/**
 * The terrain, area, liquid, height, and line of sight side of `Map`, over a `.map` file written by the test helper and the
 * vmap house of the Collision fixtures (one `StaticMapTree` per map through `MapCollisionData`).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { VMapMgr2 } from "../../common/Collision/Management/VMapMgr2.ts";
import { ModelFlags } from "../../common/Collision/Models/ModelInstance.ts";
import { TileAssembler } from "../../common/Collision/Maps/TileAssembler.ts";
import {
  crateMesh,
  dirBinBytes,
  HOUSE_GROUP_ID,
  HOUSE_ROOT_WMO_ID,
  houseRawGroups,
  makeTempDir,
  rawM2Bytes,
  rawModelBytes,
} from "../../common/Collision/test-fixtures.ts";
import { sAreaTableStore, sLiquidTypeStore, sWMOAreaTableStore } from "../DataStores/DBCStores.ts";
import { resetMapDBCStores } from "../DataStores/MapDBCStores.ts";
import { clearSharedGridTerrainData, GridTerrainLoaderHooks } from "../Grids/GridTerrainLoader.ts";
import {
  INVALID_HEIGHT,
  LIQUID_MAP_ABOVE_WATER,
  LIQUID_MAP_IN_WATER,
  LIQUID_MAP_NO_WATER,
  LIQUID_MAP_UNDER_WATER,
  MAP_LIQUID_TYPE_WATER,
} from "../Grids/GridTerrainData.ts";
import { buildMapFile } from "../Grids/GridTerrainData.test-util.ts";
import { LINEOFSIGHT_ALL_CHECKS, LINEOFSIGHT_CHECK_VMAP, ModelIgnoreFlags } from "../Grids/MapLike.ts";
import { Map } from "./Map.ts";
import { MAP_COMMON, setMapEntry } from "./Map.test-util.ts";

const tmp = makeTempDir("map-terrain-test-");
const raw = join(tmp.dir, "Buildings");
const vmaps = join(tmp.dir, "vmaps");
const savedPath = GridTerrainLoaderHooks.getDataPath;

/** House 1 of the Collision fixtures: unrotated, internal (vmap) coordinates. */
const P1 = { x: 16900, y: 16800, z: 50 };
const HOUSE = "mt_house.wmo";
const CRATE = "mt_crate.m2";

/** vmap internal coordinates to world coordinates (the conversion is its own inverse). */
function world(x: number, y: number, z: number): [number, number, number] {
  const v = VMapMgr2.convertPositionToInternalRep(x, y, z);
  return [v.x, v.y, v.z];
}

/** A point inside the house, 2 above its floor (the liquid grid at P1.z + 1 covers it). */
const [HX, HY, HZ] = world(P1.x + 1, P1.y + 1, P1.z + 2);
/** A point outside the house, on open ground of the same grid. */
const [OX, OY] = world(P1.x + 60, P1.y + 40, 0);

const GROUND = 40;
const AREA = 12;
const ZONE = 9;
const HOUSE_AREA = 77;

let map: Map;

beforeAll(async () => {
  mkdirSync(raw);
  mkdirSync(join(tmp.dir, "maps"));
  await Bun.write(join(raw, HOUSE), rawModelBytes(HOUSE_ROOT_WMO_ID, houseRawGroups()));
  await Bun.write(join(raw, CRATE), rawM2Bytes(crateMesh()));
  await Bun.write(
    join(raw, "dir_bin"),
    dirBinBytes([
      { mapID: 0, tileX: 31, tileY: 32, flags: ModelFlags.MOD_HAS_BOUND, adtId: 7, uniqueId: 1, pos: [P1.x, P1.y, P1.z], rot: [0, 0, 0], scale: 1, bound: [[P1.x, P1.y, P1.z], [P1.x + 22, P1.y + 10, P1.z + 5]], name: HOUSE },
    ]),
  );
  const quiet = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await new TileAssembler(raw, vmaps).convertWorld2()).toBe(true);
  } finally {
    quiet.mockRestore();
  }

  // grid (31, 31) of map 0: flat ground at 40, area 12, water at level 60 (the `lake` of the terrain tests)
  const V9 = new Float32Array(129 * 129).fill(GROUND);
  const V8 = new Float32Array(128 * 128).fill(GROUND);
  await Bun.write(
    join(tmp.dir, "maps", "0003131.map"),
    buildMapFile({
      areaIds: new Uint16Array(256).fill(AREA),
      height: { V9, V8, encoding: "flat" },
      liquid: { liquidType: 1, liquidFlags: MAP_LIQUID_TYPE_WATER, offsetX: 0, offsetY: 0, width: 128, height: 128, liquidLevel: 60 },
    }),
  );

  GridTerrainLoaderHooks.getDataPath = () => `${tmp.dir}/`;
  clearSharedGridTerrainData();
  sLiquidTypeStore.set(1, { Id: 1, Type: 0, SpellId: 0 });
  sLiquidTypeStore.set(13, { Id: 13, Type: 1, SpellId: 0 });
  const area = (ID: number, zone: number, flags = 0) => sAreaTableStore.set(ID, { ID, mapid: 0, zone, exploreFlag: 0, flags, area_level: 0, area_name: [], team: 0, LiquidTypeOverride: [0, 0, 0, 0] });
  area(ZONE, 0);
  area(AREA, ZONE);
  area(HOUSE_AREA, ZONE);
  sWMOAreaTableStore.set(1, { Id: 1, rootId: HOUSE_ROOT_WMO_ID, adtId: 7, groupId: HOUSE_GROUP_ID, Flags: 0, areaId: HOUSE_AREA });
  resetMapDBCStores();

  setMapEntry(0, MAP_COMMON, { linked_zone: 1519 });
  map = new Map(0, 0, 0);
  // the grid with the terrain, and the vmap tile of the house (the vmap tile files are named by tile, not by grid)
  map.loadGrid(OX, OY);
  expect(map.getMapCollisionData().loadVMapTile(32, 31)).toBe(1);
});

afterAll(() => {
  map.unloadAll();
  GridTerrainLoaderHooks.getDataPath = savedPath;
  clearSharedGridTerrainData();
  tmp.cleanup();
});

describe("Map terrain", () => {
  test("the grid reads its .map file", () => {
    expect(map.getGridTerrainData(OX, OY)).not.toBeNull();
    expect(map.getGridHeight(OX, OY)).toBeCloseTo(GROUND, 3);
    // no flight bounds in the file: the minimum height is the fixed one
    expect(map.getMinHeight(OX, OY)).toBe(-500);
    expect(map.getWaterLevel(OX, OY)).toBeCloseTo(60, 3);
    // a grid without a file has no terrain
    expect(map.getGridHeight(OX + 600, OY)).toBe(INVALID_HEIGHT);
    expect(map.getWaterLevel(OX + 600, OY)).toBe(INVALID_HEIGHT);
  });

  test("GetHeight picks the .map surface or the vmap floor under z", () => {
    // open ground: the .map height when z is above it
    expect(map.getHeightNoPhase(OX, OY, 100)).toBeCloseTo(GROUND, 3);
    expect(map.getHeight(1, OX, OY, 100)).toBeCloseTo(GROUND, 3);
    // below the ground there is no surface
    expect(map.getHeightNoPhase(OX, OY, GROUND - 5)).toBe(-200000);
    // inside the house the floor (50) is above the .map ground (40)
    expect(map.getHeightNoPhase(HX, HY, HZ)).toBeCloseTo(P1.z, 3);
    expect(map.getHeight(1, HX, HY, HZ)).toBeCloseTo(P1.z, 3);
    // without the vmap check the ground is all there is
    expect(map.getHeightNoPhase(HX, HY, HZ, false)).toBeCloseTo(GROUND, 3);
    expect(map.getHeightAtPosition({ getPositionX: () => HX, getPositionY: () => HY, getPositionZ: () => HZ, getOrientation: () => 0 })).toBeCloseTo(P1.z, 3);
    // the search distance bounds the vmap look down
    expect(map.getHeightNoPhase(HX, HY, P1.z + 200, true, 10)).toBeCloseTo(GROUND, 3);
  });

  test("GetAreaId, GetZoneId, and GetZoneAndAreaId", () => {
    expect(map.getAreaId(1, OX, OY, 100)).toBe(AREA);
    expect(map.getZoneId(1, OX, OY, 100)).toBe(ZONE);
    expect(map.getZoneAndAreaId(1, OX, OY, 100)).toEqual({ zoneid: ZONE, areaid: AREA });
    // the wmo area of the house
    expect(map.getAreaId(1, HX, HY, HZ)).toBe(HOUSE_AREA);
    expect(map.getZoneAndAreaId(1, HX, HY, HZ)).toEqual({ zoneid: ZONE, areaid: HOUSE_AREA });
    // a grid without area data falls back to the linked zone of the map
    expect(map.getAreaId(1, OX + 600, OY, 100)).toBe(1519);
    // an area without an AreaTable row is its own zone
    expect(map.getZoneId(1, OX + 600, OY, 100)).toBe(1519);
  });

  test("GetAreaInfo returns the wmo ids, or nothing where there is no wmo", () => {
    const info = map.getAreaInfo(1, HX, HY, HZ);
    expect(info).toEqual({ flags: 0x2000, adtId: 7, rootId: HOUSE_ROOT_WMO_ID, groupId: HOUSE_GROUP_ID });
    expect(map.getAreaInfo(1, OX, OY, 100)).toBeNull();
  });

  test("GetLiquidData merges the wmo liquid with the grid liquid", () => {
    // open water from the .map: level 60 over ground 40
    let liquid = map.getLiquidData(1, OX, OY, 59, 2);
    expect(liquid.Status).toBe(LIQUID_MAP_IN_WATER);
    expect(liquid.Level).toBeCloseTo(60, 3);
    expect(liquid.DepthLevel).toBeCloseTo(GROUND, 3);
    expect(liquid.Entry).toBe(1);
    expect(map.getLiquidData(1, OX, OY, 100, 2).Status).toBe(LIQUID_MAP_ABOVE_WATER);
    expect(map.getLiquidData(1, OX, OY, 55, 2).Status).toBe(LIQUID_MAP_UNDER_WATER);
    // a required liquid type that is not there
    expect(map.getLiquidData(1, OX, OY, 59, 2, 0x04).Status).toBe(LIQUID_MAP_NO_WATER);
    // inside the house: the wmo liquid at P1.z + 1 (type 13 -> kind 1), and an interior wmo ignores the grid liquid
    liquid = map.getLiquidData(1, HX, HY, P1.z + 0.5, 2);
    expect(liquid.Status).toBe(LIQUID_MAP_IN_WATER);
    expect(liquid.Level).toBeCloseTo(P1.z + 1, 3);
    expect(liquid.DepthLevel).toBeCloseTo(P1.z, 3);
    expect(liquid.Entry).toBe(13);
    expect(liquid.Flags).toBe(1 << 1);
    expect(map.getLiquidData(1, HX, HY, HZ, 2).Status).toBe(LIQUID_MAP_ABOVE_WATER);
  });

  test("IsInWater, IsUnderWater, and HasEnoughWater", () => {
    expect(map.isInWater(1, OX, OY, 55, 2)).toBe(true);
    expect(map.isInWater(1, OX, OY, 100, 2)).toBe(false);
    expect(map.isUnderWater(1, OX, OY, 50, 2)).toBe(true);
    expect(map.isUnderWater(1, OX, OY, 59, 2)).toBe(false);
    const swimmer = { getPhaseMask: () => 1, getCollisionHeight: () => 2, getMinHeightInWater: () => 2 } as never;
    expect(map.hasEnoughWater(swimmer, OX, OY, 59)).toBe(true);
    const shallow = { getPhaseMask: () => 1, getCollisionHeight: () => 2, getMinHeightInWater: () => 25 } as never;
    expect(map.hasEnoughWater(shallow, OX, OY, 59)).toBe(false);
    expect(map.hasEnoughWater(swimmer, map.getLiquidData(1, OX, OY, 59, 2))).toBe(true);
    expect(map.hasEnoughWater(swimmer, OX, OY, 100)).toBe(false);
  });

  test("GetWaterOrGroundLevel is the water level in water, the ground otherwise", () => {
    const ground = { value: 0 };
    expect(map.getWaterOrGroundLevel(1, OX, OY, 55, ground)).toBeCloseTo(60, 3);
    expect(ground.value).toBeCloseTo(GROUND, 3);
    // far above the water, still above water: the higher of level and ground
    expect(map.getWaterOrGroundLevel(1, OX, OY, 100, ground)).toBeCloseTo(60, 3);
    // over a grid without data the ground is the invalid height
    expect(map.getWaterOrGroundLevel(1, OX + 600, OY, 100)).toBe(-100000);
  });

  test("GetFullTerrainStatusForPosition combines the grid, the wmo, and the liquid", () => {
    const open = map.getFullTerrainStatusForPosition(1, OX, OY, 100, 2);
    expect(open.areaId).toBe(AREA);
    expect(open.floorZ).toBeCloseTo(GROUND, 3);
    expect(open.outdoors).toBe(true);
    expect(open.liquidInfo.Status).toBe(LIQUID_MAP_ABOVE_WATER);

    const inside = map.getFullTerrainStatusForPosition(1, HX, HY, HZ, 2);
    expect(inside.areaId).toBe(HOUSE_AREA);
    expect(inside.floorZ).toBeCloseTo(P1.z, 3);
    // an interior wmo group (mogp 0x2000, no 0x8 outdoors bit)
    expect(inside.outdoors).toBe(false);
    expect(inside.liquidInfo.Level).toBeCloseTo(P1.z + 1, 3);
    expect(inside.liquidInfo.Entry).toBe(13);
    expect(inside.liquidInfo.Status).toBe(LIQUID_MAP_ABOVE_WATER);
    const swimming = map.getFullTerrainStatusForPosition(1, HX, HY, P1.z + 0.5, 2);
    expect(swimming.liquidInfo.Status).toBe(LIQUID_MAP_IN_WATER);
  });
});

describe("Map line of sight", () => {
  test("a wall of the house blocks the static check, and the check can be left out", () => {
    const [x1, y1, z1] = world(P1.x + 5, P1.y + 5, P1.z + 2);
    const [x2, y2, z2] = world(P1.x - 5, P1.y + 5, P1.z + 2);
    expect(map.isInLineOfSight(x1, y1, z1, x2, y2, z2, 1, LINEOFSIGHT_CHECK_VMAP, ModelIgnoreFlags.Nothing)).toBe(false);
    expect(map.isInLineOfSight(x1, y1, z1, x2, y2, z2, 1, LINEOFSIGHT_ALL_CHECKS, ModelIgnoreFlags.Nothing)).toBe(false);
    expect(map.isInLineOfSight(x1, y1, z1, x2, y2, z2, 1, 0, ModelIgnoreFlags.Nothing)).toBe(true);
    // open space next to the house
    const [a1, b1, c1] = world(P1.x - 5, P1.y - 5, P1.z + 2);
    const [a2, b2, c2] = world(P1.x - 5, P1.y + 20, P1.z + 2);
    expect(map.isInLineOfSight(a1, b1, c1, a2, b2, c2, 1, LINEOFSIGHT_ALL_CHECKS, ModelIgnoreFlags.Nothing)).toBe(true);
    // the same point twice is always visible
    expect(map.isInLineOfSight(x1, y1, z1, x1, y1, z1, 1, LINEOFSIGHT_ALL_CHECKS, ModelIgnoreFlags.Nothing)).toBe(true);
  });

  test("GetGameObjectFloor is the floor of the dynamic tree (empty here)", () => {
    expect(map.getGameObjectFloor(1, OX, OY, 100)).toBe(-Infinity);
    expect(map.getDynamicMapTree().size()).toBe(0);
  });
});
