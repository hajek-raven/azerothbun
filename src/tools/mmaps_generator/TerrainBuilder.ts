/**
 * Port of `tools/mmaps_generator/TerrainBuilder.{h,cpp}`: reads the `.map` terrain files and the vmap models of a tile
 * and turns them into the triangle soup (`MeshData`) Recast rasterizes.
 *
 * Every C++ `float` operation is rounded with `Math.fround`. `G3D::Array<T>` is `G3DArray` (a growable typed array);
 * `float*` / `int*` views into one are the backing `data` plus an explicit offset.
 */
import { ReadFile } from "../../common/Collision/BinaryFile.ts";
import { VMapMgr2 } from "../../common/Collision/Management/VMapMgr2.ts";
import { NAV_EMPTY, NAV_MAGMA, NAV_SLIME, NAV_WATER } from "../../common/Collision/Management/MMapDefines.ts";
import { StaticMapTree } from "../../common/Collision/Maps/MapTree.ts";
import { Matrix3 } from "../../math/Matrix3.ts";
import { GRID_SIZE } from "./Config.ts";

export { GRID_SIZE };

const f32 = Math.fround;

/** @ac tools/mmaps_generator/TerrainBuilder.h MMAP::Spot */
export const Spot = { TOP: 1, RIGHT: 2, LEFT: 3, BOTTOM: 4, ENTIRE: 5 } as const;
export type Spot = (typeof Spot)[keyof typeof Spot];
export const { TOP, RIGHT, LEFT, BOTTOM, ENTIRE } = Spot;

/** @ac tools/mmaps_generator/TerrainBuilder.h MMAP::Grid */
export const Grid = { GRID_V8: 0, GRID_V9: 1 } as const;
export type Grid = (typeof Grid)[keyof typeof Grid];
export const { GRID_V8, GRID_V9 } = Grid;

/** @ac tools/mmaps_generator/TerrainBuilder.h MMAP::V9_SIZE */
export const V9_SIZE = 129;
export const V9_SIZE_SQ = V9_SIZE * V9_SIZE;
export const V8_SIZE = 128;
export const V8_SIZE_SQ = V8_SIZE * V8_SIZE;
/** `GRID_SIZE / V8_SIZE`. @ac tools/mmaps_generator/TerrainBuilder.h MMAP::GRID_PART_SIZE */
export const GRID_PART_SIZE = f32(GRID_SIZE / V8_SIZE);

// see contrib/extractor/system.cpp, CONF_use_minHeight
export const INVALID_MAP_LIQ_HEIGHT = -500;
export const INVALID_MAP_LIQ_HEIGHT_MAX = 5000;

// ******************************************
// Map file format defines
// ******************************************
const SIZEOF_MAP_FILEHEADER = 44;
const SIZEOF_MAP_HEIGHTHEADER = 16;
const SIZEOF_MAP_LIQUIDHEADER = 16;

const MAP_HEIGHT_NO_HEIGHT = 0x0001;
const MAP_HEIGHT_AS_INT16 = 0x0002;
const MAP_HEIGHT_AS_INT8 = 0x0004;

const MAP_LIQUID_NO_TYPE = 0x0001;
const MAP_LIQUID_NO_HEIGHT = 0x0002;

const MAP_LIQUID_TYPE_NO_WATER = 0x00;
const MAP_LIQUID_TYPE_WATER = 0x01;
const MAP_LIQUID_TYPE_OCEAN = 0x02;
const MAP_LIQUID_TYPE_MAGMA = 0x04;
const MAP_LIQUID_TYPE_SLIME = 0x08;
const MAP_LIQUID_TYPE_DARK_WATER = 0x10;

/** `"{}/{:03}{:02}{:02}.map"` @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::MAP_FILE_NAME_FORMAT */
export function MAP_FILE_NAME_FORMAT(mapsPath: string, mapID: number, y: number, x: number): string {
  return `${mapsPath}/${String(mapID).padStart(3, "0")}${String(y).padStart(2, "0")}${String(x).padStart(2, "0")}.map`;
}

/** @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::MAP_VERSION_MAGIC */
export const MAP_VERSION_MAGIC = 9;

type TypedArray = Float32Array | Int32Array | Uint8Array | Uint16Array;
type TypedArrayCtor<T extends TypedArray> = { new (length: number): T };

/**
 * `G3D::Array<T>` over a typed array: `size()`, `append(...)`, `push_back`, `getCArray()` (the backing array, valid until
 * the next append) and `fastClear` / `clear`.
 */
export class G3DArray<T extends TypedArray> {
  data: T;
  private n = 0;

  constructor(private readonly ctor: TypedArrayCtor<T>) {
    this.data = new ctor(64);
  }

  size(): number {
    return this.n;
  }

  private reserve(count: number): void {
    if (count <= this.data.length) return;
    let cap = this.data.length * 2;
    if (cap < count) cap = count;
    const data = new this.ctor(cap);
    data.set(this.data.subarray(0, this.n) as never);
    this.data = data;
  }

  /** `append(a)`, `append(a, b)`, `append(a, b, c)`: values are stored with the C++ element conversion. */
  append(...values: number[]): void {
    this.reserve(this.n + values.length);
    for (const v of values) this.data[this.n++] = v;
  }

  push_back(v: number): void {
    if (this.n === this.data.length) this.reserve(this.n + 1);
    this.data[this.n++] = v;
  }

  /** `append(Array<T> const&)` */
  appendArray(other: G3DArray<T>): void {
    this.reserve(this.n + other.n);
    this.data.set(other.data.subarray(0, other.n) as never, this.n);
    this.n += other.n;
  }

  /** `getCArray()`: the backing store (elements below `size()` are valid). */
  getCArray(): T {
    return this.data;
  }

  fastClear(): void {
    this.n = 0;
  }

  clear(): void {
    this.n = 0;
  }
}

/** @ac tools/mmaps_generator/TerrainBuilder.h MMAP::MeshData */
export class MeshData {
  solidVerts = new G3DArray(Float32Array);
  solidTris = new G3DArray(Int32Array);

  liquidVerts = new G3DArray(Float32Array);
  liquidTris = new G3DArray(Int32Array);
  liquidType = new G3DArray(Uint8Array);

  // offmesh connection data
  /** [p0y,p0z,p0x,p1y,p1z,p1x] - per connection */
  offMeshConnections = new G3DArray(Float32Array);
  offMeshConnectionRads = new G3DArray(Float32Array);
  offMeshConnectionDirs = new G3DArray(Uint8Array);
  offMeshConnectionsAreas = new G3DArray(Uint8Array);
  offMeshConnectionsFlags = new G3DArray(Uint16Array);
}

/** `G3D::pi()` is the `double` 3.1415926535898. @ac deps/g3dlite/include/G3D/g3dmath.h G3D::pi */
const G3D_PI = 3.1415926535898;

/** @ac deps/g3dlite/source/Matrix3.cpp G3D::Matrix3::fromEulerAnglesXYZ */
export function fromEulerAnglesXYZ(fYAngle: number, fPAngle: number, fRAngle: number): Matrix3 {
  fYAngle = f32(fYAngle);
  fPAngle = f32(fPAngle);
  fRAngle = f32(fRAngle);

  let fCos = f32(Math.cos(fYAngle));
  let fSin = f32(Math.sin(fYAngle));
  const kXMat = new Matrix3(1, 0, 0, 0, fCos, -fSin, 0, fSin, fCos);

  fCos = f32(Math.cos(fPAngle));
  fSin = f32(Math.sin(fPAngle));
  const kYMat = new Matrix3(fCos, 0, fSin, 0, 1, 0, -fSin, 0, fCos);

  fCos = f32(Math.cos(fRAngle));
  fSin = f32(Math.sin(fRAngle));
  const kZMat = new Matrix3(fCos, -fSin, 0, fSin, fCos, 0, 0, 0, 1);

  return kXMat.mul(kYMat.mul(kZMat));
}

const holetab_h = new Uint16Array([0x1111, 0x2222, 0x4444, 0x8888]);
const holetab_v = new Uint16Array([0x000f, 0x00f0, 0x0f00, 0xf000]);

/** Reads `n` bytes into a typed array view, zero filling what is missing (a short `fread`). */
function readInto(rf: ReadFile, out: Uint8Array): number {
  const bytes = rf.bytes(out.length);
  if (!bytes) return 0;
  out.set(bytes);
  return out.length;
}

/** @ac tools/mmaps_generator/TerrainBuilder.h MMAP::TerrainBuilder */
export class TerrainBuilder {
  /** Controls whether liquids are loaded */
  private m_skipLiquid: boolean;
  private m_mapsPath: string;
  private m_vmapsPath: string;

  /** @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::TerrainBuilder */
  constructor(dataDirPath: string, skipLiquid: boolean) {
    this.m_skipLiquid = skipLiquid;
    // std::filesystem::path(dataDirPath) / "maps"
    const base = dataDirPath === "" ? "" : `${dataDirPath.replace(/\/$/, "")}/`;
    this.m_mapsPath = `${base}maps`;
    this.m_vmapsPath = `${base}vmaps`;
  }

  /** @ac tools/mmaps_generator/TerrainBuilder.h MMAP::TerrainBuilder::usesLiquids */
  usesLiquids(): boolean {
    return !this.m_skipLiquid;
  }

  /** Sets loop variables for selecting only certain parts of a map's terrain. @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::getLoopVars */
  private getLoopVars(portion: Spot): { loopStart: number; loopEnd: number; loopInc: number } {
    switch (portion) {
      case ENTIRE:
        return { loopStart: 0, loopEnd: V8_SIZE_SQ, loopInc: 1 };
      case TOP:
        return { loopStart: 0, loopEnd: V8_SIZE, loopInc: 1 };
      case LEFT:
        return { loopStart: 0, loopEnd: V8_SIZE_SQ - V8_SIZE + 1, loopInc: V8_SIZE };
      case RIGHT:
        return { loopStart: V8_SIZE - 1, loopEnd: V8_SIZE_SQ, loopInc: V8_SIZE };
      case BOTTOM:
        return { loopStart: V8_SIZE_SQ - V8_SIZE, loopEnd: V8_SIZE_SQ, loopInc: 1 };
    }
  }

  /** @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::loadMap */
  loadMap(mapID: number, tileX: number, tileY: number, meshData: MeshData): void {
    if (this.loadMapPortion(mapID, tileX, tileY, meshData, ENTIRE)) {
      this.loadMapPortion(mapID, (tileX + 1) >>> 0, tileY, meshData, LEFT);
      this.loadMapPortion(mapID, (tileX - 1) >>> 0, tileY, meshData, RIGHT);
      this.loadMapPortion(mapID, tileX, (tileY + 1) >>> 0, meshData, TOP);
      this.loadMapPortion(mapID, tileX, (tileY - 1) >>> 0, meshData, BOTTOM);
    }
  }

  /**
   * Loads a portion of a map's terrain.
   * @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::loadMap
   */
  private loadMapPortion(mapID: number, tileX: number, tileY: number, meshData: MeshData, portion: Spot): boolean {
    const mapFileName = MAP_FILE_NAME_FORMAT(this.m_mapsPath, mapID, tileY, tileX);

    const mapFile = ReadFile.open(mapFileName);
    if (!mapFile) return false;

    const hdrBytes = mapFile.bytes(SIZEOF_MAP_FILEHEADER);
    if (!hdrBytes) {
      console.log(`${mapFileName} is the wrong version, please extract new .map files`);
      return false;
    }
    const hv = new DataView(hdrBytes.buffer, hdrBytes.byteOffset, hdrBytes.byteLength);
    const fheader = {
      mapMagic: hv.getUint32(0, true),
      versionMagic: hv.getUint32(4, true),
      buildMagic: hv.getUint32(8, true),
      areaMapOffset: hv.getUint32(12, true),
      areaMapSize: hv.getUint32(16, true),
      heightMapOffset: hv.getUint32(20, true),
      heightMapSize: hv.getUint32(24, true),
      liquidMapOffset: hv.getUint32(28, true),
      liquidMapSize: hv.getUint32(32, true),
      holesOffset: hv.getUint32(36, true),
      holesSize: hv.getUint32(40, true),
    };
    if (fheader.versionMagic !== MAP_VERSION_MAGIC) {
      console.log(`${mapFileName} is the wrong version, please extract new .map files`);
      return false;
    }

    mapFile.seek(fheader.heightMapOffset);

    let haveTerrain = false;
    let haveLiquid = false;
    let hheader = { fourcc: 0, flags: 0, gridHeight: 0, gridMaxHeight: 0 };
    const hhBytes = mapFile.bytes(SIZEOF_MAP_HEIGHTHEADER);
    if (hhBytes) {
      const dv = new DataView(hhBytes.buffer, hhBytes.byteOffset, hhBytes.byteLength);
      hheader = {
        fourcc: dv.getUint32(0, true),
        flags: dv.getUint32(4, true),
        gridHeight: dv.getFloat32(8, true),
        gridMaxHeight: dv.getFloat32(12, true),
      };
      haveTerrain = !(hheader.flags & MAP_HEIGHT_NO_HEIGHT);
      haveLiquid = fheader.liquidMapOffset !== 0 && !this.m_skipLiquid;
    }

    // no data in this map file
    if (!haveTerrain && !haveLiquid) return false;

    // data used later
    const holes = new Uint16Array(16 * 16);
    const liquid_entry = new Uint16Array(16 * 16);
    const liquid_flags = new Uint8Array(16 * 16);
    const ltriangles = new G3DArray(Int32Array);
    const ttriangles = new G3DArray(Int32Array);

    // terrain data
    if (haveTerrain) {
      const V9 = new Float32Array(V9_SIZE_SQ);
      const V8 = new Float32Array(V8_SIZE_SQ);
      const expected = V9_SIZE_SQ + V8_SIZE_SQ;

      if (hheader.flags & MAP_HEIGHT_AS_INT8) {
        const v9 = new Uint8Array(V9_SIZE_SQ);
        const v8 = new Uint8Array(V8_SIZE_SQ);
        let count = 0;
        count += readInto(mapFile, v9);
        count += readInto(mapFile, v8);
        if (count !== expected) console.log(`TerrainBuilder::loadMap: Failed to read some data expected ${expected}, read ${count}`);

        const heightMultiplier = f32(f32(hheader.gridMaxHeight - hheader.gridHeight) / 255);

        for (let i = 0; i < V9_SIZE_SQ; ++i) V9[i] = f32(f32(v9[i]! * heightMultiplier) + hheader.gridHeight);

        for (let i = 0; i < V8_SIZE_SQ; ++i) V8[i] = f32(f32(v8[i]! * heightMultiplier) + hheader.gridHeight);
      } else if (hheader.flags & MAP_HEIGHT_AS_INT16) {
        const v9 = new Uint16Array(V9_SIZE_SQ);
        const v8 = new Uint16Array(V8_SIZE_SQ);
        let count = 0;
        count += readInto(mapFile, new Uint8Array(v9.buffer)) / 2;
        count += readInto(mapFile, new Uint8Array(v8.buffer)) / 2;
        if (count !== expected) console.log(`TerrainBuilder::loadMap: Failed to read some data expected ${expected}, read ${count}`);

        const heightMultiplier = f32(f32(hheader.gridMaxHeight - hheader.gridHeight) / 65535);

        for (let i = 0; i < V9_SIZE_SQ; ++i) V9[i] = f32(f32(v9[i]! * heightMultiplier) + hheader.gridHeight);

        for (let i = 0; i < V8_SIZE_SQ; ++i) V8[i] = f32(f32(v8[i]! * heightMultiplier) + hheader.gridHeight);
      } else {
        let count = 0;
        count += readInto(mapFile, new Uint8Array(V9.buffer)) / 4;
        count += readInto(mapFile, new Uint8Array(V8.buffer)) / 4;
        if (count !== expected) console.log(`TerrainBuilder::loadMap: Failed to read some data expected ${expected}, read ${count}`);
      }

      // hole data
      if (fheader.holesSize !== 0) {
        mapFile.seek(fheader.holesOffset);
        const holeBytes = new Uint8Array(holes.buffer, 0, Math.min(fheader.holesSize, holes.byteLength));
        if (readInto(mapFile, holeBytes) !== holeBytes.length) console.log("TerrainBuilder::loadMap: Failed to read some data expected 1, read 0");
      }

      const count = (meshData.solidVerts.size() / 3) | 0;
      const xoffset = f32(f32(f32(tileX) - 32) * GRID_SIZE);
      const yoffset = f32(f32(f32(tileY) - 32) * GRID_SIZE);

      const coord = new Float32Array(3);

      for (let i = 0; i < V9_SIZE_SQ; ++i) {
        this.getHeightCoord(i, GRID_V9, xoffset, yoffset, coord, V9);
        meshData.solidVerts.append(coord[0]!);
        meshData.solidVerts.append(coord[2]!);
        meshData.solidVerts.append(coord[1]!);
      }

      for (let i = 0; i < V8_SIZE_SQ; ++i) {
        this.getHeightCoord(i, GRID_V8, xoffset, yoffset, coord, V8);
        meshData.solidVerts.append(coord[0]!);
        meshData.solidVerts.append(coord[2]!);
        meshData.solidVerts.append(coord[1]!);
      }

      const indices = new Int32Array(3);
      const { loopStart, loopEnd, loopInc } = this.getLoopVars(portion);
      for (let i = loopStart; i < loopEnd; i += loopInc)
        for (let j = TOP; j <= BOTTOM; j += 1) {
          this.getHeightTriangle(i, j as Spot, indices);
          ttriangles.append(indices[2]! + count);
          ttriangles.append(indices[1]! + count);
          ttriangles.append(indices[0]! + count);
        }
    }

    // liquid data
    if (haveLiquid) {
      mapFile.seek(fheader.liquidMapOffset);
      let lheader = { fourcc: 0, flags: 0, liquidFlags: 0, liquidType: 0, offsetX: 0, offsetY: 0, width: 0, height: 0, liquidLevel: 0 };
      const lhBytes = mapFile.bytes(SIZEOF_MAP_LIQUIDHEADER);
      if (lhBytes) {
        const dv = new DataView(lhBytes.buffer, lhBytes.byteOffset, lhBytes.byteLength);
        lheader = {
          fourcc: dv.getUint32(0, true),
          flags: dv.getUint8(4),
          liquidFlags: dv.getUint8(5),
          liquidType: dv.getUint16(6, true),
          offsetX: dv.getUint8(8),
          offsetY: dv.getUint8(9),
          width: dv.getUint8(10),
          height: dv.getUint8(11),
          liquidLevel: dv.getFloat32(12, true),
        };
      } else {
        console.log("TerrainBuilder::loadMap: Failed to read some data expected 1, read 0");
      }

      let liquid_map: Float32Array | null = null;

      if (!(lheader.flags & MAP_LIQUID_NO_TYPE)) {
        if (readInto(mapFile, new Uint8Array(liquid_entry.buffer)) !== liquid_entry.byteLength)
          console.log("TerrainBuilder::loadMap: Failed to read some data expected 1, read 0");
        if (readInto(mapFile, liquid_flags) !== liquid_flags.length) console.log("TerrainBuilder::loadMap: Failed to read some data expected 1, read 0");
      } else {
        liquid_entry.fill(lheader.liquidType);
        liquid_flags.fill(lheader.liquidFlags);
      }

      if (!(lheader.flags & MAP_LIQUID_NO_HEIGHT)) {
        const toRead = lheader.width * lheader.height;
        liquid_map = new Float32Array(toRead);
        if (readInto(mapFile, new Uint8Array(liquid_map.buffer)) !== toRead * 4) {
          console.log("TerrainBuilder::loadMap: Failed to read some data expected 1, read 0");
          liquid_map = null;
        }
      }

      const count = (meshData.liquidVerts.size() / 3) | 0;
      const xoffset = f32(f32(f32(tileX) - 32) * GRID_SIZE);
      const yoffset = f32(f32(f32(tileY) - 32) * GRID_SIZE);

      const coord = new Float32Array(3);

      // generate coordinates
      if (!(lheader.flags & MAP_LIQUID_NO_HEIGHT)) {
        let j = 0;
        for (let i = 0; i < V9_SIZE_SQ; ++i) {
          const row = (i / V9_SIZE) | 0;
          const col = i % V9_SIZE;

          if (row < lheader.offsetY || row >= lheader.offsetY + lheader.height || col < lheader.offsetX || col >= lheader.offsetX + lheader.width) {
            // dummy vert using invalid height
            meshData.liquidVerts.append(
              -f32(xoffset + f32(col * GRID_PART_SIZE)),
              INVALID_MAP_LIQ_HEIGHT,
              -f32(yoffset + f32(row * GRID_PART_SIZE)),
            );
            continue;
          }

          this.getLiquidCoord(i, j, xoffset, yoffset, coord, liquid_map!);
          meshData.liquidVerts.append(coord[0]!);
          meshData.liquidVerts.append(coord[2]!);
          meshData.liquidVerts.append(coord[1]!);
          j++;
        }
      } else {
        for (let i = 0; i < V9_SIZE_SQ; ++i) {
          const row = (i / V9_SIZE) | 0;
          const col = i % V9_SIZE;
          meshData.liquidVerts.append(
            -f32(xoffset + f32(col * GRID_PART_SIZE)),
            lheader.liquidLevel,
            -f32(yoffset + f32(row * GRID_PART_SIZE)),
          );
        }
      }

      const indices = new Int32Array(3);
      const { loopStart, loopEnd, loopInc } = this.getLoopVars(portion);
      const triInc = BOTTOM - TOP;

      // generate triangles
      for (let i = loopStart; i < loopEnd; i += loopInc) {
        for (let j = TOP; j <= BOTTOM; j += triInc) {
          this.getHeightTriangle(i, j as Spot, indices, true);
          ltriangles.append(indices[2]! + count);
          ltriangles.append(indices[1]! + count);
          ltriangles.append(indices[0]! + count);
        }
      }
    }

    // now that we have gathered the data, we can figure out which parts to keep:
    // liquid above ground, ground above liquid
    const tTriCount = 4;

    const lverts = meshData.liquidVerts.getCArray();
    const ltris = ltriangles.getCArray();

    const tverts = meshData.solidVerts.getCArray();
    const ttris = ttriangles.getCArray();

    if (ltriangles.size() + ttriangles.size() === 0) return false;

    // make a copy of liquid vertices
    // used to pad right-bottom frame due to lost vertex data at extraction
    let lverts_copy: Float32Array | null = null;
    if (meshData.liquidVerts.size()) lverts_copy = lverts.slice(0, meshData.liquidVerts.size());

    let lt = 0;
    let tt = 0;
    const { loopStart, loopEnd, loopInc } = this.getLoopVars(portion);
    for (let i = loopStart; i < loopEnd; i += loopInc) {
      for (let j = 0; j < 2; ++j) {
        // default is true, will change to false if needed
        let useTerrain = true;
        let useLiquid = true;
        let liquidType = MAP_LIQUID_TYPE_NO_WATER;

        // if there is no liquid, don't use liquid
        if (!meshData.liquidVerts.size() || !ltriangles.size()) {
          useLiquid = false;
        } else {
          liquidType = this.getLiquidType(i, liquid_flags);
          switch (liquidType) {
            default:
              useLiquid = false;
              break;
            case MAP_LIQUID_TYPE_WATER:
            case MAP_LIQUID_TYPE_OCEAN:
              // merge different types of water
              liquidType = NAV_WATER;
              break;
            case MAP_LIQUID_TYPE_MAGMA:
              liquidType = NAV_MAGMA;
              break;
            case MAP_LIQUID_TYPE_SLIME:
              liquidType = NAV_SLIME;
              break;
            case MAP_LIQUID_TYPE_DARK_WATER:
              // players should not be here, so logically neither should creatures
              useTerrain = false;
              useLiquid = false;
              break;
          }
        }

        // if there is no terrain, don't use terrain
        if (!ttriangles.size()) useTerrain = false;

        // while extracting ADT data we are losing right-bottom vertices
        // this code adds fair approximation of lost data
        if (useLiquid) {
          let quadHeight = 0;
          let validCount = 0;
          for (let idx = 0; idx < 3; idx++) {
            const h = lverts_copy![ltris[lt + idx]! * 3 + 1]!;
            if (h !== INVALID_MAP_LIQ_HEIGHT && h < INVALID_MAP_LIQ_HEIGHT_MAX) {
              quadHeight = f32(quadHeight + h);
              validCount++;
            }
          }

          // update vertex height data
          if (validCount > 0 && validCount < 3) {
            quadHeight = f32(quadHeight / validCount);
            for (let idx = 0; idx < 3; idx++) {
              const h = lverts[ltris[lt + idx]! * 3 + 1]!;
              if (h === INVALID_MAP_LIQ_HEIGHT || h > INVALID_MAP_LIQ_HEIGHT_MAX) lverts[ltris[lt + idx]! * 3 + 1] = quadHeight;
            }
          }

          // no valid vertexes - don't use this poly at all
          if (validCount === 0) useLiquid = false;
        }

        // if there is a hole here, don't use the terrain
        if (useTerrain && fheader.holesSize !== 0) useTerrain = !this.isHole(i, holes);

        // we use only one terrain kind per quad - pick higher one
        if (useTerrain && useLiquid) {
          let minLLevel = INVALID_MAP_LIQ_HEIGHT_MAX;
          let maxLLevel = INVALID_MAP_LIQ_HEIGHT;
          for (let x = 0; x < 3; x++) {
            const h = lverts[ltris[lt + x]! * 3 + 1]!;
            if (minLLevel > h) minLLevel = h;

            if (maxLLevel < h) maxLLevel = h;
          }

          let maxTLevel = INVALID_MAP_LIQ_HEIGHT;
          let minTLevel = INVALID_MAP_LIQ_HEIGHT_MAX;
          for (let x = 0; x < 6; x++) {
            const h = tverts[ttris[tt + x]! * 3 + 1]!;
            if (maxTLevel < h) maxTLevel = h;

            if (minTLevel > h) minTLevel = h;
          }

          // terrain under the liquid?
          if (minLLevel > maxTLevel) useTerrain = false;

          //liquid under the terrain?
          if (minTLevel > maxLLevel) useLiquid = false;
        }

        // store the result
        if (useLiquid) {
          meshData.liquidType.append(liquidType);
          for (let k = 0; k < 3; ++k) meshData.liquidTris.append(ltris[lt + k]!);
        }

        if (useTerrain) for (let k = 0; k < (3 * tTriCount) / 2; ++k) meshData.solidTris.append(ttris[tt + k]!);

        // advance to next set of triangles
        lt += 3;
        tt += (3 * tTriCount) / 2;
      }
    }

    return meshData.solidTris.size() !== 0 || meshData.liquidTris.size() !== 0;
  }

  /**
   * Get the vector coordinate for a specific position.
   * @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::getHeightCoord
   */
  private getHeightCoord(index: number, grid: Grid, xOffset: number, yOffset: number, coord: Float32Array, v: Float32Array): void {
    // wow coords: x, y, height
    // coord is mirroed about the horizontal axes
    switch (grid) {
      case GRID_V9:
        coord[0] = -f32(xOffset + f32((index % V9_SIZE) * GRID_PART_SIZE));
        coord[1] = -f32(yOffset + f32(((index / V9_SIZE) | 0) * GRID_PART_SIZE));
        coord[2] = v[index]!;
        break;
      case GRID_V8:
        coord[0] = -f32(f32(xOffset + f32((index % V8_SIZE) * GRID_PART_SIZE)) + f32(GRID_PART_SIZE / 2));
        coord[1] = -f32(f32(yOffset + f32(((index / V8_SIZE) | 0) * GRID_PART_SIZE)) + f32(GRID_PART_SIZE / 2));
        coord[2] = v[index]!;
        break;
    }
  }

  /**
   * Get the triangle's vector indices for a specific position.
   * @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::getHeightTriangle
   */
  private getHeightTriangle(square: number, triangle: Spot, indices: Int32Array, liquid = false): void {
    const rowOffset = (square / V8_SIZE) | 0;
    if (!liquid)
      switch (triangle) {
        case TOP:
          indices[0] = square + rowOffset; //           0-----1 .... 128
          indices[1] = square + 1 + rowOffset; //       |\ T /|
          indices[2] = V9_SIZE_SQ + square; //          | \ / |
          break; //                                     |L 0 R| .. 127
        case LEFT: //                                   | / \ |
          indices[0] = square + rowOffset; //           |/ B \|
          indices[1] = V9_SIZE_SQ + square; //         129---130 ... 386
          indices[2] = square + V9_SIZE + rowOffset; // |\   /|
          break; //                                     | \ / |
        case RIGHT: //                                  | 128 | .. 255
          indices[0] = square + 1 + rowOffset; //       | / \ |
          indices[1] = square + V9_SIZE + 1 + rowOffset; // |/   \|
          indices[2] = V9_SIZE_SQ + square; //         258---259 ... 515
          break;
        case BOTTOM:
          indices[0] = V9_SIZE_SQ + square;
          indices[1] = square + V9_SIZE + 1 + rowOffset;
          indices[2] = square + V9_SIZE + rowOffset;
          break;
        default:
          break;
      }
    else
      switch (triangle) {
        case TOP:
          indices[0] = square + rowOffset;
          indices[1] = square + 1 + rowOffset;
          indices[2] = square + V9_SIZE + 1 + rowOffset;
          break;
        case BOTTOM:
          indices[0] = square + rowOffset;
          indices[1] = square + V9_SIZE + 1 + rowOffset;
          indices[2] = square + V9_SIZE + rowOffset;
          break;
        default:
          break;
      }
  }

  /**
   * Get the liquid vector coordinate for a specific position.
   * @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::getLiquidCoord
   */
  private getLiquidCoord(index: number, index2: number, xOffset: number, yOffset: number, coord: Float32Array, v: Float32Array): void {
    // wow coords: x, y, height
    // coord is mirroed about the horizontal axes
    coord[0] = -f32(xOffset + f32((index % V9_SIZE) * GRID_PART_SIZE));
    coord[1] = -f32(yOffset + f32(((index / V9_SIZE) | 0) * GRID_PART_SIZE));
    coord[2] = v[index2]!;
  }

  /**
   * Determines if the specific position's triangles should be rendered.
   * @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::isHole
   */
  private isHole(square: number, holes: Uint16Array): boolean {
    const row = (square / 128) | 0;
    const col = square % 128;
    const cellRow = (row / 8) | 0; // 8 squares per cell
    const cellCol = (col / 8) | 0;
    const holeRow = ((row % 8) / 2) | 0;
    const holeCol = ((square - (row * 128 + cellCol * 8)) / 2) | 0;

    const hole = holes[cellRow * 16 + cellCol]!;

    return (hole & holetab_h[holeCol]! & holetab_v[holeRow]!) !== 0;
  }

  /** @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::getLiquidType */
  private getLiquidType(square: number, liquid_type: Uint8Array): number {
    const row = (square / 128) | 0;
    const col = square % 128;
    const cellRow = (row / 8) | 0; // 8 squares per cell
    const cellCol = (col / 8) | 0;

    return liquid_type[cellRow * 16 + cellCol]!;
  }

  /** @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::loadVMap */
  loadVMap(mapID: number, tileX: number, tileY: number, meshData: MeshData): boolean {
    const mapFileName = VMapMgr2.getMapFileName(mapID);
    const staticTree = new StaticMapTree(mapID, this.m_vmapsPath);
    if (!staticTree.InitMap(mapFileName)) return false;

    staticTree.LoadMapTile(tileX, tileY);

    let retval = false;

    do {
      const { models, count } = staticTree.GetModelInstances();

      if (!models) break;

      for (let i = 0; i < count; ++i) {
        const instance = models[i];
        if (!instance) continue;

        // model instances exist in tree even though there are instances of that model in this tile
        const worldModel = instance.getWorldModel();
        if (!worldModel) continue;

        // now we have a model to add to the meshdata
        retval = true;

        const groupModels = worldModel.GetGroupModels();

        // all M2s need to have triangle indices reversed
        const isM2 = instance.name.includes(".m2") || instance.name.includes(".M2");

        // transform data
        const scale = f32(instance.iScale);
        const rotation = fromEulerAnglesXYZ(
          (G3D_PI * instance.iRot.z) / -180,
          (G3D_PI * instance.iRot.x) / -180,
          (G3D_PI * instance.iRot.y) / -180,
        );
        const position = new Float32Array([instance.iPos.x, instance.iPos.y, instance.iPos.z]);
        position[0] = f32(position[0]! - f32(32 * GRID_SIZE));
        position[1] = f32(position[1]! - f32(32 * GRID_SIZE));

        for (const groupModel of groupModels) {
          const { vertices: tempVertices, triangles: tempTriangles, liquid } = groupModel.GetMeshData();

          // first handle collision mesh
          const transformedVertices = TerrainBuilder.transform(tempVertices, scale, rotation, position);

          const offset = (meshData.solidVerts.size() / 3) | 0;

          TerrainBuilder.copyVertices(transformedVertices, meshData.solidVerts);
          TerrainBuilder.copyIndices(tempTriangles, meshData.solidTris, offset, isM2);

          // now handle liquid data
          if (liquid && liquid.GetFlagsStorage()) {
            const liqTris: number[] = [];
            const { tilesX, tilesY, corner } = liquid.GetPosInfo();
            const vertsX = tilesX + 1;
            const vertsY = tilesY + 1;
            const flags = liquid.GetFlagsStorage()!;
            const data = liquid.GetHeightStorage()!;
            let type: number = NAV_EMPTY;

            switch (liquid.GetType() & 3) {
              case 0:
              case 1:
                type = NAV_WATER;
                break;
              case 2:
                type = NAV_MAGMA;
                break;
              case 3:
                type = NAV_SLIME;
                break;
            }

            // indexing is weird...
            // after a lot of trial and error, this is what works:
            // vertex = y*vertsX+x
            // tile   = x*tilesY+y
            // flag   = y*tilesY+x

            const liqVerts = new Float32Array(vertsX * vertsY * 3);
            let lv = 0;
            const vert = new Float32Array(3);
            for (let x = 0; x < vertsX; ++x) {
              for (let y = 0; y < vertsY; ++y) {
                vert[0] = f32(corner.x + f32(x * GRID_PART_SIZE));
                vert[1] = f32(corner.y + f32(y * GRID_PART_SIZE));
                vert[2] = data[y * vertsX + x]!;
                TerrainBuilder.transformPoint(vert, 0, scale, rotation, position, vert, 0);
                vert[0] = -vert[0]!;
                vert[1] = -vert[1]!;
                liqVerts[lv++] = vert[0]!;
                liqVerts[lv++] = vert[1]!;
                liqVerts[lv++] = vert[2]!;
              }
            }

            for (let x = 0; x < tilesX; ++x) {
              for (let y = 0; y < tilesY; ++y) {
                if ((flags[x + y * tilesX]! & 0x0f) !== 0x0f) {
                  const square = x * tilesY + y;
                  const idx1 = square + x;
                  const idx2 = square + 1 + x;
                  const idx3 = square + tilesY + 1 + 1 + x;
                  const idx4 = square + tilesY + 1 + x;

                  // top triangle
                  liqTris.push(idx3);
                  liqTris.push(idx2);
                  liqTris.push(idx1);
                  // bottom triangle
                  liqTris.push(idx4);
                  liqTris.push(idx3);
                  liqTris.push(idx1);
                }
              }
            }

            const liqOffset = (meshData.liquidVerts.size() / 3) | 0;
            for (let k = 0; k < liqVerts.length; k += 3) {
              meshData.liquidVerts.append(liqVerts[k + 1]!, liqVerts[k + 2]!, liqVerts[k]!);
            }

            for (let j = 0; j < ((liqTris.length / 3) | 0); ++j) {
              meshData.liquidTris.append(liqTris[j * 3 + 1]! + liqOffset, liqTris[j * 3 + 2]! + liqOffset, liqTris[j * 3]! + liqOffset);
              meshData.liquidType.append(type);
            }
          }
        }
      }
    } while (false);

    return retval;
  }

  /** `v = (p * rotation * scale) + position` with `float` arithmetic; `out` may alias `p`. */
  private static transformPoint(
    p: Float32Array,
    pi: number,
    scale: number,
    rotation: Matrix3,
    position: Float32Array,
    out: Float32Array,
    oi: number,
  ): void {
    const e = rotation.elt;
    const x = p[pi]!;
    const y = p[pi + 1]!;
    const z = p[pi + 2]!;
    // G3D::operator*(Vector3 const&, Matrix3 const&)
    const rx = f32(f32(f32(x * e[0]!) + f32(y * e[3]!)) + f32(z * e[6]!));
    const ry = f32(f32(f32(x * e[1]!) + f32(y * e[4]!)) + f32(z * e[7]!));
    const rz = f32(f32(f32(x * e[2]!) + f32(y * e[5]!)) + f32(z * e[8]!));
    out[oi] = f32(f32(rx * scale) + position[0]!);
    out[oi + 1] = f32(f32(ry * scale) + position[1]!);
    out[oi + 2] = f32(f32(rz * scale) + position[2]!);
  }

  /**
   * Applies the transform, then mirrors along the horizontal axes. `source` is `(x, y, z)` triples.
   * @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::transform
   */
  static transform(source: Float32Array, scale: number, rotation: Matrix3, position: Float32Array): Float32Array {
    const transformed = new Float32Array(source.length);
    for (let i = 0; i + 2 < source.length; i += 3) {
      // apply tranform, then mirror along the horizontal axes
      TerrainBuilder.transformPoint(source, i, scale, rotation, position, transformed, i);
      transformed[i] = -transformed[i]!;
      transformed[i + 1] = -transformed[i + 1]!;
    }
    return transformed;
  }

  /** @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::copyVertices */
  static copyVertices(source: Float32Array, dest: G3DArray<Float32Array>): void {
    for (let i = 0; i + 2 < source.length; i += 3) {
      dest.push_back(source[i + 1]!);
      dest.push_back(source[i + 2]!);
      dest.push_back(source[i]!);
    }
  }

  /**
   * Copies mesh triangles (`idx0, idx1, idx2` triples) to `dest`, reversing them when `flip` is set.
   * @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::copyIndices
   */
  static copyIndices(source: Uint32Array, dest: G3DArray<Int32Array>, offset: number, flip: boolean): void {
    if (flip) {
      for (let i = 0; i + 2 < source.length; i += 3) {
        dest.push_back(source[i + 2]! + offset);
        dest.push_back(source[i + 1]! + offset);
        dest.push_back(source[i]! + offset);
      }
    } else {
      for (let i = 0; i + 2 < source.length; i += 3) {
        dest.push_back(source[i]! + offset);
        dest.push_back(source[i + 1]! + offset);
        dest.push_back(source[i + 2]! + offset);
      }
    }
  }

  /** @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::copyIndices */
  static copyIndicesArray(source: G3DArray<Int32Array>, dest: G3DArray<Int32Array>, offset: number): void {
    const src = source.getCArray();
    for (let i = 0; i < source.size(); ++i) dest.append(src[i]! + offset);
  }

  /**
   * Removes the vertices no triangle uses and renumbers the triangles (in order of first use).
   * @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::cleanVertices
   */
  static cleanVertices(verts: G3DArray<Float32Array>, tris: G3DArray<Int32Array>): void {
    const vertMap = new Map<number, number>();

    const t = tris.getCArray();
    const v = verts.getCArray();

    const cleanVerts = new G3DArray(Float32Array);
    let count = 0;
    // collect all the vertex indices from triangle
    for (let i = 0; i < tris.size(); ++i) {
      if (vertMap.has(t[i]!)) continue;
      const index = t[i]!;
      vertMap.set(index, count);
      cleanVerts.append(v[index * 3]!, v[index * 3 + 1]!, v[index * 3 + 2]!);
      count++;
    }

    verts.fastClear();
    verts.appendArray(cleanVerts);
    cleanVerts.clear();

    // update triangles to use new indices
    for (let i = 0; i < tris.size(); ++i) {
      const mapped = vertMap.get(t[i]!);
      if (mapped === undefined) continue;

      t[i] = mapped;
    }

    vertMap.clear();
  }

  /** @ac tools/mmaps_generator/TerrainBuilder.cpp MMAP::TerrainBuilder::loadOffMeshConnections */
  loadOffMeshConnections(mapID: number, tileX: number, tileY: number, meshData: MeshData, offMeshLines: readonly string[]): void {
    if (offMeshLines.length === 0) return;

    const num = String.raw`([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)`;
    const re = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s*,\\s*(\\d+)\\s*\\(\\s*${num}\\s+${num}\\s+${num}\\s*\\)\\s*\\(\\s*${num}\\s+${num}\\s+${num}\\s*\\)\\s*${num}`);
    for (const line of offMeshLines) {
      // sscanf("%u %u,%u (%f %f %f) (%f %f %f) %f")
      const m = re.exec(line);
      if (!m) {
        console.log(`Skipped off-mesh connection '${line}': invalid format`);
        continue;
      }

      const mid = Number(m[1]) >>> 0;
      const tx = Number(m[2]) >>> 0;
      const ty = Number(m[3]) >>> 0;
      const p0 = [f32(Number(m[4])), f32(Number(m[5])), f32(Number(m[6]))];
      const p1 = [f32(Number(m[7])), f32(Number(m[8])), f32(Number(m[9]))];
      const size = f32(Number(m[10]));

      if (mapID === mid && tileX === tx && tileY === ty) {
        meshData.offMeshConnections.append(p0[1]!);
        meshData.offMeshConnections.append(p0[2]!);
        meshData.offMeshConnections.append(p0[0]!);

        meshData.offMeshConnections.append(p1[1]!);
        meshData.offMeshConnections.append(p1[2]!);
        meshData.offMeshConnections.append(p1[0]!);

        meshData.offMeshConnectionDirs.append(1); // 1 - both direction, 0 - one sided
        meshData.offMeshConnectionRads.append(size); // agent radius equivalent
        meshData.offMeshConnectionsAreas.append(0xff);
        meshData.offMeshConnectionsFlags.append(0xff);
      }
    }
  }
}

