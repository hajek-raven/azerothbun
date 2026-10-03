import { describe, expect, test } from "bun:test";
import { Vector3 } from "../../../math/Vector3.ts";
import { MoveSpline } from "./MoveSpline.ts";
import { MoveSplineFlag } from "./MoveSplineFlag.ts";
import { MoveSplineInitArgs } from "./MoveSplineInitArgs.ts";
import { computeFallElevation, computeFallTime, gravity } from "./MovementUtil.ts";
import { v } from "./test-move-unit.ts";

const F = Math.fround;

function args(path: Vector3[], velocity: number, setup: (a: MoveSplineInitArgs) => void = () => {}): MoveSplineInitArgs {
  const a = new MoveSplineInitArgs();
  a.path = path;
  a.velocity = F(velocity);
  a.splineId = 5;
  setup(a);
  return a;
}

describe("MoveSpline::Initialize", () => {
  test("a new MoveSpline is a finished, uninitialized spline", () => {
    const m = new MoveSpline();
    expect(m.finalized()).toBe(true);
    expect(m.initialized()).toBe(false);
    expect(m.duration).toBeDefined();
    expect(m.hasStarted()).toBe(false);
    expect(m.onTransport).toBe(false);
  });

  test("linear path: timestamps are 1 + int(length * 1000 / velocity) per segment", () => {
    const m = new MoveSpline();
    m.initialize(args([v(0, 0, 0), v(10, 0, 0), v(10, 20, 0)], 5));
    // velocityInv = 1000 / 5 = 200: 1 + 2000, then + 4000
    expect(m._Spline().length(m._Spline().first())).toBe(0);
    expect(m._Spline().length(m._Spline().first() + 1)).toBe(2001);
    expect(m.duration()).toBe(6001);
    expect(m.getId()).toBe(5);
    expect(m.initialized()).toBe(true);
    expect(m.finalized()).toBe(false);
    expect(m.velocity()).toBe(5);
    expect(m.finalDestination()).toEqual(v(10, 20, 0));
    expect(m.currentDestination()).toEqual(v(10, 0, 0));
    expect(m.maxPathIdx()).toBe(2); // three path points: indexes 0..2
  });

  test("truncates the float sum per segment like the C++ int32 += float", () => {
    const m = new MoveSpline();
    // 1000 / 7 = 142.857..., the time starts at 1 and a 1 yard segment adds 142.857 to the int each time (1 -> 143 -> 285)
    m.initialize(args([v(0, 0, 0), v(1, 0, 0), v(2, 0, 0)], 7));
    expect(m._Spline().length(1)).toBe(0);
    expect(m._Spline().length(2)).toBe(143);
    expect(m.duration()).toBe(285);
  });

  test("a stop spline (Done flag) clears the spline", () => {
    const m = new MoveSpline();
    m.initialize(args([v(0, 0, 0), v(10, 0, 0)], 5));
    m.initialize(args([], 0, (a) => (a.flags = new MoveSplineFlag(MoveSplineFlag.Done))));
    expect(m.initialized()).toBe(false);
    expect(m.finalized()).toBe(true);
  });

  test("all points on the same coordinates: minimal duration 1 (cyclic 1000)", () => {
    const open = new MoveSpline();
    open.initialize(args([v(1, 1, 1), v(1, 1, 1)], 5));
    expect(open.duration()).toBe(1);
    const cyc = new MoveSpline();
    cyc.initialize(args([v(1, 1, 1), v(1, 1, 1)], 5, (a) => a.flags.setRaw(MoveSplineFlag.Cyclic)));
    // the cyclic spline has two segments: lengths 1, 1 (min duration check is on the total)
    expect(cyc._Spline().isCyclic()).toBe(true);
    expect(cyc.duration()).toBeGreaterThanOrEqual(1);
  });

  test("falling: timestamps come from the fall time of the height difference", () => {
    const m = new MoveSpline();
    m.initialize(args([v(0, 0, 100), v(0, 0, 50)], 7, (a) => a.flags.enableFalling()));
    expect(m.duration()).toBe(Math.trunc(F(computeFallTime(50, false) * 1000)));
    expect(m.duration()).toBe(2276);
    expect(m.isFalling()).toBe(true);
  });

  test("parabolic: effect start time and vertical acceleration", () => {
    const m = new MoveSpline();
    m.initialize(args([v(0, 0, 0), v(10, 0, 0)], 5, (a) => {
      a.flags.enableParabolic();
      a.time_perc = 0.25;
      a.parabolic_amplitude = 3;
    }));
    const duration = m.duration(); // 2001
    expect(m.effect_start_time).toBe(Math.trunc(duration * 0.25));
    const fd = F((duration - m.effect_start_time) / 1000);
    expect(m.vertical_acceleration).toBe(F(F(3 * 8) / F(fd * fd)));
  });

  test("animation sets the effect start time only", () => {
    const m = new MoveSpline();
    m.initialize(args([v(0, 0, 0), v(10, 0, 0)], 5, (a) => {
      a.flags.enableAnimation(3);
      a.time_perc = 0.5;
    }));
    expect(m.hasAnimation()).toBe(true);
    expect(m.getAnimationType()).toBe(3);
    expect(m.effect_start_time).toBe(Math.trunc(m.duration() * 0.5));
    expect(m.vertical_acceleration).toBe(0);
  });
});

describe("MoveSpline::ComputePosition", () => {
  test("linear interpolation by time and orientation along the derivative", () => {
    const m = new MoveSpline();
    m.initialize(args([v(0, 0, 0), v(10, 0, 0), v(10, 20, 0)], 5));
    m.updateState(1001); // half of the first segment (1 + 1000 ms of 2001)
    const c = m.computePosition();
    expect(c.x).toBeCloseTo((1001 / 2001) * 10, 3);
    expect(c.y).toBe(0);
    expect(c.orientation).toBe(0);
    m.updateState(1000); // end of segment 1 -> segment 2 starts
    m.updateState(2000); // 2000 ms into the second segment of 4000 ms
    const d = m.computePosition();
    expect(d.x).toBe(10);
    expect(d.y).toBeCloseTo(10, 2);
    expect(d.orientation).toBeCloseTo(Math.PI / 2, 6);
  });

  test("a spline that never started is at its first point, facing along the first segment", () => {
    const m = new MoveSpline();
    m.initialize(args([v(1, 2, 3), v(1, 12, 3)], 5, (a) => (a.initialOrientation = 0.5)));
    const c = m.computePosition();
    expect([c.x, c.y, c.z]).toEqual([1, 2, 3]);
    expect(c.orientation).toBeCloseTo(Math.PI / 2, 6);
  });

  test("OrientationFixed keeps the initial orientation, OrientationInversed negates", () => {
    const fixed = new MoveSpline();
    fixed.initialize(args([v(0, 0, 0), v(0, 10, 0)], 5, (a) => {
      a.flags.orientationFixed = true;
      a.initialOrientation = 1.25;
    }));
    expect(fixed.computePosition().orientation).toBe(1.25);

    const inv = new MoveSpline();
    inv.initialize(args([v(0, 0, 0), v(0, 10, 0)], 5, (a) => (a.flags.orientationInversed = true)));
    expect(inv.computePosition().orientation).toBeCloseTo(-Math.PI / 2, 6);
  });

  test("final facing is applied once the spline is done", () => {
    const angle = new MoveSpline();
    angle.initialize(args([v(0, 0, 0), v(10, 0, 0)], 5, (a) => {
      a.flags.enableFacingAngle();
      a.facing.angle = 2;
    }));
    expect(angle.computePosition().orientation).toBeCloseTo(0, 6); // not done: moving along +x
    angle.updateState(100000);
    expect(angle.finalized()).toBe(true);
    expect(angle.computePosition().orientation).toBe(2);

    const point = new MoveSpline();
    point.initialize(args([v(0, 0, 0), v(10, 0, 0)], 5, (a) => {
      a.flags.enableFacingPoint();
      a.facing.f = { x: 10, y: 10, z: 0 };
    }));
    point.updateState(100000);
    expect(point.computePosition().orientation).toBeCloseTo(Math.PI / 2, 6);
  });

  test("falling elevation follows the fall formula and stops at the destination", () => {
    const m = new MoveSpline();
    m.initialize(args([v(0, 0, 100), v(0, 0, 50)], 7, (a) => a.flags.enableFalling()));
    m.updateState(1000);
    expect(m.computePosition().z).toBeCloseTo(100 - 0.5 * gravity, 3);
    expect(m.computePosition().z).toBe(F(100 - computeFallElevation(1, false)));
    m.updateState(5000);
    // the duration is the fall time truncated to ms, so the last z_now is a hair above the destination
    expect(m.computePosition().z).toBeGreaterThanOrEqual(50);
    expect(m.computePosition().z).toBeCloseTo(50, 1);
  });

  test("parabolic elevation reaches the amplitude in the middle of the effect", () => {
    const m = new MoveSpline();
    m.initialize(args([v(0, 0, 0), v(10, 0, 0)], 5, (a) => {
      a.flags.enableParabolic();
      a.time_perc = 0;
      a.parabolic_amplitude = 4;
    }));
    const dur = m.duration();
    m.updateState(Math.trunc(dur / 2));
    expect(m.computePosition().z).toBeCloseTo(4, 1);
    m.updateState(dur);
    expect(m.computePosition().z).toBeCloseTo(0, 3);
  });
});

describe("MoveSpline::updateState", () => {
  test("segments, then arrival: results, point index and finalization", () => {
    const m = new MoveSpline();
    m.initialize(args([v(0, 0, 0), v(10, 0, 0), v(10, 20, 0)], 5));
    const results: number[] = [];
    m.updateState(2000, (r) => results.push(r));
    expect(results).toEqual([MoveSpline.Result_None]);
    expect(m.timePassed()).toBe(2000);
    results.length = 0;
    m.updateState(1, (r) => results.push(r)); // reaches 2001 = end of the first segment
    expect(results).toEqual([MoveSpline.Result_NextSegment]);
    expect(m._currentSplineIdx()).toBe(2);
    expect(m.currentPathIdx()).toBe(1);
    results.length = 0;
    m.updateState(100000, (r) => results.push(r));
    expect(results).toEqual([MoveSpline.Result_Arrived | MoveSpline.Result_JustArrived]);
    expect(m.finalized()).toBe(true);
    expect(m.timePassed()).toBe(m.duration());
    expect(m.timeElapsed()).toBe(0);
    expect(m.currentPathIdx()).toBe(2); // finalized counts one more
  });

  test("one big step crosses several segments through the handler loop", () => {
    const m = new MoveSpline();
    m.initialize(args([v(0, 0, 0), v(10, 0, 0), v(10, 20, 0), v(0, 20, 0)], 5));
    const results: number[] = [];
    m.updateState(1_000_000, (r) => results.push(r));
    expect(results).toEqual([
      MoveSpline.Result_NextSegment,
      MoveSpline.Result_NextSegment,
      MoveSpline.Result_Arrived | MoveSpline.Result_JustArrived,
    ]);
  });

  test("a finalized spline answers Result_Arrived and zeroes the time", () => {
    const m = new MoveSpline();
    m.initialize(args([v(0, 0, 0), v(10, 0, 0)], 5));
    m._Interrupt();
    const diff = { value: 77 };
    expect(m._updateState(diff)).toBe(MoveSpline.Result_Arrived);
    expect(diff.value).toBe(0);
  });

  test("cyclic: wraps to the first point with the remaining time", () => {
    const m = new MoveSpline();
    m.initialize(args([v(0, 0, 0), v(10, 0, 0), v(10, 10, 0)], 5, (a) => (a.flags.cyclic = true)));
    expect(m.isCyclic()).toBe(true);
    const dur = m.duration();
    const results: number[] = [];
    m.updateState(dur + 123, (r) => results.push(r));
    expect(results.at(-2)).toBe(MoveSpline.Result_NextCycle | MoveSpline.Result_JustArrived);
    expect(m.finalized()).toBe(false);
    expect(m._currentSplineIdx()).toBeLessThan(3);
    expect(m.timePassed()).toBe(123);
    expect(m.currentPathIdx()).toBeLessThan(3); // modulo the number of segments
  });

  test("updateState on an uninitialized spline asserts", () => {
    expect(() => new MoveSpline().updateState(10)).toThrow("ASSERTION FAILED");
  });

  test("path index offset (SetFirstPointId) is added to the current path index", () => {
    const m = new MoveSpline();
    m.initialize(args([v(0, 0, 0), v(10, 0, 0), v(10, 20, 0)], 5, (a) => (a.path_Idx_offset = 7)));
    expect(m.currentPathIdx()).toBe(7);
    m.updateState(2001);
    expect(m.currentPathIdx()).toBe(8);
  });
});

describe("MoveSplineInitArgs::Validate", () => {
  test("needs two points, a velocity above 0.01 and a time percent in [0, 1]", () => {
    const ok = args([v(0, 0, 0), v(1, 0, 0)], 1);
    expect(ok.Validate(null)).toBe(true);
    expect(args([v(0, 0, 0)], 1).Validate(null)).toBe(false);
    expect(args([v(0, 0, 0), v(1, 0, 0)], 0.01).Validate({ getGUID: () => 1n })).toBe(false);
    expect(args([v(0, 0, 0), v(1, 0, 0)], 1, (a) => (a.time_perc = 1.5)).Validate(null)).toBe(false);
  });

  test("_checkPathBounds rejects a linear vertex more than 1024 yards from the middle", () => {
    const far = args([v(0, 0, 0), v(5000, 0, 0), v(10, 0, 0)], 1);
    expect(far._checkPathBounds()).toBe(false);
    const near = args([v(0, 0, 0), v(5, 0, 0), v(10, 0, 0)], 1);
    expect(near._checkPathBounds()).toBe(true);
    const smooth = args([v(0, 0, 0), v(5000, 0, 0), v(10, 0, 0)], 1, (a) => a.flags.enableCatmullRom());
    expect(smooth._checkPathBounds()).toBe(true);
  });
});

describe("MoveSpline::ToString", () => {
  test("prints the id, flags, times and spline points", () => {
    const m = new MoveSpline();
    m.initialize(args([v(0, 0, 0), v(10, 0, 0)], 5, (a) => {
      a.flags.enableFacingAngle();
      a.facing.angle = 1.5;
    }));
    const text = m.toString();
    expect(text).toContain("spline Id: 5");
    expect(text).toContain("flags:  Final_Angle");
    expect(text).toContain("facing  angle: 1.5");
    expect(text).toContain("total  time: 2001");
    expect(text).toContain("mode: Linear");
  });
});
