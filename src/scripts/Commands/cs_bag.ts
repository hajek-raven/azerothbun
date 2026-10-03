/** `cs_bag.cpp`: `.bags clear <quality>`. */
import * as R from "../../game/Accounts/RBACDefines.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { Tail } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { ItemQualityColors } from "../../game/Chat/Hyperlinks.ts";
import { sObjectMgr } from "../../game/Globals/ObjectMgr.ts";

const INVENTORY_SLOT_BAG_0 = 255;
const INVENTORY_SLOT_BAG_START = 19;
const INVENTORY_SLOT_BAG_END = 23;
const INVENTORY_SLOT_ITEM_START = 23;
const INVENTORY_SLOT_ITEM_END = 39;
const ITEM_QUALITY_POOR = 0;
const ITEM_QUALITY_HEIRLOOM = 7;
const MAX_ITEM_QUALITY = 8;

/** @ac scripts/Commands/cs_bag.cpp itemQualityToString */
const itemQualityToString = ["poor", "normal", "uncommon", "rare", "epic", "legendary", "artifact", "all"] as const;

/** @ac scripts/Commands/cs_bag.cpp bg_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  return [ChatCommand("bags clear", [Tail], HandleBagsClearCommand, R.RBAC_PERM_COMMAND_ADDITEM, Console.No)];
}

/** @ac scripts/Commands/cs_bag.cpp bg_commandscript::HandleBagsClearCommand */
async function HandleBagsClearCommand(handler: ChatHandler, args: string): Promise<boolean> {
  if (!args) return false;
  const player = handler.getSession()?.getPlayer();
  if (!player) return false;
  let itemQuality = MAX_ITEM_QUALITY;
  for (let i = ITEM_QUALITY_POOR; i < MAX_ITEM_QUALITY; ++i) {
    if (args === itemQualityToString[i]) {
      itemQuality = i;
      break;
    }
  }
  if (itemQuality === MAX_ITEM_QUALITY) return false;
  const removedItems = new Array<number>(MAX_ITEM_QUALITY).fill(0);
  const clear = async (bag: number, slot: number): Promise<void> => {
    const item = player.getItemByPos(bag, slot);
    const itemTemplate = item ? sObjectMgr.getItemTemplate(item.entry) : null;
    if (itemTemplate && itemTemplate.quality <= itemQuality) {
      await player.destroyItem(bag, slot);
      ++removedItems[itemTemplate.quality]!;
    }
  };
  // in inventory
  for (let i = INVENTORY_SLOT_ITEM_START; i < INVENTORY_SLOT_ITEM_END; ++i) await clear(INVENTORY_SLOT_BAG_0, i);
  // in inventory bags
  for (let i = INVENTORY_SLOT_BAG_START; i < INVENTORY_SLOT_BAG_END; i++) {
    const bag = player.getBagByPos(i);
    if (!bag) continue;
    for (let j = 0; j < bag.size; j++) await clear(i, j);
  }
  let str = "Removed ";
  if (itemQuality === ITEM_QUALITY_HEIRLOOM) {
    str += "all";
  } else {
    let initialize = true;
    for (let i = ITEM_QUALITY_POOR; i < MAX_ITEM_QUALITY; ++i) {
      const itemCount = removedItems[i]!;
      if (!itemCount) continue;
      if (!initialize) str += ", ";
      str += `|c${(ItemQualityColors[i] ?? 0).toString(16)}${itemCount} ${itemQualityToString[i]}|r`;
      initialize = false;
    }
  }
  str += " items from your bags.";
  handler.sendSysMessage(str);
  return true;
}

/** @ac scripts/Commands/cs_bag.cpp AddSC_bag_commandscript */
export function AddSC_bag_commandscript(): void {
  registerCommandScript(GetCommands);
}
