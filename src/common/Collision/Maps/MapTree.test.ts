import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { Vector3 } from "../../../math/Vector3.ts";
import { LoadResult } from "../Management/IVMapMgr.ts";
import { VMapMgr2 } from "../Management/VMapMgr2.ts";
import { ModelFlags } from "../Models/ModelInstance.ts";
import { ModelIgnoreFlags } from "../Models/ModelIgnoreFlags.ts";
import type { FloatRef } from "../BoundingIntervalHierarchy.ts";
import {
  crateMesh,
  dirBinBytes,
  HOUSE_GROUP_ID,
  HOUSE_LIQUID_TYPE,
  HOUSE_MOGP,
  HOUSE_ROOT_WMO_ID,
  houseRawGroups,
  makeTempDir,
  RAMP_GROUP_ID,
  rawM2Bytes,
  rawModelBytes,
} from "../test-fixtures.ts";
import { LocationInfo, StaticMapTree } from "./MapTree.ts";
import { TileAssembler } from "./TileAssembler.ts";

const tmp = makeTempDir("maptree-test-");
const raw = join(tmp.dir, "Buildings");
const vmaps = join(tmp.dir, "vmaps");

/** House 1: unrotated. */
const P1 = new Vector3(16900, 16800, 50);
/** House 2: yawed 90 degrees, model (x, y) -> world (-y, x). */
const P2 = new Vector3(16950, 16800, 50);
/** Crate: M2 unit cube, scale 2, yaw 45 degrees. */
const P3 = new Vector3(16920, 16850, 50);
/** WDT map origin as the extractor writes it (533.33333f * 32). */
const WDT = Math.fround(Math.fround(533.33333) * 32);

const HOUSE = "mt_house.wmo";
const CRATE = "mt_crate.m2";
const WDT_HOUSE = "mt_wdt_house.wmo";

function add(a: Vector3, x: number, y: number, z: number): Vector3 {
  return new Vector3(a.x + x, a.y + y, a.z + z);
}

beforeAll(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(raw);
  await Bun.write(join(raw, HOUSE), rawModelBytes(HOUSE_ROOT_WMO_ID, houseRawGroups()));
  await Bun.write(join(raw, WDT_HOUSE), rawModelBytes(HOUSE_ROOT_WMO_ID, houseRawGroups()));
  await Bun.write(join(raw, CRATE), rawM2Bytes(crateMesh()));
  await Bun.write(
    join(raw, "dir_bin"),
    dirBinBytes([
      { mapID: 0, tileX: 31, tileY: 32, flags: ModelFlags.MOD_HAS_BOUND, adtId: 7, uniqueId: 1, pos: [P1.x, P1.y, P1.z], rot: [0, 0, 0], scale: 1, bound: [[P1.x, P1.y, P1.z], [P1.x + 22, P1.y + 10, P1.z + 5]], name: HOUSE },
      { mapID: 0, tileX: 31, tileY: 32, flags: ModelFlags.MOD_M2, adtId: 0, uniqueId: 3, pos: [P3.x, P3.y, P3.z], rot: [0, 45, 0], scale: 2, name: CRATE },
      { mapID: 0, tileX: 31, tileY: 33, flags: ModelFlags.MOD_HAS_BOUND, adtId: 8, uniqueId: 2, pos: [P2.x, P2.y, P2.z], rot: [0, 90, 0], scale: 1, bound: [[P2.x - 10, P2.y, P2.z], [P2.x, P2.y + 22, P2.z + 5]], name: HOUSE },
      { mapID: 1, tileX: 65, tileY: 65, flags: ModelFlags.MOD_HAS_BOUND | ModelFlags.MOD_WORLDSPAWN, adtId: 0, uniqueId: 10, pos: [WDT, WDT, 0], rot: [0, 0, 0], scale: 1, bound: [[0, 0, 0], [22, 10, 5]], name: WDT_HOUSE },
    ]),
  );
  const quiet = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await new TileAssembler(raw, vmaps).convertWorld2()).toBe(true);
  } finally {
    quiet.mockRestore();
  }
});

afterAll(() => tmp.cleanup());

function loadMap0(): StaticMapTree {
  const tree = new StaticMapTree(0, vmaps);
  expect(tree.InitMap(VMapMgr2.getMapFileName(0))).toBe(true);
  return tree;
}

describe("StaticMapTree", () => {
  test("file names and tile ids", () => {
    expect(VMapMgr2.getMapFileName(0)).toBe("000.vmtree");
    expect(VMapMgr2.getMapFileName(571)).toBe("571.vmtree");
    expect(StaticMapTree.getTileFileName(0, 32, 31)).toBe("000_31_32.vmtile");
    expect(StaticMapTree.packTileID(31, 32)).toBe((31 << 16) | 32);
    expect(StaticMapTree.unpackTileID(StaticMapTree.packTileID(31, 32))).toEqual([31, 32]);
  });

  test("CanLoadMap / existsMap", () => {
    const mgr = new VMapMgr2();
    expect(StaticMapTree.CanLoadMap(vmaps, 0, 32, 31)).toBe(LoadResult.Success);
    expect(mgr.existsMap(vmaps, 0, 33, 31)).toBe(LoadResult.Success);
    expect(StaticMapTree.CanLoadMap(vmaps, 0, 10, 10)).toBe(LoadResult.FileNotFound);
    expect(StaticMapTree.CanLoadMap(vmaps, 99, 32, 31)).toBe(LoadResult.FileNotFound);
    // non tiled maps load for every grid
    expect(StaticMapTree.CanLoadMap(vmaps, 1, 5, 5)).toBe(LoadResult.Success);
    expect(mgr.getDirFileName(1, 0, 0)).toBe("001.vmtree");
  });

  test("nothing collides before the tiles are loaded", () => {
    const tree = loadMap0();
    expect(tree.isTiled()).toBe(true);
    expect(tree.getHeight(add(P1, 5, 5, 2), 10)).toBe(Infinity);
    expect(tree.isInLineOfSight(add(P1, 5, 5, 2), add(P1, 50, 5, 2), ModelIgnoreFlags.Nothing)).toBe(true);
    expect(tree.GetModelInstances().count).toBe(3);
  });

  test("height, line of sight and hit position in the unrotated house", () => {
    const tree = loadMap0();
    expect(tree.LoadMapTile(32, 31)).toBe(true);
    expect(tree.numLoadedTiles()).toBe(1);

    // floor below a point inside
    expect(tree.getHeight(add(P1, 5, 5, 2), 10)).toBeCloseTo(P1.z, 3);
    // ramp at x = 17 -> z 2.5
    expect(tree.getHeight(add(P1, 17, 5, 10), 20)).toBeCloseTo(P1.z + 2.5, 3);
    // search distance too short
    expect(tree.getHeight(add(P1, 17, 5, 10), 5)).toBe(Infinity);

    // wall between inside and outside
    expect(tree.isInLineOfSight(add(P1, 5, 5, 2), add(P1, -5, 5, 2), ModelIgnoreFlags.Nothing)).toBe(false);
    // open space next to the house
    expect(tree.isInLineOfSight(add(P1, -5, -5, 2), add(P1, -5, 20, 2), ModelIgnoreFlags.Nothing)).toBe(true);
    // same point
    expect(tree.isInLineOfSight(add(P1, 5, 5, 2), add(P1, 5, 5, 2), ModelIgnoreFlags.Nothing)).toBe(true);
    // infinite distance is never in sight
    expect(tree.isInLineOfSight(add(P1, 5, 5, 2), new Vector3(Infinity, 0, 0), ModelIgnoreFlags.Nothing)).toBe(false);

    const hit = new Vector3();
    expect(tree.GetObjectHitPos(add(P1, 5, 5, 2), add(P1, -5, 5, 2), hit, -0.5)).toBe(true);
    expect(hit.x).toBeCloseTo(P1.x + 0.5, 3);
    expect(hit.y).toBeCloseTo(P1.y + 5, 3);
    expect(tree.GetObjectHitPos(add(P1, -5, -5, 2), add(P1, -5, 20, 2), hit, -0.5)).toBe(false);
    expect(hit.equals(add(P1, -5, 20, 2))).toBe(true);
  });

  test("the scaled and rotated M2 crate", () => {
    const tree = loadMap0();
    tree.LoadMapTile(32, 31);
    const c = Math.SQRT2; // cube center (1, 1) after scale 2, rotated 45 degrees -> (0, sqrt 2)
    expect(tree.getHeight(add(P3, 0, c, 10), 20)).toBeCloseTo(P3.z + 2, 3);
    // outside the rotated footprint (the unrotated corner (1.9, 0.1) is outside after the turn)
    expect(tree.getHeight(add(P3, 1.9, 0.1, 10), 20)).toBe(Infinity);
    const a = add(P3, -5, c, 1);
    const b = add(P3, 5, c, 1);
    expect(tree.isInLineOfSight(a, b, ModelIgnoreFlags.Nothing)).toBe(false);
    expect(tree.isInLineOfSight(a, b, ModelIgnoreFlags.M2)).toBe(true);
    // M2s have no area info
    const info = new LocationInfo();
    expect(tree.GetLocationInfo(add(P3, 0, c, 1), info)).toBe(false);
  });

  test("the rotated house is loaded with its own tile", () => {
    const tree = loadMap0();
    tree.LoadMapTile(32, 31);
    expect(tree.getHeight(add(P2, -5, 5, 2), 10)).toBe(Infinity);
    expect(tree.LoadMapTile(33, 31)).toBe(true);
    expect(tree.numLoadedTiles()).toBe(2);
    expect(tree.getHeight(add(P2, -5, 5, 2), 10)).toBeCloseTo(P2.z, 3);
    // the ramp now rises along world +y
    expect(tree.getHeight(add(P2, -5, 17, 10), 20)).toBeCloseTo(P2.z + 2.5, 3);
    // its walls: inside to -x (model -y... world x < P2.x - 10) is blocked; along the outside it is clear
    expect(tree.isInLineOfSight(add(P2, -5, 5, 2), add(P2, -15, 5, 2), ModelIgnoreFlags.Nothing)).toBe(false);
    expect(tree.isInLineOfSight(add(P2, 2, -2, 2), add(P2, 2, 30, 2), ModelIgnoreFlags.Nothing)).toBe(true);

    const info = new LocationInfo();
    expect(tree.GetLocationInfo(add(P2, -5, 5, 2), info)).toBe(true);
    expect(info.hitModel!.GetWmoID()).toBe(HOUSE_GROUP_ID);
    expect(info.hitInstance!.ID).toBe(2);
    expect(info.hitInstance!.adtId).toBe(8);
    expect(info.ground_Z).toBeCloseTo(P2.z, 3);

    // a missing tile is a fake load; unloading keeps the models (as in C++)
    expect(tree.LoadMapTile(1, 1)).toBe(true);
    expect(tree.numLoadedTiles()).toBe(3);
    tree.UnloadMapTile(33, 31);
    expect(tree.numLoadedTiles()).toBe(2);
    expect(tree.getHeight(add(P2, -5, 5, 2), 10)).toBeCloseTo(P2.z, 3);
    tree.UnloadMap();
    expect(tree.numLoadedTiles()).toBe(0);
  });

  test("area and liquid like MapCollisionData::GetAreaAndLiquidData, in world coordinates", () => {
    const tree = loadMap0();
    tree.LoadMapTile(32, 31);
    // world position of a point 2 above the floor inside house 1, liquid grid covers model x,y 0..8.33
    const world = VMapMgr2.convertPositionToInternalRep(P1.x + 1, P1.y + 1, P1.z + 2);
    const pos = VMapMgr2.convertPositionToInternalRep(world.x, world.y, world.z);
    expect(pos.x).toBeCloseTo(P1.x + 1, 2);

    const info = new LocationInfo();
    expect(tree.GetLocationInfo(pos, info)).toBe(true);
    expect(info.ground_Z).toBeCloseTo(P1.z, 3);
    expect(info.rootId).toBe(HOUSE_ROOT_WMO_ID);
    expect(info.hitModel!.GetMogpFlags()).toBe(HOUSE_MOGP);
    expect(info.hitModel!.GetLiquidType()).toBe(HOUSE_LIQUID_TYPE);
    expect(info.hitInstance!.adtId).toBe(7);
    expect(info.hitInstance!.ID).toBe(1);
    const level: FloatRef = { value: 0 };
    expect(info.hitInstance!.GetLiquidLevel(pos, info, level)).toBe(true);
    expect(level.value).toBeCloseTo(P1.z + 1, 3);

    // above the ramp: ramp group, no liquid
    info.reset();
    expect(tree.GetLocationInfo(add(P1, 17, 5, 4), info)).toBe(true);
    expect(info.hitModel!.GetWmoID()).toBe(RAMP_GROUP_ID);
    expect(info.ground_Z).toBeCloseTo(P1.z + 2.5, 3);
    expect(info.hitInstance!.GetLiquidLevel(add(P1, 17, 5, 4), info, level)).toBe(false);

    info.reset();
    expect(tree.GetLocationInfo(add(P1, -20, 5, 2), info)).toBe(false);
  });

  test("a WDT-only map has one global model and is not tiled", () => {
    const tree = new StaticMapTree(1, vmaps);
    expect(tree.InitMap("001.vmtree")).toBe(true);
    expect(tree.isTiled()).toBe(false);
    expect(tree.LoadMapTile(10, 20)).toBe(true);
    const origin = new Vector3(WDT, WDT, 0);
    expect(tree.getHeight(add(origin, 5, 5, 2), 10)).toBeCloseTo(0, 3);
    expect(tree.isInLineOfSight(add(origin, 5, 5, 2), add(origin, 5, -5, 2), ModelIgnoreFlags.Nothing)).toBe(false);
    const info = new LocationInfo();
    expect(tree.GetLocationInfo(add(origin, 5, 5, 2), info)).toBe(true);
    expect(info.hitModel!.GetWmoID()).toBe(HOUSE_GROUP_ID);
  });

  test("InitMap fails on a missing file", () => {
    expect(new StaticMapTree(2, vmaps).InitMap("002.vmtree")).toBe(false);
  });
});
