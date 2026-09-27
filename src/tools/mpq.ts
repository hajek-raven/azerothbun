import { inflateSync } from "node:zlib";

/** MPQ archive reader for the 3.3.5a client data (format versions 1 and 2, as the client ships them). */

const MPQ_FILE_IMPLODE = 0x00000100;
const MPQ_FILE_COMPRESS = 0x00000200;
const MPQ_FILE_ENCRYPTED = 0x00010000;
const MPQ_FILE_FIX_KEY = 0x00020000;
const MPQ_FILE_SINGLE_UNIT = 0x01000000;
const MPQ_FILE_SECTOR_CRC = 0x04000000;
const MPQ_FILE_EXISTS = 0x80000000;

const MPQ_COMPRESSION_HUFFMANN = 0x01;
const MPQ_COMPRESSION_ZLIB = 0x02;
const MPQ_COMPRESSION_PKWARE = 0x08;
const MPQ_COMPRESSION_BZIP2 = 0x10;

const HASH_TABLE_INDEX = 0;
const HASH_NAME_A = 1;
const HASH_NAME_B = 2;
const HASH_FILE_KEY = 3;

const cryptTable = (() => {
  const table = new Uint32Array(0x500);
  let seed = 0x00100001;
  for (let index1 = 0; index1 < 0x100; index1++) {
    for (let index2 = index1, i = 0; i < 5; i++, index2 += 0x100) {
      seed = (seed * 125 + 3) % 0x2aaaab;
      const temp1 = (seed & 0xffff) << 0x10;
      seed = (seed * 125 + 3) % 0x2aaaab;
      const temp2 = seed & 0xffff;
      table[index2] = (temp1 | temp2) >>> 0;
    }
  }
  return table;
})();

export function hashString(name: string, type: number): number {
  let seed1 = 0x7fed7fed;
  let seed2 = 0xeeeeeeee;
  const upper = name.toUpperCase().replaceAll("/", "\\");
  for (let index = 0; index < upper.length; index++) {
    const ch = upper.charCodeAt(index) & 0xff;
    seed1 = (cryptTable[(type << 8) + ch]! ^ ((seed1 + seed2) >>> 0)) >>> 0;
    seed2 = (ch + seed1 + seed2 + (seed2 << 5) + 3) >>> 0;
  }
  return seed1 >>> 0;
}

function decryptBlock(words: Uint32Array, key: number): void {
  let seed1 = key >>> 0;
  let seed2 = 0xeeeeeeee;
  for (let index = 0; index < words.length; index++) {
    seed2 = (seed2 + cryptTable[0x400 + (seed1 & 0xff)]!) >>> 0;
    const ch = (words[index]! ^ ((seed1 + seed2) >>> 0)) >>> 0;
    seed1 = ((((~seed1 << 0x15) >>> 0) + 0x11111111) | (seed1 >>> 0x0b)) >>> 0;
    seed2 = (ch + seed2 + (seed2 << 5) + 3) >>> 0;
    words[index] = ch;
  }
}

function decryptBytes(bytes: Uint8Array, key: number): void {
  const count = Math.floor(bytes.length / 4);
  const words = new Uint32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index++) {
    words[index] = view.getUint32(index * 4, true);
  }
  decryptBlock(words, key);
  for (let index = 0; index < count; index++) {
    view.setUint32(index * 4, words[index]!, true);
  }
}

type HashEntry = { nameA: number; nameB: number; locale: number; platform: number; blockIndex: number };
type BlockEntry = { offset: number; packedSize: number; size: number; flags: number };

export class MpqArchive {
  private readonly hashes: HashEntry[] = [];
  private readonly blocks: BlockEntry[] = [];
  private readonly archiveOffset: number;
  private readonly sectorSize: number;

  constructor(
    readonly path: string,
    private readonly data: Uint8Array,
  ) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    while (offset + 32 <= data.length) {
      const magic = view.getUint32(offset, true);
      if (magic === 0x1a51504d) {
        break;
      }
      if (magic === 0x1b51504d) {
        offset += view.getUint32(offset + 8, true);
        continue;
      }
      offset += 0x200;
    }
    if (offset + 32 > data.length) {
      throw new Error(`${path}: no MPQ header`);
    }
    this.archiveOffset = offset;
    const formatVersion = view.getUint16(offset + 12, true);
    this.sectorSize = 512 << view.getUint16(offset + 14, true);
    let hashTablePos = view.getUint32(offset + 16, true);
    let blockTablePos = view.getUint32(offset + 20, true);
    const hashTableSize = view.getUint32(offset + 24, true);
    const blockTableSize = view.getUint32(offset + 28, true);
    let hiBlockTablePos = 0;
    if (formatVersion >= 1) {
      hiBlockTablePos = Number(view.getBigUint64(offset + 32, true));
      hashTablePos += view.getUint16(offset + 40, true) * 2 ** 32;
      blockTablePos += view.getUint16(offset + 42, true) * 2 ** 32;
    }

    const hashBytes = data.slice(offset + hashTablePos, offset + hashTablePos + hashTableSize * 16);
    decryptBytes(hashBytes, hashString("(hash table)", HASH_FILE_KEY));
    const hashView = new DataView(hashBytes.buffer);
    for (let index = 0; index < hashTableSize; index++) {
      this.hashes.push({
        nameA: hashView.getUint32(index * 16, true),
        nameB: hashView.getUint32(index * 16 + 4, true),
        locale: hashView.getUint16(index * 16 + 8, true),
        platform: hashView.getUint16(index * 16 + 10, true),
        blockIndex: hashView.getUint32(index * 16 + 12, true),
      });
    }

    const blockBytes = data.slice(offset + blockTablePos, offset + blockTablePos + blockTableSize * 16);
    decryptBytes(blockBytes, hashString("(block table)", HASH_FILE_KEY));
    const blockView = new DataView(blockBytes.buffer);
    const hiView = hiBlockTablePos ? new DataView(data.buffer, data.byteOffset + offset + hiBlockTablePos, blockTableSize * 2) : null;
    for (let index = 0; index < blockTableSize; index++) {
      const hi = hiView ? hiView.getUint16(index * 2, true) : 0;
      this.blocks.push({
        offset: blockView.getUint32(index * 16, true) + hi * 2 ** 32,
        packedSize: blockView.getUint32(index * 16 + 4, true),
        size: blockView.getUint32(index * 16 + 8, true),
        flags: blockView.getUint32(index * 16 + 12, true),
      });
    }
  }

  static async open(path: string): Promise<MpqArchive> {
    return new MpqArchive(path, await Bun.file(path).bytes());
  }

  private findBlock(name: string): BlockEntry | null {
    const size = this.hashes.length;
    if (size === 0) {
      return null;
    }
    const start = hashString(name, HASH_TABLE_INDEX) & (size - 1);
    const nameA = hashString(name, HASH_NAME_A);
    const nameB = hashString(name, HASH_NAME_B);
    let found: BlockEntry | null = null;
    for (let step = 0; step < size; step++) {
      const entry = this.hashes[(start + step) & (size - 1)]!;
      if (entry.blockIndex === 0xffffffff) {
        break;
      }
      if (entry.nameA === nameA && entry.nameB === nameB && entry.blockIndex !== 0xfffffffe) {
        const block = this.blocks[entry.blockIndex];
        if (block && block.flags & MPQ_FILE_EXISTS) {
          // prefer the neutral locale, then whatever locale the archive holds
          if (entry.locale === 0 || !found) {
            found = block;
          }
        }
      }
    }
    return found;
  }

  has(name: string): boolean {
    return this.findBlock(name) !== null;
  }

  read(name: string): Uint8Array | null {
    const block = this.findBlock(name);
    if (!block) {
      return null;
    }
    const start = this.archiveOffset + block.offset;
    const raw = this.data.subarray(start, start + block.packedSize);
    let key = 0;
    if (block.flags & MPQ_FILE_ENCRYPTED) {
      const base = name.slice(Math.max(name.lastIndexOf("\\"), name.lastIndexOf("/")) + 1);
      key = hashString(base, HASH_FILE_KEY);
      if (block.flags & MPQ_FILE_FIX_KEY) {
        key = ((key + block.offset) ^ block.size) >>> 0;
      }
    }
    if (block.flags & MPQ_FILE_SINGLE_UNIT) {
      const copy = raw.slice();
      if (key) {
        decryptBytes(copy, key);
      }
      if (block.flags & MPQ_FILE_COMPRESS && block.packedSize < block.size) {
        return decompress(copy, block.size, this.path, name);
      }
      return copy;
    }
    if (!(block.flags & (MPQ_FILE_COMPRESS | MPQ_FILE_IMPLODE))) {
      const copy = raw.slice(0, block.size);
      if (key) {
        decryptSectors(copy, key, this.sectorSize);
      }
      return copy;
    }
    const sectors = Math.ceil(block.size / this.sectorSize);
    const tableWords = sectors + 1 + (block.flags & MPQ_FILE_SECTOR_CRC ? 1 : 0);
    const table = raw.slice(0, tableWords * 4);
    if (key) {
      decryptBytes(table, (key - 1) >>> 0);
    }
    const tableView = new DataView(table.buffer);
    const out = new Uint8Array(block.size);
    for (let sector = 0; sector < sectors; sector++) {
      const from = tableView.getUint32(sector * 4, true);
      const to = tableView.getUint32((sector + 1) * 4, true);
      const expected = Math.min(this.sectorSize, block.size - sector * this.sectorSize);
      const chunk = raw.slice(from, to);
      if (key) {
        decryptBytes(chunk, (key + sector) >>> 0);
      }
      let plain: Uint8Array;
      if (chunk.length === expected) {
        plain = chunk;
      } else if (block.flags & MPQ_FILE_IMPLODE) {
        plain = explode(chunk, expected);
      } else {
        plain = decompress(chunk, expected, this.path, name);
      }
      out.set(plain.subarray(0, expected), sector * this.sectorSize);
    }
    return out;
  }

  /** Names from the archive's `(listfile)`. */
  listFiles(): string[] {
    const bytes = this.read("(listfile)");
    if (!bytes) {
      return [];
    }
    return new TextDecoder()
      .decode(bytes)
      .split(/[\r\n;]+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
}

function decryptSectors(bytes: Uint8Array, key: number, sectorSize: number): void {
  for (let offset = 0, sector = 0; offset < bytes.length; offset += sectorSize, sector++) {
    decryptBytes(bytes.subarray(offset, Math.min(bytes.length, offset + sectorSize)), (key + sector) >>> 0);
  }
}

function decompress(chunk: Uint8Array, expected: number, archive: string, name: string): Uint8Array {
  const mask = chunk[0]!;
  const body = chunk.subarray(1);
  if (mask === MPQ_COMPRESSION_ZLIB) {
    return new Uint8Array(inflateSync(body));
  }
  if (mask === MPQ_COMPRESSION_PKWARE) {
    return explode(body, expected);
  }
  const names = [
    mask & MPQ_COMPRESSION_HUFFMANN ? "huffman" : "",
    mask & MPQ_COMPRESSION_BZIP2 ? "bzip2" : "",
  ].filter(Boolean);
  throw new Error(`${archive}: ${name} uses compression 0x${mask.toString(16)} (${names.join(", ") || "unknown"}), which this extractor does not support`);
}

/** PKWARE Data Compression Library "explode" (binary and ASCII modes), as StormLib's `explode.c`. */
export function explode(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let outPos = 0;
  let inPos = 0;
  const ctype = input[inPos++]!;
  const dsizeBits = input[inPos++]!;
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
    throw new Error("PKWARE ASCII mode is not used by the 3.3.5a DBC files");
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
