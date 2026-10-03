/**
 * Port of `game/Movement/Waypoints/WaypointDefines.h`.
 *
 * `std::optional<float> Orientation` is `number | undefined` (`undefined` is `std::nullopt`).
 */
import { Vector3 } from "../../../math/Vector3.ts";

const fround = Math.fround;

/** @ac game/Movement/Waypoints/WaypointDefines.h WaypointMoveType */
export const WAYPOINT_MOVE_TYPE_WALK = 0;
export const WAYPOINT_MOVE_TYPE_RUN = 1;
export const WAYPOINT_MOVE_TYPE_LAND = 2;
export const WAYPOINT_MOVE_TYPE_TAKEOFF = 3;

export const WAYPOINT_MOVE_TYPE_MAX = 4;
export type WaypointMoveType = number;

/** @ac game/Movement/Waypoints/WaypointDefines.h WaypointNode */
export class WaypointNode {
  Id: number;
  X: number;
  Y: number;
  Z: number;
  Orientation: number | undefined;
  Velocity: number;
  Delay: number;
  EventId: number;
  MoveType: number;
  EventChance: number;
  SmoothTransition: boolean;
  SplinePoints: Vector3[] = [];

  /**
   * `WaypointNode()` (no arguments) and
   * `WaypointNode(uint32 id, float x, float y, float z, std::optional<float> orientation = { }, float velocity = 0.f,
   * uint32 delay = 0, bool smoothTransition = false)`. The two constructors differ in `MoveType` (RUN / WALK) and
   * `EventChance` (0 / 100).
   */
  constructor(id?: number, x?: number, y?: number, z?: number, orientation?: number, velocity = 0.0, delay = 0, smoothTransition = false) {
    if (id === undefined) {
      this.Id = 0;
      this.X = 0.0;
      this.Y = 0.0;
      this.Z = 0.0;
      this.Orientation = undefined;
      this.Velocity = 0.0;
      this.Delay = 0;
      this.EventId = 0;
      this.MoveType = WAYPOINT_MOVE_TYPE_RUN;
      this.EventChance = 0;
      this.SmoothTransition = false;
      return;
    }
    this.Id = id >>> 0;
    this.X = fround(x ?? 0);
    this.Y = fround(y ?? 0);
    this.Z = fround(z ?? 0);
    this.Orientation = orientation === undefined ? undefined : fround(orientation);
    this.Velocity = fround(velocity);
    this.Delay = delay >>> 0;
    this.SmoothTransition = smoothTransition;
    this.EventId = 0;
    this.MoveType = WAYPOINT_MOVE_TYPE_WALK;
    this.EventChance = 100;
  }
}

/** @ac game/Movement/Waypoints/WaypointDefines.h WaypointPath */
export class WaypointPath {
  Nodes: WaypointNode[];
  Id: number;

  /** `WaypointPath()` and `WaypointPath(uint32 _id, std::vector<WaypointNode>&& _nodes)` */
  constructor(_id = 0, _nodes: WaypointNode[] = []) {
    this.Id = _id >>> 0;
    this.Nodes = _nodes;
  }
}
