import { testDatabase } from "../database/test-db.ts";
import { item_instance } from "../database/schema/characters.ts";
import { worldFromSql } from "../database/test-world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { describe, expect, test } from "bun:test";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import {
  canEquip,
  canUseItemTemplate,
  equip,
  EQUIP_ERR_YOU_CAN_NEVER_USE_THAT_ITEM,
  EQUIPMENT_SLOT_CHEST,
  EQUIPMENT_SLOT_HEAD,
  INVENTORY_SLOT_BAG_0,
  INVTYPE_CHEST,
  INVTYPE_HEAD,
  type EquipInventoryItem,
} from "../items/equip.ts";
import {
  createInventory,
  EQUIPMENT_SLOT_CHEST as BAG_CHEST,
  getItem,
  INVENTORY_SLOT_BAG_0 as BAG_0,
  INVENTORY_SLOT_ITEM_START,
  type InventoryItem,
  type ItemTemplateSlice,
} from "../items/bags.ts";
import {
  CMSG_AUTOEQUIP_ITEM,
  CMSG_AUTOEQUIP_ITEM_SLOT,
  EQUIP_OPCODES,
  handleEquip,
  PLAYER_FIELD_INV_SLOT_HEAD,
  PLAYER_FIELD_PACK_SLOT_1,
  PLAYER_VISIBLE_ITEM_1_ENTRYID,
  SMSG_UPDATE_OBJECT,
  visibleGearPacket,
  type EquipPlayCtx,
} from "./equip-play.ts";

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

function place(inv: ReturnType<typeof createInventory>, bag: number, slot: number, item: InventoryItem): void {
  let map = inv.slots.get(bag);
  if (!map) {
    map = new Map();
    inv.slots.set(bag, map);
  }
  map.set(slot, item);
  inv.byGuid.set(item.guid, { bag, slot });
}

async function openDb() {
  return { db: await testDatabase("characters"), world: WorldTables.fromRows() };
}

function ctx(partial: Partial<EquipPlayCtx> & Pick<EquipPlayCtx, "inventory" | "db">): EquipPlayCtx {
  return {
    world: partial.world ?? null,
    playerGuid: partial.playerGuid ?? 1,
    race: partial.race ?? 1,
    classId: partial.classId ?? 1,
    level: partial.level ?? 10,
    ...partial,
  };
}

function autoEquipPayload(srcBag: number, srcSlot: number): Uint8Array {
  return new ByteWriter().writeU8(srcBag).writeU8(srcSlot).toUint8Array();
}

/** Parse a values-update SMSG_UPDATE_OBJECT body. */
function updateFields(block: Uint8Array): Map<number, number> {
  const reader = new ByteReader(block);
  expect(reader.readU32()).toBe(1);
  expect(reader.readU8()).toBe(0);
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
  return values;
}

describe("equip.ts class checks", () => {
  test("wrong class rejected by canUseItemTemplate / canEquip", () => {
    const inventory: EquipInventoryItem[] = [
      {
        bag: INVENTORY_SLOT_BAG_0,
        slot: 23,
        itemGuid: 50,
        itemEntry: 999,
        inventoryType: INVTYPE_CHEST,
        // warrior only (class 1 → bit 0)
        allowableClass: 1 << (1 - 1),
      },
    ];
    expect(canUseItemTemplate(inventory[0]!, { classId: 8 })).toBe(EQUIP_ERR_YOU_CAN_NEVER_USE_THAT_ITEM);
    const check = canEquip(inventory, 50, undefined, { classId: 8, level: 10 });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.error).toBe(EQUIP_ERR_YOU_CAN_NEVER_USE_THAT_ITEM);
    }
    expect(equip(inventory, 50, undefined, { classId: 8 }).ok).toBe(false);
  });
});

describe("equip-play", () => {
  test("EQUIP_OPCODES covers autoequip opcodes", () => {
    expect(EQUIP_OPCODES.has(CMSG_AUTOEQUIP_ITEM)).toBe(true);
    expect(EQUIP_OPCODES.has(CMSG_AUTOEQUIP_ITEM_SLOT)).toBe(true);
    expect(CMSG_AUTOEQUIP_ITEM).toBe(0x10a);
    expect(CMSG_AUTOEQUIP_ITEM_SLOT).toBe(0x10f);
  });

  test("equip chest from backpack slot 23 into slot 4", async () => {
    const { db, world } = await openDb();
    worldFromSql(`INSERT INTO item_template (entry, displayid, InventoryType, AllowableClass, class)
       VALUES (38, 9900, 5, -1, 4)`, world);
    await db.insert(item_instance).values({ guid: 100, itemEntry: 38, owner_guid: 1, enchantments: "" });

    const inv = createInventory();
    const chest = {
      guid: 100,
      entry: 38,
      count: 1,
      template: tpl({ entry: 38, InventoryType: INVTYPE_CHEST, class: 4, subclass: 1 }),
    };
    place(inv, 0, INVENTORY_SLOT_ITEM_START, chest);

    const result = await handleEquip(CMSG_AUTOEQUIP_ITEM, autoEquipPayload(BAG_0, INVENTORY_SLOT_ITEM_START), ctx({
      db,
      world,
      inventory: inv,
      classId: 1,
      level: 10,
    }));

    expect(result).not.toBeNull();
    expect(getItem(inv, 0, BAG_CHEST)?.guid).toBe(100);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)).toBeNull();

    const packets = result!.packets;
    expect(packets.some((p) => p.opcode === SMSG_UPDATE_OBJECT)).toBe(true);

    const merged = new Map<number, number>();
    for (const p of packets) {
      if (p.opcode === SMSG_UPDATE_OBJECT) {
        for (const [index, value] of updateFields(p.body)) {
          merged.set(index, value);
        }
      }
    }

    const chestEntryIndex = PLAYER_VISIBLE_ITEM_1_ENTRYID + EQUIPMENT_SLOT_CHEST * 2;
    expect(merged.get(chestEntryIndex)).toBe(38);

    const equipGuidLow = PLAYER_FIELD_INV_SLOT_HEAD + BAG_CHEST * 2;
    expect(merged.get(equipGuidLow)).toBe(100);
    const packGuidLow = PLAYER_FIELD_PACK_SLOT_1 + 0;
    expect(merged.get(packGuidLow)).toBe(0);
  });

  test("wrong class rejected with SMSG_INVENTORY_CHANGE_FAILURE", async () => {
    const { db, world } = await openDb();
    // Mage only (class 8 → bit 7)
    const mageOnly = 1 << (8 - 1);
    worldFromSql(`INSERT INTO item_template (entry, displayid, InventoryType, AllowableClass, class)
       VALUES (50, 1, 5, ${mageOnly}, 4)`, world);

    const inv = createInventory();
    place(inv, 0, INVENTORY_SLOT_ITEM_START, {
      guid: 200,
      entry: 50,
      count: 1,
      template: tpl({ entry: 50, InventoryType: INVTYPE_CHEST, class: 4 }),
    });

    const result = await handleEquip(CMSG_AUTOEQUIP_ITEM, autoEquipPayload(BAG_0, INVENTORY_SLOT_ITEM_START), ctx({
      db,
      world,
      inventory: inv,
      classId: 1, // warrior
      level: 20,
    }));

    expect(result).not.toBeNull();
    expect(result!.packets).toHaveLength(1);
    expect(result!.packets[0]!.opcode).toBe(0x112);
    expect(result!.packets[0]!.body[0]).toBe(EQUIP_ERR_YOU_CAN_NEVER_USE_THAT_ITEM);
    expect(getItem(inv, 0, INVENTORY_SLOT_ITEM_START)?.guid).toBe(200);
    expect(getItem(inv, 0, BAG_CHEST)).toBeNull();
  });

  test("visibleGearPacket contains the item entry", async () => {
    const { db, world } = await openDb();
    const inv = createInventory();
    place(inv, 0, EQUIPMENT_SLOT_HEAD, {
      guid: 7,
      entry: 25,
      count: 1,
      template: tpl({ entry: 25, InventoryType: INVTYPE_HEAD }),
    });

    const packet = visibleGearPacket(42, inv, world);
    expect(packet).not.toBeNull();
    expect(packet!.opcode).toBe(SMSG_UPDATE_OBJECT);
    const fields = updateFields(packet!.body);
    expect(fields.get(PLAYER_VISIBLE_ITEM_1_ENTRYID)).toBe(25);
  });

  test("CMSG_AUTOEQUIP_ITEM_SLOT equips into the requested slot", async () => {
    const { db, world } = await openDb();
    worldFromSql(`INSERT INTO item_template (entry, displayid, InventoryType, AllowableClass)
       VALUES (38, 1, 5, -1)`, world);

    const inv = createInventory();
    place(inv, 0, INVENTORY_SLOT_ITEM_START, {
      guid: 300,
      entry: 38,
      count: 1,
      template: tpl({ entry: 38, InventoryType: INVTYPE_CHEST }),
    });

    const payload = new ByteWriter()
      .writeU64(300n | (0x4000n << 48n))
      .writeU8(EQUIPMENT_SLOT_CHEST)
      .toUint8Array();

    const result = await handleEquip(CMSG_AUTOEQUIP_ITEM_SLOT, payload, ctx({ db, world, inventory: inv }));
    expect(result).not.toBeNull();
    expect(getItem(inv, 0, EQUIPMENT_SLOT_CHEST)?.guid).toBe(300);
  });

  test("unknown opcode returns null", async () => {
    const { db, world } = await openDb();
    expect(await handleEquip(0x1, new Uint8Array(), ctx({ db, world, inventory: createInventory() }))).toBeNull();
  });
});
