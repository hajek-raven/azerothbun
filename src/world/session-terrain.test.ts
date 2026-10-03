/**
 * The map data side of a session's player: the zone and area from the `.map` file under the character, the explored zone
 * bits and exploration experience on movement, and the fall below the map.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../common/Collision/test-fixtures.ts";
import { SMSG_EXPLORATION_EXPERIENCE } from "../characters/experience.ts";
import { PLAYER_FLAGS_IS_OUT_OF_BOUNDS } from "../game/Entities/Player/PlayerDefines.ts";
import { PLAYER_EXPLORED_ZONES_1 } from "../gen/UpdateFields.gen.ts";
import { defaultPlayerEnvironment } from "../characters/player-env.ts";
import { acoreWorldData } from "../data/test-world-data.ts";
import { seededTestDatabases } from "../database/test-db.ts";
import { setDatabaseEnv } from "../database/DatabaseEnv.ts";
import { saveSessionKey } from "../db.ts";
import { sAreaTableStore } from "../game/DataStores/DBCStores.ts";
import { resetMapDBCStores } from "../game/DataStores/MapDBCStores.ts";
import { sObjectMgr } from "../game/Globals/ObjectMgr.ts";
import { ComputeGridCoord } from "../game/Grids/GridDefines.ts";
import { clearSharedGridTerrainData, GridTerrainLoaderHooks } from "../game/Grids/GridTerrainLoader.ts";
import { buildMapFile } from "../game/Grids/GridTerrainData.test-util.ts";
import { MAP_COMMON, setMapEntry } from "../game/Maps/Map.test-util.ts";
import { sMapMgr } from "../game/Maps/MapMgr.ts";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import { CMSG_PLAYER_LOGIN } from "./opcodes.ts";
import { authSeed, CMSG_AUTH_SESSION, sessionDigest } from "./packets.ts";
import { WorldSession } from "./session.ts";
import { relocateOnMap } from "./session-map.ts";
import { PLAYER_EXPLORED_ZONES_SIZE, SMSG_INIT_WORLD_STATES } from "../game/Entities/Player/PlayerUpdates.ts";

const SMSG_ENVIRONMENTAL_DAMAGE_LOG = 0x1fc;
const MSG_MOVE_HEARTBEAT = 0x0ee;
const CMSG_ZONEUPDATE = 0x1f4;

const START = { x: -8949.95, y: -132.493, z: 83.5312 };
const ZONE = 9;
const AREA_VALLEY = 9;
const AREA_ABBEY = 24;
const GROUND = 80;

const tmp = makeTempDir("session-terrain-test-");
const savedPath = GridTerrainLoaderHooks.getDataPath;
const grid = ComputeGridCoord(START.x, START.y);
/** A place one grid east of the start, which has the other area. */
const NEXT = { x: START.x - 540, y: START.y, z: GROUND + 1 };
const nextGrid = ComputeGridCoord(NEXT.x, NEXT.y);

function areaTable(): void {
  const area = (ID: number, zone: number, exploreFlag: number, area_level: number) =>
    sAreaTableStore.set(ID, { ID, mapid: 0, zone, exploreFlag, flags: 0, area_level, area_name: [], team: 0, LiquidTypeOverride: [0, 0, 0, 0] });
  area(ZONE, 0, 0, 0);
  area(AREA_VALLEY, ZONE, 35, 1); // field 1, bit 3
  area(AREA_ABBEY, ZONE, 36, 1); // field 1, bit 4
}

beforeAll(async () => {
  mkdirSync(join(tmp.dir, "maps"));
  const flat = (area: number) =>
    buildMapFile({
      areaIds: new Uint16Array(256).fill(area),
      height: { V9: new Float32Array(129 * 129).fill(GROUND), V8: new Float32Array(128 * 128).fill(GROUND), encoding: "flat" },
    });
  const name = (gx: number, gy: number) => `${tmp.dir}/maps/000${String(gx).padStart(2, "0")}${String(gy).padStart(2, "0")}.map`;
  await Bun.write(name(grid.x_coord, grid.y_coord), flat(AREA_VALLEY));
  await Bun.write(name(nextGrid.x_coord, nextGrid.y_coord), flat(AREA_ABBEY));
  GridTerrainLoaderHooks.getDataPath = () => `${tmp.dir}/`;
  clearSharedGridTerrainData();
  areaTable();
  setMapEntry(0, MAP_COMMON, { linked_zone: 0 });
  resetMapDBCStores();
});

afterAll(() => {
  sMapMgr().unloadAll();
  GridTerrainLoaderHooks.getDataPath = savedPath;
  clearSharedGridTerrainData();
  tmp.cleanup();
});

function authSession(clientSeed: Uint8Array, digest: Uint8Array): Uint8Array {
  return new ByteWriter()
    .writeU32(12340)
    .writeU32(0)
    .writeCString("TEST")
    .writeU32(0)
    .writeBytes(clientSeed)
    .writeU32(0)
    .writeU32(0)
    .writeU32(1)
    .writeU32(0)
    .writeU32(0)
    .writeBytes(digest)
    .writeU32(0)
    .toUint8Array();
}

function movement(x: number, y: number, z: number, flags = 0): Uint8Array {
  return new ByteWriter().writeU8(0x01).writeU8(1).writeU32(flags).writeU16(0).writeU32(1).writeF32(x).writeF32(y).writeF32(z).writeF32(0).writeU32(0).toUint8Array();
}

const opcodeOf = (packet: Uint8Array): number => packet[2]! | (packet[3]! << 8);

async function login() {
  const world = await acoreWorldData();
  sObjectMgr.setWorld(world, world.tables());
  const key = crypto.getRandomValues(new Uint8Array(40));
  const db = await seededTestDatabases(world.tables());
  setDatabaseEnv({ characters: db.characters, login: db.login });
  await saveSessionKey(db.login, "TEST", key);
  const session = new WorldSession(db, world, null, undefined, null, undefined, undefined, defaultPlayerEnvironment());
  const clientSeed = Uint8Array.of(1, 2, 3, 4);
  await session.handle(CMSG_AUTH_SESSION, authSession(clientSeed, sessionDigest("TEST", clientSeed, authSeed(session.greeting), key)));
  const entered = await session.handle(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array());
  return { session, entered };
}

describe("a session's player on map data", () => {
  test("login updates the zone from the map: the world states go out and the character is in the zone and area of its place", async () => {
    const { session, entered } = await login();
    expect(entered.packets.map(opcodeOf)).toContain(SMSG_INIT_WORLD_STATES);
    expect(session.area!.zoneUpdateId).toBe(ZONE);
    expect(session.area!.areaUpdateId).toBe(AREA_VALLEY);
    expect(session.character!.zone).toBe(ZONE);
    expect(session.playerFacade!.getAreaId()).toBe(AREA_VALLEY);
    // the world states follow the login burst: after the time sync, before the item packets
    const names = entered.sent;
    expect(names.indexOf("SMSG_INIT_WORLD_STATES")).toBeGreaterThan(names.indexOf("SMSG_TIME_SYNC_REQ"));
    await session.disconnect();
  });

  test("CMSG_ZONEUPDATE uses the server's zone, not the client's", async () => {
    const { session } = await login();
    await session.handle(CMSG_ZONEUPDATE, new ByteWriter().writeU32(1519).toUint8Array());
    expect(session.character!.zone).toBe(ZONE);
    expect(session.area!.needZoneUpdate).toBe(true);
    await session.handle(MSG_MOVE_HEARTBEAT, movement(START.x, START.y, START.z));
    expect(session.area!.needZoneUpdate).toBe(false);
    await session.disconnect();
  });

  test("walking into an area marks it explored and gives experience once", async () => {
    const { session } = await login();
    const field = (): number => session.stats!.getUInt32(PLAYER_EXPLORED_ZONES_1 + 1);
    expect(field()).toBe(0);

    const first = await session.handle(MSG_MOVE_HEARTBEAT, movement(START.x, START.y, START.z));
    expect(field()).toBe(1 << 3);
    expect(first.packets.map(opcodeOf)).toContain(SMSG_EXPLORATION_EXPERIENCE);
    const body = first.packets.find((packet) => opcodeOf(packet) === SMSG_EXPLORATION_EXPERIENCE)!.slice(4);
    const reader = new ByteReader(body);
    expect(reader.readU32()).toBe(AREA_VALLEY);
    expect(reader.readU32()).toBeGreaterThan(0);

    const again = await session.handle(MSG_MOVE_HEARTBEAT, movement(START.x, START.y, START.z));
    expect(again.packets.map(opcodeOf)).not.toContain(SMSG_EXPLORATION_EXPERIENCE);

    // the next grid is the other area
    const next = await session.handle(MSG_MOVE_HEARTBEAT, movement(NEXT.x, NEXT.y, NEXT.z));
    expect(field()).toBe((1 << 3) | (1 << 4));
    expect(next.packets.map(opcodeOf)).toContain(SMSG_EXPLORATION_EXPERIENCE);
    // `Player::_SaveCharacter` stores the field in `characters.exploredZones`
    expect(session.stats!.getUInt32(PLAYER_EXPLORED_ZONES_1 + 1)).toBe((1 << 3) | (1 << 4));
    expect(PLAYER_EXPLORED_ZONES_SIZE).toBe(128);
    await session.disconnect();
  });

  test("the timer notices a new area without a position update", async () => {
    const { session } = await login();
    session.character!.position_x = NEXT.x;
    session.character!.position_y = NEXT.y;
    session.character!.position_z = NEXT.z;
    relocateOnMap(session);
    session.update(500);
    expect(session.area!.areaUpdateId).toBe(AREA_VALLEY);
    session.update(600);
    expect(session.area!.areaUpdateId).toBe(AREA_ABBEY);
    await session.disconnect();
  });

  test("below the minimum height of the map the player falls to the void and dies", async () => {
    const { session } = await login();
    expect(session.health).toBeGreaterThan(0);
    const result = await session.handle(MSG_MOVE_HEARTBEAT, movement(START.x, START.y, -600));
    expect(result.packets.map(opcodeOf)).toContain(SMSG_ENVIRONMENTAL_DAMAGE_LOG);
    expect(session.health).toBe(0);
    expect(session.deathState).toBe("corpse");
    expect((session.character!.playerFlags & PLAYER_FLAGS_IS_OUT_OF_BOUNDS) !== 0).toBe(true);
    await session.disconnect();
  });

  test("a place without extracted data has the fixed minimum height and no zone, so the zone stays as it was", async () => {
    const { session } = await login();
    const zone = session.character!.zone;
    // `Map::GetMinHeight` is -500 without a grid
    const above = await session.handle(MSG_MOVE_HEARTBEAT, movement(START.x + 4000, START.y, -400));
    expect(above.packets.map(opcodeOf)).not.toContain(SMSG_ENVIRONMENTAL_DAMAGE_LOG);
    expect(session.health).toBeGreaterThan(0);
    // no area data there: the zone stays as it was
    session.update(1500);
    expect(session.character!.zone).toBe(zone);
    const below = await session.handle(MSG_MOVE_HEARTBEAT, movement(START.x + 4000, START.y, -600));
    expect(below.packets.map(opcodeOf)).toContain(SMSG_ENVIRONMENTAL_DAMAGE_LOG);
    await session.disconnect();
  });
});
