/**
 * Shared helpers of the map extractor tests: converts a synthetic ADT (`adt.test-util.ts`) with the extractor, loads the
 * resulting `.map` with the runtime reader (`GridTerrainData`) and converts between grid vertices and world coordinates.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GridTerrainData, TerrainMapDataReadResult } from "../../game/Grids/GridTerrainData.ts";
import { buildADT, type TestADT } from "./adt.test-util.ts";
import { ADT_file } from "./adt.ts";
import { convertADTData, LiquidTypes } from "./System.ts";

/** `SIZE_OF_GRIDS` */
export const SIZE_OF_GRIDS = 533.3333;

/** `LiquidType.dbc` rows the synthetic ADTs use: id to `SoundBank` (0 water, 1 ocean, 2 magma, 3 slime). */
export function useTestLiquidTypes(): void {
  LiquidTypes.clear();
  LiquidTypes.set(1, { SoundBank: 0 });
  LiquidTypes.set(2, { SoundBank: 1 });
  LiquidTypes.set(3, { SoundBank: 2 });
  LiquidTypes.set(4, { SoundBank: 3 });
}

/** Runs the extractor conversion on a synthetic ADT; returns the `.map` bytes. */
export function convertSynthetic(adt: TestADT, build = 12340): Uint8Array {
  const file = new ADT_file();
  if (!file.loadData(buildADT(adt))) throw new Error("synthetic ADT does not load");
  const bytes = convertADTData(file, "synthetic.adt", build);
  if (!bytes) throw new Error("synthetic ADT does not convert");
  return bytes;
}

/** Writes the bytes to a throwaway file and loads them with `GridTerrainData`. */
export async function loadTerrain(bytes: Uint8Array): Promise<GridTerrainData> {
  const dir = await mkdtemp(join(tmpdir(), "wow-ts-map-"));
  try {
    const path = join(dir, "00000000.map");
    await Bun.write(path, bytes);
    const data = new GridTerrainData();
    const result = data.load(path);
    if (result !== TerrainMapDataReadResult.Success) throw new Error(`GridTerrainData.load failed: ${result}`);
    return data;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Convert and load in one go. */
export async function convertAndLoad(adt: TestADT): Promise<GridTerrainData> {
  return loadTerrain(convertSynthetic(adt));
}

/**
 * World coordinates of the V9 grid position `(gx, gy)` (`V9[gx * 129 + gy]`, `V8[gx * 128 + gy]` for the half step
 * position), computed for tile (32, 32) so that grid coordinates are `128 * (32 - x / SIZE_OF_GRIDS)`.
 * `fx` and `fy` are the fractions inside the square (`0.5` = the V8 centre).
 */
export function worldAt(gx: number, gy: number, fx = 0.001, fy = 0.001): [number, number] {
  return [(32 - (gx + fx) / 128) * SIZE_OF_GRIDS, (32 - (gy + fy) / 128) * SIZE_OF_GRIDS];
}

/** World position of the middle of the 8 * 8 cell `(i, j)` sub square `(y, x)` (`i`, `j` as in `TestADT.cell`). */
export function cellSquare(i: number, j: number, y: number, x: number): [number, number] {
  return worldAt(i * 8 + y, j * 8 + x, 0.5, 0.5);
}

/** `Acore::ComputeGridCoord` (the tile of a world position; the file is `MMM` + this x + this y, no `63 -`). */
export function gridCoord(x: number, y: number): [number, number] {
  const S = Math.fround(SIZE_OF_GRIDS);
  return [Math.max(0, Math.trunc(Math.fround(32 - Math.fround(x / S)))), Math.max(0, Math.trunc(Math.fround(32 - Math.fround(y / S))))];
}

/** Lazily loads the `.map` files of `data/maps` the way `Map` loads grids (`MMMXXYY.map`). */
export class TerrainCache {
  private readonly tiles = new Map<string, GridTerrainData | null>();

  constructor(readonly mapsDir: string) {}

  /** The terrain of the tile holding `(x, y)`, `null` when the extraction has no such tile. */
  at(map: number, x: number, y: number): GridTerrainData | null {
    const [gx, gy] = gridCoord(x, y);
    const name = `${String(map).padStart(3, "0")}${String(gx).padStart(2, "0")}${String(gy).padStart(2, "0")}.map`;
    let tile = this.tiles.get(name);
    if (tile === undefined) {
      tile = new GridTerrainData();
      if (tile.load(join(this.mapsDir, name)) !== TerrainMapDataReadResult.Success) tile = null;
      this.tiles.set(name, tile);
    }
    return tile;
  }
}
