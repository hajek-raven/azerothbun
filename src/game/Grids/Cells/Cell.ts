/**
 * @ac game/Grids/Cells/Cell.h
 * @ac game/Grids/Cells/CellImpl.h
 * A cell address (grid x/y and cell x/y inside the grid, 8 bits each like the C++ bit field union) and the walks over
 * the cells around a point.
 */
import type { WorldObject } from "../../Entities/Object/Object.ts";
import { CellCoord, ComputeCellCoord, MAX_NUMBER_OF_CELLS, SIZE_OF_GRIDS } from "../GridDefines.ts";
import type { MapLike } from "../MapLike.ts";
import { TypeContainerVisitor, type ContainerType, type FarVisibleVisitor, type GridTypeMapVisitor } from "../TypeContainer.ts";

/** @ac game/Grids/Cells/Cell.h CellArea */
export class CellArea {
  constructor(
    public low_bound: CellCoord = new CellCoord(),
    public high_bound: CellCoord = new CellCoord(),
  ) {}

  /** @ac game/Grids/Cells/Cell.h CellArea::operator! (true when the area is the single standing cell) */
  isEmpty(): boolean {
    return this.low_bound.equals(this.high_bound);
  }

  /** @ac game/Grids/Cells/Cell.h CellArea::ResizeBorders */
  resizeBorders(begin_cell: CellCoord, end_cell: CellCoord): void {
    begin_cell.x_coord = this.low_bound.x_coord;
    begin_cell.y_coord = this.low_bound.y_coord;
    end_cell.x_coord = this.high_bound.x_coord;
    end_cell.y_coord = this.high_bound.y_coord;
  }
}

/** @ac game/Grids/Cells/Cell.h Cell */
export class Cell {
  /** `data.Part`: each field is an 8 bit `unsigned` bit field. */
  grid_x = 0;
  grid_y = 0;
  cell_x = 0;
  cell_y = 0;

  /**
   * @ac game/Grids/Cells/Cell.h Cell::Cell
   * @ac game/Grids/Cells/CellImpl.h Cell::Cell
   * `Cell()`, `Cell(Cell const&)`, `Cell(CellCoord const&)`, and `Cell(float x, float y)`.
   */
  constructor();
  constructor(cell: Cell);
  constructor(p: CellCoord);
  constructor(x: number, y: number);
  constructor(a?: Cell | CellCoord | number, b?: number) {
    if (a === undefined) return;
    if (a instanceof Cell) {
      this.setAll(a.getAll());
      return;
    }
    const p = typeof a === "number" ? ComputeCellCoord(a, b ?? 0) : a;
    this.grid_x = Math.trunc(p.x_coord / MAX_NUMBER_OF_CELLS) & 0xff;
    this.grid_y = Math.trunc(p.y_coord / MAX_NUMBER_OF_CELLS) & 0xff;
    this.cell_x = p.x_coord % MAX_NUMBER_OF_CELLS & 0xff;
    this.cell_y = p.y_coord % MAX_NUMBER_OF_CELLS & 0xff;
  }

  /** `data.All` (grid_x in the low byte, like the little endian bit field). */
  getAll(): number {
    return (this.grid_x | (this.grid_y << 8) | (this.cell_x << 16) | (this.cell_y << 24)) >>> 0;
  }

  private setAll(all: number): void {
    this.grid_x = all & 0xff;
    this.grid_y = (all >>> 8) & 0xff;
    this.cell_x = (all >>> 16) & 0xff;
    this.cell_y = (all >>> 24) & 0xff;
  }

  /** @ac game/Grids/Cells/Cell.h Cell::Compute (the map-wide cell x/y; the reference parameters are the result) */
  compute(): { x: number; y: number } {
    return { x: this.grid_x * MAX_NUMBER_OF_CELLS + this.cell_x, y: this.grid_y * MAX_NUMBER_OF_CELLS + this.cell_y };
  }

  /** @ac game/Grids/Cells/Cell.h Cell::DiffCell */
  diffCell(cell: Cell): boolean {
    return this.cell_x !== cell.cell_x || this.cell_y !== cell.cell_y;
  }

  /** @ac game/Grids/Cells/Cell.h Cell::DiffGrid */
  diffGrid(cell: Cell): boolean {
    return this.grid_x !== cell.grid_x || this.grid_y !== cell.grid_y;
  }

  /** @ac game/Grids/Cells/Cell.h Cell::CellX */
  cellX(): number {
    return this.cell_x;
  }

  /** @ac game/Grids/Cells/Cell.h Cell::CellY */
  cellY(): number {
    return this.cell_y;
  }

  /** @ac game/Grids/Cells/Cell.h Cell::GridX */
  gridX(): number {
    return this.grid_x;
  }

  /** @ac game/Grids/Cells/Cell.h Cell::GridY */
  gridY(): number {
    return this.grid_y;
  }

  /** @ac game/Grids/Cells/Cell.h Cell::GetCellCoord */
  getCellCoord(): CellCoord {
    return new CellCoord(this.grid_x * MAX_NUMBER_OF_CELLS + this.cell_x, this.grid_y * MAX_NUMBER_OF_CELLS + this.cell_y);
  }

  /** @ac game/Grids/Cells/Cell.h Cell::operator= */
  assign(cell: Cell): this {
    this.setAll(cell.getAll());
    return this;
  }

  /** @ac game/Grids/Cells/Cell.h Cell::operator== */
  equals(cell: Cell): boolean {
    return this.getAll() === cell.getAll();
  }

  /**
   * @ac game/Grids/Cells/CellImpl.h Cell::Visit
   * `(standing_cell, visitor, map, WorldObject const& obj, radius)` widens the radius by the object's combat reach
   * (we should increase search radius by object's radius, otherwise we could have problems with huge creatures, which
   * won't attack nearest players etc); `(standing_cell, visitor, map, x, y, radius)` visits the cells around a point.
   */
  visit(standing_cell: CellCoord, visitor: TypeContainerVisitor<ContainerType>, map: MapLike, obj: WorldObject, radius: number): void;
  visit(standing_cell: CellCoord, visitor: TypeContainerVisitor<ContainerType>, map: MapLike, x_off: number, y_off: number, radius: number): void;
  visit(standing_cell: CellCoord, visitor: TypeContainerVisitor<ContainerType>, map: MapLike, objOrX: WorldObject | number, yOrRadius: number, radiusArg?: number): void {
    if (typeof objOrX !== "number") {
      this.visit(standing_cell, visitor, map, objOrX.getPositionX(), objOrX.getPositionY(), yOrRadius + objOrX.getCombatReach());
      return;
    }
    const x_off = objOrX;
    const y_off = yOrRadius;
    let radius = radiusArg ?? 0;

    if (!standing_cell.isCoordValid()) return;

    // no jokes here... Actually placing ASSERT() here was good idea, but
    // we had some problems with DynamicObjects, which pass radius = 0.0f (DB issue?)
    // maybe it is better to just return when radius <= 0.0f?
    if (radius <= 0.0) {
      map.visit(this, visitor);
      return;
    }
    // lets limit the upper value for search radius
    if (radius > SIZE_OF_GRIDS) radius = SIZE_OF_GRIDS;

    // lets calculate object coord offsets from cell borders.
    const area = Cell.calculateCellArea(x_off, y_off, radius);
    // if radius fits inside standing cell
    if (area.isEmpty()) {
      map.visit(this, visitor);
      return;
    }

    // visit all cells, found in CalculateCellArea()
    // if radius is known to reach cell area more than 4x4 then we should call optimized VisitCircle
    // currently this technique works with MAX_NUMBER_OF_CELLS 16 and higher, with lower values
    // there are nothing to optimize because SIZE_OF_GRID_CELL is too big...
    if (area.high_bound.x_coord > area.low_bound.x_coord + 4 && area.high_bound.y_coord > area.low_bound.y_coord + 4) {
      this.visitCircle(visitor, map, area.low_bound, area.high_bound);
      return;
    }

    // loop the cell range
    if (area.high_bound.x_coord < area.low_bound.x_coord || area.high_bound.y_coord < area.low_bound.y_coord) {
      throw new Error("Cell::Visit: inverted cell area");
    }
    for (let x = area.low_bound.x_coord; x <= area.high_bound.x_coord; ++x) {
      for (let y = area.low_bound.y_coord; y <= area.high_bound.y_coord; ++y) {
        const cellCoord = new CellCoord(x, y);
        const r_zone = new Cell(cellCoord);
        map.visit(r_zone, visitor);
      }
    }
  }

  /** @ac game/Grids/Cells/CellImpl.h Cell::CalculateCellArea */
  static calculateCellArea(x: number, y: number, radius: number): CellArea {
    if (radius <= 0.0) {
      const center = ComputeCellCoord(x, y).normalize();
      return new CellArea(center, center.clone());
    }

    const centerX = ComputeCellCoord(x + radius, y + radius).normalize();
    const centerY = ComputeCellCoord(x - radius, y - radius).normalize();

    return new CellArea(centerX, centerY);
  }

  /**
   * @ac game/Grids/Cells/CellImpl.h Cell::VisitCircle
   * here is an algorithm for 'filling' circum-squared octagon
   */
  private visitCircle(visitor: TypeContainerVisitor<ContainerType>, map: MapLike, begin_cell: CellCoord, end_cell: CellCoord): void {
    const x_shift = Math.max(0, Math.ceil((end_cell.x_coord - begin_cell.x_coord) * 0.3 - 0.5)) >>> 0;
    // lets calculate x_start/x_end coords for central strip...
    const x_start = begin_cell.x_coord + x_shift;
    const x_end = end_cell.x_coord - x_shift;

    // visit central strip with constant width...
    for (let x = x_start; x <= x_end; ++x) {
      for (let y = begin_cell.y_coord; y <= end_cell.y_coord; ++y) {
        const cellCoord = new CellCoord(x, y);
        const r_zone = new Cell(cellCoord);
        map.visit(r_zone, visitor);
      }
    }

    // if x_shift == 0 then we have too small cell area, which were already
    // visited at previous step, so just return from procedure...
    if (x_shift === 0) return;

    let y_start = end_cell.y_coord;
    let y_end = begin_cell.y_coord;
    // now we are visiting borders of an octagon...
    for (let step = 1; step <= x_start - begin_cell.x_coord; ++step) {
      // each step reduces strip height by 2 cells...
      y_end += 1;
      y_start -= 1;
      for (let y = y_start; y >= y_end; --y) {
        // we visit cells symmetrically from both sides, heading from center to sides and from up to bottom
        // e.g. filling 2 trapezoids after filling central cell strip...
        const cellCoord_left = new CellCoord(x_start - step, y);
        const r_zone_left = new Cell(cellCoord_left);
        map.visit(r_zone_left, visitor);

        // right trapezoid cell visit
        const cellCoord_right = new CellCoord(x_end + step, y);
        const r_zone_right = new Cell(cellCoord_right);
        map.visit(r_zone_right, visitor);
      }
    }
  }

  /**
   * @ac game/Grids/Cells/CellImpl.h Cell::VisitObjects
   * The grid objects (`GridTypeMapContainer`) in the cells within `radius` of the object or point.
   */
  static visitObjects(center_obj: WorldObject, visitor: GridTypeMapVisitor, radius: number): void;
  static visitObjects(x: number, y: number, map: MapLike, visitor: GridTypeMapVisitor, radius: number): void;
  static visitObjects(a: WorldObject | number, b: number | GridTypeMapVisitor, c: MapLike | number, d?: GridTypeMapVisitor, e?: number): void {
    if (typeof a !== "number") {
      Cell.visitObjects(a.getPositionX(), a.getPositionY(), a.getMap(), b as GridTypeMapVisitor, c as number);
      return;
    }
    const x = a;
    const y = b as number;
    const map = c as MapLike;
    const p = ComputeCellCoord(x, y);
    const cell = new Cell(p);

    const gnotifier = new TypeContainerVisitor(d as GridTypeMapVisitor, "GridTypeMapContainer");
    cell.visit(p, gnotifier, map, x, y, e ?? 0);
  }

  /**
   * @ac game/Grids/Cells/CellImpl.h Cell::VisitFarVisibleObjects
   * The far visible creatures and gameobjects (`FarVisibleGridContainer`) in the cells within `radius`.
   */
  static visitFarVisibleObjects(center_obj: WorldObject, visitor: FarVisibleVisitor, radius: number): void;
  static visitFarVisibleObjects(x: number, y: number, map: MapLike, visitor: FarVisibleVisitor, radius: number): void;
  static visitFarVisibleObjects(a: WorldObject | number, b: number | FarVisibleVisitor, c: MapLike | number, d?: FarVisibleVisitor, e?: number): void {
    if (typeof a !== "number") {
      Cell.visitFarVisibleObjects(a.getPositionX(), a.getPositionY(), a.getMap(), b as FarVisibleVisitor, c as number);
      return;
    }
    const x = a;
    const y = b as number;
    const map = c as MapLike;
    const p = ComputeCellCoord(x, y);
    const cell = new Cell(p);

    const gnotifier = new TypeContainerVisitor(d as FarVisibleVisitor, "FarVisibleGridContainer");
    cell.visit(p, gnotifier, map, x, y, e ?? 0);
  }
}
