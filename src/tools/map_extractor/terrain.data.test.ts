/**
 * Checks the full extraction in `data/maps` through the runtime reader (`GridTerrainData`): known places, liquids and
 * the heights of creature spawns. Skips itself when `data/maps` or the creature dump is missing.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  INVALID_HEIGHT,
  LIQUID_MAP_NO_WATER,
  LIQUID_MAP_UNDER_WATER,
  MAP_LIQUID_TYPE_MAGMA,
  MAP_LIQUID_TYPE_OCEAN,
  MAP_LIQUID_TYPE_WATER,
} from "../../game/Grids/GridTerrainData.ts";
import { TerrainCache } from "./convert.test-util.ts";

const mapsDir = join(process.cwd(), "data", "maps");
const creatureSql = join(process.cwd(), "sql", "base", "db_world", "creature.sql");
const hasMaps = existsSync(join(mapsDir, "0004832.map"));

function terrain() {
  return new TerrainCache(mapsDir);
}

describe.skipIf(!hasMaps)("terrain of the extracted maps", () => {
  const cache = terrain();
  const at = (map: number, x: number, y: number) => {
    const tile = cache.at(map, x, y);
    expect(tile).not.toBeNull();
    return tile!;
  };

  test("Northshire Abbey: ground near 81, area Northshire Valley, dry", () => {
    const t = at(0, -8914, -133);
    expect(t.getHeight(-8914, -133)).toBeGreaterThan(75);
    expect(t.getHeight(-8914, -133)).toBeLessThan(86);
    expect(t.getArea(-8914, -133)).toBe(9);
    expect(t.getLiquidData(-8914, -133, 82, 2).Status).toBe(LIQUID_MAP_NO_WATER);
  });

  test("Stormwind Trade District: the terrain below the city, area 1519 (Stormwind City)", () => {
    const t = at(0, -8830, 636);
    expect(t.getArea(-8830, 636)).toBe(1519);
    // the city is a WMO (vmaps); the ADT only has the ground below it
    expect(t.getHeight(-8830, 636)).toBeGreaterThan(40);
    expect(t.getHeight(-8830, 636)).toBeLessThan(94);
  });

  test("Orgrimmar: area 1637", () => {
    const t = at(1, 1629, -4373);
    expect(t.getArea(1629, -4373)).toBe(1637);
    expect(t.getHeight(1629, -4373)).not.toBe(INVALID_HEIGHT);
  });

  test("Dalaran floats above its ground: area 4553 and flight bounds below -1000", () => {
    const t = at(571, 5804, 624);
    expect(t.getArea(5804, 624)).toBe(4553);
    expect(t.getHeight(5804, 624)).toBeLessThan(647);
    expect(t.getMinHeight(5804, 624)).toBeLessThan(0); // MFBO planes, MIN_HEIGHT (-500) without them
  });

  test("the Great Sea is ocean with a dark deep part", () => {
    const t = at(0, -14000, 2000);
    expect(t.getHeight(-14000, 2000)).toBe(-500); // clamped deep ground
    const liquid = t.getLiquidData(-14000, 2000, -5, 2);
    expect(liquid.Status).toBe(LIQUID_MAP_UNDER_WATER);
    expect(liquid.Level).toBeCloseTo(0, 1);
    expect(liquid.Flags & MAP_LIQUID_TYPE_OCEAN).toBe(MAP_LIQUID_TYPE_OCEAN);
    expect(t.getLiquidLevel(-14000, 2000)).toBeCloseTo(0, 1);
  });

  test("a lake in Elwynn Forest is water, the Burning Steppes has magma", () => {
    const lake = at(0, -8535.4, -460.4).getLiquidData(-8535.4, -460.4, 150, 2);
    expect(lake.Flags & MAP_LIQUID_TYPE_WATER).toBe(MAP_LIQUID_TYPE_WATER);
    expect(lake.Level).toBeGreaterThan(130);
    expect(lake.Level).toBeLessThan(160);
    const lava = at(0, -7635.4, -1343.75);
    const magma = lava.getLiquidData(-7635.4, -1343.75, lava.getHeight(-7635.4, -1343.75) + 0.5, 2);
    expect(magma.Flags & MAP_LIQUID_TYPE_MAGMA).toBe(MAP_LIQUID_TYPE_MAGMA);
  });
});

/** Rows of `creature.sql`: guid, map, x, y, z. */
async function creatureRows(maps: number[]): Promise<Map<number, number[][]>> {
  const text = await Bun.file(creatureSql).text();
  const re = /^\((\d+),\d+,\d+,\d+,(\d+),\d+,\d+,\d+,\d+,-?\d+,(-?[\d.e+-]+),(-?[\d.e+-]+),(-?[\d.e+-]+),/gm;
  const rows = new Map<number, number[][]>(maps.map((m) => [m, []]));
  for (let m = re.exec(text); m; m = re.exec(text)) rows.get(Number(m[2]))?.push([Number(m[1]), Number(m[3]), Number(m[4]), Number(m[5])]);
  return rows;
}

describe.skipIf(!hasMaps || !existsSync(creatureSql))("creature spawns against the terrain", () => {
  const continents = [0, 1, 530, 571];

  test("most of 200 spawns per continent stand within 2 yards of the terrain", async () => {
    const cache = terrain();
    const rows = await creatureRows(continents);
    const report: string[] = [];
    for (const map of continents) {
      const list = rows.get(map)!;
      expect(list.length).toBeGreaterThan(1000);
      const step = Math.floor(list.length / 200);
      let sampled = 0;
      let hit = 0;
      for (let i = 0; i < list.length && sampled < 200; i += step, sampled++) {
        const [, x, y, z] = list[i]!;
        const tile = cache.at(map, x!, y!);
        expect(tile).not.toBeNull(); // a spawn on a tile the extraction does not have
        if (Math.abs(tile!.getHeight(x!, y!) - z!) <= 2) hit++;
      }
      report.push(`map ${map}: ${hit}/${sampled}`);
      // the rest are in buildings and caves (vmaps), on flyers and swimmers
      expect(hit / sampled).toBeGreaterThan(0.65);
    }
    console.log(`creature spawns within 2 yards of the terrain: ${report.join(", ")}`);
  });
});
