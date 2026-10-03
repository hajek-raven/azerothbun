import { logError } from "../../../log.ts";
import { AABox } from "../../../math/AABox.ts";
import { pi } from "../../../math/g3dmath.ts";
import { Matrix3 } from "../../../math/Matrix3.ts";
import { Ray } from "../../../math/Ray.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { bytesToString, stringToBytes, type ReadFile, type WriteFile } from "../BinaryFile.ts";
import type { FloatRef } from "../BoundingIntervalHierarchy.ts";
import type { GroupLocationInfo, LocationInfo } from "../Maps/MapTree.ts";
import { MAPS_LOG } from "../VMapDefinitions.ts";
import type { ModelIgnoreFlags } from "./ModelIgnoreFlags.ts";
import type { WorldModel } from "./WorldModel.ts";

/** @ac common/Collision/Models/ModelInstance.h VMAP::ModelFlags */
export const ModelFlags = {
  MOD_M2: 1,
  MOD_WORLDSPAWN: 1 << 1,
  MOD_HAS_BOUND: 1 << 2,
} as const;

/**
 * A model placement as stored in `dir_bin`, `.vmtree` and `.vmtile`:
 * flags, adtId, ID, Pos, Rot, Scale, Bound_lo, Bound_hi (only with `MOD_HAS_BOUND`), name.
 *
 * @ac common/Collision/Models/ModelInstance.h VMAP::ModelSpawn
 */
export class ModelSpawn {
  flags = 0;
  adtId = 0;
  ID = 0;
  iPos = new Vector3();
  iRot = new Vector3();
  iScale = 0;
  iBound = new AABox();
  name = "";

  /** Value copy (the C++ copy constructor). */
  copyFrom(spawn: ModelSpawn): this {
    this.flags = spawn.flags;
    this.adtId = spawn.adtId;
    this.ID = spawn.ID;
    this.iPos = spawn.iPos.clone();
    this.iRot = spawn.iRot.clone();
    this.iScale = spawn.iScale;
    this.iBound = spawn.iBound.clone();
    this.name = spawn.name;
    return this;
  }

  /** A value copy as a plain `ModelSpawn`. */
  cloneSpawn(): ModelSpawn {
    return new ModelSpawn().copyFrom(this);
  }

  /** @ac common/Collision/Models/ModelInstance.h VMAP::ModelSpawn::operator== */
  equals(other: ModelSpawn): boolean {
    return this.ID === other.ID;
  }

  /** @ac common/Collision/Models/ModelInstance.h VMAP::ModelSpawn::GetBounds */
  GetBounds(): AABox {
    return this.iBound;
  }

  /**
   * Reads one spawn into `spawn`. Fields that are not in the record (the bound without
   * `MOD_HAS_BOUND`) keep their previous value, as with the reused C++ object.
   *
   * @ac common/Collision/Models/ModelInstance.cpp VMAP::ModelSpawn::readFromFile
   */
  static readFromFile(rf: ReadFile, spawn: ModelSpawn): boolean {
    const flags = rf.u32();
    // EoF?
    if (flags === undefined) return false;
    spawn.flags = flags;
    const adtId = rf.u16();
    const id = rf.u32();
    const pos = rf.f32Array(3);
    const rot = rf.f32Array(3);
    const scale = rf.f32();
    let ok = adtId !== undefined && id !== undefined && pos !== undefined && rot !== undefined && scale !== undefined;
    if (adtId !== undefined) spawn.adtId = adtId;
    if (id !== undefined) spawn.ID = id;
    if (pos) spawn.iPos = new Vector3(pos[0], pos[1], pos[2]);
    if (rot) spawn.iRot = new Vector3(rot[0], rot[1], rot[2]);
    if (scale !== undefined) spawn.iScale = scale;
    const has_bound = (spawn.flags & ModelFlags.MOD_HAS_BOUND) !== 0;
    if (has_bound) {
      // only WMOs have bound in MPQ, only available after computation
      const b = rf.f32Array(6);
      if (b) spawn.iBound = new AABox(new Vector3(b[0], b[1], b[2]), new Vector3(b[3], b[4], b[5]));
      else ok = false;
    }
    const nameLen = rf.u32();
    if (!ok || nameLen === undefined) {
      logError(MAPS_LOG, "Error reading ModelSpawn!");
      return false;
    }
    if (nameLen > 500) {
      // file names should never be that long, must be file error
      logError(MAPS_LOG, "Error reading ModelSpawn, file name too long!");
      return false;
    }
    const name = rf.bytes(nameLen);
    if (!name) {
      logError(MAPS_LOG, "Error reading ModelSpawn!");
      return false;
    }
    spawn.name = bytesToString(name);
    return true;
  }

  /** @ac common/Collision/Models/ModelInstance.cpp VMAP::ModelSpawn::writeToFile */
  static writeToFile(wf: WriteFile, spawn: ModelSpawn): boolean {
    wf.u32(spawn.flags);
    wf.u16(spawn.adtId);
    wf.u32(spawn.ID);
    wf.f32(spawn.iPos.x);
    wf.f32(spawn.iPos.y);
    wf.f32(spawn.iPos.z);
    wf.f32(spawn.iRot.x);
    wf.f32(spawn.iRot.y);
    wf.f32(spawn.iRot.z);
    wf.f32(spawn.iScale);
    const has_bound = (spawn.flags & ModelFlags.MOD_HAS_BOUND) !== 0;
    if (has_bound) {
      // only WMOs have bound in MPQ, only available after computation
      const lo = spawn.iBound.low();
      const hi = spawn.iBound.high();
      wf.f32(lo.x);
      wf.f32(lo.y);
      wf.f32(lo.z);
      wf.f32(hi.x);
      wf.f32(hi.y);
      wf.f32(hi.z);
    }
    const name = stringToBytes(spawn.name);
    wf.u32(name.length);
    wf.bytes(name);
    return true;
  }
}

const modRay = new Ray();
const miDistance: FloatRef = { value: 0 };
const pModel = new Vector3();
const zDirModel = new Vector3();
const modelGround = new Vector3();
const zDist: FloatRef = { value: 0 };
const groupInfo: GroupLocationInfo = { hitModel: null, rootId: -1 };

/**
 * A spawned model: the spawn data plus the inverse placement transform and the shared `WorldModel`.
 *
 * @ac common/Collision/Models/ModelInstance.h VMAP::ModelInstance
 */
export class ModelInstance extends ModelSpawn {
  protected iInvRot = new Matrix3();
  protected iInvScale = 0;
  protected iModel: WorldModel | null = null;

  /**
   * `ModelInstance()` (no model) or `ModelInstance(spawn, model)`.
   *
   * @ac common/Collision/Models/ModelInstance.cpp VMAP::ModelInstance::ModelInstance
   */
  constructor(spawn?: ModelSpawn, model?: WorldModel | null) {
    super();
    if (!spawn) return;
    this.copyFrom(spawn);
    this.iModel = model ?? null;
    this.iInvRot = Matrix3.fromEulerAnglesZYX(
      (pi() * this.iRot.y) / 180,
      (pi() * this.iRot.x) / 180,
      (pi() * this.iRot.z) / 180,
    ).inverse();
    this.iInvScale = 1 / this.iScale;
  }

  /**
   * Intersects the ray (world space of the tree) with the model. On a hit shortens `pMaxDist`.
   *
   * @ac common/Collision/Models/ModelInstance.cpp VMAP::ModelInstance::intersectRay
   */
  intersectRay(pRay: Ray, pMaxDist: FloatRef, StopAtFirstHit: boolean, ignoreFlags: ModelIgnoreFlags): boolean {
    const model = this.iModel;
    if (!model) return false;
    const time = pRay.intersectionTime(this.iBound);
    if (time === Infinity) return false;
    // child bounds are defined in object space:
    const o = pRay.origin();
    const d = pRay.direction();
    const inv = this.iInvScale;
    const pos = this.iPos;
    this.iInvRot.mulVecTo(o.x - pos.x, o.y - pos.y, o.z - pos.z, pModel);
    this.iInvRot.mulVecTo(d.x, d.y, d.z, zDirModel);
    modRay.setXYZ(pModel.x * inv, pModel.y * inv, pModel.z * inv, zDirModel.x, zDirModel.y, zDirModel.z);
    miDistance.value = pMaxDist.value * inv;
    const hit = model.IntersectRay(modRay, miDistance, StopAtFirstHit, ignoreFlags);
    if (hit) pMaxDist.value = miDistance.value * this.iScale;
    return hit;
  }

  /**
   * Area info: the WMO group below `p` (world space) with the highest floor wins.
   *
   * @ac common/Collision/Models/ModelInstance.cpp VMAP::ModelInstance::GetLocationInfo
   */
  GetLocationInfo(p: Vector3, info: LocationInfo): boolean {
    const model = this.iModel;
    if (!model) return false;

    // M2 files don't contain area info, only WMO files
    if (this.flags & ModelFlags.MOD_M2) return false;
    if (!this.iBound.contains(p)) return false;
    // child bounds are defined in object space:
    const inv = this.iInvScale;
    const pos = this.iPos;
    this.iInvRot.mulVecTo(p.x - pos.x, p.y - pos.y, p.z - pos.z, pModel);
    pModel.set(pModel.x * inv, pModel.y * inv, pModel.z * inv);
    this.iInvRot.mulVecTo(0, 0, -1, zDirModel);

    groupInfo.hitModel = null;
    groupInfo.rootId = -1;
    if (model.GetLocationInfo(pModel, zDirModel, zDist, groupInfo)) {
      const z = zDist.value;
      modelGround.set(pModel.x + z * zDirModel.x, pModel.y + z * zDirModel.y, pModel.z + z * zDirModel.z);
      // Transform back to world space. Note that:
      // Mat * vec == vec * Mat.transpose()
      // and for rotation matrices: Mat.inverse() == Mat.transpose()
      this.iInvRot.vecMulTo(modelGround.x, modelGround.y, modelGround.z, modelGround);
      const world_Z = modelGround.z * this.iScale + pos.z;
      if (info.ground_Z < world_Z) {
        // hm...could it be handled automatically with zDist at intersection?
        info.rootId = groupInfo.rootId;
        info.hitModel = groupInfo.hitModel;
        info.ground_Z = world_Z;
        info.hitInstance = this;
        return true;
      }
    }
    return false;
  }

  /**
   * Liquid level of `info.hitModel` at `p` (world space), converted back to a world height.
   *
   * @ac common/Collision/Models/ModelInstance.cpp VMAP::ModelInstance::GetLiquidLevel
   */
  GetLiquidLevel(p: Vector3, info: LocationInfo, liqHeight: FloatRef): boolean {
    // child bounds are defined in object space:
    const inv = this.iInvScale;
    const pos = this.iPos;
    this.iInvRot.mulVecTo(p.x - pos.x, p.y - pos.y, p.z - pos.z, pModel);
    pModel.set(pModel.x * inv, pModel.y * inv, pModel.z * inv);
    if (info.hitModel && info.hitModel.GetLiquidLevel(pModel, zDist)) {
      // calculate world height (zDist in model coords):
      this.iInvRot.vecMulTo(pModel.x, pModel.y, zDist.value, modelGround);
      liqHeight.value = modelGround.z * this.iScale + pos.z;
      return true;
    }
    return false;
  }

  /** @ac common/Collision/Models/ModelInstance.h VMAP::ModelInstance::getWorldModel */
  getWorldModel(): WorldModel | null {
    return this.iModel;
  }
}
