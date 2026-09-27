import { worldFromSql } from "../database/test-world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { describe, expect, test } from "bun:test";
import { ByteReader } from "../net/byte-buffer.ts";
import {
  PLAYER_EXPLORED_ZONES_SIZE,
  baseExplorationXp,
  buildExplorationExperience,
  buildLevelUpInfo,
  exploreArea,
  explorationXp,
  formatExploredZones,
  giveXp,
  levelUpDeltas,
  levelUpStats,
  parseExploredZones,
  xpForLevel,
  xpRestBonus,
} from "./experience.ts";

function openXpDb(): WorldTables {
  const db = WorldTables.fromRows();
  worldFromSql(`
    CREATE TABLE player_xp_for_level (
      Level INTEGER NOT NULL PRIMARY KEY,
      Experience INTEGER NOT NULL
    );
    CREATE TABLE exploration_basexp (
      level INTEGER NOT NULL PRIMARY KEY,
      basexp INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE player_class_stats (
      Class INTEGER NOT NULL,
      Level INTEGER NOT NULL,
      BaseHP INTEGER NOT NULL,
      BaseMana INTEGER NOT NULL,
      Strength INTEGER NOT NULL,
      Agility INTEGER NOT NULL,
      Stamina INTEGER NOT NULL,
      Intellect INTEGER NOT NULL,
      Spirit INTEGER NOT NULL,
      PRIMARY KEY (Class, Level)
    );
    CREATE TABLE player_race_stats (
      Race INTEGER NOT NULL PRIMARY KEY,
      Strength INTEGER NOT NULL,
      Agility INTEGER NOT NULL,
      Stamina INTEGER NOT NULL,
      Intellect INTEGER NOT NULL,
      Spirit INTEGER NOT NULL
    );

    INSERT INTO player_xp_for_level VALUES
      (1, 400),
      (2, 900),
      (3, 1400),
      (4, 2100);

    INSERT INTO exploration_basexp VALUES
      (1, 5),
      (2, 15),
      (3, 25),
      (5, 55),
      (8, 95),
      (10, 140);

    INSERT INTO player_class_stats VALUES
      (1, 1, 20, 0, 23, 20, 22, 20, 20),
      (1, 2, 29, 0, 24, 21, 23, 20, 20),
      (8, 1, 32, 100, 17, 17, 19, 24, 23),
      (8, 2, 45, 120, 17, 17, 20, 25, 24);

    INSERT INTO player_race_stats VALUES
      (1, 0, 0, 0, 0, 0),
      (2, 3, -3, 1, -3, 2);
  `, db);
  return db;
}

describe("xpForLevel", () => {
  test("reads player_xp_for_level", () => {
    const world = openXpDb();
    expect(xpForLevel(world, 1)).toBe(400);
    expect(xpForLevel(world, 2)).toBe(900);
  });

  test("missing xp row returns 0", () => {
    const world = openXpDb();
    expect(xpForLevel(world, 50)).toBe(0);
    expect(xpForLevel(world, 0)).toBe(0);
  });
});

describe("giveXp", () => {
  test("XP that does not level", () => {
    const world = openXpDb();
    const result = giveXp({
      world,
      level: 1,
      xp: 100,
      restBonus: 0,
      amount: 50,
      rates: { rest: false },
    });
    expect(result).toEqual({
      level: 1,
      xp: 150,
      restBonus: 0,
      levelsGained: 0,
      restedGrant: 0,
      normalGrant: 50,
    });
  });

  test("XP that levels once and carries remainder", () => {
    const world = openXpDb();
    // 350 + 100 = 450; need 400 to level → level 2 with 50 XP
    const result = giveXp({
      world,
      level: 1,
      xp: 350,
      restBonus: 0,
      amount: 100,
      rates: { rest: false },
    });
    expect(result.level).toBe(2);
    expect(result.xp).toBe(50);
    expect(result.levelsGained).toBe(1);
    expect(result.normalGrant).toBe(100);
    expect(result.restedGrant).toBe(0);
  });

  test("XP that levels twice", () => {
    const world = openXpDb();
    // 0 + (400 + 900 + 100) = enough for L1→2→3 with 100 left
    const result = giveXp({
      world,
      level: 1,
      xp: 0,
      restBonus: 0,
      amount: 1400,
      rates: { rest: false },
    });
    expect(result.level).toBe(3);
    expect(result.xp).toBe(100);
    expect(result.levelsGained).toBe(2);
  });

  test("rested XP consumed before normal", () => {
    const world = openXpDb();
    const result = giveXp({
      world,
      level: 1,
      xp: 0,
      restBonus: 80,
      amount: 100,
    });
    expect(result.normalGrant).toBe(100);
    expect(result.restedGrant).toBe(80);
    expect(result.xp).toBe(180);
    expect(result.restBonus).toBe(0);
    expect(result.levelsGained).toBe(0);
  });

  test("rest bonus floors at 0 and cannot exceed amount", () => {
    const world = openXpDb();
    expect(xpRestBonus(25, 10)).toEqual({ restedGrant: 10, restBonus: 15 });
    expect(xpRestBonus(-3, 10)).toEqual({ restedGrant: 0, restBonus: 0 });

    const result = giveXp({
      world,
      level: 1,
      xp: 0,
      restBonus: 500,
      amount: 40,
    });
    expect(result.restedGrant).toBe(40);
    expect(result.restBonus).toBe(460);
    expect(result.xp).toBe(80);
  });

  test("no XP at max level", () => {
    const world = openXpDb();
    const result = giveXp({
      world,
      level: 80,
      xp: 0,
      restBonus: 100,
      amount: 500,
    });
    expect(result.levelsGained).toBe(0);
    expect(result.xp).toBe(0);
    expect(result.restBonus).toBe(100);
    expect(result.restedGrant).toBe(0);
  });

  test("quests skip rest via rates.rest false", () => {
    const world = openXpDb();
    const result = giveXp({
      world,
      level: 1,
      xp: 0,
      restBonus: 200,
      amount: 50,
      rates: { rest: false },
    });
    expect(result.restedGrant).toBe(0);
    expect(result.restBonus).toBe(200);
    expect(result.xp).toBe(50);
  });
});

describe("exploration", () => {
  test("explorationXp by level difference", () => {
    const world = openXpDb();
    // within ±5 of area level 5 at player 5 → full base
    expect(explorationXp(world, 5, 5)).toBe(55);
    // player much lower (diff < -5): GetBaseXP(playerLevel + 5)
    expect(explorationXp(world, 10, 3)).toBe(baseExplorationXp(world, 8));
    expect(explorationXp(world, 10, 3)).toBe(95);
    // diff == 5 → still full; diff > 5 → percent falloff
    expect(explorationXp(world, 5, 10)).toBe(55);
    expect(explorationXp(world, 5, 11)).toBe(Math.trunc((55 * 95) / 100));
    expect(explorationXp(world, 5, 5, { explore: 2 })).toBe(110);
  });

  test("exploreArea is once-only on the bit", () => {
    const world = openXpDb();
    const first = exploreArea({
      exploredMask: null,
      exploreFlag: 5,
      areaId: 12,
      areaLevel: 5,
      playerLevel: 5,
      world,
    });
    expect(first.status).toBe("explored");
    if (first.status !== "explored") {
      return;
    }
    expect(first.xp).toBe(55);
    const offset = Math.floor(5 / 32);
    expect((first.exploredMask[offset]! & (1 << (5 % 32))) !== 0).toBe(true);

    const second = exploreArea({
      exploredMask: first.exploredMask,
      exploreFlag: 5,
      areaId: 12,
      areaLevel: 5,
      playerLevel: 5,
      world,
    });
    expect(second.status).toBe("already_explored");
    expect(second.xp).toBe(0);
  });

  test("exploredZones round-trip", () => {
    const mask = new Array<number>(PLAYER_EXPLORED_ZONES_SIZE).fill(0);
    mask[0] = 0x20;
    const text = formatExploredZones(mask);
    expect(parseExploredZones(text)[0]).toBe(0x20);
    expect(parseExploredZones(text).length).toBe(PLAYER_EXPLORED_ZONES_SIZE);
  });

  test("max-level explore marks bit with 0 XP", () => {
    const world = openXpDb();
    const result = exploreArea({
      exploredMask: null,
      exploreFlag: 1,
      areaId: 14,
      areaLevel: 5,
      playerLevel: 80,
      world,
    });
    expect(result.status).toBe("explored");
    expect(result.xp).toBe(0);
  });
});

describe("levelUpStats", () => {
  test("human warrior level 2 from class and race tables", () => {
    const world = openXpDb();
    const stats = levelUpStats(world, 1, 1, 2);
    expect(stats).not.toBeNull();
    if (!stats) {
      return;
    }
    expect(stats.baseHp).toBe(29);
    expect(stats.baseMana).toBe(0);
    expect(stats.strength).toBe(24);
    expect(stats.stamina).toBe(23);
    expect(stats.health).toBe(29 + 20 + (23 - 20) * 10);
    expect(stats.powerType).toBe(1);
    expect(stats.maxPower).toBe(1000);
    expect(stats.power).toBe(0);
  });

  test("orc race modifiers apply", () => {
    const world = openXpDb();
    const human = levelUpStats(world, 1, 1, 1);
    const orc = levelUpStats(world, 2, 1, 1);
    expect(human).not.toBeNull();
    expect(orc).not.toBeNull();
    if (!human || !orc) {
      return;
    }
    expect(orc.strength - human.strength).toBe(3);
    expect(orc.agility - human.agility).toBe(-3);
  });
});

describe("packets", () => {
  test("SMSG_LEVELUP_INFO layout", () => {
    const world = openXpDb();
    const prev = levelUpStats(world, 1, 8, 1);
    const next = levelUpStats(world, 1, 8, 2);
    expect(prev).not.toBeNull();
    expect(next).not.toBeNull();
    if (!prev || !next) {
      return;
    }
    const fields = levelUpDeltas(prev, next, 2);
    const payload = buildLevelUpInfo(fields);
    const reader = new ByteReader(payload);
    expect(reader.readU32()).toBe(2);
    expect(reader.readU32()).toBe(next.baseHp - prev.baseHp);
    expect(reader.readU32()).toBe(next.baseMana - prev.baseMana);
    for (let i = 1; i < 7; i += 1) {
      expect(reader.readU32()).toBe(0);
    }
    expect(reader.readU32()).toBe(next.strength - prev.strength);
    expect(reader.readU32()).toBe(next.agility - prev.agility);
    expect(reader.readU32()).toBe(next.stamina - prev.stamina);
    expect(reader.readU32()).toBe(next.intellect - prev.intellect);
    expect(reader.readU32()).toBe(next.spirit - prev.spirit);
    expect(reader.remaining).toBe(0);
  });

  test("SMSG_EXPLORATION_EXPERIENCE layout", () => {
    const payload = buildExplorationExperience(12, 55);
    const reader = new ByteReader(payload);
    expect(reader.readU32()).toBe(12);
    expect(reader.readU32()).toBe(55);
    expect(reader.remaining).toBe(0);
  });
});
