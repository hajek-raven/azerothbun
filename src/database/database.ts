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
