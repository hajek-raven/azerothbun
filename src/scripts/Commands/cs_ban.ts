/** `cs_ban.cpp`: `.ban`, `.baninfo`, `.banlist`, `.unban` for accounts, characters, and IPs. */
import { executeStatement, queryFields, type Fields } from "../../database/database.ts";
import { CharacterDatabase, LoginDatabase } from "../../database/DatabaseEnv.ts";
import { CHAR_SEL_BANINFO, CHAR_SEL_BANINFO_LIST, CHAR_SEL_BANNED_NAME, CHAR_SEL_GUID_BY_NAME_FILTER } from "../../gen/CharacterDatabase.gen.ts";
import {
  LOGIN_DEL_EXPIRED_IP_BANS,
  LOGIN_SEL_ACCOUNT_BANNED_ALL,
  LOGIN_SEL_ACCOUNT_BANNED_BY_USERNAME,
  LOGIN_SEL_IP_BANNED_ALL,
  LOGIN_SEL_IP_BANNED_BY_IP,
} from "../../gen/LoginDatabase.gen.ts";
import { getId, getName } from "../../game/Accounts/AccountMgr.ts";
import * as R from "../../game/Accounts/RBACDefines.ts";
import { sCharacterCache } from "../../game/Cache/CharacterCache.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { Tail } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { ObjectAccessor } from "../../game/Globals/ObjectAccessor.ts";
import { normalizePlayerName } from "../../game/Globals/ObjectMgr.ts";
import { BAN_LONGER_EXISTS, BAN_NOTFOUND, BAN_SUCCESS, BAN_SYNTAX_ERROR, sBan } from "../../game/Misc/BanMgr.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { secsToTimeString, timeStringToSecs } from "../../game/time/timer.ts";
import { ServerConfig } from "../../game/world/world-config.ts";
import { sWorld } from "../../game/world/world.ts";
import { isIPAddress, utf8ToUpperOnlyLatin } from "../../common/util.ts";

/** @ac scripts/Commands/cs_ban.cpp BanMode */
const BAN_ACCOUNT = 0;
const BAN_CHARACTER = 1;
const BAN_IP = 2;

/** `strtok(args, " ")` three times: the first two words and the rest of the line. */
function strtok3(args: string): [string | null, string | null, string | null] {
  const first = /^ *([^ ]+) ?(.*)$/s.exec(args);
  if (!first) return [null, null, null];
  const second = /^ *([^ ]+) ?(.*)$/s.exec(first[2]!);
  if (!second) return [first[1]!, null, null];
  const rest = second[2]!.replace(/^ +/, "");
  return [first[1]!, second[1]!, rest.length > 0 ? rest : null];
}

/** `atoi` */
function atoi(str: string): number {
  const match = /^\s*([+-]?\d+)/.exec(str);
  return match ? Number.parseInt(match[1]!, 10) | 0 : 0;
}

/** `Acore::Time::TimeBreakdown` (local time) */
function TimeBreakdown(time: number): { year: number; mon: number; mday: number; hour: number; min: number } {
  const date = new Date(time * 1000);
  return { year: date.getFullYear() - 1900, mon: date.getMonth(), mday: date.getDate(), hour: date.getHours(), min: date.getMinutes() };
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const unbanCommandTable: ChatCommandTable = [
    ChatCommand("account", [Tail], HandleUnBanAccountCommand, R.RBAC_PERM_COMMAND_UNBAN_ACCOUNT, Console.Yes),
    ChatCommand("character", [Tail], HandleUnBanCharacterCommand, R.RBAC_PERM_COMMAND_UNBAN_CHARACTER, Console.Yes),
    ChatCommand("playeraccount", [Tail], HandleUnBanAccountByCharCommand, R.RBAC_PERM_COMMAND_UNBAN_PLAYERACCOUNT, Console.Yes),
    ChatCommand("ip", [Tail], HandleUnBanIPCommand, R.RBAC_PERM_COMMAND_UNBAN_IP, Console.Yes),
  ];
  const banlistCommandTable: ChatCommandTable = [
    ChatCommand("account", [Tail], HandleBanListAccountCommand, R.RBAC_PERM_COMMAND_BANLIST_ACCOUNT, Console.Yes),
    ChatCommand("character", [Tail], HandleBanListCharacterCommand, R.RBAC_PERM_COMMAND_BANLIST_CHARACTER, Console.Yes),
    ChatCommand("ip", [Tail], HandleBanListIPCommand, R.RBAC_PERM_COMMAND_BANLIST_IP, Console.Yes),
  ];
  const baninfoCommandTable: ChatCommandTable = [
    ChatCommand("account", [Tail], HandleBanInfoAccountCommand, R.RBAC_PERM_COMMAND_BANINFO_ACCOUNT, Console.Yes),
    ChatCommand("character", [Tail], HandleBanInfoCharacterCommand, R.RBAC_PERM_COMMAND_BANINFO_CHARACTER, Console.Yes),
    ChatCommand("ip", [Tail], HandleBanInfoIPCommand, R.RBAC_PERM_COMMAND_BANINFO_IP, Console.Yes),
  ];
  const banCommandTable: ChatCommandTable = [
    ChatCommand("account", [Tail], HandleBanAccountCommand, R.RBAC_PERM_COMMAND_BAN_ACCOUNT, Console.Yes),
    ChatCommand("character", [Tail], HandleBanCharacterCommand, R.RBAC_PERM_COMMAND_BAN_CHARACTER, Console.Yes),
    ChatCommand("playeraccount", [Tail], HandleBanAccountByCharCommand, R.RBAC_PERM_COMMAND_BAN_PLAYERACCOUNT, Console.Yes),
    ChatCommand("ip", [Tail], HandleBanIPCommand, R.RBAC_PERM_COMMAND_BAN_IP, Console.Yes),
  ];
  return [SubCommands("ban", banCommandTable), SubCommands("baninfo", baninfoCommandTable), SubCommands("banlist", banlistCommandTable), SubCommands("unban", unbanCommandTable)];
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleBanAccountCommand */
function HandleBanAccountCommand(handler: ChatHandler, args: string): Promise<boolean> {
  return HandleBanHelper(BAN_ACCOUNT, args, handler);
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleBanCharacterCommand */
async function HandleBanCharacterCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) return false;
  const [nameStr, durationStr, reasonStr] = strtok3(args);
  if (!nameStr) return false;
  if (!durationStr || !atoi(durationStr)) return false;
  if (!reasonStr) return false;
  const name = normalizePlayerName(nameStr);
  if (!name) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  const author = handler.getSession()?.getPlayerName() ?? "";
  switch (await sBan.BanCharacter(name, durationStr, reasonStr, author)) {
    case BAN_SUCCESS:
      if (!sWorld().getBoolConfig(ServerConfig.CONFIG_SHOW_BAN_IN_WORLD)) {
        if (atoi(durationStr) > 0) handler.pSendSysMessage(L.LANG_BAN_YOUBANNED, name, secsToTimeString(timeStringToSecs(durationStr), true), reasonStr);
        else handler.pSendSysMessage(L.LANG_BAN_YOUPERMBANNED, name, reasonStr);
      }
      break;
    case BAN_NOTFOUND:
      handler.sendErrorMessage(L.LANG_BAN_NOTFOUND, "character", name);
      return false;
    default:
      break;
  }
  return true;
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleBanAccountByCharCommand */
function HandleBanAccountByCharCommand(handler: ChatHandler, args: string): Promise<boolean> {
  return HandleBanHelper(BAN_CHARACTER, args, handler);
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleBanIPCommand */
function HandleBanIPCommand(handler: ChatHandler, args: string): Promise<boolean> {
  return HandleBanHelper(BAN_IP, args, handler);
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleBanHelper */
async function HandleBanHelper(mode: number, args: string, handler: ChatHandler): Promise<boolean> {
  if (!args) return false;
  const [cnameOrIP, durationStr, reasonStr] = strtok3(args);
  if (!cnameOrIP) return false;
  let nameOrIP = cnameOrIP;
  if (!durationStr || !atoi(durationStr)) return false;
  if (!reasonStr) return false;
  switch (mode) {
    case BAN_ACCOUNT:
      nameOrIP = utf8ToUpperOnlyLatin(nameOrIP);
      if (!nameOrIP) {
        handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, cnameOrIP);
        return false;
      }
      break;
    case BAN_CHARACTER: {
      const normalized = normalizePlayerName(nameOrIP);
      if (!normalized) {
        handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
        return false;
      }
      nameOrIP = normalized;
      break;
    }
    case BAN_IP:
      if (!isIPAddress(nameOrIP)) return false;
      break;
  }
  const author = handler.getSession()?.getPlayerName() ?? "Console";
  let banReturn: number;
  switch (mode) {
    case BAN_ACCOUNT:
      banReturn = await sBan.BanAccount(nameOrIP, durationStr, reasonStr, author);
      break;
    case BAN_CHARACTER:
      banReturn = await sBan.BanAccountByPlayerName(nameOrIP, durationStr, reasonStr, author);
      break;
    default:
      banReturn = await sBan.BanIP(nameOrIP, durationStr, reasonStr, author);
      break;
  }
  switch (banReturn) {
    case BAN_SUCCESS:
      if (!sWorld().getBoolConfig(ServerConfig.CONFIG_SHOW_BAN_IN_WORLD)) {
        if (atoi(durationStr) > 0) handler.pSendSysMessage(L.LANG_BAN_YOUBANNED, nameOrIP, secsToTimeString(timeStringToSecs(durationStr), true), reasonStr);
        else handler.pSendSysMessage(L.LANG_BAN_YOUPERMBANNED, nameOrIP, reasonStr);
      }
      break;
    case BAN_SYNTAX_ERROR:
      return false;
    case BAN_NOTFOUND:
      handler.sendErrorMessage(L.LANG_BAN_NOTFOUND, mode === BAN_CHARACTER ? "character" : mode === BAN_IP ? "ip" : "account", nameOrIP);
      return false;
    case BAN_LONGER_EXISTS:
      handler.pSendSysMessage("Unsuccessful! A longer ban is already present on this account!");
      break;
    default:
      break;
  }
  return true;
}

/** The first `strtok(args, "")` word: the whole line without leading spaces. */
function wholeLine(args: string): string | null {
  const trimmed = args.replace(/^ +/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleBanInfoAccountCommand */
async function HandleBanInfoAccountCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) return false;
  const nameStr = wholeLine(args);
  if (!nameStr) return false;
  const accountName = utf8ToUpperOnlyLatin(nameStr);
  if (!accountName) {
    handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, nameStr);
    return false;
  }
  const accountId = await getId(LoginDatabase(), accountName);
  if (!accountId) {
    handler.pSendSysMessage(L.LANG_ACCOUNT_NOT_EXIST, accountName);
    return true;
  }
  return HandleBanInfoHelper(accountId, accountName, handler);
}

/** One `LANG_BANINFO_HISTORYENTRY` line (`bandate`, `unbandate - bandate`, `active`, `unbandate`, reason, author). */
function banHistoryEntry(handler: ChatHandler, fields: Fields): void {
  const unbanDate = Number(fields[3]);
  const duration = Number(fields[1]);
  const active = Boolean(Number(fields[2])) && (duration === 0 || unbanDate >= Math.floor(Date.now() / 1000));
  const permanent = duration === 0;
  const banTime = permanent ? handler.getAcoreString(L.LANG_BANINFO_INFINITE) : secsToTimeString(duration, true);
  handler.pSendSysMessage(
    L.LANG_BANINFO_HISTORYENTRY,
    String(fields[0] ?? ""),
    banTime,
    active ? handler.getAcoreString(L.LANG_YES) : handler.getAcoreString(L.LANG_NO),
    String(fields[4] ?? ""),
    String(fields[5] ?? ""),
  );
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleBanInfoHelper */
async function HandleBanInfoHelper(accountId: number, accountName: string, handler: ChatHandler): Promise<boolean> {
  const result = await queryFields(
    LoginDatabase(),
    "SELECT FROM_UNIXTIME(bandate, '%Y-%m-%d..%H:%i:%s') as bandate, unbandate-bandate, active, unbandate, banreason, bannedby FROM account_banned WHERE id = ? ORDER BY bandate ASC",
    accountId,
  );
  if (result.length === 0) {
    handler.pSendSysMessage(L.LANG_BANINFO_NOACCOUNTBAN, accountName);
    return true;
  }
  handler.pSendSysMessage(L.LANG_BANINFO_BANHISTORY, accountName);
  for (const fields of result) banHistoryEntry(handler, fields);
  return true;
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleBanInfoCharacterCommand */
async function HandleBanInfoCharacterCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) return false;
  const target = ObjectAccessor.FindPlayerByName(args, false);
  const name = args;
  let targetGuid: number;
  if (!target) {
    targetGuid = sCharacterCache.getCharacterGuidByName(name);
    if (!targetGuid) {
      handler.pSendSysMessage(L.LANG_BANINFO_NOCHARACTER);
      return false;
    }
  } else {
    targetGuid = target.getGUIDLow();
  }
  const result = await queryFields(CharacterDatabase(), CHAR_SEL_BANINFO, targetGuid);
  if (result.length === 0) {
    handler.pSendSysMessage(L.LANG_CHAR_NOT_BANNED, name);
    return true;
  }
  handler.pSendSysMessage(L.LANG_BANINFO_BANHISTORY, name);
  for (const fields of result) banHistoryEntry(handler, fields);
  return true;
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleBanInfoIPCommand */
async function HandleBanInfoIPCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) return false;
  const ipStr = wholeLine(args);
  if (!ipStr) return false;
  if (!isIPAddress(ipStr)) return false;
  const [fields] = await queryFields(
    LoginDatabase(),
    "SELECT ip, FROM_UNIXTIME(bandate, '%Y-%m-%d %H:%i:%s'), FROM_UNIXTIME(unbandate, '%Y-%m-%d %H:%i:%s'), IF (unbandate > UNIX_TIMESTAMP(), unbandate - UNIX_TIMESTAMP(), 0) AS timeRemaining, banreason, bannedby, unbandate - bandate = 0 AS permanent FROM ip_banned WHERE ip = ?",
    ipStr,
  );
  if (!fields) {
    handler.pSendSysMessage(L.LANG_BANINFO_NOIP);
    return true;
  }
  const permanent = Number(fields[6]) === 1;
  handler.pSendSysMessage(
    L.LANG_BANINFO_IPENTRY,
    String(fields[0] ?? ""),
    String(fields[1] ?? ""),
    permanent ? handler.getAcoreString(L.LANG_BANINFO_NEVER) : String(fields[2] ?? ""),
    permanent ? handler.getAcoreString(L.LANG_BANINFO_INFINITE) : secsToTimeString(Number(fields[3]), true),
    String(fields[4] ?? ""),
    String(fields[5] ?? ""),
  );
  return true;
}

/** `strtok(args, " ")`: the first word, or "". */
function firstWord(args: string): string {
  return /^ *([^ ]+)/.exec(args)?.[1] ?? "";
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleBanListAccountCommand */
async function HandleBanListAccountCommand(handler: ChatHandler, args: string): Promise<boolean> {
  await executeStatement(LoginDatabase(), LOGIN_DEL_EXPIRED_IP_BANS);
  const filter = firstWord(args);
  const result = filter ? await queryFields(LoginDatabase(), LOGIN_SEL_ACCOUNT_BANNED_BY_USERNAME, filter) : await queryFields(LoginDatabase(), LOGIN_SEL_ACCOUNT_BANNED_ALL);
  if (result.length === 0) {
    handler.pSendSysMessage(L.LANG_BANLIST_NOACCOUNT);
    return true;
  }
  return HandleBanListHelper(result, handler);
}

/** One wide console ban row: `|name|yy-mm-dd hh:mm|yy-mm-dd hh:mm or permanent|author|reason|`. */
function banRow(handler: ChatHandler, name: string, bandate: number, unbandate: number, bannedby: string, banreason: string, leadingBar = true): void {
  const tmBan = TimeBreakdown(bandate);
  const lead = leadingBar ? "|" : "";
  if (bandate === unbandate) {
    handler.pSendSysMessage(
      `${lead}{:<15.15}|{:02}-{:02}-{:02} {:02}:{:02}|   permanent  |{:<15.15}|{:<15.15}|`,
      name,
      tmBan.year % 100,
      tmBan.mon + 1,
      tmBan.mday,
      tmBan.hour,
      tmBan.min,
      bannedby,
      banreason,
    );
  } else {
    const tmUnban = TimeBreakdown(unbandate);
    handler.pSendSysMessage(
      "|{:<15.15}|{:02}-{:02}-{:02} {:02}:{:02}|{:02}-{:02}-{:02} {:02}:{:02}|{:<15.15}|{:<15.15}|",
      name,
      tmBan.year % 100,
      tmBan.mon + 1,
      tmBan.mday,
      tmBan.hour,
      tmBan.min,
      tmUnban.year % 100,
      tmUnban.mon + 1,
      tmUnban.mday,
      tmUnban.hour,
      tmUnban.min,
      bannedby,
      banreason,
    );
  }
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleBanListHelper */
async function HandleBanListHelper(result: Fields[], handler: ChatHandler): Promise<boolean> {
  handler.pSendSysMessage(L.LANG_BANLIST_MATCHINGACCOUNT);
  // Chat short output
  if (handler.getSession()) {
    for (const fields of result) {
      const accountid = Number(fields[0]);
      const [fields2] = await queryFields(LoginDatabase(), "SELECT account.username FROM account, account_banned WHERE account_banned.id = ? AND account_banned.id = account.id", accountid);
      if (fields2) handler.pSendSysMessage("{}", String(fields2[0] ?? ""));
    }
    return true;
  }
  // Console wide output
  handler.sendSysMessage(L.LANG_BANLIST_ACCOUNTS);
  handler.sendSysMessage(" ===============================================================================");
  handler.sendSysMessage(L.LANG_BANLIST_ACCOUNTS_HEADER);
  for (const fields of result) {
    handler.sendSysMessage("-------------------------------------------------------------------------------");
    const accountId = Number(fields[0]);
    // "account" case, name can be get in same query; "character" case, name need extract from another DB
    const accountName = fields.length > 1 ? String(fields[1] ?? "") : ((await getName(LoginDatabase(), accountId)) ?? "");
    const banInfo = await queryFields(LoginDatabase(), "SELECT bandate, unbandate, bannedby, banreason FROM account_banned WHERE id = ? ORDER BY unbandate", accountId);
    for (const fields2 of banInfo) banRow(handler, accountName, Number(fields2[0]), Number(fields2[1]), String(fields2[2] ?? ""), String(fields2[3] ?? ""));
  }
  handler.sendSysMessage(" ===============================================================================");
  return true;
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleBanListCharacterCommand */
async function HandleBanListCharacterCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) return false;
  const filter = firstWord(args);
  if (!filter) return false;
  const result = await queryFields(CharacterDatabase(), CHAR_SEL_GUID_BY_NAME_FILTER, filter);
  if (result.length === 0) {
    handler.pSendSysMessage(L.LANG_BANLIST_NOCHARACTER);
    return true;
  }
  handler.pSendSysMessage(L.LANG_BANLIST_MATCHINGCHARACTER);
  // Chat short output
  if (handler.getSession()) {
    for (const fields of result) {
      const [banResult] = await queryFields(CharacterDatabase(), CHAR_SEL_BANNED_NAME, Number(fields[0]));
      if (banResult) handler.pSendSysMessage("{}", String(banResult[0] ?? ""));
    }
    return true;
  }
  // Console wide output
  handler.sendSysMessage(L.LANG_BANLIST_CHARACTERS);
  handler.sendSysMessage(" =============================================================================== ");
  handler.sendSysMessage(L.LANG_BANLIST_CHARACTERS_HEADER);
  for (const fields of result) {
    handler.sendSysMessage("-------------------------------------------------------------------------------");
    const char_name = String(fields[1] ?? "");
    const banInfo = await queryFields(CharacterDatabase(), CHAR_SEL_BANINFO_LIST, Number(fields[0]));
    for (const banFields of banInfo) banRow(handler, char_name, Number(banFields[0]), Number(banFields[1]), String(banFields[2] ?? ""), String(banFields[3] ?? ""));
  }
  handler.sendSysMessage(" =============================================================================== ");
  return true;
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleBanListIPCommand */
async function HandleBanListIPCommand(handler: ChatHandler, args: string): Promise<boolean> {
  await executeStatement(LoginDatabase(), LOGIN_DEL_EXPIRED_IP_BANS);
  const filter = firstWord(args);
  const result = filter ? await queryFields(LoginDatabase(), LOGIN_SEL_IP_BANNED_BY_IP, filter) : await queryFields(LoginDatabase(), LOGIN_SEL_IP_BANNED_ALL);
  if (result.length === 0) {
    handler.pSendSysMessage(L.LANG_BANLIST_NOIP);
    return true;
  }
  handler.pSendSysMessage(L.LANG_BANLIST_MATCHINGIP);
  // Chat short output
  if (handler.getSession()) {
    for (const fields of result) handler.pSendSysMessage("{}", String(fields[0] ?? ""));
    return true;
  }
  // Console wide output
  handler.sendSysMessage(L.LANG_BANLIST_IPS);
  handler.sendSysMessage(" ===============================================================================");
  handler.sendSysMessage(L.LANG_BANLIST_IPS_HEADER);
  for (const fields of result) {
    handler.sendSysMessage("-------------------------------------------------------------------------------");
    banRow(handler, String(fields[0] ?? ""), Number(fields[1]), Number(fields[2]), String(fields[3] ?? ""), String(fields[4] ?? ""), false);
  }
  handler.sendSysMessage(" ===============================================================================");
  return true;
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleUnBanAccountCommand */
function HandleUnBanAccountCommand(handler: ChatHandler, args: string): Promise<boolean> {
  return HandleUnBanHelper(BAN_ACCOUNT, args, handler);
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleUnBanCharacterCommand */
async function HandleUnBanCharacterCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) return false;
  const nameStr = firstWord(args);
  if (!nameStr) return false;
  const CharacterName = normalizePlayerName(nameStr);
  if (!CharacterName) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  if (!(await sBan.RemoveBanCharacter(CharacterName))) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  return true;
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleUnBanAccountByCharCommand */
function HandleUnBanAccountByCharCommand(handler: ChatHandler, args: string): Promise<boolean> {
  return HandleUnBanHelper(BAN_CHARACTER, args, handler);
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleUnBanIPCommand */
function HandleUnBanIPCommand(handler: ChatHandler, args: string): Promise<boolean> {
  return HandleUnBanHelper(BAN_IP, args, handler);
}

/** @ac scripts/Commands/cs_ban.cpp ban_commandscript::HandleUnBanHelper */
async function HandleUnBanHelper(mode: number, args: string, handler: ChatHandler): Promise<boolean> {
  if (!args) return false;
  const nameOrIPStr = firstWord(args);
  if (!nameOrIPStr) return false;
  let nameOrIP = nameOrIPStr;
  switch (mode) {
    case BAN_ACCOUNT:
      nameOrIP = utf8ToUpperOnlyLatin(nameOrIP);
      if (!nameOrIP) {
        handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, nameOrIPStr);
        return false;
      }
      break;
    case BAN_CHARACTER: {
      const normalized = normalizePlayerName(nameOrIP);
      if (!normalized) {
        handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
        return false;
      }
      nameOrIP = normalized;
      break;
    }
    case BAN_IP:
      if (!isIPAddress(nameOrIP)) return false;
      break;
  }
  const removed =
    mode === BAN_ACCOUNT ? await sBan.RemoveBanAccount(nameOrIP) : mode === BAN_CHARACTER ? await sBan.RemoveBanAccountByPlayerName(nameOrIP) : await sBan.RemoveBanIP(nameOrIP);
  handler.pSendSysMessage(removed ? L.LANG_UNBAN_UNBANNED : L.LANG_UNBAN_ERROR, nameOrIP);
  return true;
}

/** @ac scripts/Commands/cs_ban.cpp AddSC_ban_commandscript */
export function AddSC_ban_commandscript(): void {
  registerCommandScript(GetCommands);
}

