import type { Character } from "../db.ts";
import { ByteWriter } from "../net/byte-buffer.ts";

const OBJECT_END = 0x0006;
const UNIT_END = OBJECT_END + 0x008e;
export const PLAYER_END = UNIT_END + 0x049a;

const OBJECT_FIELD_GUID = 0x0000;
const OBJECT_FIELD_TYPE = 0x0002;
const OBJECT_FIELD_SCALE_X = 0x0004;
const UNIT_FIELD_BYTES_0 = OBJECT_END + 0x0011;
const UNIT_FIELD_HEALTH = OBJECT_END + 0x0012;
const UNIT_FIELD_POWER1 = OBJECT_END + 0x0013;
const UNIT_FIELD_MAXHEALTH = OBJECT_END + 0x001a;
const UNIT_FIELD_MAXPOWER1 = OBJECT_END + 0x001b;
export const UNIT_FIELD_LEVEL = OBJECT_END + 0x0030;
const UNIT_FIELD_FACTIONTEMPLATE = OBJECT_END + 0x0031;
const UNIT_FIELD_DISPLAYID = OBJECT_END + 0x003d;
const UNIT_FIELD_NATIVEDISPLAYID = OBJECT_END + 0x003e;
const UNIT_FIELD_BYTES_1 = OBJECT_END + 0x0044;
const UNIT_MOD_CAST_SPEED = OBJECT_END + 0x004a;
const UNIT_FIELD_STAT0 = OBJECT_END + 0x004e;
const UNIT_FIELD_HOVERHEIGHT = OBJECT_END + 0x008c;
const UNIT_FIELD_FLAGS = OBJECT_END + 0x0035;
const PLAYER_BYTES = UNIT_END + 0x0005;
const PLAYER_BYTES_2 = UNIT_END + 0x0006;
const PLAYER_BYTES_3 = UNIT_END + 0x0007;
const PLAYER_SKILL_INFO_1_1 = UNIT_END + 0x01e8;
const PLAYER_FIELD_WATCHED_FACTION_INDEX = UNIT_END + 0x043a;
const UNIT_FLAG_PLAYER_CONTROLLED = 0x8;
const PLAYER_MAX_SKILL_SLOTS = 128;

const TYPEMASK_PLAYER = 0x19;
const TYPEID_PLAYER = 4;
const UPDATETYPE_VALUES = 0;
const UPDATETYPE_CREATE_OBJECT2 = 3;
const UPDATEFLAG_SELF = 0x0001;
const UPDATEFLAG_LIVING = 0x0020;
const UPDATEFLAG_STATIONARY_POSITION = 0x0040;
const LEVEL_ONE_HEALTH = 60;

const RACES = new Map<number, { faction: number; male: number; female: number }>([
  [1, { faction: 1, male: 49, female: 50 }],
  [2, { faction: 2, male: 51, female: 52 }],
  [3, { faction: 3, male: 53, female: 54 }],
  [4, { faction: 4, male: 55, female: 56 }],
  [5, { faction: 5, male: 57, female: 58 }],
  [6, { faction: 6, male: 59, female: 60 }],
  [7, { faction: 115, male: 1563, female: 1564 }],
  [8, { faction: 116, male: 1478, female: 1479 }],
  [10, { faction: 1610, male: 15476, female: 15475 }],
  [11, { faction: 1629, male: 16125, female: 16126 }],
]);

const SPEEDS = [2.5, 7, 4.5, 4.722222, 2.5, 7, 4.5, 3.141594, 3.14];

export type PlayerStatValues = {
  strength: number;
  agility: number;
  stamina: number;
  intellect: number;
  spirit: number;
};

export type PlayerSkillValue = { skill: number; value: number; max: number };

export type PlayerFieldStats = {
  health: number;
  maxHealth: number;
  powerType: number;
  power: number;
  maxPower: number;
  attributes?: PlayerStatValues;
  skills?: readonly PlayerSkillValue[];
  /** Raw fields from `PlayerStats` (and the skill slots); they override the values above. */
  fields?: readonly { index: number; value: number }[];
};

export function playerCreateBlock(character: Character, stats?: PlayerFieldStats): Uint8Array {
  return new ByteWriter().writeU32(1).writeBytes(playerUpdateBlock(character, true, 0, 0, stats)).toUint8Array();
}

export function playerUpdateBlock(
  character: Character,
  self: boolean,
  moveTime = 0,
  standState = 0,
  stats?: PlayerFieldStats,
): Uint8Array {
  const appearance = raceAppearance(character.race, character.gender);
  const values = new Uint32Array(PLAYER_END);
  const view = new DataView(values.buffer);
  values[OBJECT_FIELD_GUID] = character.guid;
  values[OBJECT_FIELD_TYPE] = TYPEMASK_PLAYER;
  view.setFloat32(OBJECT_FIELD_SCALE_X * 4, 1, true);
  const power = stats?.powerType ?? powerType(character.class);
  values[UNIT_FIELD_BYTES_0] =
    character.race | (character.class << 8) | (character.gender << 16) | (power << 24);
  if (stats) {
    values[UNIT_FIELD_HEALTH] = stats.health;
    values[UNIT_FIELD_MAXHEALTH] = stats.maxHealth;
    if (stats.powerType >= 0 && stats.powerType <= 6) {
      values[UNIT_FIELD_POWER1 + stats.powerType] = stats.power;
      values[UNIT_FIELD_MAXPOWER1 + stats.powerType] = stats.maxPower;
    }
    if (stats.attributes) {
      values[UNIT_FIELD_STAT0] = stats.attributes.strength;
      values[UNIT_FIELD_STAT0 + 1] = stats.attributes.agility;
      values[UNIT_FIELD_STAT0 + 2] = stats.attributes.stamina;
      values[UNIT_FIELD_STAT0 + 3] = stats.attributes.intellect;
      values[UNIT_FIELD_STAT0 + 4] = stats.attributes.spirit;
    }
    if (stats.skills) {
      const count = Math.min(stats.skills.length, PLAYER_MAX_SKILL_SLOTS);
      for (let index = 0; index < count; index++) {
        const entry = stats.skills[index]!;
        const base = PLAYER_SKILL_INFO_1_1 + index * 3;
        // Player::SetSkill: MAKE_PAIR32(id, step), MAKE_SKILL_VALUE(value, max), bonus 0
        values[base] = entry.skill & 0xffff; // MAKE_PAIR32(id, step=0)
        values[base + 1] = (entry.value & 0xffff) | ((entry.max & 0xffff) << 16);
        values[base + 2] = 0;
      }
    }
  } else {
    values[UNIT_FIELD_HEALTH] = character.health > 0 ? character.health : LEVEL_ONE_HEALTH;
    values[UNIT_FIELD_MAXHEALTH] = LEVEL_ONE_HEALTH;
  }
  values[UNIT_FIELD_LEVEL] = character.level;
  values[UNIT_FIELD_FACTIONTEMPLATE] = appearance.faction;
  values[UNIT_FIELD_FLAGS] = UNIT_FLAG_PLAYER_CONTROLLED;
  values[UNIT_FIELD_DISPLAYID] = appearance.display;
  values[UNIT_FIELD_NATIVEDISPLAYID] = appearance.display;
  values[UNIT_FIELD_BYTES_1] = standState & 0xff;
  view.setFloat32(UNIT_MOD_CAST_SPEED * 4, 1, true);
  view.setFloat32(UNIT_FIELD_HOVERHEIGHT * 4, 1, true);
  values[PLAYER_BYTES] =
    character.skin | (character.face << 8) | (character.hairStyle << 16) | (character.hairColor << 24);
  values[PLAYER_BYTES_2] = character.facialStyle;
  values[PLAYER_BYTES_3] = character.gender;
  values[PLAYER_FIELD_WATCHED_FACTION_INDEX] = 0xffffffff;
  const force = new Set([UNIT_FIELD_BYTES_1]);
  for (const field of stats?.fields ?? []) {
    if (field.index >= 0 && field.index < values.length) {
      values[field.index] = field.value >>> 0;
    }
  }

  const flags = (self ? UPDATEFLAG_SELF : 0) | UPDATEFLAG_LIVING | UPDATEFLAG_STATIONARY_POSITION;
  const body = new ByteWriter()
    .writeU8(UPDATETYPE_CREATE_OBJECT2)
    .writeBytes(packedGuid(BigInt(character.guid)))
    .writeU8(TYPEID_PLAYER)
    .writeU16(flags)
    .writeU32(0)
    .writeU16(0)
    .writeU32(self ? 0 : moveTime)
    .writeF32(character.position_x)
    .writeF32(character.position_y)
    .writeF32(character.position_z)
    .writeF32(character.orientation)
    .writeU32(0);
  for (const speed of SPEEDS) {
    body.writeF32(speed);
  }
  if (stats && stats.powerType >= 0 && stats.powerType <= 6) {
    force.add(UNIT_FIELD_POWER1 + stats.powerType);
    force.add(UNIT_FIELD_MAXPOWER1 + stats.powerType);
  }
  writeValues(body, values, force);
  return body.toUint8Array();
}

export function standStateUpdateBlock(characterId: number, state: number): Uint8Array {
  const values = new Uint32Array(PLAYER_END);
  values[UNIT_FIELD_BYTES_1] = state & 0xff;
  const body = new ByteWriter().writeU32(1).writeU8(UPDATETYPE_VALUES).writeBytes(packedGuid(BigInt(characterId)));
  writeValues(body, values, new Set([UNIT_FIELD_BYTES_1]));
  return body.toUint8Array();
}

export function fieldUpdateBlock(characterId: number, fields: readonly { index: number; value: number }[]): Uint8Array {
  const values = new Uint32Array(PLAYER_END);
  const force = new Set<number>();
  for (const field of fields) {
    if (field.index < 0 || field.index >= values.length) {
      continue;
    }
    values[field.index] = field.value >>> 0;
    force.add(field.index);
  }
  const body = new ByteWriter().writeU32(1).writeU8(0).writeBytes(packedGuid(BigInt(characterId)));
  writeValues(body, values, force);
  return body.toUint8Array();
}

export const PLAYER_XP = UNIT_END + 0x01e6;
export const PLAYER_NEXT_LEVEL_XP = UNIT_END + 0x01e7;
export const PLAYER_FIELD_COINAGE = UNIT_END + 0x03fe;

export function healthUpdateBlock(characterId: number, health: number): Uint8Array {
  const values = new Uint32Array(PLAYER_END);
  values[UNIT_FIELD_HEALTH] = health;
  const body = new ByteWriter().writeU32(1).writeU8(0).writeBytes(packedGuid(BigInt(characterId)));
  writeValues(body, values);
  return body.toUint8Array();
}

function writeValues(body: ByteWriter, values: Uint32Array, force?: ReadonlySet<number>): void {
  const blocks = Math.ceil(values.length / 32);
  body.writeU8(blocks);
  const present: number[] = [];
  for (let block = 0; block < blocks; block++) {
    let mask = 0;
    for (let bit = 0; bit < 32; bit++) {
      const index = block * 32 + bit;
      if (index < values.length && (values[index] !== 0 || force?.has(index))) {
        mask |= 1 << bit;
        present.push(index);
      }
    }
    body.writeU32(mask >>> 0);
  }
  for (const index of present) {
    body.writeU32(values[index]!);
  }
}

export function packedGuid(guid: bigint): Uint8Array {
  let mask = 0;
  const bytes: number[] = [];
  for (let index = 0; index < 8; index++) {
    const byte = Number((guid >> BigInt(index * 8)) & 0xffn);
    if (byte !== 0) {
      mask |= 1 << index;
      bytes.push(byte);
    }
  }
  return Uint8Array.of(mask, ...bytes);
}

function raceAppearance(race: number, gender: number): { faction: number; display: number } {
  const row = RACES.get(race) ?? RACES.get(1)!;
  return { faction: row.faction, display: gender === 1 ? row.female : row.male };
}

function powerType(classId: number): number {
  if (classId === 1) {
    return 1;
  }
  if (classId === 4) {
    return 3;
  }
  if (classId === 6) {
    return 6;
  }
  return 0;
}
