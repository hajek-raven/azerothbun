import { ByteWriter } from "../net/byte-buffer.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { buildLevelUpInfo, levelUpStats, xpRestBonus } from "./experience.ts";
import {
  CLASS_DEATH_KNIGHT,
  MAX_STATS,
  PLAYER_CHARACTER_POINTS1,
  PLAYER_NEXT_LEVEL_XP,
  PLAYER_XP,
  POWER_ENERGY,
  POWER_FOCUS,
  POWER_HAPPINESS,
  POWER_MANA,
  POWER_RAGE,
  type PlayerLevelStats,
  type PlayerStats,
} from "./player-stats.ts";

export const SMSG_LOG_XPGAIN = 0x1d0;
export const SMSG_LEVELUP_INFO = 0x1d4;

export const PLAYER_FLAGS_PARTIAL_PLAY_TIME = 0x00001000;
export const PLAYER_FLAGS_NO_PLAY_TIME = 0x00002000;
export const PLAYER_FLAGS_NO_XP_GAIN = 0x02000000;

/** `MAP_EBON_HOLD` — death knights earn talent points from quests while they are here. */
const MAP_EBON_HOLD = 609;

export type LevelPacket = { opcode: number; name: string; body: Uint8Array };

/** The character columns XP and level touch. */
export type ProgressCharacter = {
  level: number;
  xp: number;
  rest_bonus: number;
  playerFlags: number;
  leveltime: number;
  map: number;
};

export type ProgressContext = {
  stats: PlayerStats;
  character: ProgressCharacter;
  /** `CONFIG_MAX_PLAYER_LEVEL`. */
  maxLevel: number;
  /** `player_xp_for_level`. */
  xpForLevel(level: number): number;
  /** `ObjectMgr::GetPlayerLevelInfo` + `GetPlayerClassLevelInfo`. */
  levelStats(level: number): PlayerLevelStats | null;
  alive: boolean;
  /** Talents spent (`m_usedTalentCount`); the talent system owns it. */
  usedTalentCount?: number;
  /** `m_questRewardTalentCount` for death knights. */
  questRewardTalentCount?: number;
  /** `m_extraBonusTalentCount`. */
  extraBonusTalentCount?: number;
  /** `Rate.Talent`. */
  talentRate?: number;
  /** `Player::UpdateSkillsForLevel`, run between the level change and the stat update. */
  updateSkillsForLevel?(level: number): void;
  /** `CONFIG_ALWAYS_MAXSKILL` → `UpdateSkillsToMaxSkillsForLevel`. */
  updateSkillsToMaxSkillsForLevel?(): void;
};

/** `SMSG_LOG_XPGAIN` (`Player::SendLogXPGain`). */
export function logXpGainPacket(givenXp: number, victimGuid: bigint | null, bonusXp: number, recruitAFriend = false): Uint8Array {
  const writer = new ByteWriter().writeU64(victimGuid ?? 0n).writeU32(givenXp + bonusXp).writeU8(victimGuid ? 0 : 1);
  if (victimGuid) {
    writer.writeU32(givenXp);
    writer.writeF32(1);
  }
  writer.writeU8(recruitAFriend ? 1 : 0);
  return writer.toUint8Array();
}

/** `Player::CalculateTalentsPoints`. */
export function calculateTalentsPoints(ctx: Pick<ProgressContext, "questRewardTalentCount" | "extraBonusTalentCount" | "talentRate"> & {
  level: number;
  classId: number;
  map: number;
}): number {
  const baseTalent = ctx.level < 10 ? 0 : ctx.level - 9;
  let points = 0;
  if (ctx.classId !== CLASS_DEATH_KNIGHT || ctx.map !== MAP_EBON_HOLD) {
    points = baseTalent;
  } else {
    points = ctx.level < 56 ? 0 : ctx.level - 55;
    points += ctx.questRewardTalentCount ?? 0;
    if (points > baseTalent) {
      points = baseTalent;
    }
  }
  points += ctx.extraBonusTalentCount ?? 0;
  return Math.trunc(points * (ctx.talentRate ?? 1)) >>> 0;
}

/** `Player::InitTalentForLevel` — the free-points field; resetting over-spent talents belongs to the talent system. */
export function initTalentForLevel(ctx: ProgressContext): void {
  const points = calculateTalentsPoints({
    level: ctx.character.level,
    classId: ctx.stats.classId,
    map: ctx.character.map,
    questRewardTalentCount: ctx.questRewardTalentCount,
    extraBonusTalentCount: ctx.extraBonusTalentCount,
    talentRate: ctx.talentRate,
  });
  const used = ctx.usedTalentCount ?? 0;
  ctx.stats.setUInt32(PLAYER_CHARACTER_POINTS1, used > points ? 0 : points - used);
}

/** The XP fields `Player::InitStatsForLevel` and `_LoadFromDB` set. */
export function initXpFields(ctx: ProgressContext): void {
  ctx.stats.setUInt32(PLAYER_XP, ctx.character.xp);
  ctx.stats.setUInt32(PLAYER_NEXT_LEVEL_XP, ctx.xpForLevel(ctx.character.level));
  initTalentForLevel(ctx);
}

/** `Player::GiveLevel`. */
export function giveLevel(ctx: ProgressContext, level: number): LevelPacket[] {
  const stats = ctx.stats;
  const oldLevel = ctx.character.level;
  if (level === oldLevel) {
    return [];
  }
  const info = ctx.levelStats(level);
  if (!info) {
    return [];
  }
  const statDelta = new Array<number>(MAX_STATS).fill(0);
  for (let stat = 0; stat < MAX_STATS; stat++) {
    statDelta[stat] = info.stats[stat]! - stats.getCreateStat(stat);
  }
  const packets: LevelPacket[] = [
    {
      opcode: SMSG_LEVELUP_INFO,
      name: "SMSG_LEVELUP_INFO",
      body: buildLevelUpInfo({
        level,
        healthDelta: info.baseHealth - stats.getCreateHealth(),
        powerDelta: [info.baseMana - stats.getCreateMana(), 0, 0, 0, 0, 0, 0],
        statDelta,
      }),
    },
  ];
  stats.setUInt32(PLAYER_NEXT_LEVEL_XP, ctx.xpForLevel(level));
  ctx.character.leveltime = 0;
  ctx.character.level = level;
  stats.applyAllLevelScaleItemMods(false);
  stats.applyLevel(level, info);
  ctx.updateSkillsForLevel?.(level);
  initTalentForLevel(ctx);
  stats.updateAllStats();
  ctx.updateSkillsToMaxSkillsForLevel?.();
  stats.applyAllLevelScaleItemMods(true);
  stats.updateAllStats();
  if (ctx.alive) {
    stats.setHealth(stats.maxHealth);
    stats.setPower(POWER_MANA, stats.maxPower(POWER_MANA));
    stats.setPower(POWER_ENERGY, stats.maxPower(POWER_ENERGY));
    if (stats.power(POWER_RAGE) > stats.maxPower(POWER_RAGE)) {
      stats.setPower(POWER_RAGE, stats.maxPower(POWER_RAGE));
    }
    stats.setPower(POWER_FOCUS, 0);
    stats.setPower(POWER_HAPPINESS, 0);
  }
  return packets;
}

/**
 * `Player::GiveXP`. `victimGuid` is set for kill XP, which also draws on rested XP; quest and exploration
 * XP pass null. Returns the packets in the order the client receives them.
 */
export function giveXp(ctx: ProgressContext, amount: number, victimGuid: bigint | null = null): LevelPacket[] {
  let xp = Math.trunc(amount);
  if (xp < 1 || !ctx.alive) {
    return [];
  }
  const flags = ctx.character.playerFlags;
  if (flags & PLAYER_FLAGS_NO_XP_GAIN || flags & PLAYER_FLAGS_NO_PLAY_TIME) {
    return [];
  }
  let level = ctx.character.level;
  if (level >= ctx.maxLevel) {
    return [];
  }
  if (flags & PLAYER_FLAGS_PARTIAL_PLAY_TIME) {
    xp = Math.max(1, Math.trunc(xp / 2));
  }
  let bonusXp = 0;
  if (victimGuid) {
    const rest = xpRestBonus(ctx.character.rest_bonus, xp);
    bonusXp = rest.restedGrant;
    ctx.character.rest_bonus = rest.restBonus;
  }
  const packets: LevelPacket[] = [
    { opcode: SMSG_LOG_XPGAIN, name: "SMSG_LOG_XPGAIN", body: logXpGainPacket(xp, victimGuid, bonusXp) },
  ];
  let nextLvlXp = ctx.stats.getUInt32(PLAYER_NEXT_LEVEL_XP) || ctx.xpForLevel(level);
  let newXp = ctx.character.xp + xp + bonusXp;
  while (newXp >= nextLvlXp && level < ctx.maxLevel) {
    if (nextLvlXp < 1) {
      break;
    }
    newXp -= nextLvlXp;
    packets.push(...giveLevel(ctx, level + 1));
    level = ctx.character.level;
    nextLvlXp = ctx.stats.getUInt32(PLAYER_NEXT_LEVEL_XP);
  }
  ctx.character.xp = newXp;
  ctx.stats.setUInt32(PLAYER_XP, newXp);
  return packets;
}

/** `ObjectMgr::GetPlayerLevelInfo` + `GetPlayerClassLevelInfo` from `player_class_stats` and `player_race_stats`. */
export function levelStatsFor(world: WorldTables, race: number, classId: number, level: number): PlayerLevelStats | null {
  const row = levelUpStats(world, race, classId, level);
  if (!row) {
    return null;
  }
  return {
    baseHealth: row.baseHp,
    baseMana: row.baseMana,
    stats: [row.strength, row.agility, row.stamina, row.intellect, row.spirit],
  };
}
