import { describe, expect, test } from "bun:test";
import { AABox } from "./AABox.ts";
import { fuzzyEq, fuzzyGt, fuzzyNe } from "./g3dmath.ts";
import { Matrix3 } from "./Matrix3.ts";
import { Ray } from "./Ray.ts";
import { Vector3 } from "./Vector3.ts";

describe("g3dlite subset", () => {
  test("fuzzy compares", () => {
    expect(fuzzyEq(1, 1 + 1e-6)).toBe(true);
    expect(fuzzyEq(1, 1.001)).toBe(false);
    expect(fuzzyNe(1e-7, 0)).toBe(false);
    expect(fuzzyNe(1e-5, 0)).toBe(true);
    expect(fuzzyGt(0, 0)).toBe(false);
    expect(fuzzyGt(1e-3, 0)).toBe(true);
  });

  test("Vector3 basics", () => {
    const v = new Vector3(3, -4, 0);
    expect(v.magnitude()).toBe(5);
    expect(v.primaryAxis()).toBe(Vector3.Y_AXIS);
    expect(new Vector3(1, 0, 0).cross(new Vector3(0, 1, 0)).equals(new Vector3(0, 0, 1))).toBe(true);
    expect(v.div(new Vector3(3, -4, 1)).equals(new Vector3(1, 1, 0))).toBe(true);
    expect(v.div(5).x).toBeCloseTo(0.6, 12);
    expect(new Vector3(NaN, 0, 0).isNaN()).toBe(true);
  });

  test("AABox empty, merge, corners, contains", () => {
    const b = new AABox();
    expect(b.isEmpty()).toBe(true);
    expect(b.equals(AABox.empty())).toBe(true);
    b.merge(new Vector3(1, 2, 3));
    b.merge(new Vector3(-1, 5, 0));
    expect(b.low().equals(new Vector3(-1, 2, 0))).toBe(true);
    expect(b.high().equals(new Vector3(1, 5, 3))).toBe(true);
    expect(b.corner(0).equals(new Vector3(-1, 2, 3))).toBe(true);
    expect(b.corner(6).equals(new Vector3(1, 5, 0))).toBe(true);
    expect(b.contains(new Vector3(0, 3, 1))).toBe(true);
    expect(b.contains(new Vector3(0, 3, 4))).toBe(false);
    expect(b.extent().equals(new Vector3(2, 3, 3))).toBe(true);
    expect(b.plus(new Vector3(1, 1, 1)).low().equals(new Vector3(0, 3, 1))).toBe(true);
    expect(AABox.zero().equals(new AABox(new Vector3(), new Vector3()))).toBe(true);
  });

  test("Matrix3 euler rotation and inverse", () => {
    const m = Matrix3.fromEulerAnglesZYX(Math.PI / 2, 0, 0);
    const v = m.mulVec(new Vector3(1, 0, 0));
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.y).toBeCloseTo(1, 6);
    const inv = m.inverse();
    const back = inv.mulVec(v);
    expect(back.x).toBeCloseTo(1, 6);
    expect(back.y).toBeCloseTo(0, 6);
    // v * M == M^T * v
    const row = Matrix3.vecMul(new Vector3(1, 2, 3), m);
    const col = m.transpose().mulVec(new Vector3(1, 2, 3));
    expect(row.x).toBeCloseTo(col.x, 6);
    expect(row.y).toBeCloseTo(col.y, 6);
    expect(row.z).toBeCloseTo(col.z, 6);
    // singular matrices give zero
    expect(Array.from(Matrix3.zero().inverse().elt)).toEqual(new Array(9).fill(0));
  });

  test("Ray / AABox intersection time", () => {
    const box = new AABox(new Vector3(1, -1, -1), new Vector3(3, 1, 1));
    expect(new Ray(new Vector3(0, 0, 0), new Vector3(1, 0, 0)).intersectionTime(box)).toBeCloseTo(1, 6);
    expect(new Ray(new Vector3(0, 0, 0), new Vector3(-1, 0, 0)).intersectionTime(box)).toBe(Infinity);
    expect(new Ray(new Vector3(2, 0, 0), new Vector3(0, 0, 1)).intersectionTime(box)).toBe(0);
    expect(new Ray(new Vector3(0, 5, 0), new Vector3(1, 0, 0)).intersectionTime(box)).toBe(Infinity);
    const r = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, 1));
    expect(r.bumpedRay(2).origin().equals(new Vector3(0, 0, 2))).toBe(true);
    expect(r.invDirection().z).toBe(1);
  });
});
