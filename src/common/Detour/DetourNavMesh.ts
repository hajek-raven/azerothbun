/**
 * Port of `deps/recastnavigation/Detour/Include/DetourNavMesh.h` and `Source/DetourNavMesh.cpp`, with the
 * AzerothCore changes from `recastnavigation.diff` (`DT_POLYREF64`, `DT_SALT_BITS` 12 / `DT_TILE_BITS` 21 /
 * `DT_POLY_BITS` 31) and `DT_SLOPE_TOO_STEEP` (in `DetourStatus.ts`).
 *
 * Tile data is the byte blob written by `dtCreateNavMeshData` (and stored after the 56-byte `MmapTileHeader` in a
 * `.mmtile`). It is never copied into objects: a `dtMeshTile` keeps typed-array views over each section of the blob,
 * at the byte layout of the 64-bit-polyref build (`sizeof(dtPoly)` 32, `sizeof(dtLink)` 16, ...). A `dtPoly*` is the
 * polygon index inside its tile (`poly - tile->polys`), read through the `dtMeshTile.poly*` accessors.
 *
 * `dtPolyRef` is a JavaScript number instead of a `uint64`. The salt and tile fields keep AzerothCore's 12 and 21
 * bits; the poly field gets the remaining 20 bits so a ref stays an exact integer below 2^53. AzerothCore tiles have
 * fewer than 0xffff vertices (`MapBuilder` rejects more), so they hold far fewer than 2^20 polygons; `addTile`
 * rejects a tile that would not fit. `DT_POLY_BITS` itself stays 31 because `MapBuilder` writes
 * `1 << DT_POLY_BITS` into `dtNavMeshParams::maxPolys`.
 */
import { dtFree } from "./DetourAlloc.ts";
import { dtAssert } from "./DetourAssert.ts";
import {
  dtAbs,
  dtAlign4,
  dtClamp,
  dtClosestHeightPointTriangle,
  dtDistancePtSegSqr2D,
  dtMax,
  dtMin,
  dtNextPow2,
  dtOppositeTile,
  dtOverlapBounds,
  dtOverlapQuantBounds,
  dtPointInPolygon,
  dtSqr,
  dtVadd,
  dtVcopy,
  dtVlenSqr,
  dtVlerp,
  dtVmax,
  dtVmin,
  dtVsub,
} from "./DetourCommon.ts";
import { dtMathFloorf } from "./DetourMath.ts";
import {
  DT_ALREADY_OCCUPIED,
  DT_BUFFER_TOO_SMALL,
  DT_FAILURE,
  DT_INVALID_PARAM,
  DT_OUT_OF_MEMORY,
  DT_SUCCESS,
  DT_WRONG_MAGIC,
  DT_WRONG_VERSION,
  type dtStatus,
  dtStatusFailed,
} from "./DetourStatus.ts";

/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h DT_SALT_BITS */
export const DT_SALT_BITS = 12;
/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h DT_TILE_BITS */
export const DT_TILE_BITS = 21;
/** AzerothCore value; used by `MapBuilder` for `dtNavMeshParams::maxPolys`. @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h DT_POLY_BITS */
export const DT_POLY_BITS = 31;

/** Bits of the poly field inside a JavaScript `dtPolyRef` (53 - salt - tile bits). */
export const DT_REF_POLY_BITS = 53 - DT_SALT_BITS - DT_TILE_BITS;
const DT_REF_POLY_MUL = 2 ** DT_REF_POLY_BITS;
const DT_REF_TILE_MUL = 2 ** DT_TILE_BITS;
const DT_REF_SALT_MUL = 2 ** (DT_REF_POLY_BITS + DT_TILE_BITS);
const DT_REF_SALT_MASK = 2 ** DT_SALT_BITS;

/** A handle to a polygon within a navigation mesh tile (an exact integer below 2^53). @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtPolyRef */
export type dtPolyRef = number;
/** A handle to a tile within a navigation mesh. @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtTileRef */
export type dtTileRef = number;

/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h DT_VERTS_PER_POLYGON */
export const DT_VERTS_PER_POLYGON = 6;
/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h DT_NAVMESH_MAGIC */
export const DT_NAVMESH_MAGIC = (0x44 << 24) | (0x4e << 16) | (0x41 << 8) | 0x56; // 'DNAV'
/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h DT_NAVMESH_VERSION */
export const DT_NAVMESH_VERSION = 7;
/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h DT_NAVMESH_STATE_MAGIC */
export const DT_NAVMESH_STATE_MAGIC = (0x44 << 24) | (0x4e << 16) | (0x4d << 8) | 0x53; // 'DNMS'
/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h DT_NAVMESH_STATE_VERSION */
export const DT_NAVMESH_STATE_VERSION = 1;
/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h DT_EXT_LINK */
export const DT_EXT_LINK = 0x8000;
/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h DT_NULL_LINK */
export const DT_NULL_LINK = 0xffffffff;
/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h DT_OFFMESH_CON_BIDIR */
export const DT_OFFMESH_CON_BIDIR = 1;
/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h DT_MAX_AREAS */
export const DT_MAX_AREAS = 64;

/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtTileFlags */
export const dtTileFlags = {
  /** The navigation mesh owns the tile memory and is responsible for freeing it. */
  DT_TILE_FREE_DATA: 0x01,
} as const;
export const DT_TILE_FREE_DATA = dtTileFlags.DT_TILE_FREE_DATA;

/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtStraightPathFlags */
export const dtStraightPathFlags = {
  /** The vertex is the start position in the path. */
  DT_STRAIGHTPATH_START: 0x01,
  /** The vertex is the end position in the path. */
  DT_STRAIGHTPATH_END: 0x02,
  /** The vertex is the start of an off-mesh connection. */
  DT_STRAIGHTPATH_OFFMESH_CONNECTION: 0x04,
} as const;
export const DT_STRAIGHTPATH_START = dtStraightPathFlags.DT_STRAIGHTPATH_START;
export const DT_STRAIGHTPATH_END = dtStraightPathFlags.DT_STRAIGHTPATH_END;
export const DT_STRAIGHTPATH_OFFMESH_CONNECTION = dtStraightPathFlags.DT_STRAIGHTPATH_OFFMESH_CONNECTION;

/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtStraightPathOptions */
export const dtStraightPathOptions = {
  /** Add a vertex at every polygon edge crossing where area changes. */
  DT_STRAIGHTPATH_AREA_CROSSINGS: 0x01,
  /** Add a vertex at every polygon edge crossing. */
  DT_STRAIGHTPATH_ALL_CROSSINGS: 0x02,
} as const;
export const DT_STRAIGHTPATH_AREA_CROSSINGS = dtStraightPathOptions.DT_STRAIGHTPATH_AREA_CROSSINGS;
export const DT_STRAIGHTPATH_ALL_CROSSINGS = dtStraightPathOptions.DT_STRAIGHTPATH_ALL_CROSSINGS;

/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtFindPathOptions */
export const dtFindPathOptions = {
  /** use raycasts during pathfind to "shortcut" (raycast still consider costs) */
  DT_FINDPATH_ANY_ANGLE: 0x02,
} as const;
export const DT_FINDPATH_ANY_ANGLE = dtFindPathOptions.DT_FINDPATH_ANY_ANGLE;

/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtRaycastOptions */
export const dtRaycastOptions = {
  /** Raycast should calculate movement cost along the ray and fill RaycastHit::cost */
  DT_RAYCAST_USE_COSTS: 0x01,
} as const;
export const DT_RAYCAST_USE_COSTS = dtRaycastOptions.DT_RAYCAST_USE_COSTS;

/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtDetailTriEdgeFlags */
export const dtDetailTriEdgeFlags = {
  /** Detail triangle edge is part of the poly boundary */
  DT_DETAIL_EDGE_BOUNDARY: 0x01,
} as const;
export const DT_DETAIL_EDGE_BOUNDARY = dtDetailTriEdgeFlags.DT_DETAIL_EDGE_BOUNDARY;

/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h DT_RAY_CAST_LIMIT_PROPORTIONS */
export const DT_RAY_CAST_LIMIT_PROPORTIONS = 50.0;

/** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtPolyTypes */
export const dtPolyTypes = {
  /** The polygon is a standard convex polygon that is part of the surface of the mesh. */
  DT_POLYTYPE_GROUND: 0,
  /** The polygon is an off-mesh connection consisting of two vertices. */
  DT_POLYTYPE_OFFMESH_CONNECTION: 1,
} as const;
export const DT_POLYTYPE_GROUND = dtPolyTypes.DT_POLYTYPE_GROUND;
export const DT_POLYTYPE_OFFMESH_CONNECTION = dtPolyTypes.DT_POLYTYPE_OFFMESH_CONNECTION;

// Byte layout of the tile structs in the 64-bit-polyref build (the layout of the `.mmtile` payload).

/** `sizeof(dtMeshHeader)`: 15 x int32, 3 floats, bmin[3], bmax[3], bvQuantFactor. */
export const DT_SIZEOF_MESH_HEADER = 100;
/** `sizeof(dtPoly)`: firstLink u32, verts[6] u16, neis[6] u16, flags u16, vertCount u8, areaAndtype u8. */
export const DT_SIZEOF_POLY = 32;
/** `sizeof(dtLink)` with a 64-bit `dtPolyRef`: ref u64, next u32, edge, side, bmin, bmax u8. */
export const DT_SIZEOF_LINK = 16;
/** `sizeof(dtPolyDetail)`: vertBase u32, triBase u32, vertCount u8, triCount u8, 2 bytes padding. */
export const DT_SIZEOF_POLY_DETAIL = 12;
/** `sizeof(dtBVNode)`: bmin[3] u16, bmax[3] u16, i int32. */
export const DT_SIZEOF_BVNODE = 16;
/** `sizeof(dtOffMeshConnection)`: pos[6] float, rad float, poly u16, flags u8, side u8, userId u32. */
export const DT_SIZEOF_OFFMESH_CONNECTION = 36;
/** `sizeof(dtNavMeshParams)`: orig[3], tileWidth, tileHeight float, maxTiles, maxPolys int32. */
export const DT_SIZEOF_NAVMESH_PARAMS = 28;

/**
 * @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtGetDetailTriEdgeFlags
 */
export function dtGetDetailTriEdgeFlags(triFlags: number, edgeIndex: number): number {
  return (triFlags >> (edgeIndex * 2)) & 0x3;
}

const EMPTY_F32 = new Float32Array(0);
const EMPTY_U32 = new Uint32Array(0);
const EMPTY_U16 = new Uint16Array(0);
const EMPTY_U8 = new Uint8Array(0);
const EMPTY_I32 = new Int32Array(0);

/**
 * Provides high level information related to a dtMeshTile object, read in place from the first 100 bytes of the
 * tile data.
 * @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtMeshHeader
 */
export class dtMeshHeader {
  private readonly i32: Int32Array;
  private readonly u32: Uint32Array;
  private readonly f32: Float32Array;
  /** The minimum bounds of the tile's AABB. [(x, y, z)] */
  readonly bmin: Float32Array;
  /** The maximum bounds of the tile's AABB. [(x, y, z)] */
  readonly bmax: Float32Array;

  constructor(buffer: ArrayBufferLike, byteOffset: number) {
    this.i32 = new Int32Array(buffer, byteOffset, 25);
    this.u32 = new Uint32Array(buffer, byteOffset, 25);
    this.f32 = new Float32Array(buffer, byteOffset, 25);
    this.bmin = this.f32.subarray(18, 21);
    this.bmax = this.f32.subarray(21, 24);
  }

  /** Tile magic number. (Used to identify the data format.) */
  get magic(): number { return this.i32[0]!; }
  set magic(v: number) { this.i32[0] = v; }
  /** Tile data format version number. */
  get version(): number { return this.i32[1]!; }
  set version(v: number) { this.i32[1] = v; }
  /** The x-position of the tile within the dtNavMesh tile grid. (x, y, layer) */
  get x(): number { return this.i32[2]!; }
  set x(v: number) { this.i32[2] = v; }
  /** The y-position of the tile within the dtNavMesh tile grid. (x, y, layer) */
  get y(): number { return this.i32[3]!; }
  set y(v: number) { this.i32[3] = v; }
  /** The layer of the tile within the dtNavMesh tile grid. (x, y, layer) */
  get layer(): number { return this.i32[4]!; }
  set layer(v: number) { this.i32[4] = v; }
  /** The user defined id of the tile. */
  get userId(): number { return this.u32[5]!; }
  set userId(v: number) { this.u32[5] = v; }
  /** The number of polygons in the tile. */
  get polyCount(): number { return this.i32[6]!; }
  set polyCount(v: number) { this.i32[6] = v; }
  /** The number of vertices in the tile. */
  get vertCount(): number { return this.i32[7]!; }
  set vertCount(v: number) { this.i32[7] = v; }
  /** The number of allocated links. */
  get maxLinkCount(): number { return this.i32[8]!; }
  set maxLinkCount(v: number) { this.i32[8] = v; }
  /** The number of sub-meshes in the detail mesh. */
  get detailMeshCount(): number { return this.i32[9]!; }
  set detailMeshCount(v: number) { this.i32[9] = v; }
  /** The number of unique vertices in the detail mesh. (In addition to the polygon vertices.) */
  get detailVertCount(): number { return this.i32[10]!; }
  set detailVertCount(v: number) { this.i32[10] = v; }
  /** The number of triangles in the detail mesh. */
  get detailTriCount(): number { return this.i32[11]!; }
  set detailTriCount(v: number) { this.i32[11] = v; }
  /** The number of bounding volume nodes. (Zero if bounding volumes are disabled.) */
  get bvNodeCount(): number { return this.i32[12]!; }
  set bvNodeCount(v: number) { this.i32[12] = v; }
  /** The number of off-mesh connections. */
  get offMeshConCount(): number { return this.i32[13]!; }
  set offMeshConCount(v: number) { this.i32[13] = v; }
  /** The index of the first polygon which is an off-mesh connection. */
  get offMeshBase(): number { return this.i32[14]!; }
  set offMeshBase(v: number) { this.i32[14] = v; }
  /** The height of the agents using the tile. */
  get walkableHeight(): number { return this.f32[15]!; }
  set walkableHeight(v: number) { this.f32[15] = v; }
  /** The radius of the agents using the tile. */
  get walkableRadius(): number { return this.f32[16]!; }
  set walkableRadius(v: number) { this.f32[16] = v; }
  /** The maximum climb height of the agents using the tile. */
  get walkableClimb(): number { return this.f32[17]!; }
  set walkableClimb(v: number) { this.f32[17] = v; }
  /** The bounding volume quantization factor. */
  get bvQuantFactor(): number { return this.f32[24]!; }
  set bvQuantFactor(v: number) { this.f32[24] = v; }
}

/** Byte offsets of the tile sections, computed like `addTile` / `dtCreateNavMeshData` do. */
export class dtTileLayout {
  headerSize = 0;
  vertsSize = 0;
  polysSize = 0;
  linksSize = 0;
  detailMeshesSize = 0;
  detailVertsSize = 0;
  detailTrisSize = 0;
  bvtreeSize = 0;
  offMeshLinksSize = 0;

  /** The `dtAlign4(sizeof(...) * count)` block of `dtNavMesh::addTile`. */
  static fromHeader(header: dtMeshHeader, out = new dtTileLayout()): dtTileLayout {
    out.headerSize = dtAlign4(DT_SIZEOF_MESH_HEADER);
    out.vertsSize = dtAlign4(4 * 3 * header.vertCount);
    out.polysSize = dtAlign4(DT_SIZEOF_POLY * header.polyCount);
    out.linksSize = dtAlign4(DT_SIZEOF_LINK * header.maxLinkCount);
    out.detailMeshesSize = dtAlign4(DT_SIZEOF_POLY_DETAIL * header.detailMeshCount);
    out.detailVertsSize = dtAlign4(4 * 3 * header.detailVertCount);
    out.detailTrisSize = dtAlign4(1 * 4 * header.detailTriCount);
    out.bvtreeSize = dtAlign4(DT_SIZEOF_BVNODE * header.bvNodeCount);
    out.offMeshLinksSize = dtAlign4(DT_SIZEOF_OFFMESH_CONNECTION * header.offMeshConCount);
    return out;
  }

  get dataSize(): number {
    return (
      this.headerSize +
      this.vertsSize +
      this.polysSize +
      this.linksSize +
      this.detailMeshesSize +
      this.detailVertsSize +
      this.detailTrisSize +
      this.bvtreeSize +
      this.offMeshLinksSize
    );
  }
}

/**
 * Defines a navigation mesh tile. The section pointers of the C++ struct are typed-array views over `data`;
 * the `poly*`, `link*`, `detail*`, `bvNode*` and `offMeshCon*` accessors read the struct fields in place.
 * @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtMeshTile
 */
export class dtMeshTile {
  /** Counter describing modifications to the tile. */
  salt = 0;
  /** Index to the next free link. */
  linksFreeList = 0;
  /** The tile header. */
  header: dtMeshHeader | null = null;
  /** The tile vertices. [(x, y, z) * dtMeshHeader::vertCount] */
  verts: Float32Array = EMPTY_F32;
  /** `dtPoly` array viewed as uint32 (stride 8): firstLink. */
  polysU32: Uint32Array = EMPTY_U32;
  /** `dtPoly` array viewed as uint16 (stride 16): verts at +2, neis at +8, flags at +14. */
  polysU16: Uint16Array = EMPTY_U16;
  /** `dtPoly` array viewed as bytes (stride 32): vertCount at +30, areaAndtype at +31. */
  polysU8: Uint8Array = EMPTY_U8;
  /** `dtLink` array viewed as uint32 (stride 4): ref low/high words, next. */
  linksU32: Uint32Array = EMPTY_U32;
  /** `dtLink` array viewed as bytes (stride 16): edge +12, side +13, bmin +14, bmax +15. */
  linksU8: Uint8Array = EMPTY_U8;
  /** `dtPolyDetail` array viewed as uint32 (stride 3): vertBase, triBase. */
  detailMeshesU32: Uint32Array = EMPTY_U32;
  /** `dtPolyDetail` array viewed as bytes (stride 12): vertCount +8, triCount +9. */
  detailMeshesU8: Uint8Array = EMPTY_U8;
  /** The detail mesh's unique vertices. [(x, y, z) * dtMeshHeader::detailVertCount] */
  detailVerts: Float32Array = EMPTY_F32;
  /** The detail mesh's triangles. [(vertA, vertB, vertC, triFlags) * dtMeshHeader::detailTriCount] */
  detailTris: Uint8Array = EMPTY_U8;
  /** The tile bounding volume nodes viewed as uint16 (stride 8): bmin[3], bmax[3]; null when the tile has none. */
  bvTree: Uint16Array | null = null;
  /** `dtBVNode` array viewed as int32 (stride 4): i at +3. */
  bvTreeI32: Int32Array = EMPTY_I32;
  /** `dtOffMeshConnection` array viewed as floats (stride 9): pos[6], rad. */
  offMeshConsF32: Float32Array = EMPTY_F32;
  /** `dtOffMeshConnection` array viewed as uint16 (stride 18): poly at +14. */
  offMeshConsU16: Uint16Array = EMPTY_U16;
  /** `dtOffMeshConnection` array viewed as bytes (stride 36): flags +30, side +31. */
  offMeshConsU8: Uint8Array = EMPTY_U8;
  /** `dtOffMeshConnection` array viewed as uint32 (stride 9): userId at +8. */
  offMeshConsU32: Uint32Array = EMPTY_U32;
  /** The tile data. (Not directly accessed under normal situations.) */
  data: Uint8Array | null = null;
  /** Size of the tile data. */
  dataSize = 0;
  /** Tile flags. (See: #dtTileFlags) */
  flags = 0;
  /** The next free tile, or the next tile in the spatial grid. */
  next: dtMeshTile | null = null;
  /** Position of the tile in `dtNavMesh::m_tiles` (the C++ `tile - m_tiles`). */
  readonly index: number;

  constructor(index = 0) {
    this.index = index;
  }

  /**
   * Points the section views at `data` (the pointer patching block of `dtNavMesh::addTile`, also used by
   * `dtCreateNavMeshData` to fill a new blob). `data.byteOffset` must be a multiple of 4.
   */
  attachData(data: Uint8Array, header: dtMeshHeader, layout: dtTileLayout): void {
    const buf = data.buffer;
    let d = data.byteOffset + layout.headerSize;
    this.verts = new Float32Array(buf, d, layout.vertsSize >> 2);
    d += layout.vertsSize;
    this.polysU32 = new Uint32Array(buf, d, layout.polysSize >> 2);
    this.polysU16 = new Uint16Array(buf, d, layout.polysSize >> 1);
    this.polysU8 = new Uint8Array(buf, d, layout.polysSize);
    d += layout.polysSize;
    this.linksU32 = new Uint32Array(buf, d, layout.linksSize >> 2);
    this.linksU8 = new Uint8Array(buf, d, layout.linksSize);
    d += layout.linksSize;
    this.detailMeshesU32 = new Uint32Array(buf, d, layout.detailMeshesSize >> 2);
    this.detailMeshesU8 = new Uint8Array(buf, d, layout.detailMeshesSize);
    d += layout.detailMeshesSize;
    this.detailVerts = new Float32Array(buf, d, layout.detailVertsSize >> 2);
    d += layout.detailVertsSize;
    this.detailTris = new Uint8Array(buf, d, layout.detailTrisSize);
    d += layout.detailTrisSize;
    this.bvTree = new Uint16Array(buf, d, layout.bvtreeSize >> 1);
    this.bvTreeI32 = new Int32Array(buf, d, layout.bvtreeSize >> 2);
    d += layout.bvtreeSize;
    this.offMeshConsF32 = new Float32Array(buf, d, layout.offMeshLinksSize >> 2);
    this.offMeshConsU16 = new Uint16Array(buf, d, layout.offMeshLinksSize >> 1);
    this.offMeshConsU8 = new Uint8Array(buf, d, layout.offMeshLinksSize);
    this.offMeshConsU32 = new Uint32Array(buf, d, layout.offMeshLinksSize >> 2);
    this.header = header;
  }

  /** Resets the section views (the pointer reset block of `dtNavMesh::removeTile`). */
  detachData(): void {
    this.header = null;
    this.verts = EMPTY_F32;
    this.polysU32 = EMPTY_U32;
    this.polysU16 = EMPTY_U16;
    this.polysU8 = EMPTY_U8;
    this.linksU32 = EMPTY_U32;
    this.linksU8 = EMPTY_U8;
    this.detailMeshesU32 = EMPTY_U32;
    this.detailMeshesU8 = EMPTY_U8;
    this.detailVerts = EMPTY_F32;
    this.detailTris = EMPTY_U8;
    this.bvTree = null;
    this.bvTreeI32 = EMPTY_I32;
    this.offMeshConsF32 = EMPTY_F32;
    this.offMeshConsU16 = EMPTY_U16;
    this.offMeshConsU8 = EMPTY_U8;
    this.offMeshConsU32 = EMPTY_U32;
  }

  // dtPoly fields (`tile->polys[ip].field`).

  /** `dtPoly::firstLink` */
  polyFirstLink(ip: number): number { return this.polysU32[ip * 8]!; }
  setPolyFirstLink(ip: number, v: number): void { this.polysU32[ip * 8] = v; }
  /** `dtPoly::verts[j]`: index into `verts` (multiply by 3 for the float offset). */
  polyVerts(ip: number, j: number): number { return this.polysU16[ip * 16 + 2 + j]!; }
  setPolyVerts(ip: number, j: number, v: number): void { this.polysU16[ip * 16 + 2 + j] = v; }
  /** Offset into `polysU16` of `dtPoly::verts` (a `const unsigned short*` to the poly's vertex indices). */
  polyVertsOffset(ip: number): number { return ip * 16 + 2; }
  /** `dtPoly::neis[j]` */
  polyNeis(ip: number, j: number): number { return this.polysU16[ip * 16 + 8 + j]!; }
  setPolyNeis(ip: number, j: number, v: number): void { this.polysU16[ip * 16 + 8 + j] = v; }
  /** `dtPoly::flags` */
  polyFlags(ip: number): number { return this.polysU16[ip * 16 + 14]!; }
  setPolyFlags(ip: number, v: number): void { this.polysU16[ip * 16 + 14] = v; }
  /** `dtPoly::vertCount` */
  polyVertCount(ip: number): number { return this.polysU8[ip * 32 + 30]!; }
  setPolyVertCount(ip: number, v: number): void { this.polysU8[ip * 32 + 30] = v; }
  /** `dtPoly::areaAndtype` */
  polyAreaAndtype(ip: number): number { return this.polysU8[ip * 32 + 31]!; }
  /** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtPoly::setArea */
  polySetArea(ip: number, a: number): void {
    const o = ip * 32 + 31;
    this.polysU8[o] = (this.polysU8[o]! & 0xc0) | (a & 0x3f);
  }
  /** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtPoly::setType */
  polySetType(ip: number, t: number): void {
    const o = ip * 32 + 31;
    this.polysU8[o] = (this.polysU8[o]! & 0x3f) | (t << 6);
  }
  /** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtPoly::getArea */
  polyGetArea(ip: number): number { return this.polysU8[ip * 32 + 31]! & 0x3f; }
  /** @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtPoly::getType */
  polyGetType(ip: number): number { return this.polysU8[ip * 32 + 31]! >> 6; }

  // dtLink fields (`tile->links[i].field`).

  /** `dtLink::ref` (stored as the low and high 32-bit words of the 8-byte field). */
  linkRef(i: number): dtPolyRef {
    const b = i * 4;
    return this.linksU32[b + 1]! * 4294967296 + this.linksU32[b]!;
  }
  setLinkRef(i: number, ref: dtPolyRef): void {
    const b = i * 4;
    this.linksU32[b] = ref >>> 0;
    this.linksU32[b + 1] = Math.floor(ref / 4294967296);
  }
  /** `dtLink::next` */
  linkNext(i: number): number { return this.linksU32[i * 4 + 2]!; }
  setLinkNext(i: number, v: number): void { this.linksU32[i * 4 + 2] = v; }
  /** `dtLink::edge` */
  linkEdge(i: number): number { return this.linksU8[i * 16 + 12]!; }
  setLinkEdge(i: number, v: number): void { this.linksU8[i * 16 + 12] = v; }
  /** `dtLink::side` */
  linkSide(i: number): number { return this.linksU8[i * 16 + 13]!; }
  setLinkSide(i: number, v: number): void { this.linksU8[i * 16 + 13] = v; }
  /** `dtLink::bmin` */
  linkBmin(i: number): number { return this.linksU8[i * 16 + 14]!; }
  setLinkBmin(i: number, v: number): void { this.linksU8[i * 16 + 14] = v; }
  /** `dtLink::bmax` */
  linkBmax(i: number): number { return this.linksU8[i * 16 + 15]!; }
  setLinkBmax(i: number, v: number): void { this.linksU8[i * 16 + 15] = v; }

  // dtPolyDetail fields (`tile->detailMeshes[i].field`).

  /** `dtPolyDetail::vertBase` */
  detailVertBase(i: number): number { return this.detailMeshesU32[i * 3]!; }
  setDetailVertBase(i: number, v: number): void { this.detailMeshesU32[i * 3] = v; }
  /** `dtPolyDetail::triBase` */
  detailTriBase(i: number): number { return this.detailMeshesU32[i * 3 + 1]!; }
  setDetailTriBase(i: number, v: number): void { this.detailMeshesU32[i * 3 + 1] = v; }
  /** `dtPolyDetail::vertCount` */
  detailVertCount(i: number): number { return this.detailMeshesU8[i * 12 + 8]!; }
  setDetailVertCount(i: number, v: number): void { this.detailMeshesU8[i * 12 + 8] = v; }
  /** `dtPolyDetail::triCount` */
  detailTriCount(i: number): number { return this.detailMeshesU8[i * 12 + 9]!; }
  setDetailTriCount(i: number, v: number): void { this.detailMeshesU8[i * 12 + 9] = v; }

  // dtBVNode fields (`tile->bvTree[i].field`); bmin at `bvTree[i * 8]`, bmax at `bvTree[i * 8 + 3]`.

  /** `dtBVNode::i` */
  bvNodeI(i: number): number { return this.bvTreeI32[i * 4 + 3]!; }
  setBvNodeI(i: number, v: number): void { this.bvTreeI32[i * 4 + 3] = v; }

  // dtOffMeshConnection fields (`tile->offMeshCons[i].field`); pos at `offMeshConsF32[i * 9]`.

  /** Offset of `dtOffMeshConnection::pos` in `offMeshConsF32`. */
  offMeshConPos(i: number): number { return i * 9; }
  /** `dtOffMeshConnection::rad` */
  offMeshConRad(i: number): number { return this.offMeshConsF32[i * 9 + 6]!; }
  setOffMeshConRad(i: number, v: number): void { this.offMeshConsF32[i * 9 + 6] = v; }
  /** `dtOffMeshConnection::poly` */
  offMeshConPoly(i: number): number { return this.offMeshConsU16[i * 18 + 14]!; }
  setOffMeshConPoly(i: number, v: number): void { this.offMeshConsU16[i * 18 + 14] = v; }
  /** `dtOffMeshConnection::flags` */
  offMeshConFlags(i: number): number { return this.offMeshConsU8[i * 36 + 30]!; }
  setOffMeshConFlags(i: number, v: number): void { this.offMeshConsU8[i * 36 + 30] = v; }
  /** `dtOffMeshConnection::side` */
  offMeshConSide(i: number): number { return this.offMeshConsU8[i * 36 + 31]!; }
  setOffMeshConSide(i: number, v: number): void { this.offMeshConsU8[i * 36 + 31] = v; }
  /** `dtOffMeshConnection::userId` */
  offMeshConUserId(i: number): number { return this.offMeshConsU32[i * 9 + 8]!; }
  setOffMeshConUserId(i: number, v: number): void { this.offMeshConsU32[i * 9 + 8] = v; }
}

/**
 * Defines an navigation mesh off-mesh connection within a dtMeshTile object (a view of
 * `tile->offMeshCons[index]`, returned by `dtNavMesh::getOffMeshConnectionByRef`).
 * @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtOffMeshConnection
 */
export class dtOffMeshConnection {
  constructor(
    readonly tile: dtMeshTile,
    readonly index: number,
  ) {}
  /** The endpoints of the connection. [(ax, ay, az, bx, by, bz)] */
  get pos(): Float32Array { return this.tile.offMeshConsF32.subarray(this.index * 9, this.index * 9 + 6); }
  /** The radius of the endpoints. [Limit: >= 0] */
  get rad(): number { return this.tile.offMeshConRad(this.index); }
  /** The polygon reference of the connection within the tile. */
  get poly(): number { return this.tile.offMeshConPoly(this.index); }
  /** Link flags. */
  get flags(): number { return this.tile.offMeshConFlags(this.index); }
  /** End point side. */
  get side(): number { return this.tile.offMeshConSide(this.index); }
  /** The id of the offmesh connection. (User assigned when the navigation mesh is built.) */
  get userId(): number { return this.tile.offMeshConUserId(this.index); }
}

/**
 * Configuration parameters used to define multi-tile navigation meshes (the 28 bytes of a `.mmap` file).
 * @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtNavMeshParams
 */
export class dtNavMeshParams {
  /** The world space origin of the navigation mesh's tile space. [(x, y, z)] */
  orig = new Float32Array(3);
  /** The width of each tile. (Along the x-axis.) */
  tileWidth = 0;
  /** The height of each tile. (Along the z-axis.) */
  tileHeight = 0;
  /** The maximum number of tiles the navigation mesh can contain. */
  maxTiles = 0;
  /** The maximum number of polygons each tile can contain. */
  maxPolys = 0;

  /** `memcpy(&dst, &src, sizeof(dtNavMeshParams))` */
  copyFrom(other: dtNavMeshParams): this {
    this.orig.set(other.orig);
    this.tileWidth = other.tileWidth;
    this.tileHeight = other.tileHeight;
    this.maxTiles = other.maxTiles;
    this.maxPolys = other.maxPolys;
    return this;
  }

  /** `fread(&params, sizeof(dtNavMeshParams), 1, file)` over little-endian bytes. */
  static fromBytes(bytes: Uint8Array, offset = 0): dtNavMeshParams {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, DT_SIZEOF_NAVMESH_PARAMS);
    const p = new dtNavMeshParams();
    p.orig[0] = view.getFloat32(0, true);
    p.orig[1] = view.getFloat32(4, true);
    p.orig[2] = view.getFloat32(8, true);
    p.tileWidth = view.getFloat32(12, true);
    p.tileHeight = view.getFloat32(16, true);
    p.maxTiles = view.getInt32(20, true);
    p.maxPolys = view.getInt32(24, true);
    return p;
  }

  /** `fwrite(&params, sizeof(dtNavMeshParams), 1, file)`: the 28 little-endian bytes of the struct. */
  toBytes(): Uint8Array {
    const bytes = new Uint8Array(DT_SIZEOF_NAVMESH_PARAMS);
    const view = new DataView(bytes.buffer);
    view.setFloat32(0, this.orig[0]!, true);
    view.setFloat32(4, this.orig[1]!, true);
    view.setFloat32(8, this.orig[2]!, true);
    view.setFloat32(12, this.tileWidth, true);
    view.setFloat32(16, this.tileHeight, true);
    view.setInt32(20, this.maxTiles, true);
    view.setInt32(24, this.maxPolys, true);
    return bytes;
  }
}

/** The `const dtMeshTile** tile, const dtPoly** poly` output pair of `getTileAndPolyByRef`. */
export class dtTileAndPoly {
  tile: dtMeshTile | null = null;
  /** Polygon index in `tile` (`poly - tile->polys`), -1 for none. */
  poly = -1;
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp overlapSlabs */
function overlapSlabs(amin: Float32Array, amax: Float32Array, bmin: Float32Array, bmax: Float32Array, px: number, py: number): boolean {
  // Check for horizontal overlap.
  // The segment is shrunken a little so that slabs which touch
  // at end points are not connected.
  const minx = dtMax(amin[0]! + px, bmin[0]! + px);
  const maxx = dtMin(amax[0]! - px, bmax[0]! - px);
  if (minx > maxx) return false;

  // Check vertical overlap.
  const ad = (amax[1]! - amin[1]!) / (amax[0]! - amin[0]!);
  const ak = amin[1]! - ad * amin[0]!;
  const bd = (bmax[1]! - bmin[1]!) / (bmax[0]! - bmin[0]!);
  const bk = bmin[1]! - bd * bmin[0]!;
  const aminy = ad * minx + ak;
  const amaxy = ad * maxx + ak;
  const bminy = bd * minx + bk;
  const bmaxy = bd * maxx + bk;
  const dmin = bminy - aminy;
  const dmax = bmaxy - amaxy;

  // Crossing segments always overlap.
  if (dmin * dmax < 0) return true;

  // Check for overlap at endpoints.
  const thr = dtSqr(py * 2);
  if (dmin * dmin <= thr || dmax * dmax <= thr) return true;

  return false;
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp getSlabCoord */
function getSlabCoord(va: Float32Array, vai: number, side: number): number {
  if (side === 0 || side === 4) return va[vai]!;
  else if (side === 2 || side === 6) return va[vai + 2]!;
  return 0;
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp calcSlabEndPoints */
function calcSlabEndPoints(va: Float32Array, vai: number, vb: Float32Array, vbi: number, bmin: Float32Array, bmax: Float32Array, side: number): void {
  if (side === 0 || side === 4) {
    if (va[vai + 2]! < vb[vbi + 2]!) {
      bmin[0] = va[vai + 2]!;
      bmin[1] = va[vai + 1]!;
      bmax[0] = vb[vbi + 2]!;
      bmax[1] = vb[vbi + 1]!;
    } else {
      bmin[0] = vb[vbi + 2]!;
      bmin[1] = vb[vbi + 1]!;
      bmax[0] = va[vai + 2]!;
      bmax[1] = va[vai + 1]!;
    }
  } else if (side === 2 || side === 6) {
    if (va[vai]! < vb[vbi]!) {
      bmin[0] = va[vai]!;
      bmin[1] = va[vai + 1]!;
      bmax[0] = vb[vbi]!;
      bmax[1] = vb[vbi + 1]!;
    } else {
      bmin[0] = vb[vbi]!;
      bmin[1] = vb[vbi + 1]!;
      bmax[0] = va[vai]!;
      bmax[1] = va[vai + 1]!;
    }
  }
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp computeTileHash */
function computeTileHash(x: number, y: number, mask: number): number {
  const h1 = 0x8da6b343; // Large multiplicative constants;
  const h2 = 0xd8163841; // here arbitrarily chosen primes
  const n = (Math.imul(h1, x) + Math.imul(h2, y)) >>> 0;
  return n & mask;
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp allocLink */
function allocLink(tile: dtMeshTile): number {
  if (tile.linksFreeList === DT_NULL_LINK) return DT_NULL_LINK;
  const link = tile.linksFreeList;
  tile.linksFreeList = tile.linkNext(link);
  return link;
}

/** @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp freeLink */
function freeLink(tile: dtMeshTile, link: number): void {
  tile.setLinkNext(link, tile.linksFreeList);
  tile.linksFreeList = link;
}

/**
 * Allocates a navigation mesh object using the Detour allocator.
 * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtAllocNavMesh
 */
export function dtAllocNavMesh(): dtNavMesh {
  return new dtNavMesh();
}

/**
 * Frees the specified navigation mesh object. Only tiles with `DT_TILE_FREE_DATA` release their data.
 * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtFreeNavMesh
 */
export function dtFreeNavMesh(navmesh: dtNavMesh | null): void {
  if (!navmesh) return;
  navmesh.destroy();
}

const MAX_NEIS = 32;

// Scratch buffers of dtNavMesh (single threaded; each function owns its own).
const fcp_amin = new Float32Array(2);
const fcp_amax = new Float32Array(2);
const fcp_bmin = new Float32Array(2);
const fcp_bmax = new Float32Array(2);
const cel_nei = new Float64Array(4);
const cel_neia = new Float32Array(4 * 2);
const ceo_halfExtents = new Float32Array(3);
const ceo_nearestPt = new Float32Array(3);
const bol_halfExtents = new Float32Array(3);
const bol_nearestPt = new Float32Array(3);
const cpde_t = new Float32Array(1);
const gph_verts = new Float32Array(DT_VERTS_PER_POLYGON * 3);
const gph_closest = new Float32Array(3);
const cpop_t = new Float32Array(1);
const fnp_bmin = new Float32Array(3);
const fnp_bmax = new Float32Array(3);
const fnp_polys = new Float64Array(128);
const fnp_closestPtPoly = new Float32Array(3);
const fnp_diff = new Float32Array(3);
const fnp_posOverPoly = { value: false };
const qpt_bmin = new Uint16Array(3);
const qpt_bmax = new Uint16Array(3);
const qpt_fbmin = new Float32Array(3);
const qpt_fbmax = new Float32Array(3);
const tap_scratch = new dtTileAndPoly();

/**
 * Finds the closest point on the detail-mesh edges of `poly` (the `closestPointOnDetailEdges<onlyBoundary>`
 * template).
 * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp closestPointOnDetailEdges
 */
function closestPointOnDetailEdges(onlyBoundary: boolean, tile: dtMeshTile, poly: number, pos: Float32Array, posi: number, closest: Float32Array, ci: number): void {
  const ip = poly;
  const pd = ip;

  let dmin = Number.MAX_VALUE;
  let tmin = 0;
  let pminArr: Float32Array | null = null;
  let pmin = 0;
  let pmaxArr: Float32Array | null = null;
  let pmax = 0;

  const triCount = tile.detailTriCount(pd);
  const triBase = tile.detailTriBase(pd);
  const vertBase = tile.detailVertBase(pd);
  const vertCount = tile.polyVertCount(poly);
  const ANY_BOUNDARY_EDGE = (DT_DETAIL_EDGE_BOUNDARY << 0) | (DT_DETAIL_EDGE_BOUNDARY << 2) | (DT_DETAIL_EDGE_BOUNDARY << 4);
  const vArr: Float32Array[] = cpde_vArr;
  const vOff = cpde_vOff;

  for (let i = 0; i < triCount; i++) {
    const tris = (triBase + i) * 4;
    const triFlags = tile.detailTris[tris + 3]!;
    if (onlyBoundary && (triFlags & ANY_BOUNDARY_EDGE) === 0) continue;

    for (let j = 0; j < 3; ++j) {
      const tj = tile.detailTris[tris + j]!;
      if (tj < vertCount) {
        vArr[j] = tile.verts;
        vOff[j] = tile.polyVerts(poly, tj) * 3;
      } else {
        vArr[j] = tile.detailVerts;
        vOff[j] = (vertBase + (tj - vertCount)) * 3;
      }
    }

    for (let k = 0, j = 2; k < 3; j = k++) {
      if (
        (dtGetDetailTriEdgeFlags(triFlags, j) & DT_DETAIL_EDGE_BOUNDARY) === 0 &&
        (onlyBoundary || tile.detailTris[tris + j]! < tile.detailTris[tris + k]!)
      ) {
        // Only looking at boundary edges and this is internal, or
        // this is an inner edge that we will see again or have already seen.
        continue;
      }

      const d = dtDistancePtSegSqr2D(pos, posi, vArr[j]!, vOff[j]!, vArr[k]!, vOff[k]!, cpde_t, 0);
      if (d < dmin) {
        dmin = d;
        tmin = cpde_t[0]!;
        pminArr = vArr[j]!;
        pmin = vOff[j]!;
        pmaxArr = vArr[k]!;
        pmax = vOff[k]!;
      }
    }
  }

  dtVlerp(closest, ci, pminArr!, pmin, pmaxArr!, pmax, tmin);
}
const cpde_vArr: Float32Array[] = [EMPTY_F32, EMPTY_F32, EMPTY_F32];
const cpde_vOff = new Int32Array(3);
const gph_vArr: Float32Array[] = [EMPTY_F32, EMPTY_F32, EMPTY_F32];
const gph_vOff = new Int32Array(3);

/**
 * A navigation mesh based on tiles of convex polygons.
 * @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtNavMesh
 */
export class dtNavMesh {
  /** Current initialization params. TODO: do not store this info twice. */
  m_params = new dtNavMeshParams();
  /** Origin of the tile (0,0) */
  m_orig = new Float32Array(3);
  /** Dimensions of each tile. */
  m_tileWidth = 0;
  m_tileHeight = 0;
  /** Max number of tiles. */
  m_maxTiles = 0;
  /** Tile hash lookup size (must be pot). */
  m_tileLutSize = 0;
  /** Tile hash lookup mask. */
  m_tileLutMask = 0;
  /** Tile hash lookup. */
  m_posLookup: (dtMeshTile | null)[] = [];
  /** Freelist of tiles. */
  m_nextFree: dtMeshTile | null = null;
  /** List of tiles. */
  m_tiles: dtMeshTile[] = [];

  /** @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::dtNavMesh */
  constructor() {}

  /**
   * The destructor: frees the data of tiles that own it (`DT_TILE_FREE_DATA`).
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::~dtNavMesh
   */
  destroy(): void {
    for (let i = 0; i < this.m_maxTiles; ++i) {
      const tile = this.m_tiles[i]!;
      if (tile.flags & DT_TILE_FREE_DATA) {
        dtFree(tile.data);
        tile.data = null;
        tile.dataSize = 0;
      }
    }
    this.m_posLookup = [];
    this.m_tiles = [];
    this.m_maxTiles = 0;
    this.m_nextFree = null;
  }

  /**
   * Initializes the navigation mesh for tiled use, or (data overload) for single tile use.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::init
   */
  init(params: dtNavMeshParams): dtStatus;
  init(data: Uint8Array, dataSize: number, flags: number): dtStatus;
  init(paramsOrData: dtNavMeshParams | Uint8Array, dataSize = 0, flags = 0): dtStatus {
    if (paramsOrData instanceof Uint8Array) return this.initSingleTile(paramsOrData, dataSize, flags);
    const params = paramsOrData;
    this.m_params.copyFrom(params);
    dtVcopy(this.m_orig, 0, params.orig, 0);
    this.m_tileWidth = params.tileWidth;
    this.m_tileHeight = params.tileHeight;

    // Init tiles
    this.m_maxTiles = params.maxTiles;
    this.m_tileLutSize = dtNextPow2(Math.trunc(params.maxTiles / 4));
    if (!this.m_tileLutSize) this.m_tileLutSize = 1;
    this.m_tileLutMask = this.m_tileLutSize - 1;

    if (this.m_maxTiles < 0) return DT_FAILURE | DT_OUT_OF_MEMORY;
    this.m_tiles = new Array<dtMeshTile>(this.m_maxTiles);
    this.m_posLookup = new Array<dtMeshTile | null>(this.m_tileLutSize).fill(null);
    for (let i = 0; i < this.m_maxTiles; ++i) this.m_tiles[i] = new dtMeshTile(i);
    this.m_nextFree = null;
    for (let i = this.m_maxTiles - 1; i >= 0; --i) {
      const tile = this.m_tiles[i]!;
      tile.salt = 1;
      tile.next = this.m_nextFree;
      this.m_nextFree = tile;
    }

    // Init ID generator values. (DT_POLYREF64: the bit counts are the DT_*_BITS constants.)

    return DT_SUCCESS;
  }

  /** The `init(unsigned char* data, const int dataSize, const int flags)` overload. */
  private initSingleTile(data: Uint8Array, dataSize: number, flags: number): dtStatus {
    // Make sure the data is in right format.
    const header = new dtMeshHeader(data.buffer, data.byteOffset);
    if (header.magic !== DT_NAVMESH_MAGIC) return DT_FAILURE | DT_WRONG_MAGIC;
    if (header.version !== DT_NAVMESH_VERSION) return DT_FAILURE | DT_WRONG_VERSION;

    const params = new dtNavMeshParams();
    dtVcopy(params.orig, 0, header.bmin, 0);
    params.tileWidth = header.bmax[0]! - header.bmin[0]!;
    params.tileHeight = header.bmax[2]! - header.bmin[2]!;
    params.maxTiles = 1;
    params.maxPolys = header.polyCount;

    const status = this.init(params);
    if (dtStatusFailed(status)) return status;

    return this.addTile(data, dataSize, flags, 0, null);
  }

  /**
   * The navigation mesh initialization params.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getParams
   */
  getParams(): dtNavMeshParams {
    return this.m_params;
  }

  /**
   * Returns all polygons in neighbour tile based on portal defined by the segment.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::findConnectingPolys
   */
  findConnectingPolys(
    va: Float32Array,
    vai: number,
    vb: Float32Array,
    vbi: number,
    tile: dtMeshTile | null,
    side: number,
    con: Float64Array,
    conarea: Float32Array,
    maxcon: number,
  ): number {
    if (!tile) return 0;
    const header = tile.header!;

    const amin = fcp_amin;
    const amax = fcp_amax;
    calcSlabEndPoints(va, vai, vb, vbi, amin, amax, side);
    const apos = getSlabCoord(va, vai, side);

    // Remove links pointing to 'side' and compact the links array.
    const bmin = fcp_bmin;
    const bmax = fcp_bmax;
    const m = DT_EXT_LINK | side;
    let n = 0;

    const base = this.getPolyRefBase(tile);

    for (let i = 0; i < header.polyCount; ++i) {
      const nv = tile.polyVertCount(i);
      for (let j = 0; j < nv; ++j) {
        // Skip edges which do not point to the right side.
        if (tile.polyNeis(i, j) !== m) continue;

        const vc = tile.polyVerts(i, j) * 3;
        const vd = tile.polyVerts(i, (j + 1) % nv) * 3;
        const bpos = getSlabCoord(tile.verts, vc, side);

        // Segments are not close enough.
        if (dtAbs(apos - bpos) > 0.01) continue;

        // Check if the segments touch.
        calcSlabEndPoints(tile.verts, vc, tile.verts, vd, bmin, bmax, side);

        if (!overlapSlabs(amin, amax, bmin, bmax, 0.01, header.walkableClimb)) continue;

        // Add return value.
        if (n < maxcon) {
          conarea[n * 2 + 0] = dtMax(amin[0]!, bmin[0]!);
          conarea[n * 2 + 1] = dtMin(amax[0]!, bmax[0]!);
          con[n] = base + i;
          n++;
        }
        break;
      }
    }
    return n;
  }

  /**
   * Removes external links at specified side.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::unconnectLinks
   */
  unconnectLinks(tile: dtMeshTile | null, target: dtMeshTile | null): void {
    if (!tile || !target) return;

    const targetNum = this.decodePolyIdTile(this.getTileRef(target));

    for (let i = 0; i < tile.header!.polyCount; ++i) {
      let j = tile.polyFirstLink(i);
      let pj = DT_NULL_LINK;
      while (j !== DT_NULL_LINK) {
        if (this.decodePolyIdTile(tile.linkRef(j)) === targetNum) {
          // Remove link.
          const nj = tile.linkNext(j);
          if (pj === DT_NULL_LINK) tile.setPolyFirstLink(i, nj);
          else tile.setLinkNext(pj, nj);
          freeLink(tile, j);
          j = nj;
        } else {
          // Advance
          pj = j;
          j = tile.linkNext(j);
        }
      }
    }
  }

  /**
   * Builds external polygon links for a tile.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::connectExtLinks
   */
  connectExtLinks(tile: dtMeshTile | null, target: dtMeshTile, side: number): void {
    if (!tile) return;

    // Connect border links.
    for (let i = 0; i < tile.header!.polyCount; ++i) {
      // Create new links.
      //		unsigned short m = DT_EXT_LINK | (unsigned short)side;

      const nv = tile.polyVertCount(i);
      for (let j = 0; j < nv; ++j) {
        // Skip non-portal edges.
        const neis = tile.polyNeis(i, j);
        if ((neis & DT_EXT_LINK) === 0) continue;

        const dir = neis & 0xff;
        if (side !== -1 && dir !== side) continue;

        // Create new links
        const va = tile.polyVerts(i, j) * 3;
        const vb = tile.polyVerts(i, (j + 1) % nv) * 3;
        const nei = cel_nei;
        const neia = cel_neia;
        const nnei = this.findConnectingPolys(tile.verts, va, tile.verts, vb, target, dtOppositeTile(dir), nei, neia, 4);
        for (let k = 0; k < nnei; ++k) {
          const idx = allocLink(tile);
          if (idx !== DT_NULL_LINK) {
            tile.setLinkRef(idx, nei[k]!);
            tile.setLinkEdge(idx, j);
            tile.setLinkSide(idx, dir);

            tile.setLinkNext(idx, tile.polyFirstLink(i));
            tile.setPolyFirstLink(i, idx);

            // Compress portal limits to a byte value.
            const verts = tile.verts;
            if (dir === 0 || dir === 4) {
              let tmin = Math.fround((neia[k * 2 + 0]! - verts[va + 2]!) / (verts[vb + 2]! - verts[va + 2]!));
              let tmax = Math.fround((neia[k * 2 + 1]! - verts[va + 2]!) / (verts[vb + 2]! - verts[va + 2]!));
              if (tmin > tmax) {
                const t = tmin;
                tmin = tmax;
                tmax = t;
              }
              tile.setLinkBmin(idx, Math.trunc(Math.fround(dtClamp(tmin, 0.0, 1.0) * 255.0)));
              tile.setLinkBmax(idx, Math.trunc(Math.fround(dtClamp(tmax, 0.0, 1.0) * 255.0)));
            } else if (dir === 2 || dir === 6) {
              let tmin = Math.fround((neia[k * 2 + 0]! - verts[va]!) / (verts[vb]! - verts[va]!));
              let tmax = Math.fround((neia[k * 2 + 1]! - verts[va]!) / (verts[vb]! - verts[va]!));
              if (tmin > tmax) {
                const t = tmin;
                tmin = tmax;
                tmax = t;
              }
              tile.setLinkBmin(idx, Math.trunc(Math.fround(dtClamp(tmin, 0.0, 1.0) * 255.0)));
              tile.setLinkBmax(idx, Math.trunc(Math.fround(dtClamp(tmax, 0.0, 1.0) * 255.0)));
            }
          }
        }
      }
    }
  }

  /**
   * Builds external polygon links for a tile.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::connectExtOffMeshLinks
   */
  connectExtOffMeshLinks(tile: dtMeshTile | null, target: dtMeshTile, side: number): void {
    if (!tile) return;

    // Connect off-mesh links.
    // We are interested on links which land from target tile to this tile.
    const oppositeSide = side === -1 ? 0xff : dtOppositeTile(side);
    const targetHeader = target.header!;

    for (let i = 0; i < targetHeader.offMeshConCount; ++i) {
      if (target.offMeshConSide(i) !== oppositeSide) continue;

      const targetPoly = target.offMeshConPoly(i);
      // Skip off-mesh connections which start location could not be connected at all.
      if (target.polyFirstLink(targetPoly) === DT_NULL_LINK) continue;

      const rad = target.offMeshConRad(i);
      const halfExtents = ceo_halfExtents;
      halfExtents[0] = rad;
      halfExtents[1] = targetHeader.walkableClimb;
      halfExtents[2] = rad;

      // Find polygon to connect to.
      const p = target.offMeshConPos(i) + 3;
      const pArr = target.offMeshConsF32;
      const nearestPt = ceo_nearestPt;
      const ref = this.findNearestPolyInTile(tile, pArr, p, halfExtents, nearestPt);
      if (!ref) continue;
      // findNearestPoly may return too optimistic results, further check to make sure.
      if (dtSqr(nearestPt[0]! - pArr[p]!) + dtSqr(nearestPt[2]! - pArr[p + 2]!) > dtSqr(rad)) continue;
      // Make sure the location is on current mesh.
      dtVcopy(target.verts, target.polyVerts(targetPoly, 1) * 3, nearestPt, 0);

      // Link off-mesh connection to target poly.
      const idx = allocLink(target);
      if (idx !== DT_NULL_LINK) {
        target.setLinkRef(idx, ref);
        target.setLinkEdge(idx, 1);
        target.setLinkSide(idx, oppositeSide);
        target.setLinkBmin(idx, 0);
        target.setLinkBmax(idx, 0);
        // Add to linked list.
        target.setLinkNext(idx, target.polyFirstLink(targetPoly));
        target.setPolyFirstLink(targetPoly, idx);
      }

      // Link target poly to off-mesh connection.
      if (target.offMeshConFlags(i) & DT_OFFMESH_CON_BIDIR) {
        const tidx = allocLink(tile);
        if (tidx !== DT_NULL_LINK) {
          const landPolyIdx = this.decodePolyIdPoly(ref) & 0xffff;
          tile.setLinkRef(tidx, this.getPolyRefBase(target) + targetPoly);
          tile.setLinkEdge(tidx, 0xff);
          tile.setLinkSide(tidx, side === -1 ? 0xff : side);
          tile.setLinkBmin(tidx, 0);
          tile.setLinkBmax(tidx, 0);
          // Add to linked list.
          tile.setLinkNext(tidx, tile.polyFirstLink(landPolyIdx));
          tile.setPolyFirstLink(landPolyIdx, tidx);
        }
      }
    }
  }

  /**
   * Builds internal polygons links for a tile.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::connectIntLinks
   */
  connectIntLinks(tile: dtMeshTile | null): void {
    if (!tile) return;

    const base = this.getPolyRefBase(tile);

    for (let i = 0; i < tile.header!.polyCount; ++i) {
      tile.setPolyFirstLink(i, DT_NULL_LINK);

      if (tile.polyGetType(i) === DT_POLYTYPE_OFFMESH_CONNECTION) continue;

      // Build edge links backwards so that the links will be
      // in the linked list from lowest index to highest.
      for (let j = tile.polyVertCount(i) - 1; j >= 0; --j) {
        // Skip hard and non-internal edges.
        const nei = tile.polyNeis(i, j);
        if (nei === 0 || nei & DT_EXT_LINK) continue;

        const idx = allocLink(tile);
        if (idx !== DT_NULL_LINK) {
          tile.setLinkRef(idx, base + (nei - 1));
          tile.setLinkEdge(idx, j);
          tile.setLinkSide(idx, 0xff);
          tile.setLinkBmin(idx, 0);
          tile.setLinkBmax(idx, 0);
          // Add to linked list.
          tile.setLinkNext(idx, tile.polyFirstLink(i));
          tile.setPolyFirstLink(i, idx);
        }
      }
    }
  }

  /**
   * Builds internal polygons links for a tile.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::baseOffMeshLinks
   */
  baseOffMeshLinks(tile: dtMeshTile | null): void {
    if (!tile) return;

    const base = this.getPolyRefBase(tile);
    const header = tile.header!;

    // Base off-mesh connection start points.
    for (let i = 0; i < header.offMeshConCount; ++i) {
      const poly = tile.offMeshConPoly(i);
      const rad = tile.offMeshConRad(i);

      const halfExtents = bol_halfExtents;
      halfExtents[0] = rad;
      halfExtents[1] = header.walkableClimb;
      halfExtents[2] = rad;

      // Find polygon to connect to.
      const p = tile.offMeshConPos(i); // First vertex
      const pArr = tile.offMeshConsF32;
      const nearestPt = bol_nearestPt;
      const ref = this.findNearestPolyInTile(tile, pArr, p, halfExtents, nearestPt);
      if (!ref) continue;
      // findNearestPoly may return too optimistic results, further check to make sure.
      if (dtSqr(nearestPt[0]! - pArr[p]!) + dtSqr(nearestPt[2]! - pArr[p + 2]!) > dtSqr(rad)) continue;
      // Make sure the location is on current mesh.
      dtVcopy(tile.verts, tile.polyVerts(poly, 0) * 3, nearestPt, 0);

      // Link off-mesh connection to target poly.
      const idx = allocLink(tile);
      if (idx !== DT_NULL_LINK) {
        tile.setLinkRef(idx, ref);
        tile.setLinkEdge(idx, 0);
        tile.setLinkSide(idx, 0xff);
        tile.setLinkBmin(idx, 0);
        tile.setLinkBmax(idx, 0);
        // Add to linked list.
        tile.setLinkNext(idx, tile.polyFirstLink(poly));
        tile.setPolyFirstLink(poly, idx);
      }

      // Start end-point is always connect back to off-mesh connection.
      const tidx = allocLink(tile);
      if (tidx !== DT_NULL_LINK) {
        const landPolyIdx = this.decodePolyIdPoly(ref) & 0xffff;
        tile.setLinkRef(tidx, base + poly);
        tile.setLinkEdge(tidx, 0xff);
        tile.setLinkSide(tidx, 0xff);
        tile.setLinkBmin(tidx, 0);
        tile.setLinkBmax(tidx, 0);
        // Add to linked list.
        tile.setLinkNext(tidx, tile.polyFirstLink(landPolyIdx));
        tile.setPolyFirstLink(landPolyIdx, tidx);
      }
    }
  }

  /**
   * Returns whether `pos` is over the poly and writes the detail-mesh height to `height[hi]` when `height` is set.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getPolyHeight
   */
  getPolyHeight(tile: dtMeshTile, poly: number, pos: Float32Array, posi: number, height: Float32Array | null, hi: number): boolean {
    // Off-mesh connections do not have detail polys and getting height
    // over them does not make sense.
    if (tile.polyGetType(poly) === DT_POLYTYPE_OFFMESH_CONNECTION) return false;

    const ip = poly;
    const pd = ip;

    const verts = gph_verts;
    const nv = tile.polyVertCount(poly);
    for (let i = 0; i < nv; ++i) dtVcopy(verts, i * 3, tile.verts, tile.polyVerts(poly, i) * 3);

    if (!dtPointInPolygon(pos, posi, verts, nv)) return false;

    if (!height) return true;

    // Find height at the location.
    const triCount = tile.detailTriCount(pd);
    const triBase = tile.detailTriBase(pd);
    const vertBase = tile.detailVertBase(pd);
    const vArr = gph_vArr;
    const vOff = gph_vOff;
    for (let j = 0; j < triCount; ++j) {
      const t = (triBase + j) * 4;
      for (let k = 0; k < 3; ++k) {
        const tk = tile.detailTris[t + k]!;
        if (tk < nv) {
          vArr[k] = tile.verts;
          vOff[k] = tile.polyVerts(poly, tk) * 3;
        } else {
          vArr[k] = tile.detailVerts;
          vOff[k] = (vertBase + (tk - nv)) * 3;
        }
      }
      if (dtClosestHeightPointTriangle(pos, posi, vArr[0]!, vOff[0]!, vArr[1]!, vOff[1]!, vArr[2]!, vOff[2]!, height, hi)) return true;
    }

    // If all triangle checks failed above (can happen with degenerate triangles
    // or larger floating point values) the point is on an edge, so just select
    // closest. This should almost never happen so the extra iteration here is
    // ok.
    const closest = gph_closest;
    closestPointOnDetailEdges(false, tile, poly, pos, posi, closest, 0);
    height[hi] = closest[1]!;
    return true;
  }

  /**
   * Find nearest point on polygon.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::closestPointOnPoly
   */
  closestPointOnPoly(ref: dtPolyRef, pos: Float32Array, posi: number, closest: Float32Array, ci: number, posOverPoly: { value: boolean } | null): void {
    this.getTileAndPolyByRefUnsafe(ref, tap_scratch);
    const tile = tap_scratch.tile!;
    const poly = tap_scratch.poly;

    dtVcopy(closest, ci, pos, posi);
    if (this.getPolyHeight(tile, poly, pos, posi, closest, ci + 1)) {
      if (posOverPoly) posOverPoly.value = true;
      return;
    }

    if (posOverPoly) posOverPoly.value = false;

    // Off-mesh connections don't have detail polygons.
    if (tile.polyGetType(poly) === DT_POLYTYPE_OFFMESH_CONNECTION) {
      const v0 = tile.polyVerts(poly, 0) * 3;
      const v1 = tile.polyVerts(poly, 1) * 3;
      dtDistancePtSegSqr2D(pos, posi, tile.verts, v0, tile.verts, v1, cpop_t, 0);
      dtVlerp(closest, ci, tile.verts, v0, tile.verts, v1, cpop_t[0]!);
      return;
    }

    // Outside poly that is not an offmesh connection.
    closestPointOnDetailEdges(true, tile, poly, pos, posi, closest, ci);
  }

  /**
   * Find nearest polygon within a tile.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::findNearestPolyInTile
   */
  findNearestPolyInTile(tile: dtMeshTile, center: Float32Array, centeri: number, halfExtents: Float32Array, nearestPt: Float32Array): dtPolyRef {
    const bmin = fnp_bmin;
    const bmax = fnp_bmax;
    dtVsub(bmin, 0, center, centeri, halfExtents, 0);
    dtVadd(bmax, 0, center, centeri, halfExtents, 0);

    // Get nearby polygons from proximity grid.
    const polys = fnp_polys;
    const polyCount = this.queryPolygonsInTile(tile, bmin, bmax, polys, 128);

    // Find nearest polygon amongst the nearby polygons.
    let nearest: dtPolyRef = 0;
    let nearestDistanceSqr = Number.MAX_VALUE;
    const walkableClimb = tile.header!.walkableClimb;
    for (let i = 0; i < polyCount; ++i) {
      const ref = polys[i]!;
      const closestPtPoly = fnp_closestPtPoly;
      const diff = fnp_diff;
      const posOverPoly = fnp_posOverPoly;
      posOverPoly.value = false;
      let d: number;
      this.closestPointOnPoly(ref, center, centeri, closestPtPoly, 0, posOverPoly);

      // If a point is directly over a polygon and closer than
      // climb height, favor that instead of straight line nearest point.
      dtVsub(diff, 0, center, centeri, closestPtPoly, 0);
      if (posOverPoly.value) {
        d = dtAbs(diff[1]!) - walkableClimb;
        d = d > 0 ? d * d : 0;
      } else {
        d = dtVlenSqr(diff, 0);
      }

      if (d < nearestDistanceSqr) {
        dtVcopy(nearestPt, 0, closestPtPoly, 0);
        nearestDistanceSqr = d;
        nearest = ref;
      }
    }

    return nearest;
  }

  /**
   * Queries polygons within a tile.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::queryPolygonsInTile
   */
  queryPolygonsInTile(tile: dtMeshTile, qmin: Float32Array, qmax: Float32Array, polys: Float64Array, maxPolys: number): number {
    const header = tile.header!;
    if (tile.bvTree) {
      const bvTree = tile.bvTree;
      let node = 0;
      const end = header.bvNodeCount;
      const tbmin = header.bmin;
      const tbmax = header.bmax;
      const qfac = header.bvQuantFactor;

      // Calculate quantized box
      const bmin = qpt_bmin;
      const bmax = qpt_bmax;
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
      const base = this.getPolyRefBase(tile);
      let n = 0;
      while (node < end) {
        const overlap = dtOverlapQuantBounds(bmin, 0, bmax, 0, bvTree, node * 8, bvTree, node * 8 + 3);
        const nodeI = tile.bvNodeI(node);
        const isLeafNode = nodeI >= 0;

        if (isLeafNode && overlap) {
          if (n < maxPolys) polys[n++] = base + nodeI;
        }

        if (overlap || isLeafNode) node++;
        else {
          const escapeIndex = -nodeI;
          node += escapeIndex;
        }
      }

      return n;
    } else {
      const bmin = qpt_fbmin;
      const bmax = qpt_fbmax;
      let n = 0;
      const base = this.getPolyRefBase(tile);
      for (let i = 0; i < header.polyCount; ++i) {
        // Do not return off-mesh connection polygons.
        if (tile.polyGetType(i) === DT_POLYTYPE_OFFMESH_CONNECTION) continue;
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
          if (n < maxPolys) polys[n++] = base + i;
        }
      }
      return n;
    }
  }

  /**
   * Adds a tile to the navigation mesh. The nav mesh keeps (and patches) the views over `data`; `data` must stay
   * untouched by other meshes until the tile is removed.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::addTile
   */
  addTile(data: Uint8Array, dataSize: number, flags: number, lastRef: dtTileRef, result: Float64Array | null): dtStatus {
    // Typed-array views need 4-byte alignment; a dtAlloc'd C++ block always has it.
    if (data.byteOffset & 3) data = data.slice(0, dataSize);

    // Make sure the data is in right format.
    const header = new dtMeshHeader(data.buffer, data.byteOffset);
    if (header.magic !== DT_NAVMESH_MAGIC) return DT_FAILURE | DT_WRONG_MAGIC;
    if (header.version !== DT_NAVMESH_VERSION) return DT_FAILURE | DT_WRONG_VERSION;
    // A JavaScript dtPolyRef has DT_REF_POLY_BITS for the polygon index (see the file comment).
    if (header.polyCount > DT_REF_POLY_MUL) return DT_FAILURE | DT_INVALID_PARAM;

    // Make sure the location is free.
    if (this.getTileAt(header.x, header.y, header.layer)) return DT_FAILURE | DT_ALREADY_OCCUPIED;

    // Allocate a tile.
    let tile: dtMeshTile | null = null;
    if (!lastRef) {
      if (this.m_nextFree) {
        tile = this.m_nextFree;
        this.m_nextFree = tile.next;
        tile.next = null;
      }
    } else {
      // Try to relocate the tile to specific index with same salt.
      const tileIndex = this.decodePolyIdTile(lastRef);
      if (tileIndex >= this.m_maxTiles) return DT_FAILURE | DT_OUT_OF_MEMORY;
      // Try to find the specific tile id from the free list.
      const target = this.m_tiles[tileIndex]!;
      let prev: dtMeshTile | null = null;
      tile = this.m_nextFree;
      while (tile && tile !== target) {
        prev = tile;
        tile = tile.next;
      }
      // Could not find the correct location.
      if (tile !== target) return DT_FAILURE | DT_OUT_OF_MEMORY;
      // Remove from freelist
      if (!prev) this.m_nextFree = tile.next;
      else prev.next = tile.next;

      // Restore salt.
      tile.salt = this.decodePolyIdSalt(lastRef);
    }

    // Make sure we could allocate a tile.
    if (!tile) return DT_FAILURE | DT_OUT_OF_MEMORY;

    // Insert tile into the position lut.
    const h = computeTileHash(header.x, header.y, this.m_tileLutMask);
    tile.next = this.m_posLookup[h]!;
    this.m_posLookup[h] = tile;

    // Patch header pointers.
    const layout = dtTileLayout.fromHeader(header);
    tile.attachData(data, header, layout);

    // If there are no items in the bvtree, reset the tree pointer.
    if (!layout.bvtreeSize) tile.bvTree = null;

    // Build links freelist
    tile.linksFreeList = 0;
    tile.setLinkNext(header.maxLinkCount - 1, DT_NULL_LINK);
    for (let i = 0; i < header.maxLinkCount - 1; ++i) tile.setLinkNext(i, i + 1);

    // Init tile.
    tile.header = header;
    tile.data = data;
    tile.dataSize = dataSize;
    tile.flags = flags;

    this.connectIntLinks(tile);

    // Base off-mesh connections to their starting polygons and connect connections inside the tile.
    this.baseOffMeshLinks(tile);
    this.connectExtOffMeshLinks(tile, tile, -1);

    // Create connections with neighbour tiles.
    const neis = addTile_neis;
    let nneis: number;

    // Connect with layers in current tile.
    nneis = this.getTilesAt(header.x, header.y, neis, MAX_NEIS);
    for (let j = 0; j < nneis; ++j) {
      const nei = neis[j]!;
      if (nei === tile) continue;

      this.connectExtLinks(tile, nei, -1);
      this.connectExtLinks(nei, tile, -1);
      this.connectExtOffMeshLinks(tile, nei, -1);
      this.connectExtOffMeshLinks(nei, tile, -1);
    }

    // Connect with neighbour tiles.
    for (let i = 0; i < 8; ++i) {
      nneis = this.getNeighbourTilesAt(header.x, header.y, i, neis, MAX_NEIS);
      for (let j = 0; j < nneis; ++j) {
        const nei = neis[j]!;
        this.connectExtLinks(tile, nei, i);
        this.connectExtLinks(nei, tile, dtOppositeTile(i));
        this.connectExtOffMeshLinks(tile, nei, i);
        this.connectExtOffMeshLinks(nei, tile, dtOppositeTile(i));
      }
    }

    if (result) result[0] = this.getTileRef(tile);

    return DT_SUCCESS;
  }

  /**
   * Gets the tile at the specified grid location.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getTileAt
   */
  getTileAt(x: number, y: number, layer: number): dtMeshTile | null {
    // Find tile based on hash.
    const h = computeTileHash(x, y, this.m_tileLutMask);
    let tile = this.m_posLookup[h] ?? null;
    while (tile) {
      const header = tile.header;
      if (header && header.x === x && header.y === y && header.layer === layer) {
        return tile;
      }
      tile = tile.next;
    }
    return null;
  }

  /**
   * Returns neighbour tile based on side.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getNeighbourTilesAt
   */
  getNeighbourTilesAt(x: number, y: number, side: number, tiles: (dtMeshTile | null)[], maxTiles: number): number {
    let nx = x;
    let ny = y;
    switch (side) {
      case 0: nx++; break;
      case 1: nx++; ny++; break;
      case 2: ny++; break;
      case 3: nx--; ny++; break;
      case 4: nx--; break;
      case 5: nx--; ny--; break;
      case 6: ny--; break;
      case 7: nx++; ny--; break;
    }

    return this.getTilesAt(nx, ny, tiles, maxTiles);
  }

  /**
   * Gets all tile in the specified grid location. Fills `tiles` up to `maxTiles` and returns the count.
   * (Both the const and the non-const C++ overloads.)
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getTilesAt
   */
  getTilesAt(x: number, y: number, tiles: (dtMeshTile | null)[], maxTiles: number): number {
    let n = 0;

    // Find tile based on hash.
    const h = computeTileHash(x, y, this.m_tileLutMask);
    let tile = this.m_posLookup[h] ?? null;
    while (tile) {
      const header = tile.header;
      if (header && header.x === x && header.y === y) {
        if (n < maxTiles) tiles[n++] = tile;
      }
      tile = tile.next;
    }

    return n;
  }

  /**
   * Gets the tile reference for the tile at specified grid location.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getTileRefAt
   */
  getTileRefAt(x: number, y: number, layer: number): dtTileRef {
    // Find tile based on hash.
    const h = computeTileHash(x, y, this.m_tileLutMask);
    let tile = this.m_posLookup[h] ?? null;
    while (tile) {
      const header = tile.header;
      if (header && header.x === x && header.y === y && header.layer === layer) {
        return this.getTileRef(tile);
      }
      tile = tile.next;
    }
    return 0;
  }

  /**
   * Gets the tile for the specified tile reference.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getTileByRef
   */
  getTileByRef(ref: dtTileRef): dtMeshTile | null {
    if (!ref) return null;
    const tileIndex = this.decodePolyIdTile(ref);
    const tileSalt = this.decodePolyIdSalt(ref);
    if (tileIndex >= this.m_maxTiles) return null;
    const tile = this.m_tiles[tileIndex]!;
    if (tile.salt !== tileSalt) return null;
    return tile;
  }

  /**
   * The maximum number of tiles supported by the navigation mesh.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getMaxTiles
   */
  getMaxTiles(): number {
    return this.m_maxTiles;
  }

  /**
   * Gets the tile at the specified index.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getTile
   */
  getTile(i: number): dtMeshTile {
    return this.m_tiles[i]!;
  }

  /**
   * Calculates the tile grid location for the specified world position.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::calcTileLoc
   */
  calcTileLoc(pos: Float32Array, posi: number, out: Int32Array): void {
    out[0] = Math.trunc(dtMathFloorf(Math.fround(Math.fround(pos[posi]! - this.m_orig[0]!) / this.m_tileWidth)));
    out[1] = Math.trunc(dtMathFloorf(Math.fround(Math.fround(pos[posi + 2]! - this.m_orig[2]!) / this.m_tileHeight)));
  }

  /**
   * Gets the tile and polygon for the specified polygon reference.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getTileAndPolyByRef
   */
  getTileAndPolyByRef(ref: dtPolyRef, out: dtTileAndPoly): dtStatus {
    if (!ref) return DT_FAILURE;
    const salt = this.decodePolyIdSalt(ref);
    const it = this.decodePolyIdTile(ref);
    const ip = this.decodePolyIdPoly(ref);
    if (it >= this.m_maxTiles) return DT_FAILURE | DT_INVALID_PARAM;
    const tile = this.m_tiles[it]!;
    if (tile.salt !== salt || tile.header === null) return DT_FAILURE | DT_INVALID_PARAM;
    if (ip >= tile.header.polyCount) return DT_FAILURE | DT_INVALID_PARAM;
    out.tile = tile;
    out.poly = ip;
    return DT_SUCCESS;
  }

  /**
   * Returns the tile and polygon for the specified polygon reference without validating it.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getTileAndPolyByRefUnsafe
   */
  getTileAndPolyByRefUnsafe(ref: dtPolyRef, out: dtTileAndPoly): void {
    out.tile = this.m_tiles[this.decodePolyIdTile(ref)]!;
    out.poly = this.decodePolyIdPoly(ref);
  }

  /**
   * Checks the validity of a polygon reference.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::isValidPolyRef
   */
  isValidPolyRef(ref: dtPolyRef): boolean {
    if (!ref) return false;
    const salt = this.decodePolyIdSalt(ref);
    const it = this.decodePolyIdTile(ref);
    const ip = this.decodePolyIdPoly(ref);
    if (it >= this.m_maxTiles) return false;
    const tile = this.m_tiles[it]!;
    if (tile.salt !== salt || tile.header === null) return false;
    if (ip >= tile.header.polyCount) return false;
    return true;
  }

  /**
   * Removes the specified tile from the navigation mesh. Writes the tile data (when the mesh does not own it) to
   * `data.value` and its size to `dataSize.value`.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::removeTile
   */
  removeTile(ref: dtTileRef, data: { value: Uint8Array | null } | null, dataSize: { value: number } | null): dtStatus {
    if (!ref) return DT_FAILURE | DT_INVALID_PARAM;
    const tileIndex = this.decodePolyIdTile(ref);
    const tileSalt = this.decodePolyIdSalt(ref);
    if (tileIndex >= this.m_maxTiles) return DT_FAILURE | DT_INVALID_PARAM;
    const tile = this.m_tiles[tileIndex]!;
    if (tile.salt !== tileSalt) return DT_FAILURE | DT_INVALID_PARAM;
    const header = tile.header!;

    // Remove tile from hash lookup.
    const h = computeTileHash(header.x, header.y, this.m_tileLutMask);
    let prev: dtMeshTile | null = null;
    let cur = this.m_posLookup[h] ?? null;
    while (cur) {
      if (cur === tile) {
        if (prev) prev.next = cur.next;
        else this.m_posLookup[h] = cur.next;
        break;
      }
      prev = cur;
      cur = cur.next;
    }

    // Remove connections to neighbour tiles.
    const neis = removeTile_neis;
    let nneis: number;

    // Disconnect from other layers in current tile.
    nneis = this.getTilesAt(header.x, header.y, neis, MAX_NEIS);
    for (let j = 0; j < nneis; ++j) {
      if (neis[j] === tile) continue;
      this.unconnectLinks(neis[j]!, tile);
    }

    // Disconnect from neighbour tiles.
    for (let i = 0; i < 8; ++i) {
      nneis = this.getNeighbourTilesAt(header.x, header.y, i, neis, MAX_NEIS);
      for (let j = 0; j < nneis; ++j) this.unconnectLinks(neis[j]!, tile);
    }

    // Reset tile.
    if (tile.flags & DT_TILE_FREE_DATA) {
      // Owns data
      dtFree(tile.data);
      tile.data = null;
      tile.dataSize = 0;
      if (data) data.value = null;
      if (dataSize) dataSize.value = 0;
    } else {
      if (data) data.value = tile.data;
      if (dataSize) dataSize.value = tile.dataSize;
    }

    tile.flags = 0;
    tile.linksFreeList = 0;
    tile.detachData();

    // Update salt, salt should never be zero.
    tile.salt = (tile.salt + 1) & ((1 << DT_SALT_BITS) - 1);
    if (tile.salt === 0) tile.salt++;

    // Add to free list.
    tile.next = this.m_nextFree;
    this.m_nextFree = tile;

    return DT_SUCCESS;
  }

  /**
   * Gets the tile reference for the specified tile.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getTileRef
   */
  getTileRef(tile: dtMeshTile | null): dtTileRef {
    if (!tile) return 0;
    const it = tile.index;
    return this.encodePolyId(tile.salt, it, 0);
  }

  /**
   * Gets the polygon reference for the tile's base polygon.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getPolyRefBase
   */
  getPolyRefBase(tile: dtMeshTile | null): dtPolyRef {
    if (!tile) return 0;
    const it = tile.index;
    return this.encodePolyId(tile.salt, it, 0);
  }

  /**
   * Gets the size of the buffer required by #storeTileState to store the specified tile's state.
   * `dtTileState` is magic, version (int) and a 64-bit `dtTileRef` (16 bytes); `dtPolyState` is flags (u16) and
   * area (u8) (4 bytes with padding).
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getTileStateSize
   */
  getTileStateSize(tile: dtMeshTile | null): number {
    if (!tile) return 0;
    const headerSize = dtAlign4(DT_SIZEOF_TILE_STATE);
    const polyStateSize = dtAlign4(DT_SIZEOF_POLY_STATE * tile.header!.polyCount);
    return headerSize + polyStateSize;
  }

  /**
   * Stores the non-structural state of the tile in the specified buffer. (Flags, area ids, etc.)
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::storeTileState
   */
  storeTileState(tile: dtMeshTile, data: Uint8Array, maxDataSize: number): dtStatus {
    // Make sure there is enough space to store the state.
    const sizeReq = this.getTileStateSize(tile);
    if (maxDataSize < sizeReq) return DT_FAILURE | DT_BUFFER_TOO_SMALL;

    const view = new DataView(data.buffer, data.byteOffset, sizeReq);
    const polyStates = dtAlign4(DT_SIZEOF_TILE_STATE);

    // Store tile state.
    view.setInt32(0, DT_NAVMESH_STATE_MAGIC, true);
    view.setInt32(4, DT_NAVMESH_STATE_VERSION, true);
    const ref = this.getTileRef(tile);
    view.setUint32(8, ref >>> 0, true);
    view.setUint32(12, Math.floor(ref / 4294967296), true);

    // Store per poly state.
    for (let i = 0; i < tile.header!.polyCount; ++i) {
      const s = polyStates + i * DT_SIZEOF_POLY_STATE;
      view.setUint16(s, tile.polyFlags(i), true);
      view.setUint8(s + 2, tile.polyGetArea(i));
    }

    return DT_SUCCESS;
  }

  /**
   * Restores the state of the tile.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::restoreTileState
   */
  restoreTileState(tile: dtMeshTile, data: Uint8Array, maxDataSize: number): dtStatus {
    // Make sure there is enough space to store the state.
    const sizeReq = this.getTileStateSize(tile);
    if (maxDataSize < sizeReq) return DT_FAILURE | DT_INVALID_PARAM;

    const view = new DataView(data.buffer, data.byteOffset, sizeReq);
    const polyStates = dtAlign4(DT_SIZEOF_TILE_STATE);

    // Check that the restore is possible.
    if (view.getInt32(0, true) !== DT_NAVMESH_STATE_MAGIC) return DT_FAILURE | DT_WRONG_MAGIC;
    if (view.getInt32(4, true) !== DT_NAVMESH_STATE_VERSION) return DT_FAILURE | DT_WRONG_VERSION;
    const storedRef = view.getUint32(12, true) * 4294967296 + view.getUint32(8, true);
    if (storedRef !== this.getTileRef(tile)) return DT_FAILURE | DT_INVALID_PARAM;

    // Restore per poly state.
    for (let i = 0; i < tile.header!.polyCount; ++i) {
      const s = polyStates + i * DT_SIZEOF_POLY_STATE;
      tile.setPolyFlags(i, view.getUint16(s, true));
      tile.polySetArea(i, view.getUint8(s + 2));
    }

    return DT_SUCCESS;
  }

  /**
   * Gets the endpoints for an off-mesh connection, ordered by "direction of travel".
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getOffMeshConnectionPolyEndPoints
   */
  getOffMeshConnectionPolyEndPoints(prevRef: dtPolyRef, polyRef: dtPolyRef, startPos: Float32Array, endPos: Float32Array): dtStatus {
    if (!polyRef) return DT_FAILURE;

    // Get current polygon
    const salt = this.decodePolyIdSalt(polyRef);
    const it = this.decodePolyIdTile(polyRef);
    const ip = this.decodePolyIdPoly(polyRef);
    if (it >= this.m_maxTiles) return DT_FAILURE | DT_INVALID_PARAM;
    const tile = this.m_tiles[it]!;
    if (tile.salt !== salt || tile.header === null) return DT_FAILURE | DT_INVALID_PARAM;
    if (ip >= tile.header.polyCount) return DT_FAILURE | DT_INVALID_PARAM;
    const poly = ip;

    // Make sure that the current poly is indeed off-mesh link.
    if (tile.polyGetType(poly) !== DT_POLYTYPE_OFFMESH_CONNECTION) return DT_FAILURE;

    // Figure out which way to hand out the vertices.
    let idx0 = 0;
    let idx1 = 1;

    // Find link that points to first vertex.
    for (let i = tile.polyFirstLink(poly); i !== DT_NULL_LINK; i = tile.linkNext(i)) {
      if (tile.linkEdge(i) === 0) {
        if (tile.linkRef(i) !== prevRef) {
          idx0 = 1;
          idx1 = 0;
        }
        break;
      }
    }

    dtVcopy(startPos, 0, tile.verts, tile.polyVerts(poly, idx0) * 3);
    dtVcopy(endPos, 0, tile.verts, tile.polyVerts(poly, idx1) * 3);

    return DT_SUCCESS;
  }

  /**
   * Gets the specified off-mesh connection.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getOffMeshConnectionByRef
   */
  getOffMeshConnectionByRef(ref: dtPolyRef): dtOffMeshConnection | null {
    if (!ref) return null;

    // Get current polygon
    const salt = this.decodePolyIdSalt(ref);
    const it = this.decodePolyIdTile(ref);
    const ip = this.decodePolyIdPoly(ref);
    if (it >= this.m_maxTiles) return null;
    const tile = this.m_tiles[it]!;
    if (tile.salt !== salt || tile.header === null) return null;
    if (ip >= tile.header.polyCount) return null;

    // Make sure that the current poly is indeed off-mesh link.
    if (tile.polyGetType(ip) !== DT_POLYTYPE_OFFMESH_CONNECTION) return null;

    const idx = ip - tile.header.offMeshBase;
    dtAssert(idx < tile.header.offMeshConCount, "idx < (unsigned int)tile->header->offMeshConCount");
    return new dtOffMeshConnection(tile, idx);
  }

  /**
   * Sets the user defined flags for the specified polygon.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::setPolyFlags
   */
  setPolyFlags(ref: dtPolyRef, flags: number): dtStatus {
    if (!ref) return DT_FAILURE;
    if (dtStatusFailed(this.getTileAndPolyByRef(ref, tap_scratch))) return DT_FAILURE | DT_INVALID_PARAM;
    // Change flags.
    tap_scratch.tile!.setPolyFlags(tap_scratch.poly, flags & 0xffff);
    return DT_SUCCESS;
  }

  /**
   * Gets the user defined flags for the specified polygon (written to `resultFlags[0]`).
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getPolyFlags
   */
  getPolyFlags(ref: dtPolyRef, resultFlags: Uint16Array): dtStatus {
    if (!ref) return DT_FAILURE;
    if (dtStatusFailed(this.getTileAndPolyByRef(ref, tap_scratch))) return DT_FAILURE | DT_INVALID_PARAM;
    resultFlags[0] = tap_scratch.tile!.polyFlags(tap_scratch.poly);
    return DT_SUCCESS;
  }

  /**
   * Sets the user defined area for the specified polygon.
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::setPolyArea
   */
  setPolyArea(ref: dtPolyRef, area: number): dtStatus {
    if (!ref) return DT_FAILURE;
    if (dtStatusFailed(this.getTileAndPolyByRef(ref, tap_scratch))) return DT_FAILURE | DT_INVALID_PARAM;
    tap_scratch.tile!.polySetArea(tap_scratch.poly, area);
    return DT_SUCCESS;
  }

  /**
   * Gets the user defined area for the specified polygon (written to `resultArea[0]`).
   * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtNavMesh::getPolyArea
   */
  getPolyArea(ref: dtPolyRef, resultArea: Uint8Array): dtStatus {
    if (!ref) return DT_FAILURE;
    if (dtStatusFailed(this.getTileAndPolyByRef(ref, tap_scratch))) return DT_FAILURE | DT_INVALID_PARAM;
    resultArea[0] = tap_scratch.tile!.polyGetArea(tap_scratch.poly);
    return DT_SUCCESS;
  }

  /**
   * Derives a standard polygon reference.
   * @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtNavMesh::encodePolyId
   */
  encodePolyId(salt: number, it: number, ip: number): dtPolyRef {
    return salt * DT_REF_SALT_MUL + it * DT_REF_POLY_MUL + ip;
  }

  /**
   * Decodes a standard polygon reference into `out` = [salt, it, ip].
   * @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtNavMesh::decodePolyId
   */
  decodePolyId(ref: dtPolyRef, out: Uint32Array): void {
    out[0] = this.decodePolyIdSalt(ref);
    out[1] = this.decodePolyIdTile(ref);
    out[2] = this.decodePolyIdPoly(ref);
  }

  /**
   * Extracts a tile's salt value from the specified polygon reference.
   * @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtNavMesh::decodePolyIdSalt
   */
  decodePolyIdSalt(ref: dtPolyRef): number {
    return Math.floor(ref / DT_REF_SALT_MUL) % DT_REF_SALT_MASK;
  }

  /**
   * Extracts the tile's index from the specified polygon reference.
   * @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtNavMesh::decodePolyIdTile
   */
  decodePolyIdTile(ref: dtPolyRef): number {
    return Math.floor(ref / DT_REF_POLY_MUL) % DT_REF_TILE_MUL;
  }

  /**
   * Extracts the polygon's index (within its tile) from the specified polygon reference.
   * @ac deps/recastnavigation/Detour/Include/DetourNavMesh.h dtNavMesh::decodePolyIdPoly
   */
  decodePolyIdPoly(ref: dtPolyRef): number {
    return ref % DT_REF_POLY_MUL;
  }
}

/** `sizeof(dtTileState)`: magic, version, then the 8-byte aligned 64-bit `dtTileRef`. */
const DT_SIZEOF_TILE_STATE = 16;
/** `sizeof(dtPolyState)`: flags u16, area u8, 1 byte padding. */
const DT_SIZEOF_POLY_STATE = 4;

const addTile_neis: (dtMeshTile | null)[] = new Array(MAX_NEIS).fill(null);
const removeTile_neis: (dtMeshTile | null)[] = new Array(MAX_NEIS).fill(null);

/**
 * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtTileState
 * @ac-skip the 16-byte record is read and written in place by storeTileState / restoreTileState
 */
export type dtTileState = { magic: number; version: number; ref: dtTileRef };

/**
 * @ac deps/recastnavigation/Detour/Source/DetourNavMesh.cpp dtPolyState
 * @ac-skip the 4-byte record is read and written in place by storeTileState / restoreTileState
 */
export type dtPolyState = { flags: number; area: number };
