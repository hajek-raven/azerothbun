import { describe, expect, test } from "bun:test";
import {
  BAG_FAMILY_MASK_CURRENCY_TOKENS,
  CONJURED_LOGOUT_EXPIRE_SECONDS,
  CURRENCYTOKEN_SLOT_END,
  CURRENCYTOKEN_SLOT_START,
  conjuredToPersist,
  describePlaceCurrencyError,
  getMaxStackSize,
  initialSpellCharges,
  isConjured,
  isConjuredConsumable,
  isCurrencyToken,
  ITEM_CLASS_CONSUMABLE,
  ITEM_FLAG_CONJURED,
  itemsRemovedOnLogout,
  MAX_ITEM_PROTO_SPELLS,
  placeCurrency,
  type CurrencyItemTemplate,
  type CurrencySlotOccupant,
  type PlaceCurrencyError,
} from "./currency.ts";

function fixtureTemplate(
  overrides: Partial<CurrencyItemTemplate> & Pick<CurrencyItemTemplate, "entry">,
): CurrencyItemTemplate {
  return {
    class: ITEM_CLASS_CONSUMABLE,
    subclass: 0,
    flags: 0,
    bagFamily: 0,
    stackable: 20,
    maxCount: 0,
    totemCategory: 0,
    spellCharges: [-1, 0, 0, 0, 0],
    ...overrides,
  };
}

/** Emblem of Heroism-style currency token fixture (not a real DB dump row). */
const emblemOfHeroism = fixtureTemplate({
  entry: 40752,
  class: 15, // ITEM_CLASS_MISC
  subclass: 4,
  bagFamily: BAG_FAMILY_MASK_CURRENCY_TOKENS,
  stackable: 2147483647,
  maxCount: 0,
  spellCharges: [0, 0, 0, 0, 0],
});

/** Conjured Manna Biscuit-style consumable fixture. */
const conjuredMannaBiscuit = fixtureTemplate({
  entry: 22019,
  class: ITEM_CLASS_CONSUMABLE,
  subclass: 5, // food
  flags: ITEM_FLAG_CONJURED,
  stackable: 20,
  spellCharges: [-1, 0, 0, 0, 0],
});

/** Ordinary non-conjured food. */
const toughHunkOfBread = fixtureTemplate({
  entry: 4540,
  class: ITEM_CLASS_CONSUMABLE,
  subclass: 5,
  flags: 0,
  stackable: 20,
  spellCharges: [-1, 0, 0, 0, 0],
});

/** Unique currency token (maxCount 1). */
const uniqueBadge = fixtureTemplate({
  entry: 90001,
  class: 15,
  subclass: 4,
  bagFamily: BAG_FAMILY_MASK_CURRENCY_TOKENS,
  stackable: 1,
  maxCount: 1,
  spellCharges: [0, 0, 0, 0, 0],
});

describe("isCurrencyToken / isConjured", () => {
  test("currency token is BagFamily mask, not a class", () => {
    expect(isCurrencyToken(emblemOfHeroism)).toBe(true);
    expect(isCurrencyToken(conjuredMannaBiscuit)).toBe(false);
    expect(isCurrencyToken({ bagFamily: 0 })).toBe(false);
    expect(isCurrencyToken({ bagFamily: BAG_FAMILY_MASK_CURRENCY_TOKENS | 1 })).toBe(
      true,
    );
  });

  test("conjured is ITEM_FLAG_CONJURED; consumable requires class 0", () => {
    expect(isConjured(conjuredMannaBiscuit)).toBe(true);
    expect(isConjured(toughHunkOfBread)).toBe(false);
    expect(isConjuredConsumable(conjuredMannaBiscuit)).toBe(true);
    expect(
      isConjuredConsumable({
        class: 15,
        flags: ITEM_FLAG_CONJURED,
      }),
    ).toBe(false);
  });

  test("copied constants match AzerothCore headers", () => {
    expect(CURRENCYTOKEN_SLOT_START).toBe(118);
    expect(CURRENCYTOKEN_SLOT_END).toBe(150);
    expect(CURRENCYTOKEN_SLOT_END - CURRENCYTOKEN_SLOT_START).toBe(32);
    expect(BAG_FAMILY_MASK_CURRENCY_TOKENS).toBe(0x2000);
    expect(ITEM_FLAG_CONJURED).toBe(0x2);
    expect(ITEM_CLASS_CONSUMABLE).toBe(0);
    expect(CONJURED_LOGOUT_EXPIRE_SECONDS).toBe(15 * 60);
    expect(MAX_ITEM_PROTO_SPELLS).toBe(5);
  });
});

describe("placeCurrency", () => {
  test("rejects non-token items", () => {
    const result = placeCurrency([], {
      entry: conjuredMannaBiscuit.entry,
      count: 1,
      template: conjuredMannaBiscuit,
    });
    expect(result).toEqual({ ok: false, error: "not_currency_token" });
  });

  test("places into first empty slot starting at 118", () => {
    const result = placeCurrency([], {
      entry: emblemOfHeroism.entry,
      count: 5,
      template: emblemOfHeroism,
    });
    expect(result).toEqual({ ok: true, slot: CURRENCYTOKEN_SLOT_START });
  });

  test("skips occupied slots and fills the next free one", () => {
    const occupied: CurrencySlotOccupant[] = [
      { slot: 118, entry: 1, count: 1 },
      { slot: 119, entry: 2, count: 1 },
    ];
    const result = placeCurrency(occupied, {
      entry: emblemOfHeroism.entry,
      count: 1,
      template: emblemOfHeroism,
    });
    expect(result).toEqual({ ok: true, slot: 120 });
  });

  test("prefers merging into an existing same-entry stack", () => {
    const occupied: CurrencySlotOccupant[] = [
      { slot: 118, entry: 99, count: 1 },
      { slot: 120, entry: emblemOfHeroism.entry, count: 10 },
    ];
    const result = placeCurrency(occupied, {
      entry: emblemOfHeroism.entry,
      count: 3,
      template: emblemOfHeroism,
    });
    expect(result).toEqual({ ok: true, slot: 120 });
  });

  test("does not merge into a full stack; uses empty slot", () => {
    const fullStack = fixtureTemplate({
      entry: 70001,
      bagFamily: BAG_FAMILY_MASK_CURRENCY_TOKENS,
      stackable: 5,
      spellCharges: [0, 0, 0, 0, 0],
    });
    const occupied: CurrencySlotOccupant[] = [
      { slot: 118, entry: fullStack.entry, count: 5 },
    ];
    const result = placeCurrency(occupied, {
      entry: fullStack.entry,
      count: 1,
      template: fullStack,
    });
    expect(result).toEqual({ ok: true, slot: 119 });
  });

  test("returns currency_slots_full when all 32 slots are taken", () => {
    const occupied: CurrencySlotOccupant[] = [];
    for (let slot = CURRENCYTOKEN_SLOT_START; slot < CURRENCYTOKEN_SLOT_END; slot++) {
      occupied.push({ slot, entry: slot, count: 1 });
    }
    const result = placeCurrency(occupied, {
      entry: emblemOfHeroism.entry,
      count: 1,
      template: emblemOfHeroism,
    });
    expect(result).toEqual({ ok: false, error: "currency_slots_full" });
  });

  test("enforces MaxCount unique limit", () => {
    const occupied: CurrencySlotOccupant[] = [
      { slot: 118, entry: uniqueBadge.entry, count: 1 },
    ];
    const result = placeCurrency(occupied, {
      entry: uniqueBadge.entry,
      count: 1,
      template: uniqueBadge,
    });
    expect(result).toEqual({ ok: false, error: "cant_carry_more" });
  });

  test("ignores occupants outside the currency slot range", () => {
    const occupied: CurrencySlotOccupant[] = [
      { slot: 23, entry: emblemOfHeroism.entry, count: 1 },
    ];
    const result = placeCurrency(occupied, {
      entry: emblemOfHeroism.entry,
      count: 1,
      template: emblemOfHeroism,
    });
    expect(result).toEqual({ ok: true, slot: CURRENCYTOKEN_SLOT_START });
  });
});

describe("conjured persist / logout removal", () => {
  const bag = [
    { guid: 1, template: conjuredMannaBiscuit },
    { guid: 2, template: toughHunkOfBread },
    { guid: 3, template: emblemOfHeroism },
  ];

  test("conjuredToPersist keeps conjured items (C++ saves them)", () => {
    const saved = conjuredToPersist(bag);
    expect(saved).toHaveLength(3);
    expect(saved.map((i) => i.guid)).toEqual([1, 2, 3]);
  });

  test("short logout does not remove conjured items", () => {
    expect(itemsRemovedOnLogout(bag, CONJURED_LOGOUT_EXPIRE_SECONDS)).toEqual([]);
    expect(itemsRemovedOnLogout(bag, CONJURED_LOGOUT_EXPIRE_SECONDS - 1)).toEqual(
      [],
    );
  });

  test("logout longer than 15 minutes removes only conjured items", () => {
    const removed = itemsRemovedOnLogout(
      bag,
      CONJURED_LOGOUT_EXPIRE_SECONDS + 1,
    );
    expect(removed).toHaveLength(1);
    expect(removed[0]?.guid).toBe(1);
  });
});

describe("spell charges and stack helpers", () => {
  test("initialSpellCharges pads to MAX_ITEM_PROTO_SPELLS", () => {
    expect(initialSpellCharges(conjuredMannaBiscuit)).toEqual([-1, 0, 0, 0, 0]);
    expect(initialSpellCharges({ spellCharges: [3] })).toEqual([3, 0, 0, 0, 0]);
    expect(getMaxStackSize(emblemOfHeroism)).toBe(0x7fffffff - 1);
    expect(getMaxStackSize({ stackable: 20 })).toBe(20);
  });

  test("describePlaceCurrencyError is exhaustive", () => {
    const errors: PlaceCurrencyError[] = [
      "not_currency_token",
      "currency_slots_full",
      "cant_carry_more",
    ];
    for (const error of errors) {
      expect(describePlaceCurrencyError(error).length).toBeGreaterThan(0);
    }
  });
});
