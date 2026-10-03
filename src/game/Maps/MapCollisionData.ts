/**
 * @ac game/Maps/MapCollisionData.h
 * @ac game/Maps/MapCollisionData.cpp
 *
 * The collision data of one map: the static vmap tree (shared with the parent map of an instance), the dynamic game
 * object tree, and the mmap nav mesh (shared with the parent map) with a per map query. `StaticVMapCollisionData` does the
 * world to vmap coordinate conversion and the config and `disables` checks; `MapCollisionData` loads the vmap and mmap tile
 * of every grid the map loads.
 *
 * @ac-skip game/Maps/MapCollisionData.h MapCollisionData::~MapCollisionData: defaulted in C++ (memory is garbage collected)
 *
 * `DisableMgr::IsVMAPDisabledFor` goes through the pointer `VMapMgr2` carries (`IsVMAPDisabledForPtr`, installed by the
 * disables manager when it is ported, "not disabled" until then). `ENABLE_VMAP_CHECKS` is on in the default build.
 */
import { MMapMgr } from "../../common/Collision/Management/MMapMgr.ts";
import { MMAP_LOAD_RESULT_ERROR, MMAP_LOAD_RESULT_IGNORED, MMAP_LOAD_RESULT_OK, type ManagedNavMeshQuery } from "../../common/Collision/Management/MMapMgr.ts";
import {
  VMAP_INVALID_HEIGHT_VALUE,
  VMAP_LOAD_RESULT,
  type AreaAndLiquidData,
} from "../../common/Collision/Management/IVMapMgr.ts";
import { VMapFactory } from "../../common/Collision/Management/VMapFactory.ts";
import { DisableTypes, VMapMgr2 } from "../../common/Collision/Management/VMapMgr2.ts";
import { StaticMapTree, LocationInfo } from "../../common/Collision/Maps/MapTree.ts";
import { DynamicMapTree } from "../../common/Collision/DynamicTree.ts";
import { GetLiquidFlags } from "../DataStores/MapDBCStores.ts";
import type { dtNavMesh } from "../../common/Detour/DetourNavMesh.ts";
import { finf } from "../../math/g3dmath.ts";
import { Vector3 } from "../../math/Vector3.ts";
import { ServerConfig } from "../world/world-config-data.ts";
import { sWorld } from "../world/world.ts";
import { GridTerrainLoaderHooks } from "../Grids/GridTerrainLoader.ts";

/** The `Map` members `MapCollisionData` reads (`Map const&` and `Map const* parentMap` in C++). */
export interface MapCollisionDataMap {
  getId(): number;
  isBattlegroundOrArena(): boolean;
}

/**
 * What `MapCollisionData` takes from other topics.
 * - `isVMAPDisabledFor`: `DisableMgr::IsVMAPDisabledFor` (default: the `VMapMgr2` pointer)
 * - `isPathfindingEnabled`: `DisableMgr::IsPathfindingEnabled`
 */
export const MapCollisionDataHooks: {
  isVMAPDisabledFor: (mapId: number, flags: number) => boolean;
  isPathfindingEnabled: (map: MapCollisionDataMap | null) => boolean;
} = {
  isVMAPDisabledFor: (mapId, flags) => VMapFactory.createOrGetVMapMgr().IsVMAPDisabledForPtr(mapId, flags),
  /** @ac game/Conditions/DisableMgr.cpp DisableMgr::IsPathfindingEnabled */
  isPathfindingEnabled: (map) => {
    if (!map) return false;

    // Still not an ideal solution but removes the extra awful forbiddenMaps hack
    // int32 f[] = {616 /*EoE*/, 649 /*ToC25*/, 650 /*ToC5*/, -1};
    switch (map.getId()) {
      case 616: // EoE
      case 649: // ToC25
      case 650: // ToC5
        return false;
      default:
        break;
    }

    return sWorld().getBoolConfig(ServerConfig.CONFIG_ENABLE_MMAPS) ? true : map.isBattlegroundOrArena();
  },
};

const scratchPos1 = new Vector3();
const scratchPos2 = new Vector3();
const scratchResult = new Vector3();
const scratchInfo = new LocationInfo();

/** @ac game/Maps/MapCollisionData.h StaticVMapCollisionData (simple wrapper for the vmap static tree) */
export class StaticVMapCollisionData {
  /** `_staticTree` is a shared_ptr in C++ as it will point to a parent maps static tree (if exists) to save on memory */
  _staticTree: StaticMapTree | null = null;
  _mapId: number;

  /** @ac game/Maps/MapCollisionData.h StaticVMapCollisionData::StaticVMapCollisionData */
  constructor(mapId: number) {
    this._mapId = mapId;
  }

  /** @ac game/Maps/MapCollisionData.cpp StaticVMapCollisionData::isInLineOfSight */
  isInLineOfSight(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, ignoreFlags: number): boolean {
    if (!sWorld().getBoolConfig(ServerConfig.CONFIG_VMAP_ENABLE_LOS) || MapCollisionDataHooks.isVMAPDisabledFor(this._mapId, DisableTypes.VMAP_DISABLE_LOS)) return true;

    if (!this._staticTree) return true;

    const pos1 = VMapMgr2.convertPositionToInternalRepTo(x1, y1, z1, scratchPos1);
    const pos2 = VMapMgr2.convertPositionToInternalRepTo(x2, y2, z2, scratchPos2);
    if (pos1.x !== pos2.x || pos1.y !== pos2.y || pos1.z !== pos2.z) return this._staticTree.isInLineOfSight(pos1, pos2, ignoreFlags);

    return true;
  }

  /**
   * @ac game/Maps/MapCollisionData.cpp StaticVMapCollisionData::GetObjectHitPos
   * The reference parameters `rx`, `ry`, `rz` are written to `result`.
   */
  GetObjectHitPos(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, result: { x: number; y: number; z: number }, modifyDist: number): boolean {
    if (sWorld().getBoolConfig(ServerConfig.CONFIG_VMAP_ENABLE_LOS) && !MapCollisionDataHooks.isVMAPDisabledFor(this._mapId, DisableTypes.VMAP_DISABLE_LOS)) {
      if (this._staticTree) {
        const pos1 = VMapMgr2.convertPositionToInternalRepTo(x1, y1, z1, scratchPos1);
        const pos2 = VMapMgr2.convertPositionToInternalRepTo(x2, y2, z2, scratchPos2);
        const hit = this._staticTree.GetObjectHitPos(pos1, pos2, scratchResult, modifyDist);
        const resultPos = VMapMgr2.convertPositionToInternalRepTo(scratchResult.x, scratchResult.y, scratchResult.z, scratchResult);
        result.x = resultPos.x;
        result.y = resultPos.y;
        result.z = resultPos.z;
        return hit;
      }
    }

    result.x = x2;
    result.y = y2;
    result.z = z2;

    return false;
  }

  /** @ac game/Maps/MapCollisionData.cpp StaticVMapCollisionData::getHeight */
  getHeight(x: number, y: number, z: number, maxSearchDist: number): number {
    if (sWorld().getBoolConfig(ServerConfig.CONFIG_VMAP_ENABLE_HEIGHT) && !MapCollisionDataHooks.isVMAPDisabledFor(this._mapId, DisableTypes.VMAP_DISABLE_HEIGHT)) {
      if (this._staticTree) {
        const pos = VMapMgr2.convertPositionToInternalRepTo(x, y, z, scratchPos1);
        const height = this._staticTree.getHeight(pos, maxSearchDist);
        if (height >= finf()) return VMAP_INVALID_HEIGHT_VALUE; // No height

        return height;
      }
    }

    return VMAP_INVALID_HEIGHT_VALUE;
  }

  /**
   * @ac game/Maps/MapCollisionData.cpp StaticVMapCollisionData::GetAreaAndLiquidData
   * `Optional<uint8> reqLiquidType` is `null` for `{}`; `data` is filled (call `data.reset()` between queries).
   */
  GetAreaAndLiquidData(x: number, y: number, z: number, reqLiquidType: number | null, data: AreaAndLiquidData): boolean {
    if (this._staticTree) {
      const info = scratchInfo.reset();
      const pos = VMapMgr2.convertPositionToInternalRepTo(x, y, z, scratchPos1);
      if (this._staticTree.GetLocationInfo(pos, info)) {
        data.floorZ = info.ground_Z;
        if (!MapCollisionDataHooks.isVMAPDisabledFor(this._mapId, DisableTypes.VMAP_DISABLE_LIQUIDSTATUS)) {
          const liquidType = info.hitModel!.GetLiquidType(); // entry from LiquidType.dbc
          if (reqLiquidType === null || (GetLiquidFlags(liquidType) & reqLiquidType) !== 0) {
            const liquidLevel = { value: 0 };
            if (info.hitInstance!.GetLiquidLevel(pos, info, liquidLevel)) data.emplaceLiquidInfo(liquidType, liquidLevel.value);
          }
        }

        if (!MapCollisionDataHooks.isVMAPDisabledFor(this._mapId, DisableTypes.VMAP_DISABLE_AREAFLAG))
          data.emplaceAreaInfo(info.hitModel!.GetWmoID(), info.hitInstance!.adtId, info.rootId, info.hitModel!.GetMogpFlags(), info.hitInstance!.ID);
        return true;
      }
    }

    return false;
  }
}

/** @ac game/Maps/MapCollisionData.h DynamicVMapCollisionData (the dynamic game object tree of a map) */
export class DynamicVMapCollisionData extends DynamicMapTree {
  /**
   * @ac game/Maps/MapCollisionData.cpp DynamicVMapCollisionData::GetObjectHitPos
   * The `(phasemask, x1, y1, z1, x2, y2, z2, rx, ry, rz, modifyDist)` form: the reference parameters are written to
   * `result`. The `Vector3` form is the `DynamicMapTree::GetObjectHitPos` the C++ one hides.
   */
  override GetObjectHitPos(phasemask: number, startPos: Vector3, endPos: Vector3, resultHit: Vector3, modifyDist: number): boolean;
  override GetObjectHitPos(
    phasemask: number,
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    result: { x: number; y: number; z: number },
    modifyDist: number,
  ): boolean;
  override GetObjectHitPos(
    phasemask: number,
    a: Vector3 | number,
    b: Vector3 | number,
    c: Vector3 | number,
    d: number | undefined,
    e?: number,
    f?: number,
    g?: { x: number; y: number; z: number },
    h?: number,
  ): boolean {
    if (a instanceof Vector3) return super.GetObjectHitPos(phasemask, a, b as Vector3, c as Vector3, d as number);

    const startPos = scratchPos1.set(a, b as number, c as number);
    const dstPos = scratchPos2.set(d as number, e as number, f as number);

    const resultPos = scratchResult;
    const hit = super.GetObjectHitPos(phasemask, startPos, dstPos, resultPos, h as number);

    g!.x = resultPos.x;
    g!.y = resultPos.y;
    g!.z = resultPos.z;
    return hit;
  }
}

/** @ac game/Maps/MapCollisionData.h MMapData */
export class MMapData {
  /** `_navMesh` is a shared_ptr in C++ as it will point to a parent maps nav mesh (if exists) to save on memory */
  _navMesh: dtNavMesh | null = null;
  /** navMeshQuery is not thread safe and needs its own instance per map */
  _navMeshQuery: ManagedNavMeshQuery | null = null;

  /** @ac game/Maps/MapCollisionData.h MMapData::GetNavMesh */
  getNavMesh(): dtNavMesh | null {
    return this._navMesh;
  }

  /** @ac game/Maps/MapCollisionData.cpp MMapData::GetNavMeshQuery */
  getNavMeshQuery(): ManagedNavMeshQuery | null {
    if (this._navMesh && !this._navMeshQuery) this._navMeshQuery = MMapMgr.createNavMeshQuery(this._navMesh);

    return this._navMeshQuery;
  }
}

/** The part of a parent `Map` a child `MapCollisionData` shares data with. */
export interface MapCollisionDataParent {
  getMapCollisionData(): { getStaticTreeSharedPtr(): StaticMapTree | null; getMMapNavMeshSharedPtr(): dtNavMesh | null };
}

/** @ac game/Maps/MapCollisionData.h MapCollisionData (map collision data holders: dynamic and static vmap, mmaps) */
export class MapCollisionData {
  private readonly _dynamicVMapData = new DynamicVMapCollisionData();
  private readonly _staticVMapData: StaticVMapCollisionData;
  private readonly _mmapData = new MMapData();

  /** @ac game/Maps/MapCollisionData.cpp MapCollisionData::MapCollisionData */
  constructor(
    private readonly _map: MapCollisionDataMap,
    parentMap: MapCollisionDataParent | null,
  ) {
    this._staticVMapData = new StaticVMapCollisionData(_map.getId());
    if (parentMap) {
      // If we have a parent map, point our static tree and mmap nav mesh to the parent maps
      this._staticVMapData._staticTree = parentMap.getMapCollisionData().getStaticTreeSharedPtr();
      this._mmapData._navMesh = parentMap.getMapCollisionData().getMMapNavMeshSharedPtr();
    } else {
      // If we are a base map create a new static tree and mmap nav mesh
      const mapFileName = VMapMgr2.getMapFileName(_map.getId());
      const newTree = new StaticMapTree(_map.getId(), `${dataPath()}vmaps`);
      if (newTree.InitMap(mapFileName)) this._staticVMapData._staticTree = newTree;

      this._mmapData._navMesh = MMapMgr.loadNavMesh(_map.getId());
    }
  }

  /** @ac game/Maps/MapCollisionData.cpp MapCollisionData::LoadVMapTile (returns a `VMAP::VMAP_LOAD_RESULT`) */
  loadVMapTile(tileX: number, tileY: number): number {
    if (!VMapFactory.createOrGetVMapMgr().isMapLoadingEnabled() || !this._staticVMapData._staticTree) return VMAP_LOAD_RESULT.VMAP_LOAD_RESULT_IGNORED;

    if (!this._staticVMapData._staticTree.LoadMapTile(tileX, tileY)) return VMAP_LOAD_RESULT.VMAP_LOAD_RESULT_ERROR;

    return VMAP_LOAD_RESULT.VMAP_LOAD_RESULT_OK;
  }

  /** @ac game/Maps/MapCollisionData.cpp MapCollisionData::LoadMMapTile (returns a `MMAP::MMAP_LOAD_RESULT`) */
  loadMMapTile(tileX: number, tileY: number): number {
    if (!MapCollisionDataHooks.isPathfindingEnabled(this._map) || !this._mmapData._navMesh) return MMAP_LOAD_RESULT_IGNORED;

    return MMapMgr.loadTile(this._mmapData._navMesh, this._map.getId(), tileX, tileY) ? MMAP_LOAD_RESULT_OK : MMAP_LOAD_RESULT_ERROR;
  }

  /** @ac game/Maps/MapCollisionData.h MapCollisionData::GetDynamicTree */
  getDynamicTree(): DynamicVMapCollisionData {
    return this._dynamicVMapData;
  }

  /** @ac game/Maps/MapCollisionData.h MapCollisionData::GetStaticTree */
  getStaticTree(): StaticVMapCollisionData {
    return this._staticVMapData;
  }

  /** @ac game/Maps/MapCollisionData.h MapCollisionData::GetMMapData */
  getMMapData(): MMapData {
    return this._mmapData;
  }

  /** @ac game/Maps/MapCollisionData.h MapCollisionData::GetStaticTreeSharedPtr */
  getStaticTreeSharedPtr(): StaticMapTree | null {
    return this._staticVMapData._staticTree;
  }

  /** @ac game/Maps/MapCollisionData.h MapCollisionData::GetMMapNavMeshSharedPtr */
  getMMapNavMeshSharedPtr(): dtNavMesh | null {
    return this._mmapData._navMesh;
  }
}

/** `sWorld->GetDataPath()` (`DataDir`, with a trailing slash) as the terrain loader resolves it. */
function dataPath(): string {
  const path = GridTerrainLoaderHooks.getDataPath();
  return path.endsWith("/") ? path : `${path}/`;
}
