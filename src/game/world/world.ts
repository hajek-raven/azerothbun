import { SERVER_MSG_RESTART_CANCELLED, SERVER_MSG_RESTART_TIME, SERVER_MSG_SHUTDOWN_CANCELLED, SERVER_MSG_SHUTDOWN_TIME, sWorldSessionMgr } from "../Server/WorldSessionMgr.ts";
import { ConfigMgr, ConfigSeverity, defaultConfigPolicy } from "../../common/config.ts";
import { HOUR, IN_MILLISECONDS, MINUTE, SECOND } from "../../common/duration.ts";
import { log } from "../../log.ts";
import { getGameTime, getGameTimeMS, updateGameTimers } from "../time/game-time.ts";
import { getMSTime, getMSTimeDiffU32, IntervalTimer, secsToTimeString } from "../time/timer.ts";
import { worldUpdateTime, type WorldUpdateTime } from "../time/update-time.ts";
import { ServerConfig, WorldConfig } from "./world-config.ts";

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
 * The map update (`sMapMgr->Update`) runs after the sessions; auction and script updates join this method as those systems are ported.
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
  /** `WorldSessionMgr::UpdateSessions` — the world server registers its sessions here. */
  private sessionUpdate: ((diff: number) => void) | null = null;
  /** `sMapMgr->Update(diff)`: the map system registers itself at startup (`MapMgr` imports this file for `sWorld()`). */
  private mapUpdate: ((diff: number) => void) | null = null;
  /** `World::_dataPath`: `DataDir` with a trailing slash, `maps/`, `vmaps/`, and `mmaps/` below it. */
  private dataPath = "./";
  loopCounter = 0;

  constructor(
    readonly settings: WorldConfig,
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

  /** @ac game/World/World.h World::getBoolConfig */
  getBoolConfig(id: ServerConfig): boolean {
    return this.settings.getBool(id);
  }

  /** @ac game/World/World.h World::getIntConfig */
  getIntConfig(id: ServerConfig): number {
    return this.settings.getUInt(id);
  }

  /** @ac game/World/World.h World::getFloatConfig */
  getFloatConfig(id: ServerConfig): number {
    return this.settings.getFloat(id);
  }

  /** @ac game/World/World.h World::getRate */
  getRate(id: ServerConfig): number {
    return this.settings.getFloat(id);
  }

  /** @ac game/World/World.cpp World::IsPvPRealm (`REALM_TYPE_PVP`, `REALM_TYPE_RPPVP`, `REALM_TYPE_FFA_PVP`) */
  isPvPRealm(): boolean {
    const type = this.settings.getUInt(ServerConfig.CONFIG_GAME_TYPE);
    return type === 1 || type === 8 || type === 16;
  }

  /** @ac game/World/World.cpp World::IsFFAPvPRealm (`REALM_TYPE_FFA_PVP`) */
  isFFAPvPRealm(): boolean {
    return this.settings.getUInt(ServerConfig.CONFIG_GAME_TYPE) === 16;
  }

  /** @ac game/World/World.h World::getStringConfig */
  getStringConfig(id: ServerConfig): string {
    return this.settings.getString(id);
  }

  /** @ac game/World/World.h World::setBoolConfig */
  setBoolConfig(id: ServerConfig, value: boolean): void {
    this.settings.overwrite(id, value);
  }

  /** @ac game/World/World.h World::setIntConfig */
  setIntConfig(id: ServerConfig, value: number): void {
    this.settings.overwrite(id, value);
  }

  private isClosedFlag = false;
  private allowedSecurityLevel = 0;
  /** `realmlist.name` of this realm. */
  realmName = "";
  /** `WorldSessionMgr::_maxActiveSessionCount` */
  private maxActiveSessions = 0;

  /** @ac game/World/World.cpp World::IsClosed */
  isClosed(): boolean {
    return this.isClosedFlag;
  }

  /** @ac game/World/World.cpp World::SetClosed */
  setClosed(val: boolean): void {
    this.isClosedFlag = val;
  }

  /** @ac game/World/World.h World::GetPlayerSecurityLimit */
  getPlayerSecurityLimit(): number {
    return this.allowedSecurityLevel;
  }

  /** @ac game/World/World.cpp World::SetPlayerSecurityLimit (raising it kicks the sessions below the new level) */
  setPlayerSecurityLimit(security: number, kickAllLess?: (security: number) => void): void {
    const sec = security < 4 /* SEC_CONSOLE */ ? security : 0;
    const update = sec > this.allowedSecurityLevel;
    this.allowedSecurityLevel = sec;
    if (update) kickAllLess?.(sec);
  }

  /** @ac game/World/World.h World::GetShutDownTimeLeft */
  getShutDownTimeLeft(): number {
    return this.shutdownTimer;
  }

  getMaxActiveSessionCount(): number {
    return Math.max(this.maxActiveSessions, this.activeSessions);
  }

  getShutdownReason(): string {
    return this.shutdownReason;
  }

  isShuttingDown(): boolean {
    return this.shutdownTimer > 0;
  }

  getQueuedSessionCount(): number {
    return this.queuedSessions;
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
    this.maxActiveSessions = Math.max(this.maxActiveSessions, active);
    this.queuedSessions = queued;
  }

  getActiveSessionCount(): number {
    return this.activeSessions;
  }

  setSessionUpdate(update: ((diff: number) => void) | null): void {
    this.sessionUpdate = update;
  }

  /** @ac game/World/World.h World::GetDataPath */
  getDataPath(): string {
    return this.dataPath;
  }

  /**
   * @ac game/World/World.cpp World::LoadConfigSettings (the `DataDir` part)
   * An empty path or one without a trailing slash gets a `/`, a leading `~` is the home directory. A reload keeps the first
   * value (`DataDir option can't be changed at worldserver.conf reload`); returns false when it was refused.
   */
  loadDataPath(configured: string, reload = false): boolean {
    let dataPath = configured;
    if (dataPath.length === 0 || (!dataPath.endsWith("/") && !dataPath.endsWith("\\"))) dataPath += "/";
    if (dataPath.startsWith("~")) {
      const home = process.env.HOME;
      if (home) dataPath = home + dataPath.slice(1);
    }
    if (reload) {
      if (dataPath !== this.dataPath) {
        log("server", `DataDir option can't be changed at worldserver.conf reload, using current value (${this.dataPath}).`);
        return false;
      }
      return true;
    }
    this.dataPath = dataPath;
    log("server", `Using DataDir ${this.dataPath}`);
    return true;
  }

  /** The map update `World::Update` runs after the sessions (`sMapMgr->Update(diff)`). */
  setMapUpdate(update: ((diff: number) => void) | null): void {
    this.mapUpdate = update;
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

    this.sessionUpdate?.(diff);

    ///- Update objects when the timer has passed (maps, transport, creatures, ...)
    this.mapUpdate?.(diff);

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
    sWorldSessionMgr.SendServerMessage(restarting ? SERVER_MSG_RESTART_CANCELLED : SERVER_MSG_SHUTDOWN_CANCELLED);
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
    sWorldSessionMgr.SendServerMessage(restarting ? SERVER_MSG_RESTART_TIME : SERVER_MSG_SHUTDOWN_TIME, text);
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

let worldInstance: World | null = null;

/** `sWorld`. Set by the server at startup; code that runs without one (tests) gets a world with default config. */
export function sWorld(): World {
  worldInstance ??= new World(defaultWorldConfig());
  return worldInstance;
}

export function setWorldInstance(world: World | null): void {
  worldInstance = world;
}

/** A `WorldConfig` with every option at its `worldserver.conf.dist` default. */
export function defaultWorldConfig(): WorldConfig {
  const config = new ConfigMgr();
  const policy = defaultConfigPolicy();
  policy.missingOptionSeverity = ConfigSeverity.Skip;
  policy.criticalOptionSeverity = ConfigSeverity.Skip;
  policy.valueErrorSeverity = ConfigSeverity.Skip;
  config.configure("", [], "", policy);
  const settings = new WorldConfig(config);
  settings.load();
  return settings;
}
