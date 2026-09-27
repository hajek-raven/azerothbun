import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { testDatabase } from "../database/test-db.ts";
import { character_homebind, character_spell, characters } from "../database/schema/characters.ts";
import type { Character } from "../db.ts";
import { saveCharacterState } from "./persist.ts";
import { loadCharacterKit, type CharacterLoginKit } from "./store.ts";

function openTestDb() {
  return testDatabase("characters");
}

type TestDb = Awaited<ReturnType<typeof openTestDb>>;

/** The minimal `characters` row the old tests inserted by hand; the rest are schema defaults. */
async function insertCharacter(db: TestDb, values: Partial<typeof characters.$inferInsert> = {}): Promise<void> {
  await db.insert(characters).values({ guid: 1, account: 1, name: "Thrall", zone: 12, health: 60, taximask: "", innTriggerId: 0, ...values });
}

async function readCharacter(db: TestDb) {
  const [row] = await db.select().from(characters).where(eq(characters.guid, 1));
  return row!;
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
    taximask: "",
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
    knownCurrencies: 0n,
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
    creation_date: new Date(0),
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

function pick<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as Pick<T, K>;
}

describe("saveCharacterState", () => {
  test("round-trips powers and position", async () => {
    const db = await openTestDb();
    await insertCharacter(db);

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
    await saveCharacterState(db, character, sampleKit());

    const full = await readCharacter(db);
    const row = pick(full, ["zone", "map", "position_x", "position_y", "position_z", "orientation", "health", "power1", "power2", "power3", "power4", "power5", "power6", "power7"]);

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

  test("round-trips flags, taximask, explored zones, rest, and honor", async () => {
    const db = await openTestDb();
    await insertCharacter(db);

    const character = sampleCharacter({
      playerFlags: 0x10,
      taximask: "1 2 3 4 5 6 7 8 9 10 11 12 13 14",
      exploredZones: "1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ",
      restState: 1,
      rest_bonus: 12.5,
      is_logout_resting: 1,
      logout_time: 1700000000,
      totalHonorPoints: 1500,
      todayHonorPoints: 25,
      yesterdayHonorPoints: 10,
      arenaPoints: 100,
      totalKills: 50,
      todayKills: 2,
      yesterdayKills: 1,
      watchedFaction: 72,
      bankSlots: 2,
      cinematic: 1,
      totaltime: 3600,
      leveltime: 600,
      at_login: 0,
      death_expire_time: 0,
      taxi_path: "",
      extra_flags: 1,
      stable_slots: 0,
      money: 42,
      level: 5,
      xp: 100,
    });
    await saveCharacterState(db, character, sampleKit());

    const full = await readCharacter(db);
    const row = pick(full, ["playerFlags", "taximask", "exploredZones", "restState", "rest_bonus", "is_logout_resting", "logout_time", "totalHonorPoints", "todayHonorPoints", "yesterdayHonorPoints", "arenaPoints", "totalKills", "todayKills", "yesterdayKills", "watchedFaction", "bankSlots", "cinematic", "totaltime", "leveltime", "money", "level", "xp", "extra_flags", "taxi_path"]);

    expect(row).toEqual({
      playerFlags: 0x10,
      taximask: "1 2 3 4 5 6 7 8 9 10 11 12 13 14",
      exploredZones: character.exploredZones,
      restState: 1,
      rest_bonus: 12.5,
      is_logout_resting: 1,
      logout_time: 1700000000,
      totalHonorPoints: 1500,
      todayHonorPoints: 25,
      yesterdayHonorPoints: 10,
      arenaPoints: 100,
      totalKills: 50,
      todayKills: 2,
      yesterdayKills: 1,
      watchedFaction: 72,
      bankSlots: 2,
      cinematic: 1,
      totaltime: 3600,
      leveltime: 600,
      money: 42,
      level: 5,
      xp: 100,
      extra_flags: 1,
      taxi_path: "",
    });
  });

  test("replaces spells so old spells are removed", async () => {
    const db = await openTestDb();
    await insertCharacter(db);
    await db.insert(character_spell).values([{ guid: 1, spell: 81, specMask: 1 }, { guid: 1, spell: 6603, specMask: 1 }]);

    await saveCharacterState(db, sampleCharacter(), sampleKit({ spells: [78, 133] }));

    expect((await loadCharacterKit(db, 1)).spells).toEqual([78, 133]);
  });

  test("replaces homebind", async () => {
    const db = await openTestDb();
    await insertCharacter(db);
    await db.insert(character_homebind).values({ guid: 1, mapId: 0, zoneId: 12, posX: -8949.95, posY: -132.493, posZ: 83.5312 });

    const next = {
      mapId: 1,
      zoneId: 14,
      posX: 10311.3,
      posY: -6391.57,
      posZ: 38.5,
    };
    await saveCharacterState(db, sampleCharacter(), sampleKit({ homebind: next }));

    expect((await loadCharacterKit(db, 1)).homebind).toEqual(next);
  });

  test("leaves no homebind row when kit.homebind is null", async () => {
    const db = await openTestDb();
    await insertCharacter(db);
    await db.insert(character_homebind).values({ guid: 1, mapId: 0, zoneId: 12, posX: 1, posY: 2, posZ: 3 });

    await saveCharacterState(db, sampleCharacter(), sampleKit({ homebind: null }));

    expect((await loadCharacterKit(db, 1)).homebind).toBeNull();
  });

  test("second save with the same kit does not duplicate spells", async () => {
    const db = await openTestDb();
    await insertCharacter(db);

    const character = sampleCharacter();
    const kit = sampleKit({ spells: [6603, 78, 81] });
    await saveCharacterState(db, character, kit);
    await saveCharacterState(db, character, kit);

    expect(await db.$count(character_spell, eq(character_spell.guid, 1))).toBe(3);
    expect((await loadCharacterKit(db, 1)).spells).toEqual([78, 81, 6603]);
  });
});
