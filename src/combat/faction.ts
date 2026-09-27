import { factiontemplate_dbc } from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import type { DbcRecord } from "../data/dbc.ts";
import { REP_FRIENDLY, REP_HOSTILE, REP_NEUTRAL, type ReputationRank } from "./constants.ts";

const FACTION_TEMPLATE_FLAG_RESPOND_TO_CALL_FOR_HELP = 0x0001;
const FACTION_TEMPLATE_FLAG_HATES_ALL_EXCEPT_FRIENDS = 0x2000;
/** `FACTION_FLAG_AT_WAR` on `character_reputation.flags`. */
const FACTION_FLAG_AT_WAR = 0x02;

/** `FactionTemplateEntry` from `factiontemplate_dbc`. */
export type FactionTemplate = {
  id: number;
  faction: number;
  flags: number;
  ourMask: number;
  friendlyMask: number;
  hostileMask: number;
  enemyFaction: [number, number, number, number];
  friendFaction: [number, number, number, number];
};

/** `FactionEntry` fields the reaction code reads (`Faction.dbc`). */
export type FactionEntry = {
  id: number;
  reputationListId: number;
  baseRepRaceMask: [number, number, number, number];
  baseRepClassMask: [number, number, number, number];
  baseRepValue: [number, number, number, number];
};

/** `FactionTemplateEntry::IsFriendlyTo` */
export function isFriendlyTo(self: FactionTemplate, other: FactionTemplate): boolean {
  if (self.faction === other.faction) {
    return true;
  }
  if (other.faction) {
    if (self.enemyFaction.includes(other.faction)) {
      return false;
    }
    if (self.friendFaction.includes(other.faction)) {
      return true;
    }
  }
  return (self.friendlyMask & other.ourMask) !== 0 || (self.ourMask & other.friendlyMask) !== 0;
}

/** `FactionTemplateEntry::IsHostileTo` */
export function isHostileTo(self: FactionTemplate, other: FactionTemplate): boolean {
  if (other.faction) {
    if (self.enemyFaction.includes(other.faction)) {
      return true;
    }
    if (self.friendFaction.includes(other.faction)) {
      return false;
    }
  }
  return (self.hostileMask & other.ourMask) !== 0;
}

/** `FactionTemplateEntry::IsNeutralToAll` */
export function isNeutralToAll(self: FactionTemplate): boolean {
  return self.enemyFaction.every((id) => id === 0) && self.hostileMask === 0 && self.friendlyMask === 0;
}

/** `FactionTemplateEntry::FactionRespondsToCallForHelp` */
export function respondsToCallForHelp(self: FactionTemplate): boolean {
  return (self.flags & FACTION_TEMPLATE_FLAG_RESPOND_TO_CALL_FOR_HELP) !== 0;
}

/** `Creature::UpdateMoveInLineOfSightState`: a template with no enemies never pulls by proximity. */
export function hasHostility(self: FactionTemplate): boolean {
  return self.hostileMask !== 0 || self.enemyFaction.some((id) => id !== 0);
}

/** `Unit::GetFactionReactionTo(FactionTemplateEntry const*, FactionTemplateEntry const*)` */
export function templateReaction(self: FactionTemplate | null, other: FactionTemplate | null): ReputationRank {
  if (!self || !other) {
    return REP_NEUTRAL;
  }
  if (isHostileTo(self, other)) {
    return REP_HOSTILE;
  }
  if (isFriendlyTo(self, other)) {
    return REP_FRIENDLY;
  }
  if (isFriendlyTo(other, self)) {
    return REP_FRIENDLY;
  }
  if (self.flags & FACTION_TEMPLATE_FLAG_HATES_ALL_EXCEPT_FRIENDS) {
    return REP_HOSTILE;
  }
  return REP_NEUTRAL;
}

const POINTS_IN_RANK = [36000, 3000, 3000, 3000, 6000, 12000, 21000, 1000];
const REPUTATION_CAP = 42999;

/** `ReputationMgr::ReputationToRank` */
export function reputationToRank(standing: number): ReputationRank {
  let limit = REPUTATION_CAP + 1;
  for (let rank = POINTS_IN_RANK.length - 1; rank >= 0; rank--) {
    limit -= POINTS_IN_RANK[rank]!;
    if (standing >= limit) {
      return rank as ReputationRank;
    }
  }
  return 0;
}

/** `ReputationMgr::GetBaseReputation` */
export function baseReputation(entry: FactionEntry, race: number, classId: number): number {
  const raceMask = 1 << (race - 1);
  const classMask = 1 << (classId - 1);
  for (let index = 0; index < 4; index++) {
    const raceOk = (entry.baseRepRaceMask[index]! & raceMask) !== 0 || (entry.baseRepRaceMask[index] === 0 && entry.baseRepClassMask[index] !== 0);
    const classOk = (entry.baseRepClassMask[index]! & classMask) !== 0 || entry.baseRepClassMask[index] === 0;
    if (raceOk && classOk) {
      return entry.baseRepValue[index]!;
    }
  }
  return 0;
}

/** Standing the player stored for one faction (`character_reputation`). */
export type PlayerReputation = { standing: number; flags: number };

export type ReactionPlayer = {
  race: number;
  classId: number;
  factionTemplate: number;
  reputation: (faction: number) => PlayerReputation | null;
};

export class FactionStore {
  private readonly templates = new Map<number, FactionTemplate>();
  private readonly factions = new Map<number, FactionEntry>();

  constructor(templates: Iterable<FactionTemplate> = [], factions: Iterable<FactionEntry> = []) {
    for (const row of templates) {
      this.templates.set(row.id, row);
    }
    for (const row of factions) {
      this.factions.set(row.id, row);
    }
  }

  static load(world: WorldTables | null, dbcFactions: readonly DbcRecord[] = []): FactionStore {
    const templates: FactionTemplate[] = [];
    // No factiontemplate_dbc rows: every reaction is neutral, like a missing template in AzerothCore.
    for (const row of world?.all(factiontemplate_dbc) ?? []) {
      templates.push({
        id: row.ID,
        faction: row.Faction,
        flags: row.Flags,
        ourMask: row.FactionGroup,
        friendlyMask: row.FriendGroup,
        hostileMask: row.EnemyGroup,
        enemyFaction: [row.Enemies_1, row.Enemies_2, row.Enemies_3, row.Enemies_4],
        friendFaction: [row.Friend_1, row.Friend_2, row.Friend_3, row.Friend_4],
      });
    }
    const factions: FactionEntry[] = [];
    for (const record of dbcFactions) {
      const num = (key: string): number => Number(record[key] ?? 0);
      factions.push({
        id: num("ID"),
        reputationListId: num("reputationListID"),
        baseRepRaceMask: [num("BaseRepRaceMask0"), num("BaseRepRaceMask1"), num("BaseRepRaceMask2"), num("BaseRepRaceMask3")],
        baseRepClassMask: [num("BaseRepClassMask0"), num("BaseRepClassMask1"), num("BaseRepClassMask2"), num("BaseRepClassMask3")],
        baseRepValue: [num("BaseRepValue0"), num("BaseRepValue1"), num("BaseRepValue2"), num("BaseRepValue3")],
      });
    }
    return new FactionStore(templates, factions);
  }

  template(id: number): FactionTemplate | null {
    return this.templates.get(id) ?? null;
  }

  /** `FactionEntry::CanHaveReputation` */
  private reputationFaction(templateId: number): FactionEntry | null {
    const template = this.template(templateId);
    if (!template) {
      return null;
    }
    const entry = this.factions.get(template.faction);
    return entry && entry.reputationListId >= 0 ? entry : null;
  }

  private playerRank(player: ReactionPlayer, entry: FactionEntry): { rank: ReputationRank; atWar: boolean } {
    const stored = player.reputation(entry.id);
    const standing = baseReputation(entry, player.race, player.classId) + (stored?.standing ?? 0);
    return { rank: reputationToRank(standing), atWar: ((stored?.flags ?? 0) & FACTION_FLAG_AT_WAR) !== 0 };
  }

  /** `Unit::GetReactionTo(creature → player)` through `GetFactionReactionTo(entry, Unit*)`. */
  creatureToPlayer(creatureTemplate: number, player: ReactionPlayer): ReputationRank {
    const self = this.template(creatureTemplate);
    if (!self) {
      return REP_NEUTRAL;
    }
    const entry = this.reputationFaction(creatureTemplate);
    if (entry) {
      const { rank, atWar } = this.playerRank(player, entry);
      return atWar ? (Math.min(REP_NEUTRAL, rank) as ReputationRank) : rank;
    }
    return templateReaction(self, this.template(player.factionTemplate));
  }

  /**
   * `Unit::GetReactionTo(player → creature)`. The player is `UNIT_FLAG_PLAYER_CONTROLLED` and the creature is not,
   * so only the faction template check applies.
   */
  playerToCreature(player: ReactionPlayer, creatureTemplate: number): ReputationRank {
    const self = this.template(player.factionTemplate);
    if (!self) {
      return REP_NEUTRAL;
    }
    return templateReaction(self, this.template(creatureTemplate));
  }

  creatureToCreature(left: number, right: number): ReputationRank {
    return templateReaction(this.template(left), this.template(right));
  }
}

/** `ChrRaces.dbc` `FactionID` for the playable races. */
export const RACE_FACTION_TEMPLATE = new Map<number, number>([
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 4],
  [5, 5],
  [6, 6],
  [7, 115],
  [8, 116],
  [10, 1610],
  [11, 1629],
]);
