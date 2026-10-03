/**
 * `cs_item.cpp`: `.item restore list`, `.item move`, `.item refund`. `.item restore` mails the item back, and mail is
 * not ported, so it is not registered; the offline refund cannot mail the currency items either.
 */
import { commitTransaction, queryFields, type StatementTransaction } from "../../database/database.ts";
import { CharacterDatabase } from "../../database/DatabaseEnv.ts";
import * as C from "../../gen/CharacterDatabase.gen.ts";
import * as R from "../../game/Accounts/RBACDefines.ts";
import { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { uint32Arg, uint8Arg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { PlayerIdentifierArg, type PlayerIdentifier } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { sItemExtendedCostStore } from "../../game/DataStores/DBCStores.ts";
import { sObjectMgr } from "../../game/Globals/ObjectMgr.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { ServerConfig } from "../../game/world/world-config.ts";
import { sWorld } from "../../game/world/world.ts";
import { isBankPos, isEquipmentPos, isInventoryPos } from "../../items/bags.ts";

const INVENTORY_SLOT_BAG_0 = 255;

/** @ac scripts/Commands/cs_item.cpp item_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const HandleItemRestoreCommandTable: ChatCommandTable = [ChatCommand("list", [PlayerIdentifierArg], HandleItemRestoreListCommand, R.RBAC_PERM_COMMAND_ITEM_RESTORE_LIST, Console.Yes)];
  const itemCommandTable: ChatCommandTable = [
    SubCommands("restore", HandleItemRestoreCommandTable),
    ChatCommand("move", [uint8Arg, uint8Arg], HandleItemMoveCommand, R.RBAC_PERM_COMMAND_ITEMMOVE, Console.Yes),
    ChatCommand("refund", [PlayerIdentifierArg, uint32Arg, uint32Arg], HandleItemRefundCommand, R.RBAC_PERM_COMMAND_ITEM_REFUND, Console.Yes),
  ];
  return [SubCommands("item", itemCommandTable)];
}

/** @ac scripts/Commands/cs_item.cpp item_commandscript::HasItemDeletionConfig */
function HasItemDeletionConfig(): boolean {
  return sWorld().getBoolConfig(ServerConfig.CONFIG_ITEMDELETE_METHOD) || sWorld().getBoolConfig(ServerConfig.CONFIG_ITEMDELETE_VENDOR);
}

/** @ac scripts/Commands/cs_item.cpp item_commandscript::HandleItemRestoreListCommand */
async function HandleItemRestoreListCommand(handler: ChatHandler, player: PlayerIdentifier): Promise<boolean> {
  if (!HasItemDeletionConfig()) {
    handler.sendErrorMessage(L.LANG_COMMAND_DISABLED);
    return false;
  }
  const disposedItems = await queryFields(CharacterDatabase(), C.CHAR_SEL_RECOVERY_ITEM_LIST, player.getGUID());
  if (disposedItems.length === 0) {
    handler.sendErrorMessage(L.LANG_ITEM_RESTORE_LIST_EMPTY);
    return false;
  }
  for (const fields of disposedItems) {
    const itemId = Number(fields[1]);
    handler.pSendSysMessage(L.LANG_ITEM_RESTORE_LIST, Number(fields[0]), sObjectMgr.getItemTemplate(itemId)?.name ?? "", itemId, Number(fields[2]));
  }
  return true;
}

/** @ac game/Entities/Player/PlayerStorage.cpp Player::IsValidPos (for the player's own slots) */
function IsValidPos(slot: number, explicitPos: boolean): boolean {
  // bag / slot pair: the equipment, backpack, bank, keyring, and currency slots of `INVENTORY_SLOT_BAG_0`
  if (isEquipmentPos(INVENTORY_SLOT_BAG_0, slot) || isInventoryPos(INVENTORY_SLOT_BAG_0, slot) || isBankPos(INVENTORY_SLOT_BAG_0, slot)) return true;
  return !explicitPos && slot === 255;
}

/** @ac scripts/Commands/cs_item.cpp item_commandscript::HandleItemMoveCommand */
async function HandleItemMoveCommand(handler: ChatHandler, srcSlot: number, dstSlot: number): Promise<boolean> {
  if (srcSlot === dstSlot) return true;
  if (!IsValidPos(srcSlot, true)) return false;
  if (!IsValidPos(dstSlot, false)) return false;
  await handler.getSession()!.swapInvItem(srcSlot, dstSlot);
  return true;
}

/** @ac scripts/Commands/cs_item.cpp item_commandscript::HandleItemRefundCommand */
async function HandleItemRefundCommand(handler: ChatHandler, player: PlayerIdentifier, itemId: number, extendedCost: number): Promise<boolean> {
  const iece = sItemExtendedCostStore.lookupEntry(extendedCost);
  if (!iece) {
    handler.sendErrorMessage(L.LANG_CMD_ITEM_REFUND_BAD_EXTENDED_COST);
    return false;
  }
  const item = sObjectMgr.getItemTemplate(itemId);
  if (!item) {
    handler.sendErrorMessage(L.LANG_COMMAND_ITEMIDINVALID, itemId);
    return false;
  }
  const maxHonor = sWorld().getIntConfig(ServerConfig.CONFIG_MAX_HONOR_POINTS);
  const maxArena = sWorld().getIntConfig(ServerConfig.CONFIG_MAX_ARENA_POINTS);
  const target = player.getConnectedPlayer();
  if (target) {
    if (!target.hasItemCount(itemId, 1, true)) {
      handler.sendErrorMessage(L.LANG_CMD_ITEM_REFUND_NOT_FOUND, itemId);
      return false;
    }
    const targetChat = new ChatHandler(target.getSession());
    if (iece.reqhonorpoints) {
      const honor = target.getHonorPoints() + iece.reqhonorpoints;
      if (honor > maxHonor) {
        handler.sendErrorMessage(L.LANG_CMD_ITEM_REFUND_MAX_HONOR, item.name, item.entry, maxHonor, target.getHonorPoints(), iece.reqhonorpoints);
        targetChat.pSendSysMessage(L.LANG_CMD_ITEM_REFUND_HONOR_FAILED, item.name);
        return false;
      }
      target.setHonorPoints(honor);
      targetChat.pSendSysMessage(L.LANG_CMD_ITEM_REFUNDED_HONOR, item.name, item.entry, iece.reqhonorpoints);
      handler.pSendSysMessage(L.LANG_CMD_ITEM_REFUNDED_HONOR, item.name, item.entry, iece.reqhonorpoints);
    }
    if (iece.reqarenapoints) {
      const arenapoints = target.getArenaPoints() + iece.reqarenapoints;
      if (arenapoints > maxArena) {
        handler.sendErrorMessage(L.LANG_CMD_ITEM_REFUND_MAX_AP, item.name, item.entry, maxArena, target.getArenaPoints(), iece.reqarenapoints);
        targetChat.pSendSysMessage(L.LANG_CMD_ITEM_REFUND_AP_FAILED, item.name);
        return false;
      }
      target.setArenaPoints(arenapoints);
      targetChat.pSendSysMessage(L.LANG_CMD_ITEM_REFUNDED_AP, item.name, item.entry, iece.reqarenapoints);
      handler.pSendSysMessage(L.LANG_CMD_ITEM_REFUNDED_AP, item.name, item.entry, iece.reqarenapoints);
    }
    for (let count = 0; count < iece.reqitem.length; ++count) {
      const reqItem = iece.reqitem[count]!;
      if (reqItem) await target.addItem(reqItem, iece.reqitemcount[count] ?? 0, null);
    }
    await target.destroyItemCount(itemId, 1);
    return true;
  }
  const guid = player.getGUID();
  const [result] = await queryFields(CharacterDatabase(), C.CHAR_SEL_CHAR_INVENTORY_ITEM_BY_ENTRY_AND_OWNER, itemId, guid);
  if (!result) {
    handler.sendErrorMessage(L.LANG_CMD_ITEM_REFUND_NOT_FOUND, itemId);
    return false;
  }
  const trans: StatementTransaction = [];
  if (iece.reqhonorpoints) {
    const [fields] = await queryFields(CharacterDatabase(), C.CHAR_SEL_HONORPOINTS, guid);
    if (fields && Number(fields[0]) + iece.reqhonorpoints > maxHonor) {
      handler.sendErrorMessage(L.LANG_CMD_ITEM_REFUND_MAX_HONOR, item.name, item.entry, maxHonor, Number(fields[0]), iece.reqhonorpoints);
      return false;
    }
    trans.push([C.CHAR_UDP_CHAR_HONOR_POINTS_ACCUMULATIVE, iece.reqhonorpoints, guid]);
    handler.pSendSysMessage(L.LANG_CMD_ITEM_REFUNDED_HONOR, item.name, item.entry, iece.reqhonorpoints);
  }
  if (iece.reqarenapoints) {
    const [fields] = await queryFields(CharacterDatabase(), C.CHAR_SEL_ARENAPOINTS, guid);
    // AzerothCore compares with the honor points here.
    if (fields && Number(fields[0]) + iece.reqhonorpoints > maxArena) {
      handler.sendErrorMessage(L.LANG_CMD_ITEM_REFUND_MAX_AP, item.name, item.entry, maxArena, Number(fields[0]), iece.reqarenapoints);
      return false;
    }
    trans.push([C.CHAR_UDP_CHAR_ARENA_POINTS_ACCUMULATIVE, iece.reqarenapoints, guid]);
    handler.pSendSysMessage(L.LANG_CMD_ITEM_REFUNDED_AP, item.name, item.entry, iece.reqarenapoints);
  }
  // The currency items are mailed in AzerothCore ("Item Refund"); mail is not ported.
  trans.push([C.CHAR_DEL_CHAR_INVENTORY_BY_ITEM, Number(result[0])], [C.CHAR_DEL_ITEM_INSTANCE, Number(result[0])]);
  await commitTransaction(CharacterDatabase(), trans);
  return true;
}

/** @ac scripts/Commands/cs_item.cpp AddSC_item_commandscript */
export function AddSC_item_commandscript(): void {
  registerCommandScript(GetCommands);
}
