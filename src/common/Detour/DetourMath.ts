/**
 * Port of `deps/recastnavigation/Detour/Include/DetourMath.h`: thin wrappers over the math library.
 * Runtime queries compute in doubles (see `docs/maps-port.md`, rule 4); values stored in `Float32Array`s are
 * rounded to `float` the way the C++ stores them.
 */

/** @ac deps/recastnavigation/Detour/Include/DetourMath.h dtMathFabsf */
export function dtMathFabsf(x: number): number {
  return Math.abs(x);
}

/** @ac deps/recastnavigation/Detour/Include/DetourMath.h dtMathSqrtf */
export function dtMathSqrtf(x: number): number {
  return Math.sqrt(x);
}

/** @ac deps/recastnavigation/Detour/Include/DetourMath.h dtMathFloorf */
export function dtMathFloorf(x: number): number {
  return Math.floor(x);
}

/** @ac deps/recastnavigation/Detour/Include/DetourMath.h dtMathCeilf */
export function dtMathCeilf(x: number): number {
  return Math.ceil(x);
}

/** @ac deps/recastnavigation/Detour/Include/DetourMath.h dtMathCosf */
export function dtMathCosf(x: number): number {
  return Math.cos(x);
}

/** @ac deps/recastnavigation/Detour/Include/DetourMath.h dtMathSinf */
export function dtMathSinf(x: number): number {
  return Math.sin(x);
}

/** @ac deps/recastnavigation/Detour/Include/DetourMath.h dtMathAtan2f */
export function dtMathAtan2f(y: number, x: number): number {
  return Math.atan2(y, x);
}

/** @ac deps/recastnavigation/Detour/Include/DetourMath.h dtMathIsfinite */
export function dtMathIsfinite(x: number): boolean {
  return Number.isFinite(x);
}
