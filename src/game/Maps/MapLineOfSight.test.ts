import { afterEach, describe, expect, test } from "bun:test";
import { LINEOFSIGHT_ALL_CHECKS, LINEOFSIGHT_CHECK_GOBJECT_M2, LINEOFSIGHT_CHECK_VMAP, ModelIgnoreFlags } from "../Grids/MapLike.ts";
import { GetHitSpherePointFor, isWithinLOS, isWithinLOSInMap, LineOfSightHooks, type LineOfSightMap, type LineOfSightObject } from "./MapLineOfSight.ts";

type Ask = { from: [number, number, number]; to: [number, number, number]; phasemask: number; checks: number; ignoreFlags: number };

/** A map that records what it was asked and answers `visible`. */
function fakeMap(visible: boolean): { map: LineOfSightMap; asked: Ask[] } {
  const asked: Ask[] = [];
  return {
    asked,
    map: {
      isInLineOfSight(x1, y1, z1, x2, y2, z2, phasemask, checks, ignoreFlags) {
        asked.push({ from: [x1, y1, z1], to: [x2, y2, z2], phasemask, checks, ignoreFlags });
        return visible;
      },
    },
  };
}

const unit = (overrides: Partial<LineOfSightObject> = {}): LineOfSightObject => ({
  map: 0,
  instance: 0,
  phaseMask: 1,
  isPlayer: true,
  x: 0,
  y: 0,
  z: 10,
  collisionHeight: 2,
  combatReach: 1.5,
  ...overrides,
});

const saved = LineOfSightHooks.findMap;
afterEach(() => {
  LineOfSightHooks.findMap = saved;
});

describe("GetHitSpherePointFor", () => {
  test("the point on the hit sphere toward the other, from the eye height", () => {
    const creature = unit({ isPlayer: false, combatReach: 1.5 });
    const point = GetHitSpherePointFor(creature, { x: 10, y: 0, z: 12 });
    expect(point.x).toBeCloseTo(1.5, 5);
    expect(point.y).toBeCloseTo(0, 5);
    expect(point.z).toBeCloseTo(12, 5);
  });

  test("a target closer than the reach to the feet is reached only that far; the reach and the height can be given", () => {
    const creature = unit({ isPlayer: false });
    // 0.5 above the feet, 1.5 below the eye: the point moves 0.5 down from the eye
    const near = GetHitSpherePointFor(creature, { x: 0, y: 0, z: 10.5 });
    expect(near.x).toBeCloseTo(0, 5);
    expect(near.z).toBeCloseTo(11.5, 5);
    const far = GetHitSpherePointFor(creature, { x: 10, y: 0, z: 12 }, null, 4);
    expect(far.x).toBeCloseTo(4, 5);
    // the collision height can be given too
    const high = GetHitSpherePointFor(creature, { x: 10, y: 0, z: 15 }, 5, 1.5);
    expect(high.x).toBeCloseTo(1.5, 5);
    expect(high.z).toBeCloseTo(15, 5);
  });

  test("the same place gives its own eye point", () => {
    const creature = unit({ isPlayer: false });
    expect(GetHitSpherePointFor(creature, { x: 0, y: 0, z: 12 })).toEqual({ x: 0, y: 0, z: 12 });
  });
});

describe("IsWithinLOSInMap", () => {
  test("players look from eye to eye, in the phase of the looker, with the checks and ignore flags given", () => {
    const { map, asked } = fakeMap(true);
    LineOfSightHooks.findMap = () => map;
    const a = unit({ x: 0, y: 0, z: 10, phaseMask: 4 });
    const b = unit({ x: 20, y: 0, z: 10 });
    expect(isWithinLOSInMap(a, b, ModelIgnoreFlags.M2, LINEOFSIGHT_ALL_CHECKS & ~LINEOFSIGHT_CHECK_GOBJECT_M2)).toBe(true);
    expect(asked).toEqual([{ from: [0, 0, 12], to: [20, 0, 12], phasemask: 4, checks: LINEOFSIGHT_CHECK_VMAP | 2, ignoreFlags: ModelIgnoreFlags.M2 }]);
  });

  test("a creature looks from its hit sphere toward the other", () => {
    const { map, asked } = fakeMap(false);
    LineOfSightHooks.findMap = () => map;
    const creature = unit({ isPlayer: false, x: 0, y: 0, z: 10, combatReach: 1.5 });
    const player = unit({ x: 20, y: 0, z: 10 });
    expect(isWithinLOSInMap(creature, player)).toBe(false);
    expect(asked[0]!.from[0]).toBeCloseTo(1.5, 5);
    expect(asked[0]!.to).toEqual([20, 0, 12]);
    // and a creature as the target is hit on its own sphere toward the looker
    asked.length = 0;
    isWithinLOSInMap(player, creature);
    expect(asked[0]!.from).toEqual([20, 0, 12]);
    expect(asked[0]!.to[0]).toBeCloseTo(1.5, 5);
  });

  test("units on different maps or instances do not see each other; without a map nothing is in the way", () => {
    const { map } = fakeMap(true);
    LineOfSightHooks.findMap = () => map;
    expect(isWithinLOSInMap(unit(), unit({ map: 1 }))).toBe(false);
    expect(isWithinLOSInMap(unit({ instance: 3 }), unit({ instance: 4 }))).toBe(false);
    LineOfSightHooks.findMap = () => null;
    expect(isWithinLOSInMap(unit(), unit({ x: 30 }))).toBe(true);
  });
});

describe("IsWithinLOS", () => {
  test("a point is seen from the eye of the unit, at the eye height of the point", () => {
    const { map, asked } = fakeMap(true);
    LineOfSightHooks.findMap = () => map;
    expect(isWithinLOS(unit({ x: 1, y: 2, z: 3 }), 11, 2, 3)).toBe(true);
    expect(asked[0]!.from).toEqual([1, 2, 5]);
    expect(asked[0]!.to).toEqual([11, 2, 5]);
    expect(asked[0]!.checks).toBe(LINEOFSIGHT_ALL_CHECKS);
    expect(asked[0]!.ignoreFlags).toBe(ModelIgnoreFlags.Nothing);
  });

  test("a map that says no is no", () => {
    LineOfSightHooks.findMap = () => fakeMap(false).map;
    expect(isWithinLOS(unit(), 10, 0, 10)).toBe(false);
  });
});
