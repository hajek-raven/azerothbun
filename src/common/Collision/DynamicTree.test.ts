import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Vector3 } from "../../math/Vector3.ts";
import { DynamicMapTree } from "./DynamicTree.ts";
import { AreaAndLiquidData } from "./Management/IVMapMgr.ts";
import { VMapFactory } from "./Management/VMapFactory.ts";
import { GameObjectModel, GameObjectModelOwnerBase, LoadGameObjectModelList, model_list } from "./Models/GameObjectModel.ts";
import { ModelIgnoreFlags } from "./Models/ModelIgnoreFlags.ts";
import { GroupModel, WorldModel } from "./Models/WorldModel.ts";
import {
  boxMesh,
  buildHouseWorldModel,
  GAMEOBJECT_MODELS,
  gameObjectModelsBytes,
  HOUSE_GROUP_ID,
  HOUSE_LIQUID_TYPE,
  HOUSE_MOGP,
  HOUSE_ROOT_WMO_ID,
  makeTempDir,
} from "./test-fixtures.ts";

const tmp = makeTempDir("dyntree-test-");
const dataPath = `${tmp.dir}/`;

const HOUSE_DISPLAY = 7001;
const CRATE_DISPLAY = 7002;
const ZERO_DISPLAY = 7003;

class TestOwner extends GameObjectModelOwnerBase {
  spawned = true;
  transport = false;

  constructor(
    public displayId: number,
    public pos: Vector3,
    public orientation = 0,
    public scale = 1,
    public phase = 1,
  ) {
    super();
  }

  IsSpawned(): boolean {
    return this.spawned;
  }
  override IsTransport(): boolean {
    return this.transport;
  }
  GetDisplayId(): number {
    return this.displayId;
  }
  GetPhaseMask(): number {
    return this.phase;
  }
  GetPosition(): Vector3 {
    return this.pos;
  }
  GetOrientation(): number {
    return this.orientation;
  }
  GetScale(): number {
    return this.scale;
  }
  DebugVisualizeCorner(_corner: Vector3): void {}
}

beforeAll(async () => {
  mkdirSync(join(tmp.dir, "vmaps"));
  expect(await buildHouseWorldModel().writeFile(join(tmp.dir, "vmaps", "dyn_house.wmo.vmo"))).toBe(true);
  const crate = new GroupModel(0, 0);
  const mesh = boxMesh([0, 0, 0], [1, 1, 1]);
  crate.setMeshData(Float32Array.from(mesh.vertices), Uint32Array.from(mesh.indices));
  const crateModel = new WorldModel();
  crateModel.setGroupModels([crate]);
  expect(await crateModel.writeFile(join(tmp.dir, "vmaps", "dyn_crate.m2.vmo"))).toBe(true);
  await Bun.write(
    join(tmp.dir, "vmaps", GAMEOBJECT_MODELS),
    gameObjectModelsBytes([
      { displayId: HOUSE_DISPLAY, isWmo: true, name: "dyn_house.wmo", lo: [0, 0, 0], hi: [22, 10, 5] },
      { displayId: CRATE_DISPLAY, isWmo: false, name: "dyn_crate.m2", lo: [0, 0, 0], hi: [1, 1, 1] },
      { displayId: ZERO_DISPLAY, isWmo: false, name: "dyn_crate.m2", lo: [0, 0, 0], hi: [0, 0, 0] },
    ]),
  );
  const quiet = spyOn(console, "log").mockImplementation(() => {});
  try {
    LoadGameObjectModelList(dataPath);
  } finally {
    quiet.mockRestore();
  }
});

afterAll(() => tmp.cleanup());

/** House yawed 90 degrees at (1000, 2000, 30): its box covers x 990..1000, y 2000..2010. */
function houseOwner(): TestOwner {
  return new TestOwner(HOUSE_DISPLAY, new Vector3(1000, 2000, 30), Math.PI / 2);
}

describe("GameObjectModel", () => {
  test("the model list is loaded from GameObjectModels.dtree", () => {
    expect(model_list.get(HOUSE_DISPLAY)?.name).toBe("dyn_house.wmo");
    expect(model_list.get(HOUSE_DISPLAY)?.isWmo).toBe(true);
    expect(model_list.get(CRATE_DISPLAY)?.isWmo).toBe(false);
  });

  test("Create fails for unknown displays and zero bounds", () => {
    expect(GameObjectModel.Create(new TestOwner(1, new Vector3()), dataPath)).toBeNull();
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(GameObjectModel.Create(new TestOwner(ZERO_DISPLAY, new Vector3()), dataPath)).toBeNull();
    } finally {
      quiet.mockRestore();
    }
  });

  test("bounds follow position, orientation and scale", () => {
    const house = GameObjectModel.Create(houseOwner(), dataPath)!;
    expect(house.name).toBe("dyn_house.wmo");
    expect(house.IsMapObject()).toBe(true);
    const b = house.GetBounds();
    expect(b.low().x).toBeCloseTo(990, 3);
    expect(b.high().x).toBeCloseTo(1000, 3);
    expect(b.low().y).toBeCloseTo(2000, 3);
    expect(b.high().y).toBeCloseTo(2022, 3);
    expect(b.high().z).toBeCloseTo(35, 3);
    const crate = GameObjectModel.Create(new TestOwner(CRATE_DISPLAY, new Vector3(10, 20, 0), 0, 2), dataPath)!;
    expect(crate.GetBounds().high().equals(new Vector3(12, 22, 2))).toBe(true);
  });
});

describe("DynamicMapTree", () => {
  test("insert, query, phase, spawn state, remove", () => {
    const tree = new DynamicMapTree();
    const owner = houseOwner();
    const house = GameObjectModel.Create(owner, dataPath)!;
    tree.insert(house);
    expect(tree.contains(house)).toBe(true);
    expect(tree.size()).toBe(1);

    // floor under a point inside the house
    expect(tree.getHeight(995, 2005, 32, 10, 1)).toBeCloseTo(30, 3);
    // ramp along world +y: model x 17 -> world y 2017, z 2.5
    expect(tree.getHeight(995, 2017, 40, 20, 1)).toBeCloseTo(32.5, 3);
    expect(tree.getHeight(900, 2005, 32, 10, 1)).toBe(-Infinity);

    // a wall between inside and outside
    expect(tree.isInLineOfSight(995, 2005, 32, 980, 2005, 32, 1, ModelIgnoreFlags.Nothing)).toBe(false);
    expect(tree.isInLineOfSight(985, 1990, 32, 985, 2030, 32, 1, ModelIgnoreFlags.Nothing)).toBe(true);
    expect(tree.isInLineOfSight(995, 2005, 32, 995, 2005, 32, 1, ModelIgnoreFlags.Nothing)).toBe(true);
    // other phase
    expect(tree.isInLineOfSight(995, 2005, 32, 980, 2005, 32, 2, ModelIgnoreFlags.Nothing)).toBe(true);
    expect(tree.getHeight(995, 2005, 32, 10, 2)).toBe(-Infinity);
    // despawned
    owner.spawned = false;
    expect(tree.isInLineOfSight(995, 2005, 32, 980, 2005, 32, 1, ModelIgnoreFlags.Nothing)).toBe(true);
    owner.spawned = true;
    // disabled collision
    house.disable();
    expect(house.isEnabled()).toBe(false);
    expect(tree.isInLineOfSight(995, 2005, 32, 980, 2005, 32, 1, ModelIgnoreFlags.Nothing)).toBe(true);
    house.enable(1);

    const hit = new Vector3();
    expect(tree.GetObjectHitPos(1, new Vector3(995, 2005, 32), new Vector3(980, 2005, 32), hit, -0.5)).toBe(true);
    expect(hit.x).toBeCloseTo(990.5, 3);
    expect(tree.GetObjectHitPos(1, new Vector3(985, 1990, 32), new Vector3(985, 2030, 32), hit, 0)).toBe(false);
    expect(hit.equals(new Vector3(985, 2030, 32))).toBe(true);

    tree.remove(house);
    expect(tree.contains(house)).toBe(false);
    expect(tree.size()).toBe(0);
    expect(tree.isInLineOfSight(995, 2005, 32, 980, 2005, 32, 1, ModelIgnoreFlags.Nothing)).toBe(true);
  });

  test("M2 game objects are ignored on request", () => {
    const tree = new DynamicMapTree();
    const crate = GameObjectModel.Create(new TestOwner(CRATE_DISPLAY, new Vector3(500, 500, 0), 0, 2), dataPath)!;
    tree.insert(crate);
    tree.balance();
    expect(tree.isInLineOfSight(495, 501, 1, 505, 501, 1, 1, ModelIgnoreFlags.Nothing)).toBe(false);
    expect(tree.isInLineOfSight(495, 501, 1, 505, 501, 1, 1, ModelIgnoreFlags.M2)).toBe(true);
    expect(tree.getHeight(501, 501, 10, 20, 1)).toBeCloseTo(2, 4);
    // M2s have no area info
    const data = new AreaAndLiquidData();
    expect(tree.GetAreaAndLiquidData(501, 501, 1, 1, null, data)).toBe(false);
  });

  test("a long ray crosses grid cells", () => {
    const tree = new DynamicMapTree();
    // two crates in different 533 yard cells
    tree.insert(GameObjectModel.Create(new TestOwner(CRATE_DISPLAY, new Vector3(100, 0, 0), 0, 2), dataPath)!);
    tree.insert(GameObjectModel.Create(new TestOwner(CRATE_DISPLAY, new Vector3(1300, 0, 0), 0, 2), dataPath)!);
    expect(tree.isInLineOfSight(-200, 1, 1, 2000, 1, 1, 1, ModelIgnoreFlags.Nothing)).toBe(false);
    const hit = new Vector3();
    expect(tree.GetObjectHitPos(1, new Vector3(2000, 1, 1), new Vector3(-200, 1, 1), hit, 0)).toBe(true);
    expect(hit.x).toBeCloseTo(1302, 3);
    expect(tree.GetObjectHitPos(1, new Vector3(1200, 1, 1), new Vector3(-200, 1, 1), hit, 0)).toBe(true);
    expect(hit.x).toBeCloseTo(102, 3);
  });

  test("area and liquid data", () => {
    const tree = new DynamicMapTree();
    const owner = houseOwner();
    tree.insert(GameObjectModel.Create(owner, dataPath)!);
    const data = new AreaAndLiquidData();
    expect(tree.GetAreaAndLiquidData(995, 2005, 32, 1, null, data)).toBe(true);
    expect(data.floorZ).toBeCloseTo(30, 3);
    expect(data.areaInfo).not.toBeNull();
    expect(data.areaInfo!.groupId).toBe(HOUSE_GROUP_ID);
    expect(data.areaInfo!.rootId).toBe(HOUSE_ROOT_WMO_ID);
    expect(data.areaInfo!.mogpFlags).toBe(HOUSE_MOGP);
    expect(data.areaInfo!.adtId).toBe(0);
    expect(data.liquidInfo!.type).toBe(HOUSE_LIQUID_TYPE);
    expect(data.liquidInfo!.level).toBeCloseTo(31, 3);

    // a liquid type filter goes through VMapMgr2::GetLiquidFlagsPtr
    const mgr = VMapFactory.createOrGetVMapMgr();
    const previous = mgr.GetLiquidFlagsPtr;
    try {
      mgr.GetLiquidFlagsPtr = (type) => (type === HOUSE_LIQUID_TYPE ? 0x4 : 0);
      data.reset();
      expect(tree.GetAreaAndLiquidData(995, 2005, 32, 1, 0x1, data)).toBe(true);
      expect(data.liquidInfo).toBeNull();
      expect(data.areaInfo).not.toBeNull();
      data.reset();
      expect(tree.GetAreaAndLiquidData(995, 2005, 32, 1, 0x4, data)).toBe(true);
      expect(data.liquidInfo!.level).toBeCloseTo(31, 3);
    } finally {
      mgr.GetLiquidFlagsPtr = previous;
    }

    // transports never give area info
    owner.transport = true;
    data.reset();
    expect(tree.GetAreaAndLiquidData(995, 2005, 32, 1, null, data)).toBe(false);
    expect(data.areaInfo).toBeNull();
  });

  test("moving a game object: remove, UpdatePosition, insert; update() rebalances", () => {
    const tree = new DynamicMapTree();
    const owner = new TestOwner(CRATE_DISPLAY, new Vector3(0, 0, 0), 0, 1);
    const crate = GameObjectModel.Create(owner, dataPath)!;
    tree.insert(crate);
    tree.update(250);
    expect(tree.getHeight(0.5, 0.5, 5, 10, 1)).toBeCloseTo(1, 4);

    tree.remove(crate);
    owner.pos = new Vector3(50, 50, 10);
    expect(crate.UpdatePosition()).toBe(true);
    tree.insert(crate);
    tree.update(250);
    expect(tree.getHeight(0.5, 0.5, 5, 10, 1)).toBe(-Infinity);
    expect(tree.getHeight(50.5, 50.5, 20, 20, 1)).toBeCloseTo(11, 4);
    expect(crate.GetPosition().equals(new Vector3(50, 50, 10))).toBe(true);
  });
});
