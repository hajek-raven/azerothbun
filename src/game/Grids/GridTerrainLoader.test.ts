import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GridTerrainData, INVALID_HEIGHT } from "./GridTerrainData.ts";
import { buildMapFile } from "./GridTerrainData.test-util.ts";
import {
  clearSharedGridTerrainData,
  getSharedGridTerrainData,
  GridTerrainLoader,
  GridTerrainLoaderHooks,
  mapFileName,
  type GridTerrainCoord,
  type GridTerrainLoaderGrid,
  type GridTerrainLoaderMap,
} from "./GridTerrainLoader.ts";

let dir: string;
const original = { ...GridTerrainLoaderHooks };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wow-ts-terrain-loader-"));
  mkdirSync(join(dir, "maps"));
  GridTerrainLoaderHooks.getDataPath = () => `${dir}/`;
});

afterEach(() => {
  clearSharedGridTerrainData();
  GridTerrainLoaderHooks.getVMapMgr = original.getVMapMgr;
  GridTerrainLoaderHooks.onLoadGridMap = original.onLoadGridMap;
});

afterAll(() => {
  Object.assign(GridTerrainLoaderHooks, original);
  rmSync(dir, { recursive: true, force: true });
});

class FakeGrid implements GridTerrainLoaderGrid {
  terrain: GridTerrainData | null = null;
  constructor(
    private readonly x: number,
    private readonly y: number,
  ) {}
  getX(): number {
    return this.x;
  }
  getY(): number {
    return this.y;
  }
  getTerrainData(): GridTerrainData | null {
    return this.terrain;
  }
  setTerrainData(terrainData: GridTerrainData | null): void {
    this.terrain = terrainData;
  }
}

class FakeMap implements GridTerrainLoaderMap {
  vmapTiles: [number, number][] = [];
  mmapTiles: [number, number][] = [];
  grids = new Map<string, FakeGrid>();
  constructor(
    readonly id: number,
    readonly instanceId = 0,
    readonly parent: FakeMap | null = null,
  ) {}
  getInstanceId(): number {
    return this.instanceId;
  }
  getId(): number {
    return this.id;
  }
  getMapName(): string {
    return `Map${this.id}`;
  }
  getParent(): { getGridTerrainDataSharedPtr(gridCoord: GridTerrainCoord): GridTerrainData | null } {
    return this.parent ?? this;
  }
  getGridTerrainDataSharedPtr(gridCoord: GridTerrainCoord): GridTerrainData | null {
    return this.grids.get(`${gridCoord.x_coord},${gridCoord.y_coord}`)?.terrain ?? null;
  }
  getMapCollisionData(): { loadVMapTile(x: number, y: number): number; loadMMapTile(x: number, y: number): number } {
    return {
      loadVMapTile: (x, y) => (this.vmapTiles.push([x, y]), 1),
      loadMMapTile: (x, y) => (this.mmapTiles.push([x, y]), 1),
    };
  }
  grid(x: number, y: number): FakeGrid {
    let grid = this.grids.get(`${x},${y}`);
    if (!grid) this.grids.set(`${x},${y}`, (grid = new FakeGrid(x, y)));
    return grid;
  }
}

async function writeGrid(mapId: number, x: number, y: number, height: number): Promise<void> {
  const V9 = new Float32Array(129 * 129).fill(height);
  const V8 = new Float32Array(128 * 128).fill(height);
  await Bun.write(mapFileName(mapId, x, y), buildMapFile({ height: { V9, V8, encoding: "flat" }, areaIds: new Uint16Array(256).fill(9) }));
}

describe("mapFileName", () => {
  test("DataDir/maps/MMMXXYY.map", () => {
    expect(mapFileName(0, 31, 32)).toBe(`${dir}/maps/0003132.map`);
    expect(mapFileName(571, 5, 7)).toBe(`${dir}/maps/5710507.map`);
    GridTerrainLoaderHooks.getDataPath = () => dir; // a DataDir without the trailing slash
    expect(mapFileName(1, 2, 3)).toBe(`${dir}/maps/0010203.map`);
    GridTerrainLoaderHooks.getDataPath = () => `${dir}/`;
  });
});

describe("GridTerrainLoader::LoadTerrain", () => {
  test("loads the .map, then the vmap and mmap tile of a base map", async () => {
    await writeGrid(1, 31, 32, 81.5);
    const map = new FakeMap(1);
    const grid = map.grid(31, 32);
    const hooked: unknown[][] = [];
    GridTerrainLoaderHooks.onLoadGridMap = (m, terrain, x, y) => hooked.push([m, terrain, x, y]);

    new GridTerrainLoader(grid, map).loadTerrain();

    expect(grid.terrain).toBeInstanceOf(GridTerrainData);
    expect(grid.terrain!.getHeight(0, 0)).toBe(81.5);
    expect(grid.terrain!.getArea(0, 0)).toBe(9);
    expect(map.vmapTiles).toEqual([[31, 32]]);
    expect(map.mmapTiles).toEqual([[31, 32]]);
    expect(hooked).toEqual([[map, grid.terrain, 31, 32]]);
  });

  test("a missing file leaves the grid without terrain but still runs the hook and the tile loads", () => {
    const map = new FakeMap(2);
    const grid = map.grid(1, 1);
    const hooked: unknown[][] = [];
    GridTerrainLoaderHooks.onLoadGridMap = (_m, terrain, x, y) => hooked.push([terrain, x, y]);

    new GridTerrainLoader(grid, map).loadTerrain();

    expect(grid.terrain).toBeNull();
    expect(hooked).toEqual([[null, 1, 1]]);
    expect(map.vmapTiles).toEqual([[1, 1]]);
    expect(map.mmapTiles).toEqual([[1, 1]]);
  });

  test("a file with the wrong version is not used", async () => {
    const bytes = buildMapFile({ areaIds: new Uint16Array(256).fill(1) });
    bytes[4] = 8;
    await Bun.write(mapFileName(3, 2, 2), bytes);
    const map = new FakeMap(3);
    const grid = map.grid(2, 2);
    new GridTerrainLoader(grid, map).loadTerrain();
    expect(grid.terrain).toBeNull();
  });

  test("two Map objects of one map id share the data of a grid", async () => {
    await writeGrid(4, 10, 11, 5);
    const first = new FakeMap(4);
    const second = new FakeMap(4);
    new GridTerrainLoader(first.grid(10, 11), first).loadTerrain();
    new GridTerrainLoader(second.grid(10, 11), second).loadTerrain();
    expect(first.grid(10, 11).terrain).not.toBeNull();
    expect(second.grid(10, 11).terrain).toBe(first.grid(10, 11).terrain!);
    expect(getSharedGridTerrainData(mapFileName(4, 10, 11))).toBe(first.grid(10, 11).terrain!);
  });

  test("different grids and maps do not share", async () => {
    await writeGrid(5, 1, 1, 1);
    await writeGrid(5, 1, 2, 2);
    await writeGrid(6, 1, 1, 3);
    const a = new FakeMap(5);
    const b = new FakeMap(6);
    new GridTerrainLoader(a.grid(1, 1), a).loadTerrain();
    new GridTerrainLoader(a.grid(1, 2), a).loadTerrain();
    new GridTerrainLoader(b.grid(1, 1), b).loadTerrain();
    expect(a.grid(1, 1).terrain!.getHeight(0, 0)).toBe(1);
    expect(a.grid(1, 2).terrain!.getHeight(0, 0)).toBe(2);
    expect(b.grid(1, 1).terrain!.getHeight(0, 0)).toBe(3);
  });

  test("an instance map points at the parent map's data and loads nothing itself", async () => {
    await writeGrid(7, 8, 9, 42);
    const parent = new FakeMap(7);
    new GridTerrainLoader(parent.grid(8, 9), parent).loadTerrain();
    const hooked: unknown[] = [];
    GridTerrainLoaderHooks.onLoadGridMap = () => hooked.push(1);

    const instance = new FakeMap(7, 12, parent);
    const grid = instance.grid(8, 9);
    new GridTerrainLoader(grid, instance).loadTerrain();

    expect(grid.terrain).toBe(parent.grid(8, 9).terrain!);
    expect(instance.vmapTiles).toEqual([]);
    expect(instance.mmapTiles).toEqual([]);
    expect(hooked).toEqual([]);
  });

  test("an instance of a grid the parent has no terrain for gets none", () => {
    const parent = new FakeMap(8);
    const instance = new FakeMap(8, 3, parent);
    const grid = instance.grid(0, 0);
    new GridTerrainLoader(grid, instance).loadTerrain();
    expect(grid.terrain).toBeNull();
  });

  test("clearSharedGridTerrainData makes the next load read the file again", async () => {
    await writeGrid(9, 3, 3, 7);
    const map = new FakeMap(9);
    new GridTerrainLoader(map.grid(3, 3), map).loadTerrain();
    const first = map.grid(3, 3).terrain;
    clearSharedGridTerrainData();
    const other = new FakeMap(9);
    new GridTerrainLoader(other.grid(3, 3), other).loadTerrain();
    expect(other.grid(3, 3).terrain).not.toBe(first);
    expect(other.grid(3, 3).terrain!.getHeight(0, 0)).toBe(7);
  });
});

describe("GridTerrainLoader::ExistMap", () => {
  test("true for a current map file", async () => {
    await writeGrid(20, 1, 2, 0);
    expect(GridTerrainLoader.existMap(20, 1, 2)).toBe(true);
  });

  test("false for a missing file", () => {
    expect(GridTerrainLoader.existMap(21, 1, 2)).toBe(false);
  });

  test("false for a short file, a wrong magic and a wrong version", async () => {
    await Bun.write(mapFileName(22, 0, 0), new Uint8Array(10));
    expect(GridTerrainLoader.existMap(22, 0, 0)).toBe(false);
    await Bun.write(mapFileName(22, 0, 1), new Uint8Array(0));
    expect(GridTerrainLoader.existMap(22, 0, 1)).toBe(false);

    const badMagic = buildMapFile({});
    badMagic[1] = 0;
    await Bun.write(mapFileName(22, 0, 2), badMagic);
    expect(GridTerrainLoader.existMap(22, 0, 2)).toBe(false);

    const badVersion = buildMapFile({});
    badVersion[4] = 7;
    await Bun.write(mapFileName(22, 0, 3), badVersion);
    expect(GridTerrainLoader.existMap(22, 0, 3)).toBe(false);
  });
});

describe("GridTerrainLoader::ExistVMap", () => {
  const vmgr = (loading: boolean, result: number) => ({
    isMapLoadingEnabled: () => loading,
    existsMap: () => result,
    getDirFileName: (mapId: number, x: number, y: number) => `${mapId}_${x}_${y}.vmtile`,
  });

  test("true without a vmap manager or with loading disabled", () => {
    expect(GridTerrainLoader.existVMap(0, 1, 1)).toBe(true);
    GridTerrainLoaderHooks.getVMapMgr = () => vmgr(false, 1);
    expect(GridTerrainLoader.existVMap(0, 1, 1)).toBe(true);
  });

  test("follows VMAP::LoadResult", () => {
    GridTerrainLoaderHooks.getVMapMgr = () => vmgr(true, 0);
    expect(GridTerrainLoader.existVMap(0, 1, 1)).toBe(true);
    GridTerrainLoaderHooks.getVMapMgr = () => vmgr(true, 1); // FileNotFound
    expect(GridTerrainLoader.existVMap(0, 1, 1)).toBe(false);
    GridTerrainLoaderHooks.getVMapMgr = () => vmgr(true, 2); // VersionMismatch
    expect(GridTerrainLoader.existVMap(0, 1, 1)).toBe(false);
  });
});

test("INVALID_HEIGHT is what a grid without terrain answers", () => {
  expect(new GridTerrainData().getHeight(0, 0)).toBe(INVALID_HEIGHT);
});
