/**
 * Port of `deps/recastnavigation/Recast/Source/RecastRasterization.cpp`.
 *
 * Spans live in the struct-of-arrays pool of `rcHeightfield` (see `rcSpanPool`); a span id stands for the C++
 * `rcSpan*`. The clipping buffers are module scratch `Float32Array`s, so no allocation happens per triangle.
 */
import {
  RC_LOG_ERROR,
  RC_SPAN_MAX_HEIGHT,
  RC_TIMER_RASTERIZE_TRIANGLES,
  f32,
  rcAbs,
  rcClamp,
  rcMax,
  rcScopedTimer,
  rcVcopy,
  type rcContext,
  type rcHeightfield,
} from "./Recast.ts";

/** @ac deps/recastnavigation/Recast/Source/RecastRasterization.cpp overlapBounds */
function overlapBounds(amin: Float32Array, amax: Float32Array, bmin: Float32Array, bmax: Float32Array): boolean {
  let overlap = true;
  overlap = amin[0]! > bmax[0]! || amax[0]! < bmin[0]! ? false : overlap;
  overlap = amin[1]! > bmax[1]! || amax[1]! < bmin[1]! ? false : overlap;
  overlap = amin[2]! > bmax[2]! || amax[2]! < bmin[2]! ? false : overlap;
  return overlap;
}

/**
 * @ac deps/recastnavigation/Recast/Source/RecastRasterization.cpp overlapInterval
 */
export function overlapInterval(amin: number, amax: number, bmin: number, bmax: number): boolean {
  if (amax < bmin) return false;
  if (amin > bmax) return false;
  return true;
}

/**
 * Pops a span id from the free list, or takes a new one from the pool (growing it as needed).
 * @ac deps/recastnavigation/Recast/Source/RecastRasterization.cpp allocSpan
 */
function allocSpan(hf: rcHeightfield): number {
  const it = hf.freelist;
  if (it) {
    // Pop item from in front of the free list.
    hf.freelist = hf.pools.next[it]!;
    return it;
  }
  const pool = hf.pools;
  if (pool.count >= pool.capacity) pool.grow();
  return pool.count++;
}

/** @ac deps/recastnavigation/Recast/Source/RecastRasterization.cpp freeSpan */
function freeSpan(hf: rcHeightfield, ptr: number): void {
  if (!ptr) return;
  // Add the node in front of the free list.
  hf.pools.next[ptr] = hf.freelist;
  hf.freelist = ptr;
}

/** @ac deps/recastnavigation/Recast/Source/RecastRasterization.cpp addSpan */
function addSpan(hf: rcHeightfield, x: number, y: number, smin: number, smax: number, area: number, flagMergeThr: number): boolean {
  const idx = x + y * hf.width;

  const s = allocSpan(hf);
  const pool = hf.pools;
  const psmin = pool.smin;
  const psmax = pool.smax;
  const parea = pool.area;
  const pnext = pool.next;
  psmin[s] = smin;
  psmax[s] = smax;
  parea[s] = area;
  pnext[s] = 0;

  // Empty cell, add the first span.
  if (!hf.spans[idx]) {
    hf.spans[idx] = s;
    return true;
  }
  let prev = 0;
  let cur = hf.spans[idx]!;

  // Insert and merge spans.
  while (cur) {
    if (psmin[cur]! > psmax[s]!) {
      // Current span is further than the new span, break.
      break;
    } else if (psmax[cur]! < psmin[s]!) {
      // Current span is before the new span advance.
      prev = cur;
      cur = pnext[cur]!;
    } else {
      // Merge spans.
      if (psmin[cur]! < psmin[s]!) psmin[s] = psmin[cur]!;
      if (psmax[cur]! > psmax[s]!) psmax[s] = psmax[cur]!;

      // Merge flags.
      if (rcAbs(psmax[s]! - psmax[cur]!) <= flagMergeThr) parea[s] = rcMax(parea[s]!, parea[cur]!);

      // Remove current span.
      const next = pnext[cur]!;
      freeSpan(hf, cur);
      if (prev) pnext[prev] = next;
      else hf.spans[idx] = next;
      cur = next;
    }
  }

  // Insert new span.
  if (prev) {
    pnext[s] = pnext[prev]!;
    pnext[prev] = s;
  } else {
    pnext[s] = hf.spans[idx]!;
    hf.spans[idx] = s;
  }

  return true;
}

/**
 * Adds a span to the specified heightfield.
 * @ac deps/recastnavigation/Recast/Source/RecastRasterization.cpp rcAddSpan
 */
export function rcAddSpan(
  ctx: rcContext,
  hf: rcHeightfield,
  x: number,
  y: number,
  smin: number,
  smax: number,
  area: number,
  flagMergeThr: number,
): boolean {
  if (!addSpan(hf, x, y, smin & 0xffff, smax & 0xffff, area & 0xff, flagMergeThr)) {
    ctx.log(RC_LOG_ERROR, "rcAddSpan: Out of memory.");
    return false;
  }
  return true;
}

const dividePolyD = new Float32Array(12);
let dividePolyNout1 = 0;
let dividePolyNout2 = 0;

/**
 * Divides a convex polygon into two convex polygons on both sides of a line. Polygons are `(array, offset)`; the
 * vertex counts go to `dividePolyNout1` / `dividePolyNout2`.
 * @ac deps/recastnavigation/Recast/Source/RecastRasterization.cpp dividePoly
 */
function dividePoly(
  inp: Float32Array,
  ii: number,
  nin: number,
  out1: Float32Array,
  o1: number,
  out2: Float32Array,
  o2: number,
  x: number,
  axis: number,
): void {
  const d = dividePolyD;
  for (let i = 0; i < nin; ++i) d[i] = x - inp[ii + i * 3 + axis]!;

  let m = 0;
  let n = 0;
  for (let i = 0, j = nin - 1; i < nin; j = i, ++i) {
    const dj = d[j]!;
    const di = d[i]!;
    const ina = dj >= 0;
    const inb = di >= 0;
    if (ina !== inb) {
      const s = f32(dj / f32(dj - di));
      const pj = ii + j * 3;
      const pi = ii + i * 3;
      const q = o1 + m * 3;
      out1[q] = inp[pj]! + f32(f32(inp[pi]! - inp[pj]!) * s);
      out1[q + 1] = inp[pj + 1]! + f32(f32(inp[pi + 1]! - inp[pj + 1]!) * s);
      out1[q + 2] = inp[pj + 2]! + f32(f32(inp[pi + 2]! - inp[pj + 2]!) * s);
      rcVcopy(out2, o2 + n * 3, out1, q);
      m++;
      n++;
      // add the i'th point to the right polygon. Do NOT add points that are on the dividing line
      // since these were already added above
      if (di > 0) {
        rcVcopy(out1, o1 + m * 3, inp, pi);
        m++;
      } else if (di < 0) {
        rcVcopy(out2, o2 + n * 3, inp, pi);
        n++;
      }
    } else {
      // same side
      // add the i'th point to the right polygon. Addition is done even for points on the dividing line
      if (di >= 0) {
        rcVcopy(out1, o1 + m * 3, inp, ii + i * 3);
        m++;
        if (di !== 0) continue;
      }
      rcVcopy(out2, o2 + n * 3, inp, ii + i * 3);
      n++;
    }
  }

  dividePolyNout1 = m;
  dividePolyNout2 = n;
}

const rasterizeTriBuf = new Float32Array(7 * 3 * 4);
const rasterizeTriMin = new Float32Array(3);
const rasterizeTriMax = new Float32Array(3);

/** @ac deps/recastnavigation/Recast/Source/RecastRasterization.cpp rasterizeTri */
function rasterizeTri(
  va: Float32Array,
  v0: number,
  vb: Float32Array,
  v1: number,
  vc: Float32Array,
  v2: number,
  area: number,
  hf: rcHeightfield,
  bmin: Float32Array,
  bmax: Float32Array,
  cs: number,
  ics: number,
  ich: number,
  flagMergeThr: number,
): boolean {
  const w = hf.width;
  const h = hf.height;
  const tmin = rasterizeTriMin;
  const tmax = rasterizeTriMax;
  const by = f32(bmax[1]! - bmin[1]!);

  // Calculate the bounding box of the triangle.
  for (let k = 0; k < 3; ++k) {
    let mn = va[v0 + k]!;
    let mx = mn;
    const b = vb[v1 + k]!;
    const c = vc[v2 + k]!;
    mn = mn < b ? mn : b;
    mn = mn < c ? mn : c;
    mx = mx > b ? mx : b;
    mx = mx > c ? mx : c;
    tmin[k] = mn;
    tmax[k] = mx;
  }

  // If the triangle does not touch the bbox of the heightfield, skip the triagle.
  if (!overlapBounds(bmin, bmax, tmin, tmax)) return true;

  // Calculate the footprint of the triangle on the grid's y-axis
  let y0 = f32(f32(tmin[2]! - bmin[2]!) * ics) | 0;
  let y1 = f32(f32(tmax[2]! - bmin[2]!) * ics) | 0;
  y0 = rcClamp(y0, 0, h - 1);
  y1 = rcClamp(y1, 0, h - 1);

  // Clip the triangle into all grid cells it touches.
  const buf = rasterizeTriBuf;
  let inp = 0;
  let inrow = 7 * 3;
  let p1 = inrow + 7 * 3;
  let p2 = p1 + 7 * 3;

  rcVcopy(buf, inp, va, v0);
  rcVcopy(buf, inp + 3, vb, v1);
  rcVcopy(buf, inp + 6, vc, v2);
  let nvrow = 0;
  let nvIn = 3;

  for (let y = y0; y <= y1; ++y) {
    // Clip polygon to row. Store the remaining polygon as well
    const cz = f32(bmin[2]! + f32(y * cs));
    dividePoly(buf, inp, nvIn, buf, inrow, buf, p1, f32(cz + cs), 2);
    nvrow = dividePolyNout1;
    nvIn = dividePolyNout2;
    let t = inp;
    inp = p1;
    p1 = t;
    if (nvrow < 3) continue;

    // find the horizontal bounds in the row
    let minX = buf[inrow]!;
    let maxX = buf[inrow]!;
    for (let i = 1; i < nvrow; ++i) {
      const vx = buf[inrow + i * 3]!;
      if (minX > vx) minX = vx;
      if (maxX < vx) maxX = vx;
    }
    let x0 = f32(f32(minX - bmin[0]!) * ics) | 0;
    let x1 = f32(f32(maxX - bmin[0]!) * ics) | 0;
    x0 = rcClamp(x0, 0, w - 1);
    x1 = rcClamp(x1, 0, w - 1);

    let nv = 0;
    let nv2 = nvrow;

    for (let x = x0; x <= x1; ++x) {
      // Clip polygon to column. store the remaining polygon as well
      const cx = f32(bmin[0]! + f32(x * cs));
      dividePoly(buf, inrow, nv2, buf, p1, buf, p2, f32(cx + cs), 0);
      nv = dividePolyNout1;
      nv2 = dividePolyNout2;
      t = inrow;
      inrow = p2;
      p2 = t;
      if (nv < 3) continue;

      // Calculate min and max of the span.
      let smin = buf[p1 + 1]!;
      let smax = smin;
      for (let i = 1; i < nv; ++i) {
        const sy = buf[p1 + i * 3 + 1]!;
        smin = smin < sy ? smin : sy;
        smax = smax > sy ? smax : sy;
      }
      smin = f32(smin - bmin[1]!);
      smax = f32(smax - bmin[1]!);
      // Skip the span if it is outside the heightfield bbox
      if (smax < 0.0) continue;
      if (smin > by) continue;
      // Clamp the span to the heightfield bbox.
      if (smin < 0.0) smin = 0;
      if (smax > by) smax = by;

      // Snap the span to the heightfield height grid.
      const ismin = rcClamp(Math.floor(f32(smin * ich)) | 0, 0, RC_SPAN_MAX_HEIGHT) & 0xffff;
      const ismax = rcClamp(Math.ceil(f32(smax * ich)) | 0, ismin + 1, RC_SPAN_MAX_HEIGHT) & 0xffff;

      if (!addSpan(hf, x, y, ismin, ismax, area, flagMergeThr)) return false;
    }
  }

  return true;
}

/**
 * Rasterizes a triangle into the specified heightfield. Vertices are `(array, offset)` pairs.
 * @ac deps/recastnavigation/Recast/Source/RecastRasterization.cpp rcRasterizeTriangle
 */
export function rcRasterizeTriangle(
  ctx: rcContext,
  v0: Float32Array,
  i0: number,
  v1: Float32Array,
  i1: number,
  v2: Float32Array,
  i2: number,
  area: number,
  solid: rcHeightfield,
  flagMergeThr = 1,
): boolean {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_RASTERIZE_TRIANGLES);

  const ics = f32(1.0 / solid.cs);
  const ich = f32(1.0 / solid.ch);
  if (!rasterizeTri(v0, i0, v1, i1, v2, i2, area & 0xff, solid, solid.bmin, solid.bmax, solid.cs, ics, ich, flagMergeThr)) {
    ctx.log(RC_LOG_ERROR, "rcRasterizeTriangle: Out of memory.");
    return false;
  }

  return true;
}

/**
 * Rasterizes an indexed triangle mesh (`int` or `unsigned short` indices) into the specified heightfield.
 * @ac deps/recastnavigation/Recast/Source/RecastRasterization.cpp rcRasterizeTriangles
 */
export function rcRasterizeTriangles(
  ctx: rcContext,
  verts: Float32Array,
  nv: number,
  tris: Int32Array | Uint16Array,
  areas: Uint8Array,
  nt: number,
  solid: rcHeightfield,
  flagMergeThr?: number,
): boolean;
/**
 * Rasterizes triangles (three vertices each, not indexed) into the specified heightfield.
 * @ac deps/recastnavigation/Recast/Source/RecastRasterization.cpp rcRasterizeTriangles
 */
export function rcRasterizeTriangles(
  ctx: rcContext,
  verts: Float32Array,
  areas: Uint8Array,
  nt: number,
  solid: rcHeightfield,
  flagMergeThr?: number,
): boolean;
export function rcRasterizeTriangles(
  ctx: rcContext,
  verts: Float32Array,
  a: number | Uint8Array,
  b: Int32Array | Uint16Array | number,
  c: Uint8Array | rcHeightfield,
  d?: number,
  e?: rcHeightfield,
  f?: number,
): boolean {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_RASTERIZE_TRIANGLES);

  if (typeof a === "number") {
    // Indexed overloads.
    const tris = b as Int32Array | Uint16Array;
    const areas = c as Uint8Array;
    const nt = d!;
    const solid = e!;
    const flagMergeThr = f ?? 1;
    const ics = f32(1.0 / solid.cs);
    const ich = f32(1.0 / solid.ch);
    // Rasterize triangles.
    for (let i = 0; i < nt; ++i) {
      const v0 = tris[i * 3]! * 3;
      const v1 = tris[i * 3 + 1]! * 3;
      const v2 = tris[i * 3 + 2]! * 3;
      // Rasterize.
      if (!rasterizeTri(verts, v0, verts, v1, verts, v2, areas[i]!, solid, solid.bmin, solid.bmax, solid.cs, ics, ich, flagMergeThr)) {
        ctx.log(RC_LOG_ERROR, "rcRasterizeTriangles: Out of memory.");
        return false;
      }
    }
    return true;
  }

  const areas = a;
  const nt = b as number;
  const solid = c as rcHeightfield;
  const flagMergeThr = d ?? 1;
  const ics = f32(1.0 / solid.cs);
  const ich = f32(1.0 / solid.ch);
  // Rasterize triangles.
  for (let i = 0; i < nt; ++i) {
    const v0 = (i * 3 + 0) * 3;
    const v1 = (i * 3 + 1) * 3;
    const v2 = (i * 3 + 2) * 3;
    // Rasterize.
    if (!rasterizeTri(verts, v0, verts, v1, verts, v2, areas[i]!, solid, solid.bmin, solid.bmax, solid.cs, ics, ich, flagMergeThr)) {
      ctx.log(RC_LOG_ERROR, "rcRasterizeTriangles: Out of memory.");
      return false;
    }
  }
  return true;
}
