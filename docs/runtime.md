# Runtime

Phase 0 starts here: configuration, game time, and the world tick. Maps, auras, and scripts are not on the tick yet.

## Config

`configs/worldserver.conf.dist` and `configs/authserver.conf.dist` are the AzerothCore dist files. On startup the server loads `configs/worldserver.conf` when that file exists, and the `.dist` file otherwise. Auth does the same with `configs/authserver.conf`.

The loader follows `ConfigMgr`:

- `key = value`, `#` comments, `[section]` headers ignored
- `"` stripped from values
- the first duplicate key in a file wins
- `AC_SOME_CONFIG` overrides `SomeConfig` (`LogDB.Opt.ClearTime` becomes `AC_LOG_DB_OPT_CLEAR_TIME`)
- Bun loads `.env` into the environment before startup, so `AC_` keys there override the file
- `--config-policy` and `AC_CONFIG_POLICY` use the same severity names as AzerothCore (`skip`, `warn`, `error`, `fatal`)

Every `SetConfigValue` in `WorldConfig.cpp` is loaded, including the range checks. A value that fails its check is replaced with the C++ default. `WorldServerPort`, `GameType`, `RealmZone`, `MaxPlayerLevel`, `Expansion`, `Wintergrasp.KickVoAPlayers`, and `AuctionHouse.WorkerThreads` stay at the value from process start when the config is reloaded.

Auth options the auth server reads (`RealmServerPort`, `BindIP`, wrong-password limits, and the rest of that list) are loaded from the auth file. The process still stores accounts in `data/auth.sqlite`. `LoginDatabaseInfo` is kept as a config value and is not a MySQL connection.

## Time and the world tick

`World.update(diff)` updates game time, the shutdown countdown, and the world interval timers, then records the diff in `WorldUpdateTime`. The loop sleeps until `MinWorldUpdateTime` milliseconds have passed, same as `WorldUpdateLoop`. Each tick is one `setTimeout`, so sockets, the console, and signals run between ticks on the same event loop where AzerothCore uses network, CLI, and signal threads.

`SIGINT` and `SIGTERM` call `World.stopNow(0)`, same as `SignalHandler`. The loop then closes the listeners, which saves every character still online, closes the databases, and exits with the world exit code.

## Event loop

- Packets are handled in the socket `data` handler. There is no receive queue as in `WorldSession::Update`.
- Bun sockets do not buffer writes. `SocketBuffers` joins the packets of one event-loop turn and writes them once, like `WorldSocket::Update`. A socket closed after a reply writes the reply first, like `DelayedCloseSocket`. `Network.TcpNodelay` is applied to world sockets.
- `bun:sqlite` is synchronous and runs on the loop. `data/auth.sqlite` uses WAL with `synchronous = NORMAL`, so a commit does not wait for `fsync`. SQLite leaves `-wal` and `-shm` files next to the database until it closes; delete them along with `data/*.sqlite`.
- A dropped connection saves the character, same as `LogoutPlayer(true)` from `~WorldSession`.
- Idle connections use `socket.timeout()`, reset where `ResetTimeOutTime` is called: after `CMSG_AUTH_SESSION`, and on every opcode except `CMSG_PING` and `CMSG_WARDEN_DATA`. In the world the timeout is `SocketTimeOutTimeActive`; on character select it is `SocketTimeOutTime`. `CMSG_KEEP_ALIVE` resets only in the world. Bun checks socket timeouts every 4 seconds, and the server closes the socket in the `timeout` handler (Bun does not). No RBAC is ported yet, so `RBAC_PERM_IGNORE_IDLE_CONNECTION` does not exempt anyone.

`server shutdown <time> [exitcode] [reason]` and `server shutdown cancel` run from stdin when `Console.Enable` is on. Lines come from Bun's `console` async iterator. One reader lives for the whole process, and `bun --hot` swaps its handler. `account create <name> <password> [email]` writes an account the way `AccountMgr::CreateAccount` does: Latin letters uppercased, SRP6 salt and verifier, and a `realmcharacters` row. A leading `.` is accepted.

The tick does not yet update maps, sessions, auctions, mail, game events, or scripts. Those timers still advance and reset on their configured intervals.

## Common helpers

`src/common/` has the runtime pieces creatures, spells, and scripts schedule work with:

- SFMT-19937 (`SfmtEngine`) with the same sequence as `sfmt_init_gen_rand` / `sfmt_init_by_array`. `urand` / `irand` use the libstdc++ `uniform_int_distribution` rejection loop. `frand`, `randNorm`, and `randChance` use `generate_canonical`.
- `EventProcessor` and `EventMap` (phases 1–8, groups, repeat, delay, cancel).
- `TaskScheduler` (`schedule`, `repeat`, groups, async callbacks, validator).
- `TimeTracker`, `TimeTrackerSmall`, `PeriodicTimer`, and `Acore::Time::ToTimeString`.
- Util helpers used by names, money strings, hex, addresses, and `flag96`.

`seedRandom` replaces the process generator. The default generator is seeded from `crypto.getRandomValues`, same as `std::random_device` when it reports entropy.
