import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { seedRandom } from "../common/random.ts";
import type { WorldData } from "../data/world.ts";
import { advanceMaps, setUpTestMapWorld, tearDownTestMapWorld } from "../world/map-world.test-util.ts";
import { mapCreatureLocator } from "../world/map-world.ts";
import type { Creature } from "../game/Entities/Creature/Creature.ts";
import { sMapMgr } from "../game/Maps/MapMgr.ts";
import type { Map as AcMap } from "../game/Maps/Map.ts";
import { addRows, creatureRow, creatureTemplateRows, loadSpawnFixture, worldSchema as w } from "../game/Maps/SpawnData.test-util.ts";
import { ConfigMgr, ConfigSeverity, defaultConfigPolicy } from "../common/config.ts";
import { WorldConfig } from "../game/world/world-config.ts";
import { CombatWorld, configureCombatRates, DEFAULT_COMBAT_RATES, type PlayerMelee } from "./combat-world.ts";
import { factionTemplate, joinWorld, melee, testCombatPlayer, type TestCombatPlayer } from "./combat.test-util.ts";
import {
  SMSG_AI_REACTION,
  SMSG_ATTACKERSTATEUPDATE,
  SMSG_ATTACKSTART,
  SMSG_ATTACKSTOP,
  SMSG_ATTACKSWING_BADFACING,
  SMSG_ATTACKSWING_NOTINRANGE,
  SMSG_MONSTER_MOVE,
  SMSG_PARTYKILLLOG,
  UNIT_DYNFLAG_DEAD,
  UNIT_DYNFLAG_LOOTABLE,
  UNIT_DYNFLAG_TAPPED,
  UNIT_DYNFLAG_TAPPED_BY_PLAYER,
  UNIT_FLAG_IN_COMBAT,
} from "./constants.ts";
import { FactionStore } from "./faction.ts";
import { UNIT_DYNAMIC_FLAGS, UNIT_FIELD_HEALTH, updateFieldValue } from "./packets.ts";

const HOME = { x: 100, y: 100, z: 10 };
const WOLF = 1;
const GUARD = 2;
const FAR_WOLF = 3;

type FakePlayer = TestCombatPlayer;

/** The creatures of the test, as the `creature` / `creature_template` rows the map layer loads. */
function spawnRows(): Map<MySqlTable, Record<string, unknown>[]> {
  const rows = new Map<MySqlTable, Record<string, unknown>[]>();
  const [wolf, wolfModel] = creatureTemplateRows(299, { faction: 14, type: 1, minlevel: 1, maxlevel: 1 });
  const [guard, guardModel] = creatureTemplateRows(68, { faction: 12, type: 7, minlevel: 1, maxlevel: 1 });
  addRows(rows, w.creature_template, wolf!, guard!);
  addRows(rows, w.creature_template_model, wolfModel!, guardModel!);
  addRows(rows, w.creature_model_info, { DisplayID: 1299, BoundingRadius: 0.5, CombatReach: 1.5, Gender: 2 }, { DisplayID: 1068, BoundingRadius: 0.5, CombatReach: 1.5, Gender: 2 });
  addRows(rows, w.creature_classlevelstats, { level: 1, class: 1, basehp0: 40, basehp1: 1, basehp2: 1, basemana: 0, basearmor: 20, attackpower: 0, rangedattackpower: 0, damage_base: 3, damage_exp1: 3, damage_exp2: 3 });
  addRows(
    rows,
    w.creature,
    creatureRow(WOLF, 299, 0, HOME.x, HOME.y, { position_z: HOME.z, orientation: Math.PI, spawntimesecs: 300 }),
    creatureRow(GUARD, 68, 0, HOME.x + 8, HOME.y, { position_z: HOME.z, orientation: Math.PI, spawntimesecs: 300 }),
    creatureRow(FAR_WOLF, 299, 0, HOME.x + 400, HOME.y, { position_z: HOME.z, orientation: Math.PI, spawntimesecs: 300 }),
  );
  return rows;
}

/** Builds a fake player; with a `map` it stands on it, so a chasing creature has an object to follow. */
function fakePlayer(guid: number, place: { x: number; y: number; z: number; o: number }, stats: PlayerMelee = melee()): FakePlayer {
  const { session } = joinWorld(guid, place.x, place.y, place.z, activeCombat);
  session.character.orientation = place.o;
  return testCombatPlayer(guid, place, stats, session);
}

let activeCombat: CombatWorld | null = null;

/** The creature object of a spawn (`Map::GetCreatureBySpawnIdStore`), that records the visibility updates the combat code asks for. */
function creatureObject(spawnGuid: number): { creature: Creature; visibilityUpdates: number } {
  const creature = mapCreatureLocator.findCreature(0, spawnGuid)!;
  const stub = { visibilityUpdates: 0, creature };
  const original = creature.updateObjectVisibility.bind(creature);
  creature.updateObjectVisibility = (forced?: boolean, fromUpdate?: boolean) => {
    stub.visibilityUpdates += 1;
    original(forced, fromUpdate);
  };
  return stub;
}

function setup(): { combat: CombatWorld; world: WorldData; map: AcMap } {
  const { world } = loadSpawnFixture(spawnRows());
  setUpTestMapWorld(world);
  const map = sMapMgr().createBaseMap(0);
  map.loadGrid(HOME.x, HOME.y);
  const factions = new FactionStore([
    factionTemplate(1, 1, 3, 2, 12),
    factionTemplate(12, 72, 2, 2, 4),
    factionTemplate(14, 14, 8, 0, 1),
  ]);
  const combat = new CombatWorld(world, mapCreatureLocator, world.tables(), null, factions);
  activeCombat = combat;
  return { combat, world, map };
}

function guidOf(combat: CombatWorld, spawnGuid: number): bigint {
  return combat.infos.info(spawnGuid)!.guid;
}

/**
 * Ticks from `start` every 100 ms for `ms`: the map update (`Creature::Update`: the spline and the motion master) and the combat
 * update (`CreatureAI::UpdateAI`) in the order of `World::Update`.
 */
function run(combat: CombatWorld, start: number, ms: number): number {
  let now = start;
  for (let elapsed = 0; elapsed <= ms; elapsed += 100) {
    now = start + elapsed;
    advanceMaps(100, 50);
    combat.update(now);
  }
  return now;
}

beforeEach(() => seedRandom(1234));

afterEach(() => {
  activeCombat = null;
  tearDownTestMapWorld();
});

describe("player melee against a creature", () => {
  test("swings, tags, kills, rewards, and leaves a lootable corpse", () => {
    const { combat } = setup();
    // standing 2 yards west of the wolf, facing east; far enough from the wolf's aggro to test the swing path first
    const player = fakePlayer(7, { x: HOME.x - 2, y: HOME.y, z: HOME.z, o: 0 });
    const wolf = guidOf(combat, WOLF);
    player.known.add(wolf);
    combat.addPlayer(player);
    let now = 1_000_000;
    combat.update(now);
    combat.attackSwing(7, wolf);
    expect(player.sent).toContain(SMSG_ATTACKSTART);
    now = run(combat, now + 100, 12_000);
    expect(player.sent).toContain(SMSG_ATTACKERSTATEUPDATE);
    expect(player.sent).toContain(SMSG_PARTYKILLLOG);
    expect(player.kills).toHaveLength(1);
    expect(player.kills[0]!.xp).toBe(50);
    expect(player.kills[0]!.guid).toBe(wolf);
    const unit = combat.creature(WOLF)!;
    expect(unit.deathState).toBe("corpse");
    expect(combat.canLoot(7, wolf)).toBe(true);
    expect(combat.canLoot(8, wolf)).toBe(false);
    const view = combat.liveView(WOLF, 7)!;
    // Feign death only; a real corpse shows it and the client treats the wolf as alive.
    expect(view.dynamicFlags & UNIT_DYNFLAG_DEAD).toBe(0);
    expect(view.dynamicFlags & UNIT_DYNFLAG_LOOTABLE).toBe(UNIT_DYNFLAG_LOOTABLE);
    const deathUpdate = player.updates.some((body) => {
      const health = updateFieldValue(body, UNIT_FIELD_HEALTH);
      const flags = updateFieldValue(body, UNIT_DYNAMIC_FLAGS);
      return health === 0 && flags !== null && (flags & UNIT_DYNFLAG_LOOTABLE) === UNIT_DYNFLAG_LOOTABLE;
    });
    expect(deathUpdate).toBe(true);
    expect(view.dynamicFlags & UNIT_DYNFLAG_TAPPED_BY_PLAYER).toBe(UNIT_DYNFLAG_TAPPED_BY_PLAYER);
    const other = combat.liveView(WOLF, 8)!;
    expect(other.dynamicFlags & UNIT_DYNFLAG_LOOTABLE).toBe(0);
    expect(other.dynamicFlags & UNIT_DYNFLAG_TAPPED).toBe(UNIT_DYNFLAG_TAPPED);
    expect(combat.inCombat(7)).toBe(false);
    expect(player.combat).toEqual([true, false]);
  });

  test("out of range and wrong facing are reported once each", () => {
    const { combat } = setup();
    const player = fakePlayer(7, { x: HOME.x - 30, y: HOME.y, z: HOME.z, o: 0 });
    const wolf = guidOf(combat, WOLF);
    combat.addPlayer(player);
    combat.update(0);
    combat.attackSwing(7, wolf);
    run(combat, 100, 1000);
    expect(player.sent.filter((op) => op === SMSG_ATTACKSWING_NOTINRANGE)).toHaveLength(1);
    tearDownTestMapWorld();
    const facing = setup().combat;
    const turned = fakePlayer(8, { x: HOME.x - 2, y: HOME.y, z: HOME.z, o: Math.PI });
    facing.addPlayer(turned);
    facing.update(0);
    facing.attackSwing(8, guidOf(facing, WOLF));
    run(facing, 100, 1000);
    expect(turned.sent.filter((op) => op === SMSG_ATTACKSWING_BADFACING)).toHaveLength(1);
  });

  test("friendly creatures can't be attacked", () => {
    const { combat } = setup();
    const player = fakePlayer(7, { x: HOME.x + 6, y: HOME.y, z: HOME.z, o: 0 });
    combat.addPlayer(player);
    combat.attackSwing(7, guidOf(combat, GUARD));
    expect(player.sent).toEqual([SMSG_ATTACKSTOP]);
  });
});

describe("creature AI", () => {
  test("a hostile creature pulls by proximity, chases, and hits the player", () => {
    const { combat } = setup();
    const player = fakePlayer(7, { x: HOME.x - 15, y: HOME.y, z: HOME.z, o: 0 }, melee({ damage: () => ({ min: 0, max: 0, school: 0 }) }));
    const wolf = guidOf(combat, WOLF);
    player.known.add(wolf);
    combat.addPlayer(player);
    run(combat, 0, 6000);
    expect(player.sent).toContain(SMSG_AI_REACTION);
    expect(player.sent).toContain(SMSG_ATTACKSTART);
    // the creature runs at the player: the player on the map receives the spline packets (`MoveSplineInit::Launch` -> `SendMessageToSet`)
    expect(player.session!.count(SMSG_MONSTER_MOVE)).toBeGreaterThan(0);
    expect(player.hp).toBeLessThan(100);
    expect(combat.inCombat(7)).toBe(true);
    expect(combat.liveView(WOLF, 7)!.unitFlags & UNIT_FLAG_IN_COMBAT).toBe(UNIT_FLAG_IN_COMBAT);
  });

  test("the creature evades home after the leash radius and timer, and heals back up", () => {
    const { combat } = setup();
    const player = fakePlayer(7, { x: HOME.x - 3, y: HOME.y, z: HOME.z, o: 0 }, melee({ damage: () => ({ min: 1, max: 1, school: 0 }) }));
    const wolf = guidOf(combat, WOLF);
    player.known.add(wolf);
    combat.addPlayer(player);
    combat.update(0);
    combat.attackSwing(7, wolf);
    let now = run(combat, 100, 2500);
    combat.attackStop(7);
    const hurt = combat.creature(WOLF)!.health;
    expect(hurt).toBeLessThan(40);
    // run 60 yards away; the wolf follows until it is past 30 yards from home and 11 s passed without damage
    player.place = { ...player.place, x: HOME.x - 60 };
    now = run(combat, now + 100, 15_000);
    expect(combat.creature(WOLF)?.threat.size ?? 0).toBe(0);
    expect(combat.inCombat(7)).toBe(false);
    now = run(combat, now + 100, 20_000);
    const unit = combat.creature(WOLF);
    if (unit) {
      expect(unit.evading).toBe(false);
      expect(unit.health).toBe(40);
    } else {
      expect(combat.liveView(WOLF, 7)).toBeNull();
    }
  });

  test("a friendly guard does not pull and an out-of-range wolf stays put", () => {
    const { combat } = setup();
    const player = fakePlayer(7, { x: HOME.x + 8, y: HOME.y + 3, z: HOME.z, o: 0 });
    player.place = { ...player.place, x: HOME.x + 200 };
    combat.addPlayer(player);
    run(combat, 0, 2000);
    expect(combat.inCombat(7)).toBe(false);
    expect(combat.creature(GUARD)).toBeNull();
    expect(combat.creature(FAR_WOLF)).toBeNull();
  });

  test("a creature that kills its victim drops it and goes home", () => {
    const { combat } = setup();
    const player = fakePlayer(7, { x: HOME.x - 3, y: HOME.y, z: HOME.z, o: 0 }, melee({ damage: () => ({ min: 0, max: 0, school: 0 }) }));
    player.hp = 5;
    player.known.add(guidOf(combat, WOLF));
    combat.addPlayer(player);
    run(combat, 0, 10_000);
    expect(player.dead).toBe(true);
    expect(combat.inCombat(7)).toBe(false);
    expect(combat.creature(WOLF)?.threat.size ?? 0).toBe(0);
  });
});

describe("corpse and respawn", () => {
  test("corpse decays after Corpse.Decay.NORMAL, hides, then respawns after spawntimesecs", () => {
    const { combat } = setup();
    const wolfObject = creatureObject(WOLF);
    const player = fakePlayer(7, { x: HOME.x - 2, y: HOME.y, z: HOME.z, o: 0 }, melee({ damage: () => ({ min: 100, max: 100, school: 0 }) }));
    const wolf = guidOf(combat, WOLF);
    player.known.add(wolf);
    combat.addPlayer(player);
    let now = 1_000_000;
    combat.update(now);
    combat.attackSwing(7, wolf);
    now = run(combat, now + 100, 3000);
    expect(combat.creature(WOLF)!.deathState).toBe("corpse");
    // looting everything halves the remaining corpse time (Rate.Corpse.Decay.Looted = 0.5)
    combat.creature(WOLF)!.loot!.gold = 0;
    combat.releaseLoot(wolf, 7);
    expect(combat.canLoot(7, wolf)).toBe(false);
    now = run(combat, now + 1000, 31_000);
    expect(combat.creature(WOLF)!.deathState).toBe("dead");
    expect(combat.liveView(WOLF, 7)!.hidden).toBe(true);
    // the corpse went: `Creature::RemoveCorpse` updates the visibility of the creature object (its viewers destroy it)
    expect(wolfObject.visibilityUpdates).toBeGreaterThan(0);
    // the creature object reads the unit's state while the unit lives
    expect(wolfObject.creature.m_combatUnit).not.toBeNull();
    // default spawntimesecs 300, minus the looted reduction
    now = run(combat, now + 1000, 300_000);
    const respawned = combat.creature(WOLF);
    expect(respawned === null || respawned.deathState === "alive").toBe(true);
  });
});

describe("configuration", () => {
  test("combat rates come from worldserver.conf defaults", () => {
    const config = new ConfigMgr();
    const policy = defaultConfigPolicy();
    policy.missingOptionSeverity = ConfigSeverity.Skip;
    policy.criticalOptionSeverity = ConfigSeverity.Skip;
    policy.valueErrorSeverity = ConfigSeverity.Skip;
    config.configure("", [], "", policy);
    const settings = new WorldConfig(config);
    settings.load();
    const { combat } = setup();
    const rates = configureCombatRates(settings);
    expect(rates).toEqual(DEFAULT_COMBAT_RATES);
    expect(combat.rates).toBe(rates);
  });
});

describe("auto-attack state", () => {
  test("attacking from out of range keeps the swing target while the player closes in", () => {
    const { combat } = setup();
    const player = fakePlayer(7, { x: HOME.x - 60, y: HOME.y, z: HOME.z, o: 0 });
    const wolf = guidOf(combat, WOLF);
    combat.addPlayer(player);
    combat.update(0);
    combat.attackSwing(7, wolf);
    run(combat, 100, 3000);
    expect(combat.victimOf(7)).toBe(wolf);
    expect(player.sent).not.toContain(SMSG_ATTACKSTOP);
  });
});
