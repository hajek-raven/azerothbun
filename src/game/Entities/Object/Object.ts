/**
 * @ac game/Entities/Object/Object.h
 * @ac game/Entities/Object/Object.cpp
 *
 * `Object` (the update field values a map object is identified by) and the parts of `WorldObject` the map layer uses:
 * map, phase, zone and area, distance and range, visibility and detection, grid membership, and notify flags.
 *
 * Out of scope here (other topics): the update field change masks and block building (`BuildValuesUpdate`,
 * `BuildMovementUpdate`, `ClearUpdateMask`, ...: Updates topic), summons (`SummonCreature`, `SummonGameObject`, ...:
 * TempSummon), spell casting and spell math (`CastSpell`, `SpellHitResult`, ...: Spells), and faction reactions
 * (`GetReactionTo`, `IsHostileTo`, ...: Combat). Those stay where their topic ports them.
 *
 * `WorldObject` reads its own position, map id, instance id, phase mask, zone, guid, and in-world state only through
 * the virtual getters, so the player facade can keep them on the character row and override just the getters.
 */
import {
  OBJECT_FIELD_ENTRY,
  OBJECT_FIELD_GUID,
  OBJECT_FIELD_SCALE_X,
  OBJECT_FIELD_TYPE,
  UNIT_FIELD_COMBATREACH,
} from "../../../gen/UpdateFields.gen.ts";
import { EventProcessor } from "../../../common/event-processor.ts";
import { randNorm } from "../../../common/random.ts";
import { log, logError } from "../../../log.ts";
import { ByteWriter } from "../../../net/byte-buffer.ts";
import { SERVERSIDE_VISIBILITY_GHOST, SERVERSIDE_VISIBILITY_GM, TOTAL_SERVERSIDE_VISIBILITY_TYPES } from "../../../shared/SharedDefines.ts";
import { MOVE_RUN, MOVE_WALK, UNIT_STATE_JUMPING } from "../../../spells/enums.ts";
import { sAreaTableStore } from "../../DataStores/DBCStores.ts";
import { Cell } from "../../Grids/Cells/Cell.ts";
import { IsValidMapCoord, NormalizeMapCoord } from "../../Grids/GridDefines.ts";
import type { GridPlayer, UnitLike } from "../../Grids/GridPlayer.ts";
import type { GridRefMgr } from "../../Grids/GridRefMgr.ts";
import { GridReference } from "../../Grids/GridReference.ts";
import {
  emptyLiquidData,
  INVALID_HEIGHT,
  LINEOFSIGHT_ALL_CHECKS,
  MAX_HEIGHT,
  ModelIgnoreFlags,
  Z_OFFSET_FIND_HEIGHT,
  type FloatRef,
  type LiquidDataLike,
  type MapLike,
  type PositionFullTerrainStatusLike,
} from "../../Grids/MapLike.ts";
import {
  AllCreaturesMatchingOneEntryInRange,
  AllCreaturesOfEntryInRange,
  AllDeadCreaturesInRange,
  AllGameObjectsMatchingOneEntryInRange,
  AllGameObjectsWithEntryInRange,
  AnyPlayerInObjectRangeCheck,
  CreatureLastSearcher,
  CreatureListSearcher,
  GameObjectLastSearcher,
  GameObjectListSearcher,
  MessageDistDeliverer,
  NearestCreatureEntryWithLiveStateInObjectRangeCheck,
  NearestGameObjectEntryInObjectRangeCheck,
  NearestGameObjectTypeInObjectRangeCheck,
  NearestPlayerInObjectRangeCheck,
  PlayerLastSearcher,
  PlayerListSearcher,
  TeamFilter,
  VisibleChangesNotifier,
} from "../../Grids/Notifiers/GridNotifiers.ts";
import { MAP_NORTHREND } from "../../Maps/AreaDefines.ts";
import type { ZoneScript } from "../../Maps/ZoneScript.ts";
import { getGameTimeMS } from "../../time/game-time.ts";
import { getMSTimeDiff } from "../../time/timer.ts";
import type { Corpse } from "../Corpse/Corpse.ts";
import type { Creature } from "../Creature/Creature.ts";
import type { DynamicObject } from "../DynamicObject/DynamicObject.ts";
import type { GameObject } from "../GameObject/GameObject.ts";
import {
  CONTACT_DISTANCE,
  DEFAULT_VISIBILITY_DISTANCE,
  DEFAULT_VISIBILITY_INSTANCE,
  DEFAULT_WORLD_OBJECT_SIZE,
  LEEWAY_BONUS_RANGE,
  LEEWAY_MIN_MOVE_SPEED,
  SIGHT_RANGE_UNIT,
  VISIBILITY_DIST_WINTERGRASP,
  VISIBILITY_DISTANCE_GIGANTIC,
  VISIBILITY_DISTANCE_INFINITE,
  VISIBILITY_DISTANCE_LARGE,
  VISIBILITY_DISTANCE_SMALL,
  VISIBILITY_DISTANCE_TINY,
  VisibilityDistanceType,
} from "./ObjectDefines.ts";
import {
  HighGuid,
  ObjectGuid,
  TYPEID_CORPSE,
  TYPEID_DYNAMICOBJECT,
  TYPEID_GAMEOBJECT,
  TYPEID_ITEM,
  TYPEID_OBJECT,
  TYPEID_PLAYER,
  TYPEID_UNIT,
  TYPEMASK_GAMEOBJECT,
  TYPEMASK_OBJECT,
  TYPEMASK_PLAYER,
  TYPEMASK_UNIT,
  type TypeID,
} from "./ObjectGuid.ts";
import { MOVEMENTFLAG_FALLING, MOVEMENTFLAG_FORWARD, MOVEMENTFLAG_STRAFE_LEFT, MOVEMENTFLAG_STRAFE_RIGHT, MOVEMENTFLAG_WALKING, type UnitMoveType } from "../Unit/UnitDefines.ts";
import { SelectSpeedType } from "../../Movement/Spline/MoveSplineInit.ts";
import { ObjectVisibilityContainer } from "./ObjectVisibilityContainer.ts";
import { Position, PositionMixin, WorldLocationMixin, fuzzyEq, type PositionLike } from "./Position.ts";
import type { UpdateData, WorldPacket } from "./Updates/UpdateData.ts";

const M_PI = Math.PI;

/** @ac game/Entities/Object/Object.h TempSummonType */
export const TEMPSUMMON_TIMED_OR_DEAD_DESPAWN = 1; // despawns after a specified time OR when the creature disappears
export const TEMPSUMMON_TIMED_OR_CORPSE_DESPAWN = 2; // despawns after a specified time OR when the creature dies
export const TEMPSUMMON_TIMED_DESPAWN = 3; // despawns after a specified time
export const TEMPSUMMON_TIMED_DESPAWN_OUT_OF_COMBAT = 4; // despawns after a specified time after the creature is out of combat
export const TEMPSUMMON_CORPSE_DESPAWN = 5; // despawns instantly after death
export const TEMPSUMMON_CORPSE_TIMED_DESPAWN = 6; // despawns after a specified time after death
export const TEMPSUMMON_DEAD_DESPAWN = 7; // despawns when the creature disappears
export const TEMPSUMMON_MANUAL_DESPAWN = 8; // despawns when UnSummon() is called
export const TEMPSUMMON_DESPAWNED = 9; // xinef: DONT USE, INTERNAL USE ONLY
export const TEMPSUMMON_TIMED_DESPAWN_OOC_ALIVE = 10; // despawns after a specified time after the creature is out of combat and alive

/** @ac game/Entities/Object/Object.h PhaseMasks */
export const PHASEMASK_NORMAL = 0x00000001;
export const PHASEMASK_ANYWHERE = 0xffffffff;

/** @ac game/Entities/Object/Object.h NotifyFlags */
export const NOTIFY_NONE = 0x00;
export const NOTIFY_AI_RELOCATION = 0x01;
export const NOTIFY_VISIBILITY_CHANGED = 0x02;
export const NOTIFY_ALL = 0xff;

/** @ac game/Entities/Object/Object.h GOSummonType */
export const GO_SUMMON_TIMED_OR_CORPSE_DESPAWN = 0; // despawns after a specified time OR when the summoner dies
export const GO_SUMMON_TIMED_DESPAWN = 1; // despawns after a specified time

/** @ac game/Entities/Object/Object.h HEARTBEAT_INTERVAL (5s + 200ms) */
export const HEARTBEAT_INTERVAL = 5200;

/** @ac shared/SharedDefines.h StealthType */
export const STEALTH_GENERAL = 0;
export const STEALTH_TRAP = 1;
export const TOTAL_STEALTH_TYPES = 2;

/** @ac shared/SharedDefines.h InvisibilityType */
export const INVISIBILITY_GENERAL = 0;
export const INVISIBILITY_UNK1 = 1;
export const INVISIBILITY_UNK2 = 2;
export const INVISIBILITY_TRAP = 3;
export const INVISIBILITY_UNK4 = 4;
export const INVISIBILITY_UNK5 = 5;
export const INVISIBILITY_DRUNK = 6;
export const INVISIBILITY_UNK7 = 7;
export const INVISIBILITY_UNK8 = 8;
export const INVISIBILITY_UNK9 = 9;
export const INVISIBILITY_UNK10 = 10;
export const INVISIBILITY_UNK11 = 11;
export const TOTAL_INVISIBILITY_TYPES = 12;

/** @ac shared/SharedDefines.h GhostVisibilityType */
export const GHOST_VISIBILITY_ALIVE = 0x1;
export const GHOST_VISIBILITY_GHOST = 0x2;

/** @ac game/Entities/Unit/Unit.h WORLD_TRIGGER */
export const WORLD_TRIGGER = 12999;
/** @ac game/Entities/Unit/Unit.h MAX_PLAYER_STEALTH_DETECT_RANGE (max distance for detection targets by player) */
export const MAX_PLAYER_STEALTH_DETECT_RANGE = 30.0;

/** @ac game/Entities/Unit/UnitDefines.h MovementFlags (the ones `WorldObject` reads; the one set is `Unit/UnitDefines.ts`) */
export { MOVEMENTFLAG_FALLING, MOVEMENTFLAG_FORWARD, MOVEMENTFLAG_STRAFE_LEFT, MOVEMENTFLAG_STRAFE_RIGHT, MOVEMENTFLAG_WALKING };

/** @ac game/Server/Protocol/Opcodes.h (the packets `Object` / `WorldObject` send) */
const SMSG_DESTROY_OBJECT = 0x0aa;
const SMSG_GAMEOBJECT_DESPAWN_ANIM = 0x215;
const SMSG_PLAY_MUSIC = 0x277;
const SMSG_PLAY_OBJECT_SOUND = 0x278;
const SMSG_PLAY_SOUND = 0x2d2;

/** @ac game/Entities/Object/Object.cpp VisibilityDistances */
const VisibilityDistances: readonly number[] = [
  DEFAULT_VISIBILITY_DISTANCE,
  VISIBILITY_DISTANCE_TINY,
  VISIBILITY_DISTANCE_SMALL,
  VISIBILITY_DISTANCE_LARGE,
  VISIBILITY_DISTANCE_GIGANTIC,
  VISIBILITY_DISTANCE_INFINITE,
];

/**
 * @ac game/Misc/DynamicVisibility.h DynamicVisibilityMgr
 * The two delays `WorldObject::AddToNotify` reads. `game/Misc/DynamicVisibility` is not ported; this is its first row
 * (`visibilitySettingsIndex` 0, under 500 sessions). The integration replaces it with the real manager.
 */
export interface DynamicVisibilityDelays {
  GetVisibilityNotifyDelay(map_type: number): number;
  GetAINotifyDelay(map_type: number): number;
}
export const DynamicVisibilityMgrDefault: DynamicVisibilityDelays = {
  GetVisibilityNotifyDelay: () => 300,
  GetAINotifyDelay: () => 150,
};

/** @ac game/Entities/Object/Object.h FlaggedValuesArray32 */
export class FlaggedValuesArray32 {
  private readonly m_values: Int32Array;
  private m_flags = 0;

  constructor(arraySize: number) {
    this.m_values = new Int32Array(arraySize);
  }

  /** @ac game/Entities/Object/Object.h FlaggedValuesArray32::GetFlags */
  getFlags(): number {
    return this.m_flags;
  }
  /** @ac game/Entities/Object/Object.h FlaggedValuesArray32::HasFlag */
  hasFlag(flag: number): boolean {
    return (this.m_flags & (1 << flag)) !== 0;
  }
  /** @ac game/Entities/Object/Object.h FlaggedValuesArray32::AddFlag */
  addFlag(flag: number): void {
    this.m_flags = (this.m_flags | (1 << flag)) >>> 0;
  }
  /** @ac game/Entities/Object/Object.h FlaggedValuesArray32::DelFlag */
  delFlag(flag: number): void {
    this.m_flags = (this.m_flags & ~(1 << flag)) >>> 0;
  }
  /** @ac game/Entities/Object/Object.h FlaggedValuesArray32::GetValue */
  getValue(flag: number): number {
    return this.m_values[flag] ?? 0;
  }
  /** @ac game/Entities/Object/Object.h FlaggedValuesArray32::SetValue */
  setValue(flag: number, value: number): void {
    this.m_values[flag] = value;
  }
  /** @ac game/Entities/Object/Object.h FlaggedValuesArray32::AddValue */
  addValue(flag: number, value: number): void {
    this.m_values[flag] = (this.m_values[flag] ?? 0) + value;
  }
}

/**
 * @ac game/Entities/Object/Object.h Object
 * The update field values (`m_uint32Values`, with the int32 and float views of the C++ union) and the in-world flag.
 */
export abstract class Object {
  protected m_objectType = TYPEMASK_OBJECT;
  protected m_objectTypeId: TypeID = TYPEID_OBJECT;
  protected m_updateFlag = 0;

  protected m_uint32Values: Uint32Array | null = null;
  protected m_int32Values: Int32Array | null = null;
  protected m_floatValues: Float32Array | null = null;
  protected m_valuesCount = 0;
  protected _fieldNotifyFlags = 0;
  protected m_objectUpdated = false;

  private m_inWorld = false;

  /**
   * The create block for one viewer (`BuildCreateUpdateBlockForPlayer`). Building update blocks belongs to the Updates
   * topic; until it is ported the integration registers the existing builders here (`spawn.ts`
   * `creatureCreateBlock` / `gameObjectCreateBlock`, `update-object.ts` `playerUpdateBlock`).
   */
  static createUpdateBlockBuilder: ((obj: Object, target: GridPlayer) => Uint8Array | null) | null = null;

  /** @ac game/Entities/Object/Object.h Object::IsInWorld */
  isInWorld(): boolean {
    return this.m_inWorld;
  }

  /** @ac game/Entities/Object/Object.cpp Object::AddToWorld */
  addToWorld(): void {
    if (this.m_inWorld) return;

    if (!this.m_uint32Values) throw new Error("Object::AddToWorld: values not initialized");

    this.m_inWorld = true;

    // synchronize values mirror with values array (changes will send in updatecreate opcode any way
    // @ac-skip ClearUpdateMask(false): update masks belong to the Updates topic
  }

  /** @ac game/Entities/Object/Object.cpp Object::RemoveFromWorld */
  removeFromWorld(): void {
    if (!this.m_inWorld) return;

    this.m_inWorld = false;

    // if we remove from world then sending changes not required
    // @ac-skip ClearUpdateMask(true): update masks belong to the Updates topic
  }

  /** @ac game/Entities/Object/Object.h Object::GetGUID */
  getGUID(): bigint {
    return this.getGuidValue(OBJECT_FIELD_GUID);
  }

  /** @ac game/Entities/Object/Object.h Object::GetPackGUID */
  getPackGUID(): Uint8Array {
    return ObjectGuid.WriteAsPacked(this.getGUID());
  }

  /** @ac game/Entities/Object/Object.h Object::GetEntry */
  getEntry(): number {
    return this.getUInt32Value(OBJECT_FIELD_ENTRY);
  }

  /** @ac game/Entities/Object/Object.h Object::SetEntry */
  setEntry(entry: number): void {
    this.setUInt32Value(OBJECT_FIELD_ENTRY, entry);
  }

  /** @ac game/Entities/Object/Object.h Object::GetObjectScale */
  getObjectScale(): number {
    return this.getFloatValue(OBJECT_FIELD_SCALE_X);
  }

  /** @ac game/Entities/Object/Object.h Object::SetObjectScale */
  setObjectScale(scale: number): void {
    this.setFloatValue(OBJECT_FIELD_SCALE_X, scale);
  }

  /** @ac game/Entities/Object/Object.h Object::GetDynamicFlags */
  getDynamicFlags(): number {
    return 0;
  }

  /** @ac game/Entities/Object/Object.h Object::HasDynamicFlag */
  hasDynamicFlag(flag: number): boolean {
    return (this.getDynamicFlags() & flag) !== 0;
  }

  /** @ac game/Entities/Object/Object.h Object::SetDynamicFlag */
  setDynamicFlag(flag: number): void {
    this.replaceAllDynamicFlags(this.getDynamicFlags() | flag);
  }

  /** @ac game/Entities/Object/Object.h Object::RemoveDynamicFlag */
  removeDynamicFlag(flag: number): void {
    this.replaceAllDynamicFlags(this.getDynamicFlags() & ~flag);
  }

  /** @ac game/Entities/Object/Object.h Object::ReplaceAllDynamicFlags */
  replaceAllDynamicFlags(_flag: number): void {}

  /** @ac game/Entities/Object/Object.h Object::GetTypeId */
  getTypeId(): TypeID {
    return this.m_objectTypeId;
  }

  /** @ac game/Entities/Object/Object.h Object::isType */
  isType(mask: number): boolean {
    return (mask & this.m_objectType) !== 0;
  }

  /** @ac game/Entities/Object/Object.cpp Object::BuildCreateUpdateBlockForPlayer (through `createUpdateBlockBuilder`) */
  buildCreateUpdateBlockForPlayer(data: UpdateData, target: GridPlayer): void {
    const block = Object.createUpdateBlockBuilder?.(this, target) ?? null;
    if (block) data.addUpdateBlock(block);
  }

  /** @ac game/Entities/Object/Object.cpp Object::BuildOutOfRangeUpdateBlock */
  buildOutOfRangeUpdateBlock(data: UpdateData): void {
    data.addOutOfRangeGUID(this.getGUID());
  }

  /**
   * @ac game/Entities/Object/Object.cpp Object::DestroyForPlayer
   * @ac-skip `SMSG_ARENA_UNIT_DESTROYED` for units in an arena: battlegrounds are not ported.
   */
  destroyForPlayer(target: GridPlayer, onDeath = false): void {
    const data = new ByteWriter().writeU64(this.getGUID());
    //! If the following bool is true, the client will call "void CGUnit_C::OnDeath()" for this object.
    //! OnDeath() does for eg trigger death animation and interrupts certain spells/missiles/auras/sounds...
    data.writeU8(onDeath ? 1 : 0);
    target.sendDirectMessage({ opcode: SMSG_DESTROY_OBJECT, payload: data.toUint8Array() });
  }

  /** @ac game/Entities/Object/Object.cpp Object::GetInt32Value */
  getInt32Value(index: number): number {
    this.checkIndex(index);
    return this.m_int32Values![index]!;
  }

  /** @ac game/Entities/Object/Object.cpp Object::GetUInt32Value */
  getUInt32Value(index: number): number {
    this.checkIndex(index);
    return this.m_uint32Values![index]!;
  }

  /** @ac game/Entities/Object/Object.cpp Object::GetUInt64Value */
  getUInt64Value(index: number): bigint {
    this.checkIndex(index + 1);
    return BigInt(this.m_uint32Values![index]!) | (BigInt(this.m_uint32Values![index + 1]!) << 32n);
  }

  /** @ac game/Entities/Object/Object.cpp Object::GetFloatValue */
  getFloatValue(index: number): number {
    this.checkIndex(index);
    return this.m_floatValues![index]!;
  }

  /** @ac game/Entities/Object/Object.cpp Object::GetByteValue */
  getByteValue(index: number, offset: number): number {
    this.checkIndex(index);
    return (this.m_uint32Values![index]! >>> (offset * 8)) & 0xff;
  }

  /** @ac game/Entities/Object/Object.cpp Object::GetUInt16Value */
  getUInt16Value(index: number, offset: number): number {
    this.checkIndex(index);
    return (this.m_uint32Values![index]! >>> (offset * 16)) & 0xffff;
  }

  /** @ac game/Entities/Object/Object.cpp Object::GetGuidValue */
  getGuidValue(index: number): bigint {
    return this.getUInt64Value(index);
  }

  /** @ac game/Entities/Object/Object.cpp Object::SetInt32Value */
  setInt32Value(index: number, value: number): void {
    this.checkIndex(index);
    this.m_int32Values![index] = value;
  }

  /** @ac game/Entities/Object/Object.cpp Object::SetUInt32Value */
  setUInt32Value(index: number, value: number): void {
    this.checkIndex(index);
    this.m_uint32Values![index] = value >>> 0;
  }

  /** @ac game/Entities/Object/Object.cpp Object::SetUInt64Value */
  setUInt64Value(index: number, value: bigint): void {
    this.checkIndex(index + 1);
    this.m_uint32Values![index] = Number(value & 0xffffffffn);
    this.m_uint32Values![index + 1] = Number((value >> 32n) & 0xffffffffn);
  }

  /** @ac game/Entities/Object/Object.cpp Object::SetFloatValue */
  setFloatValue(index: number, value: number): void {
    this.checkIndex(index);
    this.m_floatValues![index] = value;
  }

  /** @ac game/Entities/Object/Object.cpp Object::SetByteValue */
  setByteValue(index: number, offset: number, value: number): void {
    this.checkIndex(index);
    if (offset > 3) {
      logError("server", `Object::SetByteValue: wrong offset ${offset}`);
      return;
    }
    const shift = offset * 8;
    const current = this.m_uint32Values![index]!;
    this.m_uint32Values![index] = ((current & ~(0xff << shift)) | ((value & 0xff) << shift)) >>> 0;
  }

  /** @ac game/Entities/Object/Object.cpp Object::SetUInt16Value */
  setUInt16Value(index: number, offset: number, value: number): void {
    this.checkIndex(index);
    if (offset > 1) {
      logError("server", `Object::SetUInt16Value: wrong offset ${offset}`);
      return;
    }
    const shift = offset * 16;
    const current = this.m_uint32Values![index]!;
    this.m_uint32Values![index] = ((current & ~(0xffff << shift)) | ((value & 0xffff) << shift)) >>> 0;
  }

  /** @ac game/Entities/Object/Object.cpp Object::SetGuidValue */
  setGuidValue(index: number, value: bigint): void {
    this.setUInt64Value(index, value);
  }

  /** @ac game/Entities/Object/Object.cpp Object::SetFlag */
  setFlag(index: number, newFlag: number): void {
    this.setUInt32Value(index, this.getUInt32Value(index) | newFlag);
  }

  /** @ac game/Entities/Object/Object.cpp Object::RemoveFlag */
  removeFlag(index: number, oldFlag: number): void {
    this.setUInt32Value(index, this.getUInt32Value(index) & ~oldFlag);
  }

  /** @ac game/Entities/Object/Object.cpp Object::ToggleFlag */
  toggleFlag(index: number, flag: number): void {
    if (this.hasFlag(index, flag)) this.removeFlag(index, flag);
    else this.setFlag(index, flag);
  }

  /** @ac game/Entities/Object/Object.cpp Object::HasFlag */
  hasFlag(index: number, flag: number): boolean {
    if (index >= this.m_valuesCount) return false;
    return (this.getUInt32Value(index) & flag) !== 0;
  }

  /** @ac game/Entities/Object/Object.cpp Object::ApplyModFlag */
  applyModFlag(index: number, flag: number, apply: boolean): void {
    if (apply) this.setFlag(index, flag);
    else this.removeFlag(index, flag);
  }

  /**
   * @ac game/Entities/Object/Object.cpp Object::AddGuidValue
   * Like the other setters here, the `_changesMask` bits and `AddToObjectUpdateIfNeeded` belong to the Updates topic.
   */
  addGuidValue(index: number, value: bigint): boolean {
    this.checkIndex(index + 1);

    if (value && !this.getGuidValue(index)) {
      this.setGuidValue(index, value);
      return true;
    }

    return false;
  }

  /** @ac game/Entities/Object/Object.cpp Object::RemoveGuidValue */
  removeGuidValue(index: number, value: bigint): boolean {
    this.checkIndex(index + 1);

    if (value && this.getGuidValue(index) === value) {
      this.m_uint32Values![index] = 0;
      this.m_uint32Values![index + 1] = 0;
      return true;
    }

    return false;
  }

  /** @ac game/Entities/Object/Object.cpp Object::SetStatFloatValue */
  setStatFloatValue(index: number, value: number): void {
    if (value < 0) value = 0.0;

    this.setFloatValue(index, value);
  }

  /** @ac game/Entities/Object/Object.cpp Object::ApplyModSignedFloatValue */
  applyModSignedFloatValue(index: number, val: number, apply: boolean): void {
    let cur = this.getFloatValue(index);
    cur += apply ? val : -val;
    this.setFloatValue(index, cur);
  }

  /** @ac game/Entities/Object/Object.cpp Object::ApplyModPositiveFloatValue */
  applyModPositiveFloatValue(index: number, val: number, apply: boolean): void {
    let cur = this.getFloatValue(index);
    cur += apply ? val : -val;
    if (cur < 0) cur = 0;
    this.setFloatValue(index, cur);
  }

  /** @ac game/Entities/Object/Object.cpp Object::SetByteFlag */
  setByteFlag(index: number, offset: number, newFlag: number): void {
    this.checkIndex(index);

    if (offset > 3) {
      logError("world", `Object::SetByteFlag: wrong offset ${offset}`);
      return;
    }

    if (!((this.m_uint32Values![index]! >>> (offset * 8)) & 0xff & newFlag)) {
      this.m_uint32Values![index] = (this.m_uint32Values![index]! | ((newFlag & 0xff) << (offset * 8))) >>> 0;
    }
  }

  /** @ac game/Entities/Object/Object.cpp Object::RemoveByteFlag */
  removeByteFlag(index: number, offset: number, oldFlag: number): void {
    this.checkIndex(index);

    if (offset > 3) {
      logError("world", `Object::RemoveByteFlag: wrong offset ${offset}`);
      return;
    }

    if ((this.m_uint32Values![index]! >>> (offset * 8)) & 0xff & oldFlag) {
      this.m_uint32Values![index] = (this.m_uint32Values![index]! & ~((oldFlag & 0xff) << (offset * 8))) >>> 0;
    }
  }

  /** @ac game/Entities/Object/Object.h Object::GetValuesCount */
  getValuesCount(): number {
    return this.m_valuesCount;
  }

  /** @ac game/Entities/Object/Object.h Object::hasQuest */
  hasQuest(_quest_id: number): boolean {
    return false;
  }

  /** @ac game/Entities/Object/Object.h Object::hasInvolvedQuest */
  hasInvolvedQuest(_quest_id: number): boolean {
    return false;
  }

  /** @ac game/Entities/Object/Object.h Object::SetFieldNotifyFlag */
  setFieldNotifyFlag(flag: number): void {
    this._fieldNotifyFlags |= flag;
  }

  /** @ac game/Entities/Object/Object.h Object::RemoveFieldNotifyFlag */
  removeFieldNotifyFlag(flag: number): void {
    this._fieldNotifyFlags &= ~flag;
  }

  /** @ac game/Entities/Object/Object.h Object::IsPlayer */
  isPlayer(): boolean {
    return this.getTypeId() === TYPEID_PLAYER;
  }

  /** @ac game/Entities/Object/Object.h Object::ToPlayer */
  toPlayer(): GridPlayer | null {
    return this.isPlayer() ? (this as unknown as GridPlayer) : null;
  }

  /** @ac game/Entities/Object/Object.h Object::IsCreature */
  isCreature(): boolean {
    return this.getTypeId() === TYPEID_UNIT;
  }

  /** @ac game/Entities/Object/Object.h Object::ToCreature */
  toCreature(): Creature | null {
    return this.isCreature() ? (this as unknown as Creature) : null;
  }

  /** @ac game/Entities/Object/Object.h Object::IsUnit */
  isUnit(): boolean {
    return this.isType(TYPEMASK_UNIT);
  }

  /** @ac game/Entities/Object/Object.h Object::ToUnit */
  toUnit(): UnitLike | null {
    return this.isCreature() || this.isPlayer() ? (this as unknown as UnitLike) : null;
  }

  /** @ac game/Entities/Object/Object.h Object::IsGameObject */
  isGameObject(): boolean {
    return this.getTypeId() === TYPEID_GAMEOBJECT;
  }

  /** @ac game/Entities/Object/Object.h Object::ToGameObject */
  toGameObject(): GameObject | null {
    return this.isGameObject() ? (this as unknown as GameObject) : null;
  }

  /** @ac game/Entities/Object/Object.h Object::IsCorpse */
  isCorpse(): boolean {
    return this.getTypeId() === TYPEID_CORPSE;
  }

  /** @ac game/Entities/Object/Object.h Object::ToCorpse */
  toCorpse(): Corpse | null {
    return this.isCorpse() ? (this as unknown as Corpse) : null;
  }

  /** @ac game/Entities/Object/Object.h Object::IsDynamicObject */
  isDynamicObject(): boolean {
    return this.getTypeId() === TYPEID_DYNAMICOBJECT;
  }

  /** @ac game/Entities/Object/Object.h Object::ToDynObject */
  toDynObject(): DynamicObject | null {
    return this.isDynamicObject() ? (this as unknown as DynamicObject) : null;
  }

  /** @ac game/Entities/Object/Object.h Object::IsItem */
  isItem(): boolean {
    return this.getTypeId() === TYPEID_ITEM;
  }

  /** @ac game/Entities/Object/Object.h Object::Heartbeat */
  heartbeat(): void {}

  /** @ac game/Entities/Object/Object.cpp Object::GetDebugInfo */
  getObjectDebugInfo(): string {
    return `${ObjectGuid.ToString(this.getGUID())} Entry ${this.getEntry()}`;
  }

  /** @ac game/Entities/Object/Object.h Object::EntryEquals */
  entryEquals(...entries: number[]): boolean {
    return entries.includes(this.getEntry());
  }

  /** @ac game/Entities/Object/Object.cpp Object::_InitValues */
  protected _InitValues(): void {
    const buffer = new ArrayBuffer(this.m_valuesCount * 4);
    this.m_uint32Values = new Uint32Array(buffer);
    this.m_int32Values = new Int32Array(buffer);
    this.m_floatValues = new Float32Array(buffer);

    this.m_objectUpdated = false;
  }

  /** @ac game/Entities/Object/Object.cpp Object::_Create (`(guidlow, entry, guidhigh)` or `(ObjectGuid)`) */
  protected _Create(guidlowOrGuid: number | bigint, entry = 0, guidhigh: HighGuid = HighGuid.Player): void {
    const guid = typeof guidlowOrGuid === "bigint" ? guidlowOrGuid : ObjectGuid.Make(guidhigh, entry, guidlowOrGuid);
    if (!this.m_uint32Values) this._InitValues();

    this.setGuidValue(OBJECT_FIELD_GUID, guid);
    this.setUInt32Value(OBJECT_FIELD_TYPE, this.m_objectType);
  }

  /** @ac game/Entities/Object/Object.cpp Object::PrintIndexError (as the `ASSERT` it feeds) */
  private checkIndex(index: number): void {
    if (!this.m_uint32Values || index >= this.m_valuesCount) {
      throw new Error(`Object::PrintIndexError: attempt get/set value field: ${index} in object ${this.m_objectTypeId} with values count ${this.m_valuesCount}`);
    }
  }
}

/** @ac game/Entities/Object/Object.h MovementInfo */
export class MovementInfo {
  // common
  guid = 0n;
  flags = 0;
  flags2 = 0;
  pos = new Position();
  time = 0;

  // transport
  transport = {
    guid: 0n,
    pos: new Position(),
    seat: -1,
    time: 0,
    time2: 0,
    /** @ac game/Entities/Object/Object.h MovementInfo::TransportInfo::Reset */
    Reset(): void {
      this.guid = 0n;
      this.pos.relocate(0.0, 0.0, 0.0, 0.0);
      this.seat = -1;
      this.time = 0;
      this.time2 = 0;
    },
  };

  // swimming/flying
  pitch = 0.0;

  // falling
  fallTime = 0;

  // jumping
  jump = {
    zspeed: 0,
    sinAngle: 0,
    cosAngle: 0,
    xyspeed: 0,
    /** @ac game/Entities/Object/Object.h MovementInfo::JumpInfo::Reset */
    Reset(): void {
      this.zspeed = this.sinAngle = this.cosAngle = this.xyspeed = 0.0;
    },
  };

  // spline
  splineElevation = 0.0;

  /** @ac game/Entities/Object/Object.h MovementInfo::GetMovementFlags */
  getMovementFlags(): number {
    return this.flags;
  }
  /** @ac game/Entities/Object/Object.h MovementInfo::SetMovementFlags */
  setMovementFlags(flag: number): void {
    this.flags = flag >>> 0;
  }
  /** @ac game/Entities/Object/Object.h MovementInfo::AddMovementFlag */
  addMovementFlag(flag: number): void {
    this.flags = (this.flags | flag) >>> 0;
  }
  /** @ac game/Entities/Object/Object.h MovementInfo::RemoveMovementFlag */
  removeMovementFlag(flag: number): void {
    this.flags = (this.flags & ~flag) >>> 0;
  }
  /** @ac game/Entities/Object/Object.h MovementInfo::HasMovementFlag */
  hasMovementFlag(flag: number): boolean {
    return (this.flags & flag) !== 0;
  }
  /** @ac game/Entities/Object/Object.h MovementInfo::GetExtraMovementFlags */
  getExtraMovementFlags(): number {
    return this.flags2;
  }
  /** @ac game/Entities/Object/Object.h MovementInfo::AddExtraMovementFlag */
  addExtraMovementFlag(flag: number): void {
    this.flags2 = (this.flags2 | flag) & 0xffff;
  }
  /** @ac game/Entities/Object/Object.h MovementInfo::HasExtraMovementFlag */
  hasExtraMovementFlag(flag: number): boolean {
    return (this.flags2 & flag) !== 0;
  }
  /** @ac game/Entities/Object/Object.h MovementInfo::SetFallTime */
  setFallTime(newFallTime: number): void {
    this.fallTime = newFallTime;
  }
  /** @ac game/Entities/Object/Object.h MovementInfo::GetSpeedType (the body is `Movement::SelectSpeedType` of `MoveSplineInit.ts`) */
  getSpeedType(): UnitMoveType {
    return SelectSpeedType(this.flags);
  }
  // @ac-skip MovementInfo::OutDebug: debug output only.
}

/** @ac game/Entities/Object/Object.h MapObjectCellMoveState */
export const MAP_OBJECT_CELL_MOVE_NONE = 0; // not in move list
export const MAP_OBJECT_CELL_MOVE_ACTIVE = 1; // in move list
export const MAP_OBJECT_CELL_MOVE_INACTIVE = 2; // in move list but should not move

/** @ac game/Entities/Object/Object.h UpdatableMapObject::UpdateState */
export const UpdateState = { NotUpdating: 0, PendingAdd: 1, Updating: 2 } as const;
export type UpdateState = (typeof UpdateState)[keyof typeof UpdateState];

/**
 * @ac game/Entities/Object/Object.h WorldObject
 * Also carries the C++ mixins every grid object has: `GridObject<T>` (the grid reference), `MovableMapObject` (the
 * current cell and move state), and `UpdatableMapObject` (the map update list slot). `Map` reads them through the
 * public accessors (the C++ makes `Map` a friend).
 */
export abstract class WorldObject extends WorldLocationMixin(PositionMixin(Object)) {
  /** @ac game/Entities/Object/Object.h WorldObject::LastUsedScriptID */
  LastUsedScriptID = 0;

  /** @ac game/Entities/Object/Object.h WorldObject::m_stealth */
  readonly m_stealth = new FlaggedValuesArray32(TOTAL_STEALTH_TYPES);
  /** @ac game/Entities/Object/Object.h WorldObject::m_stealthDetect */
  readonly m_stealthDetect = new FlaggedValuesArray32(TOTAL_STEALTH_TYPES);
  /** @ac game/Entities/Object/Object.h WorldObject::m_invisibility */
  readonly m_invisibility = new FlaggedValuesArray32(TOTAL_INVISIBILITY_TYPES);
  /** @ac game/Entities/Object/Object.h WorldObject::m_invisibilityDetect */
  readonly m_invisibilityDetect = new FlaggedValuesArray32(TOTAL_INVISIBILITY_TYPES);
  /** @ac game/Entities/Object/Object.h WorldObject::m_serverSideVisibility */
  readonly m_serverSideVisibility = new FlaggedValuesArray32(TOTAL_SERVERSIDE_VISIBILITY_TYPES);
  /** @ac game/Entities/Object/Object.h WorldObject::m_serverSideVisibilityDetect */
  readonly m_serverSideVisibilityDetect = new FlaggedValuesArray32(TOTAL_SERVERSIDE_VISIBILITY_TYPES);

  /** @ac game/Entities/Object/Object.h WorldObject::m_movementInfo */
  readonly m_movementInfo = new MovementInfo();

  /** @ac game/Entities/Object/Object.h WorldObject::m_Events */
  readonly m_Events = new EventProcessor();

  /** The `DynamicVisibilityMgr` `AddToNotify` reads (see `DynamicVisibilityMgrDefault`). */
  static DynamicVisibilityMgr: DynamicVisibilityDelays = DynamicVisibilityMgrDefault;

  protected m_name = "";
  protected m_isActive = false;
  protected _visibilityDistanceOverrideType: VisibilityDistanceType = VisibilityDistanceType.Normal;
  protected m_zoneScript: ZoneScript | null = null;

  protected _zoneId = 0;
  protected _areaId = 0;
  protected _floorZ = INVALID_HEIGHT;
  protected _outdoors = false;
  protected _liquidData: LiquidDataLike = emptyLiquidData();
  protected _updatePositionData = false;

  /** transports (not ported: always null) */
  protected m_transport: WorldObject | null = null;

  private m_currMap: MapLike | null = null;
  private _heartbeatTimer = HEARTBEAT_INTERVAL;
  private m_InstanceId = 0;
  private m_phaseMask = PHASEMASK_NORMAL;
  /**
   * true (default): use phaseMask as bit mask combining up to 32 phases
   * false: use phaseMask to represent single phases only (up to 4294967295 phases)
   */
  private m_useCombinedPhases = true;

  private m_notifyflags = 0;
  private m_executed_notifies = 0;

  private readonly _allowedLooters = new Set<bigint>();

  private readonly _objectVisibilityContainer: ObjectVisibilityContainer;

  // GridObject<T>
  private readonly _gridRef = new GridReference<WorldObject>();
  // MovableMapObject
  private _currentCell = new Cell();
  /** @ac game/Entities/Object/Object.h MovableMapObject::_moveState */
  _moveState = MAP_OBJECT_CELL_MOVE_NONE;
  // UpdatableMapObject
  private _mapUpdateListOffset = 0;
  private _mapUpdateState: UpdateState = UpdateState.NotUpdating;

  /** @ac game/Entities/Object/Object.cpp WorldObject::WorldObject */
  constructor() {
    super();
    this._objectVisibilityContainer = new ObjectVisibilityContainer(this);
    this.m_serverSideVisibility.setValue(SERVERSIDE_VISIBILITY_GHOST, GHOST_VISIBILITY_ALIVE | GHOST_VISIBILITY_GHOST);
    this.m_serverSideVisibilityDetect.setValue(SERVERSIDE_VISIBILITY_GHOST, GHOST_VISIBILITY_ALIVE);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::Update */
  update(diff: number): void {
    this.m_Events.update(diff);

    this._heartbeatTimer -= diff;
    while (this._heartbeatTimer <= 0) {
      this._heartbeatTimer += HEARTBEAT_INTERVAL;
      this.heartbeat();
    }
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::_Create (the `(guidlow, guidhigh, phaseMask)` overload) */
  protected _CreateWorldObject(guidlow: number, guidhigh: HighGuid, phaseMask: number): void {
    this._Create(guidlow, 0, guidhigh);
    this.setPhaseMask(phaseMask, false);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::AddToWorld */
  override addToWorld(): void {
    super.addToWorld();
    const { zoneid, areaid } = this.getMap().getZoneAndAreaId(this.getPhaseMask(), this.getPositionX(), this.getPositionY(), this.getPositionZ());
    this._zoneId = zoneid;
    this._areaId = areaid;
    this.getMap().addObjectToPendingUpdateList(this);

    if (this.isZoneWideVisible()) this.getMap().addWorldObjectToZoneWideVisibleMap(this._zoneId, this);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::RemoveFromWorld */
  override removeFromWorld(): void {
    if (!this.isInWorld()) return;

    this.removeFromMapVisibilityOverrideContainers();

    this.destroyForVisiblePlayers();

    this.getObjectVisibilityContainer().cleanVisibilityReferences();

    super.removeFromWorld();
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetNearPoint2D (the `(searcher, ...)` and `(x, y, ...)` overloads; the reference parameters are the result) */
  getNearPoint2D(searcher: WorldObject | null, distance2d: number, absAngle: number, startPos: PositionLike | null = null): { x: number; y: number } {
    let effectiveReach = this.getCombatReach();

    if (searcher) {
      effectiveReach += searcher.getCombatReach();

      if (this !== searcher) {
        let myHover = 0.0;
        let searcherHover = 0.0;
        const unit = this.toUnit();
        if (unit) myHover = unit.getHoverHeight();
        const searchUnit = searcher.toUnit();
        if (searchUnit) searcherHover = searchUnit.getHoverHeight();

        const hoverDelta = myHover - searcherHover;
        if (hoverDelta !== 0.0) effectiveReach = Math.sqrt(Math.max(effectiveReach * effectiveReach - hoverDelta * hoverDelta, 0.0));
      }
    }

    const positionX = startPos ? startPos.getPositionX() : this.getPositionX();
    const positionY = startPos ? startPos.getPositionY() : this.getPositionY();

    const x = positionX + (effectiveReach + distance2d) * Math.cos(absAngle);
    const y = positionY + (effectiveReach + distance2d) * Math.sin(absAngle);

    return { x: NormalizeMapCoord(x), y: NormalizeMapCoord(y) };
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetNearPoint (the reference parameters are the result) */
  getNearPoint(
    searcher: WorldObject | null,
    searcher_size: number,
    distance2d: number,
    absAngle: number,
    controlZ = 0,
    startPos: PositionLike | null = null,
  ): { x: number; y: number; z: number } {
    let { x, y } = this.getNearPoint2D(null, distance2d + searcher_size, absAngle, startPos);
    let z = this.getPositionZ();

    if (searcher) {
      const unit = searcher.toUnit();
      const target = this.toUnit();
      if (unit && target && unit.isInWater() && target.isInWater()) {
        // if the searcher is in water
        // we have no ground so we can
        // set the target height to the
        // z-coord to keep the searcher
        // at the correct height (face to face)
        z += this.getCollisionHeight() - unit.getCollisionHeight();
      }
      z = searcher.updateAllowedPositionZ(x, y, z);
    } else {
      z = this.updateAllowedPositionZ(x, y, z);
    }

    // if detection disabled, return first point
    if (!WorldObject.detectPosCollision) return { x, y, z };

    // return if the point is already in LoS
    if (!controlZ && this.isWithinLOS(x, y, z)) return { x, y, z };

    // remember first point
    const first_x = x;
    const first_y = y;
    const first_z = z;

    // loop in a circle to look for a point in LoS using small steps
    for (let angle = M_PI / 8; angle < M_PI * 2; angle += M_PI / 8) {
      ({ x, y } = this.getNearPoint2D(null, distance2d + searcher_size, absAngle + angle, startPos));
      z = this.getPositionZ();
      z = this.updateAllowedPositionZ(x, y, z);
      if (controlZ && Math.abs(this.getPositionZ() - z) > controlZ) continue;

      if (this.isWithinLOS(x, y, z)) return { x, y, z };
    }

    // still not in LoS, give up and return first position found
    if (startPos && searcher) {
      return { x: searcher.getPositionX(), y: searcher.getPositionY(), z: searcher.getPositionZ() };
    }
    return { x: first_x, y: first_y, z: first_z };
  }

  /** `CONFIG_DETECT_POS_COLLISION` (`DetectPosCollision`, default 1). The integration sets it from `sWorld`. */
  static detectPosCollision = true;

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetVoidClosePoint (angle calculated from current orientation) */
  getVoidClosePoint(size: number, distance2d = 0, relAngle = 0, controlZ = 0): { x: number; y: number; z: number } {
    return this.getNearPoint(null, size, distance2d, this.getOrientation() + relAngle, controlZ);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetClosePoint (the point and the C++ `bool` as `ok`) */
  getClosePoint(size: number, distance2d = 0, angle = 0, forWho: WorldObject | null = null, force = false): { x: number; y: number; z: number; ok: boolean } {
    // angle calculated from current orientation
    let { x, y, z } = this.getNearPoint(forWho, size, distance2d, this.getOrientation() + angle);

    if (Math.abs(this.getPositionZ() - z) > 3.0 || !this.isWithinLOS(x, y, z)) {
      x = this.getPositionX();
      y = this.getPositionY();
      z = this.getPositionZ();
      if (forWho) {
        const u = forWho.toUnit();
        if (u) z = u.updateAllowedPositionZ(x, y, z);
      }
    }
    const maxDist = this.getObjectSize() + size + distance2d + 1.0;
    if (this.getExactDistSq(x, y, z) >= maxDist * maxDist) {
      if (force) {
        return { x: this.getPositionX(), y: this.getPositionY(), z: this.getPositionZ(), ok: true };
      }
      return { x, y, z, ok: false };
    }
    return { x, y, z, ok: true };
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::MovePosition */
  movePosition(pos: Position, dist: number, angle: number): void {
    angle += this.getOrientation();
    let destx = pos.m_positionX + dist * Math.cos(angle);
    let desty = pos.m_positionY + dist * Math.sin(angle);

    // Prevent invalid coordinates here, position is unchanged
    if (!IsValidMapCoord(destx, desty)) {
      logError("server", `WorldObject::MovePosition invalid coordinates X: ${destx} and Y: ${desty} were passed!`);
      return;
    }

    let ground = this.getMapHeight(destx, desty, MAX_HEIGHT);
    let floor = this.getMapHeight(destx, desty, pos.m_positionZ);
    let destz = Math.abs(ground - pos.m_positionZ) <= Math.abs(floor - pos.m_positionZ) ? ground : floor;

    const step = dist / 10.0;

    for (let j = 0; j < 10; ++j) {
      // do not allow too big z changes
      if (Math.abs(pos.m_positionZ - destz) > 6.0) {
        destx -= step * Math.cos(angle);
        desty -= step * Math.sin(angle);
        ground = this.getMapHeight(destx, desty, MAX_HEIGHT);
        floor = this.getMapHeight(destx, desty, pos.m_positionZ);
        destz = Math.abs(ground - pos.m_positionZ) <= Math.abs(floor - pos.m_positionZ) ? ground : floor;
      }
      // we have correct destz now
      else {
        pos.relocate(destx, desty, destz);
        break;
      }
    }

    pos.m_positionX = NormalizeMapCoord(pos.m_positionX);
    pos.m_positionY = NormalizeMapCoord(pos.m_positionY);
    pos.m_positionZ = this.updateGroundPositionZ(pos.m_positionX, pos.m_positionY, pos.m_positionZ);
    pos.setOrientation(this.getOrientation());
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetNearPosition */
  getNearPosition(dist: number, angle: number): Position {
    const pos = this.getPosition();
    this.movePosition(pos, dist, angle);
    return pos;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::MovePositionToFirstCollision */
  movePositionToFirstCollision(pos: Position, dist: number, angle: number): void {
    angle += this.getOrientation();
    const dest = {
      x: pos.m_positionX + dist * Math.cos(angle),
      y: pos.m_positionY + dist * Math.sin(angle),
      z: pos.m_positionZ,
    };

    if (!this.getMap().checkCollisionAndGetValidCoords(this, pos.m_positionX, pos.m_positionY, pos.m_positionZ, dest, false)) return;

    pos.setOrientation(this.getOrientation());
    pos.relocate(dest.x, dest.y, dest.z);
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::GetFirstCollisionPosition
   * The `(startX, startY, startZ, destX, destY)`, `(destX, destY, destZ)`, and `(dist, angle)` overloads.
   */
  getFirstCollisionPosition(dist: number, angle: number): Position;
  getFirstCollisionPosition(destX: number, destY: number, destZ: number): Position;
  getFirstCollisionPosition(startX: number, startY: number, startZ: number, destX: number, destY: number): Position;
  getFirstCollisionPosition(a: number, b: number, c?: number, d?: number, e?: number): Position {
    if (c === undefined) {
      const pos = this.getPosition();
      this.movePositionToFirstCollision(pos, a, b);
      return pos;
    }
    if (d === undefined) {
      const pos = this.getPosition();
      const distance = this.getExactDistSq(a, b, c);

      const dx = a - pos.getPositionX();
      const dy = b - pos.getPositionY();

      let ang = Math.atan2(dy, dx);
      ang = ang >= 0 ? ang : 2 * M_PI + ang;

      this.movePositionToFirstCollision(pos, distance, ang);
      return pos;
    }
    const dx = d - a;
    const dy = (e ?? 0) - b;

    let ang = Math.atan2(dy, dx);
    ang = ang >= 0 ? ang : 2 * M_PI + ang;
    const pos = new Position(a, b, c, ang);

    const distance = pos.getExactDist2d(d, e ?? 0);

    this.movePositionToFirstCollision(pos, distance, ang);
    return pos;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetRandomNearPosition */
  getRandomNearPosition(radius: number): Position {
    const pos = this.getPosition();
    this.movePosition(pos, radius * randNorm(), randNorm() * 2 * M_PI);
    return pos;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetContactPoint (angle to face `obj` to `this` using distance includes size of `obj`) */
  getContactPoint(obj: WorldObject, distance2d = CONTACT_DISTANCE): { x: number; y: number; z: number } {
    let { x, y, z } = this.getNearPoint(obj, obj.getObjectSize(), distance2d, this.getAngle(obj));

    // Exclude gameobjects from LoS calculations
    if (Math.abs(this.getPositionZ() - z) > 3.0 || (!this.isGameObject() && !this.isWithinLOS(x, y, z))) {
      x = this.getPositionX();
      y = this.getPositionY();
      z = this.getPositionZ();
      z = obj.updateAllowedPositionZ(x, y, z);
    }
    return { x, y, z };
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetChargeContactPoint */
  getChargeContactPoint(obj: WorldObject, distance2d = CONTACT_DISTANCE): { x: number; y: number; z: number } {
    // angle to face `obj` to `this` using distance includes size of `obj`
    let { x, y, z } = this.getNearPoint(obj, obj.getObjectSize(), distance2d, this.getAngle(obj));

    if (Math.abs(this.getPositionZ() - z) > 3.0 || !this.isWithinLOS(x, y, z)) {
      x = this.getPositionX();
      y = this.getPositionY();
      z = this.getPositionZ();
      z = obj.updateGroundPositionZ(x, y, z);
    }
    return { x, y, z };
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetObjectSize */
  getObjectSize(): number {
    return this.m_valuesCount > UNIT_FIELD_COMBATREACH ? this.getFloatValue(UNIT_FIELD_COMBATREACH) : DEFAULT_WORLD_OBJECT_SIZE * this.getObjectScale();
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetCombatReach (overridden (only) in Unit) */
  getCombatReach(): number {
    return 0.0;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::UpdateGroundPositionZ (the `float& z` is the return value) */
  updateGroundPositionZ(x: number, y: number, z: number): number {
    const new_z = this.getMapHeight(x, y, z);
    if (new_z > INVALID_HEIGHT) {
      const unit = this.isUnit() ? this.toUnit() : null;
      return new_z + (unit ? unit.getHoverHeight() : 0.0);
    }
    return z;
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::UpdateAllowedPositionZ
   * The `float& z` is the return value; `groundZ` (the `float*`) is filled when given.
   */
  updateAllowedPositionZ(x: number, y: number, z: number, groundZ: FloatRef | null = null): number {
    if (this.getTransport()) {
      if (groundZ) groundZ.value = z;
      return z;
    }

    const unit = this.toUnit();
    if (unit) {
      if (!unit.canFly()) {
        const c = unit.toCreature();
        const canSwim = c ? c.canSwim() : true;
        const ground: FloatRef = { value: z };
        let max_z: number;
        if (canSwim) {
          max_z = this.getMapWaterOrGroundLevel(x, y, z, ground);
        } else {
          max_z = ground.value = this.getMapHeight(x, y, z);
        }
        let ground_z = ground.value;

        if (max_z > INVALID_HEIGHT) {
          if (canSwim && unit.getMap().isInWater(unit.getPhaseMask(), x, y, max_z - Z_OFFSET_FIND_HEIGHT, unit.getCollisionHeight())) {
            // do not allow creatures to walk on
            // water level while swimming
            max_z = Math.max(max_z - this.getMinHeightInWater(), ground_z);
          } else {
            // hovering units cannot go below their hover height
            const hoverOffset = unit.getHoverHeight();
            max_z += hoverOffset;
            ground_z += hoverOffset;
          }

          if (z > max_z) z = max_z;
          else if (z < ground_z) z = ground_z;
        }

        if (groundZ) groundZ.value = ground_z;
      } else {
        const ground_z = this.getMapHeight(x, y, z) + unit.getHoverHeight();
        if (z < ground_z) z = ground_z;

        if (groundZ) groundZ.value = ground_z;
      }
    } else {
      const ground_z = this.getMapHeight(x, y, z);
      if (ground_z > INVALID_HEIGHT) z = ground_z;

      if (groundZ) groundZ.value = ground_z;
    }
    return z;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetRandomPoint (the copy overload; `getRandomPointXYZ` has the reference one) */
  getRandomPoint(srcPos: PositionLike, distance: number): Position {
    const { x, y, z } = this.getRandomPointXYZ(srcPos, distance);
    return new Position(x, y, z, this.getOrientation());
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetRandomPoint (the `float& rand_x, rand_y, rand_z` overload) */
  getRandomPointXYZ(pos: PositionLike, distance: number): { x: number; y: number; z: number } {
    if (!distance) return { x: pos.getPositionX(), y: pos.getPositionY(), z: pos.getPositionZ() };

    // angle to face `obj` to `this`
    const angle = randNorm() * 2 * M_PI;
    const new_dist = randNorm() * distance;

    let rand_x = pos.getPositionX() + new_dist * Math.cos(angle);
    let rand_y = pos.getPositionY() + new_dist * Math.sin(angle);
    let rand_z = pos.getPositionZ();

    rand_x = NormalizeMapCoord(rand_x);
    rand_y = NormalizeMapCoord(rand_y);
    rand_z = this.updateGroundPositionZ(rand_x, rand_y, rand_z); // update to LOS height if available
    return { x: rand_x, y: rand_y, z: rand_z };
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetInstanceId */
  getInstanceId(): number {
    return this.m_InstanceId;
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::SetPhaseMask
   * @ac-skip `sScriptMgr->OnBeforeWorldObjectSetPhaseMask`: scripts are not ported.
   */
  setPhaseMask(newPhaseMask: number, update: boolean): void {
    this.m_phaseMask = newPhaseMask >>> 0;

    if (update && this.isInWorld()) this.updateObjectVisibility();
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetPhaseMask */
  getPhaseMask(): number {
    return this.m_phaseMask;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::InSamePhase (`(WorldObject const*)` or `(uint32 phasemask)`) */
  inSamePhase(objOrPhaseMask: WorldObject | number): boolean {
    const phasemask = typeof objOrPhaseMask === "number" ? objOrPhaseMask >>> 0 : objOrPhaseMask.getPhaseMask() >>> 0;
    return this.m_useCombinedPhases ? (this.getPhaseMask() & phasemask) !== 0 : this.getPhaseMask() >>> 0 === phasemask;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetZoneId */
  getZoneId(): number {
    if (this._updatePositionData) this.updatePositionData();

    return this._zoneId;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetAreaId */
  getAreaId(): number {
    if (this._updatePositionData) this.updatePositionData();

    return this._areaId;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetZoneAndAreaId (the reference parameters are the result) */
  getZoneAndAreaId(): { zoneid: number; areaid: number } {
    if (this._updatePositionData) this.updatePositionData();

    return { zoneid: this._zoneId, areaid: this._areaId };
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::IsOutdoors */
  isOutdoors(): boolean {
    if (this._updatePositionData) this.updatePositionData();

    return this._outdoors;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetLiquidData */
  getLiquidData(): LiquidDataLike {
    if (this._updatePositionData) this.updatePositionData();

    return this._liquidData;
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::GetInstanceScript
   * @ac-skip `InstanceMap::GetInstanceScript`: instance scripts are not ported, so there is none.
   */
  getInstanceScript(): null {
    return null;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetName */
  getName(): string {
    return this.m_name;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::SetName */
  setName(newname: string): void {
    this.m_name = newname;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetNameForLocaleIdx */
  getNameForLocaleIdx(_locale_idx: number): string {
    return this.m_name;
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::GetDistance
   * `(WorldObject const*)` subtracts both object sizes, `(Position const&)` and `(x, y, z)` only this one's.
   */
  getDistance(objOrPosOrX: WorldObject | PositionLike | number, y?: number, z?: number): number {
    let d: number;
    if (objOrPosOrX instanceof WorldObject) {
      d = this.getExactDist(objOrPosOrX) - this.getObjectSize() - objOrPosOrX.getObjectSize();
    } else if (typeof objOrPosOrX !== "number") {
      d = this.getExactDist(objOrPosOrX) - this.getObjectSize();
    } else {
      d = this.getExactDist(objOrPosOrX, y, z) - this.getObjectSize();
    }
    return d > 0.0 ? d : 0.0;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetDistance2d (`(WorldObject const*)` or `(x, y)`) */
  getDistance2d(objOrX: WorldObject | number, y?: number): number {
    let d: number;
    if (typeof objOrX !== "number") {
      d = this.getExactDist2d(objOrX) - this.getObjectSize() - objOrX.getObjectSize();
    } else {
      d = this.getExactDist2d(objOrX, y) - this.getObjectSize();
    }
    return d > 0.0 ? d : 0.0;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetDistanceZ */
  getDistanceZ(obj: WorldObject): number {
    const dz = Math.abs(this.getPositionZ() - obj.getPositionZ());
    const sizefactor = this.getObjectSize() + obj.getObjectSize();
    const dist = dz - sizefactor;
    return dist > 0 ? dist : 0;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::IsSelfOrInSameMap */
  isSelfOrInSameMap(obj: WorldObject): boolean {
    if (this === obj) return true;

    return this.isInMap(obj);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::IsInMap */
  isInMap(obj: WorldObject | null): boolean {
    if (obj) {
      return this.isInWorld() && obj.isInWorld() && this.findMap() === obj.findMap();
    }

    return false;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::IsWithinDist3d (`(x, y, z, dist)` or `(Position const*, dist)`) */
  isWithinDist3d(xOrPos: number | PositionLike, yOrDist: number, z?: number, dist?: number): boolean {
    if (typeof xOrPos !== "number") return this.isInDist(xOrPos, yOrDist + this.getObjectSize());
    return this.isInDist(xOrPos, yOrDist, z, (dist ?? 0) + this.getObjectSize());
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::IsWithinDist2d (`(x, y, dist)` or `(Position const*, dist)`) */
  isWithinDist2d(xOrPos: number | PositionLike, yOrDist: number, dist?: number): boolean {
    if (typeof xOrPos !== "number") return this.isInDist2d(xOrPos, yOrDist + this.getObjectSize());
    return this.isInDist2d(xOrPos, yOrDist, (dist ?? 0) + this.getObjectSize());
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::IsWithinSightRange
   * Visibility always uses 2d checks, factors in self-object size already. Gameobjects will override this for custom calc
   */
  isWithinSightRange(pos: PositionLike, dist: number): boolean {
    return this.isInDist2d(pos, dist + this.getObjectSize());
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::IsWithinDist (use only if you will sure about placing both object at same map) */
  isWithinDist(obj: WorldObject | null, dist2compare: number, is3D = true, incOwnRadius = true, incTargetRadius = true): boolean {
    return obj !== null && this._IsWithinDist(obj, dist2compare, is3D, incOwnRadius, incTargetRadius);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::IsWithinDistInMap */
  isWithinDistInMap(obj: WorldObject | null, dist2compare: number, is3D = true, incOwnRadius = true, incTargetRadius = true): boolean {
    return obj !== null && this.isInMap(obj) && this.inSamePhase(obj) && this._IsWithinDist(obj, dist2compare, is3D, incOwnRadius, incTargetRadius);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::IsWithinLOS */
  isWithinLOS(ox: number, oy: number, oz: number, ignoreFlags: number = ModelIgnoreFlags.Nothing, checks: number = LINEOFSIGHT_ALL_CHECKS): boolean {
    if (this.isInWorld()) {
      oz += this.getCollisionHeight();
      let x: number;
      let y: number;
      let z: number;
      if (this.isPlayer()) {
        x = this.getPositionX();
        y = this.getPositionY();
        z = this.getPositionZ() + this.getCollisionHeight();
      } else {
        ({ x, y, z } = this.getHitSpherePointForXYZ(new Position(ox, oy, oz)));
      }

      return this.getMap().isInLineOfSight(x, y, z, ox, oy, oz, this.getPhaseMask(), checks, ignoreFlags);
    }
    return true;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::IsWithinLOSInMap */
  isWithinLOSInMap(
    obj: WorldObject,
    ignoreFlags: number = ModelIgnoreFlags.Nothing,
    checks: number = LINEOFSIGHT_ALL_CHECKS,
    collisionHeight: number | null = null,
    combatReach: number | null = null,
  ): boolean {
    if (!this.isInMap(obj)) return false;

    let ox: number;
    let oy: number;
    let oz: number;
    if (obj.isPlayer()) {
      ox = obj.getPositionX();
      oy = obj.getPositionY();
      oz = obj.getPositionZ() + obj.getCollisionHeight();
    } else {
      ({ x: ox, y: oy, z: oz } = obj.getHitSpherePointForXYZ(
        new Position(this.getPositionX(), this.getPositionY(), this.getPositionZ() + (collisionHeight ?? this.getCollisionHeight())),
      ));
    }

    let x: number;
    let y: number;
    let z: number;
    if (this.isPlayer()) {
      x = this.getPositionX();
      y = this.getPositionY();
      z = this.getPositionZ() + this.getCollisionHeight();
    } else {
      ({ x, y, z } = this.getHitSpherePointForXYZ(new Position(obj.getPositionX(), obj.getPositionY(), obj.getPositionZ() + obj.getCollisionHeight()), collisionHeight, combatReach));
    }

    return this.getMap().isInLineOfSight(x, y, z, ox, oy, oz, this.getPhaseMask(), checks, ignoreFlags);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetHitSpherePointFor (the `Position` overload) */
  getHitSpherePointFor(dest: PositionLike, collisionHeight: number | null = null, combatReach: number | null = null): Position {
    const thisX = this.getPositionX();
    const thisY = this.getPositionY();
    const thisZ = this.getPositionZ() + (collisionHeight ?? this.getCollisionHeight());
    // (vObj - vThis).directionOrZero()
    let dx = dest.getPositionX() - thisX;
    let dy = dest.getPositionY() - thisY;
    let dz = dest.getPositionZ() - thisZ;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len > 0.00001) {
      dx /= len;
      dy /= len;
      dz /= len;
    } else {
      dx = dy = dz = 0;
    }
    const reach = Math.min(Position.copy(dest).getExactDist(this), combatReach ?? this.getCombatReach());
    const cx = thisX + dx * reach;
    const cy = thisY + dy * reach;
    const cz = thisZ + dz * reach;

    return new Position(cx, cy, cz, this.getAngle(cx, cy));
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetHitSpherePointFor (the `float& x, y, z` overload) */
  getHitSpherePointForXYZ(dest: PositionLike, collisionHeight: number | null = null, combatReach: number | null = null): { x: number; y: number; z: number } {
    const pos = this.getHitSpherePointFor(dest, collisionHeight, combatReach);
    return { x: pos.getPositionX(), y: pos.getPositionY(), z: pos.getPositionZ() };
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetDistanceOrder */
  getDistanceOrder(obj1: WorldObject, obj2: WorldObject, is3D = true): boolean {
    const dx1 = this.getPositionX() - obj1.getPositionX();
    const dy1 = this.getPositionY() - obj1.getPositionY();
    let distsq1 = dx1 * dx1 + dy1 * dy1;
    if (is3D) {
      const dz1 = this.getPositionZ() - obj1.getPositionZ();
      distsq1 += dz1 * dz1;
    }

    const dx2 = this.getPositionX() - obj2.getPositionX();
    const dy2 = this.getPositionY() - obj2.getPositionY();
    let distsq2 = dx2 * dx2 + dy2 * dy2;
    if (is3D) {
      const dz2 = this.getPositionZ() - obj2.getPositionZ();
      distsq2 += dz2 * dz2;
    }

    return distsq1 < distsq2;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::IsInRange */
  isInRange(obj: WorldObject, minRange: number, maxRange: number, is3D = true): boolean {
    const dx = this.getPositionX() - obj.getPositionX();
    const dy = this.getPositionY() - obj.getPositionY();
    let distsq = dx * dx + dy * dy;
    if (is3D) {
      const dz = this.getPositionZ() - obj.getPositionZ();
      distsq += dz * dz;
    }

    const sizefactor = this.getObjectSize() + obj.getObjectSize();

    // check only for real range
    if (minRange > 0.0) {
      const mindist = minRange + sizefactor;
      if (distsq < mindist * mindist) return false;
    }

    const maxdist = maxRange + sizefactor;
    return distsq < maxdist * maxdist;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::IsInRange2d */
  isInRange2d(x: number, y: number, minRange: number, maxRange: number): boolean {
    const dx = this.getPositionX() - x;
    const dy = this.getPositionY() - y;
    const distsq = dx * dx + dy * dy;

    const sizefactor = this.getObjectSize();

    // check only for real range
    if (minRange > 0.0) {
      const mindist = minRange + sizefactor;
      if (distsq < mindist * mindist) return false;
    }

    const maxdist = maxRange + sizefactor;
    return distsq < maxdist * maxdist;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::IsInRange3d */
  isInRange3d(x: number, y: number, z: number, minRange: number, maxRange: number): boolean {
    const dx = this.getPositionX() - x;
    const dy = this.getPositionY() - y;
    const dz = this.getPositionZ() - z;
    const distsq = dx * dx + dy * dy + dz * dz;

    const sizefactor = this.getObjectSize();

    // check only for real range
    if (minRange > 0.0) {
      const mindist = minRange + sizefactor;
      if (distsq < mindist * mindist) return false;
    }

    const maxdist = maxRange + sizefactor;
    return distsq < maxdist * maxdist;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::isInFront */
  isInFront(target: WorldObject, arc = M_PI): boolean {
    return this.hasInArc(arc, target);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::isInBack */
  isInBack(target: WorldObject, arc = M_PI): boolean {
    return !this.hasInArc(2 * M_PI - arc, target);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::IsInBetween */
  isInBetween(obj1: WorldObject | null, obj2: WorldObject | null, size = 0): boolean {
    if (!obj1 || !obj2) return false;

    if (!size) size = this.getObjectSize() / 2;

    const pdist = obj1.getExactDist2dSq(obj2) + size / 2.0;
    if (this.getExactDist2dSq(obj1) >= pdist || this.getExactDist2dSq(obj2) >= pdist) return false;

    if (fuzzyEq(obj1.getPositionX(), obj2.getPositionX())) {
      return this.getPositionX() >= obj1.getPositionX() - size && this.getPositionX() <= obj1.getPositionX() + size;
    }

    const A = (obj2.getPositionY() - obj1.getPositionY()) / (obj2.getPositionX() - obj1.getPositionX());
    const B = -1;
    const C = obj1.getPositionY() - A * obj1.getPositionX();
    const dist = Math.abs(A * this.getPositionX() + B * this.getPositionY() + C) / Math.sqrt(A * A + B * B);
    return dist <= size;
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::CleanupsBeforeDelete
   * used in destructor or explicitly before mass creature delete to remove cross-references to already deleted units
   */
  cleanupsBeforeDelete(_finalCleanup = true): void {
    if (this.isInWorld()) this.removeFromWorld();

    this.m_Events.killAllEvents(false); // non-delatable (currently cast spells) will not deleted now but it will deleted at call in Map::RemoveAllObjectsInRemoveList
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::SendMessageToSet
   * `(data, bool self)` sends to the players that see this object; `(data, Player const* skipped_rcvr)` skips one.
   */
  sendMessageToSet(data: WorldPacket, selfOrSkipped: boolean | GridPlayer | null): void {
    if (typeof selfOrSkipped === "boolean") {
      if (this.isInWorld()) this.sendMessageToSetInRange(data, 0.0, selfOrSkipped);
      return;
    }
    const notifier = new MessageDistDeliverer(this, data, 0.0, TeamFilter.All, selfOrSkipped);
    notifier.visitVisiblePlayersMap(this.getObjectVisibilityContainer().getVisiblePlayersMap());
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::SendMessageToSetInRange */
  sendMessageToSetInRange(data: WorldPacket, dist: number, _self: boolean): void {
    const notifier = new MessageDistDeliverer(this, data, dist);
    notifier.visitVisiblePlayersMap(this.getObjectVisibilityContainer().getVisiblePlayersMap());
  }

  /** @ac game/Entities/Object/Object.h WorldObject::getLevelForTarget */
  getLevelForTarget(_target: WorldObject): number {
    return 1;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::PlayDistanceSound */
  playDistanceSound(sound_id: number, target: GridPlayer | null = null): void {
    const packet = { opcode: SMSG_PLAY_OBJECT_SOUND, payload: new ByteWriter().writeU32(sound_id).writeU64(this.getGUID()).toUint8Array() };
    if (target) target.sendDirectMessage(packet);
    else this.sendMessageToSet(packet, true);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::PlayDirectSound */
  playDirectSound(sound_id: number, target: GridPlayer | null = null): void {
    const packet = { opcode: SMSG_PLAY_SOUND, payload: new ByteWriter().writeU32(sound_id).toUint8Array() };
    if (target) target.sendDirectMessage(packet);
    else this.sendMessageToSet(packet, true);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::PlayRadiusSound */
  playRadiusSound(sound_id: number, radius: number): void {
    const targets: GridPlayer[] = [];
    const check = new AnyPlayerInObjectRangeCheck(this, radius, false);
    const searcher = new PlayerListSearcher(this, targets, check);
    Cell.visitObjects(this, searcher, radius);

    for (const player of targets) player.sendDirectMessage({ opcode: SMSG_PLAY_SOUND, payload: new ByteWriter().writeU32(sound_id).toUint8Array() });
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::PlayDirectMusic */
  playDirectMusic(music_id: number, target: GridPlayer | null = null): void {
    const packet = { opcode: SMSG_PLAY_MUSIC, payload: new ByteWriter().writeU32(music_id).toUint8Array() };
    if (target) target.sendDirectMessage(packet);
    else this.sendMessageToSet(packet, true);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::PlayRadiusMusic */
  playRadiusMusic(music_id: number, radius: number): void {
    const targets: GridPlayer[] = [];
    const check = new AnyPlayerInObjectRangeCheck(this, radius, false);
    const searcher = new PlayerListSearcher(this, targets, check);
    Cell.visitObjects(this, searcher, radius);

    for (const player of targets) player.sendDirectMessage({ opcode: SMSG_PLAY_MUSIC, payload: new ByteWriter().writeU32(music_id).toUint8Array() });
  }

  /** @ac game/Entities/Object/Object.h WorldObject::DoForAllVisiblePlayers (Warning: Possible iterator invalidation in uses that may modify visibility map) */
  doForAllVisiblePlayers(worker: (player: GridPlayer) => void): void {
    for (const player of this.getObjectVisibilityContainer().getVisiblePlayersMap().values()) worker(player);
  }

  /** @ac game/Entities/Object/Object.h WorldObject::DoForAllVisibleWorldObjects */
  doForAllVisibleWorldObjects(worker: (obj: WorldObject) => void): void {
    // Not a player, no access to this map
    const visibleWorldObjectsMap = this.getObjectVisibilityContainer().getVisibleWorldObjectsMap();
    if (!visibleWorldObjectsMap) return;

    for (const obj of visibleWorldObjectsMap.values()) worker(obj);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::DestroyForVisiblePlayers (removes us from visibility for all players who are currently able to see us) */
  destroyForVisiblePlayers(): void {
    if (!this.isInWorld()) return;

    const visiblePlayerMap = this.getObjectVisibilityContainer().getVisiblePlayersMap();
    for (const player of [...visiblePlayerMap.values()]) {
      this.destroyForPlayer(player);

      // Clean up visibility references now
      this.getObjectVisibilityContainer().unlinkVisibilityFromWorldObject(player);
    }
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::SendObjectDeSpawnAnim */
  sendObjectDeSpawnAnim(guid: bigint): void {
    this.sendMessageToSet({ opcode: SMSG_GAMEOBJECT_DESPAWN_ANIM, payload: new ByteWriter().writeU64(guid).toUint8Array() }, true);
  }

  /** @ac game/Entities/Object/Object.h WorldObject::SaveRespawnTime */
  saveRespawnTime(): void {}

  /** @ac game/Entities/Object/Object.cpp WorldObject::AddObjectToRemoveList */
  addObjectToRemoveList(): void {
    const map = this.findMap();
    if (!map) {
      logError("server", `Object ${ObjectGuid.ToString(this.getGUID())} at attempt add to move list not have valid map (Id: ${this.getMapId()}).`);
      return;
    }

    map.addObjectToRemoveList(this);
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::GetGridActivationRange
   * @ac-skip `Player::GetCinematicMgr().IsOnCinematic()`: cinematics are not ported, so a player is never on one.
   */
  getGridActivationRange(): number {
    if (this.toPlayer()) {
      return this.isInWintergrasp() ? VISIBILITY_DIST_WINTERGRASP : this.getMap().getVisibilityRange();
    }
    const creature = this.toCreature();
    if (creature) return creature.m_SightDistance;
    const go = this.toGameObject();
    if (((go && go.isTransport()) || this.isDynamicObject()) && this.isActiveObject()) return this.getMap().getVisibilityRange();

    return 0.0;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetVisibilityRange */
  getVisibilityRange(): number {
    if (this.isCreature() && this.isVisibilityOverridden()) return this.getVisibilityOverrideDistance();
    if (this.isGameObject()) {
      if (this.isInWintergrasp()) return VISIBILITY_DIST_WINTERGRASP;
      if (this.isVisibilityOverridden()) return this.getVisibilityOverrideDistance();
      return this.getMap().getVisibilityRange();
    }
    return this.isInWintergrasp() ? VISIBILITY_DIST_WINTERGRASP : this.getMap().getVisibilityRange();
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::GetSightRange
   * @ac-skip `Player::GetCinematicMgr().IsOnCinematic()`: cinematics are not ported, so a player is never on one.
   */
  getSightRange(target: WorldObject | null = null): number {
    if (this.toUnit()) {
      if (this.toPlayer()) {
        if (target) {
          if (target.isCreature() && target.isVisibilityOverridden()) return target.getVisibilityOverrideDistance();
          if (target.isGameObject()) {
            if (this.isInWintergrasp() && target.isInWintergrasp()) return VISIBILITY_DIST_WINTERGRASP;
            if (target.isVisibilityOverridden()) return target.getVisibilityOverrideDistance();
            return this.getMap().getVisibilityRange();
          }

          return this.isInWintergrasp() && target.isInWintergrasp() ? VISIBILITY_DIST_WINTERGRASP : this.getMap().getVisibilityRange();
        }
        return this.isInWintergrasp() ? VISIBILITY_DIST_WINTERGRASP : this.getMap().getVisibilityRange();
      }
      const creature = this.toCreature();
      if (creature) return creature.m_SightDistance;
      return SIGHT_RANGE_UNIT;
    }

    if (this.toDynObject() && this.isActiveObject()) return this.getMap().getVisibilityRange();

    return 0.0;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetLeewayBonusRangeForTargets */
  static getLeewayBonusRangeForTargets(player: UnitLike | null, target: UnitLike | null): number {
    if (!player || !target) return 0.0;

    const leewayMoveFlags = MOVEMENTFLAG_FORWARD | MOVEMENTFLAG_STRAFE_LEFT | MOVEMENTFLAG_STRAFE_RIGHT | MOVEMENTFLAG_FALLING;
    if (player.hasUnitMovementFlag(leewayMoveFlags) && !player.isWalking() && target.hasUnitMovementFlag(leewayMoveFlags) && !target.isWalking()) {
      return LEEWAY_BONUS_RANGE;
    }

    return 0.0;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetLeewayBonusRange */
  getLeewayBonusRange(target: UnitLike | null): number {
    if (!target) return 0.0;

    const player = this.toPlayer();
    if (player) return WorldObject.getLeewayBonusRangeForTargets(player, target);

    const playerTarget = target.toPlayer();
    if (playerTarget) return WorldObject.getLeewayBonusRangeForTargets(playerTarget, this.toUnit());

    return 0.0;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetLeewayBonusRadius */
  getLeewayBonusRadius(): number {
    const player = this.toPlayer();
    if (player) {
      let hasLeewayMovement = false;

      if (player.hasUnitState(UNIT_STATE_JUMPING) || player.hasUnitMovementFlag(MOVEMENTFLAG_FALLING)) {
        hasLeewayMovement = true;
      } else {
        const speedXY = player.m_movementInfo.jump.xyspeed > 0.0 ? player.m_movementInfo.jump.xyspeed : player.getSpeed(player.isWalking() ? MOVE_WALK : MOVE_RUN);

        hasLeewayMovement = speedXY > LEEWAY_MIN_MOVE_SPEED;
      }

      if (hasLeewayMovement) return LEEWAY_BONUS_RANGE;
    }

    return 0.0;
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::CanSeeOrDetect
   * @ac-skip `CreatureAI::CanBeSeen`, `GameObjectAI::CanBeSeen`, `Player::CanSeeObjectByVisibilityConditions`: AI and
   * visibility conditions are not ported. `TempSummon::IsVisibleBySummonerOnly`: temp summons are not ported. The arena
   * pet check: battlegrounds are not ported.
   */
  canSeeOrDetect(obj: WorldObject, ignoreStealth = false, distanceCheck = false, checkAlert = false): boolean {
    if (this === obj) return true;

    if (this.canNeverSee(obj)) return false;

    if (obj.isAlwaysVisibleFor(this) || this.canAlwaysSee(obj)) return true;

    // pussywizard: arena spectator
    const objPlayer = obj.toPlayer();
    if (objPlayer && objPlayer.isSpectator() && objPlayer.findMap()?.isBattleArena()) return false;

    let corpseVisibility = false;
    if (distanceCheck) {
      let corpseCheck = false;
      let sightPosition: PositionLike = this;
      const thisPlayer = this.toPlayer();
      if (thisPlayer) {
        sightPosition = thisPlayer.getSightPosition();

        if (
          thisPlayer.isDead() &&
          thisPlayer.getHealth() > 0 && // Cheap way to check for ghost state
          !(obj.m_serverSideVisibility.getValue(SERVERSIDE_VISIBILITY_GHOST) & this.m_serverSideVisibility.getValue(SERVERSIDE_VISIBILITY_GHOST) & GHOST_VISIBILITY_GHOST)
        ) {
          const corpse = thisPlayer.getCorpse();
          if (corpse) {
            corpseCheck = true;
            if (corpse.isWithinDist(thisPlayer, this.getSightRange(obj), false)) {
              if (corpse.isWithinDist(obj, this.getSightRange(obj), false)) corpseVisibility = true;
            }
          }
        }

        // our additional checks
        const target = obj.toUnit();
        if (target) {
          // xinef: don't allow to detect vehicle accessory if you can't see vehicle base!
          const vehicle = target.getVehicleBase();
          if (vehicle && !thisPlayer.haveAtClient(vehicle)) return false;
        }

        if (thisPlayer.getFarSightDistance() && !this.isInFront(obj)) return false;
      }

      if (!corpseCheck && !obj.isWithinSightRange(sightPosition, this.getSightRange(obj))) return false;
    }

    // GM visibility off or hidden NPC
    if (!obj.m_serverSideVisibility.getValue(SERVERSIDE_VISIBILITY_GM)) {
      // Stop checking other things for GMs
      if (this.m_serverSideVisibilityDetect.getValue(SERVERSIDE_VISIBILITY_GM)) return true;
    } else {
      return this.m_serverSideVisibilityDetect.getValue(SERVERSIDE_VISIBILITY_GM) >= obj.m_serverSideVisibility.getValue(SERVERSIDE_VISIBILITY_GM);
    }

    // Ghost players, Spirit Healers, and some other NPCs
    if (!corpseVisibility && !(obj.m_serverSideVisibility.getValue(SERVERSIDE_VISIBILITY_GHOST) & this.m_serverSideVisibilityDetect.getValue(SERVERSIDE_VISIBILITY_GHOST))) {
      // Alive players can see dead players in some cases, but other objects can't do that
      const thisPlayer = this.toPlayer();
      if (thisPlayer) {
        if (objPlayer) {
          if (thisPlayer.getTeamId() !== objPlayer.getTeamId() || !thisPlayer.isGroupVisibleFor(objPlayer)) return false;
        } else {
          return false;
        }
      } else {
        return false;
      }
    }

    if (obj.isInvisibleDueToDespawn()) return false;

    // pussywizard: arena spectator
    const selfPlayer = this.toPlayer();
    if (selfPlayer && selfPlayer.isSpectator() && selfPlayer.findMap()?.isBattleArena() && (obj.m_invisibility.getFlags() || obj.m_stealth.getFlags())) {
      return false;
    }

    if (!this.canDetect(obj, ignoreStealth, !distanceCheck, checkAlert)) return false;

    return true;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::CanNeverSee */
  canNeverSee(obj: WorldObject): boolean {
    if (!this.isInWorld()) return true;

    if (obj.isNeverVisible()) return true;

    if (this.isCreature() && obj.isCreature()) {
      const self: WorldObject = this;
      return this.getMap() !== obj.getMap() || (!this.inSamePhase(obj) && this.toUnit()?.getVehicleBase() !== obj && self !== obj.toUnit()?.getVehicleBase());
    }
    return this.getMap() !== obj.getMap() || !this.inSamePhase(obj);
  }

  /** @ac game/Entities/Object/Object.h WorldObject::CanAlwaysSee */
  canAlwaysSee(_obj: WorldObject): boolean {
    return false;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::CanDetect */
  canDetect(obj: WorldObject, ignoreStealth: boolean, checkClient: boolean, checkAlert = false): boolean {
    let seer: WorldObject = this;

    // Pets don't have detection, they use the detection of their masters
    const thisUnit = this.toUnit();
    if (thisUnit) {
      const controller = thisUnit.getCharmerOrOwner();
      if (controller) seer = controller;
    }

    if (obj.isAlwaysDetectableFor(seer) || this.getEntry() === WORLD_TRIGGER) return true; // xinef: World Trigger can detect all objects, used for wild gameobjects without owner!

    if (!ignoreStealth) {
      if (!seer.canDetectInvisibilityOf(obj)) return false; // xinef: added ignoreStealth, allow AoE spells to hit invisible targets!

      if (!seer.canDetectStealthOf(obj, checkAlert)) {
        // xinef: ignore units players have at client, this cant be cheated!
        if (checkClient) {
          const player = this.toPlayer();
          if (!player || !player.haveAtClient(obj)) return false;
        } else {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::CanDetectInvisibilityOf
   * The permanently invisible creature exception reads the creature's `SPELL_AURA_MOD_INVISIBILITY` effects through
   * `isPermanentlyInvisibleCreature`.
   */
  canDetectInvisibilityOf(obj: WorldObject): boolean {
    let mask = obj.m_invisibility.getFlags() & this.m_invisibilityDetect.getFlags();
    // xinef: include invisible flags of caster in the mask, 2 invisible objects should be able to detect eachother
    mask |= obj.m_invisibility.getFlags() & this.m_invisibility.getFlags();

    // Check for not detected types
    if (mask >>> 0 !== obj.m_invisibility.getFlags() >>> 0) return false;

    // It isn't possible in invisibility to detect something that can't detect the invisible object
    // (it's at least true for spell: 66)
    // It seems like that only Units are affected by this check (couldn't see arena doors with preparation invisibility)
    if (obj.toUnit()) {
      // Permanently invisible creatures should be able to engage non-invisible targets.
      // ex. Skulking Witch (20882) / Greater Invisibility (16380)
      const isPermInvisibleCreature = this.toCreature()?.isPermanentlyInvisibleCreature() ?? false;

      if (!isPermInvisibleCreature) {
        let objMask = this.m_invisibility.getFlags() & obj.m_invisibilityDetect.getFlags();
        // xinef: include invisible flags of caster in the mask, 2 invisible objects should be able to detect eachother
        objMask |= this.m_invisibility.getFlags() & obj.m_invisibility.getFlags();
        if (objMask >>> 0 !== this.m_invisibility.getFlags() >>> 0) return false;
      }
    }

    for (let i = 0; i < TOTAL_INVISIBILITY_TYPES; ++i) {
      if (!(mask & (1 << i))) continue;

      // xinef: visible for the same invisibility type:
      if (this.m_invisibility.getValue(i) && obj.m_invisibility.getValue(i)) continue;

      const objInvisibilityValue = obj.m_invisibility.getValue(i);
      const ownInvisibilityDetectValue = this.m_invisibilityDetect.getValue(i);

      // Too low value to detect
      if (ownInvisibilityDetectValue < objInvisibilityValue) return false;
    }

    return true;
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::CanDetectStealthOf
   * Combat reach is the minimal distance (both in front and behind), and it is also used in the range calculation.
   * One stealth point increases the visibility range by 0.3 yard.
   */
  canDetectStealthOf(obj: WorldObject, checkAlert = false): boolean {
    if (!obj.m_stealth.getFlags()) return true;

    // dead players shouldnt be able to detect stealth on arenas
    if (this.isType(TYPEMASK_PLAYER)) {
      if (!this.toPlayer()!.isAlive()) return false;
    }

    const distance = this.getExactDist(obj);
    let combatReach = 0.0;

    if (this.isUnit()) combatReach = this.getCombatReach();

    if (distance < combatReach) return true;

    if (!this.hasInArc(M_PI, obj)) return false;

    for (let i = 0; i < TOTAL_STEALTH_TYPES; ++i) {
      if (!(obj.m_stealth.getFlags() & (1 << i))) continue;

      const unitSelf = this.isUnit() ? this.toUnit() : null;
      if (unitSelf && unitSelf.hasAuraTypeWithMiscvalue(SPELL_AURA_DETECT_STEALTH, i)) return true;

      // Starting points
      let detectionValue = 30;

      // Level difference: 5 point / level, starting from level 1.
      // There may be spells for this and the starting points too, but
      // not in the DBCs of the client.
      detectionValue += (this.getLevelForTarget(obj) - 1) * 5;

      // Apply modifiers
      detectionValue += this.m_stealthDetect.getValue(i);
      if (obj.isType(TYPEMASK_GAMEOBJECT)) {
        detectionValue += 30; // pussywizard: increase detection range for gameobjects (ie. traps)
        const owner = obj.toGameObject()?.getOwner() ?? null;
        if (owner) detectionValue -= (owner.getLevelForTarget(this) - 1) * 5;
      }

      detectionValue -= obj.m_stealth.getValue(i);

      // Calculate max distance
      let visibilityRange = detectionValue * 0.3 + combatReach;

      const unit = this.toUnit();

      // If this unit is an NPC then player detect range doesn't apply
      if (unit && unit.isPlayer() && visibilityRange > MAX_PLAYER_STEALTH_DETECT_RANGE) visibilityRange = MAX_PLAYER_STEALTH_DETECT_RANGE;

      if (checkAlert) visibilityRange += visibilityRange * 0.08 + 1.5;

      // If checking for alert, and creature's visibility range is greater than aggro distance, No alert
      const creature = unit?.toCreature() ?? null;
      if (checkAlert && creature && visibilityRange >= creature.getAttackDistance(obj.toUnit()) + creature.m_CombatDistance) return false;

      if (distance > visibilityRange) return false;
    }

    return true;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::SendPlayMusic */
  sendPlayMusic(Music: number, OnlySelf: boolean): void {
    const data = { opcode: SMSG_PLAY_MUSIC, payload: new ByteWriter().writeU32(Music).toUint8Array() };
    const player = this.toPlayer();
    if (OnlySelf && player) player.sendDirectMessage(data);
    else this.sendMessageToSet(data, true); // ToSelf ignored in this case
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::SetMap
   * @ac-skip `sScriptMgr->OnWorldObjectSetMap`: scripts are not ported.
   */
  setMap(map: MapLike): void {
    if (this.isInWorld()) throw new Error("WorldObject::SetMap: object is in world");

    if (this.m_currMap === map) return; // command add npc: first create, than loadfromdb

    if (this.m_currMap) {
      throw new Error(
        `WorldObject::SetMap: obj ${this.getTypeId()} new map ${map.getId()} ${map.getInstanceId()}, old map ${this.m_currMap.getId()} ${this.m_currMap.getInstanceId()}`,
      );
    }

    this.m_currMap = map;
    this.m_mapId = map.getId();
    this.m_InstanceId = map.getInstanceId();
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::ResetMap
   * @ac-skip `sScriptMgr->OnWorldObjectResetMap`: scripts are not ported.
   */
  resetMap(): void {
    if (!this.m_currMap) throw new Error("WorldObject::ResetMap: no map");
    if (this.isInWorld()) throw new Error("WorldObject::ResetMap: object is in world");

    this.m_currMap = null;
    // maybe not for corpse
    // m_mapId = 0;
    // m_InstanceId = 0;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetMap */
  getMap(): MapLike {
    if (!this.m_currMap) throw new Error(`WorldObject::GetMap: ${ObjectGuid.ToString(this.getGUID())} has no map`);
    return this.m_currMap;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::FindMap */
  findMap(): MapLike | null {
    return this.m_currMap;
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::SetZoneScript
   * @ac-skip `InstanceMap::GetInstanceScript`, `sBattlefieldMgr`, `sOutdoorPvPMgr`: none is ported, so no object has a
   * zone script yet.
   */
  setZoneScript(): void {
    this.m_zoneScript = null;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::ClearZoneScript */
  clearZoneScript(): void {
    this.m_zoneScript = null;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetZoneScript */
  getZoneScript(): ZoneScript | null {
    return this.m_zoneScript;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::FindNearestCreature */
  findNearestCreature(entry: number, range: number, alive = true): Creature | null {
    const checker = new NearestCreatureEntryWithLiveStateInObjectRangeCheck(this, entry, alive, range);
    const searcher = new CreatureLastSearcher(this, checker);
    Cell.visitObjects(this, searcher, range);
    return searcher.i_object;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::FindNearestGameObject */
  findNearestGameObject(entry: number, range: number, onlySpawned = false): GameObject | null {
    const checker = new NearestGameObjectEntryInObjectRangeCheck(this, entry, range, onlySpawned);
    const searcher = new GameObjectLastSearcher(this, checker);
    Cell.visitObjects(this, searcher, range);
    return searcher.i_object;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::FindNearestGameObjectOfType */
  findNearestGameObjectOfType(type: number, range: number): GameObject | null {
    const checker = new NearestGameObjectTypeInObjectRangeCheck(this, type, range);
    const searcher = new GameObjectLastSearcher(this, checker);
    Cell.visitObjects(this, searcher, range);
    return searcher.i_object;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::SelectNearestPlayer */
  selectNearestPlayer(distance = 0): GridPlayer | null {
    const checker = new NearestPlayerInObjectRangeCheck(this, distance);
    const searcher = new PlayerLastSearcher(this, checker);
    Cell.visitObjects(this, searcher, distance);

    return searcher.i_object;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetDebugInfo */
  override getDebugInfo(): string {
    return `${super.getDebugInfo()}\n${this.getObjectDebugInfo()}\nName: ${this.getName()}`;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetGameObjectListWithEntryInGrid (one entry or a list of entries) */
  getGameObjectListWithEntryInGrid(gameobjectList: GameObject[], entry: number | readonly number[], maxSearchRange: number): void {
    const check = typeof entry === "number" ? new AllGameObjectsWithEntryInRange(this, entry, maxSearchRange) : new AllGameObjectsMatchingOneEntryInRange(this, entry, maxSearchRange);
    const searcher = new GameObjectListSearcher(this, gameobjectList, check);
    Cell.visitObjects(this, searcher, maxSearchRange);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetCreatureListWithEntryInGrid (one entry or a list of entries) */
  getCreatureListWithEntryInGrid(creatureList: Creature[], entry: number | readonly number[], maxSearchRange: number): void {
    const check = typeof entry === "number" ? new AllCreaturesOfEntryInRange(this, entry, maxSearchRange) : new AllCreaturesMatchingOneEntryInRange(this, entry, maxSearchRange);
    const searcher = new CreatureListSearcher(this, creatureList, check);
    Cell.visitObjects(this, searcher, maxSearchRange);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetDeadCreatureListInGrid */
  getDeadCreatureListInGrid(creaturedeadList: Creature[], maxSearchRange: number, alive = false): void {
    const check = new AllDeadCreaturesInRange(this, maxSearchRange, alive);
    const searcher = new CreatureListSearcher(this, creaturedeadList, check);
    Cell.visitObjects(this, searcher, maxSearchRange);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::UpdateObjectVisibility (updates object's visibility for nearby players) */
  updateObjectVisibility(_forced = true, _fromUpdate = false): void {
    const notifier = new VisibleChangesNotifier(this);
    Cell.visitObjects(this, notifier, this.getVisibilityRange());
  }

  /** @ac game/Entities/Object/Object.h WorldObject::UpdateObjectVisibilityOnCreate */
  updateObjectVisibilityOnCreate(): void {
    this.updateObjectVisibility(true);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetCreaturesWithEntryInRange */
  getCreaturesWithEntryInRange(creatureList: Creature[], radius: number, entry: number): void {
    const check = new AllCreaturesOfEntryInRange(this, entry, radius);
    const searcher = new CreatureListSearcher(this, creatureList, check);
    Cell.visitObjects(this, searcher, radius);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::SetPositionDataUpdate */
  setPositionDataUpdate(): void {
    this._updatePositionData = true;

    // Calls immediately for charmed units
    if (this.isCreature() && this.toUnit()?.isCharmedOwnedByPlayerOrPlayer()) this.updatePositionData();
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::UpdatePositionData */
  updatePositionData(): void {
    this._updatePositionData = false;

    const data = this.getMap().getFullTerrainStatusForPosition(this.getPhaseMask(), this.getPositionX(), this.getPositionY(), this.getPositionZ(), this.getCollisionHeight());
    this.processPositionDataChanged(data);
  }

  /** @ac game/Entities/Object/Object.h WorldObject::IsPositionDataUpdatePending */
  isPositionDataUpdatePending(): boolean {
    return this._updatePositionData;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::AddToObjectUpdate */
  addToObjectUpdate(): void {
    this.getMap().addUpdateObject(this);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::RemoveFromObjectUpdate */
  removeFromObjectUpdate(): void {
    this.getMap().removeUpdateObject(this);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::AddToNotify (relocation and visibility system functions) */
  addToNotify(f: number): void {
    if (!(this.m_notifyflags & f)) {
      const u = this.toUnit();
      if (u) {
        if (f & NOTIFY_VISIBILITY_CHANGED) {
          const mapEntry = u.findMap()?.getEntry() ?? null;
          let EVENT_VISIBILITY_DELAY = mapEntry ? WorldObject.DynamicVisibilityMgr.GetVisibilityNotifyDelay(mapEntry.map_type) : 1000;

          const diff = getMSTimeDiff(u.m_last_notify_mstime, getGameTimeMS());
          if (diff >= EVENT_VISIBILITY_DELAY / 2) EVENT_VISIBILITY_DELAY = Math.trunc(EVENT_VISIBILITY_DELAY / 2);
          else EVENT_VISIBILITY_DELAY -= diff;
          u.m_delayed_unit_relocation_timer = EVENT_VISIBILITY_DELAY;
          u.m_last_notify_mstime = getGameTimeMS() + EVENT_VISIBILITY_DELAY - 1;
        } else if (f & NOTIFY_AI_RELOCATION) {
          const mapEntry = u.findMap()?.getEntry() ?? null;
          u.m_delayed_unit_ai_notify_timer = mapEntry ? WorldObject.DynamicVisibilityMgr.GetAINotifyDelay(mapEntry.map_type) : 500;
        }

        this.m_notifyflags |= f;
      }
    }
  }

  /** @ac game/Entities/Object/Object.h WorldObject::RemoveFromNotify */
  removeFromNotify(f: number): void {
    this.m_notifyflags &= ~f;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::isNeedNotify */
  isNeedNotify(f: number): boolean {
    return (this.m_notifyflags & f) !== 0;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetNotifyFlags */
  getNotifyFlags(): number {
    return this.m_notifyflags;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::NotifyExecuted */
  notifyExecuted(f: number): boolean {
    return (this.m_executed_notifies & f) !== 0;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::SetNotified */
  setNotified(f: number): void {
    this.m_executed_notifies |= f;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::ResetAllNotifies */
  resetAllNotifies(): void {
    this.m_notifyflags = 0;
    this.m_executed_notifies = 0;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::isActiveObject */
  isActiveObject(): boolean {
    return this.m_isActive;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::setActive */
  setActive(on: boolean): void {
    if (this.m_isActive === on) return;

    if (this.isPlayer()) return;

    this.m_isActive = on;

    if (!on || !this.isInWorld()) return;

    const map = this.findMap();
    if (!map) return;

    map.addObjectToPendingUpdateList(this);
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetVisibilityOverrideType */
  getVisibilityOverrideType(): VisibilityDistanceType {
    return this._visibilityDistanceOverrideType;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::IsVisibilityOverridden */
  isVisibilityOverridden(): boolean {
    return this._visibilityDistanceOverrideType > VisibilityDistanceType.Normal;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::IsZoneWideVisible */
  isZoneWideVisible(): boolean {
    return this._visibilityDistanceOverrideType === VisibilityDistanceType.Infinite;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::IsFarVisible */
  isFarVisible(): boolean {
    return this._visibilityDistanceOverrideType === VisibilityDistanceType.Large || this._visibilityDistanceOverrideType === VisibilityDistanceType.Gigantic;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetVisibilityOverrideDistance */
  getVisibilityOverrideDistance(): number {
    if (this._visibilityDistanceOverrideType >= VisibilityDistanceType.Max) throw new Error("WorldObject::GetVisibilityOverrideDistance: bad type");
    return VisibilityDistances[this._visibilityDistanceOverrideType]!;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::SetVisibilityDistanceOverride */
  setVisibilityDistanceOverride(type: VisibilityDistanceType): void {
    if (type >= VisibilityDistanceType.Max) throw new Error("WorldObject::SetVisibilityDistanceOverride: bad type");

    if (type === this.getVisibilityOverrideType()) return;

    if (!this.isCreature() && !this.isGameObject() && !this.isDynamicObject()) return;

    // Important to remove from old visibility override containers first
    this.removeFromMapVisibilityOverrideContainers();

    // Always update _visibilityDistanceOverrideType, even when not in world
    this._visibilityDistanceOverrideType = type;

    // Finally, add to new visibility override containers
    this.addToMapVisibilityOverrideContainers();
  }

  /** @ac game/Entities/Object/Object.h WorldObject::IsInWintergrasp */
  isInWintergrasp(): boolean {
    return (
      this.getMapId() === MAP_NORTHREND &&
      this.getPositionX() > 3733.33331 &&
      this.getPositionX() < 5866.66663 &&
      this.getPositionY() > 1599.99999 &&
      this.getPositionY() < 4799.99997
    );
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetTransport (transports are not ported: null) */
  getTransport(): WorldObject | null {
    return this.m_transport;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetTransOffsetX */
  getTransOffsetX(): number {
    return this.m_movementInfo.transport.pos.getPositionX();
  }
  /** @ac game/Entities/Object/Object.h WorldObject::GetTransOffsetY */
  getTransOffsetY(): number {
    return this.m_movementInfo.transport.pos.getPositionY();
  }
  /** @ac game/Entities/Object/Object.h WorldObject::GetTransOffsetZ */
  getTransOffsetZ(): number {
    return this.m_movementInfo.transport.pos.getPositionZ();
  }
  /** @ac game/Entities/Object/Object.h WorldObject::GetTransOffsetO */
  getTransOffsetO(): number {
    return this.m_movementInfo.transport.pos.getOrientation();
  }
  /** @ac game/Entities/Object/Object.h WorldObject::GetTransTime */
  getTransTime(): number {
    return this.m_movementInfo.transport.time;
  }
  /** @ac game/Entities/Object/Object.h WorldObject::GetTransSeat */
  getTransSeat(): number {
    return this.m_movementInfo.transport.seat;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetTransGUID */
  getTransGUID(): bigint {
    const transport = this.getTransport();
    if (transport) return transport.getGUID();

    return ObjectGuid.Empty;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::SetTransport */
  setTransport(t: WorldObject | null): void {
    this.m_transport = t;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetStationaryX */
  getStationaryX(): number {
    return this.getPositionX();
  }
  /** @ac game/Entities/Object/Object.h WorldObject::GetStationaryY */
  getStationaryY(): number {
    return this.getPositionY();
  }
  /** @ac game/Entities/Object/Object.h WorldObject::GetStationaryZ */
  getStationaryZ(): number {
    return this.getPositionZ();
  }
  /** @ac game/Entities/Object/Object.h WorldObject::GetStationaryO */
  getStationaryO(): number {
    return this.getOrientation();
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetMapWaterOrGroundLevel (`(Position)` or `(x, y, z)`; `ground` is the `float*`) */
  getMapWaterOrGroundLevel(xOrPos: number | PositionLike, yOrGround?: number | FloatRef | null, z?: number, ground: FloatRef | null = null): number {
    if (typeof xOrPos !== "number") {
      return this.getMapWaterOrGroundLevel(xOrPos.getPositionX(), xOrPos.getPositionY(), xOrPos.getPositionZ(), (yOrGround as FloatRef | null | undefined) ?? null);
    }
    const unit = this.isUnit() ? this.toUnit() : null;
    return this.getMap().getWaterOrGroundLevel(
      this.getPhaseMask(),
      xOrPos,
      yOrGround as number,
      z ?? 0,
      ground,
      unit ? !unit.hasWaterWalkAura() : false,
      Math.max(this.getCollisionHeight(), Z_OFFSET_FIND_HEIGHT),
    );
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetMapHeight */
  getMapHeight(x: number, y: number, z: number, vmap = true, distanceToSearch = 50.0): number {
    if (z !== MAX_HEIGHT) z += Math.max(this.getCollisionHeight(), Z_OFFSET_FIND_HEIGHT);

    return this.getMap().getHeight(this.getPhaseMask(), x, y, z, vmap, distanceToSearch);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetFloorZ */
  getFloorZ(): number {
    if (this._updatePositionData) this.updatePositionData();

    if (!this.isInWorld()) return this._floorZ;

    return Math.max(
      this._floorZ,
      this.getMap().getGameObjectFloor(this.getPhaseMask(), this.getPositionX(), this.getPositionY(), this.getPositionZ() + Math.max(this.getCollisionHeight(), Z_OFFSET_FIND_HEIGHT)),
    );
  }

  /**
   * @ac game/Entities/Object/Object.cpp WorldObject::GetMinHeightInWater
   * Get the minimum height of a object that should be in water to start floating/swim
   */
  getMinHeightInWater(): number {
    // have a fun with Archimedes' formula
    const height = this.getCollisionHeight();
    const width = this.getCollisionWidth();
    const weight = getWeight(height, width, 1040); // avg human specific weight
    const heightOutOfWater = getOutOfWater(width, weight, 10202) * 4.0; // avg human density
    const heightInWater = height - heightOutOfWater;
    return height > heightInWater ? heightInWater : height - height / 3;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetCollisionHeight */
  getCollisionHeight(): number {
    return 0.0;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetCollisionWidth */
  getCollisionWidth(): number {
    return this.getObjectSize();
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetCollisionRadius */
  getCollisionRadius(): number {
    return this.getObjectSize() / 2;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::AddAllowedLooter */
  addAllowedLooter(guid: bigint): void {
    this._allowedLooters.add(guid);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::SetAllowedLooters */
  setAllowedLooters(looters: Iterable<bigint>): void {
    this._allowedLooters.clear();
    for (const guid of looters) this._allowedLooters.add(guid);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::ResetAllowedLooters */
  resetAllowedLooters(): void {
    this._allowedLooters.clear();
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::HasAllowedLooter */
  hasAllowedLooter(guid: bigint): boolean {
    if (this._allowedLooters.size === 0) return true;

    return this._allowedLooters.has(guid);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetAllowedLooters */
  getAllowedLooters(): ReadonlySet<bigint> {
    return this._allowedLooters;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::RemoveAllowedLooter */
  removeAllowedLooter(guid: bigint): void {
    this._allowedLooters.delete(guid);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::IsUpdateNeeded */
  isUpdateNeeded(): boolean {
    if (this.isActiveObject()) return true;

    return false;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::CanBeAddedToMapUpdateList */
  canBeAddedToMapUpdateList(): boolean {
    switch (this.getTypeId()) {
      case TYPEID_UNIT:
        return this.isCreature();
      case TYPEID_DYNAMICOBJECT:
      case TYPEID_GAMEOBJECT:
        return true;
      default:
        return false;
    }
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetObjectVisibilityContainer */
  getObjectVisibilityContainer(): ObjectVisibilityContainer {
    return this._objectVisibilityContainer;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetOwnerGUID */
  getOwnerGUID(): bigint {
    return ObjectGuid.Empty;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::GetCharmerOrOwnerGUID */
  getCharmerOrOwnerGUID(): bigint {
    return this.getOwnerGUID();
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::ProcessPositionDataChanged */
  protected processPositionDataChanged(data: PositionFullTerrainStatusLike): void {
    const oldZoneId = this._zoneId;

    this._zoneId = this._areaId = data.areaId;

    const area = sAreaTableStore.lookupEntry(this._areaId);
    if (area && area.zone) this._zoneId = area.zone;

    this._outdoors = data.outdoors;
    this._floorZ = data.floorZ;
    this._liquidData = data.liquidInfo;

    // Has zone ID changed?
    if (oldZoneId !== this._zoneId) {
      // If so, check if we are far visibility overridden object and refresh maps if needed.
      if (this.isZoneWideVisible()) {
        this.getMap().removeWorldObjectFromZoneWideVisibleMap(oldZoneId, this);
        this.getMap().addWorldObjectToZoneWideVisibleMap(this._zoneId, this);
      }
    }
  }

  /** @ac game/Entities/Object/Object.h WorldObject::SetLocationMapId (use them ONLY in LoadFromDB()/Create() funcs and nowhere else!) */
  protected setLocationMapId(mapId: number): void {
    this.m_mapId = mapId;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::SetLocationInstanceId */
  protected setLocationInstanceId(instanceId: number): void {
    this.m_InstanceId = instanceId;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::IsNeverVisible */
  isNeverVisible(): boolean {
    return !this.isInWorld();
  }

  /** @ac game/Entities/Object/Object.h WorldObject::IsAlwaysVisibleFor */
  isAlwaysVisibleFor(_seer: WorldObject): boolean {
    return false;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::IsInvisibleDueToDespawn */
  isInvisibleDueToDespawn(): boolean {
    return false;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::IsAlwaysDetectableFor (difference from IsAlwaysVisibleFor: 1. after distance check; 2. use owner or charmer as seer) */
  isAlwaysDetectableFor(_seer: WorldObject): boolean {
    return false;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::_IsWithinDist */
  protected _IsWithinDist(obj: WorldObject, dist2compare: number, is3D: boolean, incOwnRadius = true, incTargetRadius = true): boolean {
    let maxdist = dist2compare;
    if (incOwnRadius) maxdist += this.getObjectSize();

    if (incTargetRadius) maxdist += obj.getObjectSize();

    const transport = this.m_transport;
    const objTransport = obj.getTransport();
    if (transport && objTransport && objTransport.getGUID() === transport.getGUID()) {
      const dtx = this.m_movementInfo.transport.pos.getPositionX() - obj.m_movementInfo.transport.pos.getPositionX();
      const dty = this.m_movementInfo.transport.pos.getPositionY() - obj.m_movementInfo.transport.pos.getPositionY();
      let disttsq = dtx * dtx + dty * dty;
      if (is3D) {
        const dtz = this.m_movementInfo.transport.pos.getPositionZ() - obj.m_movementInfo.transport.pos.getPositionZ();
        disttsq += dtz * dtz;
      }
      return disttsq < maxdist * maxdist;
    }

    const dx = this.getPositionX() - obj.getPositionX();
    const dy = this.getPositionY() - obj.getPositionY();
    let distsq = dx * dx + dy * dy;
    if (is3D) {
      const dz = this.getPositionZ() - obj.getPositionZ();
      distsq += dz * dz;
    }

    return distsq < maxdist * maxdist;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::RemoveFromMapVisibilityOverrideContainers */
  private removeFromMapVisibilityOverrideContainers(): void {
    if (!this.isVisibilityOverridden()) return;

    if (!this.isInWorld()) return;

    if (this.isFarVisible()) this.getMap().removeWorldObjectFromFarVisibleMap(this);
    else if (this.isZoneWideVisible()) this.getMap().removeWorldObjectFromZoneWideVisibleMap(this._zoneId, this);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::AddToMapVisibilityOverrideContainers */
  private addToMapVisibilityOverrideContainers(): void {
    if (!this.isVisibilityOverridden()) return;

    if (!this.isInWorld()) return;

    if (this.isFarVisible()) this.getMap().addWorldObjectToFarVisibleMap(this);
    else if (this.isZoneWideVisible()) this.getMap().addWorldObjectToZoneWideVisibleMap(this._zoneId, this);
  }

  // ---------------------------------------------------------------- GridObject<T>

  /** @ac game/Entities/Object/Object.h GridObject::IsInGrid */
  isInGrid(): boolean {
    return this._gridRef.isValid();
  }

  /** @ac game/Entities/Object/Object.h GridObject::AddToGrid */
  addToGrid(m: GridRefMgr<WorldObject>): void {
    if (this.isInGrid()) throw new Error("GridObject::AddToGrid: already in grid");
    this._gridRef.link(m, this);
  }

  /** @ac game/Entities/Object/Object.h GridObject::RemoveFromGrid */
  removeFromGrid(): void {
    if (!this.isInGrid()) throw new Error("GridObject::RemoveFromGrid: not in grid");
    this._gridRef.unlink();
  }

  // ---------------------------------------------------------------- MovableMapObject

  /** @ac game/Entities/Object/Object.h MovableMapObject::GetCurrentCell */
  getCurrentCell(): Cell {
    return this._currentCell;
  }

  /** @ac game/Entities/Object/Object.h MovableMapObject::SetCurrentCell */
  setCurrentCell(cell: Cell): void {
    this._currentCell = new Cell(cell);
  }

  // ---------------------------------------------------------------- UpdatableMapObject

  /** @ac game/Entities/Object/Object.h UpdatableMapObject::SetMapUpdateListOffset */
  setMapUpdateListOffset(offset: number): void {
    if (this._mapUpdateState !== UpdateState.Updating) throw new Error("Attempted to set update list offset when object is not in map update list");
    this._mapUpdateListOffset = offset;
  }

  /** @ac game/Entities/Object/Object.h UpdatableMapObject::GetMapUpdateListOffset */
  getMapUpdateListOffset(): number {
    if (this._mapUpdateState !== UpdateState.Updating) throw new Error("Attempted to get update list offset when object is not in map update list");
    return this._mapUpdateListOffset;
  }

  /** @ac game/Entities/Object/Object.h UpdatableMapObject::SetUpdateState */
  setUpdateState(state: UpdateState): void {
    this._mapUpdateState = state;
  }

  /** @ac game/Entities/Object/Object.h UpdatableMapObject::GetUpdateState */
  getUpdateState(): UpdateState {
    return this._mapUpdateState;
  }
}

/** @ac game/Entities/Object/Object.h Acore::ObjectDistanceOrderPred (binary predicate to sort WorldObjects based on the distance to a reference WorldObject) */
export function ObjectDistanceOrderPred(pRefObj: WorldObject, ascending = true): (pLeft: WorldObject, pRight: WorldObject) => number {
  return (pLeft, pRight) => {
    const less = ascending ? pRefObj.getDistanceOrder(pLeft, pRight) : !pRefObj.getDistanceOrder(pLeft, pRight);
    if (less) return -1;
    const greater = ascending ? pRefObj.getDistanceOrder(pRight, pLeft) : !pRefObj.getDistanceOrder(pRight, pLeft);
    return greater ? 1 : 0;
  };
}

/** @ac common/Utilities/Geometry.h getCircleAreaByRadius */
function getCircleAreaByRadius(radius: number): number {
  return radius * radius * M_PI;
}

/** @ac common/Utilities/Geometry.h getCylinderVolume */
function getCylinderVolume(height: number, radius: number): number {
  return height * getCircleAreaByRadius(radius);
}

/** @ac common/Utilities/Physics.h getWeight */
function getWeight(height: number, width: number, specificWeight: number): number {
  const volume = getCylinderVolume(height, width / 2.0);
  return volume * specificWeight;
}

/** @ac common/Utilities/Physics.h getOutOfWater */
function getOutOfWater(width: number, weight: number, density: number): number {
  const baseArea = getCircleAreaByRadius(width / 2.0);
  return weight / (baseArea * density);
}

/** `SPELL_AURA_DETECT_STEALTH` (`SpellAuraDefines.h`) */
const SPELL_AURA_DETECT_STEALTH = 228;

void log;

/**
 * The rest of `Object.cpp` belongs to other topics (`docs/maps-port.md`: this file ports `Position` and the map, phase,
 * zone, and visibility parts of `WorldObject`):
 * @ac-skip Object::BuildMovementUpdate, Object::BuildMovementUpdateBlock, Object::BuildValuesUpdate,
 *   Object::BuildValuesUpdateBlockForPlayer, Object::BuildFieldsUpdate, Object::SendUpdateToPlayer,
 *   Object::ClearUpdateMask, Object::ForceValuesUpdateAtIndex, Object::AddToObjectUpdateIfNeeded, Object::_ConcatFields,
 *   Object::_LoadIntoDataField, WorldObject::BuildUpdate, MovementInfo::OutDebug:
 *   update blocks and change masks are the Updates topic (`Object.createUpdateBlockBuilder` bridges to the existing builders).
 * @ac-skip WorldObject::CastSpell, WorldObject::SpellHitResult, WorldObject::MagicSpellHitResult,
 *   WorldObject::ModSpellCastTime, WorldObject::GetSpellMaxRangeForTarget, WorldObject::GetSpellMinRangeForTarget,
 *   WorldObject::GetSpellModOwner, WorldObject::GetMagicHitRedirectTarget, WorldObject::GetMeleeHitRedirectTarget,
 *   WorldObject::SendSpellMiss, WorldObject::SendSpellNonMeleeDamageLog: the Spells topic (`src/spells/*` today).
 * @ac-skip WorldObject::GetFactionTemplateEntry, WorldObject::GetReactionTo, WorldObject::IsHostileTo,
 *   WorldObject::IsFriendlyTo, WorldObject::IsValidAttackTarget, WorldObject::IsValidAssistTarget: factions and combat
 *   targeting need `Unit` (`src/combat/*` today).
 * @ac-skip WorldObject::SummonCreature, WorldObject::SummonCreatureGroup, WorldObject::SummonGameObject,
 *   WorldObject::SummonGameObjectGroup, WorldObject::SummonTrigger: summons need `TempSummon` and `Map::SummonCreature`.
 * @ac-skip WorldObject::GetOwnerUnit, WorldObject::GetCharmerOrOwnerUnit, WorldObject::GetCharmerOrOwnerOrSelfUnit,
 *   WorldObject::GetCharmerOrOwnerPlayerOrPlayerItself, WorldObject::GetAffectingPlayer: need `ObjectAccessor::GetUnit`
 *   and the `Unit` class.
 * @ac-skip Object::~Object, WorldObject::~WorldObject: no destructors; their `sScriptMgr` hooks are not ported.
 */
