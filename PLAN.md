# Plán: zbytek AzerothCore do Bun TypeScriptu

Tento dokument popisuje, jak převedeme zbytek `azerothcore/` do `src/` jako nativní TypeScript na Bunu. Pravidla z [AGENTS.md](AGENTS.md) platí beze změny: jedno téma se portuje celé, tabulky 1:1 s AzerothCore, jen Bun API. Stav po jednotlivých položkách vede [docs/status.md](docs/status.md); tento plán určuje pořadí a způsob.

## Kde jsme

Hotové je přihlášení (SRP6, realm list), výpis, vytvoření a smazání postavy, vstup do světa, pohyb hráče, viditelnost creatures, gameobjectů a hráčů, gossip, questy a databáze AzerothCore v MySQL (`acore_auth`, `acore_characters`, `acore_world`) plněné portem `DBUpdater`. To je asi 16,5 tisíce řádků TS.

Zbývá zhruba 700 tisíc řádků C++ (bez `deps/`). Hrubé rozdělení:

| Oblast v `azerothcore/src` | Řádků C++ |
| --- | --- |
| `server/scripts/` (zóny, instance, spell skripty, příkazy, eventy) | ~305 000 |
| `server/game/Entities/` (Unit, Player, Creature, GameObject, Item, Pet…) | ~89 000 |
| `server/game/Spells/` | ~45 000 |
| `server/game/Handlers/` | ~23 000 |
| `common/` (kolize, navigace, config, utility) | ~25 000 |
| `server/game/Battlegrounds/` + `Battlefield/` + `OutdoorPvP/` | ~27 000 |
| `server/game/AI/` | ~20 000 |
| `server/game/Globals/` (ObjectMgr, ObjectAccessor) | ~13 500 |
| `server/game/Server/` + `server/shared/` | ~25 000 |
| ostatní systémy v `server/game/` | ~60 000 |
| `tools/` (extraktory map, vmap, mmap) | ~9 500 |

## Co znamená „nativně“

Každá C++ závislost má náhradu v Bunu, nebo ji napíšeme v TS. Žádné FFI na C++ knihovny AzerothCore, žádný Node.

| C++ závislost | Náhrada |
| --- | --- |
| Boost.Asio, sockety, `WorldSocketMgr` | `Bun.listen` (už běží) |
| MySQL, `DatabaseWorkerPool`, prepared statements | MySQL z `docker compose`, `Bun.SQL` + drizzle-orm (`drizzle-orm/bun-sql/mysql`), `db.transaction` |
| OpenSSL (SRP6, ARC4, HMAC, SHA1) | `Bun.CryptoHasher` + vlastní ARC4 (už běží) |
| zlib (komprese `SMSG_COMPRESSED_*`, addon info) | `Bun.deflateSync` / `Bun.inflateSync` |
| Boost.Thread, `MapUpdater` vlákna | jedno vlákno a `World.update(diff)`; `Worker` až když to změříme |
| fmt, Boost.Format | template stringy |
| G3D (vektory, BIH, kvaterniony) | vlastní malý `src/math/` |
| Recast/Detour (`mmaps`) | port runtime části Detour (`dtNavMesh`, `dtNavMeshQuery`) do TS |
| libmpq, bzip2 (extraktory) | MPQ čtečka v TS; bzip2 dekodér v TS (jen v nástrojích) |
| SFMT (RNG) | port SFMT, aby se hody chovaly stejně |
| readline, ACSoap, RemoteAccess | konzole přes `process.stdin` v Bunu, RA přes `Bun.listen`, SOAP přes `Bun.serve` |
| argon2, gsoap, jemalloc, gperftools | nepotřebujeme |

`TC9Sidecar/` (gRPC sidecar pro ToCloud9) do upstreamové hry 3.3.5a nepatří. Rozhodneme o něm zvlášť, až bude hotová Fáze 6.

## Architektura v `src/`

Adresáře kopírují moduly AzerothCore, aby se C++ soubor dal vždycky dohledat:

```text
src/
  common/        Config, Log, Util, Random (SFMT), Timer, EventProcessor
  math/          Vector3, Quat, AABox, BIH (z G3D a Collision)
  crypto/        už existuje
  net/           ByteBuffer, už existuje
  database/      tři MySQL pooly, DBUpdater, generované drizzle schéma, WorldTables
  shared/        SharedDefines, DBC formáty a struktury, Realms
  game/
    accounts/ achievements/ ai/ auction/ battlegrounds/ battlefield/
    calendar/ chat/ combat/ conditions/ datastores/ dungeon-finding/
    entities/{object,unit,player,creature,gameobject,item,pet,totem,
              corpse,dynamic-object,transport,vehicle}/
    events/ globals/ grids/ groups/ guilds/ handlers/ instances/ loot/
    mails/ maps/ movement/ outdoor-pvp/ petitions/ pools/ quests/
    reputation/ scripting/ server/ skills/ spells/ texts/ tickets/
    time/ warden/ weather/ world/
  scripts/       obsah: commands/, spells/, world/, pet/, events/,
                 eastern-kingdoms/, kalimdor/, outland/, northrend/, outdoor-pvp/
  collision/     vmaps, terrain (.map), Detour
  tools/         extraktory map/vmap/mmap (poslední fáze)
```

Stávající `src/world/`, `src/characters/` a `src/data/` postupně přestěhujeme pod `src/game/` ve chvíli, kdy dané téma portujeme celé. Nestěhuje se nic jen kvůli přejmenování.

### Klíčová rozhodnutí

- **Tři databáze** jako v AzerothCore: `acore_auth`, `acore_characters`, `acore_world` v MySQL. Schéma i data dělá `DBUpdater` z `sql/base/` a `data/sql/updates/`; drizzle schéma v `src/database/schema/` se generuje z živé DB.
- **Schéma se nepíše ručně.** Dumpy a updaty se aplikují do MySQL beze změny a `bun run gen:db-schema` z nich vytáhne drizzle tabulky s AC jmény sloupců. V `src/` není žádné `CREATE TABLE`.
- **Jedno vlákno, pevný tick.** `World.update(diff)` volá `MapMgr.update(diff)` a ten volá mapy, gridy, objekty, sessions a eventy ve stejném pořadí jako `World::Update` a `Map::Update`. `acore_world` se načte při startu do `WorldTables` a čte se synchronně jako cache `ObjectMgr`. Dotazy na `acore_auth` a `acore_characters` jsou `await`; zápisy z ticku jdou přes `executeAsync` do poolu s jedním spojením, takže zůstává pořadí jako u `CharacterDatabase.Execute`.
- **Třídy 1:1.** `Object → WorldObject → Unit → Player/Creature`, `GameObject`, `Item → Bag`. Jména metod zůstanou jako v C++ (`Unit.DealDamage` se v TS jmenuje `dealDamage`). Update fieldy jsou jedno pole `Uint32Array` podle `UpdateFields.h`, stejně jako `m_uint32Values`.
- **ObjectGuid** je hodnota ze dvou `uint32` (high a low) s pomocnými funkcemi z `ObjectGuid.h`. `bigint` jen tam, kde se 64bitová hodnota ukládá celá.
- **Enumy** z `SharedDefines.h`, `UnitDefines.h`, `SpellDefines.h` a dalších se převedou jako `const enum`, nebo jako objekty `as const`. Každý `switch` nad nimi končí kontrolou `never`.
- **Skripty** se registrují jménem. `ScriptMgr` čte `ScriptName` z `creature_template`, `gameobject_template`, `spell_script_names`, `instance_template` a `areatrigger_scripts` a najde k němu TS třídu. Hooky (`PlayerScript`, `WorldScript`, `UnitScript`…) mají stejná jména jako v `ScriptObject.h`.

## Postup u jednoho tématu

Každé téma (například „Loot“ nebo „Guildy“) se dělá stejně:

1. Přečíst všechny `.cpp` a `.h` systému a jeho handler v `Handlers/`, packety v `Server/Packets/` a opcody v `Protocol/Opcodes.cpp`.
2. Sepsat tabulky, které systém čte a zapisuje, v `db_world`, `db_characters` i `db_auth`, včetně pozdějších `ALTER` v `updates/`.
3. Převést loader (`ObjectMgr::Load*`, `*Mgr::Load*`) a zapojit ho do startu ve stejném pořadí jako `World::SetInitialWorldSettings`.
4. Převést runtime chování a handlery všech opcodů systému.
5. Napsat testy vedle kódu (`*.test.ts`): parsování packetů bajt po bajtu proti známým dumpům a logiku proti `WorldTables.fromRows` / `worldFromSql` a proti testovacím `acore_test_*` databázím v MySQL.
6. Ověřit v klientu 3.3.5a.
7. Odškrtnout řádky v `docs/status.md` a aktualizovat příslušný dokument v `docs/`.

## Fáze

Pořadí určují závislosti. Na konci každé fáze musí server nastartovat, `bun test` projít a klient musí jít přihlásit.

### Fáze 0: Základ runtime

Bez toho nejde nic dalšího.

- `Configuration/` a `worldserver.conf.dist` / `authserver.conf.dist`: loader konfigurace (soubor + proměnné prostředí z `.env`), všechny klíče z `WorldConfig.cpp` s výchozími hodnotami.
- `Time/`: `GameTime`, `UpdateTime`; `World.update(diff)` jako hlavní smyčka.
- `common/`: `EventProcessor`, `EventMap`, `TaskScheduler`, `Timer`, `Random` (SFMT), `Util`.
- `database/`: hotovo — tři MySQL pooly, port `DBUpdater` (`updates`, `updates_include`), generované drizzle schéma. Zbývá port prepared statements z `*Database.cpp`.
- Postavy jsou v `acore_characters` s plným `db_characters` (hotovo).
- `DataStores/` a `shared/DataStores`: všechny DBC z `DBCStores.cpp` a formáty z `DBCfmt.h`, ne jen sedm současných. Doplnit `sql/base/db_world` tabulky `*_dbc`, které DBC přepisují.
- `SharedDefines`, `ObjectGuid`, `Position`, `UpdateFields`.
- `World`: `SetInitialWorldSettings` jako jedna startovací sekvence, `WorldSessionMgr`, fronta přihlášení, kick, shutdown.
- Konzole: čtení příkazů ze stdin (zatím jen `server shutdown` a `account create`).

### Fáze 1: Mapy, gridy a terén

- `Grids/`: `MapGrid`, `GridCell`, `Cell`, `GridObjectLoader`, notifiers (`VisibleNotifier`, `MessageDistDeliverer` a další).
- `Maps/`: `Map`, `MapInstanced`, `MapMgr`, `MapUpdater` (jednovláknově), `TransportMgr`, `AreaBoundary`.
- `Globals/ObjectAccessor`: vyhledání hráče a objektu podle GUID.
- Terén: čtení `.map` souborů (výška, voda, oblast) podle `GridTerrainData`.
- `common/Collision`: vmapy (`VMapMgr2`, `BIH`, `DynamicTree`, modely) pro line of sight a výšku uvnitř budov.
- `common/Navigation` a Detour: runtime čtení `.mmap` / `.mmtile` a hledání cesty.
- Viditelnost podle `DynamicVisibility`, fáze z aur a questů, spawn módy (heroic, 10, 25), aktivní objekty, načítání a uvolňování gridů.
- `GameEventMgr` a `PoolMgr` za běhu: zapínání eventů podle času, nový výběr z poolu po smrti.
- Respawn časy v `creature_respawn` a `gameobject_respawn`.

Data `dbc/`, `maps/`, `vmaps/` a `mmaps/` zpočátku bereme z extraktorů AzerothCore spuštěných mimo toto repo. Porty extraktorů jsou ve Fázi 9.

### Fáze 2: Entity

- `Object`, `WorldObject`, `UpdateData`, `UpdateMask`: plné create a values update bloky pro všechny typy.
- `Unit` (`Unit.cpp`, `StatSystem.cpp`, `CharmInfo`): staty, power, stavy, frakce a nepřátelství z `FactionTemplate.dbc`.
- `Player` po souborech: `Player.cpp`, `PlayerStorage.cpp` (inventář), `PlayerQuest.cpp`, `PlayerGossip.cpp`, `PlayerTaxi.cpp`, `PlayerUpdates.cpp`, `PlayerMisc.cpp`, `PlayerSettings.cpp`, `KillRewarder`, `CinematicMgr`, `SocialMgr`, `TradeData`. Načtení a uložení všech `character_*` tabulek v `Player::LoadFromDB` a `SaveToDB`, periodický save.
- `Creature` (`Creature.cpp`, `CreatureGroups`, `TemporarySummon`, `Trainer`, `GossipDef`), `creature_addon` a `creature_template_addon`.
- `GameObject` se všemi typy (dveře, truhly, pasti, rybaření, rituály, destruktibilní budovy), `gameobject_addon`.
- `Item`, `Bag`, `ItemEnchantmentMgr`: instance předmětů v `item_instance`.
- `Corpse`, `DynamicObject`, `Pet`, `Totem`, `Transport`, `Vehicle`.

### Fáze 3: Pohyb

- `Movement/Spline`: `MoveSpline`, `MoveSplineInit`, `PacketBuilder`.
- `MotionMaster` a všechny generátory v `MovementGenerators/` (idle, random, waypoint, point, home, follow, chase, flee, confused, formation, escort).
- `PathGenerator` nad Detourem z Fáze 1.
- `Waypoints/`: `waypoint_data`, `waypoints`, formace (`creature_formations`).
- Anticheat pohybu tak, jak ho dělá `MovementHandler.cpp`, včetně transportů jako moveru.

### Fáze 4: Spelly, aury a boj

Největší jednotlivý celek. Spelly a boj jdou spolu, protože jeden bez druhého nejde otestovat.

- `SpellInfo`, `SpellInfoCorrections`, `SpellMgr` a všechny `spell_*` tabulky (`spell_proc`, `spell_linked_spell`, `spell_bonus_data`, `spell_area`, `spell_group`, `spell_ranks` a další).
- `Spell.cpp`: příprava, cast time, GCD, přerušení, pushback, cíle, dosah, line of sight.
- `SpellEffects.cpp`: všechny efekty z `SpellEffIndex`.
- `Auras/`: `SpellAuras`, `SpellAuraEffects`, všechny typy aur, stacky, trvání, exkluzivní skupiny, procy.
- `SpellScript` / `AuraScript` framework.
- `Combat/`: `CombatManager`, `ThreatManager`; melee útoky, hit tabulka, armor, resisty, resilience, `Formulas.cpp`.
- `Loot/`: `LootMgr`, všechny `*_loot_template`, referenční loot, skupiny, pravidla lootu, `LootItemStorage`.
- `Conditions/`: `ConditionMgr` a `DisableMgr` (podmínky potřebuje loot, gossip, spelly i SmartAI).
- Combat log packety (`CombatLogPackets`), duely.

### Fáze 5: AI a skriptovací jádro

- `AI/`: `CreatureAI`, `CreatureAISelector`, `CoreAI` (`GuardAI`, `PetAI`, `TotemAI`, `ReactorAI`, `PassiveAI`, `GameObjectAI`), `ScriptedAI` (`ScriptedCreature`, `ScriptedEscortAI`, `ScriptedFollowerAI`).
- `SmartScripts/`: `SmartAI`, `SmartScript`, `SmartScriptMgr` nad `smart_scripts`. Tohle rozhýbe většinu NPC bez jediného C++ skriptu.
- `Scripting/`: `ScriptMgr`, všechny typy `ScriptObject`, `MapScripts` (`event_scripts`, `spell_scripts`, `waypoint_scripts`), `ScriptSystem`.
- `Texts/`: `CreatureTextMgr`, `ChatTextBuilder`, `broadcast_text`.
- `Modules/ModuleMgr`: stejný registr pro moduly jako v AC.

### Fáze 6: Herní systémy hráče

Každá položka je samostatné téma podle postupu výše. Pořadí je doporučené, ne závazné:

1. Inventář, banka, keyring, vybavení a jeho zobrazení na hráči i na výpisu postav.
2. Vendor, opravy, buyback, trainer, banker, stable, spirit healer, taxi (`PlayerTaxi`, `TaxiHandler`).
3. Zkušenosti, level up, rested XP, smrt, hřbitovy (`GameGraveyard`), vzkříšení, rest a logout timer.
4. Skilly, profese, `SkillDiscovery`, `SkillExtraItems`, rybaření.
5. Talenty, dual spec, glyphy.
6. Reputace (`ReputationMgr`), spillover.
7. Chat (`ChatHandler`, `Chat.cpp`, `Hyperlinks`), kanály (`Channels/`), chat filtr, addon zprávy.
8. Social: přátelé, ignore, who (`WhoListCacheMgr`), `CharacterCache`.
9. Skupiny a raidy (`Group`, `GroupMgr`), ready check, ikony, loot rolly.
10. Pošta (`Mail`, `MailMgr`, `ServerMailMgr`), aukce (`AuctionHouseMgr`, `AuctionHouseSearcher`).
11. Obchod mezi hráči (`TradeHandler`).
12. Guildy (`Guild`, `GuildMgr`), guild banka, petice (`PetitionMgr`).
13. Instance: `InstanceSaveMgr`, `InstanceScript`, bind, reset, heroic a velikosti raidu.
14. Achievementy (`AchievementMgr`), statistiky.
15. LFG (`DungeonFinding/`).
16. Kalendář (`CalendarMgr`).
17. Battlegroundy, arény, arena týmy a sezóny, spectator (`Battlegrounds/`, `ArenaSpectator/`).
18. Battlefield a Wintergrasp (`Battlefield/`), outdoor PvP (`OutdoorPvP/`).
19. Světové systémy: počasí (`Weather/`), world states (`WorldState`), area triggery, autobroadcast, motd, herní čas z configu.
20. Účty: `AccountMgr`, RBAC, `BanMgr`, mute, IP lock, zamčení po neúspěšných pokusech, vytvoření účtu, logy a uptime v auth databázi.
21. Tickety (`TicketMgr`), bug a lag reporty, refer-a-friend.
22. Warden (`Warden/`, `WardenWin`, `WardenMac`, `warden_checks`).
23. Nástroje nad postavami: `PlayerDump`, `CharacterDatabaseCleaner`.

### Fáze 7: GM příkazy

- `Chat/ChatCommands`: parser argumentů, oprávnění přes RBAC, nápověda z tabulky `command`.
- Všech 55 souborů `scripts/Commands/cs_*.cpp` a `PlayerCommand`.
- Stejné příkazy z herního chatu, z konzole a přes RA/SOAP.

Příkazy jako `.go`, `.tele`, `.npc add`, `.additem`, `.learn` a `.reload` se vyplatí vzít co nejdřív (klidně během Fáze 6), protože zrychlí testování všeho ostatního.

### Fáze 8: Obsah (content skripty)

Asi 305 tisíc řádků. Framework už je hotový z Fáze 5, tady jde o objem. Pořadí podle toho, co hráč potká dřív:

1. `scripts/Spells/`: třídní a obecné spell skripty (`spell_warrior.cpp`, `spell_generic.cpp`, `spell_item.cpp`…). Bez nich třídy nefungují správně.
2. `scripts/World/`: guardi, obecné NPC, item skripty, area triggery, `npc_*`.
3. `scripts/Pet/`.
4. `scripts/EasternKingdoms/` a `scripts/Kalimdor/`: zóny, pak dungeony po jednom (nejdřív low level).
5. `scripts/Events/`: svátky.
6. `scripts/Outland/`.
7. `scripts/Northrend/`, včetně raidů (Naxxramas, Ulduar, ICC).
8. `scripts/OutdoorPvP/`.

Jedna instance je jedno téma: `InstanceScript`, všichni bossové, trash, dveře a uložené stavy. Každá instance dostane aspoň test, který načte její skripty a ověří registraci všech `ScriptName` z databáze.

Kontrola pokrytí: skript, který čte `ScriptMgr`, ale nemá TS třídu, se při startu vypíše do logu. Cíl fáze je nulový počet takových hlášek.

### Fáze 9: Nástroje

Převést `src/tools/` do TS CLI spouštěných přes `bun`:

- `map_extractor`: MPQ čtečka, DBC export, `.map` soubory.
- `vmap4_extractor` a `vmap4_assembler`.
- `mmaps_generator`: vyžaduje port Recastu (generování navmeshe). Je to největší kus této fáze. Do té doby se používají mmapy vygenerované nástrojem AC.
- `dbimport` je už nahrazený importem v `src/data/import.ts`.

## Testování a ověření

- `bun test` u každého tématu; packety se testují proti bajtům, ne jen proti tvaru objektu.
- Referenční chování se bere z C++ kódu, ne z odhadu. Kde se čísla počítají (staty, damage, XP, reputace), test porovná výsledek s hodnotou spočítanou podle vzorce z C++.
- Ruční ověření v klientu 3.3.5a na konci každé fáze. Scénáře: vytvoření postavy, level 1–10 v Northshire, dungeon, BG, obchod, pošta, guilda.
- Po Fázi 0 přidat smoke test, který nastartuje server na náhodných portech, přihlásí se testovacím klientem v TS, vstoupí do světa a odhlásí se.

## Rizika

- **Výkon jednoho vlákna.** Celý svět v jednom Bun vlákně nemusí stačit při stovkách hráčů. Nejdřív to změříme; teprve pak rozdělíme mapy do `Worker`ů se sdílenými stavy předávanými zprávami.
- **Spelly a aury.** Chyby se tu projevují až v kombinacích. Portovat přesně podle C++ včetně `SpellInfoCorrections` a netrhat to na zjednodušené verze.
- **Detour a Recast v TS.** Runtime dotazy jsou zvládnutelné; generátor je velký. Proto je generátor až ve Fázi 9.
- **Objem skriptů.** Fáze 8 je víc než polovina kódu. Paralelizuje se dobře, protože jednotlivé instance a zóny na sobě nezávisí.
- **Aktualizace upstreamu.** `azerothcore/` se může posunout. Porty tématu si poznamenají hash nebo datum posledního `updates/` souboru, podle kterého vznikly.
