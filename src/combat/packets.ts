import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import { packedGuid } from "../world/update-object.ts";
import { HITINFO_BLOCK, HITINFO_FULL_ABSORB, HITINFO_FULL_RESIST, HITINFO_PARTIAL_ABSORB, HITINFO_PARTIAL_RESIST, HITINFO_RAGE_GAIN, HITINFO_UNK1 } from "./constants.ts";

/** One `CalcDamageInfo::damages[i]` entry. */
export type SubDamage = { schoolMask: number; damage: number; absorb: number; resist: number };

export type AttackStateUpdate = {
  hitInfo: number;
  attacker: bigint;
  target: bigint;
  damages: readonly [SubDamage, SubDamage];
  targetHealth: number;
  targetState: number;
  blocked: number;
};

/** `Unit::SendAttackStateUpdate(CalcDamageInfo*)` → `SMSG_ATTACKERSTATEUPDATE`. */
export function attackerStateUpdate(info: AttackStateUpdate): Uint8Array {
  const [first, second] = info.damages;
  const count = second.damage || second.absorb || second.resist ? 2 : 1;
  const total = first.damage + second.damage;
  const overkill = total - info.targetHealth;
  const body = new ByteWriter()
    .writeU32(info.hitInfo >>> 0)
    .writeBytes(packedGuid(info.attacker))
    .writeBytes(packedGuid(info.target))
    .writeU32(total >>> 0)
    .writeU32(overkill < 0 ? 0 : overkill >>> 0)
    .writeU8(count);
  for (let index = 0; index < count; index++) {
    const damage = info.damages[index]!;
    body.writeU32(damage.schoolMask).writeF32(damage.damage).writeU32(damage.damage >>> 0);
  }
  if (info.hitInfo & (HITINFO_FULL_ABSORB | HITINFO_PARTIAL_ABSORB)) {
    for (let index = 0; index < count; index++) {
      body.writeU32(info.damages[index]!.absorb >>> 0);
    }
  }
  if (info.hitInfo & (HITINFO_FULL_RESIST | HITINFO_PARTIAL_RESIST)) {
    for (let index = 0; index < count; index++) {
      body.writeU32(info.damages[index]!.resist >>> 0);
    }
  }
  body.writeU8(info.targetState).writeU32(0).writeU32(0);
  if (info.hitInfo & HITINFO_BLOCK) {
    body.writeU32(info.blocked >>> 0);
  }
  if (info.hitInfo & HITINFO_RAGE_GAIN) {
    body.writeU32(0);
  }
  if (info.hitInfo & HITINFO_UNK1) {
    body.writeU32(0);
    for (let index = 0; index < 10; index++) {
      body.writeF32(0);
    }
    body.writeU32(0);
  }
  return body.toUint8Array();
}

/** `Unit::SendMeleeAttackStart` */
export function attackStartPacket(attacker: bigint, victim: bigint): Uint8Array {
  return new ByteWriter().writeU64(attacker).writeU64(victim).toUint8Array();
}

/** `WorldPackets::Combat::SAttackStop` */
export function attackStopPacket(attacker: bigint, victim: bigint | null, nowDead: boolean): Uint8Array {
  return new ByteWriter()
    .writeBytes(packedGuid(attacker))
    .writeBytes(packedGuid(victim ?? 0n))
    .writeU32(nowDead ? 1 : 0)
    .toUint8Array();
}

/** `Creature::SendAIReaction` */
export function aiReactionPacket(guid: bigint, reaction: number): Uint8Array {
  return new ByteWriter().writeU64(guid).writeU32(reaction).toUint8Array();
}

/** `WorldPackets::Chat::Emote` */
export function emotePacket(guid: bigint, emote: number): Uint8Array {
  return new ByteWriter().writeU32(emote).writeU64(guid).toUint8Array();
}

/** `SMSG_PARTYKILLLOG` */
export function partyKillLogPacket(player: bigint, victim: bigint): Uint8Array {
  return new ByteWriter().writeU64(player).writeU64(victim).toUint8Array();
}

/** `SMSG_LOOT_LIST` without a group looter. */
export function lootListPacket(creature: bigint): Uint8Array {
  return new ByteWriter().writeU64(creature).writeU8(0).writeU8(0).toUint8Array();
}

export type Vec3 = { x: number; y: number; z: number };

const OBJECT_END = 0x0006;
const UNIT_END = OBJECT_END + 0x008e;

/** Values update (`UPDATETYPE_VALUES`) for a creature's unit fields, wrapped as a whole `SMSG_UPDATE_OBJECT` body. */
export function unitValuesUpdate(guid: bigint, fields: readonly { index: number; value: number }[]): Uint8Array {
  const values = new Uint32Array(UNIT_END);
  const present = new Set<number>();
  for (const field of fields) {
    if (field.index >= 0 && field.index < UNIT_END) {
      values[field.index] = field.value >>> 0;
      present.add(field.index);
    }
  }
  const body = new ByteWriter().writeU32(1).writeU8(0).writeBytes(packedGuid(guid));
  const blocks = Math.ceil(UNIT_END / 32);
  body.writeU8(blocks);
  const order: number[] = [];
  for (let block = 0; block < blocks; block++) {
    let mask = 0;
    for (let bit = 0; bit < 32; bit++) {
      const index = block * 32 + bit;
      if (present.has(index)) {
        mask |= 1 << bit;
        order.push(index);
      }
    }
    body.writeU32(mask >>> 0);
  }
  for (const index of order) {
    body.writeU32(values[index]!);
  }
  return body.toUint8Array();
}

/** Value of one field in a `unitValuesUpdate` body, or null when that bit is clear. */
export function updateFieldValue(body: Uint8Array, index: number): number | null {
  const reader = new ByteReader(body);
  if (reader.remaining < 6) {
    return null;
  }
  reader.readU32();
  if (reader.readU8() !== 0) {
    return null;
  }
  const guidMask = reader.readU8();
  for (let byte = 0; byte < 8; byte++) {
    if (guidMask & (1 << byte)) {
      reader.readU8();
    }
  }
  const blocks = reader.readU8();
  const masks: number[] = [];
  for (let block = 0; block < blocks; block++) {
    masks.push(reader.readU32());
  }
  for (let field = 0; field < blocks * 32; field++) {
    if ((masks[field >> 5]! & (1 << (field & 31))) === 0) {
      continue;
    }
    const value = reader.readU32();
    if (field === index) {
      return value;
    }
  }
  return null;
}

export const UNIT_FIELD_TARGET = OBJECT_END + 0x000c;
export const UNIT_FIELD_HEALTH = OBJECT_END + 0x0012;
export const UNIT_FIELD_MAXHEALTH = OBJECT_END + 0x001a;
export const UNIT_FIELD_FLAGS = OBJECT_END + 0x0035;
export const UNIT_DYNAMIC_FLAGS = OBJECT_END + 0x0049;
export const UNIT_NPC_FLAGS = OBJECT_END + 0x004c;
export const UNIT_FIELD_BYTES_2 = OBJECT_END + 0x0074;

export function floatBits(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}
