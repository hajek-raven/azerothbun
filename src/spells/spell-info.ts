import {
  creature_classlevelstats,
  creature_immunities,
  creature_template,
  spell_bonus_data,
  spell_cooldown_overrides,
  spell_dbc,
  spellcasttimes_dbc,
  spellcategory_dbc,
  spellduration_dbc,
  spellradius_dbc,
  spellrange_dbc,
  spellshapeshiftform_dbc,
  spellvisual_dbc,
} from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { irand, randNorm } from "../common/random.ts";
import { DbcTable, type DbcRecordView } from "./dbc-table.ts";
import { SpellWorldData } from "./world-data.ts";
import { EFFECT_TARGETS, IMPLICIT_TARGETS } from "./target-data.ts";
import {
  SPELL_ATTR0_AURA_IS_DEBUFF,
  SPELL_ATTR0_COOLDOWN_ON_EVENT,
  SPELL_ATTR0_IS_ABILITY,
  SPELL_ATTR0_IS_TRADESKILL,
  SPELL_ATTR0_NOT_IN_COMBAT_ONLY_PEACEFUL,
  SPELL_ATTR0_NOT_SHAPESHIFTED,
  SPELL_ATTR0_NO_IMMUNITIES,
  SPELL_ATTR0_ON_NEXT_SWING_NO_DAMAGE,
  SPELL_ATTR0_PASSIVE,
  SPELL_ATTR0_USES_RANGED_SLOT,
  SPELL_ATTR1_ALLOW_WHILE_STEALTHED,
  SPELL_ATTR1_FINISHING_MOVE_DAMAGE,
  SPELL_ATTR1_FINISHING_MOVE_DURATION,
  SPELL_ATTR1_IS_CHANNELED,
  SPELL_ATTR1_IS_SELF_CHANNELED,
  SPELL_ATTR1_NO_THREAT,
  SPELL_ATTR2_ALLOW_DEAD_TARGET,
  SPELL_ATTR2_ALLOW_WHILE_NOT_SHAPESHIFTED,
  SPELL_ATTR2_AUTO_REPEAT,
  SPELL_ATTR3_ALLOW_AURA_WHILE_DEAD,
  SPELL_ATTR3_ALWAYS_HIT,
  SPELL_ATTR3_ONLY_ON_GHOSTS,
  SPELL_ATTR3_SUPPRESS_TARGET_PROCS,
  SPELL_ATTR5_ALLOW_ACTION_DURING_CHANNEL,
  SPELL_ATTR5_LIMIT_N,
  SPELL_AURA_ADD_FLAT_MODIFIER,
  SPELL_AURA_ADD_PCT_MODIFIER,
  SPELL_AURA_ADD_TARGET_TRIGGER,
  SPELL_AURA_AOE_CHARM,
  SPELL_AURA_BIND_SIGHT,
  SPELL_AURA_CONTROL_VEHICLE,
  SPELL_AURA_CONVERT_RUNE,
  SPELL_AURA_DAMAGE_IMMUNITY,
  SPELL_AURA_DISPEL_IMMUNITY,
  SPELL_AURA_DUMMY,
  SPELL_AURA_EFFECT_IMMUNITY,
  SPELL_AURA_GHOST,
  SPELL_AURA_MECHANIC_IMMUNITY,
  SPELL_AURA_MECHANIC_IMMUNITY_MASK,
  SPELL_AURA_MOD_CHARM,
  SPELL_AURA_MOD_CONFUSE,
  SPELL_AURA_MOD_CRIT_PCT,
  SPELL_AURA_MOD_DAMAGE_DONE,
  SPELL_AURA_MOD_DAMAGE_PERCENT_DONE,
  SPELL_AURA_MOD_DAMAGE_TAKEN,
  SPELL_AURA_MOD_DECREASE_SPEED,
  SPELL_AURA_MOD_DISARM,
  SPELL_AURA_MOD_DODGE_PERCENT,
  SPELL_AURA_MOD_FEAR,
  SPELL_AURA_MOD_HEALING_DONE,
  SPELL_AURA_MOD_HEALING_PCT,
  SPELL_AURA_MOD_IMMUNE_AURA_APPLY_SCHOOL,
  SPELL_AURA_MOD_INVISIBILITY,
  SPELL_AURA_MOD_INVISIBILITY_DETECT,
  SPELL_AURA_MOD_PACIFY_SILENCE,
  SPELL_AURA_MOD_POSSESS,
  SPELL_AURA_MOD_POSSESS_PET,
  SPELL_AURA_MOD_POWER_REGEN,
  SPELL_AURA_MOD_RANGED_HASTE,
  SPELL_AURA_MOD_MELEE_HASTE,
  SPELL_AURA_MOD_MELEE_RANGED_HASTE,
  SPELL_AURA_MOD_REGEN,
  SPELL_AURA_MOD_ROOT,
  SPELL_AURA_MOD_SILENCE,
  SPELL_AURA_MOD_SKILL,
  SPELL_AURA_MOD_SPELL_CRIT_CHANCE,
  SPELL_AURA_MOD_STALKED,
  SPELL_AURA_MOD_STAT,
  SPELL_AURA_MOD_STEALTH,
  SPELL_AURA_MOD_STUN,
  SPELL_AURA_MOD_TAUNT,
  SPELL_AURA_OBS_MOD_HEALTH,
  SPELL_AURA_OBS_MOD_POWER,
  SPELL_AURA_OPEN_STABLE,
  SPELL_AURA_PERIODIC_DAMAGE,
  SPELL_AURA_PERIODIC_DAMAGE_PERCENT,
  SPELL_AURA_PERIODIC_DUMMY,
  SPELL_AURA_PERIODIC_HEAL,
  SPELL_AURA_PERIODIC_HEALTH_FUNNEL,
  SPELL_AURA_PERIODIC_LEECH,
  SPELL_AURA_PERIODIC_TRIGGER_SPELL,
  SPELL_AURA_PERIODIC_TRIGGER_SPELL_FROM_CLIENT,
  SPELL_AURA_PERIODIC_TRIGGER_SPELL_WITH_VALUE,
  SPELL_AURA_PREVENT_RESURRECTION,
  SPELL_AURA_SCHOOL_IMMUNITY,
  SPELL_AURA_STATE_IMMUNITY,
  SPELL_AURA_TRACK_CREATURES,
  SPELL_AURA_TRACK_RESOURCES,
  SPELL_AURA_TRACK_STEALTHED,
  SPELL_AURA_TRANSFORM,
  SPELL_AURA_WATER_BREATHING,
  SPELL_CAST_OK,
  SPELL_EFFECT_APPLY_AREA_AURA_ENEMY,
  SPELL_EFFECT_APPLY_AREA_AURA_FRIEND,
  SPELL_EFFECT_APPLY_AREA_AURA_OWNER,
  SPELL_EFFECT_APPLY_AREA_AURA_PARTY,
  SPELL_EFFECT_APPLY_AREA_AURA_PET,
  SPELL_EFFECT_APPLY_AREA_AURA_RAID,
  SPELL_EFFECT_APPLY_AURA,
  SPELL_EFFECT_ATTACK_ME,
  SPELL_EFFECT_CHARGE,
  SPELL_EFFECT_CHARGE_DEST,
  SPELL_EFFECT_CREATE_ITEM,
  SPELL_EFFECT_ENERGIZE,
  SPELL_EFFECT_ENERGIZE_PCT,
  SPELL_EFFECT_GAMEOBJECT_DAMAGE,
  SPELL_EFFECT_HEAL,
  SPELL_EFFECT_HEAL_MAX_HEALTH,
  SPELL_EFFECT_HEAL_MECHANICAL,
  SPELL_EFFECT_HEAL_PCT,
  SPELL_EFFECT_HEALTH_LEECH,
  SPELL_EFFECT_INTERRUPT_CAST,
  SPELL_EFFECT_JUMP,
  SPELL_EFFECT_JUMP_DEST,
  SPELL_EFFECT_KNOCK_BACK,
  SPELL_EFFECT_KNOCK_BACK_DEST,
  SPELL_EFFECT_LEAP_BACK,
  SPELL_EFFECT_LEARN_SPELL,
  SPELL_EFFECT_NORMALIZED_WEAPON_DMG,
  SPELL_EFFECT_PERSISTENT_AREA_AURA,
  SPELL_EFFECT_PICKPOCKET,
  SPELL_EFFECT_POWER_BURN,
  SPELL_EFFECT_POWER_DRAIN,
  SPELL_EFFECT_SCHOOL_DAMAGE,
  SPELL_EFFECT_SKILL_STEP,
  SPELL_EFFECT_TRIGGER_SPELL,
  SPELL_EFFECT_TRIGGER_SPELL_WITH_VALUE,
  SPELL_EFFECT_WEAPON_DAMAGE,
  SPELL_EFFECT_WEAPON_DAMAGE_NOSCHOOL,
  SPELL_EFFECT_WEAPON_PERCENT_DAMAGE,
  SPELL_FAILED_NOT_SHAPESHIFT,
  SPELL_FAILED_ONLY_SHAPESHIFT,
  TARGET_DEST_DYNOBJ_ENEMY,
  TARGET_DEST_TARGET_ENEMY,
  TARGET_UNIT_CASTER,
  TARGET_UNIT_CONE_ENEMY_104,
  TARGET_UNIT_CONE_ENEMY_24,
  TARGET_UNIT_CONE_ENEMY_54,
  TARGET_UNIT_DEST_AREA_ENEMY,
  TARGET_UNIT_NEARBY_ENEMY,
  TARGET_UNIT_SRC_AREA_ENEMY,
  TARGET_UNIT_TARGET_ENEMY,
  TARGET_DEST_TRAJ,
} from "./defines.ts";
import {
  AURA_INTERRUPT_FLAG_CAST,
  AURA_INTERRUPT_FLAG_NOT_SEATED,
  AURA_STATE_BANISHED,
  AURA_STATE_BLEEDING,
  AURA_STATE_CONFLAGRATE,
  AURA_STATE_DEADLY_POISON,
  AURA_STATE_ENRAGE,
  AURA_STATE_FAERIE_FIRE,
  AURA_STATE_FROZEN,
  AURA_STATE_JUDGEMENT,
  AURA_STATE_NONE,
  AURA_STATE_SWIFTMEND,
  AURA_STATE_UNKNOWN22,
  AURA_STATE_WARRIOR_VICTORY_RUSH,
  DISPEL_ALL,
  DISPEL_CURSE,
  DISPEL_DISEASE,
  DISPEL_MAGIC,
  DISPEL_ENRAGE,
  DISPEL_POISON,
  EFFECT_IMPLICIT_TARGET_EXPLICIT,
  MECHANIC_BANDAGE,
  MECHANIC_BANISH,
  MECHANIC_BLEED,
  MECHANIC_CHARM,
  MECHANIC_DISORIENTED,
  MECHANIC_FEAR,
  MECHANIC_FREEZE,
  MECHANIC_HORROR,
  MECHANIC_IMMUNE_SHIELD,
  MECHANIC_INVULNERABILITY,
  MECHANIC_MOUNT,
  MECHANIC_NONE,
  MECHANIC_POLYMORPH,
  MECHANIC_ROOT,
  MECHANIC_SAPPED,
  MECHANIC_SHIELD,
  MECHANIC_SILENCE,
  MECHANIC_SLEEP,
  MECHANIC_SNARE,
  MECHANIC_STUN,
  MECHANIC_TURN,
  POWER_HEALTH,
  POWER_MANA,
  SPELL_ATTR0_CU_AURA_CANNOT_BE_SAVED,
  SPELL_ATTR0_CU_AURA_CC,
  SPELL_ATTR0_CU_BINARY_SPELL,
  SPELL_ATTR0_CU_CHARGE,
  SPELL_ATTR0_CU_CONE_BACK,
  SPELL_ATTR0_CU_DIRECT_DAMAGE,
  SPELL_ATTR0_CU_DONT_BREAK_STEALTH,
  SPELL_ATTR0_CU_FORCE_AURA_SAVING,
  SPELL_ATTR0_CU_FORCE_SEND_CATEGORY_COOLDOWNS,
  SPELL_ATTR0_CU_NEEDS_AMMO_DATA,
  SPELL_ATTR0_CU_NEGATIVE,
  SPELL_ATTR0_CU_NEGATIVE_EFF0,
  SPELL_ATTR0_CU_NO_INITIAL_THREAT,
  SPELL_ATTR0_CU_NO_PVP_FLAG,
  SPELL_ATTR0_CU_PICKPOCKET,
  SPELL_ATTR0_CU_POSITIVE,
  SPELL_ATTR0_CU_POSITIVE_EFF0,
  SPELL_ATTR0_CU_SCHOOLMASK_NORMAL_WITH_MAGIC,
  SPELL_CATEGORY_FLAG_COOLDOWN_STARTS_ON_EVENT,
  SPELL_GROUP_STACK_RULE_EXCLUSIVE_SAME_EFFECT,
  SPELL_SCHOOL_MASK_FROST,
  SPELL_SCHOOL_MASK_MAGIC,
  SPELL_SCHOOL_MASK_NORMAL,
  SPELL_SPECIFIC_ASPECT,
  SPELL_SPECIFIC_AURA,
  SPELL_SPECIFIC_CHARM,
  SPELL_SPECIFIC_CURSE,
  SPELL_SPECIFIC_DRINK,
  SPELL_SPECIFIC_ELEMENTAL_SHIELD,
  SPELL_SPECIFIC_FOOD,
  SPELL_SPECIFIC_FOOD_AND_DRINK,
  SPELL_SPECIFIC_HAND,
  SPELL_SPECIFIC_JUDGEMENT,
  SPELL_SPECIFIC_MAGE_ARCANE_BRILLANCE,
  SPELL_SPECIFIC_MAGE_ARMOR,
  SPELL_SPECIFIC_MAGE_POLYMORPH,
  SPELL_SPECIFIC_NORMAL,
  SPELL_SPECIFIC_PRESENCE,
  SPELL_SPECIFIC_PRIEST_DIVINE_SPIRIT,
  SPELL_SPECIFIC_SCROLL,
  SPELL_SPECIFIC_SEAL,
  SPELL_SPECIFIC_STING,
  SPELL_SPECIFIC_TRACKER,
  SPELL_SPECIFIC_WARLOCK_ARMOR,
  SPELL_SPECIFIC_WARLOCK_CORRUPTION,
  SPELLFAMILY_DEATHKNIGHT,
  SPELLFAMILY_DRUID,
  SPELLFAMILY_GENERIC,
  SPELLFAMILY_HUNTER,
  SPELLFAMILY_MAGE,
  SPELLFAMILY_PALADIN,
  SPELLFAMILY_PRIEST,
  SPELLFAMILY_ROGUE,
  SPELLFAMILY_SHAMAN,
  SPELLFAMILY_WARLOCK,
  SPELLFAMILY_WARRIOR,
  SPELLMOD_COST,
  TARGET_DIR_BACK,
  TARGET_DIR_BACK_LEFT,
  TARGET_DIR_BACK_RIGHT,
  TARGET_DIR_FRONT,
  TARGET_DIR_FRONT_LEFT,
  TARGET_DIR_FRONT_RIGHT,
  TARGET_DIR_LEFT,
  TARGET_DIR_RANDOM,
  TARGET_DIR_RIGHT,
  TARGET_CHECK_ALLY,
  TARGET_CHECK_ENEMY,
  TARGET_CHECK_PARTY,
  TARGET_CHECK_PASSENGER,
  TARGET_CHECK_RAID,
  TARGET_FLAG_CORPSE_ALLY,
  TARGET_FLAG_CORPSE_ENEMY,
  TARGET_FLAG_CORPSE_MASK,
  TARGET_FLAG_DEST_LOCATION,
  TARGET_FLAG_GAMEOBJECT,
  TARGET_FLAG_GAMEOBJECT_ITEM,
  TARGET_FLAG_ITEM,
  TARGET_FLAG_NONE,
  TARGET_FLAG_SOURCE_LOCATION,
  TARGET_FLAG_UNIT,
  TARGET_FLAG_UNIT_ALLY,
  TARGET_FLAG_UNIT_DEAD,
  TARGET_FLAG_UNIT_ENEMY,
  TARGET_FLAG_UNIT_MASK,
  TARGET_FLAG_UNIT_PARTY,
  TARGET_FLAG_UNIT_PASSENGER,
  TARGET_FLAG_UNIT_RAID,
  TARGET_OBJECT_TYPE_CORPSE,
  TARGET_OBJECT_TYPE_CORPSE_ALLY,
  TARGET_OBJECT_TYPE_CORPSE_ENEMY,
  TARGET_OBJECT_TYPE_DEST,
  TARGET_OBJECT_TYPE_GOBJ,
  TARGET_OBJECT_TYPE_GOBJ_ITEM,
  TARGET_OBJECT_TYPE_ITEM,
  TARGET_OBJECT_TYPE_SRC,
  TARGET_OBJECT_TYPE_UNIT,
  TARGET_OBJECT_TYPE_UNIT_AND_DEST,
  TARGET_REFERENCE_TYPE_DEST,
  TARGET_REFERENCE_TYPE_SRC,
  TARGET_REFERENCE_TYPE_TARGET,
  TARGET_SELECT_CATEGORY_AREA,
  TARGET_SELECT_CATEGORY_CONE,
} from "./enums.ts";

export const MAX_SPELL_EFFECTS = 3;
const SHAPESHIFT_FLAG_STANCE = 0x00000001;
const SHAPESHIFT_FLAG_CAN_ONLY_CAST_SHAPESHIFT_SPELLS = 0x00000400;

/** `SpellEffectInfo` */
export type SpellEffectInfo = {
  index: number;
  effect: number;
  dieSides: number;
  realPointsPerLevel: number;
  basePoints: number;
  mechanic: number;
  targetA: number;
  targetB: number;
  radius: { min: number; perLevel: number; max: number } | null;
  applyAuraName: number;
  amplitude: number;
  valueMultiplier: number;
  chainTarget: number;
  itemType: number;
  miscValue: number;
  miscValueB: number;
  triggerSpell: number;
  pointsPerComboPoint: number;
  spellClassMask: [number, number, number];
  damageMultiplier: number;
  bonusMultiplier: number;
};

export type SpellRange = { id: number; minHostile: number; minFriend: number; maxHostile: number; maxFriend: number; flags: number };

/** `ImmunityInfo` per effect (`SpellInfo::_LoadImmunityInfo`). Mechanic masks go past bit 31, so they are bigints. */
export type ImmunityInfo = {
  schoolImmuneMask: number;
  applyHarmfulAuraImmuneMask: number;
  mechanicImmuneMask: bigint;
  dispelImmuneMask: number;
  damageSchoolMask: number;
  auraTypeImmune: ReadonlySet<number>;
  spellEffectImmune: ReadonlySet<number>;
};

/** `SpellInfo` (the `SpellEntry` fields the server reads, with the store lookups resolved and `SpellMgr`'s derived data). */
export type SpellInfo = {
  id: number;
  name: string;
  rank: string;
  category: number;
  categoryFlags: number;
  dispel: number;
  mechanic: number;
  attributes: [number, number, number, number, number, number, number, number];
  stances: number;
  stancesNot: number;
  targets: number;
  targetCreatureType: number;
  requiresSpellFocus: number;
  facingCasterFlags: number;
  casterAuraState: number;
  targetAuraState: number;
  casterAuraStateNot: number;
  targetAuraStateNot: number;
  casterAuraSpell: number;
  targetAuraSpell: number;
  excludeCasterAuraSpell: number;
  excludeTargetAuraSpell: number;
  /** `CastTimeEntry->CastTime`, 0 without an entry. */
  castTime: number;
  recoveryTime: number;
  categoryRecoveryTime: number;
  interruptFlags: number;
  auraInterruptFlags: number;
  channelInterruptFlags: number;
  procFlags: number;
  procChance: number;
  procCharges: number;
  maxLevel: number;
  baseLevel: number;
  spellLevel: number;
  duration: [number, number, number];
  /** `DurationEntry != nullptr` */
  durationEntry: boolean;
  /** Read as uint32 like `SpellInfo::PowerType`; health costs are `POWER_HEALTH` (0xFFFFFFFE). */
  powerType: number;
  manaCost: number;
  manaCostPerLevel: number;
  manaPerSecond: number;
  manaPerSecondPerLevel: number;
  range: SpellRange | null;
  speed: number;
  stackAmount: number;
  totem: [number, number];
  reagents: { item: number; count: number }[];
  equippedItemClass: number;
  equippedItemSubClassMask: number;
  equippedItemInventoryTypeMask: number;
  effects: [SpellEffectInfo, SpellEffectInfo, SpellEffectInfo];
  spellVisual: [number, number];
  spellIconId: number;
  activeIconId: number;
  manaCostPercentage: number;
  startRecoveryCategory: number;
  startRecoveryTime: number;
  maxTargetLevel: number;
  spellFamilyName: number;
  spellFamilyFlags: [number, number, number];
  maxAffectedTargets: number;
  dmgClass: number;
  preventionType: number;
  totemCategory: [number, number];
  areaGroupId: number;
  schoolMask: number;
  runeCostId: number;
  /** `AttributesCu` from `spell_custom_attr` and `SpellMgr::LoadSpellInfoCustomAttributes`. */
  attributesCu: number;
  /** `SPELL_ATTR0_CU_NEGATIVE_EFF0..2` without their positive overrides. */
  negativeEffectMask: number;
  explicitTargetMask: number;
  spellSpecific: number;
  auraState: number;
  immunity: [ImmunityInfo, ImmunityInfo, ImmunityInfo];
  /** `spell_jump_distance.JumpDistance` (0 when absent). */
  jumpDistance: number;
  /** Cooldown info must be sent even for creature casts (`_requireCooldownInfo`). */
  requireCooldownInfo: boolean;
};

export type ShapeshiftForm = { id: number; flags: number; creatureType: number; attackSpeed: number; modelAlliance: number; modelHorde: number; spells: number[] };

export function hasAttribute(info: SpellInfo, index: number, flag: number): boolean {
  return ((info.attributes[index] ?? 0) & flag) !== 0;
}

export function hasCustomAttribute(info: SpellInfo, flag: number): boolean {
  return (info.attributesCu & flag) !== 0;
}

export function isNextMeleeSwingSpell(info: SpellInfo): boolean {
  return hasAttribute(info, 0, SPELL_ATTR0_ON_NEXT_SWING_NO_DAMAGE);
}

export function isPassive(info: SpellInfo): boolean {
  return hasAttribute(info, 0, SPELL_ATTR0_PASSIVE);
}

export function isChanneled(info: SpellInfo): boolean {
  return ((info.attributes[1] ?? 0) & (SPELL_ATTR1_IS_CHANNELED | SPELL_ATTR1_IS_SELF_CHANNELED)) !== 0;
}

/** `SpellInfo::IsActionAllowedChannel` */
export function isActionAllowedChannel(info: SpellInfo): boolean {
  return isChanneled(info) && hasAttribute(info, 5, SPELL_ATTR5_ALLOW_ACTION_DURING_CHANNEL);
}

export function isAutoRepeat(info: SpellInfo): boolean {
  return hasAttribute(info, 2, SPELL_ATTR2_AUTO_REPEAT);
}

export function needsComboPoints(info: SpellInfo): boolean {
  return ((info.attributes[1] ?? 0) & (SPELL_ATTR1_FINISHING_MOVE_DAMAGE | SPELL_ATTR1_FINISHING_MOVE_DURATION)) !== 0;
}

export function canBeUsedInCombat(info: SpellInfo): boolean {
  return !hasAttribute(info, 0, SPELL_ATTR0_NOT_IN_COMBAT_ONLY_PEACEFUL);
}

/** `SpellInfo::IsBreakingStealth` */
export function isBreakingStealth(info: SpellInfo): boolean {
  return !hasAttribute(info, 1, SPELL_ATTR1_ALLOW_WHILE_STEALTHED);
}

/** `SpellInfo::IsPositive` */
export function isPositive(info: SpellInfo): boolean {
  return !(info.attributesCu & SPELL_ATTR0_CU_NEGATIVE) || (info.attributesCu & SPELL_ATTR0_CU_POSITIVE) !== 0;
}

/** `SpellInfo::IsPositiveEffect` */
export function isPositiveEffect(info: SpellInfo, index: number): boolean {
  const i = index >= 0 && index < MAX_SPELL_EFFECTS ? index : 0;
  return !(info.attributesCu & (SPELL_ATTR0_CU_NEGATIVE_EFF0 << i)) || (info.attributesCu & (SPELL_ATTR0_CU_POSITIVE_EFF0 << i)) !== 0;
}

export function hasEffect(info: SpellInfo, effect: number): boolean {
  return info.effects.some((row) => row.effect === effect);
}

/** `SpellInfo::HasAura` — `SpellEffectInfo::IsAura(aura)` on any effect. */
export function hasAura(info: SpellInfo, aura: number): boolean {
  return info.effects.some((row) => effectIsAura(row) && row.applyAuraName === aura);
}

/** `SpellInfo::HasAnyAura` */
export function hasAnyAura(info: SpellInfo): boolean {
  return info.effects.some(effectIsAura);
}

/** `SpellEffectInfo::IsUnitOwnedAuraEffect` by effect id (area auras and `APPLY_AURA`). */
export function isAuraEffect(effect: number): boolean {
  return effect === SPELL_EFFECT_APPLY_AURA || isAreaAuraEffect(effect);
}

/** `SpellEffectInfo::IsAreaAuraEffect` */
export function isAreaAuraEffect(effect: number): boolean {
  return (
    effect === SPELL_EFFECT_APPLY_AREA_AURA_PARTY ||
    effect === SPELL_EFFECT_APPLY_AREA_AURA_RAID ||
    effect === SPELL_EFFECT_APPLY_AREA_AURA_FRIEND ||
    effect === SPELL_EFFECT_APPLY_AREA_AURA_ENEMY ||
    effect === SPELL_EFFECT_APPLY_AREA_AURA_PET ||
    effect === SPELL_EFFECT_APPLY_AREA_AURA_OWNER
  );
}

/** `SpellEffectInfo::IsAura` */
export function effectIsAura(effect: SpellEffectInfo): boolean {
  return (isAuraEffect(effect.effect) || effect.effect === SPELL_EFFECT_PERSISTENT_AREA_AURA) && effect.applyAuraName !== 0;
}

/** `SpellEffectInfo::IsTargetingArea` */
export function effectIsTargetingArea(effect: SpellEffectInfo): boolean {
  return implicitTargetIsArea(effect.targetA) || implicitTargetIsArea(effect.targetB);
}

/** `SpellImplicitTargetInfo::IsArea` */
export function implicitTargetIsArea(target: number): boolean {
  const category = IMPLICIT_TARGETS[target]?.selectionCategory;
  return category === TARGET_SELECT_CATEGORY_AREA || category === TARGET_SELECT_CATEGORY_CONE;
}

/** `SpellInfo::IsAffectingArea` */
export function isAffectingArea(info: SpellInfo): boolean {
  return info.effects.some((effect) => effect.effect !== 0 && (effectIsTargetingArea(effect) || effect.effect === SPELL_EFFECT_PERSISTENT_AREA_AURA || isAreaAuraEffect(effect.effect)));
}

/** `SpellInfo::IsTargetingArea` */
export function isTargetingArea(info: SpellInfo): boolean {
  return info.effects.some((effect) => effect.effect !== 0 && effectIsTargetingArea(effect));
}

/** `SpellInfo::NeedsExplicitUnitTarget` */
export function needsExplicitUnitTarget(info: SpellInfo): boolean {
  return (info.explicitTargetMask & TARGET_FLAG_UNIT_MASK) !== 0;
}

/** `SpellInfo::IsSelfCast` */
export function isSelfCast(info: SpellInfo): boolean {
  return info.effects.every((effect) => !effect.effect || effect.targetA === TARGET_UNIT_CASTER);
}

/** `SpellInfo::IsRequiringDeadTarget` */
export function isRequiringDeadTarget(info: SpellInfo): boolean {
  return hasAttribute(info, 3, SPELL_ATTR3_ONLY_ON_GHOSTS);
}

/** `SpellInfo::IsAllowingDeadTarget` */
export function isAllowingDeadTarget(info: SpellInfo): boolean {
  return hasAttribute(info, 2, SPELL_ATTR2_ALLOW_DEAD_TARGET) || (info.targets & (TARGET_FLAG_CORPSE_ALLY | TARGET_FLAG_CORPSE_ENEMY | TARGET_FLAG_UNIT_DEAD)) !== 0;
}

/** `SpellInfo::IsDeathPersistent` */
export function isDeathPersistent(info: SpellInfo): boolean {
  return hasAttribute(info, 3, SPELL_ATTR3_ALLOW_AURA_WHILE_DEAD);
}

/** `SpellInfo::HasInitialAggro` */
export function hasInitialAggro(info: SpellInfo): boolean {
  return !(hasAttribute(info, 1, SPELL_ATTR1_NO_THREAT) || hasAttribute(info, 3, SPELL_ATTR3_SUPPRESS_TARGET_PROCS));
}

/** `SpellInfo::IsCooldownStartedOnEvent` */
export function isCooldownStartedOnEvent(info: SpellInfo): boolean {
  return hasAttribute(info, 0, SPELL_ATTR0_COOLDOWN_ON_EVENT) || (info.categoryFlags & SPELL_CATEGORY_FLAG_COOLDOWN_STARTS_ON_EVENT) !== 0;
}

/** `SpellInfo::IsSingleTarget` */
export function isSingleTarget(info: SpellInfo): boolean {
  return hasAttribute(info, 5, SPELL_ATTR5_LIMIT_N);
}

/** `SpellInfo::IsMultiSlotAura` */
export function isMultiSlotAura(info: SpellInfo): boolean {
  return isPassive(info) || info.id === 40075;
}

/** `SpellInfo::IsPassiveStackableWithRanks` */
export function isPassiveStackableWithRanks(info: SpellInfo): boolean {
  return isPassive(info) && !hasEffect(info, SPELL_EFFECT_APPLY_AURA);
}

/** `SpellInfo::CanDispelAura` */
export function canDispelAura(auraInfo: SpellInfo): boolean {
  return !isPassive(auraInfo) && !hasAttribute(auraInfo, 0, SPELL_ATTR0_NO_IMMUNITIES);
}

/** `SpellInfo::ComputeIsCritCapable` */
export function isCritCapable(info: SpellInfo): boolean {
  return info.effects.some((effect) => {
    switch (effect.effect) {
      case SPELL_EFFECT_SCHOOL_DAMAGE:
      case SPELL_EFFECT_HEALTH_LEECH:
      case SPELL_EFFECT_HEAL:
      case SPELL_EFFECT_WEAPON_DAMAGE_NOSCHOOL:
      case SPELL_EFFECT_WEAPON_PERCENT_DAMAGE:
      case SPELL_EFFECT_WEAPON_DAMAGE:
      case SPELL_EFFECT_POWER_BURN:
      case SPELL_EFFECT_HEAL_MECHANICAL:
      case SPELL_EFFECT_NORMALIZED_WEAPON_DMG:
      case SPELL_EFFECT_HEAL_PCT:
        return true;
      default:
        return false;
    }
  });
}

/** `SpellInfo::GetRecoveryTime` */
export function recoveryTimeOf(info: SpellInfo): number {
  return info.recoveryTime > info.categoryRecoveryTime ? info.recoveryTime : info.categoryRecoveryTime;
}

/** `DISPEL_ALL_MASK` */
export const DISPEL_ALL_MASK = (1 << DISPEL_MAGIC) | (1 << DISPEL_CURSE) | (1 << DISPEL_DISEASE) | (1 << DISPEL_POISON);

/** `SpellInfo::GetDispelMask(DispelType)` */
export function dispelMask(type: number): number {
  return type === DISPEL_ALL ? DISPEL_ALL_MASK : (1 << type) >>> 0;
}

/** `SpellInfo::GetAllEffectsMechanicMask` */
export function allEffectsMechanicMask(info: SpellInfo): bigint {
  let mask = info.mechanic ? 1n << BigInt(info.mechanic) : 0n;
  for (const effect of info.effects) {
    if (effect.effect && effect.mechanic) mask |= 1n << BigInt(effect.mechanic);
  }
  return mask;
}

/** `SpellInfo::GetEffectMechanicMask` */
export function effectMechanicMask(info: SpellInfo, index: number): bigint {
  let mask = info.mechanic ? 1n << BigInt(info.mechanic) : 0n;
  const effect = info.effects[index]!;
  if (effect.effect && effect.mechanic) mask |= 1n << BigInt(effect.mechanic);
  return mask;
}

/** `SpellInfo::GetSpellMechanicMaskByEffectMask` */
export function mechanicMaskByEffectMask(info: SpellInfo, effectMask: number): bigint {
  let mask = info.mechanic ? 1n << BigInt(info.mechanic) : 0n;
  for (const effect of info.effects) {
    if (effectMask & (1 << effect.index) && effect.mechanic) mask |= 1n << BigInt(effect.mechanic);
  }
  return mask;
}

/** `SpellInfo::GetEffectMechanic` */
export function effectMechanic(info: SpellInfo, index: number): number {
  const effect = info.effects[index]!;
  if (effect.effect && effect.mechanic) return effect.mechanic;
  return info.mechanic || MECHANIC_NONE;
}

/** `SpellInfo::GetMinRange` */
export function minRange(info: SpellInfo, positive: boolean): number {
  if (!info.range) return 0;
  return positive ? info.range.minFriend : info.range.minHostile;
}

/** `SpellInfo::GetMaxRange` (no spell mods). */
export function maxRange(info: SpellInfo, positive: boolean): number {
  if (!info.range) return 0;
  return positive ? info.range.maxFriend : info.range.maxHostile;
}

/** `SpellEffectInfo::CalcRadius` for a caster level (null when there is no caster). */
export function calcRadius(effect: SpellEffectInfo, casterLevel: number | null): number {
  if (!effect.radius) return 0;
  let radius = effect.radius.min;
  if (casterLevel !== null) {
    radius += effect.radius.perLevel * casterLevel;
    radius = Math.min(radius, effect.radius.max);
  }
  return radius;
}

/** `SpellImplicitTargetInfo::CalcDirectionAngle` */
export function directionAngle(target: number): number {
  switch (IMPLICIT_TARGETS[target]?.directionType) {
    case TARGET_DIR_FRONT:
      return 0;
    case TARGET_DIR_BACK:
      return Math.PI;
    case TARGET_DIR_RIGHT:
      return -Math.PI / 2;
    case TARGET_DIR_LEFT:
      return Math.PI / 2;
    case TARGET_DIR_FRONT_RIGHT:
      return -Math.PI / 4;
    case TARGET_DIR_BACK_RIGHT:
      return (-3 * Math.PI) / 4;
    case TARGET_DIR_BACK_LEFT:
      return (3 * Math.PI) / 4;
    case TARGET_DIR_FRONT_LEFT:
      return Math.PI / 4;
    case TARGET_DIR_RANDOM:
      return randNorm() * 2 * Math.PI;
    default:
      return 0;
  }
}

/** `GetTargetFlagMask` */
export function targetFlagMask(objectType: number): number {
  switch (objectType) {
    case TARGET_OBJECT_TYPE_DEST:
      return TARGET_FLAG_DEST_LOCATION;
    case TARGET_OBJECT_TYPE_UNIT_AND_DEST:
      return TARGET_FLAG_DEST_LOCATION | TARGET_FLAG_UNIT;
    case TARGET_OBJECT_TYPE_CORPSE_ALLY:
      return TARGET_FLAG_CORPSE_ALLY;
    case TARGET_OBJECT_TYPE_CORPSE_ENEMY:
      return TARGET_FLAG_CORPSE_ENEMY;
    case TARGET_OBJECT_TYPE_CORPSE:
      return TARGET_FLAG_CORPSE_ALLY | TARGET_FLAG_CORPSE_ENEMY;
    case TARGET_OBJECT_TYPE_UNIT:
      return TARGET_FLAG_UNIT;
    case TARGET_OBJECT_TYPE_GOBJ:
      return TARGET_FLAG_GAMEOBJECT;
    case TARGET_OBJECT_TYPE_GOBJ_ITEM:
      return TARGET_FLAG_GAMEOBJECT_ITEM;
    case TARGET_OBJECT_TYPE_ITEM:
      return TARGET_FLAG_ITEM;
    case TARGET_OBJECT_TYPE_SRC:
      return TARGET_FLAG_SOURCE_LOCATION;
    default:
      return TARGET_FLAG_NONE;
  }
}

/** `SpellImplicitTargetInfo::GetExplicitTargetMask`; `state` carries `srcSet` / `dstSet` across calls. */
export function implicitExplicitTargetMask(target: number, state: { srcSet: boolean; dstSet: boolean }): number {
  const data = IMPLICIT_TARGETS[target];
  if (!data) return 0;
  let mask = 0;
  if (target === TARGET_DEST_TRAJ) {
    if (!state.srcSet) mask = TARGET_FLAG_SOURCE_LOCATION;
    if (!state.dstSet) mask |= TARGET_FLAG_DEST_LOCATION;
  } else {
    switch (data.referenceType) {
      case TARGET_REFERENCE_TYPE_SRC:
        if (!state.srcSet) mask = TARGET_FLAG_SOURCE_LOCATION;
        break;
      case TARGET_REFERENCE_TYPE_DEST:
        if (!state.dstSet) mask = TARGET_FLAG_DEST_LOCATION;
        break;
      case TARGET_REFERENCE_TYPE_TARGET:
        switch (data.objectType) {
          case TARGET_OBJECT_TYPE_GOBJ:
            mask = TARGET_FLAG_GAMEOBJECT;
            break;
          case TARGET_OBJECT_TYPE_GOBJ_ITEM:
            mask = TARGET_FLAG_GAMEOBJECT_ITEM;
            break;
          case TARGET_OBJECT_TYPE_UNIT_AND_DEST:
          case TARGET_OBJECT_TYPE_UNIT:
          case TARGET_OBJECT_TYPE_DEST:
            switch (data.checkType) {
              case TARGET_CHECK_ENEMY:
                mask = TARGET_FLAG_UNIT_ENEMY;
                break;
              case TARGET_CHECK_ALLY:
                mask = TARGET_FLAG_UNIT_ALLY;
                break;
              case TARGET_CHECK_PARTY:
                mask = TARGET_FLAG_UNIT_PARTY;
                break;
              case TARGET_CHECK_RAID:
                mask = TARGET_FLAG_UNIT_RAID;
                break;
              case TARGET_CHECK_PASSENGER:
                mask = TARGET_FLAG_UNIT_PASSENGER;
                break;
              default:
                mask = TARGET_FLAG_UNIT;
                break;
            }
            break;
          default:
            break;
        }
        break;
      default:
        break;
    }
  }
  switch (data.objectType) {
    case TARGET_OBJECT_TYPE_SRC:
      state.srcSet = true;
      break;
    case TARGET_OBJECT_TYPE_DEST:
    case TARGET_OBJECT_TYPE_UNIT_AND_DEST:
      state.dstSet = true;
      break;
    default:
      break;
  }
  return mask;
}

/** `SpellEffectInfo::GetProvidedTargetMask` */
export function providedTargetMask(effect: SpellEffectInfo): number {
  return targetFlagMask(IMPLICIT_TARGETS[effect.targetA]?.objectType ?? 0) | targetFlagMask(IMPLICIT_TARGETS[effect.targetB]?.objectType ?? 0);
}

/** `SpellEffectInfo::GetMissingTargetMask` */
export function missingTargetMask(effect: SpellEffectInfo, srcSet = false, dstSet = false, extra = 0): number {
  let implicitMask = targetFlagMask(EFFECT_TARGETS[effect.effect]?.usedTargetObjectType ?? 0);
  const provided = providedTargetMask(effect) | extra;
  if (provided & TARGET_FLAG_UNIT_MASK) implicitMask &= ~TARGET_FLAG_UNIT_MASK;
  if (provided & TARGET_FLAG_CORPSE_MASK) implicitMask &= ~(TARGET_FLAG_UNIT_MASK | TARGET_FLAG_CORPSE_MASK);
  if (provided & TARGET_FLAG_GAMEOBJECT_ITEM) implicitMask &= ~(TARGET_FLAG_GAMEOBJECT_ITEM | TARGET_FLAG_GAMEOBJECT | TARGET_FLAG_ITEM);
  if (provided & TARGET_FLAG_GAMEOBJECT) implicitMask &= ~(TARGET_FLAG_GAMEOBJECT | TARGET_FLAG_GAMEOBJECT_ITEM);
  if (provided & TARGET_FLAG_ITEM) implicitMask &= ~(TARGET_FLAG_ITEM | TARGET_FLAG_GAMEOBJECT_ITEM);
  if (dstSet || provided & TARGET_FLAG_DEST_LOCATION) implicitMask &= ~TARGET_FLAG_DEST_LOCATION;
  if (srcSet || provided & TARGET_FLAG_SOURCE_LOCATION) implicitMask &= ~TARGET_FLAG_SOURCE_LOCATION;
  return implicitMask >>> 0;
}

/** `SpellInfo::_InitializeExplicitTargetMask` */
function explicitTargetMaskOf(info: Omit<SpellInfo, "explicitTargetMask" | "negativeEffectMask" | "attributesCu" | "spellSpecific" | "auraState" | "immunity" | "jumpDistance" | "requireCooldownInfo">): number {
  const state = { srcSet: false, dstSet: false };
  let mask = info.targets;
  const noRange = !info.range || (info.range.maxFriend === 0 && info.range.maxHostile === 0);
  for (const effect of info.effects) {
    if (!effect.effect) continue;
    mask |= implicitExplicitTargetMask(effect.targetA, state);
    mask |= implicitExplicitTargetMask(effect.targetB, state);
    if (EFFECT_TARGETS[effect.effect]?.implicitTargetType !== EFFECT_IMPLICIT_TARGET_EXPLICIT) continue;
    let effectMask = missingTargetMask(effect, state.srcSet, state.dstSet, mask);
    if (noRange) effectMask &= ~(TARGET_FLAG_UNIT_MASK | TARGET_FLAG_GAMEOBJECT | TARGET_FLAG_CORPSE_MASK | TARGET_FLAG_DEST_LOCATION);
    mask |= effectMask;
  }
  return mask >>> 0;
}

/** `SpellInfo::GetDuration` */
export function spellDuration(info: SpellInfo): number {
  const base = info.duration[0];
  return base === -1 ? -1 : Math.abs(base);
}

/** `SpellInfo::GetMaxDuration` */
export function spellMaxDuration(info: SpellInfo): number {
  const max = info.duration[2];
  return max === -1 ? -1 : Math.abs(max);
}

/** `SpellInfo::GetMaxTicks` */
export function maxTicks(info: SpellInfo): number {
  let dotDuration = spellDuration(info);
  if (dotDuration === 0) return 1;
  if (dotDuration > 30000) dotDuration = 30000;
  for (const effect of info.effects) {
    if (effect.effect !== SPELL_EFFECT_APPLY_AURA) continue;
    switch (effect.applyAuraName) {
      case SPELL_AURA_PERIODIC_DAMAGE:
      case SPELL_AURA_PERIODIC_HEAL:
      case SPELL_AURA_PERIODIC_LEECH:
      case SPELL_AURA_PERIODIC_TRIGGER_SPELL_FROM_CLIENT:
        if (effect.amplitude !== 0) return Math.trunc(dotDuration / effect.amplitude);
        break;
      default:
        break;
    }
  }
  return 6;
}

/** `WorldObject::CalcSpellDuration`: combo points stretch the duration from `Duration[0]` toward `Duration[2]`. */
export function calcSpellDuration(info: SpellInfo, comboPoints = 0): number {
  const minDuration = spellDuration(info);
  const maxDuration = spellMaxDuration(info);
  if (comboPoints && minDuration !== -1 && minDuration !== maxDuration) {
    return minDuration + Math.trunc(((maxDuration - minDuration) * comboPoints) / 5);
  }
  return minDuration;
}

/** `SpellInfo::CalcCastTime` with `UNIT_MOD_CAST_SPEED` already resolved into `castSpeed` by `ModSpellCastTime`. */
export function calcCastTime(info: SpellInfo, castSpeed = 1): number {
  let time = info.castTime;
  if (hasAttribute(info, 0, SPELL_ATTR0_USES_RANGED_SLOT) && !isAutoRepeat(info)) {
    time += 500;
  }
  if (time > 0 && castSpeed !== 1 && !hasAttribute(info, 0, SPELL_ATTR0_IS_ABILITY) && !hasAttribute(info, 0, SPELL_ATTR0_IS_TRADESKILL)) {
    time = Math.trunc(time * castSpeed);
  }
  return time > 0 ? time : 0;
}

/**
 * `SpellEffectInfo::CalcValue` for a caster level (no spell mods). `comboPoints` adds `PointsPerComboPoint`;
 * `basePointsOverride` is `SpellValue::EffectBasePoints`.
 */
export function calcEffectValue(
  info: SpellInfo,
  effect: SpellEffectInfo,
  casterLevel: number | null,
  comboPoints = 0,
  roll: (min: number, max: number) => number = irand,
  basePointsOverride?: number,
): number {
  let basePoints = basePointsOverride ?? effect.basePoints;
  if (casterLevel !== null && effect.realPointsPerLevel !== 0) {
    let level = casterLevel;
    if (level > info.maxLevel && info.maxLevel > 0) {
      level = info.maxLevel;
    } else if (level < info.baseLevel) {
      level = info.baseLevel;
    }
    level -= Math.max(info.baseLevel, info.spellLevel);
    basePoints += Math.trunc(level * effect.realPointsPerLevel);
  }
  const randomPoints = effect.dieSides;
  if (randomPoints === 1) {
    basePoints += 1;
  } else if (randomPoints !== 0) {
    basePoints += randomPoints >= 1 ? roll(1, randomPoints) : roll(randomPoints, 1);
  }
  let value = Math.fround(basePoints);
  if (comboPoints) {
    value = Math.fround(value + effect.pointsPerComboPoint * comboPoints);
  }
  return Math.trunc(value);
}

/** `SpellEffectInfo::CalcBaseValue` */
export function calcBaseValue(effect: SpellEffectInfo, value: number): number {
  return effect.dieSides === 0 ? value : value - 1;
}

/** `SpellInfo::CheckShapeshift` */
export function checkShapeshift(info: SpellInfo, form: number, shapeshift: (form: number) => ShapeshiftForm | null, talentLearner = false): number {
  if (talentLearner) {
    return SPELL_CAST_OK;
  }
  const stanceMask = form ? 1 << (form - 1) : 0;
  if (stanceMask & info.stancesNot) {
    return SPELL_FAILED_NOT_SHAPESHIFT;
  }
  if (stanceMask & info.stances) {
    return SPELL_CAST_OK;
  }
  let actAsShifted = false;
  let shape: ShapeshiftForm | null = null;
  if (form > 0) {
    shape = shapeshift(form);
    if (!shape) {
      return SPELL_CAST_OK;
    }
    actAsShifted = (shape.flags & SHAPESHIFT_FLAG_STANCE) === 0;
  }
  if (actAsShifted) {
    if (hasAttribute(info, 0, SPELL_ATTR0_NOT_SHAPESHIFTED)) {
      return SPELL_FAILED_NOT_SHAPESHIFT;
    }
    if (info.stances !== 0) {
      return SPELL_FAILED_ONLY_SHAPESHIFT;
    }
  } else if (!hasAttribute(info, 2, SPELL_ATTR2_ALLOW_WHILE_NOT_SHAPESHIFTED) && info.stances !== 0) {
    return SPELL_FAILED_ONLY_SHAPESHIFT;
  }
  if (shape && shape.flags & SHAPESHIFT_FLAG_CAN_ONLY_CAST_SHAPESHIFT_SPELLS && !(stanceMask & info.stances)) {
    return SPELL_FAILED_ONLY_SHAPESHIFT;
  }
  return SPELL_CAST_OK;
}

/** `SpellInfo::IsAuraExclusiveBySpecificWith` */
export function isAuraExclusiveBySpecificWith(left: SpellInfo, right: SpellInfo): boolean {
  const spec1 = left.spellSpecific;
  const spec2 = right.spellSpecific;
  switch (spec1) {
    case SPELL_SPECIFIC_TRACKER:
    case SPELL_SPECIFIC_WARLOCK_ARMOR:
    case SPELL_SPECIFIC_MAGE_ARMOR:
    case SPELL_SPECIFIC_ELEMENTAL_SHIELD:
    case SPELL_SPECIFIC_MAGE_POLYMORPH:
    case SPELL_SPECIFIC_PRESENCE:
    case SPELL_SPECIFIC_CHARM:
    case SPELL_SPECIFIC_SCROLL:
    case SPELL_SPECIFIC_MAGE_ARCANE_BRILLANCE:
    case SPELL_SPECIFIC_PRIEST_DIVINE_SPIRIT:
      return spec1 === spec2;
    case SPELL_SPECIFIC_FOOD:
      return spec2 === SPELL_SPECIFIC_FOOD || spec2 === SPELL_SPECIFIC_FOOD_AND_DRINK;
    case SPELL_SPECIFIC_DRINK:
      return spec2 === SPELL_SPECIFIC_DRINK || spec2 === SPELL_SPECIFIC_FOOD_AND_DRINK;
    case SPELL_SPECIFIC_FOOD_AND_DRINK:
      return spec2 === SPELL_SPECIFIC_FOOD || spec2 === SPELL_SPECIFIC_DRINK || spec2 === SPELL_SPECIFIC_FOOD_AND_DRINK;
    default:
      return false;
  }
}

/** `SpellInfo::IsAuraExclusiveBySpecificPerCasterWith` */
export function isAuraExclusiveBySpecificPerCasterWith(left: SpellInfo, right: SpellInfo): boolean {
  switch (left.spellSpecific) {
    case SPELL_SPECIFIC_SEAL:
    case SPELL_SPECIFIC_HAND:
    case SPELL_SPECIFIC_AURA:
    case SPELL_SPECIFIC_STING:
    case SPELL_SPECIFIC_CURSE:
    case SPELL_SPECIFIC_ASPECT:
    case SPELL_SPECIFIC_JUDGEMENT:
    case SPELL_SPECIFIC_WARLOCK_CORRUPTION:
      return left.spellSpecific === right.spellSpecific;
    default:
      return false;
  }
}

/** `SpellInfo::IsAuraEffectEqual` */
export function isAuraEffectEqual(left: SpellInfo, right: SpellInfo): boolean {
  let matchCount = 0;
  let auraCount = 0;
  for (const effect of left.effects) {
    if (!effectIsAura(effect)) continue;
    const found = right.effects.some((other) => effectIsAura(other) && other.applyAuraName === effect.applyAuraName && other.miscValue === effect.miscValue);
    if (!found) return false;
    matchCount++;
  }
  for (let i = 0; i < MAX_SPELL_EFFECTS; i++) {
    if (effectIsAura(left.effects[i]!)) auraCount++;
    if (effectIsAura(right.effects[i]!)) auraCount++;
  }
  return matchCount * 2 === auraCount;
}

/** `SpellInfo::CanSpellProvideImmunityAgainstAura` */
export function canSpellProvideImmunityAgainstAura(info: SpellInfo, auraInfo: SpellInfo): boolean {
  for (const effect of info.effects) {
    if (!effect.effect) continue;
    const immune = info.immunity[effect.index]!;
    if (!hasAttribute(auraInfo, 2, 0x00000100 /* SPELL_ATTR2_NO_SCHOOL_IMMUNITIES */)) {
      if (immune.schoolImmuneMask && (auraInfo.schoolMask & immune.schoolImmuneMask) !== 0) return true;
    }
    if (immune.mechanicImmuneMask && (immune.mechanicImmuneMask & (1n << BigInt(auraInfo.mechanic))) !== 0n) return true;
    if (immune.dispelImmuneMask && auraInfo.dispel === immune.dispelImmuneMask) return true;
    let immuneToAllEffects = true;
    for (const auraEffect of auraInfo.effects) {
      if (!auraEffect.effect) continue;
      if (!immune.spellEffectImmune.has(auraEffect.effect)) {
        immuneToAllEffects = false;
        break;
      }
      if (auraEffect.mechanic && !(immune.mechanicImmuneMask & (1n << BigInt(auraEffect.mechanic)))) {
        immuneToAllEffects = false;
        break;
      }
      if (auraEffect.applyAuraName) {
        let immuneToApply = immune.auraTypeImmune.has(auraEffect.applyAuraName);
        if (!immuneToApply && !isPositiveEffect(auraInfo, auraEffect.index) && !hasAttribute(auraInfo, 2, 0x00000100)) {
          if (immune.applyHarmfulAuraImmuneMask && (auraInfo.schoolMask & immune.applyHarmfulAuraImmuneMask) !== 0) immuneToApply = true;
        }
        if (!immuneToApply) {
          immuneToAllEffects = false;
          break;
        }
      }
    }
    if (immuneToAllEffects) return true;
  }
  return false;
}

const NEGATIVE_TARGETS = new Set([
  TARGET_UNIT_NEARBY_ENEMY,
  TARGET_UNIT_TARGET_ENEMY,
  TARGET_UNIT_SRC_AREA_ENEMY,
  TARGET_UNIT_DEST_AREA_ENEMY,
  TARGET_UNIT_CONE_ENEMY_24,
  TARGET_UNIT_CONE_ENEMY_54,
  TARGET_UNIT_CONE_ENEMY_104,
  TARGET_DEST_DYNOBJ_ENEMY,
  TARGET_DEST_TARGET_ENEMY,
]);

/** `SpellInfo::_IsPositiveTarget` */
export function isPositiveTarget(targetA: number, targetB: number): boolean {
  if (NEGATIVE_TARGETS.has(targetA)) {
    return false;
  }
  return targetB ? isPositiveTarget(targetB, 0) : true;
}

type RawSpellInfo = Omit<SpellInfo, "negativeEffectMask" | "attributesCu" | "explicitTargetMask" | "spellSpecific" | "auraState" | "immunity" | "jumpDistance" | "requireCooldownInfo">;
type PositivityLookup = (id: number) => RawSpellInfo | null;

/** `SpellInfo::_IsPositiveEffect`. Effect values use the lowest die roll, where the C++ rolls without a caster. */
export function isPositiveEffectRaw(info: RawSpellInfo, index: number, deep: boolean, lookup: PositivityLookup): boolean {
  if ((info.attributes[0] & SPELL_ATTR0_AURA_IS_DEBUFF) !== 0) {
    return false;
  }
  if (info.mechanic === MECHANIC_IMMUNE_SHIELD) {
    return true;
  }
  for (const row of info.effects) {
    if (effectIsAura(row) && row.applyAuraName === SPELL_AURA_MOD_STEALTH) {
      return true;
    }
  }
  const effect = info.effects[index]!;
  const value = (): number => calcEffectValue(info as SpellInfo, effect, null, 0, (min) => min);
  switch (effect.effect) {
    case SPELL_EFFECT_HEAL:
    case SPELL_EFFECT_LEARN_SPELL:
    case SPELL_EFFECT_SKILL_STEP:
    case SPELL_EFFECT_HEAL_PCT:
    case SPELL_EFFECT_ENERGIZE_PCT:
      return true;
    case SPELL_EFFECT_APPLY_AREA_AURA_ENEMY:
    case SPELL_EFFECT_GAMEOBJECT_DAMAGE:
      return false;
    case SPELL_EFFECT_SCHOOL_DAMAGE:
      // The C++ loop inspects `Effects[effIndex]` on every pass, so school damage is always negative.
      return false;
    case SPELL_EFFECT_KNOCK_BACK:
    case SPELL_EFFECT_KNOCK_BACK_DEST:
      break;
    case SPELL_EFFECT_APPLY_AURA:
    case SPELL_EFFECT_APPLY_AREA_AURA_FRIEND:
      switch (effect.applyAuraName) {
        case SPELL_AURA_MOD_DAMAGE_DONE:
        case SPELL_AURA_MOD_STAT:
        case SPELL_AURA_MOD_SKILL:
        case SPELL_AURA_MOD_DODGE_PERCENT:
        case SPELL_AURA_MOD_HEALING_PCT:
        case SPELL_AURA_MOD_HEALING_DONE:
        case SPELL_AURA_MOD_DAMAGE_PERCENT_DONE:
          if (value() < 0) return false;
          break;
        case SPELL_AURA_MOD_DAMAGE_TAKEN:
          if (value() > 0) return false;
          break;
        case SPELL_AURA_MOD_CRIT_PCT:
        case SPELL_AURA_MOD_SPELL_CRIT_CHANCE:
          if (value() > 0) return true;
          break;
        case SPELL_AURA_ADD_TARGET_TRIGGER:
          return true;
        case SPELL_AURA_PERIODIC_TRIGGER_SPELL_WITH_VALUE:
        case SPELL_AURA_PERIODIC_TRIGGER_SPELL_FROM_CLIENT:
        case SPELL_AURA_PERIODIC_TRIGGER_SPELL:
          if (!deep) {
            const triggered = lookup(effect.triggerSpell);
            if (triggered) {
              for (let i = 0; i < MAX_SPELL_EFFECTS; i++) {
                const other = triggered.effects[i]!;
                if (!other.effect) continue;
                if (isPositiveTarget(other.targetA, other.targetB) && !isPositiveEffectRaw(triggered, i, true, lookup)) {
                  return false;
                }
              }
            }
          }
          break;
        case SPELL_AURA_MOD_STUN:
          if (index === 0 && info.effects[1]!.effect === 0 && info.effects[2]!.effect === 0) return false;
          break;
        case SPELL_AURA_MOD_PACIFY_SILENCE:
          return info.id === 24740;
        case SPELL_AURA_MOD_ROOT:
        case SPELL_AURA_MOD_FEAR:
        case SPELL_AURA_MOD_SILENCE:
        case SPELL_AURA_GHOST:
        case SPELL_AURA_PERIODIC_LEECH:
        case SPELL_AURA_MOD_STALKED:
        case SPELL_AURA_PERIODIC_DAMAGE_PERCENT:
        case SPELL_AURA_PREVENT_RESURRECTION:
          return false;
        case SPELL_AURA_PERIODIC_DAMAGE:
          if (effect.targetA === TARGET_UNIT_CASTER) return false;
          break;
        case SPELL_AURA_MOD_DECREASE_SPEED:
          if (effect.targetA !== TARGET_UNIT_CASTER) return false;
          if ((info.attributes[0] & SPELL_ATTR0_AURA_IS_DEBUFF) !== 0 && index === 0) return false;
          break;
        case SPELL_AURA_MECHANIC_IMMUNITY:
          switch (effect.miscValue) {
            case MECHANIC_BANDAGE:
            case MECHANIC_SHIELD:
            case MECHANIC_MOUNT:
            case MECHANIC_INVULNERABILITY:
              return false;
            default:
              break;
          }
          break;
        case SPELL_AURA_ADD_FLAT_MODIFIER:
        case SPELL_AURA_ADD_PCT_MODIFIER:
          if (effect.miscValue === SPELLMOD_COST && value() > 0 && !deep) {
            let negative = true;
            for (let i = 0; i < MAX_SPELL_EFFECTS; i++) {
              if (i !== index && isPositiveEffectRaw(info, i, true, lookup)) {
                negative = false;
                break;
              }
            }
            if (negative) return false;
          }
          break;
        default:
          break;
      }
      break;
    default:
      break;
  }
  if (!isPositiveTarget(effect.targetA, effect.targetB)) {
    return false;
  }
  if (!deep && !effect.applyAuraName && effect.triggerSpell) {
    const triggered = lookup(effect.triggerSpell);
    if (triggered) {
      for (let i = 0; i < MAX_SPELL_EFFECTS; i++) {
        if (!isPositiveEffectRaw(triggered, i, true, lookup)) {
          return false;
        }
      }
    }
  }
  return true;
}

const LOSS_OF_CONTROL_MECHANICS =
  (1n << BigInt(MECHANIC_SNARE)) | (1n << BigInt(MECHANIC_ROOT)) | (1n << BigInt(MECHANIC_FEAR)) | (1n << BigInt(MECHANIC_STUN)) |
  (1n << BigInt(MECHANIC_SLEEP)) | (1n << BigInt(MECHANIC_CHARM)) | (1n << BigInt(MECHANIC_SAPPED)) | (1n << BigInt(MECHANIC_HORROR)) |
  (1n << BigInt(MECHANIC_POLYMORPH)) | (1n << BigInt(MECHANIC_DISORIENTED)) | (1n << BigInt(MECHANIC_FREEZE)) | (1n << BigInt(MECHANIC_TURN));

/** `IMMUNE_TO_MOVEMENT_IMPAIRMENT_AND_LOSS_CONTROL_MASK` */
export const IMMUNE_TO_MOVEMENT_IMPAIRMENT_AND_LOSS_CONTROL_MASK =
  (1n << BigInt(MECHANIC_CHARM)) | (1n << BigInt(MECHANIC_DISORIENTED)) | (1n << BigInt(MECHANIC_FEAR)) | (1n << BigInt(MECHANIC_ROOT)) |
  (1n << BigInt(MECHANIC_SLEEP)) | (1n << BigInt(MECHANIC_SNARE)) | (1n << BigInt(MECHANIC_STUN)) | (1n << BigInt(MECHANIC_FREEZE)) |
  (1n << BigInt(MECHANIC_SILENCE)) | (1n << BigInt(MECHANIC_HORROR)) | (1n << BigInt(MECHANIC_TURN)) | (1n << BigInt(MECHANIC_SAPPED)) |
  (1n << BigInt(MECHANIC_POLYMORPH));

const LOSS_OF_CONTROL_AURAS = [SPELL_AURA_MOD_STUN, SPELL_AURA_MOD_DECREASE_SPEED, SPELL_AURA_MOD_ROOT, SPELL_AURA_MOD_CONFUSE, SPELL_AURA_MOD_FEAR];

/** `SpellInfo::_LoadImmunityInfo` for one effect. */
function immunityInfoOf(info: RawSpellInfo, effect: SpellEffectInfo): ImmunityInfo {
  let schoolImmuneMask = 0;
  let applyHarmfulAuraImmuneMask = 0;
  let mechanicImmuneMask = 0n;
  let dispelImmuneMask = 0;
  let damageSchoolMask = 0;
  const auraTypeImmune = new Set<number>();
  const spellEffectImmune = new Set<number>();
  if (!effect.effect) {
    return { schoolImmuneMask, applyHarmfulAuraImmuneMask, mechanicImmuneMask, dispelImmuneMask, damageSchoolMask, auraTypeImmune, spellEffectImmune };
  }
  const miscVal = effect.miscValue;
  const amount = calcEffectValue(info as SpellInfo, effect, null, 0, (min) => min);
  const lossOfControl = (): void => {
    mechanicImmuneMask |= LOSS_OF_CONTROL_MECHANICS;
    for (const aura of LOSS_OF_CONTROL_AURAS) auraTypeImmune.add(aura);
  };
  switch (effect.applyAuraName) {
    case SPELL_AURA_MECHANIC_IMMUNITY_MASK:
      switch (miscVal) {
        case 27:
          mechanicImmuneMask |= 1n << BigInt(MECHANIC_SILENCE);
          auraTypeImmune.add(SPELL_AURA_MOD_SILENCE);
          break;
        case 96:
        case 1615:
          if (amount) lossOfControl();
          break;
        case 679:
          if (info.id === 57742) lossOfControl();
          break;
        case 1557:
          if (info.id === 64187) {
            mechanicImmuneMask |= 1n << BigInt(MECHANIC_STUN);
            auraTypeImmune.add(SPELL_AURA_MOD_STUN);
          } else {
            lossOfControl();
          }
          break;
        case 1614:
        case 1694:
          spellEffectImmune.add(SPELL_EFFECT_ATTACK_ME);
          auraTypeImmune.add(SPELL_AURA_MOD_TAUNT);
          break;
        case 1630:
          if (info.id === 64112) {
            spellEffectImmune.add(SPELL_EFFECT_ATTACK_ME);
            auraTypeImmune.add(SPELL_AURA_MOD_TAUNT);
          } else {
            lossOfControl();
          }
          break;
        case 477:
        case 1733:
          if (!amount) {
            lossOfControl();
            spellEffectImmune.add(SPELL_EFFECT_KNOCK_BACK);
            spellEffectImmune.add(SPELL_EFFECT_KNOCK_BACK_DEST);
          }
          break;
        case 878:
          if (info.id === 66092) {
            mechanicImmuneMask |= (1n << BigInt(MECHANIC_SNARE)) | (1n << BigInt(MECHANIC_STUN)) | (1n << BigInt(MECHANIC_DISORIENTED)) | (1n << BigInt(MECHANIC_FREEZE));
            auraTypeImmune.add(SPELL_AURA_MOD_STUN);
            auraTypeImmune.add(SPELL_AURA_MOD_DECREASE_SPEED);
          }
          break;
        default:
          break;
      }
      if (auraTypeImmune.size === 0) {
        if (miscVal & (1 << 10)) auraTypeImmune.add(SPELL_AURA_MOD_STUN);
        if (miscVal & (1 << 1)) auraTypeImmune.add(SPELL_AURA_TRANSFORM);
        if (miscVal & (1 << 6)) auraTypeImmune.add(SPELL_AURA_MOD_DECREASE_SPEED);
        if (miscVal & (1 << 0)) auraTypeImmune.add(SPELL_AURA_MOD_ROOT);
        if (miscVal & (1 << 2)) auraTypeImmune.add(SPELL_AURA_MOD_CONFUSE);
        if (miscVal & (1 << 9)) auraTypeImmune.add(SPELL_AURA_MOD_FEAR);
        if (miscVal & (1 << 7)) auraTypeImmune.add(SPELL_AURA_MOD_DISARM);
      }
      break;
    case SPELL_AURA_MECHANIC_IMMUNITY:
      switch (info.id) {
        case 34471:
        case 19574:
        case 42292:
        case 46227:
        case 59752:
        case 53490:
        case 65547:
        case 134946:
        case 134956:
        case 195710:
        case 208683:
          mechanicImmuneMask |= IMMUNE_TO_MOVEMENT_IMPAIRMENT_AND_LOSS_CONTROL_MASK;
          break;
        case 54508:
          mechanicImmuneMask |= (1n << BigInt(MECHANIC_SNARE)) | (1n << BigInt(MECHANIC_ROOT)) | (1n << BigInt(MECHANIC_STUN));
          break;
        default:
          if (miscVal >= 1) mechanicImmuneMask |= 1n << BigInt(miscVal);
          break;
      }
      break;
    case SPELL_AURA_EFFECT_IMMUNITY:
      spellEffectImmune.add(miscVal);
      break;
    case SPELL_AURA_STATE_IMMUNITY:
      auraTypeImmune.add(miscVal);
      break;
    case SPELL_AURA_SCHOOL_IMMUNITY:
      schoolImmuneMask |= miscVal >>> 0;
      break;
    case SPELL_AURA_MOD_IMMUNE_AURA_APPLY_SCHOOL:
      applyHarmfulAuraImmuneMask |= miscVal >>> 0;
      break;
    case SPELL_AURA_DAMAGE_IMMUNITY:
      damageSchoolMask |= miscVal >>> 0;
      break;
    case SPELL_AURA_DISPEL_IMMUNITY:
      dispelImmuneMask = miscVal >>> 0;
      break;
    default:
      break;
  }
  return { schoolImmuneMask: schoolImmuneMask >>> 0, applyHarmfulAuraImmuneMask: applyHarmfulAuraImmuneMask >>> 0, mechanicImmuneMask, dispelImmuneMask, damageSchoolMask: damageSchoolMask >>> 0, auraTypeImmune, spellEffectImmune };
}

/** `sSpellMgr` / `sSpellStore` and the DBC stores the spell code reads, from `data/dbc` plus the world `*_dbc` tables. */
export class SpellStore {
  readonly worldData: SpellWorldData;
  private readonly spells: DbcTable;
  private readonly castTimes: DbcTable;
  private readonly durations: DbcTable;
  private readonly ranges: DbcTable;
  private readonly radii: DbcTable;
  private readonly categories: DbcTable;
  private readonly shapeshifts: DbcTable;
  private readonly visuals: DbcTable;
  private readonly cache = new Map<number, SpellInfo | null>();
  private readonly rawCache = new Map<number, RawSpellInfo | null>();
  private readonly bonus = new Map<number, { direct: number; dot: number; ap: number; apDot: number }>();
  private readonly cooldownOverrides = new Map<number, { recoveryTime: number; categoryRecoveryTime: number; startRecoveryTime: number; startRecoveryCategory: number }>();
  private readonly customAttributes = new Map<number, number>();
  private readonly jumpDistances = new Map<number, number>();
  private readonly threats = new Map<number, { flatMod: number; pctMod: number; apPctMod: number }>();
  private readonly cones = new Map<number, number>();
  private readonly sameEffectAuras = new Map<number, ReadonlySet<number>>();
  private readonly procCharges = new Map<number, number>();
  private readonly classLevelStats = new Map<string, { baseHealth: [number, number, number]; baseDamage: [number, number, number] }>();
  private readonly immunities = new Map<number, CreatureImmunities>();
  private readonly templateImmunities = new Map<number, number>();

  constructor(tables: {
    spells: DbcTable;
    castTimes: DbcTable;
    durations: DbcTable;
    ranges: DbcTable;
    radii: DbcTable;
    categories: DbcTable;
    shapeshifts: DbcTable;
    visuals?: DbcTable;
    bonus?: Iterable<{ entry: number; direct: number; dot: number; ap: number; apDot: number }>;
    cooldownOverrides?: Iterable<{ Id: number; RecoveryTime: number; CategoryRecoveryTime: number; StartRecoveryTime: number; StartRecoveryCategory: number }>;
    worldData?: SpellWorldData;
    classLevelStats?: Iterable<{ level: number; class: number; basehp0: number; basehp1: number; basehp2: number; damage_base: number; damage_exp1: number; damage_exp2: number }>;
    creatureImmunities?: Iterable<{ ID: number; SchoolMask: number; DispelTypeMask: number; MechanicsMask: number; Effects: string; Auras: string; ImmuneAoE: boolean | number; ImmuneChain: boolean | number }>;
    creatureImmunitiesIds?: Iterable<{ entry: number; CreatureImmunitiesId: number }>;
  }) {
    this.spells = tables.spells;
    this.castTimes = tables.castTimes;
    this.durations = tables.durations;
    this.ranges = tables.ranges;
    this.radii = tables.radii;
    this.categories = tables.categories;
    this.shapeshifts = tables.shapeshifts;
    this.visuals = tables.visuals ?? new DbcTable(null);
    this.worldData = tables.worldData ?? new SpellWorldData(null);
    for (const row of tables.bonus ?? []) {
      this.bonus.set(row.entry, { direct: row.direct, dot: row.dot, ap: row.ap, apDot: row.apDot });
    }
    for (const row of tables.cooldownOverrides ?? []) {
      this.cooldownOverrides.set(row.Id, { recoveryTime: row.RecoveryTime, categoryRecoveryTime: row.CategoryRecoveryTime, startRecoveryTime: row.StartRecoveryTime, startRecoveryCategory: row.StartRecoveryCategory });
    }
    for (const row of this.worldData.rows("spell_custom_attr")) {
      this.customAttributes.set(Number(row.spell_id), Number(row.attributes) >>> 0);
    }
    for (const row of this.worldData.rows("spell_jump_distance")) {
      this.jumpDistances.set(Number(row.ID), Number(row.JumpDistance));
    }
    for (const row of this.worldData.rows("spell_threat")) {
      this.threats.set(Number(row.entry), { flatMod: Number(row.flatMod ?? 0), pctMod: Number(row.pctMod ?? 1), apPctMod: Number(row.apPctMod ?? 0) });
    }
    for (const row of this.worldData.rows("spell_cone")) {
      this.cones.set(Number(row.ID), Number(row.ConeDegrees));
    }
    for (const row of this.worldData.rows("spell_proc")) {
      this.procCharges.set(Number(row.SpellId), Number(row.Charges));
    }
    // `SpellMgr::LoadCreatureImmunities`: out-of-range effect and aura ids are skipped.
    for (const row of tables.creatureImmunities ?? []) {
      const list = (text: string, limit: number): number[] =>
        String(text ?? "").split(",").map((token) => token.trim()).filter((token) => token !== "").map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value < limit);
      this.immunities.set(row.ID, {
        school: row.SchoolMask & 0x7f,
        dispelType: row.DispelTypeMask & 0xffff,
        mechanic: BigInt.asUintN(64, BigInt(row.MechanicsMask)),
        effects: list(row.Effects, 165),
        auras: list(row.Auras, 317),
        immuneAoE: !!row.ImmuneAoE,
        immuneChain: !!row.ImmuneChain,
      });
    }
    for (const row of tables.creatureImmunitiesIds ?? []) {
      if (row.CreatureImmunitiesId) this.templateImmunities.set(row.entry, row.CreatureImmunitiesId);
    }
    for (const row of tables.classLevelStats ?? []) {
      this.classLevelStats.set(`${row.level}:${row.class}`, {
        baseHealth: [row.basehp0, row.basehp1, row.basehp2],
        baseDamage: [row.damage_base, row.damage_exp1, row.damage_exp2],
      });
    }
  }

  /** `SpellProcEntry::Charges` when `spell_proc` has a row (`Aura::CalcMaxCharges`). */
  procEntryCharges(id: number): number | null {
    return this.procCharges.get(id) ?? null;
  }

  /** `SpellMgr::GetCreatureImmunities(creature_template.CreatureImmunitiesId)` for a creature entry. */
  creatureImmunities(entry: number): CreatureImmunities | null {
    const id = this.templateImmunities.get(entry);
    return id === undefined ? null : (this.immunities.get(id) ?? null);
  }

  /** `ObjectMgr::GetCreatureBaseStats` columns the spell code reads. */
  creatureBaseStats(level: number, classId: number): { baseHealth: [number, number, number]; baseDamage: [number, number, number] } | null {
    return this.classLevelStats.get(`${level}:${classId}`) ?? null;
  }

  static async load(directory: string, world: WorldTables | null): Promise<SpellStore> {
    const classLevelStats = (world?.all(creature_classlevelstats) ?? []).map((row) => ({
      level: row.level,
      class: row.class,
      basehp0: row.basehp0,
      basehp1: row.basehp1,
      basehp2: row.basehp2,
      damage_base: row.damage_base,
      damage_exp1: row.damage_exp1,
      damage_exp2: row.damage_exp2,
    }));
    const creatureImmunities = world?.has(creature_immunities) ? world.all(creature_immunities) : [];
    const creatureImmunitiesIds = world?.has(creature_template)
      ? world.all(creature_template).filter((row) => row.CreatureImmunitiesId).map((row) => ({ entry: row.entry, CreatureImmunitiesId: row.CreatureImmunitiesId }))
      : [];
    const bonus = (world?.all(spell_bonus_data) ?? []).map((row) => ({
      entry: row.entry,
      direct: row.direct_bonus,
      dot: row.dot_bonus,
      ap: row.ap_bonus,
      apDot: row.ap_dot_bonus,
    }));
    const cooldownOverrides = (world?.all(spell_cooldown_overrides) ?? []).map((row) => ({
      Id: row.Id,
      RecoveryTime: row.RecoveryTime,
      CategoryRecoveryTime: row.CategoryRecoveryTime,
      StartRecoveryTime: row.StartRecoveryTime,
      StartRecoveryCategory: row.StartRecoveryCategory,
    }));
    return new SpellStore({
      spells: await DbcTable.load(directory, "Spell.dbc", world, spell_dbc),
      castTimes: await DbcTable.load(directory, "SpellCastTimes.dbc", world, spellcasttimes_dbc),
      durations: await DbcTable.load(directory, "SpellDuration.dbc", world, spellduration_dbc),
      ranges: await DbcTable.load(directory, "SpellRange.dbc", world, spellrange_dbc),
      radii: await DbcTable.load(directory, "SpellRadius.dbc", world, spellradius_dbc),
      categories: await DbcTable.load(directory, "SpellCategory.dbc", world, spellcategory_dbc),
      shapeshifts: await DbcTable.load(directory, "SpellShapeshiftForm.dbc", world, spellshapeshiftform_dbc),
      visuals: await DbcTable.load(directory, "SpellVisual.dbc", world, spellvisual_dbc),
      bonus,
      cooldownOverrides,
      worldData: new SpellWorldData(world),
      classLevelStats,
      creatureImmunities,
      creatureImmunitiesIds,
    });
  }

  get size(): number {
    return this.spells.size;
  }

  /** Every spell id in `Spell.dbc` and `spell_dbc`, ascending. */
  ids(): number[] {
    return this.spells.ids();
  }

  get(id: number): SpellInfo | null {
    const cached = this.cache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const raw = this.raw(id);
    if (!raw) {
      this.cache.set(id, null);
      return null;
    }
    const info = this.derive(raw);
    this.cache.set(id, info);
    return info;
  }

  /** `spell_bonus_data` coefficients. */
  bonusData(id: number): { direct: number; dot: number; ap: number; apDot: number } | null {
    return this.bonus.get(id) ?? null;
  }

  /** `SpellMgr::GetSpellThreatEntry` */
  threatEntry(id: number): { flatMod: number; pctMod: number; apPctMod: number } | null {
    return this.threats.get(id) ?? null;
  }

  /** `SpellMgr::GetSpellCone` in degrees. */
  coneDegrees(id: number): number | null {
    return this.cones.get(id) ?? null;
  }

  /** `mSpellSameEffectStack`: the aura types `LoadSpellGroupStackRules` guesses for a `SPELL_GROUP_STACK_RULE_EXCLUSIVE_SAME_EFFECT` group. */
  sameEffectStackAuraTypes(groupId: number): ReadonlySet<number> | null {
    if (this.worldData.spellGroupStackRule(groupId) !== SPELL_GROUP_STACK_RULE_EXCLUSIVE_SAME_EFFECT) return null;
    const cached = this.sameEffectAuras.get(groupId);
    if (cached) return cached;
    const subGroups = [[SPELL_AURA_MOD_MELEE_HASTE, SPELL_AURA_MOD_MELEE_RANGED_HASTE, SPELL_AURA_MOD_RANGED_HASTE]];
    const frequency = new Map<number, number>();
    for (const spellId of this.worldData.groupMembers(groupId)) {
      const info = this.get(spellId);
      if (!info) continue;
      for (const effect of info.effects) {
        if (!effectIsAura(effect)) continue;
        let auraName = effect.applyAuraName;
        for (const subGroup of subGroups) {
          if (subGroup.includes(auraName)) {
            auraName = subGroup[0]!;
            break;
          }
        }
        frequency.set(auraName, (frequency.get(auraName) ?? 0) + 1);
      }
    }
    let auraType = 0;
    let auraTypeCount = 0;
    for (const [auraName, count] of frequency) {
      if (count > auraTypeCount) {
        auraType = auraName;
        auraTypeCount = count;
      }
    }
    const auraTypes = new Set<number>(subGroups.find((subGroup) => subGroup[0] === auraType) ?? [auraType]);
    this.sameEffectAuras.set(groupId, auraTypes);
    return auraTypes;
  }

  /** `SpellMgr::AddSameEffectStackRuleSpellGroups` — keeps the strongest amount per group; false when the spell is in no such group. */
  addSameEffectStackRuleSpellGroups(info: SpellInfo, auraType: number, amount: number, groups: Map<number, number>): boolean {
    for (const groupId of this.worldData.spellGroupsOf(info.id)) {
      const auraTypes = this.sameEffectStackAuraTypes(groupId);
      if (!auraTypes || !auraTypes.has(auraType)) continue;
      const current = groups.get(groupId);
      if (current === undefined || Math.abs(current) < Math.abs(amount)) groups.set(groupId, amount);
      return true;
    }
    return false;
  }

  /** `SpellInfo::GetFirstRankSpell` */
  firstRank(info: SpellInfo): SpellInfo {
    return this.get(this.worldData.firstRank(info.id)) ?? info;
  }

  /** `SpellInfo::GetPrevRankSpell` */
  prevRank(info: SpellInfo): SpellInfo | null {
    const rank = this.worldData.rank(info.id);
    if (!rank || rank.rank <= 1) return null;
    const previous = this.worldData.withRank(info.id, rank.rank - 1);
    return previous === null ? null : this.get(previous);
  }

  /** `SpellInfo::IsRankOf` */
  isRankOf(left: SpellInfo, right: SpellInfo): boolean {
    return this.worldData.firstRank(left.id) === this.worldData.firstRank(right.id);
  }

  /** `SpellInfo::IsDifferentRankOf` */
  isDifferentRankOf(left: SpellInfo, right: SpellInfo): boolean {
    return left.id !== right.id && this.isRankOf(left, right);
  }

  /** `SpellInfo::IsHighRankOf` */
  isHighRankOf(left: SpellInfo, right: SpellInfo): boolean {
    const a = this.worldData.rank(left.id);
    const b = this.worldData.rank(right.id);
    return !!a && !!b && a.first_spell_id === b.first_spell_id && a.rank > b.rank;
  }

  /**
   * `sSpellsByCategoryStore` for one category: the spell ids whose `Spell.dbc` category matches. Item template
   * entries (`fromItem`) are the item layer's; they are not indexed here.
   */
  spellsInCategory(category: number, fromItem: boolean): readonly number[] {
    if (fromItem || !category) return [];
    if (!this.byCategory) {
      this.byCategory = new Map();
      for (const id of this.spells.ids()) {
        const value = this.spells.record(id)?.u32(1) ?? 0;
        if (!value) continue;
        const list = this.byCategory.get(value);
        if (list) list.push(id);
        else this.byCategory.set(value, [id]);
      }
    }
    return this.byCategory.get(category) ?? [];
  }

  private byCategory: Map<number, number[]> | null = null;

  shapeshift(form: number): ShapeshiftForm | null {
    const row = this.shapeshifts.record(form);
    if (!row) {
      return null;
    }
    return {
      id: row.u32(0),
      flags: row.u32(19),
      creatureType: row.i32(20),
      attackSpeed: row.u32(22),
      modelAlliance: row.u32(23),
      modelHorde: row.u32(24),
      spells: Array.from({ length: 8 }, (_, index) => row.u32(27 + index)).filter((spell) => spell !== 0),
    };
  }

  private raw(id: number): RawSpellInfo | null {
    const cached = this.rawCache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const row = this.spells.record(id);
    const info = row ? this.build(row) : null;
    this.rawCache.set(id, info);
    return info;
  }

  /** `LoadSpellInfoCustomAttributes`, `LoadSpellSpecificAndAuraState`, `LoadSpellInfoImmunities`, overrides, and jump distances for one spell. */
  private derive(source: RawSpellInfo): SpellInfo {
    const raw: RawSpellInfo = { ...source, effects: source.effects.map((effect) => ({ ...effect })) as RawSpellInfo["effects"] };
    let cu = this.customAttributes.get(raw.id) ?? 0;
    let requireCooldownInfo = false;
    for (let i = 0; i < MAX_SPELL_EFFECTS; i++) {
      const present = raw.effects[i]!.effect !== 0;
      if (cu & SPELL_ATTR0_CU_NEGATIVE) {
        if (present) {
          if (cu & (SPELL_ATTR0_CU_NEGATIVE_EFF0 << i) && cu & (SPELL_ATTR0_CU_POSITIVE_EFF0 << i)) cu &= ~(SPELL_ATTR0_CU_NEGATIVE_EFF0 << i) | (SPELL_ATTR0_CU_POSITIVE_EFF0 << i);
        } else if (cu & (SPELL_ATTR0_CU_NEGATIVE_EFF0 << i)) {
          cu &= ~(SPELL_ATTR0_CU_NEGATIVE_EFF0 << i);
        }
      }
    }
    for (let i = 0; i < MAX_SPELL_EFFECTS; i++) {
      if (cu & SPELL_ATTR0_CU_POSITIVE && raw.effects[i]!.effect === 0 && cu & (SPELL_ATTR0_CU_POSITIVE_EFF0 << i)) cu &= ~(SPELL_ATTR0_CU_POSITIVE_EFF0 << i);
    }
    if (cu & SPELL_ATTR0_CU_FORCE_AURA_SAVING && cu & SPELL_ATTR0_CU_AURA_CANNOT_BE_SAVED) {
      cu &= ~(SPELL_ATTR0_CU_FORCE_AURA_SAVING | SPELL_ATTR0_CU_AURA_CANNOT_BE_SAVED);
    }
    for (const effect of raw.effects) {
      switch (effect.applyAuraName) {
        case SPELL_AURA_MOD_INVISIBILITY:
          if (![44801, 46021, 52951, 43062, 45614].includes(raw.id)) raw.auraInterruptFlags |= AURA_INTERRUPT_FLAG_CAST;
          break;
        case SPELL_AURA_TRACK_CREATURES:
        case SPELL_AURA_MOD_RANGED_HASTE:
        case SPELL_AURA_MOD_POSSESS_PET:
        case SPELL_AURA_MOD_INVISIBILITY_DETECT:
        case SPELL_AURA_WATER_BREATHING:
          cu |= SPELL_ATTR0_CU_NO_INITIAL_THREAT;
          break;
        default:
          break;
      }
      switch (effect.applyAuraName) {
        case SPELL_AURA_CONVERT_RUNE:
        case SPELL_AURA_OPEN_STABLE:
        case SPELL_AURA_CONTROL_VEHICLE:
        case SPELL_AURA_BIND_SIGHT:
        case SPELL_AURA_MOD_POSSESS:
        case SPELL_AURA_MOD_POSSESS_PET:
        case SPELL_AURA_MOD_CHARM:
        case SPELL_AURA_AOE_CHARM:
          cu |= SPELL_ATTR0_CU_AURA_CANNOT_BE_SAVED;
          break;
        default:
          break;
      }
      switch (effect.applyAuraName) {
        case SPELL_AURA_MOD_POSSESS:
        case SPELL_AURA_MOD_CONFUSE:
        case SPELL_AURA_MOD_CHARM:
        case SPELL_AURA_AOE_CHARM:
        case SPELL_AURA_MOD_FEAR:
        case SPELL_AURA_MOD_STUN:
          cu |= SPELL_ATTR0_CU_AURA_CC;
          break;
        case SPELL_AURA_BIND_SIGHT:
          cu |= SPELL_ATTR0_CU_NO_PVP_FLAG;
          break;
        default:
          break;
      }
      switch (effect.effect) {
        case SPELL_EFFECT_SCHOOL_DAMAGE:
        case SPELL_EFFECT_WEAPON_DAMAGE:
        case SPELL_EFFECT_WEAPON_DAMAGE_NOSCHOOL:
        case SPELL_EFFECT_NORMALIZED_WEAPON_DMG:
        case SPELL_EFFECT_WEAPON_PERCENT_DAMAGE:
        case SPELL_EFFECT_HEAL:
          cu |= SPELL_ATTR0_CU_DIRECT_DAMAGE;
          break;
        case SPELL_EFFECT_POWER_DRAIN:
        case SPELL_EFFECT_POWER_BURN:
        case SPELL_EFFECT_HEAL_MAX_HEALTH:
        case SPELL_EFFECT_HEALTH_LEECH:
        case SPELL_EFFECT_HEAL_PCT:
        case SPELL_EFFECT_ENERGIZE_PCT:
        case SPELL_EFFECT_ENERGIZE:
        case SPELL_EFFECT_HEAL_MECHANICAL:
        case SPELL_EFFECT_CREATE_ITEM:
          cu |= SPELL_ATTR0_CU_NO_INITIAL_THREAT;
          break;
        case SPELL_EFFECT_CHARGE:
        case SPELL_EFFECT_CHARGE_DEST:
        case SPELL_EFFECT_JUMP:
        case SPELL_EFFECT_JUMP_DEST:
        case SPELL_EFFECT_LEAP_BACK:
          cu |= SPELL_ATTR0_CU_CHARGE;
          break;
        case SPELL_EFFECT_PICKPOCKET:
          cu |= SPELL_ATTR0_CU_PICKPOCKET;
          break;
        default:
          break;
      }
    }
    if (this.computeBinary(raw, cu)) cu |= SPELL_ATTR0_CU_BINARY_SPELL;
    if (raw.schoolMask & SPELL_SCHOOL_MASK_NORMAL && raw.schoolMask & SPELL_SCHOOL_MASK_MAGIC) {
      raw.schoolMask &= ~SPELL_SCHOOL_MASK_NORMAL;
      cu |= SPELL_ATTR0_CU_SCHOOLMASK_NORMAL_WITH_MAGIC;
    }
    for (let i = 0; i < MAX_SPELL_EFFECTS; i++) {
      if (!isPositiveEffectRaw(raw, i, false, (other) => this.raw(other))) cu |= SPELL_ATTR0_CU_NEGATIVE_EFF0 << i;
    }
    if (raw.spellVisual[0] === 3879) cu |= SPELL_ATTR0_CU_CONE_BACK;
    switch (raw.spellFamilyName) {
      case SPELLFAMILY_WARRIOR:
        if (raw.spellFamilyFlags[0] & 0x20000 || raw.spellFamilyFlags[1] & 0x20) cu |= SPELL_ATTR0_CU_AURA_CC;
        break;
      case SPELLFAMILY_DRUID:
        if (raw.spellFamilyFlags[0] & 0x8) cu |= SPELL_ATTR0_CU_AURA_CC;
        break;
      case SPELLFAMILY_HUNTER:
        if (raw.category === 47) cu |= SPELL_ATTR0_CU_NO_INITIAL_THREAT;
        if (raw.spellFamilyFlags[0] & 0x00020000) cu |= SPELL_ATTR0_CU_FORCE_SEND_CATEGORY_COOLDOWNS;
        break;
      default:
        break;
    }
    switch (raw.id) {
      case 32645:
      case 32684:
      case 57992:
      case 57993: {
        // Envenom: effects 0 and 2 trade places.
        const first = raw.effects[0]!;
        raw.effects[0] = { ...raw.effects[2]!, index: 0 };
        raw.effects[2] = { ...first, index: 2 };
        break;
      }
      case 57493:
        raw.recoveryTime = 60000;
        requireCooldownInfo = true;
        break;
      case 7769:
        raw.recoveryTime = 1500;
        requireCooldownInfo = true;
        break;
      case 44535:
        raw.effects[0]!.miscValue = 127;
        break;
      default:
        break;
    }
    if (raw.speed > 0) {
      const visual = this.visuals.record(raw.spellVisual[0]);
      if (visual && visual.u32(7) && (visual.i32(8) === -4 || visual.i32(8) === -5)) cu |= SPELL_ATTR0_CU_NEEDS_AMMO_DATA;
    }
    const override = this.cooldownOverrides.get(raw.id);
    if (override) {
      // `LoadSpellInfoCustomAttributes` writes RecoveryTime for each of the start recovery mismatches as well.
      if (raw.recoveryTime !== override.recoveryTime) raw.recoveryTime = override.recoveryTime;
      if (raw.categoryRecoveryTime !== override.categoryRecoveryTime) raw.categoryRecoveryTime = override.categoryRecoveryTime;
      if (raw.startRecoveryTime !== override.startRecoveryTime) raw.recoveryTime = override.recoveryTime;
      if (raw.startRecoveryCategory !== override.startRecoveryCategory) raw.recoveryTime = override.recoveryTime;
    }
    cu >>>= 0;
    let negativeEffectMask = 0;
    for (let i = 0; i < MAX_SPELL_EFFECTS; i++) {
      if (cu & (SPELL_ATTR0_CU_NEGATIVE_EFF0 << i) && !(cu & (SPELL_ATTR0_CU_POSITIVE_EFF0 << i))) negativeEffectMask |= 1 << i;
    }
    const partial = {
      ...raw,
      attributesCu: cu,
      negativeEffectMask,
      explicitTargetMask: explicitTargetMaskOf(raw),
      spellSpecific: SPELL_SPECIFIC_NORMAL,
      auraState: AURA_STATE_NONE,
      immunity: raw.effects.map((effect) => immunityInfoOf(raw, effect)) as SpellInfo["immunity"],
      jumpDistance: this.jumpDistances.get(raw.id) ?? 0,
      requireCooldownInfo,
    };
    partial.spellSpecific = this.loadSpellSpecific(partial);
    partial.auraState = loadAuraState(partial);
    return partial;
  }

  /** The `SPELL_ATTR0_CU_BINARY_SPELL` pass, including the second pass for spells that only trigger non-binary spells. */
  private computeBinary(raw: RawSpellInfo, cu: number, deep = false): boolean {
    if (raw.attributes[3] & SPELL_ATTR3_ALWAYS_HIT) return false;
    let binary = false;
    for (const effect of raw.effects) {
      if (!effect.effect) continue;
      switch (effect.effect) {
        case SPELL_EFFECT_SCHOOL_DAMAGE:
        case SPELL_EFFECT_WEAPON_DAMAGE:
        case SPELL_EFFECT_WEAPON_DAMAGE_NOSCHOOL:
        case SPELL_EFFECT_NORMALIZED_WEAPON_DMG:
        case SPELL_EFFECT_WEAPON_PERCENT_DAMAGE:
        case SPELL_EFFECT_TRIGGER_SPELL:
        case SPELL_EFFECT_TRIGGER_SPELL_WITH_VALUE:
          continue;
        default:
          break;
      }
      if (
        (isAuraEffect(effect.effect) || effect.effect === SPELL_EFFECT_PERSISTENT_AREA_AURA) &&
        (effect.applyAuraName === SPELL_AURA_PERIODIC_DAMAGE ||
          effect.applyAuraName === SPELL_AURA_PERIODIC_DAMAGE_PERCENT ||
          effect.applyAuraName === SPELL_AURA_DUMMY ||
          effect.applyAuraName === SPELL_AURA_PERIODIC_LEECH ||
          effect.applyAuraName === SPELL_AURA_PERIODIC_HEALTH_FUNNEL ||
          effect.applyAuraName === SPELL_AURA_PERIODIC_DUMMY)
      ) continue;
      const value = calcEffectValue(raw as SpellInfo, effect, null, 0, (min) => min);
      const noImmunities = (raw.attributes[0] & SPELL_ATTR0_NO_IMMUNITIES) !== 0;
      if (!(value || ((effect.effect === SPELL_EFFECT_INTERRUPT_CAST || cu & SPELL_ATTR0_CU_DONT_BREAK_STEALTH) && !noImmunities))) continue;
      if ([69649, 71056, 71057, 71058, 73061, 73062, 73063, 73064].includes(raw.id)) continue;
      if (raw.spellFamilyName === SPELLFAMILY_MAGE && raw.spellFamilyFlags[0] & 0x20) continue;
      if (raw.id === 55095) continue;
      if (raw.spellFamilyName === SPELLFAMILY_WARLOCK && (raw.spellFamilyFlags[1] & 0x40000 || raw.spellFamilyFlags[0] & 0x4000)) continue;
      binary = true;
    }
    if (!binary || deep) return binary;
    let allNonBinary = true;
    let overrideAttr = false;
    for (const effect of raw.effects) {
      if (!effect.applyAuraName || !effect.triggerSpell) continue;
      switch (effect.applyAuraName) {
        case SPELL_AURA_PERIODIC_TRIGGER_SPELL:
        case SPELL_AURA_PERIODIC_TRIGGER_SPELL_FROM_CLIENT:
        case SPELL_AURA_PERIODIC_TRIGGER_SPELL_WITH_VALUE: {
          const trigger = this.raw(effect.triggerSpell);
          if (trigger) {
            overrideAttr = true;
            if (this.computeBinary(trigger, this.customAttributes.get(trigger.id) ?? 0, true)) allNonBinary = false;
          }
          break;
        }
        default:
          break;
      }
    }
    return !(overrideAttr && allNonBinary);
  }

  /** `SpellInfo::LoadSpellSpecific` */
  private loadSpellSpecific(info: SpellInfo): number {
    const flags = info.spellFamilyFlags;
    switch (info.spellFamilyName) {
      case SPELLFAMILY_GENERIC:
        if (info.auraInterruptFlags & AURA_INTERRUPT_FLAG_NOT_SEATED) {
          let food = false;
          let drink = false;
          for (const effect of info.effects) {
            if (!effectIsAura(effect)) continue;
            switch (effect.applyAuraName) {
              case SPELL_AURA_MOD_REGEN:
              case SPELL_AURA_OBS_MOD_HEALTH:
                food = true;
                break;
              case SPELL_AURA_MOD_POWER_REGEN:
              case SPELL_AURA_OBS_MOD_POWER:
                drink = true;
                break;
              default:
                break;
            }
          }
          if (food && drink) return SPELL_SPECIFIC_FOOD_AND_DRINK;
          if (food) return SPELL_SPECIFIC_FOOD;
          if (drink) return SPELL_SPECIFIC_DRINK;
        } else {
          switch (this.worldData.firstRank(info.id)) {
            case 8118:
            case 8099:
            case 8112:
            case 8096:
            case 8115:
            case 8091:
              return SPELL_SPECIFIC_SCROLL;
            default:
              break;
          }
        }
        break;
      case SPELLFAMILY_MAGE:
        if (flags[0] & 0x12040000) return SPELL_SPECIFIC_MAGE_ARMOR;
        if (flags[0] & 0x400) return SPELL_SPECIFIC_MAGE_ARCANE_BRILLANCE;
        if (flags[0] & 0x1000000 && info.effects[0].applyAuraName === SPELL_AURA_MOD_CONFUSE) return SPELL_SPECIFIC_MAGE_POLYMORPH;
        break;
      case SPELLFAMILY_WARLOCK:
        if (info.dispel === DISPEL_CURSE) return SPELL_SPECIFIC_CURSE;
        if (flags[1] & 0x20000020 || flags[2] & 0x00000010) return SPELL_SPECIFIC_WARLOCK_ARMOR;
        if (flags[1] & 0x10 || flags[0] & 0x2) return SPELL_SPECIFIC_WARLOCK_CORRUPTION;
        break;
      case SPELLFAMILY_PRIEST:
        if (flags[0] & 0x20) return SPELL_SPECIFIC_PRIEST_DIVINE_SPIRIT;
        break;
      case SPELLFAMILY_HUNTER:
        if (info.dispel === DISPEL_POISON) return SPELL_SPECIFIC_STING;
        if (flags[0] & 0x00380000 || flags[1] & 0x00440000 || flags[2] & 0x00001010) return SPELL_SPECIFIC_ASPECT;
        break;
      case SPELLFAMILY_PALADIN:
        if (flags[1] & 0x26000c00 || flags[0] & 0x0a000000) return SPELL_SPECIFIC_SEAL;
        if (flags[0] & 0x00002190) return SPELL_SPECIFIC_HAND;
        if (info.id === 20184 || info.id === 20185 || info.id === 20186) return SPELL_SPECIFIC_JUDGEMENT;
        if (flags[2] & 0x00000020) return SPELL_SPECIFIC_AURA;
        if (info.id === 41459 || info.id === 41469) return SPELL_SPECIFIC_SEAL;
        break;
      case SPELLFAMILY_SHAMAN:
        if (flags[1] & 0x420 || (flags[0] & 0x00000400 && hasAttribute(info, 1, SPELL_ATTR1_NO_THREAT)) || info.id === 23552) return SPELL_SPECIFIC_ELEMENTAL_SHIELD;
        break;
      case SPELLFAMILY_DEATHKNIGHT:
        if (info.id === 48266 || info.id === 48263 || info.id === 48265) return SPELL_SPECIFIC_PRESENCE;
        break;
      default:
        break;
    }
    for (const effect of info.effects) {
      if (effect.effect !== SPELL_EFFECT_APPLY_AURA) continue;
      switch (effect.applyAuraName) {
        case SPELL_AURA_MOD_CHARM:
        case SPELL_AURA_MOD_POSSESS_PET:
        case SPELL_AURA_MOD_POSSESS:
        case SPELL_AURA_AOE_CHARM:
          return SPELL_SPECIFIC_CHARM;
        case SPELL_AURA_TRACK_CREATURES:
          if (info.id === 30645) return SPELL_SPECIFIC_NORMAL;
          return SPELL_SPECIFIC_TRACKER;
        case SPELL_AURA_TRACK_RESOURCES:
        case SPELL_AURA_TRACK_STEALTHED:
          return SPELL_SPECIFIC_TRACKER;
        default:
          break;
      }
    }
    return SPELL_SPECIFIC_NORMAL;
  }

  private build(row: DbcRecordView): RawSpellInfo {
    const castTime = row.u32(28) ? (this.castTimes.record(row.u32(28))?.i32(1) ?? 0) : 0;
    const durationRow = row.u32(40) ? this.durations.record(row.u32(40)) : null;
    const rangeRow = row.u32(46) ? this.ranges.record(row.u32(46)) : null;
    const category = row.u32(1);
    const effects = [0, 1, 2].map((index): SpellEffectInfo => {
      const radiusRow = row.u32(92 + index) ? this.radii.record(row.u32(92 + index)) : null;
      return {
        index,
        effect: row.u32(71 + index),
        dieSides: row.i32(74 + index),
        realPointsPerLevel: row.f32(77 + index),
        basePoints: row.i32(80 + index),
        mechanic: row.u32(83 + index),
        targetA: row.u32(86 + index),
        targetB: row.u32(89 + index),
        radius: radiusRow ? { min: radiusRow.f32(1), perLevel: radiusRow.f32(2), max: radiusRow.f32(3) } : null,
        applyAuraName: row.u32(95 + index),
        amplitude: row.u32(98 + index),
        valueMultiplier: row.f32(101 + index),
        chainTarget: row.u32(104 + index),
        itemType: row.u32(107 + index),
        miscValue: row.i32(110 + index),
        miscValueB: row.i32(113 + index),
        triggerSpell: row.u32(116 + index),
        pointsPerComboPoint: row.f32(119 + index),
        spellClassMask: [row.u32(122 + index * 3), row.u32(123 + index * 3), row.u32(124 + index * 3)],
        damageMultiplier: row.f32(216 + index),
        bonusMultiplier: row.f32(229 + index),
      };
    }) as [SpellEffectInfo, SpellEffectInfo, SpellEffectInfo];
    const reagents: { item: number; count: number }[] = [];
    for (let index = 0; index < 8; index++) {
      const item = row.i32(52 + index);
      if (item > 0) {
        reagents.push({ item, count: row.u32(60 + index) });
      }
    }
    return {
      id: row.u32(0),
      name: row.str(136),
      rank: row.str(153),
      category,
      categoryFlags: category ? (this.categories.record(category)?.u32(1) ?? 0) : 0,
      dispel: row.u32(2),
      mechanic: row.u32(3),
      attributes: [row.u32(4), row.u32(5), row.u32(6), row.u32(7), row.u32(8), row.u32(9), row.u32(10), row.u32(11)],
      stances: row.u32(12),
      stancesNot: row.u32(14),
      targets: row.u32(16),
      targetCreatureType: row.u32(17),
      requiresSpellFocus: row.u32(18),
      facingCasterFlags: row.u32(19),
      casterAuraState: row.u32(20),
      targetAuraState: row.u32(21),
      casterAuraStateNot: row.u32(22),
      targetAuraStateNot: row.u32(23),
      casterAuraSpell: row.u32(24),
      targetAuraSpell: row.u32(25),
      excludeCasterAuraSpell: row.u32(26),
      excludeTargetAuraSpell: row.u32(27),
      castTime,
      recoveryTime: row.u32(29),
      categoryRecoveryTime: row.u32(30),
      interruptFlags: row.u32(31),
      auraInterruptFlags: row.u32(32),
      channelInterruptFlags: row.u32(33),
      procFlags: row.u32(34),
      procChance: row.u32(35),
      procCharges: row.u32(36),
      maxLevel: row.u32(37),
      baseLevel: row.u32(38),
      spellLevel: row.u32(39),
      duration: durationRow ? [durationRow.i32(1), durationRow.i32(2), durationRow.i32(3)] : [0, 0, 0],
      durationEntry: durationRow !== null,
      powerType: row.u32(41),
      manaCost: row.u32(42),
      manaCostPerLevel: row.u32(43),
      manaPerSecond: row.u32(44),
      manaPerSecondPerLevel: row.u32(45),
      range: rangeRow
        ? { id: rangeRow.u32(0), minHostile: rangeRow.f32(1), minFriend: rangeRow.f32(2), maxHostile: rangeRow.f32(3), maxFriend: rangeRow.f32(4), flags: rangeRow.u32(5) }
        : null,
      speed: row.f32(47),
      stackAmount: row.u32(49),
      totem: [row.u32(50), row.u32(51)],
      reagents,
      equippedItemClass: row.i32(68),
      equippedItemSubClassMask: row.i32(69),
      equippedItemInventoryTypeMask: row.i32(70),
      effects,
      spellVisual: [row.u32(131), row.u32(132)],
      spellIconId: row.u32(133),
      activeIconId: row.u32(134),
      manaCostPercentage: row.u32(204),
      startRecoveryCategory: row.u32(205),
      startRecoveryTime: row.u32(206),
      maxTargetLevel: row.u32(207),
      spellFamilyName: row.u32(208),
      spellFamilyFlags: [row.u32(209), row.u32(210), row.u32(211)],
      maxAffectedTargets: row.u32(212),
      dmgClass: row.u32(213),
      preventionType: row.u32(214),
      totemCategory: [row.u32(222), row.u32(223)],
      areaGroupId: row.i32(224),
      schoolMask: row.u32(225),
      runeCostId: row.u32(226),
    };
  }
}

/** `SpellInfo::LoadAuraState` */
function loadAuraState(info: SpellInfo): number {
  if (info.spellSpecific === SPELL_SPECIFIC_SEAL) return AURA_STATE_JUDGEMENT;
  const flags = info.spellFamilyFlags;
  if (info.spellFamilyName === SPELLFAMILY_WARLOCK && (flags[0] & 4 || flags[2] & 2)) return AURA_STATE_CONFLAGRATE;
  if (info.spellFamilyName === SPELLFAMILY_DRUID && flags[0] & 0x400) return AURA_STATE_FAERIE_FIRE;
  if (info.category === 1133) return AURA_STATE_FAERIE_FIRE;
  if (info.spellFamilyName === SPELLFAMILY_WARRIOR && flags[1] & 0x00040000) return AURA_STATE_WARRIOR_VICTORY_RUSH;
  if (info.spellFamilyName === SPELLFAMILY_DRUID && flags[0] & 0x50) return AURA_STATE_SWIFTMEND;
  if (info.spellFamilyName === SPELLFAMILY_ROGUE && flags[0] & 0x10000) return AURA_STATE_DEADLY_POISON;
  if (info.dispel === DISPEL_ENRAGE) return AURA_STATE_ENRAGE;
  if (allEffectsMechanicMask(info) & (1n << BigInt(MECHANIC_BLEED))) return AURA_STATE_BLEEDING;
  if (info.mechanic === MECHANIC_BANISH) return AURA_STATE_BANISHED;
  if (info.schoolMask & SPELL_SCHOOL_MASK_FROST) {
    for (const effect of info.effects) {
      if (effectIsAura(effect) && (effect.applyAuraName === SPELL_AURA_MOD_STUN || effect.applyAuraName === SPELL_AURA_MOD_ROOT)) return AURA_STATE_FROZEN;
    }
  }
  switch (info.id) {
    case 71465:
    case 50241:
      return AURA_STATE_UNKNOWN22;
    case 9991:
    case 35331:
    case 9806:
    case 35325:
    case 35328:
    case 35329:
    case 16498:
    case 6950:
    case 20656:
    case 25602:
    case 32129:
    case 49163:
      return AURA_STATE_FAERIE_FIRE;
    default:
      return AURA_STATE_NONE;
  }
}

/** `CreatureImmunities` (`creature_immunities`). */
export type CreatureImmunities = {
  school: number;
  dispelType: number;
  mechanic: bigint;
  effects: readonly number[];
  auras: readonly number[];
  immuneAoE: boolean;
  immuneChain: boolean;
};

/** `SpellInfo::CalcPowerCost` inputs from the caster. */
export type PowerCostCaster = {
  health: number;
  power: (power: number) => number;
  maxPower: (power: number) => number;
  createHealth: number;
  createMana: number;
  /** `UNIT_FIELD_POWER_COST_MODIFIER + school` */
  powerCostModifier: (school: number) => number;
  /** `UNIT_FIELD_POWER_COST_MULTIPLIER + school` */
  powerCostMultiplier: (school: number) => number;
  controlledByPlayer: boolean;
  level: number;
  /** Attack time for `SPELL_ATTR4_WEAPON_SPEED_COST_SCALING` (shapeshift speed when shapeshifted). */
  weaponSpeed: (offhand: boolean) => number;
};

/** `SpellInfo::CalcPowerCost` without spell mods and the NPC mana cost scaler (`gtNPCManaCostScaler` is not loaded). */
export function calcPowerCost(info: SpellInfo, caster: PowerCostCaster, schoolMask: number): number {
  if (hasAttribute(info, 1, 0x2 /* SPELL_ATTR1_USE_ALL_MANA */)) {
    if (info.powerType === POWER_HEALTH) return caster.health;
    if (info.powerType < 7) return caster.power(info.powerType);
    return 0;
  }
  let powerCost = info.manaCost;
  if (info.manaCostPercentage) {
    switch (info.powerType) {
      case POWER_HEALTH:
        powerCost += Math.trunc((caster.createHealth * info.manaCostPercentage) / 100);
        break;
      case POWER_MANA:
        powerCost += Math.trunc((caster.createMana * info.manaCostPercentage) / 100);
        break;
      case 1:
      case 2:
      case 3:
      case 4:
        powerCost += Math.trunc((caster.maxPower(info.powerType) * info.manaCostPercentage) / 100);
        break;
      case 5:
      case 6:
        break;
      default:
        return 0;
    }
  }
  const school = firstSchool(schoolMask);
  powerCost += caster.powerCostModifier(school);
  if (hasAttribute(info, 4, 0x400 /* SPELL_ATTR4_WEAPON_SPEED_COST_SCALING */)) {
    powerCost += Math.trunc(caster.weaponSpeed(hasAttribute(info, 3, 0x1000000 /* SPELL_ATTR3_REQUIRES_OFF_HAND_WEAPON */)) / 100);
  }
  powerCost = Math.trunc(powerCost * Math.fround(1 + caster.powerCostMultiplier(school)));
  return powerCost < 0 ? 0 : powerCost;
}

/** First school in a mask (`GetFirstSchoolInMask`). */
export function firstSchool(mask: number): number {
  for (let school = 0; school < 7; school++) {
    if (mask & (1 << school)) {
      return school;
    }
  }
  return 0;
}
