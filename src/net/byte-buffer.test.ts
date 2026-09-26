import { expect, test } from "bun:test";
import { ByteReader, ByteWriter } from "./byte-buffer.ts";

test("values written past the first buffer growth read back in order", () => {
  const writer = new ByteWriter();
  for (let i = 0; i < 40; i++) {
    writer.writeU8(i).writeU16(0x1234 + i).writeU32(0xdeadbeef - i).writeU64(BigInt(i) << 40n).writeF32(i + 0.5);
  }
  writer.writeCString("Northshire").writeBytes(Uint8Array.of(9, 8, 7));
  const reader = new ByteReader(writer.toUint8Array());
  for (let i = 0; i < 40; i++) {
    expect(reader.readU8()).toBe(i);
    expect(reader.readU16()).toBe(0x1234 + i);
    expect(reader.readU32()).toBe(0xdeadbeef - i);
    expect(reader.readU64()).toBe(BigInt(i) << 40n);
    expect(reader.readF32()).toBe(i + 0.5);
  }
  expect(reader.readCString()).toBe("Northshire");
  expect([...reader.readBytes(3)]).toEqual([9, 8, 7]);
  expect(reader.remaining).toBe(0);
});

test("writes wrap like the C++ integer casts and reads stop at the end", () => {
  const bytes = new ByteWriter().writeU8(0x1ff).writeU16(-1).writeU32(-1).toUint8Array();
  expect([...bytes]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const reader = new ByteReader(bytes.subarray(1));
  expect(reader.readU16()).toBe(0xffff);
  expect(() => reader.readU64()).toThrow("Unexpected end of packet");
  expect(() => new ByteReader(Uint8Array.of(65, 66)).readCString()).toThrow("Unterminated string");
});
