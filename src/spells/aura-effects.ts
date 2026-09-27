import { rollChanceF } from "../common/random.ts";
import type { AuraApplication, AuraEffect } from "./aura.ts";
import {
  SPELL_ATTR0_IS_ABILITY,
  SPELL_ATTR1_IMMUNITY_PURGES_EFFECT,
  SPELL_ATTR2_NO_TARGET_PER_SECOND_COST,
  SPELL_ATTR4_IGNORE_DAMAGE_TAKEN_MODIFIERS,
  SPELL_ATTR5_TREAT_AS_AREA_EFFECT,
  SPELL_ATTR7_ONLY_IN_SPELLBOOK_UNTIL_LEARNED,
  SPELL_ATTR7_TREAT_AS_NPC_AOE,
  SPELL_AURA_MOD_ATTACK_POWER_PCT,
  SPELL_AURA_MOD_BASE_RESISTANCE_PCT,
  SPELL_AURA_MOD_DAMAGE_PERCENT_DONE,
  SPELL_AURA_MOD_HEALING_DONE_PERCENT,
  SPELL_AURA_MOD_HEALING_PCT,
  SPELL_AURA_MOD_HOT_PCT,
  SPELL_AURA_MOD_INCREASE_ENERGY_PERCENT,
  SPELL_AURA_MOD_INCREASE_HEALTH_PERCENT,
  SPELL_AURA_MOD_PACIFY,
  SPELL_AURA_MOD_PACIFY_SILENCE,
  SPELL_AURA_MOD_PERCENT_STAT,
  SPELL_AURA_MOD_RANGED_ATTACK_POWER_PCT,
  SPELL_AURA_MOD_RESISTANCE,
  SPELL_AURA_MOD_RESISTANCE_EXCLUSIVE,
  SPELL_AURA_MOD_RESISTANCE_PCT,
  SPELL_AURA_MOD_SILENCE,
  SPELL_AURA_MOD_STAT,
  SPELL_AURA_MOD_TOTAL_STAT_PERCENTAGE,
  SPELL_AURA_OBS_MOD_HEALTH,
  SPELL_AURA_PERIODIC_DAMAGE,
  SPELL_AURA_PERIODIC_DAMAGE_PERCENT,
  SPELL_AURA_PERIODIC_DUMMY,
  SPELL_AURA_PERIODIC_ENERGIZE,
  SPELL_AURA_PERIODIC_HEAL,
  SPELL_AURA_PERIODIC_LEECH,
  SPELL_AURA_PERIODIC_MANA_LEECH,
  SPELL_AURA_PERIODIC_TRIGGER_SPELL,
  SPELL_AURA_PERIODIC_TRIGGER_SPELL_WITH_VALUE,
  SPELL_AURA_OBS_MOD_POWER,
  SPELL_AURA_POWER_BURN,
  SPELL_EFFECT_PERSISTENT_AREA_AURA,
} from "./defines.ts";
import {
  AURA_EFFECT_HANDLE_CHANGE_AMOUNT_MASK,
  AURA_EFFECT_HANDLE_REAL,
  AURA_EFFECT_HANDLE_SEND_FOR_CLIENT_MASK,
  AURA_EFFECT_HANDLE_STAT,
  AURA_INTERRUPT_FLAG_IMMUNE_OR_LOST_SELECTION,
  AURA_INTERRUPT_FLAG_TAKE_DAMAGE,
  BASE_PCT,
  BASE_VALUE,
  DOT,
  IMMUNITY_EFFECT,
  IMMUNITY_SCHOOL,
  IMMUNITY_STATE,
  MECHANIC_BANISH,
  MOVE_FLIGHT,
  MOVE_FLIGHT_BACK,
  MOVE_RUN,
  MOVE_RUN_BACK,
  MOVE_SWIM,
  MOVE_SWIM_BACK,
  MOVE_WALK,
  POWER_ALL,
  POWER_MANA,
  SELF_DAMAGE,
  SPELL_PREVENTION_TYPE_SILENCE,
  SPELL_SCHOOL_MASK_NORMAL,
  SPELL_SCHOOL_MASK_SPELL,
  STAT_STAMINA,
  TOTAL_PCT,
  TOTAL_VALUE,
  UNIT_FLAG_PACIFIED,
  UNIT_FLAG_SILENCED,
  UNIT_MOD_ATTACK_POWER,
  UNIT_MOD_ATTACK_POWER_RANGED,
  UNIT_MOD_HEALTH,
  UNIT_MOD_POWER_START,
  UNIT_MOD_RESISTANCE_START,
  UNIT_MOD_STAT_START,
  UNIT_MOD_DAMAGE_MAINHAND,
  UNIT_STATE_ISOLATED,
  UNIT_STATE_ROOT,
  UNIT_STATE_STUNNED,
} from "./enums.ts";
import { canDispelAura, effectIsTargetingArea, hasAttribute, isAreaAuraEffect, isChanneled, isPositive, needsExplicitUnitTarget, providedTargetMask, type SpellInfo } from "./spell-info.ts";
import { IMPLICIT_TARGETS } from "./target-data.ts";
import type { SpellUnit } from "./unit.ts";
import * as math from "./unit-math.ts";

export type AuraEffectHandler = (effect: AuraEffect, app: AuraApplication, mode: number, apply: boolean) => void;

const CHANGE_OR_STAT = AURA_EFFECT_HANDLE_CHANGE_AMOUNT_MASK | AURA_EFFECT_HANDLE_STAT;
const CLASSMASK_WAND_USERS = (1 << 4) | (1 << 7) | (1 << 8); // priest, mage, warlock
const PLAYER_FIELD_MOD_DAMAGE_DONE_POS = 0;
const PLAYER_FIELD_MOD_DAMAGE_DONE_NEG = 1;

/** `HandleNULL` / `HandleUnused` / `HandleNoImmediateEffect`: no immediate work. */
const handleNoImmediateEffect: AuraEffectHandler = () => {};

/** `AuraEffect::HandleAuraDummy`. The per-spell switch belongs to spell scripts; the dispatcher gates scripted spells. */
const handleAuraDummy: AuraEffectHandler = () => {};

/** `AuraEffect::HandleAuraModSilence` */
const handleAuraModSilence: AuraEffectHandler = (_effect, app, mode, apply) => {
  if (!(mode & AURA_EFFECT_HANDLE_REAL)) return;
  const target = app.target;
  if (apply) {
    target.setUnitFlag(UNIT_FLAG_SILENCED, true);
    for (let type = 0; type < 4; type++) {
      const spell = target.currentSpells[type];
      if (spell && spell.info.preventionType === SPELL_PREVENTION_TYPE_SILENCE) target.interruptSpell(type, false);
    }
  } else {
    if (target.hasAuraType(SPELL_AURA_MOD_SILENCE) || target.hasAuraType(SPELL_AURA_MOD_PACIFY_SILENCE)) return;
    target.setUnitFlag(UNIT_FLAG_SILENCED, false);
  }
};

/** `AuraEffect::HandleAuraModPacify` */
const handleAuraModPacify: AuraEffectHandler = (_effect, app, mode, apply) => {
  if (!(mode & AURA_EFFECT_HANDLE_SEND_FOR_CLIENT_MASK)) return;
  const target = app.target;
  if (apply) target.setUnitFlag(UNIT_FLAG_PACIFIED, true);
  else {
    if (target.hasAuraType(SPELL_AURA_MOD_PACIFY) || target.hasAuraType(SPELL_AURA_MOD_PACIFY_SILENCE)) return;
    target.setUnitFlag(UNIT_FLAG_PACIFIED, false);
  }
};

/** `AuraEffect::HandleAuraModPacifyAndSilence` */
const handleAuraModPacifyAndSilence: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & AURA_EFFECT_HANDLE_SEND_FOR_CLIENT_MASK)) return;
  if (!apply && app.target.hasAuraType(SPELL_AURA_MOD_PACIFY_SILENCE)) return;
  handleAuraModPacify(effect, app, mode, apply);
  handleAuraModSilence(effect, app, mode, apply);
};

/** `AuraEffect::HandleModThreat` — school threat modifiers are read in `ThreatCalcHelper`. */
const handleModThreat: AuraEffectHandler = () => {};

/** `AuraEffect::HandleModTaunt` */
const handleModTaunt: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & AURA_EFFECT_HANDLE_REAL)) return;
  const target = app.target;
  const caster = effect.getCaster();
  if (!target.isAlive() || !target.isCreature || !caster) return;
  target.taunt(caster, apply);
};

/** `AuraEffect::HandleAuraModStun` */
const handleAuraModStun: AuraEffectHandler = (_effect, app, mode, apply) => {
  if (!(mode & AURA_EFFECT_HANDLE_REAL)) return;
  app.target.setControlled(apply, UNIT_STATE_STUNNED);
};

/** `AuraEffect::HandleAuraModRoot` */
const handleAuraModRoot: AuraEffectHandler = (_effect, app, mode, apply) => {
  if (!(mode & AURA_EFFECT_HANDLE_REAL)) return;
  app.target.setControlled(apply, UNIT_STATE_ROOT);
};

/** `AuraEffect::HandleAuraModIncreaseSpeed` */
const handleAuraModIncreaseSpeed: AuraEffectHandler = (_effect, app, mode) => {
  if (!(mode & AURA_EFFECT_HANDLE_CHANGE_AMOUNT_MASK)) return;
  app.target.updateSpeed(MOVE_RUN);
};

/** `AuraEffect::HandleAuraModDecreaseSpeed` */
const handleAuraModDecreaseSpeed: AuraEffectHandler = (_effect, app, mode) => {
  if (!(mode & AURA_EFFECT_HANDLE_CHANGE_AMOUNT_MASK)) return;
  const target = app.target;
  for (const type of [MOVE_WALK, MOVE_RUN, MOVE_SWIM, MOVE_FLIGHT, MOVE_RUN_BACK, MOVE_SWIM_BACK, MOVE_FLIGHT_BACK]) target.updateSpeed(type);
};

/** `HandleModMechanicImmunity`, `HandleAuraModDmgImmunity`, `HandleAuraModDispelImmunity` → `ApplyAllSpellImmunitiesTo`. */
const handleApplyAllImmunities: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & AURA_EFFECT_HANDLE_REAL)) return;
  app.target.applyAllSpellImmunities(effect.spellInfo, effect.effIndex, apply);
};

/** `AuraEffect::HandleAuraModEffectImmunity` (battleground flag drops belong to the battleground layer). */
const handleAuraModEffectImmunity: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & AURA_EFFECT_HANDLE_REAL)) return;
  app.target.applySpellImmune(effect.id, IMMUNITY_EFFECT, effect.miscValue, apply);
};

/** `AuraEffect::HandleAuraModStateImmunity` */
const handleAuraModStateImmunity: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & AURA_EFFECT_HANDLE_REAL)) return;
  const target = app.target;
  target.applySpellImmune(effect.id, IMMUNITY_STATE, effect.miscValue, apply);
  if (apply && hasAttribute(effect.spellInfo, 1, SPELL_ATTR1_IMMUNITY_PURGES_EFFECT)) target.removeAurasByType(effect.miscValue, 0n, effect.base);
};

/** `AuraEffect::HandleAuraModSchoolImmunity` */
const handleAuraModSchoolImmunity: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & AURA_EFFECT_HANDLE_REAL)) return;
  const target = app.target;
  const info = effect.spellInfo;
  target.applySpellImmune(effect.id, IMMUNITY_SCHOOL, effect.miscValue, apply);
  if (info.mechanic === MECHANIC_BANISH) {
    if (apply) target.addUnitState(UNIT_STATE_ISOLATED);
    else if (!target.auraEffectsByType(effect.auraType).some((other) => other.spellInfo.mechanic === MECHANIC_BANISH)) target.clearUnitState(UNIT_STATE_ISOLATED);
  }
  if (apply && effect.miscValue === SPELL_SCHOOL_MASK_NORMAL) target.removeAurasWithInterruptFlags(AURA_INTERRUPT_FLAG_IMMUNE_OR_LOST_SELECTION);
  if (hasAttribute(info, 1, SPELL_ATTR1_IMMUNITY_PURGES_EFFECT) && hasAttribute(info, 2, 0x00000400 /* SPELL_ATTR2_FAIL_ON_ALL_TARGETS_IMMUNE */)) target.removeAurasWithInterruptFlags(AURA_INTERRUPT_FLAG_IMMUNE_OR_LOST_SELECTION);
  if (apply && hasAttribute(info, 1, SPELL_ATTR1_IMMUNITY_PURGES_EFFECT) && isPositive(info)) {
    const schoolMask = effect.miscValue;
    target.removeAppliedAuras((other) => {
      const spell = other.base.spellInfo;
      return (spell.schoolMask & schoolMask) !== 0 && canDispelAura(spell) && !other.isPositive() && spell.id !== effect.id;
    });
  }
};

/** `AuraEffect::HandleAuraModResistanceExclusive` */
const handleAuraModResistanceExclusive: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  for (let school = 0; school < 7; school++) {
    if (!(effect.miscValue & (1 << school))) continue;
    const amount = target.getMaxPositiveAuraModifierByMiscMask(SPELL_AURA_MOD_RESISTANCE_EXCLUSIVE, 1 << school, effect);
    if (amount < effect.amount) {
      target.stats.handleStatFlatModifier(UNIT_MOD_RESISTANCE_START + school, BASE_VALUE, effect.amount - amount, apply);
      if (target.isPlayer || target.isPet()) updateResistanceBuffModsMod(target, school);
    }
  }
};

/** `AuraEffect::HandleAuraModResistance` */
const handleAuraModResistance: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  for (let school = 0; school < 7; school++) {
    if (!(effect.miscValue & (1 << school))) continue;
    target.stats.handleStatFlatModifier(UNIT_MOD_RESISTANCE_START + school, TOTAL_VALUE, effect.amount, apply);
    if (target.isPlayer || target.isPet()) updateResistanceBuffModsMod(target, school);
  }
};

/** `AuraEffect::HandleAuraModBaseResistancePCT` */
const handleAuraModBaseResistancePct: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  for (let school = 0; school < 7; school++) {
    if (!(effect.miscValue & (1 << school))) continue;
    if (apply) target.stats.applyStatPctModifier(UNIT_MOD_RESISTANCE_START + school, BASE_PCT, effect.amount);
    else target.stats.setStatPctModifier(UNIT_MOD_RESISTANCE_START + school, BASE_PCT, target.getTotalAuraMultiplierByMiscMask(SPELL_AURA_MOD_BASE_RESISTANCE_PCT, 1 << school));
  }
};

/** `AuraEffect::HandleModResistancePercent` */
const handleModResistancePercent: AuraEffectHandler = (effect, app, mode) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  for (let school = 0; school < 7; school++) {
    if (!(effect.miscValue & (1 << school))) continue;
    const amount = target.getTotalAuraMultiplierByMiscMask(SPELL_AURA_MOD_RESISTANCE_PCT, 1 << school);
    if (target.stats.getPctModifierValue(UNIT_MOD_RESISTANCE_START + school, TOTAL_PCT) === amount) continue;
    target.stats.setStatPctModifier(UNIT_MOD_RESISTANCE_START + school, TOTAL_PCT, amount);
    if (target.isPlayer || target.isPet()) updateResistanceBuffModsMod(target, school);
  }
};

/** `AuraEffect::HandleModBaseResistance` */
const handleModBaseResistance: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  for (let school = 0; school < 7; school++) {
    if (effect.miscValue & (1 << school)) app.target.stats.handleStatFlatModifier(UNIT_MOD_RESISTANCE_START + school, TOTAL_VALUE, effect.amount, apply);
  }
};

/** `AuraEffect::HandleModTargetResistance` */
const handleModTargetResistance: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  if (target.isPlayer && effect.miscValue & SPELL_SCHOOL_MASK_NORMAL) target.stats.applyTargetResistanceField(true, effect.amount, apply);
  if (target.isPlayer && (effect.miscValue & SPELL_SCHOOL_MASK_SPELL) === SPELL_SCHOOL_MASK_SPELL) target.stats.applyTargetResistanceField(false, effect.amount, apply);
};

/** `Unit::UpdateResistanceBuffModsMod` */
function updateResistanceBuffModsMod(unit: SpellUnit, school: number): void {
  let positive = unit.getMaxPositiveAuraModifierByMiscMask(SPELL_AURA_MOD_RESISTANCE_EXCLUSIVE, 1 << school);
  positive += unit.getTotalAuraModifier(SPELL_AURA_MOD_RESISTANCE, (aurEff) => (aurEff.miscValue & (1 << school)) !== 0 && aurEff.amount > 0);
  let negative = unit.getTotalAuraModifier(SPELL_AURA_MOD_RESISTANCE, (aurEff) => (aurEff.miscValue & (1 << school)) !== 0 && aurEff.amount < 0);
  const factor = unit.getTotalAuraMultiplierByMiscMask(SPELL_AURA_MOD_RESISTANCE_PCT, 1 << school);
  positive = Math.fround(positive * factor);
  negative = Math.fround(negative * factor);
  unit.stats.updateResistanceBuffModsMod(school, positive, negative);
}

/** `Unit::UpdateStatBuffMod` */
export function updateStatBuffMod(unit: SpellUnit, stat: number): void {
  const mods = statBuffMods(unit, stat);
  unit.stats.updateStatBuffMod(stat, mods.pos, mods.neg);
}

/** The totals `Unit::UpdateStatBuffMod` computes (`m_floatStatPosBuff` / `m_floatStatNegBuff`). */
export function statBuffMods(unit: SpellUnit, stat: number): { pos: number; neg: number } {
  let positive = 0;
  let negative = 0;
  const modValue = unit.stats.getFlatModifierValue(UNIT_MOD_STAT_START + stat, BASE_VALUE);
  if (modValue > 0) positive += modValue;
  else negative += modValue;
  positive += unit.getTotalAuraModifier(SPELL_AURA_MOD_STAT, (aurEff) => (aurEff.miscValue < 0 || aurEff.miscValue === stat) && aurEff.amount > 0);
  negative += unit.getTotalAuraModifier(SPELL_AURA_MOD_STAT, (aurEff) => (aurEff.miscValue < 0 || aurEff.miscValue === stat) && aurEff.amount < 0);
  let factor = unit.getTotalAuraMultiplier(SPELL_AURA_MOD_PERCENT_STAT, (aurEff) => aurEff.miscValue === -1 || aurEff.miscValue === stat);
  factor = Math.fround(factor * unit.getTotalAuraMultiplier(SPELL_AURA_MOD_TOTAL_STAT_PERCENTAGE, (aurEff) => aurEff.miscValue === -1 || aurEff.miscValue === stat));
  positive = Math.fround(positive * factor);
  negative = Math.fround(negative * factor);
  return { pos: positive, neg: negative };
}

/** `AuraEffect::HandleAuraModStat` */
const handleAuraModStat: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  if (effect.miscValue < -2 || effect.miscValue > 4) return;
  const target = app.target;
  const spellGroupValue = target.getHighestExclusiveSameEffectSpellGroupValue(effect, SPELL_AURA_MOD_STAT, true, effect.miscValue);
  if (Math.abs(spellGroupValue) >= Math.abs(effect.amount)) return;
  for (let stat = 0; stat < 5; stat++) {
    if (effect.miscValue < 0 || effect.miscValue === stat) {
      if (spellGroupValue) target.stats.handleStatFlatModifier(UNIT_MOD_STAT_START + stat, TOTAL_VALUE, spellGroupValue, !apply);
      target.stats.handleStatFlatModifier(UNIT_MOD_STAT_START + stat, TOTAL_VALUE, effect.amount, apply);
      if (target.isPlayer || target.isPet()) updateStatBuffMod(target, stat);
    }
  }
};

/** `AuraEffect::HandleModPercentStat` */
const handleModPercentStat: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  if (effect.miscValue < -1 || effect.miscValue > 4) return;
  if (!target.isPlayer) return;
  for (let stat = 0; stat < 5; stat++) {
    if (effect.miscValue !== stat && effect.miscValue !== -1) continue;
    if (apply) target.stats.applyStatPctModifier(UNIT_MOD_STAT_START + stat, BASE_PCT, effect.amount);
    else target.stats.setStatPctModifier(UNIT_MOD_STAT_START + stat, BASE_PCT, target.getTotalAuraMultiplier(SPELL_AURA_MOD_PERCENT_STAT, (aurEff) => aurEff.miscValue === stat || aurEff.miscValue === -1));
  }
};

/** `AuraEffect::HandleModHealingDone` */
const handleModHealingDone: AuraEffectHandler = (_effect, app, mode) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  if (app.target.isPlayer) app.target.stats.updateSpellDamageAndHealingBonus();
};

/** `AuraEffect::HandleModTotalPercentStat` */
const handleModTotalPercentStat: AuraEffectHandler = (effect, app, mode) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  if (effect.miscValue < -1 || effect.miscValue > 4) return;
  const healthPct = target.healthPct();
  const alive = target.isAlive();
  for (let stat = 0; stat < 5; stat++) {
    if (effect.miscValue !== stat && effect.miscValue !== -1) continue;
    const amount = target.getTotalAuraMultiplier(SPELL_AURA_MOD_TOTAL_STAT_PERCENTAGE, (aurEff) => aurEff.miscValue === stat || aurEff.miscValue === -1);
    if (target.stats.getPctModifierValue(UNIT_MOD_STAT_START + stat, TOTAL_PCT) === amount) continue;
    target.stats.setStatPctModifier(UNIT_MOD_STAT_START + stat, TOTAL_PCT, amount);
    if (target.isPlayer || target.isPet()) updateStatBuffMod(target, stat);
  }
  if (effect.miscValue === STAT_STAMINA && hasAttribute(effect.spellInfo, 0, SPELL_ATTR0_IS_ABILITY)) target.setHealth(Math.max(Math.trunc((healthPct * target.maxHealth) / 100), alive ? 1 : 0));
};

/** `AuraEffect::HandleAuraModIncreaseHealth` */
const handleAuraModIncreaseHealth: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  if (apply) {
    target.stats.handleStatFlatModifier(UNIT_MOD_HEALTH, TOTAL_VALUE, effect.amount, apply);
    target.modifyHealth(effect.amount);
  } else {
    if (target.health > effect.amount) target.modifyHealth(-effect.amount);
    else target.setHealth(1);
    target.stats.handleStatFlatModifier(UNIT_MOD_HEALTH, TOTAL_VALUE, effect.amount, apply);
  }
};

/** `AuraEffect::HandleAuraModIncreaseEnergy` */
const handleAuraModIncreaseEnergy: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  app.target.stats.handleStatFlatModifier(UNIT_MOD_POWER_START + effect.miscValue, TOTAL_VALUE, effect.amount, apply);
};

/** `AuraEffect::HandleAuraModIncreaseEnergyPercent` */
const handleAuraModIncreaseEnergyPercent: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  const unitMod = UNIT_MOD_POWER_START + effect.miscValue;
  if (apply) target.stats.applyStatPctModifier(unitMod, TOTAL_PCT, effect.amount);
  else target.stats.setStatPctModifier(unitMod, TOTAL_PCT, target.getTotalAuraMultiplierByMiscValue(SPELL_AURA_MOD_INCREASE_ENERGY_PERCENT, effect.miscValue));
};

/** `AuraEffect::HandleAuraModIncreaseHealthPercent` */
const handleAuraModIncreaseHealthPercent: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  const percent = target.healthPct();
  if (apply) target.stats.applyStatPctModifier(UNIT_MOD_HEALTH, TOTAL_PCT, effect.amount);
  else target.stats.setStatPctModifier(UNIT_MOD_HEALTH, TOTAL_PCT, target.getTotalAuraMultiplier(SPELL_AURA_MOD_INCREASE_HEALTH_PERCENT));
  if (target.isAlive()) {
    const healthAmount = Math.trunc((target.maxHealth * percent) / 100);
    if (healthAmount) target.setHealth(healthAmount);
  }
};

/** `AuraEffect::HandleAuraModAttackPower` */
const handleAuraModAttackPower: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  app.target.stats.handleStatFlatModifier(UNIT_MOD_ATTACK_POWER, TOTAL_VALUE, effect.amount, apply);
};

/** `AuraEffect::HandleAuraModRangedAttackPower` */
const handleAuraModRangedAttackPower: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  if ((1 << (target.classId - 1)) & CLASSMASK_WAND_USERS) return;
  target.stats.handleStatFlatModifier(UNIT_MOD_ATTACK_POWER_RANGED, TOTAL_VALUE, effect.amount, apply);
};

/** `AuraEffect::HandleAuraModAttackPowerPercent` */
const handleAuraModAttackPowerPercent: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  if (apply) target.stats.applyStatPctModifier(UNIT_MOD_ATTACK_POWER, TOTAL_PCT, effect.amount);
  else target.stats.setStatPctModifier(UNIT_MOD_ATTACK_POWER, TOTAL_PCT, target.getTotalAuraMultiplier(SPELL_AURA_MOD_ATTACK_POWER_PCT));
};

/** `AuraEffect::HandleAuraModRangedAttackPowerPercent` */
const handleAuraModRangedAttackPowerPercent: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  if ((1 << (target.classId - 1)) & CLASSMASK_WAND_USERS) return;
  if (apply) target.stats.applyStatPctModifier(UNIT_MOD_ATTACK_POWER_RANGED, TOTAL_PCT, effect.amount);
  else target.stats.setStatPctModifier(UNIT_MOD_ATTACK_POWER_RANGED, TOTAL_PCT, target.getTotalAuraMultiplier(SPELL_AURA_MOD_RANGED_ATTACK_POWER_PCT));
};

/** `Unit::UpdateDamageDoneMods` for every attack type. */
function updateAllDamageDoneMods(unit: SpellUnit): void {
  for (let attType = 0; attType < 3; attType++) {
    const amount = unit.getTotalAuraModifier(13 /* SPELL_AURA_MOD_DAMAGE_DONE */, (aurEff) => (aurEff.miscValue & SPELL_SCHOOL_MASK_NORMAL) !== 0 && unit.checkAttackFitToAuraRequirement(attType, aurEff));
    unit.stats.setStatFlatModifier(UNIT_MOD_DAMAGE_MAINHAND + attType, TOTAL_VALUE, amount);
  }
}

/** `Unit::UpdateDamagePctDoneMods` for every attack type (`MOD_OFFHAND_DAMAGE_PCT` is outside the baseline). */
function updateAllDamagePctDoneMods(unit: SpellUnit): void {
  for (let attType = 0; attType < 3; attType++) {
    let factor = attType === 1 ? 0.5 : 1;
    factor = Math.fround(factor * unit.getTotalAuraMultiplier(SPELL_AURA_MOD_DAMAGE_PERCENT_DONE, (aurEff) => (aurEff.miscValue & SPELL_SCHOOL_MASK_NORMAL) !== 0 && unit.checkAttackFitToAuraRequirement(attType, aurEff)));
    unit.stats.setStatPctModifier(UNIT_MOD_DAMAGE_MAINHAND + attType, TOTAL_PCT, factor);
  }
}

/** `AuraEffect::HandleModDamageDone` */
const handleModDamageDone: AuraEffectHandler = (effect, app, mode, apply) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  if (effect.miscValue & SPELL_SCHOOL_MASK_NORMAL) updateAllDamageDoneMods(target);
  if (target.isPlayer) {
    const base = effect.amount >= 0 ? PLAYER_FIELD_MOD_DAMAGE_DONE_POS : PLAYER_FIELD_MOD_DAMAGE_DONE_NEG;
    for (let school = 0; school < 7; school++) {
      if (effect.miscValue & (1 << school)) target.stats.applyModDamageDoneField(base, school, effect.amount, apply);
    }
  }
};

/** `AuraEffect::HandleModDamagePercentDone` */
const handleModDamagePercentDone: AuraEffectHandler = (effect, app, mode) => {
  if (!(mode & CHANGE_OR_STAT)) return;
  const target = app.target;
  if (effect.miscValue & SPELL_SCHOOL_MASK_NORMAL) updateAllDamagePctDoneMods(target);
  if (target.isPlayer) {
    for (let school = 0; school < 7; school++) {
      if (effect.miscValue & (1 << school)) target.stats.setModDamageDonePctField(school, target.getTotalAuraMultiplierByMiscMask(SPELL_AURA_MOD_DAMAGE_PERCENT_DONE, 1 << school));
    }
  }
};

/** Aura types whose handlers (or the code that reads them) are ported, indexed by `AuraType`. */
export const AURA_EFFECT_HANDLERS: (AuraEffectHandler | undefined)[] = [];

const ported: [number, AuraEffectHandler][] = [
  [3, handleNoImmediateEffect], // PERIODIC_DAMAGE
  [4, handleAuraDummy],
  [8, handleNoImmediateEffect], // PERIODIC_HEAL
  [10, handleModThreat],
  [11, handleModTaunt],
  [12, handleAuraModStun],
  [13, handleModDamageDone],
  [14, handleNoImmediateEffect], // MOD_DAMAGE_TAKEN
  [20, handleNoImmediateEffect], // OBS_MOD_HEALTH
  [21, handleNoImmediateEffect], // OBS_MOD_POWER
  [22, handleAuraModResistance],
  [23, handleNoImmediateEffect], // PERIODIC_TRIGGER_SPELL
  [24, handleNoImmediateEffect], // PERIODIC_ENERGIZE
  [25, handleAuraModPacify],
  [26, handleAuraModRoot],
  [27, handleAuraModSilence],
  [29, handleAuraModStat],
  [31, handleAuraModIncreaseSpeed],
  [33, handleAuraModDecreaseSpeed],
  [34, handleAuraModIncreaseHealth],
  [35, handleAuraModIncreaseEnergy],
  [39, handleAuraModSchoolImmunity],
  [40, handleApplyAllImmunities], // DAMAGE_IMMUNITY
  [41, handleApplyAllImmunities], // DISPEL_IMMUNITY
  [50, handleNoImmediateEffect], // MOD_CRITICAL_HEALING_AMOUNT
  [53, handleNoImmediateEffect], // PERIODIC_LEECH
  [60, handleAuraModPacifyAndSilence],
  [64, handleNoImmediateEffect], // PERIODIC_MANA_LEECH
  [69, handleNoImmediateEffect], // SCHOOL_ABSORB
  [77, handleApplyAllImmunities], // MECHANIC_IMMUNITY
  [79, handleModDamagePercentDone],
  [80, handleModPercentStat],
  [83, handleModBaseResistance],
  [87, handleNoImmediateEffect], // MOD_DAMAGE_PERCENT_TAKEN
  [89, handleNoImmediateEffect], // PERIODIC_DAMAGE_PERCENT
  [97, handleNoImmediateEffect], // MANA_SHIELD
  [99, handleAuraModAttackPower],
  [101, handleModResistancePercent],
  [115, handleNoImmediateEffect], // MOD_HEALING
  [117, handleNoImmediateEffect], // MOD_MECHANIC_RESISTANCE
  [118, handleNoImmediateEffect], // MOD_HEALING_PCT
  [123, handleModTargetResistance],
  [124, handleAuraModRangedAttackPower],
  [129, handleAuraModIncreaseSpeed],
  [133, handleAuraModIncreaseHealthPercent],
  [135, handleModHealingDone],
  [136, handleNoImmediateEffect], // MOD_HEALING_DONE_PERCENT
  [137, handleModTotalPercentStat],
  [142, handleAuraModBaseResistancePct],
  [143, handleAuraModResistanceExclusive],
  [162, handleNoImmediateEffect], // POWER_BURN
  [163, handleNoImmediateEffect], // MOD_CRIT_DAMAGE_BONUS
  [166, handleAuraModAttackPowerPercent],
  [167, handleAuraModRangedAttackPowerPercent],
  [171, handleAuraModIncreaseSpeed],
  [179, handleNoImmediateEffect], // MOD_ATTACKER_SPELL_CRIT_CHANCE
  [186, handleNoImmediateEffect], // MOD_ATTACKER_SPELL_HIT_CHANCE
  [199, handleNoImmediateEffect], // MOD_INCREASES_SPELL_PCT_TO_HIT
  [226, handleNoImmediateEffect], // PERIODIC_DUMMY
  [227, handleNoImmediateEffect], // PERIODIC_TRIGGER_SPELL_WITH_VALUE
  [250, handleAuraModIncreaseHealth],
  [259, handleNoImmediateEffect], // MOD_HOT_PCT
  [271, handleNoImmediateEffect], // MOD_DAMAGE_FROM_CASTER
  [283, handleNoImmediateEffect], // MOD_HEALING_RECEIVED
];
for (const [type, handler] of ported) AURA_EFFECT_HANDLERS[type] = handler;

/** `HandleNULL` / `HandleUnused` entries: AzerothCore has no handler to port. */
export const REFERENCE_NOOP_AURAS: ReadonlySet<number> = new Set([
  46, 63, 70, 90, 100, 119, 157, 164, 173, 181, 183, 198, 205, 214, 217, 222, 224, 233, 242, 257, 258, 264, 265, 266, 273, 276, 295, 297, 298, 299, 302, 306, 307, 309, 311, 312, 313,
]);
for (const type of REFERENCE_NOOP_AURAS) AURA_EFFECT_HANDLERS[type] = handleNoImmediateEffect;

/** True when the aura type's AzerothCore behavior is ported (or AzerothCore itself has none). */
export function isAuraTypeSupported(type: number): boolean {
  return type === 0 || AURA_EFFECT_HANDLERS[type] !== undefined;
}

// ------------------------------------------------------------------ periodic

/** `AuraEffect::UpdatePeriodic` (drink and the other per-spell cases belong to spell scripts). */
export function updatePeriodic(_effect: AuraEffect, _caster: SpellUnit | null): void {}

/** `SpellInfo::NeedsToBeTriggeredByCaster` */
function needsToBeTriggeredByCaster(info: SpellInfo, triggering: SpellInfo, effIndex: number): boolean {
  if (needsExplicitUnitTarget(info)) return true;
  const entry = (target: number): boolean => IMPLICIT_TARGETS[target]?.checkType === 1 /* TARGET_CHECK_ENTRY */;
  const triggeringEffect = triggering.effects[effIndex]!;
  if (entry(triggeringEffect.targetA) || entry(triggeringEffect.targetB)) {
    if (info.id === 60563) return true;
    if (info.effects.some((effect) => effect.effect && (entry(effect.targetA) || entry(effect.targetB)))) return true;
  }
  if (isChanneled(triggering)) {
    let mask = 0;
    for (const effect of info.effects) {
      if (effect.targetA !== 1 /* TARGET_UNIT_CASTER */ && effect.targetA !== 18 /* TARGET_DEST_CASTER */) mask |= providedTargetMask(effect);
    }
    if (mask & 0x0011058e /* TARGET_FLAG_UNIT_MASK */) return true;
  }
  return false;
}

/** `AuraEffect::PeriodicTick` */
export function periodicTick(effect: AuraEffect, app: AuraApplication, caster: SpellUnit | null): void {
  const target = app.target;
  switch (effect.auraType) {
    case SPELL_AURA_PERIODIC_DUMMY:
      break;
    case SPELL_AURA_PERIODIC_TRIGGER_SPELL:
      periodicTriggerSpellTick(effect, target, caster, false);
      break;
    case SPELL_AURA_PERIODIC_TRIGGER_SPELL_WITH_VALUE:
      periodicTriggerSpellTick(effect, target, caster, true);
      break;
    case SPELL_AURA_PERIODIC_DAMAGE:
    case SPELL_AURA_PERIODIC_DAMAGE_PERCENT:
      periodicDamageTick(effect, target, caster);
      break;
    case SPELL_AURA_PERIODIC_LEECH:
      periodicHealthLeechTick(effect, target, caster);
      break;
    case SPELL_AURA_PERIODIC_HEAL:
    case SPELL_AURA_OBS_MOD_HEALTH:
      periodicHealTick(effect, target, caster);
      break;
    case SPELL_AURA_PERIODIC_MANA_LEECH:
      periodicManaLeechTick(effect, target, caster);
      break;
    case SPELL_AURA_OBS_MOD_POWER:
      obsModPowerTick(effect, target, caster);
      break;
    case SPELL_AURA_PERIODIC_ENERGIZE:
      periodicEnergizeTick(effect, target, caster);
      break;
    case SPELL_AURA_POWER_BURN:
      periodicPowerBurnTick(effect, target, caster);
      break;
    default:
      break;
  }
}

/** `HandlePeriodicTriggerSpellAuraTick` / `HandlePeriodicTriggerSpellWithValueAuraTick` (the per-spell trigger remaps are spell scripts). */
function periodicTriggerSpellTick(effect: AuraEffect, target: SpellUnit, caster: SpellUnit | null, withValue: boolean): void {
  const info = effect.spellInfo;
  const triggered = target.world.spells.get(info.effects[effect.effIndex]!.triggerSpell);
  if (!triggered) return;
  const triggerCaster = needsToBeTriggeredByCaster(triggered, info, effect.effIndex) ? caster : target;
  if (!triggerCaster) return;
  const entryTarget = [info.effects[effect.effIndex]!.targetA, info.effects[effect.effIndex]!.targetB].some((t) => IMPLICIT_TARGETS[t]?.checkType === 1);
  triggerCaster.castSpellInfo(target, triggered, {
    triggered: true,
    triggerFlags: withValue || !entryTarget ? 0x0007ffff : 0x0007ffff & ~0x4,
    basePoints: withValue ? [effect.amount] : undefined,
    triggeredByAura: effect,
    channelTarget: effect.channelData,
  } as Parameters<SpellUnit["castSpellInfo"]>[2]);
}

/** `HandlePeriodicDamageAurasTick` (the health-threshold removals for a few boss spells are spell scripts). */
function periodicDamageTick(effect: AuraEffect, target: SpellUnit, caster: SpellUnit | null): void {
  if (!target.isAlive()) return;
  const info = effect.spellInfo;
  if (target.isImmunedToDamage(caster, info) || target.isTotem) {
    caster?.sendSpellDamageImmune(target, info.id);
    return;
  }
  if (caster && info.effects[effect.effIndex]!.effect === SPELL_EFFECT_PERSISTENT_AREA_AURA && math.spellHitResult(caster, target, info, false) !== 0) return;
  let mitigated = 0;
  let damage = Math.max(effect.amount, 0);
  if (effect.auraType === SPELL_AURA_PERIODIC_DAMAGE_PERCENT) damage = Math.ceil((target.maxHealth * damage) / 100);
  if (effect.auraType === SPELL_AURA_PERIODIC_DAMAGE) {
    damage = math.spellDamageBonusTaken(target, caster, info, damage, DOT, effect.stackAmount);
    if (math.isDamageReducedByArmor(info.schoolMask, info, effect.effIndex)) {
      const reduced = math.calcArmorReducedDamage(caster, target, damage, info, effect.base.casterLevel);
      mitigated += damage - reduced;
      damage = reduced;
    }
  }
  const crit = rollChanceF(effect.critChance);
  if (crit) damage = math.spellCriticalDamageBonus(caster, info, damage, target);
  if (!hasAttribute(info, 4, SPELL_ATTR4_IGNORE_DAMAGE_TAKEN_MODIFIERS)) {
    const effectInfo = info.effects[effect.effIndex]!;
    if (isAreaAuraEffect(effectInfo.effect) || effectIsTargetingArea(effectInfo) || effectInfo.effect === SPELL_EFFECT_PERSISTENT_AREA_AURA || hasAttribute(info, 5, SPELL_ATTR5_TREAT_AS_AREA_EFFECT) || hasAttribute(info, 7, SPELL_ATTR7_TREAT_AS_NPC_AOE)) {
      const npcCaster = (caster && !caster.isControlledByPlayer()) || hasAttribute(info, 7, SPELL_ATTR7_TREAT_AS_NPC_AOE);
      damage = math.calculateAOEDamageReduction(target, damage, info.schoolMask, npcCaster);
    }
  }
  const resilience = { value: damage };
  if (caster?.canApplyResilience()) math.applyResilience(target, null, resilience, crit, 16 /* CR_CRIT_TAKEN_SPELL */);
  mitigated += damage - resilience.value;
  damage = Math.max(0, resilience.value);
  const dmgInfo = { attacker: caster, victim: target, damage, absorb: 0, resist: 0, schoolMask: info.schoolMask, spell: info, damageType: DOT };
  math.calcAbsorbResist(dmgInfo, effect.base.casterLevel);
  const dealt = { value: dmgInfo.damage };
  const absorb = { value: dmgInfo.absorb };
  math.dealDamageMods(target, dealt, absorb);
  const overkill = Math.max(0, dealt.value - target.health);
  math.sendPeriodicAuraLog(target, effect.casterGuid, info.id, { kind: "damage", auraType: effect.auraType, damage: dealt.value, overkill, schoolMask: info.schoolMask, absorb: absorb.value, resist: dmgInfo.resist, crit });
  math.dealDamage(caster, target, dealt.value, absorb.value, DOT, info.schoolMask, info);
  void mitigated;
}

/** `HandlePeriodicHealthLeechAuraTick` */
function periodicHealthLeechTick(effect: AuraEffect, target: SpellUnit, caster: SpellUnit | null): void {
  if (!target.isAlive()) return;
  const info = effect.spellInfo;
  if (target.isImmunedToDamage(caster, info)) {
    caster?.sendSpellDamageImmune(target, info.id);
    return;
  }
  if (caster && info.effects[effect.effIndex]!.effect === SPELL_EFFECT_PERSISTENT_AREA_AURA && math.spellHitResult(caster, target, info, false) !== 0) return;
  let damage = Math.max(effect.amount, 0);
  damage = math.spellDamageBonusTaken(target, caster, info, damage, DOT, effect.stackAmount);
  const crit = rollChanceF(effect.critChance);
  if (crit) damage = math.spellCriticalDamageBonus(caster, info, damage, target);
  if (math.isDamageReducedByArmor(info.schoolMask, info, effect.effIndex)) damage = math.calcArmorReducedDamage(caster, target, damage, info, effect.base.casterLevel);
  const resilience = { value: damage };
  if (caster?.canApplyResilience()) math.applyResilience(target, null, resilience, crit, 16);
  damage = Math.max(0, resilience.value);
  const dmgInfo = { attacker: caster, victim: target, damage, absorb: 0, resist: 0, schoolMask: info.schoolMask, spell: info, damageType: DOT };
  math.calcAbsorbResist(dmgInfo, effect.base.casterLevel);
  if (target.health < dmgInfo.damage) dmgInfo.damage = target.health;
  if (caster) {
    math.sendSpellNonMeleeDamageLog({ attacker: caster, target, spell: info, schoolMask: info.schoolMask, damage: dmgInfo.damage, absorb: dmgInfo.absorb, resist: dmgInfo.resist, blocked: 0, hitInfo: crit ? 0x2 : 0, cleanDamage: 0, physicalLog: false });
  }
  const newDamage = math.dealDamage(caster, target, dmgInfo.damage, dmgInfo.absorb, DOT, info.schoolMask, info);
  if (!caster || !caster.isAlive()) return;
  const gainMultiplier = effect.valueMultiplier();
  let heal = math.spellHealingBonusDone(caster, caster, info, Math.trunc(newDamage * gainMultiplier), DOT, effect.effIndex, 0, effect.stackAmount);
  heal = math.spellHealingBonusTaken(caster, caster, info, heal, DOT, effect.stackAmount);
  let threat = math.healBySpell(caster, caster, info, heal, false) * 0.5;
  if (caster.classId === 2 /* CLASS_PALADIN */) threat *= 0.5;
  caster.forwardThreatForAssistingMe(caster, threat);
}

/** `HandlePeriodicHealAurasTick` (heal absorbs are outside the baseline). */
function periodicHealTick(effect: AuraEffect, target: SpellUnit, caster: SpellUnit | null): void {
  if (!target.isAlive()) return;
  const info = effect.spellInfo;
  if (target.isImmunedToAuraPeriodicTick(caster, info)) {
    caster?.sendSpellDamageImmune(target, info.id);
    return;
  }
  if (target !== caster && hasAttribute(info, 2, SPELL_ATTR2_NO_TARGET_PER_SECOND_COST) && (!caster || !caster.isAlive())) return;
  if (effect.base.isPermanent() && target.health >= target.maxHealth) return;
  let damage = Math.max(effect.amount, 0);
  if (effect.auraType === SPELL_AURA_OBS_MOD_HEALTH) {
    let takenTotalMod = 1;
    const tenacity = target.getAuraEffect(58549, 0);
    if (tenacity) takenTotalMod = Math.fround(takenTotalMod + (takenTotalMod * tenacity.amount) / 100);
    for (const value of [
      target.getMaxNegativeAuraModifier(SPELL_AURA_MOD_HEALING_PCT),
      target.getMaxPositiveAuraModifier(SPELL_AURA_MOD_HEALING_PCT),
      target.getMaxNegativeAuraModifier(SPELL_AURA_MOD_HOT_PCT),
      target.getMaxPositiveAuraModifier(SPELL_AURA_MOD_HOT_PCT),
      target.getMaxNegativeAuraModifier(SPELL_AURA_MOD_HEALING_DONE_PERCENT),
    ]) {
      if (value) takenTotalMod = Math.fround(takenTotalMod + (takenTotalMod * value) / 100);
    }
    takenTotalMod = Math.max(takenTotalMod, 0);
    damage = Math.trunc((target.maxHealth * damage) / 100);
    damage = Math.trunc(damage * takenTotalMod);
  } else {
    if (caster) damage = Math.trunc(damage * caster.getTotalAuraMultiplier(SPELL_AURA_MOD_HEALING_DONE_PERCENT));
    damage = math.spellHealingBonusTaken(target, caster, info, damage, DOT, effect.stackAmount);
  }
  const crit = rollChanceF(effect.critChance);
  if (crit) damage = math.spellCriticalHealingBonus(caster, info, damage, target);
  const heal = damage;
  const gain = math.dealHeal(caster, target, heal);
  math.sendPeriodicAuraLog(target, effect.casterGuid, info.id, { kind: "heal", auraType: effect.auraType, heal, overheal: heal - gain, absorb: 0, crit });
  if (caster) {
    let threat = gain * 0.5;
    if (caster.classId === 2) threat *= 0.5;
    target.forwardThreatForAssistingMe(caster, threat);
  }
  if (target !== caster && caster && hasAttribute(info, 2, SPELL_ATTR2_NO_TARGET_PER_SECOND_COST)) {
    let manaPerSecond = info.manaPerSecond;
    if (manaPerSecond > gain && gain > 0) manaPerSecond = gain;
    const dealt = { value: manaPerSecond };
    math.dealDamageMods(caster, dealt, { value: 0 });
    math.dealDamage(caster, caster, dealt.value, 0, SELF_DAMAGE, info.schoolMask, info);
  }
}

/** `HandlePeriodicManaLeechAuraTick` (Mana Feed is a warlock script). */
function periodicManaLeechTick(effect: AuraEffect, target: SpellUnit, caster: SpellUnit | null): void {
  const powerType = effect.miscValue;
  if (!caster || !caster.isAlive() || !target.isAlive() || !target.hasActivePowerType(powerType)) return;
  const info = effect.spellInfo;
  if (target.isImmunedToAuraPeriodicTick(caster, info)) {
    caster.sendSpellDamageImmune(target, info.id);
    return;
  }
  if (info.effects[effect.effIndex]!.effect === SPELL_EFFECT_PERSISTENT_AREA_AURA && math.spellHitResult(caster, target, info, false) !== 0) return;
  let drainAmount = Math.max(effect.amount, 0);
  if (info.manaCostPercentage) {
    const maxmana = Math.trunc((caster.maxPower(powerType) * drainAmount * 2) / 100);
    drainAmount = Math.trunc((drainAmount * target.maxPower(powerType)) / 100);
    if (drainAmount > maxmana) drainAmount = maxmana;
  }
  if (powerType === POWER_MANA) drainAmount -= math.spellCritDamageReduction(target, drainAmount);
  const drained = -target.modifyPower(powerType, -drainAmount);
  const gainMultiplier = effect.valueMultiplier();
  math.sendPeriodicAuraLog(target, effect.casterGuid, info.id, { kind: "leech", auraType: effect.auraType, powerType, amount: drained, multiplier: gainMultiplier });
  const gainAmount = Math.trunc(drained * gainMultiplier);
  if (gainAmount) {
    const gained = caster.modifyPower(powerType, gainAmount);
    if (target.canHaveThreatList()) target.addThreat(caster, gained * 0.5);
  }
  target.removeAurasWithInterruptFlags(AURA_INTERRUPT_FLAG_TAKE_DAMAGE);
}

/** `HandleObsModPowerAuraTick` */
function obsModPowerTick(effect: AuraEffect, target: SpellUnit, caster: SpellUnit | null): void {
  const powerType = effect.miscValue === POWER_ALL ? target.powerType : effect.miscValue;
  if (!target.isAlive() || !target.maxPower(powerType)) return;
  if (target.isImmunedToAuraPeriodicTick(caster, effect.spellInfo)) {
    caster?.sendSpellDamageImmune(target, effect.id);
    return;
  }
  if (effect.base.isPermanent() && target.power(powerType) === target.maxPower(powerType)) return;
  const amount = Math.trunc((Math.max(effect.amount, 0) * target.maxPower(powerType)) / 100);
  math.sendPeriodicAuraLog(target, effect.casterGuid, effect.id, { kind: "energize", auraType: effect.auraType, powerType: effect.miscValue, amount });
  const gain = target.modifyPower(powerType, amount);
  if (caster) target.forwardThreatForAssistingMe(caster, gain * 0.5);
}

/** `HandlePeriodicEnergizeAuraTick` */
function periodicEnergizeTick(effect: AuraEffect, target: SpellUnit, caster: SpellUnit | null): void {
  const powerType = effect.miscValue;
  if (target.isPlayer && !target.hasActivePowerType(powerType) && !hasAttribute(effect.spellInfo, 7, SPELL_ATTR7_ONLY_IN_SPELLBOOK_UNTIL_LEARNED)) return;
  if (!target.isAlive() || !target.maxPower(powerType)) return;
  if (target.isImmunedToAuraPeriodicTick(caster, effect.spellInfo)) {
    caster?.sendSpellDamageImmune(target, effect.id);
    return;
  }
  if (effect.base.isPermanent() && target.power(powerType) === target.maxPower(powerType)) return;
  const amount = Math.max(effect.amount, 0);
  math.sendPeriodicAuraLog(target, effect.casterGuid, effect.id, { kind: "energize", auraType: effect.auraType, powerType, amount });
  const gain = target.modifyPower(powerType, amount);
  if (caster) target.forwardThreatForAssistingMe(caster, gain * 0.5);
}

/** `HandlePeriodicPowerBurnAuraTick` */
function periodicPowerBurnTick(effect: AuraEffect, target: SpellUnit, caster: SpellUnit | null): void {
  const powerType = effect.miscValue;
  if (!caster || !target.isAlive() || !target.hasActivePowerType(powerType)) return;
  const info = effect.spellInfo;
  if (target.isImmunedToDamage(caster, info)) {
    caster.sendSpellDamageImmune(target, info.id);
    return;
  }
  let damage = Math.max(effect.amount, 0);
  if (powerType === POWER_MANA) damage -= math.spellCritDamageReduction(target, damage);
  const gain = -target.modifyPower(powerType, -damage);
  const multiplier = effect.valueMultiplier();
  const damageInfo: math.SpellNonMeleeDamage = { attacker: caster, target, spell: info, schoolMask: info.schoolMask, damage: 0, absorb: 0, resist: 0, blocked: 0, hitInfo: 0, cleanDamage: 0, physicalLog: false };
  math.calculateSpellDamageTaken(caster, damageInfo, Math.trunc(gain * multiplier), info, 0, false);
  const dealt = { value: damageInfo.damage };
  const absorb = { value: damageInfo.absorb };
  math.dealDamageMods(target, dealt, absorb);
  damageInfo.damage = dealt.value;
  damageInfo.absorb = absorb.value;
  math.sendSpellNonMeleeDamageLog(damageInfo);
  math.dealSpellDamage(damageInfo);
}

