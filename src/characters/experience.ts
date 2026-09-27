import { exploration_basexp, player_class_stats, player_race_stats, player_xp_for_level } from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { ByteWriter } from "../net/byte-buffer.ts";

/** PLAYER_EXPLORED_ZONES_SIZE — 128 uint32 fields (4096 bits). */
export const PLAYER_EXPLORED_ZONES_SIZE = 128;

/** CONFIG_MAX_PLAYER_LEVEL for 3.3.5a. */
export const MAX_PLAYER_LEVEL = 80;

export const MAX_STATS = 5;
export const MAX_POWERS = 7;

export const SMSG_LEVELUP_INFO = 0x1d4;
export const SMSG_EXPLORATION_EXPERIENCE = 0x1f8;

export type XpRates = {
  /** Multiplier applied to granted XP in giveXp (default 1). */
  xp?: number;
  /** RATE_XP_EXPLORE (default 1). */
  explore?: number;
  /**
   * When true, apply GetXPRestBonus like GiveXP with a kill victim.
   * Quests and exploration pass false (GiveXP with nullptr). Default true.
   */
  rest?: boolean;
};

export type GiveXpArgs = {
  world: WorldTables;
  level: number;
  xp: number;
  restBonus: number;
  amount: number;
  rates?: XpRates;
  maxLevel?: number;
};

export type GiveXpResult = {
  level: number;
  xp: number;
  restBonus: number;
  levelsGained: number;
  restedGrant: number;
  normalGrant: number;
};

export type LevelUpStats = {
  baseHp: number;
  baseMana: number;
  strength: number;
  agility: number;
  stamina: number;
  intellect: number;
  spirit: number;
  health: number;
  mana: number;
  powerType: number;
  maxPower: number;
  power: number;
};

export type ExploreAreaArgs = {
  exploredMask: number[] | string | null;
  /** AreaTable.exploreFlag — bit index into the explored mask. */
  exploreFlag: number;
  /** AreaTable.ID — carried in SMSG_EXPLORATION_EXPERIENCE. */
  areaId: number;
  areaLevel: number;
  playerLevel: number;
  world: WorldTables;
  rates?: XpRates;
  maxLevel?: number;
};

export type ExploreAreaResult =
  | {
      status: "already_explored";
      exploredMask: number[];
      exploredZones: string;
      xp: 0;
      areaId: number;
    }
  | {
      status: "explored";
      exploredMask: number[];
      exploredZones: string;
      xp: number;
      areaId: number;
    }
  | {
      status: "invalid_flag";
      exploredMask: number[];
      exploredZones: string;
      xp: 0;
      areaId: number;
    };

type ClassStatsRow = {
  BaseHP: number;
  BaseMana: number;
  Strength: number;
  Agility: number;
  Stamina: number;
  Intellect: number;
  Spirit: number;
};

type RaceStatsRow = {
  Strength: number;
  Agility: number;
  Stamina: number;
  Intellect: number;
  Spirit: number;
};

type ClassId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 11;

function asClassId(classId: number): ClassId | null {
  switch (classId) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
    case 11:
      return classId;
    default:
      return null;
  }
}

function powerTypeForClass(classId: ClassId): number {
  switch (classId) {
    case 1:
      return 1; // rage
    case 2:
      return 0; // mana
    case 3:
      return 0; // mana (ChrClasses.dbc DisplayPower for hunters in 3.3.5)
    case 4:
      return 3; // energy
    case 5:
      return 0; // mana
    case 6:
      return 6; // runic power
    case 7:
      return 0; // mana
    case 8:
      return 0; // mana
    case 9:
      return 0; // mana
    case 11:
      return 0; // mana
    default: {
      const _exhaustive: never = classId;
      return _exhaustive;
    }
  }
}

type PowerType = 0 | 1 | 2 | 3 | 6;

function asPowerType(powerType: number): PowerType {
  switch (powerType) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 6:
      return powerType;
    default:
      return 0;
  }
}

function maxPowerForType(powerType: PowerType, mana: number): number {
  switch (powerType) {
    case 1:
      return 1000;
    case 2:
      return 100;
    case 3:
      return 100;
    case 6:
      return 1000;
    case 0:
      return mana;
    default: {
      const _exhaustive: never = powerType;
      return _exhaustive;
    }
  }
}

function currentPower(powerType: PowerType, maxPower: number): number {
  switch (powerType) {
    case 1:
    case 6:
      return 0;
    case 0:
    case 2:
    case 3:
      return maxPower;
    default: {
      const _exhaustive: never = powerType;
      return _exhaustive;
    }
  }
}

function healthFromStamina(baseHp: number, stamina: number): number {
  const bonus = stamina < 20 ? stamina : 20 + (stamina - 20) * 10;
  return Math.floor(baseHp + bonus);
}

function manaFromIntellect(baseMana: number, intellect: number): number {
  if (baseMana <= 0) {
    return 0;
  }
  const bonus = intellect < 20 ? intellect : 20 + (intellect - 20) * 15;
  return Math.floor(baseMana + bonus);
}

/** XP required to advance from `level` to `level + 1` (`player_xp_for_level`). */
export function xpForLevel(world: WorldTables, level: number): number {
  if (level < 1) {
    return 0;
  }
  return world.first(player_xp_for_level, "Level", level)?.Experience ?? 0;
}

/** exploration_basexp.basexp for an area/player level. */
export function baseExplorationXp(world: WorldTables, level: number): number {
  return world.first(exploration_basexp, "level", level)?.basexp ?? 0;
}

/**
 * Player::GetXPRestBonus — rested grant is min(restBonus, xp), then rest_bonus decreases.
 * Floors rest_bonus at 0.
 */
export function xpRestBonus(restBonus: number, xp: number): { restedGrant: number; restBonus: number } {
  let restedGrant = Math.trunc(restBonus);
  if (restedGrant < 0) {
    restedGrant = 0;
  }
  if (restedGrant > xp) {
    restedGrant = xp;
  }
  let next = restBonus - restedGrant;
  if (next < 0) {
    next = 0;
  }
  return { restedGrant, restBonus: next };
}

/**
 * Player::GiveXP level/XP/rest update (no packet side effects).
 * Call from kill rewards and from quest turn-in after QuestLog.reward (pass rates.rest: false for quests).
 */
export function giveXp(args: GiveXpArgs): GiveXpResult {
  const maxLevel = args.maxLevel ?? MAX_PLAYER_LEVEL;
  const rate = args.rates?.xp ?? 1;
  const applyRest = args.rates?.rest ?? true;

  let level = args.level;
  let xp = args.xp;
  let restBonus = args.restBonus;

  if (args.amount < 1 || level >= maxLevel) {
    return {
      level,
      xp,
      restBonus,
      levelsGained: 0,
      restedGrant: 0,
      normalGrant: 0,
    };
  }

  let amount = Math.trunc(args.amount * rate);
  if (amount < 1) {
    return {
      level,
      xp,
      restBonus,
      levelsGained: 0,
      restedGrant: 0,
      normalGrant: 0,
    };
  }

  let restedGrant = 0;
  if (applyRest) {
    const rest = xpRestBonus(restBonus, amount);
    restedGrant = rest.restedGrant;
    restBonus = rest.restBonus;
  }

  const normalGrant = amount;
  let newXp = xp + amount + restedGrant;
  let nextLvlXp = xpForLevel(args.world, level);
  let levelsGained = 0;

  while (newXp >= nextLvlXp && level < maxLevel) {
    if (nextLvlXp < 1) {
      break;
    }
    newXp -= nextLvlXp;
    level += 1;
    levelsGained += 1;
    nextLvlXp = xpForLevel(args.world, level);
  }

  return {
    level,
    xp: newXp,
    restBonus,
    levelsGained,
    restedGrant,
    normalGrant,
  };
}

/**
 * Exploration XP from CheckAreaExploreAndOutdoor (before GiveXP).
 * rate defaults to 1 (RATE_XP_EXPLORE).
 */
export function explorationXp(
  world: WorldTables,
  areaLevel: number,
  playerLevel: number,
  rates?: XpRates,
): number {
  if (areaLevel <= 0) {
    return 0;
  }
  const rate = rates?.explore ?? 1;
  const diff = playerLevel - areaLevel;
  if (diff < -5) {
    return Math.trunc(baseExplorationXp(world, playerLevel + 5) * rate);
  }
  if (diff > 5) {
    let explorationPercent = 100 - (diff - 5) * 5;
    if (explorationPercent > 100) {
      explorationPercent = 100;
    } else if (explorationPercent < 0) {
      explorationPercent = 0;
    }
    return Math.trunc(baseExplorationXp(world, areaLevel) * explorationPercent / 100 * rate);
  }
  return Math.trunc(baseExplorationXp(world, areaLevel) * rate);
}

/** Parse characters.exploredZones (space-separated uint32 list) into 128 fields. */
export function parseExploredZones(raw: string | null | undefined): number[] {
  const mask = new Array<number>(PLAYER_EXPLORED_ZONES_SIZE).fill(0);
  if (!raw) {
    return mask;
  }
  const parts = raw.trim().split(/\s+/).filter((part) => part.length > 0);
  for (let i = 0; i < PLAYER_EXPLORED_ZONES_SIZE && i < parts.length; i += 1) {
    const value = Number.parseInt(parts[i]!, 10);
    mask[i] = Number.isFinite(value) ? value >>> 0 : 0;
  }
  return mask;
}

/** Serialize explored mask the way PlayerStorage saves exploredZones. */
export function formatExploredZones(mask: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < PLAYER_EXPLORED_ZONES_SIZE; i += 1) {
    parts.push(String((mask[i] ?? 0) >>> 0));
  }
  return `${parts.join(" ")} `;
}

function normalizeExploredMask(exploredMask: number[] | string | null): number[] {
  if (Array.isArray(exploredMask)) {
    const mask = new Array<number>(PLAYER_EXPLORED_ZONES_SIZE).fill(0);
    for (let i = 0; i < PLAYER_EXPLORED_ZONES_SIZE && i < exploredMask.length; i += 1) {
      mask[i] = exploredMask[i]! >>> 0;
    }
    return mask;
  }
  return parseExploredZones(exploredMask);
}

/**
 * CheckAreaExploreAndOutdoor explore-bit + XP award (no GiveXP side effects).
 * Marks the exploreFlag bit; returns XP to feed into giveXp (with rates.rest: false).
 */
export function exploreArea(args: ExploreAreaArgs): ExploreAreaResult {
  const mask = normalizeExploredMask(args.exploredMask);
  const exploredZones = formatExploredZones(mask);
  const offset = Math.floor(args.exploreFlag / 32);
  if (offset < 0 || offset >= PLAYER_EXPLORED_ZONES_SIZE) {
    return {
      status: "invalid_flag",
      exploredMask: mask,
      exploredZones,
      xp: 0,
      areaId: args.areaId,
    };
  }

  const bit = 1 << (args.exploreFlag % 32);
  const current = mask[offset]! >>> 0;
  if ((current & bit) !== 0) {
    return {
      status: "already_explored",
      exploredMask: mask,
      exploredZones,
      xp: 0,
      areaId: args.areaId,
    };
  }

  const next = mask.slice();
  next[offset] = (current | bit) >>> 0;
  const maxLevel = args.maxLevel ?? MAX_PLAYER_LEVEL;

  let xp = 0;
  if (args.areaLevel > 0) {
    if (args.playerLevel >= maxLevel) {
      xp = 0;
    } else {
      xp = explorationXp(args.world, args.areaLevel, args.playerLevel, args.rates);
    }
  }

  return {
    status: "explored",
    exploredMask: next,
    exploredZones: formatExploredZones(next),
    xp,
    areaId: args.areaId,
  };
}

/**
 * GiveLevel create-stat snapshot from player_class_stats + player_race_stats
 * (same tables/formulas as loadPlayerStart).
 */
export function levelUpStats(
  world: WorldTables,
  race: number,
  classId: number,
  level: number,
): LevelUpStats | null {
  const classKey = asClassId(classId);
  if (classKey === null || level < 1) {
    return null;
  }

  const classStats = world.where(player_class_stats, "Class", classId).find((row) => row.Level === level);
  if (!classStats) {
    return null;
  }

  const raceStats = world.first(player_race_stats, "Race", race);

  const strength = classStats.Strength + (raceStats?.Strength ?? 0);
  const agility = classStats.Agility + (raceStats?.Agility ?? 0);
  const stamina = classStats.Stamina + (raceStats?.Stamina ?? 0);
  const intellect = classStats.Intellect + (raceStats?.Intellect ?? 0);
  const spirit = classStats.Spirit + (raceStats?.Spirit ?? 0);
  const baseHp = classStats.BaseHP;
  const baseMana = classStats.BaseMana;
  const health = healthFromStamina(baseHp, stamina);
  const mana = manaFromIntellect(baseMana, intellect);
  const powerType = asPowerType(powerTypeForClass(classKey));
  const maxPower = maxPowerForType(powerType, mana);
  const power = currentPower(powerType, maxPower);

  return {
    baseHp,
    baseMana,
    strength,
    agility,
    stamina,
    intellect,
    spirit,
    health,
    mana,
    powerType,
    maxPower,
    power,
  };
}

export type LevelUpInfoFields = {
  level: number;
  healthDelta: number;
  /** Length MAX_POWERS (7); only mana delta is typically non-zero. */
  powerDelta: number[];
  /** Length MAX_STATS (5): strength, agility, stamina, intellect, spirit. */
  statDelta: number[];
};

/** Deltas for SMSG_LEVELUP_INFO from previous and next create-stat snapshots. */
export function levelUpDeltas(previous: LevelUpStats, next: LevelUpStats, level: number): LevelUpInfoFields {
  const powerDelta = new Array<number>(MAX_POWERS).fill(0);
  powerDelta[0] = next.baseMana - previous.baseMana;
  return {
    level,
    healthDelta: next.baseHp - previous.baseHp,
    powerDelta,
    statDelta: [
      next.strength - previous.strength,
      next.agility - previous.agility,
      next.stamina - previous.stamina,
      next.intellect - previous.intellect,
      next.spirit - previous.spirit,
    ],
  };
}

/** SMSG_LEVELUP_INFO payload (MiscPackets::LevelUpInfo). */
export function buildLevelUpInfo(fields: LevelUpInfoFields): Uint8Array {
  const writer = new ByteWriter();
  writer.writeU32(fields.level);
  writer.writeU32(fields.healthDelta);
  for (let i = 0; i < MAX_POWERS; i += 1) {
    writer.writeU32(fields.powerDelta[i] ?? 0);
  }
  for (let i = 0; i < MAX_STATS; i += 1) {
    writer.writeU32(fields.statDelta[i] ?? 0);
  }
  return writer.toUint8Array();
}

/** SMSG_EXPLORATION_EXPERIENCE payload (Player::SendExplorationExperience). */
export function buildExplorationExperience(areaId: number, experience: number): Uint8Array {
  return new ByteWriter().writeU32(areaId).writeU32(experience).toUint8Array();
}
