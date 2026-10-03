import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HighGuid, ObjectGuid } from "../Entities/Object/ObjectGuid.ts";
import { GridObjectLoaderHooks } from "../Grids/GridObjectLoader.ts";
import { FakeCreature, FakeGameObject, FakeObjectMgr } from "../Grids/Grids.test-util.ts";
import { getGameTime, resetGameTimeForTests } from "../time/game-time.ts";
import { ServerConfig } from "../world/world-config-data.ts";
import { sWorld } from "../world/world.ts";
import { InstanceMap, Map, MapHooks, sMapRespawnStore, type MapObjectMgr } from "./Map.ts";
import { StdMap } from "./StdMap.ts";
import { cellCenter, MAP_COMMON, MAP_RAID, setMapEntry, TEST_MAP_ID } from "./Map.test-util.ts";
import {
  SPAWNGROUP_FLAG_COMPATIBILITY_MODE,
  SPAWNGROUP_FLAG_MANUAL_SPAWN,
  SPAWNGROUP_FLAG_SYSTEM,
  SPAWNGROUP_MAP_UNSET,
  SPAWN_TYPE_CREATURE,
  SPAWN_TYPE_GAMEOBJECT,
  CreatureData,
  GameObjectData,
  type SpawnData,
  type SpawnGroupTemplateData,
} from "./SpawnData.ts";

const savedHooks = { ...MapHooks };
const savedLoaderHooks = { ...GridObjectLoaderHooks };
const X = cellCenter(386);
const Y = cellCenter(260);

/** The `ObjectMgr` side `Map` reads: spawn groups, spawn data, linked respawns. */
class FakeMapObjectMgr implements MapObjectMgr {
  groups = new StdMap<number, SpawnGroupTemplateData>();
  creatures = new StdMap<number, CreatureData>();
  gameobjects = new StdMap<number, GameObjectData>();
  members = new StdMap<number, SpawnData[]>();
  linked = new StdMap<bigint, bigint>();
  flagsExtra = new StdMap<number, number>();

  getSpawnGroupData(groupId: number): SpawnGroupTemplateData | null {
    return this.groups.get(groupId) ?? null;
  }
  getSpawnDataForGroup(groupId: number): readonly SpawnData[] {
    return this.members.get(groupId) ?? [];
  }
  getSpawnCreatureData(spawnId: number): CreatureData | null {
    return this.creatures.get(spawnId) ?? null;
  }
  getSpawnGameObjectData(spawnId: number): GameObjectData | null {
    return this.gameobjects.get(spawnId) ?? null;
  }
  getLinkedRespawnGuid(guid: bigint): bigint {
    return this.linked.get(guid) ?? 0n;
  }
  getCreatureTemplateFlagsExtra(entry: number): number {
    return this.flagsExtra.get(entry) ?? 0;
  }

  group(groupId: number, flags: number, mapId = SPAWNGROUP_MAP_UNSET): void {
    this.groups.set(groupId, { groupId, name: `group ${groupId}`, mapId, flags });
  }
  creature(spawnId: number, groupId: number, id = 100): CreatureData {
    const data = new CreatureData();
    Object.assign(data, { spawnId, id, spawnGroupId: groupId, posX: X, posY: Y, mapid: TEST_MAP_ID });
    this.creatures.set(spawnId, data);
    this.members.set(groupId, [...(this.members.get(groupId) ?? []), data]);
    return data;
  }
  gameobject(spawnId: number, groupId: number): GameObjectData {
    const data = new GameObjectData();
    Object.assign(data, { spawnId, id: 200, spawnGroupId: groupId, posX: X, posY: Y, mapid: TEST_MAP_ID });
    this.gameobjects.set(spawnId, data);
    this.members.set(groupId, [...(this.members.get(groupId) ?? []), data]);
    return data;
  }
}

let mgr: FakeMapObjectMgr;
let map: Map;
let loaded: { type: string; spawnId: number; addToMap: boolean | undefined; allowDuplicate?: boolean }[];

beforeEach(() => {
  resetGameTimeForTests();
  mgr = new FakeMapObjectMgr();
  loaded = [];
  MapHooks.objectMgr = mgr;
  MapHooks.createCreature = () => ({
    loadCreatureFromDB: (spawnId, _map, addToMap, allowDuplicate) => {
      loaded.push({ type: "creature", spawnId, addToMap, allowDuplicate });
      return true;
    },
  });
  MapHooks.createGameObject = () => ({
    loadGameObjectFromDB: (spawnId, _map, addToMap) => {
      loaded.push({ type: "gameobject", spawnId, addToMap });
      return true;
    },
  });
  setMapEntry(TEST_MAP_ID, MAP_COMMON);
  sMapRespawnStore.clear();
  map = new Map(TEST_MAP_ID, 0, 0);
  map.loadGrid(X, Y);
});

afterEach(() => {
  map.unloadAll();
  Object.assign(MapHooks, savedHooks);
  Object.assign(GridObjectLoaderHooks, savedLoaderHooks);
});

describe("respawn times", () => {
  test("Save, Get, and Remove keep the times and the queue in step", () => {
    const now = getGameTime();
    expect(map.getCreatureRespawnTime(5)).toBe(0);
    map.saveCreatureRespawnTime(5, now + 100);
    map.saveGORespawnTime(6, now + 50);
    expect(map.getCreatureRespawnTime(5)).toBe(now + 100);
    expect(map.getGORespawnTime(6)).toBe(now + 50);
    expect(map.getRespawnTime(SPAWN_TYPE_CREATURE, 5)).toBe(now + 100);
    expect(map.getRespawnTime(SPAWN_TYPE_GAMEOBJECT, 6)).toBe(now + 50);
    expect(map.getRespawnTime(SPAWN_TYPE_GAMEOBJECT, 5)).toBe(0);
    // the mirror of the tables follows
    expect(sMapRespawnStore.creatureRespawns(TEST_MAP_ID, 0).get(5)).toBe(now + 100);

    map.saveCreatureRespawnTime(5, now + 10); // a new time replaces the old queue entry
    map.removeGORespawnTime(6);
    expect(map.getGORespawnTime(6)).toBe(0);
    map.saveCreatureRespawnTime(5, 0); // zero deletes
    expect(map.getCreatureRespawnTime(5)).toBe(0);
    expect(sMapRespawnStore.creatureRespawns(TEST_MAP_ID, 0).has(5)).toBe(false);
    expect(map.getCreatureRespawnTimes().size).toBe(0);
  });

  test("LoadRespawnTimes reads the rows of this map and instance", () => {
    sMapRespawnStore.replace(SPAWN_TYPE_CREATURE, TEST_MAP_ID, 0, 11, 5000);
    sMapRespawnStore.replace(SPAWN_TYPE_GAMEOBJECT, TEST_MAP_ID, 0, 12, 6000);
    sMapRespawnStore.replace(SPAWN_TYPE_CREATURE, TEST_MAP_ID, 3, 13, 7000); // another instance
    sMapRespawnStore.replace(SPAWN_TYPE_CREATURE, 55, 0, 14, 8000); // another map
    map.loadRespawnTimes();
    expect([...map.getCreatureRespawnTimes()]).toEqual([[11, 5000]]);
    expect([...map.getGORespawnTimes()]).toEqual([[12, 6000]]);
    map.deleteRespawnTimes();
    expect(map.getCreatureRespawnTimes().size).toBe(0);
    expect(sMapRespawnStore.creatureRespawns(TEST_MAP_ID, 0).size).toBe(0);
    expect(sMapRespawnStore.creatureRespawns(TEST_MAP_ID, 3).get(13)).toBe(7000);
  });

  test("an instance that resets before the respawn pushes the time a year out", () => {
    setMapEntry(603, MAP_RAID);
    MapHooks.instanceSaveMgr = {
      getResetTimeFor: () => 1000,
      getExtendedResetTimeFor: () => 1000 + 7 * 86400,
    } as never;
    const instance = new InstanceMap(603, 9, 0, map);
    expect(instance.getInstanceResetPeriod()).toBe(7 * 86400);
    const now = getGameTime();
    expect(instance.saveCreatureRespawnTime(1, now + 7 * 86400)).toBe(now + 365 * 86400);
    expect(instance.saveCreatureRespawnTime(2, now + 100)).toBe(now + 100);
    expect(sMapRespawnStore.creatureRespawns(603, 9).get(1)).toBe(now + 365 * 86400);
  });

  test("GetLinkedRespawnTime follows the link to a creature or a gameobject", () => {
    const now = getGameTime();
    const slave = ObjectGuid.Create(HighGuid.Unit, 100, 1);
    mgr.linked.set(slave, ObjectGuid.Create(HighGuid.Unit, 100, 2));
    expect(map.getLinkedRespawnTime(slave)).toBe(0);
    map.saveCreatureRespawnTime(2, now + 60);
    expect(map.getLinkedRespawnTime(slave)).toBe(now + 60);
    mgr.linked.set(slave, ObjectGuid.Create(HighGuid.GameObject, 200, 3));
    map.saveGORespawnTime(3, now + 70);
    expect(map.getLinkedRespawnTime(slave)).toBe(now + 70);
    expect(map.getLinkedRespawnTime(ObjectGuid.Create(HighGuid.Unit, 1, 999))).toBe(0);
  });
});

describe("ProcessRespawns", () => {
  test("a due creature of a dynamic group is loaded after its time is removed", () => {
    mgr.group(5, 0);
    mgr.creature(21, 5);
    map.saveCreatureRespawnTime(21, getGameTime() - 1);
    map.processRespawns();
    expect(loaded).toEqual([{ type: "creature", spawnId: 21, addToMap: true, allowDuplicate: true }]);
    expect(map.getCreatureRespawnTime(21)).toBe(0);
  });

  test("entries in the future wait, due ones run in time order", () => {
    mgr.group(5, 0);
    mgr.creature(21, 5);
    mgr.creature(22, 5);
    mgr.gameobject(23, 5);
    const now = getGameTime();
    map.saveCreatureRespawnTime(22, now - 5);
    map.saveGORespawnTime(23, now - 10);
    map.saveCreatureRespawnTime(21, now + 100);
    map.processRespawns();
    expect(loaded.map((l) => l.spawnId)).toEqual([23, 22]);
    expect(map.getCreatureRespawnTime(21)).toBe(now + 100);
  });

  test("compatibility mode and unknown spawns are only cleaned up", () => {
    mgr.group(1, SPAWNGROUP_FLAG_COMPATIBILITY_MODE);
    mgr.creature(31, 1);
    map.saveCreatureRespawnTime(31, getGameTime() - 1);
    map.saveCreatureRespawnTime(32, getGameTime() - 1); // no spawn data
    map.processRespawns();
    expect(loaded).toEqual([]);
    expect(map.getCreatureRespawnTimes().size).toBe(0);
  });

  test("an inactive group or an unloaded grid re-queues the respawn five seconds out", () => {
    const now = getGameTime();
    mgr.group(6, SPAWNGROUP_FLAG_MANUAL_SPAWN);
    mgr.creature(41, 6);
    map.saveCreatureRespawnTime(41, now - 1);
    map.processRespawns();
    expect(loaded).toEqual([]);
    expect(map.getCreatureRespawnTime(41)).toBe(now - 1); // the time itself stays; the queue holds the retry
    // an unloaded grid
    mgr.group(7, 0);
    const far = mgr.creature(42, 7);
    far.posX = cellCenter(100);
    far.posY = cellCenter(100);
    map.saveCreatureRespawnTime(42, now - 1);
    map.processRespawns();
    expect(loaded).toEqual([]);
  });

  test("a creature that is alive already only loses its respawn time", () => {
    mgr.group(5, 0);
    mgr.creature(51, 5);
    const alive = new FakeCreature(new FakeObjectMgr(), 51, X, Y, 0);
    map.getCreatureBySpawnIdStore().set(51, [alive]);
    map.saveCreatureRespawnTime(51, getGameTime() - 1);
    map.processRespawns();
    expect(loaded).toEqual([]);
    expect(map.getCreatureRespawnTime(51)).toBe(0);
  });

  test("a creature linked to a dead master waits for it, a hard reset one does not", () => {
    const now = getGameTime();
    mgr.group(5, 0);
    mgr.creature(61, 5, 100);
    mgr.creature(62, 5, 101);
    mgr.linked.set(ObjectGuid.Create(HighGuid.Unit, 100, 61), ObjectGuid.Create(HighGuid.Unit, 100, 62));
    map.saveCreatureRespawnTime(62, now + 1000);
    map.saveCreatureRespawnTime(61, now - 1);
    map.processRespawns();
    expect(loaded).toEqual([]);
    expect(map.getCreatureRespawnTime(61)).toBeGreaterThanOrEqual(now + 1000 + 5);
    // hard reset
    mgr.flagsExtra.set(100, 0x80000000);
    map.saveCreatureRespawnTime(61, now - 1);
    map.processRespawns();
    expect(loaded.map((l) => l.spawnId)).toEqual([61]);
  });

  test("a creature linked to itself is checked again in a day", () => {
    const now = getGameTime();
    mgr.group(5, 0);
    mgr.creature(63, 5, 100);
    const self = ObjectGuid.Create(HighGuid.Unit, 100, 63);
    mgr.linked.set(self, self);
    map.saveCreatureRespawnTime(63, now - 1);
    map.processRespawns();
    expect(loaded).toEqual([]);
    expect(map.getCreatureRespawnTime(63)).toBeGreaterThanOrEqual(now + 86400);
  });

  test("pool members go to the pool manager", () => {
    const updates: unknown[] = [];
    MapHooks.poolMgr = {
      initPoolsForMap: () => ({ isSpawnedObject: () => true }),
      isPartOfAPool: (type, spawnId) => (spawnId === 71 ? 9 : 0),
      updatePool: (_data, type, poolId, spawnId) => void updates.push([type, poolId, spawnId]),
    };
    map.saveCreatureRespawnTime(71, getGameTime() - 1);
    map.saveGORespawnTime(71, getGameTime() - 1);
    map.processRespawns();
    expect(updates).toEqual([
      ["Creature", 9, 71],
      ["GameObject", 9, 71],
    ]);
    expect(loaded).toEqual([]);
    expect(map.getCreatureRespawnTime(71)).toBe(0);
  });

  test("a gameobject that already exists is not loaded again", () => {
    mgr.group(5, 0);
    mgr.gameobject(81, 5);
    const go = new FakeGameObject(new FakeObjectMgr(), 81, X, Y, 0);
    map.getGameObjectBySpawnIdStore().set(81, [go]);
    map.saveGORespawnTime(81, getGameTime() - 1);
    map.processRespawns();
    expect(loaded).toEqual([]);
    expect(map.getGORespawnTime(81)).toBe(0);
  });

  test("Update runs the respawn check every five seconds unless compatibility mode is forced", () => {
    mgr.group(5, 0);
    mgr.creature(91, 5);
    map.saveCreatureRespawnTime(91, getGameTime() - 1);
    map.update(1000, 0);
    expect(loaded.map((l) => l.spawnId)).toEqual([91]);
    loaded.length = 0;
    sWorld().setBoolConfig(ServerConfig.CONFIG_RESPAWN_FORCE_COMPATIBILITY_MODE, true);
    try {
      map.saveCreatureRespawnTime(91, getGameTime() - 1);
      map.update(6000, 0);
      expect(loaded).toEqual([]);
    } finally {
      sWorld().setBoolConfig(ServerConfig.CONFIG_RESPAWN_FORCE_COMPATIBILITY_MODE, false);
    }
  });
});

describe("spawn groups", () => {
  test("IsSpawnGroupActive: system groups always, others by default XOR toggled", () => {
    mgr.group(1, SPAWNGROUP_FLAG_SYSTEM);
    mgr.group(2, 0);
    mgr.group(3, SPAWNGROUP_FLAG_MANUAL_SPAWN);
    expect(map.isSpawnGroupActive(1)).toBe(true);
    expect(map.isSpawnGroupActive(2)).toBe(true);
    expect(map.isSpawnGroupActive(3)).toBe(false);
    expect(map.isSpawnGroupActive(99)).toBe(false);
    mgr.creature(1, 3);
    expect(map.spawnGroupSpawn(3)).toBe(true);
    expect(map.isSpawnGroupActive(3)).toBe(true);
    expect(map.spawnGroupDespawn(3)).toBe(true);
    expect(map.isSpawnGroupActive(3)).toBe(false);
    expect(map.spawnGroupDespawn(2)).toBe(true);
    expect(map.isSpawnGroupActive(2)).toBe(false);
    expect(map.spawnGroupSpawn(2)).toBe(true);
    expect(map.isSpawnGroupActive(2)).toBe(true);
  });

  test("SpawnGroupSpawn loads the members that are not alive, due, or in an unloaded grid", () => {
    const now = getGameTime();
    mgr.group(4, SPAWNGROUP_FLAG_MANUAL_SPAWN);
    mgr.creature(101, 4);
    mgr.creature(102, 4);
    mgr.creature(103, 4);
    mgr.gameobject(104, 4);
    const far = mgr.creature(105, 4);
    far.posX = cellCenter(100);
    far.posY = cellCenter(100);
    map.getCreatureBySpawnIdStore().set(101, [new FakeCreature(new FakeObjectMgr(), 101, X, Y, 0)]); // alive
    map.saveCreatureRespawnTime(102, now + 500); // dead, waiting
    expect(map.spawnGroupSpawn(4)).toBe(true);
    expect(loaded.map((l) => `${l.type}:${l.spawnId}`)).toEqual(["creature:103", "gameobject:104"]);
    loaded.length = 0;
    // ignoreRespawn spawns the waiting one and clears its time; force spawns the alive one too
    expect(map.spawnGroupSpawn(4, true, true)).toBe(true);
    expect(loaded.map((l) => l.spawnId)).toEqual([101, 102, 103, 104]);
    expect(map.getCreatureRespawnTime(102)).toBe(0);
  });

  test("SpawnGroupSpawn and Despawn refuse system groups, unknown groups, and other maps", () => {
    mgr.group(1, SPAWNGROUP_FLAG_SYSTEM);
    mgr.group(2, 0, 1);
    expect(map.spawnGroupSpawn(1)).toBe(false);
    expect(map.spawnGroupSpawn(77)).toBe(false);
    expect(map.spawnGroupSpawn(2)).toBe(false);
    expect(map.spawnGroupDespawn(1)).toBe(false);
    expect(map.spawnGroupDespawn(77)).toBe(false);
    expect(map.spawnGroupDespawn(2)).toBe(false);
  });

  test("SpawnGroupDespawn queues the spawned members for removal and can drop their respawn times", () => {
    mgr.group(4, 0);
    mgr.creature(111, 4);
    const spawned = new FakeCreature(new FakeObjectMgr(), 111, X, Y, 0);
    spawned.setMap(map);
    map.addToMap(spawned);
    map.getCreatureBySpawnIdStore().set(111, [spawned]);
    map.saveCreatureRespawnTime(111, getGameTime() + 100);
    expect(map.spawnGroupDespawn(4, true)).toBe(true);
    expect(map.getCreatureRespawnTime(111)).toBe(0);
    expect(spawned.cleanupsCalls).toBe(1);
    // the delayed update removes it from the map
    map.delayedUpdate(0);
    expect(spawned.isInWorld()).toBe(false);
    expect(map.getCreature(spawned.getGUID())).toBeNull();
  });
});
