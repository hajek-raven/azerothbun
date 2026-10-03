/** @ac common/Collision/Management/IVMapMgr.h VMAP::VMAP_LOAD_RESULT */
export const VMAP_LOAD_RESULT = {
  VMAP_LOAD_RESULT_ERROR: 0,
  VMAP_LOAD_RESULT_OK: 1,
  VMAP_LOAD_RESULT_IGNORED: 2,
} as const;
export type VMAP_LOAD_RESULT = (typeof VMAP_LOAD_RESULT)[keyof typeof VMAP_LOAD_RESULT];

/** @ac common/Collision/Management/IVMapMgr.h VMAP::LoadResult */
export const LoadResult = {
  Success: 0,
  FileNotFound: 1,
  VersionMismatch: 2,
} as const;
export type LoadResult = (typeof LoadResult)[keyof typeof LoadResult];

/** For checks. @ac common/Collision/Management/IVMapMgr.h VMAP_INVALID_HEIGHT */
export const VMAP_INVALID_HEIGHT = -100000.0;
/** Real assigned value in unknown height case. @ac common/Collision/Management/IVMapMgr.h VMAP_INVALID_HEIGHT_VALUE */
export const VMAP_INVALID_HEIGHT_VALUE = -200000.0;

/** @ac common/Collision/Management/IVMapMgr.h VMAP::AreaAndLiquidData::AreaInfo */
export class AreaAndLiquidDataAreaInfo {
  constructor(
    public groupId = 0,
    public adtId = 0,
    public rootId = 0,
    public mogpFlags = 0,
    public uniqueId = 0,
  ) {}
}

/** @ac common/Collision/Management/IVMapMgr.h VMAP::AreaAndLiquidData::LiquidInfo */
export class AreaAndLiquidDataLiquidInfo {
  constructor(
    public type = 0,
    public level = 0,
  ) {}
}

/**
 * Result of the vmap area and liquid query. `areaInfo` / `liquidInfo` are the C++ `Optional`s: null when
 * empty. `emplaceAreaInfo` / `emplaceLiquidInfo` reuse one object each, so a caller that keeps one
 * `AreaAndLiquidData` and calls `reset()` between queries does not allocate.
 *
 * @ac common/Collision/Management/IVMapMgr.h VMAP::AreaAndLiquidData
 */
export class AreaAndLiquidData {
  floorZ = VMAP_INVALID_HEIGHT;
  areaInfo: AreaAndLiquidDataAreaInfo | null = null;
  liquidInfo: AreaAndLiquidDataLiquidInfo | null = null;
  private areaStorage: AreaAndLiquidDataAreaInfo | null = null;
  private liquidStorage: AreaAndLiquidDataLiquidInfo | null = null;

  /** `areaInfo.emplace(groupId, adtId, rootId, mogpFlags, uniqueId)`. */
  emplaceAreaInfo(groupId: number, adtId: number, rootId: number, mogpFlags: number, uniqueId: number): AreaAndLiquidDataAreaInfo {
    const a = this.areaStorage ?? (this.areaStorage = new AreaAndLiquidDataAreaInfo());
    a.groupId = groupId;
    a.adtId = adtId;
    a.rootId = rootId;
    a.mogpFlags = mogpFlags;
    a.uniqueId = uniqueId;
    this.areaInfo = a;
    return a;
  }

  /** `liquidInfo.emplace(type, level)`. */
  emplaceLiquidInfo(type: number, level: number): AreaAndLiquidDataLiquidInfo {
    const l = this.liquidStorage ?? (this.liquidStorage = new AreaAndLiquidDataLiquidInfo());
    l.type = type;
    l.level = level;
    this.liquidInfo = l;
    return l;
  }

  /** Back to the default constructed state. */
  reset(): this {
    this.floorZ = VMAP_INVALID_HEIGHT;
    this.areaInfo = null;
    this.liquidInfo = null;
    return this;
  }
}

/**
 * This is the minimum interface to the VMapMgr.
 *
 * @ac common/Collision/Management/IVMapMgr.h VMAP::IVMapMgr
 */
export abstract class IVMapMgr {
  private iEnableLineOfSightCalc = true;
  private iEnableHeightCalc = true;

  /** @ac common/Collision/Management/IVMapMgr.h VMAP::IVMapMgr::existsMap */
  abstract existsMap(pBasePath: string, pMapId: number, x: number, y: number): LoadResult;

  /** Send debug commands. @ac common/Collision/Management/IVMapMgr.h VMAP::IVMapMgr::processCommand */
  abstract processCommand(pCommand: string): boolean;

  /**
   * Enable/disable LOS calculation. It is enabled by default. If it is enabled in mid game the maps have
   * to loaded manualy.
   *
   * @ac common/Collision/Management/IVMapMgr.h VMAP::IVMapMgr::setEnableLineOfSightCalc
   */
  setEnableLineOfSightCalc(pVal: boolean): void {
    this.iEnableLineOfSightCalc = pVal;
  }

  /**
   * Enable/disable model height calculation. It is enabled by default. If it is enabled in mid game the
   * maps have to loaded manualy.
   *
   * @ac common/Collision/Management/IVMapMgr.h VMAP::IVMapMgr::setEnableHeightCalc
   */
  setEnableHeightCalc(pVal: boolean): void {
    this.iEnableHeightCalc = pVal;
  }

  /** @ac common/Collision/Management/IVMapMgr.h VMAP::IVMapMgr::isLineOfSightCalcEnabled */
  isLineOfSightCalcEnabled(): boolean {
    return this.iEnableLineOfSightCalc;
  }

  /** @ac common/Collision/Management/IVMapMgr.h VMAP::IVMapMgr::isHeightCalcEnabled */
  isHeightCalcEnabled(): boolean {
    return this.iEnableHeightCalc;
  }

  /** @ac common/Collision/Management/IVMapMgr.h VMAP::IVMapMgr::isMapLoadingEnabled */
  isMapLoadingEnabled(): boolean {
    return this.iEnableLineOfSightCalc || this.iEnableHeightCalc;
  }

  /** @ac common/Collision/Management/IVMapMgr.h VMAP::IVMapMgr::getDirFileName */
  abstract getDirFileName(pMapId: number, x: number, y: number): string;
}
