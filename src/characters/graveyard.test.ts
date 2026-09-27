import { worldFromSql } from "../database/test-world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { describe, expect, test } from "bun:test";
import {
  ALLIANCE_DEFAULT_GRAVEYARD,
  FACTION_ALLIANCE,
  FACTION_ANY,
  FACTION_HORDE,
  getClosestGraveyard,
  getDefaultGraveyard,
  HORDE_DEFAULT_GRAVEYARD,
  loadGraveyardStore,
  TEAM_ALLIANCE,
  TEAM_HORDE,
  teamIdFromRace,
} from "./graveyard.ts";

function openWorldDb(): WorldTables {
  return WorldTables.fromRows();
}

function seedElwynn(db: WorldTables): void {
  worldFromSql(`
    INSERT INTO game_graveyard (ID, Map, x, y, z, Comment) VALUES
      (105, 0, -8935.33, -188.646, 80.4165, 'Elwynn Forest, Northshire'),
      (106, 0, -9339.46, 171.408, 61.5618, 'Elwynn Forest, Goldshire'),
      (854, 0, -9465.54, -1359.82, 47.1842, 'Elwynn Forest, Eastvale'),
      (${ALLIANCE_DEFAULT_GRAVEYARD}, 0, -10546.9, 1197.24, 31.7263, 'Westfall, Sentinel Hill'),
      (${HORDE_DEFAULT_GRAVEYARD}, 1, -592.601, -2523.49, 91.788, 'The Barrens, The Crossroads');

    INSERT INTO graveyard_zone (ID, GhostZone, Faction, Comment) VALUES
      (105, 12, ${FACTION_ALLIANCE}, 'Northshire Alliance'),
      (106, 12, ${FACTION_ALLIANCE}, 'Goldshire Alliance'),
      (854, 12, ${FACTION_ANY}, 'Eastvale Any'),
      (106, 717, ${FACTION_ANY}, 'Stockades entrance');
  `, db);
}

describe("graveyard", () => {
  test("teamIdFromRace maps Alliance and Horde races", () => {
    expect(teamIdFromRace(1)).toBe(TEAM_ALLIANCE);
    expect(teamIdFromRace(2)).toBe(TEAM_HORDE);
    expect(teamIdFromRace(11)).toBe(TEAM_ALLIANCE);
    expect(teamIdFromRace(10)).toBe(TEAM_HORDE);
  });

  test("filters enemy-faction graveyards and keeps neutral", () => {
    const db = openWorldDb();
    seedElwynn(db);
    const store = loadGraveyardStore(db);

    const alliance = getClosestGraveyard(store, {
      mapId: 0,
      x: -8900,
      y: -200,
      z: 80,
      teamId: TEAM_ALLIANCE,
      areaId: 0,
      zoneId: 12,
    });
    expect(alliance?.ID).toBe(105);

    const horde = getClosestGraveyard(store, {
      mapId: 0,
      x: -8900,
      y: -200,
      z: 80,
      teamId: TEAM_HORDE,
      areaId: 0,
      zoneId: 12,
    });
    expect(horde?.ID).toBe(854);
  });

  test("picks the closest same-map graveyard by 3D distance", () => {
    const db = openWorldDb();
    seedElwynn(db);
    const store = loadGraveyardStore(db);

    const nearGoldshire = getClosestGraveyard(store, {
      mapId: 0,
      x: -9340,
      y: 170,
      z: 62,
      teamId: TEAM_ALLIANCE,
      areaId: 0,
      zoneId: 12,
    });
    expect(nearGoldshire?.ID).toBe(106);

    const nearNorthshire = getClosestGraveyard(store, {
      mapId: 0,
      x: -8930,
      y: -190,
      z: 80,
      teamId: TEAM_ALLIANCE,
      areaId: 0,
      zoneId: 12,
    });
    expect(nearNorthshire?.ID).toBe(105);
  });

  test("prefers area link over zone when the area link is friendly", () => {
    const db = openWorldDb();
    seedElwynn(db);
    worldFromSql(`
      INSERT INTO game_graveyard (ID, Map, x, y, z, Comment) VALUES
        (999, 0, -9000, 0, 50, 'Area-only GY');
      INSERT INTO graveyard_zone (ID, GhostZone, Faction, Comment) VALUES
        (999, 87, ${FACTION_ALLIANCE}, 'Goldshire area');
    `, db);
    const store = loadGraveyardStore(db);

    const gy = getClosestGraveyard(store, {
      mapId: 0,
      x: -9000,
      y: 0,
      z: 50,
      teamId: TEAM_ALLIANCE,
      areaId: 87,
      zoneId: 12,
    });
    expect(gy?.ID).toBe(999);
  });

  test("falls back to default when zone has no graveyard links", () => {
    const db = openWorldDb();
    seedElwynn(db);
    const store = loadGraveyardStore(db);

    const alliance = getClosestGraveyard(store, {
      mapId: 0,
      x: 0,
      y: 0,
      z: 0,
      teamId: TEAM_ALLIANCE,
      areaId: 0,
      zoneId: 9999,
    });
    expect(alliance?.ID).toBe(ALLIANCE_DEFAULT_GRAVEYARD);
    expect(getDefaultGraveyard(store, TEAM_ALLIANCE)?.ID).toBe(ALLIANCE_DEFAULT_GRAVEYARD);

    const horde = getClosestGraveyard(store, {
      mapId: 1,
      x: 0,
      y: 0,
      z: 0,
      teamId: TEAM_HORDE,
      areaId: 0,
      zoneId: 9999,
    });
    expect(horde?.ID).toBe(HORDE_DEFAULT_GRAVEYARD);
  });

  test("returns null when no graveyard exists on an empty store", () => {
    const db = openWorldDb();
    const store = loadGraveyardStore(db);
    const gy = getClosestGraveyard(store, {
      mapId: 0,
      x: 0,
      y: 0,
      z: 0,
      teamId: TEAM_ALLIANCE,
      areaId: 0,
      zoneId: 12,
    });
    expect(gy).toBeNull();
  });

  test("uses entrance-map distance for off-map links when MapEntry is provided", () => {
    const db = openWorldDb();
    worldFromSql(`
      INSERT INTO game_graveyard (ID, Map, x, y, z, Comment) VALUES
        (1, 0, -9100, 400, 90, 'Near entrance'),
        (2, 0, -10000, -2000, 50, 'Far from entrance'),
        (${ALLIANCE_DEFAULT_GRAVEYARD}, 0, -10546.9, 1197.24, 31.7263, 'Westfall');
      INSERT INTO graveyard_zone (ID, GhostZone, Faction, Comment) VALUES
        (1, 717, ${FACTION_ANY}, 'Stockades'),
        (2, 717, ${FACTION_ANY}, 'Stockades far');
    `, db);
    const store = loadGraveyardStore(db);

    const gy = getClosestGraveyard(store, {
      mapId: 34,
      x: 50,
      y: 50,
      z: -10,
      teamId: TEAM_ALLIANCE,
      areaId: 0,
      zoneId: 717,
      mapEntry: {
        entrance_map: 0,
        entrance_x: -9100,
        entrance_y: 400,
      },
    });
    expect(gy?.ID).toBe(1);
  });
});
