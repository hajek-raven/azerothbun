import { describe, expect, test } from "bun:test";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import {
  buildLootError,
  buildLootResponse,
  ITEM_FLAG2_FACTION_HORDE,
  ITEM_FLAG_MULTI_DROP,
  Loot,
  LootError,
  LootSlotType,
  LootType,
  PermissionTypes,
  writeLootView,
  type LootItemProto,
  type LootPlayer,
  type LootStoreItem,
} from "./loot.ts";

function proto(entry: number, fields: Partial<LootItemProto> = {}): LootItemProto {
  return {
    entry,
    Quality: 1,
    Flags: 0,
    FlagsExtra: 0,
    flagsCustom: 0,
    class: 0,
    bonding: 0,
    InventoryType: 0,
    stackable: 20,
    maxcount: 0,
    BagFamily: 0,
    RequiredSkill: 0,
    spellid_2: 0,
    startquest: 0,
    displayid: entry + 1000,
    ...fields,
  };
}

function storeItem(itemid: number, fields: Partial<LootStoreItem> = {}): LootStoreItem {
  return { itemid, reference: 0, chance: 100, needs_quest: false, lootmode: 1, groupid: 0, mincount: 1, maxcount: 1, conditions: [], ...fields };
}

function player(guid: bigint, fields: Partial<LootPlayer> = {}): LootPlayer {
  return {
    guid,
    teamId: 0,
    hasSkill: () => false,
    hasSpell: () => false,
    meetsConditions: () => true,
    hasQuestForItem: () => false,
    questStatus: () => 0,
    questRewarded: () => false,
    prevQuestId: () => 0,
    hasItemCount: () => false,
    isMasterLooter: false,
    ...fields,
  };
}

/** A loot filled for `owner` from the given rows (`Loot::FillLoot` with a personal owner). */
function filled(items: LootItemProto[], rows: LootStoreItem[], owner: LootPlayer, gold = 0): Loot {
  const byEntry = new Map(items.map((item) => [item.entry, item]));
  const loot = new Loot({ itemProto: (entry) => byEntry.get(entry) ?? null, enchSuffixFactor: (entry) => (entry === 3 ? 77 : 0), randomPropertyId: (entry) => (entry === 3 ? -12 : 0) });
  loot.fillLoot(owner, null, false, (target) => {
    for (const row of rows) target.addItem(row, (min) => min);
  });
  loot.gold = gold;
  return loot;
}

function readView(body: Uint8Array): { gold: number; items: { slot: number; itemid: number; count: number; display: number; suffix: number; property: number; slotType: number }[] } {
  const reader = new ByteReader(body);
  const gold = reader.readU32();
  const count = reader.readU8();
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push({
      slot: reader.readU8(),
      itemid: reader.readU32(),
      count: reader.readU32(),
      display: reader.readU32(),
      suffix: reader.readU32(),
      property: reader.readU32() | 0,
      slotType: reader.readU8(),
    });
  }
  return { gold, items };
}

function view(loot: Loot, viewer: LootPlayer, permission: (typeof PermissionTypes)[keyof typeof PermissionTypes]) {
  const b = new ByteWriter();
  writeLootView(b, loot, viewer, permission);
  return readView(b.toUint8Array());
}

describe("LootView", () => {
  test("an owner sees the normal items as LOOT_SLOT_TYPE_OWNER with the random suffix and property", () => {
    const owner = player(7n);
    const loot = filled([proto(1), proto(3)], [storeItem(1, { maxcount: 3, mincount: 3 }), storeItem(3)], owner, 125);
    expect(view(loot, owner, PermissionTypes.OWNER)).toEqual({
      gold: 125,
      items: [
        { slot: 0, itemid: 1, count: 3, display: 1001, suffix: 0, property: 0, slotType: LootSlotType.OWNER },
        { slot: 1, itemid: 3, count: 1, display: 1003, suffix: 77, property: -12, slotType: LootSlotType.OWNER },
      ],
    });
    expect(view(loot, owner, PermissionTypes.NONE)).toEqual({ gold: 0, items: [] });
  });

  test("SMSG_LOOT_RESPONSE is the guid, the loot type, then the view; a loot error is LOOT_NONE and the error", () => {
    const owner = player(7n);
    const loot = filled([proto(1)], [storeItem(1)], owner);
    const body = buildLootResponse(0xf130000001000001n, LootType.CORPSE, loot, owner, PermissionTypes.OWNER);
    const reader = new ByteReader(body);
    expect(reader.readU64()).toBe(0xf130000001000001n);
    expect(reader.readU8()).toBe(LootType.CORPSE);
    expect(readView(body.subarray(9)).items).toHaveLength(1);
    expect([...buildLootError(5n, LootError.TOO_FAR)]).toEqual([5, 0, 0, 0, 0, 0, 0, 0, LootType.NONE, LootError.TOO_FAR]);
  });

  test("quest items follow the normal items, only for players on the quest", () => {
    const onQuest = player(7n, { hasQuestForItem: (itemId) => itemId === 2 });
    const loot = filled([proto(1), proto(2)], [storeItem(1), storeItem(2, { needs_quest: true })], onQuest);
    expect(loot.items).toHaveLength(1);
    expect(loot.quest_items).toHaveLength(1);
    expect(view(loot, onQuest, PermissionTypes.OWNER).items.map((item) => [item.slot, item.itemid, item.slotType])).toEqual([
      [0, 1, LootSlotType.OWNER],
      [1, 2, LootSlotType.OWNER],
    ]);
    // quest items are not counted for the loot owner when no one needs them
    const offQuest = player(8n);
    expect(filled([proto(1), proto(2)], [storeItem(1), storeItem(2, { needs_quest: true })], offQuest).unlootedCount).toBe(1);
  });

  test("a quest item the bags already hold enough of is dropped from the view (showInLoot)", () => {
    const owner = player(7n, {
      hasQuestForItem: (itemId, showInLoot) => {
        if (showInLoot) {
          showInLoot.value = false;
          return false;
        }
        return itemId === 2;
      },
    });
    const loot = filled([proto(2)], [storeItem(2, { needs_quest: true })], owner);
    expect(view(loot, owner, PermissionTypes.OWNER).items).toEqual([]);
    expect(loot.quest_items[0]!.is_looted).toBe(true);
  });

  test("free for all items are listed per player and stay after one player takes them", () => {
    const owner = player(7n);
    const loot = filled([proto(4, { Flags: ITEM_FLAG_MULTI_DROP })], [storeItem(4)], owner);
    expect(loot.unlootedCount).toBe(1);
    expect(view(loot, owner, PermissionTypes.OWNER).items.map((item) => [item.slot, item.slotType])).toEqual([[0, LootSlotType.ALLOW_LOOT]]);
    const slot = loot.lootItemInSlot(0, owner)!;
    expect(slot.ffaitem).toEqual({ index: 0, is_looted: false });
    slot.ffaitem!.is_looted = true;
    expect(loot.lootItemInSlot(0, owner)).toBeNull();
    expect(loot.items[0]!.is_looted).toBe(false);
  });
});

describe("LootItem::AllowedForPlayer", () => {
  test("faction items only for their team, and a hidden item does not count toward unlootedCount", () => {
    const alliance = player(7n, { teamId: 0 });
    const loot = filled([proto(5, { FlagsExtra: ITEM_FLAG2_FACTION_HORDE })], [storeItem(5)], alliance);
    expect(loot.items).toHaveLength(1);
    expect(loot.unlootedCount).toBe(0);
    expect(loot.isLooted()).toBe(true);
    expect(loot.items[0]!.allowedForPlayer(player(8n, { teamId: 1 }), loot.env)).toBe(true);
  });

  test("a quest starter item hides once its quest is taken or its prerequisite is missing", () => {
    const item = proto(6, { startquest: 100 });
    const fresh = filled([item], [storeItem(6)], player(7n));
    expect(fresh.items[0]!.allowedForPlayer(player(7n), fresh.env)).toBe(true);
    expect(fresh.items[0]!.allowedForPlayer(player(7n, { questStatus: () => 3 }), fresh.env)).toBe(false);
    expect(fresh.items[0]!.allowedForPlayer(player(7n, { prevQuestId: () => 99 }), fresh.env)).toBe(false);
  });

  test("a BoP recipe the player already knows is hidden", () => {
    const recipe = proto(7, { class: 9, bonding: 1, spellid_2: 555 });
    const loot = filled([recipe], [storeItem(7)], player(7n));
    expect(loot.items[0]!.allowedForPlayer(player(7n, { hasSpell: (spell) => spell === 555 }), loot.env)).toBe(false);
  });
});

describe("Loot", () => {
  test("isLooted once the gold and every counted item are gone; hasItemForAll sees gold", () => {
    const owner = player(7n);
    const loot = filled([proto(1)], [storeItem(1)], owner, 10);
    expect(loot.isLooted()).toBe(false);
    loot.gold = 0;
    expect(loot.hasItemForAll()).toBe(true);
    loot.items[0]!.is_looted = true;
    loot.unlootedCount--;
    expect(loot.isLooted()).toBe(true);
    expect(loot.hasItemForAll()).toBe(false);
  });

  test("MAX_NR_LOOT_ITEMS caps the normal items", () => {
    const owner = player(7n);
    const loot = filled([proto(1, { stackable: 1 })], [storeItem(1, { mincount: 30, maxcount: 30 })], owner);
    expect(loot.items).toHaveLength(18);
  });

  test("the looters are who a removed item or money is announced to", () => {
    const loot = filled([proto(1)], [storeItem(1)], player(7n));
    loot.addLooter(7n);
    loot.addLooter(8n);
    loot.removeLooter(8n);
    expect(loot.notifyItemRemoved()).toEqual([7n]);
    expect(loot.notifyMoneyRemoved()).toEqual([7n]);
  });
});
