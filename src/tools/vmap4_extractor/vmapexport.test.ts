import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { Bytes, buildM2, buildWmoGroup, buildWmoRoot, chunk, useArchive, useWorkDir, view } from "./vmap4.test-util.ts";
import {
  GenerateUniqueObjectId,
  ParsMapFiles,
  RAW_VMAP_MAGIC,
  getModelVertexCount,
  globals,
  processArgv,
  runVMapExtractor,
  setModelVertexCount,
  strToLower,
} from "./vmapexport.ts";

let work: ReturnType<typeof useWorkDir>;
beforeEach(() => {
  work = useWorkDir();
});
afterEach(() => work.cleanup());

describe("processArgv", () => {
  test("positional client and output directories, options", () => {
    const quiet = spyOn(console, "log").mockImplementation(() => {});
    expect(processArgv(["/client"])).toEqual({ input: "/client", output: "data/Buildings", locale: null, maps: null, preciseVectorData: false });
    expect(processArgv(["/client", "out", "--locale", "deDE", "--maps", "0,530", "-l"])).toEqual({
      input: "/client",
      output: "out",
      locale: "deDE",
      maps: new Set([0, 530]),
      preciseVectorData: true,
    });
    expect(processArgv(["-d", "/client", "-s"])?.input).toBe("/client");
    // errors print the usage
    expect(processArgv([])).toBeNull();
    expect(processArgv(["/client", "--bogus"])).toBeNull();
    expect(processArgv(["/client", "--maps", "a"])).toBeNull();
    expect(processArgv(["-?"])).toBeNull();
    expect(processArgv(["a", "b", "c"])).toBeNull();
    quiet.mockRestore();
  });
});

describe("shared state", () => {
  test("unique object ids count up from 1 per (client id, doodad id)", () => {
    expect(GenerateUniqueObjectId(10, 0)).toBe(1);
    expect(GenerateUniqueObjectId(10, 1)).toBe(2);
    expect(GenerateUniqueObjectId(4294967295, 65535)).toBe(3);
    expect(GenerateUniqueObjectId(10, 0)).toBe(1);
  });

  test("strToLower, the raw magic, vertex counts read back from the file", async () => {
    expect(strToLower(".M2 ÄB")).toBe(".m2 Äb");
    expect(RAW_VMAP_MAGIC).toBe("VMAP048");
    expect(getModelVertexCount("none.m2")).toBeUndefined();
    const file = new Bytes().text("VMAP048").u8(0).u32(12).done();
    await Bun.write(`${work.dir}/x.wmo`, file);
    expect(getModelVertexCount("x.wmo")).toBe(12);
    setModelVertexCount("y.wmo", 5);
    expect(getModelVertexCount("y.wmo")).toBe(5);
  });
});

const M2 = buildM2(
  [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
  ],
  [0, 1, 2],
);

function mapFiles(): Record<string, Uint8Array> {
  const modf = new Bytes().u32(0).u32(9);
  for (const value of [100, 200, 300, 0, 0, 0, 1, 2, 3, 4, 5, 6]) modf.f32(value);
  modf.u16(0).u16(0).u16(0).u16(1024);
  const mddf = new Bytes().u32(0).u32(77);
  for (const value of [10, 20, 30, 0, 0, 0]) mddf.f32(value);
  mddf.u16(1024).u16(0);
  const wdt = new Bytes()
    .bytes(chunk("MAIN", new Bytes().zeros(8)).done())
    .bytes(chunk("MWMO", new Bytes().text("World\\Wmo\\Test\\Foo.wmo").u8(0)).done())
    .bytes(chunk("MODF", modf).done())
    .done();
  const adt = new Bytes()
    .bytes(chunk("MMDX", new Bytes().text("World\\Foo\\Bar.m2").u8(0)).done())
    .bytes(chunk("MDDF", mddf).done())
    .done();
  return {
    "World\\Maps\\Test\\Test.wdt": wdt,
    "World\\Maps\\Test\\Test_3_4.adt": adt,
    "World\\Maps\\Other\\Other.wdt": wdt,
    "World\\Foo\\Bar.m2": M2,
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
  };
}

describe("ParsMapFiles", () => {
  test("the WDT global WMO is a world spawn, each ADT adds its tile's records", () => {
    useArchive(mapFiles());
    const quiet = spyOn(console, "log").mockImplementation(() => {});
    ParsMapFiles([{ id: 7, name: "Test" }]);
    quiet.mockRestore();
    const raw = new Uint8Array(readFileSync(`${work.dir}/dir_bin`));
    const v = view(raw);
    const wmoRecord = 78 + 7;
    expect(raw).toHaveLength(wmoRecord + 60);
    // WDT: tile 65 / 65, MOD_HAS_BOUND | MOD_WORLDSPAWN
    expect([0, 4, 8, 12].map((at) => v.getUint32(at, true))).toEqual([7, 65, 65, 6]);
    // ADT 3 / 4: the doodad
    expect([0, 4, 8, 12].map((at) => v.getUint32(wmoRecord + at, true))).toEqual([7, 3, 4, 1]);
    expect(String.fromCharCode(...raw.subarray(wmoRecord + 54))).toBe("Bar.m2");
    expect(existsSync(`${work.dir}/Foo.wmo`)).toBe(true);
    expect(existsSync(`${work.dir}/Bar.m2`)).toBe(true);
  });

  test("only the listed maps are walked when a filter is given", () => {
    useArchive(mapFiles());
    const quiet = spyOn(console, "log").mockImplementation(() => {});
    ParsMapFiles(
      [
        { id: 7, name: "Test" },
        { id: 8, name: "Other" },
      ],
      new Set([8]),
    );
    quiet.mockRestore();
    const v = view(new Uint8Array(readFileSync(`${work.dir}/dir_bin`)));
    expect(v.getUint32(0, true)).toBe(8);
    expect(v.byteLength).toBe(78 + 7);
  });
});

describe("runVMapExtractor", () => {
  test("a polluted output directory is refused, a client without archives is a fatal error", async () => {
    const quiet = spyOn(console, "log").mockImplementation(() => {});
    mkdirSync(work.dir, { recursive: true });
    await Bun.write(`${work.dir}/dir_bin`, "x");
    expect(await runVMapExtractor({ input: "/nonexistent", output: work.dir, locale: null, maps: null, preciseVectorData: false })).toBe(1);
    expect(globals.szWorkDirWmo).toBe(work.dir);
    await Bun.write(`${work.dir}/dir_bin`, "");
    // dir_bin is still there: refused before any archive is looked at; remove it to reach the archive error
    const clean = `${work.dir}/clean`;
    expect(await runVMapExtractor({ input: "/nonexistent", output: clean, locale: null, maps: null, preciseVectorData: false })).toBe(1);
    quiet.mockRestore();
  });
});
