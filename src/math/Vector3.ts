import { isFinite as g3dIsFinite, isNaN as g3dIsNaN, stdMax, stdMin } from "./g3dmath.ts";

/**
 * `G3D::Vector3` (and `G3D::Point3`, which is the same type), reduced to what the Collision code uses.
 *
 * The C++ operators become methods that return a new vector (`plus`, `minus`, `times`, `div`...). Hot
 * paths in the collision runtime do not call them; they work on the components and reuse scratch
 * vectors through the `*To` / `set*` variants, which write into an existing vector.
 *
 * Components are JavaScript doubles. Code that must reproduce a C++ `float` store (files written by the
 * tools) applies `Math.fround` itself.
 *
 * @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3
 */
export class Vector3 {
  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::Axis */
  static readonly X_AXIS = 0;
  static readonly Y_AXIS = 1;
  static readonly Z_AXIS = 2;

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::Vector3 (default is zero) */
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::zero */
  static zero(): Vector3 {
    return new Vector3(0, 0, 0);
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::one */
  static one(): Vector3 {
    return new Vector3(1, 1, 1);
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::unitX */
  static unitX(): Vector3 {
    return new Vector3(1, 0, 0);
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::inf */
  static inf(): Vector3 {
    return new Vector3(Infinity, Infinity, Infinity);
  }

  /** `Vector3(float const* v)`: reads three floats at `offset`. */
  static fromArray(v: ArrayLike<number>, offset = 0): Vector3 {
    return new Vector3(v[offset]!, v[offset + 1]!, v[offset + 2]!);
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::operator[] (read) */
  get(axis: number): number {
    return axis === 0 ? this.x : axis === 1 ? this.y : this.z;
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::operator[] (write) */
  setAxis(axis: number, value: number): void {
    if (axis === 0) this.x = value;
    else if (axis === 1) this.y = value;
    else this.z = value;
  }

  /** Assigns all three components. Returns `this`. */
  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  /** `operator=`. Returns `this`. */
  copy(v: Vector3): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::operator+ */
  plus(v: Vector3): Vector3 {
    return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z);
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::operator- (binary) */
  minus(v: Vector3): Vector3 {
    return new Vector3(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::operator- (unary) */
  negate(): Vector3 {
    return new Vector3(-this.x, -this.y, -this.z);
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::operator* (scalar or component wise) */
  times(s: number | Vector3): Vector3 {
    if (typeof s === "number") return new Vector3(this.x * s, this.y * s, this.z * s);
    return new Vector3(this.x * s.x, this.y * s.y, this.z * s.z);
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::operator/ (scalar: `*this * (1.0f / s)`; vector: component wise) */
  div(s: number | Vector3): Vector3 {
    if (typeof s === "number") {
      const inv = 1 / s;
      return new Vector3(this.x * inv, this.y * inv, this.z * inv);
    }
    return new Vector3(this.x / s.x, this.y / s.y, this.z / s.z);
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::operator== */
  equals(v: Vector3): boolean {
    return this.x === v.x && this.y === v.y && this.z === v.z;
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::magnitude */
  magnitude(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::length */
  length(): number {
    return this.magnitude();
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::squaredMagnitude */
  squaredMagnitude(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::dot */
  dot(v: Vector3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::cross */
  cross(v: Vector3): Vector3 {
    return new Vector3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x);
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::min (`G3D::min(v.x, x)`) */
  min(v: Vector3): Vector3 {
    return new Vector3(stdMin(v.x, this.x), stdMin(v.y, this.y), stdMin(v.z, this.z));
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::max (`G3D::max(v.x, x)`) */
  max(v: Vector3): Vector3 {
    return new Vector3(stdMax(v.x, this.x), stdMax(v.y, this.y), stdMax(v.z, this.z));
  }

  /** @ac deps/g3dlite/source/Vector3.cpp G3D::Vector3::isNaN */
  isNaN(): boolean {
    return g3dIsNaN(this.x) || g3dIsNaN(this.y) || g3dIsNaN(this.z);
  }

  /** @ac deps/g3dlite/include/G3D/Vector3.h G3D::Vector3::isFinite */
  isFinite(): boolean {
    return g3dIsFinite(this.x) && g3dIsFinite(this.y) && g3dIsFinite(this.z);
  }

  /** @ac deps/g3dlite/source/Vector3.cpp G3D::Vector3::primaryAxis */
  primaryAxis(): number {
    const nx = Math.abs(this.x);
    const ny = Math.abs(this.y);
    const nz = Math.abs(this.z);
    if (nx > ny) return nx > nz ? Vector3.X_AXIS : Vector3.Z_AXIS;
    return ny > nz ? Vector3.Y_AXIS : Vector3.Z_AXIS;
  }

  /** @ac deps/g3dlite/source/Vector3.cpp G3D::Vector3::toString */
  toString(): string {
    return `(${this.x}, ${this.y}, ${this.z})`;
  }
}

/** `G3D::Point3` is a typedef of `Vector3`. */
export type Point3 = Vector3;
