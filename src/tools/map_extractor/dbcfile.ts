/** `dbcfile.h` / `dbcfile.cpp`: a DBC read from the archive set (the extractor reads `Map.dbc`, `LiquidType.dbc`, `CinematicCamera.dbc`). */
import { MPQFile } from "./mpq_libmpq04.ts";

const textDecoder = new TextDecoder();

/** @ac tools/map_extractor/dbcfile.h DBCFile::Record */
export class DBCRecord {
  constructor(
    private readonly file: DBCFile,
    private readonly offset: number,
  ) {}

  /** @ac tools/map_extractor/dbcfile.h DBCFile::Record::getFloat */
  getFloat(field: number): number {
    this.file.assertField(field);
    return this.file.view.getFloat32(this.offset + field * 4, true);
  }

  /** @ac tools/map_extractor/dbcfile.h DBCFile::Record::getUInt */
  getUInt(field: number): number {
    this.file.assertField(field);
    return this.file.view.getUint32(this.offset + field * 4, true);
  }

  /** @ac tools/map_extractor/dbcfile.h DBCFile::Record::getInt */
  getInt(field: number): number {
    this.file.assertField(field);
    return this.file.view.getInt32(this.offset + field * 4, true);
  }

  /** @ac tools/map_extractor/dbcfile.h DBCFile::Record::getString */
  getString(field: number): string {
    const stringOffset = this.getUInt(field);
    if (stringOffset >= this.file.stringSize) throw new Error(`string offset ${stringOffset} outside of the string table`);
    const bytes = this.file.bytes;
    const start = this.file.stringTableOffset + stringOffset;
    let end = start;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return textDecoder.decode(bytes.subarray(start, end));
  }
}

/** @ac tools/map_extractor/dbcfile.h DBCFile */
export class DBCFile {
  recordSize = 0;
  recordCount = 0;
  fieldCount = 0;
  stringSize = 0;
  bytes: Uint8Array = new Uint8Array(0);
  view: DataView = new DataView(new ArrayBuffer(0));
  stringTableOffset = 0;
  private opened = false;

  constructor(private readonly filename: string) {}

  /** @ac tools/map_extractor/dbcfile.cpp DBCFile::open */
  open(): boolean {
    const f = new MPQFile(this.filename);
    const body = f.getBuffer();
    if (!body || body.length < 20) return false;
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    // 'WDBC'
    if (body[0] !== 0x57 || body[1] !== 0x44 || body[2] !== 0x42 || body[3] !== 0x43) return false;
    const na = view.getUint32(4, true);
    const nb = view.getUint32(8, true);
    const es = view.getUint32(12, true);
    const ss = view.getUint32(16, true);

    this.recordSize = es;
    this.recordCount = na;
    this.fieldCount = nb;
    this.stringSize = ss;
    if (this.fieldCount * 4 !== this.recordSize) return false;

    const dataSize = this.recordSize * this.recordCount + this.stringSize;
    if (body.length - 20 < dataSize) return false;
    this.bytes = body.subarray(20, 20 + dataSize);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.stringTableOffset = this.recordSize * this.recordCount;
    this.opened = true;
    f.close();
    return true;
  }

  assertField(field: number): void {
    if (field >= this.fieldCount) throw new Error(`field ${field} of ${this.fieldCount}`);
  }

  /** @ac tools/map_extractor/dbcfile.cpp DBCFile::getRecord */
  getRecord(id: number): DBCRecord {
    if (!this.opened) throw new Error("DBC is not open");
    return new DBCRecord(this, id * this.recordSize);
  }

  /** @ac tools/map_extractor/dbcfile.cpp DBCFile::getMaxId */
  getMaxId(): number {
    let maxId = 0;
    for (let i = 0; i < this.recordCount; ++i) {
      const id = this.getRecord(i).getUInt(0);
      if (maxId < id) maxId = id;
    }
    return maxId;
  }

  /** `begin()`/`end()` iteration */
  *[Symbol.iterator](): IterableIterator<DBCRecord> {
    for (let i = 0; i < this.recordCount; ++i) yield this.getRecord(i);
  }

  /** @ac tools/map_extractor/dbcfile.h DBCFile::getRecordCount */
  getRecordCount(): number {
    return this.recordCount;
  }

  /** @ac tools/map_extractor/dbcfile.h DBCFile::getFieldCount */
  getFieldCount(): number {
    return this.fieldCount;
  }
}
