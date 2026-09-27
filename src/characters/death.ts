import { eq } from "drizzle-orm";
import type { Db } from "../database/database.ts";
import { corpse as corpseTable } from "../database/schema/characters.ts";
import { DAY, IN_MILLISECONDS, MINUTE } from "../common/duration.ts";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import {
  getClosestGraveyard,
  graveyardTeleport,
  teamIdFromRace,
  type GraveyardStore,
  type GraveyardTeleport,
  type TeamId,
} from "./graveyard.ts";

/** AzerothCore `PlayerFlags::PLAYER_FLAGS_GHOST`. */
export const PLAYER_FLAGS_GHOST = 0x00000010;
export const PLAYER_FLAGS_HIDE_HELM = 0x00000400;
export const PLAYER_FLAGS_HIDE_CLOAK = 0x00000800;

/** AzerothCore `PlayerExtraFlags::PLAYER_EXTRA_PVP_DEATH`. */
export const PLAYER_EXTRA_PVP_DEATH = 0x0100;

/** Corpse reclaim radius (`Corpse.h`). */
export const CORPSE_RECLAIM_RADIUS = 39;

/** `DEATH_EXPIRE_STEP` / `MAX_DEATH_COUNT` (`Player.h`). */
export const DEATH_EXPIRE_STEP = 5 * MINUTE;
export const MAX_DEATH_COUNT = 3;

/** KillPlayer auto-repop timer: 6 minutes. */
export const DEATH_TIMER_MS = 6 * MINUTE * IN_MILLISECONDS;

/** `copseReclaimDelay` (`Player.cpp`) — seconds. */
export const CORPSE_RECLAIM_DELAY_SEC = [30, 60, 120] as const;

export const EQUIPMENT_SLOT_END = 19;

export const CORPSE_BONES = 0;
export const CORPSE_RESURRECTABLE_PVE = 1;
export const CORPSE_RESURRECTABLE_PVP = 2;

export const CORPSE_FLAG_NONE = 0x00;
export const CORPSE_FLAG_BONES = 0x01;
export const CORPSE_FLAG_UNK1 = 0x02;
export const CORPSE_FLAG_UNK2 = 0x04;
export const CORPSE_FLAG_HIDE_HELM = 0x08;
export const CORPSE_FLAG_HIDE_CLOAK = 0x10;
export const CORPSE_FLAG_LOOTABLE = 0x20;

export const CLASS_DEATH_KNIGHT = 6;

/** Opcodes the parent session wires for death / corpse / resurrect. */
export const CMSG_REPOP_REQUEST = 0x15a;
export const SMSG_RESURRECT_REQUEST = 0x15b;
export const CMSG_RESURRECT_RESPONSE = 0x15c;
export const CMSG_RECLAIM_CORPSE = 0x1d2;
export const MSG_CORPSE_QUERY = 0x216;
export const CMSG_SPIRIT_HEALER_ACTIVATE = 0x21c;
export const SMSG_CORPSE_RECLAIM_DELAY = 0x269;
export const SMSG_DEATH_RELEASE_LOC = 0x378;
export const SMSG_PRE_RESURRECT = 0x494;

export type DeathState = "alive" | "justDied" | "corpse" | "dead" | "justRespawned";

export type CorpseRow = {
  guid: number;
  posX: number;
  posY: number;
  posZ: number;
  orientation: number;
  mapId: number;
  phaseMask: number;
  displayId: number;
  itemCache: string;
  bytes1: number;
  bytes2: number;
  guildId: number;
  flags: number;
  dynFlags: number;
  time: number;
  corpseType: number;
  instanceId: number;
};

export type PlayerDeathFields = {
  guid: number;
  race: number;
  class: number;
  gender: number;
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialStyle: number;
  health: number;
  maxHealth: number;
  power1: number;
  maxPower1: number;
  playerFlags: number;
  extraFlags: number;
  deathExpireTime: number;
  deathState: DeathState;
  map: number;
  zone: number;
  areaId?: number;
  position_x: number;
  position_y: number;
  position_z: number;
  orientation: number;
  displayId?: number;
  guildId?: number;
  instanceId?: number;
  phaseMask?: number;
  /** 19 equipment display values (`displayId | inventoryType << 24`), space-joined like SaveToDB. */
  itemCache?: string;
  /** In-battleground reclaim restores 100%. */
  inBattleground?: boolean;
};

export type ResurrectRequestData = {
  guid: bigint;
  mapId: number;
  x: number;
  y: number;
  z: number;
  health: number;
  mana: number;
  /** Creature casters set sickness hint on SMSG_RESURRECT_REQUEST. */
  fromCreature?: boolean;
  casterName?: string;
  /** When set, appends the NO_RES_TIMER override dword (usually 0). */
  noResTimer?: boolean;
};

export type DeathConfig = {
  /** `Death.CorpseReclaimDelay.PvP` — default true. */
  corpseReclaimDelayPvp?: boolean;
  /** `Death.CorpseReclaimDelay.PvE` — default true. */
  corpseReclaimDelayPve?: boolean;
  /** Unix seconds; defaults to `Math.floor(Date.now() / 1000)`. */
  now?: number;
};

export type OnDeathResult = {
  health: number;
  playerFlags: number;
  deathState: DeathState;
  deathExpireTime: number;
  deathTimerMs: number;
  extraFlags: number;
  corpseReclaimDelayMs: number;
  packets: { opcode: number; body: Uint8Array }[];
};

export type ReleaseSpiritResult = {
  health: number;
  playerFlags: number;
  deathState: DeathState;
  corpse: CorpseRow;
  teleport: GraveyardTeleport | null;
  deathReleaseLoc: { map: number; x: number; y: number; z: number } | null;
  packets: { opcode: number; body: Uint8Array }[];
};

export type ResurrectResult = {
  health: number;
  power1: number;
  playerFlags: number;
  deathState: DeathState;
  teleport: GraveyardTeleport | null;
  applySickness: boolean;
  packets: { opcode: number; body: Uint8Array }[];
};

export function emptyItemCache(): string {
  return Array.from({ length: EQUIPMENT_SLOT_END }, () => "0").join(" ");
}

export function corpseBytes1(race: number, gender: number, skin: number): number {
  return ((0x00) | (race << 8) | (gender << 16) | (skin << 24)) >>> 0;
}

export function corpseBytes2(face: number, hairStyle: number, hairColor: number, facialStyle: number): number {
  return (face | (hairStyle << 8) | (hairColor << 16) | (facialStyle << 24)) >>> 0;
}

/**
 * `Player::KillPlayer` — health already 0 from combat/fall. Does not create the corpse
 * (corpse is created in `releaseSpirit` / `BuildPlayerRepop`).
 */
export function onDeath(player: PlayerDeathFields, config: DeathConfig = {}): OnDeathResult {
  const now = config.now ?? Math.floor(Date.now() / 1000);
  const pvp = (player.extraFlags & PLAYER_EXTRA_PVP_DEATH) !== 0;
  const deathExpireTime = updateCorpseReclaimDelay(player.deathExpireTime, pvp, now, config);
  const corpseReclaimDelaySec = getCorpseReclaimDelay(deathExpireTime, pvp, now, config);
  const corpseReclaimDelayMs = corpseReclaimDelaySec * IN_MILLISECONDS;

  const packets: { opcode: number; body: Uint8Array }[] = [];
  if (corpseReclaimDelayMs >= 0) {
    packets.push({
      opcode: SMSG_CORPSE_RECLAIM_DELAY,
      body: buildCorpseReclaimDelay(corpseReclaimDelayMs),
    });
  }

  return {
    health: 0,
    playerFlags: player.playerFlags,
    deathState: "corpse",
    deathExpireTime,
    deathTimerMs: DEATH_TIMER_MS,
    extraFlags: player.extraFlags,
    corpseReclaimDelayMs,
    packets,
  };
}

/**
 * `HandleRepopRequestOpcode` → `BuildPlayerRepop` + `RepopAtGraveyard`.
 * Creates the corpse row, sets ghost, returns graveyard teleport (caller teleports).
 */
export async function releaseSpirit(
  db: Db,
  player: PlayerDeathFields,
  store: GraveyardStore,
  config: DeathConfig = {},
): Promise<ReleaseSpiritResult> {
  const now = config.now ?? Math.floor(Date.now() / 1000);
  const teamId = teamIdFromRace(player.race);
  const pvp = (player.extraFlags & PLAYER_EXTRA_PVP_DEATH) !== 0;

  const corpse = createCorpseRow(player, pvp ? CORPSE_RESURRECTABLE_PVP : CORPSE_RESURRECTABLE_PVE, now);
  await saveCorpse(db, corpse);

  const playerFlags = (player.playerFlags | PLAYER_FLAGS_GHOST) >>> 0;
  const packets: { opcode: number; body: Uint8Array }[] = [
    { opcode: SMSG_PRE_RESURRECT, body: buildPreResurrect(BigInt(player.guid)) },
  ];

  const reclaimMs = calculateCorpseReclaimDelayMs(null, player.deathExpireTime, pvp, now, config, false);
  if (reclaimMs >= 0) {
    packets.push({
      opcode: SMSG_CORPSE_RECLAIM_DELAY,
      body: buildCorpseReclaimDelay(reclaimMs),
    });
  }

  const gy = getClosestGraveyard(store, {
    mapId: player.map,
    x: player.position_x,
    y: player.position_y,
    z: player.position_z,
    teamId,
    areaId: player.areaId ?? 0,
    zoneId: player.zone,
    isDeathKnight: player.class === CLASS_DEATH_KNIGHT,
  });

  let teleport: GraveyardTeleport | null = null;
  let deathReleaseLoc: ReleaseSpiritResult["deathReleaseLoc"] = null;
  if (gy) {
    teleport = graveyardTeleport(gy, player.orientation);
    deathReleaseLoc = { map: gy.Map, x: gy.x, y: gy.y, z: gy.z };
    packets.push({
      opcode: SMSG_DEATH_RELEASE_LOC,
      body: buildDeathReleaseLoc(gy.Map, gy.x, gy.y, gy.z),
    });
  }

  return {
    health: 1,
    playerFlags,
    deathState: "dead",
    corpse,
    teleport,
    deathReleaseLoc,
    packets,
  };
}

/** `HandleReclaimCorpseOpcode` — resurrect at corpse (50% or 100% in BG). */
export async function reclaimCorpse(
  db: Db,
  player: PlayerDeathFields,
  config: DeathConfig = {},
): Promise<ResurrectResult | null> {
  if ((player.playerFlags & PLAYER_FLAGS_GHOST) === 0) {
    return null;
  }
  const corpse = await loadCorpse(db, player.guid);
  if (!corpse) {
    return null;
  }
  if (corpse.mapId !== player.map) {
    return null;
  }
  if (!withinReclaimRadius(player, corpse)) {
    return null;
  }

  const now = config.now ?? Math.floor(Date.now() / 1000);
  const pvp = corpse.corpseType === CORPSE_RESURRECTABLE_PVP;
  const delaySec = getCorpseReclaimDelay(player.deathExpireTime, pvp, now, config);
  if (corpse.time + delaySec > now) {
    return null;
  }

  const percent = player.inBattleground ? 1.0 : 0.5;
  const result = applyResurrect(player, percent, false);
  await deleteCorpse(db, player.guid);
  return result;
}

/**
 * Spirit healer activate (`SendSpiritResurrect`) — 50% health, sickness, bones, optional
 * teleport to the graveyard nearest the corpse.
 */
export async function spiritHealerResurrect(
  db: Db,
  player: PlayerDeathFields,
  store: GraveyardStore,
): Promise<ResurrectResult> {
  const result = applyResurrect(player, 0.5, true);
  const teamId = teamIdFromRace(player.race) as TeamId;
  const corpse = await loadCorpse(db, player.guid);

  let teleport: GraveyardTeleport | null = null;
  if (corpse) {
    // nearCorpse=true → closest GY to corpse coords (`NPCHandler::SendSpiritResurrect`).
    const corpseGrave = getClosestGraveyard(store, {
      mapId: corpse.mapId,
      x: corpse.posX,
      y: corpse.posY,
      z: corpse.posZ,
      teamId,
      areaId: player.areaId ?? 0,
      zoneId: player.zone,
      isDeathKnight: player.class === CLASS_DEATH_KNIGHT,
    });
    const ghostGrave = getClosestGraveyard(store, {
      mapId: player.map,
      x: player.position_x,
      y: player.position_y,
      z: player.position_z,
      teamId,
      areaId: player.areaId ?? 0,
      zoneId: player.zone,
      isDeathKnight: player.class === CLASS_DEATH_KNIGHT,
    });

    await deleteCorpse(db, player.guid);

    if (corpseGrave && corpseGrave.ID !== ghostGrave?.ID) {
      teleport = graveyardTeleport(corpseGrave, player.orientation);
    }
  } else {
    await deleteCorpse(db, player.guid);
  }

  return { ...result, teleport };
}

export function setResurrectRequest(data: ResurrectRequestData): ResurrectRequestData {
  return { ...data };
}

export function clearResurrectRequest(): null {
  return null;
}

/**
 * `HandleResurrectResponseOpcode`.
 * `status === 0` declines; otherwise applies request health/mana and deletes the corpse.
 */
export async function handleResurrectResponse(
  db: Db,
  player: PlayerDeathFields,
  request: ResurrectRequestData | null,
  status: number,
): Promise<ResurrectResult | { declined: true } | null> {
  if (player.deathState === "alive") {
    return null;
  }
  if (status === 0) {
    return { declined: true };
  }
  if (!request) {
    return null;
  }

  const resurrected = applyResurrect(player, 0, false);
  const health = player.maxHealth > request.health ? request.health : player.maxHealth;
  const mana = player.maxPower1 > request.mana ? request.mana : player.maxPower1;
  await deleteCorpse(db, player.guid);

  return {
    ...resurrected,
    health: Math.max(1, health),
    power1: mana,
    teleport: {
      map: request.mapId,
      x: request.x,
      y: request.y,
      z: request.z,
      o: player.orientation,
    },
  };
}

export function createCorpseRow(player: PlayerDeathFields, corpseType: number, time: number): CorpseRow {
  let flags = CORPSE_FLAG_UNK2;
  if (player.playerFlags & PLAYER_FLAGS_HIDE_HELM) {
    flags |= CORPSE_FLAG_HIDE_HELM;
  }
  if (player.playerFlags & PLAYER_FLAGS_HIDE_CLOAK) {
    flags |= CORPSE_FLAG_HIDE_CLOAK;
  }
  if (player.inBattleground) {
    flags |= CORPSE_FLAG_LOOTABLE;
  }

  return {
    guid: player.guid,
    posX: player.position_x,
    posY: player.position_y,
    posZ: player.position_z,
    orientation: player.orientation,
    mapId: player.map,
    phaseMask: player.phaseMask ?? 1,
    displayId: player.displayId ?? 0,
    itemCache: player.itemCache ?? emptyItemCache(),
    bytes1: corpseBytes1(player.race, player.gender, player.skin),
    bytes2: corpseBytes2(player.face, player.hairStyle, player.hairColor, player.facialStyle),
    guildId: player.guildId ?? 0,
    flags,
    dynFlags: 0,
    time,
    corpseType,
    instanceId: player.instanceId ?? 0,
  };
}

/** `Corpse::SaveToDB`: delete, then insert. */
export async function saveCorpse(db: Db, corpse: CorpseRow): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(corpseTable).where(eq(corpseTable.guid, corpse.guid));
    await tx.insert(corpseTable).values(corpse);
  });
}

export async function loadCorpse(db: Db, guid: number): Promise<CorpseRow | null> {
  const [row] = await db.select().from(corpseTable).where(eq(corpseTable.guid, guid));
  return row ?? null;
}

/** `Corpse::DeleteFromDB` / `SpawnCorpseBones` DB side — bones are not persisted. */
export async function deleteCorpse(db: Db, guid: number): Promise<void> {
  await db.delete(corpseTable).where(eq(corpseTable.guid, guid));
}

export function isCorpseExpired(corpse: CorpseRow, now: number): boolean {
  if (corpse.corpseType === CORPSE_BONES) {
    return corpse.time < now - 60 * MINUTE;
  }
  return corpse.time < now - 3 * DAY;
}

/** `Player::UpdateCorpseReclaimDelay`. */
export function updateCorpseReclaimDelay(
  deathExpireTime: number,
  pvp: boolean,
  now: number,
  config: DeathConfig = {},
): number {
  const pvpEnabled = config.corpseReclaimDelayPvp ?? true;
  const pveEnabled = config.corpseReclaimDelayPve ?? true;
  if ((pvp && !pvpEnabled) || (!pvp && !pveEnabled)) {
    return deathExpireTime;
  }

  if (now < deathExpireTime) {
    const count = Math.floor((deathExpireTime - now) / DEATH_EXPIRE_STEP) + 1;
    if (count < MAX_DEATH_COUNT) {
      return now + (count + 1) * DEATH_EXPIRE_STEP;
    }
    return now + MAX_DEATH_COUNT * DEATH_EXPIRE_STEP;
  }
  return now + DEATH_EXPIRE_STEP;
}

/** `Player::GetCorpseReclaimDelay` — returns seconds. */
export function getCorpseReclaimDelay(
  deathExpireTime: number,
  pvp: boolean,
  now: number,
  config: DeathConfig = {},
): number {
  const pvpEnabled = config.corpseReclaimDelayPvp ?? true;
  const pveEnabled = config.corpseReclaimDelayPve ?? true;

  if (pvp) {
    if (!pvpEnabled) {
      return CORPSE_RECLAIM_DELAY_SEC[0];
    }
  } else if (!pveEnabled) {
    return 0;
  }

  const count =
    now < deathExpireTime - 1 ? Math.floor((deathExpireTime - 1 - now) / DEATH_EXPIRE_STEP) : 0;
  const index = Math.min(Math.max(count, 0), MAX_DEATH_COUNT - 1);
  return CORPSE_RECLAIM_DELAY_SEC[index]!;
}

export function calculateCorpseReclaimDelayMs(
  corpseTime: number | null,
  deathExpireTime: number,
  pvp: boolean,
  now: number,
  config: DeathConfig = {},
  load = false,
): number {
  if (load && corpseTime === null) {
    return -1;
  }

  let delaySec: number;
  if (load && corpseTime !== null) {
    if (corpseTime > deathExpireTime) {
      return -1;
    }
    const pvpEnabled = config.corpseReclaimDelayPvp ?? true;
    const pveEnabled = config.corpseReclaimDelayPve ?? true;
    let count = 0;
    if ((pvp && pvpEnabled) || (!pvp && pveEnabled)) {
      count = Math.floor((deathExpireTime - corpseTime) / DEATH_EXPIRE_STEP);
      if (count >= MAX_DEATH_COUNT) {
        count = MAX_DEATH_COUNT - 1;
      }
    }
    const expected = corpseTime + CORPSE_RECLAIM_DELAY_SEC[count]!;
    if (now >= expected) {
      return -1;
    }
    delaySec = expected - now;
  } else {
    delaySec = getCorpseReclaimDelay(deathExpireTime, pvp, now, config);
  }
  return delaySec * IN_MILLISECONDS;
}

export function withinReclaimRadius(player: PlayerDeathFields, corpse: CorpseRow): boolean {
  const dx = player.position_x - corpse.posX;
  const dy = player.position_y - corpse.posY;
  const dz = player.position_z - corpse.posZ;
  return dx * dx + dy * dy + dz * dz <= CORPSE_RECLAIM_RADIUS * CORPSE_RECLAIM_RADIUS;
}

export function applyResurrect(
  player: PlayerDeathFields,
  restorePercent: number,
  applySickness: boolean,
): ResurrectResult {
  const packets: { opcode: number; body: Uint8Array }[] = [
    {
      opcode: SMSG_DEATH_RELEASE_LOC,
      body: buildDeathReleaseLoc(0xffffffff, 0, 0, 0),
    },
  ];

  let health = player.health;
  let power1 = player.power1;
  if (restorePercent > 0) {
    health = Math.floor(player.maxHealth * restorePercent);
    power1 = Math.floor(player.maxPower1 * restorePercent);
  }

  return {
    health,
    power1,
    playerFlags: (player.playerFlags & ~PLAYER_FLAGS_GHOST) >>> 0,
    deathState: "alive",
    teleport: null,
    applySickness,
    packets,
  };
}

// --- Packet builders (body only; parent wraps with opcode header) ---

export function buildCorpseReclaimDelay(delayMs: number): Uint8Array {
  return new ByteWriter().writeU32(delayMs >>> 0).toUint8Array();
}

export function buildDeathReleaseLoc(mapId: number, x: number, y: number, z: number): Uint8Array {
  return new ByteWriter()
    .writeU32(mapId >>> 0)
    .writeF32(x)
    .writeF32(y)
    .writeF32(z)
    .toUint8Array();
}

export function buildPreResurrect(playerGuid: bigint): Uint8Array {
  return new ByteWriter().writeBytes(packedGuid(playerGuid)).toUint8Array();
}

/** `Spell::SendResurrectRequest` body. */
export function buildResurrectRequest(request: ResurrectRequestData): Uint8Array {
  const name = request.fromCreature ? (request.casterName ?? "") : "";
  const body = new ByteWriter()
    .writeU64(request.guid)
    .writeU32(name.length + 1)
    .writeCString(name)
    .writeU8(request.fromCreature ? 1 : 0);
  if (request.noResTimer) {
    body.writeU32(0);
  }
  return body.toUint8Array();
}

/** `HandleCorpseQueryOpcode` / `MSG_CORPSE_QUERY` body. */
export function buildCorpseQueryResponse(corpse: CorpseRow | null, options?: {
  playerMapId?: number;
  entranceMapId?: number;
  entranceX?: number;
  entranceY?: number;
  entranceZ?: number;
}): Uint8Array {
  if (!corpse) {
    return new ByteWriter().writeU8(0).toUint8Array();
  }

  let mapId = corpse.mapId;
  let x = corpse.posX;
  let y = corpse.posY;
  let z = corpse.posZ;
  const corpseMapId = corpse.mapId;

  if (
    options?.playerMapId !== undefined &&
    mapId !== options.playerMapId &&
    options.entranceMapId !== undefined &&
    options.entranceMapId >= 0
  ) {
    mapId = options.entranceMapId;
    x = options.entranceX ?? x;
    y = options.entranceY ?? y;
    z = options.entranceZ ?? z;
  }

  return new ByteWriter()
    .writeU8(1)
    .writeU32(mapId)
    .writeF32(x)
    .writeF32(y)
    .writeF32(z)
    .writeU32(corpseMapId)
    .writeU32(0)
    .toUint8Array();
}

export function parseResurrectResponse(payload: Uint8Array): { guid: bigint; status: number } {
  const reader = new ByteReader(payload);
  const guid = reader.readU64();
  const status = reader.readU8();
  return { guid, status };
}

export function parseRepopRequest(payload: Uint8Array): void {
  if (payload.length > 0) {
    new ByteReader(payload).readU8();
  }
}

function packedGuid(guid: bigint): Uint8Array {
  let mask = 0;
  const bytes: number[] = [];
  for (let index = 0; index < 8; index++) {
    const byte = Number((guid >> BigInt(index * 8)) & 0xffn);
    if (byte !== 0) {
      mask |= 1 << index;
      bytes.push(byte);
    }
  }
  return Uint8Array.of(mask, ...bytes);
}
