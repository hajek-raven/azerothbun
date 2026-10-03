import { describe, expect, test } from "bun:test";
import { Vector3 } from "../../../math/Vector3.ts";
import { ModeCatmullrom, ModeLinear, SPLINE_LENGTH_DOUBLE, Spline, UninitializedMode } from "./Spline.ts";

const F = Math.fround;

function pts(...p: [number, number, number][]): Vector3[] {
  return p.map(([x, y, z]) => new Vector3(x, y, z));
}

/** Initializes the lengths in "time units" like `CommonInitializer` does at 1000 units per yard. */
function lengthsPerYard(s: Spline): void {
  let t = 1;
  s.initLengths((sp, i) => {
    t += Math.trunc(sp.segLength(i) * 1000);
    return t;
  });
}

describe("Spline linear mode", () => {
  const controls = pts([0, 0, 0], [10, 0, 0], [10, 10, 0], [10, 10, 5]);

  test("InitCatmullRom layout: count + 2 points, first() is 1, last() is count", () => {
    const s = new Spline();
    expect(s.mode()).toBe(UninitializedMode);
    s.init_spline(controls, controls.length, ModeLinear, 0);
    expect(s.getPointCount()).toBe(6);
    expect(s.first()).toBe(1);
    expect(s.last()).toBe(4);
    expect(s.empty()).toBe(false);
    expect(s.isCyclic()).toBe(false);
    // virtual start is controls[0].lerp(controls[1], -1), virtual end is controls[count - 1]
    expect(s.getPoint(0)).toEqual(new Vector3(-10, 0, 0));
    expect(s.getPoint(1)).toEqual(new Vector3(0, 0, 0));
    expect(s.getPoint(5)).toEqual(new Vector3(10, 10, 5));
  });

  test("segment lengths are the point distances", () => {
    const s = new Spline();
    s.init_spline(controls, controls.length, ModeLinear, 0);
    expect(s.segLength(1)).toBe(10);
    expect(s.segLength(2)).toBe(10);
    expect(s.segLength(3)).toBe(5);
  });

  test("evaluate_percent and evaluate_derivative on a segment", () => {
    const s = new Spline();
    s.init_spline(controls, controls.length, ModeLinear, 0);
    const c = new Vector3();
    s.evaluate_percent(1, 0.25, c);
    expect([c.x, c.y, c.z]).toEqual([2.5, 0, 0]);
    s.evaluate_percent(2, 0.5, c);
    expect([c.x, c.y, c.z]).toEqual([10, 5, 0]);
    s.evaluate_derivative(3, 0.3, c);
    expect([c.x, c.y, c.z]).toEqual([0, 0, 5]);
  });

  test("evaluate_percent by the whole spline's percent uses the lengths", () => {
    const s = new Spline();
    s.init_spline(controls, controls.length, ModeLinear, 0);
    s.initLengths(); // int32 lengths: 10, 20, 25
    expect([s.length(), s.length(1), s.length(1, 3), s.length(1, 4)]).toEqual([25, 0, 20, 25]);
    const c = new Vector3();
    s.evaluate_percent(0.4, c); // 10 yards in: end of the first segment (lengths[i + 1] < 10 is false)
    expect([c.x, c.y, c.z]).toEqual([10, 0, 0]);
    s.evaluate_percent(0.6, c); // 15 yards in: half of the second segment
    expect([c.x, c.y, c.z]).toEqual([10, 5, 0]);
    s.evaluate_percent(1, c);
    expect([c.x, c.y, c.z]).toEqual([10, 10, 5]);
    expect(s.computeIndexInBounds(0.9)).toBe(3);
  });

  test("control points are stored as 32 bit floats", () => {
    const s = new Spline();
    s.init_spline(pts([0.1, 0, 0], [0.7, 0, 0]), 2, ModeLinear, 0);
    expect(s.getPoint(1).x).toBe(F(0.1));
    expect(s.getPoint(2).x).toBe(F(0.7));
  });

  test("clear resets the spline", () => {
    const s = new Spline();
    s.init_spline(controls, controls.length, ModeLinear, 0);
    lengthsPerYard(s);
    s.clear();
    expect(s.empty()).toBe(true);
    expect(s.getPointCount()).toBe(0);
  });
});

describe("Spline Catmull-Rom mode", () => {
  const controls = pts([0, 0, 0], [10, 0, 0], [20, 5, 0], [30, 5, 2]);

  test("virtual first point is controls[0] - (cos o, sin o, 0)", () => {
    const s = new Spline();
    s.init_spline(controls, controls.length, ModeCatmullrom, Math.PI / 2);
    const p0 = s.getPoint(0);
    expect(p0.x).toBe(F(0 - F(Math.cos(F(Math.PI / 2)))));
    expect(p0.y).toBe(-1);
    expect(s.getPoint(5)).toEqual(new Vector3(30, 5, 2)); // the last control repeated
    expect(s.mode()).toBe(ModeCatmullrom);
  });

  test("the curve passes through its control points", () => {
    const s = new Spline();
    s.init_spline(controls, controls.length, ModeCatmullrom, 0);
    const c = new Vector3();
    for (let i = s.first(); i < s.last(); ++i) {
      s.evaluate_percent(i, 0, c);
      expect([c.x, c.y, c.z]).toEqual([s.getPoint(i).x, s.getPoint(i).y, s.getPoint(i).z]);
      s.evaluate_percent(i, 1, c);
      expect(c.x).toBeCloseTo(s.getPoint(i + 1).x, 4);
      expect(c.y).toBeCloseTo(s.getPoint(i + 1).y, 4);
      expect(c.z).toBeCloseTo(s.getPoint(i + 1).z, 4);
    }
  });

  test("mid segment value equals the Catmull-Rom polynomial", () => {
    const s = new Spline();
    s.init_spline(controls, controls.length, ModeCatmullrom, 0);
    const c = new Vector3();
    const t = 0.3;
    s.evaluate_percent(2, t, c);
    const p = [s.getPoint(1), s.getPoint(2), s.getPoint(3), s.getPoint(4)];
    const ref = (axis: "x" | "y" | "z") => {
      const [p0, p1, p2, p3] = p.map((q) => q[axis]) as [number, number, number, number];
      return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    };
    expect(c.x).toBeCloseTo(ref("x"), 4);
    expect(c.y).toBeCloseTo(ref("y"), 4);
    expect(c.z).toBeCloseTo(ref("z"), 4);

    // derivative against the analytic one
    const d = new Vector3();
    s.evaluate_derivative(2, t, d);
    const dref = (axis: "x" | "y" | "z") => {
      const [p0, p1, p2, p3] = p.map((q) => q[axis]) as [number, number, number, number];
      return 0.5 * ((-p0 + p2) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * t * t);
    };
    expect(d.x).toBeCloseTo(dref("x"), 4);
    expect(d.y).toBeCloseTo(dref("y"), 4);
    expect(d.z).toBeCloseTo(dref("z"), 4);
  });

  test("segment length is the 3 step polyline of the curve (a float)", () => {
    const s = new Spline();
    s.init_spline(controls, controls.length, ModeCatmullrom, 0);
    let sum = 0;
    let prev = new Vector3(s.getPoint(2).x, s.getPoint(2).y, s.getPoint(2).z);
    for (let k = 1; k <= 3; ++k) {
      const c = new Vector3();
      s.evaluate_percent(2, k / 3, c);
      sum += Math.hypot(c.x - prev.x, c.y - prev.y, c.z - prev.z);
      prev = c;
    }
    expect(s.segLength(2)).toBeCloseTo(sum, 3);
    expect(s.segLength(2)).toBe(F(s.segLength(2)));
  });
});

describe("Spline cyclic", () => {
  const controls = pts([0, 0, 0], [10, 0, 0], [10, 10, 0]);

  test("linear cyclic: count + 3 points, the segment after the last control returns to the first", () => {
    const s = new Spline();
    s.init_cyclic_spline(controls, controls.length, ModeLinear, 0, 0);
    expect(s.isCyclic()).toBe(true);
    expect(s.getPointCount()).toBe(6);
    expect(s.first()).toBe(1);
    expect(s.last()).toBe(4); // one more segment than the open spline
    // points[0] is the last control, points[high + 1] the cyclic point, points[high + 2] the one after it
    expect(s.getPoint(0)).toEqual(new Vector3(10, 10, 0));
    expect(s.getPoint(4)).toEqual(new Vector3(0, 0, 0));
    expect(s.getPoint(5)).toEqual(new Vector3(10, 0, 0));
    expect(s.segLength(3)).toBeCloseTo(Math.hypot(10, 10), 5);
    const c = new Vector3();
    s.evaluate_percent(3, 0.5, c);
    expect([c.x, c.y, c.z]).toEqual([5, 5, 0]);
  });

  test("Catmull-Rom cyclic joins smoothly: the end of the last segment is the first point", () => {
    const s = new Spline();
    s.init_cyclic_spline(controls, controls.length, ModeCatmullrom, 0, 0);
    const c = new Vector3();
    s.evaluate_percent(3, 1, c);
    expect(c.x).toBeCloseTo(0, 4);
    expect(c.y).toBeCloseTo(0, 4);
  });

  test("cyclic_point other than 0 uses the orientation for the virtual first point", () => {
    const s = new Spline();
    s.init_cyclic_spline(controls, controls.length, ModeCatmullrom, 1, 0);
    expect(s.getPoint(0)).toEqual(new Vector3(-1, 0, 0));
    expect(s.getPoint(4)).toEqual(new Vector3(10, 0, 0)); // controls[cyclic_point]
    expect(s.getPoint(5)).toEqual(new Vector3(10, 10, 0)); // controls[cyclic_point + 1]
  });
});

describe("Spline lengths", () => {
  test("initLengths with a cacher and an int32 overflow clamps to INT32_MAX", () => {
    const s = new Spline();
    s.init_spline(pts([0, 0, 0], [1, 0, 0], [2, 0, 0]), 3, ModeLinear, 0);
    s.initLengths(() => -5);
    expect(s.length(2)).toBe(2147483647);
    expect(s.length()).toBe(2147483647);
  });

  test("a decreasing cacher asserts", () => {
    const s = new Spline();
    s.init_spline(pts([0, 0, 0], [1, 0, 0], [2, 0, 0]), 3, ModeLinear, 0);
    let n = 10;
    expect(() => s.initLengths(() => (n -= 5))).toThrow("ASSERTION FAILED");
  });

  test("Spline<double> keeps fractional lengths", () => {
    const s = new Spline(SPLINE_LENGTH_DOUBLE);
    s.init_spline(pts([0, 0, 0], [1.5, 0, 0]), 2, ModeLinear, 0);
    s.initLengths();
    expect(s.length()).toBe(1.5);
  });

  test("evaluating an uninitialized spline aborts", () => {
    const s = new Spline();
    expect(() => s.evaluate_percent(0, 0, new Vector3())).toThrow("ABORT");
  });
});
