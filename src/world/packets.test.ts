import { expect, test } from "bun:test";
import { WorldCrypt } from "../crypto/world-crypt.ts";
import { encodeServerPacket, sealServerPacket, serverHeaderSize } from "./packets.ts";

const sessionKey = Uint8Array.from({ length: 40 }, (_, index) => index + 1);

function readHeader(client: WorldCrypt, wire: Uint8Array): { size: number; opcode: number } {
  const header = wire.slice(0, 4);
  client.decryptHeader(header);
  if ((header[0]! & 0x80) === 0) {
    return { size: (header[0]! << 8) | header[1]!, opcode: header[2]! | (header[3]! << 8) };
  }
  const last = wire.slice(4, 5);
  client.decryptHeader(last);
  return { size: ((header[0]! & 0x7f) << 16) | (header[1]! << 8) | header[2]!, opcode: header[3]! | (header[4]! << 8) };
}

test("headers are encrypted in the order packets reach the socket, not the order they were built", () => {
  const server = new WorldCrypt(sessionKey);
  const client = new WorldCrypt(sessionKey, "client");
  // A handler builds its reply, then awaits the database while the world tick sends another packet first.
  const reply = encodeServerPacket(0x160, new Uint8Array(10));
  const tick = encodeServerPacket(0x0a9, new Uint8Array(3));
  expect(readHeader(client, sealServerPacket(tick, server))).toEqual({ size: 5, opcode: 0x0a9 });
  expect(readHeader(client, sealServerPacket(reply, server))).toEqual({ size: 12, opcode: 0x160 });
});

test("sealing copies the packet, so one encoded packet can go to several sockets", () => {
  const packet = encodeServerPacket(0x0a9, new Uint8Array(3));
  const plain = packet.slice();
  sealServerPacket(packet, new WorldCrypt(sessionKey));
  expect(packet).toEqual(plain);
});

test("packets over 0x7FFF bytes use the 5-byte ServerPktHeader", () => {
  const packet = encodeServerPacket(0x0a9, new Uint8Array(0x9000));
  expect(serverHeaderSize(packet)).toBe(5);
  expect(packet.length).toBe(5 + 0x9000);
  const server = new WorldCrypt(sessionKey);
  const client = new WorldCrypt(sessionKey, "client");
  expect(readHeader(client, sealServerPacket(packet, server))).toEqual({ size: 0x9002, opcode: 0x0a9 });
  expect(serverHeaderSize(encodeServerPacket(0x0a9, new Uint8Array(0x7ffd)))).toBe(4);
});
