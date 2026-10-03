/** `cs_player_settings.cpp`: `.settings announcer <type> <on|off>`. */
import * as R from "../../game/Accounts/RBACDefines.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { boolArg, stringArg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import {
  ANNOUNCER_FLAG_DISABLE_ARENA_QUEUE,
  ANNOUNCER_FLAG_DISABLE_AUTOBROADCAST,
  ANNOUNCER_FLAG_DISABLE_BG_QUEUE,
  ANNOUNCER_FLAG_DISABLE_PVP_ALL,
  ANNOUNCER_FLAG_DISABLE_PVP_START,
  AzerothcorePSSource,
  SETTING_ANNOUNCER_FLAGS,
} from "../../game/Entities/Player/PlayerSettings.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { ServerConfig } from "../../game/world/world-config.ts";
import { sWorld } from "../../game/world/world.ts";

/** @ac scripts/Commands/cs_player_settings.cpp player_settings_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const playerSettingsCommandTable: ChatCommandTable = [ChatCommand("announcer", [stringArg, boolArg], HandleSettingsAnnouncerFlags, R.RBAC_PERM_COMMAND_SETTINGS_ANNOUNCER, Console.No)];
  return [SubCommands("settings", playerSettingsCommandTable)];
}

/** @ac scripts/Commands/cs_player_settings.cpp player_settings_commandscript::HandleSettingsAnnouncerFlags */
function HandleSettingsAnnouncerFlags(handler: ChatHandler, type: string, on: boolean): boolean {
  const player = handler.getPlayer()!;
  let setting = player.getPlayerSetting(AzerothcorePSSource, SETTING_ANNOUNCER_FLAGS);
  let label: string | null = null;
  // PlayerSetting::AddFlag / RemoveFlag
  const apply = (flag: number): void => {
    setting = on ? setting & ~flag : setting | flag;
    player.updatePlayerSetting(AzerothcorePSSource, SETTING_ANNOUNCER_FLAGS, setting >>> 0);
  };
  if (type === "bg") {
    apply(ANNOUNCER_FLAG_DISABLE_BG_QUEUE);
    label = "battleground queue";
  } else if (type === "arena") {
    apply(ANNOUNCER_FLAG_DISABLE_ARENA_QUEUE);
    label = "arena queue";
  } else if (type === "pvpstart") {
    apply(ANNOUNCER_FLAG_DISABLE_PVP_START);
    label = "PvP start";
  } else if (type === "pvpall") {
    apply(ANNOUNCER_FLAG_DISABLE_PVP_ALL);
    label = "PvP";
  } else if (type === "autobroadcast") {
    const minLevel = sWorld().getIntConfig(ServerConfig.CONFIG_AUTOBROADCAST_MIN_LEVEL_DISABLE);
    if (player.getLevel() < minLevel) {
      handler.setSentErrorMessage(true);
      handler.pSendSysMessage(L.LANG_CMD_AUTOBROADCAST_LVL_ERROR, minLevel);
    }
    apply(ANNOUNCER_FLAG_DISABLE_AUTOBROADCAST);
    label = "autobroadcast";
  }
  handler.setSentErrorMessage(false);
  handler.pSendSysMessage(on ? L.LANG_CMD_SETTINGS_ANNOUNCER_ON : L.LANG_CMD_SETTINGS_ANNOUNCER_OFF, label ?? type);
  return true;
}

/** @ac scripts/Commands/cs_player_settings.cpp AddSC_player_settings_commandscript */
export function AddSC_player_settings_commandscript(): void {
  registerCommandScript(GetCommands);
}
