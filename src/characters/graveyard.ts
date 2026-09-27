import { game_graveyard, graveyard_zone } from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";

/** AzerothCore `TeamId` (`SharedDefines.h`). */
export const TEAM_ALLIANCE = 0;
export const TEAM_HORDE = 1;
export const TEAM_NEUTRAL = 2;

/** AzerothCore `Team` / `graveyard_zone.Faction` values. */
export const FACTION_ANY = 0;
export const FACTION_HORDE = 67;
export const FACTION_ALLIANCE = 469;

/** Default graveyards when a zone has no link (`Graveyard::GetDefaultGraveyard`). */
export const HORDE_DEFAULT_GRAVEYARD = 10;
export const ALLIANCE_DEFAULT_GRAVEYARD = 4;

/** Death Knight-only safe locs skipped for non-DKs (`GameGraveyard.cpp`). */
export const GRAVEYARD_EBON_HOLD = 1369;
export const GRAVEYARD_ARCHERUS = 1405;

const ALLIANCE_RACES = new Set([1, 3, 4, 7, 11]);

export type TeamId = typeof TEAM_ALLIANCE | typeof TEAM_HORDE | typeof TEAM_NEUTRAL;

export type GraveyardStruct = {
  ID: number;
  Map: number;
  x: number;
  y: number;
  z: number;
  Comment: string | null;
};

export type GraveyardZoneLink = {
  ID: number;
  GhostZone: number;
  Faction: number;
  Comment: string | null;
};

export type GraveyardData = {
  safeLocId: number;
  teamId: TeamId;
};

export type MapEntrance = {
  entrance_map: number;
  entrance_x: number;
  entrance_y: number;
  isBattlegroundOrArena?: boolean;
};

export type ClosestGraveyardQuery = {
  mapId: number;
  x: number;
  y: number;
  z: number;
  teamId: TeamId;
  areaId: number;
  zoneId: number;
  isDeathKnight?: boolean;
  /** Optional Map.dbc entrance fields for instance → continent selection. */
  mapEntry?: MapEntrance | null;
};

export type GraveyardTeleport = {
  map: number;
  x: number;
  y: number;
  z: number;
  o: number;
};

export type GraveyardStore = {
  byId: Map<number, GraveyardStruct>;
  /** GhostZone / area → linked graveyards (same multimap as C++ `GraveyardStore`). */
  byZone: Map<number, GraveyardData[]>;
};

export function teamIdFromRace(race: number): TeamId {
  return ALLIANCE_RACES.has(race) ? TEAM_ALLIANCE : TEAM_HORDE;
}

export function teamIdFromFaction(faction: number): TeamId {
  if (faction === FACTION_ANY) {
    return TEAM_NEUTRAL;
  }
  if (faction === FACTION_ALLIANCE) {
    return TEAM_ALLIANCE;
  }
  return TEAM_HORDE;
}

export function isNeutralOrFriendlyToTeam(linkTeamId: TeamId, playerTeamId: TeamId): boolean {
  return linkTeamId === TEAM_NEUTRAL || playerTeamId === TEAM_NEUTRAL || linkTeamId === playerTeamId;
}

export function loadGraveyardStore(db: WorldTables): GraveyardStore {
  const byId = new Map<number, GraveyardStruct>();
  const rows: readonly GraveyardStruct[] = db.all(game_graveyard);
  for (const row of rows) {
    byId.set(row.ID, row);
  }

  const byZone = new Map<number, GraveyardData[]>();
  const links: readonly GraveyardZoneLink[] = db.all(graveyard_zone);
  for (const link of links) {
    if (!byId.has(link.ID)) {
      continue;
    }
    const teamId = teamIdFromFaction(link.Faction);
    const list = byZone.get(link.GhostZone) ?? [];
    if (list.some((entry) => entry.safeLocId === link.ID)) {
      continue;
    }
    list.push({ safeLocId: link.ID, teamId });
    byZone.set(link.GhostZone, list);
  }

  return { byId, byZone };
}

export function getGraveyard(store: GraveyardStore, id: number): GraveyardStruct | null {
  return store.byId.get(id) ?? null;
}

export function getDefaultGraveyard(store: GraveyardStore, teamId: TeamId): GraveyardStruct | null {
  const id = teamId === TEAM_HORDE ? HORDE_DEFAULT_GRAVEYARD : ALLIANCE_DEFAULT_GRAVEYARD;
  return getGraveyard(store, id);
}

/**
 * `Graveyard::GetClosestGraveyard(mapId, x, y, z, teamId, areaId, zoneId, isDeathKnight)`.
 * Returns null only when no candidate exists (e.g. empty test DB without defaults).
 */
export function getClosestGraveyard(store: GraveyardStore, query: ClosestGraveyardQuery): GraveyardStruct | null {
  const { mapId, x, y, z, teamId, areaId, zoneId, isDeathKnight = false, mapEntry = null } = query;

  if (!zoneId && !areaId) {
    if (z > -500) {
      return getDefaultGraveyard(store, teamId);
    }
  }

  let range = linksForZone(store, areaId);
  if (range.length === 0) {
    range = linksForZone(store, zoneId);
  } else {
    const first = range[0]!;
    if (!isNeutralOrFriendlyToTeam(first.teamId, teamId)) {
      range = linksForZone(store, zoneId);
    }
  }

  const isBg = mapEntry?.isBattlegroundOrArena === true;
  if (range.length === 0 && !isBg) {
    return getDefaultGraveyard(store, teamId);
  }

  let foundNear = false;
  let distNear = 10000;
  let entryNear: GraveyardStruct | null = null;

  let foundEntr = false;
  let distEntr = 10000;
  let entryEntr: GraveyardStruct | null = null;

  let entryFar: GraveyardStruct | null = null;

  for (const graveyardLink of range) {
    const entry = getGraveyard(store, graveyardLink.safeLocId);
    if (!entry) {
      continue;
    }
    if (!isNeutralOrFriendlyToTeam(graveyardLink.teamId, teamId)) {
      continue;
    }
    if (
      !isDeathKnight &&
      (graveyardLink.safeLocId === GRAVEYARD_EBON_HOLD || graveyardLink.safeLocId === GRAVEYARD_ARCHERUS)
    ) {
      continue;
    }

    if (mapId !== entry.Map) {
      if (
        !mapEntry ||
        mapEntry.entrance_map < 0 ||
        mapEntry.entrance_map !== entry.Map ||
        (mapEntry.entrance_x === 0 && mapEntry.entrance_y === 0)
      ) {
        entryFar = entry;
        continue;
      }

      const dist2 =
        (entry.x - mapEntry.entrance_x) * (entry.x - mapEntry.entrance_x) +
        (entry.y - mapEntry.entrance_y) * (entry.y - mapEntry.entrance_y);
      if (foundEntr) {
        if (dist2 < distEntr) {
          distEntr = dist2;
          entryEntr = entry;
        }
      } else {
        foundEntr = true;
        distEntr = dist2;
        entryEntr = entry;
      }
    } else {
      const dist2 =
        (entry.x - x) * (entry.x - x) + (entry.y - y) * (entry.y - y) + (entry.z - z) * (entry.z - z);
      if (foundNear) {
        if (dist2 < distNear) {
          distNear = dist2;
          entryNear = entry;
        }
      } else {
        foundNear = true;
        distNear = dist2;
        entryNear = entry;
      }
    }
  }

  if (entryNear) {
    return entryNear;
  }
  if (entryEntr) {
    return entryEntr;
  }
  return entryFar;
}

/** Build the teleport destination RepopAtGraveyard would use (caller sends teleport). */
export function graveyardTeleport(
  graveyard: GraveyardStruct,
  orientation: number,
): GraveyardTeleport {
  return {
    map: graveyard.Map,
    x: graveyard.x,
    y: graveyard.y,
    z: graveyard.z,
    o: orientation,
  };
}

function linksForZone(store: GraveyardStore, zoneOrArea: number): GraveyardData[] {
  if (!zoneOrArea) {
    return [];
  }
  return store.byZone.get(zoneOrArea) ?? [];
}
