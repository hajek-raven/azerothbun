import type { Database } from "bun:sqlite";
import { stringToInt32 } from "../../common/config.ts";
import { AccountOpResult, createAccount } from "../accounts/account-mgr.ts";
import { timeStringToSecs } from "../time/timer.ts";
import { ShutdownExitCode, type World } from "../world/world.ts";

export type ConsoleContext = {
  db: Database;
  world: World;
  expansion: number;
};

export type ConsoleResult = {
  ok: boolean;
  message: string;
};

export function handleConsoleCommand(line: string, context: ConsoleContext): ConsoleResult | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const command = trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
  const tokens = command.split(/\s+/);
  const head = `${tokens[0] ?? ""} ${tokens[1] ?? ""}`.toLowerCase();
  if (head === "server shutdown" && (tokens[2] ?? "").toLowerCase() === "cancel" && tokens.length === 3) {
    context.world.shutdownCancel();
    return { ok: true, message: "Shutdown cancelled." };
  }
  if (head === "server shutdown") {
    return shutdownCommand(tokens.slice(2), context.world);
  }
  if (head === "account create") {
    return accountCreateCommand(tokens.slice(2), context);
  }
  return { ok: false, message: `Unknown command '${command}'.` };
}

function shutdownCommand(args: string[], world: World): ConsoleResult {
  const time = args[0] ?? "";
  if (time.length === 0) {
    return { ok: false, message: "server shutdown <time> [exitcode] [reason]" };
  }
  if ((stringToInt32(time) ?? 0) < 0) {
    return { ok: false, message: "Bad value." };
  }
  let delay = timeStringToSecs(time);
  if (delay <= 0) {
    delay = stringToInt32(time) ?? 0;
  }
  if (delay <= 0) {
    return { ok: false, message: "Bad value." };
  }
  const exitToken = args[1];
  const exitCode = exitToken !== undefined ? stringToInt32(exitToken) : null;
  if (exitCode !== null && exitCode >= 0 && exitCode <= 125) {
    world.shutdownServ(delay, 0, exitCode);
    return { ok: true, message: `Shutdown in ${delay} sec, exit ${exitCode}.` };
  }
  const reasonStart = exitCode === null ? 1 : 2;
  const reason = args.slice(reasonStart).join(" ");
  world.shutdownServ(delay, 0, ShutdownExitCode.Shutdown, reason);
  return { ok: true, message: reason.length > 0 ? `Shutdown in ${delay} sec. ${reason}` : `Shutdown in ${delay} sec.` };
}

function accountCreateCommand(args: string[], context: ConsoleContext): ConsoleResult {
  const accountName = args[0];
  const password = args[1];
  const email = args[2] ?? "";
  if (!accountName || !password) {
    return { ok: false, message: "account create <name> <password> [email]" };
  }
  const result = createAccount(context.db, accountName, password, email, context.expansion);
  switch (result) {
    case AccountOpResult.Ok:
      return { ok: true, message: `Account created: ${accountName}` };
    case AccountOpResult.NameTooLong:
      return { ok: false, message: "Account name too long." };
    case AccountOpResult.PassTooLong:
      return { ok: false, message: "Password too long." };
    case AccountOpResult.EmailTooLong:
      return { ok: false, message: "Email too long." };
    case AccountOpResult.NameAlreadyExists:
      return { ok: false, message: "Account already exists." };
    case AccountOpResult.NameNotExist:
      return { ok: false, message: "Account does not exist." };
    case AccountOpResult.DbInternalError:
      return { ok: false, message: `Account not created (SQL error): ${accountName}` };
    default: {
      const unreachable: never = result;
      return { ok: false, message: `Account not created: ${String(unreachable)}` };
    }
  }
}

type ConsoleReader = { onLine: ((line: string) => void) | null };

/**
 * `CliThread` as a line reader on Bun's `console` iterator.
 * stdin has one reader per process, kept on `globalThis` so `bun --hot` swaps the handler instead of adding a reader.
 */
export function startConsole(onLine: (line: string) => void): { stop: () => void } {
  const reader = ((globalThis as { wowConsole?: ConsoleReader }).wowConsole ??= readConsole());
  reader.onLine = onLine;
  return {
    stop() {
      if (reader.onLine === onLine) {
        reader.onLine = null;
      }
    },
  };
}

function readConsole(): ConsoleReader {
  const reader: ConsoleReader = { onLine: null };
  void (async () => {
    for await (const line of console) {
      reader.onLine?.(line);
    }
  })();
  return reader;
}
