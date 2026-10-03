import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { WorldModel_Raw } from "../../common/Collision/Maps/TileAssembler.ts";
import { Bytes, buildWmoGroup, buildWmoRoot, useArchive, useWorkDir, view, type TestGroup } from "./vmap4.test-util.ts";
import { ExtractSingleWmo, getModelVertexCount, globals } from "./vmapexport.ts";

const ROOT = "World\\Wmo\\Test\\Foo.wmo";
const GROUP0 = "World\\Wmo\\Test\\Foo_000.wmo";

let work: ReturnType<typeof useWorkDir>;
beforeEach(() => {
  work = useWorkDir();
});
afterEach(() => work.cleanup());

/** Triangles: t0 collision flag, t1 nothing, t2 render, t3 render + detail but collision-only material 0xFF, t4 render + detail. */
const group: TestGroup = {
  mogpFlags: 0x1234,
  groupWMOID: 77,
  bb1: [1, 2, 3],
  bb2: [4, 5, 6],
  mopy: [
    [0x08, 0],
    [0x00, 0],
    [0x20, 0],
    [0x24, 0xff],
    [0x24, 0],
  ],
  movi: [0, 1, 2, 3, 4, 5, 2, 1, 5, 1, 0, 2, 4, 5, 3],
  movt: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [5, 5, 5],
    [6, 6, 6],
    [0, 0, 1],
  ],
  mobaIndex8: [7],
};

function floats(values: number[]): Bytes {
  const out = new Bytes();
  for (const value of values) out.f32(value);
  return out;
}

describe("ExtractSingleWmo", () => {
  test("keeps the collision triangles and renumbers the vertices", () => {
    useArchive({ [ROOT]: buildWmoRoot({ nGroups: 1, rootWMOID: 42 }), [GROUP0]: buildWmoGroup(group) });
    expect(ExtractSingleWmo({ value: ROOT })).toBe(true);

    // kept: t0 (0,1,2), t2 (2,1,5), t3 (1,0,2); used vertices 0,1,2,5 become 0,1,2,3
    const expected = new Bytes()
      .text("VMAP048")
      .u8(0)
      .u32(3) // total collision triangles (the "vertex count" of the root header)
      .u32(1) // groups written
      .u32(42) // RootWMOID
      .u32(0x1234) // mogpFlags
      .u32(77) // groupWMOID
      .bytes(floats([1, 2, 3, 4, 5, 6]).done())
      .u32(0) // liquflags (the sub chunks after MOGP reset it)
      .text("GRP ")
      .u32(4 + 4 * 1) // moba_batch * 4 + 4
      .u32(1) // moba_batch
      .u32(7) // MOBA[8] of the batch
      .text("INDX")
      .u32(3 * 6 + 4)
      .u32(9);
    for (const index of [0, 1, 2, 2, 1, 3, 1, 0, 2]) expected.u16(index);
    expected
      .text("VERT")
      .u32(4 * 12 + 4)
      .u32(4)
      .bytes(floats([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]).done());

    const written = new Uint8Array(readFileSync(`${work.dir}/Foo.wmo`));
    expect(Array.from(written)).toEqual(Array.from(expected.done()));
    expect(getModelVertexCount("Foo.wmo")).toBe(3);
  });

  test("the precise (-l) mode writes every triangle and vertex", () => {
    useArchive({ [ROOT]: buildWmoRoot({ nGroups: 1, rootWMOID: 42 }), [GROUP0]: buildWmoGroup(group) });
    globals.preciseVectorData = true;
    expect(ExtractSingleWmo({ value: ROOT })).toBe(true);
    const raw = new Uint8Array(readFileSync(`${work.dir}/Foo.wmo`));
    const v = view(raw);
    expect(v.getUint32(8, true)).toBe(5);
    // file header 20, group header 4 + 4 + 24 + 4 = 36, "GRP " block 4 + 4 + 4 + 4 = 16, then the INDX tag
    const indxAt = 20 + 36 + 16 + 4;
    expect(String.fromCharCode(...raw.subarray(indxAt - 4, indxAt))).toBe("INDX");
    expect(v.getInt32(indxAt, true)).toBe(4 + 2 * 15);
    expect(v.getUint32(indxAt + 4, true)).toBe(15);
    expect(v.getUint16(indxAt + 8 + 2 * 3, true)).toBe(3);
    const vertAt = indxAt + 8 + 30 + 4;
    expect(String.fromCharCode(...raw.subarray(vertAt - 4, vertAt))).toBe("VERT");
    expect(v.getInt32(vertAt, true)).toBe(4 + 6 * 12);
    expect(v.getInt32(vertAt + 4, true)).toBe(6);
    expect(v.getFloat32(vertAt + 8 + 3 * 12, true)).toBe(5);
  });

  test("a group the reader can take back (TileAssembler's WorldModel_Raw)", () => {
    useArchive({ [ROOT]: buildWmoRoot({ nGroups: 1, rootWMOID: 42 }), [GROUP0]: buildWmoGroup(group) });
    ExtractSingleWmo({ value: ROOT });
    const model = new WorldModel_Raw();
    expect(model.Read(`${work.dir}/Foo.wmo`)).toBe(true);
    expect(model.RootWMOID).toBe(42);
    expect(model.groupsArray).toHaveLength(1);
    const g = model.groupsArray[0]!;
    expect(g.mogpflags).toBe(0x1234);
    expect(g.GroupWMOID).toBe(77);
    expect(Array.from(g.triangles)).toEqual([0, 1, 2, 2, 1, 3, 1, 0, 2]);
    expect(Array.from(g.vertexArray)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  test("liquid: the MLIQ chunk (when it is the last one) writes LIQU with heights and tiles", () => {
    const liquidGroup: TestGroup = {
      ...group,
      mogpFlags: 0,
      liquid: { xverts: 2, yverts: 2, xtiles: 1, ytiles: 1, pos: [10, 20, 30], material: 5, heights: [1.5, 2.5, 3.5, 4.5], tiles: [0x0f] },
    };
    useArchive({ [ROOT]: buildWmoRoot({ nGroups: 1, rootWMOID: 1 }), [GROUP0]: buildWmoGroup(liquidGroup) });
    ExtractSingleWmo({ value: ROOT });
    const raw = new Uint8Array(readFileSync(`${work.dir}/Foo.wmo`));
    const v = view(raw);
    // the liquflags of the group header: only MLIQ (last chunk) survives the per chunk reset
    expect(v.getUint32(20 + 4 + 4 + 24, true)).toBe(1);
    const liquAt = raw.length - (8 + 4 + 30 + 16 + 1);
    expect(String.fromCharCode(...raw.subarray(liquAt, liquAt + 4))).toBe("LIQU");
    expect(v.getInt32(liquAt + 4, true)).toBe(4 + 30 + 16 + 1);
    expect(v.getUint32(liquAt + 8, true)).toBe(13); // root flags & 4 == 0, groupLiquid 0 -> GetLiquidTypeId(1) = 13
    expect(v.getInt32(liquAt + 12, true)).toBe(2);
    expect(v.getInt32(liquAt + 24, true)).toBe(1);
    expect(v.getFloat32(liquAt + 28, true)).toBe(10);
    expect(v.getUint16(liquAt + 40, true)).toBe(5);
    expect(v.getFloat32(liquAt + 42, true)).toBe(1.5);
    expect(v.getFloat32(liquAt + 42 + 12, true)).toBe(4.5);
    expect(raw[raw.length - 1]).toBe(0x0f);
    const model = new WorldModel_Raw();
    expect(model.Read(`${work.dir}/Foo.wmo`)).toBe(true);
    expect(model.groupsArray[0]!.liquid).not.toBeNull();
  });

  test("unreachable groups, antiportal groups and group files are skipped", () => {
    useArchive({
      [ROOT]: buildWmoRoot({ nGroups: 1, rootWMOID: 1 }),
      [GROUP0]: buildWmoGroup({ ...group, mogpFlags: 0x80 }),
    });
    expect(ExtractSingleWmo({ value: ROOT })).toBe(true);
    let raw = new Uint8Array(readFileSync(`${work.dir}/Foo.wmo`));
    expect(view(raw).getUint32(8, true)).toBe(0);
    expect(view(raw).getUint32(12, true)).toBe(0);

    useArchive({
      "World\\Wmo\\Test\\Bar.wmo": buildWmoRoot({ nGroups: 1, rootWMOID: 1, groupNames: "antiportal\0" }),
      "World\\Wmo\\Test\\Bar_000.wmo": buildWmoGroup({ ...group, groupName: 0 }),
    });
    expect(ExtractSingleWmo({ value: "World\\Wmo\\Test\\Bar.wmo" })).toBe(true);
    raw = new Uint8Array(readFileSync(`${work.dir}/Bar.wmo`));
    expect(view(raw).getUint32(12, true)).toBe(0);

    // "_000" names are group files: nothing is written, the call still succeeds
    expect(ExtractSingleWmo({ value: GROUP0 })).toBe(true);
    expect(existsSync(`${work.dir}/Foo_000.wmo`)).toBe(false);
  });

  test("a missing group file removes the output, a missing root fails", () => {
    useArchive({ [ROOT]: buildWmoRoot({ nGroups: 2, rootWMOID: 1 }), [GROUP0]: buildWmoGroup(group) });
    expect(ExtractSingleWmo({ value: ROOT })).toBe(true);
    expect(existsSync(`${work.dir}/Foo.wmo`)).toBe(false);
    expect(getModelVertexCount("Foo.wmo")).toBeUndefined();
    expect(ExtractSingleWmo({ value: "World\\Wmo\\Test\\Nothing.wmo" })).toBe(false);
  });

  test("an existing output file is kept (the C++ FileExists shortcut)", async () => {
    useArchive({});
    await Bun.write(`${work.dir}/Foo.wmo`, "x");
    expect(ExtractSingleWmo({ value: ROOT })).toBe(true);
  });
});
