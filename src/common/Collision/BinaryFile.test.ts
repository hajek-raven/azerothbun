import { describe, expect, test } from "bun:test";
import { ReadFile, WriteFile } from "./BinaryFile.ts";

describe("BinaryFile", () => {
  test("WriteFile keeps every value across buffer growth", () => {
    const wf = new WriteFile();
    for (let i = 0; i < 5000; ++i) {
      wf.u8(i & 0xff);
      wf.u16(i);
      wf.i16(-i);
      wf.u32(i * 3);
      wf.i32(-i);
      wf.f32(i / 2);
    }
    const rf = new ReadFile(wf.toBytes());
    for (let i = 0; i < 5000; ++i) {
      expect(rf.u8()).toBe(i & 0xff);
      expect(rf.u16()).toBe(i);
      expect(rf.i16()).toBe(-i | 0);
      expect(rf.u32()).toBe(i * 3);
      expect(rf.i32()).toBe(-i | 0);
      expect(rf.f32()).toBe(i / 2);
    }
    expect(rf.remaining()).toBe(0);
    expect(rf.eof()).toBe(false);
    expect(rf.u8()).toBeUndefined();
    expect(rf.eof()).toBe(true);
  });

  test("short reads consume the rest and set eof", () => {
    const rf = new ReadFile(new Uint8Array([1, 2, 3]));
    expect(rf.u32()).toBeUndefined();
    expect(rf.eof()).toBe(true);
    expect(rf.remaining()).toBe(0);
    rf.seek(0);
    expect(rf.chunk("\x01\x02", 2)).toBe(true);
    expect(rf.chunk("\x04", 1)).toBe(false);
  });

  test("open returns null for missing files", () => {
    expect(ReadFile.open("/nonexistent/definitely/missing.bin")).toBeNull();
  });
});
