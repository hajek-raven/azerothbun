import { eq } from "drizzle-orm";
import type { Db } from "../database/database.ts";
import { item_instance } from "../database/schema/characters.ts";
import { item_enchantment_template, item_template } from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { objectGuids } from "../game/Globals/object-guids.ts";
import { irand, randChance } from "../common/random.ts";
import { ByteWriter } from "../net/byte-buffer.ts";
import { packedGuid } from "../world/update-object.ts";

/** UpdateFields.h `OBJECT_END` */
export const OBJECT_END = 0x0006;

export const OBJECT_FIELD_ENTRY = 0x0003;

/** Item.h / UpdateFields.h */
export const ITEM_FIELD_OWNER = OBJECT_END + 0x0000;
export const ITEM_FIELD_CONTAINED = OBJECT_END + 0x0002;
export const ITEM_FIELD_CREATOR = OBJECT_END + 0x0004;
export const ITEM_FIELD_GIFTCREATOR = OBJECT_END + 0x0006;
export const ITEM_FIELD_STACK_COUNT = OBJECT_END + 0x0008;
export const ITEM_FIELD_DURATION = OBJECT_END + 0x0009;
export const ITEM_FIELD_SPELL_CHARGES = OBJECT_END + 0x000a;
export const ITEM_FIELD_FLAGS = OBJECT_END + 0x000f;
export const ITEM_FIELD_ENCHANTMENT_1_1 = OBJECT_END + 0x0010;
export const ITEM_FIELD_PROPERTY_SEED = OBJECT_END + 0x0034;
export const ITEM_FIELD_RANDOM_PROPERTIES_ID = OBJECT_END + 0x0035;
export const ITEM_FIELD_DURABILITY = OBJECT_END + 0x0036;
export const ITEM_FIELD_MAXDURABILITY = OBJECT_END + 0x0037;
export const ITEM_FIELD_CREATE_PLAYED_TIME = OBJECT_END + 0x0038;
export const ITEM_END = OBJECT_END + 0x003a;

/** ItemTemplate.h */
export const MAX_ITEM_PROTO_SPELLS = 5;
export const MAX_ITEM_PROTO_SOCKETS = 3;
export const MAX_GEM_SOCKETS = MAX_ITEM_PROTO_SOCKETS;

/** Item.h EnchantmentOffset / MAX_ENCHANTMENT_OFFSET */
export const ENCHANTMENT_ID_OFFSET = 0;
export const ENCHANTMENT_DURATION_OFFSET = 1;
export const ENCHANTMENT_CHARGES_OFFSET = 2;
export const MAX_ENCHANTMENT_OFFSET = 3;

/**
 * Item.h `EnchantmentSlot`.
 * Each slot stores three uint32s in the update fields and in the DB text:
 * `id duration charges`.
 */
export const EnchantmentSlot = {
  PERM_ENCHANTMENT_SLOT: 0,
  TEMP_ENCHANTMENT_SLOT: 1,
  SOCK_ENCHANTMENT_SLOT: 2,
  SOCK_ENCHANTMENT_SLOT_2: 3,
  SOCK_ENCHANTMENT_SLOT_3: 4,
  BONUS_ENCHANTMENT_SLOT: 5,
  PRISMATIC_ENCHANTMENT_SLOT: 6,
  MAX_INSPECTED_ENCHANTMENT_SLOT: 7,
  PROP_ENCHANTMENT_SLOT_0: 7,
  PROP_ENCHANTMENT_SLOT_1: 8,
  PROP_ENCHANTMENT_SLOT_2: 9,
  PROP_ENCHANTMENT_SLOT_3: 10,
  PROP_ENCHANTMENT_SLOT_4: 11,
  MAX_ENCHANTMENT_SLOT: 12,
} as const;

export type EnchantmentSlotId = (typeof EnchantmentSlot)[keyof typeof EnchantmentSlot];

export const MAX_ENCHANTMENT_SLOT = EnchantmentSlot.MAX_ENCHANTMENT_SLOT;

/** Item.h ItemUpdateState */
export const ItemUpdateState = {
  ITEM_UNCHANGED: 0,
  ITEM_CHANGED: 1,
  ITEM_NEW: 2,
  ITEM_REMOVED: 3,
} as const;

export type ItemUpdateStateId = (typeof ItemUpdateState)[keyof typeof ItemUpdateState];

export type ItemEnchantment = {
  id: number;
  duration: number;
  charges: number;
};

/**
 * In-memory item_instance row plus runtime fields MaxDurability / uState
 * (MaxDurability is not a DB column; it comes from item_template).
 */
export type ItemInstance = {
  guid: number;
  itemEntry: number;
  owner_guid: number;
  creatorGuid: number;
  giftCreatorGuid: number;
  count: number;
  duration: number;
  /** Signed spell charges; length MAX_ITEM_PROTO_SPELLS. */
  charges: number[];
  flags: number;
  /** Length MAX_ENCHANTMENT_SLOT. */
  enchantments: ItemEnchantment[];
  /** Signed; positive = ItemRandomProperties, negative = ItemRandomSuffix. */
  randomPropertyId: number;
  /** `ITEM_FIELD_PROPERTY_SEED`: the suffix factor of a random suffix item (`Item::UpdateItemSuffixFactor`). Not stored. */
  propertySeed?: number;
  durability: number;
  maxDurability: number;
  playedTime: number;
  text: string | null;
  uState: ItemUpdateStateId;
};

export type CreateItemOptions = {
  entry: number;
  owner: number;
  count?: number;
  durability?: number;
  maxDurability?: number;
  randomPropertyId?: number;
  creatorGuid?: number;
  giftCreatorGuid?: number;
  duration?: number;
  flags?: number;
  charges?: readonly number[];
  text?: string | null;
  playedTime?: number;
};

export type ItemFieldValue = { index: number; value: number };


/**
 * Exact empty enchantments blob SaveToDB writes for a blank item:
 * 12 slots × (id, duration, charges), each followed by a space.
 */
export function emptyEnchantmentsString(): string {
  const parts: string[] = [];
  for (let i = 0; i < MAX_ENCHANTMENT_SLOT * MAX_ENCHANTMENT_OFFSET; i++) {
    parts.push("0");
  }
  return `${parts.join(" ")} `;
}

/** Exact empty charges blob: 5 spell charges, each followed by a space. */
export function emptyChargesString(): string {
  const parts: string[] = [];
  for (let i = 0; i < MAX_ITEM_PROTO_SPELLS; i++) {
    parts.push("0");
  }
  return `${parts.join(" ")} `;
}

export function emptyEnchantments(): ItemEnchantment[] {
  const list: ItemEnchantment[] = [];
  for (let i = 0; i < MAX_ENCHANTMENT_SLOT; i++) {
    list.push({ id: 0, duration: 0, charges: 0 });
  }
  return list;
}

export function emptyCharges(): number[] {
  return [0, 0, 0, 0, 0];
}

/** Acore::Tokenize(str, ' ', false) */
function tokenizeSpace(data: string): string[] {
  const tokens: string[] = [];
  let start = 0;
  for (let end = data.indexOf(" "); end !== -1; end = data.indexOf(" ", start)) {
    if (start < end) {
      tokens.push(data.slice(start, end));
    }
    start = end + 1;
  }
  if (start < data.length) {
    tokens.push(data.slice(start));
  }
  return tokens;
}

/**
 * Serialize enchantments like Item::SaveToDB:
 * for each slot: `id << ' ' << duration << ' ' << charges << ' '`.
 */
export function serializeEnchantments(enchantments: readonly ItemEnchantment[]): string {
  let out = "";
  for (let i = 0; i < MAX_ENCHANTMENT_SLOT; i++) {
    const e = enchantments[i] ?? { id: 0, duration: 0, charges: 0 };
    out += `${e.id >>> 0} ${e.duration >>> 0} ${e.charges >>> 0} `;
  }
  return out;
}

/**
 * Parse the item_instance.enchantments text into MAX_ENCHANTMENT_SLOT slots.
 * Requires exactly 36 tokens (same as Object::_LoadIntoDataField).
 */
export function parseEnchantments(data: string | null | undefined): ItemEnchantment[] {
  const result = emptyEnchantments();
  if (data == null || data.length === 0) {
    return result;
  }
  const tokens = tokenizeSpace(data);
  if (tokens.length !== MAX_ENCHANTMENT_SLOT * MAX_ENCHANTMENT_OFFSET) {
    return result;
  }
  for (let slot = 0; slot < MAX_ENCHANTMENT_SLOT; slot++) {
    const base = slot * MAX_ENCHANTMENT_OFFSET;
    const id = Number.parseInt(tokens[base]!, 10);
    const duration = Number.parseInt(tokens[base + 1]!, 10);
    const charges = Number.parseInt(tokens[base + 2]!, 10);
    if (!Number.isFinite(id) || !Number.isFinite(duration) || !Number.isFinite(charges)) {
      return emptyEnchantments();
    }
    result[slot] = { id, duration, charges };
  }
  return result;
}

/** Serialize spell charges like Item::SaveToDB (trailing space). */
export function serializeCharges(charges: readonly number[]): string {
  let out = "";
  for (let i = 0; i < MAX_ITEM_PROTO_SPELLS; i++) {
    out += `${(charges[i] ?? 0) | 0} `;
  }
  return out;
}

/** Parse item_instance.charges; requires exactly MAX_ITEM_PROTO_SPELLS tokens. */
export function parseCharges(data: string | null | undefined): number[] {
  const result = emptyCharges();
  if (data == null || data.length === 0) {
    return result;
  }
  const tokens = tokenizeSpace(data);
  if (tokens.length !== MAX_ITEM_PROTO_SPELLS) {
    return result;
  }
  for (let i = 0; i < MAX_ITEM_PROTO_SPELLS; i++) {
    const value = Number.parseInt(tokens[i]!, 10);
    if (!Number.isFinite(value)) {
      return emptyCharges();
    }
    result[i] = value;
  }
  return result;
}

function lookupTemplate(
  world: WorldTables | null,
  entry: number,
): { MaxDurability: number; RandomProperty: number; RandomSuffix: number; charges: number[] } | null {
  const row = world?.first(item_template, "entry", entry);
  if (!row) {
    return null;
  }
  return {
    MaxDurability: row.MaxDurability >>> 0,
    RandomProperty: row.RandomProperty | 0,
    RandomSuffix: row.RandomSuffix >>> 0,
    charges: [
      row.spellcharges_1 | 0,
      row.spellcharges_2 | 0,
      row.spellcharges_3 | 0,
      row.spellcharges_4 | 0,
      row.spellcharges_5 | 0,
    ],
  };
}

/**
 * ItemEnchantmentMgr.cpp `GetItemEnchantMod`.
 * Rolls a weighted ench from `item_enchantment_template` for the given entry.
 */
export function getItemEnchantMod(world: WorldTables, entry: number): number {
  if (!entry || entry === -1) {
    return 0;
  }
  const rows = world
    .where(item_enchantment_template, "entry", entry)
    .filter((row) => row.chance > 0.000001 && row.chance <= 100.0);
  if (rows.length === 0) {
    return 0;
  }

  let dRoll = randChance();
  let fCount = 0;
  for (const row of rows) {
    fCount += row.chance;
    if (fCount > dRoll) {
      return row.ench >>> 0;
    }
  }

  // Sum of chances < 100%: second roll mirrors C++ integer division quirks.
  dRoll = Math.trunc(irand(0, Math.floor(fCount * 100) + 1) / 100);
  fCount = 0;
  for (const row of rows) {
    fCount += row.chance;
    if (fCount > dRoll) {
      return row.ench >>> 0;
    }
  }
  return 0;
}

/**
 * Item::GenerateItemRandomPropertyId without DBC validation.
 * Uses item_template.RandomProperty / RandomSuffix and item_enchantment_template.
 * Positive id = random property; negative = random suffix.
 */
export function GenerateRandomProperty(world: WorldTables, itemEntry: number): number {
  const proto = lookupTemplate(world, itemEntry);
  if (!proto) {
    return 0;
  }
  if (!proto.RandomProperty && !proto.RandomSuffix) {
    return 0;
  }
  if (proto.RandomProperty && proto.RandomSuffix) {
    return 0;
  }
  if (proto.RandomProperty) {
    return getItemEnchantMod(world, proto.RandomProperty) | 0;
  }
  const suffix = getItemEnchantMod(world, proto.RandomSuffix);
  return suffix ? -suffix : 0;
}

function markChanged(item: ItemInstance): void {
  if (item.uState !== ItemUpdateState.ITEM_NEW) {
    item.uState = ItemUpdateState.ITEM_CHANGED;
  }
}

export function SetState(item: ItemInstance, state: ItemUpdateStateId): void {
  if (item.uState === ItemUpdateState.ITEM_NEW && state === ItemUpdateState.ITEM_REMOVED) {
    item.uState = ItemUpdateState.ITEM_REMOVED;
    return;
  }
  if (state !== ItemUpdateState.ITEM_UNCHANGED) {
    if (item.uState !== ItemUpdateState.ITEM_NEW) {
      item.uState = state;
    }
  } else {
    item.uState = ItemUpdateState.ITEM_UNCHANGED;
  }
}

export function FSetState(item: ItemInstance, state: ItemUpdateStateId): void {
  item.uState = state;
}

export function SetEnchantment(
  item: ItemInstance,
  slot: number,
  id: number,
  duration: number,
  charges: number,
): void {
  if (slot < 0 || slot >= MAX_ENCHANTMENT_SLOT) {
    throw new Error(`SetEnchantment: slot ${slot} out of range`);
  }
  const current = item.enchantments[slot]!;
  if (current.id === id && current.duration === duration && current.charges === charges) {
    return;
  }
  item.enchantments[slot] = {
    id: id >>> 0,
    duration: duration >>> 0,
    charges: charges >>> 0,
  };
  markChanged(item);
}

export function ClearEnchantment(item: ItemInstance, slot: number): void {
  if (slot < 0 || slot >= MAX_ENCHANTMENT_SLOT) {
    throw new Error(`ClearEnchantment: slot ${slot} out of range`);
  }
  if (!item.enchantments[slot]!.id) {
    return;
  }
  item.enchantments[slot] = { id: 0, duration: 0, charges: 0 };
  markChanged(item);
}

export function GetEnchantmentId(item: ItemInstance, slot: number): number {
  return item.enchantments[slot]?.id ?? 0;
}

/**
 * Socket a gem: store the SpellItemEnchantment id in SOCK_ENCHANTMENT_SLOT + index.
 * C++ does not persist the gem item id on the item row (GemID lives on the DBC entry).
 */
export function SetGem(item: ItemInstance, socketIndex: number, enchantId: number): void {
  if (socketIndex < 0 || socketIndex >= MAX_GEM_SOCKETS) {
    throw new Error(`SetGem: socketIndex ${socketIndex} out of range`);
  }
  SetEnchantment(
    item,
    EnchantmentSlot.SOCK_ENCHANTMENT_SLOT + socketIndex,
    enchantId,
    0,
    0,
  );
}

/**
 * Clamp durability to [0, maxDurability]. Durability 0 with max &gt; 0 is broken.
 */
export function SetDurability(item: ItemInstance, durability: number, maxDurability?: number): void {
  if (maxDurability !== undefined) {
    item.maxDurability = maxDurability >>> 0;
  }
  let next = durability | 0;
  if (next < 0) {
    next = 0;
  }
  if (item.maxDurability > 0 && next > item.maxDurability) {
    next = item.maxDurability;
  }
  if (item.durability === next) {
    return;
  }
  item.durability = next;
  markChanged(item);
}

export function IsBroken(item: ItemInstance): boolean {
  return item.maxDurability > 0 && item.durability === 0;
}

export function SetSpellCharges(item: ItemInstance, index: number, value: number): void {
  if (index < 0 || index >= MAX_ITEM_PROTO_SPELLS) {
    throw new Error(`SetSpellCharges: index ${index} out of range`);
  }
  item.charges[index] = value | 0;
  markChanged(item);
}

/** `Item::Create` then `SaveToDB`: a new `item_instance` row with the next `HighGuid::Item` counter. */
export async function createItem(db: Db, world: WorldTables | null, opts: CreateItemOptions): Promise<ItemInstance> {
  const proto = lookupTemplate(world, opts.entry);
  const maxDurability = opts.maxDurability ?? proto?.MaxDurability ?? 0;
  let durability = opts.durability ?? maxDurability;
  if (durability < 0) {
    durability = 0;
  }
  if (maxDurability > 0 && durability > maxDurability) {
    durability = maxDurability;
  }

  const charges = emptyCharges();
  if (opts.charges) {
    for (let i = 0; i < MAX_ITEM_PROTO_SPELLS; i++) {
      charges[i] = (opts.charges[i] ?? 0) | 0;
    }
  } else if (proto) {
    for (let i = 0; i < MAX_ITEM_PROTO_SPELLS; i++) {
      charges[i] = proto.charges[i]!;
    }
  }

  const item: ItemInstance = {
    guid: objectGuids.item.generate(),
    itemEntry: opts.entry >>> 0,
    owner_guid: opts.owner >>> 0,
    creatorGuid: (opts.creatorGuid ?? 0) >>> 0,
    giftCreatorGuid: (opts.giftCreatorGuid ?? 0) >>> 0,
    count: opts.count === undefined ? 1 : opts.count >>> 0,
    duration: (opts.duration ?? 0) >>> 0,
    charges,
    flags: (opts.flags ?? 0) >>> 0,
    enchantments: emptyEnchantments(),
    randomPropertyId: opts.randomPropertyId ?? 0,
    durability,
    maxDurability: maxDurability >>> 0,
    playedTime: (opts.playedTime ?? 0) >>> 0,
    text: opts.text ?? null,
    uState: ItemUpdateState.ITEM_NEW,
  };

  await saveItem(db, item);
  return item;
}

export async function loadItem(db: Db, world: WorldTables | null, guid: number): Promise<ItemInstance | null> {
  const [row] = await db.select().from(item_instance).where(eq(item_instance.guid, guid));
  if (!row) {
    return null;
  }

  const proto = lookupTemplate(world, row.itemEntry ?? 0);
  const maxDurability = proto?.MaxDurability ?? 0;
  let durability = row.durability >>> 0;
  if (maxDurability > 0 && durability > maxDurability) {
    durability = maxDurability;
  }

  return {
    guid: row.guid >>> 0,
    itemEntry: (row.itemEntry ?? 0) >>> 0,
    owner_guid: row.owner_guid >>> 0,
    creatorGuid: row.creatorGuid >>> 0,
    giftCreatorGuid: row.giftCreatorGuid >>> 0,
    count: row.count >>> 0,
    duration: row.duration | 0,
    charges: parseCharges(row.charges),
    flags: (row.flags ?? 0) >>> 0,
    enchantments: parseEnchantments(row.enchantments),
    randomPropertyId: row.randomPropertyId | 0,
    durability,
    maxDurability,
    playedTime: row.playedTime >>> 0,
    text: row.text,
    uState: ItemUpdateState.ITEM_UNCHANGED,
  };
}

/** `Item::SaveToDB`: `REPLACE` for new and changed items, `DELETE` for removed ones. */
export async function saveItem(db: Db, item: ItemInstance): Promise<void> {
  const state = item.uState;
  switch (state) {
    case ItemUpdateState.ITEM_NEW:
    case ItemUpdateState.ITEM_CHANGED: {
      const row = {
        guid: item.guid,
        itemEntry: item.itemEntry,
        owner_guid: item.owner_guid,
        creatorGuid: item.creatorGuid,
        giftCreatorGuid: item.giftCreatorGuid,
        count: item.count,
        duration: item.duration,
        charges: serializeCharges(item.charges),
        flags: item.flags,
        enchantments: serializeEnchantments(item.enchantments),
        randomPropertyId: item.randomPropertyId,
        durability: item.durability,
        playedTime: item.playedTime,
        text: item.text,
      };
      await db.insert(item_instance).values(row).onDuplicateKeyUpdate({ set: row });
      item.uState = ItemUpdateState.ITEM_UNCHANGED;
      break;
    }
    case ItemUpdateState.ITEM_REMOVED: {
      await db.delete(item_instance).where(eq(item_instance.guid, item.guid));
      break;
    }
    case ItemUpdateState.ITEM_UNCHANGED:
      break;
    default: {
      const _exhaustive: never = state;
      throw new Error(`saveItem: unhandled state ${_exhaustive}`);
    }
  }
}

/**
 * Update-field pairs the create/values block needs for this instance.
 * Indexes match UpdateFields.h (OBJECT_END = 6).
 */
export function itemFieldValues(item: ItemInstance): ItemFieldValue[] {
  const fields: ItemFieldValue[] = [
    { index: OBJECT_FIELD_ENTRY, value: item.itemEntry },
    { index: ITEM_FIELD_STACK_COUNT, value: item.count },
    { index: ITEM_FIELD_FLAGS, value: item.flags },
    { index: ITEM_FIELD_DURATION, value: item.duration },
    { index: ITEM_FIELD_PROPERTY_SEED, value: item.propertySeed ?? 0 },
    { index: ITEM_FIELD_RANDOM_PROPERTIES_ID, value: item.randomPropertyId },
    { index: ITEM_FIELD_DURABILITY, value: item.durability },
    { index: ITEM_FIELD_MAXDURABILITY, value: item.maxDurability },
    { index: ITEM_FIELD_CREATE_PLAYED_TIME, value: item.playedTime },
  ];
  for (let i = 0; i < MAX_ITEM_PROTO_SPELLS; i++) {
    fields.push({ index: ITEM_FIELD_SPELL_CHARGES + i, value: item.charges[i]! });
  }
  for (let slot = 0; slot < MAX_ENCHANTMENT_SLOT; slot++) {
    const e = item.enchantments[slot]!;
    const base = ITEM_FIELD_ENCHANTMENT_1_1 + slot * MAX_ENCHANTMENT_OFFSET;
    fields.push({ index: base + ENCHANTMENT_ID_OFFSET, value: e.id });
    fields.push({ index: base + ENCHANTMENT_DURATION_OFFSET, value: e.duration });
    fields.push({ index: base + ENCHANTMENT_CHARGES_OFFSET, value: e.charges });
  }
  return fields;
}

/** SMSG_UPDATE_OBJECT values block for an item guid (UPDATETYPE_VALUES = 0). */
export function writeItemUpdate(guid: number, fields: readonly ItemFieldValue[]): Uint8Array {
  const values = new Uint32Array(ITEM_END);
  const force = new Set<number>();
  for (const field of fields) {
    if (field.index < 0 || field.index >= values.length) {
      continue;
    }
    values[field.index] = field.value >>> 0;
    force.add(field.index);
  }
  const body = new ByteWriter().writeU32(1).writeU8(0).writeBytes(packedGuid(BigInt(guid)));
  const blocks = Math.ceil(values.length / 32);
  body.writeU8(blocks);
  const present: number[] = [];
  for (let block = 0; block < blocks; block++) {
    let mask = 0;
    for (let bit = 0; bit < 32; bit++) {
      const index = block * 32 + bit;
      if (index < values.length && (values[index] !== 0 || force.has(index))) {
        mask |= 1 << bit;
        present.push(index);
      }
    }
    body.writeU32(mask >>> 0);
  }
  for (const index of present) {
    body.writeU32(values[index]!);
  }
  return body.toUint8Array();
}
