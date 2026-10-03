/**
 * Checks the terrain runtime against the real `data/maps` (extracted from the client). Skips itself when the maps
 * are not there.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GridTerrainData, INVALID_HEIGHT, LIQUID_MAP_NO_WATER, TerrainMapDataReadResult } from "./GridTerrainData.ts";

const mapsDir = join(process.cwd(), "data", "maps");

/** The grid of the `MMMXXYY.map` name: `ComputeGridCoordSimple` (`CENTER_GRID_ID - x / SIZE_OF_GRIDS`), the order the extractor writes. */
function gridCoord(x: number, y: number): [number, number] {
  const S = Math.fround(533.3333);
  const gx = Math.max(0, (32 - Math.fround(x / S)) | 0);
  const gy = Math.max(0, (32 - Math.fround(y / S)) | 0);
  return [Math.min(63, gx), Math.min(63, gy)];
}

function fileFor(mapId: number, x: number, y: number): string {
  const [gx, gy] = gridCoord(x, y);
  return join(mapsDir, `${String(mapId).padStart(3, "0")}${String(gx).padStart(2, "0")}${String(gy).padStart(2, "0")}.map`);
}

describe.skipIf(!existsSync(mapsDir))("real terrain data", () => {
  // Northshire Abbey, Elwynn Forest (map 0)
  const x = -8914;
  const y = -133;

  test("Northshire Abbey has a plausible height and area", () => {
    const file = fileFor(0, x, y);
    expect(existsSync(file)).toBe(true);
    const data = new GridTerrainData();
    expect(data.load(file)).toBe(TerrainMapDataReadResult.Success);

    const height = data.getHeight(x, y);
    expect(height).toBeGreaterThan(70);
    expect(height).toBeLessThan(95);
    expect(Math.abs(height - 81.5)).toBeLessThan(10);

    // Northshire Valley (9), Elwynn Forest (12) or the abbey (24)
    expect([9, 12, 24]).toContain(data.getArea(x, y));

    expect(data.getMinHeight(x, y)).toBeLessThanOrEqual(height);
    expect(data.getLiquidData(x, y, height, 2).Status).toBe(LIQUID_MAP_NO_WATER);
  });

  test("heights vary across the grid and every cell answers", () => {
    const data = new GridTerrainData();
    expect(data.load(fileFor(0, x, y))).toBe(TerrainMapDataReadResult.Success);
    const seen = new Set<number>();
    let invalid = 0;
    for (let dx = -200; dx <= 200; dx += 10) {
      for (let dy = -200; dy <= 200; dy += 10) {
        const h = data.getHeight(x + dx, y + dy);
        if (h === INVALID_HEIGHT) invalid++;
        else seen.add(Math.round(h));
      }
    }
    expect(seen.size).toBeGreaterThan(10);
    expect(invalid).toBeLessThan(100);
  });
});
