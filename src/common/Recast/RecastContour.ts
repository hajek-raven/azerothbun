/**
 * Port of `deps/recastnavigation/Recast/Source/RecastContour.cpp`.
 *
 * Contour vertices are `int[4]` records in `Int32Array`s; the geometric predicates take `(array, offset)` pairs.
 * The two `qsort` calls (holes, diagonals) use a stable sort: AzerothCore's Linux builds link glibc, whose `qsort` is a
 * merge sort and therefore stable, so ties keep their input order as here.
 */
import { rcIntArray } from "./RecastAlloc.ts";
import {
  RC_AREA_BORDER,
  RC_BORDER_REG,
  RC_BORDER_VERTEX,
  RC_CONTOUR_REG_MASK,
  RC_CONTOUR_TESS_AREA_EDGES,
  RC_CONTOUR_TESS_WALL_EDGES,
  RC_LOG_ERROR,
  RC_LOG_WARNING,
  RC_NOT_CONNECTED,
  RC_TIMER_BUILD_CONTOURS,
  RC_TIMER_BUILD_CONTOURS_SIMPLIFY,
  RC_TIMER_BUILD_CONTOURS_TRACE,
  f32,
  rcContour,
  rcGetCon,
  rcGetDirOffsetX,
  rcGetDirOffsetY,
  rcMax,
  rcScopedTimer,
  rcVcopy,
  type rcCompactHeightfield,
  type rcContext,
  type rcContourSet,
} from "./Recast.ts";

const cornerRegs = new Uint32Array(4);
/** `bool& isBorderVertex` output of `getCornerHeight`. */
let cornerIsBorderVertex = false;

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp getCornerHeight */
function getCornerHeight(x: number, y: number, i: number, dir: number, chf: rcCompactHeightfield): number {
  const con = chf.spans.con;
  const spanY = chf.spans.y;
  const spanReg = chf.spans.reg;
  const cellIndex = chf.cells.index;
  const areas = chf.areas;
  let ch = spanY[i]!;
  const dirp = (dir + 1) & 0x3;

  const regs = cornerRegs;
  regs[0] = 0;
  regs[1] = 0;
  regs[2] = 0;
  regs[3] = 0;

  // Combine region and area codes in order to prevent
  // border vertices which are in between two areas to be removed.
  regs[0] = spanReg[i]! | (areas[i]! << 16);

  if (rcGetCon(con, i, dir) !== RC_NOT_CONNECTED) {
    const ax = x + rcGetDirOffsetX(dir);
    const ay = y + rcGetDirOffsetY(dir);
    const ai = cellIndex[ax + ay * chf.width]! + rcGetCon(con, i, dir);
    ch = rcMax(ch, spanY[ai]!);
    regs[1] = spanReg[ai]! | (areas[ai]! << 16);
    if (rcGetCon(con, ai, dirp) !== RC_NOT_CONNECTED) {
      const ax2 = ax + rcGetDirOffsetX(dirp);
      const ay2 = ay + rcGetDirOffsetY(dirp);
      const ai2 = cellIndex[ax2 + ay2 * chf.width]! + rcGetCon(con, ai, dirp);
      ch = rcMax(ch, spanY[ai2]!);
      regs[2] = spanReg[ai2]! | (areas[ai2]! << 16);
    }
  }
  if (rcGetCon(con, i, dirp) !== RC_NOT_CONNECTED) {
    const ax = x + rcGetDirOffsetX(dirp);
    const ay = y + rcGetDirOffsetY(dirp);
    const ai = cellIndex[ax + ay * chf.width]! + rcGetCon(con, i, dirp);
    ch = rcMax(ch, spanY[ai]!);
    regs[3] = spanReg[ai]! | (areas[ai]! << 16);
    if (rcGetCon(con, ai, dir) !== RC_NOT_CONNECTED) {
      const ax2 = ax + rcGetDirOffsetX(dir);
      const ay2 = ay + rcGetDirOffsetY(dir);
      const ai2 = cellIndex[ax2 + ay2 * chf.width]! + rcGetCon(con, ai, dir);
      ch = rcMax(ch, spanY[ai2]!);
      regs[2] = spanReg[ai2]! | (areas[ai2]! << 16);
    }
  }

  // Check if the vertex is special edge vertex, these vertices will be removed later.
  for (let j = 0; j < 4; ++j) {
    const a = regs[j]!;
    const b = regs[(j + 1) & 0x3]!;
    const c = regs[(j + 2) & 0x3]!;
    const d = regs[(j + 3) & 0x3]!;

    // The vertex is a border vertex there are two same exterior cells in a row,
    // followed by two interior cells and none of the regions are out of bounds.
    const twoSameExts = (a & b & RC_BORDER_REG) !== 0 && a === b;
    const twoInts = ((c | d) & RC_BORDER_REG) === 0;
    const intsSameArea = c >>> 16 === d >>> 16;
    const noZeros = a !== 0 && b !== 0 && c !== 0 && d !== 0;
    if (twoSameExts && twoInts && intsSameArea && noZeros) {
      cornerIsBorderVertex = true;
      break;
    }
  }

  return ch;
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp walkContour */
function walkContour(x: number, y: number, i: number, chf: rcCompactHeightfield, flags: Uint8Array, points: rcIntArray): void {
  const con = chf.spans.con;
  const cellIndex = chf.cells.index;
  const spanReg = chf.spans.reg;
  // Choose the first non-connected edge
  let dir = 0;
  while ((flags[i]! & (1 << dir)) === 0) dir++;

  const startDir = dir;
  const starti = i;

  const area = chf.areas[i]!;

  let iter = 0;
  while (++iter < 40000) {
    if (flags[i]! & (1 << dir)) {
      // Choose the edge corner
      cornerIsBorderVertex = false;
      let isAreaBorder = false;
      let px = x;
      const py = getCornerHeight(x, y, i, dir, chf);
      const isBorderVertex = cornerIsBorderVertex;
      let pz = y;
      switch (dir) {
        case 0:
          pz++;
          break;
        case 1:
          px++;
          pz++;
          break;
        case 2:
          px++;
          break;
      }
      let r = 0;
      if (rcGetCon(con, i, dir) !== RC_NOT_CONNECTED) {
        const ax = x + rcGetDirOffsetX(dir);
        const ay = y + rcGetDirOffsetY(dir);
        const ai = cellIndex[ax + ay * chf.width]! + rcGetCon(con, i, dir);
        r = spanReg[ai]!;
        if (area !== chf.areas[ai]) isAreaBorder = true;
      }
      if (isBorderVertex) r |= RC_BORDER_VERTEX;
      if (isAreaBorder) r |= RC_AREA_BORDER;
      points.push(px);
      points.push(py);
      points.push(pz);
      points.push(r);

      flags[i] = flags[i]! & ~(1 << dir); // Remove visited edges
      dir = (dir + 1) & 0x3; // Rotate CW
    } else {
      let ni = -1;
      const nx = x + rcGetDirOffsetX(dir);
      const ny = y + rcGetDirOffsetY(dir);
      if (rcGetCon(con, i, dir) !== RC_NOT_CONNECTED) {
        ni = cellIndex[nx + ny * chf.width]! + rcGetCon(con, i, dir);
      }
      if (ni === -1) {
        // Should not happen.
        return;
      }
      x = nx;
      y = ny;
      i = ni;
      dir = (dir + 3) & 0x3; // Rotate CCW
    }

    if (starti === i && startDir === dir) {
      break;
    }
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp distancePtSeg */
function distancePtSeg(x: number, z: number, px: number, pz: number, qx: number, qz: number): number {
  const pqx = f32(qx - px);
  const pqz = f32(qz - pz);
  let dx = f32(x - px);
  let dz = f32(z - pz);
  const d = f32(f32(pqx * pqx) + f32(pqz * pqz));
  let t = f32(f32(pqx * dx) + f32(pqz * dz));
  if (d > 0) t = f32(t / d);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;

  dx = f32(f32(px + f32(t * pqx)) - x);
  dz = f32(f32(pz + f32(t * pqz)) - z);

  return f32(f32(dx * dx) + f32(dz * dz));
}

/** Inserts a raw point after simplified vertex `i` (the "Add space for the new point" block). */
function insertSimplifiedPoint(simplified: rcIntArray, i: number, points: Int32Array, maxi: number): void {
  // Add space for the new point.
  simplified.resize(simplified.size() + 4);
  const s = simplified.data;
  const n = simplified.size() / 4;
  for (let j = n - 1; j > i; --j) {
    s[j * 4 + 0] = s[(j - 1) * 4 + 0]!;
    s[j * 4 + 1] = s[(j - 1) * 4 + 1]!;
    s[j * 4 + 2] = s[(j - 1) * 4 + 2]!;
    s[j * 4 + 3] = s[(j - 1) * 4 + 3]!;
  }
  // Add the point.
  s[(i + 1) * 4 + 0] = points[maxi * 4 + 0]!;
  s[(i + 1) * 4 + 1] = points[maxi * 4 + 1]!;
  s[(i + 1) * 4 + 2] = points[maxi * 4 + 2]!;
  s[(i + 1) * 4 + 3] = maxi;
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp simplifyContour */
function simplifyContour(points: rcIntArray, simplified: rcIntArray, maxError: number, maxEdgeLen: number, buildFlags: number): void {
  const p = points.data;
  // Add initial points.
  let hasConnections = false;
  for (let i = 0; i < points.size(); i += 4) {
    if ((p[i + 3]! & RC_CONTOUR_REG_MASK) !== 0) {
      hasConnections = true;
      break;
    }
  }

  if (hasConnections) {
    // The contour has some portals to other regions.
    // Add a new point to every location where the region changes.
    for (let i = 0, ni = points.size() / 4; i < ni; ++i) {
      const ii = (i + 1) % ni;
      const differentRegs = (p[i * 4 + 3]! & RC_CONTOUR_REG_MASK) !== (p[ii * 4 + 3]! & RC_CONTOUR_REG_MASK);
      const areaBorders = (p[i * 4 + 3]! & RC_AREA_BORDER) !== (p[ii * 4 + 3]! & RC_AREA_BORDER);
      if (differentRegs || areaBorders) {
        simplified.push(p[i * 4 + 0]!);
        simplified.push(p[i * 4 + 1]!);
        simplified.push(p[i * 4 + 2]!);
        simplified.push(i);
      }
    }
  }

  if (simplified.size() === 0) {
    // If there is no connections at all,
    // create some initial points for the simplification process.
    // Find lower-left and upper-right vertices of the contour.
    let llx = p[0]!;
    let lly = p[1]!;
    let llz = p[2]!;
    let lli = 0;
    let urx = p[0]!;
    let ury = p[1]!;
    let urz = p[2]!;
    let uri = 0;
    for (let i = 0; i < points.size(); i += 4) {
      const x = p[i + 0]!;
      const y = p[i + 1]!;
      const z = p[i + 2]!;
      if (x < llx || (x === llx && z < llz)) {
        llx = x;
        lly = y;
        llz = z;
        lli = i / 4;
      }
      if (x > urx || (x === urx && z > urz)) {
        urx = x;
        ury = y;
        urz = z;
        uri = i / 4;
      }
    }
    simplified.push(llx);
    simplified.push(lly);
    simplified.push(llz);
    simplified.push(lli);

    simplified.push(urx);
    simplified.push(ury);
    simplified.push(urz);
    simplified.push(uri);
  }

  // Add points until all raw points are within
  // error tolerance to the simplified shape.
  const maxErrorSqr = f32(maxError * maxError);
  const pn = points.size() / 4;
  for (let i = 0; i < simplified.size() / 4; ) {
    const s = simplified.data;
    const ii = (i + 1) % (simplified.size() / 4);

    let ax = s[i * 4 + 0]!;
    let az = s[i * 4 + 2]!;
    const ai = s[i * 4 + 3]!;

    let bx = s[ii * 4 + 0]!;
    let bz = s[ii * 4 + 2]!;
    const bi = s[ii * 4 + 3]!;

    // Find maximum deviation from the segment.
    let maxd = 0;
    let maxi = -1;
    let ci: number;
    let cinc: number;
    let endi: number;

    // Traverse the segment in lexilogical order so that the
    // max deviation is calculated similarly when traversing
    // opposite segments.
    if (bx > ax || (bx === ax && bz > az)) {
      cinc = 1;
      ci = (ai + cinc) % pn;
      endi = bi;
    } else {
      cinc = pn - 1;
      ci = (bi + cinc) % pn;
      endi = ai;
      let t = ax;
      ax = bx;
      bx = t;
      t = az;
      az = bz;
      bz = t;
    }

    // Tessellate only outer edges or edges between areas.
    if ((p[ci * 4 + 3]! & RC_CONTOUR_REG_MASK) === 0 || p[ci * 4 + 3]! & RC_AREA_BORDER) {
      while (ci !== endi) {
        const d = distancePtSeg(p[ci * 4 + 0]!, p[ci * 4 + 2]!, ax, az, bx, bz);
        if (d > maxd) {
          maxd = d;
          maxi = ci;
        }
        ci = (ci + cinc) % pn;
      }
    }

    // If the max deviation is larger than accepted error,
    // add new point, else continue to next segment.
    if (maxi !== -1 && maxd > maxErrorSqr) {
      insertSimplifiedPoint(simplified, i, p, maxi);
    } else {
      ++i;
    }
  }

  // Split too long edges.
  if (maxEdgeLen > 0 && (buildFlags & (RC_CONTOUR_TESS_WALL_EDGES | RC_CONTOUR_TESS_AREA_EDGES)) !== 0) {
    for (let i = 0; i < simplified.size() / 4; ) {
      const s = simplified.data;
      const ii = (i + 1) % (simplified.size() / 4);

      const ax = s[i * 4 + 0]!;
      const az = s[i * 4 + 2]!;
      const ai = s[i * 4 + 3]!;

      const bx = s[ii * 4 + 0]!;
      const bz = s[ii * 4 + 2]!;
      const bi = s[ii * 4 + 3]!;

      // Find maximum deviation from the segment.
      let maxi = -1;
      const ci = (ai + 1) % pn;

      // Tessellate only outer edges or edges between areas.
      let tess = false;
      // Wall edges.
      if (buildFlags & RC_CONTOUR_TESS_WALL_EDGES && (p[ci * 4 + 3]! & RC_CONTOUR_REG_MASK) === 0) tess = true;
      // Edges between areas.
      if (buildFlags & RC_CONTOUR_TESS_AREA_EDGES && p[ci * 4 + 3]! & RC_AREA_BORDER) tess = true;

      if (tess) {
        const dx = bx - ax;
        const dz = bz - az;
        if (dx * dx + dz * dz > maxEdgeLen * maxEdgeLen) {
          // Round based on the segments in lexilogical order so that the
          // max tesselation is consistent regardles in which direction
          // segments are traversed.
          const n = bi < ai ? bi + pn - ai : bi - ai;
          if (n > 1) {
            if (bx > ax || (bx === ax && bz > az)) maxi = (ai + ((n / 2) | 0)) % pn;
            else maxi = (ai + (((n + 1) / 2) | 0)) % pn;
          }
        }
      }

      // If the max deviation is larger than accepted error,
      // add new point, else continue to next segment.
      if (maxi !== -1) {
        insertSimplifiedPoint(simplified, i, p, maxi);
      } else {
        ++i;
      }
    }
  }

  const s = simplified.data;
  for (let i = 0; i < simplified.size() / 4; ++i) {
    // The edge vertex flag is take from the current raw point,
    // and the neighbour region is take from the next raw point.
    const ai = (s[i * 4 + 3]! + 1) % pn;
    const bi = s[i * 4 + 3]!;
    s[i * 4 + 3] = (p[ai * 4 + 3]! & (RC_CONTOUR_REG_MASK | RC_AREA_BORDER)) | (p[bi * 4 + 3]! & RC_BORDER_VERTEX);
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp calcAreaOfPolygon2D */
function calcAreaOfPolygon2D(verts: Int32Array, nverts: number): number {
  let area = 0;
  for (let i = 0, j = nverts - 1; i < nverts; j = i++) {
    const vi = i * 4;
    const vj = j * 4;
    area += verts[vi]! * verts[vj + 2]! - verts[vj]! * verts[vi + 2]!;
  }
  return ((area + 1) / 2) | 0;
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp prev */
function prev(i: number, n: number): number {
  return i - 1 >= 0 ? i - 1 : n - 1;
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp next */
function next(i: number, n: number): number {
  return i + 1 < n ? i + 1 : 0;
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp area2 */
function area2(av: Int32Array, a: number, bv: Int32Array, b: number, cv: Int32Array, c: number): number {
  return (bv[b]! - av[a]!) * (cv[c + 2]! - av[a + 2]!) - (cv[c]! - av[a]!) * (bv[b + 2]! - av[a + 2]!);
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp xorb */
function xorb(x: boolean, y: boolean): boolean {
  return !x !== !y;
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp left */
function left(av: Int32Array, a: number, bv: Int32Array, b: number, cv: Int32Array, c: number): boolean {
  return area2(av, a, bv, b, cv, c) < 0;
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp leftOn */
function leftOn(av: Int32Array, a: number, bv: Int32Array, b: number, cv: Int32Array, c: number): boolean {
  return area2(av, a, bv, b, cv, c) <= 0;
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp collinear */
function collinear(av: Int32Array, a: number, bv: Int32Array, b: number, cv: Int32Array, c: number): boolean {
  return area2(av, a, bv, b, cv, c) === 0;
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp intersectProp */
function intersectProp(
  av: Int32Array,
  a: number,
  bv: Int32Array,
  b: number,
  cv: Int32Array,
  c: number,
  dv: Int32Array,
  d: number,
): boolean {
  // Eliminate improper cases.
  if (collinear(av, a, bv, b, cv, c) || collinear(av, a, bv, b, dv, d) || collinear(cv, c, dv, d, av, a) || collinear(cv, c, dv, d, bv, b))
    return false;

  return (
    xorb(left(av, a, bv, b, cv, c), left(av, a, bv, b, dv, d)) && xorb(left(cv, c, dv, d, av, a), left(cv, c, dv, d, bv, b))
  );
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp between */
function between(av: Int32Array, a: number, bv: Int32Array, b: number, cv: Int32Array, c: number): boolean {
  if (!collinear(av, a, bv, b, cv, c)) return false;
  // If ab not vertical, check betweenness on x; else on y.
  if (av[a] !== bv[b])
    return (av[a]! <= cv[c]! && cv[c]! <= bv[b]!) || (av[a]! >= cv[c]! && cv[c]! >= bv[b]!);
  else return (av[a + 2]! <= cv[c + 2]! && cv[c + 2]! <= bv[b + 2]!) || (av[a + 2]! >= cv[c + 2]! && cv[c + 2]! >= bv[b + 2]!);
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp intersect */
function intersect(
  av: Int32Array,
  a: number,
  bv: Int32Array,
  b: number,
  cv: Int32Array,
  c: number,
  dv: Int32Array,
  d: number,
): boolean {
  if (intersectProp(av, a, bv, b, cv, c, dv, d)) return true;
  else if (between(av, a, bv, b, cv, c) || between(av, a, bv, b, dv, d) || between(cv, c, dv, d, av, a) || between(cv, c, dv, d, bv, b))
    return true;
  else return false;
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp vequal */
function vequal(av: Int32Array, a: number, bv: Int32Array, b: number): boolean {
  return av[a] === bv[b] && av[a + 2] === bv[b + 2];
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp intersectSegCountour */
function intersectSegCountour(d0v: Int32Array, d0: number, d1v: Int32Array, d1: number, i: number, n: number, verts: Int32Array): boolean {
  // For each edge (k,k+1) of P
  for (let k = 0; k < n; k++) {
    const k1 = next(k, n);
    // Skip edges incident to i.
    if (i === k || i === k1) continue;
    const p0 = k * 4;
    const p1 = k1 * 4;
    if (vequal(d0v, d0, verts, p0) || vequal(d1v, d1, verts, p0) || vequal(d0v, d0, verts, p1) || vequal(d1v, d1, verts, p1)) continue;

    if (intersect(d0v, d0, d1v, d1, verts, p0, verts, p1)) return true;
  }
  return false;
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp inCone */
function inCone(i: number, n: number, verts: Int32Array, pjv: Int32Array, pj: number): boolean {
  const pi = i * 4;
  const pi1 = next(i, n) * 4;
  const pin1 = prev(i, n) * 4;

  // If P[i] is a convex vertex [ i+1 left or on (i-1,i) ].
  if (leftOn(verts, pin1, verts, pi, verts, pi1)) return left(verts, pi, pjv, pj, verts, pin1) && left(pjv, pj, verts, pi, verts, pi1);
  // Assume (i-1,i,i+1) not collinear.
  // else P[i] is reflex.
  return !(leftOn(verts, pi, pjv, pj, verts, pi1) && leftOn(pjv, pj, verts, pi, verts, pin1));
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp removeDegenerateSegments */
function removeDegenerateSegments(simplified: rcIntArray): void {
  // Remove adjacent vertices which are equal on xz-plane,
  // or else the triangulator will get confused.
  let npts = simplified.size() / 4;
  for (let i = 0; i < npts; ++i) {
    const ni = next(i, npts);
    const s = simplified.data;

    if (vequal(s, i * 4, s, ni * 4)) {
      // Degenerate segment, remove.
      for (let j = i; j < simplified.size() / 4 - 1; ++j) {
        s[j * 4 + 0] = s[(j + 1) * 4 + 0]!;
        s[j * 4 + 1] = s[(j + 1) * 4 + 1]!;
        s[j * 4 + 2] = s[(j + 1) * 4 + 2]!;
        s[j * 4 + 3] = s[(j + 1) * 4 + 3]!;
      }
      simplified.resize(simplified.size() - 4);
      npts--;
    }
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp mergeContours */
function mergeContours(ca: rcContour, cb: rcContour, ia: number, ib: number): boolean {
  const maxVerts = ca.nverts + cb.nverts + 2;
  const verts = new Int32Array(maxVerts * 4);
  const caVerts = ca.verts!;
  const cbVerts = cb.verts!;

  let nv = 0;

  // Copy contour A.
  for (let i = 0; i <= ca.nverts; ++i) {
    const dst = nv * 4;
    const src = ((ia + i) % ca.nverts) * 4;
    verts[dst] = caVerts[src]!;
    verts[dst + 1] = caVerts[src + 1]!;
    verts[dst + 2] = caVerts[src + 2]!;
    verts[dst + 3] = caVerts[src + 3]!;
    nv++;
  }

  // Copy contour B
  for (let i = 0; i <= cb.nverts; ++i) {
    const dst = nv * 4;
    const src = ((ib + i) % cb.nverts) * 4;
    verts[dst] = cbVerts[src]!;
    verts[dst + 1] = cbVerts[src + 1]!;
    verts[dst + 2] = cbVerts[src + 2]!;
    verts[dst + 3] = cbVerts[src + 3]!;
    nv++;
  }

  ca.verts = verts;
  ca.nverts = nv;

  cb.verts = null;
  cb.nverts = 0;

  return true;
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp rcContourHole */
interface rcContourHole {
  contour: rcContour;
  minx: number;
  minz: number;
  leftmost: number;
}

/**
 * `holes` is the `rcContourHole*` slice `allHoles[holes .. holes + nholes]`.
 * @ac deps/recastnavigation/Recast/Source/RecastContour.cpp rcContourRegion
 */
interface rcContourRegion {
  outline: rcContour | null;
  holes: number;
  nholes: number;
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp findLeftMostVertex */
function findLeftMostVertex(contour: rcContour, hole: rcContourHole): void {
  const v = contour.verts!;
  hole.minx = v[0]!;
  hole.minz = v[2]!;
  hole.leftmost = 0;
  for (let i = 1; i < contour.nverts; i++) {
    const x = v[i * 4 + 0]!;
    const z = v[i * 4 + 2]!;
    if (x < hole.minx || (x === hole.minx && z < hole.minz)) {
      hole.minx = x;
      hole.minz = z;
      hole.leftmost = i;
    }
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp compareHoles */
function compareHoles(a: rcContourHole, b: rcContourHole): number {
  if (a.minx === b.minx) {
    if (a.minz < b.minz) return -1;
    if (a.minz > b.minz) return 1;
  } else {
    if (a.minx < b.minx) return -1;
    if (a.minx > b.minx) return 1;
  }
  return 0;
}

/**
 * Compares `rcPotentialDiagonal { int vert; int dist; }` records by `dist`.
 * @ac deps/recastnavigation/Recast/Source/RecastContour.cpp compareDiagDist
 * @ac deps/recastnavigation/Recast/Source/RecastContour.cpp rcPotentialDiagonal
 */
function compareDiagDist(a: readonly [number, number], b: readonly [number, number]): number {
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  return 0;
}

/** @ac deps/recastnavigation/Recast/Source/RecastContour.cpp mergeRegionHoles */
function mergeRegionHoles(ctx: rcContext, region: rcContourRegion, allHoles: rcContourHole[]): void {
  // Sort holes from left to right.
  for (let i = 0; i < region.nholes; i++) {
    const hole = allHoles[region.holes + i]!;
    findLeftMostVertex(hole.contour, hole);
  }

  const sorted = allHoles.slice(region.holes, region.holes + region.nholes).sort(compareHoles);
  for (let i = 0; i < region.nholes; i++) allHoles[region.holes + i] = sorted[i]!;

  let maxVerts = region.outline!.nverts;
  for (let i = 0; i < region.nholes; i++) maxVerts += allHoles[region.holes + i]!.contour.nverts;

  // `rcPotentialDiagonal diags[maxVerts]`, kept for the whole call like the C++ buffer: the hole loop below reads
  // `diags[i]` with the hole index (an upstream quirk), which may hold an entry from an earlier hole.
  const diagVert = new Int32Array(maxVerts);
  const diagDist = new Int32Array(maxVerts);
  const sortBuf: Array<[number, number]> = [];

  const outline = region.outline!;

  // Merge holes into the outline one by one.
  for (let i = 0; i < region.nholes; i++) {
    const hole = allHoles[region.holes + i]!.contour;

    let index = -1;
    let bestVertex = allHoles[region.holes + i]!.leftmost;
    for (let iter = 0; iter < hole.nverts; iter++) {
      // Find potential diagonals.
      // The 'best' vertex must be in the cone described by 3 cosequtive vertices of the outline.
      // ..o j-1
      //   |
      //   |   * best
      //   |
      // j o-----o j+1
      //         :
      let ndiags = 0;
      const hv = hole.verts!;
      const corner = bestVertex * 4;
      const ov = outline.verts!;
      for (let j = 0; j < outline.nverts; j++) {
        if (inCone(j, outline.nverts, ov, hv, corner)) {
          const dx = ov[j * 4 + 0]! - hv[corner]!;
          const dz = ov[j * 4 + 2]! - hv[corner + 2]!;
          diagVert[ndiags] = j;
          diagDist[ndiags] = dx * dx + dz * dz;
          ndiags++;
        }
      }
      // Sort potential diagonals by distance, we want to make the connection as short as possible.
      sortBuf.length = ndiags;
      for (let j = 0; j < ndiags; j++) sortBuf[j] = [diagVert[j]!, diagDist[j]!];
      sortBuf.sort(compareDiagDist);
      for (let j = 0; j < ndiags; j++) {
        diagVert[j] = sortBuf[j]![0];
        diagDist[j] = sortBuf[j]![1];
      }

      // Find a diagonal that is not intersecting the outline not the remaining holes.
      index = -1;
      for (let j = 0; j < ndiags; j++) {
        const pt = diagVert[j]! * 4;
        let isect = intersectSegCountour(ov, pt, hv, corner, diagVert[i] ?? 0, outline.nverts, ov);
        for (let k = i; k < region.nholes && !isect; k++) {
          const hk = allHoles[region.holes + k]!.contour;
          isect = isect || intersectSegCountour(ov, pt, hv, corner, -1, hk.nverts, hk.verts!);
        }
        if (!isect) {
          index = diagVert[j]!;
          break;
        }
      }
      // If found non-intersecting diagonal, stop looking.
      if (index !== -1) break;
      // All the potential diagonals for the current vertex were intersecting, try next vertex.
      bestVertex = (bestVertex + 1) % hole.nverts;
    }

    if (index === -1) {
      ctx.log(RC_LOG_WARNING, "mergeHoles: Failed to find merge points for %p and %p.", region.outline, hole);
      continue;
    }
    if (!mergeContours(region.outline!, hole, index, bestVertex)) {
      ctx.log(RC_LOG_WARNING, "mergeHoles: Failed to merge contours %p and %p.", region.outline, hole);
      continue;
    }
  }
}

/**
 * Builds a contour set from the region outlines in the provided compact heightfield.
 * @ac deps/recastnavigation/Recast/Source/RecastContour.cpp rcBuildContours
 */
export function rcBuildContours(
  ctx: rcContext,
  chf: rcCompactHeightfield,
  maxError: number,
  maxEdgeLen: number,
  cset: rcContourSet,
  buildFlags: number = RC_CONTOUR_TESS_WALL_EDGES,
): boolean {
  maxError = f32(maxError);
  const w = chf.width;
  const h = chf.height;
  const borderSize = chf.borderSize;
  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;
  const con = chf.spans.con;
  const spanReg = chf.spans.reg;

  using _timer = new rcScopedTimer(ctx, RC_TIMER_BUILD_CONTOURS);

  rcVcopy(cset.bmin, 0, chf.bmin, 0);
  rcVcopy(cset.bmax, 0, chf.bmax, 0);
  if (borderSize > 0) {
    // If the heightfield was build with bordersize, remove the offset.
    const pad = f32(borderSize * chf.cs);
    cset.bmin[0] = cset.bmin[0]! + pad;
    cset.bmin[2] = cset.bmin[2]! + pad;
    cset.bmax[0] = cset.bmax[0]! - pad;
    cset.bmax[2] = cset.bmax[2]! - pad;
  }
  cset.cs = chf.cs;
  cset.ch = chf.ch;
  cset.width = chf.width - chf.borderSize * 2;
  cset.height = chf.height - chf.borderSize * 2;
  cset.borderSize = chf.borderSize;
  cset.maxError = maxError;

  let maxContours = rcMax(chf.maxRegions, 8);
  cset.conts = [];
  cset.nconts = 0;

  const flags = new Uint8Array(chf.spanCount);

  ctx.startTimer(RC_TIMER_BUILD_CONTOURS_TRACE);

  // Mark boundaries.
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const c = x + y * w;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        let res = 0;
        const sreg = spanReg[i]!;
        if (!sreg || sreg & RC_BORDER_REG) {
          flags[i] = 0;
          continue;
        }
        for (let dir = 0; dir < 4; ++dir) {
          let r = 0;
          if (rcGetCon(con, i, dir) !== RC_NOT_CONNECTED) {
            const ax = x + rcGetDirOffsetX(dir);
            const ay = y + rcGetDirOffsetY(dir);
            const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, dir);
            r = spanReg[ai]!;
          }
          if (r === sreg) res |= 1 << dir;
        }
        flags[i] = res ^ 0xf; // Inverse, mark non connected edges.
      }
    }
  }

  ctx.stopTimer(RC_TIMER_BUILD_CONTOURS_TRACE);

  const verts = new rcIntArray(256);
  const simplified = new rcIntArray(64);

  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const c = x + y * w;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        if (flags[i] === 0 || flags[i] === 0xf) {
          flags[i] = 0;
          continue;
        }
        const reg = spanReg[i]!;
        if (!reg || reg & RC_BORDER_REG) continue;
        const area = chf.areas[i]!;

        verts.resize(0);
        simplified.resize(0);

        ctx.startTimer(RC_TIMER_BUILD_CONTOURS_TRACE);
        walkContour(x, y, i, chf, flags, verts);
        ctx.stopTimer(RC_TIMER_BUILD_CONTOURS_TRACE);

        ctx.startTimer(RC_TIMER_BUILD_CONTOURS_SIMPLIFY);
        simplifyContour(verts, simplified, maxError, maxEdgeLen, buildFlags);
        removeDegenerateSegments(simplified);
        ctx.stopTimer(RC_TIMER_BUILD_CONTOURS_SIMPLIFY);

        // Store region->contour remap info.
        // Create contour.
        if (simplified.size() / 4 >= 3) {
          if (cset.nconts >= maxContours) {
            // Allocate more contours.
            // This happens when a region has holes.
            const oldMax = maxContours;
            maxContours *= 2;
            ctx.log(RC_LOG_WARNING, "rcBuildContours: Expanding max contours from %d to %d.", oldMax, maxContours);
          }

          const cont = new rcContour();
          cset.conts.push(cont);
          cset.nconts++;

          cont.nverts = simplified.size() / 4;
          cont.verts = simplified.data.slice(0, cont.nverts * 4);
          if (borderSize > 0) {
            // If the heightfield was build with bordersize, remove the offset.
            for (let j = 0; j < cont.nverts; ++j) {
              cont.verts[j * 4] = cont.verts[j * 4]! - borderSize;
              cont.verts[j * 4 + 2] = cont.verts[j * 4 + 2]! - borderSize;
            }
          }

          cont.nrverts = verts.size() / 4;
          cont.rverts = verts.data.slice(0, cont.nrverts * 4);
          if (borderSize > 0) {
            // If the heightfield was build with bordersize, remove the offset.
            for (let j = 0; j < cont.nrverts; ++j) {
              cont.rverts[j * 4] = cont.rverts[j * 4]! - borderSize;
              cont.rverts[j * 4 + 2] = cont.rverts[j * 4 + 2]! - borderSize;
            }
          }

          cont.reg = reg;
          cont.area = area;
        }
      }
    }
  }

  // Merge holes if needed.
  if (cset.nconts > 0) {
    // Calculate winding of all polygons.
    const winding = new Int8Array(cset.nconts);
    let nholes = 0;
    for (let i = 0; i < cset.nconts; ++i) {
      const cont = cset.conts[i]!;
      // If the contour is wound backwards, it is a hole.
      winding[i] = calcAreaOfPolygon2D(cont.verts!, cont.nverts) < 0 ? -1 : 1;
      if (winding[i]! < 0) nholes++;
    }

    if (nholes > 0) {
      // Collect outline contour and holes contours per region.
      // We assume that there is one outline and multiple holes.
      const nregions = chf.maxRegions + 1;
      const regions: rcContourRegion[] = new Array(nregions);
      for (let i = 0; i < nregions; i++) regions[i] = { outline: null, holes: 0, nholes: 0 };

      const holes: rcContourHole[] = new Array(cset.nconts);

      for (let i = 0; i < cset.nconts; ++i) {
        const cont = cset.conts[i]!;
        // Positively would contours are outlines, negative holes.
        if (winding[i]! > 0) {
          if (regions[cont.reg]!.outline) ctx.log(RC_LOG_ERROR, "rcBuildContours: Multiple outlines for region %d.", cont.reg);
          regions[cont.reg]!.outline = cont;
        } else {
          regions[cont.reg]!.nholes++;
        }
      }
      let index = 0;
      for (let i = 0; i < nregions; i++) {
        const r = regions[i]!;
        if (r.nholes > 0) {
          r.holes = index;
          index += r.nholes;
          r.nholes = 0;
        }
      }
      for (let i = 0; i < cset.nconts; ++i) {
        const cont = cset.conts[i]!;
        const reg = regions[cont.reg]!;
        if (winding[i]! < 0) holes[reg.holes + reg.nholes++] = { contour: cont, minx: 0, minz: 0, leftmost: 0 };
      }

      // Finally merge each regions holes into the outline.
      for (let i = 0; i < nregions; i++) {
        const reg = regions[i]!;
        if (!reg.nholes) continue;

        if (reg.outline) {
          mergeRegionHoles(ctx, reg, holes);
        } else {
          // The region does not have an outline.
          // This can happen if the contour becaomes selfoverlapping because of
          // too aggressive simplification settings.
          ctx.log(RC_LOG_ERROR, "rcBuildContours: Bad outline for region %d, contour simplification is likely too aggressive.", i);
        }
      }
    }
  }

  return true;
}
