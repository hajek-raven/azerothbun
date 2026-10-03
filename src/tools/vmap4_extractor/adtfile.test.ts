import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ADTFile, GetExtension, GetPlainName, fixPlainName, fixname2, fixnamen, readMDDF, readMODF } from "./adtfile.ts";
import { MPQFile } from "./mpq_libmpq04.ts";
import { Bytes, buildM2, buildWmoGroup, buildWmoRoot, chunk, useArchive, useWorkDir, view } from "./vmap4.test-util.ts";

let work: ReturnType<typeof useWorkDir>;
beforeEach(() => {
  work = useWorkDir();
});
afterEach(() => work.cleanup());

describe("name helpers", () => {
  test("fixnamen capitalizes words and lower cases the extension", () => {
    expect(fixnamen("WORLD\\GENERIC\\HUMAN\\BOTTLE01.MDX")).toBe("World\\Generic\\Human\\Bottle01.mdx");
    expect(fixnamen("world\\wmo\\stormwind_keep.WMO")).toBe("World\\Wmo\\Stormwind_Keep.wmo");
    expect(fixnamen("ab")).toBe("ab");
  });

  test("fixname2 turns spaces into underscores except in the last three characters", () => {
    expect(fixname2("Passive Doodads.m2")).toBe("Passive_Doodads.m2");
    expect(fixname2("ab c")).toBe("ab c");
  });

  test("GetPlainName, GetExtension, fixPlainName", () => {
    expect(GetPlainName("a\\b\\c.m2")).toBe("c.m2");
    expect(GetPlainName("c.m2")).toBe("c.m2");
    expect(GetExtension("c.m2")).toBe(".m2");
    expect(GetExtension("c")).toBeNull();
    expect(fixPlainName("WORLD\\A B\\PASSIVE DOODAD.M2")).toBe("WORLD\\A B\\Passive_Doodad.m2");
  });
});

function mddfBytes(id: number, uniqueId: number): Bytes {
  const out = new Bytes().u32(id).u32(uniqueId);
  for (const value of [100, 200, 300, 10, 20, 30]) out.f32(value);
  return out.u16(2048).u16(0);
}

function modfBytes(id: number, uniqueId: number, flags = 0): Bytes {
  const out = new Bytes().u32(id).u32(uniqueId);
  for (const value of [100, 200, 300, 0, 90, 0, 1, 2, 3, 4, 5, 6]) out.f32(value);
  return out.u16(flags).u16(0).u16(9).u16(1024);
}

const adtBlob = (): Uint8Array =>
  new Bytes()
    .bytes(chunk("MCIN", new Bytes().zeros(16)).done())
    .bytes(chunk("MMDX", new Bytes().text("World\\Foo\\Bar.m2").u8(0)).done())
    .bytes(chunk("MWMO", new Bytes().text("World\\Wmo\\Test\\Foo.wmo").u8(0)).done())
    .bytes(chunk("MDDF", mddfBytes(0, 1234)).done())
    .bytes(chunk("MODF", modfBytes(0, 4321)).done())
    .done();

describe("records", () => {
  test("MDDF / MODF layouts (36 / 64 bytes)", () => {
    useArchive({ a: mddfBytes(5, 6).bytes(modfBytes(7, 8, 1).done()).done() });
    const f = new MPQFile("a");
    const d = readMDDF(f);
    expect([d.Id, d.UniqueId, d.Position.x, d.Rotation.z, d.Scale, d.Flags]).toEqual([5, 6, 100, 30, 2048, 0]);
    const m = readMODF(f);
    expect([m.Id, m.UniqueId, m.Rotation.y, m.Bounds.min.x, m.Bounds.max.z, m.Flags, m.DoodadSet, m.NameSet, m.Scale]).toEqual([7, 8, 90, 1, 6, 1, 0, 9, 1024]);
  });
});

describe("ADTFile", () => {
  test("init extracts the models and writes the dir_bin records of its doodads and WMOs", () => {
    useArchive({
      "World\\Maps\\Test\\Test_30_40.adt": adtBlob(),
      "World\\Foo\\Bar.m2": buildM2(
        [
          [1, 2, 3],
          [4, 5, 6],
          [7, 8, 9],
        ],
        [0, 1, 2],
      ),
      "World\\Wmo\\Test\\Foo.wmo": buildWmoRoot({ nGroups: 1, rootWMOID: 1 }),
      "World\\Wmo\\Test\\Foo_000.wmo": buildWmoGroup({
        mopy: [[0x08, 0]],
        movi: [0, 1, 2],
        movt: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
      }),
    });
    const adt = new ADTFile("World\\Maps\\Test\\Test_30_40.adt");
    expect(adt.init(7, 30, 40)).toBe(true);
    adt.close();
    expect(adt.ModelInstanceNames).toEqual(["Bar.m2"]);
    expect(adt.WmoInstanceNames).toEqual(["Foo.wmo"]);

    const raw = new Uint8Array(readFileSync(`${work.dir}/dir_bin`));
    const v = view(raw);
    expect(raw).toHaveLength(60 + 78 + 7);
    // doodad record
    expect([0, 4, 8, 12].map((at) => v.getUint32(at, true))).toEqual([7, 30, 40, 1]);
    // WMO record: flags MOD_HAS_BOUND, name set 9, unique ids are handed out in order of use
    const w = 60;
    expect([0, 4, 8, 12].map((at) => v.getUint32(w + at, true))).toEqual([7, 30, 40, 4]);
    expect(v.getUint16(w + 16, true)).toBe(9);
    expect(v.getUint32(w + 18, true)).toBe(2);
    expect([22, 26, 30].map((at) => v.getFloat32(w + at, true))).toEqual([300, 100, 200]); // fixCoords of (100, 200, 300)
    expect([34, 38, 42].map((at) => v.getFloat32(w + at, true))).toEqual([0, 90, 0]); // rotation is kept as is
    expect(v.getFloat32(w + 46, true)).toBe(1); // scale
    expect([50, 54, 58].map((at) => v.getFloat32(w + at, true))).toEqual([3, 1, 2]); // bounds min (1, 2, 3)
    expect([62, 66, 70].map((at) => v.getFloat32(w + at, true))).toEqual([6, 4, 5]); // bounds max (4, 5, 6)
    expect(v.getUint32(w + 74, true)).toBe(7);
    expect(String.fromCharCode(...raw.subarray(w + 78))).toBe("Foo.wmo");
  });

  test("destructible WMOs (MODF flag 1) are not dumped; a missing file does not init", () => {
    useArchive({
      "a.adt": new Bytes()
        .bytes(chunk("MWMO", new Bytes().text("World\\Wmo\\Test\\Foo.wmo").u8(0)).done())
        .bytes(chunk("MODF", modfBytes(0, 1, 1)).done())
        .done(),
    });
    const adt = new ADTFile("a.adt");
    expect(adt.init(1, 0, 0)).toBe(true);
    expect(readFileSync(`${work.dir}/dir_bin`)).toHaveLength(0);
    expect(new ADTFile("missing.adt").init(1, 0, 0)).toBe(false);
  });
});
