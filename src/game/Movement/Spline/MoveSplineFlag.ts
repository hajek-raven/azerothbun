/**
 * Port of `game/Movement/Spline/MoveSplineFlag.h` (and `MoveSplineFlag::ToString` from `MovementUtil.cpp`).
 *
 * The C++ class is a packed 32 bit word with bit fields over it. Here `raw()` is the `uint32` and every bit field
 * (`animId`, `done`, `falling`, ... `unknown13`) is a property that reads and writes its bits, so `flags.done = true`
 * and `flags.canSwim` work as in C++. The `eFlags` enum is a set of static constants on the class
 * (`MoveSplineFlag.Done`, `MoveSplineFlag.Mask_Final_Facing`, ...).
 *
 * C++ operators map to methods: `operator&` is `and`, `operator|` is `or`, `operator&=` is `andAssign`, `operator|=` is
 * `orAssign`, copy construction and assignment are `clone()` / `assign()`.
 */
import { g_SplineFlag_names, print_flags } from "./MovementUtil.ts";

/** The bit fields of `MoveSplineFlag` (every bit above the animation byte). */
export interface MoveSplineFlag {
  /** `uint8 animId : 8` (the low byte, an animation id stored in pair with the `Animation` flag) */
  animId: number;
  done: boolean;
  falling: boolean;
  no_spline: boolean;
  parabolic: boolean;
  canSwim: boolean;
  flying: boolean;
  orientationFixed: boolean;
  final_point: boolean;
  final_target: boolean;
  final_angle: boolean;
  catmullrom: boolean;
  cyclic: boolean;
  enter_cycle: boolean;
  animation: boolean;
  frozen: boolean;
  transportEnter: boolean;
  transportExit: boolean;
  unknown7: boolean;
  unknown8: boolean;
  orientationInversed: boolean;
  unknown10: boolean;
  unknown11: boolean;
  unknown12: boolean;
  unknown13: boolean;
}

/** @ac game/Movement/Spline/MoveSplineFlag.h Movement::MoveSplineFlag */
export class MoveSplineFlag {
  // enum eFlags
  static readonly None = 0x00000000;
  // x00-xFF(first byte) used as animation Ids storage in pair with Animation flag
  static readonly Done = 0x00000100;
  /** Affects elevation computation, can't be combined with Parabolic flag */
  static readonly Falling = 0x00000200;
  static readonly No_Spline = 0x00000400;
  /** Affects elevation computation, can't be combined with Falling flag */
  static readonly Parabolic = 0x00000800;
  static readonly CanSwim = 0x00001000;
  /** Smooth movement(Catmullrom interpolation mode), flying animation */
  static readonly Flying = 0x00002000;
  /** Model orientation fixed */
  static readonly OrientationFixed = 0x00004000;
  static readonly Final_Point = 0x00008000;
  static readonly Final_Target = 0x00010000;
  static readonly Final_Angle = 0x00020000;
  /** Used Catmullrom interpolation mode */
  static readonly Catmullrom = 0x00040000;
  /** Movement by cycled spline */
  static readonly Cyclic = 0x00080000;
  /** Everytimes appears with cyclic flag in monster move packet, erases first spline vertex after first cycle done */
  static readonly Enter_Cycle = 0x00100000;
  /** Plays animation after some time passed */
  static readonly Animation = 0x00200000;
  /** Will never arrive */
  static readonly Frozen = 0x00400000;
  static readonly TransportEnter = 0x00800000;
  static readonly TransportExit = 0x01000000;
  static readonly Unknown7 = 0x02000000;
  static readonly Unknown8 = 0x04000000;
  static readonly OrientationInversed = 0x08000000;
  static readonly Unknown10 = 0x10000000;
  static readonly Unknown11 = 0x20000000;
  static readonly Unknown12 = 0x40000000;
  static readonly Unknown13 = 0x80000000;

  // Masks
  static readonly Mask_Final_Facing = (MoveSplineFlag.Final_Point | MoveSplineFlag.Final_Target | MoveSplineFlag.Final_Angle) >>> 0;
  /** animation ids stored here, see AnimType enum, used with Animation flag */
  static readonly Mask_Animations = 0xff;
  /** flags that shouldn't be appended into SMSG_MONSTER_MOVE\SMSG_MONSTER_MOVE_TRANSPORT packet, should be more probably */
  static readonly Mask_No_Monster_Move = (MoveSplineFlag.Mask_Final_Facing | MoveSplineFlag.Mask_Animations | MoveSplineFlag.Done) >>> 0;
  /** CatmullRom interpolation mode used */
  static readonly Mask_CatmullRom = (MoveSplineFlag.Flying | MoveSplineFlag.Catmullrom) >>> 0;
  /** Unused, not suported flags */
  static readonly Mask_Unused =
    (MoveSplineFlag.No_Spline |
      MoveSplineFlag.Enter_Cycle |
      MoveSplineFlag.Frozen |
      MoveSplineFlag.Unknown7 |
      MoveSplineFlag.Unknown8 |
      MoveSplineFlag.Unknown10 |
      MoveSplineFlag.Unknown11 |
      MoveSplineFlag.Unknown12 |
      MoveSplineFlag.Unknown13) >>>
    0;

  private _raw = 0;

  /** `MoveSplineFlag()` is 0, `MoveSplineFlag(uint32 f)` is `f`. */
  constructor(f = 0) {
    this._raw = f >>> 0;
  }

  /** `MoveSplineFlag(MoveSplineFlag const&)`. */
  clone(): MoveSplineFlag {
    return new MoveSplineFlag(this._raw);
  }

  /** `operator=(MoveSplineFlag const&)`. */
  assign(f: MoveSplineFlag): this {
    this._raw = f._raw;
    return this;
  }

  /** `uint32& raw()` / `uint32 const& raw() const` (read). */
  raw(): number {
    return this._raw;
  }

  /** `raw() = f` (the non-const `raw()` used as an lvalue). */
  setRaw(f: number): void {
    this._raw = f >>> 0;
  }

  // Constant interface

  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::isSmooth */
  isSmooth(): boolean {
    return (this._raw & MoveSplineFlag.Mask_CatmullRom) !== 0;
  }
  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::isLinear */
  isLinear(): boolean {
    return !this.isSmooth();
  }
  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::isFacing */
  isFacing(): boolean {
    return (this._raw & MoveSplineFlag.Mask_Final_Facing) !== 0;
  }

  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::getAnimationId */
  getAnimationId(): number {
    return this.animId;
  }
  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::hasAllFlags */
  hasAllFlags(f: number): boolean {
    return ((this._raw & f) >>> 0) === f >>> 0;
  }
  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::hasFlag */
  hasFlag(f: number): boolean {
    return (this._raw & f) !== 0;
  }
  /** `uint32 operator&(uint32 f) const` @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::operator& */
  and(f: number): number {
    return (this._raw & f) >>> 0;
  }
  /** `uint32 operator|(uint32 f) const` @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::operator| */
  or(f: number): number {
    return (this._raw | f) >>> 0;
  }
  /** @ac game/Movement/Spline/MovementUtil.cpp MoveSplineFlag::ToString */
  toString(): string {
    const str = { value: "" };
    print_flags(this._raw, g_SplineFlag_names, str);
    return str.value;
  }

  // Not constant interface

  /** `void operator&=(uint32 f)` @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::operator&= */
  andAssign(f: number): void {
    this._raw = (this._raw & f) >>> 0;
  }
  /** `void operator|=(uint32 f)` @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::operator|= */
  orAssign(f: number): void {
    this._raw = (this._raw | f) >>> 0;
  }

  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::EnableAnimation */
  enableAnimation(anim: number): void {
    this._raw = (((this._raw & ~(MoveSplineFlag.Mask_Animations | MoveSplineFlag.Falling | MoveSplineFlag.Parabolic)) | MoveSplineFlag.Animation | (anim & 0xff)) >>> 0);
  }
  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::EnableParabolic */
  enableParabolic(): void {
    this._raw = ((this._raw & ~(MoveSplineFlag.Mask_Animations | MoveSplineFlag.Falling | MoveSplineFlag.Animation)) | MoveSplineFlag.Parabolic) >>> 0;
  }
  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::EnableFalling */
  enableFalling(): void {
    this._raw = ((this._raw & ~(MoveSplineFlag.Mask_Animations | MoveSplineFlag.Parabolic | MoveSplineFlag.Flying | MoveSplineFlag.Animation)) | MoveSplineFlag.Falling) >>> 0;
  }
  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::EnableFlying */
  enableFlying(): void {
    this._raw = ((this._raw & ~(MoveSplineFlag.Falling | MoveSplineFlag.Catmullrom)) | MoveSplineFlag.Flying) >>> 0;
  }
  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::EnableCatmullRom */
  enableCatmullRom(): void {
    this._raw = ((this._raw & ~MoveSplineFlag.Flying) | MoveSplineFlag.Catmullrom) >>> 0;
  }
  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::EnableFacingPoint */
  enableFacingPoint(): void {
    this._raw = ((this._raw & ~MoveSplineFlag.Mask_Final_Facing) | MoveSplineFlag.Final_Point) >>> 0;
  }
  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::EnableFacingAngle */
  enableFacingAngle(): void {
    this._raw = ((this._raw & ~MoveSplineFlag.Mask_Final_Facing) | MoveSplineFlag.Final_Angle) >>> 0;
  }
  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::EnableFacingTarget */
  enableFacingTarget(): void {
    this._raw = ((this._raw & ~MoveSplineFlag.Mask_Final_Facing) | MoveSplineFlag.Final_Target) >>> 0;
  }
  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::EnableTransportEnter */
  enableTransportEnter(): void {
    this._raw = ((this._raw & ~MoveSplineFlag.TransportExit) | MoveSplineFlag.TransportEnter) >>> 0;
  }
  /** @ac game/Movement/Spline/MoveSplineFlag.h MoveSplineFlag::EnableTransportExit */
  enableTransportExit(): void {
    this._raw = ((this._raw & ~MoveSplineFlag.TransportEnter) | MoveSplineFlag.TransportExit) >>> 0;
  }
}

/** The single bit fields (`bool name : 1`), in declaration order, each over the bit of the `eFlags` constant. */
const BIT_FIELDS: readonly (readonly [string, number])[] = [
  ["done", MoveSplineFlag.Done],
  ["falling", MoveSplineFlag.Falling],
  ["no_spline", MoveSplineFlag.No_Spline],
  ["parabolic", MoveSplineFlag.Parabolic],
  ["canSwim", MoveSplineFlag.CanSwim],
  ["flying", MoveSplineFlag.Flying],
  ["orientationFixed", MoveSplineFlag.OrientationFixed],
  ["final_point", MoveSplineFlag.Final_Point],
  ["final_target", MoveSplineFlag.Final_Target],
  ["final_angle", MoveSplineFlag.Final_Angle],
  ["catmullrom", MoveSplineFlag.Catmullrom],
  ["cyclic", MoveSplineFlag.Cyclic],
  ["enter_cycle", MoveSplineFlag.Enter_Cycle],
  ["animation", MoveSplineFlag.Animation],
  ["frozen", MoveSplineFlag.Frozen],
  ["transportEnter", MoveSplineFlag.TransportEnter],
  ["transportExit", MoveSplineFlag.TransportExit],
  ["unknown7", MoveSplineFlag.Unknown7],
  ["unknown8", MoveSplineFlag.Unknown8],
  ["orientationInversed", MoveSplineFlag.OrientationInversed],
  ["unknown10", MoveSplineFlag.Unknown10],
  ["unknown11", MoveSplineFlag.Unknown11],
  ["unknown12", MoveSplineFlag.Unknown12],
  ["unknown13", MoveSplineFlag.Unknown13],
];

type FlagInternals = { _raw: number };

for (const [name, bit] of BIT_FIELDS) {
  Object.defineProperty(MoveSplineFlag.prototype, name, {
    get(this: FlagInternals): boolean {
      return (this._raw & bit) !== 0;
    },
    set(this: FlagInternals, value: boolean) {
      this._raw = (value ? this._raw | bit : this._raw & ~bit) >>> 0;
    },
    enumerable: true,
    configurable: true,
  });
}

Object.defineProperty(MoveSplineFlag.prototype, "animId", {
  get(this: FlagInternals): number {
    return this._raw & 0xff;
  },
  set(this: FlagInternals, value: number) {
    this._raw = ((this._raw & ~0xff) | (value & 0xff)) >>> 0;
  },
  enumerable: true,
  configurable: true,
});
