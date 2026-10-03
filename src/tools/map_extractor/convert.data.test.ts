/**
 * Converts real tiles from the client with the extractor and compares them with `data/maps` (the full extraction).
 * Skips itself when the client (`~/GAMES/ChromieCraft_3.3.5a`, or `$WOW_CLIENT`) or `data/maps` is missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GridTerrainData, TerrainMapDataReadResult } from "../../game/Grids/GridTerrainData.ts";
import { ADT_file } from "./adt.ts";
import { loadTerrain } from "./convert.test-util.ts";
import { closeArchives, openArchives } from "./mpq_libmpq04.ts";
import { convertADTData, map_ids, ReadLiquidTypeTableDBC, ReadMapDBC } from "./System.ts";

const client = process.env.WOW_CLIENT ?? join(homedir(), "GAMES", "ChromieCraft_3.3.5a");
const mapsDir = join(process.cwd(), "data", "maps");
const available = existsSync(join(client, "Data")) && existsSync(mapsDir);

/** ADT `<name>_<x>_<y>.adt`, written to `MMMYYXX.map` by the full extraction */
const tiles: { map: number; x: number; y: number }[] = [
  { map: 0, x: 32, y: 48 }, // Elwynn Forest, Northshire (-8914, -133)
  { map: 1, x: 40, y: 28 }, // Orgrimmar
  { map: 571, x: 30, y: 21 }, // Dalaran
];

function tileFile(map: number, x: number, y: number): string {
  return join(mapsDir, `${String(map).padStart(3, "0")}${String(y).padStart(2, "0")}${String(x).padStart(2, "0")}.map`);
}

describe.skipIf(!available)("map extractor on the real client", () => {
  beforeAll(async () => {
    const stdout = console.log;
    console.log = () => {};
    try {
      await openArchives(client, "enUS");
      ReadMapDBC();
      ReadLiquidTypeTableDBC();
    } finally {
      console.log = stdout;
    }
  });
  afterAll(() => closeArchives());

  test("Map.dbc lists the continents", () => {
    for (const [id, name] of [[0, "Azeroth"], [1, "Kalimdor"], [530, "Expansion01"], [571, "Northrend"]] as const) {
      expect(map_ids.find((m) => m.id === id)?.name).toBe(name);
    }
  });

  for (const { map, x, y } of tiles) {
    test(`map ${map} tile ${x},${y} converts to what the full extraction wrote`, async () => {
      const file = tileFile(map, x, y);
      expect(existsSync(file)).toBe(true);
      const existing = new Uint8Array(await Bun.file(file).arrayBuffer());
      const build = new DataView(existing.buffer).getUint32(8, true);
      const name = map_ids.find((m) => m.id === map)!.name;
      const adt = new ADT_file();
      const stdout = console.log;
      console.log = () => {};
      expect(adt.loadFile(`World\\Maps\\${name}\\${name}_${x}_${y}.adt`)).toBe(true);
      console.log = stdout;
      const bytes = convertADTData(adt, "tile", build)!;
      expect(bytes.length).toBe(existing.length);
      expect([...bytes.subarray(0, 44)]).toEqual([...existing.subarray(0, 44)]);

      // The C++ extractor keeps `liquid_height` between tiles, so the unused edge vertices of the liquid block depend on
      // the previous tile: compare what the runtime reads (area, height, liquid) instead of the raw bytes.
      const fresh = await loadTerrain(bytes);
      const old = new GridTerrainData();
      expect(old.load(file)).toBe(TerrainMapDataReadResult.Success);
      const S = 533.3333;
      let compared = 0;
      for (let gx = 0; gx < 128; gx += 3) {
        for (let gy = 0; gy < 128; gy += 3) {
          const wx = (32 - y - (gx + 0.37) / 128) * S;
          const wy = (32 - x - (gy + 0.61) / 128) * S;
          expect(fresh.getHeight(wx, wy)).toBe(old.getHeight(wx, wy));
          expect(fresh.getArea(wx, wy)).toBe(old.getArea(wx, wy));
          expect(fresh.getLiquidLevel(wx, wy)).toBe(old.getLiquidLevel(wx, wy));
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(1500);
    });
  }
});
