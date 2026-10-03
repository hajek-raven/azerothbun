import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sAreaTableStore, sLiquidTypeStore } from "../DataStores/DBCStores.ts";
import {
  GridTerrainData,
  INVALID_HEIGHT,
  LIQUID_MAP_ABOVE_WATER,
  LIQUID_MAP_IN_WATER,
  LIQUID_MAP_NO_WATER,
  LIQUID_MAP_UNDER_WATER,
  LIQUID_MAP_WATER_WALK,
  LiquidData,
  MAP_LIQUID_TYPE_DARK_WATER,
  MAP_LIQUID_TYPE_OCEAN,
  MAP_LIQUID_TYPE_WATER,
  MIN_HEIGHT,
  MapMagic,
  readMapFileHeader,
  sizeof_map_areaHeader,
  sizeof_map_fileheader,
  sizeof_map_heightHeader,
  sizeof_map_liquidHeader,
  TerrainMapDataReadResult,
} from "./GridTerrainData.ts";
import { buildMapFile, packLiquid, type TestMap } from "./GridTerrainData.test-util.ts";

const SIZE_OF_GRIDS = Math.fround(533.3333);

let dir: string;
let counter = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wow-ts-terrain-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes the map to a fresh file and loads it. */
async function load(map: TestMap | Uint8Array): Promise<{ data: GridTerrainData; result: TerrainMapDataReadResult }> {
  const path = join(dir, `${counter++}.map`);
  await Bun.write(path, map instanceof Uint8Array ? map : buildMapFile(map));
  const data = new GridTerrainData();
  return { data, result: data.load(path) };
}

async function loaded(map: TestMap): Promise<GridTerrainData> {
  const { data, result } = await load(map);
  expect(result).toBe(TerrainMapDataReadResult.Success);
  return data;
}

/** The world coordinate that is `offset` height cells (1/128 of a grid) into the grid tile that starts at x = 0. */
function world(offset: number): number {
  return Math.fround((-SIZE_OF_GRIDS * offset) / 128);
}

/** Heights 50..305 so that the uint8 step is exactly 1 and the uint16 step exactly 257. */
function heights(): { V9: Float32Array; V8: Float32Array } {
  const V9 = new Float32Array(129 * 129);
  const V8 = new Float32Array(128 * 128);
  for (let x = 0; x <= 128; x++) for (let y = 0; y <= 128; y++) V9[x * 129 + y] = 50 + ((x * 7 + y * 3) % 256);
  for (let x = 0; x < 128; x++) for (let y = 0; y < 128; y++) V8[x * 128 + y] = 50 + ((x * 13 + y * 5 + 100) % 256);
  V9[0] = 50;
  V9[1] = 305;
  return { V9, V8 };
}

type Vertex = [x: number, y: number, h: number];

/** Height at (x, y) of the plane through three points (Cramer's rule, independent of the `a*x + b*y + c` of C++). */
function planeAt(p: Vertex, q: Vertex, r: Vertex, x: number, y: number): number {
  const det = (q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]);
  const u = ((x - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (y - p[1])) / det;
  const v = ((q[0] - p[0]) * (y - p[1]) - (x - p[0]) * (q[1] - p[1])) / det;
  return p[2] + u * (q[2] - p[2]) + v * (r[2] - p[2]);
}

/** The four triangles of cell (xi, yi): [fractionX, fractionY, expected height]. */
function triangleSamples(V9: Float32Array, V8: Float32Array, xi: number, yi: number): [number, number, number][] {
  const h1 = V9[xi * 129 + yi]!;
  const h2 = V9[(xi + 1) * 129 + yi]!;
  const h3 = V9[xi * 129 + yi + 1]!;
  const h4 = V9[(xi + 1) * 129 + yi + 1]!;
  const c = V8[xi * 128 + yi]!;
  const v1: Vertex = [0, 0, h1];
  const v2: Vertex = [1, 0, h2];
  const v3: Vertex = [0, 1, h3];
  const v4: Vertex = [1, 1, h4];
  const v5: Vertex = [0.5, 0.5, c];
  return [
    [0.5, 0.25, planeAt(v1, v2, v5, 0.5, 0.25)], // triangle 1: x + y < 1, x > y
    [0.25, 0.5, planeAt(v1, v3, v5, 0.25, 0.5)], // triangle 2: x + y < 1, x < y
    [0.75, 0.5, planeAt(v2, v4, v5, 0.75, 0.5)], // triangle 3: x + y >= 1, x > y
    [0.5, 0.75, planeAt(v3, v4, v5, 0.5, 0.75)], // triangle 4: x + y >= 1, x < y
  ];
}

const CELLS: [number, number][] = [
  [0, 0],
  [5, 9],
  [64, 100],
  [127, 127],
  [127, 0],
  [0, 127],
];

describe("map file format", () => {
  test("magic numbers and header sizes", () => {
    expect(MapMagic.asUInt).toBe(0x5350414d);
    expect(sizeof_map_fileheader).toBe(44);
    expect(sizeof_map_areaHeader).toBe(8);
    expect(sizeof_map_heightHeader).toBe(16);
    expect(sizeof_map_liquidHeader).toBe(16);
  });

  test("the writer lays the sections out like the extractor", () => {
    const { V9, V8 } = heights();
    const bytes = buildMapFile({
      areaIds: new Uint16Array(256).map((_, i) => i),
      height: { V9, V8, encoding: "uint16" },
      holes: new Uint16Array(256).fill(1),
    });
    const header = readMapFileHeader(new DataView(bytes.buffer), 0);
    expect(header.areaMapOffset).toBe(44);
    expect(header.areaMapSize).toBe(8 + 512);
    expect(header.heightMapOffset).toBe(44 + 520);
    expect(header.heightMapSize).toBe(16 + (129 * 129 + 128 * 128) * 2);
    expect(header.liquidMapOffset).toBe(0);
    expect(header.holesOffset).toBe(header.heightMapOffset + header.heightMapSize);
    expect(header.holesSize).toBe(512);
    expect(bytes.length).toBe(header.holesOffset + 512);
  });
});

describe("GridTerrainData::load", () => {
  test("missing file", () => {
    expect(new GridTerrainData().load(join(dir, "does-not-exist.map"))).toBe(TerrainMapDataReadResult.NotFound);
  });

  test("a file without a full header is a read error", async () => {
    expect((await load(new Uint8Array(0))).result).toBe(TerrainMapDataReadResult.ReadError);
    expect((await load(new Uint8Array(10))).result).toBe(TerrainMapDataReadResult.ReadError);
  });

  test("wrong map or version magic", async () => {
    const good = buildMapFile({ areaIds: new Uint16Array(256).fill(12) });
    const badMagic = good.slice();
    badMagic[0] = 0x58;
    expect((await load(badMagic)).result).toBe(TerrainMapDataReadResult.InvalidMagic);
    const badVersion = good.slice();
    badVersion[4] = 8;
    expect((await load(badVersion)).result).toBe(TerrainMapDataReadResult.InvalidMagic);
  });

  test("area section", async () => {
    const good = buildMapFile({ areaIds: new Uint16Array(256).map((_, i) => i) });
    const badFourcc = good.slice();
    badFourcc[44] = 0;
    expect((await load(badFourcc)).result).toBe(TerrainMapDataReadResult.InvalidAreaData);
    expect((await load(good.slice(0, good.length - 1))).result).toBe(TerrainMapDataReadResult.InvalidAreaData);
    expect((await load(good.slice(0, 44 + 4))).result).toBe(TerrainMapDataReadResult.InvalidAreaData);
  });

  test("height section", async () => {
    const { V9, V8 } = heights();
    for (const encoding of ["float", "uint16", "uint8"] as const) {
      const good = buildMapFile({ height: { V9, V8, encoding } });
      expect((await load(good)).result).toBe(TerrainMapDataReadResult.Success);
      expect((await load(good.slice(0, good.length - 1))).result).toBe(TerrainMapDataReadResult.InvalidHeightData);
      const badFourcc = good.slice();
      badFourcc[44] = 0;
      expect((await load(badFourcc)).result).toBe(TerrainMapDataReadResult.InvalidHeightData);
    }
    // flight bounds are read after the arrays
    const withBox = buildMapFile({ height: { V9, V8, encoding: "uint8", flightBox: { max: new Array(9).fill(1), min: new Array(9).fill(0) } } });
    expect((await load(withBox)).result).toBe(TerrainMapDataReadResult.Success);
    expect((await load(withBox.slice(0, withBox.length - 2))).result).toBe(TerrainMapDataReadResult.InvalidHeightData);
  });

  test("liquid section", async () => {
    const good = buildMapFile({
      liquid: { liquidType: 1, liquidFlags: 1, width: 4, height: 4, entry: new Uint16Array(256).fill(1), flags: new Uint8Array(256).fill(1), heights: new Float32Array(16) },
    });
    expect((await load(good)).result).toBe(TerrainMapDataReadResult.Success);
    expect((await load(good.slice(0, good.length - 1))).result).toBe(TerrainMapDataReadResult.InvalidLiquidData);
    const badFourcc = good.slice();
    badFourcc[44] = 0;
    expect((await load(badFourcc)).result).toBe(TerrainMapDataReadResult.InvalidLiquidData);
  });

  test("holes section", async () => {
    const good = buildMapFile({ holes: new Uint16Array(256).fill(0xffff) });
    expect((await load(good)).result).toBe(TerrainMapDataReadResult.Success);
    expect((await load(good.slice(0, good.length - 2))).result).toBe(TerrainMapDataReadResult.InvalidHoleData);
  });

  test("a file with no sections loads and answers like no data", async () => {
    const data = await loaded({});
    expect(data.getHeight(0, 0)).toBe(INVALID_HEIGHT);
    expect(data.getArea(0, 0)).toBe(0);
    expect(data.getLiquidLevel(0, 0)).toBe(INVALID_HEIGHT);
    expect(data.getMinHeight(0, 0)).toBe(MIN_HEIGHT);
    expect(data.getLiquidData(0, 0, 0, 2).Status).toBe(LIQUID_MAP_NO_WATER);
  });
});

describe("getHeight", () => {
  test("flat grid", async () => {
    const { V9, V8 } = heights();
    V9.fill(81.5);
    V8.fill(81.5);
    const data = await loaded({ height: { V9, V8, encoding: "flat" } });
    expect(data.getHeight(world(5.25), world(9.5))).toBe(81.5);
    expect(data.getHeight(1234, -4321)).toBe(81.5);
  });

  for (const encoding of ["float", "uint16", "uint8"] as const) {
    test(`${encoding} interpolation picks the right triangle`, async () => {
      const { V9, V8 } = heights();
      const data = await loaded({ height: { V9, V8, encoding } });
      for (const [xi, yi] of CELLS) {
        for (const [fx, fy, expected] of triangleSamples(V9, V8, xi, yi)) {
          expect(data.getHeight(world(xi + fx), world(yi + fy))).toBeCloseTo(expected, encoding === "float" ? 4 : 2);
        }
      }
    });

    test(`${encoding} grid wraps every 128 cells`, async () => {
      const { V9, V8 } = heights();
      const data = await loaded({ height: { V9, V8, encoding } });
      const [fx, fy, expected] = triangleSamples(V9, V8, 5, 9)[0]!;
      for (const tile of [0, 1, 3, -2]) {
        expect(data.getHeight(world(5 + fx + 128 * tile), world(9 + fy + 128 * tile))).toBeCloseTo(expected, 2);
      }
    });
  }

  test("hand computed cell (h1 10, h2 20, h3 30, h4 40, center 28)", async () => {
    const V9 = new Float32Array(129 * 129);
    const V8 = new Float32Array(128 * 128);
    // cell (0, 0): V9[x * 129 + y]
    V9[0] = 10; // h1 (0, 0)
    V9[129] = 20; // h2 (x + 1, y)
    V9[1] = 30; // h3 (x, y + 1)
    V9[130] = 40; // h4 (x + 1, y + 1)
    V8[0] = 28; // center, h5 = 56
    const data = await loaded({ height: { V9, V8, encoding: "float" } });
    // a = h2 - h1, b = h5 - h1 - h2, c = h1
    expect(data.getHeight(world(0.5), world(0.25))).toBeCloseTo(10 * 0.5 + 26 * 0.25 + 10, 4); // 21.5
    // a = h5 - h1 - h3, b = h3 - h1, c = h1
    expect(data.getHeight(world(0.25), world(0.5))).toBeCloseTo(16 * 0.25 + 20 * 0.5 + 10, 4); // 24
    // a = h2 + h4 - h5, b = h4 - h2, c = h5 - h4
    expect(data.getHeight(world(0.75), world(0.5))).toBeCloseTo(4 * 0.75 + 20 * 0.5 + 16, 4); // 29
    // a = h4 - h3, b = h3 + h4 - h5, c = h5 - h4
    expect(data.getHeight(world(0.5), world(0.75))).toBeCloseTo(10 * 0.5 + 14 * 0.75 + 16, 4); // 31.5
    // on the grid points
    expect(data.getHeight(world(0), world(0))).toBe(10);
    expect(data.getHeight(world(0.5), world(0.5))).toBe(28); // the diagonal x == y with x + y >= 1 is triangle 4
  });

  test("uint16 heights are scaled from gridHeight to gridMaxHeight", async () => {
    const V9 = new Float32Array(129 * 129).fill(100);
    const V8 = new Float32Array(128 * 128).fill(100);
    V9[0] = 0;
    V9[129 * 129 - 1] = 1000;
    const data = await loaded({ height: { V9, V8, encoding: "uint16" } });
    // cell (0, 0) corner h1 = V9[0] = 0 (quantized 0), at the grid origin
    expect(data.getHeight(world(0), world(0))).toBeCloseTo(0, 2);
    // the middle of a flat 100 cell
    expect(data.getHeight(world(64.5), world(64.25))).toBeCloseTo(100, 1);
  });

  test("holes make the height invalid in their 2x2 cells", async () => {
    const { V9, V8 } = heights();
    const holes = new Uint16Array(256);
    holes[3 * 16 + 4] = 0x0001 | 0x0200; // rows 24-25 x cols 32-33, and rows 28-29 x cols 34-35 of cell (3, 4)
    const data = await loaded({ height: { V9, V8, encoding: "float" }, holes });
    const at = (row: number, col: number): number => data.getHeight(world(row + 0.5), world(col + 0.25));
    expect(at(24, 32)).toBe(INVALID_HEIGHT);
    expect(at(25, 33)).toBe(INVALID_HEIGHT);
    expect(at(28, 34)).toBe(INVALID_HEIGHT);
    expect(at(29, 35)).toBe(INVALID_HEIGHT);
    expect(at(26, 32)).not.toBe(INVALID_HEIGHT);
    expect(at(24, 34)).not.toBe(INVALID_HEIGHT);
    expect(at(28, 32)).not.toBe(INVALID_HEIGHT);
    expect(at(30, 36)).not.toBe(INVALID_HEIGHT);
    expect(at(24, 40)).not.toBe(INVALID_HEIGHT); // next cell
    // the other encodings use the same hole table
    for (const encoding of ["uint16", "uint8"] as const) {
      const other = await loaded({ height: { V9, V8, encoding }, holes });
      expect(other.getHeight(world(24.5), world(32.25))).toBe(INVALID_HEIGHT);
      expect(other.getHeight(world(26.5), world(32.25))).not.toBe(INVALID_HEIGHT);
    }
  });

  test("a grid with holes but no height data has no holes to test", async () => {
    const holes = new Uint16Array(256).fill(0xffff);
    const data = await loaded({ holes });
    expect(data.getHeight(world(1), world(1))).toBe(INVALID_HEIGHT);
  });
});

describe("getMinHeight (flight bounds)", () => {
  const minHeights = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  const flightBox = { max: [0, 0, 0, 0, 0, 0, 0, 0, 0], min: minHeights };
  const quarters = [
    [3, 0, 4],
    [0, 1, 4],
    [1, 2, 4],
    [2, 5, 4],
    [5, 8, 4],
    [8, 7, 4],
    [7, 6, 4],
    [6, 3, 4],
  ];
  /** (gx, gy) of the nine bound points */
  const points = [
    [0, 0],
    [0, -266.66666],
    [0, -533.33331],
    [-266.66666, 0],
    [-266.66666, -266.66666],
    [-266.66666, -533.33331],
    [-533.33331, 0],
    [-533.33331, -266.66666],
    [-533.33331, -533.33331],
  ] as const;

  async function flightMap(): Promise<GridTerrainData> {
    const { V9, V8 } = heights();
    return loaded({ height: { V9, V8, encoding: "uint8", flightBox } });
  }

  test("without flight bounds the minimum is MIN_HEIGHT", async () => {
    const { V9, V8 } = heights();
    const data = await loaded({ height: { V9, V8, encoding: "uint8" } });
    expect(data.getMinHeight(-100, -100)).toBe(MIN_HEIGHT);
  });

  test("every plane of a grid passes through the bound at its center", async () => {
    const data = await flightMap();
    // grid (20, 20): x_coord = 63 - int(32 - x / S) => x in (-12 S, -11 S], gx = x + 11 S
    const origin = Math.fround(-11 * SIZE_OF_GRIDS);
    expect(data.getMinHeight(Math.fround(origin - 266.66666), Math.fround(origin - 266.66666))).toBeCloseTo(50, 2); // point 4
  });

  for (const [gridX, gridY] of [
    [20, 30],
    [21, 31],
  ] as const) {
    test(`the centroid of each of the 8 triangles of grid (${gridX}, ${gridY}) is the mean of its three bound heights`, async () => {
      const data = await flightMap();
      for (const quarter of quarters) {
        const gx = (points[quarter[0]!]![0] + points[quarter[1]!]![0] + points[quarter[2]!]![0]) / 3;
        const gy = (points[quarter[0]!]![1] + points[quarter[1]!]![1] + points[quarter[2]!]![1]) / 3;
        const expected = (minHeights[quarter[0]!]! + minHeights[quarter[1]!]! + minHeights[quarter[2]!]!) / 3;
        const x = Math.fround(gx + (gridX - 31) * SIZE_OF_GRIDS);
        const y = Math.fround(gy + (gridY - 31) * SIZE_OF_GRIDS);
        expect(data.getMinHeight(x, y)).toBeCloseTo(expected, 1);
      }
    });
  }
});

describe("getArea", () => {
  test("a uniform grid stores only gridArea", async () => {
    const data = await loaded({ areaIds: new Uint16Array(256).fill(12) });
    expect(data.loaded.area).toEqual({ gridArea: 12, areaMap: -1 });
    expect(data.getArea(world(3), world(70))).toBe(12);
    expect(data.getArea(-8914, -133)).toBe(12);
  });

  test("a full area map is indexed [x * 16 + y] in 8x8 cell blocks", async () => {
    const areaIds = new Uint16Array(256).map((_, i) => 1000 + i);
    const data = await loaded({ areaIds });
    // height cell (21, 41) is area cell (2, 5)
    expect(data.getArea(world(21.25), world(41.5))).toBe(1000 + 2 * 16 + 5);
    expect(data.getArea(world(0.25), world(0.25))).toBe(1000);
    expect(data.getArea(world(127.5), world(127.5))).toBe(1000 + 15 * 16 + 15);
    // the whole 8x8 block has the same area
    expect(data.getArea(world(16.25), world(40.25))).toBe(1000 + 2 * 16 + 5);
    expect(data.getArea(world(23.5), world(47.5))).toBe(1000 + 2 * 16 + 5);
    expect(data.getArea(world(24.25), world(47.5))).toBe(1000 + 3 * 16 + 5);
    // wraps with the grid
    expect(data.getArea(world(21.25 + 128), world(41.5 + 256))).toBe(1000 + 2 * 16 + 5);
  });
});

describe("liquid", () => {
  beforeAll(() => {
    // LiquidType.dbc rows 1-4 (water, ocean, magma, slime); `Type` is the liquid kind bit
    sLiquidTypeStore.set(1, { Id: 1, Type: 0, SpellId: 0 });
    sLiquidTypeStore.set(2, { Id: 2, Type: 1, SpellId: 0 });
    sLiquidTypeStore.set(3, { Id: 3, Type: 2, SpellId: 0 });
    sLiquidTypeStore.set(4, { Id: 4, Type: 3, SpellId: 0 });
    // areas with `LiquidTypeOverride`: 60001 overrides ocean with magma, 60002 (zone 60000) inherits slime from its zone
    sAreaTableStore.set(60000, { ID: 60000, mapid: 0, zone: 0, exploreFlag: 0, flags: 0, area_level: 0, area_name: [], team: 0, LiquidTypeOverride: [0, 4, 0, 0] });
    sAreaTableStore.set(60001, { ID: 60001, mapid: 0, zone: 60000, exploreFlag: 0, flags: 0, area_level: 0, area_name: [], team: 0, LiquidTypeOverride: [0, 3, 0, 0] });
    sAreaTableStore.set(60002, { ID: 60002, mapid: 0, zone: 60000, exploreFlag: 0, flags: 0, area_level: 0, area_name: [], team: 0, LiquidTypeOverride: [0, 0, 0, 0] });
  });

  /** A flat 10 ground with one liquid kind over the whole grid at level 20 (the extractor's "no type, no height" packing). */
  async function lake(): Promise<GridTerrainData> {
    const { V9, V8 } = heights();
    V9.fill(10);
    V8.fill(10);
    return loaded({
      height: { V9, V8, encoding: "flat" },
      liquid: { liquidType: 1, liquidFlags: MAP_LIQUID_TYPE_WATER, offsetX: 0, offsetY: 0, width: 128, height: 128, liquidLevel: 20 },
    });
  }

  test("status follows the distance of z to the level and the collision height", async () => {
    const data = await lake();
    const x = world(40.25);
    const y = world(50.5);
    const at = (z: number, collisionHeight = 2): LiquidData => data.getLiquidData(x, y, z, collisionHeight);

    let liquid = at(25);
    expect(liquid.Status).toBe(LIQUID_MAP_ABOVE_WATER);
    expect(liquid.Entry).toBe(1);
    expect(liquid.Flags).toBe(MAP_LIQUID_TYPE_WATER);
    expect(liquid.Level).toBe(20);
    expect(liquid.DepthLevel).toBe(10);

    expect(at(20.05).Status).toBe(LIQUID_MAP_WATER_WALK); // delta -0.05 > -0.1
    expect(at(20.2).Status).toBe(LIQUID_MAP_ABOVE_WATER);
    expect(at(19.5).Status).toBe(LIQUID_MAP_IN_WATER);
    expect(at(18).Status).toBe(LIQUID_MAP_IN_WATER); // delta == collisionHeight is not under water
    expect(at(17.5).Status).toBe(LIQUID_MAP_UNDER_WATER);
    expect(at(17.5, 3).Status).toBe(LIQUID_MAP_IN_WATER);
    expect(at(10).Status).toBe(LIQUID_MAP_UNDER_WATER);

    // below the ground by more than 0.2 there is no water
    liquid = at(9.7);
    expect(liquid.Status).toBe(LIQUID_MAP_NO_WATER);
    expect(liquid.Entry).toBe(0);
    expect(liquid.Level).toBe(INVALID_HEIGHT);
    expect(at(9.85).Status).toBe(LIQUID_MAP_UNDER_WATER);
  });

  test("the required liquid mask filters by type", async () => {
    const data = await lake();
    const x = world(40.25);
    const y = world(50.5);
    expect(data.getLiquidData(x, y, 15, 2, MAP_LIQUID_TYPE_WATER).Status).toBe(LIQUID_MAP_UNDER_WATER);
    expect(data.getLiquidData(x, y, 15, 2, MAP_LIQUID_TYPE_WATER | MAP_LIQUID_TYPE_OCEAN).Status).toBe(LIQUID_MAP_UNDER_WATER);
    expect(data.getLiquidData(x, y, 15, 2, MAP_LIQUID_TYPE_OCEAN).Status).toBe(LIQUID_MAP_NO_WATER);
  });

  test("an out parameter is reused", async () => {
    const data = await lake();
    const out = new LiquidData();
    const result = data.getLiquidData(world(40.25), world(50.5), 15, 2, undefined, out);
    expect(result).toBe(out);
    expect(out.Status).toBe(LIQUID_MAP_UNDER_WATER);
    expect(data.getLiquidData(world(40.25), world(50.5), 0, 2, undefined, out)).toBe(out); // below the ground
    expect(out.Status).toBe(LIQUID_MAP_NO_WATER);
    expect(out.Level).toBe(INVALID_HEIGHT);
  });

  test("getLiquidLevel without a height map is the header level", async () => {
    const data = await lake();
    expect(data.getLiquidLevel(world(40.25), world(50.5))).toBe(20);
  });

  test("a liquid section without flags holds no water", async () => {
    const data = await loaded({ liquid: { liquidType: 1, liquidFlags: 0, width: 128, height: 128, liquidLevel: 20 } });
    expect(data.getLiquidData(world(1), world(1), 15, 2).Status).toBe(LIQUID_MAP_NO_WATER);
    expect(data.getLiquidLevel(world(1), world(1))).toBe(20);
  });

  test("per cell entries, flags and the area liquid override", async () => {
    const entry = new Uint16Array(256).fill(1);
    const flags = new Uint8Array(256).fill(MAP_LIQUID_TYPE_WATER);
    const areaIds = new Uint16Array(256).fill(60001);
    // area cell (2, 3) covers height cells x 16-23, y 24-31
    entry[2 * 16 + 3] = 2; // ocean
    flags[2 * 16 + 3] = MAP_LIQUID_TYPE_OCEAN | MAP_LIQUID_TYPE_DARK_WATER;
    areaIds[2 * 16 + 3] = 60001; // overrides ocean (Type 1) with magma (3, Type 2)
    entry[2 * 16 + 4] = 2;
    flags[2 * 16 + 4] = MAP_LIQUID_TYPE_OCEAN;
    areaIds[2 * 16 + 4] = 60002; // no override of its own: the zone 60000 gives slime (4, Type 3)
    entry[2 * 16 + 5] = 2;
    flags[2 * 16 + 5] = MAP_LIQUID_TYPE_OCEAN;
    areaIds[2 * 16 + 5] = 59999; // no area row: stays ocean
    entry[2 * 16 + 6] = 4000; // no LiquidType row: the flags stay
    flags[2 * 16 + 6] = 0x40;
    const data = await loaded({
      areaIds,
      liquid: { liquidType: 0, liquidFlags: 0, width: 128, height: 128, liquidLevel: 20, entry, flags },
    });
    const query = (cellX: number, cellY: number): LiquidData => data.getLiquidData(world(cellX + 0.25), world(cellY + 0.5), 5, 2);

    // plain water cell
    let liquid = query(0, 0);
    expect(liquid.Status).toBe(LIQUID_MAP_UNDER_WATER);
    expect(liquid.Entry).toBe(1);
    expect(liquid.Flags).toBe(MAP_LIQUID_TYPE_WATER);

    // ocean overridden by the area to magma, dark water bit kept
    liquid = query(16, 24);
    expect(liquid.Entry).toBe(3);
    expect(liquid.Flags).toBe(0x04 | MAP_LIQUID_TYPE_DARK_WATER);

    // override from the zone
    liquid = query(16, 32);
    expect(liquid.Entry).toBe(4);
    expect(liquid.Flags).toBe(0x08);

    // area without an override and without a row for its zone
    liquid = query(16, 40);
    expect(liquid.Entry).toBe(2);
    expect(liquid.Flags).toBe(MAP_LIQUID_TYPE_OCEAN);

    // entry 4000: no LiquidType row, the flags are returned as stored
    liquid = query(16, 48);
    expect(liquid.Entry).toBe(4000);
    expect(liquid.Flags).toBe(0x40);

    // a mask that does not match the (overridden) type
    expect(data.getLiquidData(world(16.25), world(24.5), 5, 2, MAP_LIQUID_TYPE_OCEAN).Status).toBe(LIQUID_MAP_NO_WATER);
    expect(data.getLiquidData(world(16.25), world(24.5), 5, 2, 0x04).Status).toBe(LIQUID_MAP_UNDER_WATER);
  });

  test("a liquid height map restricted to a rectangle (extractor packing)", async () => {
    const entry = new Uint16Array(256).fill(1);
    const flags = new Uint8Array(256).fill(MAP_LIQUID_TYPE_WATER);
    // rows (world x cells) 16-39, columns (world y cells) 8-23
    const liquid = packLiquid(
      entry,
      flags,
      (col, row) => row >= 16 && row <= 39 && col >= 8 && col <= 23,
      (col, row) => 30 + row * 0.5 + col * 0.25,
    );
    expect(liquid.offsetX).toBe(8);
    expect(liquid.offsetY).toBe(16);
    expect(liquid.width).toBe(17);
    expect(liquid.height).toBe(25);
    const { V9, V8 } = heights();
    V9.fill(10);
    V8.fill(10);
    const data = await loaded({ height: { V9, V8, encoding: "flat" }, liquid });

    // row 20, column 10
    expect(data.getLiquidLevel(world(20.5), world(10.5))).toBe(30 + 10 + 2.5);
    expect(data.getLiquidLevel(world(16.5), world(8.5))).toBe(30 + 8 + 2);
    expect(data.getLiquidLevel(world(39.5), world(23.5))).toBe(30 + 19.5 + 5.75);
    // outside the stored rectangle
    expect(data.getLiquidLevel(world(15.5), world(10.5))).toBe(INVALID_HEIGHT);
    expect(data.getLiquidLevel(world(20.5), world(7.5))).toBe(INVALID_HEIGHT);
    expect(data.getLiquidLevel(world(41.5), world(10.5))).toBe(INVALID_HEIGHT);
    expect(data.getLiquidLevel(world(20.5), world(25.5))).toBe(INVALID_HEIGHT);

    const inside = data.getLiquidData(world(20.5), world(10.5), 38, 2);
    expect(inside.Level).toBe(42.5);
    expect(inside.DepthLevel).toBe(10);
    expect(inside.Status).toBe(LIQUID_MAP_UNDER_WATER); // 42.5 - 38 = 4.5 > collision height 2
    expect(data.getLiquidData(world(20.5), world(10.5), 41, 2).Status).toBe(LIQUID_MAP_IN_WATER); // 1.5
    expect(data.getLiquidData(world(15.5), world(10.5), 38, 2).Status).toBe(LIQUID_MAP_NO_WATER);
    // the column and row after the last shown one are stored with the minimum height, below the ground
    expect(data.getLiquidData(world(24.5), world(24.5), 38, 2).Status).toBe(LIQUID_MAP_NO_WATER);
  });
});

describe("uint8 and uint16 stored without float error", () => {
  test("uint8 with a step of 1 reproduces the float heights", async () => {
    const { V9, V8 } = heights();
    const float = await loaded({ height: { V9, V8, encoding: "float" } });
    const uint8 = await loaded({ height: { V9, V8, encoding: "uint8" } });
    for (let i = 0; i < 200; i++) {
      const x = world(((i * 37) % 128) + 0.25 * (i % 4));
      const y = world(((i * 53) % 128) + 0.25 * ((i >> 2) % 4));
      expect(uint8.getHeight(x, y)).toBeCloseTo(float.getHeight(x, y), 3);
    }
  });
});
