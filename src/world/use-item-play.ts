/**
 * Session-ready `CMSG_USE_ITEM` handler.
 *
 * Pure charge / cooldown resolution lives in `src/items/use-item.ts`.
 * This module wires inventory + `item_instance` / `item_template` SQL and
 * tracks per-player spell/category cooldowns for the parent session.
 */

import { eq } from "drizzle-orm";
import { executeAsync, type Db } from "../database/database.ts";
import { item_instance } from "../database/schema/characters.ts";
import { item_template } from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { ByteReader } from "../net/byte-buffer.ts";
import { readTargets, type CastTargets } from "../spells/packets.ts";
import type { SpellStore } from "../spells/spell-info.ts";
import {
  getItem,
  resolveStorageBag,
  type Inventory,
} from "../items/bags.ts";
import { itemGuidRaw } from "../items/equipment-sets.ts";
import {
  buildInventoryChangeFailure,
  CMSG_USE_ITEM,
  EQUIP_ERR_CANT_DO_RIGHT_NOW,
  EQUIP_ERR_ITEM_NOT_FOUND,
  formatChargesString,
  ITEM_SPELLTRIGGER_ON_USE,
  lookupSpellRecovery,
  MAX_ITEM_PROTO_SPELLS,
  parseChargesString,
  parseUseItem,
  SMSG_INVENTORY_CHANGE_FAILURE,
  useItem,
  type ItemSpellSlot,
  type SpellRecovery,
  type UseItemPacket,
} from "../items/use-item.ts";

export type PlayPacket = { opcode: number; name: string; body: Uint8Array };
export type ItemCast = {
  spellId: number;
  castCount: number;
  targets: CastTargets;
  itemGuid: number;
  itemEntry: number;
  cooldownMs: number;
  category: number;
  categoryCooldownMs: number;
  commit: (nowMs: number) => PlayPacket[];
};
export type UsePlayResult = { packets: PlayPacket[]; cast?: ItemCast } | null;

export const USE_ITEM_OPCODES: ReadonlySet<number> = new Set([CMSG_USE_ITEM]);

type UseOpcode = typeof CMSG_USE_ITEM;

/** Opaque per-session cooldown clock; create once via `createUseCooldowns`. */
export type UseCooldowns = {
  readonly spellExpiry: Map<number, number>;
  readonly categoryExpiry: Map<number, number>;
};

export function createUseCooldowns(): UseCooldowns {
  return {
    spellExpiry: new Map(),
    categoryExpiry: new Map(),
  };
}

export type UsePlayCtx = {
  db: Db;
  world: WorldTables | null;
  playerGuid: number;
  nowMs: number;
  inventory: Inventory;
  /**
   * spellId → recovery. Parent passes this from Spell.dbc when loaded;
   * tests pass a Map.
   */
  spellRecovery: ReadonlyMap<
    number,
    { recoveryTime: number; categoryRecoveryTime: number; category: number }
  >;
  spellStore?: SpellStore | null;
  cooldowns: UseCooldowns;
  /** The spell engine commits charges and cooldown only after the cast succeeds. */
  deferCast?: boolean;
};

type TemplateUseData = {
  spells: ItemSpellSlot[];
  stackable: number;
  templateCharges: number[];
};

function inventoryFailure(itemGuid: bigint = 0n): PlayPacket {
  return {
    opcode: SMSG_INVENTORY_CHANGE_FAILURE,
    name: "SMSG_INVENTORY_CHANGE_FAILURE",
    body: buildInventoryChangeFailure(EQUIP_ERR_ITEM_NOT_FOUND, itemGuid),
  };
}

function cooldownFailure(itemGuid: bigint): PlayPacket {
  return {
    opcode: SMSG_INVENTORY_CHANGE_FAILURE,
    name: "SMSG_INVENTORY_CHANGE_FAILURE",
    body: buildInventoryChangeFailure(EQUIP_ERR_CANT_DO_RIGHT_NOW, itemGuid),
  };
}

function toPlayPackets(packets: readonly UseItemPacket[]): PlayPacket[] {
  return packets.map((packet) => ({
    opcode: packet.opcode,
    name: packet.name,
    body: packet.body,
  }));
}

function loadTemplateUseData(world: WorldTables | null, entry: number): TemplateUseData | null {
  const found = world?.first(item_template, "entry", entry);
  if (!found) {
    return null;
  }
  const row = found as unknown as Record<string, number>;

  const spells: ItemSpellSlot[] = [];
  const templateCharges: number[] = [];
  for (let i = 1; i <= MAX_ITEM_PROTO_SPELLS; i += 1) {
    spells.push({
      spellId: (row[`spellid_${i}`] ?? 0) | 0,
      spellTrigger: (row[`spelltrigger_${i}`] ?? 0) | 0,
      spellCharges: (row[`spellcharges_${i}`] ?? 0) | 0,
      spellCooldown: (row[`spellcooldown_${i}`] ?? 0) | 0,
      spellCategory: (row[`spellcategory_${i}`] ?? 0) | 0,
      spellCategoryCooldown: (row[`spellcategorycooldown_${i}`] ?? 0) | 0,
    });
    templateCharges.push((row[`spellcharges_${i}`] ?? 0) | 0);
  }

  return {
    spells,
    stackable: (found.stackable ?? 1) | 0,
    templateCharges,
  };
}

async function loadInstanceCharges(db: Db, itemGuid: number): Promise<number[] | null> {
  const [row] = await db.select({ charges: item_instance.charges }).from(item_instance).where(eq(item_instance.guid, itemGuid >>> 0));
  if (!row) {
    return null;
  }
  return parseChargesString(row.charges ?? "");
}

function persistCharges(db: Db, itemGuid: number, charges: readonly number[]): void {
  executeAsync(
    db.update(item_instance).set({ charges: formatChargesString(charges) }).where(eq(item_instance.guid, itemGuid >>> 0)),
    `item_instance charges of ${itemGuid}`,
  );
}

function deleteInstance(db: Db, itemGuid: number): void {
  executeAsync(db.delete(item_instance).where(eq(item_instance.guid, itemGuid >>> 0)), `delete item_instance ${itemGuid}`);
}

function removeInventoryItem(inv: Inventory, storageBag: number, slot: number, itemGuid: number): void {
  const bag = inv.slots.get(storageBag);
  if (bag) {
    bag.delete(slot);
  }
  inv.byGuid.delete(itemGuid);
}

function isCoolingDown(
  cooldowns: UseCooldowns,
  spellId: number,
  category: number,
  nowMs: number,
): boolean {
  const spellExpiry = cooldowns.spellExpiry.get(spellId);
  if (spellExpiry !== undefined && spellExpiry > nowMs) {
    return true;
  }
  if (category !== 0) {
    const catExpiry = cooldowns.categoryExpiry.get(category);
    if (catExpiry !== undefined && catExpiry > nowMs) {
      return true;
    }
  }
  return false;
}

function recordCooldowns(
  cooldowns: UseCooldowns,
  spellId: number,
  category: number,
  cooldownMs: number,
  categoryCooldownMs: number,
  nowMs: number,
): void {
  if (cooldownMs > 0) {
    cooldowns.spellExpiry.set(spellId, nowMs + cooldownMs);
  }
  if (category !== 0 && categoryCooldownMs > 0) {
    cooldowns.categoryExpiry.set(category, nowMs + categoryCooldownMs);
  }
}

function itemGuidMatches(stored: number, packetGuid: bigint): boolean {
  if (packetGuid === 0n) {
    return true;
  }
  return Number(packetGuid & 0xffffffffn) === (stored >>> 0);
}

async function handleUseItemOpcode(payload: Uint8Array, ctx: UsePlayCtx): Promise<UsePlayResult> {
  const parsed = parseUseItem(payload);
  const storageBag = resolveStorageBag(ctx.inventory, parsed.bag);
  if (storageBag === null) {
    return { packets: [inventoryFailure()] };
  }

  const invItem = getItem(ctx.inventory, storageBag, parsed.slot);
  if (!invItem) {
    return { packets: [inventoryFailure()] };
  }

  if (!itemGuidMatches(invItem.guid, parsed.itemGuid)) {
    return { packets: [inventoryFailure()] };
  }

  const template = loadTemplateUseData(ctx.world, invItem.entry);
  if (!template) {
    return { packets: [inventoryFailure(itemGuidRaw(invItem.guid))] };
  }

  const instanceCharges = await loadInstanceCharges(ctx.db, invItem.guid);
  const charges = instanceCharges ?? template.templateCharges;

  // Probe recovery for the spell the client named, or the first ON_USE slot.
  let recoverySpellId = parsed.spellId;
  if (recoverySpellId === 0) {
    const first = template.spells.find(
      (spell) => spell.spellId !== 0 && spell.spellTrigger === ITEM_SPELLTRIGGER_ON_USE,
    );
    recoverySpellId = first?.spellId ?? 0;
  }
  const spellRecovery: SpellRecovery | null =
    recoverySpellId !== 0
      ? lookupSpellRecovery(ctx.spellRecovery, recoverySpellId) ?? (() => {
        const info = ctx.spellStore?.get(recoverySpellId);
        return info ? { recoveryTime: info.recoveryTime, categoryRecoveryTime: info.categoryRecoveryTime, category: info.category } : null;
      })()
      : null;

  const result = useItem({
    item: {
      guid: itemGuidRaw(invItem.guid),
      charges,
      spells: template.spells,
      stackable: template.stackable,
    },
    spellId: parsed.spellId,
    playerGuid: BigInt(ctx.playerGuid >>> 0),
    spellRecovery,
  });

  if (!result.ok) {
    return { packets: toPlayPackets(result.packets) };
  }

  if (isCoolingDown(ctx.cooldowns, result.spellId, result.category, ctx.nowMs)) {
    return { packets: [cooldownFailure(itemGuidRaw(invItem.guid))] };
  }

  const commit = (nowMs: number): PlayPacket[] => {
    recordCooldowns(ctx.cooldowns, result.spellId, result.category, result.cooldownMs, result.categoryCooldownMs, nowMs);
    if (result.charges && result.consumeCharge && template.stackable === 1) {
      persistCharges(ctx.db, invItem.guid, result.charges);
    }
    if (result.destroy) {
      removeInventoryItem(ctx.inventory, storageBag, parsed.slot, invItem.guid);
      deleteInstance(ctx.db, invItem.guid);
    }
    return toPlayPackets(result.packets);
  };

  if (ctx.deferCast) {
    let targets: CastTargets;
    try {
      targets = readTargets(new ByteReader(parsed.targetData));
    } catch {
      return { packets: [inventoryFailure(itemGuidRaw(invItem.guid))] };
    }
    return {
      packets: [],
      cast: {
        spellId: result.spellId, castCount: parsed.castCount, targets,
        itemGuid: invItem.guid, itemEntry: invItem.entry, cooldownMs: result.cooldownMs,
        category: result.category, categoryCooldownMs: result.categoryCooldownMs, commit,
      },
    };
  }

  return { packets: commit(ctx.nowMs) };
}

/**
 * Dispatch `CMSG_USE_ITEM`. Returns `null` when the opcode is not owned here.
 *
 * Session integration (parent wires `session.ts`):
 * ```ts
 * const useCooldowns = createUseCooldowns();
 * // spellRecovery from loadSpellRecoveryMap(Spell.dbc) or empty Map
 * case 0x0ab: {
 *   const result = handleUseItem(opcode, payload, {
 *     db, world, playerGuid, nowMs: Date.now(), inventory, spellRecovery, cooldowns: useCooldowns,
 *   });
 *   if (result) { for (const p of result.packets) send(p.opcode, p.body); return; }
 * }
 * ```
 */
export async function handleUseItem(
  opcode: number,
  payload: Uint8Array,
  ctx: UsePlayCtx,
): Promise<UsePlayResult> {
  if (!USE_ITEM_OPCODES.has(opcode)) {
    return null;
  }
  const useOpcode = opcode as UseOpcode;
  switch (useOpcode) {
    case CMSG_USE_ITEM:
      return handleUseItemOpcode(payload, ctx);
    default: {
      const _exhaustive: never = useOpcode;
      return _exhaustive;
    }
  }
}
