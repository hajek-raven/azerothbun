import { expect, test } from "bun:test";
import type { Socket } from "bun";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import { clientLogonProof, reconnectProof, sessionVerifier } from "../crypto/srp6.ts";
import { testDatabases } from "../database/test-db.ts";
import { seedDevelopmentAccounts } from "../db.ts";
import {
  AUTH_LOGON_CHALLENGE,
  AUTH_LOGON_PROOF,
  AUTH_RECONNECT_CHALLENGE,
  AUTH_RECONNECT_PROOF,
  REALM_LIST,
  WOW_FAIL_UNKNOWN_ACCOUNT,
  WOW_FAIL_VERSION_INVALID,
  WOW_SUCCESS,
} from "./packets.ts";
import { startAuthServer } from "./server.ts";

test("unknown account is rejected without revealing that it is missing", async () => {
  const port = await listen();
  const client = await connect(port);
  client.send(logonChallenge("MISSING", 12340));
  const response = await client.read(3);

  expect(response[0]).toBe(AUTH_LOGON_CHALLENGE);
  expect(response[1]).toBe(0x00);
  expect(response[2]).toBe(WOW_FAIL_UNKNOWN_ACCOUNT);
  client.close();
});

test("a build other than 12340 is rejected", async () => {
  const client = await connect(await listen());
  client.send(logonChallenge("TEST", 12341));
  const response = await client.read(3);

  expect(response[2]).toBe(WOW_FAIL_VERSION_INVALID);
  client.close();
});

test("TEST logs in, sees the local realm, and can reconnect", async () => {
  const port = await listen();
  const client = await connect(port);
  client.send(logonChallenge("test", 12340));
  const challenge = await readLogonChallenge(client);
  const proof = clientLogonProof("TEST", "TEST", challenge.salt, challenge.B);

  client.send(logonProof(proof.A, proof.M1));
  const proofReader = new ByteReader(await client.read(32));
  expect(proofReader.readU8()).toBe(AUTH_LOGON_PROOF);
  expect(proofReader.readU8()).toBe(WOW_SUCCESS);
  expect(proofReader.readBytes(20)).toEqual(sessionVerifier(proof.A, proof.M1, proof.sessionKey));

  client.send(realmListRequest());
  const realms = await readRealmList(client);
  // `realmlist` row 1 from sql/base/db_auth.
  expect(realms).toContain("AzerothCore");
  expect(realms).toContain("127.0.0.1:8085");

  const reconnect = await connect(port);
  reconnect.send(logonChallenge("TEST", 12340, AUTH_RECONNECT_CHALLENGE));
  const reconnectReader = new ByteReader(await reconnect.read(34));
  expect(reconnectReader.readU8()).toBe(AUTH_RECONNECT_CHALLENGE);
  expect(reconnectReader.readU8()).toBe(WOW_SUCCESS);
  const serverNonce = reconnectReader.readBytes(16);
  const clientNonce = new Uint8Array(16);
  crypto.getRandomValues(clientNonce);
  reconnect.send(reconnectProofPacket(clientNonce, reconnectProof("TEST", clientNonce, serverNonce, proof.sessionKey)));
  const reconnectProofResponse = await reconnect.read(4);
  expect(reconnectProofResponse[0]).toBe(AUTH_RECONNECT_PROOF);
  expect(reconnectProofResponse[1]).toBe(WOW_SUCCESS);

  client.close();
  reconnect.close();
});

function logonChallenge(username: string, build: number, command = AUTH_LOGON_CHALLENGE): Uint8Array {
  const name = new TextEncoder().encode(username);
  const body = new ByteWriter()
    .writeBytes(Uint8Array.from([0x57, 0x6f, 0x57, 0x00]))
    .writeU8(3)
    .writeU8(3)
    .writeU8(5)
    .writeU16(build)
    .writeBytes(new Uint8Array(4))
    .writeBytes(new Uint8Array(4))
    .writeBytes(new Uint8Array(4))
    .writeU32(0)
    .writeU32(0)
    .writeU8(name.length)
    .writeBytes(name)
    .toUint8Array();
  return new ByteWriter().writeU8(command).writeU8(0).writeU16(body.length).writeBytes(body).toUint8Array();
}

function logonProof(A: Uint8Array, M1: Uint8Array): Uint8Array {
  return new ByteWriter().writeU8(AUTH_LOGON_PROOF).writeBytes(A).writeBytes(M1).writeBytes(new Uint8Array(20)).writeU8(0).writeU8(0).toUint8Array();
}

function reconnectProofPacket(clientNonce: Uint8Array, proof: Uint8Array): Uint8Array {
  return new ByteWriter().writeU8(AUTH_RECONNECT_PROOF).writeBytes(clientNonce).writeBytes(proof).writeBytes(new Uint8Array(20)).writeU8(0).toUint8Array();
}

function realmListRequest(): Uint8Array {
  return new ByteWriter().writeU8(REALM_LIST).writeU32(0).toUint8Array();
}

async function readLogonChallenge(client: TestClient): Promise<{ B: Uint8Array; salt: Uint8Array }> {
  const header = await client.read(3);
  expect(header[0]).toBe(AUTH_LOGON_CHALLENGE);
  expect(header[2]).toBe(WOW_SUCCESS);
  const B = await client.read(32);
  const gLength = (await client.read(1))[0] ?? 0;
  await client.read(gLength);
  const nLength = (await client.read(1))[0] ?? 0;
  await client.read(nLength);
  const salt = await client.read(32);
  await client.read(17);
  return { B, salt };
}

async function readRealmList(client: TestClient): Promise<string> {
  const header = await client.read(3);
  expect(header[0]).toBe(REALM_LIST);
  const size = header[1]! | (header[2]! << 8);
  return new TextDecoder().decode(await client.read(size));
}

type TestClient = {
  send: (packet: Uint8Array) => void;
  read: (length: number) => Promise<Uint8Array>;
  close: () => void;
};

async function listen(): Promise<number> {
  const { login, characters } = await testDatabases();
  await seedDevelopmentAccounts(login, characters, null);
  const server = startAuthServer({
    hostname: "127.0.0.1",
    port: 0,
    db: login,
  });
  return server.port ?? 0;
}

async function connect(port: number): Promise<TestClient> {
  let pending = new Uint8Array(0);
  let notify: (() => void) | null = null;
  const socket = await Bun.connect<undefined>({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket: Socket<undefined>, data: Uint8Array) {
        const next = new Uint8Array(pending.length + data.length);
        next.set(pending, 0);
        next.set(data, pending.length);
        pending = next;
        notify?.();
        notify = null;
      },
      open() {},
      close() {},
      drain() {},
      error() {},
      connectError() {},
      end() {},
    },
  });

  return {
    send(packet) {
      socket.write(packet);
    },
    read(length) {
      return new Promise((resolve) => {
        const take = () => {
          if (pending.length < length) {
            notify = take;
            return;
          }
          const out = pending.slice(0, length);
          pending = pending.subarray(length);
          resolve(out);
        };
        take();
      });
    },
    close() {
      socket.end();
    },
  };
}
