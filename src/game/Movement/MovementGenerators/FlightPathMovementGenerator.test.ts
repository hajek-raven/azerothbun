import { afterEach, describe, expect, test } from "bun:test";
import type { TaxiPathNodeEntry } from "../../../gen/DBCStructure.gen.ts";
import { UNIT_FLAG_DISABLE_MOVE, UNIT_FLAG_TAXI_FLIGHT, UNIT_STATE_IN_FLIGHT } from "../../../spells/enums.ts";
import { PLAYER_FLAGS_TAXI_BENCHMARK } from "../../Entities/Player/PlayerDefines.ts";
import { FLIGHT_MOTION_TYPE, IDLE_MOTION_TYPE, MOTION_SLOT_CONTROLLED, NULL_MOTION_TYPE } from "../MotionMaster.ts";
import { FakeMap, FakeUnit } from "../test-movement-owner.ts";
import { FlightPathContext, FlightPathMovementGenerator, type TaxiPathNodeList } from "./WaypointMovementGenerator.ts";

const original = { ...FlightPathContext };
afterEach(() => Object.assign(FlightPathContext, original));

/** `n` nodes of a taxi path: `(x0 + i * dx, y0 + i * dy)` on map `mapid`, `index` 0..n-1. */
function taxiNodes(path: number, n: number, x0: number, y0: number, dx: number, dy: number, mapid = 0, z = 100): TaxiPathNodeEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    path,
    index: i,
    mapid,
    x: x0 + i * dx,
    y: y0 + i * dy,
    z,
    actionFlag: 0,
    delay: 0,
    arrivalEventID: 0,
    departureEventID: 0,
  }));
}

function wire(byPath: TaxiPathNodeEntry[][], links: Record<string, { path: number; cost: number }>, maps: Record<number, FakeMap> = {}): void {
  FlightPathContext.getTaxiPathNodesByPath = () => byPath as readonly TaxiPathNodeList[];
  FlightPathContext.getTaxiPath = (a, b) => links[`${a}-${b}`] ?? { path: 9999, cost: 0 };
  FlightPathContext.findBaseNonInstanceMap = (id) => maps[id] ?? null;
}

function flyer(taxi: number[]) {
  const player = new FakeUnit({ player: true, pos: [0, 0, 100] });
  player.motionMaster.initialize();
  player.taxi.path = taxi;
  return player;
}

describe("FlightPathMovementGenerator", () => {
  test("a one hop flight: sets the flight state, follows the path at the taxi speed, and lands at the last node", () => {
    const nodes = taxiNodes(1, 6, 0, 0, 100, 0);
    wire([[], nodes], { "10-20": { path: 1, cost: 50 } });
    const player = flyer([10, 20]);
    player.motionMaster.moveTaxiFlight(1, 0);
    expect(player.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(FLIGHT_MOTION_TYPE);
    expect(player.hasUnitState(UNIT_STATE_IN_FLIGHT)).toBe(true);
    expect(player.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE | UNIT_FLAG_TAXI_FLIGHT)).toBe(true);
    expect(player.movespline.velocity()).toBeCloseTo(32, 3); // CONFIG_TAXI_FLIGHT_SPEED
    expect(player.movespline.splineflags.flying).toBe(true);
    // the start vertex (the player) and the six nodes
    expect(player.movespline.finalDestination().x).toBe(500);

    player.run(5000);
    expect(player.x).toBeGreaterThan(100);
    expect(player.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(FLIGHT_MOTION_TYPE);
    player.run(12_000);
    // `currentPathIdx()` counts the finished spline, so the last node is reached when the spline ends
    expect(player.x).toBeCloseTo(500, 1);
    expect(player.movespline.finalized()).toBe(true);
    expect(player.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(NULL_MOTION_TYPE);
    expect(player.motionMaster.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
    // the end of the flight
    expect(player.hasUnitState(UNIT_STATE_IN_FLIGHT)).toBe(false);
    expect(player.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE | UNIT_FLAG_TAXI_FLIGHT)).toBe(false);
    expect(player.taxi.cleared).toBe(1);
    expect(player.log).toContain("dismount");
    expect(player.log).toContain(`removePlayerFlag(${PLAYER_FLAGS_TAXI_BENCHMARK})`);
    expect(player.fallInformation).not.toBeNull();
    expect(player.money).toBe(1000); // the single hop is paid at the flight master
    expect(player.taxi.next).toBe(0); // the last stop is not "passed": the flight ends there
  });

  test("a two hop flight: passing the first stop moves on to the next destination and charges its cost", () => {
    const first = taxiNodes(1, 6, 0, 0, 100, 0); // x 0..500
    const second = taxiNodes(2, 6, 500, 0, 0, 100); // y 0..500
    wire([[], first, second], { "10-20": { path: 1, cost: 50 }, "20-30": { path: 2, cost: 70 } });
    const player = flyer([10, 20, 30]);
    player.motionMaster.moveTaxiFlight(1, 0);
    const gen = player.motionMaster.getMotionSlot(MOTION_SLOT_CONTROLLED) as FlightPathMovementGenerator;
    // the first leg without its last node, the second without its first two (within 40 yards of the stop, `i >= 2`)
    expect(gen.getPath().map((n) => [n.x, n.y])).toEqual([
      [0, 0],
      [100, 0],
      [200, 0],
      [300, 0],
      [400, 0],
      [500, 200],
      [500, 300],
      [500, 400],
      [500, 500],
    ]);
    expect(player.movespline.finalDestination().y).toBe(500);
    player.run(40_000);
    expect(player.y).toBeGreaterThan(400);
    // the first stop is passed (`NextTaxiDestination`, and the cost of the next leg is paid); the last one ends the flight
    expect(player.taxi.next).toBe(1);
    expect(player.money).toBe(1000 - 70);
    expect(player.taxi.cleared).toBe(1);
  });

  test("the node counter follows the spline and the flight ends when the last node is reached", () => {
    wire([[], taxiNodes(1, 6, 0, 0, 100, 0)], { "10-20": { path: 1, cost: 0 } });
    const player = flyer([10, 20]);
    player.motionMaster.moveTaxiFlight(1, 0);
    const gen = player.motionMaster.getMotionSlot(MOTION_SLOT_CONTROLLED) as FlightPathMovementGenerator;
    expect(gen.getCurrentNode()).toBe(0);
    expect(gen.hasArrived()).toBe(false);
    let last = 0;
    for (let t = 0; t < 20_000 && player.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED) === FLIGHT_MOTION_TYPE; t += 100) {
      player.advance(100);
      const node = gen.getCurrentNode();
      expect(node).toBeGreaterThanOrEqual(last);
      last = node;
    }
    expect(last).toBeGreaterThan(2);
    expect(last).toBeLessThanOrEqual(5);
  });

  test("departure and arrival events of a node start the event scripts", () => {
    const nodes = taxiNodes(1, 6, 0, 0, 100, 0);
    nodes[1]!.departureEventID = 777;
    nodes[2]!.arrivalEventID = 888;
    wire([[], nodes], { "10-20": { path: 1, cost: 0 } });
    const player = flyer([10, 20]);
    player.motionMaster.moveTaxiFlight(1, 0);
    player.run(15_000);
    const ids = player.getMap().scripts.map((s) => s.id);
    expect(ids).toContain(777);
  });

  test("a flight that starts in the middle (pathnode) begins at that node", () => {
    wire([[], taxiNodes(1, 6, 0, 0, 100, 0)], { "10-20": { path: 1, cost: 0 } });
    const player = flyer([10, 20]);
    player.motionMaster.moveTaxiFlight(1, 3);
    const gen = player.motionMaster.getMotionSlot(MOTION_SLOT_CONTROLLED) as FlightPathMovementGenerator;
    expect(gen.getCurrentNode()).toBe(3);
    // from the player's position to the nodes 3, 4 and 5
    expect(player.movespline.finalDestination().x).toBe(500);
    const pos = { x: 0, y: 0, z: 0 };
    gen.getResetPos(player.asPlayer(), pos);
    expect([pos.x, pos.y, pos.z]).toEqual([300, 0, 100]);
  });

  test("a path that cannot be built clears the taxi destinations and dismounts", () => {
    wire([[], []], { "10-20": { path: 1, cost: 0 } }); // path 1 has no nodes
    const player = flyer([10, 20]);
    player.motionMaster.moveTaxiFlight(1, 0);
    expect(player.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(NULL_MOTION_TYPE);
    expect(player.taxi.cleared).toBe(1);
    expect(player.log).toContain("dismount");

    // a path id beyond the table
    const other = flyer([10, 20]);
    other.motionMaster.moveTaxiFlight(50, 0);
    expect(other.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(NULL_MOTION_TYPE);
    expect(other.taxi.cleared).toBe(0);
  });

  test("a creature cannot take a taxi", () => {
    wire([[], taxiNodes(1, 6, 0, 0, 100, 0)], { "10-20": { path: 1, cost: 0 } });
    const creature = new FakeUnit();
    creature.motionMaster.initialize();
    creature.motionMaster.moveTaxiFlight(1, 0);
    expect(creature.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(NULL_MOTION_TYPE);
  });

  test("a start node past the end of the path falls back to the second last node", () => {
    wire([[], taxiNodes(1, 6, 0, 0, 100, 0)], { "10-20": { path: 1, cost: 0 } });
    const player = flyer([10, 20]);
    player.motionMaster.moveTaxiFlight(1, 40);
    const gen = player.motionMaster.getMotionSlot(MOTION_SLOT_CONTROLLED) as FlightPathMovementGenerator;
    expect(gen.getCurrentNode()).toBe(4);
  });

  test("the generator reports where the path crosses to another map, and skips to it after a teleport", () => {
    const nodes = [...taxiNodes(1, 3, 0, 0, 100, 0, 0), ...taxiNodes(1, 3, 0, 0, 100, 0, 1)];
    wire([[], nodes], { "10-20": { path: 1, cost: 0 } });
    const gen = new FlightPathMovementGenerator(0);
    const player = flyer([10, 20]);
    gen.loadPath(player.asPlayer());
    expect(gen.getPath().length).toBe(6);
    expect(gen.getPathAtMapEnd()).toBe(3);
    gen.setCurrentNodeAfterTeleport();
    expect(gen.getCurrentNode()).toBe(3);
    expect(gen.getPathAtMapEnd()).toBe(6);
    gen.skipCurrentNode();
    expect(gen.getCurrentNode()).toBe(4);
    gen.skipCurrentNode();
    gen.skipCurrentNode();
    expect(gen.hasArrived()).toBe(true);
    gen.setCurrentNodeAfterTeleport(); // past the end: nothing
    expect(gen.getCurrentNode()).toBe(6);
  });

  test("the grid of the last stop is loaded when the flight passes the preload node", () => {
    const destinationMap = new FakeMap(530);
    const nodes = taxiNodes(1, 6, 0, 0, 100, 0, 530);
    wire([[], nodes], { "10-20": { path: 1, cost: 0 } }, { 530: destinationMap });
    const player = flyer([10, 20]);
    player.motionMaster.moveTaxiFlight(1, 0);
    player.run(15_000);
    expect(destinationMap.loadedGrids).toEqual([[500, 0]]); // `_endGridX`, `_endGridY`: the last node
  });

  test("the preload does nothing when the end map is not running", () => {
    wire([[], taxiNodes(1, 6, 0, 0, 100, 0, 530)], { "10-20": { path: 1, cost: 0 } });
    const player = flyer([10, 20]);
    player.motionMaster.moveTaxiFlight(1, 0);
    player.run(20_000);
    expect(player.motionMaster.getMotionSlotType(MOTION_SLOT_CONTROLLED)).toBe(NULL_MOTION_TYPE);
  });

  test("starting a flight from the end point of the map does nothing", () => {
    wire([[], taxiNodes(1, 6, 0, 0, 100, 0)], { "10-20": { path: 1, cost: 0 } });
    const player = flyer([10, 20]);
    const gen = new FlightPathMovementGenerator(6);
    expect(gen.loadPath(player.asPlayer())).toBe(true); // the node counter is fixed up to the second last node
    const gen2 = new FlightPathMovementGenerator(0);
    gen2.loadPath(player.asPlayer());
    expect(gen2.getCurrentNode()).toBe(0);
  });
});
