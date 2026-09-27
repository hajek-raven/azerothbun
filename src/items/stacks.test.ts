import { describe, expect, test } from "bun:test";
import {
  ITEM_FIELD_FLAG_SOULBOUND,
  ITEM_FLAG_UNIQUE_EQUIPPABLE,
  ItemBondingType,
  addStack,
  canAdd,
  canEquipUnique,
  canMergeWith,
  getMaxStackSize,
  isSoulBound,
  onEquip,
  onPickup,
  onUse,
  setBinding,
  type ItemRecord,
  type ItemStackTemplate,
} from "./stacks.ts";

const OWNER = 42;

function item(
  partial: Partial<ItemRecord> & Pick<ItemRecord, "entry" | "count">,
): ItemRecord {
  return {
    flags: 0,
    owner: OWNER,
    ...partial,
  };
}

function template(
  partial: Partial<ItemStackTemplate> & Pick<ItemStackTemplate, "stackable">,
): ItemStackTemplate {
  return {
    maxcount: 0,
    bonding: ItemBondingType.NO_BIND,
    flags: 0,
    ...partial,
  };
}

describe("flag bits", () => {
  test("ITEM_FIELD_FLAG_SOULBOUND is bit 0", () => {
    expect(ITEM_FIELD_FLAG_SOULBOUND).toBe(0x00000001);
  });

  test("ITEM_FLAG_UNIQUE_EQUIPPABLE is 0x00080000", () => {
    expect(ITEM_FLAG_UNIQUE_EQUIPPABLE).toBe(0x00080000);
  });

  test("setBinding / isSoulBound toggle only the soulbound bit", () => {
    const other = 0x00000008;
    expect(isSoulBound(0)).toBe(false);
    expect(isSoulBound(setBinding(0, true))).toBe(true);
    expect(setBinding(other, true)).toBe(other | ITEM_FIELD_FLAG_SOULBOUND);
    expect(setBinding(other | ITEM_FIELD_FLAG_SOULBOUND, false)).toBe(other);
  });
});

describe("bonding transitions", () => {
  test("already soulbound stays soulbound for every bonding type", () => {
    const bound = ITEM_FIELD_FLAG_SOULBOUND;
    const types: ItemBondingType[] = [
      ItemBondingType.NO_BIND,
      ItemBondingType.BIND_WHEN_PICKED_UP,
      ItemBondingType.BIND_WHEN_EQUIPPED,
      ItemBondingType.BIND_WHEN_USE,
      ItemBondingType.BIND_QUEST_ITEM,
      ItemBondingType.BIND_QUEST_ITEM1,
    ];
    for (const bonding of types) {
      expect(onPickup(bound, bonding)).toBe(bound);
      expect(onEquip(bound, bonding)).toBe(bound);
      expect(onUse(bound, bonding)).toBe(bound);
    }
  });

  test("BIND_WHEN_PICKED_UP binds on pickup", () => {
    expect(onPickup(0, ItemBondingType.BIND_WHEN_PICKED_UP)).toBe(
      ITEM_FIELD_FLAG_SOULBOUND,
    );
    expect(onEquip(0, ItemBondingType.BIND_WHEN_PICKED_UP)).toBe(
      ITEM_FIELD_FLAG_SOULBOUND,
    );
    expect(onUse(0, ItemBondingType.BIND_WHEN_PICKED_UP)).toBe(
      ITEM_FIELD_FLAG_SOULBOUND,
    );
  });

  test("BIND_WHEN_EQUIPPED binds only on equip", () => {
    expect(onPickup(0, ItemBondingType.BIND_WHEN_EQUIPPED)).toBe(0);
    expect(onEquip(0, ItemBondingType.BIND_WHEN_EQUIPPED)).toBe(
      ITEM_FIELD_FLAG_SOULBOUND,
    );
    expect(onUse(0, ItemBondingType.BIND_WHEN_EQUIPPED)).toBe(0);
  });

  test("BIND_WHEN_USE binds only on use", () => {
    expect(onPickup(0, ItemBondingType.BIND_WHEN_USE)).toBe(0);
    expect(onEquip(0, ItemBondingType.BIND_WHEN_USE)).toBe(0);
    expect(onUse(0, ItemBondingType.BIND_WHEN_USE)).toBe(
      ITEM_FIELD_FLAG_SOULBOUND,
    );
  });

  test("BIND_QUEST_ITEM binds on pickup (and quest reward / store path)", () => {
    expect(onPickup(0, ItemBondingType.BIND_QUEST_ITEM)).toBe(
      ITEM_FIELD_FLAG_SOULBOUND,
    );
    expect(onEquip(0, ItemBondingType.BIND_QUEST_ITEM)).toBe(
      ITEM_FIELD_FLAG_SOULBOUND,
    );
    expect(onUse(0, ItemBondingType.BIND_QUEST_ITEM)).toBe(
      ITEM_FIELD_FLAG_SOULBOUND,
    );
  });

  test("NO_BIND never sets soulbound", () => {
    expect(onPickup(0, ItemBondingType.NO_BIND)).toBe(0);
    expect(onEquip(0, ItemBondingType.NO_BIND)).toBe(0);
    expect(onUse(0, ItemBondingType.NO_BIND)).toBe(0);
  });
});

describe("unique inventory maxcount", () => {
  test("maxcount 1 rejects a second copy", () => {
    const tmpl = template({ stackable: 1, maxcount: 1 });
    const owned = [item({ entry: 100, count: 1 })];
    expect(canAdd(1, 100, tmpl, owned)).toBe(false);
    expect(canAdd(1, 100, tmpl, [])).toBe(true);
  });

  test("maxcount 0 means no unique inventory cap", () => {
    const tmpl = template({ stackable: 20, maxcount: 0 });
    const owned = [item({ entry: 100, count: 999 })];
    expect(canAdd(20, 100, tmpl, owned)).toBe(true);
  });

  test("counts every owned stack of that entry toward maxcount", () => {
    const tmpl = template({ stackable: 20, maxcount: 5 });
    const owned = [
      item({ entry: 100, count: 2 }),
      item({ entry: 100, count: 2 }),
      item({ entry: 200, count: 20 }),
    ];
    expect(canAdd(1, 100, tmpl, owned)).toBe(true);
    expect(canAdd(2, 100, tmpl, owned)).toBe(false);
  });
});

describe("stack merge", () => {
  test("stackable 20 with 15+10 merges to 20 and leftover 5", () => {
    const tmpl = template({ stackable: 20 });
    const existing = [item({ entry: 50, count: 15 })];
    const result = addStack(
      { entry: 50, count: 10, flags: 0, owner: OWNER },
      tmpl,
      existing,
    );
    expect(result.merges).toEqual([{ index: 0, added: 5, newCount: 20 }]);
    expect(result.leftover).toBe(5);
    expect(getMaxStackSize(20)).toBe(20);
  });

  test("fills multiple partial stacks before leftover", () => {
    const tmpl = template({ stackable: 20 });
    const existing = [
      item({ entry: 50, count: 18 }),
      item({ entry: 50, count: 19 }),
    ];
    const result = addStack(
      { entry: 50, count: 5, flags: 0, owner: OWNER },
      tmpl,
      existing,
    );
    expect(result.merges).toEqual([
      { index: 0, added: 2, newCount: 20 },
      { index: 1, added: 1, newCount: 20 },
    ]);
    expect(result.leftover).toBe(2);
  });

  test("soulbound does not merge with unbound", () => {
    const tmpl = template({ stackable: 20 });
    const existing = [
      item({ entry: 50, count: 10, flags: ITEM_FIELD_FLAG_SOULBOUND }),
      item({ entry: 50, count: 10, flags: 0 }),
    ];
    const unbound = addStack(
      { entry: 50, count: 5, flags: 0, owner: OWNER },
      tmpl,
      existing,
    );
    expect(unbound.merges).toEqual([{ index: 1, added: 5, newCount: 15 }]);
    expect(unbound.leftover).toBe(0);

    const bound = addStack(
      {
        entry: 50,
        count: 5,
        flags: ITEM_FIELD_FLAG_SOULBOUND,
        owner: OWNER,
      },
      tmpl,
      existing,
    );
    expect(bound.merges).toEqual([{ index: 0, added: 5, newCount: 15 }]);
    expect(bound.leftover).toBe(0);

    expect(
      canMergeWith(
        existing[0]!,
        { entry: 50, flags: 0 },
        tmpl,
      ),
    ).toBe(false);
    expect(
      canMergeWith(
        existing[1]!,
        { entry: 50, flags: 0 },
        tmpl,
      ),
    ).toBe(true);
  });

  test("two soulbound stacks of the same entry do merge", () => {
    const tmpl = template({ stackable: 20 });
    const existing = [
      item({ entry: 50, count: 12, flags: ITEM_FIELD_FLAG_SOULBOUND }),
    ];
    const result = addStack(
      {
        entry: 50,
        count: 5,
        flags: ITEM_FIELD_FLAG_SOULBOUND,
        owner: OWNER,
      },
      tmpl,
      existing,
    );
    expect(result.merges).toEqual([{ index: 0, added: 5, newCount: 17 }]);
    expect(result.leftover).toBe(0);
  });

  test("different entry never merges", () => {
    const tmpl = template({ stackable: 20 });
    const existing = [item({ entry: 1, count: 1 })];
    const result = addStack(
      { entry: 2, count: 5, flags: 0, owner: OWNER },
      tmpl,
      existing,
    );
    expect(result.merges).toEqual([]);
    expect(result.leftover).toBe(5);
  });
});

describe("unique-equipped", () => {
  test("second unique-equipped of the same entry fails", () => {
    const tmpl = template({
      stackable: 1,
      flags: ITEM_FLAG_UNIQUE_EQUIPPABLE,
    });
    expect(canEquipUnique(900, tmpl, [])).toBe(true);
    expect(canEquipUnique(900, tmpl, [{ entry: 900 }])).toBe(false);
    expect(canEquipUnique(900, tmpl, [{ entry: 901 }])).toBe(true);
  });

  test("without UNIQUE_EQUIPPABLE flag, duplicates may equip", () => {
    const tmpl = template({ stackable: 1, flags: 0 });
    expect(canEquipUnique(900, tmpl, [{ entry: 900 }])).toBe(true);
  });

  test("unique-equipped is independent of inventory maxcount", () => {
    const tmpl = template({
      stackable: 1,
      maxcount: 0,
      flags: ITEM_FLAG_UNIQUE_EQUIPPABLE,
    });
    const bag = [item({ entry: 900, count: 1 }), item({ entry: 900, count: 1 })];
    expect(canAdd(1, 900, tmpl, bag)).toBe(true);
    expect(canEquipUnique(900, tmpl, [{ entry: 900 }])).toBe(false);
  });
});
