const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class ByteReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  readU8(): number {
    return this.view.getUint8(this.advance(1));
  }

  readU16(): number {
    return this.view.getUint16(this.advance(2), true);
  }

  readU32(): number {
    return this.view.getUint32(this.advance(4), true);
  }

  readU64(): bigint {
    return this.view.getBigUint64(this.advance(8), true);
  }

  readF32(): number {
    return this.view.getFloat32(this.advance(4), true);
  }

  readBytes(length: number): Uint8Array {
    if (length < 0) {
      throw new Error("Unexpected end of packet");
    }
    const start = this.advance(length);
    return this.data.slice(start, start + length);
  }

  readCString(): string {
    const end = this.data.indexOf(0, this.offset);
    if (end < 0) {
      throw new Error("Unterminated string");
    }
    const value = textDecoder.decode(this.data.subarray(this.offset, end));
    this.offset = end + 1;
    return value;
  }

  private advance(length: number): number {
    const start = this.offset;
    if (start + length > this.data.length) {
      throw new Error("Unexpected end of packet");
    }
    this.offset = start + length;
    return start;
  }
}

export class ByteWriter {
  private bytes = new Uint8Array(64);
  private view = new DataView(this.bytes.buffer);
  private length = 0;

  writeU8(value: number): this {
    const at = this.reserve(1);
    this.view.setUint8(at, value);
    return this;
  }

  writeU16(value: number): this {
    const at = this.reserve(2);
    this.view.setUint16(at, value, true);
    return this;
  }

  writeU32(value: number): this {
    const at = this.reserve(4);
    this.view.setUint32(at, value, true);
    return this;
  }

  writeU64(value: bigint): this {
    const at = this.reserve(8);
    this.view.setBigUint64(at, value, true);
    return this;
  }

  writeF32(value: number): this {
    const at = this.reserve(4);
    this.view.setFloat32(at, value, true);
    return this;
  }

  writeBytes(value: Uint8Array): this {
    const at = this.reserve(value.length);
    this.bytes.set(value, at);
    return this;
  }

  writeCString(value: string): this {
    return this.writeBytes(textEncoder.encode(value)).writeU8(0);
  }

  toUint8Array(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }

  private reserve(size: number): number {
    const start = this.length;
    const end = start + size;
    if (end > this.bytes.length) {
      const grown = new Uint8Array(Math.max(end, this.bytes.length * 2));
      grown.set(this.bytes.subarray(0, start));
      this.bytes = grown;
      this.view = new DataView(grown.buffer);
    }
    this.length = end;
    return start;
  }
}
