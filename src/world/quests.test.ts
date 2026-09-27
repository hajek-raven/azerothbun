import { testDatabase } from "../database/test-db.ts";
import {
  creature_questender,
  creature_queststarter,
  quest_template,
  quest_template_addon,
} from "../database/schema/world.ts";
import { worldFromSql } from "../database/test-world.ts";
import { WorldTables } from "../database/world-tables.ts";
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

function openWorldDb(): WorldTables {
  return WorldTables.fromRows();
}

const TEXTS = { LogDescription: "Objectives", QuestDescription: "Details", AreaDescription: "", QuestCompletionLog: "Done", ObjectiveText2: "", ObjectiveText3: "", ObjectiveText4: "" };

function insertKillQuest(db: WorldTables, id: number, creature: number, count: number, title = "Kill Quest"): void {
  db.insert(quest_template, [
    { ...TEXTS, ID: id, QuestType: 2, QuestLevel: 5, MinLevel: 1, LogTitle: title, RequiredNpcOrGo1: creature, RequiredNpcOrGoCount1: count, ObjectiveText1: "Kill them" },
  ]);
  db.insert(creature_queststarter, [{ id: 100, quest: id }]);
  db.insert(creature_questender, [{ id: 100, quest: id }]);
}

function insertTalkQuest(db: WorldTables, id: number, creature: number, ender: number): void {
  db.insert(quest_template, [
    { ...TEXTS, ID: id, QuestType: 2, QuestLevel: 5, MinLevel: 1, LogTitle: "Talk Quest", LogDescription: "Talk", RequiredNpcOrGo1: creature, RequiredNpcOrGoCount1: 1, ObjectiveText1: "Speak" },
  ]);
  db.insert(creature_queststarter, [{ id: 200, quest: id }]);
  db.insert(creature_questender, [{ id: ender, quest: id }]);
}

function insertDailyQuest(db: WorldTables, id: number): void {
  db.insert(quest_template, [
    { ...TEXTS, ID: id, QuestType: 0, QuestLevel: 5, MinLevel: 1, Flags: QUEST_FLAGS_DAILY, LogTitle: "Daily", LogDescription: "Obj", ObjectiveText1: "" },
  ]);
  db.insert(quest_template_addon, [{ ID: id, SpecialFlags: 1 }]);
  db.insert(creature_queststarter, [{ id: 300, quest: id }]);
  db.insert(creature_questender, [{ id: 300, quest: id }]);
}

const speaker = { race: 1, classId: 1, level: 10 };

describe("quests", () => {
  test("accept kill quest, credit, reward, and block retake", () => {
    const db = openWorldDb();
    insertKillQuest(db, 1, 50, 3, "Wolves");
    worldFromSql("INSERT INTO questxp_dbc (ID, Difficulty_1) VALUES (5, 100)", db);
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

  test("looted items count toward item objectives (ItemAddedQuestCheck) and HasQuestForItem follows them", () => {
    const db = openWorldDb();
    db.insert(quest_template, [
      { ...TEXTS, ID: 30, QuestType: 2, QuestLevel: 5, MinLevel: 1, LogTitle: "Pelts", RequiredItemId1: 750, RequiredItemCount1: 3, ObjectiveText1: "" },
    ]);
    db.insert(creature_queststarter, [{ id: 100, quest: 30 }]);
    const log = new QuestLog(new QuestCatalog(db));
    log.speaker = speaker;
    let owned = 0;
    const opts = { ownedCount: () => owned, itemProto: () => ({ maxcount: 0, maxStackSize: 20 }) };
    expect(log.hasQuestForItem(750, opts)).toBe(false);
    expect(log.accept(30)).toBe("ok");
    expect(log.hasQuestForItem(750, opts)).toBe(true);

    expect(log.itemAddedQuestCheck(750, 2)).toBe(false);
    owned = 2;
    expect(log.active().get(30)!.item[0]).toBe(2);
    // the bags already hold enough: the loot view hides it (showInLoot) while the quest still wants it
    owned = 3;
    const showInLoot = { value: true };
    expect(log.hasQuestForItem(750, { ...opts, showInLoot })).toBe(false);
    expect(showInLoot.value).toBe(false);

    expect(log.itemAddedQuestCheck(750, 5)).toBe(true);
    expect(log.active().get(30)!.item[0]).toBe(3);
    expect(log.status(30)).toBe(QUEST_STATUS_COMPLETE);
    expect(log.hasQuestForItem(750, opts)).toBe(false);
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

  test("save and load roundtrip of mob counts", async () => {
    const world = openWorldDb();
    insertKillQuest(world, 40, 9, 4);
    const catalog = new QuestCatalog(world);
    const log = new QuestLog(catalog);
    log.speaker = speaker;
    expect(log.accept(40)).toBe("ok");
    log.creditKill(9, 1n);
    log.creditKill(9, 2n);
    expect(log.objective(40, 0)).toBe(2);

    const chars = await testDatabase("characters");
    await log.save(chars, 7);

    const loaded = new QuestLog(catalog);
    await loaded.load(chars, 7);
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
