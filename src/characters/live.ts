import type { Database } from "bun:sqlite";
import type { PlayerStart } from "../data/player-create.ts";
import {
  CHAR_CREATE_ACCOUNT_LIMIT,
  CHAR_CREATE_FAILED,
  CHAR_CREATE_NAME_IN_USE,
  CHAR_NAME_INVALID_CHARACTER,
  CHAR_NAME_THREE_CONSECUTIVE,
  CHAR_NAME_TOO_LONG,
  CHAR_NAME_TOO_SHORT,
} from "../world/character-packets.ts";
import {
  CHAR_NAME_IN_USE,
  CHAR_NAME_INVALID,
  CHAR_NAME_OK,
  CHAR_NAME_TOO_LONG as NAME_TOO_LONG,
  CHAR_NAME_TOO_SHORT as NAME_TOO_SHORT,
  checkCharacterName,
  ensureCharacterTables,
  type CharacterDraft,
  type CharacterKit,
} from "./store.ts";

export const MAX_CHARACTERS_PER_ACCOUNT = 10;

export function kitFromStart(start: PlayerStart): CharacterKit {
  return {
    spells: [...start.spells],
    actions: start.actions.map((action) => ({ ...action })),
    skills: start.skills.map((skill) => ({ ...skill })),
    factions: [],
    homebind: {
      mapId: start.info.map,
      zoneId: start.info.zone,
      posX: start.info.positionX,
      posY: start.info.positionY,
      posZ: start.info.positionZ,
    },
  };
}

export function characterCreateNameCode(db: Database, name: string): number | null {
  const status = checkCharacterName(db, name);
  switch (status) {
    case CHAR_NAME_OK:
      return null;
    case NAME_TOO_SHORT:
      return CHAR_NAME_TOO_SHORT;
    case NAME_TOO_LONG:
      return CHAR_NAME_TOO_LONG;
    case CHAR_NAME_IN_USE:
      return CHAR_CREATE_NAME_IN_USE;
    case CHAR_NAME_INVALID:
      return threeConsecutive(name) ? CHAR_NAME_THREE_CONSECUTIVE : CHAR_NAME_INVALID_CHARACTER;
    default:
      return CHAR_CREATE_FAILED;
  }
}

export function createPlayableCharacter(db: Database, draft: CharacterDraft, kit: CharacterKit): number {
  ensureCharacterTables(db);
  const nameCode = characterCreateNameCode(db, draft.name);
  if (nameCode !== null) {
    throw new Error(String(nameCode));
  }
  const count = db
    .query<{ count: number }, { account: number }>("SELECT COUNT(*) AS count FROM characters WHERE account = $account")
    .get({ account: draft.accountId });
  if ((count?.count ?? 0) >= MAX_CHARACTERS_PER_ACCOUNT) {
    throw new Error(String(CHAR_CREATE_ACCOUNT_LIMIT));
  }

  const insert = db.transaction(() => {
    const result = db
      .query(
        `INSERT INTO characters (
           account, name, race, class, gender, level, skin, face, hairStyle, hairColor, facialStyle,
           position_x, position_y, position_z, map, zone, orientation, health, taximask, innTriggerId
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0)`,
      )
      .run(
        draft.accountId,
        draft.name,
        draft.race,
        draft.classId,
        draft.gender,
        draft.level,
        draft.skin,
        draft.face,
        draft.hairStyle,
        draft.hairColor,
        draft.facialStyle,
        draft.x,
        draft.y,
        draft.z,
        draft.map,
        draft.zone,
        draft.orientation,
        draft.health,
      );
    const guid = Number(result.lastInsertRowid);
    writeKit(db, guid, kit);
    refreshRealmCharacterCount(db, draft.accountId);
    return guid;
  });
  return insert();
}

export function ensureStartingKit(db: Database, guid: number, kit: CharacterKit, health: number): boolean {
  ensureCharacterTables(db);
  const existing = db.query<{ guid: number }, [number]>("SELECT guid FROM character_homebind WHERE guid = ?").get(guid);
  if (existing) {
    return false;
  }
  const fill = db.transaction(() => {
    writeKit(db, guid, kit);
    db.query("UPDATE characters SET health = ? WHERE guid = ?").run(health, guid);
  });
  fill();
  return true;
}

export function refreshRealmCharacterCount(db: Database, accountId: number): void {
  db.query(
    `INSERT INTO realmcharacters (realmid, acctid, numchars)
     VALUES (1, ?, (SELECT COUNT(*) FROM characters WHERE account = ?))
     ON CONFLICT(realmid, acctid) DO UPDATE SET numchars = excluded.numchars`,
  ).run(accountId, accountId);
}

function writeKit(db: Database, guid: number, kit: CharacterKit): void {
  const insertSpell = db.query("INSERT INTO character_spell (guid, spell, specMask) VALUES (?, ?, 1)");
  for (const spell of kit.spells) {
    insertSpell.run(guid, spell);
  }
  const insertAction = db.query("INSERT INTO character_action (guid, spec, button, action, type) VALUES (?, 0, ?, ?, ?)");
  for (const action of kit.actions) {
    insertAction.run(guid, action.button, action.action, action.type);
  }
  const insertSkill = db.query("INSERT INTO character_skills (guid, skill, value, max) VALUES (?, ?, ?, ?)");
  for (const skill of kit.skills) {
    insertSkill.run(guid, skill.skill, skill.value, skill.max);
  }
  const insertFaction = db.query("INSERT INTO character_reputation (guid, faction, standing, flags) VALUES (?, ?, ?, ?)");
  for (const faction of kit.factions) {
    insertFaction.run(guid, faction.faction, faction.standing, faction.flags);
  }
  db.query("INSERT INTO character_homebind (guid, mapId, zoneId, posX, posY, posZ) VALUES (?, ?, ?, ?, ?, ?)").run(
    guid,
    kit.homebind.mapId,
    kit.homebind.zoneId,
    kit.homebind.posX,
    kit.homebind.posY,
    kit.homebind.posZ,
  );
}

function threeConsecutive(name: string): boolean {
  const lowered = name.toLowerCase();
  for (let index = 2; index < lowered.length; index++) {
    if (lowered[index] === lowered[index - 1] && lowered[index] === lowered[index - 2]) {
      return true;
    }
  }
  return false;
}
