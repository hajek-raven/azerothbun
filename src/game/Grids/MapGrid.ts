/**
 * @ac game/Grids/MapGrid.h MapGrid
 * One grid of a map: `MAX_NUMBER_OF_CELLS` x `MAX_NUMBER_OF_CELLS` cells, created on first use, plus the terrain data the
 * terrain loader attached.
 */
import { GridCell } from "./GridCell.ts";
import type { GridTerrainData } from "./GridTerrainData.ts";
import { MAX_NUMBER_OF_CELLS, MAX_NUMBER_OF_GRIDS } from "./GridDefines.ts";
import type { GridRefMgr } from "./GridRefMgr.ts";
import { GridReference } from "./GridReference.ts";
import type { ContainerType, FarVisibleObject, GridStoredObject, TypeContainerVisitor } from "./TypeContainer.ts";

/** `std::shared_ptr<GridTerrainData>`: the terrain stream's `GridTerrainData` (`src/game/Grids/GridTerrainData.ts`). */
export type MapGridTerrainData = GridTerrainData;

export class MapGrid {
  private readonly _cells: (GridCell | null)[][] = Array.from({ length: MAX_NUMBER_OF_CELLS }, () => Array<GridCell | null>(MAX_NUMBER_OF_CELLS).fill(null));
  private readonly _gridReference = new GridReference<MapGrid>();
  private _objectDataLoaded = false;
  /** Instances will share a copy of the parent maps terrainData */
  private _terrainData: MapGridTerrainData | null = null;

  /** @ac game/Grids/MapGrid.h MapGrid::MapGrid */
  constructor(
    private readonly _x: number,
    private readonly _y: number,
  ) {}

  /** @ac game/Grids/MapGrid.h MapGrid::GetId (unique identifier for grid) */
  getId(): number {
    return this._y * MAX_NUMBER_OF_GRIDS + this._x;
  }

  /** @ac game/Grids/MapGrid.h MapGrid::GetX */
  getX(): number {
    return this._x;
  }

  /** @ac game/Grids/MapGrid.h MapGrid::GetY */
  getY(): number {
    return this._y;
  }

  /** @ac game/Grids/MapGrid.h MapGrid::IsObjectDataLoaded */
  isObjectDataLoaded(): boolean {
    return this._objectDataLoaded;
  }

  /** @ac game/Grids/MapGrid.h MapGrid::SetObjectDataLoaded */
  setObjectDataLoaded(): void {
    this._objectDataLoaded = true;
  }

  /** @ac game/Grids/MapGrid.h MapGrid::AddGridObject */
  addGridObject(x: number, y: number, obj: GridStoredObject): void {
    this.getOrCreateCell(x, y).addGridObject(obj);
  }

  /**
   * @ac game/Grids/MapGrid.h MapGrid::RemoveGridObject
   * The C++ template calls a `GridCell::RemoveGridObject` that does not exist and is never instantiated; objects leave
   * their cell through `GridObject::RemoveFromGrid`, which is what this does.
   */
  removeGridObject(x: number, y: number, obj: GridStoredObject): void {
    this.getOrCreateCell(x, y);
    if (obj.isInGrid()) obj.removeFromGrid();
  }

  /** @ac game/Grids/MapGrid.h MapGrid::AddFarVisibleObject */
  addFarVisibleObject(x: number, y: number, obj: FarVisibleObject): void {
    this.getOrCreateCell(x, y).addFarVisibleObject(obj);
  }

  /** @ac game/Grids/MapGrid.h MapGrid::RemoveFarVisibleObject */
  removeFarVisibleObject(x: number, y: number, obj: FarVisibleObject): void {
    this.getOrCreateCell(x, y).removeFarVisibleObject(obj);
  }

  /** @ac game/Grids/MapGrid.h MapGrid::VisitAllCells */
  visitAllCells(visitor: TypeContainerVisitor<ContainerType>): void {
    for (const cellX of this._cells) {
      for (const cellY of cellX) {
        if (!cellY) continue;
        cellY.visit(visitor);
      }
    }
  }

  /** @ac game/Grids/MapGrid.h MapGrid::VisitCell (visit single cell) */
  visitCell(x: number, y: number, visitor: TypeContainerVisitor<ContainerType>): void {
    const gridCell = this.getCell(x, y);
    if (!gridCell) return;
    gridCell.visit(visitor);
  }

  /** @ac game/Grids/MapGrid.h MapGrid::link */
  link(pTo: GridRefMgr<MapGrid>): void {
    this._gridReference.link(pTo, this);
  }

  /** The `GridReference` destructor: a deleted grid leaves its map's grid list. */
  unlink(): void {
    this._gridReference.unlink();
  }

  /** @ac game/Grids/MapGrid.h MapGrid::GetTerrainData */
  getTerrainData(): MapGridTerrainData | null {
    return this._terrainData;
  }

  /** @ac game/Grids/MapGrid.h MapGrid::GetTerrainDataSharedPtr */
  getTerrainDataSharedPtr(): MapGridTerrainData | null {
    return this._terrainData;
  }

  /** @ac game/Grids/MapGrid.h MapGrid::SetTerrainData */
  setTerrainData(terrainData: MapGridTerrainData | null): void {
    this._terrainData = terrainData;
  }

  /** @ac game/Grids/MapGrid.h MapGrid::GetCreatedCellsCount */
  getCreatedCellsCount(): number {
    let count = 0;
    for (const cellX of this._cells) {
      for (const cellY of cellX) {
        if (!cellY) continue;
        ++count;
      }
    }
    return count;
  }

  /** @ac game/Grids/MapGrid.h MapGrid::GetOrCreateCell (creates and returns the cell if not already created) */
  private getOrCreateCell(x: number, y: number): GridCell {
    let cell = this.getCell(x, y);
    if (!cell) {
      cell = new GridCell();
      this._cells[x]![y] = cell;
    }
    return cell;
  }

  /** @ac game/Grids/MapGrid.h MapGrid::GetCell */
  getCell(x: number, y: number): GridCell | null {
    if (!(x < MAX_NUMBER_OF_CELLS && y < MAX_NUMBER_OF_CELLS)) throw new Error(`MapGrid::GetCell: cell ${x},${y} out of range`);
    return this._cells[x]![y] ?? null;
  }
}
