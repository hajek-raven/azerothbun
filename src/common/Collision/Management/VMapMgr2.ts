import { Vector3 } from "../../../math/Vector3.ts";
import { MAX_NUMBER_OF_GRIDS, SIZE_OF_GRIDS } from "../Maps/MapDefines.ts";
import { StaticMapTree } from "../Maps/MapTree.ts";
import { IVMapMgr, type LoadResult } from "./IVMapMgr.ts";

/** @ac common/Collision/Management/VMapMgr2.h MAP_FILENAME_EXTENSION2 */
export const MAP_FILENAME_EXTENSION2 = ".vmtree";
/** @ac common/Collision/Management/VMapMgr2.h FILENAMEBUFFER_SIZE */
export const FILENAMEBUFFER_SIZE = 500;

/** @ac common/Collision/Management/VMapMgr2.h VMAP::DisableTypes */
export const DisableTypes = {
  VMAP_DISABLE_AREAFLAG: 0x1,
  VMAP_DISABLE_HEIGHT: 0x2,
  VMAP_DISABLE_LOS: 0x4,
  VMAP_DISABLE_LIQUIDSTATUS: 0x8,
} as const;

/** @ac common/Collision/Management/VMapMgr2.h VMAP::VMapMgr2::GetLiquidFlagsFn */
export type GetLiquidFlagsFn = (liquidType: number) => number;
/** @ac common/Collision/Management/VMapMgr2.h VMAP::VMapMgr2::IsVMAPDisabledForFn */
export type IsVMAPDisabledForFn = (entry: number, flags: number) => boolean;

/** `0.5f * MAX_NUMBER_OF_GRIDS * SIZE_OF_GRIDS` as a float. */
const MID = Math.fround(0.5 * MAX_NUMBER_OF_GRIDS * SIZE_OF_GRIDS);

/**
 * The vmap manager. In this AzerothCore revision the per map trees are owned by each `Map`
 * (`MapCollisionData` holds a `StaticMapTree` and a `DynamicMapTree`); `VMapMgr2` keeps the global
 * switches, the file name helpers, the coordinate conversion and the two function pointers `World`
 * installs at startup (`GetLiquidFlagsPtr`, `IsVMAPDisabledForPtr`).
 *
 * @ac common/Collision/Management/VMapMgr2.h VMAP::VMapMgr2
 * @ac-skip common/Collision/Management/VMapMgr2.cpp VMAP::VMapMgr2::~VMapMgr2: empty in C++
 */
export class VMapMgr2 extends IVMapMgr {
  /** @ac common/Collision/Management/VMapMgr2.h VMAP::VMapMgr2::GetLiquidFlagsDummy */
  protected static GetLiquidFlagsDummy(_liquidType: number): number {
    return 0;
  }

  /** @ac common/Collision/Management/VMapMgr2.h VMAP::VMapMgr2::IsVMAPDisabledForDummy */
  protected static IsVMAPDisabledForDummy(_entry: number, _flags: number): boolean {
    return false;
  }

  GetLiquidFlagsPtr: GetLiquidFlagsFn;
  IsVMAPDisabledForPtr: IsVMAPDisabledForFn;

  /** @ac common/Collision/Management/VMapMgr2.cpp VMAP::VMapMgr2::VMapMgr2 */
  constructor() {
    super();
    this.GetLiquidFlagsPtr = VMapMgr2.GetLiquidFlagsDummy;
    this.IsVMAPDisabledForPtr = VMapMgr2.IsVMAPDisabledForDummy;
  }

  /**
   * World coordinates to the vmap internal coordinates (`mid - x`, `mid - y`, `z`). The conversion is
   * its own inverse.
   *
   * @ac common/Collision/Management/VMapMgr2.cpp VMAP::VMapMgr2::convertPositionToInternalRep
   */
  static convertPositionToInternalRep(x: number, y: number, z: number): Vector3 {
    return VMapMgr2.convertPositionToInternalRepTo(x, y, z, new Vector3());
  }

  /** `convertPositionToInternalRep` written into `out` (for per packet callers). */
  static convertPositionToInternalRepTo(x: number, y: number, z: number, out: Vector3): Vector3 {
    return out.set(MID - x, MID - y, z);
  }

  /** `%03u.vmtree`. @ac common/Collision/Management/VMapMgr2.cpp VMAP::VMapMgr2::getMapFileName */
  static getMapFileName(mapId: number): string {
    return `${String(mapId).padStart(3, "0")}${MAP_FILENAME_EXTENSION2}`;
  }

  /** For debug and extensions. @ac common/Collision/Management/VMapMgr2.h VMAP::VMapMgr2::processCommand */
  processCommand(_command: string): boolean {
    return false;
  }

  /** @ac common/Collision/Management/VMapMgr2.h VMAP::VMapMgr2::getDirFileName */
  getDirFileName(mapId: number, _x: number, _y: number): string {
    return VMapMgr2.getMapFileName(mapId);
  }

  /** @ac common/Collision/Management/VMapMgr2.cpp VMAP::VMapMgr2::existsMap */
  existsMap(basePath: string, mapId: number, x: number, y: number): LoadResult {
    return StaticMapTree.CanLoadMap(basePath, mapId, x, y);
  }
}
