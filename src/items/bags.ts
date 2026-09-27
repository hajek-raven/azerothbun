/**
 * Bags, backpack, bank, and keyring — port of AzerothCore Player inventory slots
 * and CanStoreItem / ItemCanGoIntoBag / bank / keyring rules.
 *
 * Session hooks (wire later in session.ts; this module does not import session):
 *   CMSG_AUTOSTORE_BAG_ITEM   0x10B → autoStoreBagItem
 *   CMSG_SWAP_ITEM            0x10C → swapItem
 *   CMSG_SWAP_INV_ITEM        0x10D → swapInvItem
 *   CMSG_SPLIT_ITEM           0x10E → splitItem
 *   CMSG_DESTROYITEM          0x111 → destroyItem
 *   CMSG_BUY_BANK_SLOT        0x1B9 → buyBankSlot
 *   CMSG_AUTOSTORE_BANK_ITEM  0x282 → autoStoreBankItem
 *   CMSG_AUTOBANK_ITEM        0x283 → autoBankItem
 *   SMSG_INVENTORY_CHANGE_FAILURE 0x112 → buildInventoryChangeFailure
 *   SMSG_BUY_BANK_SLOT_RESULT 0x1BA → buildBuyBankSlotResult
 */

import { asc, eq } from "drizzle-orm";
import type { Db } from "../database/database.ts";
import { character_inventory } from "../database/schema/characters.ts";
import { ByteWriter } from "../net/byte-buffer.ts";
import { canMergeWith, getMaxStackSize } from "./stacks.ts";

// --- Slot enums from Player.h (exact values) ---

export const INVENTORY_SLOT_BAG_0 = 255;

export const EQUIPMENT_SLOT_START = 0;
export const EQUIPMENT_SLOT_HEAD = 0;
export const EQUIPMENT_SLOT_NECK = 1;
export const EQUIPMENT_SLOT_SHOULDERS = 2;
export const EQUIPMENT_SLOT_BODY = 3;
export const EQUIPMENT_SLOT_CHEST = 4;
export const EQUIPMENT_SLOT_WAIST = 5;
export const EQUIPMENT_SLOT_LEGS = 6;
export const EQUIPMENT_SLOT_FEET = 7;
export const EQUIPMENT_SLOT_WRISTS = 8;
export const EQUIPMENT_SLOT_HANDS = 9;
export const EQUIPMENT_SLOT_FINGER1 = 10;
export const EQUIPMENT_SLOT_FINGER2 = 11;
export const EQUIPMENT_SLOT_TRINKET1 = 12;
export const EQUIPMENT_SLOT_TRINKET2 = 13;
export const EQUIPMENT_SLOT_BACK = 14;
export const EQUIPMENT_SLOT_MAINHAND = 15;
export const EQUIPMENT_SLOT_OFFHAND = 16;
export const EQUIPMENT_SLOT_RANGED = 17;
export const EQUIPMENT_SLOT_TABARD = 18;
export const EQUIPMENT_SLOT_END = 19;

export const INVENTORY_SLOT_BAG_START = 19;
export const INVENTORY_SLOT_BAG_END = 23;

export const INVENTORY_SLOT_ITEM_START = 23;
export const INVENTORY_SLOT_ITEM_END = 39;

export const BANK_SLOT_ITEM_START = 39;
export const BANK_SLOT_ITEM_END = 67;

export const BANK_SLOT_BAG_START = 67;
export const BANK_SLOT_BAG_END = 74;

export const BUYBACK_SLOT_START = 74;
export const BUYBACK_SLOT_END = 86;

export const KEYRING_SLOT_START = 86;
export const KEYRING_SLOT_END = 118;

export const CURRENCYTOKEN_SLOT_START = 118;
export const CURRENCYTOKEN_SLOT_END = 150;

export const NULL_BAG = 0;
export const NULL_SLOT = 255;

export const PLAYER_SLOT_END = CURRENCYTOKEN_SLOT_END;

// --- Item class / bag family (ItemTemplate.h) ---

export const ITEM_CLASS_CONTAINER = 1;
export const ITEM_CLASS_QUIVER = 11;
export const ITEM_CLASS_KEY = 13;
export const ITEM_CLASS_ARMOR = 4;

export const ITEM_SUBCLASS_CONTAINER = 0;
export const ITEM_SUBCLASS_SOUL_CONTAINER = 1;
export const ITEM_SUBCLASS_HERB_CONTAINER = 2;
export const ITEM_SUBCLASS_ENCHANTING_CONTAINER = 3;
export const ITEM_SUBCLASS_ENGINEERING_CONTAINER = 4;
export const ITEM_SUBCLASS_GEM_CONTAINER = 5;
export const ITEM_SUBCLASS_MINING_CONTAINER = 6;
export const ITEM_SUBCLASS_LEATHERWORKING_CONTAINER = 7;
export const ITEM_SUBCLASS_INSCRIPTION_CONTAINER = 8;

export const ITEM_SUBCLASS_QUIVER = 2;
export const ITEM_SUBCLASS_AMMO_POUCH = 3;

export const INVTYPE_BAG = 18;

export const BAG_FAMILY_MASK_NONE = 0x00000000;
export const BAG_FAMILY_MASK_ARROWS = 0x00000001;
export const BAG_FAMILY_MASK_BULLETS = 0x00000002;
export const BAG_FAMILY_MASK_SOUL_SHARDS = 0x00000004;
export const BAG_FAMILY_MASK_LEATHERWORKING_SUPP = 0x00000008;
export const BAG_FAMILY_MASK_INSCRIPTION_SUPP = 0x00000010;
export const BAG_FAMILY_MASK_HERBS = 0x00000020;
export const BAG_FAMILY_MASK_ENCHANTING_SUPP = 0x00000040;
export const BAG_FAMILY_MASK_ENGINEERING_SUPP = 0x00000080;
export const BAG_FAMILY_MASK_KEYS = 0x00000100;
export const BAG_FAMILY_MASK_GEMS = 0x00000200;
export const BAG_FAMILY_MASK_MINING_SUPP = 0x00000400;
export const BAG_FAMILY_MASK_SOULBOUND_EQUIPMENT = 0x00000800;
export const BAG_FAMILY_MASK_VANITY_PETS = 0x00001000;
export const BAG_FAMILY_MASK_CURRENCY_TOKENS = 0x00002000;
export const BAG_FAMILY_MASK_QUEST_ITEMS = 0x00004000;

// --- InventoryResult (Item.h) — values used by this module ---

export const EQUIP_ERR_OK = 0;
export const EQUIP_ERR_ITEM_DOESNT_GO_TO_SLOT = 3;
export const EQUIP_ERR_BAG_FULL = 4;
export const EQUIP_ERR_NONEMPTY_BAG_OVER_OTHER_BAG = 5;
export const EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG = 15;
export const EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG2 = 16;
export const EQUIP_ERR_CANT_CARRY_MORE_OF_THIS = 17;
export const EQUIP_ERR_ITEM_CANT_STACK = 19;
export const EQUIP_ERR_ITEM_CANT_BE_EQUIPPED = 20;
export const EQUIP_ERR_ITEMS_CANT_BE_SWAPPED = 21;
export const EQUIP_ERR_SLOT_IS_EMPTY = 22;
export const EQUIP_ERR_ITEM_NOT_FOUND = 23;
export const EQUIP_ERR_TRIED_TO_SPLIT_MORE_THAN_COUNT = 26;
export const EQUIP_ERR_COULDNT_SPLIT_ITEMS = 27;
export const EQUIP_ERR_NOT_A_BAG = 30;
export const EQUIP_ERR_CAN_ONLY_DO_WITH_EMPTY_BAGS = 31;
export const EQUIP_ERR_MUST_PURCHASE_THAT_BAG_SLOT = 34;
export const EQUIP_ERR_ALREADY_LOOTED = 49;
export const EQUIP_ERR_INVENTORY_FULL = 50;
export const EQUIP_ERR_BANK_FULL = 51;
export const EQUIP_ERR_NONE = 59;
export const EQUIP_ERR_TOO_MUCH_GOLD = 77;
export const EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED = 84;
export const EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_SOCKETED_EXCEEDED = 85;
export const EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_EQUIPPED_EXCEEDED = 86;

export const SMSG_INVENTORY_CHANGE_FAILURE = 0x112;
/** SMSG_ITEM_PUSH_RESULT */
export const SMSG_ITEM_PUSH_RESULT = 0x166;
export const CMSG_AUTOSTORE_BAG_ITEM = 0x10b;
export const CMSG_SWAP_ITEM = 0x10c;
export const CMSG_SWAP_INV_ITEM = 0x10d;
export const CMSG_SPLIT_ITEM = 0x10e;
export const CMSG_DESTROYITEM = 0x111;
export const CMSG_BUY_BANK_SLOT = 0x1b9;
export const SMSG_BUY_BANK_SLOT_RESULT = 0x1ba;
export const CMSG_AUTOSTORE_BANK_ITEM = 0x282;
export const CMSG_AUTOBANK_ITEM = 0x283;

/** BankBagSlotPrices.dbc Costs for slots 1..7 (copper). */
export const BANK_BAG_SLOT_PRICES: readonly number[] = [
  1000, 10_000, 100_000, 250_000, 500_000, 1_000_000, 1_000_000,
];

export const ERR_BANKSLOT_FAILED_TOO_MANY = 0;
export const ERR_BANKSLOT_INSUFFICIENT_FUNDS = 1;
export const ERR_BANKSLOT_NOTBANKER = 2;
export const ERR_BANKSLOT_OK = 3;

/** Slice of item_template columns needed for bag / slot checks. */
export type ItemTemplateSlice = {
  entry: number;
  InventoryType: number;
  ContainerSlots: number;
  BagFamily: number;
  class: number;
  subclass: number;
  bonding: number;
  /** `item_template.stackable`; missing → treat as 1. */
  stackable?: number;
  /** `item_template.displayid`; used by item create packets. */
  displayid?: number;
  /** `item_template.maxcount`: the unique cap (`CanTakeMoreSimilarItems`). */
  maxcount?: number;
  /** `item_template.ItemLimitCategory` */
  ItemLimitCategory?: number;
};

export type InventoryItem = {
  guid: number;
  entry: number;
  count: number;
  template: ItemTemplateSlice;
};

/** character_inventory row (AzerothCore column names). */
export type CharacterInventoryRow = {
  guid: number;
  bag: number;
  slot: number;
  item: number;
};

/** Packet-facing slot change: bag is storage bag guid (0 = player). */
export type SlotChange = {
  bag: number;
  slot: number;
  itemGuid: number | null;
};

export type InventoryOpResult = {
  ok: boolean;
  error: number;
  changes: SlotChange[];
};

export type Inventory = {
  /** characters.bankSlots — purchased bank bag slots (0..7). */
  bankSlots: number;
  /** bag guid → slot → item. bag 0 = player inventory. */
  slots: Map<number, Map<number, InventoryItem>>;
  /** item guid → position */
  byGuid: Map<number, { bag: number; slot: number }>;
};

export function createInventory(bankSlots = 0): Inventory {
  return {
    bankSlots,
    slots: new Map(),
    byGuid: new Map(),
  };
}

export async function loadInventory(db: Db, guid: number): Promise<CharacterInventoryRow[]> {
  return db
    .select({ guid: character_inventory.guid, bag: character_inventory.bag, slot: character_inventory.slot, item: character_inventory.item })
    .from(character_inventory)
    .where(eq(character_inventory.guid, guid))
    .orderBy(asc(character_inventory.bag), asc(character_inventory.slot));
}

export async function saveInventoryRows(db: Db, characterGuid: number, rows: CharacterInventoryRow[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(character_inventory).where(eq(character_inventory.guid, characterGuid));
    if (rows.length > 0) {
      await tx
        .insert(character_inventory)
        .values(rows.map((row) => ({ guid: characterGuid, bag: row.bag, slot: row.slot, item: row.item })));
    }
  });
}

export function inventoryToRows(characterGuid: number, inv: Inventory): CharacterInventoryRow[] {
  const rows: CharacterInventoryRow[] = [];
  for (const [bag, bagSlots] of inv.slots) {
    for (const [slot, item] of bagSlots) {
      rows.push({ guid: characterGuid, bag, slot, item: item.guid });
    }
  }
  return rows;
}

export function getItem(inv: Inventory, bag: number, slot: number): InventoryItem | null {
  return inv.slots.get(bag)?.get(slot) ?? null;
}

export function getItemPos(
  inv: Inventory,
  itemGuid: number,
): { bag: number; slot: number } | null {
  return inv.byGuid.get(itemGuid) ?? null;
}

function bagMap(inv: Inventory, bag: number): Map<number, InventoryItem> {
  let map = inv.slots.get(bag);
  if (!map) {
    map = new Map();
    inv.slots.set(bag, map);
  }
  return map;
}

function placeItem(inv: Inventory, bag: number, slot: number, item: InventoryItem): void {
  const prev = inv.byGuid.get(item.guid);
  if (prev) {
    inv.slots.get(prev.bag)?.delete(prev.slot);
  }
  bagMap(inv, bag).set(slot, item);
  inv.byGuid.set(item.guid, { bag, slot });
}

function clearSlot(inv: Inventory, bag: number, slot: number): InventoryItem | null {
  const map = inv.slots.get(bag);
  if (!map) {
    return null;
  }
  const item = map.get(slot) ?? null;
  if (item) {
    map.delete(slot);
    inv.byGuid.delete(item.guid);
  }
  return item;
}

export function isBagItem(template: ItemTemplateSlice): boolean {
  return template.InventoryType === INVTYPE_BAG || template.ContainerSlots > 0;
}

export function isKeyItem(template: ItemTemplateSlice): boolean {
  return (template.BagFamily & BAG_FAMILY_MASK_KEYS) !== 0 || template.class === ITEM_CLASS_KEY;
}

export function isCurrencyToken(template: ItemTemplateSlice): boolean {
  return (template.BagFamily & BAG_FAMILY_MASK_CURRENCY_TOKENS) !== 0;
}

/** ItemCanGoIntoBag from Item.cpp */
export function itemCanGoIntoBag(
  proto: ItemTemplateSlice,
  bagProto: ItemTemplateSlice,
): boolean {
  switch (bagProto.class) {
    case ITEM_CLASS_CONTAINER: {
      if (bagProto.subclass === ITEM_SUBCLASS_CONTAINER) {
        return true;
      }
      if (proto.class === ITEM_CLASS_CONTAINER) {
        return false;
      }
      switch (bagProto.subclass) {
        case ITEM_SUBCLASS_SOUL_CONTAINER:
          return (proto.BagFamily & BAG_FAMILY_MASK_SOUL_SHARDS) !== 0;
        case ITEM_SUBCLASS_HERB_CONTAINER:
          return (proto.BagFamily & BAG_FAMILY_MASK_HERBS) !== 0;
        case ITEM_SUBCLASS_ENCHANTING_CONTAINER:
          return (proto.BagFamily & BAG_FAMILY_MASK_ENCHANTING_SUPP) !== 0;
        case ITEM_SUBCLASS_MINING_CONTAINER:
          return (proto.BagFamily & BAG_FAMILY_MASK_MINING_SUPP) !== 0;
        case ITEM_SUBCLASS_ENGINEERING_CONTAINER:
          return (proto.BagFamily & BAG_FAMILY_MASK_ENGINEERING_SUPP) !== 0;
        case ITEM_SUBCLASS_GEM_CONTAINER:
          return (proto.BagFamily & BAG_FAMILY_MASK_GEMS) !== 0;
        case ITEM_SUBCLASS_LEATHERWORKING_CONTAINER:
          return (proto.BagFamily & BAG_FAMILY_MASK_LEATHERWORKING_SUPP) !== 0;
        case ITEM_SUBCLASS_INSCRIPTION_CONTAINER:
          return (proto.BagFamily & BAG_FAMILY_MASK_INSCRIPTION_SUPP) !== 0;
        default:
          return false;
      }
    }
    case ITEM_CLASS_QUIVER: {
      if (proto.class === ITEM_CLASS_QUIVER) {
        return false;
      }
      switch (bagProto.subclass) {
        case ITEM_SUBCLASS_QUIVER:
          return (proto.BagFamily & BAG_FAMILY_MASK_ARROWS) !== 0;
        case ITEM_SUBCLASS_AMMO_POUCH:
          return (proto.BagFamily & BAG_FAMILY_MASK_BULLETS) !== 0;
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

export function isEquipmentPos(bag: number, slot: number): boolean {
  if (bag === 0 || bag === INVENTORY_SLOT_BAG_0) {
    if (slot < EQUIPMENT_SLOT_END) {
      return true;
    }
    if (slot >= INVENTORY_SLOT_BAG_START && slot < INVENTORY_SLOT_BAG_END) {
      return true;
    }
  }
  return false;
}

export function isInventoryPos(bag: number, slot: number): boolean {
  const playerBag = bag === 0 || bag === INVENTORY_SLOT_BAG_0;
  if (playerBag && slot === NULL_SLOT) {
    return true;
  }
  if (playerBag && slot >= INVENTORY_SLOT_ITEM_START && slot < INVENTORY_SLOT_ITEM_END) {
    return true;
  }
  if (bag >= INVENTORY_SLOT_BAG_START && bag < INVENTORY_SLOT_BAG_END) {
    return true;
  }
  if (playerBag && slot >= KEYRING_SLOT_START && slot < CURRENCYTOKEN_SLOT_END) {
    return true;
  }
  return false;
}

export function isBankPos(bag: number, slot: number): boolean {
  const playerBag = bag === 0 || bag === INVENTORY_SLOT_BAG_0;
  if (playerBag && slot >= BANK_SLOT_ITEM_START && slot < BANK_SLOT_ITEM_END) {
    return true;
  }
  if (playerBag && slot >= BANK_SLOT_BAG_START && slot < BANK_SLOT_BAG_END) {
    return true;
  }
  if (bag >= BANK_SLOT_BAG_START && bag < BANK_SLOT_BAG_END) {
    return true;
  }
  return false;
}

export function isBagPos(bag: number, slot: number): boolean {
  const playerBag = bag === 0 || bag === INVENTORY_SLOT_BAG_0;
  if (playerBag && slot >= INVENTORY_SLOT_BAG_START && slot < INVENTORY_SLOT_BAG_END) {
    return true;
  }
  if (playerBag && slot >= BANK_SLOT_BAG_START && slot < BANK_SLOT_BAG_END) {
    return true;
  }
  return false;
}

export function isKeyringPos(bag: number, slot: number): boolean {
  const playerBag = bag === 0 || bag === INVENTORY_SLOT_BAG_0;
  return playerBag && slot >= KEYRING_SLOT_START && slot < KEYRING_SLOT_END;
}

/**
 * Convert a packet bag id (255 = player, 19..22 / 67..73 = bag equipment slot)
 * into the storage bag guid (0 = player, else item guid of the container).
 */
export function resolveStorageBag(inv: Inventory, packetBag: number): number | null {
  if (packetBag === INVENTORY_SLOT_BAG_0 || packetBag === NULL_BAG) {
    return 0;
  }
  if (
    (packetBag >= INVENTORY_SLOT_BAG_START && packetBag < INVENTORY_SLOT_BAG_END) ||
    (packetBag >= BANK_SLOT_BAG_START && packetBag < BANK_SLOT_BAG_END)
  ) {
    const bagItem = getItem(inv, 0, packetBag);
    if (!bagItem || !isBagItem(bagItem.template)) {
      return null;
    }
    return bagItem.guid;
  }
  // Already a bag item guid (or unknown) — treat as storage bag guid if we know it.
  if (inv.byGuid.has(packetBag) || inv.slots.has(packetBag)) {
    return packetBag;
  }
  return null;
}

function unlockedBankBagSlots(inv: Inventory): number {
  return Math.max(0, Math.min(BANK_SLOT_BAG_END - BANK_SLOT_BAG_START, inv.bankSlots));
}

function checkPlayerSlotUnlocked(inv: Inventory, slot: number): number {
  if (slot >= BANK_SLOT_BAG_START && slot < BANK_SLOT_BAG_END) {
    if (slot - BANK_SLOT_BAG_START >= unlockedBankBagSlots(inv)) {
      return EQUIP_ERR_MUST_PURCHASE_THAT_BAG_SLOT;
    }
  }
  return EQUIP_ERR_OK;
}

function checkSlotInRange(
  inv: Inventory,
  storageBag: number,
  slot: number,
  item: InventoryItem,
): number {
  if (storageBag === 0) {
    if (slot >= BUYBACK_SLOT_START && slot < BUYBACK_SLOT_END) {
      return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
    }
    if (slot >= PLAYER_SLOT_END) {
      return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
    }
    if (slot < 0) {
      return EQUIP_ERR_ITEM_DOESNT_GO_TO_SLOT;
    }
    // Valid player-slot ranges
    const inEquip = slot < EQUIPMENT_SLOT_END;
    const inBags = slot >= INVENTORY_SLOT_BAG_START && slot < INVENTORY_SLOT_BAG_END;
    const inBackpack = slot >= INVENTORY_SLOT_ITEM_START && slot < INVENTORY_SLOT_ITEM_END;
    const inBankItems = slot >= BANK_SLOT_ITEM_START && slot < BANK_SLOT_ITEM_END;
    const inBankBags = slot >= BANK_SLOT_BAG_START && slot < BANK_SLOT_BAG_END;
    const inKeyring = slot >= KEYRING_SLOT_START && slot < KEYRING_SLOT_END;
    const inCurrency = slot >= CURRENCYTOKEN_SLOT_START && slot < CURRENCYTOKEN_SLOT_END;
    if (!(inEquip || inBags || inBackpack || inBankItems || inBankBags || inKeyring || inCurrency)) {
      return EQUIP_ERR_ITEM_DOESNT_GO_TO_SLOT;
    }
    const bankLock = checkPlayerSlotUnlocked(inv, slot);
    if (bankLock !== EQUIP_ERR_OK) {
      return bankLock;
    }
    if (inKeyring && !isKeyItem(item.template)) {
      return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
    }
    if (inCurrency && !isCurrencyToken(item.template)) {
      return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
    }
    // Keys only on keyring; currency tokens only in token slots.
    if (isKeyItem(item.template) && !inKeyring) {
      return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
    }
    if (isCurrencyToken(item.template) && !inCurrency) {
      return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
    }
    if (inBankBags && !isBagItem(item.template)) {
      return EQUIP_ERR_ITEM_DOESNT_GO_TO_SLOT;
    }
    if (inBags && !isBagItem(item.template)) {
      return EQUIP_ERR_ITEM_DOESNT_GO_TO_SLOT;
    }
    return EQUIP_ERR_OK;
  }

  const bagItem = inv.byGuid.has(storageBag)
    ? (() => {
        const pos = inv.byGuid.get(storageBag)!;
        return getItem(inv, pos.bag, pos.slot);
      })()
    : null;

  if (!bagItem || !isBagItem(bagItem.template)) {
    return EQUIP_ERR_NOT_A_BAG;
  }

  // Keys / currency tokens never sit inside equipped bags.
  if (isKeyItem(item.template) || isCurrencyToken(item.template)) {
    return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
  }

  // Bank bag content: owning bag must sit in an unlocked bank bag slot.
  const bagPos = inv.byGuid.get(storageBag);
  if (bagPos && bagPos.bag === 0 && bagPos.slot >= BANK_SLOT_BAG_START && bagPos.slot < BANK_SLOT_BAG_END) {
    const bankLock = checkPlayerSlotUnlocked(inv, bagPos.slot);
    if (bankLock !== EQUIP_ERR_OK) {
      return bankLock;
    }
  }

  if (slot < 0 || slot >= bagItem.template.ContainerSlots) {
    return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
  }
  if (!itemCanGoIntoBag(item.template, bagItem.template)) {
    return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
  }
  return EQUIP_ERR_OK;
}

function change(bag: number, slot: number, itemGuid: number | null): SlotChange {
  return { bag, slot, itemGuid };
}

function ok(changes: SlotChange[]): InventoryOpResult {
  return { ok: true, error: EQUIP_ERR_OK, changes };
}

function fail(error: number): InventoryOpResult {
  return { ok: false, error, changes: [] };
}

/** Place an item into an empty slot (no swap). */
export function storeItem(
  inv: Inventory,
  bag: number,
  slot: number,
  item: InventoryItem,
): InventoryOpResult {
  const storageBag = bag === INVENTORY_SLOT_BAG_0 ? 0 : bag;
  const range = checkSlotInRange(inv, storageBag, slot, item);
  if (range !== EQUIP_ERR_OK) {
    return fail(range);
  }
  const existing = getItem(inv, storageBag, slot);
  if (existing && existing.guid !== item.guid) {
    return fail(EQUIP_ERR_ITEM_DOESNT_GO_TO_SLOT);
  }
  placeItem(inv, storageBag, slot, item);
  return ok([change(storageBag, slot, item.guid)]);
}

/** Swap two slots (C++ SwapItem core for inventory/bank bags). */
export function swapItem(
  inv: Inventory,
  srcBag: number,
  srcSlot: number,
  dstBag: number,
  dstSlot: number,
): InventoryOpResult {
  const srcStorage = srcBag === INVENTORY_SLOT_BAG_0 ? 0 : srcBag;
  const dstStorage = dstBag === INVENTORY_SLOT_BAG_0 ? 0 : dstBag;

  if (srcStorage === dstStorage && srcSlot === dstSlot) {
    return ok([]);
  }

  const srcItem = getItem(inv, srcStorage, srcSlot);
  if (!srcItem) {
    return fail(EQUIP_ERR_ITEM_NOT_FOUND);
  }

  const dstItem = getItem(inv, dstStorage, dstSlot);

  // Prevent putting a bag into itself.
  if (isBagItem(srcItem.template) && dstStorage === srcItem.guid) {
    return fail(EQUIP_ERR_NONEMPTY_BAG_OVER_OTHER_BAG);
  }
  if (dstItem && isBagItem(dstItem.template) && srcStorage === dstItem.guid) {
    return fail(EQUIP_ERR_ITEMS_CANT_BE_SWAPPED);
  }

  const srcRange = checkSlotInRange(inv, dstStorage, dstSlot, srcItem);
  if (srcRange !== EQUIP_ERR_OK) {
    return fail(srcRange);
  }
  if (dstItem) {
    const dstRange = checkSlotInRange(inv, srcStorage, srcSlot, dstItem);
    if (dstRange !== EQUIP_ERR_OK) {
      return fail(dstRange);
    }
  }

  // Non-empty bags may only sit in bag equipment / bank bag slots.
  if (isBagItem(srcItem.template) && dstStorage === 0) {
    const hasContents = (inv.slots.get(srcItem.guid)?.size ?? 0) > 0;
    if (hasContents && !isBagPos(INVENTORY_SLOT_BAG_0, dstSlot)) {
      return fail(EQUIP_ERR_NONEMPTY_BAG_OVER_OTHER_BAG);
    }
  }
  if (dstItem && isBagItem(dstItem.template) && srcStorage === 0) {
    const hasContents = (inv.slots.get(dstItem.guid)?.size ?? 0) > 0;
    if (hasContents && !isBagPos(INVENTORY_SLOT_BAG_0, srcSlot)) {
      return fail(EQUIP_ERR_NONEMPTY_BAG_OVER_OTHER_BAG);
    }
  }

  // Stack merge when same entry and stackable (Player::SwapItem merge path).
  if (
    dstItem &&
    !isBagItem(srcItem.template) &&
    !isBagItem(dstItem.template) &&
    srcItem.entry === dstItem.entry
  ) {
    const stackable = srcItem.template.stackable ?? 1;
    if (
      canMergeWith(
        { entry: dstItem.entry, count: dstItem.count, flags: 0, owner: 0 },
        { entry: srcItem.entry, flags: 0 },
        { stackable },
      )
    ) {
      const max = getMaxStackSize(stackable);
      const total = srcItem.count + dstItem.count;
      if (total <= max) {
        clearSlot(inv, srcStorage, srcSlot);
        dstItem.count = total;
        return ok([
          change(srcStorage, srcSlot, null),
          change(dstStorage, dstSlot, dstItem.guid),
        ]);
      }
      srcItem.count = total - max;
      dstItem.count = max;
      return ok([
        change(srcStorage, srcSlot, srcItem.guid),
        change(dstStorage, dstSlot, dstItem.guid),
      ]);
    }
  }

  clearSlot(inv, srcStorage, srcSlot);
  clearSlot(inv, dstStorage, dstSlot);
  placeItem(inv, dstStorage, dstSlot, srcItem);
  const changes: SlotChange[] = [change(dstStorage, dstSlot, srcItem.guid)];
  if (dstItem) {
    placeItem(inv, srcStorage, srcSlot, dstItem);
    changes.push(change(srcStorage, srcSlot, dstItem.guid));
  } else {
    changes.push(change(srcStorage, srcSlot, null));
  }
  return ok(changes);
}

/** SwapInvItem: both slots are on player bag 0. */
export function swapInvItem(inv: Inventory, srcSlot: number, dstSlot: number): InventoryOpResult {
  return swapItem(inv, 0, srcSlot, 0, dstSlot);
}

/** Split stack into an empty destination (new item guid provided by caller). */
export function splitItem(
  inv: Inventory,
  srcBag: number,
  srcSlot: number,
  dstBag: number,
  dstSlot: number,
  count: number,
  newItemGuid: number,
): InventoryOpResult {
  const srcStorage = srcBag === INVENTORY_SLOT_BAG_0 ? 0 : srcBag;
  const dstStorage = dstBag === INVENTORY_SLOT_BAG_0 ? 0 : dstBag;

  const srcItem = getItem(inv, srcStorage, srcSlot);
  if (!srcItem) {
    return fail(EQUIP_ERR_ITEM_NOT_FOUND);
  }
  if (count <= 0 || count >= srcItem.count) {
    return fail(EQUIP_ERR_COULDNT_SPLIT_ITEMS);
  }
  if (srcItem.count < count) {
    return fail(EQUIP_ERR_TRIED_TO_SPLIT_MORE_THAN_COUNT);
  }
  if (getItem(inv, dstStorage, dstSlot)) {
    return fail(EQUIP_ERR_ITEM_DOESNT_GO_TO_SLOT);
  }

  const newItem: InventoryItem = {
    guid: newItemGuid,
    entry: srcItem.entry,
    count,
    template: srcItem.template,
  };
  const range = checkSlotInRange(inv, dstStorage, dstSlot, newItem);
  if (range !== EQUIP_ERR_OK) {
    return fail(range);
  }

  srcItem.count -= count;
  placeItem(inv, dstStorage, dstSlot, newItem);
  return ok([
    change(srcStorage, srcSlot, srcItem.guid),
    change(dstStorage, dstSlot, newItem.guid),
  ]);
}

function findEmptyInRange(
  inv: Inventory,
  storageBag: number,
  slotStart: number,
  slotEnd: number,
  item: InventoryItem,
): number | null {
  for (let slot = slotStart; slot < slotEnd; slot++) {
    if (getItem(inv, storageBag, slot)) {
      continue;
    }
    if (checkSlotInRange(inv, storageBag, slot, item) === EQUIP_ERR_OK) {
      return slot;
    }
  }
  return null;
}

function findEmptyInBag(inv: Inventory, bagGuid: number, item: InventoryItem): number | null {
  const bagItem = (() => {
    const pos = inv.byGuid.get(bagGuid);
    return pos ? getItem(inv, pos.bag, pos.slot) : null;
  })();
  if (!bagItem || !isBagItem(bagItem.template)) {
    return null;
  }
  if (!itemCanGoIntoBag(item.template, bagItem.template)) {
    return null;
  }
  for (let slot = 0; slot < bagItem.template.ContainerSlots; slot++) {
    if (!getItem(inv, bagGuid, slot)) {
      return slot;
    }
  }
  return null;
}

/**
 * Auto-store into backpack then equipped bags (CanStoreItem NULL_BAG / NULL_SLOT path,
 * without stack merge).
 */
export function autoStoreItem(inv: Inventory, item: InventoryItem): InventoryOpResult {
  // Keys prefer keyring — and nowhere else.
  if (isKeyItem(item.template)) {
    const keySlot = findEmptyInRange(inv, 0, KEYRING_SLOT_START, KEYRING_SLOT_END, item);
    if (keySlot !== null) {
      return storeItem(inv, 0, keySlot, item);
    }
    return fail(EQUIP_ERR_INVENTORY_FULL);
  }

  // Currency tokens
  if (isCurrencyToken(item.template)) {
    const tokenSlot = findEmptyInRange(
      inv,
      0,
      CURRENCYTOKEN_SLOT_START,
      CURRENCYTOKEN_SLOT_END,
      item,
    );
    if (tokenSlot !== null) {
      return storeItem(inv, 0, tokenSlot, item);
    }
    return fail(EQUIP_ERR_INVENTORY_FULL);
  }

  // Backpack
  const backpack = findEmptyInRange(
    inv,
    0,
    INVENTORY_SLOT_ITEM_START,
    INVENTORY_SLOT_ITEM_END,
    item,
  );
  if (backpack !== null) {
    return storeItem(inv, 0, backpack, item);
  }

  // Specialized bags first, then generic
  for (const specialized of [true, false]) {
    for (let bagSlot = INVENTORY_SLOT_BAG_START; bagSlot < INVENTORY_SLOT_BAG_END; bagSlot++) {
      const bagItem = getItem(inv, 0, bagSlot);
      if (!bagItem || !isBagItem(bagItem.template)) {
        continue;
      }
      const isGeneric =
        bagItem.template.class === ITEM_CLASS_CONTAINER &&
        bagItem.template.subclass === ITEM_SUBCLASS_CONTAINER;
      if (specialized === isGeneric) {
        continue;
      }
      if (!itemCanGoIntoBag(item.template, bagItem.template)) {
        continue;
      }
      const free = findEmptyInBag(inv, bagItem.guid, item);
      if (free !== null) {
        return storeItem(inv, bagItem.guid, free, item);
      }
    }
  }

  return fail(EQUIP_ERR_INVENTORY_FULL);
}

/** Move an inventory item into the bank (CanBankItem NULL_BAG). */
export function autoBankItem(
  inv: Inventory,
  srcBag: number,
  srcSlot: number,
): InventoryOpResult {
  const srcStorage = srcBag === INVENTORY_SLOT_BAG_0 ? 0 : srcBag;
  const item = getItem(inv, srcStorage, srcSlot);
  if (!item) {
    return fail(EQUIP_ERR_ITEM_NOT_FOUND);
  }

  // Bank main slots
  const bankSlot = findEmptyInRange(inv, 0, BANK_SLOT_ITEM_START, BANK_SLOT_ITEM_END, item);
  if (bankSlot !== null) {
    clearSlot(inv, srcStorage, srcSlot);
    placeItem(inv, 0, bankSlot, item);
    return ok([
      change(srcStorage, srcSlot, null),
      change(0, bankSlot, item.guid),
    ]);
  }

  // Bank bags (purchased only)
  for (let bagSlot = BANK_SLOT_BAG_START; bagSlot < BANK_SLOT_BAG_END; bagSlot++) {
    if (bagSlot - BANK_SLOT_BAG_START >= unlockedBankBagSlots(inv)) {
      break;
    }
    const bagItem = getItem(inv, 0, bagSlot);
    if (!bagItem || !isBagItem(bagItem.template)) {
      continue;
    }
    if (!itemCanGoIntoBag(item.template, bagItem.template)) {
      continue;
    }
    const free = findEmptyInBag(inv, bagItem.guid, item);
    if (free !== null) {
      clearSlot(inv, srcStorage, srcSlot);
      placeItem(inv, bagItem.guid, free, item);
      return ok([
        change(srcStorage, srcSlot, null),
        change(bagItem.guid, free, item.guid),
      ]);
    }
  }

  return fail(EQUIP_ERR_BANK_FULL);
}

/**
 * CMSG_AUTOSTORE_BANK_ITEM: from bank → inventory, or from inventory → bank
 * depending on source position.
 */
export function autoStoreBankItem(
  inv: Inventory,
  srcBag: number,
  srcSlot: number,
): InventoryOpResult {
  const srcStorage = srcBag === INVENTORY_SLOT_BAG_0 ? 0 : srcBag;
  const item = getItem(inv, srcStorage, srcSlot);
  if (!item) {
    return fail(EQUIP_ERR_ITEM_NOT_FOUND);
  }

  const fromBank =
    (srcStorage === 0 && isBankPos(INVENTORY_SLOT_BAG_0, srcSlot)) ||
    (() => {
      if (srcStorage === 0) {
        return false;
      }
      const pos = inv.byGuid.get(srcStorage);
      return pos !== undefined && pos.bag === 0 && isBankPos(INVENTORY_SLOT_BAG_0, pos.slot);
    })();

  if (fromBank) {
    clearSlot(inv, srcStorage, srcSlot);
    const stored = autoStoreItem(inv, item);
    if (!stored.ok) {
      placeItem(inv, srcStorage, srcSlot, item);
      return stored;
    }
    return ok([change(srcStorage, srcSlot, null), ...stored.changes]);
  }

  return autoBankItem(inv, srcStorage, srcSlot);
}

/** Packet bag-aware auto-store into a destination bag (HandleAutoStoreBagItem). */
export function autoStoreBagItem(
  inv: Inventory,
  srcBag: number,
  srcSlot: number,
  destPacketBag: number,
): InventoryOpResult {
  const srcStorage = resolveStorageBag(inv, srcBag);
  if (srcStorage === null && srcBag !== 0 && srcBag !== INVENTORY_SLOT_BAG_0) {
    return fail(EQUIP_ERR_ITEM_NOT_FOUND);
  }
  const srcBagGuid = srcStorage ?? 0;
  const item = getItem(inv, srcBagGuid, srcSlot);
  if (!item) {
    return fail(EQUIP_ERR_ITEM_NOT_FOUND);
  }

  if (destPacketBag === NULL_BAG || destPacketBag === INVENTORY_SLOT_BAG_0) {
    clearSlot(inv, srcBagGuid, srcSlot);
    const stored = autoStoreItem(inv, item);
    if (!stored.ok) {
      placeItem(inv, srcBagGuid, srcSlot, item);
      return stored;
    }
    return ok([change(srcBagGuid, srcSlot, null), ...stored.changes]);
  }

  const destBagGuid = resolveStorageBag(inv, destPacketBag);
  if (destBagGuid === null || destBagGuid === 0) {
    return fail(EQUIP_ERR_ITEM_DOESNT_GO_TO_SLOT);
  }
  const free = findEmptyInBag(inv, destBagGuid, item);
  if (free === null) {
    // Distinguish family reject vs full
    const bagPos = inv.byGuid.get(destBagGuid);
    const bagItem = bagPos ? getItem(inv, bagPos.bag, bagPos.slot) : null;
    if (bagItem && !itemCanGoIntoBag(item.template, bagItem.template)) {
      return fail(EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG);
    }
    return fail(EQUIP_ERR_BAG_FULL);
  }

  clearSlot(inv, srcBagGuid, srcSlot);
  placeItem(inv, destBagGuid, free, item);
  return ok([
    change(srcBagGuid, srcSlot, null),
    change(destBagGuid, free, item.guid),
  ]);
}

/**
 * SMSG_INVENTORY_CHANGE_FAILURE layout from Player::SendEquipError.
 * itemGuid / itemGuid2 are raw ObjectGuid uint64 values (use 0n when absent).
 */
export function buildInventoryChangeFailure(
  msg: number,
  itemGuid: bigint = 0n,
  itemGuid2: bigint = 0n,
  bagTypeSubclass = 0,
  itemLimitCategory = 0,
): Uint8Array {
  const w = new ByteWriter();
  w.writeU8(msg);
  if (msg !== EQUIP_ERR_OK) {
    w.writeU64(itemGuid);
    w.writeU64(itemGuid2);
    w.writeU8(bagTypeSubclass);
    switch (msg) {
      case EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED:
      case EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_SOCKETED_EXCEEDED:
      case EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_EQUIPPED_EXCEEDED:
        w.writeU32(itemLimitCategory);
        break;
      default:
        break;
    }
  }
  return w.toUint8Array();
}

/** `Player::GetItemCount` (sockets are not tracked in `Inventory`, so gems do not count). */
export function getItemCount(inv: Inventory, entry: number, inBankAlso = false): number {
  let count = 0;
  const countSlot = (slot: number): void => {
    const item = getItem(inv, 0, slot);
    if (item && item.entry === entry) {
      count += item.count;
    }
  };
  const countBag = (slot: number): void => {
    const bag = getItem(inv, 0, slot);
    for (const item of (bag && inv.slots.get(bag.guid)?.values()) ?? []) {
      if (item.entry === entry) {
        count += item.count;
      }
    }
  };
  for (let slot = EQUIPMENT_SLOT_START; slot < INVENTORY_SLOT_ITEM_END; slot++) countSlot(slot);
  for (let slot = KEYRING_SLOT_START; slot < CURRENCYTOKEN_SLOT_END; slot++) countSlot(slot);
  for (let slot = INVENTORY_SLOT_BAG_START; slot < INVENTORY_SLOT_BAG_END; slot++) countBag(slot);
  if (inBankAlso) {
    for (let slot = BANK_SLOT_ITEM_START; slot < BANK_SLOT_BAG_END; slot++) countSlot(slot);
    for (let slot = BANK_SLOT_BAG_START; slot < BANK_SLOT_BAG_END; slot++) countBag(slot);
  }
  return count;
}

/** `ItemPosCount`: `bag` is INVENTORY_SLOT_BAG_0 or the equipped bag's slot, as in the C++ `pos`. */
export type ItemPosCount = { bag: number; slot: number; count: number };

/** `sItemLimitCategoryStore.LookupEntry` */
export type LimitCategoryLookup = (id: number) => { maxCount: number; mode: number } | null;

/** `ITEM_LIMIT_CATEGORY_MODE_HAVE` */
const ITEM_LIMIT_CATEGORY_MODE_HAVE = 0;

export type CanStoreResult = { result: number; dest: ItemPosCount[]; noSpaceCount: number };

/** `Player::GetItemCountWithLimitCategory` */
export function getItemCountWithLimitCategory(inv: Inventory, limitCategory: number): number {
  let count = 0;
  const countItem = (item: InventoryItem | null | undefined): void => {
    if (item && (item.template.ItemLimitCategory ?? 0) === limitCategory) {
      count += item.count;
    }
  };
  const countBag = (slot: number): void => {
    const bag = bagByPos(inv, slot);
    for (const item of (bag && inv.slots.get(bag.guid)?.values()) ?? []) countItem(item);
  };
  for (let slot = EQUIPMENT_SLOT_START; slot < INVENTORY_SLOT_ITEM_END; slot++) countItem(getItem(inv, 0, slot));
  for (let slot = KEYRING_SLOT_START; slot < CURRENCYTOKEN_SLOT_END; slot++) countItem(getItem(inv, 0, slot));
  for (let slot = INVENTORY_SLOT_BAG_START; slot < INVENTORY_SLOT_BAG_END; slot++) countBag(slot);
  for (let slot = BANK_SLOT_ITEM_START; slot < BANK_SLOT_BAG_END; slot++) countItem(getItem(inv, 0, slot));
  for (let slot = BANK_SLOT_BAG_START; slot < BANK_SLOT_BAG_END; slot++) countBag(slot);
  return count;
}

/** `Player::CanTakeMoreSimilarItems` for a new item (no source item). */
export function canTakeMoreSimilarItems(
  inv: Inventory,
  proto: ItemTemplateSlice,
  count: number,
  limitCategory: LimitCategoryLookup,
): { result: number; noSpaceCount: number } {
  const maxCount = proto.maxcount ?? 0;
  const limitId = proto.ItemLimitCategory ?? 0;
  // no maximum
  if ((maxCount <= 0 && limitId === 0) || maxCount === 2147483647) {
    return { result: EQUIP_ERR_OK, noSpaceCount: 0 };
  }
  if (maxCount > 0) {
    const curcount = getItemCount(inv, proto.entry, true);
    if (curcount + count > maxCount) {
      return { result: EQUIP_ERR_CANT_CARRY_MORE_OF_THIS, noSpaceCount: count + curcount - maxCount };
    }
  }
  // check unique-equipped limit
  if (limitId) {
    const limitEntry = limitCategory(limitId);
    if (!limitEntry) {
      return { result: EQUIP_ERR_ITEM_CANT_BE_EQUIPPED, noSpaceCount: count };
    }
    if (limitEntry.mode === ITEM_LIMIT_CATEGORY_MODE_HAVE) {
      const curcount = getItemCountWithLimitCategory(inv, limitId);
      if (curcount + count > limitEntry.maxCount) {
        return { result: EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED, noSpaceCount: count + curcount - limitEntry.maxCount };
      }
    }
  }
  return { result: EQUIP_ERR_OK, noSpaceCount: 0 };
}

/** `Player::GetBagByPos` */
function bagByPos(inv: Inventory, slot: number): InventoryItem | null {
  const item = getItem(inv, 0, slot);
  return item && isBagItem(item.template) ? item : null;
}

/** `Player::GetItemByPos(bag, slot)` with `bag` as INVENTORY_SLOT_BAG_0 or an equipped bag's slot. */
function itemByPos(inv: Inventory, bag: number, slot: number): InventoryItem | null {
  if (bag === INVENTORY_SLOT_BAG_0) {
    return getItem(inv, 0, slot);
  }
  const container = bagByPos(inv, bag);
  return container ? getItem(inv, container.guid, slot) : null;
}

/** `Item::CanBeMergedPartlyWith` */
function canBeMergedPartlyWith(item: InventoryItem, proto: ItemTemplateSlice): number {
  // check item type
  if (item.entry !== proto.entry) {
    return EQUIP_ERR_ITEM_CANT_STACK;
  }
  // check free space (full stacks can't be target of merge
  if (item.count >= getMaxStackSize(proto.stackable ?? 1)) {
    return EQUIP_ERR_ITEM_CANT_STACK;
  }
  return EQUIP_ERR_OK;
}

/** `ItemPosCount::isContainedIn` */
function isContainedIn(dest: readonly ItemPosCount[], bag: number, slot: number): boolean {
  return dest.some((pos) => pos.bag === bag && pos.slot === slot);
}

type StoreCount = { count: number };

/** `Player::CanStoreItem_InSpecificSlot` */
function canStoreInSpecificSlot(inv: Inventory, bag: number, slot: number, dest: ItemPosCount[], proto: ItemTemplateSlice, left: StoreCount, swap: boolean): number {
  const item2 = itemByPos(inv, bag, slot);
  const maxStack = getMaxStackSize(proto.stackable ?? 1);
  let needSpace: number;
  // empty specific slot - check item fit to slot
  if (!item2 || swap) {
    if (bag === INVENTORY_SLOT_BAG_0) {
      // keyring case
      if (slot >= KEYRING_SLOT_START && slot < KEYRING_SLOT_END && !(proto.BagFamily & BAG_FAMILY_MASK_KEYS)) {
        return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
      }
      // currencytoken case
      if (slot >= CURRENCYTOKEN_SLOT_START && slot < CURRENCYTOKEN_SLOT_END && !isCurrencyToken(proto)) {
        return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
      }
      // prevent cheating
      if ((slot >= BUYBACK_SLOT_START && slot < BUYBACK_SLOT_END) || slot >= PLAYER_SLOT_END) {
        return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
      }
    } else {
      const container = bagByPos(inv, bag);
      if (!container || slot >= container.template.ContainerSlots || !itemCanGoIntoBag(proto, container.template)) {
        return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
      }
    }
    // non empty stack with space
    needSpace = maxStack;
  } else {
    // can be merged at least partly
    const res = canBeMergedPartlyWith(item2, proto);
    if (res !== EQUIP_ERR_OK) {
      return res;
    }
    // free stack space or infinity
    needSpace = maxStack - item2.count;
  }
  if (needSpace > left.count) {
    needSpace = left.count;
  }
  if (!isContainedIn(dest, bag, slot)) {
    dest.push({ bag, slot, count: needSpace });
    left.count -= needSpace;
  }
  return EQUIP_ERR_OK;
}

/** `Player::CanStoreItem_InBag` */
function canStoreInBag(
  inv: Inventory,
  bag: number,
  dest: ItemPosCount[],
  proto: ItemTemplateSlice,
  left: StoreCount,
  merge: boolean,
  nonSpecialized: boolean,
  skipBag: number,
  skipSlot: number,
): number {
  // skip specific bag already processed in first called CanStoreItem_InBag
  if (bag === skipBag) {
    return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
  }
  // skip not existed bag or self targeted bag
  const container = bagByPos(inv, bag);
  if (!container) {
    return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
  }
  const bagProto = container.template;
  // specialized bag mode or non-specilized
  if (nonSpecialized !== (bagProto.class === ITEM_CLASS_CONTAINER && bagProto.subclass === ITEM_SUBCLASS_CONTAINER)) {
    return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
  }
  if (!itemCanGoIntoBag(proto, bagProto)) {
    return EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG;
  }
  const maxStack = getMaxStackSize(proto.stackable ?? 1);
  for (let j = 0; j < bagProto.ContainerSlots; j++) {
    // skip specific slot already processed in first called CanStoreItem_InSpecificSlot
    if (j === skipSlot) {
      continue;
    }
    const item2 = getItem(inv, container.guid, j);
    // if merge skip empty, if !merge skip non-empty
    if ((item2 !== null) !== merge) {
      continue;
    }
    let needSpace = maxStack;
    if (item2) {
      // can be merged at least partly
      if (canBeMergedPartlyWith(item2, proto) !== EQUIP_ERR_OK) {
        continue;
      }
      // descrease at current stacksize
      needSpace -= item2.count;
    }
    if (needSpace > left.count) {
      needSpace = left.count;
    }
    if (!isContainedIn(dest, bag, j)) {
      dest.push({ bag, slot: j, count: needSpace });
      left.count -= needSpace;
      if (left.count === 0) {
        return EQUIP_ERR_OK;
      }
    }
  }
  return EQUIP_ERR_OK;
}

/** `Player::CanStoreItem_InInventorySlots` */
function canStoreInInventorySlots(
  inv: Inventory,
  slotBegin: number,
  slotEnd: number,
  dest: ItemPosCount[],
  proto: ItemTemplateSlice,
  left: StoreCount,
  merge: boolean,
  skipBag: number,
  skipSlot: number,
): number {
  const maxStack = getMaxStackSize(proto.stackable ?? 1);
  for (let j = slotBegin; j < slotEnd; j++) {
    // skip specific slot already processed in first called CanStoreItem_InSpecificSlot
    if (skipBag === INVENTORY_SLOT_BAG_0 && j === skipSlot) {
      continue;
    }
    const item2 = getItem(inv, 0, j);
    // if merge skip empty, if !merge skip non-empty
    if ((item2 !== null) !== merge) {
      continue;
    }
    let needSpace = maxStack;
    if (item2) {
      // can be merged at least partly
      if (canBeMergedPartlyWith(item2, proto) !== EQUIP_ERR_OK) {
        continue;
      }
      // descrease at current stacksize
      needSpace -= item2.count;
    }
    if (needSpace > left.count) {
      needSpace = left.count;
    }
    if (!isContainedIn(dest, INVENTORY_SLOT_BAG_0, j)) {
      dest.push({ bag: INVENTORY_SLOT_BAG_0, slot: j, count: needSpace });
      left.count -= needSpace;
      if (left.count === 0) {
        return EQUIP_ERR_OK;
      }
    }
  }
  return EQUIP_ERR_OK;
}

/**
 * `Player::CanStoreNewItem` → `Player::CanStoreItem` with no source item.
 * `bag` / `slot` are NULL_BAG / NULL_SLOT for "anywhere"; `dest` lists the stacks to merge into and the free slots to fill.
 */
export function canStoreNewItem(
  inv: Inventory,
  bag: number,
  slot: number,
  proto: ItemTemplateSlice | null,
  count: number,
  limitCategory: LimitCategoryLookup,
): CanStoreResult {
  const dest: ItemPosCount[] = [];
  if (!proto) {
    return { result: EQUIP_ERR_ITEM_NOT_FOUND, dest, noSpaceCount: count };
  }
  const left: StoreCount = { count };
  // check count of items (skip for auto move for same player from bank)
  let noSimilarCount = 0; // can't store this amount similar items
  const similar = canTakeMoreSimilarItems(inv, proto, count, limitCategory);
  if (similar.result !== EQUIP_ERR_OK) {
    if (count === similar.noSpaceCount) {
      return { result: similar.result, dest, noSpaceCount: similar.noSpaceCount };
    }
    noSimilarCount = similar.noSpaceCount;
    left.count -= noSimilarCount;
  }
  const failed = (res: number): CanStoreResult => ({ result: res, dest, noSpaceCount: left.count + noSimilarCount });
  const done = (): CanStoreResult | null => {
    if (left.count !== 0) {
      return null;
    }
    if (noSimilarCount === 0) {
      return { result: EQUIP_ERR_OK, dest, noSpaceCount: 0 };
    }
    return { result: EQUIP_ERR_CANT_CARRY_MORE_OF_THIS, dest, noSpaceCount: left.count + noSimilarCount };
  };
  // A step that fails the whole store on error.
  const must = (res: number): CanStoreResult | null => (res !== EQUIP_ERR_OK ? failed(res) : done());
  const stackable = (proto.stackable ?? 1) !== 1;
  const keys = (proto.BagFamily & BAG_FAMILY_MASK_KEYS) !== 0;
  let out: CanStoreResult | null;

  // in specific slot
  if (bag !== NULL_BAG && slot !== NULL_SLOT) {
    if ((out = must(canStoreInSpecificSlot(inv, bag, slot, dest, proto, left, false)))) return out;
  }

  // not specific slot or have space for partly store only in specific slot

  // in specific bag
  if (bag !== NULL_BAG) {
    // search stack in bag for merge to
    if (stackable) {
      if (bag === INVENTORY_SLOT_BAG_0) {
        if ((out = must(canStoreInInventorySlots(inv, KEYRING_SLOT_START, CURRENCYTOKEN_SLOT_END, dest, proto, left, true, bag, slot)))) return out;
        if ((out = must(canStoreInInventorySlots(inv, INVENTORY_SLOT_ITEM_START, INVENTORY_SLOT_ITEM_END, dest, proto, left, true, bag, slot)))) return out;
      } else {
        // we need check 2 time (specialized/non_specialized), use NULL_BAG to prevent skipping bag
        let res = canStoreInBag(inv, bag, dest, proto, left, true, false, NULL_BAG, slot);
        if (res !== EQUIP_ERR_OK) res = canStoreInBag(inv, bag, dest, proto, left, true, true, NULL_BAG, slot);
        if ((out = must(res))) return out;
      }
    }
    // search free slot in bag for place to
    if (bag === INVENTORY_SLOT_BAG_0) {
      if (keys) {
        if ((out = must(canStoreInInventorySlots(inv, KEYRING_SLOT_START, KEYRING_SLOT_END, dest, proto, left, false, bag, slot)))) return out;
        if ((out = must(canStoreInInventorySlots(inv, CURRENCYTOKEN_SLOT_START, CURRENCYTOKEN_SLOT_END, dest, proto, left, false, bag, slot)))) return out;
      } else if (isCurrencyToken(proto)) {
        if ((out = must(canStoreInInventorySlots(inv, CURRENCYTOKEN_SLOT_START, CURRENCYTOKEN_SLOT_END, dest, proto, left, false, bag, slot)))) return out;
      }
      if ((out = must(canStoreInInventorySlots(inv, INVENTORY_SLOT_ITEM_START, INVENTORY_SLOT_ITEM_END, dest, proto, left, false, bag, slot)))) return out;
    } else {
      let res = canStoreInBag(inv, bag, dest, proto, left, false, false, NULL_BAG, slot);
      if (res !== EQUIP_ERR_OK) res = canStoreInBag(inv, bag, dest, proto, left, false, true, NULL_BAG, slot);
      if ((out = must(res))) return out;
    }
  }

  // not specific bag or have space for partly store only in specific bag

  // search stack for merge to
  if (stackable) {
    if ((out = must(canStoreInInventorySlots(inv, KEYRING_SLOT_START, CURRENCYTOKEN_SLOT_END, dest, proto, left, true, bag, slot)))) return out;
    if ((out = must(canStoreInInventorySlots(inv, INVENTORY_SLOT_ITEM_START, INVENTORY_SLOT_ITEM_END, dest, proto, left, true, bag, slot)))) return out;
    if (proto.BagFamily) {
      for (let i = INVENTORY_SLOT_BAG_START; i < INVENTORY_SLOT_BAG_END; i++) {
        if (canStoreInBag(inv, i, dest, proto, left, true, false, bag, slot) !== EQUIP_ERR_OK) continue;
        if ((out = done())) return out;
      }
    }
    for (let i = INVENTORY_SLOT_BAG_START; i < INVENTORY_SLOT_BAG_END; i++) {
      if (canStoreInBag(inv, i, dest, proto, left, true, true, bag, slot) !== EQUIP_ERR_OK) continue;
      if ((out = done())) return out;
    }
  }

  // search free slot - special bag case
  if (proto.BagFamily) {
    if (keys) {
      if ((out = must(canStoreInInventorySlots(inv, KEYRING_SLOT_START, KEYRING_SLOT_END, dest, proto, left, false, bag, slot)))) return out;
    } else if (isCurrencyToken(proto)) {
      if ((out = must(canStoreInInventorySlots(inv, CURRENCYTOKEN_SLOT_START, CURRENCYTOKEN_SLOT_END, dest, proto, left, false, bag, slot)))) return out;
    }
    for (let i = INVENTORY_SLOT_BAG_START; i < INVENTORY_SLOT_BAG_END; i++) {
      if (canStoreInBag(inv, i, dest, proto, left, false, false, bag, slot) !== EQUIP_ERR_OK) continue;
      if ((out = done())) return out;
    }
  }

  // search free slot
  if ((out = must(canStoreInInventorySlots(inv, INVENTORY_SLOT_ITEM_START, INVENTORY_SLOT_ITEM_END, dest, proto, left, false, bag, slot)))) return out;
  for (let i = INVENTORY_SLOT_BAG_START; i < INVENTORY_SLOT_BAG_END; i++) {
    if (canStoreInBag(inv, i, dest, proto, left, false, true, bag, slot) !== EQUIP_ERR_OK) continue;
    if ((out = done())) return out;
  }
  return { result: EQUIP_ERR_INVENTORY_FULL, dest, noSpaceCount: left.count + noSimilarCount };
}

/**
 * `Player::_StoreItem` placement: `bag` is INVENTORY_SLOT_BAG_0 or an equipped bag's slot.
 * The caller has checked the position with `canStoreNewItem`.
 */
export function placeStoredItem(inv: Inventory, bag: number, slot: number, item: InventoryItem): SlotChange | null {
  const storageBag = bag === INVENTORY_SLOT_BAG_0 ? 0 : bagByPos(inv, bag)?.guid;
  if (storageBag === undefined) {
    return null;
  }
  placeItem(inv, storageBag, slot, item);
  return change(storageBag, slot, item.guid);
}

/** The item at a `canStoreNewItem` position, if any. */
export function itemAtStorePos(inv: Inventory, pos: ItemPosCount): InventoryItem | null {
  return itemByPos(inv, pos.bag, pos.slot);
}

/**
 * SMSG_ITEM_PUSH_RESULT from `Player::SendNewItem`.
 * `bagSlot` is `Item::GetBagSlot` (INVENTORY_SLOT_BAG_0 in the backpack); `slot` is -1 when added to a stack.
 */
export function buildItemPushResult(opts: {
  playerGuid: bigint;
  received: boolean;
  created: boolean;
  sendChatMessage: boolean;
  bagSlot: number;
  slot: number;
  entry: number;
  suffixFactor: number;
  randomPropertyId: number;
  count: number;
  inventoryCount: number;
}): Uint8Array {
  return new ByteWriter()
    .writeU64(opts.playerGuid)
    .writeU32(opts.received ? 1 : 0)
    .writeU32(opts.created ? 1 : 0)
    .writeU32(opts.sendChatMessage ? 1 : 0)
    .writeU8(opts.bagSlot)
    .writeU32(opts.slot >>> 0)
    .writeU32(opts.entry)
    .writeU32(opts.suffixFactor >>> 0)
    .writeU32(opts.randomPropertyId >>> 0)
    .writeU32(opts.count)
    .writeU32(opts.inventoryCount)
    .toUint8Array();
}

export type BuyBankSlotResult = {
  result: number;
  /** New money after a successful purchase; omit on failure. */
  money?: number;
  bankSlots: number;
};

/** HandleBuyBankSlotOpcode — spends copper from `money`, increments `inv.bankSlots`. */
export function buyBankSlot(inv: Inventory, money: number): BuyBankSlotResult {
  const next = inv.bankSlots + 1;
  if (next < 1 || next > BANK_BAG_SLOT_PRICES.length) {
    return { result: ERR_BANKSLOT_FAILED_TOO_MANY, bankSlots: inv.bankSlots };
  }
  const price = BANK_BAG_SLOT_PRICES[next - 1]!;
  if (money < price) {
    return { result: ERR_BANKSLOT_INSUFFICIENT_FUNDS, bankSlots: inv.bankSlots };
  }
  inv.bankSlots = next;
  return {
    result: ERR_BANKSLOT_OK,
    money: money - price,
    bankSlots: inv.bankSlots,
  };
}

export function buildBuyBankSlotResult(result: number): Uint8Array {
  return new ByteWriter().writeU32(result).toUint8Array();
}

/**
 * DestroyItem / DestroyItemCount — clears the slot (or reduces stack).
 * Non-empty bags destroy their contents first (AzerothCore DestroyItem).
 */
export function destroyItem(
  inv: Inventory,
  bag: number,
  slot: number,
  count = 0,
): InventoryOpResult {
  const storageBag = bag === INVENTORY_SLOT_BAG_0 ? 0 : bag;
  const item = getItem(inv, storageBag, slot);
  if (!item) {
    return fail(EQUIP_ERR_ITEM_NOT_FOUND);
  }

  const changes: SlotChange[] = [];

  // Destroy bag contents first when wiping the whole bag item.
  if (count === 0 && isBagItem(item.template)) {
    const contents = inv.slots.get(item.guid);
    if (contents) {
      for (const [contentSlot] of [...contents]) {
        const nested = destroyItem(inv, item.guid, contentSlot, 0);
        if (!nested.ok) {
          return nested;
        }
        changes.push(...nested.changes);
      }
    }
  }

  if (count > 0 && count < item.count) {
    item.count -= count;
    changes.push(change(storageBag, slot, item.guid));
    return ok(changes);
  }

  clearSlot(inv, storageBag, slot);
  changes.push(change(storageBag, slot, null));
  return ok(changes);
}

/** Apply rows into an inventory (caller supplies item instances by guid). */
export function applyInventoryRows(
  inv: Inventory,
  rows: CharacterInventoryRow[],
  itemsByGuid: Map<number, InventoryItem>,
): void {
  // First pass: bag=0 so containers exist before contents.
  const ordered = [...rows].sort((a, b) => a.bag - b.bag || a.slot - b.slot);
  for (const row of ordered) {
    const item = itemsByGuid.get(row.item);
    if (!item) {
      continue;
    }
    placeItem(inv, row.bag, row.slot, item);
  }
}
