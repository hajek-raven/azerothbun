/**
 * Worker thread of the mmaps generator: the TypeScript counterpart of `TileBuilder::WorkerThread`. The main thread
 * (`MapBuilder.processQueue`) sends `init` once and then one `tile` message at a time; the worker builds the tile with
 * its own `TileBuilder` and answers `done`.
 * @ac tools/mmaps_generator/MapBuilder.cpp MMAP::TileBuilder::WorkerThread
 */
import { dtAllocNavMesh, dtFreeNavMesh, dtNavMeshParams } from "../../common/Detour/DetourNavMesh.ts";
import { Config } from "./Config.ts";
import { MapBuilder, TileBuilder } from "./MapBuilder.ts";

declare const self: Worker;

let builder: MapBuilder | null = null;
let tileBuilder: TileBuilder | null = null;
let percent = 0;

self.onmessage = async (ev: MessageEvent): Promise<void> => {
  const msg = ev.data as
    | { kind: "init"; configFile: string; mapid: number }
    | { kind: "tile"; mapId: number; tileX: number; tileY: number; params: Uint8Array; percent: number };
  try {
    if (msg.kind === "init") {
      const config = await Config.FromFile(msg.configFile);
      if (!config) throw new Error(`Failed to load ${msg.configFile}`);
      builder = new MapBuilder(config, msg.mapid, 1, false);
      tileBuilder = new TileBuilder(builder, config.ShouldSkipLiquid(), config.IsDebugOutputEnabled());
      self.postMessage({ kind: "ready" });
    } else if (msg.kind === "tile" && builder && tileBuilder) {
      percent = msg.percent;
      const before = builder.m_totalTilesProcessed;
      // the worker has no view of the global counters: report the percentage the main thread had at dispatch
      builder.m_totalTiles = 100;
      builder.m_totalTilesProcessed = percent;
      const navMesh = dtAllocNavMesh();
      const params = dtNavMeshParams.fromBytes(msg.params);
      if (!navMesh.init(params)) {
        console.log(`[Map ${String(msg.mapId).padStart(4, "0")}] Failed creating navmesh for tile ${msg.tileX},${msg.tileY} !`);
        dtFreeNavMesh(navMesh);
        self.postMessage({ kind: "done", processed: 1 });
        return;
      }
      await tileBuilder.buildTile(msg.mapId, msg.tileX, msg.tileY, navMesh);
      dtFreeNavMesh(navMesh);
      void before;
      self.postMessage({ kind: "done", processed: 1 });
    }
  } catch (e) {
    self.postMessage({ kind: "error", error: (e as Error).stack ?? String(e) });
  }
};
