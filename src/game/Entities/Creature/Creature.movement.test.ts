/**
 * The movement members of `Creature` (`Unit.cpp` / `Creature.cpp`): the `MovementOwnerCreature` contract, the movement data
 * (`creature_template_movement`, `creature_movement_override`), `Creature::Update` running the spline and the `MotionMaster`,
 * the movement startup (`loadMovementData`), formations, and the death and respawn of the motion. Over a map without terrain
 * (the straight line paths of a map without nav mesh); `src/combat/creature-movement.data.test.ts` runs it over the real data.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { seedRandom } from "../../../common/random.ts";
import { makeTempDir } from "../../../common/Collision/test-fixtures.ts";
import { buildMapFile } from "../../Grids/GridTerrainData.test-util.ts";
import { clearSharedGridTerrainData } from "../../Grids/GridTerrainLoader.ts";
import { factionTemplate, joinWorld } from "../../../combat/combat.test-util.ts";
import { CombatWorld } from "../../../combat/combat-world.ts";
import { SMSG_MONSTER_MOVE } from "../../../combat/constants.ts";
import { FactionStore } from "../../../combat/faction.ts";
import { MOVEMENTFLAG_SPLINE_ENABLED } from "../Unit/UnitDefines.ts";
import { FORMATION_MOTION_TYPE, IDLE_MOTION_TYPE, RANDOM_MOTION_TYPE, WAYPOINT_MOTION_TYPE } from "../../Movement/MotionMaster.ts";
import type { MovementOwnerCreature } from "../../Movement/MovementOwner.ts";
import { sWaypointMgr } from "../../Movement/Waypoints/WaypointMgr.ts";
import { sObjectMgr } from "../../Globals/ObjectMgr.ts";
import { sMapMgr } from "../../Maps/MapMgr.ts";
import { loadMovementData } from "../../Maps/MapSetup.ts";
import { addRows, creatureRow, creatureTemplateRows, loadSpawnFixture, worldSchema as w } from "../../Maps/SpawnData.test-util.ts";
import { advanceMaps, setUpTestMapWorld, tearDownTestMapWorld } from "../../../world/map-world.test-util.ts";
import { mapCreatureLocator } from "../../../world/map-world.ts";
import { Creature } from "./Creature.ts";
import { CreatureChaseMovementType, CreatureFlightMovementType, CreatureGroundMovementType } from "./CreatureData.ts";
import { sFormationMgr } from "./CreatureGroups.ts";

// `Creature` has every member of `MovementOwnerCreature` the movement code calls, except the ones whose C++ return type is
// narrower than the grid layer's (`toUnit`, `toCreature`, `toPlayer`, `getMap`, `m_movementInfo`: `MovementOwner.ts`)
type NarrowedByTheOwnerInterface = "toUnit" | "toCreature" | "toPlayer" | "getMap" | "m_movementInfo" | "getAI" | "getUnit" | "getVictim" | "getCharmerOrOwner" | "getCharmerOrOwnerPlayerOrPlayerItself" | "getMovementTemplate" | "getCombatManager" | "getCreatureData";
type MissingMembers = Exclude<keyof MovementOwnerCreature, keyof Creature | NarrowedByTheOwnerInterface>;
const noMissingMembers: [MissingMembers] extends [never] ? true : MissingMembers = true;

const HOME = { x: 100, y: 100, z: 10 };

// grid (31, 31) of map 0 is flat ground at the height of `HOME`: the random generator needs terrain, there are no mmaps
// here (a straight line path)
const tmp = makeTempDir("creature-movement-test-");

beforeAll(async () => {
  const V9 = new Float32Array(129 * 129).fill(HOME.z);
  const V8 = new Float32Array(128 * 128).fill(HOME.z);
  await Bun.write(`${tmp.dir}/maps/0003131.map`, buildMapFile({ height: { V9, V8, encoding: "flat" } }));
  clearSharedGridTerrainData();
});

afterAll(() => {
  clearSharedGridTerrainData();
  tmp.cleanup();
});

function templateRows(rows: Map<MySqlTable, Record<string, unknown>[]>, entry: number, extra: Record<string, unknown> = {}): void {
  const [template, model] = creatureTemplateRows(entry, { faction: 35, ...extra });
  addRows(rows, w.creature_template, template!);
  addRows(rows, w.creature_template_model, model!);
  addRows(rows, w.creature_model_info, { DisplayID: 1000 + entry, BoundingRadius: 0.4, CombatReach: 1.5, Gender: 2 });
}

function start(rows: Map<MySqlTable, Record<string, unknown>[]>, grid = true) {
  const { world, tables } = loadSpawnFixture(rows);
  setUpTestMapWorld(world, tmp.dir);
  loadMovementData();
  const map = sMapMgr().createBaseMap(0);
  if (grid) map.loadGrid(HOME.x, HOME.y);
  return { world, tables, map };
}

function creatureOf(spawnId: number): Creature {
  return mapCreatureLocator.findCreature(0, spawnId)!;
}

beforeEach(() => seedRandom(42));

afterEach(() => {
  tearDownTestMapWorld();
  sFormationMgr().CreatureGroupMap.clear();
  sFormationMgr().CreatureGroupMembers.clear();
});

test("the real Creature has the members of the movement owner contract", () => {
  expect(noMissingMembers).toBe(true);
});

describe("creature_template_movement and creature_movement_override", () => {
  test("a template without a row has the defaults the C++ join leaves (Swim and Rooted read false), a row overrides, an override wins per column", () => {
    const rows = new Map<MySqlTable, Record<string, unknown>[]>();
    templateRows(rows, 1000);
    templateRows(rows, 1001);
    templateRows(rows, 1002);
    addRows(rows, w.creature_template_movement, { CreatureId: 1001, Ground: CreatureGroundMovementType.Hover, Swim: 1, Flight: CreatureFlightMovementType.CanFly, Rooted: 0, Chase: CreatureChaseMovementType.CanWalk, Random: 1, InteractionPauseTimer: 7000 });
    // an override of spawn 3 (entry 1001) changes only Chase and Rooted, the rest comes from the template row (`COALESCE`)
    addRows(rows, w.creature_movement_override, { SpawnId: 3, Ground: null, Swim: null, Flight: null, Rooted: 1, Chase: CreatureChaseMovementType.AlwaysWalk, Random: null, InteractionPauseTimer: null });
    // a bad value is reset with an error, as `CheckCreatureMovement` does
    addRows(rows, w.creature_template_movement, { CreatureId: 1002, Ground: 9, Swim: 1, Flight: 9, Rooted: 0, Chase: 9, Random: 9, InteractionPauseTimer: 0 });
    addRows(rows, w.creature, creatureRow(1, 1000, 0, HOME.x, HOME.y), creatureRow(2, 1001, 0, HOME.x + 1, HOME.y), creatureRow(3, 1001, 0, HOME.x + 2, HOME.y), creatureRow(4, 1002, 0, HOME.x + 3, HOME.y));
    start(rows);

    const plain = creatureOf(1).getMovementTemplate();
    expect([plain.Ground, plain.Swim, plain.Flight, plain.Rooted, plain.Chase, plain.Random]).toEqual([CreatureGroundMovementType.Run, false, CreatureFlightMovementType.None, false, CreatureChaseMovementType.Run, 0]);
    expect(creatureOf(1).canWalk()).toBe(true);
    expect(creatureOf(1).canFly()).toBe(false);

    const fromRow = creatureOf(2);
    expect(fromRow.getMovementTemplate().Ground).toBe(CreatureGroundMovementType.Hover);
    expect(fromRow.canFly()).toBe(true);
    expect(fromRow.canHover()).toBe(true);
    expect(fromRow.getMovementTemplate().InteractionPauseTimer).toBe(7000);
    expect(fromRow.canEnterWater()).toBe(true);

    const overridden = creatureOf(3).getMovementTemplate();
    expect(overridden.Rooted).toBe(true);
    expect(overridden.Chase).toBe(CreatureChaseMovementType.AlwaysWalk);
    expect(overridden.Ground).toBe(CreatureGroundMovementType.Hover); // COALESCE(cmo.Ground, ctm.Ground)
    expect(overridden.Swim).toBe(true);
    expect(creatureOf(3).isRooted()).toBe(true);
    expect(sObjectMgr.getCreatureMovementOverride(3)?.Rooted).toBe(true);
    expect(sObjectMgr.getCreatureMovementOverride(1)).toBeNull();

    const reset = creatureOf(4).getMovementTemplate();
    expect([reset.Ground, reset.Flight, reset.Chase, reset.Random]).toEqual([CreatureGroundMovementType.Run, CreatureFlightMovementType.None, CreatureChaseMovementType.Run, 0]);
  });
});

describe("Creature::Update runs the spline and the motion master", () => {
  test("a wanderer starts its random generator in AddToWorld, moves within its wander distance, and the players around it get the splines", () => {
    const rows = new Map<MySqlTable, Record<string, unknown>[]>();
    templateRows(rows, 1000);
    addRows(rows, w.creature, creatureRow(1, 1000, 0, HOME.x, HOME.y, { MovementType: 1, wander_distance: 8 }));
    const { map } = start(rows);
    const wanderer = creatureOf(1);
    expect(wanderer.IsAIEnabled).toBe(true);
    expect(wanderer.getDefaultMovementType()).toBe(RANDOM_MOTION_TYPE);
    expect(wanderer.getMotionMaster().getCurrentMovementGeneratorType()).toBe(RANDOM_MOTION_TYPE);
    expect(wanderer.movespline.finalized()).toBe(true);

    const { session } = joinWorld(5, HOME.x - 20, HOME.y, HOME.z);
    let farthest = 0;
    let moves = 0;
    let lastX = wanderer.getPositionX();
    for (let t = 0; t < 60_000; t += 50) {
      advanceMaps(50, 50);
      farthest = Math.max(farthest, Math.hypot(wanderer.getPositionX() - HOME.x, wanderer.getPositionY() - HOME.y));
      if (wanderer.getPositionX() !== lastX) moves++;
      lastX = wanderer.getPositionX();
    }
    expect(map.getId()).toBe(0);
    expect(moves).toBeGreaterThan(20);
    expect(farthest).toBeGreaterThan(1);
    expect(farthest).toBeLessThanOrEqual(8 + 0.5);
    expect(session.count(SMSG_MONSTER_MOVE)).toBeGreaterThan(1);
  });

  test("a creature that is moving is in the update list and its create block (movement flags) carries the spline", () => {
    const rows = new Map<MySqlTable, Record<string, unknown>[]>();
    templateRows(rows, 1000);
    addRows(rows, w.creature, creatureRow(1, 1000, 0, HOME.x, HOME.y, { MovementType: 1, wander_distance: 8 }));
    start(rows);
    const wanderer = creatureOf(1);
    joinWorld(5, HOME.x - 20, HOME.y, HOME.z);
    for (let t = 0; t < 30_000 && wanderer.movespline.finalized(); t += 50) advanceMaps(50, 50);
    expect(wanderer.movespline.finalized()).toBe(false);
    expect(wanderer.getUnitMovementFlags() & MOVEMENTFLAG_SPLINE_ENABLED).toBeTruthy();
    expect(wanderer.isMoving()).toBe(true);
    expect(wanderer.isStopped()).toBe(false);
    expect(wanderer.isUpdateNeeded()).toBe(true);
    wanderer.stopMoving();
    expect(wanderer.movespline.finalized()).toBe(true);
    expect(wanderer.isStopped()).toBe(true);
    expect(wanderer.getUnitMovementFlags() & MOVEMENTFLAG_SPLINE_ENABLED).toBe(0);
  });
});

describe("movement startup", () => {
  test("loadMovementData loads the waypoint paths and the formations, and a creature takes its path from creature_addon", () => {
    const rows = new Map<MySqlTable, Record<string, unknown>[]>();
    templateRows(rows, 1000);
    addRows(rows, w.creature, creatureRow(1, 1000, 0, HOME.x, HOME.y, { MovementType: 2 }), creatureRow(2, 1000, 0, HOME.x + 3, HOME.y), creatureRow(3, 1000, 0, HOME.x + 6, HOME.y));
    addRows(rows, w.creature_addon, { guid: 1, path_id: 777, mount: 0, bytes1: 0, bytes2: 0, emote: 0, visibilityDistanceType: 0, auras: null });
    addRows(
      rows,
      w.waypoint_data,
      { id: 777, point: 1, position_x: HOME.x + 5, position_y: HOME.y, position_z: HOME.z, orientation: null, delay: 0, move_type: 0, action: 0, action_chance: 100, velocity: 0, smoothTransition: 0 },
      { id: 777, point: 2, position_x: HOME.x + 5, position_y: HOME.y + 5, position_z: HOME.z, orientation: null, delay: 0, move_type: 0, action: 0, action_chance: 100, velocity: 0, smoothTransition: 0 },
    );
    addRows(rows, w.creature_formations, { leaderGUID: 1, memberGUID: 1, dist: 0, angle: 0, groupAI: 515, point_1: 0, point_2: 0 }, { leaderGUID: 1, memberGUID: 2, dist: 3, angle: 180, groupAI: 515, point_1: 0, point_2: 0 });
    start(rows);
    expect(sWaypointMgr().getPath(777)?.Nodes).toHaveLength(2);
    expect(sFormationMgr().CreatureGroupMap.get(2)?.leaderGUID).toBe(1);
    const leader = creatureOf(1);
    const member = creatureOf(2);
    expect(leader.getWaypointPath()).toBe(777);
    expect(leader.getMotionMaster().getCurrentMovementGeneratorType()).toBe(WAYPOINT_MOTION_TYPE);
    // `Creature::SearchFormation` in `AddToWorld`
    expect(leader.getFormation()).not.toBeNull();
    expect(member.getFormation()).toBe(leader.getFormation());
    expect(leader.isFormationLeader()).toBe(true);
    expect(member.isFormationLeader()).toBe(false);
    expect(creatureOf(3).getFormation()).toBeNull();
  });

  test("the members of a formation follow their leader along its waypoint path", () => {
    const rows = new Map<MySqlTable, Record<string, unknown>[]>();
    templateRows(rows, 1000);
    addRows(rows, w.creature, creatureRow(1, 1000, 0, HOME.x, HOME.y, { MovementType: 2 }), creatureRow(2, 1000, 0, HOME.x - 3, HOME.y));
    addRows(rows, w.creature_addon, { guid: 1, path_id: 778, mount: 0, bytes1: 0, bytes2: 0, emote: 0, visibilityDistanceType: 0, auras: null });
    const node = (point: number, x: number, y: number) => ({ id: 778, point, position_x: x, position_y: y, position_z: HOME.z, orientation: null, delay: 0, move_type: 0, action: 0, action_chance: 100, velocity: 0, smoothTransition: 0 });
    addRows(rows, w.waypoint_data, node(1, HOME.x + 30, HOME.y), node(2, HOME.x + 30, HOME.y + 30), node(3, HOME.x, HOME.y + 30), node(4, HOME.x, HOME.y));
    addRows(rows, w.creature_formations, { leaderGUID: 1, memberGUID: 1, dist: 0, angle: 0, groupAI: 515, point_1: 0, point_2: 0 }, { leaderGUID: 1, memberGUID: 2, dist: 3, angle: 180, groupAI: 515, point_1: 0, point_2: 0 });
    start(rows);
    const leader = creatureOf(1);
    const member = creatureOf(2);
    joinWorld(5, HOME.x - 20, HOME.y, HOME.z);
    let followed = false;
    let closest = Infinity;
    let farthestLeader = 0;
    for (let t = 0; t < 20_000; t += 50) {
      advanceMaps(50, 50);
      if (member.getMotionMaster().getCurrentMovementGeneratorType() === FORMATION_MOTION_TYPE) followed = true;
      farthestLeader = Math.max(farthestLeader, Math.hypot(leader.getPositionX() - HOME.x, leader.getPositionY() - HOME.y));
      if (leader.movespline.finalized() === false) closest = Math.min(closest, member.getExactDist(leader));
    }
    expect(farthestLeader).toBeGreaterThan(20);
    expect(followed).toBe(true);
    // the member keeps its place behind the leader (3 yards, 180 degrees), never running through it
    expect(closest).toBeGreaterThan(1);
    expect(member.getExactDist(leader)).toBeLessThan(25);
    expect(member.getPositionX()).not.toBe(HOME.x - 3);
  });
});

describe("death and respawn of the motion", () => {
  test("a creature the combat world kills stops, goes idle, its corpse returns to the spawn, and the respawn restarts the wander", () => {
    const rows = new Map<MySqlTable, Record<string, unknown>[]>();
    templateRows(rows, 1000);
    addRows(rows, w.creature_classlevelstats, { level: 10, class: 1, basehp0: 100, basehp1: 100, basehp2: 100, basemana: 0, basearmor: 10, attackpower: 0, rangedattackpower: 0, damage_base: 3, damage_exp1: 3, damage_exp2: 3 });
    addRows(rows, w.creature, creatureRow(1, 1000, 0, HOME.x, HOME.y, { MovementType: 1, wander_distance: 8, spawntimesecs: 60 }));
    const { world, tables } = start(rows);
    const combat = new CombatWorld(world, mapCreatureLocator, tables, null, new FactionStore([factionTemplate(35, 35, 0, 0, 0)]));
    const wanderer = creatureOf(1);
    joinWorld(5, HOME.x - 20, HOME.y, HOME.z, combat);
    let now = 1_000_000;
    for (let t = 0; t < 30_000 && wanderer.movespline.finalized(); t += 50) {
      advanceMaps(50, 50);
      combat.update(now);
      now += 50;
    }
    expect(wanderer.movespline.finalized()).toBe(false);

    combat.commandKillCreature(1, 5);
    expect(wanderer.isAlive()).toBe(false);
    expect(wanderer.movespline.finalized()).toBe(true);
    expect(wanderer.getMotionMaster().getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
    const diedAt = { x: wanderer.getPositionX(), y: wanderer.getPositionY() };
    for (let t = 0; t < 1000; t += 50) {
      advanceMaps(50, 50);
      combat.update(now);
      now += 50;
    }
    expect([wanderer.getPositionX(), wanderer.getPositionY()]).toEqual([diedAt.x, diedAt.y]);

    // the corpse decays, the creature goes back to its spawn position, and after `spawntimesecs` it respawns and wanders again
    now += 100_000;
    advanceMaps(100, 50);
    combat.update(now);
    now += 100_000;
    advanceMaps(100, 50);
    combat.update(now);
    for (let t = 0; t < 40_000 && !wanderer.isAlive(); t += 1000) {
      now += 1000;
      combat.update(now);
      advanceMaps(1000, 50);
    }
    expect(wanderer.isAlive()).toBe(true);
    expect(wanderer.getMotionMaster().getCurrentMovementGeneratorType()).toBe(RANDOM_MOTION_TYPE);
  });
});
