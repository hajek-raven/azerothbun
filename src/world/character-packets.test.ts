import { expect, test } from "bun:test";
import {
  ACTION_BUTTON_COUNT,
  CHAR_CREATE_SUCCESS,
  CHAR_DELETE_SUCCESS,
  FACTION_SLOT_COUNT,
  actionButtonsBody,
  bindPointBody,
  charCreateBody,
  charDeleteBody,
  initialSpellsBody,
  initializeFactionsBody,
} from "./character-packets.ts";

test("initialSpellsBody writes unk, count, spells, and zero cooldowns", () => {
  const body = initialSpellsBody([6603, 78]);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  expect(body[0]).toBe(0);
  expect(view.getUint16(1, true)).toBe(2);
  expect(view.getUint32(3, true)).toBe(6603);
  expect(view.getUint16(7, true)).toBe(0);
  expect(view.getUint32(9, true)).toBe(78);
  expect(view.getUint16(13, true)).toBe(0);
  expect(view.getUint16(15, true)).toBe(0);
  expect(body.length).toBe(17);
});

test("actionButtonsBody packs human-warrior starter buttons", () => {
  const body = actionButtonsBody([
    { button: 72, action: 6603, type: 0 },
    { button: 73, action: 78, type: 0 },
    { button: 82, action: 59752, type: 0 },
    { button: 200, action: 1, type: 1 },
  ]);
  expect(body[0]).toBe(1);
  expect(body.length).toBe(1 + ACTION_BUTTON_COUNT * 4);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  expect(view.getUint32(1 + 72 * 4, true)).toBe(6603);
  expect(view.getUint32(1 + 73 * 4, true)).toBe(78);
  expect(view.getUint32(1 + 82 * 4, true)).toBe(59752);
  expect(view.getUint32(1 + 0 * 4, true)).toBe(0);
});

test("initializeFactionsBody fills 128 slots and applies listed ones", () => {
  const body = initializeFactionsBody([
    { index: 1, flags: 0x11, standing: 42 },
    { index: 200, flags: 1, standing: 99 },
  ]);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  expect(view.getUint32(0, true)).toBe(0x80);
  expect(body.length).toBe(4 + FACTION_SLOT_COUNT * 5);
  expect(body[4 + 0 * 5]).toBe(0);
  expect(view.getUint32(4 + 0 * 5 + 1, true)).toBe(0);
  expect(body[4 + 1 * 5]).toBe(0x11);
  expect(view.getUint32(4 + 1 * 5 + 1, true)).toBe(42);
});

test("bindPointBody writes floats then map and zone", () => {
  const body = bindPointBody({ mapId: 0, zoneId: 12, x: -8949.95, y: -132.493, z: 83.5312 });
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  expect(body.length).toBe(20);
  expect(view.getFloat32(0, true)).toBe(Math.fround(-8949.95));
  expect(view.getFloat32(4, true)).toBe(Math.fround(-132.493));
  expect(view.getFloat32(8, true)).toBe(Math.fround(83.5312));
  expect(view.getUint32(12, true)).toBe(0);
  expect(view.getUint32(16, true)).toBe(12);
});

test("char create and delete success bodies are single ResponseCodes bytes", () => {
  expect(CHAR_CREATE_SUCCESS).toBe(0x2f);
  expect(CHAR_DELETE_SUCCESS).toBe(0x47);
  expect([...charCreateBody(CHAR_CREATE_SUCCESS)]).toEqual([0x2f]);
  expect([...charDeleteBody(CHAR_DELETE_SUCCESS)]).toEqual([0x47]);
});
