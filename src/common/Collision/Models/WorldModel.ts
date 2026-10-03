import { logError } from "../../../log.ts";
import { AABox } from "../../../math/AABox.ts";
import { finf } from "../../../math/g3dmath.ts";
import { Ray } from "../../../math/Ray.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { ReadFile, WriteFile } from "../BinaryFile.ts";
import { BIH, type BIHRayCallback, type FloatRef } from "../BoundingIntervalHierarchy.ts";
import type { GroupLocationInfo } from "../Maps/MapTree.ts";
import { LIQUID_TILE_SIZE, MAPS_LOG, readChunk, VMAP_MAGIC } from "../VMapDefinitions.ts";
import { ModelIgnoreFlags } from "./ModelIgnoreFlags.ts";

/** `ModelFlags::MOD_M2` (ModelInstance.h), repeated here to keep WorldModel free of a ModelInstance import. */
const MOD_M2 = 1;

/**
 * One triangle of a group mesh. The meshes themselves store triangles packed in a `Uint32Array`
 * (`idx0, idx1, idx2` per triangle), the same 12 bytes per triangle as the C++ vector.
 *
 * @ac common/Collision/Models/WorldModel.h VMAP::MeshTriangle
 */
export class MeshTriangle {
  constructor(
    public idx0 = 0,
    public idx1 = 0,
    public idx2 = 0,
  ) {}
}

const EPS = Math.fround(1e-5);

/**
 * Ray / triangle test (RTR2 13.7) on the packed arrays: triangle `tri` of `triangles`, vertices
 * `points` (xyz floats). Shortens `distance` and returns true on a closer hit in front of the origin.
 *
 * @ac common/Collision/Models/WorldModel.cpp VMAP::IntersectTriangle
 */
export function IntersectTriangle(triangles: Uint32Array, tri: number, points: Float32Array, ray: Ray, distance: FloatRef): boolean {
  const i0 = triangles[tri * 3]! * 3;
  const i1 = triangles[tri * 3 + 1]! * 3;
  const i2 = triangles[tri * 3 + 2]! * 3;
  const p0x = points[i0]!, p0y = points[i0 + 1]!, p0z = points[i0 + 2]!;

  const e1x = points[i1]! - p0x, e1y = points[i1 + 1]! - p0y, e1z = points[i1 + 2]! - p0z;
  const e2x = points[i2]! - p0x, e2y = points[i2 + 1]! - p0y, e2z = points[i2 + 2]! - p0z;
  const dir = ray.direction();
  const dx = dir.x, dy = dir.y, dz = dir.z;
  // p = dir x e2
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const a = e1x * px + e1y * py + e1z * pz;

  if (Math.abs(a) < EPS) {
    // Determinant is ill-conditioned; abort early
    return false;
  }

  const f = 1 / a;
  const org = ray.origin();
  const sx = org.x - p0x, sy = org.y - p0y, sz = org.z - p0z;
  const u = f * (sx * px + sy * py + sz * pz);

  if (u < 0 || u > 1) {
    // We hit the plane of the m_geometry, but outside the m_geometry
    return false;
  }

  // q = s x e1
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = f * (dx * qx + dy * qy + dz * qz);

  if (v < 0 || u + v > 1) {
    // We hit the plane of the triangle, but outside the triangle
    return false;
  }

  const t = f * (e2x * qx + e2y * qy + e2z * qz);

  if (t > 0 && t < distance.value) {
    // This is a new hit, closer than the previous one
    distance.value = t;
    return true;
  }
  // This hit is after the previous hit, so ignore it
  return false;
}

/**
 * Bounds of one packed triangle, for `BIH::build`.
 *
 * @ac common/Collision/Models/WorldModel.cpp VMAP::TriBoundFunc
 */
export function TriBoundFunc(vertices: Float32Array, triangles: Uint32Array, tri: number, out: AABox): void {
  const a = triangles[tri * 3]! * 3;
  const b = triangles[tri * 3 + 1]! * 3;
  const c = triangles[tri * 3 + 2]! * 3;
  // lo = (lo.min(v1)).min(v2): G3D::min(v.x, x) keeps the earlier value on ties
  const minOf = (x0: number, x1: number, x2: number) => {
    const m = x0 < x1 ? x0 : x1;
    return m < x2 ? m : x2;
  };
  const maxOf = (x0: number, x1: number, x2: number) => {
    const m = x1 < x0 ? x0 : x1;
    return x2 < m ? m : x2;
  };
  out.setBounds(
    minOf(vertices[a]!, vertices[b]!, vertices[c]!),
    minOf(vertices[a + 1]!, vertices[b + 1]!, vertices[c + 1]!),
    minOf(vertices[a + 2]!, vertices[b + 2]!, vertices[c + 2]!),
    maxOf(vertices[a]!, vertices[b]!, vertices[c]!),
    maxOf(vertices[a + 1]!, vertices[b + 1]!, vertices[c + 1]!),
    maxOf(vertices[a + 2]!, vertices[b + 2]!, vertices[c + 2]!),
  );
}

// ===================== WmoLiquid ==================================

/**
 * WMO liquid: a `(tilesX + 1) x (tilesY + 1)` height grid with a flag byte per tile, or a single height
 * (`iFlags` null) for a group that is completely filled.
 *
 * @ac common/Collision/Models/WorldModel.h VMAP::WmoLiquid
 * @ac-skip common/Collision/Models/WorldModel.cpp VMAP::WmoLiquid::~WmoLiquid: memory is garbage collected
 */
export class WmoLiquid {
  /** number of tiles in x direction, each */
  private iTilesX = 0;
  private iTilesY = 0;
  /** the lower corner */
  private iCorner = new Vector3();
  /** liquid type */
  private iType = 0;
  /** `(tilesX + 1) * (tilesY + 1)` height values */
  private iHeight: Float32Array | null = null;
  /** info if liquid tile is used */
  private iFlags: Uint8Array | null = null;

  /**
   * `WmoLiquid(width, height, corner, type)`. Called with no arguments it is the private default
   * constructor that `readFromFile` fills.
   *
   * @ac common/Collision/Models/WorldModel.cpp VMAP::WmoLiquid::WmoLiquid
   */
  constructor(width?: number, height?: number, corner?: Vector3, type?: number) {
    if (width === undefined) return;
    this.iTilesX = width;
    this.iTilesY = height ?? 0;
    this.iCorner = corner ? corner.clone() : new Vector3();
    this.iType = type ?? 0;
    if (width && height) {
      this.iHeight = new Float32Array((width + 1) * (height + 1));
      this.iFlags = new Uint8Array(width * height);
    } else {
      this.iHeight = new Float32Array(1);
      this.iFlags = null;
    }
  }

  /**
   * The copy constructor / assignment operator.
   *
   * @ac common/Collision/Models/WorldModel.cpp VMAP::WmoLiquid::operator=
   */
  clone(): WmoLiquid {
    const out = new WmoLiquid();
    out.iTilesX = this.iTilesX;
    out.iTilesY = this.iTilesY;
    out.iCorner = this.iCorner.clone();
    out.iType = this.iType;
    out.iHeight = this.iHeight ? this.iHeight.slice() : null;
    out.iFlags = this.iFlags ? this.iFlags.slice() : null;
    return out;
  }

  /**
   * Liquid height at `pos` (model space). False outside the grid or on a disabled tile.
   *
   * @ac common/Collision/Models/WorldModel.cpp VMAP::WmoLiquid::GetLiquidHeight
   */
  GetLiquidHeight(pos: Vector3, liqHeight: FloatRef): boolean {
    const iHeight = this.iHeight;
    // simple case
    if (!this.iFlags) {
      liqHeight.value = iHeight ? iHeight[0]! : 0;
      return true;
    }

    const tx_f = (pos.x - this.iCorner.x) / LIQUID_TILE_SIZE;
    const tx = Math.trunc(tx_f);
    if (tx_f < 0 || tx >= this.iTilesX) return false;
    const ty_f = (pos.y - this.iCorner.y) / LIQUID_TILE_SIZE;
    const ty = Math.trunc(ty_f);
    if (ty_f < 0 || ty >= this.iTilesY) return false;

    // check if tile shall be used for liquid level
    // checking for 0x08 *might* be enough, but disabled tiles always are 0x?F:
    if ((this.iFlags[tx + ty * this.iTilesX]! & 0x0f) === 0x0f) return false;

    // (dx, dy) coordinates inside tile, in [0, 1]^2
    const dx = tx_f - tx;
    const dy = ty_f - ty;

    /* Tesselate tile to two triangles (not sure if client does it exactly like this)

        ^ dy
        |
      1 x---------x (1, 1)
        | (b)   / |
        |     /   |
        |   /     |
        | /   (a) |
        x---------x---> dx
      0           1
    */

    if (!iHeight) return false;

    const rowOffset = this.iTilesX + 1;
    if (dx > dy) {
      // case (a)
      const sx = iHeight[tx + 1 + ty * rowOffset]! - iHeight[tx + ty * rowOffset]!;
      const sy = iHeight[tx + 1 + (ty + 1) * rowOffset]! - iHeight[tx + 1 + ty * rowOffset]!;
      liqHeight.value = iHeight[tx + ty * rowOffset]! + dx * sx + dy * sy;
    } else {
      // case (b)
      const sx = iHeight[tx + 1 + (ty + 1) * rowOffset]! - iHeight[tx + (ty + 1) * rowOffset]!;
      const sy = iHeight[tx + (ty + 1) * rowOffset]! - iHeight[tx + ty * rowOffset]!;
      liqHeight.value = iHeight[tx + ty * rowOffset]! + dx * sx + dy * sy;
    }
    return true;
  }

  /** @ac common/Collision/Models/WorldModel.h VMAP::WmoLiquid::GetType */
  GetType(): number {
    return this.iType;
  }

  /** @ac common/Collision/Models/WorldModel.h VMAP::WmoLiquid::GetHeightStorage */
  GetHeightStorage(): Float32Array | null {
    return this.iHeight;
  }

  /** @ac common/Collision/Models/WorldModel.h VMAP::WmoLiquid::GetFlagsStorage */
  GetFlagsStorage(): Uint8Array | null {
    return this.iFlags;
  }

  /** @ac common/Collision/Models/WorldModel.cpp VMAP::WmoLiquid::GetFileSize */
  GetFileSize(): number {
    return 2 * 4 + 12 + 4 + (this.iFlags ? (this.iTilesX + 1) * (this.iTilesY + 1) * 4 + this.iTilesX * this.iTilesY : 4);
  }

  /** @ac common/Collision/Models/WorldModel.cpp VMAP::WmoLiquid::writeToFile */
  writeToFile(wf: WriteFile): boolean {
    wf.u32(this.iTilesX);
    wf.u32(this.iTilesY);
    wf.f32(this.iCorner.x);
    wf.f32(this.iCorner.y);
    wf.f32(this.iCorner.z);
    wf.u32(this.iType);
    if (this.iTilesX && this.iTilesY) {
      const size = (this.iTilesX + 1) * (this.iTilesY + 1);
      if (!this.iHeight || this.iHeight.length < size) return false;
      wf.f32Array(this.iHeight, size);
      const flagCount = this.iTilesX * this.iTilesY;
      if (!this.iFlags || this.iFlags.length < flagCount) return false;
      wf.bytes(this.iFlags.subarray(0, flagCount));
      return true;
    }
    if (!this.iHeight) return false;
    wf.f32(this.iHeight[0]!);
    return true;
  }

  /**
   * Reads a liquid written by `writeToFile`. Returns null on a short read (the C++ out parameter stays
   * untouched and the function returns false).
   *
   * @ac common/Collision/Models/WorldModel.cpp VMAP::WmoLiquid::readFromFile
   */
  static readFromFile(rf: ReadFile): WmoLiquid | null {
    const liquid = new WmoLiquid();
    const tilesX = rf.u32();
    const tilesY = rf.u32();
    const corner = rf.f32Array(3);
    const type = rf.u32();
    if (tilesX === undefined || tilesY === undefined || corner === undefined || type === undefined) return null;
    liquid.iTilesX = tilesX;
    liquid.iTilesY = tilesY;
    liquid.iCorner = new Vector3(corner[0], corner[1], corner[2]);
    liquid.iType = type;
    if (tilesX && tilesY) {
      const size = (tilesX + 1) * (tilesY + 1);
      const height = rf.f32Array(size);
      if (!height) return null;
      liquid.iHeight = height;
      const flags = rf.bytes(tilesX * tilesY);
      if (!flags) return null;
      liquid.iFlags = flags;
      return liquid;
    }
    const height = rf.f32Array(1);
    if (!height) return null;
    liquid.iHeight = height;
    return liquid;
  }

  /** @ac common/Collision/Models/WorldModel.cpp VMAP::WmoLiquid::GetPosInfo */
  GetPosInfo(): { tilesX: number; tilesY: number; corner: Vector3 } {
    return { tilesX: this.iTilesX, tilesY: this.iTilesY, corner: this.iCorner.clone() };
  }
}

// ===================== GroupModel ==================================

/**
 * `GModelRayCallback`. Note that the C++ returns the accumulated `hit`, not the result of this
 * triangle, so with `stopAtFirstHit` the BIH stops at the first leaf object after any hit. Kept.
 *
 * @ac common/Collision/Models/WorldModel.cpp VMAP::GModelRayCallback
 */
class GModelRayCallback implements BIHRayCallback {
  vertices: Float32Array = new Float32Array(0);
  triangles: Uint32Array = new Uint32Array(0);
  hit = false;

  reset(triangles: Uint32Array, vertices: Float32Array): this {
    this.vertices = vertices;
    this.triangles = triangles;
    this.hit = false;
    return this;
  }

  onRay(ray: Ray, entry: number, distance: FloatRef, _stopAtFirstHit: boolean): boolean {
    const result = IntersectTriangle(this.triangles, entry, this.vertices, ray, distance);
    if (result) this.hit = true;
    return this.hit;
  }
}

const gModelRayCallback = new GModelRayCallback();
const insideDist: FloatRef = { value: 0 };
const bumpRay = new Ray();

/** @ac common/Collision/Models/WorldModel.cpp VMAP::IsInsideOrAboveBound */
function IsInsideOrAboveBound(bounds: AABox, point: Vector3): boolean {
  return (
    point.x >= bounds.lo.x &&
    point.y >= bounds.lo.y &&
    point.z >= bounds.lo.z &&
    point.x <= bounds.hi.x &&
    point.y <= bounds.hi.y
  );
}

/** @ac common/Collision/Models/WorldModel.h VMAP::GroupModel::InsideResult */
export const InsideResult = {
  INSIDE: 0,
  MAYBE_INSIDE: 1,
  ABOVE: 2,
  OUT_OF_BOUNDS: -1,
} as const;
export type InsideResult = (typeof InsideResult)[keyof typeof InsideResult];

/**
 * Holding additional info for WMO group files. Vertices are packed xyz floats, triangles packed
 * index triples.
 *
 * @ac common/Collision/Models/WorldModel.h VMAP::GroupModel
 */
export class GroupModel {
  protected iBound: AABox;
  /** 0x8 outdoor; 0x2000 indoor */
  protected iMogpFlags: number;
  protected iGroupWMOID: number;
  protected vertices: Float32Array = new Float32Array(0);
  protected triangles: Uint32Array = new Uint32Array(0);
  protected meshTree = new BIH();
  protected iLiquid: WmoLiquid | null = null;

  /** @ac common/Collision/Models/WorldModel.h VMAP::GroupModel::GroupModel */
  constructor(mogpFlags = 0, groupWMOID = 0, bound?: AABox) {
    this.iMogpFlags = mogpFlags;
    this.iGroupWMOID = groupWMOID;
    this.iBound = bound ? bound.clone() : new AABox();
  }

  /**
   * The copy constructor (deep copy of the mesh and the liquid; the BIH arrays are shared, they are
   * never mutated after build or read).
   *
   * @ac common/Collision/Models/WorldModel.cpp VMAP::GroupModel::GroupModel (copy)
   */
  clone(): GroupModel {
    const out = new GroupModel(this.iMogpFlags, this.iGroupWMOID, this.iBound);
    out.vertices = this.vertices.slice();
    out.triangles = this.triangles.slice();
    out.meshTree = this.meshTree;
    out.iLiquid = this.iLiquid ? this.iLiquid.clone() : null;
    return out;
  }

  /**
   * Takes the mesh (xyz floats, index triples) and builds the BIH over the triangles.
   *
   * @ac common/Collision/Models/WorldModel.cpp VMAP::GroupModel::setMeshData
   */
  setMeshData(vert: Float32Array, tri: Uint32Array): void {
    this.vertices = vert;
    this.triangles = tri;
    const count = tri.length / 3;
    const ids = new Uint32Array(count);
    for (let i = 0; i < count; ++i) ids[i] = i;
    const vertices = this.vertices;
    const triangles = this.triangles;
    this.meshTree.build(ids, (id, out) => TriBoundFunc(vertices, triangles, id, out));
  }

  /** @ac common/Collision/Models/WorldModel.h VMAP::GroupModel::setLiquidData */
  setLiquidData(liquid: WmoLiquid | null): void {
    this.iLiquid = liquid;
  }

  /** @ac common/Collision/Models/WorldModel.cpp VMAP::GroupModel::IntersectRay */
  IntersectRay(ray: Ray, distance: FloatRef, stopAtFirstHit: boolean): boolean {
    if (this.triangles.length === 0) return false;
    const callback = gModelRayCallback.reset(this.triangles, this.vertices);
    this.meshTree.intersectRay(ray, callback, distance, stopAtFirstHit);
    return callback.hit;
  }

  /**
   * Whether the ray origin is inside this group: `INSIDE` with the floor distance in `z_dist`,
   * `ABOVE` when it hits floor below the group, `MAYBE_INSIDE` when no floor is hit but the origin is
   * in the mesh bounds.
   *
   * @ac common/Collision/Models/WorldModel.cpp VMAP::GroupModel::IsInsideObject
   */
  IsInsideObject(ray: Ray, z_dist: FloatRef): InsideResult {
    if (this.triangles.length === 0 || !IsInsideOrAboveBound(this.iBound, ray.origin())) return InsideResult.OUT_OF_BOUNDS;

    const meshBound = this.meshTree.bound();
    if (meshBound.hi.z >= ray.origin().z) {
      insideDist.value = finf();
      if (this.IntersectRay(ray, insideDist, false)) {
        z_dist.value = insideDist.value - 0.1;
        return InsideResult.INSIDE;
      }
      if (meshBound.contains(ray.origin())) return InsideResult.MAYBE_INSIDE;
    } else {
      // some group models don't have any floor to intersect with
      // so we should attempt to intersect with a model part below this group
      // then find back where we originated from (in WorldModel::GetLocationInfo)
      insideDist.value = finf();
      const delta = ray.origin().z - meshBound.hi.z;
      if (this.IntersectRay(ray.bumpedRayTo(delta, bumpRay), insideDist, false)) {
        z_dist.value = insideDist.value - 0.1 + delta;
        return InsideResult.ABOVE;
      }
    }

    return InsideResult.OUT_OF_BOUNDS;
  }

  /** @ac common/Collision/Models/WorldModel.cpp VMAP::GroupModel::GetLiquidLevel */
  GetLiquidLevel(pos: Vector3, liqHeight: FloatRef): boolean {
    if (this.iLiquid) return this.iLiquid.GetLiquidHeight(pos, liqHeight);
    return false;
  }

  /** @ac common/Collision/Models/WorldModel.cpp VMAP::GroupModel::GetLiquidType */
  GetLiquidType(): number {
    if (this.iLiquid) return this.iLiquid.GetType();
    return 0;
  }

  /** @ac common/Collision/Models/WorldModel.cpp VMAP::GroupModel::writeToFile */
  writeToFile(wf: WriteFile): boolean {
    wf.f32(this.iBound.lo.x);
    wf.f32(this.iBound.lo.y);
    wf.f32(this.iBound.lo.z);
    wf.f32(this.iBound.hi.x);
    wf.f32(this.iBound.hi.y);
    wf.f32(this.iBound.hi.z);
    wf.u32(this.iMogpFlags);
    wf.u32(this.iGroupWMOID);

    // write vertices
    wf.chars("VERT", 4);
    let count = this.vertices.length / 3;
    wf.u32(4 + 12 * count);
    wf.u32(count);
    if (!count) {
      // models without (collision) geometry end here, unsure if they are useful
      return true;
    }
    wf.f32Array(this.vertices);

    // write triangle mesh
    wf.chars("TRIM", 4);
    count = this.triangles.length / 3;
    wf.u32(4 + 12 * count);
    wf.u32(count);
    wf.u32Array(this.triangles);

    // write mesh BIH
    wf.chars("MBIH", 4);
    if (!this.meshTree.writeToFile(wf)) return false;

    // write liquid data
    wf.chars("LIQU", 4);
    if (!this.iLiquid) {
      wf.u32(0);
      return true;
    }
    wf.u32(this.iLiquid.GetFileSize());
    return this.iLiquid.writeToFile(wf);
  }

  /** @ac common/Collision/Models/WorldModel.cpp VMAP::GroupModel::readFromFile */
  readFromFile(rf: ReadFile): boolean {
    this.triangles = new Uint32Array(0);
    this.vertices = new Float32Array(0);
    this.iLiquid = null;

    const bound = rf.f32Array(6);
    if (!bound) return false;
    this.iBound = new AABox(new Vector3(bound[0], bound[1], bound[2]), new Vector3(bound[3], bound[4], bound[5]));
    const mogpFlags = rf.u32();
    if (mogpFlags === undefined) return false;
    this.iMogpFlags = mogpFlags;
    const groupWMOID = rf.u32();
    if (groupWMOID === undefined) return false;
    this.iGroupWMOID = groupWMOID;

    // read vertices
    if (!readChunk(rf, "VERT", 4)) return false;
    if (rf.u32() === undefined) return false; // chunkSize
    let count = rf.u32();
    if (count === undefined) return false;
    if (!count) {
      // models without (collision) geometry end here, unsure if they are useful
      return true;
    }
    const vertices = rf.f32Array(count * 3);
    if (!vertices) return false;
    this.vertices = vertices;

    // read triangle mesh
    if (!readChunk(rf, "TRIM", 4)) return false;
    if (rf.u32() === undefined) return false; // chunkSize
    count = rf.u32();
    if (count === undefined) return false;
    const triangles = rf.u32Array(count * 3);
    if (!triangles) return false;
    this.triangles = triangles;

    // read mesh BIH
    if (!readChunk(rf, "MBIH", 4)) return false;
    if (!this.meshTree.readFromFile(rf)) return false;

    // read liquid data
    if (!readChunk(rf, "LIQU", 4)) return false;
    const chunkSize = rf.u32();
    if (chunkSize === undefined) return false;
    if (chunkSize > 0) {
      this.iLiquid = WmoLiquid.readFromFile(rf);
      return this.iLiquid !== null;
    }
    return true;
  }

  /** @ac common/Collision/Models/WorldModel.h VMAP::GroupModel::GetBound */
  GetBound(): AABox {
    return this.iBound;
  }

  /** @ac common/Collision/Models/WorldModel.h VMAP::GroupModel::GetMeshTreeBound */
  GetMeshTreeBound(): AABox {
    return this.meshTree.bound();
  }

  /** @ac common/Collision/Models/WorldModel.h VMAP::GroupModel::GetMogpFlags */
  GetMogpFlags(): number {
    return this.iMogpFlags;
  }

  /** @ac common/Collision/Models/WorldModel.h VMAP::GroupModel::GetWmoID */
  GetWmoID(): number {
    return this.iGroupWMOID;
  }

  /**
   * The mesh (copies, like the C++ vector assignment) and the liquid (shared pointer, like C++).
   *
   * @ac common/Collision/Models/WorldModel.cpp VMAP::GroupModel::GetMeshData
   */
  GetMeshData(): { vertices: Float32Array; triangles: Uint32Array; liquid: WmoLiquid | null } {
    return { vertices: this.vertices.slice(), triangles: this.triangles.slice(), liquid: this.iLiquid };
  }
}

// ===================== WorldModel ==================================

/** @ac common/Collision/Models/WorldModel.cpp VMAP::WModelRayCallBack */
class WModelRayCallBack implements BIHRayCallback {
  models: GroupModel[] = [];
  hit = false;

  reset(models: GroupModel[]): this {
    this.models = models;
    this.hit = false;
    return this;
  }

  onRay(ray: Ray, entry: number, distance: FloatRef, stopAtFirstHit: boolean): boolean {
    const result = this.models[entry]!.IntersectRay(ray, distance, stopAtFirstHit);
    if (result) this.hit = true;
    return this.hit;
  }
}

/** @ac common/Collision/Models/WorldModel.cpp VMAP::WModelAreaCallback */
class WModelAreaCallback implements BIHRayCallback {
  prims: GroupModel[] = [];
  /** Indexed by `InsideResult` (`INSIDE`, `MAYBE_INSIDE`, `ABOVE`). */
  readonly hit: (GroupModel | null)[] = [null, null, null];
  private readonly groupZ: FloatRef = { value: 0 };

  reset(prims: GroupModel[]): this {
    this.prims = prims;
    this.hit[0] = null;
    this.hit[1] = null;
    this.hit[2] = null;
    return this;
  }

  onRay(ray: Ray, entry: number, distance: FloatRef, _stopAtFirstHit: boolean): boolean {
    const prim = this.prims[entry]!;
    const result = prim.IsInsideObject(ray, this.groupZ);
    if (result !== InsideResult.OUT_OF_BOUNDS) {
      if (result !== InsideResult.MAYBE_INSIDE) {
        if (this.groupZ.value < distance.value) {
          distance.value = this.groupZ.value;
          this.hit[result] = prim;
          return true;
        }
      } else {
        this.hit[result] = prim;
      }
    }
    return false;
  }
}

const wModelRayCallBack = new WModelRayCallBack();
const wModelAreaCallback = new WModelAreaCallback();
const locationRay = new Ray();
const locationDist: FloatRef = { value: 0 };

/**
 * Holds a model (converted M2 or WMO) in its original coordinate space.
 *
 * @ac common/Collision/Models/WorldModel.h VMAP::WorldModel
 */
export class WorldModel {
  /** `ModelFlags` the model was acquired with (`WorldModelStore`). */
  Flags = 0;
  protected RootWMOID = 0;
  protected groupModels: GroupModel[] = [];
  protected groupTree = new BIH();

  /**
   * Takes ownership of `models` and builds the group BIH (one group per leaf).
   *
   * @ac common/Collision/Models/WorldModel.cpp VMAP::WorldModel::setGroupModels
   */
  setGroupModels(models: GroupModel[]): void {
    this.groupModels = models;
    this.groupTree.build(this.groupModels, (g, out) => out.copy(g.GetBound()), 1);
  }

  /** @ac common/Collision/Models/WorldModel.h VMAP::WorldModel::setRootWmoID */
  setRootWmoID(id: number): void {
    this.RootWMOID = id;
  }

  /** @ac common/Collision/Models/WorldModel.cpp VMAP::WorldModel::IntersectRay */
  IntersectRay(ray: Ray, distance: FloatRef, stopAtFirstHit: boolean, ignoreFlags: ModelIgnoreFlags): boolean {
    // If the caller asked us to ignore certain objects we should check flags
    if ((ignoreFlags & ModelIgnoreFlags.M2) !== ModelIgnoreFlags.Nothing) {
      // M2 models are not taken into account for LoS calculation if caller requested their ignoring.
      if (this.Flags & MOD_M2) return false;
    }

    // small M2 workaround, maybe better make separate class with virtual intersection funcs
    // in any case, there's no need to use a bound tree if we only have one submodel
    if (this.groupModels.length === 1) return this.groupModels[0]!.IntersectRay(ray, distance, stopAtFirstHit);

    const isc = wModelRayCallBack.reset(this.groupModels);
    this.groupTree.intersectRay(ray, isc, distance, stopAtFirstHit);
    return isc.hit;
  }

  /**
   * Finds the group `p` is inside of (casting along `down`, model space). On success fills `info` and
   * the distance to the floor in `dist`.
   *
   * @ac common/Collision/Models/WorldModel.cpp VMAP::WorldModel::GetLocationInfo
   */
  GetLocationInfo(p: Vector3, down: Vector3, dist: FloatRef, info: GroupLocationInfo): boolean {
    if (this.groupModels.length === 0) return false;

    const callback = wModelAreaCallback.reset(this.groupModels);
    const r = locationRay.setXYZ(p.x - down.x * 0.1, p.y - down.y * 0.1, p.z - down.z * 0.1, down.x, down.y, down.z);
    const b = this.groupTree.bound();
    if (b.isEmpty()) {
      locationDist.value = 0;
    } else {
      const ex = b.hi.x - b.lo.x, ey = b.hi.y - b.lo.y, ez = b.hi.z - b.lo.z;
      locationDist.value = Math.sqrt(ex * ex + ey * ey + ez * ez);
    }
    this.groupTree.intersectRay(r, callback, locationDist, false);
    if (callback.hit[InsideResult.INSIDE]) {
      info.rootId = this.RootWMOID;
      info.hitModel = callback.hit[InsideResult.INSIDE]!;
      dist.value = locationDist.value;
      return true;
    }

    // some group models don't have any floor to intersect with
    // so we should attempt to intersect with a model part below the group `p` is in (stored in GroupModel::ABOVE)
    // then find back where we originated from (GroupModel::MAYBE_INSIDE)
    if (callback.hit[InsideResult.MAYBE_INSIDE] && callback.hit[InsideResult.ABOVE]) {
      info.rootId = this.RootWMOID;
      info.hitModel = callback.hit[InsideResult.MAYBE_INSIDE]!;
      dist.value = locationDist.value;
      return true;
    }
    return false;
  }

  /**
   * Writes the `.vmo` file. Asynchronous because the file is written with `Bun.write`.
   *
   * @ac common/Collision/Models/WorldModel.cpp VMAP::WorldModel::writeFile
   */
  async writeFile(filename: string): Promise<boolean> {
    const wf = new WriteFile();
    const result = this.writeTo(wf);
    if (!(await wf.flush(filename))) return false;
    return result;
  }

  /** The body of `writeFile` into a buffer (used by `writeFile` and by tests). */
  writeTo(wf: WriteFile): boolean {
    let result = true;
    wf.chars(VMAP_MAGIC, 8);
    wf.chars("WMOD", 4);
    wf.u32(4 + 4);
    wf.u32(this.RootWMOID);

    // write group models
    const count = this.groupModels.length;
    if (count) {
      wf.chars("GMOD", 4);
      wf.u32(count);
      for (let i = 0; i < this.groupModels.length && result; ++i) result = this.groupModels[i]!.writeToFile(wf);

      // write group BIH
      if (result) {
        wf.chars("GBIH", 4);
        result = this.groupTree.writeToFile(wf);
      }
    }
    return result;
  }

  /**
   * Reads a `.vmo` file. The file is mapped and the meshes are copied into typed arrays.
   *
   * @ac common/Collision/Models/WorldModel.cpp VMAP::WorldModel::readFile
   */
  readFile(filename: string): boolean {
    const rf = ReadFile.open(filename);
    if (!rf) return false;
    try {
      return this.readFrom(rf);
    } catch (error) {
      logError(MAPS_LOG, `WorldModel::readFile: failed to read '${filename}'`, error);
      return false;
    }
  }

  /** The body of `readFile` over an open file. */
  readFrom(rf: ReadFile): boolean {
    let result = true;
    // Ignore the added magic header
    if (!readChunk(rf, VMAP_MAGIC, 8)) result = false;
    if (result && !readChunk(rf, "WMOD", 4)) result = false;
    if (result && rf.u32() === undefined) result = false; // chunkSize
    if (result) {
      const root = rf.u32();
      if (root === undefined) result = false;
      else this.RootWMOID = root;
    }

    // read group models
    if (result && readChunk(rf, "GMOD", 4)) {
      const count = rf.u32();
      if (count === undefined) result = false;
      const groups: GroupModel[] = [];
      for (let i = 0; i < (count ?? 0) && result; ++i) {
        const group = new GroupModel();
        result = group.readFromFile(rf);
        groups.push(group);
      }
      if (result) {
        while (groups.length < (count ?? 0)) groups.push(new GroupModel());
      }
      this.groupModels = groups;

      // read group BIH
      if (result && !readChunk(rf, "GBIH", 4)) result = false;
      if (result) result = this.groupTree.readFromFile(rf);
    }
    return result;
  }

  /** Copies of the group models. @ac common/Collision/Models/WorldModel.cpp VMAP::WorldModel::GetGroupModels */
  GetGroupModels(): GroupModel[] {
    return this.groupModels.map((g) => g.clone());
  }
}
