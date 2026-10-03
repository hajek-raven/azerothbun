/**
 * The static members of `MapMgr` and the map constants `GridDefines.h` shares with it. They live in their own module
 * (re-exported by `MapMgr.ts`) so `Grids/GridDefines.ts` and `ObjectMgr` can use them without importing the `Map` class,
 * which imports the grids and would close an import cycle.
 */
import { instance_template } from "../../database/schema/world.ts";
import type { WorldTables } from "../../database/world-tables.ts";
import { sMapStore } from "../DataStores/DBCStores.ts";

export const SIZE_OF_GRIDS = 533.3333;
export const MAX_NUMBER_OF_GRIDS = 64;
export const MAP_SIZE = SIZE_OF_GRIDS * MAX_NUMBER_OF_GRIDS;
export const MAP_HALFSIZE = MAP_SIZE / 2;

const MAP_INSTANCE = 1;
const MAP_RAID = 2;

let worldTables: WorldTables | null = null;

/** The world rows `IsValidMAP` and `GetInstanceTemplate` read `instance_template` from. */
export function setMapMgrWorld(world: WorldTables | null): void {
  worldTables = world;
}

/** @ac game/Maps/Map.h InstanceTemplate */
export interface InstanceTemplate {
  Parent: number;
  ScriptId: number;
  AllowMount: boolean;
}

/**
 * What turns an `instance_template.script` name into the `ScriptId` of `ObjectMgr::GetScriptId` (the integration sets it
 * to `sObjectMgr.getScriptId`; 0 until then).
 */
export const InstanceTemplateHooks: { getScriptId: (scriptName: string) => number } = {
  getScriptId: () => 0,
};

/** @ac game/Globals/ObjectMgr.cpp ObjectMgr::GetInstanceTemplate (`LoadInstanceTemplate` rows, read on demand from `instance_template`) */
export function GetInstanceTemplate(mapId: number): InstanceTemplate | null {
  const row = worldTables?.first(instance_template, "map", mapId) ?? null;
  if (!row) return null;
  return { Parent: row.parent, ScriptId: InstanceTemplateHooks.getScriptId(row.script), AllowMount: row.allowMount !== 0 };
}

/** @ac game/Maps/MapMgr.cpp MapMgr::IsValidMAP */
export function isValidMAP(mapid: number, startUp = false): boolean {
  const mEntry = sMapStore.lookupEntry(mapid);
  if (startUp) return mEntry !== null;
  if (!mEntry) return false;
  const isDungeon = mEntry.map_type === MAP_INSTANCE || mEntry.map_type === MAP_RAID;
  return !isDungeon || (worldTables?.first(instance_template, "map", mapid) ?? null) !== null;
}

/** @ac game/Grids/GridDefines.h Acore::IsValidMapCoord */
export function isValidCoord(c: number): boolean {
  return Number.isFinite(c) && Math.abs(c) <= MAP_HALFSIZE - 0.5;
}

/** A `Position const&` / `WorldLocation const&` argument of `IsValidMapCoord`. */
interface MapCoordPosition {
  getPositionX(): number;
  getPositionY(): number;
  getPositionZ(): number;
  getOrientation(): number;
}
interface MapCoordLocation extends MapCoordPosition {
  getMapId(): number;
}

/**
 * @ac game/Maps/MapMgr.h MapMgr::IsValidMapCoord
 * The `(mapid, x, y)`, `(mapid, x, y, z)`, `(mapid, x, y, z, o)`, `(mapid, Position const&)`, and `(WorldLocation const&)`
 * overloads.
 */
export function isValidMapCoord(mapid: number, x: number, y: number, z?: number, o?: number): boolean;
export function isValidMapCoord(mapid: number, pos: MapCoordPosition): boolean;
export function isValidMapCoord(loc: MapCoordLocation): boolean;
export function isValidMapCoord(a: number | MapCoordLocation, b?: number | MapCoordPosition, y?: number, z?: number, o?: number): boolean {
  if (typeof a === "object") return isValidMapCoord(a.getMapId(), a.getPositionX(), a.getPositionY(), a.getPositionZ(), a.getOrientation());
  if (typeof b === "object") return isValidMapCoord(a, b.getPositionX(), b.getPositionY(), b.getPositionZ(), b.getOrientation());
  const x = b as number;
  return isValidMAP(a, false) && isValidCoord(x) && isValidCoord(y!) && (z === undefined || isValidCoord(z)) && (o === undefined || Number.isFinite(o));
}

/** @ac game/Maps/MapMgr.h MapMgr::NormalizeOrientation */
export function normalizeOrientation(o: number): number {
  const twoPi = 2 * Math.PI;
  if (o < 0) {
    const mod = -o % twoPi;
    return -mod + twoPi;
  }
  return o % twoPi;
}
