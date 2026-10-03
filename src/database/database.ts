import { SQL } from "bun";
import { drizzle, type BunMySqlDatabase } from "drizzle-orm/bun-sql/mysql";
import { logError } from "../log.ts";

/** `MySQLConnectionInfo` from `"host;port;user;password;database[;ssl]"` (`LoginDatabaseInfo` and the others). */
export type DatabaseInfo = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
};

export function parseDatabaseInfo(value: string): DatabaseInfo {
  const [host = "127.0.0.1", port = "3306", user = "", password = "", database = "", ssl = ""] = value.split(";");
  return { host, port: Number(port), user, password, database, ssl: ssl === "ssl" };
}

/**
 * One AzerothCore database (`LoginDatabase`, `CharacterDatabase`, `WorldDatabase`) as a drizzle handle over `Bun.SQL`.
 * `$client` is the pool; the updater and raw dump files go through it.
 */
export type Db = BunMySqlDatabase & { $client: SQL };

export function openDatabase(info: DatabaseInfo, poolSize = 1): Db {
  const client = new SQL({
    adapter: "mysql",
    hostname: info.host,
    port: info.port,
    username: info.user,
    password: info.password,
    database: info.database,
    tls: info.ssl,
    max: poolSize,
  });
  return drizzle({ client }) as Db;
}

/** The three pools `worldserver` opens (`DatabaseLoader` with `LoginDatabase`, `CharacterDatabase`, `WorldDatabase`). */
export type Databases = {
  login: Db;
  characters: Db;
  world: Db;
};

export async function closeDatabases(databases: Partial<Databases>): Promise<void> {
  await Promise.all(Object.values(databases).map((db) => db?.$client.close()));
}

/** The handle inside `db.transaction(async (tx) => …)`. */
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A pool or an open transaction; save helpers take either, like `CharacterDatabaseTransaction` in AzerothCore. */
export type DbExecutor = Db | DbTransaction;

/** Rows changed by an `UPDATE` or `DELETE` (`Bun.SQL` puts `affectedRows` on the result array). */
export function affectedRows(result: unknown): number {
  return Number((result as { affectedRows?: number | bigint }).affectedRows ?? 0);
}

/**
 * `CharacterDatabase.Execute` from code that cannot wait (the world tick, deferred spell commits): the statement is
 * queued on the pool and a failure is logged. The login and character pools have one connection, so queued writes
 * run in order and before any later read.
 */
export function executeAsync(statement: PromiseLike<unknown>, what: string): void {
  Promise.resolve(statement).catch((error: unknown) => logError("sql", `${what} failed`, error));
}

/** One result row of a generated prepared statement, by column position (`fields[0].Get<uint32>()`). */
export type Fields = unknown[];

/**
 * `Database.Query(stmt)` for a statement from `src/gen/*Database.gen.ts`: the rows as column arrays, in the order the
 * SELECT lists them, so a C++ `fields[i]` reads as `row[i]`.
 */
export async function queryFields(db: Db, sql: string, ...params: unknown[]): Promise<Fields[]> {
  return (await clientOf(db).unsafe(sql, params).values()) as Fields[];
}

/** `Database.Query(stmt)` with the rows keyed by column name. */
export async function queryRows<T = Record<string, unknown>>(db: Db, sql: string, ...params: unknown[]): Promise<T[]> {
  return [...((await clientOf(db).unsafe(sql, params)) as T[])];
}

/** `Database.Execute(stmt)` / `DirectExecute(stmt)`, awaited. Returns the rows changed. */
export async function executeStatement(db: Db, sql: string, ...params: unknown[]): Promise<number> {
  return affectedRows(await clientOf(db).unsafe(sql, params));
}

/** `Database.Execute(stmt)` from code that does not wait; the pool keeps it in order before later reads. */
export function executeStatementAsync(db: Db, sql: string, ...params: unknown[]): void {
  executeAsync(clientOf(db).unsafe(sql, params), sql);
}

/** A `CharacterDatabaseTransaction` of generated statements: `Append` each, then `CommitTransaction` (all or nothing). */
export type StatementTransaction = [sql: string, ...params: unknown[]][];

/** `Database.CommitTransaction(trans)` for statements appended to a `StatementTransaction`. */
export async function commitTransaction(db: Db, trans: StatementTransaction): Promise<void> {
  if (trans.length === 0) return;
  await clientOf(db).begin(async (tx) => {
    for (const [sql, ...params] of trans) await tx.unsafe(sql, params);
  });
}

function clientOf(db: Db): SQL {
  return db.$client;
}
