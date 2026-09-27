# Jak portovat rychleji: generovat mechaniku, ručně jen logiku

Návrh pracovního postupu k [PLAN.md](../PLAN.md). Pravidla z [AGENTS.md](../AGENTS.md) platí dál. Mění se jen to, **jak** se téma portuje.

## Proč je to teď drahé

Každé téma dnes začíná stejnou ruční prací, kterou jde udělat strojově:

- Opcody se opisují ručně do `src/world/packets.ts` a `session.ts` má ruční `switch` (52 větví). AzerothCore přitom má v `Opcodes.cpp` 729 řádků `DEFINE_HANDLER` se jménem handleru, statusem a způsobem zpracování.
- SQL se píše ručně s aliasy (`id1 AS entry`, `position_x AS x`). AzerothCore má 679 hotových dotazů v `CharacterDatabase.cpp`, `LoginDatabase.cpp` a `WorldDatabase.cpp` (`CHAR_SEL_CHARACTER` a další) a v `src/` se nepoužívá ani jeden.
- DBC se čte podle čísla sloupce (`DbcTable`). `DBCfmt.h` a `DBCStructure.h` přitom popisují všech 47 formátů i jména polí.
- Enumy se generují jen pro spelly a jen z ručně vybraného seznamu.
- Soubory v `src/` se jmenují jinak než v C++ (`bags-play.ts`, `vendor-play.ts`). Kdo hledá `Player::StoreItem`, musí hádat.
- Nikde není zapsané, které C++ funkce už mají TS protějšek. Agent proto u každého tématu znovu prochází celý strom, aby zjistil, co chybí.

Hluboká analýza se tak opakuje u každé feature. Cíl je, aby se C++ četlo jen jednou, a to funkce, která se zrovna portuje.

## Princip

Kód se dělí na dvě vrstvy:

1. **Mechanická vrstva** se generuje z `azerothcore/`: opcody, SQL dotazy, typy řádků, DBC struktury, enumy a update fieldy. Nikdo ji needituje. Když se upstream posune, spustí se `bun run gen`.
2. **Logika** se portuje ručně, funkce po funkci, se stejným jménem a na stejném místě jako v C++. Každá portovaná funkce má značku `@ac`, podle které nástroj pozná, co zbývá.

Agent pak u tématu nedělá průzkum. Spustí `bun run port:card <Téma>`, dostane seznam funkcí, opcodů, dotazů a tabulek a jde po něm.

## 1. Generátory (`src/tools/gen/` → `src/gen/*.gen.ts`)

Výstup se commituje, aby šel číst a grepovat bez spuštění. Test hlídá, že `bun run gen` nic nezmění.

| Generátor | Zdroj v AzerothCore | Výstup |
| --- | --- | --- |
| `opcodes` | `Protocol/Opcodes.h`, `Opcodes.cpp` | hodnota, jméno, `STATUS_*`, `PROCESS_*` a jméno handleru (`HandleLootOpcode`) pro každý opcode; nahradí `opcode-names.ts` i ruční konstanty |
| `statements` | `database/Database/Implementation/*Database.cpp` | všech 679 dotazů pod původními jmény, doslova (databáze je MySQL jako v AC) |
| `rows` | hotovo: `bun run gen:db-schema` (`drizzle-kit pull` nad `acore_*`) | drizzle tabulky v `src/database/schema/` s AC jmény sloupců; typ řádku je `Row<typeof tabulka>` |
| `dbc` | `DBCfmt.h`, `DBCStructure.h`, `DBCStores.cpp` | pojmenované struktury, formát a store pro každé DBC včetně `*_dbc` override tabulky |
| `enums` | všechny `enum` z `SharedDefines.h`, `UnitDefines.h`, `ItemTemplate.h`, `Player.h`, `SpellDefines.h`… | `as const` objekty; `gen-spell-enums.ts` se zobecní na celé hlavičky místo ručního seznamu |
| `update-fields` | `Entities/Object/Updates/UpdateFields.h` | indexy, velikosti a viditelnost (`PUBLIC`, `OWNER`, `PARTY`…) |
| `config` | `worldserver.conf.dist` | už existuje (`gen-world-config.ts`) |

### Opcody a dispatch

Ruční `switch` nahradí tabulka. Session obsahuje handlery pod jmény z C++:

```ts
// src/game/Handlers/LootHandler.ts
/** @ac Handlers/LootHandler.cpp WorldSession::HandleLootOpcode */
export function HandleLootOpcode(session: WorldSession, recv: ByteReader) { … }
```

Dispatcher vezme `OPCODE_TABLE[opcode].handler`, najde funkci stejného jména v registru a zkontroluje `STATUS_LOGGEDIN` / `STATUS_AUTHED` jako `WorldSession::Update`. Chybějící handler zaloguje jménem C++ funkce, takže z logu je hned vidět, co port dělat dál.

### Prepared statements

Nejvíc práce ušetří tenhle generátor. Místo ručního SQL se píše totéž co v C++:

```ts
const stmt = CharacterDatabase.GetPreparedStatement(CHAR_SEL_CHARACTER_INVENTORY);
for (const row of stmt.all(guid)) { … }        // row má typ podle SELECT seznamu
```

- SQL se nepřevádí. Databáze je MySQL se stejným schématem jako v AC, takže se text dotazu zkopíruje beze změny a spustí přes `db.$client.unsafe(sql, params)` (nebo se přepíše do drizzle builderu, když je výsledek potřeba typovaný).
- Test připraví všech 679 dotazů proti vygenerovanému schématu. Tím se zadarmo ověří i schéma: chybějící sloupec shodí test dřív, než na něj narazí hra.
- `CONNECTION_ASYNC` a `QueryCallback` jsou `await`. `CharacterDatabase.Execute` z míst, která čekat nemohou (tick), je `executeAsync`. `CharacterDatabaseTransaction` je `db.transaction(async (tx) => …)`.
- Loadery z `ObjectMgr::Load*` mají SQL přímo v `.cpp`, ne v prepared statements. Ty se píšou ručně, ale se stejnými jmény sloupců, takže se nic nepřekládá.

### DBC

```ts
const area = sAreaTableStore.LookupEntry(zoneId);   // area.ParentAreaID, area.flags…
```

Generátor vezme formátový řetězec (`"niiiixxxxxissss…"`) a pole ze struct v `DBCStructure.h`. Lokalizované řetězce, `x` sloupce a pole (`uint32 SpellVisual[2]`) se rozvinou stejně jako v `DBCStorageIterator`. Existující `DbcTable` zůstane jako čtečka pod tím.

## 2. Soubory 1:1 s C++

Nové a přesouvané soubory kopírují cestu v `azerothcore/src/server/`:

```text
azerothcore/src/server/game/Loot/LootMgr.cpp       → src/game/Loot/LootMgr.ts
azerothcore/src/server/game/Handlers/ItemHandler.cpp → src/game/Handlers/ItemHandler.ts
azerothcore/src/server/game/Entities/Player/PlayerStorage.cpp → src/game/Entities/Player/PlayerStorage.ts
```

Jména tříd a funkcí zůstanou jako v C++, metody v camelCase (`Player::StoreItem` → `storeItem`). Handlery `WorldSession::Handle*` zůstanou s velkým písmenem, protože se na ně odkazuje generovaná tabulka opcodů. Existující `*-play.ts` a `src/world/*` se přesunou ve chvíli, kdy se na téma sáhne, ne naráz.

Díky tomu stačí agentovi k nalezení protějšku cesta souboru. Nemusí hledat, kam někdo dřív funkci schoval.

## 3. Značky `@ac` a pokrytí

Každá portovaná funkce nese odkaz na originál:

```ts
/** @ac Loot/LootMgr.cpp LootTemplate::Process */
```

`bun run port:coverage <cesta nebo téma>`:

1. Projde C++ definice funkcí (`Třída::Metoda(` na začátku řádku, jako to dělá ctags).
2. Projde značky `@ac` v `src/`.
3. Vypíše chybějící funkce s počtem řádků, seřazené podle souboru.

Výsledek nahradí ruční audit typu `docs/spell-system-gaps.md`. Řádek v `docs/status.md` se odškrtne, až coverage tématu nic nevypíše (nebo zbydou jen funkce výslovně označené `@ac-skip <důvod>`, například Warden pro Mac).

## 4. Karta tématu (`bun run port:card <Téma>`)

Jeden příkaz, který agentovi nahradí průzkum. Výstup je markdown do stdoutu:

- **Soubory** v `game/<Téma>/`, `Handlers/<Téma>Handler.cpp` a `Server/Packets/<Téma>Packets.*` s počtem řádků.
- **Funkce** s počtem řádků a stavem (hotovo podle `@ac`, chybí).
- **Opcody**, jejichž handler leží v těchto souborech, a SMSG, které odtud odcházejí (`WorldPacket data(SMSG_…`).
- **Prepared statements** použité v souborech tématu (`CHAR_SEL_…`) a z nich odvozené **tabulky**.
- **DBC stores** (`s…Store`), **config** (`CONFIG_…`) a **ostatní manažeři**, na které téma sahá (`sObjectMgr->`, `sSpellMgr->`). To je seznam závislostí; co z nich ještě není v TS, se označí.
- **Volající zvenku**: kde jinde v AzerothCore se funkce tématu volají. Podle toho se pozná, kam je zapojit.

Všechno je grep nad `azerothcore/` a nad `src/gen/`, žádné AST. Stačí to, protože AC kód má pevný styl.

## 5. Bun primitiva

| V AzerothCore | V Bunu |
| --- | --- |
| `DatabaseWorkerPool`, prepared statements | `Bun.SQL` pool na databázi (`drizzle-orm/bun-sql/mysql`); login a characters mají jedno spojení, takže zápisy drží pořadí |
| `Field*`, `fields[3].Get<uint32>()` | typovaný drizzle řádek s AC jmény sloupců |
| `bigint unsigned` sloupce (guidy, masky) | generátor schématu je mapuje na `mode: 'bigint'` |
| `CharacterDatabaseTransaction` | `db.transaction(fn)` |
| `ByteBuffer` `<<` a `>>` | `ByteWriter` / `ByteReader` s metodami pojmenovanými podle C++ typů (`u32`, `packGuid`, `cstring`), aby se řádek přepsal řádek po řádku |
| zlib (`SMSG_COMPRESSED_UPDATE_OBJECT`, addon info) | `Bun.deflateSync` / `Bun.inflateSync` |
| čtení `.map`, `.vmtree`, `.mmtile` | `Bun.mmap(path)` a `DataView`, bez kopírování do paměti |
| DBC soubory | `Bun.file(path).bytes()` |
| `getMSTime`, `UpdateTime` | `Bun.nanoseconds()` |
| hledání souborů v nástrojích | `Bun.Glob` |
| test packetu bajt po bajtu | `bun test` a `expect(bytes).toMatchSnapshot()`; snapshot se jednou ověří proti klientovi nebo dumpu |
| `MapUpdater` vlákna | zatím nic; později `Worker` na mapu |

## 6. Postup u jednoho tématu (nová verze)

Nahrazuje sekci „Postup u jednoho tématu“ v `PLAN.md`:

1. `bun run port:card <Téma>` a přečíst kartu. C++ se otevírá až u konkrétní funkce.
2. Chybí-li v kartě generovaný kus (opcode, statement, DBC, enum), opravit generátor, ne psát konstantu ručně.
3. Portovat loadery (`Load*`) a zapojit je do startu v pořadí `World::SetInitialWorldSettings`.
4. Portovat handlery ze seznamu opcodů. Každý je funkce se jménem z C++ a značkou `@ac`.
5. Portovat zbylé funkce ze seznamu, řádek po řádku podle C++.
6. Testy vedle kódu: snapshot bajtů u packetů, world data přes `WorldTables.fromRows` / `worldFromSql`, postavy a účty přes `testDatabase()` nad MySQL.
7. `bun run port:coverage <Téma>` bez výstupu, `bun test` zelený, ověření v klientu 3.3.5a, odškrtnout `docs/status.md`.

## Pořadí zavedení

Každý krok se vyplatí sám o sobě, takže se dají dělat postupně:

1. **`opcodes` a tabulkový dispatch.** Malé, hned zmizí ruční konstanty a `switch`.
2. **`statements`** (`rows` už je hotové jako drizzle schéma). Největší úspora pro postavy, inventář, poštu, guildy a všechno, co zapisuje do `acore_characters`.
3. **`port:card` a `port:coverage` se značkami `@ac`.** Od téhle chvíle agent nedělá průzkum od nuly.
4. **`dbc`** pro všech 47 formátů. Potřebuje ho Fáze 0 v `PLAN.md` tak jako tak.
5. **`enums` a `update-fields`** z celých hlaviček.
6. Přesun `src/world/*` a `*-play.ts` do cest podle C++ vždy spolu s tématem, které se zrovna portuje.

Volitelně později: generátor kostry třídy z `.h` (všechny metody s tělem `todo("Player.cpp:1234")`). Pomůže u velkých tříd jako `Player` a `Unit`, kde je metod stovky, ale bez kroků 1–3 nemá smysl.
