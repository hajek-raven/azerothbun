/**
 * Vendor buy / sell / repair / buyback — port of AzerothCore
 * ObjectMgr::LoadVendors, Player::BuyItemFromVendorSlot, HandleSellItemOpcode,
 * HandleBuybackItem, Player::DurabilityRepair / DurabilityRepairAll,
 * Creature vendor stock, and the SMSG_LIST_INVENTORY / SMSG_BUY_* / SMSG_SELL_ITEM packets.
 *
 * Buyback lives only in session memory (WorldSession clears slots 74..85 on logout).
 */

import {
  creature,
  durabilitycosts_dbc,
  durabilityquality_dbc,
  game_event_npc_vendor,
  npc_vendor,
} from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { ByteWriter } from "../net/byte-buffer.ts";

// --- opcodes (Opcodes.h 3.3.5a) ------------------------------------------------

export const CMSG_LIST_INVENTORY = 0x19e;
export const SMSG_LIST_INVENTORY = 0x19f;
export const CMSG_SELL_ITEM = 0x1a0;
export const SMSG_SELL_ITEM = 0x1a1;
export const CMSG_BUY_ITEM = 0x1a2;
export const CMSG_BUY_ITEM_IN_SLOT = 0x1a3;
export const SMSG_BUY_ITEM = 0x1a4;
export const SMSG_BUY_FAILED = 0x1a5;
export const CMSG_BUYBACK_ITEM = 0x290;
export const CMSG_REPAIR_ITEM = 0x2a8;

/** Wire these in the world session when vendor gossip opens / client sends the CMSG. */
export const VENDOR_SESSION_HOOKS = {
  [CMSG_LIST_INVENTORY]: "buildListInventory after loadVendor",
  [CMSG_BUY_ITEM]: "buy (slot is 1-based from client; subtract 1)",
  [CMSG_BUY_ITEM_IN_SLOT]: "buy into bag/slot",
  [CMSG_SELL_ITEM]: "sell",
  [CMSG_BUYBACK_ITEM]: "buyback (absolute BUYBACK_SLOT)",
  [CMSG_REPAIR_ITEM]: "repairOne if itemGuid else repairAll",
} as const;

// --- slots / limits ------------------------------------------------------------

/** Player.h InventorySlot */
export const BUYBACK_SLOT_START = 74;
export const BUYBACK_SLOT_END = 86;
export const BUYBACK_SLOT_COUNT = BUYBACK_SLOT_END - BUYBACK_SLOT_START;

/** Creature.h — max entries in SMSG_LIST_INVENTORY */
export const MAX_VENDOR_ITEMS = 150;

/** Unlimited stock sentinel sent as int32 in the list / buy packets */
export const VENDOR_STOCK_UNLIMITED = 0xffffffff;

export const ITEM_CLASS_WEAPON = 2;
export const ITEM_CLASS_ARMOR = 4;

/** ItemTemplate.h ITEM_FLAG2_DONT_IGNORE_BUY_PRICE */
export const ITEM_FLAG2_DONT_IGNORE_BUY_PRICE = 0x00000004;

/** Item.h InventoryResult */
export const EQUIP_ERR_OK = 0;
export const EQUIP_ERR_NOT_ENOUGH_MONEY = 29;

/** Item.h BuyResult */
export const BUY_ERR_CANT_FIND_ITEM = 0;
export const BUY_ERR_ITEM_ALREADY_SOLD = 1;
export const BUY_ERR_NOT_ENOUGHT_MONEY = 2;
export const BUY_ERR_SELLER_DONT_LIKE_YOU = 4;
export const BUY_ERR_DISTANCE_TOO_FAR = 5;
export const BUY_ERR_ITEM_SOLD_OUT = 7;
export const BUY_ERR_CANT_CARRY_MORE = 8;
export const BUY_ERR_RANK_REQUIRE = 11;
export const BUY_ERR_REPUTATION_REQUIRE = 12;

/** Item.h SellResult */
export const SELL_ERR_CANT_FIND_ITEM = 1;
export const SELL_ERR_CANT_SELL_ITEM = 2;
export const SELL_ERR_CANT_FIND_VENDOR = 3;
export const SELL_ERR_YOU_DONT_OWN_THAT_ITEM = 4;
export const SELL_ERR_UNK = 5;
export const SELL_ERR_ONLY_EMPTY_BAG = 6;
export const SELL_ERR_CANT_SELL_TO_THIS_MERCHANT = 7;

// --- row / state types ---------------------------------------------------------

/** Full `npc_vendor` row (plus eventEntry when from `game_event_npc_vendor`). */
export type NpcVendorRow = {
  entry: number;
  slot: number;
  item: number;
  maxcount: number;
  incrtime: number;
  ExtendedCost: number;
  VerifiedBuild: number | null;
  /** 0 = base `npc_vendor`; else `game_event_npc_vendor.eventEntry`. */
  eventEntry: number;
};

/** Runtime stock for a limited vendor item (`Creature::m_vendorItemCounts`). */
export type VendorItemCount = {
  itemId: number;
  count: number;
  lastIncrementTime: number;
};

export type VendorStock = Map<number, VendorItemCount>;

/** Item fields needed to price a purchase. */
export type VendorBuyTemplate = {
  BuyPrice: number;
  BuyCount: number;
  /** Optional; bit ITEM_FLAG2_DONT_IGNORE_BUY_PRICE. */
  Flags2?: number;
  displayid?: number;
  MaxDurability?: number;
};

/** Item fields needed to price a sale (and optional durability refund). */
export type VendorSellTemplate = {
  SellPrice: number;
  ItemLevel: number;
  Quality: number;
  class: number;
  subclass: number;
  /** `item_template.bonding` — quest-bound items are unsellable. */
  bonding?: number;
  /** `item_template.Flags` — unused today; reserved for AC flag checks. */
  Flags?: number;
};

/** ItemBondingType BIND_QUEST_ITEM / BIND_QUEST_ITEM1 — cannot sell to vendor. */
export const BONDING_QUEST_ITEM = 4;
export const BONDING_QUEST_ITEM1 = 5;

export type RepairableItem = {
  durability: number;
  maxDurability: number;
  ItemLevel: number;
  Quality: number;
  class: number;
  subclass: number;
};

export type BuybackItem = {
  entry: number;
  count: number;
  durability: number;
  maxDurability: number;
};

/**
 * In-memory buyback (Player m_items[74..85] + PLAYER_FIELD_BUYBACK_PRICE/TIMESTAMP).
 * Not persisted — cleared on logout like WorldSession logout.
 */
export type BuybackState = {
  items: Array<BuybackItem | null>;
  prices: number[];
  timestamps: number[];
  /** Absolute slot cursor, BUYBACK_SLOT_START .. BUYBACK_SLOT_END-1 */
  currentSlot: number;
};

export type MoneyResult<T extends object = object> = T & {
  ok: boolean;
  money: number;
  error?: number;
};


type EventVendorDbRow = {
  eventEntry: number;
  guid: number;
  slot: number;
  item: number;
  maxcount: number;
  incrtime: number;
  ExtendedCost: number;
};

// --- load ----------------------------------------------------------------------

/**
 * Load vendor rows for a creature template entry.
 *
 * Empty `activeEvents` matches startup AC: only `npc_vendor` (events are not
 * applied until GameEventMgr activates them). Non-empty adds
 * `game_event_npc_vendor` rows whose spawn `creature.id1` equals `entry` and
 * whose `eventEntry` is in the list.
 *
 * Negative `item` values are vendor references (LoadReferenceVendor).
 */
export function loadVendor(
  world: WorldTables,
  entry: number,
  activeEvents: readonly number[] = [],
): NpcVendorRow[] {
  const rows: NpcVendorRow[] = [];
  const seen = new Set<string>();

  const base = [...world.where(npc_vendor, "entry", entry)].sort(
    (left, right) => left.slot - right.slot || left.item - right.item || left.ExtendedCost - right.ExtendedCost,
  );

  for (const row of base) {
    appendVendorItem(world, rows, seen, entry, row.slot, row.item, row.maxcount, row.incrtime, row.ExtendedCost, row.VerifiedBuild, 0);
  }

  if (activeEvents.length > 0) {
    const events = new Set(activeEvents);
    const eventRows: EventVendorDbRow[] = world
      .all(game_event_npc_vendor)
      .filter((row) => events.has(row.eventEntry) && world.first(creature, "guid", row.guid)?.id === entry)
      .sort((left, right) => left.slot - right.slot || left.item - right.item || left.ExtendedCost - right.ExtendedCost);

    for (const row of eventRows) {
      appendVendorItem(
        world,
        rows,
        seen,
        entry,
        row.slot,
        row.item,
        row.maxcount,
        row.incrtime,
        row.ExtendedCost,
        null,
        row.eventEntry,
      );
    }
  }

  return rows;
}

function appendVendorItem(
  world: WorldTables,
  rows: NpcVendorRow[],
  seen: Set<string>,
  entry: number,
  slot: number,
  item: number,
  maxcount: number,
  incrtime: number,
  ExtendedCost: number,
  VerifiedBuild: number | null,
  eventEntry: number,
): void {
  if (item < 0) {
    loadReferenceVendor(world, rows, seen, entry, -item);
    return;
  }

  const key = `${item}:${ExtendedCost}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  rows.push({
    entry,
    slot,
    item,
    maxcount,
    incrtime,
    ExtendedCost,
    VerifiedBuild,
    eventEntry,
  });
}

function loadReferenceVendor(
  world: WorldTables,
  rows: NpcVendorRow[],
  seen: Set<string>,
  vendorEntry: number,
  refEntry: number,
): void {
  const refRows = [...world.where(npc_vendor, "entry", refEntry)].sort((left, right) => left.slot - right.slot);

  for (const row of refRows) {
    appendVendorItem(
      world,
      rows,
      seen,
      vendorEntry,
      row.slot,
      row.item,
      row.maxcount,
      row.incrtime,
      row.ExtendedCost,
      row.VerifiedBuild,
      0,
    );
  }
}

// --- stock ---------------------------------------------------------------------

export function createVendorStock(): VendorStock {
  return new Map();
}

/** VendorItem::IsGoldRequired */
export function isGoldRequired(template: VendorBuyTemplate, ExtendedCost: number): boolean {
  const flags2 = template.Flags2 ?? 0;
  return (flags2 & ITEM_FLAG2_DONT_IGNORE_BUY_PRICE) !== 0 || ExtendedCost === 0;
}

/**
 * Creature::GetVendorItemCurrentCount — restocks by BuyCount every incrtime seconds.
 * Unlimited (`maxcount === 0`) returns VENDOR_STOCK_UNLIMITED.
 */
export function getVendorItemCurrentCount(
  vendorItem: Pick<NpcVendorRow, "item" | "maxcount" | "incrtime">,
  stock: VendorStock,
  buyCount: number,
  now: number,
): number {
  if (!vendorItem.maxcount) {
    return VENDOR_STOCK_UNLIMITED;
  }

  const itr = stock.get(vendorItem.item);
  if (!itr) {
    return vendorItem.maxcount;
  }

  if (itr.lastIncrementTime + vendorItem.incrtime <= now) {
    const diff = Math.floor((now - itr.lastIncrementTime) / vendorItem.incrtime);
    if (itr.count + diff * buyCount >= vendorItem.maxcount) {
      stock.delete(vendorItem.item);
      return vendorItem.maxcount;
    }
    itr.count += diff * buyCount;
    itr.lastIncrementTime = now;
  }

  return itr.count;
}

/**
 * Creature::UpdateVendorItemCurrentCount — depletes stock by `usedCount` (BuyCount * count).
 * Returns the new count (0 when unlimited / after depleting).
 */
export function updateVendorItemCurrentCount(
  vendorItem: Pick<NpcVendorRow, "item" | "maxcount" | "incrtime">,
  stock: VendorStock,
  usedCount: number,
  buyCount: number,
  now: number,
): number {
  if (!vendorItem.maxcount) {
    return 0;
  }

  let itr = stock.get(vendorItem.item);
  if (!itr) {
    const newCount = vendorItem.maxcount > usedCount ? vendorItem.maxcount - usedCount : 0;
    stock.set(vendorItem.item, { itemId: vendorItem.item, count: newCount, lastIncrementTime: now });
    return newCount;
  }

  if (itr.lastIncrementTime + vendorItem.incrtime <= now) {
    const diff = Math.floor((now - itr.lastIncrementTime) / vendorItem.incrtime);
    if (itr.count + diff * buyCount < vendorItem.maxcount) {
      itr.count += diff * buyCount;
    } else {
      itr.count = vendorItem.maxcount;
    }
  }

  itr.count = itr.count > usedCount ? itr.count - usedCount : 0;
  itr.lastIncrementTime = now;
  return itr.count;
}

// --- durability / repair -------------------------------------------------------

/** ItemSubClassToDurabilityMultiplierId */
export function itemSubClassToDurabilityMultiplierId(itemClass: number, itemSubClass: number): number {
  switch (itemClass) {
    case ITEM_CLASS_WEAPON:
      return itemSubClass;
    case ITEM_CLASS_ARMOR:
      return itemSubClass + 21;
    default:
      return 0;
  }
}

function durabilityMultiplier(
  world: WorldTables,
  itemLevel: number,
  itemClass: number,
  itemSubClass: number,
): number | null {
  const row = world.first(durabilitycosts_dbc, "ID", itemLevel);

  if (!row) {
    return null;
  }

  const multipliers = [
    row.WeaponSubClassCost_1,
    row.WeaponSubClassCost_2,
    row.WeaponSubClassCost_3,
    row.WeaponSubClassCost_4,
    row.WeaponSubClassCost_5,
    row.WeaponSubClassCost_6,
    row.WeaponSubClassCost_7,
    row.WeaponSubClassCost_8,
    row.WeaponSubClassCost_9,
    row.WeaponSubClassCost_10,
    row.WeaponSubClassCost_11,
    row.WeaponSubClassCost_12,
    row.WeaponSubClassCost_13,
    row.WeaponSubClassCost_14,
    row.WeaponSubClassCost_15,
    row.WeaponSubClassCost_16,
    row.WeaponSubClassCost_17,
    row.WeaponSubClassCost_18,
    row.WeaponSubClassCost_19,
    row.WeaponSubClassCost_20,
    row.WeaponSubClassCost_21,
    row.ArmorSubClassCost_1,
    row.ArmorSubClassCost_2,
    row.ArmorSubClassCost_3,
    row.ArmorSubClassCost_4,
    row.ArmorSubClassCost_5,
    row.ArmorSubClassCost_6,
    row.ArmorSubClassCost_7,
    row.ArmorSubClassCost_8,
  ];

  const index = itemSubClassToDurabilityMultiplierId(itemClass, itemSubClass);
  return multipliers[index] ?? 0;
}

function durabilityQualityMod(world: WorldTables, quality: number): number | null {
  const id = (quality + 1) * 2;
  const row = world.first(durabilityquality_dbc, "ID", id);
  return row ? row.Data : null;
}

/**
 * Player::DurabilityRepair cost for one item (LostDurability * dmultiplier * quality_mod,
 * then * discountMod * repairRate). Artifact-quality zero becomes 1.
 * Returns 0 when the item needs no repair or DBC rows are missing.
 */
export function getRepairCost(
  world: WorldTables,
  item: RepairableItem,
  discountMod = 1,
  repairRate = 1,
): number {
  if (!item.maxDurability) {
    return 0;
  }
  const lost = item.maxDurability - item.durability;
  if (lost <= 0) {
    return 0;
  }

  const dmultiplier = durabilityMultiplier(world, item.ItemLevel, item.class, item.subclass);
  const qualityMod = durabilityQualityMod(world, item.Quality);
  if (dmultiplier === null || qualityMod === null) {
    return 0;
  }

  let costs = Math.trunc(lost * dmultiplier * qualityMod);
  costs = Math.trunc(costs * discountMod * repairRate);
  if (costs === 0) {
    costs = 1;
  }
  return costs;
}

/**
 * Sell-path durability refund (HandleSellItemOpcode): ceil(lost * mult * quality_mod),
 * minimum 1 when lost > 0.
 */
export function getSellDurabilityRefund(
  world: WorldTables,
  item: RepairableItem,
): number {
  if (!item.maxDurability) {
    return 0;
  }
  const lost = item.maxDurability - item.durability;
  if (lost <= 0) {
    return 0;
  }

  const dmultiplier = durabilityMultiplier(world, item.ItemLevel, item.class, item.subclass);
  const qualityMod = durabilityQualityMod(world, item.Quality);
  if (dmultiplier === null || qualityMod === null) {
    return 0;
  }

  let refund = Math.ceil(lost * dmultiplier * qualityMod);
  if (!refund) {
    refund = 1;
  }
  return refund;
}

// --- buyback -------------------------------------------------------------------

export function createBuybackState(): BuybackState {
  return {
    items: Array.from({ length: BUYBACK_SLOT_COUNT }, () => null),
    prices: Array.from({ length: BUYBACK_SLOT_COUNT }, () => 0),
    timestamps: Array.from({ length: BUYBACK_SLOT_COUNT }, () => 0),
    currentSlot: BUYBACK_SLOT_START,
  };
}

function buybackIndex(absoluteSlot: number): number {
  return absoluteSlot - BUYBACK_SLOT_START;
}

/**
 * Player::AddItemToBuyBackSlot — 12 slots; when full, replaces the oldest timestamp.
 * Timestamp matches PLAYER_FIELD_BUYBACK_TIMESTAMP: now - loginTime + 30h.
 */
export function addItemToBuyBackSlot(
  state: BuybackState,
  item: BuybackItem,
  money: number,
  now: number,
  loginTime: number,
): BuybackState {
  let slot = state.currentSlot;
  const idx = buybackIndex(slot);

  if (state.items[idx]) {
    let oldestTime = state.timestamps[0]!;
    let oldestSlot = BUYBACK_SLOT_START;

    for (let absolute = BUYBACK_SLOT_START + 1; absolute < BUYBACK_SLOT_END; absolute++) {
      const i = buybackIndex(absolute);
      if (!state.items[i]) {
        slot = absolute;
        break;
      }
      const iTime = state.timestamps[i]!;
      if (oldestTime > iTime) {
        oldestTime = iTime;
        oldestSlot = absolute;
      }
    }
    // C++ always assigns oldest_slot after the loop (even if an empty hole was found).
    slot = oldestSlot;
  }

  removeItemFromBuyBackSlot(state, slot);

  const eslot = buybackIndex(slot);
  const etime = (now - loginTime + 30 * 3600) >>> 0;
  state.items[eslot] = item;
  state.prices[eslot] = money;
  state.timestamps[eslot] = etime;

  if (state.currentSlot < BUYBACK_SLOT_END - 1) {
    state.currentSlot += 1;
  }

  return state;
}

export function getItemFromBuyBackSlot(state: BuybackState, absoluteSlot: number): BuybackItem | null {
  if (absoluteSlot < BUYBACK_SLOT_START || absoluteSlot >= BUYBACK_SLOT_END) {
    return null;
  }
  return state.items[buybackIndex(absoluteSlot)] ?? null;
}

export function removeItemFromBuyBackSlot(state: BuybackState, absoluteSlot: number, _del = true): void {
  if (absoluteSlot < BUYBACK_SLOT_START || absoluteSlot >= BUYBACK_SLOT_END) {
    return;
  }
  const eslot = buybackIndex(absoluteSlot);
  state.items[eslot] = null;
  state.prices[eslot] = 0;
  state.timestamps[eslot] = 0;

  if (state.items[buybackIndex(state.currentSlot)]) {
    state.currentSlot = absoluteSlot;
  }
}

// --- transactions --------------------------------------------------------------

export type BuyOk = MoneyResult<{
  ok: true;
  itemsGained: number;
  stockLeft: number;
  pricePaid: number;
  vendorSlot: number;
}>;

export type BuyFail = MoneyResult<{
  ok: false;
  buyError: number;
}>;

/**
 * Player::BuyItemFromVendorSlot (gold path). Depletes limited stock.
 * `discountMod` is GetReputationPriceDiscount (default 1).
 */
export function buy(
  vendorItems: readonly NpcVendorRow[],
  stock: VendorStock,
  vendorslot: number,
  item: number,
  count: number,
  money: number,
  template: VendorBuyTemplate,
  discountMod = 1,
  now = 0,
): BuyOk | BuyFail {
  let buyCount = count < 1 ? 1 : count;

  if (vendorslot < 0 || vendorslot >= vendorItems.length) {
    return { ok: false, money, buyError: BUY_ERR_CANT_FIND_ITEM };
  }

  const crItem = vendorItems[vendorslot]!;
  if (crItem.item !== item) {
    return { ok: false, money, buyError: BUY_ERR_CANT_FIND_ITEM };
  }

  const units = template.BuyCount * buyCount;
  if (crItem.maxcount !== 0) {
    const left = getVendorItemCurrentCount(crItem, stock, template.BuyCount, now);
    if (left < units) {
      return { ok: false, money, buyError: BUY_ERR_ITEM_ALREADY_SOLD };
    }
  }

  let pricePaid = 0;
  if (isGoldRequired(template, crItem.ExtendedCost) && template.BuyPrice > 0) {
    // C++: price = BuyPrice * count; then floor(price * discountMod).
    pricePaid = Math.floor(template.BuyPrice * buyCount);
    pricePaid = Math.floor(pricePaid * discountMod);

    if (money < pricePaid) {
      return {
        ok: false,
        money,
        error: EQUIP_ERR_NOT_ENOUGH_MONEY,
        buyError: BUY_ERR_NOT_ENOUGHT_MONEY,
      };
    }
  }

  const stockLeft = updateVendorItemCurrentCount(crItem, stock, units, template.BuyCount, now);

  return {
    ok: true,
    money: money - pricePaid,
    itemsGained: units,
    stockLeft: crItem.maxcount > 0 ? stockLeft : VENDOR_STOCK_UNLIMITED,
    pricePaid,
    vendorSlot: vendorslot,
  };
}

export type SellOk = MoneyResult<{
  ok: true;
  price: number;
  buyback: BuybackState;
}>;

export type SellFail = MoneyResult<{
  ok: false;
  sellError: number;
  buyback: BuybackState;
}>;

/**
 * HandleSellItemOpcode gold path. Adds the sold stack to buyback.
 * Pass `world` when the item has lost durability so the AC refund applies.
 */
export function sell(
  sold: BuybackItem,
  sellCount: number,
  money: number,
  buyback: BuybackState,
  template: VendorSellTemplate,
  opts: {
    world?: WorldTables;
    now?: number;
    loginTime?: number;
  } = {},
): SellOk | SellFail {
  if (template.SellPrice <= 0) {
    return { ok: false, money, sellError: SELL_ERR_CANT_SELL_ITEM, buyback };
  }

  const bonding = template.bonding ?? 0;
  if (bonding === BONDING_QUEST_ITEM || bonding === BONDING_QUEST_ITEM1) {
    return { ok: false, money, sellError: SELL_ERR_CANT_SELL_ITEM, buyback };
  }

  let count = sellCount === 0 ? sold.count : sellCount;
  if (count > sold.count || count <= 0) {
    return { ok: false, money, sellError: SELL_ERR_CANT_SELL_ITEM, buyback };
  }

  let price = template.SellPrice * count;

  if (opts.world && sold.maxDurability > 0) {
    const refund = getSellDurabilityRefund(opts.world, {
      durability: sold.durability,
      maxDurability: sold.maxDurability,
      ItemLevel: template.ItemLevel,
      Quality: template.Quality,
      class: template.class,
      subclass: template.subclass,
    });
    if (refund > 0) {
      if (refund > price) {
        price = 1;
      } else {
        price -= refund;
      }
    }
  }

  const buybackItem: BuybackItem = {
    entry: sold.entry,
    count,
    durability: sold.durability,
    maxDurability: sold.maxDurability,
  };

  addItemToBuyBackSlot(buyback, buybackItem, price, opts.now ?? 0, opts.loginTime ?? 0);

  return {
    ok: true,
    money: money + price,
    price,
    buyback,
  };
}

export type RepairOk = MoneyResult<{
  ok: true;
  cost: number;
  item: RepairableItem;
}>;

export type RepairFail = MoneyResult<{
  ok: false;
}>;

/** Player::DurabilityRepair for one item. */
export function repairOne(
  world: WorldTables,
  item: RepairableItem,
  money: number,
  discountMod = 1,
  repairRate = 1,
): RepairOk | RepairFail {
  const cost = getRepairCost(world, item, discountMod, repairRate);
  if (cost > 0 && money < cost) {
    return { ok: false, money, error: EQUIP_ERR_NOT_ENOUGH_MONEY };
  }

  const repaired: RepairableItem = {
    ...item,
    durability: item.maxDurability,
  };

  return {
    ok: true,
    money: money - cost,
    cost,
    item: repaired,
  };
}

/** Player::DurabilityRepairAll — total cost first; fail entirely if short. */
export function repairAll(
  world: WorldTables,
  items: RepairableItem[],
  money: number,
  discountMod = 1,
  repairRate = 1,
): MoneyResult<{ ok: true; cost: number; items: RepairableItem[] } | { ok: false }> {
  let total = 0;
  for (const item of items) {
    total += getRepairCost(world, item, discountMod, repairRate);
  }

  if (total > 0 && money < total) {
    return { ok: false, money, error: EQUIP_ERR_NOT_ENOUGH_MONEY };
  }

  const repaired = items.map((item) => ({
    ...item,
    durability: item.maxDurability || item.durability,
  }));

  return {
    ok: true,
    money: money - total,
    cost: total,
    items: repaired,
  };
}

export type BuybackOk = MoneyResult<{
  ok: true;
  item: BuybackItem;
  price: number;
  buyback: BuybackState;
}>;

export type BuybackFail = MoneyResult<{
  ok: false;
  buyError: number;
  buyback: BuybackState;
}>;

/** HandleBuybackItem — charges PLAYER_FIELD_BUYBACK_PRICE for the slot. */
export function buyback(
  state: BuybackState,
  absoluteSlot: number,
  money: number,
): BuybackOk | BuybackFail {
  const item = getItemFromBuyBackSlot(state, absoluteSlot);
  if (!item) {
    return { ok: false, money, buyError: BUY_ERR_CANT_FIND_ITEM, buyback: state };
  }

  const price = state.prices[buybackIndex(absoluteSlot)]!;
  if (money < price) {
    return {
      ok: false,
      money,
      error: EQUIP_ERR_NOT_ENOUGH_MONEY,
      buyError: BUY_ERR_NOT_ENOUGHT_MONEY,
      buyback: state,
    };
  }

  removeItemFromBuyBackSlot(state, absoluteSlot, false);

  return {
    ok: true,
    money: money - price,
    item,
    price,
    buyback: state,
  };
}

// --- packets -------------------------------------------------------------------

export type ListInventoryItem = {
  /** 0-based vendor slot (packet writes slot+1). */
  slot: number;
  item: number;
  displayId: number;
  /** Unlimited = VENDOR_STOCK_UNLIMITED. */
  leftInStock: number;
  price: number;
  maxDurability: number;
  buyCount: number;
  extendedCost: number;
};

/** WorldSession::SendListInventory */
export function buildListInventory(vendorGuid: bigint, items: readonly ListInventoryItem[]): Uint8Array {
  const w = new ByteWriter();
  w.writeU64(vendorGuid);

  if (items.length === 0) {
    w.writeU8(0);
    w.writeU8(0);
    return w.toUint8Array();
  }

  const count = Math.min(items.length, MAX_VENDOR_ITEMS);
  w.writeU8(count);
  for (let i = 0; i < count; i++) {
    const it = items[i]!;
    w.writeU32(it.slot + 1);
    w.writeU32(it.item);
    w.writeU32(it.displayId);
    w.writeU32(it.leftInStock >>> 0);
    w.writeU32(it.price);
    w.writeU32(it.maxDurability);
    w.writeU32(it.buyCount);
    w.writeU32(it.extendedCost);
  }
  return w.toUint8Array();
}

/** Build list entries from loaded vendor rows + templates + stock. */
export function listInventoryEntries(
  vendorItems: readonly NpcVendorRow[],
  stock: VendorStock,
  templates: ReadonlyMap<number, VendorBuyTemplate & { displayid: number; MaxDurability: number }>,
  discountMod = 1,
  now = 0,
): ListInventoryItem[] {
  const out: ListInventoryItem[] = [];
  for (let slot = 0; slot < vendorItems.length && out.length < MAX_VENDOR_ITEMS; slot++) {
    const v = vendorItems[slot]!;
    const proto = templates.get(v.item);
    if (!proto) {
      continue;
    }
    const left = getVendorItemCurrentCount(v, stock, proto.BuyCount, now);
    if (v.maxcount !== 0 && left === 0) {
      continue;
    }
    const price = isGoldRequired(proto, v.ExtendedCost) ? Math.floor(proto.BuyPrice * discountMod) : 0;
    out.push({
      slot,
      item: v.item,
      displayId: proto.displayid,
      leftInStock: left,
      price,
      maxDurability: proto.MaxDurability,
      buyCount: proto.BuyCount,
      extendedCost: v.ExtendedCost,
    });
  }
  return out;
}

/** Player::_StoreOrEquipNewItem SMSG_BUY_ITEM */
export function buildBuyItem(
  vendorGuid: bigint,
  vendorSlot0Based: number,
  newCount: number,
  count: number,
): Uint8Array {
  return new ByteWriter()
    .writeU64(vendorGuid)
    .writeU32(vendorSlot0Based + 1)
    .writeU32(newCount >>> 0)
    .writeU32(count)
    .toUint8Array();
}

/** Player::SendBuyError → SMSG_BUY_FAILED */
export function buildBuyFailed(
  vendorGuid: bigint,
  item: number,
  buyError: number,
  param = 0,
): Uint8Array {
  const w = new ByteWriter().writeU64(vendorGuid).writeU32(item);
  if (param > 0) {
    w.writeU32(param);
  }
  return w.writeU8(buyError).toUint8Array();
}

/** Player::SendSellError → SMSG_SELL_ITEM */
export function buildSellItem(
  vendorGuid: bigint,
  itemGuid: bigint,
  sellError: number,
  param = 0,
): Uint8Array {
  const w = new ByteWriter().writeU64(vendorGuid).writeU64(itemGuid);
  if (param > 0) {
    w.writeU32(param);
  }
  return w.writeU8(sellError).toUint8Array();
}
