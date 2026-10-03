/**
 * `Map` over the real extracted client data in `data/` (`dbc`, `maps`, `vmaps`, `mmaps`): terrain heights, areas, liquids,
 * the vmap floors of Stormwind, line of sight, and a collision checked move over the mmap nav mesh. Skips itself when the
 * data is not there.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MMapMgr } from "../../common/Collision/Management/MMapMgr.ts";
import { VMapFactory } from "../../common/Collision/Management/VMapFactory.ts";
import { loadDBCStores } from "../DataStores/DBCStores.ts";
import { GetLiquidFlags } from "../DataStores/MapDBCStores.ts";
import { FakePlayer } from "../Grids/Grids.test-util.ts";
import { clearSharedGridTerrainData, GridTerrainLoaderHooks } from "../Grids/GridTerrainLoader.ts";
import { LIQUID_MAP_IN_WATER, LIQUID_MAP_NO_WATER, MAP_LIQUID_TYPE_WATER } from "../Grids/GridTerrainData.ts";
import { LINEOFSIGHT_ALL_CHECKS, ModelIgnoreFlags } from "../Grids/MapLike.ts";
import { Map } from "./Map.ts";

const data = join(process.cwd(), "data");
const available = ["dbc/Map.dbc", "maps/0003434.map", "vmaps/000.vmtree", "mmaps/000.mmap"].every((f) => existsSync(join(data, f)));

/** A player with the unit members `PathGenerator` reads (the real `Unit` is not ported yet). */
class PathingPlayer extends FakePlayer {
  canSwim(): boolean {
    return true;
  }
  override hasUnitState(): boolean {
    return false;
  }
  isFalling(): boolean {
    return false;
  }
  isUnderWater(): boolean {
    return false;
  }
  override getCollisionHeight(): number {
    return 2;
  }
}

describe.skipIf(!available)("Map over the extracted client data", () => {
  const savedPath = GridTerrainLoaderHooks.getDataPath;
  let map: Map;

  beforeAll(async () => {
    await loadDBCStores(join(data, "dbc"));
    GridTerrainLoaderHooks.getDataPath = () => "data/";
    MMapMgr.setDataDir("data");
    VMapFactory.createOrGetVMapMgr().GetLiquidFlagsPtr = GetLiquidFlags;
    clearSharedGridTerrainData();
    // Eastern Kingdoms
    map = new Map(0, 0, 0);
    expect(map.getMapCollisionData().getStaticTreeSharedPtr()).not.toBeNull();
    expect(map.getMapCollisionData().getMMapData().getNavMesh()).not.toBeNull();
  });

  afterAll(() => {
    map.unloadAll();
    GridTerrainLoaderHooks.getDataPath = savedPath;
    clearSharedGridTerrainData();
  });

  test("Goldshire: ground near 56 in the Goldshire area of Elwynn Forest", () => {
    const x = -9464;
    const y = 64;
    map.loadGrid(x, y);
    expect(map.isGridLoaded(x, y)).toBe(true);
    const height = map.getHeight(1, x, y, 300);
    expect(Math.abs(height - 56)).toBeLessThan(2);
    expect(map.getAreaId(1, x, y, height + 1)).toBe(87);
    expect(map.getZoneId(1, x, y, height + 1)).toBe(12);
    expect(map.getZoneAndAreaId(1, x, y, height + 1)).toEqual({ zoneid: 12, areaid: 87 });
    expect(map.getLiquidData(1, x, y, height + 1, 2).Status).toBe(LIQUID_MAP_NO_WATER);
    const status = map.getFullTerrainStatusForPosition(1, x, y, height + 1, 2);
    expect(status.areaId).toBe(87);
    expect(status.outdoors).toBe(true);
    expect(status.floorZ).toBeCloseTo(height, 3);
  });

  test("Northshire: the Northshire Valley area, ground near 81", () => {
    const x = -8914;
    const y = -133;
    map.loadGrid(x, y);
    const height = map.getHeight(1, x, y, 300);
    expect(height).toBeGreaterThan(75);
    expect(height).toBeLessThan(86);
    expect(map.getAreaId(1, x, y, height + 1)).toBe(9);
    expect(map.getZoneId(1, x, y, height + 1)).toBe(12);
  });

  test("a lake in Elwynn Forest is water: swimming, with its level and depth", () => {
    const x = -8535.4;
    const y = -460.4;
    map.loadGrid(x, y);
    const ground = map.getHeight(1, x, y, 300);
    const liquid = map.getLiquidData(1, x, y, ground + 0.5, 2);
    expect(liquid.Status).toBe(LIQUID_MAP_IN_WATER);
    expect(liquid.Flags & MAP_LIQUID_TYPE_WATER).toBe(MAP_LIQUID_TYPE_WATER);
    expect(liquid.Level).toBeGreaterThan(ground);
    expect(liquid.DepthLevel).toBeCloseTo(ground, 3);
    expect(map.isInWater(1, x, y, ground + 0.5, 2)).toBe(true);
    expect(map.getWaterLevel(x, y)).toBeCloseTo(liquid.Level, 3);
    expect(map.getWaterOrGroundLevel(1, x, y, ground + 0.5)).toBeCloseTo(liquid.Level, 3);
  });

  test("Stormwind: the city floor from the vmaps is above the terrain under it", () => {
    const x = -8830;
    const y = 636;
    map.loadGrid(x, y);
    const terrain = map.getHeightNoPhase(x, y, 300, false);
    const floor = map.getFullTerrainStatusForPosition(1, x, y, 100, 2).floorZ;
    expect(map.getAreaId(1, x, y, 100)).toBe(1519);
    expect(floor).toBeGreaterThan(terrain + 20);
    // looking down from above the city finds the city floor, not the terrain
    expect(map.getHeightNoPhase(x, y, 100)).toBeCloseTo(floor, 2);
  });

  test("line of sight across open ground, and through the ground", () => {
    const x = -9464;
    const y = 64;
    map.loadGrid(x, y);
    const z = map.getHeight(1, x, y, 300) + 2;
    expect(map.isInLineOfSight(x, y, z, x + 24, y, z, 1, LINEOFSIGHT_ALL_CHECKS, ModelIgnoreFlags.Nothing)).toBe(true);
    expect(map.getGameObjectFloor(1, x, y, z)).toBe(-Infinity);
  });

  test("a collision checked move over open ground keeps its destination and lands on the ground", () => {
    const x = -9464;
    const y = 64;
    map.loadGrid(x, y);
    map.loadGrid(x + 14, y);
    const z = map.getHeight(1, x, y, 300);
    const walker = new PathingPlayer(1, x, y, z);
    walker.setMap(map);
    const dest = { x: x + 14, y, z };
    expect(map.checkCollisionAndGetValidCoords(walker, x, y, z, dest, true)).toBe(true);
    expect(dest.x).toBeCloseTo(x + 14, 1);
    expect(dest.y).toBeCloseTo(y, 1);
    expect(Math.abs(dest.z - map.getHeight(1, dest.x, dest.y, 300))).toBeLessThan(2);

    const next = { x: x + 14, y: y + 6, z };
    expect(map.canReachPositionAndGetValidCoords(walker, x, y, z, next, true, true)).toBe(true);
    // a point outside the map is refused
    expect(map.checkCollisionAndGetValidCoords(walker, x, y, z, { x: 1e9, y, z }, true)).toBe(false);
  });
});
