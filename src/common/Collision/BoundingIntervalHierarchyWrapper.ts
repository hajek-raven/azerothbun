import type { AABox } from "../../math/AABox.ts";
import type { Ray } from "../../math/Ray.ts";
import type { Vector3 } from "../../math/Vector3.ts";
import { BIH, type BIHPointCallback, type BIHRayCallback, type FloatRef } from "./BoundingIntervalHierarchy.ts";

/** The ray functor `BIHWrap` forwards to: `bool operator()(Ray const&, T const&, float& maxDist, bool stopAtFirstHit)`. */
export interface BIHWrapRayCallback<T> {
  onRayObject(ray: Ray, obj: T, maxDist: FloatRef, stopAtFirstHit: boolean): boolean;
}

/** The point functor `BIHWrap` forwards to: `void operator()(Vector3 const&, T const&)`. */
export interface BIHWrapPointCallback<T> {
  onPointObject(point: Vector3, obj: T): void;
}

/**
 * Maps BIH object indices back to the wrapped objects.
 *
 * @ac common/Collision/BoundingIntervalHierarchyWrapper.h BIHWrap::MDLCallback
 */
class MDLCallback<T> implements BIHRayCallback, BIHPointCallback {
  objects: (T | null)[] = [];
  objects_size = 0;
  rayCallback: BIHWrapRayCallback<T> | null = null;
  pointCallback: BIHWrapPointCallback<T> | null = null;

  /** Intersect ray */
  onRay(ray: Ray, idx: number, maxDist: FloatRef, stopAtFirstHit: boolean): boolean {
    if (idx >= this.objects_size) return false;
    const obj = this.objects[idx];
    if (obj) return this.rayCallback!.onRayObject(ray, obj, maxDist, stopAtFirstHit);
    return false;
  }

  /** Intersect point */
  onPoint(p: Vector3, idx: number): void {
    if (idx >= this.objects_size) return;
    const obj = this.objects[idx];
    if (obj) this.pointCallback!.onPointObject(p, obj);
  }
}

/**
 * A BIH over a changing set of objects, rebuilt lazily (`balance`) after inserts and removes.
 *
 * As in the C++, `balance` never fills `m_obj2Idx` and never clears `m_objects_to_push`, so the set of
 * pushed objects is the live set: `remove` drops an object from it, and every rebuild uses all of it.
 *
 * @ac common/Collision/BoundingIntervalHierarchyWrapper.h BIHWrap
 */
export class BIHWrap<T extends object> {
  private readonly m_tree = new BIH();
  private m_objects: (T | null)[] = [];
  private readonly m_obj2Idx = new Map<T, number>();
  private readonly m_objects_to_push = new Set<T>();
  private unbalanced_times = 0;
  private readonly callback = new MDLCallback<T>();

  /** `BoundsFunc::GetBounds2` is passed in. */
  constructor(private readonly getBounds: (obj: T, out: AABox) => void) {}

  /** @ac common/Collision/BoundingIntervalHierarchyWrapper.h BIHWrap::insert */
  insert(obj: T): void {
    ++this.unbalanced_times;
    this.m_objects_to_push.add(obj);
  }

  /** @ac common/Collision/BoundingIntervalHierarchyWrapper.h BIHWrap::remove */
  remove(obj: T): void {
    ++this.unbalanced_times;
    const Idx = this.m_obj2Idx.get(obj);
    if (Idx !== undefined) {
      this.m_obj2Idx.delete(obj);
      this.m_objects[Idx] = null;
    } else {
      this.m_objects_to_push.delete(obj);
    }
  }

  /** @ac common/Collision/BoundingIntervalHierarchyWrapper.h BIHWrap::balance */
  balance(): void {
    if (this.unbalanced_times === 0) return;

    this.unbalanced_times = 0;
    this.m_objects = [];
    for (const key of this.m_obj2Idx.keys()) this.m_objects.push(key);
    for (const member of this.m_objects_to_push) this.m_objects.push(member);
    //assert that m_obj2Idx has all the keys

    this.m_tree.build(this.m_objects as T[], this.getBounds);
  }

  /** @ac common/Collision/BoundingIntervalHierarchyWrapper.h BIHWrap::intersectRay */
  intersectRay(ray: Ray, intersectCallback: BIHWrapRayCallback<T>, maxDist: FloatRef, stopAtFirstHit: boolean): void {
    this.balance();
    const cb = this.callback;
    cb.objects = this.m_objects;
    cb.objects_size = this.m_objects.length;
    cb.rayCallback = intersectCallback;
    this.m_tree.intersectRay(ray, cb, maxDist, stopAtFirstHit);
  }

  /** @ac common/Collision/BoundingIntervalHierarchyWrapper.h BIHWrap::intersectPoint */
  intersectPoint(point: Vector3, intersectCallback: BIHWrapPointCallback<T>): void {
    this.balance();
    const cb = this.callback;
    cb.objects = this.m_objects;
    cb.objects_size = this.m_objects.length;
    cb.pointCallback = intersectCallback;
    this.m_tree.intersectPoint(point, cb);
  }
}
