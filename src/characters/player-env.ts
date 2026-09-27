import type { WorldTables } from "../database/world-tables.ts";
import type { DbcStores } from "../data/dbc.ts";
import { emptyStatDbcStores, loadStatDbcStores, type StatDbcStores } from "../data/dbc-stats.ts";
import { emptySkillData, loadSkillDbcStores, skillDataFromStores, type SkillData } from "../data/dbc-skills.ts";
import { ServerConfig } from "../game/world/world-config-data.ts";
import type { WorldConfig } from "../game/world/world-config.ts";
import { DEFAULT_STAT_LIMITS, type StatLimits } from "./player-stats.ts";
import { DEFAULT_REGEN_RATES, type RegenRates } from "./regen.ts";
import {
  DEFAULT_SKILL_CONFIG,
  loadPlayerCreateSkills,
  skillConfigFromWorld,
  type PlayerCreateInfoSkill,
  type SkillConfig,
} from "./skills.ts";

/** Server-wide data every player's stats, skills, regen, and level-up read. Built once at startup. */
export type PlayerEnvironment = {
  statStores: StatDbcStores;
  skillData: SkillData;
  createSkills: ReadonlyMap<number, PlayerCreateInfoSkill[]>;
  skillConfig: SkillConfig;
  regenRates: RegenRates;
  limits: StatLimits;
  maxLevel: number;
  talentRate: number;
  /** `Rate.XP.Quest`, `Rate.XP.Kill`, `Rate.XP.Explore`. */
  xpRates: { quest: number; kill: number; explore: number };
};

export function defaultPlayerEnvironment(): PlayerEnvironment {
  return {
    statStores: emptyStatDbcStores(),
    skillData: emptySkillData(),
    createSkills: new Map(),
    skillConfig: { ...DEFAULT_SKILL_CONFIG },
    regenRates: { ...DEFAULT_REGEN_RATES },
    limits: { ...DEFAULT_STAT_LIMITS },
    maxLevel: 80,
    talentRate: 1,
    xpRates: { quest: 1, kill: 1, explore: 1 },
  };
}

/** Loads the DBC-backed tables from `directory` and the config-backed rates. Missing files leave empty tables. */
export async function loadPlayerEnvironment(options: {
  directory: string;
  dbc: DbcStores | null;
  worldDb: WorldTables | null;
  settings?: WorldConfig | null;
}): Promise<PlayerEnvironment> {
  const env = defaultPlayerEnvironment();
  env.statStores = await loadStatDbcStores(options.directory);
  let skillFiles = null;
  try {
    skillFiles = loadSkillDbcStores(options.directory);
  } catch {
    skillFiles = null;
  }
  env.skillData = options.dbc || skillFiles ? skillDataFromStores(options.dbc, skillFiles) : emptySkillData();
  if (options.worldDb) {
    env.createSkills = loadPlayerCreateSkills(options.worldDb, env.skillData);
  }
  const settings = options.settings;
  if (settings) {
    env.skillConfig = skillConfigFromWorld(settings);
    env.maxLevel = settings.getUInt(ServerConfig.CONFIG_MAX_PLAYER_LEVEL) || 80;
    env.regenRates = {
      health: settings.getFloat(ServerConfig.RATE_HEALTH),
      mana: settings.getFloat(ServerConfig.RATE_POWER_MANA),
      rageLoss: settings.getFloat(ServerConfig.RATE_POWER_RAGE_LOSS),
      runicPowerLoss: settings.getFloat(ServerConfig.RATE_POWER_RUNICPOWER_LOSS),
      energy: settings.getFloat(ServerConfig.RATE_POWER_ENERGY),
      lowLevelRegenBoost: settings.getBool(ServerConfig.CONFIG_LOW_LEVEL_REGEN_BOOST),
    };
    env.talentRate = settings.getFloat(ServerConfig.RATE_TALENT);
    env.xpRates = {
      quest: settings.getFloat(ServerConfig.RATE_XP_QUEST),
      kill: settings.getFloat(ServerConfig.RATE_XP_KILL),
      explore: settings.getFloat(ServerConfig.RATE_XP_EXPLORE),
    };
  }
  return env;
}
