import { describe, expect, test } from "bun:test";
import { UNIT_STATE_DISTRACTED, UNIT_STATE_ROTATING } from "../../../spells/enums.ts";
import { ASSISTANCE_DISTRACT_MOTION_TYPE, DISTRACT_MOTION_TYPE, IDLE_MOTION_TYPE, MOTION_SLOT_ACTIVE, NULL_MOTION_TYPE, ROTATE_DIRECTION_LEFT, ROTATE_DIRECTION_RIGHT, ROTATE_MOTION_TYPE } from "../MotionMaster.ts";
import { FakeUnit } from "../test-movement-owner.ts";
import { AssistanceDistractMovementGenerator, DistractMovementGenerator, IdleMovementFactory, IdleMovementGenerator, RotateMovementGenerator } from "./IdleMovementGenerator.ts";

describe("IdleMovementGenerator", () => {
  test("one shared instance from the factory; update never ends", () => {
    const factory = new IdleMovementFactory();
    expect(factory.create()).toBe(IdleMovementGenerator.instance);
    expect(IdleMovementGenerator.instance.getMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
    const unit = new FakeUnit();
    expect(IdleMovementGenerator.instance.update(unit.asOwner(), 1000)).toBe(true);
  });

  test("initialize and reset stop a unit that is moving, and only then", () => {
    const unit = new FakeUnit({ pos: [0, 0, 0] });
    unit.motionMaster.initialize();
    unit.motionMaster.movePoint(1, 20, 0, 0);
    expect(unit.movespline.finalized()).toBe(false);
    expect(unit.isStopped()).toBe(false); // the point generator set UNIT_STATE_ROAMING_MOVE
    const sent = unit.sent.length;
    IdleMovementGenerator.instance.reset(unit.asOwner()); // `StopMoving`
    expect(unit.movespline.finalized()).toBe(true);
    expect(unit.sent.length).toBe(sent + 1); // the stop packet
    const sentAfterStop = unit.sent.length;
    IdleMovementGenerator.instance.reset(unit.asOwner());
    expect(unit.sent.length).toBe(sentAfterStop); // already stopped: no packet
  });
});

describe("RotateMovementGenerator", () => {
  test("turns left by a share of the full circle per tick and ends after the duration", () => {
    const unit = new FakeUnit({ orientation: 0 });
    unit.motionMaster.initialize();
    const gen = new RotateMovementGenerator(1000, ROTATE_DIRECTION_LEFT);
    expect(gen.getMovementGeneratorType()).toBe(ROTATE_MOTION_TYPE);
    gen.initialize(unit.asOwner());
    expect(unit.hasUnitState(UNIT_STATE_ROTATING)).toBe(true);
    expect(gen.update(unit.asOwner(), 250)).toBe(true);
    expect(unit.o).toBeCloseTo(Math.PI / 2, 5);
    expect(gen.update(unit.asOwner(), 250)).toBe(true);
    expect(unit.o).toBeCloseTo(Math.PI, 5);
    expect(gen.update(unit.asOwner(), 499)).toBe(true);
    expect(unit.o).toBeCloseTo((2 * Math.PI * 999) / 1000, 4);
    expect(gen.update(unit.asOwner(), 1)).toBe(false); // `m_duration > diff` no longer holds: the duration is used up
    expect(unit.o).toBeCloseTo(0, 3); // wrapped past 2pi
  });

  test("turns right and wraps below 0", () => {
    const unit = new FakeUnit({ orientation: 0.1 });
    const gen = new RotateMovementGenerator(1000, ROTATE_DIRECTION_RIGHT);
    gen.update(unit.asOwner(), 250);
    expect(unit.o).toBeCloseTo(0.1 - Math.PI / 2 + 2 * Math.PI, 4);
  });

  test("initialize faces the victim and drops the attack; finalize informs the AI", () => {
    const unit = new FakeUnit({ pos: [0, 0, 0] });
    const victim = new FakeUnit({ pos: [0, 10, 0] });
    unit.victim = victim;
    const gen = new RotateMovementGenerator(1000, ROTATE_DIRECTION_LEFT);
    gen.initialize(unit.asOwner());
    expect(unit.log).toContain("setInFront");
    expect(unit.log).toContain("attackStop");
    gen.finalize(unit.asOwner());
    expect(unit.hasUnitState(UNIT_STATE_ROTATING)).toBe(false);
    expect(unit.recordingAI!.calls).toContain(`MovementInform(${ROTATE_MOTION_TYPE},0)`);
  });

  test("reset restarts it", () => {
    const unit = new FakeUnit();
    const gen = new RotateMovementGenerator(1000, ROTATE_DIRECTION_LEFT);
    gen.reset(unit.asOwner());
    expect(unit.hasUnitState(UNIT_STATE_ROTATING)).toBe(true);
  });
});

describe("DistractMovementGenerator", () => {
  test("stands the unit up, sets the state, and ends after the timer or on combat", () => {
    const unit = new FakeUnit();
    unit.standState = 1;
    const gen = new DistractMovementGenerator(1000);
    expect(gen.getMovementGeneratorType()).toBe(DISTRACT_MOTION_TYPE);
    gen.initialize(unit.asOwner());
    expect(unit.standState).toBe(0);
    expect(unit.hasUnitState(UNIT_STATE_DISTRACTED)).toBe(true);
    expect(gen.update(unit.asOwner(), 400)).toBe(true);
    expect(gen.update(unit.asOwner(), 600)).toBe(true); // 1000 == timer: `time_diff > m_timer` is false
    expect(gen.update(unit.asOwner(), 1)).toBe(false);
    const fighting = new FakeUnit();
    fighting.inCombat = true;
    expect(new DistractMovementGenerator(1000).update(fighting.asOwner(), 1)).toBe(false);
  });

  test("finalize returns a creature to its home orientation", () => {
    const unit = new FakeUnit({ orientation: 1 });
    unit.homePosition.setOrientation(2.5);
    const gen = new DistractMovementGenerator(10);
    gen.initialize(unit.asOwner());
    gen.finalize(unit.asOwner());
    expect(unit.hasUnitState(UNIT_STATE_DISTRACTED)).toBe(false);
    expect(unit.o).toBeCloseTo(2.5, 5);
  });

  test("the assistance distract makes the creature aggressive again at the end", () => {
    const unit = new FakeUnit();
    unit.reactState = 0;
    const gen = new AssistanceDistractMovementGenerator(500);
    expect(gen.getMovementGeneratorType()).toBe(ASSISTANCE_DISTRACT_MOTION_TYPE);
    gen.initialize(unit.asOwner());
    gen.finalize(unit.asOwner());
    expect(unit.reactState).toBe(2);
    expect(unit.hasUnitState(UNIT_STATE_DISTRACTED)).toBe(false);
  });

  test("through the motion master: a rotate is a generator in the active slot that expires", () => {
    const unit = new FakeUnit();
    unit.motionMaster.initialize();
    unit.motionMaster.moveRotate(500, ROTATE_DIRECTION_LEFT);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_ACTIVE)).toBe(ROTATE_MOTION_TYPE);
    unit.run(600, 100);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_ACTIVE)).toBe(NULL_MOTION_TYPE);
  });
});
