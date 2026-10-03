/**
 * Role Based Access Control (`RBAC.h` / `RBAC.cpp`).
 *
 * Global permissions are computed as role grants + account grants − role denies − account denies. Roles are
 * permissions with linked permissions; `ExpandPermissions` follows the links.
 */
import type { Db } from "../../database/database.ts";
import { executeStatementAsync, queryFields } from "../../database/database.ts";
import { LOGIN_DEL_RBAC_ACCOUNT_PERMISSION, LOGIN_INS_RBAC_ACCOUNT_PERMISSION, LOGIN_SEL_RBAC_ACCOUNT_PERMISSIONS } from "../../gen/LoginDatabase.gen.ts";
import { logDebug, logTrace } from "../../log.ts";
import {
  RBAC_CANT_ADD_ALREADY_ADDED,
  RBAC_CANT_REVOKE_NOT_IN_LIST,
  RBAC_ID_DOES_NOT_EXISTS,
  RBAC_IN_DENIED_LIST,
  RBAC_IN_GRANTED_LIST,
  RBAC_OK,
} from "./RBACDefines.ts";

export type RBACCommandResult =
  | typeof RBAC_OK
  | typeof RBAC_CANT_ADD_ALREADY_ADDED
  | typeof RBAC_CANT_REVOKE_NOT_IN_LIST
  | typeof RBAC_IN_GRANTED_LIST
  | typeof RBAC_IN_DENIED_LIST
  | typeof RBAC_ID_DOES_NOT_EXISTS;

/** `RBACPermissionContainer` (`std::set<uint32>`). */
export type RBACPermissionContainer = Set<number>;

/** The permission table `RBACData` resolves ids and links through (`sAccountMgr`). */
export type RBACPermissionSource = {
  getRBACPermission(permissionId: number): RBACPermission | null;
  getRBACDefaultPermissions(secLevel: number): ReadonlySet<number>;
};

/** @ac game/Accounts/RBAC.h rbac::GetDebugPermissionString */
export function getDebugPermissionString(perms: Iterable<number>): string {
  return [...perms].join(", ");
}

/** @ac game/Accounts/RBAC.h rbac::RBACPermission */
export class RBACPermission {
  private readonly perms: RBACPermissionContainer = new Set();

  constructor(
    private readonly id = 0,
    private readonly name = "",
  ) {}

  getName(): string {
    return this.name;
  }

  getId(): number {
    return this.id;
  }

  getLinkedPermissions(): ReadonlySet<number> {
    return this.perms;
  }

  addLinkedPermission(id: number): void {
    this.perms.add(id);
  }

  removeLinkedPermission(id: number): void {
    this.perms.delete(id);
  }
}

/** @ac game/Accounts/RBAC.h rbac::RBACData */
export class RBACData {
  private grantedPerms: RBACPermissionContainer = new Set();
  private deniedPerms: RBACPermissionContainer = new Set();
  private globalPerms: RBACPermissionContainer = new Set();

  constructor(
    private readonly id: number,
    private readonly name: string,
    private readonly realmId: number,
    private secLevel = 255,
    private readonly source: RBACPermissionSource,
    private readonly db: Db | null = null,
  ) {}

  getName(): string {
    return this.name;
  }

  getId(): number {
    return this.id;
  }

  hasPermission(permission: number): boolean {
    return this.globalPerms.has(permission);
  }

  getPermissions(): ReadonlySet<number> {
    return this.globalPerms;
  }

  getGrantedPermissions(): ReadonlySet<number> {
    return this.grantedPerms;
  }

  getDeniedPermissions(): ReadonlySet<number> {
    return this.deniedPerms;
  }

  /** @ac game/Accounts/RBAC.cpp RBACData::GrantPermission */
  grantPermission(permissionId: number, realmId = 0): RBACCommandResult {
    const perm = this.source.getRBACPermission(permissionId);
    if (!perm) {
      logTrace("server", () => `RBACData::GrantPermission [Id: ${this.id} Name: ${this.name}] (Permission ${permissionId}, RealmId ${realmId}). Permission does not exists`);
      return RBAC_ID_DOES_NOT_EXISTS;
    }
    if (this.hasDeniedPermission(permissionId)) {
      return RBAC_IN_DENIED_LIST;
    }
    if (this.hasGrantedPermission(permissionId)) {
      return RBAC_CANT_ADD_ALREADY_ADDED;
    }
    this.grantedPerms.add(permissionId);
    // Do not save to db when loading data from DB (realmId = 0)
    if (realmId) {
      this.savePermission(permissionId, true, realmId);
      this.calculateNewPermissions();
    }
    return RBAC_OK;
  }

  /** @ac game/Accounts/RBAC.cpp RBACData::DenyPermission */
  denyPermission(permissionId: number, realmId = 0): RBACCommandResult {
    const perm = this.source.getRBACPermission(permissionId);
    if (!perm) {
      return RBAC_ID_DOES_NOT_EXISTS;
    }
    if (this.hasGrantedPermission(permissionId)) {
      return RBAC_IN_GRANTED_LIST;
    }
    if (this.hasDeniedPermission(permissionId)) {
      return RBAC_CANT_ADD_ALREADY_ADDED;
    }
    this.deniedPerms.add(permissionId);
    if (realmId) {
      this.savePermission(permissionId, false, realmId);
      this.calculateNewPermissions();
    }
    return RBAC_OK;
  }

  /** @ac game/Accounts/RBAC.cpp RBACData::SavePermission */
  private savePermission(permission: number, granted: boolean, realmId: number): void {
    if (this.db) {
      executeStatementAsync(this.db, LOGIN_INS_RBAC_ACCOUNT_PERMISSION, this.id, permission, granted ? 1 : 0, realmId);
    }
  }

  /** @ac game/Accounts/RBAC.cpp RBACData::RevokePermission */
  revokePermission(permissionId: number, realmId = 0): RBACCommandResult {
    if (!this.hasGrantedPermission(permissionId) && !this.hasDeniedPermission(permissionId)) {
      return RBAC_CANT_REVOKE_NOT_IN_LIST;
    }
    this.grantedPerms.delete(permissionId);
    this.deniedPerms.delete(permissionId);
    if (realmId) {
      if (this.db) {
        executeStatementAsync(this.db, LOGIN_DEL_RBAC_ACCOUNT_PERMISSION, this.id, permissionId, realmId);
      }
      this.calculateNewPermissions();
    }
    return RBAC_OK;
  }

  /** @ac game/Accounts/RBAC.cpp RBACData::LoadFromDB */
  async loadFromDB(): Promise<void> {
    this.clearData();
    logDebug("server", () => `RBACData::LoadFromDB [Id: ${this.id} Name: ${this.name}]: Loading permissions`);
    const rows = this.db ? await queryFields(this.db, LOGIN_SEL_RBAC_ACCOUNT_PERMISSIONS, this.id, this.realmId) : [];
    this.loadFromDBCallback(rows.map((row) => ({ permissionId: Number(row[0]), granted: Number(row[1]) !== 0 })));
  }

  /** @ac game/Accounts/RBAC.cpp RBACData::LoadFromDBCallback */
  loadFromDBCallback(rows: readonly { permissionId: number; granted: boolean }[]): void {
    for (const row of rows) {
      if (row.granted) {
        this.grantPermission(row.permissionId);
      } else {
        this.denyPermission(row.permissionId);
      }
    }
    // Add default permissions
    for (const permission of this.source.getRBACDefaultPermissions(this.secLevel)) {
      this.grantPermission(permission);
    }
    // Force calculation of permissions
    this.calculateNewPermissions();
  }

  /** @ac game/Accounts/RBAC.h RBACData::SetSecurityLevel */
  async setSecurityLevel(id: number): Promise<void> {
    this.secLevel = id;
    await this.loadFromDB();
  }

  getSecurityLevel(): number {
    return this.secLevel;
  }

  /** @ac game/Accounts/RBAC.h RBACData::RecalculatePermissions */
  recalculatePermissions(): void {
    this.calculateNewPermissions();
  }

  /** @ac game/Accounts/RBAC.h RBACData::SetSecurityLevelForTest */
  setSecurityLevelForTest(id: number): void {
    this.secLevel = id;
  }

  /** @ac game/Accounts/RBAC.cpp RBACData::CalculateNewPermissions */
  private calculateNewPermissions(): void {
    this.globalPerms = new Set(this.grantedPerms);
    this.expandPermissions(this.globalPerms);
    const revoked = new Set(this.deniedPerms);
    this.expandPermissions(revoked);
    removePermissions(this.globalPerms, revoked);
  }

  private getRealmId(): number {
    return this.realmId;
  }

  private hasGrantedPermission(permissionId: number): boolean {
    return this.grantedPerms.has(permissionId);
  }

  private hasDeniedPermission(permissionId: number): boolean {
    return this.deniedPerms.has(permissionId);
  }

  /** @ac game/Accounts/RBAC.cpp RBACData::ExpandPermissions */
  private expandPermissions(permissions: RBACPermissionContainer): void {
    // `std::set` iterates in ascending order; the queue keeps the same order.
    const toCheck = new Set([...permissions].sort((a, b) => a - b));
    permissions.clear();
    while (toCheck.size > 0) {
      const permissionId = Math.min(...toCheck);
      toCheck.delete(permissionId);
      const permission = this.source.getRBACPermission(permissionId);
      if (!permission) {
        continue;
      }
      permissions.add(permissionId);
      for (const linkedPerm of permission.getLinkedPermissions()) {
        if (!permissions.has(linkedPerm)) {
          toCheck.add(linkedPerm);
        }
      }
    }
    logDebug("server", () => `RBACData::ExpandPermissions: Expanded: ${getDebugPermissionString([...permissions].sort((a, b) => a - b))}`);
  }

  /** @ac game/Accounts/RBAC.cpp RBACData::ClearData */
  private clearData(): void {
    this.grantedPerms.clear();
    this.deniedPerms.clear();
    this.globalPerms.clear();
  }

  /** Realm the data was loaded for (`GetRealmId`). */
  get realm(): number {
    return this.getRealmId();
  }
}

/** @ac game/Accounts/RBAC.cpp RBACData::RemovePermissions */
function removePermissions(permsFrom: RBACPermissionContainer, permsToRemove: ReadonlySet<number>): void {
  for (const permission of permsToRemove) {
    permsFrom.delete(permission);
  }
}
