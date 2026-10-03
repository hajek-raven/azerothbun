/**
 * @ac game/Entities/GameObject/GameObject.h
 * @ac game/Entities/GameObject/GameObject.cpp
 *
 * The gameobject as a map object: identity (spawn id, entry, template), spawn data, map and grid membership, rotation,
 * respawn state, and visibility.
 *
 * Out of scope here (other topics, marked `@ac-skip <topic>` at the call sites): `Use` and the per-type behavior in
 * `Update` (GameObjects), loot (Loot), `CastSpell` and traps (Spells), the collision model (`m_model`, `EnableCollision`:
 * VMaps `GameObjectModel`, owned by the Collision stream), AI (`AIM_Initialize`), transports, destructible buildings,
 * rituals, script hooks, and `SaveToDB` / `DeleteFromDB` (World DB editing commands).
 */
import type { GameObjectTemplate } from "../../../data/world.ts";
import { gameobject_template } from "../../../database/schema/world.ts";
import {
  GAMEOBJECT_BYTES_1,
  GAMEOBJECT_DISPLAYID,
  GAMEOBJECT_DYNAMIC,
  GAMEOBJECT_END,
  GAMEOBJECT_FACTION,
  GAMEOBJECT_FLAGS,
  GAMEOBJECT_PARENTROTATION,
  OBJECT_FIELD_CREATED_BY,
} from "../../../gen/UpdateFields.gen.ts";
import { logError } from "../../../log.ts";
import { sGameObjectDisplayInfoStore } from "../../DataStores/DBCStores.ts";
import { sObjectMgr } from "../../Globals/ObjectMgr.ts";
import type { UnitLike } from "../../Grids/GridPlayer.ts";
import { IsValidMapCoord } from "../../Grids/GridDefines.ts";
import type { MapLike } from "../../Grids/MapLike.ts";
import {
  GO_STATE_ACTIVE,
  GO_STATE_ACTIVE_ALTERNATIVE,
  GO_STATE_READY,
  QuaternionDataFromEulerAnglesZYX,
  SPAWNGROUP_FLAG_COMPATIBILITY_MODE,
  type GameObjectData,
  type GameObjectTemplateAddon,
  type QuaternionData,
} from "../../Maps/SpawnData.ts";
import { urand } from "../../../common/random.ts";
import { getGameTime, getGameTimeMS } from "../../time/game-time.ts";
import { ServerConfig } from "../../world/world-config-data.ts";
import { sWorld } from "../../world/world.ts";
import { mapStores, multimapErasePair, multimapInsert } from "../Creature/Creature.ts";
import { INVISIBILITY_TRAP, STEALTH_TRAP, WorldObject } from "../Object/Object.ts";
import { VisibilityDistanceType } from "../Object/ObjectDefines.ts";
import { HighGuid, ObjectGuid, TYPEID_GAMEOBJECT, TYPEMASK_GAMEOBJECT } from "../Object/ObjectGuid.ts";
import { fuzzyEq, Position, type PositionLike } from "../Object/Position.ts";

export { GO_STATE_ACTIVE, GO_STATE_ACTIVE_ALTERNATIVE, GO_STATE_READY, MAX_GO_STATE } from "../../Maps/SpawnData.ts";

/** @ac shared/SharedDefines.h GameobjectTypes */
export const GAMEOBJECT_TYPE_DOOR = 0;
export const GAMEOBJECT_TYPE_BUTTON = 1;
export const GAMEOBJECT_TYPE_QUESTGIVER = 2;
export const GAMEOBJECT_TYPE_CHEST = 3;
export const GAMEOBJECT_TYPE_BINDER = 4;
export const GAMEOBJECT_TYPE_GENERIC = 5;
export const GAMEOBJECT_TYPE_TRAP = 6;
export const GAMEOBJECT_TYPE_CHAIR = 7;
export const GAMEOBJECT_TYPE_SPELL_FOCUS = 8;
export const GAMEOBJECT_TYPE_TEXT = 9;
export const GAMEOBJECT_TYPE_GOOBER = 10;
export const GAMEOBJECT_TYPE_TRANSPORT = 11;
export const GAMEOBJECT_TYPE_AREADAMAGE = 12;
export const GAMEOBJECT_TYPE_CAMERA = 13;
export const GAMEOBJECT_TYPE_MAP_OBJECT = 14;
export const GAMEOBJECT_TYPE_MO_TRANSPORT = 15;
export const GAMEOBJECT_TYPE_DUEL_ARBITER = 16;
export const GAMEOBJECT_TYPE_FISHINGNODE = 17;
export const GAMEOBJECT_TYPE_SUMMONING_RITUAL = 18;
export const GAMEOBJECT_TYPE_MAILBOX = 19;
export const GAMEOBJECT_TYPE_DO_NOT_USE = 20;
export const GAMEOBJECT_TYPE_GUARDPOST = 21;
export const GAMEOBJECT_TYPE_SPELLCASTER = 22;
export const GAMEOBJECT_TYPE_MEETINGSTONE = 23;
export const GAMEOBJECT_TYPE_FLAGSTAND = 24;
export const GAMEOBJECT_TYPE_FISHINGHOLE = 25;
export const GAMEOBJECT_TYPE_FLAGDROP = 26;
export const GAMEOBJECT_TYPE_MINI_GAME = 27;
export const GAMEOBJECT_TYPE_DO_NOT_USE_2 = 28;
export const GAMEOBJECT_TYPE_CAPTURE_POINT = 29;
export const GAMEOBJECT_TYPE_AURA_GENERATOR = 30;
export const GAMEOBJECT_TYPE_DUNGEON_DIFFICULTY = 31;
export const GAMEOBJECT_TYPE_BARBER_CHAIR = 32;
export const GAMEOBJECT_TYPE_DESTRUCTIBLE_BUILDING = 33;
export const GAMEOBJECT_TYPE_GUILD_BANK = 34;
export const GAMEOBJECT_TYPE_TRAPDOOR = 35;
/** sending to client this or greater value can crash client. */
export const MAX_GAMEOBJECT_TYPE = 36;

/** @ac shared/SharedDefines.h GameObjectFlags (the one read here) */
export const GO_FLAG_IN_USE = 0x00000001;
export const GO_FLAG_NODESPAWN = 0x00000020;

/** @ac game/Entities/GameObject/GameObject.h FISHING_BOBBER_READY_TIME */
export const FISHING_BOBBER_READY_TIME = 5;
/** @ac shared/SharedDefines.h DAY, MINUTE (seconds) */
const DAY = 86400;
const MINUTE = 60;

/** @ac game/Entities/GameObject/GameObject.h LootState */
export const GO_NOT_READY = 0;
export const GO_READY = 1; // can be ready but despawned, and then not possible activate until spawn
export const GO_ACTIVATED = 2;
export const GO_JUST_DEACTIVATED = 3;

/** `GameObjectTemplate` union member `data[index]` (the `uint32` fields are `Data0..23`). */
function goData(info: GameObjectTemplate, index: number): number {
  return info.data[index] ?? 0;
}

/** @ac game/Entities/GameObject/GameObjectData.h GameObjectTemplate::GetDespawnPossibility (despawn at targeting of cast?) */
export function GetDespawnPossibility(info: GameObjectTemplate): boolean {
  switch (info.type) {
    case GAMEOBJECT_TYPE_DOOR:
      return goData(info, 3) !== 0; // door.noDamageImmune
    case GAMEOBJECT_TYPE_BUTTON:
      return goData(info, 4) !== 0; // button.noDamageImmune
    case GAMEOBJECT_TYPE_QUESTGIVER:
      return goData(info, 5) !== 0; // questgiver.noDamageImmune
    case GAMEOBJECT_TYPE_GOOBER:
      return goData(info, 11) !== 0; // goober.noDamageImmune
    case GAMEOBJECT_TYPE_FLAGSTAND:
      return goData(info, 5) !== 0; // flagstand.noDamageImmune
    case GAMEOBJECT_TYPE_FLAGDROP:
      return goData(info, 3) !== 0; // flagdrop.noDamageImmune
    default:
      return true;
  }
}

/** @ac game/Entities/GameObject/GameObjectData.h GameObjectTemplate::IsDespawnAtAction */
export function IsDespawnAtAction(info: GameObjectTemplate): boolean {
  switch (info.type) {
    case GAMEOBJECT_TYPE_CHEST:
      return goData(info, 3) !== 0; // chest.consumable
    case GAMEOBJECT_TYPE_GOOBER:
      return goData(info, 5) !== 0; // goober.consumable
    default:
      return false;
  }
}

/** @ac game/Entities/GameObject/GameObjectData.h GameObjectTemplate::GetLinkedGameObjectEntry */
export function GetLinkedGameObjectEntry(info: GameObjectTemplate): number {
  switch (info.type) {
    case GAMEOBJECT_TYPE_BUTTON:
      return goData(info, 3); // button.linkedTrap
    case GAMEOBJECT_TYPE_CHEST:
      return goData(info, 7); // chest.linkedTrapId
    case GAMEOBJECT_TYPE_SPELL_FOCUS:
      return goData(info, 2); // spellFocus.linkedTrapId
    case GAMEOBJECT_TYPE_GOOBER:
      return goData(info, 12); // goober.linkedTrapId
    default:
      return 0;
  }
}

/** @ac game/Entities/GameObject/GameObjectData.h GameObjectTemplate::IsLargeGameObject */
export function IsLargeGameObject(info: GameObjectTemplate): boolean {
  switch (info.type) {
    case GAMEOBJECT_TYPE_BUTTON:
      return goData(info, 5) !== 0; // button.large
    case GAMEOBJECT_TYPE_QUESTGIVER:
      return goData(info, 9) !== 0; // questgiver.large
    case GAMEOBJECT_TYPE_GENERIC:
      return goData(info, 3) !== 0; // _generic.large
    case GAMEOBJECT_TYPE_TRAP:
      return goData(info, 10) !== 0; // trap.large
    case GAMEOBJECT_TYPE_SPELL_FOCUS:
      return goData(info, 5) !== 0; // spellFocus.large
    case GAMEOBJECT_TYPE_GOOBER:
      return goData(info, 13) !== 0; // goober.large
    case GAMEOBJECT_TYPE_SPELLCASTER:
      return goData(info, 4) !== 0; // spellcaster.large
    case GAMEOBJECT_TYPE_CAPTURE_POINT:
      return goData(info, 18) !== 0; // capturePoint.large
    default:
      return false;
  }
}

/** @ac game/Entities/GameObject/GameObjectData.h GameObjectTemplate::IsInfiniteGameObject */
export function IsInfiniteGameObject(info: GameObjectTemplate): boolean {
  switch (info.type) {
    case GAMEOBJECT_TYPE_DOOR:
    case GAMEOBJECT_TYPE_FLAGSTAND:
    case GAMEOBJECT_TYPE_FLAGDROP:
    case GAMEOBJECT_TYPE_DUNGEON_DIFFICULTY:
    case GAMEOBJECT_TYPE_TRAPDOOR:
    case GAMEOBJECT_TYPE_DESTRUCTIBLE_BUILDING:
      return true;
    default:
      return false;
  }
}

/** @ac game/Entities/GameObject/GameObjectData.h GameObjectTemplate::GetCharges (despawn at uses amount) */
export function GetCharges(info: GameObjectTemplate): number {
  switch (info.type) {
    case GAMEOBJECT_TYPE_GUARDPOST:
      return goData(info, 1); // guardpost.charges
    case GAMEOBJECT_TYPE_SPELLCASTER:
      return goData(info, 1); // spellcaster.charges
    default:
      return 0;
  }
}

/** @ac game/Entities/GameObject/GameObjectData.h GameObjectTemplate::GetAutoCloseTime */
export function GetAutoCloseTime(info: GameObjectTemplate): number {
  switch (info.type) {
    case GAMEOBJECT_TYPE_DOOR:
    case GAMEOBJECT_TYPE_BUTTON:
    case GAMEOBJECT_TYPE_GOOBER:
    case GAMEOBJECT_TYPE_TRANSPORT:
      return goData(info, 2); // autoCloseTime
    case GAMEOBJECT_TYPE_TRAP:
      return goData(info, 6); // trap.autoCloseTime
    case GAMEOBJECT_TYPE_AREADAMAGE:
      return goData(info, 5); // areadamage.autoCloseTime
    default:
      return 0;
  }
}

/** @ac game/Entities/GameObject/GameObject.h GameObject */
export class GameObject extends WorldObject {
  /** The low guid of a gameobject loaded from `gameobject`: null generates one per map; the integration sets the spawn id (see `Creature.dbGuidLow`). */
  static dbGuidLow: ((spawnId: number) => number) | null = null;

  protected _respawnCompatibilityMode = true;
  protected m_spellId = 0;
  /** (secs) time of next respawn (or despawn if GO have owner()), */
  protected m_respawnTime = 0;
  /** (secs) if 0 then current GO state no dependent from timer */
  protected m_respawnDelayTime = 300;
  protected m_despawnDelay = 0;
  /** override respawn time after delayed despawn (secs) */
  protected m_despawnRespawnTime = 0;
  protected m_lootState = GO_NOT_READY;
  protected m_spawnedByDefault = true;
  /** For new or temporary gameobjects is 0 for saved it is lowguid */
  protected m_spawnId = 0;
  protected m_goInfo: GameObjectTemplate | null = null;
  protected m_goData: GameObjectData | null = null;
  protected m_packedRotation = 0n;
  protected WorldRotation: QuaternionData = { x: 0, y: 0, z: 0, w: 1 };
  protected readonly m_stationaryPosition = new Position();
  protected m_linkedTrap = 0n;
  /** (msecs) timer used for door/button auto close, trap arming and goober reset */
  protected m_cooldownTime = 0;
  /** (secs) time when a chest restocks */
  protected m_restockTime = 0;
  protected m_usetimes = 0;
  /** @ac game/Entities/GameObject/GameObject.h GameObject::_lootStateUnitGUID */
  protected _lootStateUnitGUID = 0n;

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::GameObject */
  constructor() {
    super();
    this.m_objectType |= TYPEMASK_GAMEOBJECT;
    this.m_objectTypeId = TYPEID_GAMEOBJECT;
    // @ac-skip Updates: m_updateFlag (UPDATEFLAG_LOWGUID | STATIONARY_POSITION | POSITION | ROTATION)
    this.m_valuesCount = GAMEOBJECT_END;
    this.m_stationaryPosition.relocate(0.0, 0.0, 0.0, 0.0);
  }

  /**
   * @ac game/Entities/GameObject/GameObject.cpp GameObject::CleanupsBeforeDelete
   * @ac-skip Transports: `GetTransport()->RemovePassenger(this)`
   */
  override cleanupsBeforeDelete(_finalCleanup = true): void {
    if (this.isInWorld()) this.removeFromWorld();

    if (this.m_uint32Values) this.removeFromOwner(); // field array can be not exist if GameOBject not loaded
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::RemoveFromOwner (@ac-skip Unit: `owner->RemoveGameObject`) */
  removeFromOwner(): void {
    const ownerGUID = this.getOwnerGUID();
    if (!ownerGUID) return;
    this.setOwnerGUID(ObjectGuid.Empty);
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::AddToWorld */
  override addToWorld(): void {
    ///- Register the gameobject for guid lookup
    if (!this.isInWorld()) {
      this.m_zoneScript?.onGameObjectCreate(this);

      mapStores(this.getMap()).getObjectsStore?.().insert(this.getGUID(), this);
      if (this.m_spawnId) multimapInsert(mapStores(this.getMap()).getGameObjectBySpawnIdStore?.(), this.m_spawnId, this);

      // @ac-skip VMaps: m_model->UpdatePosition(); GetMap()->InsertGameObjectModel(*m_model); EnableCollision(...)

      super.addToWorld();

      // @ac-skip Loot: loot.sourceWorldObjectGUID = GetGUID()
      // @ac-skip Scripts: sScriptMgr->OnGameObjectAddWorld(this)
    }
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::RemoveFromWorld */
  override removeFromWorld(): void {
    ///- Remove the gameobject from the accessor
    if (this.isInWorld()) {
      // @ac-skip Scripts: sScriptMgr->OnGameObjectRemoveWorld(this)

      this.m_zoneScript?.onGameObjectRemove(this);

      this.removeFromOwner();

      // @ac-skip VMaps: GetMap()->RemoveGameObjectModel(*m_model)
      // @ac-skip Transports: transport->RemovePassenger(this, true)

      // If linked trap exists, despawn it
      this.getLinkedTrap()?.delete();

      super.removeFromWorld();

      if (this.m_spawnId) multimapErasePair(mapStores(this.getMap()).getGameObjectBySpawnIdStore?.(), this.m_spawnId, this);
      mapStores(this.getMap()).getObjectsStore?.().remove(this.getGUID());
    }
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::Create (`G3D::Quat` is `QuaternionData`) */
  create(
    guidlow: number,
    name_id: number,
    map: MapLike,
    phaseMask: number,
    x: number,
    y: number,
    z: number,
    ang: number,
    rotation: QuaternionData,
    animprogress: number,
    go_state: number,
    artKit = 0,
  ): boolean {
    this.setMap(map);

    this.relocate(x, y, z, ang);
    this.m_stationaryPosition.relocate(x, y, z, ang);
    if (!this.isPositionValid()) {
      logError("world", `Gameobject (GUID: ${guidlow} Entry: ${name_id}) not created. Suggested coordinates isn't valid (X: ${x} Y: ${y})`);
      return false;
    }

    this.setPhaseMask(phaseMask, false);

    this.updatePositionData();

    this.setZoneScript();
    if (this.m_zoneScript) {
      name_id = this.m_zoneScript.getGameObjectEntry(guidlow, name_id);
      if (!name_id) return false;
    }

    const goinfo = sObjectMgr.getGameObjectTemplate(name_id);
    if (!goinfo) {
      logError("sql", `Gameobject (GUID: ${guidlow} Entry: ${name_id}) not created: non-existing entry in \`gameobject_template\`. Map: ${map.getId()} (X: ${x} Y: ${y} Z: ${z})`);
      return false;
    }

    this._Create(guidlow, goinfo.entry, HighGuid.GameObject);

    this.m_goInfo = goinfo;

    if (goinfo.type >= MAX_GAMEOBJECT_TYPE) {
      logError("sql", `Gameobject (GUID: ${guidlow} Entry: ${name_id}) not created: non-existing GO type '${goinfo.type}' in \`gameobject_template\`. It will crash client if created.`);
      return false;
    }

    this.setWorldRotation(rotation);

    const gameObjectAddon = sObjectMgr.getGameObjectAddon(this.getSpawnId());
    const parentRotation = gameObjectAddon ? gameObjectAddon.ParentRotation : { x: 0, y: 0, z: 0, w: 1 };

    this.setTransportPathRotation(parentRotation.x, parentRotation.y, parentRotation.z, parentRotation.w);

    this.setObjectScale(goinfo.size);

    const templateAddon = this.getTemplateAddon();
    if (templateAddon) {
      this.setUInt32Value(GAMEOBJECT_FACTION, templateAddon.faction);
      this.replaceAllGameObjectFlags(templateAddon.flags);
    }

    this.setEntry(goinfo.entry);

    // set name for logs usage, doesn't affect anything ingame
    this.setName(goinfo.name);

    // GAMEOBJECT_BYTES_1, index at 0, 1, 2 and 3
    this.setGoType(goinfo.type);

    // @ac-skip Instances: IsInstanceGameobject() reads the stored state from the InstanceScript (not ported)
    this.setGoState(go_state);

    this.setGoArtKit(artKit);

    this.setDisplayId(goinfo.displayId);

    // @ac-skip VMaps: if (!m_model) m_model = CreateModel()

    switch (goinfo.type) {
      case GAMEOBJECT_TYPE_FISHINGHOLE:
        this.setGoAnimProgress(animprogress);
        // @ac-skip GameObjects: m_goValue.FishingHole.MaxOpens
        break;
      case GAMEOBJECT_TYPE_DESTRUCTIBLE_BUILDING:
        // @ac-skip GameObjects: m_goValue.Building health
        this.setGoAnimProgress(255);
        break;
      case GAMEOBJECT_TYPE_FISHINGNODE:
        this.setGoAnimProgress(0);
        break;
      case GAMEOBJECT_TYPE_TRAP:
        if (goData(goinfo, 9) /* trap.stealthed */) {
          this.m_stealth.addFlag(STEALTH_TRAP);
          this.m_stealth.addValue(STEALTH_TRAP, 70);
        }

        if (goData(goinfo, 11) /* trap.invisible */) {
          this.m_invisibility.addFlag(INVISIBILITY_TRAP);
          this.m_invisibility.addValue(INVISIBILITY_TRAP, 300);
        }
        break;
      default:
        this.setGoAnimProgress(animprogress);
        break;
    }

    if (gameObjectAddon) {
      if (gameObjectAddon.InvisibilityValue) {
        this.m_invisibility.addFlag(gameObjectAddon.invisibilityType);
        this.m_invisibility.addValue(gameObjectAddon.invisibilityType, gameObjectAddon.InvisibilityValue);
      }
    }

    // @ac-skip Scripts: LastUsedScriptID = GetScriptId()
    // @ac-skip AI: AIM_Initialize()

    const linkedEntry = GetLinkedGameObjectEntry(goinfo);
    if (linkedEntry) {
      const linkedGO = new GameObject();
      if (linkedGO.create(map.generateLowGuid(HighGuid.GameObject), linkedEntry, map, phaseMask, x, y, z, ang, rotation, 255, GO_STATE_READY)) {
        this.setLinkedTrap(linkedGO);
        mapStores(map).addToMap?.call(map, linkedGO);
      }
    }

    // Check if GameObject is Large
    if (IsLargeGameObject(goinfo)) this.setVisibilityDistanceOverride(VisibilityDistanceType.Large);

    // Check if GameObject is Infinite
    if (IsInfiniteGameObject(goinfo)) this.setVisibilityDistanceOverride(VisibilityDistanceType.Infinite);

    return true;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::LoadFromDB (`LoadGameObjectFromDB(guid, map, false)`) */
  loadFromDB(spawnId: number, map: MapLike): boolean {
    return this.loadGameObjectFromDB(spawnId, map, false);
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::LoadGameObjectFromDB */
  loadGameObjectFromDB(spawnId: number, map: MapLike, addToMap = true): boolean {
    const data = sObjectMgr.getSpawnGameObjectData(spawnId);

    if (!data) {
      logError("sql", `Gameobject (GUID: ${spawnId}) not found in table \`gameobject\`, can't load. `);
      return false;
    }

    const entry = data.id;
    const phaseMask = data.phaseMask;
    const x = data.posX;
    const y = data.posY;
    const z = data.posZ;
    const ang = data.orientation;

    const animprogress = data.animprogress;
    const go_state = data.go_state;
    const artKit = data.artKit;

    this.m_goData = data;
    this.m_spawnId = spawnId;

    // Set respawn compatibility mode based on spawn group flags
    const groupData = sObjectMgr.getSpawnGroupData(data.spawnGroupId);
    this._respawnCompatibilityMode =
      sWorld().getBoolConfig(ServerConfig.CONFIG_RESPAWN_FORCE_COMPATIBILITY_MODE) || !groupData || (groupData.flags & SPAWNGROUP_FLAG_COMPATIBILITY_MODE) !== 0;

    if (!this.create(GameObject.dbGuidLow ? GameObject.dbGuidLow(spawnId) : map.generateLowGuid(HighGuid.GameObject), entry, map, phaseMask, x, y, z, ang, data.rotation, animprogress, go_state, artKit)) return false;

    const info = this.getGOInfo()!;
    if (data.spawntimesecs >= 0) {
      this.m_spawnedByDefault = true;

      if (!GetDespawnPossibility(info) && !IsDespawnAtAction(info)) {
        this.setGameObjectFlag(GO_FLAG_NODESPAWN);
        this.m_respawnDelayTime = 0;
        this.m_respawnTime = 0;
      } else {
        this.m_respawnDelayTime = data.spawntimesecs;
        this.m_respawnTime = this.getMap().getGORespawnTime(this.m_spawnId);

        // ready to respawn
        if (this.m_respawnTime && this.m_respawnTime <= getGameTime()) {
          this.m_respawnTime = 0;
          this.getMap().removeGORespawnTime(this.m_spawnId);
        }
      }
    } else {
      this.m_spawnedByDefault = false;
      this.m_respawnDelayTime = -data.spawntimesecs;
      this.m_respawnTime = 0;
    }

    if (addToMap) {
      const add = mapStores(this.getMap()).addToMap;
      if (!add || !add.call(this.getMap(), this)) return false;
    }

    return true;
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::IsTransport */
  isTransport(): boolean {
    const info = this.getGOInfo();
    return info !== null && (info.type === GAMEOBJECT_TYPE_TRANSPORT || info.type === GAMEOBJECT_TYPE_MO_TRANSPORT);
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::IsDestructibleBuilding */
  isDestructibleBuilding(): boolean {
    const gInfo = this.getGOInfo();
    if (!gInfo) return false;
    return gInfo.type === GAMEOBJECT_TYPE_DESTRUCTIBLE_BUILDING;
  }

  /**
   * @ac game/Entities/GameObject/GameObject.cpp GameObject::GetOwner
   * `ObjectAccessor::GetUnit(*this, GetOwnerGUID())` over the map's object store; null until the Map port provides it.
   */
  getOwner(): UnitLike | null {
    const ownerGUID = this.getOwnerGUID();
    if (!ownerGUID || !this.isInWorld()) return null;
    const map = this.getMap() as MapLike & { getUnit?(guid: bigint): UnitLike | null };
    return map.getUnit?.(ownerGUID) ?? null;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetOwnerGUID */
  override getOwnerGUID(): bigint {
    return this.m_uint32Values ? this.getGuidValue(OBJECT_FIELD_CREATED_BY) : 0n;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::SetOwnerGUID */
  setOwnerGUID(owner: bigint): void {
    // Owner already found and different than expected owner - remove object from old owner
    if (owner && this.getOwnerGUID() && this.getOwnerGUID() !== owner) throw new Error("GameObject::SetOwnerGUID: ABORT");
    this.m_spawnedByDefault = false; // all object with owner is despawned after delay
    this.setGuidValue(OBJECT_FIELD_CREATED_BY, owner);
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::SaveRespawnTime */
  override saveRespawnTime(forceDelay = 0): void {
    if (this.m_goData && this.m_goData.dbData && (forceDelay || this.m_respawnTime > getGameTime()) && this.m_spawnedByDefault) {
      const respawnTime = forceDelay ? getGameTime() + forceDelay : this.m_respawnTime;
      mapStores(this.getMap()).saveGORespawnTime?.call(this.getMap(), this.m_spawnId, respawnTime);
    }
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::IsNeverVisible */
  override isNeverVisible(): boolean {
    if (super.isNeverVisible()) return true;

    if (this.getGoType() === GAMEOBJECT_TYPE_SPELL_FOCUS && goData(this.getGOInfo()!, 3) /* spellFocus.serverOnly */ === 1) return true;

    return false;
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::IsAlwaysVisibleFor (@ac-skip Combat: `owner->IsFriendlyTo(seer)`) */
  override isAlwaysVisibleFor(seer: WorldObject | null): boolean {
    if (seer && super.isAlwaysVisibleFor(seer)) return true;

    if (this.isTransport() || this.isDestructibleBuilding()) return true;

    if (!seer) return false;

    // Always seen by owner and friendly units
    const guid = this.getOwnerGUID();
    if (guid) {
      if (seer.getGUID() === guid) return true;
    }

    return false;
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::IsInvisibleDueToDespawn */
  override isInvisibleDueToDespawn(): boolean {
    if (super.isInvisibleDueToDespawn()) return true;

    // Despawned
    if (!this.isSpawned()) return true;

    return false;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetRespawnTime */
  getRespawnTime(): number {
    return this.m_respawnTime;
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::GetRespawnTimeEx */
  getRespawnTimeEx(): number {
    const now = getGameTime();
    if (this.m_respawnTime > now) return this.m_respawnTime;
    return now;
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::SetRespawnTime */
  setRespawnTime(respawn: number): void {
    this.m_respawnTime = respawn > 0 ? getGameTime() + respawn : 0;
    this.setRespawnDelay(respawn);
    if (respawn && !this.m_spawnedByDefault) this.updateObjectVisibility(true);
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::SetRespawnDelay */
  setRespawnDelay(respawn: number): void {
    this.m_respawnDelayTime = respawn > 0 ? respawn : 0;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetRespawnDelay */
  getRespawnDelay(): number {
    return this.m_respawnDelayTime;
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::Respawn */
  respawn(): void {
    if (this.m_spawnedByDefault && this.m_respawnTime > 0) {
      this.m_respawnTime = getGameTime();
      this.getMap().removeGORespawnTime(this.m_spawnId);
    }
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::isSpawned */
  isSpawned(): boolean {
    return this.m_respawnDelayTime === 0 || (this.m_respawnTime > 0 && !this.m_spawnedByDefault) || (this.m_respawnTime === 0 && this.m_spawnedByDefault);
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::isSpawnedByDefault */
  isSpawnedByDefault(): boolean {
    return this.m_spawnedByDefault;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::SetSpawnedByDefault */
  setSpawnedByDefault(b: boolean): void {
    this.m_spawnedByDefault = b;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::IsRespawnCompatibilityMode */
  isRespawnCompatibilityMode(): boolean {
    return this._respawnCompatibilityMode;
  }

  /**
   * @ac game/Entities/GameObject/GameObject.cpp GameObject::DespawnOrUnsummon (`Milliseconds` / `Seconds` are numbers)
   * @ac-skip Pools: `sPoolMgr->IsPartOfAPool` / `UpdatePool<GameObject>` (PoolMgr is not ported)
   */
  despawnOrUnsummon(delay = 0, forceRespawnTime = 0): void {
    if (delay > 0) {
      if (!this.m_despawnDelay || this.m_despawnDelay > delay) {
        this.m_despawnDelay = delay;
        this.m_despawnRespawnTime = forceRespawnTime;
      }
    } else {
      if (this.m_goData) {
        const respawnDelay = forceRespawnTime > 0 ? forceRespawnTime : this.m_goData.spawntimesecs;
        this.setRespawnTime(respawnDelay);
      }

      // Respawn is handled by the gameobject itself.
      // If we delete it from world, it simply never respawns...
      this.setLootState(GO_JUST_DEACTIVATED);
      this.sendObjectDeSpawnAnim(this.getGUID());
      this.setGoState(GO_STATE_READY);

      this.getLinkedTrap()?.despawnOrUnsummon();

      const addon = this.getTemplateAddon();
      if (addon) this.replaceAllGameObjectFlags(addon.flags);
    }
  }

  /**
   * @ac game/Entities/GameObject/GameObject.cpp GameObject::Delete
   * @ac-skip Pools: pool update instead of the remove list; @ac-skip GameObjects: `ClearRitualList` for summoning rituals
   */
  delete(): void {
    this.setLootState(GO_NOT_READY);
    this.removeFromOwner();

    this.sendObjectDeSpawnAnim(this.getGUID());

    this.setGoState(GO_STATE_READY);

    const addon = this.getTemplateAddon();
    if (addon) this.replaceAllGameObjectFlags(addon.flags);

    this.addObjectToRemoveList();
  }

  /**
   * @ac game/Entities/GameObject/GameObject.cpp GameObject::Update
   * The loot state machine: respawn and despawn timers, door/button auto close, goober reset, chest restock, and the
   * deactivate step. Per-type behavior that needs other topics is `@ac-skip` below.
   */
  override update(diff: number): void {
    super.update(diff);

    // @ac-skip AI: `AI()->UpdateAI(diff)` / `AIM_Initialize()` (no gameobject AI is ported)

    if (this.m_despawnDelay) {
      if (this.m_despawnDelay > diff) {
        this.m_despawnDelay -= diff;
      } else {
        this.m_despawnDelay = 0;
        this.despawnOrUnsummon(0, this.m_despawnRespawnTime);
      }
    }

    // @ac-skip GameObjects: `m_SkillupList` timers (fishing skillups)

    const goInfo = this.getGOInfo();
    if (!goInfo) return;

    switch (this.m_lootState) {
      case GO_NOT_READY:
      case GO_READY: {
        if (this.m_lootState === GO_NOT_READY) {
          switch (this.getGoType()) {
            case GAMEOBJECT_TYPE_TRAP:
              // Arming Time for GAMEOBJECT_TYPE_TRAP (6)
              // Bombs
              if (goData(goInfo, 4) === 2) {
                // trap.type
                this.m_cooldownTime = getGameTimeMS() + 10 * 1000; // Hardcoded tooltip value
              } else if (this.getOwner()) {
                this.m_cooldownTime = getGameTimeMS() + goData(goInfo, 7) * 1000; // trap.startDelay
              }

              this.m_lootState = GO_READY;
              break;
            case GAMEOBJECT_TYPE_FISHINGNODE:
              // @ac-skip GameObjects: fishing bobber (splash packet, `SendCustomAnim`); the bobber never becomes ready
              return;
            case GAMEOBJECT_TYPE_SUMMONING_RITUAL:
              // @ac-skip GameObjects: summoning ritual (`CheckRitualList`, `GetUniqueUseCount`, the ritual spell casts)
              return;
            case GAMEOBJECT_TYPE_CHEST:
              if (this.m_restockTime > getGameTime()) return;
              // If there is no restock timer, or if the restock timer passed, the chest becomes ready to loot
              this.m_restockTime = 0;
              this.m_lootState = GO_READY;
              // @ac-skip Updates: AddToObjectUpdateIfNeeded() (the Updates topic is not ported)
              break;
            default:
              this.m_lootState = GO_READY; // for other GOis same switched without delay to GO_READY
              break;
          }
        }

        // GO_READY
        if (this.m_respawnTime > 0) {
          // timer on
          const now = getGameTime();
          if (this.m_respawnTime <= now) {
            // timer expired
            const dbtableHighGuid = ObjectGuid.Make(HighGuid.GameObject, this.getEntry(), this.m_spawnId);
            const linkedRespawntime = mapStores(this.getMap()).getLinkedRespawnTime?.call(this.getMap(), dbtableHighGuid) ?? 0;
            if (linkedRespawntime) {
              // Can't respawn, the master is dead
              const targetGuid = sObjectMgr.getLinkedRespawnGuid(dbtableHighGuid);
              if (targetGuid === dbtableHighGuid) {
                // if linking self, never respawn (check delayed to next day)
                this.setRespawnTime(DAY);
              } else {
                this.m_respawnTime = (now > linkedRespawntime ? now : linkedRespawntime) + urand(5, MINUTE); // else copy time from master and add a little
              }
              this.saveRespawnTime(); // also save to DB immediately
              return;
            }

            this.m_respawnTime = 0;
            // @ac-skip GameObjects: `m_SkillupList.clear()`
            this.m_usetimes = 0;

            switch (this.getGoType()) {
              case GAMEOBJECT_TYPE_FISHINGNODE:
                // @ac-skip GameObjects: `Player::RemoveGameObject`, SMSG_FISH_ESCAPED
                // can be deleted
                this.m_lootState = GO_JUST_DEACTIVATED;
                return;
              case GAMEOBJECT_TYPE_DOOR:
              case GAMEOBJECT_TYPE_BUTTON:
                // we need to open doors if they are closed (add there another condition if this code breaks some usage, but it need to be here for battlegrounds)
                if (this.getGoState() !== GO_STATE_READY) this.resetDoorOrButton();
                break;
              case GAMEOBJECT_TYPE_FISHINGHOLE:
                // @ac-skip GameObjects: `m_goValue.FishingHole.MaxOpens` (fishing holes)
                break;
              default:
                break;
            }

            if (!this.m_spawnedByDefault) {
              // despawn timer
              // can be despawned or destroyed
              this.setLootState(GO_JUST_DEACTIVATED);
              return;
            }

            // @ac-skip AI: `AI()->Reset()`
            // @ac-skip Pools: `sPoolMgr->IsPartOfAPool<GameObject>` / `UpdatePool<GameObject>` (PoolMgr is not ported)
            mapStores(this.getMap()).addToMap?.call(this.getMap(), this);
          }
        }

        if (this.isSpawned()) {
          // traps can have time and can not have
          if (goInfo.type === GAMEOBJECT_TYPE_TRAP) {
            if (getGameTimeMS() < this.m_cooldownTime) break;

            // Type 2 - Bomb (will go away after casting it's spell)
            if (goData(goInfo, 4) === 2) {
              this.setLootState(GO_ACTIVATED);
              break;
            }

            // @ac-skip GameObjects: the trap trigger search (`NearestAttackableNoTotemUnitInObjectRangeCheck`,
            //   `AnyPlayerInObjectRangeCheck` through `Cell::VisitObjects`) and `SetLootState(GO_ACTIVATED, target)`
          } else {
            const max_charges = GetCharges(goInfo);
            if (max_charges) {
              if (this.m_usetimes >= max_charges) {
                this.m_usetimes = 0;
                this.setLootState(GO_JUST_DEACTIVATED); // can be despawned or destroyed
              }
            }
          }
        }

        break;
      }
      case GO_ACTIVATED:
        switch (this.getGoType()) {
          case GAMEOBJECT_TYPE_DOOR:
          case GAMEOBJECT_TYPE_BUTTON:
            if (GetAutoCloseTime(goInfo) && getGameTimeMS() >= this.m_cooldownTime) this.resetDoorOrButton();
            break;
          case GAMEOBJECT_TYPE_GOOBER:
            if (getGameTimeMS() >= this.m_cooldownTime) {
              this.removeGameObjectFlag(GO_FLAG_IN_USE);

              this.setLootState(GO_JUST_DEACTIVATED);
            }
            break;
          case GAMEOBJECT_TYPE_CHEST:
            // @ac-skip Loot: `m_groupLootTimer` (Group::EndRoll)

            // Non-consumable chest was partially looted and restock time passed, restock all loot now
            if (goData(goInfo, 3) === 0 /* chest.consumable */ && getGameTime() >= this.m_restockTime) {
              this.m_restockTime = 0;
              this.m_lootState = GO_READY;
              // @ac-skip Updates: AddToObjectUpdateIfNeeded() (the Updates topic is not ported)
            }
            break;
          case GAMEOBJECT_TYPE_TRAP:
            // @ac-skip Spells: `CastSpell` of the trap spell (bomb and target traps), the trap cooldown, and
            //   `Battleground::HandleTriggerBuff`; a bomb is only deactivated
            if (goData(goInfo, 4) === 2) this.setLootState(GO_JUST_DEACTIVATED);
            break;
          default:
            break;
        }
        break;
      case GO_JUST_DEACTIVATED: {
        // If nearby linked trap exists, despawn it
        this.getLinkedTrap()?.despawnOrUnsummon();

        // if Gameobject should cast spell, then this, but some GOs (type = 10) should be destroyed
        if (this.getGoType() === GAMEOBJECT_TYPE_GOOBER) {
          this.setGoState(GO_STATE_READY);

          // any return here in case battleground traps
          // Xinef: Do not return here for summoned gos that should be deleted few lines below
          // Xinef: Battleground objects are treated as spawned by default
          const addon = this.getTemplateAddon();
          if (addon && (addon.flags & GO_FLAG_NODESPAWN) !== 0 && this.isSpawnedByDefault()) return;
        }

        // @ac-skip Loot: `loot.clear()`

        // Do not delete chests or goobers that are not consumed on loot, while still allowing them to despawn when they expire if summoned
        const isSummonedAndExpired = (this.getOwner() !== null || this.getSpellId() !== 0) && this.m_respawnTime === 0;
        if ((this.getGoType() === GAMEOBJECT_TYPE_CHEST || this.getGoType() === GAMEOBJECT_TYPE_GOOBER) && !IsDespawnAtAction(goInfo) && !isSummonedAndExpired) {
          if (this.getGoType() === GAMEOBJECT_TYPE_CHEST && goData(goInfo, 2) /* chest.chestRestockTime */ > 0) {
            // Start restock timer when the chest is fully looted
            this.m_restockTime = getGameTime() + goData(goInfo, 2);
            this.setLootState(GO_NOT_READY);
            // @ac-skip Updates: AddToObjectUpdateIfNeeded() (the Updates topic is not ported)
          } else {
            this.setLootState(GO_READY);
          }

          this.updateObjectVisibility();
          return;
        } else if (this.getOwnerGUID() || this.getSpellId()) {
          this.setRespawnTime(0);
          this.delete();
          return;
        }

        this.setLootState(GO_READY);

        // burning flags in some battlegrounds, if you find better condition, just add it
        if (IsDespawnAtAction(goInfo) || this.getGoAnimProgress() > 0) {
          this.sendObjectDeSpawnAnim(this.getGUID());
          // reset flags
          const addon = this.getTemplateAddon();
          if (addon) this.replaceAllGameObjectFlags(addon.flags);
        }

        if (!this.m_respawnDelayTime) return;

        if (!this.m_spawnedByDefault) {
          this.m_respawnTime = 0;
          this.destroyForVisiblePlayers(); // xinef: old UpdateObjectVisibility();
          return;
        }

        const scale = mapStores(this.getMap()).applyDynamicModeRespawnScaling;
        const dynamicRespawnDelay = scale ? scale.call(this.getMap(), this, this.m_respawnDelayTime) : this.m_respawnDelayTime;
        this.m_respawnTime = getGameTime() + dynamicRespawnDelay;

        // if option not set then object will be saved at grid unload
        if (this.getMap().isDungeon()) this.saveRespawnTime();

        this.destroyForVisiblePlayers(); // xinef: old UpdateObjectVisibility();
        break;
      }
    }

    // @ac-skip Scripts: sScriptMgr->OnGameObjectUpdate(this, diff)
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::GetTemplateAddon */
  getTemplateAddon(): GameObjectTemplateAddon | null {
    return this.m_goInfo ? sObjectMgr.getGameObjectTemplateAddon(this.m_goInfo.entry) : null;
  }

  /**
   * @ac game/Entities/GameObject/GameObject.cpp GameObject::Refresh
   * Puts a despawned-by-timer object back on the map when it is spawned.
   */
  refresh(): void {
    // not refresh despawned not casted GO (despawned casted GO destroyed in all cases anyway)
    if (this.m_respawnTime > 0 && this.m_spawnedByDefault) return;

    if (this.isSpawned()) mapStores(this.getMap()).addToMap?.call(this.getMap(), this);
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::SwitchDoorOrButton */
  switchDoorOrButton(activate: boolean, alternative = false): void {
    if (activate) this.setGameObjectFlag(GO_FLAG_IN_USE);
    else this.removeGameObjectFlag(GO_FLAG_IN_USE);

    if (this.getGoState() === GO_STATE_READY) {
      // if closed -> open
      this.setGoState(alternative ? GO_STATE_ACTIVE_ALTERNATIVE : GO_STATE_ACTIVE);
    } else {
      // if open -> close
      this.setGoState(GO_STATE_READY);
    }
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::ResetDoorOrButton */
  resetDoorOrButton(): void {
    if (this.m_lootState === GO_READY || this.m_lootState === GO_JUST_DEACTIVATED) return;

    this.switchDoorOrButton(false);
    this.setLootState(GO_JUST_DEACTIVATED);
    this.m_cooldownTime = 0;
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::UseDoorOrButton */
  useDoorOrButton(time_to_restore = 0, alternative = false, user: UnitLike | null = null): void {
    if (this.m_lootState !== GO_READY) return;

    if (!time_to_restore) time_to_restore = this.m_goInfo ? GetAutoCloseTime(this.m_goInfo) : 0;

    this.switchDoorOrButton(true, alternative);
    this.setLootState(GO_ACTIVATED, user);

    this.m_cooldownTime = getGameTimeMS() + time_to_restore;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::getLootState */
  getLootState(): number {
    return this.m_lootState;
  }

  /**
   * @ac game/Entities/GameObject/GameObject.cpp GameObject::SetLootState
   * @ac-skip AI: `AI()->OnStateChanged`; @ac-skip Scripts: `OnGameObjectLootStateChanged`
   */
  setLootState(state: number, unit: UnitLike | null = null): void {
    this.m_lootState = state;

    this._lootStateUnitGUID = unit ? unit.getGUID() : 0n;

    // Start restock timer if the chest is partially looted or not looted at all
    if (this.getGoType() === GAMEOBJECT_TYPE_CHEST && state === GO_ACTIVATED && goData(this.m_goInfo!, 2) /* chest.chestRestockTime */ > 0 && this.m_restockTime === 0) {
      this.m_restockTime = getGameTime() + goData(this.m_goInfo!, 2);
    }
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::GetLinkedTrap (`ObjectAccessor::GetGameObject` through the map) */
  getLinkedTrap(): GameObject | null {
    if (!this.m_linkedTrap || !this.isInWorld()) return null;
    const map = this.getMap() as MapLike & { getGameObject?(guid: bigint): GameObject | null };
    return map.getGameObject?.(this.m_linkedTrap) ?? null;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::SetLinkedTrap */
  setLinkedTrap(linkedTrap: GameObject): void {
    this.m_linkedTrap = linkedTrap.getGUID();
  }

  /**
   * @ac game/Entities/GameObject/GameObject.cpp GameObject::IsInRange2d
   * Hides `WorldObject::IsInRange2d(x, y, minRange, maxRange)` like `isInRange3d`; the four argument call reaches it.
   */
  override isInRange2d(x: number, y: number, radiusOrMinRange: number, maxRange?: number): boolean {
    if (maxRange !== undefined) return super.isInRange2d(x, y, radiusOrMinRange, maxRange);
    const radius = radiusOrMinRange;
    const info = this.m_goInfo ? sGameObjectDisplayInfoStore.lookupEntry(this.m_goInfo.displayId) : null;
    if (!info) return this.isWithinDist2d(x, y, radius);

    const sinA = Math.sin(this.getOrientation());
    const cosA = Math.cos(this.getOrientation());
    let dx = x - this.getPositionX();
    let dy = y - this.getPositionY();
    const dist = Math.sqrt(dx * dx + dy * dy);
    //! Check if the distance between the 2 objects is 0, can happen if both objects are on the same position.
    if (fuzzyEq(dist, 0.0)) return true;

    const scale = this.getObjectScale();
    const sinB = dx / dist;
    const cosB = dy / dist;
    dx = dist * (cosA * cosB + sinA * sinB);
    dy = dist * (cosA * sinB - sinA * cosB);
    return dx < info.maxX * scale + radius && dx > info.minX * scale - radius && dy < info.maxY * scale + radius && dy > info.minY * scale - radius;
  }

  /**
   * @ac game/Entities/GameObject/GameObject.cpp GameObject::IsInRange3d
   * C++ `GameObject::IsInRange3d(x, y, z, radius)` hides `WorldObject::IsInRange3d(x, y, z, minRange, maxRange)`; the
   * five argument call still reaches the `WorldObject` one.
   */
  override isInRange3d(x: number, y: number, z: number, radiusOrMinRange: number, maxRange?: number): boolean {
    if (maxRange !== undefined) return super.isInRange3d(x, y, z, radiusOrMinRange, maxRange);
    const radius = radiusOrMinRange;
    const info = this.m_goInfo ? sGameObjectDisplayInfoStore.lookupEntry(this.m_goInfo.displayId) : null;
    if (!info) return this.isWithinDist3d(x, y, z, radius);

    const sinA = Math.sin(this.getOrientation());
    const cosA = Math.cos(this.getOrientation());
    let dx = x - this.getPositionX();
    let dy = y - this.getPositionY();
    const dz = z - this.getPositionZ();
    const dist = Math.sqrt(dx * dx + dy * dy);
    //! Check if the distance between the 2 objects is 0, can happen if both objects are on the same position.
    if (fuzzyEq(dist, 0.0)) return true;

    const scale = this.getObjectScale();
    const sinB = dx / dist;
    const cosB = dy / dist;
    dx = dist * (cosA * cosB + sinA * sinB);
    dy = dist * (cosA * sinB - sinA * cosB);
    return (
      dx < info.maxX * scale + radius &&
      dx > info.minX * scale - radius &&
      dy < info.maxY * scale + radius &&
      dy > info.minY * scale - radius &&
      dz < info.maxZ * scale + radius &&
      dz > info.minZ * scale - radius
    );
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::_IsWithinDist (proper GO size; does a 3d check) */
  protected override _IsWithinDist(obj: WorldObject, dist2compare: number, _is3D: boolean, _incOwnRadius = true, _incTargetRadius = true): boolean {
    //! Following check does check 3d distance
    dist2compare += obj.getObjectSize();
    return this.isInRange3d(obj.getPositionX(), obj.getPositionY(), obj.getPositionZ(), dist2compare);
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::IsWithinSightRange */
  override isWithinSightRange(pos: PositionLike, dist: number): boolean {
    return this.isInRange2d(pos.getPositionX(), pos.getPositionY(), dist);
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::UpdatePackedRotation */
  private updatePackedRotation(): void {
    const PACK_YZ = 1 << 20;
    const PACK_X = PACK_YZ << 1;
    const PACK_YZ_MASK = BigInt((PACK_YZ << 1) - 1);
    const PACK_X_MASK = BigInt(PACK_X) * 2n - 1n;
    const w_sign = this.WorldRotation.w >= 0 ? 1 : -1;
    const x = BigInt(Math.trunc(Math.fround(this.WorldRotation.x * PACK_X)) * w_sign) & PACK_X_MASK;
    const y = BigInt(Math.trunc(Math.fround(this.WorldRotation.y * PACK_YZ)) * w_sign) & PACK_YZ_MASK;
    const z = BigInt(Math.trunc(Math.fround(this.WorldRotation.z * PACK_YZ)) * w_sign) & PACK_YZ_MASK;
    this.m_packedRotation = BigInt.asIntN(64, z | (y << 21n) | (x << 42n));
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::SetWorldRotation */
  setWorldRotation(rot: QuaternionData): void {
    let rotation = { ...rot };
    // If the quaternion is zero (e.g. dynamically spawned GOs with no rotation),
    // fall back to computing rotation from orientation to avoid NaN from unitize()
    const magnitude = Math.sqrt(rotation.x * rotation.x + rotation.y * rotation.y + rotation.z * rotation.z + rotation.w * rotation.w);
    if (fuzzyEq(magnitude, 0.0)) {
      // G3D::Quat::fromAxisAngleRotation(Vector3::unitZ(), GetOrientation())
      const half = this.getOrientation() / 2;
      rotation = { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
    }
    // rotation.unitize()
    const length = Math.sqrt(rotation.x * rotation.x + rotation.y * rotation.y + rotation.z * rotation.z + rotation.w * rotation.w);
    this.WorldRotation = { x: Math.fround(rotation.x / length), y: Math.fround(rotation.y / length), z: Math.fround(rotation.z / length), w: Math.fround(rotation.w / length) };
    this.updatePackedRotation();
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::SetTransportPathRotation */
  setTransportPathRotation(qx: number, qy: number, qz: number, qw: number): void {
    this.setFloatValue(GAMEOBJECT_PARENTROTATION + 0, qx);
    this.setFloatValue(GAMEOBJECT_PARENTROTATION + 1, qy);
    this.setFloatValue(GAMEOBJECT_PARENTROTATION + 2, qz);
    this.setFloatValue(GAMEOBJECT_PARENTROTATION + 3, qw);
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::SetWorldRotationAngles (z_rot, y_rot, x_rot - rotation angles around z, y and x axes) */
  setWorldRotationAngles(z_rot: number, y_rot: number, x_rot: number): void {
    this.setWorldRotation(QuaternionDataFromEulerAnglesZYX(z_rot, y_rot, x_rot));
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetWorldRotation */
  getWorldRotation(): QuaternionData {
    return this.WorldRotation;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetPackedWorldRotation */
  getPackedWorldRotation(): bigint {
    return this.m_packedRotation;
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::GetFinalWorldRotation (@ac-skip Transports: the transport rotation) */
  getFinalWorldRotation(): QuaternionData {
    return this.WorldRotation;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetGOInfo */
  getGOInfo(): GameObjectTemplate | null {
    return this.m_goInfo;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetGameObjectData */
  getGameObjectData(): GameObjectData | null {
    return this.m_goData;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetSpawnId */
  getSpawnId(): number {
    return this.m_spawnId;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetSpellId */
  getSpellId(): number {
    return this.m_spellId;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::SetSpellId */
  setSpellId(id: number): void {
    this.m_spawnedByDefault = false; // all summoned object is despawned after delay
    this.m_spellId = id;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetDynamicFlags */
  override getDynamicFlags(): number {
    return this.getUInt32Value(GAMEOBJECT_DYNAMIC);
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetFaction */
  getFaction(): number {
    return this.getUInt32Value(GAMEOBJECT_FACTION);
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetGoType */
  getGoType(): number {
    return this.getByteValue(GAMEOBJECT_BYTES_1, 1);
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::SetGoType */
  setGoType(type: number): void {
    this.setByteValue(GAMEOBJECT_BYTES_1, 1, type);
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetGoState */
  getGoState(): number {
    return this.getByteValue(GAMEOBJECT_BYTES_1, 0);
  }

  /**
   * @ac game/Entities/GameObject/GameObject.cpp GameObject::SetGoState
   * @ac-skip VMaps: `EnableCollision` (the model); @ac-skip Instances: `SaveStateToDB`; @ac-skip Scripts: the hook
   */
  setGoState(state: number): void {
    this.setByteValue(GAMEOBJECT_BYTES_1, 0, state);
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetGoArtKit */
  getGoArtKit(): number {
    return this.getByteValue(GAMEOBJECT_BYTES_1, 2);
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::SetGoArtKit */
  setGoArtKit(kit: number): void {
    this.setByteValue(GAMEOBJECT_BYTES_1, 2, kit);
    const data = sObjectMgr.getSpawnGameObjectData(this.m_spawnId);
    if (data) data.artKit = kit;
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetGoAnimProgress */
  getGoAnimProgress(): number {
    return this.getByteValue(GAMEOBJECT_BYTES_1, 3);
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::SetGoAnimProgress */
  setGoAnimProgress(animprogress: number): void {
    this.setByteValue(GAMEOBJECT_BYTES_1, 3, animprogress);
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::SetDisplayId (@ac-skip VMaps: `UpdateModel()`) */
  setDisplayId(displayid: number): void {
    this.setUInt32Value(GAMEOBJECT_DISPLAYID, displayid);
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetDisplayId */
  getDisplayId(): number {
    return this.getUInt32Value(GAMEOBJECT_DISPLAYID);
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetGameObjectFlags */
  getGameObjectFlags(): number {
    return this.getUInt32Value(GAMEOBJECT_FLAGS);
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::HasGameObjectFlag */
  hasGameObjectFlag(flags: number): boolean {
    return this.hasFlag(GAMEOBJECT_FLAGS, flags);
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::SetGameObjectFlag */
  setGameObjectFlag(flags: number): void {
    this.setFlag(GAMEOBJECT_FLAGS, flags);
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::RemoveGameObjectFlag */
  removeGameObjectFlag(flags: number): void {
    this.removeFlag(GAMEOBJECT_FLAGS, flags);
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::ReplaceAllGameObjectFlags */
  replaceAllGameObjectFlags(flags: number): void {
    this.setUInt32Value(GAMEOBJECT_FLAGS, flags);
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::SetPhaseMask (@ac-skip VMaps: `EnableCollision(true)`) */
  override setPhaseMask(newPhaseMask: number, update: boolean): void {
    super.setPhaseMask(newPhaseMask, update);
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::ValidateGameobjectType */
  validateGameobjectType(): boolean {
    switch (this.m_goInfo?.type) {
      case GAMEOBJECT_TYPE_DOOR:
      case GAMEOBJECT_TYPE_BUTTON:
      case GAMEOBJECT_TYPE_TRAP:
      case GAMEOBJECT_TYPE_DESTRUCTIBLE_BUILDING:
      case GAMEOBJECT_TYPE_TRAPDOOR:
        return true;
      default:
        return false;
    }
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::IsInstanceGameobject */
  isInstanceGameobject(): boolean {
    // Avoid checking for unecessary gameobjects whose states don't matter for the dungeon progression
    if (!this.validateGameobjectType()) return false;

    const map = this.findMap();
    if (map && (map.isDungeon() || mapStores(map).isRaid?.call(map))) return true;
    return false;
  }

  /**
   * @ac game/Entities/GameObject/GameObject.cpp GameObject::GetRespawnPosition
   * The `float&` out parameters are the result.
   */
  getRespawnPosition(): { x: number; y: number; z: number; o: number } {
    if (this.m_spawnId) {
      const data = sObjectMgr.getSpawnGameObjectData(this.m_spawnId);
      if (data) return { x: data.posX, y: data.posY, z: data.posZ, o: data.orientation };
    }
    return { x: this.getPositionX(), y: this.getPositionY(), z: this.getPositionZ(), o: this.getOrientation() };
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::SetPosition (`Map::GameObjectRelocation` when the Map port has it) */
  setPosition(x: number, y: number, z: number, o: number): void {
    // pussywizard: do not call for MotionTransport and other gobjects not in grid
    if (!IsValidMapCoord(x, y, z, o)) return;

    const map = this.getMap() as MapLike & { gameObjectRelocation?(go: GameObject, x: number, y: number, z: number, o: number): void };
    if (map.gameObjectRelocation) map.gameObjectRelocation(this, x, y, z, o);
    else this.relocate(x, y, z, o);
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetStationaryX */
  override getStationaryX(): number {
    if (this.m_goInfo?.type !== GAMEOBJECT_TYPE_MO_TRANSPORT) return this.m_stationaryPosition.getPositionX();
    return this.getPositionX();
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetStationaryY */
  override getStationaryY(): number {
    if (this.m_goInfo?.type !== GAMEOBJECT_TYPE_MO_TRANSPORT) return this.m_stationaryPosition.getPositionY();
    return this.getPositionY();
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetStationaryZ */
  override getStationaryZ(): number {
    if (this.m_goInfo?.type !== GAMEOBJECT_TYPE_MO_TRANSPORT) return this.m_stationaryPosition.getPositionZ();
    return this.getPositionZ();
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::GetStationaryO */
  override getStationaryO(): number {
    if (this.m_goInfo?.type !== GAMEOBJECT_TYPE_MO_TRANSPORT) return this.m_stationaryPosition.getOrientation();
    return this.getOrientation();
  }

  /** @ac game/Entities/GameObject/GameObject.h GameObject::getLevelForTarget */
  override getLevelForTarget(target: WorldObject): number {
    const owner = this.getOwner();
    if (owner) return owner.getLevelForTarget(target);
    return 1;
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::IsUpdateNeeded */
  override isUpdateNeeded(): boolean {
    if (super.isUpdateNeeded()) return true;

    if (this.getMap().isCellMarked(this.getCurrentCell().getCellCoord().getId())) return true;

    if (this.getObjectVisibilityContainer().getVisiblePlayersMap().size !== 0) return true;

    if (this.isTransport()) return true;

    return false;
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::GetScriptId */
  getScriptId(): number {
    const data = this.getGameObjectData();
    if (data && data.ScriptId) return data.ScriptId;
    const row = sObjectMgr.worldTables()?.first(gameobject_template, "entry", this.getEntry());
    return sObjectMgr.getScriptId(row?.ScriptName ?? "");
  }
}
