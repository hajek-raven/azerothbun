import { describe, expect, test } from "bun:test";
import { buildNavMesh, wallWorldTiles } from "../../../common/Detour/test-navmesh.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import {
  PATHFIND_FARFROMPOLY_END,
  PATHFIND_INCOMPLETE,
  PATHFIND_NOPATH,
  PATHFIND_NORMAL,
  PATHFIND_NOT_USING_PATH,
  PATHFIND_SHORT,
  PATHFIND_SHORTCUT,
  PathGenerator,
  UNIT_STATE_IGNORE_PATHFINDING,
} from "./PathGenerator.ts";
import { fakeCreature, fakeMap, fakeSource } from "./test-path-source.ts";

// The wall world (`wallWorldTiles`) with 4-yard cells. World (X, Y, Z) is Detour (z, x, y), so in world terms:
// tile (0,0) covers X, Y in [0, 40]; the wall is Y in [16, 20], X in [0, 32] (the gap is X in [32, 40]);
// tile (1,0) is Y in [40, 52], X in [0, 40]; the island is Y in [0, 8], X in [72, 80].
const CS = 4;
const { t00, t10, t01 } = wallWorldTiles(CS);
const { mesh, query } = buildNavMesh(10, [t00, t10, t01], 2048, CS);
const map = fakeMap({ navMesh: mesh, query });
const walker = fakeCreature();
const START: [number, number, number] = [10, 10, 0];

function generator(creature = walker, start = START, m = map): PathGenerator {
  return new PathGenerator(fakeSource(m, start, creature));
}

function xyz(v: Vector3): [number, number, number] {
  return [v.x, v.y, v.z];
}

function insideWall(v: Vector3): boolean {
  return v.y > 16 && v.y < 20 && v.x < 32;
}

describe("PathGenerator::CalculatePath without a usable mesh", () => {
  test("no nav mesh: shortcut, NORMAL | NOT_USING_PATH", () => {
    const pg = generator(walker, START, fakeMap());
    expect(pg.calculatePath(30, 30, 0)).toBe(true);
    expect(pg.getPathType()).toBe(PATHFIND_NORMAL | PATHFIND_NOT_USING_PATH);
    expect(pg.getPath().map(xyz)).toEqual([START, [30, 30, 0]]);
  });

  test("UNIT_STATE_IGNORE_PATHFINDING skips the mesh", () => {
    const pg = generator(fakeCreature({ unitState: UNIT_STATE_IGNORE_PATHFINDING }));
    pg.calculatePath(10, 30, 0);
    expect(pg.getPathType()).toBe(PATHFIND_NORMAL | PATHFIND_NOT_USING_PATH);
    expect(pg.getPath().length).toBe(2);
  });

  test("destination tile not loaded (tile (1,1)) or negative tile coords", () => {
    const pg = generator();
    pg.calculatePath(50, 50, 0);
    expect(pg.getPathType()).toBe(PATHFIND_NORMAL | PATHFIND_NOT_USING_PATH);
    pg.calculatePath(10, -5, 0);
    expect(pg.getPathType()).toBe(PATHFIND_NORMAL | PATHFIND_NOT_USING_PATH);
  });

  test("invalid map coordinates return false and build nothing", () => {
    const pg = generator();
    expect(pg.calculatePath(1e9, 0, 0)).toBe(false);
    expect(pg.getPathType()).toBe(0);
    expect(pg.getPath().length).toBe(0);
  });
});

describe("PathGenerator::BuildPolyPath / BuildPointPath on the mesh", () => {
  test("smooth path around the wall is NORMAL, goes through the gap and ends at the destination", () => {
    const pg = generator();
    pg.calculatePath(10, 30, 0);
    expect(pg.getPathType()).toBe(PATHFIND_NORMAL);
    const path = pg.getPath();
    expect(xyz(path[0]!)).toEqual(START);
    // the last smooth point is the target itself (closestPointOnPolyBoundary of a point inside its poly)
    expect(xyz(path[path.length - 1]!)).toEqual([10, 30, 0]);
    expect(xyz(pg.getActualEndPosition())).toEqual([10, 30, 0]);
    expect(path.some((p) => p.x > 32)).toBe(true);
    expect(path.some(insideWall)).toBe(false);
  });

  test("straight path wraps both corners of the wall end", () => {
    const pg = generator();
    pg.setUseStraightPath(true);
    pg.calculatePath(10, 30, 0);
    expect(pg.getPathType()).toBe(PATHFIND_NORMAL);
    const pts = pg.getPath().map(xyz);
    expect(pts[0]).toEqual(START);
    expect(pts[pts.length - 1]).toEqual([10, 30, 0]);
    expect(pts).toContainEqual([32, 16, 0]);
    expect(pts).toContainEqual([32, 20, 0]);
    // the taut string start -> (32,16) -> (32,20) -> end is the shortest possible length
    expect(pg.getPathLength()).toBeGreaterThanOrEqual(Math.hypot(22, 6) + 4 + Math.hypot(22, 10) - 1e-4);
  });

  test("path across the tile border (1,0) is NORMAL", () => {
    const pg = generator();
    pg.calculatePath(20, 46, 0);
    expect(pg.getPathType()).toBe(PATHFIND_NORMAL);
    expect(xyz(pg.getPath()[pg.getPath().length - 1]!)).toEqual([20, 46, 0]);
  });

  test("start and end on the same polygon: two points", () => {
    const pg = generator();
    pg.calculatePath(11, 11, 0);
    expect(pg.getPathType()).toBe(PATHFIND_NORMAL);
    expect(pg.getPath().map(xyz)).toEqual([START, [11, 11, 0]]);
  });

  test("start and end closer than SMOOTH_PATH_SLOP: the special case appends the end point", () => {
    const pg = generator();
    pg.calculatePath(10.1, 10.1, 0);
    expect(pg.getPathType()).toBe(PATHFIND_NORMAL);
    const pts = pg.getPath();
    expect(pts.length).toBe(2);
    expect(pts[1]!.x).toBeCloseTo(10.1, 5);
    expect(pts[1]!.y).toBeCloseTo(10.1, 5);
  });

  test("unreachable island: findPath returns a partial corridor, INCOMPLETE", () => {
    const pg = generator();
    pg.calculatePath(76, 4, 0);
    expect(pg.getPathType()).toBe(PATHFIND_INCOMPLETE);
    const last = pg.getPath()[pg.getPath().length - 1]!;
    expect(last.x).toBeLessThanOrEqual(40); // stops at the edge of tile (0,0)
    expect(xyz(pg.getActualEndPosition())).toEqual(xyz(last));
    expect(xyz(pg.getEndPosition())).toEqual([76, 4, 0]);
  });

  test("no polygon within the search box: NOPATH for a walker, shortcut points", () => {
    const pg = generator();
    pg.calculatePath(60, 34, 0);
    expect(pg.getPathType()).toBe(PATHFIND_NOPATH);
    expect(pg.getPath().map(xyz)).toEqual([START, [60, 34, 0]]);
  });

  test("no polygon: players and flyers get NORMAL | NOT_USING_PATH, swimmers too when both ends are in water", () => {
    const player = new PathGenerator(fakeSource(map, START, null));
    player.calculatePath(60, 34, 0);
    expect(player.getPathType()).toBe(PATHFIND_NORMAL | PATHFIND_NOT_USING_PATH);

    const flyer = generator(fakeCreature({ canFly: true }));
    flyer.calculatePath(60, 34, 0);
    expect(flyer.getPathType()).toBe(PATHFIND_NORMAL | PATHFIND_NOT_USING_PATH);

    const wet = fakeMap({ navMesh: mesh, query, liquid: () => ({ Status: 0x04, Flags: 0x01 }) });
    const swimmer = generator(fakeCreature({ canSwim: true }), START, wet);
    swimmer.calculatePath(60, 34, 0);
    expect(swimmer.getPathType()).toBe(PATHFIND_NORMAL | PATHFIND_NOT_USING_PATH);

    const dry = generator(fakeCreature({ canSwim: true }));
    dry.calculatePath(60, 34, 0);
    expect(dry.getPathType()).toBe(PATHFIND_NOPATH);
  });

  test("destination 20 yards above the mesh: INCOMPLETE | FARFROMPOLY_END, end clamped onto the polygon", () => {
    const pg = generator();
    pg.calculatePath(10, 30, 20);
    expect(pg.getPathType()).toBe(PATHFIND_INCOMPLETE | PATHFIND_FARFROMPOLY_END);
    expect(xyz(pg.getActualEndPosition())).toEqual([10, 30, 0]);
    expect(xyz(pg.getEndPosition())).toEqual([10, 30, 20]);
  });

  test("far from poly and able to fly: shortcut with the far flag", () => {
    const pg = generator(fakeCreature({ canFly: true }));
    pg.calculatePath(10, 30, 20);
    expect(pg.getPathType()).toBe(PATHFIND_NORMAL | PATHFIND_NOT_USING_PATH | PATHFIND_FARFROMPOLY_END);
    expect(pg.getPath().map(xyz)).toEqual([START, [10, 30, 20]]);
  });

  test("point path limit reached: SHORTCUT | SHORT", () => {
    const pg = generator();
    pg.setPathLengthLimit(8); // 8 / SMOOTH_PATH_STEP_SIZE = 2 points
    pg.calculatePath(10, 30, 0);
    expect(pg.getPathType()).toBe(PATHFIND_SHORTCUT | PATHFIND_SHORT);
    expect(pg.getPath().map(xyz)).toEqual([START, [10, 30, 0]]);
  });

  test("forceDest on an unreachable target: NORMAL | NOT_USING_PATH ending at the destination", () => {
    const pg = generator();
    pg.calculatePath(76, 4, 0, true);
    expect(pg.getPathType()).toBe(PATHFIND_NORMAL | PATHFIND_NOT_USING_PATH);
    expect(xyz(pg.getActualEndPosition())).toEqual([76, 4, 0]);
    expect(xyz(pg.getPath()[pg.getPath().length - 1]!)).toEqual([76, 4, 0]);
  });

  test("recalculation reuses the old corridor (sub-path and prefix + suffix)", () => {
    const pg = generator();
    pg.calculatePath(10, 30, 0);
    // moved along the path, same target: sub-path of the old corridor
    pg.calculatePath(30, 10, 0, 10, 30, 0, false);
    expect(pg.getPathType()).toBe(PATHFIND_NORMAL);
    expect(xyz(pg.getPath()[pg.getPath().length - 1]!)).toEqual([10, 30, 0]);
    // target moved off the old corridor: prefix kept, suffix rebuilt
    pg.calculatePath(30, 10, 0, 6, 36, 0, false);
    expect(pg.getPathType()).toBe(PATHFIND_NORMAL);
    expect(xyz(pg.getPath()[pg.getPath().length - 1]!)).toEqual([6, 36, 0]);
    expect(pg.getPath().some(insideWall)).toBe(false);
  });
});

describe("PathGenerator with _useRaycast", () => {
  test("ray blocked by the wall: INCOMPLETE, second point 1% before the hit", () => {
    const pg = generator();
    pg.setUseRaycast(true);
    pg.calculatePath(10, 30, 0);
    expect(pg.getPathType()).toBe(PATHFIND_INCOMPLETE);
    const pts = pg.getPath();
    expect(pts.length).toBe(2);
    // the ray (Detour x 10 -> 30 at z 10) hits x = 16 at t = 0.3; 0.3 * 0.99 = 0.297 -> x = 15.94
    expect(pts[1]!.x).toBeCloseTo(10, 5);
    expect(pts[1]!.y).toBeCloseTo(15.94, 4);
    expect(pts[1]!.z).toBeCloseTo(0, 5);
  });

  test("clear ray: NORMAL, start and end", () => {
    const pg = generator();
    pg.setUseRaycast(true);
    pg.calculatePath(30, 10, 0);
    expect(pg.getPathType()).toBe(PATHFIND_NORMAL);
    expect(pg.getPath().map(xyz)).toEqual([START, [30, 10, 0]]);
  });

  test("raycast with an invalid end poly still runs (hole at the end)", () => {
    const pg = generator();
    pg.setUseRaycast(true);
    pg.calculatePath(60, 10, 0);
    // the ray leaves tile (0,0) at Detour z = 40 (X = 40) where tile (0,1) has no polygon
    expect(pg.getPathType()).toBe(PATHFIND_INCOMPLETE);
    expect(pg.getPath()[1]!.x).toBeLessThanOrEqual(40);
  });
});
