/**
 * Port of `game/Movement/MovementGenerators/FleeingMovementGenerator.{h,cpp}`: a unit runs away from its fleeing source
 * (fear), picking points on the navmesh at a quiet distance; `TimedFleeingMovementGenerator` is the creature version that
 * ends after a time (fleeing for assistance).
 *
 * The `DoFinalize` specializations of `Player` and `Creature` are one method that branches on `owner.toCreature()`.
 */
import { frand, urand } from "../../../common/random.ts";
import {
  UNIT_FLAG_FLEEING,
  UNIT_STATE_FLEEING,
  UNIT_STATE_FLEEING_MOVE,
  UNIT_STATE_NOT_MOVE,
} from "../../../spells/enums.ts";
import { TimeTracker } from "../../time/timer.ts";
import { MovementGeneratorMedium } from "../MovementGenerator.ts";
import { FLEEING_MOTION_TYPE, TIMED_FLEEING_MOTION_TYPE, type MovementGeneratorType } from "../MotionMaster.ts";
import type { MovementOwner, MovementOwnerCreature } from "../MovementOwner.ts";
import { MoveSplineInit } from "../Spline/MoveSplineInit.ts";
import { PATHFIND_FARFROMPOLY, PATHFIND_NOPATH, PATHFIND_NOT_USING_PATH, PATHFIND_SHORTCUT, PathGenerator } from "./PathGenerator.ts";
import { Position } from "../../Entities/Object/Position.ts";
import type { Vector3 } from "../../../math/Vector3.ts";

const F = Math.fround;
const M_PI = Math.PI;

/** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.cpp MIN_QUIET_DISTANCE */
const MIN_QUIET_DISTANCE = 28.0;
/** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.cpp MAX_QUIET_DISTANCE */
const MAX_QUIET_DISTANCE = 43.0;
/** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.cpp MIN_PATH_LENGTH */
const MIN_PATH_LENGTH = 2.0;

/** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.h FleeingMovementGenerator */
export class FleeingMovementGenerator<T extends MovementOwner = MovementOwner> extends MovementGeneratorMedium<T> {
  private _path: PathGenerator | null = null;
  private _fleeTargetGUID: bigint;
  private _timer = new TimeTracker(0);
  private _interrupt = false;
  private _invalidPathsCount = 0;

  /** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.h FleeingMovementGenerator::FleeingMovementGenerator */
  constructor(fleeTargetGUID: bigint) {
    super();
    this._fleeTargetGUID = fleeTargetGUID;
  }

  /** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.h FleeingMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return FLEEING_MOTION_TYPE;
  }

  /** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.cpp FleeingMovementGenerator<T>::DoInitialize */
  doInitialize(owner: T): void {
    if (!owner) {
      return;
    }

    owner.stopMoving();
    this._path = null;
    owner.setUnitFlag(UNIT_FLAG_FLEEING);
    owner.addUnitState(UNIT_STATE_FLEEING);
    this.setTargetLocation(owner);
  }

  /** `FleeingMovementGenerator<Player>::DoFinalize` and `<Creature>::DoFinalize`. @ac game/Movement/MovementGenerators/FleeingMovementGenerator.cpp FleeingMovementGenerator<T>::DoFinalize */
  doFinalize(owner: T): void {
    if (owner.isPlayer()) {
      owner.removeUnitFlag(UNIT_FLAG_FLEEING);
      owner.clearUnitState(UNIT_STATE_FLEEING);
      owner.stopMoving();
      return;
    }

    owner.removeUnitFlag(UNIT_FLAG_FLEEING);
    owner.clearUnitState(UNIT_STATE_FLEEING | UNIT_STATE_FLEEING_MOVE);

    const victim = owner.getVictim();
    if (victim) {
      owner.setTarget(victim.getGUID());
    }
  }

  /** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.cpp FleeingMovementGenerator<T>::DoReset */
  doReset(owner: T): void {
    this.doInitialize(owner);
  }

  /** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.cpp FleeingMovementGenerator<T>::DoUpdate */
  doUpdate(owner: T, diff: number): boolean {
    if (!owner || !owner.isAlive()) {
      return false;
    }

    if (owner.hasUnitState(UNIT_STATE_NOT_MOVE) || owner.isMovementPreventedByCasting()) {
      this._path = null;
      this._interrupt = true;
      owner.stopMoving();
      return true;
    } else this._interrupt = false;

    this._timer.update(diff);
    if (!this._interrupt && this._timer.passed() && owner.movespline.finalized()) {
      this.setTargetLocation(owner);
    }

    return true;
  }

  /** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.cpp FleeingMovementGenerator<T>::SetTargetLocation */
  private setTargetLocation(owner: T): void {
    if (!owner) {
      return;
    }

    if (owner.hasUnitState(UNIT_STATE_NOT_MOVE) || owner.isMovementPreventedByCasting()) {
      this._path = null;
      this._interrupt = true;
      owner.stopMoving();
      return;
    }

    owner.addUnitState(UNIT_STATE_FLEEING_MOVE);

    const destination = owner.getPosition();
    this.getPoint(owner, destination);

    // Add LOS check for target point
    if (!owner.isWithinLOS(destination.getPositionX(), destination.getPositionY(), destination.getPositionZ())) {
      this._timer.reset(200);
      return;
    }

    if (!this._path) {
      this._path = new PathGenerator(owner);
    } else {
      this._path.clear();
    }

    if (owner.isPlayer()) this._path.setSlopeCheck(true);

    this._path.setPathLengthLimit(30.0);
    const result = this._path.calculatePath(destination.getPositionX(), destination.getPositionY(), destination.getPositionZ());
    if (!result || this._path.getPathType() & (PATHFIND_NOPATH | PATHFIND_SHORTCUT | PATHFIND_FARFROMPOLY | PATHFIND_NOT_USING_PATH)) {
      if (this._fleeTargetGUID !== 0n) ++this._invalidPathsCount;

      this._timer.reset(100);
      return;
    }

    // Same position - recheck
    if (this._path.getPathLength() < MIN_PATH_LENGTH) {
      if (this._fleeTargetGUID !== 0n) ++this._invalidPathsCount;

      this._timer.reset(100);
      return;
    }

    this._invalidPathsCount = 0;

    const init = new MoveSplineInit(owner);
    init.movebyPath(this._path.getPath() as Vector3[]);
    init.setWalk(false);
    const traveltime = init.launch();
    this._timer.reset(traveltime + urand(800, 1500));
  }

  /** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.cpp FleeingMovementGenerator<T>::GetPoint */
  private getPoint(owner: T, position: Position): void {
    let casterDistance = 0.0;
    let casterAngle = 0.0;
    let fleeTarget: MovementOwner | null = null;
    if (this._invalidPathsCount < 5) fleeTarget = owner.getUnit(this._fleeTargetGUID);

    if (fleeTarget) {
      casterDistance = fleeTarget.getDistance(owner);
      if (casterDistance > F(0.2)) {
        casterAngle = fleeTarget.getAngle(owner);
      } else {
        casterAngle = frand(0.0, F(2.0 * F(M_PI)));
      }
    } else {
      casterDistance = 0.0;
      casterAngle = frand(0.0, F(2.0 * F(M_PI)));
    }

    let distance = 0.0;
    let angle = 0.0;
    if (casterDistance < MIN_QUIET_DISTANCE) {
      distance = F(frand(F(0.4), F(1.3)) * F(MIN_QUIET_DISTANCE - casterDistance));
      angle = F(casterAngle + frand(F(-F(M_PI) / 8.0), F(F(M_PI) / 8.0)));
    } else if (casterDistance > MAX_QUIET_DISTANCE) {
      distance = F(frand(F(0.4), 1.0) * (MAX_QUIET_DISTANCE - MIN_QUIET_DISTANCE));
      angle = F(-casterAngle + frand(F(-F(M_PI) / 4.0), F(F(M_PI) / 4.0)));
    } // we are inside quiet range
    else {
      distance = F(frand(F(0.6), F(1.2)) * (MAX_QUIET_DISTANCE - MIN_QUIET_DISTANCE));
      angle = frand(0.0, F(2.0 * F(M_PI)));
    }

    // In MovePositionToFirstCollision we have added owner's orientation
    // so now let's subtract it
    angle = F(angle - owner.getOrientation());

    owner.movePositionToFirstCollision(position, distance, angle);
  }
}

/** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.h TimedFleeingMovementGenerator */
export class TimedFleeingMovementGenerator extends FleeingMovementGenerator<MovementOwnerCreature> {
  private i_totalFleeTime: TimeTracker;

  /** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.h TimedFleeingMovementGenerator::TimedFleeingMovementGenerator */
  constructor(fright: bigint, time: number) {
    super(fright);
    this.i_totalFleeTime = new TimeTracker(time);
  }

  /** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.h TimedFleeingMovementGenerator::GetMovementGeneratorType */
  override getMovementGeneratorType(): MovementGeneratorType {
    return TIMED_FLEEING_MOTION_TYPE;
  }

  /** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.cpp TimedFleeingMovementGenerator::Finalize */
  override finalize(owner: MovementOwner): void {
    owner.removeUnitFlag(UNIT_FLAG_FLEEING);
    owner.clearUnitState(UNIT_STATE_FLEEING | UNIT_STATE_FLEEING_MOVE);

    const victim = owner.getVictim();
    if (victim) {
      if (owner.isAlive()) {
        owner.attackStop();
        const ownerCreature = owner.toCreature();
        if (ownerCreature) ownerCreature.ai()?.AttackStart?.(victim);
      }
    }

    const ownerCreature = owner.toCreature();
    if (ownerCreature) {
      ownerCreature.ai()?.MovementInform?.(TIMED_FLEEING_MOTION_TYPE, 0);
    }
  }

  /** @ac game/Movement/MovementGenerators/FleeingMovementGenerator.cpp TimedFleeingMovementGenerator::Update */
  override update(owner: MovementOwner, time_diff: number): boolean {
    if (!owner.isAlive()) return false;

    if (owner.hasUnitState(UNIT_STATE_NOT_MOVE) || owner.isMovementPreventedByCasting()) {
      owner.stopMoving();
      return true;
    }

    this.i_totalFleeTime.update(time_diff);
    if (this.i_totalFleeTime.passed()) return false;

    // This calls grant-parent Update method hiden by FleeingMovementGenerator::Update(Creature &, uint32) version
    // This is done instead of casting Unit& to Creature& and call parent method, then we can use Unit directly
    return super.update(owner, time_diff);
  }
}

