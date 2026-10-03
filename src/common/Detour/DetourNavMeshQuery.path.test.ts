/**
 * dtNavMeshQuery path queries (findPath, sliced find path, findStraightPath, off-mesh links, filters). Expected values
 * are derived by hand from `DetourNavMeshQuery.cpp` on the meshes of `test-navmesh.ts`.
 */
import { describe, expect, test } from "bun:test";
import { NavTerrain } from "../Collision/Management/MMapDefines.ts";
import { DT_POLYTYPE_OFFMESH_CONNECTION, DT_STRAIGHTPATH_ALL_CROSSINGS, DT_STRAIGHTPATH_AREA_CROSSINGS, DT_STRAIGHTPATH_END, DT_STRAIGHTPATH_OFFMESH_CONNECTION, DT_STRAIGHTPATH_START, dtTileAndPoly, type dtNavMesh } from "./DetourNavMesh.ts";
import type { dtNavMeshQuery, dtQueryFilter } from "./DetourNavMeshQuery.ts";
import { DT_BUFFER_TOO_SMALL, DT_FAILURE, DT_IN_PROGRESS, DT_INVALID_PARAM, DT_PARTIAL_RESULT, DT_SUCCESS, dtStatusInProgress } from "./DetourStatus.ts";
import { buildGridTile, cellWorld as world, defaultFilter, rectCells, v3, wallWorld } from "./test-navmesh.ts";

const INVALID = DT_FAILURE | DT_INVALID_PARAM;

function findPath(query: dtNavMeshQuery, startRef: number, endRef: number, s: Float32Array, e: Float32Array, filter: dtQueryFilter = defaultFilter(), maxPath = 256) {
  const path = new Float64Array(Math.max(maxPath, 1));
  const count = new Int32Array(1);
  const status = query.findPath(startRef, endRef, s, e, filter, path, count, maxPath);
  return { status, path: Array.from(path.subarray(0, count[0]!)) };
}

function straight(query: dtNavMeshQuery, s: Float32Array, e: Float32Array, path: number[], max = 16, options = 0) {
  const pts = new Float32Array(max * 3);
  const flags = new Uint8Array(max);
  const refs = new Float64Array(max);
  const count = new Int32Array(1);
  const status = query.findStraightPath(s, e, new Float64Array(path), path.length, pts, flags, refs, count, max, options);
  const n = count[0]!;
  return {
    status,
    points: Array.from({ length: n }, (_, i) => [pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!]),
    flags: Array.from(flags.subarray(0, n)),
    refs: Array.from(refs.subarray(0, n)),
  };
}

/** Every consecutive pair of polys in `path` are edge-adjacent cells. */
function expectConnected(cells: Map<number, readonly [number, number]>, path: number[]) {
  for (let i = 1; i < path.length; ++i) {
    const a = cells.get(path[i - 1]!)!;
    const b = cells.get(path[i]!)!;
    expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])).toBe(1);
  }
  expect(new Set(path).size).toBe(path.length);
}

describe("findPath", () => {
  test("goes around the wall through the gap", () => {
    const { query, ref, cells } = wallWorld();
    const { status, path } = findPath(query, ref(2, 2), ref(6, 2), v3(2.5, 0, 2.5), v3(6.5, 0, 2.5));
    expect(status).toBe(DT_SUCCESS);
    expect(path[0]).toBe(ref(2, 2));
    expect(path.at(-1)).toBe(ref(6, 2));
    expectConnected(cells, path);
    expect(path.includes(ref(4, 8)) || path.includes(ref(4, 9))).toBe(true);
    // Manhattan distance (2,2) -> (4,8) -> (6,2) is 16 steps.
    expect(path.length).toBeGreaterThanOrEqual(17);
  });

  test("returns a partial path ending at the node nearest the unreachable island", () => {
    const { query, ref, cells } = wallWorld();
    const end = v3(0.5, 0, 18.5);
    const { status, path } = findPath(query, ref(2, 2), ref(0, 18), v3(2.5, 0, 2.5), end);
    expect(status).toBe(DT_SUCCESS | DT_PARTIAL_RESULT);
    expect(path[0]).toBe(ref(2, 2));
    expectConnected(cells, path);
    // Node positions are portal midpoints; the closest one to (0.5, 18.5) is (1, 9.5), the x=1 portal of row 9.
    const last = path.at(-1)!;
    expect([ref(0, 9), ref(1, 9)]).toContain(last);
    const pool = query.getNodePool()!;
    const dist = (p: Float32Array) => Math.hypot(p[0]! - end[0]!, p[2]! - end[2]!);
    let best = Infinity;
    for (let i = 1; i <= pool.getNodeCount(); ++i) best = Math.min(best, dist(pool.getNodeAtIdx(i)!.pos));
    const lastNode = pool.findNode(last, 0)!;
    expect(dist(lastNode.pos)).toBeCloseTo(best, 6);
    expect(lastNode.pos[0]).toBeCloseTo(1, 6);
    expect(lastNode.pos[2]).toBeCloseTo(9.5, 6);
    expect(query.isInClosedList(ref(0, 18))).toBe(false);
  });

  test("keeps the first maxPath polys and reports DT_BUFFER_TOO_SMALL", () => {
    const { query, ref } = wallWorld();
    const full = findPath(query, ref(2, 2), ref(6, 2), v3(2.5, 0, 2.5), v3(6.5, 0, 2.5));
    const short = findPath(query, ref(2, 2), ref(6, 2), v3(2.5, 0, 2.5), v3(6.5, 0, 2.5), defaultFilter(), 3);
    expect(short.status).toBe(DT_SUCCESS | DT_BUFFER_TOO_SMALL);
    expect(short.path).toEqual(full.path.slice(0, 3));
  });

  test("start == end and invalid parameters", () => {
    const { query, ref } = wallWorld();
    const s = v3(2.5, 0, 2.5);
    const e = v3(6.5, 0, 2.5);
    expect(findPath(query, ref(2, 2), ref(2, 2), s, s)).toEqual({ status: DT_SUCCESS, path: [ref(2, 2)] });
    const path = new Float64Array(8);
    expect(query.findPath(ref(2, 2), ref(6, 2), s, e, defaultFilter(), path, null, 8)).toBe(INVALID);
    expect(findPath(query, 0, ref(6, 2), s, e)).toEqual({ status: INVALID, path: [] });
    expect(findPath(query, ref(2, 2), ref(6, 2) + 1e6, s, e)).toEqual({ status: INVALID, path: [] });
    expect(findPath(query, ref(2, 2), ref(6, 2), v3(NaN, 0, 0), e).status).toBe(INVALID);
    expect(findPath(query, ref(2, 2), ref(6, 2), s, e, defaultFilter(), 0).status).toBe(INVALID);
    const count = new Int32Array([7]);
    expect(query.findPath(ref(2, 2), ref(6, 2), s, e, null, path, count, 8)).toBe(INVALID);
    expect(count[0]).toBe(0);
  });
});

describe("findStraightPath", () => {
  /** Up column x=3, across the gap row 8, down column x=5. */
  const corridor = (ref: (cx: number, cz: number) => number) => [
    ...[2, 3, 4, 5, 6, 7, 8].map((cz) => ref(3, cz)),
    ref(4, 8),
    ...[8, 7, 6, 5, 4, 3, 2].map((cz) => ref(5, cz)),
  ];

  test("string-pulls a hand-built corridor around the wall corners", () => {
    const { query, ref } = wallWorld();
    const r = straight(query, v3(3.5, 0, 2.5), v3(5.5, 0, 2.5), corridor(ref));
    expect(r.status).toBe(DT_SUCCESS);
    expect(r.points).toEqual([[3.5, 0, 2.5], [4, 0, 8], [5, 0, 8], [5.5, 0, 2.5]]);
    expect(r.flags).toEqual([DT_STRAIGHTPATH_START, 0, 0, DT_STRAIGHTPATH_END]);
    // (4,8) is appended when the left side of portal 7 crosses the right side set by portal 6 (ref path[7]);
    // (5,8) when the left side of portal 8 crosses its right side (ref path[9]).
    expect(r.refs).toEqual([ref(3, 2), ref(4, 8), ref(5, 7), 0]);
  });

  test("truncates at maxStraightPath with DT_BUFFER_TOO_SMALL", () => {
    const { query, ref } = wallWorld();
    const r = straight(query, v3(3.5, 0, 2.5), v3(5.5, 0, 2.5), corridor(ref), 2);
    expect(r.status).toBe(DT_SUCCESS | DT_BUFFER_TOO_SMALL);
    expect(r.points).toEqual([[3.5, 0, 2.5], [4, 0, 8]]);
    expect(r.flags).toEqual([DT_STRAIGHTPATH_START, 0]);
  });

  test("DT_STRAIGHTPATH_ALL_CROSSINGS adds a vertex at every portal", () => {
    const { query, ref } = wallWorld();
    const path = [ref(1, 2), ref(2, 2), ref(3, 2)];
    const plain = straight(query, v3(1.5, 0, 2.5), v3(3.5, 0, 2.5), path);
    expect(plain.status).toBe(DT_SUCCESS);
    expect(plain.points).toEqual([[1.5, 0, 2.5], [3.5, 0, 2.5]]);
    const all = straight(query, v3(1.5, 0, 2.5), v3(3.5, 0, 2.5), path, 16, DT_STRAIGHTPATH_ALL_CROSSINGS);
    expect(all.status).toBe(DT_SUCCESS);
    expect(all.points).toEqual([[1.5, 0, 2.5], [2, 0, 2.5], [3, 0, 2.5], [3.5, 0, 2.5]]);
    expect(all.flags).toEqual([DT_STRAIGHTPATH_START, 0, 0, DT_STRAIGHTPATH_END]);
    expect(all.refs).toEqual([ref(1, 2), ref(2, 2), ref(3, 2), 0]);
  });

  test("DT_STRAIGHTPATH_AREA_CROSSINGS only adds the portal between different areas", () => {
    const tile = buildGridTile({ tx: 0, ty: 0, size: 10, cells: rectCells(0, 0, 10, 10), cellArea: (cx) => (cx >= 3 ? 2 : 1) });
    const { query, ref } = world(10, [tile]);
    const path = [ref(1, 2), ref(2, 2), ref(3, 2), ref(4, 2)];
    const r = straight(query, v3(1.5, 0, 2.5), v3(4.5, 0, 2.5), path, 16, DT_STRAIGHTPATH_AREA_CROSSINGS);
    expect(r.status).toBe(DT_SUCCESS);
    expect(r.points).toEqual([[1.5, 0, 2.5], [3, 0, 2.5], [4.5, 0, 2.5]]);
    expect(r.flags).toEqual([DT_STRAIGHTPATH_START, 0, DT_STRAIGHTPATH_END]);
    expect(r.refs).toEqual([ref(1, 2), ref(3, 2), 0]);
  });

  test("invalid parameters", () => {
    const { query, ref } = wallWorld();
    const pts = new Float32Array(12);
    const count = new Int32Array([5]);
    const s = v3(1.5, 0, 2.5);
    expect(query.findStraightPath(s, s, new Float64Array([ref(1, 2)]), 1, pts, null, null, null, 4)).toBe(INVALID);
    expect(query.findStraightPath(s, s, new Float64Array([ref(1, 2)]), 0, pts, null, null, count, 4)).toBe(INVALID);
    expect(count[0]).toBe(0);
    expect(query.findStraightPath(s, s, new Float64Array([0]), 1, pts, null, null, count, 4)).toBe(INVALID);
    expect(query.findStraightPath(s, s, new Float64Array([ref(1, 2)]), 1, pts, null, null, count, 0)).toBe(INVALID);
    // A single-poly path is start + end.
    expect(query.findStraightPath(s, v3(1.2, 0, 2.2), new Float64Array([ref(1, 2)]), 1, pts, null, null, count, 4)).toBe(DT_SUCCESS);
    expect(count[0]).toBe(2);
  });
});

describe("sliced findPath", () => {
  test("gives the same corridor as findPath", () => {
    const { query, ref } = wallWorld();
    const s = v3(2.5, 0, 2.5);
    const e = v3(6.5, 0, 2.5);
    const filter = defaultFilter();
    const expected = findPath(query, ref(2, 2), ref(6, 2), s, e).path;
    expect(query.initSlicedFindPath(ref(2, 2), ref(6, 2), s, e, filter)).toBe(DT_IN_PROGRESS);
    const done = new Int32Array(1);
    let status = DT_IN_PROGRESS;
    let iters = 0;
    while (dtStatusInProgress(status)) {
      status = query.updateSlicedFindPath(4, done);
      expect(done[0]).toBeLessThanOrEqual(4);
      iters += done[0]!;
    }
    expect(status).toBe(DT_SUCCESS);
    expect(iters).toBeGreaterThan(4);
    const path = new Float64Array(256);
    const count = new Int32Array(1);
    expect(query.finalizeSlicedFindPath(path, count, 256)).toBe(DT_SUCCESS);
    expect(Array.from(path.subarray(0, count[0]!))).toEqual(expected);
  });

  test("invalid start fails the sliced query", () => {
    const { query, ref } = wallWorld();
    expect(query.initSlicedFindPath(0, ref(6, 2), v3(2.5, 0, 2.5), v3(6.5, 0, 2.5), defaultFilter())).toBe(INVALID);
    expect(query.updateSlicedFindPath(10, null)).toBe(DT_FAILURE);
    const count = new Int32Array([3]);
    expect(query.finalizeSlicedFindPath(new Float64Array(4), count, 4)).toBe(DT_FAILURE);
    expect(count[0]).toBe(0);
  });

  test("finalizeSlicedFindPathPartial returns the path to the furthest visited existing poly", () => {
    // A 10x1 strip: the corridor is unique. Three iterations close cells 0..2 and touch cell 3.
    const { query, ref } = world(10, [buildGridTile({ tx: 0, ty: 0, size: 10, cells: rectCells(0, 0, 10, 1) })]);
    const existing = new Float64Array(rectCells(0, 0, 10, 1).map(([cx, cz]) => ref(cx, cz)));
    const path = new Float64Array(16);
    const count = new Int32Array(1);
    const run = () => {
      query.initSlicedFindPath(ref(0, 0), ref(9, 0), v3(0.5, 0, 0.5), v3(9.5, 0, 0.5), defaultFilter());
      expect(query.updateSlicedFindPath(3, null)).toBe(DT_IN_PROGRESS);
    };
    run();
    expect(query.finalizeSlicedFindPathPartial(existing, 10, path, count, 16)).toBe(DT_SUCCESS);
    expect(Array.from(path.subarray(0, count[0]!))).toEqual([0, 1, 2, 3].map((cx) => ref(cx, 0)));
    // No existing poly visited: falls back to the best node so far (cell 3) and flags a partial result.
    run();
    expect(query.finalizeSlicedFindPathPartial(new Float64Array([ref(8, 0)]), 1, path, count, 16)).toBe(DT_SUCCESS | DT_PARTIAL_RESULT);
    expect(Array.from(path.subarray(0, count[0]!))).toEqual([0, 1, 2, 3].map((cx) => ref(cx, 0)));
    expect(query.finalizeSlicedFindPathPartial(null, 0, path, count, 16)).toBe(INVALID);
  });
});

describe("off-mesh connections", () => {
  /** Rectangles A (cells 0..2 x 0..2) and B (cells 6..8 x 0..2), joined by a link (2.5,0,1.5) -> (6.5,0,1.5). */
  function offMeshWorld(bidir: boolean) {
    const tile = buildGridTile({
      tx: 0,
      ty: 0,
      size: 10,
      cells: [...rectCells(0, 0, 3, 3), ...rectCells(6, 0, 9, 3)],
      offMeshCons: [{ start: [2.5, 0, 1.5], end: [6.5, 0, 1.5], rad: 0.5, bidir }],
    });
    const w = world(10, [tile]);
    // The off-mesh poly follows the ground polys.
    const conRef = w.mesh.getPolyRefBase(w.mesh.getTileAt(0, 0, 0)) + tile.polyCells.length;
    return { ...w, conRef };
  }

  function polyType(mesh: dtNavMesh, ref: number): number {
    const tp = new dtTileAndPoly();
    expect(mesh.getTileAndPolyByRef(ref, tp)).toBe(DT_SUCCESS);
    return tp.tile!.polyGetType(tp.poly);
  }

  test("findPath and findStraightPath cross the link", () => {
    const { mesh, query, ref, conRef } = offMeshWorld(true);
    expect(polyType(mesh, conRef)).toBe(DT_POLYTYPE_OFFMESH_CONNECTION);
    const s = v3(1.5, 0, 1.5);
    const e = v3(7.5, 0, 1.5);
    const { status, path } = findPath(query, ref(1, 1), ref(7, 1), s, e);
    expect(status).toBe(DT_SUCCESS);
    expect(path).toEqual([ref(1, 1), ref(2, 1), conRef, ref(6, 1), ref(7, 1)]);

    const r = straight(query, s, e, path);
    expect(r.status).toBe(DT_SUCCESS);
    expect(r.points).toEqual([[1.5, 0, 1.5], [2.5, 0, 1.5], [6.5, 0, 1.5], [7.5, 0, 1.5]]);
    expect(r.flags).toEqual([DT_STRAIGHTPATH_START, DT_STRAIGHTPATH_OFFMESH_CONNECTION, 0, DT_STRAIGHTPATH_END]);
    expect(r.refs).toEqual([ref(1, 1), conRef, ref(6, 1), 0]);

    // Bidirectional: the reverse path uses the link too.
    const back = findPath(query, ref(7, 1), ref(1, 1), e, s);
    expect(back.status).toBe(DT_SUCCESS);
    expect(back.path).toEqual([ref(7, 1), ref(6, 1), conRef, ref(2, 1), ref(1, 1)]);
  });

  test("a one-way link gives a partial reverse path", () => {
    const { query, ref, conRef } = offMeshWorld(false);
    expect(findPath(query, ref(1, 1), ref(7, 1), v3(1.5, 0, 1.5), v3(7.5, 0, 1.5)).path).toContain(conRef);
    const { status, path } = findPath(query, ref(7, 1), ref(1, 2), v3(7.5, 0, 1.5), v3(1.5, 0, 2.4));
    expect(status).toBe(DT_SUCCESS | DT_PARTIAL_RESULT);
    // Best node: (6,2), entered from (6,1) at the portal midpoint (6.5, 2), nearest to (1.5, 2.4).
    expect(path).toEqual([ref(7, 1), ref(6, 1), ref(6, 2)]);
  });
});

describe("query filter", () => {
  test("exclude flags make a poly impassable and the path detours", () => {
    const { mesh, query, ref, cells } = wallWorld();
    const s = v3(2.5, 0, 2.5);
    const e = v3(6.5, 0, 2.5);
    const filter = defaultFilter();
    filter.setExcludeFlags(NavTerrain.NAV_WATER);
    expect(mesh.setPolyFlags(ref(4, 8), NavTerrain.NAV_GROUND | NavTerrain.NAV_WATER)).toBe(DT_SUCCESS);
    expect(findPath(query, ref(2, 2), ref(6, 2), s, e).path).toContain(ref(4, 8));

    const detour = findPath(query, ref(2, 2), ref(6, 2), s, e, filter);
    expect(detour.status).toBe(DT_SUCCESS);
    expect(detour.path).not.toContain(ref(4, 8));
    expect(detour.path).toContain(ref(4, 9));
    expectConnected(cells, detour.path);

    // Both gap cells excluded: the right side is unreachable.
    mesh.setPolyFlags(ref(4, 9), NavTerrain.NAV_WATER);
    const blocked = findPath(query, ref(2, 2), ref(6, 2), s, e, filter);
    expect(blocked.status).toBe(DT_SUCCESS | DT_PARTIAL_RESULT);
    expect(cells.get(blocked.path.at(-1)!)![0]).toBe(3);

    // Include flags: only NAV_WATER polys pass, so nothing next to the start can be entered.
    const water = defaultFilter();
    water.setIncludeFlags(NavTerrain.NAV_WATER);
    expect(findPath(query, ref(2, 2), ref(6, 2), s, e, water)).toEqual({ status: DT_SUCCESS | DT_PARTIAL_RESULT, path: [ref(2, 2)] });
  });
});
