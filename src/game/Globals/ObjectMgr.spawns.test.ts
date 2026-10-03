import { afterAll, describe, expect, test } from "bun:test";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { ComputeGridCoord } from "../Grids/GridDefines.ts";
import { HighGuid, ObjectGuid } from "../Entities/Object/ObjectGuid.ts";
import { VisibilityDistanceType } from "../Entities/Object/ObjectDefines.ts";
import { SPAWN_TYPE_CREATURE, SPAWN_TYPE_GAMEOBJECT, SPAWNGROUP_FLAG_COMPATIBILITY_MODE, SPAWNGROUP_FLAG_MANUAL_SPAWN, SPAWNGROUP_FLAG_SYSTEM } from "../Maps/SpawnData.ts";
import { addCreatureTemplates, addRows, creatureRow, gameObjectRow, loadSpawnFixture, worldSchema as w } from "../Maps/SpawnData.test-util.ts";
import { ServerConfig } from "../world/world-config-data.ts";
import { sWorld } from "../world/world.ts";
import { MAKE_PAIR32, sObjectMgr } from "./ObjectMgr.ts";

afterAll(() => sObjectMgr.setWorld(null, null));

const gridOf = (x: number, y: number): number => ComputeGridCoord(x, y).getId();

function fixture() {
  const rows = new Map<MySqlTable, Record<string, unknown>[]>();
  addCreatureTemplates(rows, 100, 101, 102, 103, 200);
  addRows(rows, w.creature_template, { entry: 300, name: "no model", minlevel: 1, maxlevel: 1 });
  // map 33 (dungeon: normal + heroic)
  addRows(
    rows,
    w.creature,
    creatureRow(1, 100, 33, 10, 10, { spawnMask: 1 }), // normal only
    creatureRow(2, 100, 33, 20, 20, { spawnMask: 3 }), // normal + heroic
    creatureRow(3, 101, 33, 30, 30, { spawnMask: 2 }), // heroic only
    creatureRow(4, 101, 33, 900, 30, { spawnMask: 1 }), // another grid
    creatureRow(5, 102, 0, -1, -1, { phaseMask: 0, MovementType: 1, wander_distance: 0 }), // phase 0 -> 1, random without distance -> idle
    creatureRow(6, 102, 0, -5, -5), // positive event: not in the grid
    creatureRow(7, 102, 0, -6, -6), // negative event: in the grid
    creatureRow(8, 103, 0, -7, -7), // pool member, chance 100
    creatureRow(9, 103, 0, -8, -8), // pool member, chance 0
    creatureRow(10, 999, 0, 9, 9), // missing template: skipped
    creatureRow(11, 300, 0, 9, 9), // template without model: data kept, not in the grid
    creatureRow(12, 100, 7777, 0, 0), // map not in Map.dbc: skipped
    creatureRow(13, 200, 631, -1, -1, { spawnMask: 15, spawntimesecs: 8 * 86400 }), // raid 7..14 days -> 14 days
    creatureRow(14, 200, 631, -2, -2, { spawnMask: 1 }),
    creatureRow(15, 200, 33, 1, 1, { spawnMask: 1, equipment_id: 5 }), // missing equipment set -> 0
  );
  addRows(rows, w.game_event_creature, { eventEntry: 7, guid: 6 }, { eventEntry: -7, guid: 7 });
  addRows(rows, w.pool_template, { entry: 50, max_limit: 1, description: "test pool" });
  addRows(rows, w.pool_creature, { guid: 8, pool_entry: 50, chance: 100 }, { guid: 9, pool_entry: 50, chance: 0 });
  addRows(rows, w.creature_multispawn, { spawnId: 1, entry: 101 }, { spawnId: 1, entry: 102 }, { spawnId: 1, entry: 103 });

  addRows(rows, w.gameobject_template, { entry: 500, type: 5, displayId: 100, name: "box", size: 1 });
  addRows(rows, w.gameobject_template, { entry: 501, type: 10, displayId: 100, name: "goober", size: 1, Data5: 1 });
  addRows(
    rows,
    w.gameobject,
    gameObjectRow(1, 500, 33, 10, 10, { spawnMask: 2 }),
    gameObjectRow(2, 500, 33, 10, 10, { spawnMask: 3 }),
    gameObjectRow(3, 500, 0, 0, 0, { rotation3: 0.5 }), // non-unit quaternion -> from orientation
    gameObjectRow(4, 500, 0, 0, 0, { state: 3 }), // invalid state: skipped
    gameObjectRow(5, 500, 0, 0, 0, { rotation0: 2 }), // invalid rotation: skipped
    gameObjectRow(6, 501, 0, 3, 3, { spawntimesecs: 0 }),
  );

  addRows(
    rows,
    w.spawn_group_template,
    { groupId: 0, groupName: "Default Group", groupFlags: SPAWNGROUP_FLAG_SYSTEM },
    { groupId: 1, groupName: "Legacy Group", groupFlags: SPAWNGROUP_FLAG_SYSTEM | SPAWNGROUP_FLAG_COMPATIBILITY_MODE },
    { groupId: 2, groupName: "Boss room", groupFlags: SPAWNGROUP_FLAG_MANUAL_SPAWN | 0x100 },
    { groupId: 3, groupName: "System manual", groupFlags: SPAWNGROUP_FLAG_SYSTEM | SPAWNGROUP_FLAG_MANUAL_SPAWN },
  );
  addRows(
    rows,
    w.spawn_group,
    { groupId: 2, spawnType: SPAWN_TYPE_CREATURE, spawnId: 1 },
    { groupId: 2, spawnType: SPAWN_TYPE_GAMEOBJECT, spawnId: 1 },
    { groupId: 2, spawnType: SPAWN_TYPE_CREATURE, spawnId: 5 }, // other map: not added
    { groupId: 3, spawnType: SPAWN_TYPE_CREATURE, spawnId: 2 },
    { groupId: 3, spawnType: SPAWN_TYPE_CREATURE, spawnId: 2 }, // already a member
    { groupId: 9, spawnType: SPAWN_TYPE_CREATURE, spawnId: 3 }, // unknown group
    { groupId: 2, spawnType: 7, spawnId: 3 }, // invalid type
  );
  addRows(
    rows,
    w.linked_respawn,
    { guid: 14, linkedGuid: 13, linkType: 0 }, // creature -> creature in a raid
    { guid: 5, linkedGuid: 7, linkType: 0 }, // continent: not instanceable
    { guid: 3, linkedGuid: 2, linkType: 1 }, // creature -> gameobject (heroic both)
  );
  addRows(
    rows,
    w.creature_addon,
    { guid: 2, path_id: 0, mount: 0, bytes1: 0, bytes2: 0, emote: 0, visibilityDistanceType: VisibilityDistanceType.Large, auras: "" },
    { guid: 4, path_id: 0, mount: 0, bytes1: 0, bytes2: 0, emote: 0, visibilityDistanceType: 9, auras: null },
    { guid: 999, path_id: 0, mount: 0, bytes1: 0, bytes2: 0, emote: 0, visibilityDistanceType: 0, auras: null },
  );
  addRows(rows, w.creature_template_addon, { entry: 101, path_id: 0, mount: 0, bytes1: 0, bytes2: 0, emote: 0, visibilityDistanceType: VisibilityDistanceType.Gigantic, auras: null });
  addRows(rows, w.gameobject_addon, { guid: 2, parent_rotation0: 0, parent_rotation1: 0, parent_rotation2: 0, parent_rotation3: 1, invisibilityType: 3, invisibilityValue: 0 });
  return loadSpawnFixture(rows);
}

describe("ObjectMgr spawn stores", () => {
  fixture();

  test("LoadCreatures keeps every valid row and applies the C++ fixes", () => {
    const store = sObjectMgr.getAllSpawnCreatureData();
    expect([...store.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 14, 15]);
    const five = sObjectMgr.getSpawnCreatureData(5)!;
    expect(five.phaseMask).toBe(1);
    expect(five.movementType).toBe(0);
    expect(five.posX).toBe(-1);
    expect(five.mapid).toBe(0);
    expect(sObjectMgr.getSpawnCreatureData(13)!.spawntimesecs).toBe(14 * 86400);
    expect(sObjectMgr.getSpawnCreatureData(15)!.equipmentId).toBe(0);
    expect(sObjectMgr.getSpawnCreatureData(8)!.poolId).toBe(50);
    // creature_multispawn: two variants, the third is skipped
    const one = sObjectMgr.getSpawnCreatureData(1)!;
    expect([one.id, one.id2, one.id3]).toEqual([100, 101, 102]);
  });

  test("GetGridObjectGuids returns exactly the spawns of a grid for each spawn mode", () => {
    const grid = gridOf(10, 10);
    expect(gridOf(20, 20)).toBe(grid);
    expect(gridOf(900, 30)).not.toBe(grid);
    expect(gridOf(-1, -1)).not.toBe(gridOf(1, 1)); // C++ `CENTER_VAL - x / size`: a grid edge runs through 0
    expect([...sObjectMgr.getGridObjectGuids(33, 0, grid).creatures]).toEqual([1, 2, 15]);
    expect([...sObjectMgr.getGridObjectGuids(33, 1, grid).creatures]).toEqual([2, 3]);
    expect([...sObjectMgr.getGridObjectGuids(33, 2, grid).creatures]).toEqual([]);
    expect([...sObjectMgr.getGridObjectGuids(33, 0, gridOf(900, 30)).creatures]).toEqual([4]);
    expect([...sObjectMgr.getGridObjectGuids(33, 0, grid).gameobjects]).toEqual([2]);
    expect([...sObjectMgr.getGridObjectGuids(33, 1, grid).gameobjects]).toEqual([1, 2]);
    for (let mode = 0; mode < 4; ++mode) expect([...sObjectMgr.getGridObjectGuids(631, mode, gridOf(-1, -1)).creatures]).toEqual(mode === 0 ? [13, 14] : [13]);
    expect(sObjectMgr.getMapObjectGuids(33, 0).size).toBe(2);
    expect(MAKE_PAIR32(33, 1)).toBe(33 | (1 << 16));
  });

  test("the grid store follows the import's shown set: events, pools, and models", () => {
    const continent = [...sObjectMgr.getGridObjectGuids(0, 0, gridOf(-1, -1)).creatures];
    expect(continent).toEqual([5, 7, 8]); // 6 positive event, 9 pool loser, 11 no model
  });

  test("RemoveCreatureFromGrid / AddCreatureToGrid and DeleteCreatureData keep the cells in step", () => {
    const grid = gridOf(10, 10);
    const two = sObjectMgr.getSpawnCreatureData(2)!;
    sObjectMgr.removeCreatureFromGrid(2, two);
    expect([...sObjectMgr.getGridObjectGuids(33, 0, grid).creatures]).toEqual([1, 15]);
    expect([...sObjectMgr.getGridObjectGuids(33, 1, grid).creatures]).toEqual([3]);
    sObjectMgr.addCreatureToGrid(2, two);
    expect([...sObjectMgr.getGridObjectGuids(33, 1, grid).creatures]).toEqual([2, 3]);
  });

  test("LoadGameobjects validates state, rotation, and fixes non-unit quaternions", () => {
    expect([...sObjectMgr.getAllSpawnGameObjectData().keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 6]);
    const three = sObjectMgr.getSpawnGameObjectData(3)!;
    expect(three.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(three.go_state).toBe(1);
    expect(three.animprogress).toBe(100);
    expect(sObjectMgr.isGameObjectStaticTransport(500)).toBe(false);
  });

  test("LoadSpawnGroupTemplates and LoadSpawnGroups", () => {
    expect(sObjectMgr.getSpawnGroupData(2)!.flags).toBe(SPAWNGROUP_FLAG_MANUAL_SPAWN); // invalid bits dropped
    expect(sObjectMgr.getSpawnGroupData(3)!.flags).toBe(SPAWNGROUP_FLAG_SYSTEM); // system + manual -> system
    expect(sObjectMgr.getSpawnGroupData(2)!.mapId).toBe(33);
    expect(sObjectMgr.getSpawnCreatureData(1)!.spawnGroupId).toBe(2);
    expect(sObjectMgr.getSpawnGameObjectData(1)!.spawnGroupId).toBe(2);
    expect(sObjectMgr.getSpawnCreatureData(5)!.spawnGroupId).toBe(0);
    expect(sObjectMgr.getSpawnCreatureData(2)!.spawnGroupId).toBe(3);
    expect(sObjectMgr.getSpawnDataForGroup(2).map((d) => [d.type, d.spawnId])).toEqual([
      [SPAWN_TYPE_CREATURE, 1],
      [SPAWN_TYPE_GAMEOBJECT, 1],
    ]);
    expect(sObjectMgr.getSpawnDataForGroup(3)).toEqual([]); // system groups are not linked
    expect(sObjectMgr.getDefaultSpawnGroup().name).toBe("Default Group");
    expect(sObjectMgr.getLegacySpawnGroup().flags).toBe(SPAWNGROUP_FLAG_SYSTEM | SPAWNGROUP_FLAG_COMPATIBILITY_MODE);
    sObjectMgr.onDeleteSpawnData(sObjectMgr.getSpawnCreatureData(1)!);
    expect(sObjectMgr.getSpawnDataForGroup(2).map((d) => d.spawnId)).toEqual([1]);
  });

  test("LoadLinkedRespawn keeps links on instanceable maps with a shared spawn mask", () => {
    const slave = ObjectGuid.Create(HighGuid.Unit, 200, 14);
    expect(sObjectMgr.getLinkedRespawnGuid(slave)).toBe(ObjectGuid.Create(HighGuid.Unit, 200, 13));
    expect(sObjectMgr.getLinkedRespawnGuid(ObjectGuid.Create(HighGuid.Unit, 102, 5))).toBe(0n);
    expect(sObjectMgr.getLinkedRespawnGuid(ObjectGuid.Create(HighGuid.Unit, 101, 3))).toBe(ObjectGuid.Create(HighGuid.GameObject, 500, 2));
  });

  test("addons: visibility distance type, invalid values, and missing spawns", () => {
    expect(sObjectMgr.getCreatureAddon(2)!.visibilityDistanceType).toBe(VisibilityDistanceType.Large);
    expect(sObjectMgr.getCreatureAddon(4)!.visibilityDistanceType).toBe(VisibilityDistanceType.Normal);
    expect(sObjectMgr.getCreatureAddon(999)).toBeNull();
    expect(sObjectMgr.getCreatureTemplateAddon(101)!.visibilityDistanceType).toBe(VisibilityDistanceType.Gigantic);
    const goAddon = sObjectMgr.getGameObjectAddon(2)!;
    expect(goAddon.invisibilityType).toBe(3);
    expect(goAddon.InvisibilityValue).toBe(1); // type without value -> 1
  });

  test("script names and spawn ids", () => {
    expect(sObjectMgr.getScriptId("")).toBe(0);
    expect(sObjectMgr.getScriptId("npc_missing")).toBe(0);
    expect(sObjectMgr.generateCreatureSpawnId()).toBe(16);
    expect(sObjectMgr.generateGameObjectSpawnId()).toBe(7);
  });

  test("Calculate.*.Zone.Area.Data writes the zone and area of every spawn back to its table", () => {
    const statements: { sql: string; params: unknown[] }[] = [];
    const fakeDb = {
      $client: {
        unsafe: (sql: string, params: unknown[]) => {
          statements.push({ sql, params });
          return Promise.resolve([]);
        },
      },
    } as never;
    const world = sObjectMgr.worldData();
    const tables = sObjectMgr.worldTables();
    const asked: unknown[][] = [];
    sObjectMgr.setWorld(world, tables, fakeDb);
    sObjectMgr.zoneAreaResolver = (phaseMask, mapId, x, y, z) => {
      asked.push([phaseMask, mapId, x, y, z]);
      return mapId === 33 ? { zoneid: 100 + mapId, areaid: 200 + mapId } : null;
    };
    try {
      // off: nothing is asked
      sObjectMgr.loadCreatures();
      expect(asked).toHaveLength(0);

      sWorld().setBoolConfig(ServerConfig.CONFIG_CALCULATE_CREATURE_ZONE_AREA_DATA, true);
      sObjectMgr.loadCreatures();
      expect(asked.length).toBeGreaterThan(0);
      // the map layer answered for map 33 only (no Map.dbc row for the others in this fixture)
      const written = statements.filter((statement) => statement.sql.startsWith("UPDATE creature SET zoneId"));
      expect(written.map((statement) => statement.params[2]).sort()).toEqual([1, 15, 2, 3, 4].sort());
      expect(written[0]!.params.slice(0, 2)).toEqual([133, 233]);
      expect(statements.some((statement) => statement.sql.startsWith("UPDATE gameobject"))).toBe(false);

      sWorld().setBoolConfig(ServerConfig.CONFIG_CALCULATE_GAMEOBJECT_ZONE_AREA_DATA, true);
      sObjectMgr.loadGameobjects();
      expect(statements.filter((statement) => statement.sql.startsWith("UPDATE gameobject SET zoneId")).map((statement) => statement.params[2]).sort()).toEqual([1, 2]);
    } finally {
      sWorld().setBoolConfig(ServerConfig.CONFIG_CALCULATE_CREATURE_ZONE_AREA_DATA, false);
      sWorld().setBoolConfig(ServerConfig.CONFIG_CALCULATE_GAMEOBJECT_ZONE_AREA_DATA, false);
      sObjectMgr.zoneAreaResolver = null;
      sObjectMgr.setWorld(world, tables);
    }
  });
});
