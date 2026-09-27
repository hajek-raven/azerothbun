import { irand } from "../common/random.ts";
import { ByteWriter } from "../net/byte-buffer.ts";
import { packedGuid } from "../world/update-object.ts";
import * as D from "./defines.ts";
import * as E from "./enums.ts";
import { dispelMask, allEffectsMechanicMask, hasAttribute, hasCustomAttribute, hasAura, needsExplicitUnitTarget, providedTargetMask, type SpellInfo } from "./spell-info.ts";
import type { Spell } from "./spell.ts";
import { IMPLICIT_TARGETS } from "./target-data.ts";
import type { SpellUnit } from "./unit.ts";
import * as math from "./unit-math.ts";

/** One `SpellEffects[]` entry (`Spell::Effect*`). */
export type SpellEffectHandler = (spell: Spell, effIndex: number) => void;

export const SMSG_SPELLINSTAKILLLOG = 0x32f;
export const SMSG_SPELLDISPELLOG = 0x27b;
export const SMSG_DISPEL_FAILED = 0x262;
export const SMSG_SPELLLOGEXECUTE = 0x24c;

/** `DAMAGE_FIRE` for `Player::EnvironmentalDamage`. */
const DAMAGE_FIRE = 3;

/** `GetUnitCasterForEffectHandlers`: the original caster when set, else the caster. */
function unitCaster(spell: Spell): SpellUnit | null {
  return spell.originalCasterGuid !== spell.caster.guid ? spell.originalCaster : spell.caster;
}

function isLaunchTarget(spell: Spell): boolean {
  return spell.effectHandleMode === E.SPELL_EFFECT_HANDLE_LAUNCH_TARGET;
}

function isHitTarget(spell: Spell): boolean {
  return spell.effectHandleMode === E.SPELL_EFFECT_HANDLE_HIT_TARGET;
}

/** `SPELL_ATTR0_CU_SHARE_DAMAGE`: divide by the number of targets of this effect. */
function shareDamage(spell: Spell, effIndex: number, damage: number): number {
  if (!hasCustomAttribute(spell.info, E.SPELL_ATTR0_CU_SHARE_DAMAGE)) return damage;
  const count = spell.uniqueTargets.filter((target) => target.effectMask & (1 << effIndex)).length;
  return count ? Math.trunc(damage / count) : damage;
}

/** `Spell::EffectNULL` / `EffectUnused` / `EffectNone` */
const effectNone: SpellEffectHandler = () => {};

/** `Spell::EffectInstaKill` */
const effectInstaKill: SpellEffectHandler = (spell) => {
  if (!isHitTarget(spell)) return;
  const target = spell.unitTarget;
  if (!target || !target.isAlive() || target.hasAura(27827)) return;
  if (target.isPlayer && target.isGodMode()) return;
  if (spell.caster === target) spell.finish();
  const body = new ByteWriter().writeU64(spell.caster.guid).writeU64(target.guid).writeU32(spell.info.id).toUint8Array();
  spell.caster.sendToSet(SMSG_SPELLINSTAKILLLOG, body, true);
  math.dealDamage(unitCaster(spell), target, target.health, 0, E.NODAMAGE, E.SPELL_SCHOOL_MASK_NORMAL, null);
};

/** `Spell::EffectEnvironmentalDMG` */
const effectEnvironmentalDamage: SpellEffectHandler = (spell) => {
  if (!isHitTarget(spell)) return;
  const target = spell.unitTarget;
  if (!target || !target.isAlive()) return;
  if (target.isPlayer) {
    target.environmentalDamage(DAMAGE_FIRE, spell.effectDamage);
    return;
  }
  const caster = unitCaster(spell);
  const damage = { value: spell.effectDamage };
  const absorb = { value: 0 };
  math.dealDamageMods(target, damage, absorb);
  spell.effectDamage = damage.value;
  if (caster) {
    math.sendSpellNonMeleeDamageLog({
      attacker: caster, target, spell: spell.info, schoolMask: spell.info.schoolMask, damage: damage.value, absorb: absorb.value,
      resist: 0, blocked: 0, hitInfo: 0, cleanDamage: 0, physicalLog: false,
    });
  }
};

/** `Spell::EffectSchoolDMG` (the class-family branches belong to the class script layer). */
const effectSchoolDamage: SpellEffectHandler = (spell, effIndex) => {
  if (!isLaunchTarget(spell)) return;
  const target = spell.unitTarget;
  if (!target || !target.isAlive()) return;
  let damage = spell.effectDamage;
  if (spell.info.spellFamilyName === E.SPELLFAMILY_GENERIC) damage = shareDamage(spell, effIndex, damage);
  if (spell.originalCaster) {
    if (damage < 0) damage = 0;
    damage = math.spellDamageBonusDone(spell.originalCaster, target, spell.info, damage, E.SPELL_DIRECT_DAMAGE, effIndex);
    damage = math.spellDamageBonusTaken(target, spell.originalCaster, spell.info, damage, E.SPELL_DIRECT_DAMAGE);
  }
  spell.damage += damage;
};

/** `Spell::EffectDummy`: the generic body. Spells with a script binding or a hard-coded id branch are refused at cast. */
const effectDummy: SpellEffectHandler = (spell) => {
  if (!isHitTarget(spell)) return;
  // `ScriptsStart(sSpellScripts, ...)` and `OnDummyEffect` have nothing to run for an unscripted spell.
};

/** `Spell::EffectTriggerSpell` */
const effectTriggerSpell: SpellEffectHandler = (spell, effIndex) => {
  if (spell.effectHandleMode !== E.SPELL_EFFECT_HANDLE_LAUNCH_TARGET && spell.effectHandleMode !== E.SPELL_EFFECT_HANDLE_LAUNCH) return;
  const caster = unitCaster(spell);
  const effect = spell.info.effects[effIndex]!;
  const triggeredId = effect.triggerSpell;
  const store = spell.caster.world.spells;
  if (effect.effect === D.SPELL_EFFECT_TRIGGER_SPELL && isLaunchTarget(spell)) {
    const target = spell.unitTarget;
    switch (triggeredId) {
      case 23770:
        return;
      case 29284:
      case 29286: {
        if (!caster || !target) return;
        const info = store.get(triggeredId === 29284 ? 24575 : 26464);
        if (!info) return;
        for (let j = 0; j < info.stackAmount; j++) caster.castSpell(target, info.id, { triggered: true });
        return;
      }
      case 35729: {
        if (!caster || !target) return;
        const mask = dispelMask(E.DISPEL_ALL);
        for (const app of [...target.appliedAuras]) {
          const info = app.base.spellInfo;
          if (allEffectsMechanicMask(info) & (1n << BigInt(E.MECHANIC_BLEED))) return;
          let dmgClassNone = false;
          if (info.dmgClass === E.SPELL_DAMAGE_CLASS_NONE && info.spellFamilyName === E.SPELLFAMILY_GENERIC) {
            for (let i = 0; i < 3; i++) {
              const type = info.effects[i]!.applyAuraName;
              if (app.effectMask & (1 << i) && type !== D.SPELL_AURA_PERIODIC_DAMAGE && type !== D.SPELL_AURA_PERIODIC_TRIGGER_SPELL && type !== D.SPELL_AURA_DUMMY) {
                dmgClassNone = false;
                break;
              }
              dmgClassNone = true;
            }
          }
          if ((info.dmgClass === E.SPELL_DAMAGE_CLASS_MAGIC || dispelMask(info.dispel) & mask || dmgClassNone) && !app.isPositive() && !app.base.isPassive() && (!hasAttribute(info, 0, D.SPELL_ATTR0_NO_IMMUNITIES) || info.spellFamilyName !== E.SPELLFAMILY_GENERIC)) {
            target.removeAuraApplication(app);
          }
        }
        return;
      }
      default:
        break;
    }
  }
  const info = store.get(triggeredId);
  if (!info) return;
  let target: SpellUnit | null = null;
  let dest: { x: number; y: number; z: number } | null = null;
  if (isLaunchTarget(spell)) {
    if (!needsToBeTriggeredByCaster(info, spell.info, effIndex)) return;
    target = spell.unitTarget;
  } else {
    if (needsToBeTriggeredByCaster(info, spell.info, effIndex) && providedTargetMask(effect) & E.TARGET_FLAG_UNIT_MASK) return;
    if (info.explicitTargetMask & E.TARGET_FLAG_DEST_LOCATION && spell.targets.dest) dest = spell.targets.dest;
    target = spell.unitTargetOf() ?? spell.caster;
  }
  const basePoints = effect.effect === D.SPELL_EFFECT_TRIGGER_SPELL_WITH_VALUE ? [spell.effectDamage, spell.effectDamage, spell.effectDamage] : undefined;
  if (caster?.isPlayer && info.categoryRecoveryTime && spell.info.category === info.category) caster.removeSpellCooldown(info.id, false);
  spell.caster.castSpellInfo(target, info, {
    triggerFlags: E.TRIGGERED_FULL_MASK & ~E.TRIGGERED_NO_PERIODIC_RESET,
    originalCaster: spell.originalCasterGuid,
    basePoints,
    dest,
  });
};

/** `SpellInfo::NeedsToBeTriggeredByCaster` */
export function needsToBeTriggeredByCaster(info: SpellInfo, triggering: SpellInfo, effIndex: number): boolean {
  if (needsExplicitUnitTarget(info)) return true;
  const trigger = triggering.effects[effIndex];
  if (trigger && (IMPLICIT_TARGETS[trigger.targetA]?.checkType === E.TARGET_CHECK_ENTRY || IMPLICIT_TARGETS[trigger.targetB]?.checkType === E.TARGET_CHECK_ENTRY)) {
    if (info.id === 60563) return true;
    for (const effect of info.effects) {
      if (effect.effect && (IMPLICIT_TARGETS[effect.targetA]?.checkType === E.TARGET_CHECK_ENTRY || IMPLICIT_TARGETS[effect.targetB]?.checkType === E.TARGET_CHECK_ENTRY)) return true;
    }
  }
  if (triggering.attributes[1]! & (D.SPELL_ATTR1_IS_CHANNELED | D.SPELL_ATTR1_IS_SELF_CHANNELED)) {
    let mask = 0;
    for (const effect of info.effects) {
      if (effect.targetA !== D.TARGET_UNIT_CASTER && effect.targetA !== D.TARGET_DEST_CASTER) mask |= providedTargetMask(effect);
    }
    if (mask & E.TARGET_FLAG_UNIT_MASK) return true;
  }
  return false;
}

/** `Spell::EffectTeleportUnits` (engineering teleporter post effects are item scripts outside the baseline). */
const effectTeleportUnits: SpellEffectHandler = (spell) => {
  if (!isHitTarget(spell)) return;
  const target = spell.unitTarget;
  if (!target || target.isInFlight()) return;
  const dest = spell.destTarget;
  if (!dest || !spell.targets.dest) return;
  let orientation = dest.o;
  const explicit = spell.unitTargetOf();
  if (!orientation && explicit) orientation = explicit.position().o;
  const map = dest.map;
  if (map === target.position().map) target.nearTeleportTo(dest.x, dest.y, dest.z, orientation, target === spell.caster);
  else if (target.isPlayer) target.teleportTo(map, dest.x, dest.y, dest.z, orientation);
};

/** `Spell::EffectApplyAura` / `EffectApplyAreaAura` */
const effectApplyAura: SpellEffectHandler = (spell, effIndex) => {
  if (!isHitTarget(spell)) return;
  if (!spell.spellAura || !spell.unitTarget) return;
  spell.spellAura.applyEffectForTargets(effIndex);
};

/** `Spell::EffectPowerDrain` */
const effectPowerDrain: SpellEffectHandler = (spell, effIndex) => {
  if (!isHitTarget(spell)) return;
  const effect = spell.info.effects[effIndex]!;
  if (effect.miscValue < 0 || effect.miscValue >= E.MAX_POWERS) return;
  const power = effect.miscValue;
  const target = spell.unitTarget;
  let damage = spell.effectDamage;
  if (!target || !target.isAlive() || !target.hasActivePowerType(power) || damage < 0) return;
  const caster = unitCaster(spell);
  if (caster) {
    damage = math.spellDamageBonusDone(caster, target, spell.info, damage, E.SPELL_DIRECT_DAMAGE, effIndex);
    damage = math.spellDamageBonusTaken(target, caster, spell.info, damage, E.SPELL_DIRECT_DAMAGE);
  }
  let amount = damage;
  if (power === E.POWER_MANA) amount -= math.spellCritDamageReduction(target, amount);
  const newDamage = -target.modifyPower(power, -amount);
  let gainMultiplier = 0;
  if (caster && caster !== target) {
    gainMultiplier = effect.valueMultiplier;
    math.energizeBySpell(caster, caster, spell.info.id, Math.trunc(newDamage * gainMultiplier), power);
  }
  spell.logTakeTargetPower(effIndex, target, power, newDamage, gainMultiplier);
};

/** `Spell::EffectPowerBurn` */
const effectPowerBurn: SpellEffectHandler = (spell, effIndex) => {
  if (!isHitTarget(spell)) return;
  const effect = spell.info.effects[effIndex]!;
  if (effect.miscValue < 0 || effect.miscValue >= E.MAX_POWERS) return;
  const power = effect.miscValue;
  const target = spell.unitTarget;
  let damage = spell.effectDamage;
  if (!target || !target.isAlive() || !target.hasActivePowerType(power) || damage < 0) return;
  const caster = unitCaster(spell);
  if (caster && spell.info.id === 8129) {
    const maxDamage = Math.trunc((caster.maxPower(power) * damage * 2) / 100);
    damage = Math.min(Math.trunc((target.maxPower(power) * damage) / 100), maxDamage);
    target.removeAurasByType(D.SPELL_AURA_MOD_FEAR);
  }
  let amount = damage;
  if (power === E.POWER_MANA) amount -= math.spellCritDamageReduction(target, amount);
  let newDamage = -target.modifyPower(power, -amount);
  spell.logTakeTargetPower(effIndex, target, power, newDamage, 0);
  newDamage = Math.trunc(newDamage * effect.valueMultiplier);
  spell.damage += newDamage;
};

/** `Spell::EffectHeal` (Swiftmend, Death Pact, and Vessel of the Naaru are class and item scripts). */
const effectHeal: SpellEffectHandler = (spell, effIndex) => {
  if (!isLaunchTarget(spell)) return;
  const target = spell.unitTarget;
  const damage = spell.effectDamage;
  if (!target || !target.isAlive() || damage < 0) return;
  const caster = spell.originalCasterGuid ? spell.originalCaster : unitCaster(spell);
  if (!caster) return;
  let addHealth = damage;
  if (spell.info.id !== 33778) {
    addHealth = math.spellHealingBonusDone(caster, target, spell.info, addHealth, E.HEAL, effIndex);
    spell.damageBeforeTakenMods -= addHealth;
    addHealth = math.spellHealingBonusTaken(target, caster, spell.info, addHealth, E.HEAL);
  }
  if (caster.isPlayer && caster.hasAura(23401) && !hasAura(spell.info, D.SPELL_AURA_PERIODIC_HEAL) && spell.info.schoolMask & E.SPELL_SCHOOL_MASK_HOLY) {
    spell.damage = 0;
    caster.castSpell(target, 23402, {});
    return;
  }
  spell.damage -= addHealth;
};

/** `Spell::EffectHealPct` */
const effectHealPct: SpellEffectHandler = (spell, effIndex) => {
  if (!isLaunchTarget(spell)) return;
  const target = spell.unitTarget;
  if (!target || !target.isAlive() || spell.effectDamage < 0) return;
  const caster = spell.originalCaster;
  if (!caster) return;
  let heal = math.spellHealingBonusDone(caster, target, spell.info, Math.trunc((target.maxHealth * spell.effectDamage) / 100), E.HEAL, effIndex);
  spell.damageBeforeTakenMods -= heal;
  heal = math.spellHealingBonusTaken(target, caster, spell.info, heal, E.HEAL);
  spell.damage -= heal;
};

/** `Spell::EffectHealthLeech` (the heal back happens in `DoAllEffectOnTarget`). */
const effectHealthLeech: SpellEffectHandler = (spell, effIndex) => {
  if (!isHitTarget(spell)) return;
  const target = spell.unitTarget;
  let damage = spell.effectDamage;
  if (!target || !target.isAlive() || damage < 0) return;
  const caster = unitCaster(spell);
  if (caster) {
    damage = math.spellDamageBonusDone(caster, target, spell.info, damage, E.SPELL_DIRECT_DAMAGE, effIndex);
    damage = math.spellDamageBonusTaken(target, caster, spell.info, damage, E.SPELL_DIRECT_DAMAGE);
  }
  spell.damage += damage;
};

/** `Spell::EffectHealMaxHealth` */
const effectHealMaxHealth: SpellEffectHandler = (spell) => {
  const caster = unitCaster(spell);
  if (!caster || !isHitTarget(spell)) return;
  const target = spell.unitTarget;
  if (!target || !target.isAlive()) return;
  if (target.isImmunedToAuraPeriodicTick(caster, spell.info)) {
    caster.sendSpellDamageImmune(target, spell.info.id);
    return;
  }
  spell.healing += spell.effectDamage === 0 ? caster.maxHealth : target.maxHealth - target.health;
};

/** `Spell::EffectEnergize` (Mad Alchemist's Potion is an item script). */
const effectEnergize: SpellEffectHandler = (spell, effIndex) => {
  const caster = unitCaster(spell);
  if (!caster || !isHitTarget(spell)) return;
  const target = spell.unitTarget;
  if (!target || !target.isAlive()) return;
  if (target.isImmunedToAuraPeriodicTick(caster, spell.info)) {
    caster.sendSpellDamageImmune(target, spell.info.id);
    return;
  }
  const effect = spell.info.effects[effIndex]!;
  if (effect.miscValue < 0 || effect.miscValue >= E.MAX_POWERS) return;
  const power = effect.miscValue;
  if (target.isPlayer && !target.hasActivePowerType(power) && spell.info.spellFamilyName !== E.SPELLFAMILY_POTION && !hasAttribute(spell.info, 7, D.SPELL_ATTR7_ONLY_IN_SPELLBOOK_UNTIL_LEARNED)) return;
  if (target.maxPower(power) === 0) return;
  let damage = spell.effectDamage;
  let levelMultiplier = 0;
  let levelDiff = 0;
  switch (spell.info.id) {
    case 9512:
      levelDiff = caster.level - 40;
      levelMultiplier = 2;
      break;
    case 24571:
      levelDiff = caster.level - 60;
      levelMultiplier = 10;
      break;
    case 24532:
      levelDiff = caster.level - 60;
      levelMultiplier = 4;
      break;
    case 31930:
    case 63375:
    case 68082:
      damage = Math.trunc((target.createMana * damage) / 100);
      break;
    case 48542:
      damage = Math.trunc((target.maxPower(power) * damage) / 100);
      break;
    case 71132:
      damage = Math.trunc(target.createMana / 100);
      break;
    default:
      break;
  }
  if (levelDiff > 0) damage -= levelMultiplier * levelDiff;
  if (damage < 0) return;
  math.energizeBySpell(caster, target, spell.info.id, damage, power);
};

/** `Spell::EffectEnergizePct` */
const effectEnergizePct: SpellEffectHandler = (spell, effIndex) => {
  const caster = unitCaster(spell);
  if (!caster || !isHitTarget(spell)) return;
  const target = spell.unitTarget;
  if (!target || !target.isAlive()) return;
  if (target.hasUnitState(E.UNIT_STATE_ISOLATED)) {
    caster.sendSpellDamageImmune(target, spell.info.id);
    return;
  }
  const effect = spell.info.effects[effIndex]!;
  if (effect.miscValue < 0 || effect.miscValue >= E.MAX_POWERS) return;
  const power = effect.miscValue;
  if (target.isPlayer && !target.hasActivePowerType(power) && !hasAttribute(spell.info, 7, D.SPELL_ATTR7_ONLY_IN_SPELLBOOK_UNTIL_LEARNED)) return;
  const maxPower = target.maxPower(power);
  if (maxPower === 0) return;
  math.energizeBySpell(caster, target, spell.info.id, Math.trunc((maxPower * spell.effectDamage) / 100), power);
};

/** `Spell::EffectLearnSpell` (pet spells belong to the pet layer). */
const effectLearnSpell: SpellEffectHandler = (spell, effIndex) => {
  if (!isHitTarget(spell)) return;
  const target = spell.unitTarget;
  if (!target || !target.isPlayer) return;
  const spellToLearn = spell.info.id === 483 || spell.info.id === 55884 ? spell.effectDamage : spell.info.effects[effIndex]!.triggerSpell;
  target.learnSpell(spellToLearn);
};

/** `Spell::EffectDispel` (Devour Magic's heal is a class script). */
const effectDispel: SpellEffectHandler = (spell, effIndex) => {
  if (!isHitTarget(spell)) return;
  const caster = spell.caster;
  const target = spell.unitTarget;
  if (!target) return;
  const mask = dispelMask(spell.info.effects[effIndex]!.miscValue);
  const list = target.getDispellableAuraList(caster, mask, spell.info);
  if (!list.length) return;
  let failCount = 0;
  const success: { aura: (typeof list)[number]["aura"]; count: number }[] = [];
  const failed = new ByteWriter();
  const damage = spell.effectDamage;
  for (let count = 0; count < damage && list.length; ) {
    const index = irand(0, list.length - 1);
    const entry = list[index]!;
    const chance = entry.aura.calcDispelChance(target, !target.isFriendlyTo(caster));
    if (!chance) {
      list.splice(index, 1);
      continue;
    }
    if (irand(0, 99) < chance) {
      const listed = success.find((row) => row.aura === entry.aura);
      if (listed) listed.count++;
      else success.push({ aura: entry.aura, count: 1 });
      entry.charges--;
      if (entry.charges <= 0) list.splice(index, 1);
    } else {
      if (!failCount) failed.writeU64(caster.guid).writeU64(target.guid).writeU32(spell.info.id);
      failCount++;
      failed.writeU32(entry.aura.id);
    }
    count++;
  }
  if (failCount) caster.sendToSet(SMSG_DISPEL_FAILED, failed.toUint8Array(), true);
  if (target.isFriendlyTo(caster)) target.forwardThreatForAssistingMe(caster, 0);
  if (!success.length) return;
  const body = new ByteWriter().writeBytes(packedGuid(target.guid)).writeBytes(packedGuid(caster.guid)).writeU32(spell.info.id).writeU8(0).writeU32(success.length);
  for (const row of success) {
    body.writeU32(row.aura.id).writeU8(0);
    target.removeAurasDueToSpellByDispel(row.aura.id, row.aura.casterGuid, row.count);
  }
  caster.sendToSet(SMSG_SPELLDISPELLOG, body.toUint8Array(), true);
};

/** `Spell::EffectDispelMechanic` */
const effectDispelMechanic: SpellEffectHandler = (spell, effIndex) => {
  if (!isHitTarget(spell)) return;
  const caster = spell.caster;
  const target = spell.unitTarget;
  if (!target) return;
  const effect = spell.info.effects[effIndex]!;
  const mechanic = BigInt(effect.miscValue);
  const list: { id: number; caster: bigint }[] = [];
  for (const aura of target.ownedAuras) {
    if (!aura.getApplicationOfTarget(target.guid)) continue;
    if (irand(0, 99) < aura.calcDispelChance(target, !target.isFriendlyTo(caster))) {
      if (allEffectsMechanicMask(aura.spellInfo) & (1n << mechanic)) {
        list.push({ id: aura.id, caster: aura.casterGuid });
        if (effect.basePoints === 1) break;
      }
    }
  }
  for (const row of list) target.removeAurasDueToSpell(row.id, row.caster, 0, E.AURA_REMOVE_BY_ENEMY_SPELL);
  if (target.isFriendlyTo(caster)) target.forwardThreatForAssistingMe(caster, 0);
};

/** `Spell::EffectParry` */
const effectParry: SpellEffectHandler = (spell) => {
  if (spell.effectHandleMode !== E.SPELL_EFFECT_HANDLE_HIT) return;
  if (spell.caster.isPlayer) spell.caster.stats.setCanParry(true);
};

/** `Spell::EffectBlock` */
const effectBlock: SpellEffectHandler = (spell) => {
  if (spell.effectHandleMode !== E.SPELL_EFFECT_HANDLE_HIT) return;
  if (spell.caster.isPlayer) spell.caster.stats.setCanBlock(true);
};

/** `Spell::EffectDualWield` */
const effectDualWield: SpellEffectHandler = (spell) => {
  if (!isHitTarget(spell)) return;
  spell.unitTarget?.stats.setCanDualWield(true);
};

/** `Spell::EffectWeaponDmg` for `WEAPON_DAMAGE`, `WEAPON_DAMAGE_NOSCHOOL`, `NORMALIZED_WEAPON_DMG`, and `WEAPON_PERCENT_DAMAGE`. */
const effectWeaponDamage: SpellEffectHandler = (spell, effIndex) => {
  const caster = unitCaster(spell);
  if (!caster || !isLaunchTarget(spell)) return;
  const target = spell.unitTarget;
  if (!target || !target.isAlive()) return;
  const effects = spell.info.effects;
  for (let j = effIndex + 1; j < 3; j++) {
    if (WEAPON_EFFECTS.has(effects[j]!.effect)) return;
  }
  const totalDamagePercentMod = 100;
  const spellBonus = 0;
  let normalized = false;
  let weaponDamagePercentMod = 100;
  let fixedBonus = 0;
  for (let j = 0; j < 3; j++) {
    switch (effects[j]!.effect) {
      case D.SPELL_EFFECT_WEAPON_DAMAGE:
      case D.SPELL_EFFECT_WEAPON_DAMAGE_NOSCHOOL:
        fixedBonus += spell.caster.calculateSpellDamage(spell.info, j, spell.spellValue.basePoints[j]);
        break;
      case D.SPELL_EFFECT_NORMALIZED_WEAPON_DMG:
        fixedBonus += spell.caster.calculateSpellDamage(spell.info, j, spell.spellValue.basePoints[j]);
        normalized = true;
        break;
      case D.SPELL_EFFECT_WEAPON_PERCENT_DAMAGE:
        weaponDamagePercentMod = (weaponDamagePercentMod * spell.caster.calculateSpellDamage(spell.info, j, spell.spellValue.basePoints[j])) / 100;
        break;
      default:
        break;
    }
  }
  const isPhysical = (spell.schoolMask & E.SPELL_SCHOOL_MASK_NORMAL) !== 0;
  let scaledFixed = fixedBonus;
  let scaledSpell = spellBonus;
  if (isPhysical && (fixedBonus || spellBonus)) {
    const unitMod = spell.attackType === math.OFF_ATTACK ? E.UNIT_MOD_DAMAGE_OFFHAND : spell.attackType === math.RANGED_ATTACK ? E.UNIT_MOD_DAMAGE_RANGED : E.UNIT_MOD_DAMAGE_MAINHAND;
    const pct = caster.stats.getPctModifierValue(unitMod, E.TOTAL_PCT);
    scaledFixed = Math.trunc(fixedBonus * pct);
    scaledSpell = Math.trunc(spellBonus * pct);
  }
  let weaponDamage = caster.stats.weaponDamage(spell.attackType, normalized, isPhysical);
  for (let j = 0; j < 3; j++) {
    switch (effects[j]!.effect) {
      case D.SPELL_EFFECT_WEAPON_DAMAGE:
      case D.SPELL_EFFECT_WEAPON_DAMAGE_NOSCHOOL:
      case D.SPELL_EFFECT_NORMALIZED_WEAPON_DMG:
        weaponDamage += scaledFixed;
        break;
      case D.SPELL_EFFECT_WEAPON_PERCENT_DAMAGE:
        weaponDamage = Math.trunc((weaponDamage * weaponDamagePercentMod) / 100);
        break;
      default:
        break;
    }
  }
  weaponDamage += scaledSpell;
  weaponDamage = Math.trunc((weaponDamage * totalDamagePercentMod) / 100);
  let damage = Math.max(weaponDamage, 0);
  damage = math.meleeDamageBonusDone(caster, target, damage, spell.attackType, spell.info, spell.schoolMask);
  damage = math.meleeDamageBonusTaken(target, caster, damage, spell.attackType, spell.info, spell.schoolMask);
  spell.damage += shareDamage(spell, effIndex, damage);
};

const WEAPON_EFFECTS = new Set([D.SPELL_EFFECT_WEAPON_DAMAGE, D.SPELL_EFFECT_WEAPON_DAMAGE_NOSCHOOL, D.SPELL_EFFECT_NORMALIZED_WEAPON_DMG, D.SPELL_EFFECT_WEAPON_PERCENT_DAMAGE]);

/** `Spell::EffectThreat` */
const effectThreat: SpellEffectHandler = (spell) => {
  const caster = unitCaster(spell);
  if (!caster || !isHitTarget(spell)) return;
  const target = spell.unitTarget;
  if (!target || !target.isAlive() || !caster.isAlive()) return;
  if (!target.canHaveThreatList() || caster.isFriendlyTo(target)) return;
  target.addThreat(caster, spell.effectDamage);
};

/** `Spell::EffectTaunt` (Hand of Reckoning's extra cast is a class script). */
const effectTaunt: SpellEffectHandler = (spell) => {
  const caster = unitCaster(spell);
  if (!caster || !isHitTarget(spell)) return;
  const target = spell.unitTarget;
  if (!target) return;
  if (!target.canHaveThreatList() || target.victim() === caster) {
    spell.sendCastResult(D.SPELL_FAILED_DONT_REPORT);
    return;
  }
  target.matchUnitThreatToHighestThreat(caster);
};

/** `Spell::EffectModifyThreatPercent` */
const effectModifyThreatPercent: SpellEffectHandler = (spell) => {
  const caster = unitCaster(spell);
  if (!caster || !isHitTarget(spell) || !spell.unitTarget) return;
  spell.unitTarget.modifyThreatPercent(caster, spell.effectDamage);
};

/** `Spell::EffectInterruptCast` */
const effectInterruptCast: SpellEffectHandler = (spell, effIndex) => {
  if (!isLaunchTarget(spell)) return;
  const target = spell.unitTarget;
  if (!target || !target.isAlive()) return;
  for (let type = E.CURRENT_GENERIC_SPELL; type < E.CURRENT_AUTOREPEAT_SPELL; type++) {
    const current = target.currentSpells[type];
    if (!current) continue;
    const info = current.info;
    if ((current.state === E.SPELL_STATE_CASTING || (current.state === E.SPELL_STATE_PREPARING && current.castTime > 0)) && info.preventionType === E.SPELL_PREVENTION_TYPE_SILENCE && ((type === E.CURRENT_GENERIC_SPELL && info.interruptFlags & E.SPELL_INTERRUPT_FLAG_INTERRUPT) || (type === E.CURRENT_CHANNELED_SPELL && info.channelInterruptFlags & E.CHANNEL_INTERRUPT_FLAG_INTERRUPT))) {
      if (spell.originalCaster) {
        const duration = spell.originalCaster.modSpellDuration(spell.info, target, spell.originalCaster.calcSpellDurationFor(spell.info), false, 1 << effIndex);
        target.prohibitSpellSchool(info.schoolMask, duration);
      }
      spell.logInterruptCast(effIndex, target, info.id);
      target.interruptSpell(type, false);
    }
  }
};

/** `Spell::EffectScriptEffect`: the generic body. Hard-coded ids and `spell_scripts` bindings are refused at cast. */
const effectScriptEffect: SpellEffectHandler = (spell) => {
  if (!isHitTarget(spell)) return;
};

/** `Spell::EffectAddComboPoints` */
const effectAddComboPoints: SpellEffectHandler = (spell) => {
  if (!isHitTarget(spell)) return;
  if (!spell.unitTarget || spell.effectDamage <= 0) return;
  spell.addComboPointGain(spell.unitTarget, spell.effectDamage);
};

/** `Spell::EffectRemoveAura` */
const effectRemoveAura: SpellEffectHandler = (spell, effIndex) => {
  if (!isHitTarget(spell) || !spell.unitTarget) return;
  spell.unitTarget.removeAurasDueToSpell(spell.info.effects[effIndex]!.triggerSpell);
};

/** The baseline `SpellEffects[]` table; every id missing here is refused at cast. */
export const SPELL_EFFECT_HANDLERS: Readonly<Record<number, SpellEffectHandler>> = {
  0: effectNone,
  [D.SPELL_EFFECT_INSTAKILL]: effectInstaKill,
  [D.SPELL_EFFECT_SCHOOL_DAMAGE]: effectSchoolDamage,
  [D.SPELL_EFFECT_DUMMY]: effectDummy,
  [D.SPELL_EFFECT_TELEPORT_UNITS]: effectTeleportUnits,
  [D.SPELL_EFFECT_APPLY_AURA]: effectApplyAura,
  [D.SPELL_EFFECT_ENVIRONMENTAL_DAMAGE]: effectEnvironmentalDamage,
  [D.SPELL_EFFECT_POWER_DRAIN]: effectPowerDrain,
  [D.SPELL_EFFECT_HEALTH_LEECH]: effectHealthLeech,
  [D.SPELL_EFFECT_HEAL]: effectHeal,
  [D.SPELL_EFFECT_WEAPON_DAMAGE_NOSCHOOL]: effectWeaponDamage,
  [D.SPELL_EFFECT_PARRY]: effectParry,
  [D.SPELL_EFFECT_BLOCK]: effectBlock,
  [D.SPELL_EFFECT_ENERGIZE]: effectEnergize,
  [D.SPELL_EFFECT_WEAPON_PERCENT_DAMAGE]: effectWeaponDamage,
  [D.SPELL_EFFECT_APPLY_AREA_AURA_PARTY]: effectApplyAura,
  [D.SPELL_EFFECT_LEARN_SPELL]: effectLearnSpell,
  [D.SPELL_EFFECT_DISPEL]: effectDispel,
  [D.SPELL_EFFECT_DUAL_WIELD]: effectDualWield,
  [D.SPELL_EFFECT_WEAPON_DAMAGE]: effectWeaponDamage,
  [D.SPELL_EFFECT_POWER_BURN]: effectPowerBurn,
  [D.SPELL_EFFECT_THREAT]: effectThreat,
  [D.SPELL_EFFECT_TRIGGER_SPELL]: effectTriggerSpell,
  [D.SPELL_EFFECT_APPLY_AREA_AURA_RAID]: effectApplyAura,
  [D.SPELL_EFFECT_HEAL_MAX_HEALTH]: effectHealMaxHealth,
  [D.SPELL_EFFECT_INTERRUPT_CAST]: effectInterruptCast,
  [D.SPELL_EFFECT_SCRIPT_EFFECT]: effectScriptEffect,
  [D.SPELL_EFFECT_ADD_COMBO_POINTS]: effectAddComboPoints,
  [D.SPELL_EFFECT_DISPEL_MECHANIC]: effectDispelMechanic,
  [D.SPELL_EFFECT_ATTACK_ME]: effectTaunt,
  [D.SPELL_EFFECT_APPLY_AREA_AURA_PET]: effectApplyAura,
  [D.SPELL_EFFECT_NORMALIZED_WEAPON_DMG]: effectWeaponDamage,
  [D.SPELL_EFFECT_MODIFY_THREAT_PERCENT]: effectModifyThreatPercent,
  [D.SPELL_EFFECT_APPLY_AREA_AURA_FRIEND]: effectApplyAura,
  [D.SPELL_EFFECT_APPLY_AREA_AURA_ENEMY]: effectApplyAura,
  [D.SPELL_EFFECT_HEAL_PCT]: effectHealPct,
  [D.SPELL_EFFECT_ENERGIZE_PCT]: effectEnergizePct,
  [D.SPELL_EFFECT_TRIGGER_SPELL_WITH_VALUE]: effectTriggerSpell,
  [D.SPELL_EFFECT_APPLY_AREA_AURA_OWNER]: effectApplyAura,
  [D.SPELL_EFFECT_REMOVE_AURA]: effectRemoveAura,
};

export function isEffectSupported(effect: number): boolean {
  return effect in SPELL_EFFECT_HANDLERS;
}

/** Hard-coded id branches of `EffectDummy`, `EffectScriptEffect`, `EffectTriggerSpell`, `EffectTeleportUnits`, and friends that belong to later layers. */
export const SCRIPTED_EFFECT_SPELLS: ReadonlySet<number> = new Set([
  // EffectDummy
  67866, 66867, 17731, 69294, 59086, 31789, 51662,
  // EffectScriptEffect
  22539, 22972, 22975, 22976, 22977, 22978, 22979, 22980, 22981, 22982, 22983, 22984, 22985, 32307, 54640, 41931, 52173, 60243, 57347, 57349, 58418, 58420, 61263, 31666, 58428,
  // EffectTeleportUnits
  70746, 23442, 36941,
  // EffectHeal
  45064,
  // EffectEnergize
  45051,
  // EffectTaunt
  62124,
  // EffectWeaponDmg
  67725, 67883, 20467, 53385,
]);

/**
 * The class-family branches of `EffectSchoolDMG` and `EffectWeaponDmg` that change damage from the spell's own data.
 * They belong to the class layer; until it exists such spells are refused rather than dealing the wrong amount.
 * Branches that only fire with a talent, glyph, set bonus, or shapeshift aura (none of which apply yet) stay open.
 */
export function classDamageBranch(info: SpellInfo): boolean {
  const flags = info.spellFamilyFlags;
  const hasSchool = info.effects.some((effect) => effect.effect === D.SPELL_EFFECT_SCHOOL_DAMAGE);
  const hasWeapon = info.effects.some((effect) => WEAPON_EFFECTS.has(effect.effect));
  if (hasSchool) {
    switch (info.spellFamilyName) {
      case E.SPELLFAMILY_WARRIOR:
        if ((flags[1]! & 0x200 && info.category === 1209) || flags[1]! & 0x100 || info.id === 46968) return true;
        break;
      case E.SPELLFAMILY_WARLOCK:
        if ((flags[1]! & 0x40 && info.spellIconId === 2128) || info.targetAuraState === E.AURA_STATE_CONFLAGRATE || flags[1]! & 0x400000) return true;
        break;
      case E.SPELLFAMILY_DRUID:
        if (flags[0]! & 0x800000 && info.spellVisual[0] === 6587) return true;
        break;
      case E.SPELLFAMILY_ROGUE:
        if (flags[1]! & 0x8 || flags[0]! & 0x20000) return true;
        break;
      case E.SPELLFAMILY_HUNTER:
        if (info.spellIconId === 1578 || flags[1]! & 0x1) return true;
        break;
      case E.SPELLFAMILY_PALADIN:
        if (flags[1]! & 0x40000 || flags[1]! & 0x100000) return true;
        break;
      default:
        break;
    }
  }
  if (hasWeapon) {
    switch (info.spellFamilyName) {
      case E.SPELLFAMILY_WARRIOR:
        if (flags[1]! & 0x40) return true;
        break;
      case E.SPELLFAMILY_ROGUE:
        if (flags[1]! & 0x40000 || flags[0]! & 0x6000000 || flags[1]! & 0x6) return true;
        break;
      case E.SPELLFAMILY_DRUID:
        if (flags[1]! & 0x400 || flags[0]! & 0x8800) return true;
        break;
      case E.SPELLFAMILY_HUNTER:
        if (flags[1]! & 0x800000) return true;
        break;
      case E.SPELLFAMILY_DEATHKNIGHT:
        if (flags[0]! & 0x1 || flags[0]! & 0x400000 || flags[0]! & 0x10 || flags[1]! & 0x20000 || info.spellIconId === 1736 || flags[0]! & 0x1000000 || flags[1]! & 0x20000000) return true;
        break;
      default:
        break;
    }
  }
  return false;
}
