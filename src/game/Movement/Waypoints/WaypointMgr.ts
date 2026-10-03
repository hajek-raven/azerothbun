/**
 * Port of `game/Movement/Waypoints/WaypointMgr.{h,cpp}`: `sWaypointMgr`, the paths of `waypoint_data` (and the spline
 * points of `waypoint_data_addon`) that waypoint movement and SmartAI read.
 *
 * `WorldDatabase.Query(...)` reads the in-memory `WorldTables` (`waypoint_data`, `waypoint_data_addon` are in
 * `database/world-table-list.ts`); the `ORDER BY` of the C++ queries is done here. The C++ `Get<float>` values are
 * 32 bit floats, so they go through `Math.fround`.
 *
 * The startup calls them (`loadMovementData` in `Maps/MapSetup.ts`, from `startMapSystem`): `sWaypointMgr().load()` then
 * `.loadWaypointAddons()`, after the spawn stores and before the first grid loads.
 *
 * `WaypointMgr::DeletePath` does not exist in this AzerothCore revision (only `Load`, `LoadWaypointAddons`, `ReloadPath`,
 * `GetPath`).
 */
import { waypoint_data, waypoint_data_addon } from "../../../database/schema/world.ts";
import type { WorldTables } from "../../../database/world-tables.ts";
import { log, logError, logWarn } from "../../../log.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { sObjectMgr } from "../../Globals/ObjectMgr.ts";
import { NormalizeMapCoord } from "../../Grids/GridDefines.ts";
import { getMSTime, getMSTimeDiffToNow } from "../../time/timer.ts";
import { WAYPOINT_MOVE_TYPE_MAX, WaypointNode, WaypointPath } from "./WaypointDefines.ts";

const fround = Math.fround;

/** The columns of a `waypoint_data` row `WaypointMgr::Load` and `ReloadPath` read. */
type WaypointDataRow = {
  id: number;
  point: number;
  position_x: number;
  position_y: number;
  position_z: number;
  orientation: number | null;
  velocity: number;
  delay: number;
  smoothTransition: number;
  move_type: number;
  action: number;
  action_chance: number;
};

/**
 * The common body of `Load` and `ReloadPath`: one `waypoint_data` row to a node, or null when `move_type` is invalid
 * (`LOG_ERROR ... ignoring`). `NormalizeMapCoord` is applied to `x` and `y`.
 */
function nodeFromRow(row: WaypointDataRow): WaypointNode | null {
  const x = NormalizeMapCoord(fround(row.position_x));
  const y = NormalizeMapCoord(fround(row.position_y));
  const z = fround(row.position_z);
  const o = row.orientation === null || row.orientation === undefined ? undefined : fround(row.orientation);

  const waypoint = new WaypointNode();
  waypoint.Id = row.point >>> 0;
  waypoint.X = fround(x);
  waypoint.Y = fround(y);
  waypoint.Z = z;
  if (o !== undefined) waypoint.Orientation = o;
  waypoint.Velocity = fround(row.velocity);
  waypoint.Delay = row.delay >>> 0;
  waypoint.SmoothTransition = row.smoothTransition !== 0;
  waypoint.MoveType = row.move_type >>> 0;

  if (waypoint.MoveType >= WAYPOINT_MOVE_TYPE_MAX) {
    logError("sql", `Waypoint ${waypoint.Id} in waypoint_data has invalid move_type, ignoring`);
    return null;
  }

  waypoint.EventId = row.action >>> 0;
  // Load reads `Get<int16>()`, ReloadPath `Get<uint8>()`; both end in the `uint8` EventChance
  waypoint.EventChance = row.action_chance & 0xff;
  return waypoint;
}

/** @ac game/Movement/Waypoints/WaypointMgr.h WaypointMgr */
export class WaypointMgr {
  private static _instance: WaypointMgr | null = null;

  /** @ac game/Movement/Waypoints/WaypointMgr.cpp WaypointMgr::instance */
  static instance(): WaypointMgr {
    return (WaypointMgr._instance ??= new WaypointMgr());
  }

  /** Private in C++ (`WaypointMgr() { }`); public so tests can build an empty manager. */
  constructor() {}

  /** @ac game/Movement/Waypoints/WaypointMgr.h WaypointMgr::_waypointStore */
  private readonly _waypointStore = new Map<number, WaypointPath>();

  /**
   * Loads all paths from database, should only run on startup
   * @ac game/Movement/Waypoints/WaypointMgr.cpp WaypointMgr::Load (`ORDER BY id, point`)
   */
  load(tables: WorldTables | null = sObjectMgr.worldTables()): void {
    const oldMSTime = getMSTime();

    const result = [...(tables?.all(waypoint_data) ?? [])].sort((a, b) => a.id - b.id || a.point - b.point);

    if (result.length === 0) {
      logWarn("server", ">> Loaded 0 waypoints. DB table `waypoint_data` is empty!");
      log("server", " ");
      return;
    }

    let count = 0;

    for (const row of result) {
      const pathId = row.id >>> 0;
      const waypoint = nodeFromRow(row);
      if (!waypoint) continue;

      let path = this._waypointStore.get(pathId);
      if (!path) {
        path = new WaypointPath();
        this._waypointStore.set(pathId, path);
      }
      path.Id = pathId;
      path.Nodes.push(waypoint);
      ++count;
    }

    log("server", `>> Loaded ${count} waypoints in ${getMSTimeDiffToNow(oldMSTime)} ms`);
    log("server", " ");
  }

  /**
   * Loads additional path data for waypoints from database. Should only be called on startup.
   * @ac game/Movement/Waypoints/WaypointMgr.cpp WaypointMgr::LoadWaypointAddons (`ORDER BY PathID, PointID, SplinePointIndex`)
   */
  loadWaypointAddons(tables: WorldTables | null = sObjectMgr.worldTables()): void {
    const oldMSTime = getMSTime();

    const result = [...(tables?.all(waypoint_data_addon) ?? [])].sort((a, b) => a.PathID - b.PathID || a.PointID - b.PointID || a.SplinePointIndex - b.SplinePointIndex);

    if (result.length === 0) {
      log("server", ">> Loaded 0 waypoint addon data. DB table `waypoint_data_addon` is empty!");
      log("server", " ");
      return;
    }

    let count = 0;

    for (const row of result) {
      const pathId = row.PathID >>> 0;

      const path = this._waypointStore.get(pathId);
      if (!path) {
        logError("sql", `Tried to load waypoint_data_addon data for PathID ${pathId} but there is no such path in waypoint_data. Ignoring.`);
        continue;
      }

      const pointId = row.PointID >>> 0;

      const node = path.Nodes.find((n) => n.Id === pointId);

      if (!node) {
        logError("sql", `Tried to load waypoint_data_addon data for PointID ${pointId} of PathID ${pathId} but there is no such point in waypoint_data. Ignoring.`);
        continue;
      }

      const x = NormalizeMapCoord(fround(row.PositionX));
      const y = NormalizeMapCoord(fround(row.PositionY));
      const z = fround(row.PositionZ);

      node.SplinePoints.push(new Vector3(fround(x), fround(y), z));

      ++count;
    }

    log("server", `>> Loaded ${count} waypoint addon data in ${getMSTimeDiffToNow(oldMSTime)} ms`);
    log("server", " ");
  }

  /**
   * Attempts to reload a single path from database (`WORLD_SEL_WAYPOINT_DATA_BY_ID`, `ORDER BY point`). The spline points
   * of `waypoint_data_addon` are not reloaded, as in C++.
   * @ac game/Movement/Waypoints/WaypointMgr.cpp WaypointMgr::ReloadPath
   */
  reloadPath(id: number, tables: WorldTables | null = sObjectMgr.worldTables()): void {
    id = id >>> 0;
    this._waypointStore.delete(id);

    const result = [...(tables?.where(waypoint_data, "id", id) ?? [])].sort((a, b) => a.point - b.point);

    if (result.length === 0) return;

    const values: WaypointNode[] = [];
    for (const row of result) {
      const waypoint = nodeFromRow(row);
      if (!waypoint) continue;

      values.push(waypoint);
    }

    this._waypointStore.set(id, new WaypointPath(id, values));
  }

  /**
   * Returns the path from a given id
   * @ac game/Movement/Waypoints/WaypointMgr.h WaypointMgr::GetPath
   */
  getPath(id: number): WaypointPath | null {
    return this._waypointStore.get(id) ?? null;
  }
}

/** @ac game/Movement/Waypoints/WaypointMgr.h sWaypointMgr (`WaypointMgr::instance()`) */
export function sWaypointMgr(): WaypointMgr {
  return WaypointMgr.instance();
}
