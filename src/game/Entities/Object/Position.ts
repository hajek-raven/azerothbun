/**
 * `Position` and `WorldLocation`. Every read of a coordinate, including the ones inside these classes, goes through
 * `getPositionX()` / `getPositionY()` / `getPositionZ()` / `getOrientation()`, so a subclass that keeps its position
 * elsewhere (the player facade reads the character row) only overrides the getters and everything else follows.
 *
 * C++ `WorldObject` derives from both `Object` and `WorldLocation`. TypeScript has single inheritance, so the members
 * are written once as mixins (`PositionMixin`, `WorldLocationMixin`); `Position` and `WorldLocation` are those mixins
 * over an empty base, and `WorldObject` is `WorldLocationMixin(PositionMixin(Object))`.
 */
import type { ByteReader, ByteWriter } from "../../../net/byte-buffer.ts";
import { randNorm } from "../../../common/random.ts";
import { IsValidMapCoord } from "../../Grids/GridDefines.ts";

const M_PI = Math.PI;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AbstractCtor<T = object> = abstract new (...args: any[]) => T;

/** @ac deps/g3dlite/include/G3D/g3dmath.h fuzzyEq (float, `fuzzyEpsilon32` scaled by magnitude) */
export function fuzzyEq(a: number, b: number): boolean {
  if (a === b) return true;
  const aa = Math.abs(a) + 1.0;
  const eps = aa === Infinity ? 0.00001 : 0.00001 * aa;
  return Math.abs(a - b) <= eps;
}

/** @ac common/Utilities/Geometry.h getAngle */
export function getAngle(startX: number, startY: number, destX: number, destY: number): number {
  const dx = destX - startX;
  const dy = destY - startY;
  const ang = Math.atan2(dy, dx);
  return ang >= 0 ? ang : 2 * M_PI + ang;
}

/**
 * @ac game/Entities/Object/Position.h Position::NormalizeOrientation
 * modulos a radian orientation to the range of 0..2PI
 */
export function NormalizeOrientation(o: number): number {
  // fmod only supports positive numbers. Thus we have
  // to emulate negative numbers
  if (o < 0) {
    let mod = o * -1;
    mod = mod % (2.0 * M_PI);
    mod = -mod + 2.0 * M_PI;
    return mod;
  }
  return o % (2.0 * M_PI);
}

/** Anything with the four position getters (`Position const&` arguments). */
export interface PositionLike {
  getPositionX(): number;
  getPositionY(): number;
  getPositionZ(): number;
  getOrientation(): number;
}

/** @ac game/Entities/Object/Position.cpp Position::ToString */
function positionToString(pos: PositionLike): string {
  return `X: ${pos.getPositionX()} Y: ${pos.getPositionY()} Z: ${pos.getPositionZ()} O: ${pos.getOrientation()}`;
}

/** @ac game/Entities/Object/Position.h Position (the members, over any base class) */
export function PositionMixin<TBase extends AbstractCtor>(Base: TBase) {
  abstract class PositionImpl extends Base implements PositionLike {
    m_positionX = 0;
    m_positionY = 0;
    m_positionZ = 0;
    /** Better to limit access to _orientation field, to guarantee the value is normalized */
    m_orientation = 0;

    /** @ac game/Entities/Object/Position.cpp Position::operator== */
    equals(a: PositionLike): boolean {
      return (
        fuzzyEq(a.getPositionX(), this.getPositionX()) &&
        fuzzyEq(a.getPositionY(), this.getPositionY()) &&
        fuzzyEq(a.getPositionZ(), this.getPositionZ()) &&
        fuzzyEq(a.getOrientation(), this.getOrientation())
      );
    }

    /**
     * @ac game/Entities/Object/Position.h Position::Relocate
     * The `(x, y)`, `(x, y, z)`, `(x, y, z, o)`, and `(Position const&)` overloads. The orientation is stored as given.
     */
    relocate(xOrPos: number | PositionLike, y?: number, z?: number, orientation?: number): void {
      if (typeof xOrPos !== "number") {
        this.m_positionX = xOrPos.getPositionX();
        this.m_positionY = xOrPos.getPositionY();
        this.m_positionZ = xOrPos.getPositionZ();
        this.m_orientation = xOrPos.getOrientation();
        return;
      }
      this.m_positionX = xOrPos;
      this.m_positionY = y ?? 0;
      if (z !== undefined) this.m_positionZ = z;
      if (orientation !== undefined) this.m_orientation = orientation;
    }

    /** @ac game/Entities/Object/Position.cpp Position::RelocatePolarOffset */
    relocatePolarOffset(angle: number, dist: number, z = 0.0): void {
      this.setOrientation(this.getOrientation() + angle);

      const x = this.getPositionX() + dist * Math.cos(this.getOrientation());
      const y = this.getPositionY() + dist * Math.sin(this.getOrientation());
      const nz = this.getPositionZ() + z;
      this.m_positionX = x;
      this.m_positionY = y;
      this.m_positionZ = nz;
    }

    /** @ac game/Entities/Object/Position.cpp Position::RelocateOffset */
    relocateOffset(offset: PositionLike): void {
      const o = this.getOrientation();
      const x = this.getPositionX() + (offset.getPositionX() * Math.cos(o) + offset.getPositionY() * Math.sin(o + M_PI));
      const y = this.getPositionY() + (offset.getPositionY() * Math.cos(o) + offset.getPositionX() * Math.sin(o));
      const z = this.getPositionZ() + offset.getPositionZ();
      this.m_positionX = x;
      this.m_positionY = y;
      this.m_positionZ = z;
      this.m_orientation = o + offset.getOrientation();
    }

    /** @ac game/Entities/Object/Position.h Position::SetOrientation */
    setOrientation(orientation: number): void {
      this.m_orientation = orientation;
    }

    /** @ac game/Entities/Object/Position.h Position::GetPositionX */
    getPositionX(): number {
      return this.m_positionX;
    }

    /** @ac game/Entities/Object/Position.h Position::GetPositionY */
    getPositionY(): number {
      return this.m_positionY;
    }

    /** @ac game/Entities/Object/Position.h Position::GetPositionZ */
    getPositionZ(): number {
      return this.m_positionZ;
    }

    /** @ac game/Entities/Object/Position.h Position::GetOrientation */
    getOrientation(): number {
      return this.m_orientation;
    }

    /** @ac game/Entities/Object/Position.h Position::GetPosition (the copy; the out-parameter overloads read the getters) */
    getPosition(): Position {
      return Position.copy(this);
    }

    /** @ac game/Entities/Object/Position.cpp Position::IsPositionValid */
    isPositionValid(): boolean {
      return IsValidMapCoord(this.getPositionX(), this.getPositionY(), this.getPositionZ(), this.getOrientation());
    }

    /** @ac game/Entities/Object/Position.h Position::GetExactDist2dSq (`(x, y)` or `(Position const&)`) */
    getExactDist2dSq(xOrPos: number | PositionLike, y?: number): number {
      const tx = typeof xOrPos === "number" ? xOrPos : xOrPos.getPositionX();
      const ty = typeof xOrPos === "number" ? (y ?? 0) : xOrPos.getPositionY();
      const dx = tx - this.getPositionX();
      const dy = ty - this.getPositionY();
      return dx * dx + dy * dy;
    }

    /** @ac game/Entities/Object/Position.h Position::GetExactDist2d */
    getExactDist2d(xOrPos: number | PositionLike, y?: number): number {
      return Math.sqrt(this.getExactDist2dSq(xOrPos, y));
    }

    /** @ac game/Entities/Object/Position.h Position::GetExactDistSq (`(x, y, z)` or `(Position const&)`) */
    getExactDistSq(xOrPos: number | PositionLike, y?: number, z?: number): number {
      if (typeof xOrPos !== "number") {
        return this.getExactDistSq(xOrPos.getPositionX(), xOrPos.getPositionY(), xOrPos.getPositionZ());
      }
      const dz = (z ?? 0) - this.getPositionZ();
      return this.getExactDist2dSq(xOrPos, y) + dz * dz;
    }

    /** @ac game/Entities/Object/Position.h Position::GetExactDist */
    getExactDist(xOrPos: number | PositionLike, y?: number, z?: number): number {
      return Math.sqrt(this.getExactDistSq(xOrPos, y, z));
    }

    /** @ac game/Entities/Object/Position.cpp Position::GetPositionOffsetTo */
    getPositionOffsetTo(endPos: PositionLike, retOffset: Position): void {
      const dx = endPos.getPositionX() - this.getPositionX();
      const dy = endPos.getPositionY() - this.getPositionY();
      const o = this.getOrientation();

      retOffset.m_positionX = dx * Math.cos(o) + dy * Math.sin(o);
      retOffset.m_positionY = dy * Math.cos(o) - dx * Math.sin(o);
      retOffset.m_positionZ = endPos.getPositionZ() - this.getPositionZ();
      retOffset.m_orientation = endPos.getOrientation() - o;
    }

    /** @ac game/Entities/Object/Position.h Position::GetPositionWithOffset */
    getPositionWithOffset(offset: PositionLike): Position {
      const ret = Position.copy(this);
      ret.relocateOffset(offset);
      return ret;
    }

    /**
     * @ac game/Entities/Object/Position.cpp Position::GetAngle
     * `(Position const*)` (0 for null) or `(x, y)`: the angle in 0..2*pi from here to the point.
     */
    getAngle(xOrPos: number | PositionLike | null, y?: number): number {
      if (xOrPos === null) return 0;
      if (typeof xOrPos !== "number") return this.getAngle(xOrPos.getPositionX(), xOrPos.getPositionY());
      return getAngle(this.getPositionX(), this.getPositionY(), xOrPos, y ?? 0);
    }

    /** @ac game/Entities/Object/Position.h Position::GetAbsoluteAngle */
    getAbsoluteAngle(xOrPos: number | PositionLike, y?: number): number {
      const tx = typeof xOrPos === "number" ? xOrPos : xOrPos.getPositionX();
      const ty = typeof xOrPos === "number" ? (y ?? 0) : xOrPos.getPositionY();
      return NormalizeOrientation(Math.atan2(ty - this.getPositionY(), tx - this.getPositionX()));
    }

    /** @ac game/Entities/Object/Position.h Position::GetRelativeAngle */
    getRelativeAngle(xOrPos: number | PositionLike, y?: number): number {
      return NormalizeOrientation(this.getAngle(xOrPos, y) - this.getOrientation());
    }

    /** @ac game/Entities/Object/Position.h Position::ToAbsoluteAngle */
    toAbsoluteAngle(relAngle: number): number {
      return NormalizeOrientation(relAngle + this.getOrientation());
    }

    /** @ac game/Entities/Object/Position.cpp Position::GetSinCos (the out parameters as the returned pair) */
    getSinCos(x: number, y: number): { vsin: number; vcos: number } {
      const dx = this.getPositionX() - x;
      const dy = this.getPositionY() - y;

      if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
        const angle = randNorm() * 2 * M_PI;
        return { vcos: Math.cos(angle), vsin: Math.sin(angle) };
      }
      const dist = Math.sqrt(dx * dx + dy * dy);
      return { vcos: dx / dist, vsin: dy / dist };
    }

    /** @ac game/Entities/Object/Position.h Position::IsInDist2d (`(x, y, dist)` or `(Position const*, dist)`) */
    isInDist2d(xOrPos: number | PositionLike, yOrDist: number, dist?: number): boolean {
      if (typeof xOrPos !== "number") return this.getExactDist2dSq(xOrPos) < yOrDist * yOrDist;
      const d = dist ?? 0;
      return this.getExactDist2dSq(xOrPos, yOrDist) < d * d;
    }

    /** @ac game/Entities/Object/Position.h Position::IsInDist (`(x, y, z, dist)` or `(Position const*, dist)`) */
    isInDist(xOrPos: number | PositionLike, yOrDist: number, z?: number, dist?: number): boolean {
      if (typeof xOrPos !== "number") return this.getExactDistSq(xOrPos) < yOrDist * yOrDist;
      const d = dist ?? 0;
      return this.getExactDistSq(xOrPos, yOrDist, z) < d * d;
    }

    /** @ac game/Entities/Object/Position.cpp Position::IsWithinBox */
    isWithinBox(center: PositionLike, xradius: number, yradius: number, zradius: number): boolean {
      // rotate the WorldObject position instead of rotating the whole cube, that way we can make a simplified
      // is-in-cube check and we have to calculate only one point instead of 4

      // 2PI = 360*, keep in mind that ingame orientation is counter-clockwise
      const rotation = 2 * M_PI - center.getOrientation();
      const sinVal = Math.sin(rotation);
      const cosVal = Math.cos(rotation);

      const BoxDistX = this.getPositionX() - center.getPositionX();
      const BoxDistY = this.getPositionY() - center.getPositionY();

      const rotX = center.getPositionX() + BoxDistX * cosVal - BoxDistY * sinVal;
      const rotY = center.getPositionY() + BoxDistY * cosVal + BoxDistX * sinVal;

      // box edges are parallel to coordiante axis, so we can treat every dimension independently :D
      const dz = this.getPositionZ() - center.getPositionZ();
      const dx = rotX - center.getPositionX();
      const dy = rotY - center.getPositionY();
      if (Math.abs(dx) > xradius || Math.abs(dy) > yradius || Math.abs(dz) > zradius) {
        return false;
      }

      return true;
    }

    /** @ac game/Entities/Object/Position.cpp Position::HasInArc */
    hasInArc(arc: number, obj: PositionLike, targetRadius = 0.0): boolean {
      // always have self in arc
      if (obj === this) return true;

      // move arc to range 0.. 2*pi
      arc = NormalizeOrientation(arc);

      let angle = this.getAngle(obj);
      angle -= this.getOrientation();

      // move angle to range -pi ... +pi
      angle = NormalizeOrientation(angle);
      if (angle > M_PI) angle -= 2.0 * M_PI;

      let lborder = -1 * (arc / 2.0); // in range -pi..0
      let rborder = arc / 2.0; // in range 0..pi

      // pussywizard: take into consideration target size
      if (targetRadius > 0.0) {
        const distSq = this.getExactDist2dSq(obj);
        // pussywizard: at least a part of target's model is in every direction
        if (distSq < targetRadius * targetRadius) return true;
        const angularRadius = 2.0 * Math.atan(targetRadius / (2.0 * Math.sqrt(distSq)));
        lborder -= angularRadius;
        rborder += angularRadius;
      }

      return angle >= lborder && angle <= rborder;
    }

    /** @ac game/Entities/Object/Position.cpp Position::HasInLine (`(pos, width)` and `(pos, objSize, width)`) */
    hasInLine(pos: PositionLike, objSizeOrWidth: number, width?: number): boolean {
      const objSize = width === undefined ? 0 : objSizeOrWidth;
      let w = width === undefined ? objSizeOrWidth : width;
      if (!this.hasInArc(M_PI, pos)) return false;

      w += objSize;

      const angle = this.getRelativeAngle(pos);
      return Math.abs(Math.sin(angle)) * this.getExactDist2d(pos.getPositionX(), pos.getPositionY()) < w;
    }

    /** @ac game/Entities/Object/Position.cpp Position::ToString */
    override toString(): string {
      return positionToString(this);
    }
  }
  return PositionImpl;
}

class PositionRoot {}

/** @ac game/Entities/Object/Position.h Position */
export class Position extends PositionMixin(PositionRoot) {
  /** @ac game/Entities/Object/Position.h Position::Position */
  constructor(x = 0, y = 0, z = 0, o = 0) {
    super();
    this.m_positionX = x;
    this.m_positionY = y;
    this.m_positionZ = z;
    this.m_orientation = NormalizeOrientation(o);
  }

  /** @ac game/Entities/Object/Position.h Position::Position(Position const& loc) (copies without normalizing) */
  static copy(loc: PositionLike): Position {
    const pos = new Position();
    pos.relocate(loc);
    return pos;
  }

  /** @ac game/Entities/Object/Position.h Position::NormalizeOrientation */
  static NormalizeOrientation(o: number): number {
    return NormalizeOrientation(o);
  }
}

/** @ac game/Entities/Object/Position.h MAPID_INVALID */
export const MAPID_INVALID = 0xffffffff;

/** The position members `WorldLocationMixin` builds on. */
type PositionMembers = InstanceType<ReturnType<typeof PositionMixin<typeof PositionRoot>>>;

/** @ac game/Entities/Object/Position.h WorldLocation (the members, over a position class) */
export function WorldLocationMixin<TBase extends AbstractCtor<PositionMembers>>(Base: TBase) {
  abstract class WorldLocationImpl extends Base {
    m_mapId = MAPID_INVALID;

    /** @ac game/Entities/Object/Position.h WorldLocation::WorldRelocate (`(WorldLocation const&)` or `(mapId, x, y, z, o)`) */
    worldRelocate(locOrMapId: (PositionLike & { getMapId(): number }) | number = MAPID_INVALID, x = 0, y = 0, z = 0, o = 0): void {
      if (typeof locOrMapId !== "number") {
        this.m_mapId = locOrMapId.getMapId();
        this.relocate(locOrMapId);
        return;
      }
      this.m_mapId = locOrMapId;
      this.relocate(x, y, z, o);
    }

    /** @ac game/Entities/Object/Position.h WorldLocation::SetMapId */
    setMapId(mapId: number): void {
      this.m_mapId = mapId;
    }

    /** @ac game/Entities/Object/Position.h WorldLocation::GetMapId */
    getMapId(): number {
      return this.m_mapId;
    }

    /** @ac game/Entities/Object/Position.h WorldLocation::GetWorldLocation (the copy) */
    getWorldLocation(): WorldLocation {
      return new WorldLocation(this.getMapId(), this.getPositionX(), this.getPositionY(), this.getPositionZ(), this.getOrientation());
    }

    /** @ac game/Entities/Object/Position.h WorldLocation::GetWorldLocation (into `location`) */
    getWorldLocationInto(location: WorldLocation | null): void {
      if (location) {
        location.relocate(this.getPositionX(), this.getPositionY(), this.getPositionZ(), this.getOrientation());
        location.setMapId(this.getMapId());
      }
    }

    /** @ac game/Entities/Object/Position.cpp WorldLocation::GetDebugInfo */
    getDebugInfo(): string {
      return `MapID: ${this.getMapId()} ${positionToString(this)}`;
    }
  }
  return WorldLocationImpl;
}

/** @ac game/Entities/Object/Position.h WorldLocation */
export class WorldLocation extends WorldLocationMixin(Position) {
  /** @ac game/Entities/Object/Position.h WorldLocation::WorldLocation */
  constructor(mapId = MAPID_INVALID, x = 0, y = 0, z = 0, o = 0) {
    super(x, y, z, o);
    this.m_mapId = mapId;
  }

  /** @ac game/Entities/Object/Position.h WorldLocation::WorldLocation(uint32 mapId, Position const& position) */
  static fromPosition(mapId: number, position: PositionLike): WorldLocation {
    const loc = new WorldLocation(mapId);
    loc.relocate(position);
    return loc;
  }
}

/** @ac game/Entities/Object/Position.cpp operator<<(ByteBuffer&, Position::PositionXYZStreamer const&) */
export function writePositionXYZ(buf: ByteWriter, pos: PositionLike): ByteWriter {
  return buf.writeF32(pos.getPositionX()).writeF32(pos.getPositionY()).writeF32(pos.getPositionZ());
}

/** @ac game/Entities/Object/Position.cpp operator<<(ByteBuffer&, Position::PositionXYZOStreamer const&) */
export function writePositionXYZO(buf: ByteWriter, pos: PositionLike): ByteWriter {
  return writePositionXYZ(buf, pos).writeF32(pos.getOrientation());
}

/** @ac game/Entities/Object/Position.cpp operator>>(ByteBuffer&, Position::PositionXYZStreamer const&) */
export function readPositionXYZ(buf: ByteReader, pos: Position): void {
  const x = buf.readF32();
  const y = buf.readF32();
  const z = buf.readF32();
  pos.relocate(x, y, z);
}

/** @ac game/Entities/Object/Position.cpp operator>>(ByteBuffer&, Position::PositionXYZOStreamer const&) */
export function readPositionXYZO(buf: ByteReader, pos: Position): void {
  const x = buf.readF32();
  const y = buf.readF32();
  const z = buf.readF32();
  const o = buf.readF32();
  pos.relocate(x, y, z, o);
}
