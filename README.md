# wow-ts

A 1:1 rewrite of [AzerothCore](https://github.com/azerothcore/azerothcore-wotlk) in TypeScript, on [Bun](https://bun.com). The client is World of Warcraft **3.3.5a (build 12340)**.

`azerothcore/` in this folder is the C++ server we are porting. The running server is `src/`. It uses Bun primitives: `Bun.listen`, `Bun.SQL` (MySQL, through drizzle-orm), and `Bun.CryptoHasher`. It does not use Node networking or `Buffer`.

Today you can log in, see the character `Test`, enter Northshire, walk, and see nearby creatures, objects, and other players. See [docs/status.md](docs/status.md) for the full port checklist.

## Run

```bash
bun install
docker compose up -d --wait   # MySQL 8.4 with acore_auth, acore_characters, acore_world
bun index.ts
```

Auth listens on `127.0.0.1:3724`. The world listens on `127.0.0.1:8085`. The databases are AzerothCore's: on the first start the server fills the empty `acore_*` databases from `sql/base/` and applies `azerothcore/data/sql/updates/` (about a minute for the world). `bun run db:update` does the same without starting the servers. After new updates, `bun run gen:db-schema` regenerates the drizzle schema in `src/database/schema/`.

Seeded logins: `TEST` / `TEST` (character `Test`), `TEST2` / `TEST2` (character `Testtwo`), and `TEST3` / `TEST3` (character `Bagtest`). All three are level 1 human warriors in Northshire. `Bagtest` starts with 5 gold and a backpack: linen cloth, spring water, a healing potion, a hearthstone, a worn shortsword, and a small brown pouch.

Point the client realm list at this machine (`realmlist.wtf` should use `127.0.0.1`). Then log in with that account.

`bun --hot index.ts` reloads when a source file changes, without restarting the process. The previous listeners are closed first, and each reload is printed as a `hot` banner.

## Test

```bash
docker compose up -d --wait
bun test
```

Tests that touch the auth or character database use throwaway `acore_test_*` databases on the same MySQL. The first run builds their templates from `sql/base/` in a few seconds.

## Docs

- [Plan](PLAN.md)
- [Status](docs/status.md)
- [Auth](docs/auth.md)
- [Enter world](docs/enter-world.md)
- [Movement](docs/movement.md)
