import type { Character } from "../db.ts";
import { log } from "../log.ts";
import { ByteWriter } from "../net/byte-buffer.ts";
import { SMSG_DESTROY_OBJECT, SMSG_UPDATE_OBJECT } from "./packets.ts";
import { spawnUpdatePayloads, visibilityDistance } from "./spawn.ts";
import { playerUpdateBlock } from "./update-object.ts";

export type Place = { map: number; x: number; y: number; z: number };

export type OnlinePlayer = {
  guid: number;
  known: Set<number>;
  place: () => Place;
  character: () => Character;
  moveTime: () => number;
  standState: () => number;
  send: (opcode: number, payload: Uint8Array) => void;
};

export class PlayerView {
  private readonly online = new Map<number, OnlinePlayer>();

  bind(player: OnlinePlayer): void {
    this.online.set(player.guid, player);
  }

  sync(player: OnlinePlayer): { creates: Uint8Array[]; gone: bigint[] } {
    const here = player.place();
    const now = new Set<number>();
    for (const other of this.online.values()) {
      if (other.guid !== player.guid && sees(here, other.place())) {
        now.add(other.guid);
      }
    }
    const creates: Uint8Array[] = [];
    const gone: bigint[] = [];
    for (const guid of [...player.known]) {
      if (now.has(guid)) {
        continue;
      }
      player.known.delete(guid);
      gone.push(BigInt(guid));
      const other = this.online.get(guid);
      if (other?.known.delete(player.guid)) {
        log("world", `${player.character().name} left ${other.character().name}'s view`);
        sendUpdate(other, [], [BigInt(player.guid)]);
      }
    }
    for (const guid of now) {
      if (player.known.has(guid)) {
        continue;
      }
      const other = this.online.get(guid);
      if (!other) {
        continue;
      }
      player.known.add(guid);
      creates.push(playerUpdateBlock(other.character(), false, other.moveTime(), other.standState()));
      log("world", `${player.character().name} sees ${other.character().name}`);
      if (!other.known.has(player.guid)) {
        other.known.add(player.guid);
        sendUpdate(other, [playerUpdateBlock(player.character(), false, player.moveTime(), player.standState())], []);
      }
    }
    return { creates, gone };
  }

  leave(guid: number): void {
    const player = this.online.get(guid);
    if (!player) {
      return;
    }
    this.online.delete(guid);
    player.known.clear();
    const payload = new ByteWriter().writeU64(BigInt(guid)).writeU8(0).toUint8Array();
    for (const other of this.online.values()) {
      if (other.known.delete(guid)) {
        log("world", `${player.character().name} logged out of ${other.character().name}'s view`);
        other.send(SMSG_DESTROY_OBJECT, payload);
      }
    }
  }

  broadcast(guid: number, opcode: number, payload: Uint8Array): void {
    const player = this.online.get(guid);
    if (!player) {
      return;
    }
    for (const otherGuid of player.known) {
      this.online.get(otherGuid)?.send(opcode, payload);
    }
  }
}

function sendUpdate(player: OnlinePlayer, creates: Uint8Array[], gone: bigint[]): void {
  for (const payload of spawnUpdatePayloads(creates, gone)) {
    player.send(SMSG_UPDATE_OBJECT, payload);
  }
}

function sees(left: Place, right: Place): boolean {
  if (left.map !== right.map) {
    return false;
  }
  const range = visibilityDistance(left.map);
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return dx * dx + dy * dy + dz * dz <= range * range;
}
