import { expect, test } from "bun:test";
import { ConfigMgr, ConfigSeverity, defaultConfigPolicy } from "../../common/config.ts";
import { testDatabase } from "../../database/test-db.ts";
import { findAccount } from "../../db.ts";
import { WorldConfig } from "../world/world-config.ts";
import { World } from "../world/world.ts";
import { handleConsoleCommand } from "./console.ts";

test("console shutdown and account create", async () => {
  const db = await testDatabase("auth");
  const world = new World(emptyWorldConfig());
  const context = { db, world, expansion: 2 };
  expect((await handleConsoleCommand("server shutdown 1m", context))?.message).toContain("60");
  expect(world.getShutdownTimer()).toBe(60);
  expect(world.isStopped()).toBe(false);
  expect((await handleConsoleCommand("server shutdown cancel", context))?.ok).toBe(true);
  expect(world.getShutdownTimer()).toBe(0);
  expect((await handleConsoleCommand(".account create ConsoleUser secret", context))?.ok).toBe(true);
  expect((await findAccount(db, "CONSOLEUSER"))?.username).toBe("CONSOLEUSER");
  expect((await handleConsoleCommand("account create", context))?.ok).toBe(false);
  expect((await handleConsoleCommand("nope", context))?.ok).toBe(false);
});

function emptyWorldConfig(): WorldConfig {
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
