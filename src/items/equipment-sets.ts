import { asc, eq } from "drizzle-orm";
import type { Db } from "../database/database.ts";
import { character_equipmentsets } from "../database/schema/characters.ts";
import { generateEquipmentSetGuid } from "../game/globals/object-guids.ts";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";

/** SMSG_EQUIPMENT_SET_LIST — Opcodes.h 0x4BC */
export const SMSG_EQUIPMENT_SET_LIST = 0x4bc;
/** CMSG_EQUIPMENT_SET_SAVE — Opcodes.h 0x4BD */
export const CMSG_EQUIPMENT_SET_SAVE = 0x4bd;
/** CMSG_DELETEEQUIPMENT_SET — Opcodes.h 0x13E */
export const CMSG_DELETEEQUIPMENT_SET = 0x13e;
/** CMSG_EQUIPMENT_SET_USE — Opcodes.h 0x4D5 */
export const CMSG_EQUIPMENT_SET_USE = 0x4d5;
/** SMSG_EQUIPMENT_SET_USE_RESULT — Opcodes.h 0x4D6 */
export const SMSG_EQUIPMENT_SET_USE_RESULT = 0x4d6;
/** SMSG_EQUIPMENT_SET_SAVED — Opcodes.h 0x137 */
export const SMSG_EQUIPMENT_SET_SAVED = 0x137;

/** Client equipment-manager slot count (`MAX_EQUIPMENT_SET_INDEX`). */
export const MAX_EQUIPMENT_SET_INDEX = 10;
/** `EQUIPMENT_SLOT_END` — 19 paper-doll item slots. */
export const EQUIPMENT_SLOT_END = 19;
/**
 * Raw packed GUID the client sends for an ignored slot
 * (do not touch at equip-set use). Stored as a bit in `ignore_mask`.
 */
export const EQUIPMENT_SET_IGNORED_SLOT = 1n;

const HIGH_GUID_ITEM = 0x4000n;
const NAME_MAX_LEN = 16;
const ICON_MAX_LEN = 100;

const ITEM_COLUMNS = [
  "item0",
  "item1",
  "item2",
  "item3",
  "item4",
  "item5",
  "item6",
  "item7",
  "item8",
  "item9",
  "item10",
  "item11",
  "item12",
  "item13",
  "item14",
  "item15",
  "item16",
  "item17",
  "item18",
] as const;

export type EquipmentSet = {
  setguid: bigint;
  setindex: number;
  name: string;
  iconname: string;
  ignoreMask: number;
  /** Item GUID counters for slots 0..18 (`item0`..`item18`). 0 = empty. */
  items: number[];
};

export type EquipmentSetSlotMove = {
  slot: number;
  itemGuid: number;
  /** True when the set wants an item the character does not own. */
  missing: boolean;
};

export type EquipmentSetUseSlot = {
  itemGuid: bigint;
  srcbag: number;
  srcslot: number;
};

type EquipmentSetRow = {
  setguid: number | bigint;
  setindex: number;
  name: string;
  iconname: string;
  ignore_mask: number;
  item0: number;
  item1: number;
  item2: number;
  item3: number;
  item4: number;
  item5: number;
  item6: number;
  item7: number;
  item8: number;
  item9: number;
  item10: number;
  item11: number;
  item12: number;
  item13: number;
  item14: number;
  item15: number;
  item16: number;
  item17: number;
  item18: number;
};

export async function loadSets(db: Db, characterGuid: number): Promise<EquipmentSet[]> {
  const rows: EquipmentSetRow[] = await db
    .select()
    .from(character_equipmentsets)
    .where(eq(character_equipmentsets.guid, characterGuid))
    .orderBy(asc(character_equipmentsets.setindex));

  const sets: EquipmentSet[] = [];
  for (const row of rows) {
    if (sets.length >= MAX_EQUIPMENT_SET_INDEX) {
      break;
    }
    sets.push(rowToSet(row));
  }
  return sets;
}

export async function saveSet(db: Db, characterGuid: number, set: EquipmentSet): Promise<EquipmentSet> {
  if (set.setindex < 0 || set.setindex >= MAX_EQUIPMENT_SET_INDEX) {
    throw new Error(`equipment set index out of range: ${set.setindex}`);
  }
  if (set.name.length > NAME_MAX_LEN) {
    throw new Error("equipment set name too long");
  }
  if (set.iconname.length > ICON_MAX_LEN) {
    throw new Error("equipment set icon name too long");
  }

  const items = normalizeItems(set.items);
  let setguid = set.setguid;
  if (setguid === 0n) {
    setguid = generateEquipmentSetGuid();
  }

  const params = {
    guid: characterGuid,
    setguid: Number(setguid),
    setindex: set.setindex,
    name: set.name,
    iconname: set.iconname,
    ignore_mask: set.ignoreMask >>> 0,
    item0: items[0]!,
    item1: items[1]!,
    item2: items[2]!,
    item3: items[3]!,
    item4: items[4]!,
    item5: items[5]!,
    item6: items[6]!,
    item7: items[7]!,
    item8: items[8]!,
    item9: items[9]!,
    item10: items[10]!,
    item11: items[11]!,
    item12: items[12]!,
    item13: items[13]!,
    item14: items[14]!,
    item15: items[15]!,
    item16: items[16]!,
    item17: items[17]!,
    item18: items[18]!,
  };

  await db.insert(character_equipmentsets).values(params).onDuplicateKeyUpdate({ set: params });

  return {
    setguid,
    setindex: set.setindex,
    name: set.name,
    iconname: set.iconname,
    ignoreMask: set.ignoreMask >>> 0,
    items,
  };
}

export async function deleteSet(db: Db, setguid: bigint): Promise<void> {
  await db.delete(character_equipmentsets).where(eq(character_equipmentsets.setguid, Number(setguid)));
}

/**
 * Desired paper-doll changes for applying `set`. Ignored slots are omitted.
 * A missing owned item is reported with `missing: true` (no throw).
 */
export function useSet(
  set: EquipmentSet,
  ownedItemGuids: ReadonlySet<number>,
): EquipmentSetSlotMove[] {
  const moves: EquipmentSetSlotMove[] = [];
  const items = normalizeItems(set.items);
  for (let slot = 0; slot < EQUIPMENT_SLOT_END; slot++) {
    if (set.ignoreMask & (1 << slot)) {
      continue;
    }
    const itemGuid = items[slot]!;
    if (itemGuid === 0) {
      moves.push({ slot, itemGuid: 0, missing: false });
      continue;
    }
    moves.push({
      slot,
      itemGuid,
      missing: !ownedItemGuids.has(itemGuid),
    });
  }
  return moves;
}

/**
 * Payload body for `SMSG_EQUIPMENT_SET_LIST` (no server header).
 * Format: count u32, then per set: packed setguid, setindex u32, name, icon, 19 packed item guids.
 */
export function equipmentSetListPacket(sets: readonly EquipmentSet[]): Uint8Array {
  const body = new ByteWriter();
  const limited = sets.slice(0, MAX_EQUIPMENT_SET_INDEX);
  body.writeU32(limited.length);
  for (const set of limited) {
    body.writeBytes(packedGuid(set.setguid));
    body.writeU32(set.setindex);
    body.writeCString(set.name);
    body.writeCString(set.iconname);
    const items = normalizeItems(set.items);
    for (let slot = 0; slot < EQUIPMENT_SLOT_END; slot++) {
      if (set.ignoreMask & (1 << slot)) {
        body.writeBytes(packedGuid(EQUIPMENT_SET_IGNORED_SLOT));
      } else {
        body.writeBytes(packedGuid(itemGuidRaw(items[slot]!)));
      }
    }
  }
  return body.toUint8Array();
}

/** Parse `CMSG_EQUIPMENT_SET_SAVE` payload. Returns null when the client data is invalid. */
export function parseEquipmentSetSave(payload: Uint8Array): EquipmentSet | null {
  const reader = new ByteReader(payload);
  const setguid = readPackedGuid(reader);
  const setindex = reader.readU32();
  if (setindex >= MAX_EQUIPMENT_SET_INDEX) {
    return null;
  }
  const name = reader.readCString();
  if (name.length > NAME_MAX_LEN) {
    return null;
  }
  const iconname = reader.readCString();
  if (iconname.length > ICON_MAX_LEN) {
    return null;
  }

  let ignoreMask = 0;
  const items = emptyItems();
  for (let slot = 0; slot < EQUIPMENT_SLOT_END; slot++) {
    const raw = readPackedGuid(reader);
    if (raw === 0n) {
      continue;
    }
    if (raw === EQUIPMENT_SET_IGNORED_SLOT) {
      ignoreMask |= 1 << slot;
      continue;
    }
    items[slot] = itemGuidCounter(raw);
  }

  return { setguid, setindex, name, iconname, ignoreMask, items };
}

/** Parse `CMSG_DELETEEQUIPMENT_SET` / equipment-set delete payload (packed setguid). */
export function parseEquipmentSetDelete(payload: Uint8Array): bigint {
  return readPackedGuid(new ByteReader(payload));
}

/** Parse `CMSG_EQUIPMENT_SET_USE` payload: 19 × (packed itemGuid, srcbag u8, srcslot u8). */
export function parseEquipmentSetUse(payload: Uint8Array): EquipmentSetUseSlot[] {
  const reader = new ByteReader(payload);
  const slots: EquipmentSetUseSlot[] = [];
  for (let i = 0; i < EQUIPMENT_SLOT_END; i++) {
    const itemGuid = readPackedGuid(reader);
    const srcbag = reader.readU8();
    const srcslot = reader.readU8();
    slots.push({ itemGuid, srcbag, srcslot });
  }
  return slots;
}

/** Build `HighGuid::Item` raw value from a stored item counter. */
export function itemGuidRaw(counter: number): bigint {
  if (counter === 0) {
    return 0n;
  }
  return BigInt(counter >>> 0) | (HIGH_GUID_ITEM << 48n);
}

export function itemGuidCounter(raw: bigint): number {
  if (raw === 0n || raw === EQUIPMENT_SET_IGNORED_SLOT) {
    return 0;
  }
  return Number(raw & 0xffffffffn);
}

function rowToSet(row: EquipmentSetRow): EquipmentSet {
  return {
    setguid: BigInt(row.setguid),
    setindex: row.setindex,
    name: row.name,
    iconname: row.iconname,
    ignoreMask: row.ignore_mask >>> 0,
    items: ITEM_COLUMNS.map((column) => row[column] >>> 0),
  };
}

function emptyItems(): number[] {
  return Array.from({ length: EQUIPMENT_SLOT_END }, () => 0);
}

function normalizeItems(items: readonly number[]): number[] {
  const out = emptyItems();
  for (let i = 0; i < EQUIPMENT_SLOT_END && i < items.length; i++) {
    out[i] = (items[i] ?? 0) >>> 0;
  }
  return out;
}

function packedGuid(guid: bigint): Uint8Array {
  let mask = 0;
  const bytes: number[] = [];
  for (let index = 0; index < 8; index++) {
    const byte = Number((guid >> BigInt(index * 8)) & 0xffn);
    if (byte !== 0) {
      mask |= 1 << index;
      bytes.push(byte);
    }
  }
  return Uint8Array.of(mask, ...bytes);
}

function readPackedGuid(reader: ByteReader): bigint {
  const mask = reader.readU8();
  let guid = 0n;
  for (let index = 0; index < 8; index++) {
    if (mask & (1 << index)) {
      guid |= BigInt(reader.readU8()) << BigInt(index * 8);
    }
  }
  return guid;
}
