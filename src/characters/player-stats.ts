import {
  GT_MAX_LEVEL,
  GT_MAX_RATING,
  ssdMultiplier,
  ssvArmorMod,
  ssvDpsMod,
  ssvFeralBonus,
  ssvIsTwoHand,
  ssvSpellBonus,
  type ScalingStatValuesEntry,
  type StatDbcStores,
} from "../data/dbc-stats.ts";

/** Player stat system from `StatSystem.cpp`, `Player::_ApplyItemBonuses`, and the Player rating/crit helpers. */

const OBJECT_END = 0x0006;
const UNIT_END = OBJECT_END + 0x008e;
export const PLAYER_END = UNIT_END + 0x049a;

export const UNIT_FIELD_HEALTH = OBJECT_END + 0x0012;
export const UNIT_FIELD_POWER1 = OBJECT_END + 0x0013;
export const UNIT_FIELD_MAXHEALTH = OBJECT_END + 0x001a;
export const UNIT_FIELD_MAXPOWER1 = OBJECT_END + 0x001b;
export const UNIT_FIELD_POWER_REGEN_FLAT_MODIFIER = OBJECT_END + 0x0022;
export const UNIT_FIELD_POWER_REGEN_INTERRUPTED_FLAT_MODIFIER = OBJECT_END + 0x0029;
export const UNIT_FIELD_LEVEL = OBJECT_END + 0x0030;
export const UNIT_FIELD_FLAGS = OBJECT_END + 0x0035;
export const UNIT_FIELD_FLAGS_2 = OBJECT_END + 0x0036;
export const UNIT_FIELD_AURASTATE = OBJECT_END + 0x0037;
export const UNIT_FIELD_BASEATTACKTIME = OBJECT_END + 0x0038;
export const UNIT_FIELD_RANGEDATTACKTIME = OBJECT_END + 0x003a;
export const UNIT_FIELD_MINDAMAGE = OBJECT_END + 0x0040;
export const UNIT_FIELD_MAXDAMAGE = OBJECT_END + 0x0041;
export const UNIT_FIELD_MINOFFHANDDAMAGE = OBJECT_END + 0x0042;
export const UNIT_FIELD_MAXOFFHANDDAMAGE = OBJECT_END + 0x0043;
export const UNIT_MOD_CAST_SPEED = OBJECT_END + 0x004a;
export const UNIT_FIELD_STAT0 = OBJECT_END + 0x004e;
export const UNIT_FIELD_POSSTAT0 = OBJECT_END + 0x0053;
export const UNIT_FIELD_NEGSTAT0 = OBJECT_END + 0x0058;
export const UNIT_FIELD_RESISTANCES = OBJECT_END + 0x005d;
export const UNIT_FIELD_RESISTANCEBUFFMODSPOSITIVE = OBJECT_END + 0x0064;
export const UNIT_FIELD_RESISTANCEBUFFMODSNEGATIVE = OBJECT_END + 0x006b;
export const UNIT_FIELD_BASE_MANA = OBJECT_END + 0x0072;
export const UNIT_FIELD_BASE_HEALTH = OBJECT_END + 0x0073;
export const UNIT_FIELD_ATTACK_POWER = OBJECT_END + 0x0075;
export const UNIT_FIELD_ATTACK_POWER_MODS = OBJECT_END + 0x0076;
export const UNIT_FIELD_ATTACK_POWER_MULTIPLIER = OBJECT_END + 0x0077;
export const UNIT_FIELD_RANGED_ATTACK_POWER = OBJECT_END + 0x0078;
export const UNIT_FIELD_RANGED_ATTACK_POWER_MODS = OBJECT_END + 0x0079;
export const UNIT_FIELD_RANGED_ATTACK_POWER_MULTIPLIER = OBJECT_END + 0x007a;
export const UNIT_FIELD_MINRANGEDDAMAGE = OBJECT_END + 0x007b;
export const UNIT_FIELD_MAXRANGEDDAMAGE = OBJECT_END + 0x007c;
export const UNIT_FIELD_POWER_COST_MODIFIER = OBJECT_END + 0x007d;
export const UNIT_FIELD_POWER_COST_MULTIPLIER = OBJECT_END + 0x0084;
export const PLAYER_XP = UNIT_END + 0x01e6;
export const PLAYER_NEXT_LEVEL_XP = UNIT_END + 0x01e7;
export const PLAYER_CHARACTER_POINTS1 = UNIT_END + 0x0368;
export const PLAYER_CHARACTER_POINTS2 = UNIT_END + 0x0369;
export const PLAYER_BLOCK_PERCENTAGE = UNIT_END + 0x036c;
export const PLAYER_DODGE_PERCENTAGE = UNIT_END + 0x036d;
export const PLAYER_PARRY_PERCENTAGE = UNIT_END + 0x036e;
export const PLAYER_EXPERTISE = UNIT_END + 0x036f;
export const PLAYER_OFFHAND_EXPERTISE = UNIT_END + 0x0370;
export const PLAYER_CRIT_PERCENTAGE = UNIT_END + 0x0371;
export const PLAYER_RANGED_CRIT_PERCENTAGE = UNIT_END + 0x0372;
export const PLAYER_OFFHAND_CRIT_PERCENTAGE = UNIT_END + 0x0373;
export const PLAYER_SPELL_CRIT_PERCENTAGE1 = UNIT_END + 0x0374;
export const PLAYER_SHIELD_BLOCK = UNIT_END + 0x037b;
export const PLAYER_NO_REAGENT_COST_1 = UNIT_END + 0x0489;
export const PLAYER_FIELD_MOD_DAMAGE_DONE_POS = UNIT_END + 0x03ff;
export const PLAYER_FIELD_MOD_DAMAGE_DONE_NEG = UNIT_END + 0x0406;
export const PLAYER_FIELD_MOD_DAMAGE_DONE_PCT = UNIT_END + 0x040d;
export const PLAYER_FIELD_MOD_HEALING_DONE_POS = UNIT_END + 0x0414;
export const PLAYER_FIELD_MOD_TARGET_RESISTANCE = UNIT_END + 0x0417;
export const PLAYER_FIELD_MOD_TARGET_PHYSICAL_RESISTANCE = UNIT_END + 0x0418;
export const PLAYER_FIELD_COMBAT_RATING_1 = UNIT_END + 0x043b;
export const PLAYER_FIELD_MAX_LEVEL = UNIT_END + 0x046b;

const UNIT_FLAG_PLAYER_CONTROLLED = 0x00000008;
const UNIT_FLAG2_REGENERATE_POWER = 0x00000800;

/**
 * Fields other players receive. Everything else the stat system writes is PRIVATE/OWNER
 * in `UpdateFieldFlags.cpp` and only goes to the owner.
 */
export const PUBLIC_STAT_FIELDS: ReadonlySet<number> = new Set([
  UNIT_FIELD_HEALTH,
  ...Array.from({ length: 7 }, (_, i) => UNIT_FIELD_POWER1 + i),
  UNIT_FIELD_MAXHEALTH,
  ...Array.from({ length: 7 }, (_, i) => UNIT_FIELD_MAXPOWER1 + i),
  UNIT_FIELD_LEVEL,
  UNIT_FIELD_FLAGS,
  UNIT_FIELD_FLAGS_2,
  UNIT_FIELD_AURASTATE,
  UNIT_FIELD_BASEATTACKTIME,
  UNIT_FIELD_BASEATTACKTIME + 1,
  UNIT_MOD_CAST_SPEED,
  UNIT_FIELD_BASE_MANA,
]);

export const STAT_STRENGTH = 0;
export const STAT_AGILITY = 1;
export const STAT_STAMINA = 2;
export const STAT_INTELLECT = 3;
export const STAT_SPIRIT = 4;
export const MAX_STATS = 5;

export const POWER_MANA = 0;
export const POWER_RAGE = 1;
export const POWER_FOCUS = 2;
export const POWER_ENERGY = 3;
export const POWER_HAPPINESS = 4;
export const POWER_RUNE = 5;
export const POWER_RUNIC_POWER = 6;
export const MAX_POWERS = 7;

export const BASE_ATTACK = 0;
export const OFF_ATTACK = 1;
export const RANGED_ATTACK = 2;
const MAX_ATTACK = 3;

const MINDAMAGE = 0;
const MAXDAMAGE = 1;
const MAX_ITEM_PROTO_DAMAGES = 2;
const MAX_SPELL_SCHOOL = 7;

export const BASE_MINDAMAGE = 1;
export const BASE_MAXDAMAGE = 2;
export const BASE_ATTACK_TIME = 2000;

const UNIT_MOD_STAT_START = 0;
const UNIT_MOD_HEALTH = 5;
const UNIT_MOD_MANA = 6;
const UNIT_MOD_POWER_START = UNIT_MOD_MANA;
const UNIT_MOD_ARMOR = 13;
const UNIT_MOD_RESISTANCE_START = UNIT_MOD_ARMOR;
const UNIT_MOD_ATTACK_POWER = 20;
const UNIT_MOD_ATTACK_POWER_RANGED = 21;
const UNIT_MOD_DAMAGE_MAINHAND = 22;
const UNIT_MOD_DAMAGE_OFFHAND = 23;
const UNIT_MOD_DAMAGE_RANGED = 24;
const UNIT_MOD_END = 25;

const BASE_VALUE = 0;
const TOTAL_VALUE = 1;
const BASE_PCT = 0;
const TOTAL_PCT = 1;

const CRIT_PERCENTAGE = 0;
const RANGED_CRIT_PERCENTAGE = 1;
const OFFHAND_CRIT_PERCENTAGE = 2;
const SHIELD_BLOCK_VALUE = 3;
const BASEMOD_END = 4;

export const CR_WEAPON_SKILL = 0;
export const CR_DEFENSE_SKILL = 1;
export const CR_DODGE = 2;
export const CR_PARRY = 3;
export const CR_BLOCK = 4;
export const CR_HIT_MELEE = 5;
export const CR_HIT_RANGED = 6;
export const CR_HIT_SPELL = 7;
export const CR_CRIT_MELEE = 8;
export const CR_CRIT_RANGED = 9;
export const CR_CRIT_SPELL = 10;
export const CR_HIT_TAKEN_MELEE = 11;
export const CR_HIT_TAKEN_RANGED = 12;
export const CR_HIT_TAKEN_SPELL = 13;
export const CR_CRIT_TAKEN_MELEE = 14;
export const CR_CRIT_TAKEN_RANGED = 15;
export const CR_CRIT_TAKEN_SPELL = 16;
export const CR_HASTE_MELEE = 17;
export const CR_HASTE_RANGED = 18;
export const CR_HASTE_SPELL = 19;
export const CR_WEAPON_SKILL_MAINHAND = 20;
export const CR_WEAPON_SKILL_OFFHAND = 21;
export const CR_WEAPON_SKILL_RANGED = 22;
export const CR_EXPERTISE = 23;
export const CR_ARMOR_PENETRATION = 24;
export const MAX_COMBAT_RATING = 25;

export const CLASS_WARRIOR = 1;
export const CLASS_PALADIN = 2;
export const CLASS_HUNTER = 3;
export const CLASS_ROGUE = 4;
export const CLASS_PRIEST = 5;
export const CLASS_DEATH_KNIGHT = 6;
export const CLASS_SHAMAN = 7;
export const CLASS_MAGE = 8;
export const CLASS_WARLOCK = 9;
export const CLASS_DRUID = 11;
const MAX_CLASSES = 12;

export const SKILL_DEFENSE = 95;
export const SKILL_UNARMED = 162;

const ITEM_CLASS_WEAPON = 2;
const ITEM_CLASS_ARMOR = 4;

const ITEM_SUBCLASS_ARMOR_CLOTH = 1;
const ITEM_SUBCLASS_ARMOR_LEATHER = 2;
const ITEM_SUBCLASS_ARMOR_MAIL = 3;
const ITEM_SUBCLASS_ARMOR_PLATE = 4;
const ITEM_SUBCLASS_ARMOR_SHIELD = 6;

const INVTYPE_WEAPON = 13;
const INVTYPE_2HWEAPON = 17;
const INVTYPE_WEAPONMAINHAND = 21;
const INVTYPE_WEAPONOFFHAND = 22;

export const EQUIPMENT_SLOT_MAINHAND = 15;
export const EQUIPMENT_SLOT_OFFHAND = 16;
export const EQUIPMENT_SLOT_RANGED = 17;
const INVENTORY_SLOT_BAG_END = 23;

/** `ItemTemplate::GetSkill` weapon and armor tables. */
const ITEM_WEAPON_SKILLS = [44, 172, 45, 46, 54, 160, 229, 43, 55, 0, 136, 0, 0, 473, 0, 173, 176, 253, 226, 228, 356];
const ITEM_ARMOR_SKILLS = [0, 415, 414, 413, 293, 0, 433, 0, 0, 0, 0];

const M_DIMINISHING_K = [0.956, 0.956, 0.988, 0.988, 0.983, 0.956, 0.988, 0.983, 0.983, 0.0, 0.972];
const MISS_CAP = [16, 16, 16, 16, 16, 16, 16, 16, 16, 0, 16];
const PARRY_CAP = [47.003525, 47.003525, 145.560408, 145.560408, 0, 47.003525, 145.560408, 0, 0, 0, 0];
const DODGE_CAP = [88.129021, 88.129021, 145.560408, 145.560408, 150.37594, 88.129021, 145.560408, 150.37594, 150.37594, 0, 116.890707];
const DODGE_BASE = [0.03664, 0.034943, -0.040873, 0.020957, 0.034178, 0.03664, 0.02108, 0.036587, 0.024211, 0, 0.056097];
const CRIT_TO_DODGE = [0.85 / 1.15, 1 / 1.15, 1.11 / 1.15, 2 / 1.15, 1 / 1.15, 0.85 / 1.15, 1.6 / 1.15, 1 / 1.15, 0.97 / 1.15, 0, 2 / 1.15];

const f = Math.fround;

/** The `item_template` columns `_ApplyItemBonuses`, `_ApplyWeaponDamage`, and `_ApplyAmmoBonuses` read. */
export type StatItemTemplate = {
  entry: number;
  class: number;
  subclass: number;
  InventoryType: number;
  /** `ItemTemplate::ItemStat` — `stat_typeN`/`stat_valueN` with the zero values dropped, like `LoadItemTemplates`. */
  stats: readonly { type: number; value: number }[];
  ScalingStatDistribution: number;
  ScalingStatValue: number;
  damage: readonly { min: number; max: number }[];
  armor: number;
  ArmorDamageModifier: number;
  block: number;
  holy_res: number;
  fire_res: number;
  nature_res: number;
  frost_res: number;
  shadow_res: number;
  arcane_res: number;
  delay: number;
};

/** `item_template` row → `StatItemTemplate`. */
export function statItemFromRow(row: Record<string, unknown>): StatItemTemplate {
  const num = (key: string): number => Number(row[key] ?? 0) || 0;
  const stats: { type: number; value: number }[] = [];
  for (let i = 1; i <= 10; i++) {
    const value = num(`stat_value${i}`);
    if (value !== 0) {
      stats.push({ type: num(`stat_type${i}`), value });
    }
  }
  return {
    entry: num("entry"),
    class: num("class"),
    subclass: num("subclass"),
    InventoryType: num("InventoryType"),
    stats,
    ScalingStatDistribution: num("ScalingStatDistribution"),
    ScalingStatValue: num("ScalingStatValue"),
    damage: [
      { min: num("dmg_min1"), max: num("dmg_max1") },
      { min: num("dmg_min2"), max: num("dmg_max2") },
    ],
    armor: num("armor"),
    ArmorDamageModifier: num("ArmorDamageModifier"),
    block: num("block"),
    holy_res: num("holy_res"),
    fire_res: num("fire_res"),
    nature_res: num("nature_res"),
    frost_res: num("frost_res"),
    shadow_res: num("shadow_res"),
    arcane_res: num("arcane_res"),
    delay: num("delay"),
  };
}

/** `ItemTemplate::GetSkill`. */
export function itemSkill(item: Pick<StatItemTemplate, "class" | "subclass">): number {
  if (item.class === ITEM_CLASS_WEAPON) {
    return ITEM_WEAPON_SKILLS[item.subclass] ?? 0;
  }
  if (item.class === ITEM_CLASS_ARMOR) {
    return ITEM_ARMOR_SKILLS[item.subclass] ?? 0;
  }
  return 0;
}

function itemDps(item: StatItemTemplate): number {
  if (item.delay === 0) {
    return 0;
  }
  let temp = 0;
  for (const damage of item.damage) {
    temp += damage.min + damage.max;
  }
  return f((temp * 500) / item.delay);
}

/** `ItemTemplate::getFeralBonus`. */
function feralBonus(item: StatItemTemplate, extraDps = 0): number {
  const mask = (1 << INVTYPE_WEAPON) | (1 << INVTYPE_2HWEAPON) | (1 << INVTYPE_WEAPONMAINHAND) | (1 << INVTYPE_WEAPONOFFHAND);
  if (item.class === ITEM_CLASS_WEAPON && ((1 << item.InventoryType) & mask) !== 0) {
    const bonus = Math.trunc((extraDps + itemDps(item)) * 14) - 767;
    return bonus < 0 ? 0 : bonus;
  }
  return 0;
}

export type EquippedStatItem = {
  /** `item_instance.guid`, to tell two copies of one entry apart. */
  guid?: number;
  template: StatItemTemplate;
  /** `Item::IsBroken` — `MaxDurability > 0 && durability == 0`. */
  broken: boolean;
};

/** Skill reads the stat system needs. The skill system answers them; without it every value is 0. */
export type StatSkillSource = {
  skillValue(skill: number): number;
  maxSkillValue(skill: number): number;
};

/** `PlayerLevelInfo` + `PlayerClassLevelInfo` for one level (`player_race_stats` + `player_class_stats`). */
export type PlayerLevelStats = {
  baseHealth: number;
  baseMana: number;
  stats: readonly [number, number, number, number, number];
};

/** `Stats.Limits.*` from worldserver.conf. */
export type StatLimits = {
  enable: boolean;
  dodge: number;
  parry: number;
  block: number;
  crit: number;
};

export const DEFAULT_STAT_LIMITS: StatLimits = { enable: false, dodge: 95, parry: 95, block: 95, crit: 95 };

export type PlayerStatsOptions = {
  race: number;
  classId: number;
  level: number;
  maxLevel: number;
  levelStats: PlayerLevelStats;
  stores?: StatDbcStores | null;
  skills?: StatSkillSource | null;
  limits?: StatLimits;
  /** Learned SPELL_EFFECT_PARRY / BLOCK / DUAL_WIELD spells. */
  canParry?: boolean;
  canBlock?: boolean;
  canDualWield?: boolean;
};

/**
 * One player's unit and player update fields that the stat system owns, and the modifier state behind them
 * (`m_auraFlatModifiersGroup`, `m_auraPctModifiersGroup`, `m_baseRatingValue`, `m_auraBaseFlatMod`, ...).
 */
/** The aura side of the stat system (`Unit::GetTotalAuraModifier` reads) that `PlayerStats` defers to once auras exist. */
export type PlayerStatAuraHooks = {
  /** `Unit::UpdateStatBuffMod`: positive and negative buff totals for `UNIT_FIELD_POSSTAT0` / `NEGSTAT0`. */
  statBuffMods(stat: number): { pos: number; neg: number };
  /** `Unit::SpellBaseDamageBonusDone(1 << school)` */
  spellDamageBonus(school: number): number;
  /** `Unit::SpellBaseHealingBonusDone(SPELL_SCHOOL_MASK_ALL)` */
  spellHealingBonus(): number;
};

export class PlayerStats {
  readonly values = new Uint32Array(PLAYER_END);
  /** Set by the player's spell unit; null keeps the item-only values. */
  auraHooks: PlayerStatAuraHooks | null = null;
  private readonly view = new DataView(this.values.buffer);
  private readonly changed = new Set<number>();

  readonly race: number;
  readonly classId: number;
  level: number;
  maxLevel: number;
  private readonly stores: StatDbcStores | null;
  skills: StatSkillSource | null;
  private readonly limits: StatLimits;
  canParry: boolean;
  canBlock: boolean;
  canDualWield: boolean;

  private readonly createStats = [0, 0, 0, 0, 0];
  private readonly auraStatBonuses = [0, 0, 0, 0, 0];
  private createHealth = 0;
  private createMana = 0;
  private readonly flatMods = Array.from({ length: UNIT_MOD_END }, () => [0, 0]);
  private readonly pctMods = Array.from({ length: UNIT_MOD_END }, () => [1, 1]);
  private readonly baseRatingValue = new Array<number>(MAX_COMBAT_RATING).fill(0);
  private readonly auraBaseFlatMod = new Array<number>(BASEMOD_END).fill(0);
  private readonly auraBasePctMod = new Array<number>(BASEMOD_END).fill(1);
  private readonly weaponDamage = Array.from({ length: MAX_ATTACK }, () => [
    [BASE_MINDAMAGE, 0],
    [BASE_MAXDAMAGE, 0],
  ]);
  private readonly modAttackSpeedPct = [1, 1, 1];
  private readonly equipped = new Map<number, EquippedStatItem>();
  private baseSpellPower = 0;
  private baseSpellDamage = 0;
  private baseSpellHealing = 0;
  private baseManaRegen = 0;
  baseHealthRegen = 0;
  private baseFeralAP = 0;
  private spellPenetrationItemMod = 0;
  private ammoDPS = 0;
  /** `m_realDodge` / `m_realParry` — the diminished values combat rolls against. */
  realDodge = 0;
  realParry = 0;
  modMeleeHitChance = 0;
  modRangedHitChance = 0;
  modSpellHitChance = 0;
  expertise = 0;
  offhandExpertise = 0;

  constructor(options: PlayerStatsOptions) {
    this.race = options.race;
    this.classId = options.classId;
    this.level = options.level;
    this.maxLevel = options.maxLevel;
    this.stores = options.stores ?? null;
    this.skills = options.skills ?? null;
    this.limits = options.limits ?? DEFAULT_STAT_LIMITS;
    this.canParry = options.canParry ?? false;
    this.canBlock = options.canBlock ?? false;
    this.canDualWield = options.canDualWield ?? false;
    this.setUInt32(UNIT_FIELD_LEVEL, this.level);
    this.initStatsForLevel(options.levelStats);
  }

  // ---- raw field access -------------------------------------------------------------------

  getUInt32(index: number): number {
    return this.values[index]!;
  }

  getInt32(index: number): number {
    return this.values[index]! | 0;
  }

  getFloat(index: number): number {
    return this.view.getFloat32(index * 4, true);
  }

  setUInt32(index: number, value: number): void {
    const next = value >>> 0;
    if (this.values[index] !== next) {
      this.values[index] = next;
      this.changed.add(index);
    }
  }

  setInt32(index: number, value: number): void {
    this.setUInt32(index, value | 0);
  }

  setFloat(index: number, value: number): void {
    const before = this.values[index];
    this.view.setFloat32(index * 4, value, true);
    if (this.values[index] !== before) {
      this.changed.add(index);
    }
  }

  /** `Object::SetStatFloatValue` — negative becomes 0. */
  private setStatFloat(index: number, value: number): void {
    this.setFloat(index, value < 0 ? 0 : value);
  }

  /** `Object::SetStatInt32Value` — negative becomes 0. */
  private setStatInt32(index: number, value: number): void {
    this.setUInt32(index, value < 0 ? 0 : Math.trunc(value));
  }

  setFlag(index: number, flag: number, on: boolean): void {
    const current = this.values[index]!;
    this.setUInt32(index, on ? current | flag : current & ~flag);
  }

  /** Field indices written since the last call, then forgets them. */
  takeChanged(): number[] {
    const out = [...this.changed].sort((a, b) => a - b);
    this.changed.clear();
    return out;
  }

  /** Every field the stat system has written, for a create block. */
  fieldEntries(filter?: ReadonlySet<number>): { index: number; value: number }[] {
    const out: { index: number; value: number }[] = [];
    for (let index = 0; index < this.values.length; index++) {
      if (filter && !filter.has(index)) {
        continue;
      }
      if (this.values[index] !== 0 || filter?.has(index)) {
        out.push({ index, value: this.values[index]! });
      }
    }
    return out;
  }

  // ---- health and power -------------------------------------------------------------------

  get health(): number {
    return this.getUInt32(UNIT_FIELD_HEALTH);
  }

  get maxHealth(): number {
    return this.getUInt32(UNIT_FIELD_MAXHEALTH);
  }

  power(power: number): number {
    return this.getUInt32(UNIT_FIELD_POWER1 + power);
  }

  maxPower(power: number): number {
    return this.getUInt32(UNIT_FIELD_MAXPOWER1 + power);
  }

  /** `Unit::SetHealth` for an alive player; the dead cases are handled by the death code. */
  setHealth(value: number): void {
    const max = this.maxHealth;
    this.setUInt32(UNIT_FIELD_HEALTH, value > max ? max : Math.max(0, Math.trunc(value)));
  }

  /** `Unit::SetMaxHealth`. */
  setMaxHealth(value: number): void {
    const next = value >>> 0 || 1;
    const health = this.health;
    this.setUInt32(UNIT_FIELD_MAXHEALTH, next);
    if (next < health) {
      this.setHealth(next);
    }
  }

  /** `Unit::ModifyHealth`, returns the gain. */
  modifyHealth(delta: number): number {
    if (delta === 0) {
      return 0;
    }
    const current = this.health;
    const value = Math.trunc(delta) + current;
    if (value <= 0) {
      this.setHealth(0);
      return -current;
    }
    const max = this.maxHealth;
    if (value < max) {
      this.setHealth(value);
      return value - current;
    }
    this.setHealth(max);
    return max - current;
  }

  /** `Unit::SetPower` (field part; SMSG_POWER_UPDATE is sent by the caller). */
  setPower(power: number, value: number): void {
    const max = this.maxPower(power);
    this.setStatInt32(UNIT_FIELD_POWER1 + power, value > max ? max : value);
  }

  /** `Unit::SetMaxPower`. */
  setMaxPower(power: number, value: number): void {
    const current = this.power(power);
    this.setStatInt32(UNIT_FIELD_MAXPOWER1 + power, value);
    if (value < current) {
      this.setPower(power, value);
    }
  }

  // ---- create values ----------------------------------------------------------------------

  getCreateStat(stat: number): number {
    return this.createStats[stat]!;
  }

  getCreateHealth(): number {
    return this.createHealth;
  }

  getCreateMana(): number {
    return this.createMana;
  }

  /** `Unit::GetCreatePowers` for a player. */
  getCreatePowers(power: number): number {
    switch (power) {
      case POWER_MANA:
        return this.createMana;
      case POWER_RAGE:
        return 1000;
      case POWER_ENERGY:
        return 100;
      case POWER_RUNIC_POWER:
        return 1000;
      default:
        return 0;
    }
  }

  private setCreateStat(stat: number, value: number): void {
    this.createStats[stat] = value;
  }

  private setCreateHealth(value: number): void {
    this.createHealth = value;
    this.setUInt32(UNIT_FIELD_BASE_HEALTH, value);
  }

  private setCreateMana(value: number): void {
    this.createMana = value;
    this.setUInt32(UNIT_FIELD_BASE_MANA, value);
  }

  getStat(stat: number): number {
    return this.getInt32(UNIT_FIELD_STAT0 + stat);
  }

  /** Flat `SPELL_AURA_MOD_STAT` values go through Unit's TOTAL_VALUE modifier group. */
  setStatAuraBonuses(bonuses: readonly number[]): void {
    let changed = false;
    for (let stat = 0; stat < MAX_STATS; stat++) {
      const next = bonuses[stat] ?? 0;
      const delta = next - this.auraStatBonuses[stat]!;
      if (!delta) continue;
      this.auraStatBonuses[stat] = next;
      this.handleStatFlatModifier(UNIT_MOD_STAT_START + stat, TOTAL_VALUE, delta, true);
      this.updateStatBuffMod(stat);
      changed = true;
    }
    if (changed) this.updateAllStats();
  }

  getArmor(): number {
    return this.getInt32(UNIT_FIELD_RESISTANCES);
  }

  getResistance(school: number): number {
    return this.getInt32(UNIT_FIELD_RESISTANCES + school);
  }

  // ---- modifier groups --------------------------------------------------------------------

  getFlatModifierValue(unitMod: number, type: number): number {
    return this.flatMods[unitMod]![type]!;
  }

  getPctModifierValue(unitMod: number, type: number): number {
    return this.pctMods[unitMod]![type]!;
  }

  /** `Unit::HandleStatFlatModifier` without the `UpdateUnitMod` cascade; callers finish with `updateAllStats`. */
  handleStatFlatModifier(unitMod: number, type: number, amount: number, apply: boolean): void {
    if (!amount) {
      return;
    }
    this.flatMods[unitMod]![type] = f(this.flatMods[unitMod]![type]! + (apply ? amount : -amount));
  }

  /** `Unit::SetStatFlatModifier` without the cascade. */
  setStatFlatModifier(unitMod: number, type: number, value: number): void {
    this.flatMods[unitMod]![type] = f(value);
  }

  /** `Unit::ApplyStatPctModifier` without the cascade (`AddPct` on the group). */
  applyStatPctModifier(unitMod: number, type: number, pct: number): void {
    if (!pct) return;
    const current = this.pctMods[unitMod]![type]!;
    this.pctMods[unitMod]![type] = f(current + (current * pct) / 100);
  }

  /** `Unit::SetStatPctModifier` without the cascade. */
  setStatPctModifier(unitMod: number, type: number, value: number): void {
    this.pctMods[unitMod]![type] = f(value);
  }

  /** `Unit::UpdateUnitMod`: every derived field is recomputed from the modifier groups. */
  updateUnitMod(_unitMod: number): void {
    this.updateAllStats();
  }

  /** `Unit::UpdateResistanceBuffModsMod` → `UNIT_FIELD_RESISTANCEBUFFMODSPOSITIVE/NEGATIVE + school`. */
  setResistanceBuffMods(school: number, positive: number, negative: number): void {
    this.setFloat(UNIT_FIELD_RESISTANCEBUFFMODSPOSITIVE + school, positive);
    this.setFloat(UNIT_FIELD_RESISTANCEBUFFMODSNEGATIVE + school, negative);
  }

  /** `UNIT_FIELD_POSSTAT0` / `NEGSTAT0` from `Unit::UpdateStatBuffMod`. */
  setStatBuffMods(stat: number, positive: number, negative: number): void {
    this.setFloat(UNIT_FIELD_POSSTAT0 + stat, positive);
    this.setFloat(UNIT_FIELD_NEGSTAT0 + stat, negative);
  }

  /** `ApplyModInt32Value(index, amount, apply)` */
  applyModInt32(index: number, amount: number, apply: boolean): void {
    this.setInt32(index, this.getInt32(index) + (apply ? amount : -amount));
  }

  /** `m_modAttackSpeedPct[att]` */
  attackSpeedPct(attType: number): number {
    return this.modAttackSpeedPct[attType]!;
  }

  /** Item spell power (`GetBaseSpellPowerBonus` + damage or healing). */
  itemSpellDamage(): number {
    return this.baseSpellPower + this.baseSpellDamage;
  }

  itemSpellHealing(): number {
    return this.baseSpellPower + this.baseSpellHealing;
  }

  itemSpellPenetration(): number {
    return this.spellPenetrationItemMod;
  }

  /** `Unit::GetTotalStatValue`. */
  getTotalStatValue(stat: number, additionalValue = 0): number {
    const unitMod = UNIT_MOD_STAT_START + stat;
    if (this.getPctModifierValue(unitMod, TOTAL_PCT) <= 0) {
      return 0;
    }
    let value = f(this.getFlatModifierValue(unitMod, BASE_VALUE) + this.getCreateStat(stat));
    value = f(value * this.getPctModifierValue(unitMod, BASE_PCT));
    value = f(value + this.getFlatModifierValue(unitMod, TOTAL_VALUE) + additionalValue);
    value = f(value * this.getPctModifierValue(unitMod, TOTAL_PCT));
    return value;
  }

  getBaseModValue(group: number, flat: boolean): number {
    return flat ? this.auraBaseFlatMod[group]! : this.auraBasePctMod[group]!;
  }

  private handleBaseModFlatValue(group: number, amount: number, apply: boolean): void {
    this.auraBaseFlatMod[group] = f(this.auraBaseFlatMod[group]! + (apply ? amount : -amount));
  }

  private setBaseModPctValue(group: number, value: number): void {
    this.auraBasePctMod[group] = value;
  }

  // ---- InitStatsForLevel ------------------------------------------------------------------

  /** `Player::InitStatsForLevel(false)` — the stat part; skills, flags, and XP fields belong to their owners. */
  initStatsForLevel(info: PlayerLevelStats): void {
    this.setUInt32(PLAYER_FIELD_MAX_LEVEL, this.maxLevel);
    this.setUInt32(UNIT_FIELD_AURASTATE, 0);
    this.setFloat(UNIT_MOD_CAST_SPEED, 1);
    for (let stat = 0; stat < MAX_STATS; stat++) {
      this.setCreateStat(stat, info.stats[stat]!);
    }
    for (let stat = 0; stat < MAX_STATS; stat++) {
      this.setStatInt32(UNIT_FIELD_STAT0 + stat, info.stats[stat]!);
    }
    this.setCreateHealth(info.baseHealth);
    this.setCreateMana(info.baseMana);
    this.setArmor(Math.trunc(this.createStats[STAT_AGILITY]! * 2));
    // InitStatBuffMods
    for (let stat = 0; stat < MAX_STATS; stat++) {
      this.setFloat(UNIT_FIELD_POSSTAT0 + stat, 0);
      this.setFloat(UNIT_FIELD_NEGSTAT0 + stat, 0);
    }
    for (let cr = 0; cr < MAX_COMBAT_RATING; cr++) {
      this.setUInt32(PLAYER_FIELD_COMBAT_RATING_1 + cr, 0);
    }
    this.setUInt32(PLAYER_FIELD_MOD_HEALING_DONE_POS, 0);
    for (let i = 0; i < 7; i++) {
      this.setInt32(PLAYER_FIELD_MOD_DAMAGE_DONE_NEG + i, 0);
      this.setInt32(PLAYER_FIELD_MOD_DAMAGE_DONE_POS + i, 0);
      this.setFloat(PLAYER_FIELD_MOD_DAMAGE_DONE_PCT + i, 1);
    }
    this.setFloat(UNIT_FIELD_BASEATTACKTIME, 2000);
    this.setFloat(UNIT_FIELD_BASEATTACKTIME + 1, 2000);
    this.setFloat(UNIT_FIELD_RANGEDATTACKTIME, 2000);
    for (const index of [
      UNIT_FIELD_MINDAMAGE,
      UNIT_FIELD_MAXDAMAGE,
      UNIT_FIELD_MINOFFHANDDAMAGE,
      UNIT_FIELD_MAXOFFHANDDAMAGE,
      UNIT_FIELD_MINRANGEDDAMAGE,
      UNIT_FIELD_MAXRANGEDDAMAGE,
    ]) {
      this.setFloat(index, 0);
    }
    this.setInt32(UNIT_FIELD_ATTACK_POWER, 0);
    this.setInt32(UNIT_FIELD_ATTACK_POWER_MODS, 0);
    this.setFloat(UNIT_FIELD_ATTACK_POWER_MULTIPLIER, 0);
    this.setInt32(UNIT_FIELD_RANGED_ATTACK_POWER, 0);
    this.setInt32(UNIT_FIELD_RANGED_ATTACK_POWER_MODS, 0);
    this.setFloat(UNIT_FIELD_RANGED_ATTACK_POWER_MULTIPLIER, 0);
    this.setFloat(PLAYER_CRIT_PERCENTAGE, 0);
    this.setFloat(PLAYER_OFFHAND_CRIT_PERCENTAGE, 0);
    this.setFloat(PLAYER_RANGED_CRIT_PERCENTAGE, 0);
    for (let i = 0; i < 7; i++) {
      this.setFloat(PLAYER_SPELL_CRIT_PERCENTAGE1 + i, 0);
    }
    this.setFloat(PLAYER_PARRY_PERCENTAGE, 0);
    this.setFloat(PLAYER_BLOCK_PERCENTAGE, 0);
    this.setUInt32(PLAYER_SHIELD_BLOCK, 0);
    this.setFloat(PLAYER_DODGE_PERCENTAGE, 0);
    this.setArmor(Math.trunc(this.createStats[STAT_AGILITY]! * 2));
    this.setFloat(UNIT_FIELD_RESISTANCEBUFFMODSPOSITIVE, 0);
    this.setFloat(UNIT_FIELD_RESISTANCEBUFFMODSNEGATIVE, 0);
    for (let school = 1; school < MAX_SPELL_SCHOOL; school++) {
      this.setStatInt32(UNIT_FIELD_RESISTANCES + school, 0);
      this.setFloat(UNIT_FIELD_RESISTANCEBUFFMODSPOSITIVE + school, 0);
      this.setFloat(UNIT_FIELD_RESISTANCEBUFFMODSNEGATIVE + school, 0);
    }
    this.setUInt32(PLAYER_FIELD_MOD_TARGET_RESISTANCE, 0);
    this.setUInt32(PLAYER_FIELD_MOD_TARGET_PHYSICAL_RESISTANCE, 0);
    for (let school = 0; school < MAX_SPELL_SCHOOL; school++) {
      this.setUInt32(UNIT_FIELD_POWER_COST_MODIFIER + school, 0);
      this.setFloat(UNIT_FIELD_POWER_COST_MULTIPLIER + school, 0);
    }
    for (let i = 0; i < 3; i++) {
      this.setUInt32(PLAYER_NO_REAGENT_COST_1 + i, 0);
    }
    for (let power = 0; power < MAX_POWERS; power++) {
      this.setMaxPower(power, this.getCreatePowers(power));
    }
    this.setMaxHealth(info.baseHealth);
    this.setFlag(UNIT_FIELD_FLAGS, UNIT_FLAG_PLAYER_CONTROLLED, true);
    this.setFlag(UNIT_FIELD_FLAGS_2, UNIT_FLAG2_REGENERATE_POWER, true);
  }

  // ---- items ------------------------------------------------------------------------------

  equippedItem(slot: number): EquippedStatItem | undefined {
    return this.equipped.get(slot);
  }

  /** `Player::EquipItem` → `_ApplyItemMods(apply=true)`; the item is in the slot while its mods apply. */
  equip(slot: number, item: EquippedStatItem): void {
    if (this.equipped.has(slot)) {
      this.unequip(slot);
    }
    this.equipped.set(slot, item);
    this.applyItemMods(item, slot, true);
    this.updateAllStats();
  }

  /** `Player::RemoveItem` → `_ApplyItemMods(apply=false)` before the slot is cleared. */
  unequip(slot: number): void {
    const item = this.equipped.get(slot);
    if (!item) {
      return;
    }
    this.applyItemMods(item, slot, false);
    this.equipped.delete(slot);
    this.updateAllStats();
  }

  /** Durability reached 0 or was repaired: `_ApplyItemMods` follows the broken state. */
  setBroken(slot: number, broken: boolean): void {
    const item = this.equipped.get(slot);
    if (!item || item.broken === broken) {
      return;
    }
    if (broken) {
      this.applyItemMods(item, slot, false);
      item.broken = true;
    } else {
      item.broken = false;
      this.applyItemMods(item, slot, true);
    }
    this.updateAllStats();
  }

  /** Equips a whole set at login (`_LoadInventory` → `EquipItem` per slot), then `UpdateAllStats`. */
  loadEquipment(items: ReadonlyMap<number, EquippedStatItem>): void {
    for (const [slot, item] of [...items].sort((a, b) => a[0] - b[0])) {
      this.equipped.set(slot, item);
      this.applyItemMods(item, slot, true);
    }
    this.updateAllStats();
  }

  /** `Player::_ApplyItemMods`. Equip spells, enchantments, and meta gems wait for the spell system. */
  private applyItemMods(item: EquippedStatItem, slot: number, apply: boolean): void {
    if (slot >= INVENTORY_SLOT_BAG_END || item.broken) {
      return;
    }
    this.applyItemBonuses(item.template, slot, apply);
  }

  /** `Player::_ApplyAllLevelScaleItemMods`. */
  applyAllLevelScaleItemMods(apply: boolean): void {
    for (const [slot, item] of [...this.equipped].sort((a, b) => a[0] - b[0])) {
      if (item.broken || !this.canUseAttackType(attackBySlot(slot))) {
        continue;
      }
      this.applyItemMods(item, slot, apply);
    }
  }

  private scalingValues(proto: StatItemTemplate): { ssv: ScalingStatValuesEntry | null; ssdLevel: number } {
    const ssd = proto.ScalingStatDistribution
      ? (this.stores?.scalingStatDistribution.get(proto.ScalingStatDistribution) ?? null)
      : null;
    let ssdLevel = this.level;
    if (ssd && ssdLevel > ssd.MaxLevel) {
      ssdLevel = ssd.MaxLevel;
    }
    const ssv = proto.ScalingStatValue ? (this.stores?.scalingStatValues.get(ssdLevel) ?? null) : null;
    return { ssv, ssdLevel };
  }

  /** `Player::_ApplyItemBonuses`. */
  private applyItemBonuses(proto: StatItemTemplate, slot: number, apply: boolean): void {
    if (slot >= INVENTORY_SLOT_BAG_END) {
      return;
    }
    const ssd = proto.ScalingStatDistribution
      ? (this.stores?.scalingStatDistribution.get(proto.ScalingStatDistribution) ?? null)
      : null;
    const scalingStatValue = proto.ScalingStatValue > 0 ? proto.ScalingStatValue : 0;
    const { ssv } = this.scalingValues(proto);

    for (let i = 0; i < 10; i++) {
      let statType = 0;
      let val = 0;
      if (ssv) {
        if (ssd) {
          if (ssd.StatMod[i]! < 0) {
            continue;
          }
          statType = ssd.StatMod[i]!;
          val = Math.trunc((ssdMultiplier(ssv, scalingStatValue) * ssd.Modifier[i]!) / 10000);
        } else {
          continue;
        }
      } else {
        const stat = proto.stats[i];
        if (!stat) {
          continue;
        }
        statType = stat.type;
        val = stat.value;
      }
      if (val === 0) {
        continue;
      }
      this.applyItemStat(statType, val, apply);
    }

    if (ssv) {
      const spellBonus = ssvSpellBonus(ssv, scalingStatValue);
      if (spellBonus) {
        this.applySpellPowerBonus(spellBonus, apply);
      }
    }

    let armor = proto.armor;
    if (ssv) {
      const ssvArmor = ssvArmorMod(ssv, scalingStatValue);
      if (ssvArmor && (proto.ScalingStatValue > 0 || ssvArmor < proto.armor)) {
        armor = ssvArmor;
      }
    } else if (armor && proto.ArmorDamageModifier) {
      armor = (armor - Math.trunc(proto.ArmorDamageModifier)) >>> 0;
    }
    if (armor) {
      let modType = TOTAL_VALUE;
      if (proto.class === ITEM_CLASS_ARMOR) {
        switch (proto.subclass) {
          case ITEM_SUBCLASS_ARMOR_CLOTH:
          case ITEM_SUBCLASS_ARMOR_LEATHER:
          case ITEM_SUBCLASS_ARMOR_MAIL:
          case ITEM_SUBCLASS_ARMOR_PLATE:
          case ITEM_SUBCLASS_ARMOR_SHIELD:
            modType = BASE_VALUE;
            break;
        }
      }
      this.handleStatFlatModifier(UNIT_MOD_ARMOR, modType, armor, apply);
    }
    if (proto.ArmorDamageModifier > 0) {
      this.handleStatFlatModifier(UNIT_MOD_ARMOR, TOTAL_VALUE, proto.ArmorDamageModifier, apply);
    }
    if (proto.block) {
      this.handleBaseModFlatValue(SHIELD_BLOCK_VALUE, proto.block, apply);
    }
    const resistances = [proto.holy_res, proto.fire_res, proto.nature_res, proto.frost_res, proto.shadow_res, proto.arcane_res];
    resistances.forEach((value, index) => {
      if (value) {
        this.handleStatFlatModifier(UNIT_MOD_RESISTANCE_START + 1 + index, BASE_VALUE, value, apply);
      }
    });

    const attType = attackBySlot(slot);
    if (attType !== MAX_ATTACK) {
      this.applyWeaponDamage(slot, proto, ssv, apply);
    }

    if (this.classId === CLASS_DRUID) {
      let dpsMod = 0;
      let bonus = 0;
      if (ssv) {
        dpsMod = ssvDpsMod(ssv, scalingStatValue);
        bonus += ssvFeralBonus(ssv, scalingStatValue);
      }
      bonus += feralBonus(proto, dpsMod);
      if (bonus) {
        this.baseFeralAP = Math.max(0, this.baseFeralAP + (apply ? bonus : -bonus));
      }
    }
  }

  private applyItemStat(statType: number, val: number, apply: boolean): void {
    switch (statType) {
      case 0: // ITEM_MOD_MANA
        this.handleStatFlatModifier(UNIT_MOD_MANA, BASE_VALUE, val, apply);
        break;
      case 1: // ITEM_MOD_HEALTH
        this.handleStatFlatModifier(UNIT_MOD_HEALTH, BASE_VALUE, val, apply);
        break;
      case 3: // ITEM_MOD_AGILITY
        this.handleStatFlatModifier(UNIT_MOD_STAT_START + STAT_AGILITY, BASE_VALUE, val, apply);
        this.updateStatBuffMod(STAT_AGILITY);
        break;
      case 4: // ITEM_MOD_STRENGTH
        this.handleStatFlatModifier(UNIT_MOD_STAT_START + STAT_STRENGTH, BASE_VALUE, val, apply);
        this.updateStatBuffMod(STAT_STRENGTH);
        break;
      case 5: // ITEM_MOD_INTELLECT
        this.handleStatFlatModifier(UNIT_MOD_STAT_START + STAT_INTELLECT, BASE_VALUE, val, apply);
        this.updateStatBuffMod(STAT_INTELLECT);
        break;
      case 6: // ITEM_MOD_SPIRIT
        this.handleStatFlatModifier(UNIT_MOD_STAT_START + STAT_SPIRIT, BASE_VALUE, val, apply);
        this.updateStatBuffMod(STAT_SPIRIT);
        break;
      case 7: // ITEM_MOD_STAMINA
        this.handleStatFlatModifier(UNIT_MOD_STAT_START + STAT_STAMINA, BASE_VALUE, val, apply);
        this.updateStatBuffMod(STAT_STAMINA);
        break;
      case 12:
        this.applyRatingMod(CR_DEFENSE_SKILL, val, apply);
        break;
      case 13:
        this.applyRatingMod(CR_DODGE, val, apply);
        break;
      case 14:
        this.applyRatingMod(CR_PARRY, val, apply);
        break;
      case 15:
        this.applyRatingMod(CR_BLOCK, val, apply);
        break;
      case 16:
        this.applyRatingMod(CR_HIT_MELEE, val, apply);
        break;
      case 17:
        this.applyRatingMod(CR_HIT_RANGED, val, apply);
        break;
      case 18:
        this.applyRatingMod(CR_HIT_SPELL, val, apply);
        break;
      case 19:
        this.applyRatingMod(CR_CRIT_MELEE, val, apply);
        break;
      case 20:
        this.applyRatingMod(CR_CRIT_RANGED, val, apply);
        break;
      case 21:
        this.applyRatingMod(CR_CRIT_SPELL, val, apply);
        break;
      case 22:
        this.applyRatingMod(CR_HIT_TAKEN_MELEE, val, apply);
        break;
      case 23:
        this.applyRatingMod(CR_HIT_TAKEN_RANGED, val, apply);
        break;
      case 24:
        this.applyRatingMod(CR_HIT_TAKEN_SPELL, val, apply);
        break;
      case 25:
        this.applyRatingMod(CR_CRIT_TAKEN_MELEE, val, apply);
        break;
      case 26:
        this.applyRatingMod(CR_CRIT_TAKEN_RANGED, val, apply);
        break;
      case 27:
        this.applyRatingMod(CR_CRIT_TAKEN_SPELL, val, apply);
        break;
      case 28:
        this.applyRatingMod(CR_HASTE_MELEE, val, apply);
        break;
      case 29:
        this.applyRatingMod(CR_HASTE_RANGED, val, apply);
        break;
      case 30:
        this.applyRatingMod(CR_HASTE_SPELL, val, apply);
        break;
      case 31: // ITEM_MOD_HIT_RATING
        this.applyRatingMod(CR_HIT_MELEE, val, apply);
        this.applyRatingMod(CR_HIT_RANGED, val, apply);
        this.applyRatingMod(CR_HIT_SPELL, val, apply);
        break;
      case 32: // ITEM_MOD_CRIT_RATING
        this.applyRatingMod(CR_CRIT_MELEE, val, apply);
        this.applyRatingMod(CR_CRIT_RANGED, val, apply);
        this.applyRatingMod(CR_CRIT_SPELL, val, apply);
        break;
      case 33: // ITEM_MOD_HIT_TAKEN_RATING
        this.applyRatingMod(CR_HIT_TAKEN_MELEE, val, apply);
        this.applyRatingMod(CR_HIT_TAKEN_RANGED, val, apply);
        this.applyRatingMod(CR_HIT_TAKEN_SPELL, val, apply);
        break;
      case 34: // ITEM_MOD_CRIT_TAKEN_RATING
      case 35: // ITEM_MOD_RESILIENCE_RATING
        this.applyRatingMod(CR_CRIT_TAKEN_MELEE, val, apply);
        this.applyRatingMod(CR_CRIT_TAKEN_RANGED, val, apply);
        this.applyRatingMod(CR_CRIT_TAKEN_SPELL, val, apply);
        break;
      case 36: // ITEM_MOD_HASTE_RATING
        this.applyRatingMod(CR_HASTE_MELEE, val, apply);
        this.applyRatingMod(CR_HASTE_RANGED, val, apply);
        this.applyRatingMod(CR_HASTE_SPELL, val, apply);
        break;
      case 37:
        this.applyRatingMod(CR_EXPERTISE, val, apply);
        break;
      case 38: // ITEM_MOD_ATTACK_POWER
        this.handleStatFlatModifier(UNIT_MOD_ATTACK_POWER, TOTAL_VALUE, val, apply);
        this.handleStatFlatModifier(UNIT_MOD_ATTACK_POWER_RANGED, TOTAL_VALUE, val, apply);
        break;
      case 39: // ITEM_MOD_RANGED_ATTACK_POWER
        this.handleStatFlatModifier(UNIT_MOD_ATTACK_POWER_RANGED, TOTAL_VALUE, val, apply);
        break;
      case 43: // ITEM_MOD_MANA_REGENERATION
        this.baseManaRegen = modifyUInt32(apply, this.baseManaRegen, val).value;
        break;
      case 44:
        this.applyRatingMod(CR_ARMOR_PENETRATION, val, apply);
        break;
      case 45: // ITEM_MOD_SPELL_POWER
        this.applySpellPowerBonus(val, apply);
        break;
      case 46: // ITEM_MOD_HEALTH_REGEN
        this.baseHealthRegen = modifyUInt32(apply, this.baseHealthRegen, val).value;
        break;
      case 47: // ITEM_MOD_SPELL_PENETRATION
        this.setInt32(
          PLAYER_FIELD_MOD_TARGET_RESISTANCE,
          this.getInt32(PLAYER_FIELD_MOD_TARGET_RESISTANCE) + (apply ? -val : val),
        );
        this.spellPenetrationItemMod += apply ? val : -val;
        break;
      case 48: // ITEM_MOD_BLOCK_VALUE
        this.handleBaseModFlatValue(SHIELD_BLOCK_VALUE, val, apply);
        break;
      case 41: // ITEM_MOD_SPELL_HEALING_DONE
        this.baseSpellHealing = modifyUInt32(apply, this.baseSpellHealing, val).value;
        break;
      case 42: // ITEM_MOD_SPELL_DAMAGE_DONE
        this.baseSpellDamage = modifyUInt32(apply, this.baseSpellDamage, val).value;
        break;
      default:
        break;
    }
  }

  private applySpellPowerBonus(amount: number, apply: boolean): void {
    this.baseSpellPower = modifyUInt32(apply, this.baseSpellPower, amount).value;
  }

  /** `Player::_ApplyWeaponDamage`. */
  private applyWeaponDamage(slot: number, proto: StatItemTemplate, ssvIn: ScalingStatValuesEntry | null, apply: boolean): void {
    const scalingStatValue = proto.ScalingStatValue > 0 ? proto.ScalingStatValue : 0;
    const ssv = ssvIn ?? this.scalingValues(proto).ssv;
    const attType = attackBySlot(slot);
    if (apply && !this.canUseAttackType(attType)) {
      return;
    }
    for (let i = 0; i < MAX_ITEM_PROTO_DAMAGES; i++) {
      let minDamage = proto.damage[i]?.min ?? 0;
      let maxDamage = proto.damage[i]?.max ?? 0;
      if (ssv && i === 0) {
        const extraDps = ssvDpsMod(ssv, scalingStatValue);
        if (extraDps) {
          const average = f((extraDps * proto.delay) / 1000);
          const mod = ssvIsTwoHand(proto.ScalingStatValue) ? 0.2 : 0.3;
          minDamage = f((1 - mod) * average);
          maxDamage = f((1 + mod) * average);
        }
      }
      if (apply) {
        if (minDamage > 0) {
          this.weaponDamage[attType]![MINDAMAGE]![i] = f(minDamage);
        }
        if (maxDamage > 0) {
          this.weaponDamage[attType]![MAXDAMAGE]![i] = f(maxDamage);
        }
      }
    }
    if (!apply) {
      for (let i = 0; i < MAX_ITEM_PROTO_DAMAGES; i++) {
        this.weaponDamage[attType]![MINDAMAGE]![i] = 0;
        this.weaponDamage[attType]![MAXDAMAGE]![i] = 0;
      }
      if (attType === BASE_ATTACK) {
        this.weaponDamage[BASE_ATTACK]![MINDAMAGE]![0] = BASE_MINDAMAGE;
        this.weaponDamage[BASE_ATTACK]![MAXDAMAGE]![0] = BASE_MAXDAMAGE;
      }
    }
    if (proto.delay) {
      this.setAttackTime(attType, apply ? proto.delay : BASE_ATTACK_TIME);
    }
    if (this.getWeaponDamageRange(attType, MAXDAMAGE) || proto.delay) {
      this.updateDamagePhysical(attType);
    }
  }

  // ---- attack helpers ---------------------------------------------------------------------

  /** `Unit::CanUseAttackType` — no disarm auras yet, so always true. */
  canUseAttackType(_attType: number): boolean {
    return true;
  }

  /** `Player::GetWeaponForAttack(att, useable=true)`. */
  weaponForAttack(attType: number): EquippedStatItem | null {
    const slot = attType === BASE_ATTACK ? EQUIPMENT_SLOT_MAINHAND : attType === OFF_ATTACK ? EQUIPMENT_SLOT_OFFHAND : attType === RANGED_ATTACK ? EQUIPMENT_SLOT_RANGED : -1;
    const item = this.equipped.get(slot);
    if (!item || item.template.class !== ITEM_CLASS_WEAPON || item.broken) {
      return null;
    }
    return item;
  }

  /** `Player::HasWeaponForAttack`. */
  hasWeaponForAttack(attType: number): boolean {
    return this.canUseAttackType(attType) && this.weaponForAttack(attType) !== null;
  }

  getAttackTime(attType: number): number {
    const field = attType === RANGED_ATTACK ? UNIT_FIELD_RANGEDATTACKTIME : UNIT_FIELD_BASEATTACKTIME + attType;
    return Math.trunc(f(this.getFloat(field) / this.modAttackSpeedPct[attType]!));
  }

  private setAttackTime(attType: number, value: number): void {
    const field = attType === RANGED_ATTACK ? UNIT_FIELD_RANGEDATTACKTIME : UNIT_FIELD_BASEATTACKTIME + attType;
    this.setFloat(field, value * this.modAttackSpeedPct[attType]!);
  }

  /** `Unit::ApplyAttackTimePercentMod` (the swing timer rescale belongs to combat). */
  applyAttackTimePercentMod(attType: number, val: number, apply: boolean): void {
    const field = attType === RANGED_ATTACK ? UNIT_FIELD_RANGEDATTACKTIME : UNIT_FIELD_BASEATTACKTIME + attType;
    let amount = this.getFloat(field);
    if (val > 0) {
      this.modAttackSpeedPct[attType] = applyPercentModFloatVar(this.modAttackSpeedPct[attType]!, val, !apply);
      amount = applyPercentModFloatVar(amount, val, !apply);
    } else {
      this.modAttackSpeedPct[attType] = applyPercentModFloatVar(this.modAttackSpeedPct[attType]!, -val, apply);
      amount = applyPercentModFloatVar(amount, -val, apply);
    }
    this.setFloat(field, amount);
  }

  /** `Unit::ApplyCastTimePercentMod`. */
  applyCastTimePercentMod(val: number, apply: boolean): void {
    let amount = this.getFloat(UNIT_MOD_CAST_SPEED);
    amount = val > 0 ? applyPercentModFloatVar(amount, val, !apply) : applyPercentModFloatVar(amount, -val, apply);
    this.setFloat(UNIT_MOD_CAST_SPEED, amount);
  }

  getWeaponDamageRange(attType: number, type: number, damageIndex = 0): number {
    if (attType === OFF_ATTACK && !this.hasWeaponForAttack(OFF_ATTACK)) {
      return 0;
    }
    return this.weaponDamage[attType]![type]![damageIndex]!;
  }

  /** `Unit::GetAPMultiplier(att, normalized=false)`. */
  getAPMultiplier(attType: number): number {
    return f(this.getAttackTime(attType) / 1000);
  }

  /** `Unit::GetTotalAttackPowerValue` without a victim. */
  getTotalAttackPowerValue(attType: number): number {
    if (attType === RANGED_ATTACK) {
      const ap = this.getInt32(UNIT_FIELD_RANGED_ATTACK_POWER) + this.getInt32(UNIT_FIELD_RANGED_ATTACK_POWER_MODS);
      return ap < 0 ? 0 : f(ap * (1 + this.getFloat(UNIT_FIELD_RANGED_ATTACK_POWER_MULTIPLIER)));
    }
    const ap = this.getInt32(UNIT_FIELD_ATTACK_POWER) + this.getInt32(UNIT_FIELD_ATTACK_POWER_MODS);
    return ap < 0 ? 0 : f(ap * (1 + this.getFloat(UNIT_FIELD_ATTACK_POWER_MULTIPLIER)));
  }

  /** `Unit::GetMaxSkillValueForLevel`. */
  getMaxSkillValueForLevel(): number {
    return this.level * 5;
  }

  /** `Unit::GetWeaponSkillValue` without a target. */
  getWeaponSkillValue(attType: number): number {
    const item = this.weaponForAttack(attType);
    if (attType !== BASE_ATTACK && !item) {
      return 0;
    }
    const skill = item ? itemSkill(item.template) : SKILL_UNARMED;
    let value = this.skills?.skillValue(skill) ?? 0;
    value += Math.trunc(this.getRatingBonusValue(CR_WEAPON_SKILL));
    if (attType === BASE_ATTACK) {
      value += Math.trunc(this.getRatingBonusValue(CR_WEAPON_SKILL_MAINHAND));
    } else if (attType === OFF_ATTACK) {
      value += Math.trunc(this.getRatingBonusValue(CR_WEAPON_SKILL_OFFHAND));
    } else if (attType === RANGED_ATTACK) {
      value += Math.trunc(this.getRatingBonusValue(CR_WEAPON_SKILL_RANGED));
    }
    return value >>> 0;
  }

  /** `Unit::GetDefenseSkillValue` without a target. */
  getDefenseSkillValue(): number {
    const value = (this.skills?.skillValue(SKILL_DEFENSE) ?? 0) + Math.trunc(this.getRatingBonusValue(CR_DEFENSE_SKILL));
    return value >>> 0;
  }

  private skillValue(skill: number): number {
    return this.skills?.skillValue(skill) ?? 0;
  }

  // ---- ratings ----------------------------------------------------------------------------

  private gtLevel(): number {
    return this.level > GT_MAX_LEVEL ? GT_MAX_LEVEL : this.level;
  }

  /** `Player::GetRatingMultiplier`. */
  getRatingMultiplier(cr: number): number {
    const level = this.gtLevel();
    const rating = this.stores?.combatRatings?.lookup(cr * GT_MAX_LEVEL + level - 1);
    const classRating = this.stores?.octClassCombatRatingScalar?.lookup((this.classId - 1) * GT_MAX_RATING + cr + 1);
    if (rating === undefined || classRating === undefined) {
      return 1;
    }
    return f(classRating / rating);
  }

  /** `Player::GetRatingBonusValue`. */
  getRatingBonusValue(cr: number): number {
    return f(this.getUInt32(PLAYER_FIELD_COMBAT_RATING_1 + cr) * this.getRatingMultiplier(cr));
  }

  /** `Player::ApplyRatingMod`. */
  applyRatingMod(cr: number, value: number, apply: boolean): void {
    const oldRating = this.baseRatingValue[cr]!;
    this.baseRatingValue[cr] = oldRating + (apply ? value : -value);
    if (cr === CR_HASTE_MELEE || cr === CR_HASTE_RANGED || cr === CR_HASTE_SPELL) {
      const mult = this.getRatingMultiplier(cr);
      const oldVal = f(oldRating * mult);
      const newVal = f(this.baseRatingValue[cr]! * mult);
      if (cr === CR_HASTE_MELEE) {
        this.applyAttackTimePercentMod(BASE_ATTACK, oldVal, false);
        this.applyAttackTimePercentMod(OFF_ATTACK, oldVal, false);
        this.applyAttackTimePercentMod(BASE_ATTACK, newVal, true);
        this.applyAttackTimePercentMod(OFF_ATTACK, newVal, true);
      } else if (cr === CR_HASTE_RANGED) {
        this.applyAttackTimePercentMod(RANGED_ATTACK, oldVal, false);
        this.applyAttackTimePercentMod(RANGED_ATTACK, newVal, true);
      } else {
        this.applyCastTimePercentMod(oldVal, false);
        this.applyCastTimePercentMod(newVal, true);
      }
    }
    this.updateRating(cr);
  }

  /** `Player::UpdateRating`. */
  private updateRating(cr: number): void {
    let amount = this.baseRatingValue[cr]!;
    if (amount < 0) {
      amount = 0;
    }
    this.setUInt32(PLAYER_FIELD_COMBAT_RATING_1 + cr, amount);
    switch (cr) {
      case CR_WEAPON_SKILL:
      case CR_DEFENSE_SKILL:
        this.updateDefenseBonusesMod();
        break;
      case CR_DODGE:
        this.updateDodgePercentage();
        break;
      case CR_PARRY:
        this.updateParryPercentage();
        break;
      case CR_BLOCK:
        this.updateBlockPercentage();
        break;
      case CR_HIT_MELEE:
        this.modMeleeHitChance = this.getRatingBonusValue(CR_HIT_MELEE);
        break;
      case CR_HIT_RANGED:
        this.modRangedHitChance = this.getRatingBonusValue(CR_HIT_RANGED);
        break;
      case CR_HIT_SPELL:
        this.modSpellHitChance = this.getRatingBonusValue(CR_HIT_SPELL);
        break;
      case CR_CRIT_MELEE:
        this.updateCritPercentage(BASE_ATTACK);
        this.updateCritPercentage(OFF_ATTACK);
        break;
      case CR_CRIT_RANGED:
        this.updateCritPercentage(RANGED_ATTACK);
        break;
      case CR_CRIT_SPELL:
        this.updateAllSpellCritChances();
        break;
      case CR_EXPERTISE:
        this.updateExpertise(BASE_ATTACK);
        this.updateExpertise(OFF_ATTACK);
        break;
      case CR_ARMOR_PENETRATION:
        this.setUInt32(PLAYER_FIELD_COMBAT_RATING_1 + CR_ARMOR_PENETRATION, amount);
        break;
      default:
        break;
    }
  }

  // ---- StatSystem.cpp ---------------------------------------------------------------------

  /** `Unit::UpdateStatBuffMod` — item, enchant, and flat aura contributions. */
  private updateStatBuffMod(stat: number): void {
    if (this.auraHooks) {
      const mods = this.auraHooks.statBuffMods(stat);
      this.setStatBuffMods(stat, mods.pos, mods.neg);
      return;
    }
    const modValue = this.getFlatModifierValue(UNIT_MOD_STAT_START + stat, BASE_VALUE)
      + this.getFlatModifierValue(UNIT_MOD_STAT_START + stat, TOTAL_VALUE);
    this.setFloat(UNIT_FIELD_POSSTAT0 + stat, modValue > 0 ? modValue : 0);
    this.setFloat(UNIT_FIELD_NEGSTAT0 + stat, modValue < 0 ? modValue : 0);
  }

  /** `Player::UpdateAllStats`. */
  updateAllStats(): void {
    for (let stat = 0; stat < MAX_STATS; stat++) {
      this.setStatInt32(UNIT_FIELD_STAT0 + stat, Math.trunc(this.getTotalStatValue(stat)));
    }
    this.updateArmor();
    this.updateAttackPowerAndDamage(true);
    this.updateMaxHealth();
    for (let power = POWER_MANA; power < MAX_POWERS; power++) {
      this.updateMaxPower(power);
    }
    for (let cr = 0; cr < MAX_COMBAT_RATING; cr++) {
      this.updateRating(cr);
    }
    this.updateAllCritPercentages();
    this.updateAllSpellCritChances();
    this.updateDefenseBonusesMod();
    this.updateShieldBlockValue();
    this.updateSpellDamageAndHealingBonus();
    this.updateManaRegen();
    this.updateExpertise(BASE_ATTACK);
    this.updateExpertise(OFF_ATTACK);
    this.updateRating(CR_ARMOR_PENETRATION);
    for (let school = 0; school < MAX_SPELL_SCHOOL; school++) {
      this.updateResistances(school);
    }
  }

  private setArmor(value: number): void {
    this.setStatInt32(UNIT_FIELD_RESISTANCES, value);
  }

  /** `Player::UpdateResistances`. */
  private updateResistances(school: number): void {
    if (school > 0) {
      const unitMod = UNIT_MOD_RESISTANCE_START + school;
      let value = this.getFlatModifierValue(unitMod, BASE_VALUE);
      value = f(value * this.getPctModifierValue(unitMod, BASE_PCT));
      value = f(value + this.getFlatModifierValue(unitMod, TOTAL_VALUE));
      value = f(value * this.getPctModifierValue(unitMod, TOTAL_PCT));
      this.setStatInt32(UNIT_FIELD_RESISTANCES + school, Math.trunc(value));
    } else {
      this.updateArmor();
    }
  }

  /** `Player::UpdateArmor`. */
  private updateArmor(): void {
    let value = this.getFlatModifierValue(UNIT_MOD_ARMOR, BASE_VALUE);
    value = f(value * this.getPctModifierValue(UNIT_MOD_ARMOR, BASE_PCT));
    value = f(value + this.getStat(STAT_AGILITY) * 2);
    value = f(value + this.getFlatModifierValue(UNIT_MOD_ARMOR, TOTAL_VALUE));
    value = f(value * this.getPctModifierValue(UNIT_MOD_ARMOR, TOTAL_PCT));
    this.setArmor(Math.trunc(value));
    this.updateAttackPowerAndDamage(false);
  }

  /** `Player::GetHealthBonusFromStamina`. */
  getHealthBonusFromStamina(): number {
    const stamina = this.getStat(STAT_STAMINA);
    const baseStam = stamina < 20 ? stamina : 20;
    return baseStam + (stamina - baseStam) * 10;
  }

  /** `Player::GetManaBonusFromIntellect`. */
  getManaBonusFromIntellect(): number {
    const intellect = this.getStat(STAT_INTELLECT);
    const baseInt = intellect < 20 ? intellect : 20;
    return baseInt + (intellect - baseInt) * 15;
  }

  /** `Player::UpdateMaxHealth`. */
  private updateMaxHealth(): void {
    let value = f(this.getFlatModifierValue(UNIT_MOD_HEALTH, BASE_VALUE) + this.getCreateHealth());
    value = f(value * this.getPctModifierValue(UNIT_MOD_HEALTH, BASE_PCT));
    value = f(value + this.getFlatModifierValue(UNIT_MOD_HEALTH, TOTAL_VALUE) + this.getHealthBonusFromStamina());
    value = f(value * this.getPctModifierValue(UNIT_MOD_HEALTH, TOTAL_PCT));
    this.setMaxHealth(Math.trunc(value));
  }

  /** `Player::UpdateMaxPower`. */
  private updateMaxPower(power: number): void {
    const unitMod = UNIT_MOD_POWER_START + power;
    const bonusPower = power === POWER_MANA && this.getCreatePowers(power) > 0 ? this.getManaBonusFromIntellect() : 0;
    let value = f(this.getFlatModifierValue(unitMod, BASE_VALUE) + this.getCreatePowers(power));
    value = f(value * this.getPctModifierValue(unitMod, BASE_PCT));
    value = f(value + this.getFlatModifierValue(unitMod, TOTAL_VALUE) + bonusPower);
    value = f(value * this.getPctModifierValue(unitMod, TOTAL_PCT));
    this.setMaxPower(power, Math.trunc(value));
  }

  /** `Player::UpdateAttackPowerAndDamage` for a player out of shapeshift forms. */
  private updateAttackPowerAndDamage(ranged: boolean): void {
    const level = this.level;
    const unitMod = ranged ? UNIT_MOD_ATTACK_POWER_RANGED : UNIT_MOD_ATTACK_POWER;
    const index = ranged ? UNIT_FIELD_RANGED_ATTACK_POWER : UNIT_FIELD_ATTACK_POWER;
    const indexMod = ranged ? UNIT_FIELD_RANGED_ATTACK_POWER_MODS : UNIT_FIELD_ATTACK_POWER_MODS;
    const indexMult = ranged ? UNIT_FIELD_RANGED_ATTACK_POWER_MULTIPLIER : UNIT_FIELD_ATTACK_POWER_MULTIPLIER;
    const strength = this.getStat(STAT_STRENGTH);
    const agility = this.getStat(STAT_AGILITY);
    let val2 = 0;
    if (ranged) {
      switch (this.classId) {
        case CLASS_HUNTER:
          val2 = level * 2 + agility - 10;
          break;
        case CLASS_ROGUE:
        case CLASS_WARRIOR:
          val2 = level + agility - 10;
          break;
        default:
          val2 = agility - 10;
          break;
      }
    } else {
      switch (this.classId) {
        case CLASS_PALADIN:
        case CLASS_DEATH_KNIGHT:
        case CLASS_WARRIOR:
          val2 = level * 3 + strength * 2 - 20;
          break;
        case CLASS_HUNTER:
        case CLASS_SHAMAN:
        case CLASS_ROGUE:
          val2 = level * 2 + strength + agility - 20;
          break;
        case CLASS_DRUID:
          val2 = strength * 2 - 20;
          break;
        case CLASS_MAGE:
        case CLASS_PRIEST:
        case CLASS_WARLOCK:
          val2 = strength - 10;
          break;
        default:
          break;
      }
    }
    this.setStatFlatModifier(unitMod, BASE_VALUE, val2);
    const baseAttPower = f(this.getFlatModifierValue(unitMod, BASE_VALUE) * this.getPctModifierValue(unitMod, BASE_PCT));
    // Stat- and armor-based AP auras (SPELL_AURA_MOD_*ATTACK_POWER_OF_*) add here once auras exist.
    const attPowerMod = this.getFlatModifierValue(unitMod, TOTAL_VALUE);
    const attPowerMultiplier = f(this.getPctModifierValue(unitMod, TOTAL_PCT) - 1);
    this.setInt32(index, Math.trunc(baseAttPower));
    this.setInt32(indexMod, Math.trunc(attPowerMod));
    this.setFloat(indexMult, attPowerMultiplier);
    if (ranged) {
      this.updateDamagePhysical(RANGED_ATTACK);
    } else {
      this.updateDamagePhysical(BASE_ATTACK);
      if (this.canDualWield && this.hasWeaponForAttack(OFF_ATTACK)) {
        this.updateDamagePhysical(OFF_ATTACK);
      }
      if (this.classId === CLASS_SHAMAN || this.classId === CLASS_PALADIN) {
        this.updateSpellDamageAndHealingBonus();
      }
    }
  }

  /** `Player::UpdateShieldBlockValue` / `GetShieldBlockValue`. */
  private updateShieldBlockValue(): void {
    let value = f(
      (this.auraBaseFlatMod[SHIELD_BLOCK_VALUE]! + this.getStat(STAT_STRENGTH) * 0.5 - 10) * this.auraBasePctMod[SHIELD_BLOCK_VALUE]!,
    );
    value = value < 0 ? 0 : value;
    this.setUInt32(PLAYER_SHIELD_BLOCK, Math.trunc(value));
  }

  /** `Player::CalculateMinMaxDamage(att, normalized=false, addTotalPct=true)`. */
  calculateMinMaxDamage(attType: number, damageIndex: number, normalized = false, addTotalPct = true): { min: number; max: number } {
    if (damageIndex !== 0) {
      if (!this.canUseAttackType(attType)) {
        return { min: 0, max: 0 };
      }
      return {
        min: this.getWeaponDamageRange(attType, MINDAMAGE, damageIndex),
        max: this.getWeaponDamageRange(attType, MAXDAMAGE, damageIndex),
      };
    }
    const unitMod = attType === OFF_ATTACK ? UNIT_MOD_DAMAGE_OFFHAND : attType === RANGED_ATTACK ? UNIT_MOD_DAMAGE_RANGED : UNIT_MOD_DAMAGE_MAINHAND;
    const attackSpeedMod = normalized ? this.normalizedAPMultiplier(attType) : this.getAPMultiplier(attType);
    const baseValue = f(this.getFlatModifierValue(unitMod, BASE_VALUE) + f((this.getTotalAttackPowerValue(attType) / 14) * attackSpeedMod));
    const basePct = this.getPctModifierValue(unitMod, BASE_PCT);
    const totalValue = this.getFlatModifierValue(unitMod, TOTAL_VALUE);
    const totalPct = addTotalPct ? this.getPctModifierValue(unitMod, TOTAL_PCT) : 1;
    let weaponMinDamage = this.getWeaponDamageRange(attType, MINDAMAGE);
    let weaponMaxDamage = this.getWeaponDamageRange(attType, MAXDAMAGE);
    if (attType === RANGED_ATTACK) {
      weaponMinDamage = f(weaponMinDamage + this.ammoDPS * attackSpeedMod);
      weaponMaxDamage = f(weaponMaxDamage + this.ammoDPS * attackSpeedMod);
    }
    let min = f((f((weaponMinDamage + baseValue) * basePct) + totalValue) * totalPct);
    let max = f((f((weaponMaxDamage + baseValue) * basePct) + totalValue) * totalPct);
    if (min < 0 || min > 1000000000) {
      min = 0;
    }
    if (max < 0 || max > 1000000000) {
      max = 0;
    }
    if (min > max) {
      min = max;
    }
    return { min, max };
  }

  /** `Unit::GetAPMultiplier(att, normalized=true)` for a player. */
  normalizedAPMultiplier(attType: number): number {
    const weapon = this.weaponForAttack(attType);
    if (!weapon) return 2.4;
    switch (weapon.template.InventoryType) {
      case 17: // INVTYPE_2HWEAPON
        return 3.3;
      case 15: // INVTYPE_RANGED
      case 25: // INVTYPE_THROWN
      case 26: // INVTYPE_RANGEDRIGHT
        return 2.8;
      default:
        return weapon.template.subclass === 15 /* ITEM_SUBCLASS_WEAPON_DAGGER */ ? 1.7 : 2.4;
    }
  }

  /** `Unit::UpdateDamagePhysical`. */
  private updateDamagePhysical(attType: number): void {
    let totalMin = 0;
    let totalMax = 0;
    for (let i = 0; i < MAX_ITEM_PROTO_DAMAGES; i++) {
      const range = this.calculateMinMaxDamage(attType, i);
      totalMin = f(totalMin + range.min);
      totalMax = f(totalMax + range.max);
    }
    if (attType === OFF_ATTACK) {
      this.setStatFloat(UNIT_FIELD_MINOFFHANDDAMAGE, totalMin);
      this.setStatFloat(UNIT_FIELD_MAXOFFHANDDAMAGE, totalMax);
    } else if (attType === RANGED_ATTACK) {
      this.setStatFloat(UNIT_FIELD_MINRANGEDDAMAGE, totalMin);
      this.setStatFloat(UNIT_FIELD_MAXRANGEDDAMAGE, totalMax);
    } else {
      this.setStatFloat(UNIT_FIELD_MINDAMAGE, totalMin);
      this.setStatFloat(UNIT_FIELD_MAXDAMAGE, totalMax);
    }
  }

  private updateDefenseBonusesMod(): void {
    this.updateBlockPercentage();
    this.updateParryPercentage();
    this.updateDodgePercentage();
  }

  private limit(value: number, cap: number): number {
    return this.limits.enable && value > cap ? cap : value;
  }

  /** `Player::UpdateBlockPercentage`. */
  private updateBlockPercentage(): void {
    let value = 0;
    if (this.canBlock) {
      value = 5;
      value += (this.getDefenseSkillValue() - this.getMaxSkillValueForLevel()) * 0.04;
      value += this.getRatingBonusValue(CR_BLOCK);
      value = this.limit(value, this.limits.block);
      value = value < 0 ? 0 : value;
    }
    this.setStatFloat(PLAYER_BLOCK_PERCENTAGE, value);
  }

  /** `Player::UpdateCritPercentage`. */
  private updateCritPercentage(attType: number): void {
    const group = attType === OFF_ATTACK ? OFFHAND_CRIT_PERCENTAGE : attType === RANGED_ATTACK ? RANGED_CRIT_PERCENTAGE : CRIT_PERCENTAGE;
    const index = attType === OFF_ATTACK ? PLAYER_OFFHAND_CRIT_PERCENTAGE : attType === RANGED_ATTACK ? PLAYER_RANGED_CRIT_PERCENTAGE : PLAYER_CRIT_PERCENTAGE;
    const cr = attType === RANGED_ATTACK ? CR_CRIT_RANGED : CR_CRIT_MELEE;
    let value = this.getBaseModValue(group, true) + this.getBaseModValue(group, false) + this.getRatingBonusValue(cr);
    value += (this.getWeaponSkillValue(attType) - this.getMaxSkillValueForLevel()) * 0.04;
    value = this.limit(value, this.limits.crit);
    value = value < 0 ? 0 : value;
    this.setStatFloat(index, value);
  }

  /** `Player::UpdateAllCritPercentages`. */
  private updateAllCritPercentages(): void {
    const value = this.getMeleeCritFromAgility();
    this.setBaseModPctValue(CRIT_PERCENTAGE, value);
    this.setBaseModPctValue(OFFHAND_CRIT_PERCENTAGE, value);
    this.setBaseModPctValue(RANGED_CRIT_PERCENTAGE, value);
    this.updateCritPercentage(BASE_ATTACK);
    this.updateCritPercentage(OFF_ATTACK);
    this.updateCritPercentage(RANGED_ATTACK);
  }

  /** `Player::GetMeleeCritFromAgility`. */
  getMeleeCritFromAgility(): number {
    const level = this.gtLevel();
    const critBase = this.stores?.chanceToMeleeCritBase?.lookup(this.classId - 1);
    const critRatio = this.stores?.chanceToMeleeCrit?.lookup((this.classId - 1) * GT_MAX_LEVEL + level - 1);
    if (critBase === undefined || critRatio === undefined) {
      return 0;
    }
    return f(f(critBase + this.getStat(STAT_AGILITY) * critRatio) * 100);
  }

  /** `Player::GetDodgeFromAgility`. */
  getDodgeFromAgility(): { diminishing: number; nondiminishing: number } {
    const level = this.gtLevel();
    const pclass = this.classId;
    const dodgeRatio = this.stores?.chanceToMeleeCrit?.lookup((pclass - 1) * GT_MAX_LEVEL + level - 1);
    if (dodgeRatio === undefined || pclass > MAX_CLASSES) {
      return { diminishing: 0, nondiminishing: 0 };
    }
    const baseAgility = f(this.getCreateStat(STAT_AGILITY) * this.getPctModifierValue(UNIT_MOD_STAT_START + STAT_AGILITY, BASE_PCT));
    const bonusAgility = f(this.getStat(STAT_AGILITY) - baseAgility);
    return {
      diminishing: f(100 * bonusAgility * dodgeRatio * CRIT_TO_DODGE[pclass - 1]!),
      nondiminishing: f(100 * (DODGE_BASE[pclass - 1]! + baseAgility * dodgeRatio * CRIT_TO_DODGE[pclass - 1]!)),
    };
  }

  /** `Player::GetMissPercentageFromDefence`. */
  getMissPercentageFromDefence(): number {
    const pclass = this.classId - 1;
    const nondiminishing = (this.skillValue(SKILL_DEFENSE) - this.getMaxSkillValueForLevel()) * 0.04;
    const diminishing = Math.trunc(this.getRatingBonusValue(CR_DEFENSE_SKILL)) * 0.04;
    return nondiminishing + (diminishing * MISS_CAP[pclass]!) / (diminishing + MISS_CAP[pclass]! * M_DIMINISHING_K[pclass]!);
  }

  /** `Player::UpdateParryPercentage`. */
  private updateParryPercentage(): void {
    let value = 0;
    this.realParry = 0;
    const pclass = this.classId - 1;
    const cap = PARRY_CAP[pclass] ?? 0;
    if (this.canParry && cap > 0) {
      let nondiminishing = 5;
      let diminishing = this.getRatingBonusValue(CR_PARRY);
      nondiminishing += (this.skillValue(SKILL_DEFENSE) - this.getMaxSkillValueForLevel()) * 0.04;
      diminishing += Math.trunc(this.getRatingBonusValue(CR_DEFENSE_SKILL)) * 0.04;
      this.realParry = nondiminishing + (diminishing * cap) / (diminishing + cap * M_DIMINISHING_K[pclass]!);
      this.realParry = this.realParry < 0 ? 0 : this.realParry;
      value = Math.max(diminishing + nondiminishing, 0);
      value = this.limit(value, this.limits.parry);
    }
    this.setStatFloat(PLAYER_PARRY_PERCENTAGE, value);
  }

  /** `Player::UpdateDodgePercentage`. */
  private updateDodgePercentage(): void {
    let { diminishing, nondiminishing } = this.getDodgeFromAgility();
    nondiminishing += (this.skillValue(SKILL_DEFENSE) - this.getMaxSkillValueForLevel()) * 0.04;
    diminishing += Math.trunc(this.getRatingBonusValue(CR_DEFENSE_SKILL)) * 0.04;
    diminishing += this.getRatingBonusValue(CR_DODGE);
    const pclass = this.classId - 1;
    const cap = DODGE_CAP[pclass] ?? 0;
    const k = M_DIMINISHING_K[pclass] ?? 0;
    this.realDodge = cap > 0 ? nondiminishing + (diminishing * cap) / (diminishing + cap * k) : nondiminishing;
    this.realDodge = this.realDodge < 0 ? 0 : this.realDodge;
    let value = Math.max(diminishing + nondiminishing, 0);
    value = this.limit(value, this.limits.dodge);
    this.setStatFloat(PLAYER_DODGE_PERCENTAGE, value);
  }

  /** `Player::GetSpellCritFromIntellect`. */
  getSpellCritFromIntellect(): number {
    const level = this.gtLevel();
    const critBase = this.stores?.chanceToSpellCritBase?.lookup(this.classId - 1);
    const critRatio = this.stores?.chanceToSpellCrit?.lookup((this.classId - 1) * GT_MAX_LEVEL + level - 1);
    if (critBase === undefined || critRatio === undefined) {
      return 0;
    }
    return f(f(critBase + this.getStat(STAT_INTELLECT) * critRatio) * 100);
  }

  /** `Player::UpdateSpellCritChance`. */
  private updateSpellCritChance(school: number): void {
    if (school === 0) {
      this.setFloat(PLAYER_SPELL_CRIT_PERCENTAGE1, 0);
      return;
    }
    const crit = f(this.getSpellCritFromIntellect() + this.getRatingBonusValue(CR_CRIT_SPELL));
    this.setFloat(PLAYER_SPELL_CRIT_PERCENTAGE1 + school, crit);
  }

  private updateAllSpellCritChances(): void {
    for (let school = 0; school < MAX_SPELL_SCHOOL; school++) {
      this.updateSpellCritChance(school);
    }
  }

  /** `Player::UpdateExpertise`. */
  private updateExpertise(attType: number): void {
    if (attType === RANGED_ATTACK) {
      return;
    }
    let expertise = this.getRatingBonusValue(CR_EXPERTISE);
    if (expertise < 0) {
      expertise = 0;
    }
    if (attType === BASE_ATTACK) {
      this.expertise = expertise;
      this.setUInt32(PLAYER_EXPERTISE, Math.trunc(expertise));
    } else {
      this.offhandExpertise = expertise;
      this.setUInt32(PLAYER_OFFHAND_EXPERTISE, Math.trunc(expertise));
    }
  }

  /** `Player::UpdateSpellDamageAndHealingBonus` from the item spell power (`SpellBase*BonusDone` for a player). */
  updateSpellDamageAndHealingBonus(): void {
    if (this.auraHooks) {
      this.setStatInt32(PLAYER_FIELD_MOD_HEALING_DONE_POS, Math.trunc(this.auraHooks.spellHealingBonus()));
      for (let school = 1; school < MAX_SPELL_SCHOOL; school++) {
        this.setStatInt32(PLAYER_FIELD_MOD_DAMAGE_DONE_POS + school, Math.trunc(this.auraHooks.spellDamageBonus(school)));
      }
      return;
    }
    this.setStatInt32(PLAYER_FIELD_MOD_HEALING_DONE_POS, this.baseSpellPower + this.baseSpellHealing);
    for (let school = 1; school < MAX_SPELL_SCHOOL; school++) {
      this.setStatInt32(PLAYER_FIELD_MOD_DAMAGE_DONE_POS + school, this.baseSpellPower + this.baseSpellDamage);
    }
  }

  /** `Player::OCTRegenHPPerSpirit`. */
  octRegenHPPerSpirit(): number {
    const level = this.gtLevel();
    const baseRatio = this.stores?.octRegenHP?.lookup((this.classId - 1) * GT_MAX_LEVEL + level - 1);
    const moreRatio = this.stores?.regenHPPerSpt?.lookup((this.classId - 1) * GT_MAX_LEVEL + level - 1);
    if (baseRatio === undefined || moreRatio === undefined) {
      return 0;
    }
    const spirit = this.getStat(STAT_SPIRIT);
    const baseSpirit = spirit > 50 ? 50 : spirit;
    const moreSpirit = spirit - baseSpirit;
    return f(f(baseSpirit * baseRatio + moreSpirit * moreRatio) * 2);
  }

  /** `Player::OCTRegenMPPerSpirit`. */
  octRegenMPPerSpirit(): number {
    const level = this.gtLevel();
    const moreRatio = this.stores?.regenMPPerSpt?.lookup((this.classId - 1) * GT_MAX_LEVEL + level - 1);
    if (moreRatio === undefined) {
      return 0;
    }
    return f(this.getStat(STAT_SPIRIT) * moreRatio);
  }

  /** `Player::UpdateManaRegen`. */
  updateManaRegen(): void {
    const intellect = this.getStat(STAT_INTELLECT);
    const powerRegen = f(Math.sqrt(intellect) * this.octRegenMPPerSpirit());
    const powerRegenMp5 = f(this.baseManaRegen / 5);
    this.setStatFloat(UNIT_FIELD_POWER_REGEN_INTERRUPTED_FLAT_MODIFIER + POWER_MANA, powerRegenMp5);
    this.setStatFloat(UNIT_FIELD_POWER_REGEN_FLAT_MODIFIER + POWER_MANA, f(powerRegenMp5 + powerRegen));
  }

  // ---- level ------------------------------------------------------------------------------

  /** `SetLevel` plus the `SetCreateStat` / `SetCreateHealth` / `SetCreateMana` calls of `Player::GiveLevel`. */
  applyLevel(level: number, info: PlayerLevelStats): void {
    this.level = level;
    this.setUInt32(UNIT_FIELD_LEVEL, level);
    for (let stat = 0; stat < MAX_STATS; stat++) {
      this.setCreateStat(stat, info.stats[stat]!);
    }
    this.setCreateHealth(info.baseHealth);
    this.setCreateMana(info.baseMana);
  }
}

/** `Player::GetAttackBySlot`. */
export function attackBySlot(slot: number): number {
  switch (slot) {
    case EQUIPMENT_SLOT_MAINHAND:
      return BASE_ATTACK;
    case EQUIPMENT_SLOT_OFFHAND:
      return OFF_ATTACK;
    case EQUIPMENT_SLOT_RANGED:
      return RANGED_ATTACK;
    default:
      return MAX_ATTACK;
  }
}

/** `ApplyPercentModFloatVar`. */
function applyPercentModFloatVar(value: number, val: number, apply: boolean): number {
  return f(value * (apply ? (100 + val) / 100 : 100 / (100 + val)));
}

/** `_ModifyUInt32` from StatSystem.cpp. */
function modifyUInt32(apply: boolean, baseValue: number, amount: number): { value: number; apply: boolean } {
  if (amount < 0) {
    apply = !apply;
    amount = -amount;
  }
  if (apply) {
    return { value: baseValue + amount, apply };
  }
  if (amount > baseValue) {
    amount = baseValue;
  }
  return { value: baseValue - amount, apply };
}
