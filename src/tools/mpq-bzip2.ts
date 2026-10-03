/**
 * bzip2 decoder for MPQ sectors (`MPQ_COMPRESSION_BZIP2`, 0x10). libmpq links `libbz2` for this
 * (`libmpq__decompress_bzip2` in `deps/libmpq/libmpq/extract.c`); this is a TypeScript port of the bzip2 1.0
 * decompressor (`decompress.c`, `huffman.c`) that keeps the same stages: Huffman, MTF, run-length 2, inverse BWT,
 * run-length 1. Block and stream CRCs are not checked (libmpq's caller does not use them either).
 */

const BZ_MAX_GROUPS = 6;
const BZ_MAX_ALPHA_SIZE = 258;
const BZ_MAX_CODE_LEN = 23;
const BZ_G_SIZE = 50;
const BZ_RUNA = 0;
const BZ_RUNB = 1;

/** Block scratch (`tt`), grown to the largest block size seen so decoding sectors does not reallocate. */
let tt = new Uint32Array(0);

/** @ac-skip libbz2 is not part of azerothcore/deps; `BZ2_hbCreateDecodeTables` of bzip2 1.0 */
function hbCreateDecodeTables(
  limit: Int32Array,
  base: Int32Array,
  perm: Int32Array,
  length: Uint8Array,
  minLen: number,
  maxLen: number,
  alphaSize: number,
): void {
  let pp = 0;
  for (let i = minLen; i <= maxLen; i++) {
    for (let j = 0; j < alphaSize; j++) {
      if (length[j] === i) {
        perm[pp++] = j;
      }
    }
  }
  base.fill(0);
  for (let i = 0; i < alphaSize; i++) {
    base[length[i]! + 1]!++;
  }
  for (let i = 1; i < BZ_MAX_CODE_LEN; i++) {
    base[i] = base[i]! + base[i - 1]!;
  }
  limit.fill(0);
  let vec = 0;
  for (let i = minLen; i <= maxLen; i++) {
    vec += base[i + 1]! - base[i]!;
    limit[i] = vec - 1;
    vec <<= 1;
  }
  for (let i = minLen + 1; i <= maxLen; i++) {
    base[i] = ((limit[i - 1]! + 1) << 1) - base[i]!;
  }
}

/**
 * Decompress one bzip2 stream (`BZh1`..`BZh9`). `expected` is the size the MPQ block table promises; the output is
 * allocated with it and a stream that decodes to more bytes is an error.
 *
 * @ac deps/libmpq/libmpq/extract.c libmpq__decompress_bzip2
 */
export function bunzip2(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let outPos = 0;
  let inPos = 0;
  let bitBuf = 0;
  let bitLive = 0;

  const bits = (count: number): number => {
    while (bitLive < count) {
      if (inPos >= input.length) {
        throw new Error("bzip2: unexpected end of data");
      }
      bitBuf = (bitBuf << 8) | input[inPos++]!;
      bitLive += 8;
    }
    bitLive -= count;
    return (bitBuf >>> bitLive) & ((1 << count) - 1);
  };

  if (bits(8) !== 0x42 || bits(8) !== 0x5a || bits(8) !== 0x68) {
    throw new Error("bzip2: bad stream signature");
  }
  const level = bits(8) - 0x30;
  if (level < 1 || level > 9) {
    throw new Error("bzip2: bad block size");
  }
  const blockSizeMax = level * 100000;
  if (tt.length < blockSizeMax) {
    tt = new Uint32Array(blockSizeMax);
  }

  const inUse16 = new Uint8Array(16);
  const seqToUnseq = new Uint8Array(256);
  const mtf = new Uint8Array(256);
  const selectors = new Uint8Array(18002);
  const selectorMtf = new Uint8Array(18002);
  const lens = new Array<Uint8Array>(BZ_MAX_GROUPS);
  const limits = new Array<Int32Array>(BZ_MAX_GROUPS);
  const bases = new Array<Int32Array>(BZ_MAX_GROUPS);
  const perms = new Array<Int32Array>(BZ_MAX_GROUPS);
  const minLens = new Int32Array(BZ_MAX_GROUPS);
  for (let t = 0; t < BZ_MAX_GROUPS; t++) {
    lens[t] = new Uint8Array(BZ_MAX_ALPHA_SIZE);
    limits[t] = new Int32Array(BZ_MAX_CODE_LEN + 1);
    bases[t] = new Int32Array(BZ_MAX_CODE_LEN + 2);
    perms[t] = new Int32Array(BZ_MAX_ALPHA_SIZE);
  }
  const unzftab = new Int32Array(256);
  const cftab = new Int32Array(257);

  for (;;) {
    const magicHigh = bits(24);
    const magicLow = bits(24);
    if (magicHigh === 0x177245 && magicLow === 0x385090) {
      // end of stream marker followed by the combined CRC
      bits(16);
      bits(16);
      break;
    }
    if (magicHigh !== 0x314159 || magicLow !== 0x265359) {
      throw new Error("bzip2: bad block header");
    }
    bits(16); // block CRC
    bits(16);
    if (bits(1)) {
      throw new Error("bzip2: randomised blocks are not supported");
    }
    const origPtr = bits(24);

    // symbol map
    let nInUse = 0;
    for (let i = 0; i < 16; i++) {
      inUse16[i] = bits(1);
    }
    for (let i = 0; i < 16; i++) {
      if (inUse16[i]) {
        const word = bits(16);
        for (let j = 0; j < 16; j++) {
          if (word & (0x8000 >>> j)) {
            seqToUnseq[nInUse++] = i * 16 + j;
          }
        }
      }
    }
    if (nInUse === 0) {
      throw new Error("bzip2: empty symbol map");
    }
    const alphaSize = nInUse + 2;

    // selectors
    const nGroups = bits(3);
    if (nGroups < 2 || nGroups > BZ_MAX_GROUPS) {
      throw new Error("bzip2: bad group count");
    }
    const nSelectors = bits(15);
    if (nSelectors < 1) {
      throw new Error("bzip2: no selectors");
    }
    for (let i = 0; i < nSelectors; i++) {
      let j = 0;
      while (bits(1)) {
        j++;
        if (j >= nGroups) {
          throw new Error("bzip2: bad selector");
        }
      }
      if (i < selectorMtf.length) {
        selectorMtf[i] = j;
      }
    }
    const usedSelectors = Math.min(nSelectors, selectorMtf.length);
    {
      const pos = [0, 1, 2, 3, 4, 5];
      for (let i = 0; i < usedSelectors; i++) {
        let v = selectorMtf[i]!;
        const tmp = pos[v]!;
        while (v > 0) {
          pos[v] = pos[v - 1]!;
          v--;
        }
        pos[0] = tmp;
        selectors[i] = tmp;
      }
    }

    // coding tables
    for (let t = 0; t < nGroups; t++) {
      let curr = bits(5);
      const len = lens[t]!;
      for (let i = 0; i < alphaSize; i++) {
        for (;;) {
          if (curr < 1 || curr > 20) {
            throw new Error("bzip2: bad code length");
          }
          if (!bits(1)) {
            break;
          }
          if (!bits(1)) {
            curr++;
          } else {
            curr--;
          }
        }
        len[i] = curr;
      }
    }
    for (let t = 0; t < nGroups; t++) {
      const len = lens[t]!;
      let minLen = 32;
      let maxLen = 0;
      for (let i = 0; i < alphaSize; i++) {
        if (len[i]! > maxLen) maxLen = len[i]!;
        if (len[i]! < minLen) minLen = len[i]!;
      }
      hbCreateDecodeTables(limits[t]!, bases[t]!, perms[t]!, len, minLen, maxLen, alphaSize);
      minLens[t] = minLen;
    }

    // MTF values
    const eob = nInUse + 1;
    for (let i = 0; i < 256; i++) {
      mtf[i] = i;
      unzftab[i] = 0;
    }
    let nblock = 0;
    let groupNo = -1;
    let groupPos = 0;
    let gMinLen = 0;
    let gLimit = limits[0]!;
    let gBase = bases[0]!;
    let gPerm = perms[0]!;

    const nextSym = (): number => {
      if (groupPos === 0) {
        groupNo++;
        if (groupNo >= usedSelectors) {
          throw new Error("bzip2: ran out of selectors");
        }
        groupPos = BZ_G_SIZE;
        const table = selectors[groupNo]!;
        gMinLen = minLens[table]!;
        gLimit = limits[table]!;
        gBase = bases[table]!;
        gPerm = perms[table]!;
      }
      groupPos--;
      let zn = gMinLen;
      let zvec = bits(zn);
      while (zvec > gLimit[zn]!) {
        zn++;
        if (zn > 20) {
          throw new Error("bzip2: bad Huffman code");
        }
        zvec = (zvec << 1) | bits(1);
      }
      const index = zvec - gBase[zn]!;
      if (index < 0 || index >= BZ_MAX_ALPHA_SIZE) {
        throw new Error("bzip2: bad Huffman code");
      }
      return gPerm[index]!;
    };

    let sym = nextSym();
    while (sym !== eob) {
      if (sym === BZ_RUNA || sym === BZ_RUNB) {
        let es = -1;
        let n = 1;
        do {
          es += (sym === BZ_RUNA ? 1 : 2) * n;
          n <<= 1;
          if (n > 0x200000) {
            throw new Error("bzip2: run too long");
          }
          sym = nextSym();
        } while (sym === BZ_RUNA || sym === BZ_RUNB);
        es++;
        const uc = seqToUnseq[mtf[0]!]!;
        unzftab[uc] = unzftab[uc]! + es;
        if (nblock + es > blockSizeMax) {
          throw new Error("bzip2: block overflow");
        }
        tt.fill(uc, nblock, nblock + es);
        nblock += es;
        continue;
      }
      if (nblock >= blockSizeMax) {
        throw new Error("bzip2: block overflow");
      }
      const nn = sym - 1;
      const moved = mtf[nn]!;
      mtf.copyWithin(1, 0, nn);
      mtf[0] = moved;
      const uc = seqToUnseq[moved]!;
      unzftab[uc] = unzftab[uc]! + 1;
      tt[nblock++] = uc;
      sym = nextSym();
    }
    if (origPtr < 0 || origPtr >= nblock) {
      throw new Error("bzip2: bad origPtr");
    }

    // inverse BWT
    cftab[0] = 0;
    for (let i = 1; i <= 256; i++) {
      cftab[i] = cftab[i - 1]! + unzftab[i - 1]!;
    }
    for (let i = 0; i < nblock; i++) {
      const uc = tt[i]! & 0xff;
      const slot = cftab[uc]!;
      tt[slot] = (tt[slot]! | (i << 8)) >>> 0;
      cftab[uc] = slot + 1;
    }

    // walk the BWT and undo the first run-length stage
    let tPos = tt[origPtr]! >>> 8;
    let run = 0;
    let prev = -1;
    for (let i = 0; i < nblock; i++) {
      const entry = tt[tPos]!;
      const ch = entry & 0xff;
      tPos = entry >>> 8;
      if (run === 4) {
        if (outPos + ch > expected) {
          throw new Error("bzip2: output larger than expected");
        }
        out.fill(prev, outPos, outPos + ch);
        outPos += ch;
        run = 0;
        prev = -1;
        continue;
      }
      if (ch === prev) {
        run++;
      } else {
        run = 1;
        prev = ch;
      }
      if (outPos >= expected) {
        throw new Error("bzip2: output larger than expected");
      }
      out[outPos++] = ch;
    }
  }

  return outPos === expected ? out : out.subarray(0, outPos);
}
