/**
 * Port of `game/Movement/MovementGenerators/EscortMovementGenerator.{h,cpp}` (xinef): a unit follows a fixed array of
 * points (`MoveSplinePath`, `MovePath`); `GetSplineId` tells the escort AI which spline it launched.
 */
import { Vector3 } from "../../../math/Vector3.ts";
import { UNIT_STATE_NOT_MOVE, UNIT_STATE_ROAMING, UNIT_STATE_ROAMING_MOVE } from "../../../spells/enums.ts";
import { MovementGeneratorMedium } from "../MovementGenerator.ts";
import { ESCORT_MOTION_TYPE, FORCED_MOVEMENT_FLY, FORCED_MOVEMENT_RUN, FORCED_MOVEMENT_WALK, type ForcedMovement, type MovementGeneratorType } from "../MotionMaster.ts";
import type { MovementOwner } from "../MovementOwner.ts";
import { MoveSplineInit } from "../Spline/MoveSplineInit.ts";
import type { PointsArray } from "./PathGenerator.ts";

/** @ac game/Movement/MovementGenerators/EscortMovementGenerator.h EscortMovementGenerator */
export class EscortMovementGenerator<T extends MovementOwner = MovementOwner> extends MovementGeneratorMedium<T> {
  private i_recalculateSpeed = false;
  private m_precomputedPath: PointsArray = [];

  private _splineId = 0;
  private _forcedMovement: ForcedMovement;

  /** @ac game/Movement/MovementGenerators/EscortMovementGenerator.h EscortMovementGenerator::EscortMovementGenerator */
  constructor(forcedMovement: ForcedMovement, _path: PointsArray | null = null) {
    super();
    this._forcedMovement = forcedMovement;
    if (_path) this.m_precomputedPath = _path.map((p) => new Vector3(p.x, p.y, p.z));
  }

  /** @ac game/Movement/MovementGenerators/EscortMovementGenerator.h EscortMovementGenerator::unitSpeedChanged */
  override unitSpeedChanged(): void {
    this.i_recalculateSpeed = true;
  }

  /** @ac game/Movement/MovementGenerators/EscortMovementGenerator.h EscortMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return ESCORT_MOTION_TYPE;
  }

  /** @ac game/Movement/MovementGenerators/EscortMovementGenerator.h EscortMovementGenerator::GetSplineId */
  override getSplineId(): number {
    return this._splineId;
  }

  /** @ac game/Movement/MovementGenerators/EscortMovementGenerator.cpp EscortMovementGenerator<T>::DoInitialize */
  doInitialize(unit: T): void {
    if (!unit.isStopped()) unit.stopMoving();

    unit.addUnitState(UNIT_STATE_ROAMING | UNIT_STATE_ROAMING_MOVE);
    this.i_recalculateSpeed = false;
    const init = new MoveSplineInit(unit);

    if (this.m_precomputedPath.length === 2)
      // xinef: simple case, just call move to
      init.moveTo(this.m_precomputedPath[1]!.x, this.m_precomputedPath[1]!.y, this.m_precomputedPath[1]!.z, true);
    else if (this.m_precomputedPath.length) init.movebyPath(this.m_precomputedPath);

    if (this._forcedMovement === FORCED_MOVEMENT_WALK) init.setWalk(true);
    else if (this._forcedMovement === FORCED_MOVEMENT_RUN) init.setWalk(false);
    else if (this._forcedMovement === FORCED_MOVEMENT_FLY) init.setFly();

    init.launch();

    this._splineId = unit.movespline.getId();
  }

  /** @ac game/Movement/MovementGenerators/EscortMovementGenerator.cpp EscortMovementGenerator<T>::DoUpdate */
  doUpdate(unit: T, _diff: number): boolean {
    if (!unit) return false;

    if (unit.hasUnitState(UNIT_STATE_NOT_MOVE) || unit.isMovementPreventedByCasting()) {
      unit.clearUnitState(UNIT_STATE_ROAMING_MOVE);
      return true;
    }

    unit.addUnitState(UNIT_STATE_ROAMING_MOVE);

    const arrived = unit.movespline.finalized();

    if (this.i_recalculateSpeed && !arrived) {
      this.i_recalculateSpeed = false;
      const init = new MoveSplineInit(unit);

      // xinef: speed changed during path execution, calculate remaining path and launch it once more
      if (this.m_precomputedPath.length) {
        const offset = Math.min(unit.movespline._currentSplineIdx() >>> 0, this.m_precomputedPath.length);
        this.m_precomputedPath.splice(0, offset);

        // restore 0 element (current position)
        this.m_precomputedPath.unshift(new Vector3(unit.getPositionX(), unit.getPositionY(), unit.getPositionZ()));

        if (this.m_precomputedPath.length > 2) init.movebyPath(this.m_precomputedPath);
        else if (this.m_precomputedPath.length === 2) init.moveTo(this.m_precomputedPath[1]!.x, this.m_precomputedPath[1]!.y, this.m_precomputedPath[1]!.z, true);
      }

      if (this._forcedMovement === FORCED_MOVEMENT_WALK) init.setWalk(true);
      else if (this._forcedMovement === FORCED_MOVEMENT_RUN) init.setWalk(false);
      else if (this._forcedMovement === FORCED_MOVEMENT_FLY) init.setFly();

      init.launch();
      // Xinef: Override spline Id on recalculate launch
      this._splineId = unit.movespline.getId();
    }

    return !arrived;
  }

  /** @ac game/Movement/MovementGenerators/EscortMovementGenerator.cpp EscortMovementGenerator<T>::DoFinalize */
  doFinalize(unit: T): void {
    unit.clearUnitState(UNIT_STATE_ROAMING | UNIT_STATE_ROAMING_MOVE);
  }

  /** @ac game/Movement/MovementGenerators/EscortMovementGenerator.cpp EscortMovementGenerator<T>::DoReset */
  doReset(unit: T): void {
    if (!unit.isStopped()) unit.stopMoving();

    unit.addUnitState(UNIT_STATE_ROAMING | UNIT_STATE_ROAMING_MOVE);
  }
}
