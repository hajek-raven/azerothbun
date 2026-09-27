import { describe, expect, test } from "bun:test";
import { ByteReader } from "../net/byte-buffer.ts";
import { calculateTalentsPoints, giveXp, initXpFields, SMSG_LEVELUP_INFO, SMSG_LOG_XPGAIN, type ProgressContext } from "./level-up.ts";
import {
  CLASS_DEATH_KNIGHT,
  CLASS_WARRIOR,
  PLAYER_CHARACTER_POINTS1,
  PLAYER_NEXT_LEVEL_XP,
  PLAYER_XP,
  PlayerStats,
  UNIT_FIELD_LEVEL,
  type PlayerLevelStats,
} from "./player-stats.ts";

const XP = [0, 400, 900, 1400];
const LEVELS: Record<number, PlayerLevelStats> = {
  1: { baseHealth: 20, baseMana: 0, stats: [23, 20, 22, 20, 20] },
  2: { baseHealth: 29, baseMana: 0, stats: [24, 21, 23, 20, 20] },
  3: { baseHealth: 38, baseMana: 0, stats: [25, 21, 24, 20, 21] },
};

function context(overrides: Partial<ProgressContext> = {}): ProgressContext {
  const stats = new PlayerStats({ race: 1, classId: CLASS_WARRIOR, level: 1, maxLevel: 80, levelStats: LEVELS[1]! });
  stats.updateAllStats();
  stats.setHealth(30);
  const ctx: ProgressContext = {
    stats,
    character: { level: 1, xp: 0, rest_bonus: 0, playerFlags: 0, leveltime: 100, map: 0 },
    maxLevel: 80,
    xpForLevel: (level) => XP[level] ?? 0,
    levelStats: (level) => LEVELS[level] ?? null,
    alive: true,
    ...overrides,
  };
  initXpFields(ctx);
  return ctx;
}

describe("giveXp", () => {
  test("quest XP sends SMSG_LOG_XPGAIN without a victim", () => {
    const ctx = context();
    const packets = giveXp(ctx, 150);
    expect(packets.map((p) => p.opcode)).toEqual([SMSG_LOG_XPGAIN]);
    const reader = new ByteReader(packets[0]!.body);
    expect(reader.readU64()).toBe(0n);
    expect(reader.readU32()).toBe(150);
    expect(reader.readU8()).toBe(1);
    expect(reader.readU8()).toBe(0);
    expect(ctx.character.xp).toBe(150);
    expect(ctx.stats.getUInt32(PLAYER_XP)).toBe(150);
  });

  test("kill XP adds rested bonus", () => {
    const ctx = context();
    ctx.character.rest_bonus = 50;
    const packets = giveXp(ctx, 100, 0xf130000000000001n);
    const reader = new ByteReader(packets[0]!.body);
    expect(reader.readU64()).toBe(0xf130000000000001n);
    expect(reader.readU32()).toBe(150);
    expect(reader.readU8()).toBe(0);
    expect(reader.readU32()).toBe(100);
    expect(ctx.character.xp).toBe(150);
    expect(ctx.character.rest_bonus).toBe(0);
  });

  test("crossing two levels sends one SMSG_LEVELUP_INFO per level and refills health", () => {
    const ctx = context();
    const packets = giveXp(ctx, 1400);
    expect(packets.map((p) => p.opcode)).toEqual([SMSG_LOG_XPGAIN, SMSG_LEVELUP_INFO, SMSG_LEVELUP_INFO]);
    const info = new ByteReader(packets[1]!.body);
    expect(info.readU32()).toBe(2);
    expect(info.readU32()).toBe(9);
    for (let i = 0; i < 7; i++) {
      info.readU32();
    }
    expect([info.readU32(), info.readU32(), info.readU32(), info.readU32(), info.readU32()]).toEqual([1, 1, 1, 0, 0]);
    expect(ctx.character.level).toBe(3);
    expect(ctx.character.xp).toBe(100);
    expect(ctx.character.leveltime).toBe(0);
    expect(ctx.stats.getUInt32(UNIT_FIELD_LEVEL)).toBe(3);
    expect(ctx.stats.getUInt32(PLAYER_NEXT_LEVEL_XP)).toBe(1400);
    // 38 + 20 + (24 - 20) * 10
    expect(ctx.stats.maxHealth).toBe(98);
    expect(ctx.stats.health).toBe(98);
  });

  test("no XP at the level cap, while dead, or with the no-XP flag", () => {
    expect(giveXp(context({ maxLevel: 1 }), 100)).toEqual([]);
    expect(giveXp(context({ alive: false }), 100)).toEqual([]);
    const flagged = context();
    flagged.character.playerFlags = 0x02000000;
    expect(giveXp(flagged, 100)).toEqual([]);
  });
});

describe("calculateTalentsPoints", () => {
  test("one point per level from 10", () => {
    expect(calculateTalentsPoints({ level: 9, classId: CLASS_WARRIOR, map: 0 })).toBe(0);
    expect(calculateTalentsPoints({ level: 10, classId: CLASS_WARRIOR, map: 0 })).toBe(1);
    expect(calculateTalentsPoints({ level: 80, classId: CLASS_WARRIOR, map: 0 })).toBe(71);
  });

  test("death knights in Ebon Hold earn them from quests", () => {
    expect(calculateTalentsPoints({ level: 58, classId: CLASS_DEATH_KNIGHT, map: 609 })).toBe(3);
    expect(calculateTalentsPoints({ level: 58, classId: CLASS_DEATH_KNIGHT, map: 609, questRewardTalentCount: 10 })).toBe(13);
    expect(calculateTalentsPoints({ level: 58, classId: CLASS_DEATH_KNIGHT, map: 0 })).toBe(49);
  });

  test("the free point field subtracts spent talents", () => {
    const ctx = context({ usedTalentCount: 0 });
    ctx.character.level = 12;
    initXpFields(ctx);
    expect(ctx.stats.getUInt32(PLAYER_CHARACTER_POINTS1)).toBe(3);
  });
});
