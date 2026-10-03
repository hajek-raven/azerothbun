/**
 * Port of `game/Movement/MovementGenerators/PathGenerator.{h,cpp}`: builds a movement path over the map's Detour
 * nav mesh (poly path with `findPath` / `raycast`, then a smooth or straight point path), or a two-point shortcut
 * when there is no nav mesh, no tile, or no polygon under the start or end.
 *
 * `WorldObject`, `Unit`, `Creature` and `Map` are ported by other streams, so this file takes the members it calls
 * through the narrow structural interfaces below (`PathSource`, `PathSourceUnit`, `PathSourceCreature`,
 * `PathSourceMap`, `PathSourceMMapData`), each annotated with the C++ method it stands for. The real objects satisfy
 * them as long as they keep the camelCase C++ names.
 *
 * Detour points are `Float32Array` in Detour's `(y, z, x)` order, exactly as the C++ passes `float[3]`. Positions
 * (`G3D::Vector3`) are `Vector3`; they are copied by value wherever the C++ copies them.
 */
import { dtVcopy, dtVdist, dtVdistSqr, dtVdot, dtVlerp, dtVmad, dtVsub } from "../../../common/Detour/DetourCommon.ts";
import { dtMathSqrtf } from "../../../common/Detour/DetourMath.ts";
import { DT_STRAIGHTPATH_END, DT_STRAIGHTPATH_OFFMESH_CONNECTION, type dtNavMesh, type dtPolyRef } from "../../../common/Detour/DetourNavMesh.ts";
import type { dtNavMeshQuery } from "../../../common/Detour/DetourNavMeshQuery.ts";
import { DT_FAILURE, DT_SLOPE_TOO_STEEP, DT_SUCCESS, type dtStatus, dtStatusFailed, dtStatusSucceed } from "../../../common/Detour/DetourStatus.ts";
import { NavTerrain } from "../../../common/Collision/Management/MMapDefines.ts";
import { dtQueryFilterExt } from "../../../common/Navigation/DetourExtended.ts";
import { getSlopeAngleAbs } from "../../../common/Utilities/Geometry.ts";
import { logDebug, logError } from "../../../log.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { IsValidMapCoord } from "../../Grids/GridDefines.ts";
import {
  LIQUID_MAP_NO_WATER,
  LIQUID_MAP_UNDER_WATER,
  MAP_LIQUID_STATUS_IN_CONTACT,
  MAP_LIQUID_TYPE_MAGMA,
  MAP_LIQUID_TYPE_OCEAN,
  MAP_LIQUID_TYPE_SLIME,
  MAP_LIQUID_TYPE_WATER,
} from "../../Grids/GridTerrainData.ts";
import { MAP_BLADES_EDGE_ARENA } from "../../Maps/AreaDefines.ts";
import type { PointsArray } from "../Spline/MoveSplineInitArgs.ts";

// 74*4.0f=296y number_of_points*interval = max_path_len
// this is way more than actual evade range
// I think we can safely cut those down even more
/** @ac game/Movement/MovementGenerators/PathGenerator.h MAX_PATH_LENGTH */
export const MAX_PATH_LENGTH = 74;
/** @ac game/Movement/MovementGenerators/PathGenerator.h MAX_POINT_PATH_LENGTH */
export const MAX_POINT_PATH_LENGTH = 74;

/** @ac game/Movement/MovementGenerators/PathGenerator.h SMOOTH_PATH_STEP_SIZE */
export const SMOOTH_PATH_STEP_SIZE = 4.0;
/** @ac game/Movement/MovementGenerators/PathGenerator.h SMOOTH_PATH_SLOP */
export const SMOOTH_PATH_SLOP = Math.fround(0.3);
/** secs @ac game/Movement/MovementGenerators/PathGenerator.h DISALLOW_TIME_AFTER_FAIL */
export const DISALLOW_TIME_AFTER_FAIL = 3;
/** @ac game/Movement/MovementGenerators/PathGenerator.h VERTEX_SIZE */
export const VERTEX_SIZE = 3;
/** @ac game/Movement/MovementGenerators/PathGenerator.h INVALID_POLYREF */
export const INVALID_POLYREF = 0;

/** `FLT_MAX` (`<cfloat>`). */
const FLT_MAX = 3.4028234663852886e38;

/** @ac game/Movement/MovementGenerators/PathGenerator.h PathType */
export const PathType = {
  PATHFIND_BLANK: 0x00, // path not built yet
  PATHFIND_NORMAL: 0x01, // normal path
  PATHFIND_SHORTCUT: 0x02, // travel through obstacles, terrain, air, etc (old behavior)
  PATHFIND_INCOMPLETE: 0x04, // we have partial path to follow - getting closer to target
  PATHFIND_NOPATH: 0x08, // no valid path at all or error in generating one
  PATHFIND_NOT_USING_PATH: 0x10, // used when we are either flying/swiming or on map w/o mmaps
  PATHFIND_SHORT: 0x20, // path is longer or equal to its limited path length
  PATHFIND_FARFROMPOLY_START: 0x40, // start position is far from the mmap poligon
  PATHFIND_FARFROMPOLY_END: 0x80, // end positions is far from the mmap poligon
  PATHFIND_FARFROMPOLY: 0x40 | 0x80, // start or end positions are far from the mmap poligon
} as const;
/** A combination of `PathType` bits (the C++ casts `PathType(a | b)`). */
export type PathType = number;
export const PATHFIND_BLANK = PathType.PATHFIND_BLANK;
export const PATHFIND_NORMAL = PathType.PATHFIND_NORMAL;
export const PATHFIND_SHORTCUT = PathType.PATHFIND_SHORTCUT;
export const PATHFIND_INCOMPLETE = PathType.PATHFIND_INCOMPLETE;
export const PATHFIND_NOPATH = PathType.PATHFIND_NOPATH;
export const PATHFIND_NOT_USING_PATH = PathType.PATHFIND_NOT_USING_PATH;
export const PATHFIND_SHORT = PathType.PATHFIND_SHORT;
export const PATHFIND_FARFROMPOLY_START = PathType.PATHFIND_FARFROMPOLY_START;
export const PATHFIND_FARFROMPOLY_END = PathType.PATHFIND_FARFROMPOLY_END;
export const PATHFIND_FARFROMPOLY = PathType.PATHFIND_FARFROMPOLY;

/** `Movement::PointsArray` is defined once, in `Spline/MoveSplineInitArgs.ts` (re-exported for the generators that import it from here). */
export type { PointsArray };

/** @ac game/Entities/Unit/UnitDefines.h UNIT_STATE_IGNORE_PATHFINDING */
export const UNIT_STATE_IGNORE_PATHFINDING = 0x10000000;
/** @ac game/Maps/Map.h LINEOFSIGHT_ALL_CHECKS (`LINEOFSIGHT_CHECK_VMAP | LINEOFSIGHT_CHECK_GOBJECT_ALL`) */
const LINEOFSIGHT_ALL_CHECKS = 0x1 | 0x2 | 0x4;
/** @ac common/Collision/Models/ModelIgnoreFlags.h VMAP::ModelIgnoreFlags::Nothing */
const MODEL_IGNORE_FLAGS_NOTHING = 0x00;

/** A `Position const&` argument / result (`PositionLike` in `Entities/Object/Position.ts`). */
export interface PathPosition {
  getPositionX(): number;
  getPositionY(): number;
  getPositionZ(): number;
  getOrientation(): number;
}

/** The `LiquidData` fields `PathGenerator` reads. @ac game/Grids/GridTerrainData.h LiquidData */
export interface PathLiquidData {
  Flags: number;
  Status: number;
}

/** @ac game/Maps/MapCollisionData.h MMapData (the members `PathGenerator` calls) */
export interface PathSourceMMapData {
  /** @ac game/Maps/MapCollisionData.h MMapData::GetNavMesh */
  getNavMesh(): dtNavMesh | null;
  /** @ac game/Maps/MapCollisionData.cpp MMapData::GetNavMeshQuery */
  getNavMeshQuery(): dtNavMeshQuery | null;
}

/** @ac game/Maps/Map.h Map (the members `PathGenerator` calls) */
export interface PathSourceMap {
  /** `GetMapCollisionData().GetMMapData()` @ac game/Maps/Map.h Map::GetMapCollisionData */
  getMapCollisionData(): { getMMapData(): PathSourceMMapData };
  /** `Optional<uint8> ReqLiquidType` is `null` for `{}`. @ac game/Maps/Map.cpp Map::GetLiquidData */
  getLiquidData(phaseMask: number, x: number, y: number, z: number, collisionHeight: number, reqLiquidType: number | null): PathLiquidData;
  /** @ac game/Maps/Map.cpp Map::IsInWater */
  isInWater(phaseMask: number, x: number, y: number, z: number, collisionHeight: number): boolean;
  /** @ac game/Maps/Map.cpp Map::isInLineOfSight */
  isInLineOfSight(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, phasemask: number, checks: number, ignoreFlags: number): boolean;
}

/** @ac game/Entities/Unit/Unit.h Unit (the members `PathGenerator` calls) */
export interface PathSourceUnit {
  /** @ac game/Entities/Unit/Unit.h Unit::HasUnitState */
  hasUnitState(state: number): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::CanSwim (virtual; `Creature::CanSwim` overrides it) */
  canSwim(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::CanFly (virtual; `Creature::CanFly` overrides it) */
  canFly(): boolean;
  /** @ac game/Entities/Unit/Unit.cpp Unit::IsFalling */
  isFalling(): boolean;
  /** @ac game/Entities/Unit/Unit.cpp Unit::IsInWater */
  isInWater(): boolean;
  /** @ac game/Entities/Unit/Unit.cpp Unit::IsUnderWater */
  isUnderWater(): boolean;
}

/** @ac game/Entities/Creature/Creature.h Creature (the members `PathGenerator` calls) */
export interface PathSourceCreature extends PathSourceUnit {
  /** @ac game/Entities/Creature/Creature.h Creature::CanWalk */
  canWalk(): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::CanEnterWater */
  canEnterWater(): boolean;
}

/** @ac game/Entities/Object/Object.h WorldObject (the members `PathGenerator` calls on `_source`) */
export interface PathSource {
  /** @ac game/Entities/Object/Object.h WorldObject::GetMap */
  getMap(): PathSourceMap;
  /** @ac game/Entities/Object/Object.h WorldLocation::GetMapId */
  getMapId(): number;
  /** @ac game/Entities/Object/Object.h WorldObject::GetPhaseMask */
  getPhaseMask(): number;
  /** @ac game/Entities/Object/Position.h Position::GetPositionX */
  getPositionX(): number;
  /** @ac game/Entities/Object/Position.h Position::GetPositionY */
  getPositionY(): number;
  /** @ac game/Entities/Object/Position.h Position::GetPositionZ */
  getPositionZ(): number;
  /** @ac game/Entities/Object/Object.h WorldObject::GetCollisionHeight */
  getCollisionHeight(): number;
  /** @ac game/Entities/Object/Object.h Object::GetGUID */
  getGUID(): bigint;
  /** @ac game/Entities/Object/Object.h Object::IsCreature */
  isCreature(): boolean;
  /** @ac game/Entities/Object/Object.h Object::ToUnit */
  toUnit(): PathSourceUnit | null;
  /** @ac game/Entities/Object/Object.h Object::ToCreature */
  toCreature(): PathSourceCreature | null;
  /** The `float& z` in-out parameter is the return value. @ac game/Entities/Object/Object.cpp WorldObject::UpdateAllowedPositionZ */
  updateAllowedPositionZ(x: number, y: number, z: number): number;
  /** The `float& x, y, z` out parameters are the returned position. @ac game/Entities/Object/Object.cpp WorldObject::GetHitSpherePointFor */
  getHitSpherePointFor(dest: PathPosition): PathPosition;
}

/** A `float*` / `float&` out parameter. */
export type FloatOut = { value: number };

// Blades Edge Arena Ropes normalization
/** @ac game/Movement/MovementGenerators/PathGenerator.cpp BLADE_EDGE_ROPE_SNAP_DIST */
const BLADE_EDGE_ROPE_SNAP_DIST = Math.fround(1.5);
/** @ac game/Movement/MovementGenerators/PathGenerator.cpp BLADE_EDGE_ROPE_SNAP_DIST2 */
const BLADE_EDGE_ROPE_SNAP_DIST2 = BLADE_EDGE_ROPE_SNAP_DIST * BLADE_EDGE_ROPE_SNAP_DIST;

/** @ac game/Movement/MovementGenerators/PathGenerator.cpp BladeEdgeArenaRope */
interface BladeEdgeArenaRope {
  Start: Vector3;
  End: Vector3;
  Sag: number;
}

const F = Math.fround;

/** @ac game/Movement/MovementGenerators/PathGenerator.cpp BladeEdgeArenaRopes */
const BladeEdgeArenaRopes: readonly BladeEdgeArenaRope[] = [
  {
    Start: new Vector3(F(6243.1523), F(267.53094), F(10.929295)),
    End: new Vector3(F(6245.9717), F(271.29346), F(10.879172)),
    Sag: F(0.43),
  },
  {
    Start: new Vector3(F(6234.3213), F(256.29733), F(11.002348)),
    End: new Vector3(F(6231.3247), F(252.58781), F(10.976968)),
    Sag: F(0.46),
  },
];

/** @ac game/Movement/MovementGenerators/PathGenerator.cpp IsOutsideExpandedXYBounds */
function IsOutsideExpandedXYBounds(point: Vector3, rope: BladeEdgeArenaRope): boolean {
  const minX = Math.min(rope.Start.x, rope.End.x) - BLADE_EDGE_ROPE_SNAP_DIST;
  const maxX = Math.max(rope.Start.x, rope.End.x) + BLADE_EDGE_ROPE_SNAP_DIST;
  const minY = Math.min(rope.Start.y, rope.End.y) - BLADE_EDGE_ROPE_SNAP_DIST;
  const maxY = Math.max(rope.Start.y, rope.End.y) + BLADE_EDGE_ROPE_SNAP_DIST;

  return point.x < minX || point.x > maxX || point.y < minY || point.y > maxY;
}

/** @ac game/Movement/MovementGenerators/PathGenerator.cpp GetClosestPointOnBladeEdgeArenaRope */
function GetClosestPointOnBladeEdgeArenaRope(point: Vector3, rope: BladeEdgeArenaRope, closestPoint: Vector3): boolean {
  const ropeVector = rope.End.minus(rope.Start);

  const ropeLength2XY = ropeVector.x * ropeVector.x + ropeVector.y * ropeVector.y;
  if (ropeLength2XY < 0.00001) return false;

  const pointVector = point.minus(rope.Start);

  let t = (pointVector.x * ropeVector.x + pointVector.y * ropeVector.y) / ropeLength2XY;
  t = Math.min(Math.max(t, 0.0), 1.0);

  const closestX = rope.Start.x + ropeVector.x * t;
  const closestY = rope.Start.y + ropeVector.y * t;

  const dx = point.x - closestX;
  const dy = point.y - closestY;

  // If the point is already too far in XY, it cannot be within the 3D snap radius.
  if (dx * dx + dy * dy >= BLADE_EDGE_ROPE_SNAP_DIST2) return false;

  const linearZ = rope.Start.z + (rope.End.z - rope.Start.z) * t;
  const sagZ = rope.Sag * Math.sin(Math.PI * t);

  closestPoint.set(closestX, closestY, linearZ - sagZ);
  return true;
}

/** @ac game/Movement/MovementGenerators/PathGenerator.cpp TrySnapToBladeEdgeArenaRope */
export function TrySnapToBladeEdgeArenaRope(point: Vector3): boolean {
  let snapped = false;
  let bestDist2 = BLADE_EDGE_ROPE_SNAP_DIST2;
  const bestPoint = new Vector3();

  for (const rope of BladeEdgeArenaRopes) {
    if (IsOutsideExpandedXYBounds(point, rope)) continue;

    const closestPoint = new Vector3();
    if (!GetClosestPointOnBladeEdgeArenaRope(point, rope, closestPoint)) continue;

    const dist2 = point.minus(closestPoint).squaredMagnitude();
    if (dist2 < bestDist2) {
      bestDist2 = dist2;
      bestPoint.copy(closestPoint);
      snapped = true;
    }
  }

  if (snapped) point.copy(bestPoint);

  return snapped;
}

/** The scratch out parameter of `findPath`, `raycast`, `findStraightPath` and `moveAlongSurface` (`int*`). */
function intOut(): Int32Array {
  return new Int32Array(1);
}

/** ////////////////// PathGenerator ////////////////// @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator */
export class PathGenerator {
  private readonly _pathPolyRefs = new Float64Array(MAX_PATH_LENGTH); // array of detour polygon references
  private _polyLength = 0; // number of polygons in the path

  private _pathPoints: PointsArray = []; // our actual (x,y,z) path to the target
  private _type: PathType = PATHFIND_BLANK; // tells what kind of path this is

  private _useStraightPath = false; // type of path will be generated (do not use it for movement paths)
  private _forceDestination = false; // when set, we will always arrive at given point
  private _slopeCheck = false; // when set, it skips paths with too high slopes (doesn't work with _useStraightPath)
  private _pointPathLimit = MAX_POINT_PATH_LENGTH; // limit point path size; min(this, MAX_POINT_PATH_LENGTH)
  private _useRaycast = false; // use raycast if true for a straight line path

  private _startPosition = new Vector3(); // {x, y, z} of current location
  private _endPosition = Vector3.zero(); // {x, y, z} of the destination
  private _actualEndPosition = new Vector3(); // {x, y, z} of the closest possible point to given destination

  private readonly _source: PathSource; // the object that is moving
  private _navMesh: dtNavMesh | null = null; // the nav mesh
  private _navMeshQuery: dtNavMeshQuery | null = null; // the nav mesh query used to find the path

  private readonly _filter = new dtQueryFilterExt(); // use single filter for all movements, update it when needed

  // Scratch buffers (the C++ stack arrays), reused so a path build allocates no Detour arrays.
  private readonly _closestPoint = new Float32Array(VERTEX_SIZE);
  private readonly _extents = new Float32Array(VERTEX_SIZE);
  private readonly _nearestRef = new Float64Array(1);
  private readonly _pathCount = intOut();
  private readonly _tileLoc = new Int32Array(2);
  private readonly _steerPath = new Float32Array(3 * VERTEX_SIZE);
  private readonly _steerPathFlags = new Uint8Array(3);
  private readonly _steerPathPolys = new Float64Array(3);
  private readonly _nsteerPath = intOut();

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::PathGenerator */
  constructor(owner: PathSource) {
    this._source = owner;

    //if (sDisableMgr->IsPathfindingEnabled(_sourceUnit->FindMap()))
    {
      this._navMesh = this._source.getMap().getMapCollisionData().getMMapData().getNavMesh();
      this._navMeshQuery = this._source.getMap().getMapCollisionData().getMMapData().getNavMeshQuery();
    }

    this.createFilter();
  }

  /**
   * Calculate the path from owner to given destination.
   * return: true if new path was calculated, false otherwise (no change needed)
   * @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::CalculatePath
   */
  calculatePath(destX: number, destY: number, destZ: number, forceDest?: boolean): boolean;
  calculatePath(x: number, y: number, z: number, destX: number, destY: number, destZ: number, forceDest: boolean): boolean;
  calculatePath(a: number, b: number, c: number, d?: number | boolean, e?: number, f?: number, g?: boolean): boolean {
    if (e === undefined || f === undefined) {
      const x = this._source.getPositionX();
      const y = this._source.getPositionY();
      const z = this._source.getPositionZ();
      return this.calculatePathFrom(x, y, z, a, b, c, d === true);
    }
    return this.calculatePathFrom(a, b, c, d as number, e, f, g ?? false);
  }

  /** The `(x, y, z, destX, destY, destZ, forceDest)` overload. @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::CalculatePath */
  private calculatePathFrom(x: number, y: number, z: number, destX: number, destY: number, destZ: number, forceDest: boolean): boolean {
    if (!IsValidMapCoord(destX, destY, destZ) || !IsValidMapCoord(x, y, z)) return false;

    // METRIC_DETAILED_EVENT("mmap_events", "CalculatePath", "") - metrics are not ported

    const dest = new Vector3(destX, destY, destZ);
    this.setEndPosition(dest);

    const start = new Vector3(x, y, z);
    this.setStartPosition(start);

    this._forceDestination = forceDest;

    // make sure navMesh works - we can run on map w/o mmap
    // check if the start and end point have a .mmtile loaded (can we pass via not loaded tile on the way?)
    const _sourceUnit = this._source.toUnit();
    if (
      !this._navMesh ||
      !this._navMeshQuery ||
      (_sourceUnit && _sourceUnit.hasUnitState(UNIT_STATE_IGNORE_PATHFINDING)) ||
      !this.haveTile(start) ||
      !this.haveTile(dest)
    ) {
      this.buildShortcut();
      this._type = PATHFIND_NORMAL | PATHFIND_NOT_USING_PATH;
      return true;
    }

    this.updateFilter();

    this.buildPolyPath(start, dest);
    return true;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::IsInvalidDestinationZ */
  isInvalidDestinationZ(target: { getPositionZ(): number }): boolean {
    return target.getPositionZ() - this.getActualEndPosition().z > 5.0;
  }

  // option setters - use optional

  /** when set, it skips paths with too high slopes (doesn't work with StraightPath enabled) @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::SetSlopeCheck */
  setSlopeCheck(checkSlope: boolean): void {
    this._slopeCheck = checkSlope;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::SetUseStraightPath */
  setUseStraightPath(useStraightPath: boolean): void {
    this._useStraightPath = useStraightPath;
  }

  /** `std::min<uint32>(uint32(distance / SMOOTH_PATH_STEP_SIZE), MAX_POINT_PATH_LENGTH)` @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::SetPathLengthLimit */
  setPathLengthLimit(distance: number): void {
    this._pointPathLimit = Math.min(Math.trunc(distance / SMOOTH_PATH_STEP_SIZE) >>> 0, MAX_POINT_PATH_LENGTH);
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::SetUseRaycast */
  setUseRaycast(useRaycast: boolean): void {
    this._useRaycast = useRaycast;
  }

  // result getters

  /** @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::GetStartPosition */
  getStartPosition(): Vector3 {
    return this._startPosition;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::GetEndPosition */
  getEndPosition(): Vector3 {
    return this._endPosition;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::GetActualEndPosition */
  getActualEndPosition(): Vector3 {
    return this._actualEndPosition;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::GetPath */
  getPath(): readonly Vector3[] {
    return this._pathPoints;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::GetPathType */
  getPathType(): PathType {
    return this._type;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::getPathLength */
  getPathLength(): number {
    let len = 0.0;
    let dx: number;
    let dy: number;
    let dz: number;
    const size = this._pathPoints.length;
    if (size) {
      dx = this._pathPoints[0]!.x - this._startPosition.x;
      dy = this._pathPoints[0]!.y - this._startPosition.y;
      dz = this._pathPoints[0]!.z - this._startPosition.z;
      len += Math.sqrt(dx * dx + dy * dy + dz * dz);
    } else {
      return len;
    }

    for (let i = 1; i < size; ++i) {
      dx = this._pathPoints[i]!.x - this._pathPoints[i - 1]!.x;
      dy = this._pathPoints[i]!.y - this._pathPoints[i - 1]!.y;
      dz = this._pathPoints[i]!.z - this._pathPoints[i - 1]!.z;
      len += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return len;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::Clear */
  clear(): void {
    this._polyLength = 0;
    this._pathPoints.length = 0;
  }

  /** `G3D::Vector3` is copied by value. @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::SetStartPosition */
  private setStartPosition(point: Vector3): void {
    this._startPosition = point.clone();
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::SetEndPosition */
  private setEndPosition(point: Vector3): void {
    this._actualEndPosition = point.clone();
    this._endPosition = point.clone();
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.h PathGenerator::SetActualEndPosition */
  private setActualEndPosition(point: Vector3): void {
    this._actualEndPosition = point.clone();
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::GetPathPolyByPosition */
  private getPathPolyByPosition(polyPath: Float64Array | null, polyPathSize: number, point: Float32Array, distance: FloatOut | null = null): dtPolyRef {
    if (!polyPath || !polyPathSize) return INVALID_POLYREF;

    let nearestPoly: dtPolyRef = INVALID_POLYREF;
    let minDist = FLT_MAX;

    const closestPoint = this._closestPoint;
    for (let i = 0; i < polyPathSize; ++i) {
      if (dtStatusFailed(this._navMeshQuery!.closestPointOnPoly(polyPath[i]!, point, closestPoint, null))) continue;

      const d = dtVdistSqr(point, 0, closestPoint, 0);
      if (d < minDist) {
        minDist = d;
        nearestPoly = polyPath[i]!;
      }

      if (minDist < 1.0) {
        // shortcut out - close enough for us
        break;
      }
    }

    if (distance) {
      distance.value = dtMathSqrtf(minDist);
    }

    return minDist < 3.0 ? nearestPoly : INVALID_POLYREF;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::GetPolyByLocation */
  private getPolyByLocation(point: Float32Array, distance: FloatOut): dtPolyRef {
    // first we check the current path
    // if the current path doesn't contain the current poly,
    // we need to use the expensive navMesh.findNearestPoly
    let polyRef = this.getPathPolyByPosition(this._pathPolyRefs, this._polyLength, point, distance);
    if (polyRef !== INVALID_POLYREF) return polyRef;

    // we don't have it in our old path
    // try to get it by findNearestPoly()
    // first try with low search box
    const extents = this._extents; // bounds of poly search area
    extents[0] = 3.0;
    extents[1] = 5.0;
    extents[2] = 3.0;
    const closestPoint = this._closestPoint;
    closestPoint.fill(0);
    const ref = this._nearestRef;
    ref[0] = polyRef;
    if (dtStatusSucceed(this._navMeshQuery!.findNearestPoly(point, extents, this._filter, ref, closestPoint)) && ref[0] !== INVALID_POLYREF) {
      distance.value = dtVdist(closestPoint, 0, point, 0);
      return ref[0]!;
    }

    // still nothing ..
    // try with bigger search box
    // Note that the extent should not overlap more than 128 polygons in the navmesh (see dtNavMeshQuery::findNearestPoly)
    extents[1] = 50.0;

    if (dtStatusSucceed(this._navMeshQuery!.findNearestPoly(point, extents, this._filter, ref, closestPoint)) && ref[0] !== INVALID_POLYREF) {
      distance.value = dtVdist(closestPoint, 0, point, 0);
      return ref[0]!;
    }

    polyRef = INVALID_POLYREF;
    distance.value = FLT_MAX;
    return polyRef;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::BuildPolyPath */
  private buildPolyPath(startPos: Vector3, endPos: Vector3): void {
    // *** getting start/end poly logic ***

    const distToStartPoly: FloatOut = { value: 0 };
    const distToEndPoly: FloatOut = { value: 0 };
    const startPoint = new Float32Array([startPos.y, startPos.z, startPos.x]);
    const endPoint = new Float32Array([endPos.y, endPos.z, endPos.x]);

    const startPoly = this.getPolyByLocation(startPoint, distToStartPoly);
    const endPoly = this.getPolyByLocation(endPoint, distToEndPoly);

    this._type = PATHFIND_NORMAL;

    const creature = this._source.toCreature();

    // we have a hole in our mesh
    // make shortcut path and mark it as NOPATH ( with flying and swimming exception )
    // its up to caller how he will use this info
    if (startPoly === INVALID_POLYREF || endPoly === INVALID_POLYREF) {
      this.buildShortcut();

      const canSwim = creature ? creature.canSwim() : true;
      const path = creature ? creature.canFly() : true;
      const waterPath = this.isWaterPath(this._pathPoints);
      if (path || (waterPath && canSwim)) {
        this._type = PATHFIND_NORMAL | PATHFIND_NOT_USING_PATH;
        return;
      }

      // raycast doesn't need endPoly to be valid
      if (!this._useRaycast) {
        this._type = PATHFIND_NOPATH;
        return;
      }
    }

    // we may need a better number here
    const startFarFromPoly = distToStartPoly.value > 7.0;
    const endFarFromPoly = distToEndPoly.value > 7.0;

    // create a shortcut if the path begins or end too far
    // away from the desired path points.
    // swimming creatures should not use a shortcut
    // because exiting the water must be done following a proper path
    // we just need to remove/normalize paths between 2 adjacent points
    if (startFarFromPoly || endFarFromPoly) {
      let buildShortcut = false;

      const map = this._source.getMap();
      const liquidDataStart = map.getLiquidData(this._source.getPhaseMask(), startPos.x, startPos.y, startPos.z, this._source.getCollisionHeight(), null);
      const liquidDataEnd = map.getLiquidData(this._source.getPhaseMask(), endPos.x, endPos.y, endPos.z, this._source.getCollisionHeight(), null);

      const startUnderWaterEndInWater = liquidDataStart.Status === LIQUID_MAP_UNDER_WATER && (liquidDataEnd.Status & MAP_LIQUID_STATUS_IN_CONTACT) !== 0;
      const startInWaterEndUnderWater = (liquidDataStart.Status & MAP_LIQUID_STATUS_IN_CONTACT) !== 0 && liquidDataEnd.Status === LIQUID_MAP_UNDER_WATER;
      const waterPath = startUnderWaterEndInWater || startInWaterEndUnderWater;
      const _sourceUnit = this._source.toUnit();

      if (_sourceUnit) {
        const isWater = _sourceUnit.canSwim() && waterPath;

        if (isWater || _sourceUnit.canFly() || (_sourceUnit.isFalling() && endPos.z < startPos.z)) {
          buildShortcut = true;
        }
      }

      if (buildShortcut) {
        this.buildShortcut();
        this._type = PATHFIND_NORMAL | PATHFIND_NOT_USING_PATH;

        this.addFarFromPolyFlags(startFarFromPoly, endFarFromPoly);

        return;
      } else {
        const closestPoint = new Float32Array(VERTEX_SIZE);
        // we may want to use closestPointOnPolyBoundary instead
        if (dtStatusSucceed(this._navMeshQuery!.closestPointOnPoly(endPoly, endPoint, closestPoint, null))) {
          dtVcopy(endPoint, 0, closestPoint, 0);
          this.setActualEndPosition(new Vector3(endPoint[2]!, endPoint[0]!, endPoint[1]!));
        }

        this._type = PATHFIND_INCOMPLETE;

        this.addFarFromPolyFlags(startFarFromPoly, endFarFromPoly);
      }
    }

    // *** poly path generating logic ***

    // start and end are on same polygon
    // handle this case as if they were 2 different polygons, building a line path split in some few points
    if (startPoly === endPoly && !this._useRaycast) {
      this._pathPolyRefs[0] = startPoly;
      this._polyLength = 1;

      if (startFarFromPoly || endFarFromPoly) {
        this._type = PATHFIND_INCOMPLETE;

        this.addFarFromPolyFlags(startFarFromPoly, endFarFromPoly);
      } else {
        this._type = PATHFIND_NORMAL;
      }

      this.buildPointPath(startPoint, endPoint);
      return;
    }

    // look for startPoly/endPoly in current path
    /// @todo we can merge it with getPathPolyByPosition() loop
    let startPolyFound = false;
    let endPolyFound = false;
    let pathStartIndex = 0;
    let pathEndIndex = 0;

    if (this._polyLength) {
      for (; pathStartIndex < this._polyLength; ++pathStartIndex) {
        // here to catch few bugs
        if (this._pathPolyRefs[pathStartIndex] === INVALID_POLYREF) {
          break;
        }

        if (this._pathPolyRefs[pathStartIndex] === startPoly) {
          startPolyFound = true;
          break;
        }
      }

      for (pathEndIndex = this._polyLength - 1; pathEndIndex > pathStartIndex; --pathEndIndex) {
        if (this._pathPolyRefs[pathEndIndex] === endPoly) {
          endPolyFound = true;
          break;
        }
      }
    }

    const pathCount = this._pathCount;
    if (startPolyFound && endPolyFound) {
      // we moved along the path and the target did not move out of our old poly-path
      // our path is a simple subpath case, we have all the data we need
      // just "cut" it out

      this._polyLength = pathEndIndex - pathStartIndex + 1;
      this._pathPolyRefs.copyWithin(0, pathStartIndex, pathStartIndex + this._polyLength);
    } else if (startPolyFound && !endPolyFound) {
      // we are moving on the old path but target moved out
      // so we have atleast part of poly-path ready

      this._polyLength -= pathStartIndex;

      // try to adjust the suffix of the path instead of recalculating entire length
      // at given interval the target cannot get too far from its last location
      // thus we have less poly to cover
      // sub-path of optimal path is optimal

      // take ~80% of the original length
      /// @todo play with the values here
      let prefixPolyLength = Math.trunc(Math.fround(this._polyLength * Math.fround(0.8)) + 0.5);
      this._pathPolyRefs.copyWithin(0, pathStartIndex, pathStartIndex + prefixPolyLength);

      let suffixStartPoly: dtPolyRef = this._pathPolyRefs[prefixPolyLength - 1] ?? INVALID_POLYREF;

      // we need any point on our suffix start poly to generate poly-path, so we need last poly in prefix data
      const suffixEndPoint = new Float32Array(VERTEX_SIZE);
      if (dtStatusFailed(this._navMeshQuery!.closestPointOnPoly(suffixStartPoly, endPoint, suffixEndPoint, null))) {
        // we can hit offmesh connection as last poly - closestPointOnPoly() don't like that
        // try to recover by using prev polyref
        --prefixPolyLength;
        suffixStartPoly = this._pathPolyRefs[prefixPolyLength - 1] ?? INVALID_POLYREF;
        if (dtStatusFailed(this._navMeshQuery!.closestPointOnPoly(suffixStartPoly, endPoint, suffixEndPoint, null))) {
          // suffixStartPoly is still invalid, error state
          this.buildShortcut();
          this._type = PATHFIND_NOPATH;
          return;
        }
      }

      // generate suffix
      let suffixPolyLength = 0;

      let dtResult: dtStatus;
      if (this._useRaycast) {
        this.buildShortcut();
        this._type = PATHFIND_NOPATH;
        return;
      } else {
        pathCount[0] = 0;
        dtResult = this._navMeshQuery!.findPath(
          suffixStartPoly, // start polygon
          endPoly, // end polygon
          suffixEndPoint, // start position
          endPoint, // end position
          this._filter, // polygon search filter
          this._pathPolyRefs.subarray(prefixPolyLength - 1), // [out] path
          pathCount,
          MAX_PATH_LENGTH - prefixPolyLength, // max number of polygons in output path
        );
        suffixPolyLength = pathCount[0]!;
      }

      if (!suffixPolyLength || dtStatusFailed(dtResult)) {
        // this is probably an error state, but we'll leave it
        // and hopefully recover on the next Update
        // we still need to copy our preffix
        logError("movement", `PathGenerator::BuildPolyPath: Path Build failed ${this._source.getGUID()}`);
      }

      // new path = prefix + suffix - overlap
      this._polyLength = prefixPolyLength + suffixPolyLength - 1;
    } else {
      // either we have no path at all -> first run
      // or something went really wrong -> we aren't moving along the path to the target
      // just generate new path

      // free and invalidate old path data
      this.clear();

      let dtResult: dtStatus;
      if (this._useRaycast) {
        const hit = new Float32Array(1);
        const hitNormal = new Float32Array(3);

        pathCount[0] = 0;
        dtResult = this._navMeshQuery!.raycast(startPoly, startPoint, endPoint, this._filter, hit, hitNormal, this._pathPolyRefs, pathCount, MAX_PATH_LENGTH);
        this._polyLength = pathCount[0]!;

        if (!this._polyLength || dtStatusFailed(dtResult)) {
          this.buildShortcut();
          this._type = PATHFIND_NOPATH;
          this.addFarFromPolyFlags(startFarFromPoly, endFarFromPoly);
          return;
        }

        // raycast() sets hit to FLT_MAX if there is a ray between start and end
        if (hit[0] !== FLT_MAX) {
          const hitPos = new Float32Array(3);

          // Walk back a bit from the hit point to make sure it's in the mesh (sometimes the point is actually outside of the polygons due to float precision issues)
          hit[0] = hit[0]! * Math.fround(0.99);
          dtVlerp(hitPos, 0, startPoint, 0, endPoint, 0, hit[0]!);

          // if it fails again, clamp to poly boundary
          const lastRef = this._pathPolyRefs[this._polyLength - 1]!;
          if (dtStatusFailed(this._navMeshQuery!.getPolyHeight(lastRef, hitPos, hitPos, 1))) {
            this._navMeshQuery!.closestPointOnPolyBoundary(lastRef, hitPos, hitPos);
          }

          this._pathPoints.length = 2;
          this._pathPoints[0] = this.getStartPosition().clone();
          this._pathPoints[1] = new Vector3(hitPos[2]!, hitPos[0]!, hitPos[1]!);

          this.normalizePath();
          this._type = PATHFIND_INCOMPLETE;
          this.addFarFromPolyFlags(startFarFromPoly, false);
          return;
        } else {
          // clamp to poly boundary if we fail to get the height
          const lastRef = this._pathPolyRefs[this._polyLength - 1]!;
          if (dtStatusFailed(this._navMeshQuery!.getPolyHeight(lastRef, endPoint, endPoint, 1))) {
            this._navMeshQuery!.closestPointOnPolyBoundary(lastRef, endPoint, endPoint);
          }

          this._pathPoints.length = 2;
          this._pathPoints[0] = this.getStartPosition().clone();
          this._pathPoints[1] = new Vector3(endPoint[2]!, endPoint[0]!, endPoint[1]!);

          this.normalizePath();
          if (startFarFromPoly || endFarFromPoly) {
            this._type = PATHFIND_INCOMPLETE;

            this.addFarFromPolyFlags(startFarFromPoly, endFarFromPoly);
          } else {
            this._type = PATHFIND_NORMAL;
          }
          return;
        }
      } else {
        pathCount[0] = 0;
        dtResult = this._navMeshQuery!.findPath(
          startPoly, // start polygon
          endPoly, // end polygon
          startPoint, // start position
          endPoint, // end position
          this._filter, // polygon search filter
          this._pathPolyRefs, // [out] path
          pathCount,
          MAX_PATH_LENGTH, // max number of polygons in output path
        );
        this._polyLength = pathCount[0]!;
      }

      if (!this._polyLength || dtStatusFailed(dtResult)) {
        // only happens if we passed bad data to findPath(), or navmesh is messed up
        logError("movement", `PathGenerator::BuildPolyPath: ${this._source.getGUID()} Path Build failed: 0 length path`);
        this.buildShortcut();
        this._type = PATHFIND_NOPATH;
        return;
      }
    }

    if (!this._polyLength) {
      logError("movement", `PathGenerator::BuildPolyPath: ${this._source.getGUID()} Path Build failed: 0 length path`);
      this.buildShortcut();
      this._type = PATHFIND_NOPATH;
      return;
    }

    // by now we know what type of path we can get
    if (this._pathPolyRefs[this._polyLength - 1] === endPoly && !(this._type & PATHFIND_INCOMPLETE)) {
      this._type = PATHFIND_NORMAL;
    } else {
      this._type = PATHFIND_INCOMPLETE;
    }

    this.addFarFromPolyFlags(startFarFromPoly, endFarFromPoly);

    // generate the point-path out of our up-to-date poly-path
    this.buildPointPath(startPoint, endPoint);
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::BuildPointPath */
  private buildPointPath(startPoint: Float32Array, endPoint: Float32Array): void {
    const pathPoints = new Float32Array(MAX_POINT_PATH_LENGTH * VERTEX_SIZE);
    const pointCountOut = intOut();
    let dtResult: dtStatus = DT_FAILURE;
    if (this._useRaycast) {
      // _straightLine uses raycast and it currently doesn't support building a point path, only a 2-point path with start and hitpoint/end is returned
      logError("movement", `PathGenerator::BuildPointPath() called with _useRaycast for unit ${this._source.getGUID()}`);
      this.buildShortcut();
      this._type = PATHFIND_NOPATH;
      return;
    } else if (this._useStraightPath) {
      dtResult = this._navMeshQuery!.findStraightPath(
        startPoint, // start position
        endPoint, // end position
        this._pathPolyRefs, // current path
        this._polyLength, // lenth of current path
        pathPoints, // [out] path corner points
        null, // [out] flags
        null, // [out] shortened path
        pointCountOut,
        this._pointPathLimit, // maximum number of points/polygons to use
      );
    } else {
      dtResult = this.findSmoothPath(
        startPoint, // start position
        endPoint, // end position
        this._pathPolyRefs, // current path
        this._polyLength, // length of current path
        pathPoints, // [out] path corner points
        pointCountOut,
        this._pointPathLimit, // maximum number of points
      );
    }
    let pointCount = pointCountOut[0]!;

    // Special case with start and end positions very close to each other
    if (this._polyLength === 1 && pointCount === 1 && !(dtResult & DT_SLOPE_TOO_STEEP)) {
      // First point is start position, append end position
      dtVcopy(pathPoints, 1 * VERTEX_SIZE, endPoint, 0);
      pointCount++;
    } else if (pointCount < 2 || dtStatusFailed(dtResult)) {
      // If its too steep, just return incomplete path.
      if (pointCount > 0 && dtResult & DT_SLOPE_TOO_STEEP) {
        this._pathPoints.length = pointCount;
        for (let i = 0; i < pointCount; ++i) {
          this._pathPoints[i] = new Vector3(pathPoints[i * VERTEX_SIZE + 2]!, pathPoints[i * VERTEX_SIZE]!, pathPoints[i * VERTEX_SIZE + 1]!);
        }

        this.normalizePath();

        // first point is always our current location - we need the next one
        this.setActualEndPosition(this._pathPoints[pointCount - 1]!);

        this._type = this._type | PATHFIND_INCOMPLETE;
        return;
      }

      // only happens if pass bad data to findStraightPath or navmesh is broken
      // single point paths can be generated here
      /// @todo check the exact cases
      this.buildShortcut();
      this._type = this._type | PATHFIND_NOPATH;
      return;
    } else if (pointCount >= this._pointPathLimit) {
      this.buildShortcut();
      this._type = this._type | PATHFIND_SHORT;
      return;
    }

    this._pathPoints.length = pointCount;
    for (let i = 0; i < pointCount; ++i) {
      this._pathPoints[i] = new Vector3(pathPoints[i * VERTEX_SIZE + 2]!, pathPoints[i * VERTEX_SIZE]!, pathPoints[i * VERTEX_SIZE + 1]!);
    }

    this.normalizePath();

    // first point is always our current location - we need the next one
    this.setActualEndPosition(this._pathPoints[pointCount - 1]!);

    // force the given destination, if needed
    if (this._forceDestination && (!(this._type & PATHFIND_NORMAL) || !this.inRange(this.getEndPosition(), this.getActualEndPosition(), 1.0, 1.0))) {
      // we may want to keep partial subpath
      if (this.dist3DSqr(this.getActualEndPosition(), this.getEndPosition()) < Math.fround(0.3) * this.dist3DSqr(this.getStartPosition(), this.getEndPosition())) {
        this.setActualEndPosition(this.getEndPosition());
        this._pathPoints[this._pathPoints.length - 1] = this.getEndPosition().clone();
      } else {
        this.setActualEndPosition(this.getEndPosition());
        this.buildShortcut();
      }

      this._type = PATHFIND_NORMAL | PATHFIND_NOT_USING_PATH;
    }
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::NormalizePath */
  private normalizePath(): void {
    const snapBladeEdgeArenaRopes = this._source.getMapId() === MAP_BLADES_EDGE_ARENA;
    for (const point of this._pathPoints) {
      if (snapBladeEdgeArenaRopes && TrySnapToBladeEdgeArenaRope(point)) continue;

      point.z = this._source.updateAllowedPositionZ(point.x, point.y, point.z);
    }
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::BuildShortcut */
  private buildShortcut(): void {
    this.clear();

    // make two point path, our curr pos is the start, and dest is the end
    this._pathPoints.length = 2;

    // set start and a default next position
    this._pathPoints[0] = this.getStartPosition().clone();
    this._pathPoints[1] = this.getActualEndPosition().clone();

    this.normalizePath();

    this._type = PATHFIND_SHORTCUT;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::CreateFilter */
  private createFilter(): void {
    let includeFlags = 0;
    const excludeFlags = 0;

    if (this._source.isCreature()) {
      const creature = this._source.toCreature()!;
      if (creature.canWalk()) includeFlags |= NavTerrain.NAV_GROUND; // walk

      // creatures don't take environmental damage
      if (creature.canEnterWater()) includeFlags |= NavTerrain.NAV_WATER | NavTerrain.NAV_MAGMA;
    } else {
      // assume Player
      // perfect support not possible, just stay 'safe'
      includeFlags |= NavTerrain.NAV_GROUND | NavTerrain.NAV_WATER | NavTerrain.NAV_MAGMA;
    }

    this._filter.setIncludeFlags(includeFlags);
    this._filter.setExcludeFlags(excludeFlags);

    this.updateFilter();
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::UpdateFilter */
  private updateFilter(): void {
    // allow creatures to cheat and use different movement types if they are moved
    // forcefully into terrain they can't normally move in
    const _sourceUnit = this._source.toUnit();
    if (_sourceUnit) {
      if (_sourceUnit.isInWater() || _sourceUnit.isUnderWater()) {
        let includedFlags = this._filter.getIncludeFlags();
        includedFlags |= this.getNavTerrain(this._source.getPositionX(), this._source.getPositionY(), this._source.getPositionZ());

        this._filter.setIncludeFlags(includedFlags & 0xffff);
      }

      /*if (Creature const* _sourceCreature = _source->ToCreature())
          if (_sourceCreature->IsInCombat() || _sourceCreature->IsInEvadeMode())
              _filter.setIncludeFlags(_filter.getIncludeFlags() | NAV_GROUND_STEEP);*/
    }
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::GetNavTerrain */
  private getNavTerrain(x: number, y: number, z: number): number {
    const liquidData = this._source.getMap().getLiquidData(this._source.getPhaseMask(), x, y, z, this._source.getCollisionHeight(), null);
    if (liquidData.Status === LIQUID_MAP_NO_WATER) return NavTerrain.NAV_GROUND;

    switch (liquidData.Flags) {
      case MAP_LIQUID_TYPE_WATER:
      case MAP_LIQUID_TYPE_OCEAN:
        return NavTerrain.NAV_WATER;
      case MAP_LIQUID_TYPE_MAGMA:
      case MAP_LIQUID_TYPE_SLIME:
        return NavTerrain.NAV_MAGMA;
      default:
        return NavTerrain.NAV_GROUND;
    }
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::HaveTile */
  private haveTile(p: Vector3): boolean {
    const tile = this._tileLoc;
    tile[0] = -1;
    tile[1] = -1;
    const point = new Float32Array([p.y, p.z, p.x]);

    this._navMesh!.calcTileLoc(point, 0, tile);

    /// Workaround
    /// For some reason, often the tx and ty variables wont get a valid value
    /// Use this check to prevent getting negative tile coords and crashing on getTileAt
    if (tile[0]! < 0 || tile[1]! < 0) return false;

    return this._navMesh!.getTileAt(tile[0]!, tile[1]!, 0) !== null;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::FixupCorridor */
  private fixupCorridor(path: Float64Array, npath: number, maxPath: number, visited: Float64Array, nvisited: number): number {
    let furthestPath = -1;
    let furthestVisited = -1;

    // Find furthest common polygon.
    for (let i = npath - 1; i >= 0; --i) {
      let found = false;
      for (let j = nvisited - 1; j >= 0; --j) {
        if (path[i] === visited[j]) {
          furthestPath = i;
          furthestVisited = j;
          found = true;
        }
      }
      if (found) break;
    }

    // If no intersection found just return current path.
    if (furthestPath === -1 || furthestVisited === -1) return npath;

    // Concatenate paths.

    // Adjust beginning of the buffer to include the visited.
    const req = nvisited - furthestVisited;
    const orig = furthestPath + 1 < npath ? furthestPath + 1 : npath;
    let size = npath > orig ? npath - orig : 0;
    if (req + size > maxPath) size = maxPath - req;

    if (size) path.copyWithin(req, orig, orig + size);

    // Store visited
    for (let i = 0; i < req; ++i) path[i] = visited[nvisited - 1 - i]!;

    return req + size;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::GetSteerTarget */
  private getSteerTarget(
    startPos: Float32Array,
    endPos: Float32Array,
    minTargetDist: number,
    path: Float64Array,
    pathSize: number,
    steerPos: Float32Array,
    steerPosFlag: FloatOut,
    steerPosRef: FloatOut,
  ): boolean {
    // Find steer target.
    const MAX_STEER_POINTS = 3;
    const steerPath = this._steerPath;
    const steerPathFlags = this._steerPathFlags;
    const steerPathPolys = this._steerPathPolys;
    const nsteerPathOut = this._nsteerPath;
    nsteerPathOut[0] = 0;
    const dtResult = this._navMeshQuery!.findStraightPath(startPos, endPos, path, pathSize, steerPath, steerPathFlags, steerPathPolys, nsteerPathOut, MAX_STEER_POINTS);
    const nsteerPath = nsteerPathOut[0]!;
    if (!nsteerPath || dtStatusFailed(dtResult)) return false;

    // Find vertex far enough to steer to.
    let ns = 0;
    while (ns < nsteerPath) {
      // Stop at Off-Mesh link or when point is further than slop away.
      if (steerPathFlags[ns]! & DT_STRAIGHTPATH_OFFMESH_CONNECTION || !this.inRangeYZX(steerPath.subarray(ns * VERTEX_SIZE), startPos, minTargetDist, 1000.0)) break;

      ns++;
    }
    // Failed to find good point to steer to.
    if (ns >= nsteerPath) return false;

    dtVcopy(steerPos, 0, steerPath, ns * VERTEX_SIZE);
    steerPos[1] = startPos[1]!; // keep Z value
    steerPosFlag.value = steerPathFlags[ns]!;
    steerPosRef.value = steerPathPolys[ns]!;

    return true;
  }

  /** `smoothPathSize` is the C++ `int*` out parameter. @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::FindSmoothPath */
  private findSmoothPath(
    startPos: Float32Array,
    endPos: Float32Array,
    polyPath: Float64Array,
    polyPathSize: number,
    smoothPath: Float32Array,
    smoothPathSize: Int32Array,
    maxSmoothPathSize: number,
  ): dtStatus {
    smoothPathSize[0] = 0;
    let nsmoothPath = 0;

    const polys = new Float64Array(MAX_PATH_LENGTH);
    polys.set(polyPath.subarray(0, polyPathSize));
    let npolys = polyPathSize;

    const iterPos = new Float32Array(VERTEX_SIZE);
    const targetPos = new Float32Array(VERTEX_SIZE);

    if (polyPathSize > 1) {
      // Pick the closest points on poly border
      if (dtStatusFailed(this._navMeshQuery!.closestPointOnPolyBoundary(polys[0]!, startPos, iterPos))) {
        return DT_FAILURE;
      }

      if (dtStatusFailed(this._navMeshQuery!.closestPointOnPolyBoundary(polys[npolys - 1]!, endPos, targetPos))) {
        return DT_FAILURE;
      }
    } else {
      // Case where the path is on the same poly
      dtVcopy(iterPos, 0, startPos, 0);
      dtVcopy(targetPos, 0, endPos, 0);
    }

    dtVcopy(smoothPath, nsmoothPath * VERTEX_SIZE, iterPos, 0);
    nsmoothPath++;

    const steerPos = new Float32Array(VERTEX_SIZE);
    const steerPosFlag: FloatOut = { value: 0 };
    const steerPosRef: FloatOut = { value: INVALID_POLYREF };
    const delta = new Float32Array(VERTEX_SIZE);
    const moveTgt = new Float32Array(VERTEX_SIZE);
    const result = new Float32Array(VERTEX_SIZE);
    const MAX_VISIT_POLY = 16;
    const visited = new Float64Array(MAX_VISIT_POLY);
    const nvisitedOut = intOut();
    const connectionStartPos = new Float32Array(VERTEX_SIZE);
    const connectionEndPos = new Float32Array(VERTEX_SIZE);

    // Move towards target a small advancement at a time until target reached or
    // when ran out of memory to store the path.
    while (npolys && nsmoothPath < maxSmoothPathSize) {
      // Find location to steer towards.
      steerPosRef.value = INVALID_POLYREF;

      if (!this.getSteerTarget(iterPos, targetPos, SMOOTH_PATH_SLOP, polys, npolys, steerPos, steerPosFlag, steerPosRef)) break;

      const endOfPath = (steerPosFlag.value & DT_STRAIGHTPATH_END) !== 0;
      const offMeshConnection = (steerPosFlag.value & DT_STRAIGHTPATH_OFFMESH_CONNECTION) !== 0;

      // Find movement delta.
      dtVsub(delta, 0, steerPos, 0, iterPos, 0);
      let len = Math.fround(dtMathSqrtf(dtVdot(delta, 0, delta, 0)));
      // If the steer target is end of path or off-mesh link, do not move past the location.
      if ((endOfPath || offMeshConnection) && len < SMOOTH_PATH_STEP_SIZE) len = 1.0;
      else len = Math.fround(SMOOTH_PATH_STEP_SIZE / len);

      dtVmad(moveTgt, 0, iterPos, 0, delta, 0, len);

      // Move
      nvisitedOut[0] = 0;
      if (dtStatusFailed(this._navMeshQuery!.moveAlongSurface(polys[0]!, iterPos, moveTgt, this._filter, result, visited, nvisitedOut, MAX_VISIT_POLY))) {
        return DT_FAILURE;
      }
      npolys = this.fixupCorridor(polys, npolys, MAX_PATH_LENGTH, visited, nvisitedOut[0]!);

      if (dtStatusFailed(this._navMeshQuery!.getPolyHeight(polys[0]!, result, result, 1))) {
        logDebug(
          "maps",
          () => `PathGenerator::FindSmoothPath: Cannot find height at position X: ${result[2]} Y: ${result[0]} Z: ${result[1]} for ${this._source.getGUID()}`,
        );
      }
      result[1] = result[1]! + 0.5;
      dtVcopy(iterPos, 0, result, 0);

      const canCheckSlope = this._slopeCheck && (this.getPathType() & ~PATHFIND_NOT_USING_PATH) !== 0;

      if (canCheckSlope && !this.isSwimmableSegment(iterPos, steerPos) && !this.isWalkableClimb(iterPos, steerPos)) {
        nsmoothPath--;
        smoothPathSize[0] = nsmoothPath;
        return DT_FAILURE | DT_SLOPE_TOO_STEEP;
      }

      // Handle end of path and off-mesh links when close enough.
      if (endOfPath && this.inRangeYZX(iterPos, steerPos, SMOOTH_PATH_SLOP, 1.0)) {
        // Reached end of path.
        dtVcopy(iterPos, 0, targetPos, 0);
        if (nsmoothPath < maxSmoothPathSize) {
          dtVcopy(smoothPath, nsmoothPath * VERTEX_SIZE, iterPos, 0);
          nsmoothPath++;
        }
        break;
      } else if (offMeshConnection && this.inRangeYZX(iterPos, steerPos, SMOOTH_PATH_SLOP, 1.0)) {
        // Advance the path up to and over the off-mesh connection.
        let prevRef: dtPolyRef = INVALID_POLYREF;
        let polyRef: dtPolyRef = polys[0]!;
        let npos = 0;
        while (npos < npolys && polyRef !== steerPosRef.value) {
          prevRef = polyRef;
          polyRef = polys[npos]!;
          npos++;
        }

        for (let i = npos; i < npolys; ++i) polys[i - npos] = polys[i]!;

        npolys -= npos;

        // Handle the connection.
        if (dtStatusSucceed(this._navMesh!.getOffMeshConnectionPolyEndPoints(prevRef, polyRef, connectionStartPos, connectionEndPos))) {
          if (nsmoothPath < maxSmoothPathSize) {
            dtVcopy(smoothPath, nsmoothPath * VERTEX_SIZE, connectionStartPos, 0);
            nsmoothPath++;
          }
          // Move position at the other side of the off-mesh link.
          dtVcopy(iterPos, 0, connectionEndPos, 0);
          if (dtStatusFailed(this._navMeshQuery!.getPolyHeight(polys[0]!, iterPos, iterPos, 1))) return DT_FAILURE;
          iterPos[1] = iterPos[1]! + 0.5;
        }
      }

      // Store results.
      if (nsmoothPath < maxSmoothPathSize) {
        dtVcopy(smoothPath, nsmoothPath * VERTEX_SIZE, iterPos, 0);
        nsmoothPath++;
      }
    }

    smoothPathSize[0] = nsmoothPath;

    // this is most likely a loop
    return nsmoothPath < MAX_POINT_PATH_LENGTH ? DT_SUCCESS : DT_FAILURE;
  }

  /**
   * The `(v1, v2)` and `(x, y, z, destX, destY, destZ)` overloads; both use the source's collision height.
   * @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::IsWalkableClimb
   */
  isWalkableClimb(v1: Float32Array, v2: Float32Array): boolean;
  isWalkableClimb(x: number, y: number, z: number, destX: number, destY: number, destZ: number): boolean;
  isWalkableClimb(a: Float32Array | number, b: Float32Array | number, z?: number, destX?: number, destY?: number, destZ?: number): boolean {
    if (typeof a !== "number") {
      const v1 = a;
      const v2 = b as Float32Array;
      return this.isWalkableClimb(v1[2]!, v1[0]!, v1[1]!, v2[2]!, v2[0]!, v2[1]!);
    }
    return PathGenerator.isWalkableClimb(a, b as number, z!, destX!, destY!, destZ!, this._source.getCollisionHeight());
  }

  /**
   * Check if a slope can be climbed based on source height.
   * This method is meant for short distances or linear paths.
   * @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::IsWalkableClimb
   */
  static isWalkableClimb(x: number, y: number, z: number, destX: number, destY: number, destZ: number, sourceHeight: number): boolean {
    const diffHeight = Math.abs(destZ - z);
    const reqHeight = PathGenerator.getRequiredHeightToClimb(x, y, z, destX, destY, destZ, sourceHeight);
    // check walkable slopes, based on unit height
    return diffHeight <= reqHeight;
  }

  /**
   * Return the height of a slope that can be climbed based on source height.
   * This method is meant for short distances or linear paths.
   * @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::GetRequiredHeightToClimb
   */
  static getRequiredHeightToClimb(x: number, y: number, z: number, destX: number, destY: number, destZ: number, sourceHeight: number): number {
    const slopeAngle = getSlopeAngleAbs(x, y, z, destX, destY, destZ);
    const slopeAngleDegree = (slopeAngle * 180.0) / Math.PI;
    const climbableHeight = sourceHeight - sourceHeight * (slopeAngleDegree / 100);
    return climbableHeight;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::InRangeYZX */
  private inRangeYZX(v1: Float32Array, v2: Float32Array, r: number, h: number): boolean {
    const dx = v2[0]! - v1[0]!;
    const dy = v2[1]! - v1[1]!; // elevation
    const dz = v2[2]! - v1[2]!;
    return dx * dx + dz * dz < r * r && Math.abs(dy) < h;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::InRange */
  private inRange(p1: Vector3, p2: Vector3, r: number, h: number): boolean {
    const d = p1.minus(p2);
    return d.x * d.x + d.y * d.y < r * r && Math.abs(d.z) < h;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::Dist3DSqr */
  private dist3DSqr(p1: Vector3, p2: Vector3): number {
    return p1.minus(p2).squaredMagnitude();
  }

  /**
   * Shortens the path until the destination is the specified distance from the target point.
   * @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::ShortenPathUntilDist
   */
  shortenPathUntilDist(target: Vector3, dist: number): void {
    if (this.getPathType() === PATHFIND_BLANK || this._pathPoints.length < 2) {
      logError("movement", "PathGenerator::ReducePathLengthByDist called before path was successfully built");
      return;
    }

    const distSq = dist * dist;

    // the first point of the path must be outside the specified range
    // (this should have really been checked by the caller...)
    if (this._pathPoints[0]!.minus(target).squaredMagnitude() < distSq) return;

    // check if we even need to do anything
    if (this._pathPoints[this._pathPoints.length - 1]!.minus(target).squaredMagnitude() >= distSq) return;

    let i = this._pathPoints.length - 1;
    const collisionHeight = this._source.getCollisionHeight();
    // find the first i s.t.:
    //  - _pathPoints[i] is still too close
    //  - _pathPoints[i-1] is too far away
    // => the end point is somewhere on the line between the two
    while (true) {
      // we know that pathPoints[i] is too close already (from the previous iteration)
      const prev = this._pathPoints[i - 1]!;
      if (prev.minus(target).squaredMagnitude() >= distSq) break; // bingo!

      const canCheckSlope = this._slopeCheck && (this.getPathType() & ~PATHFIND_NOT_USING_PATH) !== 0;

      // check if the shortened path is still in LoS with the target and it is walkable
      const destZ = prev.z + collisionHeight;
      const hit = this._source.getHitSpherePointFor({
        getPositionX: () => prev.x,
        getPositionY: () => prev.y,
        getPositionZ: () => destZ,
        getOrientation: () => 0,
      });
      const x = hit.getPositionX();
      const y = hit.getPositionY();
      const z = hit.getPositionZ();
      if (
        !this._source
          .getMap()
          .isInLineOfSight(x, y, z, prev.x, prev.y, destZ, this._source.getPhaseMask(), LINEOFSIGHT_ALL_CHECKS, MODEL_IGNORE_FLAGS_NOTHING) ||
        (canCheckSlope &&
          !this.isSwimmableSegment(this._source.getPositionX(), this._source.getPositionY(), this._source.getPositionZ(), prev.x, prev.y, prev.z) &&
          !this.isWalkableClimb(this._source.getPositionX(), this._source.getPositionY(), this._source.getPositionZ(), prev.x, prev.y, prev.z))
      ) {
        // whenver we find a point that is not valid anymore, simply use last valid path
        this._pathPoints.length = i + 1;
        return;
      }

      if (!--i) {
        // no point found that fulfills the condition
        this._pathPoints[0] = this._pathPoints[1]!.clone();
        this._pathPoints.length = 2;
        return;
      }
    }

    // ok, _pathPoints[i] is too close, _pathPoints[i-1] is not, so our target point is somewhere between the two...
    //   ... settle for a guesstimate since i'm not confident in doing trig on every chase motion tick...
    // (@todo review this)
    const pi = this._pathPoints[i]!;
    const dir = this._pathPoints[i - 1]!.minus(pi);
    // G3D::Vector3::direction(): v * (1 / sqrt(|v|^2))
    const invSqrt = 1.0 / Math.sqrt(dir.squaredMagnitude());
    const scale = dist - pi.minus(target).length();
    pi.set(pi.x + dir.x * invSqrt * scale, pi.y + dir.y * invSqrt * scale, pi.z + dir.z * invSqrt * scale);
    this._pathPoints.length = i + 1;
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::AddFarFromPolyFlags */
  private addFarFromPolyFlags(startFarFromPoly: boolean, endFarFromPoly: boolean): void {
    if (startFarFromPoly) {
      this._type = this._type | PATHFIND_FARFROMPOLY_START;
    }
    if (endFarFromPoly) {
      this._type = this._type | PATHFIND_FARFROMPOLY_END;
    }
  }

  /**
   * Predict if a certain segment is underwater and the unit can swim. Must only be used for very short segments
   * since this check doesn't work on long paths that alternate terrain and water. The `(v1, v2, checkSwim)` and
   * `(x, y, z, destX, destY, destZ, checkSwim)` overloads.
   * @return true if there's water at the end AND at the start of the segment
   * @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::IsSwimmableSegment
   */
  isSwimmableSegment(v1: Float32Array, v2: Float32Array, checkSwim?: boolean): boolean;
  isSwimmableSegment(x: number, y: number, z: number, destX: number, destY: number, destZ: number, checkSwim?: boolean): boolean;
  isSwimmableSegment(
    a: Float32Array | number,
    b: Float32Array | number,
    c?: number | boolean,
    destX?: number,
    destY?: number,
    destZ?: number,
    checkSwim = true,
  ): boolean {
    if (typeof a !== "number") {
      const v1 = a;
      const v2 = b as Float32Array;
      return this.isSwimmableSegment(v1[2]!, v1[0]!, v1[1]!, v2[2]!, v2[0]!, v2[1]!, c === undefined ? true : (c as boolean));
    }
    const x = a;
    const y = b as number;
    const z = c as number;
    const _sourceCreature = this._source.toCreature();
    const map = this._source.getMap();
    return (
      map.isInWater(this._source.getPhaseMask(), x, y, z, this._source.getCollisionHeight()) &&
      map.isInWater(this._source.getPhaseMask(), destX!, destY!, destZ!, this._source.getCollisionHeight()) &&
      (!checkSwim || !_sourceCreature || _sourceCreature.canSwim())
    );
  }

  /** @ac game/Movement/MovementGenerators/PathGenerator.cpp PathGenerator::IsWaterPath */
  isWaterPath(pathPoints: readonly Vector3[]): boolean {
    let waterPath = true;
    // Check both start and end points, if they're both in water, then we can *safely* let the creature move
    for (let i = 0; i < pathPoints.length; ++i) {
      const terrain = this.getNavTerrain(pathPoints[i]!.x, pathPoints[i]!.y, pathPoints[i]!.z);
      // One of the points is not in the water
      if (terrain !== NavTerrain.NAV_MAGMA && terrain !== NavTerrain.NAV_WATER) {
        waterPath = false;
        break;
      }
    }

    return waterPath;
  }
}
