/**
 * @ac game/Maps/Map.h
 * @ac game/Maps/Map.cpp
 *
 * `Map` (a world map or one instance of it), `InstanceMap` (a dungeon or raid instance), and `BattlegroundMap`. A map owns
 * its grids (`MapGridManager`), its collision data (`MapCollisionData`), the players on it (`MapRefMgr`), the objects of its
 * grids (`MapStoredObjectTypesContainer`, the by-spawn-id stores, the corpses), the respawn times and the respawn queue,
 * the list of objects that need `Update`, and the per-zone state (player counts, zone wide visible objects, music, weather).
 *
 * Out of scope here (other topics), each kept with the C++ signature and marked `@ac-skip` where it is a no-op:
 * Transport (`_transports`, `GetTransportForPos`, `SendInitTransports`), Weather (`ZoneDynamicInfo::DefaultWeather`),
 * ScriptMgr (the `sScriptMgr->On...` hooks, `ScriptsStart`), InstanceSaveMgr / InstanceScript / Group / LFG (instance
 * binds), Battleground, `WorldSession::Update` (the session pump runs from the world loop). The members they need from
 * `Player`, `Unit` and `Creature` that are not ported as classes yet are read through the optional capability interfaces
 * below. What the integration provides is set through `MapHooks` (see `MapSetup.ts`).
 *
 * `Map` shadows the JavaScript `Map` inside this module: `StdMap` is the JavaScript one.
 *
 * C++ `Map::GetHeight` has two overloads that differ only by a leading `phasemask`; `getHeight(phasemask, x, y, z, ...)` is
 * the one `MapLike` and `WorldObject` call, `getHeightNoPhase(x, y, z, ...)` the `(x, y, z, checkVMap, maxSearchDist)` one.
 * The C++ out parameters are results: `getZoneAndAreaId` returns `{ zoneid, areaid }`, `getAreaInfo` returns the flags and
 * ids, `getFullTerrainStatusForPosition` returns the `PositionFullTerrainStatus`.
 */
import { and, eq } from "drizzle-orm";
import { AreaAndLiquidData, VMAP_INVALID_HEIGHT, VMAP_INVALID_HEIGHT_VALUE } from "../../common/Collision/Management/IVMapMgr.ts";
import type { GameObjectModel } from "../../common/Collision/Models/GameObjectModel.ts";
import { urand } from "../../common/random.ts";
import { corpse as corpseTable } from "../../database/schema/characters.ts";
import { logDebug, logError } from "../../log.ts";
import { sAreaTableStore, sLiquidTypeStore, sMapStore } from "../DataStores/DBCStores.ts";
import {
  GetDefaultMapLight,
  IsSharedDifficultyMap,
  RAID_DIFFICULTY_10MAN_NORMAL,
  RAID_DIFFICULTY_25MAN_NORMAL,
  GetMapDifficultyData,
  GetWMOAreaTableEntryByTripple,
  MapEntryExpansion,
  MapEntryGetEntrancePos,
  MapEntryInstanceable,
  MapEntryIsBattleArena,
  MapEntryIsBattleground,
  MapEntryIsBattlegroundOrArena,
  MapEntryIsDungeon,
  MapEntryIsNonRaidDungeon,
  MapEntryIsRaid,
  MapEntryIsWorldMap,
  REGULAR_DIFFICULTY,
  RAID_DIFFICULTY_10MAN_HEROIC,
  RAID_DIFFICULTY_MASK_25MAN,
  DUNGEON_DIFFICULTY_NORMAL,
  DUNGEON_DIFFICULTY_HEROIC,
  type MapDifficulty,
} from "../DataStores/MapDBCStores.ts";
import type { MapEntry } from "../../gen/DBCStructure.gen.ts";
import { Cell } from "../Grids/Cells/Cell.ts";
import type { Corpse } from "../Entities/Corpse/Corpse.ts";
import type { Creature } from "../Entities/Creature/Creature.ts";
import type { DynamicObject } from "../Entities/DynamicObject/DynamicObject.ts";
import type { GameObject } from "../Entities/GameObject/GameObject.ts";
import {
  MAP_OBJECT_CELL_MOVE_ACTIVE,
  MAP_OBJECT_CELL_MOVE_INACTIVE,
  MAP_OBJECT_CELL_MOVE_NONE,
  UpdateState,
  type Object as AcObject,
  type WorldObject,
} from "../Entities/Object/Object.ts";
import { CONTACT_DISTANCE, DEFAULT_COLLISION_HEIGHT, DEFAULT_VISIBILITY_BGARENAS, DEFAULT_VISIBILITY_DISTANCE, DEFAULT_VISIBILITY_INSTANCE, MAX_VISIBILITY_DISTANCE } from "../Entities/Object/ObjectDefines.ts";
import { HighGuid, ObjectGuid, TYPEID_CORPSE, TYPEID_DYNAMICOBJECT, TYPEID_GAMEOBJECT, TYPEID_PLAYER, TYPEID_UNIT } from "../Entities/Object/ObjectGuid.ts";
import type { PositionLike } from "../Entities/Object/Position.ts";
import { UpdateData, type WorldPacket } from "../Entities/Object/Updates/UpdateData.ts";
import {
  CENTER_GRID_CELL_ID,
  CellCoord,
  ComputeCellCoord,
  ComputeGridCoord,
  GridCoord,
  IsValidMapCoord,
  SIZE_OF_GRIDS,
  SIZE_OF_GRID_CELL,
  TOTAL_NUMBER_OF_CELLS_PER_MAP,
} from "../Grids/GridDefines.ts";
import type { GridPlayer, UnitLike } from "../Grids/GridPlayer.ts";
import { GridRefMgr } from "../Grids/GridRefMgr.ts";
import {
  GridTerrainData,
  INVALID_HEIGHT,
  LIQUID_MAP_ABOVE_WATER,
  LIQUID_MAP_IN_WATER,
  LIQUID_MAP_NO_WATER,
  LIQUID_MAP_UNDER_WATER,
  LIQUID_MAP_WATER_WALK,
  LiquidData,
  MAP_ALL_LIQUIDS,
  MAP_LIQUID_STATUS_SWIMMING,
  MAP_LIQUID_TYPE_OCEAN,
  MAP_LIQUID_TYPE_WATER,
  MIN_HEIGHT,
  PositionFullTerrainStatus,
  DEFAULT_HEIGHT_SEARCH,
} from "../Grids/GridTerrainData.ts";
import type { MapGrid } from "../Grids/MapGrid.ts";
import { MapGridManager } from "../Grids/MapGridManager.ts";
import {
  LINEOFSIGHT_CHECK_GOBJECT_ALL,
  LINEOFSIGHT_CHECK_GOBJECT_M2,
  LINEOFSIGHT_CHECK_VMAP,
  ModelIgnoreFlags,
  Z_OFFSET_FIND_HEIGHT,
  type CreatureBySpawnIdContainer,
  type FloatRef,
  type MapLike,
  type SpawnedPoolDataLike,
  type ZoneWideVisibleWorldObjectsSet,
} from "../Grids/MapLike.ts";
import type { ContainerType, GridStoredObject, TypeContainerVisitor } from "../Grids/TypeContainer.ts";
import { PathGenerator, PathType, type PathSource } from "../Movement/MovementGenerators/PathGenerator.ts";
import { eps64, fuzzyGe } from "../../math/g3dmath.ts";
import { IntervalTimer, TimeTrackerSmall } from "../time/timer.ts";
import { getGameTime } from "../time/game-time.ts";
import { EventProcessor } from "../../common/event-processor.ts";
import { ByteWriter } from "../../net/byte-buffer.ts";
import { DEFAULT_LOCALE, TEAM_NEUTRAL } from "../../shared/SharedDefines.ts";
import { ObjectGuidGenerator } from "../Globals/object-guids.ts";
import { ServerConfig } from "../world/world-config-data.ts";
import { sWorld } from "../world/world.ts";
import { CharacterDatabase } from "../../database/DatabaseEnv.ts";
import { executeStatementAsync, queryFields, type Db } from "../../database/database.ts";
import {
  CHAR_DEL_CORPSES_FROM_MAP,
  CHAR_DEL_CREATURE_RESPAWN,
  CHAR_DEL_CREATURE_RESPAWN_BY_INSTANCE,
  CHAR_DEL_GO_RESPAWN,
  CHAR_DEL_GO_RESPAWN_BY_INSTANCE,
  CHAR_REP_CREATURE_RESPAWN,
  CHAR_REP_GO_RESPAWN,
  CHAR_SEL_CREATURE_RESPAWNS,
  CHAR_SEL_GO_RESPAWNS,
} from "../../gen/CharacterDatabase.gen.ts";
import { CORPSE_END, CORPSE_FIELD_FLAGS, CORPSE_FIELD_ITEM, CORPSE_FIELD_OWNER, OBJECT_FIELD_TYPE } from "../../gen/UpdateFields.gen.ts";
import { MAP_EBON_HOLD, MAP_OUTLAND, MAP_SCOTT_TEST } from "./AreaDefines.ts";
import { MapCollisionData } from "./MapCollisionData.ts";
import { GetInstanceTemplate } from "./MapMgrStatics.ts";
import { MapRefMgr } from "./MapRefMgr.ts";
import type { MapReference, MapRefTarget } from "./MapReference.ts";
import {
  SPAWNGROUP_FLAG_COMPATIBILITY_MODE,
  SPAWNGROUP_FLAG_MANUAL_SPAWN,
  SPAWNGROUP_FLAG_SYSTEM,
  SPAWNGROUP_MAP_UNSET,
  SPAWN_TYPE_CREATURE,
  SPAWN_TYPE_GAMEOBJECT,
  type SpawnData,
  type SpawnGroupTemplateData,
  type SpawnObjectType,
} from "./SpawnData.ts";
import { MOVEMENTFLAG_DISABLE_GRAVITY, MOVEMENTFLAG_FLYING } from "../Entities/Unit/UnitDefines.ts";
import { StdMap } from "./StdMap.ts";

/** @ac game/Maps/Map.cpp MAP_INVALID_ZONE */
export const MAP_INVALID_ZONE = 0xffffffff;

/** @ac game/Maps/Map.h MIN_UNLOAD_DELAY (immediate unload) */
export const MIN_UNLOAD_DELAY = 1;
/** @ac game/Maps/Map.h UPDATABLE_OBJECT_LIST_RECHECK_TIMER (time to recheck update object list, in ms) */
export const UPDATABLE_OBJECT_LIST_RECHECK_TIMER = 30 * 1000;

/** @ac shared/SharedDefines.h GROUND_HEIGHT_TOLERANCE (extra tolerance to z position to check if it is in air or on ground) */
export const GROUND_HEIGHT_TOLERANCE = Math.fround(0.05);

/** @ac game/Maps/Map.h LevelRequirementVsMode */
export const LEVELREQUIREMENT_HEROIC = 70;

/** @ac game/Maps/Map.h EncounterCreditType */
export const ENCOUNTER_CREDIT_KILL_CREATURE = 0;
export const ENCOUNTER_CREDIT_CAST_SPELL = 1;
export type EncounterCreditType = typeof ENCOUNTER_CREDIT_KILL_CREATURE | typeof ENCOUNTER_CREDIT_CAST_SPELL;

/** @ac game/Maps/Map.h Map::EnterState */
export const CAN_ENTER = 0;
export const CANNOT_ENTER_ALREADY_IN_MAP = 1; // Player is already in the map
export const CANNOT_ENTER_NO_ENTRY = 2; // No map entry was found for the target map ID
export const CANNOT_ENTER_UNINSTANCED_DUNGEON = 3; // No instance template was found for dungeon map
export const CANNOT_ENTER_DIFFICULTY_UNAVAILABLE = 4; // Requested instance difficulty is not available for target map
export const CANNOT_ENTER_NOT_IN_RAID = 5; // Target instance is a raid instance and the player is not in a raid group
export const CANNOT_ENTER_CORPSE_IN_DIFFERENT_INSTANCE = 6; // Player is dead and their corpse is not in target instance
export const CANNOT_ENTER_INSTANCE_BIND_MISMATCH = 7; // Player's permanent instance save is not compatible with their group's current instance bind
export const CANNOT_ENTER_TOO_MANY_INSTANCES = 8; // Player has entered too many instances recently
export const CANNOT_ENTER_MAX_PLAYERS = 9; // Target map already has the maximum number of players allowed
export const CANNOT_ENTER_ZONE_IN_COMBAT = 10; // A boss encounter is currently in progress on the target map
export const CANNOT_ENTER_UNSPECIFIED_REASON = 11;
export type EnterState = number;

/** @ac game/Maps/Map.h InstanceResetMethod */
export const INSTANCE_RESET_ALL = 0; // reset all option under portrait, resets only normal 5-mans
export const INSTANCE_RESET_CHANGE_DIFFICULTY = 1; // on changing difficulty
export const INSTANCE_RESET_GLOBAL = 2; // global id reset
export const INSTANCE_RESET_GROUP_JOIN = 3; // on joining group
export const INSTANCE_RESET_GROUP_LEAVE = 4; // on leaving group

/** @ac game/Maps/Weather.h WeatherState::WEATHER_STATE_FINE */
const WEATHER_STATE_FINE = 0;

/** @ac shared/SharedDefines.h YEAR / DAY / MINUTE (seconds) */
const YEAR = 365 * 24 * 60 * 60;
const DAY = 24 * 60 * 60;
const MINUTE = 60;

/** The opcodes `Map` sends itself (`WorldPackets::Misc::Weather`, `PlayMusic`, `SMSG_OVERRIDE_LIGHT`, `SMSG_PLAY_SOUND`). */
const SMSG_WEATHER = 0x2f4;
const SMSG_PLAY_MUSIC = 0x277;
const SMSG_PLAY_SOUND = 0x2d2;
const SMSG_OVERRIDE_LIGHT = 0x412;
const SMSG_INSTANCE_LOCK_WARNING_QUERY = 0x147;
const SMSG_INSTANCE_SAVE_CREATED = 0x2cb;

/** @ac shared/DataStores/DBCEnums.h AreaFlags (the two the outdoors check reads) */
const AREA_FLAG_INSIDE = 0x02000000; // used for determinating spell related inside/outside questions in Map::IsOutdoors
const AREA_FLAG_OUTSIDE = 0x04000000; // used for determinating spell related inside/outside questions in Map::IsOutdoors

/** @ac shared/SharedDefines.h CreatureEliteType */
const CREATURE_ELITE_RAREELITE = 2;
const CREATURE_ELITE_RARE = 4;
/** @ac game/Entities/Creature/CreatureData.h CreatureFlagsExtra::CREATURE_FLAG_EXTRA_HARD_RESET */
const CREATURE_FLAG_EXTRA_HARD_RESET = 0x80000000;

/** @ac game/Entities/Corpse/Corpse.h CorpseType / CorpseFlags */
const CORPSE_BONES = 0;
const MAX_CORPSE_TYPE = 3;
const CORPSE_FLAG_BONES = 0x01;
const CORPSE_FLAG_UNK2 = 0x04;
/** @ac game/Entities/Item/ItemDefines.h EquipmentSlots::EQUIPMENT_SLOT_END */
const EQUIPMENT_SLOT_END = 19;

/** @ac game/Maps/Map.h ScriptAction (the `ScriptInfo` is not ported: ScriptMgr) */
export interface ScriptAction {
  sourceGUID: bigint;
  targetGUID: bigint;
  /** owner of source if source is item */
  ownerGUID: bigint;
  /** pointer to static script data */
  script: unknown;
}

/**
 * @ac game/Maps/Map.h ZoneDynamicInfo
 * `DefaultWeather` is a `std::unique_ptr<Weather>`; weather is not ported, so it is only ever null here.
 */
export class ZoneDynamicInfo {
  /** @ac game/Maps/Map.cpp ZoneDynamicInfo::ZoneDynamicInfo (the defaults below) */
  MusicId = 0;
  DefaultWeather: { sendWeatherUpdateToPlayer(player: GridPlayer): void; update(diff: number): boolean } | null = null;
  WeatherId = WEATHER_STATE_FINE;
  WeatherGrade = 0.0;
  OverrideLightId = 0;
  LightFadeInTime = 0;
}

/** @ac game/Maps/Map.h CreatureGroupHolderType (`std::map<uint32 leaderDBGUID, CreatureGroup*>`; formations are not ported) */
export type CreatureGroupHolderType = StdMap<number, unknown>;
/** @ac game/Maps/Map.h ZoneDynamicInfoMap */
export type ZoneDynamicInfoMap = StdMap<number, ZoneDynamicInfo>;
/** @ac game/Maps/Map.h TransportsContainer (`std::unordered_set<Transport*>`; transports are not ported) */
export type TransportsContainer = Set<WorldObject>;
/** @ac game/Maps/Map.h ZoneWideVisibleWorldObjectsMap */
export type ZoneWideVisibleWorldObjectsMap = StdMap<number, Set<WorldObject>>;
/** @ac game/Maps/Map.h Map::GameObjectBySpawnIdContainer (`std::unordered_multimap<LowType, GameObject*>`) */
export type GameObjectBySpawnIdContainer = StdMap<number, GameObject[]>;
/** @ac game/Maps/Map.h Map::UpdatableObjectList */
export type UpdatableObjectList = WorldObject[];
/** @ac game/Maps/Map.h Map::PendingAddUpdatableObjectList */
export type PendingAddUpdatableObjectList = Set<WorldObject>;
/** `UpdateDataMapType` (`std::map<Player*, UpdateData>`): the per player update blocks `SendObjectUpdates` collects. */
export type UpdateDataMapType = StdMap<GridPlayer, UpdateData>;

/**
 * The `Player`, `Unit` and `Creature` members `Map` calls that the grid layer's `GridPlayer` / `UnitLike` do not list. The
 * player facade and the real classes provide them; each call site skips a missing one (the optional call).
 */
export interface MapPlayerExtras {
  /** @ac game/Entities/Player/Player.h Player::GetMapRef */
  getMapRef(): MapReference<MapPlayer>;
  /** @ac game/Entities/Unit/Unit.h Unit::GetViewpoint (Player::GetViewpoint) */
  getViewpoint(): WorldObject | null;
  /** @ac game/Entities/Player/Player.h Player::IsBeingTeleportedFar */
  isBeingTeleportedFar(): boolean;
  /** @ac game/Entities/Player/Player.cpp Player::TeleportTo (the `(mapid, x, y, z, orientation)` overload) */
  teleportTo(mapid: number, x: number, y: number, z: number, orientation: number): boolean;
  /** @ac game/Entities/Player/Player.h Player::m_homebindMapId and friends */
  homebind(): { mapId: number; x: number; y: number; z: number };
  /** @ac game/Entities/Player/Player.cpp Player::TeleportToEntryPoint */
  teleportToEntryPoint(): void;
  /** @ac game/Chat/Chat.cpp ChatHandler::SendSysMessage (`Player::SendSystemMessage`) */
  sendSystemMessage(text: string): void;
  /** @ac game/Entities/Player/Player.h Player::GetBattlegroundId */
  getBattlegroundId(): number;
  /** @ac game/Entities/Player/Player.h Player::GetDifficulty */
  getDifficulty(isRaid: boolean): number;
  /** @ac game/Entities/Player/Player.h Player::HasSpiritOfRedemptionAura */
  hasSpiritOfRedemptionAura(): boolean;
  /** @ac game/Entities/Player/Player.h Player::SendTransferAborted */
  sendTransferAborted(mapid: number, reason: number, arg?: number): void;
  /** @ac game/Entities/Unit/Unit.h Unit::GetThreatMgr (`RemoveMeFromThreatLists`) */
  removeMeFromThreatLists(): void;
  /** @ac game/Entities/Player/Player.h Player::m_InstanceValid */
  m_InstanceValid: boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::GetAurasForTarget */
  getAurasForTarget(target: GridPlayer, force: boolean): void;
  /** @ac game/Entities/Player/Player.h Player::GetGroup (instance and LFG checks) */
  getGroup(): unknown;
  /** @ac game/Entities/Player/Player.h Player::GetTransport */
  getTransport(): WorldObject | null;
}
export type MapPlayer = GridPlayer & Partial<MapPlayerExtras>;

/** The `Unit` / `Creature` / `GameObject` members `Map` calls that `UnitLike` does not list. */
export interface MapUnitExtras {
  /** @ac game/Entities/Unit/Unit.h Unit::ExecuteDelayedUnitRelocationEvent */
  executeDelayedUnitRelocationEvent(): void;
  /** @ac game/Entities/Unit/Unit.h Unit::IsVehicle */
  isVehicle(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::GetVehicleKit */
  getVehicleKit(): { relocatePassengers(): void; reset(evading?: boolean): void } | null;
  /** @ac game/Entities/Unit/Unit.h Unit::IsInCombat */
  isInCombat(): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::IsInEvadeMode */
  isInEvadeMode(): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::IsQuestGiver */
  isQuestGiver(): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::isWorldBoss */
  isWorldBoss(): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::GetCreatureTemplate (`rank`) */
  getCreatureTemplate(): { rank: number } | null;
  /** @ac game/Entities/Creature/Creature.h Creature::GetSpawnId / GameObject::GetSpawnId */
  getSpawnId(): number;
  /** @ac game/Entities/GameObject/GameObject.h GameObject::UpdateModelPosition */
  updateModelPosition(): void;
  /** @ac game/Entities/GameObject/GameObject.h GameObject::IsTransport */
  isTransport(): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::Respawn */
  respawn(force?: boolean): void;
}
export type MapObjectLike = WorldObject & Partial<MapUnitExtras>;

/** @ac game/Entities/Creature/Creature.h Creature (the member the respawns call) */
export interface MapSpawnCreature {
  /** @ac game/Entities/Creature/Creature.cpp Creature::LoadCreatureFromDB */
  loadCreatureFromDB(spawnId: number, map: MapLike, addToMap?: boolean, allowDuplicate?: boolean): boolean;
}

/** @ac game/Entities/GameObject/GameObject.h GameObject (the member the respawns call) */
export interface MapSpawnGameObject {
  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::LoadGameObjectFromDB */
  loadGameObjectFromDB(spawnId: number, map: MapLike, addToMap?: boolean): boolean;
}

/** @ac game/Entities/Corpse/Corpse.h Corpse (the members `Map` calls) */
export interface MapCorpse extends WorldObject {
  create(guidlow: number): boolean;
  loadCorpseFromDB(guid: number, fields: Record<string, unknown>): boolean;
  deleteFromDB(): void;
  getOwnerGUID(): bigint;
  getType(): number;
  isExpired(t: number): boolean;
  getCellCoord(): ReturnType<Corpse["getCellCoord"]>;
  setCellCoord(cellCoord: ReturnType<Corpse["getCellCoord"]>): void;
}

/** @ac game/Globals/ObjectMgr.h ObjectMgr (the members `Map` calls) */
export interface MapObjectMgr {
  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetSpawnGroupData */
  getSpawnGroupData(groupId: number): SpawnGroupTemplateData | null;
  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetSpawnDataForGroup (the range of `_spawnGroupMapStore`) */
  getSpawnDataForGroup(groupId: number): readonly SpawnData[];
  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetCreatureData */
  getSpawnCreatureData(spawnId: number): (SpawnData & { id: number }) | null;
  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetGameObjectData */
  getSpawnGameObjectData(spawnId: number): (SpawnData & { id: number }) | null;
  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetLinkedRespawnGuid */
  getLinkedRespawnGuid(guid: bigint): bigint;
  /** `creature_template.flags_extra` of an entry (`CreatureTemplate::HasFlagsExtra`) */
  getCreatureTemplateFlagsExtra(entry: number): number;
  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetDungeonEncounterList (dungeon encounters are not ported: absent until they are) */
  getDungeonEncounterList?(mapId: number, difficulty: number): readonly MapDungeonEncounter[] | null;
}

/** @ac game/Globals/ObjectMgr.h DungeonEncounter */
export interface MapDungeonEncounter {
  dbcEntry: { encounterIndex: number };
  creditType: number;
  creditEntry: number;
  lastEncounterDungeon: number;
}

/** @ac game/Pools/PoolMgr.h PoolMgr (the members `Map` calls) */
export interface MapPoolMgr {
  /** @ac game/Pools/PoolMgr.cpp PoolMgr::InitPoolsForMap */
  initPoolsForMap(map: Map): SpawnedPoolDataLike;
  /** @ac game/Pools/PoolMgr.h PoolMgr::IsPartOfAPool (`IsPartOfAPool<Creature>` / `<GameObject>`) */
  isPartOfAPool(type: "Creature" | "GameObject", spawnId: number): number;
  /** @ac game/Pools/PoolMgr.cpp PoolMgr::UpdatePool (`UpdatePool<Creature>` / `<GameObject>`) */
  updatePool(poolData: SpawnedPoolDataLike, type: "Creature" | "GameObject", poolId: number, spawnId: number): void;
}

/** @ac game/Instances/InstanceSaveMgr.h InstanceSaveMgr (the members `Map` and `MapInstanced` call; instance saves are not ported) */
export interface MapInstanceSaveMgr {
  getResetTimeFor(mapId: number, difficulty: number): number;
  getExtendedResetTimeFor(mapId: number, difficulty: number): number;
  getInstanceSave(instanceId: number): MapInstanceSave | null;
  addInstanceSave(mapId: number, instanceId: number, difficulty: number): MapInstanceSave | null;
  deleteInstanceSaveIfNeeded(instanceId: number, skipMapCheck: boolean): void;
  playerGetDestinationInstanceId(player: MapPlayer, mapId: number, difficulty: number): number;
  playerBindToInstance(playerGuid: bigint, save: MapInstanceSave, permanent: boolean, player: MapPlayer | null): unknown;
  playerGetBoundInstance(playerGuid: bigint, mapId: number, difficulty: number): { perm: boolean; save: MapInstanceSave } | null;
}
/** @ac game/Instances/InstanceSaveMgr.h InstanceSave (the members `Map` and `MapInstanced` call) */
export interface MapInstanceSave {
  getMapId(): number;
  getInstanceId(): number;
  getDifficulty(): number;
  canReset(): boolean;
  getInstanceData(): string;
  getCompletedEncounterMask(): number;
}

/** @ac game/Scripting/ScriptMgr.h ScriptMgr (the `On...` hooks `Map` calls; scripts are not ported, so each is a no-op) */
export interface MapScriptHooksType {
  onCreateMap(map: Map): void;
  onDestroyMap(map: Map): void;
  onPlayerEnterMap(map: Map, player: MapPlayer): void;
  onPlayerLeaveMap(map: Map, player: MapPlayer): void;
  onMapUpdate(map: Map, diff: number): void;
  onDestroyInstance(mapInstanced: Map, instanceMap: Map): void;
  canSendObjectUpdatesToPlayer(map: Map, player: GridPlayer): boolean;
}
export const MapScriptHooks: MapScriptHooksType = {
  onCreateMap: () => {},
  onDestroyMap: () => {},
  onPlayerEnterMap: () => {},
  onPlayerLeaveMap: () => {},
  onMapUpdate: () => {},
  onDestroyInstance: () => {},
  canSendObjectUpdatesToPlayer: () => true,
};

/**
 * What `Map` takes from other topics. The integration sets them at startup (`MapSetup.ts`).
 * - `objectMgr`: `sObjectMgr` (null: no spawn groups, no linked respawns)
 * - `poolMgr`: `sPoolMgr` (null: no pools, `GetPoolData` reports every member as spawned)
 * - `instanceSaveMgr`: `sInstanceSaveMgr` (null: instance binds are skipped)
 * - `createCreature` / `createGameObject`: `new Creature()` / `new GameObject()` (for the respawns and spawn groups)
 * - `createCorpse`: `new Corpse(type)`
 * - `updateSession`: `WorldSession::Update(diff, MapSessionFilter)` of a player's session (null: the world loop pumps sessions)
 * - `buildSystemChatPacket`: `ChatHandler::BuildChatPacket(CHAT_MSG_SYSTEM, LANG_UNIVERSAL, ..., text)`
 * - `getMaxVisibleDistanceOnContinents` / `InInstances` / `InBGArenas`: `World::GetMaxVisibleDistance*` (`Visibility.Distance.*`)
 * - `getDefaultDbcLocale`: `sWorld->GetDefaultDbcLocale()`
 * - `createInstanceScript`: `sScriptMgr->CreateInstanceScript(map)` (null: instances have no script)
 * - `getScriptName`: `sObjectMgr->GetScriptName(id)`
 */
export const MapHooks: {
  objectMgr: MapObjectMgr | null;
  poolMgr: MapPoolMgr | null;
  instanceSaveMgr: MapInstanceSaveMgr | null;
  createCreature: (() => MapSpawnCreature) | null;
  createGameObject: (() => MapSpawnGameObject) | null;
  createCorpse: ((type: number) => MapCorpse) | null;
  updateSession: ((player: MapPlayer, diff: number) => void) | null;
  buildSystemChatPacket: ((text: string) => WorldPacket) | null;
  getMaxVisibleDistanceOnContinents: () => number;
  getMaxVisibleDistanceInInstances: () => number;
  getMaxVisibleDistanceInBGArenas: () => number;
  getDefaultDbcLocale: () => number;
  createInstanceScript: ((map: InstanceMap) => MapInstanceScript | null) | null;
  getScriptName: ((scriptId: number) => string) | null;
} = {
  objectMgr: null,
  poolMgr: null,
  instanceSaveMgr: null,
  createCreature: null,
  createGameObject: null,
  createCorpse: null,
  updateSession: null,
  buildSystemChatPacket: null,
  getMaxVisibleDistanceOnContinents: () => DEFAULT_VISIBILITY_DISTANCE,
  getMaxVisibleDistanceInInstances: () => DEFAULT_VISIBILITY_INSTANCE,
  getMaxVisibleDistanceInBGArenas: () => DEFAULT_VISIBILITY_BGARENAS,
  getDefaultDbcLocale: () => DEFAULT_LOCALE,
  createInstanceScript: null,
  getScriptName: null,
};

/** `SpawnedPoolData` without a `PoolMgr`: every pool member counts as spawned (the grid loader then spawns what `ObjectMgr` listed). */
const UNPOOLED_SPAWNED_POOL_DATA: SpawnedPoolDataLike = { isSpawnedObject: () => true };

/** @ac game/Globals/ObjectMgr.h ObjectMgr::GetInstanceTemplate (re-exported for `MapInstanced`) */
export { GetInstanceTemplate };

/**
 * @ac game/Grids/GridDefines.h MapStoredObjectTypesContainer
 * `TypeUnorderedMapContainer<AllMapStoredObjectTypes, ObjectGuid>`: the creatures, gameobjects, dynamic objects, and corpses
 * of a map by guid. The C++ `Insert<T>` / `Remove<T>` pick the table by type; here the object (or the guid) says which.
 */
export class MapStoredObjectTypesContainer {
  private readonly creatures = new StdMap<bigint, Creature>();
  private readonly gameObjects = new StdMap<bigint, GameObject>();
  private readonly dynamicObjects = new StdMap<bigint, DynamicObject>();
  private readonly corpses = new StdMap<bigint, Corpse>();

  private tableFor(typeId: number): StdMap<bigint, WorldObject> | null {
    switch (typeId) {
      case TYPEID_UNIT:
        return this.creatures as StdMap<bigint, WorldObject>;
      case TYPEID_GAMEOBJECT:
        return this.gameObjects as StdMap<bigint, WorldObject>;
      case TYPEID_DYNAMICOBJECT:
        return this.dynamicObjects as StdMap<bigint, WorldObject>;
      case TYPEID_CORPSE:
        return this.corpses as StdMap<bigint, WorldObject>;
      default:
        return null;
    }
  }

  /** @ac common/Dynamic/TypeContainer.h TypeUnorderedMapContainer::Insert */
  insert(guid: bigint, obj: WorldObject): void {
    this.tableFor(obj.getTypeId())?.set(guid, obj);
  }

  /** @ac common/Dynamic/TypeContainer.h TypeUnorderedMapContainer::Remove (the table follows the guid's high part) */
  remove(guid: bigint): void {
    switch (ObjectGuid.GetHigh(guid)) {
      case HighGuid.Unit:
      case HighGuid.Pet:
      case HighGuid.Vehicle:
        this.creatures.delete(guid);
        break;
      case HighGuid.GameObject:
      case HighGuid.Transport:
        this.gameObjects.delete(guid);
        break;
      case HighGuid.DynamicObject:
        this.dynamicObjects.delete(guid);
        break;
      case HighGuid.Corpse:
        this.corpses.delete(guid);
        break;
      default:
        break;
    }
  }

  /** @ac common/Dynamic/TypeContainer.h TypeUnorderedMapContainer::Find */
  find(type: "Creature", guid: bigint): Creature | null;
  find(type: "GameObject", guid: bigint): GameObject | null;
  find(type: "DynamicObject", guid: bigint): DynamicObject | null;
  find(type: "Corpse", guid: bigint): Corpse | null;
  find(type: "Creature" | "GameObject" | "DynamicObject" | "Corpse", guid: bigint): Creature | GameObject | DynamicObject | Corpse | null {
    switch (type) {
      case "Creature":
        return this.creatures.get(guid) ?? null;
      case "GameObject":
        return this.gameObjects.get(guid) ?? null;
      case "DynamicObject":
        return this.dynamicObjects.get(guid) ?? null;
      case "Corpse":
        return this.corpses.get(guid) ?? null;
    }
  }

  /** @ac common/Dynamic/TypeContainer.h TypeUnorderedMapContainer::Size */
  size(type: "Creature" | "GameObject" | "DynamicObject" | "Corpse"): number {
    switch (type) {
      case "Creature":
        return this.creatures.size;
      case "GameObject":
        return this.gameObjects.size;
      case "DynamicObject":
        return this.dynamicObjects.size;
      case "Corpse":
        return this.corpses.size;
    }
  }

  /** The objects of one type (`GetObjectsStore().GetElements<T>()`). */
  values(type: "Creature" | "GameObject" | "DynamicObject" | "Corpse"): IterableIterator<WorldObject> {
    return this.tableFor(type === "Creature" ? TYPEID_UNIT : type === "GameObject" ? TYPEID_GAMEOBJECT : type === "DynamicObject" ? TYPEID_DYNAMICOBJECT : TYPEID_CORPSE)!.values();
  }
}

/** @ac game/Maps/Map.h Map::RespawnEntry (the key of the time ordered respawn queue) */
export interface RespawnEntry {
  respawnTime: number;
  type: SpawnObjectType;
  spawnId: number;
}

/** @ac game/Maps/Map.h Map::RespawnEntry::operator< */
function compareRespawnEntry(a: RespawnEntry, b: RespawnEntry): number {
  if (a.respawnTime !== b.respawnTime) return a.respawnTime < b.respawnTime ? -1 : 1;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.spawnId !== b.spawnId) return a.spawnId < b.spawnId ? -1 : 1;
  return 0;
}

/**
 * `std::set<RespawnEntry>` (`Map::_respawnQueue`): ordered by respawn time, then type, then spawn id. A sorted array with a
 * binary search per `insert` / `erase`; `begin()` is the first entry.
 */
export class RespawnQueue {
  private readonly entries: RespawnEntry[] = [];

  private lowerBound(entry: RespawnEntry): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareRespawnEntry(this.entries[mid]!, entry) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  insert(entry: RespawnEntry): void {
    const index = this.lowerBound(entry);
    const existing = this.entries[index];
    if (existing && compareRespawnEntry(existing, entry) === 0) return; // a set keeps one of each
    this.entries.splice(index, 0, { ...entry });
  }

  erase(entry: RespawnEntry): void {
    const index = this.lowerBound(entry);
    const existing = this.entries[index];
    if (existing && compareRespawnEntry(existing, entry) === 0) this.entries.splice(index, 1);
  }

  begin(): RespawnEntry | null {
    return this.entries[0] ?? null;
  }

  empty(): boolean {
    return this.entries.length === 0;
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }

  toArray(): readonly RespawnEntry[] {
    return this.entries;
  }
}

/**
 * The `creature_respawn` and `gameobject_respawn` rows of every map and instance, in memory.
 *
 * `Map::LoadRespawnTimes` runs the `CHAR_SEL_CREATURE_RESPAWNS` / `CHAR_SEL_GO_RESPAWNS` queries in `MapMgr::CreateBaseMap`
 * and `MapInstanced::CreateInstance`, before the first grid loads, because a creature reads its respawn time while it loads.
 * Those callers cannot wait for MySQL here, so the tables are read once at startup (`load`) and the maps read their rows from
 * this mirror. Every write goes through `Map::Save*RespawnTime` / `Remove*RespawnTime` / `DeleteRespawnTimes`, which update
 * the mirror and queue the same statement the C++ runs, so the mirror and the tables agree.
 */
export class MapRespawnStore {
  private readonly creatures = new StdMap<string, StdMap<number, number>>();
  private readonly gameObjects = new StdMap<string, StdMap<number, number>>();

  private static key(mapId: number, instanceId: number): string {
    return `${mapId}:${instanceId}`;
  }

  /** Reads both tables (`SELECT guid, respawnTime, mapId, instanceId`), replacing what was loaded. */
  async load(db: Db): Promise<void> {
    this.clear();
    const creatures = await queryFields(db, "SELECT guid, respawnTime, mapId, instanceId FROM creature_respawn");
    for (const row of creatures) this.set(this.creatures, Number(row[2]), Number(row[3]), Number(row[0]), Number(row[1]));
    const gameObjects = await queryFields(db, "SELECT guid, respawnTime, mapId, instanceId FROM gameobject_respawn");
    for (const row of gameObjects) this.set(this.gameObjects, Number(row[2]), Number(row[3]), Number(row[0]), Number(row[1]));
  }

  clear(): void {
    this.creatures.clear();
    this.gameObjects.clear();
  }

  private set(table: StdMap<string, StdMap<number, number>>, mapId: number, instanceId: number, guid: number, respawnTime: number): void {
    const key = MapRespawnStore.key(mapId, instanceId);
    let rows = table.get(key);
    if (!rows) table.set(key, (rows = new StdMap()));
    rows.set(guid, respawnTime);
  }

  /** The `(guid, respawnTime)` rows of `CHAR_SEL_CREATURE_RESPAWNS` for a map and instance. */
  creatureRespawns(mapId: number, instanceId: number): ReadonlyMap<number, number> {
    return this.creatures.get(MapRespawnStore.key(mapId, instanceId)) ?? new StdMap();
  }

  /** The `(guid, respawnTime)` rows of `CHAR_SEL_GO_RESPAWNS` for a map and instance. */
  gameObjectRespawns(mapId: number, instanceId: number): ReadonlyMap<number, number> {
    return this.gameObjects.get(MapRespawnStore.key(mapId, instanceId)) ?? new StdMap();
  }

  /** `CHAR_REP_CREATURE_RESPAWN` / `CHAR_REP_GO_RESPAWN` */
  replace(type: SpawnObjectType, mapId: number, instanceId: number, guid: number, respawnTime: number): void {
    this.set(type === SPAWN_TYPE_CREATURE ? this.creatures : this.gameObjects, mapId, instanceId, guid, respawnTime);
  }

  /** `CHAR_DEL_CREATURE_RESPAWN` / `CHAR_DEL_GO_RESPAWN` */
  remove(type: SpawnObjectType, mapId: number, instanceId: number, guid: number): void {
    (type === SPAWN_TYPE_CREATURE ? this.creatures : this.gameObjects).get(MapRespawnStore.key(mapId, instanceId))?.delete(guid);
  }

  /** `CHAR_DEL_CREATURE_RESPAWN_BY_INSTANCE` and `CHAR_DEL_GO_RESPAWN_BY_INSTANCE` */
  removeInstance(mapId: number, instanceId: number): void {
    this.creatures.delete(MapRespawnStore.key(mapId, instanceId));
    this.gameObjects.delete(MapRespawnStore.key(mapId, instanceId));
  }
}

/** The respawn times of every map (see `MapRespawnStore`). */
export const sMapRespawnStore = new MapRespawnStore();

/** `CharacterDatabase` when one is open (unit tests of the map run without MySQL: the statements are then not queued). */
function characterDatabase(): Db | null {
  try {
    return CharacterDatabase();
  } catch {
    return null;
  }
}

/** `CharacterDatabase.Execute(stmt)` of a generated statement from code that does not wait (the world tick). */
function executeCharacterStatement(sql: string, ...params: unknown[]): void {
  const db = characterDatabase();
  if (db) executeStatementAsync(db, sql, ...params);
}

/** @ac game/Maps/MapInstanced.h MapInstanced (the members `MapMgr` and `Map` call) */
export interface MapInstancedLike extends Map {
  getInstancedMaps(): StdMap<number, Map>;
  findInstanceMap(instanceId: number): Map | null;
  createInstanceForPlayer(mapId: number, player: MapPlayer): Map | null;
}

/** @ac game/Maps/Map.h Map (a `GridRefMgr<MapGridType>`: the grids link into it) */
export class Map extends GridRefMgr<MapGrid> implements MapLike, MapRefTarget<MapPlayer> {
  /** @ac game/Maps/Map.h Map::Events */
  readonly Events = new EventProcessor();
  /** @ac game/Maps/Map.h Map::CreatureGroupHolder */
  readonly CreatureGroupHolder: CreatureGroupHolderType = new StdMap();
  /** @ac game/Maps/Map.h Map::CustomData (`DataMap`) */
  readonly CustomData = new StdMap<string, unknown>();
  /** pussywizard: @ac game/Maps/Map.h Map::i_objectsForDelayedVisibility */
  readonly i_objectsForDelayedVisibility = new Set<UnitLike>();
  /** @ac game/Maps/Map.h Map::m_mapRefMgr (the players on the map; `MapReference` links into it) */
  readonly m_mapRefMgr = new MapRefMgr<MapPlayer>();

  // @ac-skip `std::mutex Lock`: maps update on one thread, so there is nothing to lock.
  protected readonly _mapGridManager: MapGridManager;
  protected i_mapEntry: MapEntry | null;
  /** `i_mapEntry->MapID`; kept apart so a map without a `Map.dbc` row (tests) still has an id. */
  private readonly i_mapId: number;
  protected readonly _mapCollisionData: MapCollisionData;
  protected i_spawnMode: number;
  protected i_InstanceId: number;
  protected m_unloadTimer = 0;
  protected m_VisibleDistance: number = DEFAULT_VISIBILITY_DISTANCE;
  /** pussywizard: @ac game/Maps/Map.h Map::_instanceResetPeriod */
  protected _instanceResetPeriod = 0;
  protected readonly _transports: TransportsContainer = new Set();
  /** `_transportsUpdateIter != _transports.end()`: `DelayedUpdate` is walking the transports */
  private _transportsUpdating = false;

  /** used for fast base_map (e.g. MapInstanced class object) search for InstanceMaps and BattlegroundMaps... */
  private readonly m_parentMap: Map;
  /** `std::bitset<TOTAL_NUMBER_OF_CELLS_PER_MAP * TOTAL_NUMBER_OF_CELLS_PER_MAP> marked_cells` */
  private readonly marked_cells = new Uint8Array((TOTAL_NUMBER_OF_CELLS_PER_MAP * TOTAL_NUMBER_OF_CELLS_PER_MAP) >> 3);
  private i_scriptLock = false;
  private readonly i_objectsToRemove = new Set<WorldObject>();
  /** `ScriptScheduleMap m_scriptSchedule` (`std::multimap<time_t, ScriptAction>`) */
  private readonly m_scriptSchedule: { time: number; action: ScriptAction }[] = [];

  private readonly _creatureRespawnTimes = new StdMap<number, number>();
  private readonly _goRespawnTimes = new StdMap<number, number>();
  /** Time-ordered index for ProcessRespawns() - avoids O(n) full scan. */
  private readonly _respawnQueue = new RespawnQueue();
  private readonly _poolData: SpawnedPoolDataLike;
  private readonly _toggledSpawnGroupIds = new Set<number>();
  private _respawnCheckTimer = 0;
  private readonly _zonePlayerCountMap = new StdMap<number, number>();
  private readonly _zoneDynamicInfo: ZoneDynamicInfoMap = new StdMap();
  private readonly _weatherUpdateTimer = new IntervalTimer();
  private readonly _defaultLight: number;
  private readonly _corpseUpdateTimer = new IntervalTimer();
  private readonly _guidGenerators = new StdMap<number, ObjectGuidGenerator>();
  private readonly _objectsStore = new MapStoredObjectTypesContainer();
  private readonly _creatureBySpawnIdStore: StdMap<number, Creature[]> = new StdMap();
  private readonly _gameobjectBySpawnIdStore: GameObjectBySpawnIdContainer = new StdMap();
  private readonly _corpsesByGrid = new StdMap<number, Set<Corpse>>();
  private readonly _corpsesByPlayer = new StdMap<bigint, Corpse>();
  private readonly _corpseBones = new Set<Corpse>();
  private readonly _updateObjects = new Set<AcObject>();
  private readonly _updatableObjectList: UpdatableObjectList = [];
  private readonly _pendingAddUpdatableObjectList: PendingAddUpdatableObjectList = new Set();
  private readonly _updatableObjectListRecheckTimer = new IntervalTimer();
  private readonly _zoneWideVisibleWorldObjectsMap: ZoneWideVisibleWorldObjectsMap = new StdMap();
  private readonly _redirectKickTimer = new TimeTrackerSmall();
  private readonly _lastAnnounceRedirectKickTimer = new TimeTrackerSmall();

  private _creaturesToMove: Creature[] = [];
  private _gameObjectsToMove: GameObject[] = [];
  private _dynamicObjectsToMove: DynamicObject[] = [];

  /** @ac game/Maps/Map.cpp Map::Map */
  constructor(id: number, InstanceId: number, SpawnMode: number, _parent: Map | null = null) {
    super();
    this._mapGridManager = new MapGridManager(this);
    this.i_mapEntry = sMapStore.lookupEntry(id);
    this.i_mapId = id;
    this._mapCollisionData = new MapCollisionData(this, _parent);
    this.i_spawnMode = SpawnMode;
    this.i_InstanceId = InstanceId;
    this._defaultLight = GetDefaultMapLight(id);

    this.m_parentMap = _parent ?? this;

    this._zonePlayerCountMap.clear();
    this._updatableObjectListRecheckTimer.setInterval(UPDATABLE_OBJECT_LIST_RECHECK_TIMER);

    // lets initialize visibility distance for map (`Map::InitVisibilityDistance()` is not virtual here)
    Map.prototype.initVisibilityDistance.call(this);

    this._weatherUpdateTimer.setInterval(1 * 1000);
    this._corpseUpdateTimer.setInterval(20 * MINUTE * 1000);

    this._poolData = MapHooks.poolMgr?.initPoolsForMap(this) ?? UNPOOLED_SPAWNED_POOL_DATA;
  }

  /**
   * @ac game/Maps/Map.cpp Map::~Map
   * UnloadAll must be called before deleting the map. Kill all scheduled events without executing them, since the map and
   * its objects are being destroyed. @ac-skip `sScriptMgr->DecreaseScheduledScriptCount`: scripts are not ported.
   */
  destroy(): void {
    this.Events.killAllEvents(false);

    MapScriptHooks.onDestroyMap(this);
  }

  /** @ac game/Maps/Map.h Map::GetEntry */
  getEntry(): MapEntry | null {
    return this.i_mapEntry;
  }

  /** @ac game/Maps/Map.h Map::CanUnload (currently unused for normal maps) */
  canUnload(diff: number): boolean {
    if (!this.m_unloadTimer || this.Events.hasEvents()) return false;

    if (this.m_unloadTimer <= diff) return true;

    this.m_unloadTimer -= diff;
    return false;
  }

  /** @ac game/Maps/Map.h Map::GetId */
  getId(): number {
    return this.i_mapEntry ? this.i_mapEntry.MapID : this.i_mapId;
  }

  /** @ac game/Maps/Map.h Map::GetParent */
  getParent(): Map {
    return this.m_parentMap;
  }

  /** @ac game/Maps/Map.h Map::GetInstanceId */
  getInstanceId(): number {
    return this.i_InstanceId;
  }

  /** @ac game/Maps/Map.h Map::GetSpawnMode */
  getSpawnMode(): number {
    return this.i_spawnMode;
  }

  /** @ac game/Maps/Map.h Map::GetVisibilityRange */
  getVisibilityRange(): number {
    return this.m_VisibleDistance;
  }

  /** @ac game/Maps/Map.h Map::SetVisibilityRange */
  setVisibilityRange(range: number): void {
    this.m_VisibleDistance = range;
  }

  /**
   * @ac game/Maps/Map.cpp Map::OnCreateMap
   * Hook called after map is created AND after added to map list. Instances load all grids by default (both base map and
   * child maps).
   */
  onCreateMap(): void {
    if (this.getInstanceId()) this.loadAllGrids();

    MapScriptHooks.onCreateMap(this);
  }

  /** @ac game/Maps/Map.cpp Map::InitVisibilityDistance (function for setting up visibility distance for maps on per-type/per-Id basis) */
  initVisibilityDistance(): void {
    // init visibility for continents
    this.m_VisibleDistance = MapHooks.getMaxVisibleDistanceOnContinents();

    switch (this.getId()) {
      case MAP_EBON_HOLD: // Scarlet Enclave (DK starting zone)
        this.m_VisibleDistance = 125.0;
        break;
      case MAP_SCOTT_TEST: // (box map)
        this.m_VisibleDistance = 200.0;
        break;
    }
  }

  /**
   * @ac game/Maps/Map.cpp Map::AddToGrid
   * The per-type specializations: creatures and gameobjects also join the far visible container when they are far visible;
   * players are not given a current cell; a corpse is only added when the grid's object data is loaded (corpses are added
   * to the grid via `AddToMap` or loaded through `GridObjectLoader`, and both are added to `_corpsesByGrid`; the loader
   * adds all corpses from there even if they were already added to the grid before it was loaded, so the check avoids
   * failing the assertion in `GridObject::AddToGrid`); anything else (dynamic objects) is the generic template.
   */
  addToGrid(obj: GridStoredObject, cell: Cell): void {
    const grid = this.getMapGrid(cell.gridX(), cell.gridY())!;
    switch (obj.getTypeId()) {
      case TYPEID_UNIT:
      case TYPEID_GAMEOBJECT: {
        grid.addGridObject(cell.cellX(), cell.cellY(), obj);
        const far = obj as Creature | GameObject;
        if (far.isFarVisible()) grid.addFarVisibleObject(cell.cellX(), cell.cellY(), far);

        (obj as WorldObject).setCurrentCell(cell);
        break;
      }
      case TYPEID_PLAYER:
        grid.addGridObject(cell.cellX(), cell.cellY(), obj);
        break;
      case TYPEID_CORPSE:
        if (grid.isObjectDataLoaded()) grid.addGridObject(cell.cellX(), cell.cellY(), obj);
        break;
      default:
        grid.addGridObject(cell.cellX(), cell.cellY(), obj);

        (obj as WorldObject).setCurrentCell(cell);
        break;
    }
  }

  /**
   * @ac game/Maps/Map.cpp Map::DeleteFromWorld
   * `delete obj`: a map object has no destructor to run here; what `~Object` does (leave the update object queue) is done
   * here, and the object is otherwise forgotten (the by-guid stores drop it in `RemoveFromWorld`). For a player,
   * `ObjectAccessor::RemoveObject(player)` and `delete player` belong to the session.
   * @ac-skip ObjectAccessor::RemoveObject(player): the online players are `WorldSessionMgr`'s
   */
  private deleteFromWorld(obj: WorldObject): void {
    this.removeUpdateObject(obj);
  }

  /** @ac game/Maps/Map.cpp Map::EnsureGridCreated */
  ensureGridCreated(gridCoord: GridCoord): void {
    this._mapGridManager.createGrid(gridCoord.x_coord, gridCoord.y_coord);
  }

  /** @ac game/Maps/Map.cpp Map::EnsureGridLoaded */
  protected ensureGridLoaded(cell: Cell): boolean {
    this.ensureGridCreated(new GridCoord(cell.gridX(), cell.gridY()));

    if (this._mapGridManager.loadGrid(cell.gridX(), cell.gridY())) {
      this.balance();
      return true;
    }

    return false;
  }

  /** @ac game/Maps/Map.cpp Map::GetMapGrid */
  protected getMapGrid(x: number, y: number): MapGrid | null {
    return this._mapGridManager.getGrid(x, y);
  }

  /** @ac game/Maps/Map.cpp Map::IsGridLoaded (the `(GridCoord const&)` and `(float x, float y)` overloads) */
  isGridLoaded(gridCoord: GridCoord): boolean;
  isGridLoaded(x: number, y: number): boolean;
  isGridLoaded(a: GridCoord | number, y?: number): boolean {
    const gridCoord = typeof a === "number" ? ComputeGridCoord(a, y!) : a;
    return this._mapGridManager.isGridLoaded(gridCoord.x_coord, gridCoord.y_coord);
  }

  /** @ac game/Maps/Map.cpp Map::IsGridCreated (the `(GridCoord const&)` and `(float x, float y)` overloads) */
  isGridCreated(gridCoord: GridCoord): boolean;
  isGridCreated(x: number, y: number): boolean;
  isGridCreated(a: GridCoord | number, y?: number): boolean {
    const gridCoord = typeof a === "number" ? ComputeGridCoord(a, y!) : a;
    return this._mapGridManager.isGridCreated(gridCoord.x_coord, gridCoord.y_coord);
  }

  /** @ac game/Maps/Map.cpp Map::LoadGrid */
  loadGrid(x: number, y: number): void {
    this.ensureGridLoaded(new Cell(x, y));
  }

  /** @ac game/Maps/Map.cpp Map::LoadAllGrids */
  loadAllGrids(): void {
    for (let cellX = 0; cellX < TOTAL_NUMBER_OF_CELLS_PER_MAP; cellX++)
      for (let cellY = 0; cellY < TOTAL_NUMBER_OF_CELLS_PER_MAP; cellY++)
        this.loadGrid((cellX + 0.5 - CENTER_GRID_CELL_ID) * SIZE_OF_GRID_CELL, (cellY + 0.5 - CENTER_GRID_CELL_ID) * SIZE_OF_GRID_CELL);
  }

  /** @ac game/Maps/Map.cpp Map::LoadGridsInRange */
  loadGridsInRange(center: PositionLike, radius: number): void {
    if (this._mapGridManager.isGridsFullyLoaded()) return;

    const x = center.getPositionX();
    const y = center.getPositionY();

    const cellCoord = ComputeCellCoord(x, y);
    if (!cellCoord.isCoordValid()) return;

    if (radius > SIZE_OF_GRIDS) radius = SIZE_OF_GRIDS;

    const area = Cell.calculateCellArea(x, y, radius);
    if (area.isEmpty()) return;

    for (let cx = area.low_bound.x_coord; cx <= area.high_bound.x_coord; ++cx) {
      for (let cy = area.low_bound.y_coord; cy <= area.high_bound.y_coord; ++cy) {
        this.ensureGridLoaded(new Cell(new CellCoord(cx, cy)));
      }
    }
  }

  /** @ac game/Maps/Map.cpp Map::AddPlayerToMap */
  addPlayerToMap(player: MapPlayer): boolean {
    const cellCoord = ComputeCellCoord(player.getPositionX(), player.getPositionY());
    if (!cellCoord.isCoordValid()) {
      logError(
        "maps",
        `Map::Add: Player (${ObjectGuid.ToString(player.getGUID())}) has invalid coordinates X:${player.getPositionX()} Y:${player.getPositionY()} grid cell [${cellCoord.x_coord}:${cellCoord.y_coord}]`,
      );
      return false;
    }

    const cell = new Cell(cellCoord);
    this.loadGridsInRange(player, MAX_VISIBILITY_DISTANCE);
    this.addToGrid(player, cell);

    // Check if we are adding to correct map
    if (player.findMap() !== this) throw new Error("ASSERT failed: player->GetMap() == this (Map::AddPlayerToMap)");
    player.setMap(this);
    player.addToWorld();

    this.sendInitTransports(player);
    this.sendInitSelf(player);

    player.updateObjectVisibility(false);

    if (player.isAlive()) this.convertCorpseToBones(player.getGUID());

    MapScriptHooks.onPlayerEnterMap(this, player);
    return true;
  }

  /**
   * @ac game/Maps/Map.cpp Map::InitializeObject
   * The templates are empty for every type; the `_moveState = MAP_OBJECT_CELL_MOVE_NONE` lines of the Creature and
   * GameObject specializations are commented out in the C++.
   */
  private initializeObject(_obj: WorldObject): void {}

  /**
   * @ac game/Maps/Map.cpp Map::AddToMap
   * The `Corpse`, `Creature`, `GameObject`, and `DynamicObject` instantiations. The object must already have its map set
   * (`obj->SetMap(this)`, usually during `Create`). Transports have `addTransportToMap`.
   */
  addToMap(obj: WorldObject, checkTransport = false): boolean {
    // TODO: Needs clean up. An object should not be added to map twice.
    if (obj.isInWorld()) {
      if (!obj.isInGrid()) throw new Error("ASSERT failed: obj->IsInGrid() (Map::AddToMap)");
      obj.updateObjectVisibility(true);
      return true;
    }

    const cellCoord = ComputeCellCoord(obj.getPositionX(), obj.getPositionY());
    // It will create many problems (including crashes) if an object is not added to grid after creation
    // The correct way to fix it is to make AddToMap return false and delete the object if it is not added to grid
    // But now AddToMap is used in too many places, I will just see how many ASSERT failures it will cause
    if (!cellCoord.isCoordValid()) {
      logError(
        "maps",
        `Map::AddToMap: Object ${ObjectGuid.ToString(obj.getGUID())} has invalid coordinates X:${obj.getPositionX()} Y:${obj.getPositionY()} grid cell [${cellCoord.x_coord}:${cellCoord.y_coord}]`,
      );
      return false; // Should delete object
    }

    const cell = new Cell(cellCoord);
    if (obj.isActiveObject()) this.ensureGridLoaded(cell);
    else this.ensureGridCreated(new GridCoord(cell.gridX(), cell.gridY()));

    this.addToGrid(obj as GridStoredObject, cell);

    // Must already be set before AddToMap. Usually during obj->Create.
    // obj->SetMap(this);
    obj.addToWorld();

    if (checkTransport)
      if (!(obj.isGameObject() && (obj as MapObjectLike).isTransport?.()))
        // dont add transport to transport ;d
        this.getTransportForPos(obj.getPhaseMask(), obj.getPositionX(), obj.getPositionY(), obj.getPositionZ(), obj);
    // @ac-skip Transport::AddPassenger: `GetTransportForPos` finds no transport until transports are ported

    this.initializeObject(obj);

    // something, such as vehicle, needs to be update immediately
    // also, trigger needs to cast spell, if not update, cannot see visual
    obj.updateObjectVisibilityOnCreate();

    // Post-visibility so accessories seat after the vehicle's create packet reaches clients.
    if (obj.isCreature()) (obj as MapObjectLike).getVehicleKit?.()?.reset();
    return true;
  }

  /**
   * @ac game/Maps/Map.cpp Map::AddToMap (the `Transport*` specialization)
   * @ac-skip Transport: the `Transport` class is not ported; this takes any transport-like world object.
   */
  addTransportToMap(obj: WorldObject, _checkTransport = false): boolean {
    // TODO: Needs clean up. An object should not be added to map twice.
    if (obj.isInWorld()) return true;

    const cellCoord = ComputeCellCoord(obj.getPositionX(), obj.getPositionY());
    if (!cellCoord.isCoordValid()) {
      logError(
        "maps",
        `Map::Add: Object ${ObjectGuid.ToString(obj.getGUID())} has invalid coordinates X:${obj.getPositionX()} Y:${obj.getPositionY()} grid cell [${cellCoord.x_coord}:${cellCoord.y_coord}]`,
      );
      return false; // Should delete object
    }

    const cell = new Cell(cellCoord);
    this.ensureGridLoaded(cell);

    obj.addToWorld();

    this._transports.add(obj);

    // Broadcast creation to players
    // Skip players that are not in world. Sending the create to their loading client
    // could materialize a lingering transport on whatever map they are teleporting to.
    // They get the correct transport list from SendInitTransports when added to their new map
    for (const player of this.m_mapRefMgr) {
      if (player.isInWorld() && player.getTransport?.() !== obj) {
        const data = new UpdateData();
        obj.buildCreateUpdateBlockForPlayer(data, player);
        player.sendDirectMessage(data.buildPacket());
      }
    }

    return true;
  }

  /** @ac game/Maps/Map.cpp Map::MarkNearbyCellsOf */
  markNearbyCellsOf(obj: WorldObject): void {
    // Check for valid position
    if (!obj.isPositionValid()) return;

    // Update mobs/objects in ALL visible cells around object!
    const area = Cell.calculateCellArea(obj.getPositionX(), obj.getPositionY(), obj.getGridActivationRange());
    for (let x = area.low_bound.x_coord; x <= area.high_bound.x_coord; ++x) {
      for (let y = area.low_bound.y_coord; y <= area.high_bound.y_coord; ++y) {
        // marked cells are those that have been visited
        const cell_id = y * TOTAL_NUMBER_OF_CELLS_PER_MAP + x;
        this.markCell(cell_id);
      }
    }
  }

  /** @ac game/Maps/Map.cpp Map::UpdatePlayerZoneStats */
  updatePlayerZoneStats(oldZone: number, newZone: number): void {
    // Nothing to do if no change
    if (oldZone === newZone) return;

    if (oldZone !== MAP_INVALID_ZONE) {
      const oldZoneCount = this._zonePlayerCountMap.get(oldZone) ?? 0;
      if (oldZoneCount) this._zonePlayerCountMap.set(oldZone, oldZoneCount - 1);
      else if (!this._zonePlayerCountMap.has(oldZone)) this._zonePlayerCountMap.set(oldZone, 0); // `operator[]` inserts a zero
    }

    if (newZone !== MAP_INVALID_ZONE) this._zonePlayerCountMap.set(newZone, (this._zonePlayerCountMap.get(newZone) ?? 0) + 1);
  }

  /** @ac game/Maps/Map.cpp Map::Update */
  update(t_diff: number, s_diff: number, _thread = true): void {
    if (t_diff) this._mapCollisionData.getDynamicTree().update(t_diff);

    // Update world sessions and players
    for (const player of this.m_mapRefMgr) {
      if (player && player.isInWorld()) {
        // Update session (`MapSessionFilter`)
        MapHooks.updateSession?.(player, s_diff);

        // update players at tick
        if (!t_diff) player.update(s_diff);
      }
    }

    this.Events.update(t_diff);

    if (!t_diff) {
      this.handleDelayedVisibility();
      return;
    }

    /// Process any due respawns (non-compatibility mode spawns)
    if (!sWorld().getBoolConfig(ServerConfig.CONFIG_RESPAWN_FORCE_COMPATIBILITY_MODE)) {
      if (this._respawnCheckTimer <= t_diff) {
        this.processRespawns();
        this._respawnCheckTimer = 5000; // Check every 5 seconds
      } else this._respawnCheckTimer -= t_diff;
    }

    this._updatableObjectListRecheckTimer.update(t_diff);
    this.resetMarkedCells();

    // Update players
    for (const player of this.m_mapRefMgr) {
      if (!player || !player.isInWorld()) continue;

      player.update(s_diff);

      if (this._updatableObjectListRecheckTimer.passed()) {
        this.markNearbyCellsOf(player);

        // If player is using far sight, update viewpoint
        const viewPoint = player.getViewpoint?.() ?? null;
        if (viewPoint) {
          const viewCreature = viewPoint.toCreature();
          if (viewCreature) this.markNearbyCellsOf(viewCreature);
          else {
            const viewObject = viewPoint.toDynObject();
            if (viewObject) this.markNearbyCellsOf(viewObject);
          }
        }
      }
    }

    this.updateNonPlayerObjects(t_diff);

    this.sendObjectUpdates();

    ///- Process necessary scripts
    if (this.m_scriptSchedule.length > 0) {
      this.i_scriptLock = true;
      this.scriptsProcess();
      this.i_scriptLock = false;
    }

    this.moveAllCreaturesInMoveList();
    this.moveAllGameObjectsInMoveList();
    this.moveAllDynamicObjectsInMoveList();

    this.handleDelayedVisibility();

    this.updatePlayersRedirectKickEvent(t_diff);

    this.updateWeather(t_diff);
    this.updateExpiredCorpses(t_diff);

    MapScriptHooks.onMapUpdate(this, t_diff);

    // @ac-skip METRIC_VALUE("map_creatures"), METRIC_VALUE("map_gameobjects"): metrics are not ported
  }

  /** @ac game/Maps/Map.cpp Map::UpdateNonPlayerObjects */
  private updateNonPlayerObjects(diff: number): void {
    for (const obj of this._pendingAddUpdatableObjectList) this._AddObjectToUpdateList(obj);
    this._pendingAddUpdatableObjectList.clear();

    if (this._updatableObjectListRecheckTimer.passed()) {
      for (let i = 0; i < this._updatableObjectList.length; ) {
        const obj = this._updatableObjectList[i]!;
        if (!obj.isInWorld()) {
          ++i;
          continue;
        }

        obj.update(diff);

        if (!obj.isUpdateNeeded()) {
          this._RemoveObjectFromUpdateList(obj);
          // Intentional no iteration here, obj is swapped with last element in
          // _updatableObjectList so next loop will update that object at the same index
        } else ++i;
      }
      this._updatableObjectListRecheckTimer.reset();
    } else {
      for (let i = 0; i < this._updatableObjectList.length; ++i) {
        const obj = this._updatableObjectList[i]!;
        if (!obj.isInWorld()) continue;

        obj.update(diff);
      }
    }
  }

  /** @ac game/Maps/Map.cpp Map::AddObjectToPendingUpdateList */
  addObjectToPendingUpdateList(obj: WorldObject): void {
    if (!obj.canBeAddedToMapUpdateList()) return;

    if (obj.getUpdateState() !== UpdateState.NotUpdating) return;

    this._pendingAddUpdatableObjectList.add(obj);
    obj.setUpdateState(UpdateState.PendingAdd);
  }

  /** @ac game/Maps/Map.cpp Map::_AddObjectToUpdateList (internal use only) */
  private _AddObjectToUpdateList(obj: WorldObject): void {
    if (obj.getUpdateState() !== UpdateState.PendingAdd) throw new Error("ASSERT failed: mapUpdatableObject->GetUpdateState() == PendingAdd");

    obj.setUpdateState(UpdateState.Updating);
    obj.setMapUpdateListOffset(this._updatableObjectList.length);
    this._updatableObjectList.push(obj);
  }

  /** @ac game/Maps/Map.cpp Map::_RemoveObjectFromUpdateList (internal use only) */
  private _RemoveObjectFromUpdateList(obj: WorldObject): void {
    if (obj.getUpdateState() !== UpdateState.Updating) throw new Error("ASSERT failed: mapUpdatableObject->GetUpdateState() == Updating");

    const last = this._updatableObjectList[this._updatableObjectList.length - 1]!;
    if (obj !== last) {
      const offset = obj.getMapUpdateListOffset();
      last.setMapUpdateListOffset(offset);
      // std::swap(_updatableObjectList[offset], _updatableObjectList.back())
      this._updatableObjectList[offset] = last;
      this._updatableObjectList[this._updatableObjectList.length - 1] = obj;
    }

    this._updatableObjectList.pop();
    obj.setUpdateState(UpdateState.NotUpdating);
  }

  /** @ac game/Maps/Map.cpp Map::RemoveObjectFromMapUpdateList */
  removeObjectFromMapUpdateList(obj: WorldObject): void {
    if (!obj.canBeAddedToMapUpdateList()) return;

    if (obj.getUpdateState() === UpdateState.PendingAdd) this._pendingAddUpdatableObjectList.delete(obj);
    else if (obj.getUpdateState() === UpdateState.Updating) this._RemoveObjectFromUpdateList(obj);
  }

  /** @ac game/Maps/Map.cpp Map::AddWorldObjectToFarVisibleMap (used in VisibilityDistanceType::Large and VisibilityDistanceType::Gigantic) */
  addWorldObjectToFarVisibleMap(obj: WorldObject): void {
    const creature = obj.toCreature();
    if (creature) {
      if (!creature.isInGrid()) return;

      const curr_cell = creature.getCurrentCell();
      const grid = this.getMapGrid(curr_cell.gridX(), curr_cell.gridY())!;
      grid.addFarVisibleObject(curr_cell.cellX(), curr_cell.cellY(), creature);
      return;
    }

    const go = obj.toGameObject();
    if (go) {
      if (!go.isInGrid()) return;

      const curr_cell = go.getCurrentCell();
      const grid = this.getMapGrid(curr_cell.gridX(), curr_cell.gridY())!;
      grid.addFarVisibleObject(curr_cell.cellX(), curr_cell.cellY(), go);
    }
  }

  /** @ac game/Maps/Map.cpp Map::RemoveWorldObjectFromFarVisibleMap */
  removeWorldObjectFromFarVisibleMap(obj: WorldObject): void {
    const creature = obj.toCreature();
    if (creature) {
      const curr_cell = creature.getCurrentCell();
      const grid = this.getMapGrid(curr_cell.gridX(), curr_cell.gridY())!;
      grid.removeFarVisibleObject(curr_cell.cellX(), curr_cell.cellY(), creature);
      return;
    }

    const go = obj.toGameObject();
    if (go) {
      const curr_cell = go.getCurrentCell();
      const grid = this.getMapGrid(curr_cell.gridX(), curr_cell.gridY())!;
      grid.removeFarVisibleObject(curr_cell.cellX(), curr_cell.cellY(), go);
    }
  }

  /** @ac game/Maps/Map.cpp Map::AddWorldObjectToZoneWideVisibleMap (used in VisibilityDistanceType::Infinite) */
  addWorldObjectToZoneWideVisibleMap(zoneId: number, obj: WorldObject): void {
    let set = this._zoneWideVisibleWorldObjectsMap.get(zoneId);
    if (!set) this._zoneWideVisibleWorldObjectsMap.set(zoneId, (set = new Set()));
    set.add(obj);
  }

  /** @ac game/Maps/Map.cpp Map::RemoveWorldObjectFromZoneWideVisibleMap */
  removeWorldObjectFromZoneWideVisibleMap(zoneId: number, obj: WorldObject): void {
    this._zoneWideVisibleWorldObjectsMap.get(zoneId)?.delete(obj);
  }

  /** @ac game/Maps/Map.cpp Map::GetZoneWideVisibleWorldObjectsForZone */
  getZoneWideVisibleWorldObjectsForZone(zoneId: number): ZoneWideVisibleWorldObjectsSet | null {
    return this._zoneWideVisibleWorldObjectsMap.get(zoneId) ?? null;
  }

  /** @ac game/Maps/Map.cpp Map::HandleDelayedVisibility (pussywizard) */
  handleDelayedVisibility(): void {
    if (this.i_objectsForDelayedVisibility.size === 0) return;
    for (const unit of this.i_objectsForDelayedVisibility) (unit as MapObjectLike).executeDelayedUnitRelocationEvent?.();
    this.i_objectsForDelayedVisibility.clear();
  }

  /** @ac game/Maps/Map.cpp Map::RemovePlayerFromMap */
  removePlayerFromMap(player: MapPlayer, remove: boolean): void {
    this.updatePlayerZoneStats(player.getZoneId(), MAP_INVALID_ZONE);

    player.removeMeFromThreatLists?.(); // pussywizard: multithreading crashfix

    player.removeFromWorld();
    this.sendRemoveTransports(player);

    if (player.isInGrid()) player.removeFromGrid();
    else if (!remove) throw new Error("ASSERT failed: remove (Map::RemovePlayerFromMap) - maybe deleted in logoutplayer when player is not in a map");

    MapScriptHooks.onPlayerLeaveMap(this, player);
    if (remove) this.deleteFromWorld(player);
  }

  /** @ac game/Maps/Map.cpp Map::AfterPlayerUnlinkFromMap */
  afterPlayerUnlinkFromMap(): void {}

  /** @ac game/Maps/Map.cpp Map::RemoveFromMap (the `Corpse`, `Creature`, `GameObject`, and `DynamicObject` instantiations) */
  removeFromMap(obj: WorldObject, remove: boolean): void {
    obj.removeFromWorld();

    obj.removeFromGrid();

    obj.resetMap();

    if (remove) {
      this.removeObjectFromMapUpdateList(obj);
      this.deleteFromWorld(obj);
    }
  }

  /**
   * @ac game/Maps/Map.cpp Map::RemoveFromMap (the `Transport*` specialization)
   * @ac-skip Transport: the `Transport` class is not ported; this takes any transport-like world object.
   */
  removeTransportFromMap(obj: WorldObject, remove: boolean): void {
    obj.removeFromWorld();

    if (!this.m_mapRefMgr.isEmpty()) {
      const data = new UpdateData();
      obj.buildOutOfRangeUpdateBlock(data);
      const packet = data.buildPacket();
      // Skip players that are not in world
      // Their client already received the destroy from SendRemoveTransports when leaving this map
      for (const player of this.m_mapRefMgr) if (player.isInWorld() && player.getTransport?.() !== obj) player.sendDirectMessage(packet);
    }

    if (this._transportsUpdating) {
      if (!this._transports.has(obj)) return;
      this._transports.delete(obj);
    } else this._transports.delete(obj);

    obj.resetMap();

    this.removeObjectFromMapUpdateList(obj);

    if (remove) {
      // if option set then object already saved at this moment
      if (!sWorld().getBoolConfig(ServerConfig.CONFIG_SAVE_RESPAWN_TIME_IMMEDIATELY)) (obj as unknown as { saveRespawnTime?(): void }).saveRespawnTime?.();
      this.deleteFromWorld(obj);
    }
  }

  /** @ac game/Maps/Map.cpp Map::PlayerRelocation */
  playerRelocation(player: MapPlayer, x: number, y: number, z: number, o: number): void {
    const old_cell = new Cell(player.getPositionX(), player.getPositionY());
    const new_cell = new Cell(x, y);

    if (old_cell.diffGrid(new_cell) || old_cell.diffCell(new_cell)) {
      player.removeFromGrid();

      if (old_cell.diffGrid(new_cell)) this.ensureGridLoaded(new_cell);

      this.addToGrid(player, new_cell);
    }

    player.relocate(x, y, z, o);
    const unit = player as MapObjectLike;
    if (unit.isVehicle?.()) unit.getVehicleKit?.()?.relocatePassengers();
    player.updatePositionData();
    player.updateObjectVisibility(false);
  }

  /** @ac game/Maps/Map.cpp Map::CreatureRelocation */
  creatureRelocation(creature: Creature, x: number, y: number, z: number, o: number): void {
    const old_cell = creature.getCurrentCell();
    const new_cell = new Cell(x, y);

    const cellChanged = old_cell.diffGrid(new_cell) || old_cell.diffCell(new_cell);

    if (cellChanged) {
      if (old_cell.diffGrid(new_cell)) this.ensureGridLoaded(new_cell);

      this.addCreatureToMoveList(creature);
    } else this.removeCreatureFromMoveList(creature);

    creature.relocate(x, y, z, o);
    const unit = creature as MapObjectLike;
    if (unit.isVehicle?.()) unit.getVehicleKit?.()?.relocatePassengers();

    // Terrain status (zone / area / floor / liquid) is derived lazily: the getters recompute it on
    // demand, the same as for GameObjects. GetFullTerrainStatusForPosition() is VMAP-heavy and used to
    // run on every spline sub-step, so a wandering creature that nothing is querying now costs no
    // raycast. Re-derive eagerly here only when the result must be exact immediately and nothing is
    // guaranteed to read it:
    //  - the creature changed grid cell;
    //  - it is in combat or evading home (a mob chasing / returning through water must have the
    //    correct swim state at once);
    //  - it is zone-wide visible (world boss / event NPC) - ProcessPositionDataChanged() moves it
    //    between zone visibility maps only on a real derive, so throttling could hide it from players
    //    after it crosses a zone border.
    // For a plain wandering creature, Creature::Update() keeps the swim / fly / hover flags in step
    // with the terrain it moves over.
    if (cellChanged || unit.isInCombat?.() || unit.isInEvadeMode?.() || creature.isZoneWideVisible()) creature.updatePositionData();
    else creature.setPositionDataUpdate();

    creature.updateObjectVisibility(false);
  }

  /** @ac game/Maps/Map.cpp Map::GameObjectRelocation */
  gameObjectRelocation(go: GameObject, x: number, y: number, z: number, o: number): void {
    const old_cell = go.getCurrentCell();
    const new_cell = new Cell(x, y);

    if (old_cell.diffGrid(new_cell) || old_cell.diffCell(new_cell)) {
      if (old_cell.diffGrid(new_cell)) this.ensureGridLoaded(new_cell);

      this.addGameObjectToMoveList(go);
    } else this.removeGameObjectFromMoveList(go);

    go.relocate(x, y, z, o);
    (go as MapObjectLike).updateModelPosition?.();
    go.setPositionDataUpdate();
    go.updateObjectVisibility(false);
  }

  /** @ac game/Maps/Map.cpp Map::DynamicObjectRelocation */
  dynamicObjectRelocation(dynObj: DynamicObject, x: number, y: number, z: number, o: number): void {
    const old_cell = dynObj.getCurrentCell();
    const new_cell = new Cell(x, y);

    if (old_cell.diffGrid(new_cell) || old_cell.diffCell(new_cell)) {
      if (old_cell.diffGrid(new_cell)) this.ensureGridLoaded(new_cell);

      this.addDynamicObjectToMoveList(dynObj);
    } else this.removeDynamicObjectFromMoveList(dynObj);

    dynObj.relocate(x, y, z, o);
    dynObj.setPositionDataUpdate();
    dynObj.updateObjectVisibility(false);
  }

  /** @ac game/Maps/Map.cpp Map::AddCreatureToMoveList */
  private addCreatureToMoveList(c: Creature): void {
    if (c._moveState === MAP_OBJECT_CELL_MOVE_NONE) this._creaturesToMove.push(c);
    c._moveState = MAP_OBJECT_CELL_MOVE_ACTIVE;
  }

  /** @ac game/Maps/Map.cpp Map::RemoveCreatureFromMoveList */
  private removeCreatureFromMoveList(c: Creature): void {
    if (c._moveState === MAP_OBJECT_CELL_MOVE_ACTIVE) c._moveState = MAP_OBJECT_CELL_MOVE_INACTIVE;
  }

  /** @ac game/Maps/Map.cpp Map::AddGameObjectToMoveList */
  private addGameObjectToMoveList(go: GameObject): void {
    if (go._moveState === MAP_OBJECT_CELL_MOVE_NONE) this._gameObjectsToMove.push(go);
    go._moveState = MAP_OBJECT_CELL_MOVE_ACTIVE;
  }

  /** @ac game/Maps/Map.cpp Map::RemoveGameObjectFromMoveList */
  private removeGameObjectFromMoveList(go: GameObject): void {
    if (go._moveState === MAP_OBJECT_CELL_MOVE_ACTIVE) go._moveState = MAP_OBJECT_CELL_MOVE_INACTIVE;
  }

  /** @ac game/Maps/Map.cpp Map::AddDynamicObjectToMoveList */
  private addDynamicObjectToMoveList(dynObj: DynamicObject): void {
    if (dynObj._moveState === MAP_OBJECT_CELL_MOVE_NONE) this._dynamicObjectsToMove.push(dynObj);
    dynObj._moveState = MAP_OBJECT_CELL_MOVE_ACTIVE;
  }

  /** @ac game/Maps/Map.cpp Map::RemoveDynamicObjectFromMoveList */
  private removeDynamicObjectFromMoveList(dynObj: DynamicObject): void {
    if (dynObj._moveState === MAP_OBJECT_CELL_MOVE_ACTIVE) dynObj._moveState = MAP_OBJECT_CELL_MOVE_INACTIVE;
  }

  /** @ac game/Maps/Map.cpp Map::MoveAllCreaturesInMoveList */
  moveAllCreaturesInMoveList(): void {
    for (const c of this._creaturesToMove) {
      if (c.findMap() !== this) continue;

      if (c._moveState !== MAP_OBJECT_CELL_MOVE_ACTIVE) {
        c._moveState = MAP_OBJECT_CELL_MOVE_NONE;
        continue;
      }

      c._moveState = MAP_OBJECT_CELL_MOVE_NONE;
      if (!c.isInWorld()) continue;

      const old_cell = c.getCurrentCell();
      const new_cell = new Cell(c.getPositionX(), c.getPositionY());
      if (c.isFarVisible()) {
        // Removes via GetCurrentCell, added back in AddToGrid
        this.removeWorldObjectFromFarVisibleMap(c);
      }

      c.removeFromGrid();
      if (old_cell.diffGrid(new_cell)) this.ensureGridLoaded(new_cell);
      this.addToGrid(c, new_cell);
    }
    this._creaturesToMove = [];
  }

  /** @ac game/Maps/Map.cpp Map::MoveAllGameObjectsInMoveList */
  moveAllGameObjectsInMoveList(): void {
    for (const go of this._gameObjectsToMove) {
      if (go.findMap() !== this) continue;

      if (go._moveState !== MAP_OBJECT_CELL_MOVE_ACTIVE) {
        go._moveState = MAP_OBJECT_CELL_MOVE_NONE;
        continue;
      }

      go._moveState = MAP_OBJECT_CELL_MOVE_NONE;
      if (!go.isInWorld()) continue;

      const old_cell = go.getCurrentCell();
      const new_cell = new Cell(go.getPositionX(), go.getPositionY());

      if (go.isFarVisible()) {
        // Removes via GetCurrentCell, added back in AddToGrid
        this.removeWorldObjectFromFarVisibleMap(go);
      }

      go.removeFromGrid();
      if (old_cell.diffGrid(new_cell)) this.ensureGridLoaded(new_cell);
      this.addToGrid(go, new_cell);
    }
    this._gameObjectsToMove = [];
  }

  /** @ac game/Maps/Map.cpp Map::MoveAllDynamicObjectsInMoveList */
  moveAllDynamicObjectsInMoveList(): void {
    for (const dynObj of this._dynamicObjectsToMove) {
      if (dynObj.findMap() !== this) continue;

      if (dynObj._moveState !== MAP_OBJECT_CELL_MOVE_ACTIVE) {
        dynObj._moveState = MAP_OBJECT_CELL_MOVE_NONE;
        continue;
      }

      dynObj._moveState = MAP_OBJECT_CELL_MOVE_NONE;
      if (!dynObj.isInWorld()) continue;

      const old_cell = dynObj.getCurrentCell();
      const new_cell = new Cell(dynObj.getPositionX(), dynObj.getPositionY());

      dynObj.removeFromGrid();
      if (old_cell.diffGrid(new_cell)) this.ensureGridLoaded(new_cell);
      this.addToGrid(dynObj, new_cell);
    }
    this._dynamicObjectsToMove = [];
  }

  /** @ac game/Maps/Map.cpp Map::UnloadGrid */
  unloadGrid(grid: MapGrid): boolean {
    this._mapGridManager.unloadGrid(grid.getX(), grid.getY());

    if (this.i_objectsToRemove.size !== 0) throw new Error("ASSERT failed: i_objectsToRemove.empty() (Map::UnloadGrid)");
    logDebug("maps", `Unloading grid[${grid.getX()}, ${grid.getY()}] for map ${this.getId()} finished`);
    return true;
  }

  /** @ac game/Maps/Map.cpp Map::RemoveAllPlayers */
  removeAllPlayers(): void {
    if (this.havePlayers()) {
      for (const player of this.m_mapRefMgr) {
        if (!player.isBeingTeleportedFar?.()) {
          // this is happening for bg
          logError("maps", `Map::UnloadAll: player ${player.getName()} is still in map ${this.getId()} during unload, this should not happen!`);
          const home = player.homebind?.();
          if (home) player.teleportTo?.(home.mapId, home.x, home.y, home.z, player.getOrientation());
        }
      }
    }
  }

  /** @ac game/Maps/Map.cpp Map::UnloadAll */
  unloadAll(): void {
    // clear all delayed moves, useless anyway do this moves before map unload.
    this._creaturesToMove = [];
    this._gameObjectsToMove = [];

    for (const grid of [...this]) {
      if (grid) this.unloadGrid(grid);
    }

    // pussywizard: crashfix, some npc can be left on transport (not a default passenger)
    if (!this.allTransportsEmpty()) this.allTransportsRemovePassengers();

    for (const transport of [...this._transports]) this.removeTransportFromMap(transport, true);

    this._transports.clear();

    for (const corpses of this._corpsesByGrid.values()) {
      for (const corpse of corpses) {
        corpse.removeFromWorld();
        corpse.resetMap();
      }
    }

    this._corpsesByGrid.clear();
    this._corpsesByPlayer.clear();
    this._corpseBones.clear();
  }

  /**
   * @ac game/Maps/Map.cpp Map::GetGridTerrainDataSharedPtr
   * `std::shared_ptr<GridTerrainData>`: the terrain data is shared by reference. The grid must exist (an instance reads its
   * parent's grid, which `MapGridManager::CreateGrid` created first).
   */
  getGridTerrainDataSharedPtr(gridCoord: { x_coord: number; y_coord: number }): GridTerrainData | null {
    const grid = this._mapGridManager.getGrid(gridCoord.x_coord, gridCoord.y_coord);
    if (!grid) throw new Error("ASSERT failed: grid (Map::GetGridTerrainDataSharedPtr) - Grid should always exist during this call");
    return grid.getTerrainDataSharedPtr();
  }

  /** @ac game/Maps/Map.cpp Map::GetGridTerrainData (the `(GridCoord const&)` and `(float x, float y)` overloads) */
  getGridTerrainData(gridCoord: GridCoord): GridTerrainData | null;
  getGridTerrainData(x: number, y: number): GridTerrainData | null;
  getGridTerrainData(a: GridCoord | number, y?: number): GridTerrainData | null {
    const gridCoord = typeof a === "number" ? ComputeGridCoord(a, y!) : a;
    if (!MapGridManager.isValidGridCoordinates(gridCoord.x_coord, gridCoord.y_coord)) return null;

    // ensure GridMap is created
    this.ensureGridCreated(gridCoord);
    return this._mapGridManager.getGrid(gridCoord.x_coord, gridCoord.y_coord)!.getTerrainData();
  }

  /** @ac game/Maps/Map.cpp Map::GetWaterOrGroundLevel (the `float* ground` out parameter is a `FloatRef`) */
  getWaterOrGroundLevel(
    phasemask: number,
    x: number,
    y: number,
    z: number,
    ground: FloatRef | null = null,
    _swim = false,
    collisionHeight: number = DEFAULT_COLLISION_HEIGHT,
  ): number {
    // we need ground level (including grid height version) for proper return water level in point
    const ground_z = this.getHeight(phasemask, x, y, z + Z_OFFSET_FIND_HEIGHT, true, 50.0);
    if (ground) ground.value = ground_z;

    const liquidData = this.getLiquidData(phasemask, x, y, ground_z, collisionHeight, null);
    switch (liquidData.Status) {
      case LIQUID_MAP_ABOVE_WATER:
        return liquidData.Level < ground_z ? ground_z : liquidData.Level;
      case LIQUID_MAP_NO_WATER:
        return ground_z;
      default:
        return liquidData.Level;
    }
  }

  /**
   * @ac game/Maps/Map.cpp Map::GetTransportForPos
   * @ac-skip Transport: no transports exist yet, so there is nothing to intersect (the C++ also tests the nearest static
   * transport gameobject through `FindNearestGameObjectOfType` and its `m_model`).
   */
  getTransportForPos(_phase: number, _x: number, _y: number, _z: number, _worldobject: WorldObject | null = null): WorldObject | null {
    return null;
  }

  /**
   * @ac game/Maps/Map.cpp Map::GetHeight (the `(x, y, z, checkVMap, maxSearchDist)` overload; the `(Position const&, ...)`
   * one is `getHeightAtPosition`)
   * Some calls like isInWater should not use vmaps due to processor power; can return INVALID_HEIGHT if under z+2 z coord
   * not found height.
   */
  getHeightNoPhase(x: number, y: number, z: number, checkVMap = true, maxSearchDist: number = DEFAULT_HEIGHT_SEARCH): number {
    // find raw .map surface under Z coordinates
    let mapHeight = VMAP_INVALID_HEIGHT_VALUE;
    const gridHeight = this.getGridHeight(x, y);
    if (fuzzyGe(z, F(gridHeight - GROUND_HEIGHT_TOLERANCE))) mapHeight = gridHeight;

    let vmapHeight = VMAP_INVALID_HEIGHT_VALUE;
    if (checkVMap) vmapHeight = this._mapCollisionData.getStaticTree().getHeight(x, y, z, maxSearchDist); // look from a bit higher pos to find the floor

    // mapHeight set for any above raw ground Z or <= INVALID_HEIGHT
    // vmapheight set for any under Z value or <= INVALID_HEIGHT
    if (vmapHeight > INVALID_HEIGHT) {
      if (mapHeight > INVALID_HEIGHT) {
        // we have mapheight and vmapheight and must select more appropriate

        // we are already under the surface or vmap height above map heigt
        // or if the distance of the vmap height is less the land height distance
        if (vmapHeight > mapHeight || Math.abs(mapHeight - z) > Math.abs(vmapHeight - z)) return vmapHeight;
        else return mapHeight; // better use .map surface height
      } else return vmapHeight; // we have only vmapHeight (if have)
    }

    return mapHeight; // explicitly use map data
  }

  /** @ac game/Maps/Map.h Map::GetHeight (the `(Position const& pos, checkVMap, maxSearchDist)` overload) */
  getHeightAtPosition(pos: PositionLike, checkVMap = true, maxSearchDist: number = DEFAULT_HEIGHT_SEARCH): number {
    return this.getHeightNoPhase(pos.getPositionX(), pos.getPositionY(), pos.getPositionZ(), checkVMap, maxSearchDist);
  }

  /** @ac game/Maps/Map.cpp Map::GetGridHeight */
  getGridHeight(x: number, y: number): number {
    const gmap = this.getGridTerrainData(x, y);
    if (gmap) return gmap.getHeight(x, y);

    return INVALID_HEIGHT;
  }

  /** @ac game/Maps/Map.cpp Map::GetMinHeight */
  getMinHeight(x: number, y: number): number {
    const grid = this.getGridTerrainData(x, y);
    if (grid) return grid.getMinHeight(x, y);

    return MIN_HEIGHT;
  }

  /**
   * @ac game/Maps/Map.cpp Map::GetAreaInfo
   * The `uint32& flags, int32& adtId, int32& rootId, int32& groupId` out parameters are the result (`null` when there is
   * no wmo or dynamic object area, or terrain covers it).
   */
  getAreaInfo(phaseMask: number, x: number, y: number, z: number): { flags: number; adtId: number; rootId: number; groupId: number } | null {
    let check_z = z;
    const vdata = scratchAreaInfoStatic.reset();
    const ddata = scratchAreaInfoDynamic.reset();
    let flags = 0;
    let adtId = 0;
    let rootId = 0;
    let groupId = 0;

    const hasVmapAreaInfo = this._mapCollisionData.getStaticTree().GetAreaAndLiquidData(x, y, z, null, vdata) && vdata.areaInfo !== null;
    const hasDynamicAreaInfo = this._mapCollisionData.getDynamicTree().GetAreaAndLiquidData(x, y, z, phaseMask, null, ddata) && ddata.areaInfo !== null;
    const useVmap = (): void => {
      check_z = vdata.floorZ;
      groupId = vdata.areaInfo!.groupId;
      adtId = vdata.areaInfo!.adtId;
      rootId = vdata.areaInfo!.rootId;
      flags = vdata.areaInfo!.mogpFlags;
    };
    const useDyn = (): void => {
      check_z = ddata.floorZ;
      groupId = ddata.areaInfo!.groupId;
      adtId = ddata.areaInfo!.adtId;
      rootId = ddata.areaInfo!.rootId;
      flags = ddata.areaInfo!.mogpFlags;
    };
    if (hasVmapAreaInfo) {
      if (hasDynamicAreaInfo && ddata.floorZ > vdata.floorZ) useDyn();
      else useVmap();
    } else if (hasDynamicAreaInfo) {
      useDyn();
    }

    if (hasVmapAreaInfo || hasDynamicAreaInfo) {
      // check if there's terrain between player height and object height
      const gmap = this.getGridTerrainData(x, y);
      if (gmap) {
        const mapHeight = gmap.getHeight(x, y);
        // z + 2.0f condition taken from GetHeight(), not sure if it's such a great choice...
        if (F(z + 2.0) > mapHeight && mapHeight > check_z) return null;
      }

      return { flags: flags >>> 0, adtId, rootId, groupId };
    }

    return null;
  }

  /** @ac game/Maps/Map.cpp Map::GetAreaId */
  getAreaId(phaseMask: number, x: number, y: number, z: number): number {
    const vmapZ = z;
    const areaInfo = this.getAreaInfo(phaseMask, x, y, vmapZ);
    const hasVmapArea = areaInfo !== null;

    let gridAreaId = 0;
    let gridMapHeight = INVALID_HEIGHT;
    const gmap = this.getGridTerrainData(x, y);
    if (gmap) {
      gridAreaId = gmap.getArea(x, y);
      gridMapHeight = gmap.getHeight(x, y);
    }

    let areaId = 0;

    // floor is the height we are closer to (but only if above)
    if (hasVmapArea && fuzzyGe(z, F(vmapZ - GROUND_HEIGHT_TOLERANCE)) && (fuzzyLt(z, F(gridMapHeight - GROUND_HEIGHT_TOLERANCE)) || vmapZ > gridMapHeight)) {
      // wmo found
      const wmoEntry = GetWMOAreaTableEntryByTripple(areaInfo!.rootId, areaInfo!.adtId, areaInfo!.groupId);
      if (wmoEntry) areaId = wmoEntry.areaId & 0xffff; // `uint16 areaId`

      if (!areaId) areaId = gridAreaId;
    } else areaId = gridAreaId;

    if (!areaId) areaId = this.i_mapEntry ? this.i_mapEntry.linked_zone : 0;

    return areaId;
  }

  /** @ac game/Maps/Map.cpp Map::GetZoneId */
  getZoneId(phaseMask: number, x: number, y: number, z: number): number {
    const areaId = this.getAreaId(phaseMask, x, y, z);
    const area = sAreaTableStore.lookupEntry(areaId);
    if (area && area.zone) return area.zone;

    return areaId;
  }

  /** @ac game/Maps/Map.cpp Map::GetZoneAndAreaId (the `uint32& zoneid, uint32& areaid` out parameters are the result) */
  getZoneAndAreaId(phaseMask: number, x: number, y: number, z: number): { zoneid: number; areaid: number } {
    const areaid = this.getAreaId(phaseMask, x, y, z);
    let zoneid = areaid;
    const area = sAreaTableStore.lookupEntry(areaid);
    if (area && area.zone) zoneid = area.zone;
    return { zoneid, areaid };
  }

  /**
   * @ac game/Maps/Map.cpp Map::GetLiquidData
   * `Optional<uint8> ReqLiquidType` is `null` for `{}`.
   */
  getLiquidData(phaseMask: number, x: number, y: number, z: number, collisionHeight: number, ReqLiquidType: number | null = null): LiquidData {
    let liquidData = new LiquidData();
    liquidData.Status = LIQUID_MAP_NO_WATER;

    const vmapData = scratchLiquidStatic.reset();
    let useGridLiquid = true;
    if (this._mapCollisionData.getStaticTree().GetAreaAndLiquidData(x, y, z, ReqLiquidType, vmapData) && vmapData.liquidInfo) {
      useGridLiquid = !vmapData.areaInfo || !IsInWMOInterior(vmapData.areaInfo.mogpFlags);
      logDebug("maps", () => `GetLiquidStatus(): vmap liquid level: ${vmapData.liquidInfo!.level} ground: ${vmapData.floorZ} type: ${vmapData.liquidInfo!.type}`);
      // Check water level and ground level
      if (vmapData.liquidInfo.level > vmapData.floorZ && fuzzyGe(z, F(vmapData.floorZ - GROUND_HEIGHT_TOLERANCE))) {
        // hardcoded in client like this
        if (this.getId() === MAP_OUTLAND && vmapData.liquidInfo.type === 2) vmapData.liquidInfo.type = 15;

        let liquidFlagType = 0;
        const liq = sLiquidTypeStore.lookupEntry(vmapData.liquidInfo.type);
        if (liq) liquidFlagType = liq.Type;

        if (vmapData.liquidInfo.type && vmapData.liquidInfo.type < 21) {
          let area = sAreaTableStore.lookupEntry(this.getAreaId(phaseMask, x, y, z));
          if (area) {
            let overrideLiquid = area.LiquidTypeOverride[liquidFlagType] ?? 0;
            if (!overrideLiquid && area.zone) {
              area = sAreaTableStore.lookupEntry(area.zone);
              if (area) overrideLiquid = area.LiquidTypeOverride[liquidFlagType] ?? 0;
            }

            const overrideEntry = sLiquidTypeStore.lookupEntry(overrideLiquid);
            if (overrideEntry) {
              vmapData.liquidInfo.type = overrideLiquid;
              liquidFlagType = overrideEntry.Type;
            }
          }
        }

        liquidData.Level = vmapData.liquidInfo.level;
        liquidData.DepthLevel = vmapData.floorZ;
        liquidData.Entry = vmapData.liquidInfo.type;
        liquidData.Flags = (1 << liquidFlagType) >>> 0;
      }

      const delta = F(vmapData.liquidInfo.level - z);

      // Get position delta
      if (delta > collisionHeight) liquidData.Status = LIQUID_MAP_UNDER_WATER;
      else if (delta > 0.0) liquidData.Status = LIQUID_MAP_IN_WATER;
      else if (delta > F(-0.1)) liquidData.Status = LIQUID_MAP_WATER_WALK;
      else liquidData.Status = LIQUID_MAP_ABOVE_WATER;
    }

    if (useGridLiquid) {
      const gmap = this.getGridTerrainData(x, y);
      if (gmap) {
        const map_data = gmap.getLiquidData(x, y, z, collisionHeight, ReqLiquidType ?? undefined);
        // Not override LIQUID_MAP_ABOVE_WATER with LIQUID_MAP_NO_WATER:
        if (map_data.Status !== LIQUID_MAP_NO_WATER && map_data.Level > vmapData.floorZ) {
          // hardcoded in client like this
          let liquidEntry = map_data.Entry;
          if (this.getId() === MAP_OUTLAND && liquidEntry === 2) liquidEntry = 15;

          liquidData = map_data;
          liquidData.Entry = liquidEntry;
        }
      }
    }

    return liquidData;
  }

  /**
   * @ac game/Maps/Map.cpp Map::GetFullTerrainStatusForPosition
   * The `PositionFullTerrainStatus& data` out parameter is the result; `Optional<uint8> reqLiquidType` is `null` for `{}`.
   */
  getFullTerrainStatusForPosition(
    phaseMask: number,
    x: number,
    y: number,
    z: number,
    collisionHeight: number,
    reqLiquidType: number | null = null,
  ): PositionFullTerrainStatus {
    const data = new PositionFullTerrainStatus();
    const gmap = this.getGridTerrainData(x, y);

    const vmapData = scratchFullStatic.reset();
    const dynData = scratchFullDynamic.reset();
    let wmoData: AreaAndLiquidData | null = null;
    this._mapCollisionData.getStaticTree().GetAreaAndLiquidData(x, y, z, reqLiquidType, vmapData);
    this._mapCollisionData.getDynamicTree().GetAreaAndLiquidData(x, y, z, phaseMask, reqLiquidType, dynData);

    let gridAreaId = 0;
    let gridMapHeight = INVALID_HEIGHT;
    if (gmap) {
      gridAreaId = gmap.getArea(x, y);
      gridMapHeight = gmap.getHeight(x, y);
    }

    let useGridLiquid = true;

    // floor is the height we are closer to (but only if above)
    data.floorZ = VMAP_INVALID_HEIGHT;
    if (gridMapHeight > INVALID_HEIGHT && fuzzyGe(z, F(gridMapHeight - GROUND_HEIGHT_TOLERANCE))) data.floorZ = gridMapHeight;

    if (
      vmapData.floorZ > VMAP_INVALID_HEIGHT &&
      fuzzyGe(z, F(vmapData.floorZ - GROUND_HEIGHT_TOLERANCE)) &&
      (fuzzyLt(z, F(gridMapHeight - GROUND_HEIGHT_TOLERANCE)) || vmapData.floorZ > gridMapHeight)
    ) {
      data.floorZ = vmapData.floorZ;
      wmoData = vmapData;
    }

    // NOTE: Objects will not detect a case when a wmo providing area/liquid despawns from under them
    // but this is fine as these kind of objects are not meant to be spawned and despawned a lot
    // example: Lich King platform
    if (
      dynData.floorZ > VMAP_INVALID_HEIGHT &&
      fuzzyGe(z, F(dynData.floorZ - GROUND_HEIGHT_TOLERANCE)) &&
      (fuzzyLt(z, F(gridMapHeight - GROUND_HEIGHT_TOLERANCE)) || dynData.floorZ > gridMapHeight) &&
      (fuzzyLt(z, F(vmapData.floorZ - GROUND_HEIGHT_TOLERANCE)) || dynData.floorZ > vmapData.floorZ)
    ) {
      data.floorZ = dynData.floorZ;
      wmoData = dynData;
    }

    if (wmoData) {
      if (wmoData.areaInfo) {
        // wmo found
        const wmoEntry = GetWMOAreaTableEntryByTripple(wmoData.areaInfo.rootId, wmoData.areaInfo.adtId, wmoData.areaInfo.groupId);
        data.outdoors = (wmoData.areaInfo.mogpFlags & 0x8) !== 0;
        if (wmoEntry) {
          data.areaId = wmoEntry.areaId;
          if (wmoEntry.Flags & 4) data.outdoors = true;
          else if (wmoEntry.Flags & 2) data.outdoors = false;
        }

        if (!data.areaId) data.areaId = gridAreaId;

        useGridLiquid = !IsInWMOInterior(wmoData.areaInfo.mogpFlags);
      }
    } else {
      data.outdoors = true;
      data.areaId = gridAreaId;
      const areaEntry = sAreaTableStore.lookupEntry(data.areaId);
      if (areaEntry) data.outdoors = (areaEntry.flags & (AREA_FLAG_INSIDE | AREA_FLAG_OUTSIDE)) !== AREA_FLAG_INSIDE;
    }

    if (!data.areaId) data.areaId = this.i_mapEntry ? this.i_mapEntry.linked_zone : 0;

    const areaEntry = sAreaTableStore.lookupEntry(data.areaId);

    // liquid processing
    if (wmoData && wmoData.liquidInfo && wmoData.liquidInfo.level > wmoData.floorZ) {
      let liquidType = wmoData.liquidInfo.type;
      if (this.getId() === MAP_OUTLAND && liquidType === 2)
        // gotta love blizzard hacks
        liquidType = 15;

      let liquidFlagType = 0;
      const liquidEntry = sLiquidTypeStore.lookupEntry(liquidType);
      if (liquidEntry) liquidFlagType = liquidEntry.Type;

      if (liquidType && liquidType < 21 && areaEntry) {
        let overrideLiquid = areaEntry.LiquidTypeOverride[liquidFlagType] ?? 0;
        if (!overrideLiquid && areaEntry.zone) {
          const zoneEntry = sAreaTableStore.lookupEntry(areaEntry.zone);
          if (zoneEntry) overrideLiquid = zoneEntry.LiquidTypeOverride[liquidFlagType] ?? 0;
        }

        const overrideData = sLiquidTypeStore.lookupEntry(overrideLiquid);
        if (overrideData) {
          liquidType = overrideLiquid;
          liquidFlagType = overrideData.Type;
        }
      }

      data.liquidInfo.Level = wmoData.liquidInfo.level;
      data.liquidInfo.DepthLevel = wmoData.floorZ;
      data.liquidInfo.Entry = liquidType;
      data.liquidInfo.Flags = (1 << liquidFlagType) >>> 0;

      // Get position delta
      const delta = F(wmoData.liquidInfo.level - z);

      if (delta > collisionHeight) data.liquidInfo.Status = LIQUID_MAP_UNDER_WATER;
      else if (delta > 0.0) data.liquidInfo.Status = LIQUID_MAP_IN_WATER;
      else if (delta > F(-0.1)) data.liquidInfo.Status = LIQUID_MAP_WATER_WALK;
      else data.liquidInfo.Status = LIQUID_MAP_ABOVE_WATER;
    }

    // look up liquid data from grid map
    if (gmap && useGridLiquid) {
      const gridLiquidData = gmap.getLiquidData(x, y, z, collisionHeight, reqLiquidType ?? undefined);
      if (gridLiquidData.Status !== LIQUID_MAP_NO_WATER && (!wmoData || gridLiquidData.Level > wmoData.floorZ)) {
        let liquidEntry = gridLiquidData.Entry;
        if (this.getId() === MAP_OUTLAND && liquidEntry === 2) liquidEntry = 15;

        data.liquidInfo = gridLiquidData;
        data.liquidInfo.Entry = liquidEntry;
      }
    }

    return data;
  }

  /** @ac game/Maps/Map.cpp Map::GetWaterLevel */
  getWaterLevel(x: number, y: number): number {
    const gmap = this.getGridTerrainData(x, y);
    if (gmap) return gmap.getLiquidLevel(x, y);

    return INVALID_HEIGHT;
  }

  /** @ac game/Maps/Map.cpp Map::isInLineOfSight (`LineOfSightChecks checks`, `VMAP::ModelIgnoreFlags ignoreFlags`) */
  isInLineOfSight(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, phasemask: number, checks: number, ignoreFlags: number): boolean {
    if (!sWorld().getBoolConfig(ServerConfig.CONFIG_VMAP_BLIZZLIKE_PVP_LOS)) {
      if (this.isBattlegroundOrArena()) ignoreFlags = ModelIgnoreFlags.Nothing;
    }

    if (!sWorld().getBoolConfig(ServerConfig.CONFIG_VMAP_BLIZZLIKE_LOS_OPEN_WORLD)) {
      if (this.isWorldMap()) ignoreFlags = ModelIgnoreFlags.Nothing;
    }

    if (checks & LINEOFSIGHT_CHECK_VMAP && !this._mapCollisionData.getStaticTree().isInLineOfSight(x1, y1, z1, x2, y2, z2, ignoreFlags)) return false;

    if (sWorld().getBoolConfig(ServerConfig.CONFIG_CHECK_GOBJECT_LOS) && checks & LINEOFSIGHT_CHECK_GOBJECT_ALL) {
      ignoreFlags = ModelIgnoreFlags.Nothing;
      if (!(checks & LINEOFSIGHT_CHECK_GOBJECT_M2)) ignoreFlags = ModelIgnoreFlags.M2;

      if (!this._mapCollisionData.getDynamicTree().isInLineOfSight(x1, y1, z1, x2, y2, z2, phasemask, ignoreFlags)) return false;
    }

    return true;
  }

  /** @ac game/Maps/Map.cpp Map::GetHeight (the `(phasemask, x, y, z, vmap, maxSearchDist)` overload) */
  getHeight(phasemask: number, x: number, y: number, z: number, vmap = true, maxSearchDist: number = DEFAULT_HEIGHT_SEARCH): number {
    const h1 = this.getHeightNoPhase(x, y, z, vmap, maxSearchDist);
    const h2 = this._mapCollisionData.getDynamicTree().getHeight(x, y, z, maxSearchDist, phasemask);
    return h1 < h2 ? h2 : h1; // std::max<float>
  }

  /** @ac game/Maps/Map.cpp Map::IsInWater */
  isInWater(phaseMask: number, x: number, y: number, pZ: number, collisionHeight: number): boolean {
    const liquidData = this.getLiquidData(phaseMask, x, y, pZ, collisionHeight, null);
    return (liquidData.Status & MAP_LIQUID_STATUS_SWIMMING) !== 0;
  }

  /** @ac game/Maps/Map.cpp Map::IsUnderWater */
  isUnderWater(phaseMask: number, x: number, y: number, z: number, collisionHeight: number): boolean {
    const liquidData = this.getLiquidData(phaseMask, x, y, z, collisionHeight, MAP_LIQUID_TYPE_WATER | MAP_LIQUID_TYPE_OCEAN);
    return liquidData.Status === LIQUID_MAP_UNDER_WATER;
  }

  /**
   * @ac game/Maps/Map.cpp Map::HasEnoughWater (the `(WorldObject const* searcher, float x, float y, float z)` overload)
   * @ac game/Maps/Map.h Map::HasEnoughWater (the `(searcher, LiquidData const&)` overload is declared in the header, with no
   * definition in this revision's `Map.cpp`; it shares the tail of the coordinate overload)
   */
  hasEnoughWater(searcher: WorldObject, x: number, y: number, z: number): boolean;
  hasEnoughWater(searcher: WorldObject, liquidData: LiquidData): boolean;
  hasEnoughWater(searcher: WorldObject, a: number | LiquidData, y?: number, z?: number): boolean {
    const liquidData = typeof a === "number" ? this.getLiquidData(searcher.getPhaseMask(), a, y!, z!, searcher.getCollisionHeight(), MAP_ALL_LIQUIDS) : a;

    if ((liquidData.Status & MAP_LIQUID_STATUS_SWIMMING) === 0) return false;

    const minHeightInWater = searcher.getMinHeightInWater();
    return liquidData.Level > INVALID_HEIGHT && liquidData.Level > liquidData.DepthLevel && liquidData.Level - liquidData.DepthLevel >= minHeightInWater;
  }

  /** @ac game/Maps/Map.cpp Map::GetMapName */
  getMapName(): string {
    return this.i_mapEntry ? (this.i_mapEntry.name[MapHooks.getDefaultDbcLocale()] ?? "") : "UNNAMEDMAP";
  }

  /** @ac game/Maps/Map.cpp Map::SendInitSelf */
  sendInitSelf(player: MapPlayer): void {
    logDebug("maps", () => `Creating player data for himself ${ObjectGuid.ToString(player.getGUID())}`);

    let data = new UpdateData();

    // attach to player data current transport data
    const transport = player.getTransport?.() ?? null;
    if (transport) transport.buildCreateUpdateBlockForPlayer(data, player);

    // build data for self presence in world at own client (one time for map)
    player.buildCreateUpdateBlockForPlayer(data, player);

    // build and send self update packet before sending to player his own auras
    player.sendDirectMessage(data.buildPacket());

    // send to player his own auras (this is needed here for timely initialization of some fields on client)
    player.getAurasForTarget?.(player, true);

    // clean buffers for further work
    data = new UpdateData();

    // build other passengers at transport also (they always visible and marked as visible and will not send at visibility update at add to map
    // @ac-skip Transport::GetPassengers: transports are not ported, so a transport has no passengers to build here.

    player.sendDirectMessage(data.buildPacket());
  }

  /** @ac game/Maps/Map.cpp Map::UpdateExpiredCorpses */
  updateExpiredCorpses(diff: number): void {
    this._corpseUpdateTimer.update(diff);
    if (!this._corpseUpdateTimer.passed()) return;

    this.removeOldCorpses();

    this._corpseUpdateTimer.reset();
  }

  /** @ac game/Maps/Map.cpp Map::SendInitTransports */
  sendInitTransports(player: MapPlayer): void {
    if (this._transports.size === 0) return;

    // Hack to send out transports
    const transData = new UpdateData();
    for (const transport of this._transports) if (transport !== (player.getTransport?.() ?? null)) transport.buildCreateUpdateBlockForPlayer(transData, player);
    // @ac-skip `sToCloud9Sidecar->ClusterModeEnabled()` (the phase check of cluster mode)

    if (!transData.hasData()) return;

    player.sendDirectMessage(transData.buildPacket());
  }

  /** @ac game/Maps/Map.cpp Map::SendRemoveTransports */
  sendRemoveTransports(player: MapPlayer): void {
    if (this._transports.size === 0) return;

    // Hack to send out transports
    const transData = new UpdateData();
    for (const transport of this._transports) if (transport !== (player.getTransport?.() ?? null)) transport.buildOutOfRangeUpdateBlock(transData);

    if (!transData.hasData()) return;

    player.sendDirectMessage(transData.buildPacket());
  }

  /**
   * @ac game/Maps/Map.cpp Map::SendObjectUpdates
   * @ac-skip Updates: `Object::BuildUpdate` (the values update blocks) is not ported; an object that provides `buildUpdate`
   * fills the per player blocks, otherwise it is only dequeued.
   */
  private sendObjectUpdates(): void {
    const update_players: UpdateDataMapType = new StdMap();

    while (this._updateObjects.size > 0) {
      const obj = this._updateObjects.values().next().value as AcObject;
      if (!obj.isInWorld()) throw new Error("ASSERT failed: obj->IsInWorld() (Map::SendObjectUpdates)");

      this._updateObjects.delete(obj);
      (obj as unknown as { buildUpdate?(map: UpdateDataMapType): void }).buildUpdate?.(update_players);
    }

    for (const [player, data] of update_players) {
      if (!MapScriptHooks.canSendObjectUpdatesToPlayer(this, player)) {
        data.clear();
        continue;
      }

      player.sendDirectMessage(data.buildPacket());
    }
  }

  /** @ac game/Maps/Map.cpp Map::ApplyDynamicModeRespawnScaling */
  applyDynamicModeRespawnScaling(obj: WorldObject, respawnDelay: number): number {
    if (obj.getMap() !== this) throw new Error("ASSERT failed: obj->GetMap() == this (Map::ApplyDynamicModeRespawnScaling)");

    const rate = sWorld().getFloatConfig(obj.isGameObject() ? ServerConfig.CONFIG_RESPAWN_DYNAMICRATE_GAMEOBJECT : ServerConfig.CONFIG_RESPAWN_DYNAMICRATE_CREATURE);

    if (rate === 1.0) return respawnDelay;

    // No instanced maps (dungeons, battlegrounds, arenas etc.)
    if (this.instanceable()) return respawnDelay;

    const creature = obj.toCreature() as MapObjectLike | null;
    if (creature) {
      // Temporary spawns (no DB spawn id, e.g. summons / battlefield-spawned
      // creatures such as Wintergrasp turrets) are not part of the respawn system.
      if (!creature.getSpawnId?.()) return respawnDelay;

      // No quest givers or world bosses
      const rank = creature.getCreatureTemplate?.()?.rank;
      if (creature.isQuestGiver?.() || creature.isWorldBoss?.() || rank === CREATURE_ELITE_RARE || rank === CREATURE_ELITE_RAREELITE) return respawnDelay;
    }
    // Temporary gameobjects (no DB spawn id) are likewise excluded.
    else {
      const go = obj.toGameObject() as MapObjectLike | null;
      if (go && !go.getSpawnId?.()) return respawnDelay;
    }

    const playerCount = this._zonePlayerCountMap.get(obj.getZoneId());
    if (playerCount === undefined) return respawnDelay;
    if (!playerCount) return respawnDelay;
    const adjustFactor = rate / playerCount;
    if (adjustFactor >= 1.0)
      // nothing to do here
      return respawnDelay;
    const timeMinimum = sWorld().getIntConfig(
      obj.isGameObject() ? ServerConfig.CONFIG_RESPAWN_DYNAMICMINIMUM_GAMEOBJECT : ServerConfig.CONFIG_RESPAWN_DYNAMICMINIMUM_CREATURE,
    );
    if (respawnDelay <= timeMinimum) return respawnDelay;

    return Math.max(Math.ceil(respawnDelay * adjustFactor), timeMinimum) >>> 0;
  }

  /** @ac game/Maps/Map.cpp Map::DelayedUpdate */
  delayedUpdate(t_diff: number): void {
    this._transportsUpdating = true;
    for (const transport of [...this._transports]) {
      if (!this._transports.has(transport)) continue; // removed by an earlier transport's update (the C++ iterator was advanced past it)
      if (!transport.isInWorld()) continue;

      (transport as unknown as { delayedUpdate?(diff: number): void }).delayedUpdate?.(t_diff);
    }
    this._transportsUpdating = false;

    this.removeAllObjectsInRemoveList();
  }

  /** @ac game/Maps/Map.cpp Map::AddObjectToRemoveList */
  addObjectToRemoveList(obj: WorldObject): void {
    if (!(obj.getMapId() === this.getId() && obj.getInstanceId() === this.getInstanceId())) throw new Error("ASSERT failed: obj->GetMapId() == GetId() && obj->GetInstanceId() == GetInstanceId()");

    obj.cleanupsBeforeDelete(false); // remove or simplify at least cross referenced links

    this.i_objectsToRemove.add(obj);
    // LOG_DEBUG("maps", "Object ({}) added to removing list.", obj->GetGUID().ToString());
  }

  /** @ac game/Maps/Map.cpp Map::RemoveAllObjectsInRemoveList */
  removeAllObjectsInRemoveList(): void {
    while (this.i_objectsToRemove.size > 0) {
      const obj = this.i_objectsToRemove.values().next().value as WorldObject;
      this.i_objectsToRemove.delete(obj);

      switch (obj.getTypeId()) {
        case TYPEID_CORPSE: {
          const corpse = this.getCorpse(obj.getGUID());
          if (!corpse) logError("maps", `Tried to delete corpse/bones ${ObjectGuid.ToString(obj.getGUID())} that is not in map.`);
          else this.removeFromMap(corpse, true);
          break;
        }
        case TYPEID_DYNAMICOBJECT:
          this.removeFromMap(obj, true);
          break;
        case TYPEID_GAMEOBJECT: {
          const go = obj.toGameObject() as MapObjectLike;
          if (go.isTransport?.()) this.removeTransportFromMap(obj, true);
          else this.removeFromMap(obj, true);
          break;
        }
        case TYPEID_UNIT:
          // in case triggered sequence some spell can continue casting after prev CleanupsBeforeDelete call
          // make sure that like sources auras/etc removed before destructor start
          obj.cleanupsBeforeDelete();
          this.removeFromMap(obj, true);
          break;
        default:
          logError("maps", `Non-grid object (TypeId: ${obj.getTypeId()}) is in grid object remove list, ignored.`);
          break;
      }
    }
  }

  /** @ac game/Maps/Map.cpp Map::GetPlayersCountExceptGMs (when aliveOnly is true, counts only players that are alive and not in Spirit of Redemption form) */
  getPlayersCountExceptGMs(aliveOnly = false): number {
    let count = 0;
    for (const player of this.m_mapRefMgr) if (player && !player.isGameMaster() && (!aliveOnly || (player.isAlive() && !player.hasSpiritOfRedemptionAura?.()))) ++count;
    return count;
  }

  /** @ac game/Maps/Map.cpp Map::StartPlayersRedirectKickTimer */
  startPlayersRedirectKickTimer(): void {
    for (const player of this.m_mapRefMgr)
      player.sendSystemMessage?.('Preparing to enter parallel dimension... One minute!\nAccelerate transfer: Teleport or type "/ready" in chat.');

    this._redirectKickTimer.reset(60 * 1000);
    this._lastAnnounceRedirectKickTimer.reset(55 * 1000);

    this._lastAnnounceRedirectKickTimer.update(1);
  }

  /** @ac game/Maps/Map.cpp Map::StopPlayersRedirectKickTimer */
  stopPlayersRedirectKickTimer(): void {
    this._redirectKickTimer.reset(0);
    this._lastAnnounceRedirectKickTimer.reset(0);
  }

  /** @ac game/Maps/Map.h Map::IsPlayerRedirectKickTimerActive */
  isPlayerRedirectKickTimerActive(): boolean {
    return !this._redirectKickTimer.passed();
  }

  /**
   * @ac game/Maps/Map.cpp Map::UpdatePlayersRedirectKickEvent
   * @ac-skip ToCloud9 sidecar: `WorldSession::HandleTC9PrepareForRedirect` (cluster mode) is not ported, so the redirect
   * itself is not sent when the timer passes.
   */
  private updatePlayersRedirectKickEvent(diff: number): void {
    if (this._redirectKickTimer.passed()) return;

    this._redirectKickTimer.update(diff);

    if (this._redirectKickTimer.passed()) return;

    if (this._lastAnnounceRedirectKickTimer.passed()) return;

    this._lastAnnounceRedirectKickTimer.update(diff);

    if (this._lastAnnounceRedirectKickTimer.passed()) for (const player of this.m_mapRefMgr) player.sendSystemMessage?.("Dimensional shift incoming! Prepare to transition in 5 seconds...");
  }

  /** @ac game/Maps/Map.cpp Map::SendToPlayers */
  sendToPlayers(data: WorldPacket): void {
    for (const player of this.m_mapRefMgr) player.sendDirectMessage(data);
  }

  /** @ac game/Maps/Map.h Map::GetDifficulty (have meaning only for instanced map (that have set real difficulty)) */
  getDifficulty(): number {
    return this.getSpawnMode();
  }

  /** @ac game/Maps/Map.h Map::IsRegularDifficulty */
  isRegularDifficulty(): boolean {
    return this.getDifficulty() === REGULAR_DIFFICULTY;
  }

  /** @ac game/Maps/Map.cpp Map::GetMapDifficulty */
  getMapDifficulty(): MapDifficulty | null {
    return GetMapDifficultyData(this.getId(), this.getDifficulty());
  }

  /** @ac game/Maps/Map.h Map::Instanceable */
  instanceable(): boolean {
    return !!this.i_mapEntry && MapEntryInstanceable(this.i_mapEntry);
  }

  /** @ac game/Maps/Map.h Map::IsDungeon */
  isDungeon(): boolean {
    return !!this.i_mapEntry && MapEntryIsDungeon(this.i_mapEntry);
  }

  /** @ac game/Maps/Map.h Map::IsNonRaidDungeon */
  isNonRaidDungeon(): boolean {
    return !!this.i_mapEntry && MapEntryIsNonRaidDungeon(this.i_mapEntry);
  }

  /** @ac game/Maps/Map.h Map::IsRaid */
  isRaid(): boolean {
    return !!this.i_mapEntry && MapEntryIsRaid(this.i_mapEntry);
  }

  /** @ac game/Maps/Map.h Map::IsRaidOrHeroicDungeon */
  isRaidOrHeroicDungeon(): boolean {
    return this.isRaid() || this.i_spawnMode > DUNGEON_DIFFICULTY_NORMAL;
  }

  /** @ac game/Maps/Map.h Map::IsHeroic */
  isHeroic(): boolean {
    return this.isRaid() ? this.i_spawnMode >= RAID_DIFFICULTY_10MAN_HEROIC : this.i_spawnMode >= DUNGEON_DIFFICULTY_HEROIC;
  }

  /** @ac game/Maps/Map.h Map::Is25ManRaid (since 25man difficulties are 1 and 3, we can check them like that) */
  is25ManRaid(): boolean {
    return this.isRaid() && (this.i_spawnMode & RAID_DIFFICULTY_MASK_25MAN) !== 0;
  }

  /** @ac game/Maps/Map.h Map::IsBattleground */
  isBattleground(): boolean {
    return !!this.i_mapEntry && MapEntryIsBattleground(this.i_mapEntry);
  }

  /** @ac game/Maps/Map.h Map::IsBattleArena */
  isBattleArena(): boolean {
    return !!this.i_mapEntry && MapEntryIsBattleArena(this.i_mapEntry);
  }

  /** @ac game/Maps/Map.h Map::IsBattlegroundOrArena */
  isBattlegroundOrArena(): boolean {
    return !!this.i_mapEntry && MapEntryIsBattlegroundOrArena(this.i_mapEntry);
  }

  /** @ac game/Maps/Map.h Map::IsWorldMap */
  isWorldMap(): boolean {
    return !!this.i_mapEntry && MapEntryIsWorldMap(this.i_mapEntry);
  }

  /** @ac game/Maps/Map.h Map::GetEntrancePos (the `int32& mapid, float& x, float& y` out parameters are the result) */
  getEntrancePos(): { mapid: number; x: number; y: number } | null {
    if (!this.i_mapEntry) return null;
    return MapEntryGetEntrancePos(this.i_mapEntry);
  }

  /** @ac game/Maps/Map.h Map::CannotEnter (the base map lets everyone in; `InstanceMap` and `BattlegroundMap` override it) */
  cannotEnter(_player: MapPlayer, _loginCheck = false): EnterState {
    return CAN_ENTER;
  }

  /** @ac game/Maps/Map.h Map::resetMarkedCells */
  resetMarkedCells(): void {
    this.marked_cells.fill(0);
  }

  /** @ac game/Maps/Map.h Map::isCellMarked */
  isCellMarked(pCellId: number): boolean {
    return (this.marked_cells[pCellId >> 3]! & (1 << (pCellId & 7))) !== 0;
  }

  /** @ac game/Maps/Map.h Map::markCell */
  markCell(pCellId: number): void {
    this.marked_cells[pCellId >> 3]! |= 1 << (pCellId & 7);
  }

  /** @ac game/Maps/Map.h Map::HavePlayers */
  havePlayers(): boolean {
    return !this.m_mapRefMgr.isEmpty();
  }

  /** @ac game/Maps/Map.h Map::GetPlayers (`PlayerList`) */
  getPlayers(): MapRefMgr<MapPlayer> {
    return this.m_mapRefMgr;
  }

  /**
   * @ac game/Scripting/MapScripts.cpp Map::ScriptsStart
   * @ac-skip ScriptMgr: map scripts (`ScriptInfo`, the `*_scripts` tables) are not ported.
   */
  scriptsStart(_scripts: unknown, _id: number, _source: AcObject | null, _target: AcObject | null): void {}

  /**
   * @ac game/Scripting/MapScripts.cpp Map::ScriptCommandStart
   * @ac-skip ScriptMgr: map scripts are not ported.
   */
  scriptCommandStart(_script: unknown, _delay: number, _source: AcObject | null, _target: AcObject | null): void {}

  /**
   * @ac game/Scripting/MapScripts.cpp Map::ScriptsProcess
   * @ac-skip ScriptMgr: map scripts are not ported (`m_scriptSchedule` stays empty), and with them the private helpers
   * of `Scripting/MapScripts.cpp`: `_GetScriptPlayerSourceOrTarget`, `_GetScriptCreatureSourceOrTarget`, `_GetScriptUnit`,
   * `_GetScriptPlayer`, `_GetScriptCreature`, `_GetScriptWorldObject`, `_ScriptProcessDoor`, and `_FindGameObject`.
   */
  private scriptsProcess(): void {}

  /**
   * @ac game/Maps/Map.h Map::UpdateIteratorBack
   * The player walk (`MapRefMgr`) survives a player being unlinked during it, so there is no `m_mapRefIter` to step back.
   */
  updateIteratorBack(_player: MapPlayer): void {}

  /**
   * @ac game/Entities/Object/Object.cpp Map::SummonCreature
   * @ac-skip TempSummon: temporary summons are not ported.
   */
  summonCreature(_entry: number, _pos: PositionLike, _properties: unknown = null, _duration = 0, _summoner: WorldObject | null = null, _spellId = 0, _vehId = 0, _visibleBySummonerOnly = false): WorldObject | null {
    return null;
  }

  /**
   * @ac game/Entities/Object/Object.cpp Map::SummonGameObject (the `(entry, x, y, z, ang, rotation0..3, respawnTime, checkTransport)` and `(entry, pos, rotation0..3, respawnTime, checkTransport)` overloads)
   * @ac-skip temporary gameobject summons are not ported.
   */
  summonGameObject(_entry: number, _x: number | PositionLike, ..._rest: number[]): GameObject | null {
    return null;
  }

  /**
   * @ac game/Entities/Object/Object.cpp Map::SummonCreatureGroup
   * @ac-skip TempSummon: temporary summons (`creature_summon_groups`) are not ported.
   */
  summonCreatureGroup(_group: number, _list: WorldObject[] | null = null): void {}

  /**
   * @ac game/Entities/Object/Object.cpp Map::SummonGameObjectGroup
   * @ac-skip temporary gameobject summons (`creature_summon_groups`) are not ported.
   */
  summonGameObjectGroup(_group: number, _list: GameObject[] | null = null): void {}

  /** @ac game/Maps/Map.cpp Map::GetCorpse */
  getCorpse(guid: bigint): Corpse | null {
    return this._objectsStore.find("Corpse", guid);
  }

  /** @ac game/Maps/Map.cpp Map::GetCreature */
  getCreature(guid: bigint): Creature | null {
    return this._objectsStore.find("Creature", guid);
  }

  /** @ac game/Maps/Map.cpp Map::GetGameObject */
  getGameObject(guid: bigint): GameObject | null {
    return this._objectsStore.find("GameObject", guid);
  }

  /** @ac game/Maps/Map.cpp Map::GetPet (a pet is a creature object that is a `Pet`; pets are not ported, so this is the creature when `isPet` says so) */
  getPet(guid: bigint): Creature | null {
    const creature = this._objectsStore.find("Creature", guid);
    return creature && ObjectGuid.GetHigh(guid) === HighGuid.Pet ? creature : null;
  }

  /** @ac game/Maps/Map.cpp Map::GetTransport */
  getTransport(guid: bigint): GameObject | null {
    if (ObjectGuid.GetHigh(guid) !== HighGuid.Mo_Transport && ObjectGuid.GetHigh(guid) !== HighGuid.Transport) return null;

    const go = this.getGameObject(guid);
    return go && (go as MapObjectLike).isTransport?.() ? go : null;
  }

  /** @ac game/Maps/Map.cpp Map::GetDynamicObject */
  getDynamicObject(guid: bigint): DynamicObject | null {
    return this._objectsStore.find("DynamicObject", guid);
  }

  /** @ac game/Maps/Map.h Map::GetObjectsStore */
  getObjectsStore(): MapStoredObjectTypesContainer {
    return this._objectsStore;
  }

  /** @ac game/Maps/Map.h Map::GetCreatureBySpawnIdStore (the real multimap: `CommandCreature`s are looked up from it) */
  getCreatureBySpawnIdStore(): CreatureBySpawnIdContainer & StdMap<number, Creature[]> {
    return this._creatureBySpawnIdStore;
  }

  /** @ac game/Maps/Map.h Map::GetGameObjectBySpawnIdStore */
  getGameObjectBySpawnIdStore(): GameObjectBySpawnIdContainer {
    return this._gameobjectBySpawnIdStore;
  }

  /** @ac game/Maps/Map.h Map::GetCorpsesInGrid */
  getCorpsesInGrid(gridId: number): ReadonlySet<Corpse> | null {
    return this._corpsesByGrid.get(gridId) ?? null;
  }

  /** @ac game/Maps/Map.h Map::GetCorpseByPlayer */
  getCorpseByPlayer(ownerGuid: bigint): Corpse | null {
    return this._corpsesByPlayer.get(ownerGuid) ?? null;
  }

  /** @ac game/Maps/Map.h Map::GetPoolData */
  getPoolData(): SpawnedPoolDataLike {
    return this._poolData;
  }

  /** @ac game/Maps/Map.h Map::ToMapInstanced (the `MapInstanced` of an instanceable map; the class is in `MapInstanced.ts`) */
  toMapInstanced(): MapInstancedLike | null {
    return this.instanceable() && typeof (this as unknown as Partial<MapInstancedLike>).getInstancedMaps === "function" ? (this as unknown as MapInstancedLike) : null;
  }

  /** @ac game/Maps/Map.h Map::ToInstanceMap */
  toInstanceMap(): InstanceMap | null {
    return this.isDungeon() && this instanceof InstanceMap ? this : null;
  }

  /** @ac game/Maps/Map.h Map::ToBattlegroundMap */
  toBattlegroundMap(): BattlegroundMap | null {
    return this.isBattlegroundOrArena() && this instanceof BattlegroundMap ? this : null;
  }

  /**
   * @ac game/Maps/Map.cpp Map::CanReachPositionAndGetValidCoords
   * Check if a given source can reach a specific point following a path and normalize the coords. Use this method for long
   * paths, otherwise use the overloaded method with the start coords when you need to do a quick check on small segments.
   * The `float& destX, destY, destZ` out parameters are `dest` (written in place).
   *
   * Overloads: `(source, path, dest, failOnCollision, failOnSlopes)`, `(source, dest, failOnCollision, failOnSlopes)`, and
   * `(source, startX, startY, startZ, dest, failOnCollision, failOnSlopes)`.
   */
  canReachPositionAndGetValidCoords(source: WorldObject, path: PathGenerator, dest: Vec3, failOnCollision?: boolean, failOnSlopes?: boolean): boolean;
  canReachPositionAndGetValidCoords(source: WorldObject, dest: Vec3, failOnCollision?: boolean, failOnSlopes?: boolean): boolean;
  canReachPositionAndGetValidCoords(source: WorldObject, startX: number, startY: number, startZ: number, dest: Vec3, failOnCollision?: boolean, failOnSlopes?: boolean): boolean;
  canReachPositionAndGetValidCoords(source: WorldObject, a: PathGenerator | Vec3 | number, b?: Vec3 | number | boolean, c?: number | boolean, d?: number | Vec3 | boolean, e?: Vec3 | boolean, f?: boolean, g?: boolean): boolean {
    if (a instanceof PathGenerator) {
      const dest = b as Vec3;
      const failOnCollision = (c as boolean | undefined) ?? true;
      const failOnSlopes = (d as boolean | undefined) ?? true;
      const path = a;
      let prevPath = path.getStartPosition();
      for (const vector of path.getPath()) {
        const next: Vec3 = { x: vector.x, y: vector.y, z: vector.z };

        if (!this.canReachPositionAndGetValidCoords(source, prevPath.x, prevPath.y, prevPath.z, next, failOnCollision, failOnSlopes)) {
          dest.x = next.x;
          dest.y = next.y;
          dest.z = next.z;
          return false;
        }

        prevPath = vector;
      }

      dest.x = prevPath.x;
      dest.y = prevPath.y;
      dest.z = prevPath.z;

      return true;
    }

    if (typeof a !== "number") {
      /**
       * @brief validate the new destination and set reachable coords
       * Check if a given unit can reach a specific point on a segment and set the correct dest coords
       * NOTE: use this method with small segments.
       */
      return this.canReachPositionAndGetValidCoords(
        source,
        source.getPositionX(),
        source.getPositionY(),
        source.getPositionZ(),
        a,
        (b as boolean | undefined) ?? true,
        (c as boolean | undefined) ?? true,
      );
    }

    const startX = a;
    const startY = b as number;
    const startZ = c as number;
    const dest = d as Vec3;
    const failOnCollision = (e as boolean | undefined) ?? true;
    const failOnSlopes = f ?? true;
    void g;

    if (!this.checkCollisionAndGetValidCoords(source, startX, startY, startZ, dest, failOnCollision)) return false;

    const unit = source.toUnit();
    // if it's not an unit (Object) then we do not have to continue
    // with walkable checks
    if (!unit) return true;

    /*
     * Walkable checks
     */
    const isWaterNext = this.hasEnoughWater(unit, dest.x, dest.y, dest.z);
    const creature = unit.toCreature() as (Creature & { canEnterWater(): boolean; canWalk(): boolean }) | null;
    const cannotEnterWater = isWaterNext && !!creature && !creature.canEnterWater();
    const cannotWalkOrFly = !isWaterNext && !source.toPlayer() && !unit.canFly() && !!creature && !creature.canWalk();
    if (cannotEnterWater || cannotWalkOrFly || (failOnSlopes && !PathGenerator.isWalkableClimb(startX, startY, startZ, dest.x, dest.y, dest.z, source.getCollisionHeight()))) return false;

    return true;
  }

  /**
   * @ac game/Maps/Map.cpp Map::CheckCollisionAndGetValidCoords
   * validate the new destination and set coords: check if a given unit can face collisions in a specific segment. The
   * `float& destX, destY, destZ` out parameters are `dest` (written in place). Returns true if the destination is valid.
   */
  checkCollisionAndGetValidCoords(source: WorldObject, startX: number, startY: number, startZ: number, dest: Vec3, failOnCollision = true): boolean {
    // Prevent invalid coordinates here, position is unchanged
    if (!IsValidMapCoord(startX, startY, startZ) || !IsValidMapCoord(dest.x, dest.y, dest.z)) {
      logError(
        "maps",
        `Map::CheckCollisionAndGetValidCoords invalid coordinates startX: ${startX}, startY: ${startY}, startZ: ${startZ}, destX: ${dest.x}, destY: ${dest.y}, destZ: ${dest.z}`,
      );
      return false;
    }

    const isWaterNext = this.isInWater(source.getPhaseMask(), dest.x, dest.y, dest.z, source.getCollisionHeight());

    const path = new PathGenerator(source as unknown as PathSource);

    // Use a detour raycast to get our first collision point
    path.setUseRaycast(true);
    const result = path.calculatePath(startX, startY, startZ, dest.x, dest.y, dest.z, false);

    const unit = source.toUnit() as (UnitLike & { isFlying?(): boolean }) | null;
    const flying = unit ? (unit.isFlying?.() ?? unit.hasUnitMovementFlag(MOVEMENTFLAG_FLYING | MOVEMENTFLAG_DISABLE_GRAVITY)) : false;
    const notOnGround = (path.getPathType() & PathType.PATHFIND_NOT_USING_PATH) !== 0 || isWaterNext || flying;

    // Check for valid path types before we proceed
    if (
      !result ||
      (!notOnGround &&
        (path.getPathType() & ~(PathType.PATHFIND_NORMAL | PathType.PATHFIND_SHORTCUT | PathType.PATHFIND_INCOMPLETE | PathType.PATHFIND_FARFROMPOLY_END)) !== 0)
    )
      return false;

    const points = path.getPath();
    const endPos = points[points.length - 1]!;
    dest.x = endPos.x;
    dest.y = endPos.y;
    dest.z = endPos.z;

    // collision check
    let collided = false;

    // check static LOS
    const halfHeight = source.getCollisionHeight() * 0.5;

    // Unit is not on the ground, check for potential collision via vmaps
    if (notOnGround) {
      const col = this._mapCollisionData.getStaticTree().GetObjectHitPos(startX, startY, startZ + halfHeight, dest.x, dest.y, dest.z + halfHeight, dest, -CONTACT_DISTANCE);

      dest.z -= halfHeight;

      // Collided with static LOS object, move back to collision point
      if (col) collided = true;
    }

    // check dynamic collision
    const col = this._mapCollisionData
      .getDynamicTree()
      .GetObjectHitPos(source.getPhaseMask(), startX, startY, startZ + halfHeight, dest.x, dest.y, dest.z + halfHeight, dest, -CONTACT_DISTANCE);

    dest.z -= halfHeight;

    // Collided with a gameobject, move back to collision point
    if (col) collided = true;

    const groundZ: FloatRef = { value: VMAP_INVALID_HEIGHT_VALUE };
    dest.z = source.updateAllowedPositionZ(dest.x, dest.y, dest.z, groundZ);

    // position has no ground under it (or is too far away)
    if (groundZ.value <= INVALID_HEIGHT && unit && !unit.canFly()) {
      // fall back to gridHeight if any
      const gridHeight = this.getGridHeight(dest.x, dest.y);
      if (gridHeight > INVALID_HEIGHT) dest.z = gridHeight + unit.getHoverHeight();
      else return false;
    }

    return !failOnCollision || !collided;
  }

  /** @ac game/Maps/Map.h Map::Balance */
  balance(): void {
    this._mapCollisionData.getDynamicTree().balance();
  }

  /** @ac game/Maps/Map.h Map::RemoveGameObjectModel */
  removeGameObjectModel(model: GameObjectModel): void {
    this._mapCollisionData.getDynamicTree().remove(model);
  }

  /** @ac game/Maps/Map.h Map::InsertGameObjectModel */
  insertGameObjectModel(model: GameObjectModel): void {
    this._mapCollisionData.getDynamicTree().insert(model);
  }

  /** @ac game/Maps/Map.h Map::ContainsGameObjectModel */
  containsGameObjectModel(model: GameObjectModel): boolean {
    return this._mapCollisionData.getDynamicTree().contains(model);
  }

  /** @ac game/Maps/Map.h Map::GetDynamicMapTree */
  getDynamicMapTree(): ReturnType<MapCollisionData["getDynamicTree"]> {
    return this._mapCollisionData.getDynamicTree();
  }

  /** @ac game/Maps/Map.h Map::GetGameObjectFloor */
  getGameObjectFloor(phasemask: number, x: number, y: number, z: number, maxSearchDist: number = DEFAULT_HEIGHT_SEARCH): number {
    return this._mapCollisionData.getDynamicTree().getHeight(x, y, z, maxSearchDist, phasemask);
  }

  /** @ac game/Maps/Map.h Map::GetMapCollisionData */
  getMapCollisionData(): MapCollisionData {
    return this._mapCollisionData;
  }

  /** @ac game/Maps/Map.cpp Map::GetLinkedRespawnTime */
  getLinkedRespawnTime(guid: bigint): number {
    const linkedGuid = MapHooks.objectMgr?.getLinkedRespawnGuid(guid) ?? ObjectGuid.Empty;
    switch (ObjectGuid.GetHigh(linkedGuid)) {
      case HighGuid.Unit:
        return this.getCreatureRespawnTime(ObjectGuid.GetCounter(linkedGuid));
      case HighGuid.GameObject:
        return this.getGORespawnTime(ObjectGuid.GetCounter(linkedGuid));
      default:
        break;
    }

    return 0;
  }

  /** @ac game/Maps/Map.h Map::GetCreatureRespawnTime */
  getCreatureRespawnTime(dbGuid: number): number {
    return this._creatureRespawnTimes.get(dbGuid) ?? 0;
  }

  /** @ac game/Maps/Map.h Map::GetGORespawnTime */
  getGORespawnTime(dbGuid: number): number {
    return this._goRespawnTimes.get(dbGuid) ?? 0;
  }

  /**
   * @ac game/Maps/Map.cpp Map::SaveCreatureRespawnTime
   * The `time_t& respawnTime` is also a result: an instance that resets before the respawn pushes it a year out. Returns
   * the time that was stored (0 when the entry was only deleted).
   */
  saveCreatureRespawnTime(spawnId: number, respawnTime: number): number {
    if (!respawnTime) {
      // Delete only
      this.removeCreatureRespawnTime(spawnId);
      return respawnTime;
    }

    const now = getGameTime();
    if (this.getInstanceResetPeriod() > 0 && respawnTime - now + 5 >= this.getInstanceResetPeriod()) respawnTime = now + YEAR;

    // Remove old queue entry if updating an existing respawn time
    const old = this._creatureRespawnTimes.get(spawnId);
    if (old !== undefined) this._respawnQueue.erase({ respawnTime: old, type: SPAWN_TYPE_CREATURE, spawnId });

    this._creatureRespawnTimes.set(spawnId, respawnTime);
    this._respawnQueue.insert({ respawnTime, type: SPAWN_TYPE_CREATURE, spawnId });

    sMapRespawnStore.replace(SPAWN_TYPE_CREATURE, this.getId(), this.getInstanceId(), spawnId, respawnTime >>> 0);
    executeCharacterStatement(CHAR_REP_CREATURE_RESPAWN, spawnId, respawnTime >>> 0, this.getId(), this.getInstanceId());
    return respawnTime;
  }

  /** @ac game/Maps/Map.cpp Map::RemoveCreatureRespawnTime */
  removeCreatureRespawnTime(spawnId: number): void {
    const old = this._creatureRespawnTimes.get(spawnId);
    if (old !== undefined) {
      this._respawnQueue.erase({ respawnTime: old, type: SPAWN_TYPE_CREATURE, spawnId });
      this._creatureRespawnTimes.delete(spawnId);
    }

    sMapRespawnStore.remove(SPAWN_TYPE_CREATURE, this.getId(), this.getInstanceId(), spawnId);
    executeCharacterStatement(CHAR_DEL_CREATURE_RESPAWN, spawnId, this.getId(), this.getInstanceId());
  }

  /** @ac game/Maps/Map.cpp Map::SaveGORespawnTime (see `saveCreatureRespawnTime` for the returned time) */
  saveGORespawnTime(spawnId: number, respawnTime: number): number {
    if (!respawnTime) {
      // Delete only
      this.removeGORespawnTime(spawnId);
      return respawnTime;
    }

    const now = getGameTime();
    if (this.getInstanceResetPeriod() > 0 && respawnTime - now + 5 >= this.getInstanceResetPeriod()) respawnTime = now + YEAR;

    // Remove old queue entry if updating an existing respawn time
    const old = this._goRespawnTimes.get(spawnId);
    if (old !== undefined) this._respawnQueue.erase({ respawnTime: old, type: SPAWN_TYPE_GAMEOBJECT, spawnId });

    this._goRespawnTimes.set(spawnId, respawnTime);
    this._respawnQueue.insert({ respawnTime, type: SPAWN_TYPE_GAMEOBJECT, spawnId });

    sMapRespawnStore.replace(SPAWN_TYPE_GAMEOBJECT, this.getId(), this.getInstanceId(), spawnId, respawnTime >>> 0);
    executeCharacterStatement(CHAR_REP_GO_RESPAWN, spawnId, respawnTime >>> 0, this.getId(), this.getInstanceId());
    return respawnTime;
  }

  /** @ac game/Maps/Map.cpp Map::RemoveGORespawnTime */
  removeGORespawnTime(spawnId: number): void {
    const old = this._goRespawnTimes.get(spawnId);
    if (old !== undefined) {
      this._respawnQueue.erase({ respawnTime: old, type: SPAWN_TYPE_GAMEOBJECT, spawnId });
      this._goRespawnTimes.delete(spawnId);
    }

    sMapRespawnStore.remove(SPAWN_TYPE_GAMEOBJECT, this.getId(), this.getInstanceId(), spawnId);
    executeCharacterStatement(CHAR_DEL_GO_RESPAWN, spawnId, this.getId(), this.getInstanceId());
  }

  /** @ac game/Maps/Map.h Map::GetCreatureRespawnTimes */
  getCreatureRespawnTimes(): ReadonlyMap<number, number> {
    return this._creatureRespawnTimes;
  }

  /** @ac game/Maps/Map.h Map::GetGORespawnTimes */
  getGORespawnTimes(): ReadonlyMap<number, number> {
    return this._goRespawnTimes;
  }

  /**
   * @ac game/Maps/Map.cpp Map::LoadRespawnTimes
   * The `CHAR_SEL_CREATURE_RESPAWNS` / `CHAR_SEL_GO_RESPAWNS` rows of this map and instance, from `sMapRespawnStore` (the
   * tables read at startup; see `MapRespawnStore`).
   */
  loadRespawnTimes(): void {
    for (const [lowguid, respawnTime] of sMapRespawnStore.creatureRespawns(this.getId(), this.getInstanceId())) {
      this._creatureRespawnTimes.set(lowguid, respawnTime);
      this._respawnQueue.insert({ respawnTime, type: SPAWN_TYPE_CREATURE, spawnId: lowguid });
    }

    for (const [lowguid, respawnTime] of sMapRespawnStore.gameObjectRespawns(this.getId(), this.getInstanceId())) {
      this._goRespawnTimes.set(lowguid, respawnTime);
      this._respawnQueue.insert({ respawnTime, type: SPAWN_TYPE_GAMEOBJECT, spawnId: lowguid });
    }
  }

  /** @ac game/Maps/Map.cpp Map::DeleteRespawnTimes */
  deleteRespawnTimes(): void {
    this._creatureRespawnTimes.clear();
    this._goRespawnTimes.clear();
    this._respawnQueue.clear();

    Map.deleteRespawnTimesInDB(this.getId(), this.getInstanceId());
  }

  /** @ac game/Maps/Map.cpp Map::DeleteRespawnTimesInDB */
  static deleteRespawnTimesInDB(mapId: number, instanceId: number): void {
    sMapRespawnStore.removeInstance(mapId, instanceId);
    executeCharacterStatement(CHAR_DEL_CREATURE_RESPAWN_BY_INSTANCE, mapId, instanceId);
    executeCharacterStatement(CHAR_DEL_GO_RESPAWN_BY_INSTANCE, mapId, instanceId);
  }

  /** @ac game/Maps/Map.h Map::GetInstanceResetPeriod */
  getInstanceResetPeriod(): number {
    return this._instanceResetPeriod;
  }

  /** @ac game/Maps/Map.h Map::GetRespawnTime */
  getRespawnTime(type: SpawnObjectType, spawnId: number): number {
    switch (type) {
      case SPAWN_TYPE_CREATURE:
        return this.getCreatureRespawnTime(spawnId);
      case SPAWN_TYPE_GAMEOBJECT:
        return this.getGORespawnTime(spawnId);
      default:
        return 0;
    }
  }

  /** @ac game/Maps/Map.h Map::RemoveRespawnTime */
  removeRespawnTime(type: SpawnObjectType, spawnId: number): void {
    switch (type) {
      case SPAWN_TYPE_CREATURE:
        this.removeCreatureRespawnTime(spawnId);
        break;
      case SPAWN_TYPE_GAMEOBJECT:
        this.removeGORespawnTime(spawnId);
        break;
      default:
        break;
    }
  }

  /** @ac game/Maps/Map.cpp Map::IsSpawnGroupActive */
  isSpawnGroupActive(groupId: number): boolean {
    const data = MapHooks.objectMgr?.getSpawnGroupData(groupId) ?? null;
    if (!data) return false;

    // System groups are always active
    if (data.flags & SPAWNGROUP_FLAG_SYSTEM) return true;

    // Per-map toggled state: XOR with default.
    // MANUAL_SPAWN groups default to inactive; toggling makes them active.
    // Non-MANUAL groups default to active; toggling makes them inactive.
    const toggled = this._toggledSpawnGroupIds.has(groupId);
    const defaultActive = !(data.flags & SPAWNGROUP_FLAG_MANUAL_SPAWN);
    return toggled !== defaultActive; // XOR: toggled flips the default
  }

  /** @ac game/Maps/Map.cpp Map::SpawnGroupSpawn */
  spawnGroupSpawn(groupId: number, ignoreRespawn = false, force = false): boolean {
    const objectMgr = MapHooks.objectMgr;
    const groupData = objectMgr?.getSpawnGroupData(groupId) ?? null;
    if (!objectMgr || !groupData || groupData.flags & SPAWNGROUP_FLAG_SYSTEM) {
      logError("maps", `Tried to spawn non-existing (or system) spawn group ${groupId}. Blocked.`);
      return false;
    }

    if (groupData.mapId !== SPAWNGROUP_MAP_UNSET && groupData.mapId !== this.getId()) {
      logError("maps", `Tried to spawn group ${groupId} on map ${this.getId()}, but group has map ${groupData.mapId}. Blocked.`);
      return false;
    }

    // Mark group as active on this map (toggle to active state)
    if (groupData.flags & SPAWNGROUP_FLAG_MANUAL_SPAWN) this._toggledSpawnGroupIds.add(groupId);
    else this._toggledSpawnGroupIds.delete(groupId);

    for (const data of objectMgr.getSpawnDataForGroup(groupId)) {
      const spawnId = data.spawnId;

      // Check if there's already an alive instance
      if (!force) {
        if (data.type === SPAWN_TYPE_CREATURE) {
          let alive = false;
          for (const creature of this._creatureBySpawnIdStore.get(spawnId) ?? []) if (creature.isAlive()) alive = true;
          if (alive) continue;
        } else if (data.type === SPAWN_TYPE_GAMEOBJECT) {
          if ((this._gameobjectBySpawnIdStore.get(spawnId)?.length ?? 0) > 0) continue;
        }
      }

      const respawnTime = this.getRespawnTime(data.type, spawnId);
      if (respawnTime && respawnTime > getGameTime()) {
        if (!force && !ignoreRespawn) continue;
        this.removeRespawnTime(data.type, spawnId);
      }

      // Don't spawn if grid isn't loaded (will be handled in grid loader)
      if (!this.isGridLoaded(data.posX, data.posY)) continue;

      switch (data.type) {
        case SPAWN_TYPE_CREATURE: {
          // `if (!creature->LoadCreatureFromDB(spawnId, this, true, true)) delete creature;`
          MapHooks.createCreature?.().loadCreatureFromDB(spawnId, this, true, true);
          break;
        }
        case SPAWN_TYPE_GAMEOBJECT: {
          MapHooks.createGameObject?.().loadGameObjectFromDB(spawnId, this, true);
          break;
        }
        default:
          break;
      }
    }

    return true;
  }

  /** @ac game/Maps/Map.cpp Map::SpawnGroupDespawn */
  spawnGroupDespawn(groupId: number, deleteRespawnTimes = false): boolean {
    const objectMgr = MapHooks.objectMgr;
    const groupData = objectMgr?.getSpawnGroupData(groupId) ?? null;
    if (!objectMgr || !groupData || groupData.flags & SPAWNGROUP_FLAG_SYSTEM) {
      logError("maps", `Tried to despawn non-existing (or system) spawn group ${groupId}. Blocked.`);
      return false;
    }

    if (groupData.mapId !== SPAWNGROUP_MAP_UNSET && groupData.mapId !== this.getId()) {
      logError("maps", `Tried to despawn group ${groupId} on map ${this.getId()}, but group has map ${groupData.mapId}. Blocked.`);
      return false;
    }

    // Mark group as inactive on this map (toggle to inactive state)
    if (groupData.flags & SPAWNGROUP_FLAG_MANUAL_SPAWN) this._toggledSpawnGroupIds.delete(groupId);
    else this._toggledSpawnGroupIds.add(groupId);

    const toUnload: WorldObject[] = [];
    for (const data of objectMgr.getSpawnDataForGroup(groupId)) {
      const spawnId = data.spawnId;

      if (deleteRespawnTimes) this.removeRespawnTime(data.type, spawnId);

      switch (data.type) {
        case SPAWN_TYPE_CREATURE:
          toUnload.push(...(this._creatureBySpawnIdStore.get(spawnId) ?? []));
          break;
        case SPAWN_TYPE_GAMEOBJECT:
          toUnload.push(...(this._gameobjectBySpawnIdStore.get(spawnId) ?? []));
          break;
        default:
          break;
      }
    }

    for (const obj of toUnload) obj.addObjectToRemoveList();

    return true;
  }

  /** @ac game/Maps/Map.cpp Map::ProcessRespawns */
  processRespawns(): void {
    const now = getGameTime();

    // Process due respawns from the time-ordered queue.
    // Entries are sorted by respawnTime - once we hit a future time, we're done.
    while (!this._respawnQueue.empty()) {
      const it = this._respawnQueue.begin()!;
      if (it.respawnTime > now) break; // nothing else is due this tick

      const type = it.type;
      const spawnId = it.spawnId;

      // Remove from queue first - handlers below call Remove*RespawnTime()
      // which also erases from queue, so we must pop before processing.
      this._respawnQueue.erase(it);

      if (type === SPAWN_TYPE_CREATURE) this.processCreatureRespawn(spawnId);
      else if (type === SPAWN_TYPE_GAMEOBJECT) this.processGameObjectRespawn(spawnId);
    }
  }

  /** @ac game/Maps/Map.cpp Map::ProcessCreatureRespawn */
  processCreatureRespawn(spawnId: number): void {
    const objectMgr = MapHooks.objectMgr;

    // Pool members are handled entirely by the pool system on this map's pool data
    const poolId = MapHooks.poolMgr?.isPartOfAPool("Creature", spawnId) ?? 0;
    if (poolId) {
      MapHooks.poolMgr!.updatePool(this.getPoolData(), "Creature", poolId, spawnId);
      this.removeCreatureRespawnTime(spawnId);
      return;
    }

    const data = objectMgr?.getSpawnCreatureData(spawnId) ?? null;
    if (!objectMgr || !data) {
      this.removeCreatureRespawnTime(spawnId);
      return;
    }

    // Compat-mode creatures handle their own respawn in-place - don't interfere.
    // Clean up the stale respawn time entry since the legacy system manages these.
    const groupData = objectMgr.getSpawnGroupData(data.spawnGroupId);
    if (!groupData || groupData.flags & SPAWNGROUP_FLAG_COMPATIBILITY_MODE) {
      this.removeCreatureRespawnTime(spawnId);
      return;
    }

    // Don't respawn if the spawn group is not active
    if (!this.isSpawnGroupActive(data.spawnGroupId)) {
      // Re-queue - will be checked again next ProcessRespawns() tick
      this._respawnQueue.insert({ respawnTime: getGameTime() + 5, type: SPAWN_TYPE_CREATURE, spawnId });
      return;
    }

    // Skip if grid isn't loaded (will be handled in grid loader)
    if (!this.isGridLoaded(data.posX, data.posY)) {
      this._respawnQueue.insert({ respawnTime: getGameTime() + 5, type: SPAWN_TYPE_CREATURE, spawnId });
      return;
    }

    // Skip if already alive
    for (const creature of this._creatureBySpawnIdStore.get(spawnId) ?? []) {
      if (creature.isAlive()) {
        this.removeCreatureRespawnTime(spawnId);
        return;
      }
    }

    // Check linked_respawn: don't spawn if the master creature is still dead.
    // This mirrors the check in Creature::Respawn() for compat-mode creatures:
    // hard-reset creatures bypass it (they despawn on evade and must always
    // come back), and a creature linked to itself never auto-respawns.
    const dbtableHighGuid = ObjectGuid.Create(HighGuid.Unit, data.id, spawnId);
    const linkedRespawntime = this.getLinkedRespawnTime(dbtableHighGuid);
    const flagsExtra = objectMgr.getCreatureTemplateFlagsExtra(data.id);
    if (linkedRespawntime && !(flagsExtra & CREATURE_FLAG_EXTRA_HARD_RESET)) {
      const now = getGameTime();
      let newRespawnTime: number;
      if (objectMgr.getLinkedRespawnGuid(dbtableHighGuid) === dbtableHighGuid) newRespawnTime = now + DAY; // if linking self, never respawn (check delayed to next day)
      else newRespawnTime = (now > linkedRespawntime ? now : linkedRespawntime) + urand(5, MINUTE); // master is still dead; re-queue at the master's respawn time + a small offset
      this.saveCreatureRespawnTime(spawnId, newRespawnTime);
      return;
    }

    // Remove respawn time BEFORE LoadFromDB, otherwise the creature
    // reads it back and loads as DEAD instead of ALIVE
    this.removeCreatureRespawnTime(spawnId);

    // `if (!creature->LoadCreatureFromDB(spawnId, this, true, true)) delete creature;`
    MapHooks.createCreature?.().loadCreatureFromDB(spawnId, this, true, true);
  }

  /** @ac game/Maps/Map.cpp Map::ProcessGameObjectRespawn */
  processGameObjectRespawn(spawnId: number): void {
    const objectMgr = MapHooks.objectMgr;

    // Pool members are handled entirely by the pool system on this map's pool data
    const poolId = MapHooks.poolMgr?.isPartOfAPool("GameObject", spawnId) ?? 0;
    if (poolId) {
      MapHooks.poolMgr!.updatePool(this.getPoolData(), "GameObject", poolId, spawnId);
      this.removeGORespawnTime(spawnId);
      return;
    }

    const data = objectMgr?.getSpawnGameObjectData(spawnId) ?? null;
    if (!objectMgr || !data) {
      this.removeGORespawnTime(spawnId);
      return;
    }

    // Compat-mode gameobjects handle their own respawn - don't interfere.
    // Clean up the stale respawn time entry since the legacy system manages these.
    const groupData = objectMgr.getSpawnGroupData(data.spawnGroupId);
    if (!groupData || groupData.flags & SPAWNGROUP_FLAG_COMPATIBILITY_MODE) {
      this.removeGORespawnTime(spawnId);
      return;
    }

    // Don't respawn if the spawn group is not active
    if (!this.isSpawnGroupActive(data.spawnGroupId)) {
      this._respawnQueue.insert({ respawnTime: getGameTime() + 5, type: SPAWN_TYPE_GAMEOBJECT, spawnId });
      return;
    }

    // Skip if grid isn't loaded (will be handled in grid loader)
    if (!this.isGridLoaded(data.posX, data.posY)) {
      this._respawnQueue.insert({ respawnTime: getGameTime() + 5, type: SPAWN_TYPE_GAMEOBJECT, spawnId });
      return;
    }

    if ((this._gameobjectBySpawnIdStore.get(spawnId)?.length ?? 0) > 0) {
      this.removeGORespawnTime(spawnId);
      return;
    }

    // Remove respawn time BEFORE LoadFromDB, otherwise the GO
    // reads it back and loads as despawned
    this.removeGORespawnTime(spawnId);

    // `if (!gameobject->LoadGameObjectFromDB(spawnId, this, true)) delete gameobject;`
    MapHooks.createGameObject?.().loadGameObjectFromDB(spawnId, this, true);
  }

  /**
   * @ac game/Maps/Map.cpp Map::UpdateEncounterState
   * Checks encounter state at kill/spellcast, originally in InstanceScript however not every map has instance script :(
   * @ac-skip DungeonEncounter / InstanceScript / LFG: the encounter list (`ObjectMgr::GetDungeonEncounterList`), the
   * instance script's completed encounter mask, and `LFGMgr::FinishDungeon` are read through `MapHooks.objectMgr`
   * (`getDungeonEncounterList`) and the optional `getInstanceScript` of the source; nothing happens without them.
   */
  updateEncounterState(type: EncounterCreditType, creditEntry: number, source: UnitLike | null): void {
    const objectMgr = MapHooks.objectMgr;
    if (!objectMgr?.getDungeonEncounterList) return;

    const difficulty_fixed = IsSharedDifficultyMap(this.getId()) ? this.getDifficulty() % 2 : this.getDifficulty();
    let encounters: ReturnType<NonNullable<MapObjectMgr["getDungeonEncounterList"]>>;
    // 631 : ICC - 724 : Ruby Sanctum --- For heroic difficulties, for some reason, we don't have an encounter list, so we get the encounter list from normal diff. We shouldn't change difficulty_fixed variable.
    if ((this.getId() === 631 || this.getId() === 724) && this.isHeroic()) {
      encounters = objectMgr.getDungeonEncounterList(this.getId(), !this.is25ManRaid() ? RAID_DIFFICULTY_10MAN_NORMAL : RAID_DIFFICULTY_25MAN_NORMAL);
    } else {
      encounters = objectMgr.getDungeonEncounterList(this.getId(), difficulty_fixed);
    }

    if (!encounters) return;

    for (const encounter of encounters) {
      if (encounter.creditType === type && encounter.creditEntry === creditEntry) {
        const instanceScript = (source as unknown as { getInstanceScript?(): MapInstanceScript | null } | null)?.getInstanceScript?.() ?? null;
        if (instanceScript) {
          instanceScript.setCompletedEncountersMask((1 << encounter.dbcEntry.encounterIndex) | instanceScript.getCompletedEncounterMask(), true);
        }

        if (encounter.lastEncounterDungeon) break;
      }
    }

    // pussywizard:
    this.logEncounterFinished(type, creditEntry);
    // @ac-skip ScriptMgr::OnAfterUpdateEncounterState, LFGMgr::FinishDungeon (the LFG group of the players)
  }

  /** @ac game/Maps/Map.cpp Map::LogEncounterFinished (only for wotlk raids, because logs take up tons of mysql memory) */
  logEncounterFinished(type: EncounterCreditType, creditEntry: number): void {
    if (!this.isRaid() || !this.getEntry() || MapEntryExpansion(this.getEntry()!) < 2) return;
    const map = this.toInstanceMap();
    if (!map) return;
    let playersInfo = "";
    for (const p of map.getPlayers()) {
      const extra = p as unknown as { getAppliedAurasLog?(): string; getGuildId?(): number };
      const session = p.getSession() as unknown as { getAccountId?(): number; getRemoteAddress?(): string };
      playersInfo += `${p.getName()} (${ObjectGuid.ToString(p.getGUID())}, acc: ${session.getAccountId?.() ?? 0}, ip: ${session.getRemoteAddress?.() ?? ""}, guild: ${extra.getGuildId?.() ?? 0}), xyz: (${p.getPositionX().toFixed(1)}, ${p.getPositionY().toFixed(1)}, ${p.getPositionZ().toFixed(1)}), auras: ${extra.getAppliedAurasLog?.() ?? ""}\n`;
    }
    // `CleanStringForMysqlQuery` is the parameter binding
    executeCharacterStatement("INSERT INTO log_encounter VALUES(NOW(), ?, ?, ?, ?, ?)", this.getId(), this.getDifficulty(), type, creditEntry, playersInfo);
  }

  /** @ac game/Maps/Map.cpp Map::AllTransportsEmpty (pussywizard) */
  allTransportsEmpty(): boolean {
    for (const transport of this._transports) {
      const passengers = (transport as unknown as { getPassengers?(): ReadonlySet<WorldObject> }).getPassengers?.();
      if (passengers && passengers.size > 0) return false;
    }

    return true;
  }

  /** @ac game/Maps/Map.cpp Map::AllTransportsRemovePassengers (pussywizard) */
  allTransportsRemovePassengers(): void {
    for (const transport of this._transports) {
      const t = transport as unknown as { getPassengers?(): ReadonlySet<WorldObject>; removePassenger?(passenger: WorldObject, withAll: boolean): void };
      const passengers = t.getPassengers?.();
      if (!passengers || !t.removePassenger) continue;
      while (passengers.size > 0) t.removePassenger(passengers.values().next().value as WorldObject, true);
    }
  }

  /** @ac game/Maps/Map.h Map::GetAllTransports */
  getAllTransports(): TransportsContainer {
    return this._transports;
  }

  /** @ac game/Maps/Map.cpp Map::AddCorpse */
  addCorpse(corpse: Corpse): void {
    corpse.setMap(this);

    const gridCoord = ComputeGridCoord(corpse.getPositionX(), corpse.getPositionY());
    let corpses = this._corpsesByGrid.get(gridCoord.getId());
    if (!corpses) this._corpsesByGrid.set(gridCoord.getId(), (corpses = new Set()));
    corpses.add(corpse);
    if (corpse.getType() !== CORPSE_BONES) this._corpsesByPlayer.set(corpse.getOwnerGUID(), corpse);
    else this._corpseBones.add(corpse);
  }

  /** @ac game/Maps/Map.cpp Map::RemoveCorpse */
  removeCorpse(corpse: Corpse): void {
    const gridCoord = ComputeGridCoord(corpse.getPositionX(), corpse.getPositionY());

    corpse.destroyForVisiblePlayers();
    if (corpse.isInGrid()) this.removeFromMap(corpse, false);
    else {
      corpse.removeFromWorld();
      corpse.resetMap();
    }

    this._corpsesByGrid.get(gridCoord.getId())?.delete(corpse);
    if (corpse.getType() !== CORPSE_BONES) this._corpsesByPlayer.delete(corpse.getOwnerGUID());
    else this._corpseBones.delete(corpse);
  }

  /** @ac game/Maps/Map.cpp Map::ConvertCorpseToBones */
  convertCorpseToBones(ownerGuid: bigint, insignia = false): Corpse | null {
    const corpse = this.getCorpseByPlayer(ownerGuid);
    if (!corpse) return null;

    this.removeCorpse(corpse);

    // remove corpse from DB (`corpse->DeleteFromDB(trans)` in its own transaction)
    corpse.deleteFromDB();

    let bones: MapCorpse | null = null;

    // create the bones only if the map and the grid is loaded at the corpse's location
    // ignore bones creating option in case insignia
    if (
      (insignia ||
        (this.isBattlegroundOrArena()
          ? sWorld().getBoolConfig(ServerConfig.CONFIG_DEATH_BONES_BG_OR_ARENA)
          : sWorld().getBoolConfig(ServerConfig.CONFIG_DEATH_BONES_WORLD))) &&
      this.isGridLoaded(corpse.getPositionX(), corpse.getPositionY()) &&
      MapHooks.createCorpse
    ) {
      // Create bones, don't change Corpse
      bones = MapHooks.createCorpse(CORPSE_BONES);
      bones.create(ObjectGuid.GetCounter(corpse.getGUID()));

      for (let i = OBJECT_FIELD_TYPE + 1; i < CORPSE_END; ++i)
        // don't overwrite guid and object type
        bones.setUInt32Value(i, corpse.getUInt32Value(i));

      bones.setCellCoord(corpse.getCellCoord());
      bones.relocate(corpse.getPositionX(), corpse.getPositionY(), corpse.getPositionZ(), corpse.getOrientation());
      bones.setPhaseMask(corpse.getPhaseMask(), false);

      bones.setUInt32Value(CORPSE_FIELD_FLAGS, CORPSE_FLAG_UNK2 | CORPSE_FLAG_BONES);
      bones.setGuidValue(CORPSE_FIELD_OWNER, corpse.getOwnerGUID());

      for (let i = 0; i < EQUIPMENT_SLOT_END; ++i) if (corpse.getUInt32Value(CORPSE_FIELD_ITEM + i)) bones.setUInt32Value(CORPSE_FIELD_ITEM + i, 0);

      this.addCorpse(bones as unknown as Corpse);

      bones.updatePositionData();

      // add bones in grid store if grid loaded where corpse placed
      this.addToMap(bones);
    }

    // all references to the corpse should be removed at this point
    return bones as unknown as Corpse | null;
  }

  /** @ac game/Maps/Map.cpp Map::RemoveOldCorpses */
  removeOldCorpses(): void {
    const now = getGameTime();

    const corpses: bigint[] = [];
    for (const [ownerGuid, corpse] of this._corpsesByPlayer) if (corpse.isExpired(now)) corpses.push(ownerGuid);

    for (const ownerGuid of corpses) this.convertCorpseToBones(ownerGuid);

    const expiredBones: Corpse[] = [];
    for (const bones of this._corpseBones) if (bones.isExpired(now)) expiredBones.push(bones);

    for (const bones of expiredBones) this.removeCorpse(bones);
  }

  /**
   * @ac game/Maps/Map.cpp Map::LoadCorpseData
   * Reads the `corpse` rows of this map and instance (`CHAR_SEL_CORPSES`) and adds the corpses. Awaits MySQL, so the map
   * manager starts it and does not wait: the corpses show up when the rows arrive.
   */
  async loadCorpseData(): Promise<void> {
    const db = characterDatabase();
    if (!db || !MapHooks.createCorpse) return;

    //        0     1     2     3            4      5          6          7       8       9        10     11        12    13          14          15         16
    // SELECT posX, posY, posZ, orientation, mapId, displayId, itemCache, bytes1, bytes2, guildId, flags, dynFlags, time, corpseType, instanceId, phaseMask, guid FROM corpse WHERE mapId = ? AND instanceId = ?
    const rows = await db.select().from(corpseTable).where(and(eq(corpseTable.mapId, this.getId()), eq(corpseTable.instanceId, this.getInstanceId())));
    for (const fields of rows) {
      const type = fields.corpseType;
      const guid = fields.guid;
      if (type >= MAX_CORPSE_TYPE || type === CORPSE_BONES) {
        logError("maps", `Corpse (guid: ${guid}) have wrong corpse type (${type}), not loading.`);
        continue;
      }

      const corpse = MapHooks.createCorpse(type);

      if (!corpse.loadCorpseFromDB(this.generateLowGuid(HighGuid.Corpse), fields)) continue;

      this.addCorpse(corpse as unknown as Corpse);

      corpse.updatePositionData();
    }
  }

  /** @ac game/Maps/Map.cpp Map::DeleteCorpseData */
  deleteCorpseData(): void {
    // DELETE FROM corpse WHERE mapId = ? AND instanceId = ?
    executeCharacterStatement(CHAR_DEL_CORPSES_FROM_MAP, this.getId(), this.getInstanceId());
  }

  /**
   * @ac game/Maps/Map.cpp Map::ScheduleCreatureRespawn
   * `respawnTimer` is in milliseconds (`Milliseconds`).
   */
  scheduleCreatureRespawn(creatureGuid: bigint, respawnTimer: number, pos: PositionLike | null = null): void {
    this.Events.addEventAtOffset(() => {
      const creature = this.getCreature(creatureGuid);
      if (creature) (creature as MapObjectLike).respawn?.();
      else if (pos) this.summonCreature(ObjectGuid.GetEntry(creatureGuid), pos);
    }, respawnTimer);
  }

  /** @ac game/Maps/Map.cpp Map::SendZoneMessage (send a packet to all players (or players selected team) in the zone (except self if mentioned)) */
  sendZoneMessage(zone: number, packet: WorldPacket, self: unknown = null, teamId: number = TEAM_NEUTRAL): boolean {
    let foundPlayerToSend = false;

    for (const player of this.getPlayers()) {
      if (player.isInWorld() && player.getZoneId() === zone && player.getSession() !== self && (teamId === TEAM_NEUTRAL || player.getTeamId() === teamId)) {
        player.sendDirectMessage(packet);
        foundPlayerToSend = true;
      }
    }

    return foundPlayerToSend;
  }

  /** @ac game/Maps/Map.cpp Map::SendZoneText (send a System Message to all players in the zone (except self if mentioned)) */
  sendZoneText(zoneId: number, text: string, self: unknown = null, teamId: number = TEAM_NEUTRAL): void {
    const data = MapHooks.buildSystemChatPacket?.(text);
    if (data) this.sendZoneMessage(zoneId, data, self, teamId);
  }

  /** @ac game/Maps/Map.cpp Map::SendZoneDynamicInfo */
  sendZoneDynamicInfo(zoneId: number, player: MapPlayer): void {
    const info = this._zoneDynamicInfo.get(zoneId);
    if (!info) return;

    const music = info.MusicId;
    if (music) player.sendDirectMessage({ opcode: SMSG_PLAY_MUSIC, payload: new ByteWriter().writeU32(music).toUint8Array() });

    this.sendZoneWeather(info, player);

    const overrideLight = info.OverrideLightId;
    if (overrideLight) {
      player.sendDirectMessage({
        opcode: SMSG_OVERRIDE_LIGHT,
        payload: new ByteWriter().writeU32(this._defaultLight).writeU32(overrideLight).writeU32(info.LightFadeInTime).toUint8Array(),
      });
    }
  }

  /** @ac game/Maps/Map.cpp Map::SendZoneWeather (the `(uint32 zoneId, Player*)` and `(ZoneDynamicInfo const&, Player*)` overloads) */
  sendZoneWeather(zoneId: number, player: MapPlayer): void;
  sendZoneWeather(zoneDynamicInfo: ZoneDynamicInfo, player: MapPlayer): void;
  sendZoneWeather(zoneOrInfo: number | ZoneDynamicInfo, player: MapPlayer): void {
    if (typeof zoneOrInfo === "number") {
      const info = this._zoneDynamicInfo.get(zoneOrInfo);
      if (!info) return;

      this.sendZoneWeather(info, player);
      return;
    }

    const weatherId = zoneOrInfo.WeatherId;
    if (weatherId) player.sendDirectMessage(weatherPacket(weatherId, zoneOrInfo.WeatherGrade));
    else if (zoneOrInfo.DefaultWeather) zoneOrInfo.DefaultWeather.sendWeatherUpdateToPlayer(player);
    // Weather::SendFineWeatherUpdateToPlayer
    else player.sendDirectMessage(weatherPacket(WEATHER_STATE_FINE, 0.0));
  }

  /** @ac game/Maps/Map.cpp Map::UpdateWeather */
  updateWeather(diff: number): void {
    this._weatherUpdateTimer.update(diff);
    if (!this._weatherUpdateTimer.passed()) return;

    for (const zoneInfo of this._zoneDynamicInfo.values())
      if (zoneInfo.DefaultWeather && !zoneInfo.DefaultWeather.update(this._weatherUpdateTimer.getInterval())) zoneInfo.DefaultWeather = null;

    this._weatherUpdateTimer.reset();
  }

  /** @ac game/Maps/Map.cpp Map::PlayDirectSoundToMap */
  playDirectSoundToMap(soundId: number, zoneId = 0): void {
    const players = this.getPlayers();
    if (!players.isEmpty()) {
      const data: WorldPacket = { opcode: SMSG_PLAY_SOUND, payload: new ByteWriter().writeU32(soundId).toUint8Array() };

      for (const player of players) if (player && (!zoneId || player.getZoneId() === zoneId)) player.sendDirectMessage(data);
    }
  }

  /** @ac game/Maps/Map.cpp Map::SetZoneMusic */
  setZoneMusic(zoneId: number, musicId: number): void {
    this.zoneDynamicInfo(zoneId).MusicId = musicId;

    this.sendZoneMessage(zoneId, { opcode: SMSG_PLAY_MUSIC, payload: new ByteWriter().writeU32(musicId).toUint8Array() });
  }

  /**
   * @ac game/Maps/Map.cpp Map::GetOrGenerateZoneDefaultWeather
   * @ac-skip Weather: `WeatherMgr::GetWeatherData` / `Weather` are not ported, so no zone has a default weather.
   */
  getOrGenerateZoneDefaultWeather(_zoneId: number): ZoneDynamicInfo["DefaultWeather"] {
    return null;
  }

  /** @ac game/Maps/Map.cpp Map::SetZoneWeather */
  setZoneWeather(zoneId: number, weatherId: number, weatherGrade: number): void {
    const info = this.zoneDynamicInfo(zoneId);
    info.WeatherId = weatherId;
    info.WeatherGrade = weatherGrade;

    this.sendZoneMessage(zoneId, weatherPacket(weatherId, weatherGrade));
  }

  /** @ac game/Maps/Map.cpp Map::SetZoneOverrideLight (`fadeInTime` in milliseconds) */
  setZoneOverrideLight(zoneId: number, lightId: number, fadeInTime: number): void {
    const info = this.zoneDynamicInfo(zoneId);
    info.OverrideLightId = lightId;
    info.LightFadeInTime = fadeInTime >>> 0;

    this.sendZoneMessage(zoneId, {
      opcode: SMSG_OVERRIDE_LIGHT,
      payload: new ByteWriter().writeU32(this._defaultLight).writeU32(lightId).writeU32(fadeInTime >>> 0).toUint8Array(),
    });
  }

  /** `_zoneDynamicInfo[zoneId]` (`operator[]` inserts a default entry). */
  private zoneDynamicInfo(zoneId: number): ZoneDynamicInfo {
    let info = this._zoneDynamicInfo.get(zoneId);
    if (!info) this._zoneDynamicInfo.set(zoneId, (info = new ZoneDynamicInfo()));
    return info;
  }

  /** @ac game/Maps/Map.cpp Map::DoForAllPlayers (do whatever you want to all the players in map [including GameMasters]) */
  doForAllPlayers(exec: (player: MapPlayer) => void): void {
    for (const player of this.getPlayers()) if (player) exec(player);
  }

  /**
   * @ac game/Maps/Map.h Map::GenerateLowGuid
   * @ac game/Maps/Map.h Map::GetGuidSequenceGenerator (the per high guid `_guidGenerators` entry, created on first use)
   * `GenerateLowGuid<HighGuid::Unit>()` and the other map specific guids (`ObjectGuidTraits<high>::MapSpecific`); a
   * global high guid is a programming error (the C++ `static_assert`).
   */
  generateLowGuid(high: HighGuid): number {
    switch (high) {
      case HighGuid.GameObject:
      case HighGuid.Transport:
      case HighGuid.Unit:
      case HighGuid.Pet:
      case HighGuid.Vehicle:
      case HighGuid.DynamicObject:
      case HighGuid.Corpse:
        break;
      default:
        throw new Error(`Only map specific guid can be generated in Map context (HighGuid ${high})`);
    }

    let generator = this._guidGenerators.get(high);
    if (!generator) this._guidGenerators.set(high, (generator = new ObjectGuidGenerator(`Map ${this.getId()}:${this.getInstanceId()} HighGuid ${high}`)));
    return generator.generate();
  }

  /** @ac game/Maps/Map.h Map::AddUpdateObject */
  addUpdateObject(obj: AcObject): void {
    this._updateObjects.add(obj);
  }

  /** @ac game/Maps/Map.h Map::RemoveUpdateObject */
  removeUpdateObject(obj: AcObject): void {
    this._updateObjects.delete(obj);
  }

  /** @ac game/Maps/Map.h Map::GetUpdatableObjectsCount */
  getUpdatableObjectsCount(): number {
    return this._updatableObjectList.length;
  }

  /** @ac game/Maps/Map.cpp Map::GetDebugInfo */
  getDebugInfo(): string {
    return `Id: ${this.getId()} InstanceId: ${this.getInstanceId()} Difficulty: ${this.getDifficulty()} HasPlayers: ${this.havePlayers()}`;
  }

  /** @ac game/Maps/Map.cpp Map::GetCreatedGridsCount */
  getCreatedGridsCount(): number {
    return this._mapGridManager.getCreatedGridsCount();
  }

  /** @ac game/Maps/Map.cpp Map::GetLoadedGridsCount */
  getLoadedGridsCount(): number {
    return this._mapGridManager.getLoadedGridsCount();
  }

  /** @ac game/Maps/Map.cpp Map::GetCreatedCellsInGridCount */
  getCreatedCellsInGridCount(x: number, y: number): number {
    return this._mapGridManager.getCreatedCellsInGridCount(x, y);
  }

  /** @ac game/Maps/Map.cpp Map::GetCreatedCellsInMapCount */
  getCreatedCellsInMapCount(): number {
    return this._mapGridManager.getCreatedCellsInMapCount();
  }

  /** @ac game/Maps/Map.h Map::GetPlayerCountInZone */
  getPlayerCountInZone(zoneId: number): number {
    return this._zonePlayerCountMap.get(zoneId) ?? 0;
  }

  /** @ac game/Maps/Map.h Map::visit (`Map::Visit`: nothing when the cell's grid is not loaded) */
  visit(cell: Cell, visitor: TypeContainerVisitor<ContainerType>): void {
    const grid_x = cell.gridX();
    const grid_y = cell.gridY();

    // If grid is not loaded, nothing to visit.
    if (!this._mapGridManager.isGridLoaded(grid_x, grid_y)) return;

    this.getMapGrid(grid_x, grid_y)!.visitCell(cell.cellX(), cell.cellY(), visitor);
  }
}

/** @ac game/Entities/Player/Player.h TransferAbortReason */
export const TRANSFER_ABORT_MAX_PLAYERS = 0x02;
export const TRANSFER_ABORT_ZONE_IN_COMBAT = 0x06;
export const TRANSFER_ABORT_MAP_NOT_ALLOWED = 0x10;

/** @ac game/Instances/InstanceScript.h InstanceScript (the members `InstanceMap` calls; scripts are not ported) */
export interface MapInstanceScript {
  initialize(): void;
  load(data: string): void;
  update(diff: number): void;
  onPlayerEnter(player: MapPlayer): void;
  onPlayerLeave(player: MapPlayer): void;
  setCompletedEncountersMask(mask: number, save: boolean): void;
  getCompletedEncounterMask(): number;
  isEncounterInProgress(): boolean;
  isTwoFactionInstance(): boolean;
  getTeamIdInInstance(): number;
  setTeamIdInInstance(team: number): void;
  loadInstanceSavedGameobjectStateData(): void;
}

/** @ac game/Maps/Map.h InstanceMap (a dungeon or raid instance of a `MapInstanced`) */
export class InstanceMap extends Map {
  private m_resetAfterUnload = false;
  private m_unloadWhenEmpty = false;
  private instance_data: MapInstanceScript | null = null;
  private i_script_id = 0;

  /** @ac game/Maps/Map.cpp InstanceMap::InstanceMap */
  constructor(id: number, InstanceId: number, SpawnMode: number, _parent: Map | null) {
    super(id, InstanceId, SpawnMode, _parent);

    // lets initialize visibility distance for dungeons
    InstanceMap.prototype.initVisibilityDistance.call(this);

    // the timer is started by default, and stopped when the first player joins
    // this make sure it gets unloaded if for some reason no player joins
    this.m_unloadTimer = Math.max(sWorld().getIntConfig(ServerConfig.CONFIG_INSTANCE_UNLOAD_DELAY), MIN_UNLOAD_DELAY);

    // pussywizard:
    if (this.isRaid()) {
      const saves = MapHooks.instanceSaveMgr;
      const resetTime = saves?.getResetTimeFor(id, SpawnMode) ?? 0;
      if (resetTime) {
        const extendedResetTime = saves!.getExtendedResetTimeFor(id, SpawnMode);
        if (extendedResetTime) this._instanceResetPeriod = extendedResetTime - resetTime;
      }
    }
  }

  /** @ac game/Maps/Map.cpp InstanceMap::~InstanceMap */
  override destroy(): void {
    this.instance_data = null;
    MapHooks.instanceSaveMgr?.deleteInstanceSaveIfNeeded(this.getInstanceId(), true);
    super.destroy();
  }

  /** @ac game/Maps/Map.cpp InstanceMap::InitVisibilityDistance */
  override initVisibilityDistance(): void {
    // init visibility distance for instances
    this.m_VisibleDistance = MapHooks.getMaxVisibleDistanceInInstances();

    // pussywizard: this CAN NOT exceed MAX_VISIBILITY_DISTANCE
    switch (this.getId()) {
      case 429: // Dire Maul
      case 550: // The Eye
      case 578: // The Nexus: The Oculus
        this.m_VisibleDistance = 175.0;
        break;
      case 649: // Trial of the Crusader
      case 650: // Trial of the Champion
      case 595: // Culling of Startholme
      case 658: // Pit of Saron
        this.m_VisibleDistance = 150.0;
        break;
      case 615: // Obsidian Sanctum
      case 616: // Eye of Eternity
      case 603: // Ulduar
      case 668: // Halls of Reflection
      case 631: // Icecrown Citadel
      case 724: // Ruby Sanctum
        this.m_VisibleDistance = 200.0;
        break;
      case 531: // Ahn'Qiraj Temple
        this.m_VisibleDistance = 300.0;
        break;
    }
  }

  /**
   * @ac game/Maps/Map.cpp InstanceMap::CannotEnter
   * Do map specific checks to see if the player can enter.
   * @ac-skip Group / LFG: the LFG dungeon check (`LFGMgr::inLfgDungeonMap`) and the group comparison read the optional
   * `getGroup()` of the player; they apply only when the integration provides a group.
   */
  override cannotEnter(player: MapPlayer, loginCheck = false): EnterState {
    if (!loginCheck && player.getMapRef?.().getTarget() === this) {
      logError("maps", `InstanceMap::CanEnter - player ${player.getName()} (${ObjectGuid.ToString(player.getGUID())}) already in map ${this.getId()}, ${this.getInstanceId()}, ${this.getSpawnMode()}!`);

      return CANNOT_ENTER_ALREADY_IN_MAP;
    }

    // allow GM's to enter
    if (player.isGameMaster()) return super.cannotEnter(player, loginCheck);

    // cannot enter if the instance is full (player cap), GMs don't count
    const maxPlayers = this.getMaxPlayers();
    if (this.getPlayersCountExceptGMs() >= (loginCheck ? maxPlayers + 1 : maxPlayers)) {
      logDebug("maps", `MAP: Instance '${this.getInstanceId()}' of map '${this.getMapName()}' cannot have more than '${maxPlayers}' players. Player '${player.getName()}' rejected`);
      player.sendTransferAborted?.(this.getId(), TRANSFER_ABORT_MAX_PLAYERS);
      return CANNOT_ENTER_MAX_PLAYERS;
    }

    // cannot enter while an encounter is in progress on raids
    const checkProgress = this.isRaid() || this.getId() === 668; /*HoR*/
    if (checkProgress && this.getInstanceScript()?.isEncounterInProgress()) {
      player.sendTransferAborted?.(this.getId(), TRANSFER_ABORT_ZONE_IN_COMBAT);
      return CANNOT_ENTER_ZONE_IN_COMBAT;
    }

    // cannot enter if instance is in use by another party/soloer that have a permanent save in the same instance id
    const group = player.getGroup?.() ?? null;
    if (!this.getPlayers().isEmpty()) {
      for (const iPlayer of this.getPlayers()) {
        if (iPlayer === player)
          // login case, player already added to map
          continue;
        if (iPlayer.isGameMaster())
          // bypass GMs
          continue;
        if (!group) {
          // player has not group and there is someone inside, deny entry
          player.sendTransferAborted?.(this.getId(), TRANSFER_ABORT_MAX_PLAYERS);
          return CANNOT_ENTER_INSTANCE_BIND_MISMATCH;
        }
        // player inside instance has no group or his groups is different to entering player's one, deny entry
        const iGroup = iPlayer.getGroup?.() ?? null;
        if (!iGroup || iGroup !== group) {
          player.sendTransferAborted?.(this.getId(), TRANSFER_ABORT_MAX_PLAYERS);
          return CANNOT_ENTER_INSTANCE_BIND_MISMATCH;
        }
        break;
      }
    }

    return super.cannotEnter(player, loginCheck);
  }

  /**
   * @ac game/Maps/Map.cpp InstanceMap::AddPlayerToMap
   * Do map specific checks and add the player to the map if successful.
   * @ac-skip InstanceSaveMgr / Group: the instance binds need `MapHooks.instanceSaveMgr`; without it the player is added
   * unbound. The hourly instance limit (`Player::AddInstanceEnterTime`) and `Player::SetPendingBind` are optional player members.
   */
  override addPlayerToMap(player: MapPlayer): boolean {
    if (this.m_resetAfterUnload)
      // this instance has been reset, it's not meant to be used anymore
      return false;

    const saves = MapHooks.instanceSaveMgr;
    if (this.isDungeon() && saves) {
      // get an instance save for the map
      const mapSave = saves.getInstanceSave(this.getInstanceId());
      if (!mapSave) {
        logError("maps", `InstanceMap::Add: InstanceSave does not exist for map ${this.getId()} spawnmode ${this.getSpawnMode()} with instance id ${this.getInstanceId()}`);
        return false;
      }

      // check for existing instance binds
      let playerBind = saves.playerGetBoundInstance(player.getGUID(), this.getId(), this.getSpawnMode());
      if (playerBind && playerBind.perm) {
        if (playerBind.save !== mapSave) {
          logError(
            "maps",
            `InstanceMap::Add: player ${player.getName()} (${ObjectGuid.ToString(player.getGUID())}) is permanently bound to instance ${playerBind.save.getMapId()}, ${playerBind.save.getInstanceId()}, ${playerBind.save.getDifficulty()}, ${playerBind.save.canReset()} but he is being put into instance ${mapSave.getMapId()}, ${mapSave.getInstanceId()}, ${mapSave.getDifficulty()}, ${mapSave.canReset()}`,
          );
          return false;
        }
      } else if ((player.getSession() as unknown as { playerLoading?(): boolean }).playerLoading?.() && playerBind && playerBind.save !== mapSave) {
        // Prevent "Convert to Raid" exploit to reset instances
        return false;
      } else {
        playerBind = saves.playerBindToInstance(player.getGUID(), mapSave, false, player) as typeof playerBind;
        // @ac-skip Group: the leader bind (`PlayerCreateBoundInstancesMaps`, `ObjectAccessor::FindConnectedPlayer`) needs `Group`.
      }

      // increase current instances (hourly limit)
      // xinef: specific instances are still limited
      (player as unknown as { addInstanceEnterTime?(instanceId: number, time: number): void }).addInstanceEnterTime?.(this.getInstanceId(), getGameTime());

      if (playerBind && !playerBind.perm && !mapSave.canReset() && player.getGroup?.()) {
        // SMSG_INSTANCE_LOCK_WARNING_QUERY
        player.sendDirectMessage({
          opcode: SMSG_INSTANCE_LOCK_WARNING_QUERY,
          payload: new ByteWriter().writeU32(60000).writeU32(this.instance_data ? this.instance_data.getCompletedEncounterMask() : 0).writeU8(0).toUint8Array(),
        });
        (player as unknown as { setPendingBind?(instanceId: number, bindTimer: number): void }).setPendingBind?.(mapSave.getInstanceId(), 60000);
      }
    }

    // initialize unload state
    this.m_unloadTimer = 0;
    this.m_resetAfterUnload = false;
    this.m_unloadWhenEmpty = false;

    // this will acquire the same mutex so it cannot be in the previous block
    super.addPlayerToMap(player);

    if (this.instance_data) this.instance_data.onPlayerEnter(player);

    return true;
  }

  /** @ac game/Maps/Map.cpp InstanceMap::Update */
  override update(t_diff: number, s_diff: number, _thread = true): void {
    super.update(t_diff, s_diff);

    if (t_diff) if (this.instance_data) this.instance_data.update(t_diff);
  }

  /** @ac game/Maps/Map.cpp InstanceMap::RemovePlayerFromMap */
  override removePlayerFromMap(player: MapPlayer, remove: boolean): void {
    if (this.instance_data) this.instance_data.onPlayerLeave(player);
    // pussywizard: moved m_unloadTimer to InstanceMap::AfterPlayerUnlinkFromMap(), in this function if 2 players run out at the same time the instance won't close
    super.removePlayerFromMap(player, remove);

    // If remove == true - player already deleted.
    if (!remove) (player as unknown as { setPendingBind?(instanceId: number, bindTimer: number): void }).setPendingBind?.(0, 0);
  }

  /** @ac game/Maps/Map.cpp InstanceMap::AfterPlayerUnlinkFromMap */
  override afterPlayerUnlinkFromMap(): void {
    if (!this.m_unloadTimer && !this.havePlayers())
      this.m_unloadTimer = this.m_unloadWhenEmpty ? MIN_UNLOAD_DELAY : Math.max(sWorld().getIntConfig(ServerConfig.CONFIG_INSTANCE_UNLOAD_DELAY), MIN_UNLOAD_DELAY);
    super.afterPlayerUnlinkFromMap();
  }

  /**
   * @ac game/Maps/Map.cpp InstanceMap::CreateInstanceScript
   * @ac-skip ScriptMgr / InstanceScript: the script is created by `MapHooks.createInstanceScript` (instance scripts are not
   * ported, so there is none unless the integration provides one).
   */
  createInstanceScript(load: boolean, data: string, completedEncounterMask: number): void {
    if (this.instance_data) return;

    const mInstance = GetInstanceTemplate(this.getId());
    if (mInstance) {
      this.i_script_id = mInstance.ScriptId;
      this.instance_data = MapHooks.createInstanceScript?.(this) ?? null;
    }

    if (!this.instance_data) return;

    this.instance_data.initialize();

    if (load) {
      this.instance_data.setCompletedEncountersMask(completedEncounterMask, false);
      if (data !== "") this.instance_data.load(data);
    }

    this.instance_data.loadInstanceSavedGameobjectStateData();
  }

  /**
   * @ac game/Maps/Map.cpp InstanceMap::Reset
   * Returns true if there are no players in the instance.
   * @ac-skip Player: `Player::RepopAtGraveyard` and `Player::SendResetFailedNotify` are optional player members.
   */
  reset(method: number, globalResetSkipList: bigint[] | null = null): boolean {
    if (method === INSTANCE_RESET_GLOBAL) {
      // pussywizard: teleport out immediately
      for (const player of this.getPlayers()) {
        // teleport players that are no longer bound (can be still bound if extended id)
        if (!globalResetSkipList || !globalResetSkipList.includes(player.getGUID())) (player as unknown as { repopAtGraveyard?(): void }).repopAtGraveyard?.();
      }

      // reset map only if noone is bound
      if (!globalResetSkipList || globalResetSkipList.length === 0) {
        // pussywizard: setting both m_unloadWhenEmpty and m_unloadTimer intended, in case RepopAtGraveyard failed
        if (this.havePlayers()) this.m_unloadWhenEmpty = true;
        this.m_unloadTimer = MIN_UNLOAD_DELAY;
        this.m_resetAfterUnload = true;
      }

      return this.m_mapRefMgr.isEmpty();
    }

    if (this.havePlayers()) {
      if (method === INSTANCE_RESET_ALL || method === INSTANCE_RESET_CHANGE_DIFFICULTY) {
        for (const player of this.getPlayers()) (player as unknown as { sendResetFailedNotify?(mapid: number): void }).sendResetFailedNotify?.(this.getId());
      }
    } else {
      this.m_unloadTimer = MIN_UNLOAD_DELAY;
      this.m_resetAfterUnload = true;
    }

    return this.m_mapRefMgr.isEmpty();
  }

  /** @ac game/Maps/Map.h InstanceMap::GetScriptId */
  getScriptId(): number {
    return this.i_script_id;
  }

  /** @ac game/Maps/Map.cpp InstanceMap::GetScriptName (`sObjectMgr->GetScriptName(i_script_id)`) */
  getScriptName(): string {
    return MapHooks.getScriptName?.(this.i_script_id) ?? "";
  }

  /** @ac game/Maps/Map.h InstanceMap::GetInstanceScript */
  getInstanceScript(): MapInstanceScript | null {
    return this.instance_data;
  }

  /**
   * @ac game/Maps/Map.cpp InstanceMap::PermBindAllPlayers
   * @ac-skip Group: `Group::SetDifficultyChangePrevention` after the bind.
   */
  permBindAllPlayers(): void {
    if (!this.isDungeon()) return;

    const saves = MapHooks.instanceSaveMgr;
    const save = saves?.getInstanceSave(this.getInstanceId()) ?? null;
    if (!saves || !save) {
      logError("maps", `Cannot bind players because no instance save is available for instance map (Name: ${this.getMapName()}, Entry: ${this.getId()}, InstanceId: ${this.getInstanceId()})!`);
      return;
    }

    // group members outside the instance group don't get bound
    for (const player of this.getPlayers()) {
      // players inside an instance cannot be bound to other instances
      // some players may already be permanently bound, in this case nothing happens
      const bind = saves.playerGetBoundInstance(player.getGUID(), save.getMapId(), save.getDifficulty());

      if (!bind || !bind.perm) {
        // SMSG_INSTANCE_SAVE_CREATED
        player.sendDirectMessage({ opcode: SMSG_INSTANCE_SAVE_CREATED, payload: new ByteWriter().writeU32(0).toUint8Array() });
        saves.playerBindToInstance(player.getGUID(), save, true, player);
      }
    }
  }

  /** @ac game/Maps/Map.cpp InstanceMap::UnloadAll */
  override unloadAll(): void {
    if (this.havePlayers()) throw new Error("ASSERT failed: !HavePlayers() (InstanceMap::UnloadAll)");

    if (this.m_resetAfterUnload) {
      this.deleteRespawnTimes();
      this.deleteCorpseData();
    }

    super.unloadAll();
  }

  /**
   * @ac game/Maps/Map.cpp InstanceMap::SendResetWarnings
   * @ac-skip Player: `Player::SendInstanceResetWarning` is an optional player member.
   */
  sendResetWarnings(timeLeft: number): void {
    for (const player of this.getPlayers()) {
      const p = player as unknown as { sendInstanceResetWarning?(mapid: number, difficulty: number, timeLeft: number, onEnterMap: boolean): void };
      p.sendInstanceResetWarning?.(this.getId(), player.getDifficulty?.(this.isRaid()) ?? this.getDifficulty(), timeLeft, false);
    }
  }

  /** @ac game/Maps/Map.cpp InstanceMap::GetMaxPlayers */
  getMaxPlayers(): number {
    const mapDiff = this.getMapDifficulty();
    if (mapDiff && mapDiff.maxPlayers) return mapDiff.maxPlayers;

    return this.getEntry()?.maxPlayers ?? 0;
  }

  /** @ac game/Maps/Map.cpp InstanceMap::GetMaxResetDelay */
  getMaxResetDelay(): number {
    const mapDiff = this.getMapDifficulty();
    return mapDiff ? mapDiff.resetTime : 0;
  }

  /** @ac game/Maps/Map.cpp InstanceMap::GetDebugInfo */
  override getDebugInfo(): string {
    return `${super.getDebugInfo()}\nScriptId: ${this.getScriptId()} ScriptName: ${this.getScriptName()}`;
  }
}

/** @ac game/Maps/Map.h BattlegroundMap (a battleground or arena instance of a `MapInstanced`) */
export class BattlegroundMap extends Map {
  /** `Battleground* m_bg` (battlegrounds are not ported) */
  private m_bg: MapBattleground | null = null;

  /** @ac game/Maps/Map.cpp BattlegroundMap::BattlegroundMap */
  constructor(id: number, InstanceId: number, _parent: Map | null, spawnMode: number) {
    super(id, InstanceId, spawnMode, _parent);

    // lets initialize visibility distance for BG/Arenas
    BattlegroundMap.prototype.initVisibilityDistance.call(this);
  }

  /** @ac game/Maps/Map.cpp BattlegroundMap::~BattlegroundMap */
  override destroy(): void {
    if (this.m_bg) {
      // unlink to prevent crash, always unlink all pointer reference before destruction
      this.m_bg.setBgMap(null);
      this.m_bg = null;
    }
    super.destroy();
  }

  /** @ac game/Maps/Map.cpp BattlegroundMap::InitVisibilityDistance */
  override initVisibilityDistance(): void {
    // init visibility distance for BG/Arenas
    this.m_VisibleDistance = MapHooks.getMaxVisibleDistanceInBGArenas();

    if (this.isBattleArena())
      // pussywizard: start with 30yd visibility range on arenas to ensure players can't get informations about the opponents in any way
      this.m_VisibleDistance = 30.0;
  }

  /** @ac game/Maps/Map.cpp BattlegroundMap::CannotEnter */
  override cannotEnter(player: MapPlayer, loginCheck = false): EnterState {
    if (!loginCheck && player.getMapRef?.().getTarget() === this) {
      logError("maps", `BGMap::CanEnter - player ${ObjectGuid.ToString(player.getGUID())} is already in map!`);
      throw new Error("ABORT: BGMap::CanEnter - player is already in map");
    }

    if ((player.getBattlegroundId?.() ?? 0) !== this.getInstanceId()) return CANNOT_ENTER_INSTANCE_BIND_MISMATCH;

    // pussywizard: no need to check player limit here, invitations are limited by Battleground::GetFreeSlotsForTeam

    return super.cannotEnter(player, loginCheck);
  }

  /**
   * @ac game/Maps/Map.cpp BattlegroundMap::AddPlayerToMap
   * @ac-skip Spells: the arena preparation aura (`CastSpell(player, 100102, true)`) is cast through the optional
   * `castSpell` of the player.
   */
  override addPlayerToMap(player: MapPlayer): boolean {
    player.m_InstanceValid = true;
    if (this.isBattleArena()) (player as unknown as { castSpell?(target: GridPlayer, spellId: number, triggered: boolean): void }).castSpell?.(player, 100102, true);
    return super.addPlayerToMap(player);
  }

  /**
   * @ac game/Maps/Map.cpp BattlegroundMap::RemovePlayerFromMap
   * @ac-skip Battleground: `Battleground::RemovePlayerAtLeave` / `RemoveSpectator`; the arena aura is removed through the
   * optional `removeAura` of the player.
   */
  override removePlayerFromMap(player: MapPlayer, remove: boolean): void {
    const bg = this.getBG();
    if (bg) {
      bg.removePlayerAtLeave(player);
      if (this.isBattleArena()) bg.removeSpectator(player);
    }
    if (this.isBattleArena()) (player as unknown as { removeAura?(spellId: number): void }).removeAura?.(100102);
    super.removePlayerFromMap(player, remove);
  }

  /** @ac game/Maps/Map.cpp BattlegroundMap::SetUnload */
  setUnload(): void {
    this.m_unloadTimer = MIN_UNLOAD_DELAY;
  }

  /** @ac game/Maps/Map.cpp BattlegroundMap::RemoveAllPlayers */
  override removeAllPlayers(): void {
    if (this.havePlayers())
      for (const player of this.getPlayers()) if (player && !player.isBeingTeleportedFar?.()) player.teleportToEntryPoint?.();
  }

  /** @ac game/Maps/Map.h BattlegroundMap::GetBG */
  getBG(): MapBattleground | null {
    return this.m_bg;
  }

  /** @ac game/Maps/Map.h BattlegroundMap::SetBG */
  setBG(bg: MapBattleground | null): void {
    this.m_bg = bg;
  }
}

/** @ac game/Battlegrounds/Battleground.h Battleground (the members the maps call; battlegrounds are not ported) */
export interface MapBattleground {
  setBgMap(map: BattlegroundMap | null): void;
  removePlayerAtLeave(player: MapPlayer): void;
  removeSpectator(player: MapPlayer): void;
  getStatus(): number;
  getMapId(): number;
  getMinLevel(): number;
  getSpectators(): ReadonlySet<bigint>;
}

/** Helpers of this module (the C++ file-local functions and statics). */
type Vec3 = { x: number; y: number; z: number };

const F = Math.fround;

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::fuzzyLt (is a strictly less than b? guaranteed false if a >= b) */
function fuzzyLt(a: number, b: number): boolean {
  return a < b - eps64(a, b);
}

/** @ac game/Maps/Map.cpp IsInWMOInterior */
function IsInWMOInterior(mogpFlags: number): boolean {
  return (mogpFlags & 0x2000) !== 0;
}

/** `WorldPackets::Misc::Weather(weatherId, grade).Write()` (`SMSG_WEATHER`: state, intensity, abrupt) */
function weatherPacket(weatherId: number, intensity: number, abrupt = false): WorldPacket {
  return { opcode: SMSG_WEATHER, payload: new ByteWriter().writeU32(weatherId).writeF32(intensity).writeU8(abrupt ? 1 : 0).toUint8Array() };
}

// One result object per query kind, reused so the per movement queries allocate nothing (`reset()` before each use). A
// query that calls another (`getLiquidData` calls `getAreaId`) has its own so they do not overwrite each other.
const scratchAreaInfoStatic = new AreaAndLiquidData();
const scratchAreaInfoDynamic = new AreaAndLiquidData();
const scratchLiquidStatic = new AreaAndLiquidData();
const scratchFullStatic = new AreaAndLiquidData();
const scratchFullDynamic = new AreaAndLiquidData();

