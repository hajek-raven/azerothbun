/**
 * Port of `game/Movement/MovementGenerators/PointMovementGenerator.{h,cpp}`: move a unit to a point (`MovePoint`, charges),
 * `AssistanceMovementGenerator` (the first half of a creature fleeing for assistance) and `EffectMovementGenerator` (a
 * spline launched by a knockback, jump, fall, land or takeoff: it only keeps the previous generator from interrupting it).
 */
import { fuzzyEq } from "../../../math/g3dmath.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { UNIT_STATE_CHARGING, UNIT_STATE_NOT_MOVE, UNIT_STATE_ROAMING, UNIT_STATE_ROAMING_MOVE } from "../../../spells/enums.ts";
import { ServerConfig } from "../../world/world-config-data.ts";
import { sWorld } from "../../world/world.ts";
import { MovementGenerator, MovementGeneratorMedium } from "../MovementGenerator.ts";
import {
  ASSISTANCE_MOTION_TYPE,
  EFFECT_MOTION_TYPE,
  FORCED_MOVEMENT_NONE,
  FORCED_MOVEMENT_RUN,
  FORCED_MOVEMENT_WALK,
  type AnimTier,
  type ForcedMovement,
  type MovementGeneratorType,
  POINT_MOTION_TYPE,
} from "../MotionMaster.ts";
import { EVENT_CHARGE, EVENT_CHARGE_PREPATH, MOVEMENTFLAG_FALLING, type MovementOwner, type MovementOwnerCreature } from "../MovementOwner.ts";
import { MoveSplineInit } from "../Spline/MoveSplineInit.ts";
import { PATHFIND_NOPATH, PathGenerator, type PointsArray } from "./PathGenerator.ts";

const F = Math.fround;
/** `std::numeric_limits<float>::max()` */
const FLT_MAX = 3.4028234663852886e38;

/** @ac game/Movement/MovementGenerators/PointMovementGenerator.h PointMovementGenerator */
export class PointMovementGenerator<T extends MovementOwner = MovementOwner> extends MovementGeneratorMedium<T> {
  private id: number;
  private i_x: number;
  private i_y: number;
  private i_z: number;
  private speed: number;
  private i_orientation: number;
  private i_recalculateSpeed = false;
  private m_precomputedPath: PointsArray = [];
  private _generatePath: boolean;
  private _forceDestination: boolean;
  private _reverseOrientation: boolean;
  private _chargeTargetGUID: bigint;
  private _forcedMovement: ForcedMovement;
  private _animTier: AnimTier | null;
  private _stalled = false;
  private _hasBeenStalled = false;
  private _pauseTime: number | null = null;

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.h PointMovementGenerator::PointMovementGenerator */
  constructor(
    _id: number,
    _x: number,
    _y: number,
    _z: number,
    forcedMovement: ForcedMovement,
    _speed = 0.0,
    orientation = 0.0,
    _path: PointsArray | null = null,
    generatePath = false,
    forceDestination = false,
    animTier: AnimTier | null = null,
    chargeTargetGUID = 0n,
    reverseOrientation = false,
  ) {
    super();
    this.id = _id;
    this.i_x = F(_x);
    this.i_y = F(_y);
    this.i_z = F(_z);
    this.speed = F(_speed);
    this.i_orientation = F(orientation);
    this._generatePath = generatePath;
    this._forceDestination = forceDestination;
    this._reverseOrientation = reverseOrientation;
    this._chargeTargetGUID = chargeTargetGUID;
    this._forcedMovement = forcedMovement;
    this._animTier = animTier;
    if (_path) this.m_precomputedPath = _path.map((p) => new Vector3(p.x, p.y, p.z));
  }

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.h PointMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return POINT_MOTION_TYPE;
  }

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.h PointMovementGenerator::unitSpeedChanged */
  override unitSpeedChanged(): void {
    this.i_recalculateSpeed = true;
  }

  /** The `float& x, y, z` out parameters are `dest`. @ac game/Movement/MovementGenerators/PointMovementGenerator.h PointMovementGenerator::GetDestination */
  getDestination(dest: { x: number; y: number; z: number }): boolean {
    dest.x = this.i_x;
    dest.y = this.i_y;
    dest.z = this.i_z;
    return true;
  }

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.cpp PointMovementGenerator<T>::DoInitialize */
  doInitialize(unit: T): void {
    this._stalled = false;
    this._hasBeenStalled = false;
    this._pauseTime = null;

    if (unit.hasUnitState(UNIT_STATE_NOT_MOVE) || unit.isMovementPreventedByCasting()) {
      // the next line is to ensure that a new spline is created in DoUpdate() once the unit is no longer rooted/stunned
      /// @todo: rename this flag to something more appropriate since it is set to true even without speed change now.
      this.i_recalculateSpeed = true;
      return;
    }

    if (!unit.isStopped()) unit.stopMoving();

    unit.addUnitState(UNIT_STATE_ROAMING | UNIT_STATE_ROAMING_MOVE);
    if (this.id === EVENT_CHARGE || this.id === EVENT_CHARGE_PREPATH) {
      unit.addUnitState(UNIT_STATE_CHARGING);
    }

    this.i_recalculateSpeed = false;
    const init = new MoveSplineInit(unit);

    if (this._reverseOrientation) init.setOrientationInversed();

    if (this.m_precomputedPath.length > 2)
      // pussywizard: for charge
      init.movebyPath(this.m_precomputedPath);
    else if (this._generatePath) {
      const path = new PathGenerator(unit);
      const result = path.calculatePath(this.i_x, this.i_y, this.i_z, this._forceDestination);
      if (result && !(path.getPathType() & PATHFIND_NOPATH) && path.getPath().length > 2) {
        this.m_precomputedPath = path.getPath().map((p) => new Vector3(p.x, p.y, p.z));
        init.movebyPath(this.m_precomputedPath);
      } else {
        // Xinef: fix strange client visual bug, moving on z coordinate only switches orientation by 180 degrees (visual only)
        if (fuzzyEq(unit.getPositionX(), this.i_x) && fuzzyEq(unit.getPositionY(), this.i_y)) {
          this.i_x = F(this.i_x + F(0.2 * F(Math.cos(unit.getOrientation()))));
          this.i_y = F(this.i_y + F(0.2 * F(Math.sin(unit.getOrientation()))));
        }

        init.moveTo(this.i_x, this.i_y, this.i_z, true);
      }
    } else {
      // Xinef: fix strange client visual bug, moving on z coordinate only switches orientation by 180 degrees (visual only)
      if (fuzzyEq(unit.getPositionX(), this.i_x) && fuzzyEq(unit.getPositionY(), this.i_y)) {
        this.i_x = F(this.i_x + F(0.2 * F(Math.cos(unit.getOrientation()))));
        this.i_y = F(this.i_y + F(0.2 * F(Math.sin(unit.getOrientation()))));
      }

      init.moveTo(this.i_x, this.i_y, this.i_z, true);
    }
    if (this.speed > 0.0) init.setVelocity(this.speed);

    if (this._forcedMovement === FORCED_MOVEMENT_WALK) init.setWalk(true);
    else if (this._forcedMovement === FORCED_MOVEMENT_RUN) init.setWalk(false);

    if (this.i_orientation > 0.0) {
      init.setFacing(this.i_orientation);
    }

    if (this._animTier !== null) init.setAnimation(this._animTier);

    init.launch();
  }

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.cpp PointMovementGenerator<T>::DoUpdate */
  doUpdate(unit: T, diff: number): boolean {
    if (!unit) return false;

    if (unit.isMovementPreventedByCasting()) {
      unit.stopMoving();
      return true;
    }

    if (unit.hasUnitState(UNIT_STATE_NOT_MOVE)) {
      if (!unit.hasUnitState(UNIT_STATE_CHARGING)) unit.stopMoving();
      return true;
    }

    unit.addUnitState(UNIT_STATE_ROAMING_MOVE);

    if (this._pauseTime !== null) {
      if (diff >= this._pauseTime >>> 0) this._pauseTime = null;
      else {
        this._pauseTime = (this._pauseTime - diff) | 0;
        return true;
      }

      this._hasBeenStalled = false;
      this._stalled = false;
      this.i_recalculateSpeed = true;
    }

    // Relaunch path when speed changed or when resuming from a stall.
    // Keep an indefinitely paused movement stalled until Resume() clears _stalled.
    if (this.id !== EVENT_CHARGE_PREPATH && !this._stalled && (this.i_recalculateSpeed || this._hasBeenStalled)) {
      this.i_recalculateSpeed = false;
      const init = new MoveSplineInit(unit);

      if (this._reverseOrientation) init.setOrientationInversed();

      const rebasePrecomputedPath = (offset: number | null = null): PointsArray => {
        const rebasedPath: PointsArray = [];
        const currentPos = new Vector3(unit.getPositionX(), unit.getPositionY(), unit.getPositionZ());

        if (this.m_precomputedPath.length === 0) return rebasedPath;

        if (offset !== null) {
          if (offset >= this.m_precomputedPath.length) {
            rebasedPath.push(currentPos);
            rebasedPath.push(this.m_precomputedPath[this.m_precomputedPath.length - 1]!);
            return rebasedPath;
          }

          rebasedPath.push(...this.m_precomputedPath.slice(offset));
        } else {
          let closestPointIndex = 0;
          let closestPointDist = FLT_MAX;
          for (let pointIndex = 1; pointIndex < this.m_precomputedPath.length; ++pointIndex) {
            const sqDist = F(currentPos.minus(this.m_precomputedPath[pointIndex]!).squaredMagnitude());
            if (sqDist < closestPointDist) {
              closestPointDist = sqDist;
              closestPointIndex = pointIndex;
            }
          }

          rebasedPath.push(...this.m_precomputedPath.slice(closestPointIndex));
        }

        // MovebyPath requires the first point to be the mover's current position.
        rebasedPath.unshift(currentPos);
        return rebasedPath;
      };

      if (this.m_precomputedPath.length) {
        if (!unit.movespline.finalized()) {
          const offset = Math.min(unit.movespline._currentSplineIdx() >>> 0, this.m_precomputedPath.length);
          this.m_precomputedPath = rebasePrecomputedPath(offset);

          if (this.m_precomputedPath.length > 2) init.movebyPath(this.m_precomputedPath);
          else if (this.m_precomputedPath.length === 2) init.moveTo(this.m_precomputedPath[1]!.x, this.m_precomputedPath[1]!.y, this.m_precomputedPath[1]!.z, true);
        } else {
          // Unit was stopped (finalized) due to Pause/StopMoving; trim path from current position.
          this.m_precomputedPath = rebasePrecomputedPath();

          if (this.m_precomputedPath.length > 2) init.movebyPath(this.m_precomputedPath);
          else if (this.m_precomputedPath.length === 2) init.moveTo(this.m_precomputedPath[1]!.x, this.m_precomputedPath[1]!.y, this.m_precomputedPath[1]!.z, true);
          else init.moveTo(this.i_x, this.i_y, this.i_z, true);
        }
      } else init.moveTo(this.i_x, this.i_y, this.i_z, true);

      if (this.speed > 0.0)
        // Default value for point motion type is 0.0, if 0.0 spline will use GetSpeed on unit
        init.setVelocity(this.speed);

      if (this._forcedMovement === FORCED_MOVEMENT_WALK) init.setWalk(true);
      else if (this._forcedMovement === FORCED_MOVEMENT_RUN) init.setWalk(false);

      if (this._animTier !== null) init.setAnimation(this._animTier);

      if (this.i_orientation > 0.0) init.setFacing(this.i_orientation);

      init.launch();
    }

    // If finalized but we were stalled (paused) keep generator active so Finalize() won't be called
    if (unit.movespline.finalized()) {
      if (this._hasBeenStalled) return true;

      return false;
    }

    return true;
  }

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.cpp PointMovementGenerator<T>::DoFinalize */
  doFinalize(unit: T): void {
    unit.clearUnitState(UNIT_STATE_ROAMING | UNIT_STATE_ROAMING_MOVE);
    if (this.id === EVENT_CHARGE || this.id === EVENT_CHARGE_PREPATH) {
      unit.clearUnitState(UNIT_STATE_CHARGING);

      if (this._chargeTargetGUID !== 0n && this._chargeTargetGUID === unit.getTarget()) {
        const target = unit.getUnit(this._chargeTargetGUID);
        if (target) {
          unit.attack(target, true);
        }
      }
    }

    // Only inform AI if this is a real arrival, not a finalize caused by a Pause/Stop
    if (unit.movespline.finalized() && !this._hasBeenStalled) this.movementInform(unit);
  }

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.cpp PointMovementGenerator<T>::Pause */
  override pause(timer = 0): void {
    this._stalled = timer ? false : true;
    this._hasBeenStalled = true;
    if (timer) this._pauseTime = timer | 0;
    else this._pauseTime = null;
  }

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.cpp PointMovementGenerator<T>::Resume */
  override resume(overrideTimer = 0): void {
    this._hasBeenStalled = false;
    this._stalled = false;
    if (overrideTimer) this._pauseTime = overrideTimer | 0;
    else this._pauseTime = null;

    this.i_recalculateSpeed = true;
  }

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.cpp PointMovementGenerator<T>::DoReset */
  doReset(unit: T): void {
    if (!unit.isStopped()) unit.stopMoving();

    unit.addUnitState(UNIT_STATE_ROAMING | UNIT_STATE_ROAMING_MOVE);
    if (this.id === EVENT_CHARGE || this.id === EVENT_CHARGE_PREPATH) {
      unit.addUnitState(UNIT_STATE_CHARGING);
    }
  }

  /** `PointMovementGenerator<T>::MovementInform` does nothing; the `<Creature>` specialization informs the AI. @ac game/Movement/MovementGenerators/PointMovementGenerator.cpp PointMovementGenerator<Creature>::MovementInform */
  movementInform(unit: T): void {
    const creature = unit.toCreature();
    if (!creature) return;

    creature.ai()?.MovementInform?.(POINT_MOTION_TYPE, this.id);

    const summoner = creature.getCharmerOrOwner();
    if (summoner) {
      summoner.getAI()?.SummonMovementInform?.(creature, POINT_MOTION_TYPE, this.id);
    } else {
      // `if (TempSummon* tempSummon = unit->ToTempSummon())`
      const tempSummoner = creature.getSummonerUnit();
      if (tempSummoner) tempSummoner.getAI()?.SummonMovementInform?.(creature, POINT_MOTION_TYPE, this.id);
    }
  }
}

/** @ac game/Movement/MovementGenerators/PointMovementGenerator.h AssistanceMovementGenerator */
export class AssistanceMovementGenerator extends PointMovementGenerator<MovementOwnerCreature> {
  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.h AssistanceMovementGenerator::AssistanceMovementGenerator */
  constructor(_x: number, _y: number, _z: number) {
    super(0, _x, _y, _z, FORCED_MOVEMENT_NONE);
  }

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.h AssistanceMovementGenerator::GetMovementGeneratorType */
  override getMovementGeneratorType(): MovementGeneratorType {
    return ASSISTANCE_MOTION_TYPE;
  }

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.cpp AssistanceMovementGenerator::Finalize */
  override finalize(unit: MovementOwner): void {
    const creature = unit.toCreature()!;
    creature.setNoCallAssistance(false);
    creature.callAssistance();
    if (unit.isAlive()) unit.getMotionMaster().moveSeekAssistanceDistract(sWorld().getIntConfig(ServerConfig.CONFIG_CREATURE_FAMILY_ASSISTANCE_DELAY));
  }
}

/**
 * Does almost nothing - just doesn't allows previous movegen interrupt current effect.
 * @ac game/Movement/MovementGenerators/PointMovementGenerator.h EffectMovementGenerator
 */
export class EffectMovementGenerator extends MovementGenerator {
  private m_Id: number;
  private i_spline: MoveSplineInit;

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.h EffectMovementGenerator::EffectMovementGenerator */
  constructor(spline: MoveSplineInit, Id: number) {
    super();
    this.m_Id = Id;
    this.i_spline = spline;
  }

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.cpp EffectMovementGenerator::Initialize */
  initialize(_unit: MovementOwner): void {
    this.i_spline.launch();
  }

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.cpp EffectMovementGenerator::Finalize */
  finalize(unit: MovementOwner): void {
    if (!unit.isCreature()) return;

    if (unit.isCreature() && unit.hasUnitMovementFlag(MOVEMENTFLAG_FALLING) && unit.movespline.isFalling())
      // pussywizard
      unit.removeUnitMovementFlag(MOVEMENTFLAG_FALLING);

    // Need restore previous movement since we have no proper states system
    //if (unit->IsAlive() && !unit->HasUnitState(UNIT_STATE_CONFUSED | UNIT_STATE_FLEEING))
    //{
    //    if (Unit* victim = unit->GetVictim())
    //        unit->GetMotionMaster()->MoveChase(victim);
    //    else
    //        unit->GetMotionMaster()->Initialize();
    //}

    unit.toCreature()!.ai()?.MovementInform?.(EFFECT_MOTION_TYPE, this.m_Id);
  }

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.h EffectMovementGenerator::Reset */
  reset(_unit: MovementOwner): void {}

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.cpp EffectMovementGenerator::Update */
  update(unit: MovementOwner, _diff: number): boolean {
    return !unit.movespline.finalized();
  }

  /** @ac game/Movement/MovementGenerators/PointMovementGenerator.h EffectMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return EFFECT_MOTION_TYPE;
  }
}
