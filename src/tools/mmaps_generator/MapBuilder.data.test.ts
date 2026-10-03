/**
 * Real data check: builds the Northshire tile of Eastern Kingdoms (tile 32,48) from `data/maps` and `data/vmaps` into a
 * temporary directory (symlinks to the real data, new `mmaps/`), loads it with `MMapMgr` and walks it with
 * `PathGenerator`. Skipped when the extracted data is missing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MMAP_MAGIC, MmapTileHeader, SIZEOF_MMAP_TILE_HEADER } from "../../common/Collision/Management/MMapDefines.ts";
import { MMapMgr } from "../../common/Collision/Management/MMapMgr.ts";
import { dtMeshHeader } from "../../common/Detour/DetourNavMesh.ts";
import { PathGenerator, PATHFIND_NORMAL } from "../../game/Movement/MovementGenerators/PathGenerator.ts";
import { fakeMap, fakeSource } from "../../game/Movement/MovementGenerators/test-path-source.ts";
import { Config } from "./Config.ts";
import { MapBuilder } from "./MapBuilder.ts";

const dataDir = join(import.meta.dir, "../../../data");
const hasData = existsSync(join(dataDir, "maps/0004832.map")) && existsSync(join(dataDir, "vmaps/000.vmtree")) && existsSync(join(dataDir, "vmaps/000_32_48.vmtile"));

describe.skipIf(!hasData)("mmaps for Northshire (map 0, tile 32,48)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmaps-data-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("builds the tile, loads it and finds paths on it", async () => {
    symlinkSync(join(dataDir, "maps"), join(dir, "maps"));
    symlinkSync(join(dataDir, "vmaps"), join(dir, "vmaps"));
    const configFile = join(dir, "mmaps-config.yaml");
    await Bun.write(configFile, (await Bun.file(join(import.meta.dir, "mmaps-config.yaml")).text()).replace('dataDir: "data"', `dataDir: "${dir}"`));
    const config = (await Config.FromFile(configFile))!;

    const t0 = Date.now();
    await new MapBuilder(config, 0, 1).buildSingleTile(0, 32, 48);
    console.log(`Northshire tile built in ${Date.now() - t0} ms`);

    // tile file name is MMM + tileY + tileX: the runtime loads it as grid (48, 32)
    const bytes = new Uint8Array(await Bun.file(join(dir, "mmaps/0004832.mmtile")).arrayBuffer());
    const header = MmapTileHeader.fromBytes(bytes)!;
    expect(header.mmapMagic).toBe(MMAP_MAGIC);
    expect(header.size).toBe(bytes.length - SIZEOF_MMAP_TILE_HEADER);
    expect(header.recastConfig.equals(config.GetConfigForTile(0, 32, 48).toMMAPTileRecastConfig())).toBe(true);
    expect(header.recastConfig.tilesPerMapEdge).toBe(25);

    MMapMgr.setDataDir(dir);
    const nav = MMapMgr.loadNavMesh(0)!;
    expect(nav).not.toBeNull();
    expect(MMapMgr.loadTile(nav, 0, 48, 32)).toBe(true);
    const tile = nav.getTile(0)!;
    const h = tile.header as dtMeshHeader;
    expect(h.polyCount).toBeGreaterThan(1000);
    // the tile covers x in [-9066.7, -8533.3], y in [-533.3, 0]
    expect(h.bmin[0]).toBeCloseTo(-533.3333, 2);
    expect(h.bmax[0]).toBeCloseTo(0, 2);
    expect(h.bmin[2]).toBeCloseTo(-9066.6667, 2);
    expect(h.bmax[2]).toBeCloseTo(-8533.3333, 2);

    const map = fakeMap({ navMesh: nav, query: MMapMgr.createNavMeshQuery(nav)! });
    // human start position in front of Northshire Abbey to the abbey area, and to a spot west of the start
    for (const dest of [[-8913.23, -135, 84], [-8900, -90, 90], [-9000, -100, 90]] as const) {
      const path = new PathGenerator(fakeSource(map, [-8949.95, -132.493, 83.5312], null, 0));
      expect(path.calculatePath(dest[0], dest[1], dest[2], false)).toBe(true);
      expect(path.getPathType()).toBe(PATHFIND_NORMAL);
      expect(path.getPath().length).toBeGreaterThan(5);
      // the walked terrain stays near the ground the destinations were taken from
      for (const p of path.getPath()) expect(p.z).toBeGreaterThan(70);
      expect(Math.hypot(path.getActualEndPosition().x - dest[0], path.getActualEndPosition().y - dest[1])).toBeLessThan(2);
    }
  }, 120_000);
});
