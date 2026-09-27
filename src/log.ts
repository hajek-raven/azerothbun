import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { FileSink } from "bun";

/**
 * Server log. Every line goes to the console and, unless `LOG_FILE` is empty, to a file.
 *
 * Environment (Bun loads `.env`):
 * - `LOG_LEVEL`   trace | debug | info | warn | error (default info)
 * - `LOG_SCOPES`  comma list of scopes to show below info, e.g. `spell,combat` (default: all)
 * - `LOG_FILE`    path of the log file (default `logs/server.log`, empty to disable). The previous run is
 *                 kept as `logs/server.prev.log`.
 * - `LOG_PACKETS` `1` traces every packet in both directions; or a comma list of opcode names
 *                 (`CMSG_CAST_SPELL,SMSG_SPELL_GO`); `hex` adds a hex dump of the body
 */
export type LogScope = "auth" | "world" | "hot" | "server" | "packet" | "spell" | "combat" | "loot" | "quest" | "movement" | "sql" | "sql.updates";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

type LogSettings = {
  level: LogLevel;
  scopes: Set<string> | null;
  file: string;
  packets: { all: boolean; names: Set<string>; hex: boolean };
};

const settings: LogSettings = readEnv();
let sink: FileSink | null = null;
let sinkFailed = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function readEnv(): LogSettings {
  const env = typeof process !== "undefined" ? process.env : {};
  const level = (env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  const scopes = env.LOG_SCOPES ? new Set(env.LOG_SCOPES.split(",").map((scope) => scope.trim()).filter(Boolean)) : null;
  const packetParts = (env.LOG_PACKETS ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const inTest = env.NODE_ENV === "test" || env.BUN_ENV === "test" || (typeof Bun !== "undefined" && Bun.main?.includes(".test."));
  return {
    level: level in LEVELS ? level : "info",
    scopes,
    file: env.LOG_FILE ?? (inTest ? "" : "logs/server.log"),
    packets: {
      all: packetParts.some((part) => part === "1" || part.toLowerCase() === "all" || part.toLowerCase() === "true"),
      names: new Set(packetParts.filter((part) => /^(C|S|U)?MSG_/.test(part))),
      hex: packetParts.some((part) => part.toLowerCase() === "hex"),
    },
  };
}

/** Override the environment settings (tests, console commands). */
export function configureLogging(update: Partial<Omit<LogSettings, "packets">> & { packets?: Partial<LogSettings["packets"]> }): void {
  if (update.level) settings.level = update.level;
  if (update.scopes !== undefined) settings.scopes = update.scopes;
  if (update.file !== undefined && update.file !== settings.file) {
    closeLogFile();
    settings.file = update.file;
    sinkFailed = false;
  }
  if (update.packets) Object.assign(settings.packets, update.packets);
}

export function logSettings(): Readonly<LogSettings> {
  return settings;
}

/** Whether a line at `level` for `scope` would be written. Use it to skip building expensive messages. */
export function logEnabled(level: LogLevel, scope?: LogScope): boolean {
  if (LEVELS[level] < LEVELS[settings.level]) {
    return false;
  }
  if (LEVELS[level] < LEVELS.info && scope && settings.scopes && !settings.scopes.has(scope)) {
    return false;
  }
  return true;
}

export function log(scope: LogScope, message: string): void {
  write("info", scope, message);
}

export function logTrace(scope: LogScope, message: string | (() => string)): void {
  if (logEnabled("trace", scope)) write("trace", scope, typeof message === "function" ? message() : message);
}

export function logDebug(scope: LogScope, message: string | (() => string)): void {
  if (logEnabled("debug", scope)) write("debug", scope, typeof message === "function" ? message() : message);
}

export function logWarn(scope: LogScope, message: string): void {
  write("warn", scope, message);
}

export function logError(scope: LogScope, message: string, error?: unknown): void {
  const detail = error instanceof Error ? `: ${error.message}\n${error.stack ?? ""}` : error !== undefined ? `: ${String(error)}` : "";
  write("error", scope, message + detail);
}

export function logBanner(scope: LogScope, message: string): void {
  const line = formatLog("info", scope, message);
  const bar = "=".repeat(line.length);
  emit(`\n${bar}\n${line}\n${bar}\n`, "info");
}

/** Whether packets with this opcode name are traced (`LOG_PACKETS`). */
export function packetTraced(name: string): boolean {
  return settings.packets.all || settings.packets.names.has(name);
}

/** One traced packet: direction, name, opcode, size, and optionally a hex dump. */
export function logPacket(direction: "C->S" | "S->C", name: string, opcode: number, body: Uint8Array, who = ""): void {
  if (!packetTraced(name)) {
    return;
  }
  const prefix = who ? `${who} ` : "";
  const dump = settings.packets.hex && body.length > 0 ? `\n${hexDump(body)}` : "";
  write("info", "packet", `${prefix}${direction} ${name} (${hexOpcode(opcode)}) ${body.length}b${dump}`);
}

export function hexOpcode(opcode: number): string {
  return `0x${opcode.toString(16).padStart(3, "0")}`;
}

/** 16 bytes per row with offsets and printable ASCII. */
export function hexDump(bytes: Uint8Array, limit = 512): string {
  const rows: string[] = [];
  const shown = Math.min(bytes.length, limit);
  for (let offset = 0; offset < shown; offset += 16) {
    const slice = bytes.subarray(offset, Math.min(offset + 16, shown));
    const hex = Array.from(slice, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const text = Array.from(slice, (byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".")).join("");
    rows.push(`    ${offset.toString(16).padStart(4, "0")}  ${hex.padEnd(47)}  ${text}`);
  }
  if (shown < bytes.length) {
    rows.push(`    ... ${bytes.length - shown} more bytes`);
  }
  return rows.join("\n");
}

export function closeLogFile(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (sink) {
    try {
      sink.end();
    } catch {
      // closing a broken sink
    }
    sink = null;
  }
}

function write(level: LogLevel, scope: LogScope, message: string): void {
  if (!logEnabled(level, scope)) {
    return;
  }
  emit(formatLog(level, scope, message), level);
}

function emit(line: string, level: LogLevel): void {
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
  const file = fileSink();
  if (file) {
    file.write(`${line}\n`);
  }
}

function fileSink(): FileSink | null {
  if (sink || sinkFailed || !settings.file) {
    return sink;
  }
  try {
    mkdirSync(dirname(settings.file), { recursive: true });
    if (existsSync(settings.file)) {
      // one file per server run; the previous run stays next to it
      renameSync(settings.file, settings.file.replace(/(\.log)?$/, ".prev.log"));
    }
    sink = Bun.file(settings.file).writer();
    sink.write(`\n----- log opened ${new Date().toISOString()} (level ${settings.level}) -----\n`);
    flushTimer = setInterval(() => sink?.flush(), 500);
    flushTimer.unref?.();
  } catch (error) {
    sinkFailed = true;
    console.error(`log file ${settings.file} could not be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
  return sink;
}

const LEVEL_TAGS: Record<LogLevel, string> = { trace: "TRACE", debug: "DEBUG", info: "INFO ", warn: "WARN ", error: "ERROR" };

function formatLog(level: LogLevel, scope: LogScope, message: string): string {
  return `${new Date().toISOString()} ${LEVEL_TAGS[level]} ${scope.padEnd(6)} ${message}`;
}
