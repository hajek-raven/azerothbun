import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { instance_template } from "../../database/schema/world.ts";
import { WorldTables } from "../../database/world-tables.ts";
import { CORPSE_FIELD_FLAGS } from "../../gen/UpdateFields.gen.ts";
import { Corpse, CORPSE_BONES, CORPSE_FLAG_BONES, CORPSE_RESURRECTABLE_PVE, type CorpseType } from "../Entities/Corpse/Corpse.ts";
import { HighGuid, ObjectGuid } from "../Entities/Object/ObjectGuid.ts";
import { sMapDifficultyStore } from "../DataStores/DBCStores.ts";
import { resetMapDBCStores } from "../DataStores/MapDBCStores.ts";
import { sCharacterCache } from "../Cache/CharacterCache.ts";
import { FakeCreature, FakeObjectMgr, FakePlayer } from "../Grids/Grids.test-util.ts";
import { resetGameTimeForTests } from "../time/game-time.ts";
import { ServerConfig } from "../world/world-config-data.ts";
import { sWorld } from "../world/world.ts";
import {
  CANNOT_ENTER_CORPSE_IN_DIFFERENT_INSTANCE,
  CANNOT_ENTER_DIFFICULTY_UNAVAILABLE,
  CANNOT_ENTER_NO_ENTRY,
  CANNOT_ENTER_NOT_IN_RAID,
  CANNOT_ENTER_UNINSTANCED_DUNGEON,
  CAN_ENTER,
  ENCOUNTER_CREDIT_KILL_CREATURE,
  Map,
  MapHooks,
  type MapInstanceScript,
  type MapPlayer,
} from "./Map.ts";
import { cellCenter, MAP_COMMON, MAP_INSTANCE, MAP_RAID, setMapEntry, TEST_MAP_ID } from "./Map.test-util.ts";
import { sMapMgr } from "./MapMgr.ts";
import { setMapMgrWorld } from "./MapMgrStatics.ts";

class TestCorpse extends Corpse {
  deleted = 0;
  override deleteFromDB(): void {
    ++this.deleted;
  }
}

const savedHooks = { ...MapHooks };
const X = cellCenter(386);
const Y = cellCenter(260);
const OWNER = 4001;

let map: Map;

/** A corpse of `OWNER` standing in the loaded grid of `map`. */
function corpseOfOwner(type: CorpseType = CORPSE_RESURRECTABLE_PVE): TestCorpse {
  const corpse = new TestCorpse(type);
  corpse.create(55, {
    getGUID: () => ObjectGuid.Create(HighGuid.Player, OWNER),
    getName: () => "Owner",
    getPositionX: () => X,
    getPositionY: () => Y,
    getPositionZ: () => 5,
    getOrientation: () => 0,
    getPhaseMask: () => 1,
  });
  corpse.setMap(map);
  return corpse;
}

beforeEach(() => {
  resetGameTimeForTests();
  setMapEntry(TEST_MAP_ID, MAP_COMMON);
  MapHooks.createCorpse = (type) => new TestCorpse(type as 0);
  map = new Map(TEST_MAP_ID, 0, 0);
  map.loadGrid(X, Y);
});

afterEach(() => {
  map.unloadAll();
  Object.assign(MapHooks, savedHooks);
  sWorld().setBoolConfig(ServerConfig.CONFIG_DEATH_BONES_WORLD, true);
});

describe("corpses", () => {
  test("a corpse is looked up by its owner and removed again", () => {
    const corpse = corpseOfOwner();
    map.addCorpse(corpse);
    expect(map.getCorpseByPlayer(corpse.getOwnerGUID())).toBe(corpse);
    map.addToMap(corpse);
    expect(map.getCorpse(corpse.getGUID())).toBe(corpse);
    map.removeCorpse(corpse);
    expect(map.getCorpseByPlayer(corpse.getOwnerGUID())).toBeNull();
    expect(corpse.isInWorld()).toBe(false);
  });

  test("ConvertCorpseToBones deletes the corpse row and creates bones with the same fields", () => {
    const corpse = corpseOfOwner();
    map.addCorpse(corpse);
    map.addToMap(corpse);
    const bones = map.convertCorpseToBones(corpse.getOwnerGUID())!;
    expect(corpse.deleted).toBe(1);
    expect(bones).not.toBeNull();
    expect(bones.getType()).toBe(CORPSE_BONES);
    expect(bones.getOwnerGUID()).toBe(corpse.getOwnerGUID());
    expect(bones.getUInt32Value(CORPSE_FIELD_FLAGS) & CORPSE_FLAG_BONES).toBe(CORPSE_FLAG_BONES);
    expect(bones.getPositionX()).toBeCloseTo(X, 3);
    expect(bones.isInWorld()).toBe(true);
    expect(map.getCorpseByPlayer(corpse.getOwnerGUID())).toBeNull();
    expect(map.getCorpse(bones.getGUID())).toBe(bones);
    expect(map.convertCorpseToBones(corpse.getOwnerGUID())).toBeNull();
  });

  test("no bones are made when the option is off, unless it is an insignia", () => {
    sWorld().setBoolConfig(ServerConfig.CONFIG_DEATH_BONES_WORLD, false);
    const corpse = corpseOfOwner();
    map.addCorpse(corpse);
    expect(map.convertCorpseToBones(corpse.getOwnerGUID())).toBeNull();
    const second = corpseOfOwner();
    map.addCorpse(second);
    expect(map.convertCorpseToBones(second.getOwnerGUID(), true)).not.toBeNull();
  });

  test("RemoveOldCorpses turns the corpse of a deleted character into bones, then removes the expired bones", () => {
    const corpse = corpseOfOwner();
    map.addCorpse(corpse);
    map.addToMap(corpse);
    // the owner is not in the character cache: the corpse counts as expired
    expect(sCharacterCache.getCharacterCacheByGuid(OWNER)).toBeNull();
    map.removeOldCorpses();
    expect(map.getCorpseByPlayer(corpse.getOwnerGUID())).toBeNull();
    expect(corpse.deleted).toBe(1);
    // the bones of a deleted character are expired too, so the same sweep removes them
    expect(map.getCorpsesInGrid(32 * 64 + 48)?.size).toBe(0);
  });

  test("UpdateExpiredCorpses sweeps every twenty minutes", () => {
    const corpse = corpseOfOwner();
    map.addCorpse(corpse);
    map.addToMap(corpse);
    map.updateExpiredCorpses(1000);
    expect(map.getCorpseByPlayer(corpse.getOwnerGUID())).toBe(corpse);
    map.updateExpiredCorpses(20 * 60 * 1000);
    expect(map.getCorpseByPlayer(corpse.getOwnerGUID())).toBeNull();
  });

  test("UnloadAll takes the corpses out of the world", () => {
    const corpse = corpseOfOwner();
    map.addCorpse(corpse);
    map.addToMap(corpse);
    map.unloadAll();
    expect(corpse.isInWorld()).toBe(false);
    expect(map.getCorpseByPlayer(corpse.getOwnerGUID())).toBeNull();
  });

  test("LoadCorpseData and DeleteCorpseData need a database and do nothing without one", async () => {
    await map.loadCorpseData();
    map.deleteCorpseData();
    expect(map.getCorpsesInGrid(32 * 64 + 48)).toBeNull();
  });
});

describe("encounters", () => {
  test("UpdateEncounterState credits the encounter to the instance script of the source", () => {
    const script: Pick<MapInstanceScript, "setCompletedEncountersMask" | "getCompletedEncounterMask"> & { masks: number[] } = {
      masks: [],
      setCompletedEncountersMask: (mask) => void script.masks.push(mask),
      getCompletedEncounterMask: () => 1,
    };
    const asked: [number, number][] = [];
    MapHooks.objectMgr = {
      getDungeonEncounterList: (mapId: number, difficulty: number) => {
        asked.push([mapId, difficulty]);
        return [
          { dbcEntry: { encounterIndex: 3 }, creditType: ENCOUNTER_CREDIT_KILL_CREATURE, creditEntry: 77, lastEncounterDungeon: 0 },
          { dbcEntry: { encounterIndex: 4 }, creditType: ENCOUNTER_CREDIT_KILL_CREATURE, creditEntry: 78, lastEncounterDungeon: 5 },
        ];
      },
    } as never;
    const boss = new FakeCreature(new FakeObjectMgr(), 1, X, Y, 0) as FakeCreature & { getInstanceScript?: () => unknown };
    boss.getInstanceScript = (() => script) as never;
    map.updateEncounterState(ENCOUNTER_CREDIT_KILL_CREATURE, 77, boss);
    expect(script.masks).toEqual([(1 << 3) | 1]);
    expect(asked).toEqual([[TEST_MAP_ID, 0]]);
    map.updateEncounterState(ENCOUNTER_CREDIT_KILL_CREATURE, 999, boss);
    expect(script.masks).toHaveLength(1);
    // without an encounter list there is nothing to do
    MapHooks.objectMgr = null;
    map.updateEncounterState(ENCOUNTER_CREDIT_KILL_CREATURE, 77, boss);
    expect(script.masks).toHaveLength(1);
  });
});

describe("MapMgr::PlayerCannotEnter", () => {
  const DUNGEON = 941;
  const RAID = 942;
  const NO_TEMPLATE = 943;
  const NO_DIFFICULTY = 944;

  type EntryPlayer = FakePlayer & Partial<MapPlayer> & { sent: [number, number][] };
  const entry = (guidLow: number): EntryPlayer => {
    const p = new FakePlayer(guidLow, 0, 0, 0) as EntryPlayer;
    p.sent = [];
    p.getDifficulty = () => 0;
    p.sendTransferAborted = (mapId, reason) => void p.sent.push([mapId, reason]);
    return p;
  };

  beforeEach(() => {
    setMapEntry(DUNGEON, MAP_INSTANCE);
    setMapEntry(RAID, MAP_RAID);
    setMapEntry(NO_TEMPLATE, MAP_INSTANCE);
    setMapEntry(NO_DIFFICULTY, MAP_INSTANCE);
    setMapMgrWorld(
      WorldTables.fromRows([
        [
          instance_template,
          [
            { map: DUNGEON, parent: 0, script: "", allowMount: 0 },
            { map: RAID, parent: 0, script: "", allowMount: 0 },
            { map: NO_DIFFICULTY, parent: 0, script: "", allowMount: 0 },
          ],
        ],
      ]),
    );
    sMapDifficultyStore.set(1, { MapId: DUNGEON, Difficulty: 0, areaTriggerText: "", resetTime: 0, maxPlayers: 5 });
    sMapDifficultyStore.set(2, { MapId: RAID, Difficulty: 0, areaTriggerText: "", resetTime: 0, maxPlayers: 10 });
    resetMapDBCStores();
  });

  afterEach(() => setMapMgrWorld(null));

  test("unknown maps, open world maps, and dungeons without a template or difficulty", () => {
    expect(sMapMgr().playerCannotEnter(12345, entry(1))).toBe(CANNOT_ENTER_NO_ENTRY);
    expect(sMapMgr().playerCannotEnter(TEST_MAP_ID, entry(1))).toBe(CAN_ENTER);
    expect(sMapMgr().playerCannotEnter(NO_TEMPLATE, entry(1))).toBe(CANNOT_ENTER_UNINSTANCED_DUNGEON);
    const player = entry(2);
    expect(sMapMgr().playerCannotEnter(NO_DIFFICULTY, player)).toBe(CANNOT_ENTER_DIFFICULTY_UNAVAILABLE);
    expect(player.sent).toEqual([[NO_DIFFICULTY, 8]]);
  });

  test("a game master walks in, a raid wants a raid group, the dead need a corpse", () => {
    const gm = entry(3);
    gm.isGameMaster = () => true;
    expect(sMapMgr().playerCannotEnter(RAID, gm)).toBe(CAN_ENTER);

    const messages: [number, string][] = [];
    const player = entry(4) as EntryPlayer & { sendAreaTriggerMessage?: (id: number, name: string) => void };
    player.sendAreaTriggerMessage = (id, name) => void messages.push([id, name]);
    expect(sMapMgr().playerCannotEnter(RAID, player)).toBe(CANNOT_ENTER_NOT_IN_RAID);
    expect(messages).toEqual([[750, `Test map ${RAID}`]]);
    sWorld().setBoolConfig(ServerConfig.CONFIG_INSTANCE_IGNORE_RAID, true);
    try {
      expect(sMapMgr().playerCannotEnter(RAID, player)).toBe(CAN_ENTER);
    } finally {
      sWorld().setBoolConfig(ServerConfig.CONFIG_INSTANCE_IGNORE_RAID, false);
    }

    const ghost = entry(5);
    ghost.alive = false;
    expect(sMapMgr().playerCannotEnter(DUNGEON, ghost)).toBe(CANNOT_ENTER_CORPSE_IN_DIFFERENT_INSTANCE);
    (ghost as unknown as { hasCorpse: () => boolean }).hasCorpse = () => true;
    (ghost as unknown as { getCorpseLocation: () => { getMapId: () => number } }).getCorpseLocation = () => ({ getMapId: () => TEST_MAP_ID });
    expect(sMapMgr().playerCannotEnter(DUNGEON, ghost)).toBe(CANNOT_ENTER_CORPSE_IN_DIFFERENT_INSTANCE);
    expect(ghost.received.at(-1)?.opcode).toBe(0x506);
    (ghost as unknown as { getCorpseLocation: () => { getMapId: () => number } }).getCorpseLocation = () => ({ getMapId: () => DUNGEON });
    expect(sMapMgr().playerCannotEnter(DUNGEON, ghost)).toBe(CAN_ENTER);
  });
});
