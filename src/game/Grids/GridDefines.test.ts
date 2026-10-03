import { describe, expect, test } from "bun:test";
import { Cell } from "./Cells/Cell.ts";
import {
  CellCoord,
  CENTER_GRID_CELL_ID,
  CENTER_GRID_ID,
  ComputeCellCoord,
  ComputeGridCoord,
  ComputeGridCoordSimple,
  GridCoord,
  IsValidMapCoord,
  MAP_HALFSIZE,
  MAX_NUMBER_OF_GRIDS,
  NormalizeMapCoord,
  SIZE_OF_GRID_CELL,
  SIZE_OF_GRIDS,
  TOTAL_NUMBER_OF_CELLS_PER_MAP,
} from "./GridDefines.ts";

describe("GridDefines constants", () => {
  test("match the C++ values", () => {
    expect(SIZE_OF_GRIDS).toBe(533.3333);
    expect(SIZE_OF_GRID_CELL).toBeCloseTo(66.6666625, 10);
    expect(CENTER_GRID_ID).toBe(32);
    expect(CENTER_GRID_CELL_ID).toBe(256);
    expect(TOTAL_NUMBER_OF_CELLS_PER_MAP).toBe(512);
    expect(MAP_HALFSIZE).toBeCloseTo(17066.6656, 4);
  });
});

describe("Acore::ComputeCellCoord / ComputeGridCoord", () => {
  // Northshire Abbey: x = -8949.95, y = -132.493
  // cell x: 256 - (-8949.95 / 66.6666625) = 256 + 134.2493 = 390.2493 -> 390
  // cell y: 256 - (-132.493 / 66.6666625) = 256 + 1.98740 = 257.9874 -> 257
  // grid x: 32 - (-8949.95 / 533.3333) = 32 + 16.78116 = 48.78 -> 48
  // grid y: 32 - (-132.493 / 533.3333) = 32 + 0.24842 = 32.25 -> 32
  test("Northshire", () => {
    const cell = ComputeCellCoord(-8949.95, -132.493);
    expect([cell.x_coord, cell.y_coord]).toEqual([390, 257]);
    expect(cell.isCoordValid()).toBe(true);
    expect(cell.getId()).toBe(257 * 512 + 390);

    const grid = ComputeGridCoord(-8949.95, -132.493);
    expect([grid.x_coord, grid.y_coord]).toEqual([48, 32]);
    expect(grid.getId()).toBe(32 * 64 + 48);

    // the cell's grid is the grid of the point; the cell inside the grid is 390 % 8, 257 % 8
    const c = new Cell(-8949.95, -132.493);
    expect([c.gridX(), c.gridY(), c.cellX(), c.cellY()]).toEqual([48, 32, 6, 1]);
    expect(c.getCellCoord().equals(cell)).toBe(true);
    expect(c.compute()).toEqual({ x: 390, y: 257 });
  });

  test("map origin is the center cell and grid", () => {
    expect(ComputeCellCoord(0, 0)).toMatchObject({ x_coord: 256, y_coord: 256 });
    expect(ComputeGridCoord(0, 0)).toMatchObject({ x_coord: 32, y_coord: 32 });
    // just below the origin on both axes still truncates into cell 256 (256 + 0.0015 -> 256)
    expect(ComputeCellCoord(-0.1, -0.1)).toMatchObject({ x_coord: 256, y_coord: 256 });
    // just above the origin: 256 - 0.0015 = 255.998 -> 255
    expect(ComputeCellCoord(0.1, 0.1)).toMatchObject({ x_coord: 255, y_coord: 255 });
  });

  test("clamps at 0 and overflows past the limit like the C++", () => {
    // 256 - 20000 / 66.67 = -44 -> max(0, -44) = 0
    expect(ComputeCellCoord(20000, 20000)).toMatchObject({ x_coord: 0, y_coord: 0 });
    // 256 + 300 = 556: outside the 512 cells, not valid until normalized
    const far = ComputeCellCoord(-20000, 0);
    expect(far.x_coord).toBe(556);
    expect(far.isCoordValid()).toBe(false);
    expect(far.normalize().x_coord).toBe(511);
  });

  test("ComputeGridCoordSimple mirrors the grid index", () => {
    // gx = trunc(32 + 16.78) = 48 -> 63 - 48 = 15; gy = trunc(32 + 0.25) = 32 -> 63 - 32 = 31
    const g = ComputeGridCoordSimple(-8949.95, -132.493);
    expect([g.x_coord, g.y_coord]).toEqual([15, 31]);
  });
});

describe("CoordPair", () => {
  test("inc and dec clamp to [0, LIMIT - 1]", () => {
    const g = new GridCoord(2, 62);
    g.dec_x(5);
    g.inc_y(5);
    expect([g.x_coord, g.y_coord]).toEqual([0, MAX_NUMBER_OF_GRIDS - 1]);
    g.inc_x(3);
    g.dec_y(3);
    expect([g.x_coord, g.y_coord]).toEqual([3, 60]);

    const c = new CellCoord(510, 1);
    c.inc_x(1);
    c.dec_y(1);
    expect([c.x_coord, c.y_coord]).toEqual([511, 0]);
    c.inc_x(1);
    expect(c.x_coord).toBe(511);
  });

  test("clone is an independent copy of the same limit", () => {
    const a = new CellCoord(5, 6);
    const b = a.clone();
    b.x_coord = 7;
    expect(a.x_coord).toBe(5);
    expect(b.LIMIT).toBe(512);
    expect(b).toBeInstanceOf(CellCoord);
  });
});

describe("NormalizeMapCoord / IsValidMapCoord", () => {
  test("normalize clamps to MAP_HALFSIZE - 0.5", () => {
    expect(NormalizeMapCoord(1e6)).toBe(MAP_HALFSIZE - 0.5);
    expect(NormalizeMapCoord(-1e6)).toBe(-(MAP_HALFSIZE - 0.5));
    expect(NormalizeMapCoord(123.5)).toBe(123.5);
  });

  test("valid coordinates are finite and inside the map", () => {
    expect(IsValidMapCoord(-8949.95, -132.493, 83.5, 1.0)).toBe(true);
    expect(IsValidMapCoord(MAP_HALFSIZE)).toBe(false);
    expect(IsValidMapCoord(0, Number.NaN)).toBe(false);
    expect(IsValidMapCoord(0, 0, 0, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
