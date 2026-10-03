/**
 * Test helpers for the code that runs on the map layer: a creature locator over spawn rows (what the combat tests used the
 * spawn index for), the map layer set up over world data, and the tick that runs the visibility delays. Not a test file itself.
 */
import type { CreatureSpawn, WorldData } from "../data/world.ts";
import { sMapStore } from "../game/DataStores/DBCStores.ts";
import { Creature } from "../game/Entities/Creature/Creature.ts";
import { GameObject } from "../game/Entities/GameObject/GameObject.ts";
import { WorldObject } from "../game/Entities/Object/Object.ts";
import { sObjectMgr } from "../game/Globals/ObjectMgr.ts";
import { GridObjectLoaderHooks } from "../game/Grids/GridObjectLoader.ts";
import { GridTerrainLoaderHooks } from "../game/Grids/GridTerrainLoader.ts";
import { MapHooks } from "../game/Maps/Map.ts";
import { setMapEntry, MAP_COMMON } from "../game/Maps/Map.test-util.ts";
import { sMapMgr } from "../game/Maps/MapMgr.ts";
import { setupMaps } from "../game/Maps/MapSetup.ts";
import type { CreatureLocator, Place } from "./map-world.ts";

const CELL_SIZE = 533.33333 / 8;

/**
 * The creatures of a world as a locator over their spawn rows (the old spawn index): no map, no grids. For the tests of
 * the combat code that run without the map layer.
 */
export function staticCreatureLocator(world: WorldData): CreatureLocator {
  const cells = new Map<string, CreatureSpawn[]>();
  const cellOf = (value: number): number => Math.floor(value / CELL_SIZE);
  for (const spawn of world.creaturesOnMap) {
    const key = `${spawn.map}:${cellOf(spawn.x)}:${cellOf(spawn.y)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(spawn);
    else cells.set(key, [spawn]);
  }
  return {
    creaturesNear(place: Place, radius: number): CreatureSpawn[] {
      const span = Math.ceil(radius / CELL_SIZE);
      const cx = cellOf(place.x);
      const cy = cellOf(place.y);
      const found: CreatureSpawn[] = [];
      for (let dx = -span; dx <= span; dx++) {
        for (let dy = -span; dy <= span; dy++) {
          for (const spawn of cells.get(`${place.map}:${cx + dx}:${cy + dy}`) ?? []) {
            const ddx = spawn.x - place.x;
            const ddy = spawn.y - place.y;
            const ddz = spawn.z - place.z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= radius * radius) found.push(spawn);
          }
        }
      }
      return found;
    },
    findCreature: () => null,
  };
}

const savedHooks = {
  map: { ...MapHooks },
  loader: { ...GridObjectLoaderHooks },
  terrain: { ...GridTerrainLoaderHooks },
  creatureGuid: Creature.dbGuidLow,
  gameObjectGuid: GameObject.dbGuidLow,
  visibility: WorldObject.DynamicVisibilityMgr,
};

/**
 * Sets the map layer up over `world` (its spawn rows are the spawns of the grids): `Map.dbc` rows for the continents when the
 * DBC stores are not loaded, the hooks, and the spawn stores. `dataPath` has no map data by default, so the terrain is empty
 * (heights and areas are not read) and nothing loads from disk.
 */
export function setUpTestMapWorld(world: WorldData, dataPath = "/nonexistent-test-data"): void {
  setUpTestMaps(dataPath);
  if (sObjectMgr.worldData() !== world) sObjectMgr.setWorld(world, world.tables());
  if (!loadedWorlds.has(world)) {
    sObjectMgr.loadSpawnStores();
    loadedWorlds.add(world);
  }
}

let loadedWorlds = new WeakSet<WorldData>();
let active = false;

/** A test set the map layer up and has not torn it down. */
export function mapTestWorldActive(): boolean {
  return active;
}

/** The map layer without spawns: `Map.dbc` rows for the continents when the DBC stores are not loaded, and the hooks. */
export function setUpTestMaps(dataPath = "/nonexistent-test-data"): void {
  // `src/test-setup.ts` tears the map layer down after each test that set it up
  active = true;
  (globalThis as { tearDownMapTest?: () => void }).tearDownMapTest = tearDownTestMapWorld;
  for (const id of [0, 1, 530, 571]) if (!sMapStore.lookupEntry(id)) setMapEntry(id, MAP_COMMON);
  setupMaps(dataPath);
}

/** Takes the maps down and restores the hooks `setUpTestMapWorld` set. */
export function tearDownTestMapWorld(): void {
  active = false;
  (globalThis as { tearDownMapTest?: () => void }).tearDownMapTest = undefined;
  sMapMgr().unloadAll();
  // finish the update cycle of `MapMgr::Update`, so the next test starts at its first step
  const mgr = sMapMgr() as unknown as { mapUpdateStep: number };
  for (let i = 0; i < 20 && mgr.mapUpdateStep !== 0; i++) sMapMgr().update(50);
  for (const timer of (sMapMgr() as unknown as { i_timer: { setCurrent(t: number): void }[] }).i_timer) timer.setCurrent(0);
  // no spawns stay behind for the next test (`ObjectMgr`'s grid stores are global)
  sObjectMgr.setWorld(null, null);
  sObjectMgr.loadSpawnStores();
  loadedWorlds = new WeakSet<WorldData>();
  Object.assign(MapHooks, savedHooks.map);
  Object.assign(GridObjectLoaderHooks, savedHooks.loader);
  Object.assign(GridTerrainLoaderHooks, savedHooks.terrain);
  Creature.dbGuidLow = savedHooks.creatureGuid;
  GameObject.dbGuidLow = savedHooks.gameObjectGuid;
  WorldObject.DynamicVisibilityMgr = savedHooks.visibility;
}

/** Runs the map update for `ms` milliseconds in steps (`World::Update` → `MapMgr::Update`): the visibility delays pass. */
export function advanceMaps(ms: number, step = 50): void {
  for (let elapsed = 0; elapsed < ms; elapsed += step) sMapMgr().update(step);
}
