import { expect, test } from "bun:test";
import { findAccount } from "../../db.ts";
import { handleConsoleCommand } from "../Server/console.ts";
import { sWorld } from "../world/world.ts";
import { chatTestEnv, loginClient } from "./test-chat.ts";

test("a GM runs chat commands; a player's dot line is plain chat", async () => {
  const env = await chatTestEnv();
  const gm = await loginClient(env, "TEST", 1, 3);
  const player = await loginClient(env, "TEST2", 2, 0);
  gm.takeMessages();
  player.takeMessages();

  await gm.say(".gm on");
  expect(gm.takeMessages()).toContain("GM mode is ON");
  expect(gm.session.getPlayer()?.isGameMaster()).toBe(true);

  await gm.say(".gm");
  const help = gm.takeMessages();
  expect(help.some((line) => line.includes("Possible subcommands"))).toBe(true);
  expect(help.some((line) => line.includes("gm on"))).toBe(true);

  await gm.say(".nosuchcommand");
  expect(gm.takeMessages()).toContain("Command 'nosuchcommand' does not exist");

  // A player sees only the commands of its level: `.gm ingame` is level 0, so `.gm on` shows the `.gm` help.
  await player.say(".gm on");
  expect(player.session.getPlayer()?.isGameMaster()).toBe(false);
  const playerHelp = player.takeMessages();
  expect(playerHelp).toContain("|- gm ingame");
  expect(playerHelp.some((line) => line.includes("gm on"))).toBe(false);
  // `AllowPlayerCommands = 1` (the default) tells players about unknown commands too.
  await player.say(".nosuchcommand");
  expect(player.takeMessages()).toContain("Command 'nosuchcommand' does not exist");
  // A line that is not a command is said.
  await player.say("hello");
  expect(player.takeMessages()).toContain("hello");

  await gm.say(".gm off");
  expect(gm.takeMessages()).toContain("GM mode is OFF");
});

test("the console runs the same command tree", async () => {
  const env = await chatTestEnv();
  const lines: string[] = [];
  expect((await handleConsoleCommand("account create ConsoleUser secret", (line) => lines.push(line)))?.ok).toBe(true);
  expect((await findAccount(env.db.login, "CONSOLEUSER"))?.username).toBe("CONSOLEUSER");
  expect((await handleConsoleCommand(".server shutdown 1m", () => {}))?.ok).toBe(true);
  expect(sWorld().getShutdownTimer()).toBe(60);
  expect((await handleConsoleCommand("server shutdown cancel", () => {}))?.ok).toBe(true);
  expect(sWorld().getShutdownTimer()).toBe(0);
  const missing: string[] = [];
  expect((await handleConsoleCommand("account create", (line) => missing.push(line)))?.ok).toBe(false);
  expect(missing.join("\n")).toContain("account create");
  expect((await handleConsoleCommand("nope", () => {}))?.ok).toBe(false);
});
