import { urand } from "../common/random.ts";
import {
  CONTENT_1_60,
  CONTENT_61_70,
  CONTENT_71_80,
  LEEWAY_BONUS_RANGE,
  MAX_AGGRO_RADIUS,
  MELEE_HIT_BLOCK,
  MELEE_HIT_CRIT,
  MELEE_HIT_CRUSHING,
  MELEE_HIT_DODGE,
  MELEE_HIT_EVADE,
  MELEE_HIT_GLANCING,
  MELEE_HIT_MISS,
  MELEE_HIT_NORMAL,
  MELEE_HIT_PARRY,
  NOMINAL_MELEE_RANGE,
  type MeleeHitOutcome,
} from "./constants.ts";

export type Point = { x: number; y: number; z: number };

export function distanceSq(left: Point, right: Point): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return dx * dx + dy * dy + dz * dz;
}

export function distance2d(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

/** `Unit::GetMeleeRange` */
export function meleeRange(attackerReach: number, victimReach: number): number {
  return Math.max(attackerReach + victimReach + 4 / 3, NOMINAL_MELEE_RANGE);
}

/**
 * `Unit::IsWithinMeleeRange` with `WorldObject::GetLeewayBonusRange`. `leeway` is true when a player is one side
 * and both sides move forward, strafe, or fall without walking.
 */
export function withinMeleeRange(attacker: Point, attackerReach: number, victim: Point, victimReach: number, leeway = false): boolean {
  const maxDist = meleeRange(attackerReach, victimReach) + (leeway ? LEEWAY_BONUS_RANGE : 0);
  return distanceSq(attacker, victim) < maxDist * maxDist;
}

/** `WorldObject::IsWithinBoundaryRadius` */
export function withinBoundaryRadius(self: Point, target: Point, targetBoundingRadius: number): boolean {
  const radius = targetBoundingRadius > 0 ? targetBoundingRadius : 0;
  return distanceSq(self, target) <= radius * radius;
}

export function normalizeOrientation(angle: number): number {
  const full = Math.PI * 2;
  let value = angle % full;
  if (value < 0) {
    value += full;
  }
  return value;
}

/** `Position::GetAngle` */
export function angleTo(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return normalizeOrientation(Math.atan2(to.y - from.y, to.x - from.x));
}

/** `Position::HasInArc` */
export function hasInArc(self: { x: number; y: number; o: number }, target: { x: number; y: number }, arc: number): boolean {
  if (self.x === target.x && self.y === target.y) {
    return true;
  }
  const full = Math.PI * 2;
  const normalized = normalizeOrientation(arc);
  const clamped = normalized === 0 && arc !== 0 ? full : normalized;
  let angle = angleTo(self, target) - self.o;
  angle = normalizeOrientation(angle);
  if (angle > Math.PI) {
    angle -= full;
  }
  const lborder = -(clamped / 2);
  const rborder = clamped / 2;
  return angle >= lborder && angle <= rborder;
}

/** `Unit::CalcArmorReducedDamage` without auras or armor penetration rating. */
export function armorReducedDamage(damage: number, armor: number, attackerLevel: number, armorPenetrationPct = 0, victimLevel = 0): number {
  let effective = Math.max(0, armor);
  if (armorPenetrationPct > 0) {
    let maxArmorPen = victimLevel < 60 ? 400 + 85 * victimLevel : 400 + 85 * victimLevel + 4.5 * 85 * (victimLevel - 59);
    maxArmorPen = Math.min((effective + maxArmorPen) / 3, effective);
    const armorPen = (maxArmorPen * armorPenetrationPct) / 100;
    effective -= Math.min(armorPen, maxArmorPen);
    effective = Math.max(0, effective);
  }
  let levelModifier = attackerLevel;
  if (levelModifier > 59) {
    levelModifier = levelModifier + 4.5 * (levelModifier - 59);
  }
  let reduction = (0.1 * effective) / (8.5 * levelModifier + 40);
  reduction = reduction / (1 + reduction);
  reduction = Math.min(0.75, Math.max(0, reduction));
  return Math.ceil(Math.max(damage * (1 - reduction), 0));
}

/** Chances in hundredths of a percent, as `RollMeleeOutcomeAgainst(..., int32 crit_chance, ...)` takes them. */
export type MeleeRollInput = {
  attackerIsPlayer: boolean;
  victimIsPlayer: boolean;
  victimEvading: boolean;
  attackerLevel: number;
  victimLevel: number;
  attackerMaxSkillValueForLevel: number;
  victimMaxSkillValueForLevel: number;
  attackerWeaponSkill: number;
  victimDefenseSkill: number;
  crit: number;
  miss: number;
  dodge: number;
  parry: number;
  block: number;
  /** Expertise reduction of dodge and parry (`GetExpertiseDodgeOrParryReduction * 100`). */
  expertiseReduction: number;
  /** The attacker stands inside the victim's front arc of pi. */
  attackerInFront: boolean;
  victimCanDodge: boolean;
  victimCanParry: boolean;
  victimCanBlock: boolean;
  /** Stunned or casting victims can't dodge, parry, or block. */
  victimControlled: boolean;
  /** `CREATURE_FLAG_EXTRA_NO_CRUSHING_BLOWS`, or a player-controlled attacker. */
  noCrushing: boolean;
  /** `CREATURE_FLAG_EXTRA_NO_CRIT` on a creature attacker. */
  noCrit: boolean;
  ranged?: boolean;
};

/** `Unit::RollMeleeOutcomeAgainst` with explicit chances. `roll` is `urand(0, 10000)`. */
export function rollMeleeOutcome(input: MeleeRollInput, roll = urand(0, 10000)): MeleeHitOutcome {
  if (input.victimEvading) {
    return MELEE_HIT_EVADE;
  }
  const skillBonus = 4 * (input.attackerWeaponSkill - input.victimMaxSkillValueForLevel);
  let sum = 0;
  let tmp = input.miss;
  if (tmp > 0 && roll < (sum += tmp)) {
    return MELEE_HIT_MISS;
  }

  const playerHitFromBehind = input.victimIsPlayer && !input.attackerInFront;
  if (!playerHitFromBehind && input.victimCanDodge) {
    tmp = input.dodge - input.expertiseReduction;
    if (input.victimControlled) {
      tmp = 0;
    }
    if (tmp > 0 && (tmp -= skillBonus) > 0 && roll < (sum += tmp)) {
      return MELEE_HIT_DODGE;
    }
  }

  if (input.attackerInFront) {
    const parry = input.parry - input.expertiseReduction;
    if (input.victimCanParry) {
      tmp = input.victimControlled ? 0 : parry;
      if (tmp > 0 && (tmp -= skillBonus) > 0 && roll < (sum += tmp)) {
        return MELEE_HIT_PARRY;
      }
    }
    if (input.victimCanBlock) {
      tmp = input.victimControlled ? 0 : input.block;
      if (tmp > 0 && (tmp -= skillBonus) > 0 && roll < (sum += tmp)) {
        return MELEE_HIT_BLOCK;
      }
    }
  }

  if (!input.ranged && input.attackerIsPlayer && !input.victimIsPlayer && input.attackerLevel < input.victimLevel) {
    const skill = Math.min(input.attackerWeaponSkill, input.attackerMaxSkillValueForLevel);
    tmp = Math.min((10 + (input.victimDefenseSkill - skill)) * 100, 4000);
    if (roll < (sum += tmp)) {
      return MELEE_HIT_GLANCING;
    }
  }

  if (input.attackerLevel >= input.victimLevel + 4 && !input.noCrushing) {
    tmp = Math.min(input.victimDefenseSkill, input.victimMaxSkillValueForLevel);
    tmp = input.attackerMaxSkillValueForLevel - tmp;
    if (tmp >= 15) {
      tmp = tmp * 200 - 1500;
      if (roll < (sum += tmp)) {
        return MELEE_HIT_CRUSHING;
      }
    }
  }

  tmp = input.crit;
  if (tmp > 0 && roll < (sum += tmp) && !input.noCrit) {
    return MELEE_HIT_CRIT;
  }
  return MELEE_HIT_NORMAL;
}

/**
 * `Unit::MeleeSpellMissChance` for a white swing. `victimMissChance` is `GetUnitMissChance`
 * (5 + defense for players). `dualWield` adds the 19% penalty.
 */
export function meleeMissChance(options: {
  victimMissChance: number;
  victimIsPlayer: boolean;
  skillDiff: number;
  dualWield: boolean;
  modMeleeHitChance: number;
}): number {
  let missChance = options.victimMissChance;
  if (options.dualWield) {
    missChance += 19;
  }
  const diff = -options.skillDiff;
  if (options.victimIsPlayer) {
    missChance += diff > 0 ? diff * 0.04 : diff * 0.02;
  } else {
    missChance += diff > 10 ? 1 + (diff - 10) * 0.4 : diff * 0.1;
  }
  missChance -= options.modMeleeHitChance;
  return Math.min(60, Math.max(0, missChance));
}

/** Tail of `Unit::GetUnitCriticalChance`: defense-skill difference and the floor at zero. */
export function critChanceAgainst(baseCrit: number, attackerMaxSkill: number, victimDefense: number, critTakenReduction = 0): number {
  const crit = baseCrit - critTakenReduction + (attackerMaxSkill - victimDefense) * 0.04;
  return crit < 0 ? 0 : crit;
}

/** `Unit::GetRageWeaponSpeedHitFactor` */
export function rageWeaponSpeedHitFactor(attackTimeMs: number, offhand: boolean): number {
  return Math.trunc((attackTimeMs / 1000) * (offhand ? 1.75 : 3.5));
}

/** `Unit::RewardRage` → the rage points (x10 as stored) to add. */
export function rageReward(level: number, damage: number, weaponSpeedHitFactor: number, attacker: boolean, rate = 1): number {
  let conversion = 0.0091107836 * level * level + 3.225598133 * level + 4.2652911;
  if (level > 70) {
    conversion += 13.27 * (level - 70);
  }
  let addRage: number;
  if (attacker) {
    const fromDamage = (damage / conversion) * 7.5;
    addRage = (fromDamage + weaponSpeedHitFactor) / 2;
    addRage = Math.min(addRage, fromDamage * 2);
  } else {
    addRage = (damage / conversion) * 2.5;
  }
  addRage *= rate;
  return Math.trunc(addRage * 10);
}

/** `Acore::XP::GetGrayLevel` */
export function grayLevel(level: number): number {
  if (level <= 5) {
    return 0;
  }
  if (level <= 39) {
    return level - 5 - Math.trunc(level / 10);
  }
  if (level <= 59) {
    return level - 1 - Math.trunc(level / 5);
  }
  return level - 9;
}

/** `Acore::XP::GetZeroDifference` */
export function zeroDifference(level: number): number {
  if (level < 8) return 5;
  if (level < 10) return 6;
  if (level < 12) return 7;
  if (level < 16) return 8;
  if (level < 20) return 9;
  if (level < 30) return 11;
  if (level < 40) return 12;
  if (level < 45) return 13;
  if (level < 50) return 14;
  if (level < 55) return 15;
  if (level < 60) return 16;
  return 17;
}

/** `GetContentLevelsForMapAndZone`: the map's expansion. Outland is 530, Northrend 571. */
export function contentLevelForMap(mapId: number, mapExpansion?: number): number {
  if (mapId < 2) {
    return CONTENT_1_60;
  }
  const expansion = mapExpansion ?? (mapId === 530 ? 1 : mapId === 571 ? 2 : 0);
  return expansion === 1 ? CONTENT_61_70 : expansion === 2 ? CONTENT_71_80 : CONTENT_1_60;
}

/** `Acore::XP::BaseGain` */
export function baseGain(playerLevel: number, mobLevel: number, content: number): number {
  const baseExp = content === CONTENT_61_70 ? 235 : content === CONTENT_71_80 ? 580 : 45;
  if (mobLevel >= playerLevel) {
    const levelDiff = Math.min(mobLevel - playerLevel, 4);
    return Math.trunc((Math.trunc(((playerLevel * 5 + baseExp) * (20 + levelDiff)) / 10) + 1) / 2);
  }
  if (mobLevel > grayLevel(playerLevel)) {
    const zd = zeroDifference(playerLevel);
    return Math.trunc(((playerLevel * 5 + baseExp) * (zd + mobLevel - playerLevel)) / zd);
  }
  return 0;
}

/**
 * `Acore::XP::Gain` for a creature kill plus `KillRewarder::_InitXP`'s low-health reduction.
 * `playerDamageReq` and `maxHealth` scale XP for credit given without enough player damage.
 */
export function killXp(options: {
  playerLevel: number;
  mobLevel: number;
  mapId: number;
  elite: boolean;
  experienceModifier: number;
  healthModifier: number;
  noXp: boolean;
  critterOrTotem: boolean;
  rateXpKill: number;
  playerDamageReq: number;
  maxHealth: number;
}): number {
  if (options.noXp || options.critterOrTotem) {
    return 0;
  }
  let gain = baseGain(options.playerLevel, options.mobLevel, contentLevelForMap(options.mapId));
  if (gain) {
    let xpMod = 1;
    if (options.elite) {
      xpMod *= 2;
    }
    xpMod *= options.experienceModifier;
    xpMod *= options.rateXpKill;
    if (options.playerDamageReq && options.maxHealth > 0) {
      xpMod *= 1 - (2 * options.playerDamageReq) / options.maxHealth;
    }
    gain = Math.trunc(gain * xpMod);
  }
  if (gain && options.healthModifier <= 0.75 && options.healthModifier >= 0) {
    gain = Math.trunc(gain * options.healthModifier);
  }
  return gain;
}

/** `Creature::GetAggroRange` */
export function aggroRange(options: { creatureLevel: number; playerLevel: number; detectionRange: number; aggroRate: number }): number {
  if (options.aggroRate === 0) {
    return 0;
  }
  let levelDiff = options.playerLevel - options.creatureLevel;
  if (levelDiff < -25) {
    levelDiff = -25;
  }
  let radius = options.detectionRange;
  if (radius < 1) {
    return 0;
  }
  radius -= levelDiff;
  radius = Math.min(radius, MAX_AGGRO_RADIUS);
  radius = Math.max(radius, 5);
  return radius * options.aggroRate;
}

/** `Creature::CalculateMinMaxDamage(BASE_ATTACK)` without auras. */
export function creatureMeleeDamage(options: {
  baseDamage: number;
  attackPower: number;
  variance: number;
  damageModifier: number;
  attackTimeMs: number;
}): { min: number; max: number } {
  const weaponMin = options.baseDamage;
  const weaponMax = options.baseDamage * 1.5;
  const baseValue = (options.attackPower / 14) * options.variance;
  const basePct = options.attackTimeMs / 1000;
  let min = (weaponMin + baseValue) * options.damageModifier * basePct;
  let max = (weaponMax + baseValue) * options.damageModifier * basePct;
  if (min < 0 || min > 1e9) min = 0;
  if (max < 0 || max > 1e9) max = 0;
  if (min > max) min = max;
  return { min, max };
}

/** `Unit::CalculateDamage`: `urand(uint32(min), uint32(max))`. */
export function rollDamage(min: number, max: number): number {
  let low = Math.max(0, min);
  let high = Math.max(0, max);
  if (low > high) {
    [low, high] = [high, low];
  }
  return urand(Math.trunc(low), Math.trunc(high));
}

/** `CalculateMeleeDamage` glancing reduction. */
export function glancingDamage(damage: number, attackerLevel: number, victimLevel: number): number {
  const levelDiff = Math.min(victimLevel - attackerLevel, 3);
  return Math.trunc((1 - levelDiff * 0.1) * damage);
}

/** Corpse decay per `CreatureEliteType` (`Corpse.Decay.*`), in seconds. */
export function corpseDelaySeconds(rank: number, decay: CorpseDecay, inInstance = false): number {
  switch (rank) {
    case 4:
      return decay.rare;
    case 1:
      return decay.elite;
    case 2:
      return decay.rareElite;
    case 3:
      return inInstance ? decay.worldBoss : decay.elite * 2;
    default:
      return decay.normal;
  }
}

export type CorpseDecay = { normal: number; rare: number; elite: number; rareElite: number; worldBoss: number };

/** `Creature::GetLeashTimer` in seconds. */
export function leashTimerSeconds(minLevel: number): number {
  const offset = 11;
  const modifier = ((Math.trunc(minLevel / 10) - 2) + 256) % 256;
  return Math.max(offset, (offset + modifier) % 256);
}
