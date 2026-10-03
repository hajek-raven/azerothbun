import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sMapDifficultyStore } from "../DataStores/DBCStores.ts";
import { resetMapDBCStores } from "../DataStores/MapDBCStores.ts";
import { instance_template } from "../../database/schema/world.ts";
import { WorldTables } from "../../database/world-tables.ts";
import { FakeGameObject, FakeObjectMgr, FakePlayer } from "../Grids/Grids.test-util.ts";
import { ServerConfig } from "../world/world-config-data.ts";
import { sWorld } from "../world/world.ts";
import {
  BattlegroundMap,
  CANNOT_ENTER_ALREADY_IN_MAP,
  CANNOT_ENTER_INSTANCE_BIND_MISMATCH,
  CANNOT_ENTER_MAX_PLAYERS,
  CANNOT_ENTER_ZONE_IN_COMBAT,
  CAN_ENTER,
  INSTANCE_RESET_ALL,
  INSTANCE_RESET_GLOBAL,
  InstanceMap,
  Map,
  MapHooks,
  type MapBattleground,
  type MapInstanceSave,
  type MapInstanceScript,
  type MapPlayer,
} from "./Map.ts";
import { cellCenter, MAP_ARENA, MAP_INSTANCE, MAP_RAID, playerOn, setMapEntry } from "./Map.test-util.ts";
import { sMapRespawnStore } from "./Map.ts";
import { setMapMgrWorld } from "./MapMgrStatics.ts";
import { SPAWN_TYPE_CREATURE } from "./SpawnData.ts";

const DUNGEON = 931;
const RAID = 932;
const ARENA = 933;
const savedHooks = { ...MapHooks };
const unloadDelay = sWorld().getIntConfig(ServerConfig.CONFIG_INSTANCE_UNLOAD_DELAY);

type TestPlayer = FakePlayer & Partial<MapPlayer> & { aborted: [number, number][]; group: unknown };

/** A player that is not on the map yet: it can be asked whether it may enter. */
function visitor(guidLow: number): TestPlayer {
  const player = new FakePlayer(guidLow, cellCenter(386), cellCenter(260), 0) as TestPlayer;
  player.aborted = [];
  player.group = null;
  player.sendTransferAborted = (mapId, reason) => void player.aborted.push([mapId, reason]);
  player.getGroup = () => player.group;
  return player;
}

function scriptStub(): MapInstanceScript & { encounterInProgress: boolean; masks: number[]; updates: number[]; entered: unknown[]; left: unknown[] } {
  const script = {
    encounterInProgress: false,
    masks: [] as number[],
    updates: [] as number[],
    entered: [] as unknown[],
    left: [] as unknown[],
    initialize: () => {},
    load: () => {},
    update: (diff: number) => void script.updates.push(diff),
    onPlayerEnter: (p: unknown) => void script.entered.push(p),
    onPlayerLeave: (p: unknown) => void script.left.push(p),
    setCompletedEncountersMask: (mask: number) => void script.masks.push(mask),
    getCompletedEncounterMask: () => 0,
    isEncounterInProgress: () => script.encounterInProgress,
    isTwoFactionInstance: () => false,
    getTeamIdInInstance: () => 2,
    setTeamIdInInstance: () => {},
    loadInstanceSavedGameobjectStateData: () => {},
  };
  return script;
}

let parent: Map;
let instance: InstanceMap;

beforeEach(() => {
  setMapEntry(DUNGEON, MAP_INSTANCE, { maxPlayers: 5 });
  setMapEntry(RAID, MAP_RAID, { maxPlayers: 10, expansionID: 2 });
  setMapEntry(ARENA, MAP_ARENA);
  sMapDifficultyStore.set(1, { MapId: DUNGEON, Difficulty: 0, areaTriggerText: "", resetTime: 3600, maxPlayers: 4 });
  resetMapDBCStores();
  sWorld().setIntConfig(ServerConfig.CONFIG_INSTANCE_UNLOAD_DELAY, 1000);
  sMapRespawnStore.clear();
  setMapMgrWorld(
    WorldTables.fromRows([
      [
        instance_template,
        [
          { map: DUNGEON, parent: 0, script: "", allowMount: 0 },
          { map: RAID, parent: 0, script: "", allowMount: 0 },
        ],
      ],
    ]),
  );
  parent = new Map(DUNGEON, 0, 0);
  instance = new InstanceMap(DUNGEON, 5, 0, parent);
});

afterEach(() => {
  instance.unloadAll();
  parent.unloadAll();
  Object.assign(MapHooks, savedHooks);
  sWorld().setIntConfig(ServerConfig.CONFIG_INSTANCE_UNLOAD_DELAY, unloadDelay);
  setMapMgrWorld(null);
});

describe("InstanceMap", () => {
  test("the unload timer starts at the configured delay and the limits come from MapDifficulty", () => {
    expect(instance.canUnload(500)).toBe(false);
    expect(instance.canUnload(600)).toBe(true);
    expect(instance.getMaxPlayers()).toBe(4);
    expect(instance.getMaxResetDelay()).toBe(3600);
    expect(instance.getMapDifficulty()?.maxPlayers).toBe(4);
    const raid = new InstanceMap(RAID, 6, 0, new Map(RAID, 0, 0));
    expect(raid.getMaxPlayers()).toBe(10); // no MapDifficulty row: the Map.dbc maximum
    expect(raid.getMaxResetDelay()).toBe(0);
    expect(instance.getDebugInfo()).toContain("InstanceId: 5");
    expect(instance.getDebugInfo()).toContain("ScriptId: 0");
  });

  test("a raid takes its reset period from the instance saves", () => {
    MapHooks.instanceSaveMgr = { getResetTimeFor: () => 100, getExtendedResetTimeFor: () => 700 } as never;
    expect(new InstanceMap(RAID, 7, 0, new Map(RAID, 0, 0)).getInstanceResetPeriod()).toBe(600);
    expect(new InstanceMap(DUNGEON, 7, 0, parent).getInstanceResetPeriod()).toBe(0);
  });

  test("CannotEnter: game masters, the player cap, players already inside, and groups", () => {
    const gm = visitor(1);
    gm.isGameMaster = () => true;
    expect(instance.cannotEnter(gm)).toBe(CAN_ENTER);

    const inside = playerOn(instance, 2, 0, 0);
    const lone = visitor(3);
    // someone is inside and the visitor has no group
    expect(instance.cannotEnter(lone)).toBe(CANNOT_ENTER_INSTANCE_BIND_MISMATCH);
    expect(lone.aborted).toEqual([[DUNGEON, 2]]);
    // the same group is welcome, another group is not
    const group = {};
    (inside as unknown as { getGroup: () => unknown }).getGroup = () => group;
    lone.group = group;
    expect(instance.cannotEnter(lone)).toBe(CAN_ENTER);
    lone.group = {};
    expect(instance.cannotEnter(lone)).toBe(CANNOT_ENTER_INSTANCE_BIND_MISMATCH);
    // a player that is on the map already
    expect(instance.cannotEnter(inside)).toBe(CANNOT_ENTER_ALREADY_IN_MAP);
    expect(instance.cannotEnter(inside, true)).toBe(CAN_ENTER);
    inside.mapRef.unlink();
  });

  test("CannotEnter refuses a full instance, with one more seat at login", () => {
    const players = [1, 2, 3, 4].map((n) => playerOn(instance, n, 0, 0));
    const group = {};
    for (const p of players) (p as unknown as { getGroup: () => unknown }).getGroup = () => group;
    const next = visitor(9);
    next.group = group;
    expect(instance.cannotEnter(next)).toBe(CANNOT_ENTER_MAX_PLAYERS);
    expect(next.aborted).toEqual([[DUNGEON, 2]]);
    expect(instance.cannotEnter(next, true)).toBe(CAN_ENTER);
    for (const p of players) p.mapRef.unlink();
  });

  test("a raid with an encounter in progress cannot be entered", () => {
    const script = scriptStub();
    MapHooks.createInstanceScript = () => script;
    const raid = new InstanceMap(RAID, 8, 0, new Map(RAID, 0, 0));
    raid.createInstanceScript(false, "", 0);
    expect(raid.getInstanceScript()).toBe(script);
    // `GetInstanceTemplate` needs the instance_template row for the script id; without it no script is made
    script.encounterInProgress = true;
    const player = visitor(1);
    expect(raid.cannotEnter(player)).toBe(CANNOT_ENTER_ZONE_IN_COMBAT);
    expect(player.aborted).toEqual([[RAID, 6]]);
  });

  test("AddPlayerToMap resets the unload timer and tells the instance script", () => {
    const script = scriptStub();
    MapHooks.createInstanceScript = () => script;
    instance.createInstanceScript(true, "state", 3);
    expect(script.masks).toEqual([3]);
    const player = playerOn(instance, 1, cellCenter(386), cellCenter(260), 4);
    expect(instance.addPlayerToMap(player)).toBe(true);
    expect(instance.canUnload(5000)).toBe(false);
    expect(script.entered).toEqual([player]);
    instance.update(10, 10);
    instance.update(0, 10);
    expect(script.updates).toEqual([10]);
    instance.removePlayerFromMap(player, false);
    expect(script.left).toEqual([player]);
    player.mapRef.unlink();
    instance.afterPlayerUnlinkFromMap();
    expect(instance.canUnload(2000)).toBe(true);
  });

  test("an instance bound to a save refuses a player bound to another save", () => {
    const save = (id: number): MapInstanceSave => ({
      getMapId: () => DUNGEON,
      getInstanceId: () => id,
      getDifficulty: () => 0,
      canReset: () => true,
      getInstanceData: () => "",
      getCompletedEncounterMask: () => 0,
    });
    const mine = save(5);
    const other = save(6);
    const bound: unknown[] = [];
    const binds: { perm: boolean; save: MapInstanceSave }[] = [];
    MapHooks.instanceSaveMgr = {
      getResetTimeFor: () => 0,
      getExtendedResetTimeFor: () => 0,
      getInstanceSave: (id: number) => (id === 5 ? mine : null),
      playerGetBoundInstance: () => binds[0] ?? null,
      playerBindToInstance: (_guid: bigint, s: MapInstanceSave) => (bound.push(s), { perm: false, save: s }),
      deleteInstanceSaveIfNeeded: () => {},
    } as never;
    const player = playerOn(instance, 1, cellCenter(386), cellCenter(260), 4);
    expect(instance.addPlayerToMap(player)).toBe(true);
    expect(bound).toEqual([mine]);
    instance.removePlayerFromMap(player, false);
    binds.push({ perm: true, save: other });
    expect(instance.addPlayerToMap(player)).toBe(false);
    // an instance without a save is not entered at all
    const orphan = new InstanceMap(DUNGEON, 99, 0, parent);
    binds.length = 0;
    const stranger = playerOn(orphan, 2, cellCenter(386), cellCenter(260), 4);
    expect(orphan.addPlayerToMap(stranger)).toBe(false);
    stranger.mapRef.unlink();
    orphan.unloadAll();
    player.mapRef.unlink();
  });

  test("Reset: global resets teleport players out, others only mark an empty instance", () => {
    const player = playerOn(instance, 1, cellCenter(386), cellCenter(260), 4);
    const failed: number[] = [];
    let repopped = 0;
    (player as unknown as { sendResetFailedNotify: (m: number) => void }).sendResetFailedNotify = (m) => void failed.push(m);
    (player as unknown as { repopAtGraveyard: () => void }).repopAtGraveyard = () => void ++repopped;
    expect(instance.reset(INSTANCE_RESET_ALL)).toBe(false);
    expect(failed).toEqual([DUNGEON]);
    expect(instance.reset(INSTANCE_RESET_GLOBAL, [player.getGUID()])).toBe(false);
    expect(repopped).toBe(0);
    expect(instance.reset(INSTANCE_RESET_GLOBAL)).toBe(false);
    expect(repopped).toBe(1);
    player.mapRef.unlink();
    // nobody inside: the instance is marked and refuses entry; unloading deletes its saved respawn times
    sMapRespawnStore.replace(SPAWN_TYPE_CREATURE, DUNGEON, 5, 1, 1000);
    expect(instance.reset(INSTANCE_RESET_ALL)).toBe(true);
    const late = playerOn(instance, 2, cellCenter(386), cellCenter(260), 4);
    expect(instance.addPlayerToMap(late)).toBe(false);
    late.mapRef.unlink();
    instance.unloadAll();
    expect(sMapRespawnStore.creatureRespawns(DUNGEON, 5).size).toBe(0);
  });

  test("UnloadAll asserts that nobody is inside", () => {
    const player = playerOn(instance, 1, 0, 0);
    expect(() => instance.unloadAll()).toThrow();
    player.mapRef.unlink();
  });
});

describe("BattlegroundMap", () => {
  const bg = (): MapBattleground & { left: unknown[]; spectators: unknown[]; map: unknown } => {
    const stub = {
      left: [] as unknown[],
      spectators: [] as unknown[],
      map: undefined as unknown,
      setBgMap: (m: unknown) => void (stub.map = m),
      removePlayerAtLeave: (p: unknown) => void stub.left.push(p),
      removeSpectator: (p: unknown) => void stub.spectators.push(p),
      getStatus: () => 3,
      getMapId: () => ARENA,
      getMinLevel: () => 80,
      getSpectators: () => new Set<bigint>(),
    };
    return stub;
  };

  test("only players of its battleground may enter", () => {
    const arena = new BattlegroundMap(ARENA, 4, parent, 0);
    const player = visitor(1);
    player.getBattlegroundId = () => 9;
    expect(arena.cannotEnter(player)).toBe(CANNOT_ENTER_INSTANCE_BIND_MISMATCH);
    player.getBattlegroundId = () => 4;
    expect(arena.cannotEnter(player)).toBe(CAN_ENTER);
    arena.unloadAll();
  });

  test("entering and leaving an arena applies and removes the preparation aura, and tells the battleground", () => {
    const arena = new BattlegroundMap(ARENA, 4, parent, 0);
    const stub = bg();
    arena.setBG(stub);
    const player = playerOn(arena, 1, cellCenter(386), cellCenter(260), 4);
    const spells: number[] = [];
    const removed: number[] = [];
    (player as unknown as { castSpell: (t: unknown, id: number) => void }).castSpell = (_t, id) => void spells.push(id);
    (player as unknown as { removeAura: (id: number) => void }).removeAura = (id) => void removed.push(id);
    expect(arena.addPlayerToMap(player)).toBe(true);
    expect((player as unknown as { m_InstanceValid?: boolean }).m_InstanceValid).toBe(true);
    expect(spells).toEqual([100102]);
    arena.removePlayerFromMap(player, false);
    expect(stub.left).toEqual([player]);
    expect(stub.spectators).toEqual([player]);
    expect(removed).toEqual([100102]);
    player.mapRef.unlink();
    arena.unloadAll();
  });

  test("RemoveAllPlayers sends the players home, SetUnload arms the timer, the destructor unlinks the battleground", () => {
    const arena = new BattlegroundMap(ARENA, 4, parent, 0);
    const stub = bg();
    arena.setBG(stub);
    const player = playerOn(arena, 1, cellCenter(386), cellCenter(260), 4);
    let home = 0;
    (player as unknown as { teleportToEntryPoint: () => void }).teleportToEntryPoint = () => void ++home;
    arena.removeAllPlayers();
    expect(home).toBe(1);
    player.mapRef.unlink();
    arena.setUnload();
    expect(arena.canUnload(1)).toBe(true);
    arena.destroy();
    expect(arena.getBG()).toBeNull();
    expect(stub.map).toBeNull();
    arena.unloadAll();
  });
});

describe("transports and corpses", () => {
  test("a transport is created for the players, kept in the map, and destroyed for them", () => {
    const map = new Map(DUNGEON, 0, 0);
    const player = playerOn(map, 1, cellCenter(386), cellCenter(260), 4);
    map.addPlayerToMap(player);
    const go = new FakeGameObject(new FakeObjectMgr(), 40, cellCenter(386), cellCenter(260), 0);
    go.setMap(map);
    const before = player.received.length;
    expect(map.addTransportToMap(go)).toBe(true);
    expect(go.isInWorld()).toBe(true);
    expect(map.getAllTransports().has(go)).toBe(true);
    expect(player.received.length - before).toBe(1);
    // the player that joins later is sent the transports
    expect(map.allTransportsEmpty()).toBe(true);
    map.removeTransportFromMap(go, false);
    expect(map.getAllTransports().has(go)).toBe(false);
    expect(player.received.length - before).toBe(2);
    expect(go.isInWorld()).toBe(false);
    player.mapRef.unlink();
    map.unloadAll();
  });
});
