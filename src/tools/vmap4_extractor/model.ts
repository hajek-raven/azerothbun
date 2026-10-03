import { GetPlainName, fixname2, fixnamen, type MDDF, type MODF } from "./adtfile.ts";
import { FileWriter, bytesToLatin1 } from "./fileio.ts";
import { Matrix3, toDegrees, toRadians } from "./g3d.ts";
import { emptyModelHeader, readModelHeader, type ModelHeader } from "./modelheaders.ts";
import { MPQFile } from "./mpq_libmpq04.ts";
import { Vec3D } from "./vec3d.ts";
import { MOD_M2, MOD_WORLDSPAWN, RAW_VMAP_MAGIC, GenerateUniqueObjectId, getModelVertexCount } from "./vmapexport.ts";
import { fixCoords, type WMODoodadData } from "./wmo.ts";

/** @ac tools/vmap4_extractor/model.cpp fixCoordSystem */
export function fixCoordSystem(v: Vec3D): Vec3D {
  return new Vec3D(v.x, v.z, -v.y);
}

/**
 * @ac tools/vmap4_extractor/model.h Model
 * @ac tools/vmap4_extractor/model.cpp Model::Model
 * @ac tools/vmap4_extractor/model.cpp Model::open
 * @ac tools/vmap4_extractor/model.cpp Model::ConvertToVMAPModel
 */
export class Model {
  header: ModelHeader = emptyModelHeader();
  /** x, y, z per bounding vertex. */
  vertices: Float32Array | null = null;
  indices: Uint16Array | null = null;

  constructor(private readonly filename: string) {}

  /** @ac tools/vmap4_extractor/model.h Model::_unload */
  private _unload(): void {
    this.vertices = null;
    this.indices = null;
  }

  open(): boolean {
    const f = new MPQFile(this.filename);

    if (f.isEof()) {
      f.close();
      // Do not show this error on console to avoid confusion, the extractor can continue working even if some models fail to load
      return false;
    }

    this._unload();

    this.header = readModelHeader(f.getBuffer()!);
    const header = this.header;
    if (header.nBoundingTriangles > 0) {
      f.seek(0);
      f.seekRelative(header.ofsBoundingVertices);
      const raw = new Float32Array(header.nBoundingVertices * 3);
      f.read(new Uint8Array(raw.buffer), header.nBoundingVertices * 12);
      const vertices = new Float32Array(header.nBoundingVertices * 3);
      for (let i = 0; i < header.nBoundingVertices; i++) {
        // vertices[i] = fixCoordSystem(vertices[i])
        vertices[i * 3] = raw[i * 3]!;
        vertices[i * 3 + 1] = raw[i * 3 + 2]!;
        vertices[i * 3 + 2] = -raw[i * 3 + 1]!;
      }
      this.vertices = vertices;
      f.seek(0);
      f.seekRelative(header.ofsBoundingTriangles);
      const indices = new Uint16Array(header.nBoundingTriangles);
      f.read(new Uint8Array(indices.buffer), header.nBoundingTriangles * 2);
      this.indices = indices;
      f.close();
    } else {
      f.close();
      return false;
    }
    return true;
  }

  /** Writes the raw vmap model (`VMAP048`, one group "GRP ", "INDX", "VERT"). False when the file cannot be created. */
  ConvertToVMAPModel(outfilename: string): boolean {
    const output = FileWriter.open(outfilename);
    if (!output) {
      console.log(`Can't create the output file '${outfilename}'`);
      return false;
    }
    const vertices = this.vertices!;
    const indices = this.indices!;
    output.latin1(RAW_VMAP_MAGIC, 8);
    const nVertices = this.header.nBoundingVertices;
    output.u32(nVertices);
    const nofgroups = 1;
    output.u32(nofgroups);
    output.raw(new Uint8Array(12)); // rootwmoid, flags, groupid
    output.raw(new Uint8Array(24)); // bbox, only needed for WMO currently
    output.raw(new Uint8Array(4)); // liquidflags
    output.latin1("GRP ");
    const branches = 1;
    let wsize = 4 + 4 * branches;
    output.i32(wsize);
    output.u32(branches);
    const nIndexes = this.header.nBoundingTriangles;
    output.u32(nIndexes);
    output.latin1("INDX");
    wsize = 4 + 2 * nIndexes;
    output.i32(wsize);
    output.u32(nIndexes);
    if (nIndexes > 0) {
      for (let i = 0; i < nIndexes; ++i) {
        if (i % 3 === 1 && i + 1 < nIndexes) {
          const tmp = indices[i]!;
          indices[i] = indices[i + 1]!;
          indices[i + 1] = tmp;
        }
      }
      output.raw(new Uint8Array(indices.buffer, indices.byteOffset, nIndexes * 2));
    }
    output.latin1("VERT");
    wsize = 4 + 4 * 3 * nVertices;
    output.i32(wsize);
    output.u32(nVertices);
    if (nVertices > 0) {
      for (let vpos = 0; vpos < nVertices; ++vpos) {
        const tmp = vertices[vpos * 3 + 1]!;
        vertices[vpos * 3 + 1] = -vertices[vpos * 3 + 2]!;
        vertices[vpos * 3 + 2] = tmp;
      }
      output.raw(new Uint8Array(vertices.buffer, vertices.byteOffset, nVertices * 12));
    }

    output.close();
    return true;
  }
}

/** One record of dir_bin: mapID, tileX, tileY, flags, nameSet, uniqueId, position, rotation, scale, [bound,] name. */
export const Doodad = {
  /** @ac tools/vmap4_extractor/model.cpp Doodad::Extract */
  Extract(doodadDef: MDDF, ModelInstName: string, mapID: number, tileX: number, tileY: number, pDirfile: FileWriter): void {
    const nVertices = getModelVertexCount(ModelInstName);
    if (nVertices === undefined || nVertices === 0) {
      return;
    }

    // scale factor - divide by 1024. blizzard devs must be on crack, why not just use a float?
    const sc = Math.fround(doodadDef.Scale / 1024);

    const position = fixCoords(doodadDef.Position);

    const nameSet = 0; // not used for models
    const uniqueId = GenerateUniqueObjectId(doodadDef.UniqueId, 0);
    let tcflags = MOD_M2;
    if (tileX === 65 && tileY === 65) {
      tcflags |= MOD_WORLDSPAWN;
    }

    // write mapID, tileX, tileY, Flags, NameSet, UniqueId, Pos, Rot, Scale, name
    pDirfile.u32(mapID);
    pDirfile.u32(tileX);
    pDirfile.u32(tileY);
    pDirfile.u32(tcflags);
    pDirfile.u16(nameSet);
    pDirfile.u32(uniqueId);
    pDirfile.f32(position.x);
    pDirfile.f32(position.y);
    pDirfile.f32(position.z);
    pDirfile.f32(doodadDef.Rotation.x);
    pDirfile.f32(doodadDef.Rotation.y);
    pDirfile.f32(doodadDef.Rotation.z);
    pDirfile.f32(sc);
    pDirfile.u32(ModelInstName.length);
    pDirfile.latin1(ModelInstName);
  },

  /** @ac tools/vmap4_extractor/model.cpp Doodad::ExtractSet */
  ExtractSet(doodadData: WMODoodadData, wmo: MODF, mapID: number, tileX: number, tileY: number, pDirfile: FileWriter): void {
    if (wmo.DoodadSet >= doodadData.Sets.length) {
      return;
    }

    const f = Math.fround;
    const wmoPosition = new Vec3D(wmo.Position.z, wmo.Position.x, wmo.Position.y);
    const wmoRotation = Matrix3.fromEulerAnglesZYX(toRadians(wmo.Rotation.y), toRadians(wmo.Rotation.x), toRadians(wmo.Rotation.z));
    const rotated = new Float32Array(3);
    const euler = new Float32Array(3);

    let doodadId = 0;
    const doodadSetData = doodadData.Sets[wmo.DoodadSet]!;
    for (const doodadIndex of doodadData.References) {
      if (doodadIndex < doodadSetData.StartIndex || doodadIndex >= doodadSetData.StartIndex + doodadSetData.Count) {
        continue;
      }

      const doodad = doodadData.Spawns[doodadIndex]!;

      // sprintf(ModelInstName, "%s", GetPlainName(&doodadData.Paths[doodad.NameIndex]))
      const paths = doodadData.Paths!;
      let end = doodad.NameIndex;
      while (end < paths.length && paths[end] !== 0) {
        ++end;
      }
      let ModelInstName = GetPlainName(bytesToLatin1(paths, doodad.NameIndex, end));
      const nlen = ModelInstName.length;
      ModelInstName = fixname2(fixnamen(ModelInstName, nlen), nlen);
      if (nlen > 3) {
        const extension = ModelInstName.slice(nlen - 4);
        if (extension === ".mdx" || extension === ".mdl") {
          // C++: ModelInstName[nlen - 2] = '2'; ModelInstName[nlen - 1] = '\0'; with nlen not updated, so dir_bin gets an
          // nlen byte name that ends in a NUL. The assembler and the runtime then open files through c_str(), which cuts
          // the name at the NUL (so the .vmo lands under the name without the ".vmo" suffix). This port deviates on
          // purpose: it writes the name without the NUL and with its real length, which both the C++ and the TS
          // assembler / runtime handle and which gives the regular "<name>.m2.vmo" file.
          ModelInstName = `${ModelInstName.slice(0, nlen - 2)}2`;
        }
      }

      const nVertices = getModelVertexCount(ModelInstName);
      if (nVertices === undefined || nVertices === 0) {
        continue;
      }

      if (doodadId >= 0xffff) {
        throw new Error("assertion failed: doodadId < std::numeric_limits<uint16>::max()");
      }
      ++doodadId;

      // G3D::Vector3 position = wmoPosition + (wmoRotation * G3D::Vector3(doodad.Position))
      wmoRotation.mulVec(doodad.Position.x, doodad.Position.y, doodad.Position.z, rotated);
      const px = f(wmoPosition.x + rotated[0]!);
      const py = f(wmoPosition.y + rotated[1]!);
      const pz = f(wmoPosition.z + rotated[2]!);

      Matrix3.fromQuat(doodad.Rotation.X, doodad.Rotation.Y, doodad.Rotation.Z, doodad.Rotation.W)
        .mul(wmoRotation)
        .toEulerAnglesXYZ(euler);
      // toEulerAnglesXYZ(rotation.z, rotation.x, rotation.y)
      const rotationZ = toDegrees(euler[0]!);
      const rotationX = toDegrees(euler[1]!);
      const rotationY = toDegrees(euler[2]!);

      const nameSet = 0; // not used for models
      const uniqueId = GenerateUniqueObjectId(wmo.UniqueId, doodadId);
      let tcflags = MOD_M2;
      if (tileX === 65 && tileY === 65) {
        tcflags |= MOD_WORLDSPAWN;
      }

      // write mapID, tileX, tileY, Flags, NameSet, UniqueId, Pos, Rot, Scale, name
      pDirfile.u32(mapID);
      pDirfile.u32(tileX);
      pDirfile.u32(tileY);
      pDirfile.u32(tcflags);
      pDirfile.u16(nameSet);
      pDirfile.u32(uniqueId);
      pDirfile.f32(px);
      pDirfile.f32(py);
      pDirfile.f32(pz);
      pDirfile.f32(rotationX);
      pDirfile.f32(rotationY);
      pDirfile.f32(rotationZ);
      pDirfile.f32(doodad.Scale);
      pDirfile.u32(ModelInstName.length);
      pDirfile.latin1(ModelInstName);
    }
  },
};

