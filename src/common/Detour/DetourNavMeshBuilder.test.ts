/**
 * Tests for the `dtCreateNavMeshData` port. Expectations are derived by hand from
 * `deps/recastnavigation/Detour/Source/DetourNavMeshBuilder.cpp` with the struct sizes of the DT_POLYREF64 build
 * (`dtMeshHeader` 100, `dtPoly` 32, `dtLink` 16, `dtPolyDetail` 12, `dtBVNode` 16, `dtOffMeshConnection` 36).
 */
import { describe, expect, test } from "bun:test";
import {
  DT_EXT_LINK,
  DT_NAVMESH_MAGIC,
  DT_NAVMESH_VERSION,
  DT_OFFMESH_CON_BIDIR,
  DT_POLYTYPE_GROUND,
  DT_POLYTYPE_OFFMESH_CONNECTION,
  dtGetDetailTriEdgeFlags,
  dtMeshHeader,
  dtMeshTile,
  dtTileLayout,
} from "./DetourNavMesh.ts";
import { dtCreateNavMeshData, dtNavMeshCreateParams, dtNavMeshDataSwapEndian, dtNavMeshHeaderSwapEndian } from "./DetourNavMeshBuilder.ts";
import { gridTileParams, rectCells, type TestOffMeshCon } from "./test-navmesh.ts";

function create(params: dtNavMeshCreateParams): Uint8Array | null {
  const out = { value: null as Uint8Array | null };
  const size = { value: -1 };
  if (!dtCreateNavMeshData(params, out, size)) return null;
  expect(out.value!.length).toBe(size.value);
  return out.value;
}

/** Reads a blob in place, like `dtNavMesh::addTile` patches the pointers. */
function open(data: Uint8Array): { header: dtMeshHeader; tile: dtMeshTile } {
  const header = new dtMeshHeader(data.buffer, data.byteOffset);
  const tile = new dtMeshTile();
  tile.attachData(data, header, dtTileLayout.fromHeader(header));
  return { header, tile };
}

/** Params for hand-made polygons (quantized verts, `cs` = `ch` = 1, bmin at the origin, all edges walls). */
function rawParams(verts: number[][], polys: number[][], nvp = 6): dtNavMeshCreateParams {
  const p = new dtNavMeshCreateParams();
  p.verts = new Uint16Array(verts.flat());
  p.vertCount = verts.length;
  p.polys = new Uint16Array(polys.length * 2 * nvp).fill(0xffff);
  polys.forEach((pv, i) => pv.forEach((v, j) => (p.polys![i * 2 * nvp + j] = v)));
  p.polyCount = polys.length;
  p.polyFlags = new Uint16Array(polys.length).fill(1);
  p.polyAreas = new Uint8Array(polys.length).fill(1);
  p.nvp = nvp;
  p.bmax.set([10, 10, 10]);
  p.cs = 1;
  p.ch = 1;
  p.walkableClimb = 1;
  return p;
}

const arr = (a: ArrayLike<number>) => Array.from(a);

describe("dtCreateNavMeshData", () => {
  // Tile (1,2) of size 4: cells x 4..6, z 8..9 (6 quads, 12 verts); bounds x [4,8], y [-2,20], z [8,12]; heights 0.
  const cons: TestOffMeshCon[] = [
    { start: [4.5, 0, 8.5], end: [9, 0, 9], rad: 0.5, bidir: true, flags: 0x10, area: 5, userId: 500 }, // stored, end x+ (side 0)
    { start: [3, 0, 9], end: [5, 0, 9], rad: 0.5, bidir: true, userId: 501 }, // start outside: not stored, end counts a link
    { start: [5.5, 0, 9.5], end: [6.5, 0, 8.5], rad: 0.5, bidir: false, userId: 502 }, // stored, both ends inside
    { start: [5, 5, 9], end: [9, 0, 13], rad: 0.5, bidir: true, userId: 503 }, // start above hmax = 0 + climb: zeroed
  ];
  const smallTile = () => {
    const { params } = gridTileParams({ tx: 1, ty: 2, size: 4, cells: rectCells(4, 8, 7, 10), offMeshCons: cons });
    params.userId = 0xdeadbeef;
    params.tileLayer = 3;
    return create(params)!;
  };

  test("header fields", () => {
    const data = smallTile();
    const { header: h } = open(data);
    expect(arr(data.subarray(0, 4))).toEqual([0x56, 0x41, 0x4e, 0x44]); // 'DNAV' as a little-endian int
    expect([h.magic, h.version, h.x, h.y, h.layer, h.userId]).toEqual([DT_NAVMESH_MAGIC, DT_NAVMESH_VERSION, 1, 2, 3, 0xdeadbeef]);
    expect(DT_NAVMESH_VERSION).toBe(7);
    // 6 polys + 2 stored off-mesh polys; 12 verts + 2 per stored connection.
    expect([h.polyCount, h.vertCount, h.offMeshConCount, h.offMeshBase]).toEqual([8, 16, 2, 6]);
    // edges 24 + portals (x- on 2 cells, z- on 3 cells) 5 * 2 + off-mesh link ends (1 + 1 + 2 + 0) 4 * 2.
    expect(h.maxLinkCount).toBe(42);
    // No detail mesh: one detail sub-mesh per poly, no extra verts, nv - 2 triangles per quad.
    expect([h.detailMeshCount, h.detailVertCount, h.detailTriCount, h.bvNodeCount]).toEqual([6, 0, 12, 12]);
    expect([h.walkableHeight, h.walkableRadius, h.walkableClimb, h.bvQuantFactor]).toEqual([2, 0.5, 1, 1]);
    expect([arr(h.bmin), arr(h.bmax)]).toEqual([[4, -2, 8], [8, 20, 12]]);
    // 100 + 16*12 + 8*32 + 42*16 + 6*12 + 0 + 12*4 + 12*16 + 2*36 (every section is already a multiple of 4).
    expect(data.length).toBe(100 + 192 + 256 + 672 + 72 + 0 + 48 + 192 + 72);
  });

  test("vertices, polygons and off-mesh connections", () => {
    const { tile: t } = open(smallTile());
    const vert = (i: number) => arr(t.verts.subarray(i * 3, i * 3 + 3));
    for (let p = 0; p < 6; ++p) {
      const [cx, cz] = [4 + (p % 3), 8 + Math.floor(p / 3)];
      expect([t.polyVertCount(p), t.polyGetType(p), t.polyGetArea(p), t.polyFlags(p)]).toEqual([4, DT_POLYTYPE_GROUND, 1, 1]);
      const corners = [[cx, 0, cz], [cx, 0, cz + 1], [cx + 1, 0, cz + 1], [cx + 1, 0, cz]];
      expect([0, 1, 2, 3].map((j) => vert(t.polyVerts(p, j)))).toEqual(corners);
    }
    expect([vert(12), vert(13), vert(14), vert(15)]).toEqual([[4.5, 0, 8.5], [9, 0, 9], [5.5, 0, 9.5], [6.5, 0, 8.5]]);
    expect([t.polyVertCount(6), t.polyVerts(6, 0), t.polyVerts(6, 1), t.polyGetType(6), t.polyFlags(6), t.polyGetArea(6)]).toEqual([
      2, 12, 13, DT_POLYTYPE_OFFMESH_CONNECTION, 0x10, 5,
    ]);
    expect([t.polyVerts(7, 0), t.polyVerts(7, 1), t.polyGetType(7)]).toEqual([14, 15, DT_POLYTYPE_OFFMESH_CONNECTION]);
    const con = (i: number) => [arr(t.offMeshConsF32.subarray(i * 9, i * 9 + 6)), t.offMeshConRad(i), t.offMeshConPoly(i), t.offMeshConFlags(i), t.offMeshConSide(i), t.offMeshConUserId(i)];
    expect(con(0)).toEqual([[4.5, 0, 8.5, 9, 0, 9], 0.5, 6, DT_OFFMESH_CON_BIDIR, 0, 500]);
    expect(con(1)).toEqual([[5.5, 0, 9.5, 6.5, 0, 8.5], 0.5, 7, 0, 0xff, 502]);
  });

  test("off-mesh end points are classified into the 8 sides, inside is 0xff", () => {
    // Tile (1,1) of size 4: x [4,8], z [4,8]. classifyOffMeshPoint: >= bmax is outside, < bmin is outside.
    const ends: Array<[number, number, number]> = [[9, 0, 6], [9, 0, 9], [6, 0, 9], [3, 0, 9], [3, 0, 6], [3, 0, 3], [6, 0, 3], [9, 0, 3], [8, 0, 6], [4, 0, 4], [6, 50, 6]];
    const starts: Array<[number, number, number]> = [[3.9, 0, 6], [6, -1.5, 6], [6, -1, 6]]; // outside x-, below hmin -1, on hmin
    const { params } = gridTileParams({
      tx: 1, ty: 1, size: 4, cells: rectCells(4, 4, 8, 8),
      offMeshCons: [...ends.map((end) => ({ start: [6, 0, 6] as [number, number, number], end, rad: 1, bidir: false })), ...starts.map((start) => ({ start, end: [6, 0, 6] as [number, number, number], rad: 1, bidir: false }))],
    });
    const { header: h, tile: t } = open(create(params)!);
    expect(h.offMeshConCount).toBe(12);
    expect(Array.from({ length: 12 }, (_, i) => t.offMeshConSide(i))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0, 0xff, 0xff, 0xff]);
    expect(t.offMeshConsF32[11 * 9 + 1]).toBe(-1);
    // edges 64 + portals 16 * 2 + link ends (12 stored starts + 2 inside ends of the first 11 + 3 inside ends) * 2
    expect(h.maxLinkCount).toBe(64 + 32 + (12 + 2 + 3) * 2);
  });

  test("portal and border neighbours", () => {
    const one = open(create(gridTileParams({ tx: 0, ty: 0, size: 1, cells: [[0, 0]] }).params)!);
    // RC dir 0 (x-) -> side 4, 1 (z+) -> 2, 2 (x+) -> 0, 3 (z-) -> 6.
    expect([0, 1, 2, 3].map((j) => one.tile.polyNeis(0, j))).toEqual([DT_EXT_LINK | 4, DT_EXT_LINK | 2, DT_EXT_LINK | 0, DT_EXT_LINK | 6]);
    expect(one.header.maxLinkCount).toBe(4 + 4 * 2);
    const two = open(create(gridTileParams({ tx: 0, ty: 0, size: 3, cells: [[0, 0], [1, 0]] }).params)!);
    // Internal neighbours are stored as index + 1, walls (RC_MESH_NULL_IDX: 0x8000 set, dir 0xf) as 0.
    expect([0, 1, 2, 3, 4, 5].map((j) => two.tile.polyNeis(0, j))).toEqual([DT_EXT_LINK | 4, 0, 2, DT_EXT_LINK | 6, 0, 0]);
    expect([0, 1, 2, 3].map((j) => two.tile.polyNeis(1, j))).toEqual([1, 0, 0, DT_EXT_LINK | 6]);
    expect(two.header.maxLinkCount).toBe(8 + 3 * 2);
  });

  test("dummy detail mesh: a triangle fan with boundary edge flags", () => {
    const params = rawParams(
      [[0, 0, 1], [0, 0, 2], [1, 0, 3], [2, 0, 2], [2, 0, 1], [1, 0, 0], [3, 0, 0], [3, 0, 1], [4, 0, 0]],
      [[0, 1, 2, 3, 4, 5], [6, 7, 8]],
    );
    const { header: h, tile: t } = open(create(params)!);
    expect([h.detailMeshCount, h.detailVertCount, h.detailTriCount, h.maxLinkCount]).toEqual([2, 0, 4 + 1, 9]);
    const dm = (i: number) => [t.detailVertBase(i), t.detailVertCount(i), t.detailTriBase(i), t.detailTriCount(i)];
    expect([dm(0), dm(1)]).toEqual([[0, 0, 0, 4], [0, 0, 4, 1]]);
    // Tri (0, j-1, j): edge 1 always on the boundary (1 << 2), edge 0 when j == 2 (1 << 0), edge 2 when j == nv-1 (1 << 4).
    expect(arr(t.detailTris)).toEqual([0, 1, 2, 5, 0, 2, 3, 4, 0, 3, 4, 4, 0, 4, 5, 20, 0, 1, 2, 21]);
    expect([0, 1, 2].map((e) => dtGetDetailTriEdgeFlags(t.detailTris[19]!, e))).toEqual([1, 1, 1]);
    expect([0, 1, 2].map((e) => dtGetDetailTriEdgeFlags(t.detailTris[7]!, e))).toEqual([0, 1, 0]);
  });

  test("input detail mesh: unique verts are compacted, triangles copied, BV bounds from detail verts", () => {
    const params = rawParams([[0, 0, 0], [0, 0, 2], [2, 0, 2], [2, 0, 0], [2, 0, 0], [2, 0, 2], [4, 0, 2], [4, 0, 0]], [[0, 1, 2, 3], [4, 5, 6, 7]]);
    params.detailMeshes = new Uint32Array([0, 5, 0, 4, 5, 6, 4, 2]);
    params.detailVerts = new Float32Array([0, 0, 0, 0, 0, 2, 2, 0, 2, 2, 0, 0, 1, 0.75, 1, 2, 0, 0, 2, 0, 2, 4, 0, 2, 4, 0, 0, 3, 1.5, 0.5, 3, 2.5, 1.5]);
    params.detailVertsCount = 11;
    params.detailTris = new Uint8Array([0, 1, 4, 1, 1, 2, 4, 2, 2, 3, 4, 3, 3, 0, 4, 4, 0, 1, 4, 5, 1, 2, 5, 6]);
    params.detailTriCount = 6;
    params.buildBvTree = true;
    const data = create(params)!;
    const { header: h, tile: t } = open(data);
    expect([h.detailMeshCount, h.detailVertCount, h.detailTriCount, h.bvNodeCount]).toEqual([2, 1 + 2, 6, 4]);
    const dm = (i: number) => [t.detailVertBase(i), t.detailVertCount(i), t.detailTriBase(i), t.detailTriCount(i)];
    expect([dm(0), dm(1)]).toEqual([[0, 1, 0, 4], [1, 2, 4, 2]]);
    expect(arr(t.detailVerts)).toEqual([1, 0.75, 1, 3, 1.5, 0.5, 3, 2.5, 1.5]);
    expect(arr(t.detailTris)).toEqual(arr(params.detailTris));
    // Leaves: A (0,0,0)-(2,0,2) (0.75 truncated), B (2,0,0)-(4,2,2). Root splits on x (extent 4), escape 3; node 3 stays zero.
    const node = (i: number) => [arr(t.bvTree!.subarray(i * 8, i * 8 + 6)), t.bvNodeI(i)];
    expect([0, 1, 2, 3].map(node)).toEqual([[[0, 0, 0, 4, 2, 2], -3], [[0, 0, 0, 2, 0, 2], 0], [[2, 0, 0, 4, 2, 2], 1], [[0, 0, 0, 0, 0, 0], 0]]);
    // 100 + 8*12 + 2*32 + 8*16 + 2*12 + 3*12 + 6*4 + 4*16
    expect(data.length).toBe(100 + 96 + 64 + 128 + 24 + 36 + 24 + 64);
  });
});

describe("createBVTree", () => {
  test("leaves hold the quantized poly bounds; every node contains its subtree (escape index)", () => {
    // Tile (1,1) of size 4 with a hole; slope y = x / 2, so quantized vertex y = vx + 4 (minY -2, ch 0.5).
    const cells = rectCells(4, 4, 8, 8).filter(([cx, cz]) => !(cx === 5 && cz === 6));
    const { params, polyCells } = gridTileParams({ tx: 1, ty: 1, size: 4, cells, height: (vx) => vx / 2 });
    const { header: h, tile: t } = open(create(params)!);
    const n = polyCells.length;
    expect(h.bvNodeCount).toBe(2 * n);
    const bounds = (i: number) => arr(t.bvTree!.subarray(i * 8, i * 8 + 6));
    // createBVTree writes 2n - 1 nodes; the last of the 2n allocated stays zeroed.
    expect([bounds(2 * n - 1), t.bvNodeI(2 * n - 1)]).toEqual([[0, 0, 0, 0, 0, 0], 0]);
    expect(t.bvNodeI(0)).toBe(-(2 * n - 1));

    const seen: number[] = [];
    for (let k = 0; k < 2 * n - 1; ++k) {
      const i = t.bvNodeI(k);
      if (i >= 0) {
        // x/z relative to bmin in cells; y remapped: floor(minQy * ch / cs), ceil(maxQy * ch / cs).
        const [cx, cz] = polyCells[i]!;
        expect(bounds(k)).toEqual([cx - 4, Math.floor((cx + 4) / 2), cz - 4, cx - 3, Math.ceil((cx + 5) / 2), cz - 3]);
        seen.push(i);
        continue;
      }
      // Internal: the subtree is nodes k+1 .. k+escape-1, and its bounds are the union of its leaves (calcExtends).
      const end = k - i;
      expect(end).toBeLessThanOrEqual(2 * n - 1);
      const b = bounds(k);
      const union = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let c = k + 1; c < end; ++c) {
        const cb = bounds(c);
        for (let a = 0; a < 3; ++a) {
          expect(cb[a]!).toBeGreaterThanOrEqual(b[a]!);
          expect(cb[a + 3]!).toBeLessThanOrEqual(b[a + 3]!);
          if (t.bvNodeI(c) >= 0) {
            union[a] = Math.min(union[a]!, cb[a]!);
            union[a + 3] = Math.max(union[a + 3]!, cb[a + 3]!);
          }
        }
      }
      expect(b).toEqual(union);
    }
    expect(seen.sort((x, y) => x - y)).toEqual(Array.from({ length: n }, (_, i) => i));
  });

  test("no BV tree without buildBvTree; bvQuantFactor is 1 / cs", () => {
    const { params } = gridTileParams({ tx: 0, ty: 0, size: 4, cs: 2, cells: rectCells(0, 0, 2, 2), buildBvTree: false });
    const data = create(params)!;
    const { header: h } = open(data);
    expect([h.bvNodeCount, h.bvQuantFactor]).toEqual([0, 0.5]);
    // 100 + 9*12 + 4*32 + (16 + 4*2)*16 + 4*12 + 0 + 8*4 + 0 + 0
    expect(data.length).toBe(100 + 108 + 128 + 384 + 48 + 32);
  });
});

describe("dtCreateNavMeshData input checks", () => {
  test("returns false for nvp > 6, vertCount >= 0xffff, no verts, no polys", () => {
    const base = () => gridTileParams({ tx: 0, ty: 0, size: 2, cells: rectCells(0, 0, 2, 2) }).params;
    expect(create(base())).not.toBeNull();
    const cases: Array<(p: dtNavMeshCreateParams) => void> = [
      (p) => (p.nvp = 7),
      (p) => (p.vertCount = 0xffff),
      (p) => (p.vertCount = 0),
      (p) => (p.verts = null),
      (p) => (p.polyCount = 0),
      (p) => (p.polys = null),
    ];
    for (const edit of cases) {
      const p = base();
      edit(p);
      const out = { value: null as Uint8Array | null };
      const size = { value: -1 };
      expect(dtCreateNavMeshData(p, out, size)).toBe(false);
      expect([out.value, size.value]).toEqual([null, -1]);
    }
  });
});

describe("endian swapping", () => {
  /** The (offset, size) fields the C++ swaps, from the native header: header, verts, poly verts/neis/flags,
   * detail vertBase/triBase, detail verts, BV bmin/bmax/i, off-mesh pos/rad/poly. Links, detail tris, firstLink,
   * vertCount, areaAndtype, off-mesh flags/side/userId are left alone. */
  function swappedFields(data: Uint8Array): Array<[number, number]> {
    const h = new dtMeshHeader(data.buffer, data.byteOffset);
    const f: Array<[number, number]> = [];
    for (let i = 0; i < 25; ++i) f.push([i * 4, 4]);
    let d = 100;
    for (let i = 0; i < h.vertCount * 3; ++i) f.push([d + i * 4, 4]);
    d += h.vertCount * 12;
    for (let i = 0; i < h.polyCount; ++i) {
      for (let j = 0; j < 12; ++j) f.push([d + i * 32 + 4 + j * 2, 2]);
      f.push([d + i * 32 + 28, 2]);
    }
    d += h.polyCount * 32 + h.maxLinkCount * 16;
    for (let i = 0; i < h.detailMeshCount; ++i) f.push([d + i * 12, 4], [d + i * 12 + 4, 4]);
    d += h.detailMeshCount * 12;
    for (let i = 0; i < h.detailVertCount * 3; ++i) f.push([d + i * 4, 4]);
    d += h.detailVertCount * 12 + h.detailTriCount * 4;
    for (let i = 0; i < h.bvNodeCount; ++i) {
      for (let j = 0; j < 6; ++j) f.push([d + i * 16 + j * 2, 2]);
      f.push([d + i * 16 + 12, 4]);
    }
    d += h.bvNodeCount * 16;
    for (let i = 0; i < h.offMeshConCount; ++i) {
      for (let j = 0; j < 7; ++j) f.push([d + i * 36 + j * 4, 4]);
      f.push([d + i * 36 + 28, 2]);
    }
    return f;
  }

  test("dtNavMeshDataSwapEndian + dtNavMeshHeaderSwapEndian swap exactly the C++ fields, and back", () => {
    const { params } = gridTileParams({
      tx: 1, ty: 0, size: 4, cells: rectCells(4, 0, 7, 3), height: (vx, vz) => (vx + vz) / 2,
      offMeshCons: [{ start: [4.5, 2, 0.5], end: [6.5, 3, 2.5], rad: 0.75, bidir: true, flags: 0x1234, userId: 0x01020304 }],
    });
    const data = create(params)!;
    expect([open(data).header.offMeshConCount, open(data).header.bvNodeCount]).toEqual([1, 18]);
    const expected = data.slice();
    for (const [o, s] of swappedFields(data)) expected.subarray(o, o + s).reverse();

    const copy = data.slice();
    expect(dtNavMeshDataSwapEndian(copy, copy.length)).toBe(true);
    expect(dtNavMeshHeaderSwapEndian(copy, copy.length)).toBe(true);
    expect(copy).toEqual(expected);
    // A foreign-endian blob: the data swap refuses it until the header is native again.
    expect(dtNavMeshDataSwapEndian(copy, copy.length)).toBe(false);
    expect(dtNavMeshHeaderSwapEndian(copy, copy.length)).toBe(true);
    expect(dtNavMeshDataSwapEndian(copy, copy.length)).toBe(true);
    expect(arr(copy)).toEqual(arr(data));
  });

  test("bad magic or version is rejected", () => {
    const data = create(gridTileParams({ tx: 0, ty: 0, size: 2, cells: [[0, 0]] }).params)!;
    const badMagic = data.slice();
    new DataView(badMagic.buffer).setInt32(0, 0x12345678, true);
    expect(dtNavMeshHeaderSwapEndian(badMagic, badMagic.length)).toBe(false);
    expect(dtNavMeshDataSwapEndian(badMagic, badMagic.length)).toBe(false);
    const badVersion = data.slice();
    new DataView(badVersion.buffer).setInt32(4, 6, true);
    expect(dtNavMeshHeaderSwapEndian(badVersion, badVersion.length)).toBe(false);
    expect(dtNavMeshDataSwapEndian(badVersion, badVersion.length)).toBe(false);
    expect(arr(badVersion.subarray(8))).toEqual(arr(data.subarray(8)));
  });
});
