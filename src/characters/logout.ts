import { ByteWriter } from "../net/byte-buffer.ts";

/** Opcodes from `Opcodes.cpp` (build 12340). */
export const CMSG_LOGOUT_REQUEST = 0x04b;
export const SMSG_LOGOUT_RESPONSE = 0x04c;
export const SMSG_LOGOUT_COMPLETE = 0x04d;
export const CMSG_LOGOUT_CANCEL = 0x04e;
export const SMSG_LOGOUT_CANCEL_ACK = 0x04f;

/**
 * `WorldSession::ShouldLogOut` uses a fixed `+ 20` seconds.
 * There is no `LogoutTime` worldserver.conf key — pass `logoutMs` instead of hardcoding a second default elsewhere.
 */
export const DEFAULT_LOGOUT_TIMER_MS = 20_000;

/** `LogoutResponse.LogoutResult` reasons from `HandleLogoutRequestOpcode`. */
export const LOGOUT_RESULT_OK = 0;
export const LOGOUT_RESULT_COMBAT = 1;
export const LOGOUT_RESULT_DENIED = 2;
export const LOGOUT_RESULT_FALLING = 3;

export type LogoutPacketName = "SMSG_LOGOUT_RESPONSE" | "SMSG_LOGOUT_COMPLETE" | "SMSG_LOGOUT_CANCEL_ACK";

export type LogoutPacket = {
  opcode: number;
  name: LogoutPacketName;
  body: Uint8Array;
};

export type LogoutRequestInput = {
  inCombat: boolean;
  resting: boolean;
  nowMs: number;
  /** Milliseconds; defaults to `DEFAULT_LOGOUT_TIMER_MS` (C++ hardcoded 20s). */
  logoutMs?: number;
  /** Taxi / flight — instant logout like resting. */
  inFlight?: boolean;
  /** Falling / jumping — deny with result 3. */
  falling?: boolean;
  /** RBAC instant logout (GM). */
  instantPermission?: boolean;
};

export type LogoutRequestResult = {
  packets: LogoutPacket[];
  /**
   * When set, the caller must wait until `nowMs >= completeAtMs`, then save and send
   * `SMSG_LOGOUT_COMPLETE` via `complete()`. Never set when complete is already in `packets`.
   */
  completeAtMs: number | null;
  accepted: boolean;
  reason: number;
  instant: boolean;
};

/** `WorldPackets::Character::LogoutResponse` — uint32 result + uint8 instant. */
export function buildLogoutResponse(result: number, instant: boolean): Uint8Array {
  return new ByteWriter().writeU32(result >>> 0).writeU8(instant ? 1 : 0).toUint8Array();
}

export function buildLogoutComplete(): Uint8Array {
  return new Uint8Array(0);
}

export function buildLogoutCancelAck(): Uint8Array {
  return new Uint8Array(0);
}

function responsePacket(result: number, instant: boolean): LogoutPacket {
  return {
    opcode: SMSG_LOGOUT_RESPONSE,
    name: "SMSG_LOGOUT_RESPONSE",
    body: buildLogoutResponse(result, instant),
  };
}

function completePacket(): LogoutPacket {
  return {
    opcode: SMSG_LOGOUT_COMPLETE,
    name: "SMSG_LOGOUT_COMPLETE",
    body: buildLogoutComplete(),
  };
}

function cancelAckPacket(): LogoutPacket {
  return {
    opcode: SMSG_LOGOUT_CANCEL_ACK,
    name: "SMSG_LOGOUT_CANCEL_ACK",
    body: buildLogoutCancelAck(),
  };
}

/**
 * `WorldSession::HandleLogoutRequestOpcode` decision tree (combat / rest / timer).
 * Does not send `SMSG_LOGOUT_COMPLETE` in the same call when a timer is required.
 */
export function request(input: LogoutRequestInput): LogoutRequestResult {
  const logoutMs = input.logoutMs ?? DEFAULT_LOGOUT_TIMER_MS;
  const inFlight = input.inFlight ?? false;
  const falling = input.falling ?? false;
  const instantPermission = input.instantPermission ?? false;

  const instantLogout =
    instantPermission || (input.resting && !input.inCombat) || inFlight;
  const canLogoutInCombat = input.resting;

  let reason = LOGOUT_RESULT_OK;
  if (input.inCombat && !canLogoutInCombat) {
    reason = LOGOUT_RESULT_COMBAT;
  } else if (falling) {
    reason = LOGOUT_RESULT_FALLING;
  }

  if (reason !== LOGOUT_RESULT_OK) {
    return {
      packets: [responsePacket(reason, false)],
      completeAtMs: null,
      accepted: false,
      reason,
      instant: false,
    };
  }

  if (instantLogout) {
    return {
      packets: [responsePacket(LOGOUT_RESULT_OK, true), completePacket()],
      completeAtMs: null,
      accepted: true,
      reason: LOGOUT_RESULT_OK,
      instant: true,
    };
  }

  return {
    packets: [responsePacket(LOGOUT_RESULT_OK, false)],
    completeAtMs: input.nowMs + logoutMs,
    accepted: true,
    reason: LOGOUT_RESULT_OK,
    instant: false,
  };
}

/** `WorldSession::HandleLogoutCancelOpcode` — clear the pending timer. */
export function cancel(): { packets: LogoutPacket[]; completeAtMs: null } {
  return { packets: [cancelAckPacket()], completeAtMs: null };
}

/**
 * After the logout timer elapses — caller saves the character, then sends this.
 * Matches `LogoutPlayer` sending `SMSG_LOGOUT_COMPLETE`.
 */
export function complete(): { packets: LogoutPacket[] } {
  return { packets: [completePacket()] };
}

/** `WorldSession::ShouldLogOut` — true when the pending timer has elapsed. */
export function shouldComplete(completeAtMs: number | null, nowMs: number): boolean {
  return completeAtMs !== null && nowMs >= completeAtMs;
}
