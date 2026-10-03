import { bytesToLatin1 } from "./fileio.ts";
import { MPQFile } from "./mpq_libmpq04.ts";

/**
 * @ac tools/vmap4_extractor/dbcfile.h DBCFile
 * @ac tools/vmap4_extractor/dbcfile.cpp DBCFile::DBCFile
 * @ac tools/vmap4_extractor/dbcfile.cpp DBCFile::open
 * @ac tools/vmap4_extractor/dbcfile.cpp DBCFile::getRecord
 * @ac tools/vmap4_extractor/dbcfile.cpp DBCFile::begin
 * @ac tools/vmap4_extractor/dbcfile.cpp DBCFile::end
 * @ac-skip DBCFile::Exception / NotFound: never thrown by the C++ either
 */
export class DBCRecord {
  constructor(
    private readonly file: DBCFile,
    private readonly offset: number,
  ) {}

  getFloat(field: number): number {
    return this.file.view.getFloat32(this.offset + field * 4, true);
  }

  getUInt(field: number): number {
    return this.file.view.getUint32(this.offset + field * 4, true);
  }

  getInt(field: number): number {
    return this.file.view.getInt32(this.offset + field * 4, true);
  }

  getByte(ofs: number): number {
    return this.file.view.getUint8(this.offset + ofs);
  }

  /** The string table entry the field points at (a C string, bytes as latin1). */
  getString(field: number): string {
    const stringOffset = this.getUInt(field);
    return this.file.stringAt(stringOffset);
  }
}

export class DBCFile {
  recordSize = 0;
  recordCount = 0;
  fieldCount = 0;
  stringSize = 0;
  data: Uint8Array = new Uint8Array(0);
  view: DataView = new DataView(this.data.buffer);
  stringTable = 0;

  constructor(private readonly filename: string) {}

  /** Opens the file from the archives. False when it is missing or is not a DBC. */
  open(): boolean {
    const f = new MPQFile(this.filename);

    // Need some error checking, otherwise an unhandled exception error occurs
    // if people screw with the data path.
    if (f.isEof()) {
      return false;
    }

    const header = f.readBytes(4); // File Header
    if (header[0] !== 0x57 || header[1] !== 0x44 || header[2] !== 0x42 || header[3] !== 0x43) {
      f.close();
      console.log(`Critical Error: An error occured while trying to read the DBCFile ${this.filename}.`);
      return false;
    }

    const na = f.readU32(); // Number of records
    const nb = f.readU32(); // Number of fields
    const es = f.readU32(); // Size of a record
    const ss = f.readU32(); // String size

    this.recordSize = es;
    this.recordCount = na;
    this.fieldCount = nb;
    this.stringSize = ss;
    if (this.fieldCount * 4 < this.recordSize) {
      throw new Error(`${this.filename}: fieldCount * 4 < recordSize`);
    }

    const total = this.recordSize * this.recordCount + this.stringSize;
    this.data = f.readBytes(total);
    this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    this.stringTable = this.recordSize * this.recordCount;
    f.close();
    return true;
  }

  stringAt(stringOffset: number): string {
    const start = this.stringTable + stringOffset;
    let end = start;
    while (end < this.data.length && this.data[end] !== 0) {
      ++end;
    }
    return bytesToLatin1(this.data, start, end);
  }

  getRecord(id: number): DBCRecord {
    return new DBCRecord(this, id * this.recordSize);
  }

  /** `begin()` .. `end()`. */
  *[Symbol.iterator](): IterableIterator<DBCRecord> {
    for (let index = 0; index < this.recordCount; ++index) {
      yield new DBCRecord(this, index * this.recordSize);
    }
  }

  getRecordCount(): number {
    return this.recordCount;
  }

  getFieldCount(): number {
    return this.fieldCount;
  }
}
