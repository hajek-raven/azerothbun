import { SQL } from "bun";
import { resetObjectGuids } from "../game/globals/object-guids.ts";
import { log } from "../log.ts";
import { openDatabase, parseDatabaseInfo, type Db } from "./database.ts";
import { populateDatabase, updateDatabase } from "./updater.ts";
import type { WorldTables } from "./world-tables.ts";

/**
 * `acore_test_*` databases for `bun test`, on the MySQL from `docker compose up -d`.
 *
 * Each kind is built once from `sql/base/` plus the updates as `acore_test_template_<kind>`. A test process gets one
 * copy per kind (`acore_test_<pid>_<kind>`); `testDatabase` empties it and puts the template rows back before every
 * use, so each test starts from the base data. Copies left by finished processes are dropped on the next run.
 */
type Kind = "auth" | "characters";

type Shared = { db: Db; reset: string };

const INFO = parseDatabaseInfo(process.env.AC_TEST_DATABASE_INFO ?? "127.0.0.1;3306;acore_test;acore_test;");
const shared = new Map<Kind, Promise<Shared>>();

function adminClient(): SQL {
  return new SQL({
    adapter: "mysql",
    hostname: INFO.host,
    port: INFO.port,
    username: INFO.user,
    password: INFO.password,
    database: "information_schema",
    max: 1,
  });
}

async function buildTemplate(admin: SQL, kind: Kind): Promise<string> {
  const name = `acore_test_template_${kind}`;
  const exists = await admin.unsafe("SELECT 1 FROM SCHEMATA WHERE SCHEMA_NAME = ?", [name]);
  if (exists.length > 0) {
    return name;
  }
  log("sql.updates", `building ${name}`);
  await admin.unsafe(`CREATE DATABASE \`${name}\` DEFAULT CHARACTER SET UTF8MB4 COLLATE utf8mb4_unicode_ci`);
  const db = openDatabase({ ...INFO, database: name }, 1);
  try {
    const info = {
      displayName: name,
      baseFilesDirectory: `sql/base/db_${kind}`,
      sourceDirectory: "azerothcore",
      redundancy: true,
      allowRehash: true,
      archivedRedundancy: false,
      cleanDeadRefMaxCount: 3,
    };
    await populateDatabase(db, info);
    await updateDatabase(db, info);
  } catch (error) {
    await admin.unsafe(`DROP DATABASE \`${name}\``);
    throw error;
  } finally {
    await db.$client.close();
  }
  return name;
}

async function dropAbandoned(admin: SQL): Promise<void> {
  const schemas = (await admin.unsafe("SELECT SCHEMA_NAME AS name FROM SCHEMATA WHERE SCHEMA_NAME LIKE 'acore\\_test\\_%'")) as { name: string }[];
  for (const { name } of schemas) {
    const pid = /^acore_test_(\d+)_/.exec(name)?.[1];
    if (!pid || Number(pid) === process.pid) continue;
    try {
      process.kill(Number(pid), 0);
    } catch {
      await admin.unsafe(`DROP DATABASE IF EXISTS \`${name}\``);
    }
  }
}

async function open(kind: Kind): Promise<Shared> {
  const admin = adminClient();
  try {
    await dropAbandoned(admin);
    const source = await buildTemplate(admin, kind);
    const tables = (await admin.unsafe(
      "SELECT TABLE_NAME AS name, AUTO_INCREMENT AS autoIncrement FROM TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
      [source],
    )) as { name: string; autoIncrement: number | null }[];
    const filled: string[] = [];
    for (const { name } of tables) {
      const rows = await admin.unsafe(`SELECT 1 FROM \`${source}\`.\`${name}\` LIMIT 1`);
      if (rows.length > 0) filled.push(name);
    }
    const name = `acore_test_${process.pid}_${kind}`;
    await admin.unsafe(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.unsafe(`CREATE DATABASE \`${name}\` DEFAULT CHARACTER SET UTF8MB4 COLLATE utf8mb4_unicode_ci`);
    await admin.unsafe(tables.map((table) => `CREATE TABLE \`${name}\`.\`${table.name}\` LIKE \`${source}\`.\`${table.name}\`;`).join("\n"));
    const reset = [
      "SET FOREIGN_KEY_CHECKS = 0;",
      ...tables.map((table) => `DELETE FROM \`${table.name}\`;`),
      ...tables.filter((table) => table.autoIncrement !== null).map((table) => `ALTER TABLE \`${table.name}\` AUTO_INCREMENT = 1;`),
      ...filled.map((table) => `INSERT INTO \`${table}\` SELECT * FROM \`${source}\`.\`${table}\`;`),
      "SET FOREIGN_KEY_CHECKS = 1;",
    ].join("\n");
    return { db: openDatabase({ ...INFO, database: name }, 1), reset };
  } finally {
    await admin.close();
  }
}

/** The process's auth or characters test database, emptied back to the base rows. */
export async function testDatabase(kind: Kind): Promise<Db> {
  let pending = shared.get(kind);
  if (!pending) {
    pending = open(kind);
    shared.set(kind, pending);
  }
  const { db, reset } = await pending;
  await db.$client.unsafe(reset);
  if (kind === "characters") {
    // Empty tables: the guid counters start over, as `SetHighestGuids` would find them.
    resetObjectGuids();
  }
  return db;
}

/** Both test databases, as a world session uses them. */
export async function testDatabases(): Promise<{ login: Db; characters: Db }> {
  return { login: await testDatabase("auth"), characters: await testDatabase("characters") };
}

/** Both test databases with the development accounts `TEST`, `TEST2`, and `TEST3` and their characters. */
export async function seededTestDatabases(world: WorldTables | null = null): Promise<{ login: Db; characters: Db }> {
  const databases = await testDatabases();
  const { seedDevelopmentAccounts } = await import("../db.ts");
  await seedDevelopmentAccounts(databases.login, databases.characters, world);
  return databases;
}
