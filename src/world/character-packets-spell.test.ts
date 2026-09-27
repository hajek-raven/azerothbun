import { expect, test } from "bun:test";
import { ByteReader } from "../net/byte-buffer.ts";
import { initialSpellsBody } from "./character-packets.ts";

test("initial spells includes saved item, category, and remaining cooldown", () => {
  const reader = new ByteReader(initialSpellsBody([78], [{ spell: 133, item: 42, category: 17, remaining: 5000 }]));
  expect(reader.readU8()).toBe(0);
  expect(reader.readU16()).toBe(1);
  expect(reader.readU32()).toBe(78);
  expect(reader.readU16()).toBe(0);
  expect(reader.readU16()).toBe(1);
  expect(reader.readU32()).toBe(133);
  expect(reader.readU16()).toBe(42);
  expect(reader.readU16()).toBe(17);
  expect(reader.readU32()).toBe(0);
  expect(reader.readU32()).toBe(5000);
});
