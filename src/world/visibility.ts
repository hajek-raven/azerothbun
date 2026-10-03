/**
 * The visibility distance of a map for the code that has only a map id (`Map::GetVisibilityRange`): the range of the map when
 * it is a world map that exists, else the `Visibility.Distance.*` option of its type (`Map::InitVisibilityDistance`,
 * `InstanceMap::InstanceMap`, `BattlegroundMap::BattlegroundMap`).
 */
import { sMapStore } from "../game/DataStores/DBCStores.ts";
import { MAP_ARENA, MAP_BATTLEGROUND, MAP_INSTANCE, MAP_RAID } from "../game/DataStores/MapDBCStores.ts";
import { MapHooks } from "../game/Maps/Map.ts";
import { sMapMgr } from "../game/Maps/MapMgr.ts";

export function visibilityDistance(mapId: number): number {
  const map = sMapMgr().findBaseMap(mapId);
  if (map && !map.instanceable()) return map.getVisibilityRange();

  switch (sMapStore.lookupEntry(mapId)?.map_type) {
    case MAP_INSTANCE:
    case MAP_RAID:
      return MapHooks.getMaxVisibleDistanceInInstances();
    case MAP_BATTLEGROUND:
    case MAP_ARENA:
      return MapHooks.getMaxVisibleDistanceInBGArenas();
    default:
      return MapHooks.getMaxVisibleDistanceOnContinents();
  }
}
