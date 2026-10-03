/**
 * Port of `common/Collision/Management/MMapMgr.{h,cpp}` (namespace `MMAP`).
 *
 * AzerothCore's `MMapMgr` is stateless: `loadNavMesh` reads `MMM.mmap` and creates the map's `dtNavMesh`,
 * `loadTile` adds one `MMMXXYY.mmtile` to it, and `createNavMeshQuery` makes the per-map query object. Which maps
 * and instances own which nav mesh is decided by `MapCollisionData` / `MMapData` (`game/Maps/MapCollisionData`),
 * which also checks `DisableMgr::IsPathfindingEnabled` (`MoveMaps.Enable` and the disables table).
 *
 * The C++ reads `DataDir` from the config; here the caller sets it once with `MMapMgr.setDataDir`.
 * Files are read through a private `Bun.mmap` (the synchronous `fread`); the tile blob is copied into a `dtAlloc`
 * block like the C++ does, so Detour owns plain memory and a rewritten `.mmtile` cannot fault a live mapping.
 * Log lines use the C++ `"maps"` category.
 */
import { DT_ALLOC_PERM, dtAlloc, dtFree } from "../../Detour/DetourAlloc.ts";
import { DT_TILE_FREE_DATA, dtNavMesh, dtNavMeshParams, DT_SIZEOF_NAVMESH_PARAMS, dtAllocNavMesh, dtFreeNavMesh, dtMeshHeader } from "../../Detour/DetourNavMesh.ts";
import { dtAllocNavMeshQuery, dtFreeNavMeshQuery, type dtNavMeshQuery } from "../../Detour/DetourNavMeshQuery.ts";
import { DT_SUCCESS, dtStatusFailed, dtStatusSucceed } from "../../Detour/DetourStatus.ts";
import { logDebug, logError } from "../../../log.ts";
import { MMAP_MAGIC, MMAP_VERSION, MmapTileHeader, SIZEOF_MMAP_TILE_HEADER } from "./MMapDefines.ts";

/**
 * `dtCustomAlloc` / `dtCustomFree`: the `new[]` / `delete[]` allocator `MMapMgr.h` defines for Detour.
 * @ac common/Collision/Management/MMapMgr.h dtCustomAlloc
 * @ac-skip memory is garbage collected; `dtAlloc` returns a fresh `Uint8Array`
 */
export function dtCustomAlloc(size: number): Uint8Array {
  return new Uint8Array(size);
}

/**
 * @ac common/Collision/Management/MMapMgr.h dtCustomFree
 * @ac-skip memory is garbage collected
 */
export function dtCustomFree(_ptr: Uint8Array): void {}

/** @ac common/Collision/Management/MMapMgr.h MMAP::MMAP_LOAD_RESULT */
export const MMAP_LOAD_RESULT = {
  MMAP_LOAD_RESULT_ERROR: 0,
  MMAP_LOAD_RESULT_OK: 1,
  MMAP_LOAD_RESULT_IGNORED: 2,
} as const;
export type MMAP_LOAD_RESULT = (typeof MMAP_LOAD_RESULT)[keyof typeof MMAP_LOAD_RESULT];
export const MMAP_LOAD_RESULT_ERROR = MMAP_LOAD_RESULT.MMAP_LOAD_RESULT_ERROR;
export const MMAP_LOAD_RESULT_OK = MMAP_LOAD_RESULT.MMAP_LOAD_RESULT_OK;
export const MMAP_LOAD_RESULT_IGNORED = MMAP_LOAD_RESULT.MMAP_LOAD_RESULT_IGNORED;

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** `"{}/mmaps/{:03}.mmap"` @ac common/Collision/Management/MMapMgr.h MMAP::MAP_FILE_NAME_FORMAT */
export function MAP_FILE_NAME_FORMAT(dataDir: string, mapId: number): string {
  return `${dataDir}/mmaps/${pad(mapId, 3)}.mmap`;
}

/** `"{}/mmaps/{:03}{:02}{:02}.mmtile"` @ac common/Collision/Management/MMapMgr.h MMAP::TILE_FILE_NAME_FORMAT */
export function TILE_FILE_NAME_FORMAT(dataDir: string, mapId: number, x: number, y: number): string {
  return `${dataDir}/mmaps/${pad(mapId, 3)}${pad(x, 2)}${pad(y, 2)}.mmtile`;
}

/**
 * `std::unique_ptr<dtNavMeshQuery, NavMeshQueryDeleter>`; the query is garbage collected.
 * @ac common/Collision/Management/MMapMgr.h MMAP::ManagedNavMeshQuery
 */
export type ManagedNavMeshQuery = dtNavMeshQuery;

/**
 * @ac common/Collision/Management/MMapMgr.h MMAP::NavMeshDeleter
 * @ac-skip shared_ptr deleter; `dtFreeNavMesh` is exported for owners that want to release tile data early
 */
export const NavMeshDeleter = (navMesh: dtNavMesh): void => dtFreeNavMesh(navMesh);

/**
 * @ac common/Collision/Management/MMapMgr.h MMAP::NavMeshQueryDeleter
 * @ac-skip unique_ptr deleter; the query is garbage collected
 */
export const NavMeshQueryDeleter = (query: dtNavMeshQuery): void => dtFreeNavMeshQuery(query);

/** Maps a whole file privately (copy-on-write); null when it does not exist or cannot be mapped. */
function mapFile(fileName: string): Uint8Array | null {
  try {
    return Bun.mmap(fileName, { shared: false });
  } catch {
    return null;
  }
}

/** @ac common/Collision/Management/MMapMgr.h MMAP::MMapMgr */
export class MMapMgr {
  /** `sConfigMgr->GetOption<std::string>("DataDir", ".")`, set by the caller. */
  private static dataDir = ".";

  /** Sets the `DataDir` the `mmaps/` directory is read from (the C++ reads it from the config). */
  static setDataDir(dataDir: string): void {
    MMapMgr.dataDir = dataDir;
  }

  static getDataDir(): string {
    return MMapMgr.dataDir;
  }

  /**
   * Loads and inits the map's `dtNavMesh` from the `dtNavMeshParams` in `mmaps/MMM.mmap`.
   * @ac common/Collision/Management/MMapMgr.cpp MMAP::MMapMgr::LoadNavMesh
   */
  static loadNavMesh(mapId: number): dtNavMesh | null {
    // load and init dtNavMesh - read parameters from file
    const fileName = MAP_FILE_NAME_FORMAT(MMapMgr.dataDir, mapId);

    const file = mapFile(fileName);
    if (!file) {
      logDebug("maps", `MMAP:loadMapData: Error: Could not open mmap file '${fileName}'`);
      return null;
    }

    if (file.length < DT_SIZEOF_NAVMESH_PARAMS) {
      logDebug("maps", `MMAP:loadMapData: Error: Could not read params from file '${fileName}'`);
      return null;
    }
    const params = dtNavMeshParams.fromBytes(file);

    const mesh = dtAllocNavMesh();
    if (DT_SUCCESS !== mesh.init(params)) {
      dtFreeNavMesh(mesh);
      logError("maps", `MMAP:loadMapData: Failed to initialize dtNavMesh for mmap ${pad(mapId, 3)} from file ${fileName}`);
      return null;
    }

    logDebug("maps", `MMAP:loadMapData: Loaded ${pad(mapId, 3)}.mmap`);

    return mesh;
  }

  /** @ac common/Collision/Management/MMapMgr.cpp MMAP::MMapMgr::packTileID */
  static packTileID(x: number, y: number): number {
    return ((x << 16) | y) >>> 0;
  }

  /**
   * Loads `mmaps/MMMXXYY.mmtile` into `navMesh`. The tile blob stays in the private file mapping; Detour owns it
   * (`DT_TILE_FREE_DATA`) until the tile is removed.
   * @ac common/Collision/Management/MMapMgr.cpp MMAP::MMapMgr::LoadTile
   */
  static loadTile(navMesh: dtNavMesh, mapId: number, x: number, y: number): boolean {
    // load this tile :: mmaps/MMMXXYY.mmtile
    const fileName = TILE_FILE_NAME_FORMAT(MMapMgr.dataDir, mapId, x, y);
    const file = mapFile(fileName);
    if (!file) {
      logDebug("maps", `MMAP:loadMap: Could not open mmtile file '${fileName}'`);
      return false;
    }

    // read header
    const fileHeader = MmapTileHeader.fromBytes(file);
    if (!fileHeader || fileHeader.mmapMagic !== MMAP_MAGIC) {
      logError("maps", `MMAP:loadMap: Bad header in mmap ${pad(mapId, 3)}${pad(x, 2)}${pad(y, 2)}.mmtile`);
      return false;
    }

    if (fileHeader.mmapVersion !== MMAP_VERSION) {
      logError(
        "maps",
        `MMAP:loadMap: ${pad(mapId, 3)}${pad(x, 2)}${pad(y, 2)}.mmtile was built with generator v${fileHeader.mmapVersion}, expected v${MMAP_VERSION}`,
      );
      return false;
    }

    const data = dtAlloc(fileHeader.size, DT_ALLOC_PERM);
    if (!data) throw new Error(`ASSERT failed: data (MMapMgr::LoadTile ${fileName})`);

    // fread(data, fileHeader.size, 1, file) fails on a short file and on size 0.
    if (file.length - SIZEOF_MMAP_TILE_HEADER < fileHeader.size || fileHeader.size === 0) {
      logError("maps", `MMAP:loadMap: Bad header or data in mmap ${pad(mapId, 3)}${pad(x, 2)}${pad(y, 2)}.mmtile`);
      return false;
    }
    data.set(file.subarray(SIZEOF_MMAP_TILE_HEADER, SIZEOF_MMAP_TILE_HEADER + fileHeader.size));

    const tileRef = new Float64Array(1);

    // memory allocated for data is now managed by detour, and will be deallocated when the tile is removed
    if (dtStatusSucceed(navMesh.addTile(data, fileHeader.size, DT_TILE_FREE_DATA, 0, tileRef))) {
      const header = new dtMeshHeader(data.buffer, data.byteOffset);
      logDebug(
        "maps",
        `MMAP:loadMap: Loaded mmtile ${pad(mapId, 3)}[${pad(x, 2)},${pad(y, 2)}] into ${pad(mapId, 3)}[${pad(header.x, 2)},${pad(header.y, 2)}]`,
      );
      return true;
    }

    logError("maps", `MMAP:loadMap: Could not load ${pad(mapId, 3)}${pad(x, 2)}${pad(y, 2)}.mmtile into navmesh`);
    dtFree(data);
    return false;
  }

  /**
   * Creates the query object for a map's nav mesh (1024 search nodes).
   * @ac common/Collision/Management/MMapMgr.cpp MMAP::MMapMgr::CreateNavMeshQuery
   */
  static createNavMeshQuery(navMesh: dtNavMesh): ManagedNavMeshQuery | null {
    // allocate mesh query
    const query = dtAllocNavMeshQuery();

    if (dtStatusFailed(query.init(navMesh, 1024))) {
      dtFreeNavMeshQuery(query);
      return null;
    }

    return query;
  }
}
