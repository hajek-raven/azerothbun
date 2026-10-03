import { describe, expect, test } from "bun:test";
import { ByteWriter } from "../../../net/byte-buffer.ts";
import { MoveSpline } from "./MoveSpline.ts";
import { MoveSplineFlag } from "./MoveSplineFlag.ts";
import { MoveSplineInitArgs } from "./MoveSplineInitArgs.ts";
import { appendPackXYZ, MonsterMoveType, PacketBuilder } from "./MovementPacketBuilder.ts";
import { f32hex, hex, u32hex, v } from "./test-move-unit.ts";

function spline(setup: (a: MoveSplineInitArgs) => void = () => {}): MoveSpline {
  const a = new MoveSplineInitArgs();
  a.path = [v(1, 2, 3), v(11, 2, 3)];
  a.velocity = 7;
  a.splineId = 0x01020304;
  setup(a);
  const m = new MoveSpline();
  m.initialize(a);
  return m;
}

describe("PacketBuilder", () => {
  test("MonsterMoveType values", () => {
    expect(MonsterMoveType).toEqual({ MonsterMoveNormal: 0, MonsterMoveStop: 1, MonsterMoveFacingSpot: 2, MonsterMoveFacingTarget: 3, MonsterMoveFacingAngle: 4 });
  });

  test("appendPackXYZ packs 11/11/10 bit offsets in quarter yards", () => {
    const w = new ByteWriter();
    appendPackXYZ(w, 16, -8, -1);
    appendPackXYZ(w, 0.2, 0.3, 255.75);
    appendPackXYZ(w, 600, 0, 0); // 2400 & 0x7ff = 352
    const b = hex(w.toUint8Array());
    expect(b).toBe(u32hex((64 | (2016 << 11) | (1020 << 22)) >>> 0) + u32hex((0 | (1 << 11) | (1023 << 22)) >>> 0) + u32hex(2400 & 0x7ff));
  });

  test("WriteMonsterMove: the common part and a linear path", () => {
    const w = new ByteWriter();
    PacketBuilder.writeMonsterMove(spline(), w);
    expect(hex(w.toUint8Array())).toBe(
      `00` + f32hex(1) + f32hex(2) + f32hex(3) + u32hex(0x01020304) + `00` + u32hex(0) + u32hex(1429) + u32hex(1) + f32hex(11) + f32hex(2) + f32hex(3),
    );
  });

  test("WriteMonsterMove: Mask_No_Monster_Move bits are removed from the flags", () => {
    const w = new ByteWriter();
    const m = spline((a) => {
      a.flags.setRaw(MoveSplineFlag.CanSwim | MoveSplineFlag.OrientationFixed | MoveSplineFlag.Final_Angle);
      a.facing.angle = 0.5;
    });
    PacketBuilder.writeMonsterMove(m, w);
    expect(hex(w.toUint8Array())).toBe(
      `00` + f32hex(1) + f32hex(2) + f32hex(3) + u32hex(0x01020304) + `04` + f32hex(0.5) + u32hex(MoveSplineFlag.CanSwim | MoveSplineFlag.OrientationFixed) + u32hex(1429) + u32hex(1) + f32hex(11) + f32hex(2) + f32hex(3),
    );
  });

  test("two facing flags at once fall back to MonsterMoveNormal like the C++ switch", () => {
    const w = new ByteWriter();
    PacketBuilder.writeMonsterMove(spline((a) => a.flags.setRaw(MoveSplineFlag.Final_Angle | MoveSplineFlag.Final_Point)), w);
    expect(hex(w.toUint8Array()).slice(2 + 24 + 8, 2 + 24 + 8 + 2)).toBe("00");
  });

  test("WriteStopMovement", () => {
    const w = new ByteWriter();
    PacketBuilder.writeStopMovement(v(1, 2, 3), 0x0a0b0c0d, w);
    expect(hex(w.toUint8Array())).toBe(`00` + f32hex(1) + f32hex(2) + f32hex(3) + u32hex(0x0a0b0c0d) + `01`);
  });

  test("WriteCreate: the spline block of a create update", () => {
    const m = spline((a) => a.flags.enableFacingPoint());
    m.facing.f = { x: 4, y: 5, z: 6 };
    m.updateState(100);
    const w = new ByteWriter();
    PacketBuilder.writeCreate(m, w);
    expect(hex(w.toUint8Array())).toBe(
      u32hex(MoveSplineFlag.Final_Point) + f32hex(4) + f32hex(5) + f32hex(6) +
        u32hex(100) + u32hex(1429) + u32hex(0x01020304) + f32hex(1) + f32hex(1) + f32hex(0) + u32hex(0) +
        u32hex(4) + f32hex(-9) + f32hex(2) + f32hex(3) + f32hex(1) + f32hex(2) + f32hex(3) + f32hex(11) + f32hex(2) + f32hex(3) + f32hex(11) + f32hex(2) + f32hex(3) +
        `00` + f32hex(11) + f32hex(2) + f32hex(3),
    );
  });

  test("WriteCreate of a cyclic spline ends with a zero destination, a target facing writes the guid", () => {
    const m = spline((a) => {
      a.flags.cyclic = true;
      a.flags.enableFacingTarget();
      a.facing.target = 0x1122334455667788n;
    });
    const w = new ByteWriter();
    PacketBuilder.writeCreate(m, w);
    const b = hex(w.toUint8Array());
    expect(b.slice(8, 8 + 16)).toBe("8877665544332211");
    expect(b.slice(-26)).toBe(`00` + f32hex(0) + f32hex(0) + f32hex(0));
  });
});
