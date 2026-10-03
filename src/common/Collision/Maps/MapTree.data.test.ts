/**
 * Real data checks over `data/vmaps/` (written by the AzerothCore tools or by
 * `src/tools/vmap4_extractor` + `src/tools/vmap4_assembler`). Skipped when the files are missing.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LoadResult } from "../Management/IVMapMgr.ts";
import { VMapMgr2 } from "../Management/VMapMgr2.ts";
import { LoadGameObjectModelList, model_list } from "../Models/GameObjectModel.ts";
import { ModelIgnoreFlags } from "../Models/ModelIgnoreFlags.ts";
import { WorldModel } from "../Models/WorldModel.ts";
import { StaticMapTree } from "./MapTree.ts";

const dataDir = join(import.meta.dir, "../../../../data");
const vmapsDir = join(dataDir, "vmaps");
const hasVmaps = existsSync(join(vmapsDir, "000.vmtree"));

/** Stormwind main gate, on the bridge over the moat (world coordinates). */
const STORMWIND_GATE = { x: -8913.23, y: 554.633, z: 93.79 };

function loadAround(tree: StaticMapTree, gx: number, gy: number): void {
  // the grid order of LoadMapTile follows Map / GridTerrainLoader; load both orders, extra loads are harmless
  for (let dx = -1; dx <= 1; ++dx) {
    for (let dy = -1; dy <= 1; ++dy) {
      tree.LoadMapTile(gx + dx, gy + dy);
      tree.LoadMapTile(gy + dy, gx + dx);
    }
  }
}

describe.skipIf(!hasVmaps)("vmaps from data/vmaps", () => {
  test("every map tree initializes", () => {
    const trees = readdirSync(vmapsDir).filter((f) => f.endsWith(".vmtree"));
    expect(trees.length).toBeGreaterThan(0);
    for (const file of trees) {
      const mapId = Number(file.slice(0, 3));
      const tree = new StaticMapTree(mapId, vmapsDir);
      expect(tree.InitMap(file)).toBe(true);
    }
  });

  test("a sample of .vmo models reads", () => {
    const models = readdirSync(vmapsDir).filter((f) => f.endsWith(".vmo"));
    expect(models.length).toBeGreaterThan(0);
    const step = Math.max(1, Math.floor(models.length / 300));
    for (let i = 0; i < models.length; i += step) {
      expect(new WorldModel().readFile(join(vmapsDir, models[i]!))).toBe(true);
    }
  });

  test("Stormwind gate: tiles load, the bridge has a model floor, sight across open air", () => {
    const gx = 63 - Math.trunc((STORMWIND_GATE.x - 533.3333 / 2) / 533.3333 + 32.5);
    const gy = 63 - Math.trunc((STORMWIND_GATE.y - 533.3333 / 2) / 533.3333 + 32.5);
    expect(StaticMapTree.CanLoadMap(vmapsDir, 0, gx, gy) === LoadResult.Success || StaticMapTree.CanLoadMap(vmapsDir, 0, gy, gx) === LoadResult.Success).toBe(true);
    const tree = new StaticMapTree(0, vmapsDir);
    expect(tree.InitMap(VMapMgr2.getMapFileName(0))).toBe(true);
    loadAround(tree, gx, gy);
    const { models } = tree.GetModelInstances();
    expect(models!.some((m) => m?.getWorldModel())).toBe(true);

    const above = VMapMgr2.convertPositionToInternalRep(STORMWIND_GATE.x, STORMWIND_GATE.y, STORMWIND_GATE.z + 5);
    const height = tree.getHeight(above, 30);
    expect(Number.isFinite(height)).toBe(true);
    expect(height).toBeGreaterThan(STORMWIND_GATE.z - 10);
    expect(height).toBeLessThan(STORMWIND_GATE.z + 5);

    // high above the city there is nothing in the way
    const sky1 = VMapMgr2.convertPositionToInternalRep(STORMWIND_GATE.x, STORMWIND_GATE.y, 600);
    const sky2 = VMapMgr2.convertPositionToInternalRep(STORMWIND_GATE.x + 200, STORMWIND_GATE.y + 200, 600);
    expect(tree.isInLineOfSight(sky1, sky2, ModelIgnoreFlags.Nothing)).toBe(true);
  });

  test.skipIf(!existsSync(join(vmapsDir, "GameObjectModels.dtree")))("GameObjectModels.dtree loads", () => {
    LoadGameObjectModelList(`${dataDir}/`);
    expect(model_list.size).toBeGreaterThan(0);
  });
});
