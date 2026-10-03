/**
 * Test fakes for the grid layer: a `MapLike` map backed by the real `MapGridManager`; creatures, gameobjects, and corpses
 * as subclasses of the real `Creature`, `GameObject`, and `Corpse` classes (they load from `FakeObjectMgr` instead of the
 * world tables); and players as `WorldObject` subclasses with just the members the grid code calls (`Player` is not a
 * class that fits the grid layer yet).
 */
import { Corpse } from "../Entities/Corpse/Corpse.ts";
import { Creature, DeathState } from "../Entities/Creature/Creature.ts";
import { GameObject } from "../Entities/GameObject/GameObject.ts";
import { WorldObject } from "../Entities/Object/Object.ts";
import {
  HighGuid,
  TYPEID_CORPSE,
  TYPEID_GAMEOBJECT,
  TYPEID_PLAYER,
  TYPEID_UNIT,
  TYPEMASK_PLAYER,
  TYPEMASK_UNIT,
  type TypeID,
} from "../Entities/Object/ObjectGuid.ts";
import type { PositionLike } from "../Entities/Object/Position.ts";
import type { UpdateData, WorldPacket } from "../Entities/Object/Updates/UpdateData.ts";
import type { GridPlayer, GridPlayerSession, UnitLike } from "./GridPlayer.ts";
import type { CellObjectGuids, GridLoaderCreature, GridLoaderGameObject, GridLoaderSpawnData, GridObjectLoaderObjectMgr } from "./GridObjectLoader.ts";
import { Cell } from "./Cells/Cell.ts";
import { GridCoord } from "./GridDefines.ts";
import { GridRefMgr } from "./GridRefMgr.ts";
import type { MapGrid } from "./MapGrid.ts";
import { MapGridManager } from "./MapGridManager.ts";
import { emptyLiquidData, type CreatureBySpawnIdContainer, type MapLike, type PositionFullTerrainStatusLike, type SpawnedPoolDataLike } from "./MapLike.ts";
import type { ContainerType, FarVisibleObject, GridStoredObject, TypeContainerVisitor } from "./TypeContainer.ts";

/** Enough value fields for any object type (`PLAYER_END` is 0x49a). */
const FAKE_VALUES_COUNT = 0x500;

/** A grid object with a type, a guid, a position, and a phase mask. */
export class FakeObject extends WorldObject {
  cleanupsCalls = 0;

  constructor(typeId: TypeID, typeMask: number, high: HighGuid, guidLow: number, x: number, y: number, z = 0, phaseMask = 1) {
    super();
    this.m_objectTypeId = typeId;
    this.m_objectType |= typeMask;
    this.m_valuesCount = FAKE_VALUES_COUNT;
    this._CreateWorldObject(guidLow, high, phaseMask);
    this.relocate(x, y, z, 0);
  }

  override cleanupsBeforeDelete(finalCleanup = true): void {
    ++this.cleanupsCalls;
    super.cleanupsBeforeDelete(finalCleanup);
  }
}

/** The `Unit` members (`UnitLike`) with neutral values. */
export class FakeUnit extends FakeObject implements UnitLike {
  m_last_notify_mstime = 0;
  m_delayed_unit_relocation_timer = 0;
  m_delayed_unit_ai_notify_timer = 0;
  alive = true;
  sharedVision: GridPlayer[] = [];

  isAlive(): boolean {
    return this.alive;
  }
  getHoverHeight(): number {
    return 0;
  }
  canFly(): boolean {
    return false;
  }
  isInWater(): boolean {
    return false;
  }
  hasWaterWalkAura(): boolean {
    return false;
  }
  getCharmerOrOwner(): UnitLike | null {
    return null;
  }
  getVehicleBase(): UnitLike | null {
    return null;
  }
  isCharmedOwnedByPlayerOrPlayer(): boolean {
    return this.isPlayer();
  }
  isInFlight(): boolean {
    return false;
  }
  hasStealthAura(): boolean {
    return false;
  }
  hasUnitState(_state: number): boolean {
    return false;
  }
  hasAuraTypeWithMiscvalue(_auraType: number, _miscValue: number): boolean {
    return false;
  }
  hasUnitMovementFlag(_f: number): boolean {
    return false;
  }
  isWalking(): boolean {
    return false;
  }
  getSpeed(_mtype: number): number {
    return 7;
  }
  hasSharedVision(): boolean {
    return this.sharedVision.length > 0;
  }
  getSharedVisionList(): readonly GridPlayer[] {
    return this.sharedVision;
  }
}

/** A spawn row of the fake spawn store. */
export interface FakeSpawn extends GridLoaderSpawnData {
  guid: number;
  map: number;
  x: number;
  y: number;
  z: number;
  phaseMask: number;
  /** `LoadFromDB` fails for this row. */
  failLoad?: boolean;
}

/** A creature that loads itself from `FakeObjectMgr` like `Creature::LoadFromDB`. */
export class FakeCreature extends Creature {
  cleanupsCalls = 0;
  loadedFrom: FakeSpawn | null = null;
  moveInLineOfSightCalls: UnitLike[] = [];
  sharedVision: GridPlayer[] = [];

  constructor(
    private readonly store: FakeObjectMgr,
    guidLow = 0,
    x = 0,
    y = 0,
    z = 0,
    phaseMask = 1,
  ) {
    super();
    this._CreateWorldObject(guidLow, HighGuid.Unit, phaseMask);
    this.relocate(x, y, z, 0);
  }

  get alive(): boolean {
    return this.getDeathState() === DeathState.Alive;
  }
  set alive(value: boolean) {
    this.m_deathState = value ? DeathState.Alive : DeathState.Dead;
  }

  override cleanupsBeforeDelete(finalCleanup = true): void {
    ++this.cleanupsCalls;
    super.cleanupsBeforeDelete(finalCleanup);
  }

  override loadFromDB(spawnId: number, map: MapLike, _allowDuplicate = false): boolean {
    const row = this.store.creatures.get(spawnId);
    if (!row || row.failLoad) return false;
    this._CreateWorldObject(spawnId, HighGuid.Unit, row.phaseMask);
    this.relocate(row.x, row.y, row.z, 0);
    this.setMap(map);
    this.loadedFrom = row;
    return true;
  }
  override isMoveInLineOfSightDisabled(): boolean {
    return true;
  }
  override isMoveInLineOfSightStrictlyDisabled(): boolean {
    return true;
  }
  override getDefaultMovementType(): number {
    return 0;
  }
  override hasReactState(_state: number): boolean {
    return false;
  }
  override isImmuneToNPC(): boolean {
    return false;
  }
  override hasSharedVision(): boolean {
    return this.sharedVision.length > 0;
  }
  override getSharedVisionList(): readonly GridPlayer[] {
    return this.sharedVision;
  }
}

/** A gameobject that loads itself from `FakeObjectMgr` like `GameObject::LoadFromDB`. */
export class FakeGameObject extends GameObject {
  cleanupsCalls = 0;
  loadedFrom: FakeSpawn | null = null;

  constructor(
    private readonly store: FakeObjectMgr,
    guidLow = 0,
    x = 0,
    y = 0,
    z = 0,
    phaseMask = 1,
  ) {
    super();
    this._CreateWorldObject(guidLow, HighGuid.GameObject, phaseMask);
    this.relocate(x, y, z, 0);
  }

  override cleanupsBeforeDelete(finalCleanup = true): void {
    ++this.cleanupsCalls;
    super.cleanupsBeforeDelete(finalCleanup);
  }

  override loadFromDB(spawnId: number, map: MapLike): boolean {
    const row = this.store.gameobjects.get(spawnId);
    if (!row || row.failLoad) return false;
    this._CreateWorldObject(spawnId, HighGuid.GameObject, row.phaseMask);
    this.relocate(row.x, row.y, row.z, 0);
    this.setMap(map);
    this.loadedFrom = row;
    return true;
  }
}

/** A corpse (`Map::GetCorpsesInGrid`). */
export class FakeCorpse extends Corpse {
  cleanupsCalls = 0;

  constructor(guidLow: number, x: number, y: number) {
    super();
    this._CreateWorldObject(guidLow, HighGuid.Corpse, 1);
    this.relocate(x, y, 0, 0);
  }

  override cleanupsBeforeDelete(finalCleanup = true): void {
    ++this.cleanupsCalls;
    super.cleanupsBeforeDelete(finalCleanup);
  }
}

/**
 * A player: `UpdateVisibilityOf` is the C++ `Player::UpdateVisibilityOf(T*, UpdateData&, std::vector<Unit*>&)` template
 * over the real `CanSeeOrDetect` and `ObjectVisibilityContainer`; packets are recorded.
 */
export class FakePlayer extends FakeUnit implements GridPlayer {
  m_seer: WorldObject = this;
  m_newVisible: UnitLike[] = [];
  teamId = 0;
  received: WorldPacket[] = [];
  initialVisiblePackets: UnitLike[] = [];
  private readonly session: GridPlayerSession = { getSessionDbLocaleIndex: () => 0 };

  constructor(guidLow: number, x: number, y: number, z = 0, phaseMask = 1) {
    super(TYPEID_PLAYER, TYPEMASK_PLAYER | TYPEMASK_UNIT, HighGuid.Player, guidLow, x, y, z, phaseMask);
    this.getObjectVisibilityContainer().initForPlayer();
  }

  getSession(): GridPlayerSession {
    return this.session;
  }
  getTeamId(): number {
    return this.teamId;
  }
  isGameMaster(): boolean {
    return false;
  }
  isSpectator(): boolean {
    return false;
  }
  isDead(): boolean {
    return !this.alive;
  }
  getHealth(): number {
    return 1;
  }
  getCorpse(): null {
    return null;
  }
  getSightPosition(): PositionLike {
    return this.m_seer;
  }
  getFarSightDistance(): number | null {
    return null;
  }
  isGroupVisibleFor(_p: GridPlayer): boolean {
    return false;
  }
  haveAtClient(u: WorldObject | bigint): boolean {
    const guid = typeof u === "bigint" ? u : u.getGUID();
    return guid === this.getGUID() || (this.getObjectVisibilityContainer().getVisibleWorldObjectsMap()?.has(guid) ?? false);
  }
  isWorldObjectOutOfSightRange(target: WorldObject): boolean {
    return !this.m_seer.isWithinDist(target, this.getSightRange(target), false);
  }
  updateVisibilityOf(target: WorldObject, data?: UpdateData, visibleNow?: UnitLike[]): void {
    if (!data || !visibleNow) return;
    this.getMap().addObjectToPendingUpdateList(target);

    if (this.haveAtClient(target)) {
      if (!this.canSeeOrDetect(target, false, true)) {
        target.buildOutOfRangeUpdateBlock(data);
        this.getObjectVisibilityContainer().unlinkWorldObjectVisibility(target);
      }
    } else if (this.canSeeOrDetect(target, false, true)) {
      target.buildCreateUpdateBlockForPlayer(data, this);
      this.getObjectVisibilityContainer().linkWorldObjectVisibility(target);
      if (target.isUnit()) visibleNow.push(target as unknown as UnitLike);
    }
  }
  getInitialVisiblePackets(target: UnitLike): void {
    this.initialVisiblePackets.push(target);
  }
  sendDirectMessage(data: WorldPacket): void {
    this.received.push(data);
  }
  getVehicle(): null {
    return null;
  }
}

/** The spawn store (`ObjectMgr::_mapObjectGuidsStore`, `_creatureDataStore`, `_gameObjectDataStore`). */
export class FakeObjectMgr implements GridObjectLoaderObjectMgr {
  readonly creatures = new Map<number, FakeSpawn>();
  readonly gameobjects = new Map<number, FakeSpawn>();
  readonly staticTransportEntries = new Set<number>();
  private readonly cells = new Map<string, { creatures: number[]; gameobjects: number[] }>();

  /** `ObjectMgr::AddCreatureToGrid` / `AddGameobjectToGrid` keyed by the grid id of the spawn position. */
  add(kind: "creature" | "gameobject", spawn: FakeSpawn, spawnMode: number, gridId: number): void {
    (kind === "creature" ? this.creatures : this.gameobjects).set(spawn.guid, spawn);
    const key = `${spawn.map}:${spawnMode}:${gridId}`;
    let cell = this.cells.get(key);
    if (!cell) this.cells.set(key, (cell = { creatures: [], gameobjects: [] }));
    (kind === "creature" ? cell.creatures : cell.gameobjects).push(spawn.guid);
    cell.creatures.sort((a, b) => a - b);
    cell.gameobjects.sort((a, b) => a - b);
  }

  getGridObjectGuids(mapid: number, spawnMode: number, gridId: number): CellObjectGuids {
    return this.cells.get(`${mapid}:${spawnMode}:${gridId}`) ?? { creatures: [], gameobjects: [] };
  }
  getCreatureData(spawnId: number): GridLoaderSpawnData | null {
    return this.creatures.get(spawnId) ?? null;
  }
  getGameObjectData(spawnId: number): GridLoaderSpawnData | null {
    return this.gameobjects.get(spawnId) ?? null;
  }
  isGameObjectStaticTransport(entry: number): boolean {
    return this.staticTransportEntries.has(entry);
  }
}

/** A map id with no `.map` file, so `GridTerrainLoader` finds no terrain. */
export const FAKE_MAP_ID = 9999;

/**
 * A `Map` with the grid side of the C++ class: `Map::Visit`, `Map::AddToGrid`, `EnsureGridCreated` /
 * `EnsureGridLoaded` over a real `MapGridManager`. Everything else is a recorder or a neutral value.
 */
export class FakeMap extends GridRefMgr<MapGrid> implements MapLike {
  readonly gridManager = new MapGridManager(this);
  readonly corpsesByGrid = new Map<number, Set<Corpse>>();
  readonly spawnGroupsInactive = new Set<number>();
  readonly unspawnedPoolMembers = new Set<string>();
  readonly removeList: WorldObject[] = [];
  readonly removedFromUpdateList: WorldObject[] = [];
  readonly pendingUpdate = new Set<WorldObject>();
  removeAllObjectsInRemoveListCalls = 0;
  parent: FakeMap = this;
  visibilityRange = 100;

  constructor(
    readonly id = FAKE_MAP_ID,
    readonly instanceId = 0,
    readonly spawnMode = 0,
  ) {
    super();
  }

  getId(): number {
    return this.id;
  }
  getInstanceId(): number {
    return this.instanceId;
  }
  getSpawnMode(): number {
    return this.spawnMode;
  }
  getEntry(): null {
    return null;
  }
  getParent(): MapLike {
    return this.parent;
  }
  isDungeon(): boolean {
    return false;
  }
  isBattleArena(): boolean {
    return false;
  }
  isBattlegroundOrArena(): boolean {
    return false;
  }
  getVisibilityRange(): number {
    return this.visibilityRange;
  }
  getMapName(): string {
    return "FakeMap";
  }

  /** @ac game/Maps/Map.h Map::Visit (if grid is not loaded, nothing to visit) */
  visit(cell: Cell, visitor: TypeContainerVisitor<ContainerType>): void {
    if (!this.gridManager.isGridLoaded(cell.gridX(), cell.gridY())) return;
    this.gridManager.getGrid(cell.gridX(), cell.gridY())!.visitCell(cell.cellX(), cell.cellY(), visitor);
  }
  /** @ac game/Maps/Map.cpp Map::EnsureGridCreated */
  ensureGridCreated(gridCoord: GridCoord): void {
    this.gridManager.createGrid(gridCoord.x_coord, gridCoord.y_coord);
  }
  /** @ac game/Maps/Map.cpp Map::EnsureGridLoaded (without `Balance()`) */
  ensureGridLoaded(cell: Cell): boolean {
    this.ensureGridCreated(new GridCoord(cell.gridX(), cell.gridY()));
    return this.gridManager.loadGrid(cell.gridX(), cell.gridY());
  }
  /** @ac game/Maps/Map.cpp Map::AddToGrid (the Creature, GameObject, Player, and Corpse specializations) */
  addToGrid(obj: GridStoredObject, cell: Cell): void {
    const grid = this.gridManager.getGrid(cell.gridX(), cell.gridY())!;
    if (obj.getTypeId() === TYPEID_CORPSE) {
      if (grid.isObjectDataLoaded()) grid.addGridObject(cell.cellX(), cell.cellY(), obj);
      return;
    }
    grid.addGridObject(cell.cellX(), cell.cellY(), obj);
    if (obj.getTypeId() === TYPEID_PLAYER) return;
    if ((obj.getTypeId() === TYPEID_UNIT || obj.getTypeId() === TYPEID_GAMEOBJECT) && obj.isFarVisible()) {
      grid.addFarVisibleObject(cell.cellX(), cell.cellY(), obj as FarVisibleObject);
    }
    obj.setCurrentCell(cell);
  }
  /** Puts an object on this map and into its cell (`Map::AddToMap` without visibility updates). */
  place(obj: WorldObject): void {
    obj.setMap(this);
    const cell = new Cell(obj.getPositionX(), obj.getPositionY());
    this.ensureGridLoaded(cell);
    this.addToGrid(obj as GridStoredObject, cell);
    obj.addToWorld();
  }
  getCorpsesInGrid(gridId: number): ReadonlySet<Corpse> | null {
    return this.corpsesByGrid.get(gridId) ?? null;
  }
  removeAllObjectsInRemoveList(): void {
    ++this.removeAllObjectsInRemoveListCalls;
    this.removeList.length = 0;
  }
  addObjectToRemoveList(obj: WorldObject): void {
    this.removeList.push(obj);
  }
  addObjectToPendingUpdateList(obj: WorldObject): void {
    this.pendingUpdate.add(obj);
  }
  removeObjectFromMapUpdateList(obj: WorldObject): void {
    this.removedFromUpdateList.push(obj);
    this.pendingUpdate.delete(obj);
  }
  addUpdateObject(): void {}
  removeUpdateObject(): void {}
  isCellMarked(): boolean {
    return false;
  }

  generateLowGuid(): number {
    return 0;
  }
  isSpawnGroupActive(groupId: number): boolean {
    return !this.spawnGroupsInactive.has(groupId);
  }
  getPoolData(): SpawnedPoolDataLike {
    return { isSpawnedObject: (type, guid) => !this.unspawnedPoolMembers.has(`${type}:${guid}`) };
  }
  getCreatureBySpawnIdStore(): CreatureBySpawnIdContainer {
    return new Map();
  }
  getCreatureRespawnTime(): number {
    return 0;
  }
  getGORespawnTime(): number {
    return 0;
  }
  removeGORespawnTime(): void {}

  addWorldObjectToFarVisibleMap(): void {}
  removeWorldObjectFromFarVisibleMap(): void {}
  addWorldObjectToZoneWideVisibleMap(): void {}
  removeWorldObjectFromZoneWideVisibleMap(): void {}
  getZoneWideVisibleWorldObjectsForZone(): null {
    return null;
  }

  getGridTerrainDataSharedPtr(): null {
    return null;
  }
  getMapCollisionData(): { loadVMapTile(x: number, y: number): number; loadMMapTile(x: number, y: number): number } {
    return { loadVMapTile: () => 2, loadMMapTile: () => 2 };
  }
  getZoneAndAreaId(): { zoneid: number; areaid: number } {
    return { zoneid: 0, areaid: 0 };
  }
  getFullTerrainStatusForPosition(): PositionFullTerrainStatusLike {
    return { areaId: 0, floorZ: 0, outdoors: true, liquidInfo: emptyLiquidData() };
  }
  getHeight(): number {
    return 0;
  }
  getWaterOrGroundLevel(): number {
    return 0;
  }
  isInWater(): boolean {
    return false;
  }
  getGameObjectFloor(): number {
    return 0;
  }
  isInLineOfSight(): boolean {
    return true;
  }
  checkCollisionAndGetValidCoords(): boolean {
    return true;
  }
}
