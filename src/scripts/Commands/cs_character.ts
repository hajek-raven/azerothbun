/**
 * `cs_character.cpp`: `.character …` and `.levelup`. `.pdump` needs the player dump system (`PlayerDump.cpp`), which is
 * not ported, so it is not registered.
 */
import { executeStatement, executeStatementAsync, queryFields } from "../../database/database.ts";
import { CharacterDatabase, LoginDatabase } from "../../database/DatabaseEnv.ts";
import {
  CHAR_DEL_DECLINED_NAME,
  CHAR_SEL_CHAR_DEL_INFO,
  CHAR_SEL_CHAR_DEL_INFO_BY_GUID,
  CHAR_SEL_CHAR_DEL_INFO_BY_NAME,
  CHAR_SEL_CHAR_DEL_INFO_BY_NAME_LIMIT,
  CHAR_SEL_CHARACTER_NAME_DATA,
  CHAR_SEL_CHECK_NAME,
  CHAR_UDP_RESTORE_DELETE_INFO,
  CHAR_UPD_ADD_AT_LOGIN_FLAG,
  CHAR_UPD_LEVEL,
  CHAR_UPD_NAME_BY_GUID,
} from "../../gen/CharacterDatabase.gen.ts";
import { PLAYER_CHOSEN_TITLE, PLAYER_XP } from "../../gen/UpdateFields.gen.ts";
import { getCharactersCount, getId, getName } from "../../game/Accounts/AccountMgr.ts";
import * as R from "../../game/Accounts/RBACDefines.ts";
import { sCharacterCache } from "../../game/Cache/CharacterCache.ts";
import { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { boolArg, int16Arg, Optional, stringArg, stringViewArg, uint16Arg, uint8Arg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { AccountIdentifierArg, PlayerIdentifier, PlayerIdentifierArg, type AccountIdentifier } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { ItemQualityColors } from "../../game/Chat/Hyperlinks.ts";
import { sCharTitlesStore, sFactionStore, sSkillLineStore } from "../../game/DataStores/DBCStores.ts";
import type { Player } from "../../game/Entities/Player/Player.ts";
import { AT_LOGIN_CHANGE_FACTION, AT_LOGIN_CHANGE_RACE, AT_LOGIN_CUSTOMIZE, AT_LOGIN_RENAME } from "../../game/Entities/Player/PlayerDefines.ts";
import { DeleteFromDB, DeleteOldCharacters } from "../../game/Entities/Player/PlayerMisc.ts";
import { CHAR_NAME_PROFANE, CHAR_NAME_RESERVED, CHAR_NAME_SUCCESS, normalizePlayerName, sObjectMgr } from "../../game/Globals/ObjectMgr.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { timeToTimestampStr } from "../../game/time/timer.ts";
import { ServerConfig } from "../../game/world/world-config.ts";
import { sWorld } from "../../game/world/world.ts";
import { localeNames } from "../../common/Common.ts";
import { StringFormat } from "../../common/Utilities/StringFormat.ts";
import { SkillType } from "../../characters/skills.ts";
import { guidString } from "../../game/Chat/Chat.ts";
import { getBaseReputation } from "../../world/session-player.ts";

const MAX_DELETED_CHAR_RESULTS = 50;
const DEFAULT_MAX_LEVEL = 80;
const STRONG_MAX_LEVEL = 255;
const GENDER_MALE = 0;
const INVENTORY_SLOT_BAG_0 = 255;
const SKILL_CATEGORY_PROFESSION = 11;
const SMSG_SHOW_BANK = 0x1b8;

/** `FactionFlags` (ReputationMgr.h) */
const FACTION_FLAG_VISIBLE = 0x01;
const FACTION_FLAG_AT_WAR = 0x02;
const FACTION_FLAG_HIDDEN = 0x04;
const FACTION_FLAG_INVISIBLE_FORCED = 0x08;
const FACTION_FLAG_PEACE_FORCED = 0x10;
const FACTION_FLAG_INACTIVE = 0x20;
/** @ac game/Reputation/ReputationMgr.h ReputationMgr::PointsInRank */
const PointsInRank = [36000, 3000, 3000, 3000, 6000, 12000, 21000, 1000] as const;
const ReputationRankStrIndex = [L.LANG_REP_HATED, L.LANG_REP_HOSTILE, L.LANG_REP_UNFRIENDLY, L.LANG_REP_NEUTRAL, L.LANG_REP_FRIENDLY, L.LANG_REP_HONORED, L.LANG_REP_REVERED, L.LANG_REP_EXALTED] as const;

/** @ac game/Reputation/ReputationMgr.cpp ReputationMgr::ReputationToRank */
function ReputationToRank(standing: number): number {
  let limit = 42999 + 1;
  for (let i = PointsInRank.length - 1; i >= 0; --i) {
    limit -= PointsInRank[i]!;
    if (standing >= limit) return i;
  }
  return 0;
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const characterDeletedCommandTable: ChatCommandTable = [
    ChatCommand("delete", [stringArg], HandleCharacterDeletedDeleteCommand, R.RBAC_PERM_COMMAND_CHARACTER_DELETED_DELETE, Console.Yes),
    ChatCommand("list", [Optional(stringViewArg)], HandleCharacterDeletedListCommand, R.RBAC_PERM_COMMAND_CHARACTER_DELETED_LIST, Console.Yes),
    ChatCommand("restore", [stringArg, Optional(stringViewArg), Optional(AccountIdentifierArg)], HandleCharacterDeletedRestoreCommand, R.RBAC_PERM_COMMAND_CHARACTER_DELETED_RESTORE, Console.Yes),
    ChatCommand("purge", [Optional(uint16Arg)], HandleCharacterDeletedPurgeCommand, R.RBAC_PERM_COMMAND_CHARACTER_DELETED_OLD, Console.Yes),
  ];
  const characterCheckCommandTable: ChatCommandTable = [
    ChatCommand("bank", [], HandleCharacterCheckBankCommand, R.RBAC_PERM_COMMAND_CHARACTER_CHECK_BANK, Console.Yes),
    ChatCommand("bag", [uint8Arg], HandleCharacterCheckBagCommand, R.RBAC_PERM_COMMAND_CHARACTER_CHECK_BAG, Console.Yes),
    ChatCommand("profession", [], HandleCharacterCheckProfessionCommand, R.RBAC_PERM_COMMAND_CHARACTER_CHECK_PROFESSION, Console.Yes),
  ];
  const characterCommandTable: ChatCommandTable = [
    ChatCommand("customize", [Optional(PlayerIdentifierArg)], HandleCharacterCustomizeCommand, R.RBAC_PERM_COMMAND_CHARACTER_CUSTOMIZE, Console.Yes),
    ChatCommand("changefaction", [Optional(PlayerIdentifierArg)], HandleCharacterChangeFactionCommand, R.RBAC_PERM_COMMAND_CHARACTER_CHANGEFACTION, Console.Yes),
    ChatCommand("changerace", [Optional(PlayerIdentifierArg)], HandleCharacterChangeRaceCommand, R.RBAC_PERM_COMMAND_CHARACTER_CHANGERACE, Console.Yes),
    ChatCommand("changeaccount", [stringArg, Optional(PlayerIdentifierArg)], HandleCharacterChangeAccountCommand, R.RBAC_PERM_COMMAND_CHARACTER_CHANGEACCOUNT, Console.Yes),
    SubCommands("check", characterCheckCommandTable),
    ChatCommand("erase", [PlayerIdentifierArg], HandleCharacterEraseCommand, R.RBAC_PERM_COMMAND_CHARACTER_ERASE, Console.Yes),
    SubCommands("deleted", characterDeletedCommandTable),
    ChatCommand("level", [Optional(PlayerIdentifierArg), int16Arg], HandleCharacterLevelCommand, R.RBAC_PERM_COMMAND_CHARACTER_LEVEL, Console.Yes),
    ChatCommand("rename", [Optional(PlayerIdentifierArg), Optional(boolArg), Optional(stringViewArg)], HandleCharacterRenameCommand, R.RBAC_PERM_COMMAND_CHARACTER_RENAME, Console.Yes),
    ChatCommand("reputation", [Optional(PlayerIdentifierArg)], HandleCharacterReputationCommand, R.RBAC_PERM_COMMAND_CHARACTER_REPUTATION, Console.Yes),
    ChatCommand("titles", [Optional(PlayerIdentifierArg)], HandleCharacterTitlesCommand, R.RBAC_PERM_COMMAND_CHARACTER_TITLES, Console.Yes),
  ];
  return [SubCommands("character", characterCommandTable), ChatCommand("levelup", [Optional(PlayerIdentifierArg), int16Arg], HandleLevelUpCommand, R.RBAC_PERM_COMMAND_LEVELUP, Console.No)];
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::DeletedInfo */
type DeletedInfo = { lowGuid: number; name: string; accountId: number; accountName: string; deleteDate: number; level: number };

/** @ac scripts/Commands/cs_character.cpp character_commandscript::GetDeletedCharacterInfoList */
async function GetDeletedCharacterInfoList(searchString: string, limitResults = false): Promise<DeletedInfo[] | null> {
  let result;
  if (searchString) {
    // search by GUID
    if (/^\d+$/.test(searchString)) {
      result = await queryFields(CharacterDatabase(), CHAR_SEL_CHAR_DEL_INFO_BY_GUID, Number(searchString));
    } else {
      // search by name
      const name = normalizePlayerName(searchString);
      if (!name) return null;
      result = await queryFields(CharacterDatabase(), limitResults ? CHAR_SEL_CHAR_DEL_INFO_BY_NAME_LIMIT : CHAR_SEL_CHAR_DEL_INFO_BY_NAME, name);
    }
  } else {
    result = await queryFields(CharacterDatabase(), CHAR_SEL_CHAR_DEL_INFO);
  }
  const foundList: DeletedInfo[] = [];
  for (const fields of result) {
    const accountId = Number(fields[2] ?? 0);
    foundList.push({
      lowGuid: Number(fields[0]),
      name: String(fields[1] ?? ""),
      accountId,
      // account name will be empty for nonexisting account
      accountName: (await getName(LoginDatabase(), accountId)) ?? "",
      deleteDate: Number(fields[3] ?? 0),
      level: Number(fields[4] ?? 0),
    });
  }
  return foundList;
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterDeletedListHelper */
function HandleCharacterDeletedListHelper(foundList: readonly DeletedInfo[], handler: ChatHandler): void {
  if (!handler.getSession()) {
    handler.sendSysMessage(L.LANG_CHARACTER_DELETED_LIST_BAR);
    handler.sendSysMessage(L.LANG_CHARACTER_DELETED_LIST_HEADER);
    handler.sendSysMessage(L.LANG_CHARACTER_DELETED_LIST_BAR);
  }
  for (const info of foundList) {
    const dateStr = timeToTimestampStr(info.deleteDate);
    handler.pSendSysMessage(
      handler.getSession() ? L.LANG_CHARACTER_DELETED_LIST_LINE_CHAT : L.LANG_CHARACTER_DELETED_LIST_LINE_CONSOLE,
      info.lowGuid,
      info.name,
      info.level,
      info.accountName || "<Not existing>",
      info.accountId,
      dateStr,
    );
  }
  if (!handler.getSession()) handler.sendSysMessage(L.LANG_CHARACTER_DELETED_LIST_BAR);
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterDeletedRestoreHelper */
async function HandleCharacterDeletedRestoreHelper(delInfo: DeletedInfo, handler: ChatHandler): Promise<void> {
  if (!delInfo.accountName) {
    // account does not exist
    handler.pSendSysMessage(L.LANG_CHARACTER_DELETED_SKIP_ACCOUNT, delInfo.name, delInfo.lowGuid, delInfo.accountId);
    return;
  }
  // check character count
  if ((await getCharactersCount(CharacterDatabase(), delInfo.accountId)) >= 10) {
    handler.pSendSysMessage(L.LANG_CHARACTER_DELETED_SKIP_FULL, delInfo.name, delInfo.lowGuid, delInfo.accountId);
    return;
  }
  if (sCharacterCache.getCharacterGuidByName(delInfo.name)) {
    handler.pSendSysMessage(L.LANG_CHARACTER_DELETED_SKIP_NAME, delInfo.name, delInfo.lowGuid, delInfo.accountId);
    return;
  }
  await executeStatement(CharacterDatabase(), CHAR_UDP_RESTORE_DELETE_INFO, delInfo.name, delInfo.accountId, delInfo.lowGuid);
  const [result] = await queryFields(CharacterDatabase(), CHAR_SEL_CHARACTER_NAME_DATA, delInfo.lowGuid);
  if (result) {
    sCharacterCache.addCharacterCacheEntry(delInfo.lowGuid, delInfo.accountId, delInfo.name, Number(result[2]), Number(result[0]), Number(result[1]), Number(result[3]));
  }
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterLevel */
async function HandleCharacterLevel(player: Player | null, playerGuid: number, oldLevel: number, newLevel: number, handler: ChatHandler): Promise<void> {
  if (player) {
    player.giveLevel(newLevel);
    player.initTalentForLevel();
    player.setUInt32Value(PLAYER_XP, 0);
    if (handler.needReportToTarget(player)) {
      const target = new ChatHandler(player.getSession());
      if (oldLevel === newLevel) target.pSendSysMessage(L.LANG_YOURS_LEVEL_PROGRESS_RESET, handler.getNameLink());
      else if (oldLevel < newLevel) target.pSendSysMessage(L.LANG_YOURS_LEVEL_UP, handler.getNameLink(), newLevel);
      else target.pSendSysMessage(L.LANG_YOURS_LEVEL_DOWN, handler.getNameLink(), newLevel);
    }
  } else {
    // Update level and reset XP, everything else will be updated at login
    await executeStatement(CharacterDatabase(), CHAR_UPD_LEVEL, newLevel & 0xff, playerGuid);
    sCharacterCache.updateCharacterLevel(playerGuid, newLevel);
  }
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterTitlesCommand */
function HandleCharacterTitlesCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null): boolean {
  const player = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  const target = player?.getConnectedPlayer() ?? null;
  if (!player || !target) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  const loc = handler.getSessionDbcLocale();
  const knownStr = handler.getAcoreString(L.LANG_KNOWN);
  // Search in CharTitles.dbc
  for (let id = 0; id < sCharTitlesStore.getNumRows(); id++) {
    const titleInfo = sCharTitlesStore.lookupEntry(id);
    if (!titleInfo || !target.hasTitle(titleInfo.bit_index)) continue;
    const names = target.getGender() === GENDER_MALE ? titleInfo.nameMale : titleInfo.nameFemale;
    const name = names[loc] || names[0] || "";
    if (!name) continue;
    const activeStr = target.getUInt32Value(PLAYER_CHOSEN_TITLE) === titleInfo.bit_index ? handler.getAcoreString(L.LANG_ACTIVE) : "";
    const titleName = StringFormat(name, player.getName());
    // send title in "id (idx:idx) - [namedlink locale]" format
    if (handler.getSession()) handler.pSendSysMessage(L.LANG_TITLE_LIST_CHAT, id, titleInfo.bit_index, id, titleName, localeNames[loc] ?? "", knownStr, activeStr);
    else handler.pSendSysMessage(L.LANG_TITLE_LIST_CONSOLE, id, titleInfo.bit_index, name, localeNames[loc] ?? "", knownStr, activeStr);
  }
  return true;
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterRenameCommand */
async function HandleCharacterRenameCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null, reserveName: boolean | null, newNameV: string | null): Promise<boolean> {
  if (!playerArg && newNameV) return false;
  const player = playerArg ?? PlayerIdentifier.fromTarget(handler);
  if (!player) return false;
  if (await handler.hasLowerSecurity(null, player.getGUID())) return false;
  if (newNameV) {
    const newName = normalizePlayerName(newNameV);
    if (!newName) {
      handler.sendErrorMessage(L.LANG_BAD_VALUE);
      return false;
    }
    const res = sObjectMgr.checkPlayerName(newName, true);
    if (res !== CHAR_NAME_SUCCESS) {
      if (res === CHAR_NAME_RESERVED) handler.sendErrorMessage(L.LANG_RESERVED_NAME);
      else if (res === CHAR_NAME_PROFANE) handler.sendErrorMessage(L.LANG_PROFANITY_NAME);
      else handler.sendErrorMessage(L.LANG_BAD_VALUE);
      return false;
    }
    if ((await queryFields(CharacterDatabase(), CHAR_SEL_CHECK_NAME, newName)).length > 0) {
      handler.sendErrorMessage(L.LANG_RENAME_PLAYER_ALREADY_EXISTS, newName);
      return false;
    }
    // Remove declined name from db
    await executeStatement(CharacterDatabase(), CHAR_DEL_DECLINED_NAME, player.getGUID());
    const target = player.getConnectedPlayer();
    if (target) {
      target.setName(newName);
      target.getSession().kickPlayer("HandleCharacterRenameCommand GM Command renaming character");
    }
    // The online character is saved with the new name when it logs out; the row changes now either way.
    await executeStatement(CharacterDatabase(), CHAR_UPD_NAME_BY_GUID, newName, player.getGUID());
    sCharacterCache.updateCharacterData(player.getGUID(), newName);
    handler.pSendSysMessage(L.LANG_RENAME_PLAYER_WITH_NEW_NAME, player.getName(), newName);
  } else {
    const target = player.getConnectedPlayer();
    if (target) {
      handler.pSendSysMessage(L.LANG_RENAME_PLAYER, handler.getNameLink(target));
      target.setAtLoginFlag(AT_LOGIN_RENAME);
    } else {
      // check offline security
      if (await handler.hasLowerSecurity(null, player.getGUID())) return false;
      handler.pSendSysMessage(L.LANG_RENAME_PLAYER_GUID, handler.playerLink(player.getName()), guidString(BigInt(player.getGUID())));
      await executeStatement(CharacterDatabase(), CHAR_UPD_ADD_AT_LOGIN_FLAG, AT_LOGIN_RENAME, player.getGUID());
    }
  }
  if (reserveName) sObjectMgr.addReservedPlayerName(player.getName());
  return true;
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterLevelCommand */
async function HandleCharacterLevelCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null, newlevelArg: number): Promise<boolean> {
  const player = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!player) return false;
  const connected = player.getConnectedPlayer();
  const oldlevel = connected ? connected.getLevel() : sCharacterCache.getCharacterLevelByGuid(player.getGUID());
  let newlevel = newlevelArg;
  if (newlevel < 1) return false; // invalid level
  if (newlevel > DEFAULT_MAX_LEVEL) newlevel = DEFAULT_MAX_LEVEL; // hardcoded maximum level
  await HandleCharacterLevel(connected, player.getGUID(), oldlevel, newlevel, handler);
  // including chr == NULL
  if (!handler.getSession() || handler.getSession()!.getPlayer() !== connected) handler.pSendSysMessage(L.LANG_YOU_CHANGE_LVL, handler.playerLink(player.getName()), newlevel);
  return true;
}

/** `.character customize|changefaction|changerace`: the at-login flag on the online player or the row. */
async function setAtLoginCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null, flag: number): Promise<boolean> {
  const player = playerArg ?? PlayerIdentifier.fromTarget(handler);
  if (!player) return false;
  const target = player.getConnectedPlayer();
  if (target) {
    handler.pSendSysMessage(L.LANG_CUSTOMIZE_PLAYER, handler.getNameLink(target));
    target.setAtLoginFlag(flag);
  } else {
    handler.pSendSysMessage(L.LANG_CUSTOMIZE_PLAYER_GUID, handler.playerLink(player.getName()), guidString(BigInt(player.getGUID())));
    await executeStatement(CharacterDatabase(), CHAR_UPD_ADD_AT_LOGIN_FLAG, flag, player.getGUID());
  }
  return true;
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterCustomizeCommand */
function HandleCharacterCustomizeCommand(handler: ChatHandler, player: PlayerIdentifier | null): Promise<boolean> {
  return setAtLoginCommand(handler, player, AT_LOGIN_CUSTOMIZE);
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterChangeFactionCommand */
function HandleCharacterChangeFactionCommand(handler: ChatHandler, player: PlayerIdentifier | null): Promise<boolean> {
  return setAtLoginCommand(handler, player, AT_LOGIN_CHANGE_FACTION);
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterChangeRaceCommand */
function HandleCharacterChangeRaceCommand(handler: ChatHandler, player: PlayerIdentifier | null): Promise<boolean> {
  return setAtLoginCommand(handler, player, AT_LOGIN_CHANGE_RACE);
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterReputationCommand */
function HandleCharacterReputationCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null): boolean {
  const player = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  const target = player?.getConnectedPlayer() ?? null;
  if (!player || !target) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  const loc = handler.getSessionDbcLocale();
  // `ReputationMgr::GetStateList` is ordered by `ReputationListID`.
  const states = (target.getSession().kit?.factions ?? [])
    .map((faction) => ({ ...faction, entry: sFactionStore.lookupEntry(faction.faction) }))
    .sort((a, b) => (a.entry?.reputationListID ?? 0) - (b.entry?.reputationListID ?? 0));
  for (const faction of states) {
    const factionEntry = faction.entry;
    const factionName = factionEntry ? (factionEntry.name[loc] ?? "") : "#Not found#";
    const reputation = factionEntry ? getBaseReputation(factionEntry, target.getRace(), target.getClass()) + faction.standing : faction.standing;
    const rankName = handler.getAcoreString(ReputationRankStrIndex[ReputationToRank(reputation)]!);
    let ss = handler.getSession()
      ? `${faction.faction} - |cffffffff|Hfaction:${faction.faction}|h[${factionName} ${localeNames[loc] ?? ""}]|h|r`
      : `${faction.faction} - ${factionName} ${localeNames[loc] ?? ""}`;
    ss += ` ${rankName} (${reputation})`;
    if (faction.flags & FACTION_FLAG_VISIBLE) ss += handler.getAcoreString(L.LANG_FACTION_VISIBLE);
    if (faction.flags & FACTION_FLAG_AT_WAR) ss += handler.getAcoreString(L.LANG_FACTION_ATWAR);
    if (faction.flags & FACTION_FLAG_PEACE_FORCED) ss += handler.getAcoreString(L.LANG_FACTION_PEACE_FORCED);
    if (faction.flags & FACTION_FLAG_HIDDEN) ss += handler.getAcoreString(L.LANG_FACTION_HIDDEN);
    if (faction.flags & FACTION_FLAG_INVISIBLE_FORCED) ss += handler.getAcoreString(L.LANG_FACTION_INVISIBLE_FORCED);
    if (faction.flags & FACTION_FLAG_INACTIVE) ss += handler.getAcoreString(L.LANG_FACTION_INACTIVE);
    handler.sendSysMessage(ss);
  }
  return true;
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterDeletedListCommand */
async function HandleCharacterDeletedListCommand(handler: ChatHandler, needleStr: string | null): Promise<boolean> {
  const foundList = await GetDeletedCharacterInfoList(needleStr ?? "", true);
  if (!foundList) return false;
  // if no characters have been found, output a warning
  if (foundList.length === 0) {
    handler.sendErrorMessage(L.LANG_CHARACTER_DELETED_LIST_EMPTY);
    return false;
  }
  const truncated = foundList.length > MAX_DELETED_CHAR_RESULTS;
  HandleCharacterDeletedListHelper(truncated ? foundList.slice(0, MAX_DELETED_CHAR_RESULTS) : foundList, handler);
  if (truncated) handler.sendSysMessage(L.LANG_CHARACTER_DELETED_LIST_LIMIT);
  return true;
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterDeletedRestoreCommand */
async function HandleCharacterDeletedRestoreCommand(handler: ChatHandler, needle: string, newCharName: string | null, newAccount: AccountIdentifier | null): Promise<boolean> {
  const foundList = await GetDeletedCharacterInfoList(needle);
  if (!foundList) return false;
  if (foundList.length === 0) {
    handler.sendErrorMessage(L.LANG_CHARACTER_DELETED_LIST_EMPTY);
    return false;
  }
  handler.sendSysMessage(L.LANG_CHARACTER_DELETED_RESTORE);
  HandleCharacterDeletedListHelper(foundList, handler);
  if (!newCharName) {
    // Drop nonexisting account cases
    for (const info of foundList) await HandleCharacterDeletedRestoreHelper(info, handler);
    return true;
  }
  if (foundList.length === 1) {
    // update name, and if new account provided update deleted info
    const delInfo = { ...foundList[0]!, name: newCharName };
    if (newAccount) {
      delInfo.accountId = newAccount.id;
      delInfo.accountName = newAccount.name;
    }
    await HandleCharacterDeletedRestoreHelper(delInfo, handler);
    return true;
  }
  handler.sendErrorMessage(L.LANG_CHARACTER_DELETED_ERR_RENAME);
  return false;
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterDeletedDeleteCommand */
async function HandleCharacterDeletedDeleteCommand(handler: ChatHandler, needle: string): Promise<boolean> {
  const foundList = await GetDeletedCharacterInfoList(needle);
  if (!foundList) return false;
  if (foundList.length === 0) {
    handler.sendErrorMessage(L.LANG_CHARACTER_DELETED_LIST_EMPTY);
    return false;
  }
  handler.sendSysMessage(L.LANG_CHARACTER_DELETED_DELETE);
  HandleCharacterDeletedListHelper(foundList, handler);
  // Call the appropriate function to delete them (current account for deleted characters is 0)
  for (const info of foundList) await DeleteFromDB({ characters: CharacterDatabase(), login: LoginDatabase() }, info.lowGuid, 0, false, true);
  return true;
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterDeletedPurgeCommand */
async function HandleCharacterDeletedPurgeCommand(_handler: ChatHandler, days: number | null): Promise<boolean> {
  let keepDays = sWorld().getIntConfig(ServerConfig.CONFIG_CHARDELETE_KEEP_DAYS) | 0;
  if (days !== null) keepDays = days;
  else if (keepDays <= 0) return false; // config option value 0 -> disabled and can't be used
  await DeleteOldCharacters({ characters: CharacterDatabase(), login: LoginDatabase() }, keepDays);
  return true;
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterEraseCommand */
async function HandleCharacterEraseCommand(handler: ChatHandler, player: PlayerIdentifier): Promise<boolean> {
  let accountId: number;
  const target = player.getConnectedPlayer();
  if (target) {
    accountId = target.getSession().getAccountId();
    target.getSession().kickPlayer("HandleCharacterEraseCommand GM Command deleting character");
  } else {
    accountId = sCharacterCache.getCharacterAccountIdByGuid(player.getGUID());
  }
  const accountName = (await getName(LoginDatabase(), accountId)) ?? "";
  await DeleteFromDB({ characters: CharacterDatabase(), login: LoginDatabase() }, player.getGUID(), accountId, true, true);
  handler.pSendSysMessage(L.LANG_CHARACTER_DELETED, player.getName(), guidString(BigInt(player.getGUID())), accountName, accountId);
  return true;
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleLevelUpCommand */
async function HandleLevelUpCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null, level: number): Promise<boolean> {
  const player = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!player) return false;
  const connected = player.getConnectedPlayer();
  const oldlevel = connected ? connected.getLevel() : sCharacterCache.getCharacterLevelByGuid(player.getGUID());
  let newlevel = oldlevel + level;
  if (newlevel < 1) newlevel = 1;
  if (newlevel > STRONG_MAX_LEVEL) newlevel = STRONG_MAX_LEVEL; // hardcoded maximum level
  await HandleCharacterLevel(connected, player.getGUID(), oldlevel, newlevel, handler);
  // including chr == NULL
  if (!handler.getSession() || handler.getSession()!.getPlayer() !== connected) handler.pSendSysMessage(L.LANG_YOU_CHANGE_LVL, handler.playerLink(player.getName()), newlevel);
  return true;
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterCheckBankCommand */
function HandleCharacterCheckBankCommand(handler: ChatHandler): boolean {
  // WorldSession::SendShowBank
  const session = handler.getSession()!;
  const data = new Uint8Array(8);
  new DataView(data.buffer).setBigUint64(0, session.getPlayer()!.getGUID(), true);
  session.sendPacket(SMSG_SHOW_BANK, data);
  return true;
}

/** One `.character check bag` line with the item link. */
function checkBagLine(handler: ChatHandler, counter: number, item: { entry: number; count: number }): void {
  const template = sObjectMgr.getItemTemplate(item.entry);
  const color = (ItemQualityColors[template?.quality ?? 0] ?? 0).toString(16);
  handler.pSendSysMessage("{} - |c{}|Hitem:{}:0:0:0:0:0:0:0:0:0|h[{}]|h|r - {}", counter, color, item.entry, template?.name ?? "", item.count);
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterCheckBagCommand */
function HandleCharacterCheckBagCommand(handler: ChatHandler, bagSlotArg: number): boolean {
  const target = handler.getSelectedPlayerOrSelf();
  if (!target) return false;
  let Counter = 0;
  const BagSlot = bagSlotArg === 2 ? 19 : bagSlotArg === 3 ? 20 : bagSlotArg === 4 ? 21 : bagSlotArg === 5 ? 22 : 1;
  handler.pSendSysMessage("--------------------------------------");
  if (BagSlot === 1) {
    for (let i = 23; i < 39; i++) {
      const item = target.getItemByPos(INVENTORY_SLOT_BAG_0, i);
      if (item) checkBagLine(handler, ++Counter, item);
    }
  } else {
    const bag = target.getBagByPos(BagSlot);
    if (bag) {
      for (let i = 0; i < bag.size; i++) {
        const item = target.getItemByPos(BagSlot, i);
        if (item) checkBagLine(handler, ++Counter, item);
      }
    }
  }
  handler.pSendSysMessage("--------------------------------------");
  return true;
}

const PROFESSION_NAMES: ReadonlyMap<number, string> = new Map([
  [SkillType.SKILL_ALCHEMY, "Alchemy"],
  [SkillType.SKILL_BLACKSMITHING, "Blacksmithing"],
  [SkillType.SKILL_ENCHANTING, "Enchanting"],
  [SkillType.SKILL_ENGINEERING, "Engineering"],
  [SkillType.SKILL_INSCRIPTION, "Inscription"],
  [SkillType.SKILL_JEWELCRAFTING, "Jewelcrafting"],
  [SkillType.SKILL_LEATHERWORKING, "Leatherworking"],
  [SkillType.SKILL_TAILORING, "Tailoring"],
  [SkillType.SKILL_SKINNING, "Skinning"],
  [SkillType.SKILL_HERBALISM, "Herbalism"],
  [SkillType.SKILL_MINING, "Mining"],
  [SkillType.SKILL_COOKING, "Cooking"],
  [SkillType.SKILL_FIRST_AID, "First Aid"],
]);

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterCheckProfessionCommand */
function HandleCharacterCheckProfessionCommand(handler: ChatHandler): boolean {
  const player = handler.getSelectedPlayerOrSelf();
  if (!player) return false;
  let Counter = 0;
  handler.pSendSysMessage("--------------------------------------");
  for (let i = 1; i < sSkillLineStore.getNumRows(); ++i) {
    const SkillInfo = sSkillLineStore.lookupEntry(i);
    if (!SkillInfo) continue;
    if (SkillInfo.categoryId !== SKILL_CATEGORY_PROFESSION && !SkillInfo.canLink) continue;
    const SkillID = SkillInfo.id;
    if (!player.hasSkill(SkillID)) continue;
    Counter++;
    const name = PROFESSION_NAMES.get(SkillID);
    if (name) handler.pSendSysMessage(`{} - ${name} - {}`, Counter, player.getSkillValue(SkillID));
  }
  handler.pSendSysMessage("--------------------------------------");
  return true;
}

/** @ac scripts/Commands/cs_character.cpp character_commandscript::HandleCharacterChangeAccountCommand */
async function HandleCharacterChangeAccountCommand(handler: ChatHandler, accountName: string, playerArg: PlayerIdentifier | null): Promise<boolean> {
  const player = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!player) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  const accountId = await getId(LoginDatabase(), accountName);
  if (!accountId) {
    handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, accountName);
    return true;
  }
  if ((await getCharactersCount(CharacterDatabase(), accountId)) >= 10) {
    handler.sendErrorMessage(L.LANG_ACCOUNT_CHARACTER_LIST_FULL, accountName, accountId);
    return true;
  }
  const cache = sCharacterCache.getCharacterCacheByName(player.getName());
  if (cache) {
    const accName = (await getName(LoginDatabase(), cache.AccountId)) ?? "";
    handler.pSendSysMessage(L.LANG_CMD_CHAR_CHANGE_ACC_SUCCESS, player.getName(), guidString(BigInt(player.getGUID())), accName, cache.AccountId, accountName, accountId);
  }
  player.getConnectedPlayer()?.getSession().kickPlayer("CMD char changeaccount");
  executeStatementAsync(CharacterDatabase(), "UPDATE characters SET account = ? WHERE guid = ?", accountId, player.getGUID());
  sCharacterCache.updateCharacterAccountId(player.getGUID(), accountId);
  return true;
}

/** @ac scripts/Commands/cs_character.cpp AddSC_character_commandscript */
export function AddSC_character_commandscript(): void {
  registerCommandScript(GetCommands);
}
