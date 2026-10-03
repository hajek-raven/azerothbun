/** `cs_script_loader.cpp`: registers every ported command script. */
import { AddSC_account_commandscript } from "./cs_account.ts";
import { AddSC_bag_commandscript } from "./cs_bag.ts";
import { AddSC_ban_commandscript } from "./cs_ban.ts";
import { AddSC_cache_commandscript } from "./cs_cache.ts";
import { AddSC_cast_commandscript } from "./cs_cast.ts";
import { AddSC_character_commandscript } from "./cs_character.ts";
import { AddSC_cheat_commandscript } from "./cs_cheat.ts";
import { AddSC_gear_commandscript } from "./cs_gear.ts";
import { AddSC_gm_commandscript } from "./cs_gm.ts";
import { AddSC_go_commandscript } from "./cs_go.ts";
import { AddSC_honor_commandscript } from "./cs_honor.ts";
import { AddSC_inventory_commandscript } from "./cs_inventory.ts";
import { AddSC_item_commandscript } from "./cs_item.ts";
import { AddSC_learn_commandscript } from "./cs_learn.ts";
import { AddSC_list_commandscript } from "./cs_list.ts";
import { AddSC_lookup_commandscript } from "./cs_lookup.ts";
import { AddSC_message_commandscript } from "./cs_message.ts";
import { AddSC_misc_commandscript } from "./cs_misc.ts";
import { AddSC_modify_commandscript } from "./cs_modify.ts";
import { AddSC_player_commandscript } from "./cs_player.ts";
import { AddSC_player_settings_commandscript } from "./cs_player_settings.ts";
import { AddSC_quest_commandscript } from "./cs_quest.ts";
import { AddSC_rbac_commandscript } from "./cs_rbac.ts";
import { AddSC_reset_commandscript } from "./cs_reset.ts";
import { AddSC_server_commandscript } from "./cs_server.ts";
import { AddSC_tele_commandscript } from "./cs_tele.ts";
import { AddSC_titles_commandscript } from "./cs_titles.ts";

/** @ac scripts/Commands/cs_script_loader.cpp AddCommandsScripts */
export function AddCommandsScripts(): void {
  AddSC_account_commandscript();
  AddSC_bag_commandscript();
  AddSC_ban_commandscript();
  AddSC_cache_commandscript();
  AddSC_cast_commandscript();
  AddSC_character_commandscript();
  AddSC_cheat_commandscript();
  AddSC_gear_commandscript();
  AddSC_gm_commandscript();
  AddSC_go_commandscript();
  AddSC_honor_commandscript();
  AddSC_inventory_commandscript();
  AddSC_item_commandscript();
  AddSC_learn_commandscript();
  AddSC_list_commandscript();
  AddSC_lookup_commandscript();
  AddSC_message_commandscript();
  AddSC_misc_commandscript();
  AddSC_modify_commandscript();
  AddSC_player_commandscript();
  AddSC_player_settings_commandscript();
  AddSC_quest_commandscript();
  AddSC_rbac_commandscript();
  AddSC_reset_commandscript();
  AddSC_server_commandscript();
  AddSC_tele_commandscript();
  AddSC_titles_commandscript();
}
