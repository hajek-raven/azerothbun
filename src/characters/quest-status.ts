import type { Database } from "bun:sqlite";

export type ActiveQuestRow = {
  quest: number;
  status: number;
  explored: number;
  timer: number;
  mobcount1: number;
  mobcount2: number;
  mobcount3: number;
  mobcount4: number;
  itemcount1: number;
  itemcount2: number;
  itemcount3: number;
  itemcount4: number;
  itemcount5: number;
  itemcount6: number;
  playercount: number;
};

export type QuestStatusState = {
  active: ActiveQuestRow[];
  rewarded: { quest: number; active: number }[];
  daily: { quest: number; time: number }[];
  weekly: { quest: number }[];
  monthly: { quest: number }[];
  seasonal: { quest: number; event: number }[];
};

export function ensureQuestStatusTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_queststatus (
      guid INTEGER NOT NULL DEFAULT 0,
      quest INTEGER NOT NULL DEFAULT 0,
      status INTEGER NOT NULL DEFAULT 0,
      explored INTEGER NOT NULL DEFAULT 0,
      timer INTEGER NOT NULL DEFAULT 0,
      mobcount1 INTEGER NOT NULL DEFAULT 0,
      mobcount2 INTEGER NOT NULL DEFAULT 0,
      mobcount3 INTEGER NOT NULL DEFAULT 0,
      mobcount4 INTEGER NOT NULL DEFAULT 0,
      itemcount1 INTEGER NOT NULL DEFAULT 0,
      itemcount2 INTEGER NOT NULL DEFAULT 0,
      itemcount3 INTEGER NOT NULL DEFAULT 0,
      itemcount4 INTEGER NOT NULL DEFAULT 0,
      itemcount5 INTEGER NOT NULL DEFAULT 0,
      itemcount6 INTEGER NOT NULL DEFAULT 0,
      playercount INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guid, quest)
    );
    CREATE TABLE IF NOT EXISTS character_queststatus_rewarded (
      guid INTEGER NOT NULL DEFAULT 0,
      quest INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (guid, quest)
    );
    CREATE TABLE IF NOT EXISTS character_queststatus_daily (
      guid INTEGER NOT NULL DEFAULT 0,
      quest INTEGER NOT NULL DEFAULT 0,
      time INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guid, quest)
    );
    CREATE TABLE IF NOT EXISTS character_queststatus_weekly (
      guid INTEGER NOT NULL DEFAULT 0,
      quest INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guid, quest)
    );
    CREATE TABLE IF NOT EXISTS character_queststatus_monthly (
      guid INTEGER NOT NULL DEFAULT 0,
      quest INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guid, quest)
    );
    CREATE TABLE IF NOT EXISTS character_queststatus_seasonal (
      guid INTEGER NOT NULL DEFAULT 0,
      quest INTEGER NOT NULL DEFAULT 0,
      event INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guid, quest)
    );
  `);
}

export function loadQuestStatus(db: Database, guid: number): QuestStatusState {
  ensureQuestStatusTables(db);

  const active = db
    .query(
      `SELECT quest, status, explored, timer,
              mobcount1, mobcount2, mobcount3, mobcount4,
              itemcount1, itemcount2, itemcount3, itemcount4, itemcount5, itemcount6,
              playercount
       FROM character_queststatus WHERE guid = $guid`,
    )
    .all({ guid }) as ActiveQuestRow[];

  const rewarded = db
    .query("SELECT quest, active FROM character_queststatus_rewarded WHERE guid = $guid")
    .all({ guid }) as { quest: number; active: number }[];

  const daily = db
    .query("SELECT quest, time FROM character_queststatus_daily WHERE guid = $guid")
    .all({ guid }) as { quest: number; time: number }[];

  const weekly = db
    .query("SELECT quest FROM character_queststatus_weekly WHERE guid = $guid")
    .all({ guid }) as { quest: number }[];

  const monthly = db
    .query("SELECT quest FROM character_queststatus_monthly WHERE guid = $guid")
    .all({ guid }) as { quest: number }[];

  const seasonal = db
    .query("SELECT quest, event FROM character_queststatus_seasonal WHERE guid = $guid")
    .all({ guid }) as { quest: number; event: number }[];

  return { active, rewarded, daily, weekly, monthly, seasonal };
}

export function saveQuestStatus(db: Database, guid: number, state: QuestStatusState): void {
  ensureQuestStatusTables(db);

  const save = db.transaction(() => {
    db.query("DELETE FROM character_queststatus WHERE guid = $guid").run({ guid });
    db.query("DELETE FROM character_queststatus_rewarded WHERE guid = $guid").run({ guid });
    db.query("DELETE FROM character_queststatus_daily WHERE guid = $guid").run({ guid });
    db.query("DELETE FROM character_queststatus_weekly WHERE guid = $guid").run({ guid });
    db.query("DELETE FROM character_queststatus_monthly WHERE guid = $guid").run({ guid });
    db.query("DELETE FROM character_queststatus_seasonal WHERE guid = $guid").run({ guid });

    const insertActive = db.query(
      `INSERT INTO character_queststatus (
         guid, quest, status, explored, timer,
         mobcount1, mobcount2, mobcount3, mobcount4,
         itemcount1, itemcount2, itemcount3, itemcount4, itemcount5, itemcount6,
         playercount
       ) VALUES (
         $guid, $quest, $status, $explored, $timer,
         $mobcount1, $mobcount2, $mobcount3, $mobcount4,
         $itemcount1, $itemcount2, $itemcount3, $itemcount4, $itemcount5, $itemcount6,
         $playercount
       )`,
    );
    for (const row of state.active) {
      insertActive.run({ guid, ...row });
    }

    const insertRewarded = db.query(
      "INSERT INTO character_queststatus_rewarded (guid, quest, active) VALUES ($guid, $quest, $active)",
    );
    for (const row of state.rewarded) {
      insertRewarded.run({ guid, quest: row.quest, active: row.active });
    }

    const insertDaily = db.query(
      "INSERT INTO character_queststatus_daily (guid, quest, time) VALUES ($guid, $quest, $time)",
    );
    for (const row of state.daily) {
      insertDaily.run({ guid, quest: row.quest, time: row.time });
    }

    const insertWeekly = db.query(
      "INSERT INTO character_queststatus_weekly (guid, quest) VALUES ($guid, $quest)",
    );
    for (const row of state.weekly) {
      insertWeekly.run({ guid, quest: row.quest });
    }

    const insertMonthly = db.query(
      "INSERT INTO character_queststatus_monthly (guid, quest) VALUES ($guid, $quest)",
    );
    for (const row of state.monthly) {
      insertMonthly.run({ guid, quest: row.quest });
    }

    const insertSeasonal = db.query(
      "INSERT INTO character_queststatus_seasonal (guid, quest, event) VALUES ($guid, $quest, $event)",
    );
    for (const row of state.seasonal) {
      insertSeasonal.run({ guid, quest: row.quest, event: row.event });
    }
  });

  save();
}
