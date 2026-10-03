/**
 * @ac game/Entities/Unit/Unit.cpp Unit::GetCollisionHeight
 *
 * The collision height of a unit: from the model of its native display (`CreatureDisplayInfo.dbc` and
 * `CreatureModelData.dbc`), scaled by the object scale; mounted, the height of the mount plus half the rider's. The default
 * collision height when the models have none.
 */
import { sCreatureDisplayInfoStore, sCreatureModelDataStore } from "../../DataStores/DBCStores.ts";
import { DEFAULT_COLLISION_HEIGHT } from "../Object/ObjectDefines.ts";

/** What `Unit::GetCollisionHeight` reads of the unit. */
export interface UnitCollisionState {
  /** `GetObjectScale()` */
  scale: number;
  /** `GetNativeDisplayId()` */
  nativeDisplayId: number;
  /** `GetUInt32Value(UNIT_FIELD_MOUNTDISPLAYID)`, 0 when not mounted */
  mountDisplayId: number;
}

/** @ac game/Entities/Unit/Unit.cpp Unit::GetCollisionHeight */
export function GetCollisionHeight(unit: UnitCollisionState): number {
  const scaleMod = unit.scale; // 99% sure about this
  const defaultHeight = DEFAULT_COLLISION_HEIGHT * scaleMod;

  const displayInfo = sCreatureDisplayInfoStore.lookupEntry(unit.nativeDisplayId);
  const modelData = displayInfo ? sCreatureModelDataStore.lookupEntry(displayInfo.ModelId) : null;
  // `AssertEntry` aborts in C++; a missing model (no `data/dbc`) takes the default height
  if (!displayInfo || !modelData) return defaultHeight;

  let collisionHeight = 0.0;
  if (unit.mountDisplayId) {
    const mountDisplayInfo = sCreatureDisplayInfoStore.lookupEntry(unit.mountDisplayId);
    const mountModelData = mountDisplayInfo ? sCreatureModelDataStore.lookupEntry(mountDisplayInfo.ModelId) : null;
    if (mountModelData) collisionHeight = scaleMod * (mountModelData.MountHeight + modelData.CollisionHeight * modelData.Scale * displayInfo.scale * 0.5);
  } else collisionHeight = scaleMod * modelData.CollisionHeight * modelData.Scale * displayInfo.scale;

  return collisionHeight === 0.0 ? defaultHeight : collisionHeight;
}
