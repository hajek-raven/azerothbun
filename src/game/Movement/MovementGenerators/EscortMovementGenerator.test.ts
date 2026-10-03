import { describe, expect, test } from "bun:test";
import { Vector3 } from "../../../math/Vector3.ts";
import { UNIT_STATE_ROAMING, UNIT_STATE_ROAMING_MOVE, UNIT_STATE_ROOT } from "../../../spells/enums.ts";
import { ESCORT_MOTION_TYPE, FORCED_MOVEMENT_FLY, FORCED_MOVEMENT_NONE, FORCED_MOVEMENT_RUN, FORCED_MOVEMENT_WALK, IDLE_MOTION_TYPE, MOTION_SLOT_ACTIVE } from "../MotionMaster.ts";
import { FakeUnit } from "../test-movement-owner.ts";
import { EscortMovementGenerator } from "./EscortMovementGenerator.ts";

function path(...pts: [number, number, number][]): Vector3[] {
  return pts.map(([x, y, z]) => new Vector3(x, y, z));
}

function escort(opts: ConstructorParameters<typeof FakeUnit>[0] = {}) {
  const unit = new FakeUnit({ pos: [100, 100, 10], ...opts });
  unit.motionMaster.initialize();
  return unit;
}

describe("EscortMovementGenerator", () => {
  test("follows a three point path, exposes the spline id, and ends at the last point", () => {
    const unit = escort();
    unit.motionMaster.moveSplinePath(path([100, 100, 10], [110, 100, 10], [110, 110, 10]));
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(ESCORT_MOTION_TYPE);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING)).toBe(true);
    const id = unit.motionMaster.getCurrentSplineId();
    expect(id).toBe(unit.movespline.getId());
    expect(id).toBeGreaterThan(0);
    unit.run(1000);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(ESCORT_MOTION_TYPE);
    unit.run(2000);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_ACTIVE)).not.toBe(ESCORT_MOTION_TYPE);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
    expect(unit.x).toBeCloseTo(110, 2);
    expect(unit.y).toBeCloseTo(110, 2);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING)).toBe(false);
  });

  test("a two point path is a plain move to the second point", () => {
    const unit = escort();
    unit.motionMaster.moveSplinePath(path([100, 100, 10], [105, 100, 10]));
    expect(unit.movespline.finalDestination().x).toBe(105);
    unit.run(2000);
    expect(unit.x).toBeCloseTo(105, 2);
  });

  test("no path: nothing is launched and the generator ends when the (stopped) spline is finalized", () => {
    const unit = escort();
    unit.motionMaster.moveSplinePath(null);
    expect(unit.movespline.finalized()).toBe(true);
    unit.advance(10);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
  });

  test("the forced movement picks walk, run or fly", () => {
    const walker = escort();
    walker.motionMaster.moveSplinePath(path([100, 100, 10], [110, 100, 10], [120, 100, 10]), FORCED_MOVEMENT_WALK);
    expect(walker.movespline.velocity()).toBeCloseTo(2.5, 4);
    const runner = escort();
    runner.addUnitMovementFlag(0x100);
    runner.motionMaster.moveSplinePath(path([100, 100, 10], [110, 100, 10], [120, 100, 10]), FORCED_MOVEMENT_RUN);
    expect(runner.movespline.velocity()).toBeCloseTo(7, 4);
    const flyer = escort();
    flyer.motionMaster.moveSplinePath(path([100, 100, 10], [110, 100, 10], [120, 100, 10]), FORCED_MOVEMENT_FLY);
    expect(flyer.movespline.splineflags.flying).toBe(true);
    const none = escort();
    none.motionMaster.moveSplinePath(path([100, 100, 10], [110, 100, 10], [120, 100, 10]), FORCED_MOVEMENT_NONE);
    expect(none.movespline.splineflags.flying).toBe(false);
  });

  test("a speed change relaunches the rest of the path with a new spline id", () => {
    const unit = escort();
    unit.motionMaster.moveSplinePath(path([100, 100, 10], [110, 100, 10], [120, 100, 10], [130, 100, 10]));
    const firstId = unit.motionMaster.getCurrentSplineId();
    unit.run(2000);
    expect(unit.x).toBeGreaterThan(110);
    unit.speeds[1] = 14;
    unit.motionMaster.propagateSpeedChange();
    unit.advance(10);
    expect(unit.motionMaster.getCurrentSplineId()).toBeGreaterThan(firstId);
    expect(unit.movespline.velocity()).toBeCloseTo(14, 4);
    unit.run(3000);
    expect(unit.x).toBeCloseTo(130, 2);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
  });

  test("a rooted or casting unit keeps the generator but loses the roaming move state", () => {
    const unit = escort();
    unit.motionMaster.moveSplinePath(path([100, 100, 10], [110, 100, 10], [120, 100, 10]));
    unit.addUnitState(UNIT_STATE_ROOT);
    unit.advance(100);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING_MOVE)).toBe(false);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(ESCORT_MOTION_TYPE);
    unit.clearUnitState(UNIT_STATE_ROOT);
    unit.advance(100);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING_MOVE)).toBe(true);
  });

  test("reset stops the unit and sets the roaming states", () => {
    const unit = escort();
    unit.motionMaster.moveSplinePath(path([100, 100, 10], [110, 100, 10], [120, 100, 10]));
    unit.motionMaster.reinitializeMovement();
    expect(unit.movespline.finalized()).toBe(true);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING)).toBe(true);
  });

  test("the path is copied: changing the caller's array later does not change the escort", () => {
    const unit = escort();
    const pts = path([100, 100, 10], [110, 100, 10], [120, 100, 10]);
    const gen = new EscortMovementGenerator(FORCED_MOVEMENT_NONE, pts);
    pts[2]!.x = 999;
    gen.initialize(unit.asOwner());
    expect(unit.movespline.finalDestination().x).toBe(120);
  });

  test("a player can be escorted as well", () => {
    const player = escort({ player: true });
    player.motionMaster.moveSplinePath(path([100, 100, 10], [110, 100, 10], [120, 100, 10]));
    expect(player.motionMaster.getCurrentMovementGeneratorType()).toBe(ESCORT_MOTION_TYPE);
  });

  test("movePath builds the escort from a waypoint path of the waypoint manager", async () => {
    const { sWaypointMgr } = await import("../Waypoints/WaypointMgr.ts");
    const { waypoint_data } = await import("../../../database/schema/world.ts");
    const { WorldTables } = await import("../../../database/world-tables.ts");
    sWaypointMgr().load(
      WorldTables.fromRows([
        [
          waypoint_data,
          [
            { id: 4242, point: 1, position_x: 110, position_y: 100, position_z: 10 },
            { id: 4242, point: 2, position_x: 120, position_y: 100, position_z: 10 },
          ],
        ],
      ]),
    );
    const unit = escort();
    unit.motionMaster.movePath(4242);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(ESCORT_MOTION_TYPE);
    expect(unit.movespline.finalDestination().x).toBe(120);
    unit.motionMaster.clear();
    unit.motionMaster.movePath(9999999); // no such path: logged, nothing launched
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
  });
});
