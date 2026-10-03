/** `cs_message.cpp`: `.announce`, `.nameannounce`, `.notify`, their GM variants, and `.whispers`. */
import * as R from "../../game/Accounts/RBACDefines.ts";
import { notificationPacket, SMSG_NOTIFICATION, type ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { boolArg, Optional, stringArg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { ExactSequence, Tail, Variant, type VariantValue } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { ObjectAccessor } from "../../game/Globals/ObjectAccessor.ts";
import { normalizePlayerName } from "../../game/Globals/ObjectMgr.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { SERVER_MSG_STRING, sWorldSessionMgr } from "../../game/Server/WorldSessionMgr.ts";
import { StringFormat } from "../../common/Utilities/StringFormat.ts";

/** @ac scripts/Commands/cs_message.cpp message_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  return [
    ChatCommand("nameannounce", [Tail], HandleNameAnnounceCommand, R.RBAC_PERM_COMMAND_NAMEANNOUNCE, Console.Yes),
    ChatCommand("gmnameannounce", [Tail], HandleGMNameAnnounceCommand, R.RBAC_PERM_COMMAND_GMNAMEANNOUNCE, Console.Yes),
    ChatCommand("announce", [Tail], HandleAnnounceCommand, R.RBAC_PERM_COMMAND_ANNOUNCE, Console.Yes),
    ChatCommand("gmannounce", [Tail], HandleGMAnnounceCommand, R.RBAC_PERM_COMMAND_GMANNOUNCE, Console.Yes),
    ChatCommand("notify", [Tail], HandleNotifyCommand, R.RBAC_PERM_COMMAND_NOTIFY, Console.Yes),
    ChatCommand("gmnotify", [Tail], HandleGMNotifyCommand, R.RBAC_PERM_COMMAND_GMNOTIFY, Console.Yes),
    ChatCommand("whispers", [Optional(Variant(boolArg, ExactSequence("remove"))), Optional(stringArg)], HandleWhispersCommand, R.RBAC_PERM_CAN_FILTER_WHISPERS, Console.No),
  ];
}

/** @ac scripts/Commands/cs_message.cpp message_commandscript::HandleNameAnnounceCommand */
function HandleNameAnnounceCommand(handler: ChatHandler, message: string): boolean {
  if (!message) return false;
  const name = handler.getSession()?.getPlayer()?.getName() ?? "Console";
  handler.sendWorldText(L.LANG_ANNOUNCE_COLOR, name, message);
  return true;
}

/** @ac scripts/Commands/cs_message.cpp message_commandscript::HandleGMNameAnnounceCommand */
function HandleGMNameAnnounceCommand(handler: ChatHandler, message: string): boolean {
  if (!message) return false;
  const name = handler.getSession()?.getPlayer()?.getName() ?? "Console";
  handler.sendGMText(L.LANG_GM_ANNOUNCE_COLOR, name, message);
  return true;
}

/** @ac scripts/Commands/cs_message.cpp message_commandscript::HandleAnnounceCommand */
function HandleAnnounceCommand(handler: ChatHandler, message: string): boolean {
  if (!message) return false;
  sWorldSessionMgr.SendServerMessage(SERVER_MSG_STRING, StringFormat(handler.getAcoreString(L.LANG_SYSTEMMESSAGE), message));
  return true;
}

/** @ac scripts/Commands/cs_message.cpp message_commandscript::HandleGMAnnounceCommand */
function HandleGMAnnounceCommand(handler: ChatHandler, message: string): boolean {
  if (!message) return false;
  handler.sendGMText(L.LANG_GM_BROADCAST, message);
  return true;
}

/** @ac scripts/Commands/cs_message.cpp message_commandscript::HandleNotifyCommand */
function HandleNotifyCommand(handler: ChatHandler, message: string): boolean {
  if (!message) return false;
  const str = handler.getAcoreString(L.LANG_GLOBAL_NOTIFY) + message;
  sWorldSessionMgr.SendGlobalMessage(SMSG_NOTIFICATION, notificationPacket(str));
  return true;
}

/** @ac scripts/Commands/cs_message.cpp message_commandscript::HandleGMNotifyCommand */
function HandleGMNotifyCommand(handler: ChatHandler, message: string): boolean {
  if (!message) return false;
  const str = handler.getAcoreString(L.LANG_GM_NOTIFY) + message;
  sWorldSessionMgr.SendGlobalGMMessage(SMSG_NOTIFICATION, notificationPacket(str));
  return true;
}

/** @ac scripts/Commands/cs_message.cpp message_commandscript::HandleWhispersCommand */
function HandleWhispersCommand(handler: ChatHandler, operationArg: VariantValue<boolean | string> | null, playerNameArg: string | null): boolean {
  const player = handler.getSession()!.getPlayer()!;
  if (!operationArg) {
    handler.pSendSysMessage(L.LANG_COMMAND_WHISPERACCEPTING, player.isAcceptWhispers() ? handler.getAcoreString(L.LANG_ON) : handler.getAcoreString(L.LANG_OFF));
    return true;
  }
  if (operationArg.index === 0) {
    if (operationArg.value) {
      player.setAcceptWhispers(true);
      handler.sendSysMessage(L.LANG_COMMAND_WHISPERON);
    } else {
      // Remove all players from the Gamemaster's whisper whitelist
      player.clearWhisperWhiteList();
      player.setAcceptWhispers(false);
      handler.sendSysMessage(L.LANG_COMMAND_WHISPEROFF);
    }
    return true;
  }
  if (!playerNameArg) return false;
  const name = normalizePlayerName(playerNameArg);
  if (name) {
    const target = ObjectAccessor.FindPlayerByName(name);
    if (target) {
      player.removeFromWhisperWhiteList(target.getGUID());
      handler.pSendSysMessage(L.LANG_COMMAND_WHISPEROFFPLAYER, name);
      return true;
    }
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND, name);
    return false;
  }
  handler.sendErrorMessage(L.LANG_USE_BOL);
  return false;
}

/** @ac scripts/Commands/cs_message.cpp AddSC_message_commandscript */
export function AddSC_message_commandscript(): void {
  registerCommandScript(GetCommands);
}
