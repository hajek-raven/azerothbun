/** `cs_gear.cpp`: `.gear repair|stats`. */
import { queryFields } from "../../database/database.ts";
import { CharacterDatabase } from "../../database/DatabaseEnv.ts";
import { CHAR_SEL_CHAR_STATS } from "../../gen/CharacterDatabase.gen.ts";
import * as R from "../../game/Accounts/RBACDefines.ts";
import { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { Optional } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { PlayerIdentifier, PlayerIdentifierArg } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { ServerConfig } from "../../game/world/world-config.ts";
import { sWorld } from "../../game/world/world.ts";

/** @ac scripts/Commands/cs_gear.cpp gear_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const gearCommandTable: ChatCommandTable = [
    ChatCommand("repair", [Optional(PlayerIdentifierArg)], HandleGearRepairCommand, R.RBAC_PERM_COMMAND_GEAR_REPAIR, Console.No),
    ChatCommand("stats", [], HandleGearStatsCommand, R.RBAC_PERM_COMMAND_GEAR_STATS, Console.No),
  ];
  return [SubCommands("gear", gearCommandTable)];
}

/** @ac scripts/Commands/cs_gear.cpp gear_commandscript::HandleGearRepairCommand */
async function HandleGearRepairCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null): Promise<boolean> {
  const target = targetArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  const player = target?.getConnectedPlayer() ?? null;
  if (!target || !player) return false;
  // check online security
  if (await handler.hasLowerSecurity(player)) return false;
  // Repair items
  await player.durabilityRepairAll(false, 0, false);
  const nameLink = handler.playerLink(target.getName());
  handler.pSendSysMessage(L.LANG_YOU_REPAIR_ITEMS, nameLink);
  if (handler.needReportToTarget(player)) new ChatHandler(player.getSession()).pSendSysMessage(L.LANG_YOUR_ITEMS_REPAIRED, nameLink);
  return true;
}

/** @ac scripts/Commands/cs_gear.cpp gear_commandscript::HandleGearStatsCommand */
async function HandleGearStatsCommand(handler: ChatHandler): Promise<boolean> {
  const player = handler.getSelectedPlayerOrSelf();
  if (!player) return false;
  handler.pSendSysMessage("Character: {}", player.getName());
  handler.pSendSysMessage("Current equipment average item level: |cff00ffff{}|r", Math.trunc(player.getAverageItemLevel()));
  if (sWorld().getIntConfig(ServerConfig.CONFIG_MIN_LEVEL_STAT_SAVE)) {
    const [fields] = await queryFields(CharacterDatabase(), CHAR_SEL_CHAR_STATS, player.getGUIDLow());
    if (fields) {
      const [MaxHealth, Strength, Agility, Stamina, Intellect, Spirit, Armor, AttackPower, SpellPower, Resilience] = fields.map(Number);
      handler.pSendSysMessage("Health: |cff00ffff{}|r - Stamina: |cff00ffff{}|r", MaxHealth, Stamina);
      handler.pSendSysMessage("Strength: |cff00ffff{}|r - Agility: |cff00ffff{}|r", Strength, Agility);
      handler.pSendSysMessage("Intellect: |cff00ffff{}|r - Spirit: |cff00ffff{}|r", Intellect, Spirit);
      handler.pSendSysMessage("AttackPower: |cff00ffff{}|r - SpellPower: |cff00ffff{}|r", AttackPower, SpellPower);
      handler.pSendSysMessage("Armor: |cff00ffff{}|r - Resilience: |cff00ffff{}|r", Armor, Resilience);
    }
  }
  return true;
}

/** @ac scripts/Commands/cs_gear.cpp AddSC_gear_commandscript */
export function AddSC_gear_commandscript(): void {
  registerCommandScript(GetCommands);
}
