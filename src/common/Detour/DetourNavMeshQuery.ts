/**
 * Port of `deps/recastnavigation/Detour/Include/DetourNavMeshQuery.h` and `Source/DetourNavMeshQuery.cpp`.
 * AzerothCore builds it with `DT_VIRTUAL_QUERYFILTER` (so `dtQueryFilterExt` can override `getCost`), and its
 * `findDistanceToWall` uses `sqrtf` (`recastnavigation.diff`).
 *
 * Calling conventions (see `DetourCommon.ts`): positions are `Float32Array`s of 3 floats, `dtPolyRef*` buffers are
 * `Float64Array`s, `int*` / `float*` outputs are 1-element typed arrays (or an `(array, index)` pair where the C++
 * passes a pointer into a vector, such as `getPolyHeight(ref, pos, &pos[1])`), and a `dtPoly*` is the polygon index
 * in its tile. Every method keeps its scratch vectors on the query object, so a query allocates nothing; like the
 * C++ object, a `dtNavMeshQuery` must not be used from two places at once.
 */
import { dtAssert } from "./DetourAssert.ts";
import {
  dtAbs,
  dtDistancePtPolyEdgesSqr,
  dtDistancePtSegSqr2D,
  dtIntersectSegmentPoly2D,
  dtIntersectSegSeg2D,
  dtMin,
  dtNextPow2,
  dtOverlapBounds,
  dtOverlapPolyPoly2D,
  dtOverlapQuantBounds,
  dtPointInPolygon,
  dtRandomPointInConvexPoly,
  dtSegmentPolyIntersection,
  dtSegSegIntersection,
  dtSqr,
  dtTriArea2D,
  dtVadd,
  dtVcopy,
  dtVdist,
  dtVdistSqr,
  dtVequal,
  dtVisfinite,
  dtVisfinite2D,
  dtVlenSqr,
  dtVlerp,
  dtVmad,
  dtVmax,
  dtVmin,
  dtVnormalize,
  dtVscale,
  dtVset,
  dtVsub,
  dtClamp,
} from "./DetourCommon.ts";
import { dtMathIsfinite, dtMathSqrtf } from "./DetourMath.ts";
import {
  DT_EXT_LINK,
  DT_FINDPATH_ANY_ANGLE,
  DT_MAX_AREAS,
  DT_NULL_LINK,
  DT_POLYTYPE_GROUND,
  DT_POLYTYPE_OFFMESH_CONNECTION,
  DT_RAY_CAST_LIMIT_PROPORTIONS,
  DT_RAYCAST_USE_COSTS,
  DT_STRAIGHTPATH_ALL_CROSSINGS,
  DT_STRAIGHTPATH_AREA_CROSSINGS,
  DT_STRAIGHTPATH_END,
  DT_STRAIGHTPATH_OFFMESH_CONNECTION,
  DT_STRAIGHTPATH_START,
  DT_VERTS_PER_POLYGON,
  type dtMeshTile,
  type dtNavMesh,
  type dtPolyRef,
  dtTileAndPoly,
} from "./DetourNavMesh.ts";
import {
  DT_MAX_STATES_PER_NODE,
  DT_NODE_CLOSED,
  DT_NODE_OPEN,
  DT_NODE_PARENT_BITS,
  DT_NODE_PARENT_DETACHED,
  DT_NULL_IDX,
  type dtNode,
  dtNodePool,
  dtNodeQueue,
} from "./DetourNode.ts";
import {
  DT_BUFFER_TOO_SMALL,
  DT_FAILURE,
  DT_IN_PROGRESS,
  DT_INVALID_PARAM,
  DT_OUT_OF_MEMORY,
  DT_OUT_OF_NODES,
  DT_PARTIAL_RESULT,
  DT_STATUS_DETAIL_MASK,
  DT_SUCCESS,
  type dtStatus,
  dtStatusFailed,
  dtStatusInProgress,
} from "./DetourStatus.ts";

/**
 * Defines polygon filtering and traversal costs for navigation mesh query operations. `passFilter` and `getCost`
 * are overridable (`DT_VIRTUAL_QUERYFILTER`); `curTile` / `prevTile` / `nextTile` may be null with poly -1 where the
 * C++ passes null pointers.
 * @ac deps/recastnavigation/Detour/Include/DetourNavMeshQuery.h dtQueryFilter
 */
export class dtQueryFilter {
  /** Cost per area type. (Used by default implementation.) */
  protected m_areaCost = new Float32Array(DT_MAX_AREAS);
  /** Flags for polygons that can be visited. (Used by default implementation.) */
  protected m_includeFlags = 0xffff;
  /** Flags for polygons that should not be visted. (Used by default implementation.) */
  protected m_excludeFlags = 0;

  /** @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtQueryFilter::dtQueryFilter */
  constructor() {
    for (let i = 0; i < DT_MAX_AREAS; ++i) this.m_areaCost[i] = 1.0;
  }

  /**
   * Returns true if the polygon can be visited. (I.e. Is traversable.)
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtQueryFilter::passFilter
   */
  passFilter(_ref: dtPolyRef, tile: dtMeshTile, poly: number): boolean {
    const flags = tile.polyFlags(poly);
    return (flags & this.m_includeFlags) !== 0 && (flags & this.m_excludeFlags) === 0;
  }

  /**
   * Returns cost to move from the beginning to the end of a line segment that is fully contained within a polygon.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtQueryFilter::getCost
   */
  getCost(
    pa: Float32Array,
    pb: Float32Array,
    _prevRef: dtPolyRef,
    _prevTile: dtMeshTile | null,
    _prevPoly: number,
    _curRef: dtPolyRef,
    curTile: dtMeshTile | null,
    curPoly: number,
    _nextRef: dtPolyRef,
    _nextTile: dtMeshTile | null,
    _nextPoly: number,
  ): number {
    return dtVdist(pa, 0, pb, 0) * this.m_areaCost[curTile!.polyGetArea(curPoly)]!;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNavMeshQuery.h dtQueryFilter::getAreaCost */
  getAreaCost(i: number): number {
    return this.m_areaCost[i]!;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNavMeshQuery.h dtQueryFilter::setAreaCost */
  setAreaCost(i: number, cost: number): void {
    this.m_areaCost[i] = cost;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNavMeshQuery.h dtQueryFilter::getIncludeFlags */
  getIncludeFlags(): number {
    return this.m_includeFlags;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNavMeshQuery.h dtQueryFilter::setIncludeFlags */
  setIncludeFlags(flags: number): void {
    this.m_includeFlags = flags & 0xffff;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNavMeshQuery.h dtQueryFilter::getExcludeFlags */
  getExcludeFlags(): number {
    return this.m_excludeFlags;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNavMeshQuery.h dtQueryFilter::setExcludeFlags */
  setExcludeFlags(flags: number): void {
    this.m_excludeFlags = flags & 0xffff;
  }
}

/**
 * Provides information about raycast hit filled by dtNavMeshQuery::raycast
 * @ac deps/recastnavigation/Detour/Include/DetourNavMeshQuery.h dtRaycastHit
 */
export class dtRaycastHit {
  /** The hit parameter. (FLT_MAX if no wall hit.) */
  t = 0;
  /** hitNormal	The normal of the nearest wall hit. [(x, y, z)] */
  readonly hitNormal = new Float32Array(3);
  /** the index of the edge on the final polygon where the wall was hit. */
  hitEdgeIndex = 0;
  /** Pointer to an array of reference ids of the visited polygons. [opt] */
  path: Float64Array | null = null;
  /** The number of visited polygons. [opt] */
  pathCount = 0;
  /** The maximum number of polygons the @p path array can hold. */
  maxPath = 0;
  /** The cost of the path until hit. */
  pathCost = 0;
}

/**
 * Provides custom polygon query behavior. Used by dtNavMeshQuery::queryPolygons.
 * `polys` holds the polygon indices in `tile` (the C++ `dtPoly**`).
 * @ac deps/recastnavigation/Detour/Include/DetourNavMeshQuery.h dtPolyQuery
 */
export abstract class dtPolyQuery {
  /** Called for each batch of unique polygons touched by the search area in dtNavMeshQuery::queryPolygons. */
  abstract process(tile: dtMeshTile, polys: Int32Array, refs: Float64Array, count: number): void;
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp H_SCALE */
const H_SCALE = Math.fround(0.999); // Search heuristic scale.

const FLT_MAX = 3.4028234663852886e38;

/**
 * Allocates a query object using the Detour allocator.
 * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtAllocNavMeshQuery
 */
export function dtAllocNavMeshQuery(): dtNavMeshQuery {
  return new dtNavMeshQuery();
}

/**
 * Frees the specified query object using the Detour allocator.
 * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtFreeNavMeshQuery
 */
export function dtFreeNavMeshQuery(_navmesh: dtNavMeshQuery | null): void {
  // The garbage collector releases the pools.
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtFindNearestPolyQuery */
class dtFindNearestPolyQuery extends dtPolyQuery {
  private m_query: dtNavMeshQuery;
  private m_center: Float32Array = new Float32Array(3);
  private m_nearestDistanceSqr = FLT_MAX;
  private m_nearestRef: dtPolyRef = 0;
  private readonly m_nearestPoint = new Float32Array(3);
  private readonly closestPtPoly = new Float32Array(3);
  private readonly diff = new Float32Array(3);
  private readonly posOverPoly = { value: false };

  /** @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtFindNearestPolyQuery::dtFindNearestPolyQuery */
  constructor(query: dtNavMeshQuery) {
    super();
    this.m_query = query;
  }

  /** Re-runs the constructor initialisation so one object serves every findNearestPoly call. */
  reset(center: Float32Array): void {
    this.m_center = center;
    this.m_nearestDistanceSqr = FLT_MAX;
    this.m_nearestRef = 0;
    this.m_nearestPoint.fill(0);
  }

  /** @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtFindNearestPolyQuery::nearestRef */
  nearestRef(): dtPolyRef {
    return this.m_nearestRef;
  }

  /** @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtFindNearestPolyQuery::nearestPoint */
  nearestPoint(): Float32Array {
    return this.m_nearestPoint;
  }

  /** @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtFindNearestPolyQuery::process */
  process(tile: dtMeshTile, _polys: Int32Array, refs: Float64Array, count: number): void {
    for (let i = 0; i < count; ++i) {
      const ref = refs[i]!;
      const closestPtPoly = this.closestPtPoly;
      const diff = this.diff;
      this.posOverPoly.value = false;
      let d: number;
      this.m_query.closestPointOnPoly(ref, this.m_center, closestPtPoly, this.posOverPoly);

      // If a point is directly over a polygon and closer than
      // climb height, favor that instead of straight line nearest point.
      dtVsub(diff, 0, this.m_center, 0, closestPtPoly, 0);
      if (this.posOverPoly.value) {
        d = dtAbs(diff[1]!) - tile.header!.walkableClimb;
        d = d > 0 ? d * d : 0;
      } else {
        d = dtVlenSqr(diff, 0);
      }

      if (d < this.m_nearestDistanceSqr) {
        dtVcopy(this.m_nearestPoint, 0, closestPtPoly, 0);

        this.m_nearestDistanceSqr = d;
        this.m_nearestRef = ref;
      }
    }
  }
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtCollectPolysQuery */
class dtCollectPolysQuery extends dtPolyQuery {
  private m_polys: Float64Array = new Float64Array(0);
  private m_maxPolys = 0;
  private m_numCollected = 0;
  private m_overflow = false;

  /** @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtCollectPolysQuery::dtCollectPolysQuery */
  reset(polys: Float64Array, maxPolys: number): void {
    this.m_polys = polys;
    this.m_maxPolys = maxPolys;
    this.m_numCollected = 0;
    this.m_overflow = false;
  }

  /** @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtCollectPolysQuery::numCollected */
  numCollected(): number {
    return this.m_numCollected;
  }

  /** @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtCollectPolysQuery::overflowed */
  overflowed(): boolean {
    return this.m_overflow;
  }

  /** @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtCollectPolysQuery::process */
  process(_tile: dtMeshTile, _polys: Int32Array, refs: Float64Array, count: number): void {
    const numLeft = this.m_maxPolys - this.m_numCollected;
    let toCopy = count;
    if (toCopy > numLeft) {
      this.m_overflow = true;
      toCopy = numLeft;
    }

    for (let i = 0; i < toCopy; ++i) this.m_polys[this.m_numCollected + i] = refs[i]!;
    this.m_numCollected += toCopy;
  }
}

/** Sliced query state. @ac deps/recastnavigation/Detour/Include/DetourNavMeshQuery.h dtNavMeshQuery::dtQueryData */
class dtQueryData {
  status: dtStatus = 0;
  lastBestNode: dtNode | null = null;
  lastBestNodeCost = 0;
  startRef: dtPolyRef = 0;
  endRef: dtPolyRef = 0;
  readonly startPos = new Float32Array(3);
  readonly endPos = new Float32Array(3);
  filter: dtQueryFilter | null = null;
  options = 0;
  raycastLimitSqr = 0;

  /** `memset(&m_query, 0, sizeof(dtQueryData))` */
  clear(): void {
    this.status = 0;
    this.lastBestNode = null;
    this.lastBestNodeCost = 0;
    this.startRef = 0;
    this.endRef = 0;
    this.startPos.fill(0);
    this.endPos.fill(0);
    this.filter = null;
    this.options = 0;
    this.raycastLimitSqr = 0;
  }
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtSegInterval */
const MAX_INTERVAL = 16;

/**
 * Inserts an interval into the struct-of-arrays `dtSegInterval ints[]` (refs, tmin, tmax); returns the new count.
 * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp insertInterval
 */
function insertInterval(
  intsRef: Float64Array,
  intsTmin: Int16Array,
  intsTmax: Int16Array,
  nints: number,
  maxInts: number,
  tmin: number,
  tmax: number,
  ref: dtPolyRef,
): number {
  if (nints + 1 > maxInts) return nints;
  // Find insertion point.
  let idx = 0;
  while (idx < nints) {
    if (tmax <= intsTmin[idx]!) break;
    idx++;
  }
  // Move current results.
  if (nints - idx) {
    intsRef.copyWithin(idx + 1, idx, nints);
    intsTmin.copyWithin(idx + 1, idx, nints);
    intsTmax.copyWithin(idx + 1, idx, nints);
  }
  // Store
  intsRef[idx] = ref;
  intsTmin[idx] = tmin;
  intsTmax[idx] = tmax;
  nints++;
  return nints;
}

const MAX_STACK = 48;
const MAX_NEIS = 32;
const MAX_NEIS_MOVE = 8;

/**
 * Provides the ability to perform pathfinding related queries against a navigation mesh.
 * @ac deps/recastnavigation/Detour/Include/DetourNavMeshQuery.h dtNavMeshQuery
 */
export class dtNavMeshQuery {
  /** Pointer to navmesh data. */
  private m_nav: dtNavMesh | null = null;
  /** Sliced query state. */
  private readonly m_query = new dtQueryData();
  /** Pointer to small node pool. */
  private m_tinyNodePool: dtNodePool | null = null;
  /** Pointer to node pool. */
  private m_nodePool: dtNodePool | null = null;
  /** Pointer to open list queue. */
  private m_openList: dtNodeQueue | null = null;

  // Scratch storage (the C++ stack locals), one set per method.
  private readonly tpA = new dtTileAndPoly();
  private readonly tpB = new dtTileAndPoly();
  private readonly tpC = new dtTileAndPoly();
  private readonly tpPortal = new dtTileAndPoly();
  private readonly tpAppend = new dtTileAndPoly();
  private readonly tpRay = new dtTileAndPoly();
  private readonly tpBoundary = new dtTileAndPoly();
  private readonly tpHeight = new dtTileAndPoly();
  private readonly tpValid = new dtTileAndPoly();
  private readonly tpWall = new dtTileAndPoly();
  private readonly rnd_verts = new Float32Array(3 * DT_VERTS_PER_POLYGON);
  private readonly rnd_areas = new Float32Array(DT_VERTS_PER_POLYGON);
  private readonly rnd_pt = new Float32Array(3);
  private readonly rnd_h = new Float32Array(1);
  private readonly rnd_va = new Float32Array(3);
  private readonly rnd_vb = new Float32Array(3);
  private readonly rnd_t = new Float32Array(1);
  private readonly cpb_verts = new Float32Array(DT_VERTS_PER_POLYGON * 3);
  private readonly cpb_edged = new Float32Array(DT_VERTS_PER_POLYGON);
  private readonly cpb_edget = new Float32Array(DT_VERTS_PER_POLYGON);
  private readonly gph_t = new Float32Array(1);
  private readonly nearestQuery = new dtFindNearestPolyQuery(this);
  private readonly collectQuery = new dtCollectPolysQuery();
  private readonly qpt_polyRefs = new Float64Array(32);
  private readonly qpt_polys = new Int32Array(32);
  private readonly qpt_bmin = new Uint16Array(3);
  private readonly qpt_bmax = new Uint16Array(3);
  private readonly qpt_fbmin = new Float32Array(3);
  private readonly qpt_fbmax = new Float32Array(3);
  private readonly qp_bmin = new Float32Array(3);
  private readonly qp_bmax = new Float32Array(3);
  private readonly qp_tile = new Int32Array(2);
  private readonly qp_neis: (dtMeshTile | null)[] = new Array(MAX_NEIS).fill(null);
  private readonly slice_rayHit = new dtRaycastHit();
  private readonly fin_t = new Float32Array(1);
  private readonly fin_normal = new Float32Array(3);
  private readonly fin_m = new Int32Array(1);
  private readonly ap_left = new Float32Array(3);
  private readonly ap_right = new Float32Array(3);
  private readonly ap_pt = new Float32Array(3);
  private readonly ap_seg = new dtSegSegIntersection();
  private readonly fsp_closestStartPos = new Float32Array(3);
  private readonly fsp_closestEndPos = new Float32Array(3);
  private readonly fsp_portalApex = new Float32Array(3);
  private readonly fsp_portalLeft = new Float32Array(3);
  private readonly fsp_portalRight = new Float32Array(3);
  private readonly fsp_left = new Float32Array(3);
  private readonly fsp_right = new Float32Array(3);
  private readonly fsp_types = new Uint8Array(2);
  private readonly fsp_t = new Float32Array(1);
  private readonly mas_stack: (dtNode | null)[] = new Array(MAX_STACK).fill(null);
  private readonly mas_bestPos = new Float32Array(3);
  private readonly mas_searchPos = new Float32Array(3);
  private readonly mas_verts = new Float32Array(DT_VERTS_PER_POLYGON * 3);
  private readonly mas_neis = new Float64Array(MAX_NEIS_MOVE);
  private readonly mas_tseg = new Float32Array(1);
  private readonly gpp_left = new Float32Array(3);
  private readonly gpp_right = new Float32Array(3);
  private readonly gem_left = new Float32Array(3);
  private readonly gem_right = new Float32Array(3);
  private readonly gem_types = new Uint8Array(2);
  private readonly ray_hit = new dtRaycastHit();
  private readonly ray_dir = new Float32Array(3);
  private readonly ray_curPos = new Float32Array(3);
  private readonly ray_lastPos = new Float32Array(3);
  private readonly ray_verts = new Float32Array(DT_VERTS_PER_POLYGON * 3 + 3);
  private readonly ray_isect = new dtSegmentPolyIntersection();
  private readonly ray_eDir = new Float32Array(3);
  private readonly ray_diff = new Float32Array(3);
  private readonly fpc_va = new Float32Array(3);
  private readonly fpc_vb = new Float32Array(3);
  private readonly fpc_tseg = new Float32Array(1);
  private readonly fps_centerPos = new Float32Array(3);
  private readonly fps_va = new Float32Array(3);
  private readonly fps_vb = new Float32Array(3);
  private readonly fps_isect = new dtSegmentPolyIntersection();
  private readonly gdj_endNode: (dtNode | null)[] = [null];
  private readonly fln_stack: (dtNode | null)[] = new Array(MAX_STACK).fill(null);
  private readonly fln_pa = new Float32Array(DT_VERTS_PER_POLYGON * 3);
  private readonly fln_pb = new Float32Array(DT_VERTS_PER_POLYGON * 3);
  private readonly fln_va = new Float32Array(3);
  private readonly fln_vb = new Float32Array(3);
  private readonly fln_tseg = new Float32Array(1);
  private readonly gws_intsRef = new Float64Array(MAX_INTERVAL);
  private readonly gws_intsTmin = new Int16Array(MAX_INTERVAL);
  private readonly gws_intsTmax = new Int16Array(MAX_INTERVAL);
  private readonly fdw_tseg = new Float32Array(1);
  private readonly icl_nodes: (dtNode | null)[] = new Array(DT_MAX_STATES_PER_NODE).fill(null);
  private readonly fsp_node: (dtNode | null)[] = [null];

  /** @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::dtNavMeshQuery */
  constructor() {
    this.m_query.clear();
  }

  /**
   * Initializes the query object.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::init
   */
  init(nav: dtNavMesh, maxNodes: number): dtStatus {
    if (maxNodes > DT_NULL_IDX || maxNodes > (1 << DT_NODE_PARENT_BITS) - 1) return DT_FAILURE | DT_INVALID_PARAM;

    this.m_nav = nav;

    if (!this.m_nodePool || this.m_nodePool.getMaxNodes() < maxNodes) {
      this.m_nodePool = null;
      this.m_nodePool = new dtNodePool(maxNodes, dtNextPow2(Math.trunc(maxNodes / 4)));
      if (!this.m_nodePool) return DT_FAILURE | DT_OUT_OF_MEMORY;
    } else {
      this.m_nodePool.clear();
    }

    if (!this.m_tinyNodePool) {
      this.m_tinyNodePool = new dtNodePool(64, 32);
    } else {
      this.m_tinyNodePool.clear();
    }

    if (!this.m_openList || this.m_openList.getCapacity() < maxNodes) {
      this.m_openList = null;
      this.m_openList = new dtNodeQueue(maxNodes);
    } else {
      this.m_openList.clear();
    }

    return DT_SUCCESS;
  }

  private get nav(): dtNavMesh {
    dtAssert(this.m_nav, "m_nav");
    return this.m_nav;
  }

  /**
   * Returns random location on navmesh. Polygons are chosen weighted by area. The search runs in linear related
   * to number of polygon.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::findRandomPoint
   */
  findRandomPoint(filter: dtQueryFilter | null, frand: (() => number) | null, randomRef: Float64Array | null, randomPt: Float32Array | null): dtStatus {
    const nav = this.nav;

    if (!filter || !frand || !randomRef || !randomPt) return DT_FAILURE | DT_INVALID_PARAM;

    // Randomly pick one tile. Assume that all tiles cover roughly the same area.
    let tile: dtMeshTile | null = null;
    let tsum = 0.0;
    for (let i = 0; i < nav.getMaxTiles(); i++) {
      const t = nav.getTile(i);
      if (!t || !t.header) continue;

      // Choose random tile using reservoi sampling.
      const area = 1.0; // Could be tile area too.
      tsum += area;
      const u = frand();
      if (u * tsum <= area) tile = t;
    }
    if (!tile) return DT_FAILURE;

    // Randomly pick one polygon weighted by polygon area.
    let poly = -1;
    let polyRef: dtPolyRef = 0;
    const base = nav.getPolyRefBase(tile);

    let areaSum = 0.0;
    for (let i = 0; i < tile.header!.polyCount; ++i) {
      // Do not return off-mesh connection polygons.
      if (tile.polyGetType(i) !== DT_POLYTYPE_GROUND) continue;
      // Must pass filter
      const ref = base + i;
      if (!filter.passFilter(ref, tile, i)) continue;

      // Calc area of the polygon.
      let polyArea = 0.0;
      const vertCount = tile.polyVertCount(i);
      for (let j = 2; j < vertCount; ++j) {
        const va = tile.polyVerts(i, 0) * 3;
        const vb = tile.polyVerts(i, j - 1) * 3;
        const vc = tile.polyVerts(i, j) * 3;
        polyArea += dtTriArea2D(tile.verts, va, tile.verts, vb, tile.verts, vc);
      }

      // Choose random polygon weighted by area, using reservoi sampling.
      areaSum += polyArea;
      const u = frand();
      if (u * areaSum <= polyArea) {
        poly = i;
        polyRef = ref;
      }
    }

    if (poly < 0) return DT_FAILURE;

    // Randomly pick point on polygon.
    const verts = this.rnd_verts;
    const areas = this.rnd_areas;
    const vertCount = tile.polyVertCount(poly);
    dtVcopy(verts, 0 * 3, tile.verts, tile.polyVerts(poly, 0) * 3);
    for (let j = 1; j < vertCount; ++j) {
      dtVcopy(verts, j * 3, tile.verts, tile.polyVerts(poly, j) * 3);
    }

    const s = frand();
    const t = frand();

    const pt = this.rnd_pt;
    dtRandomPointInConvexPoly(verts, vertCount, areas, s, t, pt, 0);

    const h = this.rnd_h;
    h[0] = 0.0;
    const status = this.getPolyHeight(polyRef, pt, h, 0);
    if (dtStatusFailed(status)) return status;
    pt[1] = h[0]!;

    dtVcopy(randomPt, 0, pt, 0);
    randomRef[0] = polyRef;

    return DT_SUCCESS;
  }

  /**
   * Returns random location on navmesh within the reach of specified location.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::findRandomPointAroundCircle
   */
  findRandomPointAroundCircle(
    startRef: dtPolyRef,
    centerPos: Float32Array | null,
    maxRadius: number,
    filter: dtQueryFilter | null,
    frand: (() => number) | null,
    randomRef: Float64Array | null,
    randomPt: Float32Array | null,
  ): dtStatus {
    const nav = this.nav;
    const nodePool = this.m_nodePool!;
    const openList = this.m_openList!;

    // Validate input
    if (
      !nav.isValidPolyRef(startRef) ||
      !centerPos ||
      !dtVisfinite(centerPos, 0) ||
      maxRadius < 0 ||
      !dtMathIsfinite(maxRadius) ||
      !filter ||
      !frand ||
      !randomRef ||
      !randomPt
    ) {
      return DT_FAILURE | DT_INVALID_PARAM;
    }

    nav.getTileAndPolyByRefUnsafe(startRef, this.tpA);
    if (!filter.passFilter(startRef, this.tpA.tile!, this.tpA.poly)) return DT_FAILURE | DT_INVALID_PARAM;

    nodePool.clear();
    openList.clear();

    const startNode = nodePool.getNode(startRef)!;
    dtVcopy(startNode.pos, 0, centerPos, 0);
    startNode.pidx = 0;
    startNode.cost = 0;
    startNode.total = 0;
    startNode.id = startRef;
    startNode.flags = DT_NODE_OPEN;
    openList.push(startNode);

    let status: dtStatus = DT_SUCCESS;

    const radiusSqr = dtSqr(maxRadius);
    let areaSum = 0.0;

    let randomTile: dtMeshTile | null = null;
    let randomPoly = -1;
    let randomPolyRef: dtPolyRef = 0;

    while (!openList.empty()) {
      const bestNode = openList.pop();
      bestNode.flags &= ~DT_NODE_OPEN;
      bestNode.flags |= DT_NODE_CLOSED;

      // Get poly and tile.
      // The API input has been cheked already, skip checking internal data.
      const bestRef = bestNode.id;
      nav.getTileAndPolyByRefUnsafe(bestRef, this.tpA);
      const bestTile = this.tpA.tile!;
      const bestPoly = this.tpA.poly;

      // Place random locations on on ground.
      if (bestTile.polyGetType(bestPoly) === DT_POLYTYPE_GROUND) {
        // Calc area of the polygon.
        let polyArea = 0.0;
        const vertCount = bestTile.polyVertCount(bestPoly);
        for (let j = 2; j < vertCount; ++j) {
          const va = bestTile.polyVerts(bestPoly, 0) * 3;
          const vb = bestTile.polyVerts(bestPoly, j - 1) * 3;
          const vc = bestTile.polyVerts(bestPoly, j) * 3;
          polyArea += dtTriArea2D(bestTile.verts, va, bestTile.verts, vb, bestTile.verts, vc);
        }
        // Choose random polygon weighted by area, using reservoi sampling.
        areaSum += polyArea;
        const u = frand();
        if (u * areaSum <= polyArea) {
          randomTile = bestTile;
          randomPoly = bestPoly;
          randomPolyRef = bestRef;
        }
      }

      // Get parent poly and tile.
      let parentRef: dtPolyRef = 0;
      if (bestNode.pidx) parentRef = nodePool.getNodeAtIdx(bestNode.pidx)!.id;
      if (parentRef) nav.getTileAndPolyByRefUnsafe(parentRef, this.tpB);

      for (let i = bestTile.polyFirstLink(bestPoly); i !== DT_NULL_LINK; i = bestTile.linkNext(i)) {
        const neighbourRef = bestTile.linkRef(i);
        // Skip invalid neighbours and do not follow back to parent.
        if (!neighbourRef || neighbourRef === parentRef) continue;

        // Expand to neighbour
        nav.getTileAndPolyByRefUnsafe(neighbourRef, this.tpC);
        const neighbourTile = this.tpC.tile!;
        const neighbourPoly = this.tpC.poly;

        // Do not advance if the polygon is excluded by the filter.
        if (!filter.passFilter(neighbourRef, neighbourTile, neighbourPoly)) continue;

        // Find edge and calc distance to the edge.
        const va = this.rnd_va;
        const vb = this.rnd_vb;
        if (!this.getPortalPoints(bestRef, bestPoly, bestTile, neighbourRef, neighbourPoly, neighbourTile, va, vb)) continue;

        // If the circle is not touching the next polygon, skip it.
        const distSqr = dtDistancePtSegSqr2D(centerPos, 0, va, 0, vb, 0, this.rnd_t, 0);
        if (distSqr > radiusSqr) continue;

        const neighbourNode = nodePool.getNode(neighbourRef);
        if (!neighbourNode) {
          status |= DT_OUT_OF_NODES;
          continue;
        }

        if (neighbourNode.flags & DT_NODE_CLOSED) continue;

        // Cost
        if (neighbourNode.flags === 0) dtVlerp(neighbourNode.pos, 0, va, 0, vb, 0, 0.5);

        const total = Math.fround(bestNode.total + dtVdist(bestNode.pos, 0, neighbourNode.pos, 0));

        // The node is already in open list and the new result is worse, skip.
        if (neighbourNode.flags & DT_NODE_OPEN && total >= neighbourNode.total) continue;

        neighbourNode.id = neighbourRef;
        neighbourNode.flags = neighbourNode.flags & ~DT_NODE_CLOSED;
        neighbourNode.pidx = nodePool.getNodeIdx(bestNode);
        neighbourNode.total = total;

        if (neighbourNode.flags & DT_NODE_OPEN) {
          openList.modify(neighbourNode);
        } else {
          neighbourNode.flags = DT_NODE_OPEN;
          openList.push(neighbourNode);
        }
      }
    }

    if (randomPoly < 0 || !randomTile) return DT_FAILURE;

    // Randomly pick point on polygon.
    const verts = this.rnd_verts;
    const areas = this.rnd_areas;
    const vertCount = randomTile.polyVertCount(randomPoly);
    dtVcopy(verts, 0 * 3, randomTile.verts, randomTile.polyVerts(randomPoly, 0) * 3);
    for (let j = 1; j < vertCount; ++j) {
      dtVcopy(verts, j * 3, randomTile.verts, randomTile.polyVerts(randomPoly, j) * 3);
    }

    const s = frand();
    const t = frand();

    const pt = this.rnd_pt;
    dtRandomPointInConvexPoly(verts, vertCount, areas, s, t, pt, 0);

    const h = this.rnd_h;
    h[0] = 0.0;
    const stat = this.getPolyHeight(randomPolyRef, pt, h, 0);
    if (dtStatusFailed(status)) return stat;
    pt[1] = h[0]!;

    dtVcopy(randomPt, 0, pt, 0);
    randomRef[0] = randomPolyRef;

    return DT_SUCCESS;
  }

  /**
   * Finds the closest point on the specified polygon. Uses the detail polygons to find the surface height.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::closestPointOnPoly
   */
  closestPointOnPoly(ref: dtPolyRef, pos: Float32Array | null, closest: Float32Array | null, posOverPoly: { value: boolean } | null): dtStatus {
    const nav = this.nav;
    if (!nav.isValidPolyRef(ref) || !pos || !dtVisfinite(pos, 0) || !closest) {
      return DT_FAILURE | DT_INVALID_PARAM;
    }

    nav.closestPointOnPoly(ref, pos, 0, closest, 0, posOverPoly);
    return DT_SUCCESS;
  }

  /**
   * Returns a point on the boundary closest to the source point if the source point is outside the polygon's
   * xz-bounds. `pos` and `closest` may be the same array.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::closestPointOnPolyBoundary
   */
  closestPointOnPolyBoundary(ref: dtPolyRef, pos: Float32Array | null, closest: Float32Array | null): dtStatus {
    const nav = this.nav;

    if (dtStatusFailed(nav.getTileAndPolyByRef(ref, this.tpBoundary))) return DT_FAILURE | DT_INVALID_PARAM;
    const tile = this.tpBoundary.tile!;
    const poly = this.tpBoundary.poly;

    if (!pos || !dtVisfinite(pos, 0) || !closest) return DT_FAILURE | DT_INVALID_PARAM;

    // Collect vertices.
    const verts = this.cpb_verts;
    const edged = this.cpb_edged;
    const edget = this.cpb_edget;
    let nv = 0;
    const vertCount = tile.polyVertCount(poly);
    for (let i = 0; i < vertCount; ++i) {
      dtVcopy(verts, nv * 3, tile.verts, tile.polyVerts(poly, i) * 3);
      nv++;
    }

    const inside = dtDistancePtPolyEdgesSqr(pos, 0, verts, nv, edged, edget);
    if (inside) {
      // Point is inside the polygon, return the point.
      dtVcopy(closest, 0, pos, 0);
    } else {
      // Point is outside the polygon, dtClamp to nearest edge.
      let dmin = edged[0]!;
      let imin = 0;
      for (let i = 1; i < nv; ++i) {
        if (edged[i]! < dmin) {
          dmin = edged[i]!;
          imin = i;
        }
      }
      const va = imin * 3;
      const vb = ((imin + 1) % nv) * 3;
      dtVlerp(closest, 0, verts, va, verts, vb, edget[imin]!);
    }

    return DT_SUCCESS;
  }

  /**
   * Gets the height of the polygon at the provided position using the height detail. (Most accurate.) The height is
   * written to `height[heightIdx]` (the C++ `float* height`, often `&pos[1]`).
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::getPolyHeight
   */
  getPolyHeight(ref: dtPolyRef, pos: Float32Array | null, height: Float32Array | null, heightIdx = 0): dtStatus {
    const nav = this.nav;

    if (dtStatusFailed(nav.getTileAndPolyByRef(ref, this.tpHeight))) return DT_FAILURE | DT_INVALID_PARAM;
    const tile = this.tpHeight.tile!;
    const poly = this.tpHeight.poly;

    if (!pos || !dtVisfinite2D(pos, 0)) return DT_FAILURE | DT_INVALID_PARAM;

    // We used to return success for offmesh connections, but the
    // getPolyHeight in DetourNavMesh does not do this, so special
    // case it here.
    if (tile.polyGetType(poly) === DT_POLYTYPE_OFFMESH_CONNECTION) {
      const v0 = tile.polyVerts(poly, 0) * 3;
      const v1 = tile.polyVerts(poly, 1) * 3;
      dtDistancePtSegSqr2D(pos, 0, tile.verts, v0, tile.verts, v1, this.gph_t, 0);
      const t = this.gph_t[0]!;
      if (height) height[heightIdx] = tile.verts[v0 + 1]! + (tile.verts[v1 + 1]! - tile.verts[v0 + 1]!) * t;

      return DT_SUCCESS;
    }

    return nav.getPolyHeight(tile, poly, pos, 0, height, heightIdx) ? DT_SUCCESS : DT_FAILURE | DT_INVALID_PARAM;
  }

  /**
   * Finds the polygon nearest to the specified center point. Writes the ref to `nearestRef[0]`.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::findNearestPoly
   */
  findNearestPoly(
    center: Float32Array | null,
    halfExtents: Float32Array | null,
    filter: dtQueryFilter | null,
    nearestRef: Float64Array | null,
    nearestPt: Float32Array | null,
  ): dtStatus {
    this.nav;

    if (!nearestRef) return DT_FAILURE | DT_INVALID_PARAM;

    // queryPolygons below will check rest of params

    const query = this.nearestQuery;
    query.reset(center ?? this.qp_bmin);

    const status = this.queryPolygonsWithQuery(center, halfExtents, filter, query);
    if (dtStatusFailed(status)) return status;

    nearestRef[0] = query.nearestRef();
    // Only override nearestPt if we actually found a poly so the nearest point
    // is valid.
    if (nearestPt && nearestRef[0]) dtVcopy(nearestPt, 0, query.nearestPoint(), 0);

    return DT_SUCCESS;
  }

  /**
   * Queries polygons within a tile.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::queryPolygonsInTile
   */
  private queryPolygonsInTile(tile: dtMeshTile, qmin: Float32Array, qmax: Float32Array, filter: dtQueryFilter, query: dtPolyQuery): void {
    const nav = this.nav;
    const batchSize = 32;
    const polyRefs = this.qpt_polyRefs;
    const polys = this.qpt_polys;
    let n = 0;
    const header = tile.header!;

    if (tile.bvTree) {
      const bvTree = tile.bvTree;
      let node = 0;
      const end = header.bvNodeCount;
      const tbmin = header.bmin;
      const tbmax = header.bmax;
      const qfac = header.bvQuantFactor;

      // Calculate quantized box
      const bmin = this.qpt_bmin;
      const bmax = this.qpt_bmax;
      // dtClamp query box to world box.
      const minx = Math.fround(dtClamp(qmin[0]!, tbmin[0]!, tbmax[0]!) - tbmin[0]!);
      const miny = Math.fround(dtClamp(qmin[1]!, tbmin[1]!, tbmax[1]!) - tbmin[1]!);
      const minz = Math.fround(dtClamp(qmin[2]!, tbmin[2]!, tbmax[2]!) - tbmin[2]!);
      const maxx = Math.fround(dtClamp(qmax[0]!, tbmin[0]!, tbmax[0]!) - tbmin[0]!);
      const maxy = Math.fround(dtClamp(qmax[1]!, tbmin[1]!, tbmax[1]!) - tbmin[1]!);
      const maxz = Math.fround(dtClamp(qmax[2]!, tbmin[2]!, tbmax[2]!) - tbmin[2]!);
      // Quantize
      bmin[0] = Math.trunc(Math.fround(qfac * minx)) & 0xfffe;
      bmin[1] = Math.trunc(Math.fround(qfac * miny)) & 0xfffe;
      bmin[2] = Math.trunc(Math.fround(qfac * minz)) & 0xfffe;
      bmax[0] = Math.trunc(Math.fround(Math.fround(qfac * maxx) + 1)) | 1;
      bmax[1] = Math.trunc(Math.fround(Math.fround(qfac * maxy) + 1)) | 1;
      bmax[2] = Math.trunc(Math.fround(Math.fround(qfac * maxz) + 1)) | 1;

      // Traverse tree
      const base = nav.getPolyRefBase(tile);
      while (node < end) {
        const overlap = dtOverlapQuantBounds(bmin, 0, bmax, 0, bvTree, node * 8, bvTree, node * 8 + 3);
        const nodeI = tile.bvNodeI(node);
        const isLeafNode = nodeI >= 0;

        if (isLeafNode && overlap) {
          const ref = base + nodeI;
          if (filter.passFilter(ref, tile, nodeI)) {
            polyRefs[n] = ref;
            polys[n] = nodeI;

            if (n === batchSize - 1) {
              query.process(tile, polys, polyRefs, batchSize);
              n = 0;
            } else {
              n++;
            }
          }
        }

        if (overlap || isLeafNode) node++;
        else {
          const escapeIndex = -nodeI;
          node += escapeIndex;
        }
      }
    } else {
      const bmin = this.qpt_fbmin;
      const bmax = this.qpt_fbmax;
      const base = nav.getPolyRefBase(tile);
      for (let i = 0; i < header.polyCount; ++i) {
        // Do not return off-mesh connection polygons.
        if (tile.polyGetType(i) === DT_POLYTYPE_OFFMESH_CONNECTION) continue;
        // Must pass filter
        const ref = base + i;
        if (!filter.passFilter(ref, tile, i)) continue;
        // Calc polygon bounds.
        let v = tile.polyVerts(i, 0) * 3;
        dtVcopy(bmin, 0, tile.verts, v);
        dtVcopy(bmax, 0, tile.verts, v);
        const vertCount = tile.polyVertCount(i);
        for (let j = 1; j < vertCount; ++j) {
          v = tile.polyVerts(i, j) * 3;
          dtVmin(bmin, 0, tile.verts, v);
          dtVmax(bmax, 0, tile.verts, v);
        }
        if (dtOverlapBounds(qmin, 0, qmax, 0, bmin, 0, bmax, 0)) {
          polyRefs[n] = ref;
          polys[n] = i;

          if (n === batchSize - 1) {
            query.process(tile, polys, polyRefs, batchSize);
            n = 0;
          } else {
            n++;
          }
        }
      }
    }

    // Process the last polygons that didn't make a full batch.
    if (n > 0) query.process(tile, polys, polyRefs, n);
  }

  /**
   * Finds polygons that overlap the search box. Either collects the refs into `polys` (count to `polyCount[0]`), or
   * (`dtPolyQuery` overload) hands every batch to `query.process`.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::queryPolygons
   */
  queryPolygons(
    center: Float32Array | null,
    halfExtents: Float32Array | null,
    filter: dtQueryFilter | null,
    polys: Float64Array | null,
    polyCount: Int32Array | null,
    maxPolys: number,
  ): dtStatus;
  queryPolygons(center: Float32Array | null, halfExtents: Float32Array | null, filter: dtQueryFilter | null, query: dtPolyQuery | null): dtStatus;
  queryPolygons(
    center: Float32Array | null,
    halfExtents: Float32Array | null,
    filter: dtQueryFilter | null,
    polysOrQuery: Float64Array | dtPolyQuery | null,
    polyCount?: Int32Array | null,
    maxPolys?: number,
  ): dtStatus {
    if (polysOrQuery instanceof dtPolyQuery || polyCount === undefined) {
      return this.queryPolygonsWithQuery(center, halfExtents, filter, polysOrQuery as dtPolyQuery | null);
    }
    const polys = polysOrQuery;
    if (!polys || !polyCount || maxPolys === undefined || maxPolys < 0) return DT_FAILURE | DT_INVALID_PARAM;

    const collector = this.collectQuery;
    collector.reset(polys, maxPolys);

    const status = this.queryPolygonsWithQuery(center, halfExtents, filter, collector);
    if (dtStatusFailed(status)) return status;

    polyCount[0] = collector.numCollected();
    return collector.overflowed() ? DT_SUCCESS | DT_BUFFER_TOO_SMALL : DT_SUCCESS;
  }

  /** The `queryPolygons(center, halfExtents, filter, dtPolyQuery*)` overload. */
  private queryPolygonsWithQuery(
    center: Float32Array | null,
    halfExtents: Float32Array | null,
    filter: dtQueryFilter | null,
    query: dtPolyQuery | null,
  ): dtStatus {
    const nav = this.nav;

    if (!center || !dtVisfinite(center, 0) || !halfExtents || !dtVisfinite(halfExtents, 0) || !filter || !query) {
      return DT_FAILURE | DT_INVALID_PARAM;
    }

    const bmin = this.qp_bmin;
    const bmax = this.qp_bmax;
    dtVsub(bmin, 0, center, 0, halfExtents, 0);
    dtVadd(bmax, 0, center, 0, halfExtents, 0);

    // Find tiles the query touches.
    const loc = this.qp_tile;
    nav.calcTileLoc(bmin, 0, loc);
    const minx = loc[0]!;
    const miny = loc[1]!;
    nav.calcTileLoc(bmax, 0, loc);
    const maxx = loc[0]!;
    const maxy = loc[1]!;

    const neis = this.qp_neis;

    for (let y = miny; y <= maxy; ++y) {
      for (let x = minx; x <= maxx; ++x) {
        const nneis = nav.getTilesAt(x, y, neis, MAX_NEIS);
        for (let j = 0; j < nneis; ++j) {
          this.queryPolygonsInTile(neis[j]!, bmin, bmax, filter, query);
        }
      }
    }

    return DT_SUCCESS;
  }

  /**
   * Finds a path from the start polygon to the end polygon (A*). The path is written to `path`, its length to
   * `pathCount[0]`.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::findPath
   */
  findPath(
    startRef: dtPolyRef,
    endRef: dtPolyRef,
    startPos: Float32Array | null,
    endPos: Float32Array | null,
    filter: dtQueryFilter | null,
    path: Float64Array | null,
    pathCount: Int32Array | null,
    maxPath: number,
  ): dtStatus {
    const nav = this.nav;
    const nodePool = this.m_nodePool!;
    const openList = this.m_openList!;

    if (!pathCount) return DT_FAILURE | DT_INVALID_PARAM;

    pathCount[0] = 0;

    // Validate input
    if (
      !nav.isValidPolyRef(startRef) ||
      !nav.isValidPolyRef(endRef) ||
      !startPos ||
      !dtVisfinite(startPos, 0) ||
      !endPos ||
      !dtVisfinite(endPos, 0) ||
      !filter ||
      !path ||
      maxPath <= 0
    ) {
      return DT_FAILURE | DT_INVALID_PARAM;
    }

    if (startRef === endRef) {
      path[0] = startRef;
      pathCount[0] = 1;
      return DT_SUCCESS;
    }

    nodePool.clear();
    openList.clear();

    const startNode = nodePool.getNode(startRef)!;
    dtVcopy(startNode.pos, 0, startPos, 0);
    startNode.pidx = 0;
    startNode.cost = 0;
    startNode.total = Math.fround(Math.fround(dtVdist(startPos, 0, endPos, 0)) * H_SCALE);
    startNode.id = startRef;
    startNode.flags = DT_NODE_OPEN;
    openList.push(startNode);

    let lastBestNode = startNode;
    let lastBestNodeCost = startNode.total;

    let outOfNodes = false;

    const tpBest = this.tpA;
    const tpParent = this.tpB;
    const tpNei = this.tpC;

    while (!openList.empty()) {
      // Remove node from open list and put it in closed list.
      const bestNode = openList.pop();
      bestNode.flags &= ~DT_NODE_OPEN;
      bestNode.flags |= DT_NODE_CLOSED;

      // Reached the goal, stop searching.
      if (bestNode.id === endRef) {
        lastBestNode = bestNode;
        break;
      }

      // Get current poly and tile.
      // The API input has been cheked already, skip checking internal data.
      const bestRef = bestNode.id;
      nav.getTileAndPolyByRefUnsafe(bestRef, tpBest);
      const bestTile = tpBest.tile!;
      const bestPoly = tpBest.poly;

      // Get parent poly and tile.
      let parentRef: dtPolyRef = 0;
      let parentTile: dtMeshTile | null = null;
      let parentPoly = -1;
      if (bestNode.pidx) parentRef = nodePool.getNodeAtIdx(bestNode.pidx)!.id;
      if (parentRef) {
        nav.getTileAndPolyByRefUnsafe(parentRef, tpParent);
        parentTile = tpParent.tile;
        parentPoly = tpParent.poly;
      }

      for (let i = bestTile.polyFirstLink(bestPoly); i !== DT_NULL_LINK; i = bestTile.linkNext(i)) {
        const neighbourRef = bestTile.linkRef(i);

        // Skip invalid ids and do not expand back to where we came from.
        if (!neighbourRef || neighbourRef === parentRef) continue;

        // Get neighbour poly and tile.
        // The API input has been cheked already, skip checking internal data.
        nav.getTileAndPolyByRefUnsafe(neighbourRef, tpNei);
        const neighbourTile = tpNei.tile!;
        const neighbourPoly = tpNei.poly;

        if (!filter.passFilter(neighbourRef, neighbourTile, neighbourPoly)) continue;

        // deal explicitly with crossing tile boundaries
        let crossSide = 0;
        const side = bestTile.linkSide(i);
        if (side !== 0xff) crossSide = side >> 1;

        // get the node
        const neighbourNode = nodePool.getNode(neighbourRef, crossSide);
        if (!neighbourNode) {
          outOfNodes = true;
          continue;
        }

        // If the node is visited the first time, calculate node position.
        if (neighbourNode.flags === 0) {
          this.getEdgeMidPoint(bestRef, bestPoly, bestTile, neighbourRef, neighbourPoly, neighbourTile, neighbourNode.pos);
        }

        // Calculate cost and heuristic.
        let cost = 0;
        let heuristic = 0;

        // Special case for last node.
        if (neighbourRef === endRef) {
          // Cost
          const curCost = Math.fround(
            filter.getCost(
              bestNode.pos,
              neighbourNode.pos,
              parentRef,
              parentTile,
              parentPoly,
              bestRef,
              bestTile,
              bestPoly,
              neighbourRef,
              neighbourTile,
              neighbourPoly,
            ),
          );
          const endCost = Math.fround(
            filter.getCost(neighbourNode.pos, endPos, bestRef, bestTile, bestPoly, neighbourRef, neighbourTile, neighbourPoly, 0, null, -1),
          );

          cost = Math.fround(Math.fround(bestNode.cost + curCost) + endCost);
          heuristic = 0;
        } else {
          // Cost
          const curCost = Math.fround(
            filter.getCost(
              bestNode.pos,
              neighbourNode.pos,
              parentRef,
              parentTile,
              parentPoly,
              bestRef,
              bestTile,
              bestPoly,
              neighbourRef,
              neighbourTile,
              neighbourPoly,
            ),
          );
          cost = Math.fround(bestNode.cost + curCost);
          heuristic = Math.fround(Math.fround(dtVdist(neighbourNode.pos, 0, endPos, 0)) * H_SCALE);
        }

        const total = Math.fround(cost + heuristic);

        // The node is already in open list and the new result is worse, skip.
        if (neighbourNode.flags & DT_NODE_OPEN && total >= neighbourNode.total) continue;
        // The node is already visited and process, and the new result is worse, skip.
        if (neighbourNode.flags & DT_NODE_CLOSED && total >= neighbourNode.total) continue;

        // Add or update the node.
        neighbourNode.pidx = nodePool.getNodeIdx(bestNode);
        neighbourNode.id = neighbourRef;
        neighbourNode.flags = neighbourNode.flags & ~DT_NODE_CLOSED;
        neighbourNode.cost = cost;
        neighbourNode.total = total;

        if (neighbourNode.flags & DT_NODE_OPEN) {
          // Already in open, update node location.
          openList.modify(neighbourNode);
        } else {
          // Put the node in open list.
          neighbourNode.flags |= DT_NODE_OPEN;
          openList.push(neighbourNode);
        }

        // Update nearest node to target so far.
        if (heuristic < lastBestNodeCost) {
          lastBestNodeCost = heuristic;
          lastBestNode = neighbourNode;
        }
      }
    }

    let status = this.getPathToNode(lastBestNode, path, pathCount, maxPath);

    if (lastBestNode.id !== endRef) status |= DT_PARTIAL_RESULT;

    if (outOfNodes) status |= DT_OUT_OF_NODES;

    return status;
  }

  /**
   * Gets the path leading to the specified end node.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::getPathToNode
   */
  private getPathToNode(endNode: dtNode, path: Float64Array, pathCount: Int32Array, maxPath: number): dtStatus {
    const nodePool = this.m_nodePool!;
    // Find the length of the entire path.
    let curNode: dtNode | null = endNode;
    let length = 0;
    do {
      length++;
      curNode = nodePool.getNodeAtIdx(curNode.pidx);
    } while (curNode);

    // If the path cannot be fully stored then advance to the last node we will be able to store.
    curNode = endNode;
    let writeCount: number;
    for (writeCount = length; writeCount > maxPath; writeCount--) {
      dtAssert(curNode, "curNode");

      curNode = nodePool.getNodeAtIdx(curNode.pidx);
    }

    // Write path
    for (let i = writeCount - 1; i >= 0; i--) {
      dtAssert(curNode, "curNode");

      path[i] = curNode.id;
      curNode = nodePool.getNodeAtIdx(curNode.pidx);
    }

    dtAssert(!curNode, "!curNode");

    pathCount[0] = dtMin(length, maxPath);

    if (length > maxPath) return DT_SUCCESS | DT_BUFFER_TOO_SMALL;

    return DT_SUCCESS;
  }

  /**
   * Intializes a sliced path query.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::initSlicedFindPath
   */
  initSlicedFindPath(
    startRef: dtPolyRef,
    endRef: dtPolyRef,
    startPos: Float32Array | null,
    endPos: Float32Array | null,
    filter: dtQueryFilter | null,
    options = 0,
  ): dtStatus {
    const nav = this.nav;
    const nodePool = this.m_nodePool!;
    const openList = this.m_openList!;
    const q = this.m_query;

    // Init path state.
    q.clear();
    q.status = DT_FAILURE;
    q.startRef = startRef;
    q.endRef = endRef;
    if (startPos) dtVcopy(q.startPos, 0, startPos, 0);
    if (endPos) dtVcopy(q.endPos, 0, endPos, 0);
    q.filter = filter;
    q.options = options;
    q.raycastLimitSqr = FLT_MAX;

    // Validate input
    if (
      !nav.isValidPolyRef(startRef) ||
      !nav.isValidPolyRef(endRef) ||
      !startPos ||
      !dtVisfinite(startPos, 0) ||
      !endPos ||
      !dtVisfinite(endPos, 0) ||
      !filter
    ) {
      return DT_FAILURE | DT_INVALID_PARAM;
    }

    // trade quality with performance?
    if (options & DT_FINDPATH_ANY_ANGLE) {
      // limiting to several times the character radius yields nice results. It is not sensitive
      // so it is enough to compute it from the first tile.
      const tile = nav.getTileByRef(startRef)!;
      const agentRadius = tile.header!.walkableRadius;
      q.raycastLimitSqr = Math.fround(dtSqr(Math.fround(agentRadius * DT_RAY_CAST_LIMIT_PROPORTIONS)));
    }

    if (startRef === endRef) {
      q.status = DT_SUCCESS;
      return DT_SUCCESS;
    }

    nodePool.clear();
    openList.clear();

    const startNode = nodePool.getNode(startRef)!;
    dtVcopy(startNode.pos, 0, startPos, 0);
    startNode.pidx = 0;
    startNode.cost = 0;
    startNode.total = Math.fround(Math.fround(dtVdist(startPos, 0, endPos, 0)) * H_SCALE);
    startNode.id = startRef;
    startNode.flags = DT_NODE_OPEN;
    openList.push(startNode);

    q.status = DT_IN_PROGRESS;
    q.lastBestNode = startNode;
    q.lastBestNodeCost = startNode.total;

    return q.status;
  }

  /**
   * Updates an in-progress sliced path query. Writes the iteration count to `doneIters[0]`.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::updateSlicedFindPath
   */
  updateSlicedFindPath(maxIter: number, doneIters: Int32Array | null): dtStatus {
    const q = this.m_query;
    if (!dtStatusInProgress(q.status)) return q.status;

    const nav = this.nav;
    const nodePool = this.m_nodePool!;
    const openList = this.m_openList!;
    const filter = q.filter!;

    // Make sure the request is still valid.
    if (!nav.isValidPolyRef(q.startRef) || !nav.isValidPolyRef(q.endRef)) {
      q.status = DT_FAILURE;
      return DT_FAILURE;
    }

    const rayHit = this.slice_rayHit;
    rayHit.maxPath = 0;
    rayHit.path = null;

    const tpBest = this.tpA;
    const tpParent = this.tpB;
    const tpNei = this.tpC;

    let iter = 0;
    while (iter < maxIter && !openList.empty()) {
      iter++;

      // Remove node from open list and put it in closed list.
      const bestNode = openList.pop();
      bestNode.flags &= ~DT_NODE_OPEN;
      bestNode.flags |= DT_NODE_CLOSED;

      // Reached the goal, stop searching.
      if (bestNode.id === q.endRef) {
        q.lastBestNode = bestNode;
        const details = q.status & DT_STATUS_DETAIL_MASK;
        q.status = DT_SUCCESS | details;
        if (doneIters) doneIters[0] = iter;
        return q.status;
      }

      // Get current poly and tile.
      // The API input has been cheked already, skip checking internal data.
      const bestRef = bestNode.id;
      if (dtStatusFailed(nav.getTileAndPolyByRef(bestRef, tpBest))) {
        // The polygon has disappeared during the sliced query, fail.
        q.status = DT_FAILURE;
        if (doneIters) doneIters[0] = iter;
        return q.status;
      }
      const bestTile = tpBest.tile!;
      const bestPoly = tpBest.poly;

      // Get parent and grand parent poly and tile.
      let parentRef: dtPolyRef = 0;
      let grandpaRef: dtPolyRef = 0;
      let parentTile: dtMeshTile | null = null;
      let parentPoly = -1;
      let parentNode: dtNode | null = null;
      if (bestNode.pidx) {
        parentNode = nodePool.getNodeAtIdx(bestNode.pidx)!;
        parentRef = parentNode.id;
        if (parentNode.pidx) grandpaRef = nodePool.getNodeAtIdx(parentNode.pidx)!.id;
      }
      if (parentRef) {
        const invalidParent = dtStatusFailed(nav.getTileAndPolyByRef(parentRef, tpParent));
        if (invalidParent || (grandpaRef && !nav.isValidPolyRef(grandpaRef))) {
          // The polygon has disappeared during the sliced query, fail.
          q.status = DT_FAILURE;
          if (doneIters) doneIters[0] = iter;
          return q.status;
        }
        parentTile = tpParent.tile;
        parentPoly = tpParent.poly;
      }

      // decide whether to test raycast to previous nodes
      let tryLOS = false;
      if (q.options & DT_FINDPATH_ANY_ANGLE) {
        if (parentRef !== 0 && dtVdistSqr(parentNode!.pos, 0, bestNode.pos, 0) < q.raycastLimitSqr) tryLOS = true;
      }

      for (let i = bestTile.polyFirstLink(bestPoly); i !== DT_NULL_LINK; i = bestTile.linkNext(i)) {
        const neighbourRef = bestTile.linkRef(i);

        // Skip invalid ids and do not expand back to where we came from.
        if (!neighbourRef || neighbourRef === parentRef) continue;

        // Get neighbour poly and tile.
        // The API input has been cheked already, skip checking internal data.
        nav.getTileAndPolyByRefUnsafe(neighbourRef, tpNei);
        const neighbourTile = tpNei.tile!;
        const neighbourPoly = tpNei.poly;

        if (!filter.passFilter(neighbourRef, neighbourTile, neighbourPoly)) continue;

        // get the neighbor node
        const neighbourNode = nodePool.getNode(neighbourRef, 0);
        if (!neighbourNode) {
          q.status |= DT_OUT_OF_NODES;
          continue;
        }

        // do not expand to nodes that were already visited from the same parent
        if (neighbourNode.pidx !== 0 && neighbourNode.pidx === bestNode.pidx) continue;

        // If the node is visited the first time, calculate node position.
        if (neighbourNode.flags === 0) {
          this.getEdgeMidPoint(bestRef, bestPoly, bestTile, neighbourRef, neighbourPoly, neighbourTile, neighbourNode.pos);
        }

        // Calculate cost and heuristic.
        let cost = 0;
        let heuristic = 0;

        // raycast parent
        let foundShortCut = false;
        rayHit.pathCost = rayHit.t = 0;
        if (tryLOS) {
          this.raycastImpl(parentRef, parentNode!.pos, neighbourNode.pos, filter, DT_RAYCAST_USE_COSTS, rayHit, grandpaRef);
          foundShortCut = rayHit.t >= 1.0;
        }

        // update move cost
        if (foundShortCut) {
          // shortcut found using raycast. Using shorter cost instead
          cost = Math.fround(parentNode!.cost + rayHit.pathCost);
        } else {
          // No shortcut found.
          const curCost = Math.fround(
            filter.getCost(
              bestNode.pos,
              neighbourNode.pos,
              parentRef,
              parentTile,
              parentPoly,
              bestRef,
              bestTile,
              bestPoly,
              neighbourRef,
              neighbourTile,
              neighbourPoly,
            ),
          );
          cost = Math.fround(bestNode.cost + curCost);
        }

        // Special case for last node.
        if (neighbourRef === q.endRef) {
          const endCost = Math.fround(
            filter.getCost(neighbourNode.pos, q.endPos, bestRef, bestTile, bestPoly, neighbourRef, neighbourTile, neighbourPoly, 0, null, -1),
          );

          cost = Math.fround(cost + endCost);
          heuristic = 0;
        } else {
          heuristic = Math.fround(Math.fround(dtVdist(neighbourNode.pos, 0, q.endPos, 0)) * H_SCALE);
        }

        const total = Math.fround(cost + heuristic);

        // The node is already in open list and the new result is worse, skip.
        if (neighbourNode.flags & DT_NODE_OPEN && total >= neighbourNode.total) continue;
        // The node is already visited and process, and the new result is worse, skip.
        if (neighbourNode.flags & DT_NODE_CLOSED && total >= neighbourNode.total) continue;

        // Add or update the node.
        neighbourNode.pidx = foundShortCut ? bestNode.pidx : nodePool.getNodeIdx(bestNode);
        neighbourNode.id = neighbourRef;
        neighbourNode.flags = neighbourNode.flags & ~(DT_NODE_CLOSED | DT_NODE_PARENT_DETACHED);
        neighbourNode.cost = cost;
        neighbourNode.total = total;
        if (foundShortCut) neighbourNode.flags = neighbourNode.flags | DT_NODE_PARENT_DETACHED;

        if (neighbourNode.flags & DT_NODE_OPEN) {
          // Already in open, update node location.
          openList.modify(neighbourNode);
        } else {
          // Put the node in open list.
          neighbourNode.flags |= DT_NODE_OPEN;
          openList.push(neighbourNode);
        }

        // Update nearest node to target so far.
        if (heuristic < q.lastBestNodeCost) {
          q.lastBestNodeCost = heuristic;
          q.lastBestNode = neighbourNode;
        }
      }
    }

    // Exhausted all nodes, but could not find path.
    if (openList.empty()) {
      const details = q.status & DT_STATUS_DETAIL_MASK;
      q.status = DT_SUCCESS | details;
    }

    if (doneIters) doneIters[0] = iter;

    return q.status;
  }

  /**
   * Finalizes and returns the results of a sliced path query.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::finalizeSlicedFindPath
   */
  finalizeSlicedFindPath(path: Float64Array | null, pathCount: Int32Array | null, maxPath: number): dtStatus {
    if (!pathCount) return DT_FAILURE | DT_INVALID_PARAM;

    pathCount[0] = 0;

    if (!path || maxPath <= 0) return DT_FAILURE | DT_INVALID_PARAM;

    const q = this.m_query;
    if (dtStatusFailed(q.status)) {
      // Reset query.
      q.clear();
      return DT_FAILURE;
    }

    let n = 0;

    if (q.startRef === q.endRef) {
      // Special case: the search starts and ends at same poly.
      path[n++] = q.startRef;
    } else {
      // Reverse the path.
      dtAssert(q.lastBestNode, "m_query.lastBestNode");

      if (q.lastBestNode.id !== q.endRef) q.status |= DT_PARTIAL_RESULT;

      n = this.storeReversedSlicedPath(q.lastBestNode, path, maxPath);
    }

    const details = q.status & DT_STATUS_DETAIL_MASK;

    // Reset query.
    q.clear();

    pathCount[0] = n;

    return DT_SUCCESS | details;
  }

  /**
   * The shared "Reverse the path" and "Store path" loops of `finalizeSlicedFindPath` and
   * `finalizeSlicedFindPathPartial`; returns `n`.
   */
  private storeReversedSlicedPath(start: dtNode, path: Float64Array, maxPath: number): number {
    const nodePool = this.m_nodePool!;
    const q = this.m_query;
    let n = 0;

    let prev: dtNode | null = null;
    let node: dtNode | null = start;
    let prevRay = 0;
    do {
      const next: dtNode | null = nodePool.getNodeAtIdx(node.pidx);
      node.pidx = nodePool.getNodeIdx(prev);
      prev = node;
      const nextRay = node.flags & DT_NODE_PARENT_DETACHED; // keep track of whether parent is not adjacent (i.e. due to raycast shortcut)
      node.flags = (node.flags & ~DT_NODE_PARENT_DETACHED) | prevRay; // and store it in the reversed path's node
      prevRay = nextRay;
      node = next;
    } while (node);

    // Store path
    node = prev;
    do {
      const next: dtNode | null = nodePool.getNodeAtIdx(node!.pidx);
      let status: dtStatus = 0;
      if (node!.flags & DT_NODE_PARENT_DETACHED) {
        const m = this.fin_m;
        status = this.raycast(node!.id, node!.pos, next!.pos, q.filter, this.fin_t, this.fin_normal, path.subarray(n), m, maxPath - n);
        n += m[0]!;
        // raycast ends on poly boundary and the path might include the next poly boundary.
        if (path[n - 1] === next!.id) n--; // remove to avoid duplicates
      } else {
        path[n++] = node!.id;
        if (n >= maxPath) status = DT_BUFFER_TOO_SMALL;
      }

      if (status & DT_STATUS_DETAIL_MASK) {
        q.status |= status & DT_STATUS_DETAIL_MASK;
        break;
      }
      node = next;
    } while (node);

    return n;
  }

  /**
   * Finalizes and returns the results of an incomplete sliced path query, returning the path to the furthest
   * polygon on the existing path that was visited during the search.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::finalizeSlicedFindPathPartial
   */
  finalizeSlicedFindPathPartial(
    existing: Float64Array | null,
    existingSize: number,
    path: Float64Array | null,
    pathCount: Int32Array | null,
    maxPath: number,
  ): dtStatus {
    if (!pathCount) return DT_FAILURE | DT_INVALID_PARAM;

    pathCount[0] = 0;

    if (!existing || existingSize <= 0 || !path || !pathCount || maxPath <= 0) return DT_FAILURE | DT_INVALID_PARAM;

    const q = this.m_query;
    if (dtStatusFailed(q.status)) {
      // Reset query.
      q.clear();
      return DT_FAILURE;
    }

    let n = 0;

    if (q.startRef === q.endRef) {
      // Special case: the search starts and ends at same poly.
      path[n++] = q.startRef;
    } else {
      // Find furthest existing node that was visited.
      const nodeOut = this.fsp_node;
      nodeOut[0] = null;
      let node: dtNode | null = null;
      for (let i = existingSize - 1; i >= 0; --i) {
        nodeOut[0] = null;
        this.m_nodePool!.findNodes(existing[i]!, nodeOut, 1);
        node = nodeOut[0];
        if (node) break;
      }

      if (!node) {
        q.status |= DT_PARTIAL_RESULT;
        dtAssert(q.lastBestNode, "m_query.lastBestNode");
        node = q.lastBestNode;
      }

      n = this.storeReversedSlicedPath(node, path, maxPath);
    }

    const details = q.status & DT_STATUS_DETAIL_MASK;

    // Reset query.
    q.clear();

    pathCount[0] = n;

    return DT_SUCCESS | details;
  }

  /**
   * Appends vertex to a straight path
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::appendVertex
   */
  private appendVertex(
    pos: Float32Array,
    posi: number,
    flags: number,
    ref: dtPolyRef,
    straightPath: Float32Array,
    straightPathFlags: Uint8Array | null,
    straightPathRefs: Float64Array | null,
    straightPathCount: Int32Array,
    maxStraightPath: number,
  ): dtStatus {
    const count = straightPathCount[0]!;
    if (count > 0 && dtVequal(straightPath, (count - 1) * 3, pos, posi)) {
      // The vertices are equal, update flags and poly.
      if (straightPathFlags) straightPathFlags[count - 1] = flags;
      if (straightPathRefs) straightPathRefs[count - 1] = ref;
    } else {
      // Append new vertex.
      dtVcopy(straightPath, count * 3, pos, posi);
      if (straightPathFlags) straightPathFlags[count] = flags;
      if (straightPathRefs) straightPathRefs[count] = ref;
      straightPathCount[0] = count + 1;

      // If there is no space to append more vertices, return.
      if (count + 1 >= maxStraightPath) {
        return DT_SUCCESS | DT_BUFFER_TOO_SMALL;
      }

      // If reached end of path, return.
      if (flags === DT_STRAIGHTPATH_END) {
        return DT_SUCCESS;
      }
    }
    return DT_IN_PROGRESS;
  }

  /**
   * Appends intermediate portal points to a straight path.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::appendPortals
   */
  private appendPortals(
    startIdx: number,
    endIdx: number,
    endPos: Float32Array,
    path: Float64Array,
    straightPath: Float32Array,
    straightPathFlags: Uint8Array | null,
    straightPathRefs: Float64Array | null,
    straightPathCount: Int32Array,
    maxStraightPath: number,
    options: number,
  ): dtStatus {
    const nav = this.nav;
    const startPos = (straightPathCount[0]! - 1) * 3;
    // Append or update last vertex
    let stat: dtStatus = 0;
    const tpFrom = this.tpAppend;
    const tpTo = this.tpPortal;
    for (let i = startIdx; i < endIdx; i++) {
      // Calculate portal
      const from = path[i]!;
      if (dtStatusFailed(nav.getTileAndPolyByRef(from, tpFrom))) return DT_FAILURE | DT_INVALID_PARAM;
      const fromTile = tpFrom.tile!;
      const fromPoly = tpFrom.poly;

      const to = path[i + 1]!;
      if (dtStatusFailed(nav.getTileAndPolyByRef(to, tpTo))) return DT_FAILURE | DT_INVALID_PARAM;
      const toTile = tpTo.tile!;
      const toPoly = tpTo.poly;

      const left = this.ap_left;
      const right = this.ap_right;
      if (dtStatusFailed(this.getPortalPoints(from, fromPoly, fromTile, to, toPoly, toTile, left, right))) break;

      if (options & DT_STRAIGHTPATH_AREA_CROSSINGS) {
        // Skip intersection if only area crossings are requested.
        if (fromTile.polyGetArea(fromPoly) === toTile.polyGetArea(toPoly)) continue;
      }

      // Append intersection
      const seg = this.ap_seg;
      if (dtIntersectSegSeg2D(straightPath, startPos, endPos, 0, left, 0, right, 0, seg)) {
        const pt = this.ap_pt;
        dtVlerp(pt, 0, left, 0, right, 0, seg.t);

        stat = this.appendVertex(pt, 0, 0, path[i + 1]!, straightPath, straightPathFlags, straightPathRefs, straightPathCount, maxStraightPath);
        if (stat !== DT_IN_PROGRESS) return stat;
      }
    }
    return DT_IN_PROGRESS;
  }

  /**
   * Finds the straight path from the start to the end position within the polygon corridor ('string pulling').
   * Corners go to `straightPath` (3 floats each), their flags to `straightPathFlags`, the entered polygons to
   * `straightPathRefs`, and the count to `straightPathCount[0]`.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::findStraightPath
   */
  findStraightPath(
    startPos: Float32Array | null,
    endPos: Float32Array | null,
    path: Float64Array | null,
    pathSize: number,
    straightPath: Float32Array,
    straightPathFlags: Uint8Array | null,
    straightPathRefs: Float64Array | null,
    straightPathCount: Int32Array | null,
    maxStraightPath: number,
    options = 0,
  ): dtStatus {
    this.nav;

    if (!straightPathCount) return DT_FAILURE | DT_INVALID_PARAM;

    straightPathCount[0] = 0;

    if (!startPos || !dtVisfinite(startPos, 0) || !endPos || !dtVisfinite(endPos, 0) || !path || pathSize <= 0 || !path[0] || maxStraightPath <= 0) {
      return DT_FAILURE | DT_INVALID_PARAM;
    }

    let stat: dtStatus = 0;

    // TODO: Should this be callers responsibility?
    const closestStartPos = this.fsp_closestStartPos;
    if (dtStatusFailed(this.closestPointOnPolyBoundary(path[0]!, startPos, closestStartPos))) return DT_FAILURE | DT_INVALID_PARAM;

    const closestEndPos = this.fsp_closestEndPos;
    if (dtStatusFailed(this.closestPointOnPolyBoundary(path[pathSize - 1]!, endPos, closestEndPos))) return DT_FAILURE | DT_INVALID_PARAM;

    // Add start point.
    stat = this.appendVertex(closestStartPos, 0, DT_STRAIGHTPATH_START, path[0]!, straightPath, straightPathFlags, straightPathRefs, straightPathCount, maxStraightPath);
    if (stat !== DT_IN_PROGRESS) return stat;

    if (pathSize > 1) {
      const portalApex = this.fsp_portalApex;
      const portalLeft = this.fsp_portalLeft;
      const portalRight = this.fsp_portalRight;
      dtVcopy(portalApex, 0, closestStartPos, 0);
      dtVcopy(portalLeft, 0, portalApex, 0);
      dtVcopy(portalRight, 0, portalApex, 0);
      let apexIndex = 0;
      let leftIndex = 0;
      let rightIndex = 0;

      let leftPolyType = 0;
      let rightPolyType = 0;

      let leftPolyRef: dtPolyRef = path[0]!;
      let rightPolyRef: dtPolyRef = path[0]!;

      const left = this.fsp_left;
      const right = this.fsp_right;
      const types = this.fsp_types;

      for (let i = 0; i < pathSize; ++i) {
        let toType: number;

        if (i + 1 < pathSize) {
          // Next portal. (fromType is ignored.)
          if (dtStatusFailed(this.getPortalPointsByRef(path[i]!, path[i + 1]!, left, right, types))) {
            // Failed to get portal points, in practice this means that path[i+1] is invalid polygon.
            // Clamp the end point to path[i], and return the path so far.

            if (dtStatusFailed(this.closestPointOnPolyBoundary(path[i]!, endPos, closestEndPos))) {
              // This should only happen when the first polygon is invalid.
              return DT_FAILURE | DT_INVALID_PARAM;
            }

            // Apeend portals along the current straight path segment.
            if (options & (DT_STRAIGHTPATH_AREA_CROSSINGS | DT_STRAIGHTPATH_ALL_CROSSINGS)) {
              // Ignore status return value as we're just about to return anyway.
              this.appendPortals(apexIndex, i, closestEndPos, path, straightPath, straightPathFlags, straightPathRefs, straightPathCount, maxStraightPath, options);
            }

            // Ignore status return value as we're just about to return anyway.
            this.appendVertex(closestEndPos, 0, 0, path[i]!, straightPath, straightPathFlags, straightPathRefs, straightPathCount, maxStraightPath);

            return DT_SUCCESS | DT_PARTIAL_RESULT | (straightPathCount[0]! >= maxStraightPath ? DT_BUFFER_TOO_SMALL : 0);
          }
          toType = types[1]!;

          // If starting really close the portal, advance.
          if (i === 0) {
            if (dtDistancePtSegSqr2D(portalApex, 0, left, 0, right, 0, this.fsp_t, 0) < Math.fround(dtSqr(Math.fround(0.001)))) continue;
          }
        } else {
          // End of the path.
          dtVcopy(left, 0, closestEndPos, 0);
          dtVcopy(right, 0, closestEndPos, 0);

          toType = DT_POLYTYPE_GROUND;
        }

        // Right vertex.
        if (dtTriArea2D(portalApex, 0, portalRight, 0, right, 0) <= 0.0) {
          if (dtVequal(portalApex, 0, portalRight, 0) || dtTriArea2D(portalApex, 0, portalLeft, 0, right, 0) > 0.0) {
            dtVcopy(portalRight, 0, right, 0);
            rightPolyRef = i + 1 < pathSize ? path[i + 1]! : 0;
            rightPolyType = toType;
            rightIndex = i;
          } else {
            // Append portals along the current straight path segment.
            if (options & (DT_STRAIGHTPATH_AREA_CROSSINGS | DT_STRAIGHTPATH_ALL_CROSSINGS)) {
              stat = this.appendPortals(apexIndex, leftIndex, portalLeft, path, straightPath, straightPathFlags, straightPathRefs, straightPathCount, maxStraightPath, options);
              if (stat !== DT_IN_PROGRESS) return stat;
            }

            dtVcopy(portalApex, 0, portalLeft, 0);
            apexIndex = leftIndex;

            let flags = 0;
            if (!leftPolyRef) flags = DT_STRAIGHTPATH_END;
            else if (leftPolyType === DT_POLYTYPE_OFFMESH_CONNECTION) flags = DT_STRAIGHTPATH_OFFMESH_CONNECTION;
            const ref = leftPolyRef;

            // Append or update vertex
            stat = this.appendVertex(portalApex, 0, flags, ref, straightPath, straightPathFlags, straightPathRefs, straightPathCount, maxStraightPath);
            if (stat !== DT_IN_PROGRESS) return stat;

            dtVcopy(portalLeft, 0, portalApex, 0);
            dtVcopy(portalRight, 0, portalApex, 0);
            leftIndex = apexIndex;
            rightIndex = apexIndex;

            // Restart
            i = apexIndex;

            continue;
          }
        }

        // Left vertex.
        if (dtTriArea2D(portalApex, 0, portalLeft, 0, left, 0) >= 0.0) {
          if (dtVequal(portalApex, 0, portalLeft, 0) || dtTriArea2D(portalApex, 0, portalRight, 0, left, 0) < 0.0) {
            dtVcopy(portalLeft, 0, left, 0);
            leftPolyRef = i + 1 < pathSize ? path[i + 1]! : 0;
            leftPolyType = toType;
            leftIndex = i;
          } else {
            // Append portals along the current straight path segment.
            if (options & (DT_STRAIGHTPATH_AREA_CROSSINGS | DT_STRAIGHTPATH_ALL_CROSSINGS)) {
              stat = this.appendPortals(apexIndex, rightIndex, portalRight, path, straightPath, straightPathFlags, straightPathRefs, straightPathCount, maxStraightPath, options);
              if (stat !== DT_IN_PROGRESS) return stat;
            }

            dtVcopy(portalApex, 0, portalRight, 0);
            apexIndex = rightIndex;

            let flags = 0;
            if (!rightPolyRef) flags = DT_STRAIGHTPATH_END;
            else if (rightPolyType === DT_POLYTYPE_OFFMESH_CONNECTION) flags = DT_STRAIGHTPATH_OFFMESH_CONNECTION;
            const ref = rightPolyRef;

            // Append or update vertex
            stat = this.appendVertex(portalApex, 0, flags, ref, straightPath, straightPathFlags, straightPathRefs, straightPathCount, maxStraightPath);
            if (stat !== DT_IN_PROGRESS) return stat;

            dtVcopy(portalLeft, 0, portalApex, 0);
            dtVcopy(portalRight, 0, portalApex, 0);
            leftIndex = apexIndex;
            rightIndex = apexIndex;

            // Restart
            i = apexIndex;

            continue;
          }
        }
      }

      // Append portals along the current straight path segment.
      if (options & (DT_STRAIGHTPATH_AREA_CROSSINGS | DT_STRAIGHTPATH_ALL_CROSSINGS)) {
        stat = this.appendPortals(apexIndex, pathSize - 1, closestEndPos, path, straightPath, straightPathFlags, straightPathRefs, straightPathCount, maxStraightPath, options);
        if (stat !== DT_IN_PROGRESS) return stat;
      }
    }

    // Ignore status return value as we're just about to return anyway.
    this.appendVertex(closestEndPos, 0, DT_STRAIGHTPATH_END, 0, straightPath, straightPathFlags, straightPathRefs, straightPathCount, maxStraightPath);

    return DT_SUCCESS | (straightPathCount[0]! >= maxStraightPath ? DT_BUFFER_TOO_SMALL : 0);
  }

  /**
   * Moves from the start to the end position constrained to the navigation mesh. The visited polygons go to
   * `visited`, their count to `visitedCount[0]`.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::moveAlongSurface
   */
  moveAlongSurface(
    startRef: dtPolyRef,
    startPos: Float32Array | null,
    endPos: Float32Array | null,
    filter: dtQueryFilter | null,
    resultPos: Float32Array | null,
    visited: Float64Array | null,
    visitedCount: Int32Array | null,
    maxVisitedSize: number,
  ): dtStatus {
    const nav = this.nav;
    const tinyNodePool = this.m_tinyNodePool!;

    if (!visitedCount) return DT_FAILURE | DT_INVALID_PARAM;

    visitedCount[0] = 0;

    if (
      !nav.isValidPolyRef(startRef) ||
      !startPos ||
      !dtVisfinite(startPos, 0) ||
      !endPos ||
      !dtVisfinite(endPos, 0) ||
      !filter ||
      !resultPos ||
      !visited ||
      maxVisitedSize <= 0
    ) {
      return DT_FAILURE | DT_INVALID_PARAM;
    }

    let status: dtStatus = DT_SUCCESS;

    const stack = this.mas_stack;
    let nstack = 0;

    tinyNodePool.clear();

    const startNode = tinyNodePool.getNode(startRef)!;
    startNode.pidx = 0;
    startNode.cost = 0;
    startNode.total = 0;
    startNode.id = startRef;
    startNode.flags = DT_NODE_CLOSED;
    stack[nstack++] = startNode;

    const bestPos = this.mas_bestPos;
    let bestDist = FLT_MAX;
    let bestNode: dtNode | null = null;
    dtVcopy(bestPos, 0, startPos, 0);

    // Search constraints
    const searchPos = this.mas_searchPos;
    dtVlerp(searchPos, 0, startPos, 0, endPos, 0, 0.5);
    const searchRadSqr = dtSqr(dtVdist(startPos, 0, endPos, 0) / 2.0 + 0.001);

    const verts = this.mas_verts;
    const tp = this.tpA;
    const tpNei = this.tpB;
    const tseg = this.mas_tseg;

    while (nstack) {
      // Pop front.
      const curNode = stack[0]!;
      for (let i = 0; i < nstack - 1; ++i) stack[i] = stack[i + 1]!;
      nstack--;

      // Get poly and tile.
      // The API input has been cheked already, skip checking internal data.
      const curRef = curNode.id;
      nav.getTileAndPolyByRefUnsafe(curRef, tp);
      const curTile = tp.tile!;
      const curPoly = tp.poly;

      // Collect vertices.
      const nverts = curTile.polyVertCount(curPoly);
      for (let i = 0; i < nverts; ++i) dtVcopy(verts, i * 3, curTile.verts, curTile.polyVerts(curPoly, i) * 3);

      // If target is inside the poly, stop search.
      if (dtPointInPolygon(endPos, 0, verts, nverts)) {
        bestNode = curNode;
        dtVcopy(bestPos, 0, endPos, 0);
        break;
      }

      // Find wall edges and find nearest point inside the walls.
      for (let i = 0, j = nverts - 1; i < nverts; j = i++) {
        // Find links to neighbours.
        let nneis = 0;
        const neis = this.mas_neis;

        const curNei = curTile.polyNeis(curPoly, j);
        if (curNei & DT_EXT_LINK) {
          // Tile border.
          for (let k = curTile.polyFirstLink(curPoly); k !== DT_NULL_LINK; k = curTile.linkNext(k)) {
            if (curTile.linkEdge(k) === j) {
              const linkRef = curTile.linkRef(k);
              if (linkRef !== 0) {
                nav.getTileAndPolyByRefUnsafe(linkRef, tpNei);
                if (filter.passFilter(linkRef, tpNei.tile!, tpNei.poly)) {
                  if (nneis < MAX_NEIS_MOVE) neis[nneis++] = linkRef;
                }
              }
            }
          }
        } else if (curNei) {
          const idx = curNei - 1;
          const ref = nav.getPolyRefBase(curTile) + idx;
          if (filter.passFilter(ref, curTile, idx)) {
            // Internal edge, encode id.
            neis[nneis++] = ref;
          }
        }

        if (!nneis) {
          // Wall edge, calc distance.
          const vj = j * 3;
          const vi = i * 3;
          const distSqr = dtDistancePtSegSqr2D(endPos, 0, verts, vj, verts, vi, tseg, 0);
          if (distSqr < bestDist) {
            // Update nearest distance.
            dtVlerp(bestPos, 0, verts, vj, verts, vi, tseg[0]!);
            bestDist = distSqr;
            bestNode = curNode;
          }
        } else {
          for (let k = 0; k < nneis; ++k) {
            // Skip if no node can be allocated.
            const neighbourNode = tinyNodePool.getNode(neis[k]!);
            if (!neighbourNode) continue;
            // Skip if already visited.
            if (neighbourNode.flags & DT_NODE_CLOSED) continue;

            // Skip the link if it is too far from search constraint.
            // TODO: Maybe should use getPortalPoints(), but this one is way faster.
            const vj = j * 3;
            const vi = i * 3;
            const distSqr = dtDistancePtSegSqr2D(searchPos, 0, verts, vj, verts, vi, tseg, 0);
            if (distSqr > searchRadSqr) continue;

            // Mark as the node as visited and push to queue.
            if (nstack < MAX_STACK) {
              neighbourNode.pidx = tinyNodePool.getNodeIdx(curNode);
              neighbourNode.flags |= DT_NODE_CLOSED;
              stack[nstack++] = neighbourNode;
            }
          }
        }
      }
    }

    let n = 0;
    if (bestNode) {
      // Reverse the path.
      let prev: dtNode | null = null;
      let node: dtNode | null = bestNode;
      do {
        const next: dtNode | null = tinyNodePool.getNodeAtIdx(node.pidx);
        node.pidx = tinyNodePool.getNodeIdx(prev);
        prev = node;
        node = next;
      } while (node);

      // Store result
      node = prev;
      do {
        visited[n++] = node!.id;
        if (n >= maxVisitedSize) {
          status |= DT_BUFFER_TOO_SMALL;
          break;
        }
        node = tinyNodePool.getNodeAtIdx(node!.pidx);
      } while (node);
    }

    dtVcopy(resultPos, 0, bestPos, 0);

    visitedCount[0] = n;

    return status;
  }

  /**
   * Returns portal points between two polygons (the `(from, to, left, right, fromType, toType)` overload; the types
   * are written to `types[0]` / `types[1]`).
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::getPortalPoints
   */
  private getPortalPointsByRef(from: dtPolyRef, to: dtPolyRef, left: Float32Array, right: Float32Array, types: Uint8Array): dtStatus {
    const nav = this.nav;

    const tpFrom = this.tpPortal;
    if (dtStatusFailed(nav.getTileAndPolyByRef(from, tpFrom))) return DT_FAILURE | DT_INVALID_PARAM;
    const fromTile = tpFrom.tile!;
    const fromPoly = tpFrom.poly;
    types[0] = fromTile.polyGetType(fromPoly);

    const tpTo = this.tpValid;
    if (dtStatusFailed(nav.getTileAndPolyByRef(to, tpTo))) return DT_FAILURE | DT_INVALID_PARAM;
    const toTile = tpTo.tile!;
    const toPoly = tpTo.poly;
    types[1] = toTile.polyGetType(toPoly);

    return this.getPortalPoints(from, fromPoly, fromTile, to, toPoly, toTile, left, right);
  }

  /**
   * Returns portal points between two polygons.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::getPortalPoints
   */
  private getPortalPoints(
    from: dtPolyRef,
    fromPoly: number,
    fromTile: dtMeshTile,
    to: dtPolyRef,
    toPoly: number,
    toTile: dtMeshTile,
    left: Float32Array,
    right: Float32Array,
  ): dtStatus {
    // Find the link that points to the 'to' polygon.
    let link = -1;
    for (let i = fromTile.polyFirstLink(fromPoly); i !== DT_NULL_LINK; i = fromTile.linkNext(i)) {
      if (fromTile.linkRef(i) === to) {
        link = i;
        break;
      }
    }
    if (link < 0) return DT_FAILURE | DT_INVALID_PARAM;

    // Handle off-mesh connections.
    if (fromTile.polyGetType(fromPoly) === DT_POLYTYPE_OFFMESH_CONNECTION) {
      // Find link that points to first vertex.
      for (let i = fromTile.polyFirstLink(fromPoly); i !== DT_NULL_LINK; i = fromTile.linkNext(i)) {
        if (fromTile.linkRef(i) === to) {
          const v = fromTile.linkEdge(i);
          dtVcopy(left, 0, fromTile.verts, fromTile.polyVerts(fromPoly, v) * 3);
          dtVcopy(right, 0, fromTile.verts, fromTile.polyVerts(fromPoly, v) * 3);
          return DT_SUCCESS;
        }
      }
      return DT_FAILURE | DT_INVALID_PARAM;
    }

    if (toTile.polyGetType(toPoly) === DT_POLYTYPE_OFFMESH_CONNECTION) {
      for (let i = toTile.polyFirstLink(toPoly); i !== DT_NULL_LINK; i = toTile.linkNext(i)) {
        if (toTile.linkRef(i) === from) {
          const v = toTile.linkEdge(i);
          dtVcopy(left, 0, toTile.verts, toTile.polyVerts(toPoly, v) * 3);
          dtVcopy(right, 0, toTile.verts, toTile.polyVerts(toPoly, v) * 3);
          return DT_SUCCESS;
        }
      }
      return DT_FAILURE | DT_INVALID_PARAM;
    }

    // Find portal vertices.
    const edge = fromTile.linkEdge(link);
    const v0 = fromTile.polyVerts(fromPoly, edge);
    const v1 = fromTile.polyVerts(fromPoly, (edge + 1) % fromTile.polyVertCount(fromPoly));
    dtVcopy(left, 0, fromTile.verts, v0 * 3);
    dtVcopy(right, 0, fromTile.verts, v1 * 3);

    // If the link is at tile boundary, dtClamp the vertices to
    // the link width.
    if (fromTile.linkSide(link) !== 0xff) {
      // Unpack portal limits.
      const lbmin = fromTile.linkBmin(link);
      const lbmax = fromTile.linkBmax(link);
      if (lbmin !== 0 || lbmax !== 255) {
        const s = Math.fround(1.0 / 255.0);
        const tmin = Math.fround(lbmin * s);
        const tmax = Math.fround(lbmax * s);
        dtVlerp(left, 0, fromTile.verts, v0 * 3, fromTile.verts, v1 * 3, tmin);
        dtVlerp(right, 0, fromTile.verts, v0 * 3, fromTile.verts, v1 * 3, tmax);
      }
    }

    return DT_SUCCESS;
  }

  /**
   * Returns edge mid point between two polygons (the ref-only overload).
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::getEdgeMidPoint
   */
  private getEdgeMidPointByRef(from: dtPolyRef, to: dtPolyRef, mid: Float32Array): dtStatus {
    const left = this.gem_left;
    const right = this.gem_right;
    if (dtStatusFailed(this.getPortalPointsByRef(from, to, left, right, this.gem_types))) return DT_FAILURE | DT_INVALID_PARAM;
    mid[0] = (left[0]! + right[0]!) * 0.5;
    mid[1] = (left[1]! + right[1]!) * 0.5;
    mid[2] = (left[2]! + right[2]!) * 0.5;
    return DT_SUCCESS;
  }

  /**
   * Returns edge mid point between two polygons.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::getEdgeMidPoint
   */
  private getEdgeMidPoint(
    from: dtPolyRef,
    fromPoly: number,
    fromTile: dtMeshTile,
    to: dtPolyRef,
    toPoly: number,
    toTile: dtMeshTile,
    mid: Float32Array,
  ): dtStatus {
    const left = this.gpp_left;
    const right = this.gpp_right;
    if (dtStatusFailed(this.getPortalPoints(from, fromPoly, fromTile, to, toPoly, toTile, left, right))) return DT_FAILURE | DT_INVALID_PARAM;
    mid[0] = (left[0]! + right[0]!) * 0.5;
    mid[1] = (left[1]! + right[1]!) * 0.5;
    mid[2] = (left[2]! + right[2]!) * 0.5;
    return DT_SUCCESS;
  }

  /**
   * Casts a 'walkability' ray along the surface of the navigation mesh from the start position toward the end
   * position. The first overload writes the hit parameter to `t[0]` (FLT_MAX when the end was reached), the normal
   * to `hitNormal`, the visited polygons to `path` and their count to `pathCount[0]`. The second fills a
   * `dtRaycastHit`.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::raycast
   */
  raycast(
    startRef: dtPolyRef,
    startPos: Float32Array | null,
    endPos: Float32Array | null,
    filter: dtQueryFilter | null,
    t: Float32Array,
    hitNormal: Float32Array | null,
    path: Float64Array | null,
    pathCount: Int32Array | null,
    maxPath: number,
  ): dtStatus;
  raycast(
    startRef: dtPolyRef,
    startPos: Float32Array | null,
    endPos: Float32Array | null,
    filter: dtQueryFilter | null,
    options: number,
    hit: dtRaycastHit | null,
    prevRef?: dtPolyRef,
  ): dtStatus;
  raycast(
    startRef: dtPolyRef,
    startPos: Float32Array | null,
    endPos: Float32Array | null,
    filter: dtQueryFilter | null,
    tOrOptions: Float32Array | number,
    hitNormalOrHit: Float32Array | dtRaycastHit | null,
    pathOrPrevRef?: Float64Array | dtPolyRef | null,
    pathCount?: Int32Array | null,
    maxPath?: number,
  ): dtStatus {
    if (typeof tOrOptions === "number") {
      return this.raycastImpl(startRef, startPos, endPos, filter, tOrOptions, hitNormalOrHit as dtRaycastHit | null, (pathOrPrevRef as dtPolyRef | undefined) ?? 0);
    }
    const t = tOrOptions;
    const hitNormal = hitNormalOrHit as Float32Array | null;
    const path = (pathOrPrevRef as Float64Array | null | undefined) ?? null;

    const hit = this.ray_hit;
    hit.path = path;
    hit.maxPath = maxPath ?? 0;

    const status = this.raycastImpl(startRef, startPos, endPos, filter, 0, hit, 0);

    t[0] = hit.t;
    if (hitNormal) dtVcopy(hitNormal, 0, hit.hitNormal, 0);
    if (pathCount) pathCount[0] = hit.pathCount;

    hit.path = null;
    return status;
  }

  /** The `raycast(..., options, dtRaycastHit* hit, dtPolyRef prevRef)` overload. */
  private raycastImpl(
    startRef: dtPolyRef,
    startPos: Float32Array | null,
    endPos: Float32Array | null,
    filter: dtQueryFilter | null,
    options: number,
    hit: dtRaycastHit | null,
    prevRef: dtPolyRef,
  ): dtStatus {
    const nav = this.nav;

    if (!hit) return DT_FAILURE | DT_INVALID_PARAM;

    hit.t = 0;
    hit.pathCount = 0;
    hit.pathCost = 0;

    // Validate input
    if (
      !nav.isValidPolyRef(startRef) ||
      !startPos ||
      !dtVisfinite(startPos, 0) ||
      !endPos ||
      !dtVisfinite(endPos, 0) ||
      !filter ||
      (prevRef && !nav.isValidPolyRef(prevRef))
    ) {
      return DT_FAILURE | DT_INVALID_PARAM;
    }

    const dir = this.ray_dir;
    const curPos = this.ray_curPos;
    const lastPos = this.ray_lastPos;
    const verts = this.ray_verts;
    let n = 0;

    dtVcopy(curPos, 0, startPos, 0);
    dtVsub(dir, 0, endPos, 0, startPos, 0);
    dtVset(hit.hitNormal, 0, 0, 0, 0);

    let status: dtStatus = DT_SUCCESS;

    const tp = this.tpRay;

    // The API input has been checked already, skip checking internal data.
    let curRef: dtPolyRef = startRef;
    nav.getTileAndPolyByRefUnsafe(curRef, tp);
    let tile = tp.tile!;
    let poly = tp.poly;
    let nextTile: dtMeshTile = tile;
    let prevTile: dtMeshTile = tile;
    let nextPoly = poly;
    let prevPoly = poly;
    if (prevRef) {
      nav.getTileAndPolyByRefUnsafe(prevRef, tp);
      prevTile = tp.tile!;
      prevPoly = tp.poly;
    }

    const isect = this.ray_isect;

    while (curRef) {
      // Cast ray against current polygon.

      // Collect vertices.
      let nv = 0;
      const vertCount = tile.polyVertCount(poly);
      for (let i = 0; i < vertCount; ++i) {
        dtVcopy(verts, nv * 3, tile.verts, tile.polyVerts(poly, i) * 3);
        nv++;
      }

      if (!dtIntersectSegmentPoly2D(startPos, 0, endPos, 0, verts, nv, isect)) {
        // Could not hit the polygon, keep the old t and report hit.
        hit.pathCount = n;
        return status;
      }
      const tmax = Math.fround(isect.tmax);
      const segMax = isect.segMax;

      hit.hitEdgeIndex = segMax;

      // Keep track of furthest t so far.
      if (tmax > hit.t) hit.t = tmax;

      // Store visited polygons.
      if (n < hit.maxPath) hit.path![n++] = curRef;
      else status |= DT_BUFFER_TOO_SMALL;

      // Ray end is completely inside the polygon.
      if (segMax === -1) {
        hit.t = FLT_MAX;
        hit.pathCount = n;

        // add the cost
        if (options & DT_RAYCAST_USE_COSTS) {
          hit.pathCost = Math.fround(hit.pathCost + filter.getCost(curPos, endPos, prevRef, prevTile, prevPoly, curRef, tile, poly, curRef, tile, poly));
        }
        return status;
      }

      // Follow neighbours.
      let nextRef: dtPolyRef = 0;

      for (let i = tile.polyFirstLink(poly); i !== DT_NULL_LINK; i = tile.linkNext(i)) {
        // Find link which contains this edge.
        const linkEdge = tile.linkEdge(i);
        if (linkEdge !== segMax) continue;

        // Get pointer to the next polygon.
        const linkRef = tile.linkRef(i);
        nav.getTileAndPolyByRefUnsafe(linkRef, tp);
        nextTile = tp.tile!;
        nextPoly = tp.poly;

        // Skip off-mesh connections.
        if (nextTile.polyGetType(nextPoly) === DT_POLYTYPE_OFFMESH_CONNECTION) continue;

        // Skip links based on filter.
        if (!filter.passFilter(linkRef, nextTile, nextPoly)) continue;

        // If the link is internal, just return the ref.
        const linkSide = tile.linkSide(i);
        if (linkSide === 0xff) {
          nextRef = linkRef;
          break;
        }

        // If the link is at tile boundary,

        // Check if the link spans the whole edge, and accept.
        const lbmin = tile.linkBmin(i);
        const lbmax = tile.linkBmax(i);
        if (lbmin === 0 && lbmax === 255) {
          nextRef = linkRef;
          break;
        }

        // Check for partial edge links.
        const v0 = tile.polyVerts(poly, linkEdge);
        const v1 = tile.polyVerts(poly, (linkEdge + 1) % tile.polyVertCount(poly));
        const left = v0 * 3;
        const right = v1 * 3;
        const tv = tile.verts;

        // Check that the intersection lies inside the link portal.
        if (linkSide === 0 || linkSide === 4) {
          // Calculate link size.
          const s = Math.fround(1.0 / 255.0);
          let lmin = tv[left + 2]! + (tv[right + 2]! - tv[left + 2]!) * (lbmin * s);
          let lmax = tv[left + 2]! + (tv[right + 2]! - tv[left + 2]!) * (lbmax * s);
          if (lmin > lmax) {
            const tmp = lmin;
            lmin = lmax;
            lmax = tmp;
          }

          // Find Z intersection.
          const z = startPos[2]! + (endPos[2]! - startPos[2]!) * tmax;
          if (z >= lmin && z <= lmax) {
            nextRef = linkRef;
            break;
          }
        } else if (linkSide === 2 || linkSide === 6) {
          // Calculate link size.
          const s = Math.fround(1.0 / 255.0);
          let lmin = tv[left]! + (tv[right]! - tv[left]!) * (lbmin * s);
          let lmax = tv[left]! + (tv[right]! - tv[left]!) * (lbmax * s);
          if (lmin > lmax) {
            const tmp = lmin;
            lmin = lmax;
            lmax = tmp;
          }

          // Find X intersection.
          const x = startPos[0]! + (endPos[0]! - startPos[0]!) * tmax;
          if (x >= lmin && x <= lmax) {
            nextRef = linkRef;
            break;
          }
        }
      }

      // add the cost
      if (options & DT_RAYCAST_USE_COSTS) {
        // compute the intersection point at the furthest end of the polygon
        // and correct the height (since the raycast moves in 2d)
        dtVcopy(lastPos, 0, curPos, 0);
        dtVmad(curPos, 0, startPos, 0, dir, 0, hit.t);
        const e1 = segMax * 3;
        const e2 = ((segMax + 1) % nv) * 3;
        const eDir = this.ray_eDir;
        const diff = this.ray_diff;
        dtVsub(eDir, 0, verts, e2, verts, e1);
        dtVsub(diff, 0, curPos, 0, verts, e1);
        const s = dtSqr(eDir[0]!) > dtSqr(eDir[2]!) ? diff[0]! / eDir[0]! : diff[2]! / eDir[2]!;
        curPos[1] = verts[e1 + 1]! + eDir[1]! * s;

        hit.pathCost = Math.fround(
          hit.pathCost + filter.getCost(lastPos, curPos, prevRef, prevTile, prevPoly, curRef, tile, poly, nextRef, nextTile, nextPoly),
        );
      }

      if (!nextRef) {
        // No neighbour, we hit a wall.

        // Calculate hit normal.
        const a = segMax;
        const b = segMax + 1 < nv ? segMax + 1 : 0;
        const va = a * 3;
        const vb = b * 3;
        const dx = verts[vb]! - verts[va]!;
        const dz = verts[vb + 2]! - verts[va + 2]!;
        hit.hitNormal[0] = dz;
        hit.hitNormal[1] = 0;
        hit.hitNormal[2] = -dx;
        dtVnormalize(hit.hitNormal, 0);

        hit.pathCount = n;
        return status;
      }

      // No hit, advance to neighbour polygon.
      prevRef = curRef;
      curRef = nextRef;
      prevTile = tile;
      tile = nextTile;
      prevPoly = poly;
      poly = nextPoly;
    }

    hit.pathCount = n;

    return status;
  }

  /**
   * Finds the polygons along the navigation graph that touch the specified circle (Dijkstra).
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::findPolysAroundCircle
   */
  findPolysAroundCircle(
    startRef: dtPolyRef,
    centerPos: Float32Array | null,
    radius: number,
    filter: dtQueryFilter | null,
    resultRef: Float64Array | null,
    resultParent: Float64Array | null,
    resultCost: Float32Array | null,
    resultCount: Int32Array | null,
    maxResult: number,
  ): dtStatus {
    const nav = this.nav;
    const nodePool = this.m_nodePool!;
    const openList = this.m_openList!;

    if (!resultCount) return DT_FAILURE | DT_INVALID_PARAM;

    resultCount[0] = 0;

    if (!nav.isValidPolyRef(startRef) || !centerPos || !dtVisfinite(centerPos, 0) || radius < 0 || !dtMathIsfinite(radius) || !filter || maxResult < 0) {
      return DT_FAILURE | DT_INVALID_PARAM;
    }

    nodePool.clear();
    openList.clear();

    const startNode = nodePool.getNode(startRef)!;
    dtVcopy(startNode.pos, 0, centerPos, 0);
    startNode.pidx = 0;
    startNode.cost = 0;
    startNode.total = 0;
    startNode.id = startRef;
    startNode.flags = DT_NODE_OPEN;
    openList.push(startNode);

    let status: dtStatus = DT_SUCCESS;

    let n = 0;

    const radiusSqr = dtSqr(radius);
    const tpBest = this.tpA;
    const tpParent = this.tpB;
    const tpNei = this.tpC;

    while (!openList.empty()) {
      const bestNode = openList.pop();
      bestNode.flags &= ~DT_NODE_OPEN;
      bestNode.flags |= DT_NODE_CLOSED;

      // Get poly and tile.
      // The API input has been cheked already, skip checking internal data.
      const bestRef = bestNode.id;
      nav.getTileAndPolyByRefUnsafe(bestRef, tpBest);
      const bestTile = tpBest.tile!;
      const bestPoly = tpBest.poly;

      // Get parent poly and tile.
      let parentRef: dtPolyRef = 0;
      let parentTile: dtMeshTile | null = null;
      let parentPoly = -1;
      if (bestNode.pidx) parentRef = nodePool.getNodeAtIdx(bestNode.pidx)!.id;
      if (parentRef) {
        nav.getTileAndPolyByRefUnsafe(parentRef, tpParent);
        parentTile = tpParent.tile;
        parentPoly = tpParent.poly;
      }

      if (n < maxResult) {
        if (resultRef) resultRef[n] = bestRef;
        if (resultParent) resultParent[n] = parentRef;
        if (resultCost) resultCost[n] = bestNode.total;
        ++n;
      } else {
        status |= DT_BUFFER_TOO_SMALL;
      }

      for (let i = bestTile.polyFirstLink(bestPoly); i !== DT_NULL_LINK; i = bestTile.linkNext(i)) {
        const neighbourRef = bestTile.linkRef(i);
        // Skip invalid neighbours and do not follow back to parent.
        if (!neighbourRef || neighbourRef === parentRef) continue;

        // Expand to neighbour
        nav.getTileAndPolyByRefUnsafe(neighbourRef, tpNei);
        const neighbourTile = tpNei.tile!;
        const neighbourPoly = tpNei.poly;

        // Do not advance if the polygon is excluded by the filter.
        if (!filter.passFilter(neighbourRef, neighbourTile, neighbourPoly)) continue;

        // Find edge and calc distance to the edge.
        const va = this.fpc_va;
        const vb = this.fpc_vb;
        if (!this.getPortalPoints(bestRef, bestPoly, bestTile, neighbourRef, neighbourPoly, neighbourTile, va, vb)) continue;

        // If the circle is not touching the next polygon, skip it.
        const distSqr = dtDistancePtSegSqr2D(centerPos, 0, va, 0, vb, 0, this.fpc_tseg, 0);
        if (distSqr > radiusSqr) continue;

        const neighbourNode = nodePool.getNode(neighbourRef);
        if (!neighbourNode) {
          status |= DT_OUT_OF_NODES;
          continue;
        }

        if (neighbourNode.flags & DT_NODE_CLOSED) continue;

        // Cost
        if (neighbourNode.flags === 0) dtVlerp(neighbourNode.pos, 0, va, 0, vb, 0, 0.5);

        const cost = Math.fround(
          filter.getCost(bestNode.pos, neighbourNode.pos, parentRef, parentTile, parentPoly, bestRef, bestTile, bestPoly, neighbourRef, neighbourTile, neighbourPoly),
        );

        const total = Math.fround(bestNode.total + cost);

        // The node is already in open list and the new result is worse, skip.
        if (neighbourNode.flags & DT_NODE_OPEN && total >= neighbourNode.total) continue;

        neighbourNode.id = neighbourRef;
        neighbourNode.pidx = nodePool.getNodeIdx(bestNode);
        neighbourNode.total = total;

        if (neighbourNode.flags & DT_NODE_OPEN) {
          openList.modify(neighbourNode);
        } else {
          neighbourNode.flags = DT_NODE_OPEN;
          openList.push(neighbourNode);
        }
      }
    }

    resultCount[0] = n;

    return status;
  }

  /**
   * Finds the polygons along the naviation graph that touch the specified convex polygon.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::findPolysAroundShape
   */
  findPolysAroundShape(
    startRef: dtPolyRef,
    verts: Float32Array | null,
    nverts: number,
    filter: dtQueryFilter | null,
    resultRef: Float64Array | null,
    resultParent: Float64Array | null,
    resultCost: Float32Array | null,
    resultCount: Int32Array | null,
    maxResult: number,
  ): dtStatus {
    const nav = this.nav;
    const nodePool = this.m_nodePool!;
    const openList = this.m_openList!;

    if (!resultCount) return DT_FAILURE | DT_INVALID_PARAM;

    resultCount[0] = 0;

    if (!nav.isValidPolyRef(startRef) || !verts || nverts < 3 || !filter || maxResult < 0) {
      return DT_FAILURE | DT_INVALID_PARAM;
    }

    // Validate input
    if (!startRef || !nav.isValidPolyRef(startRef)) return DT_FAILURE | DT_INVALID_PARAM;

    nodePool.clear();
    openList.clear();

    const centerPos = this.fps_centerPos;
    centerPos.fill(0);
    for (let i = 0; i < nverts; ++i) dtVadd(centerPos, 0, centerPos, 0, verts, i * 3);
    dtVscale(centerPos, 0, centerPos, 0, 1.0 / nverts);

    const startNode = nodePool.getNode(startRef)!;
    dtVcopy(startNode.pos, 0, centerPos, 0);
    startNode.pidx = 0;
    startNode.cost = 0;
    startNode.total = 0;
    startNode.id = startRef;
    startNode.flags = DT_NODE_OPEN;
    openList.push(startNode);

    let status: dtStatus = DT_SUCCESS;

    let n = 0;
    const tpBest = this.tpA;
    const tpParent = this.tpB;
    const tpNei = this.tpC;
    const isect = this.fps_isect;

    while (!openList.empty()) {
      const bestNode = openList.pop();
      bestNode.flags &= ~DT_NODE_OPEN;
      bestNode.flags |= DT_NODE_CLOSED;

      // Get poly and tile.
      // The API input has been cheked already, skip checking internal data.
      const bestRef = bestNode.id;
      nav.getTileAndPolyByRefUnsafe(bestRef, tpBest);
      const bestTile = tpBest.tile!;
      const bestPoly = tpBest.poly;

      // Get parent poly and tile.
      let parentRef: dtPolyRef = 0;
      let parentTile: dtMeshTile | null = null;
      let parentPoly = -1;
      if (bestNode.pidx) parentRef = nodePool.getNodeAtIdx(bestNode.pidx)!.id;
      if (parentRef) {
        nav.getTileAndPolyByRefUnsafe(parentRef, tpParent);
        parentTile = tpParent.tile;
        parentPoly = tpParent.poly;
      }

      if (n < maxResult) {
        if (resultRef) resultRef[n] = bestRef;
        if (resultParent) resultParent[n] = parentRef;
        if (resultCost) resultCost[n] = bestNode.total;

        ++n;
      } else {
        status |= DT_BUFFER_TOO_SMALL;
      }

      for (let i = bestTile.polyFirstLink(bestPoly); i !== DT_NULL_LINK; i = bestTile.linkNext(i)) {
        const neighbourRef = bestTile.linkRef(i);
        // Skip invalid neighbours and do not follow back to parent.
        if (!neighbourRef || neighbourRef === parentRef) continue;

        // Expand to neighbour
        nav.getTileAndPolyByRefUnsafe(neighbourRef, tpNei);
        const neighbourTile = tpNei.tile!;
        const neighbourPoly = tpNei.poly;

        // Do not advance if the polygon is excluded by the filter.
        if (!filter.passFilter(neighbourRef, neighbourTile, neighbourPoly)) continue;

        // Find edge and calc distance to the edge.
        const va = this.fps_va;
        const vb = this.fps_vb;
        if (!this.getPortalPoints(bestRef, bestPoly, bestTile, neighbourRef, neighbourPoly, neighbourTile, va, vb)) continue;

        // If the poly is not touching the edge to the next polygon, skip the connection it.
        if (!dtIntersectSegmentPoly2D(va, 0, vb, 0, verts, nverts, isect)) continue;
        if (isect.tmin > 1.0 || isect.tmax < 0.0) continue;

        const neighbourNode = nodePool.getNode(neighbourRef);
        if (!neighbourNode) {
          status |= DT_OUT_OF_NODES;
          continue;
        }

        if (neighbourNode.flags & DT_NODE_CLOSED) continue;

        // Cost
        if (neighbourNode.flags === 0) dtVlerp(neighbourNode.pos, 0, va, 0, vb, 0, 0.5);

        const cost = Math.fround(
          filter.getCost(bestNode.pos, neighbourNode.pos, parentRef, parentTile, parentPoly, bestRef, bestTile, bestPoly, neighbourRef, neighbourTile, neighbourPoly),
        );

        const total = Math.fround(bestNode.total + cost);

        // The node is already in open list and the new result is worse, skip.
        if (neighbourNode.flags & DT_NODE_OPEN && total >= neighbourNode.total) continue;

        neighbourNode.id = neighbourRef;
        neighbourNode.pidx = nodePool.getNodeIdx(bestNode);
        neighbourNode.total = total;

        if (neighbourNode.flags & DT_NODE_OPEN) {
          openList.modify(neighbourNode);
        } else {
          neighbourNode.flags = DT_NODE_OPEN;
          openList.push(neighbourNode);
        }
      }
    }

    resultCount[0] = n;

    return status;
  }

  /**
   * Gets a path from the explored nodes in the previous search (findPolysAroundCircle / findPolysAroundShape).
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::getPathFromDijkstraSearch
   */
  getPathFromDijkstraSearch(endRef: dtPolyRef, path: Float64Array | null, pathCount: Int32Array | null, maxPath: number): dtStatus {
    if (!this.nav.isValidPolyRef(endRef) || !path || !pathCount || maxPath < 0) return DT_FAILURE | DT_INVALID_PARAM;

    pathCount[0] = 0;

    const nodes = this.gdj_endNode;
    nodes[0] = null;
    if (this.m_nodePool!.findNodes(endRef, nodes, 1) !== 1 || (nodes[0]!.flags & DT_NODE_CLOSED) === 0) return DT_FAILURE | DT_INVALID_PARAM;

    return this.getPathToNode(nodes[0]!, path, pathCount, maxPath);
  }

  /**
   * Finds the non-overlapping navigation polygons in the local neighbourhood around the center position.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::findLocalNeighbourhood
   */
  findLocalNeighbourhood(
    startRef: dtPolyRef,
    centerPos: Float32Array | null,
    radius: number,
    filter: dtQueryFilter | null,
    resultRef: Float64Array,
    resultParent: Float64Array | null,
    resultCount: Int32Array | null,
    maxResult: number,
  ): dtStatus {
    const nav = this.nav;
    const tinyNodePool = this.m_tinyNodePool!;

    if (!resultCount) return DT_FAILURE | DT_INVALID_PARAM;

    resultCount[0] = 0;

    if (!nav.isValidPolyRef(startRef) || !centerPos || !dtVisfinite(centerPos, 0) || radius < 0 || !dtMathIsfinite(radius) || !filter || maxResult < 0) {
      return DT_FAILURE | DT_INVALID_PARAM;
    }

    const stack = this.fln_stack;
    let nstack = 0;

    tinyNodePool.clear();

    const startNode = tinyNodePool.getNode(startRef)!;
    startNode.pidx = 0;
    startNode.id = startRef;
    startNode.flags = DT_NODE_CLOSED;
    stack[nstack++] = startNode;

    const radiusSqr = dtSqr(radius);

    const pa = this.fln_pa;
    const pb = this.fln_pb;

    let status: dtStatus = DT_SUCCESS;

    let n = 0;
    if (n < maxResult) {
      resultRef[n] = startNode.id;
      if (resultParent) resultParent[n] = 0;
      ++n;
    } else {
      status |= DT_BUFFER_TOO_SMALL;
    }

    const tpCur = this.tpA;
    const tpNei = this.tpB;
    const tpPast = this.tpC;

    while (nstack) {
      // Pop front.
      const curNode = stack[0]!;
      for (let i = 0; i < nstack - 1; ++i) stack[i] = stack[i + 1]!;
      nstack--;

      // Get poly and tile.
      // The API input has been cheked already, skip checking internal data.
      const curRef = curNode.id;
      nav.getTileAndPolyByRefUnsafe(curRef, tpCur);
      const curTile = tpCur.tile!;
      const curPoly = tpCur.poly;

      for (let i = curTile.polyFirstLink(curPoly); i !== DT_NULL_LINK; i = curTile.linkNext(i)) {
        const neighbourRef = curTile.linkRef(i);
        // Skip invalid neighbours.
        if (!neighbourRef) continue;

        // Skip if cannot alloca more nodes.
        const neighbourNode = tinyNodePool.getNode(neighbourRef);
        if (!neighbourNode) continue;
        // Skip visited.
        if (neighbourNode.flags & DT_NODE_CLOSED) continue;

        // Expand to neighbour
        nav.getTileAndPolyByRefUnsafe(neighbourRef, tpNei);
        const neighbourTile = tpNei.tile!;
        const neighbourPoly = tpNei.poly;

        // Skip off-mesh connections.
        if (neighbourTile.polyGetType(neighbourPoly) === DT_POLYTYPE_OFFMESH_CONNECTION) continue;

        // Do not advance if the polygon is excluded by the filter.
        if (!filter.passFilter(neighbourRef, neighbourTile, neighbourPoly)) continue;

        // Find edge and calc distance to the edge.
        const va = this.fln_va;
        const vb = this.fln_vb;
        if (!this.getPortalPoints(curRef, curPoly, curTile, neighbourRef, neighbourPoly, neighbourTile, va, vb)) continue;

        // If the circle is not touching the next polygon, skip it.
        const distSqr = dtDistancePtSegSqr2D(centerPos, 0, va, 0, vb, 0, this.fln_tseg, 0);
        if (distSqr > radiusSqr) continue;

        // Mark node visited, this is done before the overlap test so that
        // we will not visit the poly again if the test fails.
        neighbourNode.flags |= DT_NODE_CLOSED;
        neighbourNode.pidx = tinyNodePool.getNodeIdx(curNode);

        // Check that the polygon does not collide with existing polygons.

        // Collect vertices of the neighbour poly.
        const npa = neighbourTile.polyVertCount(neighbourPoly);
        for (let k = 0; k < npa; ++k) dtVcopy(pa, k * 3, neighbourTile.verts, neighbourTile.polyVerts(neighbourPoly, k) * 3);

        let overlap = false;
        for (let j = 0; j < n; ++j) {
          const pastRef = resultRef[j]!;

          // Connected polys do not overlap.
          let connected = false;
          for (let k = curTile.polyFirstLink(curPoly); k !== DT_NULL_LINK; k = curTile.linkNext(k)) {
            if (curTile.linkRef(k) === pastRef) {
              connected = true;
              break;
            }
          }
          if (connected) continue;

          // Potentially overlapping.
          nav.getTileAndPolyByRefUnsafe(pastRef, tpPast);
          const pastTile = tpPast.tile!;
          const pastPoly = tpPast.poly;

          // Get vertices and test overlap
          const npb = pastTile.polyVertCount(pastPoly);
          for (let k = 0; k < npb; ++k) dtVcopy(pb, k * 3, pastTile.verts, pastTile.polyVerts(pastPoly, k) * 3);

          if (dtOverlapPolyPoly2D(pa, npa, pb, npb)) {
            overlap = true;
            break;
          }
        }
        if (overlap) continue;

        // This poly is fine, store and advance to the poly.
        if (n < maxResult) {
          resultRef[n] = neighbourRef;
          if (resultParent) resultParent[n] = curRef;
          ++n;
        } else {
          status |= DT_BUFFER_TOO_SMALL;
        }

        if (nstack < MAX_STACK) {
          stack[nstack++] = neighbourNode;
        }
      }
    }

    resultCount[0] = n;

    return status;
  }

  /**
   * Returns the segments for the specified polygon, optionally including portals. Segments go to `segmentVerts`
   * (6 floats each), the neighbour refs to `segmentRefs`, and the count to `segmentCount[0]`.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::getPolyWallSegments
   */
  getPolyWallSegments(
    ref: dtPolyRef,
    filter: dtQueryFilter | null,
    segmentVerts: Float32Array | null,
    segmentRefs: Float64Array | null,
    segmentCount: Int32Array | null,
    maxSegments: number,
  ): dtStatus {
    const nav = this.nav;

    if (!segmentCount) return DT_FAILURE | DT_INVALID_PARAM;

    segmentCount[0] = 0;

    const tp = this.tpWall;
    if (dtStatusFailed(nav.getTileAndPolyByRef(ref, tp))) return DT_FAILURE | DT_INVALID_PARAM;
    const tile = tp.tile!;
    const poly = tp.poly;

    if (!filter || !segmentVerts || maxSegments < 0) return DT_FAILURE | DT_INVALID_PARAM;

    let n = 0;
    const intsRef = this.gws_intsRef;
    const intsTmin = this.gws_intsTmin;
    const intsTmax = this.gws_intsTmax;
    let nints: number;

    const storePortals = segmentRefs !== null;

    let status: dtStatus = DT_SUCCESS;
    const tpNei = this.tpA;

    const vertCount = tile.polyVertCount(poly);
    for (let i = 0, j = vertCount - 1; i < vertCount; j = i++) {
      // Skip non-solid edges.
      nints = 0;
      const nei = tile.polyNeis(poly, j);
      if (nei & DT_EXT_LINK) {
        // Tile border.
        for (let k = tile.polyFirstLink(poly); k !== DT_NULL_LINK; k = tile.linkNext(k)) {
          if (tile.linkEdge(k) === j) {
            const linkRef = tile.linkRef(k);
            if (linkRef !== 0) {
              nav.getTileAndPolyByRefUnsafe(linkRef, tpNei);
              if (filter.passFilter(linkRef, tpNei.tile!, tpNei.poly)) {
                nints = insertInterval(intsRef, intsTmin, intsTmax, nints, MAX_INTERVAL, tile.linkBmin(k), tile.linkBmax(k), linkRef);
              }
            }
          }
        }
      } else {
        // Internal edge
        let neiRef: dtPolyRef = 0;
        if (nei) {
          const idx = nei - 1;
          neiRef = nav.getPolyRefBase(tile) + idx;
          if (!filter.passFilter(neiRef, tile, idx)) neiRef = 0;
        }

        // If the edge leads to another polygon and portals are not stored, skip.
        if (neiRef !== 0 && !storePortals) continue;

        if (n < maxSegments) {
          const vj = tile.polyVerts(poly, j) * 3;
          const vi = tile.polyVerts(poly, i) * 3;
          const seg = n * 6;
          dtVcopy(segmentVerts, seg + 0, tile.verts, vj);
          dtVcopy(segmentVerts, seg + 3, tile.verts, vi);
          if (segmentRefs) segmentRefs[n] = neiRef;
          n++;
        } else {
          status |= DT_BUFFER_TOO_SMALL;
        }

        continue;
      }

      // Add sentinels
      nints = insertInterval(intsRef, intsTmin, intsTmax, nints, MAX_INTERVAL, -1, 0, 0);
      nints = insertInterval(intsRef, intsTmin, intsTmax, nints, MAX_INTERVAL, 255, 256, 0);

      // Store segments.
      const vj = tile.polyVerts(poly, j) * 3;
      const vi = tile.polyVerts(poly, i) * 3;
      for (let k = 1; k < nints; ++k) {
        // Portal segment.
        if (storePortals && intsRef[k]) {
          const tmin = Math.fround(intsTmin[k]! / 255.0);
          const tmax = Math.fround(intsTmax[k]! / 255.0);
          if (n < maxSegments) {
            const seg = n * 6;
            dtVlerp(segmentVerts, seg + 0, tile.verts, vj, tile.verts, vi, tmin);
            dtVlerp(segmentVerts, seg + 3, tile.verts, vj, tile.verts, vi, tmax);
            if (segmentRefs) segmentRefs[n] = intsRef[k]!;
            n++;
          } else {
            status |= DT_BUFFER_TOO_SMALL;
          }
        }

        // Wall segment.
        const imin = intsTmax[k - 1]!;
        const imax = intsTmin[k]!;
        if (imin !== imax) {
          const tmin = Math.fround(imin / 255.0);
          const tmax = Math.fround(imax / 255.0);
          if (n < maxSegments) {
            const seg = n * 6;
            dtVlerp(segmentVerts, seg + 0, tile.verts, vj, tile.verts, vi, tmin);
            dtVlerp(segmentVerts, seg + 3, tile.verts, vj, tile.verts, vi, tmax);
            if (segmentRefs) segmentRefs[n] = 0;
            n++;
          } else {
            status |= DT_BUFFER_TOO_SMALL;
          }
        }
      }
    }

    segmentCount[0] = n;

    return status;
  }

  /**
   * Finds the distance from the specified position to the nearest polygon wall. Writes the distance to
   * `hitDist[0]`.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::findDistanceToWall
   */
  findDistanceToWall(
    startRef: dtPolyRef,
    centerPos: Float32Array | null,
    maxRadius: number,
    filter: dtQueryFilter | null,
    hitDist: Float32Array | null,
    hitPos: Float32Array | null,
    hitNormal: Float32Array | null,
  ): dtStatus {
    const nav = this.nav;
    const nodePool = this.m_nodePool!;
    const openList = this.m_openList!;

    // Validate input
    if (
      !nav.isValidPolyRef(startRef) ||
      !centerPos ||
      !dtVisfinite(centerPos, 0) ||
      maxRadius < 0 ||
      !dtMathIsfinite(maxRadius) ||
      !filter ||
      !hitDist ||
      !hitPos ||
      !hitNormal
    ) {
      return DT_FAILURE | DT_INVALID_PARAM;
    }

    nodePool.clear();
    openList.clear();

    const startNode = nodePool.getNode(startRef)!;
    dtVcopy(startNode.pos, 0, centerPos, 0);
    startNode.pidx = 0;
    startNode.cost = 0;
    startNode.total = 0;
    startNode.id = startRef;
    startNode.flags = DT_NODE_OPEN;
    openList.push(startNode);

    let radiusSqr = dtSqr(maxRadius);

    let status: dtStatus = DT_SUCCESS;
    const tpBest = this.tpA;
    const tpNei = this.tpC;
    const tseg = this.fdw_tseg;

    while (!openList.empty()) {
      const bestNode = openList.pop();
      bestNode.flags &= ~DT_NODE_OPEN;
      bestNode.flags |= DT_NODE_CLOSED;

      // Get poly and tile.
      // The API input has been cheked already, skip checking internal data.
      const bestRef = bestNode.id;
      nav.getTileAndPolyByRefUnsafe(bestRef, tpBest);
      const bestTile = tpBest.tile!;
      const bestPoly = tpBest.poly;

      // Get parent poly and tile.
      let parentRef: dtPolyRef = 0;
      if (bestNode.pidx) parentRef = nodePool.getNodeAtIdx(bestNode.pidx)!.id;
      if (parentRef) nav.getTileAndPolyByRefUnsafe(parentRef, this.tpB);

      // Hit test walls.
      const vertCount = bestTile.polyVertCount(bestPoly);
      for (let i = 0, j = vertCount - 1; i < vertCount; j = i++) {
        // Skip non-solid edges.
        const nei = bestTile.polyNeis(bestPoly, j);
        if (nei & DT_EXT_LINK) {
          // Tile border.
          let solid = true;
          for (let k = bestTile.polyFirstLink(bestPoly); k !== DT_NULL_LINK; k = bestTile.linkNext(k)) {
            if (bestTile.linkEdge(k) === j) {
              const linkRef = bestTile.linkRef(k);
              if (linkRef !== 0) {
                nav.getTileAndPolyByRefUnsafe(linkRef, tpNei);
                if (filter.passFilter(linkRef, tpNei.tile!, tpNei.poly)) solid = false;
              }
              break;
            }
          }
          if (!solid) continue;
        } else if (nei) {
          // Internal edge
          const idx = nei - 1;
          const ref = nav.getPolyRefBase(bestTile) + idx;
          if (filter.passFilter(ref, bestTile, idx)) continue;
        }

        // Calc distance to the edge.
        const vj = bestTile.polyVerts(bestPoly, j) * 3;
        const vi = bestTile.polyVerts(bestPoly, i) * 3;
        const tv = bestTile.verts;
        const distSqr = dtDistancePtSegSqr2D(centerPos, 0, tv, vj, tv, vi, tseg, 0);

        // Edge is too far, skip.
        if (distSqr > radiusSqr) continue;

        // Hit wall, update radius.
        radiusSqr = distSqr;
        // Calculate hit pos.
        const t = tseg[0]!;
        hitPos[0] = tv[vj]! + (tv[vi]! - tv[vj]!) * t;
        hitPos[1] = tv[vj + 1]! + (tv[vi + 1]! - tv[vj + 1]!) * t;
        hitPos[2] = tv[vj + 2]! + (tv[vi + 2]! - tv[vj + 2]!) * t;
      }

      for (let i = bestTile.polyFirstLink(bestPoly); i !== DT_NULL_LINK; i = bestTile.linkNext(i)) {
        const neighbourRef = bestTile.linkRef(i);
        // Skip invalid neighbours and do not follow back to parent.
        if (!neighbourRef || neighbourRef === parentRef) continue;

        // Expand to neighbour.
        nav.getTileAndPolyByRefUnsafe(neighbourRef, tpNei);
        const neighbourTile = tpNei.tile!;
        const neighbourPoly = tpNei.poly;

        // Skip off-mesh connections.
        if (neighbourTile.polyGetType(neighbourPoly) === DT_POLYTYPE_OFFMESH_CONNECTION) continue;

        // Calc distance to the edge.
        const edge = bestTile.linkEdge(i);
        const va = bestTile.polyVerts(bestPoly, edge) * 3;
        const vb = bestTile.polyVerts(bestPoly, (edge + 1) % vertCount) * 3;
        const distSqr = dtDistancePtSegSqr2D(centerPos, 0, bestTile.verts, va, bestTile.verts, vb, tseg, 0);

        // If the circle is not touching the next polygon, skip it.
        if (distSqr > radiusSqr) continue;

        if (!filter.passFilter(neighbourRef, neighbourTile, neighbourPoly)) continue;

        const neighbourNode = nodePool.getNode(neighbourRef);
        if (!neighbourNode) {
          status |= DT_OUT_OF_NODES;
          continue;
        }

        if (neighbourNode.flags & DT_NODE_CLOSED) continue;

        // Cost
        if (neighbourNode.flags === 0) {
          this.getEdgeMidPoint(bestRef, bestPoly, bestTile, neighbourRef, neighbourPoly, neighbourTile, neighbourNode.pos);
        }

        const total = Math.fround(bestNode.total + dtVdist(bestNode.pos, 0, neighbourNode.pos, 0));

        // The node is already in open list and the new result is worse, skip.
        if (neighbourNode.flags & DT_NODE_OPEN && total >= neighbourNode.total) continue;

        neighbourNode.id = neighbourRef;
        neighbourNode.flags = neighbourNode.flags & ~DT_NODE_CLOSED;
        neighbourNode.pidx = nodePool.getNodeIdx(bestNode);
        neighbourNode.total = total;

        if (neighbourNode.flags & DT_NODE_OPEN) {
          openList.modify(neighbourNode);
        } else {
          neighbourNode.flags |= DT_NODE_OPEN;
          openList.push(neighbourNode);
        }
      }
    }

    // Calc hit normal.
    dtVsub(hitNormal, 0, centerPos, 0, hitPos, 0);
    dtVnormalize(hitNormal, 0);

    hitDist[0] = dtMathSqrtf(radiusSqr);

    return status;
  }

  /**
   * Returns true if the polygon reference is valid and passes the filter restrictions.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::isValidPolyRef
   */
  isValidPolyRef(ref: dtPolyRef, filter: dtQueryFilter): boolean {
    const tp = this.tpValid;
    const status = this.nav.getTileAndPolyByRef(ref, tp);
    // If cannot get polygon, assume it does not exists and boundary is invalid.
    if (dtStatusFailed(status)) return false;
    // If cannot pass filter, assume flags has changed and boundary is invalid.
    if (!filter.passFilter(ref, tp.tile!, tp.poly)) return false;
    return true;
  }

  /**
   * Returns true if the polygon reference is in the closed list.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMeshQuery.cpp dtNavMeshQuery::isInClosedList
   */
  isInClosedList(ref: dtPolyRef): boolean {
    if (!this.m_nodePool) return false;

    const nodes = this.icl_nodes;
    const n = this.m_nodePool.findNodes(ref, nodes, DT_MAX_STATES_PER_NODE);

    for (let i = 0; i < n; i++) {
      if (nodes[i]!.flags & DT_NODE_CLOSED) return true;
    }

    return false;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNavMeshQuery.h dtNavMeshQuery::getNodePool */
  getNodePool(): dtNodePool | null {
    return this.m_nodePool;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNavMeshQuery.h dtNavMeshQuery::getAttachedNavMesh */
  getAttachedNavMesh(): dtNavMesh | null {
    return this.m_nav;
  }
}
