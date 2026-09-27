import { worldFromSql } from "../database/test-world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { expect, test } from "bun:test";
import { ByteReader } from "../net/byte-buffer.ts";
import {
  GossipCatalog,
  gossipMessage,
  gossipPoi,
  npcTextUpdate,
  type QuestStateView,
  type Speaker,
} from "./gossip.ts";

function openGossipDb(): WorldTables {
  const db = WorldTables.fromRows();
  worldFromSql(`
    CREATE TABLE gossip_menu (
      MenuID INTEGER NOT NULL DEFAULT 0,
      TextID INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (MenuID, TextID)
    );
    CREATE TABLE gossip_menu_option (
      MenuID INTEGER NOT NULL DEFAULT 0,
      OptionID INTEGER NOT NULL DEFAULT 0,
      OptionIcon INTEGER NOT NULL DEFAULT 0,
      OptionText TEXT,
      OptionBroadcastTextID INTEGER NOT NULL DEFAULT 0,
      OptionType INTEGER NOT NULL DEFAULT 0,
      OptionNpcFlag INTEGER NOT NULL DEFAULT 0,
      ActionMenuID INTEGER NOT NULL DEFAULT 0,
      ActionPoiID INTEGER NOT NULL DEFAULT 0,
      BoxCoded INTEGER NOT NULL DEFAULT 0,
      BoxMoney INTEGER NOT NULL DEFAULT 0,
      BoxText TEXT,
      BoxBroadcastTextID INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE npc_text (
      ID INTEGER NOT NULL DEFAULT 0 PRIMARY KEY,
      text0_0 TEXT, text0_1 TEXT, BroadcastTextID0 INTEGER NOT NULL DEFAULT 0,
      lang0 INTEGER NOT NULL DEFAULT 0, Probability0 REAL NOT NULL DEFAULT 0,
      em0_0 INTEGER NOT NULL DEFAULT 0, em0_1 INTEGER NOT NULL DEFAULT 0,
      em0_2 INTEGER NOT NULL DEFAULT 0, em0_3 INTEGER NOT NULL DEFAULT 0,
      em0_4 INTEGER NOT NULL DEFAULT 0, em0_5 INTEGER NOT NULL DEFAULT 0,
      text1_0 TEXT, text1_1 TEXT, BroadcastTextID1 INTEGER NOT NULL DEFAULT 0,
      lang1 INTEGER NOT NULL DEFAULT 0, Probability1 REAL NOT NULL DEFAULT 0,
      em1_0 INTEGER NOT NULL DEFAULT 0, em1_1 INTEGER NOT NULL DEFAULT 0,
      em1_2 INTEGER NOT NULL DEFAULT 0, em1_3 INTEGER NOT NULL DEFAULT 0,
      em1_4 INTEGER NOT NULL DEFAULT 0, em1_5 INTEGER NOT NULL DEFAULT 0,
      text2_0 TEXT, text2_1 TEXT, BroadcastTextID2 INTEGER NOT NULL DEFAULT 0,
      lang2 INTEGER NOT NULL DEFAULT 0, Probability2 REAL NOT NULL DEFAULT 0,
      em2_0 INTEGER NOT NULL DEFAULT 0, em2_1 INTEGER NOT NULL DEFAULT 0,
      em2_2 INTEGER NOT NULL DEFAULT 0, em2_3 INTEGER NOT NULL DEFAULT 0,
      em2_4 INTEGER NOT NULL DEFAULT 0, em2_5 INTEGER NOT NULL DEFAULT 0,
      text3_0 TEXT, text3_1 TEXT, BroadcastTextID3 INTEGER NOT NULL DEFAULT 0,
      lang3 INTEGER NOT NULL DEFAULT 0, Probability3 REAL NOT NULL DEFAULT 0,
      em3_0 INTEGER NOT NULL DEFAULT 0, em3_1 INTEGER NOT NULL DEFAULT 0,
      em3_2 INTEGER NOT NULL DEFAULT 0, em3_3 INTEGER NOT NULL DEFAULT 0,
      em3_4 INTEGER NOT NULL DEFAULT 0, em3_5 INTEGER NOT NULL DEFAULT 0,
      text4_0 TEXT, text4_1 TEXT, BroadcastTextID4 INTEGER NOT NULL DEFAULT 0,
      lang4 INTEGER NOT NULL DEFAULT 0, Probability4 REAL NOT NULL DEFAULT 0,
      em4_0 INTEGER NOT NULL DEFAULT 0, em4_1 INTEGER NOT NULL DEFAULT 0,
      em4_2 INTEGER NOT NULL DEFAULT 0, em4_3 INTEGER NOT NULL DEFAULT 0,
      em4_4 INTEGER NOT NULL DEFAULT 0, em4_5 INTEGER NOT NULL DEFAULT 0,
      text5_0 TEXT, text5_1 TEXT, BroadcastTextID5 INTEGER NOT NULL DEFAULT 0,
      lang5 INTEGER NOT NULL DEFAULT 0, Probability5 REAL NOT NULL DEFAULT 0,
      em5_0 INTEGER NOT NULL DEFAULT 0, em5_1 INTEGER NOT NULL DEFAULT 0,
      em5_2 INTEGER NOT NULL DEFAULT 0, em5_3 INTEGER NOT NULL DEFAULT 0,
      em5_4 INTEGER NOT NULL DEFAULT 0, em5_5 INTEGER NOT NULL DEFAULT 0,
      text6_0 TEXT, text6_1 TEXT, BroadcastTextID6 INTEGER NOT NULL DEFAULT 0,
      lang6 INTEGER NOT NULL DEFAULT 0, Probability6 REAL NOT NULL DEFAULT 0,
      em6_0 INTEGER NOT NULL DEFAULT 0, em6_1 INTEGER NOT NULL DEFAULT 0,
      em6_2 INTEGER NOT NULL DEFAULT 0, em6_3 INTEGER NOT NULL DEFAULT 0,
      em6_4 INTEGER NOT NULL DEFAULT 0, em6_5 INTEGER NOT NULL DEFAULT 0,
      text7_0 TEXT, text7_1 TEXT, BroadcastTextID7 INTEGER NOT NULL DEFAULT 0,
      lang7 INTEGER NOT NULL DEFAULT 0, Probability7 REAL NOT NULL DEFAULT 0,
      em7_0 INTEGER NOT NULL DEFAULT 0, em7_1 INTEGER NOT NULL DEFAULT 0,
      em7_2 INTEGER NOT NULL DEFAULT 0, em7_3 INTEGER NOT NULL DEFAULT 0,
      em7_4 INTEGER NOT NULL DEFAULT 0, em7_5 INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE broadcast_text (
      ID INTEGER NOT NULL DEFAULT 0 PRIMARY KEY,
      LanguageID INTEGER, MaleText TEXT, FemaleText TEXT,
      EmoteID1 INTEGER, EmoteID2 INTEGER, EmoteID3 INTEGER,
      EmoteDelay1 INTEGER, EmoteDelay2 INTEGER, EmoteDelay3 INTEGER
    );
    CREATE TABLE points_of_interest (
      ID INTEGER NOT NULL DEFAULT 0 PRIMARY KEY,
      PositionX REAL NOT NULL DEFAULT 0,
      PositionY REAL NOT NULL DEFAULT 0,
      Icon INTEGER NOT NULL DEFAULT 0,
      Flags INTEGER NOT NULL DEFAULT 0,
      Importance INTEGER NOT NULL DEFAULT 0,
      Name TEXT NOT NULL
    );
    CREATE TABLE conditions (
      SourceTypeOrReferenceId INTEGER NOT NULL DEFAULT 0,
      SourceGroup INTEGER NOT NULL DEFAULT 0,
      SourceEntry INTEGER NOT NULL DEFAULT 0,
      ElseGroup INTEGER NOT NULL DEFAULT 0,
      ConditionTypeOrReference INTEGER NOT NULL DEFAULT 0,
      ConditionValue1 INTEGER NOT NULL DEFAULT 0,
      ConditionValue2 INTEGER NOT NULL DEFAULT 0,
      ConditionValue3 INTEGER NOT NULL DEFAULT 0,
      NegativeCondition INTEGER NOT NULL DEFAULT 0
    );
  `, db);
  return db;
}

const speaker: Speaker = {
  race: 1,
  classId: 1,
  gender: 0,
  level: 10,
  zone: 12,
  map: 0,
};

function questsWith(overrides: Partial<{ status: Map<number, number>; rewarded: Set<number> }> = {}): QuestStateView {
  const statusMap = overrides.status ?? new Map<number, number>();
  const rewardedSet = overrides.rewarded ?? new Set<number>();
  return {
    status(questId) {
      return statusMap.get(questId) ?? 0;
    },
    rewarded(questId) {
      return rewardedSet.has(questId);
    },
    objective() {
      return 0;
    },
  };
}

test("gossip message bytes: one option and one quest field order", () => {
  const body = gossipMessage(
    0x1n,
    42,
    100,
    [
      {
        optionId: 0,
        icon: 1,
        coded: false,
        boxMoney: 50,
        text: "Browse goods",
        boxText: "",
        type: 3,
        npcFlag: 0x80,
        actionMenuId: 0,
        actionPoiId: 0,
      },
    ],
    [{ questId: 7, icon: 2, level: 5, flags: 8, repeatable: false, title: "Kill wolves" }],
  );
  const r = new ByteReader(body);
  expect(r.readU64()).toBe(0x1n);
  expect(r.readU32()).toBe(42);
  expect(r.readU32()).toBe(100);
  expect(r.readU32()).toBe(1);
  expect(r.readU32()).toBe(0);
  expect(r.readU8()).toBe(1);
  expect(r.readU8()).toBe(0);
  expect(r.readU32()).toBe(50);
  expect(r.readCString()).toBe("Browse goods");
  expect(r.readCString()).toBe("");
  expect(r.readU32()).toBe(1);
  expect(r.readU32()).toBe(7);
  expect(r.readU32()).toBe(2);
  expect(r.readU32()).toBe(5);
  expect(r.readU32()).toBe(8);
  expect(r.readU8()).toBe(0);
  expect(r.readCString()).toBe("Kill wolves");
  expect(r.remaining).toBe(0);
});

test("npc text fallback for missing id", () => {
  const catalog = new GossipCatalog(openGossipDb());
  const slots = catalog.npcText(99999, 0);
  const body = npcTextUpdate(99999, slots);
  const r = new ByteReader(body);
  expect(r.readU32()).toBe(99999);
  expect(r.readF32()).toBe(0);
  expect(r.readCString()).toBe("Greetings $N");
  expect(r.readCString()).toBe("Greetings $N");
});

test("menu text id skips QUESTREWARDED failure and uses next row", () => {
  const db = openGossipDb();
  worldFromSql(`INSERT INTO gossip_menu (MenuID, TextID) VALUES (10, 100), (10, 200)`, db);
  worldFromSql(`INSERT INTO conditions
      (SourceTypeOrReferenceId, SourceGroup, SourceEntry, ElseGroup, ConditionTypeOrReference,
       ConditionValue1, ConditionValue2, ConditionValue3, NegativeCondition)
     VALUES (14, 10, 100, 0, 8, 500, 0, 0, 0)`, db);
  const catalog = new GossipCatalog(db);
  const textId = catalog.textId(10, speaker, questsWith());
  expect(textId).toBe(200);
});

test("option hidden when OptionNpcFlag is vendor and npc flags are gossip only", () => {
  const db = openGossipDb();
  worldFromSql(`INSERT INTO gossip_menu_option
      (MenuID, OptionID, OptionIcon, OptionText, OptionBroadcastTextID, OptionType, OptionNpcFlag,
       ActionMenuID, ActionPoiID, BoxCoded, BoxMoney, BoxText, BoxBroadcastTextID)
     VALUES (1, 0, 1, 'Vendor', 0, 3, 128, 0, 0, 0, 0, '', 0)`, db);
  const catalog = new GossipCatalog(db);
  const options = catalog.options(1, 1, speaker, questsWith());
  expect(options).toHaveLength(0);
});

test("option shown when flags include vendor", () => {
  const db = openGossipDb();
  worldFromSql(`INSERT INTO gossip_menu_option
      (MenuID, OptionID, OptionIcon, OptionText, OptionBroadcastTextID, OptionType, OptionNpcFlag,
       ActionMenuID, ActionPoiID, BoxCoded, BoxMoney, BoxText, BoxBroadcastTextID)
     VALUES (1, 0, 1, 'Vendor', 0, 3, 128, 0, 0, 0, 0, '', 0)`, db);
  const catalog = new GossipCatalog(db);
  const options = catalog.options(1, 0x80 | 1, speaker, questsWith());
  expect(options).toHaveLength(1);
  expect(options[0]!.text).toBe("Vendor");
});

test("quest taken condition hides an option", () => {
  const db = openGossipDb();
  worldFromSql(`INSERT INTO gossip_menu_option
      (MenuID, OptionID, OptionIcon, OptionText, OptionBroadcastTextID, OptionType, OptionNpcFlag,
       ActionMenuID, ActionPoiID, BoxCoded, BoxMoney, BoxText, BoxBroadcastTextID)
     VALUES (2, 0, 0, 'Talk', 0, 1, 1, 0, 0, 0, 0, '', 0)`, db);
  worldFromSql(`INSERT INTO conditions
      (SourceTypeOrReferenceId, SourceGroup, SourceEntry, ElseGroup, ConditionTypeOrReference,
       ConditionValue1, ConditionValue2, ConditionValue3, NegativeCondition)
     VALUES (15, 2, 0, 0, 9, 77, 0, 0, 0)`, db);
  const catalog = new GossipCatalog(db);
  const hidden = catalog.options(2, 1, speaker, questsWith());
  expect(hidden).toHaveLength(0);
  const shown = catalog.options(2, 1, speaker, questsWith({ status: new Map([[77, 3]]) }));
  expect(shown).toHaveLength(1);
});

test("POI packet field order", () => {
  const body = gossipPoi({
    flags: 3,
    x: 1.5,
    y: -2.25,
    icon: 7,
    importance: 2,
    name: "Inn",
  });
  const r = new ByteReader(body);
  expect(r.readU32()).toBe(3);
  expect(r.readF32()).toBe(Math.fround(1.5));
  expect(r.readF32()).toBe(Math.fround(-2.25));
  expect(r.readU32()).toBe(7);
  expect(r.readU32()).toBe(2);
  expect(r.readCString()).toBe("Inn");
  expect(r.remaining).toBe(0);
});
