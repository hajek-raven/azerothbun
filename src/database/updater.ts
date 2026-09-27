import { CryptoHasher, Glob } from "bun";
import { basename, join } from "node:path";
import { log } from "../log.ts";
import type { Db } from "./database.ts";

/** `UpdateFetcher::State`. */
type State = "RELEASED" | "CUSTOM" | "PENDING" | "MODULE" | "ARCHIVED";

type AppliedFile = { name: string; hash: string; state: State };
type SqlFile = { path: string; name: string; state: State };

/** `DBUpdater<T>` paths and the `Updates.*` switches from the config file. */
export type UpdaterInfo = {
  /** `LoginDatabase`, `CharacterDatabase`, `WorldDatabase`. */
  displayName: string;
  /** `data/sql/base/db_*`: the full dump `PopulateDatabase` loads into an empty database. */
  baseFilesDirectory: string;
  /** `SourceDirectory`; `$` in `updates_include.path` expands to it. */
  sourceDirectory: string;
  redundancy: boolean;
  allowRehash: boolean;
  archivedRedundancy: boolean;
  cleanDeadRefMaxCount: number;
};

/** `Updates.EnableDatabases` bits (`DatabaseLoader::DatabaseTypeFlags`). */
export const DATABASE_LOGIN = 1;
export const DATABASE_CHARACTER = 2;
export const DATABASE_WORLD = 4;

/** `PopulateDatabase`: an empty database gets every `*.sql` file of the base directory, sorted by name. */
export async function populateDatabase(db: Db, info: UpdaterInfo): Promise<boolean> {
  const tables = await db.$client.unsafe("SHOW TABLES");
  if (tables.length > 0) {
    return true;
  }
  const files = await sqlFilesIn(info.baseFilesDirectory, false);
  if (files.length === 0) {
    throw new Error(`no *.sql files in ${info.baseFilesDirectory}`);
  }
  log("sql.updates", `Database ${info.displayName} is empty, auto populating it...`);
  for (const file of files.sort()) {
    log("sql.updates", `>> Applying '${basename(file)}'...`);
    await applyFile(db, file);
  }
  log("sql.updates", ">> Done!");
  return true;
}

/** `UpdateDatabase` and `UpdateFetcher::Update`. */
export async function updateDatabase(db: Db, info: UpdaterInfo): Promise<{ updated: number; recent: number; archived: number }> {
  for (const table of ["updates", "updates_include"]) {
    const found = await db.$client.unsafe(`SHOW TABLES LIKE '${table}'`);
    if (found.length === 0) {
      log("sql.updates", `> Table '${table}' not exist! Try add based table`);
      await applyFile(db, join(info.baseFilesDirectory, `${table}.sql`));
    }
  }

  const available = await fileList(db, info);
  const applied = new Map<string, AppliedFile>();
  for (const row of (await db.$client.unsafe("SELECT `name`, `hash`, `state` FROM `updates` ORDER BY `name` ASC")) as AppliedFile[]) {
    applied.set(row.name, row);
  }
  let recent = 0;
  let archived = 0;
  const hashToName = new Map<string, string>();
  for (const entry of applied.values()) {
    if (entry.state === "RELEASED") recent += 1;
    else archived += 1;
    hashToName.set(entry.hash, entry.name);
  }

  let updated = 0;
  const applyUpdateFile = async (file: SqlFile) => {
    const existing = applied.get(file.name);
    if (existing) {
      if (!info.redundancy) {
        applied.delete(file.name);
        return;
      }
      if (!info.archivedRedundancy && existing.state === "ARCHIVED" && file.state === "ARCHIVED") {
        applied.delete(file.name);
        return;
      }
    }
    const hash = sha1Hex(await Bun.file(file.path).text());
    let rehashOnly = false;
    if (!existing) {
      const renamedFrom = hashToName.get(hash);
      if (renamedFrom !== undefined) {
        if (available.some((other) => other.name === renamedFrom)) {
          log("sql.updates", `>> It seems like the update "${file.name}" '${hash.slice(0, 7)}' was renamed, but the old file is still there! Treating it as a new file! (It is probably an unmodified copy of the file "${renamedFrom}")`);
        } else {
          log("sql.updates", `>> Renaming update "${renamedFrom}" to "${file.name}" '${hash.slice(0, 7)}'.`);
          await db.$client.unsafe("DELETE FROM `updates` WHERE `name` = ?", [file.name]);
          await db.$client.unsafe("UPDATE `updates` SET `name` = ? WHERE `name` = ?", [file.name, renamedFrom]);
          applied.delete(renamedFrom);
          return;
        }
      } else {
        log("sql.updates", `>> Applying update "${file.name}" '${hash.slice(0, 7)}'...`);
      }
    } else if (info.allowRehash && existing.hash === "") {
      rehashOnly = true;
      log("sql.updates", `>> Re-hashing update "${file.name}" '${hash.slice(0, 7)}'...`);
    } else if (existing.hash !== hash) {
      log("sql.updates", `>> Reapplying update "${file.name}" '${existing.hash.slice(0, 7)}' -> '${hash.slice(0, 7)}' (it changed)...`);
    } else {
      if (existing.state !== file.state) {
        await db.$client.unsafe("UPDATE `updates` SET `state` = ? WHERE `name` = ?", [file.state, file.name]);
      }
      applied.delete(file.name);
      return;
    }

    let speed = 0;
    if (!rehashOnly) {
      const started = performance.now();
      await applyFile(db, file.path);
      speed = Math.round(performance.now() - started);
      updated += 1;
    }
    await db.$client.unsafe("REPLACE INTO `updates` (`name`, `hash`, `state`, `speed`) VALUES (?, ?, ?, ?)", [
      file.name,
      hash,
      file.state,
      speed,
    ]);
    applied.delete(file.name);
  };

  const late = (state: State) => state === "PENDING" || state === "CUSTOM" || state === "MODULE";
  for (const file of available) if (!late(file.state)) await applyUpdateFile(file);
  for (const file of available) if (late(file.state)) await applyUpdateFile(file);

  const orphans = [...applied.values()].filter((entry) => entry.state !== "MODULE");
  if (orphans.length > 0) {
    const cleanup = info.cleanDeadRefMaxCount < 0 || orphans.length <= info.cleanDeadRefMaxCount;
    for (const entry of orphans) {
      log("sql.updates", `>> The file '${entry.name}' was applied to the database, but is missing in your update directory now!`);
    }
    if (cleanup) {
      await db.$client.unsafe(`DELETE FROM \`updates\` WHERE \`name\` IN (${orphans.map(() => "?").join(", ")})`, orphans.map((entry) => entry.name));
    } else {
      log("sql.updates", `Cleanup is disabled! There were ${orphans.length} dirty files applied to your database, but they are now missing in your source directory!`);
    }
  }

  const summary = `Containing ${recent} new and ${archived} archived updates.`;
  log(
    "sql.updates",
    updated === 0 ? `>> ${info.displayName} database is up-to-date! ${summary}` : `>> Applied ${updated} ${updated === 1 ? "query" : "queries"}. ${summary}`,
  );
  return { updated, recent, archived };
}

/** `UpdateFetcher::GetFileList` over the `updates_include` directories; file names must be unique. */
async function fileList(db: Db, info: UpdaterInfo): Promise<SqlFile[]> {
  const byName = new Map<string, SqlFile>();
  const includes = (await db.$client.unsafe("SELECT `path`, `state` FROM `updates_include`")) as { path: string; state: State }[];
  for (const include of includes) {
    const directory = include.path.startsWith("$") ? info.sourceDirectory + include.path.slice(1) : include.path;
    if (!(await isDirectory(directory))) {
      log("sql.updates", `DBUpdater: Given update include directory "${directory}" does not exist, skipped!`);
      continue;
    }
    for (const path of await sqlFilesIn(directory, true)) {
      const name = basename(path);
      if (byName.has(name)) {
        throw new Error(`Duplicate filename "${path}" occurred. Because updates are ordered by their filenames, every name needs to be unique!`);
      }
      byName.set(name, { path, name, state: include.state });
    }
  }
  return [...byName.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** `Bun.SQL` sends a query as one MySQL packet, which tops out at 16 MiB. */
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * `ApplyFile`: the file as multi-statement queries, like piping it into the `mysql` client. A file above
 * `MAX_BATCH_BYTES` is cut after lines that end in `;`. `mysqldump` escapes newlines inside values, so in the base
 * dumps such a line always ends a statement.
 */
export async function applyFile(db: Db, path: string): Promise<void> {
  const text = await Bun.file(path).text();
  // The dump header sets `SQL_MODE`, `FOREIGN_KEY_CHECKS`, and `NAMES` for the session, so every batch uses one connection.
  const connection = await db.$client.reserve();
  try {
    for (const batch of statementBatches(text)) {
      await connection.unsafe(batch);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string }).code;
    throw new Error(`Applying of file '${path}' failed: ${code ? `${code} ` : ""}${detail}`, { cause: error });
  } finally {
    connection.release();
  }
}

function* statementBatches(text: string): Generator<string> {
  if (text.length <= MAX_BATCH_BYTES) {
    yield text;
    return;
  }
  let start = 0;
  let cut = 0;
  while (cut < text.length) {
    const newline = text.indexOf("\n", cut);
    const end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(cut, end).trimEnd();
    cut = end;
    if (line.endsWith(";") && cut - start >= MAX_BATCH_BYTES) {
      yield text.slice(start, cut);
      start = cut;
    }
  }
  if (start < text.length) {
    yield text.slice(start);
  }
}

async function sqlFilesIn(directory: string, recursive: boolean): Promise<string[]> {
  const files: string[] = [];
  for await (const name of new Glob(recursive ? "**/*.sql" : "*.sql").scan({ cwd: directory, onlyFiles: true })) {
    files.push(join(directory, name));
  }
  return files;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Bun.file(path).stat()).isDirectory();
  } catch {
    return false;
  }
}

function sha1Hex(text: string): string {
  return new CryptoHasher("sha1").update(text).digest("hex").toUpperCase();
}
