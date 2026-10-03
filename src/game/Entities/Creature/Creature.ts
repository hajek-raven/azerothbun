/**
 * @ac game/Entities/Creature/Creature.h
 * @ac game/Entities/Creature/Creature.cpp
 *
 * The creature as a map object: identity (spawn id, entry, template), spawn data, map and grid membership, respawn
 * state, and visibility. `Unit` is not ported as a class yet, so the `Unit` members the grid layer reads (`UnitLike`)
 * are implemented here over the state that exists (death state, unit state, movement flags, speeds).
 *
 * Movement is ported here (`docs/movement-port.md`, integration section): the `Unit` members the `MotionMaster` and the spline layer
 * call (`GetMotionMaster`, `movespline`, `UpdateSplineMovement`, `StopMoving`, `SetFacingTo`, `SetWalk`, `SetSpeed`, `BuildMovementPacket`, ...),
 * `Creature::GetMovementTemplate`, `UpdateMovementFlags`, `Motion_Initialize`, `AIM_Initialize`, the waypoint and formation members.
 *
 * Out of scope here (other topics, each marked `@ac-skip <topic>` where the C++ calls into it): stats and power
 * (`SelectLevel` past the level, `UpdateStats`, ...: Stats), combat and threat (`CanStartAttack`, `GetAggroRange`, ...:
 * Combat), scripted AI (`FactorySelector::SelectAI`: AI),
 * loot (`loot`, `SetLootRecipient`: Loot), gossip and vendors (Gossip),
 * vehicles (`CreateVehicleKit`: Vehicles), spells and auras (`m_spells`, `Mount`, auras: Spells), script hooks
 * (`sScriptMgr`: Scripts), and `SaveToDB` / `DeleteFromDB` (World DB editing commands).
 *
 * The combat code keeps its own per-creature state (`CreatureUnit` in `src/combat/combat-world.ts`). `m_combatUnit` links
 * the two: while it is set, the death state and health are read from it, and the combat state reads the position and the
 * evade state from this creature (the `MotionMaster` moves it).
 */
import { creature_template } from "../../../database/schema/world.ts";
import type { CreatureTemplate } from "../../../data/world.ts";
import {
  UNIT_END,
  UNIT_FIELD_BOUNDINGRADIUS,
  UNIT_FIELD_BYTES_0,
  UNIT_FIELD_BYTES_1,
  UNIT_FIELD_BYTES_2,
  UNIT_FIELD_COMBATREACH,
  UNIT_FIELD_CRITTER,
  UNIT_FIELD_DISPLAYID,
  UNIT_FIELD_FLAGS,
  UNIT_FIELD_HEALTH,
  UNIT_FIELD_HOVERHEIGHT,
  UNIT_FIELD_LEVEL,
  UNIT_FIELD_NATIVEDISPLAYID,
  UNIT_FIELD_TARGET,
  UNIT_NPC_EMOTESTATE,
  UNIT_NPC_FLAGS,
  UNIT_VIRTUAL_ITEM_SLOT_ID,
} from "../../../gen/UpdateFields.gen.ts";
import { urand } from "../../../common/random.ts";
import { log, logError } from "../../../log.ts";
import { SERVERSIDE_VISIBILITY_GHOST } from "../../../shared/SharedDefines.ts";
import { ByteWriter } from "../../../net/byte-buffer.ts";
import {
  UNIT_FLAG_IN_COMBAT,
  UNIT_FLAG_SWIMMING,
  UNIT_STAND_STATE_KNEEL,
  UNIT_STAND_STATE_STAND,
  UNIT_STAND_STATE_SIT,
  UNIT_STAND_STATE_SIT_CHAIR,
  UNIT_STAND_STATE_SIT_HIGH_CHAIR,
  UNIT_STAND_STATE_SIT_LOW_CHAIR,
  UNIT_STAND_STATE_SIT_MEDIUM_CHAIR,
  UNIT_STAND_STATE_SLEEP,
  UNIT_STATE_ALL_STATE,
  UNIT_STATE_CANNOT_TURN,
  UNIT_STATE_EVADE,
  UNIT_STATE_IGNORE_PATHFINDING,
  UNIT_STATE_IN_FLIGHT,
  UNIT_STATE_MOVING,
  UNIT_STATE_NO_ENVIRONMENT_UPD,
  UNIT_STATE_POSSESSED,
  UNIT_STATE_ROOT,
  UNIT_STATE_STUNNED,
} from "../../../spells/enums.ts";
import type { CreatureUnit } from "../../../combat/combat-world.ts";
import { AddMovementGeneratorFactories } from "../../AI/CreatureAIRegistry.ts";
import { ReactorAI } from "../../AI/CoreAI/ReactorAI.ts";
import type { CreatureAI } from "../../AI/CreatureAI.ts";
import { AbstractFollower } from "../../Movement/AbstractFollower.ts";
import { ESCORT_MOTION_TYPE, MAX_MOTION_SLOT, MotionMaster } from "../../Movement/MotionMaster.ts";
import type { MovementCreatureAI, MovementObject, MovementOwner, MovementOwnerCreature } from "../../Movement/MovementOwner.ts";
import { MoveSpline } from "../../Movement/Spline/MoveSpline.ts";
import { MoveSplineInit } from "../../Movement/Spline/MoveSplineInit.ts";
import { PacketBuilder } from "../../Movement/Spline/MovementPacketBuilder.ts";
import {
  MOVE_FLIGHT,
  MOVE_FLIGHT_BACK,
  MOVE_PITCH_RATE,
  MOVE_RUN,
  MOVE_RUN_BACK,
  MOVE_SWIM,
  MOVE_SWIM_BACK,
  MOVE_TURN_RATE,
  MOVE_WALK,
  MOVEMENTFLAG2_ALWAYS_ALLOW_PITCHING,
  MOVEMENTFLAG2_INTERPOLATED_MOVEMENT,
  MOVEMENTFLAG_BACKWARD,
  MOVEMENTFLAG_CAN_FLY,
  MOVEMENTFLAG_DISABLE_GRAVITY,
  MOVEMENTFLAG_FALLING,
  MOVEMENTFLAG_FALLING_FAR,
  MOVEMENTFLAG_FLYING,
  MOVEMENTFLAG_FORWARD,
  MOVEMENTFLAG_HOVER,
  MOVEMENTFLAG_MASK_MOVING,
  MOVEMENTFLAG_ONTRANSPORT,
  MOVEMENTFLAG_ROOT,
  MOVEMENTFLAG_SPLINE_ELEVATION,
  MOVEMENTFLAG_SPLINE_ENABLED,
  MOVEMENTFLAG_SWIMMING,
  MOVEMENTFLAG_WALKING,
} from "../Unit/UnitDefines.ts";
import { GetCollisionHeight } from "../Unit/UnitCollision.ts";
import { IsFormationLeader, IsFormationLeaderMoveAllowed, Motion_Initialize, SearchFormation, SignalFormationMovement, sFormationMgr, type CreatureGroup } from "./CreatureGroups.ts";
import { CreatureFlightMovementType, CreatureGroundMovementType, type CreatureMovementData } from "./CreatureData.ts";
import { sObjectMgr } from "../../Globals/ObjectMgr.ts";
import type { GridPlayer, UnitLike } from "../../Grids/GridPlayer.ts";
import { AIRelocationNotifier, CreatureRelocationNotifier, type CreatureAILike } from "../../Grids/Notifiers/GridNotifiers.ts";
import { Cell } from "../../Grids/Cells/Cell.ts";
import { MAP_COMMON } from "../../DataStores/MapDBCStores.ts";
import { DynamicVisibilityMgr } from "../../Misc/DynamicVisibility.ts";
import { IsValidMapCoord } from "../../Grids/GridDefines.ts";
import { LIQUID_MAP_ABOVE_WATER, LIQUID_MAP_IN_WATER, LIQUID_MAP_UNDER_WATER, LIQUID_MAP_WATER_WALK, MAP_LIQUID_STATUS_IN_CONTACT } from "../../Grids/GridTerrainData.ts";
import { MAX_FALL_DISTANCE, type MapLike, type PositionFullTerrainStatusLike } from "../../Grids/MapLike.ts";
import { SPAWNGROUP_FLAG_COMPATIBILITY_MODE, type CreatureAddon, type CreatureData } from "../../Maps/SpawnData.ts";
import { getGameTime, getGameTimeMS } from "../../time/game-time.ts";
import { ServerConfig } from "../../world/world-config-data.ts";
import { sWorld } from "../../world/world.ts";
import { GHOST_VISIBILITY_ALIVE, GHOST_VISIBILITY_GHOST, NOTIFY_AI_RELOCATION, NOTIFY_VISIBILITY_CHANGED, WorldObject } from "../Object/Object.ts";
import { DEFAULT_COLLISION_HEIGHT, DEFAULT_WORLD_OBJECT_SIZE, NOMINAL_MELEE_RANGE, VisibilityDistanceType } from "../Object/ObjectDefines.ts";
import type { WorldPacket } from "../Object/Updates/UpdateData.ts";
import { HighGuid, ObjectGuid, TYPEID_UNIT, TYPEMASK_UNIT } from "../Object/ObjectGuid.ts";
import { Position } from "../Object/Position.ts";

/** @ac game/Entities/Unit/Unit.h DeathState */
export const DeathState = { Alive: 0, JustDied: 1, Corpse: 2, Dead: 3, JustRespawned: 4 } as const;
export type DeathState = (typeof DeathState)[keyof typeof DeathState];

/** @ac game/Movement/MotionMaster.h MovementGeneratorType (the values the DB uses) */
export const IDLE_MOTION_TYPE = 0;
export const RANDOM_MOTION_TYPE = 1;
export const WAYPOINT_MOTION_TYPE = 2;
export const MAX_DB_MOTION_TYPE = 3;

/** @ac game/Movement/MotionMaster.h VISUAL_WAYPOINT */
export const VISUAL_WAYPOINT = 1;

/** @ac game/Entities/Unit/UnitDefines.h ReactStates */
export const REACT_PASSIVE = 0;
export const REACT_DEFENSIVE = 1;
export const REACT_AGGRESSIVE = 2;

/** @ac shared/SharedDefines.h CreatureEliteType */
export const CREATURE_ELITE_NORMAL = 0;
export const CREATURE_ELITE_ELITE = 1;
export const CREATURE_ELITE_RAREELITE = 2;
export const CREATURE_ELITE_WORLDBOSS = 3;
export const CREATURE_ELITE_RARE = 4;

/** @ac shared/SharedDefines.h CreatureTypeFlags (the ones read here) */
export const CREATURE_TYPE_FLAG_VISIBLE_TO_GHOSTS = 0x00000002;
export const CREATURE_TYPE_FLAG_BOSS_MOB = 0x00000004;

/** @ac game/Entities/Creature/CreatureData.h CreatureFlagsExtra (the ones read here) */
export const CREATURE_FLAG_EXTRA_INSTANCE_BIND = 0x00000001;
export const CREATURE_FLAG_EXTRA_CIVILIAN = 0x00000002;
export const CREATURE_FLAG_EXTRA_TRIGGER = 0x00000080;
export const CREATURE_FLAG_EXTRA_GHOST_VISIBILITY = 0x00000400;
export const CREATURE_FLAG_EXTRA_GUARD = 0x00008000;
export const CREATURE_FLAG_EXTRA_AVOID_AOE = 0x00400000;
export const CREATURE_FLAG_EXTRA_IGNORE_PATHFINDING = 0x20000000;
export const CREATURE_FLAG_EXTRA_HARD_RESET = 0x80000000;

/** @ac shared/DataStores/DBCEnums.h Difficulty::RAID_DIFFICULTY_10MAN_HEROIC */
const RAID_DIFFICULTY_10MAN_HEROIC = 2;
/** @ac game/Entities/Unit/UnitDefines.h UnitBytes1Offsets */
const UNIT_BYTES_1_OFFSET_STAND_STATE = 0;
const UNIT_BYTES_1_OFFSET_PET_TALENTS = 1;
const UNIT_BYTES_1_OFFSET_VIS_FLAG = 2;
const UNIT_BYTES_1_OFFSET_ANIM_TIER = 3;
/** @ac game/Entities/Creature/Creature.cpp CREATURE_MOVEMENT_FLAGS_REFRESH_DIST_SQ */
const CREATURE_MOVEMENT_FLAGS_REFRESH_DIST_SQ = 2.0 * 2.0;
/** @ac shared/SharedDefines.h GROUND_HEIGHT_TOLERANCE (extra tolerance to z position to check if it is in air or on ground) */
const GROUND_HEIGHT_TOLERANCE = Math.fround(0.05);
/** @ac game/Entities/Creature/CreatureData.h CreatureFlagsExtra::CREATURE_FLAG_EXTRA_NO_MOVE_FLAGS_UPDATE */
const CREATURE_FLAG_EXTRA_NO_MOVE_FLAGS_UPDATE = 0x00000200;
/** `SMSG_SPLINE_MOVE_*` / `MSG_MOVE_*` (3.3.5a `Opcodes.h`) the unit movement members send */
const MSG_MOVE_TELEPORT = 0x0c5;
const MSG_MOVE_HEARTBEAT = 0x0ee;
const SMSG_SPLINE_MOVE_SET_HOVER = 0x307;
const SMSG_SPLINE_MOVE_UNSET_HOVER = 0x308;
const SMSG_SPLINE_MOVE_START_SWIM = 0x30b;
const SMSG_SPLINE_MOVE_STOP_SWIM = 0x30c;
const SMSG_SPLINE_MOVE_SET_RUN_MODE = 0x30d;
const SMSG_SPLINE_MOVE_SET_WALK_MODE = 0x30e;
const SMSG_SPLINE_MOVE_SET_FLYING = 0x422;
const SMSG_SPLINE_MOVE_UNSET_FLYING = 0x423;
const SMSG_SPLINE_MOVE_GRAVITY_DISABLE = 0x4d3;
const SMSG_SPLINE_MOVE_GRAVITY_ENABLE = 0x4d4;
/** `SetSpeed2Opc_table[mtype][NPC]`: `SMSG_SPLINE_SET_*_SPEED` / `_TURN_RATE` / `_PITCH_RATE` by `UnitMoveType` */
const SPLINE_SET_SPEED_OPCODES = [0x301, 0x2fe, 0x2ff, 0x300, 0x302, 0x303, 0x385, 0x386, 0x45e];
/** @ac game/Entities/Unit/Unit.cpp baseMoveSpeed */
export const baseMoveSpeed = [2.5, 7.0, 4.5, 4.722222, 2.5, 3.141594, 7.0, 4.5, 3.14];
/** @ac game/Entities/Unit/UnitDefines.h MAX_MOVE_TYPE */
const MAX_MOVE_TYPE = 9;
/** @ac game/Entities/Creature/Creature.h MAX_CREATURE_SPELLS */
export const MAX_CREATURE_SPELLS = 8;
/** @ac shared/SharedDefines.h DAY */
const DAY = 86400;
/** @ac shared/SharedDefines.h MINUTE */
const MINUTE = 60;

/**
 * `Map` members the spawn objects call that `MapLike` does not list yet (the Map port provides them; each call site
 * skips the call when the member is missing):
 * `GetObjectsStore().Insert/Remove`, `GetGameObjectBySpawnIdStore`, `AddToMap`, the respawn time stores,
 * `GetLinkedRespawnTime`, `ApplyDynamicModeRespawnScaling`, `ScheduleCreatureRespawn`, and the `MapEntry` kind checks.
 * `GetCreatureBySpawnIdStore()` must return a real `Map` for the insert and erase to land.
 */
export interface MapObjectStoresLike {
  /** @ac game/Maps/Map.h Map::GetObjectsStore (`Insert<T>(guid, obj)` / `Remove<T>(guid)`) */
  getObjectsStore(): { insert(guid: bigint, obj: WorldObject): void; remove(guid: bigint): void };
  /** @ac game/Maps/Map.h Map::GetGameObjectBySpawnIdStore */
  getGameObjectBySpawnIdStore(): ReadonlyMap<number, readonly WorldObject[]>;
  /** @ac game/Maps/Map.cpp Map::AddToMap */
  addToMap(obj: WorldObject): boolean;
  /** @ac game/Maps/Map.cpp Map::SaveCreatureRespawnTime */
  saveCreatureRespawnTime(dbGuid: number, respawnTime: number): void;
  /** @ac game/Maps/Map.cpp Map::RemoveCreatureRespawnTime */
  removeCreatureRespawnTime(dbGuid: number): void;
  /** @ac game/Maps/Map.cpp Map::SaveGORespawnTime */
  saveGORespawnTime(dbGuid: number, respawnTime: number): void;
  /** @ac game/Maps/Map.cpp Map::GetLinkedRespawnTime */
  getLinkedRespawnTime(guid: bigint): number;
  /** @ac game/Maps/Map.cpp Map::ApplyDynamicModeRespawnScaling */
  applyDynamicModeRespawnScaling(obj: WorldObject, respawnDelay: number): number;
  /** @ac game/Maps/Map.cpp Map::ScheduleCreatureRespawn */
  scheduleCreatureRespawn(guid: bigint, respawnTimer: number): void;
  /** @ac game/Maps/Map.h Map::IsRaid */
  isRaid(): boolean;
}

/** The optional `MapObjectStoresLike` side of a map. */
export function mapStores(map: MapLike | null): Partial<MapObjectStoresLike> {
  return (map ?? {}) as Partial<MapObjectStoresLike>;
}

/** `std::unordered_multimap<LowType, T*>::insert` on the map's by-spawn-id store (when it is a real `Map`). */
export function multimapInsert<T>(store: ReadonlyMap<number, readonly T[]> | undefined, key: number, value: T): void {
  if (!(store instanceof Map)) return;
  const list = store.get(key) ?? [];
  store.set(key, [...list, value]);
}

/** @ac common/Utilities/Containers.h Acore::Containers::MultimapErasePair */
export function multimapErasePair<T>(store: ReadonlyMap<number, readonly T[]> | undefined, key: number, value: T): void {
  if (!(store instanceof Map)) return;
  const list = store.get(key);
  if (!list) return;
  const index = list.indexOf(value);
  if (index < 0) return;
  const next = list.filter((_: T, i: number) => i !== index);
  if (next.length === 0) store.delete(key);
  else store.set(key, next);
}

/** The `creature_template` columns `CreatureTemplate` (`src/data/world.ts`) does not carry yet. */
export function creatureTemplateRow(entry: number) {
  return sObjectMgr.worldTables()?.first(creature_template, "entry", entry) ?? null;
}

/** @ac game/Entities/Creature/CreatureData.h CreatureTemplate::DifficultyEntry */
function difficultyEntries(entry: number): [number, number, number] {
  const row = creatureTemplateRow(entry);
  return row ? [row.difficulty_entry_1, row.difficulty_entry_2, row.difficulty_entry_3] : [0, 0, 0];
}

/**
 * What the combat code wants to know when a creature comes into or leaves a map (it links the creature to its live state; see
 * `m_combatUnit`).
 */
export const CreatureWorldHooks: { added: ((creature: Creature) => void) | null; removed: ((creature: Creature) => void) | null } = {
  added: null,
  removed: null,
};

/** @ac game/Entities/Creature/Creature.h Creature */
export class Creature extends WorldObject implements UnitLike {
  // Unit state the grid layer reads (`Unit` members)
  /** @ac game/Entities/Unit/Unit.h Unit::m_deathState */
  protected m_deathState: DeathState = DeathState.Alive;
  /** @ac game/Entities/Unit/Unit.h Unit::m_state */
  protected m_state = 0;
  /** @ac game/Entities/Unit/Unit.h Unit::m_speed_rate */
  protected readonly m_speed_rate = new Array<number>(MAX_MOVE_TYPE).fill(1.0);
  /** @ac game/Entities/Unit/Unit.h Unit::m_last_notify_mstime */
  m_last_notify_mstime = 0;
  /** @ac game/Entities/Unit/Unit.h Unit::m_delayed_unit_relocation_timer */
  m_delayed_unit_relocation_timer = 0;
  /** @ac game/Entities/Unit/Unit.h Unit::m_delayed_unit_ai_notify_timer */
  m_delayed_unit_ai_notify_timer = 0;
  /** @ac game/Entities/Unit/Unit.h Unit::m_last_notify_position */
  readonly m_last_notify_position = new Position();
  /** @ac game/Entities/Unit/Unit.h Unit::IsAIEnabled (set by `AIM_Initialize`) */
  IsAIEnabled = false;
  /** @ac game/Entities/Unit/Unit.h Unit::i_AI (a `ReactorAI`: `FactorySelector::SelectAI` is not ported) */
  i_AI: CreatureAILike | null = null;
  /** @ac game/Entities/Unit/Unit.h Unit::movespline */
  readonly movespline = new MoveSpline();
  /** @ac game/Entities/Unit/Unit.h Unit::i_motionMaster */
  protected readonly i_motionMaster: MotionMaster;
  /** @ac game/Entities/Unit/Unit.h Unit::m_followingMe */
  protected readonly m_followingMe = new Set<AbstractFollower>();
  /** @ac game/Entities/Creature/Creature.h Creature::m_formation */
  protected m_formation: CreatureGroup | null = null;
  /** @ac game/Entities/Creature/Creature.h Creature::_currentWaypointNodeInfo */
  protected _currentWaypointNodeInfo: [number, number] = [0, 0];
  /** @ac game/Entities/Creature/Creature.h Creature::m_cannotReachTarget */
  protected m_cannotReachTarget = 0n;
  /** @ac game/Entities/Creature/Creature.h Creature::_isMissingSwimmingFlagOutOfCombat */
  protected _isMissingSwimmingFlagOutOfCombat = false;
  /** where UpdateMovementFlags() last ran while wandering (swim/fly flag refresh cadence) @ac game/Entities/Creature/Creature.h Creature::LastMovementFlagsPos */
  readonly LastMovementFlagsPos = new Position();

  /**
   * The low guid of a creature loaded from `creature` (`ObjectMgr::GetCreatureData`): null generates one per map
   * (`Map::GenerateLowGuid`, as the C++ does). The world code addresses a creature by `entry << 24 | spawn id` (combat, gossip,
   * vendors, loot), so the integration sets it to the spawn id.
   */
  static dbGuidLow: ((spawnId: number) => number) | null = null;

  /** The combat code's state for this creature (`CombatWorld.liveUnit`); death state and health are read from it. */
  m_combatUnit: CreatureUnit | null = null;

  /** @ac game/Entities/Creature/Creature.h Creature::m_SightDistance */
  m_SightDistance: number;
  /** @ac game/Entities/Creature/Creature.h Creature::m_CombatDistance */
  m_CombatDistance = 0.0;
  /** @ac game/Entities/Creature/Creature.h Creature::m_spells */
  readonly m_spells = new Array<number>(MAX_CREATURE_SPELLS).fill(0);

  protected _respawnCompatibilityMode = true;
  /** (secs) timer for death or corpse disappearance */
  protected m_corpseRemoveTime = 0;
  /** (secs) time of next respawn */
  protected m_respawnTime = 0;
  /** (secs) time when creature respawned */
  protected m_respawnedTime = 0;
  /** (secs) delay between corpse disappearance and respawning */
  protected m_respawnDelay = 300;
  /** (secs) delay between death and corpse disappearance */
  protected m_corpseDelay = 60;
  protected m_wanderDistance = 0.0;
  protected m_reactState = REACT_AGGRESSIVE;
  protected m_defaultMovementType = IDLE_MOTION_TYPE;
  /** For new or temporary creatures is 0 for saved it is lowguid */
  protected m_spawnId = 0;
  protected m_equipmentId = 0;
  /** can be -1 */
  protected m_originalEquipmentId = 0;
  protected m_regenHealth = true;
  protected m_originalEntry = 0;
  protected m_moveInLineOfSightDisabled = false;
  protected m_moveInLineOfSightStrictlyDisabled = false;
  protected readonly m_homePosition = new Position();
  protected readonly m_transportHomePosition = new Position();
  /** in difficulty mode > 0 can different from sObjectMgr->GetCreatureTemplate(GetEntry()) */
  protected m_creatureInfo: CreatureTemplate | null = null;
  protected m_creatureData: CreatureData | null = null;
  protected CachedScriptId = 0;
  protected CachedScriptIdEntry = 0;
  protected m_detectionDistance = 20.0;
  protected m_path_id = 0;
  protected m_waypointID = 0;
  protected TriggerJustRespawned = true;

  /** @ac game/Entities/Creature/Creature.cpp Creature::Creature */
  constructor() {
    super();
    this.m_objectType |= TYPEMASK_UNIT;
    this.m_objectTypeId = TYPEID_UNIT;
    this.m_valuesCount = UNIT_END;
    this.m_SightDistance = sWorld().getFloatConfig(ServerConfig.CONFIG_SIGHT_MONSTER);
    this.m_CombatDistance = 0.0;
    this.TriggerJustRespawned = true;
    this.m_respawnedTime = 0;
    this.i_motionMaster = new MotionMaster(this.asMovementOwner());
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::AddToWorld */
  override addToWorld(): void {
    ///- Register the creature for guid lookup
    if (!this.isInWorld()) {
      // pussywizard: motion master needs to be initialized before OnCreatureCreate, which may set death state to JUST_DIED, to prevent crash
      // it's also initialized in AIM_Initialize(), few lines below, but it's not a problem
      this.motion_Initialize();

      mapStores(this.getMap()).getObjectsStore?.().insert(this.getGUID(), this);
      if (this.m_spawnId) {
        multimapInsert(this.getMap().getCreatureBySpawnIdStore(), this.m_spawnId, this);
      }
      super.addToWorld();
      CreatureWorldHooks.added?.(this);

      this.searchFormation();

      this.AIM_Initialize();
      // @ac-skip Vehicles: GetVehicleKit()->Install()

      this.getZoneScript()?.onCreatureCreate(this);

      // @ac-skip Loot: loot.sourceWorldObjectGUID = GetGUID()
      // @ac-skip Scripts: sScriptMgr->OnCreatureAddWorld(this)
    }
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::RemoveFromWorld */
  override removeFromWorld(): void {
    if (this.isInWorld()) {
      // @ac-skip Scripts: sScriptMgr->OnCreatureRemoveWorld(this)

      this.getZoneScript()?.onCreatureRemove(this);

      if (this.m_formation) sFormationMgr().removeCreatureFromGroup(this.m_formation, this.asMovementOwner());
      // @ac-skip Transports: transport->RemovePassenger(this, true)

      CreatureWorldHooks.removed?.(this);
      // Unit::RemoveFromWorld
      if (this.IsAIEnabled) (this.i_AI as CreatureAI | null)?.OnDespawn();
      this.removeAllFollowers();
      super.removeFromWorld();

      if (this.m_spawnId) multimapErasePair(this.getMap().getCreatureBySpawnIdStore(), this.m_spawnId, this);

      mapStores(this.getMap()).getObjectsStore?.().remove(this.getGUID());
    }
  }

  /**
   * @ac game/Entities/Unit/Unit.cpp Unit::CleanupBeforeRemoveFromMap (`GetMotionMaster()->Clear(false)`: the non-standard generators go, and
   * the followers they registered with their targets unregister)
   */
  override cleanupsBeforeDelete(finalCleanup = true): void {
    super.cleanupsBeforeDelete(finalCleanup);
    this.getMotionMaster().clear(false);
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::DisappearAndDie */
  disappearAndDie(): void {
    this.destroyForVisiblePlayers();
    if (this.isAlive()) this.setDeathState(DeathState.JustDied, true);
    this.removeCorpse(false, true);
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::SearchFormation */
  searchFormation(): void {
    SearchFormation(this.asMovementOwner());
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::RemoveCorpse */
  removeCorpse(setSpawnTime = true, skipVisibility = false): void {
    if (this.getDeathState() !== DeathState.Corpse) return;

    if (this._respawnCompatibilityMode) {
      this.m_corpseRemoveTime = getGameTime();
      this.setDeathState(DeathState.Dead);
      // @ac-skip Spells: RemoveAllAuras()
      if (!skipVisibility) this.destroyForVisiblePlayers(); // pussywizard: previous UpdateObjectVisibility()
      // @ac-skip Loot: loot.clear()
      const respawnDelay = this.m_respawnDelay;
      // @ac-skip AI: if (IsAIEnabled) AI()->CorpseRemoved(respawnDelay)

      // Should get removed later, just keep "compatibility" with scripts
      if (setSpawnTime) this.m_respawnTime = getGameTime() + respawnDelay;

      this.relocateToRespawnPosition();

      if (this.isFalling()) this.stopMoving();
    } else {
      // Dynamic spawn mode: save respawn time and remove the object entirely.
      // A fresh creature will be spawned by ProcessRespawns() when the timer expires.
      // @ac-skip Loot: loot.clear()
      const respawnDelay = this.m_respawnDelay;
      // @ac-skip AI: if (IsAIEnabled) AI()->CorpseRemoved(respawnDelay)

      // m_respawnTime was already set in setDeathState(JustDied).
      if (setSpawnTime) this.m_respawnTime = Math.max(getGameTime() + respawnDelay, this.m_respawnTime);
      this.saveRespawnTime();

      this.addObjectToRemoveList();
    }
  }

  /** The compatibility mode part of `Creature::RemoveCorpse`: the corpse goes back to the spawn position (home and position). */
  relocateToRespawnPosition(): void {
    const pos = this.getRespawnPosition();
    this.setHomePosition(pos.x, pos.y, pos.z, pos.o);
    this.setPosition(pos.x, pos.y, pos.z, pos.o);

    // xinef: relocate notifier
    this.m_last_notify_position.relocate(-5000.0, -5000.0, -5000.0, 0.0);
  }

  /**
   * @ac game/Entities/Creature/Creature.cpp Creature::InitEntry
   * change the entry of creature until respawn
   */
  initEntry(Entry: number, data: CreatureData | null = null): boolean {
    const normalInfo = sObjectMgr.getCreatureTemplate(Entry);
    if (!normalInfo) {
      logError("sql", `Creature::InitEntry creature entry ${Entry} does not exist.`);
      return false;
    }

    // get difficulty 1 mode entry
    // Xinef: Skip for pets!
    let cinfo: CreatureTemplate = normalInfo;
    const difficulty = difficultyEntries(Entry);
    for (let diff = this.getMap().getSpawnMode(); diff > 0; ) {
      // we already have valid Map pointer for current creature!
      const difficultyEntry = difficulty[diff - 1] ?? 0;
      if (difficultyEntry) {
        const found = sObjectMgr.getCreatureTemplate(difficultyEntry);
        if (found) {
          cinfo = found;
          break; // template found
        }
        // check and reported at startup, so just ignore (restore normalInfo)
        cinfo = normalInfo;
      }

      // for instances heroic to normal, other cases attempt to retrieve previous difficulty
      if (diff >= RAID_DIFFICULTY_10MAN_HEROIC && mapStores(this.getMap()).isRaid?.()) diff -= 2; // to normal raid difficulty cases
      else --diff;
    }

    this.setEntry(Entry); // normal entry always
    this.m_creatureInfo = cinfo; // map mode related always
    this.CachedScriptIdEntry = 0; // force GetScriptId() to re-resolve for this (re)init

    // equal to player Race field, but creature does not have race
    this.setByteValue(UNIT_FIELD_BYTES_0, 0, 0);

    // known valid are: CLASS_WARRIOR, CLASS_PALADIN, CLASS_ROGUE, CLASS_MAGE
    this.setByteValue(UNIT_FIELD_BYTES_0, 1, cinfo.unitClass);

    // Cancel load if no model defined
    const model = cinfo.models.find((row) => row.displayId > 0);
    if (!model) {
      logError("sql", `Creature (Entry: ${Entry}) has no model defined in table \`creature_template_model\`, can't load. `);
      return false;
    }

    // @ac-skip Display: ObjectMgr::ChooseDisplayId and GetCreatureModelRandomGender (the first valid model is used)
    this.setDisplayId(model.displayId, model.scale > 0 ? model.scale : 1.0);
    this.setNativeDisplayId(model.displayId);

    // Load creature equipment
    if (!data) {
      this.loadEquipment(); // use default from the template
    } else if (data.equipmentId === 0) {
      this.loadEquipment(0); // 0 means no equipment for creature table
    } else {
      this.m_originalEquipmentId = data.equipmentId;
      this.loadEquipment(data.equipmentId);
    }

    this.setName(normalInfo.name); // at normal entry always

    this.setSpeed(MOVE_WALK, cinfo.speedWalk);
    this.setSpeed(MOVE_RUN, cinfo.speedRun);
    this.setSpeed(MOVE_SWIM, cinfo.speedSwim);
    this.setSpeed(MOVE_FLIGHT, cinfo.speedFlight);
    // @ac-skip Spells: UNIT_MOD_CAST_SPEED

    this.setObjectScale(model.scale > 0 ? model.scale : 1.0); // `GetNativeObjectScale()`

    this.setFloatValue(UNIT_FIELD_HOVERHEIGHT, cinfo.hoverHeight);

    // @ac-skip Combat: SetDualWieldMode for CREATURE_FLAG_EXTRA_USE_OFFHAND_ATTACK

    // checked at loading
    this.m_defaultMovementType = creatureTemplateRow(cinfo.entry)?.MovementType ?? IDLE_MOTION_TYPE;
    if (!this.m_wanderDistance && this.m_defaultMovementType === RANDOM_MOTION_TYPE) this.m_defaultMovementType = IDLE_MOTION_TYPE;

    // @ac-skip Spells: m_spells from creature_template_spell
    // @ac-skip Combat: GetThreatMgr().Initialize()

    return true;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::SetObjectScale (the bounding radius and combat reach of the display's model info) */
  override setObjectScale(scale: number): void {
    super.setObjectScale(scale);

    let combatReach = DEFAULT_WORLD_OBJECT_SIZE;

    const minfo = this.getCreatureTemplate()?.models.find((row) => row.displayId === this.getDisplayId());
    if (minfo) {
      this.setFloatValue(UNIT_FIELD_BOUNDINGRADIUS, (this.isPet() ? 1.0 : minfo.boundingRadius) * scale);
      if (minfo.combatReach > 0) combatReach = minfo.combatReach;
    }

    this.setFloatValue(UNIT_FIELD_COMBATREACH, combatReach * scale);
  }

  /**
   * @ac game/Entities/Creature/Creature.cpp Creature::UpdateEntry
   * The faction, flags, stats, and immunities that follow `InitEntry` belong to Stats/Combat (@ac-skip).
   */
  updateEntry(Entry: number, data: CreatureData | null = null, _changelevel = true, _updateAI = false): boolean {
    if (!this.initEntry(Entry, data)) return false;

    const cInfo = this.getCreatureTemplate();
    if (!cInfo) return false;
    this.setUInt32Value(UNIT_NPC_FLAGS, data?.npcflag || cInfo.npcFlags);
    this.selectLevel(_changelevel);
    this.updateMoveInLineOfSightState();

    // Update movement
    // @ac-skip Spells: `if (IsRooted()) SetControlled(true, UNIT_STATE_ROOT)`: the root state is the spell unit's
    this.updateMovementFlags();
    return true;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::GetRandomId */
  getRandomId(id1: number, id2: number, id3: number): number {
    let id = id1;
    let ids = 0;

    if (id2) {
      ++ids;
      if (id3) ++ids;
    }

    if (ids) {
      const idNumber = urand(0, ids);
      switch (idNumber) {
        case 0:
          id = id1;
          break;
        case 1:
          id = id2;
          break;
        case 2:
          id = id3;
          break;
      }
    }

    return id;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::Create */
  create(guidlow: number, map: MapLike, phaseMask: number, Entry: number, vehId: number, x: number, y: number, z: number, ang: number, data: CreatureData | null = null): boolean {
    this.setMap(map);
    this.setPhaseMask(phaseMask, false);

    const cinfo = sObjectMgr.getCreatureTemplate(Entry);
    if (!cinfo) {
      logError("sql", `Creature::Create(): creature template (guidlow: ${guidlow}, entry: ${Entry}) does not exist.`);
      return false;
    }

    //! Relocate before CreateFromProto, to initialize coords and allow
    //! returning correct zone id for selecting OutdoorPvP/Battlefield script
    this.relocate(x, y, z, ang);

    if (!this.isPositionValid()) {
      logError("world", `Creature::Create(): given coordinates for creature (guidlow ${guidlow}, entry ${Entry}) are not valid (X: ${x}, Y: ${y}, Z: ${z}, O: ${ang})`);
      return false;
    }

    // area/zone id is needed immediately for ZoneScript::GetCreatureEntry hook before it is known which creature template to load (no model/scale available yet)
    const terrainData = this.getMap().getFullTerrainStatusForPosition(this.getPhaseMask(), this.getPositionX(), this.getPositionY(), this.getPositionZ(), DEFAULT_COLLISION_HEIGHT);
    this.processPositionDataChanged(terrainData);

    if (!this.createFromProto(guidlow, Entry, vehId, data)) return false;

    this.updateMovementFlags();

    switch (this.getCreatureTemplate()?.rank) {
      case CREATURE_ELITE_RARE:
        this.m_corpseDelay = sWorld().getIntConfig(ServerConfig.CONFIG_CORPSE_DECAY_RARE);
        break;
      case CREATURE_ELITE_ELITE:
        this.m_corpseDelay = sWorld().getIntConfig(ServerConfig.CONFIG_CORPSE_DECAY_ELITE);
        break;
      case CREATURE_ELITE_RAREELITE:
        this.m_corpseDelay = sWorld().getIntConfig(ServerConfig.CONFIG_CORPSE_DECAY_RAREELITE);
        break;
      case CREATURE_ELITE_WORLDBOSS:
        // Xinef: Reduce corpse delay for bossess outside of instance
        if (!this.getInstanceId()) this.m_corpseDelay = sWorld().getIntConfig(ServerConfig.CONFIG_CORPSE_DECAY_ELITE) * 2;
        else this.m_corpseDelay = sWorld().getIntConfig(ServerConfig.CONFIG_CORPSE_DECAY_WORLDBOSS);
        break;
      default:
        this.m_corpseDelay = sWorld().getIntConfig(ServerConfig.CONFIG_CORPSE_DECAY_NORMAL);
        break;
    }

    // @ac-skip Display: GetCreatureModelRandomGender (the other-gender model swap)

    this.loadCreaturesAddon();
    // @ac-skip Combat: LoadSparringPct()

    //! Need to be called after LoadCreaturesAddon - MOVEMENTFLAG_HOVER is set there
    this.m_positionZ += this.getHoverHeight();

    // @ac-skip Scripts: LastUsedScriptID = GetScriptId()

    const flagsExtra = creatureTemplateRow(Entry)?.flags_extra ?? 0;
    // @ac-skip Gossip: IsSpiritHealer() / IsSpiritGuide() (npc flags) join the ghost visibility branch below
    if (flagsExtra & CREATURE_FLAG_EXTRA_GHOST_VISIBILITY) {
      this.m_serverSideVisibility.setValue(SERVERSIDE_VISIBILITY_GHOST, GHOST_VISIBILITY_GHOST);
      this.m_serverSideVisibilityDetect.setValue(SERVERSIDE_VISIBILITY_GHOST, GHOST_VISIBILITY_GHOST);
    } else if (cinfo.typeFlags & CREATURE_TYPE_FLAG_VISIBLE_TO_GHOSTS) {
      // Xinef: Add ghost visibility for ghost units
      this.m_serverSideVisibility.setValue(SERVERSIDE_VISIBILITY_GHOST, GHOST_VISIBILITY_ALIVE | GHOST_VISIBILITY_GHOST);
      this.m_serverSideVisibilityDetect.setValue(SERVERSIDE_VISIBILITY_GHOST, GHOST_VISIBILITY_ALIVE | GHOST_VISIBILITY_GHOST);
    }
    // @ac-skip Display: if (Entry == VISUAL_WAYPOINT) SetVisible(false) (UNIT_FLAG visibility is the Unit topic)

    if (flagsExtra & CREATURE_FLAG_EXTRA_IGNORE_PATHFINDING) this.addUnitState(UNIT_STATE_IGNORE_PATHFINDING);

    return true;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::CreateFromProto */
  createFromProto(guidlow: number, Entry: number, vehId: number, data: CreatureData | null = null): boolean {
    this.setZoneScript();
    const zoneScript = this.getZoneScript();
    if (zoneScript && data) {
      const FirstEntry = zoneScript.getCreatureEntry(guidlow, data);
      if (!FirstEntry) return false;
    }

    const normalInfo = sObjectMgr.getCreatureTemplate(Entry);
    if (!normalInfo) {
      logError("sql", `Creature::CreateFromProto(): creature template (guidlow: ${guidlow}, entry: ${Entry}) does not exist.`);
      return false;
    }

    this.setOriginalEntry(Entry);

    const vehicleId = creatureTemplateRow(Entry)?.VehicleId ?? 0;
    this._Create(guidlow, Entry, vehId || vehicleId ? HighGuid.Vehicle : HighGuid.Unit);

    // @ac-skip Vehicles: select the difficulty vehicle id and CreateVehicleKit

    if (!this.updateEntry(Entry, data)) return false;

    return true;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::LoadCreatureFromDB */
  loadCreatureFromDB(spawnId: number, map: MapLike, addToMap = true, allowDuplicate = false): boolean {
    if (!allowDuplicate) {
      // If an alive instance of this spawnId is already found, skip creation
      // If only dead instance(s) exist, despawn them and spawn a new (maybe also dead) version
      const creatureBounds = map.getCreatureBySpawnIdStore().get(spawnId) ?? [];
      const despawnList: Creature[] = [];

      for (const other of creatureBounds) {
        if (other.isAlive()) {
          log("maps", `Would have spawned ${spawnId} but ${ObjectGuid.ToString(creatureBounds[0]!.getGUID())} already exists`);
          return false;
        }
        despawnList.push(other);
        log("maps", `Despawned dead instance of spawn ${spawnId} (${ObjectGuid.ToString(other.getGUID())})`);
      }

      for (const despawnCreature of despawnList) despawnCreature.addObjectToRemoveList();
    }

    const data = sObjectMgr.getSpawnCreatureData(spawnId);
    if (!data) {
      logError("sql", `Creature (SpawnId: ${spawnId}) not found in table \`creature\`, can't load. `);
      return false;
    }

    // xinef: this has to be assigned before Create function, properly loads equipment id from DB
    this.m_creatureData = data;
    this.m_spawnId = spawnId;

    // Set respawn compatibility mode based on spawn group flags
    const groupData = sObjectMgr.getSpawnGroupData(data.spawnGroupId);
    this._respawnCompatibilityMode =
      sWorld().getBoolConfig(ServerConfig.CONFIG_RESPAWN_FORCE_COMPATIBILITY_MODE) || !groupData || (groupData.flags & SPAWNGROUP_FLAG_COMPATIBILITY_MODE) !== 0;

    // Add to world
    const entry = this.getRandomId(data.id, data.id2, data.id3);

    if (!this.create(Creature.dbGuidLow ? Creature.dbGuidLow(spawnId) : map.generateLowGuid(HighGuid.Unit), map, data.phaseMask, entry, 0, data.posX, data.posY, data.posZ, data.orientation, data)) return false;

    //We should set first home position, because then AI calls home movement
    this.setHomePosition(data.posX, data.posY, data.posZ, data.orientation);

    this.m_wanderDistance = data.wander_distance;

    this.m_respawnDelay = data.spawntimesecs;
    this.m_deathState = DeathState.Alive;

    this.m_respawnTime = this.getMap().getCreatureRespawnTime(this.m_spawnId);
    if (this.m_respawnTime) {
      // respawn on Update
      this.m_deathState = DeathState.Dead;
      if (this.canFly()) {
        const tz = map.getHeight(this.getPhaseMask(), data.posX, data.posY, data.posZ, true, MAX_FALL_DISTANCE);
        if (data.posZ - tz > 0.1 && IsValidMapCoord(tz)) this.relocate(data.posX, data.posY, tz);
      }
    }

    let curhealth: number;
    if (!this.m_regenHealth) {
      curhealth = data.curhealth;
      // @ac-skip Stats: curhealth * _GetHealthMod(rank) and SetPower(POWER_MANA, data->curmana)
      if (curhealth && curhealth < 1) curhealth = 1;
    } else {
      curhealth = this.getMaxHealth();
      // @ac-skip Stats: SetPower(POWER_MANA, GetMaxPower(POWER_MANA))
    }

    this.setUInt32Value(UNIT_FIELD_HEALTH, this.m_deathState === DeathState.Alive ? curhealth : 0);

    // @ac-skip Combat: ResetPlayerDamageReq()

    // checked at creature_template loading
    this.m_defaultMovementType = data.movementType;

    if (addToMap && !this.addToMapHelper()) return false;
    return true;
  }

  /**
   * @ac game/Entities/Creature/Creature.h Creature::LoadFromDB
   * `LoadFromDB(guid, map, allowDuplicate)` is `LoadCreatureFromDB(guid, map, false, allowDuplicate)`: the creature is
   * built but not added to the map (the grid loader adds it to its grid and then to the world).
   */
  loadFromDB(spawnId: number, map: MapLike, allowDuplicate = false): boolean {
    return this.loadCreatureFromDB(spawnId, map, false, allowDuplicate);
  }

  /** `GetMap()->AddToMap(this)` through the Map port (false when the map has no `AddToMap`). */
  private addToMapHelper(): boolean {
    const add = mapStores(this.getMap()).addToMap;
    if (!add) {
      logError("maps", `Creature ${this.m_spawnId}: the map has no AddToMap`);
      return false;
    }
    return add.call(this.getMap(), this);
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::SelectLevel (the level; health, power, and stats are @ac-skip Stats) */
  selectLevel(changelevel = true): void {
    const cInfo = this.getCreatureTemplate();
    if (!cInfo) return;

    // level
    const minlevel = Math.min(cInfo.maxLevel, cInfo.minLevel);
    const maxlevel = Math.max(cInfo.maxLevel, cInfo.minLevel);
    const level = minlevel === maxlevel ? minlevel : urand(minlevel, maxlevel);

    // @ac-skip Scripts: sScriptMgr->OnBeforeCreatureSelectLevel

    if (changelevel) this.setUInt32Value(UNIT_FIELD_LEVEL, level);
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::LoadEquipment */
  loadEquipment(id = 1, force = false): void {
    if (id === 0) {
      if (force) {
        for (let i = 0; i < 3; ++i) this.setUInt32Value(UNIT_VIRTUAL_ITEM_SLOT_ID + i, 0);
        this.m_equipmentId = 0;
      }
      return;
    }

    // ObjectMgr::GetEquipmentInfo (`id == -1` picks a random set)
    const sets = this.getCreatureTemplate()?.equipment ?? sObjectMgr.getCreatureTemplate(this.getEntry())?.equipment ?? [];
    const einfo = id === -1 ? (sets.length ? sets[urand(0, sets.length - 1)] : undefined) : sets.find((set) => set.id === id);
    if (!einfo) return;

    this.m_equipmentId = einfo.id;
    for (let i = 0; i < 3; ++i) this.setUInt32Value(UNIT_VIRTUAL_ITEM_SLOT_ID + i, einfo.items[i] ?? 0);
  }

  /**
   * @ac game/Entities/Creature/Creature.cpp Creature::Update
   * The death state machine: a dead creature respawns when `m_respawnTime` has passed, a corpse is removed when
   * `m_corpseRemoveTime` has passed (`getDeathState()` reads the linked combat state first, like the rest of this class).
   * While the combat code has state for this creature (`m_combatUnit`) it owns the corpse and respawn timers, so the two
   * timer branches are skipped; `Unit::Update` (spline and motion) runs for the alive and corpse states as in the C++.
   * @ac-skip AI: `IsAIEnabled && TriggerJustRespawned` -> AI()->JustRespawned(); the combat part of the alive branch (threat
   * manager update, charm AI switch, combat pulse, boundary check, leash extension, assistance timer, `i_AI->UpdateAI(diff)`)
   * is driven from `src/combat/combat-world.ts`; health and power regeneration are the combat code's too.
   */
  override update(diff: number): void {
    switch (this.getDeathState()) {
      case DeathState.JustRespawned:
        // Must not be called, see Creature::setDeathState JUST_RESPAWNED -> ALIVE promoting.
        logError("world", `Creature (${ObjectGuid.ToString(this.getGUID())}) in wrong state: DeathState::JustRespawned (4)`);
        break;
      case DeathState.JustDied:
        // Must not be called, see Creature::setDeathState JUST_DIED -> CORPSE promoting.
        logError("world", `Creature (${ObjectGuid.ToString(this.getGUID())}) in wrong state: DeathState::JustDead (1)`);
        break;
      case DeathState.Dead: {
        if (this.m_combatUnit) break; // the combat world respawns it
        const now = getGameTime();
        if (this.m_respawnTime <= now) this.respawn();
        break;
      }
      case DeathState.Corpse:
        this.unitUpdate(diff); // Unit::Update
        // deathstate changed on spells update, prevent problems
        if (this.getDeathState() !== DeathState.Corpse) break;
        if (this.m_combatUnit) break; // the combat world removes the corpse

        // @ac-skip Loot: `m_groupLootTimer && lootingGroupLowGUID` -> Group::EndRoll
        if (this.m_corpseRemoveTime <= getGameTime()) this.removeCorpse(false);
        break;
      case DeathState.Alive:
        this.unitUpdate(diff); // Unit::Update

        // creature can be dead after Unit::Update call
        // CORPSE/DEAD state will processed at next tick (in other case death timer will be updated unexpectedly)
        if (!this.isAlive()) break;

        // Swim / fly / hover flags are only refreshed inside UpdatePositionData(), which
        // Map::CreatureRelocation() throttles for a plain wandering creature. Drive them here: as
        // soon as it comes to rest, or once it has moved far enough that its liquid / floor state
        // could have changed.
        if (this.isPositionDataUpdatePending() && (!this.isMoving() || this.getExactDistSq(this.LastMovementFlagsPos) >= CREATURE_MOVEMENT_FLAGS_REFRESH_DIST_SQ)) {
          this.updatePositionData(); // -> ProcessPositionDataChanged() -> UpdateMovementFlags() re-baselines LastMovementFlagsPos
        }
        break;
      default:
        break;
    }

    if (this.isInWorld()) {
      // @ac-skip Transport: `GetOwnerGUID().IsPlayer()` -> Map::GetTransportForPos, AddPassenger / RemovePassenger
      // @ac-skip Scripts: sScriptMgr->OnCreatureUpdate(this, diff)
    }
  }

  /**
   * @ac game/Entities/Unit/Unit.cpp Unit::Update (`WorldObject::Update`, the delayed relocation timers, then the spline and the motion master)
   * @ac-skip Spells: `_UpdateSpells`, the combat timer, `m_combatManager.Update`, the attack timers, reactives and aura states are the combat
   * world's and the spell unit's.
   */
  protected unitUpdate(diff: number): void {
    super.update(diff);

    if (!this.isInWorld()) return;

    // pussywizard:
    if (this.m_delayed_unit_relocation_timer) {
      if (this.m_delayed_unit_relocation_timer <= diff) {
        this.m_delayed_unit_relocation_timer = 0;
        //ExecuteDelayedUnitRelocationEvent();
        (this.findMap() as unknown as { i_objectsForDelayedVisibility: Set<unknown> }).i_objectsForDelayedVisibility.add(this);
      } else this.m_delayed_unit_relocation_timer -= diff;
    }
    if (this.m_delayed_unit_ai_notify_timer) {
      if (this.m_delayed_unit_ai_notify_timer <= diff) {
        this.m_delayed_unit_ai_notify_timer = 0;
        this.executeDelayedUnitAINotifyEvent();
      } else this.m_delayed_unit_ai_notify_timer -= diff;
    }

    this.updateSplineMovement(diff);
    this.getMotionMaster().updateMotion(diff);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::ExecuteDelayedUnitRelocationEvent (the creature part: the creature's move is shown to the players around it) */
  executeDelayedUnitRelocationEvent(): void {
    this.removeFromNotify(NOTIFY_VISIBILITY_CHANGED);
    if (!this.isInWorld()) return;

    if (!this.isPositionValid()) return;

    const dx = this.m_last_notify_position.getPositionX() - this.getPositionX();
    const dy = this.m_last_notify_position.getPositionY() - this.getPositionY();
    const dz = this.m_last_notify_position.getPositionZ() - this.getPositionZ();
    const distsq = dx * dx + dy * dy + dz * dz;
    const mindistsq = DynamicVisibilityMgr.GetReqMoveDistSq(this.findMap()?.getEntry()?.map_type ?? MAP_COMMON);
    if (distsq < mindistsq) return;

    this.m_last_notify_position.relocate(this.getPositionX(), this.getPositionY(), this.getPositionZ());

    const relocate = new CreatureRelocationNotifier(this);
    Cell.visitObjects(this, relocate, this.getVisibilityRange());

    this.addToNotify(NOTIFY_AI_RELOCATION);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::ExecuteDelayedUnitAINotifyEvent */
  executeDelayedUnitAINotifyEvent(): void {
    this.removeFromNotify(NOTIFY_AI_RELOCATION);
    if (!this.isInWorld()) return;

    const notifier = new AIRelocationNotifier(this as unknown as UnitLike);
    const radius = 60.0;
    Cell.visitObjects(this, notifier, radius);
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::IsInvisibleDueToDespawn */
  override isInvisibleDueToDespawn(): boolean {
    if (super.isInvisibleDueToDespawn()) return true;

    // the combat code owns the corpse and respawn timers of a creature it has state for: its corpse is gone when it is "dead"
    if (this.m_combatUnit) return this.m_combatUnit.deathState === "dead";

    if (this.isAlive() || this.isDying() || this.m_corpseRemoveTime > getGameTime()) return false;

    return true;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::CanAlwaysSee (@ac-skip AI: `AI()->CanSeeAlways`) */
  override canAlwaysSee(_obj: WorldObject): boolean {
    return false;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::IsAlwaysDetectableFor (@ac-skip AI: `AI()->CanAlwaysBeDetectable`) */
  override isAlwaysDetectableFor(seer: WorldObject): boolean {
    if (super.isAlwaysDetectableFor(seer)) return true;
    return false;
  }

  /**
   * @ac game/Entities/Creature/Creature.cpp Creature::setDeathState
   * @ac game/Entities/Unit/Unit.cpp Unit::setDeathState (the state change)
   * The respawn and corpse timers. Target, npc flags, mount, formation, fall, and the respawn reset of flags and auras
   * belong to Combat/Movement/Spells (@ac-skip).
   */
  setDeathState(state: DeathState, _despawn = false): void {
    this.m_deathState = state;

    if (state === DeathState.JustDied) {
      this.m_corpseRemoveTime = getGameTime() + this.m_corpseDelay;
      const scale = mapStores(this.getMap()).applyDynamicModeRespawnScaling;
      const dynamicRespawnDelay = scale ? scale.call(this.getMap(), this, this.m_respawnDelay) : this.m_respawnDelay;
      this.m_respawnTime = getGameTime() + dynamicRespawnDelay + this.m_corpseDelay;

      // always save boss respawn time at death to prevent crash cheating
      if (this.getMap().isDungeon() || this.isWorldBoss() || (this.getCreatureTemplate()?.rank ?? 0) >= CREATURE_ELITE_ELITE) this.saveRespawnTime();

      this.setUInt32Value(UNIT_NPC_FLAGS, 0);

      this.m_deathState = DeathState.Corpse;
    } else if (state === DeathState.JustRespawned) {
      this.setUInt32Value(UNIT_FIELD_HEALTH, this.getMaxHealth());

      // pussywizard:
      if (this.hasUnitMovementFlag(MOVEMENTFLAG_FALLING)) this.m_movementInfo.removeMovementFlag(MOVEMENTFLAG_FALLING);

      this.setCannotReachTarget();

      const cinfo = this.getCreatureTemplate();
      this.updateMovementFlags();
      if (cinfo) this.setUInt32Value(UNIT_NPC_FLAGS, cinfo.npcFlags);
      this.clearUnitState((UNIT_STATE_ALL_STATE & ~(UNIT_STATE_IGNORE_PATHFINDING | UNIT_STATE_NO_ENVIRONMENT_UPD)) >>> 0);

      this.m_deathState = DeathState.Alive;

      this.motion_Initialize();
      this.loadCreaturesAddon(true);

      const data = this.getCreatureData();
      if (data && this.getPhaseMask() !== data.phaseMask) this.setPhaseMask(data.phaseMask, false);
    }
    if (this.m_combatUnit) {
      this.m_combatUnit.deathState = this.m_deathState === DeathState.Alive ? "alive" : this.m_deathState === DeathState.Corpse ? "corpse" : "dead";
    }
  }

  /**
   * @ac game/Entities/Creature/Creature.cpp Creature::Respawn
   * @param force Force the respawn by killing the creature.
   */
  respawn(force = false): void {
    if (force) {
      if (this.isAlive()) this.setDeathState(DeathState.JustDied);
      else if (this.getDeathState() !== DeathState.Corpse) this.setDeathState(DeathState.Corpse);
    }

    // @ac-skip Conditions: CONDITION_SOURCE_TYPE_CREATURE_RESPAWN (the condition system is not ported, so it always passes)
    // @ac-skip AI: AI()->CanRespawn()

    const dbtableHighGuid = ObjectGuid.Make(HighGuid.Unit, this.m_creatureData ? this.m_creatureData.id : this.getEntry(), this.m_spawnId);
    const linked = mapStores(this.getMap()).getLinkedRespawnTime;
    const linkedRespawntime = linked ? linked.call(this.getMap(), dbtableHighGuid) : 0;

    const hardReset = ((creatureTemplateRow(this.getEntry())?.flags_extra ?? 0) & CREATURE_FLAG_EXTRA_HARD_RESET) !== 0;

    if (!linkedRespawntime || hardReset || force) {
      // Should respawn
      if (this._respawnCompatibilityMode) {
        this.removeCorpse(false, false);

        if (this.getDeathState() === DeathState.Dead) {
          if (this.m_spawnId) {
            mapStores(this.getMap()).removeCreatureRespawnTime?.call(this.getMap(), this.m_spawnId);
            const data = sObjectMgr.getSpawnCreatureData(this.m_spawnId);
            // Respawn check if spawn has 2 entries
            if (data?.id2) {
              const entry = this.getRandomId(data.id, data.id2, data.id3);
              this.updateEntry(entry, data, true); // Select Random Entry
              this.m_defaultMovementType = data.movementType; // Reload Movement Type
              this.loadEquipment(data.equipmentId); // Reload Equipment
              // @ac-skip AI: AIM_Initialize()
            } else if (this.m_originalEntry !== this.getEntry()) {
              this.updateEntry(this.m_originalEntry);
            }
          }

          log("world", `Respawning creature ${this.getName()} (SpawnId: ${this.getSpawnId()}, ${ObjectGuid.ToString(this.getGUID())})`);
          this.m_respawnTime = 0;
          // @ac-skip Loot: ResetPickPocketLootTime() and loot.clear()
          this.selectLevel();

          this.m_respawnedTime = getGameTime();
          this.setDeathState(DeathState.JustRespawned);

          // @ac-skip Display: the respawn model choice (GetCreatureModelRandomGender) unless a transform aura is up
          this.getMotionMaster().initDefault();
          // @ac-skip AI: AI()->Reset(); TriggerJustRespawned = true
          // @ac-skip Pools: sPoolMgr->UpdatePool<Creature> (PoolMgr is not ported; the import resolves pools once)
          // @ac-skip Combat: InitializeReactState()
        }
        this.m_respawnedTime = getGameTime();
        // xinef: relocate notifier, fixes npc appearing in corpse position after forced respawn (instead of spawn)
        this.m_last_notify_position.relocate(-5000.0, -5000.0, -5000.0, 0.0);
        this.updateObjectVisibility(false);
      } else {
        // Non-compat mode: destroy and let ProcessRespawns() recreate
        if (this.isAlive()) return;

        if (this.m_spawnId) {
          // Set respawn time to now so ProcessRespawns() picks it up
          mapStores(this.getMap()).saveCreatureRespawnTime?.call(this.getMap(), this.m_spawnId, getGameTime());
        }
        this.addObjectToRemoveList();
      }
    } else {
      // the master is dead
      const targetGuid = sObjectMgr.getLinkedRespawnGuid(dbtableHighGuid);
      if (targetGuid === dbtableHighGuid) {
        // if linking self, never respawn (check delayed to next day)
        this.setRespawnTime(DAY);
      } else {
        const now = getGameTime();
        this.m_respawnTime = (now > linkedRespawntime ? now : linkedRespawntime) + urand(5, MINUTE); // else copy time from master and add a little
      }
      this.saveRespawnTime(); // also save to DB immediately
    }
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::ForcedDespawn (`Milliseconds` / `Seconds` are numbers) */
  forcedDespawn(timeMSToDespawn = 0, forceRespawnTimer = 0): void {
    if (timeMSToDespawn > 0) {
      // ForcedDespawnDelayEvent::Execute
      this.m_Events.addEventAtOffset(() => this.despawnOrUnsummon(0, forceRespawnTimer), timeMSToDespawn);
      return;
    }

    // Override respawn delay BEFORE setDeathState, because setDeathState(JustDied)
    // computes m_respawnTime = now + m_respawnDelay + m_corpseDelay and immediately
    // saves it to DB for bosses/elites. We must have the correct delay in place
    // before that happens.
    if (forceRespawnTimer > 0) this.m_respawnDelay = forceRespawnTimer;

    const wasAlive = this.isAlive();

    if (wasAlive) this.setDeathState(DeathState.JustDied, true);

    // Xinef: Set new respawn time, ignore corpse decay time...
    if (forceRespawnTimer > 0 || wasAlive) this.m_respawnTime = getGameTime() + this.m_respawnDelay;

    this.removeCorpse(true);

    // In compat mode the creature stays in the world as a dead body and needs
    // an event-based kick to call Respawn() after the timer expires.
    if (forceRespawnTimer > 0 && this._respawnCompatibilityMode) {
      const map = this.findMap();
      mapStores(map).scheduleCreatureRespawn?.call(map, this.getGUID(), forceRespawnTimer);
    }
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::DespawnOrUnsummon (@ac-skip TempSummon: summons are not ported) */
  despawnOrUnsummon(msTimeToDespawn = 0, forcedRespawnTimer = 0): void {
    this.forcedDespawn(msTimeToDespawn, forcedRespawnTimer);
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::SaveRespawnTime */
  override saveRespawnTime(): void {
    if (!this.m_spawnId || (this.m_creatureData && !this.m_creatureData.dbData)) return;

    mapStores(this.getMap()).saveCreatureRespawnTime?.call(this.getMap(), this.m_spawnId, this.m_respawnTime);
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetRespawnTime */
  getRespawnTime(): number {
    return this.m_respawnTime;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::GetRespawnTimeEx */
  getRespawnTimeEx(): number {
    const now = getGameTime();
    if (this.m_respawnTime > now) return this.m_respawnTime;
    return now;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::SetRespawnTime */
  setRespawnTime(respawn: number): void {
    this.m_respawnTime = respawn ? getGameTime() + respawn : 0;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetRespawnDelay */
  getRespawnDelay(): number {
    return this.m_respawnDelay;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::SetRespawnDelay */
  setRespawnDelay(delay: number): void {
    this.m_respawnDelay = delay;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::SetCorpseDelay */
  setCorpseDelay(delay: number): void {
    this.m_corpseDelay = delay;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetCorpseDelay */
  getCorpseDelay(): number {
    return this.m_corpseDelay;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::SetCorpseRemoveTime */
  setCorpseRemoveTime(delay: number): void {
    this.m_corpseRemoveTime = getGameTime() + delay;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::IsRespawnCompatibilityMode */
  isRespawnCompatibilityMode(): boolean {
    return this._respawnCompatibilityMode;
  }

  /**
   * @ac game/Entities/Creature/Creature.cpp Creature::GetRespawnPosition
   * The `float&` out parameters are the result: `{ x, y, z, o, dist }`.
   */
  getRespawnPosition(): { x: number; y: number; z: number; o: number; dist: number } {
    if (this.m_spawnId) {
      const data = sObjectMgr.getSpawnCreatureData(this.m_spawnId);
      if (data) return { x: data.posX, y: data.posY, z: data.posZ, o: data.orientation, dist: data.wander_distance };
    }

    // xinef: changed this from current position to home position, fixes world summons with infinite duration
    if (this.getTransport()) {
      return { x: this.getPositionX(), y: this.getPositionY(), z: this.getPositionZ(), o: this.getOrientation(), dist: 0 };
    }
    const homePos = this.getHomePosition();
    return { x: homePos.getPositionX(), y: homePos.getPositionY(), z: homePos.getPositionZ(), o: homePos.getOrientation(), dist: 0 };
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::SetPosition (`Map::CreatureRelocation` when the Map port has it) */
  setPosition(x: number, y: number, z: number, o: number): void {
    if (!IsValidMapCoord(x, y, z, o)) return;

    const map = this.getMap() as MapLike & { creatureRelocation?(creature: Creature, x: number, y: number, z: number, o: number): void };
    if (map.creatureRelocation) map.creatureRelocation(this, x, y, z, o);
    else this.relocate(x, y, z, o);
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::GetCreatureAddon */
  getCreatureAddon(): CreatureAddon | null {
    if (this.m_spawnId) {
      const addon = sObjectMgr.getCreatureAddon(this.m_spawnId);
      if (addon) return addon;
    }

    // dependent from difficulty mode entry
    const info = this.getCreatureTemplate();
    return info ? sObjectMgr.getCreatureTemplateAddon(info.entry) : null;
  }

  /**
   * @ac game/Entities/Creature/Creature.cpp Creature::LoadCreaturesAddon
   * creature_addon table. `Mount` and the auras are @ac-skip Spells.
   */
  loadCreaturesAddon(_reload = false): boolean {
    const cainfo = this.getCreatureAddon();
    if (!cainfo) return false;

    // @ac-skip Spells: if (cainfo->mount != 0) Mount(cainfo->mount)

    if (cainfo.bytes1 !== 0) {
      // 0 StandState
      // 1 FreeTalentPoints   Pet only, so always 0 for default creature
      // 2 StandFlags
      // 3 StandMiscFlags
      this.setByteValue(UNIT_FIELD_BYTES_1, UNIT_BYTES_1_OFFSET_STAND_STATE, cainfo.bytes1 & 0xff);
      this.setByteValue(UNIT_FIELD_BYTES_1, UNIT_BYTES_1_OFFSET_PET_TALENTS, 0);
      this.setByteValue(UNIT_FIELD_BYTES_1, UNIT_BYTES_1_OFFSET_VIS_FLAG, (cainfo.bytes1 >>> 16) & 0xff);
      this.setByteValue(UNIT_FIELD_BYTES_1, UNIT_BYTES_1_OFFSET_ANIM_TIER, (cainfo.bytes1 >>> 24) & 0xff);

      //! Suspected correlation between UNIT_FIELD_BYTES_1, offset 3, value 0x2:
      //! If no inhabittype_fly (if no MovementFlag_DisableGravity or MovementFlag_CanFly flag found in sniffs)
      //! Set MovementFlag_Hover. Otherwise do nothing.
      if (this.canHover()) this.m_movementInfo.addMovementFlag(MOVEMENTFLAG_HOVER);
    }

    if (cainfo.bytes2 !== 0) {
      // 0 SheathState
      // 1 Bytes2Flags
      // 2 UnitRename         Pet only, so always 0 for default creature
      // 3 ShapeshiftForm     Must be determined/set by shapeshift spell/aura
      this.setByteValue(UNIT_FIELD_BYTES_2, 0, cainfo.bytes2 & 0xff);
      this.setByteValue(UNIT_FIELD_BYTES_2, 2, 0);
      this.setByteValue(UNIT_FIELD_BYTES_2, 3, 0);
    }

    this.setUInt32Value(UNIT_NPC_EMOTESTATE, cainfo.emote);

    // Check if visibility distance different
    if (cainfo.visibilityDistanceType !== VisibilityDistanceType.Normal) {
      this.setVisibilityDistanceOverride(cainfo.visibilityDistanceType);
    }

    //Load Path
    if (cainfo.path_id !== 0) this.m_path_id = cainfo.path_id;

    // @ac-skip Spells: the addon auras (AddAura for each `cainfo->auras` entry)
    return true;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::GetScriptName */
  getScriptName(): string {
    return sObjectMgr.getScriptName(this.getScriptId());
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::GetScriptId */
  getScriptId(): number {
    const entry = this.getEntry();

    // Cache the resolved id per entry. Re-resolve whenever the entry changes.
    if (entry && this.CachedScriptIdEntry === entry) return this.CachedScriptId;

    let scriptId = 0;
    const creatureData = this.getCreatureData();
    if (creatureData && creatureData.ScriptId && entry === creatureData.id) scriptId = creatureData.ScriptId;

    if (!scriptId) scriptId = sObjectMgr.getScriptId(creatureTemplateRow(entry)?.ScriptName ?? "");

    this.CachedScriptId = scriptId;
    this.CachedScriptIdEntry = entry;
    return scriptId;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::IsUpdateNeeded */
  override isUpdateNeeded(): boolean {
    if (super.isUpdateNeeded()) return true;

    if (this.getMap().isCellMarked(this.getCurrentCell().getCellCoord().getId())) return true;

    // @ac-skip Combat: IsInCombat() (the combat code keeps the creature updated while it fights)
    if (this.m_combatUnit?.victim != null) return true;

    if (this.getObjectVisibilityContainer().getVisiblePlayersMap().size !== 0) return true;

    // @ac-skip TempSummon: ToTempSummon()
    if (this.getMotionMaster().hasMovementGeneratorType(WAYPOINT_MOTION_TYPE)) return true;

    if (this.hasUnitState(UNIT_STATE_EVADE)) return true;

    if (this.m_formation && this.m_formation.getLeader() !== (this as unknown)) return true;

    return false;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::getLevelForTarget (boss level support) */
  override getLevelForTarget(target: WorldObject): number {
    const unit = target.toUnit();
    if (!this.isWorldBoss() || !unit) return this.getLevel();

    const level = unit.getLevelForTarget(this) + sWorld().getIntConfig(ServerConfig.CONFIG_WORLD_BOSS_LEVEL_DIFF);
    if (level < 1) return 1;
    if (level > 255) return 255;
    return level;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::GetAttackDistance (the detect range auras are @ac-skip Spells) */
  getAttackDistance(player: UnitLike | null): number {
    const aggroRate = sWorld().getRate(ServerConfig.RATE_CREATURE_AGGRO);

    if (aggroRate === 0) return 0.0;

    if (!player) return 0.0;

    const playerLevel = player.getLevelForTarget(this);
    const creatureLevel = this.getLevelForTarget(player);

    let levelDiff = playerLevel - creatureLevel;

    // "The maximum Aggro Radius has a cap of 25 levels under. Example: A level 30 char has the same Aggro Radius of a level 5 char on a level 60 mob."
    if (levelDiff < -25) levelDiff = -25;

    // "The aggro radius of a mob having the same level as the player is roughly 20 yards"
    let retDistance = 20.0;

    // "Aggro Radius varies with level difference at a rate of roughly 1 yard/level"
    // radius grow if playlevel < creaturelevel
    retDistance -= levelDiff;

    // @ac-skip Spells: SPELL_AURA_MOD_DETECT_RANGE / SPELL_AURA_MOD_DETECTED_RANGE when creatureLevel + 5 <= CONFIG_MAX_PLAYER_LEVEL

    // "Minimum Aggro Radius for a mob seems to be combat range (5 yards)"
    if (retDistance < 5.0) retDistance = 5.0;

    return Math.fround(retDistance * aggroRate);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::CanSwim */
  private unitCanSwim(): boolean {
    // Mirror client behavior, if this method returns false then client will not use swimming animation and for players will apply gravity as if there was no water
    if (this.hasUnitFlag(0x00004000 /* UNIT_FLAG_CANNOT_SWIM */)) return false;
    if (this.hasUnitFlag(0x01000000 /* UNIT_FLAG_POSSESSED */) || this.hasUnitFlag(0x00000008 /* UNIT_FLAG_PLAYER_CONTROLLED */)) return true; // is player
    if (this.hasUnitFlag2(0x01000000 /* UNIT_FLAG2_UNUSED_6 */)) return false;
    if (this.hasUnitFlag(0x00000800 /* UNIT_FLAG_PET_IN_COMBAT */)) return true;
    return this.hasUnitFlag(0x00000010 /* UNIT_FLAG_RENAME */ | 0x00008000 /* UNIT_FLAG_SWIMMING */);
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::CanSwim (@ac-skip Pets: IsPet()) */
  canSwim(): boolean {
    if (this.unitCanSwim() || (!this.unitCanSwim() && !this.canFly())) return true;
    return false;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::CanFly */
  canFly(): boolean {
    return this.getMovementTemplate().isFlightAllowed() || this.isFlying();
  }

  /** @ac game/Entities/Creature/Creature.h Creature::CanHover */
  canHover(): boolean {
    return this.getMovementTemplate().Ground === CreatureGroundMovementType.Hover || this.isHovering();
  }

  /**
   * @ac game/Entities/Creature/Creature.cpp Creature::UpdateMoveInLineOfSightState
   * pussywizard: Updated at faction change, disable move in line of sight if actual faction is not hostile to anyone.
   * @ac-skip AI: the script / SmartAI / NullCreatureAI and faction hostility checks need the AI and faction topics;
   * the trigger and civilian part is ported.
   */
  updateMoveInLineOfSightState(): void {
    const flagsExtra = creatureTemplateRow(this.getEntry())?.flags_extra ?? 0;
    if (flagsExtra & (CREATURE_FLAG_EXTRA_TRIGGER | CREATURE_FLAG_EXTRA_CIVILIAN)) {
      this.m_moveInLineOfSightDisabled = true;
      this.m_moveInLineOfSightStrictlyDisabled = true;
      return;
    }
    this.m_moveInLineOfSightDisabled = false;
    this.m_moveInLineOfSightStrictlyDisabled = false;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::IsMoveInLineOfSightDisabled */
  isMoveInLineOfSightDisabled(): boolean {
    return this.m_moveInLineOfSightDisabled;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::IsMoveInLineOfSightStrictlyDisabled */
  isMoveInLineOfSightStrictlyDisabled(): boolean {
    return this.m_moveInLineOfSightStrictlyDisabled;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetSpawnId */
  getSpawnId(): number {
    return this.m_spawnId;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetCreatureTemplate */
  getCreatureTemplate(): CreatureTemplate | null {
    return this.m_creatureInfo;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetCreatureData */
  getCreatureData(): CreatureData | null {
    return this.m_creatureData;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetOriginalEntry */
  getOriginalEntry(): number {
    return this.m_originalEntry;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::SetOriginalEntry */
  setOriginalEntry(entry: number): void {
    this.m_originalEntry = entry;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetDefaultMovementType */
  getDefaultMovementType(): number {
    return this.m_defaultMovementType;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::SetDefaultMovementType */
  setDefaultMovementType(mgt: number): void {
    this.m_defaultMovementType = mgt;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::SetReactState */
  setReactState(state: number): void {
    this.m_reactState = state;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetReactState */
  getReactState(): number {
    return this.m_reactState;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::HasReactState */
  hasReactState(state: number): boolean {
    return this.m_reactState === state;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetWanderDistance */
  getWanderDistance(): number {
    return this.m_wanderDistance;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::SetWanderDistance */
  setWanderDistance(dist: number): void {
    this.m_wanderDistance = dist;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetWaypointPath */
  getWaypointPath(): number {
    return this.m_path_id;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetDetectionRange */
  getDetectionRange(): number {
    return this.m_detectionDistance;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::SetDetectionDistance */
  setDetectionDistance(dist: number): void {
    this.m_detectionDistance = dist;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::SetHomePosition */
  setHomePosition(xOrPos: number | Position, y = 0, z = 0, o = 0): void {
    if (typeof xOrPos === "number") this.m_homePosition.relocate(xOrPos, y, z, o);
    else this.m_homePosition.relocate(xOrPos);
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetHomePosition */
  getHomePosition(): Position {
    return this.m_homePosition;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetTransportHomePosition */
  getTransportHomePosition(): Position {
    return this.m_transportHomePosition;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetCurrentEquipmentId */
  getCurrentEquipmentId(): number {
    return this.m_equipmentId;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetOriginalEquipmentId */
  getOriginalEquipmentId(): number {
    return this.m_originalEquipmentId;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::HasFlagsExtra */
  hasFlagsExtra(flag: number): boolean {
    return ((creatureTemplateRow(this.m_creatureInfo?.entry ?? this.getEntry())?.flags_extra ?? 0) & flag) !== 0;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::IsCivilian */
  isCivilian(): boolean {
    return this.hasFlagsExtra(CREATURE_FLAG_EXTRA_CIVILIAN);
  }

  /** @ac game/Entities/Creature/Creature.h Creature::IsTrigger */
  isTrigger(): boolean {
    return this.hasFlagsExtra(CREATURE_FLAG_EXTRA_TRIGGER);
  }

  /** @ac game/Entities/Creature/Creature.h Creature::IsGuard */
  isGuard(): boolean {
    return this.hasFlagsExtra(CREATURE_FLAG_EXTRA_GUARD);
  }

  /** @ac game/Entities/Creature/Creature.h Creature::IsAvoidingAOE */
  isAvoidingAOE(): boolean {
    return this.hasFlagsExtra(CREATURE_FLAG_EXTRA_AVOID_AOE);
  }

  /** @ac game/Entities/Creature/Creature.h Creature::isWorldBoss (@ac-skip Pets: IsPet()) */
  isWorldBoss(): boolean {
    return ((this.m_creatureInfo?.typeFlags ?? 0) & CREATURE_TYPE_FLAG_BOSS_MOB) !== 0;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::isElite (@ac-skip Pets: IsPet()) */
  isElite(): boolean {
    const rank = this.m_creatureInfo?.rank ?? CREATURE_ELITE_NORMAL;
    return rank !== CREATURE_ELITE_NORMAL && rank !== CREATURE_ELITE_RARE;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::IsInEvadeMode */
  isInEvadeMode(): boolean {
    return this.hasUnitState(UNIT_STATE_EVADE);
  }

  /** @ac game/Entities/Creature/Creature.h Creature::AI (`AIM_Initialize` sets `i_AI` and `IsAIEnabled`) */
  ai(): MovementCreatureAI | null {
    return this.i_AI as MovementCreatureAI | null;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetVehicleKit (@ac-skip Vehicles) */
  getVehicleKit(): null {
    return null;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsImmuneToNPC */
  isImmuneToNPC(): boolean {
    return this.hasUnitFlag(0x00000200 /* UNIT_FLAG_IMMUNE_TO_NPC */);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsImmuneToPC */
  isImmuneToPC(): boolean {
    return this.hasUnitFlag(0x00000100 /* UNIT_FLAG_IMMUNE_TO_PC */);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsTotem (@ac-skip TempSummon: totems are summons, not ported) */
  isTotem(): boolean {
    return false;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::IsPermanentlyInvisibleCreature (the aura scan is @ac-skip Spells) */
  isPermanentlyInvisibleCreature(): boolean {
    return false;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::HasSharedVision (@ac-skip Spells: shared vision comes from auras) */
  hasSharedVision(): boolean {
    return false;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetSharedVisionList (@ac-skip Spells) */
  getSharedVisionList(): readonly GridPlayer[] {
    return [];
  }

  // ------------------------------------------------------------------ Unit movement (`Unit.h` / `Unit.cpp`)
  // `Unit` is not a class of this port: the members the movement code and the spline layer call live here with their
  // `Unit::` tags. `MovementOwnerCreature` (`Movement/MovementOwner.ts`) is what `MotionMaster` and the generators see.

  /** The creature as the narrow owner interface `MotionMaster`, the spline layer and the generators take. */
  asMovementOwner(): MovementOwnerCreature {
    return this as unknown as MovementOwnerCreature;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetMotionMaster */
  getMotionMaster(): MotionMaster {
    return this.i_motionMaster;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetAI */
  getAI(): MovementCreatureAI | null {
    return this.i_AI as MovementCreatureAI | null;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::FollowerAdded */
  followerAdded(f: AbstractFollower): void {
    this.m_followingMe.add(f);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::FollowerRemoved */
  followerRemoved(f: AbstractFollower): void {
    this.m_followingMe.delete(f);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::RemoveAllFollowers */
  removeAllFollowers(): void {
    while (this.m_followingMe.size > 0) {
      const follower = this.m_followingMe.values().next().value as AbstractFollower;
      follower.setTarget(null);
    }
  }

  /** @ac game/Entities/Unit/Unit.h Unit::isMoving */
  isMoving(): boolean {
    return this.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_MASK_MOVING);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsStopped */
  isStopped(): boolean {
    return !this.hasUnitState(UNIT_STATE_MOVING);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::AddUnitMovementFlag */
  addUnitMovementFlag(f: number): void {
    this.m_movementInfo.addMovementFlag(f);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::RemoveUnitMovementFlag */
  removeUnitMovementFlag(f: number): void {
    this.m_movementInfo.removeMovementFlag(f);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetUnitMovementFlags */
  getUnitMovementFlags(): number {
    return this.m_movementInfo.getMovementFlags();
  }

  /** @ac game/Entities/Unit/Unit.h Unit::SetUnitFlag */
  setUnitFlag(flags: number): void {
    this.setFlag(UNIT_FIELD_FLAGS, flags);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::RemoveUnitFlag */
  removeUnitFlag(flags: number): void {
    this.removeFlag(UNIT_FIELD_FLAGS, flags);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsFalling (`Unit.cpp`) */
  isFalling(): boolean {
    return this.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_FALLING | MOVEMENTFLAG_FALLING_FAR) || this.movespline.isFalling();
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsLevitating */
  isLevitating(): boolean {
    return this.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_DISABLE_GRAVITY);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::HasHoverAura (@ac-skip Spells: auras are the spell unit's) */
  hasHoverAura(): boolean {
    return false;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetCombatReach */
  override getCombatReach(): number {
    return this.getFloatValue(UNIT_FIELD_COMBATREACH);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetBoundaryRadius */
  getBoundaryRadius(): number {
    return this.getFloatValue(UNIT_FIELD_BOUNDINGRADIUS);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::GetCollisionHeight */
  override getCollisionHeight(): number {
    return GetCollisionHeight({ scale: this.getObjectScale(), nativeDisplayId: this.getNativeDisplayId(), mountDisplayId: 0 });
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetCritterGUID */
  getCritterGUID(): bigint {
    return this.getGuidValue(UNIT_FIELD_CRITTER);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetFollowAngle */
  getFollowAngle(): number {
    return Math.PI / 2;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::GetMeleeRange */
  getMeleeRange(target: MovementObject & { getCombatReach(): number }): number {
    const range = Math.fround(this.getCombatReach() + target.getCombatReach() + 4.0 / 3.0);
    return Math.max(range, NOMINAL_MELEE_RANGE);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::GetMeleeAttackPoint (@ac-skip Combat: `getAttackers()` is not tracked, so there is never a second attacker to fan around) */
  getMeleeAttackPoint(_attacker: unknown): Position | null {
    return null;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsPet (@ac-skip Pets: not ported) */
  isPet(): boolean {
    return false;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsGuardian (@ac-skip Pets: not ported) */
  isGuardian(): boolean {
    return false;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsSummon (@ac-skip TempSummon: not ported) */
  isSummon(): boolean {
    return false;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsVehicle (@ac-skip Vehicles: not ported) */
  isVehicle(): boolean {
    return false;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsImmobilizedState */
  isImmobilizedState(): boolean {
    return this.hasUnitState(UNIT_STATE_STUNNED | UNIT_STATE_ROOT);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetDirectTransport (@ac-skip Transports: not ported, a creature is never on one) */
  getDirectTransport(): null {
    return null;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::isPossessed */
  isPossessed(): boolean {
    return this.hasUnitState(UNIT_STATE_POSSESSED);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsControlledByPlayer (@ac-skip Pets: `m_ControlledByPlayer` is only set by charm and ownership) */
  isControlledByPlayer(): boolean {
    return false;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::IsClientControlled (a creature is never controlled by a client here) */
  isClientControlled(_exactClient: unknown = null): boolean {
    return false;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::GetCharmerOrOwnerPlayerOrPlayerItself (@ac-skip Pets: charm and ownership) */
  getCharmerOrOwnerPlayerOrPlayerItself(): null {
    return null;
  }

  /** @ac game/Entities/Creature/TemporarySummon.h TempSummon::GetSummonerUnit (@ac-skip TempSummon: not ported) */
  getSummonerUnit(): null {
    return null;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsStandState (`getStandState` is `UNIT_FIELD_BYTES_1` offset 0) */
  isStandState(): boolean {
    const s = this.getByteValue(UNIT_FIELD_BYTES_1, UNIT_BYTES_1_OFFSET_STAND_STATE);
    const sit = s === UNIT_STAND_STATE_SIT_CHAIR || s === UNIT_STAND_STATE_SIT_LOW_CHAIR || s === UNIT_STAND_STATE_SIT_MEDIUM_CHAIR || s === UNIT_STAND_STATE_SIT_HIGH_CHAIR || s === UNIT_STAND_STATE_SIT;
    return !sit && s !== UNIT_STAND_STATE_SLEEP && s !== UNIT_STAND_STATE_KNEEL;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SetStandState (@ac-skip Spells: `RemoveAurasWithInterruptFlags(AURA_INTERRUPT_FLAG_NOT_SEATED)`) */
  setStandState(state: number): void {
    this.setByteValue(UNIT_FIELD_BYTES_1, UNIT_BYTES_1_OFFSET_STAND_STATE, state);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::isInAccessiblePlaceFor */
  isInAccessiblePlaceFor(c: MovementOwnerCreature): boolean {
    // @ac-skip Maps: the Ring of Valor and Icecrown Citadel branches (battleground and transport state)
    // pussywizard: prevent any bugs by passengers exiting transports or normal creatures flying away
    if (c.getTransport() !== this.getTransport()) return false;

    const liquidStatus = this.getLiquidData().Status;
    const isInWater = (liquidStatus & MAP_LIQUID_STATUS_IN_CONTACT) !== 0;

    // In water or jumping in water
    if (isInWater || (liquidStatus === LIQUID_MAP_ABOVE_WATER && this.isFalling())) return c.canEnterWater();
    return c.canWalk() || c.canFly();
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::IsMovementPreventedByCasting (the creature's casts are the spell unit's) */
  isMovementPreventedByCasting(): boolean {
    return this.m_combatUnit?.spell?.isMovementPreventedByCasting() ?? false;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::CastStop (the creature's casts are the spell unit's) */
  castStop(exceptSpellId = 0, _withInstant = true): void {
    this.m_combatUnit?.spell?.castStop(exceptSpellId);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SetOrientation is `Position::SetOrientation`; the `Unit::SetInFront` body */
  setInFront(target: MovementObject): void {
    if (!this.hasUnitState(UNIT_STATE_CANNOT_TURN)) this.setOrientation(this.getAngle(target));
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SetFacingTo */
  setFacingTo(ori: number, _force = false): void {
    const init = new MoveSplineInit(this.asMovementOwner());
    init.moveTo(this.getPositionX(), this.getPositionY(), this.getPositionZ(), false);
    if (this.hasUnitMovementFlag(MOVEMENTFLAG_ONTRANSPORT) && this.getTransGUID()) init.disableTransportPathTransformations(); // It makes no sense to target global orientation
    init.setFacing(ori);
    init.launch();
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SetFacingToObject (`Milliseconds timed` is a number of milliseconds) */
  setFacingToObject(object: MovementObject, timed = 0): void {
    // never face when already moving
    if (!this.isStopped()) return;

    /// @todo figure out under what conditions creature will move towards object instead of facing it where it currently is.
    const init = new MoveSplineInit(this.asMovementOwner());
    init.moveTo(this.getPositionX(), this.getPositionY(), this.getPositionZ());
    init.setFacing(this.getAngle(object)); // when on transport, GetAngle will still return global coordinates (and angle) that needs transforming
    init.launch();

    if (timed > 0) {
      this.m_Events.addEventAtOffset(() => {
        if (this.isInWorld() && this.findMap() && this.isAlive() && !this.isInCombat()) this.setFacingTo(this.getHomePosition().getOrientation());
      }, timed);
    }
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::UpdateSplineMovement */
  updateSplineMovement(t_diff: number): void {
    if (this.movespline.finalized()) return;

    // xinef: process movementinform
    // this code cant be placed inside EscortMovementGenerator, because we cant delete active MoveGen while it is updated
    // (`SplineHandler`)
    this.movespline.updateState(t_diff, (result) => {
      if (
        result & (MoveSpline.Result_NextSegment | MoveSpline.Result_JustArrived) &&
        this.getMotionMaster().getCurrentMovementGeneratorType() === ESCORT_MOTION_TYPE &&
        this.movespline.getId() === this.getMotionMaster().getCurrentSplineId()
      ) {
        this.ai()?.MovementInform?.(ESCORT_MOTION_TYPE, this.movespline.currentPathIdx() - 1);
      }
    });
    // Xinef: Spline was cleared by StopMoving, return
    if (!this.movespline.initialized()) {
      this.disableSpline();
      return;
    }

    const arrived = this.movespline.finalized();

    if (arrived) {
      this.disableSpline();

      if (this.movespline.hasAnimation() && this.isAlive()) this.setAnimTier(this.movespline.getAnimationType());
    }

    // pussywizard: update always! not every 400ms, because movement generators need the actual position
    this.updateSplinePosition();
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::UpdateSplinePosition */
  updateSplinePosition(): void {
    const loc = this.movespline.computePosition();

    if (this.movespline.onTransport) {
      const pos = this.m_movementInfo.transport.pos;
      pos.relocate(loc.x, loc.y, loc.z, loc.orientation);
      // @ac-skip Transports: `TransportBase::CalculatePassengerPosition` (`getDirectTransport()` is always null)
    }

    // Xinef: if we had spline running update orientation along with position
    this.setPosition(loc.x, loc.y, loc.z, loc.orientation);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::DisableSpline */
  disableSpline(): void {
    this.m_movementInfo.removeMovementFlag(MOVEMENTFLAG_SPLINE_ENABLED | MOVEMENTFLAG_FORWARD | MOVEMENTFLAG_BACKWARD);
    this.movespline._Interrupt();
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::StopMoving */
  stopMoving(): void {
    this.clearUnitState(UNIT_STATE_MOVING);

    // not need send any packets if not in world or not moving
    if (!this.isInWorld()) return;

    if (this.movespline.finalized()) return;

    // Update position now since Stop does not start a new movement that can be updated later
    if (this.movespline.hasStarted()) this.updateSplinePosition();

    const init = new MoveSplineInit(this.asMovementOwner());
    init.stop();
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::StopMovingOnCurrentPos */
  stopMovingOnCurrentPos(): void {
    this.clearUnitState(UNIT_STATE_MOVING);

    // not need send any packets if not in world
    if (!this.isInWorld()) return;

    this.disableSpline(); // pussywizard: required so Launch() won't recalculate position from previous spline
    const init = new MoveSplineInit(this.asMovementOwner());
    init.moveTo(this.getPositionX(), this.getPositionY(), this.getPositionZ());
    init.setFacing(this.getOrientation());
    init.launch();
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::PauseMovement */
  pauseMovement(timer = 0, slot = 0): void {
    if (slot >= MAX_MOTION_SLOT) return;

    this.getMotionMaster().getMotionSlot(slot)?.pause(timer);

    this.stopMoving();
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::ResumeMovement */
  resumeMovement(timer = 0, slot = 0): void {
    if (slot >= MAX_MOTION_SLOT) return;

    this.getMotionMaster().getMotionSlot(slot)?.resume(timer);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::NearTeleportTo (the non-player branch) */
  nearTeleportTo(x: number, y: number, z: number, orientation: number, _casting = false): boolean {
    this.disableSpline();
    // SendTeleportPacket
    const oldPos = new Position(this.getPositionX(), this.getPositionY(), this.getPositionZ(), this.getOrientation());
    this.relocate(x, y, z, orientation);
    const data = new ByteWriter().writeBytes(this.getPackGUID());
    this.buildMovementPacket(data);
    this.relocate(oldPos);
    this.sendMessageToSet({ opcode: MSG_MOVE_TELEPORT, payload: data.toUint8Array() }, false);
    // UpdatePosition(x, y, z, orientation, true)
    this.setPosition(x, y, z, orientation);
    this.updateObjectVisibility();
    this.getMotionMaster().reinitializeMovement();
    return true;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SetAnimTier (`UNIT_FIELD_BYTES_1` offset 3) */
  setAnimTier(animTier: number): void {
    this.setByteValue(UNIT_FIELD_BYTES_1, UNIT_BYTES_1_OFFSET_ANIM_TIER, animTier);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::BuildMovementPacket */
  buildMovementPacket(data: ByteWriter): void {
    data.writeU32(this.getUnitMovementFlags()); // movement flags
    data.writeU16(this.m_movementInfo.getExtraMovementFlags()); // 2.3.0
    data.writeU32(getGameTimeMS()); // time / counter
    data.writeF32(this.getPositionX());
    data.writeF32(this.getPositionY());
    data.writeF32(this.getPositionZ());
    data.writeF32(this.getOrientation());

    // 0x00000200
    if (this.getUnitMovementFlags() & MOVEMENTFLAG_ONTRANSPORT) {
      // @ac-skip Transports / Vehicles: a creature is never on one here
      data.writeU8(0);
      data.writeF32(this.getTransOffsetX());
      data.writeF32(this.getTransOffsetY());
      data.writeF32(this.getTransOffsetZ());
      data.writeF32(this.getTransOffsetO());
      data.writeU32(this.getTransTime());
      data.writeU8(this.getTransSeat() & 0xff);
      if (this.m_movementInfo.getExtraMovementFlags() & MOVEMENTFLAG2_INTERPOLATED_MOVEMENT) data.writeU32(this.m_movementInfo.transport.time2);
    }

    // 0x02200000
    if (this.getUnitMovementFlags() & (MOVEMENTFLAG_SWIMMING | MOVEMENTFLAG_FLYING) || this.m_movementInfo.flags2 & MOVEMENTFLAG2_ALWAYS_ALLOW_PITCHING) data.writeF32(this.m_movementInfo.pitch);

    data.writeU32(this.m_movementInfo.fallTime);

    // 0x00001000
    if (this.getUnitMovementFlags() & MOVEMENTFLAG_FALLING) {
      data.writeF32(this.m_movementInfo.jump.zspeed);
      data.writeF32(this.m_movementInfo.jump.sinAngle);
      data.writeF32(this.m_movementInfo.jump.cosAngle);
      data.writeF32(this.m_movementInfo.jump.xyspeed);
    }

    // 0x04000000
    if (this.getUnitMovementFlags() & MOVEMENTFLAG_SPLINE_ELEVATION) data.writeF32(this.m_movementInfo.splineElevation);
  }

  /**
   * @ac game/Entities/Object/Object.cpp Object::BuildMovementUpdate (the `UPDATEFLAG_LIVING` part)
   * The movement block of the create block of this creature: the movement info, the nine speeds, and the current spline
   * while `MOVEMENTFLAG_SPLINE_ENABLED` is set (`PacketBuilder::WriteCreate`).
   */
  buildMovementUpdate(data: ByteWriter): void {
    this.buildMovementPacket(data);

    data.writeF32(this.getSpeed(MOVE_WALK));
    data.writeF32(this.getSpeed(MOVE_RUN));
    data.writeF32(this.getSpeed(MOVE_RUN_BACK));
    data.writeF32(this.getSpeed(MOVE_SWIM));
    data.writeF32(this.getSpeed(MOVE_SWIM_BACK));
    data.writeF32(this.getSpeed(MOVE_FLIGHT));
    data.writeF32(this.getSpeed(MOVE_FLIGHT_BACK));
    data.writeF32(this.getSpeed(MOVE_TURN_RATE));
    data.writeF32(this.getSpeed(MOVE_PITCH_RATE));

    // 0x08000000
    if (this.m_movementInfo.getMovementFlags() & MOVEMENTFLAG_SPLINE_ENABLED) PacketBuilder.writeCreate(this.movespline, data);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::BuildHeartBeatMsg */
  buildHeartBeatMsg(): WorldPacket {
    const data = new ByteWriter().writeBytes(this.getPackGUID());
    this.buildMovementPacket(data);
    return { opcode: MSG_MOVE_HEARTBEAT, payload: data.toUint8Array() };
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SendMovementFlagUpdate */
  sendMovementFlagUpdate(self = false): void {
    if (this.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_ROOT)) {
      // each case where this occurs has to be examined and reported and dealt with.
      logError("movement", `Attempted sending heartbeat with root flag for guid ${ObjectGuid.ToString(this.getGUID())}`);
      return;
    }

    this.sendMessageToSet(this.buildHeartBeatMsg(), self);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SetWalk (`Creature::SetWalk` sends the walk or run mode to the others) */
  setWalk(enable: boolean): boolean {
    if (enable === this.isWalking()) return false;

    if (enable) this.addUnitMovementFlag(MOVEMENTFLAG_WALKING);
    else this.removeUnitMovementFlag(MOVEMENTFLAG_WALKING);

    this.propagateSpeedChange();

    this.sendMessageToSet({ opcode: enable ? SMSG_SPLINE_MOVE_SET_WALK_MODE : SMSG_SPLINE_MOVE_SET_RUN_MODE, payload: new ByteWriter().writeBytes(this.getPackGUID()).toUint8Array() }, false);
    return true;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SetSwim (`Creature::SetSwim` sends the swim start or stop) */
  setSwim(enable: boolean): boolean {
    if (enable === this.hasUnitMovementFlag(MOVEMENTFLAG_SWIMMING)) return false;

    if (enable) {
      this.addUnitMovementFlag(MOVEMENTFLAG_SWIMMING);
      this.setUnitFlag(UNIT_FLAG_SWIMMING);
    } else {
      this.removeUnitMovementFlag(MOVEMENTFLAG_SWIMMING);
      this.removeUnitFlag(UNIT_FLAG_SWIMMING);
    }

    this.sendMessageToSet({ opcode: enable ? SMSG_SPLINE_MOVE_START_SWIM : SMSG_SPLINE_MOVE_STOP_SWIM, payload: new ByteWriter().writeBytes(this.getPackGUID()).toUint8Array() }, true);
    return true;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SetCanFly (a creature is never client controlled) */
  setCanFly(enable: boolean): void {
    if (enable) this.m_movementInfo.addMovementFlag(MOVEMENTFLAG_CAN_FLY);
    else this.m_movementInfo.removeMovementFlag(MOVEMENTFLAG_CAN_FLY);

    if (!this.isInWorld()) return; // is sent on add to map

    this.sendMessageToSet({ opcode: enable ? SMSG_SPLINE_MOVE_SET_FLYING : SMSG_SPLINE_MOVE_UNSET_FLYING, payload: new ByteWriter().writeBytes(this.getPackGUID()).toUint8Array() }, true);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SetDisableGravity (a creature is never client controlled) */
  setDisableGravity(enable: boolean): void {
    if (enable) this.m_movementInfo.addMovementFlag(MOVEMENTFLAG_DISABLE_GRAVITY);
    else this.m_movementInfo.removeMovementFlag(MOVEMENTFLAG_DISABLE_GRAVITY);

    if (!this.isInWorld()) return; // is sent on add to map

    this.sendMessageToSet({ opcode: enable ? SMSG_SPLINE_MOVE_GRAVITY_DISABLE : SMSG_SPLINE_MOVE_GRAVITY_ENABLE, payload: new ByteWriter().writeBytes(this.getPackGUID()).toUint8Array() }, true);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SetHover (a creature is never client controlled) */
  setHover(enable: boolean): void {
    if (enable) this.m_movementInfo.addMovementFlag(MOVEMENTFLAG_HOVER);
    else this.m_movementInfo.removeMovementFlag(MOVEMENTFLAG_HOVER);

    const hoverHeight = this.getHoverHeight();

    if (enable) {
      if (hoverHeight && this.getPositionZ() - this.getMap().getHeight(this.getPhaseMask(), this.getPositionX(), this.getPositionY(), this.getPositionZ()) < hoverHeight) {
        this.relocate(this.getPositionX(), this.getPositionY(), this.getPositionZ() + hoverHeight);
      }
    } else if (this.isAlive()) {
      const newZ0 = Math.max(this.getMap().getHeight(this.getPhaseMask(), this.getPositionX(), this.getPositionY(), this.getPositionZ()), this.getPositionZ() - hoverHeight);
      const newZ = this.updateAllowedPositionZ(this.getPositionX(), this.getPositionY(), newZ0);
      this.relocate(this.getPositionX(), this.getPositionY(), newZ);
    }

    if (!this.isInWorld()) return; // is sent on add to map

    this.sendMessageToSet({ opcode: enable ? SMSG_SPLINE_MOVE_SET_HOVER : SMSG_SPLINE_MOVE_UNSET_HOVER, payload: new ByteWriter().writeBytes(this.getPackGUID()).toUint8Array() }, true);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::propagateSpeedChange */
  propagateSpeedChange(): void {
    this.getMotionMaster().propagateSpeedChange();
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SetSpeed (`forced` sends `SMSG_SPLINE_SET_*_SPEED` to the others) */
  setSpeed(mtype: number, rate: number, forced = false): void {
    if (rate < 0) rate = 0.0;

    // Update speed only on change
    if (this.m_speed_rate[mtype] === Math.fround(rate)) return;

    this.m_speed_rate[mtype] = Math.fround(rate);

    this.propagateSpeedChange();

    if (forced) {
      const opcode = SPLINE_SET_SPEED_OPCODES[mtype];
      if (opcode !== undefined) this.sendMessageToSet({ opcode, payload: new ByteWriter().writeBytes(this.getPackGUID()).writeF32(this.getSpeed(mtype)).toUint8Array() }, true);
    }
  }

  /** @ac game/Entities/Unit/Unit.h Unit::SetSpeedRate */
  setSpeedRate(mtype: number, rate: number): void {
    this.setSpeed(mtype, rate, true);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::UpdateSpeed (@ac-skip Spells: the aura modifiers are the spell unit's; this applies the base rate) */
  updateSpeed(mtype: number, forced: boolean): void {
    const speed = this.m_combatUnit?.spell ? this.m_combatUnit.spell.speed(mtype) / (baseMoveSpeed[mtype] || 1) : (this.m_speed_rate[mtype] ?? 1.0);
    this.setSpeed(mtype, speed, forced);
  }

  // ------------------------------------------------------------------ Creature movement (`Creature.h` / `Creature.cpp`)

  /** @ac game/Entities/Creature/Creature.cpp Creature::GetMovementTemplate */
  getMovementTemplate(): CreatureMovementData {
    const movementOverride = sObjectMgr.getCreatureMovementOverride(this.m_spawnId);
    if (movementOverride) return movementOverride;

    return sObjectMgr.getCreatureTemplateMovement(this.m_creatureInfo?.entry ?? this.getEntry());
  }

  /** @ac game/Entities/Creature/Creature.h Creature::CanWalk */
  canWalk(): boolean {
    return this.getMovementTemplate().isGroundAllowed();
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::CanEnterWater */
  canEnterWater(): boolean {
    if (this.canSwim()) return true;

    return this.getMovementTemplate().isSwimAllowed();
  }

  /** @ac game/Entities/Creature/Creature.h Creature::IsRooted */
  isRooted(): boolean {
    return this.getMovementTemplate().isRooted();
  }

  /** @ac game/Entities/Creature/Creature.h Creature::HasSwimmingFlagOutOfCombat */
  hasSwimmingFlagOutOfCombat(): boolean {
    return !this._isMissingSwimmingFlagOutOfCombat;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::RefreshSwimmingFlag */
  refreshSwimmingFlag(recheck = false): void {
    if (!this._isMissingSwimmingFlagOutOfCombat || recheck) this._isMissingSwimmingFlagOutOfCombat = !this.hasUnitFlag(UNIT_FLAG_SWIMMING);

    // Check if the creature has UNIT_FLAG_SWIMMING and add it if it's missing
    // Creatures must be able to chase a target in water if they can enter water
    if (this._isMissingSwimmingFlagOutOfCombat && this.canEnterWater()) this.setUnitFlag(UNIT_FLAG_SWIMMING);
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::UpdateMovementFlags */
  updateMovementFlags(): void {
    // Track where the flags were last evaluated - Creature::Update() uses this as the throttle
    // baseline for a wandering creature (see Map::CreatureRelocation).
    this.LastMovementFlagsPos.relocate(this.getPositionX(), this.getPositionY(), this.getPositionZ());

    // Do not update movement flags if creature is controlled by a player (charm/vehicle)
    // @ac-skip Pets: `m_movedByPlayer` is never set

    const info = this.getCreatureTemplate();
    if (!info) return;

    // Creatures with CREATURE_FLAG_EXTRA_NO_MOVE_FLAGS_UPDATE should control MovementFlags in your own scripts
    if (this.hasFlagsExtra(CREATURE_FLAG_EXTRA_NO_MOVE_FLAGS_UPDATE)) return;

    const ground = this.getFloorZ();

    const canHover = this.canHover();
    const isInAir =
      this.getPositionZ() > ground + (canHover ? this.getFloatValue(UNIT_FIELD_HOVERHEIGHT) : 0.0) + GROUND_HEIGHT_TOLERANCE + 1e-5 ||
      this.getPositionZ() < ground - GROUND_HEIGHT_TOLERANCE - 1e-5; // Can be underground too, prevent the falling

    const movement = this.getMovementTemplate();
    if (movement.isFlightAllowed() && isInAir && !this.isFalling()) {
      if (movement.Flight === CreatureFlightMovementType.CanFly && !this.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_CAN_FLY)) this.setCanFly(true);
      else if (!this.isLevitating()) this.setDisableGravity(true);

      if (!this.hasHoverAura() && this.isHovering()) this.setHover(false);
    } else {
      if (this.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_CAN_FLY)) this.setCanFly(false);

      if (this.isLevitating()) this.setDisableGravity(false);

      if (this.isAlive() && (movement.Ground === CreatureGroundMovementType.Hover || this.hasHoverAura()) && !this.isHovering()) this.setHover(true);
    }

    if (!isInAir) this.removeUnitMovementFlag(MOVEMENTFLAG_FALLING);

    let swim = false;
    const liquidData = this.getLiquidData();
    switch (liquidData.Status) {
      case LIQUID_MAP_WATER_WALK:
      case LIQUID_MAP_IN_WATER:
        swim = this.getPositionZ() - liquidData.DepthLevel > this.getCollisionHeight() * 0.75; // Shallow water at ~75% of collision height
        break;
      case LIQUID_MAP_UNDER_WATER:
        swim = true;
        break;
      default:
        break;
    }

    this.setSwim(this.canSwim() && swim);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::ProcessPositionDataChanged (`WorldObject::ProcessPositionDataChanged` then `ProcessTerrainStatusUpdate`: `UpdateMovementFlags`) */
  protected override processPositionDataChanged(data: PositionFullTerrainStatusLike): void {
    super.processPositionDataChanged(data);
    this.updateMovementFlags();
    // @ac-skip Spells: the liquid auras and `RemoveAurasWithInterruptFlags` of `ProcessTerrainStatusUpdate` are for units controlled by a player
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetCurrentWaypointID */
  getCurrentWaypointID(): number {
    return this.m_waypointID;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::UpdateWaypointID */
  updateWaypointID(wpID: number): void {
    this.m_waypointID = wpID;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetCurrentWaypointInfo */
  getCurrentWaypointInfo(): readonly [number, number] {
    return this._currentWaypointNodeInfo;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::UpdateCurrentWaypointInfo */
  updateCurrentWaypointInfo(nodeId: number, pathId: number): void {
    this._currentWaypointNodeInfo = [nodeId, pathId];
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetFormation */
  getFormation(): CreatureGroup | null {
    return this.m_formation;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::SetFormation */
  setFormation(formation: CreatureGroup | null): void {
    this.m_formation = formation;
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::IsFormationLeader */
  isFormationLeader(): boolean {
    return IsFormationLeader(this.asMovementOwner());
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::SignalFormationMovement */
  signalFormationMovement(): void {
    SignalFormationMovement(this.asMovementOwner());
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::IsFormationLeaderMoveAllowed */
  isFormationLeaderMoveAllowed(): boolean {
    return IsFormationLeaderMoveAllowed(this.asMovementOwner());
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::Motion_Initialize */
  motion_Initialize(): void {
    // `AIRegistry::Initialize` runs at startup (`startMapSystem`); it changes nothing when called again
    AddMovementGeneratorFactories();
    Motion_Initialize(this.asMovementOwner());
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::AIM_Initialize (@ac-skip AI: `FactorySelector::SelectAI` is not ported, every creature gets a `ReactorAI`) */
  AIM_Initialize(): boolean {
    this.motion_Initialize();

    this.i_AI = new ReactorAI(this);
    this.IsAIEnabled = true;
    (this.i_AI as ReactorAI).InitializeAI();

    return true;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::SetTransportHomePosition */
  setTransportHomePosition(x: number, y: number, z: number, o: number): void {
    this.m_transportHomePosition.relocate(x, y, z, o);
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::SetCannotReachTarget */
  setCannotReachTarget(cannotReach = 0n): void {
    if (cannotReach === this.m_cannotReachTarget) return;

    this.m_cannotReachTarget = cannotReach;
    // @ac-skip Combat: `m_cannotReachTimer` and the evade boundary check that reads it (`Creature::Update`)
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetCannotReachTarget */
  getCannotReachTarget(): bigint {
    return this.m_cannotReachTarget;
  }

  /** @ac game/Entities/Creature/Creature.h Creature::SetNoCallAssistance (@ac-skip Combat: the combat world keeps `alreadyCalledAssistance`) */
  setNoCallAssistance(val: boolean): void {
    this.m_combatUnit?.host.creatureSetNoCallAssistance(this.m_combatUnit, val);
  }

  /** @ac game/Entities/Creature/Creature.cpp Creature::CallAssistance */
  callAssistance(): void {
    this.m_combatUnit?.host.creatureCallAssistance(this.m_combatUnit);
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetCombatManager (@ac-skip Combat: `CombatManager::SetEvadeState`; `UNIT_STATE_EVADE` is the evade state here) */
  getCombatManager(): { setEvadeState(state: number): void } {
    return { setEvadeState: (_state) => {} };
  }

  /**
   * @ac game/Entities/Creature/Creature.cpp Creature::AtEngage (the movement parts: stand up, the swimming flag, and the home position of a
   * creature that follows a path: it returns to where it engaged)
   * @ac-skip Spells: `Dismount()`; pets, guardians and `OwnerAttackedBy`
   */
  atEngage(_target: unknown = null): void {
    if (!this.isStandState()) this.setStandState(UNIT_STAND_STATE_STAND);

    this.refreshSwimmingFlag();

    const movetype = this.getMotionMaster().getCurrentMovementGeneratorType();
    if (movetype === WAYPOINT_MOTION_TYPE || movetype === ESCORT_MOTION_TYPE) this.setHomePosition(this.getPosition());
  }

  /** @ac game/Entities/Creature/Creature.h Creature::GetAttackTime (`WeaponAttackType`) */
  getAttackTime(att: number): number {
    const unit = this.m_combatUnit;
    if (!unit) return this.getCreatureTemplate() ? 2000 : 0;
    return unit.spell ? unit.spell.stats.attackTime(att) : unit.info.attackTime;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsInCombat */
  isInCombat(): boolean {
    const unit = this.m_combatUnit;
    if (unit) return unit.deathState === "alive" && unit.threat.size > 0;
    return this.hasUnitFlag(UNIT_FLAG_IN_COMBAT);
  }

  /** @ac game/Entities/Creature/Creature.h Creature::IsEngaged */
  isEngaged(): boolean {
    const ai = this.i_AI as CreatureAI | null;
    if (this.IsAIEnabled && ai) return ai.IsEngaged();
    return this.isInCombat();
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetVictim (the map object of the player the combat world has this creature attack) */
  getVictim(): MovementOwner | null {
    const unit = this.m_combatUnit;
    return unit ? unit.host.creatureVictimObject(unit) : null;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetTarget (the `UNIT_FIELD_TARGET` guid) */
  getTarget(): bigint {
    return this.getGuidValue(UNIT_FIELD_TARGET);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SetTarget */
  setTarget(guid = 0n): void {
    this.setGuidValue(UNIT_FIELD_TARGET, guid);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::Attack (the combat world owns the victim, the threat list and `SMSG_ATTACKSTART`) */
  attack(victim: MovementOwner, meleeAttack: boolean): boolean {
    const unit = this.m_combatUnit;
    return unit ? unit.host.creatureAttack(unit, victim, meleeAttack) : false;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::AttackStop (`SMSG_ATTACKSTOP` and the cleared victim) */
  attackStop(): boolean {
    const unit = this.m_combatUnit;
    return unit ? unit.host.creatureAttackStop(unit) : false;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::EngageWithTarget (the combat world adds the threat) */
  engageWithTarget(target: MovementOwner): void {
    const unit = this.m_combatUnit;
    if (unit) unit.host.creatureEngageWithTarget(unit, target);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::IsValidAttackTarget (@ac-skip Combat: only players are valid victims here) */
  isValidAttackTarget(target: MovementOwner): boolean {
    const unit = this.m_combatUnit;
    return unit ? unit.host.creatureIsValidAttackTarget(unit, target) : false;
  }

  /** `CreatureAI::_EnterEvadeMode`: the combat world's part of the evade (the threat list, the tap, the leash and the auras). */
  evadeCombat(): void {
    const unit = this.m_combatUnit;
    if (unit) unit.host.creatureEvadeCombat(unit);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::ObjectAccessor::GetUnit (`ObjectAccessor::GetUnit(*this, guid)`): a creature of this map or a player on it */
  getUnit(guid: bigint): MovementOwner | null {
    const unit = this.m_combatUnit;
    if (unit) {
      const found = unit.host.creatureUnitObject(unit, guid);
      if (found) return found;
    }
    return (this.findMap() as { getUnit?(guid: bigint): MovementOwner | null } | null)?.getUnit?.(guid) ?? null;
  }

  /**
   * The `JustDied` branch of `Unit::setDeathState` for the movement of a creature the combat world killed: the motion stack goes
   * to idle and the creature stops where it is. @ac game/Entities/Unit/Unit.cpp Unit::setDeathState
   */
  unitDied(despawn = false): void {
    this.getMotionMaster().clear(false);
    this.getMotionMaster().moveIdle();

    // Xinef: Remove Hover so the corpse can fall to the ground
    // (`SetHover(false)` of `Creature::setDeathState` is the Creature part: `needsFalling` is not ported, a corpse stays where it fell)
    if (despawn) this.disableSpline();
    else this.stopMoving();
  }

  // Unit members (the class is not ported yet; these read the state above and the update fields)

  /** @ac game/Entities/Unit/Unit.h Unit::getDeathState (the linked combat state wins while it is set) */
  getDeathState(): DeathState {
    const unit = this.m_combatUnit;
    if (unit) return unit.deathState === "alive" ? DeathState.Alive : unit.deathState === "corpse" ? DeathState.Corpse : DeathState.Dead;
    return this.m_deathState;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsAlive */
  isAlive(): boolean {
    return this.getDeathState() === DeathState.Alive;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::isDying */
  isDying(): boolean {
    return this.getDeathState() === DeathState.JustDied;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::isDead */
  isDead(): boolean {
    const state = this.getDeathState();
    return state === DeathState.Dead || state === DeathState.Corpse;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetHealth */
  getHealth(): number {
    return this.m_combatUnit ? this.m_combatUnit.health : this.getUInt32Value(UNIT_FIELD_HEALTH);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetMaxHealth */
  getMaxHealth(): number {
    return this.getUInt32Value(0x0020 /* UNIT_FIELD_MAXHEALTH */);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetLevel */
  getLevel(): number {
    return this.getUInt32Value(UNIT_FIELD_LEVEL);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::HasUnitFlag */
  hasUnitFlag(flags: number): boolean {
    return this.hasFlag(0x003b /* UNIT_FIELD_FLAGS */, flags);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::HasUnitFlag2 */
  hasUnitFlag2(flags: number): boolean {
    return this.hasFlag(0x003c /* UNIT_FIELD_FLAGS_2 */, flags);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::AddUnitState */
  addUnitState(f: number): void {
    this.m_state |= f;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::HasUnitState (the states the spell unit sets: root, stun, casting, ... count too) */
  hasUnitState(f: number): boolean {
    return ((this.m_state | (this.m_combatUnit?.spell?.unitState ?? 0)) & f) !== 0;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::ClearUnitState */
  clearUnitState(f: number): void {
    this.m_state &= ~f;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::HasUnitMovementFlag */
  hasUnitMovementFlag(f: number): boolean {
    return this.m_movementInfo.hasMovementFlag(f);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsFlying */
  isFlying(): boolean {
    return this.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_FLYING | MOVEMENTFLAG_DISABLE_GRAVITY);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsHovering */
  isHovering(): boolean {
    return this.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_HOVER);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsWalking */
  isWalking(): boolean {
    return this.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_WALKING);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetHoverHeight */
  getHoverHeight(): number {
    return this.isHovering() ? this.getFloatValue(UNIT_FIELD_HOVERHEIGHT) : 0.0;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::IsInWater (`MAP_LIQUID_STATUS_SWIMMING`) */
  isInWater(): boolean {
    return (this.getLiquidData().Status & (LIQUID_MAP_IN_WATER | LIQUID_MAP_UNDER_WATER)) !== 0;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::IsUnderWater */
  isUnderWater(): boolean {
    return this.getLiquidData().Status === LIQUID_MAP_UNDER_WATER;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::GetSpeed (creatures use `baseMoveSpeed`) */
  getSpeed(mtype: number): number {
    // the aura speed modifiers are the spell unit's (`Unit::UpdateSpeed`): its rates start from this creature's
    const spell = this.m_combatUnit?.spell;
    if (spell) return spell.speed(mtype);
    return Math.fround((this.m_speed_rate[mtype] ?? 1.0) * (baseMoveSpeed[mtype] ?? 0));
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetSpeedRate */
  getSpeedRate(mtype: number): number {
    const spell = this.m_combatUnit?.spell;
    if (spell) return spell.speedRate[mtype] ?? 1.0;
    return this.m_speed_rate[mtype] ?? 1.0;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsInFlight */
  isInFlight(): boolean {
    return this.hasUnitState(UNIT_STATE_IN_FLIGHT);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::HasWaterWalkAura (@ac-skip Spells: auras) */
  hasWaterWalkAura(): boolean {
    return false;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::HasStealthAura (@ac-skip Spells: auras) */
  hasStealthAura(): boolean {
    return false;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::HasAuraTypeWithMiscvalue (@ac-skip Spells: auras) */
  hasAuraTypeWithMiscvalue(_auraType: number, _miscValue: number): boolean {
    return false;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::GetCharmerOrOwner (@ac-skip Pets: charm and ownership) */
  getCharmerOrOwner(): UnitLike | null {
    return null;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::GetVehicleBase (@ac-skip Vehicles) */
  getVehicleBase(): UnitLike | null {
    return null;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsCharmedOwnedByPlayerOrPlayer (`GetCharmerOrOwnerOrOwnGUID().IsPlayer()`) */
  isCharmedOwnedByPlayerOrPlayer(): boolean {
    return ObjectGuid.IsPlayer(this.getCharmerOrOwnerGUID() || this.getGUID());
  }

  /**
   * @ac game/Entities/Creature/Creature.cpp Creature::SetDisplayId
   * @ac game/Entities/Unit/Unit.cpp Unit::SetDisplayId (the field; scale and the model info are @ac-skip Display)
   */
  setDisplayId(displayId: number, _displayScale = 1.0): void {
    this.setUInt32Value(UNIT_FIELD_DISPLAYID, displayId);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetDisplayId */
  getDisplayId(): number {
    return this.getUInt32Value(UNIT_FIELD_DISPLAYID);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::SetNativeDisplayId */
  setNativeDisplayId(displayId: number): void {
    this.setUInt32Value(UNIT_FIELD_NATIVEDISPLAYID, displayId);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetNativeDisplayId */
  getNativeDisplayId(): number {
    return this.getUInt32Value(UNIT_FIELD_NATIVEDISPLAYID);
  }

  /** @ac game/Entities/Creature/Creature.h Creature::IsInWorld helper: the spawn's map id (`GetCreatureData()->mapid`) */
  getSpawnMapId(): number {
    return this.m_creatureData?.mapid ?? this.getMapId();
  }
}
