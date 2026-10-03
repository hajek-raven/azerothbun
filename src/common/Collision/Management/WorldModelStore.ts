import { logDebug, logError } from "../../../log.ts";
import { WorldModel } from "../Models/WorldModel.ts";
import { MAPS_LOG } from "../VMapDefinitions.ts";

/**
 * Process wide cache of loaded `.vmo` models, keyed by file name (not by path, like the C++). Models
 * are never released; the C++ map holds a `shared_ptr` to each one for the life of the process.
 *
 * @ac common/Collision/Management/WorldModelStore.h WorldModelStore
 */
export class WorldModelStore {
  private static _instance: WorldModelStore | null = null;
  private readonly _loadedModels = new Map<string, WorldModel>();

  /** @ac common/Collision/Management/WorldModelStore.h WorldModelStore::instance */
  static instance(): WorldModelStore {
    if (!WorldModelStore._instance) WorldModelStore._instance = new WorldModelStore();
    return WorldModelStore._instance;
  }

  /**
   * Returns the cached model or loads `basepath + filename + ".vmo"`. `flags` (`ModelFlags`) are only
   * applied when the model is created. Null when the file cannot be read.
   *
   * @ac common/Collision/Management/WorldModelStore.cpp WorldModelStore::AcquireModelInstance
   */
  AcquireModelInstance(basepath: string, filename: string, flags: number): WorldModel | null {
    let model = this._loadedModels.get(filename);
    if (!model) {
      const worldmodel = new WorldModel();
      logDebug(MAPS_LOG, () => `WorldModelStore: loading file '${basepath}${filename}'`);
      if (!worldmodel.readFile(`${basepath}${filename}.vmo`)) {
        logError(MAPS_LOG, `WorldModelStore: could not load '${basepath}${filename}.vmo'`);
        return null;
      }

      worldmodel.Flags = flags;
      this._loadedModels.set(filename, worldmodel);
      model = worldmodel;
    }

    return model;
  }
}

/** @ac common/Collision/Management/WorldModelStore.h sWorldModelStore */
export function sWorldModelStore(): WorldModelStore {
  return WorldModelStore.instance();
}
