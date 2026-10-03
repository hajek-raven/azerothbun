/**
 * Port of `game/Movement/Spline/MovementPacketBuilder.{h,cpp}`: the spline part of `SMSG_MONSTER_MOVE` /
 * `SMSG_MONSTER_MOVE_TRANSPORT` (3.3.5a build 12340) and of the movement block of a create update.
 *
 * `ByteBuffer` is the repo's `ByteWriter`. Each `data << x` is the `write*` call of the C++ type of `x`
 * (`uint8` `writeU8`, `uint32` / `int32` `writeU32` of the unsigned value, `float` `writeF32`).
 */
import type { ByteWriter } from "../../../net/byte-buffer.ts";
import type { Vector3 } from "../../../math/Vector3.ts";
import { MoveSplineFlag } from "./MoveSplineFlag.ts";
import type { MoveSpline } from "./MoveSpline.ts";
import type { Spline } from "./Spline.ts";
import { floatToInt32 } from "./MovementTypedefs.ts";

const fround = Math.fround;

/** `data << Vector3`: three floats. @ac game/Movement/Spline/MovementPacketBuilder.cpp Movement::operator<<(ByteBuffer&, Vector3 const&) */
function writeVector3(b: ByteWriter, v: Vector3): void {
  b.writeF32(v.x).writeF32(v.y).writeF32(v.z);
}

/** `data.append<Vector3>(&points[from], count)` */
function appendVector3(b: ByteWriter, points: readonly Vector3[], from: number, count: number): void {
  for (let i = 0; i < count; ++i) writeVector3(b, points[from + i]!);
}

/** `ByteBuffer::appendPackXYZ`, "can be used in SMSG_MONSTER_MOVE opcode". @ac shared/Packets/ByteBuffer.h ByteBuffer::appendPackXYZ */
export function appendPackXYZ(b: ByteWriter, x: number, y: number, z: number): void {
  let packed = 0;
  packed |= floatToInt32(fround(fround(x) / 0.25)) & 0x7ff;
  packed |= (floatToInt32(fround(fround(y) / 0.25)) & 0x7ff) << 11;
  packed |= (floatToInt32(fround(fround(z) / 0.25)) & 0x3ff) << 22;
  b.writeU32(packed >>> 0);
}

/** @ac game/Movement/Spline/MovementPacketBuilder.cpp Movement::MonsterMoveType */
export const MonsterMoveNormal = 0;
export const MonsterMoveStop = 1;
export const MonsterMoveFacingSpot = 2;
export const MonsterMoveFacingTarget = 3;
export const MonsterMoveFacingAngle = 4;
export const MonsterMoveType = {
  MonsterMoveNormal,
  MonsterMoveStop,
  MonsterMoveFacingSpot,
  MonsterMoveFacingTarget,
  MonsterMoveFacingAngle,
} as const;
export type MonsterMoveType = (typeof MonsterMoveType)[keyof typeof MonsterMoveType];

/** @ac game/Movement/Spline/MovementPacketBuilder.cpp Movement::WriteLinearPath */
export function WriteLinearPath(spline: Spline, data: ByteWriter): void {
  const last_idx = spline.getPointCount() - 3;
  const real_path = (i: number): Vector3 => spline.getPoint(1 + i);

  data.writeU32(last_idx >>> 0);
  writeVector3(data, real_path(last_idx)); // destination
  if (last_idx > 1) {
    // Vector3 middle = (real_path[0] + real_path[last_idx]) / 2.f;
    const a = real_path(0);
    const b = real_path(last_idx);
    const mx = fround(fround(a.x + b.x) * 0.5);
    const my = fround(fround(a.y + b.y) * 0.5);
    const mz = fround(fround(a.z + b.z) * 0.5);
    // first and last points already appended
    for (let i = 1; i < last_idx; ++i) {
      const p = real_path(i);
      appendPackXYZ(data, fround(mx - p.x), fround(my - p.y), fround(mz - p.z));
    }
  }
}

/** @ac game/Movement/Spline/MovementPacketBuilder.cpp Movement::WriteCatmullRomPath */
export function WriteCatmullRomPath(spline: Spline, data: ByteWriter): void {
  const count = spline.getPointCount() - 3;
  data.writeU32(count >>> 0);
  appendVector3(data, spline.getPoints(), 2, count);
}

/** @ac game/Movement/Spline/MovementPacketBuilder.cpp Movement::WriteCatmullRomCyclicPath */
export function WriteCatmullRomCyclicPath(spline: Spline, data: ByteWriter, flying: boolean): void {
  const count = spline.getPointCount() - 3;
  data.writeU32((count + 1) >>> 0);
  if (flying) {
    writeVector3(data, spline.getPoint(1)); // fake point, client will erase it from the spline after first cycle done
    appendVector3(data, spline.getPoints(), 2, count);
  } else {
    appendVector3(data, spline.getPoints(), 2, count);
    data.writeF32(0).writeF32(0).writeF32(0); //Xinef: fake point (Vector3::zero())
  }
}

/** @ac game/Movement/Spline/MovementPacketBuilder.h Movement::PacketBuilder */
export class PacketBuilder {
  /** @ac game/Movement/Spline/MovementPacketBuilder.cpp PacketBuilder::WriteCommonMonsterMovePart */
  private static writeCommonMonsterMovePart(move_spline: MoveSpline, data: ByteWriter): void {
    const splineflags = move_spline.splineflags.clone();

    data.writeU8(0); // sets/unsets MOVEMENTFLAG2_UNK7 (0x40)
    writeVector3(data, move_spline.spline.getPoint(move_spline.spline.first()));
    data.writeU32(move_spline.getId());

    switch (splineflags.and(MoveSplineFlag.Mask_Final_Facing)) {
      case MoveSplineFlag.Final_Target:
        data.writeU8(MonsterMoveFacingTarget);
        data.writeU64(move_spline.facing.target);
        break;
      case MoveSplineFlag.Final_Angle:
        data.writeU8(MonsterMoveFacingAngle);
        data.writeF32(move_spline.facing.angle);
        break;
      case MoveSplineFlag.Final_Point:
        data.writeU8(MonsterMoveFacingSpot);
        data.writeF32(move_spline.facing.f.x).writeF32(move_spline.facing.f.y).writeF32(move_spline.facing.f.z);
        break;
      default:
        data.writeU8(MonsterMoveNormal);
        break;
    }

    // add fake Enter_Cycle flag - needed for client-side cyclic movement (client will erase first spline vertex after first cycle done)
    // Xinef: this flag breaks cycle for ground movement, client teleports npc between last and first point instead of using smooth movement
    if (splineflags.and(MoveSplineFlag.Flying) !== 0) splineflags.enter_cycle = move_spline.isCyclic();
    data.writeU32(splineflags.and(~MoveSplineFlag.Mask_No_Monster_Move >>> 0));

    if (splineflags.animation) {
      data.writeU8(splineflags.getAnimationId());
      data.writeU32(move_spline.effect_start_time >>> 0);
    }

    data.writeU32(move_spline.duration() >>> 0);

    if (splineflags.parabolic) {
      data.writeF32(move_spline.vertical_acceleration);
      data.writeU32(move_spline.effect_start_time >>> 0);
    }
  }

  /** @ac game/Movement/Spline/MovementPacketBuilder.cpp PacketBuilder::WriteStopMovement */
  static writeStopMovement(pos: Vector3, splineId: number, data: ByteWriter): void {
    data.writeU8(0); // sets/unsets MOVEMENTFLAG2_UNK7 (0x40)
    writeVector3(data, pos);
    data.writeU32(splineId >>> 0);
    data.writeU8(MonsterMoveStop);
  }

  /** @ac game/Movement/Spline/MovementPacketBuilder.cpp PacketBuilder::WriteMonsterMove */
  static writeMonsterMove(move_spline: MoveSpline, data: ByteWriter): void {
    PacketBuilder.writeCommonMonsterMovePart(move_spline, data);

    const spline = move_spline.spline;
    const splineflags = move_spline.splineflags;
    if (splineflags.and(MoveSplineFlag.Mask_CatmullRom) !== 0) {
      if (splineflags.cyclic) WriteCatmullRomCyclicPath(spline, data, splineflags.and(MoveSplineFlag.Flying) !== 0);
      else WriteCatmullRomPath(spline, data);
    } else WriteLinearPath(spline, data);
  }

  /** @ac game/Movement/Spline/MovementPacketBuilder.cpp PacketBuilder::WriteCreate */
  static writeCreate(move_spline: MoveSpline, data: ByteWriter): void {
    //WriteClientStatus(mov, data);
    //data.append<float>(&mov.m_float_values[SpeedWalk], SpeedMaxCount);
    //if (mov.SplineEnabled())
    {
      const splineFlags = move_spline.splineflags;

      data.writeU32(splineFlags.raw());

      if (splineFlags.final_angle) {
        data.writeF32(move_spline.facing.angle);
      } else if (splineFlags.final_target) {
        data.writeU64(move_spline.facing.target);
      } else if (splineFlags.final_point) {
        data.writeF32(move_spline.facing.f.x).writeF32(move_spline.facing.f.y).writeF32(move_spline.facing.f.z);
      }

      data.writeU32(move_spline.timePassed() >>> 0);
      data.writeU32(move_spline.duration() >>> 0);
      data.writeU32(move_spline.getId());

      data.writeF32(1.0); // splineInfo.duration_mod; added in 3.1
      data.writeF32(1.0); // splineInfo.duration_mod_next; added in 3.1

      data.writeF32(move_spline.vertical_acceleration); // added in 3.1
      data.writeU32(move_spline.effect_start_time >>> 0); // added in 3.1

      const nodes = move_spline.getPath().length;
      data.writeU32(nodes);
      if (nodes) {
        appendVector3(data, move_spline.getPath(), 0, nodes);
      }
      data.writeU8(move_spline.spline.mode()); // added in 3.1
      if (move_spline.isCyclic()) data.writeF32(0).writeF32(0).writeF32(0);
      else writeVector3(data, move_spline.finalDestination());
    }
  }
}
