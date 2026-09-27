import { expect, test } from "bun:test";
import { conditions, item_template } from "../database/schema/world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { Loot, type LootItemProto } from "./loot.ts";
import {
  DEFAULT_LOOT_RATES,
  fillLoot,
  haveQuestLootFor,
  loadAllLootStores,
  LOOT_MODE_DEFAULT,
  LOOT_STORE_KIND,
  LOOT_STORE_META,
  LOOT_TABLE_NAMES,
  lootTable,
  processTemplate,
  type LootRandom,
  type LootStores,
} from "./templates.ts";

type LootRow = {
  Entry: number;
  Item: number;
  Reference?: number;
  Chance?: number;
  QuestRequired?: number;
  LootMode?: number;
  GroupId?: number;
  MinCount?: number;
  MaxCount?: number;
};

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
    displayid: entry,
    ...fields,
  };
}

function world(items: LootItemProto[], rows: Record<string, LootRow[]>): WorldTables {
  const db = WorldTables.fromRows([[item_template, items.map((item) => ({ ...item }))]]);
  for (const [table, list] of Object.entries(rows)) {
    db.set(
      lootTable(table),
      list.map((row) => ({
        Reference: 0,
        Chance: 100,
        QuestRequired: 0,
        LootMode: LOOT_MODE_DEFAULT,
        GroupId: 0,
        MinCount: 1,
        MaxCount: 1,
        Comment: null,
        ...row,
      })),
    );
  }
  return db;
}

function newLoot(items: LootItemProto[]): Loot {
  const byEntry = new Map(items.map((item) => [item.entry, item]));
  return new Loot({ itemProto: (entry) => byEntry.get(entry) ?? null, enchSuffixFactor: () => 0, randomPropertyId: () => 0 });
}

/** `rand_chance` values in order, then 0; `urand` returns the minimum. */
function random(...chances: number[]): LootRandom {
  let i = 0;
  const next = (): number => (i < chances.length ? chances[i++]! : 0);
  return { randChance: next, rollChance: (chance) => chance > next(), urand: (min) => min };
}

function roll(stores: LootStores, loot: Loot, entry: number, rnd: LootRandom, rates = DEFAULT_LOOT_RATES): void {
  processTemplate(stores.creature.templates.get(entry)!, loot, stores.creature, LOOT_MODE_DEFAULT, 0, true, { reference: stores.reference, rates, random: rnd });
}

test("LoadLootTemplates reads every store with the AzerothCore columns", () => {
  expect(LOOT_TABLE_NAMES).toEqual([
    "creature_loot_template",
    "gameobject_loot_template",
    "pickpocketing_loot_template",
    "skinning_loot_template",
    "fishing_loot_template",
    "disenchant_loot_template",
    "milling_loot_template",
    "prospecting_loot_template",
    "item_loot_template",
    "spell_loot_template",
    "mail_loot_template",
    "player_loot_template",
    "reference_loot_template",
  ]);
  const db = world([proto(100), proto(1467)], {
    creature_loot_template: [{ Entry: 1, Item: 100, Chance: 50, QuestRequired: 1, GroupId: 2, MaxCount: 3 }],
    fishing_loot_template: [{ Entry: 44, Item: 1467, LootMode: 0 }],
  });
  const stores = loadAllLootStores(db);
  expect(Object.keys(stores).sort()).toEqual([...Object.values(LOOT_STORE_KIND)].sort());
  const grouped = stores.creature.templates.get(1)!.groups[1]!.explicitlyChanced[0]!;
  expect(grouped).toEqual({ itemid: 100, reference: 0, chance: 50, needs_quest: true, lootmode: 1, groupid: 2, mincount: 1, maxcount: 3, conditions: [] });
  // LootMode 0 is loaded as 1.
  expect(stores.fishing.templates.get(44)!.entries[0]!.lootmode).toBe(1);
  expect(LOOT_STORE_META.mail.ratesAllowed).toBe(false);
  expect(LOOT_STORE_META.creature.ratesAllowed).toBe(true);
});

test("LootStoreItem::IsValid skips missing items, low chances, and ungrouped zero chances", () => {
  const db = world([proto(100)], {
    creature_loot_template: [
      { Entry: 1, Item: 100 },
      { Entry: 1, Item: 999 },
      { Entry: 1, Item: 100, Chance: -5 },
      { Entry: 1, Item: 100, Chance: 0 },
      { Entry: 1, Item: 100, MinCount: 0 },
      { Entry: 1, Item: 100, MinCount: 3, MaxCount: 2 },
      { Entry: 1, Item: 0, Reference: 5, Chance: 0 },
    ],
  });
  expect(loadAllLootStores(db).creature.templates.get(1)!.entries).toHaveLength(1);
});

test("conditions attach to the first row of their item in the template", () => {
  const db = world([proto(100)], { creature_loot_template: [{ Entry: 1, Item: 100 }] });
  db.set(conditions, [
    { SourceTypeOrReferenceId: 1, SourceGroup: 1, SourceEntry: 100, ElseGroup: 0, ConditionTypeOrReference: 9, ConditionValue1: 33, ConditionValue2: 0, ConditionValue3: 0, NegativeCondition: 0 },
    { SourceTypeOrReferenceId: 4, SourceGroup: 1, SourceEntry: 100, ElseGroup: 0, ConditionTypeOrReference: 9, ConditionValue1: 34, ConditionValue2: 0, ConditionValue3: 0, NegativeCondition: 0 },
  ]);
  const item = loadAllLootStores(db).creature.templates.get(1)!.entries[0]!;
  expect(item.conditions).toEqual([{ elseGroup: 0, conditionType: 9, value1: 33, value2: 0, value3: 0, negative: false }]);
});

test("ungrouped rows roll on their own; a 100% row always drops and splits into stacks", () => {
  const items = [proto(100, { stackable: 5 }), proto(101)];
  const stores = loadAllLootStores(
    world(items, {
      creature_loot_template: [
        { Entry: 1, Item: 100, MinCount: 12, MaxCount: 12 },
        { Entry: 1, Item: 101, Chance: 30 },
      ],
    }),
  );
  const loot = newLoot(items);
  // the 30% row rolls 40 and misses
  roll(stores, loot, 1, random(40));
  expect(loot.items.map((item) => [item.itemid, item.count])).toEqual([
    [100, 5],
    [100, 5],
    [100, 2],
  ]);
  expect(loot.items.map((item) => item.itemIndex)).toEqual([0, 1, 2]);
});

test("a group picks one explicitly chanced row by the remaining roll, else an equal-chanced row", () => {
  const items = [proto(1), proto(2), proto(3)];
  const stores = loadAllLootStores(
    world(items, {
      creature_loot_template: [
        { Entry: 1, Item: 1, Chance: 30, GroupId: 1 },
        { Entry: 1, Item: 2, Chance: 30, GroupId: 1 },
        { Entry: 1, Item: 3, Chance: 0, GroupId: 1 },
      ],
    }),
  );
  let loot = newLoot(items);
  roll(stores, loot, 1, random(45));
  expect(loot.items.map((item) => item.itemid)).toEqual([2]);
  loot = newLoot(items);
  roll(stores, loot, 1, random(80));
  expect(loot.items.map((item) => item.itemid)).toEqual([3]);
});

test("Rate.Drop.Item.GroupAmount repeats a top-level group, and an equippable item drops once per group", () => {
  const items = [proto(1, { InventoryType: 5 }), proto(2)];
  const stores = loadAllLootStores(
    world(items, {
      creature_loot_template: [
        { Entry: 1, Item: 1, Chance: 0, GroupId: 1 },
        { Entry: 1, Item: 2, Chance: 0, GroupId: 1 },
      ],
    }),
  );
  const loot = newLoot(items);
  roll(stores, loot, 1, random(), { ...DEFAULT_LOOT_RATES, groupAmount: 5 });
  // urand picks the first valid row: the chest piece once, then the trade good up to its three-drop limit.
  expect(loot.items.map((item) => item.itemid)).toEqual([1, 2, 2, 2]);
});

test("a reference expands MaxCount times (times Rate.Drop.Item.ReferencedAmount) into the referenced template", () => {
  const items = [proto(7), proto(8)];
  const stores = loadAllLootStores(
    world(items, {
      creature_loot_template: [{ Entry: 1, Item: 0, Reference: 900, MaxCount: 2 }],
      reference_loot_template: [
        { Entry: 900, Item: 7 },
        { Entry: 900, Item: 8, Chance: 0, GroupId: 1 },
      ],
    }),
  );
  const loot = newLoot(items);
  roll(stores, loot, 1, random(), { ...DEFAULT_LOOT_RATES, referencedAmount: 1.5 });
  expect(loot.items.map((item) => item.itemid)).toEqual([7, 8, 7, 8, 7, 8]);
});

test("the quality rate scales an item's chance; the reference rate scales a reference's", () => {
  const items = [proto(1, { Quality: 2 })];
  const stores = loadAllLootStores(world(items, { creature_loot_template: [{ Entry: 1, Item: 1, Chance: 20 }] }));
  const rates = { ...DEFAULT_LOOT_RATES, quality: [1, 1, 3, 1, 1, 1, 1] };
  const loot = newLoot(items);
  // 20% × 3 beats a roll of 50
  roll(stores, loot, 1, random(50), rates);
  expect(loot.items).toHaveLength(1);
});

test("quest drops roll for everyone and land in quest_items; FillLoot then gives them to players on the quest", () => {
  const items = [proto(50), proto(51)];
  const db = world(items, {
    creature_loot_template: [
      { Entry: 1, Item: 50, QuestRequired: 1 },
      { Entry: 1, Item: 51 },
    ],
  });
  const stores = loadAllLootStores(db);
  expect(haveQuestLootFor(stores.creature, 1)).toBe(true);
  const loot = newLoot(items);
  const owner = {
    guid: 7n,
    teamId: 0,
    hasSkill: () => false,
    hasSpell: () => false,
    meetsConditions: () => true,
    hasQuestForItem: (itemId: number) => itemId === 50,
    questStatus: () => 0,
    questRewarded: () => false,
    prevQuestId: () => 0,
    hasItemCount: () => false,
    isMasterLooter: false,
  };
  expect(fillLoot(loot, 1, stores, stores.creature, owner, false, { random: random() })).toBe(true);
  expect(loot.items.map((item) => item.itemid)).toEqual([51]);
  expect(loot.quest_items.map((item) => item.itemid)).toEqual([50]);
  expect(loot.getPlayerQuestItems().get(7n)).toEqual([{ index: 0, is_looted: false }]);
  // one normal item and one quest item left to loot
  expect(loot.unlootedCount).toBe(2);
  expect(fillLoot(newLoot(items), 2, stores, stores.creature, owner, false)).toBe(false);
});
