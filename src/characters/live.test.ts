import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { testDatabases } from "../database/test-db.ts";
import { realmcharacters } from "../database/schema/auth.ts";
import { character_action, character_homebind, character_skills, character_spell, characters } from "../database/schema/characters.ts";
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

test("create stores spells, actions, skills, and a homebind that stays put", async () => {
  const { login, characters: db } = await testDatabases();
  const kit = kitFromStart(HUMAN_WARRIOR);
  const guid = await createPlayableCharacter(
    db,
    login,
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
  await db.update(characters).set({ position_x: 1 }).where(eq(characters.guid, guid));
  const loaded = await loadCharacterKit(db, guid);
  expect(loaded.spells).toEqual([78, 6603]);
  expect(loaded.actions).toEqual([
    { button: 72, action: 6603, type: 0 },
    { button: 73, action: 78, type: 0 },
  ]);
  expect(loaded.skills).toEqual([{ skill: 26, value: 1, max: 5 }]);
  expect(loaded.homebind).toEqual({ mapId: 0, zoneId: 12, posX: -8949.95, posY: -132.493, posZ: 83.5312 });
  const [place] = await db.select({ position_x: characters.position_x }).from(characters).where(eq(characters.guid, guid));
  expect(place?.position_x).toBe(1);
  const [realm] = await login.select({ numchars: realmcharacters.numchars }).from(realmcharacters).where(eq(realmcharacters.acctid, 1));
  expect(realm?.numchars).toBe(1);
});

test("name codes and a one-time starting kit", async () => {
  const { login, characters: db } = await testDatabases();
  expect(await characterCreateNameCode(db, "A")).toBe(CHAR_NAME_TOO_SHORT);
  expect(await characterCreateNameCode(db, "Aaa")).toBe(CHAR_NAME_THREE_CONSECUTIVE);
  const kit = kitFromStart(HUMAN_WARRIOR);
  await createPlayableCharacter(
    db,
    login,
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
  expect(await characterCreateNameCode(db, "aldan")).toBe(CHAR_CREATE_NAME_IN_USE);
  await db.delete(character_homebind);
  await db.delete(character_spell);
  await db.delete(character_action);
  await db.delete(character_skills);
  expect(await ensureStartingKit(db, 1, kit, 60)).toBe(true);
  expect(await ensureStartingKit(db, 1, kit, 60)).toBe(false);
  const [health] = await db.select({ health: characters.health }).from(characters).where(eq(characters.guid, 1));
  expect(health?.health).toBe(60);
  expect((await loadCharacterKit(db, 1)).spells).toEqual([78, 6603]);
});
