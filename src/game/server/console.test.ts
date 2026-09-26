import { expect, test } from "bun:test";
import { ConfigMgr, ConfigSeverity, defaultConfigPolicy } from "../../common/config.ts";
import { findAccount, openAuthDatabase } from "../../db.ts";
import { WorldConfig } from "../world/world-config.ts";
import { World } from "../world/world.ts";
import { handleConsoleCommand } from "./console.ts";

test("console shutdown and account create", () => {
  const db = openAuthDatabase(":memory:");
  const world = new World(emptyWorldConfig());
  const context = { db, world, expansion: 2 };
  expect(handleConsoleCommand("server shutdown 1m", context)?.message).toContain("60");
  expect(world.getShutdownTimer()).toBe(60);
  expect(world.isStopped()).toBe(false);
  expect(handleConsoleCommand("server shutdown cancel", context)?.ok).toBe(true);
  expect(world.getShutdownTimer()).toBe(0);
  expect(handleConsoleCommand(".account create ConsoleUser secret", context)?.ok).toBe(true);
  expect(findAccount(db, "CONSOLEUSER")?.username).toBe("CONSOLEUSER");
  expect(handleConsoleCommand("account create", context)?.ok).toBe(false);
  expect(handleConsoleCommand("nope", context)?.ok).toBe(false);
  db.close();
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
