import { ByteWriter } from "../net/byte-buffer.ts";
import type { WorldCrypt } from "../crypto/world-crypt.ts";
import {
  encodeServerPacket,
  SMSG_ACTION_BUTTONS,
  SMSG_BINDPOINTUPDATE,
  SMSG_INITIAL_SPELLS,
  SMSG_INITIALIZE_FACTIONS,
} from "./packets.ts";

export const SMSG_CHAR_CREATE = 0x03a;
export const SMSG_CHAR_DELETE = 0x03c;

/** AzerothCore ResponseCodes::CHAR_CREATE_SUCCESS */
export const CHAR_CREATE_SUCCESS = 0x2f;
/** AzerothCore ResponseCodes::CHAR_CREATE_FAILED */
export const CHAR_CREATE_FAILED = 0x31;
/** AzerothCore ResponseCodes::CHAR_CREATE_NAME_IN_USE */
export const CHAR_CREATE_NAME_IN_USE = 0x32;
/** AzerothCore ResponseCodes::CHAR_CREATE_ACCOUNT_LIMIT */
export const CHAR_CREATE_ACCOUNT_LIMIT = 0x36;
/** AzerothCore ResponseCodes::CHAR_DELETE_SUCCESS */
export const CHAR_DELETE_SUCCESS = 0x47;
/** AzerothCore ResponseCodes::CHAR_DELETE_FAILED */
export const CHAR_DELETE_FAILED = 0x48;
/** AzerothCore ResponseCodes::CHAR_NAME_TOO_SHORT */
export const CHAR_NAME_TOO_SHORT = 0x5a;
/** AzerothCore ResponseCodes::CHAR_NAME_TOO_LONG */
export const CHAR_NAME_TOO_LONG = 0x5b;
/** AzerothCore ResponseCodes::CHAR_NAME_INVALID_CHARACTER */
export const CHAR_NAME_INVALID_CHARACTER = 0x5c;
/** AzerothCore ResponseCodes::CHAR_NAME_THREE_CONSECUTIVE */
export const CHAR_NAME_THREE_CONSECUTIVE = 0x62;

export const ACTION_BUTTON_COUNT = 144;
export const FACTION_SLOT_COUNT = 128;

export type ActionButton = { button: number; action: number; type: number };
export type FactionSlot = { index: number; flags: number; standing: number };
export type Homebind = { mapId: number; zoneId: number; x: number; y: number; z: number };

export function initialSpellsBody(spellIds: readonly number[]): Uint8Array {
  const body = new ByteWriter().writeU8(0).writeU16(spellIds.length);
  for (const spellId of spellIds) {
    body.writeU32(spellId).writeU16(0);
  }
  return body.writeU16(0).toUint8Array();
}

export function actionButtonsBody(actions: readonly ActionButton[]): Uint8Array {
  const buttons = new Uint32Array(ACTION_BUTTON_COUNT);
  for (const entry of actions) {
    if (entry.button < 0 || entry.button >= ACTION_BUTTON_COUNT) {
      continue;
    }
    buttons[entry.button] = ((entry.action & 0x00ffffff) | (entry.type << 24)) >>> 0;
  }
  const body = new ByteWriter().writeU8(1);
  for (let index = 0; index < ACTION_BUTTON_COUNT; index++) {
    body.writeU32(buttons[index]!);
  }
  return body.toUint8Array();
}

export function initializeFactionsBody(slots: readonly FactionSlot[]): Uint8Array {
  const flags = new Uint8Array(FACTION_SLOT_COUNT);
  const standing = new Int32Array(FACTION_SLOT_COUNT);
  for (const slot of slots) {
    if (slot.index < 0 || slot.index >= FACTION_SLOT_COUNT) {
      continue;
    }
    flags[slot.index] = slot.flags & 0xff;
    standing[slot.index] = slot.standing | 0;
  }
  const body = new ByteWriter().writeU32(0x80);
  for (let index = 0; index < FACTION_SLOT_COUNT; index++) {
    body.writeU8(flags[index]!).writeU32(standing[index]! >>> 0);
  }
  return body.toUint8Array();
}

export function bindPointBody(homebind: Homebind): Uint8Array {
  return new ByteWriter()
    .writeF32(homebind.x)
    .writeF32(homebind.y)
    .writeF32(homebind.z)
    .writeU32(homebind.mapId)
    .writeU32(homebind.zoneId)
    .toUint8Array();
}

export function charCreateBody(code: number): Uint8Array {
  return new ByteWriter().writeU8(code).toUint8Array();
}

export function charDeleteBody(code: number): Uint8Array {
  return new ByteWriter().writeU8(code).toUint8Array();
}

export function initialSpellsPacket(crypt: WorldCrypt | null, spellIds: readonly number[]): Uint8Array {
  return encodeServerPacket(SMSG_INITIAL_SPELLS, initialSpellsBody(spellIds), crypt);
}

export function actionButtonsPacket(crypt: WorldCrypt | null, actions: readonly ActionButton[]): Uint8Array {
  return encodeServerPacket(SMSG_ACTION_BUTTONS, actionButtonsBody(actions), crypt);
}

export function initializeFactionsPacket(crypt: WorldCrypt | null, slots: readonly FactionSlot[]): Uint8Array {
  return encodeServerPacket(SMSG_INITIALIZE_FACTIONS, initializeFactionsBody(slots), crypt);
}

export function bindPointPacket(crypt: WorldCrypt | null, homebind: Homebind): Uint8Array {
  return encodeServerPacket(SMSG_BINDPOINTUPDATE, bindPointBody(homebind), crypt);
}

export function charCreatePacket(crypt: WorldCrypt | null, code: number): Uint8Array {
  return encodeServerPacket(SMSG_CHAR_CREATE, charCreateBody(code), crypt);
}

export function charDeletePacket(crypt: WorldCrypt | null, code: number): Uint8Array {
  return encodeServerPacket(SMSG_CHAR_DELETE, charDeleteBody(code), crypt);
}
