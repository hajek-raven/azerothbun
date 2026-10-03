/**
 * Port of `game/Movement/MovementGenerators/ConfusedMovementGenerator.{h,cpp}`: a confused unit walks between random
 * points around where it was confused (up to `MAX_CONF_WAYPOINTS` of them are computed up front).
 *
 * The `Player` and `Creature` specializations (`_InitSpecific`, `DoFinalize`) branch on `unit.toCreature()`.
 */
import { randNorm, urand } from "../../../common/random.ts";
import { UNIT_FLAG_CONFUSED, UNIT_STATE_CONFUSED, UNIT_STATE_CONFUSED_MOVE, UNIT_STATE_NOT_MOVE } from "../../../spells/enums.ts";
import { TimeTracker } from "../../time/timer.ts";
import { NormalizeMapCoord } from "../../Grids/GridDefines.ts";
import { INVALID_HEIGHT } from "../../Grids/GridTerrainData.ts";
import { MovementGeneratorMedium } from "../MovementGenerator.ts";
import { CONFUSED_MOTION_TYPE, type MovementGeneratorType } from "../MotionMaster.ts";
import type { MovementOwner } from "../MovementOwner.ts";
import { MoveSplineInit } from "../Spline/MoveSplineInit.ts";

const F = Math.fround;

/** Allows a twelve second confusion if i_nextMove always is the absolute minimum timer. @ac game/Movement/MovementGenerators/ConfusedMovementGenerator.h MAX_CONF_WAYPOINTS */
export const MAX_CONF_WAYPOINTS = 24;

/** @ac game/Movement/MovementGenerators/ConfusedMovementGenerator.h ConfusedMovementGenerator */
export class ConfusedMovementGenerator<T extends MovementOwner = MovementOwner> extends MovementGeneratorMedium<T> {
  private i_nextMoveTime = new TimeTracker(1);
  private readonly i_waypoints: [number, number, number][] = Array.from({ length: MAX_CONF_WAYPOINTS + 1 }, () => [0, 0, 0] as [number, number, number]);
  private i_nextMove = 0;

  /** @ac game/Movement/MovementGenerators/ConfusedMovementGenerator.h ConfusedMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return CONFUSED_MOTION_TYPE;
  }

  /** @ac game/Movement/MovementGenerators/ConfusedMovementGenerator.cpp ConfusedMovementGenerator<T>::DoInitialize */
  doInitialize(unit: T): void {
    unit.stopMoving();
    const wander_distance = 4;
    const x = unit.getPositionX();
    const y = unit.getPositionY();
    const z = unit.getPositionZ();

    const map = unit.getMap();

    const { is_water_ok, is_land_ok } = this._InitSpecific(unit);

    for (let idx = 0; idx < MAX_CONF_WAYPOINTS + 1; ++idx) {
      let wanderX = F(x + F(F(wander_distance * randNorm()) - wander_distance / 2));
      let wanderY = F(y + F(F(wander_distance * randNorm()) - wander_distance / 2));

      // prevent invalid coordinates generation
      wanderX = NormalizeMapCoord(wanderX);
      wanderY = NormalizeMapCoord(wanderY);

      const new_z = unit.getMapHeight(wanderX, wanderY, z);
      if (new_z <= INVALID_HEIGHT || Math.abs(z - new_z) > 3.0) {
        // pussywizard
        this.i_waypoints[idx]![0] = idx > 0 ? this.i_waypoints[idx - 1]![0] : x;
        this.i_waypoints[idx]![1] = idx > 0 ? this.i_waypoints[idx - 1]![1] : y;
        this.i_waypoints[idx]![2] = idx > 0 ? this.i_waypoints[idx - 1]![2] : z;
        continue;
      } else if (unit.isWithinLOS(wanderX, wanderY, z)) {
        const is_water = map.isInWater(unit.getPhaseMask(), wanderX, wanderY, z, unit.getCollisionHeight());

        if ((is_water && !is_water_ok) || (!is_water && !is_land_ok)) {
          //! Cannot use coordinates outside our InhabitType. Use the current or previous position.
          this.i_waypoints[idx]![0] = idx > 0 ? this.i_waypoints[idx - 1]![0] : x;
          this.i_waypoints[idx]![1] = idx > 0 ? this.i_waypoints[idx - 1]![1] : y;
          this.i_waypoints[idx]![2] = idx > 0 ? this.i_waypoints[idx - 1]![2] : z;
          continue;
        }
      } else {
        //! Trying to access path outside line of sight. Skip this by using the current or previous position.
        this.i_waypoints[idx]![0] = idx > 0 ? this.i_waypoints[idx - 1]![0] : x;
        this.i_waypoints[idx]![1] = idx > 0 ? this.i_waypoints[idx - 1]![1] : y;
        this.i_waypoints[idx]![2] = idx > 0 ? this.i_waypoints[idx - 1]![2] : z;
        continue;
      }

      //unit->UpdateAllowedPositionZ(wanderX, wanderY, z);

      //! Positions are fine - apply them to this waypoint
      this.i_waypoints[idx]![0] = wanderX;
      this.i_waypoints[idx]![1] = wanderY;
      this.i_waypoints[idx]![2] = new_z;
    }

    // Xinef: Call movement immediately to broadcast movement packet
    // Xinef: Initial timer is set to 1 so update with 1
    this.i_nextMove = urand(1, MAX_CONF_WAYPOINTS);
    this.doUpdate(unit, 1);

    unit.setUnitFlag(UNIT_FLAG_CONFUSED);
    unit.addUnitState(UNIT_STATE_CONFUSED | UNIT_STATE_CONFUSED_MOVE);
  }

  /** `_InitSpecific` of `<Creature>` (`CanEnterWater`, `CanWalk`) and `<Player>` (both true). @ac game/Movement/MovementGenerators/ConfusedMovementGenerator.cpp ConfusedMovementGenerator<T>::_InitSpecific */
  private _InitSpecific(unit: T): { is_water_ok: boolean; is_land_ok: boolean } {
    const creature = unit.toCreature();
    if (creature) return { is_water_ok: creature.canEnterWater(), is_land_ok: creature.canWalk() };

    return { is_water_ok: true, is_land_ok: true };
  }

  /** @ac game/Movement/MovementGenerators/ConfusedMovementGenerator.cpp ConfusedMovementGenerator<T>::DoReset */
  doReset(unit: T): void {
    this.doInitialize(unit);
  }

  /** @ac game/Movement/MovementGenerators/ConfusedMovementGenerator.cpp ConfusedMovementGenerator<T>::DoUpdate */
  doUpdate(unit: T, diff: number): boolean {
    if (unit.hasUnitState(UNIT_STATE_NOT_MOVE) || unit.isMovementPreventedByCasting()) {
      unit.stopMoving();
      return true;
    }

    if (this.i_nextMoveTime.passed()) {
      // currently moving, update location
      unit.addUnitState(UNIT_STATE_CONFUSED_MOVE);

      if (unit.movespline.finalized()) {
        this.i_nextMove = urand(1, MAX_CONF_WAYPOINTS);
        this.i_nextMoveTime.reset(urand(600, 1200)); // Guessed
      }
    } else {
      // waiting for next move
      this.i_nextMoveTime.update(diff);
      if (this.i_nextMoveTime.passed()) {
        // start moving
        unit.addUnitState(UNIT_STATE_CONFUSED_MOVE);

        if (!(this.i_nextMove <= MAX_CONF_WAYPOINTS)) throw new Error("ConfusedMovementGenerator::DoUpdate: i_nextMove > MAX_CONF_WAYPOINTS");
        const x = this.i_waypoints[this.i_nextMove]![0];
        const y = this.i_waypoints[this.i_nextMove]![1];
        const z = this.i_waypoints[this.i_nextMove]![2];
        const init = new MoveSplineInit(unit);
        init.moveTo(x, y, z, true);
        init.setWalk(true);
        init.launch();
      }
    }

    return true;
  }

  /** `DoFinalize` of `<Player>` and `<Creature>`. @ac game/Movement/MovementGenerators/ConfusedMovementGenerator.cpp ConfusedMovementGenerator<T>::DoFinalize */
  doFinalize(unit: T): void {
    if (unit.isPlayer()) {
      unit.removeUnitFlag(UNIT_FLAG_CONFUSED);
      unit.clearUnitState(UNIT_STATE_CONFUSED | UNIT_STATE_CONFUSED_MOVE);
      unit.stopMoving();
      return;
    }

    unit.removeUnitFlag(UNIT_FLAG_CONFUSED);
    unit.clearUnitState(UNIT_STATE_CONFUSED | UNIT_STATE_CONFUSED_MOVE);
    const victim = unit.getVictim();
    if (victim) unit.setTarget(victim.getGUID());
  }
}
