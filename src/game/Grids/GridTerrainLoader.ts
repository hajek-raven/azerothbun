/**
 * `GridTerrainLoader.h/.cpp`: loads the `.map`, vmap and mmap data of one map grid.
 *
 * `Map`, `MapGrid`, `VMapMgr2`, `MMapMgr` and `ScriptMgr` belong to other topics, so the loader talks to them through
 * the small structural interfaces below (the real classes satisfy them) and typed hooks.
 *
 * Terrain data is shared per grid, as the `std::shared_ptr<GridTerrainData>` of C++ is: an instance map points at the
 * parent map's data (`Map::GetGridTerrainDataSharedPtr`), and every load of a `.map` file goes through a weak cache keyed
 * by file name, so two `Map` objects of one map id never hold two copies of one grid. The cache holds `WeakRef`s: when
 * the last grid drops its reference the data (and its file mapping) is garbage collected.
 */
import { logDebug, logError } from "../../log.ts";
import { GridTerrainData, MapMagic, MapVersionMagic, readMapFileHeader, sizeof_map_fileheader, TerrainMapDataReadResult } from "./GridTerrainData.ts";

/** `GridCoord` (`CoordPair<MAX_NUMBER_OF_GRIDS>`): the fields `Map::GetGridTerrainDataSharedPtr` reads. */
export type GridTerrainCoord = { x_coord: number; y_coord: number };

/** The part of `MapGridType` (`MapGrid`) the loader uses. `shared_ptr` / `unique_ptr` are plain references here. */
export interface GridTerrainLoaderGrid {
  getX(): number;
  getY(): number;
  getTerrainData(): GridTerrainData | null;
  setTerrainData(terrainData: GridTerrainData | null): void;
}

/** The part of `Map` the loader uses. */
export interface GridTerrainLoaderMap {
  getInstanceId(): number;
  getId(): number;
  getMapName(): string;
  getParent(): { getGridTerrainDataSharedPtr(gridCoord: GridTerrainCoord): GridTerrainData | null };
  /** `MapCollisionData`: the vmap and mmap tile loads, returning `VMAP_LOAD_RESULT_*` / `MMAP_LOAD_RESULT_*`. */
  getMapCollisionData(): { loadVMapTile(x: number, y: number): number; loadMMapTile(x: number, y: number): number };
}

/** The part of `VMAP::IVMapMgr` that `ExistVMap` uses. `existsMap` returns a `VMAP::LoadResult` value. */
export interface GridTerrainLoaderVMapMgr {
  isMapLoadingEnabled(): boolean;
  existsMap(basePath: string, mapId: number, x: number, y: number): number;
  getDirFileName(mapId: number, x: number, y: number): string;
}

// `VMAP::VMAPLoadResult` (IVMapMgr.h), `MMAP::MMAPLoadResult` (MMapMgr.h) and `VMAP::LoadResult` (IVMapMgr.h)
const VMAP_LOAD_RESULT_ERROR = 0;
const VMAP_LOAD_RESULT_OK = 1;
const VMAP_LOAD_RESULT_IGNORED = 2;
const MMAP_LOAD_RESULT_ERROR = 0;
const MMAP_LOAD_RESULT_OK = 1;
const MMAP_LOAD_RESULT_IGNORED = 2;
const LOAD_RESULT_SUCCESS = 0;
const LOAD_RESULT_FILE_NOT_FOUND = 1;
const LOAD_RESULT_VERSION_MISMATCH = 2;

/**
 * What the loader takes from other topics. The integration code sets them at startup.
 * - `getDataPath`: `sWorld->GetDataPath()` (`DataDir`, ends with a slash)
 * - `getVMapMgr`: `VMAP::VMapFactory::createOrGetVMapMgr()`
 * - `onLoadGridMap`: `sScriptMgr->OnLoadGridMap` (@ac-skip: ScriptMgr is not ported)
 */
export const GridTerrainLoaderHooks: {
  getDataPath: () => string;
  getVMapMgr: () => GridTerrainLoaderVMapMgr | null;
  onLoadGridMap: (map: GridTerrainLoaderMap, terrainData: GridTerrainData | null, x: number, y: number) => void;
} = {
  getDataPath: () => "data/",
  getVMapMgr: () => null,
  onLoadGridMap: () => {},
};

function dataPath(): string {
  const path = GridTerrainLoaderHooks.getDataPath();
  return path.endsWith("/") ? path : `${path}/`;
}

/** `Acore::StringFormat("{}maps/{:03}{:02}{:02}.map", sWorld->GetDataPath(), mapid, gx, gy)` */
export function mapFileName(mapid: number, gx: number, gy: number): string {
  return `${dataPath()}maps/${String(mapid).padStart(3, "0")}${String(gx).padStart(2, "0")}${String(gy).padStart(2, "0")}.map`;
}

// Weak cache of the loaded grids, keyed by map file name.
const sharedTerrainData = new Map<string, WeakRef<GridTerrainData>>();
const sharedTerrainRelease = new FinalizationRegistry<string>((fileName) => {
  if (!sharedTerrainData.get(fileName)?.deref()) sharedTerrainData.delete(fileName);
});

/** The live terrain data of a map file, if some grid still holds it. */
export function getSharedGridTerrainData(fileName: string): GridTerrainData | null {
  return sharedTerrainData.get(fileName)?.deref() ?? null;
}

/** Forgets every cached grid (the grids that hold their data keep it). Used after the files change on disk. */
export function clearSharedGridTerrainData(): void {
  sharedTerrainData.clear();
}

function fourcc(value: number): string {
  return String.fromCharCode(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/** @ac game/Grids/GridTerrainLoader.h GridTerrainLoader */
export class GridTerrainLoader {
  constructor(
    private readonly _grid: GridTerrainLoaderGrid,
    private readonly _map: GridTerrainLoaderMap,
  ) {}

  /** @ac game/Grids/GridTerrainLoader.cpp GridTerrainLoader::LoadTerrain */
  loadTerrain(): void {
    this.loadMap();

    if (this._map.getInstanceId() === 0) {
      this.loadVMap();
      this.loadMMap();
    }
  }

  /** @ac game/Grids/GridTerrainLoader.cpp GridTerrainLoader::LoadMap */
  private loadMap(): void {
    // Instances will point to the parent maps terrain data, no need to load anything.
    if (this._map.getInstanceId() !== 0) {
      const parentMap = this._map.getParent();
      this._grid.setTerrainData(parentMap.getGridTerrainDataSharedPtr({ x_coord: this._grid.getX(), y_coord: this._grid.getY() }));
      return;
    }

    // map file name
    const fileName = mapFileName(this._map.getId(), this._grid.getX(), this._grid.getY());

    // a grid of this file that is still alive is shared instead of read again
    const shared = getSharedGridTerrainData(fileName);
    if (shared) {
      this._grid.setTerrainData(shared);
    } else {
      // loading data
      logDebug("world", `Loading map ${fileName}`);
      const terrainData = new GridTerrainData();
      const loadResult = terrainData.load(fileName);
      if (loadResult === TerrainMapDataReadResult.Success) {
        this._grid.setTerrainData(terrainData);
        sharedTerrainData.set(fileName, new WeakRef(terrainData));
        sharedTerrainRelease.register(terrainData, fileName);
      } else if (loadResult === TerrainMapDataReadResult.InvalidMagic) {
        logError("world", `Map file '${fileName}' is from an incompatible clientversion. Please recreate using the mapextractor.`);
      } else {
        logDebug("world", `Error (result: ${loadResult}) loading map file: ${fileName}`);
      }
    }

    GridTerrainLoaderHooks.onLoadGridMap(this._map, this._grid.getTerrainData(), this._grid.getX(), this._grid.getY());
  }

  /** @ac game/Grids/GridTerrainLoader.cpp GridTerrainLoader::LoadVMap */
  private loadVMap(): void {
    const x = this._grid.getX();
    const y = this._grid.getY();
    const vmapLoadResult = this._map.getMapCollisionData().loadVMapTile(x, y);
    switch (vmapLoadResult) {
      case VMAP_LOAD_RESULT_OK:
        logDebug("world", `VMAP loaded name:${this._map.getMapName()}, id:${this._map.getId()}, x:${x}, y:${y} (vmap rep.: x:${x}, y:${y})`);
        break;
      case VMAP_LOAD_RESULT_ERROR:
        logDebug("world", `Could not load VMAP name:${this._map.getMapName()}, id:${this._map.getId()}, x:${x}, y:${y} (vmap rep.: x:${x}, y:${y})`);
        break;
      case VMAP_LOAD_RESULT_IGNORED:
        logDebug("world", `Ignored VMAP name:${this._map.getMapName()}, id:${this._map.getId()}, x:${x}, y:${y} (vmap rep.: x:${x}, y:${y})`);
        break;
      default:
        break;
    }
  }

  /** @ac game/Grids/GridTerrainLoader.cpp GridTerrainLoader::LoadMMap */
  private loadMMap(): void {
    const x = this._grid.getX();
    const y = this._grid.getY();
    const mmapLoadResult = this._map.getMapCollisionData().loadMMapTile(x, y);
    switch (mmapLoadResult) {
      case MMAP_LOAD_RESULT_OK:
        logDebug("world", `MMAP loaded name:${this._map.getMapName()}, id:${this._map.getId()}, x:${x}, y:${y} (vmap rep.: x:${x}, y:${y})`);
        break;
      case MMAP_LOAD_RESULT_ERROR:
        logDebug("world", `Could not load MMAP name:${this._map.getMapName()}, id:${this._map.getId()}, x:${x}, y:${y} (vmap rep.: x:${x}, y:${y})`);
        break;
      case MMAP_LOAD_RESULT_IGNORED:
        logDebug("world", `Ignored MMAP name:${this._map.getMapName()}, id:${this._map.getId()}, x:${x}, y:${y} (vmap rep.: x:${x}, y:${y})`);
        break;
      default:
        break;
    }
  }

  /** @ac game/Grids/GridTerrainLoader.cpp GridTerrainLoader::ExistMap */
  static existMap(mapid: number, gx: number, gy: number): boolean {
    const fileName = mapFileName(mapid, gx, gy);
    let bytes: Uint8Array;
    try {
      bytes = Bun.mmap(fileName, { shared: false, size: sizeof_map_fileheader });
    } catch (error) {
      // `ifstream::fail()` for a file that cannot be opened; an empty file fails the header read
      if ((error as { code?: string }).code === "EINVAL") logDebug("world", `Map file '${fileName}': unable to read header`);
      else logDebug("world", `Map file '${fileName}': error opening file`);
      return false;
    }

    if (bytes.byteLength < sizeof_map_fileheader) {
      logDebug("world", `Map file '${fileName}': unable to read header`);
      return false;
    }

    const header = readMapFileHeader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0);
    if (header.mapMagic !== MapMagic.asUInt || header.versionMagic !== MapVersionMagic) {
      logError(
        "world",
        `Map file '${fileName}' is from an incompatible map version (${fourcc(header.mapMagic)} v${header.versionMagic}), ${MapMagic.asChar} v${MapVersionMagic} is expected. Please pull your source, recompile tools and recreate maps using the updated mapextractor, then replace your old map files with new files.`,
      );
      return false;
    }

    return true;
  }

  /** @ac game/Grids/GridTerrainLoader.cpp GridTerrainLoader::ExistVMap */
  static existVMap(mapid: number, gx: number, gy: number): boolean {
    const vmgr = GridTerrainLoaderHooks.getVMapMgr();
    if (vmgr) {
      if (vmgr.isMapLoadingEnabled()) {
        const result = vmgr.existsMap(`${dataPath()}vmaps`, mapid, gx, gy);
        const name = vmgr.getDirFileName(mapid, gx, gy);
        switch (result) {
          case LOAD_RESULT_SUCCESS:
            break;
          case LOAD_RESULT_FILE_NOT_FOUND:
            logDebug("world", `VMap file '${dataPath()}vmaps/${name}' does not exist`);
            logDebug(
              "world",
              `Please place VMAP files (*.vmtree and *.vmtile) in the vmap directory (${dataPath()}vmaps/), or correct the DataDir setting in your worldserver.conf file.`,
            );
            return false;
          case LOAD_RESULT_VERSION_MISMATCH:
            logError("world", `VMap file '${dataPath()}vmaps/${name}' couldn't be loaded`);
            logError("world", "This is because the version of the VMap file and the version of this module are different, please re-extract the maps with the tools compiled with this module.");
            return false;
        }
      }
    }

    return true;
  }
}
