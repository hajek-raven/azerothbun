import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import { G_BYTES, N_BYTES } from "../crypto/srp6.ts";
import { CLIENT_BUILD, type Realm } from "../db.ts";

export const AUTH_LOGON_CHALLENGE = 0x00;
export const AUTH_LOGON_PROOF = 0x01;
export const AUTH_RECONNECT_CHALLENGE = 0x02;
export const AUTH_RECONNECT_PROOF = 0x03;
export const REALM_LIST = 0x10;

export const WOW_SUCCESS = 0x00;
export const WOW_FAIL_UNKNOWN_ACCOUNT = 0x04;
export const WOW_FAIL_VERSION_INVALID = 0x09;

export const LOGON_PROOF_PACKET_SIZE = 75;
export const RECONNECT_PROOF_PACKET_SIZE = 58;
export const REALM_LIST_PACKET_SIZE = 5;
export const CHALLENGE_HEADER_SIZE = 4;
export const MAX_CHALLENGE_PACKET_SIZE = 51;

export const VERSION_CHALLENGE = Uint8Array.from([
  0xba, 0xa3, 0x1e, 0x99, 0xa0, 0x0b, 0x21, 0x57, 0xfc, 0x37, 0x3f, 0xb3, 0x69, 0xcd, 0xd2, 0xf1,
]);

export type LogonChallenge = {
  build: number;
  username: string;
};

export type LogonProof = {
  A: Uint8Array;
  clientM: Uint8Array;
  securityFlags: number;
};

export type ReconnectProof = {
  clientNonce: Uint8Array;
  proof: Uint8Array;
};

const CHALLENGE_BODY_WITHOUT_USERNAME = 30;

export function parseLogonChallenge(packet: Uint8Array): LogonChallenge | null {
  const reader = new ByteReader(packet);
  reader.readU8();
  reader.readU8();
  const size = reader.readU16();
  if (size !== packet.length - CHALLENGE_HEADER_SIZE || reader.remaining < CHALLENGE_BODY_WITHOUT_USERNAME) {
    return null;
  }
  reader.readBytes(4);
  reader.readU8();
  reader.readU8();
  reader.readU8();
  const build = reader.readU16();
  reader.readBytes(4);
  reader.readBytes(4);
  reader.readBytes(4);
  reader.readU32();
  reader.readU32();
  const usernameLength = reader.readU8();
  if (size - CHALLENGE_BODY_WITHOUT_USERNAME !== usernameLength || reader.remaining !== usernameLength) {
    return null;
  }
  const username = new TextDecoder().decode(reader.readBytes(usernameLength));
  return { build, username };
}

export function parseLogonProof(packet: Uint8Array): LogonProof {
  const reader = new ByteReader(packet);
  reader.readU8();
  const A = reader.readBytes(32);
  const clientM = reader.readBytes(20);
  reader.readBytes(20);
  reader.readU8();
  return { A, clientM, securityFlags: reader.readU8() };
}

export function parseReconnectProof(packet: Uint8Array): ReconnectProof {
  const reader = new ByteReader(packet);
  reader.readU8();
  return {
    clientNonce: reader.readBytes(16),
    proof: reader.readBytes(20),
  };
}

export function logonChallengeFailure(error: number): Uint8Array {
  return new ByteWriter().writeU8(AUTH_LOGON_CHALLENGE).writeU8(0x00).writeU8(error).toUint8Array();
}

export function logonChallengeSuccess(B: Uint8Array, salt: Uint8Array): Uint8Array {
  return new ByteWriter()
    .writeU8(AUTH_LOGON_CHALLENGE)
    .writeU8(0x00)
    .writeU8(WOW_SUCCESS)
    .writeBytes(B)
    .writeU8(G_BYTES.length)
    .writeBytes(G_BYTES)
    .writeU8(N_BYTES.length)
    .writeBytes(N_BYTES)
    .writeBytes(salt)
    .writeBytes(VERSION_CHALLENGE)
    .writeU8(0)
    .toUint8Array();
}

export function logonProofFailure(): Uint8Array {
  return new ByteWriter().writeU8(AUTH_LOGON_PROOF).writeU8(WOW_FAIL_UNKNOWN_ACCOUNT).writeU16(0).toUint8Array();
}

export function logonProofSuccess(M2: Uint8Array): Uint8Array {
  return new ByteWriter()
    .writeU8(AUTH_LOGON_PROOF)
    .writeU8(WOW_SUCCESS)
    .writeBytes(M2)
    .writeU32(0)
    .writeU32(0)
    .writeU16(0)
    .toUint8Array();
}

export function reconnectChallengeFailure(): Uint8Array {
  return new ByteWriter().writeU8(AUTH_RECONNECT_CHALLENGE).writeU8(WOW_FAIL_UNKNOWN_ACCOUNT).toUint8Array();
}

export function reconnectChallengeSuccess(serverNonce: Uint8Array): Uint8Array {
  return new ByteWriter()
    .writeU8(AUTH_RECONNECT_CHALLENGE)
    .writeU8(WOW_SUCCESS)
    .writeBytes(serverNonce)
    .writeBytes(VERSION_CHALLENGE)
    .toUint8Array();
}

export function reconnectProofSuccess(): Uint8Array {
  return new ByteWriter().writeU8(AUTH_RECONNECT_PROOF).writeU8(WOW_SUCCESS).writeU16(0).toUint8Array();
}

export function realmListPacket(realms: Realm[], clientBuild: number): Uint8Array {
  const body = new ByteWriter().writeU32(0);
  const compatible = realms.filter((realm) => realm.gamebuild === clientBuild);
  body.writeU16(compatible.length);
  for (const realm of compatible) {
    body
      .writeU8(realm.icon)
      .writeU8(0)
      .writeU8(realm.flag)
      .writeCString(realm.name)
      .writeCString(`${realm.address}:${realm.port}`)
      .writeF32(realm.population)
      .writeU8(0)
      .writeU8(realm.timezone)
      .writeU8(realm.id);
  }
  body.writeU8(0x10).writeU8(0x00);
  const payload = body.toUint8Array();
  return new ByteWriter().writeU8(REALM_LIST).writeU16(payload.length).writeBytes(payload).toUint8Array();
}

export function acceptedBuild(build: number): boolean {
  return build === CLIENT_BUILD;
}
