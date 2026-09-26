import { expect, test } from "bun:test";
import { ConfigMgr, ConfigSeverity, defaultConfigPolicy, envVarNameFor, iniKeyToEnvVarKey, stringToBool } from "./config.ts";

test("ini keys become AC_ environment names", () => {
  expect(iniKeyToEnvVarKey("SomeConfig")).toBe("SOME_CONFIG");
  expect(iniKeyToEnvVarKey("myNestedConfig.opt1")).toBe("MY_NESTED_CONFIG_OPT_1");
  expect(iniKeyToEnvVarKey("LogDB.Opt.ClearTime")).toBe("LOG_DB_OPT_CLEAR_TIME");
  expect(iniKeyToEnvVarKey("SomeLong.NestedNameWithNumber.Like1")).toBe("SOME_LONG_NESTED_NAME_WITH_NUMBER_LIKE_1");
  expect(iniKeyToEnvVarKey("GM.InGMList.Level")).toBe("GM_IN_GMLIST_LEVEL");
  expect(envVarNameFor("Int.Nested")).toBe("AC_INT_NESTED");
});

test("bool values match AzerothCore StringTo", () => {
  expect(stringToBool("1")).toBe(true);
  expect(stringToBool("yes")).toBe(true);
  expect(stringToBool("TRUE")).toBe(true);
  expect(stringToBool("0")).toBe(false);
  expect(stringToBool("off")).toBe(false);
  expect(stringToBool("maybe")).toBeNull();
});

test("config file values are overridden by AC_ environment variables", async () => {
  const path = await writeConfig(`
Int.Nested = 4242
lower = simpleString
UPPER = simpleString
SomeLong.NestedNameWithNumber.Like1 = 1
GM.InGMList.Level = 50
Bool.Flag = true
`);
  const config = new ConfigMgr();
  config.configure(path);
  expect(await config.loadAppConfigs()).toBe(true);
  expect(config.getInt("Int.Nested", 10)).toBe(4242);
  expect(config.getString("lower", "")).toBe("simpleString");
  expect(config.getFloat("SomeLong.NestedNameWithNumber.Like1", 0)).toBe(1);
  expect(config.getInt("GM.InGMList.Level", 1)).toBe(50);
  expect(config.getBool("Bool.Flag", false)).toBe(true);

  const previous = process.env.AC_INT_NESTED;
  process.env.AC_INT_NESTED = "8080";
  try {
    expect(config.overrideWithEnvVariablesIfAny().includes("Int.Nested")).toBe(true);
    expect(config.getInt("Int.Nested", 10)).toBe(8080);
  } finally {
    restoreEnv("AC_INT_NESTED", previous);
  }
});

test("an environment variable supplies a key that is not in the file", async () => {
  const path = await writeConfig("Present = 1\n");
  const config = new ConfigMgr();
  config.configure(path);
  expect(await config.loadAppConfigs()).toBe(true);
  const previous = process.env.AC_UNIQUE_STRING;
  process.env.AC_UNIQUE_STRING = "somevalue";
  try {
    expect(config.getString("Unique.String", "")).toBe("somevalue");
  } finally {
    restoreEnv("AC_UNIQUE_STRING", previous);
  }
});

test("a missing key returns the default and a bad number does too", async () => {
  const path = await writeConfig("Count = no\n");
  const config = new ConfigMgr();
  const policy = defaultConfigPolicy();
  policy.missingOptionSeverity = ConfigSeverity.Skip;
  policy.valueErrorSeverity = ConfigSeverity.Skip;
  config.configure(path, [], "", policy);
  expect(await config.loadAppConfigs()).toBe(true);
  expect(config.getInt("NotFound.Int", 7)).toBe(7);
  expect(config.getInt("Count", 3)).toBe(3);
});

test("duplicate keys keep the first value and quotes are removed", async () => {
  const path = await writeConfig(`
# comment
[section]
Name = "Azeroth"
Name = other
`);
  const config = new ConfigMgr();
  config.configure(path);
  expect(await config.loadAppConfigs()).toBe(true);
  expect(config.getString("Name", "")).toBe("Azeroth");
});

test("a missing config file fails the load", async () => {
  const config = new ConfigMgr();
  const policy = defaultConfigPolicy();
  policy.missingFileSeverity = ConfigSeverity.Error;
  config.configure(`/tmp/wow-config-missing-${crypto.randomUUID()}.conf`, [], "", policy);
  expect(await config.loadAppConfigs()).toBe(false);
});

async function writeConfig(body: string): Promise<string> {
  const path = `/tmp/wow-config-${crypto.randomUUID()}.conf`;
  await Bun.write(path, body);
  return path;
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}
