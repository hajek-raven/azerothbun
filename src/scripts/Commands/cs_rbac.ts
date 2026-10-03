/** `cs_rbac.cpp`: `.rbac account list|grant|deny|revoke`, `.rbac list`. */
import { getSecurity } from "../../game/Accounts/AccountMgr.ts";
import { sAccountMgr } from "../../game/Accounts/AccountMgr.ts";
import { RBACData } from "../../game/Accounts/RBAC.ts";
import * as R from "../../game/Accounts/RBACDefines.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { int32Arg, Optional, uint32Arg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { AccountIdentifierArg, type AccountIdentifier } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { sWorldSessionMgr } from "../../game/Server/WorldSessionMgr.ts";
import { LoginDatabase } from "../../database/DatabaseEnv.ts";
import { realm } from "../../shared/Realms/Realm.ts";
import { SEC_ADMINISTRATOR, SEC_CONSOLE, SEC_GAMEMASTER, SEC_MODERATOR, SEC_PLAYER } from "../../shared/SharedDefines.ts";

/** @ac scripts/Commands/cs_rbac.cpp rbac_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const rbacAccountCommandTable: ChatCommandTable = [
    ChatCommand("list", [AccountIdentifierArg], HandleRBACPermListCommand, R.RBAC_PERM_COMMAND_RBAC_ACC_PERM_LIST, Console.Yes, L.LANG_RBAC_HELP_ACC_LIST),
    ChatCommand("grant", [AccountIdentifierArg, uint32Arg, Optional(int32Arg)], HandleRBACPermGrantCommand, R.RBAC_PERM_COMMAND_RBAC_ACC_PERM_GRANT, Console.Yes, L.LANG_RBAC_HELP_ACC_GRANT),
    ChatCommand("deny", [AccountIdentifierArg, uint32Arg, Optional(int32Arg)], HandleRBACPermDenyCommand, R.RBAC_PERM_COMMAND_RBAC_ACC_PERM_DENY, Console.Yes, L.LANG_RBAC_HELP_ACC_DENY),
    ChatCommand("revoke", [AccountIdentifierArg, uint32Arg, Optional(int32Arg)], HandleRBACPermRevokeCommand, R.RBAC_PERM_COMMAND_RBAC_ACC_PERM_REVOKE, Console.Yes, L.LANG_RBAC_HELP_ACC_REVOKE),
  ];
  const rbacCommandTable: ChatCommandTable = [
    SubCommands("account", rbacAccountCommandTable),
    ChatCommand("list", [Optional(uint32Arg)], HandleRBACListPermissionsCommand, R.RBAC_PERM_COMMAND_RBAC_LIST, Console.Yes),
  ];
  return [SubCommands("rbac", rbacCommandTable)];
}

/** @ac scripts/Commands/cs_rbac.cpp rbac_commandscript::GetRBACData */
async function GetRBACData(accountId: number, accountName: string): Promise<RBACData> {
  // session->GetRBACData() can be null after World::ReloadRBAC()
  const sessionRbac = sWorldSessionMgr.FindSession(accountId)?.getRBACData();
  if (sessionRbac) return sessionRbac;
  const db = LoginDatabase();
  const rbac = new RBACData(accountId, accountName, realm.Id.Realm, await getSecurity(db, accountId, realm.Id.Realm), sAccountMgr, db);
  await rbac.loadFromDB();
  return rbac;
}

/** `.rbac account grant|deny|revoke`: the result messages for each `RBACCommandResult`. */
async function changePermission(
  handler: ChatHandler,
  account: AccountIdentifier,
  permId: number,
  realmIdArg: number | null,
  apply: (rbac: RBACData, realmId: number) => number,
  messages: Partial<Record<number, number>>,
): Promise<boolean> {
  if (await handler.hasLowerSecurityAccount(null, account.id, true)) return false;
  const realmId = realmIdArg ?? -1;
  const data = await GetRBACData(account.id, account.name);
  const result = apply(data, realmId);
  const permission = sAccountMgr.getRBACPermission(permId);
  if (result === R.RBAC_ID_DOES_NOT_EXISTS) {
    handler.pSendSysMessage(L.LANG_RBAC_WRONG_PARAMETER_ID, permId);
    return true;
  }
  const message = messages[result];
  if (message !== undefined) handler.pSendSysMessage(message, permId, permission?.getName() ?? "", realmId, account.id, account.name);
  return true;
}

/** @ac scripts/Commands/cs_rbac.cpp rbac_commandscript::HandleRBACPermGrantCommand */
function HandleRBACPermGrantCommand(handler: ChatHandler, account: AccountIdentifier, permId: number, realmId: number | null): Promise<boolean> {
  return changePermission(handler, account, permId, realmId, (rbac, id) => rbac.grantPermission(permId, id), {
    [R.RBAC_CANT_ADD_ALREADY_ADDED]: L.LANG_RBAC_PERM_GRANTED_IN_LIST,
    [R.RBAC_IN_DENIED_LIST]: L.LANG_RBAC_PERM_GRANTED_IN_DENIED_LIST,
    [R.RBAC_OK]: L.LANG_RBAC_PERM_GRANTED,
  });
}

/** @ac scripts/Commands/cs_rbac.cpp rbac_commandscript::HandleRBACPermDenyCommand */
function HandleRBACPermDenyCommand(handler: ChatHandler, account: AccountIdentifier, permId: number, realmId: number | null): Promise<boolean> {
  return changePermission(handler, account, permId, realmId, (rbac, id) => rbac.denyPermission(permId, id), {
    [R.RBAC_CANT_ADD_ALREADY_ADDED]: L.LANG_RBAC_PERM_DENIED_IN_LIST,
    [R.RBAC_IN_GRANTED_LIST]: L.LANG_RBAC_PERM_DENIED_IN_GRANTED_LIST,
    [R.RBAC_OK]: L.LANG_RBAC_PERM_DENIED,
  });
}

/** @ac scripts/Commands/cs_rbac.cpp rbac_commandscript::HandleRBACPermRevokeCommand */
function HandleRBACPermRevokeCommand(handler: ChatHandler, account: AccountIdentifier, permId: number, realmId: number | null): Promise<boolean> {
  return changePermission(handler, account, permId, realmId, (rbac, id) => rbac.revokePermission(permId, id), {
    [R.RBAC_CANT_REVOKE_NOT_IN_LIST]: L.LANG_RBAC_PERM_REVOKED_NOT_IN_LIST,
    [R.RBAC_OK]: L.LANG_RBAC_PERM_REVOKED,
  });
}

/** @ac scripts/Commands/cs_rbac.cpp rbac_commandscript::GetSecurityLevelName */
function GetSecurityLevelName(secLevel: number): string {
  switch (secLevel) {
    case SEC_PLAYER:
      return "SEC_PLAYER";
    case SEC_MODERATOR:
      return "SEC_MODERATOR";
    case SEC_GAMEMASTER:
      return "SEC_GAMEMASTER";
    case SEC_ADMINISTRATOR:
      return "SEC_ADMINISTRATOR";
    case SEC_CONSOLE:
      return "SEC_CONSOLE";
    default:
      return "Unknown";
  }
}

/** Every permission of a list as `LANG_RBAC_LIST_ELEMENT`, or `LANG_RBAC_LIST_EMPTY`. */
function listPermissions(handler: ChatHandler, ids: Iterable<number>): void {
  const list = [...ids];
  if (list.length === 0) {
    handler.sendSysMessage(handler.getAcoreString(L.LANG_RBAC_LIST_EMPTY));
    return;
  }
  for (const id of list) {
    const permission = sAccountMgr.getRBACPermission(id);
    if (permission) handler.pSendSysMessage(L.LANG_RBAC_LIST_ELEMENT, permission.getId(), permission.getName());
  }
}

/** @ac scripts/Commands/cs_rbac.cpp rbac_commandscript::HandleRBACPermListCommand */
async function HandleRBACPermListCommand(handler: ChatHandler, account: AccountIdentifier): Promise<boolean> {
  const data = await GetRBACData(account.id, account.name);
  handler.pSendSysMessage(L.LANG_RBAC_LIST_HEADER_GRANTED, data.getId(), data.getName());
  listPermissions(handler, data.getGrantedPermissions());
  handler.pSendSysMessage(L.LANG_RBAC_LIST_HEADER_DENIED, data.getId(), data.getName());
  listPermissions(handler, data.getDeniedPermissions());
  handler.pSendSysMessage(L.LANG_RBAC_LIST_HEADER_BY_SEC_LEVEL, data.getId(), data.getName(), data.getSecurityLevel(), GetSecurityLevelName(data.getSecurityLevel()));
  listPermissions(handler, sAccountMgr.getRBACDefaultPermissions(data.getSecurityLevel()));
  return true;
}

/** @ac scripts/Commands/cs_rbac.cpp rbac_commandscript::HandleRBACListPermissionsCommand */
function HandleRBACListPermissionsCommand(handler: ChatHandler, permId: number | null): boolean {
  if (permId === null) {
    handler.sendSysMessage(handler.getAcoreString(L.LANG_RBAC_LIST_PERMISSIONS_HEADER));
    for (const permission of sAccountMgr.getRBACPermissionList().values()) handler.pSendSysMessage(L.LANG_RBAC_LIST_ELEMENT, permission.getId(), permission.getName());
    return true;
  }
  const permission = sAccountMgr.getRBACPermission(permId);
  if (!permission) {
    handler.pSendSysMessage(L.LANG_RBAC_WRONG_PARAMETER_ID, permId);
    handler.setSentErrorMessage(true);
    return false;
  }
  handler.sendSysMessage(handler.getAcoreString(L.LANG_RBAC_LIST_PERMISSIONS_HEADER));
  handler.pSendSysMessage(L.LANG_RBAC_LIST_ELEMENT, permission.getId(), permission.getName());
  handler.sendSysMessage(handler.getAcoreString(L.LANG_RBAC_LIST_PERMS_LINKED_HEADER));
  listLinked(handler, permission.getLinkedPermissions());
  return true;
}

function listLinked(handler: ChatHandler, linked: Iterable<number>): void {
  for (const linkedPerm of linked) {
    const rbacPermission = sAccountMgr.getRBACPermission(linkedPerm);
    if (rbacPermission) handler.pSendSysMessage(L.LANG_RBAC_LIST_ELEMENT, rbacPermission.getId(), rbacPermission.getName());
  }
}

/** @ac scripts/Commands/cs_rbac.cpp AddSC_rbac_commandscript */
export function AddSC_rbac_commandscript(): void {
  registerCommandScript(GetCommands);
}
