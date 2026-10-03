import { Vector3 } from "./Vector3.ts";

/**
 * `G3D::Matrix3`, a row major 3x3 `float` matrix. The elements are a `Float32Array`, so every stored
 * element is rounded to `float` like the C++ `float elt[3][3]`.
 *
 * Only the parts the Collision code uses are ported: `fromEulerAnglesZYX`, `inverse`, the products with a
 * vector from either side, and the matrix product that `fromEulerAnglesZYX` needs.
 *
 * @ac deps/g3dlite/include/G3D/Matrix3.h G3D::Matrix3
 */
export class Matrix3 {
  /** `elt[r][c]` is `elt[r * 3 + c]`. */
  readonly elt = new Float32Array(9);

  /** @ac deps/g3dlite/include/G3D/Matrix3.h G3D::Matrix3::Matrix3 (nine values, row major) */
  constructor(
    e00 = 0, e01 = 0, e02 = 0,
    e10 = 0, e11 = 0, e12 = 0,
    e20 = 0, e21 = 0, e22 = 0,
  ) {
    this.set(e00, e01, e02, e10, e11, e12, e20, e21, e22);
  }

  /** @ac deps/g3dlite/source/Matrix3.cpp G3D::Matrix3::set */
  set(
    e00: number, e01: number, e02: number,
    e10: number, e11: number, e12: number,
    e20: number, e21: number, e22: number,
  ): this {
    const e = this.elt;
    e[0] = e00; e[1] = e01; e[2] = e02;
    e[3] = e10; e[4] = e11; e[5] = e12;
    e[6] = e20; e[7] = e21; e[8] = e22;
    return this;
  }

  /** `operator=`. Returns `this`. */
  copy(m: Matrix3): this {
    this.elt.set(m.elt);
    return this;
  }

  /** @ac deps/g3dlite/source/Matrix3.cpp G3D::Matrix3::zero */
  static zero(): Matrix3 {
    return new Matrix3();
  }

  /** @ac deps/g3dlite/source/Matrix3.cpp G3D::Matrix3::identity */
  static identity(): Matrix3 {
    return new Matrix3(1, 0, 0, 0, 1, 0, 0, 0, 1);
  }

  /** `elt[r][c]`. */
  at(r: number, c: number): number {
    return this.elt[r * 3 + c]!;
  }

  /** @ac deps/g3dlite/source/Matrix3.cpp G3D::Matrix3::operator* (matrix product) */
  mul(m: Matrix3): Matrix3 {
    const out = new Matrix3();
    const a = this.elt;
    const b = m.elt;
    for (let r = 0; r < 3; ++r) {
      for (let c = 0; c < 3; ++c) {
        out.elt[r * 3 + c] = Math.fround(
          Math.fround(Math.fround(a[r * 3]! * b[c]!) + Math.fround(a[r * 3 + 1]! * b[3 + c]!)) + Math.fround(a[r * 3 + 2]! * b[6 + c]!),
        );
      }
    }
    return out;
  }

  /** @ac deps/g3dlite/include/G3D/Matrix3.h G3D::Matrix3::operator* (matrix times column vector) */
  mulVec(v: Vector3): Vector3 {
    return this.mulVecTo(v.x, v.y, v.z, new Vector3());
  }

  /** `M * (x, y, z)` written into `out`. `out` may alias the input vector. */
  mulVecTo(x: number, y: number, z: number, out: Vector3): Vector3 {
    const e = this.elt;
    return out.set(e[0]! * x + e[1]! * y + e[2]! * z, e[3]! * x + e[4]! * y + e[5]! * z, e[6]! * x + e[7]! * y + e[8]! * z);
  }

  /** @ac deps/g3dlite/include/G3D/Matrix3.h G3D::operator*(Vector3 const&, Matrix3 const&) (row vector times matrix) */
  static vecMul(v: Vector3, m: Matrix3): Vector3 {
    return m.vecMulTo(v.x, v.y, v.z, new Vector3());
  }

  /** `(x, y, z) * M` (row vector times this matrix) written into `out`. */
  vecMulTo(x: number, y: number, z: number, out: Vector3): Vector3 {
    const e = this.elt;
    return out.set(x * e[0]! + y * e[3]! + z * e[6]!, x * e[1]! + y * e[4]! + z * e[7]!, x * e[2]! + y * e[5]! + z * e[8]!);
  }

  /**
   * Cofactor inverse. Returns false (and leaves `out` with the cofactors) when the determinant is within
   * `fTolerance` of zero.
   *
   * @ac deps/g3dlite/source/Matrix3.cpp G3D::Matrix3::inverse (bool overload)
   */
  inverseTo(out: Matrix3, fTolerance = 1e-6): boolean {
    const e = this.elt;
    const r = out.elt;
    const e00 = e[0]!, e01 = e[1]!, e02 = e[2]!, e10 = e[3]!, e11 = e[4]!, e12 = e[5]!, e20 = e[6]!, e21 = e[7]!, e22 = e[8]!;
    r[0] = e11 * e22 - e12 * e21;
    r[1] = e02 * e21 - e01 * e22;
    r[2] = e01 * e12 - e02 * e11;
    r[3] = e12 * e20 - e10 * e22;
    r[4] = e00 * e22 - e02 * e20;
    r[5] = e02 * e10 - e00 * e12;
    r[6] = e10 * e21 - e11 * e20;
    r[7] = e01 * e20 - e00 * e21;
    r[8] = e00 * e11 - e01 * e10;
    const fDet = Math.fround(e00 * r[0]! + e01 * r[3]! + e02 * r[6]!);
    if (Math.abs(fDet) <= Math.fround(fTolerance)) return false;
    const fInvDet = Math.fround(1 / fDet);
    for (let i = 0; i < 9; ++i) r[i] = r[i]! * fInvDet;
    return true;
  }

  /** @ac deps/g3dlite/source/Matrix3.cpp G3D::Matrix3::inverse */
  inverse(fTolerance = 1e-6): Matrix3 {
    const kInverse = Matrix3.zero();
    this.inverseTo(kInverse, fTolerance);
    return kInverse;
  }

  /** @ac deps/g3dlite/source/Matrix3.cpp G3D::Matrix3::determinant */
  determinant(): number {
    const e = this.elt;
    const c00 = e[4]! * e[8]! - e[5]! * e[7]!;
    const c10 = e[5]! * e[6]! - e[3]! * e[8]!;
    const c20 = e[3]! * e[7]! - e[4]! * e[6]!;
    return Math.fround(e[0]! * c00 + e[1]! * c10 + e[2]! * c20);
  }

  /** @ac deps/g3dlite/source/Matrix3.cpp G3D::Matrix3::transpose */
  transpose(): Matrix3 {
    const e = this.elt;
    return new Matrix3(e[0], e[3], e[6], e[1], e[4], e[7], e[2], e[5], e[8]);
  }

  /** @ac deps/g3dlite/source/Matrix3.cpp G3D::Matrix3::fromEulerAnglesZYX */
  static fromEulerAnglesZYX(fYAngle: number, fPAngle: number, fRAngle: number): Matrix3 {
    let fCos = Math.fround(Math.cos(fYAngle));
    let fSin = Math.fround(Math.sin(fYAngle));
    const kZMat = new Matrix3(fCos, -fSin, 0, fSin, fCos, 0, 0, 0, 1);

    fCos = Math.fround(Math.cos(fPAngle));
    fSin = Math.fround(Math.sin(fPAngle));
    const kYMat = new Matrix3(fCos, 0, fSin, 0, 1, 0, -fSin, 0, fCos);

    fCos = Math.fround(Math.cos(fRAngle));
    fSin = Math.fround(Math.sin(fRAngle));
    const kXMat = new Matrix3(1, 0, 0, 0, fCos, -fSin, 0, fSin, fCos);

    return kZMat.mul(kYMat.mul(kXMat));
  }
}
