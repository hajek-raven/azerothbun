/**
 * Real client checks (the 3.3.5a client at `~/GAMES/ChromieCraft_3.3.5a`, or `$WOW_CLIENT`): one real WMO and one real
 * M2 are converted and the raw files are read back with the assembler's reader. Skipped when the client is missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VMapMgr2 } from "../../common/Collision/Management/VMapMgr2.ts";
import { StaticMapTree } from "../../common/Collision/Maps/MapTree.ts";
import { WorldModel_Raw } from "../../common/Collision/Maps/TileAssembler.ts";
import { ModelIgnoreFlags } from "../../common/Collision/Models/ModelIgnoreFlags.ts";
import { Vector3 } from "../../math/Vector3.ts";
import { MpqChain } from "../mpq.ts";
import { gOpenArchives } from "./mpq_libmpq04.ts";
import { ExtractSingleModel, ExtractSingleWmo, getModelVertexCount, globals } from "./vmapexport.ts";
import { useWorkDir } from "./vmap4.test-util.ts";

const client = process.env.WOW_CLIENT ?? join(homedir(), "GAMES/ChromieCraft_3.3.5a");
const hasClient = existsSync(join(client, "Data", "common.MPQ"));

describe.skipIf(!hasClient)("vmap4 extractor on the real client", () => {
  let chain: MpqChain;
  let work: ReturnType<typeof useWorkDir>;

  beforeAll(async () => {
    chain = await MpqChain.open(client);
    work = useWorkDir();
    gOpenArchives.chain = chain;
  });

  afterAll(() => {
    work?.cleanup();
    chain?.close();
  });

  function checkRaw(path: string): WorldModel_Raw {
    const raw = new WorldModel_Raw();
    expect(raw.Read(path)).toBe(true);
    for (const group of raw.groupsArray) {
      const vertexCount = group.vertexArray.length / 3;
      expect(group.triangles.length % 3).toBe(0);
      for (const index of group.triangles) {
        expect(index).toBeLessThan(vertexCount);
      }
      for (const value of group.vertexArray) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
    return raw;
  }

  test("a WMO (the Guard Tower) converts to a raw model with collision geometry", () => {
    const quiet = console.log;
    console.log = () => {};
    const ok = ExtractSingleWmo({ value: "World\\Wmo\\Azeroth\\Buildings\\Guardtower\\Guardtower.wmo" });
    console.log = quiet;
    expect(ok).toBe(true);
    const file = `${work.dir}/Guardtower.wmo`;
    expect(existsSync(file)).toBe(true);
    const raw = checkRaw(file);
    expect(raw.groupsArray.length).toBeGreaterThan(0);
    const triangles = raw.groupsArray.reduce((sum, group) => sum + group.triangles.length / 3, 0);
    expect(triangles).toBeGreaterThan(50);
    // the header counts what the groups hold
    expect(getModelVertexCount("Guardtower.wmo")).toBe(triangles);
    const bytes = new Uint8Array(readFileSync(file));
    expect(new DataView(bytes.buffer).getUint32(12, true)).toBe(raw.groupsArray.length);
    // the group bounds enclose their vertices (the bound is the client's, not computed: allow a small margin)
    for (const group of raw.groupsArray) {
      for (let index = 0; index < group.vertexArray.length; index += 3) {
        expect(group.vertexArray[index]!).toBeGreaterThan(group.bounds.low().x - 50);
        expect(group.vertexArray[index]!).toBeLessThan(group.bounds.high().x + 50);
      }
    }
  });

  test("an M2 (a bottle) converts to a one group raw model", () => {
    const name = chain.list(/\\Bottle01\.m2$/i)[0];
    expect(name).toBeDefined();
    const ok = ExtractSingleModel({ value: name! });
    expect(ok).toBe(true);
    const file = `${work.dir}/Bottle01.m2`;
    const raw = checkRaw(file);
    expect(raw.groupsArray).toHaveLength(1);
    expect(raw.groupsArray[0]!.triangles.length).toBeGreaterThan(0);
    expect(getModelVertexCount("Bottle01.m2")).toBe(raw.groupsArray[0]!.vertexArray.length / 3);
  });

  test("the archives serve Map.dbc and the ADTs the walk asks for", () => {
    expect(globals.szWorkDirWmo).toBe(work.dir);
    expect(chain.has("DBFilesClient\\Map.dbc")).toBe(true);
    expect(chain.has("World\\Maps\\Azeroth\\Azeroth_32_48.adt")).toBe(true);
    expect(chain.has("World\\Maps\\Azeroth\\Azeroth_0_0.adt")).toBe(false);
  });
});

const vmapsDir = join(import.meta.dir, "../../../data/vmaps");

/**
 * The whole chain: `data/vmaps` made from this extractor's dump (`bun src/tools/vmap4_extractor/VMapExtractor.ts` then
 * `bun src/tools/vmap4_assembler/VMapAssembler.ts data/Buildings data/vmaps`) answers like the real Stormwind gate.
 */
describe.skipIf(!existsSync(join(vmapsDir, "000.vmtree")))("Stormwind from data/vmaps", () => {
  const gate = { x: -8913.23, y: 554.633, z: 93.79 };

  function loadGate(): StaticMapTree {
    const gx = 63 - Math.trunc((gate.x - 533.3333 / 2) / 533.3333 + 32.5);
    const gy = 63 - Math.trunc((gate.y - 533.3333 / 2) / 533.3333 + 32.5);
    const tree = new StaticMapTree(0, vmapsDir);
    expect(tree.InitMap(VMapMgr2.getMapFileName(0))).toBe(true);
    for (let dx = -1; dx <= 1; ++dx) {
      for (let dy = -1; dy <= 1; ++dy) {
        tree.LoadMapTile(gx + dx, gy + dy);
        tree.LoadMapTile(gy + dy, gx + dx);
      }
    }
    return tree;
  }

  test("a vertical height query at the gate returns the bridge floor", () => {
    const tree = loadGate();
    const above = VMapMgr2.convertPositionToInternalRep(gate.x, gate.y, gate.z + 3);
    expect(tree.getHeight(above, 30)).toBeCloseTo(gate.z, 0);
  });

  test("walls around the gate block sight; the same ray stopped short or started behind is clear", () => {
    const tree = loadGate();
    const origin = VMapMgr2.convertPositionToInternalRep(gate.x, gate.y, gate.z + 1.5);
    let blocked = 0;
    for (const angle of [0, 90, 180, 270]) {
      const radians = (angle * Math.PI) / 180;
      const end = VMapMgr2.convertPositionToInternalRep(gate.x + 60 * Math.cos(radians), gate.y + 60 * Math.sin(radians), gate.z + 1.5);
      if (tree.isInLineOfSight(origin, end, ModelIgnoreFlags.Nothing)) {
        continue;
      }
      ++blocked;
      const hit = new Vector3();
      expect(tree.GetObjectHitPos(origin, end, hit, 0)).toBe(true);
      const distance = Math.hypot(hit.x - origin.x, hit.y - origin.y);
      const along = (t: number) => new Vector3(origin.x + ((end.x - origin.x) / 60) * t, origin.y + ((end.y - origin.y) / 60) * t, origin.z);
      expect(tree.isInLineOfSight(along(0), along(distance - 0.3), ModelIgnoreFlags.Nothing)).toBe(true);
      expect(tree.isInLineOfSight(along(0), along(distance + 0.3), ModelIgnoreFlags.Nothing)).toBe(false);
      expect(tree.isInLineOfSight(along(distance + 0.5), along(distance + 8), ModelIgnoreFlags.Nothing)).toBe(true);
    }
    expect(blocked).toBeGreaterThan(0);
  });
});
