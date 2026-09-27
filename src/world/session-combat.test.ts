import { expect, test } from "bun:test";
import { combatWorldFor } from "../combat/combat-world.ts";
import {
  CMSG_ATTACKSWING,
  CMSG_SET_SELECTION,
  REP_FRIENDLY,
  SMSG_ATTACKERSTATEUPDATE,
  SMSG_ATTACKSTART,
  SMSG_ATTACKSTOP,
  SMSG_PARTYKILLLOG,
  SMSG_UPDATE_OBJECT,
  UNIT_DYNFLAG_LOOTABLE,
} from "../combat/constants.ts";
import { UNIT_DYNAMIC_FLAGS, updateFieldValue } from "../combat/packets.ts";
import { RACE_FACTION_TEMPLATE } from "../combat/faction.ts";
import { acoreWorldData } from "../data/test-world-data.ts";
import { seededTestDatabases } from "../database/test-db.ts";
import { saveSessionKey } from "../db.ts";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import { SMSG_LOG_XPGAIN } from "../characters/level-up.ts";
import { CMSG_LOOT } from "./loot-play.ts";
import { CMSG_PLAYER_LOGIN } from "./opcodes.ts";
import { authSeed, CMSG_AUTH_SESSION, sessionDigest } from "./packets.ts";
import { QuestParty } from "./party.ts";
import { PlayerView } from "./players.ts";
import { WorldSession } from "./session.ts";
import { creaturesNear, indexSpawns } from "./spawn.ts";

const SMSG_LOOT_RESPONSE = 0x160;
const MSG_MOVE_HEARTBEAT = 0x0ee;

test(
  "the seeded warrior kills an attackable Northshire creature and loots it",
  async () => {
    const world = await acoreWorldData();
    const spawns = indexSpawns(world);
    const db = await seededTestDatabases(world.tables());
    const sessionKey = crypto.getRandomValues(new Uint8Array(40));
    await saveSessionKey(db.login, "TEST", sessionKey);
    const session = new WorldSession(db, world, spawns, new PlayerView(), null, new QuestParty());
    const received: { opcode: number; payload: Uint8Array }[] = [];
    const decode = (packet: Uint8Array): void => {
      const header = packet.slice(0, 4);
      received.push({ opcode: header[2]! | (header[3]! << 8), payload: packet.slice(4) });
    };
    session.attach(decode);

    const clientSeed = Uint8Array.from([1, 2, 3, 4]);
    const digest = sessionDigest("TEST", clientSeed, authSeed(session.greeting), sessionKey);
    (await session.handle(CMSG_AUTH_SESSION, authSession("TEST", clientSeed, digest))).packets.forEach(decode);
    (await session.handle(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array())).packets.forEach(decode);

    const combat = combatWorldFor(world, spawns, world.tables(), null);
    const start = { map: 0, x: -8949.95, y: -132.493, z: 83.5312 };
    const player = { race: 1, classId: 1, factionTemplate: RACE_FACTION_TEMPLATE.get(1)!, reputation: () => null };
    const target = creaturesNear(spawns, start, 200)
      .map((spawn) => combat.infos.info(spawn.guid)!)
      .filter(
        (info) =>
          info &&
          info.level <= 3 &&
          info.type !== 8 &&
          info.aiName === "" &&
          combat.factions.creatureToPlayer(info.factionTemplate, player) < REP_FRIENDLY &&
          combat.factions.playerToCreature(player, info.factionTemplate) < REP_FRIENDLY,
      )
      .sort((left, right) => left.maxHealth - right.maxHealth)[0];
    expect(target).toBeDefined();
    const info = target!;

    // walk up to it, west of it and facing east
    const at = { x: info.home.x - 2, y: info.home.y, z: info.home.z };
    received.length = 0;
    (await session.handle(MSG_MOVE_HEARTBEAT, movement(1n, at.x, at.y, at.z, 0))).packets.forEach(decode);
    (await session.handle(CMSG_ATTACKSWING, new ByteWriter().writeU64(info.guid).toUint8Array())).packets.forEach(decode);
    expect(received.some((packet) => packet.opcode === SMSG_ATTACKSTART)).toBe(true);

    let now = Date.now() + 1000;
    for (let step = 0; step < 900 && combat.creature(info.spawnGuid)?.deathState !== "corpse"; step++) {
      now += 100;
      combat.update(now);
    }
    expect(combat.creature(info.spawnGuid)?.deathState).toBe("corpse");
    const opcodes = new Set(received.map((packet) => packet.opcode));
    expect(opcodes.has(SMSG_ATTACKERSTATEUPDATE)).toBe(true);
    expect(opcodes.has(SMSG_PARTYKILLLOG)).toBe(true);
    expect(opcodes.has(SMSG_ATTACKSTOP)).toBe(true);
    expect(opcodes.has(SMSG_LOG_XPGAIN)).toBe(true);

    const xp = received.find((packet) => packet.opcode === SMSG_LOG_XPGAIN)!;
    const reader = new ByteReader(xp.payload);
    expect(reader.readU64()).toBe(info.guid);
    expect(reader.readU32()).toBeGreaterThan(0);

    if (combat.canLoot(1, info.guid)) {
      const flagged = received.some((packet) => {
        if (packet.opcode !== SMSG_UPDATE_OBJECT) {
          return false;
        }
        const flags = updateFieldValue(packet.payload, UNIT_DYNAMIC_FLAGS);
        return flags !== null && (flags & UNIT_DYNFLAG_LOOTABLE) === UNIT_DYNFLAG_LOOTABLE;
      });
      expect(flagged).toBe(true);
      // `HandleSetSelectionOpcode` only sets the target. The window opens on `CMSG_LOOT`.
      received.length = 0;
      (await session.handle(CMSG_SET_SELECTION, new ByteWriter().writeU64(info.guid).toUint8Array())).packets.forEach(decode);
      expect(received.some((packet) => packet.opcode === SMSG_LOOT_RESPONSE)).toBe(false);
      received.length = 0;
      (await session.handle(CMSG_LOOT, new ByteWriter().writeU64(info.guid).toUint8Array())).packets.forEach(decode);
      expect(received.some((packet) => packet.opcode === SMSG_LOOT_RESPONSE)).toBe(true);
    }
    await session.disconnect();
  },
  60_000,
);

function movement(guid: bigint, x: number, y: number, z: number, orientation: number): Uint8Array {
  return new ByteWriter()
    .writeU8(0x01)
    .writeU8(Number(guid & 0xffn))
    .writeU32(0)
    .writeU16(0)
    .writeU32(1)
    .writeF32(x)
    .writeF32(y)
    .writeF32(z)
    .writeF32(orientation)
    .writeU32(0)
    .toUint8Array();
}

function authSession(account: string, clientSeed: Uint8Array, digest: Uint8Array): Uint8Array {
  return new ByteWriter()
    .writeU32(12340)
    .writeU32(0)
    .writeCString(account)
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
