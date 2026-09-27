/**
 * Currency-token slots and conjured-item logout rules.
 *
 * Sources (AzerothCore WotLK 3.3.5a):
 * - Player.h — CURRENCYTOKEN_SLOT_START / END
 * - ItemTemplate.h — BAG_FAMILY_MASK_CURRENCY_TOKENS, ITEM_FLAG_CONJURED,
 *   ItemClass, IsCurrencyToken / IsConjuredConsumable
 * - PlayerStorage.cpp — CanStoreItem currency path; _LoadItem conjured expiry
 *
 * There is no ITEM_CLASS_CURRENCY_TOKEN in 3.3.5a. Tokens are identified by
 * BagFamily & BAG_FAMILY_MASK_CURRENCY_TOKENS and stored only in slots 118..149.
 *
 * Conjured items are saved in _SaveInventory. On load, _LoadItem deletes any
 * item with ITEM_FLAG_CONJURED when logout duration exceeds 15 minutes.
 */

import { MINUTE } from "../common/duration.ts";

/** Player.h CurrencyTokenSlots — 32 slots. */
export const CURRENCYTOKEN_SLOT_START = 118;
export const CURRENCYTOKEN_SLOT_END = 150;

/** ItemTemplate.h BAG_FAMILY_MASK */
export const BAG_FAMILY_MASK_CURRENCY_TOKENS = 0x0000_2000;

/** ItemTemplate.h ItemFlags */
export const ITEM_FLAG_CONJURED = 0x0000_0002;

/** ItemTemplate.h ItemClass */
export const ITEM_CLASS_CONSUMABLE = 0;

/** ItemTemplate.h — spell charge slots on an item proto. */
export const MAX_ITEM_PROTO_SPELLS = 5;

/**
 * Player::_LoadItem: "Conjured items disappear if you are logged out for more
 * than 15 minutes" — timeDiff > 15 * MINUTE.
 */
export const CONJURED_LOGOUT_EXPIRE_SECONDS = 15 * MINUTE;

export type CurrencyItemTemplate = {
  /** item_template.entry */
  entry: number;
  /** item_template.class */
  class: number;
  /** item_template.subclass */
  subclass: number;
  /** item_template.Flags */
  flags: number;
  /** item_template.BagFamily */
  bagFamily: number;
  /** item_template.stackable — max stack size */
  stackable: number;
  /** item_template.maxcount — unique carry limit (0 = unlimited) */
  maxCount: number;
  /**
   * item_template.TotemCategory. Currency slots are scanned by
   * Player::HasItemTotemCategory; placement itself does not check this.
   */
  totemCategory: number;
  /**
   * item_template spellcharges_N (N = 1..5). Applied at item create;
   * relevant for conjured consumable stacks.
   */
  spellCharges: readonly number[];
};

export type CurrencySlotOccupant = {
  slot: number;
  entry: number;
  count: number;
};

export type PlaceCurrencyItem = {
  entry: number;
  count: number;
  template: CurrencyItemTemplate;
};

export type PlaceCurrencyError =
  | "not_currency_token"
  | "currency_slots_full"
  | "cant_carry_more";

export type PlaceCurrencyResult =
  | { ok: true; slot: number }
  | { ok: false; error: PlaceCurrencyError };

/** ItemTemplate::IsCurrencyToken — BagFamily & BAG_FAMILY_MASK_CURRENCY_TOKENS. */
export function isCurrencyToken(
  template: Pick<CurrencyItemTemplate, "bagFamily">,
): boolean {
  return (template.bagFamily & BAG_FAMILY_MASK_CURRENCY_TOKENS) !== 0;
}

/** ITEM_FLAG_CONJURED set on item_template.Flags. */
export function isConjured(
  template: Pick<CurrencyItemTemplate, "flags">,
): boolean {
  return (template.flags & ITEM_FLAG_CONJURED) !== 0;
}

/** ItemTemplate::IsConjuredConsumable — used by DestroyConjuredItems (arena). */
export function isConjuredConsumable(
  template: Pick<CurrencyItemTemplate, "class" | "flags">,
): boolean {
  return template.class === ITEM_CLASS_CONSUMABLE && isConjured(template);
}

/** ItemTemplate::GetMaxStackSize. */
export function getMaxStackSize(
  template: Pick<CurrencyItemTemplate, "stackable">,
): number {
  if (template.stackable === 2147483647 || template.stackable <= 0) {
    return 0x7fffffff - 1;
  }
  return template.stackable;
}

/**
 * Spell charges copied onto a new item instance (Item::Create).
 * Always returns MAX_ITEM_PROTO_SPELLS entries.
 */
export function initialSpellCharges(
  template: Pick<CurrencyItemTemplate, "spellCharges">,
): number[] {
  const charges: number[] = [];
  for (let i = 0; i < MAX_ITEM_PROTO_SPELLS; i++) {
    charges.push(template.spellCharges[i] ?? 0);
  }
  return charges;
}

function occupiedCurrencySlots(
  existingSlots: readonly CurrencySlotOccupant[],
): Map<number, CurrencySlotOccupant> {
  const map = new Map<number, CurrencySlotOccupant>();
  for (const occupant of existingSlots) {
    if (
      occupant.slot >= CURRENCYTOKEN_SLOT_START &&
      occupant.slot < CURRENCYTOKEN_SLOT_END
    ) {
      map.set(occupant.slot, occupant);
    }
  }
  return map;
}

/**
 * Place a currency-token item into slots [CURRENCYTOKEN_SLOT_START, CURRENCYTOKEN_SLOT_END).
 *
 * Matches Player::CanStoreItem / StoreItemIntoBank currency path:
 * 1. Reject non-tokens.
 * 2. Enforce MaxCount unique limit (CanTakeMoreSimilarItems).
 * 3. Prefer an existing same-entry stack with free space (merge).
 * 4. Else first empty currency slot.
 * 5. Else currency_slots_full.
 *
 * TotemCategory does not affect placement (only HasItemTotemCategory scans).
 */
export function placeCurrency(
  existingSlots: readonly CurrencySlotOccupant[],
  item: PlaceCurrencyItem,
): PlaceCurrencyResult {
  if (!isCurrencyToken(item.template)) {
    return { ok: false, error: "not_currency_token" };
  }

  if (item.template.maxCount > 0 && item.template.maxCount !== 2147483647) {
    let curCount = 0;
    for (const occupant of existingSlots) {
      if (occupant.entry === item.entry) {
        curCount += occupant.count;
      }
    }
    if (curCount + item.count > item.template.maxCount) {
      return { ok: false, error: "cant_carry_more" };
    }
  }

  const occupied = occupiedCurrencySlots(existingSlots);
  const maxStack = getMaxStackSize(item.template);

  for (let slot = CURRENCYTOKEN_SLOT_START; slot < CURRENCYTOKEN_SLOT_END; slot++) {
    const existing = occupied.get(slot);
    if (
      existing &&
      existing.entry === item.entry &&
      existing.count < maxStack
    ) {
      return { ok: true, slot };
    }
  }

  for (let slot = CURRENCYTOKEN_SLOT_START; slot < CURRENCYTOKEN_SLOT_END; slot++) {
    if (!occupied.has(slot)) {
      return { ok: true, slot };
    }
  }

  return { ok: false, error: "currency_slots_full" };
}

/**
 * Items written on character save. C++ _SaveInventory persists conjured items;
 * they are stripped on load after a long logout — see itemsRemovedOnLogout.
 */
export function conjuredToPersist<
  T extends { template: Pick<CurrencyItemTemplate, "flags"> },
>(items: readonly T[]): T[] {
  return items.slice();
}

/**
 * Player::_LoadItem conjured expiry: when logout duration exceeds
 * CONJURED_LOGOUT_EXPIRE_SECONDS, every ITEM_FLAG_CONJURED item is deleted.
 * Returns the items that must be removed (empty when logout was short enough).
 */
export function itemsRemovedOnLogout<
  T extends { template: Pick<CurrencyItemTemplate, "flags"> },
>(items: readonly T[], logoutSeconds: number): T[] {
  if (logoutSeconds <= CONJURED_LOGOUT_EXPIRE_SECONDS) {
    return [];
  }
  return items.filter((item) => isConjured(item.template));
}

export function describePlaceCurrencyError(error: PlaceCurrencyError): string {
  switch (error) {
    case "not_currency_token":
      return "item is not a currency token";
    case "currency_slots_full":
      return "no free currency token slot";
    case "cant_carry_more":
      return "unique maxcount limit reached";
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}
