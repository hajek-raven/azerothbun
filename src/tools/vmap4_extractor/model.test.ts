import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { WorldModel_Raw } from "../../common/Collision/Maps/TileAssembler.ts";
import type { MDDF, MODF } from "./adtfile.ts";
import { FileWriter } from "./fileio.ts";
import { Doodad, Model } from "./model.ts";
import { AaBox3D, Vec3D } from "./vec3d.ts";
import { ExtractSingleModel, GenerateUniqueObjectId, getModelVertexCount } from "./vmapexport.ts";
import { newWMODoodadData } from "./wmo.ts";
import { Bytes, buildM2, useArchive, useWorkDir, view } from "./vmap4.test-util.ts";

let work: ReturnType<typeof useWorkDir>;
beforeEach(() => {
  work = useWorkDir();
});
afterEach(() => work.cleanup());

// client coordinates (x, y, z); the extractor stores (x, z, -y) and then (x, -z, y) again for the file
const m2 = buildM2(
  [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
  ],
  [0, 1, 2],
);

function read(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

describe("Model", () => {
  test("ConvertToVMAPModel writes the raw model", () => {
    useArchive({ "World\\Foo\\Bar.m2": m2 });
    const model = new Model("World\\Foo\\Bar.m2");
    expect(model.open()).toBe(true);
    expect(model.header.nBoundingVertices).toBe(3);
    expect(model.header.nBoundingTriangles).toBe(3);
    // open: vertices go through fixCoordSystem (x, z, -y)
    expect(Array.from(model.vertices!)).toEqual([1, 3, -2, 4, 6, -5, 7, 9, -8]);

    const out = `${work.dir}/Bar.m2`;
    expect(model.ConvertToVMAPModel(out)).toBe(true);

    const expected = new Bytes().text("VMAP048").u8(0).u32(3).u32(1).zeros(12).zeros(24).zeros(4);
    expected.text("GRP ").u32(8).u32(1).u32(3);
    // indices 0,1,2: the second of every triple swaps with the third
    expected.text("INDX").u32(4 + 6).u32(3).u16(0).u16(2).u16(1);
    expected.text("VERT").u32(4 + 36).u32(3);
    for (const value of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expected.f32(value);
    expect(Array.from(read(out))).toEqual(Array.from(expected.done()));
    expect(read(out)).toHaveLength(138);
  });

  test("the raw model is readable by the assembler", () => {
    useArchive({ "World\\Foo\\Bar.m2": m2 });
    expect(ExtractSingleModel({ value: "World\\Foo\\Bar.m2" })).toBe(true);
    const raw = new WorldModel_Raw();
    expect(raw.Read(`${work.dir}/Bar.m2`)).toBe(true);
    expect(raw.groupsArray).toHaveLength(1);
    expect(Array.from(raw.groupsArray[0]!.triangles)).toEqual([0, 2, 1]);
    expect(Array.from(raw.groupsArray[0]!.vertexArray)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("a model without bounding triangles, or a missing one, does not open", () => {
    useArchive({ "a.m2": buildM2([[0, 0, 0]], []) });
    expect(new Model("a.m2").open()).toBe(false);
    expect(new Model("missing.m2").open()).toBe(false);
  });
});

describe("ExtractSingleModel", () => {
  test(".mdx names become .m2, the plain name is fixed up, and an existing file is kept", () => {
    useArchive({ "WORLD\\GENERIC\\PASSIVE DOODADS\\BOTTLE 01.M2": m2 });
    const path = { value: "WORLD\\GENERIC\\PASSIVE DOODADS\\BOTTLE 01.MDX" };
    // the archive has the .m2 name only: the .mdx name is rewritten to .m2 before the lookup
    expect(ExtractSingleModel(path)).toBe(true);
    expect(path.value).toBe("WORLD\\GENERIC\\PASSIVE DOODADS\\Bottle_01.m2");
    expect(existsSync(`${work.dir}/Bottle_01.m2`)).toBe(true);
    expect(getModelVertexCount("Bottle_01.m2")).toBe(3);
    expect(ExtractSingleModel({ value: "WORLD\\GENERIC\\PASSIVE DOODADS\\BOTTLE 01.M2" })).toBe(true);
    expect(ExtractSingleModel({ value: "abc" })).toBe(false);
    expect(ExtractSingleModel({ value: "Nothing.m2" })).toBe(false);
  });
});

function mddf(): MDDF {
  return { Id: 0, UniqueId: 1234, Position: new Vec3D(100, 200, 300), Rotation: new Vec3D(10, 20, 30), Scale: 2048, Flags: 0 };
}

describe("Doodad", () => {
  test("Extract writes one dir_bin record (position as z, x, y; scale / 1024)", () => {
    useArchive({ "World\\Foo\\Bar.m2": m2 });
    ExtractSingleModel({ value: "World\\Foo\\Bar.m2" });
    const dir = FileWriter.open(`${work.dir}/dir_bin`, true)!;
    Doodad.Extract(mddf(), "Bar.m2", 1, 30, 40, dir);
    Doodad.Extract(mddf(), "Missing.m2", 1, 30, 40, dir); // no extracted file: no record
    dir.close();
    const raw = read(`${work.dir}/dir_bin`);
    const v = view(raw);
    expect(raw).toHaveLength(54 + 6);
    expect([0, 4, 8, 12].map((at) => v.getUint32(at, true))).toEqual([1, 30, 40, 1]); // map, tile x, tile y, MOD_M2
    expect(v.getUint16(16, true)).toBe(0);
    expect(v.getUint32(18, true)).toBe(1); // first unique id handed out
    expect([22, 26, 30].map((at) => v.getFloat32(at, true))).toEqual([300, 100, 200]);
    expect([34, 38, 42].map((at) => v.getFloat32(at, true))).toEqual([10, 20, 30]);
    expect(v.getFloat32(46, true)).toBe(2);
    expect(v.getUint32(50, true)).toBe(6);
    expect(String.fromCharCode(...raw.subarray(54))).toBe("Bar.m2");
  });

  test("a world spawn tile (65, 65) sets MOD_WORLDSPAWN, the same client id keeps its unique id", () => {
    useArchive({ "World\\Foo\\Bar.m2": m2 });
    ExtractSingleModel({ value: "World\\Foo\\Bar.m2" });
    const dir = FileWriter.open(`${work.dir}/dir_bin`, true)!;
    Doodad.Extract(mddf(), "Bar.m2", 1, 65, 65, dir);
    dir.close();
    const v = view(read(`${work.dir}/dir_bin`));
    expect(v.getUint32(12, true)).toBe(1 | 2);
    expect(GenerateUniqueObjectId(1234, 0)).toBe(1);
    expect(GenerateUniqueObjectId(99, 0)).toBe(2);
    expect(GenerateUniqueObjectId(1234, 0)).toBe(1);
    expect(GenerateUniqueObjectId(1234, 1)).toBe(3);
  });

  test("ExtractSet places the doodads of a set relative to the WMO (identity rotation)", () => {
    useArchive({ "World\\Foo\\Bar.m2": m2 });
    ExtractSingleModel({ value: "World\\Foo\\Bar.m2" });
    const data = newWMODoodadData();
    data.Sets.push({ Name: "Set", StartIndex: 0, Count: 1 });
    data.Paths = new Bytes().text("Foo\\Bar.mdx").u8(0).done();
    data.Spawns.push({ NameIndex: 0, Position: new Vec3D(1, 2, 3), Rotation: { X: 0, Y: 0, Z: 0, W: 1 }, Scale: 1.5, Color: 0 });
    data.Spawns.push({ NameIndex: 0, Position: new Vec3D(9, 9, 9), Rotation: { X: 0, Y: 0, Z: 0, W: 1 }, Scale: 1, Color: 0 });
    data.References.add(0);
    data.References.add(1); // outside the set [0, 1): skipped
    const wmo: MODF = { Id: 0, UniqueId: 555, Position: new Vec3D(100, 200, 300), Rotation: new Vec3D(0, 0, 0), Bounds: new AaBox3D(), Flags: 0, DoodadSet: 0, NameSet: 0, Scale: 1024 };
    const dir = FileWriter.open(`${work.dir}/dir_bin`, true)!;
    Doodad.ExtractSet(data, wmo, 1, 2, 3, dir);
    wmo.DoodadSet = 1; // no such set
    Doodad.ExtractSet(data, wmo, 1, 2, 3, dir);
    dir.close();
    const raw = read(`${work.dir}/dir_bin`);
    const v = view(raw);
    expect(raw).toHaveLength(54 + 6);
    expect([0, 4, 8, 12].map((at) => v.getUint32(at, true))).toEqual([1, 2, 3, 1]);
    expect(v.getUint32(18, true)).toBe(1);
    // wmoPosition (z, x, y) = (300, 100, 200) plus the doodad offset (1, 2, 3)
    expect([22, 26, 30].map((at) => v.getFloat32(at, true))).toEqual([301, 102, 203]);
    for (const at of [34, 38, 42]) expect(v.getFloat32(at, true)).toBeCloseTo(0, 5);
    expect(v.getFloat32(46, true)).toBe(1.5);
    expect(v.getUint32(50, true)).toBe(6); // "Bar.mdx" -> "Bar.m2" (no trailing NUL, see Doodad.ExtractSet)
    expect(String.fromCharCode(...raw.subarray(54))).toBe("Bar.m2");
  });
});
