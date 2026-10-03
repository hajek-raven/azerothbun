/**
 * The mmap part of `common/Collision/Maps/MapDefines.h`: the `.mmtile` file header (`MmapTileHeader`, 56 bytes,
 * followed by the Detour tile blob of `header.size` bytes) and the `NavTerrain` polygon area flags.
 *
 * `MapDefines.h` also holds the grid constants (`MAX_NUMBER_OF_GRIDS`, `MAX_NUMBER_OF_CELLS`, `SIZE_OF_GRIDS`); they
 * are defined once in `../Maps/MapDefines.ts` (the mirrored path) and re-exported here, so the runtime (`MMapMgr`)
 * and the generator (`src/tools/mmaps_generator/`) get every `MapDefines.h` name from this module.
 *
 * Byte layout (little endian, `fwrite` of the whole struct):
 * - `MmapTileHeader` (56): mmapMagic u32 @0, dtVersion u32 @4, mmapVersion u32 @8, size u32 @12, usesLiquids char @16,
 *   padding[3] @17, recastConfig @20.
 * - `MmapTileRecastConfig` (36): walkableSlopeAngle f32 @0, walkableRadius u8 @4, walkableHeight u8 @5,
 *   walkableClimb u8 @6, padding0 u8 @7, vertexPerMapEdge u32 @8, vertexPerTileEdge u32 @12, tilesPerMapEdge u32 @16,
 *   baseUnitDim f32 @20, cellSizeHorizontal f32 @24, cellSizeVertical f32 @28, maxSimplificationError f32 @32.
 */
import { DT_NAVMESH_VERSION } from "../../Detour/DetourNavMesh.ts";

export { MAX_NUMBER_OF_CELLS, MAX_NUMBER_OF_GRIDS, SIZE_OF_GRIDS } from "../Maps/MapDefines.ts";

/** 'MMAP' @ac common/Collision/Maps/MapDefines.h MMAP_MAGIC */
export const MMAP_MAGIC = 0x4d4d4150;
/** @ac common/Collision/Maps/MapDefines.h MMAP_VERSION */
export const MMAP_VERSION = 20;

/** `sizeof(MmapTileRecastConfig)` */
export const SIZEOF_MMAP_TILE_RECAST_CONFIG = 36;
/** `sizeof(MmapTileHeader)` */
export const SIZEOF_MMAP_TILE_HEADER = 56;

/**
 * The Recast settings a tile was built with (stored in every `.mmtile` header).
 * @ac common/Collision/Maps/MapDefines.h MmapTileRecastConfig
 */
export class MmapTileRecastConfig {
  walkableSlopeAngle = 0;

  walkableRadius = 0; // 1
  walkableHeight = 0; // 1
  walkableClimb = 0; // 1
  padding0 = 0; // 1 → align next to 4

  vertexPerMapEdge = 0;
  vertexPerTileEdge = 0;
  tilesPerMapEdge = 0;
  baseUnitDim = 0;
  cellSizeHorizontal = 0;
  cellSizeVertical = 0;
  maxSimplificationError = 0;

  /**
   * Compares the stored widths: floats as `float`, the `uint8` and `uint32` members truncated like the C++ fields.
   * `padding0` is not compared.
   * @ac common/Collision/Maps/MapDefines.h MmapTileRecastConfig::operator==
   */
  equals(b: MmapTileRecastConfig): boolean {
    return (
      Math.fround(this.walkableSlopeAngle) === Math.fround(b.walkableSlopeAngle) &&
      (this.walkableRadius & 0xff) === (b.walkableRadius & 0xff) &&
      (this.walkableHeight & 0xff) === (b.walkableHeight & 0xff) &&
      (this.walkableClimb & 0xff) === (b.walkableClimb & 0xff) &&
      this.vertexPerMapEdge >>> 0 === b.vertexPerMapEdge >>> 0 &&
      this.vertexPerTileEdge >>> 0 === b.vertexPerTileEdge >>> 0 &&
      this.tilesPerMapEdge >>> 0 === b.tilesPerMapEdge >>> 0 &&
      Math.fround(this.baseUnitDim) === Math.fround(b.baseUnitDim) &&
      Math.fround(this.cellSizeHorizontal) === Math.fround(b.cellSizeHorizontal) &&
      Math.fround(this.cellSizeVertical) === Math.fround(b.cellSizeVertical) &&
      Math.fround(this.maxSimplificationError) === Math.fround(b.maxSimplificationError)
    );
  }

  /** Reads the 36 little-endian bytes of the struct at `offset`. */
  read(view: DataView, offset: number): this {
    this.walkableSlopeAngle = view.getFloat32(offset, true);
    this.walkableRadius = view.getUint8(offset + 4);
    this.walkableHeight = view.getUint8(offset + 5);
    this.walkableClimb = view.getUint8(offset + 6);
    this.padding0 = view.getUint8(offset + 7);
    this.vertexPerMapEdge = view.getUint32(offset + 8, true);
    this.vertexPerTileEdge = view.getUint32(offset + 12, true);
    this.tilesPerMapEdge = view.getUint32(offset + 16, true);
    this.baseUnitDim = view.getFloat32(offset + 20, true);
    this.cellSizeHorizontal = view.getFloat32(offset + 24, true);
    this.cellSizeVertical = view.getFloat32(offset + 28, true);
    this.maxSimplificationError = view.getFloat32(offset + 32, true);
    return this;
  }

  /** Writes the 36 little-endian bytes of the struct at `offset`. */
  write(view: DataView, offset: number): void {
    view.setFloat32(offset, this.walkableSlopeAngle, true);
    view.setUint8(offset + 4, this.walkableRadius);
    view.setUint8(offset + 5, this.walkableHeight);
    view.setUint8(offset + 6, this.walkableClimb);
    view.setUint8(offset + 7, this.padding0);
    view.setUint32(offset + 8, this.vertexPerMapEdge >>> 0, true);
    view.setUint32(offset + 12, this.vertexPerTileEdge >>> 0, true);
    view.setUint32(offset + 16, this.tilesPerMapEdge >>> 0, true);
    view.setFloat32(offset + 20, this.baseUnitDim, true);
    view.setFloat32(offset + 24, this.cellSizeHorizontal, true);
    view.setFloat32(offset + 28, this.cellSizeVertical, true);
    view.setFloat32(offset + 32, this.maxSimplificationError, true);
  }
}

/**
 * The header of a `.mmtile` file. All padding is written as zero so the generator produces binary-identical files.
 * @ac common/Collision/Maps/MapDefines.h MmapTileHeader
 */
export class MmapTileHeader {
  mmapMagic = MMAP_MAGIC;
  dtVersion = DT_NAVMESH_VERSION;
  mmapVersion = MMAP_VERSION;
  size = 0;
  usesLiquids = 1;
  readonly padding = new Uint8Array(3);

  readonly recastConfig = new MmapTileRecastConfig();

  /** Reads the 56 little-endian bytes of the struct at `offset` (`view` must hold them). */
  read(view: DataView, offset: number): this {
    this.mmapMagic = view.getUint32(offset, true);
    this.dtVersion = view.getUint32(offset + 4, true);
    this.mmapVersion = view.getUint32(offset + 8, true);
    this.size = view.getUint32(offset + 12, true);
    this.usesLiquids = view.getInt8(offset + 16);
    this.padding[0] = view.getUint8(offset + 17);
    this.padding[1] = view.getUint8(offset + 18);
    this.padding[2] = view.getUint8(offset + 19);
    this.recastConfig.read(view, offset + 20);
    return this;
  }

  /** Writes the 56 little-endian bytes of the struct at `offset`, padding included. */
  write(view: DataView, offset: number): void {
    view.setUint32(offset, this.mmapMagic >>> 0, true);
    view.setUint32(offset + 4, this.dtVersion >>> 0, true);
    view.setUint32(offset + 8, this.mmapVersion >>> 0, true);
    view.setUint32(offset + 12, this.size >>> 0, true);
    view.setInt8(offset + 16, this.usesLiquids);
    view.setUint8(offset + 17, this.padding[0]!);
    view.setUint8(offset + 18, this.padding[1]!);
    view.setUint8(offset + 19, this.padding[2]!);
    this.recastConfig.write(view, offset + 20);
  }

  /** `fread(&fileHeader, sizeof(MmapTileHeader), 1, file)`: null when fewer than 56 bytes are available. */
  static fromBytes(bytes: Uint8Array, offset = 0): MmapTileHeader | null {
    if (bytes.length - offset < SIZEOF_MMAP_TILE_HEADER) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, SIZEOF_MMAP_TILE_HEADER);
    return new MmapTileHeader().read(view, 0);
  }

  /** `fwrite(&header, sizeof(MmapTileHeader), 1, file)`: the 56 little-endian bytes. */
  toBytes(): Uint8Array {
    const bytes = new Uint8Array(SIZEOF_MMAP_TILE_HEADER);
    this.write(new DataView(bytes.buffer), 0);
    return bytes;
  }
}

/**
 * Polygon area flags of the AzerothCore navmesh (`dtPoly` flags, used as include/exclude filter flags).
 * @ac common/Collision/Maps/MapDefines.h NavTerrain
 */
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
  // we only have 8 bits
} as const;
export type NavTerrain = (typeof NavTerrain)[keyof typeof NavTerrain];
export const NAV_EMPTY = NavTerrain.NAV_EMPTY;
export const NAV_GROUND = NavTerrain.NAV_GROUND;
export const NAV_MAGMA = NavTerrain.NAV_MAGMA;
export const NAV_SLIME = NavTerrain.NAV_SLIME;
export const NAV_WATER = NavTerrain.NAV_WATER;
export const NAV_UNUSED1 = NavTerrain.NAV_UNUSED1;
export const NAV_UNUSED2 = NavTerrain.NAV_UNUSED2;
export const NAV_UNUSED3 = NavTerrain.NAV_UNUSED3;
export const NAV_UNUSED4 = NavTerrain.NAV_UNUSED4;
