/**
 * Session-ready bag / bank / keyring packet handlers.
 * Parent wires these from session.ts (this module does not import session).
 */

import { eq, inArray } from "drizzle-orm";
import type { Db } from "../database/database.ts";
import { characters, item_instance } from "../database/schema/characters.ts";
import { item_template } from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { objectGuids } from "../game/globals/object-guids.ts";
import {
  applyInventoryRows,
  autoBankItem,
  autoStoreBankItem,
  autoStoreBagItem,
  buildBuyBankSlotResult,
  buildInventoryChangeFailure,
  buyBankSlot,
  CMSG_AUTOBANK_ITEM,
  CMSG_AUTOSTORE_BAG_ITEM,
  CMSG_AUTOSTORE_BANK_ITEM,
  CMSG_BUY_BANK_SLOT,
  CMSG_DESTROYITEM,
  CMSG_SPLIT_ITEM,
  CMSG_SWAP_INV_ITEM,
  CMSG_SWAP_ITEM,
  createInventory,
  destroyItem,
  EQUIP_ERR_ITEM_DOESNT_GO_TO_SLOT,
  EQUIP_ERR_ITEM_NOT_FOUND,
  EQUIPMENT_SLOT_END,
  getItem,
  inventoryToRows,
  isBagItem,
  loadInventory,
  resolveStorageBag,
  saveInventoryRows,
  SMSG_BUY_BANK_SLOT_RESULT,
  SMSG_INVENTORY_CHANGE_FAILURE,
  splitItem,
  swapInvItem,
  swapItem,
  type Inventory,
  type InventoryItem,
  type InventoryOpResult,
  type ItemTemplateSlice,
} from "../items/bags.ts";
import {
  emptyChargesString,
  emptyEnchantmentsString,
  ITEM_END,
  ITEM_FIELD_CONTAINED,
  ITEM_FIELD_OWNER,
  ITEM_FIELD_STACK_COUNT,
  itemFieldValues,
  OBJECT_END,
  OBJECT_FIELD_ENTRY,
  type ItemInstance,
} from "../items/instance.ts";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import { visibleGearPacket } from "./equip-play.ts";
import {
  fieldUpdateBlock,
  packedGuid,
  PLAYER_END,
  PLAYER_FIELD_COINAGE,
} from "./update-object.ts";

export type PlayPacket = { opcode: number; name: string; body: Uint8Array };
export type BagPlayResult = { packets: PlayPacket[]; money?: number } | null;

export type BagPlayCtx = {
  db: Db;
  world: WorldTables | null;
  playerGuid: number;
  money: number;
  inventory: Inventory;
};

const SMSG_UPDATE_OBJECT = 0x0a9;
const SMSG_DESTROY_OBJECT = 0x0aa;

const OBJECT_FIELD_GUID = 0x0000;
const OBJECT_FIELD_TYPE = 0x0002;
const OBJECT_FIELD_SCALE_X = 0x0004;

const TYPEMASK_OBJECT = 0x0001;
const TYPEMASK_ITEM = 0x0002;
const TYPEMASK_CONTAINER = 0x0006;
const TYPEID_ITEM = 1;
const TYPEID_CONTAINER = 2;
const UPDATETYPE_VALUES = 0;
const UPDATETYPE_CREATE_OBJECT = 2;
const UPDATEFLAG_LOWGUID = 0x0010;

const HIGHGUID_ITEM = 0x4000n;

/** PLAYER_FIELD_INV_SLOT_HEAD = UNIT_END + 0x00B0; contiguous through currency tokens. */
const UNIT_END = OBJECT_END + 0x008e;
const PLAYER_FIELD_INV_SLOT_HEAD = UNIT_END + 0x00b0;

const CONTAINER_FIELD_NUM_SLOTS = ITEM_END + 0x0000;
const CONTAINER_FIELD_SLOT_1 = ITEM_END + 0x0002;
const CONTAINER_END = ITEM_END + 0x004a;

export const BAG_OPCODES: ReadonlySet<number> = new Set([
  CMSG_AUTOSTORE_BAG_ITEM,
  CMSG_SWAP_ITEM,
  CMSG_SWAP_INV_ITEM,
  CMSG_SPLIT_ITEM,
  CMSG_DESTROYITEM,
  CMSG_BUY_BANK_SLOT,
  CMSG_AUTOSTORE_BANK_ITEM,
  CMSG_AUTOBANK_ITEM,
]);

type BagOpcode =
  | typeof CMSG_AUTOSTORE_BAG_ITEM
  | typeof CMSG_SWAP_ITEM
  | typeof CMSG_SWAP_INV_ITEM
  | typeof CMSG_SPLIT_ITEM
  | typeof CMSG_DESTROYITEM
  | typeof CMSG_BUY_BANK_SLOT
  | typeof CMSG_AUTOSTORE_BANK_ITEM
  | typeof CMSG_AUTOBANK_ITEM;

function packet(opcode: number, name: string, body: Uint8Array): PlayPacket {
  return { opcode, name, body };
}

export function itemObjectGuid(low: number): bigint {
  return BigInt(low >>> 0) | (HIGHGUID_ITEM << 48n);
}

function writeGuidFields(values: Uint32Array, index: number, guid: bigint): void {
  values[index] = Number(guid & 0xffffffffn) >>> 0;
  values[index + 1] = Number((guid >> 32n) & 0xffffffffn) >>> 0;
}

function writeValues(
  body: ByteWriter,
  values: Uint32Array,
  force?: ReadonlySet<number>,
): void {
  const blocks = Math.ceil(values.length / 32);
  body.writeU8(blocks);
  const present: number[] = [];
  for (let block = 0; block < blocks; block++) {
    let mask = 0;
    for (let bit = 0; bit < 32; bit++) {
      const index = block * 32 + bit;
      if (index < values.length && (values[index] !== 0 || force?.has(index))) {
        mask |= 1 << bit;
        present.push(index);
      }
    }
    body.writeU32(mask >>> 0);
  }
  for (const index of present) {
    body.writeU32(values[index]!);
  }
}

/** The `item_template` columns the inventory code reads, or null when the entry does not exist. */
export function lookupTemplate(world: WorldTables | null, entry: number): ItemTemplateSlice | null {
  const row = world?.first(item_template, "entry", entry);
  if (!row) {
    return null;
  }
  return {
    entry: row.entry,
    InventoryType: row.InventoryType,
    ContainerSlots: row.ContainerSlots,
    BagFamily: row.BagFamily,
    class: row.class,
    subclass: row.subclass,
    bonding: row.bonding,
    stackable: row.stackable ?? 1,
    displayid: row.displayid,
    maxcount: row.maxcount,
    ItemLimitCategory: row.ItemLimitCategory,
  };
}

function stubTemplate(entry: number): ItemTemplateSlice {
  return {
    entry,
    InventoryType: 0,
    ContainerSlots: 0,
    BagFamily: 0,
    class: 0,
    subclass: 0,
    bonding: 0,
    stackable: 1,
    displayid: 0,
  };
}

async function loadBankSlots(db: Db, guid: number): Promise<number> {
  const [row] = await db.select({ bankSlots: characters.bankSlots }).from(characters).where(eq(characters.guid, guid));
  return row?.bankSlots ?? 0;
}

async function saveBankSlots(db: Db, guid: number, bankSlots: number): Promise<void> {
  await db.update(characters).set({ bankSlots }).where(eq(characters.guid, guid));
}

async function updateItemCount(db: Db, itemGuid: number, count: number): Promise<void> {
  await db.update(item_instance).set({ count }).where(eq(item_instance.guid, itemGuid));
}

export async function deleteItemInstance(db: Db, itemGuid: number): Promise<void> {
  await db.delete(item_instance).where(eq(item_instance.guid, itemGuid));
}

/** Load character_inventory (+ item_instance counts) into Inventory. */
export function loadPlayInventory(db: Db, guid: number, world: WorldTables | null = null): Promise<Inventory> {
  return loadInventoryFrom(db, guid, world);
}

async function loadInventoryFrom(db: Db, guid: number, world: WorldTables | null): Promise<Inventory> {
  const inv = createInventory(await loadBankSlots(db, guid));
  const rows = await loadInventory(db, guid);
  const instances = new Map<number, { itemEntry: number; count: number }>();
  if (rows.length > 0) {
    const found = await db
      .select({ guid: item_instance.guid, itemEntry: item_instance.itemEntry, count: item_instance.count })
      .from(item_instance)
      .where(inArray(item_instance.guid, rows.map((row) => row.item)));
    for (const row of found) {
      instances.set(row.guid, { itemEntry: row.itemEntry ?? 0, count: row.count });
    }
  }
  const itemsByGuid = new Map<number, InventoryItem>();
  for (const row of rows) {
    const inst = instances.get(row.item);
    const entry = inst?.itemEntry ?? 0;
    const count = inst?.count ?? 1;
    const template = lookupTemplate(world, entry) ?? stubTemplate(entry);
    itemsByGuid.set(row.item, { guid: row.item, entry, count, template });
  }
  applyInventoryRows(inv, rows, itemsByGuid);
  return inv;
}

export async function savePlayInventory(db: Db, guid: number, inventory: Inventory): Promise<void> {
  await saveInventoryRows(db, guid, inventoryToRows(guid, inventory));
  await saveBankSlots(db, guid, inventory.bankSlots);
  for (const [, bagSlots] of inventory.slots) {
    for (const [, item] of bagSlots) {
      await updateItemCount(db, item.guid, item.count);
    }
  }
}

function enrichTemplates(inv: Inventory, world: WorldTables | null): void {
  if (!world) {
    return;
  }
  for (const [, bagSlots] of inv.slots) {
    for (const [, item] of bagSlots) {
      const tpl = lookupTemplate(world, item.entry);
      if (tpl) {
        item.template = tpl;
        item.entry = tpl.entry;
      }
    }
  }
}

/** `instance` adds the `item_instance` fields (durability, charges, enchantments) to the create block. */
function buildItemCreateBlock(
  item: InventoryItem,
  ownerGuid: number,
  containedGuid: bigint,
  instance?: ItemInstance,
): Uint8Array {
  const isBag = isBagItem(item.template);
  const typeId = isBag ? TYPEID_CONTAINER : TYPEID_ITEM;
  const typeMask = isBag
    ? TYPEMASK_OBJECT | TYPEMASK_CONTAINER
    : TYPEMASK_OBJECT | TYPEMASK_ITEM;
  const fieldCount = isBag ? CONTAINER_END : ITEM_END;
  const values = new Uint32Array(fieldCount);
  const view = new DataView(values.buffer);
  const guid = itemObjectGuid(item.guid);

  writeGuidFields(values, OBJECT_FIELD_GUID, guid);
  values[OBJECT_FIELD_TYPE] = typeMask;
  values[OBJECT_FIELD_ENTRY] = item.entry;
  view.setFloat32(OBJECT_FIELD_SCALE_X * 4, 1, true);
  writeGuidFields(values, ITEM_FIELD_OWNER, BigInt(ownerGuid));
  writeGuidFields(values, ITEM_FIELD_CONTAINED, containedGuid);
  values[ITEM_FIELD_STACK_COUNT] = item.count;
  for (const field of instance ? itemFieldValues(instance) : []) {
    values[field.index] = field.value >>> 0;
  }

  if (isBag) {
    values[CONTAINER_FIELD_NUM_SLOTS] = item.template.ContainerSlots;
  }

  const body = new ByteWriter()
    .writeU8(UPDATETYPE_CREATE_OBJECT)
    .writeBytes(packedGuid(guid))
    .writeU8(typeId)
    .writeU16(UPDATEFLAG_LOWGUID)
    .writeU32(item.guid);
  writeValues(body, values);
  return body.toUint8Array();
}

function fillContainerSlots(values: Uint32Array, inv: Inventory, bagGuid: number): void {
  const bagSlots = inv.slots.get(bagGuid);
  if (!bagSlots) {
    return;
  }
  for (const [slot, item] of bagSlots) {
    writeGuidFields(values, CONTAINER_FIELD_SLOT_1 + slot * 2, itemObjectGuid(item.guid));
  }
}

/** Item create objects + player inventory-slot guid updates. Bodies are UNENCRYPTED. */
export function loginItemPackets(
  playerGuid: number,
  inventory: Inventory,
  world: WorldTables | null,
): PlayPacket[] {
  enrichTemplates(inventory, world);

  const creates: Uint8Array[] = [];
  const playerValues = new Uint32Array(PLAYER_END);
  const force = new Set<number>();

  // Create bag-0 items first, then bag contents (containers need slot fields).
  const bag0 = inventory.slots.get(0);
  if (bag0) {
    for (const [slot, item] of bag0) {
      const block = buildItemCreateBlock(item, playerGuid, BigInt(playerGuid));
      if (isBagItem(item.template)) {
        // Rebuild with container slot guids filled.
        const values = new Uint32Array(CONTAINER_END);
        const view = new DataView(values.buffer);
        const guid = itemObjectGuid(item.guid);
        writeGuidFields(values, OBJECT_FIELD_GUID, guid);
        values[OBJECT_FIELD_TYPE] = TYPEMASK_OBJECT | TYPEMASK_CONTAINER;
        values[OBJECT_FIELD_ENTRY] = item.entry;
        view.setFloat32(OBJECT_FIELD_SCALE_X * 4, 1, true);
        writeGuidFields(values, ITEM_FIELD_OWNER, BigInt(playerGuid));
        writeGuidFields(values, ITEM_FIELD_CONTAINED, BigInt(playerGuid));
        values[ITEM_FIELD_STACK_COUNT] = item.count;
        values[CONTAINER_FIELD_NUM_SLOTS] = item.template.ContainerSlots;
        fillContainerSlots(values, inventory, item.guid);
        const body = new ByteWriter()
          .writeU8(UPDATETYPE_CREATE_OBJECT)
          .writeBytes(packedGuid(guid))
          .writeU8(TYPEID_CONTAINER)
          .writeU16(UPDATEFLAG_LOWGUID)
          .writeU32(item.guid);
        writeValues(body, values);
        creates.push(body.toUint8Array());
      } else {
        creates.push(block);
      }
      writeGuidFields(playerValues, PLAYER_FIELD_INV_SLOT_HEAD + slot * 2, itemObjectGuid(item.guid));
      force.add(PLAYER_FIELD_INV_SLOT_HEAD + slot * 2);
      force.add(PLAYER_FIELD_INV_SLOT_HEAD + slot * 2 + 1);
    }
  }

  for (const [bagGuid, bagSlots] of inventory.slots) {
    if (bagGuid === 0) {
      continue;
    }
    for (const [, item] of bagSlots) {
      creates.push(buildItemCreateBlock(item, playerGuid, itemObjectGuid(bagGuid)));
    }
  }

  if (creates.length === 0) {
    return [];
  }

  const blocks = [...creates];
  const playerUpdate = new ByteWriter()
    .writeU8(UPDATETYPE_VALUES)
    .writeBytes(packedGuid(BigInt(playerGuid)));
  writeValues(playerUpdate, playerValues, force);
  blocks.push(playerUpdate.toUint8Array());

  const body = new ByteWriter().writeU32(blocks.length);
  for (const block of blocks) {
    body.writeBytes(block);
  }
  return [packet(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", body.toUint8Array())];
}

function destroyObjectPacket(itemGuid: number): PlayPacket {
  const body = new ByteWriter()
    .writeU64(itemObjectGuid(itemGuid))
    .writeU8(0)
    .toUint8Array();
  return packet(SMSG_DESTROY_OBJECT, "SMSG_DESTROY_OBJECT", body);
}

export function failurePacket(error: number, itemGuid = 0n): PlayPacket {
  return packet(
    SMSG_INVENTORY_CHANGE_FAILURE,
    "SMSG_INVENTORY_CHANGE_FAILURE",
    buildInventoryChangeFailure(error, itemGuid, 0n, 0),
  );
}

function slotFieldIndex(storageBag: number, slot: number, inv: Inventory): {
  ownerGuid: number;
  fieldBase: number;
  isPlayer: boolean;
} | null {
  if (storageBag === 0) {
    return {
      ownerGuid: 0, // filled by caller with playerGuid
      fieldBase: PLAYER_FIELD_INV_SLOT_HEAD + slot * 2,
      isPlayer: true,
    };
  }
  const pos = inv.byGuid.get(storageBag);
  if (!pos) {
    // Bag may still exist as a map key even mid-update
    return {
      ownerGuid: storageBag,
      fieldBase: CONTAINER_FIELD_SLOT_1 + slot * 2,
      isPlayer: false,
    };
  }
  return {
    ownerGuid: storageBag,
    fieldBase: CONTAINER_FIELD_SLOT_1 + slot * 2,
    isPlayer: false,
  };
}

export function buildSuccessPackets(
  playerGuid: number,
  inv: Inventory,
  result: InventoryOpResult,
  world: WorldTables | null,
  opts: {
    created?: InventoryItem[];
    /** `item_instance` rows for `created`, by item guid. */
    instances?: ReadonlyMap<number, ItemInstance>;
    destroyed?: number[];
    countUpdates?: InventoryItem[];
  } = {},
): PlayPacket[] {
  const packets: PlayPacket[] = [];
  const playerFields: { index: number; value: number }[] = [];
  const containerUpdates = new Map<number, Uint32Array>();

  const ensureContainer = (bagGuid: number): Uint32Array => {
    let values = containerUpdates.get(bagGuid);
    if (!values) {
      values = new Uint32Array(CONTAINER_END);
      containerUpdates.set(bagGuid, values);
    }
    return values;
  };

  for (const change of result.changes) {
    const info = slotFieldIndex(change.bag, change.slot, inv);
    if (!info) {
      continue;
    }
    const guid = change.itemGuid !== null ? itemObjectGuid(change.itemGuid) : 0n;
    if (info.isPlayer) {
      playerFields.push({
        index: info.fieldBase,
        value: Number(guid & 0xffffffffn) >>> 0,
      });
      playerFields.push({
        index: info.fieldBase + 1,
        value: Number((guid >> 32n) & 0xffffffffn) >>> 0,
      });
    } else {
      const values = ensureContainer(change.bag);
      writeGuidFields(values, info.fieldBase, guid);
    }
  }

  for (const item of opts.created ?? []) {
    const pos = inv.byGuid.get(item.guid);
    const contained =
      pos && pos.bag !== 0 ? itemObjectGuid(pos.bag) : BigInt(playerGuid);
    const createBody = new ByteWriter()
      .writeU32(1)
      .writeBytes(buildItemCreateBlock(item, playerGuid, contained, opts.instances?.get(item.guid)));
    packets.push(
      packet(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", createBody.toUint8Array()),
    );
  }

  for (const guid of opts.destroyed ?? []) {
    packets.push(destroyObjectPacket(guid));
  }

  for (const item of opts.countUpdates ?? []) {
    const values = new Uint32Array(ITEM_END);
    values[ITEM_FIELD_STACK_COUNT] = item.count;
    const body = new ByteWriter()
      .writeU32(1)
      .writeU8(UPDATETYPE_VALUES)
      .writeBytes(packedGuid(itemObjectGuid(item.guid)));
    writeValues(body, values, new Set([ITEM_FIELD_STACK_COUNT]));
    packets.push(packet(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", body.toUint8Array()));
  }

  if (playerFields.length > 0) {
    packets.push(
      packet(
        SMSG_UPDATE_OBJECT,
        "SMSG_UPDATE_OBJECT",
        fieldUpdateBlock(playerGuid, playerFields),
      ),
    );
  }

  const equipChanged = result.changes.some(
    (change) => change.bag === 0 && change.slot < EQUIPMENT_SLOT_END,
  );
  if (equipChanged) {
    const gear = visibleGearPacket(playerGuid, inv, world);
    if (gear) {
      packets.push(gear);
    }
  }

  for (const [bagGuid, values] of containerUpdates) {
    const force = new Set<number>();
    for (let i = 0; i < values.length; i++) {
      if (values[i] !== 0) {
        force.add(i);
      }
    }
    // Also force clears (zeros) for slots that appeared in changes
    for (const change of result.changes) {
      if (change.bag === bagGuid) {
        const base = CONTAINER_FIELD_SLOT_1 + change.slot * 2;
        force.add(base);
        force.add(base + 1);
      }
    }
    const body = new ByteWriter()
      .writeU32(1)
      .writeU8(UPDATETYPE_VALUES)
      .writeBytes(packedGuid(itemObjectGuid(bagGuid)));
    writeValues(body, values, force);
    packets.push(packet(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", body.toUint8Array()));
  }

  return packets;
}

async function persistAfterOp(ctx: BagPlayCtx, result: InventoryOpResult, destroyed: number[]): Promise<void> {
  await saveInventoryRows(ctx.db, ctx.playerGuid, inventoryToRows(ctx.playerGuid, ctx.inventory));
  for (const change of result.changes) {
    if (change.itemGuid !== null) {
      const item = [...ctx.inventory.byGuid.entries()].find(([g]) => g === change.itemGuid);
      if (item) {
        const invItem = getItem(ctx.inventory, item[1].bag, item[1].slot);
        if (invItem) {
          await updateItemCount(ctx.db, invItem.guid, invItem.count);
        }
      }
    }
  }
  for (const guid of destroyed) {
    await deleteItemInstance(ctx.db, guid);
  }
  // Also sync counts for any remaining items touched
  for (const change of result.changes) {
    if (change.itemGuid === null) {
      continue;
    }
    const pos = ctx.inventory.byGuid.get(change.itemGuid);
    if (!pos) {
      continue;
    }
    const item = getItem(ctx.inventory, pos.bag, pos.slot);
    if (item) {
      await updateItemCount(ctx.db, item.guid, item.count);
    }
  }
}

function resolvePacketBagOrFail(
  inv: Inventory,
  packetBag: number,
): { ok: true; bag: number } | { ok: false; error: number } {
  if (packetBag === 0 || packetBag === 255) {
    return { ok: true, bag: 0 };
  }
  const resolved = resolveStorageBag(inv, packetBag);
  if (resolved === null) {
    return { ok: false, error: EQUIP_ERR_ITEM_DOESNT_GO_TO_SLOT };
  }
  return { ok: true, bag: resolved };
}

function snapshotCounts(inv: Inventory): Map<number, number> {
  const map = new Map<number, number>();
  for (const [guid, pos] of inv.byGuid) {
    const item = getItem(inv, pos.bag, pos.slot);
    if (item) {
      map.set(guid, item.count);
    }
  }
  return map;
}

function diffDestroyed(
  before: Map<number, { bag: number; slot: number }>,
  after: Inventory,
  beforeCounts: Map<number, number>,
): { destroyed: number[]; countUpdates: InventoryItem[] } {
  const destroyed: number[] = [];
  const countUpdates: InventoryItem[] = [];
  for (const guid of before.keys()) {
    if (!after.byGuid.has(guid)) {
      destroyed.push(guid);
    }
  }
  for (const [guid, pos] of after.byGuid) {
    const item = getItem(after, pos.bag, pos.slot);
    if (!item) {
      continue;
    }
    const prev = beforeCounts.get(guid);
    if (prev !== undefined && prev !== item.count) {
      countUpdates.push(item);
    }
  }
  return { destroyed, countUpdates };
}

function clonePositions(inv: Inventory): Map<number, { bag: number; slot: number }> {
  return new Map(inv.byGuid);
}

export async function handleBags(opcode: number, payload: Uint8Array, ctx: BagPlayCtx): Promise<BagPlayResult> {
  if (!BAG_OPCODES.has(opcode)) {
    return null;
  }

  enrichTemplates(ctx.inventory, ctx.world);
  const op = opcode as BagOpcode;
  const r = new ByteReader(payload);

  switch (op) {
    case CMSG_SWAP_INV_ITEM: {
      const destSlot = r.readU8();
      const srcSlot = r.readU8();
      if (srcSlot === destSlot) {
        return { packets: [] };
      }
      const before = clonePositions(ctx.inventory);
      const beforeCounts = snapshotCounts(ctx.inventory);
      const result = swapInvItem(ctx.inventory, srcSlot, destSlot);
      if (!result.ok) {
        return { packets: [failurePacket(result.error)] };
      }
      const { destroyed, countUpdates } = diffDestroyed(before, ctx.inventory, beforeCounts);
      const packets = buildSuccessPackets(ctx.playerGuid, ctx.inventory, result, ctx.world, {
        destroyed,
        countUpdates,
      });
      await persistAfterOp(ctx, result, destroyed);
      return { packets };
    }
    case CMSG_SWAP_ITEM: {
      const destBag = r.readU8();
      const destSlot = r.readU8();
      const srcBag = r.readU8();
      const srcSlot = r.readU8();
      const src = resolvePacketBagOrFail(ctx.inventory, srcBag);
      if (!src.ok) {
        return { packets: [failurePacket(src.error)] };
      }
      const dst = resolvePacketBagOrFail(ctx.inventory, destBag);
      if (!dst.ok) {
        return { packets: [failurePacket(dst.error)] };
      }
      if (src.bag === dst.bag && srcSlot === destSlot) {
        return { packets: [] };
      }
      const before = clonePositions(ctx.inventory);
      const beforeCounts = snapshotCounts(ctx.inventory);
      const result = swapItem(ctx.inventory, src.bag, srcSlot, dst.bag, destSlot);
      if (!result.ok) {
        return { packets: [failurePacket(result.error)] };
      }
      const { destroyed, countUpdates } = diffDestroyed(before, ctx.inventory, beforeCounts);
      const packets = buildSuccessPackets(ctx.playerGuid, ctx.inventory, result, ctx.world, {
        destroyed,
        countUpdates,
      });
      await persistAfterOp(ctx, result, destroyed);
      return { packets };
    }
    case CMSG_SPLIT_ITEM: {
      const srcBag = r.readU8();
      const srcSlot = r.readU8();
      const destBag = r.readU8();
      const destSlot = r.readU8();
      const count = r.readU32();
      const src = resolvePacketBagOrFail(ctx.inventory, srcBag);
      if (!src.ok) {
        return { packets: [failurePacket(src.error)] };
      }
      const dst = resolvePacketBagOrFail(ctx.inventory, destBag);
      if (!dst.ok) {
        return { packets: [failurePacket(dst.error)] };
      }
      const newGuid = objectGuids.item.generate();
      const beforeCounts = snapshotCounts(ctx.inventory);
      const result = splitItem(
        ctx.inventory,
        src.bag,
        srcSlot,
        dst.bag,
        destSlot,
        count,
        newGuid,
      );
      if (!result.ok) {
        return { packets: [failurePacket(result.error)] };
      }
      const created = getItem(ctx.inventory, dst.bag, destSlot);
      const countUpdates: InventoryItem[] = [];
      const srcItem = getItem(ctx.inventory, src.bag, srcSlot);
      if (srcItem && beforeCounts.get(srcItem.guid) !== srcItem.count) {
        countUpdates.push(srcItem);
      }
      const packets = buildSuccessPackets(ctx.playerGuid, ctx.inventory, result, ctx.world, {
        created: created ? [created] : [],
        countUpdates,
      });
      await persistAfterOp(ctx, result, []);
      if (created) {
        await ctx.db.insert(item_instance).values({
          guid: created.guid,
          itemEntry: created.entry,
          owner_guid: ctx.playerGuid,
          count: created.count,
          charges: emptyChargesString(),
          enchantments: emptyEnchantmentsString(),
        });
      }
      return { packets };
    }
    case CMSG_DESTROYITEM: {
      const bag = r.readU8();
      const slot = r.readU8();
      const count = r.readU8();
      // Data1..3 unused
      if (r.remaining >= 3) {
        r.readU8();
        r.readU8();
        r.readU8();
      }
      const src = resolvePacketBagOrFail(ctx.inventory, bag);
      if (!src.ok) {
        return { packets: [failurePacket(EQUIP_ERR_ITEM_NOT_FOUND)] };
      }
      const before = clonePositions(ctx.inventory);
      const beforeCounts = snapshotCounts(ctx.inventory);
      const result = destroyItem(ctx.inventory, src.bag, slot, count);
      if (!result.ok) {
        return { packets: [failurePacket(result.error)] };
      }
      const { destroyed, countUpdates } = diffDestroyed(before, ctx.inventory, beforeCounts);
      const packets = buildSuccessPackets(ctx.playerGuid, ctx.inventory, result, ctx.world, {
        destroyed,
        countUpdates,
      });
      await persistAfterOp(ctx, result, destroyed);
      return { packets };
    }
    case CMSG_AUTOSTORE_BAG_ITEM: {
      const srcBag = r.readU8();
      const srcSlot = r.readU8();
      const destBag = r.readU8();
      const before = clonePositions(ctx.inventory);
      const beforeCounts = snapshotCounts(ctx.inventory);
      const result = autoStoreBagItem(ctx.inventory, srcBag, srcSlot, destBag);
      if (!result.ok) {
        return { packets: [failurePacket(result.error)] };
      }
      const { destroyed, countUpdates } = diffDestroyed(before, ctx.inventory, beforeCounts);
      const packets = buildSuccessPackets(ctx.playerGuid, ctx.inventory, result, ctx.world, {
        destroyed,
        countUpdates,
      });
      await persistAfterOp(ctx, result, destroyed);
      return { packets };
    }
    case CMSG_AUTOBANK_ITEM: {
      const bag = r.readU8();
      const slot = r.readU8();
      const src = resolvePacketBagOrFail(ctx.inventory, bag);
      if (!src.ok) {
        return { packets: [failurePacket(EQUIP_ERR_ITEM_NOT_FOUND)] };
      }
      const before = clonePositions(ctx.inventory);
      const beforeCounts = snapshotCounts(ctx.inventory);
      const result = autoBankItem(ctx.inventory, src.bag, slot);
      if (!result.ok) {
        return { packets: [failurePacket(result.error)] };
      }
      const { destroyed, countUpdates } = diffDestroyed(before, ctx.inventory, beforeCounts);
      const packets = buildSuccessPackets(ctx.playerGuid, ctx.inventory, result, ctx.world, {
        destroyed,
        countUpdates,
      });
      await persistAfterOp(ctx, result, destroyed);
      return { packets };
    }
    case CMSG_AUTOSTORE_BANK_ITEM: {
      const bag = r.readU8();
      const slot = r.readU8();
      const src = resolvePacketBagOrFail(ctx.inventory, bag);
      if (!src.ok) {
        return { packets: [failurePacket(EQUIP_ERR_ITEM_NOT_FOUND)] };
      }
      const before = clonePositions(ctx.inventory);
      const beforeCounts = snapshotCounts(ctx.inventory);
      const result = autoStoreBankItem(ctx.inventory, src.bag, slot);
      if (!result.ok) {
        return { packets: [failurePacket(result.error)] };
      }
      const { destroyed, countUpdates } = diffDestroyed(before, ctx.inventory, beforeCounts);
      const packets = buildSuccessPackets(ctx.playerGuid, ctx.inventory, result, ctx.world, {
        destroyed,
        countUpdates,
      });
      await persistAfterOp(ctx, result, destroyed);
      return { packets };
    }
    case CMSG_BUY_BANK_SLOT: {
      // Banker guid — ignored (no banker interaction check in this port slice).
      if (r.remaining >= 8) {
        r.readU64();
      }
      const bought = buyBankSlot(ctx.inventory, ctx.money);
      const packets: PlayPacket[] = [
        packet(
          SMSG_BUY_BANK_SLOT_RESULT,
          "SMSG_BUY_BANK_SLOT_RESULT",
          buildBuyBankSlotResult(bought.result),
        ),
      ];
      if (bought.money !== undefined) {
        ctx.money = bought.money;
        packets.push(
          packet(
            SMSG_UPDATE_OBJECT,
            "SMSG_UPDATE_OBJECT",
            fieldUpdateBlock(ctx.playerGuid, [
              { index: PLAYER_FIELD_COINAGE, value: bought.money >>> 0 },
            ]),
          ),
        );
        await saveBankSlots(ctx.db, ctx.playerGuid, ctx.inventory.bankSlots);
        return { packets, money: bought.money };
      }
      return { packets };
    }
    default: {
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}
