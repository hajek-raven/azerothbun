/** `cs_inventory.cpp`: `.inventory count`. */
import * as R from "../../game/Accounts/RBACDefines.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { Optional } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { PlayerIdentifier, PlayerIdentifierArg } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { sObjectMgr } from "../../game/Globals/ObjectMgr.ts";
import * as L from "../../game/Miscellaneous/Language.ts";

const INVENTORY_SLOT_BAG_0 = 255;
const INVENTORY_SLOT_BAG_START = 19;
const INVENTORY_SLOT_BAG_END = 23;
const INVENTORY_SLOT_ITEM_START = 23;
const INVENTORY_SLOT_ITEM_END = 39;
const ITEM_CLASS_CONTAINER = 1;
const ITEM_CLASS_QUIVER = 11;
const ITEM_SUBCLASS_CONTAINER = 0;
const MAX_ITEM_SUBCLASS_CONTAINER = 9;

/** @ac scripts/Commands/cs_inventory.cpp bagSpecsToString */
const bagSpecsToString = ["normal", "soul", "herb", "enchanting", "engineering", "gem", "mining", "leatherworking", "inscription"] as const;
/** @ac scripts/Commands/cs_inventory.cpp bagSpecsColors */
const bagSpecsColors = [0xfff0de18, 0xffa335ee, 0xff1eff00, 0xffe37166, 0xffa68b30, 0xff0070dd, 0xffc1c8c9, 0xfff5a925, 0xff54504f] as const;

/** @ac scripts/Commands/cs_inventory.cpp inventory_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const inventoryCommandTable: ChatCommandTable = [ChatCommand("count", [Optional(PlayerIdentifierArg)], HandleInventoryCountCommand, R.RBAC_PERM_COMMAND_ADDITEM, Console.No)];
  return [SubCommands("inventory", inventoryCommandTable)];
}

/** @ac scripts/Commands/cs_inventory.cpp inventory_commandscript::HandleInventoryCountCommand */
function HandleInventoryCountCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null): boolean {
  const player = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!player) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  const target = player.getConnectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  const freeSlotsInBags = new Array<number>(MAX_ITEM_SUBCLASS_CONTAINER).fill(0);
  let freeSlotsForBags = 0;
  let haveFreeSlot = false;
  // Check backpack
  for (let slot = INVENTORY_SLOT_ITEM_START; slot < INVENTORY_SLOT_ITEM_END; ++slot) {
    if (!target.getItemByPos(INVENTORY_SLOT_BAG_0, slot)) {
      haveFreeSlot = true;
      ++freeSlotsInBags[ITEM_SUBCLASS_CONTAINER]!;
    }
  }
  // Check bags
  for (let i = INVENTORY_SLOT_BAG_START; i < INVENTORY_SLOT_BAG_END; i++) {
    const bag = target.getBagByPos(i);
    if (bag) {
      const bagTemplate = sObjectMgr.getItemTemplate(bag.entry);
      if (bagTemplate && (bagTemplate.classId === ITEM_CLASS_CONTAINER || bagTemplate.classId === ITEM_CLASS_QUIVER)) {
        haveFreeSlot = true;
        freeSlotsInBags[bagTemplate.subclass] = (freeSlotsInBags[bagTemplate.subclass] ?? 0) + bag.freeSlots;
      }
    } else {
      ++freeSlotsForBags;
    }
  }
  let str: string;
  if (haveFreeSlot) {
    str = `Player ${target.getName()} have `;
    let initialize = true;
    for (let i = ITEM_SUBCLASS_CONTAINER; i < MAX_ITEM_SUBCLASS_CONTAINER; ++i) {
      const freeSlots = freeSlotsInBags[i]!;
      if (!freeSlots) continue;
      if (!initialize) str += ", ";
      str += `|c${bagSpecsColors[i]!.toString(16)}${freeSlots} in ${bagSpecsToString[i]} bags|r`;
      initialize = false;
    }
  } else {
    str = `Player ${target.getName()} does not have free slots in their bags`;
  }
  if (freeSlotsForBags) str += ` and also has ${freeSlotsForBags} free slots for bags`;
  str += ".";
  handler.sendSysMessage(str);
  return true;
}

/** @ac scripts/Commands/cs_inventory.cpp AddSC_inventory_commandscript */
export function AddSC_inventory_commandscript(): void {
  registerCommandScript(GetCommands);
}
