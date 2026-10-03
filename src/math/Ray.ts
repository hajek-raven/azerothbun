import type { AABox } from "./AABox.ts";
import { AABoxHit, collisionTimeForMovingPointFixedAABox } from "./CollisionDetection.ts";
import { Vector3, type Point3 } from "./Vector3.ts";

const boxHit = new AABoxHit();

/**
 * `G3D::Ray`: origin, unit direction and the cached inverse direction.
 *
 * The ray slope classification that G3D also precomputes in `set` (`ibyj`, `c_xy`, ...) feeds only
 * `Intersect::rayAABox`, which the Collision code does not call, so it is not kept.
 *
 * The vectors are owned by the ray. `set` / `setXYZ` copy into them, so a scratch ray can be reused
 * without allocating.
 *
 * @ac deps/g3dlite/include/G3D/Ray.h G3D::Ray
 */
export class Ray {
  private readonly m_origin = new Vector3();
  private readonly m_direction = new Vector3(1, 0, 0);
  private readonly m_invDirection = new Vector3(1, Infinity, Infinity);

  /** `Ray()` is origin zero, direction unit X. `Ray(origin, direction)` copies both. */
  constructor(origin?: Point3, direction?: Vector3) {
    if (origin && direction) this.set(origin, direction);
  }

  /** @ac deps/g3dlite/source/Ray.cpp G3D::Ray::set */
  set(origin: Point3, direction: Vector3): this {
    return this.setXYZ(origin.x, origin.y, origin.z, direction.x, direction.y, direction.z);
  }

  /** `set` on raw components. */
  setXYZ(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): this {
    this.m_origin.set(ox, oy, oz);
    this.m_direction.set(dx, dy, dz);
    this.m_invDirection.set(1 / dx, 1 / dy, 1 / dz);
    return this;
  }

  /** @ac deps/g3dlite/include/G3D/Ray.h G3D::Ray::origin */
  origin(): Point3 {
    return this.m_origin;
  }

  /** @ac deps/g3dlite/include/G3D/Ray.h G3D::Ray::direction */
  direction(): Vector3 {
    return this.m_direction;
  }

  /** @ac deps/g3dlite/include/G3D/Ray.h G3D::Ray::invDirection */
  invDirection(): Vector3 {
    return this.m_invDirection;
  }

  /** @ac deps/g3dlite/include/G3D/Ray.h G3D::Ray::fromOriginAndDirection */
  static fromOriginAndDirection(point: Point3, direction: Vector3): Ray {
    return new Ray(point, direction);
  }

  /** @ac deps/g3dlite/include/G3D/Ray.h G3D::Ray::bumpedRay */
  bumpedRay(distance: number): Ray {
    return this.bumpedRayTo(distance, new Ray());
  }

  /** `bumpedRay(distance)` written into `out` (must not be `this`). */
  bumpedRayTo(distance: number, out: Ray): Ray {
    const o = this.m_origin;
    const d = this.m_direction;
    return out.setXYZ(o.x + d.x * distance, o.y + d.y * distance, o.z + d.z * distance, d.x, d.y, d.z);
  }

  /**
   * Distance to `box` along the ray: 0 when the origin is inside, `Infinity` on a miss.
   *
   * @ac deps/g3dlite/source/Ray.cpp G3D::Ray::intersectionTime (AABox overload)
   */
  intersectionTime(box: AABox): number {
    const o = this.m_origin;
    const d = this.m_direction;
    const time = collisionTimeForMovingPointFixedAABox(o.x, o.y, o.z, d.x, d.y, d.z, box, boxHit);
    if (time === Infinity && boxHit.inside) return 0;
    return time;
  }
}
