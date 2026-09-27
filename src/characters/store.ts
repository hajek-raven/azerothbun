import { and, asc, eq, sql } from "drizzle-orm";
import { affectedRows, type Db, type DbExecutor } from "../database/database.ts";
import {
  character_action,
  character_homebind,
  character_reputation,
  character_skills,
  character_spell,
  characters,
} from "../database/schema/characters.ts";
import { objectGuids } from "../game/globals/object-guids.ts";

export type CharacterDraft = {
  accountId: number;
  name: string;
  race: number;
  classId: number;
  gender: number;
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialStyle: number;
  level: number;
  map: number;
  zone: number;
  x: number;
  y: number;
  z: number;
  orientation: number;
  health: number;
};

export type CharacterKit = {
  spells: number[];
  actions: { button: number; action: number; type: number }[];
  skills: { skill: number; value: number; max: number }[];
  factions: { faction: number; standing: number; flags: number }[];
  homebind: { mapId: number; zoneId: number; posX: number; posY: number; posZ: number };
};

export type CharacterLoginKit = {
  spells: number[];
  actions: { button: number; action: number; type: number }[];
  skills: { skill: number; value: number; max: number }[];
  factions: { faction: number; standing: number; flags: number }[];
  homebind: { mapId: number; zoneId: number; posX: number; posY: number; posZ: number } | null;
};

export const CHAR_NAME_OK = 0;
export const CHAR_NAME_TOO_SHORT = 1;
export const CHAR_NAME_TOO_LONG = 2;
export const CHAR_NAME_INVALID = 3;
export const CHAR_NAME_IN_USE = 4;

const NAME_MAX = 12;
const NAME_MIN = 2;
const ASCII_LETTER = /^[A-Za-z]+$/;

export async function checkCharacterName(db: Db, name: string): Promise<number> {
  if (name.length < NAME_MIN) {
    return CHAR_NAME_TOO_SHORT;
  }
  if (name.length > NAME_MAX) {
    return CHAR_NAME_TOO_LONG;
  }
  if (!ASCII_LETTER.test(name)) {
    return CHAR_NAME_INVALID;
  }

  const lowered = name.toLowerCase();
  for (let i = 2; i < lowered.length; i++) {
    if (lowered[i] === lowered[i - 1] && lowered[i] === lowered[i - 2]) {
      return CHAR_NAME_INVALID;
    }
  }

  const existing = await db.$count(characters, sql`lower(${characters.name}) = lower(${name})`);
  if (existing > 0) {
    return CHAR_NAME_IN_USE;
  }

  return CHAR_NAME_OK;
}

/** The `characters` row and the starting kit rows, in one transaction. The guid is the next `HighGuid::Player`. */
export async function createCharacter(db: Db, draft: CharacterDraft, kit: CharacterKit): Promise<number> {
  const nameStatus = await checkCharacterName(db, draft.name);
  if (nameStatus !== CHAR_NAME_OK) {
    throw new Error(String(nameStatus));
  }

  const guid = objectGuids.player.generate();
  await db.transaction(async (tx) => {
    await tx.insert(characters).values({
      guid,
      account: draft.accountId,
      name: draft.name,
      race: draft.race,
      class: draft.classId,
      gender: draft.gender,
      level: draft.level,
      skin: draft.skin,
      face: draft.face,
      hairStyle: draft.hairStyle,
      hairColor: draft.hairColor,
      facialStyle: draft.facialStyle,
      position_x: draft.x,
      position_y: draft.y,
      position_z: draft.z,
      map: draft.map,
      zone: draft.zone,
      orientation: draft.orientation,
      health: draft.health,
      taximask: "",
      innTriggerId: 0,
    });
    await writeCharacterKit(tx, guid, kit);
  });
  return guid;
}

/** `character_spell`, `character_action`, `character_skills`, `character_reputation`, and `character_homebind` rows of a kit. */
export async function writeCharacterKit(db: DbExecutor, guid: number, kit: CharacterKit | CharacterLoginKit): Promise<void> {
  if (kit.spells.length > 0) {
    await db.insert(character_spell).values(kit.spells.map((spell) => ({ guid, spell, specMask: 1 })));
  }
  if (kit.actions.length > 0) {
    await db
      .insert(character_action)
      .values(kit.actions.map((action) => ({ guid, spec: 0, button: action.button, action: action.action, type: action.type })));
  }
  if (kit.skills.length > 0) {
    await db
      .insert(character_skills)
      .values(kit.skills.map((skill) => ({ guid, skill: skill.skill, value: skill.value, max: skill.max })));
  }
  if (kit.factions.length > 0) {
    await db
      .insert(character_reputation)
      .values(kit.factions.map((faction) => ({ guid, faction: faction.faction, standing: faction.standing, flags: faction.flags })));
  }
  if (kit.homebind) {
    await db.insert(character_homebind).values({
      guid,
      mapId: kit.homebind.mapId,
      zoneId: kit.homebind.zoneId,
      posX: kit.homebind.posX,
      posY: kit.homebind.posY,
      posZ: kit.homebind.posZ,
    });
  }
}

/** Deletes the kit rows of a character (the tables `writeCharacterKit` fills). */
export async function deleteCharacterKit(db: DbExecutor, guid: number): Promise<void> {
  await db.delete(character_spell).where(eq(character_spell.guid, guid));
  await db.delete(character_action).where(eq(character_action.guid, guid));
  await db.delete(character_skills).where(eq(character_skills.guid, guid));
  await db.delete(character_reputation).where(eq(character_reputation.guid, guid));
  await db.delete(character_homebind).where(eq(character_homebind.guid, guid));
}

export async function deleteCharacter(db: Db, accountId: number, guid: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const result = await tx.delete(characters).where(and(eq(characters.guid, guid), eq(characters.account, accountId)));
    if (affectedRows(result) === 0) {
      return false;
    }
    await deleteCharacterKit(tx, guid);
    return true;
  });
}

export async function loadCharacterKit(db: Db, guid: number): Promise<CharacterLoginKit> {
  const spells = (
    await db.select({ spell: character_spell.spell }).from(character_spell).where(eq(character_spell.guid, guid)).orderBy(asc(character_spell.spell))
  ).map((row) => row.spell);

  const actions = await db
    .select({ button: character_action.button, action: character_action.action, type: character_action.type })
    .from(character_action)
    .where(eq(character_action.guid, guid))
    .orderBy(asc(character_action.button));

  const skills = await db
    .select({ skill: character_skills.skill, value: character_skills.value, max: character_skills.max })
    .from(character_skills)
    .where(eq(character_skills.guid, guid))
    .orderBy(asc(character_skills.skill));

  const factions = await db
    .select({ faction: character_reputation.faction, standing: character_reputation.standing, flags: character_reputation.flags })
    .from(character_reputation)
    .where(eq(character_reputation.guid, guid))
    .orderBy(asc(character_reputation.faction));

  const [homebind] = await db
    .select({
      mapId: character_homebind.mapId,
      zoneId: character_homebind.zoneId,
      posX: character_homebind.posX,
      posY: character_homebind.posY,
      posZ: character_homebind.posZ,
    })
    .from(character_homebind)
    .where(eq(character_homebind.guid, guid));

  return { spells, actions, skills, factions, homebind: homebind ?? null };
}
