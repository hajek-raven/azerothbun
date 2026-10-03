/** `cs_cheat.cpp`: `.cheat god|casttime|cooldown|power|waterwalk|status|taxi|explore`. */
import * as R from "../../game/Accounts/RBACDefines.ts";
import { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { boolArg, Optional } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { CHEAT_CASTTIME, CHEAT_COOLDOWN, CHEAT_GOD, CHEAT_POWER, CHEAT_WATERWALK } from "../../game/Entities/Player/PlayerDefines.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { PLAYER_EXPLORED_ZONES_1 } from "../../gen/UpdateFields.gen.ts";
import { PLAYER_EXPLORED_ZONES_SIZE } from "../../world/session.ts";

/** @ac scripts/Commands/cs_cheat.cpp cheat_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const cheatCommandTable: ChatCommandTable = [
    ChatCommand("god", [Optional(boolArg)], HandleGodModeCheatCommand, R.RBAC_PERM_COMMAND_CHEAT_GOD, Console.No),
    ChatCommand("casttime", [Optional(boolArg)], HandleCasttimeCheatCommand, R.RBAC_PERM_COMMAND_CHEAT_CASTTIME, Console.No),
    ChatCommand("cooldown", [Optional(boolArg)], HandleCoolDownCheatCommand, R.RBAC_PERM_COMMAND_CHEAT_COOLDOWN, Console.No),
    ChatCommand("power", [Optional(boolArg)], HandlePowerCheatCommand, R.RBAC_PERM_COMMAND_CHEAT_POWER, Console.No),
    ChatCommand("waterwalk", [Optional(boolArg)], HandleWaterWalkCheatCommand, R.RBAC_PERM_COMMAND_CHEAT_WATERWALK, Console.No),
    ChatCommand("status", [], HandleCheatStatusCommand, R.RBAC_PERM_COMMAND_CHEAT_STATUS, Console.No),
    ChatCommand("taxi", [Optional(boolArg)], HandleTaxiCheatCommand, R.RBAC_PERM_COMMAND_CHEAT_TAXI, Console.No),
    ChatCommand("explore", [boolArg], HandleExploreCheatCommand, R.RBAC_PERM_COMMAND_CHEAT_EXPLORE, Console.No),
  ];
  return [SubCommands("cheat", cheatCommandTable)];
}

/** The `.cheat god|casttime|cooldown|power` toggle: the argument, or the opposite of the current `_activeCheats` bit. */
function toggleCheat(handler: ChatHandler, cheat: number, enableArg: boolean | null, on: string, off: string): boolean {
  const player = handler.getSession()!.getPlayer()!;
  let enable = !player.getCommandStatus(cheat);
  if (enableArg !== null) enable = enableArg;
  if (enable) {
    player.setCommandStatusOn(cheat);
    handler.sendSysMessage(on);
  } else {
    player.setCommandStatusOff(cheat);
    handler.sendSysMessage(off);
  }
  return true;
}

/** @ac scripts/Commands/cs_cheat.cpp cheat_commandscript::HandleGodModeCheatCommand */
function HandleGodModeCheatCommand(handler: ChatHandler, enableArg: boolean | null): boolean {
  return toggleCheat(handler, CHEAT_GOD, enableArg, "Godmode is ON. You won't take damage.", "Godmode is OFF. You can take damage.");
}

/** @ac scripts/Commands/cs_cheat.cpp cheat_commandscript::HandleCasttimeCheatCommand */
function HandleCasttimeCheatCommand(handler: ChatHandler, enableArg: boolean | null): boolean {
  return toggleCheat(handler, CHEAT_CASTTIME, enableArg, "CastTime Cheat is ON. Your spells won't have a casttime.", "CastTime Cheat is OFF. Your spells will have a casttime.");
}

/** @ac scripts/Commands/cs_cheat.cpp cheat_commandscript::HandleCoolDownCheatCommand */
function HandleCoolDownCheatCommand(handler: ChatHandler, enableArg: boolean | null): boolean {
  return toggleCheat(handler, CHEAT_COOLDOWN, enableArg, "Cooldown Cheat is ON. You are not on the global cooldown.", "Cooldown Cheat is OFF. You are on the global cooldown.");
}

/** @ac scripts/Commands/cs_cheat.cpp cheat_commandscript::HandlePowerCheatCommand */
function HandlePowerCheatCommand(handler: ChatHandler, enableArg: boolean | null): boolean {
  return toggleCheat(handler, CHEAT_POWER, enableArg, "Power Cheat is ON. You don't need mana/rage/energy to use spells.", "Power Cheat is OFF. You need mana/rage/energy to use spells.");
}

/** @ac scripts/Commands/cs_cheat.cpp cheat_commandscript::HandleCheatStatusCommand */
function HandleCheatStatusCommand(handler: ChatHandler): boolean {
  const player = handler.getSession()!.getPlayer()!;
  const enabled = "ON";
  const disabled = "OFF";
  handler.sendSysMessage(L.LANG_COMMAND_CHEAT_STATUS);
  handler.pSendSysMessage(L.LANG_COMMAND_CHEAT_GOD, player.getCommandStatus(CHEAT_GOD) ? enabled : disabled);
  handler.pSendSysMessage(L.LANG_COMMAND_CHEAT_CD, player.getCommandStatus(CHEAT_COOLDOWN) ? enabled : disabled);
  handler.pSendSysMessage(L.LANG_COMMAND_CHEAT_CT, player.getCommandStatus(CHEAT_CASTTIME) ? enabled : disabled);
  handler.pSendSysMessage(L.LANG_COMMAND_CHEAT_POWER, player.getCommandStatus(CHEAT_POWER) ? enabled : disabled);
  handler.pSendSysMessage(L.LANG_COMMAND_CHEAT_WW, player.getCommandStatus(CHEAT_WATERWALK) ? enabled : disabled);
  handler.pSendSysMessage(L.LANG_COMMAND_CHEAT_TAXINODES, player.isTaxiCheater() ? enabled : disabled);
  return true;
}

/** @ac scripts/Commands/cs_cheat.cpp cheat_commandscript::HandleWaterWalkCheatCommand */
function HandleWaterWalkCheatCommand(handler: ChatHandler, enableArg: boolean | null): boolean {
  const player = handler.getSession()!.getPlayer()!;
  let enable = !player.getCommandStatus(CHEAT_WATERWALK);
  if (enableArg !== null) enable = enableArg;
  if (enable) {
    player.setCommandStatusOn(CHEAT_WATERWALK);
    player.setWaterWalking(true); // ON
    handler.sendSysMessage("Waterwalking is ON. You can walk on water.");
  } else {
    player.setCommandStatusOff(CHEAT_WATERWALK);
    player.setWaterWalking(false); // OFF
    handler.sendSysMessage("Waterwalking is OFF. You can't walk on water.");
  }
  return true;
}

/** @ac scripts/Commands/cs_cheat.cpp cheat_commandscript::HandleTaxiCheatCommand */
async function HandleTaxiCheatCommand(handler: ChatHandler, enableArg: boolean | null): Promise<boolean> {
  let chr = handler.getSelectedPlayer();
  if (!chr) chr = handler.getSession()!.getPlayer()!;
  else if (await handler.hasLowerSecurity(chr, 0)) return false; // check online security
  let enable = !chr.isTaxiCheater();
  if (enableArg !== null) enable = enableArg;
  if (enable) {
    chr.setTaxiCheater(true);
    handler.pSendSysMessage(L.LANG_YOU_GIVE_TAXIS, handler.getNameLink(chr));
    if (handler.needReportToTarget(chr)) new ChatHandler(chr.getSession()).pSendSysMessage(L.LANG_YOURS_TAXIS_ADDED, handler.getNameLink());
  } else {
    chr.setTaxiCheater(false);
    handler.pSendSysMessage(L.LANG_YOU_REMOVE_TAXIS, handler.getNameLink(chr));
    if (handler.needReportToTarget(chr)) new ChatHandler(chr.getSession()).pSendSysMessage(L.LANG_YOURS_TAXIS_REMOVED, handler.getNameLink());
  }
  return true;
}

/** @ac scripts/Commands/cs_cheat.cpp cheat_commandscript::HandleExploreCheatCommand */
function HandleExploreCheatCommand(handler: ChatHandler, reveal: boolean): boolean {
  const chr = handler.getSelectedPlayer();
  if (!chr) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  if (reveal) {
    handler.pSendSysMessage(L.LANG_YOU_SET_EXPLORE_ALL, handler.getNameLink(chr));
    if (handler.needReportToTarget(chr)) new ChatHandler(chr.getSession()).pSendSysMessage(L.LANG_YOURS_EXPLORE_SET_ALL, handler.getNameLink());
  } else {
    handler.pSendSysMessage(L.LANG_YOU_SET_EXPLORE_NOTHING, handler.getNameLink(chr));
    if (handler.needReportToTarget(chr)) new ChatHandler(chr.getSession()).pSendSysMessage(L.LANG_YOURS_EXPLORE_SET_NOTHING, handler.getNameLink());
  }
  // `SetFlag` on the command user's own fields, as AzerothCore does (`SetFlag(…, 0)` leaves them unchanged).
  const player = handler.getSession()!.getPlayer()!;
  for (let i = 0; i < PLAYER_EXPLORED_ZONES_SIZE; ++i) {
    const index = PLAYER_EXPLORED_ZONES_1 + i;
    player.setUInt32Value(index, (player.getUInt32Value(index) | (reveal ? 0xffffffff : 0)) >>> 0);
  }
  return true;
}

/** @ac scripts/Commands/cs_cheat.cpp AddSC_cheat_commandscript */
export function AddSC_cheat_commandscript(): void {
  registerCommandScript(GetCommands);
}
