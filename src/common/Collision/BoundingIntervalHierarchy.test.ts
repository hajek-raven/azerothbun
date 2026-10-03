import { describe, expect, test } from "bun:test";
import { AABox } from "../../math/AABox.ts";
import { Ray } from "../../math/Ray.ts";
import { Vector3 } from "../../math/Vector3.ts";
import { ReadFile, WriteFile } from "./BinaryFile.ts";
import { BIH, floatToRawIntBits, intBitsToFloat, type BIHPointCallback, type BIHRayCallback, type FloatRef } from "./BoundingIntervalHierarchy.ts";

/** Deterministic xorshift so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

function randomBoxes(rand: () => number, n: number, extent: number, size: number): AABox[] {
  const out: AABox[] = [];
  for (let i = 0; i < n; ++i) {
    const x = Math.fround((rand() - 0.5) * extent);
    const y = Math.fround((rand() - 0.5) * extent);
    const z = Math.fround((rand() - 0.5) * extent);
    const sx = Math.fround(rand() * size + 0.01);
    const sy = Math.fround(rand() * size + 0.01);
    const sz = Math.fround(rand() * size + 0.01);
    out.push(new AABox(new Vector3(x, y, z), new Vector3(Math.fround(x + sx), Math.fround(y + sy), Math.fround(z + sz))));
  }
  return out;
}

function unitDir(rand: () => number): Vector3 {
  while (true) {
    const v = new Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
    const m = v.magnitude();
    if (m > 0.1 && m <= 1) return v.div(m);
  }
}

class ClosestBoxCallback implements BIHRayCallback {
  hit = -1;
  calls = 0;
  constructor(private readonly boxes: AABox[]) {}
  onRay(ray: Ray, entry: number, maxDist: FloatRef): boolean {
    this.calls++;
    const t = ray.intersectionTime(this.boxes[entry]!);
    if (t < maxDist.value) {
      maxDist.value = t;
      this.hit = entry;
      return true;
    }
    return false;
  }
}

class PointCollector implements BIHPointCallback {
  readonly seen = new Set<number>();
  onPoint(_p: Vector3, entry: number): void {
    this.seen.add(entry);
  }
}

describe("BIH", () => {
  test("float bit helpers round trip", () => {
    expect(floatToRawIntBits(1)).toBe(0x3f800000);
    expect(intBitsToFloat(0x3f800000)).toBe(1);
    expect(floatToRawIntBits(-Infinity)).toBe(0xff800000);
  });

  test("empty tree has the dummy leaf and NaN bounds", () => {
    const tree = new BIH();
    tree.build([] as AABox[], (b, out) => out.copy(b));
    expect(tree.primCount()).toBe(0);
    expect(tree.bound().isEmpty()).toBe(true);
    const cb = new ClosestBoxCallback([]);
    tree.intersectRay(new Ray(new Vector3(), new Vector3(1, 0, 0)), cb, { value: 100 }, false);
    expect(cb.calls).toBe(0);
  });

  test("ray query finds the same closest box as brute force", () => {
    const rand = rng(1234);
    const boxes = randomBoxes(rand, 400, 200, 8);
    const tree = new BIH();
    tree.build(boxes, (b, out) => out.copy(b));
    expect(tree.primCount()).toBe(400);
    const ray = new Ray();
    for (let i = 0; i < 2000; ++i) {
      const origin = new Vector3((rand() - 0.5) * 260, (rand() - 0.5) * 260, (rand() - 0.5) * 260);
      ray.set(origin, unitDir(rand));
      const maxDist = 50 + rand() * 300;
      let best = maxDist;
      for (const box of boxes) {
        const t = ray.intersectionTime(box);
        if (t < best) best = t;
      }
      const cb = new ClosestBoxCallback(boxes);
      const dist = { value: maxDist };
      tree.intersectRay(ray, cb, dist, false);
      expect(dist.value).toBeCloseTo(best, 4);
    }
  });

  test("axis aligned rays (zero direction components) agree with brute force", () => {
    const rand = rng(99);
    const boxes = randomBoxes(rand, 200, 100, 5);
    const tree = new BIH();
    tree.build(boxes, (b, out) => out.copy(b));
    const ray = new Ray();
    const dirs = [new Vector3(0, 0, -1), new Vector3(0, 0, 1), new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, -1, 0)];
    for (let i = 0; i < 1000; ++i) {
      ray.set(new Vector3((rand() - 0.5) * 120, (rand() - 0.5) * 120, (rand() - 0.5) * 120), dirs[i % dirs.length]!);
      let best = 500;
      for (const box of boxes) best = Math.min(best, ray.intersectionTime(box));
      const dist = { value: 500 };
      tree.intersectRay(ray, new ClosestBoxCallback(boxes), dist, false);
      expect(dist.value).toBeCloseTo(best, 4);
    }
  });

  test("point query visits every box that contains the point", () => {
    const rand = rng(77);
    const boxes = randomBoxes(rand, 300, 100, 20);
    const tree = new BIH();
    tree.build(boxes, (b, out) => out.copy(b));
    for (let i = 0; i < 2000; ++i) {
      const p = new Vector3((rand() - 0.5) * 110, (rand() - 0.5) * 110, (rand() - 0.5) * 110);
      const cb = new PointCollector();
      tree.intersectPoint(p, cb);
      boxes.forEach((box, idx) => {
        if (box.contains(p)) expect(cb.seen.has(idx)).toBe(true);
      });
    }
  });

  test("nested traversals from a callback do not disturb the outer stack", () => {
    const rand = rng(5);
    const boxes = randomBoxes(rand, 200, 100, 6);
    const inner = new BIH();
    inner.build(boxes, (b, out) => out.copy(b));
    const outer = new BIH();
    outer.build(boxes, (b, out) => out.copy(b));
    const ray = new Ray();
    for (let i = 0; i < 300; ++i) {
      ray.set(new Vector3((rand() - 0.5) * 120, (rand() - 0.5) * 120, (rand() - 0.5) * 120), unitDir(rand));
      const plain = { value: 400 };
      outer.intersectRay(ray, new ClosestBoxCallback(boxes), plain, false);
      const nestedCb = new ClosestBoxCallback(boxes);
      const wrapped: BIHRayCallback = {
        onRay(r, entry, maxDist, stop) {
          inner.intersectRay(r, new ClosestBoxCallback(boxes), { value: 400 }, false);
          return nestedCb.onRay(r, entry, maxDist);
        },
      };
      const nested = { value: 400 };
      outer.intersectRay(ray, wrapped, nested, false);
      expect(nested.value).toBe(plain.value);
    }
  });

  test("write and read back gives the same tree", () => {
    const rand = rng(42);
    const boxes = randomBoxes(rand, 50, 50, 4);
    const tree = new BIH();
    tree.build(boxes, (b, out) => out.copy(b));
    const wf = new WriteFile();
    expect(tree.writeToFile(wf)).toBe(true);
    const bytes = wf.toBytes();
    const copy = new BIH();
    expect(copy.readFromFile(new ReadFile(bytes))).toBe(true);
    const wf2 = new WriteFile();
    copy.writeToFile(wf2);
    expect(wf2.toBytes()).toEqual(bytes);
    expect(copy.primCount()).toBe(50);
    // truncated input fails like a short fread
    expect(new BIH().readFromFile(new ReadFile(bytes.subarray(0, bytes.length - 2)))).toBe(false);
  });
});
