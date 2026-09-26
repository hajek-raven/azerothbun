import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Character } from "../db.ts";
import { saveCharacterState } from "./persist.ts";
import { ensureCharacterTables, loadCharacterKit, type CharacterLoginKit } from "./store.ts";

function openTestDb(): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec(`
    CREATE TABLE characters (
      guid INTEGER PRIMARY KEY,
      zone INTEGER NOT NULL DEFAULT 0,
      map INTEGER NOT NULL DEFAULT 0,
      position_x REAL NOT NULL DEFAULT 0,
      position_y REAL NOT NULL DEFAULT 0,
      position_z REAL NOT NULL DEFAULT 0,
      orientation REAL NOT NULL DEFAULT 0,
      health INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      xp INTEGER NOT NULL DEFAULT 0,
      money INTEGER NOT NULL DEFAULT 0,
      power1 INTEGER NOT NULL DEFAULT 0,
      power2 INTEGER NOT NULL DEFAULT 0,
      power3 INTEGER NOT NULL DEFAULT 0,
      power4 INTEGER NOT NULL DEFAULT 0,
      power5 INTEGER NOT NULL DEFAULT 0,
      power6 INTEGER NOT NULL DEFAULT 0,
      power7 INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensureCharacterTables(db);
  return db;
}

function sampleCharacter(overrides: Partial<Character> = {}): Character {
  return {
    guid: 1,
    account: 1,
    name: "Thrall",
    race: 1,
    class: 1,
    gender: 0,
    level: 1,
    xp: 0,
    money: 0,
    skin: 1,
    face: 1,
    hairStyle: 1,
    hairColor: 1,
    facialStyle: 0,
    bankSlots: 0,
    restState: 0,
    playerFlags: 0,
    position_x: -8949.95,
    position_y: -132.493,
    position_z: 83.5312,
    map: 0,
    instance_id: 0,
    instance_mode_mask: 0,
    orientation: 0,
    taximask: null,
    online: 0,
    cinematic: 0,
    totaltime: 0,
    leveltime: 0,
    logout_time: 0,
    is_logout_resting: 0,
    rest_bonus: 0,
    resettalents_cost: 0,
    resettalents_time: 0,
    trans_x: 0,
    trans_y: 0,
    trans_z: 0,
    trans_o: 0,
    transguid: 0,
    extra_flags: 0,
    stable_slots: 0,
    at_login: 0,
    zone: 12,
    death_expire_time: 0,
    taxi_path: null,
    arenaPoints: 0,
    totalHonorPoints: 0,
    todayHonorPoints: 0,
    yesterdayHonorPoints: 0,
    totalKills: 0,
    todayKills: 0,
    yesterdayKills: 0,
    chosenTitle: 0,
    knownCurrencies: 0,
    watchedFaction: 0,
    drunk: 0,
    health: 60,
    power1: 0,
    power2: 100,
    power3: 0,
    power4: 0,
    power5: 0,
    power6: 0,
    power7: 0,
    latency: 0,
    talentGroupsCount: 1,
    activeTalentGroup: 0,
    exploredZones: null,
    equipmentCache: null,
    ammoId: 0,
    knownTitles: null,
    actionBars: 0,
    grantableLevels: 0,
    order: null,
    creation_date: "",
    deleteInfos_Account: null,
    deleteInfos_Name: null,
    deleteDate: null,
    innTriggerId: 0,
    extraBonusTalentCount: 0,
    ...overrides,
  };
}

function sampleKit(overrides: Partial<CharacterLoginKit> = {}): CharacterLoginKit {
  return {
    spells: [6603, 78],
    actions: [{ button: 0, action: 6603, type: 0 }],
    skills: [{ skill: 95, value: 1, max: 5 }],
    factions: [{ faction: 72, standing: 0, flags: 0 }],
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

describe("saveCharacterState", () => {
  test("round-trips powers and position", () => {
    const db = openTestDb();
    db.query(
      `INSERT INTO characters (guid, zone, map, position_x, position_y, position_z, orientation, health,
        power1, power2, power3, power4, power5, power6, power7)
       VALUES (1, 12, 0, 0, 0, 0, 0, 60, 0, 0, 0, 0, 0, 0, 0)`,
    ).run();

    const character = sampleCharacter({
      zone: 40,
      map: 1,
      position_x: 100.5,
      position_y: 200.25,
      position_z: 50.125,
      orientation: 1.57,
      health: 42,
      power1: 0,
      power2: 80,
      power3: 0,
      power4: 0,
      power5: 0,
      power6: 0,
      power7: 0,
    });
    saveCharacterState(db, character, sampleKit());

    const row = db
      .query<{
        zone: number;
        map: number;
        position_x: number;
        position_y: number;
        position_z: number;
        orientation: number;
        health: number;
        power1: number;
        power2: number;
        power3: number;
        power4: number;
        power5: number;
        power6: number;
        power7: number;
      }, []>(
        `SELECT zone, map, position_x, position_y, position_z, orientation, health,
                power1, power2, power3, power4, power5, power6, power7
         FROM characters WHERE guid = 1`,
      )
      .get();

    expect(row).toEqual({
      zone: 40,
      map: 1,
      position_x: 100.5,
      position_y: 200.25,
      position_z: 50.125,
      orientation: 1.57,
      health: 42,
      power1: 0,
      power2: 80,
      power3: 0,
      power4: 0,
      power5: 0,
      power6: 0,
      power7: 0,
    });
  });

  test("replaces spells so old spells are removed", () => {
    const db = openTestDb();
    db.query(
      `INSERT INTO characters (guid, zone, map, position_x, position_y, position_z, orientation, health,
        power1, power2, power3, power4, power5, power6, power7)
       VALUES (1, 12, 0, 0, 0, 0, 0, 60, 0, 0, 0, 0, 0, 0, 0)`,
    ).run();
    db.query("INSERT INTO character_spell (guid, spell, specMask) VALUES (1, 81, 1)").run();
    db.query("INSERT INTO character_spell (guid, spell, specMask) VALUES (1, 6603, 1)").run();

    saveCharacterState(db, sampleCharacter(), sampleKit({ spells: [78, 133] }));

    expect(loadCharacterKit(db, 1).spells).toEqual([78, 133]);
  });

  test("replaces homebind", () => {
    const db = openTestDb();
    db.query(
      `INSERT INTO characters (guid, zone, map, position_x, position_y, position_z, orientation, health,
        power1, power2, power3, power4, power5, power6, power7)
       VALUES (1, 12, 0, 0, 0, 0, 0, 60, 0, 0, 0, 0, 0, 0, 0)`,
    ).run();
    db.query(
      `INSERT INTO character_homebind (guid, mapId, zoneId, posX, posY, posZ)
       VALUES (1, 0, 12, -8949.95, -132.493, 83.5312)`,
    ).run();

    const next = {
      mapId: 1,
      zoneId: 14,
      posX: 10311.3,
      posY: -6391.57,
      posZ: 38.5,
    };
    saveCharacterState(db, sampleCharacter(), sampleKit({ homebind: next }));

    expect(loadCharacterKit(db, 1).homebind).toEqual(next);
  });

  test("leaves no homebind row when kit.homebind is null", () => {
    const db = openTestDb();
    db.query(
      `INSERT INTO characters (guid, zone, map, position_x, position_y, position_z, orientation, health,
        power1, power2, power3, power4, power5, power6, power7)
       VALUES (1, 12, 0, 0, 0, 0, 0, 60, 0, 0, 0, 0, 0, 0, 0)`,
    ).run();
    db.query(
      `INSERT INTO character_homebind (guid, mapId, zoneId, posX, posY, posZ)
       VALUES (1, 0, 12, 1, 2, 3)`,
    ).run();

    saveCharacterState(db, sampleCharacter(), sampleKit({ homebind: null }));

    expect(loadCharacterKit(db, 1).homebind).toBeNull();
  });

  test("second save with the same kit does not duplicate spells", () => {
    const db = openTestDb();
    db.query(
      `INSERT INTO characters (guid, zone, map, position_x, position_y, position_z, orientation, health,
        power1, power2, power3, power4, power5, power6, power7)
       VALUES (1, 12, 0, 0, 0, 0, 0, 60, 0, 0, 0, 0, 0, 0, 0)`,
    ).run();

    const character = sampleCharacter();
    const kit = sampleKit({ spells: [6603, 78, 81] });
    saveCharacterState(db, character, kit);
    saveCharacterState(db, character, kit);

    const count = db
      .query<{ count: number }, { guid: number }>(
        "SELECT COUNT(*) AS count FROM character_spell WHERE guid = $guid",
      )
      .get({ guid: 1 });
    expect(count?.count).toBe(3);
    expect(loadCharacterKit(db, 1).spells).toEqual([78, 81, 6603]);
  });
});
