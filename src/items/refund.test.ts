import { testDatabase } from "../database/test-db.ts";
import { describe, expect, test } from "bun:test";
import { HOUR } from "../common/duration.ts";
import { ByteReader } from "../net/byte-buffer.ts";
import {
  CMSG_ITEM_REFUND,
  CMSG_ITEM_REFUND_INFO,
  ITEM_FIELD_FLAG_BOP_TRADEABLE,
  ITEM_FIELD_FLAG_REFUNDABLE,
  ITEM_REFUND_DURATION,
  ITEM_REFUND_RESULT_ERROR,
  MAX_ITEM_EXTENDED_COST_REQUIREMENTS,
  SMSG_ITEM_REFUND_INFO_RESPONSE,
  SMSG_ITEM_REFUND_RESULT,
  buildItemRefundInfoResponse,
  buildItemRefundResult,
  checkSoulboundTradeExpire,
  clearRefundOnEquip,
  createRefundItemState,
  grantRefund,
  grantSoulboundTrade,
  loadItemRefundInstance,
  loadSoulboundTradeData,
  parseAllowedPlayers,
  refundItem,
  tradeAllowed,
  type ItemExtendedCostInfo,
} from "./refund.ts";

function openDb() {
  return testDatabase("characters");
}

const EXTENDED_COST: ItemExtendedCostInfo = {
  honor: 2000,
  arena: 50,
  items: [
    { itemId: 49426, count: 1 },
    { itemId: 0, count: 0 },
    { itemId: 0, count: 0 },
    { itemId: 0, count: 0 },
    { itemId: 0, count: 0 },
  ],
};

describe("opcodes (build 12340)", () => {
  test("match Opcodes.h", () => {
    expect(SMSG_ITEM_REFUND_INFO_RESPONSE).toBe(0x4b2);
    expect(CMSG_ITEM_REFUND_INFO).toBe(0x4b3);
    expect(CMSG_ITEM_REFUND).toBe(0x4b4);
    expect(SMSG_ITEM_REFUND_RESULT).toBe(0x4b5);
  });
});

describe("flag bits and timer", () => {
  test("match ItemTemplate.h and 2 * HOUR", () => {
    expect(ITEM_FIELD_FLAG_BOP_TRADEABLE).toBe(0x00000100);
    expect(ITEM_FIELD_FLAG_REFUNDABLE).toBe(0x00001000);
    expect(ITEM_REFUND_DURATION).toBe(2 * HOUR);
    expect(ITEM_REFUND_DURATION).toBe(7200);
    expect(MAX_ITEM_EXTENDED_COST_REQUIREMENTS).toBe(5);
  });
});

describe("grantRefund / refundItem", () => {
  test("refund within window returns money, honor, and deletes the item", async () => {
    const db = await openDb();
    const item = createRefundItemState(42);
    const flag = await grantRefund(db, item, 7, { money: 150000, extendedCost: 2589 }, 0);
    expect(flag).toBe(ITEM_FIELD_FLAG_REFUNDABLE);
    expect(item.flags & ITEM_FIELD_FLAG_REFUNDABLE).toBe(ITEM_FIELD_FLAG_REFUNDABLE);
    expect(item.paidMoney).toBe(150000);
    expect(item.paidExtendedCost).toBe(2589);
    expect(item.refundRecipient).toBe(7);

    const row = await loadItemRefundInstance(db, 42, 7);
    expect(row).toEqual({
      item_guid: 42,
      player_guid: 7,
      paidMoney: 150000,
      paidExtendedCost: 2589,
    });

    const result = await refundItem(db, item, 7, ITEM_REFUND_DURATION, EXTENDED_COST);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected success");
    }
    expect(result.money).toBe(150000);
    expect(result.honor).toBe(2000);
    expect(result.arena).toBe(50);
    expect(result.items).toEqual([{ itemId: 49426, count: 1 }]);
    expect(result.deleteItem).toBe(true);
    expect(result.clearFlags).toBe(ITEM_FIELD_FLAG_REFUNDABLE);
    expect(item.flags & ITEM_FIELD_FLAG_REFUNDABLE).toBe(0);
    expect(await loadItemRefundInstance(db, 42, 7)).toBeNull();
  });

  test("refund after expiry fails with error 10 and clears refund", async () => {
    const db = await openDb();
    const item = createRefundItemState(99);
    await grantRefund(db, item, 1, { money: 10, extendedCost: 1 }, 0);

    const result = await refundItem(
      db,
      item,
      1,
      ITEM_REFUND_DURATION + 1,
      EXTENDED_COST,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.error).toBe(ITEM_REFUND_RESULT_ERROR);
    expect(result.deleteItem).toBe(false);
    expect(result.clearFlags).toBe(ITEM_FIELD_FLAG_REFUNDABLE);
    expect(item.flags & ITEM_FIELD_FLAG_REFUNDABLE).toBe(0);
    expect(await loadItemRefundInstance(db, 99, 1)).toBeNull();
  });

  test("equip clears refund", async () => {
    const db = await openDb();
    const item = createRefundItemState(5);
    await grantRefund(db, item, 3, { money: 500, extendedCost: 12 }, 0);
    expect(await loadItemRefundInstance(db, 5, 3)).not.toBeNull();

    const cleared = await clearRefundOnEquip(db, item);
    expect(cleared).toBe(ITEM_FIELD_FLAG_REFUNDABLE);
    expect(item.flags & ITEM_FIELD_FLAG_REFUNDABLE).toBe(0);
    expect(item.paidMoney).toBe(0);
    expect(await loadItemRefundInstance(db, 5, 3)).toBeNull();

    const after = await refundItem(db, item, 3, 0, EXTENDED_COST);
    expect(after.ok).toBe(false);
  });
});

describe("soulbound trade", () => {
  test("allowed then denied after the duration", async () => {
    const db = await openDb();
    const item = createRefundItemState(88);
    const grantedAt = 100_000;
    const flag = await grantSoulboundTrade(db, item, [11, 22], grantedAt);
    expect(flag).toBe(ITEM_FIELD_FLAG_BOP_TRADEABLE);
    expect(item.flags & ITEM_FIELD_FLAG_BOP_TRADEABLE).toBe(ITEM_FIELD_FLAG_BOP_TRADEABLE);
    expect(item.createPlayedTime).toBe(grantedAt);
    expect(item.allowedPlayers).toEqual([11, 22]);

    expect(tradeAllowed(item, grantedAt + ITEM_REFUND_DURATION, 11)).toBe(true);
    expect(tradeAllowed(item, grantedAt + ITEM_REFUND_DURATION, 99)).toBe(false);

    const stillOk = grantedAt + ITEM_REFUND_DURATION;
    expect(tradeAllowed(item, stillOk)).toBe(true);

    const expiredAt = grantedAt + ITEM_REFUND_DURATION + 1;
    expect(tradeAllowed(item, expiredAt)).toBe(false);
    expect(await checkSoulboundTradeExpire(db, item, expiredAt)).toBe(true);
    expect(item.flags & ITEM_FIELD_FLAG_BOP_TRADEABLE).toBe(0);
    expect(await loadSoulboundTradeData(db, 88)).toBeNull();
  });
});

describe("persist round trip", () => {
  test("refund and soulbound trade rows survive reload", async () => {
    const db = await openDb();
    const refundItemState = createRefundItemState(1001);
    await grantRefund(db, refundItemState, 55, { money: 999, extendedCost: 77 }, 0);

    const tradeItem = createRefundItemState(1002);
    await grantSoulboundTrade(db, tradeItem, [201, 202, 203], 50_000);

    const refundRow = await loadItemRefundInstance(db, 1001, 55);
    expect(refundRow).toEqual({
      item_guid: 1001,
      player_guid: 55,
      paidMoney: 999,
      paidExtendedCost: 77,
    });

    const tradeRow = await loadSoulboundTradeData(db, 1002);
    expect(tradeRow).toEqual({
      itemGuid: 1002,
      allowedPlayers: "201 202 203",
    });
    expect(parseAllowedPlayers(tradeRow!.allowedPlayers)).toEqual([201, 202, 203]);
  });
});

describe("packet builders", () => {
  test("SMSG_ITEM_REFUND_INFO_RESPONSE layout", () => {
    const itemGuid = 0x4000_0000_0000_00abn;
    const body = buildItemRefundInfoResponse({
      itemGuid,
      paidMoney: 150000,
      honor: 2000,
      arena: 50,
      items: EXTENDED_COST.items,
      playedTime: 12345,
    });
    const r = new ByteReader(body);
    expect(r.readU64()).toBe(itemGuid);
    expect(r.readU32()).toBe(150000);
    expect(r.readU32()).toBe(2000);
    expect(r.readU32()).toBe(50);
    for (let i = 0; i < MAX_ITEM_EXTENDED_COST_REQUIREMENTS; i += 1) {
      const expected = EXTENDED_COST.items[i] ?? { itemId: 0, count: 0 };
      expect(r.readU32()).toBe(expected.itemId);
      expect(r.readU32()).toBe(expected.count);
    }
    expect(r.readU32()).toBe(0);
    expect(r.readU32()).toBe(12345);
    expect(r.remaining).toBe(0);
  });

  test("SMSG_ITEM_REFUND_RESULT success and error layouts", () => {
    const itemGuid = 0x4000_0000_0000_0001n;
    const ok = buildItemRefundResult({
      itemGuid,
      error: 0,
      paidMoney: 100,
      honor: 10,
      arena: 5,
      items: [{ itemId: 1, count: 2 }],
    });
    const okReader = new ByteReader(ok);
    expect(okReader.readU64()).toBe(itemGuid);
    expect(okReader.readU32()).toBe(0);
    expect(okReader.readU32()).toBe(100);
    expect(okReader.readU32()).toBe(10);
    expect(okReader.readU32()).toBe(5);
    expect(okReader.readU32()).toBe(1);
    expect(okReader.readU32()).toBe(2);
    for (let i = 1; i < MAX_ITEM_EXTENDED_COST_REQUIREMENTS; i += 1) {
      expect(okReader.readU32()).toBe(0);
      expect(okReader.readU32()).toBe(0);
    }
    expect(okReader.remaining).toBe(0);

    const err = buildItemRefundResult({
      itemGuid,
      error: ITEM_REFUND_RESULT_ERROR,
    });
    const errReader = new ByteReader(err);
    expect(errReader.readU64()).toBe(itemGuid);
    expect(errReader.readU32()).toBe(10);
    expect(errReader.remaining).toBe(0);
  });
});
