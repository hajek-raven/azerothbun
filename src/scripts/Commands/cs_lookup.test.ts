import { expect, test } from "bun:test";
import { chatTestEnv } from "../../game/Chat/test-chat.ts";
import { handleConsoleCommand } from "../../game/Server/console.ts";

async function lines(command: string): Promise<string[]> {
  const out: string[] = [];
  await handleConsoleCommand(command, (line) => out.push(line));
  return out;
}

test(".lookup finds areas, creatures, items, spells, maps, and players", async () => {
  await chatTestEnv();
  expect((await lines("lookup area Northshire Valley")).some((line) => line.startsWith("9 - Northshire Valley"))).toBe(true);
  expect((await lines("lookup creature Marshal McBride")).join("\n")).toContain("197");
  expect((await lines("lookup item Worn Shortsword")).join("\n")).toContain("25");
  expect((await lines("lookup spell Hearthstone")).some((line) => line.startsWith("8690 - Hearthstone"))).toBe(true);
  expect((await lines("lookup map Kalimdor")).some((line) => line.startsWith("1 - [Kalimdor]"))).toBe(true);
  expect((await lines("lookup player account TEST2")).join("\n")).toContain("Testtwo");
  expect((await lines("lookup teleport goldshire")).join("\n")).toContain("Goldshire");
});
