import { eq } from "drizzle-orm";
import type { Db } from "../database/database.ts";
import {
  character_queststatus,
  character_queststatus_daily,
  character_queststatus_monthly,
  character_queststatus_rewarded,
  character_queststatus_seasonal,
  character_queststatus_weekly,
} from "../database/schema/characters.ts";

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

const ACTIVE_COLUMNS = {
  quest: character_queststatus.quest,
  status: character_queststatus.status,
  explored: character_queststatus.explored,
  timer: character_queststatus.timer,
  mobcount1: character_queststatus.mobcount1,
  mobcount2: character_queststatus.mobcount2,
  mobcount3: character_queststatus.mobcount3,
  mobcount4: character_queststatus.mobcount4,
  itemcount1: character_queststatus.itemcount1,
  itemcount2: character_queststatus.itemcount2,
  itemcount3: character_queststatus.itemcount3,
  itemcount4: character_queststatus.itemcount4,
  itemcount5: character_queststatus.itemcount5,
  itemcount6: character_queststatus.itemcount6,
  playercount: character_queststatus.playercount,
};

export async function loadQuestStatus(db: Db, guid: number): Promise<QuestStatusState> {
  const active: ActiveQuestRow[] = await db.select(ACTIVE_COLUMNS).from(character_queststatus).where(eq(character_queststatus.guid, guid));
  const rewarded = await db
    .select({ quest: character_queststatus_rewarded.quest, active: character_queststatus_rewarded.active })
    .from(character_queststatus_rewarded)
    .where(eq(character_queststatus_rewarded.guid, guid));
  const daily = await db
    .select({ quest: character_queststatus_daily.quest, time: character_queststatus_daily.time })
    .from(character_queststatus_daily)
    .where(eq(character_queststatus_daily.guid, guid));
  const weekly = await db
    .select({ quest: character_queststatus_weekly.quest })
    .from(character_queststatus_weekly)
    .where(eq(character_queststatus_weekly.guid, guid));
  const monthly = await db
    .select({ quest: character_queststatus_monthly.quest })
    .from(character_queststatus_monthly)
    .where(eq(character_queststatus_monthly.guid, guid));
  const seasonal = await db
    .select({ quest: character_queststatus_seasonal.quest, event: character_queststatus_seasonal.event })
    .from(character_queststatus_seasonal)
    .where(eq(character_queststatus_seasonal.guid, guid));

  return { active, rewarded, daily, weekly, monthly, seasonal };
}

export async function saveQuestStatus(db: Db, guid: number, state: QuestStatusState): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(character_queststatus).where(eq(character_queststatus.guid, guid));
    await tx.delete(character_queststatus_rewarded).where(eq(character_queststatus_rewarded.guid, guid));
    await tx.delete(character_queststatus_daily).where(eq(character_queststatus_daily.guid, guid));
    await tx.delete(character_queststatus_weekly).where(eq(character_queststatus_weekly.guid, guid));
    await tx.delete(character_queststatus_monthly).where(eq(character_queststatus_monthly.guid, guid));
    await tx.delete(character_queststatus_seasonal).where(eq(character_queststatus_seasonal.guid, guid));

    if (state.active.length > 0) {
      await tx.insert(character_queststatus).values(state.active.map((row) => ({ guid, ...row })));
    }
    if (state.rewarded.length > 0) {
      await tx.insert(character_queststatus_rewarded).values(state.rewarded.map((row) => ({ guid, quest: row.quest, active: row.active })));
    }
    if (state.daily.length > 0) {
      await tx.insert(character_queststatus_daily).values(state.daily.map((row) => ({ guid, quest: row.quest, time: row.time })));
    }
    if (state.weekly.length > 0) {
      await tx.insert(character_queststatus_weekly).values(state.weekly.map((row) => ({ guid, quest: row.quest })));
    }
    if (state.monthly.length > 0) {
      await tx.insert(character_queststatus_monthly).values(state.monthly.map((row) => ({ guid, quest: row.quest })));
    }
    if (state.seasonal.length > 0) {
      await tx
        .insert(character_queststatus_seasonal)
        .values(state.seasonal.map((row) => ({ guid, quest: row.quest, event: row.event })));
    }
  });
}
