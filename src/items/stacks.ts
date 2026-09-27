/**
 * Stack merge, unique inventory caps, unique-equipped, and soulbound binding.
 * Port of Player::CanStoreItem / CanTakeMoreSimilarItems / CanEquipUniqueItem,
 * Item::SetBinding / IsSoulBound / CanBeMergedPartlyWith, and ItemBondingType.
 */

/** `item_instance.flags` / `ITEM_FIELD_FLAGS` bit: item is soulbound. */
export const ITEM_FIELD_FLAG_SOULBOUND = 0x00000001;

/** `item_template.Flags`: only one of this entry may be equipped. */
export const ITEM_FLAG_UNIQUE_EQUIPPABLE = 0x00080000;

/** `ItemBondingType` from ItemTemplate.h */
export const ItemBondingType = {
  NO_BIND: 0,
  BIND_WHEN_PICKED_UP: 1,
  BIND_WHEN_EQUIPPED: 2,
  BIND_WHEN_USE: 3,
  BIND_QUEST_ITEM: 4,
  BIND_QUEST_ITEM1: 5,
} as const;

export type ItemBondingType = (typeof ItemBondingType)[keyof typeof ItemBondingType];

/** Inventory / bank item instance fields used by stack and bind rules. */
export type ItemRecord = {
  entry: number;
  count: number;
  flags: number;
  owner: number;
};

/** `item_template` columns this topic reads. */
export type ItemStackTemplate = {
  stackable: number;
  maxcount: number;
  bonding: ItemBondingType;
  flags: number;
};

export type StackMerge = {
  /** Index into the `existing` list passed to `addStack`. */
  index: number;
  /** Count moved onto that stack. */
  added: number;
  /** Stack size after the merge. */
  newCount: number;
};

export type AddStackResult = {
  merges: StackMerge[];
  /** Count that still needs a new slot (bags topic assigns slots). */
  leftover: number;
};

/** `Item::IsSoulBound` */
export function isSoulBound(flags: number): boolean {
  return (flags & ITEM_FIELD_FLAG_SOULBOUND) !== 0;
}

/** `Item::SetBinding` — only toggles `ITEM_FIELD_FLAG_SOULBOUND`. */
export function setBinding(flags: number, bound: boolean): number {
  if (bound) {
    return flags | ITEM_FIELD_FLAG_SOULBOUND;
  }
  return flags & ~ITEM_FIELD_FLAG_SOULBOUND;
}

/**
 * `ItemTemplate::GetMaxStackSize`.
 * `stackable` ≤ 0 or INT32_MAX means effectively unlimited for merge math.
 */
export function getMaxStackSize(stackable: number): number {
  if (stackable === 2147483647 || stackable <= 0) {
    return 0x7ffffffe;
  }
  return stackable;
}

/**
 * Merge rule for stacking onto an existing instance:
 * same entry, room under `stackable`, and matching soulbound state
 * (soulbound does not stack with unbound).
 */
export function canMergeWith(
  existing: ItemRecord,
  incoming: { entry: number; flags: number },
  template: Pick<ItemStackTemplate, "stackable">,
): boolean {
  if (existing.entry !== incoming.entry) {
    return false;
  }
  if (isSoulBound(existing.flags) !== isSoulBound(incoming.flags)) {
    return false;
  }
  return existing.count < getMaxStackSize(template.stackable);
}

/**
 * Merge `count` of an item into existing stacks, then report leftover that
 * still needs an empty slot. Does not assign bag/slot positions.
 */
export function addStack(
  incoming: { entry: number; count: number; flags: number; owner?: number },
  template: Pick<ItemStackTemplate, "stackable">,
  existing: readonly ItemRecord[],
): AddStackResult {
  const maxStack = getMaxStackSize(template.stackable);
  const incomingBound = isSoulBound(incoming.flags);
  let remaining = incoming.count;
  const merges: StackMerge[] = [];

  for (let index = 0; index < existing.length && remaining > 0; index++) {
    const item = existing[index]!;
    if (item.entry !== incoming.entry) {
      continue;
    }
    if (incoming.owner !== undefined && item.owner !== incoming.owner) {
      continue;
    }
    if (isSoulBound(item.flags) !== incomingBound) {
      continue;
    }
    const space = maxStack - item.count;
    if (space <= 0) {
      continue;
    }
    const added = Math.min(space, remaining);
    merges.push({ index, added, newCount: item.count + added });
    remaining -= added;
  }

  return { merges, leftover: remaining };
}

/**
 * `Player::CanTakeMoreSimilarItems` unique inventory cap (`item_template.maxcount`).
 * `maxcount` ≤ 0 or INT32_MAX means no unique inventory limit.
 * Counts every owned stack of `entry` (caller supplies bank + bags + equipped).
 */
export function canAdd(
  count: number,
  entry: number,
  template: Pick<ItemStackTemplate, "maxcount">,
  existing: readonly ItemRecord[],
): boolean {
  if (template.maxcount <= 0 || template.maxcount === 2147483647) {
    return true;
  }
  let owned = 0;
  for (const item of existing) {
    if (item.entry === entry) {
      owned += item.count;
    }
  }
  return owned + count <= template.maxcount;
}

function applyBindIf(
  flags: number,
  bonding: ItemBondingType,
  shouldBind: (bonding: ItemBondingType) => boolean,
): number {
  if (isSoulBound(flags)) {
    return flags;
  }
  return shouldBind(bonding) ? setBinding(flags, true) : flags;
}

/**
 * Binding on create / store / quest reward (`Player::StoreItem`).
 * `BIND_WHEN_PICKED_UP` and `BIND_QUEST_ITEM` set soulbound; already-bound stays bound.
 */
export function onPickup(flags: number, bonding: ItemBondingType): number {
  return applyBindIf(flags, bonding, (b) => {
    switch (b) {
      case ItemBondingType.NO_BIND:
        return false;
      case ItemBondingType.BIND_WHEN_PICKED_UP:
        return true;
      case ItemBondingType.BIND_WHEN_EQUIPPED:
        return false;
      case ItemBondingType.BIND_WHEN_USE:
        return false;
      case ItemBondingType.BIND_QUEST_ITEM:
        return true;
      case ItemBondingType.BIND_QUEST_ITEM1:
        return false;
      default: {
        const _exhaustive: never = b;
        return _exhaustive;
      }
    }
  });
}

/**
 * Binding on equip (`Player::VisualizeItem`).
 * `BIND_WHEN_EQUIPPED` (plus BoP / quest safety from C++) sets soulbound.
 */
export function onEquip(flags: number, bonding: ItemBondingType): number {
  return applyBindIf(flags, bonding, (b) => {
    switch (b) {
      case ItemBondingType.NO_BIND:
        return false;
      case ItemBondingType.BIND_WHEN_PICKED_UP:
        return true;
      case ItemBondingType.BIND_WHEN_EQUIPPED:
        return true;
      case ItemBondingType.BIND_WHEN_USE:
        return false;
      case ItemBondingType.BIND_QUEST_ITEM:
        return true;
      case ItemBondingType.BIND_QUEST_ITEM1:
        return false;
      default: {
        const _exhaustive: never = b;
        return _exhaustive;
      }
    }
  });
}

/**
 * Binding on use (`WorldSession::HandleUseItemOpcode`).
 * `BIND_WHEN_USE` (plus BoP / quest safety from C++) sets soulbound.
 */
export function onUse(flags: number, bonding: ItemBondingType): number {
  return applyBindIf(flags, bonding, (b) => {
    switch (b) {
      case ItemBondingType.NO_BIND:
        return false;
      case ItemBondingType.BIND_WHEN_PICKED_UP:
        return true;
      case ItemBondingType.BIND_WHEN_EQUIPPED:
        return false;
      case ItemBondingType.BIND_WHEN_USE:
        return true;
      case ItemBondingType.BIND_QUEST_ITEM:
        return true;
      case ItemBondingType.BIND_QUEST_ITEM1:
        return false;
      default: {
        const _exhaustive: never = b;
        return _exhaustive;
      }
    }
  });
}

/**
 * `Player::CanEquipUniqueItem` for `ITEM_FLAG_UNIQUE_EQUIPPABLE`.
 * Separate from inventory `maxcount`. Returns false when another of the same
 * entry is already equipped.
 */
export function canEquipUnique(
  entry: number,
  template: Pick<ItemStackTemplate, "flags">,
  equipped: readonly { entry: number }[],
): boolean {
  if ((template.flags & ITEM_FLAG_UNIQUE_EQUIPPABLE) === 0) {
    return true;
  }
  for (const item of equipped) {
    if (item.entry === entry) {
      return false;
    }
  }
  return true;
}
