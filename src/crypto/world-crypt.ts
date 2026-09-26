import { Arc4 } from "./arc4.ts";

const SERVER_ENCRYPTION_KEY = Uint8Array.from([
  0xcc, 0x98, 0xae, 0x04, 0xe8, 0x97, 0xea, 0xca, 0x12, 0xdd, 0xc0, 0x93, 0x42, 0x91, 0x53, 0x57,
]);
const SERVER_DECRYPTION_KEY = Uint8Array.from([
  0xc2, 0xb3, 0x72, 0x3c, 0xc6, 0xae, 0xd9, 0xb5, 0x34, 0x3c, 0x53, 0xee, 0x2f, 0x43, 0x67, 0xce,
]);

export class WorldCrypt {
  private readonly encrypt: Arc4;
  private readonly decrypt: Arc4;

  constructor(sessionKey: Uint8Array, role: "server" | "client" = "server") {
    const encryptKey = role === "server" ? SERVER_ENCRYPTION_KEY : SERVER_DECRYPTION_KEY;
    const decryptKey = role === "server" ? SERVER_DECRYPTION_KEY : SERVER_ENCRYPTION_KEY;
    this.encrypt = new Arc4(hmacSha1(encryptKey, sessionKey));
    this.decrypt = new Arc4(hmacSha1(decryptKey, sessionKey));
    const drop = new Uint8Array(1024);
    this.encrypt.process(drop);
    this.decrypt.process(drop);
  }

  encryptHeader(header: Uint8Array): void {
    this.encrypt.process(header);
  }

  decryptHeader(header: Uint8Array): void {
    this.decrypt.process(header);
  }
}

function hmacSha1(key: Uint8Array, data: Uint8Array): Uint8Array {
  const hasher = new Bun.CryptoHasher("sha1", key);
  hasher.update(data);
  return hasher.digest();
}
