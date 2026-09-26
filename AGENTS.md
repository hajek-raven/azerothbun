# AGENTS.md

This repo is a 1:1 TypeScript port of [AzerothCore](https://github.com/azerothcore/azerothcore-wotlk) on Bun. The client is World of Warcraft **3.3.5a (build 12340)**.

`azerothcore/` is the C++ and SQL reference. Do not build or run it from here. The server that runs is `src/`.

## Port the whole topic

When a topic is in scope, port it completely. A half-baked slice that only covers the packets or columns needed for the current demo is not a port.

A topic is one AzerothCore system (auth, characters, creatures, game objects, items, spells, quests, and so on), including the tables, loaders, and server behavior that system owns.

- Read the C++ and the SQL in `azerothcore/` before writing the TypeScript.
- Bring over the full behavior of that system, not a stub that is "enough to log in" or "enough to spawn one row."
- Related tables that the system reads belong in the same port. Do not leave them for a later pass.
- Wire the data through types, queries, and packets. A column that exists only in SQLite and is never loaded is unfinished.
- Behavior that the client never sees yet still gets stored and loaded. The schema and the data path come first; feature flags do not justify dropping fields.

## SQL

Every table matches AzerothCore. Source of truth is `azerothcore/data/sql/base/` plus every later `ALTER` in `azerothcore/data/sql/updates/` that still applies to that table.

- Copy every column, default, and index. Do not invent a reduced table, a hand-picked subset, or a `TEXT` blob in place of columns.
- Keep AzerothCore column names. Translate types: integer kinds to `INTEGER`, `float` / `double` to `REAL`, string kinds to `TEXT`, binary to `BLOB`.
- Do not drop a column because the current packet or the current feature does not read it.
- Do not rename columns to a shorter shape (`entry` instead of `id1`, `health` instead of `curhealth`) unless the AzerothCore name is preserved alongside it. Prefer the AzerothCore name.
- `CREATE TABLE` in `src/` is the live schema. When a table is wrong or partial, replace it with the full column list instead of adding one more field to the shortcut.

Do not migrate an old SQLite file. `CREATE TABLE IF NOT EXISTS` does not change columns that are already there. Delete `data/*.sqlite` and let the server create the schema again.

`data/world.sqlite` is filled from the dumps in `sql/base/db_world/` (a copy of `azerothcore/data/sql/base/db_world/`). Every table and every row from those files is loaded. The spawn list the server shows follows `ObjectMgr`, `GameEventMgr`, and `PoolMgr`:

- Import every map. Do not clip spawns to a coordinate box. In this dump `creature.zoneId` and `areaId` are 0, so they cannot locate Northshire or anything else.
- A stored `phaseMask` of 0 is shown as 1. Keep `spawnMask` and `phaseMask`, including dungeon bits. Do not drop a row because it is not phase 1 or spawn-mask bit 0.
- A positive `game_event_creature`, `game_event_gameobject`, or `game_event_pool` id is not in the default spawn set. Negative event ids stay visible (they are present while the holiday is off). Rows with no event stay. The hidden rows remain in the database.
- A pool shows `pool_template.max_limit` members. `0` means no limit. Sort by chance descending, then guid ascending. The other members remain in the database.
- Hide a creature spawn whose template is missing, or whose `creature_template_model` rows have no `CreatureDisplayID` > 0. Keep the template anyway.
- Hide a gameobject spawn whose template is missing or whose `displayId` is 0. Keep the template anyway, including `displayId` 0.

Display ids are `creature_template_model`, not columns on `creature_template`. Bounds and gender are `creature_model_info`. Equipment is `creature_equip_template`. Spawn entry is `creature.id1`. `curhealth` and `curmana` stay those columns.

## Bun

Use Bun. Do not use Node.js, npm, pnpm, yarn, or Vite.

- `bun <file>` instead of `node` or `ts-node`
- `bun test` instead of Jest or Vitest
- `bun install` instead of npm, yarn, or pnpm
- `bun run <script>` and `bunx <package>` instead of npm scripts and npx
- Bun loads `.env`. Do not use dotenv.
- `Bun.listen` for the auth and world sockets. Do not use Node `net` or the `ws` package.
- `bun:sqlite` for SQLite. Do not use `better-sqlite3`.
- `Bun.CryptoHasher` for hashes. Do not pull in extra crypto packages.
- `Bun.file` instead of `node:fs` readFile / writeFile.
- Do not use Node `Buffer`.

Tests live next to the code and run with `bun test`. API details are in `node_modules/bun-types/docs/**.mdx`.
