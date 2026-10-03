/**
 * @ac game/Maps/SpawnData.h
 *
 * The spawn records `ObjectMgr::LoadCreatures` / `LoadGameobjects` keep per `creature` / `gameobject` row, and the spawn
 * group templates. `CreatureData` (`Entities/Creature/CreatureData.h`) and `GameObjectData`
 * (`Entities/GameObject/GameObjectData.h`) derive from `SpawnData` and live here with it, together with the addon
 * records the creature and gameobject loaders read (`CreatureAddon`, `GameObjectAddon`).
 */
import type { VisibilityDistanceType } from "../Entities/Object/ObjectDefines.ts";

/** @ac game/Maps/SpawnData.h SpawnObjectType */
export const SPAWN_TYPE_CREATURE = 0;
export const SPAWN_TYPE_GAMEOBJECT = 1;
export const SPAWN_TYPE_MAX = 2;
export type SpawnObjectType = typeof SPAWN_TYPE_CREATURE | typeof SPAWN_TYPE_GAMEOBJECT;

/** @ac game/Maps/SpawnData.h SpawnObjectTypeMask */
export const SPAWN_TYPEMASK_CREATURE = 1 << SPAWN_TYPE_CREATURE;
export const SPAWN_TYPEMASK_GAMEOBJECT = 1 << SPAWN_TYPE_GAMEOBJECT;
export const SPAWN_TYPEMASK_ALL = SPAWN_TYPEMASK_CREATURE | SPAWN_TYPEMASK_GAMEOBJECT;

/** @ac game/Maps/SpawnData.h SpawnGroupFlags */
export const SPAWNGROUP_FLAG_NONE = 0x00;
export const SPAWNGROUP_FLAG_SYSTEM = 0x01;
export const SPAWNGROUP_FLAG_COMPATIBILITY_MODE = 0x02;
export const SPAWNGROUP_FLAG_MANUAL_SPAWN = 0x04;
export const SPAWNGROUP_FLAG_DYNAMIC_SPAWN_RATE = 0x08;
export const SPAWNGROUP_FLAG_ESCORTQUESTNPC = 0x10;
export const SPAWNGROUP_FLAG_ALL =
  SPAWNGROUP_FLAG_SYSTEM | SPAWNGROUP_FLAG_COMPATIBILITY_MODE | SPAWNGROUP_FLAG_MANUAL_SPAWN | SPAWNGROUP_FLAG_DYNAMIC_SPAWN_RATE | SPAWNGROUP_FLAG_ESCORTQUESTNPC;

/** @ac game/Maps/SpawnData.h SPAWNGROUP_MAP_UNSET */
export const SPAWNGROUP_MAP_UNSET = 0xffffffff;

/** @ac game/Maps/SpawnData.h SpawnGroupTemplateData */
export interface SpawnGroupTemplateData {
  groupId: number;
  name: string;
  mapId: number;
  flags: number;
}

/** @ac game/Entities/GameObject/GameObjectData.h GOState */
export const GO_STATE_ACTIVE = 0; // show in world as used and not reset (closed door open)
export const GO_STATE_READY = 1; // show in world as ready (closed door close)
export const GO_STATE_ACTIVE_ALTERNATIVE = 2; // show in world as used in alt way and not reset (closed door open by cannon fire)
/** @ac game/Entities/GameObject/GameObjectData.h MAX_GO_STATE */
export const MAX_GO_STATE = 3;

/** @ac game/Maps/SpawnData.h SpawnData */
export abstract class SpawnData {
  readonly type: SpawnObjectType;
  spawnId = 0;
  mapid = 0;
  phaseMask = 0;
  posX = 0.0;
  posY = 0.0;
  posZ = 0.0;
  orientation = 0.0;
  spawnMask = 0;
  ScriptId = 0;
  dbData = true;
  spawnGroupId = 0;
  poolId = 0;

  /** @ac game/Maps/SpawnData.h SpawnData::SpawnData */
  protected constructor(t: SpawnObjectType) {
    this.type = t;
  }
}

/** @ac game/Entities/Creature/CreatureData.h CreatureData */
export class CreatureData extends SpawnData {
  /** entry in creature_template */
  id = 0;
  /** entry in creature_template (from creature_multispawn) */
  id2 = 0;
  /** entry in creature_template (from creature_multispawn) */
  id3 = 0;
  displayid = 0;
  equipmentId = 0;
  spawntimesecs = 0;
  wander_distance = 0.0;
  currentwaypoint = 0;
  curhealth = 0;
  curmana = 0;
  movementType = 0;
  npcflag = 0;
  /** enum UnitFlags mask values */
  unit_flags = 0;
  dynamicflags = 0;

  /** @ac game/Entities/Creature/CreatureData.h CreatureData::CreatureData */
  constructor() {
    super(SPAWN_TYPE_CREATURE);
  }
}

/** @ac game/Entities/GameObject/GameObjectData.h GameObjectData (`G3D::Quat rotation` is `{ x, y, z, w }`) */
export class GameObjectData extends SpawnData {
  /** entry in gameobject_template */
  id = 0;
  rotation = { x: 0.0, y: 0.0, z: 0.0, w: 1.0 };
  spawntimesecs = 0;
  animprogress = 0;
  go_state = GO_STATE_ACTIVE;
  artKit = 0;

  /** @ac game/Entities/GameObject/GameObjectData.h GameObjectData::GameObjectData */
  constructor() {
    super(SPAWN_TYPE_GAMEOBJECT);
  }
}

/** @ac game/Entities/Creature/CreatureData.h CreatureAddon */
export interface CreatureAddon {
  path_id: number;
  mount: number;
  bytes1: number;
  bytes2: number;
  emote: number;
  auras: number[];
  visibilityDistanceType: VisibilityDistanceType;
}

/** @ac game/Entities/GameObject/GameObjectData.h QuaternionData */
export interface QuaternionData {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** @ac game/Entities/GameObject/GameObject.cpp QuaternionData::IsUnit */
export function QuaternionDataIsUnit(q: QuaternionData): boolean {
  const norm = Math.fround(Math.fround(q.x * q.x) + Math.fround(q.y * q.y) + Math.fround(q.z * q.z) + Math.fround(q.w * q.w));
  return Math.abs(norm - 1.0) < 1e-5;
}

/**
 * @ac game/Entities/GameObject/GameObject.cpp QuaternionData::FromEulerAnglesZYX
 * `G3D::Quat(G3D::Matrix3::fromEulerAnglesZYX(Z, Y, X))`: the rotation `Rz(Z) * Ry(Y) * Rx(X)` as a unit quaternion.
 */
export function QuaternionDataFromEulerAnglesZYX(Z: number, Y: number, X: number): QuaternionData {
  const cz = Math.cos(Z / 2), sz = Math.sin(Z / 2);
  const cy = Math.cos(Y / 2), sy = Math.sin(Y / 2);
  const cx = Math.cos(X / 2), sx = Math.sin(X / 2);
  return {
    x: Math.fround(cz * cy * sx - sz * sy * cx),
    y: Math.fround(cz * sy * cx + sz * cy * sx),
    z: Math.fround(sz * cy * cx - cz * sy * sx),
    w: Math.fround(cz * cy * cx + sz * sy * sx),
  };
}

/** @ac game/Entities/GameObject/GameObjectData.h GameObjectTemplateAddon (a `gameobject_template_addon` row) */
export interface GameObjectTemplateAddon {
  entry: number;
  faction: number;
  flags: number;
  mingold: number;
  maxgold: number;
  artKits: [number, number, number, number];
}

/** @ac game/Entities/GameObject/GameObjectData.h GameObjectAddon */
export interface GameObjectAddon {
  ParentRotation: QuaternionData;
  invisibilityType: number;
  InvisibilityValue: number;
}
