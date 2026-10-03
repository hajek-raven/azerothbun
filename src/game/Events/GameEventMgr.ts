/**
 * `sGameEventMgr` (`GameEventMgr.cpp`): the `game_event` rows. The event scheduler is not ported: the server shows the
 * default spawn set, where every positive event is off, so the active event list is empty.
 */
import { game_event } from "../../database/schema/world.ts";
import type { WorldTables } from "../../database/world-tables.ts";

/** @ac game/Events/GameEventMgr.h GameEventData */
export type GameEventData = {
  start: number;
  end: number;
  occurence: number;
  length: number;
  holiday_id: number;
  holidayStage: number;
  description: string;
  state: number;
  announce: number;
};

export class GameEventMgr {
  private events: GameEventData[] = [];
  private readonly activeEvents = new Set<number>();

  /** @ac game/Events/GameEventMgr.cpp GameEventMgr::LoadFromDB (the `game_event` part) */
  loadFromDB(world: WorldTables | null): void {
    this.events = [];
    for (const row of world?.all(game_event) ?? []) {
      this.events[row.eventEntry] = {
        start: row.start_time ? Math.floor(row.start_time.getTime() / 1000) : 0,
        end: row.end_time ? Math.floor(row.end_time.getTime() / 1000) : 0,
        occurence: Number(row.occurence),
        length: Number(row.length),
        holiday_id: row.holiday,
        holidayStage: row.holidayStage,
        description: row.description ?? "",
        state: row.world_event,
        announce: row.announce,
      };
    }
  }

  /** @ac game/Events/GameEventMgr.h GameEventMgr::GetEventMap (indexed by event id; missing ids are holes) */
  GetEventMap(): readonly (GameEventData | undefined)[] {
    return this.events;
  }

  /** @ac game/Events/GameEventMgr.h GameEventMgr::GetActiveEventList */
  GetActiveEventList(): ReadonlySet<number> {
    return this.activeEvents;
  }

  /** @ac game/Events/GameEventMgr.h GameEventMgr::IsActiveEvent */
  IsActiveEvent(eventId: number): boolean {
    return this.activeEvents.has(eventId);
  }
}

export const sGameEventMgr = new GameEventMgr();
