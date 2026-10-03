/**
 * @ac game/Grids/GridDefines.h
 * Grid and cell coordinates. A map is `MAX_NUMBER_OF_GRIDS` x `MAX_NUMBER_OF_GRIDS` grids of `SIZE_OF_GRIDS` yards, each
 * split into `MAX_NUMBER_OF_CELLS` x `MAX_NUMBER_OF_CELLS` cells. Coordinates grow toward -x/-y (grid 0 is the
 * north-west corner at +x/+y).
 */
import { isValidCoord, MAP_HALFSIZE as MAPMGR_MAP_HALFSIZE } from "../Maps/MapMgrStatics.ts";
import type { Corpse } from "../Entities/Corpse/Corpse.ts";
import type { Creature } from "../Entities/Creature/Creature.ts";
import type { DynamicObject } from "../Entities/DynamicObject/DynamicObject.ts";
import type { GameObject } from "../Entities/GameObject/GameObject.ts";
import type { GridPlayer } from "./GridPlayer.ts";
import type { GridRefMgr } from "./GridRefMgr.ts";

/** @ac common/Collision/Maps/MapDefines.h MAX_NUMBER_OF_GRIDS */
export const MAX_NUMBER_OF_GRIDS = 64;
/** @ac common/Collision/Maps/MapDefines.h MAX_NUMBER_OF_CELLS */
export const MAX_NUMBER_OF_CELLS = 8;
/** @ac common/Collision/Maps/MapDefines.h SIZE_OF_GRIDS */
export const SIZE_OF_GRIDS = 533.3333;

export const CENTER_GRID_ID = MAX_NUMBER_OF_GRIDS / 2;

export const CENTER_GRID_OFFSET = SIZE_OF_GRIDS / 2;

/** `MINUTE * IN_MILLISECONDS` */
export const MIN_GRID_DELAY = 60 * 1000;
export const MIN_MAP_UPDATE_DELAY = 1;

export const SIZE_OF_GRID_CELL = SIZE_OF_GRIDS / MAX_NUMBER_OF_CELLS;

export const CENTER_GRID_CELL_ID = (MAX_NUMBER_OF_CELLS * MAX_NUMBER_OF_GRIDS) / 2;
export const CENTER_GRID_CELL_OFFSET = SIZE_OF_GRID_CELL / 2;

export const TOTAL_NUMBER_OF_CELLS_PER_MAP = MAX_NUMBER_OF_GRIDS * MAX_NUMBER_OF_CELLS;

export const MAP_RESOLUTION = 128;

export const MAP_SIZE = SIZE_OF_GRIDS * MAX_NUMBER_OF_GRIDS;
/** Same value as `MapMgr.ts` `MAP_HALFSIZE` (kept there for the existing callers). */
export const MAP_HALFSIZE: number = MAPMGR_MAP_HALFSIZE;

/** @ac game/Grids/GridDefines.h GridMapTypeMask */
export const GRID_MAP_TYPE_MASK_CORPSE = 0x01;
export const GRID_MAP_TYPE_MASK_CREATURE = 0x02;
export const GRID_MAP_TYPE_MASK_DYNAMICOBJECT = 0x04;
export const GRID_MAP_TYPE_MASK_GAMEOBJECT = 0x08;
export const GRID_MAP_TYPE_MASK_PLAYER = 0x10;
export const GRID_MAP_TYPE_MASK_ALL = 0x1f;

/** @ac game/Grids/GridDefines.h CorpseMapType */
export type CorpseMapType = GridRefMgr<Corpse>;
/** @ac game/Grids/GridDefines.h CreatureMapType */
export type CreatureMapType = GridRefMgr<Creature>;
/** @ac game/Grids/GridDefines.h DynamicObjectMapType */
export type DynamicObjectMapType = GridRefMgr<DynamicObject>;
/** @ac game/Grids/GridDefines.h GameObjectMapType */
export type GameObjectMapType = GridRefMgr<GameObject>;
/** @ac game/Grids/GridDefines.h PlayerMapType */
export type PlayerMapType = GridRefMgr<GridPlayer>;

/** @ac game/Grids/GridDefines.h CoordPair */
export class CoordPair {
  /** @ac game/Grids/GridDefines.h CoordPair::CoordPair */
  constructor(
    readonly LIMIT: number,
    public x_coord = 0,
    public y_coord = 0,
  ) {}

  /** @ac game/Grids/GridDefines.h CoordPair::CoordPair(CoordPair const&) */
  clone(): this {
    const copy = Object.create(Object.getPrototypeOf(this)) as this;
    (copy as { LIMIT: number }).LIMIT = this.LIMIT;
    copy.x_coord = this.x_coord;
    copy.y_coord = this.y_coord;
    return copy;
  }

  /** @ac game/Grids/GridDefines.h CoordPair::dec_x */
  dec_x(val: number): void {
    if (this.x_coord > val) this.x_coord -= val;
    else this.x_coord = 0;
  }

  /** @ac game/Grids/GridDefines.h CoordPair::inc_x */
  inc_x(val: number): void {
    if (this.x_coord + val < this.LIMIT) this.x_coord += val;
    else this.x_coord = this.LIMIT - 1;
  }

  /** @ac game/Grids/GridDefines.h CoordPair::dec_y */
  dec_y(val: number): void {
    if (this.y_coord > val) this.y_coord -= val;
    else this.y_coord = 0;
  }

  /** @ac game/Grids/GridDefines.h CoordPair::inc_y */
  inc_y(val: number): void {
    if (this.y_coord + val < this.LIMIT) this.y_coord += val;
    else this.y_coord = this.LIMIT - 1;
  }

  /** @ac game/Grids/GridDefines.h CoordPair::IsCoordValid */
  isCoordValid(): boolean {
    return this.x_coord < this.LIMIT && this.y_coord < this.LIMIT;
  }

  /** @ac game/Grids/GridDefines.h CoordPair::normalize */
  normalize(): this {
    this.x_coord = Math.min(this.x_coord, this.LIMIT - 1);
    this.y_coord = Math.min(this.y_coord, this.LIMIT - 1);
    return this;
  }

  /** @ac game/Grids/GridDefines.h CoordPair::GetId */
  getId(): number {
    return this.y_coord * this.LIMIT + this.x_coord;
  }

  /** @ac game/Grids/GridDefines.h operator==(CoordPair const&, CoordPair const&) */
  equals(other: CoordPair): boolean {
    return this.x_coord === other.x_coord && this.y_coord === other.y_coord;
  }
}

/** @ac game/Grids/GridDefines.h GridCoord (`CoordPair<MAX_NUMBER_OF_GRIDS>`) */
export class GridCoord extends CoordPair {
  constructor(x = 0, y = 0) {
    super(MAX_NUMBER_OF_GRIDS, x, y);
  }
}

/** @ac game/Grids/GridDefines.h CellCoord (`CoordPair<TOTAL_NUMBER_OF_CELLS_PER_MAP>`) */
export class CellCoord extends CoordPair {
  constructor(x = 0, y = 0) {
    super(TOTAL_NUMBER_OF_CELLS_PER_MAP, x, y);
  }
}

/** C++ `uint32` from `int`: the value wraps like the implicit conversion in `CoordPair(uint32 x, uint32 y)`. */
function toUint32(value: number): number {
  return value >>> 0;
}

/**
 * @ac game/Grids/GridDefines.h Acore::Compute
 * `int gx = std::max<int>(0, (CENTER_VAL - x / size))`: the float result truncates toward zero, then clamps at 0.
 */
function Compute<T extends CoordPair>(make: (x: number, y: number) => T, centerVal: number, x: number, y: number, size: number): T {
  const gx = Math.max(0, Math.trunc(centerVal - x / size));
  const gy = Math.max(0, Math.trunc(centerVal - y / size));
  return make(toUint32(gx), toUint32(gy));
}

/** @ac game/Grids/GridDefines.h Acore::ComputeGridCoord */
export function ComputeGridCoord(x: number, y: number): GridCoord {
  return Compute((gx, gy) => new GridCoord(gx, gy), CENTER_GRID_ID, x, y, SIZE_OF_GRIDS);
}

/** @ac game/Grids/GridDefines.h Acore::ComputeGridCoordSimple */
export function ComputeGridCoordSimple(x: number, y: number): GridCoord {
  const gx = Math.trunc(CENTER_GRID_ID - x / SIZE_OF_GRIDS);
  const gy = Math.trunc(CENTER_GRID_ID - y / SIZE_OF_GRIDS);
  return new GridCoord(toUint32(MAX_NUMBER_OF_GRIDS - 1 - gx), toUint32(MAX_NUMBER_OF_GRIDS - 1 - gy));
}

/** @ac game/Grids/GridDefines.h Acore::ComputeCellCoord */
export function ComputeCellCoord(x: number, y: number): CellCoord {
  return Compute((cx, cy) => new CellCoord(cx, cy), CENTER_GRID_CELL_ID, x, y, SIZE_OF_GRID_CELL);
}

/** @ac game/Grids/GridDefines.h Acore::NormalizeMapCoord (the C++ reference parameter is the return value) */
export function NormalizeMapCoord(c: number): number {
  if (c > MAP_HALFSIZE - 0.5) return MAP_HALFSIZE - 0.5;
  if (c < -(MAP_HALFSIZE - 0.5)) return -(MAP_HALFSIZE - 0.5);
  return c;
}

/**
 * @ac game/Grids/GridDefines.h Acore::IsValidMapCoord
 * The `(c)`, `(x, y)`, `(x, y, z)`, and `(x, y, z, o)` overloads over `MapMgr.ts` `isValidCoord`.
 */
export function IsValidMapCoord(x: number, y?: number, z?: number, o?: number): boolean {
  if (!isValidCoord(x)) return false;
  if (y !== undefined && !isValidCoord(y)) return false;
  if (z !== undefined && !isValidCoord(z)) return false;
  if (o !== undefined && !Number.isFinite(o)) return false;
  return true;
}
