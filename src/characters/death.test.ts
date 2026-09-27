import { testDatabase } from "../database/test-db.ts";
import { worldFromSql } from "../database/test-world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { describe, expect, test } from "bun:test";
import { IN_MILLISECONDS } from "../common/duration.ts";
import { ByteReader } from "../net/byte-buffer.ts";
import {
  ALLIANCE_DEFAULT_GRAVEYARD,
  FACTION_ALLIANCE,
  HORDE_DEFAULT_GRAVEYARD,
  loadGraveyardStore,
} from "./graveyard.ts";
import {
  buildCorpseQueryResponse,
  buildCorpseReclaimDelay,
  buildResurrectRequest,
  CORPSE_RECLAIM_DELAY_SEC,
  CORPSE_RESURRECTABLE_PVE,
  DEATH_EXPIRE_STEP,
  getCorpseReclaimDelay,
  handleResurrectResponse,
  loadCorpse,
  MSG_CORPSE_QUERY,
  onDeath,
  PLAYER_FLAGS_GHOST,
  reclaimCorpse,
  releaseSpirit,
  SMSG_CORPSE_RECLAIM_DELAY,
  SMSG_RESURRECT_REQUEST,
  spiritHealerResurrect,
  type PlayerDeathFields,
  updateCorpseReclaimDelay,
} from "./death.ts";

function openCharsDb() {
  return testDatabase("characters");
}

function openWorldDb(): WorldTables {
  return worldFromSql(`
    INSERT INTO game_graveyard (ID, Map, x, y, z, Comment) VALUES
      (105, 0, -8935.33, -188.646, 80.4165, 'Northshire'),
      (106, 0, -9339.46, 171.408, 61.5618, 'Goldshire'),
      (${ALLIANCE_DEFAULT_GRAVEYARD}, 0, -10546.9, 1197.24, 31.7263, 'Westfall'),
      (${HORDE_DEFAULT_GRAVEYARD}, 1, -592.601, -2523.49, 91.788, 'Crossroads');
    INSERT INTO graveyard_zone (ID, GhostZone, Faction, Comment) VALUES
      (105, 12, ${FACTION_ALLIANCE}, 'Northshire'),
      (106, 12, ${FACTION_ALLIANCE}, 'Goldshire');
  `);
}

function samplePlayer(overrides: Partial<PlayerDeathFields> = {}): PlayerDeathFields {
  return {
    guid: 1,
    race: 1,
    class: 1,
    gender: 0,
    skin: 1,
    face: 2,
    hairStyle: 3,
    hairColor: 4,
    facialStyle: 5,
    health: 0,
    maxHealth: 100,
    power1: 0,
    maxPower1: 50,
    playerFlags: 0,
    extraFlags: 0,
    deathExpireTime: 0,
    deathState: "alive",
    map: 0,
    zone: 12,
    areaId: 0,
    position_x: -8900,
    position_y: -200,
    position_z: 80,
    orientation: 1.5,
    displayId: 49,
    guildId: 0,
    instanceId: 0,
    phaseMask: 1,
    ...overrides,
  };
}

describe("death / corpse", () => {
  test("onDeath zeroes health, sets corpse state, and updates death_expire_time", () => {
    const now = 1_000_000;
    const death = onDeath(samplePlayer({ deathExpireTime: 0 }), { now });
    expect(death.health).toBe(0);
    expect(death.deathState).toBe("corpse");
    expect(death.deathExpireTime).toBe(now + DEATH_EXPIRE_STEP);
    expect(death.packets[0]?.opcode).toBe(SMSG_CORPSE_RECLAIM_DELAY);
    expect(death.corpseReclaimDelayMs).toBe(CORPSE_RECLAIM_DELAY_SEC[0]! * IN_MILLISECONDS);
  });

  test("release spirit creates corpse, sets ghost, and returns closest graveyard teleport", async () => {
    const chars = await openCharsDb();
    const world = openWorldDb();
    const store = loadGraveyardStore(world);
    const now = 1_000_000;

    const killed = onDeath(samplePlayer(), { now });
    const player = samplePlayer({
      health: killed.health,
      deathState: killed.deathState,
      deathExpireTime: killed.deathExpireTime,
    });

    const repop = await releaseSpirit(chars, player, store, { now });
    expect(repop.health).toBe(1);
    expect(repop.playerFlags & PLAYER_FLAGS_GHOST).toBe(PLAYER_FLAGS_GHOST);
    expect(repop.deathState).toBe("dead");
    expect(repop.teleport?.map).toBe(0);
    expect(repop.teleport?.x).toBeCloseTo(-8935.33, 1);

    const corpse = await loadCorpse(chars, 1);
    expect(corpse).not.toBeNull();
    expect(corpse!.posX).toBeCloseTo(-8900, 1);
    expect(corpse!.mapId).toBe(0);
    expect(corpse!.corpseType).toBe(CORPSE_RESURRECTABLE_PVE);
    expect(corpse!.displayId).toBe(49);
    expect(corpse!.itemCache.split(" ").length).toBe(19);
  });

  test("reclaim delay escalates across rapid deaths", () => {
    const now = 1_000_000;
    let expire = 0;
    expire = updateCorpseReclaimDelay(expire, false, now);
    expect(getCorpseReclaimDelay(expire, false, now)).toBe(30);

    expire = updateCorpseReclaimDelay(expire, false, now + 60);
    expect(getCorpseReclaimDelay(expire, false, now + 60)).toBe(60);

    expire = updateCorpseReclaimDelay(expire, false, now + 120);
    expect(getCorpseReclaimDelay(expire, false, now + 120)).toBe(120);

    const body = buildCorpseReclaimDelay(30_000);
    expect(new ByteReader(body).readU32()).toBe(30_000);
  });

  test("resurrect accept clears ghost and deletes corpse; decline keeps request cleared", async () => {
    const chars = await openCharsDb();
    const world = openWorldDb();
    const store = loadGraveyardStore(world);
    const now = 1_000_000;

    const killed = onDeath(samplePlayer(), { now });
    const ghosted = await releaseSpirit(
      chars,
      samplePlayer({
        health: killed.health,
        deathState: killed.deathState,
        deathExpireTime: killed.deathExpireTime,
      }),
      store,
      { now },
    );

    const ghostPlayer = samplePlayer({
      health: ghosted.health,
      playerFlags: ghosted.playerFlags,
      deathState: ghosted.deathState,
      deathExpireTime: killed.deathExpireTime,
    });

    const declined = await handleResurrectResponse(chars, ghostPlayer, {
      guid: 99n,
      mapId: 0,
      x: 1,
      y: 2,
      z: 3,
      health: 80,
      mana: 40,
    }, 0);
    expect(declined).toEqual({ declined: true });
    expect(await loadCorpse(chars, 1)).not.toBeNull();

    const accepted = await handleResurrectResponse(chars, ghostPlayer, {
      guid: 99n,
      mapId: 0,
      x: 10,
      y: 20,
      z: 30,
      health: 80,
      mana: 40,
    }, 1);
    expect(accepted && "declined" in accepted).toBe(false);
    if (accepted && !("declined" in accepted)) {
      expect(accepted.playerFlags & PLAYER_FLAGS_GHOST).toBe(0);
      expect(accepted.deathState).toBe("alive");
      expect(accepted.health).toBe(80);
      expect(accepted.power1).toBe(40);
      expect(accepted.teleport).toEqual({ map: 0, x: 10, y: 20, z: 30, o: 1.5 });
    }
    expect(await loadCorpse(chars, 1)).toBeNull();
  });

  test("corpse reclaim restores 50% and deletes corpse after delay", async () => {
    const chars = await openCharsDb();
    const world = openWorldDb();
    const store = loadGraveyardStore(world);
    const now = 1_000_000;

    const killed = onDeath(samplePlayer(), { now });
    const ghosted = await releaseSpirit(
      chars,
      samplePlayer({
        health: killed.health,
        deathState: killed.deathState,
        deathExpireTime: killed.deathExpireTime,
      }),
      store,
      { now },
    );

    const tooSoon = await reclaimCorpse(
      chars,
      samplePlayer({
        health: ghosted.health,
        playerFlags: ghosted.playerFlags,
        deathState: ghosted.deathState,
        deathExpireTime: killed.deathExpireTime,
        position_x: -8900,
        position_y: -200,
        position_z: 80,
      }),
      { now: now + 10 },
    );
    expect(tooSoon).toBeNull();

    const reclaimed = await reclaimCorpse(
      chars,
      samplePlayer({
        health: ghosted.health,
        playerFlags: ghosted.playerFlags,
        deathState: ghosted.deathState,
        deathExpireTime: killed.deathExpireTime,
        position_x: -8900,
        position_y: -200,
        position_z: 80,
      }),
      { now: now + 31 },
    );
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.health).toBe(50);
    expect(reclaimed!.playerFlags & PLAYER_FLAGS_GHOST).toBe(0);
    expect(await loadCorpse(chars, 1)).toBeNull();
  });

  test("spirit healer resurrects at 50% with sickness and clears corpse", async () => {
    const chars = await openCharsDb();
    const world = openWorldDb();
    const store = loadGraveyardStore(world);
    const now = 1_000_000;

    const killed = onDeath(samplePlayer(), { now });
    const ghosted = await releaseSpirit(
      chars,
      samplePlayer({
        health: killed.health,
        deathState: killed.deathState,
        deathExpireTime: killed.deathExpireTime,
      }),
      store,
      { now },
    );

    // Ghost standing at Goldshire GY while corpse is still at Northshire death spot.
    const result = await spiritHealerResurrect(
      chars,
      samplePlayer({
        health: ghosted.health,
        playerFlags: ghosted.playerFlags,
        deathState: ghosted.deathState,
        position_x: -9339,
        position_y: 171,
        position_z: 62,
      }),
      store,
    );
    expect(result.health).toBe(50);
    expect(result.applySickness).toBe(true);
    expect(result.playerFlags & PLAYER_FLAGS_GHOST).toBe(0);
    expect(await loadCorpse(chars, 1)).toBeNull();
  });

  test("SMSG_RESURRECT_REQUEST and MSG_CORPSE_QUERY layouts", () => {
    const request = buildResurrectRequest({
      guid: 0x0000000000000064n,
      mapId: 0,
      x: 1,
      y: 2,
      z: 3,
      health: 100,
      mana: 50,
      fromCreature: true,
      casterName: "Priest",
    });
    const reader = new ByteReader(request);
    expect(reader.readU64()).toBe(0x64n);
    expect(reader.readU32()).toBe(7);
    expect(reader.readCString()).toBe("Priest");
    expect(reader.readU8()).toBe(1);
    expect(SMSG_RESURRECT_REQUEST).toBe(0x15b);

    const found = buildCorpseQueryResponse({
      guid: 1,
      posX: 1,
      posY: 2,
      posZ: 3,
      orientation: 0,
      mapId: 0,
      phaseMask: 1,
      displayId: 1,
      itemCache: "",
      bytes1: 0,
      bytes2: 0,
      guildId: 0,
      flags: 0,
      dynFlags: 0,
      time: 0,
      corpseType: 1,
      instanceId: 0,
    });
    const cq = new ByteReader(found);
    expect(cq.readU8()).toBe(1);
    expect(cq.readU32()).toBe(0);
    expect(cq.readF32()).toBeCloseTo(1);
    expect(cq.readF32()).toBeCloseTo(2);
    expect(cq.readF32()).toBeCloseTo(3);
    expect(cq.readU32()).toBe(0);
    expect(cq.readU32()).toBe(0);

    const missing = buildCorpseQueryResponse(null);
    expect(new ByteReader(missing).readU8()).toBe(0);
    expect(MSG_CORPSE_QUERY).toBe(0x216);
  });
});
