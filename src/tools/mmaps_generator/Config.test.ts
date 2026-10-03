import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeBaseUnitDim, Config, GRID_SIZE } from "./Config.ts";

const dir = mkdtempSync(join(tmpdir(), "mmaps-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function load(yaml: string, name = "cfg.yaml"): Promise<Config | null> {
  const path = join(dir, name);
  await Bun.write(path, yaml);
  return Config.FromFile(path);
}

const f32 = Math.fround;

describe("Config", () => {
  test("the shipped mmaps-config.yaml loads with the AzerothCore values", async () => {
    const config = (await Config.FromFile(join(import.meta.dir, "mmaps-config.yaml")))!;
    expect(config).not.toBeNull();
    expect(config.ShouldSkipJunkMaps()).toBe(true);
    expect(config.ShouldSkipLiquid()).toBe(false);
    expect(config.ShouldSkipContinents()).toBe(false);
    expect(config.ShouldSkipBattlegrounds()).toBe(false);
    expect(config.IsDebugOutputEnabled()).toBe(false);
    expect(config.OffMeshConnections()).toHaveLength(2);
    expect(config.OffMeshConnections()[0]).toBe("562 31,20 (6234.474121 256.563721 11.063726) (6230.162598 251.681976 11.199670) 2.1");
    expect(config.MapsPath()).toBe(`${config.DataDirPath()}/maps`);

    const cfg = config.GetConfigForTile(0, 32, 48);
    expect(cfg.walkableSlopeAngle).toBe(60);
    expect(cfg.walkableRadius).toBe(2);
    expect(cfg.walkableHeight).toBe(6);
    expect(cfg.walkableClimb).toBe(6);
    expect(cfg.vertexPerMapEdge).toBe(2000);
    expect(cfg.vertexPerTileEdge).toBe(80);
    expect(cfg.tilesPerMapEdge).toBe(25);
    expect(cfg.baseUnitDim).toBe(f32(GRID_SIZE / 2000));
    expect(cfg.cellSizeHorizontal).toBe(cfg.baseUnitDim);
    expect(cfg.cellSizeVertical).toBe(cfg.baseUnitDim);
    expect(cfg.maxSimplificationError).toBe(f32(1.8));

    // map override: Blackfathom Deeps has a taller vertical cell
    expect(config.GetConfigForTile(48, 1, 1).cellSizeVertical).toBe(f32(0.5334));
    expect(config.GetConfigForTile(48, 1, 1).cellSizeHorizontal).toBe(cfg.baseUnitDim);
  });

  test("a file without mmapsConfig or a missing file is rejected", async () => {
    expect(await load("something: 1\n")).toBeNull();
    expect(await Config.FromFile(join(dir, "does-not-exist.yaml"))).toBeNull();
  });

  test("defaults of the C++ member initializers apply to missing keys", async () => {
    const config = (await load("mmapsConfig:\n  dataDir: x\n  meshSettings: {}\n"))!;
    const cfg = config.GetConfigForTile(1, 2, 3);
    expect(cfg.walkableSlopeAngle).toBe(60);
    expect(cfg.walkableRadius).toBe(2);
    expect(cfg.walkableHeight).toBe(6);
    expect(cfg.walkableClimb).toBe(6);
    expect(cfg.vertexPerMapEdge).toBe(2000);
    expect(cfg.vertexPerTileEdge).toBe(80);
    expect(config.OffMeshConnections()).toEqual([]);
    expect(config.DataDirPath()).toBe("x");
    expect(config.VMapsPath()).toBe("x/vmaps");
    expect(config.MMapsPath()).toBe("x/mmaps");
  });

  test("overrides cascade global, map, tile; the tile key is looked up as (tileY, tileX)", async () => {
    const config = (await load(`
mmapsConfig:
  dataDir: d
  meshSettings:
    walkableSlopeAngle: 50
    walkableClimb: 4
    verticesPerMapEdge: 1000
    verticesPerTileEdge: 50
    mapsOverrides:
      "7":
        walkableRadius: 5
        verticesPerMapEdge: 500
        cellSizeHorizontal: 0.5
        tilesOverrides:
          "10,20":
            walkableSlopeAngle: 70
            walkableClimb: 1
`))!;
    // no override: global values
    const g = config.GetConfigForTile(8, 10, 20);
    expect([g.walkableSlopeAngle, g.walkableClimb, g.walkableRadius, g.vertexPerMapEdge]).toEqual([50, 4, 2, 1000]);
    expect(g.tilesPerMapEdge).toBe(20);

    // map override
    const m = config.GetConfigForTile(7, 1, 1);
    expect([m.walkableSlopeAngle, m.walkableClimb, m.walkableRadius, m.vertexPerMapEdge, m.vertexPerTileEdge]).toEqual([50, 4, 5, 500, 50]);
    expect(m.cellSizeHorizontal).toBe(0.5);
    expect(m.cellSizeVertical).toBe(ComputeBaseUnitDim(500));
    expect(m.tilesPerMapEdge).toBe(10);

    // the key "10,20" is stored as (10, 20) and looked up with (tileY, tileX): GetConfigForTile(map, tileX=20, tileY=10)
    const t = config.GetConfigForTile(7, 20, 10);
    expect([t.walkableSlopeAngle, t.walkableClimb, t.walkableRadius]).toEqual([70, 1, 5]);
    const notT = config.GetConfigForTile(7, 10, 20);
    expect(notT.walkableSlopeAngle).toBe(50);
  });

  test("toMMAPTileRecastConfig carries every field", async () => {
    const config = (await Config.FromFile(join(import.meta.dir, "mmaps-config.yaml")))!;
    const cfg = config.GetConfigForTile(0, 0, 0);
    const r = cfg.toMMAPTileRecastConfig();
    expect(r.walkableSlopeAngle).toBe(60);
    expect(r.walkableRadius).toBe(2);
    expect(r.walkableHeight).toBe(6);
    expect(r.walkableClimb).toBe(6);
    expect(r.vertexPerMapEdge).toBe(2000);
    expect(r.vertexPerTileEdge).toBe(80);
    expect(r.tilesPerMapEdge).toBe(25);
    expect(r.baseUnitDim).toBe(cfg.baseUnitDim);
    expect(r.maxSimplificationError).toBe(f32(1.8));
    expect(r.equals(cfg.toMMAPTileRecastConfig())).toBe(true);
  });
});
