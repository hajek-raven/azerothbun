/**
 * @ac game/Entities/Object/Object.cpp WorldObject::IsWithinLOS
 * @ac game/Entities/Object/Object.cpp WorldObject::IsWithinLOSInMap
 * @ac game/Entities/Object/Object.cpp WorldObject::GetHitSpherePointFor
 *
 * Line of sight between two units that are not `WorldObject`s yet (the spell and combat code's `SpellUnit`s): the same
 * points `WorldObject::IsWithinLOSInMap` picks (a player's eye height, a creature's hit sphere toward the other one), asked of
 * `Map::IsInLineOfSight` (the vmap tree and the dynamic gameobject tree of the map).
 */
import { LINEOFSIGHT_ALL_CHECKS, ModelIgnoreFlags } from "../Grids/MapLike.ts";

/** The `Map::IsInLineOfSight` of a map (`Map` implements it; the module stays free of the map layer). */
export interface LineOfSightMap {
  isInLineOfSight(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, phasemask: number, checks: number, ignoreFlags: number): boolean;
}

/** What the line of sight of a unit reads: its place, phase, and size. */
export interface LineOfSightObject {
  map: number;
  /** `GetInstanceId()` (0 for a world map) */
  instance: number;
  phaseMask: number;
  isPlayer: boolean;
  x: number;
  y: number;
  z: number;
  /** `GetCollisionHeight()` */
  collisionHeight: number;
  /** `GetCombatReach()` */
  combatReach: number;
}

export interface LineOfSightPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * The maps line of sight is asked of: `MapSetup.setupMaps` installs `getTerrainMap`. Null (no `Map.dbc` row, no map) means
 * nothing is in the way.
 */
export const LineOfSightHooks: { findMap: (mapId: number, instanceId: number) => LineOfSightMap | null } = {
  findMap: () => null,
};

/** @ac game/Entities/Object/Object.cpp WorldObject::GetHitSpherePointFor (the `float& x, y, z` overload) */
export function GetHitSpherePointFor(obj: LineOfSightObject, dest: LineOfSightPoint, collisionHeight: number | null = null, combatReach: number | null = null): LineOfSightPoint {
  const thisX = obj.x;
  const thisY = obj.y;
  const thisZ = obj.z + (collisionHeight ?? obj.collisionHeight);
  // (vObj - vThis).directionOrZero()
  let dx = dest.x - thisX;
  let dy = dest.y - thisY;
  let dz = dest.z - thisZ;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len > 0.00001) {
    dx /= len;
    dy /= len;
    dz /= len;
  } else {
    dx = dy = dz = 0;
  }
  // `Position::GetExactDist(dest, this)`: the 3D distance between the two positions (the unit's own, without the eye height)
  const exact = Math.hypot(dest.x - obj.x, dest.y - obj.y, dest.z - obj.z);
  const reach = Math.min(exact, combatReach ?? obj.combatReach);
  return { x: thisX + dx * reach, y: thisY + dy * reach, z: thisZ + dz * reach };
}

/** @ac game/Entities/Object/Object.cpp WorldObject::IsWithinLOS (a point in the unit's map) */
export function isWithinLOS(obj: LineOfSightObject, ox: number, oy: number, oz: number, ignoreFlags: number = ModelIgnoreFlags.Nothing, checks: number = LINEOFSIGHT_ALL_CHECKS): boolean {
  const map = LineOfSightHooks.findMap(obj.map, obj.instance);
  if (!map) return true;

  oz += obj.collisionHeight;
  let x: number;
  let y: number;
  let z: number;
  if (obj.isPlayer) {
    x = obj.x;
    y = obj.y;
    z = obj.z + obj.collisionHeight;
  } else ({ x, y, z } = GetHitSpherePointFor(obj, { x: ox, y: oy, z: oz }));

  return map.isInLineOfSight(x, y, z, ox, oy, oz, obj.phaseMask, checks, ignoreFlags);
}

/** @ac game/Entities/Object/Object.cpp WorldObject::IsWithinLOSInMap */
export function isWithinLOSInMap(
  obj: LineOfSightObject,
  target: LineOfSightObject,
  ignoreFlags: number = ModelIgnoreFlags.Nothing,
  checks: number = LINEOFSIGHT_ALL_CHECKS,
  collisionHeight: number | null = null,
  combatReach: number | null = null,
): boolean {
  if (obj.map !== target.map || obj.instance !== target.instance) return false;

  const map = LineOfSightHooks.findMap(obj.map, obj.instance);
  if (!map) return true;

  let ox: number;
  let oy: number;
  let oz: number;
  if (target.isPlayer) {
    ox = target.x;
    oy = target.y;
    oz = target.z + target.collisionHeight;
  } else ({ x: ox, y: oy, z: oz } = GetHitSpherePointFor(target, { x: obj.x, y: obj.y, z: obj.z + (collisionHeight ?? obj.collisionHeight) }));

  let x: number;
  let y: number;
  let z: number;
  if (obj.isPlayer) {
    x = obj.x;
    y = obj.y;
    z = obj.z + obj.collisionHeight;
  } else ({ x, y, z } = GetHitSpherePointFor(obj, { x: target.x, y: target.y, z: target.z + target.collisionHeight }, collisionHeight, combatReach));

  return map.isInLineOfSight(x, y, z, ox, oy, oz, obj.phaseMask, checks, ignoreFlags);
}
