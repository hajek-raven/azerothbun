/**
 * `WorldSessionMgr`: every connected session. The world tick updates them, and messages to all players or all GMs go
 * through here.
 */
import { log } from "../../log.ts";
import type { WorldSession } from "../../world/session.ts";
import { RBAC_PERM_RECEIVE_GLOBAL_GM_TEXTMESSAGE } from "../Accounts/RBACDefines.ts";
import { ByteWriter } from "../../net/byte-buffer.ts";

export const SMSG_CHAT_SERVER_MESSAGE = 0x291;

/** `ServerMessageType` (`World.h`). */
export const SERVER_MSG_SHUTDOWN_TIME = 1;
export const SERVER_MSG_RESTART_TIME = 2;
export const SERVER_MSG_STRING = 3;
export const SERVER_MSG_SHUTDOWN_CANCELLED = 4;
export const SERVER_MSG_RESTART_CANCELLED = 5;

export class WorldSessionMgr {
  private readonly sessions = new Set<WorldSession>();
  private readonly logouts = new Set<Promise<void>>();

  /** @ac game/Server/WorldSessionMgr.cpp WorldSessionMgr::AddSession */
  add(session: WorldSession): void {
    this.sessions.add(session);
  }

  delete(session: WorldSession): void {
    this.sessions.delete(session);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** A closed socket's `LogoutPlayer` save; `drain` waits for it. */
  trackLogout(logout: Promise<void>): void {
    this.logouts.add(logout);
    void logout.finally(() => this.logouts.delete(logout));
  }

  /** Waits for every logout save started so far (shutdown, before the pools close). */
  async drain(): Promise<void> {
    while (this.logouts.size > 0) {
      await Promise.all([...this.logouts]);
    }
  }

  /** @ac game/Server/WorldSessionMgr.cpp WorldSessionMgr::UpdateSessions */
  update(diff: number): void {
    for (const session of this.sessions) {
      try {
        session.update(diff);
      } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        log("world", `WorldSession::Update failed: ${message}`);
      }
    }
  }

  /** @ac game/Server/WorldSessionMgr.cpp WorldSessionMgr::FindSession */
  FindSession(accountId: number): WorldSession | null {
    for (const session of this.sessions) {
      if (session.getAccountId() === accountId) return session;
    }
    return null;
  }

  /** @ac game/Server/WorldSessionMgr.h WorldSessionMgr::GetAllSessions */
  GetAllSessions(): readonly WorldSession[] {
    return [...this.sessions].filter((session) => session.authenticated);
  }

  /** @ac game/Server/WorldSessionMgr.h WorldSessionMgr::GetActiveSessionCount */
  GetActiveSessionCount(): number {
    return this.GetAllSessions().length;
  }

  /** @ac game/Server/WorldSessionMgr.h WorldSessionMgr::GetPlayerCount */
  GetPlayerCount(): number {
    return this.GetAllSessions().filter((session) => session.getPlayer()).length;
  }

  /** @ac game/Server/WorldSessionMgr.cpp WorldSessionMgr::SendGlobalMessage */
  SendGlobalMessage(opcode: number, body: Uint8Array, self: WorldSession | null = null, teamId = -1): void {
    for (const session of this.sessions) {
      const player = session.getPlayer();
      if (player && player.isInWorld() && session !== self && (teamId < 0 || player.getTeamId() === teamId)) {
        session.sendPacket(opcode, body);
      }
    }
  }

  /** @ac game/Server/WorldSessionMgr.cpp WorldSessionMgr::SendGlobalGMMessage */
  SendGlobalGMMessage(opcode: number, body: Uint8Array, self: WorldSession | null = null, teamId = -1): void {
    for (const session of this.sessions) {
      const player = session.getPlayer();
      if (!player || !player.isInWorld() || session === self) continue;
      if (!session.hasPermission(RBAC_PERM_RECEIVE_GLOBAL_GM_TEXTMESSAGE)) continue;
      if (teamId >= 0 && player.getTeamId() !== teamId) continue;
      session.sendPacket(opcode, body);
    }
  }

  /** @ac game/Server/WorldSessionMgr.cpp WorldSessionMgr::SendServerMessage */
  SendServerMessage(type: number, text = "", player: { getSession(): WorldSession } | null = null): void {
    const body = new ByteWriter().writeU32(type);
    if (type <= SERVER_MSG_STRING) body.writeCString(text);
    const bytes = body.toUint8Array();
    if (player) player.getSession().sendPacket(SMSG_CHAT_SERVER_MESSAGE, bytes);
    else this.SendGlobalMessage(SMSG_CHAT_SERVER_MESSAGE, bytes);
  }

  /** @ac game/Server/WorldSessionMgr.cpp WorldSessionMgr::KickAll */
  KickAll(): void {
    for (const session of this.sessions) session.kickPlayer("KickAll sessions");
  }

  /** @ac game/Server/WorldSessionMgr.cpp WorldSessionMgr::KickAllLess */
  KickAllLess(sec: number): void {
    for (const session of this.sessions) {
      if (session.getSecurity() < sec) session.kickPlayer("KickAllLess");
    }
  }
}

export const sWorldSessionMgr = new WorldSessionMgr();
