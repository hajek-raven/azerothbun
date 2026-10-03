/**
 * @ac game/Grids/GridObjectLoader.h
 * @ac game/Grids/GridObjectLoader.cpp
 * Spawns the creatures, gameobjects, and corpses of one grid when the grid's object data is loaded, and cleans them up
 * when the grid is unloaded.
 *
 * `ObjectMgr` (spawn stores), `Creature`, `GameObject`, and `StaticTransport` belong to other streams, so the loader talks
 * to them through the structural interfaces below and `GridObjectLoaderHooks`, which the integration sets at startup
 * (`objectMgr = sObjectMgr`, `createCreature = () => new Creature()`, ...). The real classes satisfy the interfaces.
 */
import type { WorldObject } from "../Entities/Object/Object.ts";
import { NOTIFY_AI_RELOCATION, NOTIFY_VISIBILITY_CHANGED } from "../Entities/Object/Object.ts";
import { UNIT_STATE_SIGHTLESS } from "../../spells/enums.ts";
import { Cell } from "./Cells/Cell.ts";
import { ComputeCellCoord, type CorpseMapType, type CreatureMapType, type DynamicObjectMapType, type GameObjectMapType, type PlayerMapType } from "./GridDefines.ts";
import type { UnitLike } from "./GridPlayer.ts";
import type { GridRefMgr } from "./GridRefMgr.ts";
import type { MapGrid } from "./MapGrid.ts";
import type { MapLike } from "./MapLike.ts";
import { AIRelocationNotifier } from "./Notifiers/GridNotifiers.ts";
import type { GridStoredObject, GridTypeMapVisitor } from "./TypeContainer.ts";

/** @ac game/Entities/Unit/UnitDefines.h ReactStates::REACT_AGGRESSIVE */
const REACT_AGGRESSIVE = 2;
/** @ac game/Movement/MotionMaster.h MovementGeneratorType::IDLE_MOTION_TYPE */
const IDLE_MOTION_TYPE = 0;

/** @ac game/Globals/ObjectMgr.h CellGuidSet (`std::set<ObjectGuid::LowType>`: iterated in ascending order) */
export type CellGuidSet = Iterable<number>;

/** @ac game/Globals/ObjectMgr.h CellObjectGuids */
export interface CellObjectGuids {
  creatures: CellGuidSet;
  gameobjects: CellGuidSet;
}

/** @ac game/Maps/SpawnData.h SpawnData (the members the loader reads) */
export interface GridLoaderSpawnData {
  /** template entry (`id`) */
  id: number;
  spawnGroupId: number;
  poolId: number;
}

/** @ac game/Globals/ObjectMgr.h ObjectMgr (the spawn store members the loader calls) */
export interface GridObjectLoaderObjectMgr {
  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetGridObjectGuids */
  getGridObjectGuids(mapid: number, spawnMode: number, gridId: number): CellObjectGuids;
  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetCreatureData */
  getCreatureData(spawnId: number): GridLoaderSpawnData | null;
  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetGameObjectData */
  getGameObjectData(spawnId: number): GridLoaderSpawnData | null;
  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::IsGameObjectStaticTransport */
  isGameObjectStaticTransport(entry: number): boolean;
}

/** @ac game/Entities/Vehicle/Vehicle.h Vehicle (the member the loader calls) */
export interface GridLoaderVehicle {
  /** @ac game/Entities/Vehicle/Vehicle.cpp Vehicle::Reset */
  reset(evading?: boolean): void;
}

/** @ac game/Entities/Creature/Creature.h Creature (the members the loader calls) */
export interface GridLoaderCreature extends UnitLike {
  /** @ac game/Entities/Creature/Creature.cpp Creature::LoadFromDB */
  loadFromDB(spawnId: number, map: MapLike, allowDuplicate?: boolean): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::GetVehicleKit */
  getVehicleKit(): GridLoaderVehicle | null;
  /** @ac game/Entities/Creature/Creature.h Creature::IsMoveInLineOfSightDisabled */
  isMoveInLineOfSightDisabled(): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::IsMoveInLineOfSightStrictlyDisabled (read by `AIRelocationNotifier`) */
  isMoveInLineOfSightStrictlyDisabled(): boolean;
  /** @ac game/Entities/Creature/Creature.h Creature::GetDefaultMovementType */
  getDefaultMovementType(): number;
  /** @ac game/Entities/Creature/Creature.h Creature::HasReactState */
  hasReactState(state: number): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsImmuneToNPC */
  isImmuneToNPC(): boolean;
}

/** @ac game/Entities/GameObject/GameObject.h GameObject (the member the loader calls) */
export interface GridLoaderGameObject extends WorldObject {
  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::LoadFromDB */
  loadFromDB(spawnId: number, map: MapLike): boolean;
}

/** @ac game/Entities/Transport/Transport.h StaticTransport (the member the loader calls) */
export interface GridLoaderStaticTransport {
  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::LoadGameObjectFromDB */
  loadGameObjectFromDB(spawnId: number, map: MapLike, addToMap?: boolean): boolean;
}

/**
 * What the loader takes from other topics. The integration code sets them at startup.
 * - `objectMgr`: `sObjectMgr` (null until set: no spawns are loaded)
 * - `createCreature`: `new Creature()`
 * - `createGameObject`: `new GameObject()`
 * - `createStaticTransport`: `new StaticTransport()` (@ac-skip until transports are ported: null skips the spawn,
 *   which is what the C++ does when `LoadGameObjectFromDB` fails; static transports are not stored in the grid anyway)
 */
export const GridObjectLoaderHooks: {
  objectMgr: GridObjectLoaderObjectMgr | null;
  createCreature: (() => GridLoaderCreature) | null;
  createGameObject: (() => GridLoaderGameObject) | null;
  createStaticTransport: (() => GridLoaderStaticTransport) | null;
} = {
  objectMgr: null,
  createCreature: null,
  createGameObject: null,
  createStaticTransport: null,
};

const EMPTY_CELL_OBJECT_GUIDS: CellObjectGuids = { creatures: [], gameobjects: [] };

/** The deletion side of a grid object (`CleanupsBeforeDelete` and the C++ `delete`). */
type DeletableGridObject = GridStoredObject & {
  cleanupsBeforeDelete(finalCleanup?: boolean): void;
};

/**
 * @ac game/Grids/GridObjectLoader.h GridObjectLoader
 * `Map::AddToGrid` stores the object and `AddToWorld` links it into the map. The `MapLike` is the C++ `Map*`.
 */
export class GridObjectLoader {
  /** @ac game/Grids/GridObjectLoader.h GridObjectLoader::GridObjectLoader */
  constructor(
    private readonly _grid: MapGrid,
    private readonly _map: MapLike,
  ) {}

  /** @ac game/Grids/GridObjectLoader.cpp GridObjectLoader::AddObjectHelper */
  private addObjectHelper(map: MapLike, obj: WorldObject): void {
    const cellCoord = ComputeCellCoord(obj.getPositionX(), obj.getPositionY());
    const cell = new Cell(cellCoord);

    map.addToGrid(obj as GridStoredObject, cell);
    obj.addToWorld();
  }

  /**
   * @ac game/Grids/GridObjectLoader.cpp GridObjectLoader::LoadCreatures
   * A failed `LoadFromDB` drops the new object (the C++ `delete obj`).
   */
  private loadCreatures(guid_set: CellGuidSet, map: MapLike): void {
    const objectMgr = GridObjectLoaderHooks.objectMgr;
    const createCreature = GridObjectLoaderHooks.createCreature;
    if (!objectMgr || !createCreature) return;

    for (const guid of guid_set) {
      // Skip spawns whose spawn group is not active on this map
      const cData = objectMgr.getCreatureData(guid);
      if (cData && !map.isSpawnGroupActive(cData.spawnGroupId)) continue;

      // Skip pool members this map's pool state has not rolled as spawned
      if (cData && cData.poolId && !map.getPoolData().isSpawnedObject("Creature", guid)) continue;

      const obj = createCreature();
      if (!obj.loadFromDB(guid, map)) continue;

      this.addObjectHelper(map, obj);

      // Grid load bypasses Map::AddToMap, so seat accessories here.
      const vehicle = obj.getVehicleKit();
      if (vehicle) vehicle.reset();

      if (!obj.isMoveInLineOfSightDisabled() && obj.getDefaultMovementType() === IDLE_MOTION_TYPE && !obj.isNeedNotify(NOTIFY_VISIBILITY_CHANGED | NOTIFY_AI_RELOCATION)) {
        if (obj.isAlive() && !obj.hasUnitState(UNIT_STATE_SIGHTLESS) && obj.hasReactState(REACT_AGGRESSIVE) && !obj.isImmuneToNPC()) {
          // call MoveInLineOfSight for nearby grid creatures
          const notifier = new AIRelocationNotifier(obj);
          Cell.visitObjects(obj, notifier, 60.0);
        }
      }
    }
  }

  /**
   * @ac game/Grids/GridObjectLoader.cpp GridObjectLoader::LoadGameObjects
   * Static transports load through `GridObjectLoaderHooks.createStaticTransport` and are not stored in the grid.
   */
  private loadGameObjects(guid_set: CellGuidSet, map: MapLike): void {
    const objectMgr = GridObjectLoaderHooks.objectMgr;
    const createGameObject = GridObjectLoaderHooks.createGameObject;
    if (!objectMgr || !createGameObject) return;

    for (const guid of guid_set) {
      const data = objectMgr.getGameObjectData(guid);

      // Skip spawns whose spawn group is not active on this map
      if (data && !map.isSpawnGroupActive(data.spawnGroupId)) continue;

      // Skip pool members this map's pool state has not rolled as spawned
      if (data && data.poolId && !map.getPoolData().isSpawnedObject("GameObject", guid)) continue;

      if (data && objectMgr.isGameObjectStaticTransport(data.id)) {
        // Special case for static transports - we are loaded via grids
        // but we do not want to actually be stored in the grid
        const transport = GridObjectLoaderHooks.createStaticTransport?.() ?? null;
        transport?.loadGameObjectFromDB(guid, map, true);
      } else {
        const obj = createGameObject();

        if (!obj.loadFromDB(guid, map)) continue;

        this.addObjectHelper(map, obj);
      }
    }
  }

  /** @ac game/Grids/GridObjectLoader.cpp GridObjectLoader::LoadAllCellsInGrid */
  loadAllCellsInGrid(): void {
    const cell_guids = GridObjectLoaderHooks.objectMgr?.getGridObjectGuids(this._map.getId(), this._map.getSpawnMode(), this._grid.getId()) ?? EMPTY_CELL_OBJECT_GUIDS;
    this.loadGameObjects(cell_guids.gameobjects, this._map);
    this.loadCreatures(cell_guids.creatures, this._map);

    const corpses = this._map.getCorpsesInGrid(this._grid.getId());
    if (corpses) {
      for (const corpse of corpses) {
        if (corpse.isInGrid()) continue;

        this.addObjectHelper(this._map, corpse);
      }
    }
  }
}

/**
 * @ac game/Grids/GridObjectLoader.h GridObjectCleaner
 * Clean up and remove from world. `Visit(PlayerMapType&)` is empty: players are not visited.
 */
export class GridObjectCleaner implements GridTypeMapVisitor {
  /** @ac game/Grids/GridObjectLoader.cpp GridObjectCleaner::Visit */
  private visitAny<T extends GridStoredObject>(m: GridRefMgr<T>): void {
    for (const obj of m) (obj as DeletableGridObject).cleanupsBeforeDelete();
  }

  visitGameObjectMap(m: GameObjectMapType): void {
    this.visitAny(m);
  }

  visitCreatureMap(m: CreatureMapType): void {
    this.visitAny(m);
  }

  visitCorpseMap(m: CorpseMapType): void {
    this.visitAny(m);
  }

  visitDynamicObjectMap(m: DynamicObjectMapType): void {
    this.visitAny(m);
  }

  /** @ac game/Grids/GridObjectLoader.h GridObjectCleaner::Visit (`PlayerMapType&`: nothing) */
  visitPlayerMap(_m: PlayerMapType): void {}
}

/**
 * @ac game/Grids/GridObjectLoader.h GridObjectUnloader
 * Delete objects before deleting NGrid. Corpses are deleted with the Map and players are not visited.
 */
export class GridObjectUnloader implements GridTypeMapVisitor {
  /**
   * @ac game/Grids/GridObjectLoader.cpp GridObjectUnloader::Visit
   * The C++ `delete obj` runs `~GridReference`, which unlinks the object from the cell; that unlink is done here.
   * @ac-skip `sScriptMgr->OnWorldObjectDestroy` / `OnDestructObject` in the destructors: ScriptMgr is not ported.
   */
  private visitAny<T extends GridStoredObject>(m: GridRefMgr<T>): void {
    while (!m.isEmpty()) {
      const obj = m.getFirst()!.getSource()! as DeletableGridObject;
      // if option set then object already saved at this moment
      //if (!sWorld->getBoolConfig(CONFIG_SAVE_RESPAWN_TIME_IMMEDIATELY))
      //    obj->SaveRespawnTime();
      //Some creatures may summon other temp summons in CleanupsBeforeDelete()
      //So we need this even after cleaner (maybe we can remove cleaner)
      //Example: Flame Leviathan Turret 33139 is summoned when a creature is deleted
      //TODO: Check if that script has the correct logic. Do we really need to summons something before deleting?
      obj.cleanupsBeforeDelete();

      obj.getMap().removeObjectFromMapUpdateList(obj);

      ///- object will get delinked from the manager when deleted
      if (obj.isInGrid()) obj.removeFromGrid();
    }
  }

  visitGameObjectMap(m: GameObjectMapType): void {
    this.visitAny(m);
  }

  visitCreatureMap(m: CreatureMapType): void {
    this.visitAny(m);
  }

  visitDynamicObjectMap(m: DynamicObjectMapType): void {
    this.visitAny(m);
  }

  /** @ac game/Grids/GridObjectLoader.h GridObjectUnloader::Visit (`CorpseMapType&`: corpses are deleted with Map) */
  visitCorpseMap(_m: CorpseMapType): void {}

  /** @ac game/Grids/GridObjectLoader.h GridObjectUnloader::Visit (`PlayerMapType&`: nothing) */
  visitPlayerMap(_m: PlayerMapType): void {}
}
