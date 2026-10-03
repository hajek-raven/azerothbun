/**
 * The worldserver console (`CliRunnable.cpp`): each line goes through `CliHandler::ParseCommands`, the same command
 * tree the in-game `.commands` use, with console permissions.
 */
import { log } from "../../log.ts";
import { CliHandler } from "../Chat/Chat.ts";

/**
 * @ac apps/worldserver/CommandLine/CliRunnable.cpp CliThread (`World::QueueCliCommand` → `CliHandler::ParseCommands`)
 * Returns the printed lines, or null for an empty line.
 */
export async function handleConsoleCommand(line: string, print: (text: string) => void = (text) => log("server", text)): Promise<{ ok: boolean; lines: string[] } | null> {
  const command = line.trim();
  if (command.length === 0) {
    return null;
  }
  const lines: string[] = [];
  const handler = new CliHandler((text) => {
    lines.push(text);
    print(text);
  });
  const ok = await handler.parseCommands(command);
  return { ok: ok && !handler.hasSentErrorMessage(), lines };
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
