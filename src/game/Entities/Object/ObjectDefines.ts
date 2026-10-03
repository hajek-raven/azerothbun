/** @ac game/Entities/Object/ObjectDefines.h */

export const CONTACT_DISTANCE = 0.5;
export const INTERACTION_DISTANCE = 5.5;
export const ATTACK_DISTANCE = 5.0;
export const VISIBILITY_COMPENSATION = 15.0; // increase searchers
export const INSPECT_DISTANCE = 28.0;
export const SPELL_SEARCHER_COMPENSATION = 30.0; // increase searchers size in case we have large npc near cell border
export const TRADE_DISTANCE = 11.11;
export const MAX_VISIBILITY_DISTANCE = 250.0; // max distance for visible objects, experimental
export const SIGHT_RANGE_UNIT = 50.0;
export const MAX_SEARCHER_DISTANCE = 150.0; // pussywizard: replace the use of MAX_VISIBILITY_DISTANCE in searchers, because MAX_VISIBILITY_DISTANCE is quite too big for this purpose
export const VISIBILITY_DISTANCE_INFINITE = 533.0;
export const VISIBILITY_DISTANCE_GIGANTIC = 400.0;
export const VISIBILITY_DISTANCE_LARGE = 200.0;
export const VISIBILITY_DISTANCE_NORMAL = 100.0;
export const VISIBILITY_DISTANCE_SMALL = 50.0;
export const VISIBILITY_DISTANCE_TINY = 25.0;
export const DEFAULT_VISIBILITY_DISTANCE = 100.0; // default visible distance, 100 yards on continents
export const DEFAULT_VISIBILITY_INSTANCE = 170.0; // default visible distance in instances, 170 yards
export const VISIBILITY_DIST_WINTERGRASP = 175.0;
export const DEFAULT_VISIBILITY_BGARENAS = 250.0; // default visible distance in BG/Arenas, roughly 250 yards

export const DEFAULT_WORLD_OBJECT_SIZE = 0.388999998569489; // player size, also currently used (correctly?) for any non Unit world objects
export const DEFAULT_COMBAT_REACH = 1.5;
export const MIN_MELEE_REACH = 2.0;
export const NOMINAL_MELEE_RANGE = 5.0;
export const MELEE_RANGE = NOMINAL_MELEE_RANGE - MIN_MELEE_REACH * 2; // center to center for players
export const DEFAULT_COLLISION_HEIGHT = 2.03128; // Most common value in dbc
export const LEEWAY_MIN_MOVE_SPEED = 4.97; // NYI
export const LEEWAY_BONUS_RANGE = 2.66;

/** @ac game/Entities/Object/ObjectDefines.h VisibilityDistanceType */
export const VisibilityDistanceType = {
  Normal: 0,
  Tiny: 1,
  Small: 2,
  Large: 3,
  Gigantic: 4,
  Infinite: 5,

  Max: 6,
} as const;
export type VisibilityDistanceType = (typeof VisibilityDistanceType)[keyof typeof VisibilityDistanceType];

/** @ac game/Entities/Object/ObjectDefines.h PAIR64_HIPART */
export function PAIR64_HIPART(x: bigint): number {
  return Number((x >> 32n) & 0xffffffffn);
}

/** @ac game/Entities/Object/ObjectDefines.h PAIR64_LOPART */
export function PAIR64_LOPART(x: bigint): number {
  return Number(x & 0xffffffffn);
}

/** @ac game/Entities/Object/ObjectDefines.h MAKE_PAIR16 */
export function MAKE_PAIR16(l: number, h: number): number {
  return ((l & 0xff) | ((h & 0xff) << 8)) & 0xffff;
}

/** @ac game/Entities/Object/ObjectDefines.h MAKE_PAIR32 */
export function MAKE_PAIR32(l: number, h: number): number {
  return ((l & 0xffff) | ((h & 0xffff) << 16)) >>> 0;
}

/** @ac game/Entities/Object/ObjectDefines.h PAIR32_HIPART */
export function PAIR32_HIPART(x: number): number {
  return (x >>> 16) & 0x0000ffff;
}

/** @ac game/Entities/Object/ObjectDefines.h PAIR32_LOPART */
export function PAIR32_LOPART(x: number): number {
  return x & 0x0000ffff;
}
