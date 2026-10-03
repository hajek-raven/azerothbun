/**
 * End-to-end Recast pipeline on a hand-built scene: ground plane, a box obstacle and a bridge above the ground.
 * Checks counts and structural invariants of every stage (heightfield, compact heightfield, regions, contours,
 * poly mesh, detail mesh, layers) and that the build is deterministic.
 */
import { describe, expect, test } from "bun:test";
import {
  RC_NULL_AREA,
  RC_WALKABLE_AREA,
  RC_MESH_NULL_IDX,
  rcAllocCompactHeightfield,
  rcAllocContourSet,
  rcAllocHeightfield,
  rcAllocHeightfieldLayerSet,
  rcAllocPolyMesh,
  rcAllocPolyMeshDetail,
  rcBuildCompactHeightfield,
  rcCalcGridSize,
  rcContext,
  rcCreateHeightfield,
  rcMarkWalkableTriangles,
  type rcCompactHeightfield,
  type rcPolyMesh,
  type rcPolyMeshDetail,
} from "./Recast.ts";
import { rcErodeWalkableArea } from "./RecastArea.ts";
import { rcBuildContours } from "./RecastContour.ts";
import { rcFilterLedgeSpans, rcFilterLowHangingWalkableObstacles, rcFilterWalkableLowHeightSpans } from "./RecastFilter.ts";
import { rcBuildHeightfieldLayers } from "./RecastLayers.ts";
import { rcBuildPolyMesh, rcMergePolyMeshes } from "./RecastMesh.ts";
import { rcBuildPolyMeshDetail, rcMergePolyMeshDetails } from "./RecastMeshDetail.ts";
import { rcRasterizeTriangles } from "./RecastRasterization.ts";
import { rcBuildDistanceField, rcBuildRegions } from "./RecastRegion.ts";

/** Context that keeps the log messages. */
class LogContext extends rcContext {
  readonly messages: string[] = [];
  protected override doLog(_category: number, msg: string): void {
    this.messages.push(msg);
  }
}

/** Appends an axis aligned box as 12 triangles. */
function addBox(verts: number[], tris: number[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  const base = verts.length / 3;
  verts.push(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1);
  const quads = [
    [0, 1, 2, 3], // bottom
    [4, 7, 6, 5], // top (faces up)
    [0, 4, 5, 1],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 4, 0],
  ];
  for (const q of quads) {
    tris.push(base + q[0]!, base + q[1]!, base + q[2]!);
    tris.push(base + q[0]!, base + q[2]!, base + q[3]!);
  }
}

interface Scene {
  verts: Float32Array;
  tris: Int32Array;
}

function buildScene(withBridge: boolean, withBox = true): Scene {
  const verts: number[] = [];
  const tris: number[] = [];
  // Ground, two triangles facing up.
  verts.push(0, 0, 0, 0, 0, 20, 20, 0, 20, 20, 0, 0);
  tris.push(0, 1, 2, 0, 2, 3);
  // Obstacle box in the middle.
  if (withBox) addBox(verts, tris, 8, -0.5, 8, 12, 3, 12);
  if (withBridge) {
    // Bridge deck 3 units above the ground in the corner.
    addBox(verts, tris, 1, 3, 1, 6, 3.4, 6);
  }
  return { verts: new Float32Array(verts), tris: new Int32Array(tris) };
}

const CS = 0.25;
const CH = 0.2;
const WALKABLE_HEIGHT = 10; // 2 units
const WALKABLE_CLIMB = 4;
const WALKABLE_RADIUS = 2;

interface Built {
  chf: rcCompactHeightfield;
  mesh: rcPolyMesh;
  dmesh: rcPolyMeshDetail;
  spanCount: number;
}

function build(scene: Scene): Built {
  const ctx = new rcContext(false);
  const bmin = new Float32Array([-1, -1, -1]);
  const bmax = new Float32Array([21, 8, 21]);
  const w = { value: 0 };
  const h = { value: 0 };
  rcCalcGridSize(bmin, bmax, CS, w, h);
  const hf = rcAllocHeightfield();
  expect(rcCreateHeightfield(ctx, hf, w.value, h.value, bmin, bmax, CS, CH)).toBe(true);

  const nt = scene.tris.length / 3;
  const areas = new Uint8Array(nt);
  rcMarkWalkableTriangles(ctx, 45, scene.verts, scene.verts.length / 3, scene.tris, nt, areas);
  expect(rcRasterizeTriangles(ctx, scene.verts, scene.verts.length / 3, scene.tris, areas, nt, hf)).toBe(true);

  rcFilterLowHangingWalkableObstacles(ctx, WALKABLE_CLIMB, hf);
  rcFilterLedgeSpans(ctx, WALKABLE_HEIGHT, WALKABLE_CLIMB, hf);
  rcFilterWalkableLowHeightSpans(ctx, WALKABLE_HEIGHT, hf);

  const chf = rcAllocCompactHeightfield();
  expect(rcBuildCompactHeightfield(ctx, WALKABLE_HEIGHT, WALKABLE_CLIMB, hf, chf)).toBe(true);
  expect(rcErodeWalkableArea(ctx, WALKABLE_RADIUS, chf)).toBe(true);
  expect(rcBuildDistanceField(ctx, chf)).toBe(true);
  expect(rcBuildRegions(ctx, chf, 0, 8, 20)).toBe(true);

  const cset = rcAllocContourSet();
  expect(rcBuildContours(ctx, chf, 1.3, 12, cset)).toBe(true);
  const mesh = rcAllocPolyMesh();
  expect(rcBuildPolyMesh(ctx, cset, 6, mesh)).toBe(true);
  const dmesh = rcAllocPolyMeshDetail();
  expect(rcBuildPolyMeshDetail(ctx, mesh, chf, 6 * CS, 1, dmesh)).toBe(true);
  return { chf, mesh, dmesh, spanCount: chf.spanCount };
}

function polyVertCount(mesh: rcPolyMesh, i: number): number {
  let n = 0;
  for (let j = 0; j < mesh.nvp; ++j) {
    if (mesh.polys![i * mesh.nvp * 2 + j] === RC_MESH_NULL_IDX) break;
    n++;
  }
  return n;
}

describe("Recast pipeline", () => {
  const scene = buildScene(false);
  const built = build(scene);

  test("compact heightfield has walkable spans with regions", () => {
    const { chf } = built;
    expect(chf.spanCount).toBeGreaterThan(1000);
    let walkable = 0;
    for (let i = 0; i < chf.spanCount; ++i) if (chf.areas[i] !== RC_NULL_AREA) walkable++;
    expect(walkable).toBeGreaterThan(1000);
    expect(chf.maxRegions).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < chf.spanCount; ++i) {
      if (chf.areas[i] !== RC_NULL_AREA) expect(chf.spans.reg[i]).toBeGreaterThan(0);
    }
  });

  test("poly mesh is well formed", () => {
    const { mesh } = built;
    expect(mesh.npolys).toBeGreaterThan(0);
    expect(mesh.nverts).toBeGreaterThan(3);
    expect(mesh.nvp).toBe(6);
    for (let i = 0; i < mesh.npolys; ++i) {
      const nv = polyVertCount(mesh, i);
      expect(nv).toBeGreaterThanOrEqual(3);
      expect(mesh.areas![i]).toBe(RC_WALKABLE_AREA);
      for (let j = 0; j < nv; ++j) {
        expect(mesh.polys![i * 12 + j]!).toBeLessThan(mesh.nverts);
        // Adjacency is symmetric when it is an internal link.
        const nei = mesh.polys![i * 12 + 6 + j]!;
        if (nei !== RC_MESH_NULL_IDX && !(nei & 0x8000)) {
          expect(nei).toBeLessThan(mesh.npolys);
          const back = Array.from({ length: 6 }, (_, k) => mesh.polys![nei * 12 + 6 + k]);
          expect(back).toContain(i);
        }
      }
    }
  });

  test("detail mesh matches poly mesh", () => {
    const { mesh, dmesh } = built;
    expect(dmesh.nmeshes).toBe(mesh.npolys);
    let tris = 0;
    let verts = 0;
    for (let i = 0; i < dmesh.nmeshes; ++i) {
      const vbase = dmesh.meshes![i * 4]!;
      const nv = dmesh.meshes![i * 4 + 1]!;
      const tbase = dmesh.meshes![i * 4 + 2]!;
      const nt = dmesh.meshes![i * 4 + 3]!;
      expect(vbase).toBe(verts);
      expect(tbase).toBe(tris);
      expect(nv).toBeGreaterThanOrEqual(polyVertCount(mesh, i));
      expect(nt).toBeGreaterThan(0);
      for (let t = 0; t < nt; ++t) {
        for (let k = 0; k < 3; ++k) expect(dmesh.tris![(tbase + t) * 4 + k]!).toBeLessThan(nv);
        expect(dmesh.tris![(tbase + t) * 4 + 3]!).toBeLessThan(64);
      }
      tris += nt;
      verts += nv;
    }
    expect(dmesh.ntris).toBe(tris);
    expect(dmesh.nverts).toBe(verts);
    // The ground is flat at y = 0 (the ch offset of one cell height is added by the builder).
    for (let v = 0; v < dmesh.nverts; ++v) {
      const y = dmesh.verts![v * 3 + 1]!;
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThan(-1.5);
      expect(y).toBeLessThan(4.5);
    }
  });

  test("build is deterministic", () => {
    const again = build(scene);
    expect(again.mesh.nverts).toBe(built.mesh.nverts);
    expect(again.mesh.npolys).toBe(built.mesh.npolys);
    expect(Array.from(again.mesh.polys!)).toEqual(Array.from(built.mesh.polys!));
    expect(again.dmesh.ntris).toBe(built.dmesh.ntris);
    expect(Array.from(again.dmesh.verts!.subarray(0, again.dmesh.nverts * 3))).toEqual(
      Array.from(built.dmesh.verts!.subarray(0, built.dmesh.nverts * 3)),
    );
    expect(Array.from(again.dmesh.tris!.subarray(0, again.dmesh.ntris * 4))).toEqual(
      Array.from(built.dmesh.tris!.subarray(0, built.dmesh.ntris * 4)),
    );
  });

  test("rcMergePolyMeshDetails concatenates and offsets sub meshes", () => {
    const ctx = new rcContext(false);
    const merged = rcAllocPolyMeshDetail();
    expect(rcMergePolyMeshDetails(ctx, [built.dmesh, null, built.dmesh], 3, merged)).toBe(true);
    const d = built.dmesh;
    expect(merged.nmeshes).toBe(d.nmeshes * 2);
    expect(merged.nverts).toBe(d.nverts * 2);
    expect(merged.ntris).toBe(d.ntris * 2);
    expect(merged.meshes![d.nmeshes * 4]).toBe(d.nverts);
    expect(merged.meshes![d.nmeshes * 4 + 2]).toBe(d.ntris);
    expect(Array.from(merged.verts!.subarray(d.nverts * 3))).toEqual(Array.from(d.verts!.subarray(0, d.nverts * 3)));
  });

  test("rcMergePolyMeshes of the same mesh doubles the polygons", () => {
    const ctx = new rcContext(false);
    const merged = rcAllocPolyMesh();
    expect(rcMergePolyMeshes(ctx, [built.mesh, built.mesh], 2, merged)).toBe(true);
    expect(merged.npolys).toBe(built.mesh.npolys * 2);
    // Identical vertices are shared.
    expect(merged.nverts).toBe(built.mesh.nverts);
  });

  test("ground and box top form separate height levels, no walkable cells on the box walls", () => {
    const { dmesh } = built;
    let ground = 0;
    let top = 0;
    for (let v = 0; v < dmesh.nverts; ++v) {
      const x = dmesh.verts![v * 3]!;
      const y = dmesh.verts![v * 3 + 1]!;
      const z = dmesh.verts![v * 3 + 2]!;
      if (y < 1) ground++;
      else if (y > 2.5) top++;
      else throw new Error(`detail vertex on a wall at ${x},${y},${z}`);
    }
    expect(ground).toBeGreaterThan(0);
    expect(top).toBeGreaterThan(0);
  });
});

describe("rcBuildHeightfieldLayers", () => {
  test("a bridge above the ground produces more layers than the open ground", () => {
    const ctx = new LogContext();
    const layerCount = (withBridge: boolean): number => {
      const built = build(buildScene(withBridge, false));
      const lset = rcAllocHeightfieldLayerSet();
      const ok = rcBuildHeightfieldLayers(ctx, rebuildForLayers(withBridge, false), 0, WALKABLE_HEIGHT, lset);
      expect({ ok, log: ctx.messages }).toEqual({ ok: true, log: [] });
      for (let i = 0; i < lset.nlayers; ++i) {
        const l = lset.layers![i]!;
        expect(l.width * l.height).toBe(l.heights!.length);
        expect(l.minx).toBeLessThanOrEqual(l.maxx);
        expect(l.miny).toBeLessThanOrEqual(l.maxy);
        expect(l.hmin).toBeLessThanOrEqual(l.hmax);
      }
      expect(built.mesh.npolys).toBeGreaterThan(0);
      return lset.nlayers;
    };
    const flat = layerCount(false);
    const bridged = layerCount(true);
    expect(flat).toBeGreaterThanOrEqual(1);
    expect(bridged).toBeGreaterThan(flat);
  });
});

/** Compact heightfield with layer regions (what `rcBuildHeightfieldLayers` consumes). */
function rebuildForLayers(withBridge: boolean, withBox: boolean): rcCompactHeightfield {
  const scene = buildScene(withBridge, withBox);
  const ctx = new rcContext(false);
  const bmin = new Float32Array([-1, -1, -1]);
  const bmax = new Float32Array([21, 8, 21]);
  const w = { value: 0 };
  const h = { value: 0 };
  rcCalcGridSize(bmin, bmax, CS, w, h);
  const hf = rcAllocHeightfield();
  rcCreateHeightfield(ctx, hf, w.value, h.value, bmin, bmax, CS, CH);
  const nt = scene.tris.length / 3;
  const areas = new Uint8Array(nt);
  rcMarkWalkableTriangles(ctx, 45, scene.verts, scene.verts.length / 3, scene.tris, nt, areas);
  rcRasterizeTriangles(ctx, scene.verts, scene.verts.length / 3, scene.tris, areas, nt, hf);
  const chf = rcAllocCompactHeightfield();
  rcBuildCompactHeightfield(ctx, WALKABLE_HEIGHT, WALKABLE_CLIMB, hf, chf);
  return chf;
}
