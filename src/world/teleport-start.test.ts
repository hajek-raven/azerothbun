import { worldFromSql } from "../database/test-world.ts";
import { expect, test } from "bun:test";
import { ByteWriter } from "../net/byte-buffer.ts";
import {
  commandTeleport,
  hearthTeleport,
  parseActivateTaxi,
  parseActivateTaxiExpress,
  parseGoCommand,
  spellTeleport,
  taxiTeleport,
  teleportStart,
  type SpellTargetPositionRow,
  type TaxiRecords,
} from "./teleport-start.ts";

test("hearthTeleport is far when homebind is on another map", () => {
  const homebind = { mapId: 1, zoneId: 14, posX: -100, posY: 200, posZ: 50 };
  const start = hearthTeleport(homebind, 0);
  expect(start).toEqual({
    map: 1,
    x: -100,
    y: 200,
    z: 50,
    orientation: 0,
    far: true,
  });
});

test("hearthTeleport is near when homebind is on the same map", () => {
  const homebind = { mapId: 0, zoneId: 12, x: -8949.95, y: -132.493, z: 83.5312 };
  const start = hearthTeleport(homebind, 0);
  expect(start.far).toBe(false);
  expect(start.map).toBe(0);
  expect(start.x).toBeCloseTo(-8949.95);
  expect(start.y).toBeCloseTo(-132.493);
  expect(start.z).toBeCloseTo(83.5312);
});

test("spellTeleport reads a portal-style spell_target_position row", () => {
  const rows: SpellTargetPositionRow[] = [
    {
      ID: 3561,
      EffectIndex: 0,
      MapID: 0,
      PositionX: -9003.46,
      PositionY: 870.031,
      PositionZ: 29.6206,
      Orientation: 5.28,
    },
    {
      ID: 3567,
      EffectIndex: 0,
      MapID: 1,
      PositionX: 1469.85,
      PositionY: -4221.52,
      PositionZ: 58.9939,
      Orientation: 5.98,
    },
  ];
  const near = spellTeleport(rows, 3561, { map: 0, orientation: 1 });
  expect(near).toEqual({
    map: 0,
    x: -9003.46,
    y: 870.031,
    z: 29.6206,
    orientation: 5.28,
    far: false,
  });
  const far = spellTeleport(rows, 3567, { map: 0 });
  expect(far?.far).toBe(true);
  expect(far?.map).toBe(1);
  expect(spellTeleport(rows, 9999, { map: 0 })).toBeNull();
});

test("spellTeleport loads spell_target_position from a world database", () => {
  // Hearthstone-style destination row (tests the table path; live 8690 uses TARGET_DEST_HOME).
  const db = worldFromSql(`INSERT INTO spell_target_position (ID, EffectIndex, MapID, PositionX, PositionY, PositionZ, Orientation)
    VALUES (8690, 0, 0, -8949.95, -132.493, 83.5312, 0)`);
  const start = spellTeleport(db, 8690, { map: 1 });
  expect(start).toEqual({
    map: 0,
    x: -8949.95,
    y: -132.493,
    z: 83.5312,
    orientation: 0,
    far: true,
  });
});

test("parseActivateTaxi reads guid and the two taxi nodes", () => {
  const payload = new ByteWriter().writeU64(0x0000000000123456n).writeU32(2).writeU32(6).toUint8Array();
  expect(parseActivateTaxi(payload)).toEqual({ guid: 0x123456n, nodes: [2, 6] });
});

test("parseActivateTaxiExpress reads a node list", () => {
  const payload = new ByteWriter()
    .writeU64(99n)
    .writeU32(3)
    .writeU32(2)
    .writeU32(5)
    .writeU32(6)
    .toUint8Array();
  expect(parseActivateTaxiExpress(payload)).toEqual({ guid: 99n, nodes: [2, 5, 6] });
});

test("taxiTeleport returns the destination node and stores path nodes", () => {
  const data: TaxiRecords = {
    nodes: [
      { id: 2, map: 0, x: -8842.61, y: 486.2, z: 109.61 },
      { id: 6, map: 0, x: -9453.07, y: 459.43, z: 56.39 },
    ],
    paths: [{ id: 10, from: 2, to: 6, cost: 45 }],
    pathNodes: [
      { pathId: 10, nodeIndex: 0, map: 0, x: -8842.61, y: 486.2, z: 109.61 },
      { pathId: 10, nodeIndex: 1, map: 0, x: -9100, y: 470, z: 80 },
      { pathId: 10, nodeIndex: 2, map: 0, x: -9453.07, y: 459.43, z: 56.39 },
    ],
  };
  const start = taxiTeleport(data, 2, 6, { map: 0, orientation: 1.5 });
  expect(start).not.toBeNull();
  expect(start!.map).toBe(0);
  expect(start!.x).toBeCloseTo(-9453.07);
  expect(start!.y).toBeCloseTo(459.43);
  expect(start!.z).toBeCloseTo(56.39);
  expect(start!.orientation).toBe(1.5);
  expect(start!.far).toBe(false);
  expect(start!.pathId).toBe(10);
  expect(start!.cost).toBe(45);
  expect(start!.pathNodes).toHaveLength(3);
  expect(taxiTeleport(data, 2, 99, { map: 0 })).toBeNull();
});

test("taxiTeleport is far when the destination node is on another map", () => {
  const data: TaxiRecords = {
    nodes: [
      { id: 99, map: 530, x: 1, y: 2, z: 3 },
      { id: 100, map: 0, x: 10, y: 20, z: 30 },
    ],
    paths: [{ id: 1, from: 99, to: 100, cost: 0 }],
    pathNodes: [],
  };
  const start = taxiTeleport(data, 99, 100, { map: 530 });
  expect(start?.far).toBe(true);
  expect(start?.map).toBe(0);
});

test("bad go command returns an error string", () => {
  const bad = commandTeleport("go", { map: 0, orientation: 0 });
  expect(bad.ok).toBe(false);
  if (!bad.ok) {
    expect(bad.error.length).toBeGreaterThan(0);
  }
  const unknown = parseGoCommand("go grid 1 2", { map: 0 });
  expect(unknown.ok).toBe(false);
  const missingCreature = commandTeleport(".go creature 42", { map: 0 });
  expect(missingCreature).toEqual({ ok: false, error: "Creature spawn not found." });
});

test("good go command returns coordinates", () => {
  const xyz = commandTeleport(".go xyz -8949.95 -132.493 83.5312 0 1.2", { map: 1, orientation: 0 });
  expect(xyz).toEqual({
    ok: true,
    start: {
      map: 0,
      x: -8949.95,
      y: -132.493,
      z: 83.5312,
      orientation: 1.2,
      far: true,
    },
  });

  const shorthand = parseGoCommand("go 100 200 300", { map: 0, orientation: 0.5 });
  expect(shorthand).toEqual({
    ok: true,
    start: teleportStart(0, 100, 200, 300, 0.5, 0),
  });

  const creature = commandTeleport(".go creature 12", { map: 0 }, { map: 1, x: 10, y: 20, z: 30, orientation: 2 });
  expect(creature).toEqual({
    ok: true,
    start: {
      map: 1,
      x: 10,
      y: 20,
      z: 30,
      orientation: 2,
      far: true,
    },
  });
});
