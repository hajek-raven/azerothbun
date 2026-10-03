/**
 * Tests for the `dtNavMesh` port. Every expectation is derived by hand from
 * `deps/recastnavigation/Detour/Source/DetourNavMesh.cpp` (DT_POLYREF64 build) and the grid tiles of `test-navmesh.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  DT_EXT_LINK,
  DT_NAVMESH_STATE_MAGIC,
  DT_NAVMESH_STATE_VERSION,
  DT_NULL_LINK,
  DT_OFFMESH_CON_BIDIR,
  DT_POLYTYPE_GROUND,
  DT_REF_POLY_BITS,
  DT_TILE_FREE_DATA,
  dtAllocNavMesh,
  dtNavMesh,
  dtTileAndPoly,
  type dtMeshTile,
} from "./DetourNavMesh.ts";
import {
  DT_ALREADY_OCCUPIED,
  DT_BUFFER_TOO_SMALL,
  DT_FAILURE,
  DT_INVALID_PARAM,
  DT_OUT_OF_MEMORY,
  DT_SUCCESS,
  DT_WRONG_MAGIC,
  DT_WRONG_VERSION,
} from "./DetourStatus.ts";
import { buildGridTile, gridNavMeshParams, rectCells, wallWorldTiles, type TestTile } from "./test-navmesh.ts";

/** A mesh of 10-unit tiles; tiles are added with flags 0 (the caller keeps the data). */
function meshOf(tiles: TestTile[], maxTiles = 16): dtNavMesh {
  const mesh = dtAllocNavMesh();
  expect(mesh.init(gridNavMeshParams(10, maxTiles))).toBe(DT_SUCCESS);
  for (const t of tiles) expect(mesh.addTile(t.data, t.data.length, 0, 0, null)).toBe(DT_SUCCESS);
  return mesh;
}

function polyIndex(t: TestTile, cx: number, cz: number): number {
  const i = t.polyCells.findIndex(([x, z]) => x === cx && z === cz);
  if (i < 0) throw new Error(`no cell ${cx},${cz}`);
  return i;
}

interface LinkInfo { ref: number; edge: number; side: number; bmin: number; bmax: number }
const link = (ref: number, edge: number, side: number, bmin = 0, bmax = 0): LinkInfo => ({ ref, edge, side, bmin, bmax });

/** Walks `poly->firstLink` / `link->next` like the C++ loops do. */
function linksOf(tile: dtMeshTile, ip: number): LinkInfo[] {
  const out: LinkInfo[] = [];
  for (let i = tile.polyFirstLink(ip); i !== DT_NULL_LINK; i = tile.linkNext(i)) {
    out.push(link(tile.linkRef(i), tile.linkEdge(i), tile.linkSide(i), tile.linkBmin(i), tile.linkBmax(i)));
  }
  return out;
}
const extLinks = (tile: dtMeshTile, ip: number) => linksOf(tile, ip).filter((l) => l.side !== 0xff);
const arr = (a: ArrayLike<number>) => Array.from(a);

describe("dtNavMesh::init", () => {
  test("copies the params and builds the tile free list and LUT", () => {
    const mesh = dtAllocNavMesh();
    const params = gridNavMeshParams(10, 16);
    params.orig.set([-100, 5, 50]);
    expect(mesh.init(params)).toBe(DT_SUCCESS);
    const p = mesh.getParams();
    expect([arr(p.orig), p.tileWidth, p.tileHeight, p.maxTiles, p.maxPolys]).toEqual([[-100, 5, 50], 10, 10, 16, 1 << 20]);
    expect(mesh.getMaxTiles()).toBe(16);
    // m_tileLutSize = dtNextPow2(maxTiles / 4), 1 when that is 0.
    expect([mesh.m_tileLutSize, mesh.m_tileLutMask]).toEqual([4, 3]);
    expect(Array.from({ length: 16 }, (_, i) => mesh.getTile(i).salt)).toEqual(new Array(16).fill(1));
    // The free list is built backwards, so tile 0 is handed out first.
    expect(mesh.m_nextFree).toBe(mesh.getTile(0));
    expect(mesh.getTile(0).next).toBe(mesh.getTile(1));
    for (const [maxTiles, lut] of [[3, 1], [100, 32]] as const) {
      const m = dtAllocNavMesh();
      m.init(gridNavMeshParams(10, maxTiles));
      expect(m.m_tileLutSize).toBe(lut);
    }
  });

  test("calcTileLoc floors, negative coordinates give negative tiles", () => {
    const mesh = dtAllocNavMesh();
    const params = gridNavMeshParams(10, 16);
    params.orig.set([-100, 0, 50]);
    mesh.init(params);
    const loc = new Int32Array(2);
    const at = (x: number, z: number) => {
      mesh.calcTileLoc(new Float32Array([x, 123, z]), 0, loc);
      return arr(loc);
    };
    expect([at(-100, 50), at(-85, 75), at(-90, 60)]).toEqual([[0, 0], [1, 2], [1, 1]]);
    expect([at(-100.5, 49.9), at(-110, 40), at(-110.5, 39)]).toEqual([[-1, -1], [-1, -1], [-2, -2]]);
  });

  test("init(data) sets up a single-tile mesh from the header", () => {
    const t = buildGridTile({ tx: 2, ty: 3, size: 10, cells: rectCells(20, 30, 23, 32) });
    const mesh = dtAllocNavMesh();
    expect(mesh.init(t.data, t.data.length, 0)).toBe(DT_SUCCESS);
    const p = mesh.getParams();
    // orig = header bmin, tile size = bmax - bmin, maxTiles 1, maxPolys = polyCount.
    expect([arr(p.orig), p.tileWidth, p.tileHeight, p.maxTiles, p.maxPolys]).toEqual([[20, -2, 30], 10, 10, 1, 6]);
    expect(mesh.getMaxTiles()).toBe(1);
    expect(mesh.getTileAt(2, 3, 0)).toBe(mesh.getTile(0));
    const bad = t.data.slice();
    new DataView(bad.buffer).setInt32(0, 0x12345678, true);
    expect(dtAllocNavMesh().init(bad, bad.length, 0)).toBe(DT_FAILURE | DT_WRONG_MAGIC);
  });
});

describe("dtNavMesh poly refs", () => {
  test("encodePolyId / decodePolyId round trip with the salt, tile and poly fields", () => {
    const mesh = dtAllocNavMesh();
    mesh.init(gridNavMeshParams(10, 16));
    expect(DT_REF_POLY_BITS).toBe(20);
    expect(mesh.encodePolyId(3, 5, 7)).toBe(3 * 2 ** 41 + 5 * 2 ** 20 + 7);
    const maxRef = mesh.encodePolyId(0xfff, (1 << 21) - 1, (1 << 20) - 1);
    expect(maxRef).toBe(2 ** 53 - 1);
    const out = new Uint32Array(3);
    for (const fields of [[1, 0, 0], [0xfff, (1 << 21) - 1, (1 << 20) - 1], [17, 12345, 54321], [4095, 1, 0]] as const) {
      const ref = mesh.encodePolyId(fields[0], fields[1], fields[2]);
      mesh.decodePolyId(ref, out);
      expect(arr(out)).toEqual([...fields]);
      expect([mesh.decodePolyIdSalt(ref), mesh.decodePolyIdTile(ref), mesh.decodePolyIdPoly(ref)]).toEqual([...fields]);
    }
  });

  test("getTileRef / getPolyRefBase / isValidPolyRef / getTileAndPolyByRef", () => {
    const { t00, t10 } = wallWorldTiles();
    const mesh = meshOf([t00, t10]);
    const tile0 = mesh.getTileAt(0, 0, 0)!;
    const tile1 = mesh.getTileAt(1, 0, 0)!;
    expect([tile0.index, tile1.index]).toEqual([0, 1]);
    const base = mesh.encodePolyId(1, 1, 0);
    expect([mesh.getTileRef(tile1), mesh.getPolyRefBase(tile1), mesh.getTileRef(null), mesh.getPolyRefBase(null)]).toEqual([base, base, 0, 0]);
    expect(mesh.getTileByRef(base)).toBe(tile1);
    expect(mesh.getTileByRef(mesh.encodePolyId(2, 1, 0))).toBeNull();

    expect(mesh.isValidPolyRef(base)).toBe(true);
    expect(mesh.isValidPolyRef(base + 29)).toBe(true); // 3 x 10 cells
    expect(mesh.isValidPolyRef(base + 30)).toBe(false);
    expect(mesh.isValidPolyRef(0)).toBe(false);
    expect(mesh.isValidPolyRef(mesh.encodePolyId(1, 2, 0))).toBe(false); // empty slot
    expect(mesh.isValidPolyRef(mesh.encodePolyId(1, 16, 0))).toBe(false); // it >= maxTiles
    expect(mesh.isValidPolyRef(mesh.encodePolyId(2, 1, 0))).toBe(false); // wrong salt

    const tp = new dtTileAndPoly();
    expect(mesh.getTileAndPolyByRef(base + 7, tp)).toBe(DT_SUCCESS);
    expect([tp.tile, tp.poly]).toEqual([tile1, 7]);
    expect(mesh.getTileAndPolyByRef(0, tp)).toBe(DT_FAILURE);
    for (const bad of [base + 30, mesh.encodePolyId(1, 16, 0), mesh.encodePolyId(3, 0, 0)]) {
      expect(mesh.getTileAndPolyByRef(bad, tp)).toBe(DT_FAILURE | DT_INVALID_PARAM);
    }
    const unsafe = new dtTileAndPoly();
    mesh.getTileAndPolyByRefUnsafe(mesh.encodePolyId(9, 0, 3), unsafe); // salt is not checked
    expect([unsafe.tile, unsafe.poly]).toEqual([tile0, 3]);
  });
});

describe("dtNavMesh::addTile / tile lookup", () => {
  test("getTileAt / getTileRefAt / getTilesAt / getNeighbourTilesAt", () => {
    const { t00, t10, t01 } = wallWorldTiles();
    const mesh = dtAllocNavMesh();
    mesh.init(gridNavMeshParams(10, 16));
    const result = new Float64Array(1);
    expect(mesh.addTile(t10.data, t10.data.length, 0, 0, result)).toBe(DT_SUCCESS);
    expect(result[0]).toBe(mesh.encodePolyId(1, 0, 0)); // first free tile is index 0
    expect(mesh.addTile(t00.data, t00.data.length, 0, 0, result)).toBe(DT_SUCCESS);
    expect(result[0]).toBe(mesh.encodePolyId(1, 1, 0));
    expect(mesh.addTile(t01.data, t01.data.length, 0, 0, null)).toBe(DT_SUCCESS);

    const tile10 = mesh.getTileAt(1, 0, 0)!;
    const tile01 = mesh.getTileAt(0, 1, 0)!;
    expect([tile10.header!.x, tile10.header!.y, tile10.data]).toEqual([1, 0, t10.data]);
    expect(mesh.getTileAt(1, 1, 0)).toBeNull();
    expect(mesh.getTileAt(1, 0, 1)).toBeNull();
    expect([mesh.getTileRefAt(1, 0, 0), mesh.getTileRefAt(0, 0, 0)]).toEqual([mesh.encodePolyId(1, 0, 0), mesh.encodePolyId(1, 1, 0)]);
    expect([mesh.getTileRefAt(5, 5, 0), mesh.getTileRefAt(0, 0, 1)]).toEqual([0, 0]);

    const tiles: (dtMeshTile | null)[] = new Array(4).fill(null);
    expect(mesh.getTilesAt(0, 1, tiles, 4)).toBe(1);
    expect(tiles[0]).toBe(tile01);
    expect(mesh.getTilesAt(0, 1, tiles, 0)).toBe(0);
    // Sides: 0 x+, 1 x+z+, 2 z+, 3 x-z+, 4 x-, 5 x-z-, 6 z-, 7 x+z-.
    const nei = (x: number, y: number, side: number) => (mesh.getNeighbourTilesAt(x, y, side, tiles, 4) ? tiles[0] : null);
    expect(nei(0, 0, 0)).toBe(tile10);
    expect(nei(0, 0, 2)).toBe(tile01);
    expect(nei(1, 0, 4)).toBe(mesh.getTileAt(0, 0, 0));
    expect(nei(1, 0, 3)).toBe(tile01);
    expect(nei(0, 1, 7)).toBe(tile10);
    expect(nei(0, 1, 6)).toBe(mesh.getTileAt(0, 0, 0));
    expect([nei(0, 0, 1), nei(0, 0, 4), nei(0, 0, 5)]).toEqual([null, null, null]);
  });

  test("DT_ALREADY_OCCUPIED, DT_WRONG_MAGIC, DT_WRONG_VERSION", () => {
    const { t00 } = wallWorldTiles();
    const mesh = meshOf([t00]);
    expect(mesh.addTile(t00.data, t00.data.length, 0, 0, null)).toBe(DT_FAILURE | DT_ALREADY_OCCUPIED);
    const other = buildGridTile({ tx: 0, ty: 0, size: 10, cells: rectCells(0, 0, 2, 2) });
    expect(mesh.addTile(other.data, other.data.length, 0, 0, null)).toBe(DT_FAILURE | DT_ALREADY_OCCUPIED);

    const fresh = meshOf([]);
    const badMagic = other.data.slice();
    new DataView(badMagic.buffer).setInt32(0, 0x56414e44, true); // 'DNAV' byte swapped
    expect(fresh.addTile(badMagic, badMagic.length, 0, 0, null)).toBe(DT_FAILURE | DT_WRONG_MAGIC);
    const badVersion = other.data.slice();
    new DataView(badVersion.buffer).setInt32(4, 6, true);
    expect(fresh.addTile(badVersion, badVersion.length, 0, 0, null)).toBe(DT_FAILURE | DT_WRONG_VERSION);
    expect(fresh.getTileAt(0, 0, 0)).toBeNull();
  });
});

describe("dtNavMesh::removeTile", () => {
  test("returns the data, bumps the salt, invalidates refs; re-adding gives new refs", () => {
    const { t00, t10 } = wallWorldTiles();
    const mesh = meshOf([t00, t10]);
    const ref = mesh.getTileRefAt(1, 0, 0);
    const oldPoly = ref + 5;
    expect(mesh.isValidPolyRef(oldPoly)).toBe(true);
    const data = { value: null as Uint8Array | null };
    const size = { value: -1 };
    expect(mesh.removeTile(ref, data, size)).toBe(DT_SUCCESS);
    // Not DT_TILE_FREE_DATA: the caller gets its data back (tile->data itself is not reset in that branch).
    expect([data.value, size.value]).toEqual([t10.data, t10.data.length]);
    expect(mesh.getTileAt(1, 0, 0)).toBeNull();
    const slot = mesh.getTile(1);
    expect([slot.salt, slot.header, slot.flags, slot.linksFreeList]).toEqual([2, null, 0, 0]);
    expect(mesh.m_nextFree).toBe(slot);
    expect(mesh.isValidPolyRef(oldPoly)).toBe(false);
    expect(mesh.getTileByRef(ref)).toBeNull();
    for (const bad of [ref, 0, mesh.encodePolyId(1, 16, 0)]) expect(mesh.removeTile(bad, null, null)).toBe(DT_FAILURE | DT_INVALID_PARAM);

    const result = new Float64Array(1);
    expect(mesh.addTile(t10.data, t10.data.length, 0, 0, result)).toBe(DT_SUCCESS);
    expect(result[0]).toBe(mesh.encodePolyId(2, 1, 0));
    expect(mesh.isValidPolyRef(oldPoly)).toBe(false);
    expect(mesh.isValidPolyRef(result[0]! + 5)).toBe(true);
  });

  test("addTile with lastRef restores the slot and the salt", () => {
    const { t00, t10 } = wallWorldTiles();
    const mesh = meshOf([t00, t10]);
    const ref = mesh.getTileRefAt(1, 0, 0);
    mesh.removeTile(mesh.getTileRefAt(0, 0, 0), null, null);
    mesh.removeTile(ref, null, null);
    const result = new Float64Array(1);
    expect(mesh.addTile(t10.data, t10.data.length, 0, ref, result)).toBe(DT_SUCCESS);
    expect(result[0]).toBe(ref);
    expect(mesh.isValidPolyRef(ref + 5)).toBe(true);
    // The slot is no longer in the free list.
    expect(mesh.addTile(t00.data, t00.data.length, 0, ref, null)).toBe(DT_FAILURE | DT_OUT_OF_MEMORY);
  });

  test("DT_TILE_FREE_DATA: the mesh owns the data and returns null; salt wraps to 1, never 0", () => {
    const { t00 } = wallWorldTiles();
    const mesh = meshOf([]);
    mesh.addTile(t00.data, t00.data.length, DT_TILE_FREE_DATA, 0, null);
    const tile = mesh.getTileAt(0, 0, 0)!;
    tile.salt = 0xfff;
    const data = { value: new Uint8Array(1) as Uint8Array | null };
    const size = { value: 99 };
    expect(mesh.removeTile(mesh.getTileRef(tile), data, size)).toBe(DT_SUCCESS);
    expect([data.value, size.value, tile.data, tile.salt]).toEqual([null, 0, null, 1]);
  });
});

describe("dtNavMesh external links", () => {
  test("portal links across x = 10, removed with the tile (unconnectLinks), rebuilt on re-add", () => {
    const { t00, t10, t01 } = wallWorldTiles();
    const mesh = meshOf([t00, t10, t01]);
    const tile0 = mesh.getTileAt(0, 0, 0)!;
    const tile1 = mesh.getTileAt(1, 0, 0)!;
    const ip0 = polyIndex(t00, 9, 5);
    const ip1 = polyIndex(t10, 10, 5);
    expect([tile0.polyNeis(ip0, 2), tile1.polyNeis(ip1, 0)]).toEqual([DT_EXT_LINK | 0, DT_EXT_LINK | 4]);
    // Internal links (side 0xff) in edge order: x- (8,5), z+ (9,6), z- (9,4); the external one is prepended.
    const b0 = mesh.getPolyRefBase(tile0);
    const internal = [link(b0 + polyIndex(t00, 8, 5), 0, 0xff), link(b0 + polyIndex(t00, 9, 6), 1, 0xff), link(b0 + polyIndex(t00, 9, 4), 3, 0xff)];
    const expectBoth = (b1: number) => {
      expect(linksOf(tile0, ip0)).toEqual([link(b1 + ip1, 2, 0, 0, 255), ...internal]);
      expect(extLinks(tile1, ip1)).toEqual([link(b0 + ip0, 0, 4, 0, 255)]);
    };
    expectBoth(mesh.getPolyRefBase(tile1));

    mesh.removeTile(mesh.getTileRef(tile1), null, null);
    expect(linksOf(tile0, ip0)).toEqual(internal);
    const result = new Float64Array(1);
    mesh.addTile(t10.data, t10.data.length, 0, 0, result);
    expect(result[0]).toBe(mesh.encodePolyId(2, 1, 0));
    expectBoth(result[0]!);

    // Cell (5,9): edge 1 is a z+ portal, but tile (0,1) has no cells on z = 10: no link.
    const ip = polyIndex(t00, 5, 9);
    expect(tile0.polyNeis(ip, 1)).toBe(DT_EXT_LINK | 2);
    expect(linksOf(tile0, ip).map((l) => l.side)).toEqual([0xff, 0xff, 0xff]);
    // The island's x- / z+ portals face no tile at all.
    const tile01 = mesh.getTileAt(0, 1, 0)!;
    for (let i = 0; i < 4; ++i) expect(extLinks(tile01, i)).toEqual([]);
  });

  test("partially overlapping portal edges quantize bmin/bmax to 0..255", () => {
    // Tile (0,0): unit cells in column cx = 9 (x 9..10). Tile (1,0): cs = 2 cells in column cx = 5 (x 10..12),
    // so each of its x- edges spans two of tile (0,0)'s x+ edges.
    const a = buildGridTile({ tx: 0, ty: 0, size: 10, cells: rectCells(9, 0, 10, 10) });
    const b = buildGridTile({ tx: 1, ty: 0, size: 5, cs: 2, cells: rectCells(5, 0, 6, 5) });
    const mesh = meshOf([a, b]);
    const ta = mesh.getTileAt(0, 0, 0)!;
    const tb = mesh.getTileAt(1, 0, 0)!;
    const baseA = mesh.getPolyRefBase(ta);
    const baseB = mesh.getPolyRefBase(tb);
    // b's edge z 2..4 (va z = 2, vb z = 4) meets a's edges z 2..3 and 3..4: t = (z - 2) / 2 gives [0, 0.5] and
    // [0.5, 1], so (0, trunc(127.5)) and (127, 255). findConnectingPolys returns them in poly order; links are prepended.
    expect(extLinks(tb, polyIndex(b, 5, 1))).toEqual([
      link(baseA + polyIndex(a, 9, 3), 0, 4, 127, 255),
      link(baseA + polyIndex(a, 9, 2), 0, 4, 0, 127),
    ]);
    // a's edges lie inside b's edge: the full range.
    expect(extLinks(ta, polyIndex(a, 9, 3))).toEqual([link(baseB + polyIndex(b, 5, 1), 2, 0, 0, 255)]);
    expect(extLinks(ta, polyIndex(a, 9, 2))).toEqual([link(baseB + polyIndex(b, 5, 1), 2, 0, 0, 255)]);
    expect(extLinks(ta, polyIndex(a, 9, 0))).toEqual([link(baseB + polyIndex(b, 5, 0), 2, 0, 0, 255)]);
  });
});

describe("dtNavMesh poly flags, area and tile state", () => {
  test("setPolyFlags / getPolyFlags / setPolyArea / getPolyArea", () => {
    const mesh = meshOf([wallWorldTiles().t00]);
    const ref = mesh.getTileRefAt(0, 0, 0) + 3;
    const flags = new Uint16Array(1);
    const area = new Uint8Array(1);
    expect(mesh.getPolyFlags(ref, flags)).toBe(DT_SUCCESS);
    expect(flags[0]).toBe(1); // NAV_GROUND
    expect(mesh.setPolyFlags(ref, 0x1234)).toBe(DT_SUCCESS);
    mesh.getPolyFlags(ref, flags);
    expect(flags[0]).toBe(0x1234);
    // setArea keeps the type bits and masks the area to 6 bits.
    expect(mesh.setPolyArea(ref, 0x7f)).toBe(DT_SUCCESS);
    expect(mesh.getPolyArea(ref, area)).toBe(DT_SUCCESS);
    expect(area[0]).toBe(0x3f);
    expect(mesh.getTileAt(0, 0, 0)!.polyGetType(3)).toBe(DT_POLYTYPE_GROUND);
    expect([mesh.setPolyFlags(0, 1), mesh.getPolyFlags(0, flags), mesh.setPolyArea(0, 1), mesh.getPolyArea(0, area)]).toEqual(new Array(4).fill(DT_FAILURE));
    const bad = ref + 1000;
    expect([mesh.setPolyFlags(bad, 1), mesh.getPolyFlags(bad, flags), mesh.setPolyArea(bad, 1), mesh.getPolyArea(bad, area)]).toEqual(
      new Array(4).fill(DT_FAILURE | DT_INVALID_PARAM),
    );
  });

  test("storeTileState / restoreTileState round trip", () => {
    const { t00, t10 } = wallWorldTiles();
    const mesh = meshOf([t00, t10]);
    const tile = mesh.getTileAt(1, 0, 0)!;
    const base = mesh.getPolyRefBase(tile);
    // dtAlign4(sizeof(dtTileState) = 16) + dtAlign4(sizeof(dtPolyState) = 4 * 30 polys)
    expect([mesh.getTileStateSize(tile), mesh.getTileStateSize(null)]).toEqual([136, 0]);
    mesh.setPolyFlags(base + 2, 0xabcd);
    mesh.setPolyArea(base + 2, 9);
    const buf = new Uint8Array(136);
    expect(mesh.storeTileState(tile, buf, 135)).toBe(DT_FAILURE | DT_BUFFER_TOO_SMALL);
    expect(mesh.storeTileState(tile, buf, 136)).toBe(DT_SUCCESS);
    const view = new DataView(buf.buffer);
    expect([view.getInt32(0, true), view.getInt32(4, true)]).toEqual([DT_NAVMESH_STATE_MAGIC, DT_NAVMESH_STATE_VERSION]);
    expect(view.getUint32(12, true) * 2 ** 32 + view.getUint32(8, true)).toBe(mesh.getTileRef(tile));
    expect([view.getUint16(16 + 2 * 4, true), view.getUint8(16 + 2 * 4 + 2)]).toEqual([0xabcd, 9]);

    for (let i = 0; i < 30; ++i) {
      mesh.setPolyFlags(base + i, 0);
      mesh.setPolyArea(base + i, 0);
    }
    expect(mesh.restoreTileState(tile, buf, 135)).toBe(DT_FAILURE | DT_INVALID_PARAM);
    const big = new Uint8Array(1000); // tile (0,0) needs 16 + 4 * 92 bytes
    big.set(buf);
    expect(mesh.restoreTileState(mesh.getTileAt(0, 0, 0)!, big, 1000)).toBe(DT_FAILURE | DT_INVALID_PARAM); // ref mismatch
    expect(mesh.restoreTileState(tile, buf, 136)).toBe(DT_SUCCESS);
    const flags = new Uint16Array(1);
    const area = new Uint8Array(1);
    for (let i = 0; i < 30; ++i) {
      mesh.getPolyFlags(base + i, flags);
      mesh.getPolyArea(base + i, area);
      expect([flags[0], area[0]]).toEqual(i === 2 ? [0xabcd, 9] : [1, 1]);
    }
    const wrong = buf.slice();
    const wv = new DataView(wrong.buffer);
    wv.setInt32(0, 1, true);
    expect(mesh.restoreTileState(tile, wrong, 136)).toBe(DT_FAILURE | DT_WRONG_MAGIC);
    wv.setInt32(0, DT_NAVMESH_STATE_MAGIC, true);
    wv.setInt32(4, 2, true);
    expect(mesh.restoreTileState(tile, wrong, 136)).toBe(DT_FAILURE | DT_WRONG_VERSION);
  });
});

describe("dtNavMesh off-mesh connections and poly queries", () => {
  // One 10x10 tile with a connection from cell (2,2) to cell (7,7); its poly is index 100 (offMeshBase).
  const offMeshMesh = (bidir: boolean) => {
    const t = buildGridTile({
      tx: 0, ty: 0, size: 10, cells: rectCells(0, 0, 10, 10),
      offMeshCons: [{ start: [2.5, 0, 2.5], end: [7.5, 0, 7.5], rad: 0.5, bidir, userId: 77 }],
    });
    const mesh = meshOf([t]);
    const tile = mesh.getTileAt(0, 0, 0)!;
    const base = mesh.getPolyRefBase(tile);
    return { t, mesh, tile, off: base + 100, start: base + polyIndex(t, 2, 2), end: base + polyIndex(t, 7, 7) };
  };

  test("baseOffMeshLinks / connectExtOffMeshLinks link both end points", () => {
    const { t, tile, off, start, end } = offMeshMesh(true);
    expect(tile.header!.offMeshBase).toBe(100);
    // baseOffMeshLinks links the start (edge 0) first; connectExtOffMeshLinks(tile, tile, -1) prepends the end (edge 1).
    expect(linksOf(tile, 100)).toEqual([link(end, 1, 0xff), link(start, 0, 0xff)]);
    // The start poly always links back; the end poly only for a bidirectional connection.
    expect(linksOf(tile, polyIndex(t, 2, 2))[0]).toEqual(link(off, 0xff, 0xff));
    expect(linksOf(tile, polyIndex(t, 7, 7))[0]).toEqual(link(off, 0xff, 0xff));
    const oneWay = offMeshMesh(false);
    expect(linksOf(oneWay.tile, polyIndex(oneWay.t, 2, 2))[0]).toEqual(link(oneWay.off, 0xff, 0xff));
    expect(linksOf(oneWay.tile, polyIndex(oneWay.t, 7, 7)).some((l) => l.ref === oneWay.off)).toBe(false);
    expect(linksOf(oneWay.tile, 100)).toEqual([link(oneWay.end, 1, 0xff), link(oneWay.start, 0, 0xff)]);
  });

  test("getOffMeshConnectionPolyEndPoints orders by prevRef; getOffMeshConnectionByRef", () => {
    const { mesh, off, start, end } = offMeshMesh(true);
    const a = new Float32Array(3);
    const b = new Float32Array(3);
    expect(mesh.getOffMeshConnectionPolyEndPoints(start, off, a, b)).toBe(DT_SUCCESS);
    expect([arr(a), arr(b)]).toEqual([[2.5, 0, 2.5], [7.5, 0, 7.5]]);
    // Any prevRef other than the edge-0 link's ref hands the vertices out reversed.
    for (const prev of [end, 0]) {
      expect(mesh.getOffMeshConnectionPolyEndPoints(prev, off, a, b)).toBe(DT_SUCCESS);
      expect([arr(a), arr(b)]).toEqual([[7.5, 0, 7.5], [2.5, 0, 2.5]]);
    }
    expect(mesh.getOffMeshConnectionPolyEndPoints(start, start, a, b)).toBe(DT_FAILURE); // ground poly
    expect(mesh.getOffMeshConnectionPolyEndPoints(start, 0, a, b)).toBe(DT_FAILURE);
    expect(mesh.getOffMeshConnectionPolyEndPoints(start, off + 1, a, b)).toBe(DT_FAILURE | DT_INVALID_PARAM);

    const con = mesh.getOffMeshConnectionByRef(off)!;
    expect([arr(con.pos), con.rad, con.poly, con.flags, con.side, con.userId]).toEqual([[2.5, 0, 2.5, 7.5, 0, 7.5], 0.5, 100, DT_OFFMESH_CON_BIDIR, 0xff, 77]);
    expect(mesh.getOffMeshConnectionByRef(start)).toBeNull();
    expect(mesh.getOffMeshConnectionByRef(0)).toBeNull();
    expect(mesh.getOffMeshConnectionByRef(off + 1)).toBeNull();
  });

  test("getPolyHeight / closestPointOnPoly / findNearestPolyInTile", () => {
    // Slope y = x / 2 (vertex heights are multiples of ch = 0.5).
    const t = buildGridTile({ tx: 0, ty: 0, size: 10, cells: rectCells(0, 0, 10, 10), height: (vx) => vx / 2 });
    const mesh = meshOf([t]);
    const tile = mesh.getTileAt(0, 0, 0)!;
    const ip = polyIndex(t, 2, 2);
    const h = new Float32Array(1);
    expect(mesh.getPolyHeight(tile, ip, new Float32Array([2.5, 9, 2.25]), 0, h, 0)).toBe(true);
    expect(h[0]).toBeCloseTo(1.25, 5);
    expect(mesh.getPolyHeight(tile, ip, new Float32Array([3.5, 0, 2.5]), 0, h, 0)).toBe(false);
    expect(mesh.getPolyHeight(tile, ip, new Float32Array([2.5, 0, 2.5]), 0, null, 0)).toBe(true);

    const ref = mesh.getPolyRefBase(tile) + ip;
    const closest = new Float32Array(3);
    const over = { value: false };
    mesh.closestPointOnPoly(ref, new Float32Array([2.75, 7, 2.5]), 0, closest, 0, over);
    expect(over.value).toBe(true);
    expect([closest[0], closest[2]]).toEqual([2.75, 2.5]);
    expect(closest[1]).toBeCloseTo(1.375, 5);
    // Outside: the closest point on the boundary edge x = 2 (height 1).
    mesh.closestPointOnPoly(ref, new Float32Array([0.5, 7, 2.5]), 0, closest, 0, over);
    expect(over.value).toBe(false);
    expect(arr(closest)).toEqual([2, 1, 2.5]);

    // Several cells overlap the quantized query box; the one under the point (|dy| < climb) wins.
    const nearest = new Float32Array(3);
    const found = mesh.findNearestPolyInTile(tile, new Float32Array([5.5, 3, 6.5]), 0, new Float32Array([0.2, 2, 0.2]), nearest);
    expect(found).toBe(mesh.getPolyRefBase(tile) + polyIndex(t, 5, 6));
    expect(nearest[1]).toBeCloseTo(2.75, 5);
  });
});
