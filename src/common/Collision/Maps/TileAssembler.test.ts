import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Ray } from "../../../math/Ray.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { ReadFile } from "../BinaryFile.ts";
import { BIH } from "../BoundingIntervalHierarchy.ts";
import { ModelFlags, ModelSpawn } from "../Models/ModelInstance.ts";
import { WorldModel } from "../Models/WorldModel.ts";
import {
  crateMesh,
  dirBinBytes,
  HOUSE_ROOT_WMO_ID,
  houseRawGroups,
  makeTempDir,
  rawM2Bytes,
  rawModelBytes,
  tempGameObjectModelsBytes,
} from "../test-fixtures.ts";
import { readChunk, VMAP_MAGIC } from "../VMapDefinitions.ts";
import { ModelPosition, TileAssembler, WorldModel_Raw } from "./TileAssembler.ts";

const tmp = makeTempDir("tileasm-test-");
const raw = join(tmp.dir, "Buildings");
const out = join(tmp.dir, "vmaps");
const out2 = join(tmp.dir, "vmaps2");

const HOUSE = "ta_house.wmo";
const CRATE = "ta_crate.m2";
const GO_ONLY = "ta_door.m2";

async function assemble(dest: string): Promise<boolean> {
  const quiet = spyOn(console, "log").mockImplementation(() => {});
  try {
    return await new TileAssembler(raw, dest).convertWorld2();
  } finally {
    quiet.mockRestore();
  }
}

beforeAll(async () => {
  mkdirSync(raw);
  await Bun.write(join(raw, HOUSE), rawModelBytes(HOUSE_ROOT_WMO_ID, houseRawGroups()));
  await Bun.write(join(raw, CRATE), rawM2Bytes(crateMesh()));
  await Bun.write(join(raw, GO_ONLY), rawM2Bytes({ vertices: [-1, -2, 0, 3, 4, 5, 0, 0, 1], indices: [0, 1, 2] }));
  await Bun.write(
    join(raw, "dir_bin"),
    dirBinBytes([
      { mapID: 530, tileX: 20, tileY: 40, flags: ModelFlags.MOD_HAS_BOUND, adtId: 1, uniqueId: 77, pos: [100, 200, 10], rot: [0, 0, 0], scale: 1, bound: [[100, 200, 10], [122, 210, 15]], name: HOUSE },
      { mapID: 530, tileX: 20, tileY: 40, flags: ModelFlags.MOD_M2, adtId: 0, uniqueId: 5, pos: [50, 60, 0], rot: [0, 90, 0], scale: 3, name: CRATE },
      // the same unique id seen again from a neighbour ADT: one unique entry, two tile entries
      { mapID: 530, tileX: 21, tileY: 40, flags: ModelFlags.MOD_HAS_BOUND, adtId: 1, uniqueId: 77, pos: [100, 200, 10], rot: [0, 0, 0], scale: 1, bound: [[100, 200, 10], [122, 210, 15]], name: HOUSE },
      { mapID: 13, tileX: 65, tileY: 65, flags: ModelFlags.MOD_HAS_BOUND | ModelFlags.MOD_WORLDSPAWN, adtId: 0, uniqueId: 9, pos: [17066.666, 17066.666, 0], rot: [0, 0, 0], scale: 1, bound: [[0, 0, 0], [22, 10, 5]], name: HOUSE },
    ]),
  );
  await Bun.write(
    join(raw, "temp_gameobject_models"),
    tempGameObjectModelsBytes([
      { displayId: 31, isWmo: false, name: GO_ONLY },
      { displayId: 32, isWmo: true, name: HOUSE },
      { displayId: 33, isWmo: false, name: "ta_missing.m2" },
    ]),
  );
  expect(await assemble(out)).toBe(true);
});

afterAll(() => tmp.cleanup());

describe("TileAssembler", () => {
  test("writes the tree, tile, model and game object files", () => {
    const files = readdirSync(out).sort();
    expect(files).toEqual(["013.vmtree", "530.vmtree", "530_20_40.vmtile", "530_21_40.vmtile", "GameObjectModels.dtree", `${CRATE}.vmo`, `${GO_ONLY}.vmo`, `${HOUSE}.vmo`].sort());
  });

  test("the .vmtree: magic, tiled flag, NODE + BIH, GOBJ", () => {
    const rf = ReadFile.open(join(out, "530.vmtree"))!;
    expect(readChunk(rf, VMAP_MAGIC, 8)).toBe(true);
    expect(rf.u8()).toBe(1); // tiled
    expect(readChunk(rf, "NODE", 4)).toBe(true);
    const tree = new BIH();
    expect(tree.readFromFile(rf)).toBe(true);
    expect(tree.primCount()).toBe(2); // unique spawns 5 and 77
    expect(readChunk(rf, "GOBJ", 4)).toBe(true);
    expect(rf.remaining()).toBe(0);

    const wdt = ReadFile.open(join(out, "013.vmtree"))!;
    expect(readChunk(wdt, VMAP_MAGIC, 8)).toBe(true);
    expect(wdt.u8()).toBe(0); // not tiled: has a global spawn
    expect(readChunk(wdt, "NODE", 4)).toBe(true);
    expect(new BIH().readFromFile(wdt)).toBe(true);
    expect(readChunk(wdt, "GOBJ", 4)).toBe(true);
    const spawn = new ModelSpawn();
    expect(ModelSpawn.readFromFile(wdt, spawn)).toBe(true);
    expect(spawn.ID).toBe(9);
    // the worldspawn bound moved by 533.33333 * 32
    expect(spawn.iBound.low().x).toBeCloseTo(17066.666, 2);
    expect(spawn.iBound.high().y).toBeCloseTo(17076.666, 2);
  });

  test("the .vmtile: spawns with their tree node index, M2 bound computed", () => {
    const rf = ReadFile.open(join(out, "530_20_40.vmtile"))!;
    expect(readChunk(rf, VMAP_MAGIC, 8)).toBe(true);
    expect(rf.u32()).toBe(2);
    const spawns: { spawn: ModelSpawn; node: number }[] = [];
    for (let i = 0; i < 2; ++i) {
      const spawn = new ModelSpawn();
      expect(ModelSpawn.readFromFile(rf, spawn)).toBe(true);
      spawns.push({ spawn, node: rf.u32()! });
    }
    expect(rf.remaining()).toBe(0);
    // multimap order within a tile: insertion order
    expect(spawns.map((s) => s.spawn.ID)).toEqual([77, 5]);
    // node index = position in the map spawn list sorted by unique id
    expect(spawns.map((s) => s.node)).toEqual([1, 0]);
    const crate = spawns[1]!.spawn;
    expect(crate.flags).toBe(ModelFlags.MOD_M2 | ModelFlags.MOD_HAS_BOUND);
    expect(crate.iScale).toBe(3);
    // unit cube * 3, yawed 90 degrees: x' = -y in [-3, 0], y' = x in [0, 3]
    expect(crate.iBound.low().x).toBeCloseTo(47, 4);
    expect(crate.iBound.high().x).toBeCloseTo(50, 4);
    expect(crate.iBound.low().y).toBeCloseTo(60, 4);
    expect(crate.iBound.high().y).toBeCloseTo(63, 4);
    expect(crate.iBound.high().z).toBeCloseTo(3, 4);

    const second = ReadFile.open(join(out, "530_21_40.vmtile"))!;
    expect(readChunk(second, VMAP_MAGIC, 8)).toBe(true);
    expect(second.u32()).toBe(1);
  });

  test("the .vmo models read back with groups, liquid and root id", () => {
    const model = new WorldModel();
    expect(model.readFile(join(out, `${HOUSE}.vmo`))).toBe(true);
    const groups = model.GetGroupModels();
    expect(groups.length).toBe(2);
    expect(groups[0]!.GetLiquidType()).toBe(13);
    expect(groups[1]!.GetLiquidType()).toBe(0);
    const dist = { value: 50 };
    expect(model.IntersectRay(new Ray(new Vector3(5, 5, 2), new Vector3(0, 0, -1)), dist, false, 0)).toBe(true);
    expect(dist.value).toBeCloseTo(2, 5);
  });

  test("GameObjectModels.dtree lists the converted game object models with their bounds", () => {
    const rf = ReadFile.open(join(out, "GameObjectModels.dtree"))!;
    expect(readChunk(rf, VMAP_MAGIC, 8)).toBe(true);
    const entries: { id: number; wmo: number; name: string; lo: Float32Array; hi: Float32Array }[] = [];
    while (rf.remaining() > 0) {
      const id = rf.u32()!;
      const wmo = rf.u8()!;
      const len = rf.u32()!;
      const name = new TextDecoder().decode(rf.bytes(len)!);
      entries.push({ id, wmo, name, lo: rf.f32Array(3)!, hi: rf.f32Array(3)! });
    }
    // the model without a raw file is skipped
    expect(entries.map((e) => [e.id, e.wmo, e.name])).toEqual([
      [31, 0, GO_ONLY],
      [32, 1, HOUSE],
    ]);
    expect([...entries[0]!.lo]).toEqual([-1, -2, 0]);
    expect([...entries[0]!.hi]).toEqual([3, 4, 5]);
    expect([...entries[1]!.hi]).toEqual([22, 10, 5]);
  });

  test("the output is deterministic", async () => {
    expect(await assemble(out2)).toBe(true);
    for (const name of readdirSync(out)) {
      const a = new Uint8Array(await Bun.file(join(out, name)).arrayBuffer());
      const b = new Uint8Array(await Bun.file(join(out2, name)).arrayBuffer());
      expect(b).toEqual(a);
    }
  });

  test("raw readers reject bad input", async () => {
    const quiet = spyOn(console, "log").mockImplementation(() => {});
    try {
      await Bun.write(join(tmp.dir, "bad.raw"), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
      expect(new WorldModel_Raw().Read(join(tmp.dir, "bad.raw"))).toBe(false);
      expect(new WorldModel_Raw().Read(join(tmp.dir, "missing.raw"))).toBe(false);
      const full = rawM2Bytes(crateMesh());
      await Bun.write(join(tmp.dir, "short.raw"), full.subarray(0, full.length - 4));
      expect(new WorldModel_Raw().Read(join(tmp.dir, "short.raw"))).toBe(false);
      // no dir_bin
      const emptySrc = join(tmp.dir, "empty");
      mkdirSync(emptySrc);
      expect(await new TileAssembler(emptySrc, join(tmp.dir, "vmaps3")).convertWorld2()).toBe(false);
      expect(existsSync(join(tmp.dir, "vmaps3"))).toBe(true);
    } finally {
      quiet.mockRestore();
    }
  });

  test("ModelPosition transforms scale then rotation", () => {
    const mp = new ModelPosition();
    mp.iDir = new Vector3(0, 90, 0);
    mp.iScale = 2;
    mp.init();
    const v = mp.transform(new Vector3(1, 0, 0));
    expect(v.x).toBeCloseTo(0, 5);
    expect(v.y).toBeCloseTo(2, 5);
    expect(v.z).toBeCloseTo(0, 5);
  });
});
