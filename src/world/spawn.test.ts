import { expect, test } from "bun:test";
import type { Socket } from "bun";
import type { CreatureSpawn, CreatureTemplate, GameObjectSpawn, GameObjectTemplate, ItemTemplate, WorldData } from "../data/world.ts";
import { WorldCrypt } from "../crypto/world-crypt.ts";
import { openAuthDatabase, saveSessionKey } from "../db.ts";
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
import { creatureCreateBlock, creatureGuid, creatureQueryPayload, diffVisible, gameObjectCreateBlock, gameObjectQueryPayload, indexSpawns, itemQueryPayload, spawnUpdatePayloads } from "./spawn.ts";
import { startWorldServer } from "./server.ts";

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

test("visibility matches continent range, phase, and normal spawn mask", () => {
  const world = fakeWorld();
  const index = indexSpawns(world);
  const known = new Set<bigint>();
  const first = diffVisible(index, world, START, known);
  const guids = first.creates.map((block) => block[0]);
  expect(first.creates).toHaveLength(2);
  expect(guids).toEqual([2, 3]);
  expect(first.gone).toEqual([]);
  expect(diffVisible(index, world, START, known).creates).toEqual([]);

  const left = diffVisible(index, world, { map: 0, x: START.x + 800, y: START.y, z: START.z }, known);
  expect(left.creates).toEqual([]);
  expect(left.gone).toHaveLength(2);
  const payload = spawnUpdatePayloads([], left.gone)[0]!;
  const reader = new ByteReader(payload);
  expect(reader.readU32()).toBe(1);
  expect(reader.readU8()).toBe(4);
  expect(reader.readU32()).toBe(2);
});

test("login sends the creatures standing next to the character", async () => {
  const sessionKey = new Uint8Array(40);
  crypto.getRandomValues(sessionKey);
  const db = openAuthDatabase(":memory:");
  saveSessionKey(db, "TEST", sessionKey);
  const server = startWorldServer({ hostname: "127.0.0.1", port: 0, db, world: fakeWorld() });
  const client = await connect(server.port ?? 0);
  const crypt = await login(client, sessionKey);

  client.send(encodeClientPacket(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array(), crypt));
  let spawn: Uint8Array | null = null;
  for (let index = 0; index < 18; index++) {
    const packet = await readServerPacket(client, crypt);
    if (index === 17) {
      spawn = packet.payload;
      expect(packet.opcode).toBe(SMSG_UPDATE_OBJECT);
    }
  }
  expect(spawn).not.toBeNull();
  expect(new ByteReader(spawn!).readU32()).toBe(2);
  expect(containsU32(spawn!, 1859)).toBe(true);

  client.send(encodeClientPacket(CMSG_CREATURE_QUERY, new ByteWriter().writeU32(197).writeU64(creatureGuid(197, 1)).toUint8Array(), crypt));
  const query = await readServerPacket(client, crypt);
  expect(query.opcode).toBe(SMSG_CREATURE_QUERY_RESPONSE);
  expect(new ByteReader(query.payload).readU32()).toBe(197);

  client.send(encodeClientPacket(CMSG_ITEM_QUERY_SINGLE, new ByteWriter().writeU32(1899).toUint8Array(), crypt));
  const item = await readServerPacket(client, crypt);
  expect(item.opcode).toBe(SMSG_ITEM_QUERY_SINGLE_RESPONSE);
  expect(new TextDecoder().decode(item.payload)).toContain("Monster - Sword, Long Basic");

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
  } as WorldData;
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
  client.send(encodeClientPacket(CMSG_CHAR_ENUM, new Uint8Array(0), crypt));
  const characters = await readServerPacket(client, crypt);
  expect(characters.opcode).toBe(SMSG_CHAR_ENUM);
  return crypt;
}

type ServerPacket = { opcode: number; payload: Uint8Array; raw: Uint8Array };

async function readServerPacket(client: TestClient, crypt: WorldCrypt | null): Promise<ServerPacket> {
  const header = await client.read(4);
  crypt?.decryptHeader(header);
  const size = (header[0]! << 8) | header[1]!;
  const opcode = header[2]! | (header[3]! << 8);
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
