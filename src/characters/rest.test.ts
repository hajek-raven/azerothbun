import { describe, expect, test } from "bun:test";
import {
  accumulateInGameRest,
  applyOfflineRest,
  consumeRestBonus,
  DEFAULT_REST_RATES,
  isResting,
  logoutRestSnapshot,
  PLAYER_FLAGS_RESTING,
  removeRestFlag,
  REST_FLAG_IN_CITY,
  REST_FLAG_IN_TAVERN,
  REST_STATE_NOT_RAF_LINKED,
  REST_STATE_RESTED,
  restBonusCap,
  setRestBonus,
  setRestFlag,
} from "./rest.ts";

const NEXT_LEVEL_XP = 400; // level 1 → 2

describe("setRestBonus", () => {
  test("caps at nextLevelXp * Rate.Rest.MaxBonus / 2", () => {
    const cap = restBonusCap(NEXT_LEVEL_XP, 1.5);
    expect(cap).toBe(300);
    const result = setRestBonus(10_000, NEXT_LEVEL_XP, REST_STATE_NOT_RAF_LINKED, {
      level: 1,
      maxBonusRate: 1.5,
    });
    expect(result.rest_bonus).toBe(300);
    expect(result.restState).toBe(REST_STATE_RESTED);
  });

  test("clears bonus at max player level", () => {
    const result = setRestBonus(200, NEXT_LEVEL_XP, REST_STATE_RESTED, {
      level: 80,
      maxPlayerLevel: 80,
    });
    expect(result.rest_bonus).toBe(0);
    expect(result.restState).toBe(REST_STATE_NOT_RAF_LINKED);
  });

  test("restState becomes RESTED only when bonus > 10", () => {
    const low = setRestBonus(5, NEXT_LEVEL_XP, REST_STATE_NOT_RAF_LINKED, { level: 1 });
    expect(low.restState).toBe(REST_STATE_NOT_RAF_LINKED);
    const high = setRestBonus(11, NEXT_LEVEL_XP, REST_STATE_NOT_RAF_LINKED, { level: 1 });
    expect(high.restState).toBe(REST_STATE_RESTED);
  });
});

describe("applyOfflineRest", () => {
  test("gains more rest while logged out resting in an inn", () => {
    const logoutTime = 1_000_000;
    const now = logoutTime + 14_400; // 4 hours
    const base = {
      level: 1,
      rest_bonus: 0,
      restState: REST_STATE_NOT_RAF_LINKED,
      logout_time: logoutTime,
      is_logout_resting: 1,
      playerFlags: PLAYER_FLAGS_RESTING,
    };
    const inn = applyOfflineRest(base, now, NEXT_LEVEL_XP);
    const wild = applyOfflineRest({ ...base, is_logout_resting: 0, playerFlags: 0 }, now, NEXT_LEVEL_XP);

    // time * (xp/144000) * bubble: inn bubble 0.125, wilderness 0.031
    const expectedInn = 14_400 * (NEXT_LEVEL_XP / 144000) * 0.125;
    const expectedWild = 14_400 * (NEXT_LEVEL_XP / 144000) * 0.031;
    expect(inn.rest_bonus).toBeCloseTo(expectedInn, 5);
    expect(wild.rest_bonus).toBeCloseTo(expectedWild, 5);
    expect(inn.rest_bonus).toBeGreaterThan(wild.rest_bonus);
  });

  test("does not gain the same way when not resting at logout", () => {
    const logoutTime = 5_000_000;
    const now = logoutTime + 86_400;
    const resting = applyOfflineRest(
      {
        level: 1,
        rest_bonus: 0,
        restState: REST_STATE_NOT_RAF_LINKED,
        logout_time: logoutTime,
        is_logout_resting: 1,
        playerFlags: PLAYER_FLAGS_RESTING,
      },
      now,
      NEXT_LEVEL_XP,
    );
    const notResting = applyOfflineRest(
      {
        level: 1,
        rest_bonus: 0,
        restState: REST_STATE_NOT_RAF_LINKED,
        logout_time: logoutTime,
        is_logout_resting: 0,
        playerFlags: 0,
      },
      now,
      NEXT_LEVEL_XP,
    );
    expect(resting.rest_bonus / notResting.rest_bonus).toBeCloseTo(0.125 / 0.031, 5);
  });

  test("respects the rest bonus cap after long offline rest", () => {
    const logoutTime = 1;
    const now = logoutTime + 365 * 24 * 3600;
    const result = applyOfflineRest(
      {
        level: 1,
        rest_bonus: 0,
        restState: REST_STATE_NOT_RAF_LINKED,
        logout_time: logoutTime,
        is_logout_resting: 1,
        playerFlags: PLAYER_FLAGS_RESTING,
      },
      now,
      NEXT_LEVEL_XP,
      DEFAULT_REST_RATES,
    );
    expect(result.rest_bonus).toBe(restBonusCap(NEXT_LEVEL_XP));
    expect(result.restState).toBe(REST_STATE_RESTED);
  });

  test("no gain when logout_time is zero", () => {
    const result = applyOfflineRest(
      {
        level: 1,
        rest_bonus: 12,
        restState: REST_STATE_RESTED,
        logout_time: 0,
        is_logout_resting: 1,
        playerFlags: PLAYER_FLAGS_RESTING,
      },
      1_000_000,
      NEXT_LEVEL_XP,
    );
    expect(result.rest_bonus).toBe(12);
  });
});

describe("accumulateInGameRest", () => {
  test("ignores ticks shorter than 10 seconds", () => {
    const result = accumulateInGameRest(0, REST_STATE_NOT_RAF_LINKED, 1, NEXT_LEVEL_XP, 9);
    expect(result.rest_bonus).toBe(0);
  });

  test("accumulates at in-game rate for long ticks", () => {
    const result = accumulateInGameRest(0, REST_STATE_NOT_RAF_LINKED, 1, NEXT_LEVEL_XP, 100);
    const expected = 100 * (NEXT_LEVEL_XP / 72000) * 0.125;
    expect(result.rest_bonus).toBeCloseTo(expected, 5);
  });
});

describe("rest flags", () => {
  test("first rest flag sets PLAYER_FLAGS_RESTING; last clear removes it", () => {
    const first = setRestFlag(0, 0, REST_FLAG_IN_TAVERN);
    expect(first.startedResting).toBe(true);
    expect(isResting(first.playerFlags)).toBe(true);

    const second = setRestFlag(first.restFlagMask, first.playerFlags, REST_FLAG_IN_CITY);
    expect(second.startedResting).toBe(false);
    expect(isResting(second.playerFlags)).toBe(true);

    const dropTavern = removeRestFlag(second.restFlagMask, second.playerFlags, REST_FLAG_IN_TAVERN);
    expect(dropTavern.stoppedResting).toBe(false);
    expect(isResting(dropTavern.playerFlags)).toBe(true);

    const dropCity = removeRestFlag(dropTavern.restFlagMask, dropTavern.playerFlags, REST_FLAG_IN_CITY);
    expect(dropCity.stoppedResting).toBe(true);
    expect(isResting(dropCity.playerFlags)).toBe(false);
  });
});

describe("logoutRestSnapshot", () => {
  test("records is_logout_resting from PLAYER_FLAGS_RESTING", () => {
    const resting = logoutRestSnapshot(
      { rest_bonus: 40, restState: REST_STATE_RESTED, playerFlags: PLAYER_FLAGS_RESTING },
      12345,
    );
    expect(resting.logout_time).toBe(12345);
    expect(resting.is_logout_resting).toBe(1);

    const wild = logoutRestSnapshot(
      { rest_bonus: 0, restState: REST_STATE_NOT_RAF_LINKED, playerFlags: 0 },
      99,
    );
    expect(wild.is_logout_resting).toBe(0);
  });
});

describe("consumeRestBonus", () => {
  test("consumes at most the xp gained", () => {
    const result = consumeRestBonus(50, REST_STATE_RESTED, 30, 1, NEXT_LEVEL_XP);
    expect(result.restedBonus).toBe(30);
    expect(result.rest_bonus).toBe(20);
  });
});
