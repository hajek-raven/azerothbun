import { existsSync } from "node:fs";

/**
 * Stand-ins for the stdio `FILE*` the Collision readers and writers take. This file has no C++
 * counterpart; it keeps the `fread` / `fwrite` call sites of the ported functions one-to-one.
 *
 * All values are little endian, like the files AzerothCore writes on x86 and ARM.
 */

/**
 * A read cursor over a whole file (`fopen(path, "rb")`). Files are mapped with `Bun.mmap`; the readers
 * copy what they keep (typed arrays) out of the mapping, so the mapping can be dropped after loading.
 *
 * Each `read*` returns `undefined` when fewer bytes remain than requested, like a short `fread`; the
 * cursor then moves to the end and `eof()` turns true (`feof` is set only by a failed read).
 */
export class ReadFile {
  private pos = 0;
  private eofFlag = false;
  private readonly view: DataView;

  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  /** `fopen(path, "rb")`: null when the file does not exist or cannot be mapped. */
  static open(path: string): ReadFile | null {
    try {
      return new ReadFile(Bun.mmap(path, { shared: false }));
    } catch {
      // Bun.mmap rejects empty files; fopen opens them.
      try {
        if (existsSync(path) && Bun.file(path).size === 0) return new ReadFile(new Uint8Array(0));
      } catch {
        // fall through
      }
      return null;
    }
  }

  /** `ftell`. */
  tell(): number {
    return this.pos;
  }

  /** `fseek(SEEK_SET)`. */
  seek(offset: number): void {
    this.pos = Math.min(Math.max(offset, 0), this.data.byteLength);
    this.eofFlag = false;
  }

  /** `feof`. */
  eof(): boolean {
    return this.eofFlag;
  }

  remaining(): number {
    return this.data.byteLength - this.pos;
  }

  private take(n: number): number {
    if (this.data.byteLength - this.pos < n) {
      this.pos = this.data.byteLength;
      this.eofFlag = true;
      return -1;
    }
    const at = this.pos;
    this.pos += n;
    return at;
  }

  u8(): number | undefined {
    const at = this.take(1);
    return at < 0 ? undefined : this.view.getUint8(at);
  }

  u16(): number | undefined {
    const at = this.take(2);
    return at < 0 ? undefined : this.view.getUint16(at, true);
  }

  u32(): number | undefined {
    const at = this.take(4);
    return at < 0 ? undefined : this.view.getUint32(at, true);
  }

  i32(): number | undefined {
    const at = this.take(4);
    return at < 0 ? undefined : this.view.getInt32(at, true);
  }

  i16(): number | undefined {
    const at = this.take(2);
    return at < 0 ? undefined : this.view.getInt16(at, true);
  }

  f32(): number | undefined {
    const at = this.take(4);
    return at < 0 ? undefined : this.view.getFloat32(at, true);
  }

  /** Reads `n` floats into `out` starting at `outOffset`. False on a short read. */
  f32Into(out: Float32Array, outOffset: number, n: number): boolean {
    const at = this.take(n * 4);
    if (at < 0) return false;
    for (let i = 0; i < n; ++i) out[outOffset + i] = this.view.getFloat32(at + i * 4, true);
    return true;
  }

  /** A copy of the next `n` floats, or undefined on a short read. */
  f32Array(n: number): Float32Array | undefined {
    const out = new Float32Array(n);
    return this.f32Into(out, 0, n) ? out : undefined;
  }

  /** A copy of the next `n` uint32 values, or undefined on a short read. */
  u32Array(n: number): Uint32Array | undefined {
    const at = this.take(n * 4);
    if (at < 0) return undefined;
    const out = new Uint32Array(n);
    for (let i = 0; i < n; ++i) out[i] = this.view.getUint32(at + i * 4, true);
    return out;
  }

  /** A copy of the next `n` uint16 values, or undefined on a short read. */
  u16Array(n: number): Uint16Array | undefined {
    const at = this.take(n * 2);
    if (at < 0) return undefined;
    const out = new Uint16Array(n);
    for (let i = 0; i < n; ++i) out[i] = this.view.getUint16(at + i * 2, true);
    return out;
  }

  /** A copy of the next `n` bytes, or undefined on a short read. */
  bytes(n: number): Uint8Array | undefined {
    const at = this.take(n);
    if (at < 0) return undefined;
    return this.data.slice(at, at + n);
  }

  /**
   * Reads `len` bytes and compares them with the first `len` characters of `compare` (`memcmp`).
   * False on a short read or a mismatch.
   */
  chunk(compare: string, len: number): boolean {
    const at = this.take(len);
    if (at < 0) return false;
    for (let i = 0; i < len; ++i) {
      const expected = i < compare.length ? compare.charCodeAt(i) & 0xff : 0;
      if (this.data[at + i] !== expected) return false;
    }
    return true;
  }
}

/** A growable output buffer (`fopen(path, "wb")` + `fwrite`), written to disk by `flush`. */
export class WriteFile {
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(4096);
  private view = new DataView(this.buf.buffer);
  private len = 0;

  private grow(extra: number): number {
    const need = this.len + extra;
    if (need > this.buf.byteLength) {
      let size = this.buf.byteLength * 2;
      while (size < need) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    const at = this.len;
    this.len = need;
    return at;
  }

  size(): number {
    return this.len;
  }

  u8(v: number): void {
    const at = this.grow(1);
    this.view.setUint8(at, v);
  }

  u16(v: number): void {
    const at = this.grow(2);
    this.view.setUint16(at, v, true);
  }

  i16(v: number): void {
    const at = this.grow(2);
    this.view.setInt16(at, v, true);
  }

  u32(v: number): void {
    const at = this.grow(4);
    this.view.setUint32(at, v >>> 0, true);
  }

  i32(v: number): void {
    const at = this.grow(4);
    this.view.setInt32(at, v | 0, true);
  }

  f32(v: number): void {
    const at = this.grow(4);
    this.view.setFloat32(at, v, true);
  }

  f32Array(values: ArrayLike<number>, count = values.length): void {
    const at = this.grow(count * 4);
    for (let i = 0; i < count; ++i) this.view.setFloat32(at + i * 4, values[i]!, true);
  }

  u32Array(values: ArrayLike<number>, count = values.length): void {
    const at = this.grow(count * 4);
    for (let i = 0; i < count; ++i) this.view.setUint32(at + i * 4, values[i]! >>> 0, true);
  }

  u16Array(values: ArrayLike<number>, count = values.length): void {
    const at = this.grow(count * 2);
    for (let i = 0; i < count; ++i) this.view.setUint16(at + i * 2, values[i]!, true);
  }

  bytes(values: Uint8Array): void {
    const at = this.grow(values.byteLength);
    this.buf.set(values, at);
  }

  /** Writes the first `len` characters of `s` as bytes (`fwrite("NODE", 4, 1, f)`), NUL padded. */
  chars(s: string, len = s.length): void {
    const at = this.grow(len);
    for (let i = 0; i < len; ++i) this.buf[at + i] = i < s.length ? s.charCodeAt(i) & 0xff : 0;
  }

  /** Overwrites a uint32 at `offset` (`fseek` + `fwrite`). */
  patchU32(offset: number, v: number): void {
    this.view.setUint32(offset, v >>> 0, true);
  }

  toBytes(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.len);
  }

  /** `fclose`: writes the buffer to `path`. False when the write fails. */
  async flush(path: string): Promise<boolean> {
    try {
      await Bun.write(path, this.buf.subarray(0, this.len));
      return true;
    } catch {
      return false;
    }
  }
}

/** Text encoding of model names: AzerothCore writes the raw `char` bytes. */
export function bytesToString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; ++i) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** The inverse of `bytesToString`. */
export function stringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; ++i) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
