import type { AABox } from "./AABox.ts";
import { floatBitsNonZero, floatSignBit } from "./g3dmath.ts";
import { Vector3 } from "./Vector3.ts";

/**
 * The ray / box test of `G3D::CollisionDetection` that `Ray::intersectionTime(AABox)` uses.
 * Only this pair of functions is ported; the rest of `CollisionDetection` is not used by the Collision code.
 */

/** Output of the moving point / box test. Reused by callers so the test does not allocate. */
export class AABoxHit {
  readonly location = new Vector3();
  inside = false;
  readonly normal = new Vector3();
}

const maxT = new Float64Array(3);
const loc = new Float64Array(3);

/**
 * Writes the entry point of the ray `origin + t * dir` into `hit.location` and returns true when it hits
 * `box` from outside. Returns false with `hit.inside` set when the origin is inside the box.
 *
 * `IR(dir[i])` (the raw float bits are not zero) treats `-0` as non zero, and the final sign test
 * `IR(MaxT) & 0x80000000` treats `-0` as negative; both are kept.
 *
 * @ac deps/g3dlite/source/CollisionDetection.cpp G3D::CollisionDetection::collisionLocationForMovingPointFixedAABox
 */
export function collisionLocationForMovingPointFixedAABox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  box: AABox,
  hit: AABoxHit,
): boolean {
  let inside = true;
  const lo = box.lo;
  const hi = box.hi;
  maxT[0] = -1; maxT[1] = -1; maxT[2] = -1;
  loc[0] = hit.location.x; loc[1] = hit.location.y; loc[2] = hit.location.z;

  for (let i = 0; i < 3; ++i) {
    const o = i === 0 ? ox : i === 1 ? oy : oz;
    const d = i === 0 ? dx : i === 1 ? dy : dz;
    const minB = i === 0 ? lo.x : i === 1 ? lo.y : lo.z;
    const maxB = i === 0 ? hi.x : i === 1 ? hi.y : hi.z;
    if (o < minB) {
      loc[i] = minB;
      inside = false;
      if (floatBitsNonZero(d)) maxT[i] = (minB - o) / d;
    } else if (o > maxB) {
      loc[i] = maxB;
      inside = false;
      if (floatBitsNonZero(d)) maxT[i] = (maxB - o) / d;
    }
  }

  hit.inside = inside;
  if (inside) {
    hit.location.set(ox, oy, oz);
    return false;
  }

  let whichPlane = 0;
  if (maxT[1]! > maxT[whichPlane]!) whichPlane = 1;
  if (maxT[2]! > maxT[whichPlane]!) whichPlane = 2;

  if (floatSignBit(maxT[whichPlane]!)) {
    hit.location.set(loc[0]!, loc[1]!, loc[2]!);
    return false;
  }

  const t = maxT[whichPlane]!;
  for (let i = 0; i < 3; ++i) {
    if (i === whichPlane) continue;
    const o = i === 0 ? ox : i === 1 ? oy : oz;
    const d = i === 0 ? dx : i === 1 ? dy : dz;
    const v = o + t * d;
    loc[i] = v;
    const minB = i === 0 ? lo.x : i === 1 ? lo.y : lo.z;
    const maxB = i === 0 ? hi.x : i === 1 ? hi.y : hi.z;
    if (v < minB || v > maxB) {
      hit.location.set(loc[0]!, loc[1]!, loc[2]!);
      return false;
    }
  }

  hit.location.set(loc[0]!, loc[1]!, loc[2]!);
  hit.normal.set(0, 0, 0);
  hit.normal.setAxis(whichPlane, (whichPlane === 0 ? dx : whichPlane === 1 ? dy : dz) > 0 ? -1 : 1);
  return true;
}

/**
 * Distance from `origin` to the entry point, or `Infinity` on a miss and when the origin is inside
 * (`hit.inside` tells the two apart).
 *
 * @ac deps/g3dlite/source/CollisionDetection.cpp G3D::CollisionDetection::collisionTimeForMovingPointFixedAABox
 */
export function collisionTimeForMovingPointFixedAABox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  box: AABox,
  hit: AABoxHit,
): number {
  if (collisionLocationForMovingPointFixedAABox(ox, oy, oz, dx, dy, dz, box, hit)) {
    const lx = hit.location.x - ox;
    const ly = hit.location.y - oy;
    const lz = hit.location.z - oz;
    return Math.sqrt(lx * lx + ly * ly + lz * lz);
  }
  return Infinity;
}
