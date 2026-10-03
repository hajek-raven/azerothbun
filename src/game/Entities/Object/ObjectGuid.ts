/**
 * `ObjectGuid` over the raw `bigint` the port uses for guids (`ObjectGuid::GetRawValue`). The C++ class wraps a
 * `uint64`; here every helper is a static that takes or returns that `bigint`, so a guid stays a plain value in maps,
 * sets, and packets.
 */
import { packedGuid } from "../../../world/update-object.ts";

/** @ac game/Entities/Object/ObjectGuid.h TypeID */
export const TYPEID_OBJECT = 0;
export const TYPEID_ITEM = 1;
export const TYPEID_CONTAINER = 2;
export const TYPEID_UNIT = 3;
export const TYPEID_PLAYER = 4;
export const TYPEID_GAMEOBJECT = 5;
export const TYPEID_DYNAMICOBJECT = 6;
export const TYPEID_CORPSE = 7;
export type TypeID = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** @ac game/Entities/Object/ObjectGuid.h NUM_CLIENT_OBJECT_TYPES */
export const NUM_CLIENT_OBJECT_TYPES = 8;

/** @ac game/Entities/Object/ObjectGuid.h TypeMask */
export const TYPEMASK_OBJECT = 0x0001;
export const TYPEMASK_ITEM = 0x0002;
export const TYPEMASK_CONTAINER = 0x0006; // TYPEMASK_ITEM | 0x0004
export const TYPEMASK_UNIT = 0x0008; // creature
export const TYPEMASK_PLAYER = 0x0010;
export const TYPEMASK_GAMEOBJECT = 0x0020;
export const TYPEMASK_DYNAMICOBJECT = 0x0040;
export const TYPEMASK_CORPSE = 0x0080;
export const TYPEMASK_SEER = TYPEMASK_PLAYER | TYPEMASK_UNIT | TYPEMASK_DYNAMICOBJECT;

/** @ac game/Entities/Object/ObjectGuid.h HighGuid */
export const HighGuid = {
  Item: 0x4000, // blizz 4000
  Container: 0x4000, // blizz 4000
  Player: 0x0000, // blizz 0000
  GameObject: 0xf110, // blizz F110
  Transport: 0xf120, // blizz F120 (for GAMEOBJECT_TYPE_TRANSPORT)
  Unit: 0xf130, // blizz F130
  Pet: 0xf140, // blizz F140
  Vehicle: 0xf150, // blizz F550
  DynamicObject: 0xf100, // blizz F100
  Corpse: 0xf101, // blizz F100
  Mo_Transport: 0x1fc0, // blizz 1FC0 (for GAMEOBJECT_TYPE_MO_TRANSPORT)
  Instance: 0x1f40, // blizz 1F40
  Group: 0x1f50,
} as const;
export type HighGuid = (typeof HighGuid)[keyof typeof HighGuid];

/** @ac game/Entities/Object/ObjectGuid.h ObjectGuidTraits (`GUID_TRAIT_GLOBAL`) */
const GLOBAL_HIGH_GUIDS: ReadonlySet<number> = new Set([HighGuid.Player, HighGuid.Item, HighGuid.Mo_Transport, HighGuid.Group, HighGuid.Instance]);

/** @ac game/Entities/Object/ObjectGuid.h DEFAULT_NON_CROSSREALM_REALM_ID */
export const DEFAULT_NON_CROSSREALM_REALM_ID = 0;

/** @ac game/Entities/Object/ObjectGuid.h PACKED_GUID_MIN_BUFFER_SIZE */
export const PACKED_GUID_MIN_BUFFER_SIZE = 9;

export const ObjectGuid = {
  /** @ac game/Entities/Object/ObjectGuid.cpp ObjectGuid::Empty */
  Empty: 0n,

  /**
   * @ac game/Entities/Object/ObjectGuid.h ObjectGuid::Create
   * Global high guids take `(counter)`, map specific ones `(entry, counter)`, like the two `enable_if` overloads.
   */
  Create(high: HighGuid, entryOrCounter: number, counter?: number): bigint {
    if (GLOBAL_HIGH_GUIDS.has(high)) {
      return ObjectGuid.Global(high, entryOrCounter);
    }
    return ObjectGuid.MapSpecific(high, entryOrCounter, counter ?? 0);
  },

  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::ObjectGuid(HighGuid hi, uint32 entry, LowType counter) */
  Make(high: HighGuid, entry: number, counter: number): bigint {
    if (!counter) return 0n;
    return BigInt(counter >>> 0) | (BigInt(entry >>> 0) << 24n) | (BigInt(high) << 48n);
  },

  /** @ac game/Entities/Object/ObjectGuid.cpp ObjectGuid::Global */
  Global(high: HighGuid, counter: number): bigint {
    if (!counter) return 0n;
    return BigInt(counter >>> 0) | (BigInt(high) << 48n);
  },

  /** @ac game/Entities/Object/ObjectGuid.cpp ObjectGuid::MapSpecific */
  MapSpecific(high: HighGuid, entry: number, counter: number): bigint {
    return ObjectGuid.Make(high, entry, counter);
  },

  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::GetHigh */
  GetHigh(guid: bigint): HighGuid {
    return Number((guid >> 48n) & 0xffffn) as HighGuid;
  },

  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::HasEntry */
  HasEntry(high: number): boolean {
    switch (high) {
      case HighGuid.Item:
      case HighGuid.Player:
      case HighGuid.DynamicObject:
      case HighGuid.Corpse:
      case HighGuid.Mo_Transport:
      case HighGuid.Instance:
      case HighGuid.Group:
        return false;
      case HighGuid.GameObject:
      case HighGuid.Transport:
      case HighGuid.Unit:
      case HighGuid.Pet:
      case HighGuid.Vehicle:
      default:
        return true;
    }
  },

  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::GetEntry */
  GetEntry(guid: bigint): number {
    return ObjectGuid.HasEntry(ObjectGuid.GetHigh(guid)) ? Number((guid >> 24n) & 0xffffffn) : 0;
  },

  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::GetRealmID */
  GetRealmID(guid: bigint): number {
    return ObjectGuid.IsPlayer(guid) ? Number((guid >> 32n) & 0xffffn) : 0;
  },

  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::GetCounter */
  GetCounter(guid: bigint): number {
    return ObjectGuid.HasEntry(ObjectGuid.GetHigh(guid)) ? Number(guid & 0xffffffn) : Number(guid & 0xffffffffn);
  },

  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::GetMaxCounter */
  GetMaxCounter(high: number): number {
    return ObjectGuid.HasEntry(high) ? 0x00ffffff : 0xffffffff;
  },

  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsEmpty */
  IsEmpty(guid: bigint): boolean {
    return guid === 0n;
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsCreature */
  IsCreature(guid: bigint): boolean {
    return ObjectGuid.GetHigh(guid) === HighGuid.Unit;
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsPet */
  IsPet(guid: bigint): boolean {
    return ObjectGuid.GetHigh(guid) === HighGuid.Pet;
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsVehicle */
  IsVehicle(guid: bigint): boolean {
    return ObjectGuid.GetHigh(guid) === HighGuid.Vehicle;
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsCreatureOrPet */
  IsCreatureOrPet(guid: bigint): boolean {
    return ObjectGuid.IsCreature(guid) || ObjectGuid.IsPet(guid);
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsCreatureOrVehicle */
  IsCreatureOrVehicle(guid: bigint): boolean {
    return ObjectGuid.IsCreature(guid) || ObjectGuid.IsVehicle(guid);
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsAnyTypeCreature */
  IsAnyTypeCreature(guid: bigint): boolean {
    return ObjectGuid.IsCreature(guid) || ObjectGuid.IsPet(guid) || ObjectGuid.IsVehicle(guid);
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsPlayer */
  IsPlayer(guid: bigint): boolean {
    return guid !== 0n && ObjectGuid.GetHigh(guid) === HighGuid.Player;
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsUnit */
  IsUnit(guid: bigint): boolean {
    return ObjectGuid.IsAnyTypeCreature(guid) || ObjectGuid.IsPlayer(guid);
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsItem */
  IsItem(guid: bigint): boolean {
    return ObjectGuid.GetHigh(guid) === HighGuid.Item;
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsGameObject */
  IsGameObject(guid: bigint): boolean {
    return ObjectGuid.GetHigh(guid) === HighGuid.GameObject;
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsDynamicObject */
  IsDynamicObject(guid: bigint): boolean {
    return ObjectGuid.GetHigh(guid) === HighGuid.DynamicObject;
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsCorpse */
  IsCorpse(guid: bigint): boolean {
    return ObjectGuid.GetHigh(guid) === HighGuid.Corpse;
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsTransport */
  IsTransport(guid: bigint): boolean {
    return ObjectGuid.GetHigh(guid) === HighGuid.Transport;
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsMOTransport */
  IsMOTransport(guid: bigint): boolean {
    return ObjectGuid.GetHigh(guid) === HighGuid.Mo_Transport;
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsAnyTypeGameObject */
  IsAnyTypeGameObject(guid: bigint): boolean {
    return ObjectGuid.IsGameObject(guid) || ObjectGuid.IsTransport(guid) || ObjectGuid.IsMOTransport(guid);
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsInstance */
  IsInstance(guid: bigint): boolean {
    return ObjectGuid.GetHigh(guid) === HighGuid.Instance;
  },
  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::IsGroup */
  IsGroup(guid: bigint): boolean {
    return ObjectGuid.GetHigh(guid) === HighGuid.Group;
  },

  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::GetTypeId */
  GetTypeId(guid: bigint): TypeID {
    return ObjectGuid.GetTypeIdOfHigh(ObjectGuid.GetHigh(guid));
  },

  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::GetTypeId (static, by `HighGuid`) */
  GetTypeIdOfHigh(high: number): TypeID {
    switch (high) {
      case HighGuid.Item:
        return TYPEID_ITEM;
      // case HighGuid.Container: return TYPEID_CONTAINER; HighGuid.Container == HighGuid.Item currently
      case HighGuid.Unit:
        return TYPEID_UNIT;
      case HighGuid.Pet:
        return TYPEID_UNIT;
      case HighGuid.Player:
        return TYPEID_PLAYER;
      case HighGuid.GameObject:
        return TYPEID_GAMEOBJECT;
      case HighGuid.DynamicObject:
        return TYPEID_DYNAMICOBJECT;
      case HighGuid.Corpse:
        return TYPEID_CORPSE;
      case HighGuid.Mo_Transport:
        return TYPEID_GAMEOBJECT;
      case HighGuid.Vehicle:
        return TYPEID_UNIT;
      // unknown
      case HighGuid.Instance:
      case HighGuid.Group:
      default:
        return TYPEID_OBJECT;
    }
  },

  /** @ac game/Entities/Object/ObjectGuid.cpp ObjectGuid::GetTypeName (static, by `HighGuid`) */
  GetTypeNameOfHigh(high: number): string {
    switch (high) {
      case HighGuid.Item:
        return "Item";
      case HighGuid.Player:
        return "Player";
      case HighGuid.GameObject:
        return "Gameobject";
      case HighGuid.Transport:
        return "Transport";
      case HighGuid.Unit:
        return "Creature";
      case HighGuid.Pet:
        return "Pet";
      case HighGuid.Vehicle:
        return "Vehicle";
      case HighGuid.DynamicObject:
        return "DynObject";
      case HighGuid.Corpse:
        return "Corpse";
      case HighGuid.Mo_Transport:
        return "MoTransport";
      case HighGuid.Instance:
        return "InstanceID";
      case HighGuid.Group:
        return "Group";
      default:
        return "<unknown>";
    }
  },

  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::GetTypeName */
  GetTypeName(guid: bigint): string {
    return guid !== 0n ? ObjectGuid.GetTypeNameOfHigh(ObjectGuid.GetHigh(guid)) : "None";
  },

  /** @ac game/Entities/Object/ObjectGuid.cpp ObjectGuid::ToString */
  ToString(guid: bigint): string {
    let str = `GUID Full: 0x${guid.toString(16).padStart(16, "0")}`;
    str += ` Type: ${ObjectGuid.GetTypeName(guid)}`;
    if (ObjectGuid.HasEntry(ObjectGuid.GetHigh(guid))) {
      str += `${ObjectGuid.IsPet(guid) ? " Pet number: " : " Entry: "}${ObjectGuid.GetEntry(guid)} `;
    }
    str += ` Low: ${ObjectGuid.GetCounter(guid)}`;
    return str;
  },

  /** @ac game/Entities/Object/ObjectGuid.h ObjectGuid::WriteAsPacked (`PackedGuid` bytes) */
  WriteAsPacked(guid: bigint): Uint8Array {
    return packedGuid(guid);
  },
};
