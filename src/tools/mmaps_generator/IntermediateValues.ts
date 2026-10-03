/**
 * Port of `tools/mmaps_generator/IntermediateValues.{h,cpp}`: the optional debug output of the generator (the Recast
 * intermediates and an `.obj` of the input mesh, for RecastDemo).
 *
 * The structs are written with the x86-64 layout of the C++ build (`rcSpan` is 16 bytes: a `uint32` holding `smin`
 * and `smax`, the `area` byte, padding and the `next` pointer, written as 0).
 */
import { WriteFile } from "../../common/Collision/BinaryFile.ts";
import {
  type rcCompactHeightfield,
  type rcContourSet,
  type rcHeightfield,
  type rcPolyMesh,
  type rcPolyMeshDetail,
} from "../../common/Recast/Recast.ts";
import { G3DArray, type MeshData, TerrainBuilder } from "./TerrainBuilder.ts";

const pad = (n: number, w: number): string => String(n).padStart(w, "0");

/** this class gathers all debug info holding and output. @ac tools/mmaps_generator/IntermediateValues.h MMAP::IntermediateValues */
export class IntermediateValues {
  heightfield: rcHeightfield | null = null;
  compactHeightfield: rcCompactHeightfield | null = null;
  contours: rcContourSet | null = null;
  polyMesh: rcPolyMesh | null = null;
  polyMeshDetail: rcPolyMeshDetail | null = null;

  /** @ac tools/mmaps_generator/IntermediateValues.cpp MMAP::IntermediateValues::writeIV */
  async writeIV(dataPath: string, mapID: number, tileX: number, tileY: number): Promise<void> {
    const tileString = `[${pad(tileX, 2)},${pad(tileY, 2)}]: `;

    process.stdout.write(`${tileString}Writing debug output...                       \r`);

    const name = `${dataPath}/meshes/${pad(mapID, 3)}${pad(tileY, 2)}${pad(tileX, 2)}.`;

    const DEBUG_WRITE = async (fileExtension: string, write: (file: WriteFile) => void): Promise<void> => {
      const fileName = name + fileExtension;
      const file = new WriteFile();
      write(file);
      try {
        await Bun.write(fileName, file.toBytes());
      } catch (e) {
        console.error(`${tileString}Failed to open ${fileName} for writing!\n: ${(e as Error).message}`);
      }
      process.stdout.write(`${tileString}Writing debug output...                       \r`);
    };

    if (this.heightfield) {
      const hf = this.heightfield;
      await DEBUG_WRITE("hf", (f) => this.debugWriteHeightfield(f, hf));
    }
    if (this.compactHeightfield) {
      const chf = this.compactHeightfield;
      await DEBUG_WRITE("chf", (f) => this.debugWriteCompact(f, chf));
    }
    if (this.contours) {
      const cs = this.contours;
      await DEBUG_WRITE("cs", (f) => this.debugWriteContours(f, cs));
    }
    if (this.polyMesh) {
      const pm = this.polyMesh;
      await DEBUG_WRITE("pmesh", (f) => this.debugWritePolyMesh(f, pm));
    }
    if (this.polyMeshDetail) {
      const dm = this.polyMeshDetail;
      await DEBUG_WRITE("dmesh", (f) => this.debugWriteDetail(f, dm));
    }
  }

  /** `debugWrite(FILE*, rcHeightfield const*)` @ac tools/mmaps_generator/IntermediateValues.cpp MMAP::IntermediateValues::debugWrite */
  debugWriteHeightfield(file: WriteFile, mesh: rcHeightfield | null): void {
    if (!mesh) return;

    file.f32(mesh.cs);
    file.f32(mesh.ch);
    file.i32(mesh.width);
    file.i32(mesh.height);
    file.f32Array(mesh.bmin, 3);
    file.f32Array(mesh.bmax, 3);

    const { smin, smax, area, next } = mesh.pools;
    for (let y = 0; y < mesh.height; ++y)
      for (let x = 0; x < mesh.width; ++x) {
        const first = mesh.spans[x + y * mesh.width]!;

        // first, count the number of spans
        let spanCount = 0;
        for (let s = first; s; s = next[s]!) spanCount++;

        // write the span count
        file.i32(spanCount);

        // write the spans
        for (let s = first; s; s = next[s]!) {
          file.u32((smin[s]! | (smax[s]! << 16)) >>> 0);
          file.u8(area[s]!);
          file.u8(0);
          file.u8(0);
          file.u8(0);
          file.u32(0); // rcSpan* next (a 64 bit pointer, not meaningful in a file)
          file.u32(0);
        }
      }
  }

  /** `debugWrite(FILE*, rcCompactHeightfield const*)` @ac tools/mmaps_generator/IntermediateValues.cpp MMAP::IntermediateValues::debugWrite */
  debugWriteCompact(file: WriteFile, chf: rcCompactHeightfield | null): void {
    if (!chf) return;

    file.i32(chf.width);
    file.i32(chf.height);
    file.i32(chf.spanCount);

    file.i32(chf.walkableHeight);
    file.i32(chf.walkableClimb);

    file.u16(chf.maxDistance);
    file.u16(chf.maxRegions);

    file.f32Array(chf.bmin, 3);
    file.f32Array(chf.bmax, 3);

    file.f32(chf.cs);
    file.f32(chf.ch);

    let tmp = 0;
    tmp |= 1; // cells
    tmp |= 2; // spans
    if (chf.dist) tmp |= 4;
    tmp |= 8; // areas

    file.i32(tmp);

    for (let i = 0; i < chf.width * chf.height; ++i) file.u32(((chf.cells.index[i]! & 0xffffff) | (chf.cells.count[i]! << 24)) >>> 0);
    for (let i = 0; i < chf.spanCount; ++i) {
      file.u16(chf.spans.y[i]!);
      file.u16(chf.spans.reg[i]!);
      file.u32(((chf.spans.con[i]! & 0xffffff) | (chf.spans.h[i]! << 24)) >>> 0);
    }
    if (chf.dist) file.u16Array(chf.dist, chf.spanCount);
    file.bytes(chf.areas.subarray(0, chf.spanCount));
  }

  /** `debugWrite(FILE*, rcContourSet const*)` @ac tools/mmaps_generator/IntermediateValues.cpp MMAP::IntermediateValues::debugWrite */
  debugWriteContours(file: WriteFile, cs: rcContourSet | null): void {
    if (!cs) return;

    file.f32(cs.cs);
    file.f32(cs.ch);
    file.f32Array(cs.bmin, 3);
    file.f32Array(cs.bmax, 3);
    file.i32(cs.nconts);
    for (let i = 0; i < cs.nconts; ++i) {
      const c = cs.conts[i]!;
      file.u8(c.area);
      file.u16(c.reg);
      file.i32(c.nverts);
      for (let k = 0; k < c.nverts * 4; ++k) file.i32(c.verts![k]!);
      file.i32(c.nrverts);
      for (let k = 0; k < c.nrverts * 4; ++k) file.i32(c.rverts![k]!);
    }
  }

  /** `debugWrite(FILE*, rcPolyMesh const*)` @ac tools/mmaps_generator/IntermediateValues.cpp MMAP::IntermediateValues::debugWrite */
  debugWritePolyMesh(file: WriteFile, mesh: rcPolyMesh | null): void {
    if (!mesh) return;

    file.f32(mesh.cs);
    file.f32(mesh.ch);
    file.i32(mesh.nvp);
    file.f32Array(mesh.bmin, 3);
    file.f32Array(mesh.bmax, 3);
    file.i32(mesh.nverts);
    file.u16Array(mesh.verts!, mesh.nverts * 3);
    file.i32(mesh.npolys);
    file.u16Array(mesh.polys!, mesh.npolys * mesh.nvp * 2);
    file.u16Array(mesh.flags!, mesh.npolys);
    file.bytes(mesh.areas!.subarray(0, mesh.npolys));
    file.u16Array(mesh.regs!, mesh.npolys);
  }

  /** `debugWrite(FILE*, rcPolyMeshDetail const*)` @ac tools/mmaps_generator/IntermediateValues.cpp MMAP::IntermediateValues::debugWrite */
  debugWriteDetail(file: WriteFile, mesh: rcPolyMeshDetail | null): void {
    if (!mesh) return;

    file.i32(mesh.nverts);
    file.f32Array(mesh.verts!, mesh.nverts * 3);
    file.i32(mesh.ntris);
    file.bytes(mesh.tris!.subarray(0, mesh.ntris * 4));
    file.i32(mesh.nmeshes);
    file.u32Array(mesh.meshes!, mesh.nmeshes * 4);
  }

  /** @ac tools/mmaps_generator/IntermediateValues.cpp MMAP::IntermediateValues::generateObjFile */
  async generateObjFile(dataPath: string, mapID: number, tileX: number, tileY: number, meshData: MeshData): Promise<void> {
    let objFileName = `${dataPath}/meshes/map${pad(mapID, 3)}${pad(tileY, 2)}${pad(tileX, 2)}.obj`;

    const allVerts = new G3DArray(Float32Array);
    const allTris = new G3DArray(Int32Array);

    allTris.appendArray(meshData.liquidTris);
    allVerts.appendArray(meshData.liquidVerts);
    TerrainBuilder.copyIndicesArray(meshData.solidTris, allTris, (allVerts.size() / 3) | 0);
    allVerts.appendArray(meshData.solidVerts);

    const verts = allVerts.getCArray();
    const vertCount = (allVerts.size() / 3) | 0;
    const tris = allTris.getCArray();
    const triCount = (allTris.size() / 3) | 0;

    let obj = "";
    for (let i = 0; i < vertCount; i++) obj += `v ${verts[i * 3]!.toFixed(6)} ${verts[i * 3 + 1]!.toFixed(6)} ${verts[i * 3 + 2]!.toFixed(6)}\n`;

    for (let i = 0; i < triCount; i++) obj += `f ${tris[i * 3]! + 1} ${tris[i * 3 + 1]! + 1} ${tris[i * 3 + 2]! + 1}\n`;

    try {
      await Bun.write(objFileName, obj);
    } catch (e) {
      console.error(`Failed to open ${objFileName} for writing!\n: ${(e as Error).message}`);
      return;
    }

    const tileString = `[${pad(tileY, 2)},${pad(tileX, 2)}]: `;
    process.stdout.write(`${tileString}Writing debug output...                       \r`);

    objFileName = `${dataPath}/meshes/${pad(mapID, 3)}.map`;
    try {
      await Bun.write(objFileName, new Uint8Array(1));
    } catch (e) {
      console.error(`Failed to open ${objFileName} for writing!\n: ${(e as Error).message}`);
      return;
    }

    objFileName = `${dataPath}/meshes/${pad(mapID, 3)}${pad(tileY, 2)}${pad(tileX, 2)}.mesh`;

    const mesh = new WriteFile();
    mesh.i32(vertCount);
    mesh.f32Array(verts, vertCount * 3);
    mesh.i32(triCount);
    mesh.u32Array(tris, triCount * 3);
    try {
      await Bun.write(objFileName, mesh.toBytes());
    } catch (e) {
      console.error(`Failed to open ${objFileName} for writing!\n: ${(e as Error).message}`);
    }
  }
}
