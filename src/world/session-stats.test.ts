import { describe, expect, test } from "bun:test";
import { defaultPlayerEnvironment } from "../characters/player-env.ts";
import { POWER_RAGE, SKILL_DEFENSE, UNIT_FIELD_ATTACK_POWER } from "../characters/player-stats.ts";
import { SMSG_LEVELUP_INFO, SMSG_LOG_XPGAIN } from "../characters/level-up.ts";
import { seededTestDatabases } from "../database/test-db.ts";
import { findCharacterById, saveSessionKey } from "../db.ts";
import { acoreWorldData } from "../data/test-world-data.ts";
import { WorldCrypt } from "../crypto/world-crypt.ts";
import { ByteWriter } from "../net/byte-buffer.ts";
import { CMSG_PLAYER_LOGIN } from "./opcodes.ts";
import { authSeed, CMSG_AUTH_SESSION, sessionDigest } from "./packets.ts";
import { WorldSession } from "./session.ts";

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

describe("WorldSession player unit (acore_world)", () => {
  async function login() {
    const world = await acoreWorldData();
    const key = crypto.getRandomValues(new Uint8Array(40));
    const db = await seededTestDatabases(world.tables());
    await saveSessionKey(db.login, "TEST", key);
    const env = defaultPlayerEnvironment();
    env.statStores.octRegenHP = { lookup: () => 0.25 };
    env.statStores.regenHPPerSpt = { lookup: () => 0.5 };
    const session = new WorldSession(db, world, null, undefined, null, undefined, undefined, env);
    const delivered: Uint8Array[] = [];
    session.attach((packet) => delivered.push(packet));
    const clientSeed = Uint8Array.of(1, 2, 3, 4);
    await session.handle(CMSG_AUTH_SESSION, authSession("TEST", clientSeed, sessionDigest("TEST", clientSeed, authSeed(session.greeting), key)));
    expect(session.crypt).toBeInstanceOf(WorldCrypt);
    await session.handle(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array());
    return { session, db, delivered };
  }

  test("login builds stats and skills from the class tables", async () => {
    const { session } = await login();
    const stats = session.stats!;
    expect(stats).not.toBeNull();
    expect(stats.level).toBe(1);
    // player_class_stats warrior 1: 20 HP + 20 + (22 - 20) * 10
    expect(stats.maxHealth).toBe(60);
    expect(stats.maxPower(POWER_RAGE)).toBe(1000);
    expect(stats.getInt32(UNIT_FIELD_ATTACK_POWER)).toBeGreaterThanOrEqual(29);
    expect(session.skills!.getMaxSkillValue(SKILL_DEFENSE)).toBe(5);
    await session.disconnect();
  });

  test("the world tick regenerates health and flushes the field", async () => {
    const { session, delivered } = await login();
    const stats = session.stats!;
    stats.setHealth(10);
    stats.takeChanged();
    delivered.length = 0;
    session.update(2000);
    // spirit 20 × 0.25 × 2
    expect(stats.health).toBe(20);
    expect(delivered.length).toBeGreaterThan(0);
    await session.disconnect();
  });

  test("XP levels the character, sends the level packets, and saves", async () => {
    const { session, db } = await login();
    const packets = session.grantXp(400, null);
    expect(packets.map((packet) => packet.opcode)).toEqual([SMSG_LOG_XPGAIN, SMSG_LEVELUP_INFO]);
    const stats = session.stats!;
    expect(stats.level).toBe(2);
    // warrior 2: 29 HP, stamina 23
    expect(stats.maxHealth).toBe(29 + 20 + 30);
    expect(stats.health).toBe(stats.maxHealth);
    expect(session.skills!.getMaxSkillValue(SKILL_DEFENSE)).toBe(10);
    await session.disconnect();
    const saved = await findCharacterById(db.characters, 1);
    expect(saved?.level).toBe(2);
    expect(saved?.xp).toBe(0);
    expect(saved?.health).toBe(79);
  });
});
