import { expect, test } from "bun:test";
import { testDatabase } from "../database/test-db.ts";
import { loadSpellState, saveSpellState, type SavedAura } from "./persist.ts";

test("character_aura and character_spell_cooldown keep every AzerothCore column, including 64-bit guids", async () => {
  const db = await testDatabase("characters");
  const aura: SavedAura = {
    guid: 1, casterGuid: 0xf130000001010203n, itemGuid: 0x4000000000000005n, spell: 116, effectMask: 7, recalculateMask: 2, stackCount: 3,
    amount0: -10, amount1: 11, amount2: 12, base_amount0: -9, base_amount1: 14, base_amount2: 15,
    maxDuration: 30000, remainTime: 20000, remainCharges: 2,
  };
  const cooldown = { guid: 1, spell: 116, category: 1, item: 2, time: 123456, needSend: 0 };
  await saveSpellState(db, 1, [aura], [cooldown]);
  const loaded = await loadSpellState(db, 1);
  expect(loaded.auras).toEqual([aura]);
  expect(loaded.cooldowns).toEqual([cooldown]);
  await saveSpellState(db, 1, [], []);
  expect(await loadSpellState(db, 1)).toEqual({ auras: [], cooldowns: [] });
});
