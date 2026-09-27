import { describe, expect, test } from "bun:test";
import { ByteReader } from "../net/byte-buffer.ts";
import {
  buildLogoutCancelAck,
  buildLogoutComplete,
  buildLogoutResponse,
  cancel,
  CMSG_LOGOUT_CANCEL,
  CMSG_LOGOUT_REQUEST,
  complete,
  DEFAULT_LOGOUT_TIMER_MS,
  LOGOUT_RESULT_COMBAT,
  LOGOUT_RESULT_FALLING,
  LOGOUT_RESULT_OK,
  request,
  shouldComplete,
  SMSG_LOGOUT_CANCEL_ACK,
  SMSG_LOGOUT_COMPLETE,
  SMSG_LOGOUT_RESPONSE,
} from "./logout.ts";

describe("opcodes (build 12340)", () => {
  test("match Opcodes.cpp", () => {
    expect(CMSG_LOGOUT_REQUEST).toBe(0x04b);
    expect(SMSG_LOGOUT_RESPONSE).toBe(0x04c);
    expect(SMSG_LOGOUT_COMPLETE).toBe(0x04d);
    expect(CMSG_LOGOUT_CANCEL).toBe(0x04e);
    expect(SMSG_LOGOUT_CANCEL_ACK).toBe(0x04f);
  });
});

describe("packet builders", () => {
  test("LogoutResponse is uint32 result + uint8 instant", () => {
    const body = buildLogoutResponse(1, false);
    const reader = new ByteReader(body);
    expect(reader.readU32()).toBe(1);
    expect(reader.readU8()).toBe(0);
    expect(reader.remaining).toBe(0);

    const instant = new ByteReader(buildLogoutResponse(0, true));
    expect(instant.readU32()).toBe(0);
    expect(instant.readU8()).toBe(1);
  });

  test("complete and cancel ack are empty", () => {
    expect(buildLogoutComplete().length).toBe(0);
    expect(buildLogoutCancelAck().length).toBe(0);
  });
});

describe("request", () => {
  test("resting and not in combat logs out instantly with complete", () => {
    const result = request({ inCombat: false, resting: true, nowMs: 1000 });
    expect(result.accepted).toBe(true);
    expect(result.instant).toBe(true);
    expect(result.completeAtMs).toBeNull();
    expect(result.packets.map((p) => p.name)).toEqual([
      "SMSG_LOGOUT_RESPONSE",
      "SMSG_LOGOUT_COMPLETE",
    ]);
    const reader = new ByteReader(result.packets[0]!.body);
    expect(reader.readU32()).toBe(LOGOUT_RESULT_OK);
    expect(reader.readU8()).toBe(1);
  });

  test("combat without resting rejects with result 1 and no complete", () => {
    const result = request({ inCombat: true, resting: false, nowMs: 1000 });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe(LOGOUT_RESULT_COMBAT);
    expect(result.completeAtMs).toBeNull();
    expect(result.packets.map((p) => p.name)).toEqual(["SMSG_LOGOUT_RESPONSE"]);
    const reader = new ByteReader(result.packets[0]!.body);
    expect(reader.readU32()).toBe(1);
    expect(reader.readU8()).toBe(0);
  });

  test("timer starts without complete until elapsed", () => {
    const nowMs = 50_000;
    const result = request({
      inCombat: false,
      resting: false,
      nowMs,
      logoutMs: DEFAULT_LOGOUT_TIMER_MS,
    });
    expect(result.accepted).toBe(true);
    expect(result.instant).toBe(false);
    expect(result.completeAtMs).toBe(nowMs + DEFAULT_LOGOUT_TIMER_MS);
    expect(result.packets.map((p) => p.name)).toEqual(["SMSG_LOGOUT_RESPONSE"]);
    expect(result.packets.some((p) => p.name === "SMSG_LOGOUT_COMPLETE")).toBe(false);

    expect(shouldComplete(result.completeAtMs, nowMs + DEFAULT_LOGOUT_TIMER_MS - 1)).toBe(false);
    expect(shouldComplete(result.completeAtMs, nowMs + DEFAULT_LOGOUT_TIMER_MS)).toBe(true);

    const done = complete();
    expect(done.packets.map((p) => p.name)).toEqual(["SMSG_LOGOUT_COMPLETE"]);
  });

  test("resting in combat still accepts but uses the timer (not instant)", () => {
    const result = request({ inCombat: true, resting: true, nowMs: 0, logoutMs: 20_000 });
    expect(result.accepted).toBe(true);
    expect(result.instant).toBe(false);
    expect(result.completeAtMs).toBe(20_000);
    expect(result.packets.map((p) => p.name)).toEqual(["SMSG_LOGOUT_RESPONSE"]);
  });

  test("falling denies with result 3", () => {
    const result = request({ inCombat: false, resting: false, nowMs: 0, falling: true });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe(LOGOUT_RESULT_FALLING);
  });

  test("in flight is instant even when not resting", () => {
    const result = request({ inCombat: false, resting: false, nowMs: 0, inFlight: true });
    expect(result.instant).toBe(true);
    expect(result.completeAtMs).toBeNull();
    expect(result.packets).toHaveLength(2);
  });
});

describe("cancel", () => {
  test("clears the request with cancel ack", () => {
    const pending = request({ inCombat: false, resting: false, nowMs: 0, logoutMs: 20_000 });
    expect(pending.completeAtMs).not.toBeNull();
    const cleared = cancel();
    expect(cleared.completeAtMs).toBeNull();
    expect(cleared.packets[0]!.opcode).toBe(SMSG_LOGOUT_CANCEL_ACK);
    expect(cleared.packets[0]!.name).toBe("SMSG_LOGOUT_CANCEL_ACK");
  });
});
