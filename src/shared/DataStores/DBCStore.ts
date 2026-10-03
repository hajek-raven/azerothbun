/**
 * `DBCStorage<T>`: a client DBC file read with its `DBCfmt.h` format into objects named like the `DBCStructure.h`
 * struct (arrays for `name[16]`, nested objects for `DBCPosition3D`). Rows of the matching `*_dbc` world table
 * override or add records, as `DBCDatabaseLoader` does.
 */
import { join } from "node:path";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import * as worldSchema from "../../database/schema/world.ts";
import type { WorldTables } from "../../database/world-tables.ts";
import type { DBCStoreInfo } from "../../gen/DBCStructure.gen.ts";

const decoder = new TextDecoder();

/** @ac shared/DataStores/DBCStore.h DBCStorage */
export class DBCStorage<T extends object> {
  private readonly index = new Map<number, T>();
  private numRows = 0;

  constructor(readonly info: DBCStoreInfo) {}

  /** @ac shared/DataStores/DBCStore.h DBCStorage::LookupEntry */
  lookupEntry(id: number): T | null {
    return this.index.get(id) ?? null;
  }

  /** @ac shared/DataStores/DBCStore.h DBCStorage::GetNumRows (highest index + 1) */
  getNumRows(): number {
    return this.numRows;
  }

  get size(): number {
    return this.index.size;
  }

  /** Records in index order (`DBCStorageIterator`). */
  *[Symbol.iterator](): IterableIterator<T> {
    for (const id of [...this.index.keys()].sort((a, b) => a - b)) yield this.index.get(id)!;
  }

  /** Adds a record (tests, and `*_dbc` rows). */
  set(id: number, record: T): void {
    this.index.set(id, record);
    this.numRows = Math.max(this.numRows, id + 1);
  }

  /** Reads the WDBC file bytes. A file that does not match the format throws. */
  loadFromBytes(bytes: Uint8Array): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 20 || decoder.decode(bytes.subarray(0, 4)) !== "WDBC") throw new Error(`${this.info.file}: not a WDBC file`);
    const recordCount = view.getUint32(4, true);
    const fieldCount = view.getUint32(8, true);
    const recordSize = view.getUint32(12, true);
    // `gt*.dbc` files carry only the value; the `d` column of their format is the row number.
    const sequential = fieldCount === this.info.fmt.length - 1 && this.info.fmt[0] === "d";
    const fmt = sequential ? this.info.fmt.slice(1) : this.info.fmt;
    if (fieldCount !== fmt.length) throw new Error(`${this.info.file}: ${fieldCount} fields, format has ${fmt.length}`);
    // `DBCFileLoader::Load` checks only the field count: unused columns may be narrower than the format says
    // (`PowerDisplay.dbc` stores its colors as bytes), so only the read offsets are taken from the format.
    const strings = 20 + recordCount * recordSize;
    const readString = (offset: number): string => {
      const start = strings + offset;
      const end = bytes.indexOf(0, start);
      return decoder.decode(bytes.subarray(start, end < 0 ? bytes.length : end));
    };
    const keyPos = sequential ? -1 : indexPosition(fmt);
    for (let row = 0; row < recordCount; row++) {
      let offset = 20 + row * recordSize;
      const values: unknown[] = [];
      for (const c of fmt) {
        switch (c) {
          case "b":
          case "l":
            values.push(view.getUint8(offset));
            offset += 1;
            break;
          case "X":
            values.push(0);
            offset += 1;
            break;
          case "f":
            values.push(view.getFloat32(offset, true));
            offset += 4;
            break;
          case "s":
            values.push(readString(view.getUint32(offset, true)));
            offset += 4;
            break;
          case "i":
            values.push(view.getInt32(offset, true));
            offset += 4;
            break;
          default:
            values.push(view.getUint32(offset, true));
            offset += 4;
        }
      }
      this.set(keyPos < 0 ? row : Number(values[keyPos]), this.build(sequential ? [0, ...values] : values));
    }
  }

  /** Rows of the `*_dbc` table in format column order (`DBCDatabaseLoader::Load`). */
  loadOverrides(rows: readonly unknown[][]): void {
    const keyPos = indexPosition(this.info.fmt);
    for (const row of rows) {
      if (row.length < this.info.fmt.length) continue;
      const values = row.slice(0, this.info.fmt.length);
      this.set(keyPos < 0 ? this.numRows : Number(values[keyPos]), this.build(values));
    }
  }

  private build(values: readonly unknown[]): T {
    const record: Record<string, unknown> = {};
    this.info.fields.forEach((field, position) => {
      if (!field) return;
      const value = this.info.fmt[position] === "i" ? Number(values[position]) | 0 : values[position];
      const dot = field.indexOf(".");
      if (dot < 0) {
        record[field] = value;
        return;
      }
      const head = field.slice(0, dot);
      const tail = field.slice(dot + 1);
      if (/^\d+$/.test(tail)) {
        const list = (record[head] as unknown[] | undefined) ?? [];
        list[Number(tail)] = value;
        record[head] = list;
      } else {
        const nested = (record[head] as Record<string, unknown> | undefined) ?? {};
        nested[tail] = value;
        record[head] = nested;
      }
    });
    return record as T;
  }
}

function indexPosition(fmt: string): number {
  const n = fmt.indexOf("n");
  return n >= 0 ? n : fmt.indexOf("d");
}

/**
 * `LoadDBC`: `data/dbc/<file>` (missing file gives an empty store, like a server without extracted data) plus the
 * rows of the `*_dbc` table when the world tables hold it.
 */
export async function loadDBC<T extends object>(info: DBCStoreInfo, directory: string, world: WorldTables | null = null): Promise<DBCStorage<T>> {
  const store = new DBCStorage<T>(info);
  const file = Bun.file(join(directory, info.file));
  if (await file.exists()) store.loadFromBytes(await file.bytes());
  const table = (worldSchema as Record<string, unknown>)[info.table] as MySqlTable | undefined;
  if (world && table && world.has(table)) {
    store.loadOverrides(world.all(table).map((row) => Object.values(row as Record<string, unknown>)));
  }
  return store;
}
