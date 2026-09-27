import { expect, test } from "bun:test";
import { ByteReader } from "../net/byte-buffer.ts";
import {
  canEquip,
  equip,
  EQUIP_ERR_ITEM_CANT_BE_EQUIPPED,
  EQUIP_ERR_OK,
  EQUIPMENT_SLOT_HEAD,
  EQUIPMENT_SLOT_MAINHAND,
  EQUIPMENT_SLOT_OFFHAND,
  INVENTORY_SLOT_BAG_0,
  INVTYPE_2HWEAPON,
  INVTYPE_CHEST,
  INVTYPE_HEAD,
  INVTYPE_SHIELD,
  INVTYPE_WEAPON,
  PLAYER_VISIBLE_ITEM_1_ENTRYID,
  UNIT_VIRTUAL_ITEM_SLOT_ID,
  visibleItemFields,
  writeVisibleItemsUpdate,
  type EquipInventoryItem,
} from "./equip.ts";

test("equip head into slot 0", () => {
  const inventory: EquipInventoryItem[] = [
    { bag: INVENTORY_SLOT_BAG_0, slot: 23, itemGuid: 100, itemEntry: 25, inventoryType: INVTYPE_HEAD },
  ];
  const check = canEquip(inventory, 100);
  expect(check.ok).toBe(true);
  if (!check.ok) {
    return;
  }
  expect(check.destSlot).toBe(EQUIPMENT_SLOT_HEAD);

  const result = equip(inventory, 100);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.destSlot).toBe(EQUIPMENT_SLOT_HEAD);
  expect(result.moves).toEqual([
    {
      itemGuid: 100,
      itemEntry: 25,
      inventoryType: INVTYPE_HEAD,
      fromBag: INVENTORY_SLOT_BAG_0,
      fromSlot: 23,
      toBag: INVENTORY_SLOT_BAG_0,
      toSlot: EQUIPMENT_SLOT_HEAD,
    },
  ]);
  expect(result.inventory.find((row) => row.itemGuid === 100)).toEqual({
    bag: INVENTORY_SLOT_BAG_0,
    slot: EQUIPMENT_SLOT_HEAD,
    itemGuid: 100,
    itemEntry: 25,
    inventoryType: INVTYPE_HEAD,
  });
});

test("reject chest item into head slot", () => {
  const inventory: EquipInventoryItem[] = [
    { bag: INVENTORY_SLOT_BAG_0, slot: 23, itemGuid: 200, itemEntry: 38, inventoryType: INVTYPE_CHEST },
  ];
  const check = canEquip(inventory, 200, EQUIPMENT_SLOT_HEAD);
  expect(check.ok).toBe(false);
  if (check.ok) {
    return;
  }
  expect(check.error).toBe(EQUIP_ERR_ITEM_CANT_BE_EQUIPPED);
  expect(check.error).not.toBe(EQUIP_ERR_OK);

  const result = equip(inventory, 200, EQUIPMENT_SLOT_HEAD);
  expect(result.ok).toBe(false);
});

test("reject wrong class via AllowableClass", () => {
  const inventory: EquipInventoryItem[] = [
    {
      bag: INVENTORY_SLOT_BAG_0,
      slot: 23,
      itemGuid: 201,
      itemEntry: 38,
      inventoryType: INVTYPE_CHEST,
      allowableClass: 1 << (1 - 1), // warrior only
    },
  ];
  const check = canEquip(inventory, 201, undefined, { classId: 8, level: 10 });
  expect(check.ok).toBe(false);
  if (check.ok) {
    return;
  }
  expect(check.error).toBe(10); // EQUIP_ERR_YOU_CAN_NEVER_USE_THAT_ITEM
});

test("two-hand clears offhand in returned moves", () => {
  const inventory: EquipInventoryItem[] = [
    {
      bag: INVENTORY_SLOT_BAG_0,
      slot: EQUIPMENT_SLOT_MAINHAND,
      itemGuid: 1,
      itemEntry: 25,
      inventoryType: INVTYPE_WEAPON,
    },
    {
      bag: INVENTORY_SLOT_BAG_0,
      slot: EQUIPMENT_SLOT_OFFHAND,
      itemGuid: 2,
      itemEntry: 2362,
      inventoryType: INVTYPE_SHIELD,
    },
    {
      bag: INVENTORY_SLOT_BAG_0,
      slot: 23,
      itemGuid: 3,
      itemEntry: 2011,
      inventoryType: INVTYPE_2HWEAPON,
    },
  ];

  const result = equip(inventory, 3);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.destSlot).toBe(EQUIPMENT_SLOT_MAINHAND);

  const offhandMove = result.moves.find((move) => move.itemGuid === 2);
  expect(offhandMove).toBeDefined();
  expect(offhandMove!.fromSlot).toBe(EQUIPMENT_SLOT_OFFHAND);
  expect(offhandMove!.toBag).toBe(INVENTORY_SLOT_BAG_0);
  expect(offhandMove!.toSlot).toBeGreaterThanOrEqual(23);
  expect(offhandMove!.toSlot).toBeLessThan(39);

  const twoHandMove = result.moves.find((move) => move.itemGuid === 3);
  expect(twoHandMove?.toSlot).toBe(EQUIPMENT_SLOT_MAINHAND);

  expect(result.inventory.find((row) => row.itemGuid === 2)?.slot).toBe(offhandMove!.toSlot);
  expect(result.inventory.find((row) => row.slot === EQUIPMENT_SLOT_OFFHAND)).toBeUndefined();
});

test("visible fields contain the item entry for equipped gear", () => {
  const equipped: EquipInventoryItem[] = [
    {
      bag: INVENTORY_SLOT_BAG_0,
      slot: EQUIPMENT_SLOT_HEAD,
      itemGuid: 100,
      itemEntry: 25,
      inventoryType: INVTYPE_HEAD,
    },
    {
      bag: INVENTORY_SLOT_BAG_0,
      slot: EQUIPMENT_SLOT_MAINHAND,
      itemGuid: 101,
      itemEntry: 2011,
      inventoryType: INVTYPE_2HWEAPON,
      permanentEnchantment: 0x1234,
    },
  ];

  const fields = visibleItemFields(equipped);
  const headEntry = fields.find((field) => field.index === PLAYER_VISIBLE_ITEM_1_ENTRYID);
  expect(headEntry?.value).toBe(25);

  const mainEntryIndex = PLAYER_VISIBLE_ITEM_1_ENTRYID + EQUIPMENT_SLOT_MAINHAND * 2;
  const mainEnchantIndex = PLAYER_VISIBLE_ITEM_1_ENTRYID + EQUIPMENT_SLOT_MAINHAND * 2 + 1;
  expect(fields.find((field) => field.index === mainEntryIndex)?.value).toBe(2011);
  expect(fields.find((field) => field.index === mainEnchantIndex)?.value).toBe(0x1234);

  expect(fields.find((field) => field.index === UNIT_VIRTUAL_ITEM_SLOT_ID)?.value).toBe(2011);
  expect(fields.find((field) => field.index === UNIT_VIRTUAL_ITEM_SLOT_ID + 1)?.value).toBe(0);

  const block = writeVisibleItemsUpdate(42, fields);
  expect(updateField(block, PLAYER_VISIBLE_ITEM_1_ENTRYID)).toBe(25);
  expect(updateField(block, mainEntryIndex)).toBe(2011);
  expect(updateField(block, UNIT_VIRTUAL_ITEM_SLOT_ID)).toBe(2011);
});

test("PLAYER_VISIBLE_ITEM_1_ENTRYID matches UpdateFields.h absolute index", () => {
  // OBJECT_END=6, UNIT_END=0x94, +0x87 → 0x11B = 283
  expect(PLAYER_VISIBLE_ITEM_1_ENTRYID).toBe(283);
  expect(UNIT_VIRTUAL_ITEM_SLOT_ID).toBe(0x38);
});

/** Parse a values-update SMSG_UPDATE_OBJECT body like update-object.test.ts */
function updateField(block: Uint8Array, index: number): number | undefined {
  const reader = new ByteReader(block);
  expect(reader.readU32()).toBe(1);
  expect(reader.readU8()).toBe(0); // UPDATETYPE_VALUES
  const mask = reader.readU8();
  let guidBytes = 0;
  for (let bit = 0; bit < 8; bit++) {
    if (mask & (1 << bit)) {
      guidBytes++;
    }
  }
  reader.readBytes(guidBytes);
  const blockCount = reader.readU8();
  const present: number[] = [];
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    const bits = reader.readU32();
    for (let bit = 0; bit < 32; bit++) {
      if (bits & (1 << bit)) {
        present.push(blockIndex * 32 + bit);
      }
    }
  }
  const values = new Map<number, number>();
  for (const fieldIndex of present) {
    values.set(fieldIndex, reader.readU32());
  }
  return values.get(index);
}
