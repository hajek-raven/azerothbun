import type { MySqlTable } from "drizzle-orm/mysql-core";
import type { WorldTables } from "../database/world-tables.ts";
import { join } from "node:path";

/**
 * A WDBC file read field by field on demand (`DBCStorage`), keyed by column 0. Rows from the matching `*_dbc`
 * world table override or add records, like `DBCDatabaseLoader` ("If exist in DBC file override from DB").
 * Columns are addressed by their position in the file, the same order the `*_dbc` table uses.
 */
export class DbcTable {
  private readonly view: DataView | null;
  private readonly bytes: Uint8Array | null;
  private readonly rows = new Map<number, number>();
  private readonly overrides = new Map<number, unknown[]>();
  private readonly recordSize: number;
  private readonly fieldCount: number;
  private readonly stringBase: number;

  constructor(bytes: Uint8Array | null, overrideRows: readonly unknown[][] = []) {
    this.bytes = bytes;
    if (bytes && bytes.length >= 20 && String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === "WDBC") {
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const recordCount = this.view.getUint32(4, true);
      this.fieldCount = this.view.getUint32(8, true);
      this.recordSize = this.view.getUint32(12, true);
      this.stringBase = 20 + recordCount * this.recordSize;
      for (let row = 0; row < recordCount; row++) {
        this.rows.set(this.view.getUint32(20 + row * this.recordSize, true), 20 + row * this.recordSize);
      }
    } else {
      this.view = null;
      this.fieldCount = overrideRows[0]?.length ?? 0;
      this.recordSize = this.fieldCount * 4;
      this.stringBase = 0;
    }
    for (const row of overrideRows) {
      this.overrides.set(Number(row[0]), row);
    }
  }

  /** `data/dbc/<file>` plus the rows of `<table>` in the world database (either may be missing). */
  static async load(directory: string, file: string, world: WorldTables | null = null, table?: MySqlTable): Promise<DbcTable> {
    const path = join(directory, file);
    const source = Bun.file(path);
    const bytes = await source.exists() ? await source.bytes() : null;
    // Columns in schema order, which is the `*_dbc` table order and the DBC field order.
    const overrides = world && table ? world.all(table).map((row) => Object.values(row as Record<string, unknown>)) : [];
    return new DbcTable(bytes, overrides);
  }

  get size(): number {
    const ids = new Set([...this.rows.keys(), ...this.overrides.keys()]);
    return ids.size;
  }

  has(id: number): boolean {
    return this.overrides.has(id) || this.rows.has(id);
  }

  ids(): number[] {
    return [...new Set([...this.rows.keys(), ...this.overrides.keys()])].sort((left, right) => left - right);
  }

  /** A record view, or null when the id is absent. */
  record(id: number): DbcRecordView | null {
    const override = this.overrides.get(id);
    if (override) {
      return new OverrideRecord(override);
    }
    const offset = this.rows.get(id);
    if (offset === undefined || !this.view || !this.bytes) {
      return null;
    }
    return new FileRecord(this.view, this.bytes, offset, this.stringBase, this.fieldCount);
  }
}

export interface DbcRecordView {
  u32(field: number): number;
  i32(field: number): number;
  f32(field: number): number;
  str(field: number): string;
}

class FileRecord implements DbcRecordView {
  constructor(
    private readonly view: DataView,
    private readonly bytes: Uint8Array,
    private readonly offset: number,
    private readonly stringBase: number,
    private readonly fieldCount: number,
  ) {}

  u32(field: number): number {
    return field < this.fieldCount ? this.view.getUint32(this.offset + field * 4, true) : 0;
  }

  i32(field: number): number {
    return field < this.fieldCount ? this.view.getInt32(this.offset + field * 4, true) : 0;
  }

  f32(field: number): number {
    return field < this.fieldCount ? this.view.getFloat32(this.offset + field * 4, true) : 0;
  }

  str(field: number): string {
    const at = this.u32(field);
    const start = this.stringBase + at;
    if (start >= this.bytes.length) {
      return "";
    }
    const end = this.bytes.indexOf(0, start);
    return decoder.decode(this.bytes.subarray(start, end < 0 ? this.bytes.length : end));
  }
}

class OverrideRecord implements DbcRecordView {
  constructor(private readonly row: readonly unknown[]) {}

  u32(field: number): number {
    return Number(this.row[field] ?? 0) >>> 0;
  }

  i32(field: number): number {
    return Number(this.row[field] ?? 0) | 0;
  }

  f32(field: number): number {
    return Math.fround(Number(this.row[field] ?? 0));
  }

  str(field: number): string {
    const value = this.row[field];
    return typeof value === "string" ? value : "";
  }
}

const decoder = new TextDecoder();
