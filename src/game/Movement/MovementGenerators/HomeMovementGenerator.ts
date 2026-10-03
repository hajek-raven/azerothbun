/**
 * Port of `game/Movement/MovementGenerators/HomeMovementGenerator.{h,cpp}`: a creature that evades walks (or runs) back
 * to its reset position (the idle generator's, else its home position).
 *
 * Only `HomeMovementGenerator<Creature>` exists in C++.
 */
import { UNIT_FLAG_SWIMMING, UNIT_STATE_EVADE, UNIT_STATE_IGNORE_PATHFINDING, UNIT_STATE_NO_ENVIRONMENT_UPD, UNIT_STATE_POSSESSED } from "../../../spells/enums.ts";
import { MapCollisionDataHooks } from "../../Maps/MapCollisionData.ts";
import { MovementGeneratorMedium, type ResetPosition } from "../MovementGenerator.ts";
import { HOME_MOTION_TYPE, MOTION_SLOT_IDLE, type MovementGeneratorType } from "../MotionMaster.ts";
import { EVADE_STATE_HOME, EVADE_STATE_NONE, type MovementOwnerCreature, UNIT_STATE_ALL_STATE } from "../MovementOwner.ts";
import { MoveSplineInit } from "../Spline/MoveSplineInit.ts";

/** @ac game/Movement/MovementGenerators/HomeMovementGenerator.h HomeMovementGenerator<Creature> */
export class HomeMovementGenerator extends MovementGeneratorMedium<MovementOwnerCreature> {
  private arrived = false;
  private i_recalculateTravel = false;
  private _walk: boolean;

  /** @ac game/Movement/MovementGenerators/HomeMovementGenerator.h HomeMovementGenerator::HomeMovementGenerator */
  constructor(walk: boolean) {
    super();
    this._walk = walk;
  }

  /** @ac game/Movement/MovementGenerators/HomeMovementGenerator.h HomeMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return HOME_MOTION_TYPE;
  }

  /** @ac game/Movement/MovementGenerators/HomeMovementGenerator.h HomeMovementGenerator::unitSpeedChanged */
  override unitSpeedChanged(): void {
    this.i_recalculateTravel = true;
  }

  /** @ac game/Movement/MovementGenerators/HomeMovementGenerator.cpp HomeMovementGenerator<Creature>::DoInitialize */
  doInitialize(owner: MovementOwnerCreature): void {
    owner.getCombatManager().setEvadeState(EVADE_STATE_HOME);
    this._setTargetLocation(owner);
  }

  /** @ac game/Movement/MovementGenerators/HomeMovementGenerator.cpp HomeMovementGenerator<Creature>::DoFinalize */
  doFinalize(owner: MovementOwnerCreature): void {
    owner.getCombatManager().setEvadeState(EVADE_STATE_NONE);
    owner.clearUnitState(UNIT_STATE_EVADE);
    if (this.arrived) {
      owner.loadCreaturesAddon(true);
      owner.ai()?.JustReachedHome?.();
    }

    if (!owner.hasSwimmingFlagOutOfCombat()) owner.removeUnitFlag(UNIT_FLAG_SWIMMING);
  }

  /** @ac game/Movement/MovementGenerators/HomeMovementGenerator.cpp HomeMovementGenerator<Creature>::DoReset */
  doReset(_owner: MovementOwnerCreature): void {}

  /** @ac game/Movement/MovementGenerators/HomeMovementGenerator.cpp HomeMovementGenerator<Creature>::_setTargetLocation */
  private _setTargetLocation(owner: MovementOwnerCreature): void {
    // Xinef: dont interrupt in any cast!
    //if (owner->HasUnitState(UNIT_STATE_ROOT | UNIT_STATE_STUNNED | UNIT_STATE_DISTRACTED))
    //    return;
    const init = new MoveSplineInit(owner);
    const pos: ResetPosition = { x: 0, y: 0, z: 0 };

    // Xinef: if there is motion generator on controlled slot, this one is not updated
    // Xinef: always get reset pos from idle slot
    const gen = owner.getMotionMaster().getMotionSlot(MOTION_SLOT_IDLE);
    if (owner.getMotionMaster().empty() || !gen || !gen.getResetPosition(pos)) {
      const home = owner.getHomePosition();
      pos.x = home.getPositionX();
      pos.y = home.getPositionY();
      pos.z = home.getPositionZ();
      init.setFacing(home.getOrientation());
    }

    pos.z = owner.updateAllowedPositionZ(pos.x, pos.y, pos.z);
    init.moveTo(pos.x, pos.y, pos.z, MapCollisionDataHooks.isPathfindingEnabled(owner.findMap()), true);
    init.setWalk(this._walk);
    init.launch();

    this.arrived = false;

    owner.clearUnitState((UNIT_STATE_ALL_STATE & ~(UNIT_STATE_POSSESSED | UNIT_STATE_EVADE | UNIT_STATE_IGNORE_PATHFINDING | UNIT_STATE_NO_ENVIRONMENT_UPD)) >>> 0);
  }

  /** @ac game/Movement/MovementGenerators/HomeMovementGenerator.cpp HomeMovementGenerator<Creature>::DoUpdate */
  doUpdate(owner: MovementOwnerCreature, _time_diff: number): boolean {
    this.arrived = owner.movespline.finalized();
    if (this.arrived) return false;

    if (this.i_recalculateTravel) {
      this._setTargetLocation(owner);
      this.i_recalculateTravel = false;
    }

    return true;
  }
}
