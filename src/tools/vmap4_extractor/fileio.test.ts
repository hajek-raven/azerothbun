import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DBCFile } from "./dbcfile.ts";
import { FileWriter, readVertexCountAt8 } from "./fileio.ts";
import { MPQFile, flipcc, readChunkHeader } from "./mpq_libmpq04.ts";
import { Bytes, useArchive, useWorkDir, view } from "./vmap4.test-util.ts";

let work: ReturnType<typeof useWorkDir>;
beforeEach(() => {
  work = useWorkDir();
});
afterEach(() => work.cleanup());

describe("FileWriter", () => {
  test("values keep their place when the buffer grows (more than the initial 4096 bytes)", () => {
    const writer = FileWriter.open(`${work.dir}/big`)!;
    for (let index = 0; index < 5000; ++index) {
      writer.u32(index);
      writer.f32(index + 0.5);
      writer.u16(index & 0xffff);
    }
    expect(writer.tell()).toBe(5000 * 10);
    writer.patchU32(0, 0xdeadbeef);
    writer.close();
    const v = view(new Uint8Array(readFileSync(`${work.dir}/big`)));
    expect(v.getUint32(0, true)).toBe(0xdeadbeef);
    for (const index of [1, 409, 410, 4999]) {
      expect(v.getUint32(index * 10, true)).toBe(index);
      expect(v.getFloat32(index * 10 + 4, true)).toBe(index + 0.5);
      expect(v.getUint16(index * 10 + 8, true)).toBe(index & 0xffff);
    }
  });

  test("append mode adds to the file, latin1 pads with NULs", () => {
    const writer = FileWriter.open(`${work.dir}/b`)!;
    writer.latin1("ab", 4);
    writer.close();
    expect(Array.from(readFileSync(`${work.dir}/b`))).toEqual([0x61, 0x62, 0, 0]);
    const append = FileWriter.open(`${work.dir}/b`, true)!;
    append.u8(9);
    append.close();
    expect(Array.from(readFileSync(`${work.dir}/b`))).toEqual([0x61, 0x62, 0, 0, 9]);
    expect(FileWriter.open(`${work.dir}/no/such/dir/x`)).toBeNull();
  });

  test("readVertexCountAt8", () => {
    const writer = FileWriter.open(`${work.dir}/m`)!;
    writer.latin1("VMAP048", 8);
    writer.i32(-3);
    writer.close();
    expect(readVertexCountAt8(`${work.dir}/m`)).toBe(-3);
    expect(readVertexCountAt8(`${work.dir}/missing`)).toBeUndefined();
  });
});

describe("MPQFile and chunk headers", () => {
  test("read semantics: a short read sets eof, one byte files are treated as missing", () => {
    useArchive({ f: new Bytes().text("NIAM").u32(2).u16(0xbeef).done(), tiny: new Uint8Array(1) });
    const f = new MPQFile("f");
    expect(f.getSize()).toBe(10);
    expect(flipcc(f.getBuffer()!, 0)).toBe("MAIN");
    expect(readChunkHeader(f)).toEqual({ fourcc: "MAIN", size: 2 });
    expect(f.readU16()).toBe(0xbeef);
    expect(f.isEof()).toBe(false);
    expect(readChunkHeader(f)).toBeNull();
    const dest = new Uint8Array(4);
    expect(f.read(dest, 4)).toBe(0); // at the end: eof is set by the seek check of the loop, no bytes are left
    expect(new MPQFile("tiny").isEof()).toBe(true);
    expect(new MPQFile("none").isEof()).toBe(true);
    const g = new MPQFile("f");
    g.seek(8);
    expect(g.read(dest, 4)).toBe(2);
    expect(g.isEof()).toBe(true);
  });
});

describe("DBCFile", () => {
  test("records, fields and the string table", () => {
    // two records of two fields (id, string offset), strings "\0Alpha\0Beta\0"
    const strings = "\0Alpha\0Beta\0";
    const blob = new Bytes().text("WDBC").u32(2).u32(2).u32(8).u32(strings.length).u32(7).u32(1).u32(9).u32(7).text(strings).done();
    useArchive({ "DBFilesClient\\X.dbc": blob, "DBFilesClient\\Bad.dbc": new Bytes().text("XXXX").zeros(16).done() });
    const dbc = new DBCFile("DBFilesClient\\X.dbc");
    const quiet = spyOn(console, "log").mockImplementation(() => {});
    expect(dbc.open()).toBe(true);
    expect(dbc.getRecordCount()).toBe(2);
    expect(dbc.getFieldCount()).toBe(2);
    expect(dbc.getRecord(0).getUInt(0)).toBe(7);
    expect(dbc.getRecord(0).getString(1)).toBe("Alpha");
    expect(dbc.getRecord(1).getString(1)).toBe("Beta");
    expect([...dbc].map((record) => record.getUInt(0))).toEqual([7, 9]);
    expect(new DBCFile("DBFilesClient\\Bad.dbc").open()).toBe(false);
    quiet.mockRestore();
    expect(new DBCFile("DBFilesClient\\Missing.dbc").open()).toBe(false);
  });
});
