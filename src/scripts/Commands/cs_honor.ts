/** `cs_honor.cpp`: `.honor add [kill]`, `.honor update`. */
import * as R from "../../game/Accounts/RBACDefines.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { uint32Arg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import * as L from "../../game/Miscellaneous/Language.ts";

/** @ac scripts/Commands/cs_honor.cpp honor_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const honorAddCommandTable: ChatCommandTable = [
    ChatCommand("kill", [], HandleHonorAddKillCommand, R.RBAC_PERM_COMMAND_HONOR_ADD_KILL, Console.No),
    ChatCommand("", [uint32Arg], HandleHonorAddCommand, R.RBAC_PERM_COMMAND_HONOR_ADD, Console.No),
  ];
  const honorCommandTable: ChatCommandTable = [
    SubCommands("add", honorAddCommandTable),
    ChatCommand("update", [], HandleHonorUpdateCommand, R.RBAC_PERM_COMMAND_HONOR_UPDATE, Console.No),
  ];
  return [SubCommands("honor", honorCommandTable)];
}

/** @ac scripts/Commands/cs_honor.cpp honor_commandscript::HandleHonorAddCommand */
async function HandleHonorAddCommand(handler: ChatHandler, amount: number): Promise<boolean> {
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  // check online security
  if (await handler.hasLowerSecurity(target, 0)) return false;
  await target.rewardHonor(null, 1, amount);
  return true;
}

/** @ac scripts/Commands/cs_honor.cpp honor_commandscript::HandleHonorAddKillCommand */
async function HandleHonorAddKillCommand(handler: ChatHandler): Promise<boolean> {
  const target = handler.getSelectedUnit();
  if (!target) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  // check online security
  const player = target.toPlayer();
  if (player && (await handler.hasLowerSecurity(player, 0))) return false;
  await handler.getSession()!.getPlayer()!.rewardHonor(target, 1);
  return true;
}

/** @ac scripts/Commands/cs_honor.cpp honor_commandscript::HandleHonorUpdateCommand */
async function HandleHonorUpdateCommand(handler: ChatHandler): Promise<boolean> {
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  // check online security
  if (await handler.hasLowerSecurity(target, 0)) return false;
  target.updateHonorFields();
  return true;
}

/** @ac scripts/Commands/cs_honor.cpp AddSC_honor_commandscript */
export function AddSC_honor_commandscript(): void {
  registerCommandScript(GetCommands);
}
