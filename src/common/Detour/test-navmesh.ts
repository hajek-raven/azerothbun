/**
 * Test helper: builds Detour tiles with `dtCreateNavMeshData` from a hand-made Recast-style poly mesh, the way
 * `MapBuilder` feeds `rcPolyMesh` into Detour, but without Recast. The mesh is a grid of square cells of side `cs` (default 1):
 * each walkable cell is one quad polygon. Cell `(cx, cz)` covers Detour `x` in `[cx, cx + 1]` and `z` in `[cz, cz + 1]`
 * (global cell coordinates; tile `(tx, ty)` holds the cells with `tx * size <= cx < (tx + 1) * size`, same for `z`).
 *
 * Polygons are wound like Recast's (`(x0,z0) (x0,z1) (x1,z1) (x1,z0)`), so edge 0 faces `x-`, edge 1 `z+`, edge 2 `x+`
 * and edge 3 `z-`. A missing neighbour on a tile side becomes a portal (`0x8000 | dir`, as `rcBuildPolyMesh` marks
 * them), otherwise a wall (`RC_MESH_NULL_IDX`).
 */
import { NavTerrain } from "../Collision/Management/MMapDefines.ts";
import { dtAllocNavMesh, dtNavMeshParams, type dtNavMesh } from "./DetourNavMesh.ts";
import { dtCreateNavMeshData, dtNavMeshCreateParams } from "./DetourNavMeshBuilder.ts";
import { dtAllocNavMeshQuery, dtQueryFilter, type dtNavMeshQuery } from "./DetourNavMeshQuery.ts";
import { dtStatusFailed } from "./DetourStatus.ts";

/** `RC_MESH_NULL_IDX` */
export const RC_MESH_NULL_IDX = 0xffff;
/** Vertices per polygon in the generated poly mesh (`MapBuilder` uses `DT_VERTS_PER_POLYGON`). */
export const TEST_NVP = 6;

/** One off-mesh connection (`dtNavMeshCreateParams::offMeshCon*`), Detour coordinates. */
export interface TestOffMeshCon {
  start: [number, number, number];
  end: [number, number, number];
  rad: number;
  bidir: boolean;
  flags?: number;
  area?: number;
  userId?: number;
}

export interface TestTileOptions {
  tx: number;
  ty: number;
  /** Cells per tile side. */
  size: number;
  /** Walkable cells, global cell coordinates `[cx, cz]` (cells outside this tile are ignored). */
  cells: ReadonlyArray<readonly [number, number]>;
  /** World `y` of a vertex at global vertex coordinates `(vx, vz)`; must be a multiple of `ch`. Default 0. */
  height?: (vx: number, vz: number) => number;
  /** Cell side in world units (`cs`), default 1. Cell `(cx, cz)` covers `[cx * cs, (cx + 1) * cs]`. */
  cs?: number;
  /** `ch`, default 0.5. */
  ch?: number;
  /** Tile `bmin[1]` / `bmax[1]`, default -2 / 20. */
  minY?: number;
  maxY?: number;
  polyFlags?: number;
  polyArea?: number;
  /** Per-cell poly flags (global cell coordinates); overrides `polyFlags`. */
  cellFlags?: (cx: number, cz: number) => number;
  /** Per-cell poly area (global cell coordinates); overrides `polyArea`. */
  cellArea?: (cx: number, cz: number) => number;
  offMeshCons?: TestOffMeshCon[];
  buildBvTree?: boolean;
  walkableClimb?: number;
}

/** The per-polygon cell order of the built tile: `polyCells[i]` is the cell of poly index `i`. */
export interface TestTile {
  data: Uint8Array;
  polyCells: Array<readonly [number, number]>;
}

/** Builds the tile blob for `opts` with `dtCreateNavMeshData`. */
export function buildGridTile(opts: TestTileOptions): TestTile {
  const { params, polyCells } = gridTileParams(opts);
  const out: { value: Uint8Array | null } = { value: null };
  const outSize = { value: 0 };
  if (!dtCreateNavMeshData(params, out, outSize) || !out.value) throw new Error(`dtCreateNavMeshData failed for tile ${opts.tx},${opts.ty}`);
  return { data: out.value.subarray(0, outSize.value), polyCells };
}

/** The `dtNavMeshCreateParams` that `buildGridTile` passes to `dtCreateNavMeshData` (for tests that edit them first). */
export function gridTileParams(opts: TestTileOptions): { params: dtNavMeshCreateParams; polyCells: Array<readonly [number, number]> } {
  const { tx, ty, size } = opts;
  const cs = opts.cs ?? 1;
  const ch = opts.ch ?? 0.5;
  const minY = opts.minY ?? -2;
  const maxY = opts.maxY ?? 20;
  const height = opts.height ?? (() => 0);
  const x0 = tx * size;
  const z0 = ty * size;

  const inTile = (cx: number, cz: number) => cx >= x0 && cx < x0 + size && cz >= z0 && cz < z0 + size;
  const cellKey = (cx: number, cz: number) => `${cx},${cz}`;
  const polyCells: Array<readonly [number, number]> = [];
  const cellIndex = new Map<string, number>();
  for (const [cx, cz] of opts.cells) {
    if (!inTile(cx, cz) || cellIndex.has(cellKey(cx, cz))) continue;
    cellIndex.set(cellKey(cx, cz), polyCells.length);
    polyCells.push([cx, cz]);
  }

  // Vertices, deduplicated; stored as Recast quantized (x, y, z) relative to bmin.
  const verts: number[] = [];
  const vertIndex = new Map<string, number>();
  const vert = (vx: number, vz: number): number => {
    const key = cellKey(vx, vz);
    let i = vertIndex.get(key);
    if (i === undefined) {
      i = verts.length / 3;
      vertIndex.set(key, i);
      const qy = Math.round((height(vx, vz) - minY) / ch);
      verts.push(vx - x0, qy, vz - z0);
    }
    return i;
  };

  const polys = new Uint16Array(polyCells.length * 2 * TEST_NVP).fill(RC_MESH_NULL_IDX);
  for (let p = 0; p < polyCells.length; ++p) {
    const [cx, cz] = polyCells[p]!;
    const base = p * 2 * TEST_NVP;
    polys[base + 0] = vert(cx, cz);
    polys[base + 1] = vert(cx, cz + 1);
    polys[base + 2] = vert(cx + 1, cz + 1);
    polys[base + 3] = vert(cx + 1, cz);
    // edge 0: x-, edge 1: z+, edge 2: x+, edge 3: z-
    const neighbours: Array<[number, number, boolean, number]> = [
      [cx - 1, cz, cx === x0, 0],
      [cx, cz + 1, cz + 1 === z0 + size, 1],
      [cx + 1, cz, cx + 1 === x0 + size, 2],
      [cx, cz - 1, cz === z0, 3],
    ];
    for (let e = 0; e < 4; ++e) {
      const [nx, nz, onBorder, dir] = neighbours[e]!;
      const n = cellIndex.get(cellKey(nx, nz));
      if (n !== undefined) polys[base + TEST_NVP + e] = n;
      else if (onBorder) polys[base + TEST_NVP + e] = 0x8000 | dir;
      else polys[base + TEST_NVP + e] = RC_MESH_NULL_IDX;
    }
  }

  const params = new dtNavMeshCreateParams();
  params.verts = new Uint16Array(verts);
  params.vertCount = verts.length / 3;
  params.polys = polys;
  params.polyFlags = new Uint16Array(polyCells.length).fill(opts.polyFlags ?? NavTerrain.NAV_GROUND);
  params.polyAreas = new Uint8Array(polyCells.length).fill(opts.polyArea ?? NavTerrain.NAV_GROUND);
  for (let p = 0; p < polyCells.length; ++p) {
    const [cx, cz] = polyCells[p]!;
    if (opts.cellFlags) params.polyFlags[p] = opts.cellFlags(cx, cz);
    if (opts.cellArea) params.polyAreas[p] = opts.cellArea(cx, cz);
  }
  params.polyCount = polyCells.length;
  params.nvp = TEST_NVP;

  const cons = opts.offMeshCons ?? [];
  if (cons.length) {
    params.offMeshConVerts = new Float32Array(cons.flatMap((c) => [...c.start, ...c.end]));
    params.offMeshConRad = new Float32Array(cons.map((c) => c.rad));
    params.offMeshConFlags = new Uint16Array(cons.map((c) => c.flags ?? NavTerrain.NAV_GROUND));
    params.offMeshConAreas = new Uint8Array(cons.map((c) => c.area ?? NavTerrain.NAV_GROUND));
    params.offMeshConDir = new Uint8Array(cons.map((c) => (c.bidir ? 1 : 0)));
    params.offMeshConUserID = new Uint32Array(cons.map((c, i) => c.userId ?? 1000 + i));
    params.offMeshConCount = cons.length;
  }

  params.tileX = tx;
  params.tileY = ty;
  params.tileLayer = 0;
  params.bmin.set([x0 * cs, minY, z0 * cs]);
  params.bmax.set([(x0 + size) * cs, maxY, (z0 + size) * cs]);
  params.walkableHeight = 2;
  params.walkableRadius = 0.5;
  params.walkableClimb = opts.walkableClimb ?? 1;
  params.cs = cs;
  params.ch = ch;
  params.buildBvTree = opts.buildBvTree ?? true;
  return { params, polyCells };
}

/** `dtNavMeshParams` for a mesh of `size`-cell tiles starting at the origin. */
export function gridNavMeshParams(size: number, maxTiles = 16, cs = 1): dtNavMeshParams {
  const params = new dtNavMeshParams();
  params.orig.set([0, 0, 0]);
  params.tileWidth = size * cs;
  params.tileHeight = size * cs;
  params.maxTiles = maxTiles;
  params.maxPolys = 1 << 20;
  return params;
}

/** Inits a nav mesh, adds every tile (`DT_TILE_FREE_DATA`), and creates a 2048-node query. */
export function buildNavMesh(size: number, tiles: TestTile[], maxNodes = 2048, cs = 1): { mesh: dtNavMesh; query: dtNavMeshQuery } {
  const mesh = dtAllocNavMesh();
  if (dtStatusFailed(mesh.init(gridNavMeshParams(size, 16, cs)))) throw new Error("dtNavMesh::init failed");
  for (const tile of tiles) {
    if (dtStatusFailed(mesh.addTile(tile.data, tile.data.length, 1, 0, null))) throw new Error("dtNavMesh::addTile failed");
  }
  const query = dtAllocNavMeshQuery();
  if (dtStatusFailed(query.init(mesh, maxNodes))) throw new Error("dtNavMeshQuery::init failed");
  return { mesh, query };
}

/** All cells of the rectangle `[cx0, cx1) x [cz0, cz1)`. */
export function rectCells(cx0: number, cz0: number, cx1: number, cz1: number): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let cz = cz0; cz < cz1; ++cz) for (let cx = cx0; cx < cx1; ++cx) cells.push([cx, cz]);
  return cells;
}

/**
 * The shared test world, `size` 10:
 * - tile (0,0): cells x 0..9, z 0..9 without the wall column `cx = 4, cz = 0..7` (the gap is `cz = 8, 9`);
 * - tile (1,0): cells x 10..12, z 0..9 (joined to tile (0,0) across `x = 10`);
 * - tile (0,1): an island `cx = 0..1, cz = 18..19`, not connected to anything.
 */
export function wallWorldTiles(cs = 1): { t00: TestTile; t10: TestTile; t01: TestTile } {
  const wall = (cx: number, cz: number) => cx === 4 && cz < 8;
  const t00 = buildGridTile({ tx: 0, ty: 0, size: 10, cs, cells: rectCells(0, 0, 10, 10).filter(([cx, cz]) => !wall(cx, cz)) });
  const t10 = buildGridTile({ tx: 1, ty: 0, size: 10, cs, cells: rectCells(10, 0, 13, 10) });
  const t01 = buildGridTile({ tx: 0, ty: 1, size: 10, cs, cells: rectCells(0, 18, 2, 20) });
  return { t00, t10, t01 };
}

/** The ref of the polygon of cell `(cx, cz)` (centre lookup with a tiny box). */
export function cellRef(query: dtNavMeshQuery, cx: number, cz: number, y = 0, cs = 1): number {
  const ref = new Float64Array(1);
  query.findNearestPoly(new Float32Array([(cx + 0.5) * cs, y, (cz + 0.5) * cs]), new Float32Array([0.1, 1, 0.1]), defaultFilter(), ref, new Float32Array(3));
  return ref[0]!;
}

/** A default `dtQueryFilter` (include all, exclude none). */
export function defaultFilter(): dtQueryFilter {
  return new dtQueryFilter();
}

/** A `Float32Array` point `(x, y, z)`. */
export const v3 = (x: number, y: number, z: number): Float32Array => new Float32Array([x, y, z]);

/**
 * `buildNavMesh(size, tiles)` plus `ref(cx, cz)` (the poly of a cell, looked up at height `y(cx, cz)`) and the reverse
 * `cells` map (ref to cell).
 */
export function cellWorld(size: number, tiles: TestTile[], y: (cx: number, cz: number) => number = () => 0) {
  const { mesh, query } = buildNavMesh(size, tiles);
  const refs = new Map<string, number>();
  const cells = new Map<number, readonly [number, number]>();
  for (const t of tiles) {
    for (const [cx, cz] of t.polyCells) {
      const r = cellRef(query, cx, cz, y(cx, cz));
      refs.set(`${cx},${cz}`, r);
      cells.set(r, [cx, cz]);
    }
  }
  const ref = (cx: number, cz: number): number => refs.get(`${cx},${cz}`) ?? 0;
  return { mesh, query, ref, cells };
}

/** `cellWorld` over `wallWorldTiles()`. */
export function wallWorld() {
  const { t00, t10, t01 } = wallWorldTiles();
  return cellWorld(10, [t00, t10, t01]);
}
