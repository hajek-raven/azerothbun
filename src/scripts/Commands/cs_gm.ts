/** `cs_gm.cpp`: `.gm on|off|chat|fly|ingame|list|visible|spectator`. */
import { queryFields } from "../../database/database.ts";
import { LoginDatabase } from "../../database/DatabaseEnv.ts";
import { LOGIN_SEL_GM_ACCOUNTS } from "../../gen/LoginDatabase.gen.ts";
import { isPlayerAccount } from "../../game/Accounts/AccountMgr.ts";
import {
  RBAC_PERM_COMMAND_GM,
  RBAC_PERM_COMMAND_GM_CHAT,
  RBAC_PERM_COMMAND_GM_FLY,
  RBAC_PERM_COMMAND_GM_INGAME,
  RBAC_PERM_COMMAND_GM_LIST,
  RBAC_PERM_COMMAND_GM_VISIBLE,
} from "../../game/Accounts/RBACDefines.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { boolArg, Optional } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { ObjectAccessor } from "../../game/Globals/ObjectAccessor.ts";
import {
  LANG_COMMAND_FLYMODE_STATUS,
  LANG_GM_CHAT_OFF,
  LANG_GM_CHAT_ON,
  LANG_GM_OFF,
  LANG_GM_ON,
  LANG_GM_SPECTATOR_OFF,
  LANG_GM_SPECTATOR_ON,
  LANG_GMLIST,
  LANG_GMLIST_EMPTY,
  LANG_GMS_NOT_LOGGED,
  LANG_GMS_ON_SRV,
  LANG_INVISIBLE,
  LANG_INVISIBLE_INVISIBLE,
  LANG_INVISIBLE_VISIBLE,
  LANG_USE_BOL,
  LANG_VISIBLE,
  LANG_YOU_ARE,
} from "../../game/Miscellaneous/Language.ts";
import { ServerConfig } from "../../game/world/world-config.ts";
import { sWorld } from "../../game/world/world.ts";
import { SEC_MODERATOR } from "../../shared/SharedDefines.ts";
import { realm } from "../../shared/Realms/Realm.ts";

function u8(value: number): number {
  return Math.trunc(value) & 0xff;
}

/** @ac scripts/Commands/cs_gm.cpp gm_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const gmCommandTable: ChatCommandTable = [
    ChatCommand("chat", [Optional(boolArg)], HandleGMChatCommand, RBAC_PERM_COMMAND_GM_CHAT, Console.No),
    ChatCommand("fly", [Optional(boolArg)], HandleGMFlyCommand, RBAC_PERM_COMMAND_GM_FLY, Console.No),
    ChatCommand("ingame", [], HandleGMListIngameCommand, RBAC_PERM_COMMAND_GM_INGAME, Console.Yes),
    ChatCommand("list", [], HandleGMListFullCommand, RBAC_PERM_COMMAND_GM_LIST, Console.Yes),
    ChatCommand("visible", [Optional(boolArg)], HandleGMVisibleCommand, RBAC_PERM_COMMAND_GM_VISIBLE, Console.No),
    ChatCommand("on", [], HandleGMOnCommand, RBAC_PERM_COMMAND_GM, Console.No),
    ChatCommand("off", [], HandleGMOffCommand, RBAC_PERM_COMMAND_GM, Console.No),
    ChatCommand("spectator", [Optional(boolArg)], HandleGMSpectatorCommand, RBAC_PERM_COMMAND_GM, Console.No),
  ];
  return [SubCommands("gm", gmCommandTable)];
}

/** @ac scripts/Commands/cs_gm.cpp gm_commandscript::HandleGMChatCommand */
function HandleGMChatCommand(handler: ChatHandler, enableArg: boolean | null): boolean {
  const session = handler.getSession();
  if (session) {
    const player = session.getPlayer()!;
    if (enableArg === null) {
      if (!isPlayerAccount(session.getSecurity()) && player.isGMChat()) handler.sendNotification(LANG_GM_CHAT_ON);
      else handler.sendNotification(LANG_GM_CHAT_OFF);
      return true;
    }
    player.setGMChat(enableArg);
    handler.sendNotification(enableArg ? LANG_GM_CHAT_ON : LANG_GM_CHAT_OFF);
    return true;
  }
  handler.sendErrorMessage(LANG_USE_BOL);
  return false;
}

/** @ac scripts/Commands/cs_gm.cpp gm_commandscript::HandleGMFlyCommand */
function HandleGMFlyCommand(handler: ChatHandler, enable: boolean | null): boolean {
  const target = handler.getSelectedPlayer() ?? handler.getSession()!.getPlayer()!;
  let canFly: boolean;
  if (enable !== null) {
    canFly = enable;
    target.setCanFly(canFly);
  } else {
    canFly = !handler.getSession()!.getPlayer()!.canFly();
    target.setCanFly(canFly);
  }
  handler.pSendSysMessage(LANG_COMMAND_FLYMODE_STATUS, handler.getNameLink(target), canFly ? "on" : "off");
  return true;
}

/** @ac scripts/Commands/cs_gm.cpp gm_commandscript::HandleGMListIngameCommand */
function HandleGMListIngameCommand(handler: ChatHandler): boolean {
  let first = true;
  let footer = false;
  const session = handler.getSession();
  for (const player of ObjectAccessor.GetPlayers()) {
    const playerSec = player.getSession().getSecurity();
    if (
      (player.isGameMaster() || (!isPlayerAccount(playerSec) && playerSec <= sWorld().getIntConfig(ServerConfig.CONFIG_GM_LEVEL_IN_GM_LIST))) &&
      (!session || player.isVisibleGloballyFor(session.getPlayer()!))
    ) {
      if (first) {
        first = false;
        footer = true;
        handler.sendSysMessage(LANG_GMS_ON_SRV);
        handler.sendSysMessage("========================");
      }
      const name = player.getName();
      const size = u8(name.length);
      const security = u8(playerSec);
      const max = u8((16 - size) / 2);
      let max2 = max;
      if (max + max2 + size === 16) max2 = u8(max - 1);
      if (session) handler.pSendSysMessage("|    {} GMLevel {}", name, security);
      else handler.pSendSysMessage("|{}{}{}|   {}  |", max, " ", name, max2, " ", security);
    }
  }
  if (footer) handler.sendSysMessage("========================");
  if (first) handler.sendSysMessage(LANG_GMS_NOT_LOGGED);
  return true;
}

/** @ac scripts/Commands/cs_gm.cpp gm_commandscript::HandleGMListFullCommand */
async function HandleGMListFullCommand(handler: ChatHandler): Promise<boolean> {
  // Get the accounts with GM Level >0
  const result = await queryFields(LoginDatabase(), LOGIN_SEL_GM_ACCOUNTS, SEC_MODERATOR, realm.Id.Realm);
  if (result.length > 0) {
    handler.sendSysMessage(LANG_GMLIST);
    handler.sendSysMessage("========================");
    // Cycle through them. Display username and GM level
    for (const fields of result) {
      const name = String(fields[0]);
      const security = Number(fields[1]);
      const max = u8((16 - name.length) / 2);
      let max2 = max;
      if (max + max2 + name.length === 16) max2 = u8(max - 1);
      if (handler.getSession()) handler.pSendSysMessage("|    {} GMLevel {}", name, security);
      else handler.pSendSysMessage("|{}{}{}|   {}  |", max, " ", name, max2, " ", security);
    }
    handler.sendSysMessage("========================");
  } else {
    handler.pSendSysMessage(LANG_GMLIST_EMPTY);
  }
  return true;
}

/** @ac scripts/Commands/cs_gm.cpp gm_commandscript::HandleGMVisibleCommand */
function HandleGMVisibleCommand(handler: ChatHandler, visibleArg: boolean | null): boolean {
  const player = handler.getSession()!.getPlayer()!;
  if (visibleArg === null) {
    handler.pSendSysMessage(LANG_YOU_ARE, player.isGMVisible() ? handler.getAcoreString(LANG_VISIBLE) : handler.getAcoreString(LANG_INVISIBLE));
    return true;
  }
  const VISUAL_AURA = 37800;
  if (visibleArg) {
    if (player.hasAura(VISUAL_AURA)) player.removeAurasDueToSpell(VISUAL_AURA);
    player.setGMVisible(true);
    player.updateObjectVisibility();
    handler.sendNotification(LANG_INVISIBLE_VISIBLE);
  } else {
    player.spellUnit()?.addAura(VISUAL_AURA, player.spellUnit()!);
    player.setGMVisible(false);
    player.updateObjectVisibility();
    handler.sendNotification(LANG_INVISIBLE_INVISIBLE);
  }
  return true;
}

/** @ac scripts/Commands/cs_gm.cpp gm_commandscript::HandleGMOnCommand */
function HandleGMOnCommand(handler: ChatHandler): boolean {
  handler.getPlayer()!.setGameMaster(true);
  handler.sendNotification(LANG_GM_ON);
  return true;
}

/** @ac scripts/Commands/cs_gm.cpp gm_commandscript::HandleGMOffCommand */
function HandleGMOffCommand(handler: ChatHandler): boolean {
  handler.getPlayer()!.setGameMaster(false);
  handler.sendNotification(LANG_GM_OFF);
  return true;
}

/** @ac scripts/Commands/cs_gm.cpp gm_commandscript::HandleGMSpectatorCommand */
function HandleGMSpectatorCommand(handler: ChatHandler, enable: boolean | null): boolean {
  const player = handler.getSession()!.getPlayer()!;
  if (enable !== null) player.setGMSpectator(enable);
  else player.setGMSpectator(!player.isGMSpectator());
  handler.sendNotification(player.isGMSpectator() ? LANG_GM_SPECTATOR_ON : LANG_GM_SPECTATOR_OFF);
  return true;
}

/** @ac scripts/Commands/cs_gm.cpp AddSC_gm_commandscript */
export function AddSC_gm_commandscript(): void {
  registerCommandScript(GetCommands);
}
