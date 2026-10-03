/**
 * The map data side of a `WorldSession`'s player: the map it stands on, the terrain status of its position (zone, area,
 * outdoors), the host `PlayerAreaUpdates` reads and writes, and the min height check of the map.
 */
import { PLAYER_EXPLORED_ZONES_SIZE, type PlayerAreaHost, type PlayerTerrainStatus } from "../game/Entities/Player/PlayerUpdates.ts";
import { sAreaTableStore } from "../game/DataStores/DBCStores.ts";
import { DEFAULT_COLLISION_HEIGHT } from "../game/Entities/Object/ObjectDefines.ts";
import type { Map } from "../game/Maps/Map.ts";
import { getTerrainMap } from "../game/Maps/MapMgr.ts";
import { PLAYER_EXPLORED_ZONES_1, UNIT_FIELD_BYTES_2 } from "../gen/UpdateFields.gen.ts";
import { teamIdFromRace } from "../characters/graveyard.ts";
import { logError } from "../log.ts";
import type { WorldSession } from "./session.ts";

/**
 * The map whose terrain the player's position is read from (`getTerrainMap`). Null when `Map.dbc` has no row for the map id
 * or the map cannot be created.
 */
export function terrainMapOf(mapId: number, instanceId = 0): Map | null {
  try {
    return getTerrainMap(mapId, instanceId);
  } catch (error) {
    logError("maps", `terrain map ${mapId} is not available`, error);
    return null;
  }
}

/** `WorldObject::UpdatePositionData` for a player at a place: the area, its zone, and whether it is outdoors. */
export function terrainStatusAt(mapId: number, phaseMask: number, x: number, y: number, z: number): PlayerTerrainStatus | null {
  const map = terrainMapOf(mapId);
  if (!map) return null;

  const status = map.getFullTerrainStatusForPosition(phaseMask, x, y, z, DEFAULT_COLLISION_HEIGHT);
  // `WorldObject::ProcessPositionDataChanged`: the zone of an area is its parent zone
  const area = sAreaTableStore.lookupEntry(status.areaId);
  const zoneid = area && area.zone ? area.zone : status.areaId;
  return { zoneid, areaid: status.areaId, outdoors: status.outdoors };
}

/** The map the session's player is on (`Player::GetMap`), else the terrain map of its map id. */
export function playerTerrainMap(session: WorldSession): Map | null {
  const onMap = session.mapPlayer?.isInWorld() ? (session.mapPlayer.findMap() as Map | null) : null;
  if (onMap) return onMap;
  const character = session.character;
  return character ? terrainMapOf(character.map) : null;
}

/**
 * The terrain status at the session's player position: the position data of its map object (`WorldObject::GetZoneAndAreaId`
 * and `IsOutdoors`, read again at each `Map::PlayerRelocation`), or the map data at the character's position when it is on no map.
 */
export function terrainStatusOf(session: WorldSession): PlayerTerrainStatus | null {
  const character = session.character;
  if (!character) return null;
  const player = session.mapPlayer;
  if (player?.isInWorld()) return { zoneid: player.getZoneId(), areaid: player.getAreaId(), outdoors: player.isOutdoors() };
  return terrainStatusAt(character.map, session.playerFacade?.getPhaseMask() ?? 1, character.position_x, character.position_y, character.position_z);
}

/**
 * The zone and area the player's update runs with: the map data's, or - where the server has none for the place (the map
 * files are not extracted, or `Map.dbc` has no row) - the zone the character is stored in and no area, so the zone updates
 * (world states, rest flags) still happen and nothing is explored.
 */
export function areaStatusOf(session: WorldSession): PlayerTerrainStatus | null {
  const status = terrainStatusOf(session);
  if (status && status.zoneid) return status;
  const zone = session.character?.zone ?? 0;
  return zone ? { zoneid: zone, areaid: 0, outdoors: status?.outdoors ?? true } : null;
}

/** The `PlayerAreaHost` of a session: its character row, its stats fields, and its packets. */
export function createAreaHost(session: WorldSession): PlayerAreaHost {
  const character = (): NonNullable<WorldSession["character"]> => {
    if (!session.character) throw new Error("the player has left the world");
    return session.character;
  };
  const setByteFlag = (offset: number, flag: number, on: boolean): void => {
    const stats = session.stats;
    if (!stats) return;
    const shift = offset * 8;
    const bytes2 = stats.getUInt32(UNIT_FIELD_BYTES_2);
    const next = on ? bytes2 | (flag << shift) : bytes2 & ~(flag << shift);
    if (next >>> 0 !== bytes2) stats.setUInt32(UNIT_FIELD_BYTES_2, next >>> 0);
  };
  return {
    getTerrainStatus: () => areaStatusOf(session),
    getMapId: () => character().map,
    getName: () => character().name,
    getGUIDString: () => `Player (${character().guid})`,
    getPosition: () => ({ x: character().position_x, y: character().position_y, z: character().position_z }),
    getLevel: () => character().level,
    getTeamId: () => teamIdFromRace(character().race),
    isAlive: () => session.deathState === "alive" && session.health > 0,
    isInFlight: () => session.playerFacade?.isInFlight() ?? false,
    getExploredZonesField: (offset) => session.stats?.getUInt32(PLAYER_EXPLORED_ZONES_1 + offset) ?? 0,
    setExploredZonesField: (offset, value) => {
      if (offset < PLAYER_EXPLORED_ZONES_SIZE) session.playerFacade?.setUInt32Value(PLAYER_EXPLORED_ZONES_1 + offset, value);
    },
    setZone: (zone) => {
      character().zone = zone;
    },
    giveExplorationXp: (xp) => {
      for (const packet of session.grantXp(xp, null)) session.sendPacket(packet.opcode, packet.body);
    },
    sendPacket: (opcode, body) => session.sendPacket(opcode, body),
    setResting: (resting) => session.playerFacade?.setRestingFlag(resting),
    setSanctuaryFlag: (on) => setByteFlag(1, 0x08 /* UNIT_BYTE2_FLAG_SANCTUARY */, on),
    updateOutdoorsAuras: (isOutdoor) => session.unit?.updateOutdoorsAuras(isOutdoor),
    // `Map::SendZoneDynamicInfo`: the music, weather, and light the zone was given
    // @ac-skip Weather::SendFineWeatherUpdateToPlayer: no weather is ported, so there is none to clear
    sendZoneDynamicInfo: (zone) => {
      const player = session.mapPlayer;
      if (player?.isInWorld()) player.theMap().sendZoneDynamicInfo(zone, player);
    },
    updatePlayerZoneStats: (oldZone, newZone) => {
      const player = session.mapPlayer;
      if (player?.isInWorld()) player.theMap().updatePlayerZoneStats(oldZone, newZone);
    },
  };
}

/** `GetPositionZ() < GetMap()->GetMinHeight(GetPositionX(), GetPositionY())` for the session's player. */
export function isBelowMap(session: WorldSession): boolean {
  const character = session.character;
  if (!character) return false;
  const map = playerTerrainMap(session);
  return !!map && character.position_z < map.getMinHeight(character.position_x, character.position_y);
}
