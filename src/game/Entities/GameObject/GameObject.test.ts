import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { GAMEOBJECT_END } from "../../../gen/UpdateFields.gen.ts";
import { sObjectMgr } from "../../Globals/ObjectMgr.ts";
import { addRows, fakeSpawnMap, gameObjectRow, loadSpawnFixture, worldSchema as w } from "../../Maps/SpawnData.test-util.ts";
import { getGameTime } from "../../time/game-time.ts";
import { VisibilityDistanceType } from "../Object/ObjectDefines.ts";
import { HighGuid, ObjectGuid, TYPEID_GAMEOBJECT } from "../Object/ObjectGuid.ts";
import { Position } from "../Object/Position.ts";
import {
  GAMEOBJECT_TYPE_DOOR,
  GAMEOBJECT_TYPE_GENERIC,
  GAMEOBJECT_TYPE_GOOBER,
  GAMEOBJECT_TYPE_SPELL_FOCUS,
  GameObject,
  GO_ACTIVATED,
  GO_FLAG_IN_USE,
  GO_FLAG_NODESPAWN,
  GO_JUST_DEACTIVATED,
  GO_NOT_READY,
  GO_READY,
  GO_STATE_ACTIVE,
  GO_STATE_READY,
} from "./GameObject.ts";

beforeAll(() => {
  const rows = new Map<MySqlTable, Record<string, unknown>[]>();
  addRows(
    rows,
    w.gameobject_template,
    { entry: 500, type: GAMEOBJECT_TYPE_GENERIC, displayId: 100, name: "large generic", size: 2, Data3: 1 },
    { entry: 501, type: GAMEOBJECT_TYPE_GOOBER, displayId: 100, name: "consumable goober", size: 1, Data5: 1 },
    { entry: 502, type: GAMEOBJECT_TYPE_DOOR, displayId: 100, name: "door", size: 1, Data3: 0 },
    { entry: 503, type: GAMEOBJECT_TYPE_SPELL_FOCUS, displayId: 0, name: "server only focus", size: 1, Data3: 1 },
  );
  addRows(
    rows,
    w.gameobject,
    gameObjectRow(1, 500, 0, -10, -10, { orientation: Math.PI / 2, rotation2: Math.SQRT1_2, rotation3: Math.SQRT1_2 }),
    gameObjectRow(2, 501, 0, -20, -20, { spawntimesecs: 60 }),
    gameObjectRow(3, 501, 0, -30, -30, { spawntimesecs: -90 }),
    gameObjectRow(4, 502, 0, -40, -40, { state: 0 }),
    gameObjectRow(5, 503, 0, -50, -50),
  );
  addRows(rows, w.gameobject_template_addon, { entry: 500, faction: 35, flags: 0x10, mingold: 0, maxgold: 0, artkit0: 0, artkit1: 0, artkit2: 0, artkit3: 0 });
  addRows(rows, w.gameobject_addon, { guid: 2, parent_rotation0: 0, parent_rotation1: 0, parent_rotation2: 0, parent_rotation3: 1, invisibilityType: 3, invisibilityValue: 50 });
  loadSpawnFixture(rows);
});

afterAll(() => sObjectMgr.setWorld(null, null));

describe("GameObject", () => {
  test("LoadFromDB: identity, position, template, state, large visibility", () => {
    const map = fakeSpawnMap(0);
    const go = new GameObject();
    expect(go.getTypeId()).toBe(TYPEID_GAMEOBJECT);
    expect(go.getValuesCount()).toBe(GAMEOBJECT_END);
    expect(go.loadFromDB(1, map)).toBe(true);
    expect(go.isInWorld()).toBe(false);
    expect(go.getSpawnId()).toBe(1);
    expect(go.getGUID()).toBe(ObjectGuid.Create(HighGuid.GameObject, 500, 1));
    expect(go.getGOInfo()?.entry).toBe(500);
    expect(go.getGameObjectData()).toBe(sObjectMgr.getSpawnGameObjectData(1)!);
    expect(go.getGoType()).toBe(GAMEOBJECT_TYPE_GENERIC);
    expect(go.getGoState()).toBe(GO_STATE_READY);
    expect(go.getGoAnimProgress()).toBe(100);
    expect(go.getDisplayId()).toBe(100);
    expect(go.getObjectScale()).toBe(2);
    expect([go.getStationaryX(), go.getStationaryY()]).toEqual([-10, -10]);
    expect(go.getVisibilityOverrideType()).toBe(VisibilityDistanceType.Large); // _generic.large
    // GetDespawnPossibility() is true for generic objects: they keep the respawn timer
    expect(go.hasGameObjectFlag(GO_FLAG_NODESPAWN)).toBe(false);
    expect(go.getRespawnDelay()).toBe(300);
    expect(go.isSpawned()).toBe(true);
  });

  test("world rotation: unitized and packed", () => {
    const go = new GameObject();
    expect(go.loadFromDB(1, fakeSpawnMap(0))).toBe(true);
    const rotation = go.getWorldRotation();
    expect(rotation.z).toBeCloseTo(Math.SQRT1_2, 6);
    expect(rotation.w).toBeCloseTo(Math.SQRT1_2, 6);
    // z * (1 << 20) packed in the low 21 bits
    expect(Number(go.getPackedWorldRotation() & 0x1fffffn)).toBe(Math.trunc(Math.fround(Math.fround(Math.SQRT1_2) * (1 << 20))));
    go.setWorldRotation({ x: 0, y: 0, z: 0, w: 0 }); // zero quaternion: rotation around Z from the orientation
    expect(go.getWorldRotation().z).toBeCloseTo(Math.sin(Math.PI / 4), 6);
  });

  test("LoadGameObjectFromDB adds it to the map and the stores; addon invisibility", () => {
    const map = fakeSpawnMap(0);
    const go = new GameObject();
    expect(go.loadGameObjectFromDB(2, map)).toBe(true);
    expect(go.isInWorld()).toBe(true);
    expect(map.objects.get(go.getGUID())).toBe(go);
    expect(map.getGameObjectBySpawnIdStore().get(2)).toEqual([go]);
    expect(go.m_invisibility.getValue(3)).toBe(50);
    expect(go.getRespawnDelay()).toBe(60);
    go.removeFromWorld();
    expect(map.objects.size).toBe(0);
    expect(map.getGameObjectBySpawnIdStore().get(2)).toBeUndefined();
  });

  test("respawn timers: stored time, despawn, and respawn", () => {
    const map = fakeSpawnMap(0, 0, { goRespawnTimes: new Map([[2, getGameTime() + 100]]) });
    const go = new GameObject();
    expect(go.loadFromDB(2, map)).toBe(true);
    expect(go.getRespawnTime()).toBe(getGameTime() + 100);
    expect(go.isSpawned()).toBe(false);
    expect(go.isInvisibleDueToDespawn()).toBe(true);
    go.respawn();
    expect(go.getRespawnTime()).toBe(getGameTime());
    expect(map.goRespawnTimes.has(2)).toBe(false);

    // a stored time in the past is cleared at load
    const past = fakeSpawnMap(0, 0, { goRespawnTimes: new Map([[2, getGameTime() - 1]]) });
    const again = new GameObject();
    expect(again.loadFromDB(2, past)).toBe(true);
    expect(again.getRespawnTime()).toBe(0);
    expect(past.goRespawnTimes.has(2)).toBe(false);

    again.despawnOrUnsummon();
    expect(again.getRespawnTime()).toBe(getGameTime() + 60);
    expect(again.isSpawned()).toBe(false);
  });

  test("negative spawntimesecs: not spawned by default", () => {
    const go = new GameObject();
    expect(go.loadFromDB(3, fakeSpawnMap(0))).toBe(true);
    expect(go.isSpawnedByDefault()).toBe(false);
    expect(go.getRespawnDelay()).toBe(90);
    expect(go.isSpawned()).toBe(false);
  });

  test("doors are infinite-visibility; a server-only spell focus is never visible", () => {
    const door = new GameObject();
    expect(door.loadFromDB(4, fakeSpawnMap(0))).toBe(true);
    expect(door.getVisibilityOverrideType()).toBe(VisibilityDistanceType.Infinite);
    expect(door.getGoState()).toBe(0);
    // a door that is damage immune (noDamageImmune 0) and not consumable never despawns
    expect(door.hasGameObjectFlag(GO_FLAG_NODESPAWN)).toBe(true);
    expect(door.getRespawnDelay()).toBe(0);
    const focus = new GameObject();
    expect(focus.loadFromDB(5, fakeSpawnMap(0))).toBe(true);
    expect(focus.isNeverVisible()).toBe(true);
  });

  test("IsInRange2d / IsInRange3d use the display box; the WorldObject overloads still work", () => {
    const go = new GameObject();
    expect(go.loadFromDB(4, fakeSpawnMap(0))).toBe(true); // at (-40, -40, 5); box -1..1 (x, y), 0..2 (z), scale 1
    expect(go.isInRange3d(-40, -40.5, 6, 0.1)).toBe(true);
    expect(go.isInRange3d(-40, -42, 6, 0.5)).toBe(false);
    expect(go.isInRange3d(-40, -42, 6, 1.5)).toBe(true);
    expect(go.isInRange3d(-40, -40.5, 10, 1)).toBe(false); // above the box (dz 5 > maxZ 2 + radius 1)
    // C++ returns true as soon as the 2d distance is 0 (before the z check), so straight above the origin is "in range"
    expect(go.isInRange3d(-40, -40, 10, 1)).toBe(true);
    expect(go.isInRange2d(-40, -42, 1.5)).toBe(true);
    expect(go.isInRange3d(-40, -42, 6, 0, 5)).toBe(true); // WorldObject::IsInRange3d(x, y, z, min, max)
    expect(go.isWithinSightRange(new Position(-40, -60, 0, 0), 10)).toBe(false);
  });

  test("gameobject_template_addon: faction and flags at Create, flags restored at despawn", () => {
    expect(sObjectMgr.getGameObjectTemplateAddon(500)).toEqual({ entry: 500, faction: 35, flags: 0x10, mingold: 0, maxgold: 0, artKits: [0, 0, 0, 0] });
    expect(sObjectMgr.getGameObjectTemplateAddon(501)).toBeNull();
    const go = new GameObject();
    expect(go.loadFromDB(1, fakeSpawnMap(0))).toBe(true);
    expect(go.getFaction()).toBe(35);
    expect(go.getGameObjectFlags()).toBe(0x10);
    go.setGameObjectFlag(0x4);
    go.despawnOrUnsummon();
    expect(go.getGameObjectFlags()).toBe(0x10);
    expect(go.getTemplateAddon()?.entry).toBe(500);
  });

  test("Update: ready, despawn, deactivate, and respawn back onto the map", () => {
    const map = fakeSpawnMap(0);
    const go = new GameObject();
    expect(go.loadGameObjectFromDB(1, map)).toBe(true);
    expect(go.getLootState()).toBe(GO_NOT_READY);
    go.update(100); // a plain object is ready at once
    expect(go.getLootState()).toBe(GO_READY);
    expect(go.isSpawned()).toBe(true);

    go.despawnOrUnsummon();
    expect(go.getLootState()).toBe(GO_JUST_DEACTIVATED);
    expect(go.getRespawnTime()).toBe(getGameTime() + 300);
    go.update(100); // GO_JUST_DEACTIVATED: back to ready, the respawn timer runs
    expect(go.getLootState()).toBe(GO_READY);
    expect(go.getRespawnTime()).toBe(getGameTime() + 300);
    expect(go.isSpawned()).toBe(false);
    expect(map.added.filter((o) => o === go)).toHaveLength(1);

    go.update(100); // timer not expired
    expect(go.isSpawned()).toBe(false);
    go.respawn(); // timer expires now
    go.update(100);
    expect(go.getRespawnTime()).toBe(0);
    expect(go.isSpawned()).toBe(true);
    expect(map.added.filter((o) => o === go)).toHaveLength(2); // Map::AddToMap again
  });

  test("Update: a delayed despawn runs when the delay is spent; a non-consumable goober returns to ready", () => {
    const go = new GameObject();
    expect(go.loadFromDB(1, fakeSpawnMap(0))).toBe(true);
    go.update(0);
    go.despawnOrUnsummon(500);
    expect(go.getLootState()).toBe(GO_READY);
    go.update(400);
    expect(go.getLootState()).toBe(GO_READY);
    go.update(100); // DespawnOrUnsummon(0), then GO_JUST_DEACTIVATED -> GO_READY in the same tick
    expect(go.getLootState()).toBe(GO_READY);
    expect(go.isSpawned()).toBe(false);
    expect(go.getRespawnTime()).toBe(getGameTime() + 300);

    const goober = new GameObject();
    expect(goober.loadFromDB(2, fakeSpawnMap(0))).toBe(true); // goober.consumable 1: despawns at action
    goober.update(0);
    goober.setLootState(GO_JUST_DEACTIVATED);
    goober.update(0);
    expect(goober.getLootState()).toBe(GO_READY);
    expect(goober.getGoState()).toBe(GO_STATE_READY);
  });

  test("UseDoorOrButton opens a closed door; ResetDoorOrButton closes it again", () => {
    const door = new GameObject();
    expect(door.loadFromDB(4, fakeSpawnMap(0))).toBe(true);
    door.setGoState(GO_STATE_READY); // closed (the fixture row starts it open)
    door.update(0);
    expect(door.getLootState()).toBe(GO_READY);
    door.useDoorOrButton(1);
    expect(door.getLootState()).toBe(GO_ACTIVATED);
    expect(door.getGoState()).toBe(GO_STATE_ACTIVE);
    expect(door.hasGameObjectFlag(GO_FLAG_IN_USE)).toBe(true);
    door.update(0); // the template has no auto close time
    expect(door.getLootState()).toBe(GO_ACTIVATED);
    door.resetDoorOrButton();
    expect(door.getLootState()).toBe(GO_JUST_DEACTIVATED);
    expect(door.getGoState()).toBe(GO_STATE_READY);
    expect(door.hasGameObjectFlag(GO_FLAG_IN_USE)).toBe(false);
  });
});
