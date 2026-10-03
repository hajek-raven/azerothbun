import { eq } from "drizzle-orm";
import type { Db } from "../database/database.ts";
import { realmcharacters } from "../database/schema/auth.ts";
import { character_homebind, characters } from "../database/schema/characters.ts";
import { objectGuids } from "../game/Globals/object-guids.ts";
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
  writeCharacterKit,
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

export async function characterCreateNameCode(db: Db, name: string): Promise<number | null> {
  const status = await checkCharacterName(db, name);
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

/**
 * `HandleCharCreateOpcode` → `Player::Create` + `SaveToDB(true)`: the `characters` row with the next player guid,
 * the starting kit, and the account's `realmcharacters` count in the login database.
 */
export async function createPlayableCharacter(
  characterDb: Db,
  loginDb: Db,
  draft: CharacterDraft,
  kit: CharacterKit,
  realmId = 1,
): Promise<number> {
  const nameCode = await characterCreateNameCode(characterDb, draft.name);
  if (nameCode !== null) {
    throw new Error(String(nameCode));
  }
  const count = await characterDb.$count(characters, eq(characters.account, draft.accountId));
  if (count >= MAX_CHARACTERS_PER_ACCOUNT) {
    throw new Error(String(CHAR_CREATE_ACCOUNT_LIMIT));
  }

  const guid = objectGuids.player.generate();
  await characterDb.transaction(async (tx) => {
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
  await refreshRealmCharacterCount(characterDb, loginDb, draft.accountId, realmId);
  return guid;
}

export async function ensureStartingKit(db: Db, guid: number, kit: CharacterKit, health: number): Promise<boolean> {
  const [existing] = await db.select({ guid: character_homebind.guid }).from(character_homebind).where(eq(character_homebind.guid, guid));
  if (existing) {
    return false;
  }
  await db.transaction(async (tx) => {
    await writeCharacterKit(tx, guid, kit);
    await tx.update(characters).set({ health }).where(eq(characters.guid, guid));
  });
  return true;
}

/** `CHAR_SEL_SUM_CHARS` then `LOGIN_REP_REALM_CHARACTERS`. */
export async function refreshRealmCharacterCount(characterDb: Db, loginDb: Db, accountId: number, realmId = 1): Promise<void> {
  const numchars = await characterDb.$count(characters, eq(characters.account, accountId));
  await loginDb.insert(realmcharacters).values({ numchars, acctid: accountId, realmid: realmId }).onDuplicateKeyUpdate({ set: { numchars } });
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
