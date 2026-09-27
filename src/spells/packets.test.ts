import { expect, test } from "bun:test";
import { ByteWriter } from "../net/byte-buffer.ts";
import { packedGuid } from "../world/update-object.ts";
import { readCastRequest, readTargets, TARGET_FLAG_DEST_LOCATION, TARGET_FLAG_STRING, TARGET_FLAG_UNIT, writeTargets } from "./packets.ts";
import { ByteReader } from "../net/byte-buffer.ts";

test("SpellCastTargets reads and writes packed unit, location, and string", () => {
  const targets = {
    mask: TARGET_FLAG_UNIT | TARGET_FLAG_DEST_LOCATION | TARGET_FLAG_STRING,
    object: 0xf130000001010207n,
    item: 0n,
    source: null,
    dest: { transport: 0n, x: 1.25, y: -2.5, z: 3.75 },
    text: "hello",
  };
  const writer = new ByteWriter();
  writeTargets(writer, targets);
  expect(readTargets(new ByteReader(writer.toUint8Array()))).toEqual(targets);
});

test("cast request reads cast count, spell, flags, and target", () => {
  const guid = 0xf130000001010207n;
  const packet = new ByteWriter()
    .writeU8(3)
    .writeU32(133)
    .writeU8(0)
    .writeU32(TARGET_FLAG_UNIT)
    .writeBytes(packedGuid(guid))
    .toUint8Array();
  expect(readCastRequest(packet)).toEqual({
    castCount: 3,
    spellId: 133,
    clientFlags: 0,
    targets: { mask: TARGET_FLAG_UNIT, object: guid, item: 0n, source: null, dest: null, text: "" },
  });
});
