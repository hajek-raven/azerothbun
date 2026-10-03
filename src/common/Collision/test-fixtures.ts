/**
 * Test fixtures for the Collision tests: hand-built meshes, and writers for the raw vmap dump that
 * mirror the extractor (`tools/vmap4_extractor`): raw model files (`wmo.cpp` ConvertToVMAPRootWmo /
 * ConvertToVMAPGroupWmo, `model.cpp` ConvertToVMAPModel), `dir_bin` records (`wmo.cpp` / `model.cpp`
 * Extract) and `temp_gameobject_models` (`gameobject_extract.cpp`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AABox } from "../../math/AABox.ts";
import { Vector3 } from "../../math/Vector3.ts";
import { stringToBytes, WriteFile } from "./BinaryFile.ts";
import { GroupModel, WmoLiquid, WorldModel } from "./Models/WorldModel.ts";
import { GAMEOBJECT_MODELS, RAW_VMAP_MAGIC, VMAP_MAGIC } from "./VMapDefinitions.ts";

export interface Mesh {
  vertices: number[];
  indices: number[];
}

/** A closed box (8 vertices, 12 triangles). */
export function boxMesh(lo: [number, number, number], hi: [number, number, number]): Mesh {
  const vertices: number[] = [];
  for (let i = 0; i < 8; ++i) vertices.push(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]);
  // prettier-ignore
  const indices = [
    0, 1, 3, 0, 3, 2, // bottom
    4, 5, 7, 4, 7, 6, // top
    0, 2, 6, 0, 6, 4, // x lo
    1, 3, 7, 1, 7, 5, // x hi
    0, 1, 5, 0, 5, 4, // y lo
    2, 3, 7, 2, 7, 6, // y hi
  ];
  return { vertices, indices };
}

/** A ramp rising along +x from `z0` at `x0` to `z1` at `x1`, `y0..y1` wide. */
export function rampMesh(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Mesh {
  return {
    vertices: [x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

export function mergeMeshes(...meshes: Mesh[]): Mesh {
  const out: Mesh = { vertices: [], indices: [] };
  for (const m of meshes) {
    const base = out.vertices.length / 3;
    out.vertices.push(...m.vertices);
    out.indices.push(...m.indices.map((i) => i + base));
  }
  return out;
}

export function meshBounds(mesh: Mesh): [[number, number, number], [number, number, number]] {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    for (let a = 0; a < 3; ++a) {
      lo[a] = Math.min(lo[a]!, mesh.vertices[i + a]!);
      hi[a] = Math.max(hi[a]!, mesh.vertices[i + a]!);
    }
  }
  return [lo, hi];
}

/** Raw liquid of a group (`liquflags & 1`: a height grid; `liquflags & 2` only: the group top). */
export interface RawLiquid {
  type: number;
  /** Present for `liquflags & 1`. */
  grid?: { xtiles: number; ytiles: number; corner: [number, number, number]; heights: number[]; flags: number[] };
}

export interface RawGroup {
  mogpflags: number;
  groupWMOID: number;
  bound: [[number, number, number], [number, number, number]];
  mesh: Mesh;
  liquid?: RawLiquid;
}

/** The raw model file of `vmapexport` (`VMAP048`, vertex total, group count, RootWMOID, groups). */
export function rawModelBytes(rootWMOID: number, groups: RawGroup[]): Uint8Array {
  const wf = new WriteFile();
  wf.chars(RAW_VMAP_MAGIC, 8);
  wf.u32(groups.reduce((n, g) => n + g.mesh.vertices.length / 3, 0));
  wf.u32(groups.length);
  wf.u32(rootWMOID);
  for (const g of groups) {
    const liquflags = g.liquid ? (g.liquid.grid ? 1 : 2) : 0;
    wf.u32(g.mogpflags);
    wf.u32(g.groupWMOID);
    wf.f32Array(g.bound[0]);
    wf.f32Array(g.bound[1]);
    wf.u32(liquflags);
    // GRP: one batch with one index, like MobaEx
    wf.chars("GRP ", 4);
    wf.i32(1 * 4 + 4);
    wf.i32(1);
    wf.i32(0);
    // INDX
    wf.chars("INDX", 4);
    wf.i32(4 + 2 * g.mesh.indices.length);
    wf.u32(g.mesh.indices.length);
    wf.u16Array(g.mesh.indices);
    // VERT
    const nVertices = g.mesh.vertices.length / 3;
    wf.chars("VERT", 4);
    wf.i32(4 + 12 * nVertices);
    wf.i32(nVertices);
    wf.f32Array(g.mesh.vertices);
    // LIQU
    if (g.liquid) {
      const grid = g.liquid.grid;
      let total = 4;
      if (grid) total += 30 + (grid.xtiles + 1) * (grid.ytiles + 1) * 4 + grid.xtiles * grid.ytiles;
      wf.chars("LIQU", 4);
      wf.i32(total);
      wf.u32(g.liquid.type);
      if (grid) {
        wf.i32(grid.xtiles + 1);
        wf.i32(grid.ytiles + 1);
        wf.i32(grid.xtiles);
        wf.i32(grid.ytiles);
        wf.f32Array(grid.corner);
        wf.i16(0);
        wf.f32Array(grid.heights);
        wf.bytes(Uint8Array.from(grid.flags));
      }
    }
  }
  return wf.toBytes();
}

/** The raw file of an M2 (`model.cpp` ConvertToVMAPModel): one group, zero bound, no liquid. */
export function rawM2Bytes(mesh: Mesh): Uint8Array {
  return rawModelBytes(0, [{ mogpflags: 0, groupWMOID: 0, bound: [[0, 0, 0], [0, 0, 0]], mesh }]);
}

export interface DirBinEntry {
  mapID: number;
  tileX: number;
  tileY: number;
  flags: number;
  adtId: number;
  uniqueId: number;
  pos: [number, number, number];
  rot: [number, number, number];
  scale: number;
  /** Written only for WMO spawns (`MOD_HAS_BOUND`). */
  bound?: [[number, number, number], [number, number, number]];
  name: string;
}

/** `dir_bin`: mapID, tileX, tileY, Flags, NameSet, UniqueId, Pos, Rot, Scale, [Bound_lo, Bound_hi], name. */
export function dirBinBytes(entries: DirBinEntry[]): Uint8Array {
  const wf = new WriteFile();
  for (const e of entries) {
    wf.u32(e.mapID);
    wf.u32(e.tileX);
    wf.u32(e.tileY);
    wf.u32(e.flags);
    wf.u16(e.adtId);
    wf.u32(e.uniqueId);
    wf.f32Array(e.pos);
    wf.f32Array(e.rot);
    wf.f32(e.scale);
    if (e.bound) {
      wf.f32Array(e.bound[0]);
      wf.f32Array(e.bound[1]);
    }
    const name = stringToBytes(e.name);
    wf.u32(name.length);
    wf.bytes(name);
  }
  return wf.toBytes();
}

/** `temp_gameobject_models`: `VMAP048\0`, then displayId, isWmo, name length, name. */
export function tempGameObjectModelsBytes(entries: { displayId: number; isWmo: boolean; name: string }[]): Uint8Array {
  const wf = new WriteFile();
  wf.chars(RAW_VMAP_MAGIC, 8);
  for (const e of entries) {
    const name = stringToBytes(e.name);
    wf.u32(e.displayId);
    wf.u8(e.isWmo ? 1 : 0);
    wf.u32(name.length);
    wf.bytes(name);
  }
  return wf.toBytes();
}

/** `GameObjectModels.dtree` as `exportGameobjectModels` writes it. */
export function gameObjectModelsBytes(entries: { displayId: number; isWmo: boolean; name: string; lo: [number, number, number]; hi: [number, number, number] }[]): Uint8Array {
  const wf = new WriteFile();
  wf.chars(VMAP_MAGIC, 8);
  for (const e of entries) {
    const name = stringToBytes(e.name);
    wf.u32(e.displayId);
    wf.u8(e.isWmo ? 1 : 0);
    wf.u32(name.length);
    wf.bytes(name);
    wf.f32Array(e.lo);
    wf.f32Array(e.hi);
  }
  return wf.toBytes();
}

export { GAMEOBJECT_MODELS };

/** The test house: group 0 is a closed 10x10x5 box (indoor, liquid grid at z 1 over x,y 0..8.33), group 1 a ramp outside it. */
export const HOUSE_ROOT_WMO_ID = 4242;
export const HOUSE_GROUP_ID = 100;
export const RAMP_GROUP_ID = 101;
export const HOUSE_MOGP = 0x2000;
export const RAMP_MOGP = 0x8;
export const HOUSE_LIQUID_TYPE = 13;

export function houseRawGroups(): RawGroup[] {
  const house = boxMesh([0, 0, 0], [10, 10, 5]);
  const ramp = rampMesh(12, 22, 0, 10, 0, 5);
  return [
    {
      mogpflags: HOUSE_MOGP,
      groupWMOID: HOUSE_GROUP_ID,
      bound: meshBounds(house),
      mesh: house,
      liquid: { type: HOUSE_LIQUID_TYPE, grid: { xtiles: 2, ytiles: 2, corner: [0, 0, 0], heights: new Array(9).fill(1), flags: [0, 0, 0, 0] } },
    },
    { mogpflags: RAMP_MOGP, groupWMOID: RAMP_GROUP_ID, bound: meshBounds(ramp), mesh: ramp },
  ];
}

/** The same house built directly as a `WorldModel` (what `TileAssembler::convertRawFile` produces). */
export function buildHouseWorldModel(): WorldModel {
  const groups = houseRawGroups().map((raw) => {
    const g = new GroupModel(raw.mogpflags, raw.groupWMOID, new AABox(new Vector3(...raw.bound[0]), new Vector3(...raw.bound[1])));
    g.setMeshData(Float32Array.from(raw.mesh.vertices), Uint32Array.from(raw.mesh.indices));
    if (raw.liquid?.grid) {
      const grid = raw.liquid.grid;
      const liquid = new WmoLiquid(grid.xtiles, grid.ytiles, new Vector3(...grid.corner), raw.liquid.type);
      liquid.GetHeightStorage()!.set(grid.heights);
      liquid.GetFlagsStorage()!.set(grid.flags);
      g.setLiquidData(liquid);
    }
    return g;
  });
  const model = new WorldModel();
  model.setRootWmoID(HOUSE_ROOT_WMO_ID);
  model.setGroupModels(groups);
  return model;
}

/** A unit cube M2 (0..1 on each axis). */
export function crateMesh(): Mesh {
  return boxMesh([0, 0, 0], [1, 1, 1]);
}

/** A fresh temp directory and its cleanup. */
export function makeTempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Deterministic xorshift so failures reproduce. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}
