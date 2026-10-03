import { afterEach, describe, expect, test } from "bun:test";
import { AreaAndLiquidData, VMAP_INVALID_HEIGHT_VALUE, VMAP_LOAD_RESULT } from "../../common/Collision/Management/IVMapMgr.ts";
import { MMAP_LOAD_RESULT_IGNORED } from "../../common/Collision/Management/MMapMgr.ts";
import { VMapFactory } from "../../common/Collision/Management/VMapFactory.ts";
import { DisableTypes } from "../../common/Collision/Management/VMapMgr2.ts";
import { Vector3 } from "../../math/Vector3.ts";
import { ServerConfig } from "../world/world-config-data.ts";
import { sWorld } from "../world/world.ts";
import { DynamicVMapCollisionData, MapCollisionData, MapCollisionDataHooks, MMapData, StaticVMapCollisionData } from "./MapCollisionData.ts";

const savedHooks = { ...MapCollisionDataHooks };

afterEach(() => {
  Object.assign(MapCollisionDataHooks, savedHooks);
  sWorld().setBoolConfig(ServerConfig.CONFIG_ENABLE_MMAPS, true);
});

/** A map for `MapCollisionData` that has no vmap or mmap files. */
const fakeMap = (id: number, bg = false) => ({ getId: () => id, isBattlegroundOrArena: () => bg });

describe("StaticVMapCollisionData without a tree", () => {
  const data = new StaticVMapCollisionData(7);

  test("everything is open and nothing has a height", () => {
    expect(data.isInLineOfSight(0, 0, 0, 10, 10, 10, 0)).toBe(true);
    expect(data.getHeight(0, 0, 0, 50)).toBe(VMAP_INVALID_HEIGHT_VALUE);
    const hit = { x: 0, y: 0, z: 0 };
    expect(data.GetObjectHitPos(1, 2, 3, 4, 5, 6, hit, -0.5)).toBe(false);
    expect(hit).toEqual({ x: 4, y: 5, z: 6 });
    expect(data.GetAreaAndLiquidData(0, 0, 0, null, new AreaAndLiquidData())).toBe(false);
  });
});

describe("DynamicVMapCollisionData", () => {
  test("GetObjectHitPos with coordinates writes the destination into the result", () => {
    const tree = new DynamicVMapCollisionData();
    const hit = { x: 0, y: 0, z: 0 };
    expect(tree.GetObjectHitPos(1, 1, 2, 3, 11, 2, 3, hit, -0.5)).toBe(false);
    expect(hit).toEqual({ x: 11, y: 2, z: 3 });
    // the DynamicMapTree form with vectors is still there
    const result = new Vector3();
    expect(tree.GetObjectHitPos(1, new Vector3(1, 2, 3), new Vector3(4, 5, 6), result, -0.5)).toBe(false);
    expect([result.x, result.y, result.z]).toEqual([4, 5, 6]);
    expect(tree.getHeight(0, 0, 0, 50, 1)).toBe(-Infinity);
  });
});

describe("MapCollisionData", () => {
  test("a base map without files has no static tree and no nav mesh, and its tile loads are ignored", () => {
    const collision = new MapCollisionData(fakeMap(1234), null);
    expect(collision.getStaticTreeSharedPtr()).toBeNull();
    expect(collision.getMMapNavMeshSharedPtr()).toBeNull();
    expect(collision.getMMapData().getNavMesh()).toBeNull();
    expect(collision.getMMapData().getNavMeshQuery()).toBeNull();
    expect(collision.loadVMapTile(31, 31)).toBe(VMAP_LOAD_RESULT.VMAP_LOAD_RESULT_IGNORED);
    expect(collision.loadMMapTile(31, 31)).toBe(MMAP_LOAD_RESULT_IGNORED);
    expect(collision.getDynamicTree().size()).toBe(0);
    expect(collision.getStaticTree()).toBeInstanceOf(StaticVMapCollisionData);
    expect(collision.getMMapData()).toBeInstanceOf(MMapData);
  });

  test("an instance shares the static tree and the nav mesh of its parent", () => {
    const parent = new MapCollisionData(fakeMap(1234), null);
    const tree = { marker: "tree" } as never;
    const mesh = { marker: "mesh" } as never;
    parent.getStaticTree()._staticTree = tree;
    parent.getMMapData()._navMesh = mesh;
    const child = new MapCollisionData(fakeMap(1234), { getMapCollisionData: () => parent });
    expect(child.getStaticTreeSharedPtr()).toBe(tree);
    expect(child.getMMapNavMeshSharedPtr()).toBe(mesh);
    // but each map has its own dynamic tree
    expect(child.getDynamicTree()).not.toBe(parent.getDynamicTree());
  });

  test("tile loads are ignored while vmap loading is disabled", () => {
    const collision = new MapCollisionData(fakeMap(1234), null);
    const mgr = VMapFactory.createOrGetVMapMgr();
    collision.getStaticTree()._staticTree = { LoadMapTile: () => true } as never;
    expect(collision.loadVMapTile(1, 1)).toBe(VMAP_LOAD_RESULT.VMAP_LOAD_RESULT_OK);
    collision.getStaticTree()._staticTree = { LoadMapTile: () => false } as never;
    expect(collision.loadVMapTile(1, 1)).toBe(VMAP_LOAD_RESULT.VMAP_LOAD_RESULT_ERROR);
    mgr.setEnableLineOfSightCalc(false);
    mgr.setEnableHeightCalc(false);
    try {
      expect(collision.loadVMapTile(1, 1)).toBe(VMAP_LOAD_RESULT.VMAP_LOAD_RESULT_IGNORED);
    } finally {
      mgr.setEnableLineOfSightCalc(true);
      mgr.setEnableHeightCalc(true);
    }
  });

  test("the checks of the static data follow the config and the disables hook", () => {
    const data = new StaticVMapCollisionData(7);
    let queries = 0;
    data._staticTree = {
      isInLineOfSight: () => (queries++, false),
      getHeight: () => 12.5,
      GetObjectHitPos: (_a: Vector3, _b: Vector3, out: Vector3) => {
        out.set(1, 1, 1);
        return true;
      },
    } as never;
    expect(data.isInLineOfSight(0, 0, 0, 10, 0, 0, 0)).toBe(false);
    expect(data.getHeight(0, 0, 0, 50)).toBe(12.5);
    const hit = { x: 0, y: 0, z: 0 };
    expect(data.GetObjectHitPos(0, 0, 0, 10, 0, 0, hit, 0)).toBe(true);

    // the same position twice is always open and never asks the tree
    queries = 0;
    expect(data.isInLineOfSight(3, 3, 3, 3, 3, 3, 0)).toBe(true);
    expect(queries).toBe(0);

    sWorld().setBoolConfig(ServerConfig.CONFIG_VMAP_ENABLE_LOS, false);
    sWorld().setBoolConfig(ServerConfig.CONFIG_VMAP_ENABLE_HEIGHT, false);
    try {
      expect(data.isInLineOfSight(0, 0, 0, 10, 0, 0, 0)).toBe(true);
      expect(data.getHeight(0, 0, 0, 50)).toBe(VMAP_INVALID_HEIGHT_VALUE);
      expect(data.GetObjectHitPos(0, 0, 0, 10, 0, 0, hit, 0)).toBe(false);
      expect(hit).toEqual({ x: 10, y: 0, z: 0 });
    } finally {
      sWorld().setBoolConfig(ServerConfig.CONFIG_VMAP_ENABLE_LOS, true);
      sWorld().setBoolConfig(ServerConfig.CONFIG_VMAP_ENABLE_HEIGHT, true);
    }

    const disabled: number[] = [];
    MapCollisionDataHooks.isVMAPDisabledFor = (mapId, flags) => {
      disabled.push(mapId, flags);
      return true;
    };
    expect(data.isInLineOfSight(0, 0, 0, 10, 0, 0, 0)).toBe(true);
    expect(data.getHeight(0, 0, 0, 50)).toBe(VMAP_INVALID_HEIGHT_VALUE);
    expect(disabled).toEqual([7, DisableTypes.VMAP_DISABLE_LOS, 7, DisableTypes.VMAP_DISABLE_HEIGHT]);
  });
});

describe("pathfinding switch", () => {
  test("DisableMgr::IsPathfindingEnabled: config, map id, and battlegrounds", () => {
    const enabled = MapCollisionDataHooks.isPathfindingEnabled;
    expect(enabled(null)).toBe(false);
    expect(enabled(fakeMap(0))).toBe(true);
    // Eye of Eternity, Trial of the Crusader, Trial of the Champion
    expect(enabled(fakeMap(616))).toBe(false);
    expect(enabled(fakeMap(649))).toBe(false);
    expect(enabled(fakeMap(650))).toBe(false);
    sWorld().setBoolConfig(ServerConfig.CONFIG_ENABLE_MMAPS, false);
    expect(enabled(fakeMap(0))).toBe(false);
    expect(enabled(fakeMap(489, true))).toBe(true);
  });
});
