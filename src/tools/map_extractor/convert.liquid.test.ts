/** Synthetic ADT: area ids, MCLQ and MH2O liquids end to end through the extractor and `GridTerrainData`. */
import { beforeAll, describe, expect, test } from "bun:test";
import {
  LIQUID_MAP_ABOVE_WATER,
  LIQUID_MAP_IN_WATER,
  LIQUID_MAP_NO_WATER,
  LIQUID_MAP_UNDER_WATER,
  MAP_LIQUID_TYPE_DARK_WATER,
  MAP_LIQUID_TYPE_MAGMA,
  MAP_LIQUID_TYPE_OCEAN,
  MAP_LIQUID_TYPE_WATER,
} from "../../game/Grids/GridTerrainData.ts";
import { type TestCell, type TestH2OInstance, type TestMCLQ } from "./adt.test-util.ts";
import { cellSquare, convertAndLoad, convertSynthetic, useTestLiquidTypes } from "./convert.test-util.ts";

beforeAll(useTestLiquidTypes);

/** `TestMCLQ` with every square shown at one level. */
function mclq(level: number, hidden: number[] = []): TestMCLQ {
  const flags = new Uint8Array(64);
  for (const k of hidden) flags[k] = 0x0f;
  return { heights: new Float32Array(81).fill(level), flags };
}

describe("convertADTData areas", () => {
  test("one area for the whole tile is stored as the grid area", async () => {
    const bytes = convertSynthetic({ cell: () => ({ areaid: 12, ypos: 1 }) });
    expect(bytes.length).toBe(44 + 8 + 16); // no 16 * 16 area map
    const data = await convertAndLoad({ cell: () => ({ areaid: 12, ypos: 1 }) });
    expect(data.getArea(-8000, 1000)).toBe(12);
  });

  test("distinct areas are stored per cell, indexed by (i, j)", async () => {
    const data = await convertAndLoad({ cell: (i, j) => ({ areaid: 1000 + i * 16 + j, ypos: 1 }) });
    for (const [i, j] of [[0, 0], [0, 15], [15, 0], [7, 9], [15, 15]] as const) {
      const [x, y] = cellSquare(i, j, 3, 3);
      expect(data.getArea(x, y)).toBe(1000 + i * 16 + j);
    }
  });
});

describe("convertADTData MCLQ liquid", () => {
  const water = (i: number, j: number): TestCell => {
    const inLake = i >= 4 && i <= 5 && j >= 6 && j <= 7;
    return { ypos: 40, areaid: 9, flags: inLake ? 1 << 2 : 0, mclq: inLake ? mclq(50, i === 4 && j === 6 ? [0] : []) : undefined };
  };

  test("water cells report level, flags and swimming status", async () => {
    const data = await convertAndLoad({ cell: water });
    const [x, y] = cellSquare(5, 7, 4, 4);
    const under = data.getLiquidData(x, y, 45, 2);
    expect(under.Status).toBe(LIQUID_MAP_UNDER_WATER); // 5 yards below the surface, collision height 2
    expect(under.Level).toBeCloseTo(50, 3);
    expect(under.Flags).toBe(MAP_LIQUID_TYPE_WATER);
    expect(under.DepthLevel).toBeCloseTo(40, 1);
    expect(data.getLiquidData(x, y, 49, 2).Status).toBe(LIQUID_MAP_IN_WATER);
    expect(data.getLiquidData(x, y, 55, 2).Status).toBe(LIQUID_MAP_ABOVE_WATER);
    expect(data.getLiquidLevel(x, y)).toBeCloseTo(50, 3);
  });

  test("outside the lake and in a hidden square there is no liquid", async () => {
    const data = await convertAndLoad({ cell: water });
    const [x, y] = cellSquare(10, 10, 4, 4);
    expect(data.getLiquidData(x, y, 45, 2).Status).toBe(LIQUID_MAP_NO_WATER);
    // square (0, 0) of cell (4, 6) has flags 0x0f: not shown, no height stored for it
    const [hx, hy] = cellSquare(4, 6, 0, 0);
    expect(data.getLiquidData(hx, hy, 45, 2).Level).not.toBeCloseTo(50, 1);
  });

  test("MCNK flag bits select water, ocean or magma", async () => {
    const kinds: [number, number][] = [
      [1 << 2, MAP_LIQUID_TYPE_WATER],
      [1 << 3, MAP_LIQUID_TYPE_OCEAN],
      [1 << 4, MAP_LIQUID_TYPE_MAGMA],
    ];
    for (const [flag, type] of kinds) {
      const data = await convertAndLoad({ cell: (i, j) => ({ ypos: 0, flags: i === 2 && j === 2 ? flag : 0, mclq: i === 2 && j === 2 ? mclq(10) : undefined }) });
      const [x, y] = cellSquare(2, 2, 3, 3);
      const liquid = data.getLiquidData(x, y, 5, 2);
      expect(liquid.Flags & type).toBe(type);
      expect(liquid.Level).toBeCloseTo(10, 3);
    }
  });

  test("an MCLQ block with sizeMCLQ <= 8 is ignored", async () => {
    const bytes = convertSynthetic({ cell: () => ({ ypos: 0, flags: 1 << 2, mclq: mclq(10), sizeMCLQ: 8 }) });
    expect(bytes.length).toBe(44 + 8 + 16); // no liquid section
  });
});

describe("convertADTData MH2O liquid", () => {
  const lake = (type: number, extra: Partial<TestH2OInstance> = {}): Map<number, TestH2OInstance> => {
    const h2o = new Map<number, TestH2OInstance>();
    // cell (6, 3): an offset 2,1 patch of 4 * 3 squares, heights 20 + vertex index / 10
    const heights = new Float32Array(5 * 4);
    for (let k = 0; k < heights.length; k++) heights[k] = 20 + k / 10;
    h2o.set(6 * 16 + 3, { liquidType: type, width: 4, height: 3, offsetX: 2, offsetY: 1, heights, ...extra });
    return h2o;
  };

  test("a patch has its own heights, type and extent", async () => {
    const data = await convertAndLoad({ cell: () => ({ ypos: 0 }), h2o: lake(1) });
    // the patch covers squares y 1..3 (rows) and x 2..5 (columns) of cell (6, 3)
    const [x, y] = cellSquare(6, 3, 2, 3);
    const liquid = data.getLiquidData(x, y, 5, 2);
    expect(liquid.Flags & MAP_LIQUID_TYPE_WATER).toBe(MAP_LIQUID_TYPE_WATER);
    expect(liquid.Level).toBeGreaterThan(20);
    expect(liquid.Level).toBeLessThan(22);
    const [ox, oy] = cellSquare(6, 3, 6, 6);
    expect(data.getLiquidData(ox, oy, 5, 2).Status).toBe(LIQUID_MAP_NO_WATER);
    const [nx, ny] = cellSquare(1, 1, 3, 3);
    expect(data.getLiquidData(nx, ny, 5, 2).Status).toBe(LIQUID_MAP_NO_WATER);
  });

  test("ocean type with the Deep attribute adds the dark water flag", async () => {
    const deep = await convertAndLoad({ cell: () => ({ ypos: -100 }), h2o: lake(2, { deep: 0xffffffffffffffffn }) });
    const shallow = await convertAndLoad({ cell: () => ({ ypos: -100 }), h2o: lake(2, { deep: 0n }) });
    const [x, y] = cellSquare(6, 3, 2, 3);
    expect(deep.getLiquidData(x, y, 0, 2).Flags & MAP_LIQUID_TYPE_DARK_WATER).toBe(MAP_LIQUID_TYPE_DARK_WATER);
    expect(shallow.getLiquidData(x, y, 0, 2).Flags & MAP_LIQUID_TYPE_DARK_WATER).toBe(0);
    expect(shallow.getLiquidData(x, y, 0, 2).Flags & MAP_LIQUID_TYPE_OCEAN).toBe(MAP_LIQUID_TYPE_OCEAN);
  });

  test("an instance without an attributes block counts as all deep (like adt_MH2O::GetLiquidAttributes)", async () => {
    const data = await convertAndLoad({ cell: () => ({ ypos: -100 }), h2o: lake(2) });
    const [x, y] = cellSquare(6, 3, 2, 3);
    expect(data.getLiquidData(x, y, 0, 2).Flags & MAP_LIQUID_TYPE_DARK_WATER).toBe(MAP_LIQUID_TYPE_DARK_WATER);
  });

  test("the exists bitmap hides squares", async () => {
    // bit k = square (k / width, k % width): drop the first column of the patch
    let exists = 0n;
    for (let k = 0; k < 12; k++) if (k % 4 !== 0) exists |= 1n << BigInt(k);
    const data = await convertAndLoad({ cell: () => ({ ypos: 0 }), h2o: lake(1, { exists }) });
    const gone = cellSquare(6, 3, 1, 2);
    const kept = cellSquare(6, 3, 1, 3);
    const level = (p: [number, number]) => data.getLiquidData(p[0], p[1], 0, 2);
    // a hidden square has no stored height; the shown neighbour has
    expect(level(kept).Level).toBeGreaterThan(20);
    expect(level(gone).Level).not.toBeGreaterThan(20);
  });

  test("an MH2O type that is not in LiquidType.dbc is a conversion error", () => {
    expect(() => convertSynthetic({ cell: () => ({ ypos: 0 }), h2o: lake(999) })).toThrow();
  });
});
