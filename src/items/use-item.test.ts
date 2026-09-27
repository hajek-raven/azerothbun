import { describe, expect, test } from "bun:test";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import {
  applySpellCharges,
  buildInventoryChangeFailure,
  buildSpellCooldownPacket,
  CMSG_USE_ITEM,
  EQUIP_ERR_ITEM_NOT_FOUND,
  EQUIP_ERR_OK,
  formatChargesString,
  ITEM_SPELLTRIGGER_ON_USE,
  loadSpellRecoveryMap,
  lookupSpellRecovery,
  MAX_ITEM_PROTO_SPELLS,
  parseChargesString,
  parseUseItem,
  resolveItemCooldown,
  SMSG_INVENTORY_CHANGE_FAILURE,
  SMSG_ITEM_COOLDOWN,
  SMSG_SPELL_COOLDOWN,
  SPELL_COOLDOWN_FLAG_NONE,
  SPELL_DBC_FMT,
  spellRecoveryFieldNames,
  useItem,
  type ItemSpellSlot,
  type SpellRecovery,
} from "./use-item.ts";

function onUseSpell(partial: Partial<ItemSpellSlot> & Pick<ItemSpellSlot, "spellId">): ItemSpellSlot {
  return {
    spellId: partial.spellId,
    spellTrigger: partial.spellTrigger ?? ITEM_SPELLTRIGGER_ON_USE,
    spellCharges: partial.spellCharges ?? 0,
    spellCooldown: partial.spellCooldown ?? 0,
    spellCategory: partial.spellCategory ?? 0,
    spellCategoryCooldown: partial.spellCategoryCooldown ?? 0,
  };
}

describe("opcodes (build 12340)", () => {
  test("match Opcodes.cpp", () => {
    expect(CMSG_USE_ITEM).toBe(0x0ab);
    expect(SMSG_ITEM_COOLDOWN).toBe(0x0b0);
    expect(SMSG_INVENTORY_CHANGE_FAILURE).toBe(0x112);
    expect(SMSG_SPELL_COOLDOWN).toBe(0x134);
  });
});

describe("parseUseItem", () => {
  test("reads bag, slot, castCount, spellId, itemGuid, glyphIndex, castFlags", () => {
    const body = new ByteWriter()
      .writeU8(255) // bag (inventory)
      .writeU8(23) // backpack slot
      .writeU8(1) // cast count
      .writeU32(439) // spell
      .writeU64(0x1fff_0000_0000_0042n)
      .writeU32(0) // glyph
      .writeU8(0) // cast flags
      .writeU32(0) // target mask (none)
      .toUint8Array();

    const parsed = parseUseItem(body);
    expect(parsed.bag).toBe(255);
    expect(parsed.slot).toBe(23);
    expect(parsed.castCount).toBe(1);
    expect(parsed.spellId).toBe(439);
    expect(parsed.itemGuid).toBe(0x1fff_0000_0000_0042n);
    expect(parsed.glyphIndex).toBe(0);
    expect(parsed.castFlags).toBe(0);
    expect(parsed.targetData.length).toBe(4);
  });
});

describe("charges string", () => {
  test("round-trips five slots like Item::SaveToDB", () => {
    const parsed = parseChargesString("-1 0 0 0 0");
    expect(parsed).toEqual([-1, 0, 0, 0, 0]);
    expect(parseChargesString(formatChargesString(parsed))).toEqual([-1, 0, 0, 0, 0]);
    expect(formatChargesString(parsed).endsWith(" ")).toBe(true);
  });
});

describe("resolveItemCooldown", () => {
  const recovery: SpellRecovery = {
    recoveryTime: 12_000,
    categoryRecoveryTime: 8_000,
    category: 4,
  };

  test("spellCooldown -1 uses spell recovery time", () => {
    const resolved = resolveItemCooldown(
      onUseSpell({ spellId: 100, spellCooldown: -1, spellCategoryCooldown: -1 }),
      recovery,
    );
    expect(resolved.cooldownMs).toBe(12_000);
    expect(resolved.categoryCooldownMs).toBe(8_000);
    expect(resolved.category).toBe(4);
  });

  test("spellCooldown 0 is no cooldown", () => {
    const resolved = resolveItemCooldown(
      onUseSpell({ spellId: 100, spellCooldown: 0, spellCategoryCooldown: 0 }),
      recovery,
    );
    expect(resolved.cooldownMs).toBe(0);
    expect(resolved.categoryCooldownMs).toBe(0);
  });

  test("spellCooldown 5000 uses 5000", () => {
    const resolved = resolveItemCooldown(
      onUseSpell({
        spellId: 100,
        spellCooldown: 5000,
        spellCategory: 11,
        spellCategoryCooldown: 0,
      }),
      recovery,
    );
    expect(resolved.cooldownMs).toBe(5000);
    expect(resolved.category).toBe(11);
    expect(resolved.categoryCooldownMs).toBe(0);
  });
});

describe("applySpellCharges (Spell::TakeCastItemCharges)", () => {
  test("template charges 0 is unlimited and does not consume", () => {
    const result = applySpellCharges(0, -1, 1);
    expect(result.consumeCharge).toBe(false);
    expect(result.destroy).toBe(false);
    expect(result.newCharges).toBe(-1);
  });

  test("template charges -1 (expendable one-use) destroys when exhausted", () => {
    const result = applySpellCharges(-1, -1, 1);
    expect(result.consumeCharge).toBe(true);
    expect(result.destroy).toBe(true);
    expect(result.newCharges).toBe(0);
  });

  test("template charges 1 consumes without destroying", () => {
    const result = applySpellCharges(1, 1, 1);
    expect(result.consumeCharge).toBe(true);
    expect(result.destroy).toBe(false);
    expect(result.newCharges).toBe(0);
  });
});

describe("useItem", () => {
  const playerGuid = 0x0000_0000_0000_0001n;
  const itemGuid = 0x1fff_0000_0000_0099n;
  const recovery: SpellRecovery = {
    recoveryTime: 15_000,
    categoryRecoveryTime: 0,
    category: 0,
  };

  test("cooldown -1 uses the spell recovery time and sends SMSG_SPELL_COOLDOWN", () => {
    const result = useItem({
      playerGuid,
      spellRecovery: recovery,
      item: {
        guid: itemGuid,
        charges: "0 0 0 0 0",
        spells: [onUseSpell({ spellId: 439, spellCooldown: -1, spellCategoryCooldown: -1 })],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.spellId).toBe(439);
    expect(result.cooldownMs).toBe(15_000);
    expect(result.packets).toHaveLength(1);
    expect(result.packets[0]!.opcode).toBe(SMSG_SPELL_COOLDOWN);
    const reader = new ByteReader(result.packets[0]!.body);
    expect(reader.readU64()).toBe(playerGuid);
    expect(reader.readU8()).toBe(SPELL_COOLDOWN_FLAG_NONE);
    expect(reader.readU32()).toBe(439);
    expect(reader.readU32()).toBe(15_000);
  });

  test("cooldown 0 sends no cooldown packet", () => {
    const result = useItem({
      playerGuid,
      spellRecovery: recovery,
      item: {
        guid: itemGuid,
        charges: "0 0 0 0 0",
        spells: [onUseSpell({ spellId: 439, spellCooldown: 0, spellCategoryCooldown: 0 })],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.cooldownMs).toBe(0);
    expect(result.categoryCooldownMs).toBe(0);
    expect(result.packets).toEqual([]);
  });

  test("cooldown 5000 uses 5000", () => {
    const result = useItem({
      playerGuid,
      item: {
        guid: itemGuid,
        charges: "0 0 0 0 0",
        spells: [onUseSpell({ spellId: 8118, spellCooldown: 5000, spellCategoryCooldown: 0 })],
      },
    });
    expect(result.cooldownMs).toBe(5000);
    expect(result.packets).toHaveLength(1);
    const reader = new ByteReader(result.packets[0]!.body);
    reader.readU64();
    reader.readU8();
    expect(reader.readU32()).toBe(8118);
    expect(reader.readU32()).toBe(5000);
  });

  test("charges 1 (expendable abs / template -1) then destroy", () => {
    // item_template spellcharges_-1 means one charge then DestroyItemCount
    const result = useItem({
      playerGuid,
      item: {
        guid: itemGuid,
        charges: "-1 0 0 0 0",
        stackable: 1,
        spells: [
          onUseSpell({
            spellId: 433,
            spellCharges: -1,
            spellCooldown: 0,
            spellCategoryCooldown: 0,
          }),
        ],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.consumeCharge).toBe(true);
    expect(result.destroy).toBe(true);
    expect(result.charges).toEqual([0, 0, 0, 0, 0]);
  });

  test("charges 0 (unlimited) does not consume", () => {
    // Template SpellCharges 0: TakeCastItemCharges skips charge logic entirely.
    // (DB "-1" on food/potions is expendable one-use, not unlimited.)
    const result = useItem({
      playerGuid,
      item: {
        guid: itemGuid,
        charges: "0 0 0 0 0",
        spells: [
          onUseSpell({
            spellId: 265,
            spellCharges: 0,
            spellCooldown: 0,
            spellCategoryCooldown: 0,
          }),
        ],
      },
    });
    expect(result.consumeCharge).toBe(false);
    expect(result.destroy).toBe(false);
  });

  test("bad slot returns EQUIP_ERR_ITEM_NOT_FOUND", () => {
    const result = useItem({
      playerGuid,
      item: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(EQUIP_ERR_ITEM_NOT_FOUND);
    expect(result.packets).toHaveLength(1);
    expect(result.packets[0]!.opcode).toBe(SMSG_INVENTORY_CHANGE_FAILURE);
    const reader = new ByteReader(result.packets[0]!.body);
    expect(reader.readU8()).toBe(EQUIP_ERR_ITEM_NOT_FOUND);
    expect(reader.readU64()).toBe(0n);
    expect(reader.readU64()).toBe(0n);
    expect(reader.readU8()).toBe(0);
  });
});

describe("spell recovery DBC lookup", () => {
  test("loadSpellRecoveryMap reads RecoveryTime without editing dbc.ts", () => {
    // Minimal synthetic WDBC: 1 record, field count matches SPELL_DBC_FMT.
    const format = SPELL_DBC_FMT;
    const fieldCount = format.length;
    let recordSize = 0;
    for (const char of format) {
      recordSize += char === "b" || char === "X" ? 1 : 4;
    }
    const fields = spellRecoveryFieldNames();
    expect(fields[27]).toBe("RecoveryTime");
    expect(fields[28]).toBe("CategoryRecoveryTime");

    const record = new Uint8Array(recordSize);
    const view = new DataView(record.buffer);
    // Write Id=42, Category=7, RecoveryTime=9000, CategoryRecoveryTime=3000 at format positions.
    let offset = 0;
    let valueIndex = 0;
    for (const char of format) {
      if (char === "x" || char === "X") {
        offset += char === "X" ? 1 : 4;
        continue;
      }
      if (char === "n" || char === "i" || char === "d") {
        let value = 0;
        if (valueIndex === 0) value = 42;
        else if (valueIndex === 1) value = 7;
        else if (valueIndex === 27) value = 9000;
        else if (valueIndex === 28) value = 3000;
        view.setUint32(offset, value, true);
        offset += 4;
        valueIndex += 1;
        continue;
      }
      if (char === "f") {
        offset += 4;
        valueIndex += 1;
        continue;
      }
      if (char === "s") {
        offset += 4;
        valueIndex += 1;
        continue;
      }
      if (char === "b") {
        offset += 1;
        valueIndex += 1;
        continue;
      }
      throw new Error(`unexpected format ${char}`);
    }

    const header = new Uint8Array(20);
    const headerView = new DataView(header.buffer);
    header[0] = 0x57; // W
    header[1] = 0x44; // D
    header[2] = 0x42; // B
    header[3] = 0x43; // C
    headerView.setUint32(4, 1, true);
    headerView.setUint32(8, fieldCount, true);
    headerView.setUint32(12, recordSize, true);
    headerView.setUint32(16, 0, true);

    const bytes = new Uint8Array(20 + recordSize);
    bytes.set(header, 0);
    bytes.set(record, 20);

    const map = loadSpellRecoveryMap(bytes);
    const found = lookupSpellRecovery(map, 42);
    expect(found).toEqual({
      recoveryTime: 9000,
      categoryRecoveryTime: 3000,
      category: 7,
    });
  });
});

describe("packet builders", () => {
  test("buildSpellCooldownPacket layout", () => {
    const body = buildSpellCooldownPacket(99n, 8690, 1500);
    const reader = new ByteReader(body);
    expect(reader.readU64()).toBe(99n);
    expect(reader.readU8()).toBe(0);
    expect(reader.readU32()).toBe(8690);
    expect(reader.readU32()).toBe(1500);
    expect(reader.remaining).toBe(0);
  });

  test("buildInventoryChangeFailure ok is a single byte", () => {
    expect(buildInventoryChangeFailure(EQUIP_ERR_OK)).toEqual(new Uint8Array([0]));
  });

  test("MAX_ITEM_PROTO_SPELLS is 5", () => {
    expect(MAX_ITEM_PROTO_SPELLS).toBe(5);
  });
});
