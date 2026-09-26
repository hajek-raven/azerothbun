import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { CharacterLoginKit } from "../characters/store.ts";
import type { CreatureSpawn, CreatureTemplate, WorldData } from "../data/world.ts";
import type { Character } from "../db.ts";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import { GossipCatalog, SMSG_GOSSIP_COMPLETE, SMSG_GOSSIP_MESSAGE } from "./gossip.ts";
import { QuestParty, type SharePeer } from "./party.ts";
import { MSG_QUEST_PUSH_RESULT, QuestCatalog, QUEST_PARTY_MSG_ACCEPT_QUEST, QUEST_PARTY_MSG_DECLINE_QUEST, QUEST_PARTY_MSG_SHARING_QUEST, SMSG_QUEST_CONFIRM_ACCEPT, SMSG_QUESTGIVER_QUEST_COMPLETE, SMSG_QUESTGIVER_QUEST_DETAILS, SMSG_QUESTGIVER_STATUS } from "./quests.ts";
import { creditKillPackets, Talk, type TalkPacket } from "./talk.ts";

const CREATURE_GUID = 1n | (197n << 24n) | (0xf130n << 48n);

test("gossip hello lists the quest, accept stores it, and a kill opens the reward", () => {
  const db = new Database(":memory:", { strict: true });
  db.run(`
    CREATE TABLE gossip_menu (MenuID INTEGER, TextID INTEGER);
    CREATE TABLE gossip_menu_option (
      MenuID INTEGER, OptionID INTEGER, OptionIcon INTEGER, OptionText TEXT,
      OptionBroadcastTextID INTEGER, OptionType INTEGER, OptionNpcFlag INTEGER,
      ActionMenuID INTEGER, ActionPoiID INTEGER, BoxCoded INTEGER, BoxMoney INTEGER,
      BoxText TEXT, BoxBroadcastTextID INTEGER
    );
    CREATE TABLE quest_template (
      ID INTEGER, QuestType INTEGER, QuestLevel INTEGER, MinLevel INTEGER, Flags INTEGER,
      LogTitle TEXT, RequiredNpcOrGo1 INTEGER, RequiredNpcOrGoCount1 INTEGER, RewardMoney INTEGER
    );
    CREATE TABLE creature_queststarter (id INTEGER, quest INTEGER);
    CREATE TABLE creature_questender (id INTEGER, quest INTEGER);
  `);
  db.run("INSERT INTO gossip_menu VALUES (500, 1)");
  db.run(
    "INSERT INTO gossip_menu_option VALUES (500, 0, 0, 'Train me', 0, 1, 1, 0, 0, 0, 0, '', 0)",
  );
  db.run("INSERT INTO quest_template VALUES (783, 2, 1, 1, 0, 'A Threat Within', 6, 8, 25)");
  db.run("INSERT INTO creature_queststarter VALUES (197, 783)");
  db.run("INSERT INTO creature_questender VALUES (197, 783)");

  const world = {
    database: () => db,
    creatureSpawn: (guid: number) => (guid === 1 ? ({ guid: 1, entry: 197, npcFlags: 3, unitFlags: 0, dynamicFlags: 0 } as CreatureSpawn) : undefined),
    creatureTemplate: (entry: number) =>
      entry === 197
        ? ({ name: "Marshal McBride", npcFlags: 3, gossipMenuId: 500, unitFlags: 0, dynamicFlags: 0 } as CreatureTemplate)
        : undefined,
    gameObjectSpawn: () => undefined,
    gameObjectTemplate: () => undefined,
    itemTemplate: () => undefined,
  } as unknown as WorldData;

  const talk = new Talk(new GossipCatalog(db), new QuestCatalog(db), world);
  const player = { guid: 1, race: 1, class: 1, gender: 0, level: 1, xp: 0, money: 0, zone: 12, map: 0, position_x: 0, position_y: 0, position_z: 0 } as Character;
  const kit = { spells: [], actions: [], skills: [], factions: [], homebind: null } as CharacterLoginKit;
  talk.login(db, player);

  const hello = talk.handle(0x17b, new ByteWriter().writeU64(CREATURE_GUID).toUint8Array(), player, kit, new Set());
  expect(hello?.[0]?.opcode).toBe(SMSG_GOSSIP_MESSAGE);
  const menu = new ByteReader(hello![0]!.body);
  menu.readU64();
  expect(menu.readU32()).toBe(500);
  expect(menu.readU32()).toBe(1);
  expect(menu.readU32()).toBe(1);
  expect(new TextDecoder().decode(hello![0]!.body)).toContain("A Threat Within");

  const status = talk.handle(0x182, new ByteWriter().writeU64(CREATURE_GUID).toUint8Array(), player, kit, new Set());
  expect(status?.[0]?.opcode).toBe(SMSG_QUESTGIVER_STATUS);
  expect(status?.[0]?.body[8]).toBe(8);

  const queried = talk.handle(0x186, new ByteWriter().writeU64(CREATURE_GUID).writeU32(783).writeU8(0).toUint8Array(), player, kit, new Set());
  expect(queried?.[0]?.opcode).toBe(SMSG_QUESTGIVER_QUEST_DETAILS);
  expect(new TextDecoder().decode(queried![0]!.body)).toContain("A Threat Within");

  const launched = talk.handle(0x187, new Uint8Array(), player, kit, new Set());
  expect(launched).toEqual([]);

  const cancelled = talk.handle(0x190, new Uint8Array(), player, kit, new Set());
  expect(cancelled?.[0]?.opcode).toBe(SMSG_GOSSIP_COMPLETE);

  const accepted = talk.handle(0x189, new ByteWriter().writeU64(CREATURE_GUID).writeU32(783).writeU32(0).toUint8Array(), player, kit, new Set());
  expect(accepted?.some((row) => row.name === "SMSG_GOSSIP_COMPLETE")).toBe(true);
  expect(talk.quests.status(783)).toBe(3);

  for (let kill = 0; kill < 8; kill++) {
    creditKillPackets(talk.quests, 6, CREATURE_GUID, player);
  }
  expect(talk.quests.status(783)).toBe(1);

  const reward = talk.handle(0x18e, new ByteWriter().writeU64(CREATURE_GUID).writeU32(783).writeU32(0).toUint8Array(), player, kit, new Set());
  expect(reward?.some((row) => row.opcode === SMSG_QUESTGIVER_QUEST_COMPLETE)).toBe(true);
  expect(player.money).toBe(25);
  expect(talk.quests.rewarded(783)).toBe(true);
  talk.save(db, player.guid);
  const stored = db.query<{ quest: number }, []>("SELECT quest FROM character_queststatus_rewarded").get();
  expect(stored?.quest).toBe(783);
});

test("quest log swap, party share, and party confirm", () => {
  const db = new Database(":memory:", { strict: true });
  db.run(`
    CREATE TABLE gossip_menu (MenuID INTEGER, TextID INTEGER);
    CREATE TABLE gossip_menu_option (
      MenuID INTEGER, OptionID INTEGER, OptionIcon INTEGER, OptionText TEXT,
      OptionBroadcastTextID INTEGER, OptionType INTEGER, OptionNpcFlag INTEGER,
      ActionMenuID INTEGER, ActionPoiID INTEGER, BoxCoded INTEGER, BoxMoney INTEGER,
      BoxText TEXT, BoxBroadcastTextID INTEGER
    );
    CREATE TABLE quest_template (
      ID INTEGER, QuestType INTEGER, QuestLevel INTEGER, MinLevel INTEGER, Flags INTEGER,
      LogTitle TEXT, RequiredNpcOrGo1 INTEGER, RequiredNpcOrGoCount1 INTEGER, RewardMoney INTEGER
    );
    CREATE TABLE creature_queststarter (id INTEGER, quest INTEGER);
    CREATE TABLE creature_questender (id INTEGER, quest INTEGER);
  `);
  db.run("INSERT INTO quest_template VALUES (900, 2, 1, 1, 8, 'Sharable', 6, 1, 0)");
  db.run("INSERT INTO quest_template VALUES (901, 2, 1, 1, 2, 'Party Accept', 6, 1, 0)");
  db.run("INSERT INTO quest_template VALUES (902, 2, 1, 1, 0, 'Second', 7, 1, 0)");
  db.run("INSERT INTO creature_queststarter VALUES (197, 900), (197, 901), (197, 902)");
  db.run("INSERT INTO creature_questender VALUES (197, 900), (197, 901), (197, 902)");

  const world = {
    database: () => db,
    creatureSpawn: (guid: number) => (guid === 1 ? ({ guid: 1, entry: 197, npcFlags: 2, unitFlags: 0, dynamicFlags: 0 } as CreatureSpawn) : undefined),
    creatureTemplate: (entry: number) =>
      entry === 197
        ? ({ name: "Marshal McBride", npcFlags: 2, gossipMenuId: 0, unitFlags: 0, dynamicFlags: 0 } as CreatureTemplate)
        : undefined,
    gameObjectSpawn: () => undefined,
    gameObjectTemplate: () => undefined,
    itemTemplate: () => undefined,
  } as unknown as WorldData;

  const party = new QuestParty();
  const catalog = new QuestCatalog(db);
  const gossip = new GossipCatalog(db);
  const leaderTalk = new Talk(gossip, catalog, world, party);
  const memberTalk = new Talk(gossip, catalog, world, party);
  const leader = player(1);
  const member = player(2);
  const kit = { spells: [], actions: [], skills: [], factions: [], homebind: null } as CharacterLoginKit;
  leaderTalk.login(db, leader);
  memberTalk.login(db, member);
  const leaderInbox: TalkPacket[] = [];
  const memberInbox: TalkPacket[] = [];
  party.bind(peer(leaderTalk, leader, leaderInbox));
  party.bind(peer(memberTalk, member, memberInbox));
  party.form([1, 2]);

  const accept = (talk: Talk, who: Character, questId: number) =>
    talk.handle(0x189, new ByteWriter().writeU64(CREATURE_GUID).writeU32(questId).writeU32(0).toUint8Array(), who, kit, new Set());

  expect(accept(leaderTalk, leader, 900)?.some((row) => row.name === "SMSG_GOSSIP_COMPLETE")).toBe(true);
  expect(accept(leaderTalk, leader, 902)?.some((row) => row.name === "SMSG_UPDATE_OBJECT")).toBe(true);
  const swapped = leaderTalk.handle(0x193, new ByteWriter().writeU8(0).writeU8(1).toUint8Array(), leader, kit, new Set());
  expect(swapped?.[0]?.name).toBe("SMSG_UPDATE_OBJECT");
  expect(leaderTalk.quests.slotIds()[0]).toBe(902);
  expect(leaderTalk.quests.slotIds()[1]).toBe(900);
  expect(leaderTalk.handle(0x193, new ByteWriter().writeU8(0).writeU8(0).toUint8Array(), leader, kit, new Set())).toEqual([]);

  const shared = leaderTalk.handle(0x19d, new ByteWriter().writeU32(900).toUint8Array(), leader, kit, new Set());
  expect(shared?.[0]?.opcode).toBe(MSG_QUEST_PUSH_RESULT);
  const sharedReader = new ByteReader(shared![0]!.body);
  expect(sharedReader.readU64()).toBe(2n);
  expect(sharedReader.readU8()).toBe(QUEST_PARTY_MSG_SHARING_QUEST);
  expect(memberInbox[0]?.opcode).toBe(SMSG_QUESTGIVER_QUEST_DETAILS);
  const details = new ByteReader(memberInbox[0]!.body);
  expect(details.readU64()).toBe(1n);
  expect(details.readU64()).toBe(1n);
  expect(memberTalk.dividerGuid()).toBe(1n);

  const taken = memberTalk.handle(0x189, new ByteWriter().writeU64(1n).writeU32(900).writeU32(0).toUint8Array(), member, kit, new Set());
  expect(taken?.some((row) => row.name === "SMSG_GOSSIP_COMPLETE")).toBe(true);
  expect(memberTalk.quests.status(900)).toBe(3);
  expect(memberTalk.dividerGuid()).toBe(0n);
  expect(leaderInbox[0]?.opcode).toBe(MSG_QUEST_PUSH_RESULT);
  const acceptedPush = new ByteReader(leaderInbox[0]!.body);
  expect(acceptedPush.readU64()).toBe(2n);
  expect(acceptedPush.readU8()).toBe(QUEST_PARTY_MSG_ACCEPT_QUEST);

  memberInbox.length = 0;
  expect(accept(leaderTalk, leader, 901)?.some((row) => row.name === "SMSG_GOSSIP_COMPLETE")).toBe(true);
  expect(memberInbox.some((row) => row.opcode === SMSG_QUEST_CONFIRM_ACCEPT)).toBe(true);
  expect(memberTalk.dividerGuid()).toBe(1n);
  const confirmed = memberTalk.handle(0x19b, new ByteWriter().writeU32(901).toUint8Array(), member, kit, new Set());
  expect(confirmed?.[0]?.name).toBe("SMSG_UPDATE_OBJECT");
  expect(memberTalk.quests.status(901)).toBe(3);
  expect(memberTalk.dividerGuid()).toBe(0n);

  leaderTalk.setDivider(2n);
  leaderInbox.length = 0;
  expect(leaderTalk.handle(0x276, new ByteWriter().writeU64(2n).writeU32(900).writeU8(QUEST_PARTY_MSG_DECLINE_QUEST).toUint8Array(), leader, kit, new Set())).toEqual([]);
  expect(leaderTalk.dividerGuid()).toBe(0n);
  expect(memberInbox.at(-1)?.opcode).toBe(MSG_QUEST_PUSH_RESULT);
});

function player(guid: number): Character {
  return { guid, race: 1, class: 1, gender: 0, level: 1, xp: 0, money: 0, zone: 12, map: 0, position_x: 0, position_y: 0, position_z: 0, name: `P${guid}` } as Character;
}

function peer(talk: Talk, who: Character, inbox: TalkPacket[]): SharePeer {
  return {
    guid: who.guid,
    divider: () => talk.dividerGuid(),
    setDivider: (guid) => talk.setDivider(guid),
    place: () => ({ map: who.map, x: who.position_x, y: who.position_y, z: who.position_z }),
    level: () => who.level,
    status: (questId) => talk.quests.status(questId),
    canTake: (questId) => {
      talk.syncSpeaker(who);
      return talk.quests.canTake(questId, talk.quests.speaker);
    },
    canShare: (questId) => talk.quests.canShare(questId),
    logFull: () => talk.quests.logFull(),
    acceptShared: (questId) => talk.acceptShared(who, questId),
    deliver: (packets) => inbox.push(...packets),
  };
}
