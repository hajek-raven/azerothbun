import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, writeSync } from "node:fs";

/**
 * Stand-ins for the stdio `FILE*` the extractor writes through (`fopen`, `fwrite`, `fseek`, `fclose`). This file has
 * no C++ counterpart; it keeps the `fwrite` call sites of the ported functions one-to-one.
 *
 * All values are little endian. A `FileWriter` buffers in memory and writes through on `fclose` (or when the buffer
 * grows past `FLUSH_AT` for append mode files), so a model file is one write.
 */
const FLUSH_AT = 1 << 20;

export class FileWriter {
  private bytes: Uint8Array;
  private view: DataView;
  private length = 0;
  private fd: number | null;

  /** `fopen(path, "wb")` (`append` false) or `fopen(path, "ab")`. Null when the file cannot be opened. */
  static open(path: string, append = false): FileWriter | null {
    try {
      return new FileWriter(openSync(path, append ? "a" : "w"), append);
    } catch {
      return null;
    }
  }

  private constructor(
    fd: number,
    private readonly append: boolean,
  ) {
    this.fd = fd;
    this.bytes = new Uint8Array(4096);
    this.view = new DataView(this.bytes.buffer);
  }

  private reserve(extra: number): number {
    const at = this.length;
    const need = at + extra;
    if (need > this.bytes.length) {
      let capacity = this.bytes.length * 2;
      while (capacity < need) {
        capacity *= 2;
      }
      const grown = new Uint8Array(capacity);
      grown.set(this.bytes.subarray(0, at));
      this.bytes = grown;
      this.view = new DataView(grown.buffer);
    }
    this.length = need;
    return at;
  }

  /** Bytes written so far (`ftell`). */
  tell(): number {
    return this.length;
  }

  u8(value: number): void {
    const at = this.reserve(1);
    this.view.setUint8(at, value);
  }

  u16(value: number): void {
    const at = this.reserve(2);
    this.view.setUint16(at, value, true);
  }

  u32(value: number): void {
    const at = this.reserve(4);
    this.view.setUint32(at, value >>> 0, true);
  }

  i32(value: number): void {
    const at = this.reserve(4);
    this.view.setInt32(at, value | 0, true);
  }

  f32(value: number): void {
    const at = this.reserve(4);
    this.view.setFloat32(at, value, true);
  }

  /** `fwrite(data, 1, n, f)`. */
  raw(data: ArrayLike<number>): void {
    const at = this.reserve(data.length);
    this.bytes.set(data, at);
  }

  /** `fwrite` of a C string with the given length; characters are bytes (latin1). */
  latin1(text: string, length = text.length): void {
    const at = this.reserve(length);
    for (let index = 0; index < length; ++index) {
      this.bytes[at + index] = index < text.length ? text.charCodeAt(index) & 0xff : 0;
    }
  }

  /** `fseek(f, offset, SEEK_SET)` followed by `fwrite` of a uint32 / int, inside what is already buffered. */
  patchU32(offset: number, value: number): void {
    this.view.setUint32(offset, value >>> 0, true);
  }

  /** Appends are flushed in chunks; a whole-file write is flushed by `close`. */
  flushIfLarge(): void {
    if (this.append && this.length >= FLUSH_AT) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.fd === null || this.length === 0) {
      return;
    }
    let done = 0;
    while (done < this.length) {
      done += writeSync(this.fd, this.bytes, done, this.length - done);
    }
    this.length = 0;
  }

  /** `fclose`. */
  close(): void {
    if (this.fd === null) {
      return;
    }
    this.flush();
    closeSync(this.fd);
    this.fd = null;
  }
}

/** `FileExists`: `fopen(file, "rb")` succeeds. */
export function fileExists(path: string): boolean {
  return existsSync(path);
}

/** `mkdir(dir, 0711)`; false when it already exists. */
export function makeDirectory(path: string): boolean {
  try {
    mkdirSync(path, { recursive: false, mode: 0o711 });
    return true;
  } catch {
    return false;
  }
}

/** `remove(path)`. */
export function removeFile(path: string): void {
  rmSync(path, { force: true });
}

/**
 * `fopen(path, "r+b"); fseek(8); fread(&nVertices, 4, 1)`: the vertex count at offset 8 of an extracted model file
 * (`Doodad::Extract`, `MapObject::Extract`). Undefined when the file cannot be opened or is shorter than 12 bytes.
 */
export function readVertexCountAt8(path: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const head = new Uint8Array(4);
    if (readSync(fd, head, 0, 4, 8) !== 4) {
      return undefined;
    }
    return new DataView(head.buffer).getInt32(0, true);
  } finally {
    closeSync(fd);
  }
}

/** Bytes of a C string as characters (latin1), so names round trip byte for byte. */
export function bytesToLatin1(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let index = start; index < end; ++index) {
    text += String.fromCharCode(bytes[index]!);
  }
  return text;
}
