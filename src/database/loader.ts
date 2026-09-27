import type { ConfigMgr } from "../common/config.ts";
import { openDatabase, parseDatabaseInfo, type Databases, type Db } from "./database.ts";
import {
  DATABASE_CHARACTER,
  DATABASE_LOGIN,
  DATABASE_WORLD,
  populateDatabase,
  updateDatabase,
  type UpdaterInfo,
} from "./updater.ts";

type Entry = {
  key: "login" | "characters" | "world";
  displayName: string;
  infoKey: string;
  defaultInfo: string;
  poolKey: string;
  flag: number;
  base: string;
};

const ENTRIES: Entry[] = [
  { key: "login", displayName: "Login", infoKey: "LoginDatabaseInfo", defaultInfo: "127.0.0.1;3306;acore;acore;acore_auth", poolKey: "LoginDatabase.WorkerThreads", flag: DATABASE_LOGIN, base: "db_auth" },
  { key: "characters", displayName: "Character", infoKey: "CharacterDatabaseInfo", defaultInfo: "127.0.0.1;3306;acore;acore;acore_characters", poolKey: "CharacterDatabase.WorkerThreads", flag: DATABASE_CHARACTER, base: "db_characters" },
  { key: "world", displayName: "World", infoKey: "WorldDatabaseInfo", defaultInfo: "127.0.0.1;3306;acore;acore;acore_world", poolKey: "WorldDatabase.WorkerThreads", flag: DATABASE_WORLD, base: "db_world" },
];

/**
 * `DatabaseLoader`: open each pool, fill an empty database from `sql/base/` (`Updates.AutoSetup`),
 * then apply `data/sql/updates/` (`Updates.EnableDatabases`). `authserver` asks only for the login database.
 */
export async function loadDatabases<K extends keyof Databases>(
  config: ConfigMgr,
  wanted: readonly K[],
  baseDirectory = "sql/base",
): Promise<Pick<Databases, K>> {
  const autoSetup = config.getBool("Updates.AutoSetup", true);
  const enabled = config.getUInt("Updates.EnableDatabases", 7);
  const opened: Partial<Databases> = {};
  for (const entry of ENTRIES) {
    if (!wanted.includes(entry.key as K)) {
      continue;
    }
    const info = parseDatabaseInfo(config.getString(entry.infoKey, entry.defaultInfo));
    // Login and character pools keep one connection whatever `*.WorkerThreads` says, so writes queued with
    // `executeAsync` run in order and before later reads. The world pool only serves startup loads, which run side by side.
    const workers = Math.max(1, config.getInt(entry.poolKey, 1));
    const db: Db = openDatabase(info, entry.key === "world" ? Math.max(workers, 8) : 1);
    const updater: UpdaterInfo = {
      displayName: entry.displayName,
      baseFilesDirectory: `${baseDirectory}/${entry.base}`,
      sourceDirectory: config.getString("SourceDirectory", "") || "azerothcore",
      redundancy: config.getBool("Updates.Redundancy", true),
      allowRehash: config.getBool("Updates.AllowRehash", true),
      archivedRedundancy: config.getBool("Updates.ArchivedRedundancy", false),
      cleanDeadRefMaxCount: config.getInt("Updates.CleanDeadRefMaxCount", 3),
    };
    if (autoSetup) {
      await populateDatabase(db, updater);
    }
    if ((enabled & entry.flag) !== 0) {
      await updateDatabase(db, updater);
    }
    opened[entry.key] = db;
  }
  return opened as Pick<Databases, K>;
}
