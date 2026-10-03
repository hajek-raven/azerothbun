/**
 * Port of `deps/recastnavigation/Detour/Include/DetourCommon.h` and `Source/DetourCommon.cpp`.
 *
 * C++ passes vectors as `float*` that often point into the middle of a buffer (`&tile->verts[i*3]`). Every vector
 * argument here is therefore an `(array, offset)` pair: `dtVcopy(dest, d, a, ai)` is `dtVcopy(&dest[d], &a[ai])`.
 * Nothing allocates. Scalar `float&` outputs are `(array, index)` pairs too; the multi-value outputs of
 * `dtIntersectSegmentPoly2D` / `dtIntersectSegSeg2D` go to small result objects the caller owns.
 */
import { dtMathIsfinite, dtMathSqrtf } from "./DetourMath.ts";

/** Vector storage used by Detour (C++ `float*`). */
export type dtFloatArray = Float32Array;

/**
 * @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtIgnoreUnused
 * @ac-skip TypeScript has no unused-parameter warnings to silence.
 */
export function dtIgnoreUnused(_value: unknown): void {}

/**
 * `dtSwap(T& a, T& b)` swaps two lvalues. JavaScript has no references, so call sites swap their locals inline
 * (`[a, b] = [b, a]` is avoided in hot paths; a temp is used).
 * @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtSwap
 * @ac-skip no reference parameters in JavaScript; swapped inline at each call site
 */
export function dtSwap(arr: { [i: number]: number }, a: number, b: number): void {
  const t = arr[a]!;
  arr[a] = arr[b]!;
  arr[b] = t;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtMin */
export function dtMin(a: number, b: number): number {
  return a < b ? a : b;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtMax */
export function dtMax(a: number, b: number): number {
  return a > b ? a : b;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtAbs */
export function dtAbs(a: number): number {
  return a < 0 ? -a : a;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtSqr */
export function dtSqr(a: number): number {
  return a * a;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtClamp */
export function dtClamp(v: number, mn: number, mx: number): number {
  return v < mn ? mn : v > mx ? mx : v;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVcross */
export function dtVcross(dest: dtFloatArray, d: number, v1: dtFloatArray, i1: number, v2: dtFloatArray, i2: number): void {
  const x = v1[i1 + 1]! * v2[i2 + 2]! - v1[i1 + 2]! * v2[i2 + 1]!;
  const y = v1[i1 + 2]! * v2[i2]! - v1[i1]! * v2[i2 + 2]!;
  const z = v1[i1]! * v2[i2 + 1]! - v1[i1 + 1]! * v2[i2]!;
  dest[d] = x;
  dest[d + 1] = y;
  dest[d + 2] = z;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVdot */
export function dtVdot(v1: dtFloatArray, i1: number, v2: dtFloatArray, i2: number): number {
  return v1[i1]! * v2[i2]! + v1[i1 + 1]! * v2[i2 + 1]! + v1[i1 + 2]! * v2[i2 + 2]!;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVmad */
export function dtVmad(dest: dtFloatArray, d: number, v1: dtFloatArray, i1: number, v2: dtFloatArray, i2: number, s: number): void {
  dest[d] = v1[i1]! + v2[i2]! * s;
  dest[d + 1] = v1[i1 + 1]! + v2[i2 + 1]! * s;
  dest[d + 2] = v1[i1 + 2]! + v2[i2 + 2]! * s;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVlerp */
export function dtVlerp(dest: dtFloatArray, d: number, v1: dtFloatArray, i1: number, v2: dtFloatArray, i2: number, t: number): void {
  const x = v1[i1]! + (v2[i2]! - v1[i1]!) * t;
  const y = v1[i1 + 1]! + (v2[i2 + 1]! - v1[i1 + 1]!) * t;
  const z = v1[i1 + 2]! + (v2[i2 + 2]! - v1[i1 + 2]!) * t;
  dest[d] = x;
  dest[d + 1] = y;
  dest[d + 2] = z;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVadd */
export function dtVadd(dest: dtFloatArray, d: number, v1: dtFloatArray, i1: number, v2: dtFloatArray, i2: number): void {
  dest[d] = v1[i1]! + v2[i2]!;
  dest[d + 1] = v1[i1 + 1]! + v2[i2 + 1]!;
  dest[d + 2] = v1[i1 + 2]! + v2[i2 + 2]!;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVsub */
export function dtVsub(dest: dtFloatArray, d: number, v1: dtFloatArray, i1: number, v2: dtFloatArray, i2: number): void {
  dest[d] = v1[i1]! - v2[i2]!;
  dest[d + 1] = v1[i1 + 1]! - v2[i2 + 1]!;
  dest[d + 2] = v1[i1 + 2]! - v2[i2 + 2]!;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVscale */
export function dtVscale(dest: dtFloatArray, d: number, v: dtFloatArray, vi: number, t: number): void {
  dest[d] = v[vi]! * t;
  dest[d + 1] = v[vi + 1]! * t;
  dest[d + 2] = v[vi + 2]! * t;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVmin */
export function dtVmin(mn: dtFloatArray, mi: number, v: dtFloatArray, vi: number): void {
  mn[mi] = dtMin(mn[mi]!, v[vi]!);
  mn[mi + 1] = dtMin(mn[mi + 1]!, v[vi + 1]!);
  mn[mi + 2] = dtMin(mn[mi + 2]!, v[vi + 2]!);
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVmax */
export function dtVmax(mx: dtFloatArray, mi: number, v: dtFloatArray, vi: number): void {
  mx[mi] = dtMax(mx[mi]!, v[vi]!);
  mx[mi + 1] = dtMax(mx[mi + 1]!, v[vi + 1]!);
  mx[mi + 2] = dtMax(mx[mi + 2]!, v[vi + 2]!);
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVset */
export function dtVset(dest: dtFloatArray, d: number, x: number, y: number, z: number): void {
  dest[d] = x;
  dest[d + 1] = y;
  dest[d + 2] = z;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVcopy */
export function dtVcopy(dest: dtFloatArray, d: number, a: dtFloatArray, ai: number): void {
  dest[d] = a[ai]!;
  dest[d + 1] = a[ai + 1]!;
  dest[d + 2] = a[ai + 2]!;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVlen */
export function dtVlen(v: dtFloatArray, vi: number): number {
  return dtMathSqrtf(v[vi]! * v[vi]! + v[vi + 1]! * v[vi + 1]! + v[vi + 2]! * v[vi + 2]!);
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVlenSqr */
export function dtVlenSqr(v: dtFloatArray, vi: number): number {
  return v[vi]! * v[vi]! + v[vi + 1]! * v[vi + 1]! + v[vi + 2]! * v[vi + 2]!;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVdist */
export function dtVdist(v1: dtFloatArray, i1: number, v2: dtFloatArray, i2: number): number {
  const dx = v2[i2]! - v1[i1]!;
  const dy = v2[i2 + 1]! - v1[i1 + 1]!;
  const dz = v2[i2 + 2]! - v1[i1 + 2]!;
  return dtMathSqrtf(dx * dx + dy * dy + dz * dz);
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVdistSqr */
export function dtVdistSqr(v1: dtFloatArray, i1: number, v2: dtFloatArray, i2: number): number {
  const dx = v2[i2]! - v1[i1]!;
  const dy = v2[i2 + 1]! - v1[i1 + 1]!;
  const dz = v2[i2 + 2]! - v1[i1 + 2]!;
  return dx * dx + dy * dy + dz * dz;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVdist2D */
export function dtVdist2D(v1: dtFloatArray, i1: number, v2: dtFloatArray, i2: number): number {
  const dx = v2[i2]! - v1[i1]!;
  const dz = v2[i2 + 2]! - v1[i1 + 2]!;
  return dtMathSqrtf(dx * dx + dz * dz);
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVdist2DSqr */
export function dtVdist2DSqr(v1: dtFloatArray, i1: number, v2: dtFloatArray, i2: number): number {
  const dx = v2[i2]! - v1[i1]!;
  const dz = v2[i2 + 2]! - v1[i1 + 2]!;
  return dx * dx + dz * dz;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVnormalize */
export function dtVnormalize(v: dtFloatArray, vi: number): void {
  const d = 1.0 / dtMathSqrtf(dtSqr(v[vi]!) + dtSqr(v[vi + 1]!) + dtSqr(v[vi + 2]!));
  v[vi] = v[vi]! * d;
  v[vi + 1] = v[vi + 1]! * d;
  v[vi + 2] = v[vi + 2]! * d;
}

const DT_VEQUAL_THR = dtSqr(Math.fround(1.0 / 16384.0));

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVequal */
export function dtVequal(p0: dtFloatArray, i0: number, p1: dtFloatArray, i1: number): boolean {
  const d = dtVdistSqr(p0, i0, p1, i1);
  return d < DT_VEQUAL_THR;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVisfinite */
export function dtVisfinite(v: dtFloatArray, vi: number): boolean {
  return dtMathIsfinite(v[vi]!) && dtMathIsfinite(v[vi + 1]!) && dtMathIsfinite(v[vi + 2]!);
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVisfinite2D */
export function dtVisfinite2D(v: dtFloatArray, vi: number): boolean {
  return dtMathIsfinite(v[vi]!) && dtMathIsfinite(v[vi + 2]!);
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVdot2D */
export function dtVdot2D(u: dtFloatArray, ui: number, v: dtFloatArray, vi: number): number {
  return u[ui]! * v[vi]! + u[ui + 2]! * v[vi + 2]!;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtVperp2D */
export function dtVperp2D(u: dtFloatArray, ui: number, v: dtFloatArray, vi: number): number {
  return u[ui + 2]! * v[vi]! - u[ui]! * v[vi + 2]!;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtTriArea2D */
export function dtTriArea2D(a: dtFloatArray, ai: number, b: dtFloatArray, bi: number, c: dtFloatArray, ci: number): number {
  const abx = b[bi]! - a[ai]!;
  const abz = b[bi + 2]! - a[ai + 2]!;
  const acx = c[ci]! - a[ai]!;
  const acz = c[ci + 2]! - a[ai + 2]!;
  return acx * abz - abx * acz;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtOverlapQuantBounds */
export function dtOverlapQuantBounds(
  amin: Uint16Array,
  amini: number,
  amax: Uint16Array,
  amaxi: number,
  bmin: Uint16Array,
  bmini: number,
  bmax: Uint16Array,
  bmaxi: number,
): boolean {
  let overlap = true;
  overlap = amin[amini]! > bmax[bmaxi]! || amax[amaxi]! < bmin[bmini]! ? false : overlap;
  overlap = amin[amini + 1]! > bmax[bmaxi + 1]! || amax[amaxi + 1]! < bmin[bmini + 1]! ? false : overlap;
  overlap = amin[amini + 2]! > bmax[bmaxi + 2]! || amax[amaxi + 2]! < bmin[bmini + 2]! ? false : overlap;
  return overlap;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtOverlapBounds */
export function dtOverlapBounds(
  amin: dtFloatArray,
  amini: number,
  amax: dtFloatArray,
  amaxi: number,
  bmin: dtFloatArray,
  bmini: number,
  bmax: dtFloatArray,
  bmaxi: number,
): boolean {
  let overlap = true;
  overlap = amin[amini]! > bmax[bmaxi]! || amax[amaxi]! < bmin[bmini]! ? false : overlap;
  overlap = amin[amini + 1]! > bmax[bmaxi + 1]! || amax[amaxi + 1]! < bmin[bmini + 1]! ? false : overlap;
  overlap = amin[amini + 2]! > bmax[bmaxi + 2]! || amax[amaxi + 2]! < bmin[bmini + 2]! ? false : overlap;
  return overlap;
}

const cpt_ab = new Float32Array(3);
const cpt_ac = new Float32Array(3);
const cpt_ap = new Float32Array(3);
const cpt_bp = new Float32Array(3);
const cpt_cp = new Float32Array(3);

/** @ac deps/recastnavigation/Detour/Source/DetourCommon.cpp dtClosestPtPointTriangle */
export function dtClosestPtPointTriangle(
  closest: dtFloatArray,
  cl: number,
  p: dtFloatArray,
  pi: number,
  a: dtFloatArray,
  ai: number,
  b: dtFloatArray,
  bi: number,
  c: dtFloatArray,
  ci: number,
): void {
  // Check if P in vertex region outside A
  const ab = cpt_ab;
  const ac = cpt_ac;
  const ap = cpt_ap;
  dtVsub(ab, 0, b, bi, a, ai);
  dtVsub(ac, 0, c, ci, a, ai);
  dtVsub(ap, 0, p, pi, a, ai);
  const d1 = dtVdot(ab, 0, ap, 0);
  const d2 = dtVdot(ac, 0, ap, 0);
  if (d1 <= 0.0 && d2 <= 0.0) {
    // barycentric coordinates (1,0,0)
    dtVcopy(closest, cl, a, ai);
    return;
  }

  // Check if P in vertex region outside B
  const bp = cpt_bp;
  dtVsub(bp, 0, p, pi, b, bi);
  const d3 = dtVdot(ab, 0, bp, 0);
  const d4 = dtVdot(ac, 0, bp, 0);
  if (d3 >= 0.0 && d4 <= d3) {
    // barycentric coordinates (0,1,0)
    dtVcopy(closest, cl, b, bi);
    return;
  }

  // Check if P in edge region of AB, if so return projection of P onto AB
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {
    // barycentric coordinates (1-v,v,0)
    const v = d1 / (d1 - d3);
    closest[cl] = a[ai]! + v * ab[0]!;
    closest[cl + 1] = a[ai + 1]! + v * ab[1]!;
    closest[cl + 2] = a[ai + 2]! + v * ab[2]!;
    return;
  }

  // Check if P in vertex region outside C
  const cp = cpt_cp;
  dtVsub(cp, 0, p, pi, c, ci);
  const d5 = dtVdot(ab, 0, cp, 0);
  const d6 = dtVdot(ac, 0, cp, 0);
  if (d6 >= 0.0 && d5 <= d6) {
    // barycentric coordinates (0,0,1)
    dtVcopy(closest, cl, c, ci);
    return;
  }

  // Check if P in edge region of AC, if so return projection of P onto AC
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {
    // barycentric coordinates (1-w,0,w)
    const w = d2 / (d2 - d6);
    closest[cl] = a[ai]! + w * ac[0]!;
    closest[cl + 1] = a[ai + 1]! + w * ac[1]!;
    closest[cl + 2] = a[ai + 2]! + w * ac[2]!;
    return;
  }

  // Check if P in edge region of BC, if so return projection of P onto BC
  const va = d3 * d6 - d5 * d4;
  if (va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0) {
    // barycentric coordinates (0,1-w,w)
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    closest[cl] = b[bi]! + w * (c[ci]! - b[bi]!);
    closest[cl + 1] = b[bi + 1]! + w * (c[ci + 1]! - b[bi + 1]!);
    closest[cl + 2] = b[bi + 2]! + w * (c[ci + 2]! - b[bi + 2]!);
    return;
  }

  // P inside face region. Compute Q through its barycentric coordinates (u,v,w)
  const denom = 1.0 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  closest[cl] = a[ai]! + ab[0]! * v + ac[0]! * w;
  closest[cl + 1] = a[ai + 1]! + ab[1]! * v + ac[1]! * w;
  closest[cl + 2] = a[ai + 2]! + ab[2]! * v + ac[2]! * w;
}

/** Result of `dtIntersectSegmentPoly2D` (the C++ `float& tmin, float& tmax, int& segMin, int& segMax`). */
export class dtSegmentPolyIntersection {
  tmin = 0;
  tmax = 1;
  segMin = -1;
  segMax = -1;
}

const isp_dir = new Float32Array(3);
const isp_edge = new Float32Array(3);
const isp_diff = new Float32Array(3);

/** @ac deps/recastnavigation/Detour/Source/DetourCommon.cpp dtIntersectSegmentPoly2D */
export function dtIntersectSegmentPoly2D(
  p0: dtFloatArray,
  p0i: number,
  p1: dtFloatArray,
  p1i: number,
  verts: dtFloatArray,
  nverts: number,
  out: dtSegmentPolyIntersection,
): boolean {
  const EPS = 0.00000001;

  out.tmin = 0;
  out.tmax = 1;
  out.segMin = -1;
  out.segMax = -1;

  const dir = isp_dir;
  dtVsub(dir, 0, p1, p1i, p0, p0i);

  for (let i = 0, j = nverts - 1; i < nverts; j = i++) {
    const edge = isp_edge;
    const diff = isp_diff;
    dtVsub(edge, 0, verts, i * 3, verts, j * 3);
    dtVsub(diff, 0, p0, p0i, verts, j * 3);
    const n = dtVperp2D(edge, 0, diff, 0);
    const d = dtVperp2D(dir, 0, edge, 0);
    if (Math.abs(d) < EPS) {
      // S is nearly parallel to this edge
      if (n < 0) return false;
      else continue;
    }
    const t = n / d;
    if (d < 0) {
      // segment S is entering across this edge
      if (t > out.tmin) {
        out.tmin = t;
        out.segMin = j;
        // S enters after leaving polygon
        if (out.tmin > out.tmax) return false;
      }
    } else {
      // segment S is leaving across this edge
      if (t < out.tmax) {
        out.tmax = t;
        out.segMax = j;
        // S leaves before entering polygon
        if (out.tmax < out.tmin) return false;
      }
    }
  }

  return true;
}

/**
 * Returns the squared 2D distance and writes the segment parameter to `t[ti]` (the C++ `float& t`).
 * @ac deps/recastnavigation/Detour/Source/DetourCommon.cpp dtDistancePtSegSqr2D
 */
export function dtDistancePtSegSqr2D(
  pt: dtFloatArray,
  pti: number,
  p: dtFloatArray,
  pi: number,
  q: dtFloatArray,
  qi: number,
  t: dtFloatArray,
  ti: number,
): number {
  const pqx = q[qi]! - p[pi]!;
  const pqz = q[qi + 2]! - p[pi + 2]!;
  let dx = pt[pti]! - p[pi]!;
  let dz = pt[pti + 2]! - p[pi + 2]!;
  const d = pqx * pqx + pqz * pqz;
  let tt = pqx * dx + pqz * dz;
  if (d > 0) tt /= d;
  if (tt < 0) tt = 0;
  else if (tt > 1) tt = 1;
  t[ti] = tt;
  // C++ continues with the float `t`; read back the stored (float) value.
  const tf = t[ti]!;
  dx = p[pi]! + tf * pqx - pt[pti]!;
  dz = p[pi + 2]! + tf * pqz - pt[pti + 2]!;
  return dx * dx + dz * dz;
}

/** @ac deps/recastnavigation/Detour/Source/DetourCommon.cpp dtCalcPolyCenter */
export function dtCalcPolyCenter(tc: dtFloatArray, tci: number, idx: Uint16Array, idxi: number, nidx: number, verts: dtFloatArray): void {
  let x = 0.0;
  let y = 0.0;
  let z = 0.0;
  for (let j = 0; j < nidx; ++j) {
    const v = idx[idxi + j]! * 3;
    x += verts[v]!;
    y += verts[v + 1]!;
    z += verts[v + 2]!;
  }
  const s = 1.0 / nidx;
  tc[tci] = x * s;
  tc[tci + 1] = y * s;
  tc[tci + 2] = z * s;
}

const chpt_v0 = new Float32Array(3);
const chpt_v1 = new Float32Array(3);
const chpt_v2 = new Float32Array(3);

/**
 * Writes the interpolated height to `h[hi]` (the C++ `float& h`) when the point is inside the triangle.
 * @ac deps/recastnavigation/Detour/Source/DetourCommon.cpp dtClosestHeightPointTriangle
 */
export function dtClosestHeightPointTriangle(
  p: dtFloatArray,
  pi: number,
  a: dtFloatArray,
  ai: number,
  b: dtFloatArray,
  bi: number,
  c: dtFloatArray,
  ci: number,
  h: dtFloatArray,
  hi: number,
): boolean {
  const EPS = 1e-6;
  const v0 = chpt_v0;
  const v1 = chpt_v1;
  const v2 = chpt_v2;

  dtVsub(v0, 0, c, ci, a, ai);
  dtVsub(v1, 0, b, bi, a, ai);
  dtVsub(v2, 0, p, pi, a, ai);

  // Compute scaled barycentric coordinates
  let denom = v0[0]! * v1[2]! - v0[2]! * v1[0]!;
  if (Math.abs(denom) < EPS) return false;

  let u = v1[2]! * v2[0]! - v1[0]! * v2[2]!;
  let v = v0[0]! * v2[2]! - v0[2]! * v2[0]!;

  if (denom < 0) {
    denom = -denom;
    u = -u;
    v = -v;
  }

  // If point lies inside the triangle, return interpolated ycoord.
  if (u >= 0.0 && v >= 0.0 && u + v <= denom) {
    h[hi] = a[ai + 1]! + (v0[1]! * u + v1[1]! * v) / denom;
    return true;
  }
  return false;
}

/**
 * All points are projected onto the xz-plane, so the y-values are ignored.
 * @ac deps/recastnavigation/Detour/Source/DetourCommon.cpp dtPointInPolygon
 */
export function dtPointInPolygon(pt: dtFloatArray, pti: number, verts: dtFloatArray, nverts: number): boolean {
  // TODO: Replace pnpoly with triArea2D tests?
  let c = false;
  const px = pt[pti]!;
  const pz = pt[pti + 2]!;
  for (let i = 0, j = nverts - 1; i < nverts; j = i++) {
    const vi = i * 3;
    const vj = j * 3;
    const viz = verts[vi + 2]!;
    const vjz = verts[vj + 2]!;
    if (viz > pz !== vjz > pz && px < ((verts[vj]! - verts[vi]!) * (pz - viz)) / (vjz - viz) + verts[vi]!) c = !c;
  }
  return c;
}

/** @ac deps/recastnavigation/Detour/Source/DetourCommon.cpp dtDistancePtPolyEdgesSqr */
export function dtDistancePtPolyEdgesSqr(
  pt: dtFloatArray,
  pti: number,
  verts: dtFloatArray,
  nverts: number,
  ed: dtFloatArray,
  et: dtFloatArray,
): boolean {
  // TODO: Replace pnpoly with triArea2D tests?
  let c = false;
  const px = pt[pti]!;
  const pz = pt[pti + 2]!;
  for (let i = 0, j = nverts - 1; i < nverts; j = i++) {
    const vi = i * 3;
    const vj = j * 3;
    const viz = verts[vi + 2]!;
    const vjz = verts[vj + 2]!;
    if (viz > pz !== vjz > pz && px < ((verts[vj]! - verts[vi]!) * (pz - viz)) / (vjz - viz) + verts[vi]!) c = !c;
    ed[j] = dtDistancePtSegSqr2D(pt, pti, verts, vj, verts, vi, et, j);
  }
  return c;
}

const projectPoly_out = new Float64Array(2);

/** Writes `rmin`/`rmax` to `projectPoly_out[0..1]`. @ac deps/recastnavigation/Detour/Source/DetourCommon.cpp projectPoly */
function projectPoly(axis: dtFloatArray, poly: dtFloatArray, npoly: number): void {
  let rmin = dtVdot2D(axis, 0, poly, 0);
  let rmax = rmin;
  for (let i = 1; i < npoly; ++i) {
    const d = dtVdot2D(axis, 0, poly, i * 3);
    rmin = dtMin(rmin, d);
    rmax = dtMax(rmax, d);
  }
  projectPoly_out[0] = rmin;
  projectPoly_out[1] = rmax;
}

/** @ac deps/recastnavigation/Detour/Source/DetourCommon.cpp overlapRange */
function overlapRange(amin: number, amax: number, bmin: number, bmax: number, eps: number): boolean {
  return amin + eps > bmax || amax - eps < bmin ? false : true;
}

const opp_n = new Float32Array(3);

/**
 * All vertices are projected onto the xz-plane, so the y-values are ignored.
 * @ac deps/recastnavigation/Detour/Source/DetourCommon.cpp dtOverlapPolyPoly2D
 */
export function dtOverlapPolyPoly2D(polya: dtFloatArray, npolya: number, polyb: dtFloatArray, npolyb: number): boolean {
  const eps = 1e-4;
  const n = opp_n;

  for (let i = 0, j = npolya - 1; i < npolya; j = i++) {
    const va = j * 3;
    const vb = i * 3;
    dtVset(n, 0, polya[vb + 2]! - polya[va + 2]!, 0, -(polya[vb]! - polya[va]!));
    projectPoly(n, polya, npolya);
    const amin = projectPoly_out[0]!;
    const amax = projectPoly_out[1]!;
    projectPoly(n, polyb, npolyb);
    if (!overlapRange(amin, amax, projectPoly_out[0]!, projectPoly_out[1]!, eps)) {
      // Found separating axis
      return false;
    }
  }
  for (let i = 0, j = npolyb - 1; i < npolyb; j = i++) {
    const va = j * 3;
    const vb = i * 3;
    dtVset(n, 0, polyb[vb + 2]! - polyb[va + 2]!, 0, -(polyb[vb]! - polyb[va]!));
    projectPoly(n, polya, npolya);
    const amin = projectPoly_out[0]!;
    const amax = projectPoly_out[1]!;
    projectPoly(n, polyb, npolyb);
    if (!overlapRange(amin, amax, projectPoly_out[0]!, projectPoly_out[1]!, eps)) {
      // Found separating axis
      return false;
    }
  }
  return true;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtNextPow2 */
export function dtNextPow2(v: number): number {
  v = (v - 1) >>> 0;
  v |= v >>> 1;
  v |= v >>> 2;
  v |= v >>> 4;
  v |= v >>> 8;
  v |= v >>> 16;
  return ((v >>> 0) + 1) >>> 0;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtIlog2 */
export function dtIlog2(v: number): number {
  v >>>= 0;
  let r = (v > 0xffff ? 1 : 0) << 4;
  v >>>= r;
  let shift = (v > 0xff ? 1 : 0) << 3;
  v >>>= shift;
  r |= shift;
  shift = (v > 0xf ? 1 : 0) << 2;
  v >>>= shift;
  r |= shift;
  shift = (v > 0x3 ? 1 : 0) << 1;
  v >>>= shift;
  r |= shift;
  r |= v >>> 1;
  return r;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtAlign4 */
export function dtAlign4(x: number): number {
  return (x + 3) & ~3;
}

/** @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtOppositeTile */
export function dtOppositeTile(side: number): number {
  return (side + 4) & 0x7;
}

/** Swaps the bytes `data[a]` and `data[b]`. @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtSwapByte */
export function dtSwapByte(data: Uint8Array, a: number, b: number): void {
  const tmp = data[a]!;
  data[a] = data[b]!;
  data[b] = tmp;
}

/**
 * The `dtSwapEndian` overloads (`unsigned short*`, `short*`, `unsigned int*`, `int*`, `float*`): reverses the
 * `size` bytes at `data[offset]`.
 * @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtSwapEndian
 */
export function dtSwapEndian(data: Uint8Array, offset: number, size: 2 | 4): void {
  if (size === 2) {
    dtSwapByte(data, offset, offset + 1);
  } else {
    dtSwapByte(data, offset, offset + 3);
    dtSwapByte(data, offset + 1, offset + 2);
  }
}

/** @ac deps/recastnavigation/Detour/Source/DetourCommon.cpp dtRandomPointInConvexPoly */
export function dtRandomPointInConvexPoly(
  pts: dtFloatArray,
  npts: number,
  areas: dtFloatArray,
  s: number,
  t: number,
  out: dtFloatArray,
  outi: number,
): void {
  // Calc triangle araes
  let areasum = 0.0;
  for (let i = 2; i < npts; i++) {
    areas[i] = dtTriArea2D(pts, 0, pts, (i - 1) * 3, pts, i * 3);
    areasum += dtMax(0.001, areas[i]!);
  }
  // Find sub triangle weighted by area.
  const thr = s * areasum;
  let acc = 0.0;
  let u = 1.0;
  let tri = npts - 1;
  for (let i = 2; i < npts; i++) {
    const dacc = areas[i]!;
    if (thr >= acc && thr < acc + dacc) {
      u = (thr - acc) / dacc;
      tri = i;
      break;
    }
    acc += dacc;
  }

  const v = dtMathSqrtf(t);

  const a = 1 - v;
  const b = (1 - u) * v;
  const c = u * v;
  const pb = (tri - 1) * 3;
  const pc = tri * 3;

  out[outi] = a * pts[0]! + b * pts[pb]! + c * pts[pc]!;
  out[outi + 1] = a * pts[1]! + b * pts[pb + 1]! + c * pts[pc + 1]!;
  out[outi + 2] = a * pts[2]! + b * pts[pb + 2]! + c * pts[pc + 2]!;
}

/** @ac deps/recastnavigation/Detour/Source/DetourCommon.cpp vperpXZ */
function vperpXZ(a: dtFloatArray, b: dtFloatArray): number {
  return a[0]! * b[2]! - a[2]! * b[0]!;
}

/** Result of `dtIntersectSegSeg2D` (the C++ `float& s, float& t`). */
export class dtSegSegIntersection {
  s = 0;
  t = 0;
}

const iss_u = new Float32Array(3);
const iss_v = new Float32Array(3);
const iss_w = new Float32Array(3);

/** @ac deps/recastnavigation/Detour/Source/DetourCommon.cpp dtIntersectSegSeg2D */
export function dtIntersectSegSeg2D(
  ap: dtFloatArray,
  api: number,
  aq: dtFloatArray,
  aqi: number,
  bp: dtFloatArray,
  bpi: number,
  bq: dtFloatArray,
  bqi: number,
  out: dtSegSegIntersection,
): boolean {
  const u = iss_u;
  const v = iss_v;
  const w = iss_w;
  dtVsub(u, 0, aq, aqi, ap, api);
  dtVsub(v, 0, bq, bqi, bp, bpi);
  dtVsub(w, 0, ap, api, bp, bpi);
  const d = vperpXZ(u, v);
  if (Math.abs(d) < 1e-6) return false;
  out.s = vperpXZ(v, w) / d;
  out.t = vperpXZ(u, w) / d;
  return true;
}

/**
 * @ac deps/recastnavigation/Detour/Include/DetourCommon.h dtGetThenAdvanceBufferPointer
 * @ac-skip pointer arithmetic over a byte buffer; `dtMeshTile.attachData` builds typed-array views at the same offsets
 */
export function dtGetThenAdvanceBufferPointer(offset: { value: number }, distanceToAdvance: number): number {
  const at = offset.value;
  offset.value += distanceToAdvance;
  return at;
}
