import { describe, expect, test } from "bun:test";
import { adler32, zlibCompress } from "./zlib.ts";

describe("zlib", () => {
  test("Adler-32 matches the RFC 1950 examples", () => {
    expect(adler32(new Uint8Array(0))).toBe(1);
    expect(adler32(new TextEncoder().encode("Wikipedia"))).toBe(0x11e60398);
    // a long run crosses the 5552 byte step of the modulo: a = 1 + 255 n, b = n + 255 n (n + 1) / 2 (mod 65521)
    const n = 100000n;
    const a = (1n + 255n * n) % 65521n;
    const b = (n + (255n * n * (n + 1n)) / 2n) % 65521n;
    expect(adler32(new Uint8Array(100000).fill(255))).toBe(Number((b << 16n) | a));
  });

  test("a zlib stream has a valid header, the raw deflate data, and the Adler-32", () => {
    const data = new Uint8Array(30000).map((_, i) => (i * 7) % 251);
    for (const level of [1, 6, 9] as const) {
      const stream = zlibCompress(data, level);
      expect(stream[0]).toBe(0x78);
      expect(((stream[0]! << 8) | stream[1]!) % 31).toBe(0);
      const raw = stream.slice(2, stream.length - 4);
      expect(Bun.inflateSync(raw)).toEqual(data);
      expect(new DataView(stream.buffer).getUint32(stream.length - 4, false)).toBe(adler32(data));
    }
  });
});
