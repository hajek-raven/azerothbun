/**
 * @ac game/Entities/Object/ObjectVisibilityContainer.h ObjectVisibilityContainer
 * Class that manages the visibility containers of a worldobject.
 *
 * Some implementation notes: non-player worldobjects do not have any concept of 'visibility', thus, the most important
 * and mainly used map is 'VisibleWorldObjectsMap' which is only accessible for player objects. The 'VisiblePlayersMap'
 * map is simply for managing the references so we can use direct pointers.
 */
import type { GridPlayer } from "../../Grids/GridPlayer.ts";
import type { WorldObject } from "./Object.ts";

/** @ac game/Entities/Object/ObjectVisibilityContainer.h VisibleWorldObjectsMap */
export type VisibleWorldObjectsMap = Map<bigint, WorldObject>;
/** @ac game/Entities/Object/ObjectVisibilityContainer.h VisiblePlayersMap */
export type VisiblePlayersMap = Map<bigint, GridPlayer>;

export class ObjectVisibilityContainer {
  /**
   * List of all worldobjects that are visible to us (including other players). Only players contain this map, thus we
   * will only allocate it as needed.
   */
  private _visibleWorldObjectsMap: VisibleWorldObjectsMap | null = null;

  /** List of players who are currently able to see this worldobject. All worldobjects will contain this map */
  private readonly _visiblePlayersMap: VisiblePlayersMap = new Map();

  /** @ac game/Entities/Object/ObjectVisibilityContainer.cpp ObjectVisibilityContainer::ObjectVisibilityContainer */
  constructor(private readonly _selfObject: WorldObject) {}

  /** @ac game/Entities/Object/ObjectVisibilityContainer.cpp ObjectVisibilityContainer::InitForPlayer (creates the _visibleWorldObjectsMap map if we are a player) */
  initForPlayer(): void {
    this._visibleWorldObjectsMap = new Map();
  }

  /**
   * @ac game/Entities/Object/ObjectVisibilityContainer.cpp ObjectVisibilityContainer::CleanVisibilityReferences
   * Cleans up all visibility references from other worldobjects, this is used before a worldobject is deleted to
   * prevent any dangling references
   */
  cleanVisibilityReferences(): void {
    const selfGuid = this._selfObject.getGUID();
    for (const player of this._visiblePlayersMap.values()) player.getObjectVisibilityContainer().directRemoveVisibilityReference(selfGuid);

    if (this._visibleWorldObjectsMap) {
      for (const obj of this._visibleWorldObjectsMap.values()) obj.getObjectVisibilityContainer().directRemoveVisiblePlayerReference(selfGuid);

      this._visibleWorldObjectsMap.clear();
    }

    this._visiblePlayersMap.clear();
  }

  /** @ac game/Entities/Object/ObjectVisibilityContainer.cpp ObjectVisibilityContainer::LinkWorldObjectVisibility */
  linkWorldObjectVisibility(worldObject: WorldObject): void {
    // Do not link self
    if (worldObject === this._selfObject) return;

    // Transports are special and should not be added to our visibility map
    if (worldObject.isGameObject() && worldObject.toGameObject()?.isTransport()) return;

    // Only players can link visibility
    if (!this._visibleWorldObjectsMap) return;

    this._visibleWorldObjectsMap.set(worldObject.getGUID(), worldObject);
    const selfPlayer = this._selfObject.toPlayer();
    if (selfPlayer) worldObject.getObjectVisibilityContainer().directInsertVisiblePlayerReference(selfPlayer);
  }

  /** @ac game/Entities/Object/ObjectVisibilityContainer.cpp ObjectVisibilityContainer::UnlinkWorldObjectVisibility */
  unlinkWorldObjectVisibility(worldObject: WorldObject): void {
    // Only players can unlink visibility
    if (!this._visibleWorldObjectsMap) return;

    worldObject.getObjectVisibilityContainer().directRemoveVisiblePlayerReference(this._selfObject.getGUID());
    this._visibleWorldObjectsMap.delete(worldObject.getGUID());
  }

  /**
   * @ac game/Entities/Object/ObjectVisibilityContainer.cpp ObjectVisibilityContainer::UnlinkVisibilityFromPlayer
   * The C++ returns the next iterator; deleting from a JS `Map` while iterating it is safe, so the caller keeps walking.
   */
  unlinkVisibilityFromPlayer(worldObject: WorldObject): void {
    if (!this._visibleWorldObjectsMap) throw new Error("ObjectVisibilityContainer::UnlinkVisibilityFromPlayer on a non-player object");
    worldObject.getObjectVisibilityContainer().directRemoveVisiblePlayerReference(this._selfObject.getGUID());
    this._visibleWorldObjectsMap.delete(worldObject.getGUID());
  }

  /** @ac game/Entities/Object/ObjectVisibilityContainer.cpp ObjectVisibilityContainer::UnlinkVisibilityFromWorldObject */
  unlinkVisibilityFromWorldObject(player: GridPlayer): void {
    player.getObjectVisibilityContainer().directRemoveVisibilityReference(this._selfObject.getGUID());
    this._visiblePlayersMap.delete(player.getGUID());
  }

  /** @ac game/Entities/Object/ObjectVisibilityContainer.h ObjectVisibilityContainer::GetVisiblePlayersMap (returns a list of all players who can see us) */
  getVisiblePlayersMap(): VisiblePlayersMap {
    return this._visiblePlayersMap;
  }

  /**
   * @ac game/Entities/Object/ObjectVisibilityContainer.h ObjectVisibilityContainer::GetVisibleWorldObjectsMap
   * Returns a list of all worldobjects who we can see. Warning: This is for player objects only, all other objects will
   * return a nullptr
   */
  getVisibleWorldObjectsMap(): VisibleWorldObjectsMap | null {
    return this._visibleWorldObjectsMap;
  }

  /**
   * @ac game/Entities/Object/ObjectVisibilityContainer.cpp ObjectVisibilityContainer::DirectRemoveVisibilityReference
   * Directly removes visibility reference. This is to be ONLY used as a more efficient method for cleaning up
   * visibility references.
   */
  directRemoveVisibilityReference(guid: bigint): void {
    if (!this._visibleWorldObjectsMap) throw new Error("ObjectVisibilityContainer::DirectRemoveVisibilityReference on a non-player object");
    this._visibleWorldObjectsMap.delete(guid);
  }

  /** @ac game/Entities/Object/ObjectVisibilityContainer.cpp ObjectVisibilityContainer::DirectInsertVisiblePlayerReference */
  directInsertVisiblePlayerReference(player: GridPlayer): void {
    if (!this._visiblePlayersMap.has(player.getGUID())) this._visiblePlayersMap.set(player.getGUID(), player);
  }

  /** @ac game/Entities/Object/ObjectVisibilityContainer.cpp ObjectVisibilityContainer::DirectRemoveVisiblePlayerReference */
  directRemoveVisiblePlayerReference(guid: bigint): void {
    this._visiblePlayersMap.delete(guid);
  }
}
