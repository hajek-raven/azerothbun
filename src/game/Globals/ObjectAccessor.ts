/** `ObjectAccessor` for players: the online players of every session in `sWorldSessionMgr`. */
import type { Player } from "../Entities/Player/Player.ts";
import { sWorldSessionMgr } from "../Server/WorldSessionMgr.ts";

function onlinePlayers(): Player[] {
  const out: Player[] = [];
  for (const session of sWorldSessionMgr.GetAllSessions()) {
    const player = session.getPlayer();
    if (player) out.push(player);
  }
  return out;
}

export const ObjectAccessor = {
  /** @ac game/Globals/ObjectAccessor.cpp ObjectAccessor::FindPlayer (in world) */
  FindPlayer(guid: bigint): Player | null {
    return onlinePlayers().find((player) => player.getGUID() === guid && player.isInWorld()) ?? null;
  },

  /** @ac game/Globals/ObjectAccessor.cpp ObjectAccessor::FindConnectedPlayer */
  FindConnectedPlayer(guid: bigint): Player | null {
    return onlinePlayers().find((player) => player.getGUID() === guid) ?? null;
  },

  /** @ac game/Globals/ObjectAccessor.cpp ObjectAccessor::FindPlayerByLowGUID */
  FindPlayerByLowGUID(lowguid: number): Player | null {
    return ObjectAccessor.FindPlayer(BigInt(lowguid));
  },

  /** @ac game/Globals/ObjectAccessor.cpp ObjectAccessor::FindPlayerByName (`PlayerNameMapHolder` keys are the exact name) */
  FindPlayerByName(name: string, checkInWorld = true): Player | null {
    return onlinePlayers().find((player) => player.getName() === name && (!checkInWorld || player.isInWorld())) ?? null;
  },

  /** @ac game/Globals/ObjectAccessor.h ObjectAccessor::GetPlayers */
  GetPlayers(): Player[] {
    return onlinePlayers();
  },

  /** @ac game/Globals/ObjectAccessor.cpp ObjectAccessor::SaveAllPlayers */
  async SaveAllPlayers(): Promise<void> {
    await Promise.all(onlinePlayers().map((player) => player.saveToDB()));
  },
};
