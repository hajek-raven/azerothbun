import { getEpochTime, getTimeMS } from "./timer.ts";

let startTime = getEpochTime();
let gameTime = startTime;
let gameMsTime = 0;
let systemTime = Date.now();
let steadyTime = performance.now();

export function getStartTime(): number {
  return startTime;
}

export function getGameTime(): number {
  return gameTime;
}

export function getGameTimeMS(): number {
  return gameMsTime;
}

export function getSystemTime(): number {
  return systemTime;
}

export function now(): number {
  return steadyTime;
}

export function getUptime(): number {
  return gameTime - startTime;
}

export function elapsed(start: number): number {
  return (now() - start) * 1000;
}

export function hasElapsed(start: number, durationMs: number): boolean {
  return now() - start >= durationMs;
}

export function updateGameTimers(): void {
  gameTime = getEpochTime();
  gameMsTime = getTimeMS();
  systemTime = Date.now();
  steadyTime = performance.now();
}

/** Test hook. The running server leaves the start time at process launch. */
export function resetGameTimeForTests(): void {
  startTime = getEpochTime();
  gameTime = startTime;
  gameMsTime = 0;
  systemTime = Date.now();
  steadyTime = performance.now();
}
