/**
 * Port of `game/Movement/Spline/MoveSplineInitArgs.h`, plus `MoveSplineInitArgs::Validate` and `_checkPathBounds`
 * (defined in `MoveSpline.cpp`).
 *
 * `FacingInfo` is a C++ union (`{x, y, z}`, `uint64 target`, `float angle` over the same bytes). Here the three views are
 * separate fields; the code reads the one that the `final_*` spline flag selects, so the overlap is never observed.
 */
import { logError } from "../../../log.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { MoveSplineFlag } from "./MoveSplineFlag.ts";

const fround = Math.fround;

/** @ac game/Movement/Spline/MoveSplineInitArgs.h Movement::PointsArray */
export type PointsArray = Vector3[];

/** @ac game/Movement/Spline/MoveSplineInitArgs.h Movement::FacingInfo */
export class FacingInfo {
  /** `struct { float x, y, z; } f` (the facing point) */
  f = { x: 0, y: 0, z: 0 };
  /** `uint64 target` (the raw guid) */
  target = 0n;
  /** `float angle` */
  angle = 0;

  /** `FacingInfo(float o)` / `FacingInfo(uint64 t)` / `FacingInfo()` */
  constructor(value?: number | bigint) {
    if (typeof value === "number") this.angle = fround(value);
    else if (typeof value === "bigint") this.target = value;
  }

  /** Copy construction / assignment. */
  clone(): FacingInfo {
    const out = new FacingInfo();
    out.f = { x: this.f.x, y: this.f.y, z: this.f.z };
    out.target = this.target;
    out.angle = this.angle;
    return out;
  }
}

/** The members of `Unit` `MoveSplineInitArgs::Validate` reads (`unit->GetGUID().ToString()` for the log). */
export interface MoveSplineArgsUnit {
  /** @ac game/Entities/Object/Object.h Object::GetGUID */
  getGUID(): bigint;
}

/** @ac game/Movement/Spline/MoveSplineInitArgs.h Movement::MoveSplineInitArgs */
export class MoveSplineInitArgs {
  path: PointsArray = [];
  facing = new FacingInfo();
  flags = new MoveSplineFlag();
  path_Idx_offset = 0;
  velocity = 0.0;
  parabolic_amplitude = 0.0;
  time_perc = 0.0;
  splineId = 0;
  initialOrientation = 0.0;
  HasVelocity = false;
  TransformForTransport = true;
  walk = false;

  /** `MoveSplineInitArgs(std::size_t path_capacity = 16)` (`path.reserve`: nothing to reserve) */
  constructor(_path_capacity = 16) {}

  /**
   * Returns true to show that the arguments were configured correctly and MoveSpline initialization will succeed.
   * @ac game/Movement/Spline/MoveSpline.cpp MoveSplineInitArgs::Validate
   */
  Validate(unit: MoveSplineArgsUnit | null): boolean {
    const CHECK = (ok: boolean, expr: string): boolean => {
      if (!ok) {
        if (unit) logError("movement", `MoveSplineInitArgs::Validate: expression '${expr}' failed for ${unit.getGUID()}`);
        else logError("movement", `MoveSplineInitArgs::Validate: expression '${expr}' failed for cyclic spline continuation`);
        return false;
      }
      return true;
    };
    if (!CHECK(this.path.length > 1, "path.size() > 1")) return false;
    if (!CHECK(fround(this.velocity) > fround(0.01), "velocity > 0.01f")) return false;
    if (!CHECK(this.time_perc >= 0.0 && this.time_perc <= 1.0, "time_perc >= 0.f && time_perc <= 1.f")) return false;
    //CHECK(_checkPathBounds());
    return true;
  }

  /**
   * MONSTER_MOVE packet format limitation for not CatmullRom movement: each vertex offset packed into 11 bytes
   * @ac game/Movement/Spline/MoveSpline.cpp MoveSplineInitArgs::_checkPathBounds
   */
  _checkPathBounds(): boolean {
    if (!this.flags.hasFlag(MoveSplineFlag.Mask_CatmullRom) && this.path.length > 2) {
      const MAX_OFFSET = (1 << 11) / 2;
      const front = this.path[0]!;
      const back = this.path[this.path.length - 1]!;
      // Vector3 middle = (path.front() + path.back()) / 2
      const mx = fround(fround(front.x + back.x) * 0.5);
      const my = fround(fround(front.y + back.y) * 0.5);
      const mz = fround(fround(front.z + back.z) * 0.5);
      for (let i = 1; i < this.path.length - 1; ++i) {
        const p = this.path[i]!;
        const ox = fround(p.x - mx);
        const oy = fround(p.y - my);
        const oz = fround(p.z - mz);
        if (Math.abs(ox) >= MAX_OFFSET || Math.abs(oy) >= MAX_OFFSET || Math.abs(oz) >= MAX_OFFSET) {
          logError("movement", "MoveSplineInitArgs::_checkPathBounds check failed");
          return false;
        }
      }
    }
    return true;
  }
}
