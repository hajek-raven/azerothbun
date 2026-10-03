import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Ray } from "../../../math/Ray.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { ReadFile, WriteFile } from "../BinaryFile.ts";
import type { FloatRef } from "../BoundingIntervalHierarchy.ts";
import type { GroupLocationInfo } from "../Maps/MapTree.ts";
import {
  buildHouseWorldModel,
  HOUSE_GROUP_ID,
  HOUSE_LIQUID_TYPE,
  HOUSE_MOGP,
  HOUSE_ROOT_WMO_ID,
  makeTempDir,
  RAMP_GROUP_ID,
  rng,
} from "../test-fixtures.ts";
import { ModelIgnoreFlags } from "./ModelIgnoreFlags.ts";
import { GroupModel, InsideResult, IntersectTriangle, WmoLiquid, WorldModel } from "./WorldModel.ts";

const tmp = makeTempDir("wm-test-");
afterAll(() => tmp.cleanup());

function down(p: Vector3): Ray {
  return new Ray(p, new Vector3(0, 0, -1));
}

function unitDir(rand: () => number): Vector3 {
  while (true) {
    const v = new Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
    const m = v.magnitude();
    if (m > 0.1 && m <= 1) return v.div(m);
  }
}

describe("WorldModel", () => {
  test("write, read back, write again gives identical bytes", async () => {
    const model = buildHouseWorldModel();
    const path = join(tmp.dir, "wm_house.vmo");
    expect(await model.writeFile(path)).toBe(true);
    const loaded = new WorldModel();
    expect(loaded.readFile(path)).toBe(true);
    const a = new WriteFile();
    model.writeTo(a);
    const b = new WriteFile();
    loaded.writeTo(b);
    expect(b.toBytes()).toEqual(a.toBytes());
    expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(a.toBytes());
    // header layout
    const bytes = a.toBytes();
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("VMAP_4.8");
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WMOD");
    expect(new DataView(bytes.buffer).getUint32(16, true)).toBe(HOUSE_ROOT_WMO_ID);
    expect(new TextDecoder().decode(bytes.subarray(20, 24))).toBe("GMOD");
  });

  test("missing and truncated files fail", () => {
    expect(new WorldModel().readFile(join(tmp.dir, "nope.vmo"))).toBe(false);
    const wf = new WriteFile();
    buildHouseWorldModel().writeTo(wf);
    const bytes = wf.toBytes();
    expect(new WorldModel().readFrom(new ReadFile(bytes.subarray(0, bytes.length - 10)))).toBe(false);
  });

  test("ray hits: wall, floor, ramp", () => {
    const model = buildHouseWorldModel();
    const dist: FloatRef = { value: 100 };
    // from inside the house towards +x: the x=10 wall at distance 5
    expect(model.IntersectRay(new Ray(new Vector3(5, 5, 2), new Vector3(1, 0, 0)), dist, false, ModelIgnoreFlags.Nothing)).toBe(true);
    expect(dist.value).toBeCloseTo(5, 5);
    // straight down from inside: floor at distance 2
    dist.value = 100;
    expect(model.IntersectRay(down(new Vector3(5, 5, 2)), dist, false, ModelIgnoreFlags.Nothing)).toBe(true);
    expect(dist.value).toBeCloseTo(2, 5);
    // down onto the ramp at x = 17 (z 2.5)
    dist.value = 100;
    expect(model.IntersectRay(down(new Vector3(17, 5, 10)), dist, false, ModelIgnoreFlags.Nothing)).toBe(true);
    expect(dist.value).toBeCloseTo(7.5, 5);
    // miss: beside both groups
    dist.value = 100;
    expect(model.IntersectRay(down(new Vector3(30, 5, 10)), dist, false, ModelIgnoreFlags.Nothing)).toBe(false);
    expect(dist.value).toBe(100);
    // out of range: maxDist shorter than the hit
    dist.value = 1;
    expect(model.IntersectRay(down(new Vector3(5, 5, 2)), dist, false, ModelIgnoreFlags.Nothing)).toBe(false);
  });

  test("ModelIgnoreFlags.M2 skips models flagged MOD_M2", () => {
    const model = buildHouseWorldModel();
    model.Flags = 1;
    const dist: FloatRef = { value: 100 };
    expect(model.IntersectRay(down(new Vector3(5, 5, 2)), dist, true, ModelIgnoreFlags.M2)).toBe(false);
    expect(model.IntersectRay(down(new Vector3(5, 5, 2)), dist, true, ModelIgnoreFlags.Nothing)).toBe(true);
  });

  test("location info: inside the house, above the ramp, outside", () => {
    const model = buildHouseWorldModel();
    const info: GroupLocationInfo = { hitModel: null, rootId: -1 };
    const dist: FloatRef = { value: 0 };
    const downDir = new Vector3(0, 0, -1);

    expect(model.GetLocationInfo(new Vector3(5, 5, 2), downDir, dist, info)).toBe(true);
    expect(info.rootId).toBe(HOUSE_ROOT_WMO_ID);
    expect(info.hitModel!.GetWmoID()).toBe(HOUSE_GROUP_ID);
    expect(info.hitModel!.GetMogpFlags()).toBe(HOUSE_MOGP);
    // ground = p + dist * down
    expect(2 - dist.value).toBeCloseTo(0, 4);

    info.hitModel = null;
    expect(model.GetLocationInfo(new Vector3(17, 5, 4), downDir, dist, info)).toBe(true);
    expect(info.hitModel!.GetWmoID()).toBe(RAMP_GROUP_ID);
    expect(4 - dist.value).toBeCloseTo(2.5, 4);

    info.hitModel = null;
    expect(model.GetLocationInfo(new Vector3(30, 5, 2), downDir, dist, info)).toBe(false);
    expect(info.hitModel).toBeNull();
  });

  test("group inside test results", () => {
    const model = buildHouseWorldModel();
    const house = model.GetGroupModels()[0]!;
    const z: FloatRef = { value: 0 };
    expect(house.IsInsideObject(down(new Vector3(5, 5, 2)), z)).toBe(InsideResult.INSIDE);
    expect(z.value).toBeCloseTo(1.9, 5);
    // above the mesh top: bumped down to the top, hits the roof
    expect(house.IsInsideObject(down(new Vector3(5, 5, 8)), z)).toBe(InsideResult.ABOVE);
    expect(house.IsInsideObject(down(new Vector3(50, 5, 2)), z)).toBe(InsideResult.OUT_OF_BOUNDS);
  });

  test("liquid grid level and type", () => {
    const model = buildHouseWorldModel();
    const house = model.GetGroupModels()[0]!;
    const h: FloatRef = { value: 0 };
    expect(house.GetLiquidType()).toBe(HOUSE_LIQUID_TYPE);
    expect(house.GetLiquidLevel(new Vector3(1, 1, 0), h)).toBe(true);
    expect(h.value).toBeCloseTo(1, 5);
    // beyond the 2x2 grid (2 * 533.333 / 128 = 8.33)
    expect(house.GetLiquidLevel(new Vector3(9, 9, 0), h)).toBe(false);
    expect(house.GetLiquidLevel(new Vector3(-1, 1, 0), h)).toBe(false);
    expect(model.GetGroupModels()[1]!.GetLiquidLevel(new Vector3(15, 5, 0), h)).toBe(false);
  });

  test("liquid interpolates heights and honours disabled tiles", () => {
    const liquid = new WmoLiquid(1, 1, new Vector3(0, 0, 0), 2);
    liquid.GetHeightStorage()!.set([0, 4, 0, 4]); // rises along x
    const h: FloatRef = { value: 0 };
    const tile = Math.fround(Math.fround(533.333) / 128);
    expect(liquid.GetLiquidHeight(new Vector3(tile / 2, tile / 4, 0), h)).toBe(true);
    expect(h.value).toBeCloseTo(2, 4);
    liquid.GetFlagsStorage()![0] = 0x0f;
    expect(liquid.GetLiquidHeight(new Vector3(tile / 2, tile / 4, 0), h)).toBe(false);
    // the simple case: no flags, one height
    const flat = new WmoLiquid(0, 0, new Vector3(), 3);
    flat.GetHeightStorage()![0] = 7;
    expect(flat.GetLiquidHeight(new Vector3(999, 999, 0), h)).toBe(true);
    expect(h.value).toBe(7);
    expect(flat.GetFileSize()).toBe(28);
    expect(liquid.GetFileSize()).toBe(24 + 16 + 1);
  });

  test("mesh BIH ray queries agree with brute force over random rays", () => {
    const rand = rng(2024);
    const vertices: number[] = [];
    const indices: number[] = [];
    for (let t = 0; t < 600; ++t) {
      const cx = (rand() - 0.5) * 100, cy = (rand() - 0.5) * 100, cz = (rand() - 0.5) * 40;
      const base = vertices.length / 3;
      for (let k = 0; k < 3; ++k) vertices.push(cx + (rand() - 0.5) * 6, cy + (rand() - 0.5) * 6, cz + (rand() - 0.5) * 6);
      indices.push(base, base + 1, base + 2);
    }
    const vf = Float32Array.from(vertices);
    const tf = Uint32Array.from(indices);
    const group = new GroupModel(0, 0);
    group.setMeshData(vf, tf);
    const ray = new Ray();
    let hits = 0;
    for (let i = 0; i < 3000; ++i) {
      ray.set(new Vector3((rand() - 0.5) * 120, (rand() - 0.5) * 120, (rand() - 0.5) * 60), unitDir(rand));
      const maxDist = 20 + rand() * 150;
      const brute: FloatRef = { value: maxDist };
      let bruteHit = false;
      for (let t = 0; t < tf.length / 3; ++t) if (IntersectTriangle(tf, t, vf, ray, brute)) bruteHit = true;
      const viaTree: FloatRef = { value: maxDist };
      const treeHit = group.IntersectRay(ray, viaTree, false);
      expect(treeHit).toBe(bruteHit);
      if (bruteHit) {
        hits++;
        expect(viaTree.value).toBeCloseTo(brute.value, 4);
      }
      // the stop-at-first-hit query agrees on whether anything is hit
      expect(group.IntersectRay(ray, { value: maxDist }, true)).toBe(bruteHit);
    }
    expect(hits).toBeGreaterThan(100);
  });

  test("group without geometry stops after the vertex chunk", () => {
    const empty = new GroupModel(1, 2);
    const wf = new WriteFile();
    expect(empty.writeToFile(wf)).toBe(true);
    expect(wf.size()).toBe(24 + 8 + 4 + 4 + 4);
    const back = new GroupModel();
    expect(back.readFromFile(new ReadFile(wf.toBytes()))).toBe(true);
    expect(back.GetWmoID()).toBe(2);
    expect(back.IntersectRay(down(new Vector3()), { value: 10 }, false)).toBe(false);
  });
});
