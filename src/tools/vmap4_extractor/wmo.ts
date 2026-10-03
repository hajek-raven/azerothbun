import type { MODF } from "./adtfile.ts";
import { FileWriter, bytesToLatin1 } from "./fileio.ts";
import { MPQFile, readChunkHeader } from "./mpq_libmpq04.ts";
import { AaBox3D, Vec3D, type Quaternion } from "./vec3d.ts";
import {
  ExtractSingleModel,
  GenerateUniqueObjectId,
  MOD_HAS_BOUND,
  MOD_WORLDSPAWN,
  RAW_VMAP_MAGIC,
  getModelVertexCount,
  globals,
} from "./vmapexport.ts";

// MOPY flags
export const WHO_MATERIAL_UNK01 = 0x01;
export const WMO_MATERIAL_NOCAMCOLLIDE = 0x02;
export const WMO_MATERIAL_DETAIL = 0x04;
export const WMO_MATERIAL_COLLISION = 0x08;
export const WMO_MATERIAL_HINT = 0x10;
export const WMO_MATERIAL_RENDER = 0x20;
export const WMO_MATERIAL_WALL_SURFACE = 0x40; // Guessed
export const WMO_MATERIAL_COLLIDE_HIT = 0x80;

/** `WMO::MODS`, 32 bytes: `char Name[20]; uint32 StartIndex, Count; char _pad[4]`. */
export interface WMOMODS {
  Name: string;
  StartIndex: number;
  Count: number;
}

/** `WMO::MODD`, 40 bytes: `uint32 NameIndex : 24` (the high byte holds flags), position, rotation, scale, color. */
export interface WMOMODD {
  NameIndex: number;
  Position: Vec3D;
  Rotation: Quaternion;
  Scale: number;
  Color: number;
}

/** for whatever reason a certain company just can't stick to one coordinate system... @ac tools/vmap4_extractor/wmo.h fixCoords */
export function fixCoords(v: Vec3D): Vec3D {
  return new Vec3D(v.z, v.x, v.y);
}

/** @ac tools/vmap4_extractor/wmo.h WMODoodadData */
export interface WMODoodadData {
  Sets: WMOMODS[];
  /** The raw MODN chunk (`std::unique_ptr<char[]> Paths`). */
  Paths: Uint8Array | null;
  Spawns: WMOMODD[];
  /** `std::unordered_set<uint16>`; iterated in insertion order. */
  References: Set<number>;
}

export function newWMODoodadData(): WMODoodadData {
  return { Sets: [], Paths: null, Spawns: [], References: new Set() };
}

/** `WMOLiquidHeader`, 30 bytes packed. */
export interface WMOLiquidHeader {
  xverts: number;
  yverts: number;
  xtiles: number;
  ytiles: number;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  material: number;
}

export const WMO_LIQUID_HEADER_SIZE = 30;

/** Reads a NUL terminated C string (bytes as latin1) from `bytes[start..]`, stopping at `limit`. */
function cString(bytes: Uint8Array, start: number, limit: number): string {
  let end = start;
  while (end < limit && bytes[end] !== 0) {
    ++end;
  }
  return bytesToLatin1(bytes, start, end);
}

/** `new T[ceil(size / elementSize)]` filled by a `size` bytes `f.read`; the typed array views the same bytes. */
function readInto<T extends Uint16Array | Float32Array>(f: MPQFile, size: number, make: (length: number) => T, elementSize: number): T {
  const array = make(Math.ceil(size / elementSize));
  f.read(new Uint8Array(array.buffer, array.byteOffset, size), size);
  return array;
}

/**
 * @ac tools/vmap4_extractor/wmo.h WMORoot
 * @ac tools/vmap4_extractor/wmo.cpp WMORoot::WMORoot
 * @ac tools/vmap4_extractor/wmo.cpp WMORoot::open
 * @ac tools/vmap4_extractor/wmo.cpp WMORoot::ConvertToVMAPRootWmo
 */
export class WMORoot {
  color = 0;
  nTextures = 0;
  nGroups = 0;
  nPortals = 0;
  nLights = 0;
  nDoodadNames = 0;
  nDoodadDefs = 0;
  nDoodadSets = 0;
  RootWMOID = 0;
  flags = 0;
  bbcorn1 = new Float32Array(3);
  bbcorn2 = new Float32Array(3);

  GroupNames: Uint8Array = new Uint8Array(0);
  DoodadData: WMODoodadData = newWMODoodadData();
  ValidDoodadNames = new Set<number>();

  constructor(private readonly filename: string) {}

  open(): boolean {
    const f = new MPQFile(this.filename);
    if (f.isEof()) {
      console.log("No such file.");
      return false;
    }

    for (let chunk = readChunkHeader(f); chunk; chunk = readChunkHeader(f)) {
      const { fourcc, size } = chunk;
      const nextpos = f.getPos() + size;

      if (fourcc === "MOHD") {
        // header
        this.nTextures = f.readU32();
        this.nGroups = f.readU32();
        this.nPortals = f.readU32();
        this.nLights = f.readU32();
        this.nDoodadNames = f.readU32();
        this.nDoodadDefs = f.readU32();
        this.nDoodadSets = f.readU32();
        this.color = f.readU32();
        this.RootWMOID = f.readU32();
        f.read(new Uint8Array(this.bbcorn1.buffer), 12);
        f.read(new Uint8Array(this.bbcorn2.buffer), 12);
        this.flags = f.readU32();
      } else if (fourcc === "MODS") {
        const raw = f.readBytes(size);
        const view = new DataView(raw.buffer);
        const count = Math.floor(size / 32);
        this.DoodadData.Sets = [];
        for (let index = 0; index < count; ++index) {
          const at = index * 32;
          this.DoodadData.Sets.push({
            Name: cString(raw, at, at + 20),
            StartIndex: view.getUint32(at + 20, true),
            Count: view.getUint32(at + 24, true),
          });
        }
      } else if (fourcc === "MODN") {
        const buffer = f.getBuffer()!;
        const chunkStart = f.getPos();
        const limit = Math.min(chunkStart + size, buffer.length);
        const paths = new Uint8Array(size);
        paths.set(buffer.subarray(chunkStart, limit));
        this.DoodadData.Paths = paths;
        // The C++ lower-cases the plain name inside the file buffer here (GetPlainName / fixnamen / fixname2 on
        // `ptr`); nothing reads that region again, so only the original path matters.
        let ptr = chunkStart;
        const end = chunkStart + size;
        while (ptr < end) {
          const path = { value: cString(buffer, ptr, limit) };
          const doodadNameIndex = ptr - chunkStart;
          ptr += path.value.length + 1;

          if (ExtractSingleModel(path)) {
            this.ValidDoodadNames.add(doodadNameIndex);
          }
        }
      } else if (fourcc === "MODD") {
        const raw = f.readBytes(size);
        const view = new DataView(raw.buffer);
        const count = Math.floor(size / 40);
        this.DoodadData.Spawns = [];
        for (let index = 0; index < count; ++index) {
          const at = index * 40;
          this.DoodadData.Spawns.push({
            NameIndex: view.getUint32(at, true) & 0xffffff,
            Position: new Vec3D(view.getFloat32(at + 4, true), view.getFloat32(at + 8, true), view.getFloat32(at + 12, true)),
            Rotation: {
              X: view.getFloat32(at + 16, true),
              Y: view.getFloat32(at + 20, true),
              Z: view.getFloat32(at + 24, true),
              W: view.getFloat32(at + 28, true),
            },
            Scale: view.getFloat32(at + 32, true),
            Color: view.getUint32(at + 36, true),
          });
        }
      } else if (fourcc === "MOGN") {
        this.GroupNames = f.readBytes(size);
      }
      // MOTX, MOMT, MOGI, MOLT, MOSB, MOPV, MOPT, MOPR, MFOG: not needed
      f.seek(nextpos);
    }
    f.close();
    return true;
  }

  ConvertToVMAPRootWmo(pOutfile: FileWriter): boolean {
    pOutfile.latin1(RAW_VMAP_MAGIC, 8);
    const nVectors = 0;
    pOutfile.u32(nVectors); // will be filled later
    pOutfile.u32(this.nGroups);
    pOutfile.u32(this.RootWMOID);
    return true;
  }
}

/**
 * @ac tools/vmap4_extractor/wmo.h WMOGroup
 * @ac tools/vmap4_extractor/wmo.cpp WMOGroup::WMOGroup
 * @ac tools/vmap4_extractor/wmo.cpp WMOGroup::open
 * @ac tools/vmap4_extractor/wmo.cpp WMOGroup::ConvertToVMAPGroupWmo
 * @ac tools/vmap4_extractor/wmo.cpp WMOGroup::GetLiquidTypeId
 * @ac tools/vmap4_extractor/wmo.cpp WMOGroup::ShouldSkip
 * @ac tools/vmap4_extractor/wmo.cpp WMOGroup::~WMOGroup (the arrays are garbage collected)
 */
export class WMOGroup {
  // MOGP
  MOPY: Uint8Array | null = null;
  MOVI: Uint16Array | null = null;
  MOVT: Float32Array | null = null;
  MOBA: Uint16Array | null = null;
  hlq: WMOLiquidHeader | null = null;
  /** The `height` of every `WMOLiquidVert` (`unk1` and `unk2` are never used). */
  LiquEx: Float32Array | null = null;
  LiquBytes: Uint8Array | null = null;
  groupName = 0;
  descGroupName = 0;
  mogpFlags = 0;
  bbcorn1 = new Float32Array(3);
  bbcorn2 = new Float32Array(3);
  moprIdx = 0;
  moprNItems = 0;
  nBatchA = 0;
  nBatchB = 0;
  nBatchC = 0;
  fogIdx = 0;
  groupLiquid = 0;
  groupWMOID = 0;

  mopy_size = 0;
  moba_size = 0;
  LiquEx_size = 0;
  nVertices = 0; // number when loaded
  nTriangles = 0; // number when loaded
  liquflags = 0;

  DoodadReferences: number[] = [];

  constructor(private readonly filename: string) {}

  open(rootWMO: WMORoot): boolean {
    const f = new MPQFile(this.filename);
    if (f.isEof()) {
      console.log("No such file.");
      return false;
    }
    for (let chunk = readChunkHeader(f); chunk; chunk = readChunkHeader(f)) {
      const { fourcc } = chunk;
      let { size } = chunk;
      if (fourcc === "MOGP") {
        //Fix sizeoff = Data size.
        size = 68;
      }
      const nextpos = f.getPos() + size;
      // These are reset for every chunk (also the ones that do not touch them), so only what the last chunk read
      // leaves is kept; the extractor's output depends on it.
      this.LiquEx_size = 0;
      this.liquflags = 0;

      if (fourcc === "MOGP") {
        // header
        this.groupName = f.readI32();
        this.descGroupName = f.readI32();
        this.mogpFlags = f.readI32();
        f.read(new Uint8Array(this.bbcorn1.buffer), 12);
        f.read(new Uint8Array(this.bbcorn2.buffer), 12);
        this.moprIdx = f.readU16();
        this.moprNItems = f.readU16();
        this.nBatchA = f.readU16();
        this.nBatchB = f.readU16();
        this.nBatchC = f.readU32();
        this.fogIdx = f.readU32();
        this.groupLiquid = f.readU32();
        this.groupWMOID = f.readU32();

        // according to WoW.Dev Wiki:
        if (rootWMO.flags & 4) {
          this.groupLiquid = this.GetLiquidTypeId(this.groupLiquid);
        } else if (this.groupLiquid === 15) {
          this.groupLiquid = 0;
        } else {
          this.groupLiquid = this.GetLiquidTypeId(this.groupLiquid + 1);
        }

        if (this.groupLiquid) {
          this.liquflags |= 2;
        }
      } else if (fourcc === "MOPY") {
        this.MOPY = f.readBytes(size);
        this.mopy_size = size;
        this.nTriangles = Math.trunc(size / 2);
      } else if (fourcc === "MOVI") {
        this.MOVI = readInto(f, size, (n) => new Uint16Array(n), 2);
      } else if (fourcc === "MOVT") {
        this.MOVT = readInto(f, size, (n) => new Float32Array(n), 4);
        this.nVertices = Math.trunc(size / 12);
      } else if (fourcc === "MONR") {
        // normals
      } else if (fourcc === "MOTV") {
        // texture coordinates
      } else if (fourcc === "MOBA") {
        this.MOBA = readInto(f, size, (n) => new Uint16Array(n), 2);
        this.moba_size = Math.trunc(size / 2);
      } else if (fourcc === "MODR") {
        const count = Math.floor(size / 2);
        const refs = readInto(f, size, (n) => new Uint16Array(n), 2);
        this.DoodadReferences = Array.from(refs.subarray(0, count));
      } else if (fourcc === "MLIQ") {
        this.liquflags |= 1;
        const header = f.readBytes(WMO_LIQUID_HEADER_SIZE);
        const view = new DataView(header.buffer);
        const hlq: WMOLiquidHeader = {
          xverts: view.getInt32(0, true),
          yverts: view.getInt32(4, true),
          xtiles: view.getInt32(8, true),
          ytiles: view.getInt32(12, true),
          pos_x: view.getFloat32(16, true),
          pos_y: view.getFloat32(20, true),
          pos_z: view.getFloat32(24, true),
          material: view.getInt16(28, true),
        };
        this.hlq = hlq;
        this.LiquEx_size = 8 * hlq.xverts * hlq.yverts;
        const vertexCount = hlq.xverts * hlq.yverts;
        const liquEx = new Float32Array(vertexCount);
        const verts = f.readBytes(this.LiquEx_size);
        const vertView = new DataView(verts.buffer);
        for (let index = 0; index < vertexCount; ++index) {
          // WMOLiquidVert { uint16 unk1, unk2; float height; }
          liquEx[index] = vertView.getFloat32(index * 8 + 4, true);
        }
        this.LiquEx = liquEx;
        const nLiquBytes = hlq.xtiles * hlq.ytiles;
        this.LiquBytes = f.readBytes(nLiquBytes);

        // Determine legacy liquid type
        if (!this.groupLiquid) {
          for (let i = 0; i < hlq.xtiles * hlq.ytiles; ++i) {
            if ((this.LiquBytes[i]! & 0xf) !== 15) {
              this.groupLiquid = this.GetLiquidTypeId((this.LiquBytes[i]! & 0xf) + 1);
              break;
            }
          }
        }
      }
      f.seek(nextpos);
    }
    f.close();
    return true;
  }

  /** Writes the group into the raw WMO file and returns the number of collision triangles it wrote. */
  ConvertToVMAPGroupWmo(output: FileWriter, preciseVectorData: boolean): number {
    output.i32(this.mogpFlags);
    output.u32(this.groupWMOID);
    // group bound
    output.raw(new Uint8Array(this.bbcorn1.buffer));
    output.raw(new Uint8Array(this.bbcorn2.buffer));
    output.u32(this.liquflags);
    let nColTriangles = 0;
    const MOBA = this.MOBA;
    const MOVI = this.MOVI;
    const MOVT = this.MOVT;
    const MOPY = this.MOPY;

    // The "GRP " block, the same for both modes: the first uint16 of the 3rd uint32 of each MOBA batch.
    const writeGroupBlock = () => {
      output.latin1("GRP ");
      let k = 0;
      const moba_batch = Math.trunc(this.moba_size / 12);
      const mobaEx: number[] = [];
      for (let i = 8; i < this.moba_size; i += 12) {
        mobaEx[k++] = MOBA![i]!;
      }
      const moba_size_grp = moba_batch * 4 + 4;
      output.i32(moba_size_grp);
      output.i32(moba_batch);
      for (let index = 0; index < k; ++index) {
        output.i32(mobaEx[index]!);
      }
    };

    if (preciseVectorData) {
      writeGroupBlock();

      const nIdexes = this.nTriangles * 3;

      output.latin1("INDX");
      let wsize = 4 + 2 * nIdexes;
      output.i32(wsize);
      output.u32(nIdexes);
      if (nIdexes > 0) {
        output.raw(new Uint8Array(MOVI!.buffer, MOVI!.byteOffset, nIdexes * 2));
      }

      output.latin1("VERT");
      wsize = 4 + 4 * 3 * this.nVertices;
      output.i32(wsize);
      output.i32(this.nVertices);
      if (this.nVertices > 0) {
        output.raw(new Uint8Array(MOVT!.buffer, MOVT!.byteOffset, 12 * this.nVertices));
      }

      nColTriangles = this.nTriangles;
    } else {
      writeGroupBlock();

      //-------INDX------------------------------------
      //-------MOPY--------
      const MoviEx = new Uint16Array(this.nTriangles * 3); // "worst case" size...
      const IndexRenum = new Int32Array(this.nVertices).fill(-1);
      for (let i = 0; i < this.nTriangles; ++i) {
        // Skip no collision triangles
        // TODO: Update to use MOBR in the future to catch any possibly missed edge cases
        const material = MOPY![2 * i]!;
        const isRenderFace = (material & WMO_MATERIAL_RENDER) !== 0 && (material & WMO_MATERIAL_DETAIL) === 0;
        const isCollisionOnlyFace = MOPY![2 * i + 1]! === 0xff; // 255 is a collision-only material id
        const isCollision = (material & WMO_MATERIAL_COLLISION) !== 0 || isRenderFace || isCollisionOnlyFace;
        if (!isCollision) {
          continue;
        }
        // Use this triangle
        for (let j = 0; j < 3; ++j) {
          IndexRenum[MOVI![3 * i + j]!] = 1;
          MoviEx[3 * nColTriangles + j] = MOVI![3 * i + j]!;
        }
        ++nColTriangles;
      }

      // assign new vertex index numbers
      let nColVertices = 0;
      for (let i = 0; i < this.nVertices; ++i) {
        if (IndexRenum[i] === 1) {
          IndexRenum[i] = nColVertices;
          ++nColVertices;
        }
      }

      // translate triangle indices to new numbers
      for (let i = 0; i < 3 * nColTriangles; ++i) {
        // assert(MoviEx[i] < nVertices) is compiled out of release builds
        MoviEx[i] = IndexRenum[MoviEx[i]!] ?? 0;
      }

      // write triangle indices
      output.latin1("INDX");
      output.i32(nColTriangles * 6 + 4);
      output.i32(nColTriangles * 3);
      output.raw(new Uint8Array(MoviEx.buffer, 0, nColTriangles * 6));

      // write vertices
      output.latin1("VERT");
      output.i32(nColVertices * 3 * 4 + 4);
      output.i32(nColVertices);
      for (let i = 0; i < this.nVertices; ++i) {
        if (IndexRenum[i]! >= 0) {
          output.raw(new Uint8Array(MOVT!.buffer, MOVT!.byteOffset + 12 * i, 12));
        }
      }
    }

    //------LIQU------------------------
    if (this.liquflags & 3) {
      const hlq = this.hlq!;
      let LIQU_totalSize = 4;
      if (this.liquflags & 1) {
        LIQU_totalSize += WMO_LIQUID_HEADER_SIZE;
        LIQU_totalSize += (this.LiquEx_size / 8) * 4;
        LIQU_totalSize += hlq.xtiles * hlq.ytiles;
      }

      output.latin1("LIQU");
      output.i32(LIQU_totalSize);

      output.u32(this.groupLiquid);
      if (this.liquflags & 1) {
        output.i32(hlq.xverts);
        output.i32(hlq.yverts);
        output.i32(hlq.xtiles);
        output.i32(hlq.ytiles);
        output.f32(hlq.pos_x);
        output.f32(hlq.pos_y);
        output.f32(hlq.pos_z);
        output.u16(hlq.material & 0xffff);
        // only need height values, the other values are unknown anyway
        const liquEx = this.LiquEx!;
        for (let i = 0; i < this.LiquEx_size / 8; ++i) {
          output.f32(liquEx[i]!);
        }
        /// @todo: compress to bit field
        output.raw(this.LiquBytes!.subarray(0, hlq.xtiles * hlq.ytiles));
      }
    }

    return nColTriangles;
  }

  GetLiquidTypeId(liquidTypeId: number): number {
    if (liquidTypeId < 21 && liquidTypeId) {
      switch (((liquidTypeId & 0xff) - 1) & 3) {
        case 0:
          return ((this.mogpFlags & 0x80000) !== 0 ? 1 : 0) + 13;
        case 1:
          return 14;
        case 2:
          return 19;
        case 3:
          return 20;
        default:
          break;
      }
    }
    return liquidTypeId;
  }

  ShouldSkip(root: WMORoot): boolean {
    // skip unreachable
    if (this.mogpFlags & 0x80) {
      return true;
    }

    // skip antiportals
    if (this.mogpFlags & 0x4000000) {
      return true;
    }

    if (this.groupName >= 0 && this.groupName < root.GroupNames.length && cString(root.GroupNames, this.groupName, root.GroupNames.length) === "antiportal") {
      return true;
    }

    return false;
  }
}

export const MapObject = {
  /** @ac tools/vmap4_extractor/wmo.cpp MapObject::Extract */
  Extract(mapObjDef: MODF, WmoInstName: string, mapID: number, tileX: number, tileY: number, pDirfile: FileWriter): void {
    // destructible wmo, do not dump. we can handle the vmap for these
    // in dynamic tree (gameobject vmaps)
    if ((mapObjDef.Flags & 0x1) !== 0) {
      return;
    }

    //-----------add_in _dir_file----------------
    const nVertices = getModelVertexCount(WmoInstName);
    if (nVertices === undefined) {
      console.log(`WMOInstance::WMOInstance: couldn't open ${globals.szWorkDirWmo}/${WmoInstName}`);
      return;
    }
    if (nVertices === 0) {
      return;
    }

    const position = new Vec3D(mapObjDef.Position.x, mapObjDef.Position.y, mapObjDef.Position.z);

    const x = position.x;
    const z = position.z;
    if (x === 0 && z === 0) {
      position.x = Math.fround(Math.fround(533.33333) * 32);
      position.z = Math.fround(Math.fround(533.33333) * 32);
    }
    const fixed = fixCoords(position);
    const bounds = new AaBox3D();
    bounds.min = fixCoords(mapObjDef.Bounds.min);
    bounds.max = fixCoords(mapObjDef.Bounds.max);

    const scale = 1.0;
    const uniqueId = GenerateUniqueObjectId(mapObjDef.UniqueId, 0);
    let flags = MOD_HAS_BOUND;
    if (tileX === 65 && tileY === 65) {
      flags |= MOD_WORLDSPAWN;
    }
    // write mapID, tileX, tileY, Flags, NameSet, UniqueId, Pos, Rot, Scale, Bound_lo, Bound_hi, name
    pDirfile.u32(mapID);
    pDirfile.u32(tileX);
    pDirfile.u32(tileY);
    pDirfile.u32(flags);
    pDirfile.u16(mapObjDef.NameSet);
    pDirfile.u32(uniqueId);
    pDirfile.f32(fixed.x);
    pDirfile.f32(fixed.y);
    pDirfile.f32(fixed.z);
    pDirfile.f32(mapObjDef.Rotation.x);
    pDirfile.f32(mapObjDef.Rotation.y);
    pDirfile.f32(mapObjDef.Rotation.z);
    pDirfile.f32(scale);
    pDirfile.f32(bounds.min.x);
    pDirfile.f32(bounds.min.y);
    pDirfile.f32(bounds.min.z);
    pDirfile.f32(bounds.max.x);
    pDirfile.f32(bounds.max.y);
    pDirfile.f32(bounds.max.z);
    pDirfile.u32(WmoInstName.length);
    pDirfile.latin1(WmoInstName);
  },
};

