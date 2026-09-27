import type { Db } from "../database/database.ts";
import { equalBytes } from "../crypto/equal-bytes.ts";
import {
  beginServerChallenge,
  reconnectProof,
  sessionVerifier,
  upperLatin,
  verifyClientProof,
  type ServerChallenge,
} from "../crypto/srp6.ts";
import { findAccount, listRealms, saveSessionKey } from "../db.ts";
import {
  acceptedBuild,
  AUTH_LOGON_CHALLENGE,
  AUTH_LOGON_PROOF,
  AUTH_RECONNECT_CHALLENGE,
  AUTH_RECONNECT_PROOF,
  CHALLENGE_HEADER_SIZE,
  LOGON_PROOF_PACKET_SIZE,
  MAX_CHALLENGE_PACKET_SIZE,
  parseLogonChallenge,
  parseLogonProof,
  parseReconnectProof,
  REALM_LIST,
  REALM_LIST_PACKET_SIZE,
  RECONNECT_PROOF_PACKET_SIZE,
  logonChallengeFailure,
  logonChallengeSuccess,
  logonProofFailure,
  logonProofSuccess,
  realmListPacket,
  reconnectChallengeFailure,
  reconnectChallengeSuccess,
  reconnectProofSuccess,
  WOW_FAIL_UNKNOWN_ACCOUNT,
  WOW_FAIL_VERSION_INVALID,
} from "./packets.ts";

export type AuthStatus = "challenge" | "logon_proof" | "reconnect_proof" | "authed" | "closed";

export type SessionResult = { action: "send"; packet: Uint8Array } | { action: "close"; packet?: Uint8Array };

type AccountIdentity = {
  username: string;
  sessionKey: Uint8Array | null;
};

export class AuthSession {
  status: AuthStatus = "challenge";
  private account: AccountIdentity | null = null;
  private challenge: ServerChallenge | null = null;
  private reconnectNonce: Uint8Array | null = null;
  private clientBuild = 0;

  constructor(private readonly db: Db) {}

  async handle(packet: Uint8Array): Promise<SessionResult> {
    const command = packet[0];
    if (command === undefined) {
      return { action: "close" };
    }
    switch (command) {
      case AUTH_LOGON_CHALLENGE:
        return this.handleLogonChallenge(packet);
      case AUTH_LOGON_PROOF:
        return this.handleLogonProof(packet);
      case AUTH_RECONNECT_CHALLENGE:
        return this.handleReconnectChallenge(packet);
      case AUTH_RECONNECT_PROOF:
        return this.handleReconnectProof(packet);
      case REALM_LIST:
        return this.handleRealmList();
      default:
        return { action: "close" };
    }
  }

  private async handleLogonChallenge(packet: Uint8Array): Promise<SessionResult> {
    this.status = "closed";
    const challenge = parseLogonChallenge(packet);
    if (!challenge || challenge.username.length === 0 || challenge.username.length > 16) {
      return { action: "close" };
    }
    this.clientBuild = challenge.build;
    if (!acceptedBuild(challenge.build)) {
      return { action: "send", packet: logonChallengeFailure(WOW_FAIL_VERSION_INVALID) };
    }

    const username = upperLatin(challenge.username);
    const account = await findAccount(this.db, username);
    if (!account) {
      return { action: "send", packet: logonChallengeFailure(WOW_FAIL_UNKNOWN_ACCOUNT) };
    }

    this.account = { username: account.username, sessionKey: account.session_key };
    this.challenge = beginServerChallenge(account.username, account.salt, account.verifier);
    this.status = "logon_proof";
    return { action: "send", packet: logonChallengeSuccess(this.challenge.B, this.challenge.salt) };
  }

  private async handleLogonProof(packet: Uint8Array): Promise<SessionResult> {
    this.status = "closed";
    const proof = parseLogonProof(packet);
    if (!this.challenge || !this.account || proof.securityFlags !== 0) {
      return { action: "close", packet: logonProofFailure() };
    }

    const sessionKey = verifyClientProof(this.challenge, proof.A, proof.clientM);
    if (!sessionKey) {
      return { action: "send", packet: logonProofFailure() };
    }

    await saveSessionKey(this.db, this.account.username, sessionKey);
    this.account.sessionKey = sessionKey;
    this.challenge = null;
    this.status = "authed";
    return { action: "send", packet: logonProofSuccess(sessionVerifier(proof.A, proof.clientM, sessionKey)) };
  }

  private async handleReconnectChallenge(packet: Uint8Array): Promise<SessionResult> {
    this.status = "closed";
    const challenge = parseLogonChallenge(packet);
    if (!challenge || challenge.username.length === 0 || challenge.username.length > 16) {
      return { action: "close" };
    }
    this.clientBuild = challenge.build;
    if (!acceptedBuild(challenge.build)) {
      return { action: "close", packet: reconnectChallengeFailure() };
    }

    const account = await findAccount(this.db, upperLatin(challenge.username));
    if (!account?.session_key) {
      return { action: "send", packet: reconnectChallengeFailure() };
    }

    this.account = { username: account.username, sessionKey: account.session_key };
    this.reconnectNonce = crypto.getRandomValues(new Uint8Array(16));
    this.status = "reconnect_proof";
    return { action: "send", packet: reconnectChallengeSuccess(this.reconnectNonce) };
  }

  private handleReconnectProof(packet: Uint8Array): SessionResult {
    this.status = "closed";
    const proof = parseReconnectProof(packet);
    if (!this.account?.sessionKey || !this.reconnectNonce) {
      return { action: "close" };
    }
    const expected = reconnectProof(this.account.username, proof.clientNonce, this.reconnectNonce, this.account.sessionKey);
    if (!equalBytes(expected, proof.proof)) {
      return { action: "close" };
    }
    this.reconnectNonce = null;
    this.status = "authed";
    return { action: "send", packet: reconnectProofSuccess() };
  }

  private async handleRealmList(): Promise<SessionResult> {
    this.status = "authed";
    return { action: "send", packet: realmListPacket(await listRealms(this.db), this.clientBuild) };
  }
}

export function expectedPacketLength(status: AuthStatus, buffer: Uint8Array): number | "wait" | "drop" | "close" {
  const command = buffer[0];
  if (command === undefined) {
    return "wait";
  }
  const required = statusForCommand(command);
  if (required === null) {
    return "drop";
  }
  if (required !== status) {
    return "close";
  }
  if (command === AUTH_LOGON_CHALLENGE || command === AUTH_RECONNECT_CHALLENGE) {
    if (buffer.length < CHALLENGE_HEADER_SIZE) {
      return "wait";
    }
    const size = buffer[2]! | (buffer[3]! << 8);
    const total = CHALLENGE_HEADER_SIZE + size;
    if (total > MAX_CHALLENGE_PACKET_SIZE) {
      return "close";
    }
    return buffer.length < total ? "wait" : total;
  }
  const fixed = fixedPacketSize(command);
  return buffer.length < fixed ? "wait" : fixed;
}

function statusForCommand(command: number): AuthStatus | null {
  switch (command) {
    case AUTH_LOGON_CHALLENGE:
    case AUTH_RECONNECT_CHALLENGE:
      return "challenge";
    case AUTH_LOGON_PROOF:
      return "logon_proof";
    case AUTH_RECONNECT_PROOF:
      return "reconnect_proof";
    case REALM_LIST:
      return "authed";
    default:
      return null;
  }
}

function fixedPacketSize(command: number): number {
  switch (command) {
    case AUTH_LOGON_PROOF:
      return LOGON_PROOF_PACKET_SIZE;
    case AUTH_RECONNECT_PROOF:
      return RECONNECT_PROOF_PACKET_SIZE;
    case REALM_LIST:
      return REALM_LIST_PACKET_SIZE;
    default:
      return 0;
  }
}