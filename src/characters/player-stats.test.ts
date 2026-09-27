import { describe, expect, test } from "bun:test";
import { emptyStatDbcStores, GT_MAX_LEVEL, GT_MAX_RATING, type GtTable, type StatDbcStores } from "../data/dbc-stats.ts";
import {
  CLASS_MAGE,
  CLASS_WARRIOR,
  CR_CRIT_MELEE,
  CR_HASTE_MELEE,
  EQUIPMENT_SLOT_MAINHAND,
  PLAYER_CRIT_PERCENTAGE,
  PLAYER_DODGE_PERCENTAGE,
  PLAYER_FIELD_COMBAT_RATING_1,
  PLAYER_PARRY_PERCENTAGE,
  PLAYER_SHIELD_BLOCK,
  PlayerStats,
  POWER_MANA,
  POWER_RAGE,
  PUBLIC_STAT_FIELDS,
  STAT_AGILITY,
  STAT_STAMINA,
  STAT_STRENGTH,
  statItemFromRow,
  UNIT_FIELD_ATTACK_POWER,
  UNIT_FIELD_BASEATTACKTIME,
  UNIT_FIELD_MAXDAMAGE,
  UNIT_FIELD_MINDAMAGE,
  UNIT_FIELD_POSSTAT0,
  UNIT_FIELD_RANGED_ATTACK_POWER,
  UNIT_FIELD_RESISTANCES,
  type PlayerLevelStats,
  type StatItemTemplate,
} from "./player-stats.ts";

// player_class_stats Class=1 Level=1 (+ player_race_stats Race=1, all zero)
const WARRIOR_1: PlayerLevelStats = { baseHealth: 20, baseMana: 0, stats: [23, 20, 22, 20, 20] };
// player_class_stats Class=8 Level=1 + human
const MAGE_1: PlayerLevelStats = { baseHealth: 32, baseMana: 100, stats: [20, 20, 20, 23, 22] };

function warrior(stores: StatDbcStores | null = null): PlayerStats {
  return new PlayerStats({ race: 1, classId: CLASS_WARRIOR, level: 1, maxLevel: 80, levelStats: WARRIOR_1, stores, canParry: true, canBlock: true });
}

function template(overrides: Partial<StatItemTemplate>): StatItemTemplate {
  return {
    entry: 1,
    class: 4,
    subclass: 1,
    InventoryType: 5,
    stats: [],
    ScalingStatDistribution: 0,
    ScalingStatValue: 0,
    damage: [
      { min: 0, max: 0 },
      { min: 0, max: 0 },
    ],
    armor: 0,
    ArmorDamageModifier: 0,
    block: 0,
    holy_res: 0,
    fire_res: 0,
    nature_res: 0,
    frost_res: 0,
    shadow_res: 0,
    arcane_res: 0,
    delay: 0,
    ...overrides,
  };
}

function gt(values: Record<number, number>): GtTable {
  return { lookup: (index) => values[index] };
}

describe("PlayerStats", () => {
  test("level 1 human warrior matches InitStatsForLevel + UpdateAllStats", () => {
    const stats = warrior();
    stats.updateAllStats();
    expect(stats.getStat(STAT_STRENGTH)).toBe(23);
    expect(stats.getStat(STAT_STAMINA)).toBe(22);
    // 20 base + 20 + (22 - 20) * 10
    expect(stats.maxHealth).toBe(60);
    expect(stats.maxPower(POWER_RAGE)).toBe(1000);
    expect(stats.maxPower(POWER_MANA)).toBe(0);
    // agility * 2
    expect(stats.getArmor()).toBe(40);
    // level * 3 + str * 2 - 20
    expect(stats.getInt32(UNIT_FIELD_ATTACK_POWER)).toBe(29);
    // level + agi - 10
    expect(stats.getInt32(UNIT_FIELD_RANGED_ATTACK_POWER)).toBe(11);
    // unarmed: (1 + 29 / 14 * 2) .. (2 + 29 / 14 * 2)
    expect(stats.getFloat(UNIT_FIELD_MINDAMAGE)).toBeCloseTo(1 + (29 / 14) * 2, 4);
    expect(stats.getFloat(UNIT_FIELD_MAXDAMAGE)).toBeCloseTo(2 + (29 / 14) * 2, 4);
    // (0 + 23 * 0.5 - 10) * 1
    expect(stats.getUInt32(PLAYER_SHIELD_BLOCK)).toBe(1);
  });

  test("mana classes get the intellect bonus on max mana", () => {
    const stats = new PlayerStats({ race: 1, classId: CLASS_MAGE, level: 1, maxLevel: 80, levelStats: MAGE_1 });
    stats.updateAllStats();
    // 100 + 20 + (23 - 20) * 15
    expect(stats.maxPower(POWER_MANA)).toBe(165);
    // str - 10
    expect(stats.getInt32(UNIT_FIELD_ATTACK_POWER)).toBe(10);
  });

  test("item stats, armor, and resistances go through the unit mods", () => {
    const stats = warrior();
    stats.updateAllStats();
    stats.setHealth(60);
    stats.equip(4, {
      broken: false,
      template: template({
        stats: [
          { type: 7, value: 10 },
          { type: 4, value: 5 },
        ],
        armor: 100,
        fire_res: 7,
      }),
    });
    expect(stats.getStat(STAT_STAMINA)).toBe(32);
    expect(stats.getStat(STAT_STRENGTH)).toBe(28);
    expect(stats.maxHealth).toBe(60 + 100);
    expect(stats.health).toBe(60);
    expect(stats.getArmor()).toBe(140);
    expect(stats.getResistance(2)).toBe(7);
    expect(stats.getFloat(UNIT_FIELD_POSSTAT0 + STAT_STAMINA)).toBe(10);
    stats.unequip(4);
    expect(stats.maxHealth).toBe(60);
    expect(stats.getArmor()).toBe(40);
    expect(stats.getResistance(2)).toBe(0);
    expect(stats.getFloat(UNIT_FIELD_POSSTAT0 + STAT_STAMINA)).toBe(0);
  });

  test("broken items give no bonuses until repaired", () => {
    const stats = warrior();
    stats.updateAllStats();
    stats.equip(4, { broken: true, template: template({ stats: [{ type: 7, value: 10 }] }) });
    expect(stats.maxHealth).toBe(60);
    stats.setBroken(4, false);
    expect(stats.maxHealth).toBe(160);
    stats.setBroken(4, true);
    expect(stats.maxHealth).toBe(60);
  });

  test("a main hand weapon sets base damage and attack time", () => {
    const stats = warrior();
    stats.updateAllStats();
    stats.equip(EQUIPMENT_SLOT_MAINHAND, {
      broken: false,
      template: template({
        class: 2,
        subclass: 7,
        InventoryType: 13,
        damage: [
          { min: 3, max: 6 },
          { min: 0, max: 0 },
        ],
        delay: 2600,
      }),
    });
    expect(stats.getFloat(UNIT_FIELD_BASEATTACKTIME)).toBe(2600);
    const apBonus = (29 / 14) * 2.6;
    expect(stats.getFloat(UNIT_FIELD_MINDAMAGE)).toBeCloseTo(3 + apBonus, 3);
    expect(stats.getFloat(UNIT_FIELD_MAXDAMAGE)).toBeCloseTo(6 + apBonus, 3);
    stats.unequip(EQUIPMENT_SLOT_MAINHAND);
    expect(stats.getFloat(UNIT_FIELD_BASEATTACKTIME)).toBe(2000);
    expect(stats.getFloat(UNIT_FIELD_MINDAMAGE)).toBeCloseTo(1 + (29 / 14) * 2, 3);
  });

  test("ratings use gtCombatRatings and gtOCTClassCombatRatingScalar", () => {
    const stores = emptyStatDbcStores();
    stores.combatRatings = gt({ [CR_CRIT_MELEE * GT_MAX_LEVEL]: 14, [CR_HASTE_MELEE * GT_MAX_LEVEL]: 10 });
    stores.octClassCombatRatingScalar = gt({ [CR_CRIT_MELEE + 1]: 1, [CR_HASTE_MELEE + 1]: 1 });
    stores.chanceToMeleeCritBase = gt({ 0: 0.05 });
    stores.chanceToMeleeCrit = gt({ 0: 0.0025 });
    const stats = warrior(stores);
    stats.skills = { skillValue: () => 5, maxSkillValue: () => 5 };
    stats.updateAllStats();
    // (0.05 + 20 * 0.0025) * 100
    expect(stats.getFloat(PLAYER_CRIT_PERCENTAGE)).toBeCloseTo(10, 4);
    stats.equip(1, { broken: false, template: template({ stats: [{ type: 19, value: 14 }] }) });
    expect(stats.getUInt32(PLAYER_FIELD_COMBAT_RATING_1 + CR_CRIT_MELEE)).toBe(14);
    expect(stats.getFloat(PLAYER_CRIT_PERCENTAGE)).toBeCloseTo(11, 4);
    stats.equip(2, { broken: false, template: template({ stats: [{ type: 28, value: 10 }] }) });
    // 1% haste → 2000 * 100 / 101
    expect(stats.getFloat(UNIT_FIELD_BASEATTACKTIME)).toBeCloseTo(2000 / 1.01, 2);
    expect(stats.getAttackTime(0)).toBe(2000);
    stats.unequip(2);
    expect(stats.getFloat(UNIT_FIELD_BASEATTACKTIME)).toBeCloseTo(2000, 2);
  });

  test("dodge and parry follow the class diminishing tables", () => {
    const stores = emptyStatDbcStores();
    stores.chanceToMeleeCrit = gt({ 0: 0.0025 });
    const stats = warrior(stores);
    stats.skills = { skillValue: () => 5, maxSkillValue: () => 5 };
    stats.updateAllStats();
    // nondiminishing = 100 * (0.03664 + 20 * 0.0025 * 0.85 / 1.15)
    expect(stats.getFloat(PLAYER_DODGE_PERCENTAGE)).toBeCloseTo(100 * (0.03664 + 20 * 0.0025 * (0.85 / 1.15)), 3);
    expect(stats.getFloat(PLAYER_PARRY_PERCENTAGE)).toBeCloseTo(5, 4);
  });

  test("statItemFromRow drops zero stats like LoadItemTemplates", () => {
    const item = statItemFromRow({ entry: 25, class: 2, stat_type1: 7, stat_value1: 0, stat_type2: 4, stat_value2: 3, dmg_min1: 1.5, delay: 1900 });
    expect(item.stats).toEqual([{ type: 4, value: 3 }]);
    expect(item.damage[0]).toEqual({ min: 1.5, max: 0 });
    expect(item.delay).toBe(1900);
  });

  test("the level up path re-applies item mods at the new level", () => {
    const stats = warrior();
    stats.updateAllStats();
    stats.equip(4, { broken: false, template: template({ stats: [{ type: 7, value: 10 }] }) });
    stats.applyAllLevelScaleItemMods(false);
    stats.applyLevel(2, { baseHealth: 29, baseMana: 0, stats: [24, 21, 23, 20, 20] });
    stats.updateAllStats();
    stats.applyAllLevelScaleItemMods(true);
    stats.updateAllStats();
    // 29 + 20 + (33 - 20) * 10
    expect(stats.maxHealth).toBe(179);
    expect(stats.getStat(STAT_AGILITY)).toBe(21);
  });

  test("only public fields reach other players", () => {
    const stats = warrior();
    stats.updateAllStats();
    const indices = stats.fieldEntries(PUBLIC_STAT_FIELDS).map((entry) => entry.index);
    expect(indices).not.toContain(UNIT_FIELD_ATTACK_POWER);
    expect(indices).not.toContain(UNIT_FIELD_RESISTANCES);
    expect(indices).toContain(0x0006 + 0x001a);
  });

  test("takeChanged reports writes once", () => {
    const stats = warrior();
    stats.updateAllStats();
    stats.takeChanged();
    stats.setHealth(10);
    expect(stats.takeChanged()).toEqual([0x0006 + 0x0012]);
    expect(stats.takeChanged()).toEqual([]);
  });

  test("gt tables index by class and level", () => {
    expect(GT_MAX_RATING).toBe(32);
  });
});
