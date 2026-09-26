
const header = await Bun.file("azerothcore/src/server/game/World/WorldConfig.h").text();
const source = await Bun.file("azerothcore/src/server/game/World/WorldConfig.cpp").text();

const enumBody = header.slice(header.indexOf("enum ServerConfigs"), header.indexOf("class WorldConfig"));
const names: string[] = [];
for (const raw of enumBody.split("\n")) {
  const line = raw.replace(/\/\/.*$/, "").trim().replace(/,$/, "");
  if (!line || line.startsWith("enum") || line === "{" || line === "}" || line === "};") {
    continue;
  }
  const name = line.split("=")[0]?.trim() ?? "";
  if (name.length > 0) {
    names.push(name);
  }
}

const checks: Record<string, string> = {
  RATE_HEALTH: `(value) => typeof value === "number" && value > 0`,
  RATE_POWER_MANA: `(value) => typeof value === "number" && value > 0`,
  RATE_POWER_RAGE_LOSS: `(value) => typeof value === "number" && value > 0`,
  RATE_POWER_RUNICPOWER_LOSS: `(value) => typeof value === "number" && value > 0`,
  RATE_REPAIRCOST: `(value) => typeof value === "number" && value >= 0`,
  RATE_TALENT: `(value) => typeof value === "number" && value >= 0`,
  RATE_TALENT_PET: `(value) => typeof value === "number" && value >= 0`,
  RATE_MOVESPEED_PLAYER: `(value) => typeof value === "number" && value >= 0`,
  RATE_MOVESPEED_NPC: `(value) => typeof value === "number" && value >= 0`,
  RATE_DURABILITY_LOSS_ON_DEATH: `(value) => typeof value === "number" && value >= 0 && value <= 100`,
  RATE_DURABILITY_LOSS_ON_SPIRIT_RESURRECT: `(value) => typeof value === "number" && value >= 0 && value <= 100`,
  RATE_DURABILITY_LOSS_DAMAGE: `(value) => typeof value === "number" && value >= 0`,
  RATE_DURABILITY_LOSS_ABSORB: `(value) => typeof value === "number" && value >= 0`,
  RATE_DURABILITY_LOSS_PARRY: `(value) => typeof value === "number" && value >= 0`,
  RATE_DURABILITY_LOSS_BLOCK: `(value) => typeof value === "number" && value >= 0`,
  CONFIG_COMPRESSION: `(value) => typeof value === "number" && value > 0 && value < 10`,
  CONFIG_MIN_LEVEL_STAT_SAVE: `(value) => typeof value === "number" && value < MAX_LEVEL`,
  CONFIG_INTERVAL_MAPUPDATE: `(value) => typeof value === "number" && value >= MIN_MAP_UPDATE_DELAY`,
  CONFIG_MIN_PLAYER_NAME: `(value) => typeof value === "number" && value > 0 && value <= MAX_PLAYER_NAME`,
  CONFIG_MIN_CHARTER_NAME: `(value) => typeof value === "number" && value > 0 && value <= MAX_CHARTER_NAME`,
  CONFIG_MIN_PET_NAME: `(value) => typeof value === "number" && value > 0 && value <= MAX_PET_NAME`,
  CONFIG_CHARACTERS_PER_REALM: `(value) => typeof value === "number" && value > 0 && value <= 10`,
  CONFIG_CHARACTERS_PER_ACCOUNT: `(value, get) => typeof value === "number" && value >= Number(get(ServerConfig.CONFIG_CHARACTERS_PER_REALM))`,
  CONFIG_HEROIC_CHARACTERS_PER_REALM: `(value) => typeof value === "number" && value <= 10`,
  CONFIG_SKIP_CINEMATICS: `(value) => typeof value === "number" && value <= 2`,
  CONFIG_MAX_PLAYER_LEVEL: `(value) => typeof value === "number" && value > 0 && value <= MAX_LEVEL`,
  CONFIG_START_PLAYER_LEVEL: `(value, get) => typeof value === "number" && value > 0 && value <= Number(get(ServerConfig.CONFIG_MAX_PLAYER_LEVEL))`,
  CONFIG_START_HEROIC_PLAYER_LEVEL: `(value, get) => typeof value === "number" && value > 0 && value <= Number(get(ServerConfig.CONFIG_MAX_PLAYER_LEVEL))`,
  CONFIG_START_PLAYER_MONEY: `(value) => typeof value === "number" && value <= MAX_MONEY_AMOUNT`,
  CONFIG_START_HEROIC_PLAYER_MONEY: `(value) => typeof value === "number" && value <= MAX_MONEY_AMOUNT`,
  CONFIG_START_HONOR_POINTS: `(value, get) => typeof value === "number" && value <= Number(get(ServerConfig.CONFIG_MAX_HONOR_POINTS))`,
  CONFIG_START_ARENA_POINTS: `(value, get) => typeof value === "number" && value <= Number(get(ServerConfig.CONFIG_MAX_ARENA_POINTS))`,
  CONFIG_MAX_RECRUIT_A_FRIEND_BONUS_PLAYER_LEVEL: `(value, get) => typeof value === "number" && value <= Number(get(ServerConfig.CONFIG_MAX_PLAYER_LEVEL))`,
  CONFIG_TAXI_FLIGHT_SPEED: `(value) => typeof value === "number" && value > 0.01 && value <= 50`,
  CONFIG_MIN_PETITION_SIGNS: `(value) => typeof value === "number" && value <= 9`,
  CONFIG_START_GM_LEVEL: `(value) => typeof value === "number" && value <= MAX_LEVEL`,
  CONFIG_UPTIME_UPDATE: `(value) => typeof value === "number" && value > 0`,
  CONFIG_LOGDB_CLEARINTERVAL: `(value) => typeof value === "number" && value > 0`,
  CONFIG_MAX_OVERSPEED_PINGS: `(value) => typeof value === "number" && value !== 1`,
  CONFIG_QUEST_LOW_LEVEL_HIDE_DIFF: `(value) => typeof value === "number" && value <= MAX_LEVEL`,
  CONFIG_QUEST_HIGH_LEVEL_HIDE_DIFF: `(value) => typeof value === "number" && value <= MAX_LEVEL`,
  CONFIG_RANDOM_BG_RESET_HOUR: `(value) => typeof value === "number" && value <= 23`,
  CONFIG_CALENDAR_DELETE_OLD_EVENTS_HOUR: `(value) => typeof value === "number" && value <= 23`,
  CONFIG_GUILD_RESET_HOUR: `(value) => typeof value === "number" && value <= 23`,
  CONFIG_BATTLEGROUND_REPORT_AFK: `(value) => typeof value === "number" && value > 0 && value <= 9`,
  CONFIG_BATTLEGROUND_PLAYER_RESPAWN: `(value) => typeof value === "number" && value >= 3`,
  CONFIG_BATTLEGROUND_RESTORATION_BUFF_RESPAWN: `(value) => typeof value === "number" && value > 0`,
  CONFIG_BATTLEGROUND_BERSERKING_BUFF_RESPAWN: `(value) => typeof value === "number" && value > 0`,
  CONFIG_BATTLEGROUND_SPEED_BUFF_RESPAWN: `(value) => typeof value === "number" && value > 0`,
  CONFIG_WATER_BREATH_TIMER: `(value) => typeof value === "number" && value > 0`,
  CONFIG_GUILD_EVENT_LOG_COUNT: `(value) => typeof value === "number" && value <= GUILD_EVENTLOG_MAX_RECORDS`,
  CONFIG_GUILD_BANK_EVENT_LOG_COUNT: `(value) => typeof value === "number" && value <= GUILD_BANKLOG_MAX_RECORDS`,
  CONFIG_PVP_TOKEN_COUNT: `(value) => typeof value === "number" && value > 0`,
  CONFIG_PACKET_SPOOF_BANMODE: `(value) => typeof value === "number" && value === 0`,
  CONFIG_LFG_MAX_KICK_COUNT: `(value) => typeof value === "number" && value <= 3`,
  CONFIG_LFG_KICK_PREVENTION_TIMER: `(value) => typeof value === "number" && value <= 15 * MINUTE * IN_MILLISECONDS`,
  CONFIG_AUCTIONHOUSE_WORKERTHREADS: `(value) => typeof value === "number" && value >= 1`,
};

const namedDefaults = new Set([
  "REALM_ZONE_DEVELOPMENT",
  "DEFAULT_MAX_LEVEL",
  "SEC_ADMINISTRATOR",
  "SEC_CONSOLE",
  "GUILD_EVENTLOG_MAX_RECORDS",
  "GUILD_BANKLOG_MAX_RECORDS",
  "HOUR",
]);

function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const mark = line.indexOf("//");
      return mark < 0 ? line : line.slice(0, mark);
    })
    .join("\n");
}

function splitArgs(body: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? "";
    if (quote) {
      current += char;
      if (char === quote && body[i - 1] !== "\\") {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) {
    args.push(current.trim());
  }
  return args;
}

const cleaned = stripComments(source);
const calls: string[] = [];
const marker = "SetConfigValue<";
let cursor = 0;
while (cursor < cleaned.length) {
  const start = cleaned.indexOf(marker, cursor);
  if (start < 0) {
    break;
  }
  const open = cleaned.indexOf("(", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  calls.push(cleaned.slice(start, end + 1));
  cursor = end + 1;
}

type Parsed = {
  type: "bool" | "uint32" | "float" | "string";
  name: string;
  key: string;
  defaultValue: string;
  reloadable: boolean;
  checkText: string | null;
  hasCheck: boolean;
};

function mapType(typeName: string): Parsed["type"] {
  if (typeName === "bool") {
    return "bool";
  }
  if (typeName === "uint32") {
    return "uint32";
  }
  if (typeName === "float") {
    return "float";
  }
  if (typeName === "std::string") {
    return "string";
  }
  throw new Error(`unknown config type ${typeName}`);
}

const parsed: Parsed[] = calls.map((call) => {
  const typeName = call.slice(marker.length, call.indexOf(">")).trim();
  const body = call.slice(call.indexOf("(") + 1, call.lastIndexOf(")"));
  const args = splitArgs(body);
  const name = args[0] ?? "";
  const key = (args[1] ?? "").replaceAll('"', "");
  let defaultSource = args[2] ?? "";
  let reloadable = true;
  let checkText: string | null = null;
  const hasCheck = args.some((arg) => arg.includes("[](") || arg.includes("[this]("));
  for (const arg of args.slice(3)) {
    if (arg.includes("Reloadable::No")) {
      reloadable = false;
    }
    if (arg.startsWith('"') && arg.endsWith('"')) {
      checkText = arg.slice(1, -1);
    }
  }
  if (hasCheck && !checks[name]) {
    throw new Error(`missing check for ${name}`);
  }
  return {
    type: mapType(typeName),
    name,
    key,
    defaultValue: defaultSource,
    reloadable,
    checkText,
    hasCheck,
  };
});

function emitDefault(entry: Parsed): string {
  const raw = entry.defaultValue.replace(/f$/, "");
  if (raw.startsWith("GetConfigValue")) {
    return `(get) => Number(get(ServerConfig.CONFIG_REALM_ZONE)) === REALM_ZONE_RUSSIAN`;
  }
  if (entry.type === "bool") {
    if (raw === "true" || raw === "1") {
      return "true";
    }
    if (raw === "false" || raw === "0") {
      return "false";
    }
  }
  if (entry.type === "string") {
    return raw;
  }
  if (namedDefaults.has(raw)) {
    return raw;
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
    return raw;
  }
  throw new Error(`cannot emit default for ${entry.name}: ${raw}`);
}

const enumLines = names.map((name, index) => `  ${name}: ${index},`).join("\n");
const entryLines = parsed
  .map((entry) => {
    const fields = [
      `    id: ServerConfig.${entry.name},`,
      `    type: "${entry.type}",`,
      `    key: ${JSON.stringify(entry.key)},`,
      `    defaultValue: ${emitDefault(entry)},`,
      `    reloadable: ${entry.reloadable},`,
    ];
    if (entry.hasCheck) {
      fields.push(`    check: ${checks[entry.name]},`);
      fields.push(`    checkText: ${JSON.stringify(entry.checkText ?? "")},`);
    }
    return `  {\n${fields.join("\n")}\n  },`;
  })
  .join("\n");

const known = new Set(parsed.map((entry) => entry.name));
for (const name of names) {
  if (name !== "MAX_NUM_SERVER_CONFIGS" && !known.has(name)) {
    throw new Error(`enum ${name} has no SetConfigValue`);
  }
}
if (parsed.length !== names.length - 1) {
  throw new Error(`parsed ${parsed.length} configs, enum has ${names.length - 1}`);
}

const output = `import { HOUR, IN_MILLISECONDS, MINUTE } from "../../common/duration.ts";
import {
  DEFAULT_MAX_LEVEL,
  GUILD_BANKLOG_MAX_RECORDS,
  GUILD_EVENTLOG_MAX_RECORDS,
  MAX_CHARTER_NAME,
  MAX_LEVEL,
  MAX_MONEY_AMOUNT,
  MAX_PET_NAME,
  MAX_PLAYER_NAME,
  MIN_MAP_UPDATE_DELAY,
  REALM_ZONE_DEVELOPMENT,
  REALM_ZONE_RUSSIAN,
  SEC_ADMINISTRATOR,
  SEC_CONSOLE,
} from "../../shared/limits.ts";

/** Indexes match \`ServerConfigs\` in WorldConfig.h. */
export const ServerConfig = {
${enumLines}
} as const;

export type ServerConfig = (typeof ServerConfig)[keyof typeof ServerConfig];

export type ConfigValue = boolean | number | string;

export type ConfigCheck = (value: ConfigValue, get: (id: ServerConfig) => ConfigValue) => boolean;

export type WorldConfigEntry = {
  id: ServerConfig;
  type: "bool" | "uint32" | "float" | "string";
  key: string;
  defaultValue: ConfigValue | ((get: (id: ServerConfig) => ConfigValue) => ConfigValue);
  reloadable: boolean;
  check?: ConfigCheck;
  checkText?: string;
};

/** One row per \`SetConfigValue\` in WorldConfig::BuildConfigCache, in that order. */
export const WORLD_CONFIG_ENTRIES: readonly WorldConfigEntry[] = [
${entryLines}
];
`;

await Bun.write("src/game/world/world-config-data.ts", output);
console.log(`wrote ${parsed.length} configs, enum ${names.length}`);
