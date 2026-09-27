import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import { parseWdbc, type DbcRecord } from "../data/dbc.ts";

/** `Opcodes.h` / `Opcodes.cpp` build 12340. */
export const CMSG_USE_ITEM = 0x0ab;
export const SMSG_ITEM_COOLDOWN = 0x0b0;
export const SMSG_INVENTORY_CHANGE_FAILURE = 0x112;
export const SMSG_SPELL_COOLDOWN = 0x134;

/** `InventoryResult` — `Item.h`. Bad bag/slot → `EQUIP_ERR_ITEM_NOT_FOUND`. */
export const EQUIP_ERR_OK = 0;
export const EQUIP_ERR_ITEM_NOT_FOUND = 23;
/** On spell/item cooldown — unlocks the client grayed item without casting. */
export const EQUIP_ERR_CANT_DO_RIGHT_NOW = 39;

/** `MAX_ITEM_PROTO_SPELLS` — `ItemTemplate.h`. */
export const MAX_ITEM_PROTO_SPELLS = 5;

/** `ITEM_SPELLTRIGGER_ON_USE` — cast when the item is used. */
export const ITEM_SPELLTRIGGER_ON_USE = 0;

/** `SpellCooldownFlags` — `Unit.h`. */
export const SPELL_COOLDOWN_FLAG_NONE = 0x0;
export const SPELL_COOLDOWN_FLAG_INCLUDE_GCD = 0x1;

/**
 * Same format string as `SpellEntryfmt` / `src/data/dbc.ts` `SPELL_FMT`.
 * Field 29 = RecoveryTime, field 30 = CategoryRecoveryTime (`DBCStructure.h`).
 */
export const SPELL_DBC_FMT =
  "niiiiiiiiiiiixixiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiifxiiiiiiiiiiiiiiiiiiiiiiiiiiiifffiiiiiiiiiiiiiiiiiiiiifffiiiiiiiiiiiiiiifffiiiiiiiiiiiiiissssssssssssssssxssssssssssssssssxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxiiiiiiiiiiixfffxxxiiiiixxfffxx";

/** One of the five `_Spell` slots on `ItemTemplate`. */
export type ItemSpellSlot = {
  spellId: number;
  spellTrigger: number;
  spellCharges: number;
  spellCooldown: number;
  spellCategory: number;
  spellCategoryCooldown: number;
};

/** Spell.dbc recovery fields used when the item template cooldown is `-1`. */
export type SpellRecovery = {
  recoveryTime: number;
  categoryRecoveryTime: number;
  /** Spell.dbc `Category` (field 1). */
  category: number;
};

export type UseItemParsed = {
  bag: number;
  slot: number;
  castCount: number;
  spellId: number;
  itemGuid: bigint;
  glyphIndex: number;
  castFlags: number;
  /** Remaining bytes (`SpellCastTargets::Read` + cast flags payload). */
  targetData: Uint8Array;
};

export type UseItemPacketName =
  | "SMSG_SPELL_COOLDOWN"
  | "SMSG_ITEM_COOLDOWN"
  | "SMSG_INVENTORY_CHANGE_FAILURE";

export type UseItemPacket = {
  opcode: number;
  name: UseItemPacketName;
  body: Uint8Array;
};

/**
 * Result of resolving a use without casting the spell.
 * Charge destroy follows `Spell::TakeCastItemCharges` (template charges `< 0` and count hits 0).
 */
export type UseItemResult = {
  ok: boolean;
  error: number;
  spellId: number;
  cooldownMs: number;
  category: number;
  categoryCooldownMs: number;
  consumeCharge: boolean;
  destroy: boolean;
  /** Updated five-slot charge array when `ok` and charges were touched. */
  charges: number[] | null;
  packets: UseItemPacket[];
};

export type UseItemInput = {
  /** Item at bag/slot, or `null` when missing (`EQUIP_ERR_ITEM_NOT_FOUND`). */
  item: {
    guid: bigint;
    /** Instance charges string (`item_instance.charges`) or five ints. */
    charges: string | readonly number[];
    /** Template spell slots (up to 5). */
    spells: readonly ItemSpellSlot[];
    /** `item_template.stackable`; charges are written back only when `=== 1`. */
    stackable?: number;
  } | null;
  /** Spell id from `CMSG_USE_ITEM`; if omitted, first `ON_USE` slot is used. */
  spellId?: number;
  /** Guid of the casting player — `SMSG_SPELL_COOLDOWN` caster field. */
  playerGuid: bigint;
  /**
   * Spell.dbc recovery for the cast spell. Required when template `spellCooldown`
   * (and/or category cooldown) is `-1` and you want the DBC times.
   */
  spellRecovery?: SpellRecovery | null;
};

function valueFieldCount(format: string): number {
  let count = 0;
  for (const char of format) {
    if (char !== "x" && char !== "X") {
      count += 1;
    }
  }
  return count;
}

/**
 * Field names for `parseWdbc` so RecoveryTime / CategoryRecoveryTime are readable
 * without editing `src/data/dbc.ts` (that loader only names Id / Attributes / SpellName).
 */
export function spellRecoveryFieldNames(): string[] {
  const fields = Array.from({ length: valueFieldCount(SPELL_DBC_FMT) }, () => "");
  fields[0] = "Id";
  fields[1] = "Category";
  // Format positions 29 / 30 → value indices 27 / 28 (two `x` skips before them).
  fields[27] = "RecoveryTime";
  fields[28] = "CategoryRecoveryTime";
  return fields;
}

export function spellRecoveryFromRecord(record: DbcRecord): SpellRecovery | null {
  const recoveryTime = record.RecoveryTime;
  const categoryRecoveryTime = record.CategoryRecoveryTime;
  const category = record.Category;
  if (
    typeof recoveryTime !== "number" ||
    typeof categoryRecoveryTime !== "number" ||
    typeof category !== "number"
  ) {
    return null;
  }
  return {
    recoveryTime: recoveryTime >>> 0,
    categoryRecoveryTime: categoryRecoveryTime >>> 0,
    category: category >>> 0,
  };
}

/** Parse a full `Spell.dbc` buffer into Id → recovery map (does not need `loadDbcStores`). */
export function loadSpellRecoveryMap(dbcBytes: Uint8Array): Map<number, SpellRecovery> {
  const rows = parseWdbc(dbcBytes, SPELL_DBC_FMT, spellRecoveryFieldNames());
  const map = new Map<number, SpellRecovery>();
  for (const row of rows) {
    const id = row.Id;
    if (typeof id !== "number") {
      continue;
    }
    const recovery = spellRecoveryFromRecord(row);
    if (recovery) {
      map.set(id, recovery);
    }
  }
  return map;
}

export function lookupSpellRecovery(
  map: ReadonlyMap<number, SpellRecovery>,
  spellId: number,
): SpellRecovery | null {
  return map.get(spellId) ?? null;
}

/**
 * `CMSG_USE_ITEM` body — `WorldSession::HandleUseItemOpcode`:
 * `bagIndex, slot, castCount, spellId, itemGUID, glyphIndex, castFlags` then targets.
 */
export function parseUseItem(payload: Uint8Array): UseItemParsed {
  const reader = new ByteReader(payload);
  const bag = reader.readU8();
  const slot = reader.readU8();
  const castCount = reader.readU8();
  const spellId = reader.readU32();
  const itemGuid = reader.readU64();
  const glyphIndex = reader.readU32();
  const castFlags = reader.readU8();
  const remaining = reader.remaining;
  const targetData = remaining > 0 ? reader.readBytes(remaining) : new Uint8Array(0);
  return {
    bag,
    slot,
    castCount,
    spellId,
    itemGuid,
    glyphIndex,
    castFlags,
    targetData,
  };
}

export function parseChargesString(charges: string): number[] {
  const parts = charges.trim().length === 0 ? [] : charges.trim().split(/\s+/);
  const out: number[] = [];
  for (let i = 0; i < MAX_ITEM_PROTO_SPELLS; i += 1) {
    const raw = parts[i];
    out.push(raw === undefined || raw === "" ? 0 : Number.parseInt(raw, 10) || 0);
  }
  return out;
}

export function formatChargesString(charges: readonly number[]): string {
  const slots: number[] = [];
  for (let i = 0; i < MAX_ITEM_PROTO_SPELLS; i += 1) {
    slots.push(charges[i] ?? 0);
  }
  return `${slots.join(" ")} `;
}

/**
 * Cooldown resolution for an item spell slot.
 *
 * Topic rule: template `SpellCooldown === -1` → use spell RecoveryTime;
 * `=== 0` → no cooldown; `> 0` → that many ms.
 *
 * Category cooldown follows the same `-1` / `0` / positive rule with
 * `CategoryRecoveryTime`. When both template cooldowns are `< 0`, category id
 * also falls back to the spell (`Player::AddSpellAndCategoryCooldowns`).
 */
export function resolveItemCooldown(
  spell: ItemSpellSlot,
  spellRecovery?: SpellRecovery | null,
): { cooldownMs: number; category: number; categoryCooldownMs: number } {
  let category = spell.spellCategory >>> 0;
  let rec = spell.spellCooldown;
  let catrec = spell.spellCategoryCooldown;

  if (rec < 0 && catrec < 0 && spellRecovery) {
    category = spellRecovery.category >>> 0;
    rec = spellRecovery.recoveryTime;
    catrec = spellRecovery.categoryRecoveryTime;
  } else {
    if (rec === -1) {
      rec = spellRecovery?.recoveryTime ?? 0;
    } else if (rec < 0) {
      rec = 0;
    }
    if (catrec === -1) {
      catrec = spellRecovery?.categoryRecoveryTime ?? 0;
    } else if (catrec < 0) {
      catrec = 0;
    }
  }

  if (rec < 0) {
    rec = 0;
  }
  if (catrec < 0) {
    catrec = 0;
  }

  return {
    cooldownMs: rec,
    category,
    categoryCooldownMs: catrec,
  };
}

/**
 * `Unit::BuildCooldownPacket` — `SMSG_SPELL_COOLDOWN`:
 * guid, flags, (spellId, cooldownMs)* .
 *
 * Item casts store cooldowns via `AddSpellAndCategoryCooldowns` (not
 * `SMSG_ITEM_COOLDOWN`; that opcode is the 30s equip proc path).
 */
export function buildSpellCooldownPacket(
  casterGuid: bigint,
  spellId: number,
  cooldownMs: number,
  flags: number = SPELL_COOLDOWN_FLAG_NONE,
): Uint8Array {
  return new ByteWriter()
    .writeU64(casterGuid)
    .writeU8(flags & 0xff)
    .writeU32(spellId >>> 0)
    .writeU32(cooldownMs >>> 0)
    .toUint8Array();
}

/** `SMSG_ITEM_COOLDOWN` — item guid + spell id (equip cooldown path). */
export function buildItemCooldownPacket(itemGuid: bigint, spellId: number): Uint8Array {
  return new ByteWriter().writeU64(itemGuid).writeU32(spellId >>> 0).toUint8Array();
}

/** `Player::SendEquipError` for a plain inventory failure (no level/category extras). */
export function buildInventoryChangeFailure(
  result: number,
  itemGuid: bigint = 0n,
  item2Guid: bigint = 0n,
): Uint8Array {
  const writer = new ByteWriter().writeU8(result & 0xff);
  if (result !== EQUIP_ERR_OK) {
    writer.writeU64(itemGuid).writeU64(item2Guid).writeU8(0);
  }
  return writer.toUint8Array();
}

/**
 * Match an `ITEM_SPELLTRIGGER_ON_USE` slot — `Player::CastItemUseSpell` skips
 * every other trigger type.
 */
export function findOnUseSpellSlot(
  spells: readonly ItemSpellSlot[],
  spellId: number | undefined,
): { index: number; spell: ItemSpellSlot } | null {
  if (spellId !== undefined && spellId !== 0) {
    for (let i = 0; i < spells.length && i < MAX_ITEM_PROTO_SPELLS; i += 1) {
      const spell = spells[i];
      if (
        spell &&
        spell.spellId === spellId &&
        spell.spellTrigger === ITEM_SPELLTRIGGER_ON_USE
      ) {
        return { index: i, spell };
      }
    }
    return null;
  }
  for (let i = 0; i < spells.length && i < MAX_ITEM_PROTO_SPELLS; i += 1) {
    const spell = spells[i];
    if (
      spell &&
      spell.spellId !== 0 &&
      spell.spellTrigger === ITEM_SPELLTRIGGER_ON_USE
    ) {
      return { index: i, spell };
    }
  }
  return null;
}

/**
 * Apply `Spell::TakeCastItemCharges` for the matched spell slot.
 * Template `SpellCharges === 0` → unlimited (no consume).
 * Template `SpellCharges < 0` → expendable; destroy when instance charges hit 0.
 * Template `SpellCharges > 0` → limited; item kept at 0 charges.
 */
export function applySpellCharges(
  templateCharges: number,
  instanceCharges: number,
  stackable: number,
): { consumeCharge: boolean; destroy: boolean; newCharges: number; writeCharges: boolean } {
  if (templateCharges === 0) {
    return {
      consumeCharge: false,
      destroy: false,
      newCharges: instanceCharges,
      writeCharges: false,
    };
  }

  const expendable = templateCharges < 0;
  let charges = instanceCharges;
  let consumeCharge = false;

  if (charges !== 0) {
    charges = charges > 0 ? charges - 1 : charges + 1;
    consumeCharge = true;
  }

  const withoutCharges = charges === 0;
  const destroy = expendable && withoutCharges;
  const writeCharges = consumeCharge && stackable === 1;

  return { consumeCharge, destroy, newCharges: charges, writeCharges };
}

/**
 * Resolve a `CMSG_USE_ITEM` into cooldown / charge side effects.
 * Does not cast the spell (`CastItemUseSpell` / spell effects stay unchecked).
 */
export function useItem(input: UseItemInput): UseItemResult {
  const empty = (error: number, packets: UseItemPacket[]): UseItemResult => ({
    ok: false,
    error,
    spellId: 0,
    cooldownMs: 0,
    category: 0,
    categoryCooldownMs: 0,
    consumeCharge: false,
    destroy: false,
    charges: null,
    packets,
  });

  if (!input.item) {
    return empty(EQUIP_ERR_ITEM_NOT_FOUND, [
      {
        opcode: SMSG_INVENTORY_CHANGE_FAILURE,
        name: "SMSG_INVENTORY_CHANGE_FAILURE",
        body: buildInventoryChangeFailure(EQUIP_ERR_ITEM_NOT_FOUND),
      },
    ]);
  }

  const matched = findOnUseSpellSlot(input.item.spells, input.spellId);
  if (!matched) {
    return empty(EQUIP_ERR_ITEM_NOT_FOUND, [
      {
        opcode: SMSG_INVENTORY_CHANGE_FAILURE,
        name: "SMSG_INVENTORY_CHANGE_FAILURE",
        body: buildInventoryChangeFailure(EQUIP_ERR_ITEM_NOT_FOUND, input.item.guid),
      },
    ]);
  }

  const { index, spell } = matched;
  const resolved = resolveItemCooldown(spell, input.spellRecovery ?? null);
  const instanceCharges =
    typeof input.item.charges === "string"
      ? parseChargesString(input.item.charges)
      : (() => {
          const out: number[] = [];
          for (let i = 0; i < MAX_ITEM_PROTO_SPELLS; i += 1) {
            out.push(input.item!.charges[i] ?? 0);
          }
          return out;
        })();

  const stackable = input.item.stackable ?? 1;
  const chargeResult = applySpellCharges(
    spell.spellCharges,
    instanceCharges[index] ?? 0,
    stackable,
  );

  const nextCharges = instanceCharges.slice();
  if (chargeResult.writeCharges) {
    nextCharges[index] = chargeResult.newCharges;
  }

  const packets: UseItemPacket[] = [];
  // Cast path uses spell cooldowns (`AddSpellAndCategoryCooldowns` /
  // `BuildCooldownPacket`), not `SMSG_ITEM_COOLDOWN`.
  if (resolved.cooldownMs > 0 || resolved.categoryCooldownMs > 0) {
    const cooldownMs =
      resolved.cooldownMs > 0 ? resolved.cooldownMs : resolved.categoryCooldownMs;
    packets.push({
      opcode: SMSG_SPELL_COOLDOWN,
      name: "SMSG_SPELL_COOLDOWN",
      body: buildSpellCooldownPacket(input.playerGuid, spell.spellId, cooldownMs),
    });
  }

  return {
    ok: true,
    error: EQUIP_ERR_OK,
    spellId: spell.spellId,
    cooldownMs: resolved.cooldownMs,
    category: resolved.category,
    categoryCooldownMs: resolved.categoryCooldownMs,
    consumeCharge: chargeResult.consumeCharge,
    destroy: chargeResult.destroy,
    charges: chargeResult.consumeCharge || chargeResult.destroy ? nextCharges : instanceCharges,
    packets,
  };
}

/**
 * Session hook for `CMSG_USE_ITEM`: parse the payload, resolve the bag/slot item
 * via `getItem(bag, slot)`, then call `useItem`. Parent wires:
 *
 * ```ts
 * case CMSG_USE_ITEM: {
 *   const parsed = parseUseItem(payload);
 *   const item = inventory.get(parsed.bag, parsed.slot); // null if missing
 *   const result = useItem({
 *     item: item
 *       ? {
 *           guid: item.guid,
 *           charges: item.charges,
 *           spells: item.template.spells,
 *           stackable: item.template.stackable,
 *         }
 *       : null,
 *     spellId: parsed.spellId,
 *     playerGuid: player.guid,
 *     spellRecovery: lookupSpellRecovery(spellRecoveryMap, parsed.spellId),
 *   });
 *   for (const packet of result.packets) session.send(packet.opcode, packet.body);
 *   // then cast result.spellId when spell casting exists; apply charges/destroy
 *   break;
 * }
 * ```
 */
export function handleUseItemPayload(
  payload: Uint8Array,
  args: {
    getItem: (
      bag: number,
      slot: number,
    ) => UseItemInput["item"];
    playerGuid: bigint;
    spellRecoveryFor: (spellId: number) => SpellRecovery | null;
  },
): { parsed: UseItemParsed; result: UseItemResult } {
  const parsed = parseUseItem(payload);
  const item = args.getItem(parsed.bag, parsed.slot);
  if (item && parsed.itemGuid !== 0n && item.guid !== parsed.itemGuid) {
    return {
      parsed,
      result: {
        ok: false,
        error: EQUIP_ERR_ITEM_NOT_FOUND,
        spellId: 0,
        cooldownMs: 0,
        category: 0,
        categoryCooldownMs: 0,
        consumeCharge: false,
        destroy: false,
        charges: null,
        packets: [
          {
            opcode: SMSG_INVENTORY_CHANGE_FAILURE,
            name: "SMSG_INVENTORY_CHANGE_FAILURE",
            body: buildInventoryChangeFailure(EQUIP_ERR_ITEM_NOT_FOUND),
          },
        ],
      },
    };
  }
  const result = useItem({
    item,
    spellId: parsed.spellId,
    playerGuid: args.playerGuid,
    spellRecovery: args.spellRecoveryFor(parsed.spellId),
  });
  return { parsed, result };
}
