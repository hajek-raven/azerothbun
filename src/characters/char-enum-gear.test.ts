import { describe, expect, test } from "bun:test";
import { testDatabase } from "../database/test-db.ts";
import { character_inventory, item_instance } from "../database/schema/characters.ts";
import { item_template, spellitemenchantment_dbc } from "../database/schema/world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import {
  ENCHANTMENT_FIELD_COUNT,
  INVENTORY_SLOT_BAG_END,
  SPELL_ITEM_ENCHANTMENT_DBC_GAP,
  emptyCharEnumGearSlot,
  loadCharEnumGear,
  parseItemEnchantments,
  resolveEnumEnchantVisual,
  writeCharEnumGear,
  type CharEnumGearSlot,
} from "./char-enum-gear.ts";

function zeroEnchantments(): string {
  return Array.from({ length: ENCHANTMENT_FIELD_COUNT }, () => "0").join(" ");
}

function enchantmentsWithPerm(enchantId: number, tempId = 0): string {
  const fields = Array.from({ length: ENCHANTMENT_FIELD_COUNT }, () => 0);
  fields[0] = enchantId;
  fields[3] = tempId;
  return fields.join(" ");
}

type TestDb = Awaited<ReturnType<typeof testDatabase>>;

function openCharactersDb(): Promise<TestDb> {
  return testDatabase("characters");
}

async function openWorldDb(): Promise<WorldTables> {
  return WorldTables.fromRows();
}

function insertItemTemplate(world: WorldTables, entry: number, displayid: number, inventoryType: number): void {
  world.insert(item_template, [{ entry, name: `Item ${entry}`, displayid, InventoryType: inventoryType }]);
}

function insertSpellItemEnchantment(world: WorldTables, id: number, itemVisual: number): void {
  world.insert(spellitemenchantment_dbc, [{ ID: id, ItemVisual: itemVisual }]);
}

async function insertItemInstance(db: TestDb, guid: number, itemEntry: number, owner: number, enchantments: string): Promise<void> {
  await db.insert(item_instance).values({ guid, itemEntry, owner_guid: owner, count: 1, charges: "0 0 0 0 0", enchantments, text: "" });
}

async function insertEquippedItem(
  db: TestDb,
  opts: {
    charGuid: number;
    slot: number;
    itemGuid: number;
    itemEntry: number;
    enchantments?: string;
  },
): Promise<void> {
  await insertItemInstance(db, opts.itemGuid, opts.itemEntry, opts.charGuid, opts.enchantments ?? zeroEnchantments());
  await db.insert(character_inventory).values({ guid: opts.charGuid, bag: 0, slot: opts.slot, item: opts.itemGuid });
}

function readGearBytes(bytes: Uint8Array): CharEnumGearSlot[] {
  const reader = new ByteReader(bytes);
  const slots: CharEnumGearSlot[] = [];
  for (let i = 0; i < INVENTORY_SLOT_BAG_END; i += 1) {
    slots.push({
      displayId: reader.readU32(),
      inventoryType: reader.readU8(),
      enchantVisual: reader.readU32(),
      enchantmentId: 0,
    });
  }
  expect(reader.remaining).toBe(0);
  return slots;
}

describe("char enum gear", () => {
  test("empty character writes 23 zero triples matching charEnumPacket", () => {
    const slots = Array.from({ length: INVENTORY_SLOT_BAG_END }, emptyCharEnumGearSlot);
    const writer = new ByteWriter();
    writeCharEnumGear(writer, slots);
    const bytes = writer.toUint8Array();
    expect(bytes.length).toBe(INVENTORY_SLOT_BAG_END * (4 + 1 + 4));
    for (const slot of readGearBytes(bytes)) {
      expect(slot.displayId).toBe(0);
      expect(slot.inventoryType).toBe(0);
      expect(slot.enchantVisual).toBe(0);
    }
  });

  test("parseItemEnchantments requires 36 fields like Item::LoadFromDB", () => {
    expect(parseItemEnchantments("").every((v) => v === 0)).toBe(true);
    expect(parseItemEnchantments("1 2 3").every((v) => v === 0)).toBe(true);
    const fields = parseItemEnchantments(enchantmentsWithPerm(3225, 91));
    expect(fields[0]).toBe(3225);
    expect(fields[3]).toBe(91);
    expect(fields.length).toBe(ENCHANTMENT_FIELD_COUNT);
  });

  test("resolveEnumEnchantVisual prefers PERM then TEMP and uses ItemVisual from DBC", () => {
    const fields = parseItemEnchantments(enchantmentsWithPerm(10, 20));
    const fromDbc = resolveEnumEnchantVisual(fields, (id) => (id === 10 ? 777 : null));
    expect(fromDbc).toEqual({ enchantmentId: 10, enchantVisual: 777, fromDbc: true });

    const skipMissingPerm = resolveEnumEnchantVisual(fields, (id) => (id === 20 ? 888 : null));
    expect(skipMissingPerm).toEqual({ enchantmentId: 20, enchantVisual: 888, fromDbc: true });
  });

  test("DBC gap falls back to enchantment id instead of inventing 0", () => {
    const fields = parseItemEnchantments(enchantmentsWithPerm(3225));
    const gap = resolveEnumEnchantVisual(fields, () => null);
    expect(gap.fromDbc).toBe(false);
    expect(gap.enchantmentId).toBe(3225);
    expect(gap.enchantVisual).toBe(3225);
    expect(SPELL_ITEM_ENCHANTMENT_DBC_GAP.length).toBeGreaterThan(0);
  });

  test("loadCharEnumGear fills display, InventoryType, and enchant visual from inventory", async () => {
    const db = await openCharactersDb();
    const world = await openWorldDb();
    insertItemTemplate(world, 25, 1542, 21);
    insertItemTemplate(world, 38, 9891, 4);
    insertSpellItemEnchantment(world, 3225, 42);

    await insertEquippedItem(db, {
      charGuid: 1,
      slot: 15,
      itemGuid: 100,
      itemEntry: 25,
      enchantments: enchantmentsWithPerm(3225),
    });
    await insertEquippedItem(db, {
      charGuid: 1,
      slot: 3,
      itemGuid: 101,
      itemEntry: 38,
    });

    const gear = await loadCharEnumGear(db, world, 1);
    expect(gear).toHaveLength(INVENTORY_SLOT_BAG_END);
    expect(gear[15]).toEqual({
      displayId: 1542,
      inventoryType: 21,
      enchantVisual: 42,
      enchantmentId: 3225,
    });
    expect(gear[3]).toEqual({
      displayId: 9891,
      inventoryType: 4,
      enchantVisual: 0,
      enchantmentId: 0,
    });
    expect(gear[0]).toEqual(emptyCharEnumGearSlot());

    const writer = new ByteWriter();
    writeCharEnumGear(writer, gear);
    const written = readGearBytes(writer.toUint8Array());
    expect(written[15]).toMatchObject({ displayId: 1542, inventoryType: 21, enchantVisual: 42 });
    expect(written[3]).toMatchObject({ displayId: 9891, inventoryType: 4, enchantVisual: 0 });
    expect(written[0]).toMatchObject({ displayId: 0, inventoryType: 0, enchantVisual: 0 });
  });

  test("missing template or unknown enchant DBC row keep client-safe zeros / id fallback", async () => {
    const db = await openCharactersDb();
    const world = await openWorldDb();
    insertItemTemplate(world, 25, 1542, 21);

    await insertEquippedItem(db, {
      charGuid: 1,
      slot: 15,
      itemGuid: 200,
      itemEntry: 999999,
    });
    await insertEquippedItem(db, {
      charGuid: 1,
      slot: 16,
      itemGuid: 201,
      itemEntry: 25,
      enchantments: enchantmentsWithPerm(55),
    });

    const gear = await loadCharEnumGear(db, world, 1);
    expect(gear[15]).toEqual(emptyCharEnumGearSlot());
    expect(gear[16]).toEqual({
      displayId: 1542,
      inventoryType: 21,
      enchantVisual: 55,
      enchantmentId: 55,
    });
  });

  test("returns empty slots when the character has no inventory rows", async () => {
    const db = await openCharactersDb();
    const world = await openWorldDb();
    const gear = await loadCharEnumGear(db, world, 1);
    expect(gear).toHaveLength(INVENTORY_SLOT_BAG_END);
    expect(gear.every((slot) => slot.displayId === 0 && slot.enchantVisual === 0)).toBe(true);
  });

  test("ignores bag != 0 and slots outside 0..22", async () => {
    const db = await openCharactersDb();
    const world = await openWorldDb();
    insertItemTemplate(world, 25, 1542, 21);

    await insertItemInstance(db, 300, 25, 1, zeroEnchantments());
    await db.insert(character_inventory).values({ guid: 1, bag: 19, slot: 0, item: 300 });

    await insertEquippedItem(db, { charGuid: 1, slot: 0, itemGuid: 301, itemEntry: 25 });

    const gear = await loadCharEnumGear(db, world, 1);
    expect(gear[0]?.displayId).toBe(1542);
    expect(gear.every((slot, i) => i === 0 || slot.displayId === 0)).toBe(true);
  });
});
