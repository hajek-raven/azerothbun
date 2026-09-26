import { expect, test } from "bun:test";
import { Arc4 } from "./arc4.ts";
import { WorldCrypt } from "./world-crypt.ts";

test("ARC4 is symmetric", () => {
  const key = Uint8Array.from([1, 2, 3, 4, 5]);
  const plain = Uint8Array.from([9, 8, 7, 6, 5, 4]);
  const cipher = new Arc4(key);
  const again = new Arc4(key);
  cipher.process(plain);
  again.process(plain);
  expect(plain).toEqual(Uint8Array.from([9, 8, 7, 6, 5, 4]));
});

test("server and client header ciphers undo each other", () => {
  const sessionKey = new Uint8Array(40);
  crypto.getRandomValues(sessionKey);
  const server = new WorldCrypt(sessionKey, "server");
  const client = new WorldCrypt(sessionKey, "client");
  const header = Uint8Array.from([0, 6, 0xdc, 0x01, 0, 0]);
  const original = header.slice();
  client.encryptHeader(header);
  server.decryptHeader(header);
  expect(header).toEqual(original);
});
