/**
 * @ac game/Grids/GridCell.h GridCell
 * Grid is a logical segment of the game world represented inside TrinIty. One cell holds the objects stored in it
 * (`_gridObjects`) and, separately, the far visible creatures and gameobjects that stand in it (`_farVisibleObjects`).
 */
import { FarVisibleGridContainer, GridTypeMapContainer, type ContainerType, type FarVisibleObject, type GridStoredObject, type TypeContainerVisitor } from "./TypeContainer.ts";

export class GridCell {
  private readonly _gridObjects = new GridTypeMapContainer();
  private readonly _farVisibleObjects = new FarVisibleGridContainer();

  /** @ac game/Grids/GridCell.h GridCell::AddGridObject */
  addGridObject(obj: GridStoredObject): void {
    this._gridObjects.insert(obj);
    if (!obj.isInGrid()) throw new Error("GridCell::AddGridObject: object is not in grid after insert");
  }

  /**
   * @ac game/Grids/GridCell.h GridCell::Visit
   * The two overloads: grid objects for a `GridTypeMapContainer` visitor, far objects for a `FarVisibleGridContainer` one.
   */
  visit(visitor: TypeContainerVisitor<ContainerType>): void {
    if (visitor.containerType === "GridTypeMapContainer") {
      (visitor as TypeContainerVisitor<"GridTypeMapContainer">).visit(this._gridObjects);
    } else {
      (visitor as TypeContainerVisitor<"FarVisibleGridContainer">).visit(this._farVisibleObjects);
    }
  }

  /** @ac game/Grids/GridCell.h GridCell::AddFarVisibleObject */
  addFarVisibleObject(obj: FarVisibleObject): void {
    this._farVisibleObjects.insert(obj);
  }

  /** @ac game/Grids/GridCell.h GridCell::RemoveFarVisibleObject */
  removeFarVisibleObject(obj: FarVisibleObject): void {
    this._farVisibleObjects.remove(obj);
  }

  /** The grid objects (tests and `GridObjectUnloader` checks). */
  getGridObjects(): GridTypeMapContainer {
    return this._gridObjects;
  }
}
