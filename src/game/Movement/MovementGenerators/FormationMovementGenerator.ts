/**
 * Port of `game/Movement/MovementGenerators/FormationMovementGenerator.{h,cpp}`: a formation member follows its leader's
 * spline at an offset (distance and angle from `creature_formations`), relaunching every 1.2 s while the leader moves.
 */
import { UNIT_STATE_FOLLOW_MOVE, UNIT_STATE_NOT_MOVE, MOVE_WALK } from "../../../spells/enums.ts";
import { TimeTracker } from "../../time/timer.ts";
import { NormalizeOrientation, Position } from "../../Entities/Object/Position.ts";
import { AbstractFollower } from "../AbstractFollower.ts";
import { MovementGeneratorMedium } from "../MovementGenerator.ts";
import { FORMATION_MOTION_TYPE, type MovementGeneratorType } from "../MotionMaster.ts";
import type { MovementOwner, MovementOwnerCreature } from "../MovementOwner.ts";
import { MoveSplineInit } from "../Spline/MoveSplineInit.ts";

const F = Math.fround;

/** @ac game/Movement/MovementGenerators/FormationMovementGenerator.h FormationMovementGenerator */
export class FormationMovementGenerator extends MovementGeneratorMedium<MovementOwnerCreature> {
  private static readonly FORMATION_MOVEMENT_INTERVAL = 1200;

  private readonly _follower: AbstractFollower;
  private readonly _range: number;
  private _angle: number;
  private readonly _point1: number;
  private readonly _point2: number;
  private _lastLeaderSplineID = 0;
  private _hasPredictedDestination = false;
  private _isMoving = false;

  private readonly _lastLeaderPosition = new Position();
  private readonly _nextMoveTimer = new TimeTracker(0);

  /** @ac game/Movement/MovementGenerators/FormationMovementGenerator.cpp FormationMovementGenerator::FormationMovementGenerator */
  constructor(leader: MovementOwner | null, range: number, angle: number, point1: number, point2: number) {
    super();
    this._follower = new AbstractFollower(leader);
    this._range = F(range);
    this._angle = F(angle);
    this._point1 = point1;
    this._point2 = point2;
  }

  /** The C++ destructor (`~AbstractFollower`). @ac game/Movement/AbstractFollower.h AbstractFollower::~AbstractFollower */
  override destroy(): void {
    this._follower.destroyFollower();
  }

  /** @ac game/Movement/AbstractFollower.h AbstractFollower::GetTarget */
  getTarget(): MovementOwner | null {
    return this._follower.getTarget();
  }

  /** @ac game/Movement/MovementGenerators/FormationMovementGenerator.h FormationMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return FORMATION_MOTION_TYPE;
  }

  /** @ac game/Movement/MovementGenerators/FormationMovementGenerator.cpp FormationMovementGenerator::DoInitialize */
  doInitialize(owner: MovementOwnerCreature): void {
    if (owner.hasUnitState(UNIT_STATE_NOT_MOVE) || owner.isMovementPreventedByCasting()) {
      owner.stopMoving();
      return;
    }

    this._nextMoveTimer.reset(0);
  }

  /** @ac game/Movement/MovementGenerators/FormationMovementGenerator.cpp FormationMovementGenerator::DoFinalize */
  doFinalize(owner: MovementOwnerCreature): void {
    owner.clearUnitState(UNIT_STATE_FOLLOW_MOVE);
  }

  /** @ac game/Movement/MovementGenerators/FormationMovementGenerator.cpp FormationMovementGenerator::DoReset */
  doReset(owner: MovementOwnerCreature): void {
    this.doInitialize(owner);
  }

  /** @ac game/Movement/MovementGenerators/FormationMovementGenerator.cpp FormationMovementGenerator::DoUpdate */
  doUpdate(owner: MovementOwnerCreature, diff: number): boolean {
    const target = this.getTarget();
    if (!owner || !target) return false;

    if (owner.hasUnitState(UNIT_STATE_NOT_MOVE) || owner.isMovementPreventedByCasting()) {
      owner.stopMoving();
      this._nextMoveTimer.reset(0);
      this._hasPredictedDestination = false;
      this._isMoving = false;
      return true;
    }

    if (target.movespline.finalized() && target.movespline.getId() === this._lastLeaderSplineID && this._hasPredictedDestination) {
      owner.stopMoving();
      this._nextMoveTimer.reset(0);
      this._hasPredictedDestination = false;
      this._isMoving = false;
      return true;
    }

    if (!owner.movespline.finalized()) owner.setHomePosition(owner.getPosition());

    if (!target.movespline.finalized() && target.movespline.getId() !== this._lastLeaderSplineID) {
      const targetCreature = target.toCreature();
      if (this._point1 && targetCreature) {
        const formation = targetCreature.getFormation();
        if (formation) {
          const leader = formation.getLeader();
          if (leader) {
            const currentWaypoint = leader.getCurrentWaypointID() + 1;
            if (currentWaypoint === this._point1 || currentWaypoint === this._point2) this._angle = F(NormalizeOrientation(F(F(2 * Math.PI) - this._angle)));
          }
        }
      }

      this.launchMovement(owner, target);
      this._lastLeaderSplineID = target.movespline.getId();
      return true;
    }

    this._nextMoveTimer.update(diff);
    if (this._nextMoveTimer.passed()) {
      this._nextMoveTimer.reset(FormationMovementGenerator.FORMATION_MOVEMENT_INTERVAL);

      if (!this._lastLeaderPosition.equals(target.getPosition())) {
        this.launchMovement(owner, target);
        return true;
      }
    }

    if (this._isMoving && owner.movespline.finalized()) {
      this._isMoving = false;
      owner.setFacingTo(target.getOrientation());
      this.movementInform(owner);
    }

    return true;
  }

  /** @ac game/Movement/MovementGenerators/FormationMovementGenerator.cpp FormationMovementGenerator::LaunchMovement */
  private launchMovement(owner: MovementOwnerCreature, target: MovementOwner): void {
    let relativeAngle = 0.0;

    if (!target.movespline.finalized()) {
      const leaderDestination = target.movespline.currentDestination();
      relativeAngle = target.getRelativeAngle(leaderDestination.x, leaderDestination.y);
    }

    const dest = target.getPosition();
    let velocity = 0.0;

    if (!target.movespline.finalized()) {
      // Pick up leader's spline velocity
      velocity = target.movespline.velocity();

      // Calculate travel distance to get a 1650ms result
      const travelDist = F(velocity * 1.65);
      target.movePositionToFirstCollision(dest, travelDist, relativeAngle);
      target.movePositionToFirstCollision(dest, this._range, F(this._angle + relativeAngle));

      const distance = owner.getExactDist(dest);
      const velocityMod = Math.min(F(distance / travelDist), 1.5);

      velocity = F(velocity * velocityMod);
      this._hasPredictedDestination = true;
    } else {
      target.movePositionToFirstCollision(dest, this._range, F(this._angle + relativeAngle));
      this._hasPredictedDestination = false;
    }

    if (velocity === 0.0) velocity = target.getSpeed(MOVE_WALK);

    const init = new MoveSplineInit(owner);
    init.moveTo(dest.getPositionX(), dest.getPositionY(), dest.getPositionZ());
    init.setVelocity(velocity);
    init.launch();

    this._lastLeaderPosition.relocate(target.getPosition());
    this._isMoving = true;
    owner.addUnitState(UNIT_STATE_FOLLOW_MOVE);
  }

  /** @ac game/Movement/MovementGenerators/FormationMovementGenerator.cpp FormationMovementGenerator::MovementInform */
  private movementInform(owner: MovementOwnerCreature): void {
    owner.ai()?.MovementInform?.(FORMATION_MOTION_TYPE, 0);
  }
}
