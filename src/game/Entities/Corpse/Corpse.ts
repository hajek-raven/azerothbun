/**
 * @ac game/Entities/Corpse/Corpse.h
 * @ac game/Entities/Corpse/Corpse.cpp
 *
 * A player's corpse or bones as a map object: identity, owner, cell, map membership, and the `corpse` row it is saved
 * to and loaded from (`CHAR_SEL_CORPSES` / `CHAR_INS_CORPSE` / `CHAR_DEL_CORPSE`).
 *
 * @ac-skip Loot: `loot` / `lootRecipient` (insignia looting in battlegrounds); @ac-skip Updates: `BuildValuesUpdate`
 */
import type { corpse } from "../../../database/schema/characters.ts";
import { executeStatementAsync } from "../../../database/database.ts";
import { CharacterDatabase } from "../../../database/DatabaseEnv.ts";
import type { Row } from "../../../database/world-tables.ts";
import { CHAR_DEL_CORPSE, CHAR_INS_CORPSE } from "../../../gen/CharacterDatabase.gen.ts";
import {
  CORPSE_END,
  CORPSE_FIELD_BYTES_1,
  CORPSE_FIELD_BYTES_2,
  CORPSE_FIELD_DISPLAY_ID,
  CORPSE_FIELD_DYNAMIC_FLAGS,
  CORPSE_FIELD_FLAGS,
  CORPSE_FIELD_GUILD,
  CORPSE_FIELD_ITEM,
  CORPSE_FIELD_OWNER,
} from "../../../gen/UpdateFields.gen.ts";
import { logError } from "../../../log.ts";
import { sCharacterCache } from "../../Cache/CharacterCache.ts";
import { sChrRacesStore } from "../../DataStores/DBCStores.ts";
import { ComputeCellCoord, type CellCoord } from "../../Grids/GridDefines.ts";
import { getGameTime } from "../../time/game-time.ts";
import { mapStores } from "../Creature/Creature.ts";
import { WorldObject } from "../Object/Object.ts";
import { HighGuid, ObjectGuid, TYPEID_CORPSE, TYPEMASK_CORPSE } from "../Object/ObjectGuid.ts";

/** @ac game/Entities/Corpse/Corpse.h CorpseType */
export const CORPSE_BONES = 0;
export const CORPSE_RESURRECTABLE_PVE = 1;
export const CORPSE_RESURRECTABLE_PVP = 2;
export type CorpseType = typeof CORPSE_BONES | typeof CORPSE_RESURRECTABLE_PVE | typeof CORPSE_RESURRECTABLE_PVP;
/** @ac game/Entities/Corpse/Corpse.h MAX_CORPSE_TYPE */
export const MAX_CORPSE_TYPE = 3;

/** @ac game/Entities/Corpse/Corpse.h CORPSE_RECLAIM_RADIUS (Value equal client resurrection dialog show radius.) */
export const CORPSE_RECLAIM_RADIUS = 39;

/** @ac game/Entities/Corpse/Corpse.h CorpseFlags */
export const CORPSE_FLAG_NONE = 0x00;
export const CORPSE_FLAG_BONES = 0x01;
export const CORPSE_FLAG_UNK1 = 0x02;
export const CORPSE_FLAG_UNK2 = 0x04;
export const CORPSE_FLAG_HIDE_HELM = 0x08;
export const CORPSE_FLAG_HIDE_CLOAK = 0x10;
export const CORPSE_FLAG_LOOTABLE = 0x20;

/** @ac game/Entities/Item/ItemDefines.h EQUIPMENT_SLOT_END */
const EQUIPMENT_SLOT_END = 19;
/** @ac shared/SharedDefines.h MINUTE */
const MINUTE = 60;
/** @ac shared/SharedDefines.h DAY */
const DAY = 86400;

/** The player a corpse is created for (`Player*` in `Corpse::Create`). */
export interface CorpseOwnerLike {
  getGUID(): bigint;
  getName(): string;
  getPositionX(): number;
  getPositionY(): number;
  getPositionZ(): number;
  getOrientation(): number;
  getPhaseMask(): number;
}

/** @ac game/Entities/Corpse/Corpse.h Corpse */
export class Corpse extends WorldObject {
  private readonly m_type: CorpseType;
  private m_time: number;
  private _cellCoord: CellCoord;

  /** @ac game/Entities/Corpse/Corpse.cpp Corpse::Corpse */
  constructor(type: CorpseType = CORPSE_BONES) {
    super();
    this.m_type = type;
    this.m_objectType |= TYPEMASK_CORPSE;
    this.m_objectTypeId = TYPEID_CORPSE;
    // @ac-skip Updates: m_updateFlag (UPDATEFLAG_LOWGUID | UPDATEFLAG_STATIONARY_POSITION | UPDATEFLAG_POSITION)
    this.m_valuesCount = CORPSE_END;
    this.m_time = getGameTime();
    this._cellCoord = ComputeCellCoord(0, 0);
  }

  /** @ac game/Entities/Corpse/Corpse.cpp Corpse::AddToWorld (C++ calls `Object::AddToWorld`, not the `WorldObject` one) */
  override addToWorld(): void {
    ///- Register the corpse for guid lookup
    if (!this.isInWorld()) mapStores(this.getMap()).getObjectsStore?.().insert(this.getGUID(), this);

    this.objectAddToWorld();
  }

  /** @ac game/Entities/Object/Object.cpp Object::AddToWorld (the base `Corpse::AddToWorld` calls) */
  private objectAddToWorld(): void {
    // WorldObject::AddToWorld also fills the zone and the update list; the corpse skips that like the C++ does.
    const objectAddToWorld = Object.getPrototypeOf(WorldObject.prototype).addToWorld as (this: WorldObject) => void;
    objectAddToWorld.call(this);
  }

  /** @ac game/Entities/Corpse/Corpse.cpp Corpse::RemoveFromWorld */
  override removeFromWorld(): void {
    ///- Remove the corpse from the accessor
    if (this.isInWorld()) mapStores(this.getMap()).getObjectsStore?.().remove(this.getGUID());

    super.removeFromWorld();
  }

  /** @ac game/Entities/Corpse/Corpse.cpp Corpse::GetFaction (inherit faction from player race) */
  getFaction(): number {
    const race = this.getByteValue(CORPSE_FIELD_BYTES_1, 1);
    const rEntry = sChrRacesStore.lookupEntry(race);
    return rEntry ? rEntry.FactionID : 0;
  }

  /** @ac game/Entities/Corpse/Corpse.cpp Corpse::Create (the `(guidlow)` and `(guidlow, Player* owner)` overloads) */
  create(guidlow: number, owner?: CorpseOwnerLike): boolean {
    if (!owner) {
      this._Create(guidlow, 0, HighGuid.Corpse);
      return true;
    }

    this.relocate(owner.getPositionX(), owner.getPositionY(), owner.getPositionZ(), owner.getOrientation());

    if (!this.isPositionValid()) {
      logError("world", `Corpse (guidlow ${guidlow}, owner ${owner.getName()}) not created. Suggested coordinates isn't valid (X: ${owner.getPositionX()} Y: ${owner.getPositionY()})`);
      return false;
    }

    this._CreateWorldObject(guidlow, HighGuid.Corpse, owner.getPhaseMask());

    this.setObjectScale(1);
    this.setGuidValue(CORPSE_FIELD_OWNER, owner.getGUID());

    this._cellCoord = ComputeCellCoord(this.getPositionX(), this.getPositionY());

    return true;
  }

  /** @ac game/Entities/Object/Object.cpp Object::_ConcatFields (`CORPSE_FIELD_ITEM`, `EQUIPMENT_SLOT_END`) */
  private concatItemFields(): string {
    const values: number[] = [];
    for (let index = 0; index < EQUIPMENT_SLOT_END; ++index) values.push(this.getUInt32Value(CORPSE_FIELD_ITEM + index));
    return values.map((value) => `${value} `).join("");
  }

  /**
   * @ac game/Entities/Corpse/Corpse.cpp Corpse::SaveToDB
   * prevent DB data inconsistence problems and duplicates: the delete and the insert go out in order on the single
   * `CharacterDatabase` connection (the C++ transaction).
   */
  saveToDB(): void {
    this.deleteFromDB();

    executeStatementAsync(
      CharacterDatabase(),
      CHAR_INS_CORPSE,
      ObjectGuid.GetCounter(this.getOwnerGUID()), // guid
      this.getPositionX(), // posX
      this.getPositionY(), // posY
      this.getPositionZ(), // posZ
      this.getOrientation(), // orientation
      this.getMapId(), // mapId
      this.getUInt32Value(CORPSE_FIELD_DISPLAY_ID), // displayId
      this.concatItemFields(), // itemCache
      this.getUInt32Value(CORPSE_FIELD_BYTES_1), // bytes1
      this.getUInt32Value(CORPSE_FIELD_BYTES_2), // bytes2
      this.getUInt32Value(CORPSE_FIELD_GUILD), // guildId
      this.getUInt32Value(CORPSE_FIELD_FLAGS), // flags
      this.getUInt32Value(CORPSE_FIELD_DYNAMIC_FLAGS), // dynFlags
      this.m_time >>> 0, // time
      this.getType(), // corpseType
      this.getInstanceId(), // instanceId
      this.getPhaseMask(), // phaseMask
    );
  }

  /** @ac game/Entities/Corpse/Corpse.cpp Corpse::DeleteFromDB (the member and the static `(ownerGuid, trans)` overloads) */
  deleteFromDB(ownerGuid: bigint = this.getOwnerGUID()): void {
    Corpse.deleteFromDB(ownerGuid);
  }

  /** @ac game/Entities/Corpse/Corpse.cpp Corpse::DeleteFromDB (static) */
  static deleteFromDB(ownerGuid: bigint): void {
    executeStatementAsync(CharacterDatabase(), CHAR_DEL_CORPSE, ObjectGuid.GetCounter(ownerGuid));
  }

  /**
   * @ac game/Entities/Corpse/Corpse.cpp Corpse::LoadCorpseFromDB
   * `fields` is a `CHAR_SEL_CORPSES` row (the `corpse` columns).
   */
  loadCorpseFromDB(guid: number, fields: Row<typeof corpse>): boolean {
    const ownerGuid = fields.guid;

    const posX = fields.posX;
    const posY = fields.posY;
    const posZ = fields.posZ;
    const o = fields.orientation;
    const mapId = fields.mapId;

    this._Create(guid, 0, HighGuid.Corpse);

    this.setObjectScale(1.0);
    this.setUInt32Value(CORPSE_FIELD_DISPLAY_ID, fields.displayId);

    if (!this.loadItemFields(fields.itemCache)) {
      logError(
        "world",
        `Corpse (${ObjectGuid.ToString(this.getGUID())}, owner: ${ObjectGuid.ToString(this.getOwnerGUID())}) is not created, given equipment info is not valid ('${fields.itemCache}')`,
      );
    }

    this.setUInt32Value(CORPSE_FIELD_BYTES_1, fields.bytes1);
    this.setUInt32Value(CORPSE_FIELD_BYTES_2, fields.bytes2);
    this.setUInt32Value(CORPSE_FIELD_GUILD, fields.guildId);
    this.setUInt32Value(CORPSE_FIELD_FLAGS, fields.flags);
    this.setUInt32Value(CORPSE_FIELD_DYNAMIC_FLAGS, fields.dynFlags);
    this.setGuidValue(CORPSE_FIELD_OWNER, ObjectGuid.Create(HighGuid.Player, ownerGuid));

    this.m_time = fields.time;

    const instanceId = fields.instanceId;
    const phaseMask = fields.phaseMask;

    // place
    this.setLocationInstanceId(instanceId);
    this.setLocationMapId(mapId);
    this.setPhaseMask(phaseMask, false);
    this.relocate(posX, posY, posZ, o);

    if (!this.isPositionValid()) {
      logError(
        "world",
        `Corpse ( ${ObjectGuid.ToString(this.getGUID())}, owner: ${ObjectGuid.ToString(this.getOwnerGUID())}) is not created, given coordinates are not valid (X: ${posX}, Y: ${posY}, Z: ${posZ})`,
      );
      return false;
    }

    this._cellCoord = ComputeCellCoord(this.getPositionX(), this.getPositionY());
    return true;
  }

  /** @ac game/Entities/Object/Object.cpp Object::_LoadIntoDataField (`CORPSE_FIELD_ITEM`, `EQUIPMENT_SLOT_END`) */
  private loadItemFields(data: string): boolean {
    if (data === "") return false;
    const tokens = data.split(" ").filter((token) => token !== "");
    if (tokens.length !== EQUIPMENT_SLOT_END) return false;
    for (let index = 0; index < EQUIPMENT_SLOT_END; ++index) {
      const value = Number(tokens[index]);
      if (!Number.isInteger(value)) return false;
      this.setUInt32Value(CORPSE_FIELD_ITEM + index, value >>> 0);
    }
    return true;
  }

  /** @ac game/Entities/Corpse/Corpse.h Corpse::GetOwnerGUID */
  override getOwnerGUID(): bigint {
    return this.m_uint32Values ? this.getGuidValue(CORPSE_FIELD_OWNER) : 0n;
  }

  /** @ac game/Entities/Corpse/Corpse.h Corpse::GetGhostTime */
  getGhostTime(): number {
    return this.m_time;
  }

  /** @ac game/Entities/Corpse/Corpse.cpp Corpse::ResetGhostTime */
  resetGhostTime(): void {
    this.m_time = getGameTime();
  }

  /** @ac game/Entities/Corpse/Corpse.h Corpse::GetType */
  getType(): CorpseType {
    return this.m_type;
  }

  /** @ac game/Entities/Corpse/Corpse.h Corpse::GetCellCoord */
  getCellCoord(): CellCoord {
    return this._cellCoord;
  }

  /** @ac game/Entities/Corpse/Corpse.h Corpse::SetCellCoord */
  setCellCoord(cellCoord: CellCoord): void {
    this._cellCoord = cellCoord;
  }

  /** @ac game/Entities/Corpse/Corpse.cpp Corpse::IsExpired */
  isExpired(t: number): boolean {
    // Deleted character
    if (!sCharacterCache.getCharacterCacheByGuid(ObjectGuid.GetCounter(this.getOwnerGUID()))) return true;

    if (this.m_type === CORPSE_BONES) return this.m_time < t - 60 * MINUTE;
    return this.m_time < t - 3 * DAY;
  }
}
