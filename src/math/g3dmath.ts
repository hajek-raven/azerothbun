/**
 * The scalar helpers of `G3D/g3dmath.h` that the Collision code uses.
 *
 * G3D has two overload sets: `fuzzyEq(float, float)` uses the 32 bit epsilon, while `fuzzyNe` and
 * `fuzzyGt` only exist for `double` (a `float` argument is promoted), so they use the 64 bit epsilon.
 * The TypeScript names keep that split: `fuzzyEq` is the float overload, `fuzzyEq64` the double one.
 */

/** @ac deps/g3dlite/include/G3D/g3dmath.h fuzzyEpsilon64 */
export const fuzzyEpsilon64 = 0.0000005;
/** @ac deps/g3dlite/include/G3D/g3dmath.h fuzzyEpsilon32 */
export const fuzzyEpsilon32 = Math.fround(0.00001);

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::inf */
export function inf(): number {
  return Infinity;
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::finf */
export function finf(): number {
  return Infinity;
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::nan */
export function nan(): number {
  return NaN;
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::fnan */
export function fnan(): number {
  return NaN;
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::pi */
export function pi(): number {
  return Math.PI;
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::pif */
export function pif(): number {
  return Math.fround(Math.PI);
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::isNaN */
export function isNaN(x: number): boolean {
  return x !== x;
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::isFinite */
export function isFinite(x: number): boolean {
  return Number.isFinite(x);
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::eps (float overload) */
export function eps(a: number, _b: number): number {
  const aa = Math.fround(Math.fround(Math.abs(a)) + 1);
  if (aa === Infinity) return fuzzyEpsilon32;
  return Math.fround(fuzzyEpsilon32 * aa);
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::eps (double overload) */
export function eps64(a: number, _b: number): number {
  const aa = Math.abs(a) + 1;
  if (aa === Infinity) return fuzzyEpsilon64;
  return fuzzyEpsilon64 * aa;
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::fuzzyEq (float overload) */
export function fuzzyEq(a: number, b: number): boolean {
  return a === b || Math.abs(Math.fround(a - b)) <= eps(a, b);
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::fuzzyEq (double overload) */
export function fuzzyEq64(a: number, b: number): boolean {
  return a === b || Math.abs(a - b) <= eps64(a, b);
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::fuzzyNe (double only) */
export function fuzzyNe(a: number, b: number): boolean {
  return !fuzzyEq64(a, b);
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::fuzzyGt (double only) */
export function fuzzyGt(a: number, b: number): boolean {
  return a > b + eps64(a, b);
}

/** @ac deps/g3dlite/include/G3D/g3dmath.h G3D::fuzzyGe (double only) */
export function fuzzyGe(a: number, b: number): boolean {
  return a > b - eps64(a, b);
}

/** `std::min<float>(x, y)`: `(y < x) ? y : x`, which keeps `x` when either side is NaN. */
export function stdMin(x: number, y: number): number {
  return y < x ? y : x;
}

/** `std::max<float>(x, y)`: `(x < y) ? y : x`, which keeps `x` when either side is NaN. */
export function stdMax(x: number, y: number): number {
  return x < y ? y : x;
}

const bitsF32 = new Float32Array(1);
const bitsU32 = new Uint32Array(bitsF32.buffer);

/** True when the IEEE single sign bit of `x` is set (`IR(x) & 0x80000000`). Covers `-0`. */
export function floatSignBit(x: number): boolean {
  bitsF32[0] = x;
  return (bitsU32[0]! & 0x80000000) !== 0;
}

/** True when the IEEE single bits of `x` are not all zero (`IR(x) != 0`), so `-0` counts as non zero. */
export function floatBitsNonZero(x: number): boolean {
  bitsF32[0] = x;
  return bitsU32[0]! !== 0;
}
