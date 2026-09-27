/**
 * Player equip + visible gear fields (AzerothCore Player::CanEquipItem / EquipItem /
 * SetVisibleItemSlot / FindEquipSlot). Inventory is plain data; no DB or socket.
 */
import { fieldUpdateBlock } from "../world/update-object.ts";

const OBJECT_END = 0x0006;
const UNIT_END = OBJECT_END + 0x008e;

/** UpdateFields.h — PLAYER_VISIBLE_ITEM_1_ENTRYID = UNIT_END + 0x0087 */
export const PLAYER_VISIBLE_ITEM_1_ENTRYID = UNIT_END + 0x0087;
/** UpdateFields.h — PLAYER_VISIBLE_ITEM_1_ENCHANTMENT = UNIT_END + 0x0088 */
export const PLAYER_VISIBLE_ITEM_1_ENCHANTMENT = UNIT_END + 0x0088;
/** UpdateFields.h — UNIT_VIRTUAL_ITEM_SLOT_ID = OBJECT_END + 0x0032 (main/off/ranged sheathe) */
export const UNIT_VIRTUAL_ITEM_SLOT_ID = OBJECT_END + 0x0032;

export const INVENTORY_SLOT_BAG_0 = 255;
export const NULL_BAG = 0;
export const NULL_SLOT = 255;

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

export const INVENTORY_SLOT_ITEM_START = 23;
export const INVENTORY_SLOT_ITEM_END = 39;

export const INVTYPE_NON_EQUIP = 0;
export const INVTYPE_HEAD = 1;
export const INVTYPE_NECK = 2;
export const INVTYPE_SHOULDERS = 3;
export const INVTYPE_BODY = 4;
export const INVTYPE_CHEST = 5;
export const INVTYPE_WAIST = 6;
export const INVTYPE_LEGS = 7;
export const INVTYPE_FEET = 8;
export const INVTYPE_WRISTS = 9;
export const INVTYPE_HANDS = 10;
export const INVTYPE_FINGER = 11;
export const INVTYPE_TRINKET = 12;
export const INVTYPE_WEAPON = 13;
export const INVTYPE_SHIELD = 14;
export const INVTYPE_RANGED = 15;
export const INVTYPE_CLOAK = 16;
export const INVTYPE_2HWEAPON = 17;
export const INVTYPE_BAG = 18;
export const INVTYPE_TABARD = 19;
export const INVTYPE_ROBE = 20;
export const INVTYPE_WEAPONMAINHAND = 21;
export const INVTYPE_WEAPONOFFHAND = 22;
export const INVTYPE_HOLDABLE = 23;
export const INVTYPE_AMMO = 24;
export const INVTYPE_THROWN = 25;
export const INVTYPE_RANGEDRIGHT = 26;
export const INVTYPE_QUIVER = 27;
export const INVTYPE_RELIC = 28;

/** Item.h InventoryResult — codes this module can return */
export const EQUIP_ERR_OK = 0;
export const EQUIP_ERR_CANT_EQUIP_LEVEL_I = 1;
export const EQUIP_ERR_ITEM_DOESNT_GO_TO_SLOT = 3;
export const EQUIP_ERR_NO_EQUIPMENT_SLOT_AVAILABLE = 9;
export const EQUIP_ERR_YOU_CAN_NEVER_USE_THAT_ITEM = 10;
export const EQUIP_ERR_CANT_EQUIP_WITH_TWOHANDED = 13;
export const EQUIP_ERR_CANT_DUAL_WIELD = 14;
export const EQUIP_ERR_ITEM_CANT_BE_EQUIPPED = 20;
export const EQUIP_ERR_ITEMS_CANT_BE_SWAPPED = 21;
export const EQUIP_ERR_ITEM_NOT_FOUND = 23;
export const EQUIP_ERR_INVENTORY_FULL = 50;

export type InventoryResult =
  | typeof EQUIP_ERR_OK
  | typeof EQUIP_ERR_CANT_EQUIP_LEVEL_I
  | typeof EQUIP_ERR_ITEM_DOESNT_GO_TO_SLOT
  | typeof EQUIP_ERR_NO_EQUIPMENT_SLOT_AVAILABLE
  | typeof EQUIP_ERR_YOU_CAN_NEVER_USE_THAT_ITEM
  | typeof EQUIP_ERR_CANT_EQUIP_WITH_TWOHANDED
  | typeof EQUIP_ERR_CANT_DUAL_WIELD
  | typeof EQUIP_ERR_ITEM_CANT_BE_EQUIPPED
  | typeof EQUIP_ERR_ITEMS_CANT_BE_SWAPPED
  | typeof EQUIP_ERR_ITEM_NOT_FOUND
  | typeof EQUIP_ERR_INVENTORY_FULL;

export type EquipInventoryItem = {
  bag: number;
  slot: number;
  itemGuid: number;
  itemEntry: number;
  inventoryType: number;
  /** item_template.AllowableClass — omit / -1 = all classes */
  allowableClass?: number;
  /** item_template.AllowableRace — omit / -1 = all races */
  allowableRace?: number;
  /** item_template.RequiredLevel */
  requiredLevel?: number;
  /** PERM_ENCHANTMENT_SLOT id (low 16 bits of PLAYER_VISIBLE_ITEM_*_ENCHANTMENT) */
  permanentEnchantment?: number;
  /** TEMP_ENCHANTMENT_SLOT id (high 16 bits) */
  temporaryEnchantment?: number;
};

export type EquipOptions = {
  /** Player::CanDualWield — default false */
  dualWield?: boolean;
  /** Player::CanTitanGrip — default false */
  titanGrip?: boolean;
  /** Allow replacing an occupied dest slot (HandleAutoEquipItem passes true for non-bags) */
  swap?: boolean;
  /** Player race id for AllowableRace (Player::CanUseItem) */
  race?: number;
  /** Player class id for AllowableClass (Player::CanUseItem) */
  classId?: number;
  /** Player level for RequiredLevel (Player::CanUseItem) */
  level?: number;
};

export type EquipMove = {
  itemGuid: number;
  itemEntry: number;
  inventoryType: number;
  fromBag: number;
  fromSlot: number;
  toBag: number;
  toSlot: number;
  permanentEnchantment?: number;
  temporaryEnchantment?: number;
};

export type CanEquipSuccess = { ok: true; destSlot: number };
export type CanEquipFailure = { ok: false; error: InventoryResult };
export type CanEquipResult = CanEquipSuccess | CanEquipFailure;

export type EquipSuccess = {
  ok: true;
  destSlot: number;
  moves: EquipMove[];
  inventory: EquipInventoryItem[];
};
export type EquipFailure = { ok: false; error: InventoryResult };
export type EquipResult = EquipSuccess | EquipFailure;

export type VisibleItemField = { index: number; value: number };

/** SharedDefines / ItemTemplate.h InventoryType 0..28 */
export type InventoryTypeValue =
  | typeof INVTYPE_NON_EQUIP
  | typeof INVTYPE_HEAD
  | typeof INVTYPE_NECK
  | typeof INVTYPE_SHOULDERS
  | typeof INVTYPE_BODY
  | typeof INVTYPE_CHEST
  | typeof INVTYPE_WAIST
  | typeof INVTYPE_LEGS
  | typeof INVTYPE_FEET
  | typeof INVTYPE_WRISTS
  | typeof INVTYPE_HANDS
  | typeof INVTYPE_FINGER
  | typeof INVTYPE_TRINKET
  | typeof INVTYPE_WEAPON
  | typeof INVTYPE_SHIELD
  | typeof INVTYPE_RANGED
  | typeof INVTYPE_CLOAK
  | typeof INVTYPE_2HWEAPON
  | typeof INVTYPE_BAG
  | typeof INVTYPE_TABARD
  | typeof INVTYPE_ROBE
  | typeof INVTYPE_WEAPONMAINHAND
  | typeof INVTYPE_WEAPONOFFHAND
  | typeof INVTYPE_HOLDABLE
  | typeof INVTYPE_AMMO
  | typeof INVTYPE_THROWN
  | typeof INVTYPE_RANGEDRIGHT
  | typeof INVTYPE_QUIVER
  | typeof INVTYPE_RELIC;

function asInventoryType(value: number): InventoryTypeValue | undefined {
  if (value < INVTYPE_NON_EQUIP || value > INVTYPE_RELIC) {
    return undefined;
  }
  return value as InventoryTypeValue;
}

/**
 * Candidate equipment slots for an InventoryType (Player::FindEquipSlot slot list).
 * Relic class checks are out of scope; bag / ammo / quiver return [].
 */
export function equipSlotsForType(
  inventoryType: number,
  options: EquipOptions = {},
): number[] {
  const typed = asInventoryType(inventoryType);
  if (typed === undefined) {
    return [];
  }
  return equipSlotsForKnownType(typed, options);
}

function equipSlotsForKnownType(inventoryType: InventoryTypeValue, options: EquipOptions): number[] {
  const dualWield = options.dualWield === true;
  switch (inventoryType) {
    case INVTYPE_NON_EQUIP:
      return [];
    case INVTYPE_HEAD:
      return [EQUIPMENT_SLOT_HEAD];
    case INVTYPE_NECK:
      return [EQUIPMENT_SLOT_NECK];
    case INVTYPE_SHOULDERS:
      return [EQUIPMENT_SLOT_SHOULDERS];
    case INVTYPE_BODY:
      return [EQUIPMENT_SLOT_BODY];
    case INVTYPE_CHEST:
    case INVTYPE_ROBE:
      return [EQUIPMENT_SLOT_CHEST];
    case INVTYPE_WAIST:
      return [EQUIPMENT_SLOT_WAIST];
    case INVTYPE_LEGS:
      return [EQUIPMENT_SLOT_LEGS];
    case INVTYPE_FEET:
      return [EQUIPMENT_SLOT_FEET];
    case INVTYPE_WRISTS:
      return [EQUIPMENT_SLOT_WRISTS];
    case INVTYPE_HANDS:
      return [EQUIPMENT_SLOT_HANDS];
    case INVTYPE_FINGER:
      return [EQUIPMENT_SLOT_FINGER1, EQUIPMENT_SLOT_FINGER2];
    case INVTYPE_TRINKET:
      return [EQUIPMENT_SLOT_TRINKET1, EQUIPMENT_SLOT_TRINKET2];
    case INVTYPE_CLOAK:
      return [EQUIPMENT_SLOT_BACK];
    case INVTYPE_WEAPON: {
      const slots = [EQUIPMENT_SLOT_MAINHAND];
      if (dualWield) {
        slots.push(EQUIPMENT_SLOT_OFFHAND);
      }
      return slots;
    }
    case INVTYPE_SHIELD:
    case INVTYPE_WEAPONOFFHAND:
    case INVTYPE_HOLDABLE:
      return [EQUIPMENT_SLOT_OFFHAND];
    case INVTYPE_RANGED:
    case INVTYPE_RANGEDRIGHT:
    case INVTYPE_THROWN:
    case INVTYPE_RELIC:
      return [EQUIPMENT_SLOT_RANGED];
    case INVTYPE_2HWEAPON: {
      const slots = [EQUIPMENT_SLOT_MAINHAND];
      if (dualWield && options.titanGrip === true) {
        slots.push(EQUIPMENT_SLOT_OFFHAND);
      }
      return slots;
    }
    case INVTYPE_BAG:
    case INVTYPE_AMMO:
    case INVTYPE_QUIVER:
      return [];
    case INVTYPE_TABARD:
      return [EQUIPMENT_SLOT_TABARD];
    case INVTYPE_WEAPONMAINHAND:
      return [EQUIPMENT_SLOT_MAINHAND];
    default: {
      const _exhaustive: never = inventoryType;
      return _exhaustive;
    }
  }
}

function itemAt(
  inventory: readonly EquipInventoryItem[],
  bag: number,
  slot: number,
): EquipInventoryItem | undefined {
  return inventory.find((row) => row.bag === bag && row.slot === slot);
}

function itemByGuid(
  inventory: readonly EquipInventoryItem[],
  itemGuid: number,
): EquipInventoryItem | undefined {
  return inventory.find((row) => row.itemGuid === itemGuid);
}

function isTwoHandUsed(inventory: readonly EquipInventoryItem[], titanGrip: boolean): boolean {
  if (titanGrip) {
    return false;
  }
  const main = itemAt(inventory, INVENTORY_SLOT_BAG_0, EQUIPMENT_SLOT_MAINHAND);
  return main !== undefined && main.inventoryType === INVTYPE_2HWEAPON;
}

/**
 * Player::FindEquipSlot — pick dest equipment slot for the item.
 */
export function findEquipSlot(
  inventory: readonly EquipInventoryItem[],
  inventoryType: number,
  slot: number,
  options: EquipOptions = {},
): number {
  const swap = options.swap !== false;
  const slots = equipSlotsForType(inventoryType, options);
  if (slots.length === 0) {
    return NULL_SLOT;
  }

  if (slot !== NULL_SLOT) {
    if (swap || !itemAt(inventory, INVENTORY_SLOT_BAG_0, slot)) {
      for (const candidate of slots) {
        if (candidate === slot) {
          return slot;
        }
      }
    }
    return NULL_SLOT;
  }

  for (const candidate of slots) {
    if (!itemAt(inventory, INVENTORY_SLOT_BAG_0, candidate)) {
      if (candidate !== EQUIPMENT_SLOT_OFFHAND || !isTwoHandUsed(inventory, options.titanGrip === true)) {
        return candidate;
      }
    }
  }

  if (swap) {
    for (const candidate of slots) {
      return candidate;
    }
  }

  return NULL_SLOT;
}

/** Player::getClassMask / getRaceMask — `(1 << (id - 1))`. */
export function classOrRaceMask(id: number): number {
  if (id <= 0) {
    return 0;
  }
  return (1 << (id - 1)) >>> 0;
}

/**
 * Player::CanUseItem(ItemTemplate) — class / race / level subset used at equip time.
 */
export function canUseItemTemplate(
  item: Pick<EquipInventoryItem, "allowableClass" | "allowableRace" | "requiredLevel">,
  options: Pick<EquipOptions, "race" | "classId" | "level">,
): InventoryResult {
  if (options.classId !== undefined) {
    const allowable = (item.allowableClass ?? -1) >>> 0;
    if ((allowable & classOrRaceMask(options.classId)) === 0) {
      return EQUIP_ERR_YOU_CAN_NEVER_USE_THAT_ITEM;
    }
  }
  if (options.race !== undefined) {
    const allowable = (item.allowableRace ?? -1) >>> 0;
    if ((allowable & classOrRaceMask(options.race)) === 0) {
      return EQUIP_ERR_YOU_CAN_NEVER_USE_THAT_ITEM;
    }
  }
  const required = item.requiredLevel ?? 0;
  if (options.level !== undefined && options.level < required) {
    return EQUIP_ERR_CANT_EQUIP_LEVEL_I;
  }
  return EQUIP_ERR_OK;
}

/**
 * Player::CanEquipItem (slot / InventoryType / two-hand / offhand subset).
 */
export function canEquip(
  inventory: readonly EquipInventoryItem[],
  itemGuid: number,
  destSlot: number = NULL_SLOT,
  options: EquipOptions = {},
): CanEquipResult {
  const swap = options.swap !== false;
  const titanGrip = options.titanGrip === true;
  const dualWield = options.dualWield === true;

  const item = itemByGuid(inventory, itemGuid);
  if (!item) {
    return { ok: false, error: EQUIP_ERR_ITEM_NOT_FOUND };
  }

  const useErr = canUseItemTemplate(item, options);
  if (useErr !== EQUIP_ERR_OK) {
    return { ok: false, error: useErr };
  }

  const eslot = findEquipSlot(inventory, item.inventoryType, destSlot, options);
  if (eslot === NULL_SLOT) {
    return { ok: false, error: EQUIP_ERR_ITEM_CANT_BE_EQUIPPED };
  }

  if (!swap && itemAt(inventory, INVENTORY_SLOT_BAG_0, eslot)) {
    return { ok: false, error: EQUIP_ERR_NO_EQUIPMENT_SLOT_AVAILABLE };
  }

  const type = item.inventoryType;

  if (eslot === EQUIPMENT_SLOT_OFFHAND) {
    if (type === INVTYPE_WEAPON || type === INVTYPE_WEAPONOFFHAND) {
      if (!dualWield) {
        return { ok: false, error: EQUIP_ERR_CANT_DUAL_WIELD };
      }
    } else if (type === INVTYPE_2HWEAPON) {
      if (!dualWield || !titanGrip) {
        return { ok: false, error: EQUIP_ERR_CANT_DUAL_WIELD };
      }
    }

    if (isTwoHandUsed(inventory, titanGrip)) {
      return { ok: false, error: EQUIP_ERR_CANT_EQUIP_WITH_TWOHANDED };
    }
  }

  if (type === INVTYPE_2HWEAPON) {
    if (eslot === EQUIPMENT_SLOT_OFFHAND) {
      if (!titanGrip) {
        return { ok: false, error: EQUIP_ERR_ITEM_CANT_BE_EQUIPPED };
      }
    } else if (eslot !== EQUIPMENT_SLOT_MAINHAND) {
      return { ok: false, error: EQUIP_ERR_ITEM_CANT_BE_EQUIPPED };
    }

    if (!titanGrip) {
      const offItem = itemAt(inventory, INVENTORY_SLOT_BAG_0, EQUIPMENT_SLOT_OFFHAND);
      if (offItem) {
        const free = countFreeBackpackSlots(inventory, itemGuid);
        const needExtra = itemAt(inventory, INVENTORY_SLOT_BAG_0, eslot) ? 1 : 0;
        // offhand + optional dest swap; source backpack slot frees when item leaves
        if (free < 1 + needExtra) {
          return { ok: false, error: swap ? EQUIP_ERR_ITEMS_CANT_BE_SWAPPED : EQUIP_ERR_INVENTORY_FULL };
        }
      }
    }
  }

  return { ok: true, destSlot: eslot };
}

function occupiedBackpackSlots(
  inventory: readonly EquipInventoryItem[],
  excludeGuid: number,
): Set<number> {
  const used = new Set<number>();
  for (const row of inventory) {
    if (row.itemGuid === excludeGuid) {
      continue;
    }
    if (row.bag === INVENTORY_SLOT_BAG_0 && row.slot >= INVENTORY_SLOT_ITEM_START && row.slot < INVENTORY_SLOT_ITEM_END) {
      used.add(row.slot);
    }
  }
  return used;
}

function countFreeBackpackSlots(inventory: readonly EquipInventoryItem[], movingGuid: number): number {
  const used = occupiedBackpackSlots(inventory, movingGuid);
  const source = itemByGuid(inventory, movingGuid);
  // Source backpack cell becomes free once the item moves to equipment.
  if (
    source &&
    source.bag === INVENTORY_SLOT_BAG_0 &&
    source.slot >= INVENTORY_SLOT_ITEM_START &&
    source.slot < INVENTORY_SLOT_ITEM_END
  ) {
    used.delete(source.slot);
  }
  let free = 0;
  for (let slot = INVENTORY_SLOT_ITEM_START; slot < INVENTORY_SLOT_ITEM_END; slot++) {
    if (!used.has(slot)) {
      free++;
    }
  }
  return free;
}

function takeFreeBackpackSlot(used: Set<number>): number | undefined {
  for (let slot = INVENTORY_SLOT_ITEM_START; slot < INVENTORY_SLOT_ITEM_END; slot++) {
    if (!used.has(slot)) {
      used.add(slot);
      return slot;
    }
  }
  return undefined;
}

/**
 * Equip `itemGuid` into its equipment slot (or `destSlot` when provided).
 * Unequipped pieces (replaced dest, two-hand clearing offhand) move to backpack.
 */
export function equip(
  inventory: readonly EquipInventoryItem[],
  itemGuid: number,
  destSlot: number = NULL_SLOT,
  options: EquipOptions = {},
): EquipResult {
  const check = canEquip(inventory, itemGuid, destSlot, options);
  if (!check.ok) {
    return check;
  }

  const item = itemByGuid(inventory, itemGuid);
  if (!item) {
    return { ok: false, error: EQUIP_ERR_ITEM_NOT_FOUND };
  }

  const eslot = check.destSlot;
  const titanGrip = options.titanGrip === true;
  const moves: EquipMove[] = [];
  const next = inventory.map((row) => ({ ...row }));

  const usedBackpack = occupiedBackpackSlots(next, itemGuid);
  if (
    item.bag === INVENTORY_SLOT_BAG_0 &&
    item.slot >= INVENTORY_SLOT_ITEM_START &&
    item.slot < INVENTORY_SLOT_ITEM_END
  ) {
    usedBackpack.delete(item.slot);
  }

  const unequipToBackpack = (occupied: EquipInventoryItem): InventoryResult | undefined => {
    const packSlot = takeFreeBackpackSlot(usedBackpack);
    if (packSlot === undefined) {
      return EQUIP_ERR_INVENTORY_FULL;
    }
    moves.push({
      itemGuid: occupied.itemGuid,
      itemEntry: occupied.itemEntry,
      inventoryType: occupied.inventoryType,
      fromBag: occupied.bag,
      fromSlot: occupied.slot,
      toBag: INVENTORY_SLOT_BAG_0,
      toSlot: packSlot,
      permanentEnchantment: occupied.permanentEnchantment,
      temporaryEnchantment: occupied.temporaryEnchantment,
    });
    const row = next.find((entry) => entry.itemGuid === occupied.itemGuid);
    if (row) {
      row.bag = INVENTORY_SLOT_BAG_0;
      row.slot = packSlot;
    }
    return undefined;
  };

  const previous = itemAt(next, INVENTORY_SLOT_BAG_0, eslot);
  if (previous && previous.itemGuid !== itemGuid) {
    const err = unequipToBackpack(previous);
    if (err !== undefined) {
      return { ok: false, error: err };
    }
  }

  // Two-hand into mainhand: AutoUnequipOffhandIfNeed
  if (item.inventoryType === INVTYPE_2HWEAPON && eslot === EQUIPMENT_SLOT_MAINHAND && !titanGrip) {
    const offhand = itemAt(next, INVENTORY_SLOT_BAG_0, EQUIPMENT_SLOT_OFFHAND);
    if (offhand && offhand.itemGuid !== itemGuid) {
      const err = unequipToBackpack(offhand);
      if (err !== undefined) {
        return { ok: false, error: options.swap !== false ? EQUIP_ERR_ITEMS_CANT_BE_SWAPPED : err };
      }
    }
  }

  moves.push({
    itemGuid: item.itemGuid,
    itemEntry: item.itemEntry,
    inventoryType: item.inventoryType,
    fromBag: item.bag,
    fromSlot: item.slot,
    toBag: INVENTORY_SLOT_BAG_0,
    toSlot: eslot,
    permanentEnchantment: item.permanentEnchantment,
    temporaryEnchantment: item.temporaryEnchantment,
  });

  const equippedRow = next.find((entry) => entry.itemGuid === itemGuid);
  if (equippedRow) {
    equippedRow.bag = INVENTORY_SLOT_BAG_0;
    equippedRow.slot = eslot;
  }

  return { ok: true, destSlot: eslot, moves, inventory: next };
}

/**
 * Player::SetVisibleItemSlot fields for all 19 equipment slots, plus
 * UNIT_VIRTUAL_ITEM_SLOT_ID[0..2] for main/off/ranged sheathe display.
 */
export function visibleItemFields(equipped: readonly EquipInventoryItem[]): VisibleItemField[] {
  const bySlot = new Map<number, EquipInventoryItem>();
  for (const row of equipped) {
    if (row.bag === INVENTORY_SLOT_BAG_0 && row.slot >= EQUIPMENT_SLOT_START && row.slot < EQUIPMENT_SLOT_END) {
      bySlot.set(row.slot, row);
    }
  }

  const fields: VisibleItemField[] = [];
  for (let slot = EQUIPMENT_SLOT_START; slot < EQUIPMENT_SLOT_END; slot++) {
    const row = bySlot.get(slot);
    const entryIndex = PLAYER_VISIBLE_ITEM_1_ENTRYID + slot * 2;
    const enchantIndex = PLAYER_VISIBLE_ITEM_1_ENCHANTMENT + slot * 2;
    if (row) {
      const perm = (row.permanentEnchantment ?? 0) & 0xffff;
      const temp = (row.temporaryEnchantment ?? 0) & 0xffff;
      fields.push({ index: entryIndex, value: row.itemEntry >>> 0 });
      fields.push({ index: enchantIndex, value: (perm | (temp << 16)) >>> 0 });
    } else {
      fields.push({ index: entryIndex, value: 0 });
      fields.push({ index: enchantIndex, value: 0 });
    }
  }

  const main = bySlot.get(EQUIPMENT_SLOT_MAINHAND);
  const off = bySlot.get(EQUIPMENT_SLOT_OFFHAND);
  const ranged = bySlot.get(EQUIPMENT_SLOT_RANGED);
  fields.push({ index: UNIT_VIRTUAL_ITEM_SLOT_ID, value: main?.itemEntry ?? 0 });
  fields.push({ index: UNIT_VIRTUAL_ITEM_SLOT_ID + 1, value: off?.itemEntry ?? 0 });
  fields.push({ index: UNIT_VIRTUAL_ITEM_SLOT_ID + 2, value: ranged?.itemEntry ?? 0 });

  return fields;
}

/**
 * SMSG_UPDATE_OBJECT values update for already-spawned players (same layout as
 * `fieldUpdateBlock` / `standStateUpdateBlock` in update-object.ts).
 */
export function writeVisibleItemsUpdate(
  guid: number,
  fields: readonly VisibleItemField[],
): Uint8Array {
  return fieldUpdateBlock(guid, fields);
}
