import { eq } from "drizzle-orm";
import type { Db } from "../../database/database.ts";
import { executeStatement, queryFields } from "../../database/database.ts";
import { account } from "../../database/schema/auth.ts";
import { characters as charactersTable } from "../../database/schema/characters.ts";
import { checkLogin, makeRegistrationData, upperLatin } from "../../crypto/srp6.ts";
import {
  LOGIN_DEL_ACCOUNT,
  LOGIN_DEL_ACCOUNT_ACCESS,
  LOGIN_DEL_ACCOUNT_ACCESS_BY_REALM,
  LOGIN_DEL_ACCOUNT_BANNED,
  LOGIN_DEL_ACCOUNT_MUTED,
  LOGIN_DEL_REALM_CHARACTERS,
  LOGIN_GET_ACCOUNT_ACCESS_GMLEVEL,
  LOGIN_GET_ACCOUNT_ID_BY_USERNAME,
  LOGIN_GET_GMLEVEL_BY_REALMID,
  LOGIN_GET_USERNAME_BY_ID,
  LOGIN_INS_ACCOUNT_ACCESS,
  LOGIN_SEL_ACCOUNT_BY_ID,
  LOGIN_SEL_CHECK_PASSWORD,
  LOGIN_SEL_RBAC_DEFAULT_PERMISSIONS,
  LOGIN_UPD_EMAIL,
  LOGIN_UPD_LOGON,
  LOGIN_UPD_USERNAME,
} from "../../gen/LoginDatabase.gen.ts";
import { CHAR_DEL_ACCOUNT_DATA, CHAR_DEL_CHARACTER_BAN, CHAR_DEL_TUTORIALS, CHAR_SEL_CHARS_BY_ACCOUNT_ID, CHAR_SEL_SUM_CHARS } from "../../gen/CharacterDatabase.gen.ts";
import { log, logError } from "../../log.ts";
import { MAX_ACCOUNT_STR, MAX_EMAIL_STR, MAX_PASS_STR } from "../../shared/limits.ts";
import { SEC_ADMINISTRATOR, SEC_CONSOLE, SEC_GAMEMASTER, SEC_PLAYER } from "../../shared/SharedDefines.ts";
import { realm } from "../../shared/Realms/Realm.ts";
import { getMSTime, getMSTimeDiffToNow } from "../time/timer.ts";
import { RBACData, RBACPermission, type RBACPermissionSource } from "./RBAC.ts";

export const AccountOpResult = {
  Ok: "ok",
  NameTooLong: "name-too-long",
  PassTooLong: "pass-too-long",
  EmailTooLong: "email-too-long",
  NameAlreadyExists: "name-already-exists",
  NameNotExist: "name-not-exist",
  DbInternalError: "db-internal-error",
} as const;

export type AccountOpResult = (typeof AccountOpResult)[keyof typeof AccountOpResult];

function utf8Length(value: string): number {
  let length = 0;
  for (const _char of value) {
    length += 1;
  }
  return length;
}

/** @ac game/Accounts/AccountMgr.cpp AccountMgr::CreateAccount */
export async function createAccount(db: Db, username: string, password: string, email = "", expansion = 2): Promise<AccountOpResult> {
  if (utf8Length(username) > MAX_ACCOUNT_STR) {
    return AccountOpResult.NameTooLong;
  }
  if (utf8Length(password) > MAX_PASS_STR) {
    return AccountOpResult.PassTooLong;
  }
  if (utf8Length(email) > MAX_EMAIL_STR) {
    return AccountOpResult.EmailTooLong;
  }
  const name = upperLatin(username);
  const pass = upperLatin(password);
  const mail = upperLatin(email);
  const [existing] = await db.select({ id: account.id }).from(account).where(eq(account.username, name));
  if (existing) {
    return AccountOpResult.NameAlreadyExists;
  }
  const registration = makeRegistrationData(name, pass);
  try {
    // LOGIN_INS_ACCOUNT, then LOGIN_INS_REALM_CHARACTERS_INIT.
    await db.insert(account).values({
      username: name,
      salt: registration.salt,
      verifier: registration.verifier,
      expansion,
      reg_mail: mail,
      email: mail,
      joindate: new Date(),
    });
    await db.$client.unsafe(
      "INSERT INTO realmcharacters (realmid, acctid, numchars) SELECT realmlist.id, account.id, 0 FROM realmlist, account LEFT JOIN realmcharacters ON acctid=account.id WHERE acctid IS NULL",
    );
  } catch {
    return AccountOpResult.DbInternalError;
  }
  return AccountOpResult.Ok;
}

/** @ac game/Accounts/AccountMgr.cpp AccountMgr::ChangeEmail */
export async function changeEmail(db: Db, accountId: number, newEmail: string): Promise<AccountOpResult> {
  if ((await getName(db, accountId)) === null) {
    return AccountOpResult.NameNotExist;
  }
  if (utf8Length(newEmail) > MAX_EMAIL_STR) {
    return AccountOpResult.EmailTooLong;
  }
  await executeStatement(db, LOGIN_UPD_EMAIL, upperLatin(newEmail), accountId);
  return AccountOpResult.Ok;
}

/**
 * The world-side hooks `DeleteAccount` needs: kick the online character and remove each character row
 * (`Player::DeleteFromDB`).
 */
export type AccountDeleteHooks = {
  kickCharacter: (guid: number) => Promise<void>;
  deleteCharacter: (guid: number, accountId: number) => Promise<void>;
};

/** @ac game/Accounts/AccountMgr.cpp AccountMgr::DeleteAccount */
export async function deleteAccount(login: Db, characters: Db, accountId: number, hooks: AccountDeleteHooks): Promise<AccountOpResult> {
  if ((await queryFields(login, LOGIN_SEL_ACCOUNT_BY_ID, accountId)).length === 0) {
    return AccountOpResult.NameNotExist;
  }
  for (const row of await queryFields(characters, CHAR_SEL_CHARS_BY_ACCOUNT_ID, accountId)) {
    const guid = Number(row[0]);
    await hooks.kickCharacter(guid);
    await hooks.deleteCharacter(guid, accountId);
  }
  // table realm specific but common for all characters of account for realm
  await executeStatement(characters, CHAR_DEL_TUTORIALS, accountId);
  await executeStatement(characters, CHAR_DEL_ACCOUNT_DATA, accountId);
  await executeStatement(characters, CHAR_DEL_CHARACTER_BAN, accountId);
  await login.$client.begin(async (tx) => {
    await tx.unsafe(LOGIN_DEL_ACCOUNT, [accountId]);
    await tx.unsafe(LOGIN_DEL_ACCOUNT_ACCESS, [accountId]);
    await tx.unsafe(LOGIN_DEL_REALM_CHARACTERS, [accountId]);
    await tx.unsafe(LOGIN_DEL_ACCOUNT_BANNED, [accountId]);
    await tx.unsafe(LOGIN_DEL_ACCOUNT_MUTED, [accountId]);
  });
  return AccountOpResult.Ok;
}

/** @ac game/Accounts/AccountMgr.cpp AccountMgr::ChangeUsername */
export async function changeUsername(db: Db, accountId: number, newUsername: string, newPassword: string): Promise<AccountOpResult> {
  if ((await queryFields(db, LOGIN_SEL_ACCOUNT_BY_ID, accountId)).length === 0) {
    return AccountOpResult.NameNotExist;
  }
  if (utf8Length(newUsername) > MAX_ACCOUNT_STR) {
    return AccountOpResult.NameTooLong;
  }
  if (utf8Length(newPassword) > MAX_PASS_STR) {
    return AccountOpResult.PassTooLong;
  }
  const name = upperLatin(newUsername);
  const pass = upperLatin(newPassword);
  await executeStatement(db, LOGIN_UPD_USERNAME, name, accountId);
  const registration = makeRegistrationData(name, pass);
  await executeStatement(db, LOGIN_UPD_LOGON, registration.salt, registration.verifier, accountId);
  return AccountOpResult.Ok;
}

/** @ac game/Accounts/AccountMgr.cpp AccountMgr::ChangePassword */
export async function changePassword(db: Db, accountId: number, newPassword: string): Promise<AccountOpResult> {
  const username = await getName(db, accountId);
  if (username === null) {
    return AccountOpResult.NameNotExist;
  }
  if (utf8Length(newPassword) > MAX_PASS_STR) {
    return AccountOpResult.PassTooLong;
  }
  const registration = makeRegistrationData(upperLatin(username), upperLatin(newPassword));
  await executeStatement(db, LOGIN_UPD_LOGON, registration.salt, registration.verifier, accountId);
  return AccountOpResult.Ok;
}

/** @ac game/Accounts/AccountMgr.cpp AccountMgr::GetId */
export async function getId(db: Db, username: string): Promise<number> {
  const [row] = await queryFields(db, LOGIN_GET_ACCOUNT_ID_BY_USERNAME, username);
  return row ? Number(row[0]) : 0;
}

/** @ac game/Accounts/AccountMgr.cpp AccountMgr::GetSecurity */
export async function getSecurity(db: Db, accountId: number, realmId?: number): Promise<number> {
  const [row] =
    realmId === undefined
      ? await queryFields(db, LOGIN_GET_ACCOUNT_ACCESS_GMLEVEL, accountId)
      : await queryFields(db, LOGIN_GET_GMLEVEL_BY_REALMID, accountId, realmId);
  return row ? Number(row[0]) : SEC_PLAYER;
}

/** @ac game/Accounts/AccountMgr.cpp AccountMgr::GetName */
export async function getName(db: Db, accountId: number): Promise<string | null> {
  const [row] = await queryFields(db, LOGIN_GET_USERNAME_BY_ID, accountId);
  return row ? String(row[0]) : null;
}

/** @ac game/Accounts/AccountMgr.cpp AccountMgr::CheckPassword */
export async function checkPassword(db: Db, accountId: number, password: string): Promise<boolean> {
  const username = await getName(db, accountId);
  if (username === null) {
    return false;
  }
  const [row] = await queryFields(db, LOGIN_SEL_CHECK_PASSWORD, accountId);
  if (!row) {
    return false;
  }
  return checkLogin(upperLatin(username), upperLatin(password), toBytes(row[0]), toBytes(row[1]));
}

/** @ac game/Accounts/AccountMgr.cpp AccountMgr::GetCharactersCount */
export async function getCharactersCount(characters: Db, accountId: number): Promise<number> {
  const [row] = await queryFields(characters, CHAR_SEL_SUM_CHARS, accountId);
  return row ? Number(row[0]) : 0;
}

/** @ac game/Accounts/AccountMgr.cpp AccountMgr::IsPlayerAccount */
export function isPlayerAccount(gmlevel: number): boolean {
  return gmlevel === SEC_PLAYER;
}

/** @ac game/Accounts/AccountMgr.cpp AccountMgr::IsGMAccount */
export function isGMAccount(gmlevel: number): boolean {
  return gmlevel >= SEC_GAMEMASTER;
}

/** @ac game/Accounts/AccountMgr.cpp AccountMgr::IsAdminAccount */
export function isAdminAccount(gmlevel: number): boolean {
  return gmlevel >= SEC_ADMINISTRATOR && gmlevel <= SEC_CONSOLE;
}

/** @ac game/Accounts/AccountMgr.cpp AccountMgr::IsConsoleAccount */
export function isConsoleAccount(gmlevel: number): boolean {
  return gmlevel === SEC_CONSOLE;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  return new Uint8Array(0);
}

/** `sAccountMgr`: the RBAC permission table, loaded once from `acore_auth` (`AccountMgr::LoadRBAC`). */
export class AccountMgr implements RBACPermissionSource {
  private permissions = new Map<number, RBACPermission>();
  private defaultPermissions = new Map<number, Set<number>>();
  private static readonly EMPTY: ReadonlySet<number> = new Set();

  /** @ac game/Accounts/AccountMgr.cpp AccountMgr::HasPermission */
  async hasPermission(db: Db, accountId: number, permission: number, realmId: number): Promise<boolean> {
    if (!accountId) {
      logError("server", "AccountMgr::HasPermission: Wrong accountId 0");
      return false;
    }
    const rbac = new RBACData(accountId, "", realmId, await getSecurity(db, accountId, realmId), this, db);
    await rbac.loadFromDB();
    return rbac.hasPermission(permission);
  }

  /** @ac game/Accounts/AccountMgr.cpp AccountMgr::UpdateAccountAccess */
  async updateAccountAccess(db: Db, rbac: RBACData | null, accountId: number, securityLevel: number, realmId: number): Promise<void> {
    if (rbac && securityLevel !== rbac.getSecurityLevel()) {
      await rbac.setSecurityLevel(securityLevel);
    }
    await db.$client.begin(async (tx) => {
      // Delete old security level from DB
      if (realmId === -1) {
        await tx.unsafe(LOGIN_DEL_ACCOUNT_ACCESS, [accountId]);
      } else {
        await tx.unsafe(LOGIN_DEL_ACCOUNT_ACCESS_BY_REALM, [accountId, realmId]);
      }
      // Add new security level
      if (securityLevel) {
        await tx.unsafe(LOGIN_INS_ACCOUNT_ACCESS, [accountId, securityLevel, realmId]);
      }
    });
  }

  /** @ac game/Accounts/AccountMgr.cpp AccountMgr::LoadRBAC */
  async loadRBAC(db: Db): Promise<void> {
    this.clearRBAC();
    const oldMSTime = getMSTime();
    let count1 = 0;
    let count2 = 0;
    let count3 = 0;
    const permissions = await queryFields(db, "SELECT id, name FROM rbac_permissions");
    if (permissions.length === 0) {
      log("server", ">> Loaded 0 RBAC permissions. DB table `rbac_permissions` is empty.");
      return;
    }
    for (const row of permissions) {
      const id = Number(row[0]);
      this.permissions.set(id, new RBACPermission(id, String(row[1])));
      ++count1;
    }
    const linked = await queryFields(db, "SELECT id, linkedId FROM rbac_linked_permissions ORDER BY id ASC");
    for (const row of linked) {
      const permissionId = Number(row[0]);
      const linkedPermissionId = Number(row[1]);
      if (linkedPermissionId === permissionId) {
        logError("sql", `RBAC Permission ${permissionId} has itself as linked permission. Ignored`);
        continue;
      }
      this.permissions.get(permissionId)?.addLinkedPermission(linkedPermissionId);
      ++count2;
    }
    log("server", `>> Loaded ${count1} RBAC permissions and ${count2} linked permissions in ${getMSTimeDiffToNow(oldMSTime)} ms`);
    const defaults = await queryFields(db, LOGIN_SEL_RBAC_DEFAULT_PERMISSIONS, realm.Id.Realm);
    if (defaults.length === 0) {
      log("server", ">> Loaded 0 RBAC default permissions. DB table `rbac_default_permissions` is empty.");
      return;
    }
    for (const row of defaults) {
      const secId = Number(row[0]);
      let set = this.defaultPermissions.get(secId);
      if (!set) {
        set = new Set();
        this.defaultPermissions.set(secId, set);
      }
      set.add(Number(row[1]));
      ++count3;
    }
    log("server", `>> Loaded ${count3} RBAC default permissions in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** @ac game/Accounts/AccountMgr.cpp AccountMgr::GetRBACPermission */
  getRBACPermission(permissionId: number): RBACPermission | null {
    return this.permissions.get(permissionId) ?? null;
  }

  getRBACPermissionList(): ReadonlyMap<number, RBACPermission> {
    return this.permissions;
  }

  /** @ac game/Accounts/AccountMgr.cpp AccountMgr::GetRBACDefaultPermissions */
  getRBACDefaultPermissions(secLevel: number): ReadonlySet<number> {
    return this.defaultPermissions.get(secLevel) ?? AccountMgr.EMPTY;
  }

  /** @ac game/Accounts/AccountMgr.cpp AccountMgr::ClearRBAC */
  private clearRBAC(): void {
    this.permissions = new Map();
    this.defaultPermissions = new Map();
  }

  /** @ac game/Accounts/AccountMgr.cpp AccountMgr::AddPermissionForTest */
  addPermissionForTest(permissionId: number, name: string): void {
    if (!this.permissions.has(permissionId)) {
      this.permissions.set(permissionId, new RBACPermission(permissionId, name));
    }
  }

  /** @ac game/Accounts/AccountMgr.cpp AccountMgr::AddLinkedPermissionForTest */
  addLinkedPermissionForTest(permissionId: number, linkedPermissionId: number): void {
    this.permissions.get(permissionId)?.addLinkedPermission(linkedPermissionId);
  }

  /** @ac game/Accounts/AccountMgr.cpp AccountMgr::AddDefaultPermissionForTest */
  addDefaultPermissionForTest(secLevel: number, permissionId: number): void {
    let set = this.defaultPermissions.get(secLevel);
    if (!set) {
      set = new Set();
      this.defaultPermissions.set(secLevel, set);
    }
    set.add(permissionId);
  }

  /** @ac game/Accounts/AccountMgr.cpp AccountMgr::ClearPermissionsForTest */
  clearPermissionsForTest(): void {
    this.clearRBAC();
  }
}

export const sAccountMgr = new AccountMgr();

/** Characters on an account (the `characters` rows `DeleteAccount` walks). */
export async function accountCharacterGuids(characters: Db, accountId: number): Promise<number[]> {
  const rows = await characters.select({ guid: charactersTable.guid }).from(charactersTable).where(eq(charactersTable.account, accountId));
  return rows.map((row) => row.guid);
}
