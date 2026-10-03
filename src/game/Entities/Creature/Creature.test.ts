import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import type { CreatureUnit } from "../../../combat/combat-world.ts";
import { UNIT_END, UNIT_FIELD_HEALTH, UNIT_NPC_EMOTESTATE } from "../../../gen/UpdateFields.gen.ts";
import { sObjectMgr } from "../../Globals/ObjectMgr.ts";
import { addCreatureTemplates, addRows, creatureRow, fakeSpawnMap, loadSpawnFixture, worldSchema as w } from "../../Maps/SpawnData.test-util.ts";
import { SPAWNGROUP_FLAG_COMPATIBILITY_MODE } from "../../Maps/SpawnData.ts";
import { getGameTime } from "../../time/game-time.ts";
import { VisibilityDistanceType } from "../Object/ObjectDefines.ts";
import { HighGuid, ObjectGuid, TYPEID_UNIT, TYPEMASK_UNIT } from "../Object/ObjectGuid.ts";
import { Creature, DeathState, IDLE_MOTION_TYPE, RANDOM_MOTION_TYPE } from "./Creature.ts";

beforeAll(() => {
  const rows = new Map<MySqlTable, Record<string, unknown>[]>();
  addCreatureTemplates(rows, 100, 101, 102);
  addRows(rows, w.creature_template, { entry: 103, name: "rare elite", minlevel: 60, maxlevel: 62, rank: 2, flags_extra: 0x400, difficulty_entry_1: 104 });
  addRows(rows, w.creature_template_model, { CreatureID: 103, Idx: 0, CreatureDisplayID: 7, DisplayScale: 1, Probability: 1 });
  addRows(rows, w.creature_template, { entry: 104, name: "heroic version", minlevel: 80, maxlevel: 80 });
  addRows(rows, w.creature_template_model, { CreatureID: 104, Idx: 0, CreatureDisplayID: 8, DisplayScale: 1, Probability: 1 });
  addRows(rows, w.creature_equip_template, { CreatureID: 100, ID: 1, ItemID1: 1001, ItemID2: 1002, ItemID3: 0 });
  addRows(
    rows,
    w.creature,
    creatureRow(1, 100, 0, -10, -20, { spawntimesecs: 300, MovementType: 1, wander_distance: 5, curhealth: 42, equipment_id: 1 }),
    creatureRow(2, 101, 0, -11, -21),
    creatureRow(3, 102, 0, -12, -22),
    creatureRow(4, 103, 33, -13, -23, { spawnMask: 3 }),
    creatureRow(5, 100, 0, -14, -24, { spawntimesecs: 300 }),
  );
  addRows(rows, w.creature_addon, { guid: 2, path_id: 7, mount: 0, bytes1: 0, bytes2: 1, emote: 0, visibilityDistanceType: VisibilityDistanceType.Large, auras: null });
  addRows(rows, w.spawn_group_template, { groupId: 0, groupName: "Default Group", groupFlags: 1 }, { groupId: 1, groupName: "Legacy Group", groupFlags: 3 }, { groupId: 5, groupName: "dynamic", groupFlags: 0 });
  addRows(rows, w.spawn_group, { groupId: 5, spawnType: 0, spawnId: 3 }, { groupId: 1, spawnType: 0, spawnId: 5 });
  loadSpawnFixture(rows);
});

afterAll(() => sObjectMgr.setWorld(null, null));

describe("Creature", () => {
  test("constructor: unit type, values, sight distance, alive", () => {
    const creature = new Creature();
    expect(creature.getTypeId()).toBe(TYPEID_UNIT);
    expect(creature.isType(TYPEMASK_UNIT)).toBe(true);
    expect(creature.getValuesCount()).toBe(UNIT_END);
    expect(creature.isAlive()).toBe(true);
    expect(creature.getSpawnId()).toBe(0);
    expect(creature.getRespawnDelay()).toBe(300);
    expect(creature.getCorpseDelay()).toBe(60);
    expect(creature.m_SightDistance).toBeGreaterThan(0);
    expect(creature.isInWorld()).toBe(false);
  });

  test("LoadFromDB builds the creature from its spawn data without adding it to the map", () => {
    const map = fakeSpawnMap(0);
    const creature = new Creature();
    expect(creature.loadFromDB(1, map)).toBe(true);
    expect(creature.isInWorld()).toBe(false);
    expect(creature.getSpawnId()).toBe(1);
    expect(creature.getCreatureData()).toBe(sObjectMgr.getSpawnCreatureData(1)!);
    expect(creature.getCreatureTemplate()?.entry).toBe(100);
    expect(creature.getEntry()).toBe(100);
    expect(creature.getGUID()).toBe(ObjectGuid.Create(HighGuid.Unit, 100, 1));
    expect([creature.getPositionX(), creature.getPositionY(), creature.getPositionZ()]).toEqual([-10, -20, 10]);
    expect(creature.getHomePosition().getPositionX()).toBe(-10);
    expect(creature.getRespawnDelay()).toBe(300);
    expect(creature.getWanderDistance()).toBe(5);
    expect(creature.getDefaultMovementType()).toBe(RANDOM_MOTION_TYPE);
    expect(creature.getPhaseMask()).toBe(1);
    expect(creature.getMap()).toBe(map);
    expect(creature.getLevel()).toBe(10);
    expect(creature.getCurrentEquipmentId()).toBe(1);
    // group 0 ("Default Group") has no COMPATIBILITY_MODE flag: only Respawn.ForceCompatibilityMode (off) turns it on
    expect(creature.isRespawnCompatibilityMode()).toBe(false);
    expect(creature.getRespawnPosition()).toEqual({ x: -10, y: -20, z: 10, o: 1, dist: 5 });
  });

  test("LoadCreatureFromDB adds it to the map and the stores; a second alive copy is refused", () => {
    const map = fakeSpawnMap(0);
    const creature = new Creature();
    expect(creature.loadCreatureFromDB(1, map)).toBe(true);
    expect(creature.isInWorld()).toBe(true);
    expect(map.added).toEqual([creature]);
    expect(map.objects.get(creature.getGUID())).toBe(creature);
    expect(map.getCreatureBySpawnIdStore().get(1)).toEqual([creature]);
    expect(creature.getZoneId()).toBe(12);

    expect(new Creature().loadCreatureFromDB(1, map)).toBe(false);

    creature.removeFromWorld();
    expect(creature.isInWorld()).toBe(false);
    expect(map.objects.size).toBe(0);
    expect(map.getCreatureBySpawnIdStore().get(1)).toBeUndefined();
  });

  test("a dead copy is despawned and a stored respawn time loads the creature dead", () => {
    const map = fakeSpawnMap(0, 0, { respawnTimes: new Map([[3, getGameTime() + 600]]) });
    const first = new Creature();
    expect(first.loadCreatureFromDB(3, map)).toBe(true);
    expect(first.getDeathState()).toBe(DeathState.Dead);
    expect(first.getUInt32Value(UNIT_FIELD_HEALTH)).toBe(0);
    expect(first.getRespawnTime()).toBeGreaterThan(getGameTime());
    expect(first.isRespawnCompatibilityMode()).toBe(false); // spawn group 5 has no COMPATIBILITY_MODE flag
    expect(sObjectMgr.getSpawnGroupData(5)!.flags & SPAWNGROUP_FLAG_COMPATIBILITY_MODE).toBe(0);

    const second = new Creature();
    expect(second.loadCreatureFromDB(3, map)).toBe(true);
    expect(map.removeList).toEqual([first]);
  });

  test("addon: visibility distance override, path, emote, bytes2", () => {
    const creature = new Creature();
    expect(creature.loadCreatureFromDB(2, fakeSpawnMap(0))).toBe(true);
    expect(creature.getVisibilityOverrideType()).toBe(VisibilityDistanceType.Large);
    expect(creature.isFarVisible()).toBe(true);
    expect(creature.getWaypointPath()).toBe(7);
    expect(creature.getUInt32Value(UNIT_NPC_EMOTESTATE)).toBe(0);
  });

  test("difficulty entry, rank corpse decay, and ghost visibility from the template", () => {
    const creature = new Creature();
    expect(creature.loadFromDB(4, fakeSpawnMap(33, 1, { dungeon: true }))).toBe(true);
    expect(creature.getEntry()).toBe(103); // normal entry always
    expect(creature.getCreatureTemplate()?.entry).toBe(104); // map mode related
    expect(creature.getName()).toBe("rare elite");
    expect(creature.getLevel()).toBe(80);
    expect(creature.m_serverSideVisibility.getValue(1)).toBe(2); // GHOST_VISIBILITY_GHOST
  });

  test("death, corpse removal, and respawn in compatibility mode (legacy spawn group)", () => {
    const map = fakeSpawnMap(0, 0, { dungeon: true });
    const creature = new Creature();
    expect(creature.loadCreatureFromDB(5, map)).toBe(true);
    expect(creature.isRespawnCompatibilityMode()).toBe(true);
    creature.setDeathState(DeathState.JustDied);
    expect(creature.getDeathState()).toBe(DeathState.Corpse);
    expect(creature.isDead()).toBe(true);
    expect(creature.getRespawnTime()).toBe(getGameTime() + 300 + creature.getCorpseDelay());
    expect(map.respawnTimes.get(5)).toBe(creature.getRespawnTime()); // dungeon: saved at death
    expect(creature.isInvisibleDueToDespawn()).toBe(false); // corpse still shown

    creature.removeCorpse(true);
    expect(creature.getDeathState()).toBe(DeathState.Dead);
    expect(creature.getRespawnTime()).toBe(getGameTime() + 300);
    expect(creature.isInvisibleDueToDespawn()).toBe(true);

    creature.respawn();
    expect(creature.isAlive()).toBe(true);
    expect(creature.getRespawnTime()).toBe(0);
    expect(map.respawnTimes.has(5)).toBe(false);
  });

  test("Update: a corpse is removed when its time is over, then the dead creature respawns when its time is over", () => {
    const map = fakeSpawnMap(0, 0, { dungeon: true });
    const creature = new Creature();
    expect(creature.loadCreatureFromDB(5, map)).toBe(true);
    creature.update(100);
    expect(creature.isAlive()).toBe(true);

    creature.setDeathState(DeathState.JustDied);
    creature.update(100); // corpse stays until m_corpseRemoveTime
    expect(creature.getDeathState()).toBe(DeathState.Corpse);

    creature.setCorpseRemoveTime(-1);
    creature.update(100); // Creature::RemoveCorpse(false): compatibility mode keeps it as a dead body
    expect(creature.getDeathState()).toBe(DeathState.Dead);
    expect(creature.getRespawnTime()).toBeGreaterThan(getGameTime());

    creature.update(100); // respawn time not over
    expect(creature.getDeathState()).toBe(DeathState.Dead);

    creature.setRespawnTime(0);
    creature.update(100);
    expect(creature.isAlive()).toBe(true);
    expect(creature.getRespawnTime()).toBe(0);
  });

  test("dynamic spawn mode: corpse removal saves the respawn time and removes the creature", () => {
    const map = fakeSpawnMap(0);
    const creature = new Creature();
    expect(creature.loadCreatureFromDB(1, map)).toBe(true);
    expect(creature.isRespawnCompatibilityMode()).toBe(false);
    creature.setDeathState(DeathState.JustDied);
    creature.removeCorpse(true);
    expect(creature.getDeathState()).toBe(DeathState.Corpse);
    expect(map.respawnTimes.get(1)).toBe(getGameTime() + 300 + creature.getCorpseDelay());
    expect(map.removeList).toEqual([creature]);
  });

  test("SetRespawnTime and GetRespawnTimeEx", () => {
    const creature = new Creature();
    creature.setRespawnTime(30);
    expect(creature.getRespawnTime()).toBe(getGameTime() + 30);
    expect(creature.getRespawnTimeEx()).toBe(getGameTime() + 30);
    creature.setRespawnTime(0);
    expect(creature.getRespawnTime()).toBe(0);
    expect(creature.getRespawnTimeEx()).toBe(getGameTime());
  });

  test("the combat unit link drives the death state and health", () => {
    const creature = new Creature();
    expect(creature.loadFromDB(1, fakeSpawnMap(0))).toBe(true);
    const unit = { deathState: "corpse", health: 0 } as unknown as CreatureUnit;
    creature.m_combatUnit = unit;
    expect(creature.isAlive()).toBe(false);
    expect(creature.getDeathState()).toBe(DeathState.Corpse);
    unit.deathState = "alive";
    unit.health = 17;
    expect(creature.isAlive()).toBe(true);
    expect(creature.getHealth()).toBe(17);
    creature.setDeathState(DeathState.JustDied);
    expect(unit.deathState as string).toBe("corpse");
  });

  test("GetRandomId picks among the multispawn entries", () => {
    const creature = new Creature();
    expect(creature.getRandomId(5, 0, 0)).toBe(5);
    const seen = new Set<number>();
    for (let i = 0; i < 200; ++i) seen.add(creature.getRandomId(5, 6, 7));
    expect([...seen].sort()).toEqual([5, 6, 7]);
  });

  test("UnitLike members over the creature state", () => {
    const creature = new Creature();
    expect(creature.loadFromDB(1, fakeSpawnMap(0))).toBe(true);
    expect(creature.getHoverHeight()).toBe(0);
    expect(creature.canFly()).toBe(false);
    expect(creature.isInWater()).toBe(false);
    expect(creature.getSpeed(1)).toBeCloseTo(1.14286 * 7.0, 4);
    expect(creature.isCharmedOwnedByPlayerOrPlayer()).toBe(false);
    expect(creature.getAttackDistance(null)).toBe(0);
    expect(creature.getDefaultMovementType()).not.toBe(IDLE_MOTION_TYPE);
  });
});
