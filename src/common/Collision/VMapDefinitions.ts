import type { LogScope } from "../../log.ts";
import type { ReadFile } from "./BinaryFile.ts";

/** @ac common/Collision/VMapDefinitions.h LIQUID_TILE_SIZE */
export const LIQUID_TILE_SIZE = Math.fround(Math.fround(533.333) / 128);

/** @ac common/Collision/VMapDefinitions.h VMAP::VMAP_MAGIC */
export const VMAP_MAGIC = "VMAP_4.8";
/** Used in extracted vmap files with raw data. 7 characters plus the terminating NUL make 8 bytes. @ac common/Collision/VMapDefinitions.h VMAP::RAW_VMAP_MAGIC */
export const RAW_VMAP_MAGIC = "VMAP048";
/** @ac common/Collision/VMapDefinitions.h VMAP::GAMEOBJECT_MODELS */
export const GAMEOBJECT_MODELS = "GameObjectModels.dtree";

/**
 * Reads `len` bytes and compares them with `compare`. Declared in `VMapDefinitions.h`, defined in
 * `TileAssembler.cpp`; it lives here so the readers do not import the assembler.
 *
 * @ac common/Collision/Maps/TileAssembler.cpp VMAP::readChunk
 */
export function readChunk(rf: ReadFile, compare: string, len: number): boolean {
  return rf.chunk(compare, len);
}

/**
 * The C++ logs the Collision messages under the `maps` filter. `LogScope` (src/log.ts) has no `maps`
 * scope yet, so they go to `server` until one is added.
 */
export const MAPS_LOG: LogScope = "server";
