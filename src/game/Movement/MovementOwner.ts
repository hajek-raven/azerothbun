/**
 * The owners the movement generators and `MotionMaster` drive: the `Unit`, `Creature` and `Player` members that
 * `game/Movement/**` and `Entities/Creature/CreatureGroups.cpp` call, as narrow structural interfaces with the C++ names
 * (camelCase), each member annotated with the C++ member it stands for.
 *
 * `Unit` is not ported as a class (`Creature` extends `WorldObject` and implements `UnitLike`; the player is a `SessionMapPlayer`),
 * exactly like `PathGenerator.ts` takes `PathSource*`. `Creature` implements every member (`asMovementOwner()` is the one cast, because
 * its `toUnit`/`toPlayer`/`getMap` return the grid layer's types); `SessionMapPlayer` has the subset a creature calls on its target.
 * The integration is described in `docs/movement-port.md`.
 *
 * Out parameters (`float& x`) are the returned values or `{ value }` / `Position` objects that are written in place, as the
 * `WorldObject` port already does (`getNearPoint`, `getClosePoint`, `movePositionToFirstCollision`).
 */
import type { FloatRef } from "../Grids/MapLike.ts";
import type { MapCollisionDataMap } from "../Maps/MapCollisionData.ts";
import type { CreatureAILike } from "../Grids/Notifiers/GridNotifiers.ts";
import type { Position, PositionLike } from "../Entities/Object/Position.ts";
import type { CreatureGroup } from "../Entities/Creature/CreatureGroups.ts";
import type { PathSourceMap } from "./MovementGenerators/PathGenerator.ts";
import type { FactionTemplateEntry } from "../../gen/DBCStructure.gen.ts";
import type { MotionMaster } from "./MotionMaster.ts";
import type { MoveSpline } from "./Spline/MoveSpline.ts";
import type { MoveSplineMovementInfo, MoveSplineUnit } from "./Spline/MoveSplineInit.ts";
import type { AbstractFollower } from "./AbstractFollower.ts";

export {
  MOVEMENTFLAG_ASCENDING,
  MOVEMENTFLAG_BACKWARD,
  MOVEMENTFLAG_CAN_FLY,
  MOVEMENTFLAG_DESCENDING,
  MOVEMENTFLAG_FALLING,
  MOVEMENTFLAG_FALLING_FAR,
  MOVEMENTFLAG_FLYING,
  MOVEMENTFLAG_FORWARD,
  MOVEMENTFLAG_MASK_MOVING,
  MOVEMENTFLAG_NONE,
  MOVEMENTFLAG_ONTRANSPORT,
  MOVEMENTFLAG_PITCH_DOWN,
  MOVEMENTFLAG_PITCH_UP,
  MOVEMENTFLAG_SPLINE_ELEVATION,
  MOVEMENTFLAG_STRAFE_LEFT,
  MOVEMENTFLAG_STRAFE_RIGHT,
} from "../Entities/Unit/UnitDefines.ts";

/** @ac game/Entities/Pet/PetDefines.h PET_FOLLOW_DIST */
export const PET_FOLLOW_DIST = 2.0;
/** @ac shared/SharedDefines.h EventId::EVENT_CHARGE */
export const EVENT_CHARGE = 1003;
/** Special charge event which is used for charge spells that have explicit targets and had a path already generated. @ac shared/SharedDefines.h EventId::EVENT_CHARGE_PREPATH */
export const EVENT_CHARGE_PREPATH = 1005;
/** @ac game/Entities/Creature/Creature.h ReactStates */
export const REACT_PASSIVE = 0;
export const REACT_AGGRESSIVE = 2;

/** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.cpp UNIT_STATE_ALL_STATE (`0xffffffff`; the generated enum table holds `0x0fffffff`) */
export const UNIT_STATE_ALL_STATE = 0xffffffff;

/**
 * The creature AI calls the movement code makes (`CreatureAI.h` / `UnitAI.h`). `CreatureAILike` (the grid layer's two
 * relocation calls) gains these as the AI port lands.
 *
 * @ac-skip AI: only `ReactorAI` / `CreatureAI` are ported (`src/game/AI`), every call is `ai?.X`.
 */
export interface MovementCreatureAI extends CreatureAILike {
  /** @ac game/AI/CoreAI/UnitAI.h UnitAI::MovementInform (`CreatureAI::MovementInform`) */
  MovementInform?(type: number, id: number): void;
  /** @ac game/AI/CoreAI/UnitAI.h UnitAI::SummonMovementInform */
  SummonMovementInform?(creature: MovementOwnerCreature, type: number, id: number): void;
  /** @ac game/AI/CreatureAI.h CreatureAI::JustReachedHome */
  JustReachedHome?(): void;
  /** @ac game/AI/CreatureAI.h CreatureAI::WaypointPathStarted */
  WaypointPathStarted?(pathId: number): void;
  /** @ac game/AI/CreatureAI.h CreatureAI::WaypointStarted */
  WaypointStarted?(nodeId: number, pathId: number): void;
  /** @ac game/AI/CreatureAI.h CreatureAI::WaypointReached */
  WaypointReached?(nodeId: number, pathId: number): void;
  /** @ac game/AI/CreatureAI.h CreatureAI::PathEndReached */
  PathEndReached?(pathId: number): void;
  /** @ac game/AI/CreatureAI.h CreatureAI::WaypointPathEnded */
  WaypointPathEnded?(nodeId: number, pathId: number): void;
  /** @ac game/AI/CreatureAI.h CreatureAI::DistancingStarted */
  DistancingStarted?(): void;
  /** @ac game/AI/CreatureAI.h CreatureAI::DistancingEnded */
  DistancingEnded?(): void;
  /** @ac game/AI/CreatureAI.h CreatureAI::AttackStart */
  AttackStart?(victim: MovementOwner): void;
  /** @ac game/AI/CreatureAI.h CreatureAI::EnterEvadeMode */
  EnterEvadeMode?(): void;
  /** @ac game/AI/CreatureAI.h CreatureAI::EngagementStart */
  EngagementStart?(who: unknown): void;
  /** @ac game/AI/CreatureAI.h CreatureAI::EngagementOver */
  EngagementOver?(): void;
}

/** @ac game/Entities/Unit/Unit.h Unit::m_movementInfo (the members the generators call) */
export interface MovementOwnerMovementInfo extends MoveSplineMovementInfo {
  /** @ac game/Entities/Object/Object.h MovementInfo::HasMovementFlag */
  hasMovementFlag(flag: number): boolean;
  /** @ac game/Entities/Object/Object.h MovementInfo::SetFallTime */
  setFallTime(newFallTime: number): void;
  /** @ac game/Entities/Object/Object.h MovementInfo::GetSpeedType (`UnitMoveType`) */
  getSpeedType(): number;
}

/** @ac game/Maps/Map.h Map (the members `game/Movement` calls beyond `PathSourceMap`) */
export interface MovementMapExtras extends MapCollisionDataMap {
  /** @ac game/Maps/Map.h Map::GetId */
  getId(): number;
  /** @ac game/Maps/Map.cpp Map::GetHeight (the `(phasemask, x, y, z, vmap, maxSearchDist)` overload) */
  getHeight(phasemask: number, x: number, y: number, z: number, vmap?: boolean, maxSearchDist?: number): number;
  /** @ac game/Maps/Map.cpp Map::CanReachPositionAndGetValidCoords (`float& destX, destY, destZ` is `dest`, written in place) */
  canReachPositionAndGetValidCoords(source: MovementObject, dest: { x: number; y: number; z: number }, failOnCollision?: boolean, failOnSlopes?: boolean): boolean;
  /** @ac game/Maps/Map.cpp Map::ScriptsStart (`sWaypointScripts` / `sEventScripts` is the first argument) @ac-skip Scripts: the script map is not ported */
  scriptsStart(scripts: unknown, id: number, source: MovementObject | null, target: MovementObject | null): void;
}

/** The `Map` a movement owner lives on. */
export type MovementMap = PathSourceMap & MovementMapExtras;

/**
 * What the `WorldObject` members that take a `WorldObject const*` accept here: a position and a guid. The real `WorldObject`
 * and every `MovementOwner` satisfy it, so the real members (typed with `WorldObject`) stay assignable to the owner interface.
 */
export interface MovementObject extends PositionLike {
  /** @ac game/Entities/Object/Object.h Object::GetGUID */
  getGUID(): bigint;
}

/** @ac game/Entities/Creature/Creature.h CreatureMovementData (the members the generators read) */
export interface MovementOwnerCreatureMovementData {
  /** @ac game/Entities/Creature/Creature.h CreatureMovementData::GetRandom (`CreatureRandomMovementType`) */
  getRandom(): number;
  /** @ac game/Entities/Creature/Creature.h CreatureMovementData::GetChase (`CreatureChaseMovementType`) */
  getChase(): number;
}

export { CreatureChaseMovementType, CreatureRandomMovementType } from "../Entities/Creature/CreatureData.ts";

/** @ac game/Combat/CombatManager.h CombatManager (the members `HomeMovementGenerator` calls) */
export interface MovementOwnerCombatManager {
  /** @ac game/Combat/CombatManager.h CombatManager::SetEvadeState (`EvadeState`) @ac-skip Combat: the combat manager is not ported */
  setEvadeState(state: number): void;
}
/** `EvadeState` @ac game/Combat/CombatManager.h */
export const EVADE_STATE_NONE = 0;
export const EVADE_STATE_COMBAT = 1;
export const EVADE_STATE_HOME = 2;

/**
 * @ac game/Entities/Unit/Unit.h Unit (the members `MotionMaster` and the generators call).
 *
 * The `WorldObject` members keep the real signatures of `Entities/Object/Object.ts` and `Position.ts`; parameters that are a
 * `WorldObject` there are `MovementObject` here (see above). Standalone on purpose: extending `UnitLike` would make the
 * `toCreature()` / `toPlayer()` results the real classes, which do not satisfy the narrow owner interfaces yet.
 */
export interface MovementOwner extends MoveSplineUnit, MovementObject {
  // the map and the movement state
  /** @ac game/Entities/Object/Object.h WorldObject::GetMap (the `Map` with the movement members) */
  getMap(): MovementMap;
  /** @ac game/Entities/Object/Object.h WorldObject::FindMap */
  findMap(): MapCollisionDataMap | null;
  /** @ac game/Entities/Unit/Unit.h Unit::movespline */
  readonly movespline: MoveSpline;
  /** @ac game/Entities/Unit/Unit.h Unit::m_movementInfo */
  readonly m_movementInfo: MovementOwnerMovementInfo;
  /** @ac game/Entities/Unit/Unit.h Unit::GetMotionMaster */
  getMotionMaster(): MotionMaster;
  /** @ac game/Entities/Object/Object.h MovableMapObject::_moveState */
  _moveState: number;

  // type checks
  /** @ac game/Entities/Object/Object.h Object::IsPlayer */
  isPlayer(): boolean;
  /** @ac game/Entities/Object/Object.h Object::IsCreature */
  isCreature(): boolean;
  /** @ac game/Entities/Object/Object.h Object::ToUnit */
  toUnit(): MovementOwner | null;
  /** @ac game/Entities/Object/Object.h Object::ToCreature */
  toCreature(): MovementOwnerCreature | null;
  /** @ac game/Entities/Object/Object.h Object::ToPlayer */
  toPlayer(): MovementOwnerPlayer | null;

  // WorldObject
  /** @ac game/Entities/Object/Object.h Object::IsInWorld */
  isInWorld(): boolean;
  /** @ac game/Entities/Object/Position.h Position::GetPosition (the copy) */
  getPosition(): Position;
  /** @ac game/Entities/Object/Position.h Position::GetExactDistSq (`(x, y, z)` or `(Position const&)`) */
  getExactDistSq(xOrPos: number | PositionLike, y?: number, z?: number): number;
  /** @ac game/Entities/Object/Position.h Position::GetExactDist */
  getExactDist(xOrPos: number | PositionLike, y?: number, z?: number): number;
  /** @ac game/Entities/Object/Position.h Position::GetExactDist2d */
  getExactDist2d(xOrPos: number | PositionLike, y?: number): number;
  /** @ac game/Entities/Object/Position.h Position::IsInDist (`(x, y, z, dist)` or `(Position const*, dist)`) */
  isInDist(xOrPos: number | PositionLike, yOrDist: number, z?: number, dist?: number): boolean;
  /** @ac game/Entities/Object/Position.cpp Position::GetAngle (`(Position const*)` or `(x, y)`) */
  getAngle(xOrPos: number | PositionLike | null, y?: number): number;
  /** @ac game/Entities/Object/Position.h Position::GetRelativeAngle */
  getRelativeAngle(xOrPos: number | PositionLike, y?: number): number;
  /** @ac game/Entities/Object/Position.h Position::ToAbsoluteAngle */
  toAbsoluteAngle(relAngle: number): number;
  /** @ac game/Entities/Object/Object.cpp WorldObject::GetDistance (`(WorldObject const*)`, `(Position const&)` or `(x, y, z)`) */
  getDistance(objOrPosOrX: PositionLike | number, y?: number, z?: number): number;
  /** @ac game/Entities/Object/Object.cpp WorldObject::GetDistance2d (`(WorldObject const*)` or `(x, y)`) */
  getDistance2d(objOrX: MovementObject | number, y?: number): number;
  /** @ac game/Entities/Object/Object.cpp WorldObject::IsWithinLOS */
  isWithinLOS(ox: number, oy: number, oz: number, ignoreFlags?: number, checks?: number): boolean;
  /** @ac game/Entities/Object/Object.cpp WorldObject::IsWithinLOSInMap */
  isWithinLOSInMap(obj: MovementObject, ignoreFlags?: number, checks?: number, collisionHeight?: number | null, combatReach?: number | null): boolean;
  /** @ac game/Entities/Object/Object.cpp WorldObject::IsInMap */
  isInMap(obj: MovementObject | null): boolean;
  /** @ac game/Entities/Object/Object.cpp WorldObject::GetNearPoint (the reference parameters are the result) */
  getNearPoint(searcher: MovementObject | null, searcher_size: number, distance2d: number, absAngle: number, controlZ?: number, startPos?: PositionLike | null): { x: number; y: number; z: number };
  /** @ac game/Entities/Object/Object.cpp WorldObject::GetNearPoint2D (the reference parameters are the result) */
  getNearPoint2D(searcher: MovementObject | null, distance2d: number, absAngle: number, startPos?: PositionLike | null): { x: number; y: number };
  /** @ac game/Entities/Object/Object.cpp WorldObject::GetClosePoint (the point and the C++ `bool` as `ok`) */
  getClosePoint(size: number, distance2d?: number, angle?: number, forWho?: MovementObject | null, force?: boolean): { x: number; y: number; z: number; ok: boolean };
  /** @ac game/Entities/Object/Object.cpp WorldObject::MovePositionToFirstCollision (`pos` is changed in place) */
  movePositionToFirstCollision(pos: Position, dist: number, angle: number): void;
  /** @ac game/Entities/Object/Object.cpp WorldObject::GetMapHeight */
  getMapHeight(x: number, y: number, z: number, vmap?: boolean, distanceToSearch?: number): number;
  /** @ac game/Entities/Object/Object.cpp WorldObject::GetMapWaterOrGroundLevel (`(Position)` or `(x, y, z)`; `ground` is the `float*`) */
  getMapWaterOrGroundLevel(xOrPos: number | PositionLike, yOrGround?: number | FloatRef | null, z?: number, ground?: FloatRef | null): number;
  /** @ac game/Entities/Object/Object.cpp WorldObject::GetObjectSize */
  getObjectSize(): number;
  /** @ac game/Entities/Object/Object.h WorldObject::GetCombatReach */
  getCombatReach(): number;
  /** @ac game/Entities/Object/Object.h WorldObject::GetName */
  getName(): string;
  /** @ac game/Entities/Object/Object.h WorldObject::GetInstanceId */
  getInstanceId(): number;
  /** @ac game/Entities/Object/Object.h WorldObject::GetCharmerOrOwnerGUID */
  getCharmerOrOwnerGUID(): bigint;
  /** @ac game/Entities/Object/Object.h WorldObject::GetOwnerGUID (`Pet::GetOwnerGUID`) */
  getOwnerGUID(): bigint;

  // unit state and flags
  /** @ac game/Entities/Unit/Unit.h Unit::IsAlive */
  isAlive(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::HasUnitState */
  hasUnitState(f: number): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::AddUnitState */
  addUnitState(f: number): void;
  /** @ac game/Entities/Unit/Unit.h Unit::ClearUnitState */
  clearUnitState(f: number): void;
  /** @ac game/Entities/Unit/Unit.h Unit::HasUnitFlag */
  hasUnitFlag(flags: number): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::SetUnitFlag */
  setUnitFlag(flags: number): void;
  /** @ac game/Entities/Unit/Unit.h Unit::RemoveUnitFlag */
  removeUnitFlag(flags: number): void;
  /** @ac game/Entities/Unit/Unit.h Unit::HasUnitMovementFlag */
  hasUnitMovementFlag(f: number): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::AddUnitMovementFlag */
  addUnitMovementFlag(f: number): void;
  /** @ac game/Entities/Unit/Unit.h Unit::RemoveUnitMovementFlag */
  removeUnitMovementFlag(f: number): void;
  /** @ac game/Entities/Unit/Unit.h Unit::SendMovementFlagUpdate */
  sendMovementFlagUpdate(self?: boolean): void;
  /** @ac game/Entities/Unit/Unit.h Unit::IsFlying (a `MOVEMENTFLAG_FLYING` check) */
  isFlying(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsHovering */
  isHovering(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::GetHoverHeight */
  getHoverHeight(): number;
  /** @ac game/Entities/Unit/Unit.h Unit::isMoving */
  isMoving(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsWalking */
  isWalking(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::CanFly */
  canFly(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::CanSwim (virtual; `Creature::CanSwim` overrides it) */
  canSwim(): boolean;
  /** @ac game/Entities/Unit/Unit.cpp Unit::IsFalling */
  isFalling(): boolean;
  /** @ac game/Entities/Unit/Unit.cpp Unit::IsInWater */
  isInWater(): boolean;
  /** @ac game/Entities/Unit/Unit.cpp Unit::IsUnderWater */
  isUnderWater(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsInCombat */
  isInCombat(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsPet */
  isPet(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsGuardian */
  isGuardian(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsVehicle */
  isVehicle(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsControlledByPlayer */
  isControlledByPlayer(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsCharmedOwnedByPlayerOrPlayer */
  isCharmedOwnedByPlayerOrPlayer(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsStandState */
  isStandState(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::SetStandState */
  setStandState(state: number): void;
  /** @ac game/Entities/Unit/Unit.h Unit::GetBoundaryRadius */
  getBoundaryRadius(): number;
  /** @ac game/Entities/Unit/Unit.h Unit::GetMeleeRange */
  getMeleeRange(target: MovementOwner): number;
  /** @ac game/Entities/Unit/Unit.cpp Unit::GetMeleeAttackPoint (`Position& pos` is the result; null when there is no point) */
  getMeleeAttackPoint(attacker: MovementOwner): Position | null;
  /** @ac game/Entities/Unit/Unit.cpp Unit::isInAccessiblePlaceFor */
  isInAccessiblePlaceFor(c: MovementOwnerCreature): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::GetCharmerOrOwnerPlayerOrPlayerItself */
  getCharmerOrOwnerPlayerOrPlayerItself(): MovementOwnerPlayer | null;
  /** @ac game/Entities/Unit/Unit.h Unit::GetCritterGUID */
  getCritterGUID(): bigint;
  /** @ac game/Entities/Unit/Unit.h Unit::GetCharmerOrOwner */
  getCharmerOrOwner(): MovementOwner | null;
  /** @ac game/Entities/Unit/Unit.h Unit::GetFollowAngle */
  getFollowAngle(): number;
  /** @ac game/Entities/Unit/Unit.h Unit::GetAI (`UnitAI*`) @ac-skip AI: no unit AI is ported */
  getAI(): MovementCreatureAI | null;
  /** @ac game/Entities/Unit/Unit.h Unit::GetVictim */
  getVictim(): MovementOwner | null;
  /** @ac game/Entities/Unit/Unit.h Unit::GetTarget (the `UNIT_FIELD_TARGET` guid) */
  getTarget(): bigint;
  /** @ac game/Entities/Unit/Unit.h Unit::SetTarget */
  setTarget(guid?: bigint): void;
  /** @ac game/Entities/Unit/Unit.h Unit::Attack */
  attack(victim: MovementOwner, meleeAttack: boolean): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::AttackStop */
  attackStop(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::CastStop */
  castStop(exceptSpellId?: number, withInstant?: boolean): void;
  /** @ac game/Entities/Unit/Unit.h Unit::IsMovementPreventedByCasting */
  isMovementPreventedByCasting(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsStopped */
  isStopped(): boolean;
  /** @ac game/Entities/Unit/Unit.cpp Unit::StopMoving */
  stopMoving(): void;
  /** @ac game/Entities/Unit/Unit.cpp Unit::SetFacingTo */
  setFacingTo(ori: number, force?: boolean): void;
  /** @ac game/Entities/Unit/Unit.cpp Unit::SetInFront */
  setInFront(target: MovementOwner): void;
  /** @ac game/Entities/Unit/Unit.cpp Unit::NearTeleportTo */
  nearTeleportTo(x: number, y: number, z: number, orientation: number, casting?: boolean): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsClientControlled (`Player::IsClientControlled`) */
  isClientControlled(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::FollowerAdded */
  followerAdded(f: AbstractFollower): void;
  /** @ac game/Entities/Unit/Unit.h Unit::FollowerRemoved */
  followerRemoved(f: AbstractFollower): void;
  /** @ac game/Globals/ObjectAccessor.cpp ObjectAccessor::GetUnit (`GetUnit(*this, guid)`) */
  getUnit(guid: bigint): MovementOwner | null;
}

/** @ac game/Entities/Creature/Creature.h Creature (the members `game/Movement` and `CreatureGroups` call) */
export interface MovementOwnerCreature extends MovementOwner {
  /** @ac game/Entities/Object/Object.h Object::ToCreature */
  toCreature(): MovementOwnerCreature;
  /** @ac game/Entities/Creature/Creature.h Creature::AI */
  ai(): MovementCreatureAI | null;
  /** @ac game/Entities/Unit/Unit.h Unit::IsAIEnabled */
  IsAIEnabled: boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::GetSpawnId */
  getSpawnId(): number;
  /** @ac game/Entities/Creature/Creature.h Creature::GetWanderDistance */
  getWanderDistance(): number;
  /** @ac game/Entities/Creature/Creature.h Creature::GetDefaultMovementType */
  getDefaultMovementType(): number;
  /** @ac game/Entities/Creature/Creature.h Creature::GetMovementTemplate */
  getMovementTemplate(): MovementOwnerCreatureMovementData;
  /** @ac game/Entities/Creature/Creature.h Creature::GetWaypointPath */
  getWaypointPath(): number;
  /** @ac game/Entities/Creature/Creature.h Creature::GetCreatureData (`CreatureData::currentwaypoint`) */
  getCreatureData(): { currentwaypoint: number } | null;
  /** @ac game/Entities/Creature/Creature.cpp Creature::UpdateCurrentWaypointInfo */
  updateCurrentWaypointInfo(nodeId: number, pathId: number): void;
  /** @ac game/Entities/Creature/Creature.h Creature::UpdateWaypointID */
  updateWaypointID(wpID: number): void;
  /** @ac game/Entities/Creature/Creature.h Creature::GetCurrentWaypointID */
  getCurrentWaypointID(): number;
  /** @ac game/Entities/Creature/Creature.h Creature::SetHomePosition (`(x, y, z, o)` or `(Position const&)`) */
  setHomePosition(xOrPos: number | Position, y?: number, z?: number, o?: number): void;
  /** @ac game/Entities/Creature/Creature.h Creature::GetHomePosition (the `Position`) */
  getHomePosition(): Position;
  /** @ac game/Entities/Creature/Creature.h Creature::SetTransportHomePosition */
  setTransportHomePosition(x: number, y: number, z: number, o: number): void;
  /** @ac game/Entities/Creature/Creature.cpp Creature::LoadCreaturesAddon */
  loadCreaturesAddon(reload?: boolean): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::HasSwimmingFlagOutOfCombat */
  hasSwimmingFlagOutOfCombat(): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::GetCombatManager */
  getCombatManager(): MovementOwnerCombatManager;
  /** @ac game/Entities/Creature/Creature.h Creature::GetAttackTime (`WeaponAttackType`) */
  getAttackTime(att: number): number;
  /** @ac game/Entities/Creature/Creature.h Creature::SetReactState */
  setReactState(state: number): void;
  /** @ac game/Entities/Creature/Creature.h Creature::SetNoCallAssistance */
  setNoCallAssistance(val: boolean): void;
  /** @ac game/Entities/Creature/Creature.cpp Creature::CallAssistance */
  callAssistance(): void;
  /** @ac game/Entities/Creature/Creature.h Creature::SetCannotReachTarget (the target guid, or empty to clear) */
  setCannotReachTarget(guid?: bigint): void;
  /** @ac game/Entities/Creature/Creature.h Creature::CanEnterWater */
  canEnterWater(): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::CanWalk */
  canWalk(): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::IsEngaged */
  isEngaged(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::isPossessed */
  isPossessed(): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::IsInEvadeMode */
  isInEvadeMode(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsValidAttackTarget */
  isValidAttackTarget(target: MovementOwner): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::EngageWithTarget */
  engageWithTarget(target: MovementOwner): void;
  /** @ac game/Entities/Creature/Creature.cpp Creature::Respawn */
  respawn(force?: boolean): void;
  /** @ac game/Entities/Creature/Creature.cpp Creature::DespawnOrUnsummon (`Milliseconds`, `Seconds`) */
  despawnOrUnsummon(timeToDespawnMs?: number, forcedRespawnTimerSecs?: number): void;
  /** @ac game/Entities/Creature/Creature.h Creature::GetFormation */
  getFormation(): CreatureGroup | null;
  /** @ac game/Entities/Creature/Creature.h Creature::SetFormation */
  setFormation(formation: CreatureGroup | null): void;
  /** @ac game/Entities/Unit/Unit.h Unit::IsSummon */
  isSummon(): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::IsFormationLeader (`CreatureGroups.ts` `IsFormationLeader`) */
  isFormationLeader(): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::IsFormationLeaderMoveAllowed (`CreatureGroups.ts` `IsFormationLeaderMoveAllowed`) */
  isFormationLeaderMoveAllowed(): boolean;
  /** @ac game/Entities/Creature/Creature.cpp Creature::SignalFormationMovement (`CreatureGroups.ts` `SignalFormationMovement`) */
  signalFormationMovement(): void;
  /** @ac game/Entities/Creature/TemporarySummon.h TempSummon::GetSummonerUnit (`ToTempSummon()` is null for a creature that is not a summon) @ac-skip TempSummon: not ported */
  getSummonerUnit(): MovementOwner | null;
}

/** @ac game/Entities/Player/Player.h PlayerTaxi (the members the flight path generator calls) */
export interface MovementOwnerPlayerTaxi {
  /** @ac game/Entities/Player/PlayerTaxi.h PlayerTaxi::GetPath */
  getPath(): readonly number[];
  /** @ac game/Entities/Player/PlayerTaxi.h PlayerTaxi::GetFlightMasterFactionTemplate */
  getFlightMasterFactionTemplate(): FactionTemplateEntry | null;
  /** @ac game/Entities/Player/PlayerTaxi.cpp PlayerTaxi::ClearTaxiDestinations */
  clearTaxiDestinations(): void;
  /** @ac game/Entities/Player/PlayerTaxi.h PlayerTaxi::NextTaxiDestination */
  nextTaxiDestination(): void;
  /** @ac game/Entities/Player/PlayerTaxi.h PlayerTaxi::empty */
  empty(): boolean;
}

/** @ac game/Entities/Player/Player.h Player (the members `game/Movement` calls) */
export interface MovementOwnerPlayer extends MovementOwner {
  /** @ac game/Entities/Object/Object.h Object::ToPlayer */
  toPlayer(): MovementOwnerPlayer;
  /** @ac game/Entities/Player/Player.h Player::m_taxi */
  readonly m_taxi: MovementOwnerPlayerTaxi;
  /** @ac game/Entities/Player/Player.h Player::pvpInfo (`PvPInfo::EndTimer`) */
  readonly pvpInfo: { EndTimer: number };
  /** @ac game/Entities/Player/Player.cpp Player::GetReputationPriceDiscount (`(FactionTemplateEntry const*)` overload) */
  getReputationPriceDiscount(factionTemplate: FactionTemplateEntry | null): number;
  /** @ac game/Entities/Unit/Unit.cpp Unit::Dismount */
  dismount(): void;
  /** @ac game/Entities/Player/Player.cpp Player::UpdatePvPState */
  updatePvPState(onlyFFA?: boolean): void;
  /** @ac game/Entities/Player/Player.cpp Player::UpdatePvP */
  updatePvP(state: boolean, override?: boolean): void;
  /** @ac game/Entities/Player/Player.h Player::SetFallInformation */
  setFallInformation(time: number, z: number): void;
  /** @ac game/Entities/Player/Player.h Player::RemovePlayerFlag */
  removePlayerFlag(flags: number): void;
  /** @ac game/Entities/Player/PlayerAchievements.cpp Player::UpdateAchievementCriteria */
  updateAchievementCriteria(type: number, miscValue1?: number, miscValue2?: number, miscValue3?: number, unit?: MovementOwner | null): void;
  /** @ac game/Entities/Player/Player.cpp Player::ModifyMoney */
  modifyMoney(amount: number, sendError?: boolean): boolean;
  /** @ac game/Entities/Player/Player.h Player::IsGameMaster */
  isGameMaster(): boolean;
}
