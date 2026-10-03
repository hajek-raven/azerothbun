/**
 * dtNavMeshQuery local queries (moveAlongSurface, raycast, heights, nearest poly, poly queries, Dijkstra searches,
 * walls, random points). Expected values are derived by hand from `DetourNavMeshQuery.cpp` on the meshes of
 * `test-navmesh.ts`.
 */
import { describe, expect, test } from "bun:test";
import { NavTerrain } from "../Collision/Management/MMapDefines.ts";
import { DT_RAYCAST_USE_COSTS } from "./DetourNavMesh.ts";
import { dtRaycastHit } from "./DetourNavMeshQuery.ts";
import { DT_BUFFER_TOO_SMALL, DT_FAILURE, DT_INVALID_PARAM, DT_SUCCESS } from "./DetourStatus.ts";
import { buildGridTile, cellWorld, defaultFilter, rectCells, v3, wallWorld } from "./test-navmesh.ts";

const INVALID = DT_FAILURE | DT_INVALID_PARAM;
const FLT_MAX = 3.4028234663852886e38;
const expectVec = (a: ArrayLike<number>, x: number, y: number, z: number) => [x, y, z].forEach((v, i) => expect(a[i]!).toBeCloseTo(v, 5));
// Shared output buffers (tests in a file run one at a time).
const count = new Int32Array(1);
const refs = new Float64Array(32);
const parents = new Float64Array(32);
const costs = new Float32Array(32);
const pt = new Float32Array(3);
const head = (a: Float64Array) => Array.from(a.subarray(0, count[0]!));
const wallCells = rectCells(0, 0, 10, 10).filter(([cx, cz]) => !(cx === 4 && cz < 8));
/** Tile (0,0) of the wall world without a BV tree, so `queryPolygonsInTile` tests exact float bounds. */
const noBvWall = () => cellWorld(10, [buildGridTile({ tx: 0, ty: 0, size: 10, cells: wallCells, buildBvTree: false })]);

describe("moveAlongSurface", () => {
  test("stops at the wall x=4", () => {
    const { query, ref } = wallWorld();
    const status = query.moveAlongSurface(ref(2, 2), v3(2.5, 0, 2.5), v3(6, 0, 2.5), defaultFilter(), pt, refs, count, 16);
    expect(status).toBe(DT_SUCCESS);
    expect(Array.from(pt)).toEqual([4, 0, 2.5]);
    expect(head(refs)).toEqual([ref(2, 2), ref(3, 2)]);
  });

  test("reaches a target inside the mesh, truncates refs, validates input", () => {
    const { query, ref } = wallWorld();
    expect(query.moveAlongSurface(ref(2, 2), v3(2.5, 0, 2.5), v3(2.5, 0, 4.5), defaultFilter(), pt, refs, count, 16)).toBe(DT_SUCCESS);
    expect(Array.from(pt)).toEqual([2.5, 0, 4.5]);
    expect(head(refs)).toEqual([ref(2, 2), ref(2, 3), ref(2, 4)]);
    const s1 = query.moveAlongSurface(ref(2, 2), v3(2.5, 0, 2.5), v3(2.5, 0, 4.5), defaultFilter(), pt, refs, count, 1);
    expect(s1).toBe(DT_SUCCESS | DT_BUFFER_TOO_SMALL);
    expect(count[0]).toBe(1);
    expect(refs[0]).toBe(ref(2, 2));
    expect(query.moveAlongSurface(ref(2, 2), v3(2.5, 0, 2.5), v3(2.5, 0, 4.5), defaultFilter(), pt, refs, null, 16)).toBe(INVALID);
    expect(query.moveAlongSurface(0, v3(2.5, 0, 2.5), v3(2.5, 0, 4.5), defaultFilter(), pt, refs, count, 16)).toBe(INVALID);
  });
});

describe("raycast", () => {
  test("old overload: hits the wall at t=0.375 with normal (-1,0,0)", () => {
    const { query, ref } = wallWorld();
    const t = new Float32Array(1);
    const normal = new Float32Array(3);
    expect(query.raycast(ref(2, 2), v3(2.5, 0, 2.5), v3(6.5, 0, 2.5), defaultFilter(), t, normal, refs, count, 8)).toBe(DT_SUCCESS);
    expect(t[0]).toBe(0.375);
    expectVec(normal, -1, 0, 0);
    expect(head(refs)).toEqual([ref(2, 2), ref(3, 2)]);
    // Clear ray: the end lies inside (2,7).
    expect(query.raycast(ref(2, 2), v3(2.5, 0, 2.5), v3(2.5, 0, 7.5), defaultFilter(), t, normal, refs, count, 8)).toBe(DT_SUCCESS);
    expect(t[0]).toBe(FLT_MAX);
    expect(Array.from(normal)).toEqual([0, 0, 0]);
    expect(head(refs)).toEqual([2, 3, 4, 5, 6, 7].map((cz) => ref(2, cz)));
    // Path buffer too small.
    expect(query.raycast(ref(2, 2), v3(2.5, 0, 2.5), v3(2.5, 0, 7.5), defaultFilter(), t, null, refs, count, 1)).toBe(DT_SUCCESS | DT_BUFFER_TOO_SMALL);
    expect(count[0]).toBe(1);
    expect(query.raycast(0, v3(2.5, 0, 2.5), v3(2.5, 0, 7.5), defaultFilter(), t, null, refs, count, 8)).toBe(INVALID);
  });

  test("dtRaycastHit overload with DT_RAYCAST_USE_COSTS sums the segment costs", () => {
    const { query, ref } = wallWorld();
    const hit = new dtRaycastHit();
    hit.path = new Float64Array(8);
    hit.maxPath = 8;
    const filter = defaultFilter();
    expect(query.raycast(ref(2, 2), v3(2.5, 0, 2.5), v3(2.5, 0, 5.5), filter, DT_RAYCAST_USE_COSTS, hit)).toBe(DT_SUCCESS);
    expect(hit.t).toBe(FLT_MAX);
    expect(hit.pathCount).toBe(4);
    expect(hit.pathCost).toBeCloseTo(3, 5);
    filter.setAreaCost(NavTerrain.NAV_GROUND, 2);
    query.raycast(ref(2, 2), v3(2.5, 0, 2.5), v3(2.5, 0, 5.5), filter, DT_RAYCAST_USE_COSTS, hit);
    expect(hit.pathCost).toBeCloseTo(6, 5);
    // Hit: (2.5 -> 3) in (2,2) plus (3 -> 4) in (3,2).
    expect(query.raycast(ref(2, 2), v3(2.5, 0, 2.5), v3(6.5, 0, 2.5), defaultFilter(), DT_RAYCAST_USE_COSTS, hit)).toBe(DT_SUCCESS);
    expect(hit.t).toBe(0.375);
    expect(hit.hitEdgeIndex).toBe(2);
    expect(hit.pathCost).toBeCloseTo(1.5, 5);
    expectVec(hit.hitNormal, -1, 0, 0);
    // Without the option there is no cost; without a refs buffer every refs poly overflows it.
    const bare = new dtRaycastHit();
    expect(query.raycast(ref(2, 2), v3(2.5, 0, 2.5), v3(2.5, 0, 5.5), defaultFilter(), 0, bare)).toBe(DT_SUCCESS | DT_BUFFER_TOO_SMALL);
    expect(bare.pathCost).toBe(0);
    expect(bare.pathCount).toBe(0);
    expect(query.raycast(ref(2, 2), v3(2.5, 0, 2.5), v3(2.5, 0, 5.5), defaultFilter(), 0, null)).toBe(INVALID);
  });
});

describe("heights and nearest points", () => {
  test("getPolyHeight on a ramp y = 0.5 * x", () => {
    const ramp = buildGridTile({ tx: 0, ty: 0, size: 10, cells: rectCells(0, 0, 10, 10), height: (vx) => 0.5 * vx });
    const { query, ref } = cellWorld(10, [ramp], (cx) => 0.5 * (cx + 0.5));
    const h = new Float32Array(1);
    expect(query.getPolyHeight(ref(3, 2), v3(3.3, 0, 2.5), h)).toBe(DT_SUCCESS);
    expect(h[0]).toBeCloseTo(1.65, 5);
    // Written to pos[1], like `getPolyHeight(ref, pos, &pos[1])`.
    const pos = v3(3.8, 9, 2.5);
    expect(query.getPolyHeight(ref(3, 2), pos, pos, 1)).toBe(DT_SUCCESS);
    expect(pos[1]).toBeCloseTo(1.9, 5);
    expect(query.getPolyHeight(ref(3, 2), v3(5.5, 0, 2.5), h)).toBe(INVALID);
    expect(query.getPolyHeight(0, v3(3.3, 0, 2.5), h)).toBe(INVALID);
    // closestPointOnPoly over the ramp snaps to the surface.
    const over = { value: false };
    const closest = new Float32Array(3);
    expect(query.closestPointOnPoly(ref(3, 2), v3(3.3, 10, 2.5), closest, over)).toBe(DT_SUCCESS);
    expect(over.value).toBe(true);
    expectVec(closest, 3.3, 1.65, 2.5);
  });

  test("findNearestPoly", () => {
    const { query, ref } = wallWorld();
    const nearest = new Float64Array(1);
    const pt = new Float32Array(3);
    expect(query.findNearestPoly(v3(2.5, 0.8, 2.5), v3(0.1, 1, 0.1), defaultFilter(), nearest, pt)).toBe(DT_SUCCESS);
    expect(nearest[0]).toBe(ref(2, 2));
    expect(Array.from(pt)).toEqual([2.5, 0, 2.5]);
    // Larger box from inside the wall: (3,2) is 0.3 away, (5,2) 0.7.
    expect(query.findNearestPoly(v3(4.3, 0, 2.5), v3(1, 1, 1), defaultFilter(), nearest, pt)).toBe(DT_SUCCESS);
    expect(nearest[0]).toBe(ref(3, 2));
    expectVec(pt, 4, 0, 2.5);
    // With the BV tree the box [4.2, 4.4] is quantized to [4, 5], which touches (3,2) and (5,2).
    expect(query.findNearestPoly(v3(4.3, 0, 2.5), v3(0.1, 1, 0.1), defaultFilter(), nearest, pt)).toBe(DT_SUCCESS);
    expect(nearest[0]).toBe(ref(3, 2));
    // Without the BV tree the float bounds are exact: nothing overlaps, ref 0, nearestPt untouched.
    const exact = noBvWall();
    pt.set([7, 7, 7]);
    expect(exact.query.findNearestPoly(v3(4.3, 0, 2.5), v3(0.1, 1, 0.1), defaultFilter(), nearest, pt)).toBe(DT_SUCCESS);
    expect(nearest[0]).toBe(0);
    expect(Array.from(pt)).toEqual([7, 7, 7]);
    expect(exact.query.findNearestPoly(v3(4.3, 0, 2.5), v3(1, 1, 1), defaultFilter(), nearest, pt)).toBe(DT_SUCCESS);
    expect(nearest[0]).toBe(exact.ref(3, 2));
    expect(query.findNearestPoly(v3(2.5, 0, 2.5), v3(1, 1, 1), defaultFilter(), null, pt)).toBe(INVALID);
    expect(query.findNearestPoly(v3(NaN, 0, 2.5), v3(1, 1, 1), defaultFilter(), nearest, pt)).toBe(INVALID);
  });

  test("closestPointOnPoly (posOverPoly) and closestPointOnPolyBoundary", () => {
    const { query, ref } = wallWorld();
    const over = { value: false };
    const c = new Float32Array(3);
    expect(query.closestPointOnPoly(ref(2, 2), v3(2.5, 3, 2.5), c, over)).toBe(DT_SUCCESS);
    expect(over.value).toBe(true);
    expect(Array.from(c)).toEqual([2.5, 0, 2.5]);
    expect(query.closestPointOnPoly(ref(2, 2), v3(1.5, 3, 2.5), c, over)).toBe(DT_SUCCESS);
    expect(over.value).toBe(false);
    expectVec(c, 2, 0, 2.5);
    query.closestPointOnPoly(ref(2, 2), v3(1.5, 3, 1.5), c, over);
    expectVec(c, 2, 0, 2);
    expect(query.closestPointOnPoly(0, v3(1.5, 3, 1.5), c, over)).toBe(INVALID);
    // Inside: the point itself (height kept). Outside: clamped to the nearest edge.
    expect(query.closestPointOnPolyBoundary(ref(2, 2), v3(2.5, 3, 2.5), c)).toBe(DT_SUCCESS);
    expect(Array.from(c)).toEqual([2.5, 3, 2.5]);
    const p = v3(1.5, 3, 2.5);
    expect(query.closestPointOnPolyBoundary(ref(2, 2), p, p)).toBe(DT_SUCCESS);
    expectVec(p, 2, 0, 2.5);
    expect(query.closestPointOnPolyBoundary(0, p, c)).toBe(INVALID);
  });
});

describe("poly queries", () => {
  test("queryPolygons: BV quantization, exact bounds, DT_BUFFER_TOO_SMALL", () => {
    const polys = new Float64Array(64);
    // Box [1.5, 3.5]^2 quantizes to [0, 5]^3: cells 0..5 x 0..5 minus the wall cells (4, 0..5) = 30, plus poly 0
    // once more: dtCreateNavMeshData sets bvNodeCount = 2 * polyCount but the tree has 2n - 1 nodes, and the
    // zero-filled last node is a leaf for poly 0 with bounds (0,0,0)-(0,0,0), inside the quantized box.
    const bv = wallWorld();
    expect(bv.query.queryPolygons(v3(2.5, 0, 2.5), v3(1, 1, 1), defaultFilter(), polys, count, 64)).toBe(DT_SUCCESS);
    expect(count[0]).toBe(31);
    expect(polys[30]).toBe(polys[0]!);
    expect(polys[0]).toBe(bv.ref(0, 0));
    expect(new Set(polys.subarray(0, 31)).size).toBe(30);
    const exact = noBvWall();
    expect(exact.query.queryPolygons(v3(2.5, 0, 2.5), v3(1, 1, 1), defaultFilter(), polys, count, 64)).toBe(DT_SUCCESS);
    const got = head(polys).sort((a, b) => a - b);
    expect(got).toEqual(rectCells(1, 1, 4, 4).map(([cx, cz]) => exact.ref(cx, cz)).sort((a, b) => a - b));
    expect(exact.query.queryPolygons(v3(2.5, 0, 2.5), v3(1, 1, 1), defaultFilter(), polys, count, 4)).toBe(DT_SUCCESS | DT_BUFFER_TOO_SMALL);
    expect(count[0]).toBe(4);
    expect(exact.query.queryPolygons(v3(2.5, 0, 2.5), v3(1, 1, 1), defaultFilter(), polys, null, 4)).toBe(INVALID);
  });

  test("findPolysAroundCircle: Dijkstra costs in increasing order", () => {
    const { query, ref } = wallWorld();
    expect(query.findPolysAroundCircle(ref(2, 2), v3(2.5, 0, 2.5), 0.6, defaultFilter(), refs, parents, costs, count, 32)).toBe(DT_SUCCESS);
    expect(count[0]).toBe(5);
    // r = 1.2 reaches the diagonal cells through the portal corners (0.707 away), not the next ring (1.5).
    expect(query.findPolysAroundCircle(ref(2, 2), v3(2.5, 0, 2.5), 1.2, defaultFilter(), refs, parents, costs, count, 32)).toBe(DT_SUCCESS);
    const n = count[0]!;
    expect(n).toBe(9);
    expect(new Set(refs.subarray(0, n))).toEqual(new Set(rectCells(1, 1, 4, 4).map(([cx, cz]) => ref(cx, cz))));
    expect(refs[0]).toBe(ref(2, 2));
    expect(parents[0]).toBe(0);
    const c = Array.from(costs.subarray(0, n));
    expect(c[0]).toBe(0);
    for (let i = 1; i <= 4; ++i) expect(c[i]).toBeCloseTo(0.5, 6);
    for (let i = 5; i < 9; ++i) expect(c[i]).toBeCloseTo(0.5 + Math.SQRT1_2, 5);
    for (let i = 1; i < 9; ++i) expect(Array.from(refs.subarray(0, i))).toContain(parents[i]!);
    // The Dijkstra tree gives the path to a diagonal cell.
    const path = new Float64Array(8);
    expect(query.getPathFromDijkstraSearch(ref(3, 3), path, count, 8)).toBe(DT_SUCCESS);
    expect(count[0]).toBe(3);
    expect([path[0], path[2]]).toEqual([ref(2, 2), ref(3, 3)]);
    expect([ref(3, 2), ref(2, 3)]).toContain(path[1]!);
    expect(query.getPathFromDijkstraSearch(ref(6, 6), path, count, 8)).toBe(INVALID);
    expect(query.findPolysAroundCircle(ref(2, 2), v3(2.5, 0, 2.5), 1.2, defaultFilter(), refs, null, null, count, 3)).toBe(DT_SUCCESS | DT_BUFFER_TOO_SMALL);
    expect(count[0]).toBe(3);
    expect(query.findPolysAroundCircle(ref(2, 2), v3(2.5, 0, 2.5), -1, defaultFilter(), refs, null, null, count, 3)).toBe(INVALID);
  });

  test("findPolysAroundShape and findLocalNeighbourhood", () => {
    const { query, ref } = wallWorld();
    // Quad x 1.2..3.8, z 2.2..3.5 (wound like the cells): touches the portals of cells (1..3, 2..3) only.
    const shape = new Float32Array([1.2, 0, 2.2, 1.2, 0, 3.5, 3.8, 0, 3.5, 3.8, 0, 2.2]);
    expect(query.findPolysAroundShape(ref(2, 2), shape, 4, defaultFilter(), refs, parents, costs, count, 32)).toBe(DT_SUCCESS);
    const n = count[0]!;
    expect(new Set(refs.subarray(0, n))).toEqual(new Set(rectCells(1, 2, 4, 4).map(([cx, cz]) => ref(cx, cz))));
    for (let i = 1; i < n; ++i) expect(costs[i]!).toBeGreaterThanOrEqual(costs[i - 1]!);
    expect(query.findPolysAroundShape(ref(2, 2), shape, 2, defaultFilter(), refs, parents, costs, count, 32)).toBe(INVALID);
    expect(query.findLocalNeighbourhood(ref(2, 2), v3(2.5, 0, 2.5), 1.2, defaultFilter(), refs, parents, count, 32)).toBe(DT_SUCCESS);
    expect(new Set(refs.subarray(0, count[0]!))).toEqual(new Set(rectCells(1, 1, 4, 4).map(([cx, cz]) => ref(cx, cz))));
    expect(refs[0]).toBe(ref(2, 2));
    expect(parents[0]).toBe(0);
    expect(query.findLocalNeighbourhood(ref(2, 2), v3(2.5, 0, 2.5), 0.6, defaultFilter(), refs, parents, count, 32)).toBe(DT_SUCCESS);
    expect(count[0]).toBe(5);
    expect(query.findLocalNeighbourhood(ref(2, 2), v3(2.5, 0, 2.5), 1.2, defaultFilter(), refs, null, count, 1)).toBe(DT_SUCCESS | DT_BUFFER_TOO_SMALL);
    expect(count[0]).toBe(1);
  });
});

describe("walls", () => {
  const segs = (verts: Float32Array, n: number) => Array.from({ length: n }, (_, i) => Array.from(verts.subarray(i * 6, i * 6 + 6)));

  test("getPolyWallSegments with and without portals", () => {
    const { query, ref } = wallWorld();
    const verts = new Float32Array(6 * 8);
    const refs = new Float64Array(8);
    // (3,2): only the x+ edge (v2 (4,3) -> v3 (4,2)) is solid.
    expect(query.getPolyWallSegments(ref(3, 2), defaultFilter(), verts, null, count, 8)).toBe(DT_SUCCESS);
    expect(segs(verts, count[0]!)).toEqual([[4, 0, 3, 4, 0, 2]]);
    // With portals: edges in (j, i) order 3, 0, 1, 2.
    expect(query.getPolyWallSegments(ref(3, 2), defaultFilter(), verts, refs, count, 8)).toBe(DT_SUCCESS);
    expect(segs(verts, count[0]!)).toEqual([[4, 0, 2, 3, 0, 2], [3, 0, 2, 3, 0, 3], [3, 0, 3, 4, 0, 3], [4, 0, 3, 4, 0, 2]]);
    expect(Array.from(refs.subarray(0, 4))).toEqual([ref(3, 1), ref(2, 2), ref(3, 3), 0]);
    expect(query.getPolyWallSegments(ref(3, 2), defaultFilter(), verts, refs, count, 2)).toBe(DT_SUCCESS | DT_BUFFER_TOO_SMALL);
    expect(count[0]).toBe(2);
    // (9,2): the x+ edge is a tile portal fully linked to (10,2) (bmin 0, bmax 255).
    expect(query.getPolyWallSegments(ref(9, 2), defaultFilter(), verts, null, count, 8)).toBe(DT_SUCCESS);
    expect(count[0]).toBe(0);
    expect(query.getPolyWallSegments(ref(9, 2), defaultFilter(), verts, refs, count, 8)).toBe(DT_SUCCESS);
    expect(count[0]).toBe(4);
    expect(segs(verts, 4)[3]).toEqual([10, 0, 3, 10, 0, 2]);
    expect(refs[3]).toBe(ref(10, 2));
    expect(query.getPolyWallSegments(0, defaultFilter(), verts, refs, count, 8)).toBe(INVALID);
  });

  test("findDistanceToWall", () => {
    const { query, ref } = wallWorld();
    const dist = new Float32Array(1);
    const pos = new Float32Array(3);
    const normal = new Float32Array(3);
    expect(query.findDistanceToWall(ref(2, 2), v3(2.5, 0, 2.5), 5, defaultFilter(), dist, pos, normal)).toBe(DT_SUCCESS);
    expect(dist[0]).toBe(1.5);
    expect(Array.from(pos)).toEqual([4, 0, 2.5]);
    expectVec(normal, -1, 0, 0);
    // No wall within the radius: the distance is the radius and hitPos is not written.
    pos.set([7, 7, 7]);
    expect(query.findDistanceToWall(ref(2, 2), v3(2.5, 0, 2.5), 1, defaultFilter(), dist, pos, normal)).toBe(DT_SUCCESS);
    expect(dist[0]).toBe(1);
    expect(Array.from(pos)).toEqual([7, 7, 7]);
    expect(query.findDistanceToWall(ref(2, 2), v3(2.5, 0, 2.5), 5, defaultFilter(), null, pos, normal)).toBe(INVALID);
  });
});

describe("random points and validity", () => {
  const half = () => 0.5;

  test("findRandomPoint with frand = 0.5", () => {
    const { query, ref } = wallWorld();
    const r = new Float64Array(1);
    const pt = new Float32Array(3);
    // Reservoir sampling keeps the k-th item while 0.5 * k * w <= w: the 2nd tile (1,0) and its 2nd poly (11,0).
    // s = t = 0.5 picks the fan triangle (v0, v2, v3) with u = 0: v0 + sqrt(0.5) * (v2 - v0).
    expect(query.findRandomPoint(defaultFilter(), half, r, pt)).toBe(DT_SUCCESS);
    expect(r[0]).toBe(ref(11, 0));
    expectVec(pt, 11 + Math.SQRT1_2, 0, Math.SQRT1_2);
    expect(query.findRandomPoint(defaultFilter(), null, r, pt)).toBe(INVALID);
    const water = defaultFilter();
    water.setIncludeFlags(NavTerrain.NAV_WATER);
    expect(query.findRandomPoint(water, half, r, pt)).toBe(DT_FAILURE);
  });

  test("findRandomPointAroundCircle with frand = 0.5", () => {
    const { query, ref } = wallWorld();
    const r = new Float64Array(1);
    const pt = new Float32Array(3);
    // From (2.5, 2.3), r 0.6: (2,1) is the second poly popped (cost 0.3 < 0.539), so it is the one kept.
    expect(query.findRandomPointAroundCircle(ref(2, 2), v3(2.5, 0, 2.3), 0.6, defaultFilter(), half, r, pt)).toBe(DT_SUCCESS);
    expect(r[0]).toBe(ref(2, 1));
    expectVec(pt, 2 + Math.SQRT1_2, 0, 1 + Math.SQRT1_2);
    expect(query.findRandomPointAroundCircle(ref(2, 2), v3(2.5, 0, 2.3), -1, defaultFilter(), half, r, pt)).toBe(INVALID);
    const water = defaultFilter();
    water.setIncludeFlags(NavTerrain.NAV_WATER);
    expect(query.findRandomPointAroundCircle(ref(2, 2), v3(2.5, 0, 2.3), 0.6, water, half, r, pt)).toBe(INVALID);
  });

  test("isValidPolyRef and isInClosedList", () => {
    const { query, ref } = wallWorld();
    expect(query.isValidPolyRef(ref(2, 2), defaultFilter())).toBe(true);
    expect(query.isValidPolyRef(0, defaultFilter())).toBe(false);
    const noGround = defaultFilter();
    noGround.setExcludeFlags(NavTerrain.NAV_GROUND);
    expect(query.isValidPolyRef(ref(2, 2), noGround)).toBe(false);
    const path = new Float64Array(16);
    expect(query.findPath(ref(2, 2), ref(2, 4), v3(2.5, 0, 2.5), v3(2.5, 0, 4.5), defaultFilter(), path, count, 16)).toBe(DT_SUCCESS);
    expect(query.isInClosedList(ref(2, 2))).toBe(true);
    expect(query.isInClosedList(ref(2, 4))).toBe(true);
    expect(query.isInClosedList(ref(12, 9))).toBe(false);
  });
});
