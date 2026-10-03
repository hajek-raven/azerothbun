/**
 * Port of `game/Movement/MotionMaster.{h,cpp}`: the stack of movement generators of a unit (one per
 * `MovementSlot`), the `Move*` entry points that replace a slot, and `UpdateMotion`, which ticks the top generator and
 * applies the clears and expirations that were requested while it ran (`MMCF_UPDATE`, `DelayedDelete`).
 *
 * The `Unit` is a `MovementOwner` (see `MovementOwner.ts`). Overloaded C++ functions (`MovePoint`, `MoveChase`,
 * `MoveLand`, `MoveTakeoff`, `MoveJump`, `MoveCharge`) are one TypeScript method with the overloads declared, dispatching on
 * the type of the first parameter. `std::optional<T>` is `T | null`. The C++ destructor is `destroy()`.
 *
 * @ac-skip Transports: none of the C++ here touches transports directly (`MoveSplineInit` does).
 */
import { logDebug, logError } from "../../log.ts";
import { Vector3 } from "../../math/Vector3.ts";
import { CONTACT_DISTANCE } from "../Entities/Object/ObjectDefines.ts";
import { AnimTier } from "../Entities/Unit/UnitDefines.ts";
import { NormalizeOrientation, Position } from "../Entities/Object/Position.ts";
import { INVALID_HEIGHT, MAX_FALL_DISTANCE } from "../Grids/MapLike.ts";
import { getGameTime } from "../time/game-time.ts";
import { SelectMovementGenerator } from "../AI/CreatureAISelector.ts";
import { MovementGenerator, sMovementGeneratorRegistry } from "./MovementGenerator.ts";
import type { MovementOwner, MovementOwnerCreature, MovementOwnerPlayer } from "./MovementOwner.ts";
import {
  EVENT_CHARGE,
  EVENT_CHARGE_PREPATH,
  MOVEMENTFLAG_CAN_FLY,
  MOVEMENTFLAG_FALLING,
  MOVEMENTFLAG_FLYING,
  MOVEMENTFLAG_MASK_MOVING,
  PET_FOLLOW_DIST,
  REACT_PASSIVE,
} from "./MovementOwner.ts";
import { UNIT_FLAG_DISABLE_MOVE, UNIT_STATE_EVADE } from "../../spells/enums.ts";
import type { PathGenerator, PointsArray } from "./MovementGenerators/PathGenerator.ts";
import { ConfusedMovementGenerator } from "./MovementGenerators/ConfusedMovementGenerator.ts";
import { EscortMovementGenerator } from "./MovementGenerators/EscortMovementGenerator.ts";
import { FleeingMovementGenerator, TimedFleeingMovementGenerator } from "./MovementGenerators/FleeingMovementGenerator.ts";
import { FormationMovementGenerator } from "./MovementGenerators/FormationMovementGenerator.ts";
import { HomeMovementGenerator } from "./MovementGenerators/HomeMovementGenerator.ts";
import { AssistanceDistractMovementGenerator, DistractMovementGenerator, RotateMovementGenerator } from "./MovementGenerators/IdleMovementGenerator.ts";
import { AssistanceMovementGenerator, EffectMovementGenerator, PointMovementGenerator } from "./MovementGenerators/PointMovementGenerator.ts";
import { RandomMovementGenerator } from "./MovementGenerators/RandomMovementGenerator.ts";
import { ChaseMovementGenerator, FollowMovementGenerator } from "./MovementGenerators/TargetedMovementGenerator.ts";
import { FlightPathMovementGenerator, GetWaypointPath, WaypointMovementGenerator } from "./MovementGenerators/WaypointMovementGenerator.ts";
import { FlightPathContext } from "./MovementGenerators/WaypointMovementGenerator.ts";
import { MoveSplineInit } from "./Spline/MoveSplineInit.ts";
import { computeFallElevation, gravity } from "./Spline/MovementUtil.ts";

const F = Math.fround;
const M_PI = Math.PI;
const M_PI_4 = Math.PI / 4;

/** Creature Entry ID used for waypoints show, visible only for GMs. @ac game/Movement/MotionMaster.h VISUAL_WAYPOINT */
export const VISUAL_WAYPOINT = 1;

/** values 0 ... MAX_DB_MOTION_TYPE-1 used in DB. @ac game/Movement/MotionMaster.h MovementGeneratorType */
export const MovementGeneratorType = {
  IDLE_MOTION_TYPE: 0, // IdleMovementGenerator.h
  RANDOM_MOTION_TYPE: 1, // RandomMovementGenerator.h
  WAYPOINT_MOTION_TYPE: 2, // WaypointMovementGenerator.h
  MAX_DB_MOTION_TYPE: 3, // *** this and below motion types can't be set in DB.
  ANIMAL_RANDOM_MOTION_TYPE: 3, // AnimalRandomMovementGenerator.h (= MAX_DB_MOTION_TYPE)
  CONFUSED_MOTION_TYPE: 4, // ConfusedMovementGenerator.h
  CHASE_MOTION_TYPE: 5, // TargetedMovementGenerator.h
  HOME_MOTION_TYPE: 6, // HomeMovementGenerator.h
  FLIGHT_MOTION_TYPE: 7, // WaypointMovementGenerator.h
  POINT_MOTION_TYPE: 8, // PointMovementGenerator.h
  FLEEING_MOTION_TYPE: 9, // FleeingMovementGenerator.h
  DISTRACT_MOTION_TYPE: 10, // IdleMovementGenerator.h
  ASSISTANCE_MOTION_TYPE: 11, // PointMovementGenerator.h (first part of flee for assistance)
  ASSISTANCE_DISTRACT_MOTION_TYPE: 12, // IdleMovementGenerator.h (second part of flee for assistance)
  TIMED_FLEEING_MOTION_TYPE: 13, // FleeingMovementGenerator.h (alt.second part of flee for assistance)
  FOLLOW_MOTION_TYPE: 14,
  ROTATE_MOTION_TYPE: 15,
  EFFECT_MOTION_TYPE: 16,
  ESCORT_MOTION_TYPE: 17, // xinef: EscortMovementGenerator.h
  FORMATION_MOTION_TYPE: 18, // FormationMovementGenerator.h
  NULL_MOTION_TYPE: 19,
} as const;
export type MovementGeneratorType = (typeof MovementGeneratorType)[keyof typeof MovementGeneratorType];
export const IDLE_MOTION_TYPE = MovementGeneratorType.IDLE_MOTION_TYPE;
export const RANDOM_MOTION_TYPE = MovementGeneratorType.RANDOM_MOTION_TYPE;
export const WAYPOINT_MOTION_TYPE = MovementGeneratorType.WAYPOINT_MOTION_TYPE;
export const MAX_DB_MOTION_TYPE = MovementGeneratorType.MAX_DB_MOTION_TYPE;
export const ANIMAL_RANDOM_MOTION_TYPE = MovementGeneratorType.ANIMAL_RANDOM_MOTION_TYPE;
export const CONFUSED_MOTION_TYPE = MovementGeneratorType.CONFUSED_MOTION_TYPE;
export const CHASE_MOTION_TYPE = MovementGeneratorType.CHASE_MOTION_TYPE;
export const HOME_MOTION_TYPE = MovementGeneratorType.HOME_MOTION_TYPE;
export const FLIGHT_MOTION_TYPE = MovementGeneratorType.FLIGHT_MOTION_TYPE;
export const POINT_MOTION_TYPE = MovementGeneratorType.POINT_MOTION_TYPE;
export const FLEEING_MOTION_TYPE = MovementGeneratorType.FLEEING_MOTION_TYPE;
export const DISTRACT_MOTION_TYPE = MovementGeneratorType.DISTRACT_MOTION_TYPE;
export const ASSISTANCE_MOTION_TYPE = MovementGeneratorType.ASSISTANCE_MOTION_TYPE;
export const ASSISTANCE_DISTRACT_MOTION_TYPE = MovementGeneratorType.ASSISTANCE_DISTRACT_MOTION_TYPE;
export const TIMED_FLEEING_MOTION_TYPE = MovementGeneratorType.TIMED_FLEEING_MOTION_TYPE;
export const FOLLOW_MOTION_TYPE = MovementGeneratorType.FOLLOW_MOTION_TYPE;
export const ROTATE_MOTION_TYPE = MovementGeneratorType.ROTATE_MOTION_TYPE;
export const EFFECT_MOTION_TYPE = MovementGeneratorType.EFFECT_MOTION_TYPE;
export const ESCORT_MOTION_TYPE = MovementGeneratorType.ESCORT_MOTION_TYPE;
export const FORMATION_MOTION_TYPE = MovementGeneratorType.FORMATION_MOTION_TYPE;
export const NULL_MOTION_TYPE = MovementGeneratorType.NULL_MOTION_TYPE;

/** @ac game/Movement/MotionMaster.h MovementSlot */
export const MovementSlot = {
  MOTION_SLOT_IDLE: 0,
  MOTION_SLOT_ACTIVE: 1,
  MOTION_SLOT_CONTROLLED: 2,
  MAX_MOTION_SLOT: 3,
} as const;
export type MovementSlot = (typeof MovementSlot)[keyof typeof MovementSlot];
export const MOTION_SLOT_IDLE = MovementSlot.MOTION_SLOT_IDLE;
export const MOTION_SLOT_ACTIVE = MovementSlot.MOTION_SLOT_ACTIVE;
export const MOTION_SLOT_CONTROLLED = MovementSlot.MOTION_SLOT_CONTROLLED;
export const MAX_MOTION_SLOT = MovementSlot.MAX_MOTION_SLOT;

/** @ac game/Movement/MotionMaster.h MMCleanFlag */
export const MMCleanFlag = {
  MMCF_NONE: 0x00,
  MMCF_UPDATE: 0x01, // Clear or Expire called from update
  MMCF_RESET: 0x02, // Flag if need top()->Reset()
  MMCF_INUSE: 0x04, // pussywizard: Flag if in MotionMaster::UpdateMotion
} as const;
export const MMCF_NONE = MMCleanFlag.MMCF_NONE;
export const MMCF_UPDATE = MMCleanFlag.MMCF_UPDATE;
export const MMCF_RESET = MMCleanFlag.MMCF_RESET;
export const MMCF_INUSE = MMCleanFlag.MMCF_INUSE;

/** @ac game/Movement/MotionMaster.h RotateDirection */
export const RotateDirection = { ROTATE_DIRECTION_LEFT: 0, ROTATE_DIRECTION_RIGHT: 1 } as const;
export type RotateDirection = (typeof RotateDirection)[keyof typeof RotateDirection];
export const ROTATE_DIRECTION_LEFT = RotateDirection.ROTATE_DIRECTION_LEFT;
export const ROTATE_DIRECTION_RIGHT = RotateDirection.ROTATE_DIRECTION_RIGHT;

/** @ac game/Movement/MotionMaster.h ForcedMovement */
export const ForcedMovement = {
  FORCED_MOVEMENT_NONE: 0,
  FORCED_MOVEMENT_WALK: 1,
  FORCED_MOVEMENT_RUN: 2,
  FORCED_MOVEMENT_FLY: 3,

  FORCED_MOVEMENT_MAX: 4,
} as const;
export type ForcedMovement = (typeof ForcedMovement)[keyof typeof ForcedMovement];
export const FORCED_MOVEMENT_NONE = ForcedMovement.FORCED_MOVEMENT_NONE;
export const FORCED_MOVEMENT_WALK = ForcedMovement.FORCED_MOVEMENT_WALK;
export const FORCED_MOVEMENT_RUN = ForcedMovement.FORCED_MOVEMENT_RUN;
export const FORCED_MOVEMENT_FLY = ForcedMovement.FORCED_MOVEMENT_FLY;
export const FORCED_MOVEMENT_MAX = ForcedMovement.FORCED_MOVEMENT_MAX;

/** `enum class PathSource` (not the `PathGenerator`'s `PathSource` interface). @ac game/Movement/MotionMaster.h PathSource */
export const PathSource = { WAYPOINT_MGR: 0, SMART_WAYPOINT_MGR: 1 } as const;
export type PathSource = (typeof PathSource)[keyof typeof PathSource];

/** @ac game/Movement/MotionMaster.h AnimTier (`AnimTier` is in `Entities/Unit/UnitDefines.ts` with the other movement enums) */
export { AnimTier };

/** @ac game/Movement/MotionMaster.h ChaseRange */
export class ChaseRange {
  // this contains info that informs how we should path!
  MinRange: number; // we have to move if we are within this range...    (min. attack range)
  MinTolerance: number; // ...and if we are, we will move this far away
  MaxRange: number; // we have to move if we are outside this range...   (max. attack range)
  MaxTolerance: number; // ...and if we are, we will move into this range

  /**
   * `ChaseRange(float range)`, `ChaseRange(float _minRange, float _maxRange)` and
   * `ChaseRange(float _minRange, float _minTolerance, float _maxTolerance, float _maxRange)`.
   *
   * @ac game/Movement/MotionMaster.cpp ChaseRange::ChaseRange
   */
  constructor(range: number);
  constructor(minRange: number, maxRange: number);
  constructor(minRange: number, minTolerance: number, maxTolerance: number, maxRange: number);
  constructor(a: number, b?: number, c?: number, d?: number) {
    if (b === undefined) {
      this.MinRange = a > CONTACT_DISTANCE ? 0 : F(a - CONTACT_DISTANCE);
      this.MinTolerance = F(a);
      this.MaxRange = F(a + CONTACT_DISTANCE);
      this.MaxTolerance = F(a);
    } else if (c === undefined || d === undefined) {
      this.MinRange = F(a);
      this.MinTolerance = F(Math.min(F(a + CONTACT_DISTANCE), F(F(a + b) / 2)));
      this.MaxRange = F(b);
      this.MaxTolerance = F(Math.max(F(b - CONTACT_DISTANCE), this.MinTolerance));
    } else {
      this.MinRange = F(a);
      this.MinTolerance = F(b);
      this.MaxRange = F(d);
      this.MaxTolerance = F(c);
    }
  }
}

/** @ac game/Movement/MotionMaster.h ChaseAngle */
export class ChaseAngle {
  RelativeAngle: number; // we want to be at this angle relative to the target (0 = front, M_PI = back)
  Tolerance: number; // but we'll tolerate anything within +- this much

  /** @ac game/Movement/MotionMaster.cpp ChaseAngle::ChaseAngle */
  constructor(angle: number, tolerance: number = F(M_PI_4)) {
    this.RelativeAngle = F(NormalizeOrientation(angle));
    this.Tolerance = F(tolerance);
  }

  /** @ac game/Movement/MotionMaster.cpp ChaseAngle::UpperBound */
  upperBound(): number {
    return F(NormalizeOrientation(F(this.RelativeAngle + this.Tolerance)));
  }

  /** @ac game/Movement/MotionMaster.cpp ChaseAngle::LowerBound */
  lowerBound(): number {
    return F(NormalizeOrientation(F(this.RelativeAngle - this.Tolerance)));
  }

  /** @ac game/Movement/MotionMaster.cpp ChaseAngle::IsAngleOkay */
  isAngleOkay(relativeAngle: number): boolean {
    const diff = F(Math.abs(F(relativeAngle - this.RelativeAngle)));

    return Math.min(diff, F(F(2 * M_PI) - diff)) <= this.Tolerance;
  }
}

/** assume it is 25 yard per 0.6 second. @ac game/Movement/MotionMaster.h SPEED_CHARGE */
export const SPEED_CHARGE = 42.0;

/** @ac game/Movement/MotionMaster.cpp GetIdleMovementGenerator */
function GetIdleMovementGenerator(): MovementGenerator {
  const factory = sMovementGeneratorRegistry.getRegistryItem(IDLE_MOTION_TYPE);
  if (!factory) throw new Error("MotionMaster: the movement generator factories are not registered (call AddMovementGeneratorFactories at startup)");
  return factory.create();
}

/** @ac game/Movement/MotionMaster.cpp isStatic */
function isStatic(movement: MovementGenerator | null): boolean {
  return movement === GetIdleMovementGenerator();
}

/** @ac game/Movement/MotionMaster.h MotionMaster */
export class MotionMaster {
  private _expList: MovementGenerator[] | null = null;
  private readonly Impl: (MovementGenerator | null)[] = [null, null, null];
  private _top = -1;
  private readonly _owner: MovementOwner;
  private readonly _needInit: boolean[] = [true, true, true];
  private _cleanFlag: number = MMCF_NONE;

  /** @ac game/Movement/MotionMaster.h MotionMaster::MotionMaster */
  constructor(unit: MovementOwner) {
    this._owner = unit;
    for (let i = 0; i < MAX_MOTION_SLOT; ++i) {
      this.Impl[i] = null;
      this._needInit[i] = true;
    }
  }

  /** The C++ destructor: clear ALL movement generators (including default), without finalizing. @ac game/Movement/MotionMaster.cpp MotionMaster::~MotionMaster */
  destroy(): void {
    // clear ALL movement generators (including default)
    while (!this.empty()) {
      const curr = this.top();
      this.pop();
      if (curr && !isStatic(curr)) curr.destroy(); // Skip finalizing on delete, it might launch new movement
    }
  }

  /** @ac game/Movement/MotionMaster.h MotionMaster::pop */
  private pop(): void {
    if (this.empty()) return;

    this.Impl[this._top] = null;
    while (!this.empty() && !this.top()) --this._top;
  }

  /** @ac game/Movement/MotionMaster.h MotionMaster::needInitTop */
  private needInitTop(): boolean {
    if (this.empty()) return false;
    return this._needInit[this._top]!;
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::InitTop */
  private initTop(): void {
    this.top()!.initialize(this._owner);
    this._needInit[this._top] = false;
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::Initialize */
  initialize(): void {
    // clear ALL movement generators (including default)
    while (!this.empty()) {
      const curr = this.top();
      this.pop();
      if (curr) this.directDelete(curr);
    }

    this.initDefault();
  }

  /** set new default movement generator. @ac game/Movement/MotionMaster.cpp MotionMaster::InitDefault */
  initDefault(): void {
    this.mutate(SelectMovementGenerator(this._owner), MOTION_SLOT_IDLE);
  }

  /** @ac game/Movement/MotionMaster.h MotionMaster::empty */
  empty(): boolean {
    return this._top < 0;
  }

  /** @ac game/Movement/MotionMaster.h MotionMaster::size */
  size(): number {
    return this._top + 1;
  }

  /** @ac game/Movement/MotionMaster.h MotionMaster::top */
  top(): MovementGenerator | null {
    if (this.empty()) throw new Error("MotionMaster::top: the stack is empty");
    return this.Impl[this._top]!;
  }

  /** @ac game/Movement/MotionMaster.h MotionMaster::GetMotionSlot */
  getMotionSlot(slot: number): MovementGenerator | null {
    if (slot < 0) throw new Error("MotionMaster::GetMotionSlot: slot < 0");
    return this.Impl[slot] ?? null;
  }

  /** @ac game/Movement/MotionMaster.h MotionMaster::GetCleanFlags */
  getCleanFlags(): number {
    return this._cleanFlag;
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::DirectDelete */
  directDelete(curr: MovementGenerator): void {
    if (isStatic(curr)) return;
    curr.finalize(this._owner);
    curr.destroy();
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::DelayedDelete */
  delayedDelete(curr: MovementGenerator): void {
    logDebug("movement", () => `Unit (Entry ${this._owner.getEntry()}) is trying to delete its updating MG (Type ${curr.getMovementGeneratorType()})!`);
    if (isStatic(curr)) return;
    if (!this._expList) this._expList = [];
    this._expList.push(curr);
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::UpdateMotion */
  updateMotion(diff: number): void {
    if (!this._owner) return;

    if (this.empty()) throw new Error("MotionMaster::UpdateMotion: the stack is empty");

    this._cleanFlag |= MMCF_INUSE;

    this._cleanFlag |= MMCF_UPDATE;
    if (!this.top()!.update(this._owner, diff)) {
      this._cleanFlag &= ~MMCF_UPDATE;
      this.movementExpired();
    } else this._cleanFlag &= ~MMCF_UPDATE;

    if (this._expList) {
      for (let i = 0; i < this._expList.length; ++i) {
        const mg = this._expList[i]!;
        this.directDelete(mg);
      }

      this._expList = null;

      if (this.empty()) this.initialize();
      else if (this.needInitTop()) this.initTop();
      else if (this._cleanFlag & MMCF_RESET) this.top()!.reset(this._owner);

      this._cleanFlag &= ~MMCF_RESET;
    }

    this._cleanFlag &= ~MMCF_INUSE;
  }

  /** @ac game/Movement/MotionMaster.h MotionMaster::Clear */
  clear(reset = true): void {
    if (this._cleanFlag & MMCF_UPDATE) {
      if (reset) this._cleanFlag |= MMCF_RESET;
      else this._cleanFlag &= ~MMCF_RESET;
      this.delayedClean();
    } else this.directClean(reset);
  }

  /** @ac game/Movement/MotionMaster.h MotionMaster::MovementExpired */
  movementExpired(reset = true): void {
    if (this._cleanFlag & MMCF_UPDATE) {
      if (reset) this._cleanFlag |= MMCF_RESET;
      else this._cleanFlag &= ~MMCF_RESET;
      this.delayedExpire();
    } else this.directExpire(reset);
  }

  /** @ac game/Movement/MotionMaster.h MotionMaster::MovementExpiredOnSlot */
  movementExpiredOnSlot(slot: MovementSlot, reset = true): void {
    // xinef: cannot be used during motion update!
    if (!(this._cleanFlag & MMCF_UPDATE)) this.directExpireSlot(slot, reset);
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::DirectClean */
  private directClean(reset: boolean): void {
    while (this.size() > 1) {
      const curr = this.top();
      this.pop();
      if (curr) this.directDelete(curr);
    }

    if (this.empty()) return;

    if (this.needInitTop()) this.initTop();
    else if (reset) this.top()!.reset(this._owner);
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::DelayedClean */
  private delayedClean(): void {
    while (this.size() > 1) {
      const curr = this.top();
      this.pop();
      if (curr) this.delayedDelete(curr);
    }
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::DirectExpire */
  private directExpire(reset: boolean): void {
    if (this.size() > 1) {
      const curr = this.top();
      this.pop();
      if (curr) this.directDelete(curr);
    }

    while (!this.empty() && !this.top()) --this._top;

    if (this.empty()) this.initialize();
    else if (this.needInitTop()) this.initTop();
    else if (reset) this.top()!.reset(this._owner);
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::DelayedExpire */
  private delayedExpire(): void {
    if (this.size() > 1) {
      const curr = this.top();
      this.pop();
      if (curr) this.delayedDelete(curr);
    }

    while (!this.empty() && !this.top()) --this._top;
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::DirectExpireSlot */
  private directExpireSlot(slot: MovementSlot, reset: boolean): void {
    if (this.size() > 1) {
      const curr = this.Impl[slot] ?? null;

      // pussywizard: clear slot AND decrease top immediately to avoid crashes when referencing null top in DirectDelete
      this.Impl[slot] = null;
      while (!this.empty() && !this.top()) --this._top;

      if (curr) this.directDelete(curr);
    }

    while (!this.empty() && !this.top()) --this._top;

    if (this.empty()) this.initialize();
    else if (this.needInitTop()) this.initTop();
    else if (reset) this.top()!.reset(this._owner);
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::MoveIdle */
  moveIdle(): void {
    //! Should be preceded by MovementExpired or Clear if there's an overlying movementgenerator active
    if (this.empty() || !isStatic(this.top())) this.mutate(GetIdleMovementGenerator(), MOTION_SLOT_IDLE);
  }

  /**
   * @brief Enable a random movement in desired range around the unit. Doesn't work with UNIT_FLAG_DISABLE_MOVE
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveRandom
   */
  moveRandom(wanderDistance = 0.0): void {
    if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    if (this._owner.isCreature()) {
      logDebug("movement", () => `Creature (${this._owner.getGUID()}) start moving random`);
      this.mutate(new RandomMovementGenerator(wanderDistance), MOTION_SLOT_IDLE);
    }
  }

  /**
   * @brief The unit will return this initial position (owner for pets and summoned creatures). Doesn't work with UNIT_FLAG_DISABLE_MOVE
   *
   * @param walk The unit will run by default, but you can set it to walk
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveTargetedHome
   */
  moveTargetedHome(walk = false): void {
    this.clear(false);

    const creature = this._owner.toCreature();
    if (creature && !creature.getCharmerOrOwnerGUID()) {
      logDebug("movement", () => `Creature (${this._owner.getGUID()}) targeted home`);
      this.mutate(new HomeMovementGenerator(walk), MOTION_SLOT_ACTIVE);
    } else if (creature && creature.getCharmerOrOwnerGUID()) {
      this._owner.clearUnitState(UNIT_STATE_EVADE);

      if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

      logDebug("movement", () => `Pet or controlled creature (${this._owner.getGUID()}) targeting home`);
      const target = creature.getCharmerOrOwner();
      if (target) {
        logDebug("movement", () => `Following ${target.isPlayer() ? "player" : "creature"} (${target.getGUID()})`);
        this.mutate(new FollowMovementGenerator(target, PET_FOLLOW_DIST, new ChaseAngle(this._owner.getFollowAngle()), true, true), MOTION_SLOT_ACTIVE);
      }
    } else {
      logError("movement", `Player (${this._owner.getGUID()}) attempt targeted home`);
    }
  }

  /**
   * @brief Enable the confusion movement. Doesn't work with UNIT_FLAG_DISABLE_MOVE
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveConfused
   */
  moveConfused(): void {
    // Xinef: do not allow to move with UNIT_FLAG_DISABLE_MOVE
    if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    if (this._owner.isPlayer()) {
      logDebug("movement", () => `Player (${this._owner.getGUID()}) move confused`);
      this.mutate(new ConfusedMovementGenerator<MovementOwnerPlayer>(), MOTION_SLOT_CONTROLLED);
    } else {
      logDebug("movement", () => `Creature (${this._owner.getGUID()}) move confused`);
      this.mutate(new ConfusedMovementGenerator<MovementOwnerCreature>(), MOTION_SLOT_CONTROLLED);
    }
  }

  /**
   * @brief Force the unit to chase this target. Doesn't work with UNIT_FLAG_DISABLE_MOVE
   *
   * Overloads: `(target, std::optional<ChaseRange> dist, std::optional<ChaseAngle> angle)`, `(target, float dist, float angle)`
   * and `(target, float dist)`.
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveChase
   */
  moveChase(target: MovementOwner | null, dist?: ChaseRange | number | null, angle?: ChaseAngle | number | null): void {
    const range = typeof dist === "number" ? new ChaseRange(dist) : (dist ?? null);
    const chaseAngle = typeof angle === "number" ? new ChaseAngle(angle) : (angle ?? null);

    // ignore movement request if target not exist
    if (!target || target === this._owner || this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    if (this.getCurrentMovementGeneratorType() === CHASE_MOTION_TYPE) {
      const gen = this.top() as ChaseMovementGenerator<MovementOwner>;
      gen.setOffsetAndAngle(range, chaseAngle);
      gen.setNewTarget(target);
      return;
    }

    //_owner->ClearUnitState(UNIT_STATE_FOLLOW);
    if (this._owner.isPlayer()) {
      logDebug("movement", () => `Player (${this._owner.getGUID()}) chase to ${target.isPlayer() ? "player" : "creature"} (${target.getGUID()})`);
      this.mutate(new ChaseMovementGenerator<MovementOwnerPlayer>(target, range, chaseAngle), MOTION_SLOT_ACTIVE);
    } else {
      logDebug("movement", () => `Creature (${this._owner.getGUID()}) chase to ${target.isPlayer() ? "player" : "creature"} (${target.getGUID()})`);
      this.mutate(new ChaseMovementGenerator<MovementOwnerCreature>(target, range, chaseAngle), MOTION_SLOT_ACTIVE);
    }
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::DistanceYourself */
  distanceYourself(dist: number): void {
    if (this.getCurrentMovementGeneratorType() === CHASE_MOTION_TYPE) {
      const gen = this.top() as ChaseMovementGenerator<MovementOwner>;
      gen.distanceYourself(this._owner, dist);
    }
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::MoveBackwards */
  moveBackwards(target: MovementOwner | null, dist: number): void {
    if (!target) return;

    const angle = target.getAngle(this._owner);
    const point = new Vector3();
    point.x = F(target.getPositionX() + F(dist * F(Math.cos(angle))));
    point.y = F(target.getPositionY() + F(dist * F(Math.sin(angle))));
    point.z = target.getPositionZ();

    if (!this._owner.getMap().canReachPositionAndGetValidCoords(this._owner, point, true, true)) return;

    const init = new MoveSplineInit(this._owner);
    init.moveTo(point.x, point.y, point.z, false);
    init.setWalk(true);
    init.setFacing(target);
    init.setOrientationInversed();
    init.launch();
  }

  /** like movebackwards, but without the inversion. @ac game/Movement/MotionMaster.cpp MotionMaster::MoveForwards */
  moveForwards(target: MovementOwner | null, dist: number): void {
    if (!target) return;

    const angle = target.getAngle(this._owner);
    const point = new Vector3();
    point.x = F(target.getPositionX() + F(dist * F(Math.cos(angle))));
    point.y = F(target.getPositionY() + F(dist * F(Math.sin(angle))));
    point.z = target.getPositionZ();

    if (!this._owner.getMap().canReachPositionAndGetValidCoords(this._owner, point, true, true)) return;

    const init = new MoveSplineInit(this._owner);
    init.moveTo(point.x, point.y, point.z, false);
    init.setFacing(target);
    init.launch();
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::MoveCircleTarget */
  moveCircleTarget(target: MovementOwner | null): void {
    if (!target) return;

    const pos = target.getMeleeAttackPoint(this._owner);
    if (!pos) return;

    const init = new MoveSplineInit(this._owner);
    init.moveTo(pos.getPositionX(), pos.getPositionY(), pos.getPositionZ(), false);
    init.setWalk(true);
    init.setFacing(target);
    init.launch();
  }

  /**
   * @brief The unit will follow this target. Doesn't work with UNIT_FLAG_DISABLE_MOVE
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveFollow
   */
  moveFollow(target: MovementOwner | null, dist: number, angle: number, slot: MovementSlot = MOTION_SLOT_ACTIVE, inheritWalkState = true, inheritSpeed = true): void {
    // ignore movement request if target not exist
    if (!target || target === this._owner || this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    //_owner->AddUnitState(UNIT_STATE_FOLLOW);
    if (this._owner.isPlayer()) {
      logDebug("movement", () => `Player (${this._owner.getGUID()}) follow to ${target.isPlayer() ? "player" : "creature"} (${target.getGUID()})`);
      this.mutate(new FollowMovementGenerator<MovementOwnerPlayer>(target, dist, new ChaseAngle(angle), inheritWalkState, inheritSpeed), slot);
    } else {
      logDebug("movement", () => `Creature (${this._owner.getGUID()}) follow to ${target.isPlayer() ? "player" : "creature"} (${target.getGUID()})`);
      this.mutate(new FollowMovementGenerator<MovementOwnerCreature>(target, dist, new ChaseAngle(angle), inheritWalkState, inheritSpeed), slot);
    }
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::MoveFormation */
  moveFormation(leader: MovementOwner | null, dist: number, angle: number, point1: number, point2: number): void {
    if (!leader || leader === this._owner || this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    if (!this._owner.isCreature()) return;

    this.mutate(new FormationMovementGenerator(leader, dist, angle, point1, point2), MOTION_SLOT_IDLE);
  }

  /**
   * @brief The unit will move to a specific point. Doesn't work with UNIT_FLAG_DISABLE_MOVE
   *
   * For transition movement between the ground and the air, use MoveLand or MoveTakeoff instead.
   *
   * Overloads: `(id, Position const& pos, forcedMovement, speed, generatePath, forceDestination, animTier)` and
   * `(id, x, y, z, forcedMovement, speed, orientation, generatePath, forceDestination, slot, animTier)`.
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MovePoint
   */
  movePoint(
    id: number,
    pos: Position,
    forcedMovement?: ForcedMovement,
    speed?: number,
    generatePath?: boolean,
    forceDestination?: boolean,
    animTier?: AnimTier | null,
  ): void;
  movePoint(
    id: number,
    x: number,
    y: number,
    z: number,
    forcedMovement?: ForcedMovement,
    speed?: number,
    orientation?: number,
    generatePath?: boolean,
    forceDestination?: boolean,
    slot?: MovementSlot,
    animTier?: AnimTier | null,
  ): void;
  movePoint(id: number, a: number | Position, ...rest: unknown[]): void {
    if (typeof a !== "number") {
      const [forcedMovement = FORCED_MOVEMENT_NONE, speed = 0.0, generatePath = true, forceDestination = true, animTier = null] = rest as [
        ForcedMovement?,
        number?,
        boolean?,
        boolean?,
        (AnimTier | null)?,
      ];
      this.movePoint(id, a.getPositionX(), a.getPositionY(), a.getPositionZ(), forcedMovement, speed, a.getOrientation(), generatePath, forceDestination, MOTION_SLOT_ACTIVE, animTier);
      return;
    }

    const [y, z, forcedMovement = FORCED_MOVEMENT_NONE, speed = 0.0, orientation = 0.0, generatePath = true, forceDestination = true, slot = MOTION_SLOT_ACTIVE, animTier = null] = rest as [
      number,
      number,
      ForcedMovement?,
      number?,
      number?,
      boolean?,
      boolean?,
      MovementSlot?,
      (AnimTier | null)?,
    ];
    const x = a;

    if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    if (this._owner.isPlayer()) {
      logDebug("movement", () => `Player (${this._owner.getGUID()}) targeted point (Id: ${id} X: ${x} Y: ${y} Z: ${z})`);
      this.mutate(new PointMovementGenerator<MovementOwnerPlayer>(id, x, y, z, forcedMovement, speed, orientation, null, generatePath, forceDestination, animTier), slot);
    } else {
      logDebug("movement", () => `Creature (${this._owner.getGUID()}) targeted point (ID: ${id} X: ${x} Y: ${y} Z: ${z})`);
      this.mutate(new PointMovementGenerator<MovementOwnerCreature>(id, x, y, z, forcedMovement, speed, orientation, null, generatePath, forceDestination, animTier), slot);
    }
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::MoveSplinePath */
  moveSplinePath(path: PointsArray | null, forcedMovement: ForcedMovement = FORCED_MOVEMENT_NONE): void {
    // Xinef: do not allow to move with UNIT_FLAG_DISABLE_MOVE
    if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    if (this._owner.isPlayer()) {
      this.mutate(new EscortMovementGenerator<MovementOwnerPlayer>(forcedMovement, path), MOTION_SLOT_ACTIVE);
    } else {
      this.mutate(new EscortMovementGenerator<MovementOwnerCreature>(forcedMovement, path), MOTION_SLOT_ACTIVE);
    }
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::MovePath */
  movePath(path_id: number, forcedMovement: ForcedMovement = FORCED_MOVEMENT_NONE, pathSource: PathSource = PathSource.WAYPOINT_MGR): void {
    const path = GetWaypointPath(pathSource, path_id);

    if (path === null) {
      logError("sql", `WaypointMovementGenerator::LoadPath: creature ${this._owner.getName()} (${this._owner.getGUID()}) doesn't have waypoint path id: ${path_id} pathSource: ${pathSource}`);
      return;
    }

    const points: PointsArray = [];
    for (const node of path.Nodes) {
      points.push(new Vector3(node.X, node.Y, node.Z));
    }

    // pass the new PointsArray* to the appropriate MoveSplinePath function
    this.moveSplinePath(points, forcedMovement);
  }

  /**
   * @brief Use to move the unit from the air to the ground. Doesn't work with UNIT_FLAG_DISABLE_MOVE
   *
   * Overloads: `(id, Position const& pos, speed)` and `(id, x, y, z, speed)`.
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveLand
   */
  moveLand(id: number, pos: Position, speed?: number): void;
  moveLand(id: number, x: number, y: number, z: number, speed?: number): void;
  moveLand(id: number, a: Position | number, b?: number, c?: number, d = 0.0): void {
    if (typeof a === "number") {
      // pussywizard: added for easy calling by passing 3 floats x, y, z
      this.moveLand(id, new Position(a, b!, c!, 0.0), d);
      return;
    }

    const speed = b ?? 0.0;
    if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    const x = a.getPositionX();
    const y = a.getPositionY();
    const z = a.getPositionZ();

    logDebug("movement", () => `Creature (Entry: ${this._owner.getEntry()}) landing point (ID: ${id} X: ${x} Y: ${y} Z: ${z})`);

    const init = new MoveSplineInit(this._owner);
    init.moveTo(x, y, z);

    if (speed > 0.0) init.setVelocity(speed);

    init.setAnimation(AnimTier.Ground);

    this.mutate(new EffectMovementGenerator(init, id), MOTION_SLOT_ACTIVE);
  }

  /**
   * @brief Use to move the unit from the ground to the air. Doesn't work with UNIT_FLAG_DISABLE_MOVE
   *
   * Overloads: `(id, Position const& pos, speed, skipAnimation)` and `(id, x, y, z, speed, skipAnimation)`.
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveTakeoff
   */
  moveTakeoff(id: number, pos: Position, speed?: number, skipAnimation?: boolean): void;
  moveTakeoff(id: number, x: number, y: number, z: number, speed?: number, skipAnimation?: boolean): void;
  moveTakeoff(id: number, a: Position | number, ...rest: (number | boolean | undefined)[]): void {
    if (typeof a === "number") {
      const [y, z, speed = 0.0, skipAnimation = false] = rest as [number, number, number?, boolean?];
      this.moveTakeoff(id, new Position(a, y, z, 0.0), speed, skipAnimation);
      return;
    }

    const [speed = 0.0, skipAnimation = false] = rest as [number?, boolean?];
    if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    const x = a.getPositionX();
    const y = a.getPositionY();
    const z = a.getPositionZ();

    logDebug("movement", () => `Creature (Entry: ${this._owner.getEntry()}) landing point (ID: ${id} X: ${x} Y: ${y} Z: ${z})`);

    const init = new MoveSplineInit(this._owner);
    init.moveTo(x, y, z);

    if (speed > 0.0) init.setVelocity(speed);

    if (!skipAnimation) init.setAnimation(AnimTier.Hover);

    this.mutate(new EffectMovementGenerator(init, id), MOTION_SLOT_ACTIVE);
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::MoveKnockbackFrom */
  moveKnockbackFrom(srcX: number, srcY: number, speedXY: number, speedZ: number, allowClientControlled = false): void {
    //this function may make players fall below map
    if (!allowClientControlled && this._owner.isPlayer() && this._owner.isClientControlled()) return;

    if (speedXY <= F(0.1)) return;

    const dest = this._owner.getPosition();
    const moveTimeHalf = F(speedZ / gravity);
    const dist = F(F(2 * moveTimeHalf) * speedXY);
    const max_height = -computeFallElevation(moveTimeHalf, false, -speedZ);

    // Use a mmap raycast to get a valid destination.
    this._owner.movePositionToFirstCollision(dest, dist, F(this._owner.getRelativeAngle(srcX, srcY) + F(M_PI)));

    const init = new MoveSplineInit(this._owner);
    init.moveTo(dest.getPositionX(), dest.getPositionY(), dest.getPositionZ());
    init.setParabolic(max_height, 0);
    init.setOrientationFixed(true);
    init.setVelocity(speedXY);

    // Do not mutate an active fleeing/confused movement generator,
    // doing so breaks the movement upon landing from the knockback
    const slotType = this.getMotionSlotType(MOTION_SLOT_CONTROLLED);
    if (slotType === FLEEING_MOTION_TYPE || slotType === CONFUSED_MOTION_TYPE) {
      init.launch();
      return;
    }

    this.mutate(new EffectMovementGenerator(init, 0), MOTION_SLOT_CONTROLLED);
  }

  /**
   * @brief The unit will jump in a specific direction
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveJumpTo
   */
  moveJumpTo(angle: number, speedXY: number, speedZ: number): void {
    //this function may make players fall below map
    if (this._owner.isPlayer()) return;

    const moveTimeHalf = F(speedZ / gravity);
    const dist = F(F(2 * moveTimeHalf) * speedXY);
    const p = this._owner.getClosePoint(this._owner.getObjectSize(), dist, angle);
    this.moveJump(p.x, p.y, p.z, speedXY, speedZ);
  }

  /**
   * @brief The unit will jump to a specific point
   *
   * Overloads: `(Position const& pos, speedXY, speedZ, id)` and `(x, y, z, speedXY, speedZ, id, Unit const* target)`.
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveJump
   */
  moveJump(pos: Position, speedXY: number, speedZ: number, id?: number): void;
  moveJump(x: number, y: number, z: number, speedXY: number, speedZ: number, id?: number, target?: MovementOwner | null): void;
  moveJump(a: Position | number, b: number, c: number, d?: number, e?: number, f = 0, g: MovementOwner | null = null): void {
    if (typeof a !== "number") {
      this.moveJump(a.getPositionX(), a.getPositionY(), a.getPositionZ(), b, c, d ?? 0);
      return;
    }

    const x = a;
    const y = b;
    const z = c;
    const speedXY = d!;
    const speedZ = e!;
    const id = f;
    const target = g;
    logDebug("movement", () => `Unit (${this._owner.getGUID()}) jump to point (X: ${x} Y: ${y} Z: ${z})`);

    if (speedXY <= F(0.1)) return;

    const moveTimeHalf = F(speedZ / gravity);
    const max_height = -computeFallElevation(moveTimeHalf, false, -speedZ);

    const init = new MoveSplineInit(this._owner);
    init.moveTo(x, y, z);
    init.setParabolic(max_height, 0);
    init.setVelocity(speedXY);
    if (target) init.setFacing(target);

    this.mutate(new EffectMovementGenerator(init, id), MOTION_SLOT_CONTROLLED);
  }

  /**
   * @brief Makes the unit travel a closed, cyclic path around (x, y, z).
   *
   * The path starts at the unit's bearing from the centre. Flight state decides whether z pins to
   * the argument or follows the terrain, and which speed is used; forcedMovement overrides the
   * walk/run choice, and FORCED_MOVEMENT_FLY flies a unit that is not fly-flagged.
   *
   * @param stepCount Number of points the path is built from, must be at least 2: a lower count
   *                  yields an empty or single-point path, which Launch() refuses, leaving the unit
   *                  idle with neither spline nor movement generator.
   * @param speed     Fixed velocity; 0.0f keeps the speed the movement flags select.
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveCirclePath
   */
  moveCirclePath(x: number, y: number, z: number, radius: number, clockwise: boolean, stepCount: number, forcedMovement: ForcedMovement = FORCED_MOVEMENT_NONE, speed = 0.0): void {
    if (stepCount < 2) {
      logError("movement", `MotionMaster::MoveCirclePath: stepCount ${stepCount} for unit (${this._owner.getGUID()}), no path launched`);
      return;
    }

    // FORCED_MOVEMENT_FLY flies units that are not fly-flagged, so z and the spline flags have to
    // key off the same value.
    const flying = this._owner.isFlying() || forcedMovement === FORCED_MOVEMENT_FLY;

    const step = F(F(F(2 * F(M_PI)) / stepCount) * (clockwise ? -1.0 : 1.0));
    const pos = new Position(x, y, z, 0.0);
    let angle = pos.getAngle(this._owner.getPositionX(), this._owner.getPositionY());

    const init = new MoveSplineInit(this._owner);

    for (let i = 0; i < stepCount; angle = F(angle + step), ++i) {
      const point = new Vector3();
      point.x = F(x + F(radius * F(Math.cos(angle))));
      point.y = F(y + F(radius * F(Math.sin(angle))));

      if (flying) point.z = z;
      else {
        point.z = this._owner.getMap().getHeight(this._owner.getPhaseMask(), point.x, point.y, z);

        if (point.z <= INVALID_HEIGHT) {
          logError("movement", `MotionMaster::MoveCirclePath: no ground below (${point.x}, ${point.y}) for unit (${this._owner.getGUID()}), no path launched`);
          return;
        }
      }

      init.path().push(point);
    }

    if (flying) {
      init.setFly();
      init.setCyclic();
      init.setAnimation(AnimTier.Fly);
    } else {
      init.setWalk(true);
      init.setSmooth();
      init.setCyclic();
    }

    if (forcedMovement === FORCED_MOVEMENT_WALK) init.setWalk(true);
    else if (forcedMovement === FORCED_MOVEMENT_RUN) init.setWalk(false);

    if (speed > 0.0) init.setVelocity(speed);

    init.launch();
  }

  /**
   * @brief The unit will fall. Used when in the air. Doesn't work with UNIT_FLAG_DISABLE_MOVE
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveFall
   */
  moveFall(id = 0, addFlagForNPC = false): void {
    if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    // use larger distance for vmap height search than in most other cases
    const tz = this._owner.getMapHeight(this._owner.getPositionX(), this._owner.getPositionY(), this._owner.getPositionZ(), true, MAX_FALL_DISTANCE);
    if (tz <= INVALID_HEIGHT) {
      logDebug(
        "movement",
        () =>
          `MotionMaster::MoveFall: unable retrive a proper height at map ${this._owner.getMap().getId()} (x: ${this._owner.getPositionX()}, y: ${this._owner.getPositionX()}, z: ${this._owner.getPositionZ() + this._owner.getPositionZ()}).`,
      );
      return;
    }

    // Abort too if the ground is very near
    if (Math.abs(this._owner.getPositionZ() - tz) < F(0.1)) return;

    const player = this._owner.toPlayer();
    if (player) {
      this._owner.addUnitMovementFlag(MOVEMENTFLAG_FALLING);
      this._owner.m_movementInfo.setFallTime(0);
      player.setFallInformation(getGameTime(), this._owner.getPositionZ());
    } else if (this._owner.isCreature() && addFlagForNPC) {
      // pussywizard
      this._owner.removeUnitMovementFlag(MOVEMENTFLAG_MASK_MOVING);
      this._owner.removeUnitMovementFlag(MOVEMENTFLAG_FLYING | MOVEMENTFLAG_CAN_FLY);
      this._owner.addUnitMovementFlag(MOVEMENTFLAG_FALLING);
      this._owner.m_movementInfo.setFallTime(0);
      this._owner.sendMovementFlagUpdate();
    }

    const init = new MoveSplineInit(this._owner);
    init.moveTo(this._owner.getPositionX(), this._owner.getPositionY(), tz + this._owner.getHoverHeight());
    init.setFall();

    this.mutate(new EffectMovementGenerator(init, id), MOTION_SLOT_CONTROLLED);
  }

  /**
   * @brief The unit will charge the target. Doesn't work with UNIT_FLAG_DISABLE_MOVE
   *
   * Overloads: `(x, y, z, speed, id, path, generatePath, orientation, targetGUID)` and `(PathGenerator const& path, speed, targetGUID)`.
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveCharge
   */
  moveCharge(x: number, y: number, z: number, speed?: number, id?: number, path?: PointsArray | null, generatePath?: boolean, orientation?: number, targetGUID?: bigint): void;
  moveCharge(path: PathGenerator, speed?: number, targetGUID?: bigint): void;
  moveCharge(a: number | PathGenerator, b?: number, c?: number | bigint, d: number = SPEED_CHARGE, e: number = EVENT_CHARGE, f: PointsArray | null = null, g = false, h = 0.0, i = 0n): void {
    if (typeof a !== "number") {
      const speed = b ?? SPEED_CHARGE;
      const targetGUID = (c as bigint | undefined) ?? 0n;
      const dest = a.getActualEndPosition();

      this.moveCharge(dest.x, dest.y, dest.z, speed, EVENT_CHARGE_PREPATH, null, false, 0.0, targetGUID);

      // Charge movement is not started when using EVENT_CHARGE_PREPATH
      const init = new MoveSplineInit(this._owner);
      init.movebyPath(a.getPath() as PointsArray);
      init.setVelocity(speed);
      init.launch();
      return;
    }

    const x = a;
    const y = b!;
    const z = c as number;
    const speed = d;
    const id = e;
    const path = f;
    const generatePath = g;
    const orientation = h;
    const targetGUID = i;

    if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    const controlled = this.Impl[MOTION_SLOT_CONTROLLED];
    if (controlled && controlled.getMovementGeneratorType() !== DISTRACT_MOTION_TYPE) return;

    if (this._owner.isPlayer()) {
      logDebug("movement", () => `Player (${this._owner.getGUID()}) charge point (X: ${x} Y: ${y} Z: ${z})`);
      this.mutate(
        new PointMovementGenerator<MovementOwnerPlayer>(id, x, y, z, FORCED_MOVEMENT_NONE, speed, orientation, path, generatePath, generatePath, null, targetGUID),
        MOTION_SLOT_CONTROLLED,
      );
    } else {
      logDebug("movement", () => `Creature (${this._owner.getGUID()}) charge point (X: ${x} Y: ${y} Z: ${z})`);
      this.mutate(
        new PointMovementGenerator<MovementOwnerCreature>(id, x, y, z, FORCED_MOVEMENT_NONE, speed, orientation, path, generatePath, generatePath, null, targetGUID),
        MOTION_SLOT_CONTROLLED,
      );
    }
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::MoveSeekAssistance */
  moveSeekAssistance(x: number, y: number, z: number): void {
    // Xinef: do not allow to move with UNIT_FLAG_DISABLE_MOVE
    if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    if (this._owner.isPlayer()) {
      logError("movement", `Player (${this._owner.getGUID()}) attempt to seek assistance`);
    } else {
      logDebug("movement", () => `Creature (${this._owner.getGUID()}) seek assistance (X: ${x} Y: ${y} Z: ${z})`);
      this._owner.attackStop();
      this._owner.castStop(0, false);
      this._owner.toCreature()!.setReactState(REACT_PASSIVE);
      this.mutate(new AssistanceMovementGenerator(x, y, z), MOTION_SLOT_ACTIVE);
    }
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::MoveSeekAssistanceDistract */
  moveSeekAssistanceDistract(time: number): void {
    // Xinef: do not allow to move with UNIT_FLAG_DISABLE_MOVE
    if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    if (this._owner.isPlayer()) {
      logError("movement", `Player (${this._owner.getGUID()}) attempt to call distract after assistance`);
    } else {
      logDebug("movement", () => `Creature (${this._owner.getGUID()}) is distracted after assistance call (Time: ${time})`);
      this.mutate(new AssistanceDistractMovementGenerator(time), MOTION_SLOT_ACTIVE);
    }
  }

  /**
   * @brief Enable the target's fleeing movement. Doesn't work with UNIT_FLAG_DISABLE_MOVE
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveFleeing
   */
  moveFleeing(enemy: MovementOwner | null, time = 0): void {
    if (!enemy) return;

    if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    if (this._owner.isPlayer()) {
      logDebug("movement", () => `Player (${this._owner.getGUID()}) flee from ${enemy.isPlayer() ? "player" : "creature"} (${enemy.getGUID()})`);
      this.mutate(new FleeingMovementGenerator<MovementOwnerPlayer>(enemy.getGUID()), MOTION_SLOT_CONTROLLED);
    } else {
      logDebug("movement", () => `Creature (${this._owner.getGUID()}) flee from ${enemy.isPlayer() ? "player" : "creature"} (${enemy.getGUID()}) ${time ? " for a limited time" : ""}`);
      if (time) this.mutate(new TimedFleeingMovementGenerator(enemy.getGUID(), time), MOTION_SLOT_CONTROLLED);
      else this.mutate(new FleeingMovementGenerator<MovementOwnerCreature>(enemy.getGUID()), MOTION_SLOT_CONTROLLED);
    }
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::MoveTaxiFlight */
  moveTaxiFlight(path: number, pathnode: number): void {
    const player = this._owner.toPlayer();
    if (player) {
      if (path < FlightPathContext.getTaxiPathNodesByPath().length) {
        logDebug("movement", () => `${this._owner.getName()} taxi to (Path ${path} node ${pathnode})`);
        const mgen = new FlightPathMovementGenerator(pathnode);
        if (!mgen.loadPath(player)) {
          logError("movement", `${this._owner.getName()} failed to build taxi path (Path ${path} node ${pathnode}), clearing taxi destinations`);
          player.m_taxi.clearTaxiDestinations();
          player.dismount();
          mgen.destroy();
          return;
        }

        this.mutate(mgen, MOTION_SLOT_CONTROLLED);
      } else {
        logError("movement", `${this._owner.getName()} attempt taxi to (not existed Path ${path} node ${pathnode})`);
      }
    } else {
      logError("movement", `Creature (${this._owner.getGUID()}) attempt taxi to (Path ${path} node ${pathnode})`);
    }
  }

  /**
   * @brief Enable the target's distract movement. Doesn't work with UNIT_FLAG_DISABLE_MOVE and
   * if the unit has MOTION_SLOT_CONTROLLED (generaly apply when the unit is controlled).
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveDistract
   */
  moveDistract(timer: number): void {
    if (this.Impl[MOTION_SLOT_CONTROLLED]) return;

    if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    const mgen = new DistractMovementGenerator(timer);
    this.mutate(mgen, MOTION_SLOT_CONTROLLED);
  }

  /** use Move* functions instead. @ac game/Movement/MotionMaster.cpp MotionMaster::Mutate */
  private mutate(m: MovementGenerator, slot: MovementSlot): void {
    const delayed = (this._cleanFlag & MMCF_UPDATE) !== 0;

    for (let curr = this.Impl[slot]; curr; curr = this.Impl[slot]) {
      // clear slot AND decrease top immediately to avoid crashes when referencing null top in DirectDelete
      this.Impl[slot] = null;
      while (!this.empty() && !this.top()) --this._top;

      if (delayed) this.delayedDelete(curr);
      else this.directDelete(curr);
    }

    if (this._top < slot) this._top = slot;

    this.Impl[slot] = m;
    if (this._top > slot) this._needInit[slot] = true;
    else {
      this._needInit[slot] = false;
      m.initialize(this._owner);
    }
  }

  /**
   * @brief Move the unit following a specific path. Doesn't work with UNIT_FLAG_DISABLE_MOVE
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveWaypoint
   */
  moveWaypoint(path_id: number, repeatable: boolean, pathSource: PathSource = PathSource.WAYPOINT_MGR): void {
    if (!path_id) return;

    if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    this.mutate(new WaypointMovementGenerator(path_id, repeatable, pathSource), MOTION_SLOT_IDLE);

    logDebug("movement", () => `${this._owner.isPlayer() ? "Player" : "Creature"} (${this._owner.getGUID()}) start moving over path(Id:${path_id}, repeatable: ${repeatable ? "YES" : "NO"})`);
  }

  /**
   * @brief Rotate the unit. You can specify the time of the rotation.
   * @ac game/Movement/MotionMaster.cpp MotionMaster::MoveRotate
   */
  moveRotate(time: number, direction: RotateDirection): void {
    if (!time) return;

    this.mutate(new RotateMovementGenerator(time, direction), MOTION_SLOT_ACTIVE);
  }

  /** Same as MovePoint, but the unit keeps facing away from the destination (walks backwards). @ac game/Movement/MotionMaster.cpp MotionMaster::MovePointBackwards */
  movePointBackwards(id: number, x: number, y: number, z: number, generatePath = true, forceDestination = true, slot: MovementSlot = MOTION_SLOT_ACTIVE, orientation = 0.0): void {
    if (this._owner.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) return;

    if (this._owner.isPlayer()) {
      logDebug("movement", () => `Player (${this._owner.getGUID()}) targeted point backwards (Id: ${id} X: ${x} Y: ${y} Z: ${z})`);
      this.mutate(new PointMovementGenerator<MovementOwnerPlayer>(id, x, y, z, FORCED_MOVEMENT_NONE, 0.0, orientation, null, generatePath, forceDestination, null, 0n, true), slot);
    } else {
      logDebug("movement", () => `Creature (${this._owner.getGUID()}) targeted point backwards (ID: ${id} X: ${x} Y: ${y} Z: ${z})`);
      this.mutate(new PointMovementGenerator<MovementOwnerCreature>(id, x, y, z, FORCED_MOVEMENT_NONE, 0.0, orientation, null, generatePath, forceDestination, null, 0n, true), slot);
    }
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::propagateSpeedChange */
  propagateSpeedChange(): void {
    for (let i = 0; i <= this._top; ++i) {
      this.Impl[i]?.unitSpeedChanged();
    }
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::ReinitializeMovement */
  reinitializeMovement(): void {
    for (let i = 0; i <= this._top; ++i) {
      this.Impl[i]?.reset(this._owner);
    }
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::GetCurrentMovementGeneratorType */
  getCurrentMovementGeneratorType(): MovementGeneratorType {
    if (this.empty()) return IDLE_MOTION_TYPE;

    return this.top()!.getMovementGeneratorType();
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::GetMotionSlotType */
  getMotionSlotType(slot: number): MovementGeneratorType {
    const gen = this.Impl[slot];
    if (!gen) return NULL_MOTION_TYPE;
    return gen.getMovementGeneratorType();
  }

  /** @ac game/Movement/MotionMaster.cpp MotionMaster::HasMovementGeneratorType */
  hasMovementGeneratorType(type: MovementGeneratorType): boolean {
    if (this.empty() && type === IDLE_MOTION_TYPE) return true;

    for (let i = this._top; i >= 0; --i) {
      const gen = this.Impl[i];
      if (gen && gen.getMovementGeneratorType() === type) return true;
    }

    return false;
  }

  /** Xinef: Escort system. @ac game/Movement/MotionMaster.cpp MotionMaster::GetCurrentSplineId */
  getCurrentSplineId(): number {
    if (this.empty()) return 0;

    return this.top()!.getSplineId();
  }

  /** The `float& x, y, z` out parameters are `dest`. @ac game/Movement/MotionMaster.cpp MotionMaster::GetDestination */
  getDestination(dest: { x: number; y: number; z: number }): boolean {
    if (this._owner.movespline.finalized()) return false;

    const d = this._owner.movespline.finalDestination();
    dest.x = d.x;
    dest.y = d.y;
    dest.z = d.z;
    return true;
  }
}
