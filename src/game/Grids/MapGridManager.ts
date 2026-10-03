/**
 * @ac game/Grids/MapGridManager.h
 * @ac game/Grids/MapGridManager.cpp
 * The grids of one map: created on first use (with their terrain), object data loaded once, unloaded when the map
 * unloads. This AzerothCore revision has no grid states or unload timers (the old `NGrid` / `GridState` machinery);
 * a grid lives until `Map::UnloadAll` unloads it.
 *
 * The C++ `std::mutex _gridLock` guards `CreateGrid` against parallel map threads. Maps update on one thread here, so
 * there is no lock.
 */
import { MAX_NUMBER_OF_GRIDS, GridCoord } from "./GridDefines.ts";
import { GridObjectCleaner, GridObjectLoader, GridObjectUnloader } from "./GridObjectLoader.ts";
import { GridTerrainLoader } from "./GridTerrainLoader.ts";
import { MapGrid } from "./MapGrid.ts";
import type { MapLike } from "./MapLike.ts";
import { TypeContainerVisitor } from "./TypeContainer.ts";

/** @ac game/Grids/MapGridManager.h MapGridManager */
export class MapGridManager {
  private _createdGridsCount = 0;
  private _loadedGridsCount = 0;

  private readonly _mapGrid: (MapGrid | null)[][] = Array.from({ length: MAX_NUMBER_OF_GRIDS }, () => Array<MapGrid | null>(MAX_NUMBER_OF_GRIDS).fill(null));

  /** @ac game/Grids/MapGridManager.h MapGridManager::MapGridManager */
  constructor(private readonly _map: MapLike) {}

  /** @ac game/Grids/MapGridManager.cpp MapGridManager::CreateGrid */
  createGrid(x: number, y: number): void {
    if (this.isGridCreated(x, y)) return;

    // If we are an instance, ensure parent map has already created the grid before proceeding.
    // Note: grid loading is locked and is safe across multiple map threads in the
    // event of multiple child maps attempting to create the same parent map grid
    if (this._map.getInstanceId() !== 0) {
      const parentMap = this._map.getParent();
      parentMap.ensureGridCreated(new GridCoord(x, y));
    }

    const grid = new MapGrid(x, y);
    grid.link(this._map);

    // Terrain is loading during create (should/can we move this to LoadGrid?)
    const loader = new GridTerrainLoader(grid, this._map);
    loader.loadTerrain();

    this._mapGrid[x]![y] = grid;

    ++this._createdGridsCount;
  }

  /** @ac game/Grids/MapGridManager.cpp MapGridManager::LoadGrid (loads objects, terrain already loaded in CreateGrid) */
  loadGrid(x: number, y: number): boolean {
    const grid = this.getGrid(x, y);
    if (!grid || grid.isObjectDataLoaded()) return false;

    // Must mark as loaded first, as GridObjectLoader spawning objects can attempt to recursively load the grid
    grid.setObjectDataLoaded();

    const loader = new GridObjectLoader(grid, this._map);
    loader.loadAllCellsInGrid();

    ++this._loadedGridsCount;
    return true;
  }

  /**
   * @ac game/Grids/MapGridManager.cpp MapGridManager::UnloadGrid
   * Dropping the `unique_ptr` destroys the grid, whose `GridReference` destructor unlinks it from the map; `unlink`
   * does that here. The C++ does not decrement the created / loaded counters, and neither does this.
   */
  unloadGrid(x: number, y: number): void {
    const grid = this.getGrid(x, y);
    if (!grid) return;

    {
      const worker = new GridObjectCleaner();
      const visitor = new TypeContainerVisitor(worker, "GridTypeMapContainer");
      grid.visitAllCells(visitor);
    }

    this._map.removeAllObjectsInRemoveList();

    {
      const worker = new GridObjectUnloader();
      const visitor = new TypeContainerVisitor(worker, "GridTypeMapContainer");
      grid.visitAllCells(visitor);
    }

    grid.unlink();
    this._mapGrid[x]![y] = null;
  }

  /** @ac game/Grids/MapGridManager.cpp MapGridManager::IsGridCreated */
  isGridCreated(x: number, y: number): boolean {
    if (!MapGridManager.isValidGridCoordinates(x, y)) return false;

    return (this._mapGrid[x]![y] ?? null) !== null;
  }

  /** @ac game/Grids/MapGridManager.cpp MapGridManager::IsGridLoaded */
  isGridLoaded(x: number, y: number): boolean {
    if (!MapGridManager.isValidGridCoordinates(x, y)) return false;

    const grid = this._mapGrid[x]![y] ?? null;
    return grid !== null && grid.isObjectDataLoaded();
  }

  /** @ac game/Grids/MapGridManager.cpp MapGridManager::GetGrid */
  getGrid(x: number, y: number): MapGrid | null {
    if (!MapGridManager.isValidGridCoordinates(x, y)) return null;

    return this._mapGrid[x]![y] ?? null;
  }

  /** @ac game/Grids/MapGridManager.h MapGridManager::IsValidGridCoordinates (the `uint16` arguments are never negative) */
  static isValidGridCoordinates(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < MAX_NUMBER_OF_GRIDS && y < MAX_NUMBER_OF_GRIDS;
  }

  /** @ac game/Grids/MapGridManager.cpp MapGridManager::GetCreatedGridsCount */
  getCreatedGridsCount(): number {
    return this._createdGridsCount;
  }

  /** @ac game/Grids/MapGridManager.cpp MapGridManager::GetLoadedGridsCount */
  getLoadedGridsCount(): number {
    return this._loadedGridsCount;
  }

  /** @ac game/Grids/MapGridManager.cpp MapGridManager::GetCreatedCellsInGridCount */
  getCreatedCellsInGridCount(x: number, y: number): number {
    const grid = this.getGrid(x, y);
    if (grid) return grid.getCreatedCellsCount();

    return 0;
  }

  /** @ac game/Grids/MapGridManager.cpp MapGridManager::GetCreatedCellsInMapCount */
  getCreatedCellsInMapCount(): number {
    let count = 0;
    for (let gridX = 0; gridX < MAX_NUMBER_OF_GRIDS; ++gridX) {
      for (let gridY = 0; gridY < MAX_NUMBER_OF_GRIDS; ++gridY) {
        const grid = this.getGrid(gridX, gridY);
        if (grid) count += grid.getCreatedCellsCount();
      }
    }
    return count;
  }

  /** @ac game/Grids/MapGridManager.cpp MapGridManager::IsGridsFullyCreated */
  isGridsFullyCreated(): boolean {
    return this._createdGridsCount === MAX_NUMBER_OF_GRIDS * MAX_NUMBER_OF_GRIDS;
  }

  /** @ac game/Grids/MapGridManager.cpp MapGridManager::IsGridsFullyLoaded */
  isGridsFullyLoaded(): boolean {
    return this._loadedGridsCount === MAX_NUMBER_OF_GRIDS * MAX_NUMBER_OF_GRIDS;
  }
}
