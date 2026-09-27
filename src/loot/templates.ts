/**
 * AzerothCore `LootStore`, `LootTemplate`, and `LootTemplate::LootGroup` (`LootMgr.cpp`):
 * loading every `*_loot_template` table with its `conditions`, and `LootTemplate::Process`, which rolls into a `Loot`.
 *
 * SQL columns (every `*_loot_template` dump): Entry, Item, Reference, Chance,
 * QuestRequired, LootMode, GroupId, MinCount, MaxCount, Comment.
 */

import type { MySqlTable } from "drizzle-orm/mysql-core";
import * as worldSchema from "../database/schema/world.ts";
import { conditions as conditionsTable, item_template } from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { randChance, rollChanceF, urand } from "../common/random.ts";
import { ServerConfig, type WorldConfig } from "../game/world/world-config.ts";
import type { ConditionRow } from "../world/gossip.ts";
import type { Loot, LootPlayer, LootStoreItem } from "./loot.ts";

/** `LootModes::LOOT_MODE_DEFAULT` */
export const LOOT_MODE_DEFAULT = 0x01;

export const LOOT_STORE_KIND = {
  creature: "creature",
  gameobject: "gameobject",
  pickpocket: "pickpocket",
  skinning: "skinning",
  fishing: "fishing",
  disenchant: "disenchant",
  milling: "milling",
  prospecting: "prospecting",
  item: "item",
  spell: "spell",
  mail: "mail",
  player: "player",
  reference: "reference",
} as const;

export type LootStoreKind = (typeof LOOT_STORE_KIND)[keyof typeof LOOT_STORE_KIND];

/** Table name and whether `LootStore` allows quality/reference rate modifiers. */
export const LOOT_STORE_META: Record<
  LootStoreKind,
  { tableName: string; entryName: string; ratesAllowed: boolean }
> = {
  creature: {
    tableName: "creature_loot_template",
    entryName: "creature entry",
    ratesAllowed: true,
  },
  gameobject: {
    tableName: "gameobject_loot_template",
    entryName: "gameobject entry",
    ratesAllowed: true,
  },
  pickpocket: {
    tableName: "pickpocketing_loot_template",
    entryName: "creature pickpocket lootid",
    ratesAllowed: true,
  },
  skinning: {
    tableName: "skinning_loot_template",
    entryName: "creature skinning id",
    ratesAllowed: true,
  },
  fishing: {
    tableName: "fishing_loot_template",
    entryName: "area id",
    ratesAllowed: true,
  },
  disenchant: {
    tableName: "disenchant_loot_template",
    entryName: "item disenchant id",
    ratesAllowed: true,
  },
  milling: {
    tableName: "milling_loot_template",
    entryName: "item entry (herb)",
    ratesAllowed: true,
  },
  prospecting: {
    tableName: "prospecting_loot_template",
    entryName: "item entry (ore)",
    ratesAllowed: true,
  },
  item: {
    tableName: "item_loot_template",
    entryName: "item entry",
    ratesAllowed: true,
  },
  spell: {
    tableName: "spell_loot_template",
    entryName: "spell id (random item creating)",
    ratesAllowed: false,
  },
  mail: {
    tableName: "mail_loot_template",
    entryName: "mail template id",
    ratesAllowed: false,
  },
  player: {
    tableName: "player_loot_template",
    entryName: "team id",
    ratesAllowed: true,
  },
  reference: {
    tableName: "reference_loot_template",
    entryName: "reference id",
    ratesAllowed: false,
  },
};

export const LOOT_TABLE_NAMES: readonly string[] = Object.values(LOOT_STORE_META).map(
  (meta) => meta.tableName,
);

const TABLE_TO_KIND = new Map<string, LootStoreKind>(
  (Object.entries(LOOT_STORE_META) as [LootStoreKind, (typeof LOOT_STORE_META)[LootStoreKind]][]).map(
    ([kind, meta]) => [meta.tableName, kind],
  ),
);


type DbLootRow = {
  Entry: number;
  Item: number;
  Reference: number;
  Chance: number;
  QuestRequired: number;
  LootMode: number;
  GroupId: number;
  MinCount: number;
  MaxCount: number;
  Comment: string | null;
};

/** The drizzle table for each `*_loot_template` name. */
export function lootTable(tableName: string): MySqlTable {
  const table = (worldSchema as Record<string, unknown>)[tableName];
  if (!table || !LOOT_TABLE_NAMES.includes(tableName)) {
    throw new Error(`Unknown loot template table: ${tableName}`);
  }
  return table as MySqlTable;
}

export function kindForLootTable(tableName: string): LootStoreKind | null {
  return TABLE_TO_KIND.get(tableName) ?? null;
}

export function tableNameForLootKind(kind: LootStoreKind): string {
  switch (kind) {
    case LOOT_STORE_KIND.creature:
      return LOOT_STORE_META.creature.tableName;
    case LOOT_STORE_KIND.gameobject:
      return LOOT_STORE_META.gameobject.tableName;
    case LOOT_STORE_KIND.pickpocket:
      return LOOT_STORE_META.pickpocket.tableName;
    case LOOT_STORE_KIND.skinning:
      return LOOT_STORE_META.skinning.tableName;
    case LOOT_STORE_KIND.fishing:
      return LOOT_STORE_META.fishing.tableName;
    case LOOT_STORE_KIND.disenchant:
      return LOOT_STORE_META.disenchant.tableName;
    case LOOT_STORE_KIND.milling:
      return LOOT_STORE_META.milling.tableName;
    case LOOT_STORE_KIND.prospecting:
      return LOOT_STORE_META.prospecting.tableName;
    case LOOT_STORE_KIND.item:
      return LOOT_STORE_META.item.tableName;
    case LOOT_STORE_KIND.spell:
      return LOOT_STORE_META.spell.tableName;
    case LOOT_STORE_KIND.mail:
      return LOOT_STORE_META.mail.tableName;
    case LOOT_STORE_KIND.player:
      return LOOT_STORE_META.player.tableName;
    case LOOT_STORE_KIND.reference:
      return LOOT_STORE_META.reference.tableName;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}


/** `ConditionSourceType` of each loot store (`CONDITION_SOURCE_TYPE_*_LOOT_TEMPLATE`). */
export const LOOT_CONDITION_SOURCE: Record<LootStoreKind, number> = {
  creature: 1,
  disenchant: 2,
  fishing: 3,
  gameobject: 4,
  item: 5,
  mail: 6,
  milling: 7,
  pickpocket: 8,
  prospecting: 9,
  reference: 10,
  skinning: 11,
  spell: 12,
  player: 28,
};

/** `LootTemplate::LootGroup`: a set of loot definitions for items (refs are not allowed inside). */
export type LootGroup = {
  /** Entries with chances defined in DB */
  explicitlyChanced: LootStoreItem[];
  /** Zero chances - every entry takes the same chance */
  equalChanced: LootStoreItem[];
};

/** `LootTemplate` */
export type LootTemplate = {
  /** not grouped only */
  entries: LootStoreItem[];
  /** `Groups[groupid - 1]`; groups have own (optimised) processing, grouped entries go there */
  groups: (LootGroup | null)[];
};

/** `LootStore` */
export type LootStore = {
  kind: LootStoreKind;
  tableName: string;
  entryName: string;
  ratesAllowed: boolean;
  templates: Map<number, LootTemplate>;
};

export type LootStores = Record<LootStoreKind, LootStore>;

/** The `World` rates `LootStoreItem::Roll` and `LootTemplate::Process` read. */
export type LootRates = {
  /** `RATE_DROP_ITEM_POOR` .. `RATE_DROP_ITEM_ARTIFACT`, by `ItemQualities` (`qualityToRate`). */
  quality: readonly number[];
  /** `RATE_DROP_ITEM_REFERENCED` */
  referenced: number;
  /** `RATE_DROP_ITEM_REFERENCED_AMOUNT` */
  referencedAmount: number;
  /** `RATE_DROP_ITEM_GROUP_AMOUNT` */
  groupAmount: number;
  /** `RATE_DROP_MONEY` (`Loot::generateMoneyLoot`) */
  money: number;
};

export const DEFAULT_LOOT_RATES: LootRates = {
  quality: [1, 1, 1, 1, 1, 1, 1],
  referenced: 1,
  referencedAmount: 1,
  groupAmount: 1,
  money: 1,
};

let configuredLootRates: LootRates = DEFAULT_LOOT_RATES;

/** Reads the `Rate.Drop.*` settings from `worldserver.conf` for every loot rolled afterwards. */
export function configureLootRates(settings: WorldConfig): LootRates {
  configuredLootRates = {
    quality: [
      settings.getFloat(ServerConfig.RATE_DROP_ITEM_POOR),
      settings.getFloat(ServerConfig.RATE_DROP_ITEM_NORMAL),
      settings.getFloat(ServerConfig.RATE_DROP_ITEM_UNCOMMON),
      settings.getFloat(ServerConfig.RATE_DROP_ITEM_RARE),
      settings.getFloat(ServerConfig.RATE_DROP_ITEM_EPIC),
      settings.getFloat(ServerConfig.RATE_DROP_ITEM_LEGENDARY),
      settings.getFloat(ServerConfig.RATE_DROP_ITEM_ARTIFACT),
    ],
    referenced: settings.getFloat(ServerConfig.RATE_DROP_ITEM_REFERENCED),
    referencedAmount: settings.getFloat(ServerConfig.RATE_DROP_ITEM_REFERENCED_AMOUNT),
    groupAmount: settings.getFloat(ServerConfig.RATE_DROP_ITEM_GROUP_AMOUNT),
    money: settings.getFloat(ServerConfig.RATE_DROP_MONEY),
  };
  return configuredLootRates;
}

/** The configured `Rate.Drop.*` values. */
export function lootRates(): LootRates {
  return configuredLootRates;
}

/** `ITEM_QUALITY_HEIRLOOM` */
const ITEM_QUALITY_HEIRLOOM = 7;
/** Trophy of the Crusade: stays out of the three-drop limit for non-equippable items. */
const TROPHY_OF_THE_CRUSADE = 47242;

export type LootRandom = {
  /** `roll_chance_f` */
  rollChance: (chance: number) => boolean;
  /** `rand_chance`: [0, 100) */
  randChance: () => number;
  /** `urand`: inclusive */
  urand: (min: number, max: number) => number;
};

export const DEFAULT_LOOT_RANDOM: LootRandom = { rollChance: rollChanceF, randChance, urand };

/** What `LootTemplate::Process` needs besides the loot: the reference store, rates, and the rng. */
export type LootProcessContext = {
  /** `LootTemplates_Reference` */
  reference: LootStore;
  rates?: LootRates;
  random?: LootRandom;
};

function emptyTemplate(): LootTemplate {
  return { entries: [], groups: [] };
}

/** `LootTemplate::AddEntry` */
function addEntry(template: LootTemplate, item: LootStoreItem): void {
  if (item.groupid > 0) {
    // Group and grouped reference
    let group = template.groups[item.groupid - 1];
    while (template.groups.length < item.groupid) {
      template.groups.push(null);
    }
    if (!group) {
      group = { explicitlyChanced: [], equalChanced: [] };
      template.groups[item.groupid - 1] = group;
    }
    // `LootGroup::AddEntry`
    if (item.chance !== 0) {
      group.explicitlyChanced.push(item);
    } else {
      group.equalChanced.push(item);
    }
    return;
  }
  // Non-grouped entries
  template.entries.push(item);
}

/** `LootStoreItem::IsValid` */
function isValidStoreItem(world: WorldTables, item: LootStoreItem): boolean {
  // it stored in 7 bit field
  if (item.groupid >= 1 << 7) {
    return false;
  }
  if (item.mincount === 0) {
    return false;
  }
  if (!item.reference) {
    // item (quest or non-quest) entry, maybe grouped
    if (!world.first(item_template, "entry", item.itemid)) {
      return false;
    }
    // Zero chance is allowed for grouped entries only
    if (item.chance === 0 && item.groupid === 0) {
      return false;
    }
    // loot with low chance
    if (item.chance !== 0 && item.chance < 0.000001) {
      return false;
    }
    // wrong max count
    if (item.maxcount < item.mincount) {
      return false;
    }
  } else if (!item.needs_quest && item.chance === 0 && item.groupid === 0) {
    // zero chance is specified for an ungrouped reference
    return false;
  }
  return true;
}

/** `LootTemplate::addConditionItem`: the condition goes to the first entry of that item, ungrouped first. */
function addConditionItem(template: LootTemplate, itemId: number, condition: ConditionRow): boolean {
  const lists = [template.entries, ...template.groups.flatMap((group) => (group ? [group.explicitlyChanced, group.equalChanced] : []))];
  for (const list of lists) {
    const item = list.find((entry) => entry.itemid === itemId);
    if (item) {
      item.conditions.push(condition);
      return true;
    }
  }
  return false;
}

/** `LootStore::LoadLootTable`, then the `ConditionMgr` rows of the store's source type. */
export function loadLootStore(world: WorldTables, tableName: string): LootStore {
  const kind = kindForLootTable(tableName);
  if (kind === null) {
    throw new Error(`Unknown loot template table: ${tableName}`);
  }
  const meta = LOOT_STORE_META[kind];
  const templates = new Map<number, LootTemplate>();
  for (const row of world.all(lootTable(tableName)) as readonly DbLootRow[]) {
    let lootmode = row.LootMode & 0xffff;
    if (lootmode === 0) {
      // LootMode is equal to 0, item will never drop - setting mode 1
      lootmode = 1;
    }
    const storeitem: LootStoreItem = {
      itemid: row.Item >>> 0,
      reference: row.Reference | 0,
      chance: Math.fround(Number(row.Chance)),
      needs_quest: (row.QuestRequired | 0) !== 0,
      lootmode,
      groupid: row.GroupId & 0xff,
      mincount: row.MinCount & 0xff,
      maxcount: row.MaxCount & 0xff,
      conditions: [],
    };
    if (!isValidStoreItem(world, storeitem)) {
      continue;
    }
    const entry = row.Entry >>> 0;
    let template = templates.get(entry);
    if (!template) {
      template = emptyTemplate();
      templates.set(entry, template);
    }
    addEntry(template, storeitem);
  }

  const sourceType = LOOT_CONDITION_SOURCE[kind];
  for (const row of world.where(conditionsTable, "SourceTypeOrReferenceId", sourceType)) {
    const template = templates.get(row.SourceGroup >>> 0);
    if (!template) {
      continue;
    }
    addConditionItem(template, row.SourceEntry >>> 0, {
      elseGroup: row.ElseGroup,
      conditionType: row.ConditionTypeOrReference,
      value1: row.ConditionValue1,
      value2: row.ConditionValue2,
      value3: row.ConditionValue3,
      negative: row.NegativeCondition !== 0,
    });
  }

  return {
    kind,
    tableName: meta.tableName,
    entryName: meta.entryName,
    ratesAllowed: meta.ratesAllowed,
    templates,
  };
}

export function loadLootStoreByKind(world: WorldTables, kind: LootStoreKind): LootStore {
  return loadLootStore(world, tableNameForLootKind(kind));
}

/** `LoadLootTables`: every store. */
export function loadAllLootStores(db: WorldTables): LootStores {
  return {
    creature: loadLootStoreByKind(db, LOOT_STORE_KIND.creature),
    gameobject: loadLootStoreByKind(db, LOOT_STORE_KIND.gameobject),
    pickpocket: loadLootStoreByKind(db, LOOT_STORE_KIND.pickpocket),
    skinning: loadLootStoreByKind(db, LOOT_STORE_KIND.skinning),
    fishing: loadLootStoreByKind(db, LOOT_STORE_KIND.fishing),
    disenchant: loadLootStoreByKind(db, LOOT_STORE_KIND.disenchant),
    milling: loadLootStoreByKind(db, LOOT_STORE_KIND.milling),
    prospecting: loadLootStoreByKind(db, LOOT_STORE_KIND.prospecting),
    item: loadLootStoreByKind(db, LOOT_STORE_KIND.item),
    spell: loadLootStoreByKind(db, LOOT_STORE_KIND.spell),
    mail: loadLootStoreByKind(db, LOOT_STORE_KIND.mail),
    player: loadLootStoreByKind(db, LOOT_STORE_KIND.player),
    reference: loadLootStoreByKind(db, LOOT_STORE_KIND.reference),
  };
}

const storesByWorld = new WeakMap<WorldTables, LootStores>();

/** The `LootTemplates_*` globals for a world, loaded once. */
export function lootStores(world: WorldTables): LootStores {
  let stores = storesByWorld.get(world);
  if (!stores) {
    stores = loadAllLootStores(world);
    storesByWorld.set(world, stores);
  }
  return stores;
}

/** `LootStore::GetLootFor` */
export function getLootTemplate(store: LootStore, lootId: number): LootTemplate | null {
  return store.templates.get(lootId >>> 0) ?? null;
}

/** `LootStore::HaveLootFor` */
export function haveLootFor(store: LootStore, lootId: number): boolean {
  return store.templates.has(lootId >>> 0);
}

/** `LootStoreItem::Roll`: checks if the entry (quest, non-quest, reference) takes it's chance (at loot generation). */
function rollStoreItem(item: LootStoreItem, rate: boolean, loot: Loot, rates: LootRates, random: LootRandom): boolean {
  if (item.chance >= 100) {
    return true;
  }
  // reference case
  if (item.reference) {
    return random.rollChance(item.chance * (rate ? rates.referenced : 1));
  }
  const proto = loot.env.itemProto(item.itemid);
  let qualityModifier = 1;
  if (proto && proto.Quality < ITEM_QUALITY_HEIRLOOM && rate) {
    qualityModifier = rates.quality[proto.Quality] ?? 1;
  }
  return random.rollChance(item.chance * qualityModifier);
}

/** `LootGroupInvalidSelector`: loot mode mismatch, a missing template, or the per-group duplicate limit. */
function invalidForGroup(loot: Loot, lootMode: number, item: LootStoreItem): boolean {
  if (!(item.lootmode & lootMode)) {
    return true;
  }
  if (!item.reference) {
    const proto = loot.env.itemProto(item.itemid);
    if (!proto) {
      return true;
    }
    let foundDuplicates = 0;
    for (const lootItem of loot.items) {
      if (lootItem.itemid === item.itemid && lootItem.groupid === item.groupid) {
        ++foundDuplicates;
        // Non-equippable items are limited to 3 drops
        if (proto.InventoryType === 0 && foundDuplicates === 3 && proto.entry !== TROPHY_OF_THE_CRUSADE) {
          return true;
        }
        // Equippable item are limited to 1 drop
        if (proto.InventoryType !== 0 && foundDuplicates === 1) {
          return true;
        }
      }
    }
  }
  return false;
}

/** `LootTemplate::LootGroup::Roll`: rolls an item from the group, returns null if all miss their chances. */
function rollGroup(group: LootGroup, loot: Loot, lootMode: number, random: LootRandom): LootStoreItem | null {
  let possibleLoot = group.explicitlyChanced.filter((item) => !invalidForGroup(loot, lootMode, item));
  // First explicitly chanced entries are checked
  if (possibleLoot.length > 0) {
    let roll = random.randChance();
    for (const item of possibleLoot) {
      if (item.chance >= 100) {
        return item;
      }
      roll -= item.chance;
      if (roll < 0) {
        return item;
      }
    }
  }
  possibleLoot = group.equalChanced.filter((item) => !invalidForGroup(loot, lootMode, item));
  // If nothing selected yet - an item is taken from equal-chanced part
  if (possibleLoot.length > 0) {
    return possibleLoot[random.urand(0, possibleLoot.length - 1)]!;
  }
  // Empty drop from the group
  return null;
}

/** `LootTemplate::LootGroup::Process`: rolls an item from the group (if any takes its chance) and adds the item to the loot. */
function processGroup(group: LootGroup, loot: Loot, store: LootStore, lootMode: number, nonRefIterationsLeft: number, ctx: LootProcessContext): void {
  const rates = ctx.rates ?? configuredLootRates;
  const random = ctx.random ?? DEFAULT_LOOT_RANDOM;
  const item = rollGroup(group, loot, lootMode, random);
  if (!item) {
    return;
  }
  if (item.reference) {
    // References processing
    const referenced = getLootTemplate(ctx.reference, Math.abs(item.reference));
    if (referenced) {
      const maxcount = Math.trunc(Math.fround(item.maxcount * rates.referencedAmount)) >>> 0;
      // Ref multiplicator
      for (let loop = 0; loop < maxcount; ++loop) {
        // This reference needs to be processed further, but it is marked isTopLevel=false so that any groups inside
        // the reference are not multiplied by Rate.Drop.Item.GroupAmount
        processTemplate(referenced, loot, store, lootMode, 0, false, ctx);
      }
    }
    return;
  }
  // Plain entries (not a reference, not grouped)
  // Chance is already checked, just add
  loot.addItem(item, random.urand);
  // If we still have non-ref runs to do for this group AND this item wasn't a reference,
  // recursively call this function to produce more items for this group.
  // However, if this is a quest item we shouldn't multiply this group.
  if (nonRefIterationsLeft > 1 && !item.needs_quest) {
    processGroup(group, loot, store, lootMode, nonRefIterationsLeft - 1, ctx);
  }
}

/** `LootTemplate::Process`: rolls for every item in the template and adds the rolled items the the loot. */
export function processTemplate(
  template: LootTemplate,
  loot: Loot,
  store: LootStore,
  lootMode: number,
  groupId: number,
  isTopLevel: boolean,
  ctx: LootProcessContext,
): void {
  const rate = store.ratesAllowed;
  const rates = ctx.rates ?? configuredLootRates;
  const random = ctx.random ?? DEFAULT_LOOT_RANDOM;
  // `Rate.Drop.Item.GroupAmount` is a float read into a uint16.
  const groupAmount = Math.trunc(rates.groupAmount) & 0xffff;

  // Group reference uses own processing of the group
  if (groupId) {
    const group = template.groups[groupId - 1];
    if (!group) {
      return;
    }
    // Rate.Drop.Item.GroupAmount is only in effect for the top loot template level
    processGroup(group, loot, store, lootMode, isTopLevel ? groupAmount : 0, ctx);
    return;
  }

  // Rolling non-grouped items
  for (const item of template.entries) {
    // Do not add if mode mismatch
    if (!(item.lootmode & lootMode)) {
      continue;
    }
    // Bad luck for the entry
    if (!rollStoreItem(item, rate, loot, rates, random)) {
      continue;
    }
    if (item.reference) {
      // References processing
      const referenced = getLootTemplate(ctx.reference, Math.abs(item.reference));
      if (!referenced) {
        continue;
      }
      const maxcount = Math.trunc(Math.fround(item.maxcount * rates.referencedAmount)) >>> 0;
      // Ref multiplicator
      for (let loop = 0; loop < maxcount; ++loop) {
        // we're no longer in the top level, so isTopLevel is false
        processTemplate(referenced, loot, store, lootMode, item.groupid, false, ctx);
      }
    } else {
      // Plain entries (not a reference, not grouped)
      // Chance is already checked, just add
      loot.addItem(item, random.urand);
    }
  }

  // Now processing groups
  for (const group of template.groups) {
    if (group) {
      // Rate.Drop.Item.GroupAmount is only in effect for the top loot template level
      processGroup(group, loot, store, lootMode, isTopLevel ? groupAmount : 0, ctx);
    }
  }
}

/**
 * `LootTemplate::HasQuestDrop`: true if template includes at least 1 quest drop entry.
 * References are looked up in the same store, as `LootStore::HaveQuestLootFor` passes its own templates.
 */
export function hasQuestDrop(template: LootTemplate, store: LootStore, visiting = new Set<LootTemplate>()): boolean {
  if (visiting.has(template)) {
    return false;
  }
  visiting.add(template);
  const lists = [template.entries, ...template.groups.flatMap((group) => (group ? [group.explicitlyChanced, group.equalChanced] : []))];
  for (const list of lists) {
    for (const item of list) {
      if (item.reference) {
        const referenced = getLootTemplate(store, Math.abs(item.reference));
        if (referenced && hasQuestDrop(referenced, store, visiting)) {
          return true;
        }
      } else if (item.needs_quest) {
        return true;
      }
    }
  }
  return false;
}

/** `LootTemplate::HasQuestDropForPlayer`: true if template includes at least 1 quest drop for an active quest of the player. */
export function hasQuestDropForPlayer(template: LootTemplate, store: LootStore, player: Pick<LootPlayer, "hasQuestForItem">, visiting = new Set<LootTemplate>()): boolean {
  if (visiting.has(template)) {
    return false;
  }
  visiting.add(template);
  const lists = [template.entries, ...template.groups.flatMap((group) => (group ? [group.explicitlyChanced, group.equalChanced] : []))];
  for (const list of lists) {
    for (const item of list) {
      if (item.reference) {
        const referenced = getLootTemplate(store, Math.abs(item.reference));
        if (referenced && hasQuestDropForPlayer(referenced, store, player, visiting)) {
          return true;
        }
      } else if (player.hasQuestForItem(item.itemid)) {
        return true;
      }
    }
  }
  return false;
}

/** `LootStore::HaveQuestLootFor` */
export function haveQuestLootFor(store: LootStore, lootId: number): boolean {
  const template = getLootTemplate(store, lootId);
  return template ? hasQuestDrop(template, store) : false;
}

/** `LootStore::HaveQuestLootForPlayer` */
export function haveQuestLootForPlayer(store: LootStore, lootId: number, player: Pick<LootPlayer, "hasQuestForItem">): boolean {
  const template = getLootTemplate(store, lootId);
  return template ? hasQuestDropForPlayer(template, store, player) : false;
}

/**
 * `Loot::FillLoot` from a store: the template's `Process` into `loot` for `lootOwner`.
 * Returns false when the store has no rows for the loot id.
 */
export function fillLoot(
  loot: Loot,
  lootId: number,
  stores: LootStores,
  store: LootStore,
  lootOwner: LootPlayer,
  personal: boolean,
  opts: { lootMode?: number; rates?: LootRates; random?: LootRandom; group?: Parameters<Loot["fillLoot"]>[1]; storeCurrency?: Parameters<Loot["fillLoot"]>[4] } = {},
): boolean {
  const template = getLootTemplate(store, lootId);
  const ctx: LootProcessContext = { reference: stores.reference, rates: opts.rates, random: opts.random };
  return loot.fillLoot(
    lootOwner,
    opts.group ?? null,
    personal,
    template ? (target) => processTemplate(template, target, store, opts.lootMode ?? LOOT_MODE_DEFAULT, 0, true, ctx) : null,
    opts.storeCurrency,
  );
}
