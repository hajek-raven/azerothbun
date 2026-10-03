import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cell } from "../Grids/Cells/Cell.ts";
import { TOTAL_NUMBER_OF_CELLS_PER_MAP } from "../Grids/GridDefines.ts";
import { GridObjectLoaderHooks } from "../Grids/GridObjectLoader.ts";
import { FakeCreature, FakeGameObject, FakeObjectMgr, FakePlayer } from "../Grids/Grids.test-util.ts";
import { resetGameTimeForTests } from "../time/game-time.ts";
import { Map, MapHooks, MapScriptHooks, MAP_INVALID_ZONE } from "./Map.ts";
import { cellCenter, MAP_COMMON, playerOn, setMapEntry, TEST_MAP_ID } from "./Map.test-util.ts";

const savedHooks = { ...MapHooks };
const savedScriptHooks = { ...MapScriptHooks };
const savedLoaderHooks = { ...GridObjectLoaderHooks };

let store: FakeObjectMgr;
let map: Map;

beforeEach(() => {
  resetGameTimeForTests();
  store = new FakeObjectMgr();
  GridObjectLoaderHooks.objectMgr = store;
  GridObjectLoaderHooks.createCreature = () => new FakeCreature(store);
  GridObjectLoaderHooks.createGameObject = () => new FakeGameObject(store);
  setMapEntry(TEST_MAP_ID, MAP_COMMON);
  map = new Map(TEST_MAP_ID, 0, 0);
});

afterEach(() => {
  Object.assign(MapHooks, savedHooks);
  Object.assign(MapScriptHooks, savedScriptHooks);
  Object.assign(GridObjectLoaderHooks, savedLoaderHooks);
});

/** A player standing in cell (386, 260) that went through `AddPlayerToMap`. */
function joined(guidLow: number, cx = 386, cy = 260): ReturnType<typeof playerOn> {
  const player = playerOn(map, guidLow, cellCenter(cx), cellCenter(cy), 4);
  expect(map.addPlayerToMap(player)).toBe(true);
  return player;
}

describe("Map players", () => {
  test("AddPlayerToMap loads the grids around the player, adds it to the grid, the world, and the player list", () => {
    const entered: unknown[] = [];
    MapScriptHooks.onPlayerEnterMap = (_m, p) => entered.push(p);
    const player = joined(1);
    expect(player.isInWorld()).toBe(true);
    expect(player.isInGrid()).toBe(true);
    expect(map.havePlayers()).toBe(true);
    expect(map.getPlayers().getSize()).toBe(1);
    expect(map.isGridLoaded(player.getPositionX(), player.getPositionY())).toBe(true);
    expect(entered).toEqual([player]);
    // the self create packet goes out (an empty update here: no update block builder is installed)
    expect(player.received.length).toBeGreaterThan(0);
  });

  test("AddPlayerToMap refuses a player at invalid coordinates", () => {
    const player = playerOn(map, 2, -1e9, 0);
    expect(map.addPlayerToMap(player)).toBe(false);
    expect(player.isInWorld()).toBe(false);
  });

  test("AddPlayerToMap asserts the player is on this map", () => {
    const other = new Map(TEST_MAP_ID, 0, 0);
    const player = playerOn(other, 3, cellCenter(386), cellCenter(260));
    expect(() => map.addPlayerToMap(player)).toThrow();
  });

  test("RemovePlayerFromMap takes the player out of the world, the grid, and the zone count", () => {
    const left: unknown[] = [];
    MapScriptHooks.onPlayerLeaveMap = (_m, p) => left.push(p);
    const player = joined(4);
    map.updatePlayerZoneStats(MAP_INVALID_ZONE, 7);
    map.removePlayerFromMap(player, false);
    expect(player.isInWorld()).toBe(false);
    expect(player.isInGrid()).toBe(false);
    expect(left).toEqual([player]);
  });

  test("removing a player that is not in a grid asserts unless it is deleted", () => {
    const player = playerOn(map, 5, cellCenter(386), cellCenter(260));
    expect(() => map.removePlayerFromMap(player, false)).toThrow();
  });

  test("zone player counts follow UpdatePlayerZoneStats", () => {
    map.updatePlayerZoneStats(MAP_INVALID_ZONE, 12);
    map.updatePlayerZoneStats(MAP_INVALID_ZONE, 12);
    map.updatePlayerZoneStats(MAP_INVALID_ZONE, 13);
    expect(map.getPlayerCountInZone(12)).toBe(2);
    map.updatePlayerZoneStats(12, 13);
    expect(map.getPlayerCountInZone(12)).toBe(1);
    expect(map.getPlayerCountInZone(13)).toBe(2);
    map.updatePlayerZoneStats(13, 13);
    expect(map.getPlayerCountInZone(13)).toBe(2);
    map.updatePlayerZoneStats(13, MAP_INVALID_ZONE);
    expect(map.getPlayerCountInZone(13)).toBe(1);
    // never below zero
    map.updatePlayerZoneStats(99, MAP_INVALID_ZONE);
    expect(map.getPlayerCountInZone(99)).toBe(0);
  });

  test("GetPlayersCountExceptGMs skips game masters and, when asked, the dead", () => {
    const a = joined(10);
    const b = joined(11);
    const c = joined(12);
    b.isGameMaster = () => true;
    c.alive = false;
    expect(map.getPlayersCountExceptGMs()).toBe(2);
    expect(map.getPlayersCountExceptGMs(true)).toBe(1);
    expect(a.isAlive()).toBe(true);
  });

  test("DoForAllPlayers and SendToPlayers reach every player", () => {
    const a = joined(20);
    const b = joined(21);
    const seen: unknown[] = [];
    map.doForAllPlayers((p) => seen.push(p));
    expect(seen).toHaveLength(2);
    const before = [a.received.length, b.received.length];
    map.sendToPlayers({ opcode: 1, payload: new Uint8Array(0) });
    expect([a.received.length - before[0]!, b.received.length - before[1]!]).toEqual([1, 1]);
  });

  test("PlayerRelocation moves the player to its new cell and loads the new grid", () => {
    const player = joined(30, 386, 260);
    const loaded = map.getLoadedGridsCount();
    map.playerRelocation(player, cellCenter(386 + 20), cellCenter(260), 4, 1);
    expect(player.getPositionX()).toBeCloseTo(cellCenter(406), 3);
    expect(player.isInGrid()).toBe(true);
    expect(map.isGridLoaded(cellCenter(406), cellCenter(260))).toBe(true);
    expect(map.getLoadedGridsCount()).toBeGreaterThan(loaded);
  });
});

describe("Map update", () => {
  test("Update with no time passed updates the players and handles delayed visibility", () => {
    const player = joined(40);
    const updates: number[] = [];
    player.update = (diff: number) => void updates.push(diff);
    const unit = new FakeCreature(store, 41, 0, 0, 0) as FakeCreature & { executeDelayedUnitRelocationEvent?: () => void };
    let relocated = 0;
    unit.executeDelayedUnitRelocationEvent = () => void ++relocated;
    map.i_objectsForDelayedVisibility.add(unit);
    map.update(0, 50);
    expect(updates).toEqual([50]);
    expect(relocated).toBe(1);
    expect(map.i_objectsForDelayedVisibility.size).toBe(0);
  });

  test("the session hook runs for players in the world", () => {
    const player = joined(42);
    const calls: [unknown, number][] = [];
    MapHooks.updateSession = (p, diff) => void calls.push([p, diff]);
    map.update(10, 20);
    expect(calls).toEqual([[player, 20]]);
  });

  test("a timed update marks the cells around each player", () => {
    const player = joined(43);
    map.update(UPDATE_RECHECK, 20);
    const cell = new Cell(player.getPositionX(), player.getPositionY()).getCellCoord();
    expect(map.isCellMarked(cell.y_coord * TOTAL_NUMBER_OF_CELLS_PER_MAP + cell.x_coord)).toBe(true);
    expect(map.isCellMarked(0)).toBe(false);
    map.resetMarkedCells();
    expect(map.isCellMarked(cell.y_coord * TOTAL_NUMBER_OF_CELLS_PER_MAP + cell.x_coord)).toBe(false);
  });

  test("the script hook sees every timed update", () => {
    const seen: number[] = [];
    MapScriptHooks.onMapUpdate = (_m, diff) => void seen.push(diff);
    map.update(7, 7);
    map.update(0, 7);
    expect(seen).toEqual([7]);
  });
});

const UPDATE_RECHECK = 30 * 1000;

describe("Map zone state", () => {
  test("SendZoneMessage reaches the players in the zone, except the given session and other teams", () => {
    const a = joined(50) as FakePlayer & { getZoneId(): number };
    const b = joined(51) as FakePlayer & { getZoneId(): number };
    const c = joined(52) as FakePlayer & { getZoneId(): number };
    a.getZoneId = () => 7;
    b.getZoneId = () => 7;
    c.getZoneId = () => 8;
    b.teamId = 1;
    const packet = { opcode: 5, payload: new Uint8Array([1]) };
    const base = [a, b, c].map((p) => p.received.length);
    expect(map.sendZoneMessage(7, packet)).toBe(true);
    expect([a, b, c].map((p, i) => p.received.length - base[i]!)).toEqual([1, 1, 0]);
    expect(map.sendZoneMessage(7, packet, a.getSession(), 1)).toBe(true);
    expect(map.sendZoneMessage(7, packet, null, 0)).toBe(true);
    expect(map.sendZoneMessage(9, packet)).toBe(false);
  });

  test("SetZoneMusic stores the music and tells the zone; SendZoneDynamicInfo replays it", () => {
    const a = joined(60) as FakePlayer & { getZoneId(): number };
    a.getZoneId = () => 7;
    const base = a.received.length;
    map.setZoneMusic(7, 1234);
    expect(a.received.length - base).toBe(1);
    expect(Array.from(a.received.at(-1)!.payload)).toEqual([0xd2, 0x04, 0, 0]);
    map.setZoneWeather(7, 3, 0.5);
    map.setZoneOverrideLight(7, 99, 2000);
    const late = joined(61) as FakePlayer & { getZoneId(): number };
    const lateBase = late.received.length;
    map.sendZoneDynamicInfo(7, late);
    // music, weather, and the override light
    expect(late.received.length - lateBase).toBe(3);
    map.sendZoneDynamicInfo(8, late);
    expect(late.received.length - lateBase).toBe(3);
  });

  test("SendZoneWeather sends fine weather when the zone has none set", () => {
    const a = joined(62);
    map.setZoneMusic(5, 1);
    const base = a.received.length;
    map.sendZoneWeather(5, a);
    expect(a.received.length - base).toBe(1);
    expect(a.received.at(-1)!.opcode).toBe(0x2f4);
    expect(Array.from(a.received.at(-1)!.payload.slice(0, 4))).toEqual([0, 0, 0, 0]);
  });

  test("PlayDirectSoundToMap reaches the players of the zone (or all)", () => {
    const a = joined(63) as FakePlayer & { getZoneId(): number };
    const b = joined(64) as FakePlayer & { getZoneId(): number };
    a.getZoneId = () => 1;
    b.getZoneId = () => 2;
    const base = [a.received.length, b.received.length];
    map.playDirectSoundToMap(10, 1);
    expect([a.received.length - base[0]!, b.received.length - base[1]!]).toEqual([1, 0]);
    map.playDirectSoundToMap(10);
    expect([a.received.length - base[0]!, b.received.length - base[1]!]).toEqual([2, 1]);
  });

  test("SendZoneText builds the chat packet through the hook", () => {
    const a = joined(65) as FakePlayer & { getZoneId(): number };
    a.getZoneId = () => 4;
    const base = a.received.length;
    map.sendZoneText(4, "hello");
    expect(a.received.length).toBe(base);
    MapHooks.buildSystemChatPacket = (text) => ({ opcode: 0x96, payload: new TextEncoder().encode(text) });
    map.sendZoneText(4, "hello");
    expect(a.received.length - base).toBe(1);
  });

  test("zone wide visible and far visible objects are tracked per zone and cell", () => {
    const creature = new FakeCreature(store, 70, cellCenter(386), cellCenter(260), 1);
    creature.setMap(map);
    map.addToMap(creature);
    expect(map.getZoneWideVisibleWorldObjectsForZone(3)).toBeNull();
    map.addWorldObjectToZoneWideVisibleMap(3, creature);
    expect(map.getZoneWideVisibleWorldObjectsForZone(3)?.has(creature)).toBe(true);
    map.removeWorldObjectFromZoneWideVisibleMap(3, creature);
    expect(map.getZoneWideVisibleWorldObjectsForZone(3)?.has(creature)).toBe(false);
    // far visible: the creature is added to and removed from the far visible vector of its cell
    map.addWorldObjectToFarVisibleMap(creature);
    map.removeWorldObjectFromFarVisibleMap(creature);
  });

  test("the redirect kick timer announces itself and counts down", () => {
    const a = joined(80) as FakePlayer & { messages?: string[]; sendSystemMessage?: (t: string) => void };
    a.messages = [];
    a.sendSystemMessage = (text) => void a.messages!.push(text);
    expect(map.isPlayerRedirectKickTimerActive()).toBe(false);
    map.startPlayersRedirectKickTimer();
    expect(map.isPlayerRedirectKickTimerActive()).toBe(true);
    expect(a.messages).toHaveLength(1);
    map.update(1000, 1000);
    map.update(55000, 1000);
    expect(a.messages).toHaveLength(2);
    map.stopPlayersRedirectKickTimer();
    expect(map.isPlayerRedirectKickTimerActive()).toBe(false);
  });
});
