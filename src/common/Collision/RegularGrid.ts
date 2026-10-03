import type { AABox } from "../../math/AABox.ts";
import type { Ray } from "../../math/Ray.ts";
import { Vector3 } from "../../math/Vector3.ts";
import type { FloatRef } from "./BoundingIntervalHierarchy.ts";

/** What a grid cell (`Node`) must offer: the `BIHWrap` interface. */
export interface RegularGridNode<T, RayCb, PointCb> {
  insert(value: T): void;
  remove(value: T): void;
  balance(): void;
  intersectRay(ray: Ray, callback: RayCb, maxDist: FloatRef, stopAtFirstHit: boolean): void;
  intersectPoint(point: Vector3, callback: PointCb): void;
}

/** What a grid member must offer (`value.GetBounds()`). */
export interface RegularGridMember {
  GetBounds(): AABox;
}

/**
 * The (at most 9) cells one member was inserted into.
 *
 * @ac common/Collision/RegularGrid.h NodeArray
 */
export class NodeArray<Node> {
  readonly _nodes: (Node | null)[] = [null, null, null, null, null, null, null, null, null];

  /** @ac common/Collision/RegularGrid.h NodeArray::AddNode */
  AddNode(n: Node): void {
    for (let i = 0; i < 9; ++i) {
      if (this._nodes[i] === null) {
        this._nodes[i] = n;
        return;
      } else if (this._nodes[i] === n) {
        return;
      }
    }
  }
}

/** @ac common/Collision/RegularGrid.h RegularGrid2D::CELL_NUMBER */
export const CELL_NUMBER = 64;
/** Shouldn't be changed. @ac common/Collision/RegularGrid.h HGRID_MAP_SIZE */
export const HGRID_MAP_SIZE = Math.fround(Math.fround(533.33333) * 64);
/** @ac common/Collision/RegularGrid.h CELL_SIZE */
export const CELL_SIZE = Math.fround(HGRID_MAP_SIZE / CELL_NUMBER);
const INV_CELL_SIZE = Math.fround(1 / CELL_SIZE);

/** @ac common/Collision/RegularGrid.h RegularGrid2D::Cell */
export class Cell {
  x = 0;
  y = 0;

  /** @ac common/Collision/RegularGrid.h RegularGrid2D::Cell::operator== */
  equals(c2: Cell): boolean {
    return this.x === c2.x && this.y === c2.y;
  }

  /** @ac common/Collision/RegularGrid.h RegularGrid2D::Cell::ComputeCell */
  static ComputeCell(fx: number, fy: number): Cell {
    return Cell.ComputeCellTo(fx, fy, new Cell());
  }

  /** `ComputeCell` written into `out`. `int(...)` truncates toward zero. */
  static ComputeCellTo(fx: number, fy: number, out: Cell): Cell {
    out.x = Math.trunc(Math.fround(Math.fround(fx * INV_CELL_SIZE) + CELL_NUMBER / 2));
    out.y = Math.trunc(Math.fround(Math.fround(fy * INV_CELL_SIZE) + CELL_NUMBER / 2));
    return out;
  }

  /** @ac common/Collision/RegularGrid.h RegularGrid2D::Cell::isValid */
  isValid(): boolean {
    return this.x >= 0 && this.x < CELL_NUMBER && this.y >= 0 && this.y < CELL_NUMBER;
  }
}

const insertCorners = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const insertCell = new Cell();
const rayCell = new Cell();
const rayLastCell = new Cell();
const pointCell = new Cell();
const rayEnd = new Vector3();
const byValueDist: FloatRef = { value: 0 };

/**
 * A 64x64 grid over the whole map, each cell a `Node` (a `BIHWrap`). Members are inserted into the
 * cells under the 4 top corners, the 4 edge midpoints and the center of their bounds.
 *
 * @ac common/Collision/RegularGrid.h RegularGrid2D
 */
export class RegularGrid2D<T extends RegularGridMember, RayCb, PointCb, Node extends RegularGridNode<T, RayCb, PointCb>> {
  static readonly CELL_NUMBER = CELL_NUMBER;

  readonly memberTable = new Map<T, NodeArray<Node>>();
  /** `nodes[x][y]` is `nodes[x * CELL_NUMBER + y]`. */
  readonly nodes: (Node | null)[] = new Array<Node | null>(CELL_NUMBER * CELL_NUMBER).fill(null);

  /** `NodeCreatorFunc::makeNode` is passed in. @ac common/Collision/RegularGrid.h RegularGrid2D::RegularGrid2D */
  constructor(private readonly makeNode: (x: number, y: number) => Node) {}

  /** @ac common/Collision/RegularGrid.h RegularGrid2D::insert */
  insert(value: T): void {
    const bounds = value.GetBounds();
    const pos = insertCorners;
    bounds.cornerTo(0, pos[0]!);
    bounds.cornerTo(1, pos[1]!);
    bounds.cornerTo(2, pos[2]!);
    bounds.cornerTo(3, pos[3]!);
    const mid = (out: Vector3, a: Vector3, b: Vector3) => out.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    mid(pos[4]!, pos[0]!, pos[1]!);
    mid(pos[5]!, pos[1]!, pos[2]!);
    mid(pos[6]!, pos[2]!, pos[3]!);
    mid(pos[7]!, pos[3]!, pos[0]!);
    mid(pos[8]!, pos[0]!, pos[2]!);

    const na = new NodeArray<Node>();
    for (let i = 0; i < 9; ++i) {
      const c = Cell.ComputeCellTo(pos[i]!.x, pos[i]!.y, insertCell);
      if (!c.isValid()) continue;
      const node = this.getGridFor(pos[i]!.x, pos[i]!.y);
      na.AddNode(node);
    }

    for (let i = 0; i < 9; ++i) {
      const node = na._nodes[i];
      if (node) node.insert(value);
      else break;
    }

    this.memberTable.set(value, na);
  }

  /** @ac common/Collision/RegularGrid.h RegularGrid2D::remove */
  remove(value: T): void {
    const na = this.memberTable.get(value);
    if (na) {
      for (let i = 0; i < 9; ++i) {
        const node = na._nodes[i];
        if (node) node.remove(value);
        else break;
      }
    }

    // Remove the member
    this.memberTable.delete(value);
  }

  /** @ac common/Collision/RegularGrid.h RegularGrid2D::balance */
  balance(): void {
    for (const n of this.nodes) if (n) n.balance();
  }

  /** @ac common/Collision/RegularGrid.h RegularGrid2D::contains */
  contains(value: T): boolean {
    return this.memberTable.has(value);
  }

  /** @ac common/Collision/RegularGrid.h RegularGrid2D::size */
  size(): number {
    return this.memberTable.size;
  }

  /** @ac common/Collision/RegularGrid.h RegularGrid2D::getGridFor */
  getGridFor(fx: number, fy: number): Node {
    const c = Cell.ComputeCellTo(fx, fy, insertCell);
    return this.getGrid(c.x, c.y);
  }

  /** @ac common/Collision/RegularGrid.h RegularGrid2D::getGrid */
  getGrid(x: number, y: number): Node {
    if (!(x < CELL_NUMBER && y < CELL_NUMBER)) throw new Error(`ASSERT failed: RegularGrid2D::getGrid ${x} ${y}`);
    let node = this.nodes[x * CELL_NUMBER + y];
    if (!node) {
      node = this.makeNode(x, y);
      this.nodes[x * CELL_NUMBER + y] = node;
    }
    return node;
  }

  /**
   * Walks the cells the 2D projection of the ray crosses, from the origin cell to the cell of `end`.
   * With `end` null this is the C++ overload that takes `max_dist` by value and ends at
   * `origin + direction * max_dist`; `maxDist` is then not written back.
   *
   * @ac common/Collision/RegularGrid.h RegularGrid2D::intersectRay
   */
  intersectRay(ray: Ray, intersectCallback: RayCb, maxDist: FloatRef, end: Vector3 | null, stopAtFirstHit: boolean): void {
    if (!end) {
      const o = ray.origin();
      const d = ray.direction();
      byValueDist.value = maxDist.value;
      const e = rayEnd.set(o.x + d.x * maxDist.value, o.y + d.y * maxDist.value, o.z + d.z * maxDist.value);
      this.intersectRay(ray, intersectCallback, byValueDist, e, stopAtFirstHit);
      return;
    }
    const cell = Cell.ComputeCellTo(ray.origin().x, ray.origin().y, rayCell);
    if (!cell.isValid()) return;

    const last_cell = Cell.ComputeCellTo(end.x, end.y, rayLastCell);

    if (cell.equals(last_cell)) {
      const node = this.nodes[cell.x * CELL_NUMBER + cell.y];
      if (node) node.intersectRay(ray, intersectCallback, maxDist, stopAtFirstHit);
      return;
    }

    const voxel = CELL_SIZE;
    const kx_inv = ray.invDirection().x, bx = ray.origin().x;
    const ky_inv = ray.invDirection().y, by = ray.origin().y;

    let stepX: number, stepY: number;
    let tMaxX: number, tMaxY: number;
    if (kx_inv >= 0) {
      stepX = 1;
      const x_border = (cell.x + 1) * voxel;
      tMaxX = (x_border - bx) * kx_inv;
    } else {
      stepX = -1;
      const x_border = (cell.x - 1) * voxel;
      tMaxX = (x_border - bx) * kx_inv;
    }

    if (ky_inv >= 0) {
      stepY = 1;
      const y_border = (cell.y + 1) * voxel;
      tMaxY = (y_border - by) * ky_inv;
    } else {
      stepY = -1;
      const y_border = (cell.y - 1) * voxel;
      tMaxY = (y_border - by) * ky_inv;
    }

    const tDeltaX = voxel * Math.abs(kx_inv);
    const tDeltaY = voxel * Math.abs(ky_inv);
    // the cell is copied so a nested query cannot move it
    let cx = cell.x;
    let cy = cell.y;
    const lx = last_cell.x;
    const ly = last_cell.y;
    do {
      const node = this.nodes[cx * CELL_NUMBER + cy];
      if (node) node.intersectRay(ray, intersectCallback, maxDist, stopAtFirstHit);
      if (cx === lx && cy === ly) break;
      if (tMaxX < tMaxY) {
        tMaxX += tDeltaX;
        cx += stepX;
      } else {
        tMaxY += tDeltaY;
        cy += stepY;
      }
    } while (cx >= 0 && cx < CELL_NUMBER && cy >= 0 && cy < CELL_NUMBER);
  }

  /** @ac common/Collision/RegularGrid.h RegularGrid2D::intersectPoint */
  intersectPoint(point: Vector3, intersectCallback: PointCb): void {
    const cell = Cell.ComputeCellTo(point.x, point.y, pointCell);
    if (!cell.isValid()) return;
    const node = this.nodes[cell.x * CELL_NUMBER + cell.y];
    if (node) node.intersectPoint(point, intersectCallback);
  }

  /** Optimized verson of intersectRay function for rays with vertical directions. @ac common/Collision/RegularGrid.h RegularGrid2D::intersectZAllignedRay */
  intersectZAllignedRay(ray: Ray, intersectCallback: RayCb, max_dist: FloatRef): void {
    const cell = Cell.ComputeCellTo(ray.origin().x, ray.origin().y, pointCell);
    if (!cell.isValid()) return;
    const node = this.nodes[cell.x * CELL_NUMBER + cell.y];
    if (node) node.intersectRay(ray, intersectCallback, max_dist, false);
  }
}
