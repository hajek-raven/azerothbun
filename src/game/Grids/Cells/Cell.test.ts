import { describe, expect, test } from "bun:test";
import type { WorldObject } from "../../Entities/Object/Object.ts";
import { VisibilityDistanceType } from "../../Entities/Object/ObjectDefines.ts";
import { ObjectGuid } from "../../Entities/Object/ObjectGuid.ts";
import { CellCoord, GridCoord, SIZE_OF_GRID_CELL, SIZE_OF_GRIDS } from "../GridDefines.ts";
import { FakeCreature, FakeMap, FakeObjectMgr, FakeGameObject } from "../Grids.test-util.ts";
import type { MapLike } from "../MapLike.ts";
import { TypeContainerVisitor, type GridTypeMapVisitor } from "../TypeContainer.ts";
import { Cell, CellArea } from "./Cell.ts";

const S = SIZE_OF_GRID_CELL;
const low = (o: WorldObject): number => ObjectGuid.GetCounter(o.getGUID());
/** The center of cell (390, 257): x = (256 - 390.5) * S, y = (256 - 257.5) * S. */
const CX = -134.5 * S;
const CY = -1.5 * S;

/** A `Map::Visit` that records the cells it is asked to visit. */
function recordingMap(): { map: MapLike; cells: string[] } {
  const cells: string[] = [];
  const map = {
    visit(cell: Cell) {
      const c = cell.getCellCoord();
      cells.push(`${c.x_coord},${c.y_coord}`);
    },
  } as unknown as MapLike;
  return { map, cells };
}

function visitAround(x: number, y: number, radius: number): string[] {
  const { map, cells } = recordingMap();
  const standing = new CellCoord(390, 257);
  new Cell(standing).visit(standing, new TypeContainerVisitor({}, "GridTypeMapContainer"), map, x, y, radius);
  return cells;
}

function rect(x0: number, x1: number, y0: number, y1: number): string[] {
  const out: string[] = [];
  for (let x = x0; x <= x1; ++x) for (let y = y0; y <= y1; ++y) out.push(`${x},${y}`);
  return out;
}

describe("Cell::CalculateCellArea", () => {
  const area = (r: number): number[] => {
    const a = Cell.calculateCellArea(CX, CY, r);
    return [a.low_bound.x_coord, a.low_bound.y_coord, a.high_bound.x_coord, a.high_bound.y_coord];
  };

  test("radius 0 and radii inside the cell are the standing cell", () => {
    expect(area(0)).toEqual([390, 257, 390, 257]);
    expect(Cell.calculateCellArea(CX, CY, 0).isEmpty()).toBe(true);
    // 10 / 66.67 = 0.15: 390.5 +- 0.15 stays in 390
    expect(area(10)).toEqual([390, 257, 390, 257]);
    expect(Cell.calculateCellArea(CX, CY, 10).isEmpty()).toBe(true);
  });

  test("larger radii", () => {
    // 40 / S = 0.6: 389.9 -> 389, 391.1 -> 391
    expect(area(40)).toEqual([389, 256, 391, 258]);
    // 120 / S = 1.8: 388.7 -> 388, 392.3 -> 392
    expect(area(120)).toEqual([388, 255, 392, 259]);
    // 200 / S = 3.0: 387.5 -> 387, 393.5 -> 393
    expect(area(200)).toEqual([387, 254, 393, 260]);
    expect(Cell.calculateCellArea(CX, CY, 40).isEmpty()).toBe(false);
  });

  test("ResizeBorders copies the bounds", () => {
    const a = new CellArea(new CellCoord(1, 2), new CellCoord(3, 4));
    const begin = new CellCoord();
    const end = new CellCoord();
    a.resizeBorders(begin, end);
    expect([begin.x_coord, begin.y_coord, end.x_coord, end.y_coord]).toEqual([1, 2, 3, 4]);
  });
});

describe("Cell::Visit", () => {
  test("radius 0 or inside the standing cell visits only that cell", () => {
    expect(visitAround(CX, CY, 0)).toEqual(["390,257"]);
    expect(visitAround(CX, CY, 10)).toEqual(["390,257"]);
  });

  test("a small area visits the full rectangle once", () => {
    expect(visitAround(CX, CY, 40).sort()).toEqual(rect(389, 391, 256, 258).sort());
    // 5x5 is not more than 4 cells wider than its low bound: plain loop
    expect(visitAround(CX, CY, 120).sort()).toEqual(rect(388, 392, 255, 259).sort());
  });

  test("a large area visits the octagon (VisitCircle)", () => {
    const cells = visitAround(CX, CY, 200);
    // x_shift = ceil(6 * 0.3 - 0.5) = 2: central strip x 389..391 over y 254..260 (21 cells),
    // step 1: x 388 and 392 over y 255..259 (10), step 2: x 387 and 393 over y 256..258 (6)
    const expected = [...rect(389, 391, 254, 260), ...rect(388, 388, 255, 259), ...rect(392, 392, 255, 259), ...rect(387, 387, 256, 258), ...rect(393, 393, 256, 258)];
    expect(cells.length).toBe(37);
    expect(new Set(cells).size).toBe(37);
    expect(cells.sort()).toEqual(expected.sort());
    // the corners of the 7x7 square are cut
    for (const corner of ["387,254", "393,254", "387,260", "393,260"]) expect(cells).not.toContain(corner);
  });

  test("the radius is capped at SIZE_OF_GRIDS", () => {
    expect(visitAround(CX, CY, 5000).sort()).toEqual(visitAround(CX, CY, SIZE_OF_GRIDS).sort());
  });

  test("an invalid standing cell visits nothing", () => {
    const { map, cells } = recordingMap();
    const standing = new CellCoord(600, 10);
    new Cell(new CellCoord(1, 1)).visit(standing, new TypeContainerVisitor({}, "GridTypeMapContainer"), map, CX, CY, 50);
    expect(cells).toEqual([]);
  });

  test("the object overload widens the radius by the combat reach", () => {
    const store = new FakeObjectMgr();
    const obj = new FakeCreature(store, 1, CX, CY);
    obj.getCombatReach = () => 30; // 10 + 30 = 40: the 3x3 area
    const { map, cells } = recordingMap();
    const standing = new CellCoord(390, 257);
    new Cell(standing).visit(standing, new TypeContainerVisitor({}, "GridTypeMapContainer"), map, obj, 10);
    expect(cells.sort()).toEqual(rect(389, 391, 256, 258).sort());
  });
});

describe("Cell::VisitObjects / VisitFarVisibleObjects", () => {
  function setup() {
    const store = new FakeObjectMgr();
    const map = new FakeMap();
    const make = (guid: number, dx: number) => {
      const c = new FakeCreature(store, guid, CX - dx, CY);
      map.place(c);
      return c;
    };
    // 0 and 30 yards: cell 390; 60 yards: 390.5 + 0.9 -> cell 391; 300 yards: cell 395
    const near = [make(1, 0), make(2, 30), make(3, 60)];
    const far = make(4, 300);
    return { store, map, near, far };
  }

  test("only objects in the cells within the radius are visited", () => {
    const { map, near } = setup();
    const seen: number[] = [];
    const visitor: GridTypeMapVisitor = { visitCreatureMap: (m) => seen.push(...[...m].map(low)) };
    Cell.visitObjects(CX, CY, map, visitor, 70);
    expect(seen.sort()).toEqual(near.map(low).sort());
  });

  test("the WorldObject overload visits around the object on its map", () => {
    const { map, near } = setup();
    const seen: number[] = [];
    Cell.visitObjects(near[0]!, { visitCreatureMap: (m) => seen.push(...[...m].map(low)) }, 70);
    expect(seen.length).toBe(3);
    // cells 390/391 are in grid 48, the 300 yard creature's cell 395 is in grid 49
    expect(map.gridManager.getLoadedGridsCount()).toBe(2);
  });

  test("cells of grids that are created but not loaded are skipped", () => {
    const { store, map } = setup();
    // grid y 33 holds cells 264..271: y = (256 - 264.5) * S
    const other = new FakeCreature(store, 9, CX, -8.5 * S);
    map.ensureGridCreated(new GridCoord(48, 33));
    other.setMap(map);
    map.gridManager.getGrid(48, 33)!.addGridObject(6, 0, other);
    const seen: number[] = [];
    Cell.visitObjects(CX, CY, map, { visitCreatureMap: (m) => seen.push(...[...m].map(low)) }, SIZE_OF_GRIDS);
    expect(seen).not.toContain(9);
    expect(seen).toContain(4);
  });

  test("far visible objects are in their own container", () => {
    const store = new FakeObjectMgr();
    const map = new FakeMap();
    const big = new FakeCreature(store, 1, CX, CY);
    big.setVisibilityDistanceOverride(VisibilityDistanceType.Large);
    map.place(big);
    const go = new FakeGameObject(store, 2, CX, CY);
    map.place(go);
    const creatures: number[] = [];
    const gameobjects: number[] = [];
    Cell.visitFarVisibleObjects(CX, CY, map, { visitCreatureVector: (v) => creatures.push(...v.map(low)), visitGameObjectVector: (v) => gameobjects.push(...v.map(low)) }, 10);
    expect(creatures).toEqual([1]);
    expect(gameobjects).toEqual([]);
  });
});
