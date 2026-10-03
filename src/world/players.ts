import type { Character } from "../db.ts";
import { SERVERSIDE_VISIBILITY_GM } from "../shared/SharedDefines.ts";
import type { SessionMapPlayer } from "./session-map-player.ts";

/** A player in the world, as the other sessions address it (chat, party, `SendMessageToSet`). */
export type OnlinePlayer = {
  guid: number;
  character: () => Character;
  send: (opcode: number, payload: Uint8Array) => void;
  /** The player's map object; null while it is on no map (loading, in a far teleport). */
  mapPlayer: () => SessionMapPlayer | null;
};

/**
 * The players online (`ObjectAccessor::FindPlayer` and `WorldSessionMgr`'s player list for the world side): who is in the
 * world, and the messages that go to the players that see a player or stand near one. Who sees whom is the map's
 * (`ObjectVisibilityContainer` of each player), not kept here.
 */
export class PlayerView {
  private readonly online = new Map<number, OnlinePlayer>();

  bind(player: OnlinePlayer): void {
    this.online.set(player.guid, player);
  }

  get(guid: number): OnlinePlayer | null {
    return this.online.get(guid) ?? null;
  }

  all(): IterableIterator<OnlinePlayer> {
    return this.online.values();
  }

  leave(guid: number): void {
    this.online.delete(guid);
  }

  /** One packet to one player in world (`ObjectAccessor::FindPlayer` → `SendDirectMessage`). */
  send(guid: number, opcode: number, payload: Uint8Array): void {
    this.online.get(guid)?.send(opcode, payload);
  }

  /** `WorldObject::SendMessageToSet(data, false)`: every player whose client has this one (`GetVisiblePlayersMap`). */
  broadcast(guid: number, opcode: number, payload: Uint8Array): void {
    const player = this.online.get(guid)?.mapPlayer();
    if (!player?.isInWorld()) return;
    for (const other of [...player.getObjectVisibilityContainer().getVisiblePlayersMap().values()]) {
      if (other !== player) other.sendDirectMessage({ opcode, payload });
    }
  }

  /**
   * `Acore::MessageDistDeliverer` (`Cell::VisitObjects(this, notifier, dist)`): players on the same map within `dist` that can
   * see the sender's server side visibility (a hidden GM), filtered by `accept`. The sender is not included.
   */
  sendInRange(guid: number, dist: number, opcode: number, payload: Uint8Array, accept: (other: OnlinePlayer) => boolean = () => true): void {
    const sender = this.online.get(guid)?.mapPlayer();
    if (!sender?.isInWorld()) return;
    for (const other of [...sender.theMap().getPlayers()]) {
      if (other === sender || !other.isInWorld()) continue;
      const online = this.online.get(Number(other.getGUID() & 0xffffffffn));
      if (!online || !accept(online)) continue;
      if (!sender.isWithinDist(other, dist, true, false, false)) continue;
      if (sender.m_serverSideVisibility.getValue(SERVERSIDE_VISIBILITY_GM) > other.m_serverSideVisibilityDetect.getValue(SERVERSIDE_VISIBILITY_GM)) continue;
      other.sendDirectMessage({ opcode, payload });
    }
  }
}
