import { beforeEach, describe, expect, test } from "bun:test";
import { seedRandom } from "../../../common/random.ts";
import { buildNavMesh, wallWorldTiles } from "../../../common/Detour/test-navmesh.ts";
import { UNIT_FLAG_FLEEING, UNIT_STATE_FLEEING, UNIT_STATE_FLEEING_MOVE, UNIT_STATE_ROOT } from "../../../spells/enums.ts";
import { FLEEING_MOTION_TYPE, IDLE_MOTION_TYPE, MOTION_SLOT_CONTROLLED, NULL_MOTION_TYPE, TIMED_FLEEING_MOTION_TYPE } from "../MotionMaster.ts";
import { FakeMap, FakeUnit } from "../test-movement-owner.ts";
import { FleeingMovementGenerator, TimedFleeingMovementGenerator } from "./FleeingMovementGenerator.ts";

// The wall world: tile (0,0) is X, Y in [0, 40]; the wall is Y in [16, 20], X in [0, 32]. The area y > 20 is open.
const { t00, t10, t01 } = wallWorldTiles(4);
const { mesh, query } = buildNavMesh(10, [t00, t10, t01], 2048, 4);

function scene(opts: { player?: boolean; navmesh?: boolean; los?: boolean } = {}) {
  const map = new FakeMap(0, { navMesh: opts.navmesh === false ? null : mesh, query: opts.navmesh === false ? null : query, los: opts.los === false ? () => false : undefined });
  const unit = new FakeUnit({ pos: [15, 30, 0], player: opts.player, map });
  const enemy = new FakeUnit({ pos: [5, 30, 0], player: !opts.player, map });
  unit.units.set(enemy.guid, enemy);
  unit.motionMaster.initialize();
  enemy.motionMaster.initialize();
  return { unit, enemy, map };
}

beforeEach(() => seedRandom(4711));

describe("FleeingMovementGenerator", () => {
  test("sets the fleeing flag and state, then runs away from the enemy at the run speed", () => {
    const { unit, enemy } = scene();
    unit.motionMaster.moveFleeing(enemy.asOwner());
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(FLEEING_MOTION_TYPE);
    expect(unit.hasUnitFlag(UNIT_FLAG_FLEEING)).toBe(true);
    expect(unit.hasUnitState(UNIT_STATE_FLEEING)).toBe(true);
    expect(unit.hasUnitState(UNIT_STATE_FLEEING_MOVE)).toBe(true);
    expect(unit.movespline.finalized()).toBe(false);
    expect(unit.movespline.velocity()).toBeCloseTo(7, 3);
    const dest = unit.movespline.finalDestination();
    expect(Math.hypot(dest.x - 5, dest.y - 30)).toBeGreaterThan(10); // further from the enemy than the 10 yards it started at
    expect(dest.x).toBeGreaterThan(15); // away from the enemy at x = 5
    unit.run(4000);
    expect(unit.x).toBeGreaterThan(15);
  });

  test("keeps running: after the spline ends a new point is picked", () => {
    const { unit, enemy } = scene();
    unit.motionMaster.moveFleeing(enemy.asOwner());
    const firstId = unit.movespline.getId();
    unit.run(12_000);
    expect(unit.movespline.getId()).toBeGreaterThan(firstId);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(FLEEING_MOTION_TYPE);
  });

  test("a rooted or casting unit stops and starts again when free", () => {
    const { unit, enemy } = scene();
    unit.motionMaster.moveFleeing(enemy.asOwner());
    const id = unit.movespline.getId();
    unit.addUnitState(UNIT_STATE_ROOT);
    unit.advance(100);
    expect(unit.movespline.finalized()).toBe(true);
    unit.clearUnitState(UNIT_STATE_ROOT);
    // the timer of the interrupted move (travel time plus 0.8 to 1.5 s) only counts down while the unit is free
    unit.run(10_000);
    expect(unit.movespline.getId()).toBeGreaterThan(id);
  });

  test("a dead unit ends the generator", () => {
    const { unit, enemy } = scene();
    unit.motionMaster.moveFleeing(enemy.asOwner());
    unit.alive = false;
    unit.advance(100);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(NULL_MOTION_TYPE);
  });

  test("a creature gets its target back when it stops fleeing; flags and states are cleared", () => {
    const { unit, enemy } = scene();
    unit.victim = enemy;
    unit.motionMaster.moveFleeing(enemy.asOwner());
    unit.motionMaster.movementExpiredOnSlot(MOTION_SLOT_CONTROLLED);
    expect(unit.hasUnitFlag(UNIT_FLAG_FLEEING)).toBe(false);
    expect(unit.hasUnitState(UNIT_STATE_FLEEING | UNIT_STATE_FLEEING_MOVE)).toBe(false);
    expect(unit.targetGuid).toBe(enemy.guid);
  });

  test("a player flees on slopes it can walk and stops moving when it stops fleeing", () => {
    const { unit, enemy } = scene({ player: true });
    unit.motionMaster.moveFleeing(enemy.asOwner());
    expect(unit.movespline.finalized()).toBe(false);
    unit.motionMaster.movementExpiredOnSlot(MOTION_SLOT_CONTROLLED);
    expect(unit.movespline.finalized()).toBe(true);
    expect(unit.hasUnitFlag(UNIT_FLAG_FLEEING)).toBe(false);
  });

  test("without a nav mesh the path is not usable: no flee move, the timer tries again", () => {
    const { unit, enemy } = scene({ navmesh: false });
    unit.motionMaster.moveFleeing(enemy.asOwner());
    unit.run(2000);
    expect(unit.movespline.finalized()).toBe(true);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(FLEEING_MOTION_TYPE);
  });

  test("a flee point that is not in line of sight is dropped (the timer is 200 ms)", () => {
    const { unit, enemy } = scene({ los: false });
    unit.motionMaster.moveFleeing(enemy.asOwner());
    unit.run(1000);
    expect(unit.movespline.finalized()).toBe(true);
  });

  test("with no enemy to read (invalid guid) the creature runs in a random direction", () => {
    const { unit } = scene();
    unit.motionMaster.moveFleeing({ getGUID: () => 99999n, isPlayer: () => false } as never);
    expect(unit.hasUnitFlag(UNIT_FLAG_FLEEING)).toBe(true);
  });

  test("direct construction", () => {
    expect(new FleeingMovementGenerator(1n).getMovementGeneratorType()).toBe(FLEEING_MOTION_TYPE);
    expect(new TimedFleeingMovementGenerator(1n, 1000).getMovementGeneratorType()).toBe(TIMED_FLEEING_MOTION_TYPE);
  });
});

describe("TimedFleeingMovementGenerator", () => {
  test("flees for the given time, then the creature attacks its victim again and the AI is told", () => {
    const { unit, enemy } = scene();
    unit.victim = enemy;
    unit.motionMaster.moveFleeing(enemy.asOwner(), 3000);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(TIMED_FLEEING_MOTION_TYPE);
    unit.run(2000);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(TIMED_FLEEING_MOTION_TYPE);
    unit.run(1500);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(NULL_MOTION_TYPE);
    expect(unit.hasUnitFlag(UNIT_FLAG_FLEEING)).toBe(false);
    expect(unit.log).toContain("attackStop");
    expect(unit.recordingAI!.calls).toContain("AttackStart()");
    expect(unit.recordingAI!.calls).toContain(`MovementInform(${TIMED_FLEEING_MOTION_TYPE},0)`);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
  });

  test("a rooted creature does not use up the flee time", () => {
    const { unit, enemy } = scene();
    unit.motionMaster.moveFleeing(enemy.asOwner(), 1000);
    unit.addUnitState(UNIT_STATE_ROOT);
    unit.run(3000);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(TIMED_FLEEING_MOTION_TYPE);
    unit.clearUnitState(UNIT_STATE_ROOT);
    unit.run(1500);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(NULL_MOTION_TYPE);
  });

  test("a dead creature ends the generator", () => {
    const { unit, enemy } = scene();
    unit.motionMaster.moveFleeing(enemy.asOwner(), 5000);
    unit.alive = false;
    unit.advance(100);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(NULL_MOTION_TYPE);
  });
});
