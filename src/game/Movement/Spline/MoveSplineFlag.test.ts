import { describe, expect, test } from "bun:test";
import { MoveSplineFlag } from "./MoveSplineFlag.ts";
import { computeFallElevation, computeFallTime, g_SplineFlag_names, gravity, splineIdGen, terminalVelocity } from "./MovementUtil.ts";
import { counter, MSToSec, SecToMS, UInt32Counter } from "./MovementTypedefs.ts";

describe("MoveSplineFlag", () => {
  test("bit fields read and write the raw word", () => {
    const f = new MoveSplineFlag();
    expect(f.raw()).toBe(0);
    f.done = true;
    f.cyclic = true;
    f.unknown13 = true;
    expect(f.raw()).toBe((0x100 | 0x80000 | 0x80000000) >>> 0);
    expect(f.done && f.cyclic && f.unknown13).toBe(true);
    f.done = false;
    expect(f.raw()).toBe((0x80000 | 0x80000000) >>> 0);
    f.animId = 0x1ff; // only the low byte
    expect(f.animId).toBe(0xff);
    expect(f.raw() & 0xff).toBe(0xff);
    expect(f.getAnimationId()).toBe(0xff);
  });

  test("masks", () => {
    expect(MoveSplineFlag.Mask_Final_Facing).toBe(0x00038000);
    expect(MoveSplineFlag.Mask_Animations).toBe(0xff);
    expect(MoveSplineFlag.Mask_No_Monster_Move).toBe(0x000381ff);
    expect(MoveSplineFlag.Mask_CatmullRom).toBe(0x00042000);
    expect(MoveSplineFlag.Mask_Unused).toBe(((0x400 | 0x100000 | 0x400000 | 0x02000000 | 0x04000000) | 0x10000000 | 0x20000000 | 0x40000000 | 0x80000000) >>> 0);
  });

  test("smooth / linear / facing queries and hasFlag / hasAllFlags", () => {
    const f = new MoveSplineFlag();
    expect(f.isLinear()).toBe(true);
    f.flying = true;
    expect(f.isSmooth()).toBe(true);
    f.flying = false;
    f.catmullrom = true;
    expect(f.isSmooth()).toBe(true);
    expect(f.isFacing()).toBe(false);
    f.final_target = true;
    expect(f.isFacing()).toBe(true);
    expect(f.hasFlag(MoveSplineFlag.Final_Target | MoveSplineFlag.Done)).toBe(true);
    expect(f.hasAllFlags(MoveSplineFlag.Final_Target | MoveSplineFlag.Done)).toBe(false);
    expect(f.and(MoveSplineFlag.Mask_Final_Facing)).toBe(MoveSplineFlag.Final_Target);
    expect(f.or(MoveSplineFlag.Done)).toBe(MoveSplineFlag.Final_Target | MoveSplineFlag.Catmullrom | MoveSplineFlag.Done);
    f.andAssign(~MoveSplineFlag.Catmullrom);
    f.orAssign(MoveSplineFlag.Done);
    expect(f.raw()).toBe(MoveSplineFlag.Final_Target | MoveSplineFlag.Done);
  });

  test("Enable* helpers exclude their opposites", () => {
    const f = new MoveSplineFlag(MoveSplineFlag.Falling | MoveSplineFlag.Parabolic | MoveSplineFlag.Animation | 0x07);
    f.enableAnimation(2);
    expect(f.raw()).toBe(MoveSplineFlag.Animation | 2);

    f.enableParabolic();
    expect(f.raw()).toBe(MoveSplineFlag.Parabolic);

    f.enableFalling();
    expect(f.raw()).toBe(MoveSplineFlag.Falling);

    const g = new MoveSplineFlag(MoveSplineFlag.Falling | MoveSplineFlag.Catmullrom);
    g.enableFlying();
    expect(g.raw()).toBe(MoveSplineFlag.Flying);
    g.enableCatmullRom();
    expect(g.raw()).toBe(MoveSplineFlag.Catmullrom);

    const h = new MoveSplineFlag(MoveSplineFlag.Final_Angle | MoveSplineFlag.Final_Target);
    h.enableFacingPoint();
    expect(h.raw()).toBe(MoveSplineFlag.Final_Point);
    h.enableFacingAngle();
    expect(h.raw()).toBe(MoveSplineFlag.Final_Angle);
    h.enableFacingTarget();
    expect(h.raw()).toBe(MoveSplineFlag.Final_Target);

    const t = new MoveSplineFlag(MoveSplineFlag.TransportExit);
    t.enableTransportEnter();
    expect(t.raw()).toBe(MoveSplineFlag.TransportEnter);
    t.enableTransportExit();
    expect(t.raw()).toBe(MoveSplineFlag.TransportExit);
  });

  test("clone / assign copy the word", () => {
    const f = new MoveSplineFlag(MoveSplineFlag.Cyclic);
    const g = f.clone();
    f.done = true;
    expect(g.raw()).toBe(MoveSplineFlag.Cyclic);
    g.assign(f);
    expect(g.raw()).toBe(f.raw());
  });

  test("ToString lists the set flags by name", () => {
    expect(new MoveSplineFlag(MoveSplineFlag.Done | MoveSplineFlag.Cyclic | MoveSplineFlag.OrientationInversed).toString()).toBe(" Done Cyclic OrientationInversed");
    expect(new MoveSplineFlag(0x81).toString()).toBe(" AnimBit1 AnimBit8");
    expect(g_SplineFlag_names.length).toBe(32);
  });
});

describe("MovementTypedefs / MovementUtil", () => {
  test("SecToMS truncates a float product, MSToSec is a float division", () => {
    expect(SecToMS(2.2769)).toBe(2276);
    expect(SecToMS(0.0009)).toBe(0);
    expect(SecToMS(NaN)).toBe(0);
    expect(MSToSec(1500)).toBe(1.5);
    expect(MSToSec(1)).toBe(Math.fround(0.001));
  });

  test("counter restarts at its limit; splineIdGen is a uint32 counter", () => {
    const c = new counter(2);
    expect([c.newId(), c.newId(), c.newId(), c.newId()]).toEqual([1, 2, 0, 1]);
    expect(c.getCurrent()).toBe(1);
    const u = new UInt32Counter();
    expect(u.newId()).toBe(1);
    const before = splineIdGen.getCurrent();
    expect(splineIdGen.newId()).toBe(before + 1);
  });

  test("computeFallTime: below and above terminal length, safe fall and negative lengths", () => {
    expect(computeFallTime(-1, false)).toBe(0);
    expect(computeFallTime(0, false)).toBe(0);
    expect(computeFallTime(50, false)).toBe(Math.fround(Math.sqrt((2 * 50) / gravity)));
    // terminal length is v^2 / (2 g) = 93.76: past it the speed is constant
    const tl = (terminalVelocity * terminalVelocity) / (2 * gravity);
    expect(computeFallTime(tl + 60, false)).toBeCloseTo(terminalVelocity / gravity + 60 / terminalVelocity, 4);
    expect(computeFallTime(100, true)).toBeCloseTo((100 - 49 / (2 * gravity)) / 7 + 7 / gravity, 4);
    expect(computeFallTime(1, true)).toBeCloseTo(Math.sqrt(2 / gravity), 5);
  });

  test("computeFallElevation: free fall, terminal velocity, start velocity", () => {
    expect(computeFallElevation(1, false)).toBe(Math.fround(0.5 * gravity));
    const tt = terminalVelocity / gravity;
    expect(computeFallElevation(tt + 2, false)).toBeCloseTo(terminalVelocity * 2 + 0.5 * gravity * tt * tt, 3);
    // a start velocity above the terminal one is capped
    expect(computeFallElevation(1, false, 1000)).toBeCloseTo(computeFallElevation(1, false, terminalVelocity), 3);
    // jump: negative start velocity goes up first
    expect(computeFallElevation(0.5, false, -10)).toBeCloseTo(-10 * 0.5 + 0.5 * gravity * 0.25, 4);
    expect(computeFallElevation(5, true)).toBeCloseTo(7 * (5 - 7 / gravity) + 0.5 * gravity * (7 / gravity) ** 2, 3);
  });
});
