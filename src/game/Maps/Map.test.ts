import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HighGuid, ObjectGuid } from "../Entities/Object/ObjectGuid.ts";
import { MAP_OBJECT_CELL_MOVE_ACTIVE, MAP_OBJECT_CELL_MOVE_NONE, UpdateState } from "../Entities/Object/Object.ts";
import { Cell } from "../Grids/Cells/Cell.ts";
import { GridCoord, SIZE_OF_GRIDS } from "../Grids/GridDefines.ts";
import { GridObjectLoaderHooks } from "../Grids/GridObjectLoader.ts";
import { FakeCorpse, FakeCreature, FakeGameObject, FakeObjectMgr } from "../Grids/Grids.test-util.ts";
import { resetGameTimeForTests } from "../time/game-time.ts";
import {
  BattlegroundMap,
  CAN_ENTER,
  InstanceMap,
  Map,
  MapHooks,
  MapScriptHooks,
  MapStoredObjectTypesContainer,
  RespawnQueue,
  sMapRespawnStore,
  UPDATABLE_OBJECT_LIST_RECHECK_TIMER,
} from "./Map.ts";
import { cellCenter, MAP_ARENA, MAP_BATTLEGROUND, MAP_COMMON, MAP_INSTANCE, MAP_RAID, playerOn, setMapEntry, TEST_MAP_ID } from "./Map.test-util.ts";
import { SPAWN_TYPE_CREATURE, SPAWN_TYPE_GAMEOBJECT } from "./SpawnData.ts";

const savedHooks = { ...MapHooks };
const savedScriptHooks = { ...MapScriptHooks };
const savedLoaderHooks = { ...GridObjectLoaderHooks };

let store: FakeObjectMgr;
let map: Map;

/** A creature standing in cell (cx, cy) that is on `map` and not yet added to the grid. */
function creatureAt(guid: number, cx: number, cy: number): FakeCreature {
  const creature = new FakeCreature(store, guid, cellCenter(cx), cellCenter(cy), 5);
  creature.setMap(map);
  return creature;
}

beforeEach(() => {
  resetGameTimeForTests();
  store = new FakeObjectMgr();
  GridObjectLoaderHooks.objectMgr = store;
  GridObjectLoaderHooks.createCreature = () => new FakeCreature(store);
  GridObjectLoaderHooks.createGameObject = () => new FakeGameObject(store);
  setMapEntry(TEST_MAP_ID, MAP_COMMON);
  sMapRespawnStore.clear();
  map = new Map(TEST_MAP_ID, 0, 0);
});

afterEach(() => {
  map.unloadAll();
  Object.assign(MapHooks, savedHooks);
  Object.assign(MapScriptHooks, savedScriptHooks);
  Object.assign(GridObjectLoaderHooks, savedLoaderHooks);
});

describe("Map identity", () => {
  test("a base map is its own parent and reads its Map.dbc row", () => {
    expect(map.getId()).toBe(TEST_MAP_ID);
    expect(map.getInstanceId()).toBe(0);
    expect(map.getSpawnMode()).toBe(0);
    expect(map.getParent()).toBe(map);
    expect(map.getEntry()?.MapID).toBe(TEST_MAP_ID);
    expect(map.getMapName()).toBe(`Test map ${TEST_MAP_ID}`);
    expect(map.isWorldMap()).toBe(true);
    expect(map.instanceable()).toBe(false);
    expect(map.isDungeon()).toBe(false);
    expect(map.getVisibilityRange()).toBe(100);
    expect(map.cannotEnter(null as never)).toBe(CAN_ENTER);
  });

  test("the map type decides the kind flags", () => {
    const kinds: [number, string[]][] = [
      [MAP_INSTANCE, ["instanceable", "isDungeon", "isNonRaidDungeon"]],
      [MAP_RAID, ["instanceable", "isDungeon", "isRaid"]],
      [MAP_BATTLEGROUND, ["instanceable", "isBattleground", "isBattlegroundOrArena"]],
      [MAP_ARENA, ["instanceable", "isBattleArena", "isBattlegroundOrArena"]],
    ];
    for (const [type, expected] of kinds) {
      setMapEntry(901, type);
      const m = new Map(901, 0, 0);
      for (const name of ["instanceable", "isDungeon", "isNonRaidDungeon", "isRaid", "isBattleground", "isBattleArena", "isBattlegroundOrArena", "isWorldMap"] as const) {
        expect(m[name]()).toBe(expected.includes(name));
      }
    }
  });

  test("difficulty helpers follow the spawn mode", () => {
    setMapEntry(902, MAP_RAID);
    const raid25h = new Map(902, 0, 3);
    expect(raid25h.isHeroic()).toBe(true);
    expect(raid25h.is25ManRaid()).toBe(true);
    expect(raid25h.isRaidOrHeroicDungeon()).toBe(true);
    expect(new Map(902, 0, 1).is25ManRaid()).toBe(true);
    expect(new Map(902, 0, 0).is25ManRaid()).toBe(false);
    setMapEntry(903, MAP_INSTANCE);
    expect(new Map(903, 0, 1).isHeroic()).toBe(true);
    expect(new Map(903, 0, 0).isHeroic()).toBe(false);
    expect(new Map(903, 0, 0).isRegularDifficulty()).toBe(true);
  });

  test("the entrance position comes from the Map.dbc row", () => {
    expect(map.getEntrancePos()).toBeNull();
    setMapEntry(904, MAP_INSTANCE, { entrance_map: 0, entrance_x: 1.5, entrance_y: -2.5 });
    expect(new Map(904, 0, 0).getEntrancePos()).toEqual({ mapid: 0, x: 1.5, y: -2.5 });
  });

  test("InstanceMap and BattlegroundMap set their own visibility range", () => {
    setMapEntry(603, MAP_RAID);
    const instance = new InstanceMap(603, 5, 0, map);
    expect(instance.getVisibilityRange()).toBe(200);
    expect(instance.getInstanceId()).toBe(5);
    expect(instance.getParent()).toBe(map);
    setMapEntry(910, MAP_ARENA);
    expect(new BattlegroundMap(910, 3, map, 0).getVisibilityRange()).toBe(30);
    setMapEntry(911, MAP_BATTLEGROUND);
    expect(new BattlegroundMap(911, 3, map, 0).getVisibilityRange()).toBe(250);
    setMapEntry(609, MAP_COMMON);
    expect(new Map(609, 0, 0).getVisibilityRange()).toBe(125);
  });
});

describe("Map grids", () => {
  test("EnsureGridCreated creates, LoadGrid loads, and the counts follow", () => {
    const x = cellCenter(386);
    const y = cellCenter(260);
    expect(map.isGridCreated(x, y)).toBe(false);
    expect(map.isGridLoaded(x, y)).toBe(false);

    map.ensureGridCreated(new GridCoord(48, 32));
    expect(map.isGridCreated(x, y)).toBe(true);
    expect(map.isGridCreated(new GridCoord(48, 32))).toBe(true);
    expect(map.isGridLoaded(x, y)).toBe(false);
    expect(map.getCreatedGridsCount()).toBe(1);
    expect(map.getLoadedGridsCount()).toBe(0);

    map.loadGrid(x, y);
    expect(map.isGridLoaded(new GridCoord(48, 32))).toBe(true);
    expect(map.getLoadedGridsCount()).toBe(1);
    // no .map file for the test map id: no terrain
    expect(map.getGridTerrainData(x, y)).toBeNull();
    expect(map.getGridTerrainDataSharedPtr(new GridCoord(48, 32))).toBeNull();
    expect(map.getGridHeight(x, y)).toBe(-100000);
    expect(map.getMinHeight(x, y)).toBe(-500);
    expect(map.getWaterLevel(x, y)).toBe(-100000);
  });

  test("LoadGridsInRange loads the grids around a position, within one grid size", () => {
    const player = playerOn(map, 1, cellCenter(386), cellCenter(260));
    map.loadGridsInRange(player, 5000);
    // the radius is clipped to SIZE_OF_GRIDS: the 3x3 grids around cell (400, 260) at most
    expect(map.getLoadedGridsCount()).toBeGreaterThan(0);
    expect(map.getLoadedGridsCount()).toBeLessThanOrEqual(9);
    expect(map.isGridLoaded(player.getPositionX(), player.getPositionY())).toBe(true);
    const before = map.getLoadedGridsCount();
    map.loadGridsInRange(player, 5000);
    expect(map.getLoadedGridsCount()).toBe(before);
    expect(SIZE_OF_GRIDS).toBeGreaterThan(500);
  });

  test("grids load their spawns through GridObjectLoader, and unload removes them", () => {
    const spawn = { guid: 77, id: 5, map: TEST_MAP_ID, x: cellCenter(386), y: cellCenter(260), z: 3, phaseMask: 1, spawnGroupId: 0, poolId: 0 };
    store.add("creature", spawn, 0, 32 * 64 + 48);
    map.loadGrid(cellCenter(386), cellCenter(260));
    const grid = map.getGridTerrainData(cellCenter(386), cellCenter(260));
    expect(grid).toBeNull();
    expect(map.getSize()).toBe(1);
    map.unloadAll();
    expect(map.getSize()).toBe(0);
    expect(map.isGridCreated(cellCenter(386), cellCenter(260))).toBe(false);
  });

  test("visit does nothing for a grid that is not loaded", () => {
    const seen: unknown[] = [];
    const visitor = { i_visitor: { visitCreatureMap: (m: unknown) => seen.push(m) }, containerType: "GridTypeMapContainer" as const, visit: () => {} };
    map.visit(new Cell(cellCenter(386), cellCenter(260)), visitor as never);
    expect(seen).toHaveLength(0);
  });
});

describe("Map objects", () => {
  test("AddToMap puts a creature in its cell, the object store, and the pending update list", () => {
    const creature = creatureAt(10, 386, 260);
    expect(map.addToMap(creature)).toBe(true);
    expect(creature.isInWorld()).toBe(true);
    expect(creature.isInGrid()).toBe(true);
    // a creature is not active: its grid is created but not loaded
    expect(map.isGridCreated(creature.getPositionX(), creature.getPositionY())).toBe(true);
    expect(map.isGridLoaded(creature.getPositionX(), creature.getPositionY())).toBe(false);
    expect(map.getCreature(creature.getGUID())).toBe(creature);
    expect(map.getObjectsStore().size("Creature")).toBe(1);
    expect(creature.getCurrentCell().equals(new Cell(creature.getPositionX(), creature.getPositionY()))).toBe(true);
    expect(creature.getUpdateState()).toBe(UpdateState.PendingAdd);
    // adding it again only refreshes its visibility
    expect(map.addToMap(creature)).toBe(true);
    expect(map.getObjectsStore().size("Creature")).toBe(1);

    map.removeFromMap(creature, false);
    expect(creature.isInWorld()).toBe(false);
    expect(creature.isInGrid()).toBe(false);
    expect(map.getCreature(creature.getGUID())).toBeNull();
  });

  test("AddToMap loads the grid of an active object", () => {
    const creature = creatureAt(11, 386, 260);
    creature.setActive(true);
    map.addToMap(creature);
    expect(map.isGridLoaded(creature.getPositionX(), creature.getPositionY())).toBe(true);
  });

  test("an object with invalid coordinates is not added", () => {
    const creature = new FakeCreature(store, 12, -1e9, 0, 0);
    creature.setMap(map);
    expect(map.addToMap(creature)).toBe(false);
    expect(creature.isInWorld()).toBe(false);
  });

  test("RemoveFromMap with remove drops the object from the update list", () => {
    const creature = creatureAt(13, 386, 260);
    creature.setActive(true);
    map.addToMap(creature);
    map.update(100, 100);
    expect(map.getUpdatableObjectsCount()).toBe(1);
    expect(creature.getUpdateState()).toBe(UpdateState.Updating);
    map.removeFromMap(creature, true);
    expect(map.getUpdatableObjectsCount()).toBe(0);
    expect(creature.getUpdateState()).toBe(UpdateState.NotUpdating);
  });

  test("gameobjects and corpses go to their stores", () => {
    const go = new FakeGameObject(store, 20, cellCenter(386), cellCenter(260), 1);
    go.setMap(map);
    expect(map.addToMap(go)).toBe(true);
    expect(map.getGameObject(go.getGUID())).toBe(go);

    const corpse = new FakeCorpse(21, cellCenter(387), cellCenter(260));
    corpse.setMap(map);
    map.addCorpse(corpse);
    const gridId = 32 * 64 + 48;
    expect(map.getCorpsesInGrid(gridId)?.has(corpse)).toBe(true);
    map.removeCorpse(corpse);
    expect(map.getCorpsesInGrid(gridId)?.has(corpse)).toBe(false);
  });

  test("generateLowGuid counts per high guid and refuses global guids", () => {
    expect(map.generateLowGuid(HighGuid.Unit)).toBe(1);
    expect(map.generateLowGuid(HighGuid.Unit)).toBe(2);
    expect(map.generateLowGuid(HighGuid.GameObject)).toBe(1);
    expect(() => map.generateLowGuid(HighGuid.Player)).toThrow();
    expect(ObjectGuid.Create(HighGuid.Unit, 5, 2)).not.toBe(0n);
  });
});

describe("MapStoredObjectTypesContainer", () => {
  test("insert, find, size, and remove by guid", () => {
    const c = new MapStoredObjectTypesContainer();
    const creature = new FakeCreature(store, 1, 0, 0, 0);
    const go = new FakeGameObject(store, 2, 0, 0, 0);
    c.insert(creature.getGUID(), creature);
    c.insert(go.getGUID(), go);
    expect(c.find("Creature", creature.getGUID())).toBe(creature);
    expect(c.find("GameObject", go.getGUID())).toBe(go);
    expect(c.find("Creature", go.getGUID())).toBeNull();
    expect(c.size("Creature")).toBe(1);
    expect([...c.values("GameObject")]).toEqual([go]);
    c.remove(creature.getGUID());
    expect(c.size("Creature")).toBe(0);
  });
});

describe("RespawnQueue", () => {
  test("orders by time, then type, then spawn id, and holds one of each", () => {
    const q = new RespawnQueue();
    q.insert({ respawnTime: 20, type: SPAWN_TYPE_GAMEOBJECT, spawnId: 1 });
    q.insert({ respawnTime: 10, type: SPAWN_TYPE_GAMEOBJECT, spawnId: 5 });
    q.insert({ respawnTime: 10, type: SPAWN_TYPE_CREATURE, spawnId: 9 });
    q.insert({ respawnTime: 10, type: SPAWN_TYPE_CREATURE, spawnId: 2 });
    q.insert({ respawnTime: 10, type: SPAWN_TYPE_CREATURE, spawnId: 2 });
    expect(q.toArray().map((e) => [e.respawnTime, e.type, e.spawnId])).toEqual([
      [10, SPAWN_TYPE_CREATURE, 2],
      [10, SPAWN_TYPE_CREATURE, 9],
      [10, SPAWN_TYPE_GAMEOBJECT, 5],
      [20, SPAWN_TYPE_GAMEOBJECT, 1],
    ]);
    q.erase({ respawnTime: 10, type: SPAWN_TYPE_CREATURE, spawnId: 9 });
    expect(q.begin()).toEqual({ respawnTime: 10, type: SPAWN_TYPE_CREATURE, spawnId: 2 });
    expect(q.size()).toBe(3);
    q.clear();
    expect(q.empty()).toBe(true);
  });
});

describe("Map move lists and relocation", () => {
  test("CreatureRelocation to another cell queues the move, and MoveAllCreaturesInMoveList applies it", () => {
    const creature = creatureAt(30, 386, 260);
    map.addToMap(creature);
    const before = creature.getCurrentCell();
    map.creatureRelocation(creature, cellCenter(391), cellCenter(260), 5, 1);
    expect(creature._moveState).toBe(MAP_OBJECT_CELL_MOVE_ACTIVE);
    // the cell is only updated when the move list runs
    expect(creature.getCurrentCell().equals(before)).toBe(true);
    map.moveAllCreaturesInMoveList();
    expect(creature._moveState).toBe(MAP_OBJECT_CELL_MOVE_NONE);
    expect(creature.getCurrentCell().cellX()).toBe(new Cell(cellCenter(391), cellCenter(260)).cellX());
    expect(creature.isInGrid()).toBe(true);
  });

  test("a relocation inside the same cell does not queue a move", () => {
    const creature = creatureAt(31, 386, 260);
    map.addToMap(creature);
    map.creatureRelocation(creature, creature.getPositionX() + 0.1, creature.getPositionY(), 5, 0);
    expect(creature._moveState).toBe(MAP_OBJECT_CELL_MOVE_NONE);
  });

  test("a creature that moves back before the list runs stays where it is", () => {
    const creature = creatureAt(32, 386, 260);
    map.addToMap(creature);
    const home = creature.getCurrentCell();
    map.creatureRelocation(creature, cellCenter(395), cellCenter(260), 5, 0);
    map.creatureRelocation(creature, creature.getPositionX() === 0 ? 0 : cellCenter(386), cellCenter(260), 5, 0);
    map.moveAllCreaturesInMoveList();
    expect(creature.getCurrentCell().equals(home)).toBe(true);
  });

  test("the pending update list holds an active object until the recheck passes", () => {
    const creature = creatureAt(33, 386, 260);
    creature.setActive(true);
    map.addToMap(creature);
    map.update(1, 1);
    expect(map.getUpdatableObjectsCount()).toBe(1);
    creature.setActive(false);
    // the recheck interval has not passed: the object stays on the list
    map.update(100, 100);
    expect(map.getUpdatableObjectsCount()).toBe(1);
    map.update(UPDATABLE_OBJECT_LIST_RECHECK_TIMER, 100);
    expect(map.getUpdatableObjectsCount()).toBe(0);
  });
});

describe("Map members of other topics", () => {
  test("summons, map scripts, transports, and weather are documented no-ops", () => {
    expect(map.summonCreature(1, { getPositionX: () => 0, getPositionY: () => 0, getPositionZ: () => 0, getOrientation: () => 0 })).toBeNull();
    expect(map.summonGameObject(1, 0, 0, 0, 0)).toBeNull();
    map.summonCreatureGroup(1);
    map.summonGameObjectGroup(1);
    map.scriptsStart({}, 1, null, null);
    map.scriptCommandStart({}, 0, null, null);
    expect(map.getTransportForPos(1, 0, 0, 0)).toBeNull();
    expect(map.getTransport(ObjectGuid.Create(HighGuid.Transport, 5, 1))).toBeNull();
    expect(map.getTransport(ObjectGuid.Create(HighGuid.Unit, 5, 1))).toBeNull();
    expect(map.getPet(ObjectGuid.Create(HighGuid.Pet, 5, 1))).toBeNull();
    expect(map.getDynamicObject(ObjectGuid.Create(HighGuid.DynamicObject, 5, 1))).toBeNull();
    expect(map.getOrGenerateZoneDefaultWeather(1)).toBeNull();
    expect(map.allTransportsEmpty()).toBe(true);
    map.allTransportsRemovePassengers();
    map.updateIteratorBack(null as never);
    expect(map.toMapInstanced()).toBeNull();
    expect(map.toInstanceMap()).toBeNull();
    expect(map.toBattlegroundMap()).toBeNull();
    expect(map.getDebugInfo()).toBe(`Id: ${TEST_MAP_ID} InstanceId: 0 Difficulty: 0 HasPlayers: false`);
  });

  test("an instance map is an InstanceMap, a battleground map a BattlegroundMap", () => {
    setMapEntry(950, MAP_RAID);
    const instance = new InstanceMap(950, 3, 0, map);
    expect(instance.toInstanceMap()).toBe(instance);
    expect(instance.toBattlegroundMap()).toBeNull();
    setMapEntry(951, MAP_ARENA);
    const arena = new BattlegroundMap(951, 3, map, 0);
    expect(arena.toBattlegroundMap()).toBe(arena);
    expect(arena.toInstanceMap()).toBeNull();
  });

  test("destroying a map kills its pending events without running them", () => {
    let ran = 0;
    map.Events.addEventAtOffset(() => void ++ran, 1000);
    map.destroy();
    map.Events.update(5000);
    expect(ran).toBe(0);
  });

  test("ScheduleCreatureRespawn respawns the creature when its time comes", () => {
    const creature = creatureAt(90, 386, 260) as FakeCreature & { respawn?: () => void };
    map.addToMap(creature);
    let respawned = 0;
    creature.respawn = () => void ++respawned;
    map.scheduleCreatureRespawn(creature.getGUID(), 3000);
    map.update(1000, 1000);
    expect(respawned).toBe(0);
    map.update(2500, 2500);
    expect(respawned).toBe(1);
  });
});
