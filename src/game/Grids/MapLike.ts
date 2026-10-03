/**
 * The `Map` members the grid layer and `WorldObject` call, with the C++ names (camelCase). `src/game/Maps/Map.ts`
 * (the Map port) implements this; tests use a fake. A `Map` is a `GridRefMgr<MapGridType>` in C++ (the grids link
 * into it), so `MapLike` extends that class type.
 */
import type { MapEntry } from "../../gen/DBCStructure.gen.ts";
import type { Corpse } from "../Entities/Corpse/Corpse.ts";
import type { Creature } from "../Entities/Creature/Creature.ts";
import type { Object as AcObject, WorldObject } from "../Entities/Object/Object.ts";
import type { HighGuid } from "../Entities/Object/ObjectGuid.ts";
import type { Cell } from "./Cells/Cell.ts";
import type { GridCoord } from "./GridDefines.ts";
import type { GridRefMgr } from "./GridRefMgr.ts";
import type { GridTerrainData } from "./GridTerrainData.ts";
import type { GridTerrainLoaderMap } from "./GridTerrainLoader.ts";
import type { MapGrid } from "./MapGrid.ts";
import type { ContainerType, GridStoredObject, TypeContainerVisitor } from "./TypeContainer.ts";

/** @ac game/Maps/Map.h LineOfSightChecks */
export const LINEOFSIGHT_CHECK_VMAP = 0x1; // check static floor layout data
export const LINEOFSIGHT_CHECK_GOBJECT_WMO = 0x2; // check dynamic game object data (wmo models)
export const LINEOFSIGHT_CHECK_GOBJECT_M2 = 0x4; // check dynamic game object data (m2 models)
export const LINEOFSIGHT_CHECK_GOBJECT_ALL = LINEOFSIGHT_CHECK_GOBJECT_WMO | LINEOFSIGHT_CHECK_GOBJECT_M2;
export const LINEOFSIGHT_ALL_CHECKS = LINEOFSIGHT_CHECK_VMAP | LINEOFSIGHT_CHECK_GOBJECT_ALL;

/** @ac common/Collision/Models/ModelIgnoreFlags.h VMAP::ModelIgnoreFlags (the VMaps stream owns the enum) */
export const ModelIgnoreFlags = { Nothing: 0x00, M2: 0x01 } as const;

// The terrain constants live in the terrain stream's `GridTerrainData.ts`; re-exported for the grid layer.
export { DEFAULT_HEIGHT_SEARCH, INVALID_HEIGHT, MAX_FALL_DISTANCE, MAX_HEIGHT } from "./GridTerrainData.ts";
import { INVALID_HEIGHT } from "./GridTerrainData.ts";
/** @ac shared/SharedDefines.h Z_OFFSET_FIND_HEIGHT */
export const Z_OFFSET_FIND_HEIGHT = 2.0;

/** @ac game/Grids/GridTerrainData.h LiquidData (the terrain stream owns the struct) */
export interface LiquidDataLike {
  Entry: number;
  Flags: number;
  Level: number;
  DepthLevel: number;
  Status: number;
}

/** @ac game/Grids/GridTerrainData.h PositionFullTerrainStatus (the terrain stream owns the struct) */
export interface PositionFullTerrainStatusLike {
  areaId: number;
  floorZ: number;
  outdoors: boolean;
  liquidInfo: LiquidDataLike;
}

/** @ac game/Grids/GridTerrainData.h LiquidData::LiquidData (the default value) */
export function emptyLiquidData(): LiquidDataLike {
  return { Entry: 0, Flags: 0, Level: INVALID_HEIGHT, DepthLevel: INVALID_HEIGHT, Status: 0 };
}

/** A C++ `float&` / `float*` out parameter. */
export type FloatRef = { value: number };

/** @ac game/Pools/PoolMgr.h SpawnedPoolData (the members the grid loader reads) */
export interface SpawnedPoolDataLike {
  /** @ac game/Pools/PoolMgr.cpp SpawnedPoolData::IsSpawnedObject (`IsSpawnedObject<Creature>` / `<GameObject>`) */
  isSpawnedObject(type: "Creature" | "GameObject", db_guid_or_pool_id: number): boolean;
}

/** @ac game/Maps/Map.h Map::CreatureBySpawnIdContainer (`std::unordered_multimap<LowType, Creature*>`) */
export type CreatureBySpawnIdContainer = ReadonlyMap<number, readonly Creature[]>;

/** @ac game/Maps/Map.h ZoneWideVisibleWorldObjectsSet */
export type ZoneWideVisibleWorldObjectsSet = ReadonlySet<WorldObject>;

/** @ac game/Maps/Map.h Map (the members the grid layer, the grid loader, the notifiers, and `WorldObject` call) */
export interface MapLike extends GridRefMgr<MapGrid> {
  // identity
  /** @ac game/Maps/Map.h Map::GetId */
  getId(): number;
  /** @ac game/Maps/Map.h Map::GetInstanceId */
  getInstanceId(): number;
  /** @ac game/Maps/Map.h Map::GetSpawnMode */
  getSpawnMode(): number;
  /** @ac game/Maps/Map.h Map::GetEntry */
  getEntry(): MapEntry | null;
  /** @ac game/Maps/Map.h Map::GetParent */
  getParent(): MapLike;
  /** @ac game/Maps/Map.h Map::IsDungeon */
  isDungeon(): boolean;
  /** @ac game/Maps/Map.h Map::IsBattleArena */
  isBattleArena(): boolean;
  /** @ac game/Maps/Map.h Map::IsBattlegroundOrArena */
  isBattlegroundOrArena(): boolean;
  /** @ac game/Maps/Map.h Map::GetVisibilityRange */
  getVisibilityRange(): number;
  /** @ac game/Maps/Map.cpp Map::GetMapName */
  getMapName(): string;

  // grids
  /** @ac game/Maps/Map.h Map::Visit (nothing when the cell's grid is not loaded) */
  visit(cell: Cell, visitor: TypeContainerVisitor<ContainerType>): void;
  /** @ac game/Maps/Map.cpp Map::EnsureGridCreated */
  ensureGridCreated(gridCoord: GridCoord): void;
  /** @ac game/Maps/Map.cpp Map::AddToGrid (the per-type specializations) */
  addToGrid(obj: GridStoredObject, cell: Cell): void;
  /** @ac game/Maps/Map.cpp Map::GetGridTerrainDataSharedPtr (`GridTerrainLoader` reads the parent map's data) */
  getGridTerrainDataSharedPtr(gridCoord: GridCoord): GridTerrainData | null;
  /** @ac game/Maps/Map.h Map::GetMapCollisionData (the vmap and mmap tile loads `GridTerrainLoader` calls) */
  getMapCollisionData(): ReturnType<GridTerrainLoaderMap["getMapCollisionData"]>;
  /** @ac game/Maps/Map.h Map::GetCorpsesInGrid */
  getCorpsesInGrid(gridId: number): ReadonlySet<Corpse> | null;
  /** @ac game/Maps/Map.cpp Map::RemoveAllObjectsInRemoveList */
  removeAllObjectsInRemoveList(): void;
  /** @ac game/Maps/Map.cpp Map::AddObjectToRemoveList */
  addObjectToRemoveList(obj: WorldObject): void;
  /** @ac game/Maps/Map.cpp Map::AddObjectToPendingUpdateList */
  addObjectToPendingUpdateList(obj: WorldObject): void;
  /** @ac game/Maps/Map.cpp Map::RemoveObjectFromMapUpdateList */
  removeObjectFromMapUpdateList(obj: WorldObject): void;
  /** @ac game/Maps/Map.h Map::AddUpdateObject */
  addUpdateObject(obj: AcObject): void;
  /** @ac game/Maps/Map.h Map::RemoveUpdateObject */
  removeUpdateObject(obj: AcObject): void;
  /** @ac game/Maps/Map.h Map::isCellMarked */
  isCellMarked(pCellId: number): boolean;

  // spawns
  /** @ac game/Maps/Map.h Map::GenerateLowGuid (`GenerateLowGuid<HighGuid::Unit>()` etc.) */
  generateLowGuid(high: HighGuid): number;
  /** @ac game/Maps/Map.cpp Map::IsSpawnGroupActive */
  isSpawnGroupActive(groupId: number): boolean;
  /** @ac game/Maps/Map.h Map::GetPoolData */
  getPoolData(): SpawnedPoolDataLike;
  /** @ac game/Maps/Map.h Map::GetCreatureBySpawnIdStore */
  getCreatureBySpawnIdStore(): CreatureBySpawnIdContainer;
  /** @ac game/Maps/Map.h Map::GetCreatureRespawnTime */
  getCreatureRespawnTime(dbGuid: number): number;
  /** @ac game/Maps/Map.h Map::GetGORespawnTime */
  getGORespawnTime(dbGuid: number): number;
  /** @ac game/Maps/Map.cpp Map::RemoveGORespawnTime */
  removeGORespawnTime(dbGuid: number): void;

  // visibility override containers
  /** @ac game/Maps/Map.cpp Map::AddWorldObjectToFarVisibleMap */
  addWorldObjectToFarVisibleMap(obj: WorldObject): void;
  /** @ac game/Maps/Map.cpp Map::RemoveWorldObjectFromFarVisibleMap */
  removeWorldObjectFromFarVisibleMap(obj: WorldObject): void;
  /** @ac game/Maps/Map.cpp Map::AddWorldObjectToZoneWideVisibleMap */
  addWorldObjectToZoneWideVisibleMap(zoneId: number, obj: WorldObject): void;
  /** @ac game/Maps/Map.cpp Map::RemoveWorldObjectFromZoneWideVisibleMap */
  removeWorldObjectFromZoneWideVisibleMap(zoneId: number, obj: WorldObject): void;
  /** @ac game/Maps/Map.cpp Map::GetZoneWideVisibleWorldObjectsForZone */
  getZoneWideVisibleWorldObjectsForZone(zoneId: number): ZoneWideVisibleWorldObjectsSet | null;

  // terrain, vmaps, and dynamic collision
  /** @ac game/Maps/Map.cpp Map::GetZoneAndAreaId (the `uint32&` out parameters are the result) */
  getZoneAndAreaId(phaseMask: number, x: number, y: number, z: number): { zoneid: number; areaid: number };
  /** @ac game/Maps/Map.cpp Map::GetFullTerrainStatusForPosition (the `data` out parameter is the result) */
  getFullTerrainStatusForPosition(phaseMask: number, x: number, y: number, z: number, collisionHeight: number): PositionFullTerrainStatusLike;
  /** @ac game/Maps/Map.cpp Map::GetHeight (the `(phasemask, x, y, z, vmap, maxSearchDist)` overload) */
  getHeight(phasemask: number, x: number, y: number, z: number, vmap?: boolean, maxSearchDist?: number): number;
  /** @ac game/Maps/Map.cpp Map::GetWaterOrGroundLevel */
  getWaterOrGroundLevel(phasemask: number, x: number, y: number, z: number, ground: FloatRef | null, swim: boolean, collisionHeight: number): number;
  /** @ac game/Maps/Map.cpp Map::IsInWater */
  isInWater(phaseMask: number, x: number, y: number, z: number, collisionHeight: number): boolean;
  /** @ac game/Maps/Map.h Map::GetGameObjectFloor */
  getGameObjectFloor(phasemask: number, x: number, y: number, z: number, maxSearchDist?: number): number;
  /** @ac game/Maps/Map.cpp Map::isInLineOfSight */
  isInLineOfSight(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, phasemask: number, checks: number, ignoreFlags: number): boolean;
  /** @ac game/Maps/Map.cpp Map::CheckCollisionAndGetValidCoords (the `float&` destination is `dest`) */
  checkCollisionAndGetValidCoords(source: WorldObject, startX: number, startY: number, startZ: number, dest: { x: number; y: number; z: number }, failOnCollision?: boolean): boolean;
}
