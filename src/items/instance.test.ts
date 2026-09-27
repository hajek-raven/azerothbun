import { eq } from "drizzle-orm";
import { testDatabase } from "../database/test-db.ts";
import { item_instance } from "../database/schema/characters.ts";
import { item_enchantment_template, item_template } from "../database/schema/world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { describe, expect, test } from "bun:test";
import { seedRandom } from "../common/random.ts";
import {
  EnchantmentSlot,
  GenerateRandomProperty,
  IsBroken,
  ITEM_FIELD_DURABILITY,
  ITEM_FIELD_ENCHANTMENT_1_1,
  ITEM_FIELD_MAXDURABILITY,
  ITEM_FIELD_RANDOM_PROPERTIES_ID,
  ITEM_FIELD_SPELL_CHARGES,
  ITEM_FIELD_STACK_COUNT,
  MAX_ENCHANTMENT_OFFSET,
  MAX_ENCHANTMENT_SLOT,
  MAX_ITEM_PROTO_SPELLS,
  OBJECT_FIELD_ENTRY,
  SetDurability,
  SetEnchantment,
  SetGem,
  createItem,
  emptyChargesString,
  emptyEnchantmentsString,
  getItemEnchantMod,
  itemFieldValues,
  loadItem,
  parseCharges,
  parseEnchantments,
  saveItem,
  serializeCharges,
  serializeEnchantments,
  writeItemUpdate,
} from "./instance.ts";

function openDb() {
  return testDatabase("characters");
}

async function instanceRow(db: Awaited<ReturnType<typeof openDb>>, guid: number) {
  const [row] = await db.select().from(item_instance).where(eq(item_instance.guid, guid));
  return row!;
}

describe("item_instance enchantments text", () => {
  test("empty default matches SaveToDB zeros (36 values, trailing space)", () => {
    const empty = emptyEnchantmentsString();
    expect(empty.endsWith(" ")).toBe(true);
    const tokens = empty.trimEnd().split(" ");
    expect(tokens.length).toBe(MAX_ENCHANTMENT_SLOT * MAX_ENCHANTMENT_OFFSET);
    expect(tokens.every((t) => t === "0")).toBe(true);
    expect(serializeEnchantments(parseEnchantments(empty))).toBe(empty);
  });

  test("round-trip perm enchant and two gems", () => {
    const slots = parseEnchantments(emptyEnchantmentsString());
    // Crusader (1900) permanent
    slots[EnchantmentSlot.PERM_ENCHANTMENT_SLOT] = { id: 1900, duration: 0, charges: 0 };
    // two socket gems as SpellItemEnchantment ids
    slots[EnchantmentSlot.SOCK_ENCHANTMENT_SLOT] = { id: 2681, duration: 0, charges: 0 };
    slots[EnchantmentSlot.SOCK_ENCHANTMENT_SLOT_2] = { id: 2682, duration: 0, charges: 0 };

    const text = serializeEnchantments(slots);
    expect(text.endsWith(" ")).toBe(true);

    const again = parseEnchantments(text);
    expect(again[EnchantmentSlot.PERM_ENCHANTMENT_SLOT]).toEqual({
      id: 1900,
      duration: 0,
      charges: 0,
    });
    expect(again[EnchantmentSlot.SOCK_ENCHANTMENT_SLOT]).toEqual({
      id: 2681,
      duration: 0,
      charges: 0,
    });
    expect(again[EnchantmentSlot.SOCK_ENCHANTMENT_SLOT_2]).toEqual({
      id: 2682,
      duration: 0,
      charges: 0,
    });
    expect(again[EnchantmentSlot.TEMP_ENCHANTMENT_SLOT]).toEqual({
      id: 0,
      duration: 0,
      charges: 0,
    });
    expect(serializeEnchantments(again)).toBe(text);
  });
});

describe("item_instance charges text", () => {
  test("empty default and signed round-trip", () => {
    const empty = emptyChargesString();
    expect(empty).toBe("0 0 0 0 0 ");
    expect(parseCharges(empty)).toEqual([0, 0, 0, 0, 0]);

    const charges = [-1, 5, 0, 3, 0];
    const text = serializeCharges(charges);
    expect(text).toBe("-1 5 0 3 0 ");
    expect(parseCharges(text)).toEqual(charges);
    expect(parseCharges(text).length).toBe(MAX_ITEM_PROTO_SPELLS);
  });
});

describe("durability", () => {
  test("clamps to max and breaks at 0", async () => {
    const db = await openDb();
    const item = await createItem(db, null, {
      entry: 25,
      owner: 1,
      durability: 40,
      maxDurability: 40,
    });
    expect(item.durability).toBe(40);
    expect(IsBroken(item)).toBe(false);

    SetDurability(item, 99);
    expect(item.durability).toBe(40);

    SetDurability(item, -5);
    expect(item.durability).toBe(0);
    expect(IsBroken(item)).toBe(true);

    SetDurability(item, 10, 20);
    expect(item.maxDurability).toBe(20);
    expect(item.durability).toBe(10);
    expect(IsBroken(item)).toBe(false);
  });
});

describe("create / load / save", () => {
  test("persists randomPropertyId, enchants, charges, durability", async () => {
    const db = await openDb();
    const item = await createItem(db, null, {
      entry: 859,
      owner: 42,
      count: 1,
      durability: 35,
      maxDurability: 40,
      randomPropertyId: 61,
      charges: [-1, 0, 0, 0, 0],
    });

    SetEnchantment(item, EnchantmentSlot.PERM_ENCHANTMENT_SLOT, 1900, 0, 0);
    SetGem(item, 0, 2681);
    SetGem(item, 1, 2682);
    await saveItem(db, item);

    const loaded = await loadItem(db, null, item.guid);
    expect(loaded).not.toBeNull();
    expect(loaded!.itemEntry).toBe(859);
    expect(loaded!.owner_guid).toBe(42);
    expect(loaded!.randomPropertyId).toBe(61);
    expect(loaded!.durability).toBe(35);
    expect(loaded!.charges).toEqual([-1, 0, 0, 0, 0]);
    expect(loaded!.enchantments[EnchantmentSlot.PERM_ENCHANTMENT_SLOT]!.id).toBe(1900);
    expect(loaded!.enchantments[EnchantmentSlot.SOCK_ENCHANTMENT_SLOT]!.id).toBe(2681);
    expect(loaded!.enchantments[EnchantmentSlot.SOCK_ENCHANTMENT_SLOT_2]!.id).toBe(2682);

    const row = await instanceRow(db, item.guid);
    expect(row.randomPropertyId).toBe(61);
    expect(row.charges).toBe("-1 0 0 0 0 ");
    expect(row.enchantments).toBe(serializeEnchantments(loaded!.enchantments));
    expect(row.enchantments.startsWith("1900 0 0 0 0 0 2681 0 0 2682 0 0 ")).toBe(true);
  });

  test("new item writes the empty enchantments default", async () => {
    const db = await openDb();
    const item = await createItem(db, null, { entry: 1, owner: 1 });
    const row = await instanceRow(db, item.guid);
    expect(row.enchantments).toBe(emptyEnchantmentsString());
    expect(row.charges).toBe(emptyChargesString());
  });
});

describe("GenerateRandomProperty", () => {
  test("rolls from item_enchantment_template and persists id", async () => {
    seedRandom(12345);
    const db = await openDb();
    const world = WorldTables.fromRows([
      [item_template, [{ entry: 859, MaxDurability: 40, RandomProperty: 61 }]],
      [item_enchantment_template, [{ entry: 61, ench: 6, chance: 50 }, { entry: 61, ench: 8, chance: 50 }]],
    ]);

    const ench = getItemEnchantMod(world, 61);
    expect([6, 8]).toContain(ench);

    const randomPropertyId = GenerateRandomProperty(world, 859);
    expect([6, 8]).toContain(randomPropertyId);

    const item = await createItem(db, world, {
      entry: 859,
      owner: 1,
      randomPropertyId,
    });
    const loaded = (await loadItem(db, world, item.guid))!;
    expect(loaded.randomPropertyId).toBe(randomPropertyId);
    expect(loaded.maxDurability).toBe(40);
  });
});

describe("item field values / update block", () => {
  test("exports ITEM_FIELD indexes and builds a values update", async () => {
    const db = await openDb();
    const item = await createItem(db, null, {
      entry: 25,
      owner: 1,
      count: 3,
      durability: 10,
      maxDurability: 20,
      randomPropertyId: 7,
      charges: [2, 0, 0, 0, 0],
    });
    SetEnchantment(item, EnchantmentSlot.PERM_ENCHANTMENT_SLOT, 1900, 0, 0);

    const fields = itemFieldValues(item);
    const byIndex = new Map(fields.map((f) => [f.index, f.value]));
    expect(byIndex.get(OBJECT_FIELD_ENTRY)).toBe(25);
    expect(byIndex.get(ITEM_FIELD_STACK_COUNT)).toBe(3);
    expect(byIndex.get(ITEM_FIELD_SPELL_CHARGES)).toBe(2);
    expect(byIndex.get(ITEM_FIELD_ENCHANTMENT_1_1)).toBe(1900);
    expect(byIndex.get(ITEM_FIELD_RANDOM_PROPERTIES_ID)).toBe(7);
    expect(byIndex.get(ITEM_FIELD_DURABILITY)).toBe(10);
    expect(byIndex.get(ITEM_FIELD_MAXDURABILITY)).toBe(20);

    const blob = writeItemUpdate(item.guid, fields);
    expect(blob.byteLength).toBeGreaterThan(8);
    expect(blob[4]).toBe(0); // UPDATETYPE_VALUES
  });
});
