import { afterEach, expect, test } from "bun:test";
import type { Socket } from "bun";
import type { CreatureSpawn, CreatureTemplate, GameObjectSpawn, GameObjectTemplate, ItemTemplate, WorldData } from "../data/world.ts";
import { WorldCrypt } from "../crypto/world-crypt.ts";
import { seededTestDatabases } from "../database/test-db.ts";
import { saveSessionKey } from "../db.ts";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import {
  authSeed,
  CMSG_AUTH_SESSION,
  CMSG_CHAR_ENUM,
  CMSG_CREATURE_QUERY,
  CMSG_ITEM_QUERY_SINGLE,
  encodeClientPacket,
  sessionDigest,
  SMSG_AUTH_CHALLENGE,
  SMSG_AUTH_RESPONSE,
  SMSG_CHAR_ENUM,
  SMSG_CREATURE_QUERY_RESPONSE,
  SMSG_ITEM_QUERY_SINGLE_RESPONSE,
  SMSG_UPDATE_OBJECT,
} from "./packets.ts";
import { CMSG_PLAYER_LOGIN } from "./opcodes.ts";
import { creatureCreateBlock, creatureGuid, creatureQueryPayload, gameObjectCreateBlock, gameObjectQueryPayload, itemQueryPayload } from "./spawn.ts";
import { startWorldServer } from "./server.ts";
import { WorldSession } from "./session.ts";
import { advanceMaps, setUpTestMapWorld, tearDownTestMapWorld } from "./map-world.test-util.ts";
import { addRows, creatureRow, gameObjectRow, loadSpawnFixture, worldSchema as w } from "../game/Maps/SpawnData.test-util.ts";
import { sMapMgr } from "../game/Maps/MapMgr.ts";
import type { MySqlTable } from "drizzle-orm/mysql-core";

const START = { map: 0, x: -8949.95, y: -132.493, z: 83.5312 };

test("query and create packets follow the 3.3.5 layout", () => {
  const world = fakeWorld();
  const creature = creatureQueryPayload(world, 197);
  const creatureReader = new ByteReader(creature);
  expect(creatureReader.readU32()).toBe(197);
  expect(creatureReader.readCString()).toBe("Marshal McBride");
  expect(creatureReader.readU8()).toBe(0);
  expect(creatureReader.readU8()).toBe(0);
  expect(creatureReader.readU8()).toBe(0);
  expect(creatureReader.readCString()).toBe("Abbey");
  expect(creatureReader.readCString()).toBe("");
  expect(creatureReader.readU32()).toBe(0);
  expect(creatureReader.readU32()).toBe(7);
  expect(creatureReader.readU32()).toBe(0);
  expect(creatureReader.readU32()).toBe(0);
  expect(creatureReader.readU32()).toBe(0);
  expect(creatureReader.readU32()).toBe(0);
  expect([creatureReader.readU32(), creatureReader.readU32(), creatureReader.readU32(), creatureReader.readU32()]).toEqual([1859, 0, 0, 0]);
  expect(creatureReader.readF32()).toBeCloseTo(1);
  expect(creatureReader.readF32()).toBeCloseTo(1);
  expect(creatureReader.readU8()).toBe(0);
  expect(new ByteReader(creatureQueryPayload(world, 999)).readU32()).toBe((999 | 0x80000000) >>> 0);

  const object = gameObjectQueryPayload(world, 50);
  const objectReader = new ByteReader(object);
  expect(objectReader.readU32()).toBe(50);
  expect(objectReader.readU32()).toBe(6);
  expect(objectReader.readU32()).toBe(99);
  expect(objectReader.readCString()).toBe("Trap");

  const item = itemQueryPayload(world, 1899);
  const itemReader = new ByteReader(item);
  expect(itemReader.readU32()).toBe(1899);
  expect(itemReader.readU32()).toBe(2);
  expect(itemReader.readU32()).toBe(7);
  expect(itemReader.readU32()).toBe(0xffffffff);
  expect(itemReader.readCString()).toBe("Monster - Sword, Long Basic");
  expect(itemQueryPayload(world, 1).byteLength).toBe(4);

  const created = creatureCreateBlock(spawn(1, 197, START.x, START.y, START.z), mcbride(), world);
  expect(created[0]).toBe(2);
  expect(containsU32(created, 1859)).toBe(true);
  expect(containsU32(created, 1899)).toBe(true);
  expect(creatureGuid(197, 1)).toBe(1n | (197n << 24n) | (0xf130n << 48n));

  const trap = gameObjectCreateBlock(objectSpawn(10, 50, START.x, START.y, START.z), trapTemplate());
  expect(trap[0]).toBe(3);
  const chest = gameObjectCreateBlock(objectSpawn(11, 51, START.x, START.y, START.z), { ...trapTemplate(), entry: 51, type: 3, name: "Chest" });
  expect(chest[0]).toBe(2);
});

afterEach(() => {
  tearDownTestMapWorld();
});

/**
 * Marshal McBride spawned four times and a trap, in `creature` / `gameobject` rows the map layer loads:
 * 1 next to the start, 2 four hundred yards away, 3 for the heroic spawn mode only, 4 in phase 2; the trap 10 yards away.
 */
function spawnWorld(): WorldData {
  const rows = new Map<MySqlTable, Record<string, unknown>[]>();
  addRows(rows, w.creature_template, { entry: 197, name: "Marshal McBride", subname: "Abbey", minlevel: 5, maxlevel: 5, faction: 12, npcflag: 2, unit_class: 1, type: 7, speed_walk: 1, speed_run: 1.14286 });
  addRows(rows, w.creature_template_model, { CreatureID: 197, Idx: 0, CreatureDisplayID: 1859, DisplayScale: 1, Probability: 1 });
  addRows(
    rows,
    w.creature,
    creatureRow(1, 197, 0, START.x, START.y),
    creatureRow(2, 197, 0, START.x + 400, START.y),
    creatureRow(3, 197, 0, START.x, START.y, { spawnMask: 2 }),
    creatureRow(4, 197, 0, START.x, START.y, { phaseMask: 2 }),
  );
  addRows(rows, w.gameobject_template, { entry: 50, type: 6, displayId: 100, name: "Trap", size: 1 });
  addRows(rows, w.gameobject, gameObjectRow(8, 50, 0, START.x + 10, START.y));
  const { world } = loadSpawnFixture(rows);
  setUpTestMapWorld(world);
  return world;
}

/** The blocks of the `SMSG_UPDATE_OBJECT` packets in a list of encoded packets, and the out of range guids they carry. */
function updateBlocks(packets: Uint8Array[]): { creates: number; gone: number } {
  let creates = 0;
  let gone = 0;
  for (const packet of packets) {
    if ((packet[2]! | (packet[3]! << 8)) !== SMSG_UPDATE_OBJECT) continue;
    const reader = new ByteReader(packet.slice(4));
    const count = reader.readU32();
    // the creature and gameobject create blocks start with the update type
    const type = reader.readU8();
    if (type === 4) gone += reader.readU32();
    else creates += count;
  }
  return { creates, gone };
}

test("a player sees what is within the visibility range, in its phase, in the spawn mode of the map", async () => {
  const world = spawnWorld();
  const sessionKey = crypto.getRandomValues(new Uint8Array(40));
  const db = await seededTestDatabases(world.tables());
  await saveSessionKey(db.login, "TEST", sessionKey);
  const session = new WorldSession(db, world);
  const delivered: Uint8Array[] = [];
  session.attach((packet) => delivered.push(packet));
  const clientSeed = Uint8Array.from([1, 2, 3, 4]);
  const digest = sessionDigest("TEST", clientSeed, authSeed(session.greeting), sessionKey);
  await session.handle(CMSG_AUTH_SESSION, authSession("TEST", clientSeed, digest));
  const entered = await session.handle(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array());

  // creature 1 and the trap: the one within 100 yards, in phase 1, in the normal spawn mode (3, 4, and 2 are not)
  const visible = session.mapPlayer!.getObjectVisibilityContainer().getVisibleWorldObjectsMap()!;
  expect([...visible.keys()].sort()).toEqual([creatureGuid(197, 1), gameObjectGuidOf(50, 8)].sort());
  // after the self block of the burst the update that creates them
  // (the login burst has the player's own block, then the trap and the creature)
  expect(updateBlocks(entered.packets).creates).toBe(3);
  // the grids hold the spawns of the normal mode of the map; the creature in another phase is loaded but not seen
  const map = sMapMgr().findBaseMap(0)!;
  expect(map.getCreatureBySpawnIdStore().get(3)).toBeUndefined();
  expect(map.getCreatureBySpawnIdStore().get(4)).toHaveLength(1);
  expect(map.getCreatureBySpawnIdStore().get(2)).toHaveLength(1);
  expect(session.mapPlayer!.haveAtClient(creatureGuid(197, 4))).toBe(false);

  // walk 800 yards away: after the visibility delay they are destroyed
  delivered.length = 0;
  await session.handle(0x0ee, movement(1n, START.x + 800, START.y, START.z));
  expect(delivered).toHaveLength(0); // nothing yet: `AddToNotify` delays the update
  advanceMaps(500);
  expect(updateBlocks(delivered).gone).toBe(2);
  expect(visible.size).toBe(0);

  // and back: they are created again
  delivered.length = 0;
  await session.handle(0x0ee, movement(1n, START.x, START.y, START.z));
  advanceMaps(500);
  expect(updateBlocks(delivered).creates).toBe(2);
  expect(visible.has(creatureGuid(197, 1))).toBe(true);
  await session.disconnect();
});

test("a creature flagged far visible is seen from beyond the normal range", async () => {
  const rows = new Map<MySqlTable, Record<string, unknown>[]>();
  for (const entry of [197, 198]) {
    addRows(rows, w.creature_template, { entry, name: `creature ${entry}`, minlevel: 5, maxlevel: 5, faction: 12, unit_class: 1, speed_walk: 1, speed_run: 1 });
    addRows(rows, w.creature_template_model, { CreatureID: entry, Idx: 0, CreatureDisplayID: 1000 + entry, DisplayScale: 1, Probability: 1 });
  }
  // 150 yards away: past the 100 yards of a normal creature, within the 200 of a "large" one
  addRows(rows, w.creature, creatureRow(1, 197, 0, START.x + 150, START.y), creatureRow(2, 198, 0, START.x + 150, START.y));
  addRows(rows, w.creature_template_addon, { entry: 198, path_id: 0, mount: 0, bytes1: 0, bytes2: 0, emote: 0, visibilityDistanceType: 3, auras: null });
  const { world } = loadSpawnFixture(rows);
  setUpTestMapWorld(world);
  const sessionKey = crypto.getRandomValues(new Uint8Array(40));
  const db = await seededTestDatabases(world.tables());
  await saveSessionKey(db.login, "TEST", sessionKey);
  const session = new WorldSession(db, world);
  const clientSeed = Uint8Array.from([1, 2, 3, 4]);
  await session.handle(CMSG_AUTH_SESSION, authSession("TEST", clientSeed, sessionDigest("TEST", clientSeed, authSeed(session.greeting), sessionKey)));
  await session.handle(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array());
  const visible = session.mapPlayer!.getObjectVisibilityContainer().getVisibleWorldObjectsMap()!;
  expect([...visible.keys()]).toEqual([creatureGuid(198, 2)]);
  await session.disconnect();
});

function gameObjectGuidOf(entry: number, spawnId: number): bigint {
  return BigInt(spawnId) | (BigInt(entry) << 24n) | (0xf110n << 48n);
}

function authSession(username: string, clientSeed: Uint8Array, digest: Uint8Array): Uint8Array {
  return new ByteWriter()
    .writeU32(12340)
    .writeU32(0)
    .writeCString(username)
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

function movement(guid: bigint, x: number, y: number, z: number): Uint8Array {
  return new ByteWriter()
    .writeU8(0x01)
    .writeU8(Number(guid & 0xffn))
    .writeU32(0)
    .writeU16(0)
    .writeU32(1)
    .writeF32(x)
    .writeF32(y)
    .writeF32(z)
    .writeF32(0)
    .writeU32(0)
    .toUint8Array();
}

test("login sends the creatures standing next to the character", async () => {
  const sessionKey = new Uint8Array(40);
  crypto.getRandomValues(sessionKey);
  const db = await seededTestDatabases();
  await saveSessionKey(db.login, "TEST", sessionKey);
  const server = startWorldServer({ hostname: "127.0.0.1", port: 0, db, world: spawnWorld() });
  const client = await connect(server.port ?? 0);
  const crypt = await login(client, sessionKey);

  client.send(encodeClientPacket(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array(), crypt));
  // the burst (17 packets), then what the player sees: the trap (`UpdateVisibilityForPlayer`) and the creature (the relocation
  // notifier), and `Player::UpdateZone`'s world states
  let spawn: Uint8Array | null = null;
  for (let index = 0; index < 19; index++) {
    const packet = await readServerPacket(client, crypt);
    if (index === 18) spawn = packet.payload;
    if (index >= 17) expect(packet.opcode).toBe(SMSG_UPDATE_OBJECT);
  }
  expect(spawn).not.toBeNull();
  expect(new ByteReader(spawn!).readU32()).toBe(1);
  expect(containsU32(spawn!, 1859)).toBe(true);
  expect((await readServerPacket(client, crypt)).opcode).toBe(0x2c2);

  client.send(encodeClientPacket(CMSG_CREATURE_QUERY, new ByteWriter().writeU32(197).writeU64(creatureGuid(197, 1)).toUint8Array(), crypt));
  const query = await readServerPacket(client, crypt);
  expect(query.opcode).toBe(SMSG_CREATURE_QUERY_RESPONSE);
  expect(new ByteReader(query.payload).readU32()).toBe(197);

  client.send(encodeClientPacket(CMSG_ITEM_QUERY_SINGLE, new ByteWriter().writeU32(1899).toUint8Array(), crypt));
  const item = await readServerPacket(client, crypt);
  expect(item.opcode).toBe(SMSG_ITEM_QUERY_SINGLE_RESPONSE);
  // the world of this test has no item 1899: the "not found" form of the answer
  expect(new ByteReader(item.payload).readU32()).toBe((1899 | 0x80000000) >>> 0);

  client.close();
  server.stop(true);
});

function fakeWorld(): WorldData {
  const creatures = [
    spawn(1, 197, START.x, START.y, START.z),
    spawn(2, 197, START.x + 400, START.y, START.z),
    spawn(3, 197, START.x, START.y, START.z, { spawnMask: 2 }),
    spawn(4, 197, START.x, START.y, START.z, { phaseMask: 2 }),
  ];
  const objects = [objectSpawn(8, 50, START.x + 10, START.y, START.z)];
  const templates = new Map<number, CreatureTemplate>([[197, mcbride()]]);
  const objectTemplates = new Map<number, GameObjectTemplate>([[50, trapTemplate()]]);
  const items = new Map<number, ItemTemplate>([[1899, sword()]]);
  return {
    creaturesOnMap: creatures,
    gameObjectsOnMap: objects,
    creatureTemplate: (entry: number) => templates.get(entry),
    creatureClassLevelStats: () => null,
    gameObjectTemplate: (entry: number) => objectTemplates.get(entry),
    itemTemplate: (entry: number) => items.get(entry),
    playerStart: () => null,
    questItems: () => [0, 0, 0, 0, 0, 0],
  } as unknown as WorldData;
}

function mcbride(): CreatureTemplate {
  return {
    entry: 197,
    name: "Marshal McBride",
    subName: "Abbey",
    iconName: "",
    minLevel: 5,
    maxLevel: 5,
    expansion: 0,
    faction: 12,
    npcFlags: 2,
    gossipMenuId: 0,
    unitClass: 1,
    unitFlags: 0,
    unitFlags2: 0,
    dynamicFlags: 0,
    family: 0,
    type: 7,
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
    speedRun: 1.14286,
    speedSwim: 1,
    speedFlight: 1,
    hoverHeight: 1,
    models: [{ idx: 0, displayId: 1859, scale: 1, boundingRadius: 0.4, combatReach: 1.6, gender: 0 }],
    equipment: [{ id: 1, items: [1899, 143, 0] }],
  };
}

function trapTemplate(): GameObjectTemplate {
  return {
    entry: 50,
    type: 6,
    displayId: 99,
    name: "Trap",
    iconName: "",
    castBarCaption: "",
    unk1: "",
    size: 1,
    data: Array.from({ length: 24 }, () => 0),
  };
}

function sword(): ItemTemplate {
  return {
    entry: 1899,
    classId: 2,
    subclass: 7,
    soundOverrideSubclass: -1,
    name: "Monster - Sword, Long Basic",
    displayId: 7483,
    quality: 0,
    flags: 0,
    flags2: 0,
    buyPrice: 0,
    sellPrice: 0,
    inventoryType: 13,
    allowableClass: -1,
    allowableRace: -1,
    itemLevel: 1,
    requiredLevel: 0,
    requiredSkill: 0,
    requiredSkillRank: 0,
    requiredSpell: 0,
    requiredHonorRank: 0,
    requiredCityRank: 0,
    requiredReputationFaction: 0,
    requiredReputationRank: 0,
    maxCount: 0,
    stackable: 1,
    containerSlots: 0,
    stats: [],
    scalingStatDistribution: 0,
    scalingStatValue: 0,
    damages: [
      { min: 0, max: 0, type: 0 },
      { min: 0, max: 0, type: 0 },
    ],
    armor: 0,
    resistances: [0, 0, 0, 0, 0, 0],
    delay: 2000,
    ammoType: 0,
    rangedModRange: 0,
    spells: Array.from({ length: 5 }, () => ({ id: 0, trigger: 0, charges: 0, cooldown: -1, category: 0, categoryCooldown: -1 })),
    bonding: 0,
    description: "",
    pageText: 0,
    languageId: 0,
    pageMaterial: 0,
    startQuest: 0,
    lockId: 0,
    material: 0,
    sheath: 3,
    randomProperty: 0,
    randomSuffix: 0,
    block: 0,
    itemSet: 0,
    maxDurability: 0,
    area: 0,
    map: 0,
    bagFamily: 0,
    totemCategory: 0,
    sockets: [
      { color: 0, content: 0 },
      { color: 0, content: 0 },
      { color: 0, content: 0 },
    ],
    socketBonus: 0,
    gemProperties: 0,
    requiredDisenchantSkill: -1,
    armorDamageModifier: 0,
    duration: 0,
    itemLimitCategory: 0,
    holidayId: 0,
  };
}

function spawn(guid: number, entry: number, x: number, y: number, z: number, extra?: Partial<CreatureSpawn>): CreatureSpawn {
  return {
    guid,
    entry,
    map: 0,
    x,
    y,
    z,
    orientation: 0,
    spawnMask: 1,
    phaseMask: 1,
    equipmentId: 1,
    health: 100,
    mana: 0,
    npcFlags: 0,
    unitFlags: 0,
    dynamicFlags: 0,
    ...extra,
  };
}

function objectSpawn(guid: number, entry: number, x: number, y: number, z: number): GameObjectSpawn {
  return {
    guid,
    entry,
    map: 0,
    x,
    y,
    z,
    orientation: 0,
    rotation: [0, 0, 0, 1],
    spawnMask: 1,
    phaseMask: 1,
    animProgress: 255,
    state: 1,
  };
}

function containsU32(bytes: Uint8Array, value: number): boolean {
  for (let index = 0; index + 4 <= bytes.length; index++) {
    const found = bytes[index]! | (bytes[index + 1]! << 8) | (bytes[index + 2]! << 16) | (bytes[index + 3]! << 24);
    if ((found >>> 0) === value) {
      return true;
    }
  }
  return false;
}

async function login(client: TestClient, sessionKey: Uint8Array): Promise<WorldCrypt> {
  const challenge = await readServerPacket(client, null);
  expect(challenge.opcode).toBe(SMSG_AUTH_CHALLENGE);
  const clientSeed = Uint8Array.from([1, 2, 3, 4]);
  client.send(
    encodeClientPacket(
      CMSG_AUTH_SESSION,
      new ByteWriter()
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
        .writeBytes(sessionDigest("TEST", clientSeed, authSeed(challenge.raw), sessionKey))
        .writeU32(0)
        .toUint8Array(),
      null,
    ),
  );
  const crypt = new WorldCrypt(sessionKey, "client");
  const response = await readServerPacket(client, crypt);
  expect(response.opcode).toBe(SMSG_AUTH_RESPONSE);
  await readServerPacket(client, crypt);
  await readServerPacket(client, crypt);
  await readServerPacket(client, crypt);
  client.send(encodeClientPacket(CMSG_CHAR_ENUM, new Uint8Array(0), crypt));
  const characters = await readServerPacket(client, crypt);
  expect(characters.opcode).toBe(SMSG_CHAR_ENUM);
  return crypt;
}

type ServerPacket = { opcode: number; payload: Uint8Array; raw: Uint8Array };

async function readServerPacket(client: TestClient, crypt: WorldCrypt | null): Promise<ServerPacket> {
  let header = await client.read(4);
  crypt?.decryptHeader(header);
  if ((header[0]! & 0x80) !== 0) {
    // `ServerPktHeader` for packets over 0x7FFF bytes: a 3-byte size, decrypted as one stream with the rest.
    const last = await client.read(1);
    crypt?.decryptHeader(last);
    header = Uint8Array.of(...header, last[0]!);
  }
  const large = header.length === 5;
  const size = large ? ((header[0]! & 0x7f) << 16) | (header[1]! << 8) | header[2]! : (header[0]! << 8) | header[1]!;
  const opcode = large ? header[3]! | (header[4]! << 8) : header[2]! | (header[3]! << 8);
  const payload = await client.read(size - 2);
  const raw = new Uint8Array(header.length + payload.length);
  raw.set(header, 0);
  raw.set(payload, header.length);
  return { opcode, payload, raw };
}

type TestClient = {
  send: (packet: Uint8Array) => void;
  read: (length: number) => Promise<Uint8Array>;
  close: () => void;
};

async function connect(port: number): Promise<TestClient> {
  let pending = new Uint8Array(0);
  let notify: (() => void) | null = null;
  const socket = await Bun.connect<undefined>({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket: Socket<undefined>, data: Uint8Array) {
        const next = new Uint8Array(pending.length + data.length);
        next.set(pending, 0);
        next.set(data, pending.length);
        pending = next;
        notify?.();
        notify = null;
      },
      open() {},
      close() {},
      drain() {},
      error() {},
      connectError() {},
      end() {},
    },
  });
  return {
    send(packet) {
      socket.write(packet);
    },
    read(length) {
      return new Promise((resolve) => {
        const take = () => {
          if (pending.length < length) {
            notify = take;
            return;
          }
          const out = pending.slice(0, length);
          pending = pending.subarray(length);
          resolve(out);
        };
        take();
      });
    },
    close() {
      socket.end();
    },
  };
}
