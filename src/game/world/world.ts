import { HOUR, IN_MILLISECONDS, MINUTE, SECOND } from "../../common/duration.ts";
import { log } from "../../log.ts";
import { getGameTime, getGameTimeMS, updateGameTimers } from "../time/game-time.ts";
import { getMSTime, getMSTimeDiffU32, IntervalTimer, secsToTimeString } from "../time/timer.ts";
import { worldUpdateTime, type WorldUpdateTime } from "../time/update-time.ts";
import { ServerConfig, type WorldConfig } from "./world-config.ts";

export const WorldTimer = {
  WUPDATE_UPTIME: 0,
  WUPDATE_EVENTS: 1,
  WUPDATE_CLEANDB: 2,
  WUPDATE_AUTOBROADCAST: 3,
  WUPDATE_MAILBOXQUEUE: 4,
  WUPDATE_PINGDB: 5,
  WUPDATE_5_SECS: 6,
  WUPDATE_WHO_LIST: 7,
  WUPDATE_COUNT: 8,
} as const;

export type WorldTimer = (typeof WorldTimer)[keyof typeof WorldTimer];

export const ShutdownMask = {
  Restart: 1,
  Idle: 2,
} as const;

export type ShutdownMask = (typeof ShutdownMask)[keyof typeof ShutdownMask];

export const ShutdownExitCode = {
  Shutdown: 0,
  Error: 1,
  Restart: 2,
} as const;

export type ShutdownExitCode = (typeof ShutdownExitCode)[keyof typeof ShutdownExitCode];

/**
 * The world tick from `World::Update` for game time, shutdown, and the world timers.
 * Map, session, auction, and script updates join this method as those systems are ported.
 */
export class World {
  private readonly timers: IntervalTimer[];
  private stopEvent = false;
  private shutdownTimer = 0;
  private shutdownMask = 0;
  private exitCode: number = ShutdownExitCode.Shutdown;
  private shutdownReason = "";
  private activeSessions = 0;
  private queuedSessions = 0;
  loopCounter = 0;

  constructor(
    private readonly settings: WorldConfig,
    private readonly updateTime: WorldUpdateTime = worldUpdateTime,
  ) {
    this.timers = Array.from({ length: WorldTimer.WUPDATE_COUNT }, () => new IntervalTimer());
    this.initTimers();
  }

  private initTimers(): void {
    this.timers[WorldTimer.WUPDATE_UPTIME]?.setInterval(this.settings.getUInt(ServerConfig.CONFIG_UPTIME_UPDATE) * MINUTE * IN_MILLISECONDS);
    this.timers[WorldTimer.WUPDATE_CLEANDB]?.setInterval(
      this.settings.getUInt(ServerConfig.CONFIG_LOGDB_CLEARINTERVAL) * MINUTE * IN_MILLISECONDS,
    );
    this.timers[WorldTimer.WUPDATE_AUTOBROADCAST]?.setInterval(this.settings.getUInt(ServerConfig.CONFIG_AUTOBROADCAST_INTERVAL));
    this.timers[WorldTimer.WUPDATE_PINGDB]?.setInterval(this.settings.getUInt(ServerConfig.CONFIG_DB_PING_INTERVAL) * MINUTE * IN_MILLISECONDS);
    this.timers[WorldTimer.WUPDATE_5_SECS]?.setInterval(5 * IN_MILLISECONDS);
    this.timers[WorldTimer.WUPDATE_WHO_LIST]?.setInterval(5 * IN_MILLISECONDS);
  }

  isStopped(): boolean {
    return this.stopEvent;
  }

  getExitCode(): number {
    return this.exitCode;
  }

  getShutdownTimer(): number {
    return this.shutdownTimer;
  }

  timer(index: WorldTimer): IntervalTimer {
    const timer = this.timers[index];
    if (!timer) {
      throw new Error(`missing world timer ${index}`);
    }
    return timer;
  }

  setSessionCounts(active: number, queued = 0): void {
    this.activeSessions = active;
    this.queuedSessions = queued;
  }

  getActiveSessionCount(): number {
    return this.activeSessions;
  }

  getActiveAndQueuedSessionCount(): number {
    return this.activeSessions + this.queuedSessions;
  }

  update(diff: number): void {
    this.updateGameTime();
    this.updateTime.updateWithDiff(diff);
    this.updateTime.recordUpdateTime(getGameTimeMS(), diff, this.activeSessions);

    for (let index = 0; index < WorldTimer.WUPDATE_COUNT; index++) {
      const timer = this.timers[index];
      if (!timer) {
        continue;
      }
      if (timer.getCurrent() >= 0) {
        timer.update(diff);
      } else {
        timer.setCurrent(0);
      }
    }

    if (this.timer(WorldTimer.WUPDATE_5_SECS).passed()) {
      this.timer(WorldTimer.WUPDATE_5_SECS).reset();
    }
    if (this.timer(WorldTimer.WUPDATE_WHO_LIST).passed()) {
      this.timer(WorldTimer.WUPDATE_WHO_LIST).reset();
    }
    if (this.settings.getUInt(ServerConfig.CONFIG_LOGDB_CLEARTIME) > 0 && this.timer(WorldTimer.WUPDATE_CLEANDB).passed()) {
      this.timer(WorldTimer.WUPDATE_CLEANDB).reset();
    }
    if (this.settings.getBool(ServerConfig.CONFIG_AUTOBROADCAST) && this.timer(WorldTimer.WUPDATE_AUTOBROADCAST).passed()) {
      this.timer(WorldTimer.WUPDATE_AUTOBROADCAST).reset();
    }
    if (this.timer(WorldTimer.WUPDATE_UPTIME).passed()) {
      this.timer(WorldTimer.WUPDATE_UPTIME).reset();
    }
    if (this.timer(WorldTimer.WUPDATE_PINGDB).passed()) {
      this.timer(WorldTimer.WUPDATE_PINGDB).reset();
    }
  }

  shutdownServ(time: number, options: number, exitcode: number = ShutdownExitCode.Shutdown, reason = ""): void {
    if (this.isStopped()) {
      return;
    }
    this.shutdownMask = options;
    this.exitCode = exitcode;
    this.shutdownReason = reason;
    log(
      "server",
      `Server shutdown called with ShutdownMask ${options}, ExitCode ${exitcode}, Time ${secsToTimeString(time)}, Reason ${reason}`,
    );
    if (time === 0) {
      if ((options & ShutdownMask.Idle) === 0 || this.getActiveAndQueuedSessionCount() === 0) {
        this.stopEvent = true;
      } else {
        this.shutdownTimer = 1;
      }
      return;
    }
    this.shutdownTimer = time;
    this.shutdownMsg(true, reason);
  }

  shutdownCancel(): void {
    if (this.shutdownTimer === 0 || this.stopEvent) {
      return;
    }
    const restarting = (this.shutdownMask & ShutdownMask.Restart) !== 0;
    this.shutdownMask = 0;
    this.shutdownTimer = 0;
    this.exitCode = ShutdownExitCode.Shutdown;
    log("server", `Server ${restarting ? "restart" : "shuttingdown"} cancelled.`);
  }

  stopNow(exitcode: ShutdownExitCode): void {
    this.exitCode = exitcode;
    this.stopEvent = true;
  }

  private updateGameTime(): void {
    const lastGameTime = getGameTime();
    updateGameTimers();
    const elapsed = getGameTime() - lastGameTime;
    if (this.isStopped() || this.shutdownTimer <= 0 || elapsed <= 0) {
      return;
    }
    if (this.shutdownTimer <= elapsed) {
      if (!this.rescheduleShutdownForWintergrasp()) {
        if ((this.shutdownMask & ShutdownMask.Idle) === 0 || this.getActiveAndQueuedSessionCount() === 0) {
          this.stopEvent = true;
        } else {
          this.shutdownTimer = 1;
        }
      }
      return;
    }
    this.shutdownTimer -= elapsed;
    this.shutdownMsg(false);
  }

  /** No Wintergrasp battle is running until that system is ported, so a deferral never applies. */
  private rescheduleShutdownForWintergrasp(): boolean {
    const bufferMinutes = this.settings.getUInt(ServerConfig.CONFIG_WINTERGRASP_DEFER_SHUTDOWN);
    if (!bufferMinutes) {
      return false;
    }
    if ((this.shutdownMask & ShutdownMask.Idle) !== 0) {
      return false;
    }
    return false;
  }

  private shutdownMsg(show: boolean, reason = ""): void {
    if ((this.shutdownMask & ShutdownMask.Idle) !== 0) {
      return;
    }
    const twelveHours = this.shutdownTimer > 12 * HOUR && this.shutdownTimer % (12 * HOUR) === 0;
    const oneHour = this.shutdownTimer < 12 * HOUR && this.shutdownTimer % HOUR === 0;
    const fiveMin = this.shutdownTimer < 30 * MINUTE && this.shutdownTimer % (5 * MINUTE) === 0;
    const oneMin = this.shutdownTimer < 15 * MINUTE && this.shutdownTimer % MINUTE === 0;
    const thirtySec = this.shutdownTimer < 5 * MINUTE && this.shutdownTimer % 30 === 0;
    const tenSec = this.shutdownTimer < 1 * MINUTE && this.shutdownTimer % 10 === 0;
    const oneSec = this.shutdownTimer < 10 * SECOND && this.shutdownTimer % 1 === 0;
    if (!(show || twelveHours || oneHour || fiveMin || oneMin || thirtySec || tenSec || oneSec)) {
      return;
    }
    let text = `${secsToTimeString(this.shutdownTimer)}.`;
    if (reason.length > 0) {
      text += ` - ${reason}`;
    } else if (
      this.shutdownReason.length > 0 &&
      (twelveHours || oneHour || fiveMin || oneMin || this.shutdownTimer === 60 || this.shutdownTimer === 10)
    ) {
      text += ` - ${this.shutdownReason}`;
    }
    const restarting = (this.shutdownMask & ShutdownMask.Restart) !== 0;
    log("server", `Server ${restarting ? "restarting" : "shutdown"} in ${text}`);
  }
}

/**
 * `WorldUpdateLoop` on the event loop. Each tick is one timer, so sockets, the console, and signals
 * run between world updates the way the C++ network and CLI threads run beside the world thread.
 */
export function startWorldUpdateLoop(
  world: World,
  options: { minUpdateDiff: number; maxCoreStuckTime: number; onStop?: () => void },
): { stop: () => void } {
  const minUpdateDiff = options.minUpdateDiff >>> 0;
  let realPrevTime = getMSTime();
  const maxCoreStuckTime = (options.maxCoreStuckTime * IN_MILLISECONDS) >>> 0;
  let halfMaxCoreStuckTime = Math.floor(maxCoreStuckTime / 2);
  if (!halfMaxCoreStuckTime) {
    halfMaxCoreStuckTime = 0xffffffff;
  }

  const tick = (): void => {
    if (world.isStopped()) {
      options.onStop?.();
      return;
    }
    world.loopCounter += 1;
    const realCurrTime = getMSTime();
    const diff = getMSTimeDiffU32(realPrevTime, realCurrTime);
    if (diff < minUpdateDiff) {
      const sleepTime = minUpdateDiff - diff;
      if (sleepTime >= halfMaxCoreStuckTime) {
        log("server", `WorldUpdateLoop() waiting for ${sleepTime} ms with MaxCoreStuckTime set to ${maxCoreStuckTime} ms`);
      }
      timer = setTimeout(tick, sleepTime);
      return;
    }
    try {
      world.update(diff);
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      log("server", `World::Update failed: ${message}`);
    }
    realPrevTime = realCurrTime;
    const elapsed = getMSTimeDiffU32(realCurrTime, getMSTime());
    timer = setTimeout(tick, Math.max(0, minUpdateDiff - elapsed));
  };
  let timer = setTimeout(tick, 0);

  return {
    stop() {
      clearTimeout(timer);
    },
  };
}
