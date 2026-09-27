import { expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { testDatabases } from "./database/test-db.ts";
import { character_inventory, item_instance } from "./database/schema/characters.ts";
import { findAccount, listCharacters, seedDevelopmentAccounts } from "./db.ts";

test("Bagtest starts with backpack items and gold", async () => {
  const { login, characters } = await testDatabases();
  await seedDevelopmentAccounts(login, characters, null);
  const account = await findAccount(login, "TEST3");
  expect(account).not.toBeNull();
  const character = (await listCharacters(characters, account!.id)).find((row) => row.name === "Bagtest");
  expect(character?.money).toBe(50_000);
  const rows = await characters
    .select({ slot: character_inventory.slot, itemEntry: item_instance.itemEntry, count: item_instance.count })
    .from(character_inventory)
    .innerJoin(item_instance, eq(item_instance.guid, character_inventory.item))
    .where(and(eq(character_inventory.guid, character!.guid), eq(character_inventory.bag, 0)))
    .orderBy(asc(character_inventory.slot));
  expect(rows).toEqual([
    { slot: 23, itemEntry: 2589, count: 5 },
    { slot: 24, itemEntry: 159, count: 5 },
    { slot: 25, itemEntry: 118, count: 1 },
    { slot: 26, itemEntry: 6948, count: 1 },
    { slot: 27, itemEntry: 25, count: 1 },
    { slot: 28, itemEntry: 4496, count: 1 },
  ]);
});

test("seeding twice leaves one character per development account", async () => {
  const { login, characters } = await testDatabases();
  await seedDevelopmentAccounts(login, characters, null);
  await seedDevelopmentAccounts(login, characters, null);
  const account = await findAccount(login, "TEST");
  expect((await listCharacters(characters, account!.id)).map((row) => row.name)).toEqual(["Test"]);
});
