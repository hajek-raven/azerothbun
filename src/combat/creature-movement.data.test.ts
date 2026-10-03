/**
 * Creature movement end to end over the real extracted client data (`data/dbc`, `maps`, `vmaps`, `mmaps`): the creatures of
 * Northshire Valley are created by the grid loader, moved by their `MotionMaster` (`Creature::Update` -> `Unit::UpdateSplineMovement`
 * and `MotionMaster::UpdateMotion`), and fight through the combat world. Covers a chase over the nav mesh and the way home, the
 * random wander, a waypoint path with delays, the spline packets a nearby player receives, and the spline in a create block.
 * Skips itself when the data is not there.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { seedRandom } from "../common/random.ts";
import { clearSharedGridTerrainData } from "../game/Grids/GridTerrainLoader.ts";
import { loadDBCStores } from "../game/DataStores/DBCStores.ts";
import type { Creature } from "../game/Entities/Creature/Creature.ts";
import { UpdateData } from "../game/Entities/Object/Updates/UpdateData.ts";
import { HOME_MOTION_TYPE, IDLE_MOTION_TYPE, RANDOM_MOTION_TYPE, WAYPOINT_MOTION_TYPE } from "../game/Movement/MotionMaster.ts";
import { sWaypointMgr } from "../game/Movement/Waypoints/WaypointMgr.ts";
import { MOVEMENTFLAG_SPLINE_ENABLED } from "../game/Entities/Unit/UnitDefines.ts";
import { Map as AcMap } from "../game/Maps/Map.ts";
import { sMapMgr } from "../game/Maps/MapMgr.ts";
import { addRows, creatureRow, creatureTemplateRows, loadSpawnFixture, worldSchema as w } from "../game/Maps/SpawnData.test-util.ts";
import { ByteReader } from "../net/byte-buffer.ts";
import { advanceMaps, setUpTestMapWorld, tearDownTestMapWorld } from "../world/map-world.test-util.ts";
import { mapCreatureLocator } from "../world/map-world.ts";
import { removeFromMap } from "../world/session-map.ts";
import { CombatWorld } from "./combat-world.ts";
import { factionTemplate, joinWorld, melee, movePlayer, testCombatPlayer } from "./combat.test-util.ts";
import { SMSG_ATTACKSTART, SMSG_MONSTER_MOVE, SMSG_UPDATE_OBJECT } from "./constants.ts";
import { FactionStore } from "./faction.ts";
import { UNIT_STATE_EVADE } from "../spells/enums.ts";

const data = join(process.cwd(), "data");
const available = ["dbc/Map.dbc", "maps/0004832.map", "maps/0004932.map", "vmaps/000.vmtree", "mmaps/000.mmap", "mmaps/0004832.mmtile"].every((f) => existsSync(join(data, f)));

/** Young Wolf (`creature` row 79933) in the Northshire Valley, and the wolf's template. */
const WOLF = { guid: 79933, entry: 299, x: -8953.62, y: -48.5983, z: 92.078, o: 1.52582 };
const STEP_MS = 50;

/** Ground height over the real data (a map outside the map manager: no spawns, only the terrain). */
let ground: (x: number, y: number) => number;

beforeAll(async () => {
  if (!available) return;
  await loadDBCStores(join(data, "dbc"));
  setUpTestMapWorld(emptyWorld(), "data");
  clearSharedGridTerrainData();
  const terrain = new AcMap(0, 0, 0);
  terrain.loadGrid(WOLF.x, WOLF.y);
  ground = (x, y) => terrain.getHeight(1, x, y, WOLF.z + 40);
  tearDownTestMapWorld();
});

afterAll(() => {
  clearSharedGridTerrainData();
});

afterEach(() => {
  if (available) tearDownTestMapWorld();
});

function emptyWorld() {
  return loadSpawnFixture(new Map<MySqlTable, Record<string, unknown>[]>()).world;
}

/** The rows of one wolf spawn (`wander` / `type` / `path` set the movement) and the factions around it. */
function wolfRows(extra: Record<string, unknown> = {}, faction = 14, rows = new Map<MySqlTable, Record<string, unknown>[]>()): Map<MySqlTable, Record<string, unknown>[]> {
  const [template, model] = creatureTemplateRows(WOLF.entry, { name: "Young Wolf", faction, type: 1, minlevel: 1, maxlevel: 1, detection_range: 20 });
  addRows(rows, w.creature_template, template!);
  addRows(rows, w.creature_template_model, model!);
  addRows(rows, w.creature_model_info, { DisplayID: 1000 + WOLF.entry, BoundingRadius: 0.42, CombatReach: 1.5, Gender: 2 });
  addRows(rows, w.creature_classlevelstats, { level: 1, class: 1, basehp0: 40, basehp1: 1, basehp2: 1, basemana: 0, basearmor: 20, attackpower: 0, rangedattackpower: 0, damage_base: 3, damage_exp1: 3, damage_exp2: 3 });
  addRows(rows, w.creature, creatureRow(WOLF.guid, WOLF.entry, 0, WOLF.x, WOLF.y, { position_z: WOLF.z, orientation: WOLF.o, spawntimesecs: 180, ...extra }));
  return rows;
}

function factions(): FactionStore {
  return new FactionStore([factionTemplate(1, 1, 3, 2, 12), factionTemplate(14, 14, 8, 0, 1), factionTemplate(35, 35, 0, 0, 0)]);
}

/** The world over the real data: the spawn rows, the map layer, the movement stores, and the map with the wolf's grid loaded. */
function start(rows: Map<MySqlTable, Record<string, unknown>[]>) {
  const { world, tables } = loadSpawnFixture(rows);
  setUpTestMapWorld(world, "data");
  sWaypointMgr().load(tables);
  const map = sMapMgr().createBaseMap(0);
  map.loadGrid(WOLF.x, WOLF.y);
  const wolf = mapCreatureLocator.findCreature(0, WOLF.guid)!;
  const combat = new CombatWorld(world, mapCreatureLocator, tables, null, factions());
  return { world, map, wolf, combat };
}

type Tick = { now: number; x: number; y: number; z: number };

/** Runs the map (`World::Update` steps of 50 ms) and the combat update; `onStep` sees every step. */
function runFor(combat: CombatWorld | null, wolf: Creature, startMs: number, ms: number, onStep?: (tick: Tick) => void): number {
  let now = startMs;
  for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
    now = startMs + elapsed;
    advanceMaps(STEP_MS, STEP_MS);
    combat?.update(now);
    onStep?.({ now, x: wolf.getPositionX(), y: wolf.getPositionY(), z: wolf.getPositionZ() });
  }
  return now;
}

const dist2d = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by);

/** The first spline of a `SMSG_MONSTER_MOVE` payload: the unit's packed guid, the start, the id, the spline type and the points. */
function monsterMove(payload: Uint8Array): { guid: bigint; start: [number, number, number]; id: number; type: number; flags: number; duration: number; points: [number, number, number][] } {
  const reader = new ByteReader(payload);
  const mask = reader.readU8();
  let guid = 0n;
  for (let bit = 0; bit < 8; bit++) if (mask & (1 << bit)) guid |= BigInt(reader.readU8()) << BigInt(bit * 8);
  reader.readU8();
  const start: [number, number, number] = [reader.readF32(), reader.readF32(), reader.readF32()];
  const id = reader.readU32();
  const type = reader.readU8();
  if (type === 3) reader.readU64();
  else if (type === 4) reader.readF32();
  else if (type === 2) for (let i = 0; i < 3; i++) reader.readF32();
  const points: [number, number, number][] = [];
  if (type === 1) return { guid, start, id, type, flags: 0, duration: 0, points };
  const flags = reader.readU32();
  const duration = reader.readU32();
  const count = reader.readU32();
  if (count > 0) {
    // the destination is a full vector, the others are packed offsets (`WriteLinearPath`)
    points.push([reader.readF32(), reader.readF32(), reader.readF32()]);
  }
  return { guid, start, id, type, flags, duration, points: points.concat(Array.from({ length: Math.max(0, count - 1) }, () => [0, 0, 0] as [number, number, number])) };
}

describe.skipIf(!available)("creature movement over the Northshire data", () => {
  test("a wolf that aggroes a player chases over the nav mesh, fights in melee range, and walks home when the player runs away", () => {
    seedRandom(7);
    const { wolf, combat, map } = start(wolfRows({ MovementType: 0, wander_distance: 0 }));
    expect(wolf.isInWorld()).toBe(true);
    expect(wolf.getDefaultMovementType()).toBe(IDLE_MOTION_TYPE);
    expect(wolf.getMotionMaster().getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);

    // a player 14 yards west of the wolf, on the ground, in aggro range
    const px = WOLF.x - 14;
    const py = WOLF.y - 4;
    const pz = ground(px, py);
    const { session } = joinWorld(7, px, py, pz, combat);
    const player = testCombatPlayer(7, { x: px, y: py, z: pz, o: 0 }, melee({ damage: () => ({ min: 0, max: 0, school: 0 }) }), session);
    const wolfGuid = combat.infos.info(WOLF.guid)!.guid;
    player.known.add(wolfGuid);
    combat.addPlayer(player);
    // the player sees the creature (the grid notifiers linked it)
    expect(session.mapPlayer!.haveAtClient(wolfGuid)).toBe(true);
    const homeZ = wolf.getPositionZ();

    const ticks: Tick[] = [];
    let now = 1_000_000;
    now = runFor(combat, wolf, now, 6000, (tick) => ticks.push(tick));

    // it aggroed, and the chase generator took over the active slot
    expect(player.sent).toContain(SMSG_ATTACKSTART);
    expect(combat.creature(WOLF.guid)!.victim).toBe(7);
    // it moved tick by tick towards the player: on the ground, and closer than where it started
    const moved = ticks.filter((tick, i) => i > 0 && (tick.x !== ticks[i - 1]!.x || tick.y !== ticks[i - 1]!.y));
    expect(moved.length).toBeGreaterThan(5);
    for (const tick of moved) expect(Math.abs(tick.z - map.getHeight(1, tick.x, tick.y, tick.z + 3))).toBeLessThan(1.5);
    const startDistance = dist2d(WOLF.x, WOLF.y, px, py);
    const endDistance = dist2d(wolf.getPositionX(), wolf.getPositionY(), px, py);
    expect(endDistance).toBeLessThan(startDistance - 5);
    // it stops in melee reach of the player and hits it
    expect(wolf.getExactDist(session.mapPlayer!)).toBeLessThan(wolf.getMeleeRange(session.mapPlayer! as never) + 1);
    expect(player.hp).toBeLessThan(100);

    // the player on the map received the spline packets of the creature (`MoveSplineInit::Launch` -> `SendMessageToSet`)
    const splines = session.payloads(SMSG_MONSTER_MOVE).map(monsterMove);
    expect(splines.length).toBeGreaterThan(0);
    expect(splines.every((spline) => spline.guid === wolfGuid)).toBe(true);
    // the chase spline: facing the target (type 3), over a path of the nav mesh that ends in melee reach of the player
    const chase = splines.find((spline) => spline.type === 3 && spline.points.length >= 2)!;
    expect(chase).toBeDefined();
    expect(dist2d(chase.points[0]![0], chase.points[0]![1], px, py)).toBeLessThan(wolf.getMeleeRange(session.mapPlayer! as never) + 0.5);

    // the player runs 80 yards away: past the leash radius the wolf evades and walks home along a spline
    const away = { x: px - 80, y: py, z: 0 };
    away.z = ground(away.x, away.y);
    movePlayer(session, away.x, away.y, away.z, 0, true);
    player.place = { map: 0, ...away, o: 0 };
    let evaded = false;
    let homeStarted = false;
    now = runFor(combat, wolf, now + STEP_MS, 30_000, () => {
      if (wolf.hasUnitState(UNIT_STATE_EVADE)) evaded = true;
      if (wolf.getMotionMaster().getCurrentMovementGeneratorType() === HOME_MOTION_TYPE) homeStarted = true;
    });
    expect(evaded).toBe(true);
    expect(homeStarted).toBe(true);
    // back at home, idle, no longer evading, no combat state
    expect(dist2d(wolf.getPositionX(), wolf.getPositionY(), WOLF.x, WOLF.y)).toBeLessThan(1.0);
    expect(Math.abs(wolf.getPositionZ() - homeZ)).toBeLessThan(2.0);
    expect(wolf.hasUnitState(UNIT_STATE_EVADE)).toBe(false);
    expect(wolf.getMotionMaster().getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
    expect(wolf.movespline.finalized()).toBe(true);
    expect(combat.creature(WOLF.guid)?.threat.size ?? 0).toBe(0);
    expect(combat.inCombat(7)).toBe(false);
    expect(now).toBeGreaterThan(0);
  });

  test("the wolf walks home when the player dies", () => {
    seedRandom(11);
    const { wolf, combat } = start(wolfRows({ MovementType: 0, wander_distance: 0 }));
    const px = WOLF.x + 10;
    const py = WOLF.y + 6;
    const { session } = joinWorld(8, px, py, ground(px, py), combat);
    const player = testCombatPlayer(8, { x: px, y: py, z: ground(px, py), o: 0 }, melee({ damage: () => ({ min: 0, max: 0, school: 0 }) }), session);
    combat.addPlayer(player);
    let now = runFor(combat, wolf, 2_000_000, 4000);
    expect(combat.creature(WOLF.guid)!.victim).toBe(8);
    expect(wolf.getMotionMaster().getCurrentMovementGeneratorType()).not.toBe(IDLE_MOTION_TYPE);
    // the creature kills the player: it leaves combat and goes home (`CreatureAI::EnterEvadeMode` -> `MoveTargetedHome`)
    player.hp = 0;
    player.dead = true;
    combat.playerDied(8);
    movePlayer(session, px, py, ground(px, py), 0);
    let homeStarted = false;
    now = runFor(combat, wolf, now + STEP_MS, 20_000, () => {
      if (wolf.getMotionMaster().getCurrentMovementGeneratorType() === HOME_MOTION_TYPE) homeStarted = true;
    });
    expect(homeStarted).toBe(true);
    expect(dist2d(wolf.getPositionX(), wolf.getPositionY(), WOLF.x, WOLF.y)).toBeLessThan(1.0);
    expect(wolf.hasUnitState(UNIT_STATE_EVADE)).toBe(false);
  });

  test("the wolf walks home when the player it chases leaves the world", () => {
    seedRandom(13);
    const { wolf, combat } = start(wolfRows({ MovementType: 0, wander_distance: 0 }));
    const px = WOLF.x - 14;
    const py = WOLF.y - 4;
    const { session } = joinWorld(14, px, py, ground(px, py), combat);
    const player = testCombatPlayer(14, { x: px, y: py, z: ground(px, py), o: 0 }, melee({ damage: () => ({ min: 0, max: 0, school: 0 }) }), session);
    combat.addPlayer(player);
    let now = runFor(combat, wolf, 6_000_000, 2000);
    expect(combat.creature(WOLF.guid)!.victim).toBe(14);
    expect(wolf.getMotionMaster().getCurrentMovementGeneratorType()).not.toBe(IDLE_MOTION_TYPE);
    // logout: `Map::RemovePlayerFromMap` (the followers of the player drop their target) and `CombatWorld.removePlayer`
    removeFromMap(session.asSession(), false);
    combat.removePlayer(14);
    let homeStarted = false;
    now = runFor(combat, wolf, now + STEP_MS, 20_000, () => {
      if (wolf.getMotionMaster().getCurrentMovementGeneratorType() === HOME_MOTION_TYPE) homeStarted = true;
    });
    expect(homeStarted).toBe(true);
    expect(dist2d(wolf.getPositionX(), wolf.getPositionY(), WOLF.x, WOLF.y)).toBeLessThan(1.0);
    expect(wolf.hasUnitState(UNIT_STATE_EVADE)).toBe(false);
    expect(wolf.getMotionMaster().getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
    expect(now).toBeGreaterThan(0);
  });

  test("a wandering wolf stays within its wander distance of home and keeps moving", () => {
    seedRandom(3);
    // faction 35 is friendly to everyone: no combat, only `RandomMovementGenerator`
    const { wolf, map } = start(wolfRows({ MovementType: 1, wander_distance: 10 }, 35));
    expect(wolf.getDefaultMovementType()).toBe(RANDOM_MOTION_TYPE);
    expect(wolf.getMotionMaster().getCurrentMovementGeneratorType()).toBe(RANDOM_MOTION_TYPE);
    const px = WOLF.x - 25;
    const py = WOLF.y;
    const { session } = joinWorld(9, px, py, ground(px, py));

    let farthest = 0;
    let steps = 0;
    const stops = new Set<string>();
    let lastX = wolf.getPositionX();
    let lastY = wolf.getPositionY();
    runFor(null, wolf, 3_000_000, 90_000, (tick) => {
      farthest = Math.max(farthest, dist2d(tick.x, tick.y, WOLF.x, WOLF.y));
      if (tick.x !== lastX || tick.y !== lastY) ++steps;
      lastX = tick.x;
      lastY = tick.y;
      if (wolf.movespline.finalized()) stops.add(`${Math.round(tick.x)},${Math.round(tick.y)}`);
      expect(Math.abs(tick.z - map.getHeight(1, tick.x, tick.y, tick.z + 3))).toBeLessThan(2.0);
    });
    expect(steps).toBeGreaterThan(40);
    expect(farthest).toBeGreaterThan(1.5);
    // `wander_distance` 10, plus the nav mesh polygon snap
    expect(farthest).toBeLessThan(10 + 2.5);
    expect(stops.size).toBeGreaterThan(1);
    // the nearby player received its splines
    expect(session.count(SMSG_MONSTER_MOVE)).toBeGreaterThan(2);
  });

  test("a wolf on a waypoint path visits the nodes in order and waits at each", () => {
    seedRandom(5);
    const pathId = 90_001;
    const nodes = [
      { x: WOLF.x + 10, y: WOLF.y, delay: 1500 },
      { x: WOLF.x + 10, y: WOLF.y + 10, delay: 1500 },
      { x: WOLF.x, y: WOLF.y + 10, delay: 1500 },
      { x: WOLF.x - 6, y: WOLF.y + 4, delay: 1500 },
    ].map((node) => ({ ...node, z: ground(node.x, node.y) }));
    const rows = wolfRows({ MovementType: 2, wander_distance: 0 }, 35);
    addRows(rows, w.creature_addon, { guid: WOLF.guid, path_id: pathId, mount: 0, bytes1: 0, bytes2: 0, emote: 0, visibilityDistanceType: 0, auras: null });
    addRows(
      rows,
      w.waypoint_data,
      ...nodes.map((node, index) => ({ id: pathId, point: index + 1, position_x: node.x, position_y: node.y, position_z: node.z, orientation: null, delay: node.delay, move_type: 0, action: 0, action_chance: 100, velocity: 0, smoothTransition: 0 })),
    );
    const { wolf } = start(rows);
    expect(wolf.getDefaultMovementType()).toBe(WAYPOINT_MOTION_TYPE);
    expect(wolf.getWaypointPath()).toBe(pathId);
    expect(wolf.getMotionMaster().getCurrentMovementGeneratorType()).toBe(WAYPOINT_MOTION_TYPE);
    const px = WOLF.x - 20;
    const { session } = joinWorld(10, px, WOLF.y, ground(px, WOLF.y));

    const firstVisit = new Map<number, number>();
    const waited = new Map<number, number>();
    const seen: number[] = [];
    let atNodeSince: { node: number; since: number } | null = null;
    runFor(null, wolf, 4_000_000, 40_000, (tick) => {
      nodes.forEach((node, index) => {
        if (dist2d(tick.x, tick.y, node.x, node.y) < 0.6) {
          if (!firstVisit.has(index)) firstVisit.set(index, tick.now);
          if (!atNodeSince || atNodeSince.node !== index) atNodeSince = { node: index, since: tick.now };
          waited.set(index, Math.max(waited.get(index) ?? 0, tick.now - atNodeSince.since));
        }
      });
      const id = wolf.getCurrentWaypointID();
      if (seen[seen.length - 1] !== id) seen.push(id);
    });
    // every node was reached, in order, and the creature stood there for the delay of the node
    expect([...firstVisit.keys()].sort()).toEqual([0, 1, 2, 3]);
    const times = [0, 1, 2, 3].map((index) => firstVisit.get(index)!);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const index of [0, 1, 2]) expect(waited.get(index)!).toBeGreaterThanOrEqual(1000);
    // `Creature::UpdateWaypointID` followed the path (`1 2 3 4`, then the path repeats from the first node)
    expect(seen.slice(0, 5)).toEqual(expect.arrayContaining([1, 2, 3, 4]));
    expect(session.count(SMSG_MONSTER_MOVE)).toBeGreaterThan(3);
  });

  test("the create block of a creature in mid-move carries its spline, the one a second player gets from the grid notifiers", () => {
    seedRandom(7);
    const { wolf, combat } = start(wolfRows({ MovementType: 0, wander_distance: 0 }));
    const px = WOLF.x - 14;
    const py = WOLF.y - 4;
    const first = joinWorld(11, px, py, ground(px, py), combat);
    const player = testCombatPlayer(11, { x: px, y: py, z: ground(px, py), o: 0 }, melee({ damage: () => ({ min: 0, max: 0, school: 0 }) }), first.session);
    combat.addPlayer(player);
    runFor(combat, wolf, 5_000_000, 1500);
    expect(wolf.movespline.finalized()).toBe(false);
    expect(wolf.getUnitMovementFlags() & MOVEMENTFLAG_SPLINE_ENABLED).toBeTruthy();

    // a second player arrives while it runs: the grid notifiers send it the create block
    const second = joinWorld(12, WOLF.x + 12, WOLF.y + 12, ground(WOLF.x + 12, WOLF.y + 12), combat);
    const updates = second.session.payloads(SMSG_UPDATE_OBJECT);
    expect(updates.length).toBeGreaterThan(0);
    const block = createBlockOf(wolf, second.player as never);
    const parsed = parseCreateSpline(block);
    expect(parsed.movementFlags & MOVEMENTFLAG_SPLINE_ENABLED).toBeTruthy();
    expect(parsed.splineId).toBe(wolf.movespline.getId());
    expect(parsed.nodes).toBe(wolf.movespline.getPath().length);
    expect(parsed.nodes).toBeGreaterThanOrEqual(2);
    expect(parsed.destination[0]).toBeCloseTo(wolf.movespline.finalDestination().x, 2);
    expect(parsed.destination[1]).toBeCloseTo(wolf.movespline.finalDestination().y, 2);
    expect(parsed.duration).toBe(wolf.movespline.duration());
    expect(parsed.position[0]).toBeCloseTo(wolf.getPositionX(), 3);
    // and the payload really sent to the second player has the same movement block
    expect(updates.some((payload) => containsU32(payload, parsed.movementFlags))).toBe(true);
  });
});

/** The create block `Object::BuildCreateUpdateBlockForPlayer` makes for a player (`UpdateData` of one block). */
function createBlockOf(creature: Creature, target: Parameters<Creature["buildCreateUpdateBlockForPlayer"]>[1]): Uint8Array {
  const update = new UpdateData();
  creature.buildCreateUpdateBlockForPlayer(update, target);
  const packet = update.buildPacket();
  // the update packet: block count, then the block
  return packet.payload.slice(4);
}

/** The movement block of a creature create block: flags, position, speeds, and the spline `PacketBuilder::WriteCreate` writes. */
function parseCreateSpline(block: Uint8Array): { movementFlags: number; position: [number, number, number]; splineId: number; nodes: number; duration: number; destination: [number, number, number] } {
  const reader = new ByteReader(block);
  reader.readU8(); // update type
  const mask = reader.readU8();
  for (let bit = 0; bit < 8; bit++) if (mask & (1 << bit)) reader.readU8();
  reader.readU8(); // type id
  reader.readU16(); // update flags
  const movementFlags = reader.readU32();
  reader.readU16();
  reader.readU32(); // time
  const position: [number, number, number] = [reader.readF32(), reader.readF32(), reader.readF32()];
  reader.readF32(); // orientation
  if (movementFlags & (0x00200000 | 0x02000000)) reader.readF32(); // pitch
  reader.readU32(); // fall time
  if (movementFlags & 0x00001000) for (let i = 0; i < 4; i++) reader.readF32();
  if (movementFlags & 0x04000000) reader.readF32();
  for (let i = 0; i < 9; i++) reader.readF32(); // speeds
  const splineFlags = reader.readU32();
  if (splineFlags & 0x00020000) reader.readF32(); // final angle
  else if (splineFlags & 0x00010000) reader.readU64(); // final target
  else if (splineFlags & 0x00008000) for (let i = 0; i < 3; i++) reader.readF32(); // final point
  reader.readU32(); // time passed
  const duration = reader.readU32();
  const splineId = reader.readU32();
  reader.readF32();
  reader.readF32();
  reader.readF32();
  reader.readU32();
  const nodes = reader.readU32();
  for (let i = 0; i < nodes * 3; i++) reader.readF32();
  reader.readU8(); // spline mode
  const destination: [number, number, number] = [reader.readF32(), reader.readF32(), reader.readF32()];
  return { movementFlags, position, splineId, nodes, duration, destination };
}

function containsU32(payload: Uint8Array, value: number): boolean {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let i = 0; i + 4 <= payload.byteLength; i++) if (view.getUint32(i, true) === value >>> 0) return true;
  return false;
}
