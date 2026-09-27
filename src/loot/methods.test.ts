import { describe, expect, test } from "bun:test";
import { ByteReader } from "../net/byte-buffer.ts";
import {
  ALL_PERMISSION,
  DISENCHANT,
  FREE_FOR_ALL,
  GREED,
  GROUP_LOOT,
  GROUP_PERMISSION,
  ITEM_QUALITY_EPIC,
  ITEM_QUALITY_NORMAL,
  ITEM_QUALITY_POOR,
  ITEM_QUALITY_RARE,
  ITEM_QUALITY_UNCOMMON,
  LOOT_SLOT_TYPE_LOCKED,
  LOOT_SLOT_TYPE_MASTER,
  LootMethods,
  MASTER_LOOT,
  MASTER_PERMISSION,
  NEED,
  NEED_BEFORE_GREED,
  NOT_EMITED_YET,
  PASS,
  RESTRICTED_PERMISSION,
  ROLL_ALL_TYPE_NO_DISENCHANT,
  ROLL_DISENCHANT,
  ROLL_FLAG_TYPE_DISENCHANT,
  ROLL_FLAG_TYPE_NEED,
  ROLL_GREED,
  ROLL_NEED,
  ROLL_PASS,
  ROUND_ROBIN,
  ROUND_ROBIN_PERMISSION,
  SMSG_LOOT_MASTER_LIST,
  SMSG_LOOT_ROLL,
  SMSG_LOOT_ROLL_WON,
  SMSG_LOOT_START_ROLL,
  buildLootMasterList,
  buildLootRoll,
  buildLootRollWon,
  buildLootStartRoll,
  masterSlotType,
  nextRoundRobinGuid,
  permissionForMethod,
  startLoot,
  type LootMember,
} from "./methods.ts";

const A = 0x1000000000000001n;
const B = 0x1000000000000002n;
const C = 0x1000000000000003n;
const ITEM1 = 0x2000000000000001n;
const ITEM2 = 0x2000000000000002n;

function members(inRange: readonly [bigint, boolean][], canNeed?: readonly boolean[]): LootMember[] {
  return inRange.map(([guid, range], i) => ({
    guid,
    inRange: range,
    canNeed: canNeed?.[i],
  }));
}

describe("loot method enums and opcodes", () => {
  test("LootMethod and roll vote values match AzerothCore", () => {
    expect(FREE_FOR_ALL).toBe(0);
    expect(ROUND_ROBIN).toBe(1);
    expect(MASTER_LOOT).toBe(2);
    expect(GROUP_LOOT).toBe(3);
    expect(NEED_BEFORE_GREED).toBe(4);
    expect(PASS).toBe(0);
    expect(NEED).toBe(1);
    expect(GREED).toBe(2);
    expect(DISENCHANT).toBe(3);
    expect(NOT_EMITED_YET).toBe(4);
    expect(ROLL_PASS).toBe(0);
    expect(ROLL_NEED).toBe(1);
    expect(ROLL_GREED).toBe(2);
    expect(ROLL_DISENCHANT).toBe(3);
    expect(ITEM_QUALITY_POOR).toBe(0);
    expect(ITEM_QUALITY_UNCOMMON).toBe(2);
    expect(SMSG_LOOT_ROLL_WON).toBe(0x29f);
    expect(SMSG_LOOT_START_ROLL).toBe(0x2a1);
    expect(SMSG_LOOT_ROLL).toBe(0x2a2);
    expect(SMSG_LOOT_MASTER_LIST).toBe(0x2a4);
  });

  test("permission flags follow Player::SendLoot method switch", () => {
    expect(permissionForMethod(FREE_FOR_ALL, false)).toBe(ALL_PERMISSION);
    expect(permissionForMethod(ROUND_ROBIN, false)).toBe(ROUND_ROBIN_PERMISSION);
    expect(permissionForMethod(GROUP_LOOT, false)).toBe(GROUP_PERMISSION);
    expect(permissionForMethod(NEED_BEFORE_GREED, false)).toBe(GROUP_PERMISSION);
    expect(permissionForMethod(MASTER_LOOT, true)).toBe(MASTER_PERMISSION);
    expect(permissionForMethod(MASTER_LOOT, false)).toBe(RESTRICTED_PERMISSION);
    expect(masterSlotType(true)).toBe(LOOT_SLOT_TYPE_MASTER);
    expect(masterSlotType(false)).toBe(LOOT_SLOT_TYPE_LOCKED);
  });
});

describe("packet builders", () => {
  test("SMSG_LOOT_START_ROLL layout", () => {
    const body = buildLootStartRoll({
      itemGuid: ITEM1,
      mapId: 0,
      slot: 3,
      itemId: 12345,
      randomSuffix: 1,
      randomPropId: 2,
      count: 4,
      countdownMs: 60_000,
      rollVoteMask: ROLL_ALL_TYPE_NO_DISENCHANT,
    });
    const r = new ByteReader(body);
    expect(r.readU64()).toBe(ITEM1);
    expect(r.readU32()).toBe(0);
    expect(r.readU32()).toBe(3);
    expect(r.readU32()).toBe(12345);
    expect(r.readU32()).toBe(1);
    expect(r.readU32()).toBe(2);
    expect(r.readU32()).toBe(4);
    expect(r.readU32()).toBe(60_000);
    expect(r.readU8()).toBe(ROLL_ALL_TYPE_NO_DISENCHANT);
    expect(r.remaining).toBe(0);
  });

  test("SMSG_LOOT_ROLL and SMSG_LOOT_ROLL_WON layouts", () => {
    const roll = buildLootRoll({
      sourceGuid: 0n,
      slot: 1,
      targetGuid: A,
      itemId: 99,
      randomSuffix: 0,
      randomPropId: 0,
      rollNumber: 42,
      rollType: ROLL_NEED,
    });
    const rr = new ByteReader(roll);
    expect(rr.readU64()).toBe(0n);
    expect(rr.readU32()).toBe(1);
    expect(rr.readU64()).toBe(A);
    expect(rr.readU32()).toBe(99);
    expect(rr.readU32()).toBe(0);
    expect(rr.readU32()).toBe(0);
    expect(rr.readU8()).toBe(42);
    expect(rr.readU8()).toBe(ROLL_NEED);
    expect(rr.readU8()).toBe(0);

    const won = buildLootRollWon({
      sourceGuid: ITEM1,
      slot: 1,
      itemId: 99,
      randomSuffix: 0,
      randomPropId: 0,
      winnerGuid: A,
      rollNumber: 42,
      rollType: ROLL_NEED,
    });
    const wr = new ByteReader(won);
    expect(wr.readU64()).toBe(ITEM1);
    expect(wr.readU32()).toBe(1);
    expect(wr.readU32()).toBe(99);
    expect(wr.readU32()).toBe(0);
    expect(wr.readU32()).toBe(0);
    expect(wr.readU64()).toBe(A);
    expect(wr.readU8()).toBe(42);
    expect(wr.readU8()).toBe(ROLL_NEED);
  });

  test("SMSG_LOOT_MASTER_LIST layout", () => {
    const body = buildLootMasterList([A, B]);
    const r = new ByteReader(body);
    expect(r.readU8()).toBe(2);
    expect(r.readU64()).toBe(A);
    expect(r.readU64()).toBe(B);
    expect(r.remaining).toBe(0);
  });
});

describe("free for all", () => {
  test("any in-range member may take any item", () => {
    const loot = new LootMethods({
      method: FREE_FOR_ALL,
      threshold: ITEM_QUALITY_UNCOMMON,
      members: members([
        [A, true],
        [B, true],
        [C, false],
      ]),
      items: [
        { itemGuid: ITEM1, itemId: 1, quality: ITEM_QUALITY_EPIC, slot: 0 },
        { itemGuid: ITEM2, itemId: 2, quality: ITEM_QUALITY_POOR, slot: 1 },
      ],
    });
    expect(loot.whoReceives(ITEM1)).toBe("any");
    expect(loot.canTake(A, ITEM1)).toBe(true);
    expect(loot.canTake(B, ITEM2)).toBe(true);
    expect(loot.canTake(C, ITEM1)).toBe(false);
    expect(loot.rolls.size).toBe(0);
    expect(loot.takeItem(B, ITEM1)).toBe(true);
    expect(loot.whoReceives(ITEM1)).toBe(B);
  });
});

describe("round robin", () => {
  test("current player receives underthreshold items and advances on take", () => {
    const loot = new LootMethods({
      method: ROUND_ROBIN,
      threshold: ITEM_QUALITY_UNCOMMON,
      members: members([
        [A, true],
        [B, false],
        [C, true],
      ]),
      items: [
        { itemGuid: ITEM1, itemId: 1, quality: ITEM_QUALITY_POOR, slot: 0 },
        { itemGuid: ITEM2, itemId: 2, quality: ITEM_QUALITY_NORMAL, slot: 1 },
      ],
      roundRobinGuid: A,
    });
    expect(loot.whoReceives(ITEM1)).toBe(A);
    expect(loot.canTake(A, ITEM1)).toBe(true);
    expect(loot.canTake(C, ITEM1)).toBe(false);

    expect(loot.takeItem(A, ITEM1)).toBe(true);
    // B is out of range — skip to C
    expect(loot.roundRobinGuid).toBe(C);
    expect(loot.whoReceives(ITEM2)).toBe(C);
    expect(loot.takeItem(C, ITEM2)).toBe(true);
    expect(loot.roundRobinGuid).toBe(A);
  });

  test("nextRoundRobinGuid wraps and skips out-of-range", () => {
    const list = members([
      [A, false],
      [B, true],
      [C, false],
    ]);
    expect(nextRoundRobinGuid(list, A)).toBe(B);
    expect(nextRoundRobinGuid(list, B)).toBe(B);
    expect(nextRoundRobinGuid(list, C)).toBe(B);
  });
});

describe("master looter", () => {
  test("only the master may assign over-threshold; others cannot take", () => {
    const loot = new LootMethods({
      method: MASTER_LOOT,
      threshold: ITEM_QUALITY_UNCOMMON,
      members: members([
        [A, true],
        [B, true],
      ]),
      masterLooterGuid: A,
      items: [
        { itemGuid: ITEM1, itemId: 1, quality: ITEM_QUALITY_RARE, slot: 0 },
        { itemGuid: ITEM2, itemId: 2, quality: ITEM_QUALITY_POOR, slot: 1 },
      ],
      roundRobinGuid: B,
    });
    expect(loot.masterListPacket).not.toBeNull();
    expect(loot.permission(A)).toBe(MASTER_PERMISSION);
    expect(loot.permission(B)).toBe(RESTRICTED_PERMISSION);
    expect(loot.whoReceives(ITEM1)).toBe(A);
    expect(loot.canTake(A, ITEM1)).toBe(true);
    expect(loot.canTake(B, ITEM1)).toBe(false);
    expect(loot.assignMasterLoot(B, ITEM1, B)).toBe(false);
    expect(loot.assignMasterLoot(A, ITEM1, B)).toBe(true);
    expect(loot.whoReceives(ITEM1)).toBe(B);

    // Underthreshold still follows round robin
    expect(loot.whoReceives(ITEM2)).toBe(B);
    expect(loot.canTake(B, ITEM2)).toBe(true);
    expect(loot.canTake(A, ITEM2)).toBe(false);
  });
});

describe("group loot", () => {
  test("need beats greed; threshold gates the roll", () => {
    const loot = new LootMethods({
      method: GROUP_LOOT,
      threshold: ITEM_QUALITY_UNCOMMON,
      members: members([
        [A, true],
        [B, true],
      ]),
      items: [
        { itemGuid: ITEM1, itemId: 100, quality: ITEM_QUALITY_RARE, slot: 0 },
        { itemGuid: ITEM2, itemId: 200, quality: ITEM_QUALITY_POOR, slot: 1 },
      ],
      roundRobinGuid: A,
      rng: () => 50,
    });
    expect(loot.rolls.size).toBe(1);
    expect(loot.item(ITEM1)?.isBlocked).toBe(true);
    expect(loot.item(ITEM2)?.isUnderthreshold).toBe(true);
    expect(loot.whoReceives(ITEM2)).toBe(A);
    expect(loot.whoReceives(ITEM1)).toBe("rolling");

    const start = loot.startRollPackets.get(ITEM1);
    expect(start).toBeInstanceOf(Uint8Array);

    const need = loot.vote(ITEM1, A, ROLL_NEED);
    expect(need).not.toBeNull();
    expect(need!.outcome).toBeNull();
    const greed = loot.vote(ITEM1, B, ROLL_GREED);
    expect(greed).not.toBeNull();
    expect(greed!.outcome?.kind).toBe("won");
    if (greed!.outcome?.kind === "won") {
      expect(greed!.outcome.winnerGuid).toBe(A);
      expect(greed!.outcome.rollType).toBe(ROLL_NEED);
    }
    expect(loot.whoReceives(ITEM1)).toBe(A);
  });

  test("tie uses injected rolls; first max wins (strict <)", () => {
    const rolls = [80, 80];
    let i = 0;
    const loot = new LootMethods({
      method: GROUP_LOOT,
      threshold: ITEM_QUALITY_UNCOMMON,
      members: members([
        [A, true],
        [B, true],
      ]),
      items: [{ itemGuid: ITEM1, itemId: 1, quality: ITEM_QUALITY_UNCOMMON, slot: 0 }],
      rng: () => rolls[i++]!,
    });
    loot.vote(ITEM1, A, ROLL_NEED);
    const result = loot.vote(ITEM1, B, ROLL_NEED);
    expect(result?.outcome?.kind).toBe("won");
    if (result?.outcome?.kind === "won") {
      // A rolled first with 80; B also 80 — maxResult < randomN is false, A keeps win
      expect(result.outcome.winnerGuid).toBe(A);
      expect(result.outcome.rollNumber).toBe(80);
    }
  });

  test("higher injected roll wins the tie break", () => {
    const rolls = [40, 90];
    let i = 0;
    const loot = new LootMethods({
      method: GROUP_LOOT,
      threshold: ITEM_QUALITY_UNCOMMON,
      members: members([
        [A, true],
        [B, true],
      ]),
      items: [{ itemGuid: ITEM1, itemId: 1, quality: ITEM_QUALITY_RARE, slot: 0 }],
      rng: () => rolls[i++]!,
    });
    loot.vote(ITEM1, A, ROLL_GREED);
    const result = loot.vote(ITEM1, B, ROLL_GREED);
    expect(result?.outcome?.kind).toBe("won");
    if (result?.outcome?.kind === "won") {
      expect(result.outcome.winnerGuid).toBe(B);
      expect(result.outcome.rollNumber).toBe(90);
    }
  });
});

describe("need before greed", () => {
  test("greed-only items strip NEED; canNeed=false strips per player", () => {
    const started = startLoot({
      method: NEED_BEFORE_GREED,
      threshold: ITEM_QUALITY_UNCOMMON,
      members: members(
        [
          [A, true],
          [B, true],
        ],
        [true, false],
      ),
      items: [
        {
          itemGuid: ITEM1,
          itemId: 1,
          quality: ITEM_QUALITY_EPIC,
          slot: 0,
          greedOnly: true,
          canDisenchant: true,
        },
      ],
      mapId: 530,
    });
    const perPlayer = started.startRollPackets.get(ITEM1);
    expect(perPlayer).toBeInstanceOf(Map);
    const map = perPlayer as Map<bigint, Uint8Array>;
    const readMask = (body: Uint8Array): number => {
      const r = new ByteReader(body);
      r.readU64();
      r.readU32();
      r.readU32();
      r.readU32();
      r.readU32();
      r.readU32();
      r.readU32();
      r.readU32();
      return r.readU8();
    };
    // greedOnly → no NEED; canDisenchant → DE bit set
    const expectedBase = (ROLL_ALL_TYPE_NO_DISENCHANT | ROLL_FLAG_TYPE_DISENCHANT) & ~ROLL_FLAG_TYPE_NEED;
    expect(readMask(map.get(A)!)).toBe(expectedBase);
    // B also cannot need from greedOnly (already stripped) — same mask
    expect(readMask(map.get(B)!)).toBe(expectedBase);
  });

  test("canNeed=false strips NEED when item allows need", () => {
    const started = startLoot({
      method: NEED_BEFORE_GREED,
      threshold: ITEM_QUALITY_UNCOMMON,
      members: members(
        [
          [A, true],
          [B, true],
        ],
        [true, false],
      ),
      items: [{ itemGuid: ITEM1, itemId: 1, quality: ITEM_QUALITY_RARE, slot: 0 }],
    });
    const map = started.startRollPackets.get(ITEM1) as Map<bigint, Uint8Array>;
    const readMask = (body: Uint8Array): number => {
      const r = new ByteReader(body);
      r.readU64();
      r.readU32();
      r.readU32();
      r.readU32();
      r.readU32();
      r.readU32();
      r.readU32();
      r.readU32();
      return r.readU8();
    };
    expect(readMask(map.get(A)!)).toBe(ROLL_ALL_TYPE_NO_DISENCHANT);
    expect(readMask(map.get(B)!)).toBe(ROLL_ALL_TYPE_NO_DISENCHANT & ~ROLL_FLAG_TYPE_NEED);
  });

  test("need still beats greed on the shared CountTheRoll path", () => {
    const loot = new LootMethods({
      method: NEED_BEFORE_GREED,
      threshold: ITEM_QUALITY_UNCOMMON,
      members: members([
        [A, true],
        [B, true],
      ]),
      items: [{ itemGuid: ITEM1, itemId: 1, quality: ITEM_QUALITY_RARE, slot: 0 }],
      rng: () => 10,
    });
    loot.vote(ITEM1, A, ROLL_GREED);
    const result = loot.vote(ITEM1, B, ROLL_NEED);
    expect(result?.outcome?.kind).toBe("won");
    if (result?.outcome?.kind === "won") {
      expect(result.outcome.winnerGuid).toBe(B);
      expect(result.outcome.rollType).toBe(ROLL_NEED);
    }
  });
});

describe("timeout", () => {
  test("timed-out unresolved voters pass", () => {
    const loot = new LootMethods({
      method: GROUP_LOOT,
      threshold: ITEM_QUALITY_UNCOMMON,
      members: members([
        [A, true],
        [B, true],
      ]),
      items: [{ itemGuid: ITEM1, itemId: 1, quality: ITEM_QUALITY_RARE, slot: 0 }],
      rng: () => 77,
    });
    loot.vote(ITEM1, A, ROLL_NEED);
    const outcome = loot.resolve(ITEM1, true);
    expect(outcome?.kind).toBe("won");
    if (outcome?.kind === "won") {
      expect(outcome.winnerGuid).toBe(A);
    }
    expect(loot.roll(ITEM1)?.playerVote.get(B)).toBe(PASS);
  });

  test("all timeout-pass yields all_passed and unblocks", () => {
    const loot = new LootMethods({
      method: GROUP_LOOT,
      threshold: ITEM_QUALITY_UNCOMMON,
      members: members([
        [A, true],
        [B, true],
      ]),
      items: [{ itemGuid: ITEM1, itemId: 1, quality: ITEM_QUALITY_RARE, slot: 0 }],
    });
    const outcome = loot.resolve(ITEM1, true);
    expect(outcome?.kind).toBe("all_passed");
    expect(loot.item(ITEM1)?.isBlocked).toBe(false);
    expect(loot.whoReceives(ITEM1)).toBe("any");
  });
});
