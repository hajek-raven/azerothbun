/**
 * Session-ready auto-equip + visible gear (CMSG_AUTOEQUIP_ITEM / _SLOT).
 * Mutates ctx.inventory in place; parent persists via bags.saveInventoryRows.
 */
import { inArray } from "drizzle-orm";
import type { Db } from "../database/database.ts";
import { item_instance } from "../database/schema/characters.ts";
import { item_template } from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import {
  enchantmentIdAt,
  parseItemEnchantments,
  PERM_ENCHANTMENT_SLOT,
  TEMP_ENCHANTMENT_SLOT,
} from "../characters/char-enum-gear.ts";
import {
  buildInventoryChangeFailure,
  EQUIPMENT_SLOT_END,
  EQUIPMENT_SLOT_START,
  getItem,
  getItemPos,
  INVENTORY_SLOT_BAG_0,
  INVENTORY_SLOT_ITEM_END,
  INVENTORY_SLOT_ITEM_START,
  isBagItem,
  SMSG_INVENTORY_CHANGE_FAILURE,
  swapItem,
  type Inventory,
  type SlotChange,
} from "../items/bags.ts";
import {
  canEquip,
  equip,
  EQUIP_ERR_ITEM_CANT_BE_EQUIPPED,
  INVENTORY_SLOT_BAG_0 as EQUIP_BAG_0,
  NULL_SLOT,
  PLAYER_VISIBLE_ITEM_1_ENTRYID,
  visibleItemFields,
  writeVisibleItemsUpdate,
  type EquipInventoryItem,
  type EquipMove,
  type EquipOptions,
} from "../items/equip.ts";
import { itemGuidRaw } from "../items/equipment-sets.ts";
import { ByteReader } from "../net/byte-buffer.ts";

const OBJECT_END = 0x0006;
const UNIT_END = OBJECT_END + 0x008e;

/** UpdateFields.h — PLAYER_FIELD_INV_SLOT_HEAD (equipment + bag slots 0..22) */
export const PLAYER_FIELD_INV_SLOT_HEAD = UNIT_END + 0x00b0;
/** UpdateFields.h — PLAYER_FIELD_PACK_SLOT_1 (backpack 23..38) */
export const PLAYER_FIELD_PACK_SLOT_1 = UNIT_END + 0x00de;

export const CMSG_AUTOEQUIP_ITEM = 0x10a;
export const CMSG_AUTOEQUIP_ITEM_SLOT = 0x10f;
export const SMSG_UPDATE_OBJECT = 0x0a9;

export const EQUIP_OPCODES: ReadonlySet<number> = new Set([
  CMSG_AUTOEQUIP_ITEM,
  CMSG_AUTOEQUIP_ITEM_SLOT,
]);

export type PlayPacket = { opcode: number; name: string; body: Uint8Array };
export type EquipPlayResult = { packets: PlayPacket[] } | null;

export type EquipPlayCtx = {
  db: Db;
  world: WorldTables | null;
  playerGuid: number;
  race: number;
  classId: number;
  level: number;
  inventory: Inventory;
};

type ItemUseLimits = {
  allowableClass: number;
  allowableRace: number;
  requiredLevel: number;
};

type OpcodeKind = "autoequip_item" | "autoequip_item_slot";

function opcodeKind(opcode: number): OpcodeKind | null {
  switch (opcode) {
    case CMSG_AUTOEQUIP_ITEM:
      return "autoequip_item";
    case CMSG_AUTOEQUIP_ITEM_SLOT:
      return "autoequip_item_slot";
    default:
      return null;
  }
}

function packet(opcode: number, name: string, body: Uint8Array): PlayPacket {
  return { opcode, name, body };
}

function storageBag(bag: number): number {
  return bag === INVENTORY_SLOT_BAG_0 ? 0 : bag;
}

function equipBag(storage: number): number {
  return storage === 0 ? EQUIP_BAG_0 : storage;
}

type EnchantIds = { perm: number; temp: number };

/** Permanent and temporary enchant ids of each item, from `item_instance.enchantments`. */
async function loadEnchantIds(db: Db, inventory: Inventory): Promise<Map<number, EnchantIds>> {
  const guids = [...inventory.byGuid.keys()];
  const enchants = new Map<number, EnchantIds>();
  if (guids.length === 0) {
    return enchants;
  }
  const rows = await db
    .select({ guid: item_instance.guid, enchantments: item_instance.enchantments })
    .from(item_instance)
    .where(inArray(item_instance.guid, guids));
  for (const row of rows) {
    const fields = parseItemEnchantments(row.enchantments);
    enchants.set(row.guid, {
      perm: enchantmentIdAt(fields, PERM_ENCHANTMENT_SLOT),
      temp: enchantmentIdAt(fields, TEMP_ENCHANTMENT_SLOT),
    });
  }
  return enchants;
}

function loadItemUseLimits(world: WorldTables | null, entry: number): ItemUseLimits {
  const row = entry ? world?.first(item_template, "entry", entry) : undefined;
  if (!row) {
    return { allowableClass: -1, allowableRace: -1, requiredLevel: 0 };
  }
  return {
    allowableClass: row.AllowableClass,
    allowableRace: row.AllowableRace,
    requiredLevel: row.RequiredLevel,
  };
}

function inventoryToEquipRows(inv: Inventory, enchantIds: ReadonlyMap<number, EnchantIds>, world: WorldTables | null): EquipInventoryItem[] {
  const rows: EquipInventoryItem[] = [];
  for (const [bag, slots] of inv.slots) {
    for (const [slot, item] of slots) {
      const enchants = enchantIds.get(item.guid) ?? { perm: 0, temp: 0 };
      const limits = loadItemUseLimits(world, item.entry);
      rows.push({
        bag: equipBag(bag),
        slot,
        itemGuid: item.guid,
        itemEntry: item.entry,
        inventoryType: item.template.InventoryType,
        allowableClass: limits.allowableClass,
        allowableRace: limits.allowableRace,
        requiredLevel: limits.requiredLevel,
        permanentEnchantment: enchants.perm,
        temporaryEnchantment: enchants.temp,
      });
    }
  }
  return rows;
}

function equipOptions(ctx: EquipPlayCtx, swap: boolean): EquipOptions {
  return {
    swap,
    race: ctx.race,
    classId: ctx.classId,
    level: ctx.level,
  };
}

function failurePacket(msg: number, itemGuid: number): PlayPacket {
  return packet(
    SMSG_INVENTORY_CHANGE_FAILURE,
    "SMSG_INVENTORY_CHANGE_FAILURE",
    buildInventoryChangeFailure(msg, itemGuidRaw(itemGuid)),
  );
}

/** Update-field index for a player bag-0 inventory slot guid (low half of LONG). */
export function invSlotGuidFieldIndex(bag: number, slot: number): number | null {
  const storage = storageBag(bag);
  if (storage !== 0) {
    return null;
  }
  if (slot >= EQUIPMENT_SLOT_START && slot < INVENTORY_SLOT_ITEM_START) {
    return PLAYER_FIELD_INV_SLOT_HEAD + slot * 2;
  }
  if (slot >= INVENTORY_SLOT_ITEM_START && slot < INVENTORY_SLOT_ITEM_END) {
    return PLAYER_FIELD_PACK_SLOT_1 + (slot - INVENTORY_SLOT_ITEM_START) * 2;
  }
  return null;
}

function guidFieldValues(itemGuid: number | null): { low: number; high: number } {
  if (itemGuid === null || itemGuid === 0) {
    return { low: 0, high: 0 };
  }
  const raw = itemGuidRaw(itemGuid);
  return { low: Number(raw & 0xffffffffn), high: Number((raw >> 32n) & 0xffffffffn) };
}

function slotChangeFields(changes: readonly SlotChange[]): { index: number; value: number }[] {
  const fields: { index: number; value: number }[] = [];
  for (const change of changes) {
    const index = invSlotGuidFieldIndex(change.bag, change.slot);
    if (index === null) {
      continue;
    }
    const guid = guidFieldValues(change.itemGuid);
    fields.push({ index, value: guid.low });
    fields.push({ index: index + 1, value: guid.high });
  }
  return fields;
}

/** Apply each move by current guid position → destination (handles swap-into-source). */
function applyEquipMoves(inv: Inventory, moves: readonly EquipMove[]): SlotChange[] {
  const changes: SlotChange[] = [];
  for (const move of moves) {
    const pos = getItemPos(inv, move.itemGuid);
    if (!pos) {
      continue;
    }
    const fromBag = pos.bag === 0 ? INVENTORY_SLOT_BAG_0 : pos.bag;
    const toBag = move.toBag === EQUIP_BAG_0 ? INVENTORY_SLOT_BAG_0 : move.toBag;
    if (fromBag === toBag && pos.slot === move.toSlot) {
      continue;
    }
    const result = swapItem(inv, fromBag, pos.slot, toBag, move.toSlot);
    if (!result.ok) {
      continue;
    }
    changes.push(...result.changes);
  }
  return changes;
}

function equippedVisibleRows(
  inventory: Inventory,
  enchantIds: ReadonlyMap<number, EnchantIds>,
  world: WorldTables | null,
): EquipInventoryItem[] {
  const rows: EquipInventoryItem[] = [];
  for (const [bag, slots] of inventory.slots) {
    if (storageBag(bag) !== 0) {
      continue;
    }
    for (const [slot, item] of slots) {
      if (slot < EQUIPMENT_SLOT_START || slot >= EQUIPMENT_SLOT_END) {
        continue;
      }
      const enchants = enchantIds.get(item.guid) ?? { perm: 0, temp: 0 };
      const limits = loadItemUseLimits(world, item.entry);
      rows.push({
        bag: EQUIP_BAG_0,
        slot,
        itemGuid: item.guid,
        itemEntry: item.entry,
        inventoryType: item.template.InventoryType,
        allowableClass: limits.allowableClass,
        allowableRace: limits.allowableRace,
        requiredLevel: limits.requiredLevel,
        permanentEnchantment: enchants.perm,
        temporaryEnchantment: enchants.temp,
      });
    }
  }
  return rows;
}

/**
 * UPDATETYPE_VALUES block (SMSG_UPDATE_OBJECT) writing PLAYER_VISIBLE_ITEM_* for
 * currently equipped slots 0..18. Unencrypted body.
 *
 * Enchant ids are 0 unless the caller passes them (`handleEquip` reads them from `item_instance`).
 */
export function visibleGearPacket(
  playerGuid: number,
  inventory: Inventory,
  world: WorldTables | null,
  enchantIds: ReadonlyMap<number, EnchantIds> = new Map(),
): PlayPacket | null {
  const rows = equippedVisibleRows(inventory, enchantIds, world);
  const fields = visibleItemFields(rows);
  return packet(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", writeVisibleItemsUpdate(playerGuid, fields));
}

function visibleGearPacketWithEnchants(
  playerGuid: number,
  inventory: Inventory,
  enchantIds: ReadonlyMap<number, EnchantIds>,
  world: WorldTables | null,
): PlayPacket {
  const rows = equippedVisibleRows(inventory, enchantIds, world);
  return packet(
    SMSG_UPDATE_OBJECT,
    "SMSG_UPDATE_OBJECT",
    writeVisibleItemsUpdate(playerGuid, visibleItemFields(rows)),
  );
}

function inventoryGuidPacket(playerGuid: number, changes: readonly SlotChange[]): PlayPacket | null {
  const fields = slotChangeFields(changes);
  if (fields.length === 0) {
    return null;
  }
  return packet(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", writeVisibleItemsUpdate(playerGuid, fields));
}

function successPackets(
  ctx: EquipPlayCtx,
  enchantIds: ReadonlyMap<number, EnchantIds>,
  changes: readonly SlotChange[],
): EquipPlayResult {
  const packets: PlayPacket[] = [];
  const invPacket = inventoryGuidPacket(ctx.playerGuid, changes);
  if (invPacket) {
    packets.push(invPacket);
  }
  packets.push(visibleGearPacketWithEnchants(ctx.playerGuid, ctx.inventory, enchantIds, ctx.world));
  return { packets };
}

function handleAutoEquipItem(payload: Uint8Array, ctx: EquipPlayCtx, enchantIds: ReadonlyMap<number, EnchantIds>): EquipPlayResult {
  if (payload.length < 2) {
    return null;
  }
  const reader = new ByteReader(payload);
  const srcBag = reader.readU8();
  const srcSlot = reader.readU8();
  const srcStorage = storageBag(srcBag);
  const srcItem = getItem(ctx.inventory, srcStorage, srcSlot);
  if (!srcItem) {
    return null;
  }

  const swap = !isBagItem(srcItem.template);
  const rows = inventoryToEquipRows(ctx.inventory, enchantIds, ctx.world);
  const result = equip(rows, srcItem.guid, NULL_SLOT, equipOptions(ctx, swap));
  if (!result.ok) {
    return { packets: [failurePacket(result.error, srcItem.guid)] };
  }

  const dest = result.destSlot;
  if (dest === srcSlot && srcStorage === 0) {
    return { packets: [failurePacket(EQUIP_ERR_ITEM_CANT_BE_EQUIPPED, srcItem.guid)] };
  }

  const changes = applyEquipMoves(ctx.inventory, result.moves);
  return successPackets(ctx, enchantIds, changes);
}

function handleAutoEquipItemSlot(payload: Uint8Array, ctx: EquipPlayCtx, enchantIds: ReadonlyMap<number, EnchantIds>): EquipPlayResult {
  if (payload.length < 9) {
    return null;
  }
  const reader = new ByteReader(payload);
  const itemGuidRaw64 = reader.readU64();
  const destSlot = reader.readU8();
  if (destSlot >= EQUIPMENT_SLOT_END) {
    return null;
  }

  const itemGuid = Number(itemGuidRaw64 & 0xffffffffn);
  const pos = getItemPos(ctx.inventory, itemGuid);
  if (!pos) {
    return null;
  }
  if (pos.bag === 0 && pos.slot === destSlot) {
    return null;
  }

  const srcItem = getItem(ctx.inventory, pos.bag, pos.slot);
  if (!srcItem) {
    return null;
  }

  const rows = inventoryToEquipRows(ctx.inventory, enchantIds, ctx.world);
  const check = canEquip(rows, itemGuid, destSlot, equipOptions(ctx, true));
  if (!check.ok) {
    return { packets: [failurePacket(check.error, itemGuid)] };
  }

  const result = equip(rows, itemGuid, destSlot, equipOptions(ctx, true));
  if (!result.ok) {
    return { packets: [failurePacket(result.error, itemGuid)] };
  }

  const changes = applyEquipMoves(ctx.inventory, result.moves);
  return successPackets(ctx, enchantIds, changes);
}

export async function handleEquip(opcode: number, payload: Uint8Array, ctx: EquipPlayCtx): Promise<EquipPlayResult> {
  const kind = opcodeKind(opcode);
  if (kind === null) {
    return null;
  }
  const enchantIds = await loadEnchantIds(ctx.db, ctx.inventory);
  switch (kind) {
    case "autoequip_item":
      return handleAutoEquipItem(payload, ctx, enchantIds);
    case "autoequip_item_slot":
      return handleAutoEquipItemSlot(payload, ctx, enchantIds);
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export { PLAYER_VISIBLE_ITEM_1_ENTRYID };
