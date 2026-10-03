/**
 * @ac game/Entities/Player/PlayerUpdates.cpp (Player::UpdateZone, UpdateArea, the zone update timer of Player::Update, and
 * the zone part of Player::UpdatePosition)
 * @ac game/Entities/Player/Player.cpp Player::CheckAreaExploreAndOutdoor, Player::SendInitWorldStates
 *
 * The player's zone and area state: the zone and area ids come from the map data (`Map::GetZoneAndAreaId`), the explored
 * zone bits and the exploration experience from `AreaTable.dbc`, and the rest, PvP, and sanctuary flags from the area flags.
 * The player itself lives on `WorldSession`; `PlayerAreaHost` is the part of it this reads and writes.
 *
 * @ac-skip game/Entities/Player/PlayerUpdates.cpp Player::UpdateZone: `sOutdoorPvPMgr`, `sWorldState`, `sBattlefieldMgr`,
 * guild member data, the group update flag, `UpdateLocalChannels` (channels), `DestroyZoneLimitedItem`,
 * `AutoUnequipOffhandIfNeed`, `UpdatePvPState`, and `sScriptMgr->OnPlayerUpdateZone`: none of those systems is ported.
 * @ac-skip game/Entities/Player/PlayerUpdates.cpp Player::UpdateArea: `InstanceScript::OnPlayerAreaUpdate`, `UpdateFFAPvPState`,
 * the sanctuary combat stop, `UpdateAreaDependentAuras` and `UpdateZoneDependentAuras` (`spell_area` is not loaded).
 * @ac-skip game/Entities/Player/Player.cpp Player::CheckAreaExploreAndOutdoor: `UpdateAchievementCriteria` (achievements) and
 * `sScriptMgr->OnPlayerCanAreaExploreAndOutdoor` / `OnPlayerGiveXP`.
 * @ac-skip game/Entities/Player/Player.cpp Player::SendInitWorldStates: the zone specific states of the outdoor PvP zones,
 * the battlegrounds, the battlefields, and instances, and the arena season (`ArenaSeasonMgr` is not ported); the states
 * every zone gets are sent.
 */
import { buildExplorationExperience, SMSG_EXPLORATION_EXPERIENCE } from "../../../characters/experience.ts";
import { ByteWriter } from "../../../net/byte-buffer.ts";
import { PLAYER_EXPLORED_ZONES_1 } from "../../../gen/UpdateFields.gen.ts";
import { log, logError } from "../../../log.ts";
import { sAreaTableStore } from "../../DataStores/DBCStores.ts";
import { sObjectMgr } from "../../Globals/ObjectMgr.ts";
import { MAP_OUTLAND } from "../../Maps/AreaDefines.ts";
import { ServerConfig } from "../../world/world-config-data.ts";
import { sWorld } from "../../world/world.ts";

/** @ac game/Entities/Player/Player.h ZONE_UPDATE_INTERVAL (1 * IN_MILLISECONDS) */
export const ZONE_UPDATE_INTERVAL = 1000;

/** @ac game/Entities/Player/Player.h PLAYER_EXPLORED_ZONES_SIZE */
export const PLAYER_EXPLORED_ZONES_SIZE = 128;

/** @ac shared/DataStores/DBCEnums.h AreaFlags (the ones this reads) */
export const AREA_FLAG_ARENA = 0x00000080;
export const AREA_FLAG_CAPITAL = 0x00000100;
export const AREA_FLAG_SANCTUARY = 0x00000800;
export const AREA_FLAG_REST_ZONE_HORDE = 0x00400000;
export const AREA_FLAG_REST_ZONE_ALLIANCE = 0x00800000;
export const AREA_FLAG_WINTERGRASP = 0x01000000;

/** @ac shared/DataStores/DBCEnums.h AreaTeams */
export const AREATEAM_NONE = 0;
export const AREATEAM_ALLY = 2;
export const AREATEAM_HORDE = 4;

/** @ac shared/SharedDefines.h TeamId */
const TEAM_ALLIANCE = 0;
const TEAM_HORDE = 1;

/** @ac game/Entities/Player/Player.h RestFlag */
export const REST_FLAG_IN_TAVERN = 0x1;
export const REST_FLAG_IN_CITY = 0x2;
export const REST_FLAG_IN_FACTION_AREA = 0x4;

/** @ac game/Entities/Unit/UnitDefines.h UnitBytes2Flags */
export const UNIT_BYTE2_FLAG_SANCTUARY = 0x08;

/** @ac game/Maps/AreaDefines.h MAP_EBON_HOLD */
const MAP_EBON_HOLD = 609;

/** @ac shared/DataStores/DBCStructure.h AreaTableEntry::IsSanctuary */
export function isSanctuary(area: { mapid: number; flags: number }): boolean {
  if (area.mapid === MAP_EBON_HOLD) return true;
  return (area.flags & AREA_FLAG_SANCTUARY) !== 0;
}

/** @ac game/World/WorldStateDefines.h (the world states every zone gets in `Player::SendInitWorldStates`) */
const WORLD_STATE_SCOURGE_INVASION_WINTERSPRING = 2259;
const WORLD_STATE_SCOURGE_INVASION_AZSHARA = 2260;
const WORLD_STATE_SCOURGE_INVASION_BLASTED_LANDS = 2261;
const WORLD_STATE_SCOURGE_INVASION_BURNING_STEPPES = 2262;
const WORLD_STATE_SCOURGE_INVASION_TANARIS = 2263;
const WORLD_STATE_SCOURGE_INVASION_EASTERN_PLAGUELANDS = 2264;
const WORLD_STATE_ARENA_SEASON_PROGRESS = 3191;
const WORLD_STATE_ARENA_SEASON_ID = 3901;
const WORLD_STATE_OPVP_NA_UI_GUARDS_LEFT = 2491;
const WORLD_STATE_OPVP_NA_UI_GUARDS_MAX = 2493;
const WORLD_STATE_OPVP_NA_UI_TOWER_SLIDER_DISPLAY = 2495;

/** @ac game/Server/Opcodes.h SMSG_INIT_WORLD_STATES */
export const SMSG_INIT_WORLD_STATES = 0x2c2;

/**
 * @ac game/Entities/Player/Player.cpp Player::SendInitWorldStates (the `SMSG_INIT_WORLD_STATES` body)
 * `uint32 mapId, uint32 zoneId, uint32 areaId, uint16 count`, then `uint32 state, uint32 value` pairs.
 */
export function buildInitWorldStates(mapId: number, zoneId: number, areaId: number): Uint8Array {
  const states: [number, number][] = [
    [WORLD_STATE_SCOURGE_INVASION_WINTERSPRING, 0],
    [WORLD_STATE_SCOURGE_INVASION_AZSHARA, 0],
    [WORLD_STATE_SCOURGE_INVASION_BLASTED_LANDS, 0],
    [WORLD_STATE_SCOURGE_INVASION_BURNING_STEPPES, 0],
    [WORLD_STATE_SCOURGE_INVASION_TANARIS, 0],
    [WORLD_STATE_SCOURGE_INVASION_EASTERN_PLAGUELANDS, 0],
    // 7 1 - Arena season in progress, 0 - end of season; 8 Arena season id (@ac-skip ArenaSeasonMgr)
    [WORLD_STATE_ARENA_SEASON_PROGRESS, 0],
    [WORLD_STATE_ARENA_SEASON_ID, 0],
  ];
  if (mapId === MAP_OUTLAND) {
    states.push([WORLD_STATE_OPVP_NA_UI_TOWER_SLIDER_DISPLAY, 0], [WORLD_STATE_OPVP_NA_UI_GUARDS_MAX, 15], [WORLD_STATE_OPVP_NA_UI_GUARDS_LEFT, 15]);
  }

  const packet = new ByteWriter().writeU32(mapId).writeU32(zoneId).writeU32(areaId).writeU16(states.length);
  for (const [state, value] of states) packet.writeU32(state).writeU32(value);
  return packet.toUint8Array();
}

/** The terrain status of the player's position (`WorldObject::GetZoneAndAreaId`, `IsOutdoors`). */
export interface PlayerTerrainStatus {
  zoneid: number;
  areaid: number;
  outdoors: boolean;
}

/** What `PlayerAreaUpdates` reads and writes on the player. */
export interface PlayerAreaHost {
  /** The zone, area, and outdoors state at the player's position; null while the player has no map data. */
  getTerrainStatus(): PlayerTerrainStatus | null;
  getMapId(): number;
  getName(): string;
  getGUIDString(): string;
  getPosition(): { x: number; y: number; z: number };
  getLevel(): number;
  /** `Player::GetTeamId(true)` */
  getTeamId(): number;
  isAlive(): boolean;
  isInFlight(): boolean;
  /** `PLAYER_EXPLORED_ZONES_1 + offset` */
  getExploredZonesField(offset: number): number;
  setExploredZonesField(offset: number, value: number): void;
  /** The zone the character row stores (`characters.zone`) */
  setZone(zone: number): void;
  /** `Player::GiveXP(xp, nullptr)` then the packets it produced to the client */
  giveExplorationXp(xp: number): void;
  sendPacket(opcode: number, body: Uint8Array): void;
  /** `Player::SetPlayerFlag(PLAYER_FLAGS_RESTING)` side of `SetRestFlag` / `RemoveRestFlag` */
  setResting(resting: boolean): void;
  /** `UNIT_FIELD_BYTES_2` byte 1 flag (`SetByteFlag` / `RemoveByteFlag`) */
  setSanctuaryFlag(on: boolean): void;
  /** `Unit::RemoveAura` / `HandleAllEffects` for `SPELL_ATTR0_ONLY_INDOORS` and `SPELL_ATTR0_ONLY_OUTDOORS` spells */
  updateOutdoorsAuras(isOutdoor: boolean): void;
  /** Called after `UpdateZone` when the zone changed: weather and the zone's dynamic info of the map. */
  sendZoneDynamicInfo?(zone: number): void;
  /** `Map::UpdatePlayerZoneStats(oldZone, newZone)` */
  updatePlayerZoneStats?(oldZone: number, newZone: number): void;
}

/** @ac game/Entities/Player/Player.h PvPInfo */
export interface PvPInfo {
  IsInHostileArea: boolean;
  IsInNoPvPArea: boolean;
  IsInFFAPvPArea: boolean;
  IsHostile: boolean;
}

/** The zone and area state of one player (`m_zoneUpdateId`, `m_areaUpdateId`, `m_zoneUpdateTimer`, `m_needZoneUpdate`, ...). */
export class PlayerAreaUpdates {
  /** @ac game/Entities/Player/Player.h Player::m_zoneUpdateId */
  zoneUpdateId = 0xffffffff;
  /** @ac game/Entities/Player/Player.h Player::m_areaUpdateId */
  areaUpdateId = 0;
  /** @ac game/Entities/Player/Player.h Player::m_zoneUpdateTimer */
  zoneUpdateTimer = 0;
  /** @ac game/Entities/Player/Player.h Player::m_needZoneUpdate */
  needZoneUpdate = false;
  /** @ac game/Entities/Player/Player.h Player::_wasOutdoor */
  wasOutdoor = true;
  /** @ac game/Entities/Player/Player.h Player::m_restFlagMask (`_restFlagMask`) */
  restFlagMask = 0;
  readonly pvpInfo: PvPInfo = { IsInHostileArea: false, IsInNoPvPArea: false, IsInFFAPvPArea: false, IsHostile: false };

  constructor(private readonly host: PlayerAreaHost) {}

  /** @ac game/Entities/Player/Player.cpp Player::SetRestFlag */
  setRestFlag(restFlag: number): void {
    const oldRestMask = this.restFlagMask;
    this.restFlagMask |= restFlag;

    if (!oldRestMask && this.restFlagMask) this.host.setResting(true);
  }

  /** @ac game/Entities/Player/Player.cpp Player::RemoveRestFlag */
  removeRestFlag(restFlag: number): void {
    const oldRestMask = this.restFlagMask;
    this.restFlagMask &= ~restFlag;

    if (oldRestMask && !this.restFlagMask) this.host.setResting(false);
  }

  /** @ac game/Entities/Player/Player.h Player::HasRestFlag */
  hasRestFlag(restFlag: number): boolean {
    return (this.restFlagMask & restFlag) !== 0;
  }

  /**
   * @ac game/Entities/Player/PlayerUpdates.cpp Player::Update (the zone update timer)
   * Once a second the zone and area are read again; a changed zone runs `UpdateZone`, a changed area `UpdateArea`.
   * @ac-skip the tavern check of the timer (`HasRestFlag(REST_FLAG_IN_TAVERN)` and the inn area trigger radius): the rest
   * code does not set the tavern flag, so there is none to remove.
   */
  update(p_time: number): void {
    if (this.zoneUpdateTimer > 0) {
      if (p_time >= this.zoneUpdateTimer) {
        const status = this.host.getTerrainStatus();
        if (status) {
          if (this.zoneUpdateId !== status.zoneid) this.updateZone(status.zoneid, status.areaid); // also update area
          // use area updates as well
          // needed for free far all arenas for example
          else if (this.areaUpdateId !== status.areaid) this.updateArea(status.areaid);
        }

        this.zoneUpdateTimer = ZONE_UPDATE_INTERVAL;
      } else this.zoneUpdateTimer -= p_time;
    }
  }

  /**
   * @ac game/Entities/Player/PlayerUpdates.cpp Player::UpdatePosition (after `Unit::UpdatePosition`)
   * A pending zone update runs first, then the exploration check.
   */
  updatePosition(): void {
    // Update player zone if needed
    if (this.needZoneUpdate) {
      const status = this.host.getTerrainStatus();
      if (status) this.updateZone(status.zoneid, status.areaid);
      this.needZoneUpdate = false;
    }

    this.checkAreaExploreAndOutdoor();
  }

  /**
   * @ac game/Entities/Player/Player.cpp Player::SendInitialPacketsAfterAddToMap (the zone update)
   * `GetZoneAndAreaId(newzone, newarea); UpdateZone(newzone, newarea);`
   */
  updateZoneAfterAddToMap(): void {
    const status = this.host.getTerrainStatus();
    if (status) this.updateZone(status.zoneid, status.areaid);
  }

  /** @ac game/Entities/Player/PlayerUpdates.cpp Player::UpdateArea */
  updateArea(newArea: number): void {
    // FFA_PVP flags are area and not zone id dependent
    // so apply them accordingly
    this.areaUpdateId = newArea;

    const area = sAreaTableStore.lookupEntry(newArea);
    this.pvpInfo.IsInFFAPvPArea = !!area && (area.flags & AREA_FLAG_ARENA) !== 0;

    this.pvpInfo.IsInNoPvPArea = false;
    if (area && isSanctuary(area)) {
      this.host.setSanctuaryFlag(true);
      this.pvpInfo.IsInNoPvPArea = true;
    } else this.host.setSanctuaryFlag(false);

    const areaRestFlag = this.host.getTeamId() === TEAM_ALLIANCE ? AREA_FLAG_REST_ZONE_ALLIANCE : AREA_FLAG_REST_ZONE_HORDE;
    if (area && area.flags & areaRestFlag) this.setRestFlag(REST_FLAG_IN_FACTION_AREA);
    else this.removeRestFlag(REST_FLAG_IN_FACTION_AREA);
  }

  /** @ac game/Entities/Player/PlayerUpdates.cpp Player::UpdateZone */
  updateZone(newZone: number, newArea: number, force = false): void {
    if (!newZone) return;

    const oldZone = this.zoneUpdateId;
    if (this.zoneUpdateId !== newZone) {
      // only if really enters to new zone, not just area change, works strange...
      this.sendInitWorldStates(newZone, newArea);
    }

    this.host.updatePlayerZoneStats?.(oldZone, newZone);

    this.zoneUpdateId = newZone;
    this.zoneUpdateTimer = ZONE_UPDATE_INTERVAL;
    this.host.setZone(newZone);

    // zone changed, so area changed as well, update it
    this.updateArea(newArea);

    const zone = sAreaTableStore.lookupEntry(newZone);
    if (!zone) return;

    if (oldZone !== newZone || force) this.host.sendZoneDynamicInfo?.(newZone);

    // in PvP, any not controlled zone (except zone->team == 6, default case)
    // in PvE, only opposition team capital
    const teamId = this.host.getTeamId();
    switch (zone.team) {
      case AREATEAM_ALLY:
        this.pvpInfo.IsInHostileArea = teamId !== TEAM_ALLIANCE && (sWorld().isPvPRealm() || (zone.flags & AREA_FLAG_CAPITAL) !== 0);
        break;
      case AREATEAM_HORDE:
        this.pvpInfo.IsInHostileArea = teamId !== TEAM_HORDE && (sWorld().isPvPRealm() || (zone.flags & AREA_FLAG_CAPITAL) !== 0);
        break;
      case AREATEAM_NONE:
        // overwrite for battlegrounds, maybe batter some zone flags but current known not 100% fit to this
        this.pvpInfo.IsInHostileArea = sWorld().isPvPRealm() || (zone.flags & AREA_FLAG_WINTERGRASP) !== 0;
        break;
      default: // 6 in fact
        this.pvpInfo.IsInHostileArea = false;
        break;
    }

    // Treat players having a quest flagging for PvP as always in hostile area
    this.pvpInfo.IsHostile = this.pvpInfo.IsInHostileArea; // @ac-skip HasPvPForcingQuest

    if (zone.flags & AREA_FLAG_CAPITAL) {
      // Is in a capital city
      if (!this.pvpInfo.IsHostile || isSanctuary(zone)) this.setRestFlag(REST_FLAG_IN_CITY);

      this.pvpInfo.IsInNoPvPArea = true;
    } else this.removeRestFlag(REST_FLAG_IN_CITY); // Recently left a capital city
  }

  /** @ac game/Entities/Player/Player.cpp Player::SendInitWorldStates */
  sendInitWorldStates(zoneId: number, areaId: number): void {
    this.host.sendPacket(SMSG_INIT_WORLD_STATES, buildInitWorldStates(this.host.getMapId(), zoneId, areaId));
  }

  /** @ac game/Entities/Player/Player.cpp Player::CheckAreaExploreAndOutdoor */
  checkAreaExploreAndOutdoor(): void {
    if (!this.host.isAlive()) return;

    if (this.host.isInFlight()) return;

    const status = this.host.getTerrainStatus();
    if (!status) return;

    const isOutdoor = status.outdoors;
    const areaId = status.areaid;
    const areaEntry = sAreaTableStore.lookupEntry(areaId);

    if (sWorld().getBoolConfig(ServerConfig.CONFIG_VMAP_INDOOR_CHECK) && this.wasOutdoor !== isOutdoor) {
      this.wasOutdoor = isOutdoor;
      this.host.updateOutdoorsAuras(isOutdoor);
    }

    if (!areaId) return;

    if (!areaEntry) {
      const pos = this.host.getPosition();
      logError("world", `Player '${this.host.getName()}' (${this.host.getGUIDString()}) discovered unknown area (x: ${pos.x} y: ${pos.y} z: ${pos.z} map: ${this.host.getMapId()})`);
      return;
    }

    const offset = Math.floor(areaEntry.exploreFlag / 32);

    if (offset >= PLAYER_EXPLORED_ZONES_SIZE) {
      const pos = this.host.getPosition();
      logError(
        "world",
        `Wrong area flag ${areaEntry.flags} in map data for (X: ${pos.x} Y: ${pos.y}) point to field PLAYER_EXPLORED_ZONES_1 + ${offset} ( ${offset} must be < ${PLAYER_EXPLORED_ZONES_SIZE} ).`,
      );
      return;
    }

    const val = (1 << areaEntry.exploreFlag % 32) >>> 0;
    const currFields = this.host.getExploredZonesField(offset) >>> 0;

    if (!(currFields & val)) {
      this.host.setExploredZonesField(offset, (currFields | val) >>> 0);

      if (areaEntry.area_level > 0) {
        const playerLevel = this.host.getLevel();

        if (playerLevel >= sWorld().getIntConfig(ServerConfig.CONFIG_MAX_PLAYER_LEVEL)) {
          this.sendExplorationExperience(areaId, 0);
        } else {
          const diff = playerLevel - areaEntry.area_level;
          let XP = 0;
          if (diff < -5) {
            XP = Math.trunc(this.getBaseXP(playerLevel + 5) * sWorld().getRate(ServerConfig.RATE_XP_EXPLORE));
          } else if (diff > 5) {
            let exploration_percent = 100 - (diff - 5) * 5;
            if (exploration_percent > 100) exploration_percent = 100;
            else if (exploration_percent < 0) exploration_percent = 0;

            XP = Math.trunc(Math.trunc((this.getBaseXP(areaEntry.area_level) * exploration_percent) / 100) * sWorld().getRate(ServerConfig.RATE_XP_EXPLORE));
          } else {
            XP = Math.trunc(this.getBaseXP(areaEntry.area_level) * sWorld().getRate(ServerConfig.RATE_XP_EXPLORE));
          }

          this.host.giveExplorationXp(XP);
          this.sendExplorationExperience(areaId, XP);
        }
        log("world", `Player ${this.host.getGUIDString()} discovered a new area: ${areaId}`);
      }
    }
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::GetBaseXP (the `exploration_basexp` table) */
  private getBaseXP(level: number): number {
    return sObjectMgr.getBaseXP(level);
  }

  /** @ac game/Entities/Player/Player.cpp Player::SendExplorationExperience */
  sendExplorationExperience(areaId: number, xp: number): void {
    this.host.sendPacket(SMSG_EXPLORATION_EXPERIENCE, buildExplorationExperience(areaId, xp));
  }
}
