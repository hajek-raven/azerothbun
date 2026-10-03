/**
 * @ac game/Maps/MapInstanced.h
 * @ac game/Maps/MapInstanced.cpp
 * @ac-skip game/Maps/MapInstanced.cpp MapInstanced::RelocationNotify: commented out in the C++ source
 * @ac-skip game/Maps/MapInstanced.h MapInstanced::~MapInstanced: empty in C++ (`Map::destroy` runs `~Map`)
 *
 * The base map of an instanceable map id (a dungeon, raid, battleground, or arena): it holds no players itself, only the
 * `InstanceMap` / `BattlegroundMap` copies, and creates, finds, updates, and destroys them.
 *
 * @ac-skip InstanceSaveMgr / Group / Battleground: the instance saves, the group difficulty, and the battleground are read
 * through `MapHooks.instanceSaveMgr` and the optional player members (`getGroup`, `getBattleground`); without them every
 * entry creates a new instance on the player's own difficulty.
 */
import { logDebug, logError } from "../../log.ts";
import { sMapStore } from "../DataStores/DBCStores.ts";
import {
  DUNGEON_DIFFICULTY_NORMAL,
  GetBattlegroundBracketByLevel,
  GetDownscaledMapDifficultyData,
  IsSharedDifficultyMap,
  REGULAR_DIFFICULTY,
} from "../DataStores/MapDBCStores.ts";
import {
  BattlegroundMap,
  CAN_ENTER,
  InstanceMap,
  Map,
  MapHooks,
  type EnterState,
  type MapBattleground,
  type MapInstanceSave,
  type MapInstancedLike,
  type MapPlayer,
} from "./Map.ts";
import { GetInstanceTemplate } from "./MapMgrStatics.ts";
import { sMapMgr } from "./MapMgr.ts";
import { StdMap } from "./StdMap.ts";

/** @ac game/Battlegrounds/Battleground.h BattlegroundStatus::STATUS_WAIT_LEAVE */
const STATUS_WAIT_LEAVE = 4;

/** @ac game/Maps/MapInstanced.h MapInstanced */
export class MapInstanced extends Map implements MapInstancedLike {
  /** @ac game/Maps/MapInstanced.h MapInstanced::InstancedMaps (`std::unordered_map<uint32, Map*>`) */
  private readonly m_InstancedMaps = new StdMap<number, Map>();

  /** @ac game/Maps/MapInstanced.cpp MapInstanced::MapInstanced */
  constructor(id: number) {
    super(id, 0, DUNGEON_DIFFICULTY_NORMAL);
    // initialize instanced maps list
    this.m_InstancedMaps.clear();
  }

  /** @ac game/Maps/MapInstanced.cpp MapInstanced::InitVisibilityDistance */
  override initVisibilityDistance(): void {
    // `Map::Map` calls the base version before `m_InstancedMaps` exists
    if (!this.m_InstancedMaps || this.m_InstancedMaps.size === 0) return;
    // initialize visibility distances for all instance copies
    for (const map of this.m_InstancedMaps.values()) map.initVisibilityDistance();
  }

  /** @ac game/Maps/MapInstanced.cpp MapInstanced::Update */
  override update(t: number, s_diff: number, _thread = true): void {
    // take care of loaded GridMaps (when unused, unload it!)
    super.update(t, s_diff, false);

    // update the instanced maps (`DestroyInstance` erases the entry it is given, so the walk is over a snapshot)
    for (const [instanceId, map] of [...this.m_InstancedMaps]) {
      if (this.m_InstancedMaps.get(instanceId) !== map) continue;

      if (map.canUnload(t)) {
        this.destroyInstance(instanceId);
      } else {
        // update only here, because it may schedule some bad things before delete
        if (sMapMgr().getMapUpdater().activated()) sMapMgr().getMapUpdater().scheduleUpdate(map, t, s_diff);
        else map.update(t, s_diff);
      }
    }
  }

  /** @ac game/Maps/MapInstanced.cpp MapInstanced::DelayedUpdate */
  override delayedUpdate(diff: number): void {
    for (const map of this.m_InstancedMaps.values()) map.delayedUpdate(diff);

    super.delayedUpdate(diff); // this may be removed
  }

  /** @ac game/Maps/MapInstanced.cpp MapInstanced::UnloadAll */
  override unloadAll(): void {
    // Unload instanced maps
    for (const map of this.m_InstancedMaps.values()) map.unloadAll();

    // Delete the maps only after everything is unloaded to prevent crashes
    for (const map of this.m_InstancedMaps.values()) map.destroy();

    this.m_InstancedMaps.clear();

    // Unload own grids (just dummy(placeholder) grids, neccesary to unload GridMaps!)
    super.unloadAll();
  }

  /**
   * @ac game/Maps/MapInstanced.cpp MapInstanced::CreateInstanceForPlayer
   * - return the right instance for the object, based on its InstanceId
   * - create the instance if it's not created already
   * - the player is not actually added to the instance (only in InstanceMap::Add)
   */
  createInstanceForPlayer(mapId: number, player: MapPlayer): Map | null {
    if (this.getId() !== mapId || !player) return null;

    let map: Map | null = null;

    if (this.isBattlegroundOrArena()) {
      // instantiate or find existing bg map for player
      // the instance id is set in battlegroundid
      const newInstanceId = player.getBattlegroundId?.() ?? 0;
      if (!newInstanceId) return null;

      map = sMapMgr().findMap(mapId, newInstanceId);
      if (!map) {
        const bg = (player as unknown as { getBattleground?(create: boolean): MapBattleground | null }).getBattleground?.(true) ?? null;
        if (bg && bg.getStatus() < STATUS_WAIT_LEAVE) map = this.createBattleground(newInstanceId, bg);
        else {
          player.teleportToEntryPoint?.();
          return null;
        }
      }
    } else {
      const realdiff = player.getDifficulty?.(this.isRaid()) ?? REGULAR_DIFFICULTY;
      const saves = MapHooks.instanceSaveMgr;
      const destInstId = saves?.playerGetDestinationInstanceId(player, this.getId(), realdiff) ?? 0;

      if (destInstId) {
        const pSave = saves!.getInstanceSave(destInstId);
        if (!pSave) throw new Error("ASSERT failed: pSave (MapInstanced::CreateInstanceForPlayer)"); // pussywizard: must exist

        map = this.findInstanceMap(destInstId);
        if (!map) map = this.createInstance(destInstId, pSave, realdiff, player);
        else if (IsSharedDifficultyMap(mapId) && !map.havePlayers() && map.getDifficulty() !== realdiff) {
          if ((player as unknown as { isBeingLoaded?(): boolean }).isBeingLoaded?.())
            // pussywizard: crashfix (assert(passengers.empty) fail in ~transport), could be added to a transport during loading from db
            return null;

          if (!map.allTransportsEmpty())
            map.allTransportsRemovePassengers(); // pussywizard: gameobjects / summons (assert(passengers.empty) fail in ~transport)

          if (this.m_InstancedMaps.has(destInstId)) {
            this.destroyInstance(destInstId);
            map = this.createInstance(destInstId, pSave, realdiff, player);
          }
        }
      } else {
        const newInstanceId = sMapMgr().generateInstanceId();
        if (this.findInstanceMap(newInstanceId)) throw new Error("ASSERT failed: !FindInstanceMap(newInstanceId)"); // pussywizard: instance with new id can't exist
        const group = (player as unknown as { getGroup?(): { getDifficulty(isRaid: boolean): number } | null }).getGroup?.() ?? null;
        const diff = group ? group.getDifficulty(this.isRaid()) : realdiff;
        map = this.createInstance(newInstanceId, null, diff, player);
      }
    }

    return map;
  }

  /** @ac game/Maps/MapInstanced.h MapInstanced::FindInstanceMap */
  findInstanceMap(instanceId: number): Map | null {
    return this.m_InstancedMaps.get(instanceId) ?? null;
  }

  /** @ac game/Maps/MapInstanced.h MapInstanced::GetInstancedMaps */
  getInstancedMaps(): StdMap<number, Map> {
    return this.m_InstancedMaps;
  }

  /** @ac game/Maps/MapInstanced.cpp MapInstanced::CreateInstance */
  private createInstance(InstanceId: number, save: MapInstanceSave | null, difficulty: number, player: MapPlayer | null): InstanceMap {
    // load/create a map (`std::lock_guard<std::mutex> guard(Lock)`: maps update on one thread)

    // make sure we have a valid map id
    const entry = sMapStore.lookupEntry(this.getId());
    if (!entry) {
      logError("maps", `CreateInstance: no entry for map ${this.getId()}`);
      throw new Error(`ABORT: CreateInstance: no entry for map ${this.getId()}`);
    }
    const iTemplate = GetInstanceTemplate(this.getId());
    if (!iTemplate) {
      logError("maps", `CreateInstance: no instance template for map ${this.getId()}`);
      throw new Error(`ABORT: CreateInstance: no instance template for map ${this.getId()}`);
    }

    // some instances only have one difficulty
    difficulty = GetDownscaledMapDifficultyData(this.getId(), difficulty).difficulty;

    logDebug("maps", `MapInstanced::CreateInstance: ${save ? "" : "new "}map instance ${InstanceId} for ${this.getId()} created with difficulty ${difficulty ? "heroic" : "normal"}`);

    const map = new InstanceMap(this.getId(), InstanceId, difficulty, this);
    if (!map.isDungeon()) throw new Error("ASSERT failed: map->IsDungeon() (MapInstanced::CreateInstance)");
    this.m_InstancedMaps.set(InstanceId, map);

    map.loadRespawnTimes();
    void map.loadCorpseData().catch((error: unknown) => logError("maps", `Loading the corpses of instance ${InstanceId} of map ${this.getId()} failed`, error));

    if (save) map.createInstanceScript(true, save.getInstanceData(), save.getCompletedEncounterMask());
    else map.createInstanceScript(false, "", 0);

    const script = map.getInstanceScript();
    if (script && script.isTwoFactionInstance() && script.getTeamIdInInstance() === 2 /* TEAM_NEUTRAL */) {
      if (!player) throw new Error("ASSERT failed: player (MapInstanced::CreateInstance)"); // Player should exist, as checked by in MapInstanced::CreateInstanceForPlayer
      script.setTeamIdInInstance(player.getTeamId());
      // @ac-skip Group: the instance takes the team of the group leader (`ObjectAccessor::FindConnectedPlayer(group->GetLeaderGUID())`)
    }

    map.onCreateMap();

    if (!save)
      // this is for sure a dungeon (assert above), no need to check here
      MapHooks.instanceSaveMgr?.addInstanceSave(this.getId(), InstanceId, difficulty);

    return map;
  }

  /** @ac game/Maps/MapInstanced.cpp MapInstanced::CreateBattleground */
  private createBattleground(InstanceId: number, bg: MapBattleground): BattlegroundMap {
    // load/create a map (`std::lock_guard<std::mutex> guard(Lock)`: maps update on one thread)

    logDebug("maps", `MapInstanced::CreateBattleground: map bg ${InstanceId} for ${this.getId()} created.`);

    const bracketEntry = GetBattlegroundBracketByLevel(bg.getMapId(), bg.getMinLevel());

    const spawnMode = bracketEntry ? bracketEntry.difficulty : REGULAR_DIFFICULTY;

    const map = new BattlegroundMap(this.getId(), InstanceId, this, spawnMode);
    if (!map.isBattlegroundOrArena()) throw new Error("ASSERT failed: map->IsBattlegroundOrArena() (MapInstanced::CreateBattleground)");
    this.m_InstancedMaps.set(InstanceId, map);

    map.setBG(bg);
    bg.setBgMap(map);

    map.onCreateMap();

    return map;
  }

  /**
   * @ac game/Maps/MapInstanced.cpp MapInstanced::DestroyInstance
   * The C++ takes and advances an iterator; here the instance id is given. Returns false when the instance still has players.
   */
  destroyInstance(instanceId: number): boolean {
    const map = this.m_InstancedMaps.get(instanceId);
    if (!map) return false;

    map.removeAllPlayers();

    if (map.havePlayers()) return false;

    // @ac-skip ScriptMgr::OnDestroyInstance is a no-op hook
    map.unloadAll();

    // erase map
    map.destroy();
    this.m_InstancedMaps.delete(instanceId);

    return true;
  }

  /** @ac game/Maps/MapInstanced.cpp MapInstanced::CannotEnter */
  override cannotEnter(_player: MapPlayer, _loginCheck = false): EnterState {
    // ABORT();
    return CAN_ENTER;
  }
}
