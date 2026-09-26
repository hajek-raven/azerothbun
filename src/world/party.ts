export type SharePlace = { map: number; x: number; y: number; z: number };

export type SharePacket = { opcode: number; name: string; body: Uint8Array };

export type SharePeer = {
  guid: number;
  divider(): bigint;
  setDivider(guid: bigint): void;
  place(): SharePlace;
  level(): number;
  status(questId: number): number;
  canTake(questId: number): boolean;
  canShare(questId: number): boolean;
  logFull(): boolean;
  acceptShared(questId: number): SharePacket[];
  deliver(packets: SharePacket[]): void;
};

const CONTINENTS = new Set([0, 1, 530, 571]);
const GROUP_XP_DISTANCE = 74;

export class QuestParty {
  private readonly peers = new Map<number, SharePeer>();
  private readonly groupOf = new Map<number, number>();
  private nextGroup = 1;

  bind(peer: SharePeer): void {
    this.peers.set(peer.guid, peer);
  }

  unbind(guid: number): void {
    this.peers.delete(guid);
  }

  peer(guid: number): SharePeer | undefined {
    return this.peers.get(guid);
  }

  form(guids: readonly number[]): void {
    const id = this.nextGroup;
    this.nextGroup += 1;
    for (const guid of guids) {
      this.groupOf.set(guid, id);
    }
  }

  members(guid: number): SharePeer[] {
    const group = this.groupOf.get(guid);
    if (group === undefined) {
      return [];
    }
    const list: SharePeer[] = [];
    for (const [other, id] of this.groupOf) {
      if (id !== group || other === guid) {
        continue;
      }
      const peer = this.peers.get(other);
      if (peer) {
        list.push(peer);
      }
    }
    return list;
  }

  sameGroup(left: number, right: number): boolean {
    const group = this.groupOf.get(left);
    return group !== undefined && group === this.groupOf.get(right);
  }
}

export function inGroupRewardRange(left: SharePlace, right: SharePlace): boolean {
  if (left.map !== right.map) {
    return false;
  }
  if (!CONTINENTS.has(left.map)) {
    return true;
  }
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return dx * dx + dy * dy + dz * dz <= GROUP_XP_DISTANCE * GROUP_XP_DISTANCE;
}
