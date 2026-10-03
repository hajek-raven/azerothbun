/**
 * Port of the part of `game/AI/CreatureAI.{h,cpp}` the movement code and the combat world reach: the default movement hooks
 * (`JustReachedHome`, `Waypoint*`, `PathEndReached`, `Distancing*`), `EnterEvadeMode` / `_EnterEvadeMode`, the engagement state,
 * and the two calls the grid relocation workers make (`MoveInLineOfSight_Safe`, `TriggerAlert`).
 *
 * @ac-skip AI: the aggro scan (`MoveInLineOfSight`) and `UpdateVictim` are the combat world's (`src/combat/combat-world.ts` polls
 * the players around a creature and picks its victim from the threat list), so `MoveInLineOfSight_Safe` and `TriggerAlert`
 * do nothing here. Scripts, SmartAI, `DoZoneInCombat`, `Talk`, boundaries and the circle / backwards checks are not ported.
 */
import { UNIT_STATE_EVADE } from "../../spells/enums.ts";
import type { Creature } from "../Entities/Creature/Creature.ts";
import type { UnitLike } from "../Grids/GridPlayer.ts";
import { UnitAI } from "./CoreAI/UnitAI.ts";

/** @ac game/AI/CreatureAI.h EvadeReason */
export const EvadeReason = {
  EVADE_REASON_NO_HOSTILES: 0, // the creature's threat list is empty
  EVADE_REASON_BOUNDARY: 1, // the creature has moved outside its evade boundary
  EVADE_REASON_NO_PATH: 2, // the creature was unable to reach its target for over 5 seconds
  EVADE_REASON_SEQUENCE_BREAK: 3, // this is a boss and the pre-requisite encounters for engaging it are not defeated yet
  EVADE_REASON_OTHER: 4, // anything else
} as const;
export type EvadeReason = (typeof EvadeReason)[keyof typeof EvadeReason];

/** @ac game/AI/CreatureAI.h CreatureAI */
export class CreatureAI extends UnitAI {
  /** @ac game/AI/CreatureAI.h CreatureAI::_isEngaged */
  private _isEngaged = false;

  /** @ac game/AI/CreatureAI.h CreatureAI::CreatureAI */
  constructor(creature: Creature) {
    super(creature);
  }

  /** @ac game/AI/CreatureAI.h CreatureAI::IsEngaged */
  IsEngaged(): boolean {
    return this._isEngaged;
  }

  /** @ac game/AI/CreatureAI.cpp CreatureAI::EngagementStart (`AtEngage` is the combat world's) */
  EngagementStart(_who: UnitLike | null): void {
    if (this._isEngaged) return;
    this._isEngaged = true;
  }

  /** @ac game/AI/CreatureAI.cpp CreatureAI::EngagementOver (`AtDisengage` is the combat world's) */
  EngagementOver(): void {
    if (!this._isEngaged) return;
    this._isEngaged = false;
  }

  /** @ac game/AI/CreatureAI.h CreatureAI::JustReachedHome */
  JustReachedHome(): void {}

  /** @ac game/AI/CreatureAI.h CreatureAI::WaypointPathStarted */
  WaypointPathStarted(_pathId: number): void {}

  /** @ac game/AI/CreatureAI.h CreatureAI::WaypointStarted */
  WaypointStarted(_nodeId: number, _pathId: number): void {}

  /** @ac game/AI/CreatureAI.h CreatureAI::WaypointReached */
  WaypointReached(_nodeId: number, _pathId: number): void {}

  /** @ac game/AI/CreatureAI.h CreatureAI::PathEndReached */
  PathEndReached(_pathId: number): void {}

  /** @ac game/AI/CreatureAI.h CreatureAI::WaypointPathEnded */
  WaypointPathEnded(_nodeId: number, _pathId: number): void {}

  /** @ac game/AI/CreatureAI.h CreatureAI::DistancingStarted */
  DistancingStarted(): void {}

  /** @ac game/AI/CreatureAI.h CreatureAI::DistancingEnded */
  DistancingEnded(): void {}

  /** @ac game/AI/CreatureAI.h CreatureAI::MoveInLineOfSight_Safe (@ac-skip AI: the combat world scans for aggro) */
  MoveInLineOfSight_Safe(_who: UnitLike): void {}

  /** @ac game/AI/CreatureAI.cpp CreatureAI::TriggerAlert (@ac-skip AI: stealth alert is not ported) */
  TriggerAlert(_who: UnitLike): void {}

  /** @ac game/AI/CreatureAI.cpp CreatureAI::EnterEvadeMode */
  EnterEvadeMode(why: EvadeReason = EvadeReason.EVADE_REASON_OTHER): void {
    if (!this._EnterEvadeMode(why)) return;

    // @ac-skip Vehicles: `me->GetVehicle()` is always null
    const owner = this.me.getCharmerOrOwner();
    if (owner) {
      // Owned creatures (pets/guardians) follow their owner
      this.me.clearUnitState(UNIT_STATE_EVADE);
      this.me.getMotionMaster().clear(false);
      // @ac-skip Pets: `MoveFollow(owner, PET_FOLLOW_DIST, ...)`: charmed and owned creatures are not ported (`getCharmerOrOwner` is null)
    } else {
      // Required to prevent attacking creatures that are evading and cause them to reenter combat
      // Does not apply to MoveFollow — UNIT_STATE_EVADE is already set from _EnterEvadeMode
      this.me.getMotionMaster().moveTargetedHome();
    }

    this.Reset();
    // @ac-skip Scripts: `sScriptMgr->OnUnitEnterEvadeMode`
    // @ac-skip Display: `CREATURE_FLAG_EXTRA_HARD_RESET` -> `DespawnOnEvade()`
  }

  /** @ac game/AI/CreatureAI.cpp CreatureAI::_EnterEvadeMode */
  protected _EnterEvadeMode(_why: EvadeReason): boolean {
    const me = this.me;
    if (me.isInEvadeMode()) return false;

    if (!me.isAlive()) {
      this.EngagementOver();
      return false;
    }

    // Set evade state early to prevent recursion
    me.addUnitState(UNIT_STATE_EVADE);

    // `RemoveEvadeAuras`, `CombatStop(true)`, `LoadCreaturesAddon(true)`, `SetLootRecipient(nullptr)`, `ResetPlayerDamageReq`,
    // `ClearLastLeashExtensionTimePtr`, `SetCannotReachTarget`: the combat world owns the threat list, loot tap and leash state
    me.evadeCombat();
    me.loadCreaturesAddon(true);
    me.setCannotReachTarget();

    me.getZoneScript()?.onCreatureEvade(me);

    me.getFormation()?.memberEvaded(me as never);

    this.EngagementOver();

    return true;
  }
}
