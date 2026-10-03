import { describe, expect, test } from "bun:test";
import { Vector3 } from "../../../math/Vector3.ts";
import { UNIT_STATE_ROAMING, UNIT_STATE_ROAMING_MOVE, UNIT_STATE_ROOT } from "../../../spells/enums.ts";
import { MOTION_SLOT_IDLE, PathSource, WAYPOINT_MOTION_TYPE } from "../MotionMaster.ts";
import { FakeUnit } from "../test-movement-owner.ts";
import { WAYPOINT_MOVE_TYPE_LAND, WAYPOINT_MOVE_TYPE_RUN, WAYPOINT_MOVE_TYPE_TAKEOFF, WAYPOINT_MOVE_TYPE_WALK, WaypointNode, WaypointPath } from "../Waypoints/WaypointDefines.ts";
import { sWaypointMgr } from "../Waypoints/WaypointMgr.ts";
import { WaypointMovementGenerator } from "./WaypointMovementGenerator.ts";

const PATH_ID = 11;

/** A node at `(x, y, 10)` that runs (the `WaypointNode(id, ...)` constructor walks). */
function node(id: number, x: number, y: number, extra: Partial<WaypointNode> = {}): WaypointNode {
  const n = new WaypointNode(id, x, y, 10);
  n.MoveType = WAYPOINT_MOVE_TYPE_RUN;
  return Object.assign(n, extra);
}

function square(): WaypointNode[] {
  return [node(1, 110, 100), node(2, 110, 110), node(3, 100, 110)];
}

function walker(nodes: WaypointNode[], repeating: boolean, opts: ConstructorParameters<typeof FakeUnit>[0] = {}) {
  const unit = new FakeUnit({ pos: [100, 100, 10], ...opts });
  unit.motionMaster.initialize();
  const gen = new WaypointMovementGenerator(new WaypointPath(PATH_ID, nodes), repeating);
  (unit.motionMaster as unknown as { mutate(m: unknown, slot: number): void }).mutate(gen, MOTION_SLOT_IDLE);
  return { unit, gen };
}

const reached = (unit: FakeUnit) => unit.recordingAI!.calls.filter((c) => c.startsWith("WaypointReached")).map((c) => c);

describe("WaypointMovementGenerator: a path of single splines", () => {
  test("starts the path, walks node by node, informs the AI in order, and ends at the last node of a non repeating path", () => {
    const { unit } = walker(square(), false);
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(WAYPOINT_MOTION_TYPE);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING)).toBe(true);
    expect(unit.recordingAI!.calls).toEqual([`WaypointPathStarted(${PATH_ID})`]);
    unit.run(10_000);
    expect(unit.recordingAI!.calls).toEqual([
      `WaypointPathStarted(${PATH_ID})`,
      `WaypointStarted(1,${PATH_ID})`,
      "MovementInform(2,1)",
      `WaypointReached(1,${PATH_ID})`,
      `WaypointStarted(2,${PATH_ID})`,
      "MovementInform(2,2)",
      `WaypointReached(2,${PATH_ID})`,
      `WaypointStarted(3,${PATH_ID})`,
      "MovementInform(2,3)",
      `WaypointReached(3,${PATH_ID})`,
      `PathEndReached(${PATH_ID})`,
      `WaypointPathEnded(3,${PATH_ID})`,
    ]);
    expect(unit.x).toBeCloseTo(100, 2);
    expect(unit.y).toBeCloseTo(110, 2);
    expect(unit.currentWaypointInfo).toEqual([0, 0]); // cleared at the path end
    expect(unit.waypointId).toBe(3);
    unit.run(3000);
    expect(unit.recordingAI!.calls.length).toBe(12); // done: nothing more happens
    expect(unit.motionMaster.getCurrentMovementGeneratorType()).toBe(WAYPOINT_MOTION_TYPE);
  });

  test("the home position follows the creature along the path and ends at the last node", () => {
    const { unit } = walker(square(), false);
    unit.run(1000);
    const mid = unit.homePosition.getPositionX();
    expect(mid).toBeGreaterThan(100); // set to the current position while the spline runs
    unit.run(10_000);
    expect(unit.homePosition.getPositionX()).toBeCloseTo(100, 3);
    expect(unit.homePosition.getPositionY()).toBeCloseTo(110, 3);
  });

  test("a repeating path wraps from the last node to the first, again and again", () => {
    const { unit } = walker(square(), true);
    unit.run(30_000);
    const ids = reached(unit).map((c) => Number(/\((\d+),/.exec(c)![1]));
    expect(ids.slice(0, 7)).toEqual([1, 2, 3, 1, 2, 3, 1]);
    expect(unit.recordingAI!.calls).not.toContain(`PathEndReached(${PATH_ID})`);
  });

  test("a delay at a node stops the creature for that long, with the roaming move state cleared", () => {
    const nodes = square();
    nodes[1]!.Delay = 3000;
    nodes[1]!.Orientation = 1.0;
    const { unit } = walker(nodes, false);
    unit.run(3000); // node 1 (10 yards), then 10 yards to node 2 (1.43 s each)
    let arrivedAt = -1;
    for (let t = 0; t < 8000 && arrivedAt < 0; t += 50) {
      unit.advance(50);
      if (unit.recordingAI!.calls.includes(`WaypointReached(2,${PATH_ID})`)) arrivedAt = t;
    }
    expect(arrivedAt).toBeGreaterThanOrEqual(0);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING_MOVE)).toBe(false);
    const idAtArrival = unit.movespline.getId();
    unit.run(2800, 100);
    expect(unit.movespline.getId()).toBe(idAtArrival); // still waiting
    expect(unit.o).toBeCloseTo(1.0, 3); // the node's orientation (the spline ends facing it)
    unit.run(1000, 100);
    expect(unit.movespline.getId()).toBeGreaterThan(idAtArrival);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING_MOVE)).toBe(true);
  });

  test("a creature starts at the node stored in its spawn data when the path is long enough", () => {
    const unit = new FakeUnit({ pos: [100, 100, 10] });
    unit.creatureData = { currentwaypoint: 2 };
    unit.motionMaster.initialize();
    const gen = new WaypointMovementGenerator(new WaypointPath(PATH_ID, square()), false);
    (unit.motionMaster as unknown as { mutate(m: unknown, slot: number): void }).mutate(gen, MOTION_SLOT_IDLE);
    expect(unit.currentWaypointInfo).toEqual([2, PATH_ID]);
    unit.run(200);
    expect(unit.recordingAI!.calls).toContain(`WaypointStarted(3,${PATH_ID})`);
    expect(gen.getCurrentNode()).toBe(2);
  });

  test("the move type decides run, walk, and the landing and takeoff animation; a velocity overrides the speed", () => {
    const nodes = [node(1, 130, 100, { MoveType: WAYPOINT_MOVE_TYPE_WALK }), node(2, 130, 130, { MoveType: WAYPOINT_MOVE_TYPE_RUN })];
    const { unit } = walker(nodes, false);
    unit.advance(10);
    expect(unit.movespline.velocity()).toBeCloseTo(2.5, 4);
    unit.run(15_000);
    expect(unit.movespline.velocity()).toBeCloseTo(7, 4);

    const { unit: fast } = walker([node(1, 130, 100, { Velocity: 3.5 })], false);
    fast.advance(10);
    expect(fast.movespline.velocity()).toBeCloseTo(3.5, 4);

    const { unit: land } = walker([node(1, 130, 100, { MoveType: WAYPOINT_MOVE_TYPE_LAND })], false);
    land.advance(10);
    expect(land.movespline.hasAnimation()).toBe(true);
    const { unit: take } = walker([node(1, 130, 100, { MoveType: WAYPOINT_MOVE_TYPE_TAKEOFF })], false);
    take.advance(10);
    expect(take.movespline.hasAnimation()).toBe(true);
  });

  test("a flying creature flies the path", () => {
    const { unit } = walker(square(), false, { canFly: true });
    unit.advance(10);
    expect(unit.movespline.splineflags.flying).toBe(true);
  });

  test("spline points of a node (waypoint_data_addon) make the creature walk through them to the node", () => {
    const n = node(1, 120, 100);
    n.SplinePoints = [new Vector3(105, 105, 10), new Vector3(115, 105, 10)];
    const { unit } = walker([n], false);
    unit.advance(10);
    // the start vertex, the two points and the node (the spline adds padding points)
    const path = unit.movespline.getPath();
    expect(path.some((p) => p.x === 105 && p.y === 105)).toBe(true);
    expect(path.some((p) => p.x === 115 && p.y === 105)).toBe(true);
    expect(unit.movespline.finalDestination().x).toBe(120);
    unit.run(5000);
    expect(unit.x).toBeCloseTo(120, 2);
  });

  test("a dead creature does not move; an empty path does nothing", () => {
    const { unit } = walker(square(), false);
    unit.alive = false;
    unit.run(1000);
    expect(unit.movespline.finalized()).toBe(true);
    const { unit: empty } = walker([], false);
    empty.run(1000);
    expect(empty.movespline.finalized()).toBe(true);
  });
});

describe("WaypointMovementGenerator: pause, root, speed change", () => {
  test("pause stops the creature at once and resume carries on to the same node", () => {
    const { unit, gen } = walker([node(1, 150, 100)], false);
    unit.run(1000);
    expect(unit.movespline.finalized()).toBe(false);
    gen.pause();
    unit.advance(100);
    expect(unit.movespline.finalized()).toBe(true);
    const x = unit.x;
    unit.run(1000);
    expect(unit.x).toBe(x);
    gen.resume();
    unit.run(10_000);
    expect(unit.x).toBeCloseTo(150, 2);
    expect(unit.recordingAI!.calls.filter((c) => c.startsWith("WaypointStarted")).length).toBe(1); // a relaunch is not a new start
    expect(unit.recordingAI!.calls).toContain(`WaypointReached(1,${PATH_ID})`);
  });

  test("pause with a timer resumes by itself", () => {
    const { unit, gen } = walker([node(1, 150, 100)], false);
    unit.run(500);
    gen.pause(2000);
    unit.advance(100);
    expect(unit.movespline.finalized()).toBe(true);
    unit.run(1500);
    expect(unit.movespline.finalized()).toBe(true);
    unit.run(1000);
    expect(unit.movespline.finalized()).toBe(false);
    unit.run(10_000);
    expect(unit.x).toBeCloseTo(150, 2);
  });

  test("a rooted creature stops and goes on when the root ends", () => {
    const { unit } = walker([node(1, 150, 100)], false);
    unit.run(500);
    unit.addUnitState(UNIT_STATE_ROOT);
    unit.advance(100);
    expect(unit.movespline.finalized()).toBe(true);
    unit.run(1000);
    unit.clearUnitState(UNIT_STATE_ROOT);
    unit.run(10_000);
    expect(unit.x).toBeCloseTo(150, 2);
  });

  test("a speed change restarts the move to the same node at the new speed", () => {
    const { unit } = walker([node(1, 150, 100)], false);
    unit.run(500);
    const id = unit.movespline.getId();
    unit.speeds[1] = 14;
    unit.motionMaster.propagateSpeedChange();
    unit.advance(10);
    expect(unit.movespline.getId()).toBeGreaterThan(id);
    expect(unit.movespline.velocity()).toBeCloseTo(14, 4);
    expect(unit.recordingAI!.calls.filter((c) => c.startsWith("WaypointStarted")).length).toBe(1);
  });

  test("the reset position is the node the creature is going to; none when done or the path is empty", () => {
    const { unit, gen } = walker(square(), false);
    const pos = { x: 0, y: 0, z: 0 };
    expect(gen.getResetPosition(pos)).toBe(true);
    expect([pos.x, pos.y, pos.z]).toEqual([110, 100, 10]);
    unit.run(1500);
    unit.advance(100);
    gen.getResetPosition(pos);
    expect(pos.y).toBe(110); // the next node
    unit.run(15_000);
    expect(gen.getResetPosition(pos)).toBe(false); // done
    const { gen: empty } = walker([], false);
    expect(empty.getResetPosition(pos)).toBe(false);
  });

  test("a reset in the middle of a move counts as a stall and starts the move again", () => {
    const { unit } = walker([node(1, 150, 100)], false);
    unit.run(500);
    unit.motionMaster.reinitializeMovement();
    unit.run(10_000);
    expect(unit.x).toBeCloseTo(150, 2);
  });
});

describe("WaypointMovementGenerator: smooth transitions", () => {
  function smoothSquare(delayAt = -1): WaypointNode[] {
    const nodes = [node(1, 130, 100, { SmoothTransition: true }), node(2, 130, 130, { SmoothTransition: true }), node(3, 100, 130, { SmoothTransition: true }), node(4, 100, 100, { SmoothTransition: true })];
    if (delayAt >= 0) nodes[delayAt]!.Delay = 2000;
    return nodes;
  }

  test("one catmull-rom spline through the nodes; the AI hears each node as the spline passes it", () => {
    const { unit } = walker(smoothSquare(), false);
    unit.advance(10);
    expect(unit.movespline.splineflags.isSmooth()).toBe(true);
    const id = unit.movespline.getId();
    unit.run(40_000);
    expect(unit.movespline.getId()).toBe(id); // one spline for the whole path
    const ids = reached(unit).map((c) => Number(/\((\d+),/.exec(c)![1]));
    // `currentPathIdx()` counts one more once the spline is finalized, so the last node is passed too
    expect(ids).toEqual([1, 2, 3, 4]);
    expect(unit.recordingAI!.calls).toContain(`PathEndReached(${PATH_ID})`);
    // the node id of `WaypointPathEnded` is read after `i_currentNode` wrapped to the first node (as the C++ does)
    expect(unit.recordingAI!.calls).toContain(`WaypointPathEnded(1,${PATH_ID})`);
    expect(unit.currentWaypointInfo).toEqual([0, 0]);
  });

  test("a node with a delay ends the smooth segment: the creature stops there for the delay and carries on", () => {
    const { unit } = walker(smoothSquare(1), false);
    let stopped = -1;
    for (let t = 0; t < 15_000 && stopped < 0; t += 50) {
      unit.advance(50);
      if (unit.recordingAI!.calls.includes(`WaypointReached(2,${PATH_ID})`)) stopped = t;
    }
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(unit.movespline.finalized()).toBe(true);
    expect(unit.hasUnitState(UNIT_STATE_ROAMING_MOVE)).toBe(false);
    expect([unit.x, unit.y].map(Math.round)).toEqual([130, 130]);
    const id = unit.movespline.getId();
    unit.run(1800, 100);
    expect(unit.movespline.getId()).toBe(id); // waiting out the 2000 ms
    unit.run(500, 100);
    expect(unit.movespline.getId()).toBeGreaterThan(id); // a new smooth segment from the delay node on
    expect(unit.hasUnitState(UNIT_STATE_ROAMING_MOVE)).toBe(true);
  });

  test("a repeating smooth path loops without ever ending", () => {
    const { unit } = walker(smoothSquare(), true);
    unit.run(60_000);
    const ids = reached(unit).map((c) => Number(/\((\d+),/.exec(c)![1]));
    expect(ids.length).toBeGreaterThan(8);
    expect(ids.slice(0, 5)).toEqual([1, 2, 3, 4, 1]);
    expect(unit.recordingAI!.calls).not.toContain(`PathEndReached(${PATH_ID})`);
  });
});

describe("WaypointMovementGenerator from the waypoint manager", () => {
  test("moveWaypoint reads the path of the manager; a creature's own waypoint path is the default", async () => {
    const { waypoint_data } = await import("../../../database/schema/world.ts");
    const { WorldTables } = await import("../../../database/world-tables.ts");
    sWaypointMgr().load(
      WorldTables.fromRows([
        [
          waypoint_data,
          [
            { id: 5151, point: 1, position_x: 110, position_y: 100, position_z: 10, move_type: 1 },
            { id: 5151, point: 2, position_x: 110, position_y: 110, position_z: 10, move_type: 1 },
          ],
        ],
      ]),
    );
    const unit = new FakeUnit({ pos: [100, 100, 10] });
    unit.motionMaster.initialize();
    unit.motionMaster.moveWaypoint(5151, false);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(WAYPOINT_MOTION_TYPE);
    unit.run(10_000);
    expect(unit.recordingAI!.calls).toContain("PathEndReached(5151)");

    const own = new FakeUnit({ pos: [100, 100, 10] });
    own.waypointPath = 5151;
    own.motionMaster.initialize();
    own.motionMaster.moveWaypoint(5151, true);
    expect(own.recordingAI!.calls).toEqual(["WaypointPathStarted(5151)"]);

    const defaulted = new FakeUnit({ pos: [100, 100, 10] });
    defaulted.waypointPath = 5151;
    defaulted.motionMaster.initialize();
    const gen = new WaypointMovementGenerator(0, false, PathSource.WAYPOINT_MGR);
    gen.initialize(defaulted.asOwner());
    expect(defaulted.recordingAI!.calls).toEqual(["WaypointPathStarted(5151)"]);
  });

  test("a path that does not exist is logged and the creature does not move", () => {
    const unit = new FakeUnit({ pos: [100, 100, 10] });
    unit.motionMaster.initialize();
    unit.motionMaster.moveWaypoint(88888888, true);
    unit.run(1000);
    expect(unit.movespline.finalized()).toBe(true);
    expect(unit.recordingAI!.calls).toEqual([]);
  });

  test("moveWaypoint ignores path id 0", () => {
    const unit = new FakeUnit();
    unit.motionMaster.initialize();
    unit.motionMaster.moveWaypoint(0, true);
    expect(unit.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).not.toBe(WAYPOINT_MOTION_TYPE);
  });
});
