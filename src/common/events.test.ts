import { expect, test } from "bun:test";
import { BasicEvent, EventProcessor } from "./event-processor.ts";
import { EVENT_TIME_NONE, EventMap } from "./event-map.ts";
import { TaskScheduler } from "./task-scheduler.ts";

class CountingEvent extends BasicEvent {
  executed = 0;
  aborted = 0;
  constructor(
    private readonly keep: boolean,
    private readonly deletable = true,
  ) {
    super();
  }

  override execute(): boolean {
    this.executed += 1;
    return !this.keep;
  }

  override abort(): void {
    this.aborted += 1;
  }

  override isDeletable(): boolean {
    return this.deletable;
  }
}

test("events run in time order and equal times keep insertion order", () => {
  const processor = new EventProcessor();
  const order: number[] = [];
  processor.addEventAtOffset(() => order.push(2), 20);
  processor.addEventAtOffset(() => order.push(1), 10);
  processor.addEventAtOffset(() => order.push(3), 20);
  processor.update(10);
  expect(order).toEqual([1]);
  processor.update(10);
  expect(order).toEqual([1, 2, 3]);
  expect(processor.hasEvents()).toBe(false);
});

test("abort skips execute, and a non-deletable event is checked again next tick", () => {
  const processor = new EventProcessor();
  const event = new CountingEvent(false, false);
  processor.addEvent(event, 10);
  event.scheduleAbort();
  processor.update(10);
  expect(event.executed).toBe(0);
  expect(event.aborted).toBe(1);
  expect(event.isAborted()).toBe(true);
  expect(processor.hasEvents()).toBe(true);
  processor.update(1);
  expect(event.aborted).toBe(1);
  expect(processor.hasEvents()).toBe(true);
});

test("cancelEventGroup aborts that group and leaves the rest queued", () => {
  const processor = new EventProcessor();
  const grouped = new CountingEvent(false);
  const other = new CountingEvent(false);
  processor.addEvent(grouped, 50, true, 3);
  processor.addEvent(other, 50, true, 4);
  processor.cancelEventGroup(3);
  expect(grouped.aborted).toBe(1);
  processor.update(50);
  expect(other.executed).toBe(1);
  expect(grouped.executed).toBe(0);
});

test("modifyEventTime and calculateQueueTime use the processor clock", () => {
  const processor = new EventProcessor();
  const event = new CountingEvent(false);
  processor.addEvent(event, 100);
  processor.modifyEventTime(event, 40);
  processor.update(40);
  expect(event.executed).toBe(1);
  processor.update(250);
  expect(processor.calculateQueueTime(1000)).toBe(1000);
});

test("killAllEvents aborts queued events", () => {
  const processor = new EventProcessor();
  const event = new CountingEvent(false, true);
  processor.addEvent(event, 10);
  processor.killAllEvents(true);
  expect(event.aborted).toBe(1);
  expect(processor.hasEvents()).toBe(false);
  processor.update(10);
  expect(event.executed).toBe(0);
});

test("event map phases, repeat, delay, and cancel", () => {
  const map = new EventMap();
  map.scheduleEvent(1, 100, 1, 1);
  map.scheduleEvent(2, 100, 2, 2);
  map.setPhase(1);
  map.update(100);
  expect(map.executeEvent()).toBe(1);
  map.addPhase(2);
  expect(map.executeEvent()).toBe(2);
  map.repeat(50);
  expect(map.getTimeUntilEvent(2)).toBe(50);
  map.delayEvents(25);
  expect(map.getTimeUntilEvent(2)).toBe(75);
  map.cancelEvent(2);
  expect(map.hasTimeUntilEvent(2)).toBe(false);
  expect(map.getTimeUntilEvent(2)).toBe(EVENT_TIME_NONE);
});

test("reschedule replaces an event and delayEventsToMax drops its phase", () => {
  const map = new EventMap();
  map.scheduleEvent(4, 10, 1, 2);
  map.rescheduleEvent(4, 40, 1, 2);
  expect(map.getTimeUntilEvent(4)).toBe(40);

  const delayed = new EventMap();
  delayed.scheduleEvent(4, 10, 1, 2);
  delayed.delayEventsToMax(30, 1);
  expect(delayed.getTimeUntilEvent(4)).toBe(30);
  delayed.update(30);
  expect(delayed.executeEvent()).toBe(4);

  const hidden = new EventMap();
  hidden.scheduleEvent(4, 10, 1, 2);
  hidden.delayEventsToMax(30, 1);
  hidden.setPhase(1);
  hidden.update(30);
  expect(hidden.executeEvent()).toBe(4);
});

test("task scheduler runs async work before due tasks and repeats from the context", () => {
  const scheduler = new TaskScheduler();
  const order: string[] = [];
  scheduler.async(() => order.push("async"));
  scheduler.schedule(10, (context) => {
    order.push(`run-${context.getRepeatCounter()}`);
    if (context.getRepeatCounter() === 0) {
      context.repeat(10);
    }
  });
  scheduler.update(10);
  expect(order).toEqual(["async", "run-0"]);
  scheduler.update(10);
  expect(order).toEqual(["async", "run-0", "run-1"]);
});

test("validator stops dispatch, and cancelGroup drops that group", () => {
  let allow = true;
  const scheduler = new TaskScheduler(() => allow);
  const ran: number[] = [];
  scheduler.schedule(0, 1, () => ran.push(1));
  scheduler.schedule(0, 2, () => ran.push(2));
  allow = false;
  let finished = false;
  scheduler.update(0, () => {
    finished = true;
  });
  expect(ran).toEqual([]);
  expect(finished).toBe(false);
  allow = true;
  scheduler.cancelGroup(1);
  scheduler.update(0);
  expect(ran).toEqual([2]);
  expect(scheduler.isGroupScheduled(2)).toBe(false);
});

test("delay and a task scheduled from a context use the task end", () => {
  const scheduler = new TaskScheduler();
  const ran: string[] = [];
  scheduler.schedule(10, (context) => {
    ran.push("first");
    context.schedule(0, () => ran.push("follow"));
  });
  scheduler.schedule(10, 7, () => ran.push("grouped"));
  scheduler.delayGroup(7, 10);
  scheduler.update(10);
  expect(ran).toEqual(["first", "follow"]);
  scheduler.update(10);
  expect(ran).toEqual(["first", "follow", "grouped"]);
});
