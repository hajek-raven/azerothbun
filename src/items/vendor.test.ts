import { worldFromSql } from "../database/test-world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { expect, test } from "bun:test";
import { ByteReader } from "../net/byte-buffer.ts";
import {
  BUYBACK_SLOT_COUNT,
  BUYBACK_SLOT_START,
  BUY_ERR_NOT_ENOUGHT_MONEY,
  EQUIP_ERR_NOT_ENOUGH_MONEY,
  SMSG_BUY_FAILED,
  SMSG_BUY_ITEM,
  SMSG_LIST_INVENTORY,
  SMSG_SELL_ITEM,
  VENDOR_SESSION_HOOKS,
  VENDOR_STOCK_UNLIMITED,
  addItemToBuyBackSlot,
  buildBuyFailed,
  buildBuyItem,
  buildListInventory,
  buildSellItem,
  buy,
  buyback,
  createBuybackState,
  createVendorStock,
  getRepairCost,
  loadVendor,
  repairOne,
  sell,
  type BuybackItem,
  type NpcVendorRow,
  type RepairableItem,
  SELL_ERR_CANT_SELL_ITEM,
} from "./vendor.ts";

function openVendorDb(): WorldTables {
  const db = WorldTables.fromRows();
  worldFromSql(`
    CREATE TABLE npc_vendor (
      entry INTEGER NOT NULL DEFAULT 0,
      slot INTEGER NOT NULL DEFAULT 0,
      item INTEGER NOT NULL DEFAULT 0,
      maxcount INTEGER NOT NULL DEFAULT 0,
      incrtime INTEGER NOT NULL DEFAULT 0,
      ExtendedCost INTEGER NOT NULL DEFAULT 0,
      VerifiedBuild INTEGER DEFAULT NULL,
      PRIMARY KEY (entry, item, ExtendedCost)
    );
    CREATE TABLE game_event_npc_vendor (
      eventEntry INTEGER NOT NULL,
      guid INTEGER NOT NULL DEFAULT 0,
      slot INTEGER NOT NULL DEFAULT 0,
      item INTEGER NOT NULL DEFAULT 0,
      maxcount INTEGER NOT NULL DEFAULT 0,
      incrtime INTEGER NOT NULL DEFAULT 0,
      ExtendedCost INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (eventEntry, guid, item)
    );
    CREATE TABLE creature (
      guid INTEGER NOT NULL PRIMARY KEY,
      id1 INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE durabilitycosts_dbc (
      ID INTEGER NOT NULL DEFAULT 0 PRIMARY KEY,
      WeaponSubClassCost_1 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_2 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_3 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_4 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_5 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_6 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_7 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_8 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_9 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_10 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_11 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_12 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_13 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_14 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_15 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_16 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_17 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_18 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_19 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_20 INTEGER NOT NULL DEFAULT 0,
      WeaponSubClassCost_21 INTEGER NOT NULL DEFAULT 0,
      ArmorSubClassCost_1 INTEGER NOT NULL DEFAULT 0,
      ArmorSubClassCost_2 INTEGER NOT NULL DEFAULT 0,
      ArmorSubClassCost_3 INTEGER NOT NULL DEFAULT 0,
      ArmorSubClassCost_4 INTEGER NOT NULL DEFAULT 0,
      ArmorSubClassCost_5 INTEGER NOT NULL DEFAULT 0,
      ArmorSubClassCost_6 INTEGER NOT NULL DEFAULT 0,
      ArmorSubClassCost_7 INTEGER NOT NULL DEFAULT 0,
      ArmorSubClassCost_8 INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE durabilityquality_dbc (
      ID INTEGER NOT NULL DEFAULT 0 PRIMARY KEY,
      Data REAL NOT NULL DEFAULT 0
    );
  `, db);
  return db;
}

function seedLimitedVendor(db: WorldTables): void {
  worldFromSql(`INSERT INTO npc_vendor (entry, slot, item, maxcount, incrtime, ExtendedCost, VerifiedBuild)
     VALUES (66, 0, 6270, 1, 9000, 0, 0),
            (66, 1, 2320, 0, 0, 0, 0)`, db);
}

test("loadVendor returns full npc_vendor columns; empty events skip game_event rows", () => {
  const db = openVendorDb();
  seedLimitedVendor(db);
  worldFromSql(`INSERT INTO creature (guid, id) VALUES (7, 66)`, db);
  worldFromSql(`INSERT INTO game_event_npc_vendor (eventEntry, guid, slot, item, maxcount, incrtime, ExtendedCost)
     VALUES (17, 7, 0, 23160, 0, 0, 0)`, db);

  const base = loadVendor(db, 66, []);
  expect(base).toHaveLength(2);
  expect(base[0]).toEqual({
    entry: 66,
    slot: 0,
    item: 6270,
    maxcount: 1,
    incrtime: 9000,
    ExtendedCost: 0,
    VerifiedBuild: 0,
    eventEntry: 0,
  });
  expect(base.every((r) => r.eventEntry === 0)).toBe(true);

  const withEvent = loadVendor(db, 66, [17]);
  expect(withEvent).toHaveLength(3);
  expect(withEvent.some((r) => r.item === 23160 && r.eventEntry === 17)).toBe(true);
});

test("buy reduces money and limited stock", () => {
  const items: NpcVendorRow[] = [
    {
      entry: 66,
      slot: 0,
      item: 6270,
      maxcount: 1,
      incrtime: 9000,
      ExtendedCost: 0,
      VerifiedBuild: 0,
      eventEntry: 0,
    },
  ];
  const stock = createVendorStock();
  const result = buy(items, stock, 0, 6270, 1, 1000, { BuyPrice: 200, BuyCount: 1 }, 1, 0);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.money).toBe(800);
  expect(result.pricePaid).toBe(200);
  expect(result.stockLeft).toBe(0);
  expect(result.itemsGained).toBe(1);
});

test("buy fails with EQUIP_ERR_NOT_ENOUGH_MONEY when poor", () => {
  const items: NpcVendorRow[] = [
    {
      entry: 66,
      slot: 0,
      item: 6270,
      maxcount: 0,
      incrtime: 0,
      ExtendedCost: 0,
      VerifiedBuild: 0,
      eventEntry: 0,
    },
  ];
  const result = buy(items, createVendorStock(), 0, 6270, 1, 50, { BuyPrice: 200, BuyCount: 1 });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBe(EQUIP_ERR_NOT_ENOUGH_MONEY);
  expect(result.buyError).toBe(BUY_ERR_NOT_ENOUGHT_MONEY);
  expect(result.money).toBe(50);
});

test("sell increases money by SellPrice * count", () => {
  const buyback = createBuybackState();
  const sold: BuybackItem = { entry: 6270, count: 3, durability: 0, maxDurability: 0 };
  const result = sell(sold, 2, 100, buyback, {
    SellPrice: 50,
    ItemLevel: 1,
    Quality: 1,
    class: 0,
    subclass: 0,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.price).toBe(100);
  expect(result.money).toBe(200);
  expect(result.buyback.items[0]?.entry).toBe(6270);
  expect(result.buyback.prices[0]).toBe(100);
});

test("sell rejects quest-bound items", () => {
  const buyback = createBuybackState();
  const sold: BuybackItem = { entry: 1, count: 1, durability: 0, maxDurability: 0 };
  const result = sell(sold, 1, 100, buyback, {
    SellPrice: 50,
    ItemLevel: 1,
    Quality: 1,
    class: 0,
    subclass: 0,
    bonding: 4,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.sellError).toBe(SELL_ERR_CANT_SELL_ITEM);
});

test("repair costs the C++ amount for a half-broken item", () => {
  const db = openVendorDb();
  // ItemLevel 10, weapon subclass 0 → WeaponSubClassCost_1 = 5
  worldFromSql(`INSERT INTO durabilitycosts_dbc (ID, WeaponSubClassCost_1) VALUES (10, 5)`, db);
  // Quality 1 → id (1+1)*2 = 4, quality_mod = 1.0
  worldFromSql(`INSERT INTO durabilityquality_dbc (ID, Data) VALUES (4, 1.0)`, db);

  const item: RepairableItem = {
    durability: 50,
    maxDurability: 100,
    ItemLevel: 10,
    Quality: 1,
    class: 2, // weapon
    subclass: 0,
  };

  // LostDurability=50, dmultiplier=5, quality_mod=1 → 250; * discount 1 * rate 1
  expect(getRepairCost(db, item)).toBe(250);

  const repaired = repairOne(db, item, 1000);
  expect(repaired.ok).toBe(true);
  if (!repaired.ok) return;
  expect(repaired.cost).toBe(250);
  expect(repaired.money).toBe(750);
  expect(repaired.item.durability).toBe(100);

  const poor = repairOne(db, item, 100);
  expect(poor.ok).toBe(false);
  expect(poor.error).toBe(EQUIP_ERR_NOT_ENOUGH_MONEY);
});

test("buyback restores the sold item and charges the stored price", () => {
  let state = createBuybackState();
  const item: BuybackItem = { entry: 6270, count: 2, durability: 0, maxDurability: 0 };
  state = addItemToBuyBackSlot(state, item, 100, 1000, 0);

  const result = buyback(state, BUYBACK_SLOT_START, 500);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.money).toBe(400);
  expect(result.price).toBe(100);
  expect(result.item).toEqual(item);
  expect(result.buyback.items[0]).toBeNull();
});

test("13th sale drops the oldest buyback", () => {
  let state = createBuybackState();
  for (let i = 0; i < BUYBACK_SLOT_COUNT; i++) {
    state = addItemToBuyBackSlot(
      state,
      { entry: 1000 + i, count: 1, durability: 0, maxDurability: 0 },
      10 + i,
      1000 + i,
      0,
    );
  }
  expect(state.items.every((x) => x !== null)).toBe(true);
  expect(state.items[0]?.entry).toBe(1000);

  state = addItemToBuyBackSlot(
    state,
    { entry: 9999, count: 1, durability: 0, maxDurability: 0 },
    99,
    2000,
    0,
  );

  const entries = state.items.map((x) => x?.entry);
  expect(entries).not.toContain(1000);
  expect(entries).toContain(9999);
  expect(entries.filter((e) => e != null)).toHaveLength(BUYBACK_SLOT_COUNT);
});

test("packet builders match 3.3.5 layouts", () => {
  const list = buildListInventory(0x100n, [
    {
      slot: 0,
      item: 6270,
      displayId: 1,
      leftInStock: VENDOR_STOCK_UNLIMITED,
      price: 200,
      maxDurability: 0,
      buyCount: 1,
      extendedCost: 0,
    },
  ]);
  const lr = new ByteReader(list);
  expect(lr.readU64()).toBe(0x100n);
  expect(lr.readU8()).toBe(1);
  expect(lr.readU32()).toBe(1);
  expect(lr.readU32()).toBe(6270);
  expect(lr.readU32()).toBe(1);
  expect(lr.readU32()).toBe(VENDOR_STOCK_UNLIMITED);
  expect(lr.readU32()).toBe(200);

  const buyPkt = buildBuyItem(0x100n, 0, VENDOR_STOCK_UNLIMITED, 1);
  const br = new ByteReader(buyPkt);
  expect(br.readU64()).toBe(0x100n);
  expect(br.readU32()).toBe(1);
  expect(br.readU32()).toBe(VENDOR_STOCK_UNLIMITED);
  expect(br.readU32()).toBe(1);

  const fail = buildBuyFailed(0x100n, 6270, BUY_ERR_NOT_ENOUGHT_MONEY);
  const fr = new ByteReader(fail);
  expect(fr.readU64()).toBe(0x100n);
  expect(fr.readU32()).toBe(6270);
  expect(fr.readU8()).toBe(BUY_ERR_NOT_ENOUGHT_MONEY);

  const sellPkt = buildSellItem(0x100n, 0x200n, 2);
  const sr = new ByteReader(sellPkt);
  expect(sr.readU64()).toBe(0x100n);
  expect(sr.readU64()).toBe(0x200n);
  expect(sr.readU8()).toBe(2);

  expect(SMSG_LIST_INVENTORY).toBe(0x19f);
  expect(SMSG_BUY_ITEM).toBe(0x1a4);
  expect(SMSG_BUY_FAILED).toBe(0x1a5);
  expect(SMSG_SELL_ITEM).toBe(0x1a1);
  expect(VENDOR_SESSION_HOOKS[0x19e]).toContain("buildListInventory");
});
