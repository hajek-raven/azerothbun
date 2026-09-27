import { describe, expect, test } from "bun:test";
import { updateFieldValue } from "../combat/packets.ts";
import { testDatabase } from "../database/test-db.ts";
import { worldFromSql } from "../database/test-world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import {
  createInventory,
  EQUIP_ERR_ALREADY_LOOTED,
  EQUIP_ERR_CANT_CARRY_MORE_OF_THIS,
  EQUIP_ERR_INVENTORY_FULL,
  getItem,
  INVENTORY_SLOT_BAG_0,
  INVENTORY_SLOT_ITEM_END,
  INVENTORY_SLOT_ITEM_START,
  placeStoredItem,
  SMSG_INVENTORY_CHANGE_FAILURE,
  SMSG_ITEM_PUSH_RESULT,
  type Inventory,
} from "../items/bags.ts";
import { ItemDbc } from "../items/item-dbc.ts";
import { Loot, LootError, LootSlotType, LootType, SMSG_LOOT_RESPONSE, type LootPlayer } from "../loot/loot.ts";
import { fillLoot, loadAllLootStores } from "../loot/templates.ts";
import { ByteReader } from "../net/byte-buffer.ts";
import { lookupTemplate } from "./bags-play.ts";
import { PLAYER_FIELD_PACK_SLOT_1 } from "./equip-play.ts";
import {
  CMSG_AUTOSTORE_LOOT_ITEM,
  CMSG_LOOT,
  CMSG_LOOT_MONEY,
  CMSG_LOOT_RELEASE,
  handleLoot,
  LOOT_OPCODES,
  lootItemProto,
  packLootGuid,
  SMSG_LOOT_CLEAR_MONEY,
  SMSG_LOOT_MONEY_NOTIFY,
  SMSG_LOOT_RELEASE_RESPONSE,
  SMSG_LOOT_REMOVED,
  type LootCreature,
  type LootPlayCtx,
  type PlayPacket,
} from "./loot-play.ts";
import { SMSG_UPDATE_OBJECT } from "./packets.ts";
import { PLAYER_FIELD_COINAGE } from "./update-object.ts";

const PLAYER = 1;
const CREATURE_ENTRY = 6;
const CORPSE = 0xf130000000000000n | (BigInt(CREATURE_ENTRY) << 24n) | 42n;
const OTHER_CORPSE = 0xf130000000000000n | (BigInt(CREATURE_ENTRY) << 24n) | 43n;
const LINEN = 2589;
const MEAT = 769;
const QUEST_ITEM = 750;
const UNIQUE = 5000;

function memoryWorld(): WorldTables {
  return worldFromSql(`
    INSERT INTO item_template (entry, displayid, class, subclass, InventoryType, stackable, maxcount, Quality, bonding) VALUES
      (${LINEN}, 7007, 7, 0, 0, 20, 0, 1, 0),
      (${MEAT}, 7008, 7, 0, 0, 10, 0, 1, 0),
      (${QUEST_ITEM}, 7009, 12, 0, 0, 20, 0, 1, 4),
      (${UNIQUE}, 7010, 15, 0, 0, 1, 1, 1, 0);
    INSERT INTO creature_loot_template (Entry, Item, Reference, Chance, QuestRequired, LootMode, GroupId, MinCount, MaxCount, Comment) VALUES
      (${CREATURE_ENTRY}, ${LINEN}, 0, 100, 0, 1, 0, 2, 2, 'linen'),
      (${CREATURE_ENTRY}, ${MEAT}, 0, 100, 0, 1, 0, 1, 1, 'meat'),
      (${CREATURE_ENTRY}, ${QUEST_ITEM}, 0, 100, 1, 1, 0, 1, 1, 'quest'),
      (7, ${UNIQUE}, 0, 100, 0, 1, 0, 1, 1, 'unique');
  `);
}

function lootPlayer(fields: Partial<LootPlayer> = {}): LootPlayer {
  return {
    guid: BigInt(PLAYER),
    teamId: 0,
    hasSkill: () => false,
    hasSpell: () => false,
    meetsConditions: () => true,
    hasQuestForItem: (itemId) => itemId === QUEST_ITEM,
    questStatus: () => 0,
    questRewarded: () => false,
    prevQuestId: () => 0,
    hasItemCount: () => false,
    isMasterLooter: false,
    ...fields,
  };
}

/** A corpse killed by `PLAYER` with its kill-time loot (`Unit::Kill` → `Loot::FillLoot`). */
function corpse(world: WorldTables, guid: bigint, lootId: number, gold = 0): LootCreature {
  const loot = new Loot({ itemProto: (entry) => lootItemProto(world, entry), enchSuffixFactor: () => 0, randomPropertyId: () => 0 });
  const stores = loadAllLootStores(world);
  fillLoot(loot, lootId, stores, stores.creature, lootPlayer(), false);
  loot.gold = gold;
  return { guid, alive: false, lootable: true, lootRecipient: PLAYER, loot, withinInteractionDistance: true };
}

type Harness = {
  ctx: LootPlayCtx;
  released: bigint[];
  others: { guid: bigint; packet: PlayPacket }[];
  added: [number, number][];
  looting: boolean[];
  interrupted: number;
};

async function harness(world: WorldTables, corpses: LootCreature[], fields: Partial<LootPlayCtx> = {}): Promise<Harness> {
  const db = await testDatabase("characters");
  const byGuid = new Map(corpses.map((c) => [c.guid, c]));
  const h: Harness = { ctx: null as unknown as LootPlayCtx, released: [], others: [], added: [], looting: [], interrupted: 0 };
  h.ctx = {
    db,
    world,
    itemDbc: ItemDbc.empty(),
    player: lootPlayer(),
    playerGuid: PLAYER,
    alive: true,
    money: 0,
    lootGuid: 0n,
    inventory: createInventory(0),
    creatures: {
      creature: (guid) => byGuid.get(guid) ?? null,
      releaseLoot: (guid) => {
        h.released.push(guid);
      },
    },
    sendToPlayer: (guid, packet) => h.others.push({ guid, packet }),
    itemAdded: (entry, count) => {
      h.added.push([entry, count]);
      return [];
    },
    interruptNonMeleeSpells: () => {
      h.interrupted++;
    },
    removeLootAuras: () => {},
    setLooting: (on) => h.looting.push(on),
    ...fields,
  };
  return h;
}

function find(packets: PlayPacket[], opcode: number): Uint8Array | undefined {
  return packets.find((p) => p.opcode === opcode)?.body;
}

/** SMSG_LOOT_RESPONSE items as [slot, item, count, slot type]. */
function lootWindow(body: Uint8Array): { type: number; gold: number; items: number[][] } {
  const r = new ByteReader(body);
  r.readU64();
  const type = r.readU8();
  const gold = r.readU32();
  const count = r.readU8();
  const items: number[][] = [];
  for (let i = 0; i < count; i++) {
    const slot = r.readU8();
    const item = r.readU32();
    const n = r.readU32();
    r.readU32();
    r.readU32();
    r.readU32();
    items.push([slot, item, n, r.readU8()]);
  }
  return { type, gold, items };
}

function fillBackpack(inventory: Inventory, world: WorldTables, entry: number): void {
  for (let slot = INVENTORY_SLOT_ITEM_START; slot < INVENTORY_SLOT_ITEM_END; slot++) {
    placeStoredItem(inventory, INVENTORY_SLOT_BAG_0, slot, { guid: 900 + slot, entry, count: 1, template: lookupTemplate(world, entry)! });
  }
}

test("LOOT_OPCODES covers the four client loot messages", () => {
  expect([...LOOT_OPCODES].sort()).toEqual([CMSG_AUTOSTORE_LOOT_ITEM, CMSG_LOOT, CMSG_LOOT_MONEY, CMSG_LOOT_RELEASE].sort());
});

describe("CMSG_LOOT → Player::SendLoot", () => {
  test("the recipient sees the loot as its owner and starts looting", async () => {
    const world = memoryWorld();
    const h = await harness(world, [corpse(world, CORPSE, CREATURE_ENTRY, 35)]);
    const packets = (await handleLoot(CMSG_LOOT, packLootGuid(CORPSE), h.ctx))!;
    const window = lootWindow(find(packets, SMSG_LOOT_RESPONSE)!);
    expect(window.type).toBe(LootType.CORPSE);
    expect(window.gold).toBe(35);
    expect(window.items).toEqual([
      [0, LINEN, 2, LootSlotType.OWNER],
      [1, MEAT, 1, LootSlotType.OWNER],
      [2, QUEST_ITEM, 1, LootSlotType.OWNER],
    ]);
    expect(h.ctx.lootGuid).toBe(CORPSE);
    expect(h.looting).toEqual([true]);
    expect(h.interrupted).toBe(1);
  });

  test("a corpse tapped by someone else answers LOOT_ERROR_DIDNT_KILL", async () => {
    const world = memoryWorld();
    const h = await harness(world, [{ ...corpse(world, CORPSE, CREATURE_ENTRY), lootRecipient: 2 }]);
    const packets = (await handleLoot(CMSG_LOOT, packLootGuid(CORPSE), h.ctx))!;
    const r = new ByteReader(find(packets, SMSG_LOOT_RESPONSE)!);
    expect(r.readU64()).toBe(CORPSE);
    expect(r.readU8()).toBe(LootType.NONE);
    expect(r.readU8()).toBe(LootError.DIDNT_KILL);
    expect(h.ctx.lootGuid).toBe(0n);
  });

  test("out of INTERACTION_DISTANCE the window is released", async () => {
    const world = memoryWorld();
    const h = await harness(world, [{ ...corpse(world, CORPSE, CREATURE_ENTRY), withinInteractionDistance: false }]);
    const packets = (await handleLoot(CMSG_LOOT, packLootGuid(CORPSE), h.ctx))!;
    expect(packets.map((p) => p.opcode)).toEqual([SMSG_LOOT_RELEASE_RESPONSE]);
  });

  test("a dead player or a non-creature guid gets nothing", async () => {
    const world = memoryWorld();
    const h = await harness(world, [corpse(world, CORPSE, CREATURE_ENTRY)], { alive: false });
    expect(await handleLoot(CMSG_LOOT, packLootGuid(CORPSE), h.ctx)).toEqual([]);
    h.ctx.alive = true;
    expect(await handleLoot(CMSG_LOOT, packLootGuid(0x4000000000000001n), h.ctx)).toEqual([]);
  });

  test("opening another corpse releases the one being looted", async () => {
    const world = memoryWorld();
    const h = await harness(world, [corpse(world, CORPSE, CREATURE_ENTRY), corpse(world, OTHER_CORPSE, CREATURE_ENTRY)]);
    await handleLoot(CMSG_LOOT, packLootGuid(CORPSE), h.ctx);
    const packets = (await handleLoot(CMSG_LOOT, packLootGuid(OTHER_CORPSE), h.ctx))!;
    expect(packets.map((p) => p.opcode)).toEqual([SMSG_LOOT_RELEASE_RESPONSE, SMSG_LOOT_RESPONSE]);
    expect(h.released).toEqual([CORPSE]);
    expect(h.ctx.lootGuid).toBe(OTHER_CORPSE);
  });
});

describe("CMSG_AUTOSTORE_LOOT_ITEM → Player::StoreLootItem", () => {
  test("the item is created in the backpack, removed from the loot, and pushed to the client", async () => {
    const world = memoryWorld();
    const dead = corpse(world, CORPSE, CREATURE_ENTRY);
    const h = await harness(world, [dead]);
    await handleLoot(CMSG_LOOT, packLootGuid(CORPSE), h.ctx);
    const packets = (await handleLoot(CMSG_AUTOSTORE_LOOT_ITEM, Uint8Array.of(0), h.ctx))!;
    const stored = getItem(h.ctx.inventory, 0, INVENTORY_SLOT_ITEM_START)!;
    expect([stored.entry, stored.count]).toEqual([LINEN, 2]);
    expect(new ByteReader(find(packets, SMSG_LOOT_REMOVED)!).readU8()).toBe(0);
    const updates = packets.filter((p) => p.opcode === SMSG_UPDATE_OBJECT);
    expect(updates.some((p) => p.body[4] === 2)).toBe(true); // UPDATETYPE_CREATE_OBJECT
    expect(updates.some((p) => updateFieldValue(p.body, PLAYER_FIELD_PACK_SLOT_1) === stored.guid)).toBe(true);
    const push = new ByteReader(find(packets, SMSG_ITEM_PUSH_RESULT)!);
    expect(push.readU64()).toBe(BigInt(PLAYER));
    expect([push.readU32(), push.readU32(), push.readU32()]).toEqual([0, 0, 1]);
    expect(push.readU8()).toBe(INVENTORY_SLOT_BAG_0);
    expect(push.readU32()).toBe(INVENTORY_SLOT_ITEM_START);
    expect(push.readU32()).toBe(LINEN);
    push.readU32();
    push.readU32();
    expect([push.readU32(), push.readU32()]).toEqual([2, 2]);
    expect(dead.loot!.items[0]!.is_looted).toBe(true);
    expect(dead.loot!.unlootedCount).toBe(2);
    // The same slot again is already looted.
    const again = (await handleLoot(CMSG_AUTOSTORE_LOOT_ITEM, Uint8Array.of(0), h.ctx))!;
    expect(find(again, SMSG_INVENTORY_CHANGE_FAILURE)![0]).toBe(EQUIP_ERR_ALREADY_LOOTED);
  });

  test("a stackable item fills the stack the bags already hold (slot -1 in SMSG_ITEM_PUSH_RESULT)", async () => {
    const world = memoryWorld();
    const h = await harness(world, [corpse(world, CORPSE, CREATURE_ENTRY)]);
    placeStoredItem(h.ctx.inventory, INVENTORY_SLOT_BAG_0, 30, { guid: 777, entry: LINEN, count: 5, template: lookupTemplate(world, LINEN)! });
    await handleLoot(CMSG_LOOT, packLootGuid(CORPSE), h.ctx);
    const packets = (await handleLoot(CMSG_AUTOSTORE_LOOT_ITEM, Uint8Array.of(0), h.ctx))!;
    expect(getItem(h.ctx.inventory, 0, 30)!.count).toBe(7);
    expect(getItem(h.ctx.inventory, 0, INVENTORY_SLOT_ITEM_START)).toBeNull();
    expect(packets.filter((p) => p.opcode === SMSG_UPDATE_OBJECT).some((p) => p.body[4] === 2)).toBe(false);
    const push = new ByteReader(find(packets, SMSG_ITEM_PUSH_RESULT)!);
    push.readU64();
    push.readU32();
    push.readU32();
    push.readU32();
    push.readU8();
    expect(push.readU32()).toBe(0xffffffff);
    push.readU32();
    push.readU32();
    push.readU32();
    expect([push.readU32(), push.readU32()]).toEqual([2, 7]);
  });

  test("full bags answer EQUIP_ERR_INVENTORY_FULL and leave the item in the loot", async () => {
    const world = memoryWorld();
    const dead = corpse(world, CORPSE, CREATURE_ENTRY);
    const h = await harness(world, [dead]);
    fillBackpack(h.ctx.inventory, world, MEAT);
    await handleLoot(CMSG_LOOT, packLootGuid(CORPSE), h.ctx);
    const packets = (await handleLoot(CMSG_AUTOSTORE_LOOT_ITEM, Uint8Array.of(0), h.ctx))!;
    expect(packets.map((p) => p.opcode)).toEqual([SMSG_INVENTORY_CHANGE_FAILURE]);
    expect(packets[0]!.body[0]).toBe(EQUIP_ERR_INVENTORY_FULL);
    expect(dead.loot!.items[0]!.is_looted).toBe(false);
  });

  test("a unique item the player already carries answers EQUIP_ERR_CANT_CARRY_MORE_OF_THIS", async () => {
    const world = memoryWorld();
    const h = await harness(world, [corpse(world, CORPSE, 7)]);
    placeStoredItem(h.ctx.inventory, INVENTORY_SLOT_BAG_0, 30, { guid: 778, entry: UNIQUE, count: 1, template: lookupTemplate(world, UNIQUE)! });
    await handleLoot(CMSG_LOOT, packLootGuid(CORPSE), h.ctx);
    const packets = (await handleLoot(CMSG_AUTOSTORE_LOOT_ITEM, Uint8Array.of(0), h.ctx))!;
    expect(packets[0]!.body[0]).toBe(EQUIP_ERR_CANT_CARRY_MORE_OF_THIS);
  });

  test("a quest item counts toward the quest (ItemAddedQuestCheck) and is bound on store", async () => {
    const world = memoryWorld();
    const h = await harness(world, [corpse(world, CORPSE, CREATURE_ENTRY)]);
    await handleLoot(CMSG_LOOT, packLootGuid(CORPSE), h.ctx);
    const packets = (await handleLoot(CMSG_AUTOSTORE_LOOT_ITEM, Uint8Array.of(2), h.ctx))!;
    expect(h.added).toEqual([[QUEST_ITEM, 1]]);
    expect(new ByteReader(find(packets, SMSG_LOOT_REMOVED)!).readU8()).toBe(2);
    expect(getItem(h.ctx.inventory, 0, INVENTORY_SLOT_ITEM_START)!.entry).toBe(QUEST_ITEM);
  });

  test("another player looting the corpse sees the item go", async () => {
    const world = memoryWorld();
    const dead = corpse(world, CORPSE, CREATURE_ENTRY);
    const h = await harness(world, [dead]);
    await handleLoot(CMSG_LOOT, packLootGuid(CORPSE), h.ctx);
    dead.loot!.addLooter(2n);
    await handleLoot(CMSG_AUTOSTORE_LOOT_ITEM, Uint8Array.of(1), h.ctx);
    expect(h.others.map((o) => [o.guid, o.packet.opcode])).toEqual([[2n, SMSG_LOOT_REMOVED]]);
  });

  test("without an open window the loot error names the empty guid", async () => {
    const world = memoryWorld();
    const h = await harness(world, [corpse(world, CORPSE, CREATURE_ENTRY)]);
    const packets = (await handleLoot(CMSG_AUTOSTORE_LOOT_ITEM, Uint8Array.of(0), h.ctx))!;
    expect([...find(packets, SMSG_LOOT_RESPONSE)!]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, LootType.NONE, LootError.DIDNT_KILL]);
  });
});

describe("CMSG_LOOT_MONEY and CMSG_LOOT_RELEASE", () => {
  test("the money goes to the sole looter with the coinage update and the notify", async () => {
    const world = memoryWorld();
    const dead = corpse(world, CORPSE, CREATURE_ENTRY, 120);
    const h = await harness(world, [dead], { money: 50 });
    await handleLoot(CMSG_LOOT, packLootGuid(CORPSE), h.ctx);
    const packets = (await handleLoot(CMSG_LOOT_MONEY, new Uint8Array(), h.ctx))!;
    expect(packets.map((p) => p.opcode)).toEqual([SMSG_LOOT_CLEAR_MONEY, SMSG_UPDATE_OBJECT, SMSG_LOOT_MONEY_NOTIFY]);
    expect(updateFieldValue(packets[1]!.body, PLAYER_FIELD_COINAGE)).toBe(170);
    expect([...packets[2]!.body]).toEqual([120, 0, 0, 0, 1]);
    expect(h.ctx.money).toBe(170);
    expect(dead.loot!.gold).toBe(0);
  });

  test("release answers, stops looting, and lets the corpse update; a wrong guid is ignored", async () => {
    const world = memoryWorld();
    const h = await harness(world, [corpse(world, CORPSE, CREATURE_ENTRY)]);
    await handleLoot(CMSG_LOOT, packLootGuid(CORPSE), h.ctx);
    expect(await handleLoot(CMSG_LOOT_RELEASE, packLootGuid(OTHER_CORPSE), h.ctx)).toEqual([]);
    const packets = (await handleLoot(CMSG_LOOT_RELEASE, packLootGuid(CORPSE), h.ctx))!;
    const r = new ByteReader(find(packets, SMSG_LOOT_RELEASE_RESPONSE)!);
    expect([r.readU64(), r.readU8()]).toEqual([CORPSE, 1]);
    expect(h.ctx.lootGuid).toBe(0n);
    expect(h.looting).toEqual([true, false]);
    expect(h.released).toEqual([CORPSE]);
  });
});
