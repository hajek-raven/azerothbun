import { describe, expect, test } from "bun:test";
import { NavTerrain } from "../../../common/Collision/Management/MMapDefines.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { MAP_BLADES_EDGE_ARENA } from "../../Maps/AreaDefines.ts";
import { MAX_POINT_PATH_LENGTH, PATHFIND_NORMAL, PathGenerator, TrySnapToBladeEdgeArenaRope } from "./PathGenerator.ts";
import { fakeCreature, fakeMap, fakeSource } from "./test-path-source.ts";

/** A generator on a map without mmaps (every path is a shortcut). */
function plain(opts: Parameters<typeof fakeMap>[0] = {}, creature = fakeCreature(), mapId = 0): PathGenerator {
  return new PathGenerator(fakeSource(fakeMap(opts), [0, 0, 0], creature, mapId));
}

/** Private members, through the TypeScript bracket escape hatch. */
type Internals = {
  fixupCorridor(path: Float64Array, npath: number, maxPath: number, visited: Float64Array, nvisited: number): number;
  getNavTerrain(x: number, y: number, z: number): number;
  _pathPoints: Vector3[];
  _type: number;
  _pointPathLimit: number;
  _filter: { getIncludeFlags(): number; getExcludeFlags(): number };
};
const internals = (pg: PathGenerator) => pg as unknown as Internals;

describe("PathGenerator::FixupCorridor", () => {
  const fixup = (path: number[], visited: number[], maxPath = 74) => {
    const p = new Float64Array(16);
    p.set(path);
    const n = internals(plain()).fixupCorridor(p, path.length, maxPath, new Float64Array(visited), visited.length);
    return Array.from(p.subarray(0, n));
  };

  test("moved forward along the corridor", () => {
    // furthest common poly is path[2] = visited[2]; req = 1, the corridor after it is kept
    expect(fixup([1, 2, 3, 4, 5], [1, 2, 3])).toEqual([3, 4, 5]);
  });

  test("moved off the corridor: the visited tail is prepended in reverse", () => {
    expect(fixup([1, 2, 3], [1, 2, 9])).toEqual([9, 2, 3]);
  });

  test("no common polygon: the corridor is unchanged", () => {
    expect(fixup([1, 2, 3], [7, 8])).toEqual([1, 2, 3]);
  });

  test("result clamped to maxPath", () => {
    // req = 5 (visited from index 0), orig = 1, size = 3 -> clamped to maxPath - req = 1
    expect(fixup([1, 2, 3, 4], [1, 5, 6, 7, 8], 6)).toEqual([8, 7, 6, 5, 1, 2]);
  });
});

describe("PathGenerator::getPathLength / ShortenPathUntilDist", () => {
  test("length of a shortcut and of an empty path", () => {
    const pg = plain();
    expect(pg.getPathLength()).toBe(0);
    pg.calculatePath(3, 4, 0);
    expect(pg.getPathLength()).toBe(5);
    pg.clear();
    expect(pg.getPath().length).toBe(0);
  });

  test("shortens the last segment to `dist` from the target", () => {
    const pg = plain();
    pg.calculatePath(3, 4, 0);
    pg.shortenPathUntilDist(new Vector3(3, 4, 0), 2);
    const pts = pg.getPath();
    expect(pts.length).toBe(2);
    expect(pts[1]!.x).toBeCloseTo(1.8, 6);
    expect(pts[1]!.y).toBeCloseTo(2.4, 6);
  });

  const setPath = (pg: PathGenerator, xs: number[]) => {
    internals(pg)._pathPoints = xs.map((x) => new Vector3(x, 0, 0));
    internals(pg)._type = PATHFIND_NORMAL;
  };

  test("walks back over the points that are too close", () => {
    const pg = plain();
    setPath(pg, [0, 4, 5, 6]);
    pg.shortenPathUntilDist(new Vector3(6, 0, 0), 3);
    // p[2] and p[1] are within 3, p[0] is not: p[1] moves 1 yard towards p[0]
    expect(pg.getPath().map((p) => p.x)).toEqual([0, 3]);
  });

  test("stops at the first point that loses line of sight", () => {
    const pg = plain({ los: (_x1, _y1, _z1, x2) => x2 !== 4 });
    setPath(pg, [0, 4, 5, 6]);
    pg.shortenPathUntilDist(new Vector3(6, 0, 0), 3);
    expect(pg.getPath().map((p) => p.x)).toEqual([0, 4, 5]);
  });

  test("no-op when nothing is in range, when the start is in range, or before a path exists", () => {
    const pg = plain();
    pg.shortenPathUntilDist(new Vector3(0, 0, 0), 1); // PATHFIND_BLANK: logs, does nothing
    expect(pg.getPath().length).toBe(0);
    setPath(pg, [0, 4, 5, 6]);
    pg.shortenPathUntilDist(new Vector3(20, 0, 0), 3);
    expect(pg.getPath().length).toBe(4);
    pg.shortenPathUntilDist(new Vector3(0, 0, 0), 3);
    expect(pg.getPath().length).toBe(4);
  });
});

describe("PathGenerator climb and swim checks", () => {
  test("GetRequiredHeightToClimb: height * (1 - slope degrees / 100)", () => {
    expect(PathGenerator.getRequiredHeightToClimb(0, 0, 0, 10, 0, 0, 2)).toBe(2);
    expect(PathGenerator.getRequiredHeightToClimb(0, 0, 0, 1, 0, 1, 2)).toBeCloseTo(1.1, 6);
  });

  test("IsWalkableClimb (static and the source-height overloads)", () => {
    expect(PathGenerator.isWalkableClimb(0, 0, 0, 10, 0, 0, 2)).toBe(true);
    expect(PathGenerator.isWalkableClimb(0, 0, 0, 1, 0, 1, 2)).toBe(true); // 1 <= 1.1
    expect(PathGenerator.isWalkableClimb(0, 0, 0, 1, 0, 2, 2)).toBe(false); // 63.4 deg: 2 > 0.73
    const pg = plain();
    expect(pg.isWalkableClimb(0, 0, 0, 1, 0, 2)).toBe(false);
    // Detour (y, z, x) order: v1 = (x 0, y 0, z 0), v2 = (x 1, y 0, z 1)
    expect(pg.isWalkableClimb(new Float32Array([0, 0, 0]), new Float32Array([0, 1, 1]))).toBe(true);
  });

  test("IsSwimmableSegment needs water at both ends and (with checkSwim) a swimming creature", () => {
    const wet = (x: number) => x < 5;
    expect(plain({ inWater: wet }, fakeCreature({ canSwim: true })).isSwimmableSegment(0, 0, 0, 1, 0, 0)).toBe(true);
    expect(plain({ inWater: wet }, fakeCreature({ canSwim: true })).isSwimmableSegment(0, 0, 0, 9, 0, 0)).toBe(false);
    expect(plain({ inWater: wet }).isSwimmableSegment(0, 0, 0, 1, 0, 0)).toBe(false);
    expect(plain({ inWater: wet }).isSwimmableSegment(0, 0, 0, 1, 0, 0, false)).toBe(true);
    expect(plain({ inWater: wet }).isSwimmableSegment(new Float32Array([0, 0, 0]), new Float32Array([0, 0, 1]), false)).toBe(true);
  });

  test("IsInvalidDestinationZ: target more than 5 yards above the actual end", () => {
    const pg = plain();
    pg.calculatePath(3, 4, 0);
    expect(pg.isInvalidDestinationZ({ getPositionZ: () => 5.5 })).toBe(true);
    expect(pg.isInvalidDestinationZ({ getPositionZ: () => 5 })).toBe(false);
  });
});

describe("PathGenerator filters and terrain", () => {
  test("CreateFilter include flags", () => {
    expect(internals(plain({}, fakeCreature()))._filter.getIncludeFlags()).toBe(NavTerrain.NAV_GROUND);
    expect(internals(plain({}, fakeCreature({ canEnterWater: true })))._filter.getIncludeFlags()).toBe(
      NavTerrain.NAV_GROUND | NavTerrain.NAV_WATER | NavTerrain.NAV_MAGMA,
    );
    expect(internals(plain({}, fakeCreature({ canWalk: false })))._filter.getIncludeFlags()).toBe(0);
    const player = new PathGenerator(fakeSource(fakeMap(), [0, 0, 0], null));
    expect(internals(player)._filter.getIncludeFlags()).toBe(NavTerrain.NAV_GROUND | NavTerrain.NAV_WATER | NavTerrain.NAV_MAGMA);
    expect(internals(player)._filter.getExcludeFlags()).toBe(0);
  });

  test("UpdateFilter adds the terrain under a unit in water", () => {
    const slime = { liquid: () => ({ Status: 0x04, Flags: 0x08 }) };
    expect(internals(plain(slime, fakeCreature({ isInWater: true })))._filter.getIncludeFlags()).toBe(NavTerrain.NAV_GROUND | NavTerrain.NAV_MAGMA);
    expect(internals(plain(slime, fakeCreature({ isUnderWater: true })))._filter.getIncludeFlags()).toBe(NavTerrain.NAV_GROUND | NavTerrain.NAV_MAGMA);
    expect(internals(plain(slime, fakeCreature()))._filter.getIncludeFlags()).toBe(NavTerrain.NAV_GROUND);
  });

  test("GetNavTerrain maps liquid types", () => {
    const terrain = (Status: number, Flags: number) => internals(plain({ liquid: () => ({ Status, Flags }) })).getNavTerrain(0, 0, 0);
    expect(terrain(0, 0x01)).toBe(NavTerrain.NAV_GROUND); // LIQUID_MAP_NO_WATER
    expect(terrain(0x04, 0x01)).toBe(NavTerrain.NAV_WATER);
    expect(terrain(0x08, 0x02)).toBe(NavTerrain.NAV_WATER);
    expect(terrain(0x04, 0x04)).toBe(NavTerrain.NAV_MAGMA);
    expect(terrain(0x04, 0x08)).toBe(NavTerrain.NAV_MAGMA);
    expect(terrain(0x04, 0x10)).toBe(NavTerrain.NAV_GROUND); // dark water is not a case
  });

  test("IsWaterPath: every point in water or magma", () => {
    const pg = plain({ liquid: (x) => (x < 5 ? { Status: 0x04, Flags: x < 2 ? 0x01 : 0x04 } : { Status: 0, Flags: 0 }) });
    expect(pg.isWaterPath([new Vector3(0, 0, 0), new Vector3(3, 0, 0)])).toBe(true);
    expect(pg.isWaterPath([new Vector3(0, 0, 0), new Vector3(6, 0, 0)])).toBe(false);
    expect(pg.isWaterPath([])).toBe(true);
  });

  test("SetPathLengthLimit: distance / 4, at most MAX_POINT_PATH_LENGTH", () => {
    const pg = plain();
    pg.setPathLengthLimit(8);
    expect(internals(pg)._pointPathLimit).toBe(2);
    pg.setPathLengthLimit(11.9);
    expect(internals(pg)._pointPathLimit).toBe(2);
    pg.setPathLengthLimit(1000);
    expect(internals(pg)._pointPathLimit).toBe(MAX_POINT_PATH_LENGTH);
  });
});

describe("PathGenerator::NormalizePath", () => {
  test("UpdateAllowedPositionZ is applied to every point", () => {
    const pg = new PathGenerator(fakeSource(fakeMap(), [0, 0, 5], fakeCreature(), 0, (_x, _y, z) => z - 1));
    pg.calculatePath(3, 4, 7);
    expect(pg.getPath().map((p) => p.z)).toEqual([4, 6]);
  });

  test("Blade's Edge Arena ropes snap points within 1.5 yards", () => {
    // rope 1 midpoint (t = 0.5): z = linear 10.904 - sag 0.43
    const sx = Math.fround(6243.1523), ex = Math.fround(6245.9717);
    const sy = Math.fround(267.53094), ey = Math.fround(271.29346);
    const sz = Math.fround(10.929295), ez = Math.fround(10.879172);
    const p = new Vector3((sx + ex) / 2, (sy + ey) / 2, 11);
    expect(TrySnapToBladeEdgeArenaRope(p)).toBe(true);
    expect(p.z).toBeCloseTo((sz + ez) / 2 - Math.fround(0.43), 5);
    const far = new Vector3(6000, 0, 3);
    expect(TrySnapToBladeEdgeArenaRope(far)).toBe(false);
    expect(far.z).toBe(3);

    // on map 562 the snapped point skips UpdateAllowedPositionZ, the other point does not
    const src = fakeSource(fakeMap(), [(sx + ex) / 2, (sy + ey) / 2, 11], fakeCreature(), MAP_BLADES_EDGE_ARENA, () => -100);
    const pg = new PathGenerator(src);
    pg.calculatePath(6100, 260, 20);
    expect(pg.getPath()[0]!.z).toBeCloseTo((sz + ez) / 2 - Math.fround(0.43), 5);
    expect(pg.getPath()[1]!.z).toBe(-100);
  });
});
