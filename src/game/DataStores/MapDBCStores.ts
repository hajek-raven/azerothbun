/**
 * The map related functions of `DBCStores.cpp` and `DBCStructure.h` that the map layer calls: the `MapEntry` queries, the
 * `MapDifficulty` lookups built from `MapDifficulty.dbc`, the WMO area lookup built from `WMOAreaTable.dbc`, the liquid
 * flags, the default map light, and the battleground bracket lookups.
 *
 * The C++ fills `sMapDifficultyMap` and `sWMOAreaInfoByTripple` once in `LoadDBCStores`. Here they are built on first
 * use from the loaded stores and rebuilt when a store changes (`DBCStorage::set` in tests).
 */
import type { MapEntry, PvPDifficultyEntry, WMOAreaTableEntry } from "../../gen/DBCStructure.gen.ts";
import { sLightStore, sLiquidTypeStore, sMapDifficultyStore, sPvPDifficultyStore, sWMOAreaTableStore } from "./DBCStores.ts";
import { ServerConfig } from "../world/world-config-data.ts";
import { sWorld } from "../world/world.ts";

/** @ac shared/DataStores/DBCEnums.h MapTypes */
export const MAP_COMMON = 0; // none
export const MAP_INSTANCE = 1; // party
export const MAP_RAID = 2; // raid
export const MAP_BATTLEGROUND = 3; // pvp
export const MAP_ARENA = 4; // arena

/** @ac shared/DataStores/DBCEnums.h Difficulty */
export const REGULAR_DIFFICULTY = 0;
export const DUNGEON_DIFFICULTY_NORMAL = 0;
export const DUNGEON_DIFFICULTY_HEROIC = 1;
export const DUNGEON_DIFFICULTY_EPIC = 2;
export const RAID_DIFFICULTY_10MAN_NORMAL = 0;
export const RAID_DIFFICULTY_25MAN_NORMAL = 1;
export const RAID_DIFFICULTY_10MAN_HEROIC = 2;
export const RAID_DIFFICULTY_25MAN_HEROIC = 3;
/** since 25man difficulties are 1 and 3, we can check them like that */
export const RAID_DIFFICULTY_MASK_25MAN = 1;

/** @ac shared/DataStores/DBCStructure.h MapEntry::Expansion */
export function MapEntryExpansion(entry: MapEntry): number {
  return entry.expansionID;
}
/** @ac shared/DataStores/DBCStructure.h MapEntry::IsDungeon */
export function MapEntryIsDungeon(entry: MapEntry): boolean {
  return entry.map_type === MAP_INSTANCE || entry.map_type === MAP_RAID;
}
/** @ac shared/DataStores/DBCStructure.h MapEntry::IsNonRaidDungeon */
export function MapEntryIsNonRaidDungeon(entry: MapEntry): boolean {
  return entry.map_type === MAP_INSTANCE;
}
/** @ac shared/DataStores/DBCStructure.h MapEntry::Instanceable */
export function MapEntryInstanceable(entry: MapEntry): boolean {
  return entry.map_type === MAP_INSTANCE || entry.map_type === MAP_RAID || entry.map_type === MAP_BATTLEGROUND || entry.map_type === MAP_ARENA;
}
/** @ac shared/DataStores/DBCStructure.h MapEntry::IsRaid */
export function MapEntryIsRaid(entry: MapEntry): boolean {
  return entry.map_type === MAP_RAID;
}
/** @ac shared/DataStores/DBCStructure.h MapEntry::IsBattleground */
export function MapEntryIsBattleground(entry: MapEntry): boolean {
  return entry.map_type === MAP_BATTLEGROUND;
}
/** @ac shared/DataStores/DBCStructure.h MapEntry::IsBattleArena */
export function MapEntryIsBattleArena(entry: MapEntry): boolean {
  return entry.map_type === MAP_ARENA;
}
/** @ac shared/DataStores/DBCStructure.h MapEntry::IsBattlegroundOrArena */
export function MapEntryIsBattlegroundOrArena(entry: MapEntry): boolean {
  return entry.map_type === MAP_BATTLEGROUND || entry.map_type === MAP_ARENA;
}
/** @ac shared/DataStores/DBCStructure.h MapEntry::IsWorldMap */
export function MapEntryIsWorldMap(entry: MapEntry): boolean {
  return entry.map_type === MAP_COMMON;
}
/** @ac shared/DataStores/DBCStructure.h MapEntry::GetEntrancePos (the reference parameters are the result) */
export function MapEntryGetEntrancePos(entry: MapEntry): { mapid: number; x: number; y: number } | null {
  if (entry.entrance_map < 0) return null;
  return { mapid: entry.entrance_map, x: entry.entrance_x, y: entry.entrance_y };
}

/** @ac game/DataStores/DBCStores.h MapDifficulty */
export interface MapDifficulty {
  resetTime: number;
  maxPlayers: number;
  hasErrorMessage: boolean;
}

const MAKE_PAIR32 = (l: number, h: number): number => ((l & 0xffff) | ((h & 0xffff) << 16)) >>> 0;

let mapDifficultyMap: Map<number, MapDifficulty> | null = null;
let mapDifficultyKey = "";
let wmoAreaInfoByTripple: Map<string, WMOAreaTableEntry> | null = null;
let wmoAreaKey = "";

/** Forgets the maps built from the stores (the next lookup rebuilds them). */
export function resetMapDBCStores(): void {
  mapDifficultyMap = null;
  wmoAreaInfoByTripple = null;
}

function difficultyMap(): Map<number, MapDifficulty> {
  const key = `${sMapDifficultyStore.size}:${sMapDifficultyStore.getNumRows()}`;
  if (!mapDifficultyMap || mapDifficultyKey !== key) {
    mapDifficultyKey = key;
    mapDifficultyMap = new Map();
    // fill data (`LoadDBCStores`)
    for (const entry of sMapDifficultyStore) {
      mapDifficultyMap.set(MAKE_PAIR32(entry.MapId, entry.Difficulty), {
        resetTime: entry.resetTime,
        maxPlayers: entry.maxPlayers,
        hasErrorMessage: entry.areaTriggerText.length > 0 && entry.areaTriggerText.charAt(0) !== "\0",
      });
    }
  }
  return mapDifficultyMap;
}

/** @ac game/DataStores/DBCStores.cpp GetMapDifficultyData */
export function GetMapDifficultyData(mapId: number, difficulty: number): MapDifficulty | null {
  return difficultyMap().get(MAKE_PAIR32(mapId, difficulty)) ?? null;
}

/**
 * @ac game/DataStores/DBCStores.cpp GetDownscaledMapDifficultyData
 * The `Difficulty&` parameter is returned in `difficulty`.
 */
export function GetDownscaledMapDifficultyData(mapId: number, difficulty: number): { mapDiff: MapDifficulty | null; difficulty: number } {
  let tmpDiff = difficulty;

  let mapDiff = GetMapDifficultyData(mapId, tmpDiff);
  if (!mapDiff) {
    if (tmpDiff > RAID_DIFFICULTY_25MAN_NORMAL)
      // heroic, downscale to normal
      tmpDiff -= 2;
    // any non-normal mode for raids like tbc (only one mode)
    else tmpDiff -= 1;

    // pull new data
    mapDiff = GetMapDifficultyData(mapId, tmpDiff); // we are 10 normal or 25 normal
    if (!mapDiff) {
      tmpDiff -= 1;
      mapDiff = GetMapDifficultyData(mapId, tmpDiff); // 10 normal
    }
  }

  return { mapDiff, difficulty: tmpDiff & 0xff };
}

function wmoKey(rootid: number, adtid: number, groupid: number): string {
  // `WMOAreaTableKey(int16(rootid), int8(adtid), groupid)`
  return `${(rootid << 16) >> 16},${(adtid << 24) >> 24},${groupid | 0}`;
}

/** @ac game/DataStores/DBCStores.cpp GetWMOAreaTableEntryByTripple */
export function GetWMOAreaTableEntryByTripple(rootid: number, adtid: number, groupid: number): WMOAreaTableEntry | null {
  const key = `${sWMOAreaTableStore.size}:${sWMOAreaTableStore.getNumRows()}`;
  if (!wmoAreaInfoByTripple || wmoAreaKey !== key) {
    wmoAreaKey = key;
    wmoAreaInfoByTripple = new Map();
    for (const entry of sWMOAreaTableStore) wmoAreaInfoByTripple.set(wmoKey(entry.rootId, entry.adtId, entry.groupId), entry);
  }
  return wmoAreaInfoByTripple.get(wmoKey(rootid, adtid, groupid)) ?? null;
}

/** @ac game/DataStores/DBCStores.cpp IsSharedDifficultyMap */
export function IsSharedDifficultyMap(mapid: number): boolean {
  return sWorld().getBoolConfig(ServerConfig.CONFIG_INSTANCE_SHARED_ID) && (mapid === 631 || mapid === 724);
}

/** @ac game/DataStores/DBCStores.cpp GetLiquidFlags */
export function GetLiquidFlags(liquidType: number): number {
  const liq = sLiquidTypeStore.lookupEntry(liquidType);
  if (liq) return (1 << liq.Type) >>> 0;

  return 0;
}

/** @ac game/DataStores/DBCStores.cpp GetDefaultMapLight */
export function GetDefaultMapLight(mapId: number): number {
  for (let i = sLightStore.getNumRows(); i >= 0; --i) {
    const light = sLightStore.lookupEntry(i);
    if (!light) continue;

    if (light.MapId === mapId && light.X === 0.0 && light.Y === 0.0 && light.Z === 0.0) return light.Id;
  }

  return 0;
}

/** @ac game/DataStores/DBCStores.cpp GetBattlegroundBracketByLevel */
export function GetBattlegroundBracketByLevel(mapid: number, level: number): PvPDifficultyEntry | null {
  let maxEntry: PvPDifficultyEntry | null = null; // used for level > max listed level case

  for (const entry of sPvPDifficultyStore) {
    // skip unrelated and too-high brackets
    if (entry.mapId !== mapid || entry.minLevel > level) continue;

    // exactly fit
    if (entry.maxLevel >= level) return entry;

    // remember for possible out-of-range case (search higher from existed)
    if (!maxEntry || maxEntry.maxLevel < entry.maxLevel) maxEntry = entry;
  }

  return maxEntry;
}

/** @ac game/DataStores/DBCStores.cpp GetBattlegroundBracketById */
export function GetBattlegroundBracketById(mapid: number, id: number): PvPDifficultyEntry | null {
  for (const entry of sPvPDifficultyStore) if (entry.mapId === mapid && entry.bracketId === id) return entry;

  return null;
}
