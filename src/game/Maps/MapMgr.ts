/**
 * @ac game/Maps/MapMgr.h
 * @ac game/Maps/MapMgr.cpp
 * @ac-skip game/Maps/MapMgr.cpp MapMgr::~MapMgr: empty in C++ (`unloadAll` is what shuts the maps down)
 * @ac-skip game/Maps/MapMgr.h MapMgr::LoadGrid: commented out in the C++ header
 *
 * `MapMgr`: the world's maps. `i_maps` holds one base map per map id (a `Map` for a world map, a `MapInstanced` that owns the
 * instances for a dungeon, raid, battleground, or arena); `CreateMap` returns the map a player goes to, `Update` ticks them in
 * the same four steps as the C++ (continents, battlegrounds and arenas, instances, then the idle remainder of the update
 * interval), and the instance id generator hands out the ids of new instances.
 *
 * The static helpers (`IsValidMAP`, `IsValidMapCoord`, `NormalizeOrientation`) live in `MapMgrStatics.ts` so the grids can use
 * them without importing `Map`; they are re-exported here. `getHeight` and `getWaterLevel` below are the functions the chat
 * commands call: they read the base map of a map id (`MapMgr::CreateBaseMap(mapId)->GetHeight(x, y, z)`).
 */
import { queryFields, type Db } from "../../database/database.ts";
import { CharacterDatabase } from "../../database/DatabaseEnv.ts";
import { logError } from "../../log.ts";
import { sMapStore } from "../DataStores/DBCStores.ts";
import {
  MapEntryInstanceable,
  MapEntryIsDungeon,
  MapEntryIsRaid,
  MapEntryIsNonRaidDungeon,
  REGULAR_DIFFICULTY,
  GetDownscaledMapDifficultyData,
} from "../DataStores/MapDBCStores.ts";
import { ComputeGridCoord, MIN_MAP_UPDATE_DELAY } from "../Grids/GridDefines.ts";
import { GridTerrainLoader } from "../Grids/GridTerrainLoader.ts";
import { IntervalTimer } from "../time/timer.ts";
import { ServerConfig } from "../world/world-config-data.ts";
import { ShutdownExitCode, sWorld } from "../world/world.ts";
import {
  CANNOT_ENTER_CORPSE_IN_DIFFERENT_INSTANCE,
  CANNOT_ENTER_DIFFICULTY_UNAVAILABLE,
  CANNOT_ENTER_NO_ENTRY,
  CANNOT_ENTER_NOT_IN_RAID,
  CANNOT_ENTER_TOO_MANY_INSTANCES,
  CANNOT_ENTER_UNINSTANCED_DUNGEON,
  CANNOT_ENTER_UNSPECIFIED_REASON,
  CAN_ENTER,
  Map,
  MapHooks,
  type EnterState,
  type MapPlayer,
  type MapPlayerExtras,
} from "./Map.ts";
import { MapInstanced } from "./MapInstanced.ts";
import { GetInstanceTemplate } from "./MapMgrStatics.ts";
import { MapUpdater } from "./MapUpdater.ts";
import { StdMap } from "./StdMap.ts";

export {
  GetInstanceTemplate,
  InstanceTemplateHooks,
  MAP_HALFSIZE,
  MAP_SIZE,
  MAX_NUMBER_OF_GRIDS,
  SIZE_OF_GRIDS,
  isValidCoord,
  isValidMAP,
  isValidMapCoord,
  normalizeOrientation,
  setMapMgrWorld,
  type InstanceTemplate,
} from "./MapMgrStatics.ts";
export { INVALID_HEIGHT, MAX_HEIGHT } from "../Grids/GridTerrainData.ts";

/** @ac game/Entities/Player/Player.h TransferAbortReason */
const TRANSFER_ABORT_DIFFICULTY = 0x08;
const TRANSFER_ABORT_TOO_MANY_INSTANCES = 0x04;
const TRANSFER_ABORT_MAP_NOT_ALLOWED = 0x10;
/** @ac game/Opcodes SMSG_CORPSE_NOT_IN_INSTANCE */
const SMSG_CORPSE_NOT_IN_INSTANCE = 0x506;
/** @ac game/Server/Packets/ChatPackets LANG_INSTANCE_RAID_GROUP_ONLY (the `acore_string` entry) */
const LANG_INSTANCE_RAID_GROUP_ONLY = 750;

/** The `Group` members `PlayerCannotEnter` reads (groups are not ported; the player's optional `getGroup`). */
interface MapGroupLike {
  isRaidGroup?(): boolean;
  isLFGGroup?(): boolean;
  isLfgRandomInstance?(): boolean;
}

/** The players members only `PlayerCannotEnter` calls. */
interface MapEntryPlayerExtras extends MapPlayerExtras {
  hasCorpse(): boolean;
  getCorpseLocation(): { getMapId(): number };
  checkInstanceCount(instanceId: number): boolean;
  satisfy(accessRequirement: unknown, mapid: number, report: boolean): boolean;
  sendAreaTriggerMessage(stringId: number, mapName: string): void;
}

/** A `Position const&` / `WorldLocation const&` argument of `MapMgr::GetAreaId` and `GetZoneId`. */
interface MapMgrPosition {
  getPositionX(): number;
  getPositionY(): number;
  getPositionZ(): number;
}
interface MapMgrLocation extends MapMgrPosition {
  getMapId(): number;
}

function positionArguments(a: number | MapMgrLocation, b?: number | MapMgrPosition, c?: number, d?: number): { mapid: number; x: number; y: number; z: number } {
  if (typeof a === "object") return { mapid: a.getMapId(), x: a.getPositionX(), y: a.getPositionY(), z: a.getPositionZ() };
  if (typeof b === "object") return { mapid: a, x: b.getPositionX(), y: b.getPositionY(), z: b.getPositionZ() };
  return { mapid: a, x: b as number, y: c!, z: d! };
}

/** @ac game/Maps/MapMgr.h MapMgr */
export class MapMgr {
  /** @ac game/Maps/MapMgr.h MapMgr::instance */
  private static _instance: MapMgr | null = null;

  static instance(): MapMgr {
    return (MapMgr._instance ??= new MapMgr());
  }

  /** @ac game/Maps/MapMgr.h MapMgr::MapMapType */
  private readonly i_maps = new StdMap<number, Map>();
  /** continents, bgs/arenas, instances, total from the beginning */
  private readonly i_timer = [new IntervalTimer(), new IntervalTimer(), new IntervalTimer(), new IntervalTimer()];
  private mapUpdateStep = 0;

  private _instanceIds: boolean[] = [];
  private _nextInstanceId = 0;
  private readonly m_updater = new MapUpdater((mapId) => this.createBaseMap(mapId));

  /** @ac game/Maps/MapMgr.cpp MapMgr::MapMgr */
  constructor() {
    this.i_timer[3]!.setInterval(sWorld().getIntConfig(ServerConfig.CONFIG_INTERVAL_MAPUPDATE));
    this.mapUpdateStep = 0;
    this._nextInstanceId = 0;
  }

  /**
   * @ac game/Maps/MapMgr.cpp MapMgr::Initialize
   * @ac-skip threads: `MapUpdate.Threads` (`CONFIG_NUMTHREADS`) starts worker threads for the C++ `MapUpdater`; here maps are
   * updated inline, so the updater is not activated.
   */
  initialize(): void {
    const num_threads = sWorld().getIntConfig(ServerConfig.CONFIG_NUMTHREADS);

    // Start mtmaps if needed
    if (num_threads > 0) this.m_updater.activate(num_threads);
  }

  /** @ac game/Maps/MapMgr.cpp MapMgr::InitializeVisibilityDistanceInfo */
  initializeVisibilityDistanceInfo(): void {
    for (const map of this.i_maps.values()) map.initVisibilityDistance();
  }

  /** @ac game/Maps/MapMgr.cpp MapMgr::CreateBaseMap */
  createBaseMap(id: number): Map {
    let map = this.findBaseMap(id);

    if (!map) {
      // (`std::lock_guard<std::mutex> guard(Lock)`: maps update on one thread)
      const entry = sMapStore.lookupEntry(id);
      if (!entry) throw new Error(`ASSERT failed: entry (MapMgr::CreateBaseMap ${id})`);

      if (MapEntryInstanceable(entry)) map = new MapInstanced(id);
      else map = new Map(id, 0, REGULAR_DIFFICULTY);

      this.i_maps.set(id, map);

      if (!MapEntryInstanceable(entry)) {
        map.loadRespawnTimes();
        const created = map;
        void map.loadCorpseData().catch((error: unknown) => logError("maps", `Loading the corpses of map ${created.getId()} failed`, error));
      }

      map.onCreateMap();
    }

    return map;
  }

  /** @ac game/Maps/MapMgr.cpp MapMgr::FindBaseNonInstanceMap */
  findBaseNonInstanceMap(mapId: number): Map | null {
    const map = this.findBaseMap(mapId);
    if (map && map.instanceable()) return null;
    return map;
  }

  /** @ac game/Maps/MapMgr.cpp MapMgr::CreateMap */
  createMap(id: number, player: MapPlayer): Map | null {
    let m: Map | null = this.createBaseMap(id);

    if (m && m.instanceable()) m = (m as MapInstanced).createInstanceForPlayer(id, player);

    return m;
  }

  /** @ac game/Maps/MapMgr.cpp MapMgr::FindMap */
  findMap(mapid: number, instanceId: number): Map | null {
    const map = this.findBaseMap(mapid);
    if (!map) return null;

    if (!map.instanceable()) return instanceId === 0 ? map : null;

    return (map as MapInstanced).findInstanceMap(instanceId);
  }

  /** @ac game/Maps/MapMgr.h MapMgr::FindBaseMap (pussywizard: need this public for movemaps (mmaps)) */
  findBaseMap(mapId: number): Map | null {
    return this.i_maps.get(mapId) ?? null;
  }

  /**
   * @ac game/Maps/MapMgr.h MapMgr::GetAreaId
   * The `(phaseMask, mapid, x, y, z)`, `(phaseMask, mapid, Position const&)`, and `(phaseMask, WorldLocation const&)` forms.
   */
  getAreaId(phaseMask: number, mapid: number, x: number, y: number, z: number): number;
  getAreaId(phaseMask: number, mapid: number, pos: MapMgrPosition): number;
  getAreaId(phaseMask: number, loc: MapMgrLocation): number;
  getAreaId(phaseMask: number, a: number | MapMgrLocation, b?: number | MapMgrPosition, c?: number, d?: number): number {
    const at = positionArguments(a, b, c, d);
    return this.createBaseMap(at.mapid).getAreaId(phaseMask, at.x, at.y, at.z);
  }

  /** @ac game/Maps/MapMgr.h MapMgr::GetZoneId (the same three forms as `getAreaId`) */
  getZoneId(phaseMask: number, mapid: number, x: number, y: number, z: number): number;
  getZoneId(phaseMask: number, mapid: number, pos: MapMgrPosition): number;
  getZoneId(phaseMask: number, loc: MapMgrLocation): number;
  getZoneId(phaseMask: number, a: number | MapMgrLocation, b?: number | MapMgrPosition, c?: number, d?: number): number {
    const at = positionArguments(a, b, c, d);
    return this.createBaseMap(at.mapid).getZoneId(phaseMask, at.x, at.y, at.z);
  }

  /** @ac game/Maps/MapMgr.h MapMgr::GetZoneAndAreaId (the `uint32& zoneid, uint32& areaid` out parameters are the result) */
  getZoneAndAreaId(phaseMask: number, mapid: number, x: number, y: number, z: number): { zoneid: number; areaid: number } {
    return this.createBaseMap(mapid).getZoneAndAreaId(phaseMask, x, y, z);
  }

  /** @ac game/Maps/MapMgr.h MapMgr::SetMapUpdateInterval */
  setMapUpdateInterval(t: number): void {
    if (t < MIN_MAP_UPDATE_DELAY) t = MIN_MAP_UPDATE_DELAY;

    this.i_timer[3]!.setInterval(t);
    this.i_timer[3]!.reset();
  }

  /** @ac game/Maps/MapMgr.cpp MapMgr::Update */
  update(diff: number): void {
    for (let i = 0; i < 4; ++i) this.i_timer[i]!.update(diff);

    // pussywizard: lfg compatibles update, schedule before maps so it is processed from the very beginning
    this.m_updater.scheduleLfgUpdate(diff);

    for (const map of this.i_maps.values()) {
      const full =
        this.mapUpdateStep < 3 &&
        ((this.mapUpdateStep === 0 && !map.isBattlegroundOrArena() && !map.isDungeon()) ||
          (this.mapUpdateStep === 1 && map.isBattlegroundOrArena()) ||
          (this.mapUpdateStep === 2 && map.isDungeon()));
      if (this.m_updater.activated()) this.m_updater.scheduleUpdate(map, full ? this.i_timer[this.mapUpdateStep]!.getCurrent() : 0, diff);
      else map.update(full ? this.i_timer[this.mapUpdateStep]!.getCurrent() : 0, diff);
    }

    if (this.m_updater.activated()) this.m_updater.wait();

    if (this.mapUpdateStep < 3) {
      for (const map of this.i_maps.values()) {
        const full =
          (this.mapUpdateStep === 0 && !map.isBattlegroundOrArena() && !map.isDungeon()) ||
          (this.mapUpdateStep === 1 && map.isBattlegroundOrArena()) ||
          (this.mapUpdateStep === 2 && map.isDungeon());
        if (full) map.delayedUpdate(this.i_timer[this.mapUpdateStep]!.getCurrent());
      }

      this.i_timer[this.mapUpdateStep]!.setCurrent(0);
      ++this.mapUpdateStep;
    }

    if (this.mapUpdateStep === 3 && this.i_timer[3]!.passed()) {
      this.mapUpdateStep = 0;
      this.i_timer[3]!.setCurrent(0);
    }
  }

  /** @ac game/Maps/MapMgr.cpp MapMgr::DoDelayedMovesAndRemoves */
  doDelayedMovesAndRemoves(): void {}

  /** @ac game/Maps/MapMgr.cpp MapMgr::ExistMapAndVMap */
  static existMapAndVMap(mapid: number, x: number, y: number): boolean {
    const p = ComputeGridCoord(x, y);
    return GridTerrainLoader.existMap(mapid, p.x_coord, p.y_coord) && GridTerrainLoader.existVMap(mapid, p.x_coord, p.y_coord);
  }

  /** @ac game/Maps/MapMgr.cpp MapMgr::UnloadAll */
  unloadAll(): void {
    for (const [id, map] of [...this.i_maps]) {
      map.unloadAll();
      map.destroy();
      this.i_maps.delete(id);
    }

    if (this.m_updater.activated()) this.m_updater.deactivate();
  }

  /** @ac game/Maps/MapMgr.cpp MapMgr::GetNumInstances (the counters are added to the given ones, returned as the result) */
  getNumInstances(counts = { dungeons: 0, battlegrounds: 0, arenas: 0 }): { dungeons: number; battlegrounds: number; arenas: number } {
    for (const map of this.i_maps.values()) {
      const instanced = map.toMapInstanced();
      if (!instanced) continue;
      for (const instance of instanced.getInstancedMaps().values()) {
        if (instance.isDungeon()) counts.dungeons++;
        else if (instance.isBattleground()) counts.battlegrounds++;
        else if (instance.isBattleArena()) counts.arenas++;
      }
    }
    return counts;
  }

  /**
   * @ac game/Maps/MapMgr.cpp MapMgr::GetNumPlayersInInstances
   * @ac-skip Battleground: the spectator count of an arena needs `Battleground::GetSpectators` (read when the map has a bg).
   */
  getNumPlayersInInstances(counts = { dungeons: 0, battlegrounds: 0, arenas: 0, spectators: 0 }): { dungeons: number; battlegrounds: number; arenas: number; spectators: number } {
    for (const map of this.i_maps.values()) {
      const instanced = map.toMapInstanced();
      if (!instanced) continue;
      for (const instance of instanced.getInstancedMaps().values()) {
        if (instance.isDungeon()) counts.dungeons += instance.getPlayers().getSize();
        else if (instance.isBattleground()) counts.battlegrounds += instance.getPlayers().getSize();
        else if (instance.isBattleArena()) {
          let spect = 0;
          const bgmap = instance.toBattlegroundMap();
          const bg = bgmap?.getBG() ?? null;
          if (bg) spect = bg.getSpectators().size;

          counts.arenas += instance.getPlayers().getSize() - spect;
          counts.spectators += spect;
        }
      }
    }
    return counts;
  }

  /** @ac game/Maps/MapMgr.h MapMgr::GetInstanceIDs */
  getInstanceIDs(): boolean[] {
    return this._instanceIds;
  }

  /** @ac game/Maps/MapMgr.cpp MapMgr::InitInstanceIds (`SELECT MAX(id) FROM instance`) */
  async initInstanceIds(db: Db = CharacterDatabase()): Promise<void> {
    this._nextInstanceId = 1;

    const result = await queryFields(db, "SELECT MAX(id) FROM instance");
    const row = result[0];
    if (row && row[0] !== null && row[0] !== undefined) {
      const maxId = Number(row[0]);
      this._instanceIds = new Array<boolean>(maxId + 1).fill(false);
    }
  }

  /** @ac game/Maps/MapMgr.cpp MapMgr::RegisterInstanceId */
  registerInstanceId(instanceId: number): void {
    // Allocation was done in InitInstanceIds()
    this._instanceIds[instanceId] = true;

    // Instances are pulled in ascending order from db and _nextInstanceId is initialized with 1,
    // so if the instance id is used, increment
    if (this._nextInstanceId === instanceId) ++this._nextInstanceId;
  }

  /**
   * @ac game/Maps/MapMgr.cpp MapMgr::GenerateInstanceId
   * @ac-skip ToCloud9 sidecar: cluster mode has its own instance guid generator.
   */
  generateInstanceId(): number {
    const newInstanceId = this._nextInstanceId;

    // find the lowest available id starting from the current _nextInstanceId
    while (this._nextInstanceId < 0xffffffff && ++this._nextInstanceId < this._instanceIds.length && this._instanceIds[this._nextInstanceId]);

    if (this._nextInstanceId === 0xffffffff) {
      logError("server", "Instance ID overflow!! Can't continue, shutting down server. ");
      sWorld().stopNow(ShutdownExitCode.Error);
    }

    return newInstanceId;
  }

  /** @ac game/Maps/MapMgr.h MapMgr::GetMapUpdater */
  getMapUpdater(): MapUpdater {
    return this.m_updater;
  }

  /** @ac game/Maps/MapMgr.h MapMgr::DoForAllMaps (the instances of an instanced base map, or the map itself) */
  doForAllMaps(worker: (map: Map) => void): void {
    for (const map of this.i_maps.values()) {
      const mapInstanced = map.toMapInstanced();
      if (mapInstanced) for (const instance of mapInstanced.getInstancedMaps().values()) worker(instance);
      else worker(map);
    }
  }

  /** @ac game/Maps/MapMgr.h MapMgr::DoForAllMapsWithMapId */
  doForAllMapsWithMapId(mapId: number, worker: (map: Map) => void): void {
    const map = this.i_maps.get(mapId);
    if (map) {
      const mapInstanced = map.toMapInstanced();
      if (mapInstanced) for (const instance of mapInstanced.getInstancedMaps().values()) worker(instance);
      else worker(map);
    }
  }

  /**
   * @ac game/Maps/MapMgr.cpp MapMgr::PlayerCannotEnter
   * @ac-skip ScriptMgr / Group / LFG / InstanceSaveMgr / AccessRequirement: `OnPlayerCanEnterMap`, the LFG dungeon check,
   * `PlayerGetDestinationInstanceId`, `PlayerGetInstanceSave`, and `Player::Satisfy(GetAccessRequirement)` are applied
   * through `MapHooks.instanceSaveMgr` and the optional player members; a check whose member is missing passes.
   */
  playerCannotEnter(mapid: number, player: MapPlayer, loginCheck = false): EnterState {
    const entry = sMapStore.lookupEntry(mapid);
    if (!entry) return CANNOT_ENTER_NO_ENTRY;

    if (!MapEntryIsDungeon(entry)) return CAN_ENTER;

    const instance = GetInstanceTemplate(mapid);
    if (!instance) return CANNOT_ENTER_UNINSTANCED_DUNGEON;

    const p = player as MapPlayer & Partial<MapEntryPlayerExtras>;
    const requestedDifficulty = p.getDifficulty?.(MapEntryIsRaid(entry)) ?? REGULAR_DIFFICULTY;
    // Get the highest available difficulty if current setting is higher than the instance allows
    const { mapDiff, difficulty: targetDifficulty } = GetDownscaledMapDifficultyData(entry.MapID, requestedDifficulty);
    if (!mapDiff) {
      p.sendTransferAborted?.(mapid, TRANSFER_ABORT_DIFFICULTY, requestedDifficulty);
      return CANNOT_ENTER_DIFFICULTY_UNAVAILABLE;
    }

    // Bypass checks for GMs
    if (player.isGameMaster()) return CAN_ENTER;

    const mapName = entry.name[MapHooks.getDefaultDbcLocale()] ?? "";

    const group = (p.getGroup?.() ?? null) as MapGroupLike | null;
    if (MapEntryIsRaid(entry)) {
      // can only enter in a raid group
      if ((!group || !group.isRaidGroup?.()) && !sWorld().getBoolConfig(ServerConfig.CONFIG_INSTANCE_IGNORE_RAID)) {
        // probably there must be special opcode, because client has this string constant in GlobalStrings.lua
        // @todo: this is not a good place to send the message
        p.sendAreaTriggerMessage?.(LANG_INSTANCE_RAID_GROUP_ONLY, mapName);
        return CANNOT_ENTER_NOT_IN_RAID;
      }
    }

    if (!player.isAlive()) {
      if (p.hasCorpse?.()) {
        // let enter in ghost mode in instance that connected to inner instance with corpse
        let corpseMap = p.getCorpseLocation!().getMapId();
        do {
          if (corpseMap === mapid) break;

          const corpseInstance = GetInstanceTemplate(corpseMap);
          corpseMap = corpseInstance ? corpseInstance.Parent : 0;
        } while (corpseMap);

        if (!corpseMap) {
          player.sendDirectMessage({ opcode: SMSG_CORPSE_NOT_IN_INSTANCE, payload: new Uint8Array(0) });
          return CANNOT_ENTER_CORPSE_IN_DIFFERENT_INSTANCE;
        }
      } else {
        return CANNOT_ENTER_CORPSE_IN_DIFFERENT_INSTANCE;
      }
    }

    const saves = MapHooks.instanceSaveMgr;

    // if map exists - check for being full, etc.
    if (!loginCheck) {
      // for login this is done by the calling function
      const destInstId = saves?.playerGetDestinationInstanceId(player, mapid, targetDifficulty) ?? 0;
      if (destInstId) {
        const boundMap = this.findMap(mapid, destInstId);
        if (boundMap) {
          const denyReason = boundMap.cannotEnter(player, loginCheck);
          if (denyReason) return denyReason;
        }
      }
    }

    // players are only allowed to enter 5 instances per hour
    if (MapEntryIsNonRaidDungeon(entry) && (!group || !group.isLFGGroup?.() || !group.isLfgRandomInstance?.())) {
      // instaceIdToCheck can be 0 if save not found - means no bind so the instance is new
      const instaceIdToCheck = 0; // @ac-skip InstanceSaveMgr::PlayerGetInstanceSave
      if (p.checkInstanceCount && !p.checkInstanceCount(instaceIdToCheck)) {
        p.sendTransferAborted?.(mapid, TRANSFER_ABORT_TOO_MANY_INSTANCES);
        return CANNOT_ENTER_TOO_MANY_INSTANCES;
      }
    }

    // Other requirements (`player->Satisfy(sObjectMgr->GetAccessRequirement(mapid, targetDifficulty), mapid, true)`)
    void TRANSFER_ABORT_MAP_NOT_ALLOWED;
    return p.satisfy ? (p.satisfy(null, mapid, true) ? CAN_ENTER : CANNOT_ENTER_UNSPECIFIED_REASON) : CAN_ENTER;
  }
}

/** @ac game/Maps/MapMgr.h sMapMgr (`MapMgr::instance()`) */
export function sMapMgr(): MapMgr {
  return MapMgr.instance();
}

/**
 * The height of a map at a point, for the chat commands: `MapMgr::CreateBaseMap(mapId)->GetHeight(x, y, z)` (map file and vmap
 * height under `z`). `INVALID_HEIGHT` for a map id without a `Map.dbc` row.
 * @ac game/Maps/Map.cpp Map::GetHeight
 */
export function getHeight(mapId: number, x: number, y: number, z: number = 100000): number {
  if (!sMapStore.lookupEntry(mapId)) return -100000;
  return sMapMgr().createBaseMap(mapId).getHeightNoPhase(x, y, z);
}

/**
 * The water level of a map at a point, for the chat commands: `MapMgr::CreateBaseMap(mapId)->GetWaterLevel(x, y)`.
 * @ac game/Maps/Map.cpp Map::GetWaterLevel
 */
export function getWaterLevel(mapId: number, x: number, y: number): number {
  if (!sMapStore.lookupEntry(mapId)) return -100000;
  return sMapMgr().createBaseMap(mapId).getWaterLevel(x, y);
}

/**
 * The map the terrain and collision data of a place is read from: the instance when it exists, else the base map of the map
 * id (`MapMgr::CreateBaseMap`; an instanced base map reads the same extracted data). Null for a map id without a `Map.dbc`
 * row. For the code that works on positions without a `WorldObject` (spells, the zone update, the chat commands).
 */
export function getTerrainMap(mapId: number, instanceId = 0): Map | null {
  if (!sMapStore.lookupEntry(mapId)) return null;
  if (instanceId) {
    const instance = sMapMgr().findMap(mapId, instanceId);
    if (instance) return instance;
  }
  return sMapMgr().createBaseMap(mapId);
}
