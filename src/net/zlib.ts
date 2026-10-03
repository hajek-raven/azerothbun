/**
 * zlib streams (RFC 1950) over `Bun.deflateSync`, which writes the raw deflate data: the two byte header, the deflate data,
 * and the Adler-32 of the uncompressed bytes, big endian. The client reads `SMSG_COMPRESSED_UPDATE_OBJECT` with `uncompress`.
 */

/** Adler-32 of `data` (RFC 1950). */
export function adler32(data: Uint8Array): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  // 5552 is the largest n for which the sums stay below 2^32 before the modulo
  for (let start = 0; start < data.length; start += 5552) {
    const end = Math.min(start + 5552, data.length);
    for (let i = start; i < end; i++) {
      a += data[i]!;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** `compress2`: a zlib stream of `data` (default level 1, the world server's default `Compression`). */
export function zlibCompress(data: Uint8Array, level: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 1): Uint8Array {
  const raw = Bun.deflateSync(data as Uint8Array<ArrayBuffer>, { level });
  const out = new Uint8Array(2 + raw.length + 4);
  // CMF: deflate with a 32K window; FLG: the check bits for the level (FCHECK makes the pair a multiple of 31)
  out[0] = 0x78;
  out[1] = level === 1 ? 0x01 : level < 6 ? 0x5e : level === 6 ? 0x9c : 0xda;
  out.set(raw, 2);
  new DataView(out.buffer).setUint32(2 + raw.length, adler32(data), false);
  return out;
}
