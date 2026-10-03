/** `Acore::Crypto::TOTP` (RFC 6238 over HMAC-SHA1, 30 second steps, 6 digits). */
const TOTP_INTERVAL = 30;

export const TOTP = {
  RECOMMENDED_SECRET_LENGTH: 20,

  /** @ac common/Cryptography/TOTP.cpp Acore::Crypto::TOTP::GenerateToken */
  GenerateToken(secret: Uint8Array, timestamp: number): number {
    let counter = BigInt(Math.floor(timestamp / TOTP_INTERVAL));
    const challenge = new Uint8Array(8);
    for (let i = 8; i--; counter >>= 8n) challenge[i] = Number(counter & 0xffn);
    const hmac = new Bun.CryptoHasher("sha1", secret);
    hmac.update(challenge);
    const digest = hmac.digest();
    const offset = digest[19]! & 0xf;
    const truncated = ((digest[offset]! << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!) & 0x7fffffff;
    return truncated % 1000000;
  },

  /** @ac common/Cryptography/TOTP.cpp Acore::Crypto::TOTP::ValidateToken */
  ValidateToken(secret: Uint8Array, token: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    return token === TOTP.GenerateToken(secret, now - TOTP_INTERVAL) || token === TOTP.GenerateToken(secret, now) || token === TOTP.GenerateToken(secret, now + TOTP_INTERVAL);
  },
};
