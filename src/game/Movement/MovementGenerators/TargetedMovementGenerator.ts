/**
 * Port of `game/Movement/MovementGenerators/TargetedMovementGenerator.{h,cpp}`: `ChaseMovementGenerator` (a unit chases
 * its target to melee or caster range, repathing when the target moves, with an optional fixed angle and range) and
 * `FollowMovementGenerator` (a pet or other follower keeps a distance and angle behind its target).
 *
 * Both templates exist for `Player` and `Creature`; each is one generic class here, and the `Creature` only calls go through
 * `owner.toCreature()` (null for a player), as the C++ does.
 */
import { Vector3 } from "../../../math/Vector3.ts";
import {
  BASE_ATTACK,
  MOVE_FLIGHT,
  MOVE_FLIGHT_BACK,
  MOVE_RUN,
  MOVE_RUN_BACK,
  MOVE_WALK,
  UNIT_FLAG_POSSESSED,
  UNIT_STATE_CHASE,
  UNIT_STATE_CHASE_MOVE,
  UNIT_STATE_FOLLOW,
  UNIT_STATE_FOLLOW_MOVE,
  UNIT_STATE_NOT_MOVE,
  UNIT_STATE_NO_COMBAT_MOVEMENT,
} from "../../../spells/enums.ts";
import { TimeTrackerSmall } from "../../time/timer.ts";
import { CONTACT_DISTANCE, NOMINAL_MELEE_RANGE } from "../../Entities/Object/ObjectDefines.ts";
import { ObjectGuid } from "../../Entities/Object/ObjectGuid.ts";
import { Position } from "../../Entities/Object/Position.ts";
import { AbstractFollower } from "../AbstractFollower.ts";
import { CHASE_MOTION_TYPE, FOLLOW_MOTION_TYPE, type ChaseAngle, type ChaseRange, type MovementGeneratorType } from "../MotionMaster.ts";
import { MovementGeneratorMedium } from "../MovementGenerator.ts";
import {
  CreatureChaseMovementType,
  MOVEMENTFLAG_BACKWARD,
  MOVEMENTFLAG_FORWARD,
  MOVEMENTFLAG_STRAFE_LEFT,
  MOVEMENTFLAG_STRAFE_RIGHT,
  type MovementOwner,
} from "../MovementOwner.ts";
import { MoveSplineInit } from "../Spline/MoveSplineInit.ts";
import { PATHFIND_INCOMPLETE, PATHFIND_NOPATH, PathGenerator } from "./PathGenerator.ts";

const F = Math.fround;
const M_PI = Math.PI;

/** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h ChaseMovementMode */
export const ChaseMovementMode = {
  CHASE_MODE_NORMAL: 0, // chasing target
  CHASE_MODE_BACKPEDAL: 1, // collision movement
  CHASE_MODE_DISTANCING: 2, // running away from melee
  CHASE_MODE_FANNING: 3, // mob collision movement
} as const;
export type ChaseMovementMode = (typeof ChaseMovementMode)[keyof typeof ChaseMovementMode];
export const CHASE_MODE_NORMAL = ChaseMovementMode.CHASE_MODE_NORMAL;
export const CHASE_MODE_BACKPEDAL = ChaseMovementMode.CHASE_MODE_BACKPEDAL;
export const CHASE_MODE_DISTANCING = ChaseMovementMode.CHASE_MODE_DISTANCING;
export const CHASE_MODE_FANNING = ChaseMovementMode.CHASE_MODE_FANNING;

/** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp IsMutualChase */
function IsMutualChase(owner: MovementOwner, target: MovementOwner): boolean {
  if (target.getMotionMaster().getCurrentMovementGeneratorType() !== CHASE_MOTION_TYPE) return false;

  return target.getVictim() === owner;
}

/** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp GetChaseRange */
function GetChaseRange(owner: MovementOwner, target: MovementOwner): number {
  const hitboxSum = F(owner.getCombatReach() + target.getCombatReach());

  const hoverDelta = F(owner.getHoverHeight() - target.getHoverHeight());
  if (hoverDelta !== 0.0) return F(Math.sqrt(Math.max(F(F(hitboxSum * hitboxSum) - F(hoverDelta * hoverDelta)), 0.0)));

  return hitboxSum;
}

/** `G3D::square` */
function square(x: number): number {
  return F(x * x);
}

/** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h ChaseMovementGenerator */
export class ChaseMovementGenerator<T extends MovementOwner = MovementOwner> extends MovementGeneratorMedium<T> {
  private readonly _follower: AbstractFollower;
  private i_leashExtensionTimer = new TimeTrackerSmall(5000);
  private i_path: PathGenerator | null = null;
  private i_recheckDistance = new TimeTrackerSmall(0);
  private i_recalculateTravel = true;

  private _lastTargetPosition: Position | null = null;
  private _range: ChaseRange | null;
  private _angle: ChaseAngle | null;
  private _movingTowards = true;
  private _mutualChase = true;
  private _fallbackPositioning = false;

  private m_currentMode: ChaseMovementMode = CHASE_MODE_NORMAL;

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h ChaseMovementGenerator::ChaseMovementGenerator */
  constructor(target: MovementOwner | null, range: ChaseRange | null = null, angle: ChaseAngle | null = null) {
    super();
    this._follower = new AbstractFollower(target);
    this._range = range;
    this._angle = angle;
  }

  /** The C++ destructor (`~AbstractFollower`). @ac game/Movement/AbstractFollower.h AbstractFollower::~AbstractFollower */
  override destroy(): void {
    this._follower.destroyFollower();
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h ChaseMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return CHASE_MOTION_TYPE;
  }

  /** @ac game/Movement/AbstractFollower.cpp AbstractFollower::SetTarget */
  setTarget(unit: MovementOwner | null): void {
    this._follower.setTarget(unit);
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h ChaseMovementGenerator::GetTarget */
  getTarget(): MovementOwner | null {
    return this._follower.getTarget();
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h ChaseMovementGenerator::unitSpeedChanged */
  override unitSpeedChanged(): void {
    this._lastTargetPosition = null;
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h ChaseMovementGenerator::EnableWalking */
  enableWalking(): boolean {
    return false;
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h ChaseMovementGenerator::HasLostTarget */
  hasLostTarget(unit: MovementOwner): boolean {
    return unit.getVictim() !== this.getTarget();
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp ChaseMovementGenerator<T>::PositionOkay */
  positionOkay(owner: T, target: MovementOwner, maxDistance: number | null, angle: ChaseAngle | null): boolean {
    const distSq = owner.getExactDistSq(target);

    // Distance between owner(chaser) and target is greater than the allowed distance.
    if (maxDistance !== null && distSq > square(maxDistance)) return false;

    // owner's relative angle to its target is not within boundaries
    if (angle && !angle.isAngleOkay(target.getRelativeAngle(owner))) return false;

    // owner cannot see its target
    if (!owner.isWithinLOSInMap(target)) return false;
    return true;
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp ChaseMovementGenerator<T>::SetOffsetAndAngle */
  setOffsetAndAngle(dist: ChaseRange | null, angle: ChaseAngle | null): void {
    this._range = dist;
    this._angle = angle;
    this._fallbackPositioning = false;
    this._lastTargetPosition = null;
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp ChaseMovementGenerator<T>::SetNewTarget */
  setNewTarget(target: MovementOwner | null): void {
    this.setTarget(target);
    this._fallbackPositioning = false;
    this._lastTargetPosition = null;
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp ChaseMovementGenerator<T>::DistanceYourself */
  distanceYourself(owner: T, distance: number): void {
    // make a new path if we have to...
    if (!this.i_path) this.i_path = new PathGenerator(owner);

    const target = this.getTarget()!;
    const p = target.getNearPoint(owner, owner.getBoundaryRadius(), distance, target.getAngle(owner));
    if (this.dispatchSplineToPosition(owner, p.x, p.y, p.z, false, false, 0.0, false, false)) {
      this.m_currentMode = CHASE_MODE_DISTANCING;
      // `if constexpr (!std::is_same_v<T, Player>)`
      const creature = owner.toCreature();
      if (creature) creature.ai()?.DistancingStarted?.();
    }
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp ChaseMovementGenerator<T>::DispatchSplineToPosition */
  dispatchSplineToPosition(owner: T, x: number, y: number, z: number, walk: boolean, cutPath: boolean, maxTarget: number, forceDest: boolean, target = false): boolean {
    const cOwner = owner.toCreature();
    const chaseTarget = this.getTarget()!;
    const targetPos = chaseTarget.getPosition();
    const path = this.i_path!;

    if (owner.isHovering()) z = owner.updateAllowedPositionZ(x, y, z);

    const isPathUsable = (): boolean => {
      const pathType = path.getPathType();
      if (pathType & PATHFIND_NOPATH) return false;

      // For pets, treat incomplete paths as failures to avoid clipping through geometry
      // Players and Player-controlled units have more erratic movement, skip failure
      if (cOwner && (cOwner.isPet() || cOwner.isControlledByPlayer()) && !chaseTarget.isCharmedOwnedByPlayerOrPlayer()) if (pathType & PATHFIND_INCOMPLETE) return false;

      return true;
    };

    let pathFailed = !path.calculatePath(x, y, z, forceDest) || !isPathUsable();
    let usedFallback = false;

    // Targets with an oversized combat reach can stand entirely over unwalkable space
    // (e.g. Kologarn) so pathing to their center or to an angled near point (pets chase
    // to behind the target, which may hang over the void) fails even though the melee
    // ring covers the navmesh. Retry against the nearest point on the ring, ignoring the
    // chase angle, via GetNearPoint2D: GetNearPoint's LoS repositioning must be avoided
    // here, it can rotate the point to the far side of the target.
    if (pathFailed && (!this._range || this._range.MaxRange <= CONTACT_DISTANCE) && !chaseTarget.isCharmedOwnedByPlayerOrPlayer() && chaseTarget.getCombatReach() > NOMINAL_MELEE_RANGE) {
      const near = chaseTarget.getNearPoint2D(owner, 0.0, chaseTarget.getAngle(owner));
      x = near.x;
      y = near.y;
      z = targetPos.getPositionZ();
      z = owner.updateAllowedPositionZ(x, y, z);
      if (Math.abs(z - targetPos.getPositionZ()) < maxTarget) {
        pathFailed = !path.calculatePath(x, y, z, forceDest) || !isPathUsable();
        // the destination already lies on the melee ring, nothing to cut
        cutPath = false;

        if (!pathFailed) usedFallback = true;
      }

      if (pathFailed) {
        // If the nearest point on the melee ring is also unpathable (e.g. Brain of Yogg-Saron
        // where the 30yd combat reach extends beyond the room's walls into geometry, but the
        // floor directly underneath the target is walkable), fall back to pathing directly
        // toward the target's ground position and cut the path once within combat range.
        let groundZ = targetPos.getPositionZ();
        groundZ = owner.updateAllowedPositionZ(targetPos.getPositionX(), targetPos.getPositionY(), groundZ);
        if (Math.abs(groundZ - targetPos.getPositionZ()) < maxTarget) {
          x = targetPos.getPositionX();
          y = targetPos.getPositionY();
          z = groundZ;
          pathFailed = !path.calculatePath(x, y, z, forceDest) || !isPathUsable();
          cutPath = true;
          if (!pathFailed) usedFallback = true;
        }
      }
    }

    if (pathFailed) {
      this._fallbackPositioning = false;
      if (cOwner) {
        cOwner.setCannotReachTarget(chaseTarget.getGUID());

        if (cOwner.isPet() || cOwner.isControlledByPlayer()) cOwner.attackStop();
      }

      owner.stopMoving();
      return false;
    }

    this._fallbackPositioning = usedFallback;

    if (cutPath) path.shortenPathUntilDist(new Vector3(targetPos.getPositionX(), targetPos.getPositionY(), targetPos.getPositionZ()), maxTarget);

    if (cOwner) {
      cOwner.setCannotReachTarget();
    }

    owner.addUnitState(UNIT_STATE_CHASE_MOVE);
    this.i_recalculateTravel = true;

    const init = new MoveSplineInit(owner);
    init.movebyPath(path.getPath() as Vector3[]);
    if (target) init.setFacing(chaseTarget);
    init.setWalk(walk);
    init.launch();

    return true;
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp ChaseMovementGenerator<T>::DoUpdate */
  doUpdate(owner: T, time_diff: number): boolean {
    const chaseTarget = this.getTarget();
    if (!chaseTarget || !chaseTarget.isInWorld() || !owner.isInMap(chaseTarget)) return false;

    if (!owner || !owner.isAlive()) return false;

    if (owner.hasUnitState(UNIT_STATE_NO_COMBAT_MOVEMENT)) {
      // script paused combat movement
      owner.stopMoving();
      this._lastTargetPosition = null;
      return true;
    }

    const cOwner = owner.toCreature();
    const isStoppedBecauseOfCasting = cOwner !== null && cOwner.isMovementPreventedByCasting();

    // the owner might be unable to move (rooted or casting), or we have lost the target, pause movement
    if (owner.hasUnitState(UNIT_STATE_NOT_MOVE) || this.hasLostTarget(owner) || isStoppedBecauseOfCasting) {
      // Every time a caster mob stops to cast a spell, the leash timer ticks down. Once the timer expires, the mob evades and walks home.
      owner.stopMoving();
      this._lastTargetPosition = null;

      if (cOwner) cOwner.setCannotReachTarget();

      return true;
    }

    const targetPlayer = chaseTarget.toPlayer();
    const forceDest =
      //(cOwner && (cOwner->isWorldBoss() || cOwner->IsDungeonBoss())) || // force for all bosses, even not in instances
      (targetPlayer !== null && targetPlayer.isGameMaster()) || // for .npc follow
      owner.canFly(); // closes "bool forceDest", that way it is more appropriate, so we can comment out crap whenever we need to

    const target = chaseTarget;

    let mutualChase = IsMutualChase(owner, target);
    const mutualTarget = target.getVictim() === owner;
    const chaseRange = GetChaseRange(owner, target);
    const meleeRange = owner.getMeleeRange(target);
    const minTarget = F((this._range ? this._range.MinTolerance : 0.0) + chaseRange);
    const maxRange = this._range ? F(this._range.MaxRange + chaseRange) : meleeRange; // melee range already includes hitboxes
    const maxTarget = this._range ? F(this._range.MaxTolerance + chaseRange) : F(CONTACT_DISTANCE + chaseRange);

    let angle: ChaseAngle | null = mutualChase || this._fallbackPositioning ? null : this._angle;

    // Prevent almost infinite spinning of mutual targets.
    if (angle && !mutualChase && this._mutualChase && mutualTarget && chaseRange < meleeRange) {
      angle = null;
      mutualChase = true;
    }

    // Prevent almost infinite spinning for pets with mutualTarget
    // _mutualChase is false for previous check
    if (angle && !mutualChase && !this._mutualChase && mutualTarget && chaseRange < meleeRange && cOwner && cOwner.isPet()) {
      angle = null;
      mutualChase = true;
    }

    // periodically check if we're already in the expected range...
    this.i_recheckDistance.update(time_diff);
    if (this.i_recheckDistance.passed()) {
      this.i_recheckDistance.reset(400); // Sniffed value

      if (this.m_currentMode !== CHASE_MODE_DISTANCING) {
        if (this.i_recalculateTravel && this.positionOkay(owner, target, this._movingTowards ? maxTarget : null, angle)) {
          if ((owner.hasUnitState(UNIT_STATE_CHASE_MOVE) && !target.isMoving() && !mutualChase) || this._range) {
            this.i_recalculateTravel = false;
            this.i_path = null;
            if (cOwner) cOwner.setCannotReachTarget();
            owner.stopMoving();
            owner.setInFront(target);
            this.movementInform(owner);
            return true;
          }
        }
      }
    }

    // if we're done moving, we want to clean up
    if (owner.hasUnitState(UNIT_STATE_CHASE_MOVE) && owner.movespline.finalized()) {
      this.i_recalculateTravel = false;
      this.i_path = null;
      owner.clearUnitState(UNIT_STATE_CHASE_MOVE);
      owner.setInFront(target);

      if (cOwner) cOwner.setCannotReachTarget();

      this.movementInform(owner);
    }

    if (cOwner) {
      if (this.i_recalculateTravel) this.i_leashExtensionTimer.reset(cOwner.getAttackTime(BASE_ATTACK));
    }

    if (this.m_currentMode === CHASE_MODE_DISTANCING) return true;

    // if the target moved, we have to consider whether to adjust
    if (!this._lastTargetPosition || !target.getPosition().equals(this._lastTargetPosition) || mutualChase !== this._mutualChase || !owner.isWithinLOSInMap(target)) {
      this._lastTargetPosition = target.getPosition();
      this._mutualChase = mutualChase;
      this._fallbackPositioning = false;
      angle = mutualChase ? null : this._angle;
      if (owner.hasUnitState(UNIT_STATE_CHASE_MOVE) || !this.positionOkay(owner, target, maxTarget, angle)) {
        // can we get to the target?
        if (cOwner && !target.isInAccessiblePlaceFor(cOwner)) {
          cOwner.setCannotReachTarget(target.getGUID());
          cOwner.stopMoving();
          this.i_path = null;
          return true;
        }

        // figure out which way we want to move
        let x = target.getPositionX();
        let y = target.getPositionY();
        let z = target.getPositionZ();
        const withinRange = owner.isInDist(target, maxRange);
        const withinLOS = owner.isWithinLOS(x, y, z);
        const moveToward = !(withinRange && withinLOS);

        // make a new path if we have to...
        if (!this.i_path || moveToward !== this._movingTowards) this.i_path = new PathGenerator(owner);
        else this.i_path.clear();

        // Predict chase destination to keep up with chase target
        let additionalRange = 0;
        const predictDestination = !mutualChase && target.isMoving();
        if (predictDestination) {
          let moveType = MOVE_RUN;
          if (target.canFly()) moveType = target.hasUnitMovementFlag(MOVEMENTFLAG_BACKWARD) ? MOVE_FLIGHT_BACK : MOVE_FLIGHT;
          else {
            if (target.isWalking()) moveType = MOVE_WALK;
            else moveType = target.hasUnitMovementFlag(MOVEMENTFLAG_BACKWARD) ? MOVE_RUN_BACK : MOVE_RUN;
          }
          const speed = F(target.getSpeed(moveType) * 0.5);
          additionalRange = owner.getExactDistSq(target) < square(speed) ? 0 : speed;
        }

        let shortenPath: boolean;

        // if we want to move toward the target and there's no fixed angle...
        if (moveToward && !angle) {
          // ...we'll pathfind to the center, then shorten the path
          shortenPath = true;
        } else {
          // otherwise, we fall back to nearpoint finding
          const p = target.getNearPoint(
            owner,
            F(F((moveToward ? maxTarget : minTarget) - chaseRange) - additionalRange),
            0,
            angle ? target.toAbsoluteAngle(angle.RelativeAngle) : target.getAngle(owner),
          );
          x = p.x;
          y = p.y;
          z = p.z;
          shortenPath = false;
        }

        let walk = false;
        if (cOwner && !cOwner.isPet()) {
          switch (cOwner.getMovementTemplate().getChase()) {
            case CreatureChaseMovementType.CanWalk:
              walk = owner.isWalking();
              break;
            case CreatureChaseMovementType.AlwaysWalk:
              walk = true;
              break;
            default:
              break;
          }
        }

        this.dispatchSplineToPosition(owner, x, y, z, walk, shortenPath, maxTarget, forceDest, true);
      }
    }

    return true;
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp ChaseMovementGenerator<Player/Creature>::DoInitialize */
  doInitialize(owner: T): void {
    this.i_path = null;
    this._lastTargetPosition = null;
    this._fallbackPositioning = false;
    const creature = owner.toCreature();
    if (!creature) {
      // `ChaseMovementGenerator<Player>::DoInitialize`
      owner.stopMoving();
      owner.addUnitState(UNIT_STATE_CHASE);
      return;
    }

    // `ChaseMovementGenerator<Creature>::DoInitialize`
    this.i_recheckDistance.reset(0);
    this.i_leashExtensionTimer.reset(creature.getAttackTime(BASE_ATTACK));
    owner.addUnitState(UNIT_STATE_CHASE);
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp ChaseMovementGenerator<T>::DoFinalize */
  doFinalize(owner: T): void {
    owner.clearUnitState(UNIT_STATE_CHASE | UNIT_STATE_CHASE_MOVE);
    const cOwner = owner.toCreature();
    if (cOwner) {
      cOwner.setCannotReachTarget();
    }
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp ChaseMovementGenerator<T>::DoReset */
  doReset(owner: T): void {
    this.doInitialize(owner);
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp ChaseMovementGenerator<T>::MovementInform */
  movementInform(owner: T): void {
    const creature = owner.toCreature();
    if (!creature) return;

    switch (this.m_currentMode) {
      default: {
        // Pass back the GUIDLow of the target. If it is pet's owner then PetAI will handle
        creature.ai()?.MovementInform?.(CHASE_MOTION_TYPE, ObjectGuid.GetCounter(this.getTarget()!.getGUID()));
        break;
      }
      case CHASE_MODE_DISTANCING: {
        creature.ai()?.DistancingEnded?.();
        break;
      }
    }

    this.m_currentMode = CHASE_MODE_NORMAL;
  }
}

//-----------------------------------------------//

/** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp GetTargetSpeedInMotion */
function GetTargetSpeedInMotion(target: MovementOwner): number {
  if (!target.movespline.finalized()) return target.movespline.velocity();

  return target.getSpeed(target.m_movementInfo.getSpeedType());
}

/** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp GetVelocity */
function GetVelocity(owner: MovementOwner, target: MovementOwner, dest: Vector3, playerPet: boolean): number | null {
  let speed: number | null = null;
  if (owner.isInCombat() || owner.isVehicle() || owner.hasUnitFlag(UNIT_FLAG_POSSESSED)) return speed;

  const isPetLike = owner.isPet() || owner.isGuardian() || owner.getGUID() === target.getCritterGUID() || owner.getCharmerOrOwnerGUID() === target.getGUID();

  // For pets/guardians/critters or creature-to-creature follow: sync with target's speed
  if (isPetLike || (owner.isCreature() && target.isCreature())) {
    speed = GetTargetSpeedInMotion(target);

    if (playerPet) {
      const distance = F(F(owner.getDistance2d(dest.x, dest.y) - target.getObjectSize()) - F(speed / 2.0));
      if (distance > 0.0) {
        const multiplier = F(1.0 + F(distance / 10.0));
        speed = F(speed * multiplier);
      }
    }
  }

  return speed;
}

/** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp PredictPosition */
function PredictPosition(target: MovementOwner): Position {
  const pos = target.getPosition();
  // 0.5 - it's time (0.5 sec) between starting movement opcode (e.g. MSG_MOVE_START_FORWARD) and MSG_MOVE_HEARTBEAT sent by client
  const speed = F(target.getSpeed(target.m_movementInfo.getSpeedType()) * 0.5);
  const orientation = target.getOrientation();

  if (target.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_FORWARD)) {
    pos.m_positionX = F(pos.m_positionX + Math.cos(orientation) * speed);
    pos.m_positionY = F(pos.m_positionY + Math.sin(orientation) * speed);
  } else if (target.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_BACKWARD)) {
    pos.m_positionX = F(pos.m_positionX - Math.cos(orientation) * speed);
    pos.m_positionY = F(pos.m_positionY - Math.sin(orientation) * speed);
  }

  if (target.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_STRAFE_LEFT)) {
    pos.m_positionX = F(pos.m_positionX + Math.cos(orientation + M_PI / 2.0) * speed);
    pos.m_positionY = F(pos.m_positionY + Math.sin(orientation + M_PI / 2.0) * speed);
  } else if (target.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_STRAFE_RIGHT)) {
    pos.m_positionX = F(pos.m_positionX + Math.cos(orientation - M_PI / 2.0) * speed);
    pos.m_positionY = F(pos.m_positionY + Math.sin(orientation - M_PI / 2.0) * speed);
  }

  return pos;
}

/** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp IsValidPredictedPosition */
function IsValidPredictedPosition(target: MovementOwner, predicted: Position): boolean {
  const current = target.getPosition();

  if (current.getExactDist2d(predicted) > 15.0) return false;

  // Check line of sight from current to predicted to avoid clipping through geometry
  if (!target.isWithinLOS(predicted.getPositionX(), predicted.getPositionY(), predicted.getPositionZ())) return false;

  return true;
}

/** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h FollowMovementGenerator */
export class FollowMovementGenerator<T extends MovementOwner = MovementOwner> extends MovementGeneratorMedium<T> {
  private readonly _follower: AbstractFollower;
  private i_path: PathGenerator | null = null;
  private i_recheckPredictedDistanceTimer = new TimeTrackerSmall(0);
  private i_recheckPredictedDistance = false;

  private _lastTargetPosition: Position | null = null;
  private _lastPredictedPosition: Position | null = null;
  private _range: number;
  private _angle: ChaseAngle;
  private _inheritWalkState: boolean;
  private _inheritSpeed: boolean;

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h FollowMovementGenerator::FollowMovementGenerator */
  constructor(target: MovementOwner | null, range: number, angle: ChaseAngle, inheritWalkState: boolean, inheritSpeed: boolean) {
    super();
    this._follower = new AbstractFollower(target);
    this._range = F(range);
    this._angle = angle;
    this._inheritWalkState = inheritWalkState;
    this._inheritSpeed = inheritSpeed;
  }

  /** The C++ destructor (`~AbstractFollower`). @ac game/Movement/AbstractFollower.h AbstractFollower::~AbstractFollower */
  override destroy(): void {
    this._follower.destroyFollower();
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h FollowMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return FOLLOW_MOTION_TYPE;
  }

  /** @ac game/Movement/AbstractFollower.cpp AbstractFollower::SetTarget */
  setTarget(unit: MovementOwner | null): void {
    this._follower.setTarget(unit);
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h FollowMovementGenerator::GetTarget */
  getTarget(): MovementOwner | null {
    return this._follower.getTarget();
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h FollowMovementGenerator::unitSpeedChanged */
  override unitSpeedChanged(): void {
    this._lastTargetPosition = null;
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h FollowMovementGenerator::_clearUnitStateMove */
  static _clearUnitStateMove(u: MovementOwner): void {
    u.clearUnitState(UNIT_STATE_FOLLOW_MOVE);
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h FollowMovementGenerator::_addUnitStateMove */
  static _addUnitStateMove(u: MovementOwner): void {
    u.addUnitState(UNIT_STATE_FOLLOW_MOVE);
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.h FollowMovementGenerator::GetFollowRange */
  getFollowRange(): number {
    return this._range;
  }

  /** The `bool& targetIsMoving` out parameter is `targetIsMoving.value`. @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp FollowMovementGenerator<T>::PositionOkay */
  positionOkay(target: MovementOwner, isPlayerPet: boolean, targetIsMoving: { value: boolean }, diff: number): boolean {
    if (!this._lastTargetPosition) return false;

    const exactDistSq = target.getExactDistSq(this._lastTargetPosition.getPositionX(), this._lastTargetPosition.getPositionY(), this._lastTargetPosition.getPositionZ());
    let distanceTolerance = 0.25;
    // For creatures, increase tolerance
    if (target.isCreature()) {
      distanceTolerance = F(distanceTolerance + F(this._range + this._range));
    }

    if (isPlayerPet) {
      targetIsMoving.value = target.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_FORWARD | MOVEMENTFLAG_BACKWARD | MOVEMENTFLAG_STRAFE_LEFT | MOVEMENTFLAG_STRAFE_RIGHT);
    }

    if (exactDistSq > distanceTolerance) return false;

    if (isPlayerPet) {
      if (!targetIsMoving.value) {
        if (this.i_recheckPredictedDistanceTimer.getExpiry()) {
          this.i_recheckPredictedDistanceTimer.update(diff);
          if (this.i_recheckPredictedDistanceTimer.passed()) {
            this.i_recheckPredictedDistanceTimer = new TimeTrackerSmall(0);
            return false;
          }
        }

        return true;
      }

      return false;
    }

    return true;
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp FollowMovementGenerator<T>::DoUpdate */
  doUpdate(owner: T, time_diff: number): boolean {
    const followTarget = this.getTarget();
    if (!followTarget || !followTarget.isInWorld() || !owner.isInMap(followTarget)) return false;

    if (!owner || !owner.isAlive()) return false;

    const cOwner = owner.toCreature();
    const target = followTarget;

    // the owner might be unable to move (rooted or casting), or we have lost the target, pause movement
    if (owner.hasUnitState(UNIT_STATE_NOT_MOVE) || (cOwner && cOwner.isMovementPreventedByCasting())) {
      this.i_path = null;
      owner.stopMoving();
      this._lastTargetPosition = null;
      return true;
    }

    let followingMaster = false;
    if (owner.isPet()) {
      if (target.getGUID() === owner.getOwnerGUID()) followingMaster = true;
    }

    const targetPlayer = this.getTarget()!.toPlayer();
    const forceDest =
      followingMaster || // allow pets following their master to cheat while generating paths
      (targetPlayer !== null && targetPlayer.isGameMaster()); // for .npc follow

    const targetIsMoving = { value: false };
    const isPlayerPet = owner.isGuardian() && target.isPlayer();
    const isFollowingPlayer = target.isPlayer();

    if (this.positionOkay(target, isPlayerPet, targetIsMoving, time_diff)) {
      if (owner.hasUnitState(UNIT_STATE_FOLLOW_MOVE) && owner.movespline.finalized()) {
        owner.clearUnitState(UNIT_STATE_FOLLOW_MOVE);
        this.i_path = null;
        this.movementInform(owner);

        if (this.i_recheckPredictedDistance) {
          this.i_recheckPredictedDistanceTimer.reset(1000);
        }

        owner.setFacingTo(target.getOrientation());
      }
    } else {
      const targetPosition = target.getPosition();
      this._lastTargetPosition = target.getPosition();

      // If player is moving and their position is not updated, we need to predict position
      let predictedTarget = targetPosition;
      if (targetIsMoving.value) {
        const predictedPosition = PredictPosition(target);
        if (this._lastPredictedPosition && this._lastPredictedPosition.getExactDistSq(predictedPosition) < 0.25) return true;

        if (IsValidPredictedPosition(target, predictedPosition)) {
          this._lastPredictedPosition = predictedPosition;
          predictedTarget = new Position(predictedPosition.getPositionX(), predictedPosition.getPositionY(), predictedPosition.getPositionZ(), predictedPosition.getOrientation());
          this.i_recheckPredictedDistance = true;
        } else {
          this._lastPredictedPosition = null;
          this.i_recheckPredictedDistance = false;
        }
      } else {
        this.i_recheckPredictedDistance = false;
        this.i_recheckPredictedDistanceTimer.reset(0);
        this._lastPredictedPosition = null;
      }

      if (!this.i_path) this.i_path = new PathGenerator(owner);
      else this.i_path.clear();

      target.movePositionToFirstCollision(predictedTarget, F(owner.getCombatReach() + this._range), F(target.toAbsoluteAngle(this._angle.RelativeAngle) - target.getOrientation()));

      let x = predictedTarget.getPositionX();
      let y = predictedTarget.getPositionY();
      let z = predictedTarget.getPositionZ();

      if (owner.isHovering()) z = owner.updateAllowedPositionZ(x, y, z);

      const success = this.i_path.calculatePath(x, y, z, forceDest);
      if (!success || (this.i_path.getPathType() & PATHFIND_NOPATH && !followingMaster)) {
        if (!owner.isStopped()) owner.stopMoving();

        // Teleport if stuck and too far away
        if (cOwner && isFollowingPlayer) {
          const distance = owner.getDistance2d(target);
          if (distance > 20.0) {
            const tele = target.getClosePoint(owner.getCombatReach());
            const teleZ = owner.getMapHeight(tele.x, tele.y, tele.z);
            owner.nearTeleportTo(tele.x, tele.y, teleZ, target.getOrientation());
            this._lastTargetPosition = null;
            this._lastPredictedPosition = null;
          }
        }
        return true;
      }

      owner.addUnitState(UNIT_STATE_FOLLOW_MOVE);

      const init = new MoveSplineInit(owner);
      init.movebyPath(this.i_path.getPath() as Vector3[]);
      if (this._inheritWalkState) init.setWalk(target.isWalking());

      if (this._inheritSpeed) {
        const velocity = GetVelocity(owner, target, this.i_path.getActualEndPosition(), owner.isGuardian());
        if (velocity !== null) init.setVelocity(velocity);
      }
      init.launch();
    }

    return true;
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp FollowMovementGenerator<T>::DoInitialize */
  doInitialize(owner: T): void {
    this.i_path = null;
    this._lastTargetPosition = null;
    owner.addUnitState(UNIT_STATE_FOLLOW);
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp FollowMovementGenerator<T>::DoFinalize */
  doFinalize(owner: T): void {
    owner.clearUnitState(UNIT_STATE_FOLLOW | UNIT_STATE_FOLLOW_MOVE);
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp FollowMovementGenerator<T>::DoReset */
  doReset(owner: T): void {
    this.doInitialize(owner);
  }

  /** @ac game/Movement/MovementGenerators/TargetedMovementGenerator.cpp FollowMovementGenerator<T>::MovementInform */
  movementInform(owner: T): void {
    const creature = owner.toCreature();
    if (!creature) return;

    // Pass back the GUIDLow of the target. If it is pet's owner then PetAI will handle
    creature.ai()?.MovementInform?.(FOLLOW_MOTION_TYPE, ObjectGuid.GetCounter(this.getTarget()!.getGUID()));
  }
}
