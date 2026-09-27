import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { testDatabase } from "../database/test-db.ts";
import { characters } from "../database/schema/characters.ts";
import {
  CHAR_NAME_IN_USE,
  CHAR_NAME_INVALID,
  CHAR_NAME_OK,
  CHAR_NAME_TOO_SHORT,
  checkCharacterName,
  createCharacter,
  deleteCharacter,
  loadCharacterKit,
  type CharacterDraft,
  type CharacterKit,
} from "./store.ts";

function openTestDb() {
  return testDatabase("characters");
}

type TestDb = Awaited<ReturnType<typeof openTestDb>>;

function characterCount(db: TestDb, guid?: number): Promise<number> {
  return db.$count(characters, guid === undefined ? undefined : eq(characters.guid, guid));
}

function sampleDraft(overrides: Partial<CharacterDraft> = {}): CharacterDraft {
  return {
    accountId: 1,
    name: "Thrall",
    race: 1,
    classId: 1,
    gender: 0,
    skin: 1,
    face: 1,
    hairStyle: 1,
    hairColor: 1,
    facialStyle: 0,
    level: 1,
    map: 0,
    zone: 12,
    x: -8949.95,
    y: -132.493,
    z: 83.5312,
    orientation: 0,
    health: 60,
    ...overrides,
  };
}

function sampleKit(overrides: Partial<CharacterKit> = {}): CharacterKit {
  return {
    spells: [6603, 78, 81],
    actions: [
      { button: 0, action: 6603, type: 0 },
      { button: 1, action: 78, type: 0 },
    ],
    skills: [
      { skill: 26, value: 1, max: 1 },
      { skill: 95, value: 1, max: 5 },
    ],
    factions: [
      { faction: 72, standing: 0, flags: 0 },
      { faction: 47, standing: 3000, flags: 17 },
    ],
    homebind: {
      mapId: 0,
      zoneId: 12,
      posX: -8949.95,
      posY: -132.493,
      posZ: 83.5312,
    },
    ...overrides,
  };
}

describe("checkCharacterName", () => {
  test("accepts a valid unused name", async () => {
    const db = await openTestDb();
    expect(await checkCharacterName(db, "Thrall")).toBe(CHAR_NAME_OK);
  });

  test("rejects a short name", async () => {
    const db = await openTestDb();
    expect(await checkCharacterName(db, "A")).toBe(CHAR_NAME_TOO_SHORT);
  });

  test("rejects three identical letters", async () => {
    const db = await openTestDb();
    expect(await checkCharacterName(db, "Aaa")).toBe(CHAR_NAME_INVALID);
    expect(await checkCharacterName(db, "Booo")).toBe(CHAR_NAME_INVALID);
  });

  test("rejects a duplicate name case-insensitively without inserting", async () => {
    const db = await openTestDb();
    await createCharacter(db, sampleDraft({ name: "Thrall" }), sampleKit());
    expect(await checkCharacterName(db, "thrall")).toBe(CHAR_NAME_IN_USE);
    expect(await checkCharacterName(db, "THRALL")).toBe(CHAR_NAME_IN_USE);
    expect(await characterCount(db)).toBe(1);
  });
});

describe("createCharacter / loadCharacterKit", () => {
  test("create then load roundtrip preserves kit and sorts rows", async () => {
    const db = await openTestDb();
    const kit = sampleKit({
      spells: [81, 6603, 78],
      actions: [
        { button: 2, action: 81, type: 0 },
        { button: 0, action: 6603, type: 0 },
        { button: 1, action: 78, type: 0 },
      ],
      skills: [
        { skill: 95, value: 1, max: 5 },
        { skill: 26, value: 1, max: 1 },
      ],
      factions: [
        { faction: 72, standing: 0, flags: 0 },
        { faction: 47, standing: 3000, flags: 17 },
      ],
    });

    const guid = await createCharacter(db, sampleDraft(), kit);
    expect(guid).toBeGreaterThan(0);

    const loaded = await loadCharacterKit(db, guid);
    expect(loaded.spells).toEqual([78, 81, 6603]);
    expect(loaded.actions).toEqual([
      { button: 0, action: 6603, type: 0 },
      { button: 1, action: 78, type: 0 },
      { button: 2, action: 81, type: 0 },
    ]);
    expect(loaded.skills).toEqual([
      { skill: 26, value: 1, max: 1 },
      { skill: 95, value: 1, max: 5 },
    ]);
    expect(loaded.factions).toEqual([
      { faction: 47, standing: 3000, flags: 17 },
      { faction: 72, standing: 0, flags: 0 },
    ]);
    expect(loaded.homebind).toEqual(kit.homebind);

    const [row] = await db
      .select({ name: characters.name, class: characters.class, position_x: characters.position_x })
      .from(characters)
      .where(eq(characters.guid, guid));
    expect(row).toEqual({ name: "Thrall", class: 1, position_x: -8949.95 });
  });

  test("throws numeric code string when the name fails", async () => {
    const db = await openTestDb();
    await expect(createCharacter(db, sampleDraft({ name: "A" }), sampleKit())).rejects.toThrow("1");
    await expect(createCharacter(db, sampleDraft({ name: "Aaa" }), sampleKit())).rejects.toThrow("3");
    await createCharacter(db, sampleDraft({ name: "Thrall" }), sampleKit());
    await expect(createCharacter(db, sampleDraft({ name: "thrall" }), sampleKit())).rejects.toThrow("4");
    expect(await characterCount(db)).toBe(1);
  });

  test("homebind stays fixed when characters position changes", async () => {
    const db = await openTestDb();
    const kit = sampleKit({
      homebind: { mapId: 0, zoneId: 12, posX: -8949.95, posY: -132.493, posZ: 83.5312 },
    });
    const guid = await createCharacter(db, sampleDraft({ x: -8949.95, y: -132.493, z: 83.5312 }), kit);

    await db.update(characters).set({ position_x: -9000 }).where(eq(characters.guid, guid));
    const [position] = await db.select({ position_x: characters.position_x }).from(characters).where(eq(characters.guid, guid));
    expect(position?.position_x).toBe(-9000);

    const loaded = await loadCharacterKit(db, guid);
    expect(loaded.homebind).toEqual({
      mapId: 0,
      zoneId: 12,
      posX: -8949.95,
      posY: -132.493,
      posZ: 83.5312,
    });
  });

  test("loadCharacterKit returns empty kit when child tables were missing", async () => {
    const db = await openTestDb();
    await db.insert(characters).values({ guid: 9, account: 1, name: "Solo", race: 1, class: 1, level: 1, zone: 12, health: 60, taximask: "", innTriggerId: 0 });

    const loaded = await loadCharacterKit(db, 9);
    expect(loaded).toEqual({
      spells: [],
      actions: [],
      skills: [],
      factions: [],
      homebind: null,
    });
  });
});

describe("deleteCharacter", () => {
  test("deletes only the owning account's character and child rows", async () => {
    const db = await openTestDb();
    const guid = await createCharacter(db, sampleDraft({ accountId: 1, name: "Mine" }), sampleKit());
    const other = await createCharacter(db, sampleDraft({ accountId: 2, name: "Theirs" }), sampleKit());

    expect(await deleteCharacter(db, 2, guid)).toBe(false);
    expect((await loadCharacterKit(db, guid)).spells.length).toBeGreaterThan(0);
    expect(await characterCount(db, guid)).toBe(1);

    expect(await deleteCharacter(db, 1, guid)).toBe(true);
    expect(await characterCount(db, guid)).toBe(0);
    expect(await loadCharacterKit(db, guid)).toEqual({
      spells: [],
      actions: [],
      skills: [],
      factions: [],
      homebind: null,
    });
    expect(await characterCount(db, other)).toBe(1);
  });
});
