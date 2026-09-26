import { randtime } from "./random.ts";

const AbortState = {
  Running: 0,
  AbortScheduled: 1,
  Aborted: 2,
} as const;

type AbortState = (typeof AbortState)[keyof typeof AbortState];

/**
 * `BasicEvent`. `execute` returns false when the event re-queued itself and must stay alive.
 */
export class BasicEvent {
  private abortState: AbortState = AbortState.Running;
  addTime = 0;
  execTime = 0;
  eventGroup = 0;

  execute(_eTime: number, _pTime: number): boolean {
    return true;
  }

  isDeletable(): boolean {
    return true;
  }

  abort(_eTime: number): void {}

  scheduleAbort(): void {
    if (this.abortState !== AbortState.Running) {
      throw new Error("Tried to scheduled the abortion of an event twice!");
    }
    this.abortState = AbortState.AbortScheduled;
  }

  setAborted(): void {
    if (this.abortState === AbortState.Aborted) {
      throw new Error("Tried to abort an already aborted event!");
    }
    this.abortState = AbortState.Aborted;
  }

  isRunning(): boolean {
    return this.abortState === AbortState.Running;
  }

  isAbortScheduled(): boolean {
    return this.abortState === AbortState.AbortScheduled;
  }

  isAborted(): boolean {
    return this.abortState === AbortState.Aborted;
  }
}

class LambdaBasicEvent extends BasicEvent {
  constructor(private readonly callback: () => void) {
    super();
  }

  override execute(): boolean {
    this.callback();
    return true;
  }
}

type QueuedEvent = { time: number; event: BasicEvent };

function insertByTime(events: QueuedEvent[], entry: QueuedEvent): void {
  let i = events.length;
  while (i > 0 && entry.time < events[i - 1]!.time) {
    i -= 1;
  }
  events.splice(i, 0, entry);
}

/** `EventProcessor`. Times are milliseconds on the processor clock. */
export class EventProcessor {
  private time = 0;
  private readonly events: QueuedEvent[] = [];

  update(pTime: number): void {
    this.time += pTime;
    while (this.events.length > 0 && this.events[0]!.time <= this.time) {
      const event = this.events.shift()!.event;
      if (event.isRunning()) {
        event.execute(this.time, pTime);
        continue;
      }
      if (event.isAbortScheduled()) {
        event.abort(this.time);
        event.setAborted();
      }
      if (event.isDeletable()) {
        continue;
      }
      this.addEvent(event, this.calculateTime(1), false);
    }
  }

  killAllEvents(force: boolean): void {
    const kept: QueuedEvent[] = [];
    for (const entry of this.events) {
      if (!entry.event.isAborted()) {
        entry.event.setAborted();
        entry.event.abort(this.time);
      }
      if (!force && !entry.event.isDeletable()) {
        kept.push(entry);
      }
    }
    this.events.length = 0;
    if (!force) {
      this.events.push(...kept);
    }
  }

  addEvent(event: BasicEvent | (() => void), eTime: number, setAddTime = true, eventGroup = 0): void {
    const basic = typeof event === "function" ? new LambdaBasicEvent(event) : event;
    if (setAddTime) {
      basic.addTime = this.time;
    }
    basic.execTime = eTime;
    basic.eventGroup = eventGroup;
    insertByTime(this.events, { time: eTime, event: basic });
  }

  addEventAtOffset(event: BasicEvent | (() => void), offset: number, eventGroup = 0): void {
    this.addEvent(event, this.calculateTime(offset), true, eventGroup);
  }

  addEventAtRandomOffset(event: BasicEvent | (() => void), offset: number, offset2: number, eventGroup = 0): void {
    this.addEvent(event, this.calculateTime(randtime(offset, offset2)), true, eventGroup);
  }

  modifyEventTime(event: BasicEvent, newTime: number): void {
    const index = this.events.findIndex((entry) => entry.event === event);
    if (index < 0) {
      return;
    }
    const [entry] = this.events.splice(index, 1);
    if (!entry) {
      return;
    }
    entry.event.execTime = newTime;
    entry.time = newTime;
    insertByTime(this.events, entry);
  }

  calculateTime(offset: number): number {
    return this.time + offset;
  }

  calculateQueueTime(delay: number): number {
    return this.calculateTime(delay - (this.time % delay));
  }

  cancelEventGroup(group: number): void {
    const kept: QueuedEvent[] = [];
    for (const entry of this.events) {
      if (entry.event.eventGroup !== group) {
        kept.push(entry);
        continue;
      }
      if (!entry.event.isAborted()) {
        entry.event.setAborted();
        entry.event.abort(this.time);
      }
    }
    this.events.length = 0;
    this.events.push(...kept);
  }

  hasEvents(): boolean {
    return this.events.length > 0;
  }

  now(): number {
    return this.time;
  }
}
