/**
 * The grid type containers and their visitor, specialized to the two type lists the grids use.
 *
 * @ac common/Dynamic/TypeContainer.h TypeMapContainer
 * @ac common/Dynamic/TypeContainer.h TypeVectorContainer
 * @ac common/Dynamic/TypeContainerVisitor.h TypeContainerVisitor
 * @ac common/Dynamic/TypeContainerFunctions.h Acore::Insert
 *
 * C++ picks the `Visit(GridRefMgr<T>&)` overload of a notifier at compile time, with a catch-all template for the
 * types it skips. Here a visitor is an object with an optional method per stored type; `VisitorHelper` calls the ones
 * present, in the `TYPELIST` order, so a visitor sees exactly the object types it declares.
 */
import type { Corpse } from "../Entities/Corpse/Corpse.ts";
import type { Creature } from "../Entities/Creature/Creature.ts";
import type { DynamicObject } from "../Entities/DynamicObject/DynamicObject.ts";
import type { GameObject } from "../Entities/GameObject/GameObject.ts";
import type { WorldObject } from "../Entities/Object/Object.ts";
import { TYPEID_CORPSE, TYPEID_DYNAMICOBJECT, TYPEID_GAMEOBJECT, TYPEID_PLAYER, TYPEID_UNIT } from "../Entities/Object/ObjectGuid.ts";
import type { CorpseMapType, CreatureMapType, DynamicObjectMapType, GameObjectMapType, PlayerMapType } from "./GridDefines.ts";
import type { GridPlayer } from "./GridPlayer.ts";
import { GridRefMgr } from "./GridRefMgr.ts";

/** @ac game/Grids/GridDefines.h AllMapGridStoredObjectTypes (`TYPELIST_5(GameObject, Player, Creature, Corpse, DynamicObject)`) */
export type GridStoredObject = GameObject | GridPlayer | Creature | Corpse | DynamicObject;

/** @ac game/Grids/GridDefines.h AllFarVisibleObjectTypes (`TYPELIST_2(Creature, GameObject)`) */
export type FarVisibleObject = Creature | GameObject;

/** The `Visit(XMapType&)` overloads a notifier declares for `GridTypeMapContainer`. */
export interface GridTypeMapVisitor {
  visitGameObjectMap?(m: GameObjectMapType): void;
  visitPlayerMap?(m: PlayerMapType): void;
  visitCreatureMap?(m: CreatureMapType): void;
  visitCorpseMap?(m: CorpseMapType): void;
  visitDynamicObjectMap?(m: DynamicObjectMapType): void;
}

/** The `Visit(std::vector<T>&)` overloads a notifier declares for `FarVisibleGridContainer`. */
export interface FarVisibleVisitor {
  visitCreatureVector?(m: readonly Creature[]): void;
  visitGameObjectVector?(m: readonly GameObject[]): void;
}

/** @ac game/Grids/GridDefines.h GridTypeMapContainer (`TypeMapContainer<AllMapGridStoredObjectTypes>`) */
export class GridTypeMapContainer {
  readonly GameObject: GameObjectMapType = new GridRefMgr<GameObject>();
  readonly Player: PlayerMapType = new GridRefMgr<GridPlayer>();
  readonly Creature: CreatureMapType = new GridRefMgr<Creature>();
  readonly Corpse: CorpseMapType = new GridRefMgr<Corpse>();
  readonly DynamicObject: DynamicObjectMapType = new GridRefMgr<DynamicObject>();

  /** @ac common/Dynamic/TypeContainer.h TypeMapContainer::Count */
  count(typeId: number): number {
    return this.listFor(typeId)?.getSize() ?? 0;
  }

  /**
   * @ac common/Dynamic/TypeContainer.h TypeMapContainer::insert
   * inserts a specific object into the container (`Acore::Insert` links the object's grid reference)
   */
  insert(obj: GridStoredObject): boolean {
    const list = this.listFor(obj.getTypeId());
    if (!list) return false;
    (obj as WorldObject).addToGrid(list as GridRefMgr<WorldObject>);
    return true;
  }

  private listFor(typeId: number): GridRefMgr<GridStoredObject> | null {
    switch (typeId) {
      case TYPEID_GAMEOBJECT:
        return this.GameObject as GridRefMgr<GridStoredObject>;
      case TYPEID_PLAYER:
        return this.Player as GridRefMgr<GridStoredObject>;
      case TYPEID_UNIT:
        return this.Creature as GridRefMgr<GridStoredObject>;
      case TYPEID_CORPSE:
        return this.Corpse as GridRefMgr<GridStoredObject>;
      case TYPEID_DYNAMICOBJECT:
        return this.DynamicObject as GridRefMgr<GridStoredObject>;
      default:
        return null;
    }
  }
}

/** @ac game/Grids/GridDefines.h FarVisibleGridContainer (`TypeVectorContainer<AllFarVisibleObjectTypes>`) */
export class FarVisibleGridContainer {
  readonly Creature: Creature[] = [];
  readonly GameObject: GameObject[] = [];

  /** @ac common/Dynamic/TypeContainer.h TypeVectorContainer::Count */
  count(typeId: number): number {
    return this.vectorFor(typeId)?.length ?? 0;
  }

  /** @ac common/Dynamic/TypeContainer.h TypeVectorContainer::Insert */
  insert(obj: FarVisibleObject): boolean {
    const vector = this.vectorFor(obj.getTypeId());
    if (!vector) return false;
    vector.push(obj);
    return true;
  }

  /** @ac common/Dynamic/TypeContainer.h TypeVectorContainer::Remove */
  remove(obj: FarVisibleObject): boolean {
    const vector = this.vectorFor(obj.getTypeId());
    if (!vector) return false;
    const index = vector.indexOf(obj);
    if (index >= 0) vector.splice(index, 1);
    return true;
  }

  private vectorFor(typeId: number): FarVisibleObject[] | null {
    switch (typeId) {
      case TYPEID_UNIT:
        return this.Creature;
      case TYPEID_GAMEOBJECT:
        return this.GameObject;
      default:
        return null;
    }
  }
}

export type ContainerType = "GridTypeMapContainer" | "FarVisibleGridContainer";
export type VisitorFor<C extends ContainerType> = C extends "GridTypeMapContainer" ? GridTypeMapVisitor : FarVisibleVisitor;
export type ContainerFor<C extends ContainerType> = C extends "GridTypeMapContainer" ? GridTypeMapContainer : FarVisibleGridContainer;

/** @ac common/Dynamic/TypeContainerVisitor.h VisitorHelper (for `TypeMapContainer`, in `TYPELIST` order) */
export function VisitorHelperMap(v: GridTypeMapVisitor, c: GridTypeMapContainer): void {
  v.visitGameObjectMap?.(c.GameObject);
  v.visitPlayerMap?.(c.Player);
  v.visitCreatureMap?.(c.Creature);
  v.visitCorpseMap?.(c.Corpse);
  v.visitDynamicObjectMap?.(c.DynamicObject);
}

/** @ac common/Dynamic/TypeContainerVisitor.h VisitorHelper (for `TypeVectorContainer`, in `TYPELIST` order) */
export function VisitorHelperVector(v: FarVisibleVisitor, c: FarVisibleGridContainer): void {
  v.visitCreatureVector?.(c.Creature);
  v.visitGameObjectVector?.(c.GameObject);
}

/**
 * @ac common/Dynamic/TypeContainerVisitor.h TypeContainerVisitor
 * `TypeContainerVisitor<VISITOR, TYPE_CONTAINER>`: the container type is a value here so `GridCell::Visit` can pick
 * which of its two containers to hand over.
 */
export class TypeContainerVisitor<C extends ContainerType = ContainerType> {
  constructor(
    readonly i_visitor: VisitorFor<C>,
    readonly containerType: C,
  ) {}

  /** @ac common/Dynamic/TypeContainerVisitor.h TypeContainerVisitor::Visit */
  visit(c: ContainerFor<C>): void {
    if (this.containerType === "GridTypeMapContainer") {
      VisitorHelperMap(this.i_visitor as GridTypeMapVisitor, c as GridTypeMapContainer);
    } else {
      VisitorHelperVector(this.i_visitor as FarVisibleVisitor, c as FarVisibleGridContainer);
    }
  }
}
