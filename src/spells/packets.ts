import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import { packedGuid } from "../world/update-object.ts";

export const CMSG_CAST_SPELL = 0x12e;
export const SMSG_LEARNED_SPELL = 0x12b;
export const CMSG_CANCEL_CAST = 0x12f;
export const SMSG_CAST_FAILED = 0x130;
export const SMSG_SPELL_START = 0x131;
export const SMSG_SPELL_GO = 0x132;
export const SMSG_SPELL_FAILURE = 0x133;
export const SMSG_SPELL_COOLDOWN = 0x134;
export const CMSG_CANCEL_AURA = 0x136;
export const MSG_CHANNEL_START = 0x139;
export const MSG_CHANNEL_UPDATE = 0x13a;
export const CMSG_CANCEL_CHANNELLING = 0x13b;
export const CMSG_CANCEL_AUTO_REPEAT_SPELL = 0x26d;
export const SMSG_SPELLHEALLOG = 0x150;
export const SMSG_SPELLENERGIZELOG = 0x151;
export const SMSG_CLEAR_COOLDOWN = 0x1de;
export const SMSG_SPELL_DELAYED = 0x1e2;
export const SMSG_SPELLLOGMISS = 0x24b;
export const SMSG_PERIODICAURALOG = 0x24e;
export const SMSG_SPELLNONMELEEDAMAGELOG = 0x250;
export const SMSG_SPELL_FAILED_OTHER = 0x2a6;
export const SMSG_SPLINE_SET_RUN_SPEED = 0x2fe;
export const SMSG_UPDATE_COMBO_POINTS = 0x39d;
export const SMSG_AURA_UPDATE_ALL = 0x495;
export const SMSG_AURA_UPDATE = 0x496;

/** `SpellCastTargetFlags` */
export const TARGET_FLAG_NONE = 0x00000000;
export const TARGET_FLAG_UNUSED_1 = 0x00000001;
export const TARGET_FLAG_UNIT = 0x00000002;
export const TARGET_FLAG_UNIT_RAID = 0x00000004;
export const TARGET_FLAG_UNIT_PARTY = 0x00000008;
export const TARGET_FLAG_ITEM = 0x00000010;
export const TARGET_FLAG_SOURCE_LOCATION = 0x00000020;
export const TARGET_FLAG_DEST_LOCATION = 0x00000040;
export const TARGET_FLAG_UNIT_ENEMY = 0x00000080;
export const TARGET_FLAG_UNIT_ALLY = 0x00000100;
export const TARGET_FLAG_CORPSE_ENEMY = 0x00000200;
export const TARGET_FLAG_UNIT_DEAD = 0x00000400;
export const TARGET_FLAG_GAMEOBJECT = 0x00000800;
export const TARGET_FLAG_TRADE_ITEM = 0x00001000;
export const TARGET_FLAG_STRING = 0x00002000;
export const TARGET_FLAG_GAMEOBJECT_ITEM = 0x00004000;
export const TARGET_FLAG_CORPSE_ALLY = 0x00008000;
export const TARGET_FLAG_UNIT_MINIPET = 0x00010000;

/** `SpellCastFlags` */
export const CAST_FLAG_NONE = 0x00000000;
export const CAST_FLAG_PENDING = 0x00000001;
export const CAST_FLAG_HAS_TRAJECTORY = 0x00000002;
export const CAST_FLAG_PROJECTILE = 0x00000020;
export const CAST_FLAG_POWER_LEFT_SELF = 0x00000800;
export const CAST_FLAG_UNKNOWN_9 = 0x00000100;
export const CAST_FLAG_NO_GCD = 0x00040000;

export type Location = { transport: bigint; x: number; y: number; z: number };

/** `SpellCastTargets` as the client sends and the server echoes them. */
export type CastTargets = {
  mask: number;
  object: bigint;
  item: bigint;
  source: Location | null;
  dest: Location | null;
  text: string;
};

export function emptyTargets(): CastTargets {
  return { mask: 0, object: 0n, item: 0n, source: null, dest: null, text: "" };
}

function readPackedGuid(reader: ByteReader): bigint {
  const mask = reader.readU8();
  let guid = 0n;
  for (let index = 0; index < 8; index++) {
    if (mask & (1 << index)) {
      guid |= BigInt(reader.readU8()) << BigInt(index * 8);
    }
  }
  return guid;
}

/** `SpellCastTargets::Read` in the 3.3.5 client protocol. */
export function readTargets(reader: ByteReader): CastTargets {
  const mask = reader.readU32();
  const targets = { ...emptyTargets(), mask };
  if (mask & (TARGET_FLAG_UNIT | TARGET_FLAG_UNIT_MINIPET | TARGET_FLAG_GAMEOBJECT | TARGET_FLAG_CORPSE_ENEMY | TARGET_FLAG_CORPSE_ALLY)) {
    targets.object = readPackedGuid(reader);
  }
  if (mask & (TARGET_FLAG_ITEM | TARGET_FLAG_TRADE_ITEM)) {
    targets.item = readPackedGuid(reader);
  }
  if (mask & TARGET_FLAG_SOURCE_LOCATION) {
    targets.source = { transport: readPackedGuid(reader), x: reader.readF32(), y: reader.readF32(), z: reader.readF32() };
  }
  if (mask & TARGET_FLAG_DEST_LOCATION) {
    targets.dest = { transport: readPackedGuid(reader), x: reader.readF32(), y: reader.readF32(), z: reader.readF32() };
  }
  if (mask & TARGET_FLAG_STRING) {
    targets.text = reader.readCString();
  }
  return targets;
}

export function readCastRequest(payload: Uint8Array): { castCount: number; spellId: number; clientFlags: number; targets: CastTargets } {
  const reader = new ByteReader(payload);
  const castCount = reader.readU8();
  const spellId = reader.readU32();
  const clientFlags = reader.readU8();
  return { castCount, spellId, clientFlags, targets: readTargets(reader) };
}

/** `SpellCastTargets::Write` */
export function writeTargets(body: ByteWriter, targets: CastTargets): void {
  body.writeU32(targets.mask >>> 0);
  if (targets.mask & (TARGET_FLAG_UNIT | TARGET_FLAG_CORPSE_ALLY | TARGET_FLAG_GAMEOBJECT | TARGET_FLAG_CORPSE_ENEMY | TARGET_FLAG_UNIT_MINIPET)) {
    body.writeBytes(packedGuid(targets.object));
  }
  if (targets.mask & (TARGET_FLAG_ITEM | TARGET_FLAG_TRADE_ITEM)) {
    body.writeBytes(packedGuid(targets.item));
  }
  if (targets.mask & TARGET_FLAG_SOURCE_LOCATION) {
    const source = targets.source ?? { transport: 0n, x: 0, y: 0, z: 0 };
    body.writeBytes(packedGuid(source.transport)).writeF32(source.x).writeF32(source.y).writeF32(source.z);
  }
  if (targets.mask & TARGET_FLAG_DEST_LOCATION) {
    const dest = targets.dest ?? { transport: 0n, x: 0, y: 0, z: 0 };
    body.writeBytes(packedGuid(dest.transport)).writeF32(dest.x).writeF32(dest.y).writeF32(dest.z);
  }
  if (targets.mask & TARGET_FLAG_STRING) {
    body.writeCString(targets.text);
  }
}

/** `Spell::WriteCastResultInfo` → `SMSG_CAST_FAILED` */
export function castFailedPacket(castCount: number, spellId: number, result: number, extra: number[] = []): Uint8Array {
  const body = new ByteWriter().writeU8(castCount).writeU32(spellId).writeU8(result);
  for (const value of extra) {
    body.writeU32(value >>> 0);
  }
  return body.toUint8Array();
}

/** `Spell::SendSpellStart` */
export function spellStartPacket(options: {
  caster: bigint;
  castItem?: bigint;
  castCount: number;
  spellId: number;
  castFlags: number;
  timer: number;
  targets: CastTargets;
  powerLeft?: number;
}): Uint8Array {
  const body = new ByteWriter()
    .writeBytes(packedGuid(options.castItem || options.caster))
    .writeBytes(packedGuid(options.caster))
    .writeU8(options.castCount)
    .writeU32(options.spellId)
    .writeU32(options.castFlags >>> 0)
    .writeU32(options.timer >>> 0);
  writeTargets(body, options.targets);
  if (options.castFlags & CAST_FLAG_POWER_LEFT_SELF) {
    body.writeU32((options.powerLeft ?? 0) >>> 0);
  }
  if (options.castFlags & CAST_FLAG_PROJECTILE) {
    body.writeU32(0).writeU32(0);
  }
  return body.toUint8Array();
}

/** `Spell::SendSpellGo` with `WriteSpellGoTargets` */
export function spellGoPacket(options: {
  caster: bigint;
  castItem?: bigint;
  castCount: number;
  spellId: number;
  castFlags: number;
  timeMs: number;
  hits: bigint[];
  misses: { guid: bigint; reason: number }[];
  targets: CastTargets;
  powerLeft?: number;
}): Uint8Array {
  const body = new ByteWriter()
    .writeBytes(packedGuid(options.castItem || options.caster))
    .writeBytes(packedGuid(options.caster))
    .writeU8(options.castCount)
    .writeU32(options.spellId)
    .writeU32(options.castFlags >>> 0)
    .writeU32(options.timeMs >>> 0);
  const hits = options.hits.slice(0, 255);
  body.writeU8(hits.length);
  for (const hit of hits) {
    body.writeU64(hit);
  }
  const misses = options.misses.slice(0, 255);
  body.writeU8(misses.length);
  for (const miss of misses) {
    body.writeU64(miss.guid).writeU8(miss.reason);
    if (miss.reason === 11 /* SPELL_MISS_REFLECT */) {
      body.writeU8(0);
    }
  }
  writeTargets(body, options.targets);
  if (options.castFlags & CAST_FLAG_POWER_LEFT_SELF) {
    body.writeU32((options.powerLeft ?? 0) >>> 0);
  }
  if (options.castFlags & CAST_FLAG_PROJECTILE) {
    body.writeU32(0).writeU32(0);
  }
  if (options.targets.mask & TARGET_FLAG_DEST_LOCATION) {
    body.writeU8(0);
  }
  return body.toUint8Array();
}

/** `Spell::SendInterrupted` → `SMSG_SPELL_FAILURE` / `SMSG_SPELL_FAILED_OTHER` */
export function spellFailurePacket(caster: bigint, castCount: number, spellId: number, result: number): Uint8Array {
  return new ByteWriter().writeBytes(packedGuid(caster)).writeU8(castCount).writeU32(spellId).writeU8(result).toUint8Array();
}

/** `Spell::Delayed` → `SMSG_SPELL_DELAYED` */
export function spellDelayedPacket(caster: bigint, delayMs: number): Uint8Array {
  return new ByteWriter().writeBytes(packedGuid(caster)).writeU32(delayMs >>> 0).toUint8Array();
}

/** `MSG_CHANNEL_START` */
export function channelStartPacket(caster: bigint, spellId: number, durationMs: number): Uint8Array {
  return new ByteWriter().writeBytes(packedGuid(caster)).writeU32(spellId).writeU32(durationMs >>> 0).toUint8Array();
}

/** `MSG_CHANNEL_UPDATE` */
export function channelUpdatePacket(caster: bigint, remainingMs: number): Uint8Array {
  return new ByteWriter().writeBytes(packedGuid(caster)).writeU32(remainingMs >>> 0).toUint8Array();
}

/** `Unit::SendSpellNonMeleeDamageLog` */
export function spellDamageLogPacket(options: {
  target: bigint;
  caster: bigint;
  spellId: number;
  damage: number;
  overkill: number;
  schoolMask: number;
  absorb: number;
  resist: number;
  physicalLog: boolean;
  blocked: number;
  hitInfo: number;
}): Uint8Array {
  return new ByteWriter()
    .writeBytes(packedGuid(options.target))
    .writeBytes(packedGuid(options.caster))
    .writeU32(options.spellId)
    .writeU32(options.damage >>> 0)
    .writeU32(Math.max(0, options.overkill) >>> 0)
    .writeU8(options.schoolMask)
    .writeU32(options.absorb >>> 0)
    .writeU32(options.resist >>> 0)
    .writeU8(options.physicalLog ? 1 : 0)
    .writeU8(0)
    .writeU32(options.blocked >>> 0)
    .writeU32(options.hitInfo >>> 0)
    .writeU8(0)
    .toUint8Array();
}

/** `Unit::SendHealSpellLog` */
export function healLogPacket(target: bigint, caster: bigint, spellId: number, heal: number, overheal: number, crit: boolean): Uint8Array {
  return new ByteWriter()
    .writeBytes(packedGuid(target))
    .writeBytes(packedGuid(caster))
    .writeU32(spellId)
    .writeU32(heal >>> 0)
    .writeU32(overheal >>> 0)
    .writeU32(0)
    .writeU8(crit ? 1 : 0)
    .writeU8(0)
    .toUint8Array();
}

/** `Unit::SendEnergizeSpellLog` */
export function energizeLogPacket(target: bigint, caster: bigint, spellId: number, powerType: number, amount: number): Uint8Array {
  return new ByteWriter().writeBytes(packedGuid(target)).writeBytes(packedGuid(caster)).writeU32(spellId).writeU32(powerType).writeU32(amount >>> 0).toUint8Array();
}

/** `WorldObject::SendSpellMiss` */
export function spellMissPacket(caster: bigint, target: bigint, spellId: number, missInfo: number): Uint8Array {
  return new ByteWriter().writeU32(spellId).writeU64(caster).writeU8(0).writeU32(1).writeU64(target).writeU8(missInfo).toUint8Array();
}

export type PeriodicLog =
  | { kind: "damage"; auraType: number; damage: number; overkill: number; schoolMask: number; absorb: number; resist: number; crit: boolean }
  | { kind: "heal"; auraType: number; heal: number; overheal: number; absorb: number; crit: boolean }
  | { kind: "energize"; auraType: number; powerType: number; amount: number }
  | { kind: "leech"; auraType: number; powerType: number; amount: number; multiplier: number };

/** `Unit::SendPeriodicAuraLog` */
export function periodicAuraLogPacket(target: bigint, caster: bigint, spellId: number, log: PeriodicLog): Uint8Array {
  const body = new ByteWriter().writeBytes(packedGuid(target)).writeBytes(packedGuid(caster)).writeU32(spellId).writeU32(1).writeU32(log.auraType);
  switch (log.kind) {
    case "damage":
      body
        .writeU32(log.damage >>> 0)
        .writeU32(Math.max(0, log.overkill) >>> 0)
        .writeU32(log.schoolMask)
        .writeU32(log.absorb >>> 0)
        .writeU32(log.resist >>> 0)
        .writeU8(log.crit ? 1 : 0);
      break;
    case "heal":
      body.writeU32(log.heal >>> 0).writeU32(log.overheal >>> 0).writeU32(log.absorb >>> 0).writeU8(log.crit ? 1 : 0);
      break;
    case "energize":
      body.writeU32(log.powerType).writeU32(log.amount >>> 0);
      break;
    case "leech":
      body.writeU32(log.powerType).writeU32(log.amount >>> 0).writeF32(log.multiplier);
      break;
  }
  return body.toUint8Array();
}

export type AuraSlotUpdate = {
  slot: number;
  spellId: number;
  flags: number;
  casterLevel: number;
  stack: number;
  caster: bigint;
  maxDuration: number;
  duration: number;
};

export const AFLAG_CASTER = 0x08;
export const AFLAG_POSITIVE = 0x10;
export const AFLAG_DURATION = 0x20;
export const AFLAG_NEGATIVE = 0x80;

/** `AuraApplication::BuildUpdatePacket` for one slot (`spellId` 0 removes it). */
export function writeAuraSlot(body: ByteWriter, update: AuraSlotUpdate): void {
  body.writeU8(update.slot).writeU32(update.spellId);
  if (update.spellId === 0) {
    return;
  }
  body.writeU8(update.flags).writeU8(update.casterLevel).writeU8(update.stack);
  if (!(update.flags & AFLAG_CASTER)) {
    body.writeBytes(packedGuid(update.caster));
  }
  if (update.flags & AFLAG_DURATION) {
    body.writeU32(update.maxDuration >>> 0).writeU32(update.duration >>> 0);
  }
}

/** `SMSG_AURA_UPDATE` for one slot. */
export function auraUpdatePacket(target: bigint, update: AuraSlotUpdate): Uint8Array {
  const body = new ByteWriter().writeBytes(packedGuid(target));
  writeAuraSlot(body, update);
  return body.toUint8Array();
}

/** `SMSG_AURA_UPDATE_ALL` */
export function auraUpdateAllPacket(target: bigint, updates: readonly AuraSlotUpdate[]): Uint8Array {
  const body = new ByteWriter().writeBytes(packedGuid(target));
  for (const update of updates) {
    writeAuraSlot(body, update);
  }
  return body.toUint8Array();
}

/** `Unit::SendComboPoints` → `SMSG_UPDATE_COMBO_POINTS` */
export function comboPointsPacket(target: bigint, points: number): Uint8Array {
  return new ByteWriter().writeBytes(packedGuid(target)).writeU8(points).toUint8Array();
}

/** `SMSG_SPELL_COOLDOWN` */
export function spellCooldownPacket(caster: bigint, flags: number, entries: readonly { spellId: number; cooldown: number }[]): Uint8Array {
  const body = new ByteWriter().writeU64(caster).writeU8(flags);
  for (const entry of entries) {
    body.writeU32(entry.spellId).writeU32(entry.cooldown >>> 0);
  }
  return body.toUint8Array();
}

/** `SMSG_CLEAR_COOLDOWN` */
export function clearCooldownPacket(spellId: number, caster: bigint): Uint8Array {
  return new ByteWriter().writeU32(spellId).writeU64(caster).toUint8Array();
}

/** `SMSG_SPLINE_SET_RUN_SPEED` */
export function splineSetRunSpeedPacket(guid: bigint, speed: number): Uint8Array {
  return new ByteWriter().writeBytes(packedGuid(guid)).writeF32(speed).toUint8Array();
}
