import { testDatabase } from "../database/test-db.ts";
import { describe, expect, test } from "bun:test";
import { ByteReader } from "../net/byte-buffer.ts";
import {
  applyInventoryRows,
  autoBankItem,
  autoStoreItem,
  BAG_FAMILY_MASK_HERBS,
  BAG_FAMILY_MASK_KEYS,
  BANK_SLOT_BAG_START,
  BANK_SLOT_ITEM_START,
  buildInventoryChangeFailure,
  buyBankSlot,
  createInventory,
  destroyItem,
  EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG,
  EQUIP_ERR_ITEM_DOESNT_GO_TO_SLOT,
  EQUIP_ERR_MUST_PURCHASE_THAT_BAG_SLOT,
  EQUIP_ERR_OK,
  ERR_BANKSLOT_OK,
  getItem,
  INVENTORY_SLOT_BAG_START,
  INVENTORY_SLOT_ITEM_START,
  INVTYPE_BAG,
  ITEM_CLASS_ARMOR,
  ITEM_CLASS_CONTAINER,
  ITEM_CLASS_KEY,
  ITEM_SUBCLASS_CONTAINER,
  ITEM_SUBCLASS_HERB_CONTAINER,
  KEYRING_SLOT_START,
  loadInventory,
  saveInventoryRows,
  splitItem,
  storeItem,
  swapInvItem,
  swapItem,
  type InventoryItem,
  type ItemTemplateSlice,
  canStoreNewItem,
  EQUIP_ERR_CANT_CARRY_MORE_OF_THIS,
  EQUIP_ERR_INVENTORY_FULL,
  INVENTORY_SLOT_BAG_0,
  INVENTORY_SLOT_ITEM_END,
  EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED,
  NULL_BAG,
  NULL_SLOT,
} from "./bags.ts";

function tpl(partial: Partial<ItemTemplateSlice> & Pick<ItemTemplateSlice, "entry">): ItemTemplateSlice {
  return {
    InventoryType: 0,
    ContainerSlots: 0,
    BagFamily: 0,
    class: 0,
    subclass: 0,
    bonding: 0,
    ...partial,
  };
}

function item(
  guid: number,
  template: ItemTemplateSlice,
  count = 1,
): InventoryItem {
  return { guid, entry: template.entry, count, template };
}

/** Full item_template column list from sql/base/db_world/item_template.sql (for query tests). */

const junk = () => tpl({ entry: 1001, class: 15, subclass: 0 });
const armor = () =>
  tpl({ entry: 1002, class: ITEM_CLASS_ARMOR, subclass: 1, InventoryType: 4 });
const key = () =>
  tpl({
    entry: 1003,
    class: ITEM_CLASS_KEY,
    subclass: 0,
    BagFamily: BAG_FAMILY_MASK_KEYS,
  });
const herb = () =>
  tpl({ entry: 1004, class: 7, subclass: 9, BagFamily: BAG_FAMILY_MASK_HERBS });
const genericBag = () =>
  tpl({
    entry: 2001,
    class: ITEM_CLASS_CONTAINER,
    subclass: ITEM_SUBCLASS_CONTAINER,
    InventoryType: INVTYPE_BAG,
    ContainerSlots: 4,
  });
const herbBag = () =>
  tpl({
    entry: 2002,
    class: ITEM_CLASS_CONTAINER,
    subclass: ITEM_SUBCLASS_HERB_CONTAINER,
    InventoryType: INVTYPE_BAG,
    ContainerSlots: 4,
    BagFamily: BAG_FAMILY_MASK_HERBS,
  });

describe("character_inventory", () => {
  test("saveInventoryRows replaces a character's rows and loadInventory reads them in bag, slot order", async () => {
    const db = await testDatabase("characters");
    await saveInventoryRows(db, 1, [
      { guid: 1, bag: 0, slot: INVENTORY_SLOT_ITEM_START + 1, item: 51 },
      { guid: 1, bag: 0, slot: INVENTORY_SLOT_ITEM_START, item: 50 },
    ]);
    await saveInventoryRows(db, 2, [{ guid: 2, bag: 0, slot: INVENTORY_SLOT_ITEM_START, item: 60 }]);
    expect(await loadInventory(db, 1)).toEqual([
      { guid: 1, bag: 0, slot: INVENTORY_SLOT_ITEM_START, item: 50 },
      { guid: 1, bag: 0, slot: INVENTORY_SLOT_ITEM_START + 1, item: 51 },
    ]);
    await saveInventoryRows(db, 1, []);
    expect(await loadInventory(db, 1)).toEqual([]);
    expect(await loadInventory(db, 2)).toHaveLength(1);
  });
});

describe("auto-store backpack", () => {
  test("empty backpack stores into first backpack slot", () => {
    const inv = createInventory(0);
    const result = autoStoreItem(inv, item(1, junk()));
    expect(result.ok).toBe(true);
    expect(result.error).toBe(EQUIP_ERR_OK);
    expect(result.changes).toEqual([
      { bag: 0, slot: INVENTORY_SLOT_ITEM_START, itemGuid: 1 },
    ]);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)?.guid).toBe(1);
  });
});

describe("bag family", () => {
  test("herb bag rejects armor", () => {
    const inv = createInventory(0);
    const bag = item(10, herbBag());
    expect(storeItem(inv, 0, INVENTORY_SLOT_BAG_START, bag).ok).toBe(true);

    const result = storeItem(inv, bag.guid, 0, item(11, armor()));
    expect(result.ok).toBe(false);
    expect(result.error).toBe(EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG);
  });

  test("herb bag accepts herb", () => {
    const inv = createInventory(0);
    const bag = item(10, herbBag());
    storeItem(inv, 0, INVENTORY_SLOT_BAG_START, bag);
    const result = storeItem(inv, bag.guid, 0, item(11, herb()));
    expect(result.ok).toBe(true);
    expect(getItem(inv, bag.guid, 0)?.entry).toBe(herb().entry);
  });

  test("generic bag accepts armor", () => {
    const inv = createInventory(0);
    const bag = item(10, genericBag());
    storeItem(inv, 0, INVENTORY_SLOT_BAG_START, bag);
    expect(storeItem(inv, bag.guid, 0, item(11, armor())).ok).toBe(true);
  });
});

describe("bank slots", () => {
  test("locked bank bag slot rejects store", () => {
    const inv = createInventory(0); // no purchased bank bags
    const result = storeItem(inv, 0, BANK_SLOT_BAG_START, item(1, genericBag()));
    expect(result.ok).toBe(false);
    expect(result.error).toBe(EQUIP_ERR_MUST_PURCHASE_THAT_BAG_SLOT);
  });

  test("unlocked bank bag slot accepts bag", () => {
    const inv = createInventory(1);
    const result = storeItem(inv, 0, BANK_SLOT_BAG_START, item(1, genericBag()));
    expect(result.ok).toBe(true);
  });

  test("bank main slots work without purchased bags", () => {
    const inv = createInventory(0);
    const result = autoBankItem(inv, 0, INVENTORY_SLOT_ITEM_START);
    // nothing at source
    expect(result.ok).toBe(false);

    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, item(5, junk()));
    const banked = autoBankItem(inv, 0, INVENTORY_SLOT_ITEM_START);
    expect(banked.ok).toBe(true);
    expect(getItem(inv, 0, BANK_SLOT_ITEM_START)?.guid).toBe(5);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)).toBeNull();
  });
});

describe("keyring", () => {
  test("accepts a key", () => {
    const inv = createInventory(0);
    const result = storeItem(inv, 0, KEYRING_SLOT_START, item(1, key()));
    expect(result.ok).toBe(true);
    expect(getItem(inv, 0, KEYRING_SLOT_START)?.template.class).toBe(ITEM_CLASS_KEY);
  });

  test("rejects armor", () => {
    const inv = createInventory(0);
    const result = storeItem(inv, 0, KEYRING_SLOT_START, item(1, armor()));
    expect(result.ok).toBe(false);
    expect(result.error).toBe(EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG);
  });

  test("autoStore prefers keyring for keys", () => {
    const inv = createInventory(0);
    const result = autoStoreItem(inv, item(1, key()));
    expect(result.ok).toBe(true);
    expect(result.changes[0]?.slot).toBe(KEYRING_SLOT_START);
  });
});

describe("swap and split", () => {
  test("swap two backpack slots", () => {
    const inv = createInventory(0);
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, item(1, junk()));
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START + 1, item(2, armor()));

    const result = swapInvItem(inv, INVENTORY_SLOT_ITEM_START, INVENTORY_SLOT_ITEM_START + 1);
    expect(result.ok).toBe(true);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)?.guid).toBe(2);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START + 1)?.guid).toBe(1);
  });

  test("swap into empty slot", () => {
    const inv = createInventory(0);
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, item(1, junk()));
    const result = swapItem(
      inv,
      0,
      INVENTORY_SLOT_ITEM_START,
      0,
      INVENTORY_SLOT_ITEM_START + 2,
    );
    expect(result.ok).toBe(true);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)).toBeNull();
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START + 2)?.guid).toBe(1);
  });

  test("split count into empty slot", () => {
    const inv = createInventory(0);
    const stack = item(1, junk(), 10);
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, stack);

    const result = splitItem(
      inv,
      0,
      INVENTORY_SLOT_ITEM_START,
      0,
      INVENTORY_SLOT_ITEM_START + 1,
      3,
      99,
    );
    expect(result.ok).toBe(true);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)?.count).toBe(7);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START + 1)?.count).toBe(3);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START + 1)?.guid).toBe(99);
  });

  test("reject store into occupied destination", () => {
    const inv = createInventory(0);
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, item(1, junk()));
    const result = storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, item(2, armor()));
    expect(result.ok).toBe(false);
    expect(result.error).toBe(EQUIP_ERR_ITEM_DOESNT_GO_TO_SLOT);
  });

  test("stack merge on swap when same entry", () => {
    const inv = createInventory(0);
    const stackTpl = tpl({ entry: 1001, class: 15, subclass: 0, stackable: 20 });
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, item(1, stackTpl, 5));
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START + 1, item(2, stackTpl, 7));
    const result = swapInvItem(inv, INVENTORY_SLOT_ITEM_START, INVENTORY_SLOT_ITEM_START + 1);
    expect(result.ok).toBe(true);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)).toBeNull();
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START + 1)?.count).toBe(12);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START + 1)?.guid).toBe(2);
  });
});

describe("destroyItem", () => {
  test("clears backpack slot", () => {
    const inv = createInventory(0);
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, item(1, junk()));
    const result = destroyItem(inv, 0, INVENTORY_SLOT_ITEM_START, 0);
    expect(result.ok).toBe(true);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)).toBeNull();
  });

  test("partial destroy reduces count", () => {
    const inv = createInventory(0);
    storeItem(inv, 0, INVENTORY_SLOT_ITEM_START, item(1, junk(), 10));
    const result = destroyItem(inv, 0, INVENTORY_SLOT_ITEM_START, 3);
    expect(result.ok).toBe(true);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)?.count).toBe(7);
  });
});

describe("buyBankSlot", () => {
  test("first slot costs 1000 copper", () => {
    const inv = createInventory(0);
    const bought = buyBankSlot(inv, 5000);
    expect(bought.result).toBe(ERR_BANKSLOT_OK);
    expect(bought.money).toBe(4000);
    expect(inv.bankSlots).toBe(1);
  });
});

describe("SMSG_INVENTORY_CHANGE_FAILURE", () => {
  test("matches SendEquipError layout", () => {
    const payload = buildInventoryChangeFailure(
      EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG,
      42n,
      0n,
      0,
    );
    const r = new ByteReader(payload);
    expect(r.readU8()).toBe(EQUIP_ERR_ITEM_DOESNT_GO_INTO_BAG);
    expect(r.readU64()).toBe(42n);
    expect(r.readU64()).toBe(0n);
    expect(r.readU8()).toBe(0);
  });
});

describe("applyInventoryRows", () => {
  test("loads bag=0 before bag contents", () => {
    const inv = createInventory(0);
    const bagTpl = genericBag();
    const junkTpl = junk();
    const items = new Map<number, InventoryItem>([
      [10, item(10, bagTpl)],
      [11, item(11, junkTpl)],
    ]);
    applyInventoryRows(
      inv,
      [
        { guid: 1, bag: 10, slot: 0, item: 11 },
        { guid: 1, bag: 0, slot: INVENTORY_SLOT_BAG_START, item: 10 },
      ],
      items,
    );
    expect(getItem(inv, 0, INVENTORY_SLOT_BAG_START)?.guid).toBe(10);
    expect(getItem(inv, 10, 0)?.guid).toBe(11);
  });
});

describe("canStoreNewItem (Player::CanStoreItem)", () => {
  const cloth = () => tpl({ entry: 1005, class: 7, subclass: 5, stackable: 20 });
  const noLimit = () => null;

  test("fills partial stacks first, then the first free backpack slot", () => {
    const inv = createInventory(0);
    storeItem(inv, 0, 30, item(10, cloth(), 15));
    storeItem(inv, 0, 25, item(11, cloth(), 20));
    const result = canStoreNewItem(inv, NULL_BAG, NULL_SLOT, cloth(), 12, noLimit);
    expect(result.result).toBe(EQUIP_ERR_OK);
    expect(result.dest).toEqual([
      { bag: INVENTORY_SLOT_BAG_0, slot: 30, count: 5 },
      { bag: INVENTORY_SLOT_BAG_0, slot: INVENTORY_SLOT_ITEM_START, count: 7 },
    ]);
  });

  test("a specialized bag takes its family before the backpack", () => {
    const inv = createInventory(0);
    const bag = item(10, herbBag());
    storeItem(inv, 0, INVENTORY_SLOT_BAG_START, bag);
    const result = canStoreNewItem(inv, NULL_BAG, NULL_SLOT, herb(), 1, noLimit);
    expect(result.dest).toEqual([{ bag: INVENTORY_SLOT_BAG_START, slot: 0, count: 1 }]);
  });

  test("full bags are EQUIP_ERR_INVENTORY_FULL with the count that did not fit", () => {
    const inv = createInventory(0);
    for (let slot = INVENTORY_SLOT_ITEM_START; slot < INVENTORY_SLOT_ITEM_END; slot++) {
      storeItem(inv, 0, slot, item(100 + slot, junk()));
    }
    const result = canStoreNewItem(inv, NULL_BAG, NULL_SLOT, cloth(), 3, noLimit);
    expect(result.result).toBe(EQUIP_ERR_INVENTORY_FULL);
    expect(result.noSpaceCount).toBe(3);
  });

  test("item_template.maxcount and ItemLimitCategory cap what can be carried", () => {
    const inv = createInventory(0);
    const unique = tpl({ entry: 1006, maxcount: 1, stackable: 1 });
    storeItem(inv, 0, 30, item(10, unique));
    expect(canStoreNewItem(inv, NULL_BAG, NULL_SLOT, unique, 1, noLimit).result).toBe(EQUIP_ERR_CANT_CARRY_MORE_OF_THIS);
    const limited = tpl({ entry: 1007, ItemLimitCategory: 4, stackable: 20 });
    storeItem(inv, 0, 31, item(11, limited, 2));
    const limit = (id: number) => (id === 4 ? { maxCount: 2, mode: 0 } : null);
    expect(canStoreNewItem(inv, NULL_BAG, NULL_SLOT, limited, 1, limit).result).toBe(EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED);
  });
});
