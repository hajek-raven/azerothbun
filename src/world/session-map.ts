/**
 * What a `WorldSession` does with its player's place on a map: put it on the map it stands on (`MapMgr::CreateMap`,
 * `Player::SetMap`, `Map::AddPlayerToMap`), take it off (`Map::RemovePlayerFromMap`), move it (`Map::PlayerRelocation`), and
 * show the world to it (`Player::UpdateVisibilityForPlayer`).
 *
 * @ac game/Entities/Player/Player.cpp Player::SetMap, Player::ResetMap, Player::TeleportTo (the map part)
 * @ac game/Handlers/MovementHandler.cpp WorldSession::HandleMoveWorldportAckOpcode (the map part)
 */
import { sMapStore } from "../game/DataStores/DBCStores.ts";
import { sMapMgr } from "../game/Maps/MapMgr.ts";
import type { Map } from "../game/Maps/Map.ts";
import { CAN_ENTER } from "../game/Maps/Map.ts";
import { logError } from "../log.ts";
import { SessionMapPlayer } from "./session-map-player.ts";
import type { WorldSession } from "./session.ts";

/**
 * The player goes on the map of its character row. Returns false (and logs) when no map takes it: no `Map.dbc` row, an
 * instance that denies it, or invalid coordinates; the player is then in the world without a map (no visibility).
 */
export function addToMap(session: WorldSession): boolean {
  const character = session.character;
  if (!character) return false;

  const player = (session.mapPlayer ??= new SessionMapPlayer(session));
  player.syncIdentity();
  if (player.isInWorld()) return true;

  if (!sMapStore.lookupEntry(character.map)) {
    logError("maps", `Player ${character.name} (${character.guid}) is on map ${character.map}, which has no row in Map.dbc: it has no map.`);
    return false;
  }

  try {
    // `MapMgr::PlayerCannotEnter`: a dungeon that denies the player
    const denied = sMapMgr().playerCannotEnter(character.map, player, true);
    if (denied !== CAN_ENTER) {
      logError("maps", `Player ${character.name} (${character.guid}) cannot enter map ${character.map} (state ${denied}).`);
      return false;
    }

    const map = sMapMgr().createMap(character.map, player);
    if (!map) {
      logError("maps", `Player ${character.name} (${character.guid}) is on map ${character.map}, which has no map for it.`);
      return false;
    }

    if (player.findMap()) player.resetMap();
    // `Player::SetMap`
    player.setMap(map);
    player.getMapRef().link(map, player);

    if (!map.addPlayerToMap(player)) {
      player.getMapRef().unlink();
      player.resetMap();
      return false;
    }
    return true;
  } catch (error) {
    logError("maps", `Player ${character.name} (${character.guid}) could not be added to map ${character.map}`, error);
    return false;
  }
}

/** `Map::RemovePlayerFromMap(player, remove)` and the unlink from the map (`Player::ResetMap`). */
export function removeFromMap(session: WorldSession, remove: boolean): void {
  const player = session.mapPlayer;
  if (!player) return;

  const map = player.findMap() as Map | null;
  if (!map) return;

  try {
    map.removePlayerFromMap(player, remove);
  } catch (error) {
    logError("maps", `Player ${session.character?.name ?? "?"} could not be removed from map ${map.getId()}`, error);
  }
  if (player.findMap()) player.resetMap();
  player.getMapRef().unlink();
  map.afterPlayerUnlinkFromMap();
}

/** `Map::PlayerRelocation` to the position of the character row: the cell, the terrain data, and the visibility update. */
export function relocateOnMap(session: WorldSession): void {
  const character = session.character;
  const player = session.mapPlayer;
  if (!character || !player?.isInWorld()) return;

  player.theMap().playerRelocation(player, character.position_x, character.position_y, character.position_z, character.orientation);
}

/**
 * `Player::UpdateVisibilityForPlayer(true)` (the gameobjects and the far visible objects) and the relocation notifier (the
 * creatures and the players, which `Unit::ExecuteDelayedUnitRelocationEvent` runs after the visibility delay): what the
 * player sees at the place it stands, now.
 */
export function showWorld(session: WorldSession): void {
  const player = session.mapPlayer;
  if (!player?.isInWorld()) return;

  player.updateVisibilityForPlayer(true);
  player.executeDelayedUnitRelocationEvent();
}
