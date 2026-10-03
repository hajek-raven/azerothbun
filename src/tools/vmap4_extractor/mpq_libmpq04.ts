import type { MpqChain } from "../mpq.ts";

/**
 * The archive glue of the extractor.
 *
 * @ac tools/vmap4_extractor/mpq_libmpq04.h MPQFile
 * @ac tools/vmap4_extractor/mpq_libmpq.cpp MPQFile::MPQFile
 * @ac tools/vmap4_extractor/mpq_libmpq.cpp MPQFile::read
 * @ac tools/vmap4_extractor/mpq_libmpq.cpp MPQFile::seek
 * @ac tools/vmap4_extractor/mpq_libmpq.cpp MPQFile::seekRelative
 * @ac tools/vmap4_extractor/mpq_libmpq.cpp MPQFile::close
 * @ac tools/vmap4_extractor/mpq_libmpq04.h flipcc
 * @ac-skip MPQArchive / ArchiveSet / MPQArchive::GetFileListTo: the archives, their load order and the name lookup
 *   are `MpqChain` (`src/tools/mpq.ts`), `gOpenArchives.chain` holds it
 */
export interface ArchiveReader {
  /** The whole file, or null when no archive serves the name (or the name is a delete marker). */
  read(name: string): Uint8Array | null;
}

/** `ArchiveSet gOpenArchives`. */
export const gOpenArchives: { chain: ArchiveReader | MpqChain | null } = { chain: null };

export class MPQFile {
  eof = false;
  buffer: Uint8Array | null = null;
  pointer = 0;
  size = 0;
  private view: DataView | null = null;

  /** Filenames are not case sensitive. The newest archive that holds the name wins (`MpqChain`). */
  constructor(filename: string) {
    const chain = gOpenArchives.chain;
    const bytes = chain ? chain.read(filename) : null;
    if (!bytes) {
      this.eof = true;
      return;
    }
    // HACK: in patch.mpq some files don't want to open and give 1 for filesize
    if (bytes.length <= 1) {
      this.eof = true;
      return;
    }
    this.size = bytes.length;
    this.buffer = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Copies up to `bytes` bytes to `dest`; a short read sets `eof`. Returns the bytes copied. */
  read(dest: Uint8Array | null, bytes: number): number {
    if (this.eof || !this.buffer) {
      return 0;
    }
    let rpos = this.pointer + bytes;
    if (rpos > this.size) {
      bytes = this.size - this.pointer;
      this.eof = true;
    }
    if (dest && bytes > 0) {
      dest.set(this.buffer.subarray(this.pointer, this.pointer + bytes));
    }
    this.pointer = rpos;
    return bytes;
  }

  /** `f.read(&value, 4)` for a uint32 (0 when nothing is left). */
  readU32(): number {
    if (this.eof || !this.view || this.pointer + 4 > this.size) {
      this.read(null, 4);
      return 0;
    }
    const value = this.view.getUint32(this.pointer, true);
    this.pointer += 4;
    return value;
  }

  readI32(): number {
    return this.readU32() | 0;
  }

  readU16(): number {
    if (this.eof || !this.view || this.pointer + 2 > this.size) {
      this.read(null, 2);
      return 0;
    }
    const value = this.view.getUint16(this.pointer, true);
    this.pointer += 2;
    return value;
  }

  readI16(): number {
    return (this.readU16() << 16) >> 16;
  }

  /** `f.read(dest, n)` into a fresh zero filled array (what `new T[n]` plus a possibly short `read` leaves). */
  readBytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    this.read(out, n);
    return out;
  }

  getSize(): number {
    return this.size;
  }

  getPos(): number {
    return this.pointer;
  }

  getBuffer(): Uint8Array | null {
    return this.buffer;
  }

  isEof(): boolean {
    return this.eof;
  }

  seek(offset: number): void {
    this.pointer = offset;
    this.eof = this.pointer >= this.size;
  }

  seekRelative(offset: number): void {
    this.pointer += offset;
    this.eof = this.pointer >= this.size;
  }

  close(): void {
    this.buffer = null;
    this.view = null;
    this.eof = true;
  }
}

/** The chunk id as the file stores it is reversed ("NIAM"); `flipcc` swaps it back ("MAIN"). Takes 4 bytes. */
export function flipcc(buffer: Uint8Array, at: number): string {
  return String.fromCharCode(buffer[at + 3]!, buffer[at + 2]!, buffer[at + 1]!, buffer[at]!);
}

/**
 * The `while (!f.isEof())` chunk loop of every extractor reader: `read(fourcc, 4); read(&size, 4); flipcc`. Returns
 * null when fewer than 8 bytes remain (C++ would parse stale locals there; no real file ends that way).
 */
export function readChunkHeader(f: MPQFile): { fourcc: string; size: number } | null {
  const buffer = f.buffer;
  if (f.eof || !buffer || f.pointer + 8 > f.size) {
    return null;
  }
  const fourcc = flipcc(buffer, f.pointer);
  f.pointer += 4;
  const size = f.readU32();
  return { fourcc, size };
}
