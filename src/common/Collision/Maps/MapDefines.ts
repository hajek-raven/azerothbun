/**
 * Shared map constants and the `.mmtile` header layout.
 *
 * The C++ structs are read and written with `fread` / `fwrite` of the whole struct; `readMmapTileHeader`
 * and `writeMmapTileHeader` are that memcpy, field by field, with the padding bytes the C++ zero
 * initializes. `DT_NAVMESH_VERSION` belongs to Detour (another module); the default here is the value of
 * `deps/recastnavigation/Detour/Include/DetourNavMesh.h`.
 */

/** @ac common/Collision/Maps/MapDefines.h MAX_NUMBER_OF_GRIDS */
export const MAX_NUMBER_OF_GRIDS = 64;
/** @ac common/Collision/Maps/MapDefines.h MAX_NUMBER_OF_CELLS */
export const MAX_NUMBER_OF_CELLS = 8;
/** @ac common/Collision/Maps/MapDefines.h SIZE_OF_GRIDS */
export const SIZE_OF_GRIDS = Math.fround(533.3333);

/** 'MMAP'. @ac common/Collision/Maps/MapDefines.h MMAP_MAGIC */
export const MMAP_MAGIC = 0x4d4d4150;
/** @ac common/Collision/Maps/MapDefines.h MMAP_VERSION */
export const MMAP_VERSION = 20;

/** `DT_NAVMESH_VERSION` of the bundled Detour, the default `MmapTileHeader::dtVersion`. */
export const DT_NAVMESH_VERSION_DEFAULT = 7;

/** @ac common/Collision/Maps/MapDefines.h MmapTileRecastConfig */
export interface MmapTileRecastConfig {
  walkableSlopeAngle: number;
  walkableRadius: number;
  walkableHeight: number;
  walkableClimb: number;
  vertexPerMapEdge: number;
  vertexPerTileEdge: number;
  tilesPerMapEdge: number;
  baseUnitDim: number;
  cellSizeHorizontal: number;
  cellSizeVertical: number;
  maxSimplificationError: number;
}

/** `sizeof(MmapTileRecastConfig)`. */
export const MMAP_TILE_RECAST_CONFIG_SIZE = 36;

/** @ac common/Collision/Maps/MapDefines.h MmapTileRecastConfig::operator== */
export function mmapTileRecastConfigEquals(a: MmapTileRecastConfig, b: MmapTileRecastConfig): boolean {
  return (
    Math.fround(a.walkableSlopeAngle) === Math.fround(b.walkableSlopeAngle) &&
    a.walkableRadius === b.walkableRadius &&
    a.walkableHeight === b.walkableHeight &&
    a.walkableClimb === b.walkableClimb &&
    a.vertexPerMapEdge === b.vertexPerMapEdge &&
    a.vertexPerTileEdge === b.vertexPerTileEdge &&
    a.tilesPerMapEdge === b.tilesPerMapEdge &&
    Math.fround(a.baseUnitDim) === Math.fround(b.baseUnitDim) &&
    Math.fround(a.cellSizeHorizontal) === Math.fround(b.cellSizeHorizontal) &&
    Math.fround(a.cellSizeVertical) === Math.fround(b.cellSizeVertical) &&
    Math.fround(a.maxSimplificationError) === Math.fround(b.maxSimplificationError)
  );
}

/** @ac common/Collision/Maps/MapDefines.h MmapTileHeader */
export interface MmapTileHeader {
  mmapMagic: number;
  dtVersion: number;
  mmapVersion: number;
  size: number;
  usesLiquids: boolean;
  recastConfig: MmapTileRecastConfig;
}

/** `sizeof(MmapTileHeader)`. */
export const MMAP_TILE_HEADER_SIZE = 56;

/** @ac common/Collision/Maps/MapDefines.h MmapTileHeader::MmapTileHeader */
export function createMmapTileHeader(dtVersion = DT_NAVMESH_VERSION_DEFAULT): MmapTileHeader {
  return {
    mmapMagic: MMAP_MAGIC,
    dtVersion,
    mmapVersion: MMAP_VERSION,
    size: 0,
    usesLiquids: true,
    recastConfig: {
      walkableSlopeAngle: 0,
      walkableRadius: 0,
      walkableHeight: 0,
      walkableClimb: 0,
      vertexPerMapEdge: 0,
      vertexPerTileEdge: 0,
      tilesPerMapEdge: 0,
      baseUnitDim: 0,
      cellSizeHorizontal: 0,
      cellSizeVertical: 0,
      maxSimplificationError: 0,
    },
  };
}

/** `fread(&header, sizeof(MmapTileHeader), 1, f)`: null when fewer than 56 bytes remain. */
export function readMmapTileHeader(view: DataView, offset = 0): MmapTileHeader | null {
  if (view.byteLength - offset < MMAP_TILE_HEADER_SIZE) return null;
  const c = offset + 20;
  return {
    mmapMagic: view.getUint32(offset, true),
    dtVersion: view.getUint32(offset + 4, true),
    mmapVersion: view.getUint32(offset + 8, true),
    size: view.getUint32(offset + 12, true),
    usesLiquids: view.getUint8(offset + 16) !== 0,
    recastConfig: {
      walkableSlopeAngle: view.getFloat32(c, true),
      walkableRadius: view.getUint8(c + 4),
      walkableHeight: view.getUint8(c + 5),
      walkableClimb: view.getUint8(c + 6),
      vertexPerMapEdge: view.getUint32(c + 8, true),
      vertexPerTileEdge: view.getUint32(c + 12, true),
      tilesPerMapEdge: view.getUint32(c + 16, true),
      baseUnitDim: view.getFloat32(c + 20, true),
      cellSizeHorizontal: view.getFloat32(c + 24, true),
      cellSizeVertical: view.getFloat32(c + 28, true),
      maxSimplificationError: view.getFloat32(c + 32, true),
    },
  };
}

/** `fwrite(&header, sizeof(MmapTileHeader), 1, f)`, padding bytes zero. Returns the 56 bytes. */
export function writeMmapTileHeader(header: MmapTileHeader): Uint8Array {
  const out = new Uint8Array(MMAP_TILE_HEADER_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, header.mmapMagic >>> 0, true);
  view.setUint32(4, header.dtVersion >>> 0, true);
  view.setUint32(8, header.mmapVersion >>> 0, true);
  view.setUint32(12, header.size >>> 0, true);
  view.setUint8(16, header.usesLiquids ? 1 : 0);
  const c = 20;
  const r = header.recastConfig;
  view.setFloat32(c, r.walkableSlopeAngle, true);
  view.setUint8(c + 4, r.walkableRadius);
  view.setUint8(c + 5, r.walkableHeight);
  view.setUint8(c + 6, r.walkableClimb);
  view.setUint32(c + 8, r.vertexPerMapEdge >>> 0, true);
  view.setUint32(c + 12, r.vertexPerTileEdge >>> 0, true);
  view.setUint32(c + 16, r.tilesPerMapEdge >>> 0, true);
  view.setFloat32(c + 20, r.baseUnitDim, true);
  view.setFloat32(c + 24, r.cellSizeHorizontal, true);
  view.setFloat32(c + 28, r.cellSizeVertical, true);
  view.setFloat32(c + 32, r.maxSimplificationError, true);
  return out;
}

/** @ac common/Collision/Maps/MapDefines.h NavTerrain */
export const NavTerrain = {
  NAV_EMPTY: 0x00,
  NAV_GROUND: 0x01,
  NAV_MAGMA: 0x02,
  NAV_SLIME: 0x04,
  NAV_WATER: 0x08,
  NAV_UNUSED1: 0x10,
  NAV_UNUSED2: 0x20,
  NAV_UNUSED3: 0x40,
  NAV_UNUSED4: 0x80,
} as const;
