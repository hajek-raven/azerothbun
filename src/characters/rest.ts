import type { WorldConfig } from "../game/world/world-config.ts";
import { ServerConfig } from "../game/world/world-config-data.ts";
import { DEFAULT_MAX_LEVEL } from "../shared/limits.ts";

/** `PlayerFlags::PLAYER_FLAGS_RESTING` — set while any rest flag is active. */
export const PLAYER_FLAGS_RESTING = 0x00000020;

/** `RestFlag` from Player.h — runtime mask, not a characters column. */
export const REST_FLAG_IN_TAVERN = 0x1;
export const REST_FLAG_IN_CITY = 0x2;
export const REST_FLAG_IN_FACTION_AREA = 0x4;

/** `PlayerRestState` — stored in `characters.restState` / PLAYER_BYTES_2 byte 3. */
export const REST_STATE_RESTED = 0x01;
export const REST_STATE_NOT_RAF_LINKED = 0x02;
export const REST_STATE_TIRED = 0x03;
export const REST_STATE_TIRED_XP_REDUCED = 0x04;
export const REST_STATE_EXHAUSTED = 0x05;
export const REST_STATE_RAF_LINKED = 0x06;

/** Offline wilderness bubble (section/hour) from `Player::LoadFromDB`. */
export const REST_BUBBLE_OFFLINE_WILDERNESS = 0.031;
/** Offline tavern/city bubble (section/hour) from `Player::LoadFromDB`. */
export const REST_BUBBLE_OFFLINE_TAVERN_OR_CITY = 0.125;
/** In-game rest bubble from `Player::Update`. */
export const REST_BUBBLE_INGAME = 0.125;

/**
 * Conf defaults from `Rate.Rest.*` (`WorldConfig` / worldserver.conf.dist).
 * Cap formula uses `RATE_REST_MAX_BONUS` (default 1.5) as `nextLevelXp * rate / 2`.
 */
export type RestRates = {
  inGame: number;
  offlineInTavernOrCity: number;
  offlineInWilderness: number;
  maxBonus: number;
};

export const DEFAULT_REST_RATES: RestRates = {
  inGame: 1,
  offlineInTavernOrCity: 1,
  offlineInWilderness: 1,
  maxBonus: 1.5,
};

export type RestCharacterInput = {
  level: number;
  rest_bonus: number;
  restState: number;
  logout_time: number;
  is_logout_resting: number;
  playerFlags: number;
};

export type RestFields = {
  rest_bonus: number;
  restState: number;
  is_logout_resting: number;
  playerFlags: number;
};

export type SetRestBonusResult = {
  rest_bonus: number;
  restState: number;
};

export function restRatesFromConfig(config: WorldConfig): RestRates {
  return {
    inGame: config.getFloat(ServerConfig.RATE_REST_INGAME),
    offlineInTavernOrCity: config.getFloat(ServerConfig.RATE_REST_OFFLINE_IN_TAVERN_OR_CITY),
    offlineInWilderness: config.getFloat(ServerConfig.RATE_REST_OFFLINE_IN_WILDERNESS),
    maxBonus: config.getFloat(ServerConfig.RATE_REST_MAX_BONUS),
  };
}

/**
 * `Player::SetRestBonus` — clamps bonus, updates PLAYER_BYTES_2 rest byte when thresholds cross.
 * Cap is `PLAYER_NEXT_LEVEL_XP * Rate.Rest.MaxBonus / 2` (client doubles the sent value).
 */
export function setRestBonus(
  restBonusNew: number,
  nextLevelXp: number,
  currentRestState: number,
  options: {
    level: number;
    maxPlayerLevel?: number;
    maxBonusRate?: number;
    rafLinked?: boolean;
  },
): SetRestBonusResult {
  const maxPlayerLevel = options.maxPlayerLevel ?? DEFAULT_MAX_LEVEL;
  const maxBonusRate = options.maxBonusRate ?? DEFAULT_REST_RATES.maxBonus;
  const rafLinked = options.rafLinked ?? false;

  let bonus = restBonusNew;
  if (options.level >= maxPlayerLevel) {
    bonus = 0;
  }
  if (bonus < 0) {
    bonus = 0;
  }

  const restBonusMax = nextLevelXp * maxBonusRate / 2;
  if (bonus > restBonusMax) {
    bonus = restBonusMax;
  }

  let restState = currentRestState;
  if (rafLinked) {
    restState = REST_STATE_RAF_LINKED;
  } else if (bonus > 10) {
    restState = REST_STATE_RESTED;
  } else if (bonus <= 1) {
    restState = REST_STATE_NOT_RAF_LINKED;
  }

  return { rest_bonus: bonus, restState };
}

/**
 * Offline rest gain from `Player::LoadFromDB` using `logout_time` and `is_logout_resting`.
 * `nowUnix` is unix seconds (same clock as `characters.logout_time`).
 */
export function applyOfflineRest(
  character: RestCharacterInput,
  nowUnix: number,
  nextLevelXp: number,
  rates: RestRates = DEFAULT_REST_RATES,
  options: { maxPlayerLevel?: number; rafLinked?: boolean } = {},
): RestFields {
  let bonus = character.rest_bonus;
  if (character.logout_time > 0 && nowUnix > character.logout_time) {
    const timeDiff = nowUnix - character.logout_time;
    const bubble =
      character.is_logout_resting > 0
        ? REST_BUBBLE_OFFLINE_TAVERN_OR_CITY * rates.offlineInTavernOrCity
        : REST_BUBBLE_OFFLINE_WILDERNESS * rates.offlineInWilderness;
    bonus += timeDiff * (nextLevelXp / 144000) * bubble;
  }

  const capped = setRestBonus(bonus, nextLevelXp, character.restState, {
    level: character.level,
    maxPlayerLevel: options.maxPlayerLevel,
    maxBonusRate: rates.maxBonus,
    rafLinked: options.rafLinked,
  });

  return {
    rest_bonus: capped.rest_bonus,
    restState: capped.restState,
    is_logout_resting: character.is_logout_resting,
    playerFlags: character.playerFlags,
  };
}

/**
 * In-game rest tick from `Player::Update` while `PLAYER_FLAGS_RESTING` is set.
 * `timeDiffSeconds` is seconds since `_restTime` (C++ only applies when >= 10).
 */
export function accumulateInGameRest(
  restBonus: number,
  restState: number,
  level: number,
  nextLevelXp: number,
  timeDiffSeconds: number,
  rates: RestRates = DEFAULT_REST_RATES,
  options: { maxPlayerLevel?: number; rafLinked?: boolean } = {},
): SetRestBonusResult {
  if (timeDiffSeconds < 10) {
    return { rest_bonus: restBonus, restState };
  }
  const bubble = REST_BUBBLE_INGAME * rates.inGame;
  const extraPerSec = (nextLevelXp / 72000) * bubble;
  return setRestBonus(restBonus + timeDiffSeconds * extraPerSec, nextLevelXp, restState, {
    level,
    maxPlayerLevel: options.maxPlayerLevel,
    maxBonusRate: rates.maxBonus,
    rafLinked: options.rafLinked,
  });
}

/** `Player::GetXPRestBonus` — consume up to `xp` points of rest bonus. */
export function consumeRestBonus(
  restBonus: number,
  restState: number,
  xp: number,
  level: number,
  nextLevelXp: number,
  rates: RestRates = DEFAULT_REST_RATES,
  options: { maxPlayerLevel?: number; rafLinked?: boolean } = {},
): { restedBonus: number; rest_bonus: number; restState: number } {
  let restedBonus = Math.floor(restBonus);
  if (restedBonus > xp) {
    restedBonus = xp;
  }
  const after = setRestBonus(restBonus - restedBonus, nextLevelXp, restState, {
    level,
    maxPlayerLevel: options.maxPlayerLevel,
    maxBonusRate: rates.maxBonus,
    rafLinked: options.rafLinked,
  });
  return { restedBonus, rest_bonus: after.rest_bonus, restState: after.restState };
}

export type RestFlagMask = number;

/**
 * `Player::SetRestFlag` — first flag also sets `PLAYER_FLAGS_RESTING`.
 * Returns whether `_restTime` should be set to now (first rest state).
 */
export function setRestFlag(
  restFlagMask: RestFlagMask,
  playerFlags: number,
  restFlag: number,
): { restFlagMask: number; playerFlags: number; startedResting: boolean } {
  const oldMask = restFlagMask;
  const nextMask = restFlagMask | restFlag;
  let flags = playerFlags;
  let startedResting = false;
  if (oldMask === 0 && nextMask !== 0) {
    flags |= PLAYER_FLAGS_RESTING;
    startedResting = true;
  }
  return { restFlagMask: nextMask, playerFlags: flags, startedResting };
}

/**
 * `Player::RemoveRestFlag` — clearing the last flag removes `PLAYER_FLAGS_RESTING`.
 */
export function removeRestFlag(
  restFlagMask: RestFlagMask,
  playerFlags: number,
  restFlag: number,
): { restFlagMask: number; playerFlags: number; stoppedResting: boolean } {
  const oldMask = restFlagMask;
  const nextMask = restFlagMask & ~restFlag;
  let flags = playerFlags;
  let stoppedResting = false;
  if (oldMask !== 0 && nextMask === 0) {
    flags &= ~PLAYER_FLAGS_RESTING;
    stoppedResting = true;
  }
  return { restFlagMask: nextMask, playerFlags: flags, stoppedResting };
}

export function isResting(playerFlags: number): boolean {
  return (playerFlags & PLAYER_FLAGS_RESTING) !== 0;
}

export type LogoutRestSnapshot = RestFields & { logout_time: number };

/**
 * Values written on logout / save: `logout_time`, `is_logout_resting` from `PLAYER_FLAGS_RESTING`.
 */
export function logoutRestSnapshot(
  character: Pick<RestCharacterInput, "rest_bonus" | "restState" | "playerFlags">,
  nowUnix: number,
): LogoutRestSnapshot {
  return {
    rest_bonus: character.rest_bonus,
    restState: character.restState,
    logout_time: nowUnix,
    is_logout_resting: isResting(character.playerFlags) ? 1 : 0,
    playerFlags: character.playerFlags,
  };
}

/** Max stored rest bonus for the given next-level XP and rate (pure). */
export function restBonusCap(nextLevelXp: number, maxBonusRate = DEFAULT_REST_RATES.maxBonus): number {
  return nextLevelXp * maxBonusRate / 2;
}
