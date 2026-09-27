/**
 * Item refunds and soulbound trade timers (AzerothCore WotLK 3.3.5a).
 *
 * Sources:
 * - item_refund_instance / item_soulbound_trade_data (db_characters)
 * - Item::SaveRefundDataToDB / SetNotRefundable / UpdatePlayedTime / IsRefundExpired
 * - Item::SetSoulboundTradeable / ClearSoulboundTradeable / CheckSoulboundTradeExpire
 * - Player::SendRefundInfo / RefundItem / BuyItemFromVendorSlot refund grant
 * - ItemHandler CMSG_ITEM_REFUND_INFO / CMSG_ITEM_REFUND
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "../database/database.ts";
import { item_refund_instance, item_soulbound_trade_data } from "../database/schema/characters.ts";
import { HOUR } from "../common/duration.ts";
import { ByteWriter } from "../net/byte-buffer.ts";

/** `ItemFieldFlags::ITEM_FIELD_FLAG_BOP_TRADEABLE` */
export const ITEM_FIELD_FLAG_BOP_TRADEABLE = 0x00000100;
/** `ItemFieldFlags::ITEM_FIELD_FLAG_REFUNDABLE` */
export const ITEM_FIELD_FLAG_REFUNDABLE = 0x00001000;

/** Refund / BOP-trade window from `Item::IsRefundExpired` / `CheckSoulboundTradeExpire`. */
export const ITEM_REFUND_DURATION = 2 * HOUR;

/** `DBCStructure.h` — slots in `ItemExtendedCostEntry::reqitem`. */
export const MAX_ITEM_EXTENDED_COST_REQUIREMENTS = 5;

/** Opcodes from `Opcodes.h` / `Opcodes.cpp` (build 12340). */
export const SMSG_ITEM_REFUND_INFO_RESPONSE = 0x4b2;
export const CMSG_ITEM_REFUND_INFO = 0x4b3;
export const CMSG_ITEM_REFUND = 0x4b4;
export const SMSG_ITEM_REFUND_RESULT = 0x4b5;

/** Error code written by `Player::RefundItem` when expired or cannot store tokens. */
export const ITEM_REFUND_RESULT_ERROR = 10;

/** Extended-cost slice used by refund packets and grant-back (from ItemExtendedCost.dbc). */
export type ItemExtendedCostInfo = {
  honor: number;
  arena: number;
  /** Always length `MAX_ITEM_EXTENDED_COST_REQUIREMENTS` when building packets. */
  items: readonly { itemId: number; count: number }[];
};

/** In-memory item fields this topic mutates. */
export type RefundItemState = {
  guid: number;
  flags: number;
  /**
   * `ITEM_FIELD_CREATE_PLAYED_TIME`.
   * Refundable: elapsed seconds since purchase (starts at 0).
   * BOP-tradeable: owner's total played time at grant.
   */
  createPlayedTime: number;
  refundRecipient: number;
  paidMoney: number;
  paidExtendedCost: number;
  /** Space-separated GUID lows persisted in `item_soulbound_trade_data.allowedPlayers`. */
  allowedPlayers: number[];
};

export type RefundPrice = {
  money: number;
  extendedCost: number;
};

export type RefundSuccess = {
  ok: true;
  money: number;
  honor: number;
  arena: number;
  items: { itemId: number; count: number }[];
  deleteItem: true;
  clearFlags: number;
};

export type RefundFailure = {
  ok: false;
  error: number;
  deleteItem: false;
  clearFlags: number;
};

export type RefundResult = RefundSuccess | RefundFailure;

export type ItemRefundInstanceRow = {
  item_guid: number;
  player_guid: number;
  paidMoney: number;
  paidExtendedCost: number;
};

export type ItemSoulboundTradeDataRow = {
  itemGuid: number;
  allowedPlayers: string;
};

function emptyExtendedItems(): { itemId: number; count: number }[] {
  return Array.from({ length: MAX_ITEM_EXTENDED_COST_REQUIREMENTS }, () => ({
    itemId: 0,
    count: 0,
  }));
}

function padExtendedItems(
  items: readonly { itemId: number; count: number }[],
): { itemId: number; count: number }[] {
  const out = emptyExtendedItems();
  for (let i = 0; i < MAX_ITEM_EXTENDED_COST_REQUIREMENTS; i += 1) {
    const entry = items[i];
    if (entry) {
      out[i] = { itemId: entry.itemId >>> 0, count: entry.count >>> 0 };
    }
  }
  return out;
}

export function createRefundItemState(guid: number, flags = 0): RefundItemState {
  return {
    guid: guid >>> 0,
    flags: flags >>> 0,
    createPlayedTime: 0,
    refundRecipient: 0,
    paidMoney: 0,
    paidExtendedCost: 0,
    allowedPlayers: [],
  };
}

/**
 * `Item::SaveRefundDataToDB` + vendor grant path in `BuyItemFromVendorSlot`.
 * Writes the refund row and returns `ITEM_FIELD_FLAG_REFUNDABLE` to OR onto the item.
 * `now` is ignored for the DB row (timer lives on `ITEM_FIELD_CREATE_PLAYED_TIME`);
 * createPlayedTime is reset to 0 like `Item::Create`.
 */
export async function grantRefund(
  db: Db,
  item: RefundItemState,
  buyer: number,
  price: RefundPrice,
  _now: number,
): Promise<number> {
  const itemGuid = item.guid >>> 0;
  const playerGuid = buyer >>> 0;
  const paidMoney = price.money >>> 0;
  const paidExtendedCost = price.extendedCost >>> 0;

  await db.transaction(async (tx) => {
    await tx.delete(item_refund_instance).where(eq(item_refund_instance.item_guid, itemGuid));
    await tx.insert(item_refund_instance).values({ item_guid: itemGuid, player_guid: playerGuid, paidMoney, paidExtendedCost });
  });

  item.refundRecipient = playerGuid;
  item.paidMoney = paidMoney;
  item.paidExtendedCost = paidExtendedCost;
  item.createPlayedTime = 0;
  item.flags = (item.flags | ITEM_FIELD_FLAG_REFUNDABLE) >>> 0;

  return ITEM_FIELD_FLAG_REFUNDABLE;
}

/** `Item::GetPlayedTime` / `IsRefundExpired` — `now` is current elapsed played time. */
export function isRefundExpired(item: Pick<RefundItemState, "createPlayedTime">, now: number): boolean {
  const played = Math.max(item.createPlayedTime >>> 0, now >>> 0);
  return played > ITEM_REFUND_DURATION;
}

/**
 * `Item::SetNotRefundable` — clears flag, in-memory refund fields, and DB row.
 * Used for equip / enchant / trade / timer / destroy paths in C++.
 */
export async function clearRefund(db: Db, item: RefundItemState): Promise<number> {
  if ((item.flags & ITEM_FIELD_FLAG_REFUNDABLE) === 0) {
    return 0;
  }

  await db.delete(item_refund_instance).where(eq(item_refund_instance.item_guid, item.guid >>> 0));

  item.flags = (item.flags & ~ITEM_FIELD_FLAG_REFUNDABLE) >>> 0;
  item.refundRecipient = 0;
  item.paidMoney = 0;
  item.paidExtendedCost = 0;
  return ITEM_FIELD_FLAG_REFUNDABLE;
}

/** Equip clears refundability (`SetNotRefundable` on move/destroy/stack paths). */
export function clearRefundOnEquip(db: Db, item: RefundItemState): Promise<number> {
  return clearRefund(db, item);
}

/** Enchant clears soulbound trade; also clears refund when still refundable. */
export function clearRefundOnEnchant(db: Db, item: RefundItemState): Promise<number> {
  return clearRefund(db, item);
}

/**
 * `Player::RefundItem` decision core (no inventory store checks).
 * `now` is current `GetPlayedTime()` elapsed seconds since purchase.
 * Honor / arena / token items come from the extended-cost DBC slice for `paidExtendedCost`.
 */
export async function refundItem(
  db: Db,
  item: RefundItemState,
  playerGuid: number,
  now: number,
  extendedCost: ItemExtendedCostInfo | null,
): Promise<RefundResult> {
  if ((item.flags & ITEM_FIELD_FLAG_REFUNDABLE) === 0) {
    return {
      ok: false,
      error: ITEM_REFUND_RESULT_ERROR,
      deleteItem: false,
      clearFlags: 0,
    };
  }

  if (isRefundExpired(item, now)) {
    const cleared = await clearRefund(db, item);
    return {
      ok: false,
      error: ITEM_REFUND_RESULT_ERROR,
      deleteItem: false,
      clearFlags: cleared,
    };
  }

  if ((playerGuid >>> 0) !== (item.refundRecipient >>> 0)) {
    const cleared = await clearRefund(db, item);
    return {
      ok: false,
      error: ITEM_REFUND_RESULT_ERROR,
      deleteItem: false,
      clearFlags: cleared,
    };
  }

  const row = await loadItemRefundInstance(db, item.guid, playerGuid);
  if (!row) {
    const cleared = await clearRefund(db, item);
    return {
      ok: false,
      error: ITEM_REFUND_RESULT_ERROR,
      deleteItem: false,
      clearFlags: cleared,
    };
  }

  if (!extendedCost) {
    return {
      ok: false,
      error: ITEM_REFUND_RESULT_ERROR,
      deleteItem: false,
      clearFlags: 0,
    };
  }

  const money = row.paidMoney >>> 0;
  const honor = extendedCost.honor >>> 0;
  const arena = extendedCost.arena >>> 0;
  const items = padExtendedItems(extendedCost.items).filter(
    (entry) => entry.itemId !== 0 && entry.count !== 0,
  );

  const cleared = await clearRefund(db, item);
  return {
    ok: true,
    money,
    honor,
    arena,
    items,
    deleteItem: true,
    clearFlags: cleared,
  };
}

/**
 * `Item::SetSoulboundTradeable` + insert into `item_soulbound_trade_data`.
 * `now` is the owner's `GetTotalPlayedTime()` stored on `ITEM_FIELD_CREATE_PLAYED_TIME`.
 * Returns `ITEM_FIELD_FLAG_BOP_TRADEABLE` to OR onto the item.
 */
export async function grantSoulboundTrade(
  db: Db,
  item: RefundItemState,
  allowedGuid: number | readonly number[],
  now: number,
): Promise<number> {
  const allowed = (Array.isArray(allowedGuid) ? [...allowedGuid] : [allowedGuid]).map(
    (guid) => guid >>> 0,
  );
  const allowedPlayers = allowed.join(" ");

  await db.transaction(async (tx) => {
    await tx.delete(item_soulbound_trade_data).where(eq(item_soulbound_trade_data.itemGuid, item.guid >>> 0));
    await tx.insert(item_soulbound_trade_data).values({ itemGuid: item.guid >>> 0, allowedPlayers });
  });

  item.allowedPlayers = allowed;
  item.createPlayedTime = now >>> 0;
  item.flags = (item.flags | ITEM_FIELD_FLAG_BOP_TRADEABLE) >>> 0;
  return ITEM_FIELD_FLAG_BOP_TRADEABLE;
}

/** `Item::ClearSoulboundTradeable` */
export async function clearSoulboundTrade(db: Db, item: RefundItemState): Promise<number> {
  if ((item.flags & ITEM_FIELD_FLAG_BOP_TRADEABLE) === 0 && item.allowedPlayers.length === 0) {
    return 0;
  }

  await db.delete(item_soulbound_trade_data).where(eq(item_soulbound_trade_data.itemGuid, item.guid >>> 0));

  item.allowedPlayers = [];
  item.flags = (item.flags & ~ITEM_FIELD_FLAG_BOP_TRADEABLE) >>> 0;
  return ITEM_FIELD_FLAG_BOP_TRADEABLE;
}

/**
 * `Item::CheckSoulboundTradeExpire` — trade still allowed while
 * `createPlayedTime + 2*HOUR >= ownerTotalPlayedTime` (`now`).
 */
export function tradeAllowed(
  item: Pick<RefundItemState, "flags" | "createPlayedTime" | "allowedPlayers">,
  now: number,
  traderGuid?: number,
): boolean {
  if ((item.flags & ITEM_FIELD_FLAG_BOP_TRADEABLE) === 0) {
    return false;
  }
  if ((item.createPlayedTime >>> 0) + ITEM_REFUND_DURATION < (now >>> 0)) {
    return false;
  }
  if (traderGuid !== undefined) {
    return item.allowedPlayers.includes(traderGuid >>> 0);
  }
  return item.allowedPlayers.length > 0;
}

/**
 * Apply timer expiry like `CheckSoulboundTradeExpire`.
 * Returns true when the tradeable flag was cleared.
 */
export async function checkSoulboundTradeExpire(
  db: Db,
  item: RefundItemState,
  ownerTotalPlayedTime: number,
): Promise<boolean> {
  if ((item.flags & ITEM_FIELD_FLAG_BOP_TRADEABLE) === 0) {
    return false;
  }
  if ((item.createPlayedTime >>> 0) + ITEM_REFUND_DURATION < (ownerTotalPlayedTime >>> 0)) {
    await clearSoulboundTrade(db, item);
    return true;
  }
  return false;
}

export async function loadItemRefundInstance(
  db: Db,
  itemGuid: number,
  playerGuid: number,
): Promise<ItemRefundInstanceRow | null> {
  const [row] = await db
    .select()
    .from(item_refund_instance)
    .where(and(eq(item_refund_instance.item_guid, itemGuid >>> 0), eq(item_refund_instance.player_guid, playerGuid >>> 0)))
    .limit(1);
  return row ?? null;
}

export async function loadSoulboundTradeData(db: Db, itemGuid: number): Promise<ItemSoulboundTradeDataRow | null> {
  const [row] = await db
    .select()
    .from(item_soulbound_trade_data)
    .where(eq(item_soulbound_trade_data.itemGuid, itemGuid >>> 0))
    .limit(1);
  return row ?? null;
}

export function parseAllowedPlayers(allowedPlayers: string): number[] {
  if (allowedPlayers.length === 0) {
    return [];
  }
  return allowedPlayers
    .split(" ")
    .map((token) => Number.parseInt(token, 10))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => value >>> 0);
}

/**
 * `Player::SendRefundInfo` — `SMSG_ITEM_REFUND_INFO_RESPONSE` body.
 * Layout: guid, money, honor, arena, 5×(itemId, count), unk0, playedTime.
 */
export function buildItemRefundInfoResponse(opts: {
  itemGuid: bigint;
  paidMoney: number;
  honor: number;
  arena: number;
  items?: readonly { itemId: number; count: number }[];
  /** Always 0 in AzerothCore. */
  unk?: number;
  /**
   * `GetTotalPlayedTime() - item->GetPlayedTime()` — client uses this with
   * current played time to show remaining refund window.
   */
  playedTime: number;
}): Uint8Array {
  const w = new ByteWriter();
  w.writeU64(opts.itemGuid);
  w.writeU32(opts.paidMoney >>> 0);
  w.writeU32(opts.honor >>> 0);
  w.writeU32(opts.arena >>> 0);
  const items = padExtendedItems(opts.items ?? []);
  for (const entry of items) {
    w.writeU32(entry.itemId);
    w.writeU32(entry.count);
  }
  w.writeU32((opts.unk ?? 0) >>> 0);
  w.writeU32(opts.playedTime >>> 0);
  return w.toUint8Array();
}

/**
 * `Player::RefundItem` — `SMSG_ITEM_REFUND_RESULT` body.
 * Error path: guid + error (no cost payload). Success: guid, 0, money, honor, arena, 5× pairs.
 */
export function buildItemRefundResult(opts: {
  itemGuid: bigint;
  error: number;
  paidMoney?: number;
  honor?: number;
  arena?: number;
  items?: readonly { itemId: number; count: number }[];
}): Uint8Array {
  const w = new ByteWriter();
  w.writeU64(opts.itemGuid);
  w.writeU32(opts.error >>> 0);
  if ((opts.error >>> 0) !== 0) {
    return w.toUint8Array();
  }
  w.writeU32((opts.paidMoney ?? 0) >>> 0);
  w.writeU32((opts.honor ?? 0) >>> 0);
  w.writeU32((opts.arena ?? 0) >>> 0);
  const items = padExtendedItems(opts.items ?? []);
  for (const entry of items) {
    w.writeU32(entry.itemId);
    w.writeU32(entry.count);
  }
  return w.toUint8Array();
}
