/**
 * Port of `deps/recastnavigation/Detour/Include/DetourNavMeshBuilder.h` and `Source/DetourNavMeshBuilder.cpp`.
 *
 * `dtCreateNavMeshData` writes the tile blob that `dtNavMesh::addTile` reads and that `MapBuilder` stores after the
 * `MmapTileHeader` of a `.mmtile`. The float math that ends up in the blob is rounded to `float` (`Math.fround`) at
 * the same points the C++ rounds, so the bytes match a C++ build for the same input.
 *
 * One known difference: `subdivide` sorts the BV items with a stable sort, while C `qsort` is unstable and its order
 * of equal keys depends on the C library. The BV tree is equivalent either way; only the order of nodes whose
 * bounds start at the same coordinate can differ from a given C++ build.
 *
 * The `float` members of `dtNavMeshCreateParams` (`cs`, `ch`, `walkableClimb`, ...) are plain numbers here; the
 * builder reads them through `Math.fround` so a caller that passes a double gets the same bytes as the C++ struct.
 */
import { DT_ALLOC_PERM, DT_ALLOC_TEMP, dtAlloc, dtFree } from "./DetourAlloc.ts";
import { dtAlign4, dtClamp, dtMax, dtMin, dtSwapEndian, dtVcopy, dtVmax, dtVmin } from "./DetourCommon.ts";
import { dtMathCeilf, dtMathFloorf } from "./DetourMath.ts";
import {
  DT_EXT_LINK,
  DT_NAVMESH_MAGIC,
  DT_NAVMESH_VERSION,
  DT_OFFMESH_CON_BIDIR,
  DT_POLYTYPE_GROUND,
  DT_POLYTYPE_OFFMESH_CONNECTION,
  DT_SIZEOF_BVNODE,
  DT_SIZEOF_LINK,
  DT_SIZEOF_MESH_HEADER,
  DT_SIZEOF_OFFMESH_CONNECTION,
  DT_SIZEOF_POLY,
  DT_SIZEOF_POLY_DETAIL,
  DT_VERTS_PER_POLYGON,
  dtMeshHeader,
  dtMeshTile,
  dtTileLayout,
} from "./DetourNavMesh.ts";

/** @ac deps/recastnavigation/Detour/Source/DetourNavMeshBuilder.cpp MESH_NULL_IDX */
const MESH_NULL_IDX = 0xffff;

/** @ac deps/recastnavigation/Detour/Source/DetourNavMeshBuilder.cpp BVItem */
class BVItem {
  readonly bmin = new Uint16Array(3);
  readonly bmax = new Uint16Array(3);
  i = 0;
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMeshBuilder.cpp compareItemX */
function compareItemX(a: BVItem, b: BVItem): number {
  if (a.bmin[0]! < b.bmin[0]!) return -1;
  if (a.bmin[0]! > b.bmin[0]!) return 1;
  return 0;
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMeshBuilder.cpp compareItemY */
function compareItemY(a: BVItem, b: BVItem): number {
  if (a.bmin[1]! < b.bmin[1]!) return -1;
  if (a.bmin[1]! > b.bmin[1]!) return 1;
  return 0;
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMeshBuilder.cpp compareItemZ */
function compareItemZ(a: BVItem, b: BVItem): number {
  if (a.bmin[2]! < b.bmin[2]!) return -1;
  if (a.bmin[2]! > b.bmin[2]!) return 1;
  return 0;
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMeshBuilder.cpp calcExtends */
function calcExtends(items: BVItem[], _nitems: number, imin: number, imax: number, bmin: Uint16Array, bmax: Uint16Array): void {
  const first = items[imin]!;
  bmin[0] = first.bmin[0]!;
  bmin[1] = first.bmin[1]!;
  bmin[2] = first.bmin[2]!;

  bmax[0] = first.bmax[0]!;
  bmax[1] = first.bmax[1]!;
  bmax[2] = first.bmax[2]!;

  for (let i = imin + 1; i < imax; ++i) {
    const it = items[i]!;
    if (it.bmin[0]! < bmin[0]!) bmin[0] = it.bmin[0]!;
    if (it.bmin[1]! < bmin[1]!) bmin[1] = it.bmin[1]!;
    if (it.bmin[2]! < bmin[2]!) bmin[2] = it.bmin[2]!;

    if (it.bmax[0]! > bmax[0]!) bmax[0] = it.bmax[0]!;
    if (it.bmax[1]! > bmax[1]!) bmax[1] = it.bmax[1]!;
    if (it.bmax[2]! > bmax[2]!) bmax[2] = it.bmax[2]!;
  }
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMeshBuilder.cpp longestAxis */
function longestAxis(x: number, y: number, z: number): number {
  let axis = 0;
  let maxVal = x & 0xffff;
  if ((y & 0xffff) > maxVal) {
    axis = 1;
    maxVal = y & 0xffff;
  }
  if ((z & 0xffff) > maxVal) {
    axis = 2;
  }
  return axis;
}

/** `qsort(items+imin, inum, sizeof(BVItem), compare)` (stable, see the file comment). */
function sortRange(items: BVItem[], imin: number, inum: number, compare: (a: BVItem, b: BVItem) => number): void {
  const part = items.slice(imin, imin + inum).sort(compare);
  for (let k = 0; k < inum; ++k) items[imin + k] = part[k]!;
}

/** The BV node array of the tile blob: `nodes16` (stride 8: bmin[3], bmax[3]) and `nodes32` (stride 4: i at +3). */
type BVNodes = { nodes16: Uint16Array; nodes32: Int32Array };


/** Writes `node.bmin` / `node.bmax` / `node.i` for node `n`. */
function setNode(nodes: BVNodes, n: number, bmin: Uint16Array, bmax: Uint16Array, i: number): void {
  const o = n * 8;
  nodes.nodes16[o] = bmin[0]!;
  nodes.nodes16[o + 1] = bmin[1]!;
  nodes.nodes16[o + 2] = bmin[2]!;
  nodes.nodes16[o + 3] = bmax[0]!;
  nodes.nodes16[o + 4] = bmax[1]!;
  nodes.nodes16[o + 5] = bmax[2]!;
  nodes.nodes32[n * 4 + 3] = i;
}

/**
 * Builds the BV subtree for `items[imin..imax)`; `curNode.value` is the C++ `int& curNode`.
 * @ac deps/recastnavigation/Detour/Source/DetourNavMeshBuilder.cpp subdivide
 */
function subdivide(items: BVItem[], nitems: number, imin: number, imax: number, curNode: { value: number }, nodes: BVNodes): void {
  const inum = imax - imin;
  const icur = curNode.value;

  const node = curNode.value++;

  if (inum === 1) {
    // Leaf
    const it = items[imin]!;
    setNode(nodes, node, it.bmin, it.bmax, it.i);
  } else {
    // Split
    const bmin = new Uint16Array(3);
    const bmax = new Uint16Array(3);
    calcExtends(items, nitems, imin, imax, bmin, bmax);
    setNode(nodes, node, bmin, bmax, 0);

    const axis = longestAxis(bmax[0]! - bmin[0]!, bmax[1]! - bmin[1]!, bmax[2]! - bmin[2]!);

    if (axis === 0) {
      // Sort along x-axis
      sortRange(items, imin, inum, compareItemX);
    } else if (axis === 1) {
      // Sort along y-axis
      sortRange(items, imin, inum, compareItemY);
    } else {
      // Sort along z-axis
      sortRange(items, imin, inum, compareItemZ);
    }

    const isplit = imin + Math.trunc(inum / 2);

    // Left
    subdivide(items, nitems, imin, isplit, curNode, nodes);
    // Right
    subdivide(items, nitems, isplit, imax, curNode, nodes);

    const iescape = curNode.value - icur;
    // Negative index means escape.
    nodes.nodes32[node * 4 + 3] = -iescape;
  }
}

const cbv_bmin = new Float32Array(3);
const cbv_bmax = new Float32Array(3);

/** @ac deps/recastnavigation/Detour/Source/DetourNavMeshBuilder.cpp createBVTree */
function createBVTree(params: dtNavMeshCreateParams, nodes: BVNodes, _nnodes: number): number {
  // Build tree
  const cs = Math.fround(params.cs);
  const ch = Math.fround(params.ch);
  const quantFactor = Math.fround(1 / cs);
  const items: BVItem[] = new Array(params.polyCount);
  for (let i = 0; i < params.polyCount; i++) {
    const it = new BVItem();
    items[i] = it;
    it.i = i;
    // Calc polygon bounds. Use detail meshes if available.
    if (params.detailMeshes) {
      const vb = params.detailMeshes[i * 4 + 0]!;
      const ndv = params.detailMeshes[i * 4 + 1]!;
      const bmin = cbv_bmin;
      const bmax = cbv_bmax;

      const dvArr = params.detailVerts!;
      const dv = vb * 3;
      dtVcopy(bmin, 0, dvArr, dv);
      dtVcopy(bmax, 0, dvArr, dv);

      for (let j = 1; j < ndv; j++) {
        dtVmin(bmin, 0, dvArr, dv + j * 3);
        dtVmax(bmax, 0, dvArr, dv + j * 3);
      }

      // BV-tree uses cs for all dimensions
      const pbmin = params.bmin;
      it.bmin[0] = dtClamp(Math.trunc(Math.fround(Math.fround(bmin[0]! - pbmin[0]!) * quantFactor)), 0, 0xffff);
      it.bmin[1] = dtClamp(Math.trunc(Math.fround(Math.fround(bmin[1]! - pbmin[1]!) * quantFactor)), 0, 0xffff);
      it.bmin[2] = dtClamp(Math.trunc(Math.fround(Math.fround(bmin[2]! - pbmin[2]!) * quantFactor)), 0, 0xffff);

      it.bmax[0] = dtClamp(Math.trunc(Math.fround(Math.fround(bmax[0]! - pbmin[0]!) * quantFactor)), 0, 0xffff);
      it.bmax[1] = dtClamp(Math.trunc(Math.fround(Math.fround(bmax[1]! - pbmin[1]!) * quantFactor)), 0, 0xffff);
      it.bmax[2] = dtClamp(Math.trunc(Math.fround(Math.fround(bmax[2]! - pbmin[2]!) * quantFactor)), 0, 0xffff);
    } else {
      const polys = params.polys!;
      const verts = params.verts!;
      const p = i * params.nvp * 2;
      it.bmin[0] = it.bmax[0] = verts[polys[p]! * 3 + 0]!;
      it.bmin[1] = it.bmax[1] = verts[polys[p]! * 3 + 1]!;
      it.bmin[2] = it.bmax[2] = verts[polys[p]! * 3 + 2]!;

      for (let j = 1; j < params.nvp; ++j) {
        const pj = polys[p + j]!;
        if (pj === MESH_NULL_IDX) break;
        const x = verts[pj * 3 + 0]!;
        const y = verts[pj * 3 + 1]!;
        const z = verts[pj * 3 + 2]!;

        if (x < it.bmin[0]!) it.bmin[0] = x;
        if (y < it.bmin[1]!) it.bmin[1] = y;
        if (z < it.bmin[2]!) it.bmin[2] = z;

        if (x > it.bmax[0]!) it.bmax[0] = x;
        if (y > it.bmax[1]!) it.bmax[1] = y;
        if (z > it.bmax[2]!) it.bmax[2] = z;
      }
      // Remap y
      it.bmin[1] = Math.trunc(dtMathFloorf(Math.fround(Math.fround(it.bmin[1]! * ch) / cs)));
      it.bmax[1] = Math.trunc(dtMathCeilf(Math.fround(Math.fround(it.bmax[1]! * ch) / cs)));
    }
  }

  const curNode = { value: 0 };
  subdivide(items, params.polyCount, 0, params.polyCount, curNode, nodes);

  return curNode.value;
}

const XP = 1 << 0;
const ZP = 1 << 1;
const XM = 1 << 2;
const ZM = 1 << 3;

/** @ac deps/recastnavigation/Detour/Source/DetourNavMeshBuilder.cpp classifyOffMeshPoint */
function classifyOffMeshPoint(pt: Float32Array, pti: number, bmin: Float32Array, bmax: Float32Array): number {
  let outcode = 0;
  outcode |= pt[pti]! >= bmax[0]! ? XP : 0;
  outcode |= pt[pti + 2]! >= bmax[2]! ? ZP : 0;
  outcode |= pt[pti]! < bmin[0]! ? XM : 0;
  outcode |= pt[pti + 2]! < bmin[2]! ? ZM : 0;

  switch (outcode) {
    case XP: return 0;
    case XP | ZP: return 1;
    case ZP: return 2;
    case XM | ZP: return 3;
    case XM: return 4;
    case XM | ZM: return 5;
    case ZM: return 6;
    case XP | ZM: return 7;
  }

  return 0xff;
}

/**
 * Represents the source data used to build an navigation mesh tile.
 * @ac deps/recastnavigation/Detour/Include/DetourNavMeshBuilder.h dtNavMeshCreateParams
 */
export class dtNavMeshCreateParams {
  // Polygon Mesh Attributes

  /** The polygon mesh vertices. [(x, y, z) * #vertCount] [Unit: vx] */
  verts: Uint16Array | null = null;
  /** The number vertices in the polygon mesh. [Limit: >= 3] */
  vertCount = 0;
  /** The polygon data. [Size: #polyCount * 2 * #nvp] */
  polys: Uint16Array | null = null;
  /** The user defined flags assigned to each polygon. [Size: #polyCount] */
  polyFlags: Uint16Array | null = null;
  /** The user defined area ids assigned to each polygon. [Size: #polyCount] */
  polyAreas: Uint8Array | null = null;
  /** Number of polygons in the mesh. [Limit: >= 1] */
  polyCount = 0;
  /** Number maximum number of vertices per polygon. [Limit: >= 3] */
  nvp = 0;

  // Height Detail Attributes (Optional)

  /** The height detail sub-mesh data. [Size: 4 * #polyCount] */
  detailMeshes: Uint32Array | null = null;
  /** The detail mesh vertices. [Size: 3 * #detailVertsCount] [Unit: wu] */
  detailVerts: Float32Array | null = null;
  /** The number of vertices in the detail mesh. */
  detailVertsCount = 0;
  /** The detail mesh triangles. [Size: 4 * #detailTriCount] */
  detailTris: Uint8Array | null = null;
  /** The number of triangles in the detail mesh. */
  detailTriCount = 0;

  // Off-Mesh Connections Attributes (Optional)

  /** Off-mesh connection vertices. [(ax, ay, az, bx, by, bz) * #offMeshConCount] [Unit: wu] */
  offMeshConVerts: Float32Array | null = null;
  /** Off-mesh connection radii. [Size: #offMeshConCount] [Unit: wu] */
  offMeshConRad: Float32Array | null = null;
  /** User defined flags assigned to the off-mesh connections. [Size: #offMeshConCount] */
  offMeshConFlags: Uint16Array | null = null;
  /** User defined area ids assigned to the off-mesh connections. [Size: #offMeshConCount] */
  offMeshConAreas: Uint8Array | null = null;
  /** The permitted travel direction of the off-mesh connections. [Size: #offMeshConCount] */
  offMeshConDir: Uint8Array | null = null;
  /** The user defined ids of the off-mesh connection. [Size: #offMeshConCount] */
  offMeshConUserID: Uint32Array | null = null;
  /** The number of off-mesh connections. [Limit: >= 0] */
  offMeshConCount = 0;

  // Tile Attributes

  /** The user defined id of the tile. */
  userId = 0;
  /** The tile's x-grid location within the multi-tile destination mesh. (Along the x-axis.) */
  tileX = 0;
  /** The tile's y-grid location within the multi-tile desitation mesh. (Along the z-axis.) */
  tileY = 0;
  /** The tile's layer within the layered destination mesh. [Limit: >= 0] (Along the y-axis.) */
  tileLayer = 0;
  /** The minimum bounds of the tile. [(x, y, z)] [Unit: wu] */
  readonly bmin = new Float32Array(3);
  /** The maximum bounds of the tile. [(x, y, z)] [Unit: wu] */
  readonly bmax = new Float32Array(3);

  // General Configuration Attributes

  /** The agent height. [Unit: wu] */
  walkableHeight = 0;
  /** The agent radius. [Unit: wu] */
  walkableRadius = 0;
  /** The agent maximum traversable ledge. (Up/Down) [Unit: wu] */
  walkableClimb = 0;
  /** The xz-plane cell size of the polygon mesh. [Limit: > 0] [Unit: wu] */
  cs = 0;
  /** The y-axis cell height of the polygon mesh. [Limit: > 0] [Unit: wu] */
  ch = 0;

  /** True if a bounding volume tree should be built for the tile. */
  buildBvTree = false;
}

/**
 * Builds navigation mesh tile data from the provided tile creation data. The blob goes to `outData.value`, its
 * size to `outDataSize.value`.
 * @ac deps/recastnavigation/Detour/Source/DetourNavMeshBuilder.cpp dtCreateNavMeshData
 */
export function dtCreateNavMeshData(
  params: dtNavMeshCreateParams,
  outData: { value: Uint8Array | null },
  outDataSize: { value: number },
): boolean {
  if (params.nvp > DT_VERTS_PER_POLYGON) return false;
  if (params.vertCount >= 0xffff) return false;
  if (!params.vertCount || !params.verts) return false;
  if (!params.polyCount || !params.polys) return false;

  const nvp = params.nvp;
  const pverts = params.verts;
  const ppolys = params.polys;
  // `float` members of the C++ struct.
  const cs = Math.fround(params.cs);
  const ch = Math.fround(params.ch);
  const walkableClimb = Math.fround(params.walkableClimb);

  // Classify off-mesh connection points. We store only the connections
  // whose start point is inside the tile.
  let offMeshConClass: Uint8Array | null = null;
  let storedOffMeshConCount = 0;
  let offMeshConLinkCount = 0;

  if (params.offMeshConCount > 0) {
    offMeshConClass = dtAlloc(params.offMeshConCount * 2, DT_ALLOC_TEMP);
    if (!offMeshConClass) return false;

    // Find tight heigh bounds, used for culling out off-mesh start locations.
    let hmin = 3.4028234663852886e38;
    let hmax = -3.4028234663852886e38;

    if (params.detailVerts && params.detailVertsCount) {
      for (let i = 0; i < params.detailVertsCount; ++i) {
        const h = params.detailVerts[i * 3 + 1]!;
        hmin = dtMin(hmin, h);
        hmax = dtMax(hmax, h);
      }
    } else {
      for (let i = 0; i < params.vertCount; ++i) {
        const h = Math.fround(params.bmin[1]! + Math.fround(pverts[i * 3 + 1]! * ch));
        hmin = dtMin(hmin, h);
        hmax = dtMax(hmax, h);
      }
    }
    hmin = Math.fround(hmin - walkableClimb);
    hmax = Math.fround(hmax + walkableClimb);
    const bmin = new Float32Array(3);
    const bmax = new Float32Array(3);
    dtVcopy(bmin, 0, params.bmin, 0);
    dtVcopy(bmax, 0, params.bmax, 0);
    bmin[1] = hmin;
    bmax[1] = hmax;

    const conVerts = params.offMeshConVerts!;
    for (let i = 0; i < params.offMeshConCount; ++i) {
      const p0 = (i * 2 + 0) * 3;
      const p1 = (i * 2 + 1) * 3;
      offMeshConClass[i * 2 + 0] = classifyOffMeshPoint(conVerts, p0, bmin, bmax);
      offMeshConClass[i * 2 + 1] = classifyOffMeshPoint(conVerts, p1, bmin, bmax);

      // Zero out off-mesh start positions which are not even potentially touching the mesh.
      if (offMeshConClass[i * 2 + 0] === 0xff) {
        if (conVerts[p0 + 1]! < bmin[1]! || conVerts[p0 + 1]! > bmax[1]!) offMeshConClass[i * 2 + 0] = 0;
      }

      // Cound how many links should be allocated for off-mesh connections.
      if (offMeshConClass[i * 2 + 0] === 0xff) offMeshConLinkCount++;
      if (offMeshConClass[i * 2 + 1] === 0xff) offMeshConLinkCount++;

      if (offMeshConClass[i * 2 + 0] === 0xff) storedOffMeshConCount++;
    }
  }

  // Off-mesh connectionss are stored as polygons, adjust values.
  const totPolyCount = params.polyCount + storedOffMeshConCount;
  const totVertCount = params.vertCount + storedOffMeshConCount * 2;

  // Find portal edges which are at tile borders.
  let edgeCount = 0;
  let portalCount = 0;
  for (let i = 0; i < params.polyCount; ++i) {
    const p = i * 2 * nvp;
    for (let j = 0; j < nvp; ++j) {
      if (ppolys[p + j] === MESH_NULL_IDX) break;
      edgeCount++;

      if (ppolys[p + nvp + j]! & 0x8000) {
        const dir = ppolys[p + nvp + j]! & 0xf;
        if (dir !== 0xf) portalCount++;
      }
    }
  }

  const maxLinkCount = edgeCount + portalCount * 2 + offMeshConLinkCount * 2;

  // Find unique detail vertices.
  let uniqueDetailVertCount = 0;
  let detailTriCount = 0;
  if (params.detailMeshes) {
    // Has detail mesh, count unique detail vertex count and use input detail tri count.
    detailTriCount = params.detailTriCount;
    for (let i = 0; i < params.polyCount; ++i) {
      const p = i * nvp * 2;
      let ndv = params.detailMeshes[i * 4 + 1]!;
      let nv = 0;
      for (let j = 0; j < nvp; ++j) {
        if (ppolys[p + j] === MESH_NULL_IDX) break;
        nv++;
      }
      ndv -= nv;
      uniqueDetailVertCount += ndv;
    }
  } else {
    // No input detail mesh, build detail mesh from nav polys.
    uniqueDetailVertCount = 0; // No extra detail verts.
    detailTriCount = 0;
    for (let i = 0; i < params.polyCount; ++i) {
      const p = i * nvp * 2;
      let nv = 0;
      for (let j = 0; j < nvp; ++j) {
        if (ppolys[p + j] === MESH_NULL_IDX) break;
        nv++;
      }
      detailTriCount += nv - 2;
    }
  }

  // Calculate data size
  const layout = new dtTileLayout();
  layout.headerSize = dtAlign4(DT_SIZEOF_MESH_HEADER);
  layout.vertsSize = dtAlign4(4 * 3 * totVertCount);
  layout.polysSize = dtAlign4(DT_SIZEOF_POLY * totPolyCount);
  layout.linksSize = dtAlign4(DT_SIZEOF_LINK * maxLinkCount);
  layout.detailMeshesSize = dtAlign4(DT_SIZEOF_POLY_DETAIL * params.polyCount);
  layout.detailVertsSize = dtAlign4(4 * 3 * uniqueDetailVertCount);
  layout.detailTrisSize = dtAlign4(1 * 4 * detailTriCount);
  layout.bvtreeSize = params.buildBvTree ? dtAlign4(DT_SIZEOF_BVNODE * params.polyCount * 2) : 0;
  layout.offMeshLinksSize = dtAlign4(DT_SIZEOF_OFFMESH_CONNECTION * storedOffMeshConCount);

  const dataSize = layout.dataSize;

  const data = dtAlloc(dataSize, DT_ALLOC_PERM);
  if (!data) {
    dtFree(offMeshConClass);
    return false;
  }
  data.fill(0);

  // The section pointers (header, navVerts, navPolys, links are skipped, navDMeshes, ...) are views of a scratch
  // tile over the new blob.
  const header = new dtMeshHeader(data.buffer, data.byteOffset);
  const t = new dtMeshTile();
  t.attachData(data, header, layout);
  const navVerts = t.verts;

  // Store header
  header.magic = DT_NAVMESH_MAGIC;
  header.version = DT_NAVMESH_VERSION;
  header.x = params.tileX;
  header.y = params.tileY;
  header.layer = params.tileLayer;
  header.userId = params.userId;
  header.polyCount = totPolyCount;
  header.vertCount = totVertCount;
  header.maxLinkCount = maxLinkCount;
  dtVcopy(header.bmin, 0, params.bmin, 0);
  dtVcopy(header.bmax, 0, params.bmax, 0);
  header.detailMeshCount = params.polyCount;
  header.detailVertCount = uniqueDetailVertCount;
  header.detailTriCount = detailTriCount;
  header.bvQuantFactor = 1.0 / cs;
  header.offMeshBase = params.polyCount;
  header.walkableHeight = params.walkableHeight;
  header.walkableRadius = params.walkableRadius;
  header.walkableClimb = params.walkableClimb;
  header.offMeshConCount = storedOffMeshConCount;
  header.bvNodeCount = params.buildBvTree ? params.polyCount * 2 : 0;

  const offMeshVertsBase = params.vertCount;
  const offMeshPolyBase = params.polyCount;

  // Store vertices
  // Mesh vertices
  for (let i = 0; i < params.vertCount; ++i) {
    const iv = i * 3;
    const v = i * 3;
    navVerts[v] = params.bmin[0]! + Math.fround(pverts[iv]! * cs);
    navVerts[v + 1] = params.bmin[1]! + Math.fround(pverts[iv + 1]! * ch);
    navVerts[v + 2] = params.bmin[2]! + Math.fround(pverts[iv + 2]! * cs);
  }
  // Off-mesh link vertices.
  let n = 0;
  for (let i = 0; i < params.offMeshConCount; ++i) {
    // Only store connections which start from this tile.
    if (offMeshConClass![i * 2 + 0] === 0xff) {
      const linkv = i * 2 * 3;
      const v = (offMeshVertsBase + n * 2) * 3;
      dtVcopy(navVerts, v, params.offMeshConVerts!, linkv);
      dtVcopy(navVerts, v + 3, params.offMeshConVerts!, linkv + 3);
      n++;
    }
  }

  // Store polygons
  // Mesh polys
  let src = 0;
  for (let i = 0; i < params.polyCount; ++i) {
    t.setPolyVertCount(i, 0);
    t.setPolyFlags(i, params.polyFlags![i]!);
    t.polySetArea(i, params.polyAreas![i]!);
    t.polySetType(i, DT_POLYTYPE_GROUND);
    for (let j = 0; j < nvp; ++j) {
      if (ppolys[src + j] === MESH_NULL_IDX) break;
      t.setPolyVerts(i, j, ppolys[src + j]!);
      const nei = ppolys[src + nvp + j]!;
      if (nei & 0x8000) {
        // Border or portal edge.
        const dir = nei & 0xf;
        if (dir === 0xf) // Border
          t.setPolyNeis(i, j, 0);
        else if (dir === 0) // Portal x-
          t.setPolyNeis(i, j, DT_EXT_LINK | 4);
        else if (dir === 1) // Portal z+
          t.setPolyNeis(i, j, DT_EXT_LINK | 2);
        else if (dir === 2) // Portal x+
          t.setPolyNeis(i, j, DT_EXT_LINK | 0);
        else if (dir === 3) // Portal z-
          t.setPolyNeis(i, j, DT_EXT_LINK | 6);
      } else {
        // Normal connection
        t.setPolyNeis(i, j, nei + 1);
      }

      t.setPolyVertCount(i, t.polyVertCount(i) + 1);
    }
    src += nvp * 2;
  }
  // Off-mesh connection vertices.
  n = 0;
  for (let i = 0; i < params.offMeshConCount; ++i) {
    // Only store connections which start from this tile.
    if (offMeshConClass![i * 2 + 0] === 0xff) {
      const p = offMeshPolyBase + n;
      t.setPolyVertCount(p, 2);
      t.setPolyVerts(p, 0, offMeshVertsBase + n * 2 + 0);
      t.setPolyVerts(p, 1, offMeshVertsBase + n * 2 + 1);
      t.setPolyFlags(p, params.offMeshConFlags![i]!);
      t.polySetArea(p, params.offMeshConAreas![i]!);
      t.polySetType(p, DT_POLYTYPE_OFFMESH_CONNECTION);
      n++;
    }
  }

  // Store detail meshes and vertices.
  // The nav polygon vertices are stored as the first vertices on each mesh.
  // We compress the mesh data by skipping them and using the navmesh coordinates.
  if (params.detailMeshes) {
    let vbase = 0;
    const navDVerts = t.detailVerts;
    for (let i = 0; i < params.polyCount; ++i) {
      const vb = params.detailMeshes[i * 4 + 0]!;
      const ndv = params.detailMeshes[i * 4 + 1]!;
      const nv = t.polyVertCount(i);
      t.setDetailVertBase(i, vbase);
      t.setDetailVertCount(i, (ndv - nv) & 0xff);
      t.setDetailTriBase(i, params.detailMeshes[i * 4 + 2]!);
      t.setDetailTriCount(i, params.detailMeshes[i * 4 + 3]! & 0xff);
      // Copy vertices except the first 'nv' verts which are equal to nav poly verts.
      if (ndv - nv) {
        navDVerts.set(params.detailVerts!.subarray((vb + nv) * 3, (vb + nv) * 3 + 3 * (ndv - nv)), vbase * 3);
        vbase = (vbase + (ndv - nv)) & 0xffff;
      }
    }
    // Store triangles.
    t.detailTris.set(params.detailTris!.subarray(0, 4 * params.detailTriCount));
  } else {
    // Create dummy detail mesh by triangulating polys.
    let tbase = 0;
    const navDTris = t.detailTris;
    for (let i = 0; i < params.polyCount; ++i) {
      const nv = t.polyVertCount(i);
      t.setDetailVertBase(i, 0);
      t.setDetailVertCount(i, 0);
      t.setDetailTriBase(i, tbase);
      t.setDetailTriCount(i, (nv - 2) & 0xff);
      // Triangulate polygon (local indices).
      for (let j = 2; j < nv; ++j) {
        const tt = tbase * 4;
        navDTris[tt] = 0;
        navDTris[tt + 1] = j - 1;
        navDTris[tt + 2] = j;
        // Bit for each edge that belongs to poly boundary.
        navDTris[tt + 3] = 1 << 2;
        if (j === 2) navDTris[tt + 3] = navDTris[tt + 3]! | (1 << 0);
        if (j === nv - 1) navDTris[tt + 3] = navDTris[tt + 3]! | (1 << 4);
        tbase++;
      }
    }
  }

  // Store and create BVtree.
  if (params.buildBvTree) {
    createBVTree(params, { nodes16: t.bvTree!, nodes32: t.bvTreeI32 }, 2 * params.polyCount);
  }

  // Store Off-Mesh connections.
  n = 0;
  for (let i = 0; i < params.offMeshConCount; ++i) {
    // Only store connections which start from this tile.
    if (offMeshConClass![i * 2 + 0] === 0xff) {
      const con = n;
      t.setOffMeshConPoly(con, offMeshPolyBase + n);
      // Copy connection end-points.
      const endPts = i * 2 * 3;
      dtVcopy(t.offMeshConsF32, t.offMeshConPos(con), params.offMeshConVerts!, endPts);
      dtVcopy(t.offMeshConsF32, t.offMeshConPos(con) + 3, params.offMeshConVerts!, endPts + 3);
      t.setOffMeshConRad(con, params.offMeshConRad![i]!);
      t.setOffMeshConFlags(con, params.offMeshConDir![i] ? DT_OFFMESH_CON_BIDIR : 0);
      t.setOffMeshConSide(con, offMeshConClass![i * 2 + 1]!);
      if (params.offMeshConUserID) t.setOffMeshConUserId(con, params.offMeshConUserID[i]!);
      n++;
    }
  }

  dtFree(offMeshConClass);

  outData.value = data;
  outDataSize.value = dataSize;

  return true;
}

const SWAPPED_MAGIC = swap32(DT_NAVMESH_MAGIC);
const SWAPPED_VERSION = swap32(DT_NAVMESH_VERSION);

function swap32(v: number): number {
  return (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) | 0;
}

/**
 * Swaps the endianess of the tile data's header (dtMeshHeader).
 * @ac deps/recastnavigation/Detour/Source/DetourNavMeshBuilder.cpp dtNavMeshHeaderSwapEndian
 */
export function dtNavMeshHeaderSwapEndian(data: Uint8Array, _dataSize: number): boolean {
  const view = new DataView(data.buffer, data.byteOffset, DT_SIZEOF_MESH_HEADER);
  const magic = view.getInt32(0, true);
  const version = view.getInt32(4, true);

  if ((magic !== DT_NAVMESH_MAGIC || version !== DT_NAVMESH_VERSION) && (magic !== SWAPPED_MAGIC || version !== SWAPPED_VERSION)) {
    return false;
  }

  // magic, version, x, y, layer, userId, polyCount, vertCount, maxLinkCount, detailMeshCount, detailVertCount,
  // detailTriCount, bvNodeCount, offMeshConCount, offMeshBase, walkableHeight, walkableRadius, walkableClimb,
  // bmin[3], bmax[3], bvQuantFactor: 25 four-byte fields.
  for (let i = 0; i < 25; ++i) dtSwapEndian(data, i * 4, 4);

  // Freelist index and pointers are updated when tile is added, no need to swap.

  return true;
}

/**
 * Swaps endianess of the tile data. The header must already be in native endianess.
 * @ac deps/recastnavigation/Detour/Source/DetourNavMeshBuilder.cpp dtNavMeshDataSwapEndian
 */
export function dtNavMeshDataSwapEndian(data: Uint8Array, _dataSize: number): boolean {
  // Make sure the data is in right format.
  const header = new dtMeshHeader(data.buffer, data.byteOffset);
  if (header.magic !== DT_NAVMESH_MAGIC) return false;
  if (header.version !== DT_NAVMESH_VERSION) return false;

  // Patch header pointers.
  const layout = dtTileLayout.fromHeader(header);

  let d = layout.headerSize;
  const verts = d;
  d += layout.vertsSize;
  const polys = d;
  d += layout.polysSize;
  d += layout.linksSize; // Ignore links; they technically should be endian-swapped but all their data is overwritten on load anyway.
  const detailMeshes = d;
  d += layout.detailMeshesSize;
  const detailVerts = d;
  d += layout.detailVertsSize;
  d += layout.detailTrisSize; // Ignore detail tris; single bytes can't be endian-swapped.
  const bvTree = d;
  d += layout.bvtreeSize;
  const offMeshCons = d;

  // Vertices
  for (let i = 0; i < header.vertCount * 3; ++i) dtSwapEndian(data, verts + i * 4, 4);

  // Polys
  for (let i = 0; i < header.polyCount; ++i) {
    const p = polys + i * DT_SIZEOF_POLY;
    // poly->firstLink is update when tile is added, no need to swap.
    for (let j = 0; j < DT_VERTS_PER_POLYGON; ++j) {
      dtSwapEndian(data, p + 4 + j * 2, 2);
      dtSwapEndian(data, p + 16 + j * 2, 2);
    }
    dtSwapEndian(data, p + 28, 2);
  }

  // Links are rebuild when tile is added, no need to swap.

  // Detail meshes
  for (let i = 0; i < header.detailMeshCount; ++i) {
    const pd = detailMeshes + i * DT_SIZEOF_POLY_DETAIL;
    dtSwapEndian(data, pd, 4);
    dtSwapEndian(data, pd + 4, 4);
  }

  // Detail verts
  for (let i = 0; i < header.detailVertCount * 3; ++i) dtSwapEndian(data, detailVerts + i * 4, 4);

  // BV-tree
  for (let i = 0; i < header.bvNodeCount; ++i) {
    const node = bvTree + i * DT_SIZEOF_BVNODE;
    for (let j = 0; j < 3; ++j) {
      dtSwapEndian(data, node + j * 2, 2);
      dtSwapEndian(data, node + 6 + j * 2, 2);
    }
    dtSwapEndian(data, node + 12, 4);
  }

  // Off-mesh Connections.
  for (let i = 0; i < header.offMeshConCount; ++i) {
    const con = offMeshCons + i * DT_SIZEOF_OFFMESH_CONNECTION;
    for (let j = 0; j < 6; ++j) dtSwapEndian(data, con + j * 4, 4);
    dtSwapEndian(data, con + 24, 4);
    dtSwapEndian(data, con + 28, 2);
  }

  return true;
}
