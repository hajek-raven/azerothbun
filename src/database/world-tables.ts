import { getColumns, getTableName, is, SQL, type InferSelectModel } from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import type { Db } from "./database.ts";

export type Row<T extends MySqlTable> = InferSelectModel<T>;

/**
 * World database rows held in memory, the way `ObjectMgr`, `SpellMgr`, and the other managers cache `acore_world`
 * at startup. Game code reads them synchronously, so the world tick never waits on MySQL.
 *
 * `load` reads the listed tables once. `where` builds a column index on first use.
 */
export class WorldTables {
  private readonly tables = new Map<string, readonly unknown[]>();
  private readonly indexes = new Map<string, Map<unknown, unknown[]>>();

  /**
   * @param strict  A table that was not loaded throws (server). Off in tests, where a missing table reads as empty.
   */
  private constructor(private readonly strict: boolean) {}

  static async load(db: Db, tables: readonly MySqlTable[]): Promise<WorldTables> {
    const store = new WorldTables(true);
    const results = await Promise.all(tables.map((table) => db.select().from(table)));
    tables.forEach((table, index) => store.tables.set(getTableName(table), results[index]!));
    return store;
  }

  /**
   * Rows given in code (tests). Missing columns get the column default from the schema, as an `INSERT` that
   * names only some columns would.
   */
  static fromRows(entries: readonly (readonly [MySqlTable, readonly Record<string, unknown>[]])[] = []): WorldTables {
    const store = new WorldTables(false);
    for (const [table, rows] of entries) {
      store.set(table, rows);
    }
    return store;
  }

  /** Adds or replaces a table (tests). */
  set<T extends MySqlTable>(table: T, rows: readonly Partial<Row<T>>[] | readonly Record<string, unknown>[]): this {
    const name = getTableName(table);
    const defaults = columnDefaults(table);
    this.tables.set(
      name,
      rows.map((row) => ({ ...defaults, ...row })),
    );
    for (const key of this.indexes.keys()) {
      if (key.startsWith(`${name}.`)) this.indexes.delete(key);
    }
    return this;
  }

  /** Appends rows to a table (tests), with the same defaults as `set`. */
  insert<T extends MySqlTable>(table: T, rows: readonly Partial<Row<T>>[] | readonly Record<string, unknown>[]): this {
    const existing = this.tables.get(getTableName(table)) ?? [];
    return this.set(table, [...(existing as Record<string, unknown>[]), ...(rows as Record<string, unknown>[])]);
  }

  has(table: MySqlTable): boolean {
    return this.tables.has(getTableName(table));
  }

  all<T extends MySqlTable>(table: T): readonly Row<T>[] {
    const name = getTableName(table);
    const rows = this.tables.get(name);
    if (!rows) {
      if (this.strict) {
        throw new Error(`world table ${name} is not loaded; add it to WORLD_TABLES`);
      }
      return [];
    }
    return rows as readonly Row<T>[];
  }

  /** Rows whose `column` equals `value`, in table order. */
  where<T extends MySqlTable, K extends keyof Row<T> & string>(table: T, column: K, value: Row<T>[K]): readonly Row<T>[] {
    const key = `${getTableName(table)}.${column}`;
    let index = this.indexes.get(key);
    if (!index) {
      index = new Map();
      for (const row of this.all(table)) {
        const cell = (row as Record<string, unknown>)[column];
        const list = index.get(cell);
        if (list) list.push(row);
        else index.set(cell, [row]);
      }
      this.indexes.set(key, index);
    }
    return (index.get(value) ?? []) as readonly Row<T>[];
  }

  first<T extends MySqlTable, K extends keyof Row<T> & string>(table: T, column: K, value: Row<T>[K]): Row<T> | undefined {
    return this.where(table, column, value)[0];
  }
}

function columnDefaults(table: MySqlTable): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(getColumns(table))) {
    const value = column.default;
    defaults[key] = value === undefined || is(value, SQL) ? null : value;
  }
  return defaults;
}
