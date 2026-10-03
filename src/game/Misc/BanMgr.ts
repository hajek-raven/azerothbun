/** `sBan` (`BanMgr.cpp`): account, character, and IP bans in `account_banned`, `character_banned`, and `ip_banned`. */
import { commitTransaction, executeStatement, queryFields, type StatementTransaction } from "../../database/database.ts";
import { CharacterDatabase, LoginDatabase } from "../../database/DatabaseEnv.ts";
import { CHAR_INS_CHARACTER_BAN, CHAR_UPD_CHARACTER_BAN } from "../../gen/CharacterDatabase.gen.ts";
import {
  LOGIN_DEL_IP_NOT_BANNED,
  LOGIN_INS_ACCOUNT_BANNED,
  LOGIN_INS_IP_BANNED,
  LOGIN_SEL_ACCOUNT_BANNED,
  LOGIN_SEL_ACCOUNT_BY_IP,
  LOGIN_UPD_ACCOUNT_NOT_BANNED,
} from "../../gen/LoginDatabase.gen.ts";
import { getId, getName } from "../Accounts/AccountMgr.ts";
import { sCharacterCache } from "../Cache/CharacterCache.ts";
import { ChatHandler } from "../Chat/Chat.ts";
import { ObjectAccessor } from "../Globals/ObjectAccessor.ts";
import * as L from "../Miscellaneous/Language.ts";
import { sWorldSessionMgr } from "../Server/WorldSessionMgr.ts";
import { secsToTimeString, timeStringToSecs } from "../time/timer.ts";
import { ServerConfig } from "../world/world-config.ts";
import { sWorld } from "../world/world.ts";

/** @ac game/Misc/BanMgr.h BanReturn */
export const BAN_SUCCESS = 0;
export const BAN_SYNTAX_ERROR = 1;
export const BAN_NOTFOUND = 2;
export const BAN_LONGER_EXISTS = 3;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** The world announcement of a ban (`CONFIG_SHOW_BAN_IN_WORLD`). */
function announce(Duration: string, timed: number, permanent: number, Author: string, name: string, Reason: string): void {
  if (!sWorld().getBoolConfig(ServerConfig.CONFIG_SHOW_BAN_IN_WORLD)) return;
  if (timeStringToSecs(Duration) > 0) new ChatHandler(null).sendWorldText(timed, Author, name, secsToTimeString(timeStringToSecs(Duration), true), Reason);
  else new ChatHandler(null).sendWorldText(permanent, Author, name, Reason);
}

/** Kicks the account's session unless its player is the author (`FindSession(account)->GetPlayerName() != author`). */
function kickAccount(accountId: number, Author: string, reason: string): void {
  const session = sWorldSessionMgr.FindSession(accountId);
  if (session && session.getPlayerName() !== Author) session.kickPlayer(reason);
}

export class BanMgr {
  /** @ac game/Misc/BanMgr.cpp BanMgr::BanAccount */
  async BanAccount(AccountName: string, Duration: string, Reason: string, Author: string): Promise<number> {
    if (!AccountName || !Duration) return BAN_SYNTAX_ERROR;
    const AccountID = await getId(LoginDatabase(), AccountName);
    if (!AccountID) return BAN_NOTFOUND;
    return this.banAccountId(AccountID, AccountName, Duration, Reason, Author);
  }

  /** @ac game/Misc/BanMgr.cpp BanMgr::BanAccountByPlayerName */
  async BanAccountByPlayerName(CharacterName: string, Duration: string, Reason: string, Author: string): Promise<number> {
    if (!CharacterName || !Duration) return BAN_SYNTAX_ERROR;
    const AccountID = sCharacterCache.getCharacterAccountIdByName(CharacterName);
    if (!AccountID) return BAN_NOTFOUND;
    return this.banAccountId(AccountID, null, Duration, Reason, Author);
  }

  /** The shared body of `BanAccount` and `BanAccountByPlayerName`. */
  private async banAccountId(AccountID: number, accountName: string | null, Duration: string, Reason: string, Author: string): Promise<number> {
    const DurationSecs = timeStringToSecs(Duration);
    // pussywizard: check existing ban to prevent overriding by a shorter one! >_>
    const [banresult] = await queryFields(LoginDatabase(), LOGIN_SEL_ACCOUNT_BANNED, AccountID);
    if (banresult && (Number(banresult[0]) === Number(banresult[1]) || (Number(banresult[1]) > now() + DurationSecs && DurationSecs))) return BAN_LONGER_EXISTS;
    // make sure there is only one active ban
    const trans: StatementTransaction = [
      [LOGIN_UPD_ACCOUNT_NOT_BANNED, AccountID],
      [LOGIN_INS_ACCOUNT_BANNED, AccountID, DurationSecs, Author, Reason],
    ];
    kickAccount(AccountID, Author, "Ban Account at condition 'FindSession(account)->GetPlayerName() != author'");
    await commitTransaction(LoginDatabase(), trans);
    const AccountName = accountName ?? (await getName(LoginDatabase(), AccountID)) ?? "";
    announce(Duration, L.LANG_BAN_ACCOUNT_YOUBANNEDMESSAGE_WORLD, L.LANG_BAN_ACCOUNT_YOUPERMBANNEDMESSAGE_WORLD, Author, AccountName, Reason);
    return BAN_SUCCESS;
  }

  /** @ac game/Misc/BanMgr.cpp BanMgr::BanIP */
  async BanIP(IP: string, Duration: string, Reason: string, Author: string): Promise<number> {
    if (!IP || !Duration) return BAN_SYNTAX_ERROR;
    const DurationSecs = timeStringToSecs(Duration);
    const resultAccounts = await queryFields(LoginDatabase(), LOGIN_SEL_ACCOUNT_BY_IP, IP);
    await executeStatement(LoginDatabase(), LOGIN_INS_IP_BANNED, IP, DurationSecs, Author, Reason);
    announce(Duration, L.LANG_BAN_IP_YOUBANNEDMESSAGE_WORLD, L.LANG_BAN_IP_YOUPERMBANNEDMESSAGE_WORLD, Author, IP, Reason);
    ///- Disconnect all affected players (for IP it can be several)
    for (const fields of resultAccounts) kickAccount(Number(fields[0]), Author, "Ban IP at condition 'FindSession(account)->GetPlayerName() != author'");
    return BAN_SUCCESS;
  }

  /** @ac game/Misc/BanMgr.cpp BanMgr::BanCharacter */
  async BanCharacter(CharacterName: string, Duration: string, Reason: string, Author: string): Promise<number> {
    const target = ObjectAccessor.FindPlayerByName(CharacterName, false);
    const DurationSecs = timeStringToSecs(Duration);
    /// Pick a player to ban if not online
    const TargetGUID = target ? target.getGUIDLow() : sCharacterCache.getCharacterGuidByName(CharacterName);
    if (!TargetGUID) return BAN_NOTFOUND;
    // make sure there is only one active ban
    await executeStatement(CharacterDatabase(), CHAR_UPD_CHARACTER_BAN, TargetGUID);
    await executeStatement(CharacterDatabase(), CHAR_INS_CHARACTER_BAN, TargetGUID, DurationSecs, Author, Reason);
    if (target) target.getSession().kickPlayer("Ban");
    announce(Duration, L.LANG_BAN_CHARACTER_YOUBANNEDMESSAGE_WORLD, L.LANG_BAN_CHARACTER_YOUPERMBANNEDMESSAGE_WORLD, Author, CharacterName, Reason);
    return BAN_SUCCESS;
  }

  /** @ac game/Misc/BanMgr.cpp BanMgr::RemoveBanAccount */
  async RemoveBanAccount(AccountName: string): Promise<boolean> {
    const AccountID = await getId(LoginDatabase(), AccountName);
    if (!AccountID) return false;
    await executeStatement(LoginDatabase(), LOGIN_UPD_ACCOUNT_NOT_BANNED, AccountID);
    return true;
  }

  /** @ac game/Misc/BanMgr.cpp BanMgr::RemoveBanAccountByPlayerName */
  async RemoveBanAccountByPlayerName(CharacterName: string): Promise<boolean> {
    const AccountID = sCharacterCache.getCharacterAccountIdByName(CharacterName);
    if (!AccountID) return false;
    await executeStatement(LoginDatabase(), LOGIN_UPD_ACCOUNT_NOT_BANNED, AccountID);
    return true;
  }

  /** @ac game/Misc/BanMgr.cpp BanMgr::RemoveBanIP */
  async RemoveBanIP(IP: string): Promise<boolean> {
    await executeStatement(LoginDatabase(), LOGIN_DEL_IP_NOT_BANNED, IP);
    return true;
  }

  /** @ac game/Misc/BanMgr.cpp BanMgr::RemoveBanCharacter */
  async RemoveBanCharacter(CharacterName: string): Promise<boolean> {
    const pBanned = ObjectAccessor.FindPlayerByName(CharacterName, false);
    /// Pick a player to ban if not online
    const guid = pBanned ? pBanned.getGUIDLow() : sCharacterCache.getCharacterGuidByName(CharacterName);
    if (!guid) return false;
    await executeStatement(CharacterDatabase(), CHAR_UPD_CHARACTER_BAN, guid);
    return true;
  }
}

export const sBan = new BanMgr();
