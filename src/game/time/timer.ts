import { DAY, HOUR, MINUTE, SECOND } from "../../common/duration.ts";

const applicationStart = performance.now();

export function getApplicationStartTime(): number {
  return applicationStart;
}

/** Milliseconds since process start. Matches `GetTimeMS`. */
export function getTimeMS(): number {
  return performance.now() - applicationStart;
}

/** `uint32` milliseconds since process start. Matches `getMSTime`. */
export function getMSTime(): number {
  return Math.floor(getTimeMS()) >>> 0;
}

/** Absolute difference of two millisecond timestamps. Matches `GetMSTimeDiff(Milliseconds)`. */
export function getMSTimeDiff(oldMSTime: number, newMSTime: number): number {
  if (oldMSTime > newMSTime) {
    return oldMSTime - newMSTime;
  }
  return newMSTime - oldMSTime;
}

/** Wrapping `uint32` difference. Matches `getMSTimeDiff(uint32, uint32)`. */
export function getMSTimeDiffU32(oldMSTime: number, newMSTime: number): number {
  if (oldMSTime > newMSTime) {
    return (0xffffffff - oldMSTime + newMSTime) >>> 0;
  }
  return (newMSTime - oldMSTime) >>> 0;
}

export function getEpochTime(): number {
  return Math.floor(Date.now() / 1000);
}

/** `1d2h3m4s` to seconds. A trailing number without a unit is dropped, same as `TimeStringToSecs`. */
export function timeStringToSecs(timestring: string): number {
  let secs = 0;
  let buffer = 0;
  for (const char of timestring) {
    if (char >= "0" && char <= "9") {
      buffer = buffer * 10 + (char.charCodeAt(0) - 48);
      continue;
    }
    let multiplier = 0;
    switch (char) {
      case "d":
        multiplier = DAY;
        break;
      case "h":
        multiplier = HOUR;
        break;
      case "m":
        multiplier = MINUTE;
        break;
      case "s":
        multiplier = SECOND;
        break;
      default:
        return 0;
    }
    secs += buffer * multiplier;
    buffer = 0;
  }
  return secs;
}

export function secsToTimeString(timeInSecs: number, shortText = false): string {
  const secs = timeInSecs % MINUTE;
  const minutes = Math.floor(timeInSecs % HOUR / MINUTE);
  const hours = Math.floor(timeInSecs % DAY / HOUR);
  const days = Math.floor(timeInSecs / DAY);
  let text = "";
  if (days) {
    text += `${days}${shortText ? "d" : " day(s) "}`;
  }
  if (hours) {
    text += `${hours}${shortText ? "h" : " hour(s) "}`;
  }
  if (minutes) {
    text += `${minutes}${shortText ? "m" : " minute(s) "}`;
  }
  if (secs || (!days && !hours && !minutes)) {
    text += `${secs}${shortText ? "s" : " second(s) "}`;
  }
  if (!shortText && text.endsWith(" ")) {
    return text.slice(0, -1);
  }
  return text;
}

/** Matches `IntervalTimer`. An interval of 0 resets to 0 instead of dividing by zero. */
export class IntervalTimer {
  private interval = 0;
  private current = 0;

  update(diff: number): void {
    this.current += diff;
    if (this.current < 0) {
      this.current = 0;
    }
  }

  passed(): boolean {
    return this.current >= this.interval;
  }

  reset(): void {
    if (this.interval === 0) {
      this.current = 0;
      return;
    }
    if (this.current >= this.interval) {
      this.current %= this.interval;
    }
  }

  setCurrent(current: number): void {
    this.current = current;
  }

  setInterval(interval: number): void {
    this.interval = interval;
  }

  getInterval(): number {
    return this.interval;
  }

  getCurrent(): number {
    return this.current;
  }
}

/** Countdown in milliseconds. Matches `TimeTracker`. */
export class TimeTracker {
  constructor(private expiryTime: number) {}

  update(diff: number): void {
    this.expiryTime -= diff;
  }

  passed(): boolean {
    return this.expiryTime <= 0;
  }

  reset(interval: number): void {
    this.expiryTime = interval;
  }

  getExpiry(): number {
    return this.expiryTime;
  }
}

/** 32-bit countdown. Matches `TimeTrackerSmall`. */
export class TimeTrackerSmall {
  constructor(private expiryTime = 0) {}

  update(diff: number): void {
    this.expiryTime -= diff;
  }

  passed(): boolean {
    return this.expiryTime <= 0;
  }

  reset(interval: number): void {
    this.expiryTime = interval;
  }

  getExpiry(): number {
    return this.expiryTime;
  }
}

/**
 * Fires once per `update` when the countdown crosses zero, then arms the next period.
 * Matches `PeriodicTimer`.
 */
export class PeriodicTimer {
  private period: number;
  private expireTime: number;

  constructor(period: number, startTime: number) {
    this.period = period;
    this.expireTime = startTime;
  }

  update(diff: number): boolean {
    this.expireTime -= diff;
    if (this.expireTime > 0) {
      return false;
    }
    this.expireTime += this.period > diff ? this.period : diff;
    return true;
  }

  setPeriodic(period: number, startTime: number): void {
    this.expireTime = startTime;
    this.period = period;
  }
}

export function getMSTimeDiffToNow(oldMSTime: number): number {
  return getMSTimeDiffU32(oldMSTime, getMSTime());
}

export const TimeFormat = {
  FullText: 0,
  ShortText: 1,
  Numeric: 2,
} as const;

export type TimeFormat = (typeof TimeFormat)[keyof typeof TimeFormat];

export const TimeOutput = {
  Days: 0,
  Hours: 1,
  Minutes: 2,
  Seconds: 3,
  Milliseconds: 4,
  Microseconds: 5,
} as const;

export type TimeOutput = (typeof TimeOutput)[keyof typeof TimeOutput];

const US_PER_MS = 1000;
const US_PER_SEC = 1000 * US_PER_MS;
const US_PER_MIN = 60 * US_PER_SEC;
const US_PER_HOUR = 60 * US_PER_MIN;
const US_PER_DAY = 24 * US_PER_HOUR;

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * `Acore::Time::ToTimeString` for a microsecond count.
 * The C++ numeric format string has one more placeholder than it passes; microseconds fill that field.
 */
export function toTimeString(
  durationUs: number,
  timeOutput: TimeOutput = TimeOutput.Seconds,
  timeFormat: TimeFormat = TimeFormat.ShortText,
): string {
  const microsecs = durationUs % 1000;
  const millisecs = Math.floor(durationUs / US_PER_MS) % 1000;
  const secs = Math.floor(durationUs / US_PER_SEC) % 60;
  const minutes = Math.floor(durationUs / US_PER_MIN) % 60;
  const hours = Math.floor(durationUs / US_PER_HOUR) % 24;
  const days = Math.floor(durationUs / US_PER_DAY);

  if (timeFormat === TimeFormat.Numeric) {
    if (days) {
      return `${days}:${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}:${pad2(millisecs)}:${pad2(microsecs)}`;
    }
    if (hours) {
      return `${hours}:${pad2(minutes)}:${pad2(secs)}:${pad2(millisecs)}:${pad2(microsecs)}`;
    }
    if (minutes) {
      return `${minutes}:${pad2(secs)}:${pad2(millisecs)}:${pad2(microsecs)}`;
    }
    if (secs) {
      return `${secs}:${pad2(millisecs)}:${pad2(microsecs)}`;
    }
    if (millisecs) {
      return `${millisecs}:${pad2(microsecs)}`;
    }
    return `${microsecs}`;
  }

  const parts: string[] = [];
  let captured = "";
  const push = (timeType: number, shortText: string, one: string, many: string): void => {
    switch (timeFormat) {
      case TimeFormat.ShortText:
        parts.push(`${timeType}${shortText}`);
        break;
      case TimeFormat.FullText:
        parts.push(`${timeType}${timeType === 1 ? one : many}`);
        break;
      default: {
        const unreachable: never = timeFormat;
        throw new Error(`unknown time format ${String(unreachable)}`);
      }
    }
  };
  const snap = (output: TimeOutput): void => {
    if (timeOutput === output) {
      captured = parts.join("");
    }
  };

  if (days) {
    push(days, "d ", " Day ", " Days ");
  }
  snap(TimeOutput.Days);
  if (hours) {
    push(hours, "h ", " Hour ", " Hours ");
  }
  snap(TimeOutput.Hours);
  if (minutes) {
    push(minutes, "m ", " Minute ", " Minutes ");
  }
  snap(TimeOutput.Minutes);
  if (secs) {
    push(secs, "s ", " Second ", " Seconds ");
  }
  snap(TimeOutput.Seconds);
  if (millisecs) {
    push(millisecs, "ms ", " Millisecond ", " Milliseconds ");
  }
  snap(TimeOutput.Milliseconds);
  if (microsecs) {
    push(microsecs, "us ", " Microsecond ", " Microseconds ");
  }
  snap(TimeOutput.Microseconds);
  return captured.trimEnd();
}

export type BrokenTime = {
  sec: number;
  min: number;
  hour: number;
  mday: number;
  mon: number;
  year: number;
  wday: number;
  yday: number;
};

function brokenTime(time = 0): BrokenTime {
  const unix = time || getEpochTime();
  const date = new Date(unix * 1000);
  const start = new Date(date.getFullYear(), 0, 1);
  const yday = Math.floor((date.getTime() - start.getTime()) / (DAY * 1000));
  return {
    sec: date.getSeconds(),
    min: date.getMinutes(),
    hour: date.getHours(),
    mday: date.getDate(),
    mon: date.getMonth(),
    year: date.getFullYear() - 1900,
    wday: date.getDay(),
    yday,
  };
}

/** POSIX `timezone`: standard (non-DST) seconds to add to local time to get UTC. */
function posixTimezoneSeconds(): number {
  const year = new Date().getFullYear();
  const jan = new Date(year, 0, 1).getTimezoneOffset();
  const jul = new Date(year, 6, 1).getTimezoneOffset();
  return Math.max(jan, jul) * 60;
}

export function localTimeToUTCTime(time: number): number {
  return time + posixTimezoneSeconds();
}

export function getLocalHourTimestamp(time: number, hour: number, onlyAfterTime = true): number {
  const parts = brokenTime(time);
  const midnight = new Date(parts.year + 1900, parts.mon, parts.mday, 0, 0, 0, 0);
  let hourLocal = Math.floor(midnight.getTime() / 1000) + hour * HOUR;
  if (onlyAfterTime && hourLocal <= time) {
    hourLocal += DAY;
  }
  return hourLocal;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const TIME_TOKENS = ["%Y", "%m", "%d", "%H", "%M", "%S", "%X", "%a", "%b"] as const;

type TimeToken = (typeof TIME_TOKENS)[number];

function formatToken(token: TimeToken, parts: BrokenTime, year: number): string {
  switch (token) {
    case "%Y":
      return year.toString().padStart(4, "0");
    case "%m":
      return (parts.mon + 1).toString().padStart(2, "0");
    case "%d":
      return parts.mday.toString().padStart(2, "0");
    case "%H":
      return parts.hour.toString().padStart(2, "0");
    case "%M":
      return parts.min.toString().padStart(2, "0");
    case "%S":
      return parts.sec.toString().padStart(2, "0");
    case "%X":
      return `${parts.hour.toString().padStart(2, "0")}:${parts.min.toString().padStart(2, "0")}:${parts.sec.toString().padStart(2, "0")}`;
    case "%a":
      return WEEKDAYS[parts.wday] ?? "Sun";
    case "%b":
      return MONTHS[parts.mon] ?? "Jan";
    default: {
      const unreachable: never = token;
      return unreachable;
    }
  }
}

function formatLocal(time: number, fmt: string): string {
  const parts = brokenTime(time);
  const year = parts.year + 1900;
  return fmt.replace(/%Y|%m|%d|%H|%M|%S|%X|%a|%b/g, (token) => formatToken(token as TimeToken, parts, year));
}

export function timeToTimestampStr(time = 0, fmt = "%Y-%m-%d %X"): string {
  return formatLocal(time || getEpochTime(), fmt);
}

export function timeToHumanReadable(time = 0, fmt = "%a %b %d %Y %X"): string {
  return formatLocal(time || getEpochTime(), fmt);
}

export function getNextTimeWithDayAndHour(dayOfWeek: number, hour: number): number {
  const clampedHour = hour < 0 || hour > 23 ? 0 : hour;
  const now = brokenTime();
  let day = dayOfWeek;
  if (day < 0 || day > 6) {
    day = (now.wday + 1) % 7;
  }
  const add = now.wday >= day ? (7 - (now.wday - day)) * DAY : (day - now.wday) * DAY;
  const local = new Date(now.year + 1900, now.mon, now.mday, clampedHour, 0, 0, 0);
  return Math.floor(local.getTime() / 1000) + add;
}

export function getNextTimeWithMonthAndHour(month: number, hour: number): number {
  const clampedHour = hour < 0 || hour > 23 ? 0 : hour;
  const now = brokenTime();
  let year = now.year;
  let mon = month;
  if (mon < 0 || mon > 11) {
    mon = (now.mon + 1) % 12;
    if (!mon) {
      year += 1;
    }
  } else if (now.mon >= mon) {
    year += 1;
  }
  const local = new Date(year + 1900, mon, 1, clampedHour, 0, 0, 0);
  return Math.floor(local.getTime() / 1000);
}

export function getSeconds(time = 0): number {
  return brokenTime(time).sec;
}

export function getMinutes(time = 0): number {
  return brokenTime(time).min;
}

export function getHours(time = 0): number {
  return brokenTime(time).hour;
}

export function getDayInWeek(time = 0): number {
  return brokenTime(time).wday;
}

export function getDayInMonth(time = 0): number {
  return brokenTime(time).mday;
}

export function getDayInYear(time = 0): number {
  return brokenTime(time).yday;
}

export function getMonth(time = 0): number {
  return brokenTime(time).mon;
}

export function getYear(time = 0): number {
  return brokenTime(time).year;
}
