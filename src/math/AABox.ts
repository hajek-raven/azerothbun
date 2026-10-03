import { Vector3, type Point3 } from "./Vector3.ts";

/**
 * `G3D::AABox`, the axis aligned box the Collision code uses for bounds.
 *
 * The default constructor is the empty box (both corners NaN), like G3D. `low()` and `high()` return the
 * stored corners (not copies), so callers must not mutate them unless they own the box.
 *
 * @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox
 */
export class AABox {
  lo: Point3;
  hi: Point3;

  /**
   * `AABox()` (empty), `AABox(v)` (zero volume at `v`), or `AABox(low, high)`. The corners are copied.
   *
   * @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::AABox
   */
  constructor(low?: Point3, high?: Point3) {
    if (!low) {
      this.lo = new Vector3(NaN, NaN, NaN);
      this.hi = new Vector3(NaN, NaN, NaN);
    } else {
      this.lo = low.clone();
      this.hi = (high ?? low).clone();
    }
  }

  /** @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::isEmpty */
  isEmpty(): boolean {
    return this.lo.isNaN();
  }

  /** @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::set */
  set(low: Point3, high: Point3): void {
    this.lo.copy(low);
    this.hi.copy(high);
  }

  /** Assigns the six bounds without allocating. */
  setBounds(lx: number, ly: number, lz: number, hx: number, hy: number, hz: number): this {
    this.lo.set(lx, ly, lz);
    this.hi.set(hx, hy, hz);
    return this;
  }

  /** `operator=`. Returns `this`. */
  copy(b: AABox): this {
    this.lo.copy(b.lo);
    this.hi.copy(b.hi);
    return this;
  }

  clone(): AABox {
    const b = new AABox();
    b.copy(this);
    return b;
  }

  /** @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::merge */
  merge(a: AABox | Point3): void {
    if (a instanceof AABox) {
      if (this.isEmpty()) {
        this.lo.copy(a.lo);
        this.hi.copy(a.hi);
      } else if (!a.isEmpty()) {
        this.lo = this.lo.min(a.lo);
        this.hi = this.hi.max(a.hi);
      }
      return;
    }
    if (this.isEmpty()) {
      this.lo.copy(a);
      this.hi.copy(a);
    } else {
      this.lo = this.lo.min(a);
      this.hi = this.hi.max(a);
    }
  }

  /** @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::isFinite */
  isFinite(): boolean {
    return this.isEmpty() || (this.lo.isFinite() && this.hi.isFinite());
  }

  /** @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::low */
  low(): Point3 {
    return this.lo;
  }

  /** @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::high */
  high(): Point3 {
    return this.hi;
  }

  /** @ac deps/g3dlite/source/AABox.cpp G3D::AABox::maxFinite */
  static maxFinite(): AABox {
    const m = 3.4028234663852886e38;
    return new AABox(new Vector3(-m, -m, -m), new Vector3(m, m, m));
  }

  /** @ac deps/g3dlite/source/AABox.cpp G3D::AABox::inf */
  static inf(): AABox {
    return new AABox(new Vector3(-Infinity, -Infinity, -Infinity), Vector3.inf());
  }

  /** @ac deps/g3dlite/source/AABox.cpp G3D::AABox::zero */
  static zero(): AABox {
    return new AABox(Vector3.zero(), Vector3.zero());
  }

  /** @ac deps/g3dlite/source/AABox.cpp G3D::AABox::empty */
  static empty(): AABox {
    return new AABox();
  }

  /** @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::center */
  center(): Point3 {
    return new Vector3((this.lo.x + this.hi.x) * 0.5, (this.lo.y + this.hi.y) * 0.5, (this.lo.z + this.hi.z) * 0.5);
  }

  /** @ac deps/g3dlite/source/AABox.cpp G3D::AABox::corner */
  corner(index: number): Point3 {
    const v = new Vector3();
    this.cornerTo(index, v);
    return v;
  }

  /** `corner(index)` written into `out`. */
  cornerTo(index: number, out: Vector3): Vector3 {
    const lo = this.lo;
    const hi = this.hi;
    switch (index) {
      case 0: return out.set(lo.x, lo.y, hi.z);
      case 1: return out.set(hi.x, lo.y, hi.z);
      case 2: return out.set(hi.x, hi.y, hi.z);
      case 3: return out.set(lo.x, hi.y, hi.z);
      case 4: return out.set(lo.x, lo.y, lo.z);
      case 5: return out.set(hi.x, lo.y, lo.z);
      case 6: return out.set(hi.x, hi.y, lo.z);
      case 7: return out.set(lo.x, hi.y, lo.z);
      default: return out.set(0, 0, 0);
    }
  }

  /** `extent()` (no argument: the size vector) or `extent(a)` (size along axis `a`). */
  extent(): Vector3;
  extent(a: number): number;
  /** @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::extent */
  extent(a?: number): Vector3 | number {
    if (a === undefined) {
      if (this.isEmpty()) return Vector3.zero();
      return this.hi.minus(this.lo);
    }
    if (this.isEmpty()) return 0;
    return this.hi.get(a) - this.lo.get(a);
  }

  /** @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::contains (point) */
  contains(point: Point3): boolean {
    return (
      point.x >= this.lo.x &&
      point.y >= this.lo.y &&
      point.z >= this.lo.z &&
      point.x <= this.hi.x &&
      point.y <= this.hi.y &&
      point.z <= this.hi.z
    );
  }

  /** `contains(point)` on raw components. */
  containsXYZ(x: number, y: number, z: number): boolean {
    return x >= this.lo.x && y >= this.lo.y && z >= this.lo.z && x <= this.hi.x && y <= this.hi.y && z <= this.hi.z;
  }

  /** @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::contains (box, less than or equal) */
  containsBox(other: AABox): boolean {
    return (
      other.hi.x <= this.hi.x &&
      other.hi.y <= this.hi.y &&
      other.hi.z <= this.hi.z &&
      other.lo.x >= this.lo.x &&
      other.lo.y >= this.lo.y &&
      other.lo.z >= this.lo.z
    );
  }

  /** @ac deps/g3dlite/source/AABox.cpp G3D::AABox::intersects */
  intersects(other: AABox): boolean {
    for (let a = 0; a < 3; ++a) {
      if (this.lo.get(a) > other.hi.get(a) || this.hi.get(a) < other.lo.get(a)) return false;
    }
    return true;
  }

  /** @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::operator== */
  equals(b: AABox): boolean {
    if (this.isEmpty() && b.isEmpty()) return true;
    return this.lo.equals(b.lo) && this.hi.equals(b.hi);
  }

  /** @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::operator+ */
  plus(v: Vector3): AABox {
    const out = new AABox();
    out.lo.set(this.lo.x + v.x, this.lo.y + v.y, this.lo.z + v.z);
    out.hi.set(this.hi.x + v.x, this.hi.y + v.y, this.hi.z + v.z);
    return out;
  }

  /** @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::operator- */
  minus(v: Vector3): AABox {
    const out = new AABox();
    out.lo.set(this.lo.x - v.x, this.lo.y - v.y, this.lo.z - v.z);
    out.hi.set(this.hi.x - v.x, this.hi.y - v.y, this.hi.z - v.z);
    return out;
  }

  /** @ac deps/g3dlite/include/G3D/AABox.h G3D::AABox::getBounds */
  getBounds(out: AABox): void {
    out.copy(this);
  }

  toString(): string {
    return `AABox(${this.lo.toString()}, ${this.hi.toString()})`;
  }
}
