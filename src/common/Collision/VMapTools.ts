import type { AABox } from "../../math/AABox.ts";
import { floatBitsNonZero, floatSignBit } from "../../math/g3dmath.ts";
import type { Ray } from "../../math/Ray.ts";
import { Vector3 } from "../../math/Vector3.ts";

/**
 * The class is mainly taken from G3D/AABSPTree.h but modified to be able to use our internal data
 * structure. This is an iterator that helps us analysing the BSP-Trees. Nothing in the Collision code
 * calls it today; it is kept for parity with the header.
 *
 * @ac common/Collision/VMapTools.h VMAP::IntersectionCallBack
 */
export class IntersectionCallBack<TValue extends { intersect(ray: Ray, distance: { value: number }, stopAtFirstHit: boolean, hitLocation: Vector3, hitNormal: Vector3): void }> {
  closestEntity: TValue | null = null;
  hitLocation = new Vector3();
  hitNormal = new Vector3();

  /** `operator()(Ray const&, TValue const*, bool StopAtFirstHit, float& distance)` */
  call(ray: Ray, entity: TValue, StopAtFirstHit: boolean, distance: { value: number }): void {
    entity.intersect(ray, distance, StopAtFirstHit, this.hitLocation, this.hitNormal);
  }
}

/**
 * The G3D moving point / box test, modified to return true when the origin is inside the box.
 *
 * @ac common/Collision/VMapTools.h VMAP::MyCollisionDetection
 */
export class MyCollisionDetection {
  /**
   * Writes the entry point into `location`; `inside.value` tells whether the origin is in the box.
   *
   * @ac common/Collision/VMapTools.h VMAP::MyCollisionDetection::collisionLocationForMovingPointFixedAABox
   */
  static collisionLocationForMovingPointFixedAABox(
    origin: Vector3,
    dir: Vector3,
    box: AABox,
    location: Vector3,
    Inside: { value: boolean },
  ): boolean {
    Inside.value = true;
    const MinB = box.low();
    const MaxB = box.high();
    const MaxT = [-1, -1, -1];

    // Find candidate planes.
    for (let i = 0; i < 3; ++i) {
      if (origin.get(i) < MinB.get(i)) {
        location.setAxis(i, MinB.get(i));
        Inside.value = false;
        // Calculate T distances to candidate planes
        if (floatBitsNonZero(dir.get(i))) MaxT[i] = (MinB.get(i) - origin.get(i)) / dir.get(i);
      } else if (origin.get(i) > MaxB.get(i)) {
        location.setAxis(i, MaxB.get(i));
        Inside.value = false;
        // Calculate T distances to candidate planes
        if (floatBitsNonZero(dir.get(i))) MaxT[i] = (MaxB.get(i) - origin.get(i)) / dir.get(i);
      }
    }

    if (Inside.value) {
      // definite hit
      location.copy(origin);
      return true;
    }

    // Get largest of the maxT's for final choice of intersection
    let WhichPlane = 0;
    if (MaxT[1]! > MaxT[WhichPlane]!) WhichPlane = 1;
    if (MaxT[2]! > MaxT[WhichPlane]!) WhichPlane = 2;

    // Check final candidate actually inside box
    if (floatSignBit(MaxT[WhichPlane]!)) {
      // Miss the box
      return false;
    }

    for (let i = 0; i < 3; ++i) {
      if (i !== WhichPlane) {
        location.setAxis(i, origin.get(i) + MaxT[WhichPlane]! * dir.get(i));
        if (location.get(i) < MinB.get(i) || location.get(i) > MaxB.get(i)) {
          // On this plane we're outside the box extents, so we miss the box
          return false;
        }
      }
    }
    return true;
  }
}
