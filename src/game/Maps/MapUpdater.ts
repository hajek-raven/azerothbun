/**
 * @ac game/Maps/MapUpdater.h
 * @ac game/Maps/MapUpdater.cpp
 *
 * The map update scheduler. AzerothCore queues `UpdateRequest`s for a pool of worker threads (`MapUpdate.Threads`). This
 * server updates maps on the one world thread, so the updater is never "activated" (`activated()` is false) and every
 * request is run on the spot, in the order it is scheduled, exactly as the C++ does when `MapUpdate.Threads` is 0.
 * `MapMgr::Update` and `MapInstanced::Update` already call `Map::Update` directly when the updater is not activated.
 *
 * @ac-skip game/Maps/MapUpdater.cpp MapUpdater::WorkerThread, MapUpdater::~MapUpdater: no worker threads
 * @ac-skip threads: `activate`, `deactivate`, `wait`, `WorkerThread`, the `ProducerConsumerQueue`, and the pending request
 * counter have nothing to do on one thread. A `Worker` per map is the later step (docs/porting-workflow.md).
 */
import { log } from "../../log.ts";
import type { Map } from "./Map.ts";

/** @ac game/Maps/MapUpdater.cpp UpdateRequest */
export abstract class UpdateRequest {
  abstract call(): void;
}

/** @ac game/Maps/MapUpdater.cpp MapUpdateRequest */
export class MapUpdateRequest extends UpdateRequest {
  constructor(
    private readonly m_map: Map,
    private readonly m_updater: MapUpdater,
    private readonly m_diff: number,
    private readonly s_diff: number,
  ) {
    super();
  }

  override call(): void {
    // @ac-skip METRIC_TIMER("map_update_time_diff"): metrics are not ported
    this.m_map.update(this.m_diff, this.s_diff);
    this.m_updater.updateFinished();
  }
}

/** @ac game/Maps/MapUpdater.cpp MapPreloadRequest */
export class MapPreloadRequest extends UpdateRequest {
  constructor(
    private readonly _mapId: number,
    private readonly _updater: MapUpdater,
    private readonly _createBaseMap: (mapId: number) => Map,
  ) {
    super();
  }

  override call(): void {
    const map = this._createBaseMap(this._mapId);
    log("server", `>> Loading All Grids For Map ${map.getId()} (${map.getMapName()})`);
    map.loadAllGrids();
    this._updater.updateFinished();
  }
}

/**
 * @ac game/Maps/MapUpdater.cpp LFGUpdateRequest
 * @ac-skip LFG: `LFGMgr::Update` is not ported, so the request only reports itself finished.
 */
export class LFGUpdateRequest extends UpdateRequest {
  constructor(
    private readonly m_updater: MapUpdater,
    private readonly m_diff: number,
  ) {
    super();
  }

  override call(): void {
    void this.m_diff;
    this.m_updater.updateFinished();
  }
}

/** @ac game/Maps/MapUpdater.h MapUpdater */
export class MapUpdater {
  /** `pending_requests`: requests scheduled and not finished yet (always 0 between calls on one thread) */
  private pending_requests = 0;

  /** @ac game/Maps/MapUpdater.cpp MapUpdater::MapUpdater */
  constructor(private readonly createBaseMap: (mapId: number) => Map = () => {
    throw new Error("MapUpdater: no map manager to preload maps from");
  }) {}

  /** @ac game/Maps/MapUpdater.cpp MapUpdater::activate (no worker threads: stays inactive) */
  activate(_num_threads: number): void {}

  /** @ac game/Maps/MapUpdater.cpp MapUpdater::deactivate */
  deactivate(): void {}

  /** @ac game/Maps/MapUpdater.cpp MapUpdater::wait (nothing is ever pending once `scheduleTask` returns) */
  wait(): void {}

  /** @ac game/Maps/MapUpdater.cpp MapUpdater::schedule_task (the request runs now) */
  scheduleTask(request: UpdateRequest): void {
    ++this.pending_requests;
    request.call();
  }

  /** @ac game/Maps/MapUpdater.cpp MapUpdater::schedule_update */
  scheduleUpdate(map: Map, diff: number, s_diff: number): void {
    this.scheduleTask(new MapUpdateRequest(map, this, diff, s_diff));
  }

  /** @ac game/Maps/MapUpdater.cpp MapUpdater::schedule_map_preload */
  scheduleMapPreload(mapid: number): void {
    this.scheduleTask(new MapPreloadRequest(mapid, this, this.createBaseMap));
  }

  /** @ac game/Maps/MapUpdater.cpp MapUpdater::schedule_lfg_update */
  scheduleLfgUpdate(diff: number): void {
    this.scheduleTask(new LFGUpdateRequest(this, diff));
  }

  /** @ac game/Maps/MapUpdater.cpp MapUpdater::activated (`!_workerThreads.empty()`) */
  activated(): boolean {
    return false;
  }

  /** @ac game/Maps/MapUpdater.cpp MapUpdater::update_finished */
  updateFinished(): void {
    --this.pending_requests;
  }
}
