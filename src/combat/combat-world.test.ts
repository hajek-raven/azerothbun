import { beforeEach, describe, expect, test } from "bun:test";
import { Loot } from "../loot/loot.ts";
import { seedRandom } from "../common/random.ts";
import type { CreatureSpawn, CreatureTemplate, WorldData } from "../data/world.ts";
import { indexSpawns } from "../world/spawn.ts";
import { ConfigMgr, ConfigSeverity, defaultConfigPolicy } from "../common/config.ts";
import { WorldConfig } from "../game/world/world-config.ts";
import { CombatWorld, configureCombatRates, DEFAULT_COMBAT_RATES, type CombatPlayer, type CreatureKill, type PlayerMelee } from "./combat-world.ts";
import {
  SMSG_AI_REACTION,
  SMSG_ATTACKERSTATEUPDATE,
  SMSG_ATTACKSTART,
  SMSG_ATTACKSTOP,
  SMSG_ATTACKSWING_BADFACING,
  SMSG_ATTACKSWING_NOTINRANGE,
  SMSG_MONSTER_MOVE,
  SMSG_PARTYKILLLOG,
  SMSG_UPDATE_OBJECT,
  UNIT_DYNFLAG_DEAD,
  UNIT_DYNFLAG_LOOTABLE,
  UNIT_DYNFLAG_TAPPED,
  UNIT_DYNFLAG_TAPPED_BY_PLAYER,
  UNIT_FLAG_IN_COMBAT,
} from "./constants.ts";
import { FactionStore, type FactionTemplate } from "./faction.ts";
import { UNIT_DYNAMIC_FLAGS, UNIT_FIELD_HEALTH, updateFieldValue } from "./packets.ts";

const HOME = { x: 100, y: 100, z: 10 };
const WOLF = 1;
const GUARD = 2;
const FAR_WOLF = 3;

function factionTemplate(id: number, faction: number, ourMask: number, friendlyMask: number, hostileMask: number): FactionTemplate {
  return { id, faction, flags: 1, ourMask, friendlyMask, hostileMask, enemyFaction: [0, 0, 0, 0], friendFaction: [0, 0, 0, 0] };
}

function template(entry: number, faction: number, type: number): CreatureTemplate {
  return {
    entry,
    name: `creature ${entry}`,
    subName: "",
    iconName: "",
    minLevel: 1,
    maxLevel: 1,
    expansion: 0,
    faction,
    npcFlags: 0,
    gossipMenuId: 0,
    unitClass: 1,
    unitFlags: 0,
    unitFlags2: 0,
    dynamicFlags: 0,
    family: 0,
    type,
    typeFlags: 0,
    rank: 0,
    killCredit: [0, 0],
    healthMod: 1,
    manaMod: 1,
    armorMod: 1,
    damageMod: 1,
    resistances: [0, 0, 0, 0, 0, 0, 0],
    racialLeader: 0,
    movementId: 0,
    speedWalk: 1,
    speedRun: 1,
    speedSwim: 1,
    speedFlight: 1,
    hoverHeight: 1,
    models: [{ idx: 0, displayId: 100, scale: 1, boundingRadius: 0.5, combatReach: 1.5, gender: 2 }],
    equipment: [],
  };
}

function spawn(guid: number, entry: number, x: number, y: number): CreatureSpawn {
  return { guid, entry, map: 0, x, y, z: HOME.z, orientation: Math.PI, spawnMask: 1, phaseMask: 1, equipmentId: 0, health: 0, mana: 0, npcFlags: 0, unitFlags: 0, dynamicFlags: 0 };
}

function fakeWorld(): WorldData {
  const templates = new Map([
    [299, template(299, 14, 1)],
    [68, template(68, 12, 7)],
  ]);
  return {
    creaturesOnMap: [spawn(WOLF, 299, HOME.x, HOME.y), spawn(GUARD, 68, HOME.x + 8, HOME.y), spawn(FAR_WOLF, 299, HOME.x + 400, HOME.y)],
    gameObjectsOnMap: [],
    creatureTemplate: (entry: number) => templates.get(entry),
    creatureClassLevelStats: () => ({
      level: 1,
      classId: 1,
      baseHp: [40, 1, 1],
      baseMana: 0,
      baseArmor: 20,
      attackPower: 0,
      rangedAttackPower: 0,
      damage: [3, 3, 3],
      strength: 0,
      agility: 0,
      stamina: 0,
      intellect: 0,
      spirit: 0,
    }),
    gameObjectTemplate: () => undefined,
    itemTemplate: () => undefined,
    playerStart: () => null,
    questItems: () => [],
  } as unknown as WorldData;
}

type FakePlayer = CombatPlayer & {
  sent: number[];
  updates: Uint8Array[];
  place: { map: number; x: number; y: number; z: number; o: number };
  hp: number;
  dead: boolean;
  combat: boolean[];
  kills: CreatureKill[];
  known: Set<bigint>;
  refreshes: number;
};

function melee(overrides: Partial<PlayerMelee> = {}): PlayerMelee {
  return {
    attackTime: () => 2000,
    hasOffhand: false,
    damage: () => ({ min: 20, max: 20, school: 0 }),
    crit: () => 0,
    weaponSkill: () => 5,
    maxSkill: 5,
    defenseSkill: 5,
    expertiseReduction: () => 0,
    modMeleeHitChance: 100,
    armorPenetrationPct: 0,
    dodge: 0,
    parry: 0,
    block: 0,
    blockValue: 0,
    armor: 0,
    missFromDefense: 0,
    critTakenReduction: 0,
    canParry: false,
    canBlock: false,
    usesRage: true,
    ...overrides,
  };
}

function fakePlayer(guid: number, place: { x: number; y: number; z: number; o: number }, stats: PlayerMelee = melee()): FakePlayer {
  const player: FakePlayer = {
    guid,
    sent: [],
    updates: [],
    place: { map: 0, ...place },
    hp: 100,
    dead: false,
    combat: [],
    kills: [],
    known: new Set(),
    refreshes: 0,
    name: () => `player${guid}`,
    position: () => player.place,
    level: () => 1,
    race: () => 1,
    classId: () => 1,
    factionTemplate: () => 1,
    reputation: () => null,
    alive: () => !player.dead,
    gameMaster: () => false,
    sitting: () => false,
    standUp: () => {},
    moving: () => false,
    mounted: () => false,
    knows: (g) => player.known.has(g),
    send: (opcode, body) => {
      player.sent.push(opcode);
      if (opcode === SMSG_UPDATE_OBJECT) {
        player.updates.push(body);
      }
    },
    broadcast: () => {},
    health: () => player.hp,
    melee: () => stats,
    takeDamage: (amount) => {
      player.hp = Math.max(0, player.hp - amount);
      player.dead = player.hp === 0;
      return player.dead;
    },
    addRage: () => {},
    setInCombat: (on) => player.combat.push(on),
    killedCreature: (kill) => {
      player.kills.push(kill);
      // A corpse with money on it (`Loot::generateMoneyLoot`).
      const loot = new Loot({ itemProto: () => null, enchSuffixFactor: () => 0, randomPropertyId: () => 0 });
      loot.gold = 5;
      return loot;
    },
    combatSkill: () => {},
    refreshSpawns: () => {
      player.refreshes += 1;
    },
  };
  return player;
}

function setup(): { combat: CombatWorld; world: WorldData } {
  const world = fakeWorld();
  const factions = new FactionStore([
    factionTemplate(1, 1, 3, 2, 12),
    factionTemplate(12, 72, 2, 2, 4),
    factionTemplate(14, 14, 8, 0, 1),
  ]);
  const combat = new CombatWorld(world, indexSpawns(world), null, null, factions);
  return { combat, world };
}

function guidOf(combat: CombatWorld, spawnGuid: number): bigint {
  return combat.infos.info(spawnGuid)!.guid;
}

/** Ticks from `start` every 100 ms for `ms`. */
function run(combat: CombatWorld, start: number, ms: number): number {
  let now = start;
  for (let elapsed = 0; elapsed <= ms; elapsed += 100) {
    now = start + elapsed;
    combat.update(now);
  }
  return now;
}

beforeEach(() => seedRandom(1234));

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
    expect(player.sent).toContain(SMSG_MONSTER_MOVE);
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
    player.place.x = HOME.x + 200;
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
    expect(player.refreshes).toBeGreaterThan(0);
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
