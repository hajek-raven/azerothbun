import { expect, test } from "bun:test";
import * as D from "./defines.ts";
import * as E from "./enums.ts";
import { MSG_CHANNEL_START, SMSG_AURA_UPDATE, SMSG_CAST_FAILED, SMSG_PERIODICAURALOG, SMSG_SPELL_GO, SMSG_SPELL_START, SMSG_SPELLHEALLOG, SMSG_SPELLNONMELEEDAMAGELOG } from "./packets.ts";
import { SpellStore } from "./spell-info.ts";
import { unsupportedReason } from "./spell.ts";
import { TestMap, TestUnit } from "./test-units.ts";
import { LineOfSightHooks } from "../game/Maps/MapLineOfSight.ts";

const hasDbc = await Bun.file("data/dbc/Spell.dbc").exists();
const spells = hasDbc ? await SpellStore.load("data/dbc", null) : null;

function setup(): { map: TestMap; caster: TestUnit; enemy: TestUnit } {
  const map = new TestMap(spells!);
  const caster = new TestUnit(map, true, { level: 10 });
  const enemy = new TestUnit(map, false, { level: 10, x: 10, health: 5000 });
  // No random spell misses in these tests (`MagicSpellHitResult` caps the hit chance at 100%).
  caster.stats.modSpellHitChance = 100;
  return { map, caster, enemy };
}

test.skipIf(!hasDbc)("Fireball casts for 1.5 s, flies, hits, and leaves its burn ticking", () => {
  const { map, caster, enemy } = setup();
  expect(caster.castSpell(enemy, 133)).toBe(D.SPELL_CAST_OK);
  expect(caster.opcodes()).toContain(SMSG_SPELL_START);
  const mana = caster.power(0);
  expect(mana).toBe(1000);
  map.advance(1499);
  expect(caster.opcodes()).not.toContain(SMSG_SPELL_GO);
  map.advance(1);
  expect(caster.opcodes()).toContain(SMSG_SPELL_GO);
  expect(caster.power(0)).toBeLessThan(mana);
  // The projectile is in flight until the next event after its travel time.
  expect(enemy.health).toBe(5000);
  map.advance(1000);
  expect(caster.opcodes()).toContain(SMSG_SPELLNONMELEEDAMAGELOG);
  expect(enemy.health).toBeLessThan(5000);
  expect(enemy.hasAura(133)).toBe(true);
  expect(enemy.isInCombat()).toBe(true);
  const afterHit = enemy.health;
  map.advance(2000);
  expect(enemy.health).toBeLessThan(afterHit);
  expect(enemy.opcodes()).toContain(SMSG_PERIODICAURALOG);
});

test.skipIf(!hasDbc)("the global cooldown blocks the next cast and a cancelled cast frees it", () => {
  const { map, caster, enemy } = setup();
  caster.castSpell(enemy, 133, { castCount: 1 });
  expect(caster.hasGlobalCooldown(spells!.get(133)!)).toBe(true);
  caster.currentSpells[E.CURRENT_GENERIC_SPELL]!.cancel();
  expect(caster.hasGlobalCooldown(spells!.get(133)!)).toBe(false);
  expect(caster.castSpell(caster, 139, { castCount: 2 })).toBe(D.SPELL_CAST_OK);
  expect(caster.castSpell(enemy, 133, { castCount: 3 })).toBe(D.SPELL_FAILED_NOT_READY);
  expect(caster.opcodes()).toContain(SMSG_CAST_FAILED);
  map.advance(1500);
  expect(caster.castSpell(enemy, 133, { castCount: 4 })).toBe(D.SPELL_CAST_OK);
});

test.skipIf(!hasDbc)("Renew applies a heal-over-time aura that ticks and expires", () => {
  const { map, caster } = setup();
  caster.setHealth(100);
  expect(caster.castSpell(caster, 139)).toBe(D.SPELL_CAST_OK);
  // Visible aura changes go out with the unit's next update (`m_visibleAurasToUpdate`).
  map.advance(1);
  expect(caster.opcodes()).toContain(SMSG_AURA_UPDATE);
  expect(caster.hasAura(139)).toBe(true);
  map.advance(3000);
  expect(caster.health).toBeGreaterThan(100);
  map.advance(12000);
  expect(caster.hasAura(139)).toBe(false);
});

test.skipIf(!hasDbc)("a direct heal restores health and sends the heal log", () => {
  const { map, caster } = setup();
  caster.setHealth(100);
  caster.castSpell(caster, 2050);
  map.advance(1500);
  expect(caster.opcodes()).toContain(SMSG_SPELLHEALLOG);
  expect(caster.health).toBeGreaterThan(100);
});

test.skipIf(!hasDbc)("Power Word: Fortitude raises maximum health through the stamina modifier group", () => {
  const { caster } = setup();
  const before = caster.stats.getFlatModifierValue(E.UNIT_MOD_STAT_STAMINA, E.TOTAL_VALUE);
  caster.castSpell(caster, 1243);
  expect(caster.hasAura(1243)).toBe(true);
  expect(caster.stats.getFlatModifierValue(E.UNIT_MOD_STAT_STAMINA, E.TOTAL_VALUE)).toBeGreaterThan(before);
  caster.removeAurasDueToSpell(1243);
  expect(caster.stats.getFlatModifierValue(E.UNIT_MOD_STAT_STAMINA, E.TOTAL_VALUE)).toBe(before);
});

test.skipIf(!hasDbc)("a stun sets the stunned state and prevents the victim from casting", () => {
  const { map, caster, enemy } = setup();
  caster.castSpell(enemy, 853);
  map.advance(10);
  expect(enemy.hasUnitState(E.UNIT_STATE_STUNNED)).toBe(true);
  expect(enemy.hasUnitFlag(E.UNIT_FLAG_STUNNED)).toBe(true);
  expect(enemy.castSpell(caster, 133)).toBe(D.SPELL_FAILED_STUNNED);
  enemy.removeAurasDueToSpell(853);
  expect(enemy.hasUnitState(E.UNIT_STATE_STUNNED)).toBe(false);
});

test.skipIf(!hasDbc)("Frost Nova hits every enemy around the caster and roots them", () => {
  const map = new TestMap(spells!);
  const caster = new TestUnit(map, true, { level: 10 });
  const near = new TestUnit(map, false, { x: 3 });
  const also = new TestUnit(map, false, { y: 4 });
  const far = new TestUnit(map, false, { x: 40 });
  const friend = new TestUnit(map, true, { x: 2 });
  // `MagicSpellHitResult` caps the hit chance at 100%, so a large bonus removes the random miss.
  caster.stats.modSpellHitChance = 100;
  caster.castSpell(null, 122);
  map.advance(10);
  expect(near.hasUnitState(E.UNIT_STATE_ROOT)).toBe(true);
  expect(also.hasUnitState(E.UNIT_STATE_ROOT)).toBe(true);
  expect(far.hasUnitState(E.UNIT_STATE_ROOT)).toBe(false);
  expect(friend.hasUnitState(E.UNIT_STATE_ROOT)).toBe(false);
});

test.skipIf(!hasDbc)("Arcane Missiles channels and fires its triggered missiles each tick", () => {
  const { map, caster, enemy } = setup();
  expect(caster.castSpell(enemy, 5143)).toBe(D.SPELL_CAST_OK);
  // A channel with no cast time starts on the next update (`prepare` only casts generic spells at once).
  map.advance(1);
  expect(caster.opcodes()).toContain(MSG_CHANNEL_START);
  expect(caster.currentSpells[E.CURRENT_CHANNELED_SPELL]).not.toBeNull();
  for (let i = 0; i < 40; i++) map.advance(100);
  expect(enemy.health).toBeLessThan(5000);
  map.advance(2000);
  expect(caster.currentSpells[E.CURRENT_CHANNELED_SPELL]).toBeNull();
});

test.skipIf(!hasDbc)("moving interrupts a cast that has a cast time", () => {
  const { map, caster, enemy } = setup();
  caster.castSpell(enemy, 133);
  caster.moving = true;
  map.advance(100);
  expect(caster.currentSpells[E.CURRENT_GENERIC_SPELL]).toBeNull();
  expect(enemy.health).toBe(5000);
});

test.skipIf(!hasDbc)("school immunity turns a hit into an immune miss", () => {
  const { map, caster, enemy } = setup();
  enemy.applySpellImmune(1, E.IMMUNITY_SCHOOL, E.SPELL_SCHOOL_MASK_FIRE, true);
  caster.castSpell(enemy, 133);
  map.advance(3000);
  expect(enemy.health).toBe(5000);
  expect(enemy.hasAura(133)).toBe(false);
});

test.skipIf(!hasDbc)("spells outside the baseline are refused before they spend anything", () => {
  const { caster } = setup();
  const resurrection = spells!.get(2006)!;
  expect(unsupportedReason(resurrection, spells!)).not.toBeNull();
  const mana = caster.power(0);
  expect(caster.castSpell(caster, 2006)).toBe(D.SPELL_FAILED_ERROR);
  expect(caster.power(0)).toBe(mana);
  expect(unsupportedReason(spells!.get(133)!, spells!)).toBeNull();
});

test.skipIf(!hasDbc)("killing the target with a direct hit removes its auras", () => {
  const map = new TestMap(spells!);
  const caster = new TestUnit(map, true, { level: 60 });
  const enemy = new TestUnit(map, false, { level: 1, x: 5, health: 10 });
  caster.stats.modSpellHitChance = 100;
  caster.castSpell(enemy, 853);
  map.advance(10);
  expect(enemy.hasAura(853)).toBe(true);
  caster.castSpell(enemy, 133, { triggered: true });
  // The first event records the delay start; the missile lands on a later one.
  map.advance(10);
  map.advance(1000);
  expect(enemy.isAlive()).toBe(false);
  expect(enemy.appliedAuras.length).toBe(0);
});

test.skipIf(!hasDbc)("a spell needs line of sight to its target, except one that ignores it or a spell on the caster", () => {
  const { map, caster, enemy } = setup();
  const saved = LineOfSightHooks.findMap;
  const info = spells!.get(133)!;
  const attributes = info.attributes[2]!;
  const asked: number[][] = [];
  LineOfSightHooks.findMap = () => ({
    isInLineOfSight(x1, _y1, _z1, x2, _y2, _z2, _phase, checks) {
      asked.push([x1, x2, checks]);
      return false;
    },
  });
  try {
    expect(caster.castSpell(enemy, 133)).toBe(D.SPELL_FAILED_LINE_OF_SIGHT);
    expect(caster.opcodes()).toContain(SMSG_CAST_FAILED);
    // from the caster's eye to the creature's hit sphere toward the caster (x 0 -> 10 - combat reach 1.5), with every check
    expect(asked[0]![0]).toBeCloseTo(0, 3);
    expect(asked[0]![1]).toBeCloseTo(8.5, 3);
    expect(asked[0]![2]).toBe(7);

    // a spell on the caster is not checked
    asked.length = 0;
    expect(caster.castSpell(caster, 139, { castCount: 2 })).toBe(D.SPELL_CAST_OK);
    expect(asked).toHaveLength(0);
    map.advance(1500);

    // SPELL_ATTR2_IGNORE_LINE_OF_SIGHT (also set by a `disables` row)
    info.attributes[2] = (attributes | D.SPELL_ATTR2_IGNORE_LINE_OF_SIGHT) >>> 0;
    expect(caster.castSpell(enemy, 133, { castCount: 3 })).toBe(D.SPELL_CAST_OK);
  } finally {
    info.attributes[2] = attributes;
    LineOfSightHooks.findMap = saved;
  }
});

test.skipIf(!hasDbc)("a spell with line of sight to its target casts", () => {
  const { caster, enemy } = setup();
  const saved = LineOfSightHooks.findMap;
  LineOfSightHooks.findMap = () => ({ isInLineOfSight: () => true });
  try {
    expect(caster.castSpell(enemy, 133)).toBe(D.SPELL_CAST_OK);
  } finally {
    LineOfSightHooks.findMap = saved;
  }
});
