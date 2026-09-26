import { randtime } from "./random.ts";

/** Returned by `getTimeUntilEvent` when the id is not scheduled. Matches `Milliseconds::max()` for callers that only compare. */
export const EVENT_TIME_NONE = Number.MAX_SAFE_INTEGER;

const MASK_BITS = 8;

type ScheduledEvent = {
  time: number;
  id: number;
  groupMask: number;
  phaseMask: number;
};

function groupMask(group: number): number {
  return group ? (1 << (group - 1)) & 0xff : 0;
}

function phaseMask(phase: number): number {
  return phase ? (1 << (phase - 1)) & 0xff : 0;
}

function insertByTime(events: ScheduledEvent[], entry: ScheduledEvent): void {
  let i = events.length;
  while (i > 0 && entry.time < events[i - 1]!.time) {
    i -= 1;
  }
  events.splice(i, 0, entry);
}

/**
 * `EventMap`. The clock starts at 0, which behaves like `TimePoint::min()` plus elapsed milliseconds.
 * Group and phase indexes are 1..8. 0 means "no group" or "every phase".
 */
export class EventMap {
  private time = 0;
  private phase = 0;
  private lastEvent: ScheduledEvent = { time: 0, id: 0, groupMask: 0, phaseMask: 0 };
  private readonly events: ScheduledEvent[] = [];

  reset(): void {
    this.events.length = 0;
    this.time = 0;
    this.phase = 0;
  }

  update(time: number): void {
    this.time += time;
  }

  getPhaseMask(): number {
    return this.phase;
  }

  empty(): boolean {
    return this.events.length === 0;
  }

  setPhase(phase: number): void {
    if (!phase) {
      this.phase = 0;
    } else if (phase <= MASK_BITS) {
      this.phase = phaseMask(phase);
    }
  }

  addPhase(phase: number): void {
    if (phase && phase <= MASK_BITS) {
      this.phase |= phaseMask(phase);
    }
  }

  removePhase(phase: number): void {
    if (phase && phase <= MASK_BITS) {
      this.phase &= ~phaseMask(phase) & 0xff;
    }
  }

  scheduleEvent(eventId: number, time: number, group = 0, phase = 0): void {
    if (group > MASK_BITS || phase > MASK_BITS) {
      return;
    }
    insertByTime(this.events, {
      time: this.time + time,
      id: eventId,
      groupMask: groupMask(group),
      phaseMask: phaseMask(phase),
    });
  }

  scheduleEventRange(eventId: number, minTime: number, maxTime: number, group = 0, phase = 0): void {
    this.scheduleEvent(eventId, randtime(minTime, maxTime), group, phase);
  }

  rescheduleEvent(eventId: number, time: number, group = 0, phase = 0): void {
    this.cancelEvent(eventId);
    this.scheduleEvent(eventId, time, group, phase);
  }

  rescheduleEventRange(eventId: number, minTime: number, maxTime: number, group = 0, phase = 0): void {
    this.cancelEvent(eventId);
    this.scheduleEvent(eventId, randtime(minTime, maxTime), group, phase);
  }

  repeat(time: number): void {
    insertByTime(this.events, {
      time: this.time + time,
      id: this.lastEvent.id,
      groupMask: this.lastEvent.groupMask,
      phaseMask: this.lastEvent.phaseMask,
    });
  }

  repeatRange(minTime: number, maxTime: number): void {
    this.repeat(randtime(minTime, maxTime));
  }

  /** Next due id, or 0 when nothing is ready. Event id 0 is indistinguishable from "none", same as C++. */
  executeEvent(): number {
    while (!this.empty()) {
      const entry = this.events[0]!;
      if (entry.time > this.time) {
        return 0;
      }
      if (this.phase && entry.phaseMask && (entry.phaseMask & this.phase) === 0) {
        this.events.shift();
        continue;
      }
      this.lastEvent = entry;
      this.events.shift();
      return entry.id;
    }
    return 0;
  }

  delayEvents(delay: number): void;
  delayEvents(delay: number, group: number): void;
  delayEvents(delay: number, group?: number): void {
    if (group === undefined) {
      if (this.empty()) {
        return;
      }
      const delayed = this.events.splice(0, this.events.length);
      for (const entry of delayed) {
        entry.time += delay;
        insertByTime(this.events, entry);
      }
      return;
    }
    if (group > MASK_BITS || this.empty()) {
      return;
    }
    const bit = groupMask(group);
    const delayed: ScheduledEvent[] = [];
    const kept: ScheduledEvent[] = [];
    for (const entry of this.events) {
      if (!group || (entry.groupMask & bit) !== 0) {
        delayed.push({ ...entry, time: entry.time + delay });
        continue;
      }
      kept.push(entry);
    }
    this.events.length = 0;
    this.events.push(...kept);
    for (const entry of delayed) {
      insertByTime(this.events, entry);
    }
  }

  /**
   * Events of `group` that would fire before `delay` are moved to exactly `delay`.
   * The rescheduled row uses `group` and phase 0, same as `EventMap::DelayEventsToMax`.
   */
  delayEventsToMax(delay: number, group: number): void {
    const limit = this.time + delay;
    const bit = groupMask(group);
    for (let i = 0; i < this.events.length;) {
      const entry = this.events[i]!;
      if (entry.time < limit && (!group || (entry.groupMask & bit) !== 0)) {
        this.scheduleEvent(entry.id, delay, group);
        const index = this.events.indexOf(entry);
        this.events.splice(index, 1);
        i = 0;
        continue;
      }
      i += 1;
    }
  }

  cancelEvent(eventId: number): void {
    if (this.empty()) {
      return;
    }
    for (let i = 0; i < this.events.length;) {
      if (this.events[i]!.id === eventId) {
        this.events.splice(i, 1);
        continue;
      }
      i += 1;
    }
  }

  cancelEventGroup(group: number): void {
    if (!group || group > MASK_BITS || this.empty()) {
      return;
    }
    const bit = groupMask(group);
    for (let i = 0; i < this.events.length;) {
      if ((this.events[i]!.groupMask & bit) !== 0) {
        this.events.splice(i, 1);
        i = 0;
        continue;
      }
      i += 1;
    }
  }

  isInPhase(phase: number): boolean {
    return phase <= MASK_BITS && (!phase || (this.phase & phaseMask(phase)) !== 0);
  }

  getTimeUntilEvent(eventId: number): number {
    for (const entry of this.events) {
      if (entry.id === eventId) {
        return entry.time - this.time;
      }
    }
    return EVENT_TIME_NONE;
  }

  hasTimeUntilEvent(eventId: number): boolean {
    return this.getTimeUntilEvent(eventId) !== EVENT_TIME_NONE;
  }
}
