/**
 * Port of `deps/recastnavigation/Recast/Source/RecastMesh.cpp`.
 *
 * Polygons are rows of `unsigned short` in `Uint16Array`s addressed by offset (`p = i*nvp*2`); contour and hole
 * vertices are `int[4]` records in `Int32Array`s. `rcEdge` is six `unsigned short` per edge in one `Uint16Array`.
 */
import {
  RC_BORDER_VERTEX,
  RC_LOG_ERROR,
  RC_LOG_WARNING,
  RC_MESH_NULL_IDX,
  RC_MULTIPLE_REGS,
  RC_TIMER_BUILD_POLYMESH,
  RC_TIMER_MERGE_POLYMESH,
  f32,
  rcAbs,
  rcMax,
  rcScopedTimer,
  rcVcopy,
  rcVmax,
  rcVmin,
  type rcContext,
  type rcContourSet,
  type rcPolyMesh,
  type rcRef,
} from "./Recast.ts";

/** `rcEdge` field offsets inside a 6-element record. @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp rcEdge */
const EDGE_VERT0 = 0;
const EDGE_VERT1 = 1;
const EDGE_POLYEDGE0 = 2;
const EDGE_POLYEDGE1 = 3;
const EDGE_POLY0 = 4;
const EDGE_POLY1 = 5;

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp buildMeshAdjacency */
function buildMeshAdjacency(polys: Uint16Array, npolys: number, nverts: number, vertsPerPoly: number): boolean {
  // Based on code by Eric Lengyel from:
  // http://www.terathon.com/code/edges.php

  const maxEdgeCount = npolys * vertsPerPoly;
  const firstEdge = new Uint16Array(nverts + maxEdgeCount);
  const nextEdge = nverts;
  let edgeCount = 0;

  const edges = new Uint16Array(maxEdgeCount * 6);

  for (let i = 0; i < nverts; i++) firstEdge[i] = RC_MESH_NULL_IDX;

  for (let i = 0; i < npolys; ++i) {
    const t = i * vertsPerPoly * 2;
    for (let j = 0; j < vertsPerPoly; ++j) {
      if (polys[t + j] === RC_MESH_NULL_IDX) break;
      const v0 = polys[t + j]!;
      const v1 = j + 1 >= vertsPerPoly || polys[t + j + 1] === RC_MESH_NULL_IDX ? polys[t]! : polys[t + j + 1]!;
      if (v0 < v1) {
        const edge = edgeCount * 6;
        edges[edge + EDGE_VERT0] = v0;
        edges[edge + EDGE_VERT1] = v1;
        edges[edge + EDGE_POLY0] = i;
        edges[edge + EDGE_POLYEDGE0] = j;
        edges[edge + EDGE_POLY1] = i;
        edges[edge + EDGE_POLYEDGE1] = 0;
        // Insert edge
        firstEdge[nextEdge + edgeCount] = firstEdge[v0]!;
        firstEdge[v0] = edgeCount;
        edgeCount++;
      }
    }
  }

  for (let i = 0; i < npolys; ++i) {
    const t = i * vertsPerPoly * 2;
    for (let j = 0; j < vertsPerPoly; ++j) {
      if (polys[t + j] === RC_MESH_NULL_IDX) break;
      const v0 = polys[t + j]!;
      const v1 = j + 1 >= vertsPerPoly || polys[t + j + 1] === RC_MESH_NULL_IDX ? polys[t]! : polys[t + j + 1]!;
      if (v0 > v1) {
        for (let e = firstEdge[v1]!; e !== RC_MESH_NULL_IDX; e = firstEdge[nextEdge + e]!) {
          const edge = e * 6;
          if (edges[edge + EDGE_VERT1] === v0 && edges[edge + EDGE_POLY0] === edges[edge + EDGE_POLY1]) {
            edges[edge + EDGE_POLY1] = i;
            edges[edge + EDGE_POLYEDGE1] = j;
            break;
          }
        }
      }
    }
  }

  // Store adjacency
  for (let i = 0; i < edgeCount; ++i) {
    const e = i * 6;
    const poly0 = edges[e + EDGE_POLY0]!;
    const poly1 = edges[e + EDGE_POLY1]!;
    if (poly0 !== poly1) {
      const p0 = poly0 * vertsPerPoly * 2;
      const p1 = poly1 * vertsPerPoly * 2;
      polys[p0 + vertsPerPoly + edges[e + EDGE_POLYEDGE0]!] = poly1;
      polys[p1 + vertsPerPoly + edges[e + EDGE_POLYEDGE1]!] = poly0;
    }
  }

  return true;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp VERTEX_BUCKET_COUNT */
const VERTEX_BUCKET_COUNT = 1 << 12;

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp computeVertexHash */
function computeVertexHash(x: number, y: number, z: number): number {
  const h1 = 0x8da6b343 | 0; // Large multiplicative constants;
  const h2 = 0xd8163841 | 0; // here arbitrarily chosen primes
  const h3 = 0xcb1ab31f | 0;
  const n = (Math.imul(h1, x) + Math.imul(h2, y) + Math.imul(h3, z)) | 0;
  return n & (VERTEX_BUCKET_COUNT - 1);
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp addVertex */
function addVertex(
  x: number,
  y: number,
  z: number,
  verts: Uint16Array,
  firstVert: Int32Array,
  nextVert: Int32Array,
  nv: rcRef<number>,
): number {
  const bucket = computeVertexHash(x, 0, z);
  let i = firstVert[bucket]!;

  while (i !== -1) {
    const v = i * 3;
    if (verts[v] === x && rcAbs(verts[v + 1]! - y) <= 2 && verts[v + 2] === z) return i & 0xffff;
    i = nextVert[i]!; // next
  }

  // Could not find, create new.
  i = nv.value;
  nv.value++;
  const v = i * 3;
  verts[v] = x;
  verts[v + 1] = y;
  verts[v + 2] = z;
  nextVert[i] = firstVert[bucket]!;
  firstVert[bucket] = i;

  return i & 0xffff;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp prev */
function prev(i: number, n: number): number {
  return i - 1 >= 0 ? i - 1 : n - 1;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp next */
function next(i: number, n: number): number {
  return i + 1 < n ? i + 1 : 0;
}

/** Offsets `a`, `b`, `c` index `int[4]` records of `v`. @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp area2 */
function area2(v: Int32Array, a: number, b: number, c: number): number {
  return (v[b]! - v[a]!) * (v[c + 2]! - v[a + 2]!) - (v[c]! - v[a]!) * (v[b + 2]! - v[a + 2]!);
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp xorb */
function xorb(x: boolean, y: boolean): boolean {
  return !x !== !y;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp left */
function left(v: Int32Array, a: number, b: number, c: number): boolean {
  return area2(v, a, b, c) < 0;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp leftOn */
function leftOn(v: Int32Array, a: number, b: number, c: number): boolean {
  return area2(v, a, b, c) <= 0;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp collinear */
function collinear(v: Int32Array, a: number, b: number, c: number): boolean {
  return area2(v, a, b, c) === 0;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp intersectProp */
function intersectProp(v: Int32Array, a: number, b: number, c: number, d: number): boolean {
  // Eliminate improper cases.
  if (collinear(v, a, b, c) || collinear(v, a, b, d) || collinear(v, c, d, a) || collinear(v, c, d, b)) return false;

  return xorb(left(v, a, b, c), left(v, a, b, d)) && xorb(left(v, c, d, a), left(v, c, d, b));
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp between */
function between(v: Int32Array, a: number, b: number, c: number): boolean {
  if (!collinear(v, a, b, c)) return false;
  // If ab not vertical, check betweenness on x; else on y.
  if (v[a] !== v[b]) return (v[a]! <= v[c]! && v[c]! <= v[b]!) || (v[a]! >= v[c]! && v[c]! >= v[b]!);
  else return (v[a + 2]! <= v[c + 2]! && v[c + 2]! <= v[b + 2]!) || (v[a + 2]! >= v[c + 2]! && v[c + 2]! >= v[b + 2]!);
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp intersect */
function intersect(v: Int32Array, a: number, b: number, c: number, d: number): boolean {
  if (intersectProp(v, a, b, c, d)) return true;
  else if (between(v, a, b, c) || between(v, a, b, d) || between(v, c, d, a) || between(v, c, d, b)) return true;
  else return false;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp vequal */
function vequal(v: Int32Array, a: number, b: number): boolean {
  return v[a] === v[b] && v[a + 2] === v[b + 2];
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp diagonalie */
function diagonalie(i: number, j: number, n: number, verts: Int32Array, indices: Int32Array): boolean {
  const d0 = (indices[i]! & 0x0fffffff) * 4;
  const d1 = (indices[j]! & 0x0fffffff) * 4;

  // For each edge (k,k+1) of P
  for (let k = 0; k < n; k++) {
    const k1 = next(k, n);
    // Skip edges incident to i or j
    if (!(k === i || k1 === i || k === j || k1 === j)) {
      const p0 = (indices[k]! & 0x0fffffff) * 4;
      const p1 = (indices[k1]! & 0x0fffffff) * 4;

      if (vequal(verts, d0, p0) || vequal(verts, d1, p0) || vequal(verts, d0, p1) || vequal(verts, d1, p1)) continue;

      if (intersect(verts, d0, d1, p0, p1)) return false;
    }
  }
  return true;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp inCone */
function inCone(i: number, j: number, n: number, verts: Int32Array, indices: Int32Array): boolean {
  const pi = (indices[i]! & 0x0fffffff) * 4;
  const pj = (indices[j]! & 0x0fffffff) * 4;
  const pi1 = (indices[next(i, n)]! & 0x0fffffff) * 4;
  const pin1 = (indices[prev(i, n)]! & 0x0fffffff) * 4;

  // If P[i] is a convex vertex [ i+1 left or on (i-1,i) ].
  if (leftOn(verts, pin1, pi, pi1)) return left(verts, pi, pj, pin1) && left(verts, pj, pi, pi1);
  // Assume (i-1,i,i+1) not collinear.
  // else P[i] is reflex.
  return !(leftOn(verts, pi, pj, pi1) && leftOn(verts, pj, pi, pin1));
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp diagonal */
function diagonal(i: number, j: number, n: number, verts: Int32Array, indices: Int32Array): boolean {
  return inCone(i, j, n, verts, indices) && diagonalie(i, j, n, verts, indices);
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp diagonalieLoose */
function diagonalieLoose(i: number, j: number, n: number, verts: Int32Array, indices: Int32Array): boolean {
  const d0 = (indices[i]! & 0x0fffffff) * 4;
  const d1 = (indices[j]! & 0x0fffffff) * 4;

  // For each edge (k,k+1) of P
  for (let k = 0; k < n; k++) {
    const k1 = next(k, n);
    // Skip edges incident to i or j
    if (!(k === i || k1 === i || k === j || k1 === j)) {
      const p0 = (indices[k]! & 0x0fffffff) * 4;
      const p1 = (indices[k1]! & 0x0fffffff) * 4;

      if (vequal(verts, d0, p0) || vequal(verts, d1, p0) || vequal(verts, d0, p1) || vequal(verts, d1, p1)) continue;

      if (intersectProp(verts, d0, d1, p0, p1)) return false;
    }
  }
  return true;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp inConeLoose */
function inConeLoose(i: number, j: number, n: number, verts: Int32Array, indices: Int32Array): boolean {
  const pi = (indices[i]! & 0x0fffffff) * 4;
  const pj = (indices[j]! & 0x0fffffff) * 4;
  const pi1 = (indices[next(i, n)]! & 0x0fffffff) * 4;
  const pin1 = (indices[prev(i, n)]! & 0x0fffffff) * 4;

  // If P[i] is a convex vertex [ i+1 left or on (i-1,i) ].
  if (leftOn(verts, pin1, pi, pi1)) return leftOn(verts, pi, pj, pin1) && leftOn(verts, pj, pi, pi1);
  // Assume (i-1,i,i+1) not collinear.
  // else P[i] is reflex.
  return !(leftOn(verts, pi, pj, pi1) && leftOn(verts, pj, pi, pin1));
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp diagonalLoose */
function diagonalLoose(i: number, j: number, n: number, verts: Int32Array, indices: Int32Array): boolean {
  return inConeLoose(i, j, n, verts, indices) && diagonalieLoose(i, j, n, verts, indices);
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp triangulate */
function triangulate(n: number, verts: Int32Array, indices: Int32Array, tris: Int32Array): number {
  let ntris = 0;
  let dst = 0;

  // The last bit of the index is used to indicate if the vertex can be removed.
  for (let i = 0; i < n; i++) {
    const i1 = next(i, n);
    const i2 = next(i1, n);
    if (diagonal(i, i2, n, verts, indices)) indices[i1] = indices[i1]! | 0x80000000;
  }

  while (n > 3) {
    let minLen = -1;
    let mini = -1;
    for (let i = 0; i < n; i++) {
      const i1 = next(i, n);
      if (indices[i1]! & 0x80000000) {
        const p0 = (indices[i]! & 0x0fffffff) * 4;
        const p2 = (indices[next(i1, n)]! & 0x0fffffff) * 4;

        const dx = verts[p2]! - verts[p0]!;
        const dy = verts[p2 + 2]! - verts[p0 + 2]!;
        const len = dx * dx + dy * dy;

        if (minLen < 0 || len < minLen) {
          minLen = len;
          mini = i;
        }
      }
    }

    if (mini === -1) {
      // We might get here because the contour has overlapping segments, like this:
      //
      //  A o-o=====o---o B
      //   /  |C   D|    \.
      //  o   o     o     o
      //  :   :     :     :
      // We'll try to recover by loosing up the inCone test a bit so that a diagonal
      // like A-B or C-D can be found and we can continue.
      minLen = -1;
      mini = -1;
      for (let i = 0; i < n; i++) {
        const i1 = next(i, n);
        const i2 = next(i1, n);
        if (diagonalLoose(i, i2, n, verts, indices)) {
          const p0 = (indices[i]! & 0x0fffffff) * 4;
          const p2 = (indices[next(i2, n)]! & 0x0fffffff) * 4;
          const dx = verts[p2]! - verts[p0]!;
          const dy = verts[p2 + 2]! - verts[p0 + 2]!;
          const len = dx * dx + dy * dy;

          if (minLen < 0 || len < minLen) {
            minLen = len;
            mini = i;
          }
        }
      }
      if (mini === -1) {
        // The contour is messed up. This sometimes happens
        // if the contour simplification is too aggressive.
        return -ntris;
      }
    }

    let i = mini;
    let i1 = next(i, n);
    const i2 = next(i1, n);

    tris[dst++] = indices[i]! & 0x0fffffff;
    tris[dst++] = indices[i1]! & 0x0fffffff;
    tris[dst++] = indices[i2]! & 0x0fffffff;
    ntris++;

    // Removes P[i1] by copying P[i+1]...P[n-1] left one index.
    n--;
    for (let k = i1; k < n; k++) indices[k] = indices[k + 1]!;

    if (i1 >= n) i1 = 0;
    i = prev(i1, n);
    // Update diagonal flags.
    if (diagonal(prev(i, n), i1, n, verts, indices)) indices[i] = indices[i]! | 0x80000000;
    else indices[i] = indices[i]! & 0x0fffffff;

    if (diagonal(i, next(i1, n), n, verts, indices)) indices[i1] = indices[i1]! | 0x80000000;
    else indices[i1] = indices[i1]! & 0x0fffffff;
  }

  // Append the remaining triangle.
  tris[dst++] = indices[0]! & 0x0fffffff;
  tris[dst++] = indices[1]! & 0x0fffffff;
  tris[dst++] = indices[2]! & 0x0fffffff;
  ntris++;

  return ntris;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp countPolyVerts */
function countPolyVerts(polys: Uint16Array, p: number, nvp: number): number {
  for (let i = 0; i < nvp; ++i) if (polys[p + i] === RC_MESH_NULL_IDX) return i;
  return nvp;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp uleft */
function uleft(verts: Uint16Array, a: number, b: number, c: number): boolean {
  return (verts[b]! - verts[a]!) * (verts[c + 2]! - verts[a + 2]!) - (verts[c]! - verts[a]!) * (verts[b + 2]! - verts[a + 2]!) < 0;
}

/** `int& ea, int& eb` outputs of `getPolyMergeValue`. */
let mergeEa = 0;
let mergeEb = 0;

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp getPolyMergeValue */
function getPolyMergeValue(polys: Uint16Array, pa: number, pb: number, verts: Uint16Array, nvp: number): number {
  const na = countPolyVerts(polys, pa, nvp);
  const nb = countPolyVerts(polys, pb, nvp);

  // If the merged polygon would be too big, do not merge.
  if (na + nb - 2 > nvp) return -1;

  // Check if the polygons share an edge.
  let ea = -1;
  let eb = -1;
  mergeEa = ea;
  mergeEb = eb;

  for (let i = 0; i < na; ++i) {
    let va0 = polys[pa + i]!;
    let va1 = polys[pa + ((i + 1) % na)]!;
    if (va0 > va1) {
      const t = va0;
      va0 = va1;
      va1 = t;
    }
    for (let j = 0; j < nb; ++j) {
      let vb0 = polys[pb + j]!;
      let vb1 = polys[pb + ((j + 1) % nb)]!;
      if (vb0 > vb1) {
        const t = vb0;
        vb0 = vb1;
        vb1 = t;
      }
      if (va0 === vb0 && va1 === vb1) {
        ea = i;
        eb = j;
        break;
      }
    }
  }
  mergeEa = ea;
  mergeEb = eb;

  // No common edge, cannot merge.
  if (ea === -1 || eb === -1) return -1;

  // Check to see if the merged polygon would be convex.
  let va = polys[pa + ((ea + na - 1) % na)]!;
  let vb = polys[pa + ea]!;
  let vc = polys[pb + ((eb + 2) % nb)]!;
  if (!uleft(verts, va * 3, vb * 3, vc * 3)) return -1;

  va = polys[pb + ((eb + nb - 1) % nb)]!;
  vb = polys[pb + eb]!;
  vc = polys[pa + ((ea + 2) % na)]!;
  if (!uleft(verts, va * 3, vb * 3, vc * 3)) return -1;

  va = polys[pa + ea]!;
  vb = polys[pa + ((ea + 1) % na)]!;

  const dx = verts[va * 3 + 0]! - verts[vb * 3 + 0]!;
  const dy = verts[va * 3 + 2]! - verts[vb * 3 + 2]!;

  return dx * dx + dy * dy;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp mergePolyVerts */
function mergePolyVerts(polys: Uint16Array, pa: number, pb: number, ea: number, eb: number, tmp: number, nvp: number): void {
  const na = countPolyVerts(polys, pa, nvp);
  const nb = countPolyVerts(polys, pb, nvp);

  // Merge polygons.
  polys.fill(0xffff, tmp, tmp + nvp);
  let n = 0;
  // Add pa
  for (let i = 0; i < na - 1; ++i) polys[tmp + n++] = polys[pa + ((ea + 1 + i) % na)]!;
  // Add pb
  for (let i = 0; i < nb - 1; ++i) polys[tmp + n++] = polys[pb + ((eb + 1 + i) % nb)]!;

  polys.copyWithin(pa, tmp, tmp + nvp);
}

/** Returns the new count. @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp pushFront */
function pushFront(v: number, arr: Int32Array, an: number): number {
  an++;
  for (let i = an - 1; i > 0; --i) arr[i] = arr[i - 1]!;
  arr[0] = v;
  return an;
}

/** Returns the new count. @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp pushBack */
function pushBack(v: number, arr: Int32Array, an: number): number {
  arr[an] = v;
  an++;
  return an;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp canRemoveVertex */
function canRemoveVertex(_ctx: rcContext, mesh: rcPolyMesh, rem: number): boolean {
  const nvp = mesh.nvp;
  const polys = mesh.polys!;

  // Count number of polygons to remove.
  let numTouchedVerts = 0;
  let numRemainingEdges = 0;
  for (let i = 0; i < mesh.npolys; ++i) {
    const p = i * nvp * 2;
    const nv = countPolyVerts(polys, p, nvp);
    let numRemoved = 0;
    let numVerts = 0;
    for (let j = 0; j < nv; ++j) {
      if (polys[p + j] === rem) {
        numTouchedVerts++;
        numRemoved++;
      }
      numVerts++;
    }
    if (numRemoved) {
      numRemainingEdges += numVerts - (numRemoved + 1);
    }
  }

  // There would be too few edges remaining to create a polygon.
  // This can happen for example when a tip of a triangle is marked
  // as deletion, but there are no other polys that share the vertex.
  // In this case, the vertex should not be removed.
  if (numRemainingEdges <= 2) return false;

  // Find edges which share the removed vertex.
  const maxEdges = numTouchedVerts * 2;
  let nedges = 0;
  const edges = new Int32Array(maxEdges * 3);

  for (let i = 0; i < mesh.npolys; ++i) {
    const p = i * nvp * 2;
    const nv = countPolyVerts(polys, p, nvp);

    // Collect edges which touches the removed vertex.
    for (let j = 0, k = nv - 1; j < nv; k = j++) {
      if (polys[p + j] === rem || polys[p + k] === rem) {
        // Arrange edge so that a=rem.
        let a = polys[p + j]!;
        let b = polys[p + k]!;
        if (b === rem) {
          const t = a;
          a = b;
          b = t;
        }

        // Check if the edge exists
        let exists = false;
        for (let m = 0; m < nedges; ++m) {
          const e = m * 3;
          if (edges[e + 1] === b) {
            // Exists, increment vertex share count.
            edges[e + 2]!++;
            exists = true;
          }
        }
        // Add new edge.
        if (!exists) {
          const e = nedges * 3;
          edges[e] = a;
          edges[e + 1] = b;
          edges[e + 2] = 1;
          nedges++;
        }
      }
    }
  }

  // There should be no more than 2 open edges.
  // This catches the case that two non-adjacent polygons
  // share the removed vertex. In that case, do not remove the vertex.
  let numOpenEdges = 0;
  for (let i = 0; i < nedges; ++i) {
    if (edges[i * 3 + 2]! < 2) numOpenEdges++;
  }
  if (numOpenEdges > 2) return false;

  return true;
}

/** @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp removeVertex */
function removeVertex(ctx: rcContext, mesh: rcPolyMesh, rem: number, maxTris: number): boolean {
  const nvp = mesh.nvp;
  const mpolys = mesh.polys!;
  const mverts = mesh.verts!;
  const mregs = mesh.regs!;
  const mareas = mesh.areas!;

  // Count number of polygons to remove.
  let numRemovedVerts = 0;
  for (let i = 0; i < mesh.npolys; ++i) {
    const p = i * nvp * 2;
    const nv = countPolyVerts(mpolys, p, nvp);
    for (let j = 0; j < nv; ++j) {
      if (mpolys[p + j] === rem) numRemovedVerts++;
    }
  }

  let nedges = 0;
  const edges = new Int32Array(numRemovedVerts * nvp * 4);

  let nhole = 0;
  const hole = new Int32Array(numRemovedVerts * nvp);

  let nhreg = 0;
  const hreg = new Int32Array(numRemovedVerts * nvp);

  let nharea = 0;
  const harea = new Int32Array(numRemovedVerts * nvp);

  for (let i = 0; i < mesh.npolys; ++i) {
    const p = i * nvp * 2;
    const nv = countPolyVerts(mpolys, p, nvp);
    let hasRem = false;
    for (let j = 0; j < nv; ++j) if (mpolys[p + j] === rem) hasRem = true;
    if (hasRem) {
      // Collect edges which does not touch the removed vertex.
      for (let j = 0, k = nv - 1; j < nv; k = j++) {
        if (mpolys[p + j] !== rem && mpolys[p + k] !== rem) {
          const e = nedges * 4;
          edges[e] = mpolys[p + k]!;
          edges[e + 1] = mpolys[p + j]!;
          edges[e + 2] = mregs[i]!;
          edges[e + 3] = mareas[i]!;
          nedges++;
        }
      }
      // Remove the polygon.
      const p2 = (mesh.npolys - 1) * nvp * 2;
      if (p !== p2) mpolys.copyWithin(p, p2, p2 + nvp);
      mpolys.fill(0xffff, p + nvp, p + nvp * 2);
      mregs[i] = mregs[mesh.npolys - 1]!;
      mareas[i] = mareas[mesh.npolys - 1]!;
      mesh.npolys--;
      --i;
    }
  }

  // Remove vertex.
  for (let i = rem; i < mesh.nverts - 1; ++i) {
    mverts[i * 3 + 0] = mverts[(i + 1) * 3 + 0]!;
    mverts[i * 3 + 1] = mverts[(i + 1) * 3 + 1]!;
    mverts[i * 3 + 2] = mverts[(i + 1) * 3 + 2]!;
  }
  mesh.nverts--;

  // Adjust indices to match the removed vertex layout.
  for (let i = 0; i < mesh.npolys; ++i) {
    const p = i * nvp * 2;
    const nv = countPolyVerts(mpolys, p, nvp);
    for (let j = 0; j < nv; ++j) if (mpolys[p + j]! > rem) mpolys[p + j]!--;
  }
  for (let i = 0; i < nedges; ++i) {
    if (edges[i * 4 + 0]! > rem) edges[i * 4 + 0]!--;
    if (edges[i * 4 + 1]! > rem) edges[i * 4 + 1]!--;
  }

  if (nedges === 0) return true;

  // Start with one vertex, keep appending connected
  // segments to the start and end of the hole.
  nhole = pushBack(edges[0]!, hole, nhole);
  nhreg = pushBack(edges[2]!, hreg, nhreg);
  nharea = pushBack(edges[3]!, harea, nharea);

  while (nedges) {
    let match = false;

    for (let i = 0; i < nedges; ++i) {
      const ea = edges[i * 4 + 0]!;
      const eb = edges[i * 4 + 1]!;
      const r = edges[i * 4 + 2]!;
      const a = edges[i * 4 + 3]!;
      let add = false;
      if (hole[0] === eb) {
        // The segment matches the beginning of the hole boundary.
        nhole = pushFront(ea, hole, nhole);
        nhreg = pushFront(r, hreg, nhreg);
        nharea = pushFront(a, harea, nharea);
        add = true;
      } else if (hole[nhole - 1] === ea) {
        // The segment matches the end of the hole boundary.
        nhole = pushBack(eb, hole, nhole);
        nhreg = pushBack(r, hreg, nhreg);
        nharea = pushBack(a, harea, nharea);
        add = true;
      }
      if (add) {
        // The edge segment was added, remove it.
        edges[i * 4 + 0] = edges[(nedges - 1) * 4 + 0]!;
        edges[i * 4 + 1] = edges[(nedges - 1) * 4 + 1]!;
        edges[i * 4 + 2] = edges[(nedges - 1) * 4 + 2]!;
        edges[i * 4 + 3] = edges[(nedges - 1) * 4 + 3]!;
        --nedges;
        match = true;
        --i;
      }
    }

    if (!match) break;
  }

  const tris = new Int32Array(nhole * 3);
  const tverts = new Int32Array(nhole * 4);
  const thole = new Int32Array(nhole);

  // Generate temp vertex array for triangulation.
  for (let i = 0; i < nhole; ++i) {
    const pi = hole[i]!;
    tverts[i * 4 + 0] = mverts[pi * 3 + 0]!;
    tverts[i * 4 + 1] = mverts[pi * 3 + 1]!;
    tverts[i * 4 + 2] = mverts[pi * 3 + 2]!;
    tverts[i * 4 + 3] = 0;
    thole[i] = i;
  }

  // Triangulate the hole.
  let ntris = triangulate(nhole, tverts, thole, tris);
  if (ntris < 0) {
    ntris = -ntris;
    ctx.log(RC_LOG_WARNING, "removeVertex: triangulate() returned bad results.");
  }

  // Merge the hole triangles back to polygons.
  const polys = new Uint16Array((ntris + 1) * nvp);
  const pregs = new Uint16Array(ntris);
  const pareas = new Uint8Array(ntris);

  const tmpPoly = ntris * nvp;

  // Build initial polygons.
  let npolys = 0;
  polys.fill(0xffff, 0, ntris * nvp);
  for (let j = 0; j < ntris; ++j) {
    const t0 = tris[j * 3]!;
    const t1 = tris[j * 3 + 1]!;
    const t2 = tris[j * 3 + 2]!;
    if (t0 !== t1 && t0 !== t2 && t1 !== t2) {
      polys[npolys * nvp + 0] = hole[t0]!;
      polys[npolys * nvp + 1] = hole[t1]!;
      polys[npolys * nvp + 2] = hole[t2]!;

      // If this polygon covers multiple region types then
      // mark it as such
      if (hreg[t0] !== hreg[t1] || hreg[t1] !== hreg[t2]) pregs[npolys] = RC_MULTIPLE_REGS;
      else pregs[npolys] = hreg[t0]!;

      pareas[npolys] = harea[t0]!;
      npolys++;
    }
  }
  if (!npolys) return true;

  // Merge polygons.
  if (nvp > 3) {
    for (;;) {
      // Find best polygons to merge.
      let bestMergeVal = 0;
      let bestPa = 0;
      let bestPb = 0;
      let bestEa = 0;
      let bestEb = 0;

      for (let j = 0; j < npolys - 1; ++j) {
        const pj = j * nvp;
        for (let k = j + 1; k < npolys; ++k) {
          const pk = k * nvp;
          const v = getPolyMergeValue(polys, pj, pk, mverts, nvp);
          if (v > bestMergeVal) {
            bestMergeVal = v;
            bestPa = j;
            bestPb = k;
            bestEa = mergeEa;
            bestEb = mergeEb;
          }
        }
      }

      if (bestMergeVal > 0) {
        // Found best, merge.
        const pa = bestPa * nvp;
        const pb = bestPb * nvp;
        mergePolyVerts(polys, pa, pb, bestEa, bestEb, tmpPoly, nvp);
        if (pregs[bestPa] !== pregs[bestPb]) pregs[bestPa] = RC_MULTIPLE_REGS;

        const last = (npolys - 1) * nvp;
        if (pb !== last) polys.copyWithin(pb, last, last + nvp);
        pregs[bestPb] = pregs[npolys - 1]!;
        pareas[bestPb] = pareas[npolys - 1]!;
        npolys--;
      } else {
        // Could not merge any polygons, stop.
        break;
      }
    }
  }

  // Store polygons.
  for (let i = 0; i < npolys; ++i) {
    if (mesh.npolys >= maxTris) break;
    const p = mesh.npolys * nvp * 2;
    mpolys.fill(0xffff, p, p + nvp * 2);
    for (let j = 0; j < nvp; ++j) mpolys[p + j] = polys[i * nvp + j]!;
    mregs[mesh.npolys] = pregs[i]!;
    mareas[mesh.npolys] = pareas[i]!;
    mesh.npolys++;
    if (mesh.npolys > maxTris) {
      ctx.log(RC_LOG_ERROR, "removeVertex: Too many polygons %d (max:%d).", mesh.npolys, maxTris);
      return false;
    }
  }

  return true;
}

/**
 * Builds a polygon mesh from the provided contours.
 * @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp rcBuildPolyMesh
 */
export function rcBuildPolyMesh(ctx: rcContext, cset: rcContourSet, nvp: number, mesh: rcPolyMesh): boolean {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_BUILD_POLYMESH);

  rcVcopy(mesh.bmin, 0, cset.bmin, 0);
  rcVcopy(mesh.bmax, 0, cset.bmax, 0);
  mesh.cs = cset.cs;
  mesh.ch = cset.ch;
  mesh.borderSize = cset.borderSize;
  mesh.maxEdgeError = cset.maxError;

  let maxVertices = 0;
  let maxTris = 0;
  let maxVertsPerCont = 0;
  for (let i = 0; i < cset.nconts; ++i) {
    const cont = cset.conts[i]!;
    // Skip null contours.
    if (cont.nverts < 3) continue;
    maxVertices += cont.nverts;
    maxTris += cont.nverts - 2;
    maxVertsPerCont = rcMax(maxVertsPerCont, cont.nverts);
  }

  if (maxVertices >= 0xfffe) {
    ctx.log(RC_LOG_ERROR, "rcBuildPolyMesh: Too many vertices %d.", maxVertices);
    return false;
  }

  const vflags = new Uint8Array(maxVertices);

  const mverts = new Uint16Array(maxVertices * 3);
  const mpolys = new Uint16Array(maxTris * nvp * 2);
  const mregs = new Uint16Array(maxTris);
  const mareas = new Uint8Array(maxTris);
  mesh.verts = mverts;
  mesh.polys = mpolys;
  mesh.regs = mregs;
  mesh.areas = mareas;

  mesh.nverts = 0;
  mesh.npolys = 0;
  mesh.nvp = nvp;
  mesh.maxpolys = maxTris;

  mpolys.fill(0xffff);

  const nextVert = new Int32Array(maxVertices);

  const firstVert = new Int32Array(VERTEX_BUCKET_COUNT);
  firstVert.fill(-1);

  const indices = new Int32Array(maxVertsPerCont);
  const tris = new Int32Array(maxVertsPerCont * 3);
  const polys = new Uint16Array((maxVertsPerCont + 1) * nvp);
  const tmpPoly = maxVertsPerCont * nvp;
  const nv: rcRef<number> = { value: 0 };

  for (let i = 0; i < cset.nconts; ++i) {
    const cont = cset.conts[i]!;

    // Skip null contours.
    if (cont.nverts < 3) continue;
    const cverts = cont.verts!;

    // Triangulate contour
    for (let j = 0; j < cont.nverts; ++j) indices[j] = j;

    let ntris = triangulate(cont.nverts, cverts, indices, tris);
    if (ntris <= 0) {
      // Bad triangulation, should not happen.
      ctx.log(RC_LOG_WARNING, "rcBuildPolyMesh: Bad triangulation Contour %d.", i);
      ntris = -ntris;
    }

    // Add and merge vertices.
    nv.value = mesh.nverts;
    for (let j = 0; j < cont.nverts; ++j) {
      const v = j * 4;
      indices[j] = addVertex(cverts[v]! & 0xffff, cverts[v + 1]! & 0xffff, cverts[v + 2]! & 0xffff, mverts, firstVert, nextVert, nv);
      if (cverts[v + 3]! & RC_BORDER_VERTEX) {
        // This vertex should be removed.
        vflags[indices[j]!] = 1;
      }
    }
    mesh.nverts = nv.value;

    // Build initial polygons.
    let npolys = 0;
    polys.fill(0xffff, 0, maxVertsPerCont * nvp);
    for (let j = 0; j < ntris; ++j) {
      const t0 = tris[j * 3]!;
      const t1 = tris[j * 3 + 1]!;
      const t2 = tris[j * 3 + 2]!;
      if (t0 !== t1 && t0 !== t2 && t1 !== t2) {
        polys[npolys * nvp + 0] = indices[t0]!;
        polys[npolys * nvp + 1] = indices[t1]!;
        polys[npolys * nvp + 2] = indices[t2]!;
        npolys++;
      }
    }
    if (!npolys) continue;

    // Merge polygons.
    if (nvp > 3) {
      for (;;) {
        // Find best polygons to merge.
        let bestMergeVal = 0;
        let bestPa = 0;
        let bestPb = 0;
        let bestEa = 0;
        let bestEb = 0;

        for (let j = 0; j < npolys - 1; ++j) {
          const pj = j * nvp;
          for (let k = j + 1; k < npolys; ++k) {
            const pk = k * nvp;
            const v = getPolyMergeValue(polys, pj, pk, mverts, nvp);
            if (v > bestMergeVal) {
              bestMergeVal = v;
              bestPa = j;
              bestPb = k;
              bestEa = mergeEa;
              bestEb = mergeEb;
            }
          }
        }

        if (bestMergeVal > 0) {
          // Found best, merge.
          const pa = bestPa * nvp;
          const pb = bestPb * nvp;
          mergePolyVerts(polys, pa, pb, bestEa, bestEb, tmpPoly, nvp);
          const lastPoly = (npolys - 1) * nvp;
          if (pb !== lastPoly) polys.copyWithin(pb, lastPoly, lastPoly + nvp);
          npolys--;
        } else {
          // Could not merge any polygons, stop.
          break;
        }
      }
    }

    // Store polygons.
    for (let j = 0; j < npolys; ++j) {
      const p = mesh.npolys * nvp * 2;
      const q = j * nvp;
      for (let k = 0; k < nvp; ++k) mpolys[p + k] = polys[q + k]!;
      mregs[mesh.npolys] = cont.reg;
      mareas[mesh.npolys] = cont.area;
      mesh.npolys++;
      if (mesh.npolys > maxTris) {
        ctx.log(RC_LOG_ERROR, "rcBuildPolyMesh: Too many polygons %d (max:%d).", mesh.npolys, maxTris);
        return false;
      }
    }
  }

  // Remove edge vertices.
  for (let i = 0; i < mesh.nverts; ++i) {
    if (vflags[i]) {
      if (!canRemoveVertex(ctx, mesh, i)) continue;
      if (!removeVertex(ctx, mesh, i, maxTris)) {
        // Failed to remove vertex
        ctx.log(RC_LOG_ERROR, "rcBuildPolyMesh: Failed to remove edge vertex %d.", i);
        return false;
      }
      // Remove vertex
      // Note: mesh.nverts is already decremented inside removeVertex()!
      // Fixup vertex flags
      for (let j = i; j < mesh.nverts; ++j) vflags[j] = vflags[j + 1]!;
      --i;
    }
  }

  // Calculate adjacency.
  if (!buildMeshAdjacency(mpolys, mesh.npolys, mesh.nverts, nvp)) {
    ctx.log(RC_LOG_ERROR, "rcBuildPolyMesh: Adjacency failed.");
    return false;
  }

  // Find portal edges
  if (mesh.borderSize > 0) {
    const w = cset.width;
    const h = cset.height;
    for (let i = 0; i < mesh.npolys; ++i) {
      const p = i * 2 * nvp;
      for (let j = 0; j < nvp; ++j) {
        if (mpolys[p + j] === RC_MESH_NULL_IDX) break;
        // Skip connected edges.
        if (mpolys[p + nvp + j] !== RC_MESH_NULL_IDX) continue;
        let nj = j + 1;
        if (nj >= nvp || mpolys[p + nj] === RC_MESH_NULL_IDX) nj = 0;
        const va = mpolys[p + j]! * 3;
        const vb = mpolys[p + nj]! * 3;

        if (mverts[va] === 0 && mverts[vb] === 0) mpolys[p + nvp + j] = 0x8000 | 0;
        else if (mverts[va + 2] === h && mverts[vb + 2] === h) mpolys[p + nvp + j] = 0x8000 | 1;
        else if (mverts[va] === w && mverts[vb] === w) mpolys[p + nvp + j] = 0x8000 | 2;
        else if (mverts[va + 2] === 0 && mverts[vb + 2] === 0) mpolys[p + nvp + j] = 0x8000 | 3;
      }
    }
  }

  // Just allocate the mesh flags array. The user is resposible to fill it.
  mesh.flags = new Uint16Array(mesh.npolys);

  if (mesh.nverts > 0xffff) {
    ctx.log(RC_LOG_ERROR, "rcBuildPolyMesh: The resulting mesh has too many vertices %d (max %d). Data can be corrupted.", mesh.nverts, 0xffff);
  }
  if (mesh.npolys > 0xffff) {
    ctx.log(RC_LOG_ERROR, "rcBuildPolyMesh: The resulting mesh has too many polygons %d (max %d). Data can be corrupted.", mesh.npolys, 0xffff);
  }

  return true;
}

/**
 * Merges multiple polygon meshes into a single mesh.
 * @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp rcMergePolyMeshes
 */
export function rcMergePolyMeshes(ctx: rcContext, meshes: ReadonlyArray<rcPolyMesh> | null, nmeshes: number, mesh: rcPolyMesh): boolean {
  if (!nmeshes || !meshes) return true;

  using _timer = new rcScopedTimer(ctx, RC_TIMER_MERGE_POLYMESH);

  const first = meshes[0]!;
  mesh.nvp = first.nvp;
  mesh.cs = first.cs;
  mesh.ch = first.ch;
  rcVcopy(mesh.bmin, 0, first.bmin, 0);
  rcVcopy(mesh.bmax, 0, first.bmax, 0);

  let maxVerts = 0;
  let maxPolys = 0;
  let maxVertsPerMesh = 0;
  for (let i = 0; i < nmeshes; ++i) {
    const m = meshes[i]!;
    rcVmin(mesh.bmin, 0, m.bmin, 0);
    rcVmax(mesh.bmax, 0, m.bmax, 0);
    maxVertsPerMesh = rcMax(maxVertsPerMesh, m.nverts);
    maxVerts += m.nverts;
    maxPolys += m.npolys;
  }

  mesh.nverts = 0;
  const mverts = new Uint16Array(maxVerts * 3);
  mesh.verts = mverts;

  mesh.npolys = 0;
  const mpolys = new Uint16Array(maxPolys * 2 * mesh.nvp);
  mpolys.fill(0xffff);
  mesh.polys = mpolys;

  const mregs = new Uint16Array(maxPolys);
  mesh.regs = mregs;
  const mareas = new Uint8Array(maxPolys);
  mesh.areas = mareas;
  const mflags = new Uint16Array(maxPolys);
  mesh.flags = mflags;

  const nextVert = new Int32Array(maxVerts);

  const firstVert = new Int32Array(VERTEX_BUCKET_COUNT);
  firstVert.fill(-1);

  const vremap = new Uint16Array(maxVertsPerMesh);
  const nv: rcRef<number> = { value: 0 };
  const cs = mesh.cs;

  for (let i = 0; i < nmeshes; ++i) {
    const pmesh = meshes[i]!;
    const pverts = pmesh.verts!;
    const ppolys = pmesh.polys!;

    const ox = (Math.floor(f32(f32(f32(pmesh.bmin[0]! - mesh.bmin[0]!) / cs) + 0.5)) | 0) & 0xffff;
    const oz = (Math.floor(f32(f32(f32(pmesh.bmin[2]! - mesh.bmin[2]!) / cs) + 0.5)) | 0) & 0xffff;

    const isMinX = ox === 0;
    const isMinZ = oz === 0;
    const isMaxX = ((Math.floor(f32(f32(f32(mesh.bmax[0]! - pmesh.bmax[0]!) / cs) + 0.5)) | 0) & 0xffff) === 0;
    const isMaxZ = ((Math.floor(f32(f32(f32(mesh.bmax[2]! - pmesh.bmax[2]!) / cs) + 0.5)) | 0) & 0xffff) === 0;
    const isOnBorder = isMinX || isMinZ || isMaxX || isMaxZ;

    nv.value = mesh.nverts;
    for (let j = 0; j < pmesh.nverts; ++j) {
      const v = j * 3;
      vremap[j] = addVertex((pverts[v]! + ox) & 0xffff, pverts[v + 1]!, (pverts[v + 2]! + oz) & 0xffff, mverts, firstVert, nextVert, nv);
    }
    mesh.nverts = nv.value;

    for (let j = 0; j < pmesh.npolys; ++j) {
      const tgt = mesh.npolys * 2 * mesh.nvp;
      const src = j * 2 * mesh.nvp;
      mregs[mesh.npolys] = pmesh.regs![j]!;
      mareas[mesh.npolys] = pmesh.areas![j]!;
      mflags[mesh.npolys] = pmesh.flags![j]!;
      mesh.npolys++;
      for (let k = 0; k < mesh.nvp; ++k) {
        if (ppolys[src + k] === RC_MESH_NULL_IDX) break;
        mpolys[tgt + k] = vremap[ppolys[src + k]!]!;
      }

      if (isOnBorder) {
        for (let k = mesh.nvp; k < mesh.nvp * 2; ++k) {
          const sk = ppolys[src + k]!;
          if (sk & 0x8000 && sk !== 0xffff) {
            const dir = sk & 0xf;
            switch (dir) {
              case 0: // Portal x-
                if (isMinX) mpolys[tgt + k] = sk;
                break;
              case 1: // Portal z+
                if (isMaxZ) mpolys[tgt + k] = sk;
                break;
              case 2: // Portal x+
                if (isMaxX) mpolys[tgt + k] = sk;
                break;
              case 3: // Portal z-
                if (isMinZ) mpolys[tgt + k] = sk;
                break;
            }
          }
        }
      }
    }
  }

  // Calculate adjacency.
  if (!buildMeshAdjacency(mpolys, mesh.npolys, mesh.nverts, mesh.nvp)) {
    ctx.log(RC_LOG_ERROR, "rcMergePolyMeshes: Adjacency failed.");
    return false;
  }

  if (mesh.nverts > 0xffff) {
    ctx.log(RC_LOG_ERROR, "rcMergePolyMeshes: The resulting mesh has too many vertices %d (max %d). Data can be corrupted.", mesh.nverts, 0xffff);
  }
  if (mesh.npolys > 0xffff) {
    ctx.log(RC_LOG_ERROR, "rcMergePolyMeshes: The resulting mesh has too many polygons %d (max %d). Data can be corrupted.", mesh.npolys, 0xffff);
  }

  return true;
}

/**
 * Copies the poly mesh data from src to dst.
 * @ac deps/recastnavigation/Recast/Source/RecastMesh.cpp rcCopyPolyMesh
 */
export function rcCopyPolyMesh(_ctx: rcContext, src: rcPolyMesh, dst: rcPolyMesh): boolean {
  dst.nverts = src.nverts;
  dst.npolys = src.npolys;
  dst.maxpolys = src.npolys;
  dst.nvp = src.nvp;
  rcVcopy(dst.bmin, 0, src.bmin, 0);
  rcVcopy(dst.bmax, 0, src.bmax, 0);
  dst.cs = src.cs;
  dst.ch = src.ch;
  dst.borderSize = src.borderSize;
  dst.maxEdgeError = src.maxEdgeError;

  dst.verts = src.verts!.slice(0, src.nverts * 3);
  dst.polys = src.polys!.slice(0, src.npolys * 2 * src.nvp);
  dst.regs = src.regs!.slice(0, src.npolys);
  dst.areas = src.areas!.slice(0, src.npolys);
  dst.flags = src.flags!.slice(0, src.npolys);

  return true;
}
