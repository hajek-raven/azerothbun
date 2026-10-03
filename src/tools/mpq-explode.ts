/**
 * PKWARE Data Compression Library "explode", binary mode (`MPQ_FILE_IMPLODE` blocks and mask 0x08). ASCII mode throws:
 * no archive of the 3.3.5a load order contains an imploded sector at all (every compressed block uses zlib or bzip2).
 *
 * @ac deps/libmpq/libmpq/explode.c libmpq__do_decompress_pkzip
 * @ac deps/libmpq/libmpq/extract.c libmpq__decompress_pkzip
 * @ac-skip ASCII mode literal tables (`pkzip_bits_asc`, `pkzip_code_asc`, `generate_tables_ascii`): never used by the client data
 */
export function explode(input: Uint8Array, expected: number): Uint8Array {
  if (input.length <= 4) {
    throw new Error("PKWARE: stream too short");
  }
  const out = new Uint8Array(expected);
  let outPos = 0;
  let inPos = 0;
  const ctype = input[inPos++]!;
  const dsizeBits = input[inPos++]!;
  if (dsizeBits < 4 || dsizeBits > 6) {
    throw new Error("PKWARE: invalid dictionary size");
  }
  let bitBuf = input[inPos++]! | 0;
  let extraBits = 0;

  const lenBits = [3, 2, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 7, 7];
  const lenCode = [0x05, 0x03, 0x01, 0x06, 0x0a, 0x02, 0x0c, 0x14, 0x04, 0x18, 0x08, 0x30, 0x10, 0x20, 0x40, 0x00];
  const exLenBits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
  const lenBase = [0x0000, 0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x0008, 0x000a, 0x000e, 0x0016, 0x0026, 0x0046, 0x0086, 0x0106];
  const distBits = [
    2, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 8, 8, 8, 8,
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
  ];
  const distCode = [
    0x03, 0x0d, 0x05, 0x19, 0x09, 0x11, 0x01, 0x3e, 0x1e, 0x2e, 0x0e, 0x36, 0x16, 0x26, 0x06, 0x3a, 0x1a, 0x2a, 0x0a, 0x32, 0x12, 0x22, 0x42, 0x02, 0x7c, 0x3c, 0x5c,
    0x1c, 0x6c, 0x2c, 0x4c, 0x0c, 0x74, 0x34, 0x54, 0x14, 0x64, 0x24, 0x44, 0x04, 0x78, 0x38, 0x58, 0x18, 0x68, 0x28, 0x48, 0x08, 0xf0, 0x70, 0xb0, 0x30, 0xd0, 0x50,
    0x90, 0x10, 0xe0, 0x60, 0xa0, 0x20, 0xc0, 0x40, 0x80, 0x00,
  ];
  if (ctype !== 0) {
    throw new Error("PKWARE ASCII mode is not supported (no 3.3.5a client archive uses it)");
  }

  const wasteBits = (count: number): boolean => {
    if (count <= extraBits) {
      extraBits -= count;
      bitBuf >>>= count;
      return true;
    }
    bitBuf >>>= extraBits;
    if (inPos >= input.length) {
      return false;
    }
    bitBuf |= input[inPos++]! << 8;
    bitBuf >>>= count - extraBits;
    extraBits = extraBits - count + 8;
    return true;
  };

  const decodeLit = (): number => {
    if (bitBuf & 1) {
      if (!wasteBits(1)) return 0x306;
      for (let index = 0; index < 16; index++) {
        const bits = lenBits[index]!;
        if ((bitBuf & ((1 << bits) - 1)) === lenCode[index]) {
          if (!wasteBits(bits)) return 0x306;
          let length = lenBase[index]!;
          const ex = exLenBits[index]!;
          if (ex) {
            const extra = bitBuf & ((1 << ex) - 1);
            if (!wasteBits(ex)) {
              if (index + extra !== 0x10e) return 0x306;
            }
            length += extra;
          }
          return length + 0x100;
        }
      }
      return 0x306;
    }
    if (!wasteBits(1)) return 0x306;
    const value = bitBuf & 0xff;
    if (!wasteBits(8)) return 0x306;
    return value;
  };

  const decodeDist = (length: number): number => {
    let index = 0;
    for (; index < 64; index++) {
      const bits = distBits[index]!;
      if ((bitBuf & ((1 << bits) - 1)) === distCode[index]) {
        if (!wasteBits(bits)) return 0;
        break;
      }
    }
    let dist: number;
    if (length === 2) {
      dist = (index << 2) | (bitBuf & 0x03);
      if (!wasteBits(2)) return 0;
    } else {
      dist = (index << dsizeBits) | (bitBuf & ((1 << dsizeBits) - 1));
      if (!wasteBits(dsizeBits)) return 0;
    }
    return dist + 1;
  };

  for (;;) {
    const lit = decodeLit();
    if (lit >= 0x305) {
      break;
    }
    if (lit < 0x100) {
      out[outPos++] = lit;
    } else {
      const length = lit - 0xfe;
      const dist = decodeDist(length);
      if (dist === 0) break;
      for (let index = 0; index < length && outPos < expected; index++) {
        out[outPos] = out[outPos - dist]!;
        outPos++;
      }
    }
    if (outPos >= expected) break;
  }
  return out;
}
