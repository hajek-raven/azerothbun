/**
 * The subset of G3D (`deps/g3dlite`) that `Doodad::ExtractSet` uses: `Matrix3` (from a `Quat`, `fromEulerAnglesZYX`,
 * `operator*`, `toEulerAnglesXYZ`), `Quat::unitize` and `toRadians` / `toDegrees`. G3D's `float` arithmetic is
 * float32, so every operation rounds with `Math.fround` where the C++ stores or combines floats.
 *
 * The extractor keeps its own copy (instead of `src/math/`) so the raw dump does not depend on the runtime math
 * port; the values they compute are the same.
 */
const f = Math.fround;

/** `G3D::pi()` is the truncated 3.1415926535898, not `Math.PI`. */
const PI = 3.1415926535898;
/** `G3D::halfPi()`. */
const HALF_PI = 1.57079633;

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::toRadians (the float overload) */
export function toRadians(deg: number): number {
  return f(f(deg * f(PI)) / 180);
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::toDegrees (the float overload) */
export function toDegrees(rad: number): number {
  return f(f(rad * 180) / f(PI));
}

/** `G3D::Matrix3`, row major `elt[row][col]` in a Float32Array(9). */
export class Matrix3 {
  readonly elt = new Float32Array(9);

  /** @ac deps/g3dlite/source/Matrix3.cpp Matrix3::Matrix3(const Quat&) */
  static fromQuat(qx: number, qy: number, qz: number, qw: number): Matrix3 {
    // q.unitize(): *this *= rsq(dot(*this))
    const dot = f(f(f(f(qx * qx) + f(qy * qy)) + f(qz * qz)) + f(qw * qw));
    const s = f(1 / f(Math.sqrt(dot)));
    const x = f(qx * s);
    const y = f(qy * s);
    const z = f(qz * s);
    const w = f(qw * s);
    const xx = f(f(2 * x) * x);
    const xy = f(f(2 * x) * y);
    const xz = f(f(2 * x) * z);
    const xw = f(f(2 * x) * w);
    const yy = f(f(2 * y) * y);
    const yz = f(f(2 * y) * z);
    const yw = f(f(2 * y) * w);
    const zz = f(f(2 * z) * z);
    const zw = f(f(2 * z) * w);
    const m = new Matrix3();
    m.elt.set([
      f(f(1 - yy) - zz),
      f(xy - zw),
      f(xz + yw),
      f(xy + zw),
      f(f(1 - xx) - zz),
      f(yz - xw),
      f(xz - yw),
      f(yz + xw),
      f(f(1 - xx) - yy),
    ]);
    return m;
  }

  /** @ac deps/g3dlite/source/Matrix3.cpp Matrix3::fromEulerAnglesZYX */
  static fromEulerAnglesZYX(fYAngle: number, fPAngle: number, fRAngle: number): Matrix3 {
    let cos = f(Math.cos(fYAngle));
    let sin = f(Math.sin(fYAngle));
    const kZMat = new Matrix3();
    kZMat.elt.set([cos, -sin, 0, sin, cos, 0, 0, 0, 1]);

    cos = f(Math.cos(fPAngle));
    sin = f(Math.sin(fPAngle));
    const kYMat = new Matrix3();
    kYMat.elt.set([cos, 0, sin, 0, 1, 0, -sin, 0, cos]);

    cos = f(Math.cos(fRAngle));
    sin = f(Math.sin(fRAngle));
    const kXMat = new Matrix3();
    kXMat.elt.set([1, 0, 0, 0, cos, -sin, 0, sin, cos]);

    return kZMat.mul(kYMat.mul(kXMat));
  }

  /** @ac deps/g3dlite/source/Matrix3.cpp Matrix3::operator*(const Matrix3&) */
  mul(other: Matrix3): Matrix3 {
    const out = new Matrix3();
    const a = this.elt;
    const b = other.elt;
    for (let row = 0; row < 3; ++row) {
      for (let col = 0; col < 3; ++col) {
        out.elt[row * 3 + col] = f(
          f(f(a[row * 3]! * b[col]!) + f(a[row * 3 + 1]! * b[3 + col]!)) + f(a[row * 3 + 2]! * b[6 + col]!),
        );
      }
    }
    return out;
  }

  /** @ac deps/g3dlite/include/G3D/Matrix3.h Matrix3::operator*(const Vector3&) */
  mulVec(x: number, y: number, z: number, out: Float32Array): void {
    const a = this.elt;
    for (let row = 0; row < 3; ++row) {
      out[row] = f(f(f(a[row * 3]! * x) + f(a[row * 3 + 1]! * y)) + f(a[row * 3 + 2]! * z));
    }
  }

  /**
   * @ac deps/g3dlite/source/Matrix3.cpp Matrix3::toEulerAnglesXYZ
   * @returns the (x, y, z) angles in radians
   */
  toEulerAnglesXYZ(out: Float32Array): boolean {
    const e = this.elt;
    // rot =  cy*cz          -cy*sz           sy
    //        cz*sx*sy+cx*sz  cx*cz-sx*sy*sz -cy*sx
    //       -cx*cz*sy+sx*sz  cz*sx+cx*sy*sz  cx*cy
    if (e[2]! < 1) {
      if (e[2]! > -1) {
        out[0] = f(Math.atan2(-e[5]!, e[8]!));
        out[1] = f(aSin(e[2]!));
        out[2] = f(Math.atan2(-e[1]!, e[0]!));
        return true;
      }
      // WARNING.  Not unique.  XA - ZA = -atan2(r10,r11)
      out[0] = -f(Math.atan2(e[3]!, e[4]!));
      out[1] = -f(HALF_PI);
      out[2] = 0;
      return false;
    }
    // WARNING.  Not unique.  XAngle + ZAngle = atan2(r10,r11)
    out[0] = f(Math.atan2(e[3]!, e[4]!));
    out[1] = f(HALF_PI);
    out[2] = 0;
    return false;
  }
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::aSin */
function aSin(value: number): number {
  if (-1 < value) {
    if (value < 1) {
      return Math.asin(value);
    }
    return -HALF_PI;
  }
  return HALF_PI;
}
