import { expect, test } from "bun:test";
import type { Socket } from "bun";
import { WorldCrypt } from "../crypto/world-crypt.ts";
import { eq } from "drizzle-orm";
import { seededTestDatabases } from "../database/test-db.ts";
import { characters } from "../database/schema/characters.ts";
import { listCharacters, saveSessionKey } from "../db.ts";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import {
  authSeed,
  CMSG_AUTH_SESSION,
  CMSG_CHAR_ENUM,
  CMSG_LOGOUT_REQUEST,
  encodeClientPacket,
  sessionDigest,
  SMSG_AUTH_CHALLENGE,
  SMSG_AUTH_RESPONSE,
  SMSG_CHAR_ENUM,
  SMSG_DESTROY_OBJECT,
  SMSG_LOGOUT_COMPLETE,
  SMSG_UPDATE_OBJECT,
} from "./packets.ts";
import { CMSG_PLAYER_LOGIN } from "./opcodes.ts";
import { startWorldServer } from "./server.ts";

const HEARTBEAT = 0x0ee;

test("nearby players are created, moved, and destroyed", async () => {
  const db = await seededTestDatabases();
  const server = startWorldServer({ hostname: "127.0.0.1", port: 0, db });
  const port = server.port ?? 0;
  const first = await enter(port, db, "TEST", 1, false);
  await db.characters.update(characters).set({ playerFlags: 32 }).where(eq(characters.name, "Testtwo"));
  const second = await enter(port, db, "TEST2", 2, true);
  expect(second.other?.[4]).toBe(3);
  expect(containsU32(second.other!, 49)).toBe(true);

  const appeared = await readServerPacket(first.client, first.crypt);
  expect(appeared.opcode).toBe(SMSG_UPDATE_OBJECT);
  expect(appeared.payload[4]).toBe(3);
  expect(containsU32(appeared.payload, 50)).toBe(true);

  const movedX = -8940;
  second.client.send(encodeClientPacket(HEARTBEAT, movement(2n, movedX, -136, 83.5312), second.crypt));
  const move = await readServerPacket(first.client, first.crypt);
  expect(move.opcode).toBe(HEARTBEAT);
  const moveReader = new ByteReader(move.payload);
  expect(moveReader.readU8()).toBe(0x01);
  expect(moveReader.readU8()).toBe(2);
  moveReader.readU32();
  moveReader.readU16();
  moveReader.readU32();
  expect(moveReader.readF32()).toBeCloseTo(movedX);

  second.client.send(encodeClientPacket(HEARTBEAT, movement(2n, movedX + 800, -136, 83.5312), second.crypt));
  const leaving = await readServerPacket(first.client, first.crypt);
  expect(leaving.opcode).toBe(HEARTBEAT);
  const gone = await readServerPacket(first.client, first.crypt);
  expect(gone.opcode).toBe(SMSG_UPDATE_OBJECT);
  expect(gone.payload[4]).toBe(4);

  second.client.send(encodeClientPacket(HEARTBEAT, movement(2n, movedX, -136, 83.5312), second.crypt));
  const back = await readServerPacket(first.client, first.crypt);
  expect(back.opcode).toBe(SMSG_UPDATE_OBJECT);
  expect(back.payload[4]).toBe(3);
  expect(containsU32(back.payload, 50)).toBe(true);

  second.client.send(encodeClientPacket(CMSG_LOGOUT_REQUEST, new Uint8Array(0), second.crypt));
  const destroyed = await readServerPacket(first.client, first.crypt);
  expect(destroyed.opcode).toBe(SMSG_DESTROY_OBJECT);
  expect(new ByteReader(destroyed.payload).readU64()).toBe(2n);
  const loggedOut = await readUntil(second.client, second.crypt, SMSG_LOGOUT_COMPLETE);
  expect(loggedOut).toBe(true);

  first.client.close();
  second.client.close();
  server.stop(true);
});

async function enter(
  port: number,
  db: Awaited<ReturnType<typeof seededTestDatabases>>,
  username: string,
  accountId: number,
  otherAlreadyIn: boolean,
): Promise<{ client: TestClient; crypt: WorldCrypt; other: Uint8Array | null }> {
  const sessionKey = new Uint8Array(40);
  crypto.getRandomValues(sessionKey);
  await saveSessionKey(db.login, username, sessionKey);
  const client = await connect(port);
  const challenge = await readServerPacket(client, null);
  expect(challenge.opcode).toBe(SMSG_AUTH_CHALLENGE);
  const clientSeed = Uint8Array.from([1, 2, 3, 4]);
  client.send(
    encodeClientPacket(
      CMSG_AUTH_SESSION,
      new ByteWriter()
        .writeU32(12340)
        .writeU32(0)
        .writeCString(username)
        .writeU32(0)
        .writeBytes(clientSeed)
        .writeU32(0)
        .writeU32(0)
        .writeU32(1)
        .writeU32(0)
        .writeU32(0)
        .writeBytes(sessionDigest(username, clientSeed, authSeed(challenge.raw), sessionKey))
        .writeU32(0)
        .toUint8Array(),
      null,
    ),
  );
  const crypt = new WorldCrypt(sessionKey, "client");
  const response = await readServerPacket(client, crypt);
  expect(response.opcode).toBe(SMSG_AUTH_RESPONSE);
  await readServerPacket(client, crypt);
  await readServerPacket(client, crypt);
  await readServerPacket(client, crypt);
  client.send(encodeClientPacket(CMSG_CHAR_ENUM, new Uint8Array(0), crypt));
  const enumerated = await readServerPacket(client, crypt);
  expect(enumerated.opcode).toBe(SMSG_CHAR_ENUM);
  const character = (await listCharacters(db.characters, accountId))[0];
  expect(character).toBeDefined();
  client.send(encodeClientPacket(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(BigInt(character!.guid)).toUint8Array(), crypt));
  let other: Uint8Array | null = null;
  const count = otherAlreadyIn ? 17 : 16;
  for (let index = 0; index < count; index++) {
    const packet = await readServerPacket(client, crypt);
    if (index === 16) {
      expect(packet.opcode).toBe(SMSG_UPDATE_OBJECT);
      other = packet.payload;
    }
  }
  return { client, crypt, other };
}

function movement(guid: bigint, x: number, y: number, z: number): Uint8Array {
  return new ByteWriter()
    .writeU8(0x01)
    .writeU8(Number(guid & 0xffn))
    .writeU32(0)
    .writeU16(0)
    .writeU32(1)
    .writeF32(x)
    .writeF32(y)
    .writeF32(z)
    .writeF32(0)
    .writeU32(0)
    .toUint8Array();
}

function containsU32(bytes: Uint8Array, value: number): boolean {
  for (let index = 0; index + 4 <= bytes.length; index++) {
    const found = bytes[index]! | (bytes[index + 1]! << 8) | (bytes[index + 2]! << 16) | (bytes[index + 3]! << 24);
    if ((found >>> 0) === value) {
      return true;
    }
  }
  return false;
}

async function readUntil(client: TestClient, crypt: WorldCrypt, opcode: number): Promise<boolean> {
  for (let index = 0; index < 8; index++) {
    const packet = await readServerPacket(client, crypt);
    if (packet.opcode === opcode) {
      return true;
    }
  }
  return false;
}

type ServerPacket = { opcode: number; payload: Uint8Array; raw: Uint8Array };

async function readServerPacket(client: TestClient, crypt: WorldCrypt | null): Promise<ServerPacket> {
  let header = await client.read(4);
  crypt?.decryptHeader(header);
  if ((header[0]! & 0x80) !== 0) {
    // `ServerPktHeader` for packets over 0x7FFF bytes: a 3-byte size, decrypted as one stream with the rest.
    const last = await client.read(1);
    crypt?.decryptHeader(last);
    header = Uint8Array.of(...header, last[0]!);
  }
  const large = header.length === 5;
  const size = large ? ((header[0]! & 0x7f) << 16) | (header[1]! << 8) | header[2]! : (header[0]! << 8) | header[1]!;
  const opcode = large ? header[3]! | (header[4]! << 8) : header[2]! | (header[3]! << 8);
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
};

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
