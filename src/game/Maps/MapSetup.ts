/**
 * Wires the map layer to the rest of the server at startup: the hooks `Map`, `MapCollisionData`, and the grid loaders take
 * from other topics, the vmap and mmap switches `World::SetInitialWorldSettings` sets, and the `Visibility.Distance.*` options
 * of `World::LoadConfigSettings`. Nothing in `Map.ts` imports this file (it imports `ObjectMgr`, `Creature`, `GameObject`,
 * `Corpse`, and the chat, which import the grids); the startup code calls it once, after the world tables and the DBC stores
 * are loaded and before the first map is created.
 */
import { MMapMgr } from "../../common/Collision/Management/MMapMgr.ts";
import { VMapFactory } from "../../common/Collision/Management/VMapFactory.ts";
import type { ConfigMgr } from "../../common/config.ts";
import type { Db } from "../../database/database.ts";
import { CHAT_MSG_SYSTEM, LANG_UNIVERSAL } from "../../shared/SharedDefines.ts";
import { log, logError } from "../../log.ts";
import { BuildChatPacket } from "../Chat/Chat.ts";
import { GetLiquidFlags } from "../DataStores/MapDBCStores.ts";
import { Corpse, type CorpseType } from "../Entities/Corpse/Corpse.ts";
import { Creature, creatureTemplateRow } from "../Entities/Creature/Creature.ts";
import { GameObject } from "../Entities/GameObject/GameObject.ts";
import {
  DEFAULT_VISIBILITY_BGARENAS,
  DEFAULT_VISIBILITY_DISTANCE,
  DEFAULT_VISIBILITY_INSTANCE,
  MAX_VISIBILITY_DISTANCE,
} from "../Entities/Object/ObjectDefines.ts";
import { DisableMgr } from "../Conditions/DisableMgr.ts";
import { DynamicVisibilityMgr } from "../Misc/DynamicVisibility.ts";
import { WorldObject } from "../Entities/Object/Object.ts";
import { sMapStore } from "../DataStores/DBCStores.ts";
import { MapEntryInstanceable } from "../DataStores/MapDBCStores.ts";
import { sObjectMgr } from "../Globals/ObjectMgr.ts";
import { AddMovementGeneratorFactories } from "../AI/CreatureAIRegistry.ts";
import { sFormationMgr } from "../Entities/Creature/CreatureGroups.ts";
import { FlightPathContext } from "../Movement/MovementGenerators/WaypointMovementGenerator.ts";
import { sWaypointMgr } from "../Movement/Waypoints/WaypointMgr.ts";
import { GridObjectLoaderHooks } from "../Grids/GridObjectLoader.ts";
import { GridTerrainLoaderHooks } from "../Grids/GridTerrainLoader.ts";
import { ServerConfig } from "../world/world-config-data.ts";
import { sWorld } from "../world/world.ts";
import { MAP_EASTERN_KINGDOMS, MAP_KALIMDOR, MAP_OUTLAND } from "./AreaDefines.ts";
import { MapHooks, sMapRespawnStore, type MapCorpse, type MapObjectMgr } from "./Map.ts";
import { LineOfSightHooks } from "./MapLineOfSight.ts";
import { getTerrainMap, MapMgr, sMapMgr } from "./MapMgr.ts";
import { InstanceTemplateHooks } from "./MapMgrStatics.ts";

/** `sObjectMgr` as the `Map` side needs it. */
function mapObjectMgr(): MapObjectMgr {
  return {
    getSpawnGroupData: (groupId) => sObjectMgr.getSpawnGroupData(groupId),
    getSpawnDataForGroup: (groupId) => sObjectMgr.getSpawnDataForGroup(groupId),
    getSpawnCreatureData: (spawnId) => sObjectMgr.getSpawnCreatureData(spawnId),
    getSpawnGameObjectData: (spawnId) => sObjectMgr.getSpawnGameObjectData(spawnId),
    getLinkedRespawnGuid: (guid) => sObjectMgr.getLinkedRespawnGuid(guid),
    getCreatureTemplateFlagsExtra: (entry) => creatureTemplateRow(entry)?.flags_extra ?? 0,
  };
}

/**
 * Sets the hooks of the map layer (`Map`, `MapCollisionData`, `GridTerrainLoader`, and `GridObjectLoader`).
 * @param dataPath `DataDir` (`maps/`, `vmaps/`, `mmaps/` are read below it)
 */
export function setupMaps(dataPath: string): void {
  const path = dataPath.endsWith("/") ? dataPath : `${dataPath}/`;
  GridTerrainLoaderHooks.getDataPath = () => path;
  GridTerrainLoaderHooks.getVMapMgr = () => VMapFactory.createOrGetVMapMgr();
  MMapMgr.setDataDir(path.slice(0, -1));

  // `World::SetInitialWorldSettings`: VMAP::VMapFactory::createOrGetVMapMgr()->GetLiquidFlagsPtr = &GetLiquidFlags
  VMapFactory.createOrGetVMapMgr().GetLiquidFlagsPtr = GetLiquidFlags;

  // the spawns a grid loads (`GridObjectLoader` reads `ObjectMgr`'s per grid guid lists and creates the objects)
  GridObjectLoaderHooks.objectMgr = {
    getGridObjectGuids: (mapid, spawnMode, gridId) => sObjectMgr.getGridObjectGuids(mapid, spawnMode, gridId),
    getCreatureData: (spawnId) => sObjectMgr.getSpawnCreatureData(spawnId),
    getGameObjectData: (spawnId) => sObjectMgr.getSpawnGameObjectData(spawnId),
    isGameObjectStaticTransport: (entry) => sObjectMgr.isGameObjectStaticTransport(entry),
  };
  // the world code addresses creatures and gameobjects by `entry << 24 | spawn id`
  Creature.dbGuidLow = (spawnId) => spawnId;
  GameObject.dbGuidLow = (spawnId) => spawnId;
  GridObjectLoaderHooks.createCreature = () => new Creature();
  GridObjectLoaderHooks.createGameObject = () => new GameObject();

  // `ObjectMgr::LoadCreatures` / `LoadGameobjects` (`Calculate.*.Zone.Area.Data`): `sMapMgr->GetZoneId` and `GetAreaId`
  sObjectMgr.zoneAreaResolver = (phaseMask, mapId, x, y, z) => (sMapStore.lookupEntry(mapId) ? sMapMgr().getZoneAndAreaId(phaseMask, mapId, x, y, z) : null);

  // the delays and distances of the visibility updates grow with the sessions (`World::Update`: `DynamicVisibilityMgr::Update`)
  WorldObject.DynamicVisibilityMgr = DynamicVisibilityMgr;

  // line of sight of units that are not `WorldObject`s (spells) asks the map of their place
  LineOfSightHooks.findMap = getTerrainMap;

  // `World::SetInitialWorldSettings`: vmmgr2->IsVMAPDisabledForPtr = &DisableMgr::IsVMAPDisabledFor
  DisableMgr.install();

  InstanceTemplateHooks.getScriptId = (name) => sObjectMgr.getScriptId(name);
  MapHooks.getScriptName = (id) => sObjectMgr.getScriptName(id);
  MapHooks.objectMgr = mapObjectMgr();
  MapHooks.createCreature = () => new Creature();
  MapHooks.createGameObject = () => new GameObject();
  MapHooks.createCorpse = (type) => new Corpse(type as CorpseType) as unknown as MapCorpse;
  MapHooks.buildSystemChatPacket = (text) => {
    const packet = BuildChatPacket(CHAT_MSG_SYSTEM, LANG_UNIVERSAL, 0n, 0n, text, 0);
    return { opcode: packet.opcode, payload: packet.body };
  };
}

/**
 * `MapMgr::CreateBaseMap` / `MapInstanced::CreateInstance` read the respawn times of their map at creation: read the
 * `creature_respawn` and `gameobject_respawn` tables once at startup (see `MapRespawnStore`).
 */
export async function loadMapRespawnTimes(characterDb: Db): Promise<void> {
  await sMapRespawnStore.load(characterDb);
}

/**
 * @ac game/World/World.cpp World::LoadConfigSettings (the `Visibility.Distance.Continents`, `.Instances`, `.BGArenas` part)
 * The distances are clamped between the creature aggro radius (45 yards times `Rate.Creature.Aggro`) and
 * `MAX_VISIBILITY_DISTANCE`. Call it again after a config reload, then `MapMgr::InitializeVisibilityDistanceInfo`.
 */
export function loadMapVisibilityDistances(config: ConfigMgr): void {
  const aggro = 45 * sWorld().getRate(ServerConfig.RATE_CREATURE_AGGRO);
  const read = (key: string, def: number): number => {
    let distance = config.getFloat(key, def);
    if (distance < aggro) {
      logError("server", `${key} can't be less max aggro radius ${aggro}`);
      distance = aggro;
    } else if (distance > MAX_VISIBILITY_DISTANCE) {
      logError("server", `${key} can't be greater ${MAX_VISIBILITY_DISTANCE}`);
      distance = MAX_VISIBILITY_DISTANCE;
    }
    return distance;
  };
  const continents = read("Visibility.Distance.Continents", DEFAULT_VISIBILITY_DISTANCE);
  const instances = read("Visibility.Distance.Instances", DEFAULT_VISIBILITY_INSTANCE);
  const bgArenas = read("Visibility.Distance.BGArenas", DEFAULT_VISIBILITY_BGARENAS);
  MapHooks.getMaxVisibleDistanceOnContinents = () => continents;
  MapHooks.getMaxVisibleDistanceInInstances = () => instances;
  MapHooks.getMaxVisibleDistanceInBGArenas = () => bgArenas;
}

/**
 * @ac game/World/World.cpp World::LoadConfigSettings (the `vmap.*` part)
 * `vmap.enableLOS` and `vmap.enableHeight` are the two switches the vmap manager keeps; `vmap.enableIndoorCheck`,
 * `vmap.petLOS`, `vmap.BlizzlikePvPLOS`, `vmap.BlizzlikeLOSInOpenWorld`, and `MoveMaps.Enable` are read through
 * `sWorld()` where they are used (`Map::IsInLineOfSight`, `WorldObject::IsWithinLOS`, `MapCollisionData`). Call it again
 * after a config reload.
 */
export function loadMapConfigSettings(): void {
  const world = sWorld();
  const enableIndoor = world.getBoolConfig(ServerConfig.CONFIG_VMAP_INDOOR_CHECK);
  const enableLOS = world.getBoolConfig(ServerConfig.CONFIG_VMAP_ENABLE_LOS);
  const enablePetLOS = world.getBoolConfig(ServerConfig.CONFIG_PET_LOS);
  const enableHeight = world.getBoolConfig(ServerConfig.CONFIG_VMAP_ENABLE_HEIGHT);
  if (!enableHeight) logError("server", "VMap height checking disabled! Creatures movements and other various things WILL be broken! Expect no support.");

  VMapFactory.createOrGetVMapMgr().setEnableLineOfSightCalc(enableLOS);
  VMapFactory.createOrGetVMapMgr().setEnableHeightCalc(enableHeight);
  log("server", `WORLD: VMap support included. LineOfSight:${enableLOS}, getHeight:${enableHeight}, indoorCheck:${enableIndoor} PetLOS:${enablePetLOS}`);
}

/**
 * @ac game/World/World.cpp World::SetInitialWorldSettings (the map file check of the starting areas)
 * Returns the starting area positions that have no `.map` or vmap tile. The C++ logs "Failed to find map files for starting
 * areas" and exits; the caller of this port reports it and goes on (the extracted data of a development checkout is partial).
 */
export function checkStartingAreaMaps(): string[] {
  const missing: string[] = [];
  const check = (mapId: number, x: number, y: number): void => {
    if (!MapMgr.existMapAndVMap(mapId, x, y)) missing.push(`map ${mapId} at ${x}, ${y}`);
  };
  check(MAP_EASTERN_KINGDOMS, -6240.32, 331.033);
  check(MAP_EASTERN_KINGDOMS, -8949.95, -132.493);
  check(MAP_KALIMDOR, -618.518, -4251.67);
  check(MAP_EASTERN_KINGDOMS, 1676.35, 1677.45);
  check(MAP_KALIMDOR, 10311.3, 832.463);
  check(MAP_KALIMDOR, -2917.58, -257.98);
  if (sWorld().getIntConfig(ServerConfig.CONFIG_EXPANSION)) {
    check(MAP_OUTLAND, 10349.6, -6357.29);
    check(MAP_OUTLAND, -3961.64, -13931.2);
  }
  return missing;
}

/**
 * @ac game/World/World.cpp World::SetInitialWorldSettings (`PreloadAllNonInstancedMapGrids`)
 * Creates every non instanced map and loads all of its grids.
 */
export function preloadAllNonInstancedMapGrids(): void {
  if (!sWorld().getBoolConfig(ServerConfig.CONFIG_PRELOAD_ALL_NON_INSTANCED_MAP_GRIDS)) return;

  log("server", "Loading All Grids For All Non-Instanced Maps...");
  for (const mapEntry of [...sMapStore]) {
    if (MapEntryInstanceable(mapEntry)) continue;

    const map = sMapMgr().createBaseMap(mapEntry.MapID);
    log("server", `>> Loading All Grids For Map ${map.getId()}`);
    map.loadAllGrids();
  }
}

/**
 * The movement part of `World::SetInitialWorldSettings`: `AIRegistry::Initialize` (the movement generator factories), then, after the
 * creature spawns and before the first grid loads (a creature looks for its formation when it is added to the world),
 * `sWaypointMgr->Load()`, `sWaypointMgr->LoadWaypointAddons()` and `sFormationMgr->LoadCreatureFormations()`.
 * `MoveMaps.Enable` / `DisableMgr::IsPathfindingEnabled` is `MapCollisionDataHooks.isPathfindingEnabled` (read by `MapCollisionData`).
 */
export function loadMovementData(): void {
  AddMovementGeneratorFactories();
  // `sMapMgr->FindBaseNonInstanceMap` (the flight path generator preloads the grids of its next nodes)
  FlightPathContext.findBaseNonInstanceMap = (mapId) => sMapMgr().findBaseNonInstanceMap(mapId);
  // @ac-skip Taxi: `FlightPathContext.getTaxiPathNodesByPath` / `getTaxiPath` need `sTaxiPathNodesByPath` and `ObjectMgr::GetTaxiPath`
  const tables = sObjectMgr.worldTables();
  if (!tables) return;
  sWaypointMgr().load(tables);
  sWaypointMgr().loadWaypointAddons(tables);
  sFormationMgr().loadCreatureFormations(tables, (spawnId) => sObjectMgr.getSpawnCreatureData(spawnId) !== null);
}

/** The options `startMapSystem` takes. */
export interface MapSystemOptions {
  /** `DataDir` as the world resolved it (`sWorld().getDataPath()` when absent) */
  dataPath?: string;
  config: ConfigMgr;
  characterDb: Db;
}

/**
 * The map part of `World::SetInitialWorldSettings`, in the C++ order: the hooks and the vmap switches, the respawn times of
 * the characters database, `MapMgr::InitInstanceIds`, `MapMgr::Initialize`, the visibility distances and the update interval,
 * and the preload of every grid when `PreloadAllNonInstancedMapGrids` is on. The spawn stores (`ObjectMgr::LoadCreatures` and
 * friends) load here, after the hooks they use. The world tables and the DBC stores must be loaded before.
 */
export async function startMapSystem(options: MapSystemOptions): Promise<void> {
  setupMaps(options.dataPath ?? sWorld().getDataPath());
  loadMapConfigSettings();
  loadMapVisibilityDistances(options.config);
  // the spawn stores after the hooks: `Calculate.*.Zone.Area.Data` asks the maps for the zone and area of each spawn
  sObjectMgr.loadSpawnStores();
  loadMovementData();
  const missing = checkStartingAreaMaps();
  if (missing.length > 0) logError("server", `Failed to find map files for starting areas: ${missing.join("; ")}`);
  await loadMapRespawnTimes(options.characterDb);
  await sMapMgr().initInstanceIds(options.characterDb);
  sMapMgr().initialize();
  sMapMgr().setMapUpdateInterval(sWorld().getIntConfig(ServerConfig.CONFIG_INTERVAL_MAPUPDATE));
  sMapMgr().initializeVisibilityDistanceInfo();
  preloadAllNonInstancedMapGrids();
}
