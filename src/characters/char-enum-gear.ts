import { and, eq, gte, lt } from "drizzle-orm";
import type { Db } from "../database/database.ts";
import { character_inventory, item_instance } from "../database/schema/characters.ts";
import { item_template, spellitemenchantment_dbc } from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import type { ByteWriter } from "../net/byte-buffer.ts";

/** Equipment + equipped bags written in SMSG_CHAR_ENUM (INVENTORY_SLOT_BAG_END). */
export const INVENTORY_SLOT_BAG_END = 23;

export const PERM_ENCHANTMENT_SLOT = 0;
export const TEMP_ENCHANTMENT_SLOT = 1;
export const MAX_ENCHANTMENT_SLOT = 12;
export const MAX_ENCHANTMENT_OFFSET = 3;
export const ENCHANTMENT_ID_OFFSET = 0;
export const ENCHANTMENT_FIELD_COUNT = MAX_ENCHANTMENT_SLOT * MAX_ENCHANTMENT_OFFSET;

/**
 * SpellItemEnchantment.dbc is not loaded in `src/data/dbc.ts`. The world dump ships
 * `spellitemenchantment_dbc` (ItemVisual = C++ aura_id) but the base dump has 0 rows.
 * When no DBC/SQL row exists for a PERM/TEMP enchant id, `enchantVisual` is that id
 * (not 0) so the packet field stays populated until the table/DBC is filled. Use 0 only
 * when there is no PERM/TEMP enchant id (same as BuildEnumData with a null entry).
 */
export const SPELL_ITEM_ENCHANTMENT_DBC_GAP =
  "SpellItemEnchantment.dbc / spellitemenchantment_dbc ItemVisual not available; enchantVisual falls back to enchantment id";

export type CharEnumGearSlot = {
  displayId: number;
  inventoryType: number;
  /** ItemVisual (aura_id) from spellitemenchantment_dbc, or enchantment id on DBC gap. */
  enchantVisual: number;
  /** PERM then TEMP enchantment id selected for the visual (0 if none). */
  enchantmentId: number;
};

type InventoryGearRow = {
  slot: number;
  itemEntry: number;
  enchantments: string | null;
};

type ItemTemplateDisplay = {
  displayid: number;
  InventoryType: number;
};

type SpellItemEnchantmentVisual = {
  ItemVisual: number;
};

export function emptyCharEnumGearSlot(): CharEnumGearSlot {
  return { displayId: 0, inventoryType: 0, enchantVisual: 0, enchantmentId: 0 };
}

/** Parse `item_instance.enchantments` the way Item::_LoadIntoDataField does (36 uints). */
export function parseItemEnchantments(enchantments: string | null | undefined): number[] {
  const fields = new Array<number>(ENCHANTMENT_FIELD_COUNT).fill(0);
  if (enchantments == null || enchantments === "") {
    return fields;
  }
  const tokens = enchantments.trim().split(/\s+/);
  if (tokens.length !== ENCHANTMENT_FIELD_COUNT) {
    return fields;
  }
  for (let i = 0; i < ENCHANTMENT_FIELD_COUNT; i += 1) {
    const value = Number.parseInt(tokens[i]!, 10);
    fields[i] = Number.isFinite(value) && value >= 0 ? value >>> 0 : 0;
  }
  return fields;
}

export function enchantmentIdAt(fields: readonly number[], slot: number): number {
  const index = slot * MAX_ENCHANTMENT_OFFSET + ENCHANTMENT_ID_OFFSET;
  return fields[index] ?? 0;
}

/**
 * BuildEnumData: walk PERM then TEMP, LookupEntry SpellItemEnchantment, send aura_id.
 * Without a DBC/SQL hit, expose the first non-zero enchant id (see SPELL_ITEM_ENCHANTMENT_DBC_GAP).
 */
export function resolveEnumEnchantVisual(
  fields: readonly number[],
  lookupItemVisual: (enchantId: number) => number | null,
): { enchantmentId: number; enchantVisual: number; fromDbc: boolean } {
  let fallbackId = 0;
  for (let slot = PERM_ENCHANTMENT_SLOT; slot <= TEMP_ENCHANTMENT_SLOT; slot += 1) {
    const enchantId = enchantmentIdAt(fields, slot);
    if (!enchantId) {
      continue;
    }
    if (fallbackId === 0) {
      fallbackId = enchantId;
    }
    const itemVisual = lookupItemVisual(enchantId);
    if (itemVisual !== null) {
      return { enchantmentId: enchantId, enchantVisual: itemVisual >>> 0, fromDbc: true };
    }
  }
  return {
    enchantmentId: fallbackId,
    enchantVisual: fallbackId,
    fromDbc: false,
  };
}

function lookupSpellItemEnchantmentVisual(world: WorldTables, enchantId: number): number | null {
  const row = world.first(spellitemenchantment_dbc, "ID", enchantId);
  return row ? row.ItemVisual >>> 0 : null;
}

function loadItemTemplateDisplay(world: WorldTables, entry: number): ItemTemplateDisplay | null {
  if (!entry) {
    return null;
  }
  const row = world.first(item_template, "entry", entry);
  return row ? { displayid: row.displayid, InventoryType: row.InventoryType } : null;
}

/**
 * Load bag=0 slots 0..22 from character_inventory ⊕ item_instance, resolve display/InventoryType
 * from item_template, and enchant visual like Player::BuildEnumData.
 */
export async function loadCharEnumGear(db: Db, world: WorldTables, guid: number): Promise<CharEnumGearSlot[]> {
  const slots: CharEnumGearSlot[] = Array.from({ length: INVENTORY_SLOT_BAG_END }, emptyCharEnumGearSlot);
  const rows: InventoryGearRow[] = (
    await db
      .select({ slot: character_inventory.slot, itemEntry: item_instance.itemEntry, enchantments: item_instance.enchantments })
      .from(character_inventory)
      .innerJoin(item_instance, eq(item_instance.guid, character_inventory.item))
      .where(
        and(
          eq(character_inventory.guid, guid),
          eq(character_inventory.bag, 0),
          gte(character_inventory.slot, 0),
          lt(character_inventory.slot, INVENTORY_SLOT_BAG_END),
        ),
      )
  ).map((row) => ({ ...row, itemEntry: row.itemEntry ?? 0 }));

  for (const row of rows) {
    const slot = row.slot;
    if (slot < 0 || slot >= INVENTORY_SLOT_BAG_END) {
      continue;
    }
    const proto = loadItemTemplateDisplay(world, row.itemEntry >>> 0);
    if (!proto) {
      continue;
    }
    const enchantFields = parseItemEnchantments(row.enchantments);
    const enchant = resolveEnumEnchantVisual(enchantFields, (id) => lookupSpellItemEnchantmentVisual(world, id));
    slots[slot] = {
      displayId: proto.displayid >>> 0,
      inventoryType: proto.InventoryType & 0xff,
      enchantVisual: enchant.enchantVisual,
      enchantmentId: enchant.enchantmentId,
    };
  }
  return slots;
}

/** Write exactly 23 triples: u32 displayId, u8 inventoryType, u32 enchantVisual. */
export function writeCharEnumGear(writer: ByteWriter, slots: readonly CharEnumGearSlot[]): void {
  for (let slot = 0; slot < INVENTORY_SLOT_BAG_END; slot += 1) {
    const gear = slots[slot] ?? emptyCharEnumGearSlot();
    writer.writeU32(gear.displayId).writeU8(gear.inventoryType).writeU32(gear.enchantVisual);
  }
}
