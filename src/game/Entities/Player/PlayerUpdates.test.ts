import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SMSG_EXPLORATION_EXPERIENCE } from "../../../characters/experience.ts";
import { exploration_basexp } from "../../../database/schema/world.ts";
import { WorldTables } from "../../../database/world-tables.ts";
import { ByteReader } from "../../../net/byte-buffer.ts";
import { sAreaTableStore } from "../../DataStores/DBCStores.ts";
import { sObjectMgr } from "../../Globals/ObjectMgr.ts";
import { ServerConfig } from "../../world/world-config-data.ts";
import { sWorld } from "../../world/world.ts";
import {
  AREA_FLAG_CAPITAL,
  AREA_FLAG_REST_ZONE_ALLIANCE,
  AREA_FLAG_SANCTUARY,
  AREATEAM_ALLY,
  buildInitWorldStates,
  isSanctuary,
  PlayerAreaUpdates,
  REST_FLAG_IN_CITY,
  REST_FLAG_IN_FACTION_AREA,
  SMSG_INIT_WORLD_STATES,
  ZONE_UPDATE_INTERVAL,
  type PlayerAreaHost,
  type PlayerTerrainStatus,
} from "./PlayerUpdates.ts";

const ZONE = 12;
const AREA = 24;
const CITY = 1519;
const INN = 800;

function area(ID: number, zone: number, flags = 0, exploreFlag = 0, area_level = 0, team = 0, mapid = 0): void {
  sAreaTableStore.set(ID, { ID, mapid, zone, exploreFlag, flags, area_level, area_name: [], team, LiquidTypeOverride: [0, 0, 0, 0] });
}

class FakeHost implements PlayerAreaHost {
  status: PlayerTerrainStatus | null = { zoneid: ZONE, areaid: AREA, outdoors: true };
  mapId = 0;
  level = 10;
  teamId = 0;
  alive = true;
  inFlight = false;
  explored = new Map<number, number>();
  zone = 0;
  xp: number[] = [];
  sent: { opcode: number; body: Uint8Array }[] = [];
  resting = false;
  sanctuary = false;
  outdoorsCalls: boolean[] = [];
  dynamicInfo: number[] = [];
  zoneStats: [number, number][] = [];

  getTerrainStatus = () => this.status;
  getMapId = () => this.mapId;
  getName = () => "Tester";
  getGUIDString = () => "Player (1)";
  getPosition = () => ({ x: 1, y: 2, z: 3 });
  getLevel = () => this.level;
  getTeamId = () => this.teamId;
  isAlive = () => this.alive;
  isInFlight = () => this.inFlight;
  getExploredZonesField = (offset: number) => this.explored.get(offset) ?? 0;
  setExploredZonesField = (offset: number, value: number) => void this.explored.set(offset, value);
  setZone = (zone: number) => void (this.zone = zone);
  giveExplorationXp = (xp: number) => void this.xp.push(xp);
  sendPacket = (opcode: number, body: Uint8Array) => void this.sent.push({ opcode, body });
  setResting = (resting: boolean) => void (this.resting = resting);
  setSanctuaryFlag = (on: boolean) => void (this.sanctuary = on);
  updateOutdoorsAuras = (isOutdoor: boolean) => void this.outdoorsCalls.push(isOutdoor);
  sendZoneDynamicInfo = (zone: number) => void this.dynamicInfo.push(zone);
  updatePlayerZoneStats = (oldZone: number, newZone: number) => void this.zoneStats.push([oldZone, newZone]);
}

const savedWorld = sObjectMgr.worldTables();
const savedXpRate = sWorld().getFloatConfig(ServerConfig.RATE_XP_EXPLORE);

beforeEach(() => {
  sObjectMgr.setWorld(
    null,
    WorldTables.fromRows([
      [
        exploration_basexp,
        [
          { level: 5, basexp: 100 },
          { level: 8, basexp: 200 },
          { level: 10, basexp: 300 },
          { level: 15, basexp: 500 },
        ],
      ],
    ]),
  );
  area(ZONE, 0);
  area(AREA, ZONE, 0, 33, 10); // explore flag 33: bit 1 of field 1
  area(CITY, 0, AREA_FLAG_CAPITAL | AREA_FLAG_SANCTUARY);
  area(INN, CITY, AREA_FLAG_REST_ZONE_ALLIANCE, 40, 0);
  sAreaTableStore.set(2000, { ID: 2000, mapid: 0, zone: 0, exploreFlag: 0, flags: 0, area_level: 0, area_name: [], team: AREATEAM_ALLY, LiquidTypeOverride: [0, 0, 0, 0] });
});

afterEach(() => {
  sObjectMgr.setWorld(null, savedWorld);
  sWorld().settings.overwrite(ServerConfig.RATE_XP_EXPLORE, savedXpRate);
});

describe("Player::UpdateZone and UpdateArea", () => {
  test("the first update sends the world states, sets the zone, and starts the timer", () => {
    const host = new FakeHost();
    const player = new PlayerAreaUpdates(host);
    expect(player.zoneUpdateId).toBe(0xffffffff);
    player.updateZoneAfterAddToMap();
    expect(player.zoneUpdateId).toBe(ZONE);
    expect(player.areaUpdateId).toBe(AREA);
    expect(player.zoneUpdateTimer).toBe(ZONE_UPDATE_INTERVAL);
    expect(host.zone).toBe(ZONE);
    expect(host.zoneStats).toEqual([[0xffffffff, ZONE]]);
    expect(host.dynamicInfo).toEqual([ZONE]);
    expect(host.sent.map((packet) => packet.opcode)).toEqual([SMSG_INIT_WORLD_STATES]);
  });

  test("a zone without an id is not an update", () => {
    const host = new FakeHost();
    host.status = { zoneid: 0, areaid: 0, outdoors: true };
    const player = new PlayerAreaUpdates(host);
    player.updateZoneAfterAddToMap();
    expect(player.zoneUpdateId).toBe(0xffffffff);
    expect(host.sent).toHaveLength(0);
  });

  test("the timer re-reads the zone once a second: a new zone updates the zone, a new area only the area", () => {
    const host = new FakeHost();
    const player = new PlayerAreaUpdates(host);
    player.updateZoneAfterAddToMap();
    host.sent.length = 0;

    player.update(ZONE_UPDATE_INTERVAL - 1);
    host.status = { zoneid: ZONE, areaid: 25, outdoors: true };
    expect(player.areaUpdateId).toBe(AREA); // not yet
    player.update(1);
    expect(player.areaUpdateId).toBe(25);
    expect(host.sent).toHaveLength(0); // an area change sends no world states

    host.status = { zoneid: 13, areaid: 26, outdoors: true };
    player.update(ZONE_UPDATE_INTERVAL);
    expect(player.zoneUpdateId).toBe(13);
    expect(host.sent.map((packet) => packet.opcode)).toEqual([SMSG_INIT_WORLD_STATES]);
    expect(host.zoneStats.at(-1)).toEqual([ZONE, 13]);
  });

  test("a pending zone update (CMSG_ZONEUPDATE) runs with the next position update", () => {
    const host = new FakeHost();
    const player = new PlayerAreaUpdates(host);
    player.updateZoneAfterAddToMap();
    host.status = { zoneid: 13, areaid: 26, outdoors: true };
    player.updatePosition();
    expect(player.zoneUpdateId).toBe(ZONE);
    player.needZoneUpdate = true;
    player.updatePosition();
    expect(player.zoneUpdateId).toBe(13);
    expect(player.needZoneUpdate).toBe(false);
  });

  test("a capital city sets the city rest flag, a faction rest area the faction flag, and both clear on leaving", () => {
    const host = new FakeHost();
    const player = new PlayerAreaUpdates(host);
    host.status = { zoneid: CITY, areaid: INN, outdoors: false };
    player.updateZoneAfterAddToMap();
    expect(player.hasRestFlag(REST_FLAG_IN_CITY)).toBe(true);
    expect(player.hasRestFlag(REST_FLAG_IN_FACTION_AREA)).toBe(true);
    expect(host.resting).toBe(true);
    expect(player.pvpInfo.IsInNoPvPArea).toBe(true);
    // the faction area is for the alliance only
    const horde = new FakeHost();
    horde.teamId = 1;
    horde.status = { zoneid: CITY, areaid: INN, outdoors: false };
    const hordePlayer = new PlayerAreaUpdates(horde);
    hordePlayer.updateZoneAfterAddToMap();
    expect(hordePlayer.hasRestFlag(REST_FLAG_IN_FACTION_AREA)).toBe(false);

    host.status = { zoneid: ZONE, areaid: AREA, outdoors: true };
    player.update(ZONE_UPDATE_INTERVAL);
    expect(player.restFlagMask).toBe(0);
    expect(host.resting).toBe(false);
  });

  test("a sanctuary area sets the sanctuary flag and clears it elsewhere", () => {
    expect(isSanctuary({ mapid: 0, flags: AREA_FLAG_SANCTUARY })).toBe(true);
    expect(isSanctuary({ mapid: 609, flags: 0 })).toBe(true);
    expect(isSanctuary({ mapid: 0, flags: 0 })).toBe(false);
    const host = new FakeHost();
    const player = new PlayerAreaUpdates(host);
    player.updateArea(CITY);
    expect(host.sanctuary).toBe(true);
    player.updateArea(AREA);
    expect(host.sanctuary).toBe(false);
  });

  test("hostile zones of the other faction on a PvP realm", () => {
    const host = new FakeHost();
    host.teamId = 1; // horde
    host.status = { zoneid: 2000, areaid: 2000, outdoors: true };
    const player = new PlayerAreaUpdates(host);
    player.updateZoneAfterAddToMap();
    expect(player.pvpInfo.IsInHostileArea).toBe(false); // PvE realm, not a capital
    const type = sWorld().getIntConfig(ServerConfig.CONFIG_GAME_TYPE);
    sWorld().settings.overwrite(ServerConfig.CONFIG_GAME_TYPE, 1);
    player.updateZone(2000, 2000, true);
    expect(player.pvpInfo.IsInHostileArea).toBe(true);
    expect(player.pvpInfo.IsHostile).toBe(true);
    sWorld().settings.overwrite(ServerConfig.CONFIG_GAME_TYPE, type);
  });
});

describe("Player::CheckAreaExploreAndOutdoor", () => {
  test("a new area sets its explore bit and gives exploration experience once", () => {
    const host = new FakeHost();
    const player = new PlayerAreaUpdates(host);
    player.updatePosition();
    // area 24: exploreFlag 33 = field 1, bit 1; level 10 player in a level 10 area: base xp of level 10
    expect(host.explored.get(1)).toBe(2);
    expect(host.xp).toEqual([300]);
    const packet = host.sent.find((sent) => sent.opcode === SMSG_EXPLORATION_EXPERIENCE)!;
    const reader = new ByteReader(packet.body);
    expect([reader.readU32(), reader.readU32()]).toEqual([AREA, 300]);

    host.sent.length = 0;
    player.updatePosition();
    expect(host.xp).toEqual([300]);
    expect(host.sent.filter((sent) => sent.opcode === SMSG_EXPLORATION_EXPERIENCE)).toHaveLength(0);
  });

  test("the experience follows the level difference and Rate.XP.Explore", () => {
    const run = (level: number): number[] => {
      const host = new FakeHost();
      host.level = level;
      new PlayerAreaUpdates(host).updatePosition();
      return host.xp;
    };
    // diff -7 < -5: the base xp of the player's level + 5 (8), and diff -5 is still the area's level
    expect(run(3)).toEqual([200]);
    expect(run(5)).toEqual([300]);
    sWorld().settings.overwrite(ServerConfig.RATE_XP_EXPLORE, 2);
    expect(run(10)).toEqual([600]);
    sWorld().settings.overwrite(ServerConfig.RATE_XP_EXPLORE, 1);
    // diff 7 > 5: 100 - (7 - 5) * 5 = 90 percent of the area level's base xp
    expect(run(17)).toEqual([Math.trunc((300 * 90) / 100)]);
    // diff 12: 100 - 35 = 65
    expect(run(22)).toEqual([Math.trunc((300 * 65) / 100)]);
  });

  test("an area without a level marks the bit and gives nothing; a max level player gets a zero message", () => {
    area(AREA, ZONE, 0, 33, 0);
    const host = new FakeHost();
    new PlayerAreaUpdates(host).updatePosition();
    expect(host.explored.get(1)).toBe(2);
    expect(host.xp).toEqual([]);
    expect(host.sent).toHaveLength(0);

    area(AREA, ZONE, 0, 33, 10);
    const capped = new FakeHost();
    capped.level = sWorld().getIntConfig(ServerConfig.CONFIG_MAX_PLAYER_LEVEL);
    new PlayerAreaUpdates(capped).updatePosition();
    expect(capped.xp).toEqual([]);
    const packet = capped.sent.find((sent) => sent.opcode === SMSG_EXPLORATION_EXPERIENCE)!;
    expect(new ByteReader(packet.body).readU32()).toBe(AREA);
  });

  test("nothing happens while dead or in flight, without an area, for an unknown area, or an explore flag out of range", () => {
    const dead = new FakeHost();
    dead.alive = false;
    new PlayerAreaUpdates(dead).updatePosition();
    const flying = new FakeHost();
    flying.inFlight = true;
    new PlayerAreaUpdates(flying).updatePosition();
    const none = new FakeHost();
    none.status = { zoneid: 0, areaid: 0, outdoors: true };
    new PlayerAreaUpdates(none).updatePosition();
    const unknown = new FakeHost();
    unknown.status = { zoneid: 1, areaid: 99999, outdoors: true };
    new PlayerAreaUpdates(unknown).updatePosition();
    area(AREA, ZONE, 0, 128 * 32, 10);
    const outOfRange = new FakeHost();
    new PlayerAreaUpdates(outOfRange).updatePosition();
    for (const host of [dead, flying, none, unknown, outOfRange]) {
      expect(host.explored.size).toBe(0);
      expect(host.sent).toHaveLength(0);
    }
  });

  test("going indoors or outdoors updates the aura state only when vmap.enableIndoorCheck is on", () => {
    const host = new FakeHost();
    const player = new PlayerAreaUpdates(host);
    player.updatePosition();
    expect(host.outdoorsCalls).toEqual([]); // outdoors, as it was
    host.status = { zoneid: ZONE, areaid: AREA, outdoors: false };
    player.updatePosition();
    expect(host.outdoorsCalls).toEqual([false]);
    player.updatePosition();
    expect(host.outdoorsCalls).toEqual([false]);
    host.status = { zoneid: ZONE, areaid: AREA, outdoors: true };
    player.updatePosition();
    expect(host.outdoorsCalls).toEqual([false, true]);

    sWorld().setBoolConfig(ServerConfig.CONFIG_VMAP_INDOOR_CHECK, false);
    host.status = { zoneid: ZONE, areaid: AREA, outdoors: false };
    player.updatePosition();
    expect(host.outdoorsCalls).toEqual([false, true]);
    sWorld().setBoolConfig(ServerConfig.CONFIG_VMAP_INDOOR_CHECK, true);
  });
});

describe("SMSG_INIT_WORLD_STATES", () => {
  test("the map, zone, area, and the states every zone gets", () => {
    const reader = new ByteReader(buildInitWorldStates(0, 12, 24));
    expect([reader.readU32(), reader.readU32(), reader.readU32(), reader.readU16()]).toEqual([0, 12, 24, 8]);
    const states = new Map<number, number>();
    for (let index = 0; index < 8; index++) states.set(reader.readU32(), reader.readU32());
    expect(states.get(2259)).toBe(0); // scourge invasion
    expect(states.has(3191)).toBe(true); // arena season progress
    expect(states.has(3901)).toBe(true); // arena season id
  });

  test("Outland adds the Nagrand states", () => {
    const reader = new ByteReader(buildInitWorldStates(530, 3518, 3518));
    reader.readU32();
    reader.readU32();
    reader.readU32();
    expect(reader.readU16()).toBe(11);
    const states = new Map<number, number>();
    for (let index = 0; index < 11; index++) states.set(reader.readU32(), reader.readU32());
    expect(states.get(2493)).toBe(15);
    expect(states.get(2491)).toBe(15);
    expect(states.get(2495)).toBe(0);
  });
});
