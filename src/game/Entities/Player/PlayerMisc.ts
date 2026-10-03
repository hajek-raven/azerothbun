/** The static `Player` helpers for characters that are not online (`PlayerMisc.cpp`, `PlayerStorage.cpp`). */
import { commitTransaction, executeStatement, queryFields, type Db, type StatementTransaction } from "../../../database/database.ts";
import { CharacterDatabase } from "../../../database/DatabaseEnv.ts";
import * as C from "../../../gen/CharacterDatabase.gen.ts";
import { CHAR_SEL_CHAR_POSITION, CHAR_UPD_CHARACTER_POSITION } from "../../../gen/CharacterDatabase.gen.ts";
import { refreshRealmCharacterCount } from "../../../characters/live.ts";
import { log } from "../../../log.ts";
import { realm } from "../../../shared/Realms/Realm.ts";
import { sCharacterCache } from "../../Cache/CharacterCache.ts";
import { ServerConfig } from "../../world/world-config.ts";
import { sWorld } from "../../world/world.ts";
import type { WorldPosition } from "./Player.ts";

/** @ac game/Entities/Player/PlayerMisc.cpp Player::SavePositionInDB */
export async function SavePositionInDB(loc: WorldPosition, zoneId: number, guid: number): Promise<void> {
  await executeStatement(CharacterDatabase(), CHAR_UPD_CHARACTER_POSITION, loc.x, loc.y, loc.z, loc.o, loc.mapId, zoneId, guid);
}

/** @ac game/Entities/Player/PlayerStorage.cpp Player::LoadPositionFromDB */
export async function LoadPositionFromDB(guid: number): Promise<(WorldPosition & { inFlight: boolean }) | null> {
  const [fields] = await queryFields(CharacterDatabase(), CHAR_SEL_CHAR_POSITION, guid);
  if (!fields) return null;
  return {
    x: Number(fields[0]),
    y: Number(fields[1]),
    z: Number(fields[2]),
    o: Number(fields[3]),
    mapId: Number(fields[4]),
    inFlight: String(fields[5] ?? "").length > 0,
  };
}

/** `CharDeleteMethod` */
const CHAR_DELETE_REMOVE = 0;
const CHAR_DELETE_UNLINK = 1;
const MAIL_NORMAL = 0;
const DAY = 86400;

/**
 * @ac game/Entities/Player/Player.cpp Player::DeleteFromDB
 * Guilds, arena teams, tickets, groups, petitions, the social list, and mail return are not ported: their rows are
 * deleted with the character, and a player's mail is deleted instead of returned to its sender.
 */
export async function DeleteFromDB(db: { characters: Db; login: Db | null }, lowGuid: number, accountId: number, updateRealmCharsArg: boolean, deleteFinally: boolean): Promise<void> {
  // for not existed account avoid update realm
  const updateRealmChars = accountId ? updateRealmCharsArg : false;
  let charDelete_method = sWorld().getIntConfig(ServerConfig.CONFIG_CHARDELETE_METHOD);
  const charDelete_minLvl = sWorld().getIntConfig(ServerConfig.CONFIG_CHARDELETE_MIN_LEVEL);
  // if we want to finally delete the character or the character does not meet the level requirement,
  // we set it to mode CHAR_DELETE_REMOVE
  if (deleteFinally || sCharacterCache.getCharacterLevelByGuid(lowGuid) < charDelete_minLvl) charDelete_method = CHAR_DELETE_REMOVE;
  switch (charDelete_method) {
    // Completely remove from the database
    case CHAR_DELETE_REMOVE: {
      const trans: StatementTransaction = [];
      for (const mailFields of await queryFields(db.characters, C.CHAR_SEL_CHAR_COD_ITEM_MAIL, lowGuid)) {
        const mail_id = Number(mailFields[0]);
        const mailType = Number(mailFields[1]);
        const has_items = Boolean(Number(mailFields[7]));
        // We can return mail now; so firstly delete the old one
        trans.push([C.CHAR_DEL_MAIL_BY_ID, mail_id]);
        if (mailType !== MAIL_NORMAL) {
          // Mail is not from player
          if (has_items) trans.push([C.CHAR_DEL_MAIL_ITEM_BY_ID, mail_id]);
          continue;
        }
        trans.push([C.CHAR_DEL_MAIL_ITEM_BY_ID, mail_id]);
      }
      // NOW we can finally clear other DB data related to character
      for (const sql of [
        C.CHAR_DEL_CHARACTER,
        C.CHAR_DEL_PLAYER_ACCOUNT_DATA,
        C.CHAR_DEL_CHAR_DECLINED_NAME,
        C.CHAR_DEL_CHAR_ACTION,
        C.CHAR_DEL_CHAR_AURA,
        C.CHAR_DEL_CHAR_GIFT,
        C.CHAR_DEL_PLAYER_HOMEBIND,
        C.CHAR_DEL_CHAR_INSTANCE,
        C.CHAR_DEL_CHAR_INVENTORY,
        C.CHAR_DEL_CHAR_QUESTSTATUS,
        C.CHAR_DEL_CHAR_QUESTSTATUS_REWARDED,
        C.CHAR_DEL_CHAR_REPUTATION,
        C.CHAR_DEL_CHAR_SPELL,
        C.CHAR_DEL_CHAR_SPELL_COOLDOWN,
        sWorld().getBoolConfig(ServerConfig.CONFIG_DELETE_CHARACTER_TICKET_TRACE) ? C.CHAR_UPD_PLAYER_GM_TICKETS_ON_CHAR_DELETION : C.CHAR_DEL_PLAYER_GM_TICKETS,
        C.CHAR_DEL_ITEM_INSTANCE_BY_OWNER,
        C.CHAR_DEL_CHAR_SOCIAL_BY_FRIEND,
        C.CHAR_DEL_CHAR_SOCIAL_BY_GUID,
        C.CHAR_DEL_MAIL,
        C.CHAR_DEL_MAIL_ITEMS,
        C.CHAR_DEL_CHAR_PET_BY_OWNER,
        C.CHAR_DEL_CHAR_PET_DECLINEDNAME_BY_OWNER,
        C.CHAR_DEL_CHAR_ACHIEVEMENTS,
        C.CHAR_DEL_CHAR_ACHIEVEMENT_PROGRESS,
        C.CHAR_DEL_CHAR_EQUIPMENTSETS,
      ]) {
        trans.push([sql, lowGuid]);
      }
      trans.push([C.CHAR_DEL_GUILD_EVENTLOG_BY_PLAYER, lowGuid, lowGuid]);
      for (const sql of [
        C.CHAR_DEL_GUILD_BANK_EVENTLOG_BY_PLAYER,
        C.CHAR_DEL_PLAYER_ENTRY_POINT,
        C.CHAR_DEL_CHAR_GLYPHS,
        C.CHAR_DEL_QUEST_STATUS_DAILY_CHAR,
        C.CHAR_DEL_QUEST_STATUS_WEEKLY_CHAR,
        C.CHAR_DEL_QUEST_STATUS_MONTHLY_CHAR,
        C.CHAR_DEL_QUEST_STATUS_SEASONAL_CHAR,
        C.CHAR_DEL_CHAR_TALENT,
        C.CHAR_DEL_CHAR_SKILLS,
        C.CHAR_DEL_CHAR_SETTINGS,
        // Corpse::DeleteFromDB
        C.CHAR_DEL_CORPSE,
      ]) {
        trans.push([sql, lowGuid]);
      }
      await commitTransaction(db.characters, trans);
      break;
    }
    // The character gets unlinked from the account, the name gets freed up and appears as deleted ingame
    case CHAR_DELETE_UNLINK:
      await executeStatement(db.characters, C.CHAR_UPD_DELETE_INFO, lowGuid);
      break;
    default:
      log("world", `Player::DeleteFromDB: Unsupported delete method: ${charDelete_method}.`);
      return;
  }
  const cache = sCharacterCache.getCharacterCacheByGuid(lowGuid);
  if (cache) sCharacterCache.deleteCharacterCacheEntry(lowGuid, cache.Name);
  if (updateRealmChars && db.login) await refreshRealmCharacterCount(db.characters, db.login, accountId, realm.Id.Realm);
}

/** @ac game/Entities/Player/Player.cpp Player::DeleteOldCharacters */
export async function DeleteOldCharacters(db: { characters: Db; login: Db | null }, keepDays: number): Promise<void> {
  log("world", `Player::DeleteOldChars: Deleting all characters which have been deleted ${keepDays} days before...`);
  const result = await queryFields(db.characters, C.CHAR_SEL_CHAR_OLD_CHARS, Math.floor(Date.now() / 1000) - keepDays * DAY);
  if (result.length > 0) log("world", `Player::DeleteOldChars: Found ${result.length} character(s) to delete`);
  for (const fields of result) await DeleteFromDB(db, Number(fields[0]), Number(fields[1]), true, true);
}
