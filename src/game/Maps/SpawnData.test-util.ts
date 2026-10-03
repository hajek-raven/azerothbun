/**
 * Test fixtures for the spawn stores: a few maps in `Map.dbc` / `MapDifficulty.dbc`, world rows through
 * `WorldTables.fromRows`, and `sObjectMgr` pointed at them with `loadSpawnStores()` run.
 */
import type { MySqlTable } from "drizzle-orm/mysql-core";
import * as w from "../../database/schema/world.ts";
import { WorldTables } from "../../database/world-tables.ts";
import { WorldData } from "../../data/world.ts";
import { sGameObjectDisplayInfoStore, sMapDifficultyStore, sMapStore } from "../DataStores/DBCStores.ts";
import { sObjectMgr } from "../Globals/ObjectMgr.ts";
import { setMapMgrWorld } from "./MapMgr.ts";

/** Map 0 (continent), 33 (dungeon with normal and heroic), 631 (raid with 4 difficulties). */
export function setUpTestMaps(): void {
  const map = (MapID: number, map_type: number) => ({
    MapID,
    map_type,
    Flags: 0,
    name: [`map ${MapID}`],
    linked_zone: 0,
    multimap_id: 0,
    entrance_map: -1,
    entrance_x: 0,
    entrance_y: 0,
    expansionID: 0,
    maxPlayers: 0,
  });
  sMapStore.set(0, map(0, 0));
  sMapStore.set(33, map(33, 1));
  sMapStore.set(631, map(631, 2));
  let id = 1;
  const difficulty = (MapId: number, Difficulty: number) =>
    sMapDifficultyStore.set(id++, { MapId, Difficulty, areaTriggerText: "", resetTime: 0, maxPlayers: 0 });
  difficulty(0, 0);
  difficulty(33, 0);
  difficulty(33, 1);
  for (let d = 0; d < 4; ++d) difficulty(631, d);
  sGameObjectDisplayInfoStore.set(100, { Displayid: 100, filename: "box.m2", minX: -1, minY: -1, minZ: 0, maxX: 1, maxY: 1, maxZ: 2 });
}

/** A `creature_template` row and a model (`WorldData` hides spawns of templates without a model). */
export function creatureTemplateRows(entry: number, extra: Record<string, unknown> = {}): [Record<string, unknown>, Record<string, unknown>] {
  return [
    { entry, name: `creature ${entry}`, minlevel: 10, maxlevel: 10, unit_class: 1, faction: 35, speed_walk: 1, speed_run: 1.14286, ...extra },
    { CreatureID: entry, Idx: 0, CreatureDisplayID: 1000 + entry, DisplayScale: 1, Probability: 1 },
  ];
}

/** `creature` row with the C++ column names. */
export function creatureRow(guid: number, id: number, map: number, x: number, y: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { guid, id, map, position_x: x, position_y: y, position_z: 10, orientation: 1, spawnMask: 1, phaseMask: 1, spawntimesecs: 120, ...extra };
}

/** `gameobject` row with the C++ column names (unit rotation around Z). */
export function gameObjectRow(guid: number, id: number, map: number, x: number, y: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { guid, id, map, position_x: x, position_y: y, position_z: 5, orientation: 0, rotation0: 0, rotation1: 0, rotation2: 0, rotation3: 1, spawnMask: 1, phaseMask: 1, spawntimesecs: 300, animprogress: 100, state: 1, ...extra };
}

/**
 * Builds the tables, the `WorldData` import over them, points `sObjectMgr` at both, and runs the spawn loaders.
 * `rows` maps a table to its rows; creature templates and their models are added with `creatureTemplateRows`.
 */
export function loadSpawnFixture(rows: Map<MySqlTable, Record<string, unknown>[]>): { tables: WorldTables; world: WorldData } {
  setUpTestMaps();
  // MapMgr::IsValidMAP wants an instance_template row for the dungeon and raid maps
  const instances = rows.get(w.instance_template) ?? [];
  for (const map of [33, 631]) if (!instances.some((row) => row.map === map)) instances.push({ map, parent: 0, script: "", allowMount: 0 });
  rows.set(w.instance_template, instances);
  const tables = WorldTables.fromRows([...rows.entries()]);
  setMapMgrWorld(tables);
  const world = new WorldData(tables);
  sObjectMgr.setWorld(world, tables);
  sObjectMgr.loadSpawnStores();
  return { tables, world };
}

/** Adds rows to a table in the `loadSpawnFixture` map. */
export function addRows(rows: Map<MySqlTable, Record<string, unknown>[]>, table: MySqlTable, ...values: Record<string, unknown>[]): void {
  const list = rows.get(table) ?? [];
  list.push(...values);
  rows.set(table, list);
}

/** Adds creature templates (with models) for the entries. */
export function addCreatureTemplates(rows: Map<MySqlTable, Record<string, unknown>[]>, ...entries: number[]): void {
  for (const entry of entries) {
    const [template, model] = creatureTemplateRows(entry);
    addRows(rows, w.creature_template, template);
    addRows(rows, w.creature_template_model, model);
  }
}

export { w as worldSchema };

/**
 * A map for `LoadFromDB` tests: the `MapLike` members the spawn objects call, real by-spawn-id and object stores, and
 * `AddToMap` that adds to the world. Any other member is a no-op.
 */
const OPTIONAL_MAP_HOOKS = new Set<string | symbol>(["creatureRelocation", "gameObjectRelocation", "getUnit", "getGameObject", "scheduleCreatureRespawn", "then"]);

export function fakeSpawnMap(id: number, spawnMode = 0, opts: { dungeon?: boolean; respawnTimes?: Map<number, number>; goRespawnTimes?: Map<number, number> } = {}) {
  let lowGuid = 0;
  const objects = new Map<bigint, unknown>();
  const creatureBySpawnId = new Map<number, unknown[]>();
  const gameObjectBySpawnId = new Map<number, unknown[]>();
  const added: unknown[] = [];
  const removeList: unknown[] = [];
  const respawnTimes = opts.respawnTimes ?? new Map<number, number>();
  const goRespawnTimes = opts.goRespawnTimes ?? new Map<number, number>();
  const target = {
    objects,
    added,
    removeList,
    respawnTimes,
    goRespawnTimes,
    getId: () => id,
    getInstanceId: () => 0,
    getSpawnMode: () => spawnMode,
    getEntry: () => sMapStore.lookupEntry(id),
    isDungeon: () => opts.dungeon ?? false,
    isRaid: () => false,
    getVisibilityRange: () => 100,
    generateLowGuid: () => ++lowGuid,
    getCreatureBySpawnIdStore: () => creatureBySpawnId,
    getGameObjectBySpawnIdStore: () => gameObjectBySpawnId,
    getObjectsStore: () => ({ insert: (guid: bigint, obj: unknown) => objects.set(guid, obj), remove: (guid: bigint) => objects.delete(guid) }),
    getCreatureRespawnTime: (dbGuid: number) => respawnTimes.get(dbGuid) ?? 0,
    saveCreatureRespawnTime: (dbGuid: number, t: number) => respawnTimes.set(dbGuid, t),
    removeCreatureRespawnTime: (dbGuid: number) => respawnTimes.delete(dbGuid),
    getGORespawnTime: (dbGuid: number) => goRespawnTimes.get(dbGuid) ?? 0,
    saveGORespawnTime: (dbGuid: number, t: number) => goRespawnTimes.set(dbGuid, t),
    removeGORespawnTime: (dbGuid: number) => goRespawnTimes.delete(dbGuid),
    getZoneAndAreaId: () => ({ zoneid: 12, areaid: 9 }),
    getFullTerrainStatusForPosition: () => ({ areaId: 9, floorZ: 0, outdoors: true, liquidInfo: { Entry: 0, Flags: 0, Level: -100000, DepthLevel: -100000, Status: 0 } }),
    getHeight: () => 0,
    isCellMarked: () => false,
    addObjectToRemoveList: (obj: unknown) => removeList.push(obj),
    applyDynamicModeRespawnScaling: (_obj: unknown, respawnDelay: number) => respawnDelay,
    getLinkedRespawnTime: () => 0,
    addToMap: (obj: { addToWorld(): void }) => {
      added.push(obj);
      obj.addToWorld();
      return true;
    },
  };
  return new Proxy(target, {
    // optional Map hooks the spawn objects probe for stay absent; any other member is a no-op
    get: (t, key) => (key in t ? t[key as keyof typeof t] : OPTIONAL_MAP_HOOKS.has(key) ? undefined : () => undefined),
  }) as typeof target & import("../Grids/MapLike.ts").MapLike;
}
