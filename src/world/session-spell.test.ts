import { afterEach, expect, test } from "bun:test";
import { acoreWorldData } from "../data/test-world-data.ts";
import { seededTestDatabases } from "../database/test-db.ts";
import { combatWorldFor } from "../combat/combat-world.ts";
import { RACE_FACTION_TEMPLATE } from "../combat/faction.ts";
import { REP_FRIENDLY } from "../combat/constants.ts";
import { mapCreatureLocator } from "./map-world.ts";
import { advanceMaps, setUpTestMapWorld, staticCreatureLocator, tearDownTestMapWorld } from "./map-world.test-util.ts";
import { saveSessionKey } from "../db.ts";
import { ByteWriter } from "../net/byte-buffer.ts";
import { SpellStore } from "../spells/spell-info.ts";
import { loadSpellState } from "../spells/persist.ts";
import { loadCharacterKit } from "../characters/store.ts";
import { itemGuidRaw } from "../items/equipment-sets.ts";
import { CMSG_USE_ITEM, SMSG_SPELL_COOLDOWN } from "../items/use-item.ts";
import { CMSG_CANCEL_CAST, CMSG_CAST_SPELL, SMSG_AURA_UPDATE, SMSG_LEARNED_SPELL, SMSG_PERIODICAURALOG, SMSG_SPELL_FAILURE, SMSG_SPELL_GO, SMSG_SPELL_START, SMSG_SPELLHEALLOG, SMSG_SPELLNONMELEEDAMAGELOG, TARGET_FLAG_UNIT, writeTargets } from "../spells/packets.ts";
import { CMSG_PLAYER_LOGIN } from "./opcodes.ts";
import { authSeed, CMSG_AUTH_SESSION, sessionDigest } from "./packets.ts";
import { WorldSession } from "./session.ts";

afterEach(() => {
  tearDownTestMapWorld();
});

test.skipIf(!(await Bun.file("data/dbc/Spell.dbc").exists()))("known heal casts after its cast time and changes health", async () => {
  const db = await seededTestDatabases();
  await db.characters.$client.unsafe("INSERT INTO character_spell (guid, spell, specMask) VALUES (1, 2050, 1)");
  const key = crypto.getRandomValues(new Uint8Array(40));
  await saveSessionKey(db.login, "TEST", key);
  const spells = await SpellStore.load("data/dbc", null);
  const world = await acoreWorldData();
  const session = new WorldSession(db, world, null, undefined, null, undefined, undefined, undefined, spells);
  const received: number[] = [];
  const decode = (packet: Uint8Array): void => {
    const header = packet.slice(0, 4);
    received.push(header[2]! | (header[3]! << 8));
  };
  session.attach(decode);
  const seed = Uint8Array.of(1, 2, 3, 4);
  const auth = new ByteWriter().writeU32(12340).writeU32(0).writeCString("TEST").writeU32(0).writeBytes(seed)
    .writeU32(0).writeU32(0).writeU32(1).writeU32(0).writeU32(0)
    .writeBytes(sessionDigest("TEST", seed, authSeed(session.greeting), key)).writeU32(0).toUint8Array();
  (await session.handle(CMSG_AUTH_SESSION, auth)).packets.forEach(decode);
  (await session.handle(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array())).packets.forEach(decode);
  session.stats!.setMaxPower(0, 100);
  session.stats!.setPower(0, 100);
  session.stats!.setHealth(10);
  received.length = 0;
  const cast = new ByteWriter().writeU8(1).writeU32(2050).writeU8(0).writeU32(0).toUint8Array();
  (await session.handle(CMSG_CAST_SPELL, cast)).packets.forEach(decode);
  expect(received).toContain(SMSG_SPELL_START);
  expect(received).not.toContain(SMSG_SPELL_GO);
  (await session.handle(CMSG_CANCEL_CAST, new ByteWriter().writeU8(2).writeU32(2050).toUint8Array())).packets.forEach(decode);
  expect(received).toContain(SMSG_SPELL_FAILURE);
  received.length = 0;
  (await session.handle(CMSG_CAST_SPELL, cast)).packets.forEach(decode);
  expect(received).toContain(SMSG_SPELL_START);
  (await session.handle(CMSG_CANCEL_CAST, new ByteWriter().writeU8(2).writeU32(2050).toUint8Array())).packets.forEach(decode);
  session.update(1500);
  expect(session.stats!.health).toBeLessThan(session.stats!.maxHealth);
  received.length = 0;
  (await session.handle(CMSG_CAST_SPELL, cast)).packets.forEach(decode);
  session.update(1499);
  expect(received).not.toContain(SMSG_SPELL_GO);
  session.update(1);
  expect(received).toContain(SMSG_SPELL_GO);
  expect(received).toContain(SMSG_SPELLHEALLOG);
  expect(session.stats!.health).toBeGreaterThan(10);
  await session.disconnect();
});

test.skipIf(!(await Bun.file("data/dbc/Spell.dbc").exists()))("learn-spell effect updates the spellbook and persists it", async () => {
  const db = await seededTestDatabases();
  await db.characters.$client.unsafe("INSERT INTO character_spell (guid, spell, specMask) VALUES (1, 563, 1)");
  const key = crypto.getRandomValues(new Uint8Array(40));
  await saveSessionKey(db.login, "TEST", key);
  // The player's `Unit` (stats, spells, auras) needs the world's level stats, as `Player::LoadFromDB` does.
  const world = await acoreWorldData();
  const session = new WorldSession(db, world, null, undefined, null, undefined, undefined, undefined, await SpellStore.load("data/dbc", null));
  const received: number[] = [];
  const decode = (packet: Uint8Array): void => {
    const header = packet.slice(0, 4);
    received.push(header[2]! | (header[3]! << 8));
  };
  session.attach(decode);
  const seed = Uint8Array.of(1, 2, 3, 4);
  const auth = new ByteWriter().writeU32(12340).writeU32(0).writeCString("TEST").writeU32(0).writeBytes(seed)
    .writeU32(0).writeU32(0).writeU32(1).writeU32(0).writeU32(0)
    .writeBytes(sessionDigest("TEST", seed, authSeed(session.greeting), key)).writeU32(0).toUint8Array();
  (await session.handle(CMSG_AUTH_SESSION, auth)).packets.forEach(decode);
  (await session.handle(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array())).packets.forEach(decode);
  (await session.handle(CMSG_CAST_SPELL, new ByteWriter().writeU8(1).writeU32(563).writeU8(0).writeU32(0).toUint8Array())).packets.forEach(decode);
  session.update(3000);
  expect(received).toContain(SMSG_LEARNED_SPELL);
  await session.disconnect();
  expect((await loadCharacterKit(db.characters, 1)).spells).toContain(8928);
});

test.skipIf(!(await Bun.file("data/dbc/Spell.dbc").exists()))("percentage healing uses the target's maximum health", async () => {
  const db = await seededTestDatabases();
  await db.characters.$client.unsafe("INSERT INTO character_spell (guid, spell, specMask) VALUES (1, 48982, 1)");
  const key = crypto.getRandomValues(new Uint8Array(40));
  await saveSessionKey(db.login, "TEST", key);
  const world = await acoreWorldData();
  const session = new WorldSession(db, world, null, undefined, null, undefined, undefined, undefined, await SpellStore.load("data/dbc", null));
  const decode = (_packet: Uint8Array): void => {};
  session.attach(decode);
  const seed = Uint8Array.of(1, 2, 3, 4);
  const auth = new ByteWriter().writeU32(12340).writeU32(0).writeCString("TEST").writeU32(0).writeBytes(seed)
    .writeU32(0).writeU32(0).writeU32(1).writeU32(0).writeU32(0)
    .writeBytes(sessionDigest("TEST", seed, authSeed(session.greeting), key)).writeU32(0).toUint8Array();
  (await session.handle(CMSG_AUTH_SESSION, auth)).packets.forEach(decode);
  (await session.handle(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array())).packets.forEach(decode);
  session.stats!.setMaxHealth(100);
  session.stats!.setHealth(50);
  (await session.handle(CMSG_CAST_SPELL, new ByteWriter().writeU8(1).writeU32(48982).writeU8(0).writeU32(0).toUint8Array())).packets.forEach(decode);
  expect(session.stats!.health).toBe(60);
  await session.disconnect();
});

test.skipIf(!(await Bun.file("data/dbc/Spell.dbc").exists()))("item spell heals and consumes its charge after casting", async () => {
  const db = await seededTestDatabases();
  await db.characters.$client.unsafe("INSERT INTO item_instance (guid, itemEntry, owner_guid, count, charges, enchantments) VALUES (42, 118, 1, 1, '-1 0 0 0 0 ', '')");
  await db.characters.$client.unsafe("INSERT INTO character_inventory (guid, bag, slot, item) VALUES (1, 0, 23, 42)");
  const key = crypto.getRandomValues(new Uint8Array(40));
  await saveSessionKey(db.login, "TEST", key);
  const world = await acoreWorldData();
  const spells = await SpellStore.load("data/dbc", world.tables());
  const session = new WorldSession(db, world, null, undefined, null, undefined, undefined, undefined, spells);
  const received: number[] = [];
  const decode = (packet: Uint8Array): void => {
    const header = packet.slice(0, 4);
    received.push(header[2]! | (header[3]! << 8));
  };
  session.attach(decode);
  const seed = Uint8Array.of(1, 2, 3, 4);
  const auth = new ByteWriter().writeU32(12340).writeU32(0).writeCString("TEST").writeU32(0).writeBytes(seed)
    .writeU32(0).writeU32(0).writeU32(1).writeU32(0).writeU32(0)
    .writeBytes(sessionDigest("TEST", seed, authSeed(session.greeting), key)).writeU32(0).toUint8Array();
  (await session.handle(CMSG_AUTH_SESSION, auth)).packets.forEach(decode);
  (await session.handle(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array())).packets.forEach(decode);
  session.stats!.setHealth(10);
  const use = new ByteWriter().writeU8(0).writeU8(23).writeU8(1).writeU32(439)
    .writeU64(itemGuidRaw(42)).writeU32(0).writeU8(0).writeU32(0).toUint8Array();
  (await session.handle(CMSG_USE_ITEM, use)).packets.forEach(decode);
  expect(received).toContain(SMSG_SPELL_START);
  expect(received).toContain(SMSG_SPELL_GO);
  expect(received).toContain(SMSG_SPELL_COOLDOWN);
  expect(received).toContain(SMSG_SPELLHEALLOG);
  expect(session.stats!.health).toBeGreaterThan(10);
  expect(((await db.characters.$client.unsafe("SELECT guid FROM item_instance WHERE guid = 42"))[0] ?? null)).toBeNull();
  await session.disconnect();
  // `Player::AddSpellAndCategoryCooldowns` stores the cast spell's own row with category 0 (`_AddSpellCooldown(id, 0, ...)`).
  expect((await loadSpellState(db.characters, 1)).cooldowns).toEqual(expect.arrayContaining([expect.objectContaining({ spell: 439, item: 118, category: 0 })]));
});

test.skipIf(!(await Bun.file("data/dbc/Spell.dbc").exists()))("Hearthstone waits for its cast and teleports to homebind", async () => {
  const db = await seededTestDatabases();
  await db.characters.$client.unsafe("INSERT INTO character_homebind (guid,mapId,zoneId,posX,posY,posZ) VALUES (1,0,12,-8860,-120,83)");
  await db.characters.$client.unsafe("INSERT INTO item_instance (guid, itemEntry, owner_guid, count, charges, enchantments) VALUES (42, 6948, 1, 1, '0 0 0 0 0 ', '')");
  await db.characters.$client.unsafe("INSERT INTO character_inventory (guid, bag, slot, item) VALUES (1, 0, 23, 42)");
  const key = crypto.getRandomValues(new Uint8Array(40));
  await saveSessionKey(db.login, "TEST", key);
  const world = await acoreWorldData();
  const session = new WorldSession(db, world, null, undefined, null, undefined, undefined, undefined, await SpellStore.load("data/dbc", world.tables()));
  const received: number[] = [];
  const decode = (packet: Uint8Array): void => {
    const header = packet.slice(0, 4);
    received.push(header[2]! | (header[3]! << 8));
  };
  session.attach(decode);
  const seed = Uint8Array.of(1, 2, 3, 4);
  const auth = new ByteWriter().writeU32(12340).writeU32(0).writeCString("TEST").writeU32(0).writeBytes(seed)
    .writeU32(0).writeU32(0).writeU32(1).writeU32(0).writeU32(0)
    .writeBytes(sessionDigest("TEST", seed, authSeed(session.greeting), key)).writeU32(0).toUint8Array();
  (await session.handle(CMSG_AUTH_SESSION, auth)).packets.forEach(decode);
  (await session.handle(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array())).packets.forEach(decode);
  const use = new ByteWriter().writeU8(0).writeU8(23).writeU8(1).writeU32(8690)
    .writeU64(itemGuidRaw(42)).writeU32(0).writeU8(0).writeU32(0).toUint8Array();
  (await session.handle(CMSG_USE_ITEM, use)).packets.forEach(decode);
  expect(received).toContain(SMSG_SPELL_START);
  expect(received).not.toContain(SMSG_SPELL_GO);
  session.update(9999);
  expect(received).not.toContain(SMSG_SPELL_GO);
  session.update(1);
  expect(received).toContain(SMSG_SPELL_GO);
  expect(received).toContain(SMSG_SPELL_COOLDOWN);
  expect(((await db.characters.$client.unsafe("SELECT guid FROM item_instance WHERE guid = 42"))[0] ?? null)).not.toBeNull();
  await session.disconnect();
  expect((((await db.characters.$client.unsafe("SELECT position_x FROM characters WHERE guid = 1"))[0] ?? null) as { position_x: number }).position_x).toBe(-8860);
});

test.skipIf(!(await Bun.file("data/dbc/Spell.dbc").exists()))("Fireball damages a hostile creature and ticks its damage aura", async () => {
  const db = await seededTestDatabases();
  await db.characters.$client.unsafe("INSERT INTO character_spell (guid, spell, specMask) VALUES (1, 133, 1)");
  const key = crypto.getRandomValues(new Uint8Array(40));
  await saveSessionKey(db.login, "TEST", key);
  const world = await acoreWorldData();
  setUpTestMapWorld(world);
  const spawns = mapCreatureLocator;
  const spells = await SpellStore.load("data/dbc", world.tables());
  const session = new WorldSession(db, world, spawns, undefined, null, undefined, undefined, undefined, spells);
  const received: number[] = [];
  const decode = (packet: Uint8Array): void => {
    const header = packet.slice(0, 4);
    received.push(header[2]! | (header[3]! << 8));
  };
  session.attach(decode);
  const seed = Uint8Array.of(1, 2, 3, 4);
  const auth = new ByteWriter().writeU32(12340).writeU32(0).writeCString("TEST").writeU32(0).writeBytes(seed)
    .writeU32(0).writeU32(0).writeU32(1).writeU32(0).writeU32(0)
    .writeBytes(sessionDigest("TEST", seed, authSeed(session.greeting), key)).writeU32(0).toUint8Array();
  (await session.handle(CMSG_AUTH_SESSION, auth)).packets.forEach(decode);
  (await session.handle(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array())).packets.forEach(decode);
  const combat = combatWorldFor(world, spawns, world.tables(), null);
  const start = { map: 0, x: -8949.95, y: -132.493, z: 83.5312 };
  const player = { race: 1, classId: 1, factionTemplate: RACE_FACTION_TEMPLATE.get(1)!, reputation: () => null };
  const target = staticCreatureLocator(world).creaturesNear(start, 200)
    .map((spawn) => combat.infos.info(spawn.guid)!)
    .filter((info) => info && info.level <= 3 && info.type !== 8 && info.aiName === ""
      && combat.factions.creatureToPlayer(info.factionTemplate, player) < REP_FRIENDLY
      && combat.factions.playerToCreature(player, info.factionTemplate) < REP_FRIENDLY)
    .sort((left, right) => right.maxHealth - left.maxHealth)[0]!;
  expect(target).toBeDefined();
  const move = new ByteWriter().writeU8(1).writeU8(1).writeU32(0).writeU16(0).writeU32(1)
    .writeF32(target.home.x - 3).writeF32(target.home.y).writeF32(target.home.z).writeF32(0).writeU32(0).toUint8Array();
  (await session.handle(0x0ee, move)).packets.forEach(decode);
  advanceMaps(600);
  session.stats!.setMaxPower(0, 100);
  session.stats!.setPower(0, 100);
  // `MagicSpellHitResult` caps the hit chance at 100%; the bonus removes the random miss from this test.
  session.stats!.modSpellHitChance = 100;
  const before = target.maxHealth;
  const cast = new ByteWriter().writeU8(1).writeU32(133).writeU8(0);
  writeTargets(cast, { mask: TARGET_FLAG_UNIT, object: target.guid, item: 0n, source: null, dest: null, text: "" });
  (await session.handle(CMSG_CAST_SPELL, cast.toUint8Array())).packets.forEach(decode);
  session.update(1500);
  expect(received).toContain(SMSG_SPELL_GO);
  // The missile lands on a later spell event than the cast (`SpellEvent::Execute` records the delay start first).
  expect(received).not.toContain(SMSG_SPELLNONMELEEDAMAGELOG);
  session.update(1000);
  expect(received).toContain(SMSG_SPELLNONMELEEDAMAGELOG);
  expect(combat.creature(target.spawnGuid)?.health).toBeLessThan(before);
  expect(combat.creature(target.spawnGuid)?.spell?.hasAura(133)).toBe(true);
  const afterHit = combat.creature(target.spawnGuid)!.health;
  combat.update(Date.now() + 2000);
  expect(combat.creature(target.spawnGuid)?.health).toBeLessThan(afterHit);
  await session.disconnect();
});

test.skipIf(!(await Bun.file("data/dbc/Spell.dbc").exists()))("a triggered damage spell hits without a second cooldown or power cost", async () => {
  const db = await seededTestDatabases();
  await db.characters.$client.unsafe("INSERT INTO character_spell (guid, spell, specMask) VALUES (1, 36342, 1)");
  const key = crypto.getRandomValues(new Uint8Array(40));
  await saveSessionKey(db.login, "TEST", key);
  const world = await acoreWorldData();
  setUpTestMapWorld(world);
  const spawns = mapCreatureLocator;
  const spells = await SpellStore.load("data/dbc", world.tables());
  const session = new WorldSession(db, world, spawns, undefined, null, undefined, undefined, undefined, spells);
  const received: number[] = [];
  const decode = (packet: Uint8Array): void => {
    const header = packet.slice(0, 4);
    received.push(header[2]! | (header[3]! << 8));
  };
  session.attach(decode);
  const seed = Uint8Array.of(1, 2, 3, 4);
  const auth = new ByteWriter().writeU32(12340).writeU32(0).writeCString("TEST").writeU32(0).writeBytes(seed)
    .writeU32(0).writeU32(0).writeU32(1).writeU32(0).writeU32(0)
    .writeBytes(sessionDigest("TEST", seed, authSeed(session.greeting), key)).writeU32(0).toUint8Array();
  (await session.handle(CMSG_AUTH_SESSION, auth)).packets.forEach(decode);
  (await session.handle(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array())).packets.forEach(decode);
  const combat = combatWorldFor(world, spawns, world.tables(), null);
  const start = { map: 0, x: -8949.95, y: -132.493, z: 83.5312 };
  const player = { race: 1, classId: 1, factionTemplate: RACE_FACTION_TEMPLATE.get(1)!, reputation: () => null };
  const target = staticCreatureLocator(world).creaturesNear(start, 200)
    .map((spawn) => combat.infos.info(spawn.guid)!)
    .filter((info) => info && info.level <= 3 && info.type !== 8 && info.aiName === ""
      && combat.factions.creatureToPlayer(info.factionTemplate, player) < REP_FRIENDLY
      && combat.factions.playerToCreature(player, info.factionTemplate) < REP_FRIENDLY)
    .sort((left, right) => right.maxHealth - left.maxHealth)[0]!;
  expect(target).toBeDefined();
  const move = new ByteWriter().writeU8(1).writeU8(1).writeU32(0).writeU16(0).writeU32(1)
    .writeF32(target.home.x - 3).writeF32(target.home.y).writeF32(target.home.z).writeF32(0).writeU32(0).toUint8Array();
  (await session.handle(0x0ee, move)).packets.forEach(decode);
  advanceMaps(600);
  received.length = 0;
  session.stats!.modSpellHitChance = 100;
  session.stats!.modMeleeHitChance = 100;
  session.stats!.modRangedHitChance = 100;
  const cast = new ByteWriter().writeU8(1).writeU32(36342).writeU8(0);
  writeTargets(cast, { mask: TARGET_FLAG_UNIT, object: target.guid, item: 0n, source: null, dest: null, text: "" });
  (await session.handle(CMSG_CAST_SPELL, cast.toUint8Array())).packets.forEach(decode);
  // The parent launches the triggered missile (36628) before its own go packet.
  expect(received.filter((opcode) => opcode === SMSG_SPELL_GO)).toHaveLength(2);
  session.update(1);
  session.update(1000);
  expect(received).toContain(SMSG_SPELLNONMELEEDAMAGELOG);
  expect(combat.creature(target.spawnGuid)?.health).toBeLessThan(target.maxHealth);
  await session.disconnect();
  expect((await loadSpellState(db.characters, 1)).cooldowns.some((row) => row.spell === 36628)).toBe(false);
});

test.skipIf(!(await Bun.file("data/dbc/Spell.dbc").exists()))("Renew applies, heals on its periodic tick, and survives logout", async () => {
  const db = await seededTestDatabases();
  await db.characters.$client.unsafe("INSERT INTO character_spell (guid, spell, specMask) VALUES (1, 139, 1)");
  const key = crypto.getRandomValues(new Uint8Array(40));
  await saveSessionKey(db.login, "TEST", key);
  const world = await acoreWorldData();
  const session = new WorldSession(db, world, null, undefined, null, undefined, undefined, undefined, await SpellStore.load("data/dbc", null));
  const received: number[] = [];
  const decode = (packet: Uint8Array): void => {
    const header = packet.slice(0, 4);
    received.push(header[2]! | (header[3]! << 8));
  };
  session.attach(decode);
  const seed = Uint8Array.of(1, 2, 3, 4);
  const auth = new ByteWriter().writeU32(12340).writeU32(0).writeCString("TEST").writeU32(0).writeBytes(seed)
    .writeU32(0).writeU32(0).writeU32(1).writeU32(0).writeU32(0)
    .writeBytes(sessionDigest("TEST", seed, authSeed(session.greeting), key)).writeU32(0).toUint8Array();
  (await session.handle(CMSG_AUTH_SESSION, auth)).packets.forEach(decode);
  (await session.handle(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array())).packets.forEach(decode);
  session.stats!.setMaxPower(0, 100);
  session.stats!.setPower(0, 100);
  session.stats!.setHealth(10);
  received.length = 0;
  (await session.handle(CMSG_CAST_SPELL, new ByteWriter().writeU8(1).writeU32(139).writeU8(0).writeU32(0).toUint8Array())).packets.forEach(decode);
  session.update(3000);
  // Visible aura changes go out with the unit's next update (`m_visibleAurasToUpdate`).
  expect(received).toContain(SMSG_AURA_UPDATE);
  expect(received).toContain(SMSG_PERIODICAURALOG);
  expect(session.stats!.health).toBeGreaterThan(10);
  await session.disconnect();
  expect((await loadSpellState(db.characters, 1)).auras[0]).toMatchObject({ spell: 139, effectMask: 1, remainTime: 12000 });
});
