import { describe, expect, test } from "bun:test";
import { waypoint_data, waypoint_data_addon } from "../../../database/schema/world.ts";
import { WORLD_TABLES } from "../../../database/world-table-list.ts";
import { WorldTables } from "../../../database/world-tables.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import {
  WAYPOINT_MOVE_TYPE_LAND,
  WAYPOINT_MOVE_TYPE_MAX,
  WAYPOINT_MOVE_TYPE_RUN,
  WAYPOINT_MOVE_TYPE_TAKEOFF,
  WAYPOINT_MOVE_TYPE_WALK,
  WaypointNode,
  WaypointPath,
} from "./WaypointDefines.ts";
import { sWaypointMgr, WaypointMgr } from "./WaypointMgr.ts";

const F = Math.fround;

function wp(id: number, point: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, point, position_x: point * 10, position_y: 0, position_z: 1, ...extra };
}

describe("WaypointDefines", () => {
  test("move types", () => {
    expect([WAYPOINT_MOVE_TYPE_WALK, WAYPOINT_MOVE_TYPE_RUN, WAYPOINT_MOVE_TYPE_LAND, WAYPOINT_MOVE_TYPE_TAKEOFF, WAYPOINT_MOVE_TYPE_MAX]).toEqual([0, 1, 2, 3, 4]);
  });

  test("the two WaypointNode constructors differ in MoveType and EventChance", () => {
    const empty = new WaypointNode();
    expect(empty).toMatchObject({ Id: 0, X: 0, Y: 0, Z: 0, Velocity: 0, Delay: 0, EventId: 0, MoveType: WAYPOINT_MOVE_TYPE_RUN, EventChance: 0, SmoothTransition: false });
    expect(empty.Orientation).toBeUndefined();
    expect(empty.SplinePoints).toEqual([]);

    const full = new WaypointNode(7, 1.1, 2, 3, 0.5, 4, 5000, true);
    expect(full).toMatchObject({ Id: 7, X: F(1.1), Y: 2, Z: 3, Orientation: 0.5, Velocity: 4, Delay: 5000, EventId: 0, MoveType: WAYPOINT_MOVE_TYPE_WALK, EventChance: 100, SmoothTransition: true });
    expect(new WaypointNode(1, 0, 0, 0).Orientation).toBeUndefined();
  });

  test("WaypointPath", () => {
    expect(new WaypointPath()).toMatchObject({ Id: 0, Nodes: [] });
    const nodes = [new WaypointNode(1, 0, 0, 0)];
    expect(new WaypointPath(9, nodes)).toMatchObject({ Id: 9, Nodes: nodes });
  });
});

describe("WaypointMgr::Load", () => {
  test("waypoint_data and waypoint_data_addon are in the loaded world tables", () => {
    expect(WORLD_TABLES).toContain(waypoint_data);
    expect(WORLD_TABLES).toContain(waypoint_data_addon);
  });

  test("an empty table loads nothing", () => {
    const mgr = new WaypointMgr();
    mgr.load(WorldTables.fromRows([[waypoint_data, []]]));
    expect(mgr.getPath(1)).toBeNull();
    mgr.loadWaypointAddons(WorldTables.fromRows([]));
  });

  test("groups rows by path id, ordered by point, with every column", () => {
    const tables = WorldTables.fromRows([
      [
        waypoint_data,
        [
          wp(2, 1, { position_x: 5000, position_y: -5000, orientation: 1.25, velocity: 3.5, delay: 4000, smoothTransition: 1, move_type: WAYPOINT_MOVE_TYPE_LAND, action: 77, action_chance: 40 }),
          wp(1, 3, { orientation: null, move_type: WAYPOINT_MOVE_TYPE_RUN }),
          wp(1, 1, { move_type: WAYPOINT_MOVE_TYPE_WALK, velocity: 2 }),
          wp(1, 2, { move_type: WAYPOINT_MOVE_TYPE_TAKEOFF, orientation: 3 }),
        ],
      ],
    ]);
    const mgr = new WaypointMgr();
    mgr.load(tables);

    const one = mgr.getPath(1)!;
    expect(one.Id).toBe(1);
    expect(one.Nodes.map((n) => n.Id)).toEqual([1, 2, 3]);
    expect(one.Nodes.map((n) => n.MoveType)).toEqual([WAYPOINT_MOVE_TYPE_WALK, WAYPOINT_MOVE_TYPE_TAKEOFF, WAYPOINT_MOVE_TYPE_RUN]);
    expect(one.Nodes[0]).toMatchObject({ X: 10, Y: 0, Z: 1, Velocity: 2, Delay: 0, EventId: 0, EventChance: 100, SmoothTransition: false });
    expect(one.Nodes[0]!.Orientation).toBeUndefined();
    expect(one.Nodes[1]!.Orientation).toBe(3);
    expect(one.Nodes[2]!.Orientation).toBeUndefined();

    const two = mgr.getPath(2)!;
    expect(two.Nodes.length).toBe(1);
    // x and y are normalized to the map's edge (MAP_HALFSIZE - 0.5 = 17066.166...)
    expect(two.Nodes[0]).toMatchObject({ Orientation: 1.25, Velocity: 3.5, Delay: 4000, SmoothTransition: true, MoveType: WAYPOINT_MOVE_TYPE_LAND, EventId: 77, EventChance: 40 });
    expect(two.Nodes[0]!.X).toBeLessThanOrEqual(17066.67);
    expect(mgr.getPath(3)).toBeNull();
    expect(sWaypointMgr()).toBe(WaypointMgr.instance());
  });

  test("a coordinate beyond the map edge is clamped to MAP_HALFSIZE - 0.5", () => {
    const mgr = new WaypointMgr();
    mgr.load(WorldTables.fromRows([[waypoint_data, [wp(1, 1, { position_x: 99999, position_y: -99999, position_z: 99999 })]]]));
    const n = mgr.getPath(1)!.Nodes[0]!;
    expect(n.X).toBe(F(17066.666666666668 - 0.5));
    expect(n.Y).toBe(F(-(17066.666666666668 - 0.5)));
    expect(n.Z).toBe(99999);
  });

  test("a row with an invalid move_type is skipped", () => {
    const mgr = new WaypointMgr();
    mgr.load(
      WorldTables.fromRows([
        [waypoint_data, [wp(1, 1, { move_type: 4 }), wp(1, 2, { move_type: -1 }), wp(1, 3, { move_type: 2 })]],
      ]),
    );
    expect(mgr.getPath(1)!.Nodes.map((n) => n.Id)).toEqual([3]);
    const only = new WaypointMgr();
    only.load(WorldTables.fromRows([[waypoint_data, [wp(5, 1, { move_type: 9 })]]]));
    expect(only.getPath(5)).toBeNull(); // no node: the path is never created
  });

  test("action_chance keeps the low 8 bits like the uint8 EventChance", () => {
    const mgr = new WaypointMgr();
    mgr.load(WorldTables.fromRows([[waypoint_data, [wp(1, 1, { action_chance: 300 }), wp(1, 2, { action_chance: -1 })]]]));
    expect(mgr.getPath(1)!.Nodes.map((n) => n.EventChance)).toEqual([44, 255]);
  });
});

describe("WaypointMgr::LoadWaypointAddons", () => {
  test("adds spline points to the matching node, ordered by SplinePointIndex, and skips unknown rows", () => {
    const tables = WorldTables.fromRows([
      [waypoint_data, [wp(1, 1), wp(1, 2)]],
      [
        waypoint_data_addon,
        [
          { PathID: 1, PointID: 2, SplinePointIndex: 1, PositionX: 2, PositionY: 2, PositionZ: 2 },
          { PathID: 1, PointID: 2, SplinePointIndex: 0, PositionX: 1.5, PositionY: 1, PositionZ: 1 },
          { PathID: 1, PointID: 2, SplinePointIndex: 2, PositionX: 99999, PositionY: 3, PositionZ: 3 },
          { PathID: 9, PointID: 1, SplinePointIndex: 0, PositionX: 1, PositionY: 1, PositionZ: 1 }, // no such path
          { PathID: 1, PointID: 7, SplinePointIndex: 0, PositionX: 1, PositionY: 1, PositionZ: 1 }, // no such point
        ],
      ],
    ]);
    const mgr = new WaypointMgr();
    mgr.load(tables);
    mgr.loadWaypointAddons(tables);
    const nodes = mgr.getPath(1)!.Nodes;
    expect(nodes[0]!.SplinePoints).toEqual([]);
    expect(nodes[1]!.SplinePoints).toEqual([new Vector3(1.5, 1, 1), new Vector3(2, 2, 2), new Vector3(F(17066.666666666668 - 0.5), 3, 3)]);
  });
});

describe("WaypointMgr::ReloadPath", () => {
  test("replaces one path from the table, drops it when the rows are gone, keeps the others", () => {
    const mgr = new WaypointMgr();
    mgr.load(WorldTables.fromRows([[waypoint_data, [wp(1, 1), wp(1, 2), wp(2, 1)]]]));
    const addon = WorldTables.fromRows([
      [waypoint_data, [wp(1, 1), wp(1, 2)]],
      [waypoint_data_addon, [{ PathID: 1, PointID: 1, SplinePointIndex: 0, PositionX: 1, PositionY: 1, PositionZ: 1 }]],
    ]);
    mgr.loadWaypointAddons(addon);
    expect(mgr.getPath(1)!.Nodes[0]!.SplinePoints.length).toBe(1);

    const changed = WorldTables.fromRows([
      [waypoint_data, [wp(1, 5, { action: 3, action_chance: 20 }), wp(1, 4, { move_type: 7 }), wp(1, 6, { smoothTransition: 1, orientation: 2 }), wp(2, 1)]],
    ]);
    mgr.reloadPath(1, changed);
    const path = mgr.getPath(1)!;
    expect(path.Id).toBe(1);
    expect(path.Nodes.map((n) => n.Id)).toEqual([5, 6]); // ordered by point, the invalid move_type skipped
    expect(path.Nodes[0]).toMatchObject({ EventId: 3, EventChance: 20 });
    expect(path.Nodes[1]).toMatchObject({ SmoothTransition: true, Orientation: 2 });
    expect(path.Nodes[0]!.SplinePoints).toEqual([]); // addon data is not reloaded
    expect(mgr.getPath(2)!.Nodes.length).toBe(1);

    mgr.reloadPath(1, WorldTables.fromRows([[waypoint_data, [wp(2, 1)]]]));
    expect(mgr.getPath(1)).toBeNull();
    mgr.reloadPath(2, WorldTables.fromRows([[waypoint_data, []]]));
    expect(mgr.getPath(2)).toBeNull();
  });
});
