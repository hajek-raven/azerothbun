# Maps, grids, terrain, vmaps, and mmaps port

Working contract for the "Maps and visibility" topic of `docs/status.md`. Every stream below ports a slice of
`azerothcore/` into `src/` under the rules of `AGENTS.md` and `docs/porting-workflow.md`: C++-mirrored paths, C++ names
(camelCase methods), `@ac <path> <Class::Function>` tags, no invented behavior.

## Data layout (same files and formats as AzerothCore, so extractor output from either side works)

`DataDir` is `data` (`serverDataPath`). The files are gitignored.

| Directory | Files | Written by | Read by |
| --- | --- | --- | --- |
| `data/dbc/` | `*.dbc` | `src/tools/extract-dbc.ts` (done) | `loadDBCStores` |
| `data/maps/` | `MMMXXYY.map` (`MMM` = map id, `XX` = grid x, `YY` = grid y, all zero padded) | `src/tools/map_extractor/` | `GridTerrainLoader` |
| `data/vmaps/` | `*.vmtree`, `*.vmtile`, `*.vmo`, `GameObjectModels.dbc`-style model list | `src/tools/vmap4_extractor/` then `src/tools/vmap4_assembler/` | `VMapMgr2`, `GameObjectModel` |
| `data/mmaps/` | `MMM.mmap`, `MMMXXYY.mmtile` | `src/tools/mmaps_generator/` | `MMapMgr` |

The client is `~/GAMES/ChromieCraft_3.3.5a` (3.3.5a build 12340, `enUS`). Extractor tools take the client directory as an
argument, never a hard-coded path. Do not copy client data into the repo outside `data/`.

## Modules and owners

| Module | Path | C++ source | Notes |
| --- | --- | --- | --- |
| MPQ reader | `src/tools/mpq.ts` | `deps/libmpq` | random-access reads (archives are up to 4 GB), all compressions, patch chain |
| Terrain data | `src/game/Grids/GridTerrainData.ts`, `GridTerrainLoader.ts` | `game/Grids/GridTerrain*.{h,cpp}` | `.map` reader, height, area, liquid, holes |
| Map extractor | `src/tools/map_extractor/` | `tools/map_extractor` | MPQ to `.map` |
| Math | `src/math/` | `deps/g3dlite` (the subset the Collision code uses) | `Vector3`, `AABox`, `Ray`, `Matrix3`, ... |
| VMaps runtime | `src/common/Collision/**` | `common/Collision` | BIH, `WorldModel`, `ModelInstance`, `StaticMapTree`, `VMapMgr2`, `DynamicMapTree`, `GameObjectModel`, `TileAssembler` |
| VMap extractor | `src/tools/vmap4_extractor/`, `src/tools/vmap4_assembler/` | `tools/vmap4_*` | MPQ to raw model dumps, then `TileAssembler` |
| Detour and paths | `src/common/Detour/**`, `src/common/Collision/Management/MMapMgr.ts`, `src/game/Movement/MovementGenerators/PathGenerator.ts` | `deps/recastnavigation/Detour`, `MMapMgr`, `PathGenerator` | runtime only |
| Recast and generator | `src/common/Recast/**`, `src/tools/mmaps_generator/` | `deps/recastnavigation/Recast`, `tools/mmaps_generator` | writes `data/mmaps/` |
| Objects | `src/game/Entities/Object/**` | `Entities/Object` | `Position`, `WorldObject` (map, phase, zone, visibility parts) |
| Grids | `src/game/Grids/**` (except terrain) | `game/Grids` | `Cell`, `MapGrid`, `MapGridManager`, `GridObjectLoader`, notifiers |
| Maps | `src/game/Maps/**` | `game/Maps` | `Map`, `InstanceMap`, `BattlegroundMap`, `MapMgr`, `MapInstanced`, `MapUpdater`, respawns |
| Integration | `src/world/*`, `src/combat/*`, `src/game/Entities/*` | `Player`/`Creature` visibility | done: `session-map-player.ts`, `session-map.ts`, `map-world.ts` replace the `spawn.ts` cell index and `PlayerView.sync` |

## Contracts between modules (names are the C++ names)

- Terrain: `GridTerrainData` (`getHeight(x, y)`, `getMinHeight`, `getArea`, `getLiquidData`, `getFullTerrainStatusForPosition`,
  `LiquidData`, `ZLiquidStatus`, `PositionFullTerrainStatus`, `INVALID_HEIGHT`, `MAX_HEIGHT`, `DEFAULT_HEIGHT_SEARCH`).
- VMaps: this AzerothCore revision has no per-call `VMapMgr2.loadMap/isInLineOfSight/getHeight`. Each `Map` owns a
  `MapCollisionData` (`game/Maps/MapCollisionData.{h,cpp}`, ported by the Maps stream) holding a `StaticMapTree` and a
  `DynamicMapTree`; it does the coordinate conversion and the disable checks. `src/common/Collision/` provides
  `VMapFactory.createOrGetVMapMgr()`, `VMapMgr2`, `StaticMapTree` (`InitMap`, `LoadMapTile`, `UnloadMapTile`,
  `isInLineOfSight`, `GetObjectHitPos`, `getHeight`, `GetLocationInfo`), `ModelInstance.GetLiquidLevel`,
  `DynamicMapTree` (`insert/remove/contains`, `getHeight`, `isInLineOfSight`, `GetObjectHitPos`, `GetAreaAndLiquidData`),
  `GameObjectModel`, `ModelIgnoreFlags`. C++ `float&` out parameters are `{ value: number }` (`FloatRef`).
- MMaps: `MMapFactory.createOrGetMMapMgr(): MMapMgr` (`loadMap`, `loadMapInstance`, `unloadMap`, `GetNavMesh`,
  `GetNavMeshQuery`), `PathGenerator` (`calculatePath`, `getPath`, `getPathType`, `getActualEndPosition`, `setUseStraightPath`...).
- Objects are plain TypeScript classes: `Position`, `WorldLocation`, `Object`, `WorldObject`. `WorldObject` always reads
  its position through `getPositionX()` / `getPositionY()` / `getPositionZ()` / `getOrientation()`, never through the
  field, because `SessionPlayer` overrides them to read the character row. GUIDs stay `bigint`.
- A `Map` knows `GridTerrainData` per grid, `VMapMgr2` (global), `MMapMgr` (global), and `DynamicMapTree` per map
  (through `MapCollisionData`).
- Tests for binary formats use hand-built fixtures (written by a test helper that mirrors the C++ writer) and, where the real
  client data exists in `data/`, a second test file `*.data.test.ts` that skips itself when the file is missing.

## Rules for every stream

1. Read the C++ before writing TS. Port every function of the files you own, in file order, with the C++ name and an
   `@ac` tag. Where a dependency belongs to a topic that is not ported yet (Weather, Transport, Battleground, scripts,
   instance saves, ...), keep the method with the C++ signature and make the call site a documented no-op or a
   typed hook, and mark it `@ac-skip <reason>` in the docblock. Never drop a function silently.
2. Match the style of the surrounding code (two-space indent, double quotes, `.ts` import extensions, `bigint` guids).
   Use Bun APIs (`Bun.file`, `Bun.mmap`, `Bun.inflateSync`, `DataView`), no Node `Buffer`, no `node:fs` readFile.
   `node:fs` directory listing and `node:path` are fine (the existing tools use them).
3. Binary readers use `DataView` over a `Uint8Array` (or `Bun.mmap`); no per-sample object allocation in hot paths
   (height lookups, BIH traversal, Detour queries run per movement packet).
4. Floats: C++ `float` is 32 bit. Where results are written to files or compared against C++ (extractors, generators),
   use `Math.fround` at the same places the C++ truncates; in runtime queries plain doubles are fine.
5. Do not edit files you do not own. If you need a change in a shared file (`world-config-data.ts`, `DBCStores.gen.ts`,
   `session.ts`, ...), say so in your final report instead, unless the integration stream owns it.
6. Tests live next to the code and run with `bun test <file>`. Run only your own test files while other streams are
   working in the same tree; the full `bun test` and `bunx tsc --noEmit -p .` are run by the integrator. `bunx tsc` must
   pass for your files (the whole project typechecks today).
7. Do not run `git commit`, `git stash`, `git checkout`, or anything else that changes the index or other people's files.
   The working tree holds uncommitted work from other streams.
8. Do not build or run anything under `azerothcore/`.
9. Final report: files created, what is ported and what is `@ac-skip` (with reasons), test results, how the real-data
   verification went, and anything the next stream must know.

## mmaps generator

`bun src/tools/mmaps_generator/PathGenerator.ts [map] [--tile x,y] [--threads n] [--config f] [--file f] [--silent]` reads
`data/maps` and `data/vmaps` and writes `data/mmaps/MMM.mmap` + `MMMXXYY.mmtile` (tile file name is `MMMYYXX` as in the C++
`MapBuilder`; `--tile 32,48` is Northshire on map 0). Settings come from `src/tools/mmaps_generator/mmaps-config.yaml` (`dataDir`
is `data`). Worker threads are Bun `Worker`s (`TileBuilderWorker.ts`). Byte equality with C++-generated tiles is unverified.

## Integration (what the server does with the map layer)

- Startup (`startMapSystem`, `src/game/Maps/MapSetup.ts`): hooks, `vmap.*` / `MoveMaps.Enable` / `DataDir`, the `disables` table (`DisableMgr`),
  spawn stores, respawn times, instance ids, update interval. `World::Update` runs `MapMgr::Update` after the sessions.
- A session's player is a `SessionMapPlayer` (`src/world/session-map-player.ts`): login and the far teleport put it on its map
  (`Map::AddPlayerToMap`), a movement packet is `Map::PlayerRelocation`, logout and the start of a far teleport remove it. What it
  sees comes from the grid notifiers; creatures and gameobjects are `GridObjectLoader` objects whose create blocks are the ones of
  `spawn.ts` (`map-world.ts`). Login and teleports show the world at once (a deviation from the 150-300 ms delay); movement uses
  the delay (`DynamicVisibilityMgr`).
- Creatures and gameobjects of the grids have the low guid `spawn id` (`Creature.dbGuidLow`), because combat, gossip, vendors and loot
  address them by `entry << 24 | spawn id`. The combat code keeps the live state of a creature (`CreatureUnit`); `Creature.m_combatUnit`
  links it to the map object. The `MotionMaster` of the map object moves it (`Map::CreatureRelocation` from `Unit::UpdateSplinePosition`) and
  the combat state reads the position from it (`docs/movement-port.md`).
- Not done: instances share nothing yet (no `InstanceSaveMgr`: every dungeon entry makes a new instance), `Player::UpdateVisibilityOf`
  skips `GetInitialVisiblePackets`, corpses are not visible objects, group visibility, weather, `spell_area` auras.
