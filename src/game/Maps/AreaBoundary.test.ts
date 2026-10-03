import { describe, expect, test } from "bun:test";
import { Position } from "../Entities/Object/Position.ts";
import {
  BoundaryIntersectBoundary,
  BoundaryUnionBoundary,
  CircleBoundary,
  DoublePosition,
  EllipseBoundary,
  ParallelogramBoundary,
  RectangleBoundary,
  TriangleBoundary,
  ZRangeBoundary,
} from "./AreaBoundary.ts";

const p = (x: number, y: number, z = 0): Position => new Position(x, y, z, 0);

describe("AreaBoundary", () => {
  test("a null position is never within", () => {
    expect(new RectangleBoundary(0, 10, 0, 10).isWithinBoundary(null)).toBe(false);
    expect(new RectangleBoundary(0, 10, 0, 10, true).isWithinBoundary(null)).toBe(false);
  });

  test("RectangleBoundary: south/north X, east/west Y, edges inclusive", () => {
    const rect = new RectangleBoundary(-10, 10, -5, 5);
    expect(rect.isWithinBoundary(p(0, 0))).toBe(true);
    expect(rect.isWithinBoundary(p(10, 5))).toBe(true);
    expect(rect.isWithinBoundary(p(-10, -5))).toBe(true);
    expect(rect.isWithinBoundary(p(10.01, 0))).toBe(false);
    expect(rect.isWithinBoundary(p(0, -5.01))).toBe(false);
    // inverted
    const outside = new RectangleBoundary(-10, 10, -5, 5, true);
    expect(outside.isWithinBoundary(p(0, 0))).toBe(false);
    expect(outside.isWithinBoundary(p(20, 0))).toBe(true);
  });

  test("CircleBoundary: radius and point-on-circle constructors, 2d only", () => {
    const circle = new CircleBoundary(p(100, 100, 50), 10);
    expect(circle.isWithinBoundary(p(100, 110, -500))).toBe(true); // on the circle, z ignored
    expect(circle.isWithinBoundary(p(107, 107))).toBe(true); // 9.9 away
    expect(circle.isWithinBoundary(p(108, 108))).toBe(false); // 11.3 away
    const byPoint = new CircleBoundary(p(0, 0), p(3, 4));
    expect(byPoint.isWithinBoundary(p(0, 5))).toBe(true);
    expect(byPoint.isWithinBoundary(p(0, 5.01))).toBe(false);
    expect(new CircleBoundary(p(0, 0), 5, true).isWithinBoundary(p(0, 6))).toBe(true);
  });

  test("EllipseBoundary: radiusX along X, radiusY along Y", () => {
    const ellipse = new EllipseBoundary(p(0, 0), 20, 5);
    expect(ellipse.isWithinBoundary(p(20, 0))).toBe(true);
    expect(ellipse.isWithinBoundary(p(0, 5))).toBe(true);
    expect(ellipse.isWithinBoundary(p(0, 6))).toBe(false);
    expect(ellipse.isWithinBoundary(p(21, 0))).toBe(false);
    expect(ellipse.isWithinBoundary(p(14, 3.5))).toBe(true); // (14/20)^2 + (3.5/5)^2 = 0.98
    expect(ellipse.isWithinBoundary(p(15, 3.5))).toBe(false); // 0.5625 + 0.49 = 1.05
  });

  test("TriangleBoundary: either winding", () => {
    for (const tri of [new TriangleBoundary(p(0, 0), p(10, 0), p(0, 10)), new TriangleBoundary(p(0, 0), p(0, 10), p(10, 0))]) {
      expect(tri.isWithinBoundary(p(2, 2))).toBe(true);
      expect(tri.isWithinBoundary(p(4.9, 4.9))).toBe(true);
      expect(tri.isWithinBoundary(p(5.1, 5.1))).toBe(false);
      expect(tri.isWithinBoundary(p(-1, 2))).toBe(false);
    }
  });

  test("ParallelogramBoundary: corners A, B, D (AB orthogonal to AD) span a rectangle", () => {
    // A (0,0), B (10,0), D (0,4) -> C (10,4)
    const para = new ParallelogramBoundary(p(0, 0), p(10, 0), p(0, 4));
    expect(para.isWithinBoundary(p(5, 2))).toBe(true);
    expect(para.isWithinBoundary(p(9.9, 3.9))).toBe(true);
    expect(para.isWithinBoundary(p(10.1, 2))).toBe(false);
    expect(para.isWithinBoundary(p(5, 4.1))).toBe(false);
    expect(para.isWithinBoundary(p(5, -0.1))).toBe(false);
    // rotated 45 degrees
    const rotated = new ParallelogramBoundary(p(0, 0), p(5, 5), p(-2, 2));
    expect(rotated.isWithinBoundary(p(1.5, 3))).toBe(true);
    expect(rotated.isWithinBoundary(p(4, 1))).toBe(false);
  });

  test("ZRangeBoundary: inclusive on both ends", () => {
    const z = new ZRangeBoundary(10, 20);
    expect(z.isWithinBoundary(p(0, 0, 10))).toBe(true);
    expect(z.isWithinBoundary(p(1000, -1000, 20))).toBe(true);
    expect(z.isWithinBoundary(p(0, 0, 9.9))).toBe(false);
    expect(new ZRangeBoundary(10, 20, true).isWithinBoundary(p(0, 0, 25))).toBe(true);
  });

  test("BoundaryUnionBoundary and BoundaryIntersectBoundary combine the inner checks", () => {
    const left = new CircleBoundary(p(0, 0), 5);
    const right = new CircleBoundary(p(8, 0), 5);
    const union = new BoundaryUnionBoundary(left, right);
    const intersect = new BoundaryIntersectBoundary(left, right);
    expect(union.isWithinBoundary(p(-4, 0))).toBe(true);
    expect(union.isWithinBoundary(p(12, 0))).toBe(true);
    expect(union.isWithinBoundary(p(4, 6))).toBe(false);
    expect(intersect.isWithinBoundary(p(4, 0))).toBe(true);
    expect(intersect.isWithinBoundary(p(-4, 0))).toBe(false);
    // inner inversion is applied by the inner boundary, outer inversion by the outer one
    const notLeft = new CircleBoundary(p(0, 0), 5, true);
    expect(new BoundaryIntersectBoundary(notLeft, right).isWithinBoundary(p(10, 0))).toBe(true);
    expect(new BoundaryIntersectBoundary(notLeft, right, true).isWithinBoundary(p(10, 0))).toBe(false);
  });

  test("DoublePosition keeps the double coordinates and syncs the float ones", () => {
    const pos = new DoublePosition(0.1, 0.2, 0.3);
    expect(pos.getDoublePositionX()).toBe(0.1);
    expect(pos.getPositionX()).toBe(Math.fround(0.1));
    expect(pos.getDoubleExactDist2dSq(new DoublePosition(3.1, 4.2))).toBeCloseTo(25, 12);
    pos.DoublePosX = 1.5;
    pos.sync();
    expect(pos.getPositionX()).toBe(1.5);
  });
});
