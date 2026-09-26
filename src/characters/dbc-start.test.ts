import { describe, expect, test } from "bun:test";
import {
  SKILL_LINE_ABILITY_LEARNED_ON_SKILL_LEARN,
  SKILL_LINE_ABILITY_LEARNED_ON_SKILL_VALUE,
  characterStartFromDbc,
} from "./dbc-start.ts";
import type { DbcStores } from "../data/dbc.ts";

function emptyStores(overrides: Partial<DbcStores> = {}): DbcStores {
  return {
    spells: new Map(),
    factions: [],
    skillLineAbilities: [],
    skillRaceClassInfo: [],
    charStartOutfits: [],
    chrClasses: new Map(),
    chrRaces: new Map(),
    ...overrides,
  };
}

describe("characterStartFromDbc", () => {
  test("drops a known skill that fails the race mask", () => {
    const stores = emptyStores({
      skillRaceClassInfo: [
        {
          Id: 1,
          SkillID: 95,
          RaceMask: 1 << (2 - 1), // orc only
          ClassMask: 0,
          Flags: 0,
          SkillTierID: 0,
        },
      ],
    });
    const start = characterStartFromDbc(stores, 1, 1, 0, 1, [{ skill: 95, value: 1, max: 0 }]);
    expect(start.skills).toEqual([]);
  });

  test("returns a matching SkillLineAbility spell", () => {
    const stores = emptyStores({
      spells: new Map([
        [78, { Id: 78, Attributes: 0 }],
        [6603, { Id: 6603, Attributes: 0x40 }], // passive also included
      ]),
      skillRaceClassInfo: [
        {
          Id: 1,
          SkillID: 26,
          RaceMask: 0,
          ClassMask: 1 << (1 - 1),
          Flags: 0,
          SkillTierID: 0,
        },
      ],
      skillLineAbilities: [
        {
          Id: 1,
          SkillLine: 26,
          Spell: 78,
          RaceMask: 0,
          ClassMask: 0,
          MinSkillLineRank: 0,
          SupercededBySpell: 0,
          AcquireMethod: SKILL_LINE_ABILITY_LEARNED_ON_SKILL_VALUE,
          TrivialSkillLineRankHigh: 0,
          TrivialSkillLineRankLow: 0,
        },
        {
          Id: 2,
          SkillLine: 26,
          Spell: 6603,
          RaceMask: 0,
          ClassMask: 0,
          MinSkillLineRank: 0,
          SupercededBySpell: 0,
          AcquireMethod: SKILL_LINE_ABILITY_LEARNED_ON_SKILL_LEARN,
          TrivialSkillLineRankHigh: 0,
          TrivialSkillLineRankLow: 0,
        },
      ],
    });
    const start = characterStartFromDbc(stores, 1, 1, 0, 1, [{ skill: 26, value: 1, max: 0 }]);
    expect(start.skills).toEqual([{ skill: 26, value: 1, max: 5 }]);
    expect(start.spells).toEqual([78, 6603]);
  });

  test("keeps a faction slot listId", () => {
    const stores = emptyStores({
      factions: [
        {
          ID: 21,
          reputationListID: 1,
          BaseRepRaceMask0: 1 << (1 - 1),
          BaseRepClassMask0: 0,
          BaseRepValue0: -3000,
          ReputationFlags0: 1,
          BaseRepRaceMask1: 0,
          BaseRepClassMask1: 0,
          BaseRepValue1: 0,
          ReputationFlags1: 0,
          BaseRepRaceMask2: 0,
          BaseRepClassMask2: 0,
          BaseRepValue2: 0,
          ReputationFlags2: 0,
          BaseRepRaceMask3: 0,
          BaseRepClassMask3: 0,
          BaseRepValue3: 0,
          ReputationFlags3: 0,
        },
        {
          ID: 22,
          reputationListID: -1,
          BaseRepRaceMask0: 0,
          BaseRepClassMask0: 0,
          BaseRepValue0: 0,
          ReputationFlags0: 0,
          BaseRepRaceMask1: 0,
          BaseRepClassMask1: 0,
          BaseRepValue1: 0,
          ReputationFlags1: 0,
          BaseRepRaceMask2: 0,
          BaseRepClassMask2: 0,
          BaseRepValue2: 0,
          ReputationFlags2: 0,
          BaseRepRaceMask3: 0,
          BaseRepClassMask3: 0,
          BaseRepValue3: 0,
          ReputationFlags3: 0,
        },
      ],
    });
    const start = characterStartFromDbc(stores, 1, 1, 0, 1, []);
    expect(start.factions).toEqual([{ faction: 21, standing: -3000, flags: 1, listId: 1 }]);
  });

  test("returns CharStartOutfit item ids", () => {
    const stores = emptyStores({
      charStartOutfits: [
        {
          Id: 1,
          Race: 1,
          Class: 1,
          Gender: 0,
          ItemId0: 38,
          ItemId1: 39,
          ItemId2: 0,
          ItemId3: 40,
          ItemId4: 0,
          ItemId5: 0,
          ItemId6: 0,
          ItemId7: 0,
          ItemId8: 0,
          ItemId9: 0,
          ItemId10: 0,
          ItemId11: 0,
          ItemId12: 0,
          ItemId13: 0,
          ItemId14: 0,
          ItemId15: 0,
          ItemId16: 0,
          ItemId17: 0,
          ItemId18: 0,
          ItemId19: 0,
          ItemId20: 0,
          ItemId21: 0,
          ItemId22: 0,
          ItemId23: 0,
        },
      ],
    });
    const start = characterStartFromDbc(stores, 1, 1, 0, 1, []);
    expect(start.items).toEqual([38, 39, 40]);
    expect(characterStartFromDbc(stores, 1, 1, 1, 1, []).items).toEqual([]);
  });
});
