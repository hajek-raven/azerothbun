/**
 * `Loot`, `LootItem`, `QuestItem`, and `LootView` from AzerothCore `LootMgr.h` / `LootMgr.cpp`.
 * The template rolls (`LootTemplate::Process`) live in `templates.ts` and call `Loot.addItem`.
 */

import { ByteWriter } from "../net/byte-buffer.ts";
import type { ConditionRow } from "../world/gossip.ts";

/** SMSG_LOOT_RESPONSE */
export const SMSG_LOOT_RESPONSE = 0x160;

/** `MAX_NR_LOOT_ITEMS` */
export const MAX_NR_LOOT_ITEMS = 18;
/** `MAX_NR_QUEST_ITEMS`: unrelated to the client's item count, which is 16 normal + 32 quest. */
export const MAX_NR_QUEST_ITEMS = 32;

/** `LootType` */
export const LootType = {
  NONE: 0,
  CORPSE: 1,
  PICKPOCKETING: 2,
  FISHING: 3,
  DISENCHANTING: 4,
  // ignored always by client
  SKINNING: 6,
  PROSPECTING: 7,
  MILLING: 8,
  // unsupported by client, sending LOOT_FISHING instead
  FISHINGHOLE: 20,
  // unsupported by client, sending LOOT_CORPSE instead
  INSIGNIA: 21,
  // unsupported by client, sending LOOT_FISHING instead
  FISHING_JUNK: 22,
} as const;

export type LootTypeValue = (typeof LootType)[keyof typeof LootType];

/** `LootError` */
export const LootError = {
  DIDNT_KILL: 0, // You don't have permission to loot that corpse.
  TOO_FAR: 4, // You are too far away to loot that corpse.
  BAD_FACING: 5, // You must be facing the corpse to loot it.
  LOCKED: 6, // Someone is already looting that corpse.
  NOTSTANDING: 8, // You need to be standing up to loot something!
  STUNNED: 9, // You can't loot anything while stunned!
  PLAYER_NOT_FOUND: 10, // Player not found
  PLAY_TIME_EXCEEDED: 11, // Maximum play time exceeded
  MASTER_INV_FULL: 12, // That player's inventory is full
  MASTER_UNIQUE_ITEM: 13, // Player has too many of that item already
  MASTER_OTHER: 14, // Can't assign item to that player
  ALREADY_PICKPOCKETED: 15, // Your target has already had its pockets picked
  NOT_WHILE_SHAPESHIFTED: 16, // You can't do that while shapeshifted.
} as const;

export type LootErrorValue = (typeof LootError)[keyof typeof LootError];

/** `LootSlotType`: type of a loot item in the loot view. */
export const LootSlotType = {
  ALLOW_LOOT: 0, // player can loot the item.
  ROLL_ONGOING: 1, // roll is ongoing. player cannot loot.
  MASTER: 2, // item can only be distributed by group loot master.
  LOCKED: 3, // item is shown in red. player cannot loot.
  OWNER: 4, // ignore binding confirmation and etc, for single player looting
} as const;

/** `PermissionTypes` */
export const PermissionTypes = {
  ALL: 0,
  GROUP: 1,
  MASTER: 2,
  RESTRICTED: 3,
  ROUND_ROBIN: 4,
  OWNER: 5,
  NONE: 6,
} as const;

export type PermissionType = (typeof PermissionTypes)[keyof typeof PermissionTypes];

/** `ItemFlags`, `ItemFlags2`, and `ItemFlagsCustom` bits the loot code reads. */
export const ITEM_FLAG_MULTI_DROP = 0x00000800;
export const ITEM_FLAG_HIDE_UNUSABLE_RECIPE = 0x02000000;
export const ITEM_FLAG2_FACTION_HORDE = 0x00000001;
export const ITEM_FLAG2_FACTION_ALLIANCE = 0x00000002;
export const ITEM_FLAGS_CU_IGNORE_QUEST_STATUS = 0x0002;
export const ITEM_FLAGS_CU_FOLLOW_LOOT_RULES = 0x0004;
const ITEM_CLASS_RECIPE = 9;
const BIND_WHEN_PICKED_UP = 1;
const BAG_FAMILY_MASK_CURRENCY_TOKENS = 0x00002000;
const TEAM_ALLIANCE = 0;
const TEAM_HORDE = 1;
const QUEST_STATUS_NONE = 0;

/** A `*_loot_template` row after `LootStore::LoadLootTable`. */
export type LootStoreItem = {
  itemid: number;
  reference: number;
  chance: number;
  needs_quest: boolean;
  lootmode: number;
  groupid: number;
  mincount: number;
  maxcount: number;
  /** `ConditionMgr` rows for this item in this template. */
  conditions: ConditionRow[];
};

/** The `ItemTemplate` fields loot reads. */
export type LootItemProto = {
  entry: number;
  Quality: number;
  Flags: number;
  FlagsExtra: number;
  flagsCustom: number;
  class: number;
  bonding: number;
  InventoryType: number;
  stackable: number;
  maxcount: number;
  BagFamily: number;
  RequiredSkill: number;
  spellid_2: number;
  startquest: number;
  displayid: number;
};

/** `ItemTemplate::GetMaxStackSize` */
export function maxStackSize(proto: LootItemProto): number {
  return proto.stackable === 2147483647 || proto.stackable <= 0 ? 0x7ffffffe : proto.stackable;
}

/** World lookups a loot needs: item templates and the random enchant rolls of a new `LootItem`. */
export type LootEnv = {
  itemProto(entry: number): LootItemProto | null;
  /** `GenerateEnchSuffixFactor` */
  enchSuffixFactor(entry: number): number;
  /** `Item::GenerateItemRandomPropertyId` */
  randomPropertyId(entry: number): number;
  /** `sDisableMgr->IsDisabledFor(DISABLE_TYPE_LOOT, itemid)` */
  lootDisabled?(entry: number): boolean;
};

/** The `Player` side `LootItem::AllowedForPlayer`, `FillQuestLoot`, and `LootView` ask about. */
export type LootPlayer = {
  guid: bigint;
  /** `Player::GetTeamId(true)` */
  teamId: number;
  hasSkill(skill: number): boolean;
  hasSpell(spell: number): boolean;
  meetsConditions(conditions: readonly ConditionRow[]): boolean;
  /** `Player::HasQuestForItem(itemid, 0, false, showInLoot)`; clears `showInLoot.value` when only the stack count keeps it from showing. */
  hasQuestForItem(itemId: number, showInLoot?: { value: boolean }): boolean;
  questStatus(questId: number): number;
  questRewarded(questId: number): boolean;
  /** `Quest::GetPrevQuestId` */
  prevQuestId(questId: number): number;
  /** `Player::HasItemCount(item, count, inBankAlso)` */
  hasItemCount(itemId: number, count: number, inBankAlso: boolean): boolean;
  /** In a group whose master looter is this player. */
  isMasterLooter: boolean;
};

/** `QuestItem`: position in `quest_items` (or `items` for FFA and conditional lists). */
export type QuestItem = { index: number; is_looted: boolean };

export class LootItem {
  itemid: number;
  itemIndex = 0;
  randomSuffix: number;
  randomPropertyId: number;
  conditions: ConditionRow[];
  allowedGUIDs = new Set<bigint>();
  /** Stores the guid of person who won loot, if his bags are full only he can see the item in loot list! */
  rollWinnerGUID = 0n;
  count = 0;
  is_looted = false;
  is_blocked = false;
  freeforall: boolean;
  is_underthreshold = false;
  is_counted = false;
  needs_quest: boolean;
  follow_loot_rules: boolean;
  groupid: number;

  /** `LootItem::LootItem(LootStoreItem const&)`: copies the row and rolls the random suffix and property. */
  constructor(li: LootStoreItem, env: LootEnv) {
    this.itemid = li.itemid;
    this.conditions = li.conditions;
    const proto = env.itemProto(li.itemid);
    this.freeforall = !!proto && (proto.Flags & ITEM_FLAG_MULTI_DROP) !== 0;
    this.follow_loot_rules = !!proto && (proto.flagsCustom & ITEM_FLAGS_CU_FOLLOW_LOOT_RULES) !== 0;
    this.needs_quest = li.needs_quest;
    this.randomSuffix = env.enchSuffixFactor(li.itemid);
    this.randomPropertyId = env.randomPropertyId(li.itemid);
    this.groupid = li.groupid;
  }

  /** `LootItem::AllowedForPlayer`: basic checks for player/item compatibility - if false no chance to see the item in the loot. */
  allowedForPlayer(player: LootPlayer, env: LootEnv): boolean {
    const proto = env.itemProto(this.itemid);
    if (!proto) {
      return false;
    }
    if (env.lootDisabled?.(this.itemid)) {
      return false;
    }
    if (!player.meetsConditions(this.conditions)) {
      return false;
    }
    // not show loot for not own team
    if (proto.FlagsExtra & ITEM_FLAG2_FACTION_HORDE && player.teamId !== TEAM_HORDE) {
      return false;
    }
    if (proto.FlagsExtra & ITEM_FLAG2_FACTION_ALLIANCE && player.teamId !== TEAM_ALLIANCE) {
      return false;
    }
    // profession / recipe checks
    if (proto.Flags & ITEM_FLAG_HIDE_UNUSABLE_RECIPE && (!player.hasSkill(proto.RequiredSkill) || player.hasSpell(proto.spellid_2))) {
      return false;
    }
    if (proto.class === ITEM_CLASS_RECIPE && proto.bonding === BIND_WHEN_PICKED_UP && proto.spellid_2 !== 0 && player.hasSpell(proto.spellid_2)) {
      return false;
    }
    // check quest requirements
    if (!(proto.flagsCustom & ITEM_FLAGS_CU_IGNORE_QUEST_STATUS)) {
      if (this.needs_quest && !player.hasQuestForItem(this.itemid)) {
        return false;
      }
      // Hide quest starter items when quest is already started/rewarded,
      // when unique count is already reached, or when prerequisite is missing.
      if (proto.startquest) {
        const prevQuestId = player.prevQuestId(proto.startquest);
        if (
          player.questStatus(proto.startquest) !== QUEST_STATUS_NONE ||
          player.questRewarded(proto.startquest) ||
          (proto.maxcount && player.hasItemCount(this.itemid, proto.maxcount, true)) ||
          (prevQuestId && !player.questRewarded(prevQuestId))
        ) {
          return false;
        }
      }
    }
    return true;
  }

  addAllowedLooter(player: LootPlayer): void {
    this.allowedGUIDs.add(player.guid);
  }
}

/** `Loot::LootItemInSlot` result: the item and the per-player entry that tracks it, if any. */
export type LootSlotItem = {
  item: LootItem;
  qitem: QuestItem | null;
  ffaitem: QuestItem | null;
  conditem: QuestItem | null;
};

/** The group a loot is filled for (`Player::GetGroup`), as far as `Loot` needs it. */
export type LootGroupView = {
  /** Members that are at loot reward distance of the loot source. */
  membersInRange: readonly LootPlayer[];
  members: readonly LootPlayer[];
  lootThreshold: number;
};

export class Loot {
  items: LootItem[] = [];
  quest_items: LootItem[] = [];
  gold = 0;
  unlootedCount = 0;
  /** GUID of the player having the Round-Robin ownership for the loot. If 0, round robin owner has released. */
  roundRobinPlayer = 0n;
  lootOwnerGUID = 0n;
  /** required for achievement system */
  loot_type: LootTypeValue = LootType.NONE;
  /** GUID of container that holds this loot (item_instance.entry), set for items that can be looted */
  containerGUID = 0n;
  sourceWorldObjectGUID = 0n;

  private readonly PlayersLooting = new Set<bigint>();
  private readonly PlayerQuestItems = new Map<bigint, QuestItem[]>();
  private readonly PlayerFFAItems = new Map<bigint, QuestItem[]>();
  private readonly PlayerNonQuestNonFFAConditionalItems = new Map<bigint, QuestItem[]>();
  /** Who `AddItem` checks visibility for while `FillLoot` runs (`ObjectAccessor::FindPlayer(lootOwnerGUID)` and its group). */
  private fillingFor: { owner: LootPlayer; group: LootGroupView | null } | null = null;

  constructor(readonly env: LootEnv) {}

  getPlayerQuestItems(): ReadonlyMap<bigint, readonly QuestItem[]> {
    return this.PlayerQuestItems;
  }

  getPlayerFFAItems(): ReadonlyMap<bigint, readonly QuestItem[]> {
    return this.PlayerFFAItems;
  }

  getPlayerNonQuestNonFFAConditionalItems(): ReadonlyMap<bigint, readonly QuestItem[]> {
    return this.PlayerNonQuestNonFFAConditionalItems;
  }

  clear(): void {
    this.PlayerQuestItems.clear();
    this.PlayerFFAItems.clear();
    this.PlayerNonQuestNonFFAConditionalItems.clear();
    this.PlayersLooting.clear();
    this.items = [];
    this.quest_items = [];
    this.gold = 0;
    this.unlootedCount = 0;
    this.roundRobinPlayer = 0n;
    this.loot_type = LootType.NONE;
  }

  empty(): boolean {
    return this.items.length === 0 && this.gold === 0;
  }

  isLooted(): boolean {
    return this.gold === 0 && this.unlootedCount === 0;
  }

  addLooter(guid: bigint): void {
    this.PlayersLooting.add(guid);
  }

  removeLooter(guid: bigint): void {
    this.PlayersLooting.delete(guid);
  }

  /** `PlayersLooting` */
  looters(): bigint[] {
    return [...this.PlayersLooting];
  }

  /** `Loot::generateMoneyLoot` with `RATE_DROP_MONEY`. */
  generateMoneyLoot(minAmount: number, maxAmount: number, rateDropMoney: number, urand: (min: number, max: number) => number): void {
    if (maxAmount > 0) {
      if (maxAmount <= minAmount) {
        this.gold = Math.trunc(maxAmount * rateDropMoney) >>> 0;
      } else if (maxAmount - minAmount < 32700) {
        this.gold = Math.trunc(urand(minAmount, maxAmount) * rateDropMoney) >>> 0;
      } else {
        this.gold = (Math.trunc(urand(minAmount >>> 8, maxAmount >>> 8) * rateDropMoney) << 8) >>> 0;
      }
    }
  }

  /**
   * `Loot::FillLoot` around the caller's `LootTemplate::Process`: records the owner, rolls, then sets the access rights.
   * `process` is null when the store has no template for the loot id (the C++ returns false before rolling).
   */
  fillLoot(
    lootOwner: LootPlayer,
    group: LootGroupView | null,
    personal: boolean,
    process: ((loot: Loot) => void) | null,
    storeCurrency: (player: LootPlayer, lootSlot: number) => void = () => {},
  ): boolean {
    this.lootOwnerGUID = lootOwner.guid;
    if (!process) {
      return false;
    }
    this.fillingFor = { owner: lootOwner, group };
    try {
      process(this);
    } finally {
      this.fillingFor = null;
    }
    // Setting access rights for group loot case
    if (!personal && group) {
      this.roundRobinPlayer = lootOwner.guid;
      for (const player of group.membersInRange) {
        this.fillNotNormalLootFor(player, storeCurrency);
      }
      for (const item of this.items) {
        const proto = this.env.itemProto(item.itemid);
        if (proto && proto.Quality < group.lootThreshold) {
          item.is_underthreshold = true;
        }
      }
    } else {
      // ... for personal loot
      this.fillNotNormalLootFor(lootOwner, storeCurrency);
    }
    return true;
  }

  /** `Loot::AddItem`: inserts the item into the loot (called by LootTemplate processors). */
  addItem(item: LootStoreItem, urand: (min: number, max: number) => number): void {
    const proto = this.env.itemProto(item.itemid);
    if (!proto) {
      return;
    }
    const maxStack = maxStackSize(proto);
    let count = urand(item.mincount, item.maxcount);
    const stacks = Math.floor(count / maxStack) + (count % maxStack ? 1 : 0);
    const lootItems = item.needs_quest ? this.quest_items : this.items;
    const limit = item.needs_quest ? MAX_NR_QUEST_ITEMS : MAX_NR_LOOT_ITEMS;
    for (let i = 0; i < stacks && lootItems.length < limit; i++) {
      const generatedLoot = new LootItem(item, this.env);
      generatedLoot.count = Math.min(count, maxStack);
      generatedLoot.itemIndex = lootItems.length;
      lootItems.push(generatedLoot);
      count -= maxStack;

      // In some cases, a dropped item should be visible/lootable only for some players in group
      let canSeeItemInLootWindow = false;
      const filling = this.fillingFor;
      if (filling) {
        if (filling.group) {
          canSeeItemInLootWindow = filling.group.members.some((member) => generatedLoot.allowedForPlayer(member, this.env));
        } else if (generatedLoot.allowedForPlayer(filling.owner, this.env)) {
          canSeeItemInLootWindow = true;
        }
      }
      if (!canSeeItemInLootWindow) {
        continue;
      }
      // non-conditional one-player only items are counted here,
      // free for all items are counted in FillFFALoot(),
      // non-ffa conditionals are counted in FillNonQuestNonFFAConditionalLoot()
      if (!item.needs_quest && item.conditions.length === 0 && !(proto.Flags & ITEM_FLAG_MULTI_DROP)) {
        this.unlootedCount++;
      }
    }
  }

  /** `Loot::FillNotNormalLootFor`. Currency tokens are stored at once through `storeCurrency` (`Player::StoreLootItem`). */
  fillNotNormalLootFor(player: LootPlayer, storeCurrency: (player: LootPlayer, lootSlot: number) => void = () => {}): void {
    if (!this.PlayerQuestItems.has(player.guid)) {
      this.fillQuestLoot(player);
    }
    if (!this.PlayerFFAItems.has(player.guid)) {
      this.fillFFALoot(player);
    }
    if (!this.PlayerNonQuestNonFFAConditionalItems.has(player.guid)) {
      this.fillNonQuestNonFFAConditionalLoot(player);
    }
    // Process currency items
    const maxSlot = this.getMaxSlotInLootFor(player);
    const itemsSize = this.items.length;
    for (let i = 0; i < maxSlot; i++) {
      const item = i < itemsSize ? this.items[i] : this.quest_items[i - itemsSize];
      if (item && !item.is_looted && item.freeforall && item.allowedForPlayer(player, this.env)) {
        const proto = this.env.itemProto(item.itemid);
        if (proto && proto.BagFamily & BAG_FAMILY_MASK_CURRENCY_TOKENS) {
          storeCurrency(player, i);
        }
      }
    }
  }

  /** `Loot::FillFFALoot` */
  private fillFFALoot(player: LootPlayer): QuestItem[] | null {
    const ql: QuestItem[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      if (!item.is_looted && item.freeforall && item.allowedForPlayer(player, this.env)) {
        ql.push({ index: i, is_looted: false });
        this.unlootedCount++;
      }
    }
    if (ql.length === 0) {
      return null;
    }
    this.PlayerFFAItems.set(player.guid, ql);
    return ql;
  }

  /** `Loot::FillQuestLoot` */
  private fillQuestLoot(player: LootPlayer): QuestItem[] | null {
    if (this.items.length === MAX_NR_LOOT_ITEMS) {
      return null;
    }
    const ql: QuestItem[] = [];
    for (let i = 0; i < this.quest_items.length; i++) {
      const item = this.quest_items[i]!;
      const allowed = item.allowedForPlayer(player, this.env);
      if (!allowed && !player.isMasterLooter) {
        continue;
      }
      ql.push({ index: i, is_looted: false });
      // Only add "allowed looter" if you are actually allowed to loot.
      if (allowed) {
        item.addAllowedLooter(player);
        if (item.freeforall) {
          this.unlootedCount++;
        } else if (!item.is_counted) {
          this.unlootedCount++;
          item.is_counted = true;
        }
      }
      if (this.items.length + ql.length === MAX_NR_LOOT_ITEMS) {
        break;
      }
    }
    if (ql.length === 0) {
      return null;
    }
    this.PlayerQuestItems.set(player.guid, ql);
    return ql;
  }

  /** `Loot::FillNonQuestNonFFAConditionalLoot` */
  private fillNonQuestNonFFAConditionalLoot(player: LootPlayer): QuestItem[] | null {
    const ql: QuestItem[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      if (!item.is_looted && !item.freeforall && item.allowedForPlayer(player, this.env)) {
        item.addAllowedLooter(player);
        if (item.conditions.length > 0) {
          ql.push({ index: i, is_looted: false });
          if (!item.is_counted) {
            this.unlootedCount++;
            item.is_counted = true;
          }
        }
      }
    }
    if (ql.length === 0) {
      return null;
    }
    this.PlayerNonQuestNonFFAConditionalItems.set(player.guid, ql);
    return ql;
  }

  /** `Loot::NotifyItemRemoved`: every player looting sees the slot go. */
  notifyItemRemoved(): bigint[] {
    return this.looters();
  }

  /** `Loot::NotifyMoneyRemoved`: every player looting sees the money go. */
  notifyMoneyRemoved(): bigint[] {
    return this.looters();
  }

  /**
   * `Loot::NotifyQuestItemRemoved`: when a free for all questitem is looted all players will get notified of it being removed
   * (other questitems can be looted by each group member). Each looter gets the slot they see it in.
   */
  notifyQuestItemRemoved(questIndex: number): { guid: bigint; lootSlot: number }[] {
    const out: { guid: bigint; lootSlot: number }[] = [];
    for (const guid of this.PlayersLooting) {
      const pql = this.PlayerQuestItems.get(guid);
      if (!pql) {
        continue;
      }
      const j = pql.findIndex((qi) => qi.index === questIndex);
      if (j >= 0) {
        out.push({ guid, lootSlot: this.items.length + j });
      }
    }
    return out;
  }

  /** `Loot::LootItemInSlot` */
  lootItemInSlot(lootSlot: number, player: LootPlayer): LootSlotItem | null {
    let item: LootItem | null = null;
    let qitem: QuestItem | null = null;
    let ffaitem: QuestItem | null = null;
    let conditem: QuestItem | null = null;
    let is_looted = true;
    if (lootSlot >= this.items.length) {
      const questSlot = lootSlot - this.items.length;
      const list = this.PlayerQuestItems.get(player.guid);
      if (list && questSlot < list.length) {
        const qitem2 = list[questSlot]!;
        qitem = qitem2;
        item = this.quest_items[qitem2.index] ?? null;
        // such items (follow_loot_rules) are added to every player, but not everyone is allowed, check it here
        if (item && item.follow_loot_rules && !item.allowedForPlayer(player, this.env)) {
          return null;
        }
        is_looted = qitem2.is_looted;
      }
    } else {
      item = this.items[lootSlot]!;
      is_looted = item.is_looted;
      if (item.freeforall) {
        const ffa = this.PlayerFFAItems.get(player.guid)?.find((qi) => qi.index === lootSlot);
        if (ffa) {
          ffaitem = ffa;
          is_looted = ffa.is_looted;
        }
      } else if (item.conditions.length > 0) {
        const cond = this.PlayerNonQuestNonFFAConditionalItems.get(player.guid)?.find((qi) => qi.index === lootSlot);
        if (cond) {
          conditem = cond;
          is_looted = cond.is_looted;
        }
      }
    }
    if (is_looted || !item) {
      return null;
    }
    return { item, qitem, ffaitem, conditem };
  }

  /** `Loot::GetMaxSlotInLootFor` */
  getMaxSlotInLootFor(player: LootPlayer): number {
    return this.items.length + (this.PlayerQuestItems.get(player.guid)?.length ?? 0);
  }

  /** `Loot::hasItemForAll` */
  hasItemForAll(): boolean {
    // Gold is always lootable
    if (this.gold) {
      return true;
    }
    return this.items.some((item) => !item.is_looted && !item.freeforall && item.conditions.length === 0);
  }

  /** `Loot::hasItemFor`: true if there is any FFA, quest or conditional item for the player. */
  hasItemFor(player: Pick<LootPlayer, "guid">): boolean {
    for (const qi of this.PlayerQuestItems.get(player.guid) ?? []) {
      const item = this.quest_items[qi.index];
      if (item && !qi.is_looted && !item.is_looted) return true;
    }
    for (const fi of this.PlayerFFAItems.get(player.guid) ?? []) {
      const item = this.items[fi.index];
      if (item && !fi.is_looted && !item.is_looted) return true;
    }
    for (const ci of this.PlayerNonQuestNonFFAConditionalItems.get(player.guid) ?? []) {
      const item = this.items[ci.index];
      if (item && !ci.is_looted && !item.is_looted) return true;
    }
    return false;
  }

  /** `Loot::hasOverThresholdItem`: true if there is any item over the group threshold (i.e. not underthreshold). */
  hasOverThresholdItem(): boolean {
    return this.items.some((item) => !item.is_looted && !item.is_underthreshold && !item.freeforall);
  }
}

/** `operator<<(ByteBuffer&, LootItem const&)` without the slot type. */
function writeLootItem(b: ByteWriter, li: LootItem, env: LootEnv): void {
  b.writeU32(li.itemid);
  b.writeU32(li.count); // nr of items of this type
  b.writeU32(env.itemProto(li.itemid)?.displayid ?? 0);
  b.writeU32(li.randomSuffix >>> 0);
  b.writeU32(li.randomPropertyId >>> 0);
}

/** A slot type for a `follow_loot_rules` quest or conditional item. */
function followLootRulesSlotType(item: LootItem, permission: PermissionType, slotType: number): number {
  switch (permission) {
    case PermissionTypes.MASTER:
      return LootSlotType.MASTER;
    case PermissionTypes.RESTRICTED:
      return item.is_blocked ? LootSlotType.LOCKED : slotType;
    case PermissionTypes.GROUP:
    case PermissionTypes.ROUND_ROBIN:
      return item.is_blocked ? LootSlotType.ROLL_ONGOING : LootSlotType.ALLOW_LOOT;
    default:
      return slotType;
  }
}

/** `operator<<(ByteBuffer&, LootView const&)`: gold, item count, then the items this viewer sees. */
export function writeLootView(b: ByteWriter, l: Loot, viewer: LootPlayer, permission: PermissionType): void {
  if (permission === PermissionTypes.NONE) {
    b.writeU32(0); // gold
    b.writeU8(0); // item count
    return; // nothing output more
  }
  const env = l.env;
  const rows = new ByteWriter();
  let itemsShown = 0;
  const show = (lootSlot: number, item: LootItem, slotType: number): void => {
    rows.writeU8(lootSlot);
    writeLootItem(rows, item, env);
    rows.writeU8(slotType);
    itemsShown++;
  };

  switch (permission) {
    case PermissionTypes.GROUP:
    case PermissionTypes.MASTER:
    case PermissionTypes.RESTRICTED: {
      const isMasterLooter = viewer.isMasterLooter;
      // if you are not the round-robin group looter, you can only see
      // blocked rolled items and quest items, and !ffa items
      for (let i = 0; i < l.items.length; i++) {
        const item = l.items[i]!;
        if (item.is_looted || item.freeforall || (item.conditions.length > 0 && !isMasterLooter) || !item.allowedForPlayer(viewer, env)) {
          continue;
        }
        let slotType: number;
        if (item.is_blocked) {
          // for ML & restricted is_blocked = !is_underthreshold
          if (permission === PermissionTypes.GROUP) slotType = LootSlotType.ROLL_ONGOING;
          else if (permission === PermissionTypes.MASTER) slotType = isMasterLooter ? LootSlotType.MASTER : LootSlotType.LOCKED;
          else slotType = LootSlotType.LOCKED;
        } else if (item.rollWinnerGUID) {
          if (item.rollWinnerGUID !== viewer.guid) continue;
          slotType = LootSlotType.OWNER;
        } else if (!l.roundRobinPlayer || viewer.guid === l.roundRobinPlayer || !item.is_underthreshold) {
          // no round robin owner or he has released the loot
          // or it IS the round robin group owner
          // => item is lootable
          slotType = LootSlotType.ALLOW_LOOT;
        } else {
          // item shall not be displayed.
          continue;
        }
        show(i, item, slotType);
      }
      break;
    }
    case PermissionTypes.ROUND_ROBIN: {
      for (let i = 0; i < l.items.length; i++) {
        const item = l.items[i]!;
        if (!item.is_looted && !item.freeforall && item.conditions.length === 0 && item.allowedForPlayer(viewer, env)) {
          if (l.roundRobinPlayer && viewer.guid !== l.roundRobinPlayer) {
            // item shall not be displayed.
            continue;
          }
          show(i, item, LootSlotType.ALLOW_LOOT);
        }
      }
      break;
    }
    case PermissionTypes.ALL:
    case PermissionTypes.OWNER: {
      const slotType = permission === PermissionTypes.OWNER ? LootSlotType.OWNER : LootSlotType.ALLOW_LOOT;
      for (let i = 0; i < l.items.length; i++) {
        const item = l.items[i]!;
        if (!item.is_looted && !item.freeforall && item.conditions.length === 0 && item.allowedForPlayer(viewer, env)) {
          show(i, item, slotType);
        }
      }
      break;
    }
    default:
      b.writeU32(l.gold);
      b.writeU8(0);
      return;
  }

  const slotType = permission === PermissionTypes.OWNER ? LootSlotType.OWNER : LootSlotType.ALLOW_LOOT;
  // Xinef: items that do not follow loot rules need this
  const partySlotType = permission === PermissionTypes.MASTER ? LootSlotType.MASTER : slotType;

  const qList = l.getPlayerQuestItems().get(viewer.guid);
  if (qList) {
    for (let qi = 0; qi < qList.length; qi++) {
      const entry = qList[qi]!;
      const item = l.quest_items[entry.index];
      if (!item || entry.is_looted || item.is_looted) {
        continue;
      }
      const showInLoot = { value: true };
      const hasQuestForItem = viewer.hasQuestForItem(item.itemid, showInLoot);
      if (!hasQuestForItem) {
        if (!showInLoot.value) {
          entry.is_looted = true;
          if (!item.freeforall) {
            item.is_looted = true;
          }
          continue;
        }
        show(l.items.length + qi, item, permission === PermissionTypes.MASTER ? LootSlotType.MASTER : LootSlotType.LOCKED);
      } else if (item.follow_loot_rules) {
        show(l.items.length + qi, item, followLootRulesSlotType(item, permission, slotType));
      } else {
        show(l.items.length + qi, item, item.freeforall ? slotType : partySlotType);
      }
    }
  }

  for (const fi of l.getPlayerFFAItems().get(viewer.guid) ?? []) {
    const item = l.items[fi.index];
    if (item && !fi.is_looted && !item.is_looted) {
      // Xinef: Here are FFA items, so dont use owner permision
      show(fi.index, item, LootSlotType.ALLOW_LOOT);
    }
  }

  for (const ci of l.getPlayerNonQuestNonFFAConditionalItems().get(viewer.guid) ?? []) {
    const item = l.items[ci.index];
    if (item && !ci.is_looted && !item.is_looted) {
      if (item.follow_loot_rules) {
        show(ci.index, item, followLootRulesSlotType(item, permission, slotType));
      } else {
        show(ci.index, item, item.freeforall ? slotType : partySlotType);
      }
    }
  }

  b.writeU32(l.gold);
  b.writeU8(itemsShown);
  b.writeBytes(rows.toUint8Array());
}

/** `Player::SendLoot` → SMSG_LOOT_RESPONSE: guid, loot type, then the `LootView`. */
export function buildLootResponse(guid: bigint, lootType: number, loot: Loot, viewer: LootPlayer, permission: PermissionType): Uint8Array {
  const b = new ByteWriter().writeU64(guid).writeU8(lootType);
  writeLootView(b, loot, viewer, permission);
  return b.toUint8Array();
}

/** `Player::SendLootError` */
export function buildLootError(guid: bigint, error: LootErrorValue): Uint8Array {
  return new ByteWriter().writeU64(guid).writeU8(LootType.NONE).writeU8(error).toUint8Array();
}

/** `Player::SendLootRelease` → SMSG_LOOT_RELEASE_RESPONSE */
export function buildLootReleaseResponse(guid: bigint): Uint8Array {
  return new ByteWriter().writeU64(guid).writeU8(1).toUint8Array();
}

/** `Player::SendNotifyLootItemRemoved` → SMSG_LOOT_REMOVED */
export function buildLootRemoved(lootSlot: number): Uint8Array {
  return new ByteWriter().writeU8(lootSlot).toUint8Array();
}

/** SMSG_LOOT_MONEY_NOTIFY: `soleLooter` 1 is "You loot...", 0 is "Your share is...". */
export function buildLootMoneyNotify(gold: number, soleLooter: boolean): Uint8Array {
  return new ByteWriter().writeU32(gold).writeU8(soleLooter ? 1 : 0).toUint8Array();
}
