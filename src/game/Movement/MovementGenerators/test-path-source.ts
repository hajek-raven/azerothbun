/** Test helper: fake `PathSource` / `PathSourceCreature` / `PathSourceMap` for `PathGenerator` tests. */
import type { dtNavMesh } from "../../../common/Detour/DetourNavMesh.ts";
import type { dtNavMeshQuery } from "../../../common/Detour/DetourNavMeshQuery.ts";
import type { PathLiquidData, PathPosition, PathSource, PathSourceCreature, PathSourceMap } from "./PathGenerator.ts";

export interface FakeCreatureOptions {
  canWalk?: boolean;
  canSwim?: boolean;
  canFly?: boolean;
  canEnterWater?: boolean;
  isFalling?: boolean;
  isInWater?: boolean;
  isUnderWater?: boolean;
  unitState?: number;
}

export function fakeCreature(opts: FakeCreatureOptions = {}): PathSourceCreature {
  return {
    hasUnitState: (state) => ((opts.unitState ?? 0) & state) !== 0,
    canSwim: () => opts.canSwim ?? false,
    canFly: () => opts.canFly ?? false,
    isFalling: () => opts.isFalling ?? false,
    isInWater: () => opts.isInWater ?? false,
    isUnderWater: () => opts.isUnderWater ?? false,
    canWalk: () => opts.canWalk ?? true,
    canEnterWater: () => opts.canEnterWater ?? false,
  };
}

export interface FakeMapOptions {
  navMesh?: dtNavMesh | null;
  query?: dtNavMeshQuery | null;
  liquid?: (x: number, y: number, z: number) => PathLiquidData;
  inWater?: (x: number, y: number, z: number) => boolean;
  los?: (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) => boolean;
}

export function fakeMap(opts: FakeMapOptions = {}): PathSourceMap {
  return {
    getMapCollisionData: () => ({
      getMMapData: () => ({ getNavMesh: () => opts.navMesh ?? null, getNavMeshQuery: () => opts.query ?? null }),
    }),
    getLiquidData: (_phaseMask, x, y, z) => (opts.liquid ? opts.liquid(x, y, z) : { Status: 0, Flags: 0 }),
    isInWater: (_phaseMask, x, y, z) => (opts.inWater ? opts.inWater(x, y, z) : false),
    isInLineOfSight: (x1, y1, z1, x2, y2, z2) => (opts.los ? opts.los(x1, y1, z1, x2, y2, z2) : true),
  };
}

/** A source at world `pos` (`creature` null means a player: `ToCreature()` is null and `ToUnit()` is a plain unit). */
export function fakeSource(
  map: PathSourceMap,
  pos: [number, number, number],
  creature: PathSourceCreature | null,
  mapId = 0,
  updateZ: (x: number, y: number, z: number) => number = (_x, _y, z) => z,
): PathSource {
  const player = fakeCreature();
  return {
    getMap: () => map,
    getMapId: () => mapId,
    getPhaseMask: () => 1,
    getPositionX: () => pos[0],
    getPositionY: () => pos[1],
    getPositionZ: () => pos[2],
    getCollisionHeight: () => 2,
    getGUID: () => 1n,
    isCreature: () => creature !== null,
    toUnit: () => creature ?? player,
    toCreature: () => creature,
    updateAllowedPositionZ: updateZ,
    getHitSpherePointFor: (dest: PathPosition) => dest,
  };
}
