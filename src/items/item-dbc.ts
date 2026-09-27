/**
 * The item DBC stores read when an item is created or stored (`DBCStores.cpp`):
 * `sRandomPropertiesPointsStore`, `sItemRandomPropertiesStore`, `sItemRandomSuffixStore`, and `sItemLimitCategoryStore`.
 * Each is `data/dbc/<file>` overridden by its `*_dbc` world table, like `DBCDatabaseLoader`.
 */

import { itemlimitcategory_dbc, itemrandomproperties_dbc, itemrandomsuffix_dbc, item_template, randproppoints_dbc } from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { DbcTable } from "../spells/dbc-table.ts";
import {
  INVTYPE_2HWEAPON,
  INVTYPE_AMMO,
  INVTYPE_BAG,
  INVTYPE_BODY,
  INVTYPE_CHEST,
  INVTYPE_CLOAK,
  INVTYPE_FEET,
  INVTYPE_FINGER,
  INVTYPE_HANDS,
  INVTYPE_HEAD,
  INVTYPE_HOLDABLE,
  INVTYPE_LEGS,
  INVTYPE_NECK,
  INVTYPE_NON_EQUIP,
  INVTYPE_QUIVER,
  INVTYPE_RANGED,
  INVTYPE_RANGEDRIGHT,
  INVTYPE_RELIC,
  INVTYPE_ROBE,
  INVTYPE_SHIELD,
  INVTYPE_SHOULDERS,
  INVTYPE_TABARD,
  INVTYPE_THROWN,
  INVTYPE_TRINKET,
  INVTYPE_WAIST,
  INVTYPE_WEAPON,
  INVTYPE_WEAPONMAINHAND,
  INVTYPE_WEAPONOFFHAND,
  INVTYPE_WRISTS,
} from "./equip.ts";
import { EnchantmentSlot, getItemEnchantMod, SetEnchantment, type ItemInstance } from "./instance.ts";

/** `ItemQualities` */
const ITEM_QUALITY_UNCOMMON = 2;
const ITEM_QUALITY_RARE = 3;
const ITEM_QUALITY_EPIC = 4;

/** `ItemLimitCategoryMode` */
export const ITEM_LIMIT_CATEGORY_MODE_HAVE = 0;
export const ITEM_LIMIT_CATEGORY_MODE_EQUIP = 1;

/** `MAX_ITEM_ENCHANTMENT_EFFECTS` */
const MAX_ITEM_ENCHANTMENT_EFFECTS = 5;

// Field positions in the DBC record (and in the `*_dbc` table, which keeps the DBC field order).
/** RandPropPoints.dbc: ID, EpicPropertiesPoints[5], RarePropertiesPoints[5], UncommonPropertiesPoints[5]. */
const RAND_PROP_POINTS_EPIC = 1;
const RAND_PROP_POINTS_RARE = 6;
const RAND_PROP_POINTS_UNCOMMON = 11;
/** ItemRandomProperties.dbc: ID, internal name, Enchantment[5], Name[16], mask. */
const ITEM_RANDOM_PROPERTIES_ENCHANTMENT = 2;
/** ItemRandomSuffix.dbc: ID, Name[16], mask, internal name, Enchantment[5], AllocationPct[5]. */
const ITEM_RANDOM_SUFFIX_ENCHANTMENT = 19;
/** ItemLimitCategory.dbc: ID, Name[16], mask, maxCount, mode. */
const ITEM_LIMIT_CATEGORY_MAX_COUNT = 18;
const ITEM_LIMIT_CATEGORY_MODE = 19;

export type ItemLimitCategoryEntry = { ID: number; maxCount: number; mode: number };

export class ItemDbc {
  constructor(
    private readonly randPropPoints: DbcTable,
    private readonly randomProperties: DbcTable,
    private readonly randomSuffix: DbcTable,
    private readonly limitCategories: DbcTable,
  ) {}

  static async load(directory: string, world: WorldTables | null): Promise<ItemDbc> {
    return new ItemDbc(
      await DbcTable.load(directory, "RandPropPoints.dbc", world, randproppoints_dbc),
      await DbcTable.load(directory, "ItemRandomProperties.dbc", world, itemrandomproperties_dbc),
      await DbcTable.load(directory, "ItemRandomSuffix.dbc", world, itemrandomsuffix_dbc),
      await DbcTable.load(directory, "ItemLimitCategory.dbc", world, itemlimitcategory_dbc),
    );
  }

  /** No DBC rows (tests, or a server started without `data/dbc`). */
  static empty(): ItemDbc {
    return new ItemDbc(new DbcTable(null), new DbcTable(null), new DbcTable(null), new DbcTable(null));
  }

  /** Stores from rows given in DBC field order (tests). */
  static fromRows(rows: {
    randPropPoints?: readonly unknown[][];
    randomProperties?: readonly unknown[][];
    randomSuffix?: readonly unknown[][];
    limitCategories?: readonly unknown[][];
  }): ItemDbc {
    return new ItemDbc(
      new DbcTable(null, rows.randPropPoints ?? []),
      new DbcTable(null, rows.randomProperties ?? []),
      new DbcTable(null, rows.randomSuffix ?? []),
      new DbcTable(null, rows.limitCategories ?? []),
    );
  }

  hasRandomProperties(id: number): boolean {
    return this.randomProperties.has(id);
  }

  hasRandomSuffix(id: number): boolean {
    return this.randomSuffix.has(id);
  }

  /** `ItemRandomPropertiesEntry::Enchantment` */
  randomPropertiesEnchantments(id: number): number[] | null {
    const record = this.randomProperties.record(id);
    if (!record) return null;
    return Array.from({ length: MAX_ITEM_ENCHANTMENT_EFFECTS }, (_, i) => record.u32(ITEM_RANDOM_PROPERTIES_ENCHANTMENT + i));
  }

  /** `ItemRandomSuffixEntry::Enchantment` */
  randomSuffixEnchantments(id: number): number[] | null {
    const record = this.randomSuffix.record(id);
    if (!record) return null;
    return Array.from({ length: MAX_ITEM_ENCHANTMENT_EFFECTS }, (_, i) => record.u32(ITEM_RANDOM_SUFFIX_ENCHANTMENT + i));
  }

  /** `RandomPropertiesPointsEntry` for an item level, split by quality. */
  randomPropertiesPoints(itemLevel: number): { epic: number[]; rare: number[]; uncommon: number[] } | null {
    const record = this.randPropPoints.record(itemLevel);
    if (!record) return null;
    const points = (base: number): number[] => Array.from({ length: 5 }, (_, i) => record.u32(base + i));
    return { epic: points(RAND_PROP_POINTS_EPIC), rare: points(RAND_PROP_POINTS_RARE), uncommon: points(RAND_PROP_POINTS_UNCOMMON) };
  }

  /** `sItemLimitCategoryStore.LookupEntry` */
  limitCategory(id: number): ItemLimitCategoryEntry | null {
    const record = this.limitCategories.record(id);
    if (!record) return null;
    return { ID: id, maxCount: record.u32(ITEM_LIMIT_CATEGORY_MAX_COUNT), mode: record.u32(ITEM_LIMIT_CATEGORY_MODE) };
  }
}

/** The `item_template` columns random enchantments read. */
export type RandomEnchantProto = {
  RandomProperty: number;
  RandomSuffix: number;
  ItemLevel: number;
  InventoryType: number;
  Quality: number;
};

function randomEnchantProto(world: WorldTables | null, entry: number): RandomEnchantProto | null {
  const row = world?.first(item_template, "entry", entry);
  if (!row) return null;
  return {
    RandomProperty: row.RandomProperty | 0,
    RandomSuffix: row.RandomSuffix >>> 0,
    ItemLevel: row.ItemLevel,
    InventoryType: row.InventoryType,
    Quality: row.Quality,
  };
}

/** `GenerateEnchSuffixFactor` (ItemEnchantmentMgr.cpp). */
export function generateEnchSuffixFactor(proto: RandomEnchantProto | null, dbc: ItemDbc): number {
  if (!proto || !proto.RandomSuffix) {
    return 0;
  }
  const randomProperty = dbc.randomPropertiesPoints(proto.ItemLevel);
  if (!randomProperty) {
    return 0;
  }
  let suffixFactor: number;
  switch (proto.InventoryType) {
    // Items of that type don`t have points
    case INVTYPE_NON_EQUIP:
    case INVTYPE_BAG:
    case INVTYPE_TABARD:
    case INVTYPE_AMMO:
    case INVTYPE_QUIVER:
    case INVTYPE_RELIC:
      return 0;
    // Select point coefficient
    case INVTYPE_HEAD:
    case INVTYPE_BODY:
    case INVTYPE_CHEST:
    case INVTYPE_LEGS:
    case INVTYPE_2HWEAPON:
    case INVTYPE_ROBE:
      suffixFactor = 0;
      break;
    case INVTYPE_SHOULDERS:
    case INVTYPE_WAIST:
    case INVTYPE_FEET:
    case INVTYPE_HANDS:
    case INVTYPE_TRINKET:
      suffixFactor = 1;
      break;
    case INVTYPE_NECK:
    case INVTYPE_WRISTS:
    case INVTYPE_FINGER:
    case INVTYPE_SHIELD:
    case INVTYPE_CLOAK:
    case INVTYPE_HOLDABLE:
      suffixFactor = 2;
      break;
    case INVTYPE_WEAPON:
    case INVTYPE_WEAPONMAINHAND:
    case INVTYPE_WEAPONOFFHAND:
      suffixFactor = 3;
      break;
    case INVTYPE_RANGED:
    case INVTYPE_THROWN:
    case INVTYPE_RANGEDRIGHT:
      suffixFactor = 4;
      break;
    default:
      return 0;
  }
  // Select rare/epic modifier
  switch (proto.Quality) {
    case ITEM_QUALITY_UNCOMMON:
      return randomProperty.uncommon[suffixFactor]!;
    case ITEM_QUALITY_RARE:
      return randomProperty.rare[suffixFactor]!;
    case ITEM_QUALITY_EPIC:
      return randomProperty.epic[suffixFactor]!;
    default:
      return 0;
  }
}

/** `GenerateEnchSuffixFactor(item_id)` */
export function generateEnchSuffixFactorFor(world: WorldTables | null, dbc: ItemDbc, entry: number): number {
  return generateEnchSuffixFactor(randomEnchantProto(world, entry), dbc);
}

/** `Item::GenerateItemRandomPropertyId`: positive is `ItemRandomProperties`, negative is `ItemRandomSuffix`. */
export function generateItemRandomPropertyId(world: WorldTables | null, dbc: ItemDbc, entry: number): number {
  const proto = randomEnchantProto(world, entry);
  if (!world || !proto) {
    return 0;
  }
  // item must have one from this field values not null if it can have random enchantments
  if (!proto.RandomProperty && !proto.RandomSuffix) {
    return 0;
  }
  // item can have not null only one from field values
  if (proto.RandomProperty && proto.RandomSuffix) {
    return 0;
  }
  if (proto.RandomProperty) {
    const randomPropId = getItemEnchantMod(world, proto.RandomProperty);
    return dbc.hasRandomProperties(randomPropId) ? randomPropId : 0;
  }
  const randomPropId = getItemEnchantMod(world, proto.RandomSuffix);
  return dbc.hasRandomSuffix(randomPropId) ? -randomPropId : 0;
}

/** `Item::SetItemRandomProperties`: the id, the suffix factor, and the `PROP_ENCHANTMENT_SLOT_*` enchantments. */
export function setItemRandomProperties(item: ItemInstance, randomPropId: number, world: WorldTables | null, dbc: ItemDbc): void {
  if (!randomPropId) {
    return;
  }
  const enchantments = randomPropId > 0 ? dbc.randomPropertiesEnchantments(randomPropId) : dbc.randomSuffixEnchantments(-randomPropId);
  if (!enchantments) {
    return;
  }
  item.randomPropertyId = randomPropId;
  if (randomPropId < 0) {
    // `Item::UpdateItemSuffixFactor`
    item.propertySeed = generateEnchSuffixFactorFor(world, dbc, item.itemEntry);
  }
  for (let slot = EnchantmentSlot.PROP_ENCHANTMENT_SLOT_0; slot < EnchantmentSlot.MAX_ENCHANTMENT_SLOT; slot++) {
    SetEnchantment(item, slot, enchantments[slot - EnchantmentSlot.PROP_ENCHANTMENT_SLOT_0]!, 0, 0);
  }
}
