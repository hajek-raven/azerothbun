/** `cs_player.cpp`: `.player learn|unlearn`. */
import * as R from "../../game/Accounts/RBACDefines.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { Optional, SpellInfoArg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { ExactSequence, PlayerIdentifier, PlayerIdentifierArg } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import type { SpellInfo } from "../../spells/spell-info.ts";
import { HandleLearnSpellCommand, HandleUnlearnSpellCommand } from "./PlayerCommand.ts";

/** @ac scripts/Commands/cs_player.cpp player_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const playerCommandTable: ChatCommandTable = [
    ChatCommand("learn", [Optional(PlayerIdentifierArg), SpellInfoArg, Optional(ExactSequence("all"))], HandlePlayerLearnCommand, R.RBAC_PERM_COMMAND_LEARN, Console.Yes),
    ChatCommand("unlearn", [Optional(PlayerIdentifierArg), SpellInfoArg, Optional(ExactSequence("all"))], HandlePlayerUnLearnCommand, R.RBAC_PERM_COMMAND_UNLEARN, Console.Yes),
  ];
  return [SubCommands("player", playerCommandTable)];
}

/** @ac scripts/Commands/cs_player.cpp player_commandscript::HandlePlayerLearnCommand */
function HandlePlayerLearnCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null, spell: SpellInfo, allRanks: string | null): boolean {
  const targetPlayer = (playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler))?.getConnectedPlayer();
  if (!targetPlayer) return false;
  return HandleLearnSpellCommand(handler, targetPlayer, spell, allRanks);
}

/** @ac scripts/Commands/cs_player.cpp player_commandscript::HandlePlayerUnLearnCommand */
function HandlePlayerUnLearnCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null, spell: SpellInfo, allRanks: string | null): boolean {
  const targetPlayer = (playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler))?.getConnectedPlayer();
  if (!targetPlayer) return false;
  return HandleUnlearnSpellCommand(handler, targetPlayer, spell, allRanks);
}

/** @ac scripts/Commands/cs_player.cpp AddSC_player_commandscript */
export function AddSC_player_commandscript(): void {
  registerCommandScript(GetCommands);
}
