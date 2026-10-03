/**
 * Port of `game/Movement/Spline/MoveSpline.{h,cpp}`: a smooth Catmull-Rom or linear curve and the point that moves along
 * it (the unit's `movespline`). The curve can be cyclic; the point can have a vertical acceleration component (fall,
 * parabolic movement).
 *
 * C++ `protected` members that `PacketBuilder` reads through `friend class PacketBuilder` (`spline`, `facing`,
 * `splineflags`, `effect_start_time`, `vertical_acceleration`, `getPath`) are public here. The C++ field `velocity`
 * shares its name with the method `Velocity()`, which becomes `velocity()` as every method does, so the field is `_velocity`.
 *
 * `MoveSpline::UpdateResult` values are constants (`Result_None` ... `Result_JustArrived`); the combined results
 * (`Result_NextCycle | Result_JustArrived`) are plain numbers.
 *
 * Float fidelity: `Math.fround` on the same operations the C++ does on `float` (time ratios, parabolic and fall
 * elevation, orientation); time values are `int32` and are truncated like `static_cast<int32>(float)`.
 */
import { Vector3 } from "../../../math/Vector3.ts";
import { FacingInfo, type MoveSplineInitArgs } from "./MoveSplineInitArgs.ts";
import { MoveSplineFlag } from "./MoveSplineFlag.ts";
import { ModeCatmullrom, ModeLinear, Spline } from "./Spline.ts";
import { floatToInt32, MSToSec, SecToMS } from "./MovementTypedefs.ts";
import { computeFallElevation as computeFallElevationFn, computeFallTime } from "./MovementUtil.ts";

const fround = Math.fround;

/** `ASSERT(cond)` of `Errors.h`. */
function ASSERT(cond: boolean, expr: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${expr}`);
}

/** @ac game/Movement/Spline/MoveSpline.h Movement::Location */
export class Location extends Vector3 {
  orientation = 0;

  /** `Location()`, `Location(x, y, z, o)`, `Location(Vector3 const&)`, `Location(Vector3 const&, float o)`. */
  constructor(x?: number | Vector3, y?: number, z?: number, o?: number) {
    super(x instanceof Vector3 ? x.x : (x ?? 0), x instanceof Vector3 ? x.y : (y ?? 0), x instanceof Vector3 ? x.z : (z ?? 0));
    this.orientation = (x instanceof Vector3 ? y : o) ?? 0;
  }
}

/** `int32&` out parameter of `MoveSpline::_updateState`. */
export type Int32Ref = { value: number };

/** @ac game/Movement/Spline/MoveSpline.cpp Movement::minimal_duration */
const minimal_duration = 1;

/**
 * @ac game/Movement/Spline/MoveSpline.cpp Movement::computeDuration (unused in the file)
 */
export function computeDuration(length: number, velocity: number): number {
  return SecToMS(fround(fround(length) / fround(velocity)));
}

/** @ac game/Movement/Spline/MoveSpline.cpp Movement::FallInitializer */
class FallInitializer {
  constructor(private readonly start_elevation: number) {}
  call(s: Spline, i: number): number {
    return floatToInt32(fround(computeFallTime(fround(this.start_elevation - s.getPoint(i + 1).z), false) * 1000.0));
  }
}

/** @ac game/Movement/Spline/MoveSpline.cpp Movement::CommonInitializer */
class CommonInitializer {
  readonly velocityInv: number;
  private _time = minimal_duration;

  constructor(_velocity: number) {
    this.velocityInv = fround(1000.0 / fround(_velocity));
  }

  call(s: Spline, i: number): number {
    // `_time += (s.SegLength(i) * velocityInv)`: int32 + float is a float sum, converted back to int32
    this._time = floatToInt32(fround(fround(this._time) + fround(s.segLength(i) * this.velocityInv)));
    return this._time;
  }
}

/** @ac game/Movement/Spline/MoveSpline.h Movement::MoveSpline */
export class MoveSpline {
  // enum UpdateResult
  static readonly Result_None = 0x01;
  static readonly Result_Arrived = 0x02;
  static readonly Result_NextCycle = 0x04;
  static readonly Result_NextSegment = 0x08;
  static readonly Result_JustArrived = 0x10;

  // protected in C++ (`friend class PacketBuilder`)
  spline = new Spline(); // MySpline: Spline<int32>

  facing = new FacingInfo();

  m_Id = 0;

  splineflags = new MoveSplineFlag();

  time_passed = 0;
  // currently duration mods are unused, but its _currently_
  //float           duration_mod;
  //float           duration_mod_next;
  vertical_acceleration = 0.0;
  initialOrientation = 0.0;
  /** the C++ field `velocity` (the method `Velocity()` is `velocity()`) */
  _velocity = 0.0;
  effect_start_time = 0;
  point_Idx = 0;
  point_Idx_offset = 0;

  onTransport = false;

  /** @ac game/Movement/Spline/MoveSpline.cpp MoveSpline::MoveSpline */
  constructor() {
    this.splineflags.done = true;
  }

  /** @ac game/Movement/Spline/MoveSpline.cpp MoveSpline::init_spline */
  protected init_spline(args: MoveSplineInitArgs): void {
    const modes = [ModeLinear, ModeCatmullrom];
    if (args.flags.cyclic) {
      const cyclic_point = 0;
      // MoveSplineFlag::Enter_Cycle support dropped
      //if (splineflags & SPLINEFLAG_ENTER_CYCLE)
      //cyclic_point = 1;   // shouldn't be modified, came from client
      this.spline.init_cyclic_spline(args.path, args.path.length, modes[args.flags.isSmooth() ? 1 : 0]!, cyclic_point, args.initialOrientation);
    } else {
      this.spline.init_spline(args.path, args.path.length, modes[args.flags.isSmooth() ? 1 : 0]!, args.initialOrientation);
    }

    // init spline timestamps
    if (this.splineflags.falling) {
      const init = new FallInitializer(this.spline.getPoint(this.spline.first()).z);
      this.spline.initLengths((s, i) => init.call(s, i));
    } else {
      const init = new CommonInitializer(args.velocity);
      this.spline.initLengths((s, i) => init.call(s, i));
    }

    /// @todo: what to do in such cases? problem is in input data (all points are at same coords)
    if (this.spline.length() < minimal_duration) {
      this.spline.set_length(this.spline.last(), this.spline.isCyclic() ? 1000 : 1);
    }
    this.point_Idx = this.spline.first();
  }

  /** @ac game/Movement/Spline/MoveSpline.cpp MoveSpline::Initialize */
  initialize(args: MoveSplineInitArgs): void {
    this.splineflags = args.flags.clone();
    this.facing = args.facing.clone();
    this.m_Id = args.splineId;
    this.point_Idx_offset = args.path_Idx_offset;
    this.initialOrientation = fround(args.initialOrientation);

    this.time_passed = 0;
    this.vertical_acceleration = 0.0;
    this.effect_start_time = 0;
    this._velocity = fround(args.velocity);

    // Check if its a stop spline
    if (args.flags.done) {
      this.spline.clear();
      return;
    }

    this.init_spline(args);

    // init parabolic / animation
    // spline initialized, duration known and i able to compute parabolic acceleration
    if (args.flags.hasFlag(MoveSplineFlag.Parabolic | MoveSplineFlag.Animation)) {
      this.effect_start_time = floatToInt32(fround(fround(this.duration()) * fround(args.time_perc)));
      if (args.flags.parabolic && this.effect_start_time < this.duration()) {
        const f_duration = MSToSec(this.duration() - this.effect_start_time);
        this.vertical_acceleration = fround(fround(fround(args.parabolic_amplitude) * 8.0) / fround(f_duration * f_duration));
      }
    }
  }

  /** @ac game/Movement/Spline/MoveSpline.cpp MoveSpline::ComputePosition */
  computePosition(): Location {
    ASSERT(this.initialized(), "Initialized()");

    let u = 1.0;
    const seg_time = this.spline.length(this.point_Idx, this.point_Idx + 1);
    if (seg_time > 0) u = fround(fround(this.time_passed - this.spline.length(this.point_Idx)) / fround(seg_time));
    const c = new Location();
    c.orientation = this.initialOrientation;
    this.spline.evaluate_percent(this.point_Idx, u, c);

    if (this.splineflags.animation) {
      // MoveSplineFlag::Animation disables falling or parabolic movement
    } else if (this.splineflags.parabolic) c.z = this.computeParabolicElevation(c.z);
    else if (this.splineflags.falling) c.z = this.computeFallElevation(c.z);

    if (this.splineflags.done && this.splineflags.isFacing()) {
      if (this.splineflags.final_angle) c.orientation = this.facing.angle;
      else if (this.splineflags.final_point) c.orientation = fround(Math.atan2(fround(this.facing.f.y - c.y), fround(this.facing.f.x - c.x)));
      //nothing to do for MoveSplineFlag::Final_Target flag
    } else {
      if (!this.splineflags.hasFlag(MoveSplineFlag.OrientationFixed | MoveSplineFlag.Falling)) {
        const hermite = new Vector3();
        this.spline.evaluate_derivative(this.point_Idx, u, hermite);
        c.orientation = fround(Math.atan2(hermite.y, hermite.x));
      }

      if (this.splineflags.orientationInversed) c.orientation = -c.orientation;
    }
    return c;
  }

  /** `void computeParabolicElevation(float& el) const`: takes the current `el` and returns the new one. @ac game/Movement/Spline/MoveSpline.cpp MoveSpline::computeParabolicElevation */
  protected computeParabolicElevation(el: number): number {
    if (this.time_passed > this.effect_start_time) {
      const t_passedf = MSToSec(this.time_passed - this.effect_start_time);
      const t_durationf = MSToSec(this.duration() - this.effect_start_time); //client use not modified duration here

      // -a*x*x + bx + c:
      //(dur * v3->z_acceleration * dt)/2 - (v3->z_acceleration * dt * dt)/2 + Z;
      el = fround(el + fround(fround(fround(fround(t_durationf - t_passedf) * 0.5) * this.vertical_acceleration) * t_passedf));
    }
    return el;
  }

  /** `void computeFallElevation(float& el) const`: the new `el` is returned. @ac game/Movement/Spline/MoveSpline.cpp MoveSpline::computeFallElevation */
  protected computeFallElevation(_el: number): number {
    const z_now = fround(this.spline.getPoint(this.spline.first()).z - computeFallElevationFn(MSToSec(this.time_passed), false));
    const final_z = this.finalDestination().z;
    return Math.max(z_now, final_z);
  }

  /** `int32& ms_time_diff` is `{ value }`. @ac game/Movement/Spline/MoveSpline.cpp MoveSpline::_updateState */
  _updateState(ms_time_diff: Int32Ref): number {
    if (this.finalized()) {
      ms_time_diff.value = 0;
      return MoveSpline.Result_Arrived;
    }

    let result: number = MoveSpline.Result_None;

    let minimal_diff = Math.min(ms_time_diff.value, this.segment_time_elapsed());
    if (minimal_diff < 0) minimal_diff = 0;

    ASSERT(minimal_diff >= 0, "minimal_diff >= 0");
    this.time_passed += minimal_diff;
    ms_time_diff.value -= minimal_diff;

    if (this.time_passed >= this.next_timestamp()) {
      ++this.point_Idx;
      if (this.point_Idx < this.spline.last()) {
        result = MoveSpline.Result_NextSegment;
      } else {
        if (this.spline.isCyclic()) {
          this.point_Idx = this.spline.first();
          this.time_passed = this.time_passed % this.duration();
          result = MoveSpline.Result_NextCycle | MoveSpline.Result_JustArrived;
        } else {
          this._Finalize();
          ms_time_diff.value = 0;
          result = MoveSpline.Result_Arrived | MoveSpline.Result_JustArrived;
        }
      }
    }

    return result;
  }

  /**
   * `updateState(int32 difftime, UpdateHandler& handler)` calls `handler(result)` after every `_updateState` step;
   * `updateState(int32 difftime)` (no handler) just steps.
   * @ac game/Movement/Spline/MoveSpline.h MoveSpline::updateState
   */
  updateState(difftime: number, handler?: (result: number) => void): void {
    ASSERT(this.initialized(), "Initialized()");
    const diff: Int32Ref = { value: difftime | 0 };
    do {
      const result = this._updateState(diff);
      if (handler) handler(result);
    } while (diff.value > 0);
  }

  /** @ac game/Movement/Spline/MoveSpline.cpp MoveSpline::ToString */
  toString(): string {
    let str = "MoveSpline\n";
    str += `spline Id: ${this.getId()}\n`;
    str += `flags: ${this.splineflags.toString()}\n`;
    if (this.splineflags.final_angle) str += `facing  angle: ${stream(this.facing.angle)}`;
    else if (this.splineflags.final_target) str += `facing target: ${this.facing.target}`;
    else if (this.splineflags.final_point) str += `facing  point: ${stream(this.facing.f.x)} ${stream(this.facing.f.y)} ${stream(this.facing.f.z)}`;
    str += "\n";
    str += `time passed: ${this.time_passed}\n`;
    str += `total  time: ${this.duration()}\n`;
    str += `spline point Id: ${this.point_Idx}\n`;
    str += `path  point  Id: ${this.currentPathIdx()}\n`;
    str += this.spline.toString();
    return str;
  }

  /** @ac game/Movement/Spline/MoveSpline.cpp MoveSpline::_Finalize */
  _Finalize(): void {
    this.splineflags.done = true;
    this.point_Idx = this.spline.last() - 1;
    this.time_passed = this.duration();
  }

  /** @ac game/Movement/Spline/MoveSpline.cpp MoveSpline::currentPathIdx */
  currentPathIdx(): number {
    let point = this.point_Idx_offset + this.point_Idx - this.spline.first() + (this.finalized() ? 1 : 0);
    if (this.isCyclic()) point = point % (this.spline.last() - this.spline.first());
    return point;
  }

  // ///////// inline accessors of MoveSpline.h

  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::getPath */
  getPath(): readonly Vector3[] {
    return this.spline.getPoints();
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::next_timestamp */
  next_timestamp(): number {
    return this.spline.length(this.point_Idx + 1);
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::segment_time_elapsed */
  segment_time_elapsed(): number {
    return this.next_timestamp() - this.time_passed;
  }
  /** xinef: moved to public for waypoint movegen @ac game/Movement/Spline/MoveSpline.h MoveSpline::timeElapsed */
  timeElapsed(): number {
    return this.duration() - this.time_passed;
  }
  /** xinef: moved to public for waypoint movegen @ac game/Movement/Spline/MoveSpline.h MoveSpline::timePassed */
  timePassed(): number {
    return this.time_passed;
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::Duration */
  duration(): number {
    return this.spline.length();
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::_Spline */
  _Spline(): Spline {
    return this.spline;
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::_currentSplineIdx */
  _currentSplineIdx(): number {
    return this.point_Idx;
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::Velocity */
  velocity(): number {
    return this._velocity;
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::_Interrupt */
  _Interrupt(): void {
    this.splineflags.done = true;
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::Initialized */
  initialized(): boolean {
    return !this.spline.empty();
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::GetId */
  getId(): number {
    return this.m_Id;
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::Finalized */
  finalized(): boolean {
    return this.splineflags.done;
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::isCyclic */
  isCyclic(): boolean {
    return this.splineflags.cyclic;
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::isFalling */
  isFalling(): boolean {
    return this.splineflags.falling;
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::isBoarding */
  isBoarding(): boolean {
    return this.splineflags.transportEnter || this.splineflags.transportExit;
  }
  /** `Vector3 FinalDestination() const` (a copy) @ac game/Movement/Spline/MoveSpline.h MoveSpline::FinalDestination */
  finalDestination(): Vector3 {
    return this.initialized() ? this.spline.getPoint(this.spline.last()).clone() : new Vector3();
  }
  /** `Vector3 CurrentDestination() const` (a copy) @ac game/Movement/Spline/MoveSpline.h MoveSpline::CurrentDestination */
  currentDestination(): Vector3 {
    return this.initialized() ? this.spline.getPoint(this.point_Idx + 1).clone() : new Vector3();
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::MaxPathIdx */
  maxPathIdx(): number {
    return this.spline.last() - 1;
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::HasAnimation */
  hasAnimation(): boolean {
    return this.splineflags.animation;
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::GetAnimationType */
  getAnimationType(): number {
    return this.splineflags.animId;
  }
  /** @ac game/Movement/Spline/MoveSpline.h MoveSpline::HasStarted */
  hasStarted(): boolean {
    return this.time_passed > 0;
  }
}

/** Default `std::ostream` formatting of a float (6 significant digits). */
function stream(n: number): string {
  return String(Number(n.toPrecision(6)));
}
