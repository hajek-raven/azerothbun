import { expect, test } from "bun:test";
import type { Character } from "../db.ts";
import { ByteReader } from "../net/byte-buffer.ts";
import { playerUpdateBlock, standStateUpdateBlock, type PlayerFieldStats } from "./update-object.ts";

const OBJECT_END = 0x0006;
const UNIT_END = OBJECT_END + 0x008e;
const UNIT_FIELD_BYTES_0 = OBJECT_END + 0x0011;
const UNIT_FIELD_HEALTH = OBJECT_END + 0x0012;
const UNIT_FIELD_POWER1 = OBJECT_END + 0x0013;
const UNIT_FIELD_MAXHEALTH = OBJECT_END + 0x001a;
const UNIT_FIELD_MAXPOWER1 = OBJECT_END + 0x001b;
const UNIT_FIELD_STAT0 = OBJECT_END + 0x004e;
const UNIT_FIELD_BYTES_1 = 0x4a;
const PLAYER_SKILL_INFO_1_1 = UNIT_END + 0x01e8;

test("stand state update writes the stand byte, including stand", () => {
  expect(updateField(standStateUpdateBlock(1, 0), UNIT_FIELD_BYTES_1)).toBe(0);
  expect(updateField(standStateUpdateBlock(1, 1), UNIT_FIELD_BYTES_1)).toBe(1);
});

test("player update without stats keeps max health at 60", () => {
  const values = playerValues(playerUpdateBlock(character({ health: 60 }), true));
  expect(values.get(UNIT_FIELD_HEALTH)).toBe(60);
  expect(values.get(UNIT_FIELD_MAXHEALTH)).toBe(60);
  expect(values.has(UNIT_FIELD_POWER1)).toBe(false);
  expect(values.has(UNIT_FIELD_MAXPOWER1)).toBe(false);
});

test("player update with rage stats writes POWER1+1 and MAXPOWER1+1", () => {
  const stats: PlayerFieldStats = { health: 60, maxHealth: 60, powerType: 1, power: 0, maxPower: 1000 };
  const values = playerValues(playerUpdateBlock(character({ health: 60 }), true, 0, 0, stats));
  expect(values.get(UNIT_FIELD_HEALTH)).toBe(60);
  expect(values.get(UNIT_FIELD_MAXHEALTH)).toBe(60);
  expect((values.get(UNIT_FIELD_BYTES_0)! >>> 24) & 0xff).toBe(1);
  expect(values.get(UNIT_FIELD_POWER1 + 1)).toBe(0);
  expect(values.get(UNIT_FIELD_MAXPOWER1 + 1)).toBe(1000);
  expect(values.has(UNIT_FIELD_POWER1)).toBe(false);
  expect(values.has(UNIT_FIELD_MAXPOWER1)).toBe(false);
});

test("player update with mana stats writes POWER1 and MAXPOWER1", () => {
  const stats: PlayerFieldStats = { health: 80, maxHealth: 100, powerType: 0, power: 50, maxPower: 200 };
  const values = playerValues(playerUpdateBlock(character({ health: 60 }), true, 0, 0, stats));
  expect(values.get(UNIT_FIELD_HEALTH)).toBe(80);
  expect(values.get(UNIT_FIELD_MAXHEALTH)).toBe(100);
  expect((values.get(UNIT_FIELD_BYTES_0)! >>> 24) & 0xff).toBe(0);
  expect(values.get(UNIT_FIELD_POWER1)).toBe(50);
  expect(values.get(UNIT_FIELD_MAXPOWER1)).toBe(200);
});

test("player update with attributes writes UNIT_FIELD_STAT0 through STAT4", () => {
  const stats: PlayerFieldStats = {
    health: 60,
    maxHealth: 60,
    powerType: 1,
    power: 0,
    maxPower: 1000,
    attributes: { strength: 23, agility: 20, stamina: 22, intellect: 18, spirit: 19 },
  };
  const values = playerValues(playerUpdateBlock(character({ health: 60 }), true, 0, 0, stats));
  expect(values.get(UNIT_FIELD_STAT0)).toBe(23);
  expect(values.get(UNIT_FIELD_STAT0 + 4)).toBe(19);
});

test("player update with skills packs PLAYER_SKILL_INFO_1_1 like Player::SetSkill", () => {
  const stats: PlayerFieldStats = {
    health: 60,
    maxHealth: 60,
    powerType: 1,
    power: 0,
    maxPower: 1000,
    skills: [{ skill: 26, value: 1, max: 5 }],
  };
  const values = playerValues(playerUpdateBlock(character({ health: 60 }), true, 0, 0, stats));
  // MAKE_PAIR32(id, step=0), MAKE_SKILL_VALUE(value, max), bonus 0 (omitted when zero)
  expect(values.get(PLAYER_SKILL_INFO_1_1)).toBe(26);
  expect(values.get(PLAYER_SKILL_INFO_1_1 + 1)).toBe(1 | (5 << 16));
  expect(values.has(PLAYER_SKILL_INFO_1_1 + 2)).toBe(false);
});

function character(overrides: Partial<Character> = {}): Character {
  return {
    guid: 1,
    account: 1,
    name: "Test",
    race: 1,
    class: 1,
    gender: 0,
    level: 1,
    xp: 0,
    money: 0,
    skin: 0,
    face: 0,
    hairStyle: 0,
    hairColor: 0,
    facialStyle: 0,
    bankSlots: 0,
    restState: 0,
    playerFlags: 0,
    position_x: 0,
    position_y: 0,
    position_z: 0,
    map: 0,
    instance_id: 0,
    instance_mode_mask: 0,
    orientation: 0,
    taximask: "",
    online: 0,
    cinematic: 0,
    totaltime: 0,
    leveltime: 0,
    logout_time: 0,
    is_logout_resting: 0,
    rest_bonus: 0,
    resettalents_cost: 0,
    resettalents_time: 0,
    trans_x: 0,
    trans_y: 0,
    trans_z: 0,
    trans_o: 0,
    transguid: 0,
    extra_flags: 0,
    stable_slots: 0,
    at_login: 0,
    zone: 0,
    death_expire_time: 0,
    taxi_path: null,
    arenaPoints: 0,
    totalHonorPoints: 0,
    todayHonorPoints: 0,
    yesterdayHonorPoints: 0,
    totalKills: 0,
    todayKills: 0,
    yesterdayKills: 0,
    chosenTitle: 0,
    knownCurrencies: 0n,
    watchedFaction: 0,
    drunk: 0,
    health: 60,
    power1: 0,
    power2: 0,
    power3: 0,
    power4: 0,
    power5: 0,
    power6: 0,
    power7: 0,
    latency: 0,
    talentGroupsCount: 1,
    activeTalentGroup: 0,
    exploredZones: null,
    equipmentCache: null,
    ammoId: 0,
    knownTitles: null,
    actionBars: 0,
    grantableLevels: 0,
    order: null,
    creation_date: new Date(0),
    deleteInfos_Account: null,
    deleteInfos_Name: null,
    deleteDate: null,
    innTriggerId: 0,
    extraBonusTalentCount: 0,
    ...overrides,
  };
}

function playerValues(block: Uint8Array): Map<number, number> {
  const reader = new ByteReader(block);
  reader.readU8();
  const mask = reader.readU8();
  for (let index = 0; index < 8; index++) {
    if ((mask & (1 << index)) !== 0) {
      reader.readU8();
    }
  }
  reader.readU8();
  reader.readU16();
  reader.readU32();
  reader.readU16();
  reader.readU32();
  reader.readF32();
  reader.readF32();
  reader.readF32();
  reader.readF32();
  reader.readU32();
  for (let index = 0; index < 9; index++) {
    reader.readF32();
  }
  return readValues(reader);
}

function updateField(block: Uint8Array, field: number): number | null {
  const reader = new ByteReader(block);
  reader.readU32();
  reader.readU8();
  const mask = reader.readU8();
  for (let index = 0; index < 8; index++) {
    if ((mask & (1 << index)) !== 0) {
      reader.readU8();
    }
  }
  return readValues(reader).get(field) ?? null;
}

function readValues(reader: ByteReader): Map<number, number> {
  const blocks = reader.readU8();
  const present: number[] = [];
  for (let blockIndex = 0; blockIndex < blocks; blockIndex++) {
    const bits = reader.readU32();
    for (let bit = 0; bit < 32; bit++) {
      if ((bits & (1 << bit)) !== 0) {
        present.push(blockIndex * 32 + bit);
      }
    }
  }
  const values = new Map<number, number>();
  for (const index of present) {
    values.set(index, reader.readU32());
  }
  return values;
}
