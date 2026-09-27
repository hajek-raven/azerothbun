import { expect, test } from "bun:test";
import { spell_cooldown_overrides } from "../database/schema/world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { SpellStore, calcCastTime, calcEffectValue, isNextMeleeSwingSpell } from "./spell-info.ts";

test.skipIf(!(await Bun.file("data/dbc/Spell.dbc").exists()))("SpellStore reads client DBC spell, cast time, and effects", async () => {
  const spells = await SpellStore.load("data/dbc", null);
  expect(spells.size).toBeGreaterThan(10000);
  const heroicStrike = spells.get(78)!;
  expect(heroicStrike.name).toBe("Heroic Strike");
  expect(isNextMeleeSwingSpell(heroicStrike)).toBe(true);
  const fireball = spells.get(133)!;
  expect(fireball.name).toBe("Fireball");
  expect(calcCastTime(fireball)).toBe(1500);
  expect(fireball.effects[0].effect).toBe(2);
  expect(calcEffectValue(fireball, fireball.effects[0], 1, 0, (min) => min)).toBeGreaterThan(0);
});

test.skipIf(!(await Bun.file("data/dbc/Spell.dbc").exists()))("world cooldown overrides write recovery times the way LoadSpellInfoCustomAttributes does", async () => {
  const world = WorldTables.fromRows([
    [spell_cooldown_overrides, [{ Id: 2050, RecoveryTime: 12000, CategoryRecoveryTime: 15000, StartRecoveryTime: 500, StartRecoveryCategory: 7 }]],
  ]);
  const spells = await SpellStore.load("data/dbc", world);
  const dbc = (await SpellStore.load("data/dbc", null)).get(2050)!;
  // A differing start recovery rewrites RecoveryTime, never the start recovery fields themselves.
  expect(spells.get(2050)).toMatchObject({ recoveryTime: 12000, categoryRecoveryTime: 15000, startRecoveryTime: dbc.startRecoveryTime, startRecoveryCategory: dbc.startRecoveryCategory });
});
