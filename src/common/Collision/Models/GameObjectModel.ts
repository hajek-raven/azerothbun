import { log, logError } from "../../../log.ts";
import { AABox } from "../../../math/AABox.ts";
import { Matrix3 } from "../../../math/Matrix3.ts";
import { Ray } from "../../../math/Ray.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { bytesToString, ReadFile } from "../BinaryFile.ts";
import type { FloatRef } from "../BoundingIntervalHierarchy.ts";
import { WorldModelStore } from "../Management/WorldModelStore.ts";
import type { GroupLocationInfo, LocationInfo } from "../Maps/MapTree.ts";
import { GAMEOBJECT_MODELS, MAPS_LOG, VMAP_MAGIC } from "../VMapDefinitions.ts";
import type { ModelIgnoreFlags } from "./ModelIgnoreFlags.ts";
import { ModelFlags } from "./ModelInstance.ts";
import type { WorldModel } from "./WorldModel.ts";

/**
 * What a game object (or a test) provides to its collision model.
 *
 * @ac common/Collision/Models/GameObjectModel.h GameObjectModelOwnerBase
 */
export abstract class GameObjectModelOwnerBase {
  /** @ac common/Collision/Models/GameObjectModel.h GameObjectModelOwnerBase::IsSpawned */
  abstract IsSpawned(): boolean;
  /** @ac common/Collision/Models/GameObjectModel.h GameObjectModelOwnerBase::IsTransport */
  IsTransport(): boolean {
    return false;
  }
  /** @ac common/Collision/Models/GameObjectModel.h GameObjectModelOwnerBase::GetDisplayId */
  abstract GetDisplayId(): number;
  /** @ac common/Collision/Models/GameObjectModel.h GameObjectModelOwnerBase::GetPhaseMask */
  abstract GetPhaseMask(): number;
  /** @ac common/Collision/Models/GameObjectModel.h GameObjectModelOwnerBase::GetPosition */
  abstract GetPosition(): Vector3;
  /** @ac common/Collision/Models/GameObjectModel.h GameObjectModelOwnerBase::GetOrientation */
  abstract GetOrientation(): number;
  /** @ac common/Collision/Models/GameObjectModel.h GameObjectModelOwnerBase::GetScale */
  abstract GetScale(): number;
  /** @ac common/Collision/Models/GameObjectModel.h GameObjectModelOwnerBase::DebugVisualizeCorner */
  abstract DebugVisualizeCorner(corner: Vector3): void;
}

/** @ac common/Collision/Models/GameObjectModel.cpp GameobjectModelData */
export class GameobjectModelData {
  readonly bound: AABox;

  constructor(
    readonly name: string,
    lowBound: Vector3,
    highBound: Vector3,
    readonly isWmo: boolean,
  ) {
    this.bound = new AABox(lowBound, highBound);
  }
}

/** display id -> model, from `GameObjectModels.dtree`. @ac common/Collision/Models/GameObjectModel.cpp model_list */
export const model_list = new Map<number, GameobjectModelData>();

/**
 * Reads `<dataPath>vmaps/GameObjectModels.dtree` (written by `TileAssembler::exportGameobjectModels`):
 * `VMAP_MAGIC`, then per model displayId (u32), isWmo (u8), name length (u32), name, bound low and
 * high (3 floats each).
 *
 * @ac common/Collision/Models/GameObjectModel.cpp LoadGameObjectModelList
 */
export function LoadGameObjectModelList(dataPath: string): void {
  const oldMSTime = performance.now();

  const model_list_file = ReadFile.open(`${dataPath}vmaps/${GAMEOBJECT_MODELS}`);
  if (!model_list_file) {
    logError(MAPS_LOG, `Unable to open '${GAMEOBJECT_MODELS}' file.`);
    return;
  }

  if (!model_list_file.chunk(VMAP_MAGIC, 8)) {
    logError(MAPS_LOG, `File '${GAMEOBJECT_MODELS}' has wrong header, expected ${VMAP_MAGIC}.`);
    return;
  }

  while (true) {
    const displayId = model_list_file.u32();
    if (displayId === undefined && model_list_file.eof()) {
      // EOF flag is only set after failed reading attempt
      break;
    }

    const isWmo = model_list_file.u8();
    const name_length = model_list_file.u32();
    const buff = name_length !== undefined && name_length < 500 ? model_list_file.bytes(name_length) : undefined;
    const v1 = buff ? model_list_file.f32Array(3) : undefined;
    const v2 = v1 ? model_list_file.f32Array(3) : undefined;
    if (isWmo === undefined || name_length === undefined || !buff || !v1 || !v2) {
      logError(MAPS_LOG, `File '${GAMEOBJECT_MODELS}' seems to be corrupted!`);
      break;
    }

    const lo = new Vector3(v1[0], v1[1], v1[2]);
    const hi = new Vector3(v2[0], v2[1], v2[2]);
    const name = bytesToString(buff);
    if (lo.isNaN() || hi.isNaN()) {
      logError(MAPS_LOG, `File '${GAMEOBJECT_MODELS}' Model '${name}' has invalid v1${lo.toString()} v2${hi.toString()} values!`);
      continue;
    }

    // std::unordered_map::emplace keeps the first entry of a display id
    if (!model_list.has(displayId!)) model_list.set(displayId!, new GameobjectModelData(name, lo, hi, isWmo !== 0));
  }

  log("server", `>> Loaded ${model_list.size} GameObject Models in ${Math.round(performance.now() - oldMSTime)} ms`);
  log("server", " ");
}

const modRay = new Ray();
const pModel = new Vector3();
const dirModel = new Vector3();
const modelGround = new Vector3();
const goDistance: FloatRef = { value: 0 };
const zDist: FloatRef = { value: 0 };
const groupInfo: GroupLocationInfo = { hitModel: null, rootId: -1 };
const cornerScratch = new Vector3();

/**
 * Collision model of a game object: a `WorldModel` placed by the owner's position, orientation and
 * scale, switched by phase mask.
 *
 * @ac common/Collision/Models/GameObjectModel.h GameObjectModel
 */
export class GameObjectModel {
  name = "";

  private phasemask = 0;
  private iBound = new AABox();
  private iInvRot = new Matrix3();
  private iPos = new Vector3();
  private iInvScale = 0;
  private iScale = 0;
  private iModel: WorldModel | null = null;
  private owner: GameObjectModelOwnerBase | null = null;
  private isWmo = false;

  private constructor() {}

  /** @ac common/Collision/Models/GameObjectModel.h GameObjectModel::GetBounds */
  GetBounds(): AABox {
    return this.iBound;
  }

  /** @ac common/Collision/Models/GameObjectModel.h GameObjectModel::GetPosition */
  GetPosition(): Vector3 {
    return this.iPos;
  }

  /** Enables\disables collision. @ac common/Collision/Models/GameObjectModel.h GameObjectModel::disable */
  disable(): void {
    this.phasemask = 0;
  }

  /** @ac common/Collision/Models/GameObjectModel.h GameObjectModel::enable */
  enable(ph_mask: number): void {
    this.phasemask = ph_mask;
  }

  /** @ac common/Collision/Models/GameObjectModel.h GameObjectModel::isEnabled */
  isEnabled(): boolean {
    return this.phasemask !== 0;
  }

  /** @ac common/Collision/Models/GameObjectModel.h GameObjectModel::IsMapObject */
  IsMapObject(): boolean {
    return this.isWmo;
  }

  /** @ac common/Collision/Models/GameObjectModel.cpp GameObjectModel::intersectRay */
  intersectRay(ray: Ray, MaxDist: FloatRef, StopAtFirstHit: boolean, ph_mask: number, ignoreFlags: ModelIgnoreFlags): boolean {
    if (!(this.phasemask & ph_mask) || !this.owner!.IsSpawned()) return false;

    const time = ray.intersectionTime(this.iBound);
    if (time === Infinity) return false;

    // child bounds are defined in object space:
    const o = ray.origin();
    const d = ray.direction();
    const inv = this.iInvScale;
    const pos = this.iPos;
    this.iInvRot.mulVecTo(o.x - pos.x, o.y - pos.y, o.z - pos.z, pModel);
    this.iInvRot.mulVecTo(d.x, d.y, d.z, dirModel);
    modRay.setXYZ(pModel.x * inv, pModel.y * inv, pModel.z * inv, dirModel.x, dirModel.y, dirModel.z);
    goDistance.value = MaxDist.value * inv;
    const hit = this.iModel!.IntersectRay(modRay, goDistance, StopAtFirstHit, ignoreFlags);
    if (hit) MaxDist.value = goDistance.value * this.iScale;
    return hit;
  }

  /**
   * Transports provide inaccurate area info while moving (e.g. Booty Bay - Ratchet boat, see #7335),
   * so they never answer.
   *
   * @ac common/Collision/Models/GameObjectModel.cpp GameObjectModel::GetLocationInfo
   */
  GetLocationInfo(point: Vector3, info: LocationInfo, ph_mask: number): boolean {
    if (!(this.phasemask & ph_mask) || !this.owner!.IsSpawned() || !this.IsMapObject() || this.owner!.IsTransport()) return false;

    if (!this.iBound.contains(point)) return false;

    // child bounds are defined in object space:
    const inv = this.iInvScale;
    const pos = this.iPos;
    this.iInvRot.mulVecTo(point.x - pos.x, point.y - pos.y, point.z - pos.z, pModel);
    pModel.set(pModel.x * inv, pModel.y * inv, pModel.z * inv);
    this.iInvRot.mulVecTo(0, 0, -1, dirModel);

    groupInfo.hitModel = null;
    groupInfo.rootId = -1;
    if (this.iModel!.GetLocationInfo(pModel, dirModel, zDist, groupInfo)) {
      const z = zDist.value;
      modelGround.set(pModel.x + z * dirModel.x, pModel.y + z * dirModel.y, pModel.z + z * dirModel.z);
      this.iInvRot.vecMulTo(modelGround.x, modelGround.y, modelGround.z, modelGround);
      const world_Z = modelGround.z * this.iScale + pos.z;
      if (info.ground_Z < world_Z) {
        info.rootId = groupInfo.rootId;
        info.hitModel = groupInfo.hitModel;
        info.ground_Z = world_Z;
        return true;
      }
    }

    return false;
  }

  /** @ac common/Collision/Models/GameObjectModel.cpp GameObjectModel::GetLiquidLevel */
  GetLiquidLevel(point: Vector3, info: LocationInfo, liqHeight: FloatRef): boolean {
    // child bounds are defined in object space:
    const inv = this.iInvScale;
    const pos = this.iPos;
    this.iInvRot.mulVecTo(point.x - pos.x, point.y - pos.y, point.z - pos.z, pModel);
    pModel.set(pModel.x * inv, pModel.y * inv, pModel.z * inv);
    if (info.hitModel && info.hitModel.GetLiquidLevel(pModel, zDist)) {
      // calculate world height (zDist in model coords):
      // assume WMO not tilted (wouldn't make much sense anyway)
      liqHeight.value = zDist.value * this.iScale + pos.z;
      return true;
    }
    return false;
  }

  /**
   * The model of `modelOwner.GetDisplayId()` from the model list, or null when the display has no
   * collision model (not in the list, zero bounds, or the `.vmo` cannot be read).
   *
   * @ac common/Collision/Models/GameObjectModel.cpp GameObjectModel::Create
   */
  static Create(modelOwner: GameObjectModelOwnerBase, dataPath: string): GameObjectModel | null {
    const mdl = new GameObjectModel();
    if (!mdl.initialize(modelOwner, dataPath)) return null;
    return mdl;
  }

  /** @ac common/Collision/Models/GameObjectModel.cpp GameObjectModel::initialize */
  private initialize(modelOwner: GameObjectModelOwnerBase, dataPath: string): boolean {
    const it = model_list.get(modelOwner.GetDisplayId());
    if (!it) return false;

    let mdl_box = it.bound.clone();
    // ignore models with no bounds
    if (mdl_box.equals(AABox.zero())) {
      logError(MAPS_LOG, `GameObject model ${it.name} has zero bounds, loading skipped`);
      return false;
    }

    this.iModel = WorldModelStore.instance().AcquireModelInstance(
      `${dataPath}vmaps/`,
      it.name,
      it.isWmo ? ModelFlags.MOD_WORLDSPAWN : ModelFlags.MOD_M2,
    );

    if (!this.iModel) return false;

    this.name = it.name;
    this.iPos = modelOwner.GetPosition().clone();
    this.phasemask = modelOwner.GetPhaseMask();
    this.iScale = modelOwner.GetScale();
    this.iInvScale = 1 / this.iScale;

    const iRotation = Matrix3.fromEulerAnglesZYX(modelOwner.GetOrientation(), 0, 0);
    this.iInvRot = iRotation.inverse();
    // transform bounding box:
    mdl_box = new AABox(mdl_box.low().times(this.iScale), mdl_box.high().times(this.iScale));
    const rotated_bounds = new AABox();
    for (let i = 0; i < 8; ++i) rotated_bounds.merge(iRotation.mulVec(mdl_box.cornerTo(i, cornerScratch)));

    this.iBound = rotated_bounds.plus(this.iPos);

    // @ac-skip SPAWN_CORNERS debug block (DebugVisualizeCorner): compiled out in AzerothCore builds.

    this.owner = modelOwner;
    this.isWmo = it.isWmo;
    return true;
  }

  /** @ac common/Collision/Models/GameObjectModel.cpp GameObjectModel::UpdatePosition */
  UpdatePosition(): boolean {
    if (!this.iModel) return false;

    const it = model_list.get(this.owner!.GetDisplayId());
    if (!it) return false;

    let mdl_box = it.bound.clone();

    // ignore models with no bounds
    if (mdl_box.equals(AABox.zero())) return false;

    this.iPos = this.owner!.GetPosition().clone();
    const iRotation = Matrix3.fromEulerAnglesZYX(this.owner!.GetOrientation(), 0, 0);
    this.iInvRot = iRotation.inverse();

    // transform bounding box:
    mdl_box = new AABox(mdl_box.low().times(this.iScale), mdl_box.high().times(this.iScale));
    const rotated_bounds = new AABox();

    for (let i = 0; i < 8; ++i) rotated_bounds.merge(iRotation.mulVec(mdl_box.cornerTo(i, cornerScratch)));

    this.iBound = rotated_bounds.plus(this.iPos);
    // @ac-skip SPAWN_CORNERS debug block (DebugVisualizeCorner): compiled out in AzerothCore builds.

    return true;
  }
}
