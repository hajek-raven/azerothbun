/**
 * Port of `game/Movement/Spline/Spline.{h,cpp}` and `SplineImpl.h`: `SplineBase` (control points, the linear and
 * Catmull-Rom evaluators, segment lengths, initialization) and `Spline<length_type>` (the cumulative lengths in time
 * units, index lookup).
 *
 * Floats: every C++ `float` operation in the evaluators is rounded with `Math.fround`, in the C++ order, so positions and
 * lengths come out as the 32 bit values the C++ computes (`G3D::Vector3` operators are per component float operations,
 * `Vector4 * Matrix4` accumulates in float, `SegLengthCatmullRom` sums in double). `std::cos` / `std::sin` / `sqrtf` use
 * the double functions of `Math` rounded to float (not bit exact with `cosf` / `sinf` in rare last-ulp cases).
 *
 * `Spline<length_type>`: C++ instantiates `Spline<int32>` (`MoveSpline::MySpline`) and `Spline<double>` (`TransportSpline`).
 * Here `new Spline()` is `Spline<int32>` and `new Spline(SPLINE_LENGTH_DOUBLE)` is `Spline<double>`.
 *
 * `ASSERT` is an exception (`Error`), like the C++ assert aborting the process.
 */
import { Vector3 } from "../../../math/Vector3.ts";
import { floatToInt32 } from "./MovementTypedefs.ts";

const fround = Math.fround;

/** `ASSERT(cond)` of `Errors.h`. */
function ASSERT(cond: boolean, expr: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${expr}`);
}

/** @ac game/Movement/Spline/Spline.h Movement::SplineBase::EvaluationMode */
export const ModeLinear = 0;
export const ModeCatmullrom = 1;
export const ModeBezier3_Unused = 2;
export const UninitializedMode = 3;
export const ModesEnd = 4;
export type EvaluationMode = number;

/** The `length_type` template argument of `Spline<length_type>`. */
export const SPLINE_LENGTH_INT32 = 0;
export const SPLINE_LENGTH_DOUBLE = 1;
export type SplineLengthType = typeof SPLINE_LENGTH_INT32 | typeof SPLINE_LENGTH_DOUBLE;

/** `std::numeric_limits<int32>::max()` */
const INT32_MAX = 2147483647;

// ///////// Matrix4 constants (row major, `M[j][i]` is `[j * 4 + i]`)

/** @ac game/Movement/Spline/Spline.cpp s_catmullRomCoeffs */
const s_catmullRomCoeffs = new Float32Array([-0.5, 1.5, -1.5, 0.5, 1.0, -2.5, 2.0, -0.5, -0.5, 0.0, 0.5, 0.0, 0.0, 1.0, 0.0, 0.0]);

/** @ac game/Movement/Spline/Spline.cpp s_Bezier3Coeffs */
const s_Bezier3Coeffs = new Float32Array([-1.0, 3.0, -3.0, 1.0, 3.0, -6.0, 3.0, 0.0, -3.0, 3.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]);

const weights = new Float64Array(4);
const tvec = new Float64Array(4);

/** `Vector4 weights(tvec * matr)`: `result[i] = 0; result[i] += tvec[j] * M[j][i]` in float. */
function computeWeights(matr: Float32Array): void {
  for (let i = 0; i < 4; ++i) {
    let r = 0.0;
    for (let j = 0; j < 4; ++j) r = fround(r + fround(tvec[j]! * matr[j * 4 + i]!));
    weights[i] = r;
  }
}

/** `result = v[0] * w[0] + v[1] * w[1] + v[2] * w[2] + v[3] * w[3]` on `G3D::Vector3` (float per component). */
function combine(vertice: readonly Vector3[], base: number, result: Vector3): void {
  const v0 = vertice[base]!;
  const v1 = vertice[base + 1]!;
  const v2 = vertice[base + 2]!;
  const v3 = vertice[base + 3]!;
  const w0 = weights[0]!;
  const w1 = weights[1]!;
  const w2 = weights[2]!;
  const w3 = weights[3]!;
  result.x = fround(fround(fround(fround(v0.x * w0) + fround(v1.x * w1)) + fround(v2.x * w2)) + fround(v3.x * w3));
  result.y = fround(fround(fround(fround(v0.y * w0) + fround(v1.y * w1)) + fround(v2.y * w2)) + fround(v3.y * w3));
  result.z = fround(fround(fround(fround(v0.z * w0) + fround(v1.z * w1)) + fround(v2.z * w2)) + fround(v3.z * w3));
}

/** @ac game/Movement/Spline/Spline.cpp C_Evaluate (`vertice` is `&points[base]`) */
function C_Evaluate(vertice: readonly Vector3[], base: number, t: number, matr: Float32Array, result: Vector3): void {
  t = fround(t);
  tvec[0] = fround(fround(t * t) * t);
  tvec[1] = fround(t * t);
  tvec[2] = t;
  tvec[3] = 1.0;
  computeWeights(matr);
  combine(vertice, base, result);
}

/** @ac game/Movement/Spline/Spline.cpp C_Evaluate_Derivative */
function C_Evaluate_Derivative(vertice: readonly Vector3[], base: number, t: number, matr: Float32Array, result: Vector3): void {
  t = fround(t);
  tvec[0] = fround(fround(3.0 * t) * t);
  tvec[1] = fround(2.0 * t);
  tvec[2] = 1.0;
  tvec[3] = 0.0;
  computeWeights(matr);
  combine(vertice, base, result);
}

/** `Vector3::length()`: `sqrtf(x*x + y*y + z*z)` over float operands. */
function vlength(x: number, y: number, z: number): number {
  return fround(Math.sqrt(fround(fround(fround(x * x) + fround(y * y)) + fround(z * z))));
}

/** @ac game/Movement/Spline/Spline.h Movement::SplineBase */
export class SplineBase {
  /** `typedef int index_type` */
  static readonly STEPS_PER_SEGMENT = 3;

  protected points: Vector3[] = [];

  protected index_lo = 0;
  protected index_hi = 0;

  protected m_mode: number = UninitializedMode;
  protected cyclic = false;
  protected initialOrientation = 0;

  // ///////// evaluation

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::EvaluateLinear */
  protected EvaluateLinear(index: number, u: number, result: Vector3): void {
    ASSERT(index >= this.index_lo && index < this.index_hi, "index >= index_lo && index < index_hi");
    const a = this.points[index]!;
    const b = this.points[index + 1]!;
    u = fround(u);
    result.x = fround(a.x + fround(fround(b.x - a.x) * u));
    result.y = fround(a.y + fround(fround(b.y - a.y) * u));
    result.z = fround(a.z + fround(fround(b.z - a.z) * u));
  }

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::EvaluateCatmullRom */
  protected EvaluateCatmullRom(index: number, t: number, result: Vector3): void {
    ASSERT(index >= this.index_lo && index < this.index_hi, "index >= index_lo && index < index_hi");
    C_Evaluate(this.points, index - 1, t, s_catmullRomCoeffs, result);
  }

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::EvaluateBezier3 */
  protected EvaluateBezier3(index: number, t: number, result: Vector3): void {
    index *= 3;
    ASSERT(index >= this.index_lo && index < this.index_hi, "index >= index_lo && index < index_hi");
    C_Evaluate(this.points, index, t, s_Bezier3Coeffs, result);
  }

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::EvaluateDerivativeLinear */
  protected EvaluateDerivativeLinear(index: number, _u: number, result: Vector3): void {
    ASSERT(index >= this.index_lo && index < this.index_hi, "index >= index_lo && index < index_hi");
    const a = this.points[index]!;
    const b = this.points[index + 1]!;
    result.x = fround(b.x - a.x);
    result.y = fround(b.y - a.y);
    result.z = fround(b.z - a.z);
  }

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::EvaluateDerivativeCatmullRom */
  protected EvaluateDerivativeCatmullRom(index: number, t: number, result: Vector3): void {
    ASSERT(index >= this.index_lo && index < this.index_hi, "index >= index_lo && index < index_hi");
    C_Evaluate_Derivative(this.points, index - 1, t, s_catmullRomCoeffs, result);
  }

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::EvaluateDerivativeBezier3 */
  protected EvaluateDerivativeBezier3(index: number, t: number, result: Vector3): void {
    index *= 3;
    ASSERT(index >= this.index_lo && index < this.index_hi, "index >= index_lo && index < index_hi");
    C_Evaluate_Derivative(this.points, index, t, s_Bezier3Coeffs, result);
  }

  /** @ac game/Movement/Spline/Spline.h SplineBase::UninitializedSplineEvaluationMethod (`ABORT()`) */
  protected UninitializedSplineEvaluationMethod(_index: number, _u: number, _result: Vector3): void {
    throw new Error("ABORT: SplineBase evaluated while uninitialized");
  }

  // ///////// segment lengths

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::SegLengthLinear */
  protected SegLengthLinear(index: number): number {
    ASSERT(index >= this.index_lo && index < this.index_hi, "index >= index_lo && index < index_hi");
    const a = this.points[index]!;
    const b = this.points[index + 1]!;
    return vlength(fround(a.x - b.x), fround(a.y - b.y), fround(a.z - b.z));
  }

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::SegLengthCatmullRom */
  protected SegLengthCatmullRom(index: number): number {
    ASSERT(index >= this.index_lo && index < this.index_hi, "index >= index_lo && index < index_hi");

    const p = this.points;
    const base = index - 1;
    const cur = p[base + 1]!.clone();
    const next = p[base + 1]!.clone();

    let i = 1;
    let length = 0; // double
    while (i <= SplineBase.STEPS_PER_SEGMENT) {
      C_Evaluate(p, base, fround(fround(i) / fround(SplineBase.STEPS_PER_SEGMENT)), s_catmullRomCoeffs, next);
      length += vlength(fround(next.x - cur.x), fround(next.y - cur.y), fround(next.z - cur.z));
      cur.copy(next);
      ++i;
    }
    return fround(length);
  }

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::SegLengthBezier3 */
  protected SegLengthBezier3(index: number): number {
    index *= 3;
    ASSERT(index >= this.index_lo && index < this.index_hi, "index >= index_lo && index < index_hi");

    const p = this.points;
    const cur = new Vector3();
    const next = new Vector3();

    C_Evaluate(p, index, 0.0, s_Bezier3Coeffs, next);
    cur.copy(next);

    let i = 1;
    let length = 0; // double
    while (i <= SplineBase.STEPS_PER_SEGMENT) {
      C_Evaluate(p, index, fround(fround(i) / fround(SplineBase.STEPS_PER_SEGMENT)), s_Bezier3Coeffs, next);
      length += vlength(fround(next.x - cur.x), fround(next.y - cur.y), fround(next.z - cur.z));
      cur.copy(next);
      ++i;
    }
    return fround(length);
  }

  /** @ac game/Movement/Spline/Spline.h SplineBase::UninitializedSplineSegLenghtMethod (`ABORT()`) */
  protected UninitializedSplineSegLenghtMethod(_index: number): number {
    throw new Error("ABORT: SplineBase segment length of an uninitialized spline");
  }

  // ///////// initialization

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::InitLinear (unused: the initializers table uses `InitCatmullRom` for linear) */
  protected InitLinear(controls: readonly Vector3[], count: number, cyclic: boolean, cyclic_point: number): void {
    ASSERT(count >= 2, "count >= 2");
    const real_size = count + 1;

    this.points = this.resizedPoints(real_size);

    for (let i = 0; i < count; ++i) this.points[i]!.copy(roundVector(controls[i]!));

    // first and last two indexes are space for special 'virtual points'
    // these points are required for proper C_Evaluate and C_Evaluate_Derivative methtod work
    if (cyclic) this.points[count]!.copy(roundVector(controls[cyclic_point]!));
    else this.points[count]!.copy(roundVector(controls[count - 1]!));

    this.index_lo = 0;
    this.index_hi = cyclic ? count : count - 1;
  }

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::InitCatmullRom */
  protected InitCatmullRom(controls: readonly Vector3[], count: number, cyclic: boolean, cyclic_point: number): void {
    const real_size = count + (cyclic ? 1 + 2 : 1 + 1);

    this.points = this.resizedPoints(real_size);

    const lo_index = 1;
    const high_index = lo_index + count - 1;

    for (let i = 0; i < count; ++i) this.points[lo_index + i]!.copy(roundVector(controls[i]!));

    // first and last two indexes are space for special 'virtual points'
    // these points are required for proper C_Evaluate and C_Evaluate_Derivative methtod work
    if (cyclic) {
      if (cyclic_point === 0) this.points[0]!.copy(roundVector(controls[count - 1]!));
      else this.points[0]!.copy(this.backwardsFromOrientation(controls[0]!));

      this.points[high_index + 1]!.copy(roundVector(controls[cyclic_point]!));
      this.points[high_index + 2]!.copy(roundVector(controls[cyclic_point + 1]!));
    } else {
      if (this.m_mode === ModeCatmullrom) {
        this.points[0]!.copy(this.backwardsFromOrientation(controls[0]!));
      } else {
        // controls[0].lerp(controls[1], -1)
        const a = roundVector(controls[0]!);
        const b = roundVector(controls[1]!);
        this.points[0]!.set(
          fround(a.x + fround(fround(b.x - a.x) * -1)),
          fround(a.y + fround(fround(b.y - a.y) * -1)),
          fround(a.z + fround(fround(b.z - a.z) * -1)),
        );
      }

      this.points[high_index + 1]!.copy(roundVector(controls[count - 1]!));
    }

    this.index_lo = lo_index;
    this.index_hi = high_index + (cyclic ? 1 : 0);
  }

  /** `controls[0] - G3D::Vector3{ std::cos(initialOrientation), std::sin(initialOrientation), 0.0f }` */
  private backwardsFromOrientation(c: Vector3): Vector3 {
    const o = fround(this.initialOrientation);
    return new Vector3(fround(fround(c.x) - fround(Math.cos(o))), fround(fround(c.y) - fround(Math.sin(o))), fround(fround(c.z) - 0.0));
  }

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::InitBezier3 */
  protected InitBezier3(controls: readonly Vector3[], count: number, _cyclic: boolean, _cyclic_point: number): void {
    const c = Math.trunc(count / 3) * 3;
    const t = Math.trunc(c / 3);

    this.points = this.resizedPoints(c);
    for (let i = 0; i < c; ++i) this.points[i]!.copy(roundVector(controls[i]!));

    this.index_lo = 0;
    this.index_hi = t - 1;
    //mov_assert(points.size() % 3 == 0);
  }

  /** @ac game/Movement/Spline/Spline.h SplineBase::UninitializedSplineInitMethod (`ABORT()`) */
  protected UninitializedSplineInitMethod(_controls: readonly Vector3[], _count: number, _cyclic: boolean, _cyclic_point: number): void {
    throw new Error("ABORT: SplineBase initialized with an uninitialized mode");
  }

  /** `points.resize(n)`: the existing elements stay, new ones are `Vector3()`. */
  private resizedPoints(size: number): Vector3[] {
    const out = this.points.slice(0, size);
    while (out.length < size) out.push(new Vector3());
    return out;
  }

  // ///////// public interface

  /**
   * Caclulates the position for given segment Idx, and percent of segment length t
   * @param u - percent of segment length, assumes that t in range [0, 1]
   * @param Idx - spline segment index, should be in range [first, last)
   * @ac game/Movement/Spline/Spline.h SplineBase::evaluate_percent
   */
  evaluate_percent(Idx: number, u: number, c: Vector3): void {
    switch (this.m_mode) {
      case ModeLinear:
        this.EvaluateLinear(Idx, u, c);
        break;
      case ModeCatmullrom:
        this.EvaluateCatmullRom(Idx, u, c);
        break;
      case ModeBezier3_Unused:
        this.EvaluateBezier3(Idx, u, c);
        break;
      default:
        this.UninitializedSplineEvaluationMethod(Idx, u, c);
    }
  }

  /**
   * Caclulates derivation in index Idx, and percent of segment length t
   * @param Idx - spline segment index, should be in range [first, last)
   * @param u  - percent of spline segment length, assumes that t in range [0, 1]
   * @ac game/Movement/Spline/Spline.h SplineBase::evaluate_derivative
   */
  evaluate_derivative(Idx: number, u: number, hermite: Vector3): void {
    switch (this.m_mode) {
      case ModeLinear:
        this.EvaluateDerivativeLinear(Idx, u, hermite);
        break;
      case ModeCatmullrom:
        this.EvaluateDerivativeCatmullRom(Idx, u, hermite);
        break;
      case ModeBezier3_Unused:
        this.EvaluateDerivativeBezier3(Idx, u, hermite);
        break;
      default:
        this.UninitializedSplineEvaluationMethod(Idx, u, hermite);
    }
  }

  /** Bounds for spline indexes. All indexes should be in range [first, last). @ac game/Movement/Spline/Spline.h SplineBase::first */
  first(): number {
    return this.index_lo;
  }
  /** @ac game/Movement/Spline/Spline.h SplineBase::last */
  last(): number {
    return this.index_hi;
  }

  /** @ac game/Movement/Spline/Spline.h SplineBase::empty */
  empty(): boolean {
    return this.index_lo === this.index_hi;
  }
  /** @ac game/Movement/Spline/Spline.h SplineBase::mode */
  mode(): EvaluationMode {
    return this.m_mode;
  }
  /** @ac game/Movement/Spline/Spline.h SplineBase::isCyclic */
  isCyclic(): boolean {
    return this.cyclic;
  }

  // Xinef: DO NOT USE EXCEPT FOR SPLINE INITIALIZATION!!!!!!
  /** @ac game/Movement/Spline/Spline.h SplineBase::getPoints */
  getPoints(): readonly Vector3[] {
    return this.points;
  }
  /** @ac game/Movement/Spline/Spline.h SplineBase::getPointCount */
  getPointCount(): number {
    return this.points.length;
  }
  /** @ac game/Movement/Spline/Spline.h SplineBase::getPoint */
  getPoint(i: number): Vector3 {
    return this.points[i]!;
  }

  /**
   * Initializes spline. Don't call other methods while spline not initialized.
   * @ac game/Movement/Spline/Spline.cpp SplineBase::init_spline
   */
  init_spline(controls: readonly Vector3[], count: number, m: EvaluationMode, orientation: number): void {
    this.m_mode = m;
    this.cyclic = false;
    this.initialOrientation = fround(orientation);

    this.runInitializer(controls, count, this.cyclic, 0);
  }

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::init_cyclic_spline */
  init_cyclic_spline(controls: readonly Vector3[], count: number, m: EvaluationMode, cyclic_point: number, orientation: number): void {
    this.m_mode = m;
    this.cyclic = true;
    this.initialOrientation = fround(orientation);

    this.runInitializer(controls, count, this.cyclic, cyclic_point);
  }

  /** `(this->*initializers[m_mode])(...)`: linear mode uses the catmullrom initializer (client's internal structure limitation) */
  private runInitializer(controls: readonly Vector3[], count: number, cyclic: boolean, cyclic_point: number): void {
    switch (this.m_mode) {
      case ModeLinear:
      case ModeCatmullrom:
        this.InitCatmullRom(controls, count, cyclic, cyclic_point);
        break;
      case ModeBezier3_Unused:
        this.InitBezier3(controls, count, cyclic, cyclic_point);
        break;
      default:
        this.UninitializedSplineInitMethod(controls, count, cyclic, cyclic_point);
    }
  }

  /**
   * As i can see there are a lot of ways how spline can be initialized
   * would be no harm to have some custom initializers.
   * @ac game/Movement/Spline/Spline.h SplineBase::init_spline_custom
   * The initializer's `m_mode, cyclic, points, index_lo, index_hi` reference parameters are the fields of `state`.
   */
  init_spline_custom(initializer: (state: { m_mode: number; cyclic: boolean; points: Vector3[]; index_lo: number; index_hi: number }) => void): void {
    const state = { m_mode: this.m_mode, cyclic: this.cyclic, points: this.points, index_lo: this.index_lo, index_hi: this.index_hi };
    initializer(state);
    this.m_mode = state.m_mode;
    this.cyclic = state.cyclic;
    this.points = state.points;
    this.index_lo = state.index_lo;
    this.index_hi = state.index_hi;
  }

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::clear */
  clear(): void {
    this.index_lo = 0;
    this.index_hi = 0;
    this.points = [];
  }

  /** Calculates distance between [i; i+1] points, assumes that index i is in bounds. @ac game/Movement/Spline/Spline.h SplineBase::SegLength */
  segLength(i: number): number {
    switch (this.m_mode) {
      case ModeLinear:
        return this.SegLengthLinear(i);
      case ModeCatmullrom:
        return this.SegLengthCatmullRom(i);
      case ModeBezier3_Unused:
        return this.SegLengthBezier3(i);
      default:
        return this.UninitializedSplineSegLenghtMethod(i);
    }
  }

  /** @ac game/Movement/Spline/Spline.cpp SplineBase::ToString */
  toString(): string {
    const mode_str = ["Linear", "CatmullRom", "Bezier3", "Uninitialized"];

    const count = this.points.length;
    let str = `mode: ${mode_str[this.mode()]}\n`;
    str += `points count: ${count}\n`;
    for (let i = 0; i < count; ++i) str += `point ${i} : ${this.points[i]!.toString()}\n`;

    return str;
  }
}

/** A control point as the C++ `float` triple it is copied into. */
function roundVector(v: Vector3): Vector3 {
  return new Vector3(fround(v.x), fround(v.y), fround(v.z));
}

/** @ac game/Movement/Spline/Spline.h Movement::Spline */
export class Spline extends SplineBase {
  protected lengths: number[] = [];

  /** @param lengthType `Spline<int32>` (default) or `Spline<double>` (`SPLINE_LENGTH_DOUBLE`) */
  constructor(private readonly lengthType: SplineLengthType = SPLINE_LENGTH_INT32) {
    super();
  }

  /** A float expression stored into a `length_type` (`int32` truncates like the C++ conversion, `double` keeps it). */
  private toLength(x: number): number {
    return this.lengthType === SPLINE_LENGTH_INT32 ? floatToInt32(x) : x;
  }

  /** `length_type length_ = t * length()`: `float * int32` is a float product, `float * double` a double one. */
  private scaledLength(t: number): number {
    return this.lengthType === SPLINE_LENGTH_INT32 ? floatToInt32(fround(fround(t) * fround(this.length()))) : fround(t) * this.length();
  }

  /** @ac game/Movement/Spline/SplineImpl.h Spline::computeIndexInBounds (`length_type` overload) */
  private computeIndexInBoundsLength(length_: number): number {
    // Temporary disabled: causes infinite loop with t = 1.f
    let i = this.index_lo;
    const N = this.index_hi;
    while (i + 1 < N && this.lengths[i + 1]! < length_) ++i;

    return i;
  }

  /**
   * Calculates the position for given t
   * @param t - percent of spline's length, assumes that t in range [0, 1].
   * Overloads: `evaluate_percent(t, c)` and `evaluate_percent(Idx, u, c)`.
   * @ac game/Movement/Spline/SplineImpl.h Spline::evaluate_percent
   */
  override evaluate_percent(idxOrT: number, uOrC: number | Vector3, c?: Vector3): void {
    if (c === undefined) {
      const out = { index: 0, u: 0 };
      this.computeIndex(idxOrT, out);
      this.evaluate_percent(out.index, out.u, uOrC as Vector3);
      return;
    }
    super.evaluate_percent(idxOrT, uOrC as number, c);
  }

  /**
   * Calculates derivation for given t. Overloads: `evaluate_derivative(t, hermite)` and `evaluate_derivative(Idx, u, hermite)`.
   * @ac game/Movement/Spline/SplineImpl.h Spline::evaluate_derivative
   */
  override evaluate_derivative(idxOrT: number, uOrHermite: number | Vector3, hermite?: Vector3): void {
    if (hermite === undefined) {
      const out = { index: 0, u: 0 };
      this.computeIndex(idxOrT, out);
      this.evaluate_derivative(out.index, out.u, uOrHermite as Vector3);
      return;
    }
    super.evaluate_derivative(idxOrT, uOrHermite as number, hermite);
  }

  /** Assumes that t in range [0, 1] @ac game/Movement/Spline/SplineImpl.h Spline::computeIndexInBounds (float overload) */
  computeIndexInBounds(t: number): number {
    ASSERT(t >= 0.0 && t <= 1.0, "t >= 0.f && t <= 1.f");
    return this.computeIndexInBoundsLength(this.scaledLength(t));
  }

  /** `computeIndex(float t, index_type& out_idx, float& out_u)` @ac game/Movement/Spline/SplineImpl.h Spline::computeIndex */
  computeIndex(t: number, out: { index: number; u: number }): void {
    ASSERT(t >= 0.0 && t <= 1.0, "t >= 0.f && t <= 1.f");
    const length_ = this.scaledLength(t);
    const index = this.computeIndexInBoundsLength(length_);
    out.index = index;
    ASSERT(index < this.index_hi, "index < index_hi");
    out.u = fround(fround(length_ - this.length(index)) / fround(this.length(index, index + 1)));
  }

  /**
   * Initializes lengths with SplineBase::SegLength method.
   * Initializes lengths in some custom way (`initLengths(cacher)`): the value returned by the cacher must be greater or
   * equal to the previous value.
   * @ac game/Movement/Spline/SplineImpl.h Spline::initLengths
   */
  initLengths(cacher?: (s: Spline, i: number) => number): void {
    let i = this.index_lo;
    this.resizeLengths(this.index_hi + 1);
    if (cacher === undefined) {
      let length = 0;
      while (i < this.index_hi) {
        length = this.toLength(this.lengthType === SPLINE_LENGTH_INT32 ? fround(fround(length) + this.segLength(i)) : length + this.segLength(i));
        this.lengths[++i] = length;
      }
      return;
    }

    let prev_length = 0;
    let new_length = 0;
    while (i < this.index_hi) {
      new_length = cacher(this, i);
      // length overflowed, assign to max positive value
      if (new_length < 0) new_length = this.lengthType === SPLINE_LENGTH_INT32 ? INT32_MAX : Number.MAX_VALUE;
      this.lengths[++i] = new_length;

      ASSERT(prev_length <= new_length, "prev_length <= new_length");
      prev_length = new_length;
    }
  }

  private resizeLengths(size: number): void {
    if (this.lengths.length > size) this.lengths.length = size;
    while (this.lengths.length < size) this.lengths.push(0);
  }

  /** Returns length of the whole spline. @ac game/Movement/Spline/Spline.h Spline::length */
  length(): number;
  /** Returns length between given nodes. */
  length(first: number, last: number): number;
  /** Returns length at the node. */
  length(Idx: number): number;
  length(a?: number, b?: number): number {
    // an uninitialized spline has no lengths (a C++ read out of an empty vector); 0 here
    if (a === undefined) return this.lengths[this.index_hi] ?? 0;
    if (b === undefined) return this.lengths[a] ?? 0;
    return this.toLength((this.lengths[b] ?? 0) - (this.lengths[a] ?? 0));
  }

  /** @ac game/Movement/Spline/Spline.h Spline::set_length */
  set_length(i: number, length: number): void {
    this.lengths[i] = length;
  }

  /** @ac game/Movement/Spline/SplineImpl.h Spline::clear */
  override clear(): void {
    super.clear();
    this.lengths = [];
  }
}
