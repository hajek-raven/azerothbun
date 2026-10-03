/**
 * @ac game/Maps/AreaBoundary.h
 * @ac game/Maps/AreaBoundary.cpp
 *
 * Boss and creature boundaries (`CreatureBoundary` is a list of these). The geometry is done in doubles like the C++
 * `DoublePosition`; the positions tested are the object's float positions.
 */
import { Position, type PositionLike } from "../Entities/Object/Position.ts";

/** @ac game/Maps/AreaBoundary.h AreaBoundary::DoublePosition */
export class DoublePosition extends Position {
  DoublePosX: number;
  DoublePosY: number;
  DoublePosZ: number;

  /**
   * @ac game/Maps/AreaBoundary.h AreaBoundary::DoublePosition::DoublePosition
   * The `(double x, double y, double z, float o)`, `(float x, ...)`, and `(Position const&)` overloads: the `Position`
   * part holds the coordinates truncated to `float`, the `DoublePos*` members the full values.
   */
  constructor(xOrPos: number | PositionLike = 0.0, y = 0.0, z = 0.0, o = 0.0) {
    if (typeof xOrPos !== "number") {
      super(xOrPos.getPositionX(), xOrPos.getPositionY(), xOrPos.getPositionZ(), xOrPos.getOrientation());
      this.DoublePosX = xOrPos.getPositionX();
      this.DoublePosY = xOrPos.getPositionY();
      this.DoublePosZ = xOrPos.getPositionZ();
      return;
    }
    super(Math.fround(xOrPos), Math.fround(y), Math.fround(z), Math.fround(o));
    this.DoublePosX = xOrPos;
    this.DoublePosY = y;
    this.DoublePosZ = z;
  }

  /** @ac game/Maps/AreaBoundary.h AreaBoundary::DoublePosition::GetDoublePositionX */
  getDoublePositionX(): number {
    return this.DoublePosX;
  }

  /** @ac game/Maps/AreaBoundary.h AreaBoundary::DoublePosition::GetDoublePositionY */
  getDoublePositionY(): number {
    return this.DoublePosY;
  }

  /** @ac game/Maps/AreaBoundary.h AreaBoundary::DoublePosition::GetDoublePositionZ */
  getDoublePositionZ(): number {
    return this.DoublePosZ;
  }

  /** @ac game/Maps/AreaBoundary.h AreaBoundary::DoublePosition::GetDoubleExactDist2dSq */
  getDoubleExactDist2dSq(pos: DoublePosition): number {
    const offX = this.getDoublePositionX() - pos.getDoublePositionX();
    const offY = this.getDoublePositionY() - pos.getDoublePositionY();
    return offX * offX + offY * offY;
  }

  /** @ac game/Maps/AreaBoundary.h AreaBoundary::DoublePosition::sync */
  sync(): Position {
    this.m_positionX = Math.fround(this.DoublePosX);
    this.m_positionY = Math.fround(this.DoublePosY);
    this.m_positionZ = Math.fround(this.DoublePosZ);
    return this;
  }
}

/** @ac game/Maps/AreaBoundary.h AreaBoundary */
export abstract class AreaBoundary {
  private readonly _isInvertedBoundary: boolean;

  /** @ac game/Maps/AreaBoundary.h AreaBoundary::AreaBoundary */
  protected constructor(isInverted: boolean) {
    this._isInvertedBoundary = isInverted;
  }

  /** @ac game/Maps/AreaBoundary.h AreaBoundary::IsWithinBoundary (the `Position const*` and `Position const&` overloads) */
  isWithinBoundary(pos: PositionLike | null): boolean {
    return pos !== null && this.isWithinBoundaryArea(pos) !== this._isInvertedBoundary;
  }

  /** @ac game/Maps/AreaBoundary.h AreaBoundary::IsWithinBoundaryArea */
  protected abstract isWithinBoundaryArea(pos: PositionLike): boolean;
}

/** @ac game/Maps/AreaBoundary.h RectangleBoundary */
export class RectangleBoundary extends AreaBoundary {
  private readonly _minX: number;
  private readonly _maxX: number;
  private readonly _minY: number;
  private readonly _maxY: number;

  /**
   * @ac game/Maps/AreaBoundary.cpp RectangleBoundary::RectangleBoundary
   * X axis is north/south, Y axis is east/west, larger values are northwest
   */
  constructor(southX: number, northX: number, eastY: number, westY: number, isInverted = false) {
    super(isInverted);
    this._minX = Math.fround(southX);
    this._maxX = Math.fround(northX);
    this._minY = Math.fround(eastY);
    this._maxY = Math.fround(westY);
  }

  /** @ac game/Maps/AreaBoundary.cpp RectangleBoundary::IsWithinBoundaryArea */
  protected override isWithinBoundaryArea(pos: PositionLike): boolean {
    return !(
      pos.getPositionX() < this._minX ||
      pos.getPositionX() > this._maxX ||
      pos.getPositionY() < this._minY ||
      pos.getPositionY() > this._maxY
    );
  }
}

/** @ac game/Maps/AreaBoundary.h CircleBoundary */
export class CircleBoundary extends AreaBoundary {
  private readonly _center: DoublePosition;
  private readonly _radiusSq: number;

  /**
   * @ac game/Maps/AreaBoundary.cpp CircleBoundary::CircleBoundary
   * The `(center, double radius)` and `(center, Position const& pointOnCircle)` overloads.
   */
  constructor(center: PositionLike, radiusOrPointOnCircle: number | PositionLike, isInverted = false) {
    super(isInverted);
    this._center = new DoublePosition(center);
    if (typeof radiusOrPointOnCircle === "number") {
      this._radiusSq = radiusOrPointOnCircle * radiusOrPointOnCircle;
    } else {
      this._radiusSq = this._center.getDoubleExactDist2dSq(new DoublePosition(radiusOrPointOnCircle));
    }
  }

  /** @ac game/Maps/AreaBoundary.cpp CircleBoundary::IsWithinBoundaryArea */
  protected override isWithinBoundaryArea(pos: PositionLike): boolean {
    const offX = this._center.getDoublePositionX() - pos.getPositionX();
    const offY = this._center.getDoublePositionY() - pos.getPositionY();
    return offX * offX + offY * offY <= this._radiusSq;
  }
}

/** @ac game/Maps/AreaBoundary.h EllipseBoundary */
export class EllipseBoundary extends AreaBoundary {
  private readonly _center: DoublePosition;
  private readonly _radiusYSq: number;
  private readonly _scaleXSq: number;

  /** @ac game/Maps/AreaBoundary.cpp EllipseBoundary::EllipseBoundary */
  constructor(center: PositionLike, radiusX: number, radiusY: number, isInverted = false) {
    super(isInverted);
    this._center = new DoublePosition(center);
    this._radiusYSq = radiusY * radiusY;
    this._scaleXSq = this._radiusYSq / (radiusX * radiusX);
  }

  /** @ac game/Maps/AreaBoundary.cpp EllipseBoundary::IsWithinBoundaryArea */
  protected override isWithinBoundaryArea(pos: PositionLike): boolean {
    const offX = this._center.getDoublePositionX() - pos.getPositionX();
    const offY = this._center.getDoublePositionY() - pos.getPositionY();
    return offX * offX * this._scaleXSq + offY * offY <= this._radiusYSq;
  }
}

/** @ac game/Maps/AreaBoundary.h TriangleBoundary */
export class TriangleBoundary extends AreaBoundary {
  private readonly _a: DoublePosition;
  private readonly _b: DoublePosition;
  private readonly _c: DoublePosition;
  private readonly _abx: number;
  private readonly _bcx: number;
  private readonly _cax: number;
  private readonly _aby: number;
  private readonly _bcy: number;
  private readonly _cay: number;

  /** @ac game/Maps/AreaBoundary.cpp TriangleBoundary::TriangleBoundary */
  constructor(pointA: PositionLike, pointB: PositionLike, pointC: PositionLike, isInverted = false) {
    super(isInverted);
    this._a = new DoublePosition(pointA);
    this._b = new DoublePosition(pointB);
    this._c = new DoublePosition(pointC);
    this._abx = this._b.getDoublePositionX() - this._a.getDoublePositionX();
    this._bcx = this._c.getDoublePositionX() - this._b.getDoublePositionX();
    this._cax = this._a.getDoublePositionX() - this._c.getDoublePositionX();
    this._aby = this._b.getDoublePositionY() - this._a.getDoublePositionY();
    this._bcy = this._c.getDoublePositionY() - this._b.getDoublePositionY();
    this._cay = this._a.getDoublePositionY() - this._c.getDoublePositionY();
  }

  /** @ac game/Maps/AreaBoundary.cpp TriangleBoundary::IsWithinBoundaryArea */
  protected override isWithinBoundaryArea(pos: PositionLike): boolean {
    // half-plane signs
    const sign1 = (-this._b.getDoublePositionX() + pos.getPositionX()) * this._aby - (-this._b.getDoublePositionY() + pos.getPositionY()) * this._abx < 0;
    const sign2 = (-this._c.getDoublePositionX() + pos.getPositionX()) * this._bcy - (-this._c.getDoublePositionY() + pos.getPositionY()) * this._bcx < 0;
    const sign3 = (-this._a.getDoublePositionX() + pos.getPositionX()) * this._cay - (-this._a.getDoublePositionY() + pos.getPositionY()) * this._cax < 0;

    // if all signs are the same, the point is inside the triangle
    return sign1 === sign2 && sign2 === sign3;
  }
}

/** @ac game/Maps/AreaBoundary.h ParallelogramBoundary */
export class ParallelogramBoundary extends AreaBoundary {
  private readonly _a: DoublePosition;
  private readonly _b: DoublePosition;
  private readonly _d: DoublePosition;
  private readonly _c: DoublePosition;
  private readonly _abx: number;
  private readonly _dax: number;
  private readonly _aby: number;
  private readonly _day: number;

  /**
   * @ac game/Maps/AreaBoundary.cpp ParallelogramBoundary::ParallelogramBoundary
   * Note: AB must be orthogonal to AD
   */
  constructor(cornerA: PositionLike, cornerB: PositionLike, cornerD: PositionLike, isInverted = false) {
    super(isInverted);
    this._a = new DoublePosition(cornerA);
    this._b = new DoublePosition(cornerB);
    this._d = new DoublePosition(cornerD);
    this._c = new DoublePosition(
      this._d.getDoublePositionX() + (this._b.getDoublePositionX() - this._a.getDoublePositionX()),
      this._d.getDoublePositionY() + (this._b.getDoublePositionY() - this._a.getDoublePositionY()),
    );
    this._abx = this._b.getDoublePositionX() - this._a.getDoublePositionX();
    this._dax = this._a.getDoublePositionX() - this._d.getDoublePositionX();
    this._aby = this._b.getDoublePositionY() - this._a.getDoublePositionY();
    this._day = this._a.getDoublePositionY() - this._d.getDoublePositionY();
  }

  /** @ac game/Maps/AreaBoundary.cpp ParallelogramBoundary::IsWithinBoundaryArea */
  protected override isWithinBoundaryArea(pos: PositionLike): boolean {
    // half-plane signs
    const sign1 = (-this._b.getDoublePositionX() + pos.getPositionX()) * this._aby - (-this._b.getDoublePositionY() + pos.getPositionY()) * this._abx < 0;
    const sign2 = (-this._a.getDoublePositionX() + pos.getPositionX()) * this._day - (-this._a.getDoublePositionY() + pos.getPositionY()) * this._dax < 0;
    const sign3 = (-this._d.getDoublePositionY() + pos.getPositionY()) * this._abx - (-this._d.getDoublePositionX() + pos.getPositionX()) * this._aby < 0; // AB = -CD
    const sign4 = (-this._c.getDoublePositionY() + pos.getPositionY()) * this._dax - (-this._c.getDoublePositionX() + pos.getPositionX()) * this._day < 0; // DA = -BC

    // if all signs are equal, the point is inside
    return sign1 === sign2 && sign2 === sign3 && sign3 === sign4;
  }
}

/** @ac game/Maps/AreaBoundary.h ZRangeBoundary */
export class ZRangeBoundary extends AreaBoundary {
  private readonly _minZ: number;
  private readonly _maxZ: number;

  /** @ac game/Maps/AreaBoundary.cpp ZRangeBoundary::ZRangeBoundary */
  constructor(minZ: number, maxZ: number, isInverted = false) {
    super(isInverted);
    this._minZ = Math.fround(minZ);
    this._maxZ = Math.fround(maxZ);
  }

  /** @ac game/Maps/AreaBoundary.cpp ZRangeBoundary::IsWithinBoundaryArea */
  protected override isWithinBoundaryArea(pos: PositionLike): boolean {
    return this._minZ <= pos.getPositionZ() && pos.getPositionZ() <= this._maxZ;
  }
}

/** @ac game/Maps/AreaBoundary.h BoundaryUnionBoundary */
export class BoundaryUnionBoundary extends AreaBoundary {
  private readonly _b1: AreaBoundary;
  private readonly _b2: AreaBoundary;

  /** @ac game/Maps/AreaBoundary.cpp BoundaryUnionBoundary::BoundaryUnionBoundary */
  constructor(b1: AreaBoundary, b2: AreaBoundary, isInverted = false) {
    super(isInverted);
    if (!b1 || !b2) throw new Error("BoundaryUnionBoundary: ASSERT(b1 && b2)");
    this._b1 = b1;
    this._b2 = b2;
  }

  /** @ac game/Maps/AreaBoundary.cpp BoundaryUnionBoundary::IsWithinBoundaryArea */
  protected override isWithinBoundaryArea(pos: PositionLike): boolean {
    return this._b1.isWithinBoundary(pos) || this._b2.isWithinBoundary(pos);
  }
}

/** @ac game/Maps/AreaBoundary.h BoundaryIntersectBoundary */
export class BoundaryIntersectBoundary extends AreaBoundary {
  private readonly _b1: AreaBoundary;
  private readonly _b2: AreaBoundary;

  /** @ac game/Maps/AreaBoundary.cpp BoundaryIntersectBoundary::BoundaryIntersectBoundary */
  constructor(b1: AreaBoundary, b2: AreaBoundary, isInverted = false) {
    super(isInverted);
    if (!b1 || !b2) throw new Error("BoundaryIntersectBoundary: ASSERT(b1 && b2)");
    this._b1 = b1;
    this._b2 = b2;
  }

  /** @ac game/Maps/AreaBoundary.cpp BoundaryIntersectBoundary::IsWithinBoundaryArea */
  protected override isWithinBoundaryArea(pos: PositionLike): boolean {
    return this._b1.isWithinBoundary(pos) && this._b2.isWithinBoundary(pos);
  }
}
