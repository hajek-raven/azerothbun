import { describe, expect, test } from "bun:test";
import {
  SOCKET_COLOR_BLUE,
  SOCKET_COLOR_META,
  SOCKET_COLOR_RED,
  SOCKET_COLOR_YELLOW,
  applyEnchantments,
  canSocketGem,
  gemColorMatchesSocket,
  gemsFitSockets,
  itemSetBonuses,
  itemSetFromSqlRow,
  socketGem,
  spellItemEnchantmentFromSqlRow,
  toEnchantmentRecord,
  type ItemSetEntry,
  type SocketGemItem,
  type SpellItemEnchantment,
} from "./enchants.ts";

function enchantRow(partial: {
  ID: number;
  Charges?: number;
  Effect_1?: number;
  Effect_2?: number;
  Effect_3?: number;
  EffectPointsMin_1?: number;
  EffectPointsMin_2?: number;
  EffectPointsMin_3?: number;
  EffectArg_1?: number;
  EffectArg_2?: number;
  EffectArg_3?: number;
  Src_ItemID?: number;
}): SpellItemEnchantment {
  return spellItemEnchantmentFromSqlRow({
    Charges: 0,
    Effect_1: 0,
    Effect_2: 0,
    Effect_3: 0,
    EffectPointsMin_1: 0,
    EffectPointsMin_2: 0,
    EffectPointsMin_3: 0,
    EffectArg_1: 0,
    EffectArg_2: 0,
    EffectArg_3: 0,
    Src_ItemID: 0,
    Condition_Id: 0,
    RequiredSkillID: 0,
    RequiredSkillRank: 0,
    MinLevel: 0,
    ...partial,
  });
}

const EQUIP_SPELL = 3;

describe("spell item enchantment fixtures", () => {
  test("returns effect spell ids from a fixture row", () => {
    const row = enchantRow({
      ID: 3223,
      Charges: 0,
      Effect_1: EQUIP_SPELL,
      EffectArg_1: 13881,
      Effect_2: EQUIP_SPELL,
      EffectArg_2: 6296,
      Effect_3: 0,
      EffectArg_3: 0,
    });
    expect(row.id).toBe(3223);
    expect(row.charges).toBe(0);
    expect(row.effects[0]).toEqual({ type: EQUIP_SPELL, amount: 0, spellId: 13881 });
    expect(row.effects[1]).toEqual({ type: EQUIP_SPELL, amount: 0, spellId: 6296 });

    const record = toEnchantmentRecord({ id: 3223, duration: 0, charges: 0 }, row);
    expect(record.effectSpellIds).toEqual([13881, 6296]);

    const table = new Map([[row.id, row]]);
    expect(applyEnchantments([{ id: 3223, duration: 0, charges: 0 }], true, table)).toEqual([
      13881, 6296,
    ]);
    expect(applyEnchantments([{ id: 3223, duration: 0, charges: 0 }], false, table)).toEqual([]);
  });
});

describe("gem color match", () => {
  test("matches and mismatches socket colors including meta and prismatic", () => {
    expect(gemColorMatchesSocket(SOCKET_COLOR_RED, SOCKET_COLOR_RED)).toBe(true);
    expect(gemColorMatchesSocket(SOCKET_COLOR_YELLOW, SOCKET_COLOR_RED)).toBe(false);
    expect(gemColorMatchesSocket(SOCKET_COLOR_META, SOCKET_COLOR_META)).toBe(true);
    expect(gemColorMatchesSocket(SOCKET_COLOR_META, SOCKET_COLOR_RED)).toBe(false);
    // prismatic = R|Y|B
    const prismatic = SOCKET_COLOR_RED | SOCKET_COLOR_YELLOW | SOCKET_COLOR_BLUE;
    expect(gemColorMatchesSocket(prismatic, SOCKET_COLOR_BLUE)).toBe(true);
    expect(gemColorMatchesSocket(prismatic, SOCKET_COLOR_META)).toBe(false);
  });

  test("canSocketGem rejects meta/non-meta swaps", () => {
    const item: SocketGemItem = {
      template: {
        socketColor_1: SOCKET_COLOR_META,
        socketColor_2: SOCKET_COLOR_RED,
        socketColor_3: 0,
        socketBonus: 0,
      },
      socketEnchantIds: [0, 0, 0],
      hasPrismaticSocket: false,
    };
    expect(canSocketGem(item, 0, { color: SOCKET_COLOR_RED, enchantId: 1 })).toBe("color_mismatch");
    expect(canSocketGem(item, 0, { color: SOCKET_COLOR_META, enchantId: 1 })).toBe("ok");
    expect(canSocketGem(item, 1, { color: SOCKET_COLOR_META, enchantId: 1 })).toBe("color_mismatch");
    expect(canSocketGem(item, 1, { color: SOCKET_COLOR_YELLOW, enchantId: 1 })).toBe("ok");
  });
});

describe("socket bonus", () => {
  test("activates only when every colored socket has a matching gem", () => {
    const redEnchant = enchantRow({ ID: 1001, Effect_1: EQUIP_SPELL, EffectArg_1: 5001 });
    const yellowEnchant = enchantRow({ ID: 1002, Effect_1: EQUIP_SPELL, EffectArg_1: 5002 });
    const bonusEnchant = enchantRow({ ID: 2000, Effect_1: EQUIP_SPELL, EffectArg_1: 9001 });
    const enchantTable = new Map<number, SpellItemEnchantment>([
      [1001, redEnchant],
      [1002, yellowEnchant],
      [2000, bonusEnchant],
    ]);
    const gemColorByEnchantId = new Map<number, number>([
      [1001, SOCKET_COLOR_RED],
      [1002, SOCKET_COLOR_YELLOW],
    ]);

    const item: SocketGemItem = {
      template: {
        socketColor_1: SOCKET_COLOR_RED,
        socketColor_2: SOCKET_COLOR_YELLOW,
        socketColor_3: 0,
        socketBonus: 2000,
      },
      socketEnchantIds: [0, 0, 0],
      hasPrismaticSocket: false,
    };

    const first = socketGem(
      item,
      0,
      { color: SOCKET_COLOR_RED, enchantId: 1001 },
      enchantTable,
      gemColorByEnchantId,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error("expected ok");
    }
    expect(first.socketBonusEnchantId).toBeNull();
    expect(first.socketBonusSpellIds).toEqual([]);

    const afterOne: SocketGemItem = {
      ...item,
      socketEnchantIds: first.socketEnchantIds,
    };
    // wrong color still sockets into yellow, but bonus stays off
    const mismatch = socketGem(
      afterOne,
      1,
      { color: SOCKET_COLOR_RED, enchantId: 1001 },
      enchantTable,
      gemColorByEnchantId,
    );
    expect(mismatch.ok).toBe(true);
    if (!mismatch.ok) {
      throw new Error("expected ok");
    }
    expect(mismatch.socketBonusEnchantId).toBeNull();
    expect(
      gemsFitSockets(item.template, mismatch.socketEnchantIds, enchantTable, gemColorByEnchantId),
    ).toBe(false);

    const match = socketGem(
      afterOne,
      1,
      { color: SOCKET_COLOR_YELLOW, enchantId: 1002 },
      enchantTable,
      gemColorByEnchantId,
    );
    expect(match.ok).toBe(true);
    if (!match.ok) {
      throw new Error("expected ok");
    }
    expect(match.socketBonusEnchantId).toBe(2000);
    expect(match.socketBonusSpellIds).toEqual([9001]);
  });
});

describe("item set bonuses", () => {
  test("activates 2-piece spell at two pieces, not at one", () => {
    const set = itemSetFromSqlRow({
      ID: 42,
      Name_Lang_enUS: "Test Set",
      ItemID_1: 1,
      ItemID_2: 2,
      ItemID_3: 3,
      ItemID_4: 0,
      ItemID_5: 0,
      ItemID_6: 0,
      ItemID_7: 0,
      ItemID_8: 0,
      ItemID_9: 0,
      ItemID_10: 0,
      SetSpellID_1: 1111,
      SetThreshold_1: 2,
      SetSpellID_2: 2222,
      SetThreshold_2: 4,
      SetSpellID_3: 0,
      SetThreshold_3: 0,
      SetSpellID_4: 0,
      SetThreshold_4: 0,
      SetSpellID_5: 0,
      SetThreshold_5: 0,
      SetSpellID_6: 0,
      SetThreshold_6: 0,
      SetSpellID_7: 0,
      SetThreshold_7: 0,
      SetSpellID_8: 0,
      SetThreshold_8: 0,
      RequiredSkill: 0,
      RequiredSkillRank: 0,
    }) satisfies ItemSetEntry;

    const setTable = new Map([[set.id, set]]);

    expect(itemSetBonuses([{ itemSet: 42 }], setTable)).toEqual([]);
    expect(itemSetBonuses([{ itemSet: 42 }, { itemSet: 42 }], setTable)).toEqual([1111]);
    expect(
      itemSetBonuses([{ itemSet: 42 }, { itemSet: 42 }, { itemSet: 42 }, { itemSet: 42 }], setTable),
    ).toEqual([1111, 2222]);
  });
});
