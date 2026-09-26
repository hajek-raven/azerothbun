import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { PlayerStart } from "../data/player-create.ts";
import { CHAR_CREATE_NAME_IN_USE, CHAR_NAME_THREE_CONSECUTIVE, CHAR_NAME_TOO_SHORT } from "../world/character-packets.ts";
import { loadCharacterKit } from "./store.ts";
import { characterCreateNameCode, createPlayableCharacter, ensureStartingKit, kitFromStart } from "./live.ts";

const HUMAN_WARRIOR: PlayerStart = {
  info: {
    race: 1,
    classId: 1,
    map: 0,
    zone: 12,
    positionX: -8949.95,
    positionY: -132.493,
    positionZ: 83.5312,
    orientation: 0,
  },
  actions: [
    { button: 72, action: 6603, type: 0 },
    { button: 73, action: 78, type: 0 },
  ],
  spells: [78, 6603],
  skills: [{ skill: 26, value: 1, max: 5 }],
  stats: {
    baseHp: 20,
    baseMana: 0,
    strength: 23,
    agility: 20,
    stamina: 22,
    intellect: 20,
    spirit: 20,
    health: 60,
    mana: 0,
    powerType: 1,
    maxPower: 1000,
    power: 0,
  },
};

function openDb(): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec(`
    CREATE TABLE characters (
      guid INTEGER PRIMARY KEY,
      account INTEGER NOT NULL,
      name TEXT NOT NULL,
      race INTEGER NOT NULL DEFAULT 0,
      class INTEGER NOT NULL DEFAULT 0,
      gender INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      skin INTEGER NOT NULL DEFAULT 0,
      face INTEGER NOT NULL DEFAULT 0,
      hairStyle INTEGER NOT NULL DEFAULT 0,
      hairColor INTEGER NOT NULL DEFAULT 0,
      facialStyle INTEGER NOT NULL DEFAULT 0,
      position_x REAL NOT NULL DEFAULT 0,
      position_y REAL NOT NULL DEFAULT 0,
      position_z REAL NOT NULL DEFAULT 0,
      map INTEGER NOT NULL DEFAULT 0,
      zone INTEGER NOT NULL DEFAULT 0,
      orientation REAL NOT NULL DEFAULT 0,
      health INTEGER NOT NULL DEFAULT 0,
      taximask TEXT NOT NULL,
      innTriggerId INTEGER NOT NULL
    );
    CREATE TABLE realmcharacters (
      realmid INTEGER NOT NULL,
      acctid INTEGER NOT NULL,
      numchars INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (realmid, acctid)
    );
  `);
  return db;
}

test("create stores spells, actions, skills, and a homebind that stays put", () => {
  const db = openDb();
  const kit = kitFromStart(HUMAN_WARRIOR);
  const guid = createPlayableCharacter(
    db,
    {
      accountId: 1,
      name: "Aldan",
      race: 1,
      classId: 1,
      gender: 0,
      skin: 1,
      face: 2,
      hairStyle: 3,
      hairColor: 4,
      facialStyle: 5,
      level: 1,
      map: kit.homebind.mapId,
      zone: kit.homebind.zoneId,
      x: kit.homebind.posX,
      y: kit.homebind.posY,
      z: kit.homebind.posZ,
      orientation: 0,
      health: 60,
    },
    kit,
  );
  db.query("UPDATE characters SET position_x = 1 WHERE guid = $guid").run({ guid });
  const loaded = loadCharacterKit(db, guid);
  expect(loaded.spells).toEqual([78, 6603]);
  expect(loaded.actions).toEqual([
    { button: 72, action: 6603, type: 0 },
    { button: 73, action: 78, type: 0 },
  ]);
  expect(loaded.skills).toEqual([{ skill: 26, value: 1, max: 5 }]);
  expect(loaded.homebind).toEqual({ mapId: 0, zoneId: 12, posX: -8949.95, posY: -132.493, posZ: 83.5312 });
  const place = db.query<{ position_x: number }, { guid: number }>("SELECT position_x FROM characters WHERE guid = $guid").get({ guid });
  expect(place?.position_x).toBe(1);
  const realm = db.query<{ numchars: number }, { acctid: number }>("SELECT numchars FROM realmcharacters WHERE acctid = $acctid").get({
    acctid: 1,
  });
  expect(realm?.numchars).toBe(1);
});

test("name codes and a one-time starting kit", () => {
  const db = openDb();
  expect(characterCreateNameCode(db, "A")).toBe(CHAR_NAME_TOO_SHORT);
  expect(characterCreateNameCode(db, "Aaa")).toBe(CHAR_NAME_THREE_CONSECUTIVE);
  const kit = kitFromStart(HUMAN_WARRIOR);
  createPlayableCharacter(
    db,
    {
      accountId: 1,
      name: "Aldan",
      race: 1,
      classId: 1,
      gender: 0,
      skin: 0,
      face: 0,
      hairStyle: 0,
      hairColor: 0,
      facialStyle: 0,
      level: 1,
      map: 0,
      zone: 12,
      x: 1,
      y: 2,
      z: 3,
      orientation: 0,
      health: 1,
    },
    kit,
  );
  expect(characterCreateNameCode(db, "aldan")).toBe(CHAR_CREATE_NAME_IN_USE);
  db.exec("DELETE FROM character_homebind");
  db.exec("DELETE FROM character_spell");
  db.exec("DELETE FROM character_action");
  db.exec("DELETE FROM character_skills");
  expect(ensureStartingKit(db, 1, kit, 60)).toBe(true);
  expect(ensureStartingKit(db, 1, kit, 60)).toBe(false);
  const health = db.query<{ health: number }, []>("SELECT health FROM characters WHERE guid = 1").get();
  expect(health?.health).toBe(60);
  expect(loadCharacterKit(db, 1).spells).toEqual([78, 6603]);
});
