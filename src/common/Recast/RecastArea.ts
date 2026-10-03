/**
 * Port of `deps/recastnavigation/Recast/Source/RecastArea.cpp`.
 */
import {
  RC_NOT_CONNECTED,
  RC_NULL_AREA,
  RC_TIMER_ERODE_AREA,
  RC_TIMER_MARK_BOX_AREA,
  RC_TIMER_MARK_CONVEXPOLY_AREA,
  RC_TIMER_MARK_CYLINDER_AREA,
  RC_TIMER_MEDIAN_AREA,
  f32,
  rcGetCon,
  rcGetDirOffsetX,
  rcGetDirOffsetY,
  rcMin,
  rcScopedTimer,
  rcSqrt,
  rcVcopy,
  rcVmax,
  rcVmin,
  type rcCompactHeightfield,
  type rcContext,
} from "./Recast.ts";

/**
 * Erodes the walkable area within the heightfield by the specified radius.
 * @ac deps/recastnavigation/Recast/Source/RecastArea.cpp rcErodeWalkableArea
 */
export function rcErodeWalkableArea(ctx: rcContext, radius: number, chf: rcCompactHeightfield): boolean {
  const w = chf.width;
  const h = chf.height;

  using _timer = new rcScopedTimer(ctx, RC_TIMER_ERODE_AREA);

  const dist = new Uint8Array(chf.spanCount);
  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;
  const con = chf.spans.con;
  const areas = chf.areas;

  // Init distance.
  dist.fill(0xff);

  // Mark boundary cells.
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const c = x + y * w;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        if (areas[i] === RC_NULL_AREA) {
          dist[i] = 0;
        } else {
          let nc = 0;
          for (let dir = 0; dir < 4; ++dir) {
            if (rcGetCon(con, i, dir) !== RC_NOT_CONNECTED) {
              const nx = x + rcGetDirOffsetX(dir);
              const ny = y + rcGetDirOffsetY(dir);
              const nidx = cellIndex[nx + ny * w]! + rcGetCon(con, i, dir);
              if (areas[nidx] !== RC_NULL_AREA) {
                nc++;
              }
            }
          }
          // At least one missing neighbour.
          if (nc !== 4) dist[i] = 0;
        }
      }
    }
  }

  let nd = 0;

  // Pass 1
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const c = x + y * w;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        if (rcGetCon(con, i, 0) !== RC_NOT_CONNECTED) {
          // (-1,0)
          const ax = x + rcGetDirOffsetX(0);
          const ay = y + rcGetDirOffsetY(0);
          const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, 0);
          nd = rcMin(dist[ai]! + 2, 255);
          if (nd < dist[i]!) dist[i] = nd;

          // (-1,-1)
          if (rcGetCon(con, ai, 3) !== RC_NOT_CONNECTED) {
            const aax = ax + rcGetDirOffsetX(3);
            const aay = ay + rcGetDirOffsetY(3);
            const aai = cellIndex[aax + aay * w]! + rcGetCon(con, ai, 3);
            nd = rcMin(dist[aai]! + 3, 255);
            if (nd < dist[i]!) dist[i] = nd;
          }
        }
        if (rcGetCon(con, i, 3) !== RC_NOT_CONNECTED) {
          // (0,-1)
          const ax = x + rcGetDirOffsetX(3);
          const ay = y + rcGetDirOffsetY(3);
          const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, 3);
          nd = rcMin(dist[ai]! + 2, 255);
          if (nd < dist[i]!) dist[i] = nd;

          // (1,-1)
          if (rcGetCon(con, ai, 2) !== RC_NOT_CONNECTED) {
            const aax = ax + rcGetDirOffsetX(2);
            const aay = ay + rcGetDirOffsetY(2);
            const aai = cellIndex[aax + aay * w]! + rcGetCon(con, ai, 2);
            nd = rcMin(dist[aai]! + 3, 255);
            if (nd < dist[i]!) dist[i] = nd;
          }
        }
      }
    }
  }

  // Pass 2
  for (let y = h - 1; y >= 0; --y) {
    for (let x = w - 1; x >= 0; --x) {
      const c = x + y * w;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        if (rcGetCon(con, i, 2) !== RC_NOT_CONNECTED) {
          // (1,0)
          const ax = x + rcGetDirOffsetX(2);
          const ay = y + rcGetDirOffsetY(2);
          const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, 2);
          nd = rcMin(dist[ai]! + 2, 255);
          if (nd < dist[i]!) dist[i] = nd;

          // (1,1)
          if (rcGetCon(con, ai, 1) !== RC_NOT_CONNECTED) {
            const aax = ax + rcGetDirOffsetX(1);
            const aay = ay + rcGetDirOffsetY(1);
            const aai = cellIndex[aax + aay * w]! + rcGetCon(con, ai, 1);
            nd = rcMin(dist[aai]! + 3, 255);
            if (nd < dist[i]!) dist[i] = nd;
          }
        }
        if (rcGetCon(con, i, 1) !== RC_NOT_CONNECTED) {
          // (0,1)
          const ax = x + rcGetDirOffsetX(1);
          const ay = y + rcGetDirOffsetY(1);
          const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, 1);
          nd = rcMin(dist[ai]! + 2, 255);
          if (nd < dist[i]!) dist[i] = nd;

          // (-1,1)
          if (rcGetCon(con, ai, 0) !== RC_NOT_CONNECTED) {
            const aax = ax + rcGetDirOffsetX(0);
            const aay = ay + rcGetDirOffsetY(0);
            const aai = cellIndex[aax + aay * w]! + rcGetCon(con, ai, 0);
            nd = rcMin(dist[aai]! + 3, 255);
            if (nd < dist[i]!) dist[i] = nd;
          }
        }
      }
    }
  }

  const thr = (radius * 2) & 0xff;
  for (let i = 0; i < chf.spanCount; ++i) if (dist[i]! < thr) areas[i] = RC_NULL_AREA;

  return true;
}

/** @ac deps/recastnavigation/Recast/Source/RecastArea.cpp insertSort */
function insertSort(a: Uint8Array, n: number): void {
  let i: number;
  let j: number;
  for (i = 1; i < n; i++) {
    const value = a[i]!;
    for (j = i - 1; j >= 0 && a[j]! > value; j--) a[j + 1] = a[j]!;
    a[j + 1] = value;
  }
}

const medianNei = new Uint8Array(9);

/**
 * Applies a median filter to walkable area types (based on area id), removing noise.
 * @ac deps/recastnavigation/Recast/Source/RecastArea.cpp rcMedianFilterWalkableArea
 */
export function rcMedianFilterWalkableArea(ctx: rcContext, chf: rcCompactHeightfield): boolean {
  const w = chf.width;
  const h = chf.height;

  using _timer = new rcScopedTimer(ctx, RC_TIMER_MEDIAN_AREA);

  const areas = new Uint8Array(chf.spanCount);
  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;
  const con = chf.spans.con;
  const chfAreas = chf.areas;
  const nei = medianNei;

  // Init distance.
  areas.fill(0xff);

  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const c = x + y * w;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        if (chfAreas[i] === RC_NULL_AREA) {
          areas[i] = chfAreas[i]!;
          continue;
        }

        for (let j = 0; j < 9; ++j) nei[j] = chfAreas[i]!;

        for (let dir = 0; dir < 4; ++dir) {
          if (rcGetCon(con, i, dir) !== RC_NOT_CONNECTED) {
            const ax = x + rcGetDirOffsetX(dir);
            const ay = y + rcGetDirOffsetY(dir);
            const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, dir);
            if (chfAreas[ai] !== RC_NULL_AREA) nei[dir * 2 + 0] = chfAreas[ai]!;

            const dir2 = (dir + 1) & 0x3;
            if (rcGetCon(con, ai, dir2) !== RC_NOT_CONNECTED) {
              const ax2 = ax + rcGetDirOffsetX(dir2);
              const ay2 = ay + rcGetDirOffsetY(dir2);
              const ai2 = cellIndex[ax2 + ay2 * w]! + rcGetCon(con, ai, dir2);
              if (chfAreas[ai2] !== RC_NULL_AREA) nei[dir * 2 + 1] = chfAreas[ai2]!;
            }
          }
        }
        insertSort(nei, 9);
        areas[i] = nei[4]!;
      }
    }
  }

  chfAreas.set(areas);

  return true;
}

/**
 * Applies an area id to all spans within the specified bounding box. (AABB)
 * @ac deps/recastnavigation/Recast/Source/RecastArea.cpp rcMarkBoxArea
 */
export function rcMarkBoxArea(ctx: rcContext, bmin: Float32Array, bmax: Float32Array, areaId: number, chf: rcCompactHeightfield): void {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_MARK_BOX_AREA);

  areaId &= 0xff;
  let minx = f32(f32(bmin[0]! - chf.bmin[0]!) / chf.cs) | 0;
  const miny = f32(f32(bmin[1]! - chf.bmin[1]!) / chf.ch) | 0;
  let minz = f32(f32(bmin[2]! - chf.bmin[2]!) / chf.cs) | 0;
  let maxx = f32(f32(bmax[0]! - chf.bmin[0]!) / chf.cs) | 0;
  const maxy = f32(f32(bmax[1]! - chf.bmin[1]!) / chf.ch) | 0;
  let maxz = f32(f32(bmax[2]! - chf.bmin[2]!) / chf.cs) | 0;

  if (maxx < 0) return;
  if (minx >= chf.width) return;
  if (maxz < 0) return;
  if (minz >= chf.height) return;

  if (minx < 0) minx = 0;
  if (maxx >= chf.width) maxx = chf.width - 1;
  if (minz < 0) minz = 0;
  if (maxz >= chf.height) maxz = chf.height - 1;

  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;
  const spanY = chf.spans.y;
  for (let z = minz; z <= maxz; ++z) {
    for (let x = minx; x <= maxx; ++x) {
      const c = x + z * chf.width;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        if (spanY[i]! >= miny && spanY[i]! <= maxy) {
          if (chf.areas[i] !== RC_NULL_AREA) chf.areas[i] = areaId;
        }
      }
    }
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastArea.cpp pointInPoly */
function pointInPoly(nvert: number, verts: Float32Array, p: Float32Array): number {
  let i: number;
  let j: number;
  let c = 0;
  for (i = 0, j = nvert - 1; i < nvert; j = i++) {
    const vi = i * 3;
    const vj = j * 3;
    if (
      verts[vi + 2]! > p[2]! !== verts[vj + 2]! > p[2]! &&
      p[0]! <
        f32(f32(f32(f32(verts[vj]! - verts[vi]!) * f32(p[2]! - verts[vi + 2]!)) / f32(verts[vj + 2]! - verts[vi + 2]!)) + verts[vi]!)
    )
      c = c ? 0 : 1;
  }
  return c;
}

const markConvexBmin = new Float32Array(3);
const markConvexBmax = new Float32Array(3);
const markConvexP = new Float32Array(3);

/**
 * Applies the area id to the all spans within the specified convex polygon.
 * @ac deps/recastnavigation/Recast/Source/RecastArea.cpp rcMarkConvexPolyArea
 */
export function rcMarkConvexPolyArea(
  ctx: rcContext,
  verts: Float32Array,
  nverts: number,
  hmin: number,
  hmax: number,
  areaId: number,
  chf: rcCompactHeightfield,
): void {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_MARK_CONVEXPOLY_AREA);

  areaId &= 0xff;
  const bmin = markConvexBmin;
  const bmax = markConvexBmax;
  rcVcopy(bmin, 0, verts, 0);
  rcVcopy(bmax, 0, verts, 0);
  for (let i = 1; i < nverts; ++i) {
    rcVmin(bmin, 0, verts, i * 3);
    rcVmax(bmax, 0, verts, i * 3);
  }
  bmin[1] = hmin;
  bmax[1] = hmax;

  let minx = f32(f32(bmin[0]! - chf.bmin[0]!) / chf.cs) | 0;
  const miny = f32(f32(bmin[1]! - chf.bmin[1]!) / chf.ch) | 0;
  let minz = f32(f32(bmin[2]! - chf.bmin[2]!) / chf.cs) | 0;
  let maxx = f32(f32(bmax[0]! - chf.bmin[0]!) / chf.cs) | 0;
  const maxy = f32(f32(bmax[1]! - chf.bmin[1]!) / chf.ch) | 0;
  let maxz = f32(f32(bmax[2]! - chf.bmin[2]!) / chf.cs) | 0;

  if (maxx < 0) return;
  if (minx >= chf.width) return;
  if (maxz < 0) return;
  if (minz >= chf.height) return;

  if (minx < 0) minx = 0;
  if (maxx >= chf.width) maxx = chf.width - 1;
  if (minz < 0) minz = 0;
  if (maxz >= chf.height) maxz = chf.height - 1;

  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;
  const spanY = chf.spans.y;
  const p = markConvexP;
  // TODO: Optimize.
  for (let z = minz; z <= maxz; ++z) {
    for (let x = minx; x <= maxx; ++x) {
      const c = x + z * chf.width;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        if (chf.areas[i] === RC_NULL_AREA) continue;
        if (spanY[i]! >= miny && spanY[i]! <= maxy) {
          p[0] = chf.bmin[0]! + f32(f32(x + 0.5) * chf.cs);
          p[1] = 0;
          p[2] = chf.bmin[2]! + f32(f32(z + 0.5) * chf.cs);

          if (pointInPoly(nverts, verts, p)) {
            chf.areas[i] = areaId;
          }
        }
      }
    }
  }
}

/**
 * Helper function to offset convex polygons for `rcMarkConvexPolyArea`. Returns the number of vertices in the offset
 * polygon or 0 if too few vertices in `outVerts`.
 * @ac deps/recastnavigation/Recast/Source/RecastArea.cpp rcOffsetPoly
 */
export function rcOffsetPoly(verts: Float32Array, nverts: number, offset: number, outVerts: Float32Array, maxOutVerts: number): number {
  const MITER_LIMIT = f32(1.2);
  const EPS = f32(1e-6);
  offset = f32(offset);

  let n = 0;

  for (let i = 0; i < nverts; i++) {
    const a = (i + nverts - 1) % nverts;
    const b = i;
    const c = (i + 1) % nverts;
    const va = a * 3;
    const vb = b * 3;
    const vc = c * 3;
    let dx0 = f32(verts[vb]! - verts[va]!);
    let dy0 = f32(verts[vb + 2]! - verts[va + 2]!);
    let d0 = f32(f32(dx0 * dx0) + f32(dy0 * dy0));
    if (d0 > EPS) {
      d0 = f32(1.0 / rcSqrt(d0));
      dx0 = f32(dx0 * d0);
      dy0 = f32(dy0 * d0);
    }
    let dx1 = f32(verts[vc]! - verts[vb]!);
    let dy1 = f32(verts[vc + 2]! - verts[vb + 2]!);
    let d1 = f32(f32(dx1 * dx1) + f32(dy1 * dy1));
    if (d1 > EPS) {
      d1 = f32(1.0 / rcSqrt(d1));
      dx1 = f32(dx1 * d1);
      dy1 = f32(dy1 * d1);
    }
    const dlx0 = -dy0;
    const dly0 = dx0;
    const dlx1 = -dy1;
    const dly1 = dx1;
    const cross = f32(f32(dx1 * dy0) - f32(dx0 * dy1));
    let dmx = f32(f32(dlx0 + dlx1) * 0.5);
    let dmy = f32(f32(dly0 + dly1) * 0.5);
    const dmr2 = f32(f32(dmx * dmx) + f32(dmy * dmy));
    const bevel = f32(f32(dmr2 * MITER_LIMIT) * MITER_LIMIT) < 1.0;
    if (dmr2 > EPS) {
      const scale = f32(1.0 / dmr2);
      dmx = f32(dmx * scale);
      dmy = f32(dmy * scale);
    }

    if (bevel && cross < 0.0) {
      if (n + 2 >= maxOutVerts) return 0;
      const d = f32(f32(1.0 - f32(f32(dx0 * dx1) + f32(dy0 * dy1))) * 0.5);
      outVerts[n * 3 + 0] = verts[vb]! + f32(f32(-dlx0 + f32(dx0 * d)) * offset);
      outVerts[n * 3 + 1] = verts[vb + 1]!;
      outVerts[n * 3 + 2] = verts[vb + 2]! + f32(f32(-dly0 + f32(dy0 * d)) * offset);
      n++;
      outVerts[n * 3 + 0] = verts[vb]! + f32(f32(-dlx1 - f32(dx1 * d)) * offset);
      outVerts[n * 3 + 1] = verts[vb + 1]!;
      outVerts[n * 3 + 2] = verts[vb + 2]! + f32(f32(-dly1 - f32(dy1 * d)) * offset);
      n++;
    } else {
      if (n + 1 >= maxOutVerts) return 0;
      outVerts[n * 3 + 0] = verts[vb]! - f32(dmx * offset);
      outVerts[n * 3 + 1] = verts[vb + 1]!;
      outVerts[n * 3 + 2] = verts[vb + 2]! - f32(dmy * offset);
      n++;
    }
  }

  return n;
}

const markCylinderBmin = new Float32Array(3);
const markCylinderBmax = new Float32Array(3);

/**
 * Applies the area id to all spans within the specified cylinder. `pos` is `(array, offset)`.
 * @ac deps/recastnavigation/Recast/Source/RecastArea.cpp rcMarkCylinderArea
 */
export function rcMarkCylinderArea(
  ctx: rcContext,
  pos: Float32Array,
  pi: number,
  r: number,
  h: number,
  areaId: number,
  chf: rcCompactHeightfield,
): void {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_MARK_CYLINDER_AREA);

  r = f32(r);
  h = f32(h);
  areaId &= 0xff;
  const bmin = markCylinderBmin;
  const bmax = markCylinderBmax;
  bmin[0] = pos[pi]! - r;
  bmin[1] = pos[pi + 1]!;
  bmin[2] = pos[pi + 2]! - r;
  bmax[0] = pos[pi]! + r;
  bmax[1] = pos[pi + 1]! + h;
  bmax[2] = pos[pi + 2]! + r;
  const r2 = f32(r * r);

  let minx = f32(f32(bmin[0]! - chf.bmin[0]!) / chf.cs) | 0;
  const miny = f32(f32(bmin[1]! - chf.bmin[1]!) / chf.ch) | 0;
  let minz = f32(f32(bmin[2]! - chf.bmin[2]!) / chf.cs) | 0;
  let maxx = f32(f32(bmax[0]! - chf.bmin[0]!) / chf.cs) | 0;
  const maxy = f32(f32(bmax[1]! - chf.bmin[1]!) / chf.ch) | 0;
  let maxz = f32(f32(bmax[2]! - chf.bmin[2]!) / chf.cs) | 0;

  if (maxx < 0) return;
  if (minx >= chf.width) return;
  if (maxz < 0) return;
  if (minz >= chf.height) return;

  if (minx < 0) minx = 0;
  if (maxx >= chf.width) maxx = chf.width - 1;
  if (minz < 0) minz = 0;
  if (maxz >= chf.height) maxz = chf.height - 1;

  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;
  const spanY = chf.spans.y;
  for (let z = minz; z <= maxz; ++z) {
    for (let x = minx; x <= maxx; ++x) {
      const c = x + z * chf.width;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        if (chf.areas[i] === RC_NULL_AREA) continue;

        if (spanY[i]! >= miny && spanY[i]! <= maxy) {
          const sx = f32(chf.bmin[0]! + f32(f32(x + 0.5) * chf.cs));
          const sz = f32(chf.bmin[2]! + f32(f32(z + 0.5) * chf.cs));
          const dx = f32(sx - pos[pi]!);
          const dz = f32(sz - pos[pi + 2]!);

          if (f32(f32(dx * dx) + f32(dz * dz)) < r2) {
            chf.areas[i] = areaId;
          }
        }
      }
    }
  }
}
