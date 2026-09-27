import { testDatabase } from "../database/test-db.ts";
import { describe, expect, test } from "bun:test";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import {
  EQUIPMENT_SET_IGNORED_SLOT,
  EQUIPMENT_SLOT_END,
  deleteSet,
  equipmentSetListPacket,
  itemGuidRaw,
  loadSets,
  parseEquipmentSetDelete,
  parseEquipmentSetSave,
  parseEquipmentSetUse,
  saveSet,
  useSet,
  type EquipmentSet,
} from "./equipment-sets.ts";

function openDb() {
  return testDatabase("characters");
}

function sampleSet(overrides: Partial<EquipmentSet> = {}): EquipmentSet {
  const items = Array.from({ length: EQUIPMENT_SLOT_END }, () => 0);
  items[0] = 1001;
  items[15] = 2002;
  return {
    setguid: 0n,
    setindex: 0,
    name: "PvE",
    iconname: "Ability_Warrior_BattleShout",
    ignoreMask: 0,
    items,
    ...overrides,
  };
}

function writePacked(writer: ByteWriter, guid: bigint): void {
  let mask = 0;
  const bytes: number[] = [];
  for (let index = 0; index < 8; index++) {
    const byte = Number((guid >> BigInt(index * 8)) & 0xffn);
    if (byte !== 0) {
      mask |= 1 << index;
      bytes.push(byte);
    }
  }
  writer.writeU8(mask);
  for (const byte of bytes) {
    writer.writeU8(byte);
  }
}

function readPacked(reader: ByteReader): bigint {
  const mask = reader.readU8();
  let guid = 0n;
  for (let index = 0; index < 8; index++) {
    if (mask & (1 << index)) {
      guid |= BigInt(reader.readU8()) << BigInt(index * 8);
    }
  }
  return guid;
}

describe("equipment sets", () => {
  test("save and load round trip including ignored slots", async () => {
    const db = await openDb();
    const ignoreMask = (1 << 3) | (1 << 14);
    const saved = await saveSet(
      db,
      42,
      sampleSet({
        setindex: 1,
        name: "Tank",
        iconname: "Ability_Defend",
        ignoreMask,
        items: (() => {
          const items = Array.from({ length: EQUIPMENT_SLOT_END }, () => 0);
          items[0] = 55;
          items[4] = 77;
          return items;
        })(),
      }),
    );

    expect(saved.setguid).toBeGreaterThan(0n);

    const loaded = await loadSets(db, 42);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.setguid).toBe(saved.setguid);
    expect(loaded[0]!.setindex).toBe(1);
    expect(loaded[0]!.name).toBe("Tank");
    expect(loaded[0]!.iconname).toBe("Ability_Defend");
    expect(loaded[0]!.ignoreMask).toBe(ignoreMask);
    expect(loaded[0]!.items[0]).toBe(55);
    expect(loaded[0]!.items[3]).toBe(0);
    expect(loaded[0]!.items[4]).toBe(77);
    expect(loaded[0]!.items[14]).toBe(0);

    const writer = new ByteWriter();
    writePacked(writer, saved.setguid);
    writer.writeU32(1);
    writer.writeCString("Tank");
    writer.writeCString("Ability_Defend");
    for (let slot = 0; slot < EQUIPMENT_SLOT_END; slot++) {
      if (ignoreMask & (1 << slot)) {
        writePacked(writer, EQUIPMENT_SET_IGNORED_SLOT);
      } else if (slot === 0) {
        writePacked(writer, itemGuidRaw(55));
      } else if (slot === 4) {
        writePacked(writer, itemGuidRaw(77));
      } else {
        writePacked(writer, 0n);
      }
    }

    const parsed = parseEquipmentSetSave(writer.toUint8Array());
    expect(parsed).not.toBeNull();
    expect(parsed!.setguid).toBe(saved.setguid);
    expect(parsed!.ignoreMask).toBe(ignoreMask);
    expect(parsed!.items[0]).toBe(55);
    expect(parsed!.items[4]).toBe(77);
    expect(parsed!.items[3]).toBe(0);
  });

  test("delete removes the set", async () => {
    const db = await openDb();
    const a = await saveSet(db, 7, sampleSet({ setindex: 0, name: "A" }));
    const b = await saveSet(db, 7, sampleSet({ setindex: 1, name: "B", items: Array.from({ length: 19 }, () => 0) }));
    expect(await loadSets(db, 7)).toHaveLength(2);

    await deleteSet(db, a.setguid);
    const remaining = await loadSets(db, 7);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.setguid).toBe(b.setguid);

    const delPayload = new ByteWriter();
    writePacked(delPayload, a.setguid);
    expect(parseEquipmentSetDelete(delPayload.toUint8Array())).toBe(a.setguid);
  });

  test("list packet count and ignored slot encoding", () => {
    const sets: EquipmentSet[] = [
      sampleSet({
        setguid: 9n,
        setindex: 0,
        name: "One",
        iconname: "Icon_One",
        ignoreMask: 1 << 5,
        items: (() => {
          const items = Array.from({ length: EQUIPMENT_SLOT_END }, () => 0);
          items[1] = 333;
          return items;
        })(),
      }),
      sampleSet({
        setguid: 10n,
        setindex: 2,
        name: "Two",
        iconname: "Icon_Two",
        ignoreMask: 0,
        items: Array.from({ length: EQUIPMENT_SLOT_END }, () => 0),
      }),
    ];

    const packet = equipmentSetListPacket(sets);
    const reader = new ByteReader(packet);
    expect(reader.readU32()).toBe(2);

    expect(readPacked(reader)).toBe(9n);
    expect(reader.readU32()).toBe(0);
    expect(reader.readCString()).toBe("One");
    expect(reader.readCString()).toBe("Icon_One");
    for (let slot = 0; slot < EQUIPMENT_SLOT_END; slot++) {
      const raw = readPacked(reader);
      if (slot === 5) {
        expect(raw).toBe(EQUIPMENT_SET_IGNORED_SLOT);
      } else if (slot === 1) {
        expect(raw).toBe(itemGuidRaw(333));
      } else {
        expect(raw).toBe(0n);
      }
    }

    expect(readPacked(reader)).toBe(10n);
    expect(reader.readU32()).toBe(2);
    expect(reader.readCString()).toBe("Two");
    expect(reader.readCString()).toBe("Icon_Two");
    for (let slot = 0; slot < EQUIPMENT_SLOT_END; slot++) {
      expect(readPacked(reader)).toBe(0n);
    }
    expect(reader.remaining).toBe(0);
  });

  test("useSet reports missing item without throwing", () => {
    const set = sampleSet({
      setguid: 1n,
      ignoreMask: 1 << 2,
      items: (() => {
        const items = Array.from({ length: EQUIPMENT_SLOT_END }, () => 0);
        items[0] = 100;
        items[1] = 200;
        items[2] = 999;
        items[15] = 0;
        return items;
      })(),
    });

    const moves = useSet(set, new Set([100]));
    expect(moves).toEqual([
      { slot: 0, itemGuid: 100, missing: false },
      { slot: 1, itemGuid: 200, missing: true },
      { slot: 3, itemGuid: 0, missing: false },
      { slot: 4, itemGuid: 0, missing: false },
      { slot: 5, itemGuid: 0, missing: false },
      { slot: 6, itemGuid: 0, missing: false },
      { slot: 7, itemGuid: 0, missing: false },
      { slot: 8, itemGuid: 0, missing: false },
      { slot: 9, itemGuid: 0, missing: false },
      { slot: 10, itemGuid: 0, missing: false },
      { slot: 11, itemGuid: 0, missing: false },
      { slot: 12, itemGuid: 0, missing: false },
      { slot: 13, itemGuid: 0, missing: false },
      { slot: 14, itemGuid: 0, missing: false },
      { slot: 15, itemGuid: 0, missing: false },
      { slot: 16, itemGuid: 0, missing: false },
      { slot: 17, itemGuid: 0, missing: false },
      { slot: 18, itemGuid: 0, missing: false },
    ]);
    expect(moves.find((m) => m.slot === 2)).toBeUndefined();
  });

  test("parseEquipmentSetUse reads src bag and slot", () => {
    const writer = new ByteWriter();
    for (let slot = 0; slot < EQUIPMENT_SLOT_END; slot++) {
      if (slot === 0) {
        writePacked(writer, itemGuidRaw(44));
        writer.writeU8(255);
        writer.writeU8(0);
      } else if (slot === 1) {
        writePacked(writer, EQUIPMENT_SET_IGNORED_SLOT);
        writer.writeU8(0);
        writer.writeU8(0);
      } else {
        writePacked(writer, 0n);
        writer.writeU8(0);
        writer.writeU8(0);
      }
    }
    const parsed = parseEquipmentSetUse(writer.toUint8Array());
    expect(parsed).toHaveLength(EQUIPMENT_SLOT_END);
    expect(parsed[0]).toEqual({ itemGuid: itemGuidRaw(44), srcbag: 255, srcslot: 0 });
    expect(parsed[1]!.itemGuid).toBe(EQUIPMENT_SET_IGNORED_SLOT);
  });
});
