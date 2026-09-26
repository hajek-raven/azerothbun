import { expect, test } from "bun:test";
import { ConfigMgr, ConfigSeverity, defaultConfigPolicy } from "../../common/config.ts";
import { ServerConfig, WorldConfig } from "./world-config.ts";

test("every WorldConfig key loads from worldserver.conf.dist", async () => {
  const { settings } = await loadWorldConfig("configs/worldserver.conf.dist");
  expect(settings.getFloat(ServerConfig.RATE_HEALTH)).toBe(1);
  expect(settings.getUInt(ServerConfig.CONFIG_PORT_WORLD)).toBe(8085);
  expect(settings.getUInt(ServerConfig.CONFIG_MAX_PLAYER_LEVEL)).toBe(80);
  expect(settings.getBool(ServerConfig.CONFIG_ALLOW_PLAYER_COMMANDS)).toBe(true);
  expect(settings.getBool(ServerConfig.CONFIG_DECLINED_NAMES_USED)).toBe(false);
  expect(settings.getString(ServerConfig.CONFIG_NEW_CHAR_STRING)).toBe("");
});

test("a rate of 0 falls back to the default", async () => {
  const { settings } = await loadWorldConfigText("Rate.Health = 0\n");
  expect(settings.getFloat(ServerConfig.RATE_HEALTH)).toBe(1);
});

test("declined names default to on only for a Russian realm", async () => {
  const russian = await loadWorldConfigText("RealmZone = 12\n");
  expect(russian.settings.getBool(ServerConfig.CONFIG_DECLINED_NAMES_USED)).toBe(true);
  const development = await loadWorldConfigText("RealmZone = 1\n");
  expect(development.settings.getBool(ServerConfig.CONFIG_DECLINED_NAMES_USED)).toBe(false);
});

test("characters per account must cover characters per realm", async () => {
  const { settings } = await loadWorldConfigText("CharactersPerRealm = 10\nCharactersPerAccount = 1\n");
  expect(settings.getUInt(ServerConfig.CONFIG_CHARACTERS_PER_REALM)).toBe(10);
  expect(settings.getUInt(ServerConfig.CONFIG_CHARACTERS_PER_ACCOUNT)).toBe(50);
});

test("world server port is not changed by reload", async () => {
  const path = `/tmp/wow-world-config-${crypto.randomUUID()}.conf`;
  await Bun.write(path, "WorldServerPort = 8085\nRate.Health = 2\n");
  const config = new ConfigMgr();
  const policy = quietPolicy();
  config.configure(path, [], "", policy);
  expect(await config.loadAppConfigs()).toBe(true);
  const settings = new WorldConfig(config);
  settings.load();
  expect(settings.getUInt(ServerConfig.CONFIG_PORT_WORLD)).toBe(8085);
  expect(settings.getFloat(ServerConfig.RATE_HEALTH)).toBe(2);
  await Bun.write(path, "WorldServerPort = 1\nRate.Health = 3\n");
  expect(await config.reload()).toBe(true);
  settings.load(true);
  expect(settings.getUInt(ServerConfig.CONFIG_PORT_WORLD)).toBe(8085);
  expect(settings.getFloat(ServerConfig.RATE_HEALTH)).toBe(3);
});

async function loadWorldConfig(path: string): Promise<{ settings: WorldConfig }> {
  const config = new ConfigMgr();
  config.configure(path, [], "", quietPolicy());
  expect(await config.loadAppConfigs()).toBe(true);
  const settings = new WorldConfig(config);
  settings.load();
  return { settings };
}

async function loadWorldConfigText(body: string): Promise<{ settings: WorldConfig }> {
  const path = `/tmp/wow-world-config-${crypto.randomUUID()}.conf`;
  await Bun.write(path, body);
  return loadWorldConfig(path);
}

function quietPolicy() {
  const policy = defaultConfigPolicy();
  policy.missingOptionSeverity = ConfigSeverity.Skip;
  policy.missingFileSeverity = ConfigSeverity.Skip;
  policy.criticalOptionSeverity = ConfigSeverity.Skip;
  policy.valueErrorSeverity = ConfigSeverity.Skip;
  return policy;
}
