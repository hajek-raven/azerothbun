import { inflateSync } from "bun";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import { logPacket } from "../log.ts";
import { OPCODE_NAMES } from "./opcode-names.ts";
import { sha1 } from "../crypto/srp6.ts";
import type { Character } from "../db.ts";
import { WorldCrypt } from "../crypto/world-crypt.ts";
import { writeCharEnumGear, type CharEnumGearSlot } from "../characters/char-enum-gear.ts";
import { playerCreateBlock, type PlayerFieldStats } from "./update-object.ts";
import { AT_LOGIN_RENAME, AT_LOGIN_RESURRECT, PLAYER_FLAGS_GHOST, PLAYER_FLAGS_HIDE_CLOAK, PLAYER_FLAGS_HIDE_HELM } from "../game/Entities/Player/PlayerDefines.ts";
import {
  actionButtonsPacket,
  bindPointPacket,
  initializeFactionsPacket,
  initialSpellsPacket,
  type ActionButton,
  type FactionSlot,
  type Homebind,
} from "./character-packets.ts";

export { SMSG_CHAR_CREATE, SMSG_CHAR_DELETE } from "./character-packets.ts";

export const SMSG_AUTH_CHALLENGE = 0x1ec;
export const CMSG_AUTH_SESSION = 0x1ed;
export const SMSG_AUTH_RESPONSE = 0x1ee;
export const CMSG_CHAR_CREATE = 0x036;
export const CMSG_CHAR_ENUM = 0x037;
export const CMSG_CHAR_DELETE = 0x038;
export const SMSG_CHAR_ENUM = 0x03b;
export const CMSG_PING = 0x1dc;
export const SMSG_PONG = 0x1dd;
export const SMSG_ADDON_INFO = 0x2ef;
export const SMSG_CLIENTCACHE_VERSION = 0x4ab;
export const SMSG_LOGIN_VERIFY_WORLD = 0x236;
export const SMSG_ACCOUNT_DATA_TIMES = 0x209;
export const SMSG_FEATURE_SYSTEM_STATUS = 0x3c9;
export const SMSG_LEARNED_DANCE_MOVES = 0x455;
export const SMSG_BINDPOINTUPDATE = 0x155;
export const SMSG_TUTORIAL_FLAGS = 0x0fd;
export const CMSG_TUTORIAL_FLAG = 0x0fe;
export const CMSG_TUTORIAL_CLEAR = 0x0ff;
export const CMSG_TUTORIAL_RESET = 0x100;
export const SMSG_INSTANCE_DIFFICULTY = 0x33b;
export const SMSG_INITIAL_SPELLS = 0x12a;
export const SMSG_SEND_UNLEARN_SPELLS = 0x41e;
export const SMSG_ACTION_BUTTONS = 0x129;
export const SMSG_INITIALIZE_FACTIONS = 0x122;
export const SMSG_ALL_ACHIEVEMENT_DATA = 0x47d;
export const SMSG_EQUIPMENT_SET_LIST = 0x4bc;
export const SMSG_TALENTS_INFO = 0x4c0;
export const SMSG_LOGIN_SETTIMESPEED = 0x042;
export const SMSG_UPDATE_OBJECT = 0x0a9;
export const SMSG_DESTROY_OBJECT = 0x0aa;
export const SMSG_TIME_SYNC_REQ = 0x390;
export const SMSG_REALM_SPLIT = 0x38b;
export const CMSG_REALM_SPLIT = 0x38c;
export const CMSG_READY_FOR_ACCOUNT_DATA_TIMES = 0x4ff;
export const CMSG_NAME_QUERY = 0x050;
export const SMSG_NAME_QUERY_RESPONSE = 0x051;
export const CMSG_LOGOUT_REQUEST = 0x04b;
export const SMSG_LOGOUT_RESPONSE = 0x04c;
export const SMSG_LOGOUT_COMPLETE = 0x04d;
export const CMSG_LOGOUT_CANCEL = 0x04e;
export const SMSG_LOGOUT_CANCEL_ACK = 0x04f;
export const CMSG_CAST_SPELL = 0x12e;
export const CMSG_ATTACKSWING = 0x141;
export const CMSG_ATTACKSTOP = 0x142;
export const CMSG_ACTIVATETAXI = 0x1ad;
export const CMSG_ACTIVATETAXIEXPRESS = 0x312;
export const CMSG_QUERY_TIME = 0x1ce;
export const SMSG_QUERY_TIME_RESPONSE = 0x1cf;
export const CMSG_ZONEUPDATE = 0x1f4;
export const CMSG_TIME_SYNC_RESP = 0x391;
export const CMSG_WORLD_STATE_UI_TIMER_UPDATE = 0x4f6;
export const SMSG_WORLD_STATE_UI_TIMER_UPDATE = 0x4f7;
export const CMSG_ITEM_QUERY_SINGLE = 0x056;
export const SMSG_ITEM_QUERY_SINGLE_RESPONSE = 0x058;
export const CMSG_GAMEOBJECT_QUERY = 0x05e;
export const SMSG_GAMEOBJECT_QUERY_RESPONSE = 0x05f;
export const CMSG_CREATURE_QUERY = 0x060;
export const SMSG_CREATURE_QUERY_RESPONSE = 0x061;
export const CMSG_STANDSTATECHANGE = 0x101;
export const CMSG_WARDEN_DATA = 0x2e7;
export const CMSG_KEEP_ALIVE = 0x407;
export const SMSG_STANDSTATE_UPDATE = 0x29d;

export const AUTH_OK = 0x0c;
export const AUTH_FAILED = 0x0d;
export const AUTH_UNAVAILABLE = 0x10;
export const AUTH_BANNED = 0x1c;
export const CLIENT_HEADER_SIZE = 6;
export const SERVER_HEADER_SIZE = 4;
const EQUIPMENT_SLOTS = 23;

export type AuthSessionPacket = {
  build: number;
  account: string;
  clientSeed: Uint8Array;
  realmId: number;
  digest: Uint8Array;
  addonInfo: Uint8Array;
};

/**
 * `ServerPktHeader` and the packet body. The header stays plain here: `WorldSocket::WritePacketToBuffer`
 * encrypts it when the packet is written to the socket (`sealServerPacket`), so the RC4 stream follows wire order.
 */
export function encodeServerPacket(opcode: number, payload: Uint8Array): Uint8Array {
  logPacket("S->C", OPCODE_NAMES.get(opcode) ?? "UNKNOWN", opcode, payload);
  const size = payload.length + 2;
  const large = size > 0x7fff;
  const headerSize = large ? SERVER_HEADER_SIZE + 1 : SERVER_HEADER_SIZE;
  const packet = new Uint8Array(headerSize + payload.length);
  let index = 0;
  if (large) {
    packet[index++] = 0x80 | ((size >> 16) & 0xff);
  }
  packet[index++] = (size >> 8) & 0xff;
  packet[index++] = size & 0xff;
  packet[index++] = opcode & 0xff;
  packet[index++] = (opcode >> 8) & 0xff;
  packet.set(payload, headerSize);
  return packet;
}

/** Header length of an encoded server packet: 5 bytes when the large-packet bit is set, else 4. */
export function serverHeaderSize(packet: Uint8Array): number {
  return (packet[0]! & 0x80) !== 0 ? SERVER_HEADER_SIZE + 1 : SERVER_HEADER_SIZE;
}

/**
 * `WorldSocket::WritePacketToBuffer`: encrypt the header with `_authCrypt` at write time.
 * Returns a copy, so one encoded packet can go to several sockets.
 */
export function sealServerPacket(packet: Uint8Array, crypt: WorldCrypt | null): Uint8Array {
  if (!crypt) {
    return packet;
  }
  const sealed = packet.slice();
  crypt.encryptHeader(sealed.subarray(0, serverHeaderSize(sealed)));
  return sealed;
}

export function decodeClientHeader(header: Uint8Array): { size: number; opcode: number } {
  const size = (header[0]! << 8) | header[1]!;
  const opcode = header[2]! | (header[3]! << 8) | (header[4]! << 16) | (header[5]! << 24);
  return { size, opcode };
}

export function encodeClientPacket(opcode: number, payload: Uint8Array, crypt: WorldCrypt | null): Uint8Array {
  const size = payload.length + 4;
  const header = new Uint8Array(CLIENT_HEADER_SIZE);
  header[0] = (size >> 8) & 0xff;
  header[1] = size & 0xff;
  header[2] = opcode & 0xff;
  header[3] = (opcode >> 8) & 0xff;
  header[4] = (opcode >> 16) & 0xff;
  header[5] = (opcode >> 24) & 0xff;
  crypt?.encryptHeader(header);
  const packet = new Uint8Array(header.length + payload.length);
  packet.set(header, 0);
  packet.set(payload, header.length);
  return packet;
}

export function authChallengePacket(seed: Uint8Array): Uint8Array {
  const payload = new ByteWriter().writeU32(1).writeBytes(seed).writeBytes(crypto.getRandomValues(new Uint8Array(32))).toUint8Array();
  return encodeServerPacket(SMSG_AUTH_CHALLENGE, payload);
}

export function authSeed(packet: Uint8Array): Uint8Array {
  return packet.subarray(SERVER_HEADER_SIZE + 4, SERVER_HEADER_SIZE + 8);
}

export function sessionDigest(account: string, clientSeed: Uint8Array, serverSeed: Uint8Array, sessionKey: Uint8Array): Uint8Array {
  return sha1(account, new Uint8Array(4), clientSeed, serverSeed, sessionKey);
}

export function parseAuthSession(payload: Uint8Array): AuthSessionPacket | null {
  const reader = new ByteReader(payload);
  if (reader.remaining < 4 + 4 + 1) {
    return null;
  }
  const build = reader.readU32();
  reader.readU32();
  const account = reader.readCString();
  if (reader.remaining < 4 + 4 + 4 + 4 + 4 + 8 + 20) {
    return null;
  }
  reader.readU32();
  const clientSeed = reader.readBytes(4);
  reader.readU32();
  reader.readU32();
  const realmId = reader.readU32();
  reader.readU32();
  reader.readU32();
  const digest = reader.readBytes(20);
  const addonInfo = reader.readBytes(reader.remaining);
  return { build, account, clientSeed, realmId, digest, addonInfo };
}

export function authResponsePacket(crypt: WorldCrypt, code: number): Uint8Array {
  const payload =
    code === AUTH_OK
      ? new ByteWriter().writeU8(AUTH_OK).writeU32(0).writeU8(0).writeU32(0).writeU8(2).toUint8Array()
      : new ByteWriter().writeU8(code).toUint8Array();
  return encodeServerPacket(SMSG_AUTH_RESPONSE, payload);
}

export function addonInfoPacket(crypt: WorldCrypt, addonInfo: Uint8Array): Uint8Array | null {
  const addons = parseAddons(addonInfo);
  if (!addons) {
    return null;
  }
  const body = new ByteWriter();
  for (const addon of addons) {
    const enabled = addon.enabled !== 0;
    body.writeU8(enabled ? 2 : 1);
    body.writeU8(enabled ? 1 : 0);
    if (enabled) {
      body.writeU8(0);
      body.writeU32(0);
    }
    body.writeU8(enabled ? 0 : 1);
    if (!enabled) {
      body.writeU8(0);
    }
  }
  return encodeServerPacket(SMSG_ADDON_INFO, body.toUint8Array());
}

export function clientCacheVersionPacket(crypt: WorldCrypt): Uint8Array {
  return encodeServerPacket(SMSG_CLIENTCACHE_VERSION, new ByteWriter().writeU32(0).toUint8Array());
}

export function pongPacket(crypt: WorldCrypt, ping: number): Uint8Array {
  return encodeServerPacket(SMSG_PONG, new ByteWriter().writeU32(ping).toUint8Array());
}

/** `CharacterFlags` (Player.cpp) */
const CHARACTER_FLAG_HIDE_HELM = 0x00000400;
const CHARACTER_FLAG_HIDE_CLOAK = 0x00000800;
const CHARACTER_FLAG_GHOST = 0x00002000;
const CHARACTER_FLAG_RENAME = 0x00004000;
const CHARACTER_FLAG_LOCKED_BY_BILLING = 0x01000000;
const CHARACTER_FLAG_DECLINED = 0x02000000;

export function charEnumPacket(
  crypt: WorldCrypt,
  characters: Character[],
  gearByGuid: ReadonlyMap<number, readonly CharEnumGearSlot[]> = new Map(),
  bannedGuids: ReadonlySet<number> = new Set(),
  declinedNamesUsed = false,
): Uint8Array {
  const body = new ByteWriter().writeU8(characters.length);
  for (const character of characters) {
    // `Player::BuildEnumData` character flags
    let playerFlags = character.playerFlags;
    let charFlags = 0;
    if (character.at_login & AT_LOGIN_RESURRECT) playerFlags &= ~PLAYER_FLAGS_GHOST;
    if (playerFlags & PLAYER_FLAGS_HIDE_HELM) charFlags |= CHARACTER_FLAG_HIDE_HELM;
    if (playerFlags & PLAYER_FLAGS_HIDE_CLOAK) charFlags |= CHARACTER_FLAG_HIDE_CLOAK;
    if (playerFlags & PLAYER_FLAGS_GHOST) charFlags |= CHARACTER_FLAG_GHOST;
    if (character.at_login & AT_LOGIN_RENAME) charFlags |= CHARACTER_FLAG_RENAME;
    if (bannedGuids.has(character.guid)) charFlags |= CHARACTER_FLAG_LOCKED_BY_BILLING;
    // Declined names (`character_declinedname`) are only read when `DeclinedNames` is on.
    if (!declinedNamesUsed) charFlags |= CHARACTER_FLAG_DECLINED;
    body
      .writeU64(BigInt(character.guid))
      .writeCString(character.name)
      .writeU8(character.race)
      .writeU8(character.class)
      .writeU8(character.gender)
      .writeU8(character.skin)
      .writeU8(character.face)
      .writeU8(character.hairStyle)
      .writeU8(character.hairColor)
      .writeU8(character.facialStyle)
      .writeU8(character.level)
      .writeU32(character.zone)
      .writeU32(character.map)
      .writeF32(character.position_x)
      .writeF32(character.position_y)
      .writeF32(character.position_z)
      .writeU32(0)
      .writeU32(charFlags >>> 0)
      .writeU32(0)
      .writeU8(1)
      .writeU32(0)
      .writeU32(0)
      .writeU32(0);
    const gear = gearByGuid.get(character.guid);
    if (gear) {
      writeCharEnumGear(body, gear);
    } else {
      for (let slot = 0; slot < EQUIPMENT_SLOTS; slot++) {
        body.writeU32(0).writeU8(0).writeU32(0);
      }
    }
  }
  return encodeServerPacket(SMSG_CHAR_ENUM, body.toUint8Array());
}

export type LoginCharacterState = {
  spells: readonly number[];
  cooldowns?: readonly import("./character-packets.ts").InitialSpellCooldown[];
  actions: readonly ActionButton[];
  homebind: Homebind | null;
  factions: readonly FactionSlot[];
  stats?: PlayerFieldStats;
  equipmentSetList?: Uint8Array;
};

export function loginPackets(crypt: WorldCrypt, character: Character, state?: LoginCharacterState): Uint8Array[] {
  const homebind = state?.homebind ?? {
    x: character.position_x,
    y: character.position_y,
    z: character.position_z,
    mapId: character.map,
    zoneId: character.zone,
  };
  return [
    loginVerifyWorld(crypt, character),
    accountDataTimes(crypt),
    featureSystemStatus(crypt),
    learnedDanceMoves(crypt),
    bindPointPacket(crypt, homebind),
    instanceDifficulty(crypt),
    initialSpellsPacket(crypt, state?.spells ?? [], state?.cooldowns ?? []),
    unlearnSpells(crypt),
    actionButtonsPacket(crypt, state?.actions ?? []),
    initializeFactionsPacket(crypt, state?.factions ?? []),
    achievementData(crypt),
    equipmentSets(crypt, state?.equipmentSetList),
    talentsInfo(crypt),
    loginSetTimeSpeed(crypt),
    encodeServerPacket(SMSG_UPDATE_OBJECT, playerCreateBlock(character, state?.stats)),
    timeSync(crypt, 0),
  ];
}

export const LOGIN_PACKET_NAMES = [
  "SMSG_LOGIN_VERIFY_WORLD",
  "SMSG_ACCOUNT_DATA_TIMES",
  "SMSG_FEATURE_SYSTEM_STATUS",
  "SMSG_LEARNED_DANCE_MOVES",
  "SMSG_BINDPOINTUPDATE",
  "SMSG_INSTANCE_DIFFICULTY",
  "SMSG_INITIAL_SPELLS",
  "SMSG_SEND_UNLEARN_SPELLS",
  "SMSG_ACTION_BUTTONS",
  "SMSG_INITIALIZE_FACTIONS",
  "SMSG_ALL_ACHIEVEMENT_DATA",
  "SMSG_EQUIPMENT_SET_LIST",
  "SMSG_TALENTS_INFO",
  "SMSG_LOGIN_SETTIMESPEED",
  "SMSG_UPDATE_OBJECT",
  "SMSG_TIME_SYNC_REQ",
];

export function realmSplitPacket(crypt: WorldCrypt, unk: number): Uint8Array {
  const payload = new ByteWriter().writeU32(unk).writeU32(0).writeCString("01/01/01").toUint8Array();
  return encodeServerPacket(SMSG_REALM_SPLIT, payload);
}

export function accountDataTimesPacket(crypt: WorldCrypt): Uint8Array {
  return accountDataTimes(crypt);
}

export function nameQueryResponse(crypt: WorldCrypt, character: Character): Uint8Array {
  const payload = new ByteWriter()
    .writeBytes(packedGuid(BigInt(character.guid)))
    .writeU8(0)
    .writeCString(character.name)
    .writeCString("")
    .writeU8(character.race)
    .writeU8(character.gender)
    .writeU8(character.class)
    .writeU8(0)
    .toUint8Array();
  return encodeServerPacket(SMSG_NAME_QUERY_RESPONSE, payload);
}

export function queryTimeResponse(crypt: WorldCrypt): Uint8Array {
  const now = Math.floor(Date.now() / 1000);
  return encodeServerPacket(SMSG_QUERY_TIME_RESPONSE, new ByteWriter().writeU32(now).writeU32(0).toUint8Array());
}

export function worldStateTimer(crypt: WorldCrypt): Uint8Array {
  return encodeServerPacket(SMSG_WORLD_STATE_UI_TIMER_UPDATE, new ByteWriter().writeU32(Math.floor(Date.now() / 1000)).toUint8Array());
}

export function logoutPackets(crypt: WorldCrypt): Uint8Array[] {
  return [
    encodeServerPacket(SMSG_LOGOUT_RESPONSE, new ByteWriter().writeU32(0).writeU8(1).toUint8Array()),
    encodeServerPacket(SMSG_LOGOUT_COMPLETE, new Uint8Array(0)),
  ];
}

export function environmentalDamagePacket(crypt: WorldCrypt, guid: bigint, amount: number): Uint8Array {
  const payload = new ByteWriter().writeU64(guid).writeU8(2).writeU32(amount).writeU32(0).writeU32(0).toUint8Array();
  return encodeServerPacket(0x1fc, payload);
}

export function relocationPackets(crypt: WorldCrypt, character: Character): Uint8Array[] {
  return [loginVerifyWorld(crypt, character), encodeServerPacket(SMSG_UPDATE_OBJECT, playerCreateBlock(character))];
}

export function timeSyncRequest(crypt: WorldCrypt, counter: number): Uint8Array {
  return encodeServerPacket(SMSG_TIME_SYNC_REQ, new ByteWriter().writeU32(counter).toUint8Array());
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

function loginVerifyWorld(crypt: WorldCrypt, character: Character): Uint8Array {
  const payload = new ByteWriter()
    .writeU32(character.map)
    .writeF32(character.position_x)
    .writeF32(character.position_y)
    .writeF32(character.position_z)
    .writeF32(character.orientation)
    .toUint8Array();
  return encodeServerPacket(SMSG_LOGIN_VERIFY_WORLD, payload);
}

function accountDataTimes(crypt: WorldCrypt): Uint8Array {
  const body = new ByteWriter().writeU32(Math.floor(Date.now() / 1000)).writeU8(1).writeU32(0xff);
  for (let index = 0; index < 8; index++) {
    body.writeU32(0);
  }
  return encodeServerPacket(SMSG_ACCOUNT_DATA_TIMES, body.toUint8Array());
}

function featureSystemStatus(crypt: WorldCrypt): Uint8Array {
  return encodeServerPacket(SMSG_FEATURE_SYSTEM_STATUS, new ByteWriter().writeU8(2).writeU8(0).toUint8Array());
}

function learnedDanceMoves(crypt: WorldCrypt): Uint8Array {
  return encodeServerPacket(SMSG_LEARNED_DANCE_MOVES, new ByteWriter().writeU32(0).writeU32(0).toUint8Array());
}

/** `WorldSession::SendTutorialsData`: sent once after `SMSG_AUTH_RESPONSE`, not on player login. */
export function tutorialFlagsPacket(crypt: WorldCrypt, values: readonly number[]): Uint8Array {
  const body = new ByteWriter();
  for (let index = 0; index < 8; index++) {
    body.writeU32(values[index] ?? 0);
  }
  return encodeServerPacket(SMSG_TUTORIAL_FLAGS, body.toUint8Array());
}

function instanceDifficulty(crypt: WorldCrypt): Uint8Array {
  return encodeServerPacket(SMSG_INSTANCE_DIFFICULTY, new ByteWriter().writeU32(0).writeU32(0).toUint8Array());
}

function unlearnSpells(crypt: WorldCrypt): Uint8Array {
  return encodeServerPacket(SMSG_SEND_UNLEARN_SPELLS, new ByteWriter().writeU32(0).toUint8Array());
}

function achievementData(crypt: WorldCrypt): Uint8Array {
  return encodeServerPacket(SMSG_ALL_ACHIEVEMENT_DATA, new ByteWriter().writeU32(0xffffffff).writeU32(0xffffffff).toUint8Array());
}

function equipmentSets(crypt: WorldCrypt, body?: Uint8Array): Uint8Array {
  return encodeServerPacket(SMSG_EQUIPMENT_SET_LIST, body ?? new ByteWriter().writeU32(0).toUint8Array());
}

function talentsInfo(crypt: WorldCrypt): Uint8Array {
  const body = new ByteWriter().writeU8(0).writeU32(0).writeU8(1).writeU8(0).writeU8(0).writeU8(6);
  for (let glyph = 0; glyph < 6; glyph++) {
    body.writeU16(0);
  }
  return encodeServerPacket(SMSG_TALENTS_INFO, body.toUint8Array());
}

function loginSetTimeSpeed(crypt: WorldCrypt): Uint8Array {
  const payload = new ByteWriter().writeU32(packedTime(new Date())).writeF32(0.01666667).writeU32(0).toUint8Array();
  return encodeServerPacket(SMSG_LOGIN_SETTIMESPEED, payload);
}

function timeSync(crypt: WorldCrypt, counter: number): Uint8Array {
  return encodeServerPacket(SMSG_TIME_SYNC_REQ, new ByteWriter().writeU32(counter).toUint8Array());
}

function packedTime(date: Date): number {
  return (
    ((date.getUTCFullYear() - 2000) << 24) |
    (date.getUTCMonth() << 20) |
    ((date.getUTCDate() - 1) << 14) |
    (date.getUTCDay() << 11) |
    (date.getUTCHours() << 6) |
    date.getUTCMinutes()
  ) >>> 0;
}

function parseAddons(addonInfo: Uint8Array): Array<{ enabled: number }> | null {
  if (addonInfo.length < 4) {
    return [];
  }
  const reader = new ByteReader(addonInfo);
  const size = reader.readU32();
  if (size === 0) {
    return [];
  }
  try {
    const inflated = inflateSync(addonInfo.slice(4));
    const packed = new ByteReader(inflated);
    const count = packed.readU32();
    const addons: Array<{ enabled: number }> = [];
    for (let index = 0; index < count; index++) {
      packed.readCString();
      addons.push({ enabled: packed.readU8() });
      packed.readU32();
      packed.readU32();
    }
    return addons;
  } catch {
    return null;
  }
}
