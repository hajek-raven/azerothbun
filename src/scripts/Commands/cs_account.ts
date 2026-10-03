/** `cs_account.cpp`: `.account`, `.account create|delete|password|set …|lock …|flag …|info|onlinelist|addon|2fa …`. */
import { executeStatement, queryFields } from "../../database/database.ts";
import { CharacterDatabase, LoginDatabase } from "../../database/DatabaseEnv.ts";
import {
  LOGIN_DEL_ACCOUNT_ACCESS,
  LOGIN_DEL_ACCOUNT_ACCESS_BY_REALM,
  LOGIN_GET_EMAIL_BY_ID,
  LOGIN_INS_ACCOUNT_ACCESS,
  LOGIN_SEL_ACCOUNT_ACCESS_GMLEVEL_TEST,
  LOGIN_SEL_ACCOUNT_FLAG,
  LOGIN_SEL_ACCOUNT_INFO,
  LOGIN_SEL_ACCOUNT_INFO_DETAILED,
  LOGIN_SEL_ACCOUNT_TOTP_SECRET,
  LOGIN_SEL_PINFO_BANS,
  LOGIN_UPD_ACCOUNT_LOCK,
  LOGIN_UPD_ACCOUNT_LOCK_COUNTRY,
  LOGIN_UPD_ACCOUNT_TOTP_SECRET,
  LOGIN_UPD_EXPANSION,
} from "../../gen/LoginDatabase.gen.ts";
import { CHAR_SEL_ACCOUNT_INFO_CHARS, CHAR_SEL_CHARACTER_ONLINE } from "../../gen/CharacterDatabase.gen.ts";
import { log, logError } from "../../log.ts";
import { accountFlagNames, MAX_ACCOUNT_FLAG } from "../../common/Common.ts";
import { Base32 } from "../../common/Encoding/Base32.ts";
import { AEDecrypt, AEEncryptWithRandomIV, IV_SIZE_BYTES, TAG_SIZE_BYTES } from "../../common/Cryptography/AES.ts";
import { TOTP } from "../../common/Cryptography/TOTP.ts";
import { stringEqualI, utf8ToUpperOnlyLatin } from "../../common/util.ts";
import {
  AccountOpResult,
  changeEmail,
  changePassword,
  checkPassword,
  createAccount,
  deleteAccount,
  getId,
  getName,
  getSecurity,
  isConsoleAccount,
} from "../../game/Accounts/AccountMgr.ts";
import {
  RBAC_PERM_COMMAND_ACCOUNT,
  RBAC_PERM_COMMAND_ACCOUNT_ADDON,
  RBAC_PERM_COMMAND_ACCOUNT_CREATE,
  RBAC_PERM_COMMAND_ACCOUNT_DELETE,
  RBAC_PERM_COMMAND_ACCOUNT_FLAG_ADD,
  RBAC_PERM_COMMAND_ACCOUNT_FLAG_LIST,
  RBAC_PERM_COMMAND_ACCOUNT_FLAG_REMOVE,
  RBAC_PERM_COMMAND_ACCOUNT_INFO,
  RBAC_PERM_COMMAND_ACCOUNT_LOCK_COUNTRY,
  RBAC_PERM_COMMAND_ACCOUNT_LOCK_IP,
  RBAC_PERM_COMMAND_ACCOUNT_ONLINE_LIST,
  RBAC_PERM_COMMAND_ACCOUNT_PASSWORD,
  RBAC_PERM_COMMAND_ACCOUNT_SET,
  RBAC_PERM_COMMAND_ACCOUNT_SET_ADDON,
  RBAC_PERM_COMMAND_ACCOUNT_SET_PASSWORD,
  RBAC_PERM_COMMAND_ACCOUNT_SET_SEC_EMAIL,
  RBAC_PERM_COMMAND_ACCOUNT_SET_SECLEVEL,
  RBAC_PERM_MAY_CHECK_OWN_EMAIL,
} from "../../game/Accounts/RBACDefines.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { Optional, stringArg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { AccountIdentifierArg, Tail, type AccountIdentifier } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { sChrClassesStore, sChrRacesStore } from "../../game/DataStores/DBCStores.ts";
import { DeleteFromDB } from "../../game/Entities/Player/PlayerMisc.ts";
import { ObjectAccessor } from "../../game/Globals/ObjectAccessor.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { sWorldSessionMgr } from "../../game/Server/WorldSessionMgr.ts";
import { secsToTimeString } from "../../game/time/timer.ts";
import { ServerConfig } from "../../game/world/world-config.ts";
import { sWorld } from "../../game/world/world.ts";
import { ACCOUNT_FLAG_GM, SEC_CONSOLE } from "../../shared/SharedDefines.ts";
import { realm } from "../../shared/Realms/Realm.ts";
import { SECRET_TOTP_MASTER_KEY, sSecretMgr } from "../../shared/Secrets/SecretMgr.ts";

/** `strtok(args, " ")` over a legacy `char const* args` handler. */
function strtok(args: string): string[] {
  return args.split(" ").filter((token) => token.length > 0);
}

/** `Acore::StringTo<uint8>` / `<int32>` / `<uint32>` (whole token, base 10). */
function stringTo(token: string | undefined, min: number, max: number): number | null {
  if (token === undefined || !/^-?\d+$/.test(token)) return null;
  const value = Number(token);
  return value >= min && value <= max ? value : null;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const accountSetCommandTable: ChatCommandTable = [
    ChatCommand("addon", [Tail], HandleAccountSetAddonCommand, RBAC_PERM_COMMAND_ACCOUNT_SET_ADDON, Console.Yes),
    ChatCommand("gmlevel", [Tail], HandleAccountSetGmLevelCommand, RBAC_PERM_COMMAND_ACCOUNT_SET_SECLEVEL, Console.Yes),
    ChatCommand("password", [Tail], HandleAccountSetPasswordCommand, RBAC_PERM_COMMAND_ACCOUNT_SET_PASSWORD, Console.Yes),
    ChatCommand("2fa", [Tail], HandleAccountSet2FACommand, RBAC_PERM_COMMAND_ACCOUNT_SET, Console.Yes),
    ChatCommand("email", [AccountIdentifierArg, stringArg, stringArg], HandleAccountSetEmailCommand, RBAC_PERM_COMMAND_ACCOUNT_SET_SEC_EMAIL, Console.Yes),
  ];
  const accountLockCommandTable: ChatCommandTable = [
    ChatCommand("country", [Tail], HandleAccountLockCountryCommand, RBAC_PERM_COMMAND_ACCOUNT_LOCK_COUNTRY, Console.Yes),
    ChatCommand("ip", [Tail], HandleAccountLockIpCommand, RBAC_PERM_COMMAND_ACCOUNT_LOCK_IP, Console.Yes),
  ];
  const account2faCommandTable: ChatCommandTable = [
    ChatCommand("setup", [Tail], HandleAccount2FASetupCommand, RBAC_PERM_COMMAND_ACCOUNT, Console.No),
    ChatCommand("remove", [Tail], HandleAccount2FARemoveCommand, RBAC_PERM_COMMAND_ACCOUNT, Console.No),
  ];
  const accountRemoveCommandTable: ChatCommandTable = [
    ChatCommand("country", [Tail], HandleAccountRemoveLockCountryCommand, RBAC_PERM_COMMAND_ACCOUNT_LOCK_COUNTRY, Console.Yes),
  ];
  const accountFlagCommandTable: ChatCommandTable = [
    ChatCommand("list", [Optional(AccountIdentifierArg)], HandleAccountFlagListCommand, RBAC_PERM_COMMAND_ACCOUNT_FLAG_LIST, Console.Yes),
    ChatCommand("add", [AccountIdentifierArg, stringArg], HandleAccountFlagAddCommand, RBAC_PERM_COMMAND_ACCOUNT_FLAG_ADD, Console.Yes),
    ChatCommand("remove", [AccountIdentifierArg, stringArg], HandleAccountFlagRemoveCommand, RBAC_PERM_COMMAND_ACCOUNT_FLAG_REMOVE, Console.Yes),
  ];
  const accountCommandTable: ChatCommandTable = [
    SubCommands("2fa", account2faCommandTable),
    ChatCommand("addon", [Tail], HandleAccountAddonCommand, RBAC_PERM_COMMAND_ACCOUNT_ADDON, Console.No),
    ChatCommand("create", [Tail], HandleAccountCreateCommand, RBAC_PERM_COMMAND_ACCOUNT_CREATE, Console.Yes),
    ChatCommand("delete", [Tail], HandleAccountDeleteCommand, RBAC_PERM_COMMAND_ACCOUNT_DELETE, Console.Yes),
    SubCommands("flag", accountFlagCommandTable),
    ChatCommand("info", [Optional(AccountIdentifierArg)], HandleAccountInfoCommand, RBAC_PERM_COMMAND_ACCOUNT_INFO, Console.Yes),
    ChatCommand("onlinelist", [Tail], HandleAccountOnlineListCommand, RBAC_PERM_COMMAND_ACCOUNT_ONLINE_LIST, Console.Yes),
    SubCommands("lock", accountLockCommandTable),
    SubCommands("set", accountSetCommandTable),
    ChatCommand("password", [Tail], HandleAccountPasswordCommand, RBAC_PERM_COMMAND_ACCOUNT_PASSWORD, Console.No),
    SubCommands("remove", accountRemoveCommandTable),
    ChatCommand("", [Tail], HandleAccountCommand, RBAC_PERM_COMMAND_ACCOUNT, Console.No),
  ];
  return [SubCommands("account", accountCommandTable)];
}

/** Suggested TOTP secrets per account (`static std::unordered_map<uint32, Secret> suggestions`). */
const suggestions = new Map<number, Uint8Array>();

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccount2FASetupCommand */
async function HandleAccount2FASetupCommand(handler: ChatHandler, args: string): Promise<boolean> {
  // no error message here: the framework then prints the command help, which explains how to get the key
  if (!args) return false;
  const token = stringTo(args, 0, 0xffffffff);
  const masterKey = await sSecretMgr.GetSecret(LoginDatabase(), SECRET_TOTP_MASTER_KEY);
  if (!masterKey.available) {
    handler.sendErrorMessage(L.LANG_2FA_COMMANDS_NOT_SETUP);
    return false;
  }
  const accountId = handler.getSession()!.getAccountId();
  // check if 2FA already enabled
  const [row] = await queryFields(LoginDatabase(), LOGIN_SEL_ACCOUNT_TOTP_SECRET, accountId);
  if (!row) {
    logError("server", `Account ${accountId} not found in login database when processing .account 2fa setup command.`);
    handler.sendErrorMessage(L.LANG_UNKNOWN_ERROR);
    return false;
  }
  if (row[0] !== null) {
    handler.sendErrorMessage(L.LANG_2FA_ALREADY_SETUP);
    return false;
  }
  // store random suggested secrets
  let suggestion = suggestions.get(accountId);
  const fresh = !suggestion;
  if (!suggestion) {
    suggestion = crypto.getRandomValues(new Uint8Array(TOTP.RECOMMENDED_SECRET_LENGTH));
    suggestions.set(accountId, suggestion);
  }
  if (!fresh && token) {
    if (TOTP.ValidateToken(suggestion, token)) {
      const stored = masterKey.value ? await AEEncryptWithRandomIV(suggestion, masterKey.value) : suggestion;
      await executeStatement(LoginDatabase(), LOGIN_UPD_ACCOUNT_TOTP_SECRET, stored, accountId);
      suggestions.delete(accountId);
      handler.sendSysMessage(L.LANG_2FA_SETUP_COMPLETE);
      return true;
    }
    handler.sendSysMessage(L.LANG_2FA_INVALID_TOKEN);
  }
  // new suggestion, or no token specified, output TOTP parameters
  handler.sendErrorMessage(L.LANG_2FA_SECRET_SUGGESTION, Base32.Encode(suggestion));
  return false;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccount2FARemoveCommand */
async function HandleAccount2FARemoveCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) return false;
  const token = stringTo(args, 0, 0xffffffff);
  const masterKey = await sSecretMgr.GetSecret(LoginDatabase(), SECRET_TOTP_MASTER_KEY);
  if (!masterKey.available) {
    handler.sendErrorMessage(L.LANG_2FA_COMMANDS_NOT_SETUP);
    return false;
  }
  const accountId = handler.getSession()!.getAccountId();
  const [row] = await queryFields(LoginDatabase(), LOGIN_SEL_ACCOUNT_TOTP_SECRET, accountId);
  if (!row) {
    logError("server", `Account ${accountId} not found in login database when processing .account 2fa setup command.`);
    handler.sendErrorMessage(L.LANG_UNKNOWN_ERROR);
    return false;
  }
  if (row[0] === null) {
    // 2FA not enabled
    handler.sendErrorMessage(L.LANG_2FA_NOT_SETUP);
    return false;
  }
  let secret: Uint8Array | null = row[0] instanceof Uint8Array ? row[0] : new Uint8Array(0);
  if (token) {
    if (masterKey.value) {
      secret = await AEDecrypt(secret, masterKey.value);
      if (!secret) {
        logError("server", `Account ${accountId} has invalid ciphertext in TOTP token.`);
        handler.sendErrorMessage(L.LANG_UNKNOWN_ERROR);
        return false;
      }
    }
    if (TOTP.ValidateToken(secret, token)) {
      await executeStatement(LoginDatabase(), LOGIN_UPD_ACCOUNT_TOTP_SECRET, null, accountId);
      handler.sendSysMessage(L.LANG_2FA_REMOVE_COMPLETE);
      return true;
    }
    handler.sendSysMessage(L.LANG_2FA_INVALID_TOKEN);
  }
  handler.sendErrorMessage(L.LANG_2FA_REMOVE_NEED_TOKEN);
  return false;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountAddonCommand */
async function HandleAccountAddonCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) {
    handler.sendErrorMessage(L.LANG_CMD_SYNTAX);
    return false;
  }
  const exp = strtok(args)[0];
  const accountId = handler.getSession()!.getAccountId();
  const expansion = stringTo(exp, 0, 255);
  if (!expansion || expansion > sWorld().getIntConfig(ServerConfig.CONFIG_EXPANSION)) {
    handler.sendErrorMessage(L.LANG_IMPROPER_VALUE);
    return false;
  }
  await executeStatement(LoginDatabase(), LOGIN_UPD_EXPANSION, expansion, accountId);
  handler.pSendSysMessage(L.LANG_ACCOUNT_ADDON, expansion);
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountCreateCommand */
async function HandleAccountCreateCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) return false;
  const [accountName, password, email] = strtok(args);
  if (!accountName || !password) return false;
  const result = await createAccount(LoginDatabase(), accountName, password, email ?? "", sWorld().getIntConfig(ServerConfig.CONFIG_EXPANSION));
  switch (result) {
    case AccountOpResult.Ok: {
      handler.pSendSysMessage(L.LANG_ACCOUNT_CREATED, accountName);
      const session = handler.getSession();
      if (session) log("server", `Account: ${session.getAccountId()} (IP: ${session.getRemoteAddress()}) Character:[${session.getPlayerName()}] Change Password.`);
      break;
    }
    case AccountOpResult.NameTooLong:
      handler.sendErrorMessage(L.LANG_ACCOUNT_TOO_LONG);
      return false;
    case AccountOpResult.PassTooLong:
      handler.sendErrorMessage(L.LANG_ACCOUNT_PASS_TOO_LONG);
      return false;
    case AccountOpResult.NameAlreadyExists:
      handler.sendErrorMessage(L.LANG_ACCOUNT_ALREADY_EXIST);
      return false;
    case AccountOpResult.DbInternalError:
      handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_CREATED_SQL_ERROR, accountName);
      return false;
    default:
      handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_CREATED, accountName);
      return false;
  }
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountDeleteCommand */
async function HandleAccountDeleteCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) return false;
  const account = strtok(args)[0];
  if (!account) return false;
  const accountName = utf8ToUpperOnlyLatin(account);
  const accountId = await getId(LoginDatabase(), accountName);
  if (!accountId) {
    handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, accountName);
    return false;
  }
  // can delete only for account with less security; this is also reject self apply in fact
  if (await handler.hasLowerSecurityAccount(null, accountId, true)) return false;
  const result = await deleteAccount(LoginDatabase(), CharacterDatabase(), accountId, {
    kickCharacter: async (guid) => {
      const player = ObjectAccessor.FindConnectedPlayer(BigInt(guid));
      if (player) {
        const session = player.getSession();
        session.kickPlayer("Delete account");
        await session.disconnect();
      }
    },
    deleteCharacter: async (guid, owner) => {
      await DeleteFromDB({ characters: CharacterDatabase(), login: LoginDatabase() }, guid, owner, false, true);
    },
  });
  switch (result) {
    case AccountOpResult.Ok:
      handler.pSendSysMessage(L.LANG_ACCOUNT_DELETED, accountName);
      break;
    case AccountOpResult.NameNotExist:
      handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, accountName);
      return false;
    case AccountOpResult.DbInternalError:
      handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_DELETED_SQL_ERROR, accountName);
      return false;
    default:
      handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_DELETED, accountName);
      return false;
  }
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountOnlineListCommand */
async function HandleAccountOnlineListCommand(handler: ChatHandler, _args: string): Promise<boolean> {
  const result = await queryFields(CharacterDatabase(), CHAR_SEL_CHARACTER_ONLINE);
  if (result.length === 0) {
    handler.sendSysMessage(L.LANG_ACCOUNT_LIST_EMPTY);
    return true;
  }
  handler.sendSysMessage(L.LANG_ACCOUNT_LIST_BAR_HEADER);
  handler.sendSysMessage(L.LANG_ACCOUNT_LIST_HEADER);
  handler.sendSysMessage(L.LANG_ACCOUNT_LIST_BAR);
  for (const fieldsDB of result) {
    const name = String(fieldsDB[0]);
    const account = Number(fieldsDB[1]);
    const [fieldsLogin] = await queryFields(LoginDatabase(), LOGIN_SEL_ACCOUNT_INFO, account);
    if (fieldsLogin) {
      handler.pSendSysMessage(
        L.LANG_ACCOUNT_LIST_LINE,
        String(fieldsLogin[0]),
        name,
        String(fieldsLogin[1]),
        Number(fieldsDB[2]),
        Number(fieldsDB[3]),
        Number(fieldsLogin[3] ?? 0),
        Number(fieldsLogin[2] ?? 0),
      );
    } else {
      handler.pSendSysMessage(L.LANG_ACCOUNT_LIST_ERROR, name);
    }
  }
  handler.sendSysMessage(L.LANG_ACCOUNT_LIST_BAR);
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountRemoveLockCountryCommand */
async function HandleAccountRemoveLockCountryCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) {
    handler.sendErrorMessage(L.LANG_CMD_SYNTAX);
    return false;
  }
  const account = strtok(args)[0];
  if (!account) return false;
  const accountName = utf8ToUpperOnlyLatin(account);
  const accountId = await getId(LoginDatabase(), accountName);
  if (!accountId) {
    handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, accountName);
    return false;
  }
  await executeStatement(LoginDatabase(), LOGIN_UPD_ACCOUNT_LOCK_COUNTRY, "00", accountId);
  handler.pSendSysMessage(L.LANG_COMMAND_ACCLOCKUNLOCKED);
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountLockCountryCommand */
async function HandleAccountLockCountryCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) {
    handler.sendErrorMessage(L.LANG_USE_BOL);
    return false;
  }
  const param = args;
  if (param === "on") {
    // `sIPLocation` has no IP2Location data loaded in this server.
    handler.sendErrorMessage("No IP2Location information - account not locked");
    return false;
  } else if (param === "off") {
    await executeStatement(LoginDatabase(), LOGIN_UPD_ACCOUNT_LOCK_COUNTRY, "00", handler.getSession()!.getAccountId());
    handler.pSendSysMessage(L.LANG_COMMAND_ACCLOCKUNLOCKED);
  }
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountLockIpCommand */
async function HandleAccountLockIpCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) {
    handler.sendErrorMessage(L.LANG_USE_BOL);
    return false;
  }
  const param = args;
  let locked: boolean | null = null;
  if (param === "on") {
    locked = true;
    handler.pSendSysMessage(L.LANG_COMMAND_ACCLOCKLOCKED);
  } else if (param === "off") {
    locked = false;
    handler.pSendSysMessage(L.LANG_COMMAND_ACCLOCKUNLOCKED);
  }
  // The C++ executes the statement even for another word, with the lock value left unbound.
  await executeStatement(LoginDatabase(), LOGIN_UPD_ACCOUNT_LOCK, locked === null ? null : locked ? 1 : 0, handler.getSession()!.getAccountId());
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountPasswordCommand */
async function HandleAccountPasswordCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) {
    handler.sendErrorMessage(L.LANG_CMD_SYNTAX);
    return false;
  }
  const [oldPassword, newPassword, passwordConfirmation] = strtok(args);
  if (!oldPassword || !newPassword || !passwordConfirmation) {
    handler.sendErrorMessage(L.LANG_CMD_SYNTAX);
    return false;
  }
  const accountId = handler.getSession()!.getAccountId();
  if (!(await checkPassword(LoginDatabase(), accountId, oldPassword))) {
    handler.sendErrorMessage(L.LANG_COMMAND_WRONGOLDPASSWORD);
    return false;
  }
  if (newPassword !== passwordConfirmation) {
    handler.sendErrorMessage(L.LANG_NEW_PASSWORDS_NOT_MATCH);
    return false;
  }
  const result = await changePassword(LoginDatabase(), accountId, newPassword);
  switch (result) {
    case AccountOpResult.Ok:
      handler.sendSysMessage(L.LANG_COMMAND_PASSWORD);
      break;
    case AccountOpResult.PassTooLong:
      handler.sendErrorMessage(L.LANG_PASSWORD_TOO_LONG);
      return false;
    default:
      handler.sendErrorMessage(L.LANG_COMMAND_NOTCHANGEPASSWORD);
      return false;
  }
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountSet2FACommand */
async function HandleAccountSet2FACommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) {
    handler.sendErrorMessage(L.LANG_CMD_SYNTAX);
    return false;
  }
  const [account, secret] = strtok(args);
  if (!account || !secret) {
    handler.sendErrorMessage(L.LANG_CMD_SYNTAX);
    return false;
  }
  const accountName = utf8ToUpperOnlyLatin(account);
  const targetAccountId = await getId(LoginDatabase(), accountName);
  if (!targetAccountId) {
    handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, accountName);
    return false;
  }
  if (await handler.hasLowerSecurityAccount(null, targetAccountId, true)) return false;
  if (secret === "off") {
    await executeStatement(LoginDatabase(), LOGIN_UPD_ACCOUNT_TOTP_SECRET, null, targetAccountId);
    handler.pSendSysMessage(L.LANG_2FA_REMOVE_COMPLETE);
    return true;
  }
  const masterKey = await sSecretMgr.GetSecret(LoginDatabase(), SECRET_TOTP_MASTER_KEY);
  if (!masterKey.available) {
    handler.sendErrorMessage(L.LANG_2FA_COMMANDS_NOT_SETUP);
    return false;
  }
  const decoded = Base32.Decode(secret);
  if (!decoded) {
    handler.sendErrorMessage(L.LANG_2FA_SECRET_INVALID);
    return false;
  }
  if (128 < decoded.length + IV_SIZE_BYTES + TAG_SIZE_BYTES) {
    handler.sendErrorMessage(L.LANG_2FA_SECRET_TOO_LONG);
    return false;
  }
  const stored = masterKey.value ? await AEEncryptWithRandomIV(decoded, masterKey.value) : decoded;
  await executeStatement(LoginDatabase(), LOGIN_UPD_ACCOUNT_TOTP_SECRET, stored, targetAccountId);
  handler.pSendSysMessage(L.LANG_2FA_SECRET_SET_COMPLETE, accountName);
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountCommand */
async function HandleAccountCommand(handler: ChatHandler, _args: string): Promise<boolean> {
  const session = handler.getSession()!;
  handler.pSendSysMessage(L.LANG_ACCOUNT_LEVEL, session.getSecurity());
  if (session.hasPermission(RBAC_PERM_MAY_CHECK_OWN_EMAIL)) {
    const [row] = await queryFields(LoginDatabase(), LOGIN_GET_EMAIL_BY_ID, session.getAccountId());
    if (row) handler.pSendSysMessage(L.LANG_COMMAND_EMAIL_OUTPUT, String(row[0]));
  }
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountInfoCommand */
async function HandleAccountInfoCommand(handler: ChatHandler, account: AccountIdentifier | null): Promise<boolean> {
  let accountId: number;
  let accountName: string;
  const target = handler.getSelectedPlayerOrSelf();
  if (account) {
    accountId = account.id;
    accountName = account.name;
  } else if (target) {
    accountId = target.getSession().getAccountId();
    accountName = (await getName(LoginDatabase(), accountId)) ?? "";
  } else {
    handler.sendErrorMessage(L.LANG_CMD_SYNTAX);
    return false;
  }
  // The strong check rejects equal security, so inspecting your own account has to be exempted
  const session = handler.getSession();
  if (session && session.getAccountId() !== accountId && (await handler.hasLowerSecurityAccount(null, accountId, true))) return false;
  const [fields] = await queryFields(LoginDatabase(), LOGIN_SEL_ACCOUNT_INFO_DETAILED, realm.Id.Realm, accountId);
  if (!fields) {
    handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, accountName);
    return false;
  }
  accountName = String(fields[0]);
  const security = Number(fields[1] ?? 0);
  let eMail = String(fields[2] ?? "");
  let regMail = String(fields[3] ?? "");
  let lastIp = String(fields[4] ?? "");
  let lastLogin = String(fields[5] ?? "");
  let muteTime = Number(fields[6] ?? 0);
  const muteReason = String(fields[7] ?? "");
  const muteBy = String(fields[8] ?? "");
  const failedLogins = Number(fields[9] ?? 0);
  const locked = Number(fields[10] ?? 0);
  const OS = String(fields[11] ?? "");
  const expansion = Number(fields[12] ?? 0);
  let accountFlags = Number(fields[13] ?? 0) >>> 0;
  const joinDate = String(fields[14] ?? "");
  const totalTime = Number(fields[15] ?? 0);
  const lockCountry = String(fields[16] ?? "");
  // Empty unless the account is online, in which case it holds the address of the live connection
  let currentIp = "";
  let latency = 0;
  const targetSession = sWorldSessionMgr.FindSession(accountId);
  if (targetSession) {
    latency = targetSession.getLatency();
    muteTime = targetSession.muteTime;
    accountFlags = targetSession.getAccountFlags();
    currentIp = targetSession.getRemoteAddress();
  }
  if (!(!session || session.getSecurity() >= security)) {
    eMail = handler.getAcoreString(L.LANG_UNAUTHORIZED);
    regMail = handler.getAcoreString(L.LANG_UNAUTHORIZED);
    lastIp = handler.getAcoreString(L.LANG_UNAUTHORIZED);
    lastLogin = handler.getAcoreString(L.LANG_UNAUTHORIZED);
    if (currentIp) currentIp = handler.getAcoreString(L.LANG_UNAUTHORIZED);
  }
  let banTime = -1;
  let banReason = handler.getAcoreString(L.LANG_NO_REASON);
  let bannedBy = handler.getAcoreString(L.LANG_UNKNOWN);
  const [banFields] = await queryFields(LoginDatabase(), LOGIN_SEL_PINFO_BANS, accountId);
  if (banFields) {
    banTime = Number(banFields[1]) ? 0 : Number(banFields[0]);
    bannedBy = String(banFields[2]);
    banReason = String(banFields[3]);
  }
  handler.pSendSysMessage(L.LANG_PINFO_ACC_ACCOUNT, accountName, accountId, security);
  if (accountFlags) {
    handler.pSendSysMessage(L.LANG_ACCOUNT_FLAGS_PINFO);
    for (let i = 0; i < MAX_ACCOUNT_FLAG; ++i) if (accountFlags & ((1 << i) >>> 0)) handler.pSendSysMessage(L.LANG_SUBCMDS_LIST_ENTRY, accountFlagNames[i]!.full);
  }
  const now = Math.floor(Date.now() / 1000);
  if (banTime >= 0) {
    handler.pSendSysMessage(L.LANG_ACCOUNT_INFO_BANNED, banReason, banTime > 0 ? secsToTimeString(banTime - now, true) : handler.getAcoreString(L.LANG_PERMANENTLY), bannedBy);
  }
  // mutetime is only cleared once the muted player logs back in, so an expired mute can still be stored
  if (muteTime > now) handler.pSendSysMessage(L.LANG_PINFO_MUTED, muteReason, secsToTimeString(muteTime - now, true), muteBy);
  handler.pSendSysMessage(L.LANG_ACCOUNT_INFO_JOINDATE, joinDate);
  handler.pSendSysMessage(L.LANG_PINFO_ACC_LASTLOGIN, lastLogin, failedLogins);
  handler.pSendSysMessage(L.LANG_PINFO_ACC_OS, OS, latency);
  handler.pSendSysMessage(L.LANG_PINFO_ACC_REGMAILS, regMail, eMail);
  handler.pSendSysMessage(L.LANG_PINFO_ACC_IP, lastIp, locked ? handler.getAcoreString(L.LANG_YES) : handler.getAcoreString(L.LANG_NO));
  if (currentIp) handler.pSendSysMessage(L.LANG_ACCOUNT_INFO_CURRENT_IP, currentIp);
  // "00" is the default value meaning no country lock is set
  if (lockCountry !== "00") handler.pSendSysMessage(L.LANG_ACCOUNT_INFO_LOCK_COUNTRY, lockCountry);
  handler.pSendSysMessage(L.LANG_ACCOUNT_INFO_EXPANSION, expansion);
  handler.pSendSysMessage(L.LANG_PINFO_CHR_PLAYEDTIME, secsToTimeString(totalTime, true));
  const charResult = await queryFields(CharacterDatabase(), CHAR_SEL_ACCOUNT_INFO_CHARS, accountId);
  if (charResult.length === 0) {
    handler.pSendSysMessage(L.LANG_ACCOUNT_INFO_NO_CHARS);
    return true;
  }
  handler.pSendSysMessage(L.LANG_ACCOUNT_INFO_CHARS, charResult.length);
  const locale = handler.getSessionDbcLocale();
  for (const charFields of charResult) {
    const guid = Number(charFields[0]);
    const name = String(charFields[1]);
    const level = Number(charFields[2]);
    const race = sChrRacesStore.lookupEntry(Number(charFields[3]));
    const cls = sChrClassesStore.lookupEntry(Number(charFields[4]));
    const online = Number(charFields[5]) !== 0;
    handler.pSendSysMessage(
      L.LANG_ACCOUNT_INFO_CHAR_ENTRY,
      handler.playerLink(name),
      online ? "" : handler.getAcoreString(L.LANG_ACCOUNT_INFO_CHAR_OFFLINE),
      guid,
      level,
      race ? (race.name[locale] ?? "") : handler.getAcoreString(L.LANG_UNKNOWN),
      cls ? (cls.name[locale] ?? "") : handler.getAcoreString(L.LANG_UNKNOWN),
    );
  }
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountSetAddonCommand */
async function HandleAccountSetAddonCommand(handler: ChatHandler, args: string): Promise<boolean> {
  const tokens = strtok(args);
  const account = tokens[0];
  let exp = tokens[1];
  if (!account) return false;
  let accountName: string;
  let accountId: number;
  if (!exp) {
    const player = handler.getSelectedPlayer();
    if (!player) return false;
    accountId = player.getSession().getAccountId();
    accountName = (await getName(LoginDatabase(), accountId)) ?? "";
    exp = account;
  } else {
    accountName = utf8ToUpperOnlyLatin(account);
    accountId = await getId(LoginDatabase(), accountName);
    if (!accountId) {
      handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, accountName);
      return false;
    }
  }
  // Let set addon state only for lesser (strong) security level or to self account
  const session = handler.getSession();
  if (session && session.getAccountId() !== accountId && (await handler.hasLowerSecurityAccount(null, accountId, true))) return false;
  const expansion = stringTo(exp, 0, 255);
  if (!expansion || expansion > sWorld().getIntConfig(ServerConfig.CONFIG_EXPANSION)) return false;
  await executeStatement(LoginDatabase(), LOGIN_UPD_EXPANSION, expansion, accountId);
  handler.pSendSysMessage(L.LANG_ACCOUNT_SETADDON, accountName, accountId, expansion);
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountSetGmLevelCommand */
async function HandleAccountSetGmLevelCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) return false;
  const [arg1, arg2, arg3] = strtok(args);
  let targetAccountName = "";
  let isAccountNameGiven = true;
  if (arg1 && !arg3) {
    if (!handler.getSelectedPlayer()) return false;
    isAccountNameGiven = false;
  }
  // Check for second parameter
  if (!isAccountNameGiven && !arg2) return false;
  // Check for account
  if (isAccountNameGiven) targetAccountName = utf8ToUpperOnlyLatin(arg1 ?? "");
  // Check for invalid specified GM level.
  const gm = (isAccountNameGiven ? stringTo(arg2, -0x80000000, 0x7fffffff) : stringTo(arg1, -0x80000000, 0x7fffffff)) ?? 0;
  if (gm >>> 0 > SEC_CONSOLE) {
    handler.sendErrorMessage(L.LANG_BAD_VALUE);
    return false;
  }
  const login = LoginDatabase();
  const targetAccountId = isAccountNameGiven ? await getId(login, targetAccountName) : handler.getSelectedPlayer()!.getSession().getAccountId();
  const gmRealmID = (isAccountNameGiven ? stringTo(arg3, -0x80000000, 0x7fffffff) : stringTo(arg2, -0x80000000, 0x7fffffff)) ?? 0;
  const session = handler.getSession();
  const playerSecurity = session ? await getSecurity(login, session.getAccountId(), gmRealmID) : SEC_CONSOLE;
  // can set security level only for target with less security and to less security that we have
  const targetSecurity = await getSecurity(login, targetAccountId, gmRealmID);
  if (targetSecurity >= playerSecurity || gm >= playerSecurity) {
    handler.sendErrorMessage(L.LANG_YOURS_SECURITY_IS_LOW);
    return false;
  }
  // Check and abort if the target gm has a higher rank on one of the realms and the new realm is -1
  if (gmRealmID === -1 && !isConsoleAccount(playerSecurity)) {
    const result = await queryFields(login, LOGIN_SEL_ACCOUNT_ACCESS_GMLEVEL_TEST, targetAccountId, gm & 0xff);
    if (result.length > 0) {
      handler.sendErrorMessage(L.LANG_YOURS_SECURITY_IS_LOW);
      return false;
    }
  }
  // Check if provided gmRealmID has a negative value other than -1
  if (gmRealmID < -1) {
    handler.sendErrorMessage(L.LANG_INVALID_REALMID);
    return false;
  }
  if (gmRealmID === -1) await executeStatement(login, LOGIN_DEL_ACCOUNT_ACCESS, targetAccountId);
  else await executeStatement(login, LOGIN_DEL_ACCOUNT_ACCESS_BY_REALM, targetAccountId, gmRealmID);
  if (gm !== 0) await executeStatement(login, LOGIN_INS_ACCOUNT_ACCESS, targetAccountId, gm & 0xff, gmRealmID);
  // An online session keeps the security it logged in with (`WorldSession::_security`), as in the C++.
  handler.pSendSysMessage(L.LANG_YOU_CHANGE_SECURITY, targetAccountName, gm);
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountSetPasswordCommand */
async function HandleAccountSetPasswordCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) return false;
  const [account, password, passwordConfirmation] = strtok(args);
  if (!account || !password || !passwordConfirmation) return false;
  const accountName = utf8ToUpperOnlyLatin(account);
  const targetAccountId = await getId(LoginDatabase(), accountName);
  if (!targetAccountId) {
    handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, accountName);
    return false;
  }
  // can set password only for target with less security; this is also reject self apply in fact
  if (await handler.hasLowerSecurityAccount(null, targetAccountId, true)) return false;
  if (password !== passwordConfirmation) {
    handler.sendErrorMessage(L.LANG_NEW_PASSWORDS_NOT_MATCH);
    return false;
  }
  const result = await changePassword(LoginDatabase(), targetAccountId, password);
  switch (result) {
    case AccountOpResult.Ok:
      handler.sendSysMessage(L.LANG_COMMAND_PASSWORD);
      break;
    case AccountOpResult.NameNotExist:
      handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, accountName);
      return false;
    case AccountOpResult.PassTooLong:
      handler.sendErrorMessage(L.LANG_PASSWORD_TOO_LONG);
      return false;
    default:
      handler.sendErrorMessage(L.LANG_COMMAND_NOTCHANGEPASSWORD);
      return false;
  }
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::ParseAccountFlagBit */
function ParseAccountFlagBit(input: string): number | null {
  for (let i = 0; i < MAX_ACCOUNT_FLAG; ++i) {
    if (stringEqualI(input, accountFlagNames[i]!.full) || stringEqualI(input, accountFlagNames[i]!.shortName)) return i;
  }
  return null;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountFlagListCommand */
async function HandleAccountFlagListCommand(handler: ChatHandler, account: AccountIdentifier | null): Promise<boolean> {
  let accountId: number;
  let accountName: string;
  const session = handler.getSession();
  if (account) {
    accountId = account.id;
    accountName = account.name;
  } else if (session) {
    accountId = session.getAccountId();
    accountName = (await getName(LoginDatabase(), accountId)) ?? "";
  } else {
    handler.sendErrorMessage(L.LANG_CMD_SYNTAX);
    return false;
  }
  if (await handler.hasLowerSecurityAccount(null, accountId, true)) return false;
  let flags: number;
  const targetSession = sWorldSessionMgr.FindSession(accountId);
  if (targetSession) {
    flags = targetSession.getAccountFlags();
  } else {
    const [row] = await queryFields(LoginDatabase(), LOGIN_SEL_ACCOUNT_FLAG, accountId);
    if (!row) {
      handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, accountName);
      return false;
    }
    flags = Number(row[0]) >>> 0;
  }
  if (!flags) {
    handler.pSendSysMessage(L.LANG_ACCOUNT_FLAG_LIST_EMPTY, accountName, accountId);
    return true;
  }
  handler.pSendSysMessage(L.LANG_ACCOUNT_FLAG_LIST_HEADER, accountName, accountId);
  for (let i = 0; i < MAX_ACCOUNT_FLAG; ++i) if (flags & ((1 << i) >>> 0)) handler.pSendSysMessage(L.LANG_SUBCMDS_LIST_ENTRY, accountFlagNames[i]!.full);
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::ChangeAccountFlag */
async function ChangeAccountFlag(handler: ChatHandler, account: AccountIdentifier, flagArg: string, add: boolean): Promise<boolean> {
  if (await handler.hasLowerSecurityAccount(null, account.id, true)) return false;
  const bit = ParseAccountFlagBit(flagArg);
  if (bit === null) {
    handler.sendErrorMessage(L.LANG_ACCOUNT_FLAG_INVALID, flagArg);
    return false;
  }
  // ACCOUNT_FLAG_GM is handled by GMLevel and should not be allowed to set manually
  const flag = (1 << bit) >>> 0;
  if (flag & ACCOUNT_FLAG_GM) {
    handler.sendErrorMessage(L.LANG_ACCOUNT_FLAG_RESERVED);
    return false;
  }
  const session = sWorldSessionMgr.FindSession(account.id);
  if (session) session.updateAccountFlag(flag, !add);
  else await executeStatement(LoginDatabase(), `UPDATE account SET Flags = Flags ${add ? "|" : "& ~"} ? WHERE id = ?`, flag, account.id);
  handler.pSendSysMessage(add ? L.LANG_ACCOUNT_FLAG_ADDED : L.LANG_ACCOUNT_FLAG_REMOVED, accountFlagNames[bit]!.full, account.name, account.id);
  return true;
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountFlagAddCommand */
function HandleAccountFlagAddCommand(handler: ChatHandler, account: AccountIdentifier, flagArg: string): Promise<boolean> {
  return ChangeAccountFlag(handler, account, flagArg, true);
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountFlagRemoveCommand */
function HandleAccountFlagRemoveCommand(handler: ChatHandler, account: AccountIdentifier, flagArg: string): Promise<boolean> {
  return ChangeAccountFlag(handler, account, flagArg, false);
}

/** @ac scripts/Commands/cs_account.cpp account_commandscript::HandleAccountSetEmailCommand */
async function HandleAccountSetEmailCommand(handler: ChatHandler, account: AccountIdentifier, email: string, emailConfirmation: string): Promise<boolean> {
  const accountName = utf8ToUpperOnlyLatin(account.name);
  const targetAccountId = account.id;
  if (!targetAccountId) {
    handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, accountName);
    return false;
  }
  if (email !== emailConfirmation) {
    handler.sendErrorMessage(L.LANG_NEW_EMAILS_NOT_MATCH);
    return false;
  }
  const result = await changeEmail(LoginDatabase(), targetAccountId, email);
  switch (result) {
    case AccountOpResult.Ok:
      handler.sendSysMessage(L.LANG_COMMAND_EMAIL);
      break;
    case AccountOpResult.NameNotExist:
      handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, accountName);
      return false;
    case AccountOpResult.EmailTooLong:
      handler.sendErrorMessage(L.LANG_EMAIL_TOO_LONG);
      return false;
    default:
      handler.sendErrorMessage(L.LANG_COMMAND_NOTCHANGEEMAIL);
      return false;
  }
  return true;
}

/** @ac scripts/Commands/cs_account.cpp AddSC_account_commandscript */
export function AddSC_account_commandscript(): void {
  registerCommandScript(GetCommands);
}
