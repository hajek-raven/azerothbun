/** Synthetic ADT: height encodings, flat tiles, the minimum height clamp, flight bounds and holes. */
import { describe, expect, test } from "bun:test";
import { INVALID_HEIGHT } from "../../game/Grids/GridTerrainData.ts";
import { buildMCVT, type TestADT } from "./adt.test-util.ts";
import { cellSquare, convertAndLoad, convertSynthetic, worldAt } from "./convert.test-util.ts";

/** An ADT whose V9 height at grid vertex `(cy, cx)` is `H(cy, cx)` (V8 = H at the half step position). */
function planeADT(H: (cy: number, cx: number) => number, extra: Partial<TestADT> = {}): TestADT {
  return {
    ...extra,
    cell: (i, j) => ({
      ypos: 10,
      mcvt: buildMCVT(
        (x, y) => H(i * 8 + y, j * 8 + x) - 10,
        (x, y) => H(i * 8 + y + 0.5, j * 8 + x + 0.5) - 10,
      ),
    }),
  };
}

describe("convertADTData heights", () => {
  test("a flat tile stores only the grid height", async () => {
    const adt: TestADT = { cell: () => ({ ypos: 123.5 }) };
    const bytes = convertSynthetic(adt);
    // header (44) + area header (8) + height header (16): no height arrays at all
    expect(bytes.length).toBe(44 + 8 + 16);
    const data = await convertAndLoad(adt);
    expect(data.getHeight(-100, 200)).toBe(123.5);
    // no flight bounds: the runtime falls back to MIN_HEIGHT
    expect(data.getMinHeight(-100, 200)).toBe(-500);
  });

  test("a gentle slope packs to uint8 and reads back within the step", async () => {
    const H = (cy: number, cx: number) => 20 + cy * 0.01 + cx * 0.005; // range 1.9 < 2
    const adt = planeADT(H);
    const bytes = convertSynthetic(adt);
    expect(bytes.length).toBe(44 + 8 + 16 + 129 * 129 + 128 * 128);
    const data = await convertAndLoad(adt);
    for (const [cy, cx] of [[0, 0], [10, 77], [64, 64], [127, 3], [100, 120]] as const) {
      const [x, y] = worldAt(cy, cx);
      expect(data.getHeight(x, y)).toBeCloseTo(H(cy + 0.001, cx + 0.001), 1);
    }
  });

  test("a moderate slope packs to uint16 and is accurate to a few millimetres", async () => {
    const H = (cy: number, cx: number) => 30 + cy * 0.5 + cx * 0.25;
    const adt = planeADT(H);
    expect(convertSynthetic(adt).length).toBe(44 + 8 + 16 + 2 * (129 * 129 + 128 * 128));
    const data = await convertAndLoad(adt);
    for (let cy = 3; cy < 128; cy += 17) {
      for (let cx = 5; cx < 128; cx += 23) {
        const [x, y] = worldAt(cy, cx, 0.4, 0.3);
        expect(Math.abs(data.getHeight(x, y) - H(cy + 0.4, cx + 0.3))).toBeLessThan(0.01);
      }
    }
  });

  test("a steep tile (range over 2048) keeps full floats", async () => {
    const H = (cy: number, cx: number) => -100 + cy * 20 + cx * 5;
    const adt = planeADT(H);
    expect(convertSynthetic(adt).length).toBe(44 + 8 + 16 + 4 * (129 * 129 + 128 * 128));
    const data = await convertAndLoad(adt);
    for (const [cy, cx] of [[1, 1], [50, 60], [120, 7]] as const) {
      const [x, y] = worldAt(cy, cx, 0.25, 0.5);
      expect(data.getHeight(x, y)).toBeCloseTo(H(cy + 0.25, cx + 0.5), 2);
    }
  });

  test("the V8 centre of a cell is the inner MCVT value", async () => {
    const adt: TestADT = {
      cell: (i, j) => ({ ypos: 0, mcvt: buildMCVT(() => 0, () => (i === 2 && j === 3 ? 1.5 : 0)) }),
    };
    const data = await convertAndLoad(adt);
    const [x, y] = cellSquare(2, 3, 4, 4);
    expect(data.getHeight(x, y)).toBeCloseTo(1.5, 1);
    const [x2, y2] = cellSquare(3, 2, 4, 4);
    expect(data.getHeight(x2, y2)).toBeCloseTo(0, 3);
  });

  test("heights below -500 are clamped like the extractor does", async () => {
    const adt: TestADT = { cell: (i) => ({ ypos: i < 8 ? -2000 : 30 }) };
    const data = await convertAndLoad(adt);
    const [x, y] = worldAt(10, 10);
    expect(data.getHeight(x, y)).toBe(-500);
    const [x2, y2] = worldAt(100, 10);
    expect(data.getHeight(x2, y2)).toBeCloseTo(30, 0);
  });

  test("flight bounds from MFBO are carried into the file", () => {
    const max = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const min = [-1, -2, -3, -4, -5, -6, -7, -8, -9];
    const without = convertSynthetic({ cell: () => ({ ypos: 5 }) });
    const withBox = convertSynthetic({ cell: () => ({ ypos: 5 }), mfbo: { max, min } });
    expect(withBox.length).toBe(without.length + 36);
    const view = new DataView(withBox.buffer, withBox.byteOffset, withBox.byteLength);
    const heightHeader = 44 + 8;
    expect(view.getUint32(heightHeader + 4, true) & 0x08).toBe(0x08);
    const after = heightHeader + 16;
    expect(view.getInt16(after, true)).toBe(1);
    expect(view.getInt16(after + 16, true)).toBe(9);
    expect(view.getInt16(after + 18, true)).toBe(-1);
    expect(view.getInt16(after + 34, true)).toBe(-9);
  });

  test("flight bounds give getMinHeight a plane", async () => {
    const adt: TestADT = { cell: () => ({ ypos: 5 }), mfbo: { max: Array(9).fill(80), min: Array(9).fill(-50) } };
    const data = await convertAndLoad(adt);
    for (const [cy, cx] of [[3, 4], [64, 64], [120, 9]] as const) {
      const [x, y] = worldAt(cy, cx, 0.3, 0.7);
      expect(data.getMinHeight(x, y)).toBeCloseTo(-50, 1);
    }
  });

  test("hole bits make that quarter of the cell INVALID_HEIGHT", async () => {
    const H = (cy: number, cx: number) => 40 + cy * 0.5;
    // cell (3, 4): bit 0 = sub squares rows 0-1 / columns 0-1; bit 5 (0x20) = rows 2-3 / columns 2-3
    const adt = planeADT(H, { cell: undefined });
    const base = adt.cell!;
    adt.cell = (i, j) => ({ ...base(i, j)!, holes: i === 3 && j === 4 ? 0x0001 | 0x0020 : 0 });
    const data = await convertAndLoad(adt);
    const hole = cellSquare(3, 4, 0, 0);
    expect(data.getHeight(hole[0], hole[1])).toBe(INVALID_HEIGHT);
    const hole2 = cellSquare(3, 4, 3, 2);
    expect(data.getHeight(hole2[0], hole2[1])).toBe(INVALID_HEIGHT);
    const solid = cellSquare(3, 4, 6, 6);
    expect(data.getHeight(solid[0], solid[1])).toBeCloseTo(H(3 * 8 + 6.5, 0), 1);
    const neighbour = cellSquare(3, 5, 0, 0);
    expect(data.getHeight(neighbour[0], neighbour[1])).not.toBe(INVALID_HEIGHT);
  });
});
