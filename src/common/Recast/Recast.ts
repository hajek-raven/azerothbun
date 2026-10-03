/**
 * Port of `deps/recastnavigation/Recast/Include/Recast.h` and `Source/Recast.cpp`, including the AzerothCore patch
 * (`recastnavigation.diff`): `RC_SPAN_HEIGHT_BITS = 16` and an 8-bit `rcSpan::area`.
 *
 * Output must equal the C++ bit for bit, so:
 * - every C++ `float` operation is rounded with `Math.fround` (`f32`) unless the result goes straight into a
 *   `Float32Array` (the store rounds the same way). The C++ is assumed compiled without FMA contraction, which is what
 *   AzerothCore's default x86-64 build does;
 * - `float` parameters are rounded at function entry (the C++ call converts `double` arguments to `float`);
 * - integer fields keep their C++ widths (`Uint16Array` for heights, regions and poly indices, `Uint8Array` for areas).
 *
 * Structs of many small elements are stored as structs of typed arrays: `chf.spans[i].reg` is `chf.spans.reg[i]`,
 * `chf.cells[i].index` is `chf.cells.index[i]`, and a heightfield `rcSpan*` is a span id into `hf.pools` (0 is null).
 * Vector arguments follow the Detour port: `(array, offset)` pairs, `rcVcopy(dest, d, v, vi)` is
 * `rcVcopy(&dest[d], &v[vi])`.
 */

/** C++ `float` rounding. */
export const f32 = Math.fround;

/** @ac deps/recastnavigation/Recast/Include/Recast.h RC_PI */
export const RC_PI = f32(3.14159265);

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcLogCategory */
export const rcLogCategory = {
  RC_LOG_PROGRESS: 1,
  RC_LOG_WARNING: 2,
  RC_LOG_ERROR: 3,
} as const;
export type rcLogCategory = (typeof rcLogCategory)[keyof typeof rcLogCategory];
export const RC_LOG_PROGRESS = rcLogCategory.RC_LOG_PROGRESS;
export const RC_LOG_WARNING = rcLogCategory.RC_LOG_WARNING;
export const RC_LOG_ERROR = rcLogCategory.RC_LOG_ERROR;

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcTimerLabel */
export const rcTimerLabel = {
  RC_TIMER_TOTAL: 0,
  RC_TIMER_TEMP: 1,
  RC_TIMER_RASTERIZE_TRIANGLES: 2,
  RC_TIMER_BUILD_COMPACTHEIGHTFIELD: 3,
  RC_TIMER_BUILD_CONTOURS: 4,
  RC_TIMER_BUILD_CONTOURS_TRACE: 5,
  RC_TIMER_BUILD_CONTOURS_SIMPLIFY: 6,
  RC_TIMER_FILTER_BORDER: 7,
  RC_TIMER_FILTER_WALKABLE: 8,
  RC_TIMER_MEDIAN_AREA: 9,
  RC_TIMER_FILTER_LOW_OBSTACLES: 10,
  RC_TIMER_BUILD_POLYMESH: 11,
  RC_TIMER_MERGE_POLYMESH: 12,
  RC_TIMER_ERODE_AREA: 13,
  RC_TIMER_MARK_BOX_AREA: 14,
  RC_TIMER_MARK_CYLINDER_AREA: 15,
  RC_TIMER_MARK_CONVEXPOLY_AREA: 16,
  RC_TIMER_BUILD_DISTANCEFIELD: 17,
  RC_TIMER_BUILD_DISTANCEFIELD_DIST: 18,
  RC_TIMER_BUILD_DISTANCEFIELD_BLUR: 19,
  RC_TIMER_BUILD_REGIONS: 20,
  RC_TIMER_BUILD_REGIONS_WATERSHED: 21,
  RC_TIMER_BUILD_REGIONS_EXPAND: 22,
  RC_TIMER_BUILD_REGIONS_FLOOD: 23,
  RC_TIMER_BUILD_REGIONS_FILTER: 24,
  RC_TIMER_BUILD_LAYERS: 25,
  RC_TIMER_BUILD_POLYMESHDETAIL: 26,
  RC_TIMER_MERGE_POLYMESHDETAIL: 27,
  RC_MAX_TIMERS: 28,
} as const;
export type rcTimerLabel = (typeof rcTimerLabel)[keyof typeof rcTimerLabel];
export const {
  RC_TIMER_TOTAL,
  RC_TIMER_TEMP,
  RC_TIMER_RASTERIZE_TRIANGLES,
  RC_TIMER_BUILD_COMPACTHEIGHTFIELD,
  RC_TIMER_BUILD_CONTOURS,
  RC_TIMER_BUILD_CONTOURS_TRACE,
  RC_TIMER_BUILD_CONTOURS_SIMPLIFY,
  RC_TIMER_FILTER_BORDER,
  RC_TIMER_FILTER_WALKABLE,
  RC_TIMER_MEDIAN_AREA,
  RC_TIMER_FILTER_LOW_OBSTACLES,
  RC_TIMER_BUILD_POLYMESH,
  RC_TIMER_MERGE_POLYMESH,
  RC_TIMER_ERODE_AREA,
  RC_TIMER_MARK_BOX_AREA,
  RC_TIMER_MARK_CYLINDER_AREA,
  RC_TIMER_MARK_CONVEXPOLY_AREA,
  RC_TIMER_BUILD_DISTANCEFIELD,
  RC_TIMER_BUILD_DISTANCEFIELD_DIST,
  RC_TIMER_BUILD_DISTANCEFIELD_BLUR,
  RC_TIMER_BUILD_REGIONS,
  RC_TIMER_BUILD_REGIONS_WATERSHED,
  RC_TIMER_BUILD_REGIONS_EXPAND,
  RC_TIMER_BUILD_REGIONS_FLOOD,
  RC_TIMER_BUILD_REGIONS_FILTER,
  RC_TIMER_BUILD_LAYERS,
  RC_TIMER_BUILD_POLYMESHDETAIL,
  RC_TIMER_MERGE_POLYMESHDETAIL,
  RC_MAX_TIMERS,
} = rcTimerLabel;

/** A `printf` argument of `rcContext::log`. */
export type rcLogArg = number | string | object | null | undefined;

/**
 * The subset of `vsnprintf` the Recast messages use: `%d`, `%i`, `%u`, `%f`, `%s`, `%p` and `%%`.
 */
function rcFormatMessage(format: string, args: readonly rcLogArg[]): string {
  let ai = 0;
  return format.replace(/%(\d*)(?:\.(\d+))?([diufsp%])/g, (_m, _width: string, prec: string | undefined, conv: string) => {
    if (conv === "%") return "%";
    const arg = args[ai++];
    switch (conv) {
      case "d":
      case "i":
      case "u":
        return String(Math.trunc(Number(arg)));
      case "f":
        return Number(arg).toFixed(prec === undefined ? 6 : Number(prec));
      case "p":
        return arg === null || arg === undefined ? "(nil)" : "0x0";
      default:
        return String(arg);
    }
  });
}

/**
 * Provides an interface for optional logging and performance tracking of the Recast build process. Subclasses
 * override the protected `do*` methods, like the C++ virtuals.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcContext
 */
export class rcContext {
  /** True if logging is enabled. */
  protected m_logEnabled: boolean;
  /** True if the performance timers are enabled. */
  protected m_timerEnabled: boolean;

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcContext::rcContext */
  constructor(state = true) {
    this.m_logEnabled = state;
    this.m_timerEnabled = state;
  }

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcContext::enableLog */
  enableLog(state: boolean): void {
    this.m_logEnabled = state;
  }

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcContext::resetLog */
  resetLog(): void {
    if (this.m_logEnabled) this.doResetLog();
  }

  /**
   * Logs a message. The message is formatted like `vsnprintf` into a 512-byte buffer.
   * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcContext::log
   */
  log(category: rcLogCategory, format: string, ...args: rcLogArg[]): void {
    if (!this.m_logEnabled) return;
    const MSG_SIZE = 512;
    let msg = rcFormatMessage(format, args);
    let len = msg.length;
    if (len >= MSG_SIZE) {
      len = MSG_SIZE - 1;
      msg = msg.slice(0, len);
    }
    this.doLog(category, msg, len);
  }

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcContext::enableTimer */
  enableTimer(state: boolean): void {
    this.m_timerEnabled = state;
  }

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcContext::resetTimers */
  resetTimers(): void {
    if (this.m_timerEnabled) this.doResetTimers();
  }

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcContext::startTimer */
  startTimer(label: rcTimerLabel): void {
    if (this.m_timerEnabled) this.doStartTimer(label);
  }

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcContext::stopTimer */
  stopTimer(label: rcTimerLabel): void {
    if (this.m_timerEnabled) this.doStopTimer(label);
  }

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcContext::getAccumulatedTime */
  getAccumulatedTime(label: rcTimerLabel): number {
    return this.m_timerEnabled ? this.doGetAccumulatedTime(label) : -1;
  }

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcContext::doResetLog */
  protected doResetLog(): void {}

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcContext::doLog */
  protected doLog(_category: rcLogCategory, _msg: string, _len: number): void {}

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcContext::doResetTimers */
  protected doResetTimers(): void {}

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcContext::doStartTimer */
  protected doStartTimer(_label: rcTimerLabel): void {}

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcContext::doStopTimer */
  protected doStopTimer(_label: rcTimerLabel): void {}

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcContext::doGetAccumulatedTime */
  protected doGetAccumulatedTime(_label: rcTimerLabel): number {
    return -1;
  }
}

/**
 * Starts a timer and stops it when the scope ends. Use with `using timer = new rcScopedTimer(ctx, label);`, which
 * runs the destructor on every return path like the C++ RAII object.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcScopedTimer
 */
export class rcScopedTimer implements Disposable {
  private readonly m_ctx: rcContext;
  private readonly m_label: rcTimerLabel;

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcScopedTimer::rcScopedTimer */
  constructor(ctx: rcContext, label: rcTimerLabel) {
    this.m_ctx = ctx;
    this.m_label = label;
    this.m_ctx.startTimer(this.m_label);
  }

  /** @ac deps/recastnavigation/Recast/Include/Recast.h rcScopedTimer::~rcScopedTimer */
  [Symbol.dispose](): void {
    this.m_ctx.stopTimer(this.m_label);
  }
}

/**
 * Specifies a configuration to use when performing Recast builds. `float` members are stored as given; the build
 * functions round them to `float` when they receive them.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcConfig
 */
export class rcConfig {
  /** The width of the field along the x-axis. [Limit: >= 0] [Units: vx] */
  width = 0;
  /** The height of the field along the z-axis. [Limit: >= 0] [Units: vx] */
  height = 0;
  /** The width/height size of tile's on the xz-plane. [Limit: >= 0] [Units: vx] */
  tileSize = 0;
  /** The size of the non-navigable border around the heightfield. [Limit: >=0] [Units: vx] */
  borderSize = 0;
  /** The xz-plane cell size to use for fields. [Limit: > 0] [Units: wu] */
  cs = 0;
  /** The y-axis cell size to use for fields. [Limit: > 0] [Units: wu] */
  ch = 0;
  /** The minimum bounds of the field's AABB. [(x, y, z)] [Units: wu] */
  readonly bmin = new Float32Array(3);
  /** The maximum bounds of the field's AABB. [(x, y, z)] [Units: wu] */
  readonly bmax = new Float32Array(3);
  /** The maximum slope that is considered walkable. [Limits: 0 <= value < 90] [Units: Degrees] */
  walkableSlopeAngle = 0;
  /** Minimum floor to 'ceiling' height that will still allow the floor area to be considered walkable. [Limit: >= 3] [Units: vx] */
  walkableHeight = 0;
  /** Maximum ledge height that is considered to still be traversable. [Limit: >=0] [Units: vx] */
  walkableClimb = 0;
  /** The distance to erode/shrink the walkable area of the heightfield away from obstructions. [Limit: >=0] [Units: vx] */
  walkableRadius = 0;
  /** The maximum allowed length for contour edges along the border of the mesh. [Limit: >=0] [Units: vx] */
  maxEdgeLen = 0;
  /** The maximum distance a simplfied contour's border edges should deviate the original raw contour. [Limit: >=0] [Units: vx] */
  maxSimplificationError = 0;
  /** The minimum number of cells allowed to form isolated island areas. [Limit: >=0] [Units: vx] */
  minRegionArea = 0;
  /** Any regions with a span count smaller than this value will, if possible, be merged with larger regions. [Limit: >=0] [Units: vx] */
  mergeRegionArea = 0;
  /** The maximum number of vertices allowed for polygons generated during the contour to polygon conversion process. [Limit: >= 3] */
  maxVertsPerPoly = 0;
  /** Sets the sampling distance to use when generating the detail mesh. (For height detail only.) [Limits: 0 or >= 0.9] [Units: wu] */
  detailSampleDist = 0;
  /** The maximum distance the detail mesh surface should deviate from heightfield data. (For height detail only.) [Limit: >=0] [Units: wu] */
  detailSampleMaxError = 0;
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h RC_SPAN_HEIGHT_BITS */
export const RC_SPAN_HEIGHT_BITS = 16;
/** @ac deps/recastnavigation/Recast/Include/Recast.h RC_SPAN_MAX_HEIGHT */
export const RC_SPAN_MAX_HEIGHT = (1 << RC_SPAN_HEIGHT_BITS) - 1;
/** @ac deps/recastnavigation/Recast/Include/Recast.h RC_SPANS_PER_POOL */
export const RC_SPANS_PER_POOL = 2048;

/** The null `rcSpan*`: span ids start at 1, so a zeroed column array means "no spans" like the C++ `memset`. */
export const RC_NULL_SPAN = 0;

/**
 * The `rcSpan` / `rcSpanPool` storage of one heightfield, as a struct of arrays indexed by span id. Span id `s` is the
 * C++ `rcSpan*`: `s->smin` is `pools.smin[s]`, `s->next` is `pools.next[s]` (0 = null). The C++ allocates spans in
 * pages of `RC_SPANS_PER_POOL` and keeps a free list; here the arrays grow by doubling and `rcHeightfield.freelist`
 * keeps the freed ids. Allocation order never reaches the output (only the per-column linked lists do).
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcSpanPool
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcSpan
 */
export class rcSpanPool {
  /** The lower limit of the span. [Limit: < #smax] */
  smin: Uint16Array;
  /** The upper limit of the span. [Limit: <= #RC_SPAN_MAX_HEIGHT] */
  smax: Uint16Array;
  /** The area id assigned to the span. */
  area: Uint8Array;
  /** The next span higher up in column (0 = none). */
  next: Int32Array;
  /** One past the highest span id handed out (id 0 is the null span). */
  count = 1;

  constructor(capacity: number = RC_SPANS_PER_POOL) {
    this.smin = new Uint16Array(capacity);
    this.smax = new Uint16Array(capacity);
    this.area = new Uint8Array(capacity);
    this.next = new Int32Array(capacity);
  }

  /** Allocated span slots. */
  get capacity(): number {
    return this.next.length;
  }

  /** Doubles the storage. Arrays read before the call must be read again. */
  grow(): void {
    const cap = this.next.length * 2;
    const smin = new Uint16Array(cap);
    smin.set(this.smin);
    const smax = new Uint16Array(cap);
    smax.set(this.smax);
    const area = new Uint8Array(cap);
    area.set(this.area);
    const next = new Int32Array(cap);
    next.set(this.next);
    this.smin = smin;
    this.smax = smax;
    this.area = area;
    this.next = next;
  }
}

/**
 * A dynamic heightfield representing obstructed space.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcHeightfield
 */
export class rcHeightfield {
  /** The width of the heightfield. (Along the x-axis in cell units.) */
  width = 0;
  /** The height of the heightfield. (Along the z-axis in cell units.) */
  height = 0;
  /** The minimum bounds in world space. [(x, y, z)] */
  readonly bmin = new Float32Array(3);
  /** The maximum bounds in world space. [(x, y, z)] */
  readonly bmax = new Float32Array(3);
  /** The size of each cell. (On the xz-plane.) */
  cs = 0;
  /** The height of each cell. (The minimum increment along the y-axis.) */
  ch = 0;
  /** Heightfield of spans (width*height): the id of the lowest span of each column, 0 if none. */
  spans: Int32Array = new Int32Array(0);
  /** The span storage. */
  pools: rcSpanPool = new rcSpanPool();
  /** The next free span (0 = none). */
  freelist = RC_NULL_SPAN;
}

/**
 * Cell columns of a compact heightfield. C++ `cells[i].index` (24 bits) is `index[i]`, `cells[i].count` (8 bits) is
 * `count[i]`; the `Uint8Array` wraps like the bitfield.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcCompactCell
 */
export class rcCompactCells {
  /** Index to the first span in the column. */
  readonly index: Uint32Array;
  /** Number of spans in the column. */
  readonly count: Uint8Array;

  constructor(n: number) {
    this.index = new Uint32Array(n);
    this.count = new Uint8Array(n);
  }
}

/**
 * Spans of a compact heightfield. C++ `spans[i].y` is `y[i]`, and so on; `con` holds the 24-bit packed connections.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcCompactSpan
 */
export class rcCompactSpans {
  /** The lower extent of the span. (Measured from the heightfield's base.) */
  readonly y: Uint16Array;
  /** The id of the region the span belongs to. (Or zero if not in a region.) */
  readonly reg: Uint16Array;
  /** Packed neighbor connection data (24 bits). */
  readonly con: Uint32Array;
  /** The height of the span. (Measured from #y.) */
  readonly h: Uint8Array;

  constructor(n: number) {
    this.y = new Uint16Array(n);
    this.reg = new Uint16Array(n);
    this.con = new Uint32Array(n);
    this.h = new Uint8Array(n);
  }
}

/**
 * A compact, static heightfield representing unobstructed space.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcCompactHeightfield
 */
export class rcCompactHeightfield {
  /** The width of the heightfield. (Along the x-axis in cell units.) */
  width = 0;
  /** The height of the heightfield. (Along the z-axis in cell units.) */
  height = 0;
  /** The number of spans in the heightfield. */
  spanCount = 0;
  /** The walkable height used during the build of the field. (See: rcConfig::walkableHeight) */
  walkableHeight = 0;
  /** The walkable climb used during the build of the field. (See: rcConfig::walkableClimb) */
  walkableClimb = 0;
  /** The AABB border size used during the build of the field. (See: rcConfig::borderSize) */
  borderSize = 0;
  /** The maximum distance value of any span within the field (`unsigned short`). */
  maxDistance = 0;
  /** The maximum region id of any span within the field (`unsigned short`). */
  maxRegions = 0;
  /** The minimum bounds in world space. [(x, y, z)] */
  readonly bmin = new Float32Array(3);
  /** The maximum bounds in world space. [(x, y, z)] */
  readonly bmax = new Float32Array(3);
  /** The size of each cell. (On the xz-plane.) */
  cs = 0;
  /** The height of each cell. (The minimum increment along the y-axis.) */
  ch = 0;
  /** Array of cells. [Size: #width*#height] */
  cells: rcCompactCells = new rcCompactCells(0);
  /** Array of spans. [Size: #spanCount] */
  spans: rcCompactSpans = new rcCompactSpans(0);
  /** Array containing border distance data. [Size: #spanCount] */
  dist: Uint16Array | null = null;
  /** Array containing area id data. [Size: #spanCount] */
  areas: Uint8Array = new Uint8Array(0);
}

/**
 * Represents a heightfield layer within a layer set.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcHeightfieldLayer
 */
export class rcHeightfieldLayer {
  /** The minimum bounds in world space. [(x, y, z)] */
  readonly bmin = new Float32Array(3);
  /** The maximum bounds in world space. [(x, y, z)] */
  readonly bmax = new Float32Array(3);
  /** The size of each cell. (On the xz-plane.) */
  cs = 0;
  /** The height of each cell. (The minimum increment along the y-axis.) */
  ch = 0;
  /** The width of the heightfield. (Along the x-axis in cell units.) */
  width = 0;
  /** The height of the heightfield. (Along the z-axis in cell units.) */
  height = 0;
  /** The minimum x-bounds of usable data. */
  minx = 0;
  /** The maximum x-bounds of usable data. */
  maxx = 0;
  /** The minimum y-bounds of usable data. (Along the z-axis.) */
  miny = 0;
  /** The maximum y-bounds of usable data. (Along the z-axis.) */
  maxy = 0;
  /** The minimum height bounds of usable data. (Along the y-axis.) */
  hmin = 0;
  /** The maximum height bounds of usable data. (Along the y-axis.) */
  hmax = 0;
  /** The heightfield. [Size: width * height] */
  heights: Uint8Array | null = null;
  /** Area ids. [Size: Same as #heights] */
  areas: Uint8Array | null = null;
  /** Packed neighbor connection information. [Size: Same as #heights] */
  cons: Uint8Array | null = null;
}

/**
 * Represents a set of heightfield layers.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcHeightfieldLayerSet
 */
export class rcHeightfieldLayerSet {
  /** The layers in the set. [Size: #nlayers] */
  layers: rcHeightfieldLayer[] | null = null;
  /** The number of layers in the set. */
  nlayers = 0;
}

/**
 * Represents a simple, non-overlapping contour in field space.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcContour
 */
export class rcContour {
  /** Simplified contour vertex and connection data. [Size: 4 * #nverts] */
  verts: Int32Array | null = null;
  /** The number of vertices in the simplified contour. */
  nverts = 0;
  /** Raw contour vertex and connection data. [Size: 4 * #nrverts] */
  rverts: Int32Array | null = null;
  /** The number of vertices in the raw contour. */
  nrverts = 0;
  /** The region id of the contour (`unsigned short`). */
  reg = 0;
  /** The area id of the contour (`unsigned char`). */
  area = 0;
}

/**
 * Represents a group of related contours.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcContourSet
 */
export class rcContourSet {
  /** An array of the contours in the set. [Size: #nconts] */
  conts: rcContour[] = [];
  /** The number of contours in the set. */
  nconts = 0;
  /** The minimum bounds in world space. [(x, y, z)] */
  readonly bmin = new Float32Array(3);
  /** The maximum bounds in world space. [(x, y, z)] */
  readonly bmax = new Float32Array(3);
  /** The size of each cell. (On the xz-plane.) */
  cs = 0;
  /** The height of each cell. (The minimum increment along the y-axis.) */
  ch = 0;
  /** The width of the set. (Along the x-axis in cell units.) */
  width = 0;
  /** The height of the set. (Along the z-axis in cell units.) */
  height = 0;
  /** The AABB border size used to generate the source data from which the contours were derived. */
  borderSize = 0;
  /** The max edge error that this contour set was simplified with. */
  maxError = 0;
}

/**
 * Represents a polygon mesh suitable for use in building a navigation mesh.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcPolyMesh
 */
export class rcPolyMesh {
  /** The mesh vertices. [Form: (x, y, z) * #nverts] */
  verts: Uint16Array | null = null;
  /** Polygon and neighbor data. [Length: #maxpolys * 2 * #nvp] */
  polys: Uint16Array | null = null;
  /** The region id assigned to each polygon. [Length: #maxpolys] */
  regs: Uint16Array | null = null;
  /** The user defined flags for each polygon. [Length: #maxpolys] */
  flags: Uint16Array | null = null;
  /** The area id assigned to each polygon. [Length: #maxpolys] */
  areas: Uint8Array | null = null;
  /** The number of vertices. */
  nverts = 0;
  /** The number of polygons. */
  npolys = 0;
  /** The number of allocated polygons. */
  maxpolys = 0;
  /** The maximum number of vertices per polygon. */
  nvp = 0;
  /** The minimum bounds in world space. [(x, y, z)] */
  readonly bmin = new Float32Array(3);
  /** The maximum bounds in world space. [(x, y, z)] */
  readonly bmax = new Float32Array(3);
  /** The size of each cell. (On the xz-plane.) */
  cs = 0;
  /** The height of each cell. (The minimum increment along the y-axis.) */
  ch = 0;
  /** The AABB border size used to generate the source data from which the mesh was derived. */
  borderSize = 0;
  /** The max error of the polygon edges in the mesh. */
  maxEdgeError = 0;
}

/**
 * Contains triangle meshes that represent detailed height data associated with the polygons in its associated
 * polygon mesh object.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcPolyMeshDetail
 */
export class rcPolyMeshDetail {
  /** The sub-mesh data. [Size: 4*#nmeshes] */
  meshes: Uint32Array | null = null;
  /** The mesh vertices. [Size: 3*#nverts] */
  verts: Float32Array | null = null;
  /** The mesh triangles. [Size: 4*#ntris] */
  tris: Uint8Array | null = null;
  /** The number of sub-meshes defined by #meshes. */
  nmeshes = 0;
  /** The number of vertices in #verts. */
  nverts = 0;
  /** The number of triangles in #tris. */
  ntris = 0;
}

/** @ac deps/recastnavigation/Recast/Source/Recast.cpp rcAllocHeightfield */
export function rcAllocHeightfield(): rcHeightfield {
  return new rcHeightfield();
}

/**
 * Releases the span storage. The object itself is garbage collected.
 * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcFreeHeightField
 * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcHeightfield::~rcHeightfield
 */
export function rcFreeHeightField(hf: rcHeightfield | null): void {
  if (!hf) return;
  hf.spans = new Int32Array(0);
  hf.pools = new rcSpanPool(0);
  hf.freelist = RC_NULL_SPAN;
}

/** @ac deps/recastnavigation/Recast/Source/Recast.cpp rcAllocCompactHeightfield */
export function rcAllocCompactHeightfield(): rcCompactHeightfield {
  return new rcCompactHeightfield();
}

/**
 * Releases the arrays. The object itself is garbage collected.
 * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcFreeCompactHeightfield
 * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcCompactHeightfield::~rcCompactHeightfield
 */
export function rcFreeCompactHeightfield(chf: rcCompactHeightfield | null): void {
  if (!chf) return;
  chf.cells = new rcCompactCells(0);
  chf.spans = new rcCompactSpans(0);
  chf.dist = null;
  chf.areas = new Uint8Array(0);
}

/** @ac deps/recastnavigation/Recast/Source/Recast.cpp rcAllocHeightfieldLayerSet */
export function rcAllocHeightfieldLayerSet(): rcHeightfieldLayerSet {
  return new rcHeightfieldLayerSet();
}

/**
 * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcFreeHeightfieldLayerSet
 * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcHeightfieldLayerSet::~rcHeightfieldLayerSet
 */
export function rcFreeHeightfieldLayerSet(lset: rcHeightfieldLayerSet | null): void {
  if (!lset) return;
  lset.layers = null;
  lset.nlayers = 0;
}

/** @ac deps/recastnavigation/Recast/Source/Recast.cpp rcAllocContourSet */
export function rcAllocContourSet(): rcContourSet {
  return new rcContourSet();
}

/**
 * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcFreeContourSet
 * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcContourSet::~rcContourSet
 */
export function rcFreeContourSet(cset: rcContourSet | null): void {
  if (!cset) return;
  cset.conts = [];
  cset.nconts = 0;
}

/** @ac deps/recastnavigation/Recast/Source/Recast.cpp rcAllocPolyMesh */
export function rcAllocPolyMesh(): rcPolyMesh {
  return new rcPolyMesh();
}

/**
 * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcFreePolyMesh
 * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcPolyMesh::~rcPolyMesh
 */
export function rcFreePolyMesh(pmesh: rcPolyMesh | null): void {
  if (!pmesh) return;
  pmesh.verts = null;
  pmesh.polys = null;
  pmesh.regs = null;
  pmesh.flags = null;
  pmesh.areas = null;
}

/** @ac deps/recastnavigation/Recast/Source/Recast.cpp rcAllocPolyMeshDetail */
export function rcAllocPolyMeshDetail(): rcPolyMeshDetail {
  return new rcPolyMeshDetail();
}

/** @ac deps/recastnavigation/Recast/Source/Recast.cpp rcFreePolyMeshDetail */
export function rcFreePolyMeshDetail(dmesh: rcPolyMeshDetail | null): void {
  if (!dmesh) return;
  dmesh.meshes = null;
  dmesh.verts = null;
  dmesh.tris = null;
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h RC_BORDER_REG */
export const RC_BORDER_REG = 0x8000;
/** @ac deps/recastnavigation/Recast/Include/Recast.h RC_MULTIPLE_REGS */
export const RC_MULTIPLE_REGS = 0;
/** @ac deps/recastnavigation/Recast/Include/Recast.h RC_BORDER_VERTEX */
export const RC_BORDER_VERTEX = 0x10000;
/** @ac deps/recastnavigation/Recast/Include/Recast.h RC_AREA_BORDER */
export const RC_AREA_BORDER = 0x20000;

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcBuildContoursFlags */
export const rcBuildContoursFlags = {
  RC_CONTOUR_TESS_WALL_EDGES: 0x01,
  RC_CONTOUR_TESS_AREA_EDGES: 0x02,
} as const;
export const RC_CONTOUR_TESS_WALL_EDGES = rcBuildContoursFlags.RC_CONTOUR_TESS_WALL_EDGES;
export const RC_CONTOUR_TESS_AREA_EDGES = rcBuildContoursFlags.RC_CONTOUR_TESS_AREA_EDGES;

/** @ac deps/recastnavigation/Recast/Include/Recast.h RC_CONTOUR_REG_MASK */
export const RC_CONTOUR_REG_MASK = 0xffff;
/** @ac deps/recastnavigation/Recast/Include/Recast.h RC_MESH_NULL_IDX */
export const RC_MESH_NULL_IDX = 0xffff;
/** @ac deps/recastnavigation/Recast/Include/Recast.h RC_NULL_AREA */
export const RC_NULL_AREA = 0;
/** @ac deps/recastnavigation/Recast/Include/Recast.h RC_WALKABLE_AREA */
export const RC_WALKABLE_AREA = 63;
/** @ac deps/recastnavigation/Recast/Include/Recast.h RC_NOT_CONNECTED */
export const RC_NOT_CONNECTED = 0x3f;

/**
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcIgnoreUnused
 * @ac-skip TypeScript has no unused-parameter warnings to silence.
 */
export function rcIgnoreUnused(_value: unknown): void {}

/**
 * `rcSwap(T& a, T& b)` swaps two lvalues. JavaScript has no references, so call sites swap their locals inline; this
 * helper swaps two array elements.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcSwap
 */
export function rcSwap(arr: { [i: number]: number }, a: number, b: number): void {
  const t = arr[a]!;
  arr[a] = arr[b]!;
  arr[b] = t;
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcMin */
export function rcMin(a: number, b: number): number {
  return a < b ? a : b;
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcMax */
export function rcMax(a: number, b: number): number {
  return a > b ? a : b;
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcAbs */
export function rcAbs(a: number): number {
  return a < 0 ? -a : a;
}

/** `T` is the argument type: wrap in `f32` for `float`. @ac deps/recastnavigation/Recast/Include/Recast.h rcSqr */
export function rcSqr(a: number): number {
  return a * a;
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcClamp */
export function rcClamp(v: number, mn: number, mx: number): number {
  return v < mn ? mn : v > mx ? mx : v;
}

/** @ac deps/recastnavigation/Recast/Source/Recast.cpp rcSqrt */
export function rcSqrt(x: number): number {
  return f32(Math.sqrt(x));
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcVcross */
export function rcVcross(dest: Float32Array, d: number, v1: Float32Array, i1: number, v2: Float32Array, i2: number): void {
  const x = f32(f32(v1[i1 + 1]! * v2[i2 + 2]!) - f32(v1[i1 + 2]! * v2[i2 + 1]!));
  const y = f32(f32(v1[i1 + 2]! * v2[i2]!) - f32(v1[i1]! * v2[i2 + 2]!));
  const z = f32(f32(v1[i1]! * v2[i2 + 1]!) - f32(v1[i1 + 1]! * v2[i2]!));
  dest[d] = x;
  dest[d + 1] = y;
  dest[d + 2] = z;
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcVdot */
export function rcVdot(v1: Float32Array, i1: number, v2: Float32Array, i2: number): number {
  return f32(f32(f32(v1[i1]! * v2[i2]!) + f32(v1[i1 + 1]! * v2[i2 + 1]!)) + f32(v1[i1 + 2]! * v2[i2 + 2]!));
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcVmad */
export function rcVmad(dest: Float32Array, d: number, v1: Float32Array, i1: number, v2: Float32Array, i2: number, s: number): void {
  s = f32(s);
  dest[d] = v1[i1]! + f32(v2[i2]! * s);
  dest[d + 1] = v1[i1 + 1]! + f32(v2[i2 + 1]! * s);
  dest[d + 2] = v1[i1 + 2]! + f32(v2[i2 + 2]! * s);
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcVadd */
export function rcVadd(dest: Float32Array, d: number, v1: Float32Array, i1: number, v2: Float32Array, i2: number): void {
  dest[d] = v1[i1]! + v2[i2]!;
  dest[d + 1] = v1[i1 + 1]! + v2[i2 + 1]!;
  dest[d + 2] = v1[i1 + 2]! + v2[i2 + 2]!;
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcVsub */
export function rcVsub(dest: Float32Array, d: number, v1: Float32Array, i1: number, v2: Float32Array, i2: number): void {
  dest[d] = v1[i1]! - v2[i2]!;
  dest[d + 1] = v1[i1 + 1]! - v2[i2 + 1]!;
  dest[d + 2] = v1[i1 + 2]! - v2[i2 + 2]!;
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcVmin */
export function rcVmin(mn: Float32Array, m: number, v: Float32Array, vi: number): void {
  mn[m] = rcMin(mn[m]!, v[vi]!);
  mn[m + 1] = rcMin(mn[m + 1]!, v[vi + 1]!);
  mn[m + 2] = rcMin(mn[m + 2]!, v[vi + 2]!);
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcVmax */
export function rcVmax(mx: Float32Array, m: number, v: Float32Array, vi: number): void {
  mx[m] = rcMax(mx[m]!, v[vi]!);
  mx[m + 1] = rcMax(mx[m + 1]!, v[vi + 1]!);
  mx[m + 2] = rcMax(mx[m + 2]!, v[vi + 2]!);
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcVcopy */
export function rcVcopy(dest: Float32Array, d: number, v: Float32Array, vi: number): void {
  dest[d] = v[vi]!;
  dest[d + 1] = v[vi + 1]!;
  dest[d + 2] = v[vi + 2]!;
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcVdist */
export function rcVdist(v1: Float32Array, i1: number, v2: Float32Array, i2: number): number {
  const dx = f32(v2[i2]! - v1[i1]!);
  const dy = f32(v2[i2 + 1]! - v1[i1 + 1]!);
  const dz = f32(v2[i2 + 2]! - v1[i1 + 2]!);
  return rcSqrt(f32(f32(f32(dx * dx) + f32(dy * dy)) + f32(dz * dz)));
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcVdistSqr */
export function rcVdistSqr(v1: Float32Array, i1: number, v2: Float32Array, i2: number): number {
  const dx = f32(v2[i2]! - v1[i1]!);
  const dy = f32(v2[i2 + 1]! - v1[i1 + 1]!);
  const dz = f32(v2[i2 + 2]! - v1[i1 + 2]!);
  return f32(f32(f32(dx * dx) + f32(dy * dy)) + f32(dz * dz));
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcVnormalize */
export function rcVnormalize(v: Float32Array, vi: number): void {
  const d = f32(1.0 / rcSqrt(f32(f32(f32(v[vi]! * v[vi]!) + f32(v[vi + 1]! * v[vi + 1]!)) + f32(v[vi + 2]! * v[vi + 2]!))));
  v[vi] = v[vi]! * d;
  v[vi + 1] = v[vi + 1]! * d;
  v[vi + 2] = v[vi + 2]! * d;
}

/**
 * Sets the neighbor connection data for the specified direction. C++ `rcSetCon(chf.spans[s], dir, i)` is
 * `rcSetCon(chf.spans.con, s, dir, i)`.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcSetCon
 */
export function rcSetCon(con: Uint32Array, s: number, dir: number, i: number): void {
  const shift = dir * 6;
  con[s] = (con[s]! & ~(0x3f << shift)) | ((i & 0x3f) << shift);
}

/**
 * Gets neighbor connection data for the specified direction. C++ `rcGetCon(chf.spans[s], dir)` is
 * `rcGetCon(chf.spans.con, s, dir)`.
 * @ac deps/recastnavigation/Recast/Include/Recast.h rcGetCon
 */
export function rcGetCon(con: Uint32Array, s: number, dir: number): number {
  return (con[s]! >>> (dir * 6)) & 0x3f;
}

const rcDirOffsetX = new Int32Array([-1, 0, 1, 0]);
const rcDirOffsetY = new Int32Array([0, 1, 0, -1]);
const rcDirForOffset = new Int32Array([3, 0, -1, 2, 1]);

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcGetDirOffsetX */
export function rcGetDirOffsetX(dir: number): number {
  return rcDirOffsetX[dir & 0x03]!;
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcGetDirOffsetY */
export function rcGetDirOffsetY(dir: number): number {
  return rcDirOffsetY[dir & 0x03]!;
}

/** @ac deps/recastnavigation/Recast/Include/Recast.h rcGetDirForOffset */
export function rcGetDirForOffset(x: number, y: number): number {
  return rcDirForOffset[((y + 1) << 1) + x]!;
}

/** A C++ `int*` / `float&` output parameter. */
export interface rcRef<T> {
  value: T;
}

/** @ac deps/recastnavigation/Recast/Source/Recast.cpp rcCalcBounds */
export function rcCalcBounds(verts: Float32Array, nv: number, bmin: Float32Array, bmax: Float32Array): void {
  // Calculate bounding box.
  rcVcopy(bmin, 0, verts, 0);
  rcVcopy(bmax, 0, verts, 0);
  for (let i = 1; i < nv; ++i) {
    rcVmin(bmin, 0, verts, i * 3);
    rcVmax(bmax, 0, verts, i * 3);
  }
}

/** @ac deps/recastnavigation/Recast/Source/Recast.cpp rcCalcGridSize */
export function rcCalcGridSize(bmin: Float32Array, bmax: Float32Array, cs: number, w: rcRef<number>, h: rcRef<number>): void {
  cs = f32(cs);
  w.value = f32(f32(f32(bmax[0]! - bmin[0]!) / cs) + 0.5) | 0;
  h.value = f32(f32(f32(bmax[2]! - bmin[2]!) / cs) + 0.5) | 0;
}

/**
 * Initializes a new heightfield.
 * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcCreateHeightfield
 */
export function rcCreateHeightfield(
  _ctx: rcContext | null,
  hf: rcHeightfield,
  width: number,
  height: number,
  bmin: Float32Array,
  bmax: Float32Array,
  cs: number,
  ch: number,
): boolean {
  hf.width = width;
  hf.height = height;
  rcVcopy(hf.bmin, 0, bmin, 0);
  rcVcopy(hf.bmax, 0, bmax, 0);
  hf.cs = f32(cs);
  hf.ch = f32(ch);
  hf.spans = new Int32Array(hf.width * hf.height);
  hf.pools = new rcSpanPool();
  hf.freelist = RC_NULL_SPAN;
  return true;
}

const calcTriNormalE0 = new Float32Array(3);
const calcTriNormalE1 = new Float32Array(3);

/** @ac deps/recastnavigation/Recast/Source/Recast.cpp calcTriNormal */
function calcTriNormal(verts: Float32Array, v0: number, v1: number, v2: number, norm: Float32Array): void {
  const e0 = calcTriNormalE0;
  const e1 = calcTriNormalE1;
  rcVsub(e0, 0, verts, v1, verts, v0);
  rcVsub(e1, 0, verts, v2, verts, v0);
  rcVcross(norm, 0, e0, 0, e1, 0);
  rcVnormalize(norm, 0);
}

const markWalkableNorm = new Float32Array(3);

/**
 * Sets the area id of all triangles with a slope below the specified value to `RC_WALKABLE_AREA`.
 * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcMarkWalkableTriangles
 */
export function rcMarkWalkableTriangles(
  _ctx: rcContext | null,
  walkableSlopeAngle: number,
  verts: Float32Array,
  _nv: number,
  tris: Int32Array,
  nt: number,
  areas: Uint8Array,
): void {
  const walkableThr = f32(Math.cos(f32(f32(f32(walkableSlopeAngle) / 180.0) * RC_PI)));
  const norm = markWalkableNorm;
  for (let i = 0; i < nt; ++i) {
    const t = i * 3;
    calcTriNormal(verts, tris[t]! * 3, tris[t + 1]! * 3, tris[t + 2]! * 3, norm);
    // Check if the face is walkable.
    if (norm[1]! > walkableThr) areas[i] = RC_WALKABLE_AREA;
  }
}

/**
 * Sets the area id of all triangles with a slope greater than or equal to the specified value to `RC_NULL_AREA`.
 * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcClearUnwalkableTriangles
 */
export function rcClearUnwalkableTriangles(
  _ctx: rcContext | null,
  walkableSlopeAngle: number,
  verts: Float32Array,
  _nv: number,
  tris: Int32Array,
  nt: number,
  areas: Uint8Array,
): void {
  const walkableThr = f32(Math.cos(f32(f32(f32(walkableSlopeAngle) / 180.0) * RC_PI)));
  const norm = markWalkableNorm;
  for (let i = 0; i < nt; ++i) {
    const t = i * 3;
    calcTriNormal(verts, tris[t]! * 3, tris[t + 1]! * 3, tris[t + 2]! * 3, norm);
    // Check if the face is walkable.
    if (norm[1]! <= walkableThr) areas[i] = RC_NULL_AREA;
  }
}

/** @ac deps/recastnavigation/Recast/Source/Recast.cpp rcGetHeightFieldSpanCount */
export function rcGetHeightFieldSpanCount(_ctx: rcContext | null, hf: rcHeightfield): number {
  const w = hf.width;
  const h = hf.height;
  const { area, next } = hf.pools;
  let spanCount = 0;
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      for (let s = hf.spans[x + y * w]!; s; s = next[s]!) {
        if (area[s] !== RC_NULL_AREA) spanCount++;
      }
    }
  }
  return spanCount;
}

/**
 * Builds a compact heightfield representing open space, from a heightfield representing solid space.
 * @ac deps/recastnavigation/Recast/Source/Recast.cpp rcBuildCompactHeightfield
 */
export function rcBuildCompactHeightfield(
  ctx: rcContext,
  walkableHeight: number,
  walkableClimb: number,
  hf: rcHeightfield,
  chf: rcCompactHeightfield,
): boolean {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_BUILD_COMPACTHEIGHTFIELD);

  const w = hf.width;
  const h = hf.height;
  const spanCount = rcGetHeightFieldSpanCount(ctx, hf);

  // Fill in header.
  chf.width = w;
  chf.height = h;
  chf.spanCount = spanCount;
  chf.walkableHeight = walkableHeight;
  chf.walkableClimb = walkableClimb;
  chf.maxRegions = 0;
  rcVcopy(chf.bmin, 0, hf.bmin, 0);
  rcVcopy(chf.bmax, 0, hf.bmax, 0);
  chf.bmax[1] = chf.bmax[1]! + f32(walkableHeight * hf.ch);
  chf.cs = hf.cs;
  chf.ch = hf.ch;
  chf.cells = new rcCompactCells(w * h);
  chf.spans = new rcCompactSpans(spanCount);
  chf.areas = new Uint8Array(spanCount);

  const MAX_HEIGHT = 0xffff;
  const { smin, smax, area, next } = hf.pools;
  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;
  const spanY = chf.spans.y;
  const spanH = chf.spans.h;
  const spanCon = chf.spans.con;
  const areas = chf.areas;

  // Fill in cells and spans.
  let idx = 0;
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      let s = hf.spans[x + y * w]!;
      // If there are no spans at this cell, just leave the data to index=0, count=0.
      if (!s) continue;
      const c = x + y * w;
      cellIndex[c] = idx & 0xffffff;
      cellCount[c] = 0;
      while (s) {
        if (area[s] !== RC_NULL_AREA) {
          const bot = smax[s]!;
          const ns = next[s]!;
          const top = ns ? smin[ns]! : MAX_HEIGHT;
          spanY[idx] = rcClamp(bot, 0, 0xffff);
          spanH[idx] = rcClamp(top - bot, 0, 0xff);
          areas[idx] = area[s]!;
          idx++;
          cellCount[c]!++;
        }
        s = next[s]!;
      }
    }
  }

  // Find neighbour connections.
  const MAX_LAYERS = RC_NOT_CONNECTED - 1;
  let tooHighNeighbour = 0;
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const c = x + y * w;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        const sy = spanY[i]!;
        const sTop = sy + spanH[i]!;
        for (let dir = 0; dir < 4; ++dir) {
          rcSetCon(spanCon, i, dir, RC_NOT_CONNECTED);
          const nx = x + rcGetDirOffsetX(dir);
          const ny = y + rcGetDirOffsetY(dir);
          // First check that the neighbour cell is in bounds.
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;

          // Iterate over all neighbour spans and check if any of the is
          // accessible from current cell.
          const nc = nx + ny * w;
          const ncIndex = cellIndex[nc]!;
          for (let k = ncIndex, nk = ncIndex + cellCount[nc]!; k < nk; ++k) {
            const nsy = spanY[k]!;
            const bot = rcMax(sy, nsy);
            const top = rcMin(sTop, nsy + spanH[k]!);

            // Check that the gap between the spans is walkable,
            // and that the climb height between the gaps is not too high.
            if (top - bot >= walkableHeight && rcAbs(nsy - sy) <= walkableClimb) {
              // Mark direction as walkable.
              const lidx = k - ncIndex;
              if (lidx < 0 || lidx > MAX_LAYERS) {
                tooHighNeighbour = rcMax(tooHighNeighbour, lidx);
                continue;
              }
              rcSetCon(spanCon, i, dir, lidx);
              break;
            }
          }
        }
      }
    }
  }

  if (tooHighNeighbour > MAX_LAYERS) {
    ctx.log(RC_LOG_ERROR, "rcBuildCompactHeightfield: Heightfield has too many layers %d (max: %d)", tooHighNeighbour, MAX_LAYERS);
  }

  return true;
}
