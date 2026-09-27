import { irand, randNorm, rollChanceF, rollChanceI, urand } from "../common/random.ts";
import { ByteWriter } from "../net/byte-buffer.ts";
import { packedGuid } from "../world/update-object.ts";
import type { AuraEffect } from "./aura.ts";
import {
  SPELL_ATTR0_NO_ACTIVE_DEFENSE,
  SPELL_ATTR0_SCALES_WITH_CREATURE_LEVEL,
  SPELL_ATTR2_CANT_CRIT,
  SPELL_ATTR3_ALWAYS_HIT,
  SPELL_ATTR3_COMPLETELY_BLOCKED,
  SPELL_ATTR3_IGNORE_CASTER_MODIFIERS,
  SPELL_ATTR4_IGNORE_DAMAGE_TAKEN_MODIFIERS,
  SPELL_ATTR4_NO_CAST_LOG,
  SPELL_ATTR4_DAMAGE_DOESNT_BREAK_AURAS,
  SPELL_ATTR6_IGNORE_CASTER_DAMAGE_MODIFIERS,
  SPELL_ATTR6_IGNORE_HEALTH_MODIFIERS,
  SPELL_ATTR7_NO_ATTACK_DODGE,
  SPELL_ATTR7_NO_ATTACK_MISS,
  SPELL_ATTR7_NO_ATTACK_PARRY,
  SPELL_ATTR3_TREAT_AS_PERIODIC,
  SPELL_ATTR7_DONT_CAUSE_SPELL_PUSHBACK,
  SPELL_AURA_ABILITY_PERIODIC_CRIT,
  SPELL_AURA_DEFLECT_SPELLS,
  SPELL_AURA_DUMMY,
  SPELL_AURA_IGNORE_COMBAT_RESULT,
  SPELL_AURA_MANA_SHIELD,
  SPELL_AURA_MELEE_ATTACK_POWER_ATTACKER_BONUS,
  SPELL_AURA_MOD_ABILITY_IGNORE_TARGET_RESIST,
  SPELL_AURA_MOD_AOE_AVOIDANCE,
  SPELL_AURA_MOD_AOE_DAMAGE_AVOIDANCE,
  SPELL_AURA_MOD_ATTACKER_MELEE_CRIT_CHANCE,
  SPELL_AURA_MOD_ATTACKER_MELEE_CRIT_DAMAGE,
  SPELL_AURA_MOD_ATTACKER_MELEE_HIT_CHANCE,
  SPELL_AURA_MOD_ATTACKER_RANGED_CRIT_CHANCE,
  SPELL_AURA_MOD_ATTACKER_RANGED_CRIT_DAMAGE,
  SPELL_AURA_MOD_ATTACKER_RANGED_HIT_CHANCE,
  SPELL_AURA_MOD_ATTACKER_SPELL_AND_WEAPON_CRIT_CHANCE,
  SPELL_AURA_MOD_ATTACKER_SPELL_CRIT_CHANCE,
  SPELL_AURA_MOD_ATTACKER_SPELL_HIT_CHANCE,
  SPELL_AURA_MOD_BLOCK_PERCENT,
  SPELL_AURA_MOD_COMBAT_RESULT_CHANCE,
  SPELL_AURA_MOD_CREATURE_AOE_DAMAGE_AVOIDANCE,
  SPELL_AURA_MOD_CRIT_CHANCE_FOR_CASTER,
  SPELL_AURA_MOD_CRIT_DAMAGE_BONUS,
  SPELL_AURA_MOD_CRIT_PCT,
  SPELL_AURA_MOD_CRIT_PERCENT_VERSUS,
  SPELL_AURA_MOD_CRITICAL_HEALING_AMOUNT,
  SPELL_AURA_MOD_DAMAGE_DONE,
  SPELL_AURA_MOD_DAMAGE_DONE_CREATURE,
  SPELL_AURA_MOD_DAMAGE_DONE_VERSUS,
  SPELL_AURA_MOD_DAMAGE_DONE_VERSUS_AURASTATE,
  SPELL_AURA_MOD_DAMAGE_FROM_CASTER,
  SPELL_AURA_MOD_DAMAGE_PERCENT_DONE,
  SPELL_AURA_MOD_DAMAGE_PERCENT_TAKEN,
  SPELL_AURA_MOD_DAMAGE_TAKEN,
  SPELL_AURA_MOD_DEBUFF_RESISTANCE,
  SPELL_AURA_MOD_DODGE_PERCENT,
  SPELL_AURA_MOD_ENEMY_DODGE,
  SPELL_AURA_MOD_EXPERTISE,
  SPELL_AURA_MOD_FLAT_SPELL_DAMAGE_VERSUS,
  SPELL_AURA_MOD_HEALING,
  SPELL_AURA_MOD_HEALING_DONE,
  SPELL_AURA_MOD_HEALING_DONE_PERCENT,
  SPELL_AURA_MOD_HEALING_PCT,
  SPELL_AURA_MOD_HEALING_RECEIVED,
  SPELL_AURA_MOD_HOT_PCT,
  SPELL_AURA_MOD_IGNORE_TARGET_RESIST_MODIFIERS,
  SPELL_AURA_MOD_INCREASES_SPELL_PCT_TO_HIT,
  SPELL_AURA_MOD_MECHANIC_DAMAGE_TAKEN_PERCENT,
  SPELL_AURA_MOD_MECHANIC_RESISTANCE,
  SPELL_AURA_MOD_MELEE_ATTACK_POWER_VERSUS,
  SPELL_AURA_MOD_MELEE_DAMAGE_TAKEN,
  SPELL_AURA_MOD_MELEE_DAMAGE_TAKEN_PCT,
  SPELL_AURA_MOD_PARRY_PERCENT,
  SPELL_AURA_MOD_RANGED_ATTACK_POWER_VERSUS,
  SPELL_AURA_MOD_RANGED_DAMAGE_TAKEN,
  SPELL_AURA_MOD_RANGED_DAMAGE_TAKEN_PCT,
  SPELL_AURA_MOD_SPELL_CRIT_CHANCE_SCHOOL,
  SPELL_AURA_MOD_SPELL_DAMAGE_OF_ATTACK_POWER,
  SPELL_AURA_MOD_SPELL_DAMAGE_OF_STAT_PERCENT,
  SPELL_AURA_MOD_SPELL_HEALING_OF_ATTACK_POWER,
  SPELL_AURA_MOD_SPELL_HEALING_OF_STAT_PERCENT,
  SPELL_AURA_MOD_TARGET_ABILITY_ABSORB_SCHOOL,
  SPELL_AURA_MOD_TARGET_ABSORB_SCHOOL,
  SPELL_AURA_MOD_TARGET_RESISTANCE,
  SPELL_AURA_MOD_WEAPON_CRIT_PERCENT,
  SPELL_AURA_PERIODIC_DAMAGE,
  SPELL_AURA_PERIODIC_HEAL,
  SPELL_AURA_PERIODIC_HEALTH_FUNNEL,
  SPELL_AURA_PERIODIC_LEECH,
  SPELL_AURA_RANGED_ATTACK_POWER_ATTACKER_BONUS,
  SPELL_AURA_REFLECT_SPELLS,
  SPELL_AURA_REFLECT_SPELLS_SCHOOL,
  SPELL_AURA_SCHOOL_ABSORB,
  SPELL_AURA_SHARE_DAMAGE_PCT,
  SPELL_AURA_CONTROL_VEHICLE,
  SPELL_EFFECT_APPLY_AURA,
  SPELL_EFFECT_DISPEL,
  SPELL_EFFECT_ENVIRONMENTAL_DAMAGE,
  SPELL_EFFECT_HEAL,
  SPELL_EFFECT_HEALTH_LEECH,
  SPELL_EFFECT_NORMALIZED_WEAPON_DMG,
  SPELL_EFFECT_POWER_BURN,
  SPELL_EFFECT_POWER_DRAIN,
  SPELL_EFFECT_SCHOOL_DAMAGE,
  SPELL_EFFECT_TRIGGER_SPELL_WITH_VALUE,
  SPELL_EFFECT_DUMMY,
  SPELL_EFFECT_SCRIPT_EFFECT,
  SPELL_EFFECT_WEAPON_DAMAGE,
  SPELL_EFFECT_FORCE_CAST_WITH_VALUE,
  SPELL_EFFECT_TRIGGER_MISSILE_SPELL_WITH_VALUE,
  SPELL_AURA_DAMAGE_SHIELD,
  SPELL_AURA_PROC_TRIGGER_DAMAGE,
  SPELL_AURA_PERIODIC_MANA_LEECH,
  SPELL_AURA_PERIODIC_TRIGGER_SPELL_WITH_VALUE,
  SPELL_MISS_BLOCK,
  SPELL_MISS_DEFLECT,
  SPELL_MISS_DODGE,
  SPELL_MISS_EVADE,
  SPELL_MISS_IMMUNE,
  SPELL_MISS_MISS,
  SPELL_MISS_NONE,
  SPELL_MISS_PARRY,
  SPELL_MISS_REFLECT,
  SPELL_MISS_RESIST,
} from "./defines.ts";
import {
  SPELL_ATTR0_CU_BINARY_SPELL,
  AURA_INTERRUPT_FLAG_DIRECT_DAMAGE,
  AURA_INTERRUPT_FLAG_TAKE_DAMAGE,
  AURA_REMOVE_BY_ENEMY_SPELL,
  CHANNEL_FLAG_DELAY,
  CURRENT_CHANNELED_SPELL,
  CURRENT_GENERIC_SPELL,
  DOT,
  MECHANIC_BLEED,
  NODAMAGE,
  POWER_MANA,
  POWER_RAGE,
  SPELL_ATTR0_CU_IGNORE_ARMOR,
  SPELL_ATTR0_CU_NO_POSITIVE_TAKEN_BONUS,
  SPELL_ATTR0_CU_REQ_CASTER_BEHIND_TARGET,
  SPELL_ATTR0_CU_SCHOOLMASK_NORMAL_WITH_MAGIC,
  SPELL_DAMAGE_CLASS_MAGIC,
  SPELL_DAMAGE_CLASS_MELEE,
  SPELL_DAMAGE_CLASS_NONE,
  SPELL_DAMAGE_CLASS_RANGED,
  SPELL_DIRECT_DAMAGE,
  SPELL_INTERRUPT_FLAG_ABORT_ON_DMG,
  SPELL_INTERRUPT_FLAG_PUSH_BACK,
  SPELL_SCHOOL_MASK_HOLY,
  SPELL_SCHOOL_MASK_NORMAL,
  SPELL_STATE_CASTING,
  SPELL_STATE_PREPARING,
  SPELLFAMILY_POTION,
  DIRECT_DAMAGE,
  UNIT_STATE_CONTROLLED,
  UNIT_STATE_STUNNED,
  STAT_STRENGTH,
} from "./enums.ts";
import {
  SMSG_PERIODICAURALOG,
  SMSG_SPELLENERGIZELOG,
  SMSG_SPELLHEALLOG,
  SMSG_SPELLLOGMISS,
  SMSG_SPELLNONMELEEDAMAGELOG,
  energizeLogPacket,
  periodicAuraLogPacket,
  spellDamageLogPacket,
  spellMissPacket,
  type PeriodicLog,
} from "./packets.ts";
import {
  calcCastTime,
  calcEffectValue,
  effectIsTargetingArea,
  effectMechanic,
  effectMechanicMask,
  firstSchool,
  hasAttribute,
  hasAura,
  hasCustomAttribute,
  hasEffect,
  isAffectingArea,
  isChanneled,
  isCritCapable,
  isPositive,
  allEffectsMechanicMask,
  maxTicks,
  spellDuration,
  type SpellInfo,
  mechanicMaskByEffectMask,
} from "./spell-info.ts";
import type { DamageInfo, SpellUnit } from "./unit.ts";

const RANGED_ATTACK = 2;
const BASE_ATTACK = 0;
const OFF_ATTACK = 1;
const CR_CRIT_TAKEN_MELEE = 14;
const CR_CRIT_TAKEN_RANGED = 15;
const CR_CRIT_TAKEN_SPELL = 16;
const CR_HIT_TAKEN_SPELL = 13;
const CR_ARMOR_PENETRATION = 24;
const SPELL_HIT_TYPE_CRIT = 0x2;
const MELEE_HIT_DODGE = 2;
const MELEE_HIT_BLOCK = 3;
const MELEE_HIT_PARRY = 4;
const VICTIMSTATE_DODGE = 2;
const CREATURE_FLAG_EXTRA_NO_PARRY = 0x00000004;
const CREATURE_FLAG_EXTRA_NO_BLOCK = 0x00000010;
const CREATURE_FLAG_EXTRA_NO_DODGE = 0x00800000;
const CREATURE_TYPE_HUMANOID = 7;
const MISS_CHANCE_MULTIPLIER_PLAYER = 7;
const MISS_CHANCE_MULTIPLIER_CREATURE = 11;
const f = Math.fround;

function addPct(value: number, pct: number): number {
  return f(value + (value * pct) / 100);
}

// ------------------------------------------------------------------ amounts

/** `WorldObject::CalculateSpellDamage` → `SpellEffectInfo::CalcValue` with the caster. */
export function calculateSpellDamage(caster: SpellUnit, info: SpellInfo, effIndex: number, basePoints?: number): number {
  const effect = info.effects[effIndex]!;
  let value = calcEffectValue(info, effect, caster.level, caster.comboPoints, irand, basePoints);
  // amount multiplication based on caster's level (creature casts of level-scaling spells)
  if (!caster.isControlledByPlayer() && info.spellLevel && info.spellLevel !== caster.level && !effect.realPointsPerLevel && hasAttribute(info, 0, SPELL_ATTR0_SCALES_WITH_CREATURE_LEVEL)) {
    let canEffectScale = false;
    switch (effect.effect) {
      case SPELL_EFFECT_SCHOOL_DAMAGE:
      case SPELL_EFFECT_DUMMY:
      case SPELL_EFFECT_POWER_DRAIN:
      case SPELL_EFFECT_HEALTH_LEECH:
      case SPELL_EFFECT_HEAL:
      case SPELL_EFFECT_WEAPON_DAMAGE:
      case SPELL_EFFECT_POWER_BURN:
      case SPELL_EFFECT_SCRIPT_EFFECT:
      case SPELL_EFFECT_NORMALIZED_WEAPON_DMG:
      case SPELL_EFFECT_FORCE_CAST_WITH_VALUE:
      case SPELL_EFFECT_TRIGGER_SPELL_WITH_VALUE:
      case SPELL_EFFECT_TRIGGER_MISSILE_SPELL_WITH_VALUE:
        canEffectScale = true;
        break;
      default:
        break;
    }
    switch (effect.applyAuraName) {
      case SPELL_AURA_PERIODIC_DAMAGE:
      case SPELL_AURA_DUMMY:
      case SPELL_AURA_PERIODIC_HEAL:
      case SPELL_AURA_DAMAGE_SHIELD:
      case SPELL_AURA_PROC_TRIGGER_DAMAGE:
      case SPELL_AURA_PERIODIC_LEECH:
      case SPELL_AURA_PERIODIC_MANA_LEECH:
      case SPELL_AURA_SCHOOL_ABSORB:
      case SPELL_AURA_PERIODIC_TRIGGER_SPELL_WITH_VALUE:
        canEffectScale = true;
        break;
      default:
        break;
    }
    const trigger = effect.triggerSpell ? caster.world.spells.get(effect.triggerSpell) : null;
    if (trigger && hasAttribute(trigger, 0, SPELL_ATTR0_SCALES_WITH_CREATURE_LEVEL)) canEffectScale = false;
    if (canEffectScale) {
      const expansion = caster.creatureExpansion();
      const creature = caster.world.spells.creatureBaseStats(caster.level, caster.classId);
      const spell = caster.world.spells.creatureBaseStats(info.spellLevel, caster.classId);
      if (creature && spell && spell.baseDamage[expansion]) value = Math.trunc(f(value * f(creature.baseDamage[expansion]! / spell.baseDamage[expansion]!)));
    }
  }
  return value;
}

/** `Unit::CalculateLevelPenalty` */
export function calculateLevelPenalty(unit: SpellUnit, info: SpellInfo): number {
  if (!unit.isPlayer) return 1;
  if (info.spellLevel <= 0 || info.spellLevel >= info.maxLevel) return 1;
  let penalty = 0;
  if (info.spellLevel < 20) penalty = (20 - info.spellLevel) * 3.75;
  let factor = f((info.spellLevel + 6) / unit.level);
  if (factor > 1) factor = 1;
  return addPct(factor, -penalty);
}

/** `Unit::GetCastingTimeForBonus` */
export function castingTimeForBonus(unit: SpellUnit, info: SpellInfo, damageType: number, castingTime: number): number {
  if (castingTime === 0 && unit.isCreature && !unit.isPet()) return 3500;
  if (castingTime > 7000) castingTime = 7000;
  if (castingTime < 1500) castingTime = 1500;
  if (damageType === DOT && !isChanneled(info)) castingTime = 3500;
  let overTime = 0;
  let effects = 0;
  let directDamage = false;
  let areaEffect = false;
  for (const effect of info.effects) {
    switch (effect.effect) {
      case SPELL_EFFECT_SCHOOL_DAMAGE:
      case SPELL_EFFECT_POWER_DRAIN:
      case SPELL_EFFECT_HEALTH_LEECH:
      case SPELL_EFFECT_ENVIRONMENTAL_DAMAGE:
      case SPELL_EFFECT_POWER_BURN:
      case SPELL_EFFECT_HEAL:
        directDamage = true;
        break;
      case SPELL_EFFECT_APPLY_AURA:
        switch (effect.applyAuraName) {
          case SPELL_AURA_PERIODIC_DAMAGE:
          case SPELL_AURA_PERIODIC_HEAL:
          case SPELL_AURA_PERIODIC_LEECH:
            if (spellDuration(info)) overTime = spellDuration(info);
            break;
          default:
            effects++;
            break;
        }
        break;
      default:
        break;
    }
    if (effectIsTargetingArea(effect)) areaEffect = true;
  }
  if (overTime > 0 && directDamage) {
    let original = calcCastTime(info);
    if (original > 7000) original = 7000;
    if (original < 1500) original = 1500;
    const ptot = f(f(overTime / 15000) / f(f(overTime / 15000) + f(original / 3500)));
    if (damageType === DOT) castingTime = Math.trunc(castingTime * ptot);
    else if (ptot < 1) castingTime = Math.trunc(castingTime * (1 - ptot));
    else castingTime = 0;
  }
  if (areaEffect) castingTime = Math.trunc(castingTime / 2);
  for (const effect of info.effects) {
    if (effect.effect === SPELL_EFFECT_HEALTH_LEECH || (effect.effect === SPELL_EFFECT_APPLY_AURA && effect.applyAuraName === SPELL_AURA_PERIODIC_LEECH)) {
      castingTime = Math.trunc(castingTime / 2);
      break;
    }
  }
  for (let i = 0; i < effects; i++) castingTime = Math.trunc(castingTime * 0.95);
  return castingTime;
}

/** `Unit::CalculateDefaultCoefficient` */
export function calculateDefaultCoefficient(unit: SpellUnit, info: SpellInfo, damageType: number): number {
  let dotFactor = 1;
  if (damageType === DOT) {
    const dotDuration = spellDuration(info);
    if (!isChanneled(info) && dotDuration > 0) dotFactor = f(dotDuration / 15000);
    const ticks = maxTicks(info);
    if (ticks) dotFactor = f(dotFactor / ticks);
  }
  let castingTime = isChanneled(info) ? spellDuration(info) : calcCastTime(info);
  castingTime = castingTimeForBonus(unit, info, damageType, castingTime);
  return f(f(castingTime / 3500) * dotFactor);
}

/** `SpellInfo::IsRangedWeaponSpell` */
function isRangedWeaponSpell(info: SpellInfo): boolean {
  return (info.spellFamilyName === 9 /* SPELLFAMILY_HUNTER */ && !(info.spellFamilyFlags[1] & 0x10000000)) || (info.equippedItemSubClassMask & 0x0004000c) !== 0 && info.equippedItemClass === 2 || hasAttribute(info, 0, 0x2);
}

/** `SpellInfo::ValidateAttribute6SpellDamageMods` */
function validateAttribute6SpellDamageMods(info: SpellInfo, caster: SpellUnit | null, auraEffect: AuraEffect | null, isDot: boolean): boolean {
  if (!hasAttribute(info, 6, SPELL_ATTR6_IGNORE_CASTER_DAMAGE_MODIFIERS)) return true;
  if (info.id === 70890 && auraEffect) {
    const auraInfo = auraEffect.spellInfo;
    return auraInfo.spellIconId === 3086 || (auraInfo.spellFamilyName === 15 && (!!(auraInfo.spellFamilyFlags[0] & 8388608 || auraInfo.spellFamilyFlags[1] & 64 || auraInfo.spellFamilyFlags[2] & 16) || auraInfo.spellIconId === 235 || auraInfo.spellIconId === 154));
  }
  if (info.id === 51460) return false;
  return !isDot && !!auraEffect && (auraEffect.amount < 0 || (auraEffect.casterGuid === caster?.guid && auraEffect.spellInfo.spellFamilyName === info.spellFamilyName)) && !auraEffect.base.castItemGuid;
}

// ------------------------------------------------------------------ damage bonuses

/** `Unit::SpellPctDamageModsDone` (the override-class-script, glyph, and talent branches belong to the class layer). */
export function spellPctDamageModsDone(unit: SpellUnit, victim: SpellUnit, info: SpellInfo, damageType: number): number {
  if (damageType === DIRECT_DAMAGE) return 1;
  if (hasAttribute(info, 3, SPELL_ATTR3_IGNORE_CASTER_MODIFIERS)) return 1;
  let done = 1;
  done = f(done * unit.getTotalAuraMultiplier(SPELL_AURA_MOD_DAMAGE_PERCENT_DONE, (aurEff) => {
    const auraInfo = aurEff.spellInfo;
    if (info.equippedItemClass === -1 && auraInfo.equippedItemClass !== -1 && !hasAttribute(auraInfo, 5, 0x00080000) && aurEff.miscValue === SPELL_SCHOOL_MASK_NORMAL) return false;
    if (!validateAttribute6SpellDamageMods(info, unit, aurEff, damageType === DOT)) return false;
    if (aurEff.miscValue & info.schoolMask) {
      if (auraInfo.equippedItemClass === -1) return true;
      if (!hasAttribute(auraInfo, 5, 0x00080000) && auraInfo.equippedItemSubClassMask === 0) return true;
      return unit.hasItemFitToSpellRequirements(auraInfo);
    }
    return false;
  }));
  const creatureTypeMask = victim.creatureTypeMask();
  done = f(done * unit.getTotalAuraMultiplier(SPELL_AURA_MOD_DAMAGE_DONE_VERSUS, (aurEff) => (creatureTypeMask & aurEff.miscValue) !== 0 && validateAttribute6SpellDamageMods(info, unit, aurEff, damageType === DOT)));
  done = f(done * unit.getTotalAuraMultiplier(SPELL_AURA_MOD_DAMAGE_DONE_VERSUS_AURASTATE, (aurEff) => victim.hasAuraState(aurEff.miscValue) && validateAttribute6SpellDamageMods(info, unit, aurEff, damageType === DOT)));
  return done;
}

/** `Unit::SpellBaseDamageBonusDone` */
export function spellBaseDamageBonusDone(unit: SpellUnit, schoolMask: number): number {
  let benefit = unit.getTotalAuraModifier(SPELL_AURA_MOD_DAMAGE_DONE, (aurEff) => (aurEff.miscValue & schoolMask) !== 0 && aurEff.spellInfo.equippedItemClass === -1 && aurEff.spellInfo.equippedItemInventoryTypeMask === 0);
  if (unit.isPlayer) {
    benefit += unit.stats.baseSpellDamageBonus();
    for (const aurEff of unit.auraEffectsByType(SPELL_AURA_MOD_SPELL_DAMAGE_OF_STAT_PERCENT)) {
      if (aurEff.miscValue & schoolMask) benefit += Math.trunc((unit.stats.getStat(aurEff.miscValueB) * aurEff.amount) / 100);
    }
    benefit += Math.trunc((unit.stats.getTotalAttackPowerValue(BASE_ATTACK) * unit.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_SPELL_DAMAGE_OF_ATTACK_POWER, schoolMask)) / 100);
  }
  return benefit;
}

/** `Unit::SpellBaseDamageBonusTaken` */
export function spellBaseDamageBonusTaken(unit: SpellUnit, schoolMask: number, isDot: boolean): number {
  return unit.getTotalAuraModifier(SPELL_AURA_MOD_DAMAGE_TAKEN, (aurEff) => (aurEff.miscValue & schoolMask) !== 0 && !(isDot && aurEff.base.isUsingCharges && aurEff.spellInfo.procFlags & 0x00040000 /* PROC_FLAG_TAKEN_PERIODIC */));
}

/** `Unit::SpellDamageBonusDone` */
export function spellDamageBonusDone(unit: SpellUnit, victim: SpellUnit, info: SpellInfo, damage: number, damageType: number, effIndex: number, totalMod = 0, stack = 1): number {
  if (damageType === DIRECT_DAMAGE) return damage;
  if (hasAttribute(info, 3, SPELL_ATTR3_IGNORE_CASTER_MODIFIERS)) return damage;
  const apCoeffMod = 1;
  let doneTotal = 0;
  let doneTotalMod = totalMod ? totalMod : spellPctDamageModsDone(unit, victim, info, damageType);
  if (unit.isCreature) doneTotalMod = f(doneTotalMod * unit.creatureSpellDamageMod());
  if (!hasAttribute(info, 6, SPELL_ATTR6_IGNORE_CASTER_DAMAGE_MODIFIERS)) doneTotal += unit.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_FLAT_SPELL_DAMAGE_VERSUS, victim.creatureTypeMask());
  let advertised = spellBaseDamageBonusDone(unit, info.schoolMask);
  let coeff = info.effects[effIndex]!.bonusMultiplier;
  const bonus = unit.world.spells.bonusData(info.id);
  const attType = isRangedWeaponSpell(info) && info.dmgClass !== SPELL_DAMAGE_CLASS_MELEE ? RANGED_ATTACK : BASE_ATTACK;
  if (bonus) {
    const apBonus = (): number => victim.getTotalAuraModifier(attType === BASE_ATTACK ? SPELL_AURA_MELEE_ATTACK_POWER_ATTACKER_BONUS : SPELL_AURA_RANGED_ATTACK_POWER_ATTACKER_BONUS) + unit.stats.getTotalAttackPowerValue(attType);
    if (damageType === DOT) {
      coeff = bonus.dot;
      if (bonus.apDot > 0) doneTotal += Math.trunc(bonus.apDot * stack * apCoeffMod * apBonus());
    } else {
      coeff = bonus.direct;
      if (bonus.ap > 0) doneTotal += Math.trunc(bonus.ap * stack * apCoeffMod * apBonus());
    }
  } else if (info.dmgClass === SPELL_DAMAGE_CLASS_NONE) {
    return Math.trunc(Math.max(f((damage + doneTotal) * doneTotalMod), 0));
  }
  if (coeff && advertised) {
    const factorMod = f(calculateLevelPenalty(unit, info) * stack);
    doneTotal += Math.trunc(advertised * coeff * factorMod);
  }
  advertised = 0;
  return Math.trunc(Math.max(f((damage + doneTotal) * doneTotalMod), 0));
}

/** `Unit::SpellDamageBonusTaken` */
export function spellDamageBonusTaken(unit: SpellUnit, caster: SpellUnit | null, info: SpellInfo, damage: number, damageType: number, stack = 1): number {
  if (damageType === DIRECT_DAMAGE) return damage;
  let takenTotal = 0;
  let takenTotalMod = unit.getTotalAuraMultiplierByMiscMask(SPELL_AURA_MOD_DAMAGE_PERCENT_TAKEN, info.schoolMask);
  if (caster) {
    takenTotalMod = f(takenTotalMod * unit.getTotalAuraMultiplier(SPELL_AURA_MOD_DAMAGE_FROM_CASTER, (aurEff) => aurEff.casterGuid === caster.guid && aurEff.isAffectedOnSpell(info)));
  }
  const mechanicMask = allEffectsMechanicMask(info);
  if (mechanicMask) {
    let modifierMax = 0;
    let modifierMin = 0;
    for (const aurEff of unit.auraEffectsByType(SPELL_AURA_MOD_MECHANIC_DAMAGE_TAKEN_PERCENT)) {
      if (!validateAttribute6SpellDamageMods(info, caster, aurEff, damageType === DOT)) continue;
      if (aurEff.spellInfo.spellFamilyName === 15 && (!caster || caster.guid !== aurEff.casterGuid)) continue;
      if (mechanicMask & (1n << BigInt(aurEff.miscValue))) {
        if (aurEff.amount > 0) modifierMax = Math.max(modifierMax, aurEff.amount);
        else if (aurEff.amount < modifierMin) modifierMin = aurEff.amount;
      }
    }
    takenTotalMod = addPct(takenTotalMod, modifierMax);
    takenTotalMod = addPct(takenTotalMod, modifierMin);
  }
  const advertised = spellBaseDamageBonusTaken(unit, info.schoolMask, damageType === DOT);
  let coeff = 0;
  const bonus = unit.world.spells.bonusData(info.id);
  if (bonus) coeff = damageType === DOT ? bonus.dot : bonus.direct;
  if (advertised) {
    if (coeff <= 0) coeff = (caster ?? unit) ? calculateDefaultCoefficient(caster ?? unit, info, damageType) * stack : 0;
    const factorMod = f(calculateLevelPenalty(unit, info) * stack);
    takenTotal += Math.trunc(advertised * coeff * factorMod);
  }
  if (hasCustomAttribute(info, SPELL_ATTR0_CU_NO_POSITIVE_TAKEN_BONUS) && takenTotalMod > 1) {
    takenTotal = 0;
    takenTotalMod = 1;
  }
  if (caster && takenTotalMod < 1 && caster.hasAuraType(SPELL_AURA_MOD_IGNORE_TARGET_RESIST_MODIFIERS)) {
    let damageModifier = f(1 - takenTotalMod);
    for (const aurEff of caster.auraEffectsByType(SPELL_AURA_MOD_IGNORE_TARGET_RESIST_MODIFIERS)) {
      if (aurEff.miscValue & info.schoolMask) damageModifier = addPct(damageModifier, -aurEff.amount);
    }
    takenTotalMod = f(1 - damageModifier);
  }
  return Math.trunc(Math.max(f((damage + takenTotal) * takenTotalMod), 0));
}

/** `Unit::MeleeDamageBonusDone` */
export function meleeDamageBonusDone(unit: SpellUnit, victim: SpellUnit, damage: number, attType: number, info: SpellInfo | null, schoolMask = SPELL_SCHOOL_MASK_NORMAL): number {
  if (damage === 0) return 0;
  const creatureTypeMask = victim.creatureTypeMask();
  let doneFlat = unit.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_DAMAGE_DONE_CREATURE, creatureTypeMask);
  let apBonus = 0;
  if (attType === RANGED_ATTACK) {
    apBonus += victim.getTotalAuraModifier(SPELL_AURA_RANGED_ATTACK_POWER_ATTACKER_BONUS);
    apBonus += unit.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_RANGED_ATTACK_POWER_VERSUS, creatureTypeMask);
  } else {
    apBonus += victim.getTotalAuraModifier(SPELL_AURA_MELEE_ATTACK_POWER_ATTACKER_BONUS);
    apBonus += unit.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_MELEE_ATTACK_POWER_VERSUS, creatureTypeMask);
  }
  if (apBonus !== 0) {
    const normalized = !!info && hasEffect(info, SPELL_EFFECT_NORMALIZED_WEAPON_DMG);
    doneFlat += Math.trunc(f(apBonus / 14) * unit.apMultiplier(attType, normalized));
  }
  let doneMod = 1;
  if (!(schoolMask & SPELL_SCHOOL_MASK_NORMAL)) {
    doneMod = f(doneMod * unit.getTotalAuraMultiplier(SPELL_AURA_MOD_DAMAGE_PERCENT_DONE, (aurEff) => {
      if (info && !validateAttribute6SpellDamageMods(info, unit, aurEff, false)) return false;
      if (!(aurEff.miscValue & schoolMask)) return false;
      if (aurEff.spellInfo.equippedItemClass === -1) return true;
      if (!hasAttribute(aurEff.spellInfo, 5, 0x00080000) && aurEff.spellInfo.equippedItemSubClassMask === 0) return true;
      return unit.hasItemFitToSpellRequirements(aurEff.spellInfo);
    }));
  }
  doneMod = f(doneMod * unit.getTotalAuraMultiplier(SPELL_AURA_MOD_DAMAGE_DONE_VERSUS, (aurEff) => (creatureTypeMask & aurEff.miscValue) !== 0 && (!info || validateAttribute6SpellDamageMods(info, unit, aurEff, false))));
  doneMod = f(doneMod * unit.getTotalAuraMultiplier(SPELL_AURA_MOD_DAMAGE_DONE_VERSUS_AURASTATE, (aurEff) => victim.hasAuraState(aurEff.miscValue) && (!info || validateAttribute6SpellDamageMods(info, unit, aurEff, false))));
  if (info && hasAttribute(info, 3, SPELL_ATTR3_IGNORE_CASTER_MODIFIERS)) {
    doneFlat = 0;
    doneMod = 1;
  }
  return Math.trunc(Math.max(f((damage + doneFlat) * doneMod), 0));
}

/** `Unit::MeleeDamageBonusTaken` */
export function meleeDamageBonusTaken(unit: SpellUnit, attacker: SpellUnit, damage: number, attType: number, info: SpellInfo | null, schoolMask = SPELL_SCHOOL_MASK_NORMAL): number {
  if (damage === 0) return 0;
  let takenFlat = unit.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_DAMAGE_TAKEN, schoolMask);
  takenFlat += unit.getTotalAuraModifier(attType !== RANGED_ATTACK ? SPELL_AURA_MOD_MELEE_DAMAGE_TAKEN : SPELL_AURA_MOD_RANGED_DAMAGE_TAKEN);
  let takenMod = unit.getTotalAuraMultiplierByMiscMask(SPELL_AURA_MOD_DAMAGE_PERCENT_TAKEN, schoolMask);
  if (info) {
    takenMod = f(takenMod * unit.getTotalAuraMultiplier(SPELL_AURA_MOD_DAMAGE_FROM_CASTER, (aurEff) => attacker.guid === aurEff.casterGuid && aurEff.isAffectedOnSpell(info)));
    let mechanicMask = allEffectsMechanicMask(info);
    if (info.spellFamilyName === 7 /* SPELLFAMILY_DRUID */ && info.spellFamilyFlags[0] & 0x00008800) mechanicMask |= 1n << BigInt(MECHANIC_BLEED);
    if (mechanicMask) takenMod = f(takenMod * unit.getTotalAuraMultiplier(SPELL_AURA_MOD_MECHANIC_DAMAGE_TAKEN_PERCENT, (aurEff) => (mechanicMask & (1n << BigInt(aurEff.miscValue))) !== 0n));
  }
  takenMod = f(takenMod * unit.getTotalAuraMultiplier(attType !== RANGED_ATTACK ? SPELL_AURA_MOD_MELEE_DAMAGE_TAKEN_PCT : SPELL_AURA_MOD_RANGED_DAMAGE_TAKEN_PCT));
  if (info && hasCustomAttribute(info, SPELL_ATTR0_CU_NO_POSITIVE_TAKEN_BONUS) && takenMod > 1) {
    takenFlat = 0;
    takenMod = 1;
  }
  if (takenMod < 1 && attacker.hasAuraType(SPELL_AURA_MOD_IGNORE_TARGET_RESIST_MODIFIERS)) {
    let damageModifier = f(1 - takenMod);
    for (const aurEff of attacker.auraEffectsByType(SPELL_AURA_MOD_IGNORE_TARGET_RESIST_MODIFIERS)) if (aurEff.miscValue & schoolMask) damageModifier = addPct(damageModifier, -aurEff.amount);
    takenMod = f(1 - damageModifier);
  }
  return Math.trunc(Math.max(f((damage + takenFlat) * takenMod), 0));
}

// ------------------------------------------------------------------ healing bonuses

/** `Unit::SpellPctHealingModsDone` (override-class-script and glyph branches belong to the class layer). */
export function spellPctHealingModsDone(unit: SpellUnit, _victim: SpellUnit, info: SpellInfo, _damageType: number, includeHealingDonePct = true): number {
  if (hasAttribute(info, 3, SPELL_ATTR3_IGNORE_CASTER_MODIFIERS)) return 1;
  if (hasAttribute(info, 6, SPELL_ATTR6_IGNORE_HEALTH_MODIFIERS)) return 1;
  if (info.spellFamilyName === SPELLFAMILY_POTION) return 1;
  let done = 1;
  if (includeHealingDonePct) done = f(done * unit.getTotalAuraMultiplier(SPELL_AURA_MOD_HEALING_DONE_PERCENT));
  return done;
}

/** `Unit::SpellBaseHealingBonusDone` */
export function spellBaseHealingBonusDone(unit: SpellUnit, schoolMask: number): number {
  let benefit = unit.getTotalAuraModifier(SPELL_AURA_MOD_HEALING_DONE, (aurEff) => !aurEff.miscValue || (aurEff.miscValue & schoolMask) !== 0);
  if (unit.isPlayer) {
    benefit += unit.stats.baseSpellHealingBonus();
    for (const aurEff of unit.auraEffectsByType(SPELL_AURA_MOD_SPELL_HEALING_OF_STAT_PERCENT)) {
      benefit += Math.trunc((unit.stats.getStat(aurEff.miscValue) * aurEff.amount) / 100);
    }
    benefit += Math.trunc((unit.stats.getTotalAttackPowerValue(BASE_ATTACK) * unit.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_SPELL_HEALING_OF_ATTACK_POWER, schoolMask)) / 100);
  }
  return benefit;
}

/** `Unit::SpellHealingBonusDone` */
export function spellHealingBonusDone(unit: SpellUnit, victim: SpellUnit, info: SpellInfo, heal: number, damageType: number, effIndex: number, totalMod = 0, stack = 1): number {
  if (info.spellFamilyName === SPELLFAMILY_POTION) return heal;
  const doneTotalMod = totalMod ? totalMod : spellPctHealingModsDone(unit, victim, info, damageType);
  let doneTotal = 0;
  const advertised = spellBaseHealingBonusDone(unit, info.schoolMask);
  let coeff = info.effects[effIndex]!.bonusMultiplier;
  const bonus = unit.world.spells.bonusData(info.id);
  const attType = isRangedWeaponSpell(info) && info.dmgClass !== SPELL_DAMAGE_CLASS_MELEE ? RANGED_ATTACK : BASE_ATTACK;
  if (bonus) {
    if (damageType === DOT) {
      coeff = bonus.dot;
      if (bonus.apDot > 0) doneTotal += Math.trunc(bonus.apDot * stack * unit.stats.getTotalAttackPowerValue(attType));
    } else {
      coeff = bonus.direct;
      if (bonus.ap > 0) doneTotal += Math.trunc(bonus.ap * stack * unit.stats.getTotalAttackPowerValue(attType));
    }
  } else if (info.dmgClass === SPELL_DAMAGE_CLASS_NONE) {
    return heal;
  }
  if (advertised) doneTotal += Math.trunc(advertised * coeff * f(calculateLevelPenalty(unit, info) * stack));
  for (const effect of info.effects) {
    if (effect.applyAuraName === SPELL_AURA_PERIODIC_LEECH || effect.applyAuraName === SPELL_AURA_PERIODIC_HEALTH_FUNNEL || effect.effect === SPELL_EFFECT_HEALTH_LEECH) doneTotal = 0;
  }
  return Math.trunc(Math.max(f((heal + doneTotal) * doneTotalMod), 0));
}

/** `Unit::SpellHealingBonusTaken` */
export function spellHealingBonusTaken(unit: SpellUnit, caster: SpellUnit | null, info: SpellInfo, heal: number, damageType: number, stack = 1): number {
  let takenMod = 1;
  const minval = unit.getMaxNegativeAuraModifier(SPELL_AURA_MOD_HEALING_PCT);
  if (minval) takenMod = addPct(takenMod, minval);
  const maxval = unit.getMaxPositiveAuraModifier(SPELL_AURA_MOD_HEALING_PCT);
  if (maxval) takenMod = addPct(takenMod, maxval);
  const tenacity = unit.getAuraEffect(58549, 0);
  if (tenacity) takenMod = addPct(takenMod, tenacity.amount);
  let takenTotal = 0;
  const advertised = unit.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_HEALING, info.schoolMask);
  if (damageType === DOT) {
    const minHot = unit.getMaxNegativeAuraModifier(SPELL_AURA_MOD_HOT_PCT);
    if (minHot) takenMod = addPct(takenMod, minHot);
    const maxHot = unit.getMaxPositiveAuraModifier(SPELL_AURA_MOD_HOT_PCT);
    if (maxHot) takenMod = addPct(takenMod, maxHot);
  }
  const bonus = unit.world.spells.bonusData(info.id);
  let coeff = 0;
  if (bonus) coeff = damageType === DOT ? bonus.dot : bonus.direct;
  else if (info.dmgClass === SPELL_DAMAGE_CLASS_NONE) return Math.trunc(Math.max(f(heal * takenMod), 0));
  if (advertised) {
    if (coeff <= 0) coeff = f(calculateDefaultCoefficient(unit, info, damageType) * stack * 1.88);
    const factorMod = f(calculateLevelPenalty(unit, info) * stack);
    takenTotal += Math.trunc(advertised * coeff * factorMod);
  }
  if (caster) takenMod = f(takenMod * unit.getTotalAuraMultiplier(SPELL_AURA_MOD_HEALING_RECEIVED, (aurEff) => caster.guid === aurEff.casterGuid && aurEff.isAffectedOnSpell(info)));
  for (const effect of info.effects) {
    if (effect.applyAuraName === SPELL_AURA_PERIODIC_LEECH || effect.applyAuraName === SPELL_AURA_PERIODIC_HEALTH_FUNNEL || effect.effect === SPELL_EFFECT_HEALTH_LEECH) takenTotal = 0;
  }
  if ((hasAttribute(info, 6, SPELL_ATTR6_IGNORE_HEALTH_MODIFIERS) || hasCustomAttribute(info, SPELL_ATTR0_CU_NO_POSITIVE_TAKEN_BONUS)) && takenMod > 1) {
    takenTotal = 0;
    takenMod = 1;
  }
  return Math.trunc(Math.max(f((heal + takenTotal) * takenMod), 0));
}

// ------------------------------------------------------------------ crits

/** `Unit::SpellDoneCritChance` */
export function spellDoneCritChance(unit: SpellUnit, info: SpellInfo, schoolMask: number, attType: number, skipEffectCheck: boolean): number {
  if (unit.isCreature && !unit.spellModOwnerIsPlayer()) return -100;
  if (hasAttribute(info, 2, SPELL_ATTR2_CANT_CRIT)) return 0;
  if (!skipEffectCheck && !isCritCapable(info)) return 0;
  let critChance = 0;
  switch (info.dmgClass) {
    case SPELL_DAMAGE_CLASS_MAGIC:
      if (schoolMask & SPELL_SCHOOL_MASK_NORMAL) critChance = 0;
      else if (unit.isPlayer) critChance = unit.stats.spellCritChance(firstSchool(schoolMask)) ?? 0;
      else critChance = (unit.stats.spellCritChance(firstSchool(schoolMask)) ?? 0) + unit.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_SPELL_CRIT_CHANCE_SCHOOL, schoolMask);
      break;
    case SPELL_DAMAGE_CLASS_MELEE:
    case SPELL_DAMAGE_CLASS_RANGED:
      if (unit.isPlayer) critChance = unit.stats.weaponCritChance(attType) ?? 0;
      else critChance = 5 + unit.getTotalAuraModifier(SPELL_AURA_MOD_WEAPON_CRIT_PERCENT) + unit.getTotalAuraModifier(SPELL_AURA_MOD_CRIT_PCT);
      critChance += unit.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_SPELL_CRIT_CHANCE_SCHOOL, schoolMask);
      break;
    default:
      return 0;
  }
  return critChance;
}

/** `Unit::GetSpellCritDamageReduction` (resilience from the owning player). */
export function spellCritDamageReduction(unit: SpellUnit, damage: number): number {
  const target = unit.isPlayer ? unit : unit.isPet() ? unit.charmerOrOwner() : null;
  if (!target || !target.isPlayer) return 0;
  return Math.trunc((damage * Math.min(target.stats.ratingBonus(CR_CRIT_TAKEN_SPELL) * 2.2, 33)) / 100);
}

/** `Unit::ApplyResilience` for the reductions this port has ratings for. */
export function applyResilience(victim: SpellUnit, crit: { value: number } | null, damage: { value: number } | null, isCrit: boolean, type: number): void {
  const target = victim.isPlayer ? victim : victim.isPet() ? victim.charmerOrOwner() : null;
  if (!target || !target.isPlayer) return;
  const rating = target.stats.ratingBonus(type);
  if (crit) crit.value -= rating;
  if (damage) {
    const pct = (rate: number, cap: number, value: number): number => Math.trunc((value * Math.min(rating * rate, cap)) / 100);
    if (isCrit) damage.value -= pct(2.2, 33, damage.value);
    damage.value -= pct(2, 100, damage.value);
  }
}

/** `Unit::SpellTakenCritChance` (the family and override-class-script branches belong to the class layer). */
export function spellTakenCritChance(unit: SpellUnit, caster: SpellUnit | null, info: SpellInfo, schoolMask: number, doneChance: number, attType: number, skipEffectCheck: boolean): number {
  if (hasAttribute(info, 2, SPELL_ATTR2_CANT_CRIT)) return 0;
  if (!skipEffectCheck && !isCritCapable(info)) return 0;
  const crit = { value: doneChance };
  switch (info.dmgClass) {
    case SPELL_DAMAGE_CLASS_MAGIC:
      if (!isPositive(info)) {
        crit.value += unit.getMaxNegativeAuraModifierByMiscMask(SPELL_AURA_MOD_ATTACKER_SPELL_CRIT_CHANCE, schoolMask);
        crit.value += unit.getMaxPositiveAuraModifierByMiscMask(SPELL_AURA_MOD_ATTACKER_SPELL_CRIT_CHANCE, schoolMask);
        applyResilience(unit, crit, null, false, CR_CRIT_TAKEN_SPELL);
      }
      break;
    case SPELL_DAMAGE_CLASS_MELEE:
    case SPELL_DAMAGE_CLASS_RANGED:
      if (info.dmgClass === SPELL_DAMAGE_CLASS_MELEE && unit.isPlayer && (unit.isSitState() || unit.standState === 3 /* UNIT_STAND_STATE_SLEEP */)) return 100;
      crit.value += unit.getTotalAuraModifier(attType === RANGED_ATTACK ? SPELL_AURA_MOD_ATTACKER_RANGED_CRIT_CHANCE : SPELL_AURA_MOD_ATTACKER_MELEE_CRIT_CHANCE);
      applyResilience(unit, crit, null, false, attType !== RANGED_ATTACK ? CR_CRIT_TAKEN_MELEE : CR_CRIT_TAKEN_RANGED);
      if (caster) crit.value += (caster.stats.maxSkillValueForLevel(unit) - unit.stats.defenseSkillValue(caster)) * 0.04;
      break;
    default:
      return 0;
  }
  if (caster) crit.value += unit.getTotalAuraModifier(SPELL_AURA_MOD_CRIT_CHANCE_FOR_CASTER, (aurEff) => caster.guid === aurEff.casterGuid);
  if (!isPositive(info)) crit.value += unit.getTotalAuraModifier(SPELL_AURA_MOD_ATTACKER_SPELL_AND_WEAPON_CRIT_CHANCE);
  return crit.value;
}

/** `Unit::SpellCriticalDamageBonus` */
export function spellCriticalDamageBonus(caster: SpellUnit | null, info: SpellInfo, damage: number, victim: SpellUnit | null): number {
  let critBonus = damage;
  if (info.dmgClass === SPELL_DAMAGE_CLASS_MELEE || info.dmgClass === SPELL_DAMAGE_CLASS_RANGED) critBonus += damage;
  else critBonus += Math.trunc(damage / 2);
  if (caster) {
    let critMod = caster.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_CRIT_DAMAGE_BONUS, info.schoolMask);
    if (victim) critMod += caster.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_CRIT_PERCENT_VERSUS, victim.creatureTypeMask());
    if (critBonus !== 0 && critMod !== 0) critBonus = Math.trunc(addPct(critBonus, critMod));
  }
  return critBonus;
}

/** `Unit::SpellCriticalHealingBonus` */
export function spellCriticalHealingBonus(caster: SpellUnit | null, info: SpellInfo, damage: number, victim: SpellUnit | null): number {
  let critBonus = info.dmgClass === SPELL_DAMAGE_CLASS_MELEE || info.dmgClass === SPELL_DAMAGE_CLASS_RANGED ? damage : Math.trunc(damage / 2);
  if (caster && victim) critBonus = Math.trunc(critBonus * caster.getTotalAuraMultiplierByMiscMask(SPELL_AURA_MOD_CRIT_PERCENT_VERSUS, victim.creatureTypeMask()));
  if (critBonus > 0) damage += critBonus;
  if (caster) damage = Math.trunc(damage * caster.getTotalAuraMultiplier(SPELL_AURA_MOD_CRITICAL_HEALING_AMOUNT));
  return damage;
}

/** `AuraEffect::CalcPeriodicCritChance` (Rupture's family branch is the rogue layer; periodic crits need `ABILITY_PERIODIC_CRIT`). */
export function calcPeriodicCritChance(caster: SpellUnit, effect: AuraEffect, target: SpellUnit | null): number {
  let critChance = 0;
  if (caster.spellModOwnerIsPlayer()) {
    for (const aurEff of caster.auraEffectsByType(SPELL_AURA_ABILITY_PERIODIC_CRIT)) {
      if (aurEff.isAffectedOnSpell(effect.spellInfo)) {
        critChance = spellDoneCritChance(caster, effect.spellInfo, effect.spellInfo.schoolMask, effect.spellInfo.dmgClass === SPELL_DAMAGE_CLASS_RANGED ? RANGED_ATTACK : BASE_ATTACK, true);
        break;
      }
    }
    if (effect.spellInfo.spellFamilyName === 8 /* ROGUE */ && effect.spellInfo.spellFamilyFlags[0] & 0x100000) critChance = spellDoneCritChance(caster, effect.spellInfo, effect.spellInfo.schoolMask, BASE_ATTACK, true);
  }
  if (target && critChance > 0) critChance = spellTakenCritChance(target, caster, effect.spellInfo, effect.spellInfo.schoolMask, critChance, BASE_ATTACK, true);
  return Math.max(0, critChance);
}

// ------------------------------------------------------------------ hit results

/** `Unit::GetMechanicResistChance` */
export function mechanicResistChance(unit: SpellUnit, info: SpellInfo): number {
  let resist = 0;
  for (let i = 0; i < 3; i++) {
    if (!info.effects[i]!.effect) break;
    const mechanic = effectMechanic(info, i);
    if (mechanic) resist = Math.max(resist, unit.getTotalAuraModifierByMiscValue(SPELL_AURA_MOD_MECHANIC_RESISTANCE, mechanic));
  }
  return resist;
}

/** `Unit::GetResistance(SpellSchoolMask)` — the lowest resistance among the schools. */
export function resistanceForMask(unit: SpellUnit, schoolMask: number): number {
  let resistance = -1;
  for (let school = 0; school < 7; school++) {
    if (!(schoolMask & (1 << school))) continue;
    const value = unit.stats.getResistance(school);
    if (resistance < 0 || value < resistance) resistance = value;
  }
  return resistance < 0 ? 0 : resistance;
}

/** `Unit::GetEffectiveResistChance` */
export function effectiveResistChance(owner: SpellUnit | null, schoolMask: number, victim: SpellUnit, info: SpellInfo | null, casterLevel = 0): number {
  let victimResistance = resistanceForMask(victim, schoolMask);
  if (owner) {
    victimResistance += owner.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_TARGET_RESISTANCE, schoolMask);
    if (owner.isPlayer) victimResistance -= owner.stats.spellPenetrationItemMod();
  }
  victimResistance = Math.max(victimResistance, 0);
  const effectiveCasterLevel = owner ? owner.level : casterLevel;
  if (effectiveCasterLevel && (!info || !hasCustomAttribute(info, SPELL_ATTR0_CU_BINARY_SPELL))) {
    victimResistance += Math.max((victim.level - effectiveCasterLevel) * 5, 0);
  }
  const level = effectiveCasterLevel ? effectiveCasterLevel : victim.level;
  let constant: number;
  if (level > 60) constant = 150 + (level - 60) * (level - 67.5);
  else if (level > 20) constant = 50 + (level - 20) * 2.5;
  else constant = 50;
  return Math.min(f(victimResistance / (victimResistance + constant)), 0.75);
}

/** `WorldObject::MagicSpellHitResult` */
export function magicSpellHitResult(caster: SpellUnit, victim: SpellUnit, info: SpellInfo): number {
  if (!victim.isAlive() && !victim.isPlayer) return SPELL_MISS_NONE;
  if (hasAttribute(info, 3, SPELL_ATTR3_ALWAYS_HIT) || hasAttribute(info, 7, SPELL_ATTR7_NO_ATTACK_MISS)) return SPELL_MISS_NONE;
  const schoolMask = info.schoolMask;
  let thisLevel = caster.levelForTarget(victim);
  if (caster.isCreature && caster.isTrigger()) thisLevel = Math.max(thisLevel, info.spellLevel);
  const levelDiff = victim.levelForTarget(caster) - thisLevel;
  const multiplier = victim.isPlayer ? MISS_CHANCE_MULTIPLIER_PLAYER : MISS_CHANCE_MULTIPLIER_CREATURE;
  let modHitChance = levelDiff < 3 ? 96 - levelDiff : 94 - (levelDiff - 2) * multiplier;
  modHitChance += caster.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_INCREASES_SPELL_PCT_TO_HIT, schoolMask);
  modHitChance += victim.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_ATTACKER_SPELL_HIT_CHANCE, schoolMask);
  if (isAffectingArea(info)) modHitChance -= victim.getTotalAuraModifier(SPELL_AURA_MOD_AOE_AVOIDANCE);
  if (victim.isPlayer) modHitChance -= Math.trunc(victim.stats.ratingBonus(CR_HIT_TAKEN_SPELL));
  let hitChance = modHitChance * 100;
  hitChance += Math.trunc(caster.stats.modSpellHitChance * 100);
  if (hitChance < 100) hitChance = 100;
  else if (hitChance > 10000) hitChance = 10000;
  let tmp = 10000 - hitChance;
  const rand = irand(1, 10000);
  if (rand < tmp) return SPELL_MISS_MISS;
  tmp += mechanicResistChance(victim, info) * 100;
  if (!isPositive(info) && !hasAttribute(info, 4, SPELL_ATTR4_NO_CAST_LOG)) {
    const negativeAura = !info.effects.some((effect) => effect.effect && effect.applyAuraName === 0);
    if (negativeAura) {
      tmp += victim.getMaxPositiveAuraModifierByMiscValue(SPELL_AURA_MOD_DEBUFF_RESISTANCE, info.dispel) * 100;
      tmp += victim.getMaxNegativeAuraModifierByMiscValue(SPELL_AURA_MOD_DEBUFF_RESISTANCE, info.dispel) * 100;
    }
    if (hasCustomAttribute(info, SPELL_ATTR0_CU_BINARY_SPELL) && (info.schoolMask & (SPELL_SCHOOL_MASK_NORMAL | SPELL_SCHOOL_MASK_HOLY)) === 0) {
      tmp += Math.trunc(effectiveResistChance(caster, info.schoolMask, victim, info) * 10000);
    }
  }
  if (rand < tmp) return SPELL_MISS_RESIST;
  if (!victim.hasUnitState(UNIT_STATE_STUNNED) && victim.hasInArc(Math.PI, caster)) {
    tmp += victim.getTotalAuraModifier(SPELL_AURA_DEFLECT_SPELLS) * 100;
    if (rand < tmp) return SPELL_MISS_DEFLECT;
  }
  return SPELL_MISS_NONE;
}

/** `Unit::MeleeSpellMissChance` */
function meleeSpellMissChance(caster: SpellUnit, victim: SpellUnit, attType: number, skillDiff: number, info: SpellInfo): number {
  if (hasAttribute(info, 7, SPELL_ATTR7_NO_ATTACK_MISS)) return 0;
  let missChance = unitMissChance(victim, attType);
  const diff = -skillDiff;
  if (victim.isPlayer) missChance += diff > 0 ? diff * 0.04 : diff * 0.02;
  else missChance += diff > 10 ? 1 + (diff - 10) * 0.4 : diff * 0.1;
  missChance -= attType === RANGED_ATTACK ? caster.stats.modRangedHitChance : caster.stats.modMeleeHitChance;
  if (missChance < 0) return 0;
  if (missChance > 60) return 60;
  return missChance;
}

/** `Unit::GetUnitMissChance` */
export function unitMissChance(unit: SpellUnit, attType: number): number {
  let missChance = 5;
  if (unit.isPlayer) missChance += unit.stats.missFromDefense();
  missChance -= unit.getTotalAuraModifier(attType === RANGED_ATTACK ? SPELL_AURA_MOD_ATTACKER_RANGED_HIT_CHANCE : SPELL_AURA_MOD_ATTACKER_MELEE_HIT_CHANCE);
  return missChance;
}

/** `Unit::GetUnitDodgeChance` */
export function unitDodgeChance(unit: SpellUnit): number {
  if (unit.isPlayer) return unit.stats.dodgeChance();
  if (unit.isTotem) return 0;
  const dodge = unit.stats.dodgeChance() + unit.getTotalAuraModifier(SPELL_AURA_MOD_DODGE_PERCENT);
  return dodge > 0 ? dodge : 0;
}

/** `Unit::GetUnitParryChance` */
export function unitParryChance(unit: SpellUnit): number {
  let chance = 0;
  if (unit.isPlayer) chance = unit.stats.parryChance();
  else {
    chance = unit.stats.parryChance();
    if (!chance && unit.creatureType === CREATURE_TYPE_HUMANOID) chance = 5;
    chance += unit.getTotalAuraModifier(SPELL_AURA_MOD_PARRY_PERCENT);
  }
  return chance > 0 ? chance : 0;
}

/** `Unit::GetUnitBlockChance` */
export function unitBlockChance(unit: SpellUnit): number {
  if (unit.isPlayer) return unit.stats.blockChance();
  if (unit.isTotem) return 0;
  const block = 5 + unit.getTotalAuraModifier(SPELL_AURA_MOD_BLOCK_PERCENT);
  return block > 0 ? block : 0;
}

/** `Unit::MeleeSpellHitResult` */
export function meleeSpellHitResult(caster: SpellUnit, victim: SpellUnit, info: SpellInfo): number {
  if (hasAttribute(info, 3, SPELL_ATTR3_ALWAYS_HIT)) return SPELL_MISS_NONE;
  const attType = info.dmgClass === SPELL_DAMAGE_CLASS_RANGED ? RANGED_ATTACK : BASE_ATTACK;
  const attackerWeaponSkill = info.dmgClass === SPELL_DAMAGE_CLASS_RANGED && !isRangedWeaponSpell(info) ? caster.level * 5 : caster.stats.weaponSkillValue(attType, victim);
  const skillDiff = attackerWeaponSkill - victim.stats.maxSkillValueForLevel(caster);
  const roll = urand(0, 10000);
  let tmp = Math.trunc(meleeSpellMissChance(caster, victim, attType, skillDiff, info) * 100);
  if (roll < tmp) return SPELL_MISS_MISS;
  let canDodge = !hasAttribute(info, 7, SPELL_ATTR7_NO_ATTACK_DODGE);
  let canParry = !hasAttribute(info, 7, SPELL_ATTR7_NO_ATTACK_PARRY);
  let canBlock = hasAttribute(info, 3, SPELL_ATTR3_COMPLETELY_BLOCKED) && !hasCustomAttribute(info, 0x00000100 /* SPELL_ATTR0_CU_DIRECT_DAMAGE */);
  if (hasAttribute(info, 0, SPELL_ATTR0_NO_ACTIVE_DEFENSE)) return SPELL_MISS_NONE;
  tmp += mechanicResistChance(victim, info) * 100;
  if (roll < tmp) return SPELL_MISS_RESIST;
  if (attType === RANGED_ATTACK) {
    if (!victim.hasUnitState(UNIT_STATE_STUNNED) && victim.hasInArc(Math.PI, caster)) {
      tmp += victim.getTotalAuraModifier(SPELL_AURA_DEFLECT_SPELLS) * 100;
      if (roll < tmp) return SPELL_MISS_DEFLECT;
    }
    canDodge = false;
    canParry = false;
  }
  if (!victim.hasInArc(Math.PI, caster)) {
    if (victim.isPlayer) canDodge = false;
    canParry = false;
    canBlock = false;
  }
  const flagsExtra = victim.creatureFlagsExtra();
  if (flagsExtra & CREATURE_FLAG_EXTRA_NO_DODGE) canDodge = false;
  if (flagsExtra & CREATURE_FLAG_EXTRA_NO_PARRY) canParry = false;
  if (flagsExtra & CREATURE_FLAG_EXTRA_NO_BLOCK) canBlock = false;
  for (const aurEff of caster.auraEffectsByType(SPELL_AURA_IGNORE_COMBAT_RESULT)) {
    if (!aurEff.isAffectedOnSpell(info)) continue;
    if (aurEff.miscValue === MELEE_HIT_DODGE) canDodge = false;
    else if (aurEff.miscValue === MELEE_HIT_BLOCK) canBlock = false;
    else if (aurEff.miscValue === MELEE_HIT_PARRY) canParry = false;
  }
  const busy = victim.isNonMeleeSpellCast(false, false, true) || victim.hasUnitState(UNIT_STATE_CONTROLLED);
  if (canDodge) {
    let dodgeChance = Math.trunc(unitDodgeChance(victim) * 100) - skillDiff * 4;
    dodgeChance += caster.getTotalAuraModifierByMiscValue(SPELL_AURA_MOD_COMBAT_RESULT_CHANCE, VICTIMSTATE_DODGE) * 100;
    dodgeChance = Math.trunc(dodgeChance * caster.getTotalAuraMultiplier(SPELL_AURA_MOD_ENEMY_DODGE));
    if (caster.isPlayer) dodgeChance -= Math.trunc(caster.stats.expertiseDodgeOrParryReduction(attType) * 100);
    else dodgeChance -= caster.getTotalAuraModifier(SPELL_AURA_MOD_EXPERTISE) * 25;
    if (dodgeChance < 0 || busy) dodgeChance = 0;
    tmp += dodgeChance;
    if (roll < tmp) return SPELL_MISS_DODGE;
  }
  if (canParry) {
    let parryChance = Math.trunc(unitParryChance(victim) * 100) - skillDiff * 4;
    if (caster.isPlayer) parryChance -= Math.trunc(caster.stats.expertiseDodgeOrParryReduction(attType) * 100);
    else parryChance -= caster.getTotalAuraModifier(SPELL_AURA_MOD_EXPERTISE) * 25;
    if (parryChance < 0 || busy) parryChance = 0;
    tmp += parryChance;
    if (roll < tmp) return SPELL_MISS_PARRY;
  }
  if (canBlock) {
    let blockChance = Math.trunc(unitBlockChance(victim) * 100) - skillDiff * 4;
    if (blockChance < 0 || busy) blockChance = 0;
    tmp += blockChance;
    if (roll < tmp) return SPELL_MISS_BLOCK;
  }
  return SPELL_MISS_NONE;
}

/** `WorldObject::SpellHitResult(victim, spell, canReflect)` */
export function spellHitResult(caster: SpellUnit, victim: SpellUnit, info: SpellInfo, canReflect: boolean, schoolMask = info.schoolMask): number {
  if (victim.isImmunedToSpell(info, caster, schoolMask)) return SPELL_MISS_IMMUNE;
  if ((isPositive(info) || hasEffect(info, SPELL_EFFECT_DISPEL)) && !caster.isHostileTo(victim)) return SPELL_MISS_NONE;
  if (caster === victim) return SPELL_MISS_NONE;
  if (victim.isCreature && victim.isEvading() && !hasAura(info, SPELL_AURA_CONTROL_VEHICLE) && !hasCustomAttribute(info, 0x00000800 /* CU_IGNORE_EVADE */) && !hasAttribute(info, 1, 0x00020000 /* SPELL_ATTR1_AURA_STAYS_AFTER_COMBAT */)) return SPELL_MISS_EVADE;
  if (canReflect) {
    let reflectChance = victim.getTotalAuraModifier(SPELL_AURA_REFLECT_SPELLS);
    reflectChance += victim.getTotalAuraModifierByMiscMask(SPELL_AURA_REFLECT_SPELLS_SCHOOL, info.schoolMask);
    if (reflectChance > 0 && rollChanceI(reflectChance)) return SPELL_MISS_REFLECT;
  }
  switch (info.dmgClass) {
    case SPELL_DAMAGE_CLASS_RANGED:
    case SPELL_DAMAGE_CLASS_MELEE:
      return meleeSpellHitResult(caster, victim, info);
    case SPELL_DAMAGE_CLASS_NONE:
      if (info.spellFamilyName) return SPELL_MISS_NONE;
      for (const effect of info.effects) {
        if (effect.effect && effect.effect !== SPELL_EFFECT_SCHOOL_DAMAGE && effect.applyAuraName !== SPELL_AURA_PERIODIC_DAMAGE) return SPELL_MISS_NONE;
      }
      return magicSpellHitResult(caster, victim, info);
    case SPELL_DAMAGE_CLASS_MAGIC:
      return magicSpellHitResult(caster, victim, info);
    default:
      return SPELL_MISS_NONE;
  }
}

// ------------------------------------------------------------------ mitigation

/** `Unit::IsDamageReducedByArmor` */
export function isDamageReducedByArmor(schoolMask: number, info: SpellInfo | null, effIndex = 3): boolean {
  if ((schoolMask & SPELL_SCHOOL_MASK_NORMAL) === 0) return false;
  if (info) {
    if (hasCustomAttribute(info, SPELL_ATTR0_CU_IGNORE_ARMOR)) return false;
    if (effIndex !== 3) {
      const effect = info.effects[effIndex]!;
      if ((effect.applyAuraName === SPELL_AURA_PERIODIC_DAMAGE || effect.effect === SPELL_EFFECT_SCHOOL_DAMAGE) && effectMechanicMask(info, effIndex) & (1n << BigInt(MECHANIC_BLEED))) return false;
    }
  }
  return true;
}

/** `Unit::CalcArmorReducedDamage` */
export function calcArmorReducedDamage(attacker: SpellUnit | null, victim: SpellUnit, damage: number, info: SpellInfo | null, attackerLevel = 0): number {
  let armor = f(victim.stats.getArmor());
  if (attacker) {
    armor += attacker.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_TARGET_RESISTANCE, SPELL_SCHOOL_MASK_NORMAL);
    for (const aurEff of attacker.auraEffectsByType(SPELL_AURA_MOD_ABILITY_IGNORE_TARGET_RESIST)) {
      if (aurEff.miscValue & SPELL_SCHOOL_MASK_NORMAL && aurEff.isAffectedOnSpell(info)) armor = Math.floor(addPct(armor, -aurEff.amount));
    }
    if (attacker.isPlayer) {
      const bonusPct = attacker.getTotalAuraModifier(280 /* SPELL_AURA_MOD_ARMOR_PENETRATION_PCT */, (aurEff) => {
        if (aurEff.spellInfo.equippedItemClass === -1) {
          if (!info || aurEff.isAffectedOnSpell(info) || aurEff.miscValue & info.schoolMask) return true;
          return !aurEff.miscValue && !aurEff.hasSpellClassMask();
        }
        return attacker.hasItemFitToSpellRequirements(aurEff.spellInfo);
      });
      const level = victim.level;
      let maxArmorPen = level < 60 ? 400 + 85 * level : 400 + 85 * level + 4.5 * 85 * (level - 59);
      maxArmorPen = Math.min((armor + maxArmorPen) / 3, armor);
      const armorPen = (maxArmorPen * (bonusPct + attacker.stats.ratingBonus(CR_ARMOR_PENETRATION))) / 100;
      armor -= Math.min(armorPen, maxArmorPen);
    }
  }
  if (armor < 0) armor = 0;
  let levelModifier = attacker ? attacker.level : attackerLevel;
  if (levelModifier > 59) levelModifier = levelModifier + 4.5 * (levelModifier - 59);
  let tmp = f((0.1 * armor) / (8.5 * levelModifier + 40));
  tmp = f(tmp / (1 + tmp));
  if (tmp < 0) tmp = 0;
  if (tmp > 0.75) tmp = 0.75;
  return Math.ceil(Math.max(damage * (1 - tmp), 0));
}

/** `Unit::CalcAbsorbResist` (split damage auras are outside the baseline). */
export function calcAbsorbResist(info: DamageInfo, casterLevel = 0): void {
  const { victim, attacker, schoolMask } = info;
  const spell = info.spell;
  if (!victim.isAlive() || !info.damage) return;
  if (!(schoolMask & SPELL_SCHOOL_MASK_NORMAL) && (!(schoolMask & SPELL_SCHOOL_MASK_HOLY) || victim.isCreature) && (!spell || (!hasCustomAttribute(spell, SPELL_ATTR0_CU_BINARY_SPELL) && !hasAttribute(spell, 4, SPELL_ATTR4_NO_CAST_LOG)))) {
    const averageResist = effectiveResistChance(attacker, schoolMask, victim, null, casterLevel);
    const probability: number[] = [];
    for (let i = 0; i < 11; i++) probability[i] = Math.max(0, f(0.5 - 2.5 * Math.abs(0.1 * i - averageResist)));
    if (averageResist <= 0.1) {
      probability[0] = f(1 - 7.5 * averageResist);
      probability[1] = f(5 * averageResist);
      probability[2] = f(2.5 * averageResist);
    }
    const r = randNorm();
    let i = 0;
    let sum = probability[0]!;
    while (r >= sum && i < 10) sum += probability[++i]!;
    let resisted = f(Math.trunc((info.damage * i) / 10));
    if (resisted) {
      if (attacker) {
        const mult = attacker.getTotalAuraMultiplier(SPELL_AURA_MOD_ABILITY_IGNORE_TARGET_RESIST, (aurEff) => (aurEff.miscValue & schoolMask) !== 0 && aurEff.isAffectedOnSpell(spell));
        resisted -= resisted * (mult - 1);
      }
      if (spell && hasCustomAttribute(spell, SPELL_ATTR0_CU_SCHOOLMASK_NORMAL_WITH_MAGIC)) {
        const armorReduction = info.damage - calcArmorReducedDamage(attacker, victim, info.damage, spell);
        if (armorReduction < resisted) resisted = armorReduction;
      }
    }
    const amount = Math.min(Math.trunc(resisted), info.damage);
    info.damage -= amount;
    info.resist += amount;
  }
  let auraAbsorbMod = 0;
  if (attacker) {
    auraAbsorbMod = attacker.getMaxPositiveAuraModifierByMiscMask(SPELL_AURA_MOD_TARGET_ABSORB_SCHOOL, schoolMask);
    auraAbsorbMod = Math.max(auraAbsorbMod, attacker.getMaxPositiveAuraModifier(SPELL_AURA_MOD_TARGET_ABILITY_ABSORB_SCHOOL, (aurEff) => (aurEff.miscValue & schoolMask) !== 0 && aurEff.isAffectedOnSpell(spell)));
    auraAbsorbMod = Math.min(100, Math.max(0, auraAbsorbMod));
  }
  // `Acore::AbsorbAuraOrderPred`: shields with the lowest remaining duration absorb first (spell-specific priorities are class data).
  const schoolAbsorbs = [...victim.auraEffectsByType(SPELL_AURA_SCHOOL_ABSORB)].sort((a, b) => absorbOrder(a) - absorbOrder(b));
  for (const aurEff of schoolAbsorbs) {
    if (info.damage <= 0) break;
    if (!aurEff.base.getApplicationOfTarget(victim.guid)) continue;
    if (!(aurEff.miscValue & schoolMask)) continue;
    let currentAbsorb = Math.max(aurEff.amount, 0);
    currentAbsorb = Math.min(Math.max(currentAbsorb, 0), info.damage);
    currentAbsorb = Math.trunc(addPct(currentAbsorb, -auraAbsorbMod));
    info.damage -= currentAbsorb;
    info.absorb += currentAbsorb;
    if (aurEff.amount >= 0) {
      aurEff.setAmount(aurEff.amount - currentAbsorb);
      if (aurEff.amount <= 0) aurEff.base.remove(AURA_REMOVE_BY_ENEMY_SPELL);
    }
  }
  for (const aurEff of [...victim.auraEffectsByType(SPELL_AURA_MANA_SHIELD)]) {
    if (info.damage <= 0) break;
    if (!aurEff.base.getApplicationOfTarget(victim.guid)) continue;
    if (!(aurEff.miscValue & schoolMask)) continue;
    let currentAbsorb = Math.min(Math.max(aurEff.amount, 0), info.damage);
    currentAbsorb = Math.trunc(addPct(currentAbsorb, -auraAbsorbMod));
    let manaReduction = currentAbsorb;
    const manaMultiplier = aurEff.valueMultiplier();
    if (manaMultiplier) manaReduction = Math.trunc(manaReduction * manaMultiplier);
    const manaTaken = -victim.modifyPower(POWER_MANA, -manaReduction);
    currentAbsorb = currentAbsorb && manaReduction ? Math.trunc(currentAbsorb * (manaTaken / manaReduction)) : 0;
    info.damage -= currentAbsorb;
    info.absorb += currentAbsorb;
    if (aurEff.amount >= 0) {
      aurEff.setAmount(aurEff.amount - currentAbsorb);
      if (aurEff.amount <= 0) aurEff.base.remove(AURA_REMOVE_BY_ENEMY_SPELL);
    }
  }
}

function absorbOrder(effect: AuraEffect): number {
  return effect.base.duration < 0 ? Number.MAX_SAFE_INTEGER : effect.base.duration;
}

/** `Unit::CalculateAOEDamageReduction` */
export function calculateAOEDamageReduction(unit: SpellUnit, damage: number, schoolMask: number, npcCaster: boolean): number {
  damage = Math.trunc(damage * unit.getTotalAuraMultiplierByMiscMask(SPELL_AURA_MOD_AOE_DAMAGE_AVOIDANCE, schoolMask));
  if (npcCaster) damage = Math.trunc(damage * unit.getTotalAuraMultiplierByMiscMask(SPELL_AURA_MOD_CREATURE_AOE_DAMAGE_AVOIDANCE, schoolMask));
  return damage;
}

/** `SpellNonMeleeDamage` */
export type SpellNonMeleeDamage = {
  attacker: SpellUnit;
  target: SpellUnit;
  spell: SpellInfo;
  schoolMask: number;
  damage: number;
  absorb: number;
  resist: number;
  blocked: number;
  hitInfo: number;
  cleanDamage: number;
  physicalLog: boolean;
};

/** `Unit::isSpellBlocked` */
function isSpellBlocked(caster: SpellUnit, victim: SpellUnit, info: SpellInfo, attType: number): boolean {
  if (hasAttribute(info, 0, SPELL_ATTR0_NO_ACTIVE_DEFENSE)) return false;
  if (hasAttribute(info, 3, SPELL_ATTR3_COMPLETELY_BLOCKED)) return false;
  if (victim.hasInArc(Math.PI, caster) || hasCustomAttribute(info, SPELL_ATTR0_CU_REQ_CASTER_BEHIND_TARGET)) {
    if (victim.creatureFlagsExtra() & CREATURE_FLAG_EXTRA_NO_BLOCK) return false;
    let blockChance = unitBlockChance(victim);
    blockChance += (caster.stats.weaponSkillValue(attType, victim) - victim.stats.maxSkillValueForLevel(caster)) * 0.04;
    return rollChanceF(blockChance);
  }
  return false;
}

/** `Unit::CalculateSpellDamageTaken` */
export function calculateSpellDamageTaken(attacker: SpellUnit, info: SpellNonMeleeDamage, damage: number, spell: SpellInfo, attType: number, crit: boolean): void {
  if (damage < 0) return;
  const victim = info.target;
  if (!victim.isAlive()) return;
  const schoolMask = info.schoolMask;
  let cleanDamage = 0;
  if (!hasAttribute(spell, 4, SPELL_ATTR4_IGNORE_DAMAGE_TAKEN_MODIFIERS) && isDamageReducedByArmor(schoolMask, spell)) {
    const old = damage;
    damage = calcArmorReducedDamage(attacker, victim, damage, spell);
    cleanDamage = old - damage;
  }
  switch (spell.dmgClass) {
    case SPELL_DAMAGE_CLASS_RANGED:
    case SPELL_DAMAGE_CLASS_MELEE: {
      const blocked = schoolMask & SPELL_SCHOOL_MASK_NORMAL ? isSpellBlocked(attacker, victim, spell, attType) : false;
      if (crit) {
        info.hitInfo |= SPELL_HIT_TYPE_CRIT;
        let critBonus = damage + damage;
        let critMod = victim.getTotalAuraModifier(attType === RANGED_ATTACK ? SPELL_AURA_MOD_ATTACKER_RANGED_CRIT_DAMAGE : SPELL_AURA_MOD_ATTACKER_MELEE_CRIT_DAMAGE);
        critMod += attacker.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_CRIT_DAMAGE_BONUS, spell.schoolMask);
        critMod += attacker.getTotalAuraModifierByMiscMask(SPELL_AURA_MOD_CRIT_PERCENT_VERSUS, victim.creatureTypeMask());
        if (critBonus !== 0 && critMod !== 0) critBonus = Math.trunc(addPct(critBonus, critMod));
        damage = critBonus;
      }
      if (blocked) {
        info.blocked = victim.stats.shieldBlockValue();
        if (damage < info.blocked) info.blocked = damage;
        damage -= info.blocked;
        cleanDamage += info.blocked;
      }
      const resilience = { value: damage };
      if (attacker.canApplyResilience()) applyResilience(victim, null, resilience, crit, attType !== RANGED_ATTACK ? CR_CRIT_TAKEN_MELEE : CR_CRIT_TAKEN_RANGED);
      cleanDamage += damage - resilience.value;
      damage = resilience.value;
      break;
    }
    case SPELL_DAMAGE_CLASS_NONE:
    case SPELL_DAMAGE_CLASS_MAGIC: {
      if (crit) {
        info.hitInfo |= SPELL_HIT_TYPE_CRIT;
        damage = spellCriticalDamageBonus(attacker, spell, damage, victim);
      }
      const resilience = { value: damage };
      if (attacker.canApplyResilience()) applyResilience(victim, null, resilience, crit, CR_CRIT_TAKEN_SPELL);
      cleanDamage += damage - resilience.value;
      damage = resilience.value;
      break;
    }
    default:
      break;
  }
  info.cleanDamage = Math.max(0, cleanDamage);
  info.damage = Math.max(0, damage);
  if (info.damage > 0) {
    const dmg: DamageInfo = { attacker, victim, damage: info.damage, absorb: 0, resist: 0, schoolMask: info.schoolMask, spell, damageType: SPELL_DIRECT_DAMAGE };
    calcAbsorbResist(dmg);
    info.absorb = dmg.absorb;
    info.resist = dmg.resist;
    info.damage = dmg.damage;
  }
}

/** `Unit::DealDamageMods` */
export function dealDamageMods(victim: SpellUnit, damage: { value: number }, absorb: { value: number } | null): void {
  if (!victim.isAlive() || victim.isInFlight() || (victim.isCreature && victim.isEvading())) {
    if (absorb) absorb.value += damage.value;
    damage.value = 0;
  }
}

/** `Unit::DealDamage` (share-damage, duels, sparring, durability, and damage shields are outside the baseline). */
export function dealDamage(attacker: SpellUnit | null, victim: SpellUnit, damage: number, cleanAbsorbed: number, damageType: number, schoolMask: number, spell: SpellInfo | null): number {
  if (damageType !== NODAMAGE) {
    if (spell) {
      if (!hasAttribute(spell, 4, SPELL_ATTR4_DAMAGE_DOESNT_BREAK_AURAS)) victim.removeAurasWithInterruptFlags(AURA_INTERRUPT_FLAG_TAKE_DAMAGE, spell.id);
    } else {
      victim.removeAurasWithInterruptFlags(AURA_INTERRUPT_FLAG_TAKE_DAMAGE, 0);
    }
    if (!damage && damageType !== DOT && cleanAbsorbed && victim !== attacker && victim.isPlayer) {
      const generic = victim.currentSpells[CURRENT_GENERIC_SPELL];
      if (generic && generic.state === SPELL_STATE_PREPARING && generic.info.interruptFlags & SPELL_INTERRUPT_FLAG_ABORT_ON_DMG) victim.interruptNonMeleeSpells(false);
    }
    void victim.auraEffectsByType(SPELL_AURA_SHARE_DAMAGE_PCT);
  }
  if (!damage) {
    if (cleanAbsorbed) {
      if (victim.hasActivePowerType(POWER_RAGE)) victim.rewardRage(cleanAbsorbed, 0, false);
      if (attacker?.hasActivePowerType(POWER_RAGE)) attacker.rewardRage(cleanAbsorbed, 0, true);
    }
    return 0;
  }
  const health = victim.health;
  if (health <= damage) {
    victim.receiveDamage(attacker, damage, spell, damageType);
    return damage;
  }
  victim.receiveDamage(attacker, damage, spell, damageType);
  if (damageType === DIRECT_DAMAGE || damageType === SPELL_DIRECT_DAMAGE) victim.removeAurasWithInterruptFlags(AURA_INTERRUPT_FLAG_DIRECT_DAMAGE, spell?.id ?? 0);
  if (attacker !== victim && victim.hasActivePowerType(POWER_RAGE)) victim.rewardRage(damage + cleanAbsorbed, 0, false);
  if (damageType !== NODAMAGE && damage && (!spell || !(hasAttribute(spell, 3, SPELL_ATTR3_TREAT_AS_PERIODIC) || hasAttribute(spell, 7, SPELL_ATTR7_DONT_CAUSE_SPELL_PUSHBACK)))) {
    if (victim !== attacker && victim.isPlayer && damageType !== DOT) {
      const generic = victim.currentSpells[CURRENT_GENERIC_SPELL];
      if (generic && generic.state === SPELL_STATE_PREPARING) {
        if (generic.info.interruptFlags & SPELL_INTERRUPT_FLAG_ABORT_ON_DMG) victim.interruptNonMeleeSpells(false);
        else if (generic.info.interruptFlags & SPELL_INTERRUPT_FLAG_PUSH_BACK) generic.delayed();
      }
      const channel = victim.currentSpells[CURRENT_CHANNELED_SPELL];
      if (channel && channel.state === SPELL_STATE_CASTING && channel.info.channelInterruptFlags & CHANNEL_FLAG_DELAY) channel.delayedChannel();
    }
  }
  return damage;
}

/** `Unit::DealSpellDamage` */
export function dealSpellDamage(info: SpellNonMeleeDamage): void {
  const victim = info.target;
  if (!victim.isAlive() || victim.isInFlight() || (victim.isCreature && victim.isEvading())) return;
  dealDamage(info.attacker, victim, info.damage, info.absorb, SPELL_DIRECT_DAMAGE, info.schoolMask, info.spell);
}

/** `Unit::SendSpellNonMeleeDamageLog` */
export function sendSpellNonMeleeDamageLog(info: SpellNonMeleeDamage): void {
  const body = spellDamageLogPacket({
    target: info.target.guid, caster: info.attacker.guid, spellId: info.spell.id, damage: info.damage,
    overkill: info.damage - info.target.health, schoolMask: info.schoolMask, absorb: info.absorb, resist: info.resist,
    physicalLog: info.physicalLog, blocked: info.blocked, hitInfo: info.hitInfo,
  });
  info.attacker.sendToSet(SMSG_SPELLNONMELEEDAMAGELOG, body, true);
  if (info.target !== info.attacker && info.target.isPlayer && !info.target.seesSetOf(info.attacker)) info.target.sendToSelf(SMSG_SPELLNONMELEEDAMAGELOG, body);
}

/** `WorldObject::SendSpellMiss` */
export function sendSpellMiss(caster: SpellUnit, target: SpellUnit, spellId: number, missInfo: number): void {
  caster.sendToSet(SMSG_SPELLLOGMISS, spellMissPacket(caster.guid, target.guid, spellId, missInfo), true);
}

/** `Unit::DealHeal` */
export function dealHeal(_healer: SpellUnit | null, victim: SpellUnit, heal: number): number {
  return heal ? victim.modifyHealth(heal) : 0;
}

/** `Unit::HealBySpell` + `SendHealSpellLog` (heal absorbs are outside the baseline). */
export function healBySpell(healer: SpellUnit, target: SpellUnit, info: SpellInfo, heal: number, critical: boolean): number {
  const gain = dealHeal(healer, target, heal);
  const body = new ByteWriter()
    .writeBytes(packedGuid(target.guid))
    .writeBytes(packedGuid(healer.guid))
    .writeU32(info.id)
    .writeU32(heal >>> 0)
    .writeU32((heal - gain) >>> 0)
    .writeU32(0)
    .writeU8(critical ? 1 : 0)
    .writeU8(0)
    .toUint8Array();
  healer.sendToSet(SMSG_SPELLHEALLOG, body, true);
  return gain;
}

/** `Unit::EnergizeBySpell` */
export function energizeBySpell(caster: SpellUnit, victim: SpellUnit, spellId: number, amount: number, powerType: number): void {
  victim.modifyPower(powerType, amount);
  if (powerType !== 4 /* POWER_HAPPINESS */) victim.forwardThreatForAssistingMe(caster, amount / 2);
  caster.sendToSet(SMSG_SPELLENERGIZELOG, energizeLogPacket(victim.guid, caster.guid, spellId, powerType, amount), true);
}

/** `Unit::SendPeriodicAuraLog` */
export function sendPeriodicAuraLog(target: SpellUnit, caster: bigint, spellId: number, log: PeriodicLog): void {
  target.sendToSet(SMSG_PERIODICAURALOG, periodicAuraLogPacket(target.guid, caster, spellId, log), true);
}

/** `WorldObject::ModSpellDuration` */
export function modSpellDuration(_caster: SpellUnit, info: SpellInfo, target: SpellUnit, duration: number, positive: boolean, effectMask: number): number {
  if (duration < 0) return duration;
  if (hasAttribute(info, 7, 0x2 /* SPELL_ATTR7_NO_TARGET_DURATION_MOD */)) return duration;
  if (!positive) {
    const mechanic = mechanicMaskByEffectMask(info, effectMask);
    let always = 0;
    let notStack = 0;
    for (let i = 1; i <= 31 /* MECHANIC_ENRAGED */; i++) {
      if (!(mechanic & (1n << BigInt(i)))) continue;
      if (i === 11 /* MECHANIC_SNARE */ && mechanic & (1n << 2n) /* MECHANIC_DISORIENTED */) continue;
      const nextAlways = target.getTotalAuraModifierByMiscValue(232 /* SPELL_AURA_MECHANIC_DURATION_MOD */, i);
      const nextNotStack = target.getMaxNegativeAuraModifierByMiscValue(234 /* SPELL_AURA_MECHANIC_DURATION_MOD_NOT_STACK */, i);
      if (nextAlways < always) always = nextAlways;
      if (nextNotStack < notStack) notStack = nextNotStack;
    }
    let durationMod = always > notStack ? notStack : always;
    if (durationMod !== 0) duration = Math.trunc(addPct(duration, durationMod));
    always = target.getTotalAuraModifierByMiscValue(245 /* SPELL_AURA_MOD_AURA_DURATION_BY_DISPEL */, info.dispel);
    notStack = target.getMaxNegativeAuraModifierByMiscValue(246 /* SPELL_AURA_MOD_AURA_DURATION_BY_DISPEL_NOT_STACK */, info.dispel);
    durationMod = always > notStack ? notStack : always;
    if (durationMod !== 0) duration = Math.trunc(addPct(duration, durationMod));
  }
  if (target === _caster) {
    const flags = info.spellFamilyFlags;
    if (info.spellFamilyName === 7 /* SPELLFAMILY_DRUID */ && flags[0]! & 0x100) {
      const glyph = target.getAuraEffect(57862, 0);
      if (glyph) duration += glyph.amount * 60 * 1000;
    } else if (info.spellFamilyName === 10 /* SPELLFAMILY_PALADIN */) {
      if (flags[0]! & 0x2 && info.spellIconId === 298) {
        const glyph = target.getAuraEffect(57958, 0);
        if (glyph) duration += glyph.amount * 60 * 1000;
      } else if (flags[0]! & 0x10000 && info.spellIconId === 306) {
        const glyph = target.getAuraEffect(57979, 0);
        if (glyph) duration += glyph.amount * 60 * 1000;
      }
    }
  }
  return Math.max(Math.trunc(duration), 0);
}

export { OFF_ATTACK, RANGED_ATTACK, BASE_ATTACK, STAT_STRENGTH };
