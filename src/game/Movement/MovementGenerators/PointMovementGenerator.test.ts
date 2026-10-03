import { describe, expect, test } from "bun:test";
import { buildNavMesh, wallWorldTiles } from "../../../common/Detour/test-navmesh.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { UNIT_STATE_CHARGING, UNIT_STATE_ROAMING, UNIT_STATE_ROAMING_MOVE, UNIT_STATE_ROOT } from "../../../spells/enums.ts";
import { MOVEMENTFLAG_FALLING } from "../../Entities/Unit/UnitDefines.ts";
import {
  ASSISTANCE_DISTRACT_MOTION_TYPE,
  ASSISTANCE_MOTION_TYPE,
  EFFECT_MOTION_TYPE,
  FORCED_MOVEMENT_RUN,
  FORCED_MOVEMENT_WALK,
  IDLE_MOTION_TYPE,
  MOTION_SLOT_ACTIVE,
  MOTION_SLOT_CONTROLLED,
  NULL_MOTION_TYPE,
  POINT_MOTION_TYPE,
  SPEED_CHARGE,
} from "../MotionMaster.ts";
import { EVENT_CHARGE, EVENT_CHARGE_PREPATH } from "../MovementOwner.ts";
import { FakeMap, FakeUnit } from "../test-movement-owner.ts";
import { AnimTier } from "../../Entities/Unit/UnitDefines.ts";
import { AssistanceMovementGenerator, EffectMovementGenerator, PointMovementGenerator } from "./PointMovementGenerator.ts";

function mover(opts: ConstructorParameters<typeof FakeUnit>[0] = {}) {
  const unit = new FakeUnit({ pos: [100, 100, 10], ...opts });
  unit.motionMaster.initialize();
  return unit;
}

describe("PointMovementGenerator", () => {
  test("moves to the point and informs the AI with the point id when it arrives", () => {
    const unit = mover();
    unit.motionMaster.movePoint(7, 120, 100, 10);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(POINT_MOTION_TYPE);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING)).toBe(true);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING_MOVE)).toBe(true);
    unit.run(1000);
    expect(unit.recordingAI!.calls).toEqual([]); // 20 yards at 7 yards/s: not there yet
    unit.run(2500);
    expect(unit.x).toBeCloseTo(120, 3);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
    expect(unit.recordingAI!.calls).toEqual(["MovementInform(8,7)"]); // POINT_MOTION_TYPE, id
    expect(unit.hasUnitState(UNIT_STATE_ROAMING)).toBe(false);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING_MOVE)).toBe(false);
  });

  test("a summoner's AI hears about the arrival too (owner first, else the summoner)", () => {
    const owner = mover({ player: true });
    const owned = mover();
    owned.charmerOrOwner = owner;
    // the owner is a player: no AI. Use a creature owner with an AI
    const creatureOwner = mover();
    const pet = mover({ pos: [100, 100, 10] });
    pet.charmerOrOwner = creatureOwner;
    pet.motionMaster.movePoint(3, 101, 100, 10);
    pet.run(1000);
    expect(creatureOwner.recordingAI!.calls).toEqual(["SummonMovementInform(8,3)"]);
    const summon = mover();
    summon.summoner = creatureOwner;
    creatureOwner.recordingAI!.calls.length = 0;
    summon.motionMaster.movePoint(4, 101, 100, 10);
    summon.run(1000);
    expect(creatureOwner.recordingAI!.calls).toEqual(["SummonMovementInform(8,4)"]);
  });

  test("speed, forced walk or run, final orientation and animation tier go into the spline", () => {
    const unit = mover();
    unit.motionMaster.movePoint(1, 130, 100, 10, FORCED_MOVEMENT_WALK, 0, 2.0, false, true, MOTION_SLOT_ACTIVE, AnimTier.Hover);
    expect(unit.movespline.velocity()).toBeCloseTo(2.5, 4);
    expect(unit.movespline.hasAnimation()).toBe(true);
    unit.run(15_000);
    expect(unit.o).toBeCloseTo(2.0, 3);

    const runner = mover();
    runner.walking = true;
    runner.addUnitMovementFlag(0x100); // walking
    runner.motionMaster.movePoint(1, 130, 100, 10, FORCED_MOVEMENT_RUN);
    expect(runner.movespline.velocity()).toBeCloseTo(7, 4);

    const fixed = mover();
    fixed.motionMaster.movePoint(1, 130, 100, 10, 0, 11.5);
    expect(fixed.movespline.velocity()).toBeCloseTo(11.5, 4);
  });

  test("a move straight up or down (same x, y) is nudged 0.2 yards along the orientation", () => {
    const unit = mover({ orientation: 0 });
    unit.motionMaster.movePoint(1, 100, 100, 20);
    const dest = unit.movespline.finalDestination();
    expect(dest.x).toBeCloseTo(100.2, 4);
    expect(dest.y).toBeCloseTo(100, 4);
    expect(dest.z).toBe(20);
  });

  test("the point is made from the Position overload with its orientation", () => {
    const unit = mover();
    unit.motionMaster.movePoint(1, unit.getPosition());
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(POINT_MOTION_TYPE);
  });

  test("a unit that cannot move yet starts when it can (UNIT_STATE_NOT_MOVE at initialization)", () => {
    const unit = mover();
    unit.addUnitState(UNIT_STATE_ROOT);
    unit.motionMaster.movePoint(1, 120, 100, 10);
    expect(unit.movespline.finalized()).toBe(true);
    unit.advance(100);
    expect(unit.movespline.finalized()).toBe(true); // still rooted: `StopMoving`
    unit.clearUnitState(UNIT_STATE_ROOT);
    unit.advance(100);
    expect(unit.movespline.finalized()).toBe(false);
    unit.run(4000);
    expect(unit.recordingAI!.calls).toEqual(["MovementInform(8,1)"]);
  });

  test("casting stops a point mover without ending the generator", () => {
    const unit = mover();
    unit.motionMaster.movePoint(1, 140, 100, 10);
    unit.run(500);
    unit.movementPreventedByCasting = true;
    unit.advance(100);
    expect(unit.movespline.finalized()).toBe(true);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(POINT_MOTION_TYPE);
  });

  test("pause with a timer stops relaunching until it ends, then moves on from where the unit stopped", () => {
    const unit = mover();
    unit.motionMaster.movePoint(1, 140, 100, 10);
    unit.run(1000);
    const gen = unit.motionMaster.top()!;
    unit.stopMoving();
    gen.pause(500);
    unit.advance(300);
    expect(unit.movespline.finalized()).toBe(true);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(POINT_MOTION_TYPE); // finalized but stalled: kept
    unit.advance(300); // the timer ran out: a new spline from the current position
    expect(unit.movespline.finalized()).toBe(false);
    unit.run(6000);
    expect(unit.x).toBeCloseTo(140, 2);
    expect(unit.recordingAI!.calls).toEqual(["MovementInform(8,1)"]);
  });

  test("pause without a timer holds until resume", () => {
    const unit = mover();
    unit.motionMaster.movePoint(1, 140, 100, 10);
    unit.run(500);
    const gen = unit.motionMaster.top()!;
    unit.stopMoving();
    gen.pause();
    unit.run(2000);
    expect(unit.movespline.finalized()).toBe(true);
    gen.resume();
    unit.advance(100);
    expect(unit.movespline.finalized()).toBe(false);
    unit.run(6000);
    expect(unit.recordingAI!.calls).toEqual(["MovementInform(8,1)"]);
  });

  test("a stopped generator that is finalized by a pause does not report an arrival", () => {
    const unit = mover();
    unit.motionMaster.movePoint(1, 140, 100, 10);
    unit.run(500);
    unit.motionMaster.top()!.pause();
    unit.stopMoving();
    unit.motionMaster.clear();
    expect(unit.recordingAI!.calls).toEqual([]);
  });

  test("a speed change relaunches the remaining path (the generated path with several points keeps its corners)", () => {
    const { t00, t10, t01 } = wallWorldTiles(4);
    const { mesh, query } = buildNavMesh(10, [t00, t10, t01], 2048, 4);
    const map = new FakeMap(0, { navMesh: mesh, query });
    const unit = mover({ pos: [10, 10, 0], map });
    unit.motionMaster.movePoint(2, 10, 30, 0);
    const first = unit.movespline;
    expect(first.finalized()).toBe(false);
    const idBefore = first.getId();
    unit.run(2000);
    expect(unit.x).toBeGreaterThan(10);
    unit.speeds[1] = 14;
    unit.motionMaster.propagateSpeedChange();
    unit.advance(10);
    expect(unit.movespline.getId()).toBeGreaterThan(idBefore);
    expect(unit.movespline.velocity()).toBeCloseTo(14, 4);
    unit.run(10_000);
    expect(unit.x).toBeCloseTo(10, 2);
    expect(unit.y).toBeCloseTo(30, 2);
    expect(unit.recordingAI!.calls).toEqual(["MovementInform(8,2)"]);
  });

  test("a charge sets the charging state, and attacks the charge target at the end when it is the unit's target", () => {
    const unit = mover();
    const target = mover({ pos: [110, 100, 10] });
    unit.units.set(target.guid, target);
    unit.targetGuid = target.guid;
    unit.motionMaster.moveCharge(110, 100, 10, SPEED_CHARGE, EVENT_CHARGE, null, false, 0.0, target.guid);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(POINT_MOTION_TYPE);
    expect(unit.hasUnitState(UNIT_STATE_CHARGING)).toBe(true);
    unit.run(1000);
    expect(unit.hasUnitState(UNIT_STATE_CHARGING)).toBe(false);
    expect(unit.log).toContain("attack");
    expect(unit.recordingAI!.calls).toEqual([`MovementInform(8,${EVENT_CHARGE})`]);
  });

  test("a charge with a pre-computed path (EVENT_CHARGE_PREPATH) does not launch a spline itself", () => {
    const unit = mover();
    unit.motionMaster.moveCharge(110, 100, 10, SPEED_CHARGE, EVENT_CHARGE_PREPATH);
    expect(unit.hasUnitState(UNIT_STATE_CHARGING)).toBe(true);
    unit.advance(10);
    expect(unit.movespline.finalized()).toBe(false); // the charge spline of `MoveCharge(path)` is launched by the caller
  });

  test("moveCharge(PathGenerator) launches the path spline and waits for it", () => {
    const unit = mover();
    const path = { getActualEndPosition: () => new Vector3(110, 100, 10), getPath: () => [new Vector3(100, 100, 10), new Vector3(105, 100, 10), new Vector3(110, 100, 10)] };
    unit.motionMaster.moveCharge(path as never, 20);
    expect(unit.movespline.velocity()).toBeCloseTo(20, 3);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(POINT_MOTION_TYPE);
  });

  test("reset adds the roaming states again", () => {
    const unit = mover();
    unit.motionMaster.movePoint(1, 140, 100, 10);
    unit.clearUnitState(UNIT_STATE_ROAMING | UNIT_STATE_ROAMING_MOVE);
    unit.motionMaster.reinitializeMovement();
    expect(unit.hasUnitState(UNIT_STATE_ROAMING)).toBe(true);
  });

  test("movePointBackwards walks away facing the point (orientation inversed)", () => {
    const unit = mover();
    unit.motionMaster.movePointBackwards(5, 90, 100, 10);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(POINT_MOTION_TYPE);
    expect(unit.movespline.finalized()).toBe(false);
    expect(unit.movespline.splineflags.orientationInversed).toBe(true);
  });

  test("direct construction", () => {
    const gen = new PointMovementGenerator(1, 1, 2, 3, FORCED_MOVEMENT_WALK);
    const dest = { x: 0, y: 0, z: 0 };
    expect(gen.getDestination(dest)).toBe(true);
    expect([dest.x, dest.y, dest.z]).toEqual([1, 2, 3]);
  });
});

describe("AssistanceMovementGenerator", () => {
  test("after arriving the creature calls for help and stands distracted for the family assistance delay", () => {
    const unit = mover();
    unit.motionMaster.moveSeekAssistance(110, 100, 10);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(ASSISTANCE_MOTION_TYPE);
    unit.run(2500);
    expect(unit.log).toContain("setNoCallAssistance(false)");
    expect(unit.log).toContain("callAssistance");
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(ASSISTANCE_DISTRACT_MOTION_TYPE);
    unit.run(3000); // CONFIG_CREATURE_FAMILY_ASSISTANCE_DELAY, 1500 ms by default
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_ACTIVE)).toBe(NULL_MOTION_TYPE);
    expect(unit.reactState).toBe(2);
  });

  test("the generator has the assistance type and is a point generator", () => {
    const gen = new AssistanceMovementGenerator(1, 2, 3);
    expect(gen.getMovementGeneratorType()).toBe(ASSISTANCE_MOTION_TYPE);
  });
});

describe("EffectMovementGenerator", () => {
  test("a jump runs to its end, then informs the AI with the effect id", () => {
    const unit = mover();
    unit.motionMaster.moveJump(105, 100, 10, 10, 8, 42);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(EFFECT_MOTION_TYPE);
    unit.run(3000);
    expect(unit.x).toBeCloseTo(105, 3);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(NULL_MOTION_TYPE);
    expect(unit.recordingAI!.calls).toEqual([`MovementInform(16,42)`]);
  });

  test("a fall removes the falling flag of a creature at the end", () => {
    const unit = mover({ pos: [100, 100, 40] });
    unit.getMap().opts.ground = () => 10;
    unit.motionMaster.moveFall(3, true);
    expect(unit.hasUnitMovementFlag(MOVEMENTFLAG_FALLING)).toBe(true);
    unit.run(5000);
    expect(unit.hasUnitMovementFlag(MOVEMENTFLAG_FALLING)).toBe(false);
    expect(unit.z).toBeCloseTo(10, 1);
    expect(unit.recordingAI!.calls).toEqual(["MovementInform(16,3)"]);
  });

  test("a player's fall sets the fall state and the fall information", () => {
    const unit = mover({ player: true, pos: [100, 100, 40] });
    unit.getMap().opts.ground = () => 10;
    unit.motionMaster.moveFall();
    expect(unit.hasUnitMovementFlag(MOVEMENTFLAG_FALLING)).toBe(true);
    expect(unit.fallInformation?.[1]).toBe(40);
  });

  test("a knockback in the middle of a flee is only launched, not mutated into the controlled slot", () => {
    const unit = mover();
    const enemy = mover({ pos: [101, 100, 10] });
    unit.motionMaster.moveFleeing(enemy.asOwner());
    const type = unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED);
    unit.motionMaster.moveKnockbackFrom(95, 100, 5, 5);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(type);
  });

  test("the generator ends when its spline does and reset does nothing", () => {
    const unit = mover();
    const gen = new EffectMovementGenerator({ launch: () => 0 } as never, 1);
    expect(gen.update(unit.asOwner(), 1)).toBe(false); // the unit's spline is finalized
    expect(gen.getMovementGeneratorType()).toBe(EFFECT_MOTION_TYPE);
    gen.reset(unit.asOwner());
  });
});
