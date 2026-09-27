import { testDatabase } from "../database/test-db.ts";
import { objectGuids } from "../game/globals/object-guids.ts";
import { characters, item_instance } from "../database/schema/characters.ts";
import { describe, expect, test } from "bun:test";
import {
  BAG_FAMILY_MASK_KEYS,
  CMSG_BUY_BANK_SLOT,
  CMSG_DESTROYITEM,
  CMSG_SPLIT_ITEM,
  CMSG_SWAP_INV_ITEM,
  createInventory,
  EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG,
  getItem,
  INVENTORY_SLOT_ITEM_START,
  ITEM_CLASS_KEY,
  KEYRING_SLOT_START,
  storeItem,
  type InventoryItem,
  type ItemTemplateSlice,
} from "../items/bags.ts";
import { emptyChargesString, emptyEnchantmentsString } from "../items/instance.ts";
import { ByteWriter } from "../net/byte-buffer.ts";
import { visibleGearPacket } from "./equip-play.ts";
import {
  BAG_OPCODES,
  handleBags,
  loginItemPackets,
  loadPlayInventory,
  savePlayInventory,
  type BagPlayCtx,
} from "./bags-play.ts";

function tpl(partial: Partial<ItemTemplateSlice> & Pick<ItemTemplateSlice, "entry">): ItemTemplateSlice {
  return {
    InventoryType: 0,
    ContainerSlots: 0,
    BagFamily: 0,
    class: 0,
    subclass: 0,
    bonding: 0,
    stackable: 1,
    displayid: 0,
    ...partial,
  };
}

function item(guid: number, template: ItemTemplateSlice, count = 1): InventoryItem {
  return { guid, entry: template.entry, count, template };
}

const junk = () => tpl({ entry: 1001, class: 15, subclass: 0, stackable: 20 });
const key = () =>
  tpl({
    entry: 1003,
    class: ITEM_CLASS_KEY,
    subclass: 0,
    BagFamily: BAG_FAMILY_MASK_KEYS,
  });

function memDb() {
  return testDatabase("characters");
}

async function ctx(
  inventory: ReturnType<typeof createInventory>,
  overrides: Partial<BagPlayCtx> = {},
): Promise<BagPlayCtx> {
  return {
    db: await memDb(),
    world: null,
    playerGuid: 1,
    money: 10_000,
    inventory,
    ...overrides,
  };
}

describe("BAG_OPCODES", () => {
  test("includes required client opcodes", async () => {
    expect(BAG_OPCODES.has(0x10b)).toBe(true);
    expect(BAG_OPCODES.has(0x10c)).toBe(true);
    expect(BAG_OPCODES.has(0x10d)).toBe(true);
    expect(BAG_OPCODES.has(0x10e)).toBe(true);
    expect(BAG_OPCODES.has(0x111)).toBe(true);
    expect(BAG_OPCODES.has(0x1b9)).toBe(true);
    expect(BAG_OPCODES.has(0x282)).toBe(true);
    expect(BAG_OPCODES.has(0x283)).toBe(true);
  });
});

describe("handleBags swap", () => {
  test("swaps two backpack slots", async () => {
    const inv = createInventory(0);
    const a = tpl({ entry: 1001, class: 15, subclass: 0 });
    const b = tpl({ entry: 1002, class: 15, subclass: 0 });
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, item(1, a));
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START + 1, item(2, b));

    const body = new ByteWriter()
      .writeU8(INVENTORY_SLOT_ITEM_START + 1)
      .writeU8(INVENTORY_SLOT_ITEM_START)
      .toUint8Array();
    const result = await handleBags(CMSG_SWAP_INV_ITEM, body, await ctx(inv));
    expect(result).not.toBeNull();
    expect(result!.packets.length).toBeGreaterThan(0);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)?.guid).toBe(2);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START + 1)?.guid).toBe(1);
  });

  test("rejects key into backpack", async () => {
    const inv = createInventory(0);
    storeItem(inv, 0, KEYRING_SLOT_START, item(1, key()));

    const body = new ByteWriter()
      .writeU8(INVENTORY_SLOT_ITEM_START)
      .writeU8(KEYRING_SLOT_START)
      .toUint8Array();
    const result = await handleBags(CMSG_SWAP_INV_ITEM, body, await ctx(inv));
    expect(result).not.toBeNull();
    expect(result!.packets.some((p) => p.opcode === 0x112)).toBe(true);
    expect(getItem(inv, 0, KEYRING_SLOT_START)?.guid).toBe(1);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)).toBeNull();
  });

  test("unequip mainhand clears the visible weapon", async () => {
    const inv = createInventory(0);
    const sword = tpl({ entry: 25, class: 2, subclass: 7, InventoryType: 13 });
    storeItem(inv, 0, 15, item(5, sword));
    const play = await ctx(inv);
    const body = new ByteWriter().writeU8(INVENTORY_SLOT_ITEM_START).writeU8(15).toUint8Array();
    const result = await handleBags(CMSG_SWAP_INV_ITEM, body, play);
    expect(getItem(inv, 0, 15)).toBeNull();
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)?.entry).toBe(25);
    const gear = visibleGearPacket(play.playerGuid, inv, null);
    expect(gear).not.toBeNull();
    expect(result!.packets.some((packet) => sameBytes(packet.body, gear!.body))).toBe(true);
  });
});

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

describe("handleBags bank slot buy", () => {
  test("buys first bank bag slot and returns money", async () => {
    const inv = createInventory(0);
    const play = await ctx(inv, { money: 5000 });
    const body = new ByteWriter().writeU64(0n).toUint8Array();
    const result = await handleBags(CMSG_BUY_BANK_SLOT, body, play);
    expect(result).not.toBeNull();
    expect(result!.money).toBe(4000);
    expect(play.money).toBe(4000);
    expect(inv.bankSlots).toBe(1);
    expect(result!.packets.some((p) => p.opcode === 0x1ba)).toBe(true);
  });

  test("rejects when funds are insufficient", async () => {
    const inv = createInventory(0);
    const play = await ctx(inv, { money: 500 });
    const result = await handleBags(CMSG_BUY_BANK_SLOT, new ByteWriter().writeU64(0n).toUint8Array(), play);
    expect(result!.money).toBeUndefined();
    expect(inv.bankSlots).toBe(0);
    expect(play.money).toBe(500);
  });
});

describe("handleBags split and destroy", () => {
  test("splits a stack into an empty backpack slot", async () => {
    const inv = createInventory(0);
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, item(1, junk(), 10));
    const body = new ByteWriter()
      .writeU8(255)
      .writeU8(INVENTORY_SLOT_ITEM_START)
      .writeU8(255)
      .writeU8(INVENTORY_SLOT_ITEM_START + 1)
      .writeU32(3)
      .toUint8Array();
    const play = await ctx(inv);
    // `SetHighestGuids` puts the item counter past every guid in `item_instance`.
    objectGuids.item.set(2);
    const result = await handleBags(CMSG_SPLIT_ITEM, body, play);
    expect(result).not.toBeNull();
    expect(result!.packets.length).toBeGreaterThan(0);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)?.count).toBe(7);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START + 1)?.count).toBe(3);
  });

  test("destroys an item in the backpack", async () => {
    const inv = createInventory(0);
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, item(1, junk()));
    const body = new ByteWriter()
      .writeU8(255)
      .writeU8(INVENTORY_SLOT_ITEM_START)
      .writeU8(0)
      .writeU8(0)
      .writeU8(0)
      .writeU8(0)
      .toUint8Array();
    const result = await handleBags(CMSG_DESTROYITEM, body, await ctx(inv));
    expect(result).not.toBeNull();
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)).toBeNull();
    expect(result!.packets.some((p) => p.opcode === 0x0aa || p.opcode === 0x0a9)).toBe(true);
  });
});

describe("loginItemPackets", () => {
  test("emits non-empty update when backpack slot 23 has an item", async () => {
    const inv = createInventory(0);
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, item(50, junk()));
    const packets = loginItemPackets(1, inv, null);
    expect(packets.length).toBeGreaterThan(0);
    expect(packets[0]!.opcode).toBe(0x0a9);
    expect(packets[0]!.body.length).toBeGreaterThan(8);
  });
});

describe("load/save play inventory", () => {
  test("round-trips character_inventory rows", async () => {
    const db = await memDb();
    const inv = createInventory(2);
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, item(50, junk(), 4));
    await db.insert(characters).values({ guid: 1, account: 1, name: "Bagtest", taximask: "", innTriggerId: 0 });
    await db.insert(item_instance).values({
      guid: 50,
      itemEntry: 1001,
      owner_guid: 1,
      count: 4,
      charges: emptyChargesString(),
      enchantments: emptyEnchantmentsString(),
    });
    await savePlayInventory(db, 1, inv);

    const loaded = await loadPlayInventory(db, 1);
    expect(loaded.bankSlots).toBe(2);
    expect(getItem(loaded, 0, INVENTORY_SLOT_ITEM_START)?.guid).toBe(50);
    expect(getItem(loaded, 0, INVENTORY_SLOT_ITEM_START)?.count).toBe(4);
    expect(getItem(loaded, 0, INVENTORY_SLOT_ITEM_START)?.entry).toBe(1001);
  });
});

describe("storeItem key rules", () => {
  test("store key in backpack fails", async () => {
    const inv = createInventory(0);
    const result = storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, item(1, key()));
    expect(result.ok).toBe(false);
    expect(result.error).toBe(EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG);
  });
});
