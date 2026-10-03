/** `cs_server.cpp`: `.server info|motd|debug|corpses|exit|shutdown|restart|idleshutdown|idlerestart|set …`. */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { executeStatement, queryFields } from "../../database/database.ts";
import { CharacterDatabase, LoginDatabase, WorldDatabase } from "../../database/DatabaseEnv.ts";
import { LOGIN_REP_MOTD, LOGIN_REP_MOTD_LOCALE, LOGIN_UPD_REALMLIST_SECURITY_LEVEL } from "../../gen/LoginDatabase.gen.ts";
import { configureLogging, type LogLevel } from "../../log.ts";
import { GetLocaleByName, GetNameByLocaleConstant, IsLocaleValid, localeNames } from "../../common/Common.ts";
import { VMapFactory } from "../../common/Collision/Management/VMapFactory.ts";
import { GitRevision } from "../../common/GitRevision.ts";
import { stringStartsWith } from "../../common/util.ts";
import {
  RBAC_PERM_COMMAND_SERVER_CORPSES,
  RBAC_PERM_COMMAND_SERVER_DEBUG,
  RBAC_PERM_COMMAND_SERVER_EXIT,
  RBAC_PERM_COMMAND_SERVER_IDLERESTART,
  RBAC_PERM_COMMAND_SERVER_IDLERESTART_CANCEL,
  RBAC_PERM_COMMAND_SERVER_IDLESHUTDOWN,
  RBAC_PERM_COMMAND_SERVER_IDLESHUTDOWN_CANCEL,
  RBAC_PERM_COMMAND_SERVER_INFO,
  RBAC_PERM_COMMAND_SERVER_MOTD,
  RBAC_PERM_COMMAND_SERVER_RESTART,
  RBAC_PERM_COMMAND_SERVER_RESTART_CANCEL,
  RBAC_PERM_COMMAND_SERVER_SET_CLOSED,
  RBAC_PERM_COMMAND_SERVER_SET_LOGLEVEL,
  RBAC_PERM_COMMAND_SERVER_SET_MOTD,
  RBAC_PERM_COMMAND_SERVER_SET_SECURITY,
  RBAC_PERM_COMMAND_SERVER_SHUTDOWN,
  RBAC_PERM_COMMAND_SERVER_SHUTDOWN_CANCEL,
} from "../../game/Accounts/RBACDefines.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { boolArg, int32Arg, Optional, stringArg, uint8Arg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { Tail } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import {
  LANG_BAD_VALUE,
  LANG_COMMAND_EXIT,
  LANG_COMMAND_SERVER_INFO_SECURITY,
  LANG_COMMAND_SERVER_SET_SECURITY,
  LANG_COMMAND_SERVER_SET_SECURITY_ERROR,
  LANG_GENERIC_TWO_CURLIES_WITH_COLON,
  LANG_MOTD_CURRENT,
  LANG_MOTD_NEW,
  LANG_SHUTDOWN_TIMELEFT,
  LANG_UPTIME,
  LANG_USE_BOL,
  LANG_WORLD_CLOSED,
  LANG_WORLD_OPENED,
} from "../../game/Miscellaneous/Language.ts";
import { sMotdMgr } from "../../game/Motd/MotdMgr.ts";
import { sWorldSessionMgr } from "../../game/Server/WorldSessionMgr.ts";
import { getUptime } from "../../game/time/game-time.ts";
import { secsToTimeString, timeStringToSecs } from "../../game/time/timer.ts";
import { worldUpdateTime } from "../../game/time/update-time.ts";
import { ServerConfig } from "../../game/world/world-config.ts";
import { ShutdownExitCode, ShutdownMask, sWorld } from "../../game/world/world.ts";
import { LOCALE_enUS, SEC_ADMINISTRATOR, SEC_PLAYER, TOTAL_LOCALES } from "../../shared/SharedDefines.ts";
import { realm } from "../../shared/Realms/Realm.ts";

/** @ac scripts/Commands/cs_server.cpp server_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const shutdownArgs = [stringArg, Optional(int32Arg), Tail] as const;
  const serverIdleRestartCommandTable: ChatCommandTable = [
    ChatCommand("cancel", [], HandleServerShutDownCancelCommand, RBAC_PERM_COMMAND_SERVER_IDLERESTART_CANCEL, Console.Yes),
    ChatCommand("", shutdownArgs, HandleServerIdleRestartCommand, RBAC_PERM_COMMAND_SERVER_IDLERESTART, Console.Yes),
  ];
  const serverIdleShutdownCommandTable: ChatCommandTable = [
    ChatCommand("cancel", [], HandleServerShutDownCancelCommand, RBAC_PERM_COMMAND_SERVER_IDLESHUTDOWN_CANCEL, Console.Yes),
    ChatCommand("", shutdownArgs, HandleServerIdleShutDownCommand, RBAC_PERM_COMMAND_SERVER_IDLESHUTDOWN, Console.Yes),
  ];
  const serverRestartCommandTable: ChatCommandTable = [
    ChatCommand("cancel", [], HandleServerShutDownCancelCommand, RBAC_PERM_COMMAND_SERVER_RESTART_CANCEL, Console.Yes),
    ChatCommand("", shutdownArgs, HandleServerRestartCommand, RBAC_PERM_COMMAND_SERVER_RESTART, Console.Yes),
  ];
  const serverShutdownCommandTable: ChatCommandTable = [
    ChatCommand("cancel", [], HandleServerShutDownCancelCommand, RBAC_PERM_COMMAND_SERVER_SHUTDOWN_CANCEL, Console.Yes),
    ChatCommand("", shutdownArgs, HandleServerShutDownCommand, RBAC_PERM_COMMAND_SERVER_SHUTDOWN, Console.Yes),
  ];
  const serverSetCommandTable: ChatCommandTable = [
    ChatCommand("loglevel", [boolArg, stringArg, int32Arg], HandleServerSetLogLevelCommand, RBAC_PERM_COMMAND_SERVER_SET_LOGLEVEL, Console.Yes),
    ChatCommand("motd", [Optional(int32Arg), stringArg, Tail], HandleServerSetMotdCommand, RBAC_PERM_COMMAND_SERVER_SET_MOTD, Console.Yes),
    ChatCommand("closed", [Optional(stringArg)], HandleServerSetClosedCommand, RBAC_PERM_COMMAND_SERVER_SET_CLOSED, Console.Yes),
    ChatCommand("security", [uint8Arg], HandleServerSetSecurityCommand, RBAC_PERM_COMMAND_SERVER_SET_SECURITY, Console.Yes),
  ];
  const serverCommandTable: ChatCommandTable = [
    ChatCommand("corpses", [], HandleServerCorpsesCommand, RBAC_PERM_COMMAND_SERVER_CORPSES, Console.Yes),
    ChatCommand("debug", [], HandleServerDebugCommand, RBAC_PERM_COMMAND_SERVER_DEBUG, Console.Yes),
    ChatCommand("exit", [], HandleServerExitCommand, RBAC_PERM_COMMAND_SERVER_EXIT, Console.Yes),
    SubCommands("idlerestart", serverIdleRestartCommandTable),
    SubCommands("idleshutdown", serverIdleShutdownCommandTable),
    ChatCommand("info", [], HandleServerInfoCommand, RBAC_PERM_COMMAND_SERVER_INFO, Console.Yes),
    ChatCommand("motd", [], HandleServerMotdCommand, RBAC_PERM_COMMAND_SERVER_MOTD, Console.Yes),
    SubCommands("restart", serverRestartCommandTable),
    SubCommands("shutdown", serverShutdownCommandTable),
    SubCommands("set", serverSetCommandTable),
  ];
  return [SubCommands("server", serverCommandTable)];
}

/** Hooks the server sets at startup for the parts of the process outside the world (corpse cleanup). */
export const serverCommandHooks: { removeOldCorpses: () => Promise<void> } = { removeOldCorpses: async () => {} };

/** @ac scripts/Commands/cs_server.cpp server_commandscript::HandleServerCorpsesCommand */
async function HandleServerCorpsesCommand(_handler: ChatHandler): Promise<boolean> {
  await serverCommandHooks.removeOldCorpses();
  return true;
}

function directorySize(path: string): number {
  let size = 0;
  for (const file of readdirSync(path)) {
    const stat = statSync(join(path, file));
    if (stat.isFile()) size += stat.size;
  }
  return size;
}

async function latestUpdate(db: import("../../database/database.ts").Db): Promise<string> {
  const [row] = await queryFields(db, "SELECT name FROM updates ORDER BY name DESC LIMIT 1");
  return row ? String(row[0]) : "No updates found!";
}

/** @ac scripts/Commands/cs_server.cpp server_commandscript::HandleServerDebugCommand */
async function HandleServerDebugCommand(handler: ChatHandler): Promise<boolean> {
  const worldPort = sWorld().getIntConfig(ServerConfig.CONFIG_PORT_WORLD) & 0xffff;
  const [portRow] = await queryFields(LoginDatabase(), "SELECT port FROM realmlist WHERE id = ?", realm.Id.Realm);
  const dbPort = portRow ? Number(portRow[0]) : 0;
  const dbPortOutput = dbPort
    ? `Realmlist (Realm Id: ${realm.Id.Realm}) configured in port ${dbPort}`
    : `Realm Id: ${realm.Id.Realm} not found in \`realmlist\` table. Please check your setup`;
  HandleServerInfoCommand(handler);
  handler.pSendSysMessage("Using Bun version: {}", Bun.version);
  handler.pSendSysMessage("Compiled on: {}", `${process.platform} ${process.arch}`);
  handler.pSendSysMessage("Worldserver listening connections on port {}", worldPort);
  handler.pSendSysMessage("{}", dbPortOutput);
  const vmapIndoorCheck = sWorld().getBoolConfig(ServerConfig.CONFIG_VMAP_INDOOR_CHECK);
  const vmapLOSCheck = VMapFactory.createOrGetVMapMgr().isLineOfSightCalcEnabled();
  const vmapHeightCheck = VMapFactory.createOrGetVMapMgr().isHeightCalcEnabled();
  const mmapEnabled = sWorld().getBoolConfig(ServerConfig.CONFIG_ENABLE_MMAPS);
  const dataDir = sWorld().getDataPath();
  const subDirs = ["maps"];
  if (vmapIndoorCheck || vmapLOSCheck || vmapHeightCheck) {
    handler.pSendSysMessage("VMAPs status: Enabled. LineOfSight: {}, getHeight: {}, indoorCheck: {}", vmapLOSCheck, vmapHeightCheck, vmapIndoorCheck);
    subDirs.push("vmaps");
  } else {
    handler.sendSysMessage("VMAPs status: Disabled");
  }
  if (mmapEnabled) {
    handler.sendSysMessage("MMAPs status: Enabled");
    subDirs.push("mmaps");
  } else {
    handler.sendSysMessage("MMAPs status: Disabled");
  }
  for (const subDir of subDirs) {
    const mapPath = join(dataDir, subDir);
    if (!existsSync(mapPath)) {
      handler.pSendSysMessage("{} directory doesn't exist!. Using path: {}", subDir, mapPath);
      continue;
    }
    handler.pSendSysMessage("{} directory located in {}. Total size: {} bytes", subDir, mapPath, directorySize(mapPath));
  }
  const defaultLocale = LOCALE_enUS;
  handler.pSendSysMessage("Default DBC locale: {}.\nAll available DBC locales: {}", localeNames[defaultLocale]!, localeNames[defaultLocale]!);
  handler.pSendSysMessage("Latest LoginDatabase update: {}", await latestUpdate(LoginDatabase()));
  handler.pSendSysMessage("Latest CharacterDatabase update: {}", await latestUpdate(CharacterDatabase()));
  handler.pSendSysMessage("Latest WorldDatabase update: {}", await latestUpdate(WorldDatabase()));
  handler.pSendSysMessage("No modules are enabled");
  return true;
}

/** @ac scripts/Commands/cs_server.cpp server_commandscript::HandleServerInfoCommand */
function HandleServerInfoCommand(handler: ChatHandler): boolean {
  const world = sWorld();
  const playerCount = sWorldSessionMgr.GetPlayerCount();
  const activeSessionCount = sWorldSessionMgr.GetActiveSessionCount();
  const queuedSessionCount = world.getQueuedSessionCount();
  const connPeak = Math.max(world.getMaxActiveSessionCount(), activeSessionCount);
  handler.pSendSysMessage("{}", GitRevision.GetFullVersion());
  if (!queuedSessionCount) handler.pSendSysMessage("Connected players: {}. Characters in world: {}.", activeSessionCount, playerCount);
  else handler.pSendSysMessage("Connected players: {}. Characters in world: {}. Queue: {}.", activeSessionCount, playerCount, queuedSessionCount);
  handler.pSendSysMessage("Connection peak: {}.", connPeak);
  handler.pSendSysMessage(LANG_COMMAND_SERVER_INFO_SECURITY, world.getPlayerSecurityLimit());
  handler.pSendSysMessage(LANG_UPTIME, secsToTimeString(getUptime()));
  handler.pSendSysMessage("Update time diff: {}ms. Last {} diffs summary:", worldUpdateTime.getLastUpdateTime(), worldUpdateTime.getDatasetSize());
  handler.pSendSysMessage("|- Mean: {}ms", worldUpdateTime.getAverageUpdateTime());
  handler.pSendSysMessage("|- Median: {}ms", worldUpdateTime.getPercentile(50));
  handler.pSendSysMessage(
    "|- Percentiles (95, 99, max): {}ms, {}ms, {}ms",
    worldUpdateTime.getPercentile(95),
    worldUpdateTime.getPercentile(99),
    worldUpdateTime.getPercentile(100),
  );
  if (world.isShuttingDown()) handler.pSendSysMessage(LANG_SHUTDOWN_TIMELEFT, `${secsToTimeString(world.getShutDownTimeLeft())}.`);
  return true;
}

/** @ac scripts/Commands/cs_server.cpp server_commandscript::HandleServerMotdCommand */
function HandleServerMotdCommand(handler: ChatHandler): boolean {
  handler.pSendSysMessage(LANG_MOTD_CURRENT);
  for (let i = 0; i < TOTAL_LOCALES; ++i) handler.pSendSysMessage(LANG_GENERIC_TWO_CURLIES_WITH_COLON, GetNameByLocaleConstant(i), sMotdMgr.GetMotd(i));
  return true;
}

/** @ac scripts/Commands/cs_server.cpp server_commandscript::HandleServerShutDownCancelCommand */
function HandleServerShutDownCancelCommand(_handler: ChatHandler): boolean {
  sWorld().shutdownCancel();
  return true;
}

/** The shared body of the four shutdown and restart commands. */
function shutdownWith(handler: ChatHandler, time: string, exitCode: number | null, reason: string, options: number, defaultExitCode: number): boolean {
  if (time.length === 0) return false;
  if ((/^-?\d+$/.test(time) ? Number(time) : 0) < 0) {
    handler.sendErrorMessage(LANG_BAD_VALUE);
    return false;
  }
  let delay = timeStringToSecs(time);
  if (delay <= 0) delay = /^-?\d+$/.test(time) ? Number(time) | 0 : 0;
  if (delay <= 0) {
    handler.sendErrorMessage(LANG_BAD_VALUE);
    return false;
  }
  if (exitCode !== null && exitCode >= 0 && exitCode <= 125) sWorld().shutdownServ(delay, options, exitCode);
  else sWorld().shutdownServ(delay, options, defaultExitCode, reason);
  return true;
}

/** @ac scripts/Commands/cs_server.cpp server_commandscript::HandleServerShutDownCommand */
function HandleServerShutDownCommand(handler: ChatHandler, time: string, exitCode: number | null, reason: string): boolean {
  return shutdownWith(handler, time, exitCode, reason, 0, ShutdownExitCode.Shutdown);
}

/** @ac scripts/Commands/cs_server.cpp server_commandscript::HandleServerRestartCommand */
function HandleServerRestartCommand(handler: ChatHandler, time: string, exitCode: number | null, reason: string): boolean {
  return shutdownWith(handler, time, exitCode, reason, ShutdownMask.Restart, ShutdownExitCode.Restart);
}

/** @ac scripts/Commands/cs_server.cpp server_commandscript::HandleServerIdleRestartCommand */
function HandleServerIdleRestartCommand(handler: ChatHandler, time: string, exitCode: number | null, reason: string): boolean {
  return shutdownWith(handler, time, exitCode, reason, ShutdownMask.Restart | ShutdownMask.Idle, ShutdownExitCode.Restart);
}

/** @ac scripts/Commands/cs_server.cpp server_commandscript::HandleServerIdleShutDownCommand */
function HandleServerIdleShutDownCommand(handler: ChatHandler, time: string, exitCode: number | null, reason: string): boolean {
  return shutdownWith(handler, time, exitCode, reason, ShutdownMask.Idle, ShutdownExitCode.Shutdown);
}

/** @ac scripts/Commands/cs_server.cpp server_commandscript::HandleServerExitCommand */
function HandleServerExitCommand(handler: ChatHandler): boolean {
  handler.sendSysMessage(LANG_COMMAND_EXIT);
  sWorld().stopNow(ShutdownExitCode.Shutdown);
  return true;
}

/** @ac scripts/Commands/cs_server.cpp server_commandscript::HandleServerSetMotdCommand */
async function HandleServerSetMotdCommand(handler: ChatHandler, realmIdArg: number | null, locale: string, motd: string): Promise<boolean> {
  const realmId = realmIdArg ?? realm.Id.Realm;
  if (!IsLocaleValid(locale)) {
    handler.sendErrorMessage("locale ({}) is not valid. Valid locales: enUS, koKR, frFR, deDE, zhCN, zhWE, esES, esMX, ruRU.", locale);
    return false;
  }
  const localeConstant = GetLocaleByName(locale);
  if (motd.length === 0) return false;
  await LoginDatabase().$client.begin(async (tx) => {
    if (localeConstant === LOCALE_enUS) await tx.unsafe(LOGIN_REP_MOTD, [realmId, motd]);
    else await tx.unsafe(LOGIN_REP_MOTD_LOCALE, [realmId, locale, motd]);
  });
  sMotdMgr.SetMotd(motd, localeConstant);
  handler.pSendSysMessage(LANG_MOTD_NEW, realmId, locale, motd);
  return true;
}

/** @ac scripts/Commands/cs_server.cpp server_commandscript::HandleServerSetClosedCommand */
function HandleServerSetClosedCommand(handler: ChatHandler, args: string | null): boolean {
  const value = args ?? "";
  if (stringStartsWith("on", value)) {
    handler.sendSysMessage(LANG_WORLD_CLOSED);
    sWorld().setClosed(true);
    return true;
  }
  if (stringStartsWith("off", value)) {
    handler.sendSysMessage(LANG_WORLD_OPENED);
    sWorld().setClosed(false);
    return true;
  }
  handler.sendErrorMessage(LANG_USE_BOL);
  return false;
}

/** @ac scripts/Commands/cs_server.cpp server_commandscript::HandleServerSetSecurityCommand */
async function HandleServerSetSecurityCommand(handler: ChatHandler, level: number): Promise<boolean> {
  if (level > SEC_ADMINISTRATOR) {
    handler.sendErrorMessage(LANG_COMMAND_SERVER_SET_SECURITY_ERROR, SEC_PLAYER, SEC_ADMINISTRATOR);
    return false;
  }
  await executeStatement(LoginDatabase(), LOGIN_UPD_REALMLIST_SECURITY_LEVEL, level, realm.Id.Realm);
  // Apply live; raising the limit kicks any now-disallowed sessions.
  sWorld().setPlayerSecurityLimit(level, (sec) => sWorldSessionMgr.KickAllLess(sec));
  handler.pSendSysMessage(LANG_COMMAND_SERVER_SET_SECURITY, level);
  return true;
}

/** AzerothCore log levels (`LogLevel`): 0 disabled … 6 trace. */
const LOG_LEVELS: readonly LogLevel[] = ["error", "error", "error", "warn", "info", "debug", "trace"];

/** @ac scripts/Commands/cs_server.cpp server_commandscript::HandleServerSetLogLevelCommand */
function HandleServerSetLogLevelCommand(_handler: ChatHandler, isLogger: boolean, name: string, level: number): boolean {
  const logLevel = LOG_LEVELS[Math.max(0, Math.min(6, level))]!;
  if (isLogger && name.length > 0 && name !== "root") configureLogging({ level: logLevel, scopes: new Set([name]) });
  else configureLogging({ level: logLevel });
  return true;
}

/** @ac scripts/Commands/cs_server.cpp AddSC_server_commandscript */
export function AddSC_server_commandscript(): void {
  registerCommandScript(GetCommands);
}
