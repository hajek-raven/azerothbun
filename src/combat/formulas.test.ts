import { describe, expect, test } from "bun:test";
import {
  MELEE_HIT_BLOCK,
  MELEE_HIT_CRIT,
  MELEE_HIT_CRUSHING,
  MELEE_HIT_DODGE,
  MELEE_HIT_EVADE,
  MELEE_HIT_GLANCING,
  MELEE_HIT_MISS,
  MELEE_HIT_NORMAL,
  MELEE_HIT_PARRY,
} from "./constants.ts";
import {
  aggroRange,
  armorReducedDamage,
  baseGain,
  corpseDelaySeconds,
  creatureMeleeDamage,
  critChanceAgainst,
  glancingDamage,
  grayLevel,
  hasInArc,
  killXp,
  leashTimerSeconds,
  meleeMissChance,
  meleeRange,
  rageReward,
  rageWeaponSpeedHitFactor,
  rollMeleeOutcome,
  withinMeleeRange,
  type MeleeRollInput,
} from "./formulas.ts";

function roll(overrides: Partial<MeleeRollInput> = {}): MeleeRollInput {
  return {
    attackerIsPlayer: true,
    victimIsPlayer: false,
    victimEvading: false,
    attackerLevel: 10,
    victimLevel: 10,
    attackerMaxSkillValueForLevel: 50,
    victimMaxSkillValueForLevel: 50,
    attackerWeaponSkill: 50,
    victimDefenseSkill: 50,
    crit: 500,
    miss: 500,
    dodge: 500,
    parry: 500,
    block: 500,
    expertiseReduction: 0,
    attackerInFront: true,
    victimCanDodge: true,
    victimCanParry: true,
    victimCanBlock: true,
    victimControlled: false,
    noCrushing: true,
    noCrit: false,
    ...overrides,
  };
}

describe("RollMeleeOutcomeAgainst", () => {
  test("walks miss, dodge, parry, block, crit, then normal", () => {
    expect(rollMeleeOutcome(roll(), 0)).toBe(MELEE_HIT_MISS);
    expect(rollMeleeOutcome(roll(), 499)).toBe(MELEE_HIT_MISS);
    expect(rollMeleeOutcome(roll(), 500)).toBe(MELEE_HIT_DODGE);
    expect(rollMeleeOutcome(roll(), 1000)).toBe(MELEE_HIT_PARRY);
    expect(rollMeleeOutcome(roll(), 1500)).toBe(MELEE_HIT_BLOCK);
    expect(rollMeleeOutcome(roll(), 2000)).toBe(MELEE_HIT_CRIT);
    expect(rollMeleeOutcome(roll(), 2500)).toBe(MELEE_HIT_NORMAL);
  });

  test("evading victims evade everything", () => {
    expect(rollMeleeOutcome(roll({ victimEvading: true }), 9999)).toBe(MELEE_HIT_EVADE);
  });

  test("attacks from behind skip parry and block; players also lose dodge", () => {
    const behind = roll({ attackerInFront: false });
    expect(rollMeleeOutcome(behind, 500)).toBe(MELEE_HIT_DODGE);
    expect(rollMeleeOutcome(behind, 1000)).toBe(MELEE_HIT_CRIT);
    const player = roll({ attackerInFront: false, victimIsPlayer: true, attackerIsPlayer: false });
    expect(rollMeleeOutcome(player, 500)).toBe(MELEE_HIT_CRIT);
  });

  test("glancing blows only for players on higher level creatures, capped at 40%", () => {
    const higher = roll({ victimLevel: 13, victimDefenseSkill: 65, victimMaxSkillValueForLevel: 65, miss: 0, dodge: 0, parry: 0, block: 0, crit: 0 });
    expect(rollMeleeOutcome(higher, 2499)).toBe(MELEE_HIT_GLANCING);
    expect(rollMeleeOutcome(higher, 2500)).toBe(MELEE_HIT_NORMAL);
  });

  test("crushing blows from creatures four levels above", () => {
    const crush = roll({
      attackerIsPlayer: false,
      victimIsPlayer: true,
      attackerLevel: 14,
      attackerMaxSkillValueForLevel: 70,
      attackerWeaponSkill: 70,
      noCrushing: false,
      miss: 0,
      dodge: 0,
      parry: 0,
      block: 0,
      crit: 0,
    });
    // (70 - 50) * 200 - 1500 = 2500
    expect(rollMeleeOutcome(crush, 2499)).toBe(MELEE_HIT_CRUSHING);
    expect(rollMeleeOutcome(crush, 2500)).toBe(MELEE_HIT_NORMAL);
  });

  test("CREATURE_FLAG_EXTRA_NO_CRIT turns the crit band into normal hits", () => {
    expect(rollMeleeOutcome(roll({ miss: 0, dodge: 0, parry: 0, block: 0, noCrit: true }), 100)).toBe(MELEE_HIT_NORMAL);
  });
});

describe("damage", () => {
  test("armor reduction follows CalcArmorReducedDamage", () => {
    // 0.1 * 100 / (8.5 * 10 + 40) = 0.08; 0.08 / 1.08 = 0.074074
    expect(armorReducedDamage(100, 100, 10)).toBe(93);
    expect(armorReducedDamage(100, 0, 10)).toBe(100);
    expect(armorReducedDamage(100, 1_000_000, 10)).toBe(25);
  });

  test("creature damage uses base damage, attack power, and attack speed", () => {
    const damage = creatureMeleeDamage({ baseDamage: 4, attackPower: 14, variance: 1, damageModifier: 1, attackTimeMs: 2000 });
    expect(damage.min).toBeCloseTo(10);
    expect(damage.max).toBeCloseTo(14);
  });

  test("glancing reduces by ten percent per level up to three", () => {
    expect(glancingDamage(100, 10, 12)).toBe(80);
    expect(glancingDamage(100, 10, 20)).toBe(70);
  });

  test("miss chance adds dual wield and skill difference", () => {
    expect(meleeMissChance({ victimMissChance: 5, victimIsPlayer: false, skillDiff: 0, dualWield: false, modMeleeHitChance: 0 })).toBe(5);
    expect(meleeMissChance({ victimMissChance: 5, victimIsPlayer: false, skillDiff: 0, dualWield: true, modMeleeHitChance: 0 })).toBe(24);
    expect(meleeMissChance({ victimMissChance: 5, victimIsPlayer: false, skillDiff: -15, dualWield: false, modMeleeHitChance: 0 })).toBe(8);
    expect(meleeMissChance({ victimMissChance: 5, victimIsPlayer: true, skillDiff: -10, dualWield: false, modMeleeHitChance: 0 })).toBeCloseTo(5.4);
  });

  test("crit chance adds 0.04% per skill point of difference", () => {
    expect(critChanceAgainst(5, 50, 50)).toBe(5);
    expect(critChanceAgainst(5, 50, 75)).toBe(4);
    expect(critChanceAgainst(0, 50, 100)).toBe(0);
  });
});

describe("rage", () => {
  test("RewardRage for dealt and taken damage", () => {
    const factor = rageWeaponSpeedHitFactor(2000, false);
    expect(factor).toBe(7);
    // level 1 conversion 7.500 → from damage 10 = 10 rage; (10 + 7) / 2 = 8.5 → 85 points
    expect(rageReward(1, 10, factor, true)).toBe(84);
    expect(rageReward(1, 10, 0, false)).toBe(33);
  });
});

describe("experience", () => {
  test("gray level and base gain", () => {
    expect(grayLevel(5)).toBe(0);
    expect(grayLevel(10)).toBe(4);
    expect(grayLevel(60)).toBe(51);
    expect(baseGain(1, 1, 0)).toBe(50);
    expect(baseGain(10, 12, 0)).toBe(105);
    expect(baseGain(10, 8, 0)).toBe(67);
    expect(baseGain(10, 4, 0)).toBe(0);
  });

  test("kill XP doubles for elites and ignores critters", () => {
    const base = { playerLevel: 1, mobLevel: 1, mapId: 0, elite: false, experienceModifier: 1, healthModifier: 1, noXp: false, critterOrTotem: false, rateXpKill: 1, playerDamageReq: 0, maxHealth: 100 };
    expect(killXp(base)).toBe(50);
    expect(killXp({ ...base, elite: true })).toBe(100);
    expect(killXp({ ...base, critterOrTotem: true })).toBe(0);
    expect(killXp({ ...base, healthModifier: 0.5 })).toBe(25);
  });
});

describe("ranges", () => {
  test("melee range is at least five yards", () => {
    expect(meleeRange(1.5, 1.5)).toBeCloseTo(5);
    expect(withinMeleeRange({ x: 0, y: 0, z: 0 }, 1.5, { x: 4.9, y: 0, z: 0 }, 1.5)).toBe(true);
    expect(withinMeleeRange({ x: 0, y: 0, z: 0 }, 1.5, { x: 5.4, y: 0, z: 0 }, 1.5)).toBe(false);
    expect(withinMeleeRange({ x: 0, y: 0, z: 0 }, 1.5, { x: 5.4, y: 0, z: 0 }, 1.5, true)).toBe(true);
  });

  test("aggro range shrinks one yard per level the player is above", () => {
    expect(aggroRange({ creatureLevel: 10, playerLevel: 10, detectionRange: 20, aggroRate: 1 })).toBe(20);
    expect(aggroRange({ creatureLevel: 10, playerLevel: 20, detectionRange: 20, aggroRate: 1 })).toBe(10);
    expect(aggroRange({ creatureLevel: 10, playerLevel: 40, detectionRange: 20, aggroRate: 1 })).toBe(5);
    expect(aggroRange({ creatureLevel: 60, playerLevel: 1, detectionRange: 20, aggroRate: 1 })).toBe(45);
  });

  test("HasInArc", () => {
    const self = { x: 0, y: 0, o: 0 };
    expect(hasInArc(self, { x: 5, y: 0 }, Math.PI)).toBe(true);
    expect(hasInArc(self, { x: -5, y: 0 }, Math.PI)).toBe(false);
    expect(hasInArc(self, { x: 5, y: 4 }, (2 * Math.PI) / 3)).toBe(true);
    expect(hasInArc(self, { x: 1, y: 4 }, (2 * Math.PI) / 3)).toBe(false);
  });

  test("leash timer and corpse decay", () => {
    expect(leashTimerSeconds(1)).toBe(11);
    expect(leashTimerSeconds(35)).toBe(12);
    expect(leashTimerSeconds(80)).toBe(17);
    const decay = { normal: 60, rare: 300, elite: 300, rareElite: 300, worldBoss: 3600 };
    expect(corpseDelaySeconds(0, decay)).toBe(60);
    expect(corpseDelaySeconds(3, decay)).toBe(600);
  });
});
