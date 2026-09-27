import { testDatabase } from "../database/test-db.ts";
import { worldFromSql } from "../database/test-world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { expect, test } from "bun:test";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import {
  createInventory,
  INVENTORY_SLOT_ITEM_START,
  type Inventory,
  type InventoryItem,
} from "../items/bags.ts";
import { createItem, SetDurability, saveItem, loadItem } from "../items/instance.ts";
import {
  BUYBACK_SLOT_START,
  CMSG_BUY_ITEM,
  CMSG_BUYBACK_ITEM,
  CMSG_LIST_INVENTORY,
  CMSG_REPAIR_ITEM,
  CMSG_SELL_ITEM,
  SMSG_BUY_FAILED,
  SMSG_BUY_ITEM,
  SMSG_LIST_INVENTORY,
  SMSG_SELL_ITEM,
} from "../items/vendor.ts";
import {
  createVendorSession,
  handleVendor,
  VENDOR_OPCODES,
  type VendorPlayCtx,
} from "./vendor-play.ts";

const VENDOR_SPAWN = 7;
const VENDOR_ENTRY = 66;
const ITEM_ENTRY = 6270;
const SELL_ITEM_ENTRY = 2589;
const PLAYER_GUID = 1;

function openWorld(): WorldTables {
  return worldFromSql(`
    INSERT INTO creature (guid, id) VALUES (${VENDOR_SPAWN}, ${VENDOR_ENTRY});
    INSERT INTO npc_vendor (entry, slot, item, maxcount, incrtime, ExtendedCost, VerifiedBuild)
      VALUES (${VENDOR_ENTRY}, 0, ${ITEM_ENTRY}, 0, 0, 0, 0);
    INSERT INTO item_template (
       entry, class, subclass, displayid, BuyCount, BuyPrice, SellPrice,
       InventoryType, ContainerSlots, BagFamily, bonding, ItemLevel, Quality, MaxDurability
     ) VALUES
       (${ITEM_ENTRY}, 4, 1, 10, 1, 200, 50, 0, 0, 0, 0, 10, 1, 0),
       (${SELL_ITEM_ENTRY}, 4, 1, 11, 1, 0, 25, 0, 0, 0, 0, 10, 1, 100),
       (9999, 2, 0, 12, 1, 0, 0, 0, 0, 0, 0, 10, 1, 100);
    -- ItemLevel 10 weapon subclass 0 → cost 5; Quality 1 → quality id 4 mod 1.0
    INSERT INTO durabilitycosts_dbc (ID, WeaponSubClassCost_1) VALUES (10, 5);
    INSERT INTO durabilityquality_dbc (ID, Data) VALUES (4, 1.0);
  `);
}

function openChars() {
  return testDatabase("characters");
}

type TestDb = Awaited<ReturnType<typeof openChars>>;

function vendorGuid(): bigint {
  return BigInt(VENDOR_SPAWN) | (BigInt(VENDOR_ENTRY) << 24n) | (0xf130n << 48n);
}

function listPayload(): Uint8Array {
  return new ByteWriter().writeU64(vendorGuid()).toUint8Array();
}

function buyPayload(item: number, slot1Based: number, count: number): Uint8Array {
  return new ByteWriter()
    .writeU64(vendorGuid())
    .writeU32(item)
    .writeU32(slot1Based)
    .writeU32(count)
    .writeU8(0)
    .toUint8Array();
}

function sellPayload(itemGuid: number, count: number): Uint8Array {
  const packed = BigInt(itemGuid) | (0x4000n << 48n);
  return new ByteWriter()
    .writeU64(vendorGuid())
    .writeU64(packed)
    .writeU32(count)
    .toUint8Array();
}

function buybackPayload(slot: number): Uint8Array {
  return new ByteWriter().writeU64(vendorGuid()).writeU32(slot).toUint8Array();
}

function repairPayload(itemGuid: number): Uint8Array {
  const packed = itemGuid === 0 ? 0n : BigInt(itemGuid) | (0x4000n << 48n);
  return new ByteWriter()
    .writeU64(vendorGuid())
    .writeU64(packed)
    .writeU8(0)
    .toUint8Array();
}

function makeCtx(
  chars: TestDb,
  world: WorldTables,
  money: number,
  inventory: Inventory,
): VendorPlayCtx {
  return {
    db: chars,
    world,
    playerGuid: PLAYER_GUID,
    money,
    inventory,
  };
}

function placeBackpack(inv: Inventory, item: InventoryItem, slot = INVENTORY_SLOT_ITEM_START): void {
  let bag = inv.slots.get(0);
  if (!bag) {
    bag = new Map();
    inv.slots.set(0, bag);
  }
  bag.set(slot, item);
  inv.byGuid.set(item.guid, { bag: 0, slot });
}

test("VENDOR_OPCODES covers list/buy/sell/buyback/repair", () => {
  expect(VENDOR_OPCODES.has(CMSG_LIST_INVENTORY)).toBe(true);
  expect(VENDOR_OPCODES.has(CMSG_BUY_ITEM)).toBe(true);
  expect(VENDOR_OPCODES.has(CMSG_SELL_ITEM)).toBe(true);
  expect(VENDOR_OPCODES.has(CMSG_BUYBACK_ITEM)).toBe(true);
  expect(VENDOR_OPCODES.has(CMSG_REPAIR_ITEM)).toBe(true);
});

test("list inventory returns vendor rows", async () => {
  const world = openWorld();
  const chars = await openChars();
  const session = createVendorSession(0);
  const result = await handleVendor(
    CMSG_LIST_INVENTORY,
    listPayload(),
    makeCtx(chars, world, 1000, createInventory()),
    session,
  );
  expect(result).not.toBeNull();
  expect(result!.packets[0]!.opcode).toBe(SMSG_LIST_INVENTORY);
  const body = new ByteReader(result!.packets[0]!.body);
  expect(body.readU64()).toBe(vendorGuid());
  expect(body.readU8()).toBe(1);
  expect(body.readU32()).toBe(1); // slot+1
  expect(body.readU32()).toBe(ITEM_ENTRY);
});

test("buy decreases money and stores the item", async () => {
  const world = openWorld();
  const chars = await openChars();
  const inv = createInventory();
  const session = createVendorSession(0);
  const ctx = makeCtx(chars, world, 1000, inv);
  const result = await handleVendor(CMSG_BUY_ITEM, buyPayload(ITEM_ENTRY, 1, 1), ctx, session);
  expect(result).not.toBeNull();
  expect(result!.money).toBe(800);
  expect(result!.packets.some((p) => p.opcode === SMSG_BUY_ITEM)).toBe(true);
  expect(inv.byGuid.size).toBe(1);
  const stored = [...inv.byGuid.keys()][0]!;
  const pos = inv.byGuid.get(stored)!;
  expect(pos.slot).toBeGreaterThanOrEqual(INVENTORY_SLOT_ITEM_START);
  expect(getEntry(inv, stored)).toBe(ITEM_ENTRY);
});

test("sell increases money and fills buyback", async () => {
  const world = openWorld();
  const chars = await openChars();
  const inv = createInventory();
  const instance = await createItem(chars, world, {
    entry: SELL_ITEM_ENTRY,
    owner: PLAYER_GUID,
    count: 1,
    durability: 100,
    maxDurability: 100,
  });
  placeBackpack(inv, {
    guid: instance.guid,
    entry: SELL_ITEM_ENTRY,
    count: 1,
    template: {
      entry: SELL_ITEM_ENTRY,
      InventoryType: 0,
      ContainerSlots: 0,
      BagFamily: 0,
      class: 4,
      subclass: 1,
      bonding: 0,
    },
  });
  const session = createVendorSession(0);
  const ctx = makeCtx(chars, world, 100, inv);
  const result = await handleVendor(CMSG_SELL_ITEM, sellPayload(instance.guid, 1), ctx, session);
  expect(result).not.toBeNull();
  expect(result!.money).toBe(125);
  expect(result!.packets.some((p) => p.opcode === SMSG_SELL_ITEM)).toBe(true);
  expect(inv.byGuid.size).toBe(0);
  expect(session.buyback.items[0]?.entry).toBe(SELL_ITEM_ENTRY);
  expect(session.buyback.prices[0]).toBe(25);
});

test("buyback restores the sold item and charges", async () => {
  const world = openWorld();
  const chars = await openChars();
  const inv = createInventory();
  const instance = await createItem(chars, world, {
    entry: SELL_ITEM_ENTRY,
    owner: PLAYER_GUID,
    count: 1,
  });
  placeBackpack(inv, {
    guid: instance.guid,
    entry: SELL_ITEM_ENTRY,
    count: 1,
    template: {
      entry: SELL_ITEM_ENTRY,
      InventoryType: 0,
      ContainerSlots: 0,
      BagFamily: 0,
      class: 4,
      subclass: 1,
      bonding: 0,
    },
  });
  const session = createVendorSession(0);
  const ctx = makeCtx(chars, world, 200, inv);
  await handleVendor(CMSG_SELL_ITEM, sellPayload(instance.guid, 1), ctx, session);
  expect(ctx.money).toBe(225);

  const back = await handleVendor(
    CMSG_BUYBACK_ITEM,
    buybackPayload(BUYBACK_SLOT_START),
    ctx,
    session,
  );
  expect(back).not.toBeNull();
  expect(back!.money).toBe(200);
  expect(inv.byGuid.size).toBe(1);
  expect(session.buyback.items[0]).toBeNull();
});

test("repair fails when the player cannot afford it", async () => {
  const world = openWorld();
  const chars = await openChars();
  const inv = createInventory();
  const instance = await createItem(chars, world, {
    entry: 9999,
    owner: PLAYER_GUID,
    count: 1,
    durability: 50,
    maxDurability: 100,
  });
  SetDurability(instance, 50, 100);
  await saveItem(chars, instance);
  placeBackpack(inv, {
    guid: instance.guid,
    entry: 9999,
    count: 1,
    template: {
      entry: 9999,
      InventoryType: 0,
      ContainerSlots: 0,
      BagFamily: 0,
      class: 2,
      subclass: 0,
      bonding: 0,
    },
  });
  const session = createVendorSession(0);
  const ctx = makeCtx(chars, world, 100, inv); // cost is 250
  const result = await handleVendor(CMSG_REPAIR_ITEM, repairPayload(instance.guid), ctx, session);
  expect(result).not.toBeNull();
  expect(result!.money ?? ctx.money).toBe(100);
  const after = await loadItem(chars, world, instance.guid);
  expect(after?.durability).toBe(50);
});

test("unknown opcode returns null", async () => {
  const world = openWorld();
  const chars = await openChars();
  expect(
    await handleVendor(0x1, new Uint8Array(), makeCtx(chars, world, 0, createInventory()), createVendorSession()),
  ).toBeNull();
});

test("buy with insufficient money sends SMSG_BUY_FAILED", async () => {
  const world = openWorld();
  const chars = await openChars();
  const session = createVendorSession(0);
  const result = await handleVendor(
    CMSG_BUY_ITEM,
    buyPayload(ITEM_ENTRY, 1, 1),
    makeCtx(chars, world, 50, createInventory()),
    session,
  );
  expect(result!.packets.some((p) => p.opcode === SMSG_BUY_FAILED)).toBe(true);
  expect(result!.money ?? 50).toBe(50);
});

function getEntry(inv: Inventory, guid: number): number {
  const pos = inv.byGuid.get(guid)!;
  return inv.slots.get(pos.bag)!.get(pos.slot)!.entry;
}
