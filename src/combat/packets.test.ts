import { describe, expect, test } from "bun:test";
import { ByteReader } from "../net/byte-buffer.ts";
import { HITINFO_AFFECTS_VICTIM, HITINFO_BLOCK, HITINFO_CRITICALHIT, VICTIMSTATE_HIT } from "./constants.ts";
import { attackerStateUpdate, attackStartPacket, attackStopPacket, unitValuesUpdate, UNIT_FIELD_HEALTH } from "./packets.ts";

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

describe("combat packets", () => {
  test("SMSG_ATTACKERSTATEUPDATE follows SendAttackStateUpdate", () => {
    const creature = 0xf13000000c000001n;
    const body = attackerStateUpdate({
      hitInfo: HITINFO_AFFECTS_VICTIM | HITINFO_CRITICALHIT | HITINFO_BLOCK,
      attacker: 7n,
      target: creature,
      damages: [
        { schoolMask: 1, damage: 30, absorb: 0, resist: 0 },
        { schoolMask: 1, damage: 0, absorb: 0, resist: 0 },
      ],
      targetHealth: 20,
      targetState: VICTIMSTATE_HIT,
      blocked: 5,
    });
    const reader = new ByteReader(body);
    expect(reader.readU32()).toBe(HITINFO_AFFECTS_VICTIM | HITINFO_CRITICALHIT | HITINFO_BLOCK);
    expect(readPacked(reader)).toBe(7n);
    expect(readPacked(reader)).toBe(creature);
    expect(reader.readU32()).toBe(30);
    expect(reader.readU32()).toBe(10);
    expect(reader.readU8()).toBe(1);
    expect(reader.readU32()).toBe(1);
    expect(reader.readF32()).toBe(30);
    expect(reader.readU32()).toBe(30);
    expect(reader.readU8()).toBe(VICTIMSTATE_HIT);
    expect(reader.readU32()).toBe(0);
    expect(reader.readU32()).toBe(0);
    expect(reader.readU32()).toBe(5);
    expect(reader.remaining).toBe(0);
  });

  test("attack start uses full guids, attack stop packed guids and the dead flag", () => {
    const start = new ByteReader(attackStartPacket(1n, 2n));
    expect(start.readU64()).toBe(1n);
    expect(start.readU64()).toBe(2n);
    const stop = new ByteReader(attackStopPacket(1n, null, true));
    expect(readPacked(stop)).toBe(1n);
    expect(readPacked(stop)).toBe(0n);
    expect(stop.readU32()).toBe(1);
  });

  test("unit values update carries only the listed fields", () => {
    const reader = new ByteReader(unitValuesUpdate(0xf13000000c000001n, [{ index: UNIT_FIELD_HEALTH, value: 42 }]));
    expect(reader.readU32()).toBe(1);
    expect(reader.readU8()).toBe(0);
    expect(readPacked(reader)).toBe(0xf13000000c000001n);
    const blocks = reader.readU8();
    expect(blocks).toBe(5);
    const masks = Array.from({ length: blocks }, () => reader.readU32());
    expect(masks[0]).toBe(1 << UNIT_FIELD_HEALTH);
    expect(reader.readU32()).toBe(42);
    expect(reader.remaining).toBe(0);
  });
});
