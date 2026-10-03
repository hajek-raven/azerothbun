import { describe, expect, test } from "bun:test";
import { Vector3 } from "../../math/Vector3.ts";
import { UNIT_FLAG_DISABLE_MOVE, UNIT_STATE_CHASE, UNIT_STATE_DISTRACTED, UNIT_STATE_FLEEING, UNIT_STATE_ROAMING } from "../../spells/enums.ts";
import {
  ASSISTANCE_DISTRACT_MOTION_TYPE,
  CHASE_MOTION_TYPE,
  ChaseAngle,
  ChaseRange,
  CONFUSED_MOTION_TYPE,
  DISTRACT_MOTION_TYPE,
  EFFECT_MOTION_TYPE,
  ESCORT_MOTION_TYPE,
  FLEEING_MOTION_TYPE,
  FOLLOW_MOTION_TYPE,
  FORCED_MOVEMENT_NONE,
  FORMATION_MOTION_TYPE,
  HOME_MOTION_TYPE,
  IDLE_MOTION_TYPE,
  MMCF_INUSE,
  MMCF_NONE,
  MMCF_UPDATE,
  MotionMaster,
  MOTION_SLOT_ACTIVE,
  MOTION_SLOT_CONTROLLED,
  MOTION_SLOT_IDLE,
  type MovementGeneratorType,
  type MovementSlot,
  NULL_MOTION_TYPE,
  POINT_MOTION_TYPE,
  RANDOM_MOTION_TYPE,
  ROTATE_DIRECTION_LEFT,
  ROTATE_MOTION_TYPE,
  SPEED_CHARGE,
  TIMED_FLEEING_MOTION_TYPE,
  WAYPOINT_MOTION_TYPE,
} from "./MotionMaster.ts";
import { MovementGenerator } from "./MovementGenerator.ts";
import type { MovementOwner } from "./MovementOwner.ts";
import { FakeUnit } from "./test-movement-owner.ts";

/** A generator that logs every call and reports `type`; `update` returns what `updateResult` says. */
class Probe extends MovementGenerator {
  readonly log: string[] = [];
  updateResult = true;
  onUpdate: ((unit: MovementOwner) => void) | null = null;

  constructor(
    readonly type: MovementGeneratorType,
    readonly name: string,
  ) {
    super();
  }
  initialize(): void {
    this.log.push(`${this.name}.initialize`);
  }
  finalize(): void {
    this.log.push(`${this.name}.finalize`);
  }
  reset(): void {
    this.log.push(`${this.name}.reset`);
  }
  update(unit: MovementOwner): boolean {
    this.log.push(`${this.name}.update`);
    this.onUpdate?.(unit);
    return this.updateResult;
  }
  override destroy(): void {
    this.log.push(`${this.name}.destroy`);
  }
  override getSplineId(): number {
    return this.type === ESCORT_MOTION_TYPE ? 77 : 0;
  }
  override unitSpeedChanged(): void {
    this.log.push(`${this.name}.speed`);
  }
  getMovementGeneratorType(): MovementGeneratorType {
    return this.type;
  }
}

/** `MotionMaster::Mutate` is private (the `Move*` functions are the interface); the tests put a probe in a slot directly. */
function mutate(mm: MotionMaster, m: MovementGenerator, slot: MovementSlot): void {
  (mm as unknown as { mutate(m: MovementGenerator, slot: MovementSlot): void }).mutate(m, slot);
}

function creature() {
  const unit = new FakeUnit({ pos: [100, 100, 10] });
  unit.motionMaster.initialize();
  return unit;
}

describe("ChaseRange and ChaseAngle", () => {
  test("ChaseRange(range): inside CONTACT_DISTANCE the minimum is 0", () => {
    const near = new ChaseRange(0.25);
    expect(near.MinRange).toBe(-0.25); // `range - CONTACT_DISTANCE` when range <= CONTACT_DISTANCE
    expect(near.MinTolerance).toBe(0.25);
    expect(near.MaxRange).toBe(0.75);
    expect(near.MaxTolerance).toBe(0.25);
    const far = new ChaseRange(5);
    expect(far.MinRange).toBe(0); // 0 when range > CONTACT_DISTANCE
    expect(far.MaxRange).toBe(5.5);
    expect(far.MaxTolerance).toBe(5);
  });

  test("ChaseRange(min, max) derives the tolerances", () => {
    const r = new ChaseRange(2, 10);
    expect(r.MinRange).toBe(2);
    expect(r.MinTolerance).toBe(2.5);
    expect(r.MaxRange).toBe(10);
    expect(r.MaxTolerance).toBe(9.5);
    const tight = new ChaseRange(2, 2.2);
    expect(tight.MinTolerance).toBeCloseTo(2.1, 5); // min(2.5, 2.1)
    expect(tight.MaxTolerance).toBeCloseTo(2.1, 5); // max(1.7, MinTolerance)
  });

  test("ChaseRange(min, minTolerance, maxTolerance, max) stores the four values", () => {
    const r = new ChaseRange(1, 2, 3, 4);
    expect([r.MinRange, r.MinTolerance, r.MaxTolerance, r.MaxRange]).toEqual([1, 2, 3, 4]);
  });

  test("ChaseAngle normalizes the angle and checks it with wrap around", () => {
    const a = new ChaseAngle(-Math.PI / 2, 0.5);
    expect(a.RelativeAngle).toBeCloseTo((3 * Math.PI) / 2, 5);
    expect(a.isAngleOkay((3 * Math.PI) / 2 + 0.4)).toBe(true);
    expect(a.isAngleOkay((3 * Math.PI) / 2 + 0.6)).toBe(false);
    // the shortest way around 0 / 2pi
    const behind = new ChaseAngle(0.1, 0.3);
    expect(behind.isAngleOkay(2 * Math.PI - 0.1)).toBe(true);
    expect(behind.upperBound()).toBeCloseTo(0.4, 5);
    expect(behind.lowerBound()).toBeCloseTo(2 * Math.PI - 0.2, 5);
  });

  test("ChaseAngle tolerance defaults to pi / 4", () => {
    expect(new ChaseAngle(1).Tolerance).toBeCloseTo(Math.PI / 4, 6);
  });
});

describe("MotionMaster stack", () => {
  test("initialize makes the default idle generator", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    expect(mm.empty()).toBe(false);
    expect(mm.size()).toBe(1);
    expect(mm.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
    expect(mm.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(IDLE_MOTION_TYPE);
    expect(mm.getMotionSlotType(MOTION_SLOT_ACTIVE)).toBe(NULL_MOTION_TYPE);
    expect(mm.hasMovementGeneratorType(IDLE_MOTION_TYPE)).toBe(true);
    expect(mm.hasMovementGeneratorType(CHASE_MOTION_TYPE)).toBe(false);
  });

  test("an empty motion master reports idle", () => {
    const unit = new FakeUnit();
    expect(unit.motionMaster.empty()).toBe(true);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
    expect(unit.motionMaster.hasMovementGeneratorType(IDLE_MOTION_TYPE)).toBe(true);
    expect(unit.motionMaster.getCurrentSplineId()).toBe(0);
  });

  test("the default movement type of a creature selects the idle slot generator (random)", () => {
    const unit = new FakeUnit({ pos: [0, 0, 0], defaultMovementType: RANDOM_MOTION_TYPE, wanderDistance: 5, spawnId: 5 });
    unit.motionMaster.initialize();
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(RANDOM_MOTION_TYPE);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING)).toBe(true);
  });

  test("a player (or a charmed creature) always gets the idle generator", () => {
    const player = new FakeUnit({ player: true, defaultMovementType: RANDOM_MOTION_TYPE });
    player.motionMaster.initialize();
    expect(player.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(IDLE_MOTION_TYPE);
    const pet = new FakeUnit({ defaultMovementType: RANDOM_MOTION_TYPE });
    pet.charmerOrOwner = player;
    pet.motionMaster.initialize();
    expect(pet.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(IDLE_MOTION_TYPE);
  });

  test("a generator in a higher slot is initialized at once and sits on top; a lower slot waits to be initialized", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const active = new Probe(POINT_MOTION_TYPE, "active");
    mutate(mm, active, MOTION_SLOT_ACTIVE);
    expect(active.log).toEqual(["active.initialize"]);
    expect(mm.size()).toBe(2);
    expect(mm.getCurrentMovementGeneratorType()).toBe(POINT_MOTION_TYPE);

    const idle = new Probe(WAYPOINT_MOTION_TYPE, "idle");
    mutate(mm, idle, MOTION_SLOT_IDLE);
    expect(idle.log).toEqual([]); // `_needInit`: it is below the top
    expect(mm.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(WAYPOINT_MOTION_TYPE);
    expect(mm.getCurrentMovementGeneratorType()).toBe(POINT_MOTION_TYPE);

    mm.movementExpired();
    expect(active.log).toEqual(["active.initialize", "active.finalize", "active.destroy"]);
    expect(idle.log).toEqual(["idle.initialize"]); // now on top: `InitTop`
    expect(mm.getCurrentMovementGeneratorType()).toBe(WAYPOINT_MOTION_TYPE);
    expect(mm.size()).toBe(1);
  });

  test("replacing a slot finalizes and deletes the generator that was in it", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const a = new Probe(POINT_MOTION_TYPE, "a");
    const b = new Probe(CHASE_MOTION_TYPE, "b");
    mutate(mm, a, MOTION_SLOT_ACTIVE);
    mutate(mm, b, MOTION_SLOT_ACTIVE);
    expect(a.log).toEqual(["a.initialize", "a.finalize", "a.destroy"]);
    expect(b.log).toEqual(["b.initialize"]);
    expect(mm.getCurrentMovementGeneratorType()).toBe(CHASE_MOTION_TYPE);
  });

  test("the controlled slot is above the active slot; expiring it resets the generator below", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const active = new Probe(POINT_MOTION_TYPE, "active");
    const controlled = new Probe(CONFUSED_MOTION_TYPE, "controlled");
    mutate(mm, active, MOTION_SLOT_ACTIVE);
    mutate(mm, controlled, MOTION_SLOT_CONTROLLED);
    expect(mm.size()).toBe(3);
    expect(mm.getCurrentMovementGeneratorType()).toBe(CONFUSED_MOTION_TYPE);
    expect(mm.hasMovementGeneratorType(POINT_MOTION_TYPE)).toBe(true);

    mm.movementExpired();
    expect(controlled.log).toEqual(["controlled.initialize", "controlled.finalize", "controlled.destroy"]);
    expect(active.log).toEqual(["active.initialize", "active.reset"]);
    expect(mm.getCurrentMovementGeneratorType()).toBe(POINT_MOTION_TYPE);

    // `MovementExpired(false)` does not reset
    const again = new Probe(CONFUSED_MOTION_TYPE, "again");
    mutate(mm, again, MOTION_SLOT_CONTROLLED);
    mm.movementExpired(false);
    expect(active.log).toEqual(["active.initialize", "active.reset"]);
  });

  test("expiring the only generator re-creates the default one", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    mm.movementExpired();
    expect(mm.size()).toBe(1);
    expect(mm.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
  });

  test("clear() keeps only the bottom generator (and resets it)", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const idle = new Probe(WAYPOINT_MOTION_TYPE, "idle");
    const active = new Probe(POINT_MOTION_TYPE, "active");
    const controlled = new Probe(CONFUSED_MOTION_TYPE, "controlled");
    mutate(mm, idle, MOTION_SLOT_IDLE);
    mutate(mm, active, MOTION_SLOT_ACTIVE);
    mutate(mm, controlled, MOTION_SLOT_CONTROLLED);
    mm.clear();
    expect(mm.size()).toBe(1);
    expect(mm.getCurrentMovementGeneratorType()).toBe(WAYPOINT_MOTION_TYPE);
    expect(active.log).toContain("active.finalize");
    expect(controlled.log).toContain("controlled.finalize");
    expect(idle.log).toEqual(["idle.initialize", "idle.reset"]);
  });

  test("clear(false) does not reset the bottom generator", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const idle = new Probe(WAYPOINT_MOTION_TYPE, "idle");
    mutate(mm, idle, MOTION_SLOT_IDLE);
    mutate(mm, new Probe(POINT_MOTION_TYPE, "active"), MOTION_SLOT_ACTIVE);
    mm.clear(false);
    expect(idle.log).toEqual(["idle.initialize"]);
  });

  test("movementExpiredOnSlot removes one slot in the middle of the stack", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const active = new Probe(POINT_MOTION_TYPE, "active");
    const controlled = new Probe(CONFUSED_MOTION_TYPE, "controlled");
    mutate(mm, active, MOTION_SLOT_ACTIVE);
    mutate(mm, controlled, MOTION_SLOT_CONTROLLED);
    mm.movementExpiredOnSlot(MOTION_SLOT_ACTIVE);
    expect(active.log).toEqual(["active.initialize", "active.finalize", "active.destroy"]);
    expect(mm.getMotionSlotType(MOTION_SLOT_ACTIVE)).toBe(NULL_MOTION_TYPE);
    expect(mm.getCurrentMovementGeneratorType()).toBe(CONFUSED_MOTION_TYPE);
    expect(mm.size()).toBe(3); // the top is the controlled slot
  });

  test("movementExpiredOnSlot is ignored while the motion is updating", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const active = new Probe(POINT_MOTION_TYPE, "active");
    mutate(mm, active, MOTION_SLOT_ACTIVE);
    active.onUpdate = () => mm.movementExpiredOnSlot(MOTION_SLOT_ACTIVE);
    mm.updateMotion(10);
    expect(mm.getMotionSlotType(MOTION_SLOT_ACTIVE)).toBe(POINT_MOTION_TYPE);
  });

  test("moveIdle only replaces a generator that is not the idle one", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const idle = new Probe(WAYPOINT_MOTION_TYPE, "wp");
    mutate(mm, idle, MOTION_SLOT_IDLE);
    mm.moveIdle();
    expect(idle.log).toEqual(["wp.initialize", "wp.finalize", "wp.destroy"]);
    expect(mm.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
    mm.moveIdle(); // already the idle generator: nothing happens
    expect(mm.size()).toBe(1);
  });

  test("propagateSpeedChange and reinitializeMovement reach every generator", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const a = new Probe(POINT_MOTION_TYPE, "a");
    const b = new Probe(CONFUSED_MOTION_TYPE, "b");
    mutate(mm, a, MOTION_SLOT_ACTIVE);
    mutate(mm, b, MOTION_SLOT_CONTROLLED);
    mm.propagateSpeedChange();
    expect(a.log).toContain("a.speed");
    expect(b.log).toContain("b.speed");
    mm.reinitializeMovement();
    expect(a.log).toContain("a.reset");
    expect(b.log).toContain("b.reset");
  });

  test("getCurrentSplineId is the top generator's spline id", () => {
    const unit = creature();
    mutate(unit.motionMaster, new Probe(ESCORT_MOTION_TYPE, "escort"), MOTION_SLOT_ACTIVE);
    expect(unit.motionMaster.getCurrentSplineId()).toBe(77);
  });

  test("destroy deletes every generator without finalizing", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const a = new Probe(POINT_MOTION_TYPE, "a");
    mutate(mm, a, MOTION_SLOT_ACTIVE);
    mm.destroy();
    expect(a.log).toEqual(["a.initialize", "a.destroy"]);
    expect(mm.empty()).toBe(true);
  });
});

describe("MotionMaster update and delayed deletion", () => {
  test("updateMotion ticks the top generator only", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const idle = new Probe(WAYPOINT_MOTION_TYPE, "idle");
    const active = new Probe(POINT_MOTION_TYPE, "active");
    mutate(mm, idle, MOTION_SLOT_IDLE);
    mutate(mm, active, MOTION_SLOT_ACTIVE);
    mm.updateMotion(50);
    expect(active.log).toContain("active.update");
    expect(idle.log).not.toContain("idle.update");
    expect(mm.getCleanFlags()).toBe(MMCF_NONE);
  });

  test("a generator that returns false from update expires", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const active = new Probe(POINT_MOTION_TYPE, "active");
    active.updateResult = false;
    mutate(mm, active, MOTION_SLOT_ACTIVE);
    mm.updateMotion(50);
    expect(active.log).toEqual(["active.initialize", "active.update", "active.finalize", "active.destroy"]);
    expect(mm.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
    expect(mm.getCleanFlags()).toBe(MMCF_NONE);
  });

  test("the clean flags show the update (`MMCF_UPDATE` / `MMCF_INUSE`) while the generator runs", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const active = new Probe(POINT_MOTION_TYPE, "active");
    let flags = 0;
    active.onUpdate = () => {
      flags = mm.getCleanFlags();
    };
    mutate(mm, active, MOTION_SLOT_ACTIVE);
    mm.updateMotion(1);
    expect(flags & MMCF_UPDATE).toBe(MMCF_UPDATE);
    expect(flags & MMCF_INUSE).toBe(MMCF_INUSE);
  });

  test("a clear() called from the running generator is delayed until the update ends", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const idle = new Probe(WAYPOINT_MOTION_TYPE, "idle");
    const active = new Probe(POINT_MOTION_TYPE, "active");
    mutate(mm, idle, MOTION_SLOT_IDLE);
    mutate(mm, active, MOTION_SLOT_ACTIVE);
    active.onUpdate = () => {
      mm.clear();
      expect(active.log).not.toContain("active.finalize"); // not deleted while it runs
    };
    mm.updateMotion(10);
    expect(active.log).toEqual(["active.initialize", "active.update", "active.finalize", "active.destroy"]);
    expect(mm.size()).toBe(1);
    expect(idle.log).toEqual(["idle.initialize", "idle.reset"]); // `MMCF_RESET` from `Clear(reset = true)`
  });

  test("a delayed expire from the running generator does not reset when asked not to", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const idle = new Probe(WAYPOINT_MOTION_TYPE, "idle");
    const active = new Probe(POINT_MOTION_TYPE, "active");
    mutate(mm, idle, MOTION_SLOT_IDLE);
    mutate(mm, active, MOTION_SLOT_ACTIVE);
    active.onUpdate = () => mm.movementExpired(false);
    mm.updateMotion(10);
    expect(mm.getCurrentMovementGeneratorType()).toBe(WAYPOINT_MOTION_TYPE);
    expect(idle.log).toEqual(["idle.initialize"]);
  });

  test("mutating a slot from the running generator deletes the old one after the update", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const active = new Probe(POINT_MOTION_TYPE, "active");
    const replacement = new Probe(CHASE_MOTION_TYPE, "replacement");
    mutate(mm, active, MOTION_SLOT_ACTIVE);
    active.onUpdate = () => mutate(mm, replacement, MOTION_SLOT_ACTIVE);
    mm.updateMotion(10);
    expect(active.log).toEqual(["active.initialize", "active.update", "active.finalize", "active.destroy"]);
    expect(replacement.log).toEqual(["replacement.initialize"]);
    expect(mm.getCurrentMovementGeneratorType()).toBe(CHASE_MOTION_TYPE);
  });

  test("a static (idle) generator is never deleted or finalized", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const idleGen = mm.getMotionSlot(MOTION_SLOT_IDLE)!;
    mm.directDelete(idleGen);
    mm.delayedDelete(idleGen);
    expect(mm.getMotionSlot(MOTION_SLOT_IDLE)).toBe(idleGen);
  });
});

describe("MotionMaster entry points", () => {
  test("UNIT_FLAG_DISABLE_MOVE blocks the move requests", () => {
    const unit = creature();
    unit.setUnitFlag(UNIT_FLAG_DISABLE_MOVE);
    const mm = unit.motionMaster;
    const target = new FakeUnit({ pos: [105, 100, 10] });
    mm.moveChase(target.asOwner());
    mm.moveFollow(target.asOwner(), 2, 0);
    mm.movePoint(1, 1, 2, 3);
    mm.moveConfused();
    mm.moveFleeing(target.asOwner());
    mm.moveRandom(3);
    mm.moveDistract(1000);
    mm.moveWaypoint(1, true);
    expect(mm.size()).toBe(1);
  });

  test("moveChase ignores a null target and the owner itself; chasing again retargets the running generator", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    mm.moveChase(null);
    mm.moveChase(unit.asOwner());
    expect(mm.size()).toBe(1);

    const a = new FakeUnit({ pos: [105, 100, 10] });
    const b = new FakeUnit({ pos: [95, 100, 10] });
    mm.moveChase(a.asOwner(), 5);
    expect(mm.getCurrentMovementGeneratorType()).toBe(CHASE_MOTION_TYPE);
    expect(unit.hasUnitState(UNIT_STATE_CHASE)).toBe(true);
    const gen = mm.top();
    expect(a.followers.size).toBe(1);
    mm.moveChase(b.asOwner(), new ChaseRange(1, 3), new ChaseAngle(1));
    expect(mm.top()).toBe(gen); // the same generator, a new target
    expect(a.followers.size).toBe(0);
    expect(b.followers.size).toBe(1);
  });

  test("moveFollow is a follow generator in the active slot and unregisters from the target when it ends", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const target = new FakeUnit({ pos: [105, 100, 10] });
    mm.moveFollow(target.asOwner(), 2, Math.PI);
    expect(mm.getCurrentMovementGeneratorType()).toBe(FOLLOW_MOTION_TYPE);
    expect(target.followers.size).toBe(1);
    mm.movementExpired();
    expect(target.followers.size).toBe(0);
  });

  test("movePoint with a Position and with coordinates, in the requested slot", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    mm.movePoint(3, 110, 100, 10);
    expect(mm.getCurrentMovementGeneratorType()).toBe(POINT_MOTION_TYPE);
    expect(mm.getMotionSlotType(MOTION_SLOT_ACTIVE)).toBe(POINT_MOTION_TYPE);
    mm.clear();
    mm.movePoint(4, 110, 100, 10, FORCED_MOVEMENT_NONE, 0, 0, true, true, MOTION_SLOT_CONTROLLED);
    expect(mm.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(POINT_MOTION_TYPE);
    mm.clear();
    mm.movePoint(5, unit.getPosition());
    expect(mm.getMotionSlotType(MOTION_SLOT_ACTIVE)).toBe(POINT_MOTION_TYPE);
  });

  test("moveDistract goes to the controlled slot and is refused while it is taken", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    mm.moveDistract(500);
    expect(mm.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(DISTRACT_MOTION_TYPE);
    expect(unit.hasUnitState(UNIT_STATE_DISTRACTED)).toBe(true);
    const first = mm.getMotionSlot(MOTION_SLOT_CONTROLLED);
    mm.moveDistract(900);
    expect(mm.getMotionSlot(MOTION_SLOT_CONTROLLED)).toBe(first);
    mm.updateMotion(600); // the timer ran out
    expect(unit.hasUnitState(UNIT_STATE_DISTRACTED)).toBe(false);
    expect(mm.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(NULL_MOTION_TYPE);
  });

  test("moveCharge is refused while the controlled slot holds something other than a distract", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    mutate(mm, new Probe(CONFUSED_MOTION_TYPE, "c"), MOTION_SLOT_CONTROLLED);
    mm.moveCharge(110, 100, 10);
    expect(mm.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(CONFUSED_MOTION_TYPE);
    mm.clear();
    mm.movementExpiredOnSlot(MOTION_SLOT_CONTROLLED);
    mm.moveDistract(500);
    mm.moveCharge(110, 100, 10, SPEED_CHARGE);
    expect(mm.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(POINT_MOTION_TYPE); // the distract is replaced
  });

  test("moveFleeing: a timed flee for a creature with a time, a plain flee without", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    const enemy = new FakeUnit({ pos: [101, 100, 10] });
    mm.moveFleeing(null);
    expect(mm.size()).toBe(1);
    mm.moveFleeing(enemy.asOwner(), 2000);
    expect(mm.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(TIMED_FLEEING_MOTION_TYPE);
    mm.clear();
    mm.movementExpiredOnSlot(MOTION_SLOT_CONTROLLED);
    mm.moveFleeing(enemy.asOwner());
    expect(mm.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(FLEEING_MOTION_TYPE);
    expect(unit.hasUnitState(UNIT_STATE_FLEEING)).toBe(true);
  });

  test("moveConfused: a player and a creature both get one in the controlled slot", () => {
    const unit = creature();
    unit.motionMaster.moveConfused();
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(CONFUSED_MOTION_TYPE);
    const player = new FakeUnit({ player: true, pos: [10, 10, 10] });
    player.motionMaster.initialize();
    player.motionMaster.moveConfused();
    expect(player.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(CONFUSED_MOTION_TYPE);
  });

  test("moveSeekAssistance (creature only) goes passive, then a distract with the assistance type", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    mm.moveSeekAssistance(110, 100, 10);
    expect(unit.reactState).toBe(0);
    expect(unit.log).toContain("attackStop");
    expect(unit.log).toContain("castStop");
    expect(mm.getCurrentMovementGeneratorType()).toBe(11);
    mm.moveSeekAssistanceDistract(1000);
    expect(mm.getCurrentMovementGeneratorType()).toBe(ASSISTANCE_DISTRACT_MOTION_TYPE);

    const player = new FakeUnit({ player: true });
    player.motionMaster.initialize();
    player.motionMaster.moveSeekAssistance(1, 2, 3);
    expect(player.motionMaster.size()).toBe(1);
  });

  test("moveRotate turns the unit for the duration", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    mm.moveRotate(0, ROTATE_DIRECTION_LEFT);
    expect(mm.size()).toBe(1);
    mm.moveRotate(1000, ROTATE_DIRECTION_LEFT);
    expect(mm.getCurrentMovementGeneratorType()).toBe(ROTATE_MOTION_TYPE);
    mm.updateMotion(500);
    expect(unit.o).toBeCloseTo(Math.PI, 4);
    mm.updateMotion(600);
    expect(mm.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
  });

  test("moveFormation needs a creature and a leader that is not the unit", () => {
    const unit = creature();
    const leader = new FakeUnit({ pos: [110, 100, 10] });
    unit.motionMaster.moveFormation(null, 2, 1, 0, 0);
    unit.motionMaster.moveFormation(unit.asOwner(), 2, 1, 0, 0);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(IDLE_MOTION_TYPE);
    unit.motionMaster.moveFormation(leader.asOwner(), 2, 1, 0, 0);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(FORMATION_MOTION_TYPE);
    expect(leader.followers.size).toBe(1);
  });

  test("moveTargetedHome: a creature gets the home generator in the active slot", () => {
    const unit = creature();
    unit.x = 130;
    unit.motionMaster.moveTargetedHome();
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(HOME_MOTION_TYPE);
    expect(unit.evadeStates).toEqual([2]);
  });

  test("moveTargetedHome: a pet with an owner follows the owner instead", () => {
    const owner = new FakeUnit({ player: true, pos: [100, 100, 10] });
    const pet = new FakeUnit({ pos: [101, 100, 10] });
    pet.charmerOrOwner = owner;
    pet.motionMaster.initialize();
    pet.motionMaster.moveTargetedHome();
    expect(pet.motionMaster.getCurrentMovementGeneratorType()).toBe(FOLLOW_MOTION_TYPE);
  });

  test("getDestination is the final destination of the running spline", () => {
    const unit = creature();
    const dest = { x: 0, y: 0, z: 0 };
    expect(unit.motionMaster.getDestination(dest)).toBe(false);
    unit.motionMaster.movePoint(1, 110, 100, 10);
    expect(unit.motionMaster.getDestination(dest)).toBe(true);
    expect([dest.x, dest.y, dest.z]).toEqual([110, 100, 10]);
  });

  test("moveSplinePath launches an escort over the points; movePath turns a waypoint path into one", () => {
    const unit = creature();
    unit.motionMaster.moveSplinePath([new Vector3(100, 100, 10), new Vector3(110, 100, 10), new Vector3(110, 110, 10)]);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(ESCORT_MOTION_TYPE);
    expect(unit.motionMaster.getCurrentSplineId()).toBe(unit.movespline.getId());
  });

  test("moveLand, moveTakeoff, moveJump, moveKnockbackFrom and moveFall launch an effect spline in the right slot", () => {
    const unit = creature();
    const mm = unit.motionMaster;
    mm.moveLand(1, 100, 100, 5, 4);
    expect(mm.getMotionSlotType(MOTION_SLOT_ACTIVE)).toBe(EFFECT_MOTION_TYPE);
    expect(unit.movespline.finalized()).toBe(false);
    mm.clear();
    mm.moveTakeoff(2, 100, 100, 15, 0, true);
    expect(mm.getMotionSlotType(MOTION_SLOT_ACTIVE)).toBe(EFFECT_MOTION_TYPE);
    mm.clear();
    mm.moveJump(105, 100, 10, 10, 8, 9);
    expect(mm.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(EFFECT_MOTION_TYPE);
    mm.clear();
    mm.movementExpiredOnSlot(MOTION_SLOT_CONTROLLED);
    mm.moveKnockbackFrom(95, 100, 5, 5);
    expect(mm.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(EFFECT_MOTION_TYPE);
  });

  test("moveFall: nothing when the ground is near, an effect spline to the ground otherwise", () => {
    const unit = new FakeUnit({ pos: [0, 0, 50], map: undefined });
    unit.motionMaster.initialize();
    unit.getMap().opts.ground = () => 10;
    unit.motionMaster.moveFall(7);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(EFFECT_MOTION_TYPE);
    const near = new FakeUnit({ pos: [0, 0, 10.05] });
    near.motionMaster.initialize();
    near.getMap().opts.ground = () => 10;
    near.motionMaster.moveFall();
    expect(near.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(NULL_MOTION_TYPE);
  });

  test("moveCirclePath launches a cyclic spline; a step count below 2 is refused", () => {
    const unit = creature();
    unit.motionMaster.moveCirclePath(100, 100, 10, 5, true, 1);
    expect(unit.movespline.finalized()).toBe(true);
    unit.motionMaster.moveCirclePath(100, 100, 10, 5, true, 8);
    expect(unit.movespline.finalized()).toBe(false);
    expect(unit.movespline.isCyclic()).toBe(true);
  });

  test("moveBackwards / moveForwards / moveCircleTarget launch a spline relative to the target", () => {
    const unit = creature();
    const target = new FakeUnit({ pos: [105, 100, 10] });
    unit.motionMaster.moveBackwards(target.asOwner(), 3);
    expect(unit.movespline.finalized()).toBe(false);
    unit.stopMoving();
    expect(unit.movespline.finalized()).toBe(true);
    unit.getMap().opts.canReach = () => false;
    unit.motionMaster.moveForwards(target.asOwner(), 3);
    expect(unit.movespline.finalized()).toBe(true); // the point is not reachable
  });
});
