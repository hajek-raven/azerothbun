/**
 * `GridTerrainData.h/.cpp`: the `.map` file format (`map_fileheader`, `map_areaHeader`, `map_heightHeader`,
 * `map_liquidHeader`) and the per grid terrain data read from it (area ids, V8/V9 height planes as float, uint16 or
 * uint8, flight bounds, liquid, holes).
 *
 * The file is mapped with `Bun.mmap` and read through a `DataView`, so a loaded grid costs no heap memory and the
 * lookups (`getHeight`, `getArea`, `getLiquidLevel`, `GetLiquidData`, `getMinHeight`) allocate nothing. The C++ code
 * works in 32 bit floats: every intermediate result is rounded with `Math.fround` where C++ rounds, so the cell
 * borders, the triangle selection and the interpolated heights match the C++ server.
 */
import { sAreaTableStore, sLiquidTypeStore } from "../DataStores/DBCStores.ts";

const F = Math.fround;

// ******************************************
// Constants (`GridTerrainData.h`, `Map.h`, `GridDefines.h`, `MapDefines.h`)
// ******************************************

/** @ac game/Grids/GridTerrainData.h MAX_HEIGHT */
export const MAX_HEIGHT = 100000.0; // can be use for find ground height at surface
/** @ac game/Grids/GridTerrainData.h INVALID_HEIGHT */
export const INVALID_HEIGHT = -100000.0; // for check, must be equal to VMAP_INVALID_HEIGHT, real value for unknown height is VMAP_INVALID_HEIGHT_VALUE
/** @ac game/Grids/GridTerrainData.h MAX_FALL_DISTANCE */
export const MAX_FALL_DISTANCE = 250000.0; // "unlimited fall" to find VMap ground if it is available, just larger than MAX_HEIGHT - INVALID_HEIGHT
/** @ac game/Grids/GridTerrainData.h MIN_HEIGHT */
export const MIN_HEIGHT = -500.0;
/** @ac game/Maps/Map.h DEFAULT_HEIGHT_SEARCH */
export const DEFAULT_HEIGHT_SEARCH = 50.0; // default search distance to find height at nearby locations

/** @ac game/Grids/GridTerrainData.h MAP_LIQUID_TYPE_NO_WATER */
export const MAP_LIQUID_TYPE_NO_WATER = 0x00;
/** @ac game/Grids/GridTerrainData.h MAP_LIQUID_TYPE_WATER */
export const MAP_LIQUID_TYPE_WATER = 0x01;
/** @ac game/Grids/GridTerrainData.h MAP_LIQUID_TYPE_OCEAN */
export const MAP_LIQUID_TYPE_OCEAN = 0x02;
/** @ac game/Grids/GridTerrainData.h MAP_LIQUID_TYPE_MAGMA */
export const MAP_LIQUID_TYPE_MAGMA = 0x04;
/** @ac game/Grids/GridTerrainData.h MAP_LIQUID_TYPE_SLIME */
export const MAP_LIQUID_TYPE_SLIME = 0x08;
/** @ac game/Grids/GridTerrainData.h MAP_ALL_LIQUIDS */
export const MAP_ALL_LIQUIDS = MAP_LIQUID_TYPE_WATER | MAP_LIQUID_TYPE_OCEAN | MAP_LIQUID_TYPE_MAGMA | MAP_LIQUID_TYPE_SLIME;
/** @ac game/Grids/GridTerrainData.h MAP_LIQUID_TYPE_DARK_WATER */
export const MAP_LIQUID_TYPE_DARK_WATER = 0x10;

/** `enum LiquidStatus : uint32` (the older cores call it `ZLiquidStatus`). @ac game/Grids/GridTerrainData.h LiquidStatus */
export const LiquidStatus = {
  LIQUID_MAP_NO_WATER: 0x00000000,
  LIQUID_MAP_ABOVE_WATER: 0x00000001,
  LIQUID_MAP_WATER_WALK: 0x00000002,
  LIQUID_MAP_IN_WATER: 0x00000004,
  LIQUID_MAP_UNDER_WATER: 0x00000008,
} as const;
export type LiquidStatus = (typeof LiquidStatus)[keyof typeof LiquidStatus];
export const ZLiquidStatus = LiquidStatus;
export type ZLiquidStatus = LiquidStatus;

export const LIQUID_MAP_NO_WATER = LiquidStatus.LIQUID_MAP_NO_WATER;
export const LIQUID_MAP_ABOVE_WATER = LiquidStatus.LIQUID_MAP_ABOVE_WATER;
export const LIQUID_MAP_WATER_WALK = LiquidStatus.LIQUID_MAP_WATER_WALK;
export const LIQUID_MAP_IN_WATER = LiquidStatus.LIQUID_MAP_IN_WATER;
export const LIQUID_MAP_UNDER_WATER = LiquidStatus.LIQUID_MAP_UNDER_WATER;

/** @ac game/Grids/GridTerrainData.h MAP_LIQUID_STATUS_SWIMMING */
export const MAP_LIQUID_STATUS_SWIMMING = LIQUID_MAP_IN_WATER | LIQUID_MAP_UNDER_WATER;
/** @ac game/Grids/GridTerrainData.h MAP_LIQUID_STATUS_IN_CONTACT */
export const MAP_LIQUID_STATUS_IN_CONTACT = MAP_LIQUID_STATUS_SWIMMING | LIQUID_MAP_WATER_WALK;

// `MapDefines.h` / `GridDefines.h` values the terrain code needs. `SIZE_OF_GRIDS` is a `float` literal in C++.
const SIZE_OF_GRIDS = F(533.3333);
const MAX_NUMBER_OF_GRIDS = 64;
const CENTER_GRID_ID = MAX_NUMBER_OF_GRIDS / 2;
const CENTER_GRID_OFFSET = F(SIZE_OF_GRIDS / 2);
const MAP_RESOLUTION = 128;
const MAP_SIZE = F(SIZE_OF_GRIDS * MAX_NUMBER_OF_GRIDS);
const MAP_HALFSIZE = F(MAP_SIZE / 2);

// ******************************************
// Map file format defines
// ******************************************

/** `union u_map_magic`: the four characters and the little endian `uint32` they make. */
export type u_map_magic = { readonly asChar: string; readonly asUInt: number };

function magic(text: string): u_map_magic {
  const asUInt = (text.charCodeAt(0) | (text.charCodeAt(1) << 8) | (text.charCodeAt(2) << 16) | (text.charCodeAt(3) << 24)) >>> 0;
  return { asChar: text, asUInt };
}

/** @ac game/Grids/GridTerrainData.h MapMagic */
export const MapMagic: u_map_magic = magic("MAPS");
/** @ac game/Grids/GridTerrainData.h MapVersionMagic */
export const MapVersionMagic = 9;
/** @ac game/Grids/GridTerrainData.h MapAreaMagic */
export const MapAreaMagic: u_map_magic = magic("AREA");
/** @ac game/Grids/GridTerrainData.h MapHeightMagic */
export const MapHeightMagic: u_map_magic = magic("MHGT");
/** @ac game/Grids/GridTerrainData.h MapLiquidMagic */
export const MapLiquidMagic: u_map_magic = magic("MLIQ");

/** `struct map_fileheader`. */
export type map_fileheader = {
  mapMagic: number;
  versionMagic: number;
  buildMagic: number;
  areaMapOffset: number;
  areaMapSize: number;
  heightMapOffset: number;
  heightMapSize: number;
  liquidMapOffset: number;
  liquidMapSize: number;
  holesOffset: number;
  holesSize: number;
};
/** `sizeof(map_fileheader)` */
export const sizeof_map_fileheader = 44;

/** @ac game/Grids/GridTerrainData.h MAP_AREA_NO_AREA */
export const MAP_AREA_NO_AREA = 0x0001;

/** `struct map_areaHeader`. */
export type map_areaHeader = { fourcc: number; flags: number; gridArea: number };
/** `sizeof(map_areaHeader)` */
export const sizeof_map_areaHeader = 8;

/** @ac game/Grids/GridTerrainData.h MAP_HEIGHT_NO_HEIGHT */
export const MAP_HEIGHT_NO_HEIGHT = 0x0001;
/** @ac game/Grids/GridTerrainData.h MAP_HEIGHT_AS_INT16 */
export const MAP_HEIGHT_AS_INT16 = 0x0002;
/** @ac game/Grids/GridTerrainData.h MAP_HEIGHT_AS_INT8 */
export const MAP_HEIGHT_AS_INT8 = 0x0004;
/** @ac game/Grids/GridTerrainData.h MAP_HEIGHT_HAS_FLIGHT_BOUNDS */
export const MAP_HEIGHT_HAS_FLIGHT_BOUNDS = 0x0008;

/** `struct map_heightHeader`. */
export type map_heightHeader = { fourcc: number; flags: number; gridHeight: number; gridMaxHeight: number };
/** `sizeof(map_heightHeader)` */
export const sizeof_map_heightHeader = 16;

/** @ac game/Grids/GridTerrainData.h MAP_LIQUID_NO_TYPE */
export const MAP_LIQUID_NO_TYPE = 0x0001;
/** @ac game/Grids/GridTerrainData.h MAP_LIQUID_NO_HEIGHT */
export const MAP_LIQUID_NO_HEIGHT = 0x0002;

/** `struct map_liquidHeader`. */
export type map_liquidHeader = {
  fourcc: number;
  flags: number;
  liquidFlags: number;
  liquidType: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  liquidLevel: number;
};
/** `sizeof(map_liquidHeader)` */
export const sizeof_map_liquidHeader = 16;

/** Sizes of the arrays in the file (`std::array` sizes of the `Loaded*Data` structs). */
export const AREA_MAP_ENTRIES = 16 * 16;
export const V9_SIZE = 129 * 129;
export const V8_SIZE = 128 * 128;
export const LIQUID_ENTRIES = 16 * 16;
export const HOLE_ENTRIES = 16 * 16;

/** Reads `map_fileheader` at `offset` (the caller checked the bounds). */
export function readMapFileHeader(view: DataView, offset: number): map_fileheader {
  return {
    mapMagic: view.getUint32(offset, true),
    versionMagic: view.getUint32(offset + 4, true),
    buildMagic: view.getUint32(offset + 8, true),
    areaMapOffset: view.getUint32(offset + 12, true),
    areaMapSize: view.getUint32(offset + 16, true),
    heightMapOffset: view.getUint32(offset + 20, true),
    heightMapSize: view.getUint32(offset + 24, true),
    liquidMapOffset: view.getUint32(offset + 28, true),
    liquidMapSize: view.getUint32(offset + 32, true),
    holesOffset: view.getUint32(offset + 36, true),
    holesSize: view.getUint32(offset + 40, true),
  };
}

/** Writes `map_fileheader` at `offset` (used by the test writer and the extractor). */
export function writeMapFileHeader(view: DataView, offset: number, header: map_fileheader): void {
  view.setUint32(offset, header.mapMagic, true);
  view.setUint32(offset + 4, header.versionMagic, true);
  view.setUint32(offset + 8, header.buildMagic, true);
  view.setUint32(offset + 12, header.areaMapOffset, true);
  view.setUint32(offset + 16, header.areaMapSize, true);
  view.setUint32(offset + 20, header.heightMapOffset, true);
  view.setUint32(offset + 24, header.heightMapSize, true);
  view.setUint32(offset + 28, header.liquidMapOffset, true);
  view.setUint32(offset + 32, header.liquidMapSize, true);
  view.setUint32(offset + 36, header.holesOffset, true);
  view.setUint32(offset + 40, header.holesSize, true);
}

// ******************************************
// Loaded map data structures
// ******************************************

/**
 * `LoadedAreaData`. C++ owns copies in `std::array`s; here the arrays stay in the mapped file and the fields hold
 * their byte offsets (`-1` where C++ holds a null `unique_ptr`).
 */
export type LoadedAreaData = {
  gridArea: number;
  /** offset of `areaMap` (16 * 16 `uint16`), -1 when the whole grid has `gridArea` */
  areaMap: number;
};

/** `LoadedHeightData` with byte offsets in place of the arrays. */
export type LoadedHeightData = {
  gridHeight: number;
  /** `Uint16HeightData`: `v9` (129 * 129 `uint16`), `v8` (128 * 128 `uint16`) */
  uint16HeightData: { v9: number; v8: number; gridIntHeightMultiplier: number } | null;
  /** `Uint8HeightData`: `v9` (129 * 129 `uint8`), `v8` (128 * 128 `uint8`) */
  uint8HeightData: { v9: number; v8: number; gridIntHeightMultiplier: number } | null;
  /** `FloatHeightData`: `v9` (129 * 129 `float`), `v8` (128 * 128 `float`) */
  floatHeightData: { v9: number; v8: number } | null;
  /** `HeightPlanesType`: 8 `G3D::Plane` as (normal.x, normal.y, normal.z, d) with `normal * p + d = 0` */
  minHeightPlanes: Float64Array | null;
};

/** `LoadedLiquidData` with byte offsets in place of the arrays. */
export type LoadedLiquidData = {
  liquidGlobalEntry: number;
  liquidGlobalFlags: number;
  liquidOffX: number;
  liquidOffY: number;
  liquidWidth: number;
  liquidHeight: number;
  liquidLevel: number;
  /** offset of `liquidEntry` (16 * 16 `uint16`), -1 when not stored */
  liquidEntry: number;
  /** offset of `liquidFlags` (16 * 16 `uint8`), -1 when not stored */
  liquidFlags: number;
  /** offset of `liquidMap` (`liquidWidth * liquidHeight` `float`), -1 when not stored */
  liquidMap: number;
};

/** `LoadedHoleData` (16 * 16 `uint16` at `holes`). */
export type LoadedHoleData = { holes: number };

/** `struct LiquidData` */
export class LiquidData {
  Entry = 0;
  Flags = 0;
  Level: number = INVALID_HEIGHT;
  DepthLevel: number = INVALID_HEIGHT;
  Status: LiquidStatus = LIQUID_MAP_NO_WATER;

  /** `liquidData = other` */
  copyFrom(other: LiquidData): this {
    this.Entry = other.Entry;
    this.Flags = other.Flags;
    this.Level = other.Level;
    this.DepthLevel = other.DepthLevel;
    this.Status = other.Status;
    return this;
  }

  /** Back to the default constructed state. */
  reset(): this {
    this.Entry = 0;
    this.Flags = 0;
    this.Level = INVALID_HEIGHT;
    this.DepthLevel = INVALID_HEIGHT;
    this.Status = LIQUID_MAP_NO_WATER;
    return this;
  }
}

/** `struct PositionFullTerrainStatus` (declared in `Map.h`, filled by `Map::GetFullTerrainStatusForPosition`). */
export class PositionFullTerrainStatus {
  areaId = 0;
  floorZ: number = INVALID_HEIGHT;
  outdoors = false;
  liquidInfo = new LiquidData();
}

/** `enum class TerrainMapDataReadResult` */
export const TerrainMapDataReadResult = {
  Success: 0,
  NotFound: 1,
  ReadError: 2,
  InvalidMagic: 3,
  InvalidAreaData: 4,
  InvalidHeightData: 5,
  InvalidLiquidData: 6,
  InvalidHoleData: 7,
} as const;
export type TerrainMapDataReadResult = (typeof TerrainMapDataReadResult)[keyof typeof TerrainMapDataReadResult];

/** @ac game/Grids/GridTerrainData.cpp holetab_h */
const holetab_h = [0x1111, 0x2222, 0x4444, 0x8888] as const;
/** @ac game/Grids/GridTerrainData.cpp holetab_v */
const holetab_v = [0x000f, 0x00f0, 0x0f00, 0xf000] as const;

// `GridTerrainData::LoadHeightData` flight bound planes
const flightBoundIndices = [
  [3, 0, 4],
  [0, 1, 4],
  [1, 2, 4],
  [2, 5, 4],
  [5, 8, 4],
  [8, 7, 4],
  [7, 6, 4],
  [6, 3, 4],
] as const;
const boundGridCoords = [
  [0.0, 0.0],
  [0.0, -266.66666],
  [0.0, -533.33331],
  [-266.66666, 0.0],
  [-266.66666, -266.66666],
  [-266.66666, -533.33331],
  [-533.33331, 0.0],
  [-533.33331, -266.66666],
  [-533.33331, -533.33331],
] as const;

/**
 * `G3D::Plane(Vector3, Vector3, Vector3)` followed by `Plane::getEquation`, in float arithmetic: the plane through
 * three points as (normal.x, normal.y, normal.z, d) with `normal * p + d = 0`.
 */
function planeEquation(out: Float64Array, at: number, p0: readonly number[], p1: readonly number[], p2: readonly number[]): void {
  const ax = F(p1[0]! - p0[0]!);
  const ay = F(p1[1]! - p0[1]!);
  const az = F(p1[2]! - p0[2]!);
  const bx = F(p2[0]! - p0[0]!);
  const by = F(p2[1]! - p0[1]!);
  const bz = F(p2[2]! - p0[2]!);
  // Vector3::cross
  const cx = F(F(ay * bz) - F(az * by));
  const cy = F(F(az * bx) - F(ax * bz));
  const cz = F(F(ax * by) - F(ay * bx));
  // Vector3::direction
  const lenSquared = F(F(F(cx * cx) + F(cy * cy)) + F(cz * cz));
  const invSqrt = F(1 / F(Math.sqrt(lenSquared)));
  const nx = F(cx * invSqrt);
  const ny = F(cy * invSqrt);
  const nz = F(cz * invSqrt);
  // _distance = _normal.dot(point0); getEquation: d = -_distance
  const distance = F(F(F(nx * p0[0]!) + F(ny * p0[1]!)) + F(nz * p0[2]!));
  out[at] = nx;
  out[at + 1] = ny;
  out[at + 2] = nz;
  out[at + 3] = -distance;
}

/** @ac game/Grids/GridTerrainData.h GridTerrainData */
export class GridTerrainData {
  private _view: DataView = new DataView(new ArrayBuffer(0));
  private _loadedAreaData: LoadedAreaData | null = null;
  private _loadedHeightData: LoadedHeightData | null = null;
  private _loadedLiquidData: LoadedLiquidData | null = null;
  private _loadedHoleData: LoadedHoleData | null = null;

  /** `_gridGetHeight` (a member function pointer in C++): 0 flat, 1 float, 2 uint16, 3 uint8. */
  private _gridGetHeight = 0;

  /** @ac game/Grids/GridTerrainData.cpp GridTerrainData::GridTerrainData */
  constructor() {
    this._gridGetHeight = 0; // getHeightFromFlat
  }

  /** Bytes still in the mapped file after `pos` (`std::ifstream::read` fails when fewer remain). */
  private canRead(pos: number, length: number): boolean {
    return pos + length <= this._view.byteLength;
  }

  /** @ac game/Grids/GridTerrainData.cpp GridTerrainData::Load */
  load(mapFileName: string): TerrainMapDataReadResult {
    // Map the file; a missing file is told apart from any other error first, like `std::filesystem::exists`
    let bytes: Uint8Array;
    try {
      bytes = Bun.mmap(mapFileName, { shared: false });
    } catch (error) {
      return (error as { code?: string }).code === "ENOENT" ? TerrainMapDataReadResult.NotFound : TerrainMapDataReadResult.ReadError;
    }
    this._view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Read the map header
    if (!this.canRead(0, sizeof_map_fileheader)) return TerrainMapDataReadResult.ReadError;
    const header = readMapFileHeader(this._view, 0);

    // Check for valid map and version magics
    if (header.mapMagic !== MapMagic.asUInt || header.versionMagic !== MapVersionMagic) return TerrainMapDataReadResult.InvalidMagic;

    // Load area data
    if (header.areaMapOffset && !this.loadAreaData(header.areaMapOffset)) return TerrainMapDataReadResult.InvalidAreaData;

    // Load height data
    if (header.heightMapOffset && !this.loadHeightData(header.heightMapOffset)) return TerrainMapDataReadResult.InvalidHeightData;

    // Load liquid data
    if (header.liquidMapOffset && !this.loadLiquidData(header.liquidMapOffset)) return TerrainMapDataReadResult.InvalidLiquidData;

    // Load hole data
    if (header.holesSize && !this.loadHolesData(header.holesOffset)) return TerrainMapDataReadResult.InvalidHoleData;

    return TerrainMapDataReadResult.Success;
  }

  /** @ac game/Grids/GridTerrainData.cpp GridTerrainData::LoadAreaData */
  private loadAreaData(offset: number): boolean {
    if (!this.canRead(offset, sizeof_map_areaHeader)) return false;
    const view = this._view;
    if (view.getUint32(offset, true) !== MapAreaMagic.asUInt) return false;
    const flags = view.getUint16(offset + 4, true);
    const gridArea = view.getUint16(offset + 6, true);

    this._loadedAreaData = { gridArea, areaMap: -1 };
    if (!(flags & MAP_AREA_NO_AREA)) {
      const areaMap = offset + sizeof_map_areaHeader;
      if (!this.canRead(areaMap, AREA_MAP_ENTRIES * 2)) return false;
      this._loadedAreaData.areaMap = areaMap;
    }
    return true;
  }

  /** @ac game/Grids/GridTerrainData.cpp GridTerrainData::LoadHeightData */
  private loadHeightData(offset: number): boolean {
    if (!this.canRead(offset, sizeof_map_heightHeader)) return false;
    const view = this._view;
    if (view.getUint32(offset, true) !== MapHeightMagic.asUInt) return false;
    const flags = view.getUint32(offset + 4, true);
    const gridHeight = view.getFloat32(offset + 8, true);
    const gridMaxHeight = view.getFloat32(offset + 12, true);

    const heightData: LoadedHeightData = {
      gridHeight,
      uint16HeightData: null,
      uint8HeightData: null,
      floatHeightData: null,
      minHeightPlanes: null,
    };
    this._loadedHeightData = heightData;
    let pos = offset + sizeof_map_heightHeader;

    if (!(flags & MAP_HEIGHT_NO_HEIGHT)) {
      if (flags & MAP_HEIGHT_AS_INT16) {
        const v9 = pos;
        const v8 = v9 + V9_SIZE * 2;
        if (!this.canRead(v9, V9_SIZE * 2) || !this.canRead(v8, V8_SIZE * 2)) return false;
        pos = v8 + V8_SIZE * 2;

        heightData.uint16HeightData = { v9, v8, gridIntHeightMultiplier: F(F(gridMaxHeight - gridHeight) / 65535) };
        this._gridGetHeight = 2; // getHeightFromUint16
      } else if (flags & MAP_HEIGHT_AS_INT8) {
        const v9 = pos;
        const v8 = v9 + V9_SIZE;
        if (!this.canRead(v9, V9_SIZE) || !this.canRead(v8, V8_SIZE)) return false;
        pos = v8 + V8_SIZE;

        heightData.uint8HeightData = { v9, v8, gridIntHeightMultiplier: F(F(gridMaxHeight - gridHeight) / 255) };
        this._gridGetHeight = 3; // getHeightFromUint8
      } else {
        const v9 = pos;
        const v8 = v9 + V9_SIZE * 4;
        if (!this.canRead(v9, V9_SIZE * 4) || !this.canRead(v8, V8_SIZE * 4)) return false;
        pos = v8 + V8_SIZE * 4;

        heightData.floatHeightData = { v9, v8 };
        this._gridGetHeight = 1; // getHeightFromFloat
      }
    } else {
      this._gridGetHeight = 0; // getHeightFromFlat
    }

    if (flags & MAP_HEIGHT_HAS_FLIGHT_BOUNDS) {
      const maxHeights = pos;
      const minHeights = maxHeights + 9 * 2;
      if (!this.canRead(maxHeights, 9 * 2) || !this.canRead(minHeights, 9 * 2)) return false;

      const planes = new Float64Array(8 * 4);
      for (let quarterIndex = 0; quarterIndex < 8; ++quarterIndex) {
        const indices = flightBoundIndices[quarterIndex]!;
        const point = (i: number): number[] => {
          const coords = boundGridCoords[i]!;
          return [F(coords[0]), F(coords[1]), view.getInt16(minHeights + i * 2, true)];
        };
        planeEquation(planes, quarterIndex * 4, point(indices[0]), point(indices[1]), point(indices[2]));
      }
      heightData.minHeightPlanes = planes;
    }

    return true;
  }

  /** @ac game/Grids/GridTerrainData.cpp GridTerrainData::LoadLiquidData */
  private loadLiquidData(offset: number): boolean {
    if (!this.canRead(offset, sizeof_map_liquidHeader)) return false;
    const view = this._view;
    if (view.getUint32(offset, true) !== MapLiquidMagic.asUInt) return false;
    const flags = view.getUint8(offset + 4);

    const liquid: LoadedLiquidData = {
      liquidGlobalEntry: view.getUint16(offset + 6, true), // header.liquidType
      liquidGlobalFlags: view.getUint8(offset + 5), // header.liquidFlags
      liquidOffX: view.getUint8(offset + 8),
      liquidOffY: view.getUint8(offset + 9),
      liquidWidth: view.getUint8(offset + 10),
      liquidHeight: view.getUint8(offset + 11),
      liquidLevel: view.getFloat32(offset + 12, true),
      liquidEntry: -1,
      liquidFlags: -1,
      liquidMap: -1,
    };
    this._loadedLiquidData = liquid;
    let pos = offset + sizeof_map_liquidHeader;

    if (!(flags & MAP_LIQUID_NO_TYPE)) {
      if (!this.canRead(pos, LIQUID_ENTRIES * 2)) return false;
      liquid.liquidEntry = pos;
      pos += LIQUID_ENTRIES * 2;

      if (!this.canRead(pos, LIQUID_ENTRIES)) return false;
      liquid.liquidFlags = pos;
      pos += LIQUID_ENTRIES;
    }
    if (!(flags & MAP_LIQUID_NO_HEIGHT)) {
      const size = liquid.liquidWidth * liquid.liquidHeight * 4;
      if (!this.canRead(pos, size)) return false;
      liquid.liquidMap = pos;
    }
    return true;
  }

  /** @ac game/Grids/GridTerrainData.cpp GridTerrainData::LoadHolesData */
  private loadHolesData(offset: number): boolean {
    if (!this.canRead(offset, HOLE_ENTRIES * 2)) return false;
    this._loadedHoleData = { holes: offset };
    return true;
  }

  /** @ac game/Grids/GridTerrainData.cpp GridTerrainData::getArea */
  getArea(x: number, y: number): number {
    const area = this._loadedAreaData;
    if (!area) return 0;

    if (area.areaMap < 0) return area.gridArea;

    x = F(16 * F(32 - F(F(x) / SIZE_OF_GRIDS)));
    y = F(16 * F(32 - F(F(y) / SIZE_OF_GRIDS)));
    const lx = (x | 0) & 15;
    const ly = (y | 0) & 15;
    return this._view.getUint16(area.areaMap + (lx * 16 + ly) * 2, true);
  }

  /** `inline float getHeight(float x, float y) const { return (this->*_gridGetHeight)(x, y); }` */
  getHeight(x: number, y: number): number {
    switch (this._gridGetHeight) {
      case 1:
        return this.getHeightFromFloat(x, y);
      case 2:
        return this.getHeightFromUint16(x, y);
      case 3:
        return this.getHeightFromUint8(x, y);
      default:
        return this.getHeightFromFlat(x, y);
    }
  }

  /** @ac game/Grids/GridTerrainData.cpp GridTerrainData::getHeightFromFlat */
  private getHeightFromFlat(_x: number, _y: number): number {
    const height = this._loadedHeightData;
    if (!height) return INVALID_HEIGHT;

    return height.gridHeight;
  }

  /** @ac game/Grids/GridTerrainData.cpp GridTerrainData::getHeightFromFloat */
  private getHeightFromFloat(x: number, y: number): number {
    const height = this._loadedHeightData;
    const data = height?.floatHeightData;
    if (!data) return INVALID_HEIGHT;

    x = F(MAP_RESOLUTION * F(32 - F(F(x) / SIZE_OF_GRIDS)));
    y = F(MAP_RESOLUTION * F(32 - F(F(y) / SIZE_OF_GRIDS)));

    let x_int = x | 0;
    let y_int = y | 0;
    x = F(x - x_int);
    y = F(y - y_int);
    x_int &= MAP_RESOLUTION - 1;
    y_int &= MAP_RESOLUTION - 1;

    if (this.isHole(x_int, y_int)) return INVALID_HEIGHT;

    // Height stored as: h5 - its v8 grid, h1-h4 - its v9 grid
    // +--------------> X
    // | h1-------h2     Coordinates is:
    // | | \  1  / |     h1 0, 0
    // | |  \   /  |     h2 0, 1
    // | | 2  h5 3 |     h3 1, 0
    // | |  /   \  |     h4 1, 1
    // | | /  4  \ |     h5 1/2, 1/2
    // | h3-------h4
    // V Y
    // For find height need
    // 1 - detect triangle
    // 2 - solve linear equation from triangle points
    // Calculate coefficients for solve h = a*x + b*y + c
    const view = this._view;
    const h1Offset = data.v9 + (x_int * 129 + y_int) * 4;
    const h5 = F(2 * view.getFloat32(data.v8 + (x_int * 128 + y_int) * 4, true));

    let a: number;
    let b: number;
    let c: number;
    // Select triangle:
    if (F(x + y) < 1) {
      if (x > y) {
        // 1 triangle (h1, h2, h5 points)
        const h1 = view.getFloat32(h1Offset, true);
        const h2 = view.getFloat32(h1Offset + 129 * 4, true);
        a = F(h2 - h1);
        b = F(F(h5 - h1) - h2);
        c = h1;
      } else {
        // 2 triangle (h1, h3, h5 points)
        const h1 = view.getFloat32(h1Offset, true);
        const h3 = view.getFloat32(h1Offset + 4, true);
        a = F(F(h5 - h1) - h3);
        b = F(h3 - h1);
        c = h1;
      }
    } else if (x > y) {
      // 3 triangle (h2, h4, h5 points)
      const h2 = view.getFloat32(h1Offset + 129 * 4, true);
      const h4 = view.getFloat32(h1Offset + 130 * 4, true);
      a = F(F(h2 + h4) - h5);
      b = F(h4 - h2);
      c = F(h5 - h4);
    } else {
      // 4 triangle (h3, h4, h5 points)
      const h3 = view.getFloat32(h1Offset + 4, true);
      const h4 = view.getFloat32(h1Offset + 130 * 4, true);
      a = F(h4 - h3);
      b = F(F(h3 + h4) - h5);
      c = F(h5 - h4);
    }
    // Calculate height
    return F(F(F(a * x) + F(b * y)) + c);
  }

  /** @ac game/Grids/GridTerrainData.cpp GridTerrainData::getHeightFromUint8 */
  private getHeightFromUint8(x: number, y: number): number {
    const height = this._loadedHeightData;
    const data = height?.uint8HeightData;
    if (!height || !data) return INVALID_HEIGHT;

    x = F(MAP_RESOLUTION * F(32 - F(F(x) / SIZE_OF_GRIDS)));
    y = F(MAP_RESOLUTION * F(32 - F(F(y) / SIZE_OF_GRIDS)));

    let x_int = x | 0;
    let y_int = y | 0;
    x = F(x - x_int);
    y = F(y - y_int);
    x_int &= MAP_RESOLUTION - 1;
    y_int &= MAP_RESOLUTION - 1;

    if (this.isHole(x_int, y_int)) return INVALID_HEIGHT;

    const view = this._view;
    let a: number;
    let b: number;
    let c: number;
    const V9_h1_ptr = data.v9 + x_int * 128 + x_int + y_int;
    const h5 = 2 * view.getUint8(data.v8 + x_int * 128 + y_int);
    if (F(x + y) < 1) {
      if (x > y) {
        // 1 triangle (h1, h2, h5 points)
        const h1 = view.getUint8(V9_h1_ptr);
        const h2 = view.getUint8(V9_h1_ptr + 129);
        a = h2 - h1;
        b = h5 - h1 - h2;
        c = h1;
      } else {
        // 2 triangle (h1, h3, h5 points)
        const h1 = view.getUint8(V9_h1_ptr);
        const h3 = view.getUint8(V9_h1_ptr + 1);
        a = h5 - h1 - h3;
        b = h3 - h1;
        c = h1;
      }
    } else if (x > y) {
      // 3 triangle (h2, h4, h5 points)
      const h2 = view.getUint8(V9_h1_ptr + 129);
      const h4 = view.getUint8(V9_h1_ptr + 130);
      a = h2 + h4 - h5;
      b = h4 - h2;
      c = h5 - h4;
    } else {
      // 4 triangle (h3, h4, h5 points)
      const h3 = view.getUint8(V9_h1_ptr + 1);
      const h4 = view.getUint8(V9_h1_ptr + 130);
      a = h4 - h3;
      b = h3 + h4 - h5;
      c = h5 - h4;
    }
    // Calculate height
    return F(F(F(F(F(a * x) + F(b * y)) + c) * data.gridIntHeightMultiplier) + height.gridHeight);
  }

  /** @ac game/Grids/GridTerrainData.cpp GridTerrainData::getHeightFromUint16 */
  private getHeightFromUint16(x: number, y: number): number {
    const height = this._loadedHeightData;
    const data = height?.uint16HeightData;
    if (!height || !data) return INVALID_HEIGHT;

    x = F(MAP_RESOLUTION * F(32 - F(F(x) / SIZE_OF_GRIDS)));
    y = F(MAP_RESOLUTION * F(32 - F(F(y) / SIZE_OF_GRIDS)));

    let x_int = x | 0;
    let y_int = y | 0;
    x = F(x - x_int);
    y = F(y - y_int);
    x_int &= MAP_RESOLUTION - 1;
    y_int &= MAP_RESOLUTION - 1;

    if (this.isHole(x_int, y_int)) return INVALID_HEIGHT;

    const view = this._view;
    let a: number;
    let b: number;
    let c: number;
    const V9_h1_ptr = data.v9 + (x_int * 128 + x_int + y_int) * 2;
    const h5 = 2 * view.getUint16(data.v8 + (x_int * 128 + y_int) * 2, true);
    if (F(x + y) < 1) {
      if (x > y) {
        // 1 triangle (h1, h2, h5 points)
        const h1 = view.getUint16(V9_h1_ptr, true);
        const h2 = view.getUint16(V9_h1_ptr + 129 * 2, true);
        a = h2 - h1;
        b = h5 - h1 - h2;
        c = h1;
      } else {
        // 2 triangle (h1, h3, h5 points)
        const h1 = view.getUint16(V9_h1_ptr, true);
        const h3 = view.getUint16(V9_h1_ptr + 2, true);
        a = h5 - h1 - h3;
        b = h3 - h1;
        c = h1;
      }
    } else if (x > y) {
      // 3 triangle (h2, h4, h5 points)
      const h2 = view.getUint16(V9_h1_ptr + 129 * 2, true);
      const h4 = view.getUint16(V9_h1_ptr + 130 * 2, true);
      a = h2 + h4 - h5;
      b = h4 - h2;
      c = h5 - h4;
    } else {
      // 4 triangle (h3, h4, h5 points)
      const h3 = view.getUint16(V9_h1_ptr + 2, true);
      const h4 = view.getUint16(V9_h1_ptr + 130 * 2, true);
      a = h4 - h3;
      b = h3 + h4 - h5;
      c = h5 - h4;
    }
    // Calculate height
    return F(F(F(F(F(a * x) + F(b * y)) + c) * data.gridIntHeightMultiplier) + height.gridHeight);
  }

  /** @ac game/Grids/GridTerrainData.cpp GridTerrainData::isHole */
  private isHole(row: number, col: number): boolean {
    const holes = this._loadedHoleData;
    if (!holes) return false;

    const cellRow = (row / 8) | 0; // 8 squares per cell
    const cellCol = (col / 8) | 0;
    const holeRow = (((row % 8) / 2) | 0);
    const holeCol = (((col - cellCol * 8) / 2) | 0);

    const hole = this._view.getUint16(holes.holes + (cellRow * 16 + cellCol) * 2, true);

    return (hole & holetab_h[holeCol]! & holetab_v[holeRow]!) !== 0;
  }

  /** @ac game/Grids/GridTerrainData.cpp GridTerrainData::getMinHeight */
  getMinHeight(x: number, y: number): number {
    const height = this._loadedHeightData;
    const planes = height?.minHeightPlanes;
    if (!planes) return MIN_HEIGHT;

    x = F(x);
    y = F(y);

    // Acore::ComputeGridCoordSimple
    const gridX = (MAX_NUMBER_OF_GRIDS - 1) - (F(CENTER_GRID_ID - F(x / SIZE_OF_GRIDS)) | 0);
    const gridY = (MAX_NUMBER_OF_GRIDS - 1) - (F(CENTER_GRID_ID - F(y / SIZE_OF_GRIDS)) | 0);

    const doubleGridX = Math.floor(F(-F(x - MAP_HALFSIZE) / CENTER_GRID_OFFSET)) | 0;
    const doubleGridY = Math.floor(F(-F(y - MAP_HALFSIZE) / CENTER_GRID_OFFSET)) | 0;

    const gx = F(x - F((gridX - CENTER_GRID_ID + 1) * SIZE_OF_GRIDS));
    const gy = F(y - F((gridY - CENTER_GRID_ID + 1) * SIZE_OF_GRIDS));

    let quarterIndex = 0;
    if (doubleGridY & 1) {
      if (doubleGridX & 1) quarterIndex = 4 + (gx <= gy ? 1 : 0);
      else quarterIndex = 2 + (F(-SIZE_OF_GRIDS - gx) > gy ? 1 : 0);
    } else if (doubleGridX & 1) quarterIndex = 6 + (F(-SIZE_OF_GRIDS - gx) <= gy ? 1 : 0);
    else quarterIndex = gx > gy ? 1 : 0;

    // G3D::Ray::fromOriginAndDirection(Vector3(gx, gy, 0.0f), Vector3::unitZ()).intersection(plane).z
    const at = quarterIndex * 4;
    const rate = planes[at + 2]!; // direction (0, 0, 1) . normal
    if (rate >= 0.0) return Infinity; // Vector3::inf()
    const originDotNormal = F(F(F(gx * planes[at]!) + F(gy * planes[at + 1]!)) + F(0 * planes[at + 2]!));
    return F(-F(planes[at + 3]! + originDotNormal) / rate);
  }

  /** @ac game/Grids/GridTerrainData.cpp GridTerrainData::getLiquidLevel */
  getLiquidLevel(x: number, y: number): number {
    const liquid = this._loadedLiquidData;
    if (!liquid) return INVALID_HEIGHT;

    if (liquid.liquidMap < 0) return liquid.liquidLevel;

    x = F(MAP_RESOLUTION * F(32 - F(F(x) / SIZE_OF_GRIDS)));
    y = F(MAP_RESOLUTION * F(32 - F(F(y) / SIZE_OF_GRIDS)));

    const cx_int = ((x | 0) & (MAP_RESOLUTION - 1)) - liquid.liquidOffY;
    const cy_int = ((y | 0) & (MAP_RESOLUTION - 1)) - liquid.liquidOffX;

    if (cx_int < 0 || cx_int >= liquid.liquidHeight) return INVALID_HEIGHT;
    if (cy_int < 0 || cy_int >= liquid.liquidWidth) return INVALID_HEIGHT;

    return this._view.getFloat32(liquid.liquidMap + (cx_int * liquid.liquidWidth + cy_int) * 4, true);
  }

  /**
   * Get water state on map. `out` is filled and returned when given, so the per movement packet callers allocate
   * nothing; without it a new `LiquidData` is returned (`LiquidData const` by value in C++).
   * @ac game/Grids/GridTerrainData.cpp GridTerrainData::GetLiquidData
   */
  getLiquidData(x: number, y: number, z: number, collisionHeight: number, ReqLiquidType?: number, out?: LiquidData): LiquidData {
    const liquidData = out ? out.reset() : new LiquidData();
    liquidData.Status = LIQUID_MAP_NO_WATER;

    const liquid = this._loadedLiquidData;
    if (!liquid) return liquidData;

    x = F(x);
    y = F(y);
    z = F(z);
    collisionHeight = F(collisionHeight);

    // Check water type (if no water return)
    if (liquid.liquidGlobalFlags || liquid.liquidFlags >= 0) {
      // Get cell
      const cx = F(MAP_RESOLUTION * F(32 - F(x / SIZE_OF_GRIDS)));
      const cy = F(MAP_RESOLUTION * F(32 - F(y / SIZE_OF_GRIDS)));

      const x_int = (cx | 0) & (MAP_RESOLUTION - 1);
      const y_int = (cy | 0) & (MAP_RESOLUTION - 1);

      // Check water type in cell
      const idx = (x_int >> 3) * 16 + (y_int >> 3);
      const view = this._view;
      let type = liquid.liquidFlags >= 0 ? view.getUint8(liquid.liquidFlags + idx) : liquid.liquidGlobalFlags;
      let entry = liquid.liquidEntry >= 0 ? view.getUint16(liquid.liquidEntry + idx * 2, true) : liquid.liquidGlobalEntry;
      const liquidEntry = sLiquidTypeStore.lookupEntry(entry);
      if (liquidEntry) {
        type &= MAP_LIQUID_TYPE_DARK_WATER;
        let liqTypeIdx = liquidEntry.Type;
        if (entry < 21) {
          let area = sAreaTableStore.lookupEntry(this.getArea(x, y));
          if (area) {
            let overrideLiquid = area.LiquidTypeOverride[liquidEntry.Type] ?? 0;
            if (!overrideLiquid && area.zone) {
              area = sAreaTableStore.lookupEntry(area.zone);
              if (area) overrideLiquid = area.LiquidTypeOverride[liquidEntry.Type] ?? 0;
            }

            const liq = sLiquidTypeStore.lookupEntry(overrideLiquid);
            if (liq) {
              entry = overrideLiquid;
              liqTypeIdx = liq.Type;
            }
          }
        }

        type = (type | (1 << liqTypeIdx)) & 0xff; // uint8 type |= 1 << liqTypeIdx
      }

      // Check req liquid type mask
      if (type !== 0 && (ReqLiquidType === undefined || (ReqLiquidType & type) !== 0)) {
        // Check water level:
        // Check water height map
        const lx_int = x_int - liquid.liquidOffY;
        const ly_int = y_int - liquid.liquidOffX;
        if (lx_int >= 0 && lx_int < liquid.liquidHeight && ly_int >= 0 && ly_int < liquid.liquidWidth) {
          // Get water level
          const liquid_level =
            liquid.liquidMap >= 0 ? view.getFloat32(liquid.liquidMap + (lx_int * liquid.liquidWidth + ly_int) * 4, true) : liquid.liquidLevel;
          // Get ground level
          const ground_level = this.getHeight(x, y);

          // Check water level and ground level (sub 0.2 for fix some errors)
          if (liquid_level >= ground_level && z >= F(ground_level - F(0.2))) {
            // All ok in water -> store data
            liquidData.Entry = entry;
            liquidData.Flags = type;
            liquidData.Level = liquid_level;
            liquidData.DepthLevel = ground_level;

            // For speed check as int values
            const delta = F(liquid_level - z);

            if (delta > collisionHeight) liquidData.Status = LIQUID_MAP_UNDER_WATER;
            else if (delta > 0.0) liquidData.Status = LIQUID_MAP_IN_WATER;
            else if (delta > F(-0.1)) liquidData.Status = LIQUID_MAP_WATER_WALK;
            else liquidData.Status = LIQUID_MAP_ABOVE_WATER;
          }
        }
      }
    }

    return liquidData;
  }

  /** Test and tooling access to what was loaded (`_loadedAreaData` and friends are private in C++). */
  get loaded(): { area: LoadedAreaData | null; height: LoadedHeightData | null; liquid: LoadedLiquidData | null; holes: LoadedHoleData | null } {
    return { area: this._loadedAreaData, height: this._loadedHeightData, liquid: this._loadedLiquidData, holes: this._loadedHoleData };
  }
}
