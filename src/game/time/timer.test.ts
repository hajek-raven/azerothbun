import { expect, test } from "bun:test";
import {
  getDayInYear,
  getHours,
  getLocalHourTimestamp,
  PeriodicTimer,
  secsToTimeString,
  TimeFormat,
  TimeOutput,
  TimeTracker,
  timeToTimestampStr,
  toTimeString,
} from "./timer.ts";

test("duration strings and the microsecond formatter", () => {
  expect(secsToTimeString(90)).toBe("1 minute(s) 30 second(s)");
  expect(secsToTimeString(90, true)).toBe("1m30s");
  expect(toTimeString(1_000_000, TimeOutput.Seconds, TimeFormat.FullText)).toBe("1 Second");
  expect(toTimeString(2_000_000, TimeOutput.Seconds, TimeFormat.ShortText)).toBe("2s");
  expect(toTimeString(86_400_000_000, TimeOutput.Seconds, TimeFormat.ShortText)).toBe("1d");
  expect(toTimeString(1_500, TimeOutput.Microseconds, TimeFormat.ShortText)).toBe("1ms 500us");
});

test("trackers and the periodic timer", () => {
  const tracker = new TimeTracker(100);
  tracker.update(40);
  expect(tracker.passed()).toBe(false);
  tracker.update(60);
  expect(tracker.passed()).toBe(true);

  const periodic = new PeriodicTimer(100, 50);
  expect(periodic.update(40)).toBe(false);
  expect(periodic.update(20)).toBe(true);
});

test("local time helpers agree with Date for a fixed unix time", () => {
  const unix = 1_600_000_000;
  const date = new Date(unix * 1000);
  expect(getHours(unix)).toBe(date.getHours());
  const start = new Date(date.getFullYear(), 0, 1);
  expect(getDayInYear(unix)).toBe(Math.floor((date.getTime() - start.getTime()) / 86_400_000));
  const stamp = timeToTimestampStr(unix, "%Y-%m-%d %H:%M:%S");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  expect(stamp).toBe(`${date.getFullYear()}-${month}-${day} ${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`);
  const hour = getLocalHourTimestamp(unix, 15, true);
  expect(hour).toBeGreaterThan(unix);
});
