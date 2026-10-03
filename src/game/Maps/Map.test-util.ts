/**
 * Helpers for the map tests: a `Map.dbc` row for a map id, the cell center of a cell index, a player linked into the map's
 * player list, and the recorder hooks. Not a test file itself.
 */
import { sMapStore } from "../DataStores/DBCStores.ts";
import type { MapEntry } from "../../gen/DBCStructure.gen.ts";
import { FakePlayer } from "../Grids/Grids.test-util.ts";
import { SIZE_OF_GRID_CELL } from "../Grids/GridDefines.ts";
import { MapReference } from "./MapReference.ts";
import { Map, type MapPlayer } from "./Map.ts";

/** `MapTypes` */
export const MAP_COMMON = 0;
export const MAP_INSTANCE = 1;
export const MAP_RAID = 2;
export const MAP_BATTLEGROUND = 3;
export const MAP_ARENA = 4;

/** A map id no extracted data exists for. */
export const TEST_MAP_ID = 900;

/** The x or y of the center of cell `c` (0..511; cell 256 is just west of the map center): `(256 - c - 0.5) * SIZE_OF_GRID_CELL`. */
export function cellCenter(c: number): number {
  return (256 - c - 0.5) * SIZE_OF_GRID_CELL;
}

/** Registers a `Map.dbc` row (the store is global, so a test registers the ids it uses). */
export function setMapEntry(mapId: number, mapType: number, extra: Partial<MapEntry> = {}): MapEntry {
  const entry: MapEntry = {
    MapID: mapId,
    map_type: mapType,
    Flags: 0,
    name: [`Test map ${mapId}`, "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    linked_zone: 0,
    multimap_id: 0,
    entrance_map: -1,
    entrance_x: 0,
    entrance_y: 0,
    expansionID: 0,
    maxPlayers: 0,
    ...extra,
  };
  sMapStore.set(mapId, entry);
  return entry;
}

/** A player that is set on the map and linked into its player list (what `Player::SetMap` does), not yet added to the grid. */
export function playerOn(map: Map, guidLow: number, x: number, y: number, z = 0): FakePlayer & { mapRef: MapReference<MapPlayer> } {
  const player = new FakePlayer(guidLow, x, y, z) as FakePlayer & { mapRef: MapReference<MapPlayer> };
  player.setMap(map);
  player.mapRef = new MapReference<MapPlayer>();
  player.mapRef.link(map, player);
  (player as unknown as { getMapRef(): MapReference<MapPlayer> }).getMapRef = () => player.mapRef;
  return player;
}
