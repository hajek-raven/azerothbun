import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MMAP_MAGIC, MMAP_VERSION, MmapTileHeader, SIZEOF_MMAP_TILE_HEADER } from "../../common/Collision/Management/MMapDefines.ts";
import { MMapMgr } from "../../common/Collision/Management/MMapMgr.ts";
import { DT_NAVMESH_VERSION } from "../../common/Detour/DetourNavMesh.ts";
import { buildMapFile } from "../../game/Grids/GridTerrainData.test-util.ts";
import { PathGenerator, PATHFIND_NORMAL } from "../../game/Movement/MovementGenerators/PathGenerator.ts";
import { fakeMap, fakeSource } from "../../game/Movement/MovementGenerators/test-path-source.ts";
import { Config, GRID_SIZE } from "./Config.ts";
import { MapBuilder, MapTiles, TileBuilder } from "./MapBuilder.ts";
import { MAP_FILE_NAME_FORMAT, V8_SIZE_SQ, V9_SIZE_SQ } from "./TerrainBuilder.ts";

const f32 = Math.fround;

const dir = mkdtempSync(join(tmpdir(), "mmaps-builder-"));
mkdirSync(join(dir, "maps"));
mkdirSync(join(dir, "vmaps"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A coarse mesh (400 vertices per map edge, 80 per tile: 5 x 5 sub tiles of 80 cells) keeps the test fast. */
async function makeConfig(extra = "", name = "mmaps-config.yaml"): Promise<Config> {
  const path = join(dir, name);
  await Bun.write(
    path,
    `mmapsConfig:
  skipLiquid: false
  skipContinents: false
  skipJunkMaps: true
  skipBattlegrounds: false
  dataDir: "${dir}"
  debugOutput: false
  meshSettings:
    walkableSlopeAngle: 60
    walkableHeight: 3
    walkableClimb: 2
    walkableRadius: 1
    verticesPerMapEdge: 400
    verticesPerTileEdge: 80
    maxSimplificationError: 1.8
${extra}`,
  );
  return (await Config.FromFile(path))!;
}

/** Flat terrain at `height` with a block of terrain 20 units higher in the middle (a plateau with steep sides). */
function terrainTile(height: number): Uint8Array {
  const V9 = new Float32Array(V9_SIZE_SQ).fill(height);
  const V8 = new Float32Array(V8_SIZE_SQ).fill(height);
  for (let r = 50; r < 80; ++r)
    for (let c = 50; c < 80; ++c) {
      V9[r * 129 + c] = height + 20;
      if (r < 128 && c < 128) V8[r * 128 + c] = height + 20;
    }
  return buildMapFile({ height: { V9, V8, encoding: "float" } });
}

describe("MapBuilder helpers", () => {
  test("getTileBounds: the tile covers (32 - tile) * GRID_SIZE downwards; elevation is kept from the vertices", async () => {
    const mb = new MapBuilder(await makeConfig(), 5, 1, false);
    const bmin = new Float32Array(3);
    const bmax = new Float32Array(3);
    mb.getTileBounds(31, 33, null, 0, bmin, bmax);
    expect(bmax[0]).toBe(f32(f32(32 - 31) * GRID_SIZE));
    expect(bmax[2]).toBe(f32(f32(32 - 33) * GRID_SIZE));
    expect(bmin[0]).toBe(f32(bmax[0]! - GRID_SIZE));
    expect(bmin[1]).toBe(f32(1.1754943508222875e-38)); // FLT_MIN
    expect(bmax[1]).toBe(f32(3.4028234663852886e38)); // FLT_MAX

    mb.getTileBounds(31, 33, new Float32Array([1, 5, 2, -3, 9, 4]), 2, bmin, bmax);
    expect([bmin[1], bmax[1]]).toEqual([5, 9]);
  });

  test("getRecastConfig derives the Recast configuration from the resolved mesh settings", async () => {
    const config = await makeConfig();
    const mb = new MapBuilder(config, 5, 1, false);
    const cfg = config.GetConfigForTile(5, 1, 1);
    const rc = mb.getRecastConfig(cfg, new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6]));
    expect(rc.maxVertsPerPoly).toBe(6);
    expect(rc.cs).toBe(cfg.cellSizeHorizontal);
    expect(rc.ch).toBe(cfg.cellSizeVertical);
    expect(rc.tileSize).toBe(80);
    expect(rc.walkableRadius).toBe(1);
    expect(rc.borderSize).toBe(4);
    expect(rc.maxEdgeLen).toBe(81);
    expect(rc.walkableHeight).toBe(3);
    expect(rc.walkableClimb).toBe(2);
    expect(rc.minRegionArea).toBe(3600);
    expect(rc.mergeRegionArea).toBe(2500);
    expect(rc.detailSampleDist).toBe(f32(rc.cs * 16));
    expect(rc.detailSampleMaxError).toBe(rc.ch);
    expect(Array.from(rc.bmin)).toEqual([1, 2, 3]);
    expect(Array.from(rc.bmax)).toEqual([4, 5, 6]);
  });

  test("shouldSkipMap follows the skip settings, an explicit map id wins", async () => {
    const config = await makeConfig();
    const skip = (mapid: number, id: number): boolean => (new MapBuilder(config, mapid, 1, false) as unknown as { shouldSkipMap(id: number): boolean }).shouldSkipMap(id);
    // junk maps and transport maps are skipped, continents and battlegrounds are not
    expect(skip(-1, 13)).toBe(true);
    expect(skip(-1, 169)).toBe(true);
    expect(skip(-1, 582)).toBe(true);
    expect(skip(-1, 0)).toBe(false);
    expect(skip(-1, 529)).toBe(false);
    // a requested map id builds only that map, junk or not
    expect(skip(13, 13)).toBe(false);
    expect(skip(13, 0)).toBe(true);

    const strict = await makeConfig("", "strict.yaml");
    const sb = strict as unknown as { _skipContinents: boolean; _skipBattlegrounds: boolean };
    sb._skipContinents = true;
    sb._skipBattlegrounds = true;
    const skip2 = (id: number): boolean => (new MapBuilder(strict, -1, 1, false) as unknown as { shouldSkipMap(id: number): boolean }).shouldSkipMap(id);
    expect([0, 1, 530, 571].map(skip2)).toEqual([true, true, true, true]);
    expect([30, 37, 489, 529, 566, 607, 628].map(skip2)).toEqual([true, true, true, true, true, true, true]);
    expect(skip2(530 + 1)).toBe(false);
  });

  test("MapTiles compares by map id", () => {
    expect(new MapTiles(5, new Set()).equals(5)).toBe(true);
    expect(new MapTiles().equals(0xffffffff)).toBe(true);
  });
});

describe("MapBuilder end to end", () => {
  test("a single tile: .mmap, .mmtile with a valid header, and the mesh can be loaded and walked", async () => {
    await Bun.write(MAP_FILE_NAME_FORMAT(join(dir, "maps"), 999, 30, 30), terrainTile(10));
    const config = await makeConfig();
    const builder = new MapBuilder(config, 999, 1);
    await builder.buildSingleTile(999, 30, 30);

    // the map file holds the 28 byte dtNavMeshParams, the tile file is named MMM + tileY + tileX
    const mmap = Bun.file(join(dir, "mmaps/999.mmap"));
    expect(await mmap.exists()).toBe(true);
    expect(mmap.size).toBe(28);
    const tileFile = Bun.file(join(dir, "mmaps/9993030.mmtile"));
    expect(await tileFile.exists()).toBe(true);

    const bytes = new Uint8Array(await tileFile.arrayBuffer());
    const header = MmapTileHeader.fromBytes(bytes)!;
    expect(header.mmapMagic).toBe(MMAP_MAGIC);
    expect(header.dtVersion).toBe(DT_NAVMESH_VERSION);
    expect(header.mmapVersion).toBe(MMAP_VERSION);
    expect(header.usesLiquids).toBe(1);
    expect(header.size).toBe(bytes.length - SIZEOF_MMAP_TILE_HEADER);
    expect(header.recastConfig.equals(config.GetConfigForTile(999, 30, 30).toMMAPTileRecastConfig())).toBe(true);
    expect(header.recastConfig.tilesPerMapEdge).toBe(5);

    // the tile is up to date, a different configuration makes it stale
    const tb = new TileBuilder(builder, false, false);
    expect(await tb.shouldSkipTile(999, 30, 30)).toBe(true);
    expect(await tb.shouldSkipTile(999, 31, 30)).toBe(false);
    const other = await makeConfig("    mapsOverrides:\n      \"999\":\n        walkableRadius: 3\n", "other.yaml");
    expect(await new TileBuilder(new MapBuilder(other, 999, 1, false), false, false).shouldSkipTile(999, 30, 30)).toBe(false);

    // load it with the runtime and walk across the flat part of the tile
    MMapMgr.setDataDir(dir);
    const nav = MMapMgr.loadNavMesh(999)!;
    expect(nav).not.toBeNull();
    expect(MMapMgr.loadTile(nav, 999, 30, 30)).toBe(true);
    const query = MMapMgr.createNavMeshQuery(nav)!;
    const map = fakeMap({ navMesh: nav, query });
    // tile (30, 30) covers world x, y in [533.3, 1066.7] and the terrain is at z = 10
    // (paths longer than about 300 yards are rejected by PathGenerator itself: MAX_POINT_PATH_LENGTH * SMOOTH_PATH_STEP_SIZE)
    // the straight line crosses the plateau, so the path has to go around it
    const path = new PathGenerator(fakeSource(map, [700, 800, 10], null, 999));
    expect(path.calculatePath(900, 800, 10, false)).toBe(true);
    expect(path.getPathType() & PATHFIND_NORMAL).toBe(PATHFIND_NORMAL);
    expect(path.getPath().length).toBeGreaterThanOrEqual(2);
    const end = path.getActualEndPosition();
    expect(Math.hypot(end.x - 900, end.y - 800)).toBeLessThan(2);
    for (const p of path.getPath()) expect(Math.abs(p.z - 10)).toBeLessThan(4);
    expect(path.getPathLength()).toBeGreaterThan(230); // longer than the 200 units of the blocked straight line
  });

  test("buildMaps with worker threads builds the queued tiles and skips up to date ones", async () => {
    await Bun.write(MAP_FILE_NAME_FORMAT(join(dir, "maps"), 998, 30, 31), terrainTile(5));
    await Bun.write(MAP_FILE_NAME_FORMAT(join(dir, "maps"), 998, 31, 31), terrainTile(7));
    const config = await makeConfig();
    const builder = new MapBuilder(config, 998, 2);
    await builder.buildMaps(998);
    expect(existsSync(join(dir, "mmaps/998.mmap"))).toBe(true);
    expect(existsSync(join(dir, "mmaps/9983031.mmtile"))).toBe(true);
    expect(existsSync(join(dir, "mmaps/9983131.mmtile"))).toBe(true);
    expect(builder.m_totalTilesProcessed).toBe(2);
    expect(builder.currentPercentageDone()).toBe(100);
  }, 120_000);
});
