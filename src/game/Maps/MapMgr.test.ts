import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { instance_template } from "../../database/schema/world.ts";
import { WorldTables } from "../../database/world-tables.ts";
import { sMapDifficultyStore } from "../DataStores/DBCStores.ts";
import { resetMapDBCStores } from "../DataStores/MapDBCStores.ts";
import { FakePlayer } from "../Grids/Grids.test-util.ts";
import { ServerConfig } from "../world/world-config-data.ts";
import { sWorld } from "../world/world.ts";
import { BattlegroundMap, InstanceMap, Map, MapHooks, type MapBattleground, type MapPlayer } from "./Map.ts";
import { MAP_ARENA, MAP_COMMON, MAP_INSTANCE, MAP_RAID, playerOn, setMapEntry } from "./Map.test-util.ts";
import { getHeight, getWaterLevel, MapMgr, sMapMgr } from "./MapMgr.ts";
import { MapInstanced } from "./MapInstanced.ts";
import { setMapMgrWorld } from "./MapMgrStatics.ts";
import { MapUpdater } from "./MapUpdater.ts";

const WORLD_MAP = 920;
const DUNGEON = 921;
const RAID = 922;
const ARENA = 923;

const savedHooks = { ...MapHooks };
const unloadDelay = sWorld().getIntConfig(ServerConfig.CONFIG_INSTANCE_UNLOAD_DELAY);

/** A pool whose `SELECT MAX(id) FROM instance` answers `maxId` (`null` for an empty table). */
function fakeInstanceDb(maxId: number | null) {
  return { $client: { unsafe: () => ({ values: async () => [[maxId]] }) } } as never;
}

beforeEach(async () => {
  setMapEntry(WORLD_MAP, MAP_COMMON);
  setMapEntry(DUNGEON, MAP_INSTANCE, { maxPlayers: 5 });
  setMapEntry(RAID, MAP_RAID);
  setMapEntry(ARENA, MAP_ARENA);
  setMapMgrWorld(
    WorldTables.fromRows([
      [
        instance_template,
        [
          { map: DUNGEON, parent: 0, script: "", allowMount: 0 },
          { map: RAID, parent: 0, script: "", allowMount: 0 },
        ],
      ],
    ]),
  );
  sMapDifficultyStore.set(1, { MapId: DUNGEON, Difficulty: 0, areaTriggerText: "", resetTime: 0, maxPlayers: 5 });
  resetMapDBCStores();
  sWorld().setIntConfig(ServerConfig.CONFIG_INSTANCE_UNLOAD_DELAY, 1000);
  await sMapMgr().initInstanceIds(fakeInstanceDb(0));
});

afterEach(() => {
  sMapMgr().unloadAll();
  Object.assign(MapHooks, savedHooks);
  sWorld().setIntConfig(ServerConfig.CONFIG_INSTANCE_UNLOAD_DELAY, unloadDelay);
  setMapMgrWorld(null);
});

/** A player that has a difficulty, no group, and is alive (what `CreateInstanceForPlayer` reads). */
function entering(guidLow: number): FakePlayer & Partial<MapPlayer> {
  const player = new FakePlayer(guidLow, 0, 0) as FakePlayer & Partial<MapPlayer>;
  player.getDifficulty = () => 0;
  return player;
}

describe("MapMgr maps", () => {
  test("CreateBaseMap makes a Map for a world map and a MapInstanced for an instanceable one, once", () => {
    const world = sMapMgr().createBaseMap(WORLD_MAP);
    expect(world).toBeInstanceOf(Map);
    expect(world).not.toBeInstanceOf(MapInstanced);
    expect(sMapMgr().createBaseMap(WORLD_MAP)).toBe(world);
    expect(sMapMgr().findBaseMap(WORLD_MAP)).toBe(world);
    expect(sMapMgr().findBaseNonInstanceMap(WORLD_MAP)).toBe(world);

    const dungeon = sMapMgr().createBaseMap(DUNGEON);
    expect(dungeon).toBeInstanceOf(MapInstanced);
    expect(sMapMgr().findBaseNonInstanceMap(DUNGEON)).toBeNull();
    expect(sMapMgr().findBaseMap(999)).toBeNull();
    expect(() => sMapMgr().createBaseMap(999)).toThrow();
  });

  test("FindMap finds a world map by instance id 0 and an instance by its id", () => {
    const world = sMapMgr().createBaseMap(WORLD_MAP);
    expect(sMapMgr().findMap(WORLD_MAP, 0)).toBe(world);
    expect(sMapMgr().findMap(WORLD_MAP, 4)).toBeNull();
    expect(sMapMgr().findMap(404, 0)).toBeNull();
    const instance = sMapMgr().createMap(DUNGEON, entering(1) as MapPlayer)!;
    expect(instance).toBeInstanceOf(InstanceMap);
    expect(sMapMgr().findMap(DUNGEON, instance.getInstanceId())).toBe(instance);
    expect(sMapMgr().findMap(DUNGEON, 0)).toBeNull();
  });

  test("CreateMap gives each entry without a save its own new instance", () => {
    const a = sMapMgr().createMap(DUNGEON, entering(1) as MapPlayer)!;
    const b = sMapMgr().createMap(DUNGEON, entering(2) as MapPlayer)!;
    expect(a.getInstanceId()).toBe(1);
    expect(b.getInstanceId()).toBe(2);
    expect(a.getParent()).toBe(sMapMgr().findBaseMap(DUNGEON)!);
    expect(a.getId()).toBe(DUNGEON);
    // instances load every grid
    expect(a.getLoadedGridsCount()).toBe(64 * 64);
    expect(sMapMgr().createMap(WORLD_MAP, entering(3) as MapPlayer)).toBe(sMapMgr().findBaseMap(WORLD_MAP)!);
    const counts = sMapMgr().getNumInstances();
    expect(counts).toEqual({ dungeons: 2, battlegrounds: 0, arenas: 0 });
  });

  test("an instance needs an instance template", () => {
    setMapEntry(924, MAP_INSTANCE);
    expect(() => sMapMgr().createMap(924, entering(1) as MapPlayer)).toThrow();
  });

  test("instance ids come from the lowest free id, skipping registered ones", async () => {
    await sMapMgr().initInstanceIds(fakeInstanceDb(5));
    expect(sMapMgr().getInstanceIDs()).toHaveLength(6);
    sMapMgr().registerInstanceId(1);
    sMapMgr().registerInstanceId(2);
    sMapMgr().registerInstanceId(4);
    expect(sMapMgr().generateInstanceId()).toBe(3);
    expect(sMapMgr().generateInstanceId()).toBe(5);
    expect(sMapMgr().generateInstanceId()).toBe(6);
    expect(sMapMgr().generateInstanceId()).toBe(7);
  });

  test("a battleground map is found by the battleground id and created from the battleground of the player", () => {
    const created: MapBattleground[] = [];
    const bg: MapBattleground = {
      setBgMap: () => {},
      removePlayerAtLeave: () => {},
      removeSpectator: () => {},
      getStatus: () => 3,
      getMapId: () => ARENA,
      getMinLevel: () => 80,
      getSpectators: () => new Set(),
    };
    const player = entering(5) as FakePlayer & Partial<MapPlayer> & { getBattleground?: (create: boolean) => MapBattleground | null };
    expect(sMapMgr().createMap(ARENA, player as MapPlayer)).toBeNull(); // not in a battleground
    player.getBattlegroundId = () => 7;
    let teleported = 0;
    player.teleportToEntryPoint = () => void ++teleported;
    expect(sMapMgr().createMap(ARENA, player as MapPlayer)).toBeNull(); // no battleground to join
    expect(teleported).toBe(1);
    player.getBattleground = () => (created.push(bg), bg);
    const map = sMapMgr().createMap(ARENA, player as MapPlayer);
    expect(map).toBeInstanceOf(BattlegroundMap);
    expect(map!.getInstanceId()).toBe(7);
    expect((map as BattlegroundMap).getBG()).toBe(bg);
    expect(sMapMgr().createMap(ARENA, player as MapPlayer)).toBe(map);
    expect(sMapMgr().getNumInstances().arenas).toBe(1);
    expect(created).toHaveLength(1);
  });
});

describe("MapMgr update", () => {
  test("Update ticks the continents first, then battlegrounds, then instances, then idles", () => {
    const world = sMapMgr().createBaseMap(WORLD_MAP);
    const dungeon = sMapMgr().createBaseMap(DUNGEON);
    const worldUpdate = spyOn(world, "update");
    const dungeonUpdate = spyOn(dungeon, "update");
    const worldDelayed = spyOn(world, "delayedUpdate");
    sMapMgr().setMapUpdateInterval(1000);

    sMapMgr().update(100); // step 0: the continent runs a full update, the instance base map a bare one
    expect(worldUpdate).toHaveBeenLastCalledWith(100, 100);
    expect(dungeonUpdate).toHaveBeenLastCalledWith(0, 100);
    expect(worldDelayed).toHaveBeenCalledTimes(1);

    sMapMgr().update(100); // step 1: battlegrounds and arenas
    expect(worldUpdate).toHaveBeenLastCalledWith(0, 100);
    expect(worldDelayed).toHaveBeenCalledTimes(1);

    sMapMgr().update(100); // step 2: instances
    expect(dungeonUpdate).toHaveBeenLastCalledWith(300, 100);

    sMapMgr().update(900); // step 3: idle until the interval passes
    expect(worldUpdate).toHaveBeenLastCalledWith(0, 900);
    // the interval has passed: start over, the continents' timer has run since the first step
    sMapMgr().update(100);
    expect(worldUpdate).toHaveBeenLastCalledWith(1200, 100);
    sMapMgr().update(50); // step 1 again
    expect(worldUpdate).toHaveBeenLastCalledWith(0, 50);
  });

  test("an empty instance is destroyed once its unload timer runs out", () => {
    const base = sMapMgr().createBaseMap(DUNGEON) as MapInstanced;
    const instance = sMapMgr().createMap(DUNGEON, entering(1) as MapPlayer)!;
    base.update(500, 500);
    expect(base.findInstanceMap(instance.getInstanceId())).toBe(instance);
    base.update(600, 600);
    expect(base.findInstanceMap(instance.getInstanceId())).toBeNull();
    expect(base.getInstancedMaps().size).toBe(0);
  });

  test("UnloadAll unloads every map and the instances in them", () => {
    sMapMgr().createBaseMap(WORLD_MAP);
    const instance = sMapMgr().createMap(RAID, entering(1) as MapPlayer)!;
    sMapMgr().unloadAll();
    expect(sMapMgr().findBaseMap(WORLD_MAP)).toBeNull();
    expect(instance.getSize()).toBe(0);
  });

  test("DoForAllMaps visits world maps and every instance", () => {
    sMapMgr().createBaseMap(WORLD_MAP);
    sMapMgr().createMap(DUNGEON, entering(1) as MapPlayer);
    sMapMgr().createMap(DUNGEON, entering(2) as MapPlayer);
    const seen: number[] = [];
    sMapMgr().doForAllMaps((m) => seen.push(m.getId()));
    expect(seen.sort((a, b) => a - b)).toEqual([WORLD_MAP, DUNGEON, DUNGEON]);
    const dungeons: number[] = [];
    sMapMgr().doForAllMapsWithMapId(DUNGEON, (m) => dungeons.push(m.getInstanceId()));
    expect(dungeons.sort((a, b) => a - b)).toEqual([1, 2]);
    const none: number[] = [];
    sMapMgr().doForAllMapsWithMapId(1, (m) => none.push(m.getId()));
    expect(none).toEqual([]);
  });

  test("the players of the instances are counted", () => {
    const instance = sMapMgr().createMap(DUNGEON, entering(1) as MapPlayer)!;
    const a = playerOn(instance, 10, 0, 0);
    const b = playerOn(instance, 11, 0, 0);
    expect(sMapMgr().getNumPlayersInInstances()).toEqual({ dungeons: 2, battlegrounds: 0, arenas: 0, spectators: 0 });
    a.mapRef.unlink();
    b.mapRef.unlink();
  });
});

describe("MapMgr helpers", () => {
  test("the map based height and water level functions read the base map", () => {
    expect(getHeight(404, 0, 0)).toBe(-100000);
    expect(getWaterLevel(404, 0, 0)).toBe(-100000);
    // a map without a .map file: the invalid height
    expect(getHeight(WORLD_MAP, 0, 0, 100000)).toBe(-100000);
    expect(getWaterLevel(WORLD_MAP, 0, 0)).toBe(-100000);
    expect(sMapMgr().getAreaId(1, WORLD_MAP, 0, 0, 0)).toBe(0);
    expect(sMapMgr().getZoneId(1, WORLD_MAP, 0, 0, 0)).toBe(0);
    expect(sMapMgr().getZoneAndAreaId(1, WORLD_MAP, 0, 0, 0)).toEqual({ zoneid: 0, areaid: 0 });
    expect(MapMgr.existMapAndVMap(WORLD_MAP, 0, 0)).toBe(false);
  });

  test("the visibility distances of all maps are initialized again", () => {
    const world = sMapMgr().createBaseMap(WORLD_MAP);
    world.setVisibilityRange(5);
    sMapMgr().initializeVisibilityDistanceInfo();
    expect(world.getVisibilityRange()).toBe(100);
  });
});

describe("MapUpdater", () => {
  test("requests run on the spot and the updater never activates", () => {
    const world = sMapMgr().createBaseMap(WORLD_MAP);
    const update = spyOn(world, "update");
    const updater = sMapMgr().getMapUpdater();
    expect(updater).toBeInstanceOf(MapUpdater);
    expect(updater.activated()).toBe(false);
    updater.activate(4);
    expect(updater.activated()).toBe(false);
    updater.scheduleUpdate(world, 10, 20);
    expect(update).toHaveBeenCalledWith(10, 20);
    updater.scheduleLfgUpdate(5);
    updater.wait();
    updater.deactivate();
    updater.scheduleMapPreload(WORLD_MAP);
    expect(world.getLoadedGridsCount()).toBe(64 * 64);
  });
});
