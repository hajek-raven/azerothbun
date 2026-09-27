import { expect, test } from "bun:test";
import { item_enchantment_template, item_template } from "../database/schema/world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { seedRandom } from "../common/random.ts";
import { EnchantmentSlot, type ItemInstance } from "./instance.ts";
import { generateEnchSuffixFactor, generateItemRandomPropertyId, ItemDbc, setItemRandomProperties } from "./item-dbc.ts";

// RandPropPoints.dbc row for item level 20: ID, Epic[5], Rare[5], Uncommon[5].
const POINTS_20 = [20, 50, 40, 30, 20, 10, 45, 35, 25, 15, 5, 12, 9, 7, 5, 3];
// ItemRandomSuffix.dbc row: ID, Name[16], mask, internal name, Enchantment[5], AllocationPct[5].
const SUFFIX_6 = [6, ...Array(16).fill(""), 0, "of the Bear", 2801, 2802, 0, 0, 0, 5000, 3000, 0, 0, 0];
// ItemRandomProperties.dbc row: ID, internal name, Enchantment[5], Name[16], mask.
const PROPERTY_9 = [9, "of Strength", 71, 0, 0, 0, 0, ...Array(16).fill(""), 0];

const dbc = ItemDbc.fromRows({
  randPropPoints: [POINTS_20],
  randomSuffix: [SUFFIX_6],
  randomProperties: [PROPERTY_9],
  limitCategories: [[4, ...Array(16).fill(""), 0, 2, 1]],
});

test("GenerateEnchSuffixFactor picks the RandPropPoints column by slot and quality", () => {
  const cloak = { RandomProperty: 0, RandomSuffix: 6, ItemLevel: 20, InventoryType: 16, Quality: 2 };
  expect(generateEnchSuffixFactor(cloak, dbc)).toBe(7);
  expect(generateEnchSuffixFactor({ ...cloak, Quality: 3 }, dbc)).toBe(25);
  expect(generateEnchSuffixFactor({ ...cloak, InventoryType: 5 }, dbc)).toBe(12);
  expect(generateEnchSuffixFactor({ ...cloak, InventoryType: 18 }, dbc)).toBe(0);
  expect(generateEnchSuffixFactor({ ...cloak, RandomSuffix: 0 }, dbc)).toBe(0);
});

test("GenerateItemRandomPropertyId rolls item_enchantment_template and keeps only ids the DBC knows", () => {
  const world = WorldTables.fromRows([
    [item_template, [{ entry: 1, RandomProperty: 0, RandomSuffix: 30 }, { entry: 2, RandomProperty: 40, RandomSuffix: 0 }, { entry: 3, RandomProperty: 41, RandomSuffix: 0 }]],
    [item_enchantment_template, [{ entry: 30, ench: 6, chance: 100 }, { entry: 40, ench: 9, chance: 100 }, { entry: 41, ench: 123, chance: 100 }]],
  ]);
  seedRandom(1);
  expect(generateItemRandomPropertyId(world, dbc, 1)).toBe(-6);
  expect(generateItemRandomPropertyId(world, dbc, 2)).toBe(9);
  expect(generateItemRandomPropertyId(world, dbc, 3)).toBe(0);
});

test("SetItemRandomProperties writes the suffix factor and the PROP_ENCHANTMENT_SLOT enchantments", () => {
  const world = WorldTables.fromRows([[item_template, [{ entry: 1, RandomProperty: 0, RandomSuffix: 30, ItemLevel: 20, InventoryType: 16, Quality: 2 }]]]);
  const item = {
    itemEntry: 1,
    randomPropertyId: 0,
    enchantments: Array.from({ length: 12 }, () => ({ id: 0, duration: 0, charges: 0 })),
    uState: 0,
  } as unknown as ItemInstance;
  setItemRandomProperties(item, -6, world, dbc);
  expect(item.randomPropertyId).toBe(-6);
  expect(item.propertySeed).toBe(7);
  expect(item.enchantments[EnchantmentSlot.PROP_ENCHANTMENT_SLOT_0]!.id).toBe(2801);
  expect(item.enchantments[EnchantmentSlot.PROP_ENCHANTMENT_SLOT_1]!.id).toBe(2802);
  expect(dbc.limitCategory(4)).toEqual({ ID: 4, maxCount: 2, mode: 1 });
});
