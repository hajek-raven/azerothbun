import { describe, expect, test } from "bun:test";
import { emptyStatDbcStores, type GtTable } from "../data/dbc-stats.ts";
import { CLASS_MAGE, CLASS_ROGUE, CLASS_WARRIOR, PlayerStats, POWER_ENERGY, POWER_MANA, POWER_RAGE } from "./player-stats.ts";
import { isStandState, PlayerRegen } from "./regen.ts";

const idle = { inCombat: false, standing: true, recentManaUse: false };

function gt(values: Record<number, number>): GtTable {
  return { lookup: (index) => values[index] };
}

describe("PlayerRegen", () => {
  test("health regenerates every two seconds out of combat from gtOCTRegenHP / gtRegenHPPerSpt", () => {
    const stores = emptyStatDbcStores();
    stores.octRegenHP = gt({ 0: 0.25 });
    stores.regenHPPerSpt = gt({ 0: 0.5 });
    const stats = new PlayerStats({
      race: 1,
      classId: CLASS_WARRIOR,
      level: 1,
      maxLevel: 80,
      stores,
      levelStats: { baseHealth: 20, baseMana: 0, stats: [23, 20, 22, 20, 20] },
    });
    stats.updateAllStats();
    stats.setHealth(30);
    const regen = new PlayerRegen(stats);
    regen.update(1000, true, idle);
    expect(stats.health).toBe(30);
    regen.update(1000, true, idle);
    // spirit 20 → 20 * 0.25 * 2 = 10
    expect(stats.health).toBe(40);
    regen.update(2000, true, { ...idle, standing: false });
    // sitting: 10 * 1.33
    expect(stats.health).toBe(53);
    regen.update(2000, true, { ...idle, inCombat: true });
    expect(stats.health).toBe(53);
    regen.update(2000, false, idle);
    expect(stats.health).toBe(53);
  });

  test("rage decays out of combat and sends a power update each tick", () => {
    const stats = new PlayerStats({
      race: 1,
      classId: CLASS_WARRIOR,
      level: 1,
      maxLevel: 80,
      levelStats: { baseHealth: 20, baseMana: 0, stats: [23, 20, 22, 20, 20] },
    });
    stats.updateAllStats();
    stats.setPower(POWER_RAGE, 100);
    const regen = new PlayerRegen(stats);
    const rage = (updates: { power: number; value: number }[]) => updates.filter((update) => update.power === POWER_RAGE);
    expect(rage(regen.update(2000, true, idle))).toEqual([{ power: POWER_RAGE, value: 80 }]);
    expect(rage(regen.update(2000, true, { ...idle, inCombat: true }))).toEqual([]);
    expect(stats.power(POWER_RAGE)).toBe(80);
  });

  test("energy refills 10 per second and keeps the fraction", () => {
    const stats = new PlayerStats({
      race: 1,
      classId: CLASS_ROGUE,
      level: 1,
      maxLevel: 80,
      levelStats: { baseHealth: 25, baseMana: 0, stats: [21, 23, 21, 20, 20] },
    });
    stats.updateAllStats();
    stats.setPower(POWER_ENERGY, 0);
    const regen = new PlayerRegen(stats);
    regen.update(150, true, idle);
    expect(stats.power(POWER_ENERGY)).toBe(1);
    regen.update(150, true, idle);
    expect(stats.power(POWER_ENERGY)).toBe(3);
    regen.update(20000, true, idle);
    expect(stats.power(POWER_ENERGY)).toBe(100);
  });

  test("mana uses the spirit regen field", () => {
    const stores = emptyStatDbcStores();
    stores.regenMPPerSpt = gt({ [(CLASS_MAGE - 1) * 100]: 0.1 });
    const stats = new PlayerStats({
      race: 1,
      classId: CLASS_MAGE,
      level: 1,
      maxLevel: 80,
      stores,
      levelStats: { baseHealth: 32, baseMana: 100, stats: [20, 20, 20, 23, 22] },
    });
    stats.updateAllStats();
    stats.setPower(POWER_MANA, 0);
    const regen = new PlayerRegen(stats);
    regen.update(2000, true, idle);
    // sqrt(23) * 22 * 0.1 per second, two seconds
    expect(stats.power(POWER_MANA)).toBe(Math.trunc(Math.sqrt(23) * 2.2 * 2));
  });

  test("stand states that count as resting", () => {
    expect(isStandState(0)).toBe(true);
    expect(isStandState(1)).toBe(false);
    expect(isStandState(3)).toBe(false);
    expect(isStandState(7)).toBe(true);
    expect(isStandState(8)).toBe(false);
  });
});
