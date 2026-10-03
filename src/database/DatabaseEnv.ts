/** `DatabaseEnv.h`: the three global pools (`LoginDatabase`, `CharacterDatabase`, `WorldDatabase`), set at startup. */
import type { Db } from "./database.ts";

const pools: { login: Db | null; characters: Db | null; world: Db | null } = { login: null, characters: null, world: null };

export function setDatabaseEnv(databases: { login?: Db | null; characters?: Db | null; world?: Db | null }): void {
  if (databases.login !== undefined) pools.login = databases.login;
  if (databases.characters !== undefined) pools.characters = databases.characters;
  if (databases.world !== undefined) pools.world = databases.world;
}

function required(db: Db | null, name: string): Db {
  if (!db) throw new Error(`${name} is not open`);
  return db;
}

/** `LoginDatabase` */
export function LoginDatabase(): Db {
  return required(pools.login, "LoginDatabase");
}

/** `CharacterDatabase` */
export function CharacterDatabase(): Db {
  return required(pools.characters, "CharacterDatabase");
}

/** `WorldDatabase` */
export function WorldDatabase(): Db {
  return required(pools.world, "WorldDatabase");
}

export function hasLoginDatabase(): boolean {
  return pools.login !== null;
}
