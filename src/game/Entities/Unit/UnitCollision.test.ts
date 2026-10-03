import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sCreatureDisplayInfoStore, sCreatureModelDataStore } from "../../DataStores/DBCStores.ts";
import { DEFAULT_COLLISION_HEIGHT } from "../Object/ObjectDefines.ts";
import { GetCollisionHeight } from "./UnitCollision.ts";

const DISPLAY = 990001;
const MOUNT = 990002;

beforeEach(() => {
  sCreatureModelDataStore.set(7001, { Id: 7001, Flags: 0, Scale: 1.2, CollisionWidth: 1, CollisionHeight: 2, MountHeight: 0 });
  sCreatureModelDataStore.set(7002, { Id: 7002, Flags: 0, Scale: 1, CollisionWidth: 1, CollisionHeight: 3, MountHeight: 1.5 });
  sCreatureDisplayInfoStore.set(DISPLAY, { Displayid: DISPLAY, ModelId: 7001, ExtendedDisplayInfoID: 0, scale: 0.5 });
  sCreatureDisplayInfoStore.set(MOUNT, { Displayid: MOUNT, ModelId: 7002, ExtendedDisplayInfoID: 0, scale: 1 });
});

afterEach(() => {
  // the stores are global: leave no rows behind that another test could read
  sCreatureDisplayInfoStore.set(DISPLAY, undefined as never);
  sCreatureDisplayInfoStore.set(MOUNT, undefined as never);
});

describe("Unit::GetCollisionHeight", () => {
  test("model height times the model scale, the display scale, and the object scale", () => {
    expect(GetCollisionHeight({ scale: 2, nativeDisplayId: DISPLAY, mountDisplayId: 0 })).toBeCloseTo(2 * 2 * 1.2 * 0.5, 5);
  });

  test("mounted: the mount height plus half the rider's height", () => {
    // scaleMod * (MountHeight + CollisionHeight * Scale * displayScale * 0.5)
    expect(GetCollisionHeight({ scale: 1, nativeDisplayId: DISPLAY, mountDisplayId: MOUNT })).toBeCloseTo(1.5 + 2 * 1.2 * 0.5 * 0.5, 5);
  });

  test("a mount without model data, or no model at all, has the default height", () => {
    expect(GetCollisionHeight({ scale: 1, nativeDisplayId: DISPLAY, mountDisplayId: 123456 })).toBeCloseTo(DEFAULT_COLLISION_HEIGHT, 5);
    expect(GetCollisionHeight({ scale: 1.5, nativeDisplayId: 424242, mountDisplayId: 0 })).toBeCloseTo(DEFAULT_COLLISION_HEIGHT * 1.5, 5);
  });
});
