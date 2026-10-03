import { describe, expect, test } from "bun:test";
import { UNIT_STATE_EVADE, UNIT_STATE_FOLLOW } from "../../../spells/enums.ts";
import { HOME_MOTION_TYPE, IDLE_MOTION_TYPE, MOTION_SLOT_ACTIVE, MOTION_SLOT_IDLE, RANDOM_MOTION_TYPE } from "../MotionMaster.ts";
import { FakeUnit } from "../test-movement-owner.ts";
import { HomeMovementGenerator } from "./HomeMovementGenerator.ts";

function awayFromHome(extra: ConstructorParameters<typeof FakeUnit>[0] = {}) {
  const unit = new FakeUnit({ pos: [100, 100, 10], orientation: 0, ...extra });
  unit.homePosition.relocate(100, 100, 10, 1.5);
  unit.motionMaster.initialize();
  unit.x = 130;
  unit.y = 100;
  unit.addUnitState(UNIT_STATE_EVADE);
  return unit;
}

describe("HomeMovementGenerator", () => {
  test("runs to the home position, faces the home orientation, and informs the AI on arrival", () => {
    const unit = awayFromHome();
    unit.motionMaster.moveTargetedHome();
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(HOME_MOTION_TYPE);
    expect(unit.evadeStates).toEqual([2]); // EVADE_STATE_HOME
    expect(unit.movespline.finalized()).toBe(false);
    expect(unit.movespline.finalDestination().x).toBe(100);
    expect(unit.movespline.getId()).toBeGreaterThan(0);

    unit.run(5000);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
    expect(unit.x).toBeCloseTo(100, 3);
    expect(unit.o).toBeCloseTo(1.5, 3); // the final facing of the spline
    expect(unit.evadeStates).toEqual([2, 0]); // EVADE_STATE_NONE at the end
    expect(unit.hasUnitState(UNIT_STATE_EVADE)).toBe(false);
    expect(unit.log).toContain("loadCreaturesAddon");
    expect(unit.recordingAI!.calls).toContain("JustReachedHome()");
  });

  test("a home generator that is interrupted does not report arrival", () => {
    const unit = awayFromHome();
    unit.motionMaster.moveTargetedHome();
    unit.run(500);
    unit.motionMaster.clear();
    expect(unit.recordingAI!.calls).not.toContain("JustReachedHome()");
    expect(unit.evadeStates).toEqual([2, 0]);
  });

  test("walks home when asked to", () => {
    const unit = awayFromHome();
    unit.motionMaster.moveTargetedHome(true);
    const before = unit.movespline.velocity();
    expect(before).toBeCloseTo(2.5, 4); // the walk speed
    const runner = awayFromHome();
    runner.motionMaster.moveTargetedHome(false);
    expect(runner.movespline.velocity()).toBeCloseTo(7, 4);
  });

  test("the reset position of the idle generator replaces the home position (a random mover returns to its path)", () => {
    const unit = new FakeUnit({ pos: [100, 100, 10], defaultMovementType: RANDOM_MOTION_TYPE, wanderDistance: 5, spawnId: 9 });
    unit.motionMaster.initialize();
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(RANDOM_MOTION_TYPE);
    unit.homePosition.relocate(0, 0, 0, 0);
    unit.x = 120;
    unit.motionMaster.moveTargetedHome();
    // the random generator's initial position is (100, 100, 10), not the home position
    expect(unit.movespline.finalDestination().x).toBe(100);
    expect(unit.movespline.finalDestination().y).toBe(100);
  });

  test("a speed change relaunches the spline from where the unit is", () => {
    const unit = awayFromHome();
    unit.motionMaster.moveTargetedHome();
    unit.run(1000);
    const firstId = unit.movespline.getId();
    unit.speeds[1] = 14;
    unit.motionMaster.propagateSpeedChange();
    unit.advance(50);
    expect(unit.movespline.getId()).toBeGreaterThan(firstId);
    expect(unit.movespline.velocity()).toBeCloseTo(14, 4);
  });

  test("the generator clears the movement states except possessed, evade, ignore pathfinding and no environment update", () => {
    const unit = awayFromHome();
    unit.addUnitState(UNIT_STATE_FOLLOW);
    unit.motionMaster.moveTargetedHome();
    expect(unit.hasUnitState(UNIT_STATE_FOLLOW)).toBe(false);
    expect(unit.hasUnitState(UNIT_STATE_EVADE)).toBe(true);
  });

  test("the active slot is where it lives, and expiring it is what ends the evade", () => {
    const unit = awayFromHome();
    unit.motionMaster.moveTargetedHome();
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_ACTIVE)).toBe(HOME_MOTION_TYPE);
    const gen = new HomeMovementGenerator(false);
    expect(gen.getMovementGeneratorType()).toBe(HOME_MOTION_TYPE);
  });
});
