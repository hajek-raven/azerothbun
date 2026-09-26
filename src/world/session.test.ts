import { expect, test } from "bun:test";
import type { Socket } from "bun";
import { ByteWriter } from "../net/byte-buffer.ts";
import { WorldCrypt } from "../crypto/world-crypt.ts";
import { findCharacterById, openAuthDatabase, saveSessionKey } from "../db.ts";
import {
  AUTH_OK,
  authSeed,
  CMSG_AUTH_SESSION,
  CMSG_CHAR_ENUM,
  CMSG_PING,
  encodeClientPacket,
  sessionDigest,
  SMSG_AUTH_CHALLENGE,
  SMSG_AUTH_RESPONSE,
  SMSG_CHAR_ENUM,
  SMSG_LOGIN_VERIFY_WORLD,
  SMSG_PONG,
  SMSG_LOGOUT_COMPLETE,
  SMSG_NAME_QUERY_RESPONSE,
  SMSG_QUERY_TIME_RESPONSE,
  SMSG_UPDATE_OBJECT,
  CMSG_LOGOUT_REQUEST,
  CMSG_NAME_QUERY,
  CMSG_QUERY_TIME,
  CMSG_STANDSTATECHANGE,
  SMSG_STANDSTATE_UPDATE,
} from "./packets.ts";
import { ConfigMgr, ConfigSeverity, defaultConfigPolicy } from "../common/config.ts";
import { ServerConfig, WorldConfig } from "../game/world/world-config.ts";
import { CMSG_PLAYER_LOGIN } from "./opcodes.ts";
import { startWorldServer, timeOutTimeSeconds } from "./server.ts";

test("authenticated client receives the seeded character", async () => {
  const sessionKey = new Uint8Array(40);
  crypto.getRandomValues(sessionKey);
  const db = openAuthDatabase(":memory:");
  saveSessionKey(db, "TEST", sessionKey);
  const server = startWorldServer({ hostname: "127.0.0.1", port: 0, db });
  const client = await connect(server.port ?? 0);

  const challenge = await readServerPacket(client, null);
  expect(challenge.opcode).toBe(SMSG_AUTH_CHALLENGE);
  const clientSeed = Uint8Array.from([1, 2, 3, 4]);
  client.send(
    encodeClientPacket(
      CMSG_AUTH_SESSION,
      authSession("TEST", 12340, 1, clientSeed, sessionDigest("TEST", clientSeed, authSeed(challenge.raw), sessionKey)),
      null,
    ),
  );

  const crypt = new WorldCrypt(sessionKey, "client");
  const response = await readServerPacket(client, crypt);
  expect(response.opcode).toBe(SMSG_AUTH_RESPONSE);
  expect(response.payload[0]).toBe(AUTH_OK);
  await readServerPacket(client, crypt);
  await readServerPacket(client, crypt);

  client.send(encodeClientPacket(CMSG_CHAR_ENUM, new Uint8Array(0), crypt));
  const characters = await readServerPacket(client, crypt);
  expect(characters.opcode).toBe(SMSG_CHAR_ENUM);
  expect(characters.payload[0]).toBe(1);
  expect(new TextDecoder().decode(characters.payload)).toContain("Test");

  client.send(encodeClientPacket(CMSG_PING, new ByteWriter().writeU32(42).writeU32(0).toUint8Array(), crypt));
  const pong = await readServerPacket(client, crypt);
  expect(pong.opcode).toBe(SMSG_PONG);
  expect(pong.payload[0]).toBe(42);

  client.send(encodeClientPacket(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array(), crypt));
  const entered = new Map<number, Uint8Array>();
  for (let index = 0; index < 17; index++) {
    const packet = await readServerPacket(client, crypt);
    entered.set(packet.opcode, packet.payload);
  }
  const verify = entered.get(SMSG_LOGIN_VERIFY_WORLD);
  expect(verify).toBeDefined();
  expect(verify![0]! | (verify![1]! << 8) | (verify![2]! << 16) | (verify![3]! << 24)).toBe(0);
  expect(entered.has(SMSG_UPDATE_OBJECT)).toBe(true);

  client.send(encodeClientPacket(CMSG_NAME_QUERY, new ByteWriter().writeU64(1n).toUint8Array(), crypt));
  const name = await readServerPacket(client, crypt);
  expect(name.opcode).toBe(SMSG_NAME_QUERY_RESPONSE);
  expect(new TextDecoder().decode(name.payload)).toContain("Test");

  client.send(encodeClientPacket(CMSG_QUERY_TIME, new Uint8Array(0), crypt));
  const time = await readServerPacket(client, crypt);
  expect(time.opcode).toBe(SMSG_QUERY_TIME_RESPONSE);

  client.send(encodeClientPacket(CMSG_STANDSTATECHANGE, new ByteWriter().writeU32(1).toUint8Array(), crypt));
  const sat = await readServerPacket(client, crypt);
  expect(sat.opcode).toBe(SMSG_STANDSTATE_UPDATE);
  expect(sat.payload[0]).toBe(1);
  const satUpdate = await readServerPacket(client, crypt);
  expect(satUpdate.opcode).toBe(SMSG_UPDATE_OBJECT);

  client.send(encodeClientPacket(CMSG_STANDSTATECHANGE, new ByteWriter().writeU32(1).toUint8Array(), crypt));
  const satAgain = await readServerPacket(client, crypt);
  expect(satAgain.opcode).toBe(SMSG_STANDSTATE_UPDATE);
  expect(satAgain.payload[0]).toBe(1);
  client.send(encodeClientPacket(CMSG_PING, new ByteWriter().writeU32(7).writeU32(0).toUint8Array(), crypt));
  const satPong = await readServerPacket(client, crypt);
  expect(satPong.opcode).toBe(SMSG_PONG);

  client.send(encodeClientPacket(CMSG_STANDSTATECHANGE, new ByteWriter().writeU32(7).toUint8Array(), crypt));
  client.send(encodeClientPacket(CMSG_PING, new ByteWriter().writeU32(8).writeU32(0).toUint8Array(), crypt));
  const deadPong = await readServerPacket(client, crypt);
  expect(deadPong.opcode).toBe(SMSG_PONG);

  client.send(encodeClientPacket(0x0b5, movement(1n, -8900, -100, 84, 0x1), crypt));
  const stood = await readUntil(client, crypt, new Set([SMSG_STANDSTATE_UPDATE]));
  expect(stood.get(SMSG_STANDSTATE_UPDATE)?.[0]).toBe(0);

  client.send(encodeClientPacket(0x0ee, movement(1n, -8900, -100, 84), crypt));
  client.send(encodeClientPacket(CMSG_LOGOUT_REQUEST, new Uint8Array(0), crypt));
  const logout = await readUntil(client, crypt, new Set([SMSG_LOGOUT_COMPLETE]));
  expect(logout.has(SMSG_LOGOUT_COMPLETE)).toBe(true);
  const saved = findCharacterById(db, 1);
  expect(saved?.position_x).toBeCloseTo(-8900);
  expect(saved?.position_z).toBeCloseTo(84);

  client.close();
  server.stop(true);
});

test("a dropped connection saves the character like LogoutPlayer(true)", async () => {
  const sessionKey = crypto.getRandomValues(new Uint8Array(40));
  const db = openAuthDatabase(":memory:");
  saveSessionKey(db, "TEST", sessionKey);
  const server = startWorldServer({ hostname: "127.0.0.1", port: 0, db });
  const client = await connect(server.port ?? 0);
  const challenge = await readServerPacket(client, null);
  const clientSeed = Uint8Array.of(5, 6, 7, 8);
  client.send(
    encodeClientPacket(
      CMSG_AUTH_SESSION,
      authSession("TEST", 12340, 1, clientSeed, sessionDigest("TEST", clientSeed, authSeed(challenge.raw), sessionKey)),
      null,
    ),
  );
  const crypt = new WorldCrypt(sessionKey, "client");
  await readServerPacket(client, crypt);
  await readServerPacket(client, crypt);
  await readServerPacket(client, crypt);
  client.send(encodeClientPacket(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(1n).toUint8Array(), crypt));
  await readUntil(client, crypt, new Set([SMSG_LOGIN_VERIFY_WORLD]));

  client.send(encodeClientPacket(0x0b5, movement(1n, -8800, -120, 84, 0x1), crypt));
  client.send(encodeClientPacket(CMSG_PING, new ByteWriter().writeU32(1).writeU32(0).toUint8Array(), crypt));
  await readUntil(client, crypt, new Set([SMSG_PONG]));
  expect(findCharacterById(db, 1)?.position_x).not.toBeCloseTo(-8800);

  client.close();
  await Bun.sleep(50);
  expect(findCharacterById(db, 1)?.position_x).toBeCloseTo(-8800);
  server.stop(true);
});

test("idle timeouts follow ResetTimeOutTime", () => {
  const settings = worldSettings();
  settings.overwrite(ServerConfig.CONFIG_SOCKET_TIMEOUTTIME, 900000);
  settings.overwrite(ServerConfig.CONFIG_SOCKET_TIMEOUTTIME_ACTIVE, 60000);
  expect(timeOutTimeSeconds({ authenticated: false, inWorld: false }, settings, false)).toBeNull();
  expect(timeOutTimeSeconds({ authenticated: true, inWorld: false }, settings, false)).toBe(900);
  expect(timeOutTimeSeconds({ authenticated: true, inWorld: false }, settings, true)).toBeNull();
  expect(timeOutTimeSeconds({ authenticated: true, inWorld: true }, settings, true)).toBe(60);
  settings.overwrite(ServerConfig.CONFIG_SOCKET_TIMEOUTTIME, 0);
  expect(timeOutTimeSeconds({ authenticated: true, inWorld: false }, settings, false)).toBe(1);
});

test(
  "an authenticated connection idle on character select is closed",
  async () => {
    const sessionKey = crypto.getRandomValues(new Uint8Array(40));
    const db = openAuthDatabase(":memory:");
    saveSessionKey(db, "TEST", sessionKey);
    const settings = worldSettings();
    settings.overwrite(ServerConfig.CONFIG_SOCKET_TIMEOUTTIME, 1000);
    const server = startWorldServer({ hostname: "127.0.0.1", port: 0, db, settings });
    const client = await connect(server.port ?? 0);
    const challenge = await readServerPacket(client, null);
    const clientSeed = Uint8Array.of(1, 1, 2, 3);
    client.send(
      encodeClientPacket(
        CMSG_AUTH_SESSION,
        authSession("TEST", 12340, 1, clientSeed, sessionDigest("TEST", clientSeed, authSeed(challenge.raw), sessionKey)),
        null,
      ),
    );
    const crypt = new WorldCrypt(sessionKey, "client");
    expect((await readServerPacket(client, crypt)).opcode).toBe(SMSG_AUTH_RESPONSE);
    await client.closed;
    server.stop(true);
  },
  10_000,
);

function worldSettings(): WorldConfig {
  const config = new ConfigMgr();
  const policy = defaultConfigPolicy();
  policy.missingOptionSeverity = ConfigSeverity.Skip;
  policy.criticalOptionSeverity = ConfigSeverity.Skip;
  policy.valueErrorSeverity = ConfigSeverity.Skip;
  config.configure("", [], "", policy);
  const settings = new WorldConfig(config);
  settings.load();
  return settings;
}

function movement(guid: bigint, x: number, y: number, z: number, flags = 0): Uint8Array {
  return new ByteWriter()
    .writeU8(0x01)
    .writeU8(Number(guid & 0xffn))
    .writeU32(flags)
    .writeU16(0)
    .writeU32(1)
    .writeF32(x)
    .writeF32(y)
    .writeF32(z)
    .writeF32(0)
    .writeU32(0)
    .toUint8Array();
}

function authSession(account: string, build: number, realmId: number, clientSeed: Uint8Array, digest: Uint8Array): Uint8Array {
  return new ByteWriter()
    .writeU32(build)
    .writeU32(0)
    .writeCString(account)
    .writeU32(0)
    .writeBytes(clientSeed)
    .writeU32(0)
    .writeU32(0)
    .writeU32(realmId)
    .writeU32(0)
    .writeU32(0)
    .writeBytes(digest)
    .writeU32(0)
    .toUint8Array();
}

async function readUntil(client: TestClient, crypt: WorldCrypt, wanted: Set<number>): Promise<Map<number, Uint8Array>> {
  const found = new Map<number, Uint8Array>();
  for (let index = 0; index < 24 && found.size < wanted.size; index++) {
    const packet = await readServerPacket(client, crypt);
    if (wanted.has(packet.opcode)) {
      found.set(packet.opcode, packet.payload);
    }
  }
  return found;
}

type ServerPacket = { opcode: number; payload: Uint8Array; raw: Uint8Array };

async function readServerPacket(client: TestClient, crypt: WorldCrypt | null): Promise<ServerPacket> {
  const header = await client.read(4);
  crypt?.decryptHeader(header);
  const size = (header[0]! << 8) | header[1]!;
  const opcode = header[2]! | (header[3]! << 8);
  const payload = await client.read(size - 2);
  const raw = new Uint8Array(header.length + payload.length);
  raw.set(header, 0);
  raw.set(payload, header.length);
  return { opcode, payload, raw };
}

type TestClient = {
  send: (packet: Uint8Array) => void;
  read: (length: number) => Promise<Uint8Array>;
  close: () => void;
  closed: Promise<void>;
};

async function connect(port: number): Promise<TestClient> {
  let pending = new Uint8Array(0);
  let notify: (() => void) | null = null;
  const closed = Promise.withResolvers<void>();
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
      close() {
        closed.resolve();
      },
      drain() {},
      error() {},
      connectError() {},
      end() {},
    },
  });
  return {
    closed: closed.promise,
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
