import type { Database } from "bun:sqlite";
import type { Socket, TCPSocketListener } from "bun";
import type { DbcStores } from "../data/dbc.ts";
import type { WorldData } from "../data/world.ts";
import { log } from "../log.ts";
import { SocketBuffers } from "../net/socket-buffers.ts";
import { ServerConfig, type WorldConfig } from "../game/world/world-config.ts";
import {
  CLIENT_HEADER_SIZE,
  CMSG_AUTH_SESSION,
  CMSG_KEEP_ALIVE,
  CMSG_PING,
  CMSG_WARDEN_DATA,
  decodeClientHeader,
} from "./packets.ts";
import { QuestParty } from "./party.ts";
import { PlayerView } from "./players.ts";
import { indexSpawns, type SpawnIndex } from "./spawn.ts";
import { describeWorldOpcode, WorldSession } from "./session.ts";
import { talkDataFor } from "./talk.ts";

export type WorldSocketData = {
  session: WorldSession;
  io: SocketBuffers;
  header: { size: number; opcode: number } | null;
};

/**
 * `WorldSession::ResetTimeOutTime` as seconds for `socket.timeout`, or null when the running timer stays.
 * In the world the timer is `SocketTimeOutTimeActive`, on character select `SocketTimeOutTime`.
 * `onlyActive` (keep-alive) leaves the character-select timer alone.
 */
export function timeOutTimeSeconds(
  session: { authenticated: boolean; inWorld: boolean },
  settings: WorldConfig,
  onlyActive: boolean,
): number | null {
  if (!session.authenticated) {
    return null;
  }
  let milliseconds: number;
  if (session.inWorld) {
    milliseconds = settings.getUInt(ServerConfig.CONFIG_SOCKET_TIMEOUTTIME_ACTIVE);
  } else if (!onlyActive) {
    milliseconds = settings.getUInt(ServerConfig.CONFIG_SOCKET_TIMEOUTTIME);
  } else {
    return null;
  }
  // `timeout(0)` turns the timer off. A 0 ms setting is idle at once in C++, so it becomes the shortest timeout.
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

export function startWorldServer(options: {
  hostname: string;
  port: number;
  db: Database;
  world?: WorldData | null;
  dbc?: DbcStores | null;
  tcpNoDelay?: boolean;
  /** Source of the idle timeouts. Without it connections never time out. */
  settings?: WorldConfig;
}): TCPSocketListener<WorldSocketData> {
  const spawns: SpawnIndex | null = options.world ? indexSpawns(options.world) : null;
  if (options.world) {
    const talk = talkDataFor(options.world);
    log("world", `loaded ${talk.quests.quests.size} quests`);
  }
  const players = new PlayerView();
  const party = new QuestParty();
  const tcpNoDelay = options.tcpNoDelay ?? true;
  return Bun.listen<WorldSocketData>({
    hostname: options.hostname,
    port: options.port,
    socket: {
      open(socket) {
        socket.setNoDelay(tcpNoDelay);
        const io = new SocketBuffers(socket);
        const session = new WorldSession(options.db, options.world ?? null, spawns, players, options.dbc ?? null, party);
        session.attach((packet) => io.send(packet));
        socket.data = { session, io, header: null };
        log("world", `connection from ${socket.remoteAddress}`);
        log("world", "S->C SMSG_AUTH_CHALLENGE");
        io.send(session.greeting);
      },
      data(socket, data) {
        socket.data.io.receive(data);
        pump(socket, options.settings);
      },
      drain(socket) {
        socket.data.io.flush();
      },
      timeout(socket) {
        log("world", `idle connection ${socket.remoteAddress} timed out, closing`);
        socket.data.io.close();
      },
      close(socket) {
        socket.data?.session.disconnect();
        log("world", `connection closed ${socket.remoteAddress}`);
      },
      error(socket, error) {
        log("world", `socket error ${socket.remoteAddress}: ${error.message}`);
        socket.data?.io.close();
      },
    },
  });
}

function resetTimeOutTime(socket: Socket<WorldSocketData>, settings: WorldConfig | undefined, onlyActive: boolean): void {
  const seconds = settings ? timeOutTimeSeconds(socket.data.session, settings, onlyActive) : null;
  if (seconds !== null) {
    socket.timeout(seconds);
  }
}

function pump(socket: Socket<WorldSocketData>, settings: WorldConfig | undefined): void {
  const state = socket.data;
  const { io, session } = state;
  while (io.open) {
    if (!state.header) {
      if (io.received.length < CLIENT_HEADER_SIZE) {
        return;
      }
      const header = io.take(CLIENT_HEADER_SIZE);
      session.crypt?.decryptHeader(header);
      const decoded = decodeClientHeader(header);
      if (decoded.size < 4 || decoded.size >= 10240) {
        log("world", `bad header size ${decoded.size} opcode ${describeWorldOpcode(decoded.opcode)}, closing`);
        io.close();
        return;
      }
      state.header = decoded;
    }

    const payloadLength = state.header.size - 4;
    if (io.received.length < payloadLength) {
      return;
    }
    const payload = io.take(payloadLength);
    const opcode = state.header.opcode;
    state.header = null;
    if (opcode === CMSG_KEEP_ALIVE) {
      resetTimeOutTime(socket, settings, true);
    } else if (opcode !== CMSG_PING && opcode !== CMSG_AUTH_SESSION && opcode !== CMSG_WARDEN_DATA) {
      resetTimeOutTime(socket, settings, false);
    }
    const result = session.handle(opcode, payload);
    if (opcode === CMSG_AUTH_SESSION) {
      resetTimeOutTime(socket, settings, false);
    }
    const sent = result.sent.length > 0 ? ` -> ${result.sent.join(", ")}` : result.close ? " -> close" : " -> ignored";
    if (opcode !== CMSG_PING && !result.quiet) {
      log("world", `C->S ${describeWorldOpcode(opcode)} ${payload.length}b${sent}`);
    }
    for (const packet of result.packets) {
      io.send(packet);
    }
    if (result.close) {
      io.close();
      return;
    }
  }
}
