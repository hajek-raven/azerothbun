import { eq } from "drizzle-orm";
import { testDatabase } from "../database/test-db.ts";
import { item_instance } from "../database/schema/characters.ts";
import { item_template } from "../database/schema/world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { describe, expect, test } from "bun:test";
import {
  createInventory,
  INVENTORY_SLOT_BAG_0,
  INVENTORY_SLOT_ITEM_START,
  storeItem,
  type ItemTemplateSlice,
} from "../items/bags.ts";
import { itemGuidRaw } from "../items/equipment-sets.ts";
import {
  CMSG_USE_ITEM,
  EQUIP_ERR_CANT_DO_RIGHT_NOW,
  EQUIP_ERR_ITEM_NOT_FOUND,
  formatChargesString,
  SMSG_INVENTORY_CHANGE_FAILURE,
  SMSG_SPELL_COOLDOWN,
  SPELL_COOLDOWN_FLAG_NONE,
} from "../items/use-item.ts";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import {
  createUseCooldowns,
  handleUseItem,
  USE_ITEM_OPCODES,
  type UsePlayCtx,
} from "./use-item-play.ts";

const SPELL_ID = 439;
const ITEM_ENTRY = 118; // Minor Healing Potion-shaped test entry
const ITEM_GUID = 42;
const PLAYER_GUID = 7;

function bagTemplate(): ItemTemplateSlice {
  return {
    entry: ITEM_ENTRY,
    InventoryType: 0,
    ContainerSlots: 0,
    BagFamily: 0,
    class: 0,
    subclass: 0,
    bonding: 0,
  };
}

type TestDb = Awaited<ReturnType<typeof testDatabase>>;

function ensureWorldTemplate(
  world: WorldTables,
  opts: {
    spellCooldown?: number;
    spellCharges?: number;
    spellCategoryCooldown?: number;
    stackable?: number;
  } = {},
): void {
  world.insert(item_template, [
    {
      entry: ITEM_ENTRY,
      stackable: opts.stackable ?? 1,
      spellid_1: SPELL_ID,
      spelltrigger_1: 0,
      spellcharges_1: opts.spellCharges ?? 5,
      spellcooldown_1: opts.spellCooldown ?? -1,
      spellcategory_1: 0,
      spellcategorycooldown_1: opts.spellCategoryCooldown ?? -1,
    },
  ]);
}

async function ensureItemInstance(db: TestDb, charges: string): Promise<void> {
  await db.insert(item_instance).values({ guid: ITEM_GUID, itemEntry: ITEM_ENTRY, owner_guid: PLAYER_GUID, charges, enchantments: "" });
}

async function storedCharges(db: TestDb): Promise<string> {
  const [row] = await db.select({ charges: item_instance.charges }).from(item_instance).where(eq(item_instance.guid, ITEM_GUID));
  return row?.charges ?? "";
}

function buildUsePayload(opts: {
  bag?: number;
  slot?: number;
  spellId?: number;
  itemGuid?: bigint;
} = {}): Uint8Array {
  return new ByteWriter()
    .writeU8(opts.bag ?? INVENTORY_SLOT_BAG_0)
    .writeU8(opts.slot ?? INVENTORY_SLOT_ITEM_START)
    .writeU8(1)
    .writeU32(opts.spellId ?? SPELL_ID)
    .writeU64(opts.itemGuid ?? itemGuidRaw(ITEM_GUID))
    .writeU32(0)
    .writeU8(0)
    .toUint8Array();
}

function makeCtx(opts: {
  db: TestDb;
  world: WorldTables;
  nowMs?: number;
  recoveryMs?: number;
  cooldowns?: ReturnType<typeof createUseCooldowns>;
  spellRecovery?: UsePlayCtx["spellRecovery"];
}): UsePlayCtx {
  const inventory = createInventory();
  storeItem(inventory, INVENTORY_SLOT_BAG_0, INVENTORY_SLOT_ITEM_START, {
    guid: ITEM_GUID,
    entry: ITEM_ENTRY,
    count: 1,
    template: bagTemplate(),
  });
  const recoveryMs = opts.recoveryMs ?? 1000;
  return {
    db: opts.db,
    world: opts.world,
    playerGuid: PLAYER_GUID,
    nowMs: opts.nowMs ?? 10_000,
    inventory,
    spellRecovery:
      opts.spellRecovery ??
      new Map([
        [
          SPELL_ID,
          {
            recoveryTime: recoveryMs,
            categoryRecoveryTime: 0,
            category: 0,
          },
        ],
      ]),
    cooldowns: opts.cooldowns ?? createUseCooldowns(),
  };
}

describe("USE_ITEM_OPCODES", () => {
  test("includes CMSG_USE_ITEM", () => {
    expect(USE_ITEM_OPCODES.has(CMSG_USE_ITEM)).toBe(true);
    expect(USE_ITEM_OPCODES.has(0x0ab)).toBe(true);
  });
});

describe("handleUseItem", () => {
  test("spellcooldown -1 uses recovery map (1000ms) and sends SMSG_SPELL_COOLDOWN", async () => {
    const db = await testDatabase("characters");
    const world = WorldTables.fromRows();
    ensureWorldTemplate(world, { spellCooldown: -1, spellCharges: 5 });
    await ensureItemInstance(db, formatChargesString([5, 0, 0, 0, 0]));
    const ctx = makeCtx({ db, world, recoveryMs: 1000 });

    const result = await handleUseItem(CMSG_USE_ITEM, buildUsePayload(), ctx);
    expect(result).not.toBeNull();
    expect(result!.packets).toHaveLength(1);
    expect(result!.packets[0]!.opcode).toBe(SMSG_SPELL_COOLDOWN);
    const reader = new ByteReader(result!.packets[0]!.body);
    expect(reader.readU64()).toBe(BigInt(PLAYER_GUID));
    expect(reader.readU8()).toBe(SPELL_COOLDOWN_FLAG_NONE);
    expect(reader.readU32()).toBe(SPELL_ID);
    expect(reader.readU32()).toBe(1000);
  });

  test("second use inside the cooldown window fails", async () => {
    const db = await testDatabase("characters");
    const world = WorldTables.fromRows();
    ensureWorldTemplate(world, { spellCooldown: -1, spellCharges: 5 });
    await ensureItemInstance(db, formatChargesString([5, 0, 0, 0, 0]));
    const cooldowns = createUseCooldowns();
    const ctx = makeCtx({ db, world, recoveryMs: 1000, nowMs: 50_000, cooldowns });

    const first = await handleUseItem(CMSG_USE_ITEM, buildUsePayload(), ctx);
    expect(first!.packets[0]!.opcode).toBe(SMSG_SPELL_COOLDOWN);

    ctx.nowMs = 50_500; // still inside 1000ms window
    const second = await handleUseItem(CMSG_USE_ITEM, buildUsePayload(), ctx);
    expect(second).not.toBeNull();
    expect(second!.packets).toHaveLength(1);
    expect(second!.packets[0]!.opcode).toBe(SMSG_INVENTORY_CHANGE_FAILURE);
    const reader = new ByteReader(second!.packets[0]!.body);
    expect(reader.readU8()).toBe(EQUIP_ERR_CANT_DO_RIGHT_NOW);

    const row = { charges: await storedCharges(db) };
    // First use consumed one charge; second use must not consume again.
    expect(parseInt(row.charges.trim().split(/\s+/)[0]!, 10)).toBe(4);
  });

  test("charges decrement on successful use", async () => {
    const db = await testDatabase("characters");
    const world = WorldTables.fromRows();
    ensureWorldTemplate(world, { spellCooldown: 0, spellCharges: 3, spellCategoryCooldown: 0 });
    await ensureItemInstance(db, formatChargesString([3, 0, 0, 0, 0]));
    const ctx = makeCtx({ db, world, spellRecovery: new Map() });

    const result = await handleUseItem(CMSG_USE_ITEM, buildUsePayload(), ctx);
    expect(result).not.toBeNull();
    // No cooldown packet when template cooldown is 0.
    expect(result!.packets).toEqual([]);

    const row = { charges: await storedCharges(db) };
    expect(row.charges).toBe(formatChargesString([2, 0, 0, 0, 0]));
  });

  test("deferred item use spends charges and cooldown only after the cast commits", async () => {
    const db = await testDatabase("characters");
    const world = WorldTables.fromRows();
    ensureWorldTemplate(world, { spellCooldown: 1000, spellCharges: 3, spellCategoryCooldown: 0 });
    await ensureItemInstance(db, formatChargesString([3, 0, 0, 0, 0]));
    const ctx = makeCtx({ db, world, nowMs: 50_000 });
    ctx.deferCast = true;
    const payload = new ByteWriter().writeBytes(buildUsePayload()).writeU32(0).toUint8Array();
    const prepared = await handleUseItem(CMSG_USE_ITEM, payload, ctx);
    expect(prepared?.cast?.spellId).toBe(SPELL_ID);
    expect(prepared?.packets).toEqual([]);
    expect(await storedCharges(db)).toBe(formatChargesString([3, 0, 0, 0, 0]));
    expect(ctx.cooldowns.spellExpiry.size).toBe(0);
    prepared!.cast!.commit(51_000);
    expect(await storedCharges(db)).toBe(formatChargesString([2, 0, 0, 0, 0]));
    expect(ctx.cooldowns.spellExpiry.get(SPELL_ID)).toBe(52_000);
  });

  test("missing item returns EQUIP_ERR_ITEM_NOT_FOUND", async () => {
    const db = await testDatabase("characters");
    const world = WorldTables.fromRows();
    ensureWorldTemplate(world);
    const inventory = createInventory();
    const ctx: UsePlayCtx = {
      db,
      world,
      playerGuid: PLAYER_GUID,
      nowMs: 0,
      inventory,
      spellRecovery: new Map(),
      cooldowns: createUseCooldowns(),
    };

    const result = await handleUseItem(CMSG_USE_ITEM, buildUsePayload(), ctx);
    expect(result!.packets[0]!.opcode).toBe(SMSG_INVENTORY_CHANGE_FAILURE);
    const reader = new ByteReader(result!.packets[0]!.body);
    expect(reader.readU8()).toBe(EQUIP_ERR_ITEM_NOT_FOUND);
  });

  test("unknown opcode returns null", async () => {
    const db = await testDatabase("characters");
    const world = WorldTables.fromRows();
    const ctx = makeCtx({ db, world });
    expect(await handleUseItem(0x999, buildUsePayload(), ctx)).toBeNull();
  });
});
