import type { Database } from "bun:sqlite";
import { ensureQuestStatusTables } from "./quest-status.ts";

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

export function ensureCharacterTables(db: Database): void {
  ensureQuestStatusTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_spell (
      guid INTEGER NOT NULL,
      spell INTEGER NOT NULL,
      specMask INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (guid, spell)
    );
    CREATE TABLE IF NOT EXISTS character_action (
      guid INTEGER NOT NULL,
      spec INTEGER NOT NULL DEFAULT 0,
      button INTEGER NOT NULL,
      action INTEGER NOT NULL,
      type INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guid, spec, button)
    );
    CREATE TABLE IF NOT EXISTS character_skills (
      guid INTEGER NOT NULL,
      skill INTEGER NOT NULL,
      value INTEGER NOT NULL,
      max INTEGER NOT NULL,
      PRIMARY KEY (guid, skill)
    );
    CREATE TABLE IF NOT EXISTS character_reputation (
      guid INTEGER NOT NULL,
      faction INTEGER NOT NULL,
      standing INTEGER NOT NULL DEFAULT 0,
      flags INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guid, faction)
    );
    CREATE TABLE IF NOT EXISTS character_homebind (
      guid INTEGER NOT NULL PRIMARY KEY,
      mapId INTEGER NOT NULL,
      zoneId INTEGER NOT NULL,
      posX REAL NOT NULL,
      posY REAL NOT NULL,
      posZ REAL NOT NULL
    );
  `);
}

export function checkCharacterName(db: Database, name: string): number {
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

  const existing = db
    .query<{ count: number }, { name: string }>(
      "SELECT COUNT(*) AS count FROM characters WHERE lower(name) = lower($name)",
    )
    .get({ name });
  if ((existing?.count ?? 0) > 0) {
    return CHAR_NAME_IN_USE;
  }

  return CHAR_NAME_OK;
}

export function createCharacter(db: Database, draft: CharacterDraft, kit: CharacterKit): number {
  ensureCharacterTables(db);

  const nameStatus = checkCharacterName(db, draft.name);
  if (nameStatus !== CHAR_NAME_OK) {
    throw new Error(String(nameStatus));
  }

  const insert = db.transaction(() => {
    const result = db
      .query(
        `INSERT INTO characters (
           account, name, race, class, gender, level, skin, face, hairStyle, hairColor, facialStyle,
           position_x, position_y, position_z, map, zone, orientation, health
         ) VALUES (
           $account, $name, $race, $class, $gender, $level, $skin, $face, $hairStyle, $hairColor, $facialStyle,
           $position_x, $position_y, $position_z, $map, $zone, $orientation, $health
         )`,
      )
      .run({
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
      });

    const guid = Number(result.lastInsertRowid);

    const insertSpell = db.query(
      "INSERT INTO character_spell (guid, spell, specMask) VALUES ($guid, $spell, 1)",
    );
    for (const spell of kit.spells) {
      insertSpell.run({ guid, spell });
    }

    const insertAction = db.query(
      "INSERT INTO character_action (guid, spec, button, action, type) VALUES ($guid, 0, $button, $action, $type)",
    );
    for (const action of kit.actions) {
      insertAction.run({
        guid,
        button: action.button,
        action: action.action,
        type: action.type,
      });
    }

    const insertSkill = db.query(
      "INSERT INTO character_skills (guid, skill, value, max) VALUES ($guid, $skill, $value, $max)",
    );
    for (const skill of kit.skills) {
      insertSkill.run({
        guid,
        skill: skill.skill,
        value: skill.value,
        max: skill.max,
      });
    }

    const insertFaction = db.query(
      "INSERT INTO character_reputation (guid, faction, standing, flags) VALUES ($guid, $faction, $standing, $flags)",
    );
    for (const faction of kit.factions) {
      insertFaction.run({
        guid,
        faction: faction.faction,
        standing: faction.standing,
        flags: faction.flags,
      });
    }

    db.query(
      `INSERT INTO character_homebind (guid, mapId, zoneId, posX, posY, posZ)
       VALUES ($guid, $mapId, $zoneId, $posX, $posY, $posZ)`,
    ).run({
      guid,
      mapId: kit.homebind.mapId,
      zoneId: kit.homebind.zoneId,
      posX: kit.homebind.posX,
      posY: kit.homebind.posY,
      posZ: kit.homebind.posZ,
    });

    return guid;
  });

  return insert();
}

export function deleteCharacter(db: Database, accountId: number, guid: number): boolean {
  ensureCharacterTables(db);

  const remove = db.transaction(() => {
    const result = db
      .query("DELETE FROM characters WHERE guid = $guid AND account = $account")
      .run({ guid, account: accountId });
    if (result.changes === 0) {
      return false;
    }

    db.query("DELETE FROM character_spell WHERE guid = $guid").run({ guid });
    db.query("DELETE FROM character_action WHERE guid = $guid").run({ guid });
    db.query("DELETE FROM character_skills WHERE guid = $guid").run({ guid });
    db.query("DELETE FROM character_reputation WHERE guid = $guid").run({ guid });
    db.query("DELETE FROM character_homebind WHERE guid = $guid").run({ guid });
    return true;
  });

  return remove();
}

export function loadCharacterKit(db: Database, guid: number): CharacterLoginKit {
  ensureCharacterTables(db);

  const spells = db
    .query<{ spell: number }, { guid: number }>(
      "SELECT spell FROM character_spell WHERE guid = $guid ORDER BY spell",
    )
    .all({ guid })
    .map((row) => row.spell);

  const actions = db
    .query<{ button: number; action: number; type: number }, { guid: number }>(
      "SELECT button, action, type FROM character_action WHERE guid = $guid ORDER BY button",
    )
    .all({ guid })
    .map((row) => ({ button: row.button, action: row.action, type: row.type }));

  const skills = db
    .query<{ skill: number; value: number; max: number }, { guid: number }>(
      "SELECT skill, value, max FROM character_skills WHERE guid = $guid ORDER BY skill",
    )
    .all({ guid })
    .map((row) => ({ skill: row.skill, value: row.value, max: row.max }));

  const factions = db
    .query<{ faction: number; standing: number; flags: number }, { guid: number }>(
      "SELECT faction, standing, flags FROM character_reputation WHERE guid = $guid ORDER BY faction",
    )
    .all({ guid })
    .map((row) => ({ faction: row.faction, standing: row.standing, flags: row.flags }));

  const homebind =
    db
      .query<
        { mapId: number; zoneId: number; posX: number; posY: number; posZ: number },
        { guid: number }
      >(
        "SELECT mapId, zoneId, posX, posY, posZ FROM character_homebind WHERE guid = $guid",
      )
      .get({ guid }) ?? null;

  return { spells, actions, skills, factions, homebind };
}
