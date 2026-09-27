import { expect, test } from "bun:test";
import { ByteWriter } from "../net/byte-buffer.ts";
import { fallDamage, readMoveInfo, sanitizeFlags, speedVerdict } from "./movement.ts";

test("flying and waterwalk flags from the client are stripped", () => {
  const flags = sanitizeFlags(0x02000000 | 0x10000000 | 0x00000001);
  expect(flags & 0x02000000).toBe(0);
  expect(flags & 0x10000000).toBe(0);
  expect(flags & 0x00000001).toBe(0x00000001);
});

test("a flying movement packet still yields the position", () => {
  const payload = new ByteWriter()
    .writeU8(0x01)
    .writeU8(1)
    .writeU32(0x02000000)
    .writeU16(0)
    .writeU32(5)
    .writeF32(10)
    .writeF32(20)
    .writeF32(30)
    .writeF32(0)
    .writeF32(0.5)
    .writeU32(0)
    .toUint8Array();
  const info = readMoveInfo("move", payload);
  expect(info?.x).toBeCloseTo(10);
  expect(info?.z).toBeCloseTo(30);
  expect(info!.flags & 0x02000000).toBe(0);
});

test("falls shorter than 13.48 yards deal no damage", () => {
  expect(fallDamage(10, 60)).toBe(0);
  expect(fallDamage(20, 60)).toBeGreaterThan(0);
});

test("run speed above 7 is a kick and a slower ack is corrected", () => {
  expect(speedVerdict(0x0e3, 7)).toBe("ok");
  expect(speedVerdict(0x0e3, 14)).toBe("kick");
  expect(speedVerdict(0x0e3, 1)).toBe("correct");
});
