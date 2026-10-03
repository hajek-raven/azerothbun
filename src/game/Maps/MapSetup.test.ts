import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { MMapMgr } from "../../common/Collision/Management/MMapMgr.ts";
import { VMapFactory } from "../../common/Collision/Management/VMapFactory.ts";
import type { ConfigMgr } from "../../common/config.ts";
import { GetLiquidFlags } from "../DataStores/MapDBCStores.ts";
import { Corpse } from "../Entities/Corpse/Corpse.ts";
import { Creature } from "../Entities/Creature/Creature.ts";
import { GameObject } from "../Entities/GameObject/GameObject.ts";
import { GridObjectLoaderHooks } from "../Grids/GridObjectLoader.ts";
import { GridTerrainLoaderHooks } from "../Grids/GridTerrainLoader.ts";
import { MapHooks } from "./Map.ts";
import { testDatabase } from "../../database/test-db.ts";
import { ServerConfig } from "../world/world-config-data.ts";
import { sWorld } from "../world/world.ts";
import { sMapMgr } from "./MapMgr.ts";
import { WorldTables } from "../../database/world-tables.ts";
import { LineOfSightHooks } from "./MapLineOfSight.ts";
import { sObjectMgr } from "../Globals/ObjectMgr.ts";
import { checkStartingAreaMaps, loadMapConfigSettings, loadMapVisibilityDistances, preloadAllNonInstancedMapGrids, setupMaps, startMapSystem } from "./MapSetup.ts";

const savedMapHooks = { ...MapHooks };
const savedLoaderHooks = { ...GridTerrainLoaderHooks };
const savedObjectLoaderHooks = { ...GridObjectLoaderHooks };
const savedDataDir = MMapMgr.getDataDir();
const savedFindMap = LineOfSightHooks.findMap;
const savedVMapDisabled = VMapFactory.createOrGetVMapMgr().IsVMAPDisabledForPtr;

afterEach(() => {
  Object.assign(MapHooks, savedMapHooks);
  Object.assign(GridTerrainLoaderHooks, savedLoaderHooks);
  Object.assign(GridObjectLoaderHooks, savedObjectLoaderHooks);
  MMapMgr.setDataDir(savedDataDir);
  LineOfSightHooks.findMap = savedFindMap;
  VMapFactory.createOrGetVMapMgr().IsVMAPDisabledForPtr = savedVMapDisabled;
  sObjectMgr.zoneAreaResolver = null;
});

describe("setupMaps", () => {
  test("points the grid loader, the vmap manager, and the map hooks at the server", () => {
    setupMaps("somewhere/data");
    expect(GridTerrainLoaderHooks.getDataPath()).toBe("somewhere/data/");
    expect(GridTerrainLoaderHooks.getVMapMgr()).toBe(VMapFactory.createOrGetVMapMgr());
    expect(VMapFactory.createOrGetVMapMgr().GetLiquidFlagsPtr).toBe(GetLiquidFlags);
    expect(MMapMgr.getDataDir()).toBe("somewhere/data");
    expect(MapHooks.objectMgr).not.toBeNull();
    expect(GridObjectLoaderHooks.objectMgr?.getGridObjectGuids(0, 0, 0)).toBeDefined();
    expect(GridObjectLoaderHooks.createCreature!()).toBeInstanceOf(Creature);
    expect(GridObjectLoaderHooks.createGameObject!()).toBeInstanceOf(GameObject);
    expect(MapHooks.createCreature!()).toBeInstanceOf(Creature);
    expect(MapHooks.createGameObject!()).toBeInstanceOf(GameObject);
    expect(MapHooks.createCorpse!(1)).toBeInstanceOf(Corpse);
    expect(MapHooks.objectMgr!.getSpawnGroupData(0)?.groupId ?? 0).toBe(0);
    expect(MapHooks.objectMgr!.getCreatureTemplateFlagsExtra(123456)).toBe(0);
    const packet = MapHooks.buildSystemChatPacket!("hi");
    expect(packet.opcode).toBe(0x96);
    expect(new TextDecoder().decode(packet.payload)).toContain("hi");
  });
});

describe("loadMapVisibilityDistances", () => {
  const config = (values: Record<string, number>) => ({ getFloat: (key: string, def: number) => values[key] ?? def }) as unknown as ConfigMgr;

  test("takes the configured distances", () => {
    loadMapVisibilityDistances(config({ "Visibility.Distance.Continents": 120, "Visibility.Distance.Instances": 190, "Visibility.Distance.BGArenas": 200 }));
    expect([MapHooks.getMaxVisibleDistanceOnContinents(), MapHooks.getMaxVisibleDistanceInInstances(), MapHooks.getMaxVisibleDistanceInBGArenas()]).toEqual([120, 190, 200]);
  });

  test("defaults when unset, and clamps to the aggro radius and the maximum", () => {
    loadMapVisibilityDistances(config({}));
    expect([MapHooks.getMaxVisibleDistanceOnContinents(), MapHooks.getMaxVisibleDistanceInInstances(), MapHooks.getMaxVisibleDistanceInBGArenas()]).toEqual([100, 170, 250]);
    loadMapVisibilityDistances(config({ "Visibility.Distance.Continents": 10, "Visibility.Distance.Instances": 1000 }));
    expect(MapHooks.getMaxVisibleDistanceOnContinents()).toBe(45); // 45 * Rate.Creature.Aggro (1)
    expect(MapHooks.getMaxVisibleDistanceInInstances()).toBe(250);
  });
});

describe("loadMapConfigSettings", () => {
  const vmaps = () => VMapFactory.createOrGetVMapMgr();
  afterEach(() => {
    sWorld().setBoolConfig(ServerConfig.CONFIG_VMAP_ENABLE_LOS, true);
    sWorld().setBoolConfig(ServerConfig.CONFIG_VMAP_ENABLE_HEIGHT, true);
    loadMapConfigSettings();
  });

  test("vmap.enableLOS and vmap.enableHeight switch the vmap manager", () => {
    loadMapConfigSettings();
    expect([vmaps().isLineOfSightCalcEnabled(), vmaps().isHeightCalcEnabled()]).toEqual([true, true]);

    sWorld().setBoolConfig(ServerConfig.CONFIG_VMAP_ENABLE_LOS, false);
    sWorld().setBoolConfig(ServerConfig.CONFIG_VMAP_ENABLE_HEIGHT, false);
    loadMapConfigSettings();
    expect([vmaps().isLineOfSightCalcEnabled(), vmaps().isHeightCalcEnabled()]).toEqual([false, false]);
  });
});

describe("World data path", () => {
  test("DataDir gets a trailing slash and a reload cannot change it", () => {
    const world = sWorld();
    const before = world.getDataPath();
    expect(world.loadDataPath("somewhere/data")).toBe(true);
    expect(world.getDataPath()).toBe("somewhere/data/");
    expect(world.loadDataPath("elsewhere", true)).toBe(false);
    expect(world.getDataPath()).toBe("somewhere/data/");
    expect(world.loadDataPath("somewhere/data/", true)).toBe(true);
    expect(world.loadDataPath("", false)).toBe(true);
    expect(world.getDataPath()).toBe("/");
    world.loadDataPath(before);
  });
});

describe("checkStartingAreaMaps", () => {
  test("lists the starting areas without map files (the outland ones only with the expansion)", () => {
    setupMaps("/nonexistent-data-dir");
    const original = sWorld().getIntConfig(ServerConfig.CONFIG_EXPANSION);
    sWorld().setIntConfig(ServerConfig.CONFIG_EXPANSION, 0);
    expect(checkStartingAreaMaps()).toHaveLength(6);
    sWorld().setIntConfig(ServerConfig.CONFIG_EXPANSION, 2);
    expect(checkStartingAreaMaps()).toHaveLength(8);
    sWorld().setIntConfig(ServerConfig.CONFIG_EXPANSION, original);
  });
});

describe("preloadAllNonInstancedMapGrids", () => {
  test("does nothing while PreloadAllNonInstancedMapGrids is off", () => {
    expect(sWorld().getBoolConfig(ServerConfig.CONFIG_PRELOAD_ALL_NON_INSTANCED_MAP_GRIDS)).toBe(false);
    const created = spyOn(sMapMgr(), "createBaseMap");
    preloadAllNonInstancedMapGrids();
    expect(created).not.toHaveBeenCalled();
    created.mockRestore();
  });
});

describe("startMapSystem", () => {
  test("installs the hooks, reads the instance ids, and applies the update interval and the visibility distances", async () => {
    const characters = await testDatabase("characters");
    const savedWorld = sObjectMgr.worldTables();
    sObjectMgr.setWorld(null, WorldTables.fromRows([]));
    const config = { getFloat: (_key: string, def: number) => def } as unknown as ConfigMgr;
    const interval = sWorld().getIntConfig(ServerConfig.CONFIG_INTERVAL_MAPUPDATE);
    await startMapSystem({ dataPath: "somewhere/data", config, characterDb: characters });
    expect(GridTerrainLoaderHooks.getDataPath()).toBe("somewhere/data/");
    expect(MapHooks.objectMgr).not.toBeNull();
    expect(MapHooks.getMaxVisibleDistanceOnContinents()).toBe(100);
    expect(sMapMgr().generateInstanceId()).toBeGreaterThanOrEqual(1);
    expect(interval).toBeGreaterThan(0);
    expect(sObjectMgr.getAllSpawnCreatureData().size).toBe(0);
    sObjectMgr.setWorld(null, savedWorld);
  });
});
