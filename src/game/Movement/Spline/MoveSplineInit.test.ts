import { describe, expect, test } from "bun:test";
import { Vector3 } from "../../../math/Vector3.ts";
import { ByteWriter } from "../../../net/byte-buffer.ts";
import { SMSG_MONSTER_MOVE } from "../../../combat/constants.ts";
import {
  MOVE_FLIGHT,
  MOVE_FLIGHT_BACK,
  MOVE_RUN,
  MOVE_RUN_BACK,
  MOVE_SWIM,
  MOVE_SWIM_BACK,
  MOVE_WALK,
  MOVEMENTFLAG_BACKWARD,
  MOVEMENTFLAG_CAN_FLY,
  MOVEMENTFLAG_FLYING,
  MOVEMENTFLAG_FORWARD,
  MOVEMENTFLAG_ONTRANSPORT,
  MOVEMENTFLAG_ROOT,
  MOVEMENTFLAG_SPLINE_ENABLED,
  MOVEMENTFLAG_SWIMMING,
  MOVEMENTFLAG_WALKING,
} from "../../Entities/Unit/UnitDefines.ts";
import { MoveSplineFlag } from "./MoveSplineFlag.ts";
import { MoveSplineInit, SelectSpeedType, SMSG_MONSTER_MOVE_TRANSPORT, TransportPathTransform, HoverMovementTransform } from "./MoveSplineInit.ts";
import { f32hex, fakeMoveUnit, hex, u32hex, v } from "./test-move-unit.ts";

const F = Math.fround;
const ID = 0x0a0b0c0d;

/** `packed guid 1`, the zero byte, and the start position. */
const head = (x: number, y: number, z: number) => `0101` + `00` + f32hex(x) + f32hex(y) + f32hex(z) + u32hex(ID);

describe("MoveSplineInit::Launch: SMSG_MONSTER_MOVE bytes (3.3.5a)", () => {
  test("a linear walk A to B", () => {
    const unit = fakeMoveUnit({ pos: [1, 2, 3] });
    const init = new MoveSplineInit(unit);
    init.args.splineId = ID;
    init.moveTo(v(11, 2, 3));
    // velocity 7: 1 + int(10 * (1000 / 7)) = 1429 ms
    expect(init.launch()).toBe(1429);

    expect(unit.sent.length).toBe(1);
    expect(unit.sent[0]!.opcode).toBe(SMSG_MONSTER_MOVE);
    expect(hex(unit.sent[0]!.payload)).toBe(
      head(1, 2, 3) + `00` + u32hex(0) + u32hex(1429) + u32hex(1) + f32hex(11) + f32hex(2) + f32hex(3),
    );

    // the unit now moves: forward + spline enabled, the spline runs
    expect(unit.flags).toBe((MOVEMENTFLAG_FORWARD | MOVEMENTFLAG_SPLINE_ENABLED) >>> 0);
    expect(unit.movespline.initialized()).toBe(true);
    expect(unit.movespline.duration()).toBe(1429);
    expect(unit.movespline.getId()).toBe(ID);
    expect(unit.movespline.velocity()).toBe(7);
  });

  test("a one segment move with a final angle is the exact SMSG_MONSTER_MOVE bytes of the 3.3.5a client layout", () => {
    const unit = fakeMoveUnit({ pos: [1, 2, 3] });
    const init = new MoveSplineInit(unit);
    init.args.splineId = ID;
    init.moveTo(v(11, 2, 3));
    init.setFacing(1.5);
    init.launch();
    // packed guid, 0, start x y z, spline id, facing angle (4), spline flags, duration, one point, the destination
    const expected = new ByteWriter()
      .writeBytes(Uint8Array.from([0x01, 0x01]))
      .writeU8(0)
      .writeF32(1)
      .writeF32(2)
      .writeF32(3)
      .writeU32(ID)
      .writeU8(4)
      .writeF32(1.5)
      .writeU32(0)
      .writeU32(1429)
      .writeU32(1)
      .writeF32(11)
      .writeF32(2)
      .writeF32(3)
      .toUint8Array();
    expect(hex(unit.sent[0]!.payload)).toBe(hex(expected));
  });

  test("final facing angle, target and spot (the facing flags are not sent as flags)", () => {
    for (const [name, setup, facing] of [
      ["angle", (i: MoveSplineInit) => i.setFacing(1.5), `04` + f32hex(1.5)],
      ["target", (i: MoveSplineInit) => i.setFacing({ getGUID: () => 0x0123456789abcdefn }), `03` + `efcdab8967452301`],
      ["spot", (i: MoveSplineInit) => i.setFacing(v(5, 6, 7)), `02` + f32hex(5) + f32hex(6) + f32hex(7)],
    ] as const) {
      const unit = fakeMoveUnit({ pos: [1, 2, 3] });
      const init = new MoveSplineInit(unit);
      init.args.splineId = ID;
      init.moveTo(v(11, 2, 3));
      setup(init);
      init.launch();
      expect(hex(unit.sent[0]!.payload)).toBe(
        `0101` + `00` + f32hex(1) + f32hex(2) + f32hex(3) + u32hex(ID) + facing + u32hex(0) + u32hex(1429) + u32hex(1) + f32hex(11) + f32hex(2) + f32hex(3),
      );
      expect(name).toBeTruthy();
    }
  });

  test("a linear path with 4 points packs the middle vertices as offsets from the middle", () => {
    const unit = fakeMoveUnit({ pos: [0, 0, 0] });
    const init = new MoveSplineInit(unit);
    init.args.splineId = ID;
    init.movebyPath([v(0, 0, 0), v(4, 8, 1), v(20, 0, 0), v(40, 0, 0)]);
    const duration = init.launch();

    // middle = (first + last) / 2 = (20, 0, 0); offset = middle - point: (16, -8, -1) and (0, 0, 0)
    const packed1 = (64 | (2016 << 11) | (1020 << 22)) >>> 0;
    expect(hex(unit.sent[0]!.payload)).toBe(
      head(0, 0, 0) + `00` + u32hex(0) + u32hex(duration) + u32hex(3) + f32hex(40) + f32hex(0) + f32hex(0) + u32hex(packed1) + u32hex(0),
    );
  });

  test("a smooth (Catmull-Rom) path sends every point after the first and the Catmullrom flag", () => {
    const unit = fakeMoveUnit({ pos: [0, 0, 0] });
    const init = new MoveSplineInit(unit);
    init.args.splineId = ID;
    init.movebyPath([v(0, 0, 0), v(10, 0, 0), v(20, 5, 0)]);
    init.setSmooth();
    const duration = init.launch();
    expect(hex(unit.sent[0]!.payload)).toBe(
      head(0, 0, 0) + `00` + u32hex(MoveSplineFlag.Catmullrom) + u32hex(duration) + u32hex(2) + f32hex(10) + f32hex(0) + f32hex(0) + f32hex(20) + f32hex(5) + f32hex(0),
    );
    expect(unit.movespline.spline.mode()).toBe(1);
  });

  test("a cyclic flying path adds the Enter_Cycle flag and the fake first point", () => {
    const unit = fakeMoveUnit({ pos: [0, 0, 0] });
    const init = new MoveSplineInit(unit);
    init.args.splineId = ID;
    init.movebyPath([v(0, 0, 0), v(10, 0, 0), v(20, 5, 0)]);
    init.setFly();
    init.setCyclic();
    const duration = init.launch();
    const flags = MoveSplineFlag.Flying | MoveSplineFlag.Cyclic | MoveSplineFlag.Enter_Cycle;
    // count + 1 = 4: the fake point is the first control, then the three controls from index 2 of the 6 stored points
    expect(hex(unit.sent[0]!.payload)).toBe(
      head(0, 0, 0) + `00` + u32hex(flags) + u32hex(duration) + u32hex(4) +
        f32hex(0) + f32hex(0) + f32hex(0) + // points[1]
        f32hex(10) + f32hex(0) + f32hex(0) + // points[2]
        f32hex(20) + f32hex(5) + f32hex(0) + // points[3]
        f32hex(0) + f32hex(0) + f32hex(0), // points[4] = controls[cyclic_point]
    );
    // the unit's own movespline keeps the real flags (no Enter_Cycle)
    expect(unit.movespline.splineflags.enter_cycle).toBe(false);
  });

  test("a cyclic ground path ends with a zero fake point and has no Enter_Cycle", () => {
    const unit = fakeMoveUnit({ pos: [0, 0, 0] });
    const init = new MoveSplineInit(unit);
    init.args.splineId = ID;
    init.movebyPath([v(0, 0, 0), v(10, 0, 0), v(20, 5, 0)]);
    init.setSmooth();
    init.setCyclic();
    const duration = init.launch();
    expect(hex(unit.sent[0]!.payload)).toBe(
      head(0, 0, 0) + `00` + u32hex(MoveSplineFlag.Catmullrom | MoveSplineFlag.Cyclic) + u32hex(duration) + u32hex(4) +
        f32hex(10) + f32hex(0) + f32hex(0) +
        f32hex(20) + f32hex(5) + f32hex(0) +
        f32hex(0) + f32hex(0) + f32hex(0) + // points[4]
        f32hex(0) + f32hex(0) + f32hex(0), // Xinef fake point
    );
  });

  test("parabolic and animation extras follow the flags", () => {
    const parabolic = fakeMoveUnit({ pos: [0, 0, 0] });
    const p = new MoveSplineInit(parabolic);
    p.args.splineId = ID;
    p.moveTo(v(10, 0, 0));
    p.setParabolic(3, 0.5);
    p.launch();
    const ms = parabolic.movespline;
    expect(ms.effect_start_time).toBe(Math.trunc(ms.duration() * 0.5));
    expect(hex(parabolic.sent[0]!.payload)).toBe(
      head(0, 0, 0) + `00` + u32hex(MoveSplineFlag.Parabolic) + u32hex(ms.duration()) + f32hex(ms.vertical_acceleration) + u32hex(ms.effect_start_time) + u32hex(1) + f32hex(10) + f32hex(0) + f32hex(0),
    );

    const animated = fakeMoveUnit({ pos: [0, 0, 0] });
    const a = new MoveSplineInit(animated);
    a.args.splineId = ID;
    a.moveTo(v(10, 0, 0));
    a.setAnimation(3);
    a.launch();
    const am = animated.movespline;
    // flags word without the animation id (Mask_Animations is stripped), then `uint8 animId, int32 effect_start_time`
    expect(hex(animated.sent[0]!.payload)).toBe(
      head(0, 0, 0) + `00` + u32hex(MoveSplineFlag.Animation) + `03` + u32hex(0) + u32hex(am.duration()) + u32hex(1) + f32hex(10) + f32hex(0) + f32hex(0),
    );
  });

  test("on a transport: SMSG_MONSTER_MOVE_TRANSPORT with the packed transport guid and seat, offsets from the transport", () => {
    const transport = {
      calculatePassengerOffset: (pos: Vector3) => {
        pos.x -= 100;
      },
    };
    const unit = fakeMoveUnit({
      pos: [111, 0, 0],
      flags: MOVEMENTFLAG_ONTRANSPORT,
      transGuid: 0x00f1300000001234n,
      transSeat: 2,
      transPos: [3, 4, 5],
      directTransport: transport,
    });
    const init = new MoveSplineInit(unit);
    init.args.splineId = ID;
    expect(init.args.TransformForTransport).toBe(true);
    init.moveTo(v(113, 4, 5)); // transformed to the offset (13, 4, 5)
    const duration = init.launch();

    expect(unit.sent[0]!.opcode).toBe(SMSG_MONSTER_MOVE_TRANSPORT);
    expect(hex(unit.sent[0]!.payload)).toBe(
      `0101` + `63341230f1` + `02` + `00` + f32hex(3) + f32hex(4) + f32hex(5) + u32hex(ID) + `00` + u32hex(0) + u32hex(duration) + u32hex(1) + f32hex(13) + f32hex(4) + f32hex(5),
    );
    expect(unit.movespline.onTransport).toBe(true);
  });
});

describe("MoveSplineInit::Launch behavior", () => {
  test("returns 0 without sending for an empty path or invalid args", () => {
    const unit = fakeMoveUnit();
    expect(new MoveSplineInit(unit).launch()).toBe(0);

    const slow = new MoveSplineInit(unit);
    slow.moveTo(v(5, 0, 0));
    slow.setVelocity(0);
    expect(slow.launch()).toBe(0);
    expect(unit.sent.length).toBe(0);
    expect(unit.movespline.initialized()).toBe(false);
  });

  test("the speed comes from the movement flags and is limited like the client does", () => {
    const launched = (setup: (i: MoveSplineInit) => void, opts: Parameters<typeof fakeMoveUnit>[0] = {}) => {
      const unit = fakeMoveUnit(opts);
      const init = new MoveSplineInit(unit);
      init.moveTo(v(10, 0, 0));
      setup(init);
      init.launch();
      return unit.movespline.velocity();
    };
    expect(launched(() => {})).toBe(7); // run speed
    expect(launched((i) => i.setWalk(true))).toBe(2.5); // walk speed, without the walk flag on the unit
    expect(launched(() => {}, { flags: MOVEMENTFLAG_WALKING })).toBe(2.5); // the unit's walk flag is mixed in
    expect(launched((i) => i.setWalk(false), { flags: MOVEMENTFLAG_WALKING })).toBe(7);
    expect(launched((i) => i.setVelocity(100))).toBe(28); // max(28, run * 4)
    expect(launched((i) => i.setVelocity(100), { speeds: { [MOVE_RUN]: 10 } })).toBe(40);
    expect(launched((i) => i.setVelocity(100), { flags: MOVEMENTFLAG_CAN_FLY })).toBe(50); // flying
    expect(launched((i) => i.setVelocity(100), {})).toBe(28);
    expect(launched((i) => i.setVelocity(3))).toBe(3);
    expect(launched(() => {}, { flags: MOVEMENTFLAG_SWIMMING })).toBe(F(4.722222));
  });

  test("a move to its own position is orientation only: no moving flags stay", () => {
    const unit = fakeMoveUnit({ pos: [5, 5, 5] });
    const init = new MoveSplineInit(unit);
    init.moveTo(v(5, 5, 5));
    init.launch();
    expect(unit.flags).toBe(MOVEMENTFLAG_SPLINE_ENABLED);
  });

  test("a rooted unit loses its moving flags", () => {
    const unit = fakeMoveUnit({ flags: MOVEMENTFLAG_ROOT | MOVEMENTFLAG_FORWARD });
    const init = new MoveSplineInit(unit);
    init.moveTo(v(5, 0, 0));
    init.launch();
    expect(unit.flags & MOVEMENTFLAG_ROOT).toBe(MOVEMENTFLAG_ROOT);
    expect(unit.flags & MOVEMENTFLAG_FORWARD).toBe(0);
  });

  test("an inversed orientation sets BACKWARD instead of FORWARD", () => {
    const unit = fakeMoveUnit({ flags: MOVEMENTFLAG_FORWARD });
    const init = new MoveSplineInit(unit);
    init.moveTo(v(5, 0, 0));
    init.setOrientationInversed();
    init.launch();
    expect(unit.flags & MOVEMENTFLAG_BACKWARD).toBe(MOVEMENTFLAG_BACKWARD);
    expect(unit.flags & MOVEMENTFLAG_FORWARD).toBe(0);
    expect(unit.movespline.splineflags.orientationInversed).toBe(true);
  });

  test("a second launch starts from the computed position of the running spline", () => {
    const unit = fakeMoveUnit({ pos: [0, 0, 0] });
    const first = new MoveSplineInit(unit);
    first.moveTo(v(10, 0, 0));
    first.launch();
    unit.movespline.updateState(714);
    const second = new MoveSplineInit(unit);
    second.moveTo(v(0, 10, 0));
    second.args.splineId = ID;
    second.launch();
    const x = unit.movespline.getPath()[1]!.x; // the corrected first vertex
    expect(x).toBeCloseTo((714 / 1429) * 10, 2);
    expect(unit.sent.length).toBe(2);
    expect(unit.movespline.getId()).toBe(ID);
  });

  test("the constructor mixes in the unit's state", () => {
    const flying = new MoveSplineInit(fakeMoveUnit({ flags: MOVEMENTFLAG_CAN_FLY }));
    expect(flying.args.flags.flying).toBe(true);
    const walking = new MoveSplineInit(fakeMoveUnit({ flags: MOVEMENTFLAG_WALKING }));
    expect(walking.args.walk).toBe(true);
    const a = new MoveSplineInit(fakeMoveUnit());
    const b = new MoveSplineInit(fakeMoveUnit());
    expect(b.args.splineId).toBe(a.args.splineId + 1);
  });

  test("MoveTo with generatePath builds the path with PathGenerator (no mmaps: a two point shortcut)", () => {
    const unit = fakeMoveUnit({ pos: [0, 0, 0] });
    const init = new MoveSplineInit(unit);
    init.moveTo(v(0, 0, 0), v(30, 0, 0)); // start, destination, generatePath defaults to true
    expect(init.path().length).toBe(2);
    expect(init.path()[1]).toEqual(v(30, 0, 0));
    const xyz = new MoveSplineInit(unit);
    xyz.moveTo(7, 8, 9);
    expect(xyz.path()[1]).toEqual(v(7, 8, 9));
    expect(xyz.args.path_Idx_offset).toBe(0);
    const gen = new MoveSplineInit(unit);
    gen.moveTo(v(30, 0, 0), true);
    expect(gen.path().length).toBe(2);
  });
});

describe("MoveSplineInit::Stop", () => {
  test("a running spline stops at its computed position: bytes and state", () => {
    const unit = fakeMoveUnit({ pos: [1, 2, 3] });
    const init = new MoveSplineInit(unit);
    init.moveTo(v(11, 2, 3));
    init.launch();
    unit.movespline.updateState(500);

    const stop = new MoveSplineInit(unit);
    stop.args.splineId = ID;
    stop.stop();
    const at = F(1 + F(F(500 / 1429) * 10));
    expect(unit.sent.length).toBe(2);
    expect(unit.sent[1]!.opcode).toBe(SMSG_MONSTER_MOVE);
    const bytes = hex(unit.sent[1]!.payload);
    expect(bytes.slice(0, 6)).toBe("010100");
    expect(bytes.length).toBe(2 + 2 + 2 + 12 * 2 + 8 + 2);
    expect(bytes.slice(-10)).toBe(u32hex(ID) + "01");
    const x = new DataView(Uint8Array.from(bytes.slice(6, 14).match(/../g)!, (h) => parseInt(h, 16)).buffer).getFloat32(0, true);
    expect(x).toBeCloseTo(at, 3);

    expect(unit.flags & (MOVEMENTFLAG_FORWARD | MOVEMENTFLAG_SPLINE_ENABLED)).toBe(0);
    expect(unit.movespline.finalized()).toBe(true);
    expect(unit.movespline.initialized()).toBe(false);
  });

  test("exact stop bytes at the start", () => {
    const unit = fakeMoveUnit({ pos: [1, 2, 3] });
    const init = new MoveSplineInit(unit);
    init.moveTo(v(11, 2, 3));
    init.launch();
    const stop = new MoveSplineInit(unit);
    stop.args.splineId = ID;
    stop.stop();
    expect(hex(unit.sent[1]!.payload)).toBe(`0101` + `00` + f32hex(1) + f32hex(2) + f32hex(3) + u32hex(ID) + `01`);
  });

  test("nothing is sent when the unit is not moving", () => {
    const unit = fakeMoveUnit();
    new MoveSplineInit(unit).stop();
    expect(unit.sent.length).toBe(0);
  });
});

describe("MoveSplineInit setters", () => {
  test("flags", () => {
    const init = new MoveSplineInit(fakeMoveUnit());
    init.setFall();
    expect(init.args.flags.falling).toBe(true);
    init.setFly();
    expect(init.args.flags.flying).toBe(true);
    expect(init.args.flags.falling).toBe(false);
    init.setSmooth();
    expect(init.args.flags.catmullrom).toBe(true);
    expect(init.args.flags.flying).toBe(false);
    init.setCyclic();
    init.setOrientationFixed(true);
    init.setTransportEnter();
    init.setTransportExit();
    expect(init.args.flags.cyclic && init.args.flags.orientationFixed).toBe(true);
    expect(init.args.flags.transportExit && !init.args.flags.transportEnter).toBe(true);
    init.setOrientationFixed(false);
    expect(init.args.flags.orientationFixed).toBe(false);
    init.setFirstPointId(5);
    expect(init.args.path_Idx_offset).toBe(5);
    init.disableTransportPathTransformations();
    expect(init.args.TransformForTransport).toBe(false);
    init.setVelocity(2.5);
    expect(init.args.HasVelocity).toBe(true);
    expect(init.args.velocity).toBe(2.5);
    init.setParabolic(2, 0.25);
    expect(init.args.flags.parabolic).toBe(true);
    expect(init.args.time_perc).toBe(0.25);
    init.setAnimation(4);
    expect(init.args.flags.animation).toBe(true);
    expect(init.args.flags.parabolic).toBe(false);
    expect(init.args.flags.animId).toBe(4);
    expect(init.args.time_perc).toBe(0);
  });

  test("SetFacing(angle) wraps to [0, 2pi) and subtracts the vehicle or transport orientation on transports", () => {
    const wrapped = (angle: number, opts: Parameters<typeof fakeMoveUnit>[0] = {}) => {
      const init = new MoveSplineInit(fakeMoveUnit(opts));
      init.setFacing(angle);
      expect(init.args.flags.final_angle).toBe(true);
      return init.args.facing.angle;
    };
    expect(wrapped(1)).toBe(1);
    expect(wrapped(-1)).toBeCloseTo(2 * Math.PI - 1, 5);
    expect(wrapped(7)).toBeCloseTo(7 - 2 * Math.PI, 5);
    const onTransport = { flags: MOVEMENTFLAG_ONTRANSPORT, transGuid: 5n };
    expect(wrapped(3, { ...onTransport, vehicleOrientation: 1 })).toBe(2);
    expect(wrapped(3, { ...onTransport, transportOrientation: 0.5 })).toBe(2.5);
    expect(wrapped(3, { vehicleOrientation: 1 })).toBe(3); // not on a transport: no transformation
  });

  test("SetFacing(point) and SetFacing(unit)", () => {
    const init = new MoveSplineInit(fakeMoveUnit());
    init.setFacing(v(1, 2, 3));
    expect(init.args.flags.final_point).toBe(true);
    expect(init.args.facing.f).toEqual({ x: 1, y: 2, z: 3 });
    init.setFacing({ getGUID: () => 99n });
    expect(init.args.flags.final_target).toBe(true);
    expect(init.args.flags.final_point).toBe(false);
    expect(init.args.facing.target).toBe(99n);
  });

  test("TransportPathTransform and HoverMovementTransform return copies", () => {
    const calls: Vector3[] = [];
    const unit = fakeMoveUnit({
      directTransport: {
        calculatePassengerOffset: (p) => {
          calls.push(p);
          p.x += 1;
        },
      },
    });
    const input = v(1, 2, 3);
    expect(new TransportPathTransform(unit, true).call(input)).toEqual(v(2, 2, 3));
    expect(input).toEqual(v(1, 2, 3));
    expect(new TransportPathTransform(unit, false).call(input)).toEqual(v(1, 2, 3));
    expect(calls.length).toBe(1);
    expect(new HoverMovementTransform(2).call(input)).toEqual(v(1, 2, 5));
  });

  test("SelectSpeedType follows MovementInfo::GetSpeedType", () => {
    expect(SelectSpeedType(0)).toBe(MOVE_RUN);
    expect(SelectSpeedType(MOVEMENTFLAG_WALKING)).toBe(MOVE_WALK);
    expect(SelectSpeedType(MOVEMENTFLAG_BACKWARD)).toBe(MOVE_RUN_BACK);
    expect(SelectSpeedType(MOVEMENTFLAG_SWIMMING)).toBe(MOVE_SWIM);
    expect(SelectSpeedType(MOVEMENTFLAG_SWIMMING | MOVEMENTFLAG_BACKWARD)).toBe(MOVE_SWIM_BACK);
    expect(SelectSpeedType(MOVEMENTFLAG_FLYING)).toBe(MOVE_FLIGHT);
    expect(SelectSpeedType(MOVEMENTFLAG_FLYING | MOVEMENTFLAG_BACKWARD | MOVEMENTFLAG_SWIMMING)).toBe(MOVE_FLIGHT_BACK);
    expect(SelectSpeedType(MOVEMENTFLAG_WALKING | MOVEMENTFLAG_BACKWARD)).toBe(MOVE_WALK);
  });
});
