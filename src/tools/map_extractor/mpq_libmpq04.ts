/**
 * `mpq_libmpq04.h` / `mpq_libmpq.cpp`: the archive set the extractor reads from and `MPQFile`, one file out of it.
 *
 * C++ pushes every `MPQArchive` it opens to the front of `gOpenArchives` and `MPQFile` takes the first archive that
 * has the name. `MpqChain` (`src/tools/mpq.ts`) is that lookup over all archives of one client, so the set here holds
 * the chain instead of a list of archives. `LoadLocaleMPQFiles` and `LoadCommonMPQFiles` (`System.cpp`) are
 * `openArchives`, `CloseMPQFiles` is `closeArchives`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MpqChain } from "../mpq.ts";

/** @ac tools/map_extractor/mpq_libmpq.cpp gOpenArchives */
export const gOpenArchives: { chain: MpqChain | null } = { chain: null };

/**
 * @ac tools/map_extractor/System.cpp LoadLocaleMPQFiles
 * @ac tools/map_extractor/System.cpp LoadCommonMPQFiles
 * @ac tools/map_extractor/mpq_libmpq.cpp MPQArchive::MPQArchive
 */
export async function openArchives(inputPath: string, locale: string): Promise<MpqChain> {
  closeArchives();
  const dataDir = existsSync(join(inputPath, "Data")) ? join(inputPath, "Data") : inputPath;
  gOpenArchives.chain = await MpqChain.open(dataDir, locale);
  return gOpenArchives.chain;
}

/** @ac tools/map_extractor/System.cpp CloseMPQFiles */
export function closeArchives(): void {
  gOpenArchives.chain?.close();
  gOpenArchives.chain = null;
}

/**
 * One file read from the archive set. The body is read at construction (`libmpq__file_read`) and held until `close()`;
 * callers must not keep it longer than one conversion.
 *
 * @ac tools/map_extractor/mpq_libmpq.cpp MPQFile
 */
export class MPQFile {
  private eof = false;
  private buffer: Uint8Array | null = null;
  private pointer = 0;
  private size = 0;

  /** @ac tools/map_extractor/mpq_libmpq.cpp MPQFile::MPQFile */
  constructor(filename: string) {
    const body = gOpenArchives.chain?.read(filename) ?? null;
    if (!body) {
      this.eof = true;
      return;
    }
    this.size = body.length;
    // HACK: in patch.mpq some files don't want to open and give 1 for filesize
    if (this.size <= 1) {
      this.eof = true;
      return;
    }
    this.buffer = body;
  }

  /** @ac tools/map_extractor/mpq_libmpq.cpp MPQFile::read */
  read(dest: Uint8Array, bytes: number): number {
    if (this.eof || !this.buffer) return 0;
    const rpos = this.pointer + bytes;
    if (rpos > this.size) {
      bytes = this.size - this.pointer;
      this.eof = true;
    }
    dest.set(this.buffer.subarray(this.pointer, this.pointer + bytes));
    this.pointer = rpos;
    return bytes;
  }

  /** @ac tools/map_extractor/mpq_libmpq04.h MPQFile::getSize */
  getSize(): number {
    return this.size;
  }

  /** @ac tools/map_extractor/mpq_libmpq04.h MPQFile::getPos */
  getPos(): number {
    return this.pointer;
  }

  /** @ac tools/map_extractor/mpq_libmpq04.h MPQFile::getBuffer */
  getBuffer(): Uint8Array | null {
    return this.buffer;
  }

  /** @ac tools/map_extractor/mpq_libmpq04.h MPQFile::getPointer */
  getPointer(): Uint8Array | null {
    return this.buffer ? this.buffer.subarray(this.pointer) : null;
  }

  /** @ac tools/map_extractor/mpq_libmpq04.h MPQFile::isEof */
  isEof(): boolean {
    return this.eof;
  }

  /** @ac tools/map_extractor/mpq_libmpq.cpp MPQFile::seek */
  seek(offset: number): void {
    this.pointer = offset;
    this.eof = this.pointer >= this.size;
  }

  /** @ac tools/map_extractor/mpq_libmpq.cpp MPQFile::seekRelative */
  seekRelative(offset: number): void {
    this.pointer += offset;
    this.eof = this.pointer >= this.size;
  }

  /** @ac tools/map_extractor/mpq_libmpq.cpp MPQFile::close */
  close(): void {
    this.buffer = null;
    this.eof = true;
  }
}
