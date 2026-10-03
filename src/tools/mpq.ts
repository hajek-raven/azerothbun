/**
 * MPQ archive reader for the 3.3.5a client data, a port of what AzerothCore's extractors use from
 * `deps/libmpq/libmpq` (`mpq.c`, `common.c`, `extract.c`) and of `MPQArchive` / `MPQFile` in
 * `tools/map_extractor/mpq_libmpq.cpp` and `tools/vmap4_extractor/mpq_libmpq.cpp`.
 *
 * Archives are memory mapped (`Bun.mmap`), never read as a whole: opening one touches the header, the hash table
 * and the block table; reading a file touches only the pages of that file. File bodies are not cached.
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { bunzip2 } from "./mpq-bzip2.ts";
import { explode } from "./mpq-explode.ts";

export { explode };

/** `LIBMPQ_FLAG_*` (`mpq-internal.h`) and the StormLib flags that the 3.3.5a archives can carry. */
export const MPQ_FILE_IMPLODE = 0x00000100;
export const MPQ_FILE_COMPRESS = 0x00000200;
export const MPQ_FILE_COMPRESS_MASK = 0x0000ff00;
export const MPQ_FILE_ENCRYPTED = 0x00010000;
export const MPQ_FILE_FIX_KEY = 0x00020000;
export const MPQ_FILE_PATCH_FILE = 0x00100000;
export const MPQ_FILE_SINGLE_UNIT = 0x01000000;
export const MPQ_FILE_DELETE_MARKER = 0x02000000;
export const MPQ_FILE_SECTOR_CRC = 0x04000000;
export const MPQ_FILE_EXISTS = 0x80000000;

/** `LIBMPQ_COMPRESSION_*` (`extract.h`), the mask in the first byte of a compressed sector. */
export const MPQ_COMPRESSION_HUFFMAN = 0x01;
export const MPQ_COMPRESSION_ZLIB = 0x02;
export const MPQ_COMPRESSION_PKWARE = 0x08;
export const MPQ_COMPRESSION_BZIP2 = 0x10;
export const MPQ_COMPRESSION_SPARSE = 0x20;
export const MPQ_COMPRESSION_ADPCM_MONO = 0x40;
export const MPQ_COMPRESSION_ADPCM_STEREO = 0x80;

const MPQ_HEADER_MAGIC = 0x1a51504d;
const MPQ_USER_DATA_MAGIC = 0x1b51504d;
const HASH_FREE = 0xffffffff;
const HASH_DELETED = 0xfffffffe;

const HASH_TABLE_INDEX = 0;
const HASH_NAME_A = 1;
const HASH_NAME_B = 2;
const HASH_FILE_KEY = 3;

/** `crypt_buf` (`crypt_buf.h`), generated the way `crypt_buf_gen.c` does. */
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

/** Upper-case ASCII, `/` as `\`, the way the MPQ name hash sees a path. */
function hashChar(code: number): number {
  const ch = code & 0xff;
  if (ch >= 0x61 && ch <= 0x7a) {
    return ch - 0x20;
  }
  return ch === 0x2f ? 0x5c : ch;
}

/**
 * `libmpq__hash_string` (names are upper-cased ASCII with `/` read as `\`, which StormLib does and the extractors rely on).
 *
 * @ac deps/libmpq/libmpq/common.c libmpq__hash_string
 */
export function hashString(name: string, type: number): number {
  let seed1 = 0x7fed7fed;
  let seed2 = 0xeeeeeeee;
  const base = type << 8;
  for (let index = 0; index < name.length; index++) {
    const ch = hashChar(name.charCodeAt(index));
    seed1 = (cryptTable[base + ch]! ^ (seed1 + seed2)) >>> 0;
    seed2 = (ch + seed1 + seed2 + (seed2 << 5) + 3) >>> 0;
  }
  return seed1 >>> 0;
}

/** The three lookup hashes of a name: table index, name A and name B. Filled by `computeNameHashes`. */
export type NameHashes = { index: number; nameA: number; nameB: number };

/**
 * The three `libmpq__hash_string` calls of `libmpq__file_number` (types 0x000, 0x100, 0x200) in one pass over the name.
 *
 * @ac deps/libmpq/libmpq/mpq.c libmpq__file_number
 */
export function computeNameHashes(name: string, into: NameHashes): NameHashes {
  let s1a = 0x7fed7fed;
  let s2a = 0xeeeeeeee;
  let s1b = 0x7fed7fed;
  let s2b = 0xeeeeeeee;
  let s1c = 0x7fed7fed;
  let s2c = 0xeeeeeeee;
  for (let index = 0; index < name.length; index++) {
    const ch = hashChar(name.charCodeAt(index));
    s1a = (cryptTable[ch]! ^ (s1a + s2a)) >>> 0;
    s2a = (ch + s1a + s2a + (s2a << 5) + 3) >>> 0;
    s1b = (cryptTable[0x100 + ch]! ^ (s1b + s2b)) >>> 0;
    s2b = (ch + s1b + s2b + (s2b << 5) + 3) >>> 0;
    s1c = (cryptTable[0x200 + ch]! ^ (s1c + s2c)) >>> 0;
    s2c = (ch + s1c + s2c + (s2c << 5) + 3) >>> 0;
  }
  into.index = s1a;
  into.nameA = s1b;
  into.nameB = s1c;
  return into;
}

/**
 * `words` are little endian 32 bit values, the length is `in_size / 4`.
 *
 * @ac deps/libmpq/libmpq/common.c libmpq__decrypt_block
 */
export function decryptBlock(words: Uint32Array, key: number): void {
  let seed1 = key >>> 0;
  let seed2 = 0xeeeeeeee;
  for (let index = 0; index < words.length; index++) {
    seed2 = (seed2 + cryptTable[0x400 + (seed1 & 0xff)]!) >>> 0;
    const ch = (words[index]! ^ (seed1 + seed2)) >>> 0;
    seed1 = (((~seed1 << 0x15) + 0x11111111) | (seed1 >>> 0x0b)) >>> 0;
    seed2 = (ch + seed2 + (seed2 << 5) + 3) >>> 0;
    words[index] = ch;
  }
}

/**
 * The reader never needs it, the test fixtures do.
 *
 * @ac deps/libmpq/libmpq/common.c libmpq__encrypt_block
 */
export function encryptBlock(words: Uint32Array, key: number): void {
  let seed1 = key >>> 0;
  let seed2 = 0xeeeeeeee;
  for (let index = 0; index < words.length; index++) {
    seed2 = (seed2 + cryptTable[0x400 + (seed1 & 0xff)]!) >>> 0;
    const plain = words[index]!;
    words[index] = (plain ^ (seed1 + seed2)) >>> 0;
    seed1 = (((~seed1 << 0x15) + 0x11111111) | (seed1 >>> 0x0b)) >>> 0;
    seed2 = (plain + seed2 + (seed2 << 5) + 3) >>> 0;
  }
}

/** Decrypts whole 32 bit words of `bytes` in place (a trailing partial word stays as is, as in libmpq). */
export function decryptBytes(bytes: Uint8Array, key: number): void {
  const count = bytes.length >>> 2;
  if (count === 0) {
    return;
  }
  if (bytes.byteOffset % 4 === 0) {
    decryptBlock(new Uint32Array(bytes.buffer, bytes.byteOffset, count), key);
    return;
  }
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

/**
 * Recovers the file seed from the first two words of an encrypted sector offset table when the
 * file name is not known. `words` is the still encrypted table, `tableBytes` its length in bytes.
 *
 * @ac deps/libmpq/libmpq/common.c libmpq__decrypt_key
 */
export function detectFileKey(words: Uint32Array, tableBytes: number, sectorSize: number): number | null {
  const temp = ((words[0]! ^ tableBytes) - 0xeeeeeeee) >>> 0;
  for (let i = 0; i < 0x100; i++) {
    let seed1 = (temp - cryptTable[0x400 + i]!) >>> 0;
    let seed2 = 0xeeeeeeee;
    seed2 = (seed2 + cryptTable[0x400 + (seed1 & 0xff)]!) >>> 0;
    const ch = (words[0]! ^ (seed1 + seed2)) >>> 0;
    if (ch !== tableBytes) {
      continue;
    }
    const saved = (seed1 + 1) >>> 0;
    seed1 = (((~seed1 << 0x15) + 0x11111111) | (seed1 >>> 0x0b)) >>> 0;
    seed2 = (ch + seed2 + (seed2 << 5) + 3) >>> 0;
    seed2 = (seed2 + cryptTable[0x400 + (seed1 & 0xff)]!) >>> 0;
    const second = (words[1]! ^ (seed1 + seed2)) >>> 0;
    if (((second - ch) >>> 0) <= sectorSize) {
      return saved;
    }
  }
  return null;
}

/** File name part after the last separator, which the file key is derived from. */
function baseName(name: string): string {
  return name.slice(Math.max(name.lastIndexOf("\\"), name.lastIndexOf("/")) + 1);
}

function maskNames(mask: number): string {
  const names: string[] = [];
  if (mask & MPQ_COMPRESSION_HUFFMAN) names.push("huffman");
  if (mask & MPQ_COMPRESSION_ZLIB) names.push("zlib");
  if (mask & MPQ_COMPRESSION_PKWARE) names.push("pkware");
  if (mask & MPQ_COMPRESSION_BZIP2) names.push("bzip2");
  if (mask & MPQ_COMPRESSION_SPARSE) names.push("sparse");
  if (mask & MPQ_COMPRESSION_ADPCM_MONO) names.push("adpcm-mono");
  if (mask & MPQ_COMPRESSION_ADPCM_STEREO) names.push("adpcm-stereo");
  return names.join("+") || "none";
}

/**
 * zlib stream as stored in MPQ sectors: `Bun.inflateSync` inflates raw deflate, so the 2 byte zlib header is skipped.
 *
 * @ac deps/libmpq/libmpq/extract.c libmpq__decompress_zlib
 */
function inflateZlib(body: Uint8Array, expected: number): Uint8Array {
  if (body.length < 2 || (body[1]! & 0x20) !== 0) {
    throw new Error("zlib: bad stream header");
  }
  const out = Bun.inflateSync(body.subarray(2) as Uint8Array<ArrayBuffer>);
  if (out.length < expected) {
    throw new Error(`zlib: stream ended after ${out.length} of ${expected} bytes`);
  }
  return out;
}

/**
 * The first byte of a compressed sector is the mask of the algorithms applied, which are
 * undone in StormLib's table order (bzip2, pkware, zlib, huffman, adpcm stereo, adpcm mono) with the output of one
 * stage feeding the next. Also covers `libmpq__decompress_block` (the stored/compressed decision is made by the caller:
 * a sector whose packed size equals its unpacked size is not compressed).
 *
 * @ac deps/libmpq/libmpq/extract.c libmpq__decompress_multi
 * @ac deps/libmpq/libmpq/extract.c libmpq__decompress_bzip2
 * @ac deps/libmpq/libmpq/common.c libmpq__decompress_block
 * @ac-skip libmpq__decompress_huffman, libmpq__decompress_wave_mono, libmpq__decompress_wave_stereo (huffman, ADPCM and
 * sparse masks occur in none of the 16 archives of the 3.3.5a load order, checked over every sector; they throw an
 * error that names the mask instead)
 */
export function decompressSector(sector: Uint8Array, expected: number): Uint8Array {
  const mask = sector[0]!;
  let data = sector.subarray(1);
  let handled = 0;
  if (mask & MPQ_COMPRESSION_BZIP2) {
    data = bunzip2(data, expected);
    handled |= MPQ_COMPRESSION_BZIP2;
  }
  if (mask & MPQ_COMPRESSION_PKWARE) {
    data = explode(data, expected);
    handled |= MPQ_COMPRESSION_PKWARE;
  }
  if (mask & MPQ_COMPRESSION_ZLIB) {
    data = inflateZlib(data, expected);
    handled |= MPQ_COMPRESSION_ZLIB;
  }
  if (mask & ~handled) {
    throw new Error(`compression 0x${mask.toString(16)} (${maskNames(mask & ~handled)}) is not supported`);
  }
  return data;
}

/** Random access to the bytes of one archive file. */
export interface MpqSource {
  readonly length: number;
  /** `length` bytes at `position` (fewer at the end of the file); may be a view of the mapping or a fresh copy. */
  bytes(position: number, length: number): Uint8Array;
  close(): void;
}

export class MpqMappedSource implements MpqSource {
  constructor(private data: Uint8Array) {}

  get length(): number {
    return this.data.length;
  }

  bytes(position: number, length: number): Uint8Array {
    return this.data.subarray(position, position + length);
  }

  close(): void {
    this.data = new Uint8Array(0);
  }
}

/**
 * Positional reads through a file descriptor, for when `Bun.mmap` cannot map the file (it opens read-write, so it fails on
 * a read-only client directory). `node:fs` is used because Bun has no synchronous positional read.
 */
export class MpqDescriptorSource implements MpqSource {
  readonly length: number;
  private fd: number;

  constructor(path: string) {
    this.fd = openSync(path, "r");
    this.length = fstatSync(this.fd).size;
  }

  bytes(position: number, length: number): Uint8Array {
    const size = Math.max(0, Math.min(length, this.length - position));
    const out = new Uint8Array(size);
    let done = 0;
    while (done < size) {
      const count = readSync(this.fd, out, done, size - done, position + done);
      if (count <= 0) {
        throw new Error("unexpected end of archive file");
      }
      done += count;
    }
    return out;
  }

  close(): void {
    if (this.fd >= 0) {
      closeSync(this.fd);
      this.fd = -1;
    }
  }
}

export type MpqBlockInfo = { offset: number; packedSize: number; size: number; flags: number };

/**
 * A single MPQ archive (header version 1 and 2, the way the 3.3.5a client ships them).
 *
 * The constructor is `libmpq__archive_open`: it finds the header, reads and decrypts the hash table and the block table
 * (and the extended block table of version 2) into typed arrays. `libmpq`'s file number indirection (`mpq_map`, which
 * skips blocks without `LIBMPQ_FLAG_EXISTS`) is not needed because lookups return block table indices directly.
 *
 * @ac deps/libmpq/libmpq/mpq.c libmpq__archive_open
 * @ac deps/libmpq/libmpq/mpq.c libmpq__archive_close
 * @ac deps/libmpq/libmpq/mpq.c libmpq__file_unpacked_size
 * @ac tools/map_extractor/mpq_libmpq.cpp MPQArchive::MPQArchive
 * @ac-skip libmpq__archive_packed_size, libmpq__archive_unpacked_size, libmpq__archive_offset, libmpq__archive_version,
 * libmpq__archive_files, libmpq__file_packed_size, libmpq__file_offset, libmpq__file_blocks, libmpq__file_encrypted,
 * libmpq__file_compressed, libmpq__file_imploded, libmpq__block_unpacked_size, libmpq__block_seed (accessors over the
 * block table; `block()` returns the same values and `readBlock` derives block sizes and seeds inline)
 */
export class MpqArchive {
  readonly archiveOffset: number;
  readonly formatVersion: number;
  readonly sectorSize: number;
  readonly hashTableSize: number;
  readonly blockTableSize: number;
  /** Hash table, four words per entry: name A, name B, locale | platform << 16, block index. */
  private hashes: Uint32Array;
  /** Block table, four words per entry: offset, packed size, size, flags. */
  private blocks: Uint32Array;
  /** High 16 bits of the block offsets (extended block table), or null when the archive has none. */
  private offsetHigh: Uint16Array | null = null;
  private source: MpqSource;
  private listing: string[] | null = null;

  /** `data` is the whole archive file (a mapping or, in tests, a buffer) or a positional reader over it. */
  constructor(
    readonly path: string,
    data: Uint8Array | MpqSource,
  ) {
    this.source = data instanceof Uint8Array ? new MpqMappedSource(data) : data;
    let head: DataView = new DataView(new ArrayBuffer(48));
    let offset = 0;
    for (;;) {
      const bytes = this.source.bytes(offset, 48);
      if (bytes.length < 32) {
        throw new Error(`${path}: no MPQ header`);
      }
      head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const magic = head.getUint32(0, true);
      if (magic === MPQ_HEADER_MAGIC) {
        break;
      }
      if (magic === MPQ_USER_DATA_MAGIC) {
        // user data header: the real header follows at the offset stored in it
        offset += head.getUint32(8, true);
        continue;
      }
      offset += 0x200;
    }
    const view = head;
    this.archiveOffset = offset;
    this.formatVersion = view.getUint16(12, true);
    if (this.formatVersion > 1) {
      throw new Error(`${path}: MPQ format version ${this.formatVersion + 1} is not supported`);
    }
    this.sectorSize = 512 << view.getUint16(14, true);
    let hashTablePos = view.getUint32(16, true);
    let blockTablePos = view.getUint32(20, true);
    this.hashTableSize = view.getUint32(24, true);
    this.blockTableSize = view.getUint32(28, true);
    let hiBlockTablePos = 0;
    if (this.formatVersion >= 1 && view.getUint32(8, true) >= 44 && view.byteLength >= 44) {
      // mpq_header_ex_s: extended block table offset and the high 16 bits of both table offsets
      hiBlockTablePos = Number(view.getBigUint64(32, true));
      hashTablePos += view.getUint16(40, true) * 2 ** 32;
      blockTablePos += view.getUint16(42, true) * 2 ** 32;
    }
    if ((this.hashTableSize & (this.hashTableSize - 1)) !== 0) {
      throw new Error(`${path}: hash table size ${this.hashTableSize} is not a power of two`);
    }

    this.hashes = this.readTable(offset + hashTablePos, this.hashTableSize, "(hash table)");
    this.blocks = this.readTable(offset + blockTablePos, this.blockTableSize, "(block table)");
    if (hiBlockTablePos > 0) {
      const bytes = this.source.bytes(offset + hiBlockTablePos, this.blockTableSize * 2);
      if (bytes.length === this.blockTableSize * 2) {
        const high = new Uint16Array(this.blockTableSize);
        const hiView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let index = 0; index < high.length; index++) {
          high[index] = hiView.getUint16(index * 2, true);
        }
        this.offsetHigh = high;
      }
    }
  }

  /** Reads and decrypts a table of 16 byte entries into an aligned word array. */
  private readTable(position: number, count: number, keyName: string): Uint32Array {
    const length = count * 16;
    if (position + length > this.source.length) {
      throw new Error(`${this.path}: ${keyName} lies outside the file`);
    }
    const words = new Uint32Array(count * 4);
    new Uint8Array(words.buffer).set(this.source.bytes(position, length));
    decryptBlock(words, hashString(keyName, HASH_FILE_KEY));
    return words;
  }

  /**
   * Opens an archive through `Bun.mmap` (positional reads when the file cannot be mapped); only the header and the two
   * tables are read.
   */
  static async open(path: string): Promise<MpqArchive> {
    return MpqArchive.openSync(path);
  }

  static openSync(path: string): MpqArchive {
    let mapped: Uint8Array;
    try {
      mapped = Bun.mmap(path);
    } catch (error) {
      if ((error as { code?: string }).code === "EACCES" || (error as { code?: string }).code === "EPERM") {
        return new MpqArchive(path, new MpqDescriptorSource(path));
      }
      throw error;
    }
    return new MpqArchive(path, mapped);
  }

  /** Releases the mapping or descriptor; the archive cannot be read afterwards. */
  close(): void {
    this.source.close();
    this.hashes = new Uint32Array(0);
    this.blocks = new Uint32Array(0);
    this.listing = null;
  }

  /** Block table entry `index` (offset is relative to the archive start and includes the extended high bits). */
  block(index: number): MpqBlockInfo {
    const word = index * 4;
    const high = this.offsetHigh ? this.offsetHigh[index]! : 0;
    return {
      offset: this.blocks[word]! + high * 2 ** 32,
      packedSize: this.blocks[word + 1]!,
      size: this.blocks[word + 2]!,
      flags: this.blocks[word + 3]!,
    };
  }

  blockFlags(index: number): number {
    return this.blocks[index * 4 + 3]!;
  }

  blockSize(index: number): number {
    return this.blocks[index * 4 + 2]!;
  }

  /** Hash table entry `index`: name hashes, locale, platform and block index (`0xffffffff` free, `0xfffffffe` deleted). */
  hashEntry(index: number): { nameA: number; nameB: number; locale: number; platform: number; blockIndex: number } {
    const word = index * 4;
    return {
      nameA: this.hashes[word]!,
      nameB: this.hashes[word + 1]!,
      locale: this.hashes[word + 2]! & 0xffff,
      platform: this.hashes[word + 2]! >>> 16,
      blockIndex: this.hashes[word + 3]!,
    };
  }

  /**
   * `libmpq__file_number` with the checks StormLib adds: walks the probe sequence from the name's table index to the first
   * free entry, skips deleted entries and entries that point outside the block table, and prefers the neutral locale.
   * Returns the block table index, or -1 when no entry matches. A returned block can still be a deleted file
   * (`isDeletedBlock`).
   *
   * @ac deps/libmpq/libmpq/mpq.c libmpq__file_number
   */
  findBlockIndex(hash: NameHashes): number {
    const size = this.hashTableSize;
    if (size === 0) {
      return -1;
    }
    const mask = size - 1;
    const hashes = this.hashes;
    let found = -1;
    let index = hash.index & mask;
    for (let step = 0; step < size; step++, index = (index + 1) & mask) {
      const word = index * 4;
      const blockIndex = hashes[word + 3]!;
      if (blockIndex === HASH_FREE) {
        break;
      }
      if (hashes[word] === hash.nameA && hashes[word + 1] === hash.nameB && blockIndex < this.blockTableSize) {
        if ((hashes[word + 2]! & 0xffff) === 0) {
          return blockIndex;
        }
        if (found < 0) {
          found = blockIndex;
        }
      }
    }
    return found;
  }

  /** Block table entries that do not carry `MPQ_FILE_EXISTS` or are patch-style delete markers hide the file. */
  isDeletedBlock(blockIndex: number): boolean {
    const flags = this.blocks[blockIndex * 4 + 3]!;
    return (flags & MPQ_FILE_EXISTS) === 0 || (flags & MPQ_FILE_DELETE_MARKER) !== 0;
  }

  private findLive(name: string): number {
    const blockIndex = this.findBlockIndex(computeNameHashes(name, scratchHashes));
    return blockIndex >= 0 && !this.isDeletedBlock(blockIndex) ? blockIndex : -1;
  }

  has(name: string): boolean {
    return this.findLive(name) >= 0;
  }

  /** Unpacked size of the file, or null when the archive does not have it. */
  size(name: string): number | null {
    const blockIndex = this.findLive(name);
    return blockIndex < 0 ? null : this.blockSize(blockIndex);
  }

  read(name: string): Uint8Array | null {
    const blockIndex = this.findLive(name);
    return blockIndex < 0 ? null : this.readBlock(blockIndex, name);
  }

  /**
   * `libmpq__file_read` for one block table entry: sector offset table, decryption, per sector decompression. `name`
   * gives the encryption key (`hash(basename)`); without it the key is recovered from the offset table.
   *
   * @ac deps/libmpq/libmpq/mpq.c libmpq__file_read
   * @ac deps/libmpq/libmpq/mpq.c libmpq__block_open_offset
   * @ac deps/libmpq/libmpq/mpq.c libmpq__block_read
   * @ac-skip PATCH_FILE blocks (PTCH/BSD0): libmpq cannot read them either, and none of the 16 archives of the load order
   * has one, so `readBlock` throws a named error for them
   */
  readBlock(blockIndex: number, name: string | null): Uint8Array {
    const info = this.block(blockIndex);
    const { flags, size, packedSize } = info;
    const start = this.archiveOffset + info.offset;
    const label = name ?? `block ${blockIndex}`;
    if (start + packedSize > this.source.length) {
      throw new Error(`${this.path}: ${label} lies outside the archive`);
    }
    if (flags & MPQ_FILE_PATCH_FILE) {
      throw new Error(`${this.path}: ${label} is a patch file, which this reader does not apply`);
    }
    if (size === 0) {
      return new Uint8Array(0);
    }
    const raw = this.source.bytes(start, packedSize);
    let key = 0;
    let encrypted = (flags & MPQ_FILE_ENCRYPTED) !== 0;
    if (encrypted && name !== null) {
      key = hashString(baseName(name), HASH_FILE_KEY);
      if (flags & MPQ_FILE_FIX_KEY) {
        key = ((key + (info.offset >>> 0)) ^ size) >>> 0;
      }
    }

    if (flags & MPQ_FILE_SINGLE_UNIT) {
      let body = raw;
      if (encrypted) {
        body = raw.slice();
        decryptBytes(body, key);
      }
      if (flags & MPQ_FILE_COMPRESS_MASK && packedSize < size) {
        return this.unpack(flags, body, size, label);
      }
      return encrypted ? body.subarray(0, size) : raw.slice(0, size);
    }

    const sectorSize = this.sectorSize;
    const sectorCount = Math.ceil(size / sectorSize);
    if (!(flags & MPQ_FILE_COMPRESS_MASK)) {
      const out = raw.slice(0, Math.min(packedSize, size));
      if (encrypted) {
        for (let at = 0, sector = 0; at < out.length; at += sectorSize, sector++) {
          decryptBytes(out.subarray(at, Math.min(out.length, at + sectorSize)), (key + sector) >>> 0);
        }
      }
      return out;
    }

    // compressed: the sector offset table leads the data, one extra word when the sector CRC flag is set
    const tableWords = sectorCount + 1 + (flags & MPQ_FILE_SECTOR_CRC ? 1 : 0);
    if (tableWords * 4 > packedSize) {
      throw new Error(`${this.path}: ${label} has a truncated sector table`);
    }
    const table = new Uint32Array(tableWords);
    new Uint8Array(table.buffer).set(raw.subarray(0, tableWords * 4));
    if (!encrypted && table[0] !== tableWords * 4 && table[0] !== (sectorCount + 1) * 4) {
      // libmpq: the file looks unencrypted but its table does not start where it should, so it is encrypted
      encrypted = true;
      key = 0;
    }
    if (encrypted) {
      if (key === 0) {
        const detected = detectFileKey(table, tableWords * 4, sectorSize);
        if (detected === null) {
          throw new Error(`${this.path}: ${label} is encrypted and its key cannot be found`);
        }
        key = detected;
      }
      const encryptedTable = table.slice();
      decryptBlock(table, (key - 1) >>> 0);
      if (table[0] !== tableWords * 4 && table[0] !== (sectorCount + 1) * 4) {
        // the name key was wrong (renamed file); fall back to recovering it like libmpq does
        const detected = detectFileKey(encryptedTable, tableWords * 4, sectorSize);
        if (detected === null) {
          throw new Error(`${this.path}: ${label} sector table does not decrypt`);
        }
        key = detected;
        table.set(encryptedTable);
        decryptBlock(table, (key - 1) >>> 0);
      }
    }

    const out = new Uint8Array(size);
    for (let sector = 0; sector < sectorCount; sector++) {
      const from = table[sector]!;
      const to = table[sector + 1]!;
      if (to < from || to > packedSize) {
        throw new Error(`${this.path}: ${label} sector ${sector} has a bad offset`);
      }
      const expected = Math.min(sectorSize, size - sector * sectorSize);
      let chunk = raw.subarray(from, to);
      if (encrypted) {
        chunk = chunk.slice();
        decryptBytes(chunk, (key + sector) >>> 0);
      }
      const plain = chunk.length === expected ? chunk : this.unpack(flags, chunk, expected, label);
      out.set(plain.length > expected ? plain.subarray(0, expected) : plain, sector * sectorSize);
    }
    return out;
  }

  private unpack(flags: number, chunk: Uint8Array, expected: number, label: string): Uint8Array {
    try {
      return flags & MPQ_FILE_IMPLODE ? explode(chunk, expected) : decompressSector(chunk, expected);
    } catch (error) {
      throw new Error(`${this.path}: ${label}: ${(error as Error).message}`);
    }
  }

  /** Names from the archive's `(listfile)`. */
  listFiles(): string[] {
    if (this.listing) {
      return this.listing;
    }
    const bytes = this.read("(listfile)");
    this.listing = bytes
      ? new TextDecoder()
          .decode(bytes)
          .split(/[\r\n;]+/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];
    return this.listing;
  }
}

const scratchHashes: NameHashes = { index: 0, nameA: 0, nameB: 0 };

/**
 * The client's archive order for one locale (lowest priority first). This is the client's own order (locale patches win
 * over common patches), not `map_extractor`'s, which pushes every archive to the front of `gOpenArchives` after loading
 * the locale files first and so lets `patch.MPQ` .. `patch-5.MPQ` win over `patch-<locale>-N.MPQ`.
 *
 * @ac tools/map_extractor/System.cpp LoadCommonMPQFiles
 * @ac tools/map_extractor/System.cpp LoadLocaleMPQFiles
 */
export function archiveOrder(dataDir: string, locale: string): string[] {
  const base = ["common.MPQ", "common-2.MPQ", "expansion.MPQ", "lichking.MPQ"];
  const localeFiles = [
    `${locale}/locale-${locale}.MPQ`,
    `${locale}/speech-${locale}.MPQ`,
    `${locale}/expansion-locale-${locale}.MPQ`,
    `${locale}/expansion-speech-${locale}.MPQ`,
    `${locale}/lichking-locale-${locale}.MPQ`,
    `${locale}/lichking-speech-${locale}.MPQ`,
  ];
  const patches = patchFiles(dataDir, "");
  const localePatches = patchFiles(join(dataDir, locale), `${locale}/`, locale);
  return [...base, ...localeFiles, ...patches, ...localePatches].map((file) => join(dataDir, file)).filter((path) => existsSync(path));
}

/** `patch.MPQ`, `patch-2.MPQ`, ... `patch-9.MPQ`, `patch-A.MPQ` ... in the order the client loads them. */
function patchFiles(directory: string, prefix: string, locale?: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const stem = locale ? `patch-${locale}` : "patch";
  const pattern = new RegExp(`^${stem}(?:-([0-9A-Za-z]))?\\.mpq$`, "i");
  return readdirSync(directory)
    .map((file) => ({ file, match: pattern.exec(file) }))
    .filter((row) => row.match !== null)
    .sort((left, right) => patchRank(left.match![1]) - patchRank(right.match![1]))
    .map((row) => `${prefix}${row.file}`);
}

function patchRank(suffix: string | undefined): number {
  if (!suffix) {
    return 1;
  }
  const digit = Number.parseInt(suffix, 10);
  return Number.isNaN(digit) ? 100 + suffix.toUpperCase().charCodeAt(0) : digit;
}

export function detectLocale(dataDir: string): string | null {
  for (const locale of ["enUS", "enGB", "deDE", "frFR", "esES", "esMX", "ruRU", "koKR", "zhCN", "zhTW"]) {
    if (existsSync(join(dataDir, locale, `locale-${locale}.MPQ`))) {
      return locale;
    }
  }
  return null;
}

/** Lower case, `\\` separators: the key under which names are compared (the MPQ name hash is case and separator blind). */
export function normalizeMpqName(name: string): string {
  return name.replaceAll("/", "\\").toLowerCase();
}

/**
 * The client's archives in load order with "later archive overrides earlier", the lookup `MPQFile` does over
 * `gOpenArchives` in `map_extractor` / `vmap4_extractor` (`LoadCommonMPQFiles`, `LoadLocaleMPQFiles`). A file that the
 * highest priority archive holding its name marks as deleted (patch delete markers, size 1 in libmpq's view) is absent
 * from the chain, whatever lower archives say.
 *
 * @ac tools/map_extractor/mpq_libmpq.cpp MPQFile::MPQFile
 * @ac tools/map_extractor/System.cpp LoadCommonMPQFiles
 * @ac tools/map_extractor/System.cpp LoadLocaleMPQFiles
 */
export class MpqChain {
  /** Lowest priority first, in the order of `archiveOrder`. */
  readonly archives: MpqArchive[];
  private listing: Map<string, string> | null = null;

  private constructor(
    archives: MpqArchive[],
    readonly dataDir: string,
    readonly locale: string,
  ) {
    this.archives = archives;
  }

  /** `dataDir` is the client's `Data` directory (or the client directory that contains it). */
  static async open(dataDir: string, locale?: string): Promise<MpqChain> {
    const dir = existsSync(join(dataDir, "Data")) ? join(dataDir, "Data") : dataDir;
    const chosen = locale ?? detectLocale(dir);
    if (!chosen) {
      throw new Error(`no locale-<locale>.MPQ under ${dir}`);
    }
    const paths = archiveOrder(dir, chosen);
    if (paths.length === 0) {
      throw new Error(`no MPQ archives under ${dir}`);
    }
    const archives: MpqArchive[] = [];
    for (const path of paths) {
      archives.push(await MpqArchive.open(path));
    }
    return new MpqChain(archives, dir, chosen);
  }

  /** A chain over already opened archives (lowest priority first), for tests and tools. */
  static fromArchives(archives: MpqArchive[]): MpqChain {
    return new MpqChain(archives, "", "");
  }

  close(): void {
    for (const archive of this.archives) {
      archive.close();
    }
    this.listing = null;
  }

  /** Index of the archive that serves `name` and its block, or null when absent or deleted. */
  private resolve(name: string): { archive: MpqArchive; blockIndex: number } | null {
    computeNameHashes(name, chainHashes);
    for (let index = this.archives.length - 1; index >= 0; index--) {
      const archive = this.archives[index]!;
      const blockIndex = archive.findBlockIndex(chainHashes);
      if (blockIndex < 0) {
        continue;
      }
      return archive.isDeletedBlock(blockIndex) ? null : { archive, blockIndex };
    }
    return null;
  }

  has(name: string): boolean {
    return this.resolve(name) !== null;
  }

  /** Unpacked size from the block table, without reading the file. */
  size(name: string): number | null {
    const hit = this.resolve(name);
    return hit ? hit.archive.blockSize(hit.blockIndex) : null;
  }

  /** The archive that serves `name` (for diagnostics and tests). */
  archiveOf(name: string): MpqArchive | null {
    return this.resolve(name)?.archive ?? null;
  }

  /** The whole file, decompressed into a fresh buffer; nothing is cached. */
  read(name: string): Uint8Array | null {
    const hit = this.resolve(name);
    return hit ? hit.archive.readBlock(hit.blockIndex, name) : null;
  }

  /**
   * Names that the archives' `(listfile)` entries list and the chain serves, sorted case-insensitively. A string is a
   * path prefix; a RegExp is tested against the name with `\\` separators and always matches case-insensitively.
   */
  list(pattern?: RegExp | string): string[] {
    if (!this.listing) {
      const names = new Map<string, string>();
      for (const archive of this.archives) {
        for (const name of archive.listFiles()) {
          names.set(normalizeMpqName(name), name);
        }
      }
      for (const [key, name] of names) {
        if (!this.has(name)) {
          names.delete(key);
        }
      }
      this.listing = names;
    }
    let test: (key: string, name: string) => boolean = () => true;
    if (typeof pattern === "string") {
      const prefix = normalizeMpqName(pattern);
      test = (key) => key.startsWith(prefix);
    } else if (pattern) {
      const flags = pattern.flags.replaceAll(/[gy]/g, "");
      const regexp = new RegExp(pattern.source, flags.includes("i") ? flags : `${flags}i`);
      test = (_key, name) => regexp.test(name.replaceAll("/", "\\"));
    }
    const result: string[] = [];
    for (const [key, name] of this.listing) {
      if (test(key, name)) {
        result.push(name);
      }
    }
    return result.sort((left, right) => {
      const a = normalizeMpqName(left);
      const b = normalizeMpqName(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }
}

const chainHashes: NameHashes = { index: 0, nameA: 0, nameB: 0 };
