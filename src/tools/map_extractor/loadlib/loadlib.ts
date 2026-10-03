/**
 * `loadlib/loadlib.h` and `loadlib.cpp`: the chunked file loader the ADT and WDT readers sit on. A chunk is a 4 byte
 * fourcc (stored reversed on disk, so `MVER` is the bytes `REVM`), a `uint32` size and the body; the structs of C++ are
 * read in place from the file bytes through a `DataView` (the classes in `adt.ts` / `wdt.ts` hold a view and the offset
 * of their fourcc).
 */
import { MPQFile } from "../mpq_libmpq04.ts";

/** @ac tools/map_extractor/loadlib/loadlib.h FILE_FORMAT_VERSION */
export const FILE_FORMAT_VERSION = 18;

/** `u_map_fcc`: the little endian `uint32` of the four characters as they sit in memory (and on disk). */
export function u_map_fcc(text: string): number {
  return (text.charCodeAt(0) | (text.charCodeAt(1) << 8) | (text.charCodeAt(2) << 16) | (text.charCodeAt(3) << 24)) >>> 0;
}

/** @ac tools/map_extractor/loadlib.cpp MverMagic */
export const MverMagic = u_map_fcc("REVM");

/** `struct file_MVER`: fourcc, size, version. */
export const sizeof_file_MVER = 12;

/** @ac tools/map_extractor/loadlib/loadlib.h FileLoader */
export class FileLoader {
  protected data: Uint8Array | null = null;
  protected data_size = 0;
  protected view: DataView = new DataView(new ArrayBuffer(0));
  /** Offset of `file_MVER` in the file, -1 while nothing is loaded (`version` in C++). */
  version = -1;

  /** `version->size` */
  protected versionSize(): number {
    return this.view.getUint32(this.version + 4, true);
  }

  /** @ac tools/map_extractor/loadlib.cpp FileLoader::loadFile */
  loadFile(fileName: string, log = true): boolean {
    this.free();
    const mf = new MPQFile(fileName);
    if (mf.isEof()) {
      if (log) console.log(`No such file ${fileName}`);
      return false;
    }

    // C++ copies the body into its own buffer; the chain already returned a fresh one
    const body = mf.getBuffer()!;
    this.setData(body);
    mf.close();
    let ok = false;
    try {
      ok = this.prepareLoadedData();
    } catch {
      // a chunk that points outside of the file; C++ would read garbage
      ok = false;
    }
    if (ok) return true;

    process.stdout.write(`Error loading ${fileName}\n`);
    this.free();
    return false;
  }

  /** Test and tool entry: the same as `loadFile` for bytes that are already in memory. */
  loadData(body: Uint8Array): boolean {
    this.free();
    this.setData(body);
    let ok = false;
    try {
      ok = this.prepareLoadedData();
    } catch {
      ok = false;
    }
    if (!ok) this.free();
    return ok;
  }

  private setData(body: Uint8Array): void {
    this.data = body;
    this.data_size = body.length;
    this.view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  }

  GetData(): Uint8Array | null {
    return this.data;
  }

  GetDataSize(): number {
    return this.data_size;
  }

  /** @ac tools/map_extractor/loadlib.cpp FileLoader::prepareLoadedData */
  prepareLoadedData(): boolean {
    // Check version
    this.version = 0;
    if (this.data_size < sizeof_file_MVER) return false;
    if (this.view.getUint32(0, true) !== MverMagic) return false;
    if (this.view.getUint32(8, true) !== FILE_FORMAT_VERSION) return false;
    return true;
  }

  /** @ac tools/map_extractor/loadlib.cpp FileLoader::free */
  free(): void {
    this.data = null;
    this.data_size = 0;
    this.version = -1;
    this.view = new DataView(new ArrayBuffer(0));
  }
}
