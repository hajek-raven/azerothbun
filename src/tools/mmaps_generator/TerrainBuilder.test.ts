import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NAV_WATER } from "../../common/Collision/Management/MMapDefines.ts";
import { Matrix3 } from "../../math/Matrix3.ts";
import { buildMapFile, type TestMap } from "../../game/Grids/GridTerrainData.test-util.ts";
import {
  G3DArray,
  GRID_PART_SIZE,
  GRID_SIZE,
  MAP_FILE_NAME_FORMAT,
  MeshData,
  TerrainBuilder,
  V8_SIZE_SQ,
  V9_SIZE_SQ,
  fromEulerAnglesXYZ,
} from "./TerrainBuilder.ts";

const f32 = Math.fround;

const dir = mkdtempSync(join(tmpdir(), "mmaps-terrain-"));
mkdirSync(join(dir, "maps"));
mkdirSync(join(dir, "vmaps"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function flat(height: number, encoding: "float" | "uint8" | "uint16" = "float"): TestMap["height"] {
  return { V9: new Float32Array(V9_SIZE_SQ).fill(height), V8: new Float32Array(V8_SIZE_SQ).fill(height), encoding };
}

async function writeTile(mapID: number, tileX: number, tileY: number, map: TestMap): Promise<void> {
  await Bun.write(MAP_FILE_NAME_FORMAT(join(dir, "maps"), mapID, tileY, tileX), buildMapFile(map));
}

describe("TerrainBuilder.loadMap", () => {
  test("a flat tile: V9 then V8 vertices (mirrored, y and z swapped) and four triangles per square", async () => {
    await writeTile(5, 31, 33, { height: flat(10) });
    const tb = new TerrainBuilder(dir, false);
    const md = new MeshData();
    tb.loadMap(5, 31, 33, md);

    expect(md.solidVerts.size()).toBe((V9_SIZE_SQ + V8_SIZE_SQ) * 3);
    expect(md.solidTris.size()).toBe(128 * 128 * 4 * 3);
    expect(md.liquidVerts.size()).toBe(0);

    const v = md.solidVerts.getCArray();
    const xoffset = f32(f32(31 - 32) * GRID_SIZE);
    const yoffset = f32(f32(33 - 32) * GRID_SIZE);
    // V9 vertex 0: (-(xoffset), height, -(yoffset))
    expect([v[0], v[1], v[2]]).toEqual([-xoffset, 10, -yoffset]);
    // V9 vertex 1 is one grid part further along x (the column index feeds coord[0])
    expect(v[3]).toBe(-f32(xoffset + f32(1 * GRID_PART_SIZE)));
    expect(v[5]).toBe(-yoffset);
    // vertex 129 starts the second row: one part along y
    expect(v[129 * 3 + 2]).toBe(-f32(yoffset + f32(1 * GRID_PART_SIZE)));
    // first V8 vertex sits half a part inside
    const o8 = V9_SIZE_SQ * 3;
    expect(v[o8]).toBe(-f32(xoffset + f32(GRID_PART_SIZE / 2)));
    expect(v[o8 + 1]).toBe(10);
    expect(v[o8 + 2]).toBe(-f32(yoffset + f32(GRID_PART_SIZE / 2)));

    // square 0: TOP, RIGHT, LEFT, BOTTOM (Spot 1..4) with the indices reversed
    const t = md.solidTris.getCArray();
    const c = V9_SIZE_SQ;
    expect(Array.from(t.subarray(0, 12))).toEqual([
      c, 1, 0, // TOP: {0, 1, V9_SIZE_SQ}
      c, 130, 1, // RIGHT: {1, 130, V9_SIZE_SQ}
      129, c, 0, // LEFT: {0, V9_SIZE_SQ, 129}
      129, 130, c, // BOTTOM: {V9_SIZE_SQ, 130, 129}
    ]);
    // all indices are valid vertices
    for (let i = 0; i < md.solidTris.size(); ++i) expect(t[i]!).toBeLessThan(V9_SIZE_SQ + V8_SIZE_SQ);
  });

  test("uint8 and uint16 heights are scaled like the extractor stored them", async () => {
    const V9 = new Float32Array(V9_SIZE_SQ).fill(0);
    const V8 = new Float32Array(V8_SIZE_SQ).fill(0);
    V9[5] = 100; // maximum, everything else is the minimum 0
    for (const [encoding, tileX] of [["uint8", 20], ["uint16", 21]] as const) {
      await writeTile(6, tileX, 20, { height: { V9, V8, encoding } });
      const md = new MeshData();
      new TerrainBuilder(dir, false).loadMap(6, tileX, 20, md);
      const v = md.solidVerts.getCArray();
      expect(v[1]).toBe(0); // vertex 0 is the minimum
      expect(v[5 * 3 + 1]).toBe(100); // vertex 5 is the maximum
    }
  });

  test("holes remove the squares of their 2x2 block", async () => {
    const holes = new Uint16Array(256);
    holes[0] = 0x0001; // cell (0,0), hole (0,0): squares rows 0..1, cols 0..1
    await writeTile(7, 22, 22, { height: flat(5), holes });
    const md = new MeshData();
    new TerrainBuilder(dir, false).loadMap(7, 22, 22, md);
    expect(md.solidTris.size()).toBe((128 * 128 - 4) * 12);
  });

  test("liquid above the terrain is kept and the terrain below it is dropped", async () => {
    await writeTile(8, 23, 23, { height: flat(10), liquid: { liquidType: 1, liquidFlags: 1, liquidLevel: 20 } });
    const md = new MeshData();
    new TerrainBuilder(dir, false).loadMap(8, 23, 23, md);
    expect(md.liquidVerts.size()).toBe(V9_SIZE_SQ * 3);
    expect(md.liquidTris.size()).toBe(128 * 128 * 2 * 3);
    expect(md.liquidType.size()).toBe(128 * 128 * 2);
    expect(new Set(md.liquidType.getCArray().subarray(0, md.liquidType.size()))).toEqual(new Set([NAV_WATER]));
    expect(md.solidTris.size()).toBe(0);
    expect(md.liquidVerts.getCArray()[1]).toBe(20);

    // liquid below the terrain is dropped, the terrain stays
    await writeTile(12, 24, 23, { height: flat(30), liquid: { liquidType: 1, liquidFlags: 1, liquidLevel: 20 } });
    const md2 = new MeshData();
    new TerrainBuilder(dir, false).loadMap(12, 24, 23, md2);
    expect(md2.liquidTris.size()).toBe(0);
    expect(md2.solidTris.size()).toBe(128 * 128 * 12);

    // skipLiquid ignores the liquid section
    const md3 = new MeshData();
    new TerrainBuilder(dir, true).loadMap(8, 23, 23, md3);
    expect(md3.liquidVerts.size()).toBe(0);
    expect(md3.solidTris.size()).toBe(128 * 128 * 12);
  });

  test("dark water removes the terrain and the liquid", async () => {
    await writeTile(9, 25, 25, { height: flat(10), liquid: { liquidType: 0x10, liquidFlags: 0x10, liquidLevel: 20 } });
    const md = new MeshData();
    new TerrainBuilder(dir, false).loadMap(9, 25, 25, md);
    expect(md.solidTris.size()).toBe(0);
    expect(md.liquidTris.size()).toBe(0);
  });

  test("a neighbour tile contributes only its facing border squares", async () => {
    await writeTile(10, 30, 30, { height: flat(1) });
    await writeTile(10, 31, 30, { height: flat(2) }); // tileX + 1 -> LEFT column of the neighbour
    const md = new MeshData();
    new TerrainBuilder(dir, false).loadMap(10, 30, 30, md);
    // the main tile: 16384 squares * 12; the neighbour: its 128 left column squares * 2 triangles * 3 ... per getLoopVars LEFT
    expect(md.solidTris.size()).toBe(128 * 128 * 12 + 128 * 12);
    expect(md.solidVerts.size()).toBe(2 * (V9_SIZE_SQ + V8_SIZE_SQ) * 3);
  });

  test("a missing, wrong version or empty file loads nothing", async () => {
    const md = new MeshData();
    new TerrainBuilder(dir, false).loadMap(11, 1, 1, md);
    expect(md.solidVerts.size()).toBe(0);

    const bytes = buildMapFile({ height: flat(1) });
    new DataView(bytes.buffer).setUint32(4, 8, true); // versionMagic
    await Bun.write(MAP_FILE_NAME_FORMAT(join(dir, "maps"), 11, 2, 2), bytes);
    new TerrainBuilder(dir, false).loadMap(11, 2, 2, md);
    expect(md.solidVerts.size()).toBe(0);

    await writeTile(11, 3, 3, { height: { V9: new Float32Array(V9_SIZE_SQ), V8: new Float32Array(V8_SIZE_SQ), encoding: "flat" } });
    new TerrainBuilder(dir, false).loadMap(11, 3, 3, md);
    expect(md.solidVerts.size()).toBe(0);
  });
});

describe("TerrainBuilder helpers", () => {
  test("cleanVertices drops unused vertices and renumbers in order of first use", () => {
    const verts = new G3DArray(Float32Array);
    for (let i = 0; i < 6; ++i) verts.append(i, i + 0.5, -i);
    const tris = new G3DArray(Int32Array);
    tris.append(4, 2, 5, 2, 4, 4);
    TerrainBuilder.cleanVertices(verts, tris);
    expect(verts.size()).toBe(9);
    expect(Array.from(verts.getCArray().subarray(0, 9))).toEqual([4, 4.5, -4, 2, 2.5, -2, 5, 5.5, -5]);
    expect(Array.from(tris.getCArray().subarray(0, 6))).toEqual([0, 1, 2, 1, 0, 0]);
  });

  test("copyVertices swaps to (y, z, x); copyIndices offsets and flips", () => {
    const dest = new G3DArray(Float32Array);
    TerrainBuilder.copyVertices(new Float32Array([1, 2, 3, 4, 5, 6]), dest);
    expect(Array.from(dest.getCArray().subarray(0, 6))).toEqual([2, 3, 1, 5, 6, 4]);

    const tris = new G3DArray(Int32Array);
    TerrainBuilder.copyIndices(new Uint32Array([0, 1, 2]), tris, 10, false);
    TerrainBuilder.copyIndices(new Uint32Array([0, 1, 2]), tris, 10, true);
    expect(Array.from(tris.getCArray().subarray(0, 6))).toEqual([10, 11, 12, 12, 11, 10]);

    const more = new G3DArray(Int32Array);
    TerrainBuilder.copyIndicesArray(tris, more, 100);
    expect(more.size()).toBe(6);
    expect(more.getCArray()[0]).toBe(110);
  });

  test("transform applies rotation, scale and position and mirrors x and y", () => {
    const identity = Matrix3.identity();
    const out = TerrainBuilder.transform(new Float32Array([1, 2, 3]), 2, identity, new Float32Array([10, 20, 30]));
    expect(Array.from(out)).toEqual([-(1 * 2 + 10), -(2 * 2 + 20), 3 * 2 + 30]);

    // a quarter turn about z: (x, y) -> row vector times matrix
    const rot = fromEulerAnglesXYZ(0, 0, Math.PI / 2);
    const r = TerrainBuilder.transform(new Float32Array([1, 0, 0]), 1, rot, new Float32Array(3));
    expect(r[0]).toBeCloseTo(-0, 5);
    expect(Math.abs(r[1]!)).toBeCloseTo(1, 5);
  });

  test("fromEulerAnglesXYZ is Rx * (Ry * Rz)", () => {
    const m = fromEulerAnglesXYZ(0.3, -0.7, 1.1);
    const c = (a: number): number => f32(Math.cos(f32(a)));
    const s = (a: number): number => f32(Math.sin(f32(a)));
    const rx = new Matrix3(1, 0, 0, 0, c(0.3), -s(0.3), 0, s(0.3), c(0.3));
    const ry = new Matrix3(c(-0.7), 0, s(-0.7), 0, 1, 0, -s(-0.7), 0, c(-0.7));
    const rz = new Matrix3(c(1.1), -s(1.1), 0, s(1.1), c(1.1), 0, 0, 0, 1);
    expect(Array.from(m.elt)).toEqual(Array.from(rx.mul(ry.mul(rz)).elt));
    // identity for zero angles
    expect(Array.from(fromEulerAnglesXYZ(0, 0, 0).elt)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  test("loadOffMeshConnections reads the matching lines (y, z, x order) and skips bad ones", () => {
    const tb = new TerrainBuilder(dir, false);
    const md = new MeshData();
    const lines = [
      "562 31,20 (6234.474121 256.563721 11.063726) (6230.162598 251.681976 11.199670) 2.1",
      "562 30,20 (1 2 3) (4 5 6) 1.5", // other tile
      "563 31,20 (1 2 3) (4 5 6) 1.5", // other map
      "garbage",
    ];
    tb.loadOffMeshConnections(562, 31, 20, md, lines);
    expect(md.offMeshConnections.size()).toBe(6);
    expect(Array.from(md.offMeshConnections.getCArray().subarray(0, 6))).toEqual([
      f32(256.563721), f32(11.063726), f32(6234.474121),
      f32(251.681976), f32(11.19967), f32(6230.162598),
    ]);
    expect(md.offMeshConnectionRads.getCArray()[0]).toBe(f32(2.1));
    expect(md.offMeshConnectionDirs.getCArray()[0]).toBe(1);
    expect(md.offMeshConnectionsAreas.getCArray()[0]).toBe(0xff);
    expect(md.offMeshConnectionsFlags.getCArray()[0]).toBe(0xff);

    const none = new MeshData();
    tb.loadOffMeshConnections(562, 31, 20, none, []);
    expect(none.offMeshConnections.size()).toBe(0);
  });

  test("loadVMap without a vmtree returns false", () => {
    expect(new TerrainBuilder(dir, false).loadVMap(5, 1, 1, new MeshData())).toBe(false);
  });
});
