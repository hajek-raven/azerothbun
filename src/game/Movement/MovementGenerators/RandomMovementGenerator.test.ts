import { beforeEach, describe, expect, test } from "bun:test";
import { seedRandom } from "../../../common/random.ts";
import { INVALID_HEIGHT } from "../../Grids/GridTerrainData.ts";
import { UNIT_FLAG_DISABLE_MOVE, UNIT_STATE_ROAMING, UNIT_STATE_ROAMING_MOVE, UNIT_STATE_ROOT } from "../../../spells/enums.ts";
import { MAP_OBJECT_CELL_MOVE_ACTIVE } from "../../Entities/Object/Object.ts";
import { MOTION_SLOT_IDLE, RANDOM_MOTION_TYPE } from "../MotionMaster.ts";
import { CreatureRandomMovementType } from "../MovementOwner.ts";
import { FakeMap, FakeUnit } from "../test-movement-owner.ts";
import { MAX_PATH_LENGHT_FACTOR, MIN_WANDER_DISTANCE_AIR, MIN_WANDER_DISTANCE_GROUND, RANDOM_LINKS_COUNT, RANDOM_POINTS_NUMBER, RandomMovementGenerator } from "./RandomMovementGenerator.ts";

function wanderer(opts: ConstructorParameters<typeof FakeUnit>[0] = {}) {
  const unit = new FakeUnit({ pos: [200, 200, 20], spawnId: 5, wanderDistance: 8, defaultMovementType: RANDOM_MOTION_TYPE, ...opts });
  unit.motionMaster.initialize();
  return unit;
}

function randomGen(unit: FakeUnit): RandomMovementGenerator {
  return unit.motionMaster.getMotionSlot(MOTION_SLOT_IDLE) as RandomMovementGenerator;
}

beforeEach(() => seedRandom(12345));

describe("RandomMovementGenerator constants", () => {
  test("the C++ values", () => {
    expect([RANDOM_POINTS_NUMBER, RANDOM_LINKS_COUNT, MIN_WANDER_DISTANCE_GROUND, MIN_WANDER_DISTANCE_AIR]).toEqual([12, 7, 1, 10]);
    expect(MAX_PATH_LENGHT_FACTOR).toBe(Math.fround(1.85));
  });
});

describe("RandomMovementGenerator initialization", () => {
  test("is the idle slot generator of a creature with the random movement type; ROAMING states", () => {
    const unit = wanderer();
    expect(randomGen(unit).getMovementGeneratorType()).toBe(RANDOM_MOTION_TYPE);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING)).toBe(true);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING_MOVE)).toBe(true);
  });

  test("the reset position is the spawn position until the creature has picked a point", () => {
    const unit = wanderer();
    const pos = { x: 0, y: 0, z: 0 };
    expect(randomGen(unit).getResetPosition(pos)).toBe(true);
    expect([pos.x, pos.y, pos.z]).toEqual([200, 200, 20]);
  });

  test("a creature that is not alive does not initialize", () => {
    const unit = new FakeUnit({ pos: [200, 200, 20], spawnId: 5, wanderDistance: 8 });
    unit.alive = false;
    const gen = new RandomMovementGenerator(0);
    gen.initialize(unit.asOwner());
    expect(unit.hasUnitState(UNIT_STATE_ROAMING)).toBe(false);
    expect(gen.getResetPosition({ x: 0, y: 0, z: 0 })).toBe(false);
  });

  test("the wander distance is at least 1 yard on the ground and 10 yards in the air for a spawn at its own distance", () => {
    const ground = new FakeUnit({ pos: [200, 200, 20], spawnId: 5, wanderDistance: 0.2 });
    const g = new RandomMovementGenerator(0);
    g.initialize(ground.asOwner());
    // the first point is 0.5..1 of the distance away at angle 0
    ground.motionMaster.initialize();
    const air = new FakeUnit({ pos: [200, 200, 20], spawnId: 5, wanderDistance: 3, canFly: true });
    const a = new RandomMovementGenerator(0);
    a.initialize(air.asOwner());
    // read the destination points through the private field
    const gp = (g as unknown as { _destinationPoints: { x: number; y: number }[] })._destinationPoints;
    const ap = (a as unknown as { _destinationPoints: { x: number; y: number }[] })._destinationPoints;
    expect(gp.length).toBe(12);
    for (const p of gp) expect(Math.hypot(p.x - 200, p.y - 200)).toBeLessThanOrEqual(1.0001);
    expect(Math.max(...ap.map((p) => Math.hypot(p.x - 200, p.y - 200)))).toBeGreaterThan(5); // 10 yards, factor 0.5..1
    for (const p of ap) {
      const d = Math.hypot(p.x - 200, p.y - 200);
      expect(d).toBeGreaterThanOrEqual(4.99);
      expect(d).toBeLessThanOrEqual(10.001);
    }
  });

  test("the twelve points are 30 degrees apart on a circle around the spawn point, 0.5..1 of the wander distance out", () => {
    const unit = wanderer({ wanderDistance: 20 });
    const points = (randomGen(unit) as unknown as { _destinationPoints: { x: number; y: number; z: number }[] })._destinationPoints;
    expect(points.length).toBe(12);
    points.forEach((p, i) => {
      const d = Math.hypot(p.x - 200, p.y - 200);
      expect(d).toBeGreaterThanOrEqual(10 - 1e-3);
      expect(d).toBeLessThanOrEqual(20 + 1e-3);
      const angle = Math.atan2(p.y - 200, p.x - 200);
      expect((angle + 2 * Math.PI) % (2 * Math.PI)).toBeCloseTo((i * Math.PI) / 6, 3);
      expect(p.z).toBe(20);
    });
  });
});

describe("RandomMovementGenerator updates", () => {
  test("the first move starts after the random timer (at most 5000 ms for a spawned creature), within the wander distance", () => {
    const unit = wanderer();
    let moved = -1;
    for (let t = 0; t < 6000 && moved < 0; t += 100) {
      unit.advance(100);
      if (!unit.movespline.finalized()) moved = t;
    }
    expect(moved).toBeGreaterThanOrEqual(0);
    expect(moved).toBeLessThanOrEqual(5100);
    const dest = unit.movespline.finalDestination();
    expect(Math.hypot(dest.x - 200, dest.y - 200)).toBeLessThanOrEqual(8.01);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING_MOVE)).toBe(true);
    expect(unit.getFormation()).toBeNull();
  });

  test("a creature with no spawn id (a summon) moves at once", () => {
    const unit = wanderer({ spawnId: 0 });
    unit.advance(10);
    expect(unit.movespline.finalized()).toBe(false);
  });

  test("walks by default; AlwaysRun runs; CanRun follows the unit's own walk state", () => {
    const walker = wanderer({ spawnId: 0 });
    walker.advance(10);
    expect(walker.movespline.velocity()).toBeCloseTo(2.5, 4);

    const runner = wanderer({ spawnId: 0 });
    runner.movementTemplate = { getRandom: () => CreatureRandomMovementType.AlwaysRun, getChase: () => 0 };
    runner.advance(10);
    expect(runner.movespline.velocity()).toBeCloseTo(7, 4);

    const mixed = wanderer({ spawnId: 0 });
    mixed.movementTemplate = { getRandom: () => CreatureRandomMovementType.CanRun, getChase: () => 0 };
    mixed.walking = false;
    mixed.advance(10);
    expect(mixed.movespline.velocity()).toBeCloseTo(7, 4);
  });

  test("keeps wandering: after many moves it never leaves the wander circle and moves along linked points", () => {
    const unit = wanderer({ wanderDistance: 6 });
    let maxDist = 0;
    let launches = 0;
    let lastId = unit.movespline.getId();
    for (let t = 0; t < 120_000; t += 100) {
      unit.advance(100);
      maxDist = Math.max(maxDist, Math.hypot(unit.x - 200, unit.y - 200));
      if (unit.movespline.getId() !== lastId) {
        launches++;
        lastId = unit.movespline.getId();
      }
    }
    expect(launches).toBeGreaterThan(5);
    expect(maxDist).toBeLessThanOrEqual(6.05);
  });

  test("rooted, stunned or casting: the timer expires, the unit stops, and the generator stays", () => {
    const unit = wanderer({ spawnId: 0 });
    unit.advance(10);
    expect(unit.movespline.finalized()).toBe(false);
    unit.addUnitState(UNIT_STATE_ROOT);
    unit.advance(10);
    expect(unit.movespline.finalized()).toBe(true);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(RANDOM_MOTION_TYPE);
    unit.clearUnitState(UNIT_STATE_ROOT);

    const caster = wanderer({ spawnId: 0 });
    caster.movementPreventedByCasting = true;
    caster.advance(10);
    expect(caster.movespline.finalized()).toBe(true);
  });

  test("UNIT_FLAG_DISABLE_MOVE: no movement, the roaming move state is cleared, the generator stays", () => {
    const unit = wanderer({ spawnId: 0 });
    unit.setUnitFlag(UNIT_FLAG_DISABLE_MOVE);
    unit.advance(10);
    expect(unit.movespline.finalized()).toBe(true);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING_MOVE)).toBe(false);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING)).toBe(true);
  });

  test("a creature in the map's move list does not pick a point", () => {
    const unit = wanderer({ spawnId: 0 });
    unit._moveState = MAP_OBJECT_CELL_MOVE_ACTIVE;
    unit.advance(10);
    expect(unit.movespline.finalized()).toBe(true);
  });

  test("a cliff (every point is 5 yards up) removes every link, and the creature stays at its spawn point", () => {
    const map = new FakeMap(0, { ground: (x, y, z) => z + (Math.hypot(x - 200, y - 200) > 0.5 ? 5 : 0) });
    const unit = wanderer({ map, spawnId: 0 });
    for (let t = 0; t < 60_000; t += 100) unit.advance(100);
    expect(Math.hypot(unit.x - 200, unit.y - 200)).toBeLessThan(0.5);
    expect(randomGen(unit).getResetPosition({ x: 0, y: 0, z: 0 })).toBe(true);
  });

  test("points with no ground are dropped for a walker; a creature that cannot walk never moves on the ground", () => {
    const map = new FakeMap(0, { ground: () => INVALID_HEIGHT });
    const unit = wanderer({ map, spawnId: 0 });
    for (let t = 0; t < 30_000; t += 100) unit.advance(100);
    expect(unit.movespline.finalized()).toBe(true);
    const nonWalker = wanderer({ canWalk: false, spawnId: 0 });
    for (let t = 0; t < 30_000; t += 100) nonWalker.advance(100);
    expect(Math.hypot(nonWalker.x - 200, nonWalker.y - 200)).toBeLessThan(0.5);
  });

  test("a point that is not in line of sight is dropped", () => {
    const map = new FakeMap(0, { los: () => false });
    const unit = wanderer({ map, spawnId: 0 });
    for (let t = 0; t < 30_000; t += 100) unit.advance(100);
    expect(Math.hypot(unit.x - 200, unit.y - 200)).toBeLessThan(0.5);
  });

  test("a flying creature moves to a point at or above the ground, from where it is", () => {
    const unit = wanderer({ canFly: true, spawnId: 0, wanderDistance: 12 });
    unit.advance(10);
    expect(unit.movespline.finalized()).toBe(false);
    const dest = unit.movespline.finalDestination();
    expect(dest.z).toBeGreaterThanOrEqual(20);
    expect(Math.hypot(dest.x - 200, dest.y - 200)).toBeLessThanOrEqual(12.01);
  });
});
