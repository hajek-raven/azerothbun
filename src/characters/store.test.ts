import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  CHAR_NAME_IN_USE,
  CHAR_NAME_INVALID,
  CHAR_NAME_OK,
  CHAR_NAME_TOO_SHORT,
  checkCharacterName,
  createCharacter,
  deleteCharacter,
  ensureCharacterTables,
  loadCharacterKit,
  type CharacterDraft,
  type CharacterKit,
} from "./store.ts";

function openTestDb(): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec(`
    CREATE TABLE characters (
      guid INTEGER PRIMARY KEY,
      account INTEGER,
      name TEXT,
      race INTEGER,
      class INTEGER,
      gender INTEGER,
      level INTEGER,
      skin INTEGER,
      face INTEGER,
      hairStyle INTEGER,
      hairColor INTEGER,
      facialStyle INTEGER,
      position_x REAL,
      position_y REAL,
      position_z REAL,
      map INTEGER,
      zone INTEGER,
      orientation REAL,
      health INTEGER
    );
  `);
  return db;
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

describe("ensureCharacterTables", () => {
  test("is idempotent", () => {
    const db = openTestDb();
    ensureCharacterTables(db);
    ensureCharacterTables(db);
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN (
             'character_spell', 'character_action', 'character_skills',
             'character_reputation', 'character_homebind'
           )
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual([
      "character_action",
      "character_homebind",
      "character_reputation",
      "character_skills",
      "character_spell",
    ]);
  });
});

describe("checkCharacterName", () => {
  test("accepts a valid unused name", () => {
    const db = openTestDb();
    expect(checkCharacterName(db, "Thrall")).toBe(CHAR_NAME_OK);
  });

  test("rejects a short name", () => {
    const db = openTestDb();
    expect(checkCharacterName(db, "A")).toBe(CHAR_NAME_TOO_SHORT);
  });

  test("rejects three identical letters", () => {
    const db = openTestDb();
    expect(checkCharacterName(db, "Aaa")).toBe(CHAR_NAME_INVALID);
    expect(checkCharacterName(db, "Booo")).toBe(CHAR_NAME_INVALID);
  });

  test("rejects a duplicate name case-insensitively without inserting", () => {
    const db = openTestDb();
    createCharacter(db, sampleDraft({ name: "Thrall" }), sampleKit());
    expect(checkCharacterName(db, "thrall")).toBe(CHAR_NAME_IN_USE);
    expect(checkCharacterName(db, "THRALL")).toBe(CHAR_NAME_IN_USE);
    const count = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM characters").get();
    expect(count?.count).toBe(1);
  });
});

describe("createCharacter / loadCharacterKit", () => {
  test("create then load roundtrip preserves kit and sorts rows", () => {
    const db = openTestDb();
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

    const guid = createCharacter(db, sampleDraft(), kit);
    expect(guid).toBeGreaterThan(0);

    const loaded = loadCharacterKit(db, guid);
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

    const row = db
      .query<{ name: string; class: number; position_x: number }, { guid: number }>(
        "SELECT name, class, position_x FROM characters WHERE guid = $guid",
      )
      .get({ guid });
    expect(row).toEqual({ name: "Thrall", class: 1, position_x: -8949.95 });
  });

  test("throws numeric code string when the name fails", () => {
    const db = openTestDb();
    expect(() => createCharacter(db, sampleDraft({ name: "A" }), sampleKit())).toThrow("1");
    expect(() => createCharacter(db, sampleDraft({ name: "Aaa" }), sampleKit())).toThrow("3");
    createCharacter(db, sampleDraft({ name: "Thrall" }), sampleKit());
    expect(() => createCharacter(db, sampleDraft({ name: "thrall" }), sampleKit())).toThrow("4");
    const count = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM characters").get();
    expect(count?.count).toBe(1);
  });

  test("homebind stays fixed when characters position changes", () => {
    const db = openTestDb();
    const kit = sampleKit({
      homebind: { mapId: 0, zoneId: 12, posX: -8949.95, posY: -132.493, posZ: 83.5312 },
    });
    const guid = createCharacter(db, sampleDraft({ x: -8949.95, y: -132.493, z: 83.5312 }), kit);

    db.query("UPDATE characters SET position_x = $x WHERE guid = $guid").run({
      guid,
      x: -9000,
    });

    const position = db
      .query<{ position_x: number }, { guid: number }>("SELECT position_x FROM characters WHERE guid = $guid")
      .get({ guid });
    expect(position?.position_x).toBe(-9000);

    const loaded = loadCharacterKit(db, guid);
    expect(loaded.homebind).toEqual({
      mapId: 0,
      zoneId: 12,
      posX: -8949.95,
      posY: -132.493,
      posZ: 83.5312,
    });
  });

  test("loadCharacterKit returns empty kit when child tables were missing", () => {
    const db = openTestDb();
    db.query(
      `INSERT INTO characters (account, name, race, class, gender, level, skin, face, hairStyle, hairColor, facialStyle,
        position_x, position_y, position_z, map, zone, orientation, health)
       VALUES (1, 'Solo', 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 12, 0, 60)`,
    ).run();
    const guid = Number(
      db.query<{ guid: number }, []>("SELECT guid FROM characters WHERE name = 'Solo'").get()?.guid,
    );

    const loaded = loadCharacterKit(db, guid);
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
  test("deletes only the owning account's character and child rows", () => {
    const db = openTestDb();
    const guid = createCharacter(db, sampleDraft({ accountId: 1, name: "Mine" }), sampleKit());
    const other = createCharacter(db, sampleDraft({ accountId: 2, name: "Theirs" }), sampleKit());

    expect(deleteCharacter(db, 2, guid)).toBe(false);
    expect(loadCharacterKit(db, guid).spells.length).toBeGreaterThan(0);
    expect(
      db.query<{ count: number }, { guid: number }>("SELECT COUNT(*) AS count FROM characters WHERE guid = $guid").get({
        guid,
      })?.count,
    ).toBe(1);

    expect(deleteCharacter(db, 1, guid)).toBe(true);
    expect(
      db.query<{ count: number }, { guid: number }>("SELECT COUNT(*) AS count FROM characters WHERE guid = $guid").get({
        guid,
      })?.count,
    ).toBe(0);
    expect(loadCharacterKit(db, guid)).toEqual({
      spells: [],
      actions: [],
      skills: [],
      factions: [],
      homebind: null,
    });
    expect(
      db.query<{ count: number }, { guid: number }>("SELECT COUNT(*) AS count FROM characters WHERE guid = $guid").get({
        guid: other,
      })?.count,
    ).toBe(1);
  });
});
