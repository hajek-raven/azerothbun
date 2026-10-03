/** Port of `common/Navigation/DetourExtended.{h,cpp}`: the slope-aware query filter `PathGenerator` uses. */
import { dtVdist } from "../Detour/DetourCommon.ts";
import type { dtMeshTile, dtPolyRef } from "../Detour/DetourNavMesh.ts";
import { dtQueryFilter } from "../Detour/DetourNavMeshQuery.ts";
import { getSlopeAngle } from "../Utilities/Geometry.ts";

/** @ac common/Navigation/DetourExtended.h dtQueryFilterExt */
export class dtQueryFilterExt extends dtQueryFilter {
  /**
   * Distance times area cost, raised by 1% per degree of slope between the two points.
   * @ac common/Navigation/DetourExtended.cpp dtQueryFilterExt::getCost
   */
  override getCost(
    pa: Float32Array,
    pb: Float32Array,
    _prevRef: dtPolyRef,
    _prevTile: dtMeshTile | null,
    _prevPoly: number,
    _curRef: dtPolyRef,
    curTile: dtMeshTile | null,
    curPoly: number,
    _nextRef: dtPolyRef,
    _nextTile: dtMeshTile | null,
    _nextPoly: number,
  ): number {
    const startX = pa[2]!;
    const startY = pa[0]!;
    const startZ = pa[1]!;
    const destX = pb[2]!;
    const destY = pb[0]!;
    const destZ = pb[1]!;
    const slopeAngle = Math.fround(getSlopeAngle(startX, startY, startZ, destX, destY, destZ));
    const slopeAngleDegree = Math.fround((slopeAngle * 180.0) / Math.PI);
    const cost = slopeAngleDegree > 0 ? Math.fround(1.0 + 1.0 * Math.fround(slopeAngleDegree / 100)) : 1.0;
    const dist = Math.fround(dtVdist(pa, 0, pb, 0));
    const totalCost = Math.fround(Math.fround(dist * cost) * this.getAreaCost(curTile!.polyGetArea(curPoly)));
    return totalCost;
  }
}
