import type { Socket, TCPSocketListener } from "bun";
import type { DbcStores } from "../data/dbc.ts";
import type { SpellRecovery } from "../items/use-item.ts";
import type { SpellStore } from "../spells/spell-info.ts";
import type { ItemDbc } from "../items/item-dbc.ts";
import type { WorldData } from "../data/world.ts";
import { log, logDebug, logError, logPacket } from "../log.ts";
import { worldOpcodeName } from "./opcodes.ts";
import { SocketBuffers } from "../net/socket-buffers.ts";
import { ServerConfig, type WorldConfig } from "../game/world/world-config.ts";
import {
  CLIENT_HEADER_SIZE,
  CMSG_AUTH_SESSION,
  CMSG_KEEP_ALIVE,
  CMSG_PING,
  CMSG_WARDEN_DATA,
  decodeClientHeader,
  sealServerPacket,
} from "./packets.ts";
import { QuestParty } from "./party.ts";
import { PlayerView } from "./players.ts";
import { mapCreatureLocator, type CreatureLocator } from "./map-world.ts";
import { describeWorldOpcode, WorldSession, type SessionDatabases } from "./session.ts";
import type { WorldSessionMgr } from "../game/Server/WorldSessionMgr.ts";
import type { PlayerEnvironment } from "../characters/player-env.ts";

/** `WorldSessionMgr` lives in `src/game/Server/WorldSessionMgr.ts`; the old name stays for callers. */
export { WorldSessionMgr as WorldSessions } from "../game/Server/WorldSessionMgr.ts";
import { talkDataFor } from "./talk.ts";

export type WorldSocketData = {
  session: WorldSession;
  io: SocketBuffers;
  header: { size: number; opcode: number } | null;
  /** Packets are handled one at a time, in arrival order; the next waits for the previous database round trip. */
  pumping: Promise<void>;
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
  db: SessionDatabases;
  world?: WorldData | null;
  dbc?: DbcStores | null;
  /** Spell.dbc recovery times for item cooldowns of -1. Shared across sessions. */
  spellRecovery?: ReadonlyMap<number, SpellRecovery>;
  spellStore?: SpellStore;
  /** RandPropPoints, ItemRandomProperties, ItemRandomSuffix, and ItemLimitCategory. */
  itemDbc?: ItemDbc;
  tcpNoDelay?: boolean;
  /** Source of the idle timeouts. Without it connections never time out. */
  settings?: WorldConfig;
  /** Stat, skill, and regen tables shared by every player. */
  playerEnv?: PlayerEnvironment;
  /** Receives each session so the world tick can update it. */
  sessions?: WorldSessionMgr;
}): TCPSocketListener<WorldSocketData> {
  const spawns: CreatureLocator | null = options.world ? mapCreatureLocator : null;
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
        const session = new WorldSession(
          options.db,
          options.world ?? null,
          spawns,
          players,
          options.dbc ?? null,
          party,
          options.spellRecovery,
          options.playerEnv,
          options.spellStore,
          options.itemDbc,
        );
        // `WorldSocket::SendPacket`: every packet reaches the socket, and its header cipher, in the order it is sent.
        session.attach((packet) => io.send(sealServerPacket(packet, session.crypt)));
        session.attachClose(() => io.close());
        session.remoteAddress = socket.remoteAddress;
        options.sessions?.add(session);
        socket.data = { session, io, header: null, pumping: Promise.resolve() };
        log("world", `connection from ${socket.remoteAddress}`);
        log("world", "S->C SMSG_AUTH_CHALLENGE");
        io.send(session.greeting);
      },
      data(socket, data) {
        socket.data.io.receive(data);
        schedulePump(socket, options.settings);
      },
      drain(socket) {
        socket.data.io.flush();
      },
      timeout(socket) {
        log("world", `idle connection ${socket.remoteAddress} timed out, closing`);
        socket.data.io.close();
      },
      close(socket) {
        if (socket.data) {
          const { session } = socket.data;
          options.sessions?.delete(session);
          // `LogoutPlayer(true)` after any packet still in flight.
          socket.data.pumping = socket.data.pumping
            .then(() => session.disconnect())
            .catch((error: unknown) => logError("world", `${session.label} logout failed`, error));
          options.sessions?.trackLogout(socket.data.pumping);
        }
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

function schedulePump(socket: Socket<WorldSocketData>, settings: WorldConfig | undefined): void {
  socket.data.pumping = socket.data.pumping
    .then(() => pump(socket, settings))
    .catch((error: unknown) => {
      logError("world", `${socket.data.session.label} packet pump failed`, error);
      socket.data.io.close();
    });
}

async function pump(socket: Socket<WorldSocketData>, settings: WorldConfig | undefined): Promise<void> {
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
    logPacket("C->S", worldOpcodeName(opcode), opcode, payload, session.label);
    let result: Awaited<ReturnType<WorldSession["handle"]>>;
    try {
      result = await session.handle(opcode, payload);
    } catch (error) {
      logError("world", `${session.label} C->S ${describeWorldOpcode(opcode)} ${payload.length}b threw`, error);
      continue;
    }
    if (opcode === CMSG_AUTH_SESSION) {
      resetTimeOutTime(socket, settings, false);
    }
    const sent = result.sent.length > 0 ? ` -> ${result.sent.join(", ")}` : result.close ? " -> close" : " -> ignored";
    if (opcode !== CMSG_PING && !result.quiet) {
      log("world", `${session.label} C->S ${describeWorldOpcode(opcode)} ${payload.length}b${sent}`);
    } else if (opcode !== CMSG_PING) {
      logDebug("world", () => `${session.label} C->S ${describeWorldOpcode(opcode)} ${payload.length}b${sent}`);
    }
    for (const packet of result.packets) {
      io.send(sealServerPacket(packet, session.crypt));
    }
    if (result.close) {
      io.close();
      return;
    }
  }
}
