import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import { encodeServerPacket } from "./packets.ts";
import type { WorldCrypt } from "../crypto/world-crypt.ts";

const FORWARD = 0x00000001;
const BACKWARD = 0x00000002;
const STRAFE_LEFT = 0x00000004;
const STRAFE_RIGHT = 0x00000008;
const LEFT = 0x00000010;
const RIGHT = 0x00000020;
const PITCH_UP = 0x00000040;
const PITCH_DOWN = 0x00000080;
const ON_TRANSPORT = 0x00000200;
const DISABLE_GRAVITY = 0x00000400;
const ROOT = 0x00000800;
const FALLING = 0x00001000;
const FALLING_FAR = 0x00002000;
const SWIMMING = 0x00200000;
const ASCENDING = 0x00400000;
const DESCENDING = 0x00800000;
const CAN_FLY = 0x01000000;
const FLYING = 0x02000000;
const SPLINE_ELEVATION = 0x04000000;
const SPLINE_ENABLED = 0x08000000;
const WATERWALKING = 0x10000000;
const FALLING_SLOW = 0x20000000;
const HOVER = 0x40000000;

const ALWAYS_ALLOW_PITCHING = 0x00000020;
const INTERPOLATED_MOVEMENT = 0x00000400;

const MAP_LIMIT = 17066.666;
const GRID_SIZE = 533.33333;

const MOVE = new Set([
  0x0b5, 0x0b6, 0x0b7, 0x0b8, 0x0b9, 0x0ba, 0x0bb, 0x0bc, 0x0bd, 0x0be, 0x0bf, 0x0c0, 0x0c1, 0x0c2, 0x0c3, 0x0c9, 0x0ca,
  0x0cb, 0x0da, 0x0db, 0x0ee, 0x2ca, 0x346, 0x359, 0x35a, 0x38d, 0x3a7,
]);

const SPEED_LIMIT = new Map<number, { opcode: number; limit: number; run: boolean }>([
  [0x2db, { opcode: 0x2da, limit: 2.5, run: false }],
  [0x0e3, { opcode: 0x0e2, limit: 7, run: true }],
  [0x0e5, { opcode: 0x0e4, limit: 4.5, run: false }],
  [0x0e7, { opcode: 0x0e6, limit: 4.722222, run: false }],
  [0x2dd, { opcode: 0x2dc, limit: 2.5, run: false }],
  [0x2df, { opcode: 0x2de, limit: 3.141594, run: false }],
  [0x382, { opcode: 0x381, limit: 7, run: false }],
  [0x384, { opcode: 0x383, limit: 4.5, run: false }],
  [0x45d, { opcode: 0x45c, limit: 3.14, run: false }],
]);

const ROOT_ACK = new Set([0x0e9, 0x0eb]);
const FLAG_ACK = new Set([0x0f6, 0x2cf, 0x2d0, 0x345, 0x4cf, 0x4d1]);

export type MoveTransport = {
  guid: bigint;
  x: number;
  y: number;
  z: number;
  orientation: number;
  time: number;
  seat: number;
  time2: number | null;
};

export type MoveJump = { z: number; sin: number; cos: number; xy: number };

export type MoveInfo = {
  guid: bigint;
  flags: number;
  flags2: number;
  time: number;
  x: number;
  y: number;
  z: number;
  orientation: number;
  fallTime: number;
  pitch: number | null;
  transport: MoveTransport | null;
  jump: MoveJump | null;
  splineElevation: number | null;
  speed: number | null;
  timeSkipped: number | null;
};

export type MovementKind = "move" | "speed" | "root" | "knock" | "flag" | "spline" | "skip" | "active" | "teleport" | "worldport" | "not-active";

const MOVING_OR_TURNING =
  FORWARD |
  BACKWARD |
  STRAFE_LEFT |
  STRAFE_RIGHT |
  LEFT |
  RIGHT |
  PITCH_UP |
  PITCH_DOWN |
  FALLING |
  FALLING_FAR |
  ASCENDING |
  DESCENDING |
  SPLINE_ELEVATION;

export function movingOrTurning(flags: number): boolean {
  return (flags & MOVING_OR_TURNING) !== 0;
}

export function movementKind(opcode: number): MovementKind | null {
  if (MOVE.has(opcode)) {
    return "move";
  }
  if (SPEED_LIMIT.has(opcode) || opcode === 0x517) {
    return "speed";
  }
  if (ROOT_ACK.has(opcode)) {
    return "root";
  }
  if (opcode === 0x0f0) {
    return "knock";
  }
  if (FLAG_ACK.has(opcode)) {
    return "flag";
  }
  if (opcode === 0x2c9) {
    return "spline";
  }
  if (opcode === 0x2ce) {
    return "skip";
  }
  if (opcode === 0x26a) {
    return "active";
  }
  if (opcode === 0x0c7) {
    return "teleport";
  }
  if (opcode === 0x0dc) {
    return "worldport";
  }
  if (opcode === 0x2d1) {
    return "not-active";
  }
  return null;
}

export function readMoveInfo(kind: MovementKind, payload: Uint8Array): MoveInfo | null {
  if (kind === "worldport") {
    return empty();
  }
  try {
    const reader = new ByteReader(payload);
    if (kind === "active") {
      const info = empty();
      info.guid = reader.readU64();
      return info;
    }
    if (kind === "teleport") {
      const info = empty();
      info.guid = readPackedGuid(reader);
      reader.readU32();
      reader.readU32();
      return info;
    }
    if (kind === "skip") {
      const info = empty();
      info.guid = readPackedGuid(reader);
      info.timeSkipped = reader.readU32();
      return info;
    }
    const info = empty();
    info.guid = readPackedGuid(reader);
    if (kind === "speed" || kind === "root" || kind === "flag") {
      reader.readU32();
    }
    if (kind === "knock") {
      reader.readU32();
    }
    const rawFlags = reader.readU32();
    info.flags = sanitizeFlags(rawFlags);
    info.flags2 = reader.readU16();
    info.time = reader.readU32();
    info.x = reader.readF32();
    info.y = reader.readF32();
    info.z = reader.readF32();
    info.orientation = reader.readF32();
    if (rawFlags & ON_TRANSPORT) {
      const transportGuid = readPackedGuid(reader);
      const tx = reader.readF32();
      const ty = reader.readF32();
      const tz = reader.readF32();
      const to = reader.readF32();
      const transportTime = reader.readU32();
      const seat = reader.readU8();
      const time2 = info.flags2 & INTERPOLATED_MOVEMENT ? reader.readU32() : null;
      info.transport = { guid: transportGuid, x: tx, y: ty, z: tz, orientation: to, time: transportTime, seat, time2 };
      if (!validCoord(info.x + tx, info.y + ty, info.z + tz, info.orientation + to)) {
        return null;
      }
    }
    if (rawFlags & (SWIMMING | FLYING) || info.flags2 & ALWAYS_ALLOW_PITCHING) {
      info.pitch = reader.readF32();
    }
    info.fallTime = reader.readU32();
    if (rawFlags & FALLING) {
      info.jump = { z: reader.readF32(), sin: reader.readF32(), cos: reader.readF32(), xy: reader.readF32() };
    }
    if (rawFlags & SPLINE_ELEVATION) {
      info.splineElevation = reader.readF32();
    }
    if (kind === "speed") {
      info.speed = reader.readF32();
    }
    if (!validCoord(info.x, info.y, info.z, info.orientation)) {
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

export function transportTooFar(info: MoveInfo, current: { x: number; y: number }): boolean {
  if ((info.flags & ON_TRANSPORT) === 0) {
    return false;
  }
  const dx = info.x - current.x;
  const dy = info.y - current.y;
  return Math.hypot(dx, dy) > GRID_SIZE;
}

export function speedVerdict(opcode: number, speed: number): "ok" | "correct" | "kick" {
  const limit = SPEED_LIMIT.get(opcode);
  if (!limit || !Number.isFinite(speed)) {
    return "ok";
  }
  if (speed > limit.limit + 0.01) {
    return "kick";
  }
  if (limit.limit - speed > 0.01) {
    return "correct";
  }
  return "ok";
}

export function writeMoveInfo(info: MoveInfo): Uint8Array {
  const body = new ByteWriter()
    .writeBytes(packedGuid(info.guid))
    .writeU32(info.flags)
    .writeU16(info.flags2)
    .writeU32(info.time)
    .writeF32(info.x)
    .writeF32(info.y)
    .writeF32(info.z)
    .writeF32(info.orientation);
  if (info.flags & ON_TRANSPORT && info.transport) {
    body
      .writeBytes(packedGuid(info.transport.guid))
      .writeF32(info.transport.x)
      .writeF32(info.transport.y)
      .writeF32(info.transport.z)
      .writeF32(info.transport.orientation)
      .writeU32(info.transport.time)
      .writeU8(info.transport.seat);
    if (info.transport.time2 !== null) {
      body.writeU32(info.transport.time2);
    }
  }
  if (info.flags & (SWIMMING | FLYING) || info.flags2 & ALWAYS_ALLOW_PITCHING) {
    body.writeF32(info.pitch ?? 0);
  }
  body.writeU32(info.fallTime);
  if (info.flags & FALLING && info.jump) {
    body.writeF32(info.jump.z).writeF32(info.jump.sin).writeF32(info.jump.cos).writeF32(info.jump.xy);
  }
  if (info.flags & SPLINE_ELEVATION) {
    body.writeF32(info.splineElevation ?? 0);
  }
  return body.toUint8Array();
}

export function nearTeleportPacket(crypt: WorldCrypt, guid: bigint, counter: number, place: { x: number; y: number; z: number; orientation: number }): Uint8Array {
  const body = new ByteWriter()
    .writeBytes(packedGuid(guid))
    .writeU32(counter)
    .writeU32(0)
    .writeU16(0)
    .writeU32(0)
    .writeF32(place.x)
    .writeF32(place.y)
    .writeF32(place.z)
    .writeF32(place.orientation)
    .writeU32(0);
  return encodeServerPacket(0x0c7, body.toUint8Array(), crypt);
}

export function farTeleportPackets(crypt: WorldCrypt, map: number, place: { x: number; y: number; z: number; orientation: number }): Uint8Array[] {
  const pending = new ByteWriter().writeU32(map).toUint8Array();
  const world = new ByteWriter().writeU32(map).writeF32(place.x).writeF32(place.y).writeF32(place.z).writeF32(place.orientation).toUint8Array();
  return [encodeServerPacket(0x03f, pending, crypt), encodeServerPacket(0x03e, world, crypt)];
}

export function forceSpeedPacket(crypt: WorldCrypt, opcode: number, guid: bigint, counter: number): Uint8Array | null {
  const limit = SPEED_LIMIT.get(opcode);
  if (!limit) {
    return null;
  }
  const body = new ByteWriter().writeBytes(packedGuid(guid)).writeU32(counter);
  if (limit.run) {
    body.writeU8(0);
  }
  body.writeF32(limit.limit);
  return encodeServerPacket(limit.opcode, body.toUint8Array(), crypt);
}

export function sanitizeFlags(flags: number): number {
  let next = flags & ~ROOT & ~HOVER & ~WATERWALKING & ~FALLING_SLOW & ~(FLYING | CAN_FLY) & ~SPLINE_ENABLED;
  if (next & ASCENDING && next & DESCENDING) {
    next &= ~(ASCENDING | DESCENDING);
  }
  if (next & LEFT && next & RIGHT) {
    next &= ~(LEFT | RIGHT);
  }
  if (next & STRAFE_LEFT && next & STRAFE_RIGHT) {
    next &= ~(STRAFE_LEFT | STRAFE_RIGHT);
  }
  if (next & PITCH_UP && next & PITCH_DOWN) {
    next &= ~(PITCH_UP | PITCH_DOWN);
  }
  if (next & FORWARD && next & BACKWARD) {
    next &= ~(FORWARD | BACKWARD);
  }
  if (next & (CAN_FLY | DISABLE_GRAVITY) && next & FALLING) {
    next &= ~FALLING;
  }
  return next >>> 0;
}

const MIN_FALL_DISTANCE = 13.48;
const FALL_SLOPE = 0.018;
const FALL_INTERCEPT = -0.2426;

export function fallDamage(zDiff: number, maxHealth: number): number {
  if (zDiff < MIN_FALL_DISTANCE) {
    return 0;
  }
  const percent = FALL_SLOPE * zDiff + FALL_INTERCEPT;
  if (percent <= 0) {
    return 0;
  }
  return Math.min(maxHealth, Math.floor(percent * maxHealth));
}

export function shouldResetFall(lastFallTime: number, lastFallZ: number, fallTime: number, z: number, landed: boolean): boolean {
  return lastFallTime >= fallTime || lastFallZ <= z || landed;
}

function empty(): MoveInfo {
  return {
    guid: 0n,
    flags: 0,
    flags2: 0,
    time: 0,
    x: 0,
    y: 0,
    z: 0,
    orientation: 0,
    fallTime: 0,
    pitch: null,
    transport: null,
    jump: null,
    splineElevation: null,
    speed: null,
    timeSkipped: null,
  };
}

function validCoord(x: number, y: number, z: number, orientation: number): boolean {
  return [x, y, z, orientation].every((value) => Number.isFinite(value) && Math.abs(value) <= MAP_LIMIT);
}

function readPackedGuid(reader: ByteReader): bigint {
  const mask = reader.readU8();
  let guid = 0n;
  for (let index = 0; index < 8; index++) {
    if (mask & (1 << index)) {
      guid |= BigInt(reader.readU8()) << BigInt(index * 8);
    }
  }
  return guid;
}

function packedGuid(guid: bigint): Uint8Array {
  let mask = 0;
  const bytes: number[] = [];
  for (let index = 0; index < 8; index++) {
    const byte = Number((guid >> BigInt(index * 8)) & 0xffn);
    if (byte !== 0) {
      mask |= 1 << index;
      bytes.push(byte);
    }
  }
  return Uint8Array.of(mask, ...bytes);
}
