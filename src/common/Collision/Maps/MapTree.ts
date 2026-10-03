import { logDebug, logError } from "../../../log.ts";
import { finf, inf } from "../../../math/g3dmath.ts";
import { Ray } from "../../../math/Ray.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { ReadFile } from "../BinaryFile.ts";
import { BIH, type BIHPointCallback, type BIHRayCallback, type FloatRef } from "../BoundingIntervalHierarchy.ts";
import { LoadResult } from "../Management/IVMapMgr.ts";
import { VMapMgr2 } from "../Management/VMapMgr2.ts";
import { WorldModelStore } from "../Management/WorldModelStore.ts";
import { ModelIgnoreFlags } from "../Models/ModelIgnoreFlags.ts";
import { ModelInstance, ModelSpawn } from "../Models/ModelInstance.ts";
import type { GroupModel } from "../Models/WorldModel.ts";
import { MAPS_LOG, readChunk, VMAP_MAGIC } from "../VMapDefinitions.ts";

/** `std::numeric_limits<float>::max()`. */
const FLT_MAX = 3.4028234663852886e38;

/** @ac common/Collision/Maps/MapTree.h VMAP::GroupLocationInfo */
export interface GroupLocationInfo {
  hitModel: GroupModel | null;
  rootId: number;
}

/** @ac common/Collision/Maps/MapTree.h VMAP::LocationInfo */
export class LocationInfo {
  hitInstance: ModelInstance | null = null;
  hitModel: GroupModel | null = null;
  ground_Z = -inf();
  rootId = -1;

  /** Back to the default constructed state, so one `LocationInfo` can serve many queries. */
  reset(): this {
    this.hitInstance = null;
    this.hitModel = null;
    this.ground_Z = -inf();
    this.rootId = -1;
    return this;
  }
}

/** @ac common/Collision/Maps/MapTree.h VMAP::AreaInfo */
export class AreaInfo {
  result = false;
  ground_Z = -inf();
  flags = 0;
  adtId = 0;
  rootId = 0;
  groupId = 0;
}

/** @ac common/Collision/Maps/MapTree.cpp VMAP::MapRayCallback */
class MapRayCallback implements BIHRayCallback {
  prims: (ModelInstance | null)[] = [];
  flags: ModelIgnoreFlags = ModelIgnoreFlags.Nothing;
  hit = false;

  reset(prims: (ModelInstance | null)[], ignoreFlags: ModelIgnoreFlags): this {
    this.prims = prims;
    this.flags = ignoreFlags;
    this.hit = false;
    return this;
  }

  onRay(ray: Ray, entry: number, distance: FloatRef, StopAtFirstHit: boolean): boolean {
    const prim = this.prims[entry];
    if (!prim) return false;
    const result = prim.intersectRay(ray, distance, StopAtFirstHit, this.flags);
    if (result) this.hit = true;
    return result;
  }

  didHit(): boolean {
    return this.hit;
  }
}

/** @ac common/Collision/Maps/MapTree.cpp VMAP::LocationInfoCallback */
class LocationInfoCallback implements BIHPointCallback {
  prims: (ModelInstance | null)[] = [];
  locInfo: LocationInfo = new LocationInfo();
  result = false;

  reset(prims: (ModelInstance | null)[], info: LocationInfo): this {
    this.prims = prims;
    this.locInfo = info;
    this.result = false;
    return this;
  }

  onPoint(point: Vector3, entry: number): void {
    const prim = this.prims[entry];
    if (prim && prim.GetLocationInfo(point, this.locInfo)) this.result = true;
  }
}

const mapRayCallback = new MapRayCallback();
const locationInfoCallback = new LocationInfoCallback();
const queryRay = new Ray();
const queryDist: FloatRef = { value: 0 };

/**
 * The static (ADT and WDT placed) model tree of one map: a BIH over every spawn of the map, filled per
 * tile from the `.vmtile` files as grids load.
 *
 * `iTreeValues` holds `null` for a slot whose tile is not loaded yet; the C++ default constructed
 * `ModelInstance` there has no model and answers every query with false, which is what a null slot does.
 *
 * Positions are in the vmap internal coordinates (`VMapMgr2.convertPositionToInternalRep`).
 *
 * @ac common/Collision/Maps/MapTree.h VMAP::StaticMapTree
 * @ac-skip common/Collision/Maps/MapTree.cpp VMAP::StaticMapTree::~StaticMapTree: memory is garbage collected
 */
export class StaticMapTree {
  private iMapID: number;
  private iIsTiled = false;
  private iTree = new BIH();
  /** the tree entries */
  private iTreeValues: (ModelInstance | null)[] | null = null;
  private iNTreeValues = 0;
  /**
   * Store all the map tile idents that are loaded for that map. Some maps are not splitted into tiles
   * and we have to make sure, not removing the map before all tiles are removed. Empty tiles have no
   * tile file, hence map with bool instead of just a set (consistency check).
   */
  private iLoadedTiles = new Map<number, boolean>();
  private iBasePath: string;

  /** @ac common/Collision/Maps/MapTree.cpp VMAP::StaticMapTree::getTileFileName (`%03u_%02u_%02u.vmtile`, Y before X) */
  static getTileFileName(mapID: number, tileX: number, tileY: number): string {
    return `${String(mapID).padStart(3, "0")}_${String(tileY).padStart(2, "0")}_${String(tileX).padStart(2, "0")}.vmtile`;
  }

  /** @ac common/Collision/Maps/MapTree.h VMAP::StaticMapTree::packTileID */
  static packTileID(tileX: number, tileY: number): number {
    return ((tileX << 16) | tileY) >>> 0;
  }

  /** Returns `[tileX, tileY]`. `tileY` is `ID & 0xFF`, as in C++. @ac common/Collision/Maps/MapTree.h VMAP::StaticMapTree::unpackTileID */
  static unpackTileID(ID: number): [tileX: number, tileY: number] {
    return [ID >>> 16, ID & 0xff];
  }

  /** @ac common/Collision/Maps/MapTree.cpp VMAP::StaticMapTree::StaticMapTree */
  constructor(mapID: number, basePath: string) {
    this.iMapID = mapID;
    this.iBasePath = basePath;
    if (this.iBasePath.length > 0 && !this.iBasePath.endsWith("/") && !this.iBasePath.endsWith("\\")) this.iBasePath += "/";
  }

  /**
   * If intersection is found within pMaxDist, sets pMaxDist to intersection distance and returns true.
   * Else, pMaxDist is not modified and returns false.
   *
   * @ac common/Collision/Maps/MapTree.cpp VMAP::StaticMapTree::GetIntersectionTime
   */
  private GetIntersectionTime(pRay: Ray, pMaxDist: FloatRef, StopAtFirstHit: boolean, ignoreFlags: ModelIgnoreFlags): boolean {
    if (!this.iTreeValues) return false;
    const distance = pMaxDist.value;
    queryDist.value = distance;
    const intersectionCallBack = mapRayCallback.reset(this.iTreeValues, ignoreFlags);
    this.iTree.intersectRay(pRay, intersectionCallBack, queryDist, StopAtFirstHit);
    if (intersectionCallBack.didHit()) pMaxDist.value = queryDist.value;
    return intersectionCallBack.didHit();
  }

  /** @ac common/Collision/Maps/MapTree.cpp VMAP::StaticMapTree::isInLineOfSight */
  isInLineOfSight(pos1: Vector3, pos2: Vector3, ignoreFlags: ModelIgnoreFlags): boolean {
    const dx = pos2.x - pos1.x, dy = pos2.y - pos1.y, dz = pos2.z - pos1.z;
    const maxDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // return false if distance is over max float, in case of cheater teleporting to the end of the universe
    if (maxDist === FLT_MAX || !Number.isFinite(maxDist)) return false;

    // prevent NaN values which can cause BIH intersection to enter infinite loop
    if (maxDist < 1e-10) return true;
    // direction with length of 1
    const inv = 1 / maxDist;
    const ray = queryRay.setXYZ(pos1.x, pos1.y, pos1.z, dx * inv, dy * inv, dz * inv);
    losDist.value = maxDist;
    return !this.GetIntersectionTime(ray, losDist, true, ignoreFlags);
  }

  /**
   * When moving from pos1 to pos2 check if we hit an object. Return true and the position if we hit
   * one. Return the hit pos or the original dest pos (in `pResultHitPos`).
   *
   * @ac common/Collision/Maps/MapTree.cpp VMAP::StaticMapTree::GetObjectHitPos
   */
  GetObjectHitPos(pPos1: Vector3, pPos2: Vector3, pResultHitPos: Vector3, pModifyDist: number): boolean {
    const dx = pPos2.x - pPos1.x, dy = pPos2.y - pPos1.y, dz = pPos2.z - pPos1.z;
    const maxDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // valid map coords should *never ever* produce float overflow, but this would produce NaNs too
    if (!(maxDist < FLT_MAX)) throw new Error(`ASSERT failed: StaticMapTree::GetObjectHitPos maxDist ${maxDist} < FLT_MAX`);
    // prevent NaN values which can cause BIH intersection to enter infinite loop
    if (maxDist < 1e-10) {
      pResultHitPos.copy(pPos2);
      return false;
    }
    // direction with length of 1
    const inv = 1 / maxDist;
    const dirX = dx * inv, dirY = dy * inv, dirZ = dz * inv;
    const ray = queryRay.setXYZ(pPos1.x, pPos1.y, pPos1.z, dirX, dirY, dirZ);
    losDist.value = maxDist;
    if (this.GetIntersectionTime(ray, losDist, false, ModelIgnoreFlags.Nothing)) {
      const dist = losDist.value;
      let rx = pPos1.x + dirX * dist, ry = pPos1.y + dirY * dist, rz = pPos1.z + dirZ * dist;
      if (pModifyDist < 0) {
        const hx = rx - pPos1.x, hy = ry - pPos1.y, hz = rz - pPos1.z;
        if (Math.sqrt(hx * hx + hy * hy + hz * hz) > -pModifyDist) {
          rx += dirX * pModifyDist;
          ry += dirY * pModifyDist;
          rz += dirZ * pModifyDist;
        } else {
          rx = pPos1.x;
          ry = pPos1.y;
          rz = pPos1.z;
        }
      } else {
        rx += dirX * pModifyDist;
        ry += dirY * pModifyDist;
        rz += dirZ * pModifyDist;
      }
      pResultHitPos.set(rx, ry, rz);
      return true;
    }
    pResultHitPos.copy(pPos2);
    return false;
  }

  /**
   * Height of the first model surface below `pPos` within `maxSearchDist`, or `Infinity` (`finf`) when
   * none is hit.
   *
   * @ac common/Collision/Maps/MapTree.cpp VMAP::StaticMapTree::getHeight
   */
  getHeight(pPos: Vector3, maxSearchDist: number): number {
    let height = finf();
    // direction with length of 1
    const ray = queryRay.setXYZ(pPos.x, pPos.y, pPos.z, 0, 0, -1);
    losDist.value = maxSearchDist;
    if (this.GetIntersectionTime(ray, losDist, false, ModelIgnoreFlags.Nothing)) height = pPos.z - losDist.value;
    return height;
  }

  /** @ac common/Collision/Maps/MapTree.cpp VMAP::StaticMapTree::GetLocationInfo */
  GetLocationInfo(pos: Vector3, info: LocationInfo): boolean {
    if (!this.iTreeValues) return false;
    const intersectionCallBack = locationInfoCallback.reset(this.iTreeValues, info);
    this.iTree.intersectPoint(pos, intersectionCallBack);
    return intersectionCallBack.result;
  }

  /** @ac common/Collision/Maps/MapTree.cpp VMAP::StaticMapTree::CanLoadMap */
  static CanLoadMap(vmapPath: string, mapID: number, tileX: number, tileY: number): LoadResult {
    let basePath = vmapPath;
    if (basePath.length > 0 && !basePath.endsWith("/") && !basePath.endsWith("\\")) basePath += "/";
    const fullname = basePath + VMapMgr2.getMapFileName(mapID);

    let result: LoadResult = LoadResult.Success;

    const rf = ReadFile.open(fullname);
    if (!rf) return LoadResult.FileNotFound;

    const magicOk = readChunk(rf, VMAP_MAGIC, 8);
    const tiled = rf.u8();
    if (!magicOk || tiled === undefined) return LoadResult.VersionMismatch;
    if (tiled) {
      const tilefile = basePath + StaticMapTree.getTileFileName(mapID, tileX, tileY);
      const tf = ReadFile.open(tilefile);
      if (!tf) result = LoadResult.FileNotFound;
      else if (!readChunk(tf, VMAP_MAGIC, 8)) result = LoadResult.VersionMismatch;
    }
    return result;
  }

  /** @ac common/Collision/Maps/MapTree.cpp VMAP::StaticMapTree::InitMap */
  InitMap(fname: string): boolean {
    let success = false;
    const fullname = this.iBasePath + fname;
    const rf = ReadFile.open(fullname);
    if (!rf) return false;

    let tiled = 0;
    if (readChunk(rf, VMAP_MAGIC, 8)) {
      const t = rf.u8();
      if (t !== undefined) {
        tiled = t;
        if (readChunk(rf, "NODE", 4) && this.iTree.readFromFile(rf)) {
          this.iNTreeValues = this.iTree.primCount();
          this.iTreeValues = new Array<ModelInstance | null>(this.iNTreeValues).fill(null);
          success = readChunk(rf, "GOBJ", 4);
        }
      }
    }

    this.iIsTiled = tiled !== 0;

    // global model spawns
    // only non-tiled maps have them, and if so exactly one (so far at least...)
    const spawn = new ModelSpawn();
    if (!this.iIsTiled && ModelSpawn.readFromFile(rf, spawn)) {
      const model = WorldModelStore.instance().AcquireModelInstance(this.iBasePath, spawn.name, spawn.flags);
      if (model && this.iTreeValues && this.iTreeValues.length > 0) {
        // assume that global model always is the first and only tree value (could be improved...)
        this.iTreeValues[0] = new ModelInstance(spawn, model);
      } else {
        success = false;
      }
    }

    return success;
  }

  /** @ac common/Collision/Maps/MapTree.cpp VMAP::StaticMapTree::UnloadMap */
  UnloadMap(): void {
    this.iLoadedTiles.clear();
  }

  /** @ac common/Collision/Maps/MapTree.cpp VMAP::StaticMapTree::LoadMapTile */
  LoadMapTile(tileX: number, tileY: number): boolean {
    if (!this.iIsTiled) {
      // currently, core creates grids for all maps, whether it has terrain tiles or not
      // so we need "fake" tile loads to know when we can unload map geometry
      this.iLoadedTiles.set(StaticMapTree.packTileID(tileX, tileY), false);
      return true;
    }
    const treeValues = this.iTreeValues;
    if (!treeValues) {
      logError(MAPS_LOG, `StaticMapTree::LoadMapTile() : tree has not been initialized [${tileX}, ${tileY}]`);
      return false;
    }
    let result = true;

    const tilefile = this.iBasePath + StaticMapTree.getTileFileName(this.iMapID, tileX, tileY);
    const tf = ReadFile.open(tilefile);
    if (tf) {
      if (!readChunk(tf, VMAP_MAGIC, 8)) result = false;
      let numSpawns = 0;
      if (result) {
        const n = tf.u32();
        if (n === undefined) result = false;
        else numSpawns = n;
      }
      for (let i = 0; i < numSpawns && result; ++i) {
        // read model spawns
        const spawn = new ModelSpawn();
        result = ModelSpawn.readFromFile(tf, spawn);
        if (result) {
          // acquire model instance
          const model = WorldModelStore.instance().AcquireModelInstance(this.iBasePath, spawn.name, spawn.flags);
          if (!model) {
            logError(MAPS_LOG, `StaticMapTree::LoadMapTile() : could not acquire WorldModel pointer [${tileX}, ${tileY}]`);
          }

          // update tree
          const referencedVal = tf.u32();
          if (referencedVal !== undefined) {
            if (referencedVal >= this.iNTreeValues) {
              logDebug(MAPS_LOG, () => `StaticMapTree::LoadMapTile() : invalid tree element (${referencedVal}/${this.iNTreeValues})`);
              continue;
            }

            // This looks odd and is confusing, took some research to figure it out:
            // the first WorldModel will create a "groupmodel" of all other same-models in the tile
            // we don't actually care about anything else
            if (!treeValues[referencedVal]?.getWorldModel()) treeValues[referencedVal] = new ModelInstance(spawn, model);
          } else {
            result = false;
          }
        }
      }
      this.iLoadedTiles.set(StaticMapTree.packTileID(tileX, tileY), true);
    } else {
      this.iLoadedTiles.set(StaticMapTree.packTileID(tileX, tileY), false);
    }

    // @ac-skip METRIC_EVENT("map_events", "LoadMapTile", ...): there is no metrics backend.
    return result;
  }

  /** @ac common/Collision/Maps/MapTree.cpp VMAP::StaticMapTree::UnloadMapTile */
  UnloadMapTile(tileX: number, tileY: number): void {
    const tileID = StaticMapTree.packTileID(tileX, tileY);
    if (!this.iLoadedTiles.has(tileID)) {
      logError(MAPS_LOG, `StaticMapTree::UnloadMapTile() : trying to unload non-loaded tile - Map:${this.iMapID} X:${tileX} Y:${tileY}`);
      return;
    }
    this.iLoadedTiles.delete(tileID);
    // @ac-skip METRIC_EVENT("map_events", "UnloadMapTile", ...): there is no metrics backend.
  }

  /** @ac common/Collision/Maps/MapTree.h VMAP::StaticMapTree::isTiled */
  isTiled(): boolean {
    return this.iIsTiled;
  }

  /** @ac common/Collision/Maps/MapTree.h VMAP::StaticMapTree::numLoadedTiles */
  numLoadedTiles(): number {
    return this.iLoadedTiles.size;
  }

  /** The tree entries and their count (`null` entries are slots whose tile is not loaded). @ac common/Collision/Maps/MapTree.cpp VMAP::StaticMapTree::GetModelInstances */
  GetModelInstances(): { models: (ModelInstance | null)[] | null; count: number } {
    return { models: this.iTreeValues, count: this.iNTreeValues };
  }
}

const losDist: FloatRef = { value: 0 };
