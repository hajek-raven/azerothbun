import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ByteReader } from "../net/byte-buffer.ts";
import {
  buildQuestQueryResponse,
  buildQuestUpdateAddKill,
  DIALOG_AVAILABLE,
  DIALOG_REWARD,
  QUEST_FLAGS_DAILY,
  QUEST_STATUS_COMPLETE,
  QUEST_STATUS_INCOMPLETE,
  QuestCatalog,
  QuestLog,
} from "./quests.ts";

function openWorldDb(): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec(`
    CREATE TABLE quest_template (
      ID INTEGER PRIMARY KEY,
      QuestType INTEGER NOT NULL DEFAULT 2,
      QuestLevel INTEGER NOT NULL DEFAULT 1,
      MinLevel INTEGER NOT NULL DEFAULT 0,
      QuestSortID INTEGER NOT NULL DEFAULT 0,
      QuestInfoID INTEGER NOT NULL DEFAULT 0,
      SuggestedGroupNum INTEGER NOT NULL DEFAULT 0,
      RequiredFactionId1 INTEGER NOT NULL DEFAULT 0,
      RequiredFactionId2 INTEGER NOT NULL DEFAULT 0,
      RequiredFactionValue1 INTEGER NOT NULL DEFAULT 0,
      RequiredFactionValue2 INTEGER NOT NULL DEFAULT 0,
      RewardNextQuest INTEGER NOT NULL DEFAULT 0,
      RewardXPDifficulty INTEGER NOT NULL DEFAULT 0,
      RewardMoney INTEGER NOT NULL DEFAULT 0,
      RewardMoneyDifficulty INTEGER NOT NULL DEFAULT 0,
      RewardDisplaySpell INTEGER NOT NULL DEFAULT 0,
      RewardSpell INTEGER NOT NULL DEFAULT 0,
      RewardHonor INTEGER NOT NULL DEFAULT 0,
      RewardKillHonor REAL NOT NULL DEFAULT 0,
      StartItem INTEGER NOT NULL DEFAULT 0,
      Flags INTEGER NOT NULL DEFAULT 0,
      RequiredPlayerKills INTEGER NOT NULL DEFAULT 0,
      RewardItem1 INTEGER NOT NULL DEFAULT 0, RewardAmount1 INTEGER NOT NULL DEFAULT 0,
      RewardItem2 INTEGER NOT NULL DEFAULT 0, RewardAmount2 INTEGER NOT NULL DEFAULT 0,
      RewardItem3 INTEGER NOT NULL DEFAULT 0, RewardAmount3 INTEGER NOT NULL DEFAULT 0,
      RewardItem4 INTEGER NOT NULL DEFAULT 0, RewardAmount4 INTEGER NOT NULL DEFAULT 0,
      ItemDrop1 INTEGER NOT NULL DEFAULT 0, ItemDropQuantity1 INTEGER NOT NULL DEFAULT 0,
      ItemDrop2 INTEGER NOT NULL DEFAULT 0, ItemDropQuantity2 INTEGER NOT NULL DEFAULT 0,
      ItemDrop3 INTEGER NOT NULL DEFAULT 0, ItemDropQuantity3 INTEGER NOT NULL DEFAULT 0,
      ItemDrop4 INTEGER NOT NULL DEFAULT 0, ItemDropQuantity4 INTEGER NOT NULL DEFAULT 0,
      RewardChoiceItemID1 INTEGER NOT NULL DEFAULT 0, RewardChoiceItemQuantity1 INTEGER NOT NULL DEFAULT 0,
      RewardChoiceItemID2 INTEGER NOT NULL DEFAULT 0, RewardChoiceItemQuantity2 INTEGER NOT NULL DEFAULT 0,
      RewardChoiceItemID3 INTEGER NOT NULL DEFAULT 0, RewardChoiceItemQuantity3 INTEGER NOT NULL DEFAULT 0,
      RewardChoiceItemID4 INTEGER NOT NULL DEFAULT 0, RewardChoiceItemQuantity4 INTEGER NOT NULL DEFAULT 0,
      RewardChoiceItemID5 INTEGER NOT NULL DEFAULT 0, RewardChoiceItemQuantity5 INTEGER NOT NULL DEFAULT 0,
      RewardChoiceItemID6 INTEGER NOT NULL DEFAULT 0, RewardChoiceItemQuantity6 INTEGER NOT NULL DEFAULT 0,
      POIContinent INTEGER NOT NULL DEFAULT 0, POIx REAL NOT NULL DEFAULT 0, POIy REAL NOT NULL DEFAULT 0, POIPriority INTEGER NOT NULL DEFAULT 0,
      RewardTitle INTEGER NOT NULL DEFAULT 0, RewardTalents INTEGER NOT NULL DEFAULT 0, RewardArenaPoints INTEGER NOT NULL DEFAULT 0,
      RewardFactionID1 INTEGER NOT NULL DEFAULT 0, RewardFactionValue1 INTEGER NOT NULL DEFAULT 0, RewardFactionOverride1 INTEGER NOT NULL DEFAULT 0,
      RewardFactionID2 INTEGER NOT NULL DEFAULT 0, RewardFactionValue2 INTEGER NOT NULL DEFAULT 0, RewardFactionOverride2 INTEGER NOT NULL DEFAULT 0,
      RewardFactionID3 INTEGER NOT NULL DEFAULT 0, RewardFactionValue3 INTEGER NOT NULL DEFAULT 0, RewardFactionOverride3 INTEGER NOT NULL DEFAULT 0,
      RewardFactionID4 INTEGER NOT NULL DEFAULT 0, RewardFactionValue4 INTEGER NOT NULL DEFAULT 0, RewardFactionOverride4 INTEGER NOT NULL DEFAULT 0,
      RewardFactionID5 INTEGER NOT NULL DEFAULT 0, RewardFactionValue5 INTEGER NOT NULL DEFAULT 0, RewardFactionOverride5 INTEGER NOT NULL DEFAULT 0,
      TimeAllowed INTEGER NOT NULL DEFAULT 0, AllowableRaces INTEGER NOT NULL DEFAULT 0,
      LogTitle TEXT, LogDescription TEXT, QuestDescription TEXT, AreaDescription TEXT, QuestCompletionLog TEXT,
      RequiredNpcOrGo1 INTEGER NOT NULL DEFAULT 0, RequiredNpcOrGo2 INTEGER NOT NULL DEFAULT 0,
      RequiredNpcOrGo3 INTEGER NOT NULL DEFAULT 0, RequiredNpcOrGo4 INTEGER NOT NULL DEFAULT 0,
      RequiredNpcOrGoCount1 INTEGER NOT NULL DEFAULT 0, RequiredNpcOrGoCount2 INTEGER NOT NULL DEFAULT 0,
      RequiredNpcOrGoCount3 INTEGER NOT NULL DEFAULT 0, RequiredNpcOrGoCount4 INTEGER NOT NULL DEFAULT 0,
      RequiredItemId1 INTEGER NOT NULL DEFAULT 0, RequiredItemId2 INTEGER NOT NULL DEFAULT 0, RequiredItemId3 INTEGER NOT NULL DEFAULT 0,
      RequiredItemId4 INTEGER NOT NULL DEFAULT 0, RequiredItemId5 INTEGER NOT NULL DEFAULT 0, RequiredItemId6 INTEGER NOT NULL DEFAULT 0,
      RequiredItemCount1 INTEGER NOT NULL DEFAULT 0, RequiredItemCount2 INTEGER NOT NULL DEFAULT 0, RequiredItemCount3 INTEGER NOT NULL DEFAULT 0,
      RequiredItemCount4 INTEGER NOT NULL DEFAULT 0, RequiredItemCount5 INTEGER NOT NULL DEFAULT 0, RequiredItemCount6 INTEGER NOT NULL DEFAULT 0,
      ObjectiveText1 TEXT, ObjectiveText2 TEXT, ObjectiveText3 TEXT, ObjectiveText4 TEXT
    );
    CREATE TABLE quest_template_addon (
      ID INTEGER PRIMARY KEY,
      MaxLevel INTEGER NOT NULL DEFAULT 0,
      AllowableClasses INTEGER NOT NULL DEFAULT 0,
      PrevQuestID INTEGER NOT NULL DEFAULT 0,
      NextQuestID INTEGER NOT NULL DEFAULT 0,
      ExclusiveGroup INTEGER NOT NULL DEFAULT 0,
      SpecialFlags INTEGER NOT NULL DEFAULT 0,
      ProvidedItemCount INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE creature_queststarter (id INTEGER NOT NULL, quest INTEGER NOT NULL);
    CREATE TABLE creature_questender (id INTEGER NOT NULL, quest INTEGER NOT NULL);
    CREATE TABLE questxp_dbc (
      ID INTEGER PRIMARY KEY,
      Difficulty_1 INTEGER NOT NULL DEFAULT 0, Difficulty_2 INTEGER NOT NULL DEFAULT 0,
      Difficulty_3 INTEGER NOT NULL DEFAULT 0, Difficulty_4 INTEGER NOT NULL DEFAULT 0,
      Difficulty_5 INTEGER NOT NULL DEFAULT 0, Difficulty_6 INTEGER NOT NULL DEFAULT 0,
      Difficulty_7 INTEGER NOT NULL DEFAULT 0, Difficulty_8 INTEGER NOT NULL DEFAULT 0,
      Difficulty_9 INTEGER NOT NULL DEFAULT 0, Difficulty_10 INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function insertKillQuest(db: Database, id: number, creature: number, count: number, title = "Kill Quest"): void {
  db.query(
    `INSERT INTO quest_template (
       ID, QuestType, QuestLevel, MinLevel, LogTitle, LogDescription, QuestDescription,
       AreaDescription, QuestCompletionLog, RequiredNpcOrGo1, RequiredNpcOrGoCount1,
       ObjectiveText1, ObjectiveText2, ObjectiveText3, ObjectiveText4
     ) VALUES (?, 2, 5, 1, ?, 'Objectives', 'Details', '', 'Done', ?, ?, 'Kill them', '', '', '')`,
  ).run(id, title, creature, count);
  db.query("INSERT INTO creature_queststarter (id, quest) VALUES (100, ?)").run(id);
  db.query("INSERT INTO creature_questender (id, quest) VALUES (100, ?)").run(id);
}

function insertTalkQuest(db: Database, id: number, creature: number, ender: number): void {
  db.query(
    `INSERT INTO quest_template (
       ID, QuestType, QuestLevel, MinLevel, LogTitle, LogDescription, QuestDescription,
       AreaDescription, QuestCompletionLog, RequiredNpcOrGo1, RequiredNpcOrGoCount1,
       ObjectiveText1, ObjectiveText2, ObjectiveText3, ObjectiveText4
     ) VALUES (?, 2, 5, 1, 'Talk Quest', 'Talk', 'Details', '', 'Done', ?, 1, 'Speak', '', '', '')`,
  ).run(id, creature);
  db.query("INSERT INTO creature_queststarter (id, quest) VALUES (200, ?)").run(id);
  db.query("INSERT INTO creature_questender (id, quest) VALUES (?, ?)").run(ender, id);
}

function insertDailyQuest(db: Database, id: number): void {
  db.query(
    `INSERT INTO quest_template (
       ID, QuestType, QuestLevel, MinLevel, Flags, LogTitle, LogDescription, QuestDescription,
       AreaDescription, QuestCompletionLog,
       ObjectiveText1, ObjectiveText2, ObjectiveText3, ObjectiveText4
     ) VALUES (?, 0, 5, 1, ?, 'Daily', 'Obj', 'Details', '', 'Done', '', '', '', '')`,
  ).run(id, QUEST_FLAGS_DAILY);
  db.query(
    "INSERT INTO quest_template_addon (ID, SpecialFlags) VALUES (?, 1)",
  ).run(id);
  db.query("INSERT INTO creature_queststarter (id, quest) VALUES (300, ?)").run(id);
  db.query("INSERT INTO creature_questender (id, quest) VALUES (300, ?)").run(id);
}

const speaker = { race: 1, classId: 1, level: 10 };

describe("quests", () => {
  test("accept kill quest, credit, reward, and block retake", () => {
    const db = openWorldDb();
    insertKillQuest(db, 1, 50, 3, "Wolves");
    db.query(
      "INSERT INTO questxp_dbc (ID, Difficulty_1) VALUES (5, 100)",
    ).run();
    const catalog = new QuestCatalog(db);
    const log = new QuestLog(catalog);
    log.speaker = speaker;

    expect(log.accept(1)).toBe("ok");
    expect(log.status(1)).toBe(QUEST_STATUS_INCOMPLETE);

    log.creditKill(50, 1n);
    log.creditKill(50, 2n);
    expect(log.status(1)).toBe(QUEST_STATUS_INCOMPLETE);
    log.creditKill(50, 3n);
    expect(log.status(1)).toBe(QUEST_STATUS_COMPLETE);
    expect(log.objective(1, 0)).toBe(3);

    const reward = log.reward(1, 0, speaker.level);
    expect(reward).not.toBeNull();
    expect(log.active().has(1)).toBe(false);
    expect(log.rewarded(1)).toBe(true);
    expect(log.canTake(1, speaker)).toBe(false);
  });

  test("talk credit only advances speak-to ender objectives", () => {
    const db = openWorldDb();
    insertKillQuest(db, 10, 77, 1, "Kill Only");
    insertTalkQuest(db, 11, 88, 88);
    const catalog = new QuestCatalog(db);
    const log = new QuestLog(catalog);
    log.speaker = speaker;

    expect(log.accept(10)).toBe("ok");
    expect(log.accept(11)).toBe("ok");

    expect(log.creditTalk(77)).toEqual([]);
    expect(log.objective(10, 0)).toBe(0);

    const talked = log.creditTalk(88);
    expect(talked).toHaveLength(1);
    expect(talked[0]!.questId).toBe(11);
    expect(talked[0]!.count).toBe(1);
    expect(log.status(11)).toBe(QUEST_STATUS_COMPLETE);
  });

  test("quest query response contains the title string", () => {
    const db = openWorldDb();
    insertKillQuest(db, 20, 1, 1, "Title Marker");
    const catalog = new QuestCatalog(db);
    const quest = catalog.quest(20)!;
    const body = buildQuestQueryResponse(quest, 10, catalog);
    const text = new TextDecoder().decode(body);
    expect(text.includes("Title Marker")).toBe(true);
  });

  test("add-kill packet field order", () => {
    const body = buildQuestUpdateAddKill(33, 44, 2, 5, 99n);
    const reader = new ByteReader(body);
    expect(reader.readU32()).toBe(33);
    expect(reader.readU32()).toBe(44);
    expect(reader.readU32()).toBe(2);
    expect(reader.readU32()).toBe(5);
    expect(reader.readU64()).toBe(99n);
  });

  test("save and load roundtrip of mob counts", () => {
    const world = openWorldDb();
    insertKillQuest(world, 40, 9, 4);
    const catalog = new QuestCatalog(world);
    const log = new QuestLog(catalog);
    log.speaker = speaker;
    expect(log.accept(40)).toBe("ok");
    log.creditKill(9, 1n);
    log.creditKill(9, 2n);
    expect(log.objective(40, 0)).toBe(2);

    const chars = new Database(":memory:", { strict: true });
    log.save(chars, 7);

    const loaded = new QuestLog(catalog);
    loaded.load(chars, 7);
    expect(loaded.status(40)).toBe(QUEST_STATUS_INCOMPLETE);
    expect(loaded.objective(40, 0)).toBe(2);
  });

  test("dialog status AVAILABLE for starter and REWARD when complete", () => {
    const db = openWorldDb();
    insertKillQuest(db, 50, 12, 1);
    const catalog = new QuestCatalog(db);
    const log = new QuestLog(catalog);
    log.speaker = speaker;

    expect(log.dialogStatus("creature", 100)).toBe(DIALOG_AVAILABLE);

    expect(log.accept(50)).toBe("ok");
    log.creditKill(12, 1n);
    expect(log.status(50)).toBe(QUEST_STATUS_COMPLETE);
    expect(log.dialogStatus("creature", 100)).toBe(DIALOG_REWARD);
  });

  test("daily reward then canTake is false", () => {
    const db = openWorldDb();
    insertDailyQuest(db, 60);
    const catalog = new QuestCatalog(db);
    const log = new QuestLog(catalog);
    log.speaker = speaker;

    expect(log.canTake(60, speaker)).toBe(true);
    expect(log.accept(60)).toBe("ok");
    expect(log.status(60)).toBe(QUEST_STATUS_COMPLETE);
    expect(log.reward(60, 0, speaker.level)).not.toBeNull();
    expect(log.canTake(60, speaker)).toBe(false);
  });

  test("swap exchanges occupied slots and an empty slot", () => {
    const db = openWorldDb();
    insertKillQuest(db, 70, 1, 1);
    insertKillQuest(db, 71, 2, 1);
    const log = new QuestLog(new QuestCatalog(db));
    log.speaker = speaker;
    expect(log.accept(70)).toBe("ok");
    expect(log.accept(71)).toBe("ok");
    expect(log.slotIds()[0]).toBe(70);
    expect(log.slotIds()[1]).toBe(71);
    expect(log.swap(0, 1)).toBe(true);
    expect(log.slotIds()[0]).toBe(71);
    expect(log.slotIds()[1]).toBe(70);
    expect(log.swap(0, 0)).toBe(false);
    expect(log.swap(0, 4)).toBe(true);
    expect(log.slotIds()[0]).toBe(0);
    expect(log.slotIds()[4]).toBe(71);
    expect(log.abandon(4)).toBe(71);
    expect(log.slotIds()[1]).toBe(70);
  });
});
