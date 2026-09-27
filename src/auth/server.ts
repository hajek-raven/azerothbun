import type { Socket, TCPSocketListener } from "bun";
import type { Db } from "../database/database.ts";
import { log, logError } from "../log.ts";
import { SocketBuffers } from "../net/socket-buffers.ts";
import {
  AUTH_LOGON_CHALLENGE,
  AUTH_LOGON_PROOF,
  AUTH_RECONNECT_CHALLENGE,
  AUTH_RECONNECT_PROOF,
  REALM_LIST,
} from "./packets.ts";
import { AuthSession, expectedPacketLength } from "./session.ts";

export type AuthSocketData = {
  session: AuthSession;
  io: SocketBuffers;
  /** Packets are handled one at a time; the next waits for the previous database round trip. */
  pumping: Promise<void>;
};

export function startAuthServer(options: { hostname: string; port: number; db: Db }): TCPSocketListener<AuthSocketData> {
  return Bun.listen<AuthSocketData>({
    hostname: options.hostname,
    port: options.port,
    socket: {
      open(socket) {
        socket.data = { session: new AuthSession(options.db), io: new SocketBuffers(socket), pumping: Promise.resolve() };
        log("auth", `connection from ${socket.remoteAddress}`);
      },
      data(socket, data) {
        socket.data.io.receive(data);
        schedulePump(socket);
      },
      drain(socket) {
        socket.data.io.flush();
      },
      close(socket) {
        log("auth", `connection closed ${socket.remoteAddress}`);
      },
      error(socket, error) {
        log("auth", `socket error ${socket.remoteAddress}: ${error.message}`);
        socket.data?.io.close();
      },
    },
  });
}

function schedulePump(socket: Socket<AuthSocketData>): void {
  socket.data.pumping = socket.data.pumping
    .then(() => pump(socket))
    .catch((error: unknown) => {
      logError("auth", `session failed for ${socket.remoteAddress}`, error);
      socket.data.io.close();
    });
}

async function pump(socket: Socket<AuthSocketData>): Promise<void> {
  const { session, io } = socket.data;
  while (io.open && io.received.length > 0) {
    const length = expectedPacketLength(session.status, io.received);
    if (length === "wait") {
      return;
    }
    if (length === "drop") {
      log("auth", `ignored unknown command 0x${(io.received[0] ?? 0).toString(16)}`);
      io.discardReceived();
      return;
    }
    if (length === "close") {
      log("auth", `closing, unexpected command 0x${(io.received[0] ?? 0).toString(16)} in status ${session.status}`);
      io.close();
      return;
    }

    const packet = io.take(length);
    const result = await session.handle(packet);
    const command = packet[0] ?? 0;
    const reply = result.packet ? ` -> ${authOpcodeName(result.packet[0] ?? 0)}` : "";
    log("auth", `C->S ${authOpcodeName(command)} ${packet.length}b${reply}${result.action === "close" ? " close" : ""}`);
    if (result.packet) {
      io.send(result.packet);
    }
    if (result.action === "close") {
      io.close();
      return;
    }
  }
}

function authOpcodeName(command: number): string {
  switch (command) {
    case AUTH_LOGON_CHALLENGE:
      return "AUTH_LOGON_CHALLENGE";
    case AUTH_LOGON_PROOF:
      return "AUTH_LOGON_PROOF";
    case AUTH_RECONNECT_CHALLENGE:
      return "AUTH_RECONNECT_CHALLENGE";
    case AUTH_RECONNECT_PROOF:
      return "AUTH_RECONNECT_PROOF";
    case REALM_LIST:
      return "REALM_LIST";
    default:
      return `0x${command.toString(16)}`;
  }
}
