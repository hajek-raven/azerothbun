import { equalBytes } from "./equal-bytes.ts";

const N = 0x894b645e89e1535bbdad5b8b290650530801b18ebfbf5e8fab3c82872a3e9bb7n;
const G = 7n;
const EPHEMERAL_LENGTH = 32;
const SHA1_LENGTH = 20;
const SESSION_KEY_LENGTH = 40;

export const N_BYTES = bigIntToBytesLE(N, EPHEMERAL_LENGTH);
export const G_BYTES = Uint8Array.of(7);

export type Registration = {
  salt: Uint8Array;
  verifier: Uint8Array;
};

export type ServerChallenge = {
  username: string;
  salt: Uint8Array;
  B: Uint8Array;
  secret: bigint;
  verifier: bigint;
};

export type ClientProof = {
  A: Uint8Array;
  M1: Uint8Array;
  sessionKey: Uint8Array;
};

export function upperLatin(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += code >= 0x61 && code <= 0x7a ? String.fromCharCode(code - 0x20) : char;
  }
  return out;
}

export function makeRegistrationData(username: string, password: string): Registration {
  const salt = randomBytes(EPHEMERAL_LENGTH);
  return { salt, verifier: calculateVerifier(upperLatin(username), password, salt) };
}

export function beginServerChallenge(username: string, salt: Uint8Array, verifier: Uint8Array): ServerChallenge {
  const secretBytes = randomBytes(EPHEMERAL_LENGTH);
  const secret = bytesToBigIntLE(secretBytes);
  const verifierInt = bytesToBigIntLE(verifier);
  const B = (modPow(G, secret, N) + 3n * verifierInt) % N;
  return {
    username: upperLatin(username),
    salt,
    B: bigIntToBytesLE(B, EPHEMERAL_LENGTH),
    secret,
    verifier: verifierInt,
  };
}

export function verifyClientProof(challenge: ServerChallenge, A: Uint8Array, clientM: Uint8Array): Uint8Array | null {
  const publicA = bytesToBigIntLE(A);
  if (publicA % N === 0n) {
    return null;
  }

  const u = bytesToBigIntLE(sha1(A, challenge.B));
  const S = modPow((publicA * modPow(challenge.verifier, u, N)) % N, challenge.secret, N);
  const sessionKey = sha1Interleave(bigIntToBytesLE(S, EPHEMERAL_LENGTH));
  const expected = proof(challenge.username, challenge.salt, A, challenge.B, sessionKey);
  return equalBytes(expected, clientM) ? sessionKey : null;
}

export function sessionVerifier(A: Uint8Array, clientM: Uint8Array, sessionKey: Uint8Array): Uint8Array {
  return sha1(A, clientM, sessionKey);
}

export function clientLogonProof(username: string, password: string, salt: Uint8Array, B: Uint8Array): ClientProof {
  const identity = upperLatin(username);
  const secret = bytesToBigIntLE(randomBytes(EPHEMERAL_LENGTH));
  const A = bigIntToBytesLE(modPow(G, secret, N), EPHEMERAL_LENGTH);
  const x = bytesToBigIntLE(sha1(salt, sha1(`${identity}:${password}`)));
  const u = bytesToBigIntLE(sha1(A, B));
  const verifier = modPow(G, x, N);
  const base = (bytesToBigIntLE(B) + N - (3n * verifier) % N) % N;
  const S = modPow(base, secret + u * x, N);
  const sessionKey = sha1Interleave(bigIntToBytesLE(S, EPHEMERAL_LENGTH));
  return { A, M1: proof(identity, salt, A, B, sessionKey), sessionKey };
}

export function reconnectProof(username: string, clientNonce: Uint8Array, serverNonce: Uint8Array, sessionKey: Uint8Array): Uint8Array {
  return sha1(upperLatin(username), clientNonce, serverNonce, sessionKey);
}

export function sha1(...parts: Array<Uint8Array | string>): Uint8Array {
  const hasher = new Bun.CryptoHasher("sha1");
  for (const part of parts) {
    hasher.update(part);
  }
  return hasher.digest();
}

function calculateVerifier(username: string, password: string, salt: Uint8Array): Uint8Array {
  const x = bytesToBigIntLE(sha1(salt, sha1(`${username}:${password}`)));
  return bigIntToBytesLE(modPow(G, x, N), EPHEMERAL_LENGTH);
}

function proof(username: string, salt: Uint8Array, A: Uint8Array, B: Uint8Array, sessionKey: Uint8Array): Uint8Array {
  const nHash = sha1(N_BYTES);
  const gHash = sha1(G_BYTES);
  const mixed = new Uint8Array(SHA1_LENGTH);
  for (let i = 0; i < SHA1_LENGTH; i++) {
    mixed[i] = nHash[i]! ^ gHash[i]!;
  }
  return sha1(mixed, sha1(username), salt, A, B, sessionKey);
}

function sha1Interleave(S: Uint8Array): Uint8Array {
  const even = new Uint8Array(EPHEMERAL_LENGTH / 2);
  const odd = new Uint8Array(EPHEMERAL_LENGTH / 2);
  for (let i = 0; i < even.length; i++) {
    even[i] = S[2 * i]!;
    odd[i] = S[2 * i + 1]!;
  }

  let p = 0;
  while (p < EPHEMERAL_LENGTH && S[p] === 0) {
    p += 1;
  }
  if (p & 1) {
    p += 1;
  }
  p /= 2;

  const hash0 = sha1(even.subarray(p));
  const hash1 = sha1(odd.subarray(p));
  const key = new Uint8Array(SESSION_KEY_LENGTH);
  for (let i = 0; i < SHA1_LENGTH; i++) {
    key[2 * i] = hash0[i]!;
    key[2 * i + 1] = hash1[i]!;
  }
  return key;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === 1n) {
    return 0n;
  }
  let result = 1n;
  let value = ((base % modulus) + modulus) % modulus;
  let exp = exponent;
  while (exp > 0n) {
    if (exp & 1n) {
      result = (result * value) % modulus;
    }
    exp >>= 1n;
    value = (value * value) % modulus;
  }
  return result;
}

function bytesToBigIntLE(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(`0x${bytes.toReversed().toHex()}`);
}

/** Low `length` bytes of `value`, little-endian. */
function bigIntToBytesLE(value: bigint, length: number): Uint8Array {
  return Uint8Array.fromHex(value.toString(16).padStart(length * 2, "0").slice(-length * 2)).reverse();
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}
