/**
 * Port of `deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp`.
 *
 * Every C++ `float` operation is rounded with `f32` (see `Recast.ts`). Vectors are `(Float32Array, offset)` pairs;
 * `rcIntArray` is the shared legacy int vector and `rcHeightPatch` keeps `data` as a `Uint16Array`.
 */
import { rcIntArray } from "./RecastAlloc.ts";
import { rcAssert } from "./RecastAssert.ts";
import {
  RC_LOG_ERROR,
  RC_LOG_WARNING,
  RC_MESH_NULL_IDX,
  RC_MULTIPLE_REGS,
  RC_NOT_CONNECTED,
  RC_TIMER_BUILD_POLYMESHDETAIL,
  RC_TIMER_MERGE_POLYMESHDETAIL,
  f32,
  rcAbs,
  rcClamp,
  rcGetCon,
  rcGetDirForOffset,
  rcGetDirOffsetX,
  rcGetDirOffsetY,
  rcMax,
  rcMin,
  rcScopedTimer,
  rcSqrt,
  rcSwap,
  rcVcopy,
  rcVmax,
  rcVmin,
  type rcCompactHeightfield,
  type rcContext,
  type rcPolyMesh,
  type rcPolyMeshDetail,
  type rcRef,
} from "./Recast.ts";

/** `FLT_MAX`. */
const FLT_MAX = 3.4028234663852886e38;

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp RC_UNSET_HEIGHT */
const RC_UNSET_HEIGHT = 0xffff;

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp rcHeightPatch */
class rcHeightPatch {
  data: Uint16Array | null = null;
  xmin = 0;
  ymin = 0;
  width = 0;
  height = 0;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp vdot2 */
function vdot2(a: Float32Array, ai: number, b: Float32Array, bi: number): number {
  return f32(f32(a[ai]! * b[bi]!) + f32(a[ai + 2]! * b[bi + 2]!));
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp vdistSq2 */
function vdistSq2(p: Float32Array, pi: number, q: Float32Array, qi: number): number {
  const dx = f32(q[qi]! - p[pi]!);
  const dy = f32(q[qi + 2]! - p[pi + 2]!);
  return f32(f32(dx * dx) + f32(dy * dy));
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp vdist2 */
function vdist2(p: Float32Array, pi: number, q: Float32Array, qi: number): number {
  return f32(Math.sqrt(vdistSq2(p, pi, q, qi)));
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp vcross2 */
function vcross2(p1: Float32Array, i1: number, p2: Float32Array, i2: number, p3: Float32Array, i3: number): number {
  const u1 = f32(p2[i2]! - p1[i1]!);
  const v1 = f32(p2[i2 + 2]! - p1[i1 + 2]!);
  const u2 = f32(p3[i3]! - p1[i1]!);
  const v2 = f32(p3[i3 + 2]! - p1[i1 + 2]!);
  return f32(f32(u1 * v2) - f32(v1 * u2));
}

const CC_EPS = f32(1e-6);
const cc_v1 = new Float32Array(3);
const cc_v2 = new Float32Array(3);
const cc_v3 = new Float32Array(3);

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp circumCircle */
function circumCircle(
  p1: Float32Array,
  i1: number,
  p2: Float32Array,
  i2: number,
  p3: Float32Array,
  i3: number,
  c: Float32Array,
  ci: number,
  r: rcRef<number>,
): boolean {
  // Calculate the circle relative to p1, to avoid some precision issues.
  const v1 = cc_v1;
  const v2 = cc_v2;
  const v3 = cc_v3;
  v1[0] = 0;
  v1[1] = 0;
  v1[2] = 0;
  v2[0] = f32(p2[i2]! - p1[i1]!);
  v2[1] = f32(p2[i2 + 1]! - p1[i1 + 1]!);
  v2[2] = f32(p2[i2 + 2]! - p1[i1 + 2]!);
  v3[0] = f32(p3[i3]! - p1[i1]!);
  v3[1] = f32(p3[i3 + 1]! - p1[i1 + 1]!);
  v3[2] = f32(p3[i3 + 2]! - p1[i1 + 2]!);

  const cp = vcross2(v1, 0, v2, 0, v3, 0);
  if (Math.abs(cp) > CC_EPS) {
    const v1Sq = vdot2(v1, 0, v1, 0);
    const v2Sq = vdot2(v2, 0, v2, 0);
    const v3Sq = vdot2(v3, 0, v3, 0);
    const cp2 = f32(2 * cp);
    c[ci] = f32(
      f32(f32(f32(v1Sq * f32(v2[2]! - v3[2]!)) + f32(v2Sq * f32(v3[2]! - v1[2]!))) + f32(v3Sq * f32(v1[2]! - v2[2]!))) / cp2,
    );
    c[ci + 1] = 0;
    c[ci + 2] = f32(
      f32(f32(f32(v1Sq * f32(v3[0]! - v2[0]!)) + f32(v2Sq * f32(v1[0]! - v3[0]!))) + f32(v3Sq * f32(v2[0]! - v1[0]!))) / cp2,
    );
    r.value = vdist2(c, ci, v1, 0);
    c[ci] = f32(c[ci]! + p1[i1]!);
    c[ci + 1] = f32(c[ci + 1]! + p1[i1 + 1]!);
    c[ci + 2] = f32(c[ci + 2]! + p1[i1 + 2]!);
    return true;
  }

  rcVcopy(c, ci, p1, i1);
  r.value = 0;
  return false;
}

const DPT_EPS = f32(1e-4);
const DPT_ONE_PLUS_EPS = f32(1 + DPT_EPS);
const dpt_v0 = new Float32Array(3);
const dpt_v1 = new Float32Array(3);
const dpt_v2 = new Float32Array(3);

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp distPtTri */
function distPtTri(
  p: Float32Array,
  pi: number,
  a: Float32Array,
  ai: number,
  b: Float32Array,
  bi: number,
  c: Float32Array,
  ci: number,
): number {
  const v0 = dpt_v0;
  const v1 = dpt_v1;
  const v2 = dpt_v2;
  v0[0] = f32(c[ci]! - a[ai]!);
  v0[1] = f32(c[ci + 1]! - a[ai + 1]!);
  v0[2] = f32(c[ci + 2]! - a[ai + 2]!);
  v1[0] = f32(b[bi]! - a[ai]!);
  v1[1] = f32(b[bi + 1]! - a[ai + 1]!);
  v1[2] = f32(b[bi + 2]! - a[ai + 2]!);
  v2[0] = f32(p[pi]! - a[ai]!);
  v2[1] = f32(p[pi + 1]! - a[ai + 1]!);
  v2[2] = f32(p[pi + 2]! - a[ai + 2]!);

  const dot00 = vdot2(v0, 0, v0, 0);
  const dot01 = vdot2(v0, 0, v1, 0);
  const dot02 = vdot2(v0, 0, v2, 0);
  const dot11 = vdot2(v1, 0, v1, 0);
  const dot12 = vdot2(v1, 0, v2, 0);

  // Compute barycentric coordinates
  const invDenom = f32(1 / f32(f32(dot00 * dot11) - f32(dot01 * dot01)));
  const u = f32(f32(f32(dot11 * dot02) - f32(dot01 * dot12)) * invDenom);
  const v = f32(f32(f32(dot00 * dot12) - f32(dot01 * dot02)) * invDenom);

  // If point lies inside the triangle, return interpolated y-coord.
  if (u >= -DPT_EPS && v >= -DPT_EPS && f32(u + v) <= DPT_ONE_PLUS_EPS) {
    const y = f32(f32(a[ai + 1]! + f32(v0[1]! * u)) + f32(v1[1]! * v));
    return Math.abs(f32(y - p[pi + 1]!));
  }
  return FLT_MAX;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp distancePtSeg */
function distancePtSeg(pt: Float32Array, pti: number, p: Float32Array, pi: number, q: Float32Array, qi: number): number {
  const pqx = f32(q[qi]! - p[pi]!);
  const pqy = f32(q[qi + 1]! - p[pi + 1]!);
  const pqz = f32(q[qi + 2]! - p[pi + 2]!);
  let dx = f32(pt[pti]! - p[pi]!);
  let dy = f32(pt[pti + 1]! - p[pi + 1]!);
  let dz = f32(pt[pti + 2]! - p[pi + 2]!);
  const d = f32(f32(f32(pqx * pqx) + f32(pqy * pqy)) + f32(pqz * pqz));
  let t = f32(f32(f32(pqx * dx) + f32(pqy * dy)) + f32(pqz * dz));
  if (d > 0) t = f32(t / d);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;

  dx = f32(f32(p[pi]! + f32(t * pqx)) - pt[pti]!);
  dy = f32(f32(p[pi + 1]! + f32(t * pqy)) - pt[pti + 1]!);
  dz = f32(f32(p[pi + 2]! + f32(t * pqz)) - pt[pti + 2]!);

  return f32(f32(f32(dx * dx) + f32(dy * dy)) + f32(dz * dz));
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp distancePtSeg2d */
function distancePtSeg2d(pt: Float32Array, pti: number, p: Float32Array, pi: number, q: Float32Array, qi: number): number {
  const pqx = f32(q[qi]! - p[pi]!);
  const pqz = f32(q[qi + 2]! - p[pi + 2]!);
  let dx = f32(pt[pti]! - p[pi]!);
  let dz = f32(pt[pti + 2]! - p[pi + 2]!);
  const d = f32(f32(pqx * pqx) + f32(pqz * pqz));
  let t = f32(f32(pqx * dx) + f32(pqz * dz));
  if (d > 0) t = f32(t / d);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;

  dx = f32(f32(p[pi]! + f32(t * pqx)) - pt[pti]!);
  dz = f32(f32(p[pi + 2]! + f32(t * pqz)) - pt[pti + 2]!);

  return f32(f32(dx * dx) + f32(dz * dz));
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp distToTriMesh */
function distToTriMesh(p: Float32Array, pi: number, verts: Float32Array, _nverts: number, tris: Int32Array, ntris: number): number {
  let dmin = FLT_MAX;
  for (let i = 0; i < ntris; ++i) {
    const va = tris[i * 4 + 0]! * 3;
    const vb = tris[i * 4 + 1]! * 3;
    const vc = tris[i * 4 + 2]! * 3;
    const d = distPtTri(p, pi, verts, va, verts, vb, verts, vc);
    if (d < dmin) dmin = d;
  }
  if (dmin === FLT_MAX) return -1;
  return dmin;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp distToPoly */
function distToPoly(nvert: number, verts: Float32Array, p: Float32Array, pi: number): number {
  let dmin = FLT_MAX;
  let c = false;
  for (let i = 0, j = nvert - 1; i < nvert; j = i++) {
    const vi = i * 3;
    const vj = j * 3;
    if (
      verts[vi + 2]! > p[pi + 2]! !== verts[vj + 2]! > p[pi + 2]! &&
      p[pi]! <
        f32(f32(f32(f32(verts[vj]! - verts[vi]!) * f32(p[pi + 2]! - verts[vi + 2]!)) / f32(verts[vj + 2]! - verts[vi + 2]!)) + verts[vi]!)
    )
      c = !c;
    dmin = rcMin(dmin, distancePtSeg2d(p, pi, verts, vj, verts, vi));
  }
  return c ? -dmin : dmin;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp getHeight */
function getHeight(fx: number, fy: number, fz: number, _cs: number, ics: number, ch: number, radius: number, hp: rcHeightPatch): number {
  const data = hp.data!;
  let ix = Math.floor(f32(f32(fx * ics) + f32(0.01))) | 0;
  let iz = Math.floor(f32(f32(fz * ics) + f32(0.01))) | 0;
  ix = rcClamp(ix - hp.xmin, 0, hp.width - 1);
  iz = rcClamp(iz - hp.ymin, 0, hp.height - 1);
  let h = data[ix + iz * hp.width]!;
  if (h === RC_UNSET_HEIGHT) {
    // Special case when data might be bad.
    // Walk adjacent cells in a spiral up to 'radius', and look
    // for a pixel which has a valid height.
    let x = 1;
    let z = 0;
    let dx = 1;
    let dz = 0;
    const maxSize = radius * 2 + 1;
    const maxIter = maxSize * maxSize - 1;

    let nextRingIterStart = 8;
    let nextRingIters = 16;

    let dmin = FLT_MAX;
    for (let i = 0; i < maxIter; i++) {
      const nx = ix + x;
      const nz = iz + z;

      if (nx >= 0 && nz >= 0 && nx < hp.width && nz < hp.height) {
        const nh = data[nx + nz * hp.width]!;
        if (nh !== RC_UNSET_HEIGHT) {
          const d = Math.abs(f32(f32(nh * ch) - fy));
          if (d < dmin) {
            h = nh;
            dmin = d;
          }
        }
      }

      // We are searching in a grid which looks approximately like this:
      //  __________
      // |2 ______ 2|
      // | |1 __ 1| |
      // | | |__| | |
      // | |______| |
      // |__________|
      // We want to find the best height as close to the center cell as possible. This means that
      // if we find a height in one of the neighbor cells to the center, we don't want to
      // expand further out than the 8 neighbors - we want to limit our search to the closest
      // of these "rings", but the best height in the ring.
      // For example, the center is just 1 cell. We checked that at the entrance to the function.
      // The next "ring" contains 8 cells (marked 1 above). Those are all the neighbors to the center cell.
      // The next one again contains 16 cells (marked 2). In general each ring has 8 additional cells, which
      // can be thought of as adding 2 cells around the "center" of each side when we expand the ring.
      // Here we detect if we are about to enter the next ring, and if we are and we have found
      // a height, we abort the search.
      if (i + 1 === nextRingIterStart) {
        if (h !== RC_UNSET_HEIGHT) break;

        nextRingIterStart += nextRingIters;
        nextRingIters += 8;
      }

      if (x === z || (x < 0 && x === -z) || (x > 0 && x === 1 - z)) {
        const tmp = dx;
        dx = -dz;
        dz = tmp;
      }
      x += dx;
      z += dz;
    }
  }
  return h;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp EdgeValues */
const EV_UNDEF = -1;
const EV_HULL = -2;

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp findEdge */
function findEdge(edges: Int32Array, nedges: number, s: number, t: number): number {
  for (let i = 0; i < nedges; i++) {
    const e = i * 4;
    if ((edges[e]! === s && edges[e + 1]! === t) || (edges[e]! === t && edges[e + 1]! === s)) return i;
  }
  return EV_UNDEF;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp addEdge */
function addEdge(
  ctx: rcContext,
  edges: Int32Array,
  nedges: rcRef<number>,
  maxEdges: number,
  s: number,
  t: number,
  l: number,
  r: number,
): number {
  if (nedges.value >= maxEdges) {
    ctx.log(RC_LOG_ERROR, "addEdge: Too many edges (%d/%d).", nedges.value, maxEdges);
    return EV_UNDEF;
  }

  // Add edge if not already in the triangulation.
  const e = findEdge(edges, nedges.value, s, t);
  if (e === EV_UNDEF) {
    const edge = nedges.value * 4;
    edges[edge] = s;
    edges[edge + 1] = t;
    edges[edge + 2] = l;
    edges[edge + 3] = r;
    return nedges.value++;
  }
  return EV_UNDEF;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp updateLeftFace */
function updateLeftFace(edges: Int32Array, e: number, s: number, t: number, f: number): void {
  if (edges[e]! === s && edges[e + 1]! === t && edges[e + 2]! === EV_UNDEF) edges[e + 2] = f;
  else if (edges[e + 1]! === s && edges[e]! === t && edges[e + 3]! === EV_UNDEF) edges[e + 3] = f;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp overlapSegSeg2d */
function overlapSegSeg2d(
  a: Float32Array,
  ai: number,
  b: Float32Array,
  bi: number,
  c: Float32Array,
  ci: number,
  d: Float32Array,
  di: number,
): number {
  const a1 = vcross2(a, ai, b, bi, d, di);
  const a2 = vcross2(a, ai, b, bi, c, ci);
  if (f32(a1 * a2) < 0) {
    const a3 = vcross2(c, ci, d, di, a, ai);
    const a4 = f32(f32(a3 + a2) - a1);
    if (f32(a3 * a4) < 0) return 1;
  }
  return 0;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp overlapEdges */
function overlapEdges(pts: Float32Array, edges: Int32Array, nedges: number, s1: number, t1: number): boolean {
  for (let i = 0; i < nedges; ++i) {
    const s0 = edges[i * 4 + 0]!;
    const t0 = edges[i * 4 + 1]!;
    // Same or connected edges do not overlap.
    if (s0 === s1 || s0 === t1 || t0 === s1 || t0 === t1) continue;
    if (overlapSegSeg2d(pts, s0 * 3, pts, t0 * 3, pts, s1 * 3, pts, t1 * 3)) return true;
  }
  return false;
}

const CF_EPS = f32(1e-5);
const CF_TOL = f32(0.001);
const CF_ONE_PLUS_TOL = f32(1 + CF_TOL);
const CF_ONE_MINUS_TOL = f32(1 - CF_TOL);
const cf_c = new Float32Array(3);
const cf_r: rcRef<number> = { value: 0 };

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp completeFacet */
function completeFacet(
  ctx: rcContext,
  pts: Float32Array,
  npts: number,
  edges: Int32Array,
  nedges: rcRef<number>,
  maxEdges: number,
  nfaces: rcRef<number>,
  e: number,
): void {
  const edge = e * 4;

  // Cache s and t.
  let s: number;
  let t: number;
  if (edges[edge + 2]! === EV_UNDEF) {
    s = edges[edge]!;
    t = edges[edge + 1]!;
  } else if (edges[edge + 3]! === EV_UNDEF) {
    s = edges[edge + 1]!;
    t = edges[edge]!;
  } else {
    // Edge already completed.
    return;
  }

  // Find best point on left of edge.
  let pt = npts;
  const c = cf_c;
  c[0] = 0;
  c[1] = 0;
  c[2] = 0;
  const r = cf_r;
  r.value = -1;
  for (let u = 0; u < npts; ++u) {
    if (u === s || u === t) continue;
    if (vcross2(pts, s * 3, pts, t * 3, pts, u * 3) > CF_EPS) {
      if (r.value < 0) {
        // The circle is not updated yet, do it now.
        pt = u;
        circumCircle(pts, s * 3, pts, t * 3, pts, u * 3, c, 0, r);
        continue;
      }
      const d = vdist2(c, 0, pts, u * 3);
      if (d > f32(r.value * CF_ONE_PLUS_TOL)) {
        // Outside current circumcircle, skip.
        continue;
      } else if (d < f32(r.value * CF_ONE_MINUS_TOL)) {
        // Inside safe circumcircle, update circle.
        pt = u;
        circumCircle(pts, s * 3, pts, t * 3, pts, u * 3, c, 0, r);
      } else {
        // Inside epsilon circum circle, do extra tests to make sure the edge is valid.
        // s-u and t-u cannot overlap with s-pt nor t-pt if they exists.
        if (overlapEdges(pts, edges, nedges.value, s, u)) continue;
        if (overlapEdges(pts, edges, nedges.value, t, u)) continue;
        // Edge is valid.
        pt = u;
        circumCircle(pts, s * 3, pts, t * 3, pts, u * 3, c, 0, r);
      }
    }
  }

  // Add new triangle or update edge info if s-t is on hull.
  if (pt < npts) {
    // Update face information of edge being completed.
    updateLeftFace(edges, e * 4, s, t, nfaces.value);

    // Add new edge or update face info of old edge.
    e = findEdge(edges, nedges.value, pt, s);
    if (e === EV_UNDEF) addEdge(ctx, edges, nedges, maxEdges, pt, s, nfaces.value, EV_UNDEF);
    else updateLeftFace(edges, e * 4, pt, s, nfaces.value);

    // Add new edge or update face info of old edge.
    e = findEdge(edges, nedges.value, t, pt);
    if (e === EV_UNDEF) addEdge(ctx, edges, nedges, maxEdges, t, pt, nfaces.value, EV_UNDEF);
    else updateLeftFace(edges, e * 4, t, pt, nfaces.value);

    nfaces.value++;
  } else {
    updateLeftFace(edges, e * 4, s, t, EV_HULL);
  }
}

/**
 * `hull` is an `int*` read at offset 0; `pts` holds `npts` vertices.
 * @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp delaunayHull
 */
function delaunayHull(
  ctx: rcContext,
  npts: number,
  pts: Float32Array,
  nhull: number,
  hull: Int32Array,
  tris: rcIntArray,
  edgesOut: rcIntArray,
): void {
  const nfaces: rcRef<number> = { value: 0 };
  const nedges: rcRef<number> = { value: 0 };
  const maxEdges = npts * 10;
  edgesOut.resize(maxEdges * 4);
  const edges = edgesOut.data;

  for (let i = 0, j = nhull - 1; i < nhull; j = i++) addEdge(ctx, edges, nedges, maxEdges, hull[j]!, hull[i]!, EV_HULL, EV_UNDEF);

  let currentEdge = 0;
  while (currentEdge < nedges.value) {
    if (edges[currentEdge * 4 + 2]! === EV_UNDEF) completeFacet(ctx, pts, npts, edges, nedges, maxEdges, nfaces, currentEdge);
    if (edges[currentEdge * 4 + 3]! === EV_UNDEF) completeFacet(ctx, pts, npts, edges, nedges, maxEdges, nfaces, currentEdge);
    currentEdge++;
  }

  // Create tris
  tris.resize(nfaces.value * 4);
  const td = tris.data;
  for (let i = 0; i < nfaces.value * 4; ++i) td[i] = -1;

  for (let i = 0; i < nedges.value; ++i) {
    const e = i * 4;
    if (edges[e + 3]! >= 0) {
      // Left face
      const t = edges[e + 3]! * 4;
      if (td[t]! === -1) {
        td[t] = edges[e]!;
        td[t + 1] = edges[e + 1]!;
      } else if (td[t]! === edges[e + 1]!) td[t + 2] = edges[e]!;
      else if (td[t + 1]! === edges[e]!) td[t + 2] = edges[e + 1]!;
    }
    if (edges[e + 2]! >= 0) {
      // Right
      const t = edges[e + 2]! * 4;
      if (td[t]! === -1) {
        td[t] = edges[e + 1]!;
        td[t + 1] = edges[e]!;
      } else if (td[t]! === edges[e]!) td[t + 2] = edges[e + 1]!;
      else if (td[t + 1]! === edges[e + 1]!) td[t + 2] = edges[e]!;
    }
  }

  for (let i = 0; i < tris.size() / 4; ++i) {
    const t = i * 4;
    if (td[t]! === -1 || td[t + 1]! === -1 || td[t + 2]! === -1) {
      ctx.log(RC_LOG_WARNING, "delaunayHull: Removing dangling face %d [%d,%d,%d].", i, td[t]!, td[t + 1]!, td[t + 2]!);
      const n = tris.size();
      td[t] = td[n - 4]!;
      td[t + 1] = td[n - 3]!;
      td[t + 2] = td[n - 2]!;
      td[t + 3] = td[n - 1]!;
      tris.resize(n - 4);
      --i;
    }
  }
}

/**
 * Calculate minimum extend of the polygon.
 * @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp polyMinExtent
 */
function polyMinExtent(verts: Float32Array, nverts: number): number {
  let minDist = FLT_MAX;
  for (let i = 0; i < nverts; i++) {
    const ni = (i + 1) % nverts;
    const p1 = i * 3;
    const p2 = ni * 3;
    let maxEdgeDist = 0;
    for (let j = 0; j < nverts; j++) {
      if (j === i || j === ni) continue;
      const d = distancePtSeg2d(verts, j * 3, verts, p1, verts, p2);
      maxEdgeDist = rcMax(maxEdgeDist, d);
    }
    minDist = rcMin(minDist, maxEdgeDist);
  }
  return rcSqrt(minDist);
}

/** Last time I checked the if version got compiled using cmov, which was a lot faster than module (with idiv). */
function prev(i: number, n: number): number {
  return i - 1 >= 0 ? i - 1 : n - 1;
}
function next(i: number, n: number): number {
  return i + 1 < n ? i + 1 : 0;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp triangulateHull */
function triangulateHull(_nverts: number, verts: Float32Array, nhull: number, hull: Int32Array, nin: number, tris: rcIntArray): void {
  let start = 0;
  let left = 1;
  let right = nhull - 1;

  // Start from an ear with shortest perimeter.
  // This tends to favor well formed triangles as starting point.
  let dmin = FLT_MAX;
  for (let i = 0; i < nhull; i++) {
    if (hull[i]! >= nin) continue; // Ears are triangles with original vertices as middle vertex while others are actually line segments on edges
    const pi = prev(i, nhull);
    const ni = next(i, nhull);
    const pv = hull[pi]! * 3;
    const cv = hull[i]! * 3;
    const nv = hull[ni]! * 3;
    const d = f32(f32(vdist2(verts, pv, verts, cv) + vdist2(verts, cv, verts, nv)) + vdist2(verts, nv, verts, pv));
    if (d < dmin) {
      start = i;
      left = ni;
      right = pi;
      dmin = d;
    }
  }

  // Add first triangle
  tris.push(hull[start]!);
  tris.push(hull[left]!);
  tris.push(hull[right]!);
  tris.push(0);

  // Triangulate the polygon by moving left or right,
  // depending on which triangle has shorter perimeter.
  // This heuristic was chose emprically, since it seems
  // handle tesselated straight edges well.
  while (next(left, nhull) !== right) {
    // Check to see if se should advance left or right.
    const nleft = next(left, nhull);
    const nright = prev(right, nhull);

    const cvleft = hull[left]! * 3;
    const nvleft = hull[nleft]! * 3;
    const cvright = hull[right]! * 3;
    const nvright = hull[nright]! * 3;
    const dleft = f32(vdist2(verts, cvleft, verts, nvleft) + vdist2(verts, nvleft, verts, cvright));
    const dright = f32(vdist2(verts, cvright, verts, nvright) + vdist2(verts, cvleft, verts, nvright));

    if (dleft < dright) {
      tris.push(hull[left]!);
      tris.push(hull[nleft]!);
      tris.push(hull[right]!);
      tris.push(0);
      left = nleft;
    } else {
      tris.push(hull[left]!);
      tris.push(hull[nright]!);
      tris.push(hull[right]!);
      tris.push(0);
      right = nright;
    }
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp getJitterX */
function getJitterX(i: number): number {
  return f32(f32(f32((Math.imul(i, 0x8da6b343) & 0xffff) / 65535) * 2) - 1);
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp getJitterY */
function getJitterY(i: number): number {
  return f32(f32(f32((Math.imul(i, 0xd8163841) & 0xffff) / 65535) * 2) - 1);
}

const BPD_MAX_VERTS = 127;
const BPD_MAX_TRIS = 255; // Max tris for delaunay is 2n-2-k (n=num verts, k=num hull verts).
const BPD_MAX_VERTS_PER_EDGE = 32;
const bpd_edge = new Float32Array((BPD_MAX_VERTS_PER_EDGE + 1) * 3);
const bpd_hull = new Int32Array(BPD_MAX_VERTS);
const bpd_idx = new Int32Array(BPD_MAX_VERTS_PER_EDGE);
const bpd_bmin = new Float32Array(3);
const bpd_bmax = new Float32Array(3);
const bpd_pt = new Float32Array(3);
const bpd_bestpt = new Float32Array(3);
const F_0_1 = f32(0.1);
const F_1E6 = f32(1e-6);

/**
 * `in` is the polygon (`nin` vertices from offset 0) and `verts` the output vertices (`nin` copied, more appended).
 * @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp buildPolyDetail
 */
function buildPolyDetail(
  ctx: rcContext,
  inp: Float32Array,
  nin: number,
  sampleDist: number,
  sampleMaxError: number,
  heightSearchRadius: number,
  chf: rcCompactHeightfield,
  hp: rcHeightPatch,
  verts: Float32Array,
  nverts: rcRef<number>,
  tris: rcIntArray,
  edges: rcIntArray,
  samples: rcIntArray,
): boolean {
  const edge = bpd_edge;
  const hull = bpd_hull;
  let nhull = 0;

  nverts.value = nin;

  for (let i = 0; i < nin; ++i) rcVcopy(verts, i * 3, inp, i * 3);

  edges.resize(0);
  tris.resize(0);

  const cs = f32(chf.cs);
  const ics = f32(1 / cs);
  const chfch = f32(chf.ch);

  // Calculate minimum extents of the polygon based on input data.
  const minExtent = polyMinExtent(verts, nverts.value);

  // Tessellate outlines.
  // This is done in separate pass in order to ensure
  // seamless height values across the ply boundaries.
  if (sampleDist > 0) {
    for (let i = 0, j = nin - 1; i < nin; j = i++) {
      let vj = j * 3;
      let vi = i * 3;
      let swapped = false;
      // Make sure the segments are always handled in same order
      // using lexological sort or else there will be seams.
      if (Math.abs(f32(inp[vj]! - inp[vi]!)) < F_1E6) {
        if (inp[vj + 2]! > inp[vi + 2]!) {
          const t = vj;
          vj = vi;
          vi = t;
          swapped = true;
        }
      } else if (inp[vj]! > inp[vi]!) {
        const t = vj;
        vj = vi;
        vi = t;
        swapped = true;
      }
      // Create samples along the edge.
      const dx = f32(inp[vi]! - inp[vj]!);
      const dy = f32(inp[vi + 1]! - inp[vj + 1]!);
      const dz = f32(inp[vi + 2]! - inp[vj + 2]!);
      const d = f32(Math.sqrt(f32(f32(dx * dx) + f32(dz * dz))));
      let nn = 1 + (Math.floor(f32(d / sampleDist)) | 0);
      if (nn >= BPD_MAX_VERTS_PER_EDGE) nn = BPD_MAX_VERTS_PER_EDGE - 1;
      if (nverts.value + nn >= BPD_MAX_VERTS) nn = BPD_MAX_VERTS - 1 - nverts.value;

      for (let k = 0; k <= nn; ++k) {
        const u = f32(f32(k) / f32(nn));
        const pos = k * 3;
        edge[pos] = f32(inp[vj]! + f32(dx * u));
        edge[pos + 1] = f32(inp[vj + 1]! + f32(dy * u));
        edge[pos + 2] = f32(inp[vj + 2]! + f32(dz * u));
        edge[pos + 1] = f32(
          getHeight(edge[pos]!, edge[pos + 1]!, edge[pos + 2]!, cs, ics, chfch, heightSearchRadius, hp) * chfch,
        );
      }
      // Simplify samples.
      const idx = bpd_idx;
      idx.fill(0);
      idx[0] = 0;
      idx[1] = nn;
      let nidx = 2;
      for (let k = 0; k < nidx - 1; ) {
        const a = idx[k]!;
        const b = idx[k + 1]!;
        const va = a * 3;
        const vb = b * 3;
        // Find maximum deviation along the segment.
        let maxd = 0;
        let maxi = -1;
        for (let m = a + 1; m < b; ++m) {
          const dev = distancePtSeg(edge, m * 3, edge, va, edge, vb);
          if (dev > maxd) {
            maxd = dev;
            maxi = m;
          }
        }
        // If the max deviation is larger than accepted error,
        // add new point, else continue to next segment.
        if (maxi !== -1 && maxd > f32(sampleMaxError * sampleMaxError)) {
          for (let m = nidx; m > k; --m) idx[m] = idx[m - 1]!;
          idx[k + 1] = maxi;
          nidx++;
        } else {
          ++k;
        }
      }

      hull[nhull++] = j;
      // Add new vertices.
      if (swapped) {
        for (let k = nidx - 2; k > 0; --k) {
          rcVcopy(verts, nverts.value * 3, edge, idx[k]! * 3);
          hull[nhull++] = nverts.value;
          nverts.value++;
        }
      } else {
        for (let k = 1; k < nidx - 1; ++k) {
          rcVcopy(verts, nverts.value * 3, edge, idx[k]! * 3);
          hull[nhull++] = nverts.value;
          nverts.value++;
        }
      }
    }
  }

  // If the polygon minimum extent is small (sliver or small triangle), do not try to add internal points.
  if (minExtent < f32(sampleDist * 2)) {
    triangulateHull(nverts.value, verts, nhull, hull, nin, tris);
    return true;
  }

  // Tessellate the base mesh.
  // We're using the triangulateHull instead of delaunayHull as it tends to
  // create a bit better triangulation for long thin triangles when there
  // are no internal points.
  triangulateHull(nverts.value, verts, nhull, hull, nin, tris);

  if (tris.size() === 0) {
    // Could not triangulate the poly, make sure there is some valid data there.
    ctx.log(RC_LOG_WARNING, "buildPolyDetail: Could not triangulate polygon (%d verts).", nverts.value);
    return true;
  }

  if (sampleDist > 0) {
    // Create sample locations in a grid.
    const bmin = bpd_bmin;
    const bmax = bpd_bmax;
    rcVcopy(bmin, 0, inp, 0);
    rcVcopy(bmax, 0, inp, 0);
    for (let i = 1; i < nin; ++i) {
      rcVmin(bmin, 0, inp, i * 3);
      rcVmax(bmax, 0, inp, i * 3);
    }
    const x0 = Math.floor(f32(bmin[0]! / sampleDist)) | 0;
    const x1 = Math.ceil(f32(bmax[0]! / sampleDist)) | 0;
    const z0 = Math.floor(f32(bmin[2]! / sampleDist)) | 0;
    const z1 = Math.ceil(f32(bmax[2]! / sampleDist)) | 0;
    samples.resize(0);
    const pt = bpd_pt;
    for (let z = z0; z < z1; ++z) {
      for (let x = x0; x < x1; ++x) {
        pt[0] = f32(x * sampleDist);
        pt[1] = f32(f32(bmax[1]! + bmin[1]!) * 0.5);
        pt[2] = f32(z * sampleDist);
        // Make sure the samples are not too close to the edges.
        if (distToPoly(nin, inp, pt, 0) > f32(-sampleDist / 2)) continue;
        samples.push(x);
        samples.push(getHeight(pt[0], pt[1], pt[2], cs, ics, chfch, heightSearchRadius, hp));
        samples.push(z);
        samples.push(0); // Not added
      }
    }

    // Add the samples starting from the one that has the most
    // error. The procedure stops when all samples are added
    // or when the max error is within treshold.
    const nsamples = (samples.size() / 4) | 0;
    const bestpt = bpd_bestpt;
    for (let iter = 0; iter < nsamples; ++iter) {
      if (nverts.value >= BPD_MAX_VERTS) break;

      // Find sample with most error.
      bestpt[0] = 0;
      bestpt[1] = 0;
      bestpt[2] = 0;
      let bestd = 0;
      let besti = -1;
      for (let i = 0; i < nsamples; ++i) {
        const s = i * 4;
        const sd = samples.data;
        if (sd[s + 3]!) continue; // skip added.
        // The sample location is jittered to get rid of some bad triangulations
        // which are cause by symmetrical data from the grid structure.
        pt[0] = f32(f32(sd[s]! * sampleDist) + f32(f32(getJitterX(i) * cs) * F_0_1));
        pt[1] = f32(sd[s + 1]! * chfch);
        pt[2] = f32(f32(sd[s + 2]! * sampleDist) + f32(f32(getJitterY(i) * cs) * F_0_1));
        const d = distToTriMesh(pt, 0, verts, nverts.value, tris.data, (tris.size() / 4) | 0);
        if (d < 0) continue; // did not hit the mesh.
        if (d > bestd) {
          bestd = d;
          besti = i;
          rcVcopy(bestpt, 0, pt, 0);
        }
      }
      // If the max error is within accepted threshold, stop tesselating.
      if (bestd <= sampleMaxError || besti === -1) break;
      // Mark sample as added.
      samples.data[besti * 4 + 3] = 1;
      // Add the new sample point.
      rcVcopy(verts, nverts.value * 3, bestpt, 0);
      nverts.value++;

      // Create new triangulation.
      // TODO: Incremental add instead of full rebuild.
      edges.resize(0);
      tris.resize(0);
      delaunayHull(ctx, nverts.value, verts, nhull, hull, tris, edges);
    }
  }

  const ntris = (tris.size() / 4) | 0;
  if (ntris > BPD_MAX_TRIS) {
    tris.resize(BPD_MAX_TRIS * 4);
    ctx.log(RC_LOG_ERROR, "rcBuildPolyMeshDetail: Shrinking triangle count from %d to max %d.", ntris, BPD_MAX_TRIS);
  }

  return true;
}

const SEED_OFFSET = new Int32Array([0, 0, -1, -1, 0, -1, 1, -1, 1, 0, 1, 1, 0, 1, -1, 1, -1, 0]);

/**
 * `poly` is the polygon indices at `polyOff` in `mesh.polys`, `verts` is `mesh.verts`.
 * @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp seedArrayWithPolyCenter
 */
function seedArrayWithPolyCenter(
  ctx: rcContext,
  chf: rcCompactHeightfield,
  poly: Uint16Array,
  polyOff: number,
  npoly: number,
  verts: Uint16Array,
  bs: number,
  hp: rcHeightPatch,
  array: rcIntArray,
): void {
  // Note: Reads to the compact heightfield are offset by border size (bs)
  // since border size offset is already removed from the polymesh vertices.

  const offset = SEED_OFFSET;

  // Find cell closest to a poly vertex
  let startCellX = 0;
  let startCellY = 0;
  let startSpanIndex = -1;
  let dmin = RC_UNSET_HEIGHT;
  for (let j = 0; j < npoly && dmin > 0; ++j) {
    for (let k = 0; k < 9 && dmin > 0; ++k) {
      const ax = verts[poly[polyOff + j]! * 3 + 0]! + offset[k * 2 + 0]!;
      const ay = verts[poly[polyOff + j]! * 3 + 1]!;
      const az = verts[poly[polyOff + j]! * 3 + 2]! + offset[k * 2 + 1]!;
      if (ax < hp.xmin || ax >= hp.xmin + hp.width || az < hp.ymin || az >= hp.ymin + hp.height) continue;

      const cell = ax + bs + (az + bs) * chf.width;
      for (let i = chf.cells.index[cell]!, ni = chf.cells.index[cell]! + chf.cells.count[cell]!; i < ni && dmin > 0; ++i) {
        const d = rcAbs(ay - chf.spans.y[i]!);
        if (d < dmin) {
          startCellX = ax;
          startCellY = az;
          startSpanIndex = i;
          dmin = d;
        }
      }
    }
  }

  rcAssert(startSpanIndex !== -1);
  // Find center of the polygon
  let pcx = 0;
  let pcy = 0;
  for (let j = 0; j < npoly; ++j) {
    pcx += verts[poly[polyOff + j]! * 3 + 0]!;
    pcy += verts[poly[polyOff + j]! * 3 + 2]!;
  }
  pcx = (pcx / npoly) | 0;
  pcy = (pcy / npoly) | 0;

  // Use seeds array as a stack for DFS
  array.resize(0);
  array.push(startCellX);
  array.push(startCellY);
  array.push(startSpanIndex);

  const dirs = new Int32Array([0, 1, 2, 3]);
  hp.data!.fill(0, 0, hp.width * hp.height);
  // DFS to move to the center. Note that we need a DFS here and can not just move
  // directly towards the center without recording intermediate nodes, even though the polygons
  // are convex. In very rare we can get stuck due to contour simplification if we do not
  // record nodes.
  let cx = -1;
  let cy = -1;
  let ci = -1;
  while (true) {
    if (array.size() < 3) {
      ctx.log(RC_LOG_WARNING, "Walk towards polygon center failed to reach center");
      break;
    }

    ci = array.pop();
    cy = array.pop();
    cx = array.pop();

    if (cx === pcx && cy === pcy) break;

    // If we are already at the correct X-position, prefer direction
    // directly towards the center in the Y-axis; otherwise prefer
    // direction in the X-axis
    let directDir: number;
    if (cx === pcx) directDir = rcGetDirForOffset(0, pcy > cy ? 1 : -1);
    else directDir = rcGetDirForOffset(pcx > cx ? 1 : -1, 0);

    // Push the direct dir last so we start with this on next iteration
    rcSwap(dirs, directDir, 3);

    for (let i = 0; i < 4; i++) {
      const dir = dirs[i]!;
      if (rcGetCon(chf.spans.con, ci, dir) === RC_NOT_CONNECTED) continue;

      const newX = cx + rcGetDirOffsetX(dir);
      const newY = cy + rcGetDirOffsetY(dir);

      const hpx = newX - hp.xmin;
      const hpy = newY - hp.ymin;
      if (hpx < 0 || hpx >= hp.width || hpy < 0 || hpy >= hp.height) continue;

      if (hp.data![hpx + hpy * hp.width]! !== 0) continue;

      hp.data![hpx + hpy * hp.width] = 1;
      array.push(newX);
      array.push(newY);
      array.push(chf.cells.index[newX + bs + (newY + bs) * chf.width]! + rcGetCon(chf.spans.con, ci, dir));
    }

    rcSwap(dirs, directDir, 3);
  }

  array.resize(0);
  // getHeightData seeds are given in coordinates with borders
  array.push(cx + bs);
  array.push(cy + bs);
  array.push(ci);

  hp.data!.fill(0xffff, 0, hp.width * hp.height);
  hp.data![cx - hp.xmin + (cy - hp.ymin) * hp.width] = chf.spans.y[ci]!;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp push3 */
function push3(queue: rcIntArray, v1: number, v2: number, v3: number): void {
  queue.resize(queue.size() + 3);
  const n = queue.size();
  queue.data[n - 3] = v1;
  queue.data[n - 2] = v2;
  queue.data[n - 1] = v3;
}

const RETRACT_SIZE = 256;

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp getHeightData */
function getHeightData(
  ctx: rcContext,
  chf: rcCompactHeightfield,
  poly: Uint16Array,
  polyOff: number,
  npoly: number,
  verts: Uint16Array,
  bs: number,
  hp: rcHeightPatch,
  queue: rcIntArray,
  region: number,
): void {
  // Note: Reads to the compact heightfield are offset by border size (bs)
  // since border size offset is already removed from the polymesh vertices.

  queue.resize(0);
  // Set all heights to RC_UNSET_HEIGHT.
  hp.data!.fill(0xffff, 0, hp.width * hp.height);

  let empty = true;

  // We cannot sample from this poly if it was created from polys
  // of different regions. If it was then it could potentially be overlapping
  // with polys of that region and the heights sampled here could be wrong.
  if (region !== RC_MULTIPLE_REGS) {
    // Copy the height from the same region, and mark region borders
    // as seed points to fill the rest.
    for (let hy = 0; hy < hp.height; hy++) {
      const y = hp.ymin + hy + bs;
      for (let hx = 0; hx < hp.width; hx++) {
        const x = hp.xmin + hx + bs;
        const cell = x + y * chf.width;
        for (let i = chf.cells.index[cell]!, ni = chf.cells.index[cell]! + chf.cells.count[cell]!; i < ni; ++i) {
          if (chf.spans.reg[i]! === region) {
            // Store height
            hp.data![hx + hy * hp.width] = chf.spans.y[i]!;
            empty = false;

            // If any of the neighbours is not in same region,
            // add the current location as flood fill start
            let border = false;
            for (let dir = 0; dir < 4; ++dir) {
              if (rcGetCon(chf.spans.con, i, dir) !== RC_NOT_CONNECTED) {
                const ax = x + rcGetDirOffsetX(dir);
                const ay = y + rcGetDirOffsetY(dir);
                const ai = chf.cells.index[ax + ay * chf.width]! + rcGetCon(chf.spans.con, i, dir);
                if (chf.spans.reg[ai]! !== region) {
                  border = true;
                  break;
                }
              }
            }
            if (border) push3(queue, x, y, i);
            break;
          }
        }
      }
    }
  }

  // if the polygon does not contain any points from the current region (rare, but happens)
  // or if it could potentially be overlapping polygons of the same region,
  // then use the center as the seed point.
  if (empty) seedArrayWithPolyCenter(ctx, chf, poly, polyOff, npoly, verts, bs, hp, queue);

  let head = 0;

  // We assume the seed is centered in the polygon, so a BFS to collect
  // height data will ensure we do not move onto overlapping polygons and
  // sample wrong heights.
  while (head * 3 < queue.size()) {
    const cx = queue.data[head * 3 + 0]!;
    const cy = queue.data[head * 3 + 1]!;
    const ci = queue.data[head * 3 + 2]!;
    head++;
    if (head >= RETRACT_SIZE) {
      head = 0;
      if (queue.size() > RETRACT_SIZE * 3) queue.data.copyWithin(0, RETRACT_SIZE * 3, queue.size());
      queue.resize(queue.size() - RETRACT_SIZE * 3);
    }

    for (let dir = 0; dir < 4; ++dir) {
      if (rcGetCon(chf.spans.con, ci, dir) === RC_NOT_CONNECTED) continue;

      const ax = cx + rcGetDirOffsetX(dir);
      const ay = cy + rcGetDirOffsetY(dir);
      const hx = ax - hp.xmin - bs;
      const hy = ay - hp.ymin - bs;

      if (hx >>> 0 >= hp.width || hy >>> 0 >= hp.height) continue;

      if (hp.data![hx + hy * hp.width]! !== RC_UNSET_HEIGHT) continue;

      const ai = chf.cells.index[ax + ay * chf.width]! + rcGetCon(chf.spans.con, ci, dir);

      hp.data![hx + hy * hp.width] = chf.spans.y[ai]!;

      push3(queue, ax, ay, ai);
    }
  }
}

const THR_SQR = f32(f32(0.001) * f32(0.001));

/**
 * The flag returned by this function matches dtDetailTriEdgeFlags in Detour. Figure out if edge (va,vb) is part of the
 * polygon boundary.
 * @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp getEdgeFlags
 */
function getEdgeFlags(va: Float32Array, vai: number, vb: Float32Array, vbi: number, vpoly: Float32Array, npoly: number): number {
  for (let i = 0, j = npoly - 1; i < npoly; j = i++) {
    if (distancePtSeg2d(va, vai, vpoly, j * 3, vpoly, i * 3) < THR_SQR && distancePtSeg2d(vb, vbi, vpoly, j * 3, vpoly, i * 3) < THR_SQR)
      return 1;
  }
  return 0;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp getTriFlags */
function getTriFlags(
  va: Float32Array,
  vai: number,
  vb: Float32Array,
  vbi: number,
  vc: Float32Array,
  vci: number,
  vpoly: Float32Array,
  npoly: number,
): number {
  let flags = 0;
  flags |= getEdgeFlags(va, vai, vb, vbi, vpoly, npoly) << 0;
  flags |= getEdgeFlags(vb, vbi, vc, vci, vpoly, npoly) << 2;
  flags |= getEdgeFlags(vc, vci, va, vai, vpoly, npoly) << 4;
  return flags;
}

/**
 * See the #rcConfig documentation for more information on the configuration parameters.
 * @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp rcBuildPolyMeshDetail
 */
export function rcBuildPolyMeshDetail(
  ctx: rcContext,
  mesh: rcPolyMesh,
  chf: rcCompactHeightfield,
  sampleDist: number,
  sampleMaxError: number,
  dmesh: rcPolyMeshDetail,
): boolean {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_BUILD_POLYMESHDETAIL);
  sampleDist = f32(sampleDist);
  sampleMaxError = f32(sampleMaxError);

  if (mesh.nverts === 0 || mesh.npolys === 0) return true;

  const nvp = mesh.nvp;
  const cs = f32(mesh.cs);
  const ch = f32(mesh.ch);
  const orig = mesh.bmin;
  const borderSize = mesh.borderSize;
  const heightSearchRadius = rcMax(1, Math.ceil(mesh.maxEdgeError) | 0);
  const mpolys = mesh.polys!;
  const mverts = mesh.verts!;

  const edges = new rcIntArray(64);
  const tris = new rcIntArray(512);
  const arr = new rcIntArray(512);
  const samples = new rcIntArray(512);
  const verts = new Float32Array(256 * 3);
  const hp = new rcHeightPatch();
  let nPolyVerts = 0;
  let maxhw = 0;
  let maxhh = 0;

  const bounds = new Int32Array(mesh.npolys * 4);
  const poly = new Float32Array(nvp * 3);

  // Find max size for a polygon area.
  for (let i = 0; i < mesh.npolys; ++i) {
    const p = i * nvp * 2;
    let xmin = chf.width;
    let xmax = 0;
    let ymin = chf.height;
    let ymax = 0;
    for (let j = 0; j < nvp; ++j) {
      if (mpolys[p + j] === RC_MESH_NULL_IDX) break;
      const v = mpolys[p + j]! * 3;
      xmin = rcMin(xmin, mverts[v]!);
      xmax = rcMax(xmax, mverts[v]!);
      ymin = rcMin(ymin, mverts[v + 2]!);
      ymax = rcMax(ymax, mverts[v + 2]!);
      nPolyVerts++;
    }
    xmin = rcMax(0, xmin - 1);
    xmax = rcMin(chf.width, xmax + 1);
    ymin = rcMax(0, ymin - 1);
    ymax = rcMin(chf.height, ymax + 1);
    bounds[i * 4 + 0] = xmin;
    bounds[i * 4 + 1] = xmax;
    bounds[i * 4 + 2] = ymin;
    bounds[i * 4 + 3] = ymax;
    if (xmin >= xmax || ymin >= ymax) continue;
    maxhw = rcMax(maxhw, xmax - xmin);
    maxhh = rcMax(maxhh, ymax - ymin);
  }

  hp.data = new Uint16Array(maxhw * maxhh);

  dmesh.nmeshes = mesh.npolys;
  dmesh.nverts = 0;
  dmesh.ntris = 0;
  dmesh.meshes = new Uint32Array(dmesh.nmeshes * 4);

  let vcap = nPolyVerts + ((nPolyVerts / 2) | 0);
  let tcap = vcap * 2;

  dmesh.nverts = 0;
  dmesh.verts = new Float32Array(vcap * 3);
  dmesh.ntris = 0;
  dmesh.tris = new Uint8Array(tcap * 4);

  const nv: rcRef<number> = { value: 0 };
  for (let i = 0; i < mesh.npolys; ++i) {
    const p = i * nvp * 2;

    // Store polygon vertices for processing.
    let npoly = 0;
    for (let j = 0; j < nvp; ++j) {
      if (mpolys[p + j] === RC_MESH_NULL_IDX) break;
      const v = mpolys[p + j]! * 3;
      poly[j * 3 + 0] = f32(mverts[v]! * cs);
      poly[j * 3 + 1] = f32(mverts[v + 1]! * ch);
      poly[j * 3 + 2] = f32(mverts[v + 2]! * cs);
      npoly++;
    }

    // Get the height data from the area of the polygon.
    hp.xmin = bounds[i * 4 + 0]!;
    hp.ymin = bounds[i * 4 + 2]!;
    hp.width = bounds[i * 4 + 1]! - bounds[i * 4 + 0]!;
    hp.height = bounds[i * 4 + 3]! - bounds[i * 4 + 2]!;
    getHeightData(ctx, chf, mpolys, p, npoly, mverts, borderSize, hp, arr, mesh.regs![i]!);

    // Build detail mesh.
    nv.value = 0;
    if (!buildPolyDetail(ctx, poly, npoly, sampleDist, sampleMaxError, heightSearchRadius, chf, hp, verts, nv, tris, edges, samples)) {
      return false;
    }
    const nverts = nv.value;

    // Move detail verts to world space.
    const chfch = f32(chf.ch);
    for (let j = 0; j < nverts; ++j) {
      verts[j * 3 + 0] = f32(verts[j * 3 + 0]! + orig[0]!);
      verts[j * 3 + 1] = f32(verts[j * 3 + 1]! + f32(orig[1]! + chfch)); // Is this offset necessary?
      verts[j * 3 + 2] = f32(verts[j * 3 + 2]! + orig[2]!);
    }
    // Offset poly too, will be used to flag checking.
    for (let j = 0; j < npoly; ++j) {
      poly[j * 3 + 0] = f32(poly[j * 3 + 0]! + orig[0]!);
      poly[j * 3 + 1] = f32(poly[j * 3 + 1]! + orig[1]!);
      poly[j * 3 + 2] = f32(poly[j * 3 + 2]! + orig[2]!);
    }

    // Store detail submesh.
    const ntris = (tris.size() / 4) | 0;

    dmesh.meshes[i * 4 + 0] = dmesh.nverts;
    dmesh.meshes[i * 4 + 1] = nverts;
    dmesh.meshes[i * 4 + 2] = dmesh.ntris;
    dmesh.meshes[i * 4 + 3] = ntris;

    // Store vertices, allocate more memory if necessary.
    if (dmesh.nverts + nverts > vcap) {
      while (dmesh.nverts + nverts > vcap) vcap += 256;

      const newv = new Float32Array(vcap * 3);
      if (dmesh.nverts) newv.set(dmesh.verts!.subarray(0, 3 * dmesh.nverts));
      dmesh.verts = newv;
    }
    for (let j = 0; j < nverts; ++j) {
      dmesh.verts![dmesh.nverts * 3 + 0] = verts[j * 3 + 0]!;
      dmesh.verts![dmesh.nverts * 3 + 1] = verts[j * 3 + 1]!;
      dmesh.verts![dmesh.nverts * 3 + 2] = verts[j * 3 + 2]!;
      dmesh.nverts++;
    }

    // Store triangles, allocate more memory if necessary.
    if (dmesh.ntris + ntris > tcap) {
      while (dmesh.ntris + ntris > tcap) tcap += 256;
      const newt = new Uint8Array(tcap * 4);
      if (dmesh.ntris) newt.set(dmesh.tris!.subarray(0, 4 * dmesh.ntris));
      dmesh.tris = newt;
    }
    const td = tris.data;
    for (let j = 0; j < ntris; ++j) {
      const t = j * 4;
      dmesh.tris![dmesh.ntris * 4 + 0] = td[t]!;
      dmesh.tris![dmesh.ntris * 4 + 1] = td[t + 1]!;
      dmesh.tris![dmesh.ntris * 4 + 2] = td[t + 2]!;
      dmesh.tris![dmesh.ntris * 4 + 3] = getTriFlags(verts, td[t]! * 3, verts, td[t + 1]! * 3, verts, td[t + 2]! * 3, poly, npoly);
      dmesh.ntris++;
    }
  }

  return true;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMeshDetail.cpp rcMergePolyMeshDetails */
export function rcMergePolyMeshDetails(ctx: rcContext, meshes: ReadonlyArray<rcPolyMeshDetail | null>, nmeshes: number, mesh: rcPolyMeshDetail): boolean {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_MERGE_POLYMESHDETAIL);

  let maxVerts = 0;
  let maxTris = 0;
  let maxMeshes = 0;

  for (let i = 0; i < nmeshes; ++i) {
    const m = meshes[i];
    if (!m) continue;
    maxVerts += m.nverts;
    maxTris += m.ntris;
    maxMeshes += m.nmeshes;
  }

  mesh.nmeshes = 0;
  mesh.meshes = new Uint32Array(maxMeshes * 4);

  mesh.ntris = 0;
  mesh.tris = new Uint8Array(maxTris * 4);

  mesh.nverts = 0;
  mesh.verts = new Float32Array(maxVerts * 3);

  // Merge datas.
  for (let i = 0; i < nmeshes; ++i) {
    const dm = meshes[i];
    if (!dm) continue;
    for (let j = 0; j < dm.nmeshes; ++j) {
      const dst = mesh.nmeshes * 4;
      const src = j * 4;
      mesh.meshes[dst + 0] = mesh.nverts + dm.meshes![src]!;
      mesh.meshes[dst + 1] = dm.meshes![src + 1]!;
      mesh.meshes[dst + 2] = mesh.ntris + dm.meshes![src + 2]!;
      mesh.meshes[dst + 3] = dm.meshes![src + 3]!;
      mesh.nmeshes++;
    }

    for (let k = 0; k < dm.nverts; ++k) {
      rcVcopy(mesh.verts, mesh.nverts * 3, dm.verts!, k * 3);
      mesh.nverts++;
    }
    for (let k = 0; k < dm.ntris; ++k) {
      mesh.tris[mesh.ntris * 4 + 0] = dm.tris![k * 4 + 0]!;
      mesh.tris[mesh.ntris * 4 + 1] = dm.tris![k * 4 + 1]!;
      mesh.tris[mesh.ntris * 4 + 2] = dm.tris![k * 4 + 2]!;
      mesh.tris[mesh.ntris * 4 + 3] = dm.tris![k * 4 + 3]!;
      mesh.ntris++;
    }
  }

  return true;
}
