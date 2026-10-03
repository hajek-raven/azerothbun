import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DT_NAVMESH_VERSION } from "../../Detour/DetourNavMesh.ts";
import { DT_PARTIAL_RESULT, dtStatusSucceed } from "../../Detour/DetourStatus.ts";
import { buildGridTile, defaultFilter, gridNavMeshParams, rectCells } from "../../Detour/test-navmesh.ts";
import { MAP_FILE_NAME_FORMAT, MMapMgr, TILE_FILE_NAME_FORMAT } from "./MMapMgr.ts";
import { MMAP_MAGIC, MMAP_VERSION, MmapTileHeader, SIZEOF_MMAP_TILE_HEADER } from "./MMapDefines.ts";

/**
 * Mirrors `MapBuilder::buildNavMesh` / `TileWorker::buildMoveMapTile`: `fwrite(&navMeshParams, sizeof(dtNavMeshParams))`
 * into `MMM.mmap`, then `fwrite(&header, sizeof(MmapTileHeader))` and the `dtCreateNavMeshData` blob into
 * `MMMXXYY.mmtile`. `MmapTileHeader` is packed by hand from `MapDefines.h` (56 bytes, little endian).
 */
function tileFileBytes(data: Uint8Array, opts: { magic?: number; dtVersion?: number; mmapVersion?: number; size?: number } = {}): Uint8Array {
  const out = new Uint8Array(SIZEOF_MMAP_TILE_HEADER + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, opts.magic ?? MMAP_MAGIC, true);
  v.setUint32(4, opts.dtVersion ?? DT_NAVMESH_VERSION, true);
  v.setUint32(8, opts.mmapVersion ?? MMAP_VERSION, true);
  v.setUint32(12, opts.size ?? data.length, true);
  out[16] = 1; // usesLiquids, padding[3] stays 0
  // MmapTileRecastConfig at 20: walkableSlopeAngle, walkableRadius/Height/Climb, padding0,
  // vertexPerMapEdge, vertexPerTileEdge, tilesPerMapEdge, baseUnitDim, cellSizeHorizontal, cellSizeVertical, maxSimplificationError
  v.setFloat32(20, 60, true);
  out[24] = 2;
  out[25] = 6;
  out[26] = 4;
  v.setUint32(28, 2000, true);
  v.setUint32(32, 80, true);
  v.setUint32(36, 25, true);
  v.setFloat32(40, 0.2666666, true);
  v.setFloat32(44, 0.2666666, true);
  v.setFloat32(48, 0.2666666, true);
  v.setFloat32(52, 1.8, true);
  out.set(data, SIZEOF_MMAP_TILE_HEADER);
  return out;
}

let dataDir = "";
const MAP = 1;
const t00 = buildGridTile({ tx: 0, ty: 0, size: 10, cells: rectCells(0, 0, 10, 10) });
const t10 = buildGridTile({ tx: 1, ty: 0, size: 10, cells: rectCells(10, 0, 20, 10) });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mmapmgr-"));
  mkdirSync(join(dataDir, "mmaps"));
  const params = gridNavMeshParams(10, 4);
  params.maxPolys = 1 << 31; // MapBuilder: `int maxPolysPerTile = 1 << DT_POLY_BITS` (INT_MIN)
  await Bun.write(MAP_FILE_NAME_FORMAT(dataDir, MAP), params.toBytes());
  await Bun.write(TILE_FILE_NAME_FORMAT(dataDir, MAP, 0, 0), tileFileBytes(t00.data));
  await Bun.write(TILE_FILE_NAME_FORMAT(dataDir, MAP, 1, 0), tileFileBytes(t10.data));
  await Bun.write(TILE_FILE_NAME_FORMAT(dataDir, MAP, 2, 0), tileFileBytes(t10.data, { magic: 0x12345678 }));
  await Bun.write(TILE_FILE_NAME_FORMAT(dataDir, MAP, 3, 0), tileFileBytes(t10.data, { mmapVersion: MMAP_VERSION - 1 }));
  await Bun.write(TILE_FILE_NAME_FORMAT(dataDir, MAP, 4, 0), tileFileBytes(t10.data, { size: t10.data.length + 100 }));
  await Bun.write(TILE_FILE_NAME_FORMAT(dataDir, MAP, 5, 0), new Uint8Array(20));
  await Bun.write(MAP_FILE_NAME_FORMAT(dataDir, 2), new Uint8Array(10)); // too short for dtNavMeshParams
  MMapMgr.setDataDir(dataDir);
});

afterAll(() => {
  MMapMgr.setDataDir(".");
  rmSync(dataDir, { recursive: true, force: true });
});

describe("MMAP file names", () => {
  test("MAP_FILE_NAME_FORMAT and TILE_FILE_NAME_FORMAT pad like {:03} / {:02}", () => {
    expect(MAP_FILE_NAME_FORMAT("data", 1)).toBe("data/mmaps/001.mmap");
    expect(TILE_FILE_NAME_FORMAT("data", 530, 2, 31)).toBe("data/mmaps/5300231.mmtile");
  });

  test("packTileID is x << 16 | y", () => {
    expect(MMapMgr.packTileID(2, 3)).toBe(0x20003);
    expect(MMapMgr.packTileID(63, 63)).toBe((63 << 16) | 63);
  });
});

describe("MMapMgr::LoadNavMesh", () => {
  test("reads dtNavMeshParams from MMM.mmap (maxPolys INT_MIN as written by MapBuilder)", () => {
    const mesh = MMapMgr.loadNavMesh(MAP);
    expect(mesh).not.toBeNull();
    const params = mesh!.getParams();
    expect(Array.from(params.orig)).toEqual([0, 0, 0]);
    expect(params.tileWidth).toBe(10);
    expect(params.tileHeight).toBe(10);
    expect(params.maxTiles).toBe(4);
    expect(params.maxPolys).toBe(-2147483648);
    expect(mesh!.getMaxTiles()).toBe(4);
  });

  test("missing or short .mmap gives null", () => {
    expect(MMapMgr.loadNavMesh(99)).toBeNull();
    expect(MMapMgr.loadNavMesh(2)).toBeNull();
  });
});

describe("MMapMgr::LoadTile", () => {
  test("loads MMMXXYY.mmtile into the nav mesh and links the neighbours", () => {
    const mesh = MMapMgr.loadNavMesh(MAP)!;
    expect(MMapMgr.loadTile(mesh, MAP, 0, 0)).toBe(true);
    expect(MMapMgr.loadTile(mesh, MAP, 1, 0)).toBe(true);
    const tile = mesh.getTileAt(1, 0, 0);
    expect(tile).not.toBeNull();
    expect(tile!.header!.polyCount).toBe(100);

    const query = MMapMgr.createNavMeshQuery(mesh)!;
    expect(query).not.toBeNull();
    const ref = new Float64Array(1);
    const start = new Float32Array([0.5, 0, 0.5]);
    const end = new Float32Array([19.5, 0, 9.5]);
    query.findNearestPoly(start, new Float32Array([0.1, 1, 0.1]), defaultFilter(), ref, new Float32Array(3));
    const startRef = ref[0]!;
    query.findNearestPoly(end, new Float32Array([0.1, 1, 0.1]), defaultFilter(), ref, new Float32Array(3));
    const endRef = ref[0]!;
    expect(startRef).not.toBe(0);
    expect(endRef).not.toBe(0);
    const path = new Float64Array(64);
    const count = new Int32Array(1);
    const status = query.findPath(startRef, endRef, start, end, defaultFilter(), path, count, 64);
    expect(dtStatusSucceed(status)).toBe(true);
    expect(status & DT_PARTIAL_RESULT).toBe(0);
    expect(path[count[0]! - 1]).toBe(endRef);
  });

  test("loading the same tile twice fails (DT_ALREADY_OCCUPIED)", () => {
    const mesh = MMapMgr.loadNavMesh(MAP)!;
    expect(MMapMgr.loadTile(mesh, MAP, 0, 0)).toBe(true);
    expect(MMapMgr.loadTile(mesh, MAP, 0, 0)).toBe(false);
  });

  test("missing file, bad magic, wrong generator version, truncated data and short header all fail", () => {
    const mesh = MMapMgr.loadNavMesh(MAP)!;
    expect(MMapMgr.loadTile(mesh, MAP, 9, 9)).toBe(false);
    expect(MMapMgr.loadTile(mesh, MAP, 2, 0)).toBe(false);
    expect(MMapMgr.loadTile(mesh, MAP, 3, 0)).toBe(false);
    expect(MMapMgr.loadTile(mesh, MAP, 4, 0)).toBe(false);
    expect(MMapMgr.loadTile(mesh, MAP, 5, 0)).toBe(false);
    expect(mesh.getTileAt(2, 0, 0)).toBeNull();
  });

  test("the hand-packed header matches MmapTileHeader parsing", () => {
    const bytes = tileFileBytes(t00.data);
    const header = MmapTileHeader.fromBytes(bytes)!;
    expect(header.mmapMagic).toBe(MMAP_MAGIC);
    expect(header.dtVersion).toBe(DT_NAVMESH_VERSION);
    expect(header.mmapVersion).toBe(MMAP_VERSION);
    expect(header.size).toBe(t00.data.length);
    expect(header.recastConfig.walkableRadius).toBe(2);
    expect(header.recastConfig.walkableHeight).toBe(6);
    expect(header.recastConfig.walkableClimb).toBe(4);
    expect(header.recastConfig.vertexPerMapEdge).toBe(2000);
    expect(header.recastConfig.tilesPerMapEdge).toBe(25);
    expect(header.recastConfig.maxSimplificationError).toBeCloseTo(1.8, 6);
  });
});

describe("MMapMgr::CreateNavMeshQuery", () => {
  test("creates a 1024-node query over the mesh", () => {
    const mesh = MMapMgr.loadNavMesh(MAP)!;
    MMapMgr.loadTile(mesh, MAP, 0, 0);
    const query = MMapMgr.createNavMeshQuery(mesh)!;
    expect(query.getAttachedNavMesh()).toBe(mesh);
    expect(query.getNodePool()!.getMaxNodes()).toBe(1024);
  });
});
