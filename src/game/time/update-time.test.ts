import { expect, test } from "bun:test";
import { getMSTimeDiff, getMSTimeDiffU32, secsToTimeString, timeStringToSecs } from "./timer.ts";
import { UpdateTime } from "./update-time.ts";

test("update time tracks the mean, the weighted mean, and the median", () => {
  const time = new UpdateTime();
  time.updateWithDiff(10);
  time.updateWithDiff(30);
  expect(time.getAverageUpdateTime()).toBe(20);
  expect(time.getTimeWeightedAverageUpdateTime()).toBe(25);
  expect(time.getLastUpdateTime()).toBe(30);
  expect(time.getDatasetSize()).toBe(2);
  expect(time.getPercentile(50)).toBe(20);
  expect(time.getPercentile(100)).toBe(30);
  expect(time.getMaxUpdateTime()).toBe(30);
});

test("an empty update-time table reports a zero percentile", () => {
  expect(new UpdateTime().getPercentile(95)).toBe(0);
});

test("millisecond differences match Timer.h", () => {
  expect(getMSTimeDiff(5, 8)).toBe(3);
  expect(getMSTimeDiff(8, 5)).toBe(3);
  expect(getMSTimeDiffU32(0xfffffff0, 1)).toBe(16);
});

test("shutdown delays parse the same way as TimeStringToSecs", () => {
  expect(timeStringToSecs("1h30m")).toBe(5400);
  expect(timeStringToSecs("30")).toBe(0);
  expect(timeStringToSecs("1x")).toBe(0);
  expect(secsToTimeString(90)).toBe("1 minute(s) 30 second(s)");
  expect(secsToTimeString(90, true)).toBe("1m30s");
});
