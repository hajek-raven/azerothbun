/**
 * @ac game/Entities/DynamicObject/DynamicObject.h
 * @ac game/Entities/DynamicObject/DynamicObject.cpp
 *
 * A spell's area object (area auras, far sight focus) as a map object: identity, caster binding, duration, viewpoint,
 * and map membership. `Aura` belongs to the Spells topic; the aura and the caster's `Unit` side are the structural
 * interfaces below.
 */
import {
  DYNAMICOBJECT_BYTES,
  DYNAMICOBJECT_CASTER,
  DYNAMICOBJECT_CASTTIME,
  DYNAMICOBJECT_END,
  DYNAMICOBJECT_RADIUS,
  DYNAMICOBJECT_SPELLID,
} from "../../../gen/UpdateFields.gen.ts";
import { logError } from "../../../log.ts";
import type { UnitLike } from "../../Grids/GridPlayer.ts";
import type { MapLike } from "../../Grids/MapLike.ts";
import { getGameTimeMS } from "../../time/game-time.ts";
import { mapStores } from "../Creature/Creature.ts";
import { WorldObject } from "../Object/Object.ts";
import { HighGuid, ObjectGuid, TYPEID_DYNAMICOBJECT, TYPEMASK_DYNAMICOBJECT } from "../Object/ObjectGuid.ts";
import type { PositionLike } from "../Object/Position.ts";

/** @ac game/Entities/DynamicObject/DynamicObject.h DynamicObjectType */
export const DYNAMIC_OBJECT_PORTAL = 0x0; // unused
export const DYNAMIC_OBJECT_AREA_SPELL = 0x1;
export const DYNAMIC_OBJECT_FARSIGHT_FOCUS = 0x2;
export type DynamicObjectType = typeof DYNAMIC_OBJECT_PORTAL | typeof DYNAMIC_OBJECT_AREA_SPELL | typeof DYNAMIC_OBJECT_FARSIGHT_FOCUS;

/** @ac game/Spells/Auras/SpellAuraDefines.h AuraRemoveMode::AURA_REMOVE_BY_DEFAULT */
const AURA_REMOVE_BY_DEFAULT = 1;

/** @ac game/Spells/Auras/SpellAuras.h Aura (the members a dynamic object calls) */
export interface DynObjAuraLike {
  /** @ac game/Spells/Auras/SpellAuras.h Aura::IsRemoved */
  IsRemoved(): boolean;
  /** @ac game/Spells/Auras/SpellAuras.h Aura::IsExpired */
  IsExpired(): boolean;
  /** @ac game/Spells/Auras/SpellAuras.cpp Aura::UpdateOwner */
  UpdateOwner(diff: number, owner: WorldObject): void;
  /** @ac game/Spells/Auras/SpellAuras.h Aura::GetDuration */
  GetDuration(): number;
  /** @ac game/Spells/Auras/SpellAuras.cpp Aura::SetDuration */
  SetDuration(duration: number): void;
  /** @ac game/Spells/Auras/SpellAuras.cpp Aura::_Remove */
  _Remove(removeMode: number): void;
}

/** @ac game/Entities/Unit/Unit.h Unit (the caster members a dynamic object calls; all optional until `Unit` is ported) */
export interface DynObjCasterLike extends UnitLike {
  /** @ac game/Entities/Unit/Unit.h Unit::GetFaction */
  getFaction?(): number;
  /** @ac game/Entities/Unit/Unit.cpp Unit::_RegisterDynObject */
  _RegisterDynObject?(dynObj: DynamicObject): void;
  /** @ac game/Entities/Unit/Unit.cpp Unit::_UnregisterDynObject */
  _UnregisterDynObject?(dynObj: DynamicObject): void;
  /** @ac game/Entities/Player/Player.cpp Player::SetViewpoint */
  setViewpoint?(target: WorldObject, apply: boolean): void;
  /** @ac game/Entities/Player/Player.cpp Player::UpdateVisibilityForPlayer */
  updateVisibilityForPlayer?(): void;
  /** `ObjectAccessor::GetUnit(*caster, caster->GetGuidValue(PLAYER_FARSIGHT))` */
  getFarsightUnit?(): WorldObject | null;
  /** `ObjectAccessor::GetUnit(*caster, guid)` */
  getUnitByGuid?(guid: bigint): WorldObject | null;
}

/** @ac game/Entities/DynamicObject/DynamicObject.h DynamicObject */
export class DynamicObject extends WorldObject {
  protected _aura: DynObjAuraLike | null = null;
  protected _removedAura: DynObjAuraLike | null = null;
  protected _caster: DynObjCasterLike | null = null;
  /** for non-aura dynobjects */
  protected _duration = 0;
  protected _isViewpoint = false;
  protected _updateViewerVisibilityTimer = 0;
  protected _oldFarsightGUID = 0n;
  /** The caster `CreateDynamicObject` was given; `BindToCaster` falls back to it when the map cannot look units up. */
  private _createCaster: DynObjCasterLike | null = null;

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::DynamicObject */
  constructor() {
    super();
    this.m_objectType |= TYPEMASK_DYNAMICOBJECT;
    this.m_objectTypeId = TYPEID_DYNAMICOBJECT;
    // @ac-skip Updates: m_updateFlag (UPDATEFLAG_LOWGUID | UPDATEFLAG_STATIONARY_POSITION | UPDATEFLAG_POSITION)
    this.m_valuesCount = DYNAMICOBJECT_END;
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::CleanupsBeforeDelete (@ac-skip Transports: `RemovePassenger`) */
  override cleanupsBeforeDelete(finalCleanup = true): void {
    super.cleanupsBeforeDelete(finalCleanup);
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::AddToWorld */
  override addToWorld(): void {
    ///- Register the dynamicObject for guid lookup and for caster
    if (!this.isInWorld()) {
      mapStores(this.getMap()).getObjectsStore?.().insert(this.getGUID(), this);

      super.addToWorld();

      this.bindToCaster();
    }
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::RemoveFromWorld (@ac-skip Transports: `RemovePassenger`) */
  override removeFromWorld(): void {
    ///- Remove the dynamicObject from the accessor and from all lists of objects in world
    if (this.isInWorld()) {
      if (this._isViewpoint) this.removeCasterViewpoint();

      if (this._aura) this.removeAura();

      // dynobj could get removed in Aura::RemoveAura
      if (!this.isInWorld()) return;

      this.unbindFromCaster();

      super.removeFromWorld();

      mapStores(this.getMap()).getObjectsStore?.().remove(this.getGUID());
    }
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::CreateDynamicObject */
  createDynamicObject(guidlow: number, caster: DynObjCasterLike, spellId: number, pos: PositionLike, radius: number, type: DynamicObjectType): boolean {
    this.setMap(caster.getMap());
    this.relocate(pos);
    if (!this.isPositionValid()) {
      logError("spell", `DynamicObject (spell ${spellId}) not created. Suggested coordinates isn't valid (X: ${this.getPositionX()} Y: ${this.getPositionY()})`);
      return false;
    }

    this._CreateWorldObject(guidlow, HighGuid.DynamicObject, caster.getPhaseMask());

    this.updatePositionData();

    this.setEntry(spellId);
    this.setObjectScale(1);
    this.setGuidValue(DYNAMICOBJECT_CASTER, caster.getGUID());
    this._createCaster = caster;

    // The lower word of DYNAMICOBJECT_BYTES must be 0x0001. This value means that the visual radius will be overriden
    // by client for most of the "ground patch" visual effect spells and a few "skyfall" ones like Hurricane.
    this.setByteValue(DYNAMICOBJECT_BYTES, 0, type);
    this.setUInt32Value(DYNAMICOBJECT_SPELLID, spellId);
    this.setFloatValue(DYNAMICOBJECT_RADIUS, radius);
    this.setUInt32Value(DYNAMICOBJECT_CASTTIME, getGameTimeMS() >>> 0);

    const add = mapStores(this.getMap()).addToMap;
    if (!add || !add.call(this.getMap(), this)) {
      // Returning false will cause the object to be deleted - remove from transport
      return false;
    }

    return true;
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::Update (@ac-skip Scripts: `OnDynamicObjectUpdate`) */
  override update(p_time: number): void {
    // caster has to be always available and in the same map
    if (!this._caster) throw new Error("DynamicObject::Update: ASSERT(_caster)");

    let expired = false;

    if (this._aura) {
      if (!this._aura.IsRemoved()) this._aura.UpdateOwner(p_time, this);

      // _aura may be set to null in Aura::UpdateOwner call
      if (this._aura && (this._aura.IsRemoved() || this._aura.IsExpired())) expired = true;
    } else {
      if (this.getDuration() > p_time) this._duration -= p_time;
      else expired = true;
    }

    if (expired) {
      this.remove();
    } else if (this._updateViewerVisibilityTimer) {
      if (this._updateViewerVisibilityTimer <= p_time) {
        this._updateViewerVisibilityTimer = 0;

        if (this._caster.isPlayer()) this._caster.updateVisibilityForPlayer?.();
      } else {
        this._updateViewerVisibilityTimer -= p_time;
      }
    }
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::Remove */
  remove(): void {
    if (this.isInWorld()) {
      this.sendObjectDeSpawnAnim(this.getGUID());
      this.removeFromWorld();
      this.addObjectToRemoveList();
    }
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::GetDuration */
  getDuration(): number {
    if (!this._aura) return this._duration;
    return this._aura.GetDuration();
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::SetDuration */
  setDuration(newDuration: number): void {
    if (!this._aura) this._duration = newDuration;
    else this._aura.SetDuration(newDuration);
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::Delay */
  delay(delaytime: number): void {
    this.setDuration(this.getDuration() - delaytime);
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::SetAura */
  setAura(aura: DynObjAuraLike): void {
    if (this._aura || !aura) throw new Error("DynamicObject::SetAura: ASSERT(!_aura && aura)");
    this._aura = aura;
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::RemoveAura */
  removeAura(): void {
    if (!this._aura || this._removedAura) throw new Error("DynamicObject::RemoveAura: ASSERT(_aura && !_removedAura)");
    this._removedAura = this._aura;
    this._aura = null;
    if (!this._removedAura.IsRemoved()) this._removedAura._Remove(AURA_REMOVE_BY_DEFAULT);
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::SetCasterViewpoint */
  setCasterViewpoint(updateViewerVisibility: boolean): void {
    const caster = this._caster;
    if (caster?.isPlayer()) {
      // Remove old farsight viewpoint
      const farsightObject = caster.getFarsightUnit?.() ?? null;
      if (farsightObject) {
        this._oldFarsightGUID = farsightObject.getGUID();
        caster.setViewpoint?.(farsightObject, false);
      }

      caster.setViewpoint?.(this, true);
      this._isViewpoint = true;
    }

    this._updateViewerVisibilityTimer = updateViewerVisibility ? 100 : 0;
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::RemoveCasterViewpoint */
  removeCasterViewpoint(): void {
    const caster = this._caster;
    if (caster?.isPlayer()) {
      caster.setViewpoint?.(this, false);
      this._isViewpoint = false;

      // Restore prev farsight viewpoint
      const farsightObject = this._oldFarsightGUID ? (caster.getUnitByGuid?.(this._oldFarsightGUID) ?? null) : null;
      if (farsightObject) caster.setViewpoint?.(farsightObject, true);
      this._oldFarsightGUID = ObjectGuid.Empty;
    }
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::GetFaction */
  getFaction(): number {
    if (!this._caster) throw new Error("DynamicObject::GetFaction: ASSERT(_caster)");
    return this._caster.getFaction?.() ?? 0;
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.h DynamicObject::GetCaster */
  getCaster(): DynObjCasterLike | null {
    return this._caster;
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::BindToCaster (`ObjectAccessor::GetUnit` through the map) */
  bindToCaster(): void {
    if (this._caster) throw new Error("DynamicObject::BindToCaster: ASSERT(!_caster)");
    const map = this.getMap() as MapLike & { getUnit?(guid: bigint): DynObjCasterLike | null };
    this._caster = map.getUnit?.(this.getCasterGUID()) ?? this._createCaster;
    if (!this._caster) throw new Error("DynamicObject::BindToCaster: ASSERT(_caster)");
    if (this._caster.getMap() !== this.getMap()) throw new Error("DynamicObject::BindToCaster: ASSERT(_caster->GetMap() == GetMap())");
    this._caster._RegisterDynObject?.(this);
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::UnbindFromCaster */
  unbindFromCaster(): void {
    if (!this._caster) throw new Error("DynamicObject::UnbindFromCaster: ASSERT(_caster)");
    this._caster._UnregisterDynObject?.(this);
    this._caster = null;
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.h DynamicObject::GetSpellId */
  getSpellId(): number {
    return this.getUInt32Value(DYNAMICOBJECT_SPELLID);
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.h DynamicObject::GetOwnerGUID */
  override getOwnerGUID(): bigint {
    return this.getCasterGUID();
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.h DynamicObject::GetCasterGUID */
  getCasterGUID(): bigint {
    return this.m_uint32Values ? this.getGuidValue(DYNAMICOBJECT_CASTER) : 0n;
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.h DynamicObject::GetRadius */
  getRadius(): number {
    return this.getFloatValue(DYNAMICOBJECT_RADIUS);
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.h DynamicObject::IsViewpoint */
  isViewpoint(): boolean {
    return this._isViewpoint;
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.h DynamicObject::GetOldFarsightGUID */
  getOldFarsightGUID(): bigint {
    return this._oldFarsightGUID;
  }

  /** @ac game/Entities/DynamicObject/DynamicObject.cpp DynamicObject::IsUpdateNeeded */
  override isUpdateNeeded(): boolean {
    if (this.getByteValue(DYNAMICOBJECT_BYTES, 0) === DYNAMIC_OBJECT_AREA_SPELL) return true;

    return super.isUpdateNeeded();
  }
}
