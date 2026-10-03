import { beforeEach, describe, expect, test } from "bun:test";
import { seedRandom } from "../../../common/random.ts";
import { UNIT_FLAG_CONFUSED, UNIT_STATE_CONFUSED, UNIT_STATE_CONFUSED_MOVE, UNIT_STATE_ROOT } from "../../../spells/enums.ts";
import { CONFUSED_MOTION_TYPE, MOTION_SLOT_CONTROLLED, NULL_MOTION_TYPE } from "../MotionMaster.ts";
import { FakeMap, FakeUnit } from "../test-movement-owner.ts";
import { ConfusedMovementGenerator, MAX_CONF_WAYPOINTS } from "./ConfusedMovementGenerator.ts";

beforeEach(() => seedRandom(99));

function confused(opts: ConstructorParameters<typeof FakeUnit>[0] = {}) {
  const unit = new FakeUnit({ pos: [300, 300, 20], ...opts });
  unit.motionMaster.initialize();
  unit.motionMaster.moveConfused();
  return unit;
}

describe("ConfusedMovementGenerator", () => {
  test("sets the confused flag and states and starts to walk at once, within 2 yards of where it was", () => {
    const unit = confused();
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(CONFUSED_MOTION_TYPE);
    expect(unit.hasUnitFlag(UNIT_FLAG_CONFUSED)).toBe(true);
    expect(unit.hasUnitState(UNIT_STATE_CONFUSED)).toBe(true);
    expect(unit.hasUnitState(UNIT_STATE_CONFUSED_MOVE)).toBe(true);
    expect(unit.movespline.finalized()).toBe(false); // `DoUpdate(unit, 1)` at the end of the initialization
    expect(unit.movespline.velocity()).toBeCloseTo(2.5, 3);
    const dest = unit.movespline.finalDestination();
    expect(Math.abs(dest.x - 300)).toBeLessThanOrEqual(2.001);
    expect(Math.abs(dest.y - 300)).toBeLessThanOrEqual(2.001);
  });

  test("wanders from point to point with pauses of 0.6 to 1.2 seconds, never further than 2 yards from the start", () => {
    const unit = confused();
    let launches = 0;
    let id = unit.movespline.getId();
    let maxDist = 0;
    for (let t = 0; t < 60_000; t += 100) {
      unit.advance(100);
      maxDist = Math.max(maxDist, Math.hypot(unit.x - 300, unit.y - 300));
      if (unit.movespline.getId() !== id) {
        launches++;
        id = unit.movespline.getId();
      }
    }
    expect(launches).toBeGreaterThan(10);
    expect(maxDist).toBeLessThanOrEqual(2.9);
  });

  test("cliffs (more than 3 yards of height difference) keep the unit where it is", () => {
    const map = new FakeMap(0, { ground: (_x, _y, z) => z + 5 });
    const unit = confused({ map });
    for (let t = 0; t < 20_000; t += 100) unit.advance(100);
    expect(Math.hypot(unit.x - 300, unit.y - 300)).toBeLessThan(0.01);
  });

  test("a point out of line of sight is replaced by the previous point", () => {
    const map = new FakeMap(0, { los: () => false });
    const unit = confused({ map });
    for (let t = 0; t < 20_000; t += 100) unit.advance(100);
    expect(Math.hypot(unit.x - 300, unit.y - 300)).toBeLessThan(0.01);
  });

  test("a creature that cannot enter water does not walk into it; a player does", () => {
    const water = new FakeMap(0, { water: () => true });
    const creature = confused({ map: water });
    for (let t = 0; t < 20_000; t += 100) creature.advance(100);
    expect(Math.hypot(creature.x - 300, creature.y - 300)).toBeLessThan(0.01);

    const swimmer = confused({ map: new FakeMap(0, { water: () => true }), canEnterWater: true, canWalk: false });
    for (let t = 0; t < 20_000; t += 100) swimmer.advance(100);
    expect(Math.hypot(swimmer.x - 300, swimmer.y - 300)).toBeGreaterThan(0.1);

    const player = confused({ map: new FakeMap(0, { water: () => true }), player: true });
    for (let t = 0; t < 20_000; t += 100) player.advance(100);
    expect(Math.hypot(player.x - 300, player.y - 300)).toBeGreaterThan(0.1);
  });

  test("a rooted unit stands still", () => {
    const unit = confused();
    unit.run(300);
    unit.addUnitState(UNIT_STATE_ROOT);
    unit.advance(100);
    expect(unit.movespline.finalized()).toBe(true);
  });

  test("a creature gets its target back at the end; a player stops moving", () => {
    const unit = confused();
    const enemy = new FakeUnit({ pos: [301, 300, 20] });
    unit.victim = enemy;
    unit.motionMaster.movementExpiredOnSlot(MOTION_SLOT_CONTROLLED);
    expect(unit.hasUnitFlag(UNIT_FLAG_CONFUSED)).toBe(false);
    expect(unit.hasUnitState(UNIT_STATE_CONFUSED | UNIT_STATE_CONFUSED_MOVE)).toBe(false);
    expect(unit.targetGuid).toBe(enemy.guid);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(NULL_MOTION_TYPE);

    const player = confused({ player: true });
    expect(player.movespline.finalized()).toBe(false);
    player.motionMaster.movementExpiredOnSlot(MOTION_SLOT_CONTROLLED);
    expect(player.movespline.finalized()).toBe(true);
    expect(player.hasUnitFlag(UNIT_FLAG_CONFUSED)).toBe(false);
  });

  test("direct use", () => {
    expect(MAX_CONF_WAYPOINTS).toBe(24);
    expect(new ConfusedMovementGenerator().getMovementGeneratorType()).toBe(CONFUSED_MOTION_TYPE);
  });
});
