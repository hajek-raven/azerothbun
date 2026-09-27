import { describe, expect, test } from "bun:test";
import { factiontemplate_dbc } from "../database/schema/world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { REP_FRIENDLY, REP_HOSTILE, REP_NEUTRAL } from "./constants.ts";
import { baseReputation, FactionStore, reputationToRank, templateReaction, type FactionTemplate } from "./faction.ts";

function template(id: number, faction: number, ourMask: number, friendlyMask: number, hostileMask: number, extra: Partial<FactionTemplate> = {}): FactionTemplate {
  return { id, faction, flags: 0, ourMask, friendlyMask, hostileMask, enemyFaction: [0, 0, 0, 0], friendFaction: [0, 0, 0, 0], ...extra };
}

// factiontemplate_dbc rows 1 (Human), 12 (Stormwind), 14 (Monster), 7 (Creature), 2 (Orc)
const HUMAN = template(1, 1, 3, 2, 12);
const ORC = template(2, 2, 5, 4, 10);
const STORMWIND = template(12, 72, 2, 2, 4, { friendFaction: [72, 0, 0, 0] });
const MONSTER = template(14, 14, 8, 0, 1);
const CREATURE = template(7, 7, 0, 0, 0);

describe("FactionTemplateEntry reactions", () => {
  test("monsters are hostile to players, Stormwind is friendly to humans", () => {
    expect(templateReaction(MONSTER, HUMAN)).toBe(REP_HOSTILE);
    expect(templateReaction(HUMAN, MONSTER)).toBe(REP_HOSTILE);
    expect(templateReaction(STORMWIND, HUMAN)).toBe(REP_FRIENDLY);
    expect(templateReaction(STORMWIND, ORC)).toBe(REP_HOSTILE);
    expect(templateReaction(CREATURE, HUMAN)).toBe(REP_NEUTRAL);
    expect(templateReaction(null, HUMAN)).toBe(REP_NEUTRAL);
  });

  test("the store answers both directions", () => {
    const store = new FactionStore([HUMAN, ORC, STORMWIND, MONSTER, CREATURE]);
    const player = { race: 1, classId: 1, factionTemplate: 1, reputation: () => null };
    expect(store.creatureToPlayer(14, player)).toBe(REP_HOSTILE);
    expect(store.playerToCreature(player, 7)).toBe(REP_NEUTRAL);
  });

  test("reputation factions use the player's standing and at-war flag", () => {
    const store = new FactionStore(
      [HUMAN, STORMWIND],
      [
        {
          id: 72,
          reputationListId: 5,
          baseRepRaceMask: [1 | 4 | 8 | 64, 0, 0, 0],
          baseRepClassMask: [0, 0, 0, 0],
          baseRepValue: [3000, 0, 0, 0],
        },
      ],
    );
    const friendly = { race: 1, classId: 1, factionTemplate: 1, reputation: () => null };
    expect(store.creatureToPlayer(12, friendly)).toBe(REP_FRIENDLY);
    const hated = { race: 1, classId: 1, factionTemplate: 1, reputation: () => ({ standing: -40000, flags: 0 }) };
    expect(store.creatureToPlayer(12, hated)).toBe(0);
    const atWar = { race: 1, classId: 1, factionTemplate: 1, reputation: () => ({ standing: 0, flags: 2 }) };
    expect(store.creatureToPlayer(12, atWar)).toBe(REP_NEUTRAL);
  });

  test("ReputationToRank and GetBaseReputation", () => {
    expect(reputationToRank(0)).toBe(REP_NEUTRAL);
    expect(reputationToRank(3000)).toBe(REP_FRIENDLY);
    expect(reputationToRank(-3001)).toBe(1);
    expect(reputationToRank(42999)).toBe(7);
    const entry = { id: 1, reputationListId: 0, baseRepRaceMask: [2, 0, 0, 0] as [number, number, number, number], baseRepClassMask: [0, 0, 0, 0] as [number, number, number, number], baseRepValue: [-42000, 0, 0, 0] as [number, number, number, number] };
    expect(baseReputation(entry, 2, 1)).toBe(-42000);
    expect(baseReputation(entry, 1, 1)).toBe(0);
  });

  test("loads factiontemplate_dbc from the world database", () => {
    const db = WorldTables.fromRows([
      [
        factiontemplate_dbc,
        [
          { ID: 14, Faction: 14, Flags: 0, FactionGroup: 8, FriendGroup: 0, EnemyGroup: 1 },
          { ID: 1, Faction: 1, Flags: 72, FactionGroup: 3, FriendGroup: 2, EnemyGroup: 12 },
        ],
      ],
    ]);
    const store = FactionStore.load(db);
    expect(store.template(14)?.hostileMask).toBe(1);
    expect(store.creatureToPlayer(14, { race: 1, classId: 1, factionTemplate: 1, reputation: () => null })).toBe(REP_HOSTILE);
  });
});
