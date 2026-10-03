import { TimeTrackerSmall } from "../../game/time/timer.ts";
import type { AABox } from "../../math/AABox.ts";
import { fuzzyGt } from "../../math/g3dmath.ts";
import { Ray } from "../../math/Ray.ts";
import { Vector3 } from "../../math/Vector3.ts";
import type { FloatRef } from "./BoundingIntervalHierarchy.ts";
import { BIHWrap, type BIHWrapPointCallback, type BIHWrapRayCallback } from "./BoundingIntervalHierarchyWrapper.ts";
import type { AreaAndLiquidData } from "./Management/IVMapMgr.ts";
import { VMapFactory } from "./Management/VMapFactory.ts";
import { LocationInfo } from "./Maps/MapTree.ts";
import type { GameObjectModel } from "./Models/GameObjectModel.ts";
import { ModelIgnoreFlags } from "./Models/ModelIgnoreFlags.ts";
import { RegularGrid2D } from "./RegularGrid.ts";

/** @ac common/Collision/DynamicTree.cpp CHECK_TREE_PERIOD */
const CHECK_TREE_PERIOD = 200;

/** `std::numeric_limits<float>::max()`. */
const FLT_MAX = 3.4028234663852886e38;

type GoRayCallback = BIHWrapRayCallback<GameObjectModel>;
type GoPointCallback = BIHWrapPointCallback<GameObjectModel>;
type GoNode = BIHWrap<GameObjectModel>;

/** `BoundsTrait<GameObjectModel>::GetBounds2`. */
function getBounds2(g: GameObjectModel, out: AABox): void {
  out.copy(g.GetBounds());
}

/**
 * `typedef RegularGrid2D<GameObjectModel, BIHWrap<GameObjectModel>> ParentTree` with the rebalance timer.
 *
 * @ac common/Collision/DynamicTree.cpp DynTreeImpl
 */
class DynTreeImpl extends RegularGrid2D<GameObjectModel, GoRayCallback, GoPointCallback, GoNode> {
  readonly rebalance_timer = new TimeTrackerSmall(CHECK_TREE_PERIOD);
  unbalanced_times = 0;

  constructor() {
    super(() => new BIHWrap<GameObjectModel>(getBounds2));
  }

  /** @ac common/Collision/DynamicTree.cpp DynTreeImpl::insert */
  override insert(mdl: GameObjectModel): void {
    super.insert(mdl);
    ++this.unbalanced_times;
  }

  /** @ac common/Collision/DynamicTree.cpp DynTreeImpl::remove */
  override remove(mdl: GameObjectModel): void {
    super.remove(mdl);
    ++this.unbalanced_times;
  }

  /** @ac common/Collision/DynamicTree.cpp DynTreeImpl::balance */
  override balance(): void {
    super.balance();
    this.unbalanced_times = 0;
  }

  /** @ac common/Collision/DynamicTree.cpp DynTreeImpl::update */
  update(difftime: number): void {
    if (!this.size()) return;

    this.rebalance_timer.update(difftime);
    if (this.rebalance_timer.passed()) {
      this.rebalance_timer.reset(CHECK_TREE_PERIOD);
      if (this.unbalanced_times > 0) this.balance();
    }
  }
}

/** @ac common/Collision/DynamicTree.cpp DynamicTreeIntersectionCallback */
class DynamicTreeIntersectionCallback implements GoRayCallback {
  private _didHit = false;
  private _phaseMask = 0;
  private _ignoreFlags: ModelIgnoreFlags = ModelIgnoreFlags.Nothing;

  reset(phasemask: number, ignoreFlags: ModelIgnoreFlags): this {
    this._didHit = false;
    this._phaseMask = phasemask;
    this._ignoreFlags = ignoreFlags;
    return this;
  }

  onRayObject(r: Ray, obj: GameObjectModel, distance: FloatRef, stopAtFirstHit: boolean): boolean {
    const result = obj.intersectRay(r, distance, stopAtFirstHit, this._phaseMask, this._ignoreFlags);
    if (result) this._didHit = result;
    return result;
  }

  didHit(): boolean {
    return this._didHit;
  }
}

/** @ac common/Collision/DynamicTree.cpp DynamicTreeLocationInfoCallback */
class DynamicTreeLocationInfoCallback implements GoPointCallback {
  private _phaseMask = 0;
  private readonly _locationInfo = new LocationInfo();
  private _hitModel: GameObjectModel | null = null;

  reset(phaseMask: number): this {
    this._phaseMask = phaseMask;
    this._locationInfo.reset();
    this._hitModel = null;
    return this;
  }

  onPointObject(p: Vector3, obj: GameObjectModel): void {
    if (obj.GetLocationInfo(p, this._locationInfo, this._phaseMask)) this._hitModel = obj;
  }

  GetLocationInfo(): LocationInfo {
    return this._locationInfo;
  }

  GetHitModel(): GameObjectModel | null {
    return this._hitModel;
  }
}

const intersectionCallback = new DynamicTreeIntersectionCallback();
const locationInfoCallback = new DynamicTreeLocationInfoCallback();
const scratchRay = new Ray();
const scratchDist: FloatRef = { value: 0 };
const scratchEnd = new Vector3();
const scratchPoint = new Vector3();
const liquidLevel: FloatRef = { value: 0 };

/**
 * Game object collision of one map instance. Positions are world coordinates (no internal conversion,
 * unlike the static tree).
 *
 * @ac common/Collision/DynamicTree.h DynamicMapTree
 * @ac-skip common/Collision/DynamicTree.cpp DynamicMapTree::~DynamicMapTree: memory is garbage collected
 */
export class DynamicMapTree {
  /** @ac common/Collision/DynamicTree.cpp DynamicMapTree::DynamicMapTree */
  private readonly impl = new DynTreeImpl();

  /** @ac common/Collision/DynamicTree.cpp DynamicMapTree::insert */
  insert(mdl: GameObjectModel): void {
    this.impl.insert(mdl);
  }

  /** @ac common/Collision/DynamicTree.cpp DynamicMapTree::remove */
  remove(mdl: GameObjectModel): void {
    this.impl.remove(mdl);
  }

  /** @ac common/Collision/DynamicTree.cpp DynamicMapTree::contains */
  contains(mdl: GameObjectModel): boolean {
    return this.impl.contains(mdl);
  }

  /** @ac common/Collision/DynamicTree.cpp DynamicMapTree::balance */
  balance(): void {
    this.impl.balance();
  }

  /** @ac common/Collision/DynamicTree.cpp DynamicMapTree::size */
  size(): number {
    return this.impl.size();
  }

  /** @ac common/Collision/DynamicTree.cpp DynamicMapTree::update */
  update(t_diff: number): void {
    this.impl.update(t_diff);
  }

  /**
   * Shortens `maxDist` to the nearest hit along the ray up to `endPos` and returns true on a hit.
   *
   * @ac common/Collision/DynamicTree.cpp DynamicMapTree::GetIntersectionTime
   */
  GetIntersectionTime(phasemask: number, ray: Ray, endPos: Vector3, maxDist: FloatRef): boolean {
    scratchDist.value = maxDist.value;
    const callback = intersectionCallback.reset(phasemask, ModelIgnoreFlags.Nothing);
    this.impl.intersectRay(ray, callback, scratchDist, endPos, false);
    if (callback.didHit()) maxDist.value = scratchDist.value;
    return callback.didHit();
  }

  /**
   * When moving from `startPos` to `endPos`, the first game object hit: true with the hit position
   * (moved by `modifyDist` along the path) in `resultHit`, else false with `resultHit = endPos`.
   *
   * @ac common/Collision/DynamicTree.cpp DynamicMapTree::GetObjectHitPos
   */
  GetObjectHitPos(phasemask: number, startPos: Vector3, endPos: Vector3, resultHit: Vector3, modifyDist: number): boolean {
    const dx = endPos.x - startPos.x, dy = endPos.y - startPos.y, dz = endPos.z - startPos.z;
    const maxDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // valid map coords should *never ever* produce float overflow, but this would produce NaNs too
    if (!(maxDist < FLT_MAX)) throw new Error(`ASSERT failed: DynamicMapTree::GetObjectHitPos maxDist ${maxDist} < FLT_MAX`);
    // prevent NaN values which can cause BIH intersection to enter infinite loop
    if (maxDist < 1e-10) {
      resultHit.copy(endPos);
      return false;
    }
    // direction with length of 1
    const inv = 1 / maxDist;
    const dirX = dx * inv, dirY = dy * inv, dirZ = dz * inv;
    const ray = scratchRay.setXYZ(startPos.x, startPos.y, startPos.z, dirX, dirY, dirZ);
    const dist = hitDist;
    dist.value = maxDist;
    if (this.GetIntersectionTime(phasemask, ray, endPos, dist)) {
      let rx = startPos.x + dirX * dist.value, ry = startPos.y + dirY * dist.value, rz = startPos.z + dirZ * dist.value;
      if (modifyDist < 0) {
        const hx = rx - startPos.x, hy = ry - startPos.y, hz = rz - startPos.z;
        if (Math.sqrt(hx * hx + hy * hy + hz * hz) > -modifyDist) {
          rx += dirX * modifyDist;
          ry += dirY * modifyDist;
          rz += dirZ * modifyDist;
        } else {
          rx = startPos.x;
          ry = startPos.y;
          rz = startPos.z;
        }
      } else {
        rx += dirX * modifyDist;
        ry += dirY * modifyDist;
        rz += dirZ * modifyDist;
      }
      resultHit.set(rx, ry, rz);
      return true;
    }
    resultHit.copy(endPos);
    return false;
  }

  /** @ac common/Collision/DynamicTree.cpp DynamicMapTree::isInLineOfSight */
  isInLineOfSight(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, phasemask: number, ignoreFlags: ModelIgnoreFlags): boolean {
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const maxDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (!fuzzyGt(maxDist, 0)) return true;

    const inv = 1 / maxDist;
    const r = scratchRay.setXYZ(x1, y1, z1, dx * inv, dy * inv, dz * inv);
    const callback = intersectionCallback.reset(phasemask, ignoreFlags);
    scratchDist.value = maxDist;
    this.impl.intersectRay(r, callback, scratchDist, scratchEnd.set(x2, y2, z2), true);

    return !callback.didHit();
  }

  /**
   * Height of the first game object surface below `(x, y, z)` within `maxSearchDist`, or `-Infinity`.
   *
   * @ac common/Collision/DynamicTree.cpp DynamicMapTree::getHeight
   */
  getHeight(x: number, y: number, z: number, maxSearchDist: number, phasemask: number): number {
    const r = scratchRay.setXYZ(x, y, z, 0, 0, -1);
    const callback = intersectionCallback.reset(phasemask, ModelIgnoreFlags.Nothing);
    scratchDist.value = maxSearchDist;
    this.impl.intersectZAllignedRay(r, callback, scratchDist);

    if (callback.didHit()) return z - scratchDist.value;
    return -Infinity;
  }

  /**
   * Area and liquid of the game object WMO under `(x, y, z + 0.5)`. `reqLiquidType` is the C++
   * `Optional<uint8>` (null for none). Fills `data` and returns true when a WMO group is found.
   *
   * @ac common/Collision/DynamicTree.cpp DynamicMapTree::GetAreaAndLiquidData
   */
  GetAreaAndLiquidData(x: number, y: number, z: number, phasemask: number, reqLiquidType: number | null, data: AreaAndLiquidData): boolean {
    const v = scratchPoint.set(x, y, z + 0.5);
    const intersectionCallBack = locationInfoCallback.reset(phasemask);
    this.impl.intersectPoint(v, intersectionCallBack);
    const info = intersectionCallBack.GetLocationInfo();
    const hitModel = info.hitModel;
    if (hitModel) {
      data.floorZ = info.ground_Z;
      const liquidType = hitModel.GetLiquidType();
      if (reqLiquidType === null || VMapFactory.createOrGetVMapMgr().GetLiquidFlagsPtr(liquidType) & reqLiquidType) {
        if (intersectionCallBack.GetHitModel()!.GetLiquidLevel(v, info, liquidLevel)) data.emplaceLiquidInfo(liquidType, liquidLevel.value);
      }

      data.emplaceAreaInfo(hitModel.GetWmoID(), 0, info.rootId, hitModel.GetMogpFlags(), 0);
      return true;
    }
    return false;
  }
}

const hitDist: FloatRef = { value: 0 };
