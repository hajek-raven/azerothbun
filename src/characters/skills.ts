import { and, asc, eq } from "drizzle-orm";
import type { DbExecutor } from "../database/database.ts";
import { character_skills } from "../database/schema/characters.ts";
import { playercreateinfo_skills } from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { irand as defaultIrand, rollChanceF as defaultRollChanceF } from "../common/random.ts";
import {
  MAX_SKILL_STEP,
  SKILL_CATEGORY_ARMOR,
  SKILL_CATEGORY_LANGUAGES,
  SKILL_CATEGORY_PROFESSION,
  SKILL_CATEGORY_SECONDARY,
  SKILL_FLAG_ALWAYS_MAX_VALUE,
  SKILL_LINE_ABILITY_LEARNED_ON_SKILL_LEARN,
  SKILL_LINE_ABILITY_LEARNED_ON_SKILL_VALUE,
  type SkillData,
  type SkillLineEntry,
  type SkillRaceClassInfoEntry,
} from "../data/dbc-skills.ts";
import type { WorldConfig } from "../game/world/world-config.ts";
import { ServerConfig } from "../game/world/world-config-data.ts";

/**
 * Player skill system: `Player::mSkillStatus` + the PLAYER_SKILL_INFO_1_1 update fields.
 *
 * Ported from Player.cpp (SetSkill, getters, ModifySkillBonus, LearnDefaultSkill(s),
 * learnSkillRewardedSpells, _LoadSkills), PlayerStorage.cpp (_SaveSkills), PlayerUpdates.cpp
 * (UpdateSkill, UpdateSkillPro, UpdateGatherSkill, UpdateCraftSkill, UpdateFishingSkill,
 * UpdateWeaponSkill, UpdateCombatSkills, UpdateDefense, UpdateSkillsForLevel,
 * UpdateSkillsToMaxSkillsForLevel), ObjectMgr.cpp (GetSkillRangeType, lang_description,
 * playercreateinfo_skills) and DBCStores.cpp (GetSkillRaceClassInfo).
 *
 * Things the C++ does through other systems (spells, auras, item enchantments, achievements,
 * combat ratings) are reported as ordered `SkillEvent`s; drain them with `drainEvents()`.
 */

// ---------------------------------------------------------------------------------------------
// SharedDefines.h `SkillType`
// ---------------------------------------------------------------------------------------------

export const SkillType = {
  SKILL_NONE: 0,
  SKILL_FROST: 6,
  SKILL_FIRE: 8,
  SKILL_ARMS: 26,
  SKILL_COMBAT: 38,
  SKILL_SUBTLETY: 39,
  SKILL_SWORDS: 43,
  SKILL_AXES: 44,
  SKILL_BOWS: 45,
  SKILL_GUNS: 46,
  SKILL_BEAST_MASTERY: 50,
  SKILL_SURVIVAL: 51,
  SKILL_MACES: 54,
  SKILL_2H_SWORDS: 55,
  SKILL_HOLY: 56,
  SKILL_SHADOW: 78,
  SKILL_DEFENSE: 95,
  SKILL_LANG_COMMON: 98,
  SKILL_RACIAL_DWARVEN: 101,
  SKILL_LANG_ORCISH: 109,
  SKILL_LANG_DWARVEN: 111,
  SKILL_LANG_DARNASSIAN: 113,
  SKILL_LANG_TAURAHE: 115,
  SKILL_DUAL_WIELD: 118,
  SKILL_RACIAL_TAUREN: 124,
  SKILL_ORC_RACIAL: 125,
  SKILL_RACIAL_NIGHT_ELF: 126,
  SKILL_FIRST_AID: 129,
  SKILL_FERAL_COMBAT: 134,
  SKILL_STAVES: 136,
  SKILL_LANG_THALASSIAN: 137,
  SKILL_LANG_DRACONIC: 138,
  SKILL_LANG_DEMON_TONGUE: 139,
  SKILL_LANG_TITAN: 140,
  SKILL_LANG_OLD_TONGUE: 141,
  SKILL_SURVIVAL2: 142,
  SKILL_RIDING_HORSE: 148,
  SKILL_RIDING_WOLF: 149,
  SKILL_RIDING_TIGER: 150,
  SKILL_RIDING_RAM: 152,
  SKILL_SWIMING: 155,
  SKILL_2H_MACES: 160,
  SKILL_UNARMED: 162,
  SKILL_MARKSMANSHIP: 163,
  SKILL_BLACKSMITHING: 164,
  SKILL_LEATHERWORKING: 165,
  SKILL_ALCHEMY: 171,
  SKILL_2H_AXES: 172,
  SKILL_DAGGERS: 173,
  SKILL_THROWN: 176,
  SKILL_HERBALISM: 182,
  SKILL_GENERIC_DND: 183,
  SKILL_RETRIBUTION: 184,
  SKILL_COOKING: 185,
  SKILL_MINING: 186,
  SKILL_PET_IMP: 188,
  SKILL_PET_FELHUNTER: 189,
  SKILL_TAILORING: 197,
  SKILL_ENGINEERING: 202,
  SKILL_PET_SPIDER: 203,
  SKILL_PET_VOIDWALKER: 204,
  SKILL_PET_SUCCUBUS: 205,
  SKILL_PET_INFERNAL: 206,
  SKILL_PET_DOOMGUARD: 207,
  SKILL_PET_WOLF: 208,
  SKILL_PET_CAT: 209,
  SKILL_PET_BEAR: 210,
  SKILL_PET_BOAR: 211,
  SKILL_PET_CROCILISK: 212,
  SKILL_PET_CARRION_BIRD: 213,
  SKILL_PET_CRAB: 214,
  SKILL_PET_GORILLA: 215,
  SKILL_PET_RAPTOR: 217,
  SKILL_PET_TALLSTRIDER: 218,
  SKILL_RACIAL_UNDED: 220,
  SKILL_CROSSBOWS: 226,
  SKILL_WANDS: 228,
  SKILL_POLEARMS: 229,
  SKILL_PET_SCORPID: 236,
  SKILL_ARCANE: 237,
  SKILL_PET_TURTLE: 251,
  SKILL_ASSASSINATION: 253,
  SKILL_FURY: 256,
  SKILL_PROTECTION: 257,
  SKILL_PROTECTION2: 267,
  SKILL_PET_TALENTS: 270,
  SKILL_PLATE_MAIL: 293,
  SKILL_LANG_GNOMISH: 313,
  SKILL_LANG_TROLL: 315,
  SKILL_ENCHANTING: 333,
  SKILL_DEMONOLOGY: 354,
  SKILL_AFFLICTION: 355,
  SKILL_FISHING: 356,
  SKILL_ENHANCEMENT: 373,
  SKILL_RESTORATION: 374,
  SKILL_ELEMENTAL_COMBAT: 375,
  SKILL_SKINNING: 393,
  SKILL_MAIL: 413,
  SKILL_LEATHER: 414,
  SKILL_CLOTH: 415,
  SKILL_SHIELD: 433,
  SKILL_FIST_WEAPONS: 473,
  SKILL_RIDING_RAPTOR: 533,
  SKILL_RIDING_MECHANOSTRIDER: 553,
  SKILL_RIDING_UNDEAD_HORSE: 554,
  SKILL_RESTORATION2: 573,
  SKILL_BALANCE: 574,
  SKILL_DESTRUCTION: 593,
  SKILL_HOLY2: 594,
  SKILL_DISCIPLINE: 613,
  SKILL_LOCKPICKING: 633,
  SKILL_PET_BAT: 653,
  SKILL_PET_HYENA: 654,
  SKILL_PET_BIRD_OF_PREY: 655,
  SKILL_PET_WIND_SERPENT: 656,
  SKILL_LANG_GUTTERSPEAK: 673,
  SKILL_RIDING_KODO: 713,
  SKILL_RACIAL_TROLL: 733,
  SKILL_RACIAL_GNOME: 753,
  SKILL_RACIAL_HUMAN: 754,
  SKILL_JEWELCRAFTING: 755,
  SKILL_RACIAL_BLOODELF: 756,
  SKILL_PET_EVENT_RC: 758,
  SKILL_LANG_DRAENEI: 759,
  SKILL_RACIAL_DRAENEI: 760,
  SKILL_PET_FELGUARD: 761,
  SKILL_RIDING: 762,
  SKILL_PET_DRAGONHAWK: 763,
  SKILL_PET_NETHER_RAY: 764,
  SKILL_PET_SPOREBAT: 765,
  SKILL_PET_WARP_STALKER: 766,
  SKILL_PET_RAVAGER: 767,
  SKILL_PET_SERPENT: 768,
  SKILL_INTERNAL: 769,
  SKILL_DK_BLOOD: 770,
  SKILL_DK_FROST: 771,
  SKILL_DK_UNHOLY: 772,
  SKILL_INSCRIPTION: 773,
  SKILL_PET_MOTH: 775,
  SKILL_RUNEFORGING: 776,
  SKILL_MOUNTS: 777,
  SKILL_COMPANIONS: 778,
  SKILL_PET_EXOTIC_CHIMAERA: 780,
  SKILL_PET_EXOTIC_DEVILSAUR: 781,
  SKILL_PET_GHOUL: 782,
  SKILL_PET_EXOTIC_SILITHID: 783,
  SKILL_PET_EXOTIC_WORM: 784,
  SKILL_PET_WASP: 785,
  SKILL_PET_EXOTIC_RHINO: 786,
  SKILL_PET_EXOTIC_CORE_HOUND: 787,
  SKILL_PET_EXOTIC_SPIRIT_BEAST: 788,
} as const;

/** SharedDefines.h `MAX_SKILL_TYPE`. */
export const MAX_SKILL_TYPE = 789;

const SKILL_DEFENSE = SkillType.SKILL_DEFENSE;
const SKILL_UNARMED = SkillType.SKILL_UNARMED;
const SKILL_FIST_WEAPONS = SkillType.SKILL_FIST_WEAPONS;
const SKILL_LOCKPICKING = SkillType.SKILL_LOCKPICKING;
const SKILL_RUNEFORGING = SkillType.SKILL_RUNEFORGING;
const SKILL_FISHING = SkillType.SKILL_FISHING;
const SKILL_COOKING = SkillType.SKILL_COOKING;
const SKILL_FIRST_AID = SkillType.SKILL_FIRST_AID;
const SKILL_RIDING = SkillType.SKILL_RIDING;
const SKILL_HERBALISM = SkillType.SKILL_HERBALISM;
const SKILL_JEWELCRAFTING = SkillType.SKILL_JEWELCRAFTING;
const SKILL_INSCRIPTION = SkillType.SKILL_INSCRIPTION;
const SKILL_SKINNING = SkillType.SKILL_SKINNING;
const SKILL_MINING = SkillType.SKILL_MINING;

// ---------------------------------------------------------------------------------------------
// Player.h / ObjectMgr.h constants
// ---------------------------------------------------------------------------------------------

/** Player.h `PLAYER_MAX_SKILLS` (client limit; the 128th field slot is never used). */
export const PLAYER_MAX_SKILLS = 127;
/** 128 slots x 3 uint32 in the update-field block. */
export const PLAYER_SKILL_FIELD_COUNT = 384;
/** UpdateFields.h `PLAYER_SKILL_INFO_1_1` = UNIT_END + 0x01E8. */
export const PLAYER_SKILL_INFO_1_1 = 0x0006 + 0x008e + 0x01e8;

/** Player.h `SkillUpdateState`. */
export const SKILL_UNCHANGED = 0;
export const SKILL_CHANGED = 1;
export const SKILL_NEW = 2;
export const SKILL_DELETED = 3;
export type SkillUpdateState = 0 | 1 | 2 | 3;

/** ObjectMgr.h `SkillRangeType`. */
export const SKILL_RANGE_LANGUAGE = 0;
export const SKILL_RANGE_LEVEL = 1;
export const SKILL_RANGE_MONO = 2;
export const SKILL_RANGE_RANK = 3;
export const SKILL_RANGE_NONE = 4;
export type SkillRangeType = 0 | 1 | 2 | 3 | 4;

/** DBCEnums.h `AchievementCriteriaTypes` used by the skill system. */
export const ACHIEVEMENT_CRITERIA_TYPE_REACH_SKILL_LEVEL = 7;
export const ACHIEVEMENT_CRITERIA_TYPE_LEARN_SKILL_LEVEL = 40;

/** Unit.h `WeaponAttackType`. */
export const BASE_ATTACK = 0;
export const OFF_ATTACK = 1;
export const RANGED_ATTACK = 2;

const CLASS_DEATH_KNIGHT = 6;

/** ItemTemplate.h. */
export const ITEM_CLASS_WEAPON = 2;
export const ITEM_CLASS_ARMOR = 4;
export const ITEM_SUBCLASS_WEAPON_FIST = 13;
export const ITEM_SUBCLASS_WEAPON_FISHING_POLE = 20;
const MAX_ITEM_SUBCLASS_WEAPON = 21;
const MAX_ITEM_SUBCLASS_ARMOR = 11;

/** SharedDefines.h `CLASSMASK_ALL_PLAYABLE`. */
export const CLASSMASK_ALL_PLAYABLE =
  (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 10) | (1 << 5);
/** RaceMgr playable mask for stock 3.3.5a ChrRaces.dbc (1-8, 10, 11). */
export const RACEMASK_ALL_PLAYABLE_335 = 0x6ff;
const MAX_CLASSES = 12;

// ---------------------------------------------------------------------------------------------
// Pair helpers (Player.h / Define.h)
// ---------------------------------------------------------------------------------------------

/** `MAKE_PAIR32(uint16 l, uint16 h)`. */
export function makePair32(lo: number, hi: number): number {
  return ((lo & 0xffff) | ((hi & 0xffff) << 16)) >>> 0;
}

function pairLo(value: number): number {
  return value & 0xffff;
}

function pairHi(value: number): number {
  return (value >>> 16) & 0xffff;
}

function int16(value: number): number {
  return (value << 16) >> 16;
}

/** `SKILL_VALUE`, `SKILL_MAX`, `SKILL_TEMP_BONUS`, `SKILL_PERM_BONUS`. */
export const skillValueOf = pairLo;
export const skillMaxOf = pairHi;
export function skillTempBonusOf(value: number): number {
  return int16(pairLo(value));
}
export function skillPermBonusOf(value: number): number {
  return int16(pairHi(value));
}

function skillIndex(pos: number): number {
  return pos * 3;
}
function skillValueIndex(pos: number): number {
  return pos * 3 + 1;
}
function skillBonusIndex(pos: number): number {
  return pos * 3 + 2;
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

/** The world config values the skill system reads (defaults from WorldConfig.cpp). */
export type SkillConfig = {
  /** CONFIG_MAX_PLAYER_LEVEL ("MaxPlayerLevel"). */
  maxPlayerLevel: number;
  /** CONFIG_ALWAYS_MAX_SKILL_FOR_LEVEL ("AlwaysMaxSkillForLevel"). */
  alwaysMaxSkillForLevel: boolean;
  /** CONFIG_ALWAYS_MAXSKILL ("AlwaysMaxWeaponSkill"). */
  alwaysMaxWeaponSkill: boolean;
  skillChanceOrange: number;
  skillChanceYellow: number;
  skillChanceGreen: number;
  skillChanceGrey: number;
  skillChanceMiningSteps: number;
  skillChanceSkinningSteps: number;
  skillGainCrafting: number;
  skillGainDefense: number;
  skillGainGathering: number;
  skillGainWeapon: number;
  /** CONFIG_TRIAL_TRADE_SKILL_CAP ("Trial.TradeSkillCap"); 0 disables. */
  trialTradeSkillCap: number;
};

export const DEFAULT_SKILL_CONFIG: Readonly<SkillConfig> = {
  maxPlayerLevel: 80,
  alwaysMaxSkillForLevel: false,
  alwaysMaxWeaponSkill: false,
  skillChanceOrange: 100,
  skillChanceYellow: 75,
  skillChanceGreen: 25,
  skillChanceGrey: 0,
  skillChanceMiningSteps: 0,
  skillChanceSkinningSteps: 0,
  skillGainCrafting: 1,
  skillGainDefense: 1,
  skillGainGathering: 1,
  skillGainWeapon: 1,
  trialTradeSkillCap: 100,
};

export function skillConfigFromWorld(config: WorldConfig): SkillConfig {
  return {
    maxPlayerLevel: config.getUInt(ServerConfig.CONFIG_MAX_PLAYER_LEVEL),
    alwaysMaxSkillForLevel: config.getBool(ServerConfig.CONFIG_ALWAYS_MAX_SKILL_FOR_LEVEL),
    alwaysMaxWeaponSkill: config.getBool(ServerConfig.CONFIG_ALWAYS_MAXSKILL),
    skillChanceOrange: config.getUInt(ServerConfig.CONFIG_SKILL_CHANCE_ORANGE),
    skillChanceYellow: config.getUInt(ServerConfig.CONFIG_SKILL_CHANCE_YELLOW),
    skillChanceGreen: config.getUInt(ServerConfig.CONFIG_SKILL_CHANCE_GREEN),
    skillChanceGrey: config.getUInt(ServerConfig.CONFIG_SKILL_CHANCE_GREY),
    skillChanceMiningSteps: config.getUInt(ServerConfig.CONFIG_SKILL_CHANCE_MINING_STEPS),
    skillChanceSkinningSteps: config.getUInt(ServerConfig.CONFIG_SKILL_CHANCE_SKINNING_STEPS),
    skillGainCrafting: config.getUInt(ServerConfig.CONFIG_SKILL_GAIN_CRAFTING),
    skillGainDefense: config.getUInt(ServerConfig.CONFIG_SKILL_GAIN_DEFENSE),
    skillGainGathering: config.getUInt(ServerConfig.CONFIG_SKILL_GAIN_GATHERING),
    skillGainWeapon: config.getUInt(ServerConfig.CONFIG_SKILL_GAIN_WEAPON),
    trialTradeSkillCap: config.getUInt(ServerConfig.CONFIG_TRIAL_TRADE_SKILL_CAP),
  };
}

/** `World::GetConfigMaxSkillValue`. */
export function configMaxSkillValue(maxPlayerLevel: number): number {
  const lvl = maxPlayerLevel & 0xffff;
  return (lvl > 60 ? 300 + Math.trunc(((lvl - 60) * 75) / 10) : lvl * 5) & 0xffff;
}

/** `Acore::XP::GetGrayLevel`. */
export function grayLevel(playerLevel: number): number {
  const pl = playerLevel & 0xff;
  let level: number;
  if (pl <= 5) {
    level = 0;
  } else if (pl <= 39) {
    level = pl - 5 - Math.trunc(pl / 10);
  } else if (pl <= 59) {
    level = pl - 1 - Math.trunc(pl / 5);
  } else {
    level = pl - 9;
  }
  return level & 0xff;
}

// ---------------------------------------------------------------------------------------------
// DBC lookups
// ---------------------------------------------------------------------------------------------

/**
 * Categories used when SkillLine.dbc is not loaded. Only the categories whose value changes
 * behavior are listed (GetSkillRangeType: armor / languages; IsPrimaryProfessionSkill:
 * profession); every other skill falls through to SKILL_RANGE_LEVEL, which is also what the
 * real DBC yields for weapon, class, attribute, secondary and generic skills without a tier.
 */
const FALLBACK_SKILL_CATEGORY = new Map<number, number>([
  // SKILL_CATEGORY_LANGUAGES
  [SkillType.SKILL_LANG_COMMON, SKILL_CATEGORY_LANGUAGES],
  [SkillType.SKILL_LANG_ORCISH, SKILL_CATEGORY_LANGUAGES],
  [SkillType.SKILL_LANG_DWARVEN, SKILL_CATEGORY_LANGUAGES],
  [SkillType.SKILL_LANG_DARNASSIAN, SKILL_CATEGORY_LANGUAGES],
  [SkillType.SKILL_LANG_TAURAHE, SKILL_CATEGORY_LANGUAGES],
  [SkillType.SKILL_LANG_THALASSIAN, SKILL_CATEGORY_LANGUAGES],
  [SkillType.SKILL_LANG_DRACONIC, SKILL_CATEGORY_LANGUAGES],
  [SkillType.SKILL_LANG_DEMON_TONGUE, SKILL_CATEGORY_LANGUAGES],
  [SkillType.SKILL_LANG_TITAN, SKILL_CATEGORY_LANGUAGES],
  [SkillType.SKILL_LANG_OLD_TONGUE, SKILL_CATEGORY_LANGUAGES],
  [SkillType.SKILL_LANG_GNOMISH, SKILL_CATEGORY_LANGUAGES],
  [SkillType.SKILL_LANG_TROLL, SKILL_CATEGORY_LANGUAGES],
  [SkillType.SKILL_LANG_GUTTERSPEAK, SKILL_CATEGORY_LANGUAGES],
  [SkillType.SKILL_LANG_DRAENEI, SKILL_CATEGORY_LANGUAGES],
  // SKILL_CATEGORY_ARMOR
  [SkillType.SKILL_CLOTH, SKILL_CATEGORY_ARMOR],
  [SkillType.SKILL_LEATHER, SKILL_CATEGORY_ARMOR],
  [SkillType.SKILL_MAIL, SKILL_CATEGORY_ARMOR],
  [SkillType.SKILL_PLATE_MAIL, SKILL_CATEGORY_ARMOR],
  [SkillType.SKILL_SHIELD, SKILL_CATEGORY_ARMOR],
  // SKILL_CATEGORY_PROFESSION
  [SkillType.SKILL_BLACKSMITHING, SKILL_CATEGORY_PROFESSION],
  [SkillType.SKILL_LEATHERWORKING, SKILL_CATEGORY_PROFESSION],
  [SkillType.SKILL_ALCHEMY, SKILL_CATEGORY_PROFESSION],
  [SkillType.SKILL_HERBALISM, SKILL_CATEGORY_PROFESSION],
  [SkillType.SKILL_MINING, SKILL_CATEGORY_PROFESSION],
  [SkillType.SKILL_TAILORING, SKILL_CATEGORY_PROFESSION],
  [SkillType.SKILL_ENGINEERING, SKILL_CATEGORY_PROFESSION],
  [SkillType.SKILL_ENCHANTING, SKILL_CATEGORY_PROFESSION],
  [SkillType.SKILL_SKINNING, SKILL_CATEGORY_PROFESSION],
  [SkillType.SKILL_JEWELCRAFTING, SKILL_CATEGORY_PROFESSION],
  [SkillType.SKILL_INSCRIPTION, SKILL_CATEGORY_PROFESSION],
  // SKILL_CATEGORY_SECONDARY
  [SkillType.SKILL_FIRST_AID, SKILL_CATEGORY_SECONDARY],
  [SkillType.SKILL_COOKING, SKILL_CATEGORY_SECONDARY],
  [SkillType.SKILL_FISHING, SKILL_CATEGORY_SECONDARY],
  [SkillType.SKILL_RIDING, SKILL_CATEGORY_SECONDARY],
]);

/**
 * `sSkillLineStore.LookupEntry(id)`. With SkillLine.dbc absent every non-zero id is treated as
 * present, with `FALLBACK_SKILL_CATEGORY` (or 0) as its category.
 */
export function skillLineEntry(data: SkillData, skillId: number): SkillLineEntry | null {
  if (data.skillLines) {
    return data.skillLines.get(skillId) ?? null;
  }
  if (!skillId) {
    return null;
  }
  return { id: skillId, categoryId: FALLBACK_SKILL_CATEGORY.get(skillId) ?? 0, name: "", spellIcon: 0, canLink: 0 };
}

/**
 * DBCStores.cpp `GetSkillRaceClassInfo`. With SkillRaceClassInfo.dbc absent the race/class
 * combination cannot be checked, so a permissive entry (masks 0, flags 0, no tier) is returned
 * for any skill that `skillLineEntry` accepts. Nothing is deleted on load in that mode.
 */
export function getSkillRaceClassInfo(
  data: SkillData,
  skillId: number,
  race: number,
  classId: number,
): SkillRaceClassInfoEntry | null {
  if (!data.raceClassInfoBySkill) {
    if (!skillLineEntry(data, skillId)) {
      return null;
    }
    return { id: 0, skillId, raceMask: 0, classMask: 0, flags: 0, skillTierId: 0 };
  }
  const list = data.raceClassInfoBySkill.get(skillId);
  if (!list) {
    return null;
  }
  const raceBit = (1 << (race - 1)) >>> 0;
  const classBit = (1 << (classId - 1)) >>> 0;
  for (const entry of list) {
    if (entry.raceMask && !((entry.raceMask & raceBit) >>> 0)) {
      continue;
    }
    if (entry.classMask && !((entry.classMask & classBit) >>> 0)) {
      continue;
    }
    return entry;
  }
  return null;
}

/** ObjectMgr.cpp `GetSkillRangeType`. */
export function getSkillRangeType(data: SkillData, rcEntry: SkillRaceClassInfoEntry): SkillRangeType {
  const skill = skillLineEntry(data, rcEntry.skillId);
  if (!skill) {
    return SKILL_RANGE_NONE;
  }
  if (data.skillTiers?.has(rcEntry.skillTierId)) {
    return SKILL_RANGE_RANK;
  }
  if (rcEntry.skillId === SKILL_RUNEFORGING) {
    return SKILL_RANGE_MONO;
  }
  switch (skill.categoryId) {
    case SKILL_CATEGORY_ARMOR:
      return SKILL_RANGE_MONO;
    case SKILL_CATEGORY_LANGUAGES:
      return SKILL_RANGE_LANGUAGE;
  }
  return SKILL_RANGE_LEVEL;
}

/** SpellMgr.cpp `IsPrimaryProfessionSkill`. */
export function isPrimaryProfessionSkill(data: SkillData, skillId: number): boolean {
  const skill = skillLineEntry(data, skillId);
  return skill !== null && skill.categoryId === SKILL_CATEGORY_PROFESSION;
}

/** SpellMgr.h `IsProfessionSkill`. */
export function isProfessionSkill(data: SkillData, skillId: number): boolean {
  return (
    isPrimaryProfessionSkill(data, skillId) ||
    skillId === SKILL_FISHING ||
    skillId === SKILL_COOKING ||
    skillId === SKILL_FIRST_AID
  );
}

/** SpellMgr.h `IsProfessionOrRidingSkill`. */
export function isProfessionOrRidingSkill(data: SkillData, skillId: number): boolean {
  return isProfessionSkill(data, skillId) || skillId === SKILL_RIDING;
}

function hasSpellInfo(data: SkillData, spellId: number): boolean {
  return data.spells ? data.spells.has(spellId) : true;
}

// ---------------------------------------------------------------------------------------------
// ItemTemplate::GetSkill
// ---------------------------------------------------------------------------------------------

const ITEM_WEAPON_SKILLS: readonly number[] = [
  SkillType.SKILL_AXES, SkillType.SKILL_2H_AXES, SkillType.SKILL_BOWS, SkillType.SKILL_GUNS, SkillType.SKILL_MACES,
  SkillType.SKILL_2H_MACES, SkillType.SKILL_POLEARMS, SkillType.SKILL_SWORDS, SkillType.SKILL_2H_SWORDS, 0,
  SkillType.SKILL_STAVES, 0, 0, SkillType.SKILL_FIST_WEAPONS, 0,
  SkillType.SKILL_DAGGERS, SkillType.SKILL_THROWN, SkillType.SKILL_ASSASSINATION, SkillType.SKILL_CROSSBOWS, SkillType.SKILL_WANDS,
  SkillType.SKILL_FISHING,
];

const ITEM_ARMOR_SKILLS: readonly number[] = [
  0, SkillType.SKILL_CLOTH, SkillType.SKILL_LEATHER, SkillType.SKILL_MAIL, SkillType.SKILL_PLATE_MAIL, 0,
  SkillType.SKILL_SHIELD, 0, 0, 0, 0,
];

/** ItemTemplate.h `ItemTemplate::GetSkill`. */
export function itemSkill(itemClass: number, subClass: number): number {
  switch (itemClass) {
    case ITEM_CLASS_WEAPON:
      return subClass >= MAX_ITEM_SUBCLASS_WEAPON || subClass < 0 ? 0 : ITEM_WEAPON_SKILLS[subClass]!;
    case ITEM_CLASS_ARMOR:
      return subClass >= MAX_ITEM_SUBCLASS_ARMOR || subClass < 0 ? 0 : ITEM_ARMOR_SKILLS[subClass]!;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Skill gain formulas (PlayerUpdates.cpp)
// ---------------------------------------------------------------------------------------------

/** `SkillGainChance` (per-mille). */
export function skillGainChance(
  config: SkillConfig,
  skillValue: number,
  grayLevelValue: number,
  greenLevel: number,
  yellowLevel: number,
): number {
  if (skillValue >= grayLevelValue) {
    return config.skillChanceGrey * 10;
  }
  if (skillValue >= greenLevel) {
    return config.skillChanceGreen * 10;
  }
  if (skillValue >= yellowLevel) {
    return config.skillChanceYellow * 10;
  }
  return config.skillChanceOrange * 10;
}

/** `CraftSkillGainChance` (per-mille). */
export function craftSkillGainChance(
  config: SkillConfig,
  skillValue: number,
  grayLevelValue: number,
  yellowLevel: number,
): number {
  const orangeChance = config.skillChanceOrange * 10;
  const grayChance = config.skillChanceGrey * 10;
  if (grayLevelValue <= yellowLevel) {
    return skillValue < grayLevelValue ? orangeChance : grayChance;
  }
  if (skillValue <= yellowLevel) {
    return orangeChance;
  }
  if (skillValue >= grayLevelValue) {
    return grayChance;
  }
  return grayChance + Math.trunc(((grayLevelValue - skillValue) * (orangeChance - grayChance)) / (grayLevelValue - yellowLevel));
}

const FISHING_BOUNDS = [115, 135, 160, 190, 215, 295, 315, 355, 425, 450];
const FISHING_DENS = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 1];

/** `getProbabilityOfLevelUp` (percent, float). */
export function fishingLevelUpProbability(skillValue: number): number {
  if (!skillValue) {
    return 0;
  }
  let index = FISHING_BOUNDS.findIndex((bound) => bound >= skillValue);
  if (index < 0) {
    index = FISHING_BOUNDS.length;
  }
  return Math.fround(100 / FISHING_DENS[index]!);
}

/** `bonusSkillLevels` in PlayerUpdates.cpp. */
const BONUS_SKILL_LEVELS = [75, 150, 225, 300, 375, 450];

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/**
 * Side effects the C++ performs through other systems, in the order it performs them.
 * - learnSpell: learnSkillRewardedSpells learn path. Out of world: `addSpell(spell, SPEC_MASK_ALL,
 *   true, temporary=true)`; in world: `learnSpell(spell, temporary=true, learnFromSkill=true)`.
 *   Emitted even when the player already knows the spell (addSpell ignores duplicates).
 * - unlearnSpell: learnSkillRewardedSpells value-too-low path: `removeSpell(spell, activeSpec, onlyTemporary=true)`.
 * - removeSpell / removeAuras: SetSkill(id, 0) path: `removeSpell(firstInChain(spell), SPEC_MASK_ALL, false)`
 *   and `RemoveAurasDueToSpell(spell)` for every SkillLineAbility of the skill.
 * - skillEnchantments: `UpdateSkillEnchantments(skill, oldValue, newValue)`.
 * - achievementCriteria: `UpdateAchievementCriteria(type, skill)`.
 * - applySkillAuras: re-run SPELL_AURA_MOD_SKILL / SPELL_AURA_MOD_SKILL_TALENT effects whose misc value is `skill`
 *   (they call `modifySkillBonus`).
 * - defenseBonuses: `UpdateDefenseBonusesMod()`.
 * - critPercentages: `UpdateAllCritPercentages()`.
 */
export type SkillEvent =
  | { type: "learnSpell"; skill: number; spell: number; inWorld: boolean }
  | { type: "unlearnSpell"; skill: number; spell: number }
  | { type: "removeSpell"; skill: number; spell: number }
  | { type: "removeAuras"; skill: number; spell: number }
  | { type: "skillEnchantments"; skill: number; oldValue: number; newValue: number }
  | { type: "achievementCriteria"; criteriaType: number; skill: number }
  | { type: "applySkillAuras"; skill: number }
  | { type: "defenseBonuses" }
  | { type: "critPercentages" };

/** Net spell changes from an event list (later events win). */
export function spellChangesFromEvents(events: readonly SkillEvent[]): { learn: number[]; remove: number[] } {
  const state = new Map<number, boolean>();
  for (const event of events) {
    if (event.type === "learnSpell") {
      state.set(event.spell, true);
    } else if (event.type === "unlearnSpell" || event.type === "removeSpell") {
      state.set(event.spell, false);
    }
  }
  const learn: number[] = [];
  const remove: number[] = [];
  for (const [spell, learned] of state) {
    (learned ? learn : remove).push(spell);
  }
  return { learn, remove };
}

// ---------------------------------------------------------------------------------------------
// PlayerSkills
// ---------------------------------------------------------------------------------------------

/** `SkillStatusData`. */
export type SkillStatusData = { pos: number; uState: SkillUpdateState };

export type SkillRow = { skill: number; value: number; max: number };

/** `PlayerCreateInfoSkill`. */
export type PlayerCreateInfoSkill = { skillId: number; rank: number };

export type SkillRandom = {
  /** `irand` (inclusive). */
  irand(min: number, max: number): number;
  /** `roll_chance_f`. */
  rollChanceF(chance: number): boolean;
};

export type PlayerSkillsOwner = { race: number; classId: number; level: number };

export type PlayerSkillsOptions = {
  data: SkillData;
  config?: Partial<SkillConfig>;
  random?: SkillRandom;
  /** `sSpellMgr->GetFirstSpellInChain`; identity when spell chains are not loaded. */
  firstSpellInChain?: (spellId: number) => number;
};

/** A weapon as the skill code sees it (`Item*` with template Class/SubClass and IsBroken()). */
export type SkillWeapon = { itemClass: number; subClass: number; broken?: boolean };

export type UpdateWeaponSkillArgs = {
  attackType: number;
  /** `GetWeaponForAttack(attType, true)`. */
  weapon: SkillWeapon | null;
  /** Optional explicit item (spell's `m_weaponItem`). */
  item?: SkillWeapon | null;
  /** `IsInFeralForm()` (cat, bear, dire bear, ghost wolf). */
  inFeralForm?: boolean;
  /** `GetShapeshiftForm() == FORM_TREE`. */
  inTreeForm?: boolean;
  /** Victim is a creature with CREATURE_FLAG_EXTRA_NO_SKILL_GAINS. */
  victimNoSkillGains?: boolean;
};

export type UpdateCombatSkillsArgs = UpdateWeaponSkillArgs & {
  /** `defence ? victim->getLevelForTarget(player) : victim->GetLevel()`. */
  victimLevel: number;
  defence: boolean;
  /** `GetStat(STAT_INTELLECT)`. */
  intellect: number;
};

export class PlayerSkills {
  race: number;
  classId: number;
  level: number;
  /** `IsInWorld()`; controls learnSpell vs addSpell in learnSkillRewardedSpells. */
  inWorld = false;
  /** `GetSession()->IsTrialAccount()`. */
  trialAccount = false;
  /** `GetActiveSpec()`; reported for unlearnSpell callers. */
  activeSpec = 0;

  readonly data: SkillData;
  readonly config: SkillConfig;
  private readonly random: SkillRandom;
  private readonly firstSpellInChain: (spellId: number) => number;

  private readonly fields = new Uint32Array(PLAYER_SKILL_FIELD_COUNT);
  private readonly changedFields = new Set<number>();
  private readonly status = new Map<number, SkillStatusData>();
  private events: SkillEvent[] = [];

  constructor(owner: PlayerSkillsOwner, options: PlayerSkillsOptions) {
    this.race = owner.race;
    this.classId = owner.classId;
    this.level = owner.level;
    this.data = options.data;
    this.config = { ...DEFAULT_SKILL_CONFIG, ...options.config };
    this.random = options.random ?? { irand: defaultIrand, rollChanceF: defaultRollChanceF };
    this.firstSpellInChain = options.firstSpellInChain ?? ((spellId) => spellId);
  }

  // --- update fields -------------------------------------------------------------------------

  private getField(index: number): number {
    return this.fields[index]!;
  }

  /** `Object::SetUInt32Value`: only marks the field when the value changes. */
  private setField(index: number, value: number): void {
    const next = value >>> 0;
    if (this.fields[index] !== next) {
      this.fields[index] = next;
      this.changedFields.add(index);
    }
  }

  /** The 384 uint32 values of PLAYER_SKILL_INFO_1_1 .. +383 (copy). */
  fieldValues(): Uint32Array {
    return this.fields.slice();
  }

  /** Relative indices (0..383) changed since the last `flushChangedFields`, ascending. */
  changedFieldIndices(): number[] {
    return [...this.changedFields].sort((a, b) => a - b);
  }

  /** Returns and clears the changed relative indices (add PLAYER_SKILL_INFO_1_1 for absolute). */
  flushChangedFields(): number[] {
    const indices = this.changedFieldIndices();
    this.changedFields.clear();
    return indices;
  }

  // --- events --------------------------------------------------------------------------------

  drainEvents(): SkillEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  private emit(event: SkillEvent): void {
    this.events.push(event);
  }

  // --- status map ----------------------------------------------------------------------------

  private live(skill: number): SkillStatusData | null {
    const itr = this.status.get(skill);
    if (!itr || itr.uState === SKILL_DELETED) {
      return null;
    }
    return itr;
  }

  /** Read-only view of `mSkillStatus` (insertion order). */
  statusMap(): ReadonlyMap<number, Readonly<SkillStatusData>> {
    return this.status;
  }

  /** Non-deleted skills in slot order, as character_skills rows. */
  rows(): SkillRow[] {
    const out: { pos: number; row: SkillRow }[] = [];
    for (const [skill, itr] of this.status) {
      if (itr.uState === SKILL_DELETED) {
        continue;
      }
      const data = this.getField(skillValueIndex(itr.pos));
      out.push({ pos: itr.pos, row: { skill, value: skillValueOf(data), max: skillMaxOf(data) } });
    }
    return out.sort((a, b) => a.pos - b.pos).map((entry) => entry.row);
  }

  /** `Unit::GetMaxSkillValueForLevel` (Player override only adds a script hook). */
  maxSkillValueForLevel(): number {
    return (this.level * 5) & 0xffff;
  }

  rcInfo(skill: number): SkillRaceClassInfoEntry | null {
    return getSkillRaceClassInfo(this.data, skill, this.race, this.classId);
  }

  // --- load / save ---------------------------------------------------------------------------

  /**
   * `Player::_LoadSkills`. Rows come from `SELECT skill, value, max FROM character_skills WHERE guid = ?`.
   * Returns skills stored with value 0; the C++ deletes those rows immediately
   * (`loadFromDb` does it for you).
   */
  load(rows: readonly SkillRow[]): { zeroValueSkills: number[] } {
    this.fields.fill(0);
    this.changedFields.clear();
    this.status.clear();
    const zeroValueSkills: number[] = [];
    const loadedSkillValues = new Map<number, number>();
    let count = 0;

    for (const row of rows) {
      const skill = row.skill & 0xffff;
      let value = row.value & 0xffff;
      let max = row.max & 0xffff;

      const rcEntry = this.rcInfo(skill);
      if (!rcEntry) {
        // invalid for race/class: mark for deletion in the database
        this.status.set(skill, { pos: 0, uState: SKILL_DELETED });
        continue;
      }

      switch (getSkillRangeType(this.data, rcEntry)) {
        case SKILL_RANGE_LANGUAGE:
          value = max = 300;
          break;
        case SKILL_RANGE_MONO:
          value = max = 1;
          break;
        case SKILL_RANGE_LEVEL:
          max = this.maxSkillValueForLevel();
          break;
        default:
          break;
      }

      if (value === 0) {
        zeroValueSkills.push(skill);
        continue;
      }

      // Faithful to the C++, which compares Value[skillStep] (always Value[0]) on every iteration:
      // the step is 1 when the tier's first value equals max, otherwise 0.
      let skillStep = 0;
      const tier = this.data.skillTiers?.get(rcEntry.skillTierId);
      if (tier) {
        for (let i = 0; i < MAX_SKILL_STEP; i += 1) {
          if (tier.value[skillStep] === max) {
            skillStep = i + 1;
            break;
          }
        }
      }

      this.setField(skillIndex(count), makePair32(skill, skillStep));
      this.setField(skillValueIndex(count), makePair32(value, max));
      this.setField(skillBonusIndex(count), 0);
      this.status.set(skill, { pos: count, uState: SKILL_UNCHANGED });
      loadedSkillValues.set(skill, value);

      count += 1;
      if (count >= PLAYER_MAX_SKILLS) {
        break;
      }
    }

    for (const [skill, value] of loadedSkillValues) {
      this.learnSkillRewardedSpells(skill, value);
    }

    return { zeroValueSkills };
  }

  /** Loads from character_skills (ordered by primary key) and deletes zero-value rows like the C++. */
  async loadFromDb(db: DbExecutor, guid: number): Promise<{ zeroValueSkills: number[] }> {
    const rows: SkillRow[] = await db
      .select({ skill: character_skills.skill, value: character_skills.value, max: character_skills.max })
      .from(character_skills)
      .where(eq(character_skills.guid, guid))
      .orderBy(asc(character_skills.skill));
    const result = this.load(rows);
    for (const skill of result.zeroValueSkills) {
      await db.delete(character_skills).where(and(eq(character_skills.guid, guid), eq(character_skills.skill, skill)));
    }
    return result;
  }

  /**
   * `Player::_SaveSkills`: writes only NEW / CHANGED / DELETED rows, then marks everything
   * UNCHANGED and drops DELETED entries. Call inside the caller's save transaction.
   */
  async save(db: DbExecutor, guid: number): Promise<void> {
    // CHAR_DEL_CHAR_SKILL_BY_SKILL, CHAR_INS_CHAR_SKILLS, CHAR_UDP_CHAR_SKILLS
    for (const [skill, itr] of [...this.status]) {
      if (itr.uState === SKILL_UNCHANGED) {
        continue;
      }
      if (itr.uState === SKILL_DELETED) {
        await db.delete(character_skills).where(and(eq(character_skills.guid, guid), eq(character_skills.skill, skill)));
        this.status.delete(skill);
        continue;
      }
      const valueData = this.getField(skillValueIndex(itr.pos));
      const value = skillValueOf(valueData);
      const max = skillMaxOf(valueData);
      if (itr.uState === SKILL_NEW) {
        await db.insert(character_skills).values({ guid, skill: skill & 0xffff, value, max });
      } else if (itr.uState === SKILL_CHANGED) {
        await db
          .update(character_skills)
          .set({ value, max })
          .where(and(eq(character_skills.guid, guid), eq(character_skills.skill, skill & 0xffff)));
      }
      itr.uState = SKILL_UNCHANGED;
    }
  }

  // --- SetSkill ------------------------------------------------------------------------------

  /** `Player::SetSkill`. A value of 0 removes the skill. */
  setSkill(idIn: number, stepIn: number, newValIn: number, maxValIn: number): void {
    const id = idIn & 0xffff;
    const step = stepIn & 0xffff;
    const newVal = newValIn & 0xffff;
    const maxVal = maxValIn & 0xffff;
    if (!id) {
      return;
    }

    const itr = this.status.get(id);
    if (itr && itr.uState !== SKILL_DELETED) {
      const currVal = skillValueOf(this.getField(skillValueIndex(itr.pos)));
      if (newVal) {
        if (newVal < currVal) {
          this.emit({ type: "skillEnchantments", skill: id, oldValue: currVal, newValue: newVal });
        }
        this.setField(skillIndex(itr.pos), makePair32(id, step));
        this.setField(skillValueIndex(itr.pos), makePair32(newVal, maxVal));
        if (itr.uState !== SKILL_NEW) {
          itr.uState = SKILL_CHANGED;
        }
        this.learnSkillRewardedSpells(id, newVal);
        if (newVal > currVal) {
          this.emit({ type: "skillEnchantments", skill: id, oldValue: currVal, newValue: newVal });
        }
        this.emit({ type: "achievementCriteria", criteriaType: ACHIEVEMENT_CRITERIA_TYPE_REACH_SKILL_LEVEL, skill: id });
        this.emit({ type: "achievementCriteria", criteriaType: ACHIEVEMENT_CRITERIA_TYPE_LEARN_SKILL_LEVEL, skill: id });
      } else {
        this.emit({ type: "skillEnchantments", skill: id, oldValue: currVal, newValue: 0 });
        this.setField(skillIndex(itr.pos), 0);
        this.setField(skillValueIndex(itr.pos), 0);
        this.setField(skillBonusIndex(itr.pos), 0);
        if (itr.uState !== SKILL_NEW) {
          itr.uState = SKILL_DELETED;
        } else {
          this.status.delete(id);
        }
        for (const ability of this.data.abilitiesBySkillLine.get(id) ?? []) {
          this.emit({ type: "removeSpell", skill: id, spell: this.firstSpellInChain(ability.spell) });
          this.emit({ type: "removeAuras", skill: id, spell: ability.spell });
        }
      }
      return;
    }

    if (!newVal) {
      return;
    }

    for (let i = 0; i < PLAYER_MAX_SKILLS; i += 1) {
      if (this.getField(skillIndex(i))) {
        continue;
      }
      if (!skillLineEntry(this.data, id)) {
        return;
      }
      this.setField(skillIndex(i), makePair32(id, step));
      this.setField(skillValueIndex(i), makePair32(newVal, maxVal));
      this.emit({ type: "skillEnchantments", skill: id, oldValue: 0, newValue: newVal });

      if (itr) {
        itr.pos = i;
        itr.uState = SKILL_CHANGED;
      } else {
        this.status.set(id, { pos: i, uState: SKILL_NEW });
      }

      this.setField(skillBonusIndex(i), 0);
      this.emit({ type: "applySkillAuras", skill: id });

      this.learnSkillRewardedSpells(id, newVal);
      this.emit({ type: "achievementCriteria", criteriaType: ACHIEVEMENT_CRITERIA_TYPE_REACH_SKILL_LEVEL, skill: id });
      this.emit({ type: "achievementCriteria", criteriaType: ACHIEVEMENT_CRITERIA_TYPE_LEARN_SKILL_LEVEL, skill: id });
      return;
    }
  }

  // --- getters -------------------------------------------------------------------------------

  hasSkill(skill: number): boolean {
    if (!skill) {
      return false;
    }
    return this.live(skill) !== null;
  }

  getSkillStep(skill: number): number {
    const itr = skill ? this.live(skill) : null;
    return itr ? pairHi(this.getField(skillIndex(itr.pos))) : 0;
  }

  getSkillValue(skill: number): number {
    const itr = skill ? this.live(skill) : null;
    if (!itr) {
      return 0;
    }
    const bonus = this.getField(skillBonusIndex(itr.pos));
    let result = skillValueOf(this.getField(skillValueIndex(itr.pos)));
    result += skillTempBonusOf(bonus);
    result += skillPermBonusOf(bonus);
    return result < 0 ? 0 : result & 0xffff;
  }

  getMaxSkillValue(skill: number): number {
    const itr = skill ? this.live(skill) : null;
    if (!itr) {
      return 0;
    }
    const bonus = this.getField(skillBonusIndex(itr.pos));
    let result = skillMaxOf(this.getField(skillValueIndex(itr.pos)));
    result += skillTempBonusOf(bonus);
    result += skillPermBonusOf(bonus);
    return result < 0 ? 0 : result & 0xffff;
  }

  getPureMaxSkillValue(skill: number): number {
    const itr = skill ? this.live(skill) : null;
    return itr ? skillMaxOf(this.getField(skillValueIndex(itr.pos))) : 0;
  }

  getBaseSkillValue(skill: number): number {
    const itr = skill ? this.live(skill) : null;
    if (!itr) {
      return 0;
    }
    let result = skillValueOf(this.getField(skillValueIndex(itr.pos)));
    result += skillPermBonusOf(this.getField(skillBonusIndex(itr.pos)));
    return result < 0 ? 0 : result & 0xffff;
  }

  getPureSkillValue(skill: number): number {
    const itr = skill ? this.live(skill) : null;
    return itr ? skillValueOf(this.getField(skillValueIndex(itr.pos))) : 0;
  }

  getSkillPermBonusValue(skill: number): number {
    const itr = skill ? this.live(skill) : null;
    return itr ? skillPermBonusOf(this.getField(skillBonusIndex(itr.pos))) : 0;
  }

  getSkillTempBonusValue(skill: number): number {
    const itr = skill ? this.live(skill) : null;
    return itr ? skillTempBonusOf(this.getField(skillBonusIndex(itr.pos))) : 0;
  }

  /** `Player::GetBaseDefenseSkillValue`. */
  getBaseDefenseSkillValue(): number {
    return this.getBaseSkillValue(SKILL_DEFENSE);
  }

  /** `Player::GetBaseWeaponSkillValue` with `weapon` = `GetWeaponForAttack(attType, true)`. */
  getBaseWeaponSkillValue(attackType: number, weapon: SkillWeapon | null): number {
    if (attackType !== BASE_ATTACK && !weapon) {
      return 0;
    }
    const skill = weapon ? itemSkill(weapon.itemClass, weapon.subClass) : SKILL_UNARMED;
    return this.getBaseSkillValue(skill);
  }

  /**
   * `Player::ModifySkillBonus`. `talent` (SPELL_AURA_MOD_SKILL_TALENT) changes the permanent
   * (high) half; otherwise the temporary/item (low) half.
   */
  modifySkillBonus(skillId: number, val: number, talent: boolean): void {
    const itr = this.live(skillId);
    if (!itr) {
      return;
    }
    const bonusIndex = skillBonusIndex(itr.pos);
    const bonusVal = this.getField(bonusIndex);
    const tempBonus = skillTempBonusOf(bonusVal);
    const permBonus = skillPermBonusOf(bonusVal);
    if (talent) {
      this.setField(bonusIndex, makePair32(tempBonus, permBonus + val));
    } else {
      this.setField(bonusIndex, makePair32(tempBonus + val, permBonus));
    }
  }

  // --- spells --------------------------------------------------------------------------------

  /** `Player::learnSkillRewardedSpells`. */
  learnSkillRewardedSpells(skillId: number, skillValue: number): void {
    const raceMask = (1 << (this.race - 1)) >>> 0;
    const classMask = (1 << (this.classId - 1)) >>> 0;
    const abilities = [...(this.data.abilitiesBySkillLine.get(skillId) ?? [])].sort(
      (a, b) => a.minSkillLineRank - b.minSkillLineRank,
    );

    for (const ability of abilities) {
      if (!hasSpellInfo(this.data, ability.spell)) {
        continue;
      }
      if (
        ability.acquireMethod !== SKILL_LINE_ABILITY_LEARNED_ON_SKILL_VALUE &&
        ability.acquireMethod !== SKILL_LINE_ABILITY_LEARNED_ON_SKILL_LEARN
      ) {
        continue;
      }
      if (ability.raceMask && !((ability.raceMask & raceMask) >>> 0)) {
        continue;
      }
      if (ability.classMask && !((ability.classMask & classMask) >>> 0)) {
        continue;
      }

      if (skillValue < ability.minSkillLineRank && ability.acquireMethod === SKILL_LINE_ABILITY_LEARNED_ON_SKILL_VALUE) {
        this.emit({ type: "unlearnSpell", skill: skillId, spell: ability.spell });
        continue;
      }

      if (ability.acquireMethod === SKILL_LINE_ABILITY_LEARNED_ON_SKILL_LEARN && ability.supercededBySpell) {
        let skipCurrent = false;
        for (const other of this.data.abilitiesBySpell.get(ability.supercededBySpell) ?? []) {
          if (other.acquireMethod === SKILL_LINE_ABILITY_LEARNED_ON_SKILL_LEARN && skillValue >= other.minSkillLineRank) {
            skipCurrent = true;
            break;
          }
        }
        if (skipCurrent) {
          continue;
        }
      }

      this.emit({ type: "learnSpell", skill: skillId, spell: ability.spell, inWorld: this.inWorld });
    }
  }

  // --- default skills ------------------------------------------------------------------------

  /** `Player::LearnDefaultSkills` over the race/class `PlayerInfo::skills` list. */
  learnDefaultSkills(createSkills: readonly PlayerCreateInfoSkill[]): void {
    for (const entry of createSkills) {
      if (this.hasSkill(entry.skillId)) {
        continue;
      }
      this.learnDefaultSkill(entry.skillId, entry.rank);
    }
  }

  /** `Player::LearnDefaultSkill`. */
  learnDefaultSkill(skillId: number, rank: number): void {
    const rcInfo = this.rcInfo(skillId);
    if (!rcInfo) {
      return;
    }
    const isDeathKnight = this.classId === CLASS_DEATH_KNIGHT;
    switch (getSkillRangeType(this.data, rcInfo)) {
      case SKILL_RANGE_LANGUAGE:
        this.setSkill(skillId, 0, 300, 300);
        break;
      case SKILL_RANGE_LEVEL: {
        let skillValue = 1;
        const maxValue = this.maxSkillValueForLevel();
        if (this.config.alwaysMaxWeaponSkill && !isProfessionOrRidingSkill(this.data, skillId)) {
          skillValue = maxValue;
        } else if (rcInfo.flags & SKILL_FLAG_ALWAYS_MAX_VALUE) {
          skillValue = maxValue;
        } else if (isDeathKnight) {
          skillValue = Math.min(Math.max(1, ((this.level - 1) * 5) & 0xffff), maxValue);
        } else if (skillId === SKILL_FIST_WEAPONS) {
          skillValue = Math.max(1, this.getSkillValue(SKILL_UNARMED));
        } else if (skillId === SKILL_LOCKPICKING) {
          // The C++ reads SKILL_LOCKPICKING itself here (0 when not known yet).
          skillValue = Math.max(1, this.getSkillValue(SKILL_LOCKPICKING));
        }
        this.setSkill(skillId, 0, skillValue, maxValue);
        break;
      }
      case SKILL_RANGE_MONO:
        this.setSkill(skillId, 0, 1, 1);
        break;
      case SKILL_RANGE_RANK: {
        if (!rank) {
          break;
        }
        const tier = this.data.skillTiers!.get(rcInfo.skillTierId)!;
        const maxValue = tier.value[Math.max(rank - 1, 0)] ?? 0;
        let skillValue = 1;
        if (rcInfo.flags & SKILL_FLAG_ALWAYS_MAX_VALUE) {
          skillValue = maxValue;
        } else if (isDeathKnight) {
          skillValue = Math.min(Math.max(1, ((this.level - 1) * 5) & 0xffff), maxValue);
        }
        this.setSkill(skillId, rank, skillValue, maxValue);
        break;
      }
      default:
        break;
    }
  }

  // --- level ---------------------------------------------------------------------------------

  /** `Player::UpdateSkillsForLevel`. Pass the new level (or set `level` first). */
  updateSkillsForLevel(level: number = this.level): void {
    this.level = level;
    const maxconfskill = configMaxSkillValue(this.config.maxPlayerLevel);
    const maxSkill = this.maxSkillValueForLevel();
    const alwaysMaxSkill = this.config.alwaysMaxSkillForLevel;

    for (const [pskill, itr] of this.status) {
      if (itr.uState === SKILL_DELETED) {
        continue;
      }
      const rcEntry = this.rcInfo(pskill);
      if (!rcEntry) {
        continue;
      }
      if (getSkillRangeType(this.data, rcEntry) !== SKILL_RANGE_LEVEL) {
        continue;
      }
      const valueIndex = skillValueIndex(itr.pos);
      const data = this.getField(valueIndex);
      const max = skillMaxOf(data);
      const val = skillValueOf(data);

      if (max !== 1) {
        if (alwaysMaxSkill || rcEntry.flags & SKILL_FLAG_ALWAYS_MAX_VALUE) {
          this.setField(valueIndex, makePair32(maxSkill, maxSkill));
          if (itr.uState !== SKILL_NEW) {
            itr.uState = SKILL_CHANGED;
          }
        } else if (max !== maxconfskill) {
          this.setField(valueIndex, makePair32(val, maxSkill));
          if (itr.uState !== SKILL_NEW) {
            itr.uState = SKILL_CHANGED;
          }
        }
      }
    }
  }

  /** `Player::UpdateSkillsToMaxSkillsForLevel` (.levelup / AlwaysMaxWeaponSkill). */
  updateSkillsToMaxSkillsForLevel(): void {
    for (const [pskill, itr] of this.status) {
      if (itr.uState === SKILL_DELETED) {
        continue;
      }
      if (isProfessionOrRidingSkill(this.data, pskill)) {
        continue;
      }
      const valueIndex = skillValueIndex(itr.pos);
      const max = skillMaxOf(this.getField(valueIndex));
      if (max > 1) {
        this.setField(valueIndex, makePair32(max, max));
        if (itr.uState !== SKILL_NEW) {
          itr.uState = SKILL_CHANGED;
        }
      }
      if (pskill === SKILL_DEFENSE) {
        this.emit({ type: "defenseBonuses" });
      }
    }
  }

  // --- skill gains ---------------------------------------------------------------------------

  /** `Player::UpdateSkill`: skill + step, capped at max. */
  updateSkill(skillId: number, step: number): boolean {
    if (!skillId) {
      return false;
    }
    const itr = this.live(skillId);
    if (!itr) {
      return false;
    }
    const valueIndex = skillValueIndex(itr.pos);
    const data = this.getField(valueIndex);
    const value = skillValueOf(data);
    const max = skillMaxOf(data);
    if (!max || !value || value >= max) {
      return false;
    }
    let newValue = value + step;
    if (newValue > max) {
      newValue = max;
    }
    this.setField(valueIndex, makePair32(newValue, max));
    if (itr.uState !== SKILL_NEW) {
      itr.uState = SKILL_CHANGED;
    }
    this.emit({ type: "skillEnchantments", skill: skillId, oldValue: value, newValue });
    this.emit({ type: "achievementCriteria", criteriaType: ACHIEVEMENT_CRITERIA_TYPE_REACH_SKILL_LEVEL, skill: skillId });
    return true;
  }

  /** `Player::UpdateSkillPro`: `chance` is per-mille, rolled with `irand(1, 1000)`. */
  updateSkillPro(skillIdIn: number, chance: number, step: number): boolean {
    const skillId = skillIdIn & 0xffff;
    if (!skillId) {
      return false;
    }
    if (chance <= 0) {
      return false;
    }
    const itr = this.live(skillId);
    if (!itr) {
      return false;
    }
    const valueIndex = skillValueIndex(itr.pos);
    const data = this.getField(valueIndex);
    const skillValue = skillValueOf(data);
    const maxValue = skillMaxOf(data);
    if (!maxValue || !skillValue || skillValue >= maxValue) {
      return false;
    }
    const trialSkillCap = this.config.trialTradeSkillCap;
    if (trialSkillCap && this.trialAccount && skillValue >= trialSkillCap) {
      return false;
    }

    const roll = this.random.irand(1, 1000);
    if (roll > chance) {
      return false;
    }

    let newValue = skillValue + step;
    if (newValue > maxValue) {
      newValue = maxValue;
    }
    this.setField(valueIndex, makePair32(newValue, maxValue));
    if (itr.uState !== SKILL_NEW) {
      itr.uState = SKILL_CHANGED;
    }
    for (const bsl of BONUS_SKILL_LEVELS) {
      if (skillValue < bsl && newValue >= bsl) {
        this.learnSkillRewardedSpells(skillId, newValue);
        break;
      }
    }
    this.emit({ type: "skillEnchantments", skill: skillId, oldValue: skillValue, newValue });
    this.emit({ type: "achievementCriteria", criteriaType: ACHIEVEMENT_CRITERIA_TYPE_REACH_SKILL_LEVEL, skill: skillId });
    return true;
  }

  /** `Player::UpdateGatherSkill`. */
  updateGatherSkill(skillId: number, skillValue: number, redLevel: number, multiplicator = 1): boolean {
    const gain = this.config.skillGainGathering;
    const chance = () => skillGainChance(this.config, skillValue, redLevel + 100, redLevel + 50, redLevel + 25) * multiplicator;
    switch (skillId) {
      case SKILL_HERBALISM:
      case SKILL_LOCKPICKING:
      case SKILL_JEWELCRAFTING:
      case SKILL_INSCRIPTION:
        return this.updateSkillPro(skillId, chance(), gain);
      case SKILL_SKINNING: {
        const steps = this.config.skillChanceSkinningSteps;
        if (steps === 0) {
          return this.updateSkillPro(skillId, chance(), gain);
        }
        return this.updateSkillPro(skillId, chance() >> Math.trunc(skillValue / steps), gain);
      }
      case SKILL_MINING: {
        const steps = this.config.skillChanceMiningSteps;
        if (steps === 0) {
          return this.updateSkillPro(skillId, chance(), gain);
        }
        return this.updateSkillPro(skillId, chance() >> Math.trunc(skillValue / steps), gain);
      }
    }
    return false;
  }

  /**
   * `Player::UpdateCraftSkill`. Alchemy discoveries (MECHANIC_DISCOVERY + skill_discovery_template)
   * are the spell system's job and are not handled here.
   */
  updateCraftSkill(spellId: number): boolean {
    for (const ability of this.data.abilitiesBySpell.get(spellId) ?? []) {
      if (!ability.skillLine) {
        continue;
      }
      const skillValue = this.getPureSkillValue(ability.skillLine);
      return this.updateSkillPro(
        ability.skillLine,
        craftSkillGainChance(this.config, skillValue, ability.trivialSkillLineRankHigh, ability.trivialSkillLineRankLow),
        this.config.skillGainCrafting,
      );
    }
    return false;
  }

  /** `Player::UpdateFishingSkill`. */
  updateFishingSkill(): boolean {
    const skillValue = this.getPureSkillValue(SKILL_FISHING);
    if (skillValue >= this.getMaxSkillValue(SKILL_FISHING)) {
      return false;
    }
    return this.updateSkillPro(
      SKILL_FISHING,
      Math.trunc(fishingLevelUpProbability(skillValue)) * 10,
      this.config.skillGainGathering,
    );
  }

  /** `Player::UpdateDefense`. */
  updateDefense(): boolean {
    if (this.updateSkill(SKILL_DEFENSE, this.config.skillGainDefense)) {
      this.emit({ type: "defenseBonuses" });
      return true;
    }
    return false;
  }

  /** `Player::UpdateWeaponSkill`. */
  updateWeaponSkill(args: UpdateWeaponSkillArgs): void {
    if (args.inFeralForm) {
      return;
    }
    if (args.inTreeForm) {
      return;
    }
    if (args.victimNoSkillGains) {
      return;
    }
    const gain = this.config.skillGainWeapon;
    let tmpitem = args.weapon;
    const item = args.item ?? null;
    if (item && item !== tmpitem && !item.broken) {
      tmpitem = item;
    }

    if (!tmpitem && args.attackType === BASE_ATTACK) {
      this.updateSkill(SKILL_UNARMED, gain);
      this.updateSkill(SKILL_FIST_WEAPONS, gain);
    } else if (tmpitem && tmpitem.subClass !== ITEM_SUBCLASS_WEAPON_FISHING_POLE) {
      if (tmpitem.subClass === ITEM_SUBCLASS_WEAPON_FIST) {
        this.updateSkill(SKILL_UNARMED, gain);
      }
      this.updateSkill(itemSkill(tmpitem.itemClass, tmpitem.subClass), gain);
    }

    this.emit({ type: "critPercentages" });
  }

  /** `Player::UpdateCombatSkills`. Rolls with `roll_chance_f`. */
  updateCombatSkills(args: UpdateCombatSkillsArgs): void {
    const playerLevel = this.level & 0xff;
    const currentSkillValue = args.defence
      ? this.getBaseDefenseSkillValue()
      : this.getBaseWeaponSkillValue(args.attackType, args.weapon);
    const currentSkillMax = (5 * playerLevel) & 0xffff;
    const skillDiff = currentSkillMax - currentSkillValue;
    if (skillDiff <= 0) {
      return;
    }

    const greylevel = grayLevel(playerLevel);
    let moblevel = args.victimLevel & 0xff;
    if (moblevel > playerLevel + 5) {
      moblevel = (playerLevel + 5) & 0xff;
    }
    let lvldif = int16(moblevel - greylevel);
    if (lvldif < 3) {
      lvldif = 3;
    }

    let chance = Math.fround(Math.fround(3 * lvldif * skillDiff) / playerLevel);
    if (!args.defence) {
      chance = Math.fround(chance + Math.fround(Math.fround(chance * Math.fround(0.02)) * Math.fround(args.intellect)));
    }
    chance = chance < 1 ? 1 : chance;

    if (this.random.rollChanceF(chance)) {
      if (args.defence) {
        this.updateDefense();
      } else {
        this.updateWeaponSkill(args);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// playercreateinfo_skills (ObjectMgr::LoadPlayerInfo)
// ---------------------------------------------------------------------------------------------

type CreateSkillRow = { raceMask: number; classMask: number; skill: number; rank: number };

/**
 * `ObjectMgr::LoadPlayerInfo` "Player Create Skills" for every playable race/class.
 * Key is `race * 256 + classId`. Rows are read in primary-key order like the MySQL scan.
 */
export function loadPlayerCreateSkills(
  world: WorldTables,
  data: SkillData,
  playableRaceMask: number = RACEMASK_ALL_PLAYABLE_335,
): Map<number, PlayerCreateInfoSkill[]> {
  const rows: CreateSkillRow[] = [...world.all(playercreateinfo_skills)].sort(
    (left, right) => left.raceMask - right.raceMask || left.classMask - right.classMask || left.skill - right.skill,
  );
  let maxRaces = 1;
  for (let race = 1; race <= 32; race += 1) {
    if ((playableRaceMask >>> (race - 1)) & 1) {
      maxRaces = race + 1;
    }
  }
  const out = new Map<number, PlayerCreateInfoSkill[]>();
  for (const row of rows) {
    const raceMask = row.raceMask >>> 0;
    const classMask = row.classMask >>> 0;
    const skill: PlayerCreateInfoSkill = { skillId: row.skill & 0xffff, rank: row.rank & 0xffff };
    if (skill.rank >= MAX_SKILL_STEP) {
      continue;
    }
    if (raceMask !== 0 && !((raceMask & playableRaceMask) >>> 0)) {
      continue;
    }
    if (classMask !== 0 && !((classMask & CLASSMASK_ALL_PLAYABLE) >>> 0)) {
      continue;
    }
    if (!skillLineEntry(data, skill.skillId)) {
      continue;
    }
    for (let race = 1; race < maxRaces; race += 1) {
      if (raceMask !== 0 && !((raceMask >>> (race - 1)) & 1)) {
        continue;
      }
      if (!((playableRaceMask >>> (race - 1)) & 1)) {
        // `_playerInfo[race][class]` only exists for playercreateinfo races; skip non-playable ones.
        continue;
      }
      for (let classId = 1; classId < MAX_CLASSES; classId += 1) {
        if (classMask !== 0 && !((classMask >>> (classId - 1)) & 1)) {
          continue;
        }
        if (!((CLASSMASK_ALL_PLAYABLE >>> (classId - 1)) & 1)) {
          continue;
        }
        if (!getSkillRaceClassInfo(data, skill.skillId, race, classId)) {
          continue;
        }
        const key = race * 256 + classId;
        const list = out.get(key);
        if (list) {
          list.push({ ...skill });
        } else {
          out.set(key, [{ ...skill }]);
        }
      }
    }
  }
  return out;
}

/** `PlayerInfo::skills` for one race/class (empty when none). */
export function playerCreateSkillsFor(
  table: ReadonlyMap<number, PlayerCreateInfoSkill[]>,
  race: number,
  classId: number,
): PlayerCreateInfoSkill[] {
  return table.get(race * 256 + classId) ?? [];
}

// ---------------------------------------------------------------------------------------------
// Languages (SharedDefines.h `Language`, ObjectMgr.cpp `lang_description`)
// ---------------------------------------------------------------------------------------------

export const LANG_UNIVERSAL = 0;
export const LANG_ORCISH = 1;
export const LANG_DARNASSIAN = 2;
export const LANG_TAURAHE = 3;
export const LANG_DWARVISH = 6;
export const LANG_COMMON = 7;
export const LANG_DEMONIC = 8;
export const LANG_TITAN = 9;
export const LANG_THALASSIAN = 10;
export const LANG_DRACONIC = 11;
export const LANG_KALIMAG = 12;
export const LANG_GNOMISH = 13;
export const LANG_TROLL = 14;
export const LANG_GUTTERSPEAK = 33;
export const LANG_DRAENEI = 35;
export const LANG_ZOMBIE = 36;
export const LANG_GNOMISH_BINARY = 37;
export const LANG_GOBLIN_BINARY = 38;
export const LANG_ADDON = 0xffffffff;

/** ObjectMgr.h `LanguageDesc`. */
export type LanguageDesc = { langId: number; spellId: number; skillId: number };

/** ObjectMgr.cpp `lang_description[LANGUAGES_COUNT]`. */
export const LANG_DESCRIPTION: readonly LanguageDesc[] = [
  { langId: LANG_ADDON, spellId: 0, skillId: 0 },
  { langId: LANG_UNIVERSAL, spellId: 0, skillId: 0 },
  { langId: LANG_ORCISH, spellId: 669, skillId: SkillType.SKILL_LANG_ORCISH },
  { langId: LANG_DARNASSIAN, spellId: 671, skillId: SkillType.SKILL_LANG_DARNASSIAN },
  { langId: LANG_TAURAHE, spellId: 670, skillId: SkillType.SKILL_LANG_TAURAHE },
  { langId: LANG_DWARVISH, spellId: 672, skillId: SkillType.SKILL_LANG_DWARVEN },
  { langId: LANG_COMMON, spellId: 668, skillId: SkillType.SKILL_LANG_COMMON },
  { langId: LANG_DEMONIC, spellId: 815, skillId: SkillType.SKILL_LANG_DEMON_TONGUE },
  { langId: LANG_TITAN, spellId: 816, skillId: SkillType.SKILL_LANG_TITAN },
  { langId: LANG_THALASSIAN, spellId: 813, skillId: SkillType.SKILL_LANG_THALASSIAN },
  { langId: LANG_DRACONIC, spellId: 814, skillId: SkillType.SKILL_LANG_DRACONIC },
  { langId: LANG_KALIMAG, spellId: 817, skillId: SkillType.SKILL_LANG_OLD_TONGUE },
  { langId: LANG_GNOMISH, spellId: 7340, skillId: SkillType.SKILL_LANG_GNOMISH },
  { langId: LANG_TROLL, spellId: 7341, skillId: SkillType.SKILL_LANG_TROLL },
  { langId: LANG_GUTTERSPEAK, spellId: 17737, skillId: SkillType.SKILL_LANG_GUTTERSPEAK },
  { langId: LANG_DRAENEI, spellId: 29932, skillId: SkillType.SKILL_LANG_DRAENEI },
  { langId: LANG_ZOMBIE, spellId: 0, skillId: 0 },
  { langId: LANG_GNOMISH_BINARY, spellId: 0, skillId: 0 },
  { langId: LANG_GOBLIN_BINARY, spellId: 0, skillId: 0 },
];

/** `GetLanguageDescByID` (lang compared as uint32). */
export function languageDesc(lang: number): LanguageDesc | null {
  const id = lang >>> 0;
  return LANG_DESCRIPTION.find((desc) => desc.langId >>> 0 === id) ?? null;
}

/** Skill id required for `lang`: 0 = no skill needed, null = unknown language. */
export function languageSkill(lang: number): number | null {
  const desc = languageDesc(lang);
  return desc ? desc.skillId : null;
}

export type SpeakLanguageResult = "ok" | "unknown-language" | "not-learned";

/**
 * ChatHandler.cpp `HandleMessagechatOpcode` language gate:
 * unknown language -> LANG_UNKNOWN_LANGUAGE notification; a language whose skill the sender lacks
 * and no SPELL_AURA_COMPREHEND_LANGUAGE aura with that misc value -> LANG_NOT_LEARNED_LANGUAGE.
 */
export function canSpeakLanguage(
  skills: { hasSkill(skill: number): boolean },
  lang: number,
  comprehendLanguageMiscValues: Iterable<number> = [],
): SpeakLanguageResult {
  const desc = languageDesc(lang);
  if (!desc) {
    return "unknown-language";
  }
  if (desc.skillId !== 0 && !skills.hasSkill(desc.skillId)) {
    const wanted = lang | 0;
    for (const misc of comprehendLanguageMiscValues) {
      if ((misc | 0) === wanted) {
        return "ok";
      }
    }
    return "not-learned";
  }
  return "ok";
}

