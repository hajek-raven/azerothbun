/**
 * `ObjectMgr` for what the chat and command code reads: `acore_string`, `game_tele`, and template lookups over the
 * cached world tables. The rest of `ObjectMgr` joins this class as its topics are ported.
 */
import type { Db } from "../../database/database.ts";
import { executeStatementAsync } from "../../database/database.ts";
import { acore_string, areatrigger, creature, exploration_basexp, creature_template_locale, gameobject_template_locale, item_template_locale, quest_template_locale, creature_queststarter, creature_questender, game_tele, gameobject, gameobject_queststarter, gameobject_questender, gameobject_template } from "../../database/schema/world.ts";
import type { Row } from "../../database/world-tables.ts";
import type { WorldTables } from "../../database/world-tables.ts";
import type { CreatureSpawn, CreatureTemplate, GameObjectSpawn, GameObjectTemplate, ItemTemplate, WorldData } from "../../data/world.ts";
import { WORLD_DEL_GAME_TELE, WORLD_INS_GAME_TELE, WORLD_UPD_CREATURE_ZONE_AREA_DATA, WORLD_UPD_GAMEOBJECT_ZONE_AREA_DATA } from "../../gen/WorldDatabase.gen.ts";
import { log, logError } from "../../log.ts";
import { StringFormat } from "../../common/Utilities/StringFormat.ts";
import { isBasicLatinString, isCyrillicString, isEastAsianString, isExtendedLatinString, wcharToUpper, wstrToLower } from "../../common/util.ts";
import { CharacterDatabase } from "../../database/DatabaseEnv.ts";
import { CHAR_INS_RESERVED_PLAYER_NAME } from "../../gen/CharacterDatabase.gen.ts";
import { sNamesProfanityStore, sNamesReservedStore } from "../DataStores/DBCStores.ts";
import { ServerConfig } from "../world/world-config.ts";
import { sWorld } from "../world/world.ts";
import { DEFAULT_LOCALE, TOTAL_LOCALES } from "../../shared/SharedDefines.ts";
import { GetLocaleByName } from "../../common/Common.ts";
import { talkDataFor } from "../../world/talk.ts";
import type { QuestCatalog, QuestTemplate } from "../../world/quests.ts";
import { isValidMapCoord } from "../Maps/MapMgrStatics.ts";
import { LoadTrainers, type Trainer } from "../Entities/Creature/Trainer.ts";
import { getMSTime, getMSTimeDiffToNow } from "../time/timer.ts";
// Spawn stores (Maps topic): `LoadCreatures`, `LoadGameobjects`, the grid guid store, spawn groups, linked respawns, addons
import * as acoreWorld from "../../database/schema/world.ts";
import { WORLD_DEL_CRELINKED_RESPAWN, WORLD_REP_CREATURE_LINKED_RESPAWN } from "../../gen/WorldDatabase.gen.ts";
import { sCreatureDisplayInfoStore, sEmotesStore, sFactionTemplateStore, sGameObjectArtKitStore, sGameObjectDisplayInfoStore, sMapDifficultyStore, sMapStore } from "../DataStores/DBCStores.ts";
import { ComputeGridCoord } from "../Grids/GridDefines.ts";
import { HighGuid, ObjectGuid } from "../Entities/Object/ObjectGuid.ts";
import {
  CreatureChaseMovementType,
  CreatureFlightMovementType,
  CreatureGroundMovementType,
  CreatureMovementData,
  CreatureRandomMovementType,
} from "../Entities/Creature/CreatureData.ts";
import { VisibilityDistanceType } from "../Entities/Object/ObjectDefines.ts";
import { sSpellMgr } from "../Spells/SpellMgr.ts";
import { spellDuration } from "../../spells/spell-info.ts";
import {
  CreatureData as SpawnCreatureData,
  GameObjectData as SpawnGameObjectData,
  GO_STATE_ACTIVE,
  MAX_GO_STATE,
  QuaternionDataFromEulerAnglesZYX,
  QuaternionDataIsUnit,
  SPAWN_TYPE_CREATURE,
  SPAWN_TYPE_GAMEOBJECT,
  SPAWN_TYPE_MAX,
  SPAWNGROUP_FLAG_ALL,
  SPAWNGROUP_FLAG_COMPATIBILITY_MODE,
  SPAWNGROUP_FLAG_MANUAL_SPAWN,
  SPAWNGROUP_FLAG_SYSTEM,
  SPAWNGROUP_MAP_UNSET,
  type CreatureAddon,
  type GameObjectAddon,
  type GameObjectTemplateAddon,
  type SpawnData,
  type SpawnGroupTemplateData,
  type SpawnObjectType,
} from "../Maps/SpawnData.ts";

/** @ac game/Globals/ObjectMgr.h GameTele */
export type GameTele = {
  position_x: number;
  position_y: number;
  position_z: number;
  orientation: number;
  mapId: number;
  name: string;
  wnameLow: string;
};

/** @ac game/Globals/ObjectMgr.cpp normalizePlayerName */
export function normalizePlayerName(name: string): string | null {
  if (name.length === 0 || name.includes(" ")) {
    return null;
  }
  const lower = wstrToLower(name);
  const chars = Array.from(lower);
  if (chars.length === 0) return null;
  chars[0] = String.fromCodePoint(wcharToUpper(chars[0]!.codePointAt(0)!));
  return chars.join("");
}

const LOCALE_COLUMNS = ["content_default", "locale_koKR", "locale_frFR", "locale_deDE", "locale_zhCN", "locale_zhTW", "locale_esES", "locale_esMX", "locale_ruRU"] as const;

export class ObjectMgr {
  private world: WorldData | null = null;
  private tables: WorldTables | null = null;
  private worldDb: Db | null = null;
  private readonly acoreStringStore = new Map<number, string[]>();
  private readonly gameTeleStore = new Map<number, GameTele>();
  private dbcLocaleIndex = DEFAULT_LOCALE;

  /** Points the manager at the loaded world data and the `WorldDatabase` pool for writes. */
  setWorld(world: WorldData | null, tables: WorldTables | null, worldDb: Db | null = null): void {
    this.world = world;
    this.tables = tables ?? world?.tables() ?? null;
    this.worldDb = worldDb;
    this.trainerStore = null;
    this.transportMaps = null;
  }

  worldData(): WorldData | null {
    return this.world;
  }

  worldTables(): WorldTables | null {
    return this.tables;
  }

  worldDatabase(): Db | null {
    return this.worldDb;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadAcoreStrings */
  loadAcoreStrings(): boolean {
    const oldMSTime = getMSTime();
    this.acoreStringStore.clear();
    const rows = this.tables?.all(acore_string) ?? [];
    if (rows.length === 0) {
      log("server", ">> Loaded 0 acore strings. DB table `acore_strings` is empty.");
      return false;
    }
    for (const row of rows) {
      const content: string[] = [];
      for (let i = 0; i < TOTAL_LOCALES; i++) {
        const value = (row as Record<string, unknown>)[LOCALE_COLUMNS[i]!];
        // `ObjectMgr::AddLocaleString`: empty strings are not stored.
        content[i] = typeof value === "string" ? value : "";
      }
      this.acoreStringStore.set(row.entry, content);
    }
    log("server", `>> Loaded ${this.acoreStringStore.size} Acore Strings in ${getMSTimeDiffToNow(oldMSTime)} ms`);
    return true;
  }

  /** Adds or replaces one string (tests). */
  setAcoreString(entry: number, text: string): void {
    this.acoreStringStore.set(entry, [text]);
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::GetAcoreString */
  getAcoreString(entry: number, locale: number = DEFAULT_LOCALE): string {
    const content = this.acoreStringStore.get(entry);
    if (content && content.length > 0) {
      const localized = content[locale];
      if (localized) return localized;
      return content[DEFAULT_LOCALE] ?? "";
    }
    const msg = StringFormat("No entry for acore_string ({}) in DB.", entry);
    logError("sql", msg);
    return msg;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetAcoreStringForDBCLocale */
  getAcoreStringForDBCLocale(entry: number): string {
    return this.getAcoreString(entry, this.dbcLocaleIndex);
  }

  getDBCLocaleIndex(): number {
    return this.dbcLocaleIndex;
  }

  setDBCLocaleIndex(locale: number): void {
    this.dbcLocaleIndex = locale;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadGameTele */
  loadGameTele(): void {
    const oldMSTime = getMSTime();
    this.gameTeleStore.clear();
    const rows = this.tables?.all(game_tele) ?? [];
    if (rows.length === 0) {
      log("server", ">> Loaded 0 GameTeleports. DB table `game_tele` is empty!");
      return;
    }
    let count = 0;
    for (const row of rows) {
      const gt: GameTele = {
        position_x: row.position_x,
        position_y: row.position_y,
        position_z: row.position_z,
        orientation: row.orientation,
        mapId: row.map,
        name: row.name,
        wnameLow: wstrToLower(row.name),
      };
      if (!isValidMapCoord(gt.mapId, gt.position_x, gt.position_y, gt.position_z, gt.orientation)) {
        logError("sql", `Wrong position for id ${row.id} (name: ${gt.name}) in \`game_tele\` table, ignoring.`);
        continue;
      }
      this.gameTeleStore.set(row.id, gt);
      ++count;
    }
    log("server", `>> Loaded ${count} GameTeleports in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetGameTele */
  getGameTele(id: number): GameTele | null {
    return this.gameTeleStore.get(id) ?? null;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::GetGameTele */
  getGameTeleByName(name: string, exactSearch = false): GameTele | null {
    const wname = wstrToLower(name);
    let alt: GameTele | null = null;
    for (const tele of this.sortedTeles()) {
      if (tele.wnameLow === wname) return tele;
      if (!exactSearch && !alt && tele.wnameLow.includes(wname)) alt = tele;
    }
    return alt;
  }

  getGameTeleMap(): ReadonlyMap<number, GameTele> {
    return this.gameTeleStore;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::AddGameTele */
  addGameTele(tele: Omit<GameTele, "wnameLow">): boolean {
    let newId = 0;
    for (const id of this.gameTeleStore.keys()) {
      if (id > newId) newId = id;
    }
    ++newId;
    this.gameTeleStore.set(newId, { ...tele, wnameLow: wstrToLower(tele.name) });
    if (this.worldDb) {
      executeStatementAsync(this.worldDb, WORLD_INS_GAME_TELE, newId, tele.position_x, tele.position_y, tele.position_z, tele.orientation, tele.mapId, tele.name);
    }
    return true;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::DeleteGameTele */
  deleteGameTele(name: string): boolean {
    const wname = wstrToLower(name);
    for (const [id, tele] of this.sortedTeleEntries()) {
      if (tele.wnameLow === wname) {
        if (this.worldDb) executeStatementAsync(this.worldDb, WORLD_DEL_GAME_TELE, tele.name);
        this.gameTeleStore.delete(id);
        return true;
      }
    }
    return false;
  }

  private sortedTeleEntries(): [number, GameTele][] {
    return [...this.gameTeleStore.entries()].sort((a, b) => a[0] - b[0]);
  }

  private sortedTeles(): GameTele[] {
    return this.sortedTeleEntries().map(([, tele]) => tele);
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetCreatureLocale (`Name` and `Title` by `LocaleConstant`) */
  getCreatureLocale(entry: number): CreatureLocale | null {
    const rows = this.tables?.where(creature_template_locale, "entry", entry) ?? [];
    if (rows.length === 0) return null;
    return { Name: byLocale(rows, (row) => row.Name), Title: byLocale(rows, (row) => row.Title) };
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetGameObjectLocale */
  getGameObjectLocale(entry: number): GameObjectLocale | null {
    const rows = this.tables?.where(gameobject_template_locale, "entry", entry) ?? [];
    if (rows.length === 0) return null;
    return { Name: byLocale(rows, (row) => row.name), CastBarCaption: byLocale(rows, (row) => row.castBarCaption) };
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetItemLocale */
  getItemLocale(entry: number): ItemLocale | null {
    const rows = this.tables?.where(item_template_locale, "ID", entry) ?? [];
    if (rows.length === 0) return null;
    return { Name: byLocale(rows, (row) => row.Name), Description: byLocale(rows, (row) => row.Description) };
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetQuestLocale */
  getQuestLocale(entry: number): QuestLocale | null {
    const rows = this.tables?.where(quest_template_locale, "ID", entry) ?? [];
    if (rows.length === 0) return null;
    return { Title: byLocale(rows, (row) => row.Title) };
  }

  private trainerStore: ReturnType<typeof LoadTrainers> | null = null;

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetClassTrainers */
  getClassTrainers(classId: number): readonly Trainer[] {
    if (!this.trainerStore) this.trainerStore = this.tables ? LoadTrainers(this.tables) : { trainers: new Map(), classTrainers: new Map() };
    return this.trainerStore.classTrainers.get(classId) ?? [];
  }

  private readonly reservedNamesStore = new Set<string>();
  private readonly profanityNamesStore = new Set<string>();

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadReservedPlayerNamesDB and LoadReservedPlayerNamesDBC */
  async loadReservedPlayerNames(characters: Db): Promise<void> {
    this.reservedNamesStore.clear();
    for (const row of (await characters.$client.unsafe("SELECT name FROM reserved_name")) as { name: string }[]) this.reservedNamesStore.add(wstrToLower(row.name));
    if (sWorld().getBoolConfig(ServerConfig.CONFIG_STRICT_NAMES_RESERVED)) {
      // DBC does not have clean entries, remove the junk.
      for (const entry of sNamesReservedStore) this.reservedNamesStore.add(entry.Pattern.replaceAll("\\<", "").replaceAll("\\>", ""));
    }
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadProfanityNamesFromDB and LoadProfanityNamesFromDBC */
  async loadProfanityNames(characters: Db): Promise<void> {
    this.profanityNamesStore.clear();
    for (const row of (await characters.$client.unsafe("SELECT name FROM profanity_name")) as { name: string }[]) this.profanityNamesStore.add(wstrToLower(row.name));
    if (sWorld().getBoolConfig(ServerConfig.CONFIG_STRICT_NAMES_PROFANITY)) {
      for (const entry of sNamesProfanityStore) this.profanityNamesStore.add(entry.Pattern.replaceAll("\\<", "").replaceAll("\\>", ""));
    }
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::IsReservedName */
  isReservedName(name: string): boolean {
    // pussywizard
    if (/[Gg][Mm]$/.test(name)) return true;
    return this.reservedNamesStore.has(wstrToLower(name));
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::IsProfanityName */
  isProfanityName(name: string): boolean {
    // pussywizard
    if (/[Gg][Mm]$/.test(name)) return true;
    return this.profanityNamesStore.has(wstrToLower(name));
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::AddReservedPlayerName */
  addReservedPlayerName(name: string): void {
    if (this.isReservedName(name)) return;
    this.reservedNamesStore.add(wstrToLower(name));
    executeStatementAsync(CharacterDatabase(), CHAR_INS_RESERVED_PLAYER_NAME, name);
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::CheckPlayerName */
  checkPlayerName(name: string, create = false): number {
    const wname = [...name];
    // Check for too long name
    if (wname.length > MAX_PLAYER_NAME) return CHAR_NAME_TOO_LONG;
    // Check for too short name
    if (wname.length < sWorld().getIntConfig(ServerConfig.CONFIG_MIN_PLAYER_NAME)) return CHAR_NAME_TOO_SHORT;
    // Check for mixed languages
    if (!isValidString(name, sWorld().getIntConfig(ServerConfig.CONFIG_STRICT_PLAYER_NAMES), false, create)) return CHAR_NAME_MIXED_LANGUAGES;
    // Check for three consecutive letters
    const lower = [...wstrToLower(name)];
    for (let i = 2; i < lower.length; ++i) if (lower[i] === lower[i - 1] && lower[i] === lower[i - 2]) return CHAR_NAME_THREE_CONSECUTIVE;
    // Check Reserved Name
    if (this.isReservedName(name)) return CHAR_NAME_RESERVED;
    // Check Profanity Name
    if (this.isProfanityName(name)) return CHAR_NAME_PROFANE;
    return CHAR_NAME_SUCCESS;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetItemTemplate */
  getItemTemplate(entry: number): ItemTemplate | null {
    return this.world?.itemTemplate(entry) ?? null;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetItemTemplateStore */
  getItemTemplateStore(): ReadonlyMap<number, ItemTemplate> {
    return this.world?.items ?? new Map();
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetCreatureTemplate */
  getCreatureTemplate(entry: number): CreatureTemplate | null {
    return this.world?.creatureTemplate(entry) ?? null;
  }

  getCreatureTemplates(): ReadonlyMap<number, CreatureTemplate> {
    return this.world?.templates ?? new Map();
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetGameObjectTemplate */
  getGameObjectTemplate(entry: number): GameObjectTemplate | null {
    return this.world?.gameObjectTemplate(entry) ?? null;
  }

  getGameObjectTemplates(): ReadonlyMap<number, GameObjectTemplate> {
    return this.world?.gameObjectTemplates ?? new Map();
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetCreatureData (every `creature` row, shown or not) */
  getCreatureData(spawnId: number): CreatureData | null {
    return this.tables?.first(creature, "guid", spawnId) ?? null;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetAllCreatureData (in spawn id order) */
  getAllCreatureData(): readonly CreatureData[] {
    return this.tables?.all(creature) ?? [];
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetGameObjectData */
  getGameObjectData(spawnId: number): GameObjectData | null {
    return this.tables?.first(gameobject, "guid", spawnId) ?? null;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetAllGOData */
  getAllGOData(): readonly GameObjectData[] {
    return this.tables?.all(gameobject) ?? [];
  }

  /** The spawn the map shows for a spawn id (null when an event, pool, or missing model hides it). */
  getShownCreatureSpawn(spawnId: number): CreatureSpawn | null {
    return this.world?.creatureSpawn(spawnId) ?? null;
  }

  getShownGameObjectSpawn(spawnId: number): GameObjectSpawn | null {
    return this.world?.gameObjectSpawn(spawnId) ?? null;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::GetBaseXP (the `exploration_basexp` table: `LoadExplorationBaseXP`) */
  getBaseXP(level: number): number {
    return this.tables?.first(exploration_basexp, "level", level)?.basexp ?? 0;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetAreaTrigger */
  getAreaTrigger(trigger: number): Row<typeof areatrigger> | null {
    return this.tables?.first(areatrigger, "entry", trigger) ?? null;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetCreatureQuestRelationMap (creature entry, quest) */
  getCreatureQuestRelationMap(): readonly { id: number; quest: number }[] {
    return this.tables?.all(creature_queststarter) ?? [];
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetCreatureQuestInvolvedRelationMap */
  getCreatureQuestInvolvedRelationMap(): readonly { id: number; quest: number }[] {
    return this.tables?.all(creature_questender) ?? [];
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetGOQuestRelationMap */
  getGOQuestRelationMap(): readonly { id: number; quest: number }[] {
    return this.tables?.all(gameobject_queststarter) ?? [];
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetGOQuestInvolvedRelationMap */
  getGOQuestInvolvedRelationMap(): readonly { id: number; quest: number }[] {
    return this.tables?.all(gameobject_questender) ?? [];
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::IsTransportMap (`GAMEOBJECT_TYPE_MO_TRANSPORT` `moTransport.mapID` is `Data6`) */
  isTransportMap(mapId: number): boolean {
    this.transportMaps ??= new Set((this.tables?.all(gameobject_template) ?? []).filter((row) => row.type === 15).map((row) => row.Data6));
    return this.transportMaps.has(mapId);
  }

  private transportMaps: Set<number> | null = null;

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetQuestTemplate */
  getQuestTemplate(questId: number): QuestTemplate | null {
    return this.world ? talkDataFor(this.world).quests.quest(questId) : null;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetQuestTemplates */
  getQuestTemplates(): ReadonlyMap<number, QuestTemplate> {
    return this.world ? talkDataFor(this.world).quests.quests : new Map();
  }

  /** The quest templates with the XP and money tables (`quest_xp`, `quest_money_reward`) the rewards read. */
  questCatalog(): QuestCatalog | null {
    return this.world ? talkDataFor(this.world).quests : null;
  }

  // ---- Spawn stores (Maps topic) ----
  // `getCreatureData` / `getGameObjectData` / `getAllCreatureData` / `getAllGOData` above still return the raw rows the
  // chat commands read. The C++ `GetCreatureData` / `GetGameObjectData` (the `SpawnData` records `LoadCreatures` and
  // `LoadGameobjects` build) are `getSpawnCreatureData` / `getSpawnGameObjectData` / `getSpawnData` below.

  private _scriptNamesStore: string[] = [];
  private readonly _creatureDataStore = new Map<number, SpawnCreatureData>();
  private readonly _gameObjectDataStore = new Map<number, SpawnGameObjectData>();
  /** `MapObjectGuids`: `MAKE_PAIR32(mapid, spawnMode)` -> grid id -> `CellObjectGuids` */
  private readonly _mapObjectGuidsStore = new Map<number, Map<number, CellObjectGuids>>();
  private readonly _emptyCellObjectGuidsMap: ReadonlyMap<number, CellObjectGuids> = new Map();
  /** Created on first use: `SortedGuidSet` is declared below `sObjectMgr`. */
  private _emptyCellObjectGuids: CellObjectGuids | null = null;
  private readonly _spawnGroupDataStore = new Map<number, SpawnGroupTemplateData>([
    // Initialize default spawn groups (ObjectMgr::ObjectMgr)
    [0, { groupId: 0, name: "Default Group", mapId: SPAWNGROUP_MAP_UNSET, flags: SPAWNGROUP_FLAG_SYSTEM }],
    [1, { groupId: 1, name: "Legacy Group", mapId: SPAWNGROUP_MAP_UNSET, flags: SPAWNGROUP_FLAG_SYSTEM | SPAWNGROUP_FLAG_COMPATIBILITY_MODE }],
  ]);
  /** `SpawnGroupLinkContainer` (`std::multimap<uint32, SpawnData const*>`) */
  private readonly _spawnGroupMapStore = new Map<number, SpawnData[]>();
  /** `LinkedRespawnContainer` (`std::map<ObjectGuid, ObjectGuid>`) */
  private readonly _linkedRespawnStore = new Map<bigint, bigint>();
  private readonly _creatureAddonStore = new Map<number, CreatureAddon>();
  /** `CreatureTemplate::Movement` of the templates that have a `creature_template_movement` row (the others are `CreatureMovementData()`). */
  private readonly _creatureTemplateMovementStore = new Map<number, CreatureMovementData>();
  private readonly _creatureMovementOverrides = new Map<number, CreatureMovementData>();
  private readonly _creatureTemplateAddonStore = new Map<number, CreatureAddon>();
  private readonly _gameObjectAddonStore = new Map<number, GameObjectAddon>();
  private readonly _gameObjectTemplateAddonStore = new Map<number, GameObjectTemplateAddon>();
  private _creatureSpawnId = 1;
  private _gameObjectSpawnId = 1;

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadScriptNames (over the cached tables; a table that is not cached adds nothing) */
  loadScriptNames(): void {
    const oldMSTime = getMSTime();
    // We insert an empty placeholder here so we can use the script id 0 as dummy for "no script found".
    this._scriptNamesStore = [""];
    const tables = this.tables;
    if (!tables) return;
    const names = new Set<string>();
    const collect = (table: Parameters<WorldTables["all"]>[0], column: string, filter?: (row: Record<string, unknown>) => boolean): void => {
      if (!tables.has(table)) return;
      for (const row of tables.all(table) as readonly Record<string, unknown>[]) {
        const name = row[column];
        if (typeof name === "string" && name !== "" && (!filter || filter(row))) names.add(name);
      }
    };
    collect(acoreWorld.achievement_criteria_data, "ScriptName", (row) => row.type === 11);
    collect(acoreWorld.battleground_template, "ScriptName");
    collect(acoreWorld.creature, "ScriptName");
    collect(acoreWorld.creature_template, "ScriptName");
    collect(acoreWorld.gameobject, "ScriptName");
    collect(acoreWorld.gameobject_template, "ScriptName");
    collect(acoreWorld.item_template, "ScriptName");
    collect(acoreWorld.areatrigger_scripts, "ScriptName");
    collect(acoreWorld.spell_script_names, "ScriptName");
    collect(acoreWorld.transports, "ScriptName");
    collect(acoreWorld.game_weather, "ScriptName");
    collect(acoreWorld.conditions, "ScriptName");
    collect(acoreWorld.outdoorpvp_template, "ScriptName");
    collect(acoreWorld.instance_template, "script");
    this._scriptNamesStore.push(...names);
    // std::sort on std::string (byte order; the names are ASCII)
    this._scriptNamesStore.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    log("server", `>> Loaded ${this._scriptNamesStore.length} ScriptNames in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::GetScriptName */
  getScriptName(id: number): string {
    return id < this._scriptNamesStore.length ? (this._scriptNamesStore[id] ?? "") : "";
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::GetScriptId (binary search in the sorted names; "" is the first element) */
  getScriptId(name: string): number {
    if (name === "") return 0;
    let lo = 0;
    let hi = this._scriptNamesStore.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this._scriptNamesStore[mid] ?? "") < name) lo = mid + 1;
      else hi = mid;
    }
    if (lo === this._scriptNamesStore.length || this._scriptNamesStore[lo] !== name) return 0;
    return lo;
  }

  /** `LoadCreatures` / `LoadGameobjects`: "Build single time for check spawnmask" (`GetMapDifficultyData(i, k)` per map). */
  private buildSpawnMasks(): Map<number, number> {
    const spawnMasks = new Map<number, number>();
    for (let i = 0; i < sMapDifficultyStore.getNumRows(); ++i) {
      const entry = sMapDifficultyStore.lookupEntry(i);
      if (!entry || !sMapStore.lookupEntry(entry.MapId)) continue;
      spawnMasks.set(entry.MapId, (spawnMasks.get(entry.MapId) ?? 0) | (1 << entry.Difficulty));
    }
    return spawnMasks;
  }

  /** The spawns the map shows by default (`WorldData` resolved events and pools); null when no `WorldData` is set. */
  private shownSpawnIds(kind: "creature" | "gameobject"): Set<number> | null {
    if (!this.world) return null;
    return new Set((kind === "creature" ? this.world.creaturesOnMap : this.world.gameObjectsOnMap).map((spawn) => spawn.guid));
  }

  /**
   * @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadCreatures
   * Every valid `creature` row goes into `_creatureDataStore`. The grid store gets the spawns the import shows by
   * default (`WorldData.creaturesOnMap`: no positive `game_event_creature`, the chosen pool members, a template with a
   * model); C++ adds the `eventEntry == 0` rows and lets `GameEventMgr` / the grid loader's pool check do the rest,
   * which comes to the same set while no event is running.
   * `CONFIG_CALCULATE_CREATURE_ZONE_AREA_DATA` writes `zoneId` / `areaId` back to the `creature` table (`updateSpawnZoneAreaData`).
   */
  loadCreatures(): void {
    const oldMSTime = getMSTime();
    const tables = this.tables;
    this._creatureDataStore.clear();
    if (!tables || tables.all(creature).length === 0) {
      log("server", ">> Loaded 0 creatures. DB table `creature` is empty.");
      return;
    }

    const gameEvents = new Map(tables.all(acoreWorld.game_event_creature).map((row) => [row.guid, row.eventEntry]));
    const pools = new Map(tables.all(acoreWorld.pool_creature).map((row) => [row.guid, row.pool_entry]));
    const shown = this.shownSpawnIds("creature");
    const spawnMasks = this.buildSpawnMasks();
    // _difficultyEntries (filled by CheckCreatureTemplate): templates listed as a difficulty entry of another one
    const difficultyEntries: Set<number>[] = [new Set(), new Set(), new Set()];
    for (const row of tables.all(acoreWorld.creature_template)) {
      if (row.difficulty_entry_1) difficultyEntries[0]!.add(row.difficulty_entry_1);
      if (row.difficulty_entry_2) difficultyEntries[1]!.add(row.difficulty_entry_2);
      if (row.difficulty_entry_3) difficultyEntries[2]!.add(row.difficulty_entry_3);
    }

    let count = 0;
    for (const row of [...tables.all(creature)].sort((a, b) => a.guid - b.guid)) {
      const spawnId = row.guid;
      const creatureId = row.id;

      const cInfo = this.getCreatureTemplate(creatureId);
      if (!cInfo) {
        logError("sql", `Table \`creature\` has creature (SpawnId: ${spawnId}) with non existing creature entry ${creatureId} in \`id\` field, skipped.`);
        continue;
      }
      const cInfoRow = tables.first(acoreWorld.creature_template, "entry", creatureId);
      const data = new SpawnCreatureData();
      data.spawnId = spawnId;
      data.id = creatureId;
      data.mapid = row.map;
      data.equipmentId = row.equipment_id;
      data.posX = row.position_x;
      data.posY = row.position_y;
      data.posZ = row.position_z;
      data.orientation = row.orientation;
      data.spawntimesecs = row.spawntimesecs;
      data.wander_distance = row.wander_distance;
      data.currentwaypoint = row.currentwaypoint;
      data.curhealth = row.curhealth;
      data.curmana = row.curmana;
      data.movementType = row.MovementType;
      data.spawnMask = row.spawnMask;
      data.phaseMask = row.phaseMask;
      const gameEvent = gameEvents.get(spawnId) ?? 0;
      data.poolId = pools.get(spawnId) ?? 0;
      data.npcflag = row.npcflag;
      data.unit_flags = row.unit_flags;
      data.dynamicflags = row.dynamicflags;
      data.ScriptId = this.getScriptId(row.ScriptName ?? "");
      data.spawnGroupId = 0;

      if (!data.ScriptId) data.ScriptId = this.getScriptId(cInfoRow?.ScriptName ?? "");

      const mapEntry = sMapStore.lookupEntry(data.mapid);
      if (!mapEntry) {
        logError("sql", `Table \`creature\` have creature (SpawnId: ${spawnId}) that spawned at not existed map (Id: ${data.mapid}), skipped.`);
        continue;
      }

      // pussywizard: 7 days means no reaspawn, so set it to 14 days, because manual id reset may be late
      if (mapEntryIsRaid(mapEntry.map_type) && data.spawntimesecs >= 7 * 86400 && data.spawntimesecs < 14 * 86400) data.spawntimesecs = 14 * 86400;

      // Skip spawnMask check for transport maps
      if (!this.isTransportMap(data.mapid)) {
        if (data.spawnMask & ~(spawnMasks.get(data.mapid) ?? 0)) {
          logError("sql", `Table \`creature\` have creature (SpawnId: ${spawnId}) that have wrong spawn mask ${data.spawnMask} including not supported difficulty modes for map (Id: ${data.mapid}).`);
        }
      } else {
        data.spawnGroupId = 1; // force compatibility group for transport spawns
      }

      let ok = true;
      for (let diff = 0; diff < 3 && ok; ++diff) {
        if (difficultyEntries[diff]!.has(data.id)) {
          logError("sql", `Table \`creature\` have creature (SpawnId: ${spawnId}) that listed as difficulty ${diff + 1} template (Entry: ${data.id}) in \`creature_template\`, skipped.`);
          ok = false;
        }
      }
      if (!ok) continue;

      // -1 random, 0 no equipment,
      if (data.equipmentId !== 0) {
        const sets = cInfo.equipment;
        const found = data.equipmentId === -1 ? sets.length > 0 : sets.some((set) => set.id === data.equipmentId);
        if (!found) {
          logError("sql", `Table \`creature\` have creature (Entry: ${data.id}) with equipment_id ${data.equipmentId} not found in table \`creature_equip_template\`, set to no equipment.`);
          data.equipmentId = 0;
        }
      }
      if ((cInfoRow?.flags_extra ?? 0) & 0x00000001 /* CREATURE_FLAG_EXTRA_INSTANCE_BIND */) {
        if (!mapEntryIsDungeon(mapEntry.map_type)) {
          logError("sql", `Table \`creature\` have creature (SpawnId: ${spawnId} Entry: ${data.id}) with \`creature_template\`.\`flags_extra\` including CREATURE_FLAG_EXTRA_INSTANCE_BIND but creature are not in instance.`);
        }
      }
      if (data.movementType >= 3 /* MAX_DB_MOTION_TYPE */) {
        logError("sql", `Table \`creature\` has creature (SpawnId: ${spawnId} Entry: ${data.id}) with wrong movement generator type (${data.movementType}), ignored and set to IDLE.`);
        data.movementType = 0; // IDLE_MOTION_TYPE
      }
      if (data.wander_distance < 0.0) {
        logError("sql", `Table \`creature\` have creature (SpawnId: ${spawnId} Entry: ${data.id}) with \`wander_distance\`< 0, set to 0.`);
        data.wander_distance = 0.0;
      } else if (data.movementType === 1 /* RANDOM_MOTION_TYPE */) {
        if (data.wander_distance === 0.0) {
          logError("sql", `Table \`creature\` have creature (SpawnId: ${spawnId} Entry: ${data.id}) with \`MovementType\`=1 (random movement) but with \`wander_distance\`=0, replace by idle movement type (0).`);
          data.movementType = 0; // IDLE_MOTION_TYPE
        }
      } else if (data.movementType === 0 /* IDLE_MOTION_TYPE */) {
        if (data.wander_distance !== 0.0) {
          logError("sql", `Table \`creature\` have creature (SpawnId: ${spawnId} Entry: ${data.id}) with \`MovementType\`=0 (idle) have \`wander_distance\`<>0, set to 0.`);
          data.wander_distance = 0.0;
        }
      }

      if (data.phaseMask === 0) {
        logError("sql", `Table \`creature\` have creature (SpawnId: ${spawnId} Entry: ${data.id}) with \`phaseMask\`=0 (not visible for anyone), set to 1.`);
        data.phaseMask = 1;
      }

      if (sWorld().getBoolConfig(ServerConfig.CONFIG_CALCULATE_CREATURE_ZONE_AREA_DATA)) {
        this.updateSpawnZoneAreaData(WORLD_UPD_CREATURE_ZONE_AREA_DATA, spawnId, data.phaseMask, data.mapid, data.posX, data.posY, data.posZ);
      }

      this._creatureDataStore.set(spawnId, data);

      // Add to grid if not managed by the game event (see the docblock for the shown set)
      if (shown ? shown.has(spawnId) : gameEvent === 0) this.addCreatureToGrid(spawnId, data);

      ++count;
    }

    // Load alternate entries from creature_multispawn
    this.loadCreatureMultispawn();

    log("server", `>> Loaded ${count} Creatures in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }
  /**
   * `sMapMgr->GetZoneId` / `GetAreaId` of a spawn: the `zoneId` and `areaId` columns of `creature` and `gameobject` are
   * filled from the map data when `Calculate.Creature.Zone.Area.Data` / `Calculate.Gameobject.Zone.Area.Data` is on
   * (`WORLD_UPD_CREATURE_ZONE_AREA_DATA`, `WORLD_UPD_GAMEOBJECT_ZONE_AREA_DATA`). The map layer installs the resolver
   * (`MapSetup.setupMaps`); without one, or without a `Map.dbc` row for the map, the row is left alone.
   */
  zoneAreaResolver: ((phaseMask: number, mapId: number, x: number, y: number, z: number) => { zoneid: number; areaid: number } | null) | null = null;

  private updateSpawnZoneAreaData(statement: string, spawnId: number, phaseMask: number, mapId: number, x: number, y: number, z: number): void {
    const resolved = this.zoneAreaResolver?.(phaseMask, mapId, x, y, z) ?? null;
    if (!resolved || !this.worldDb) return;
    executeStatementAsync(this.worldDb, statement, resolved.zoneid, resolved.areaid, spawnId);
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadCreatures (the `creature_multispawn` part: `id2` / `id3`) */
  private loadCreatureMultispawn(): void {
    const tables = this.tables;
    if (!tables || !tables.has(acoreWorld.creature_multispawn)) return;
    const rows = [...tables.all(acoreWorld.creature_multispawn)].sort((a, b) => a.spawnId - b.spawnId);
    if (rows.length === 0) return;
    let variantCount = 0;
    for (const row of rows) {
      const spawnId = row.spawnId;
      const entry = row.entry;
      const data = this._creatureDataStore.get(spawnId);
      if (!data) {
        logError("sql", `Table \`creature_multispawn\` has entry for non-existing creature spawn (SpawnId: ${spawnId}), skipped.`);
        continue;
      }
      const variantInfo = this.getCreatureTemplate(entry);
      if (!variantInfo) {
        logError("sql", `Table \`creature_multispawn\` has creature (SpawnId: ${spawnId}) with non-existing creature entry ${entry}, skipped.`);
        continue;
      }
      // Check difficulty entries for variant
      const isDifficultyEntry = tables
        .all(acoreWorld.creature_template)
        .some((t) => t.difficulty_entry_1 === entry || t.difficulty_entry_2 === entry || t.difficulty_entry_3 === entry);
      if (isDifficultyEntry) {
        logError("sql", `Table \`creature_multispawn\` has creature (SpawnId: ${spawnId}) with entry ${entry} listed as difficulty template in \`creature_template\`, skipped.`);
        continue;
      }
      // Validate equipment for variant entry
      if (data.equipmentId !== 0 && !(data.equipmentId === -1 ? variantInfo.equipment.length > 0 : variantInfo.equipment.some((set) => set.id === data.equipmentId))) {
        logError("sql", `Table \`creature_multispawn\` has creature (SpawnId: ${spawnId}) with entry ${entry} where equipment_id ${data.equipmentId} not found in \`creature_equip_template\`.`);
      }
      // Populate id2/id3 fields
      if (!data.id2) {
        data.id2 = entry;
        ++variantCount;
      } else if (!data.id3) {
        data.id3 = entry;
        ++variantCount;
      } else {
        logError("sql", `Table \`creature_multispawn\` has more than 2 variant entries for creature (SpawnId: ${spawnId}), extra entry ${entry} skipped.`);
      }
    }
    log("server", `>> Loaded ${variantCount} creature spawn variants`);
  }

  /** `_mapObjectGuidsStore[MAKE_PAIR32(mapid, i)][gridCoord.GetId()]`, created on first use. */
  private cellGuids(mapid: number, spawnMode: number, posX: number, posY: number): CellObjectGuids {
    const key = MAKE_PAIR32(mapid, spawnMode);
    let cells = this._mapObjectGuidsStore.get(key);
    if (!cells) {
      cells = new Map();
      this._mapObjectGuidsStore.set(key, cells);
    }
    const gridId = ComputeGridCoord(posX, posY).getId();
    let cell = cells.get(gridId);
    if (!cell) {
      cell = { creatures: new SortedGuidSet(), gameobjects: new SortedGuidSet() };
      cells.set(gridId, cell);
    }
    return cell;
  }

  // @ac-skip Maps: ObjectMgr::AddGOData and ObjectMgr::AddCreData (runtime spawn of `dbData = false` rows; they need
  //   `MapMgr::CreateBaseMap`, `Map::IsGridLoaded`, and `CreatureBaseStats`); the data stores they fill are
  //   `newGOData` / `newOrExistCreatureData` / `addCreatureToGrid` / `addGameobjectToGrid` below.

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::AddCreatureToGrid */
  addCreatureToGrid(guid: number, data: SpawnCreatureData): void {
    let mask = data.spawnMask;
    for (let i = 0; mask !== 0; i++, mask >>= 1) {
      if (mask & 1) this.cellGuids(data.mapid, i, data.posX, data.posY).creatures.insert(guid);
    }
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::RemoveCreatureFromGrid */
  removeCreatureFromGrid(guid: number, data: SpawnCreatureData): void {
    let mask = data.spawnMask;
    for (let i = 0; mask !== 0; i++, mask >>= 1) {
      if (mask & 1) this.cellGuids(data.mapid, i, data.posX, data.posY).creatures.erase(guid);
    }
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::AddGameobjectToGrid */
  addGameobjectToGrid(guid: number, data: SpawnGameObjectData): void {
    let mask = data.spawnMask;
    for (let i = 0; mask !== 0; i++, mask >>= 1) {
      if (mask & 1) this.cellGuids(data.mapid, i, data.posX, data.posY).gameobjects.insert(guid);
    }
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::RemoveGameobjectFromGrid */
  removeGameobjectFromGrid(guid: number, data: SpawnGameObjectData): void {
    let mask = data.spawnMask;
    for (let i = 0; mask !== 0; i++, mask >>= 1) {
      if (mask & 1) this.cellGuids(data.mapid, i, data.posX, data.posY).gameobjects.erase(guid);
    }
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetGridObjectGuids */
  getGridObjectGuids(mapid: number, spawnMode: number, gridId: number): CellObjectGuids {
    return this._mapObjectGuidsStore.get(MAKE_PAIR32(mapid, spawnMode))?.get(gridId) ?? (this._emptyCellObjectGuids ??= { creatures: new SortedGuidSet(), gameobjects: new SortedGuidSet() });
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetMapObjectGuids */
  getMapObjectGuids(mapid: number, spawnMode: number): ReadonlyMap<number, CellObjectGuids> {
    return this._mapObjectGuidsStore.get(MAKE_PAIR32(mapid, spawnMode)) ?? this._emptyCellObjectGuidsMap;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetCreatureData (the `SpawnData` record; see the note at the top of this block) */
  getSpawnCreatureData(spawnId: number): SpawnCreatureData | null {
    return this._creatureDataStore.get(spawnId) ?? null;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetAllCreatureData (the `SpawnData` records) */
  getAllSpawnCreatureData(): ReadonlyMap<number, SpawnCreatureData> {
    return this._creatureDataStore;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetGameObjectData (the `SpawnData` record) */
  getSpawnGameObjectData(spawnId: number): SpawnGameObjectData | null {
    return this._gameObjectDataStore.get(spawnId) ?? null;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetAllGOData (the `SpawnData` records) */
  getAllSpawnGameObjectData(): ReadonlyMap<number, SpawnGameObjectData> {
    return this._gameObjectDataStore;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::GetSpawnData */
  getSpawnData(type: SpawnObjectType, spawnId: number): SpawnData | null {
    switch (type) {
      case SPAWN_TYPE_CREATURE:
        return this.getSpawnCreatureData(spawnId);
      case SPAWN_TYPE_GAMEOBJECT:
        return this.getSpawnGameObjectData(spawnId);
      default:
        return null;
    }
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::NewOrExistCreatureData */
  newOrExistCreatureData(spawnId: number): SpawnCreatureData {
    let data = this._creatureDataStore.get(spawnId);
    if (!data) {
      data = new SpawnCreatureData();
      this._creatureDataStore.set(spawnId, data);
    }
    return data;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::NewGOData */
  newGOData(guid: number): SpawnGameObjectData {
    let data = this._gameObjectDataStore.get(guid);
    if (!data) {
      data = new SpawnGameObjectData();
      this._gameObjectDataStore.set(guid, data);
    }
    return data;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::DeleteCreatureData */
  deleteCreatureData(guid: number): void {
    // remove mapid*cellid -> guid_set map
    const data = this.getSpawnCreatureData(guid);
    if (data) this.removeCreatureFromGrid(guid, data);
    this._creatureDataStore.delete(guid);
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::DeleteGOData */
  deleteGOData(guid: number): void {
    // remove mapid*cellid -> guid_set map
    const data = this.getSpawnGameObjectData(guid);
    if (data) this.removeGameobjectFromGrid(guid, data);
    this._gameObjectDataStore.delete(guid);
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::GenerateCreatureSpawnId */
  generateCreatureSpawnId(): number {
    if (this._creatureSpawnId >= 0xffffff) {
      throw new Error("Creature spawn id overflow!! Can't continue, shutting down server. Search on forum for TCE00007 for more info.");
    }
    return this._creatureSpawnId++;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::GenerateGameObjectSpawnId */
  generateGameObjectSpawnId(): number {
    if (this._gameObjectSpawnId >= 0xffffff) {
      throw new Error("GameObject spawn id overflow!! Can't continue, shutting down server. Search on forum for TCE00007 for more info. ");
    }
    return this._gameObjectSpawnId++;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::SetHighestGuids (the `creature` / `gameobject` spawn id counters) */
  setHighestSpawnIds(): void {
    let creatureMax = 0;
    for (const row of this.tables?.all(creature) ?? []) creatureMax = Math.max(creatureMax, row.guid);
    let gameObjectMax = 0;
    for (const row of this.tables?.all(gameobject) ?? []) gameObjectMax = Math.max(gameObjectMax, row.guid);
    this._creatureSpawnId = creatureMax + 1;
    this._gameObjectSpawnId = gameObjectMax + 1;
  }
  /**
   * @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadGameobjects
   * The grid store gets the spawns `WorldData.gameObjectsOnMap` shows (see `loadCreatures`).
   * @ac-skip Maps: `CONFIG_CALCULATE_GAMEOBJECT_ZONE_AREA_DATA` (writes `zoneId` / `areaId` back through `sMapMgr`)
   */
  loadGameobjects(): void {
    const oldMSTime = getMSTime();
    const tables = this.tables;
    this._gameObjectDataStore.clear();
    if (!tables || tables.all(gameobject).length === 0) {
      log("server", ">> Loaded 0 gameobjects. DB table `gameobject` is empty.");
      return;
    }

    const gameEvents = new Map(tables.all(acoreWorld.game_event_gameobject).map((row) => [row.guid, row.eventEntry]));
    const pools = new Map(tables.all(acoreWorld.pool_gameobject).map((row) => [row.guid, row.pool_entry]));
    const shown = this.shownSpawnIds("gameobject");
    // build single time for check spawnmask
    const spawnMasks = this.buildSpawnMasks();

    for (const row of [...tables.all(gameobject)].sort((a, b) => a.guid - b.guid)) {
      const guid = row.guid;
      const entry = row.id;

      const gInfo = this.getGameObjectTemplate(entry);
      if (!gInfo) {
        logError("sql", `Table \`gameobject\` has gameobject (GUID: ${guid}) with non existing gameobject entry ${entry}, skipped.`);
        continue;
      }

      if (!gInfo.displayId) {
        switch (gInfo.type) {
          case 6: // GAMEOBJECT_TYPE_TRAP
          case 8: // GAMEOBJECT_TYPE_SPELL_FOCUS
            break;
          default:
            logError("sql", `Gameobject (GUID: ${guid} Entry ${entry} GoType: ${gInfo.type}) doesn't have a displayId (${gInfo.displayId}), not loaded.`);
            break;
        }
      }

      if (gInfo.displayId && !sGameObjectDisplayInfoStore.lookupEntry(gInfo.displayId)) {
        logError("sql", `Gameobject (GUID: ${guid} Entry ${entry} GoType: ${gInfo.type}) has an invalid displayId (${gInfo.displayId}), not loaded.`);
        continue;
      }

      const data = new SpawnGameObjectData();
      data.spawnId = guid;
      data.id = entry;
      data.mapid = row.map;
      data.posX = row.position_x;
      data.posY = row.position_y;
      data.posZ = row.position_z;
      data.orientation = row.orientation;
      data.rotation = { x: row.rotation0, y: row.rotation1, z: row.rotation2, w: row.rotation3 };
      data.spawntimesecs = row.spawntimesecs;
      data.ScriptId = this.getScriptId(row.ScriptName ?? "");
      data.spawnGroupId = 0;
      if (!data.ScriptId) data.ScriptId = this.getScriptId(tables.first(gameobject_template, "entry", entry)?.ScriptName ?? "");

      const mapEntry = sMapStore.lookupEntry(data.mapid);
      if (!mapEntry) {
        logError("sql", `Table \`gameobject\` has gameobject (GUID: ${guid} Entry: ${data.id}) spawned on a non-existed map (Id: ${data.mapid}), skip`);
        continue;
      }

      if (data.spawntimesecs === 0 && gameObjectTemplateIsDespawnAtAction(gInfo.type, gInfo.data)) {
        logError("sql", `Table \`gameobject\` has gameobject (GUID: ${guid} Entry: ${data.id}) with \`spawntimesecs\` (0) value, but the gameobejct is marked as despawnable at action.`);
      }

      data.animprogress = row.animprogress;
      data.artKit = 0;

      const go_state = row.state;
      if (go_state >= MAX_GO_STATE) {
        logError("sql", `Table \`gameobject\` has gameobject (GUID: ${guid} Entry: ${data.id}) with invalid \`state\` (${go_state}) value, skip`);
        continue;
      }
      data.go_state = go_state;

      data.spawnMask = row.spawnMask;

      if (!this.isTransportMap(data.mapid)) {
        if (data.spawnMask & ~(spawnMasks.get(data.mapid) ?? 0)) {
          logError("sql", `Table \`gameobject\` has gameobject (GUID: ${guid} Entry: ${data.id}) that has wrong spawn mask ${data.spawnMask} including not supported difficulty modes for map (Id: ${data.mapid}), skip`);
        }
      } else {
        data.spawnGroupId = 1; // force compatibility group for transport spawns
      }

      data.phaseMask = row.phaseMask;
      const gameEvent = gameEvents.get(guid) ?? 0;
      data.poolId = pools.get(guid) ?? 0;

      const r = data.rotation;
      if (r.x < -1.0 || r.x > 1.0) {
        logError("sql", `Table \`gameobject\` has gameobject (GUID: ${guid} Entry: ${data.id}) with invalid rotationX (${r.x}) value, skip`);
        continue;
      }
      if (r.y < -1.0 || r.y > 1.0) {
        logError("sql", `Table \`gameobject\` has gameobject (GUID: ${guid} Entry: ${data.id}) with invalid rotationY (${r.y}) value, skip`);
        continue;
      }
      if (r.z < -1.0 || r.z > 1.0) {
        logError("sql", `Table \`gameobject\` has gameobject (GUID: ${guid} Entry: ${data.id}) with invalid rotationZ (${r.z}) value, skip`);
        continue;
      }
      if (r.w < -1.0 || r.w > 1.0) {
        logError("sql", `Table \`gameobject\` has gameobject (GUID: ${guid} Entry: ${data.id}) with invalid rotationW (${r.w}) value, skip`);
        continue;
      }

      if (Math.abs(r.x * r.x + r.y * r.y + r.z * r.z + r.w * r.w - 1.0) >= 1e-5) {
        logError("sql", `Table \`gameobject\` has gameobject (GUID: ${guid} Entry: ${data.id}) with invalid rotation quaternion (non-unit), defaulting to orientation on Z axis only`);
        data.rotation = QuaternionDataFromEulerAnglesZYX(data.orientation, 0.0, 0.0);
      }

      if (!isValidMapCoord(data.mapid, data.posX, data.posY, data.posZ, data.orientation)) {
        logError("sql", `Table \`gameobject\` has gameobject (GUID: ${guid} Entry: ${data.id}) with invalid coordinates, skip`);
        continue;
      }

      if (data.phaseMask === 0) {
        logError("sql", `Table \`gameobject\` has gameobject (GUID: ${guid} Entry: ${data.id}) with \`phaseMask\`=0 (not visible for anyone), set to 1.`);
        data.phaseMask = 1;
      }

      if (sWorld().getBoolConfig(ServerConfig.CONFIG_CALCULATE_GAMEOBJECT_ZONE_AREA_DATA)) {
        this.updateSpawnZoneAreaData(WORLD_UPD_GAMEOBJECT_ZONE_AREA_DATA, guid, data.phaseMask, data.mapid, data.posX, data.posY, data.posZ);
      }

      this._gameObjectDataStore.set(guid, data);

      // if not this is to be managed by GameEvent System (see the docblock for the shown set)
      if (shown ? shown.has(guid) : gameEvent === 0) this.addGameobjectToGrid(guid, data);
    }

    log("server", `>> Loaded ${this._gameObjectDataStore.size} Gameobjects in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::IsGameObjectStaticTransport */
  isGameObjectStaticTransport(entry: number): boolean {
    const goinfo = this.getGameObjectTemplate(entry);
    return goinfo !== null && goinfo.type === 11; // GAMEOBJECT_TYPE_TRANSPORT
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadSpawnGroupTemplates */
  loadSpawnGroupTemplates(): void {
    const oldMSTime = getMSTime();

    this._spawnGroupDataStore.clear();

    for (const row of this.tables?.all(acoreWorld.spawn_group_template) ?? []) {
      const groupId = row.groupId;
      const group: SpawnGroupTemplateData = { groupId, name: row.groupName, mapId: SPAWNGROUP_MAP_UNSET, flags: 0 };
      this._spawnGroupDataStore.set(groupId, group);
      let flags = row.groupFlags;
      if (flags & ~SPAWNGROUP_FLAG_ALL) {
        flags &= SPAWNGROUP_FLAG_ALL;
        logError("sql", `Invalid spawn group flag ${row.groupFlags} on group ID ${groupId} (${group.name}), reduced to valid flags ${flags}.`);
      }
      if (flags & SPAWNGROUP_FLAG_SYSTEM && flags & SPAWNGROUP_FLAG_MANUAL_SPAWN) {
        flags &= ~SPAWNGROUP_FLAG_MANUAL_SPAWN;
        logError("sql", `System spawn group ${groupId} (${group.name}) has invalid manual spawn flag. Ignored.`);
      }
      group.flags = flags;
    }

    if (!this._spawnGroupDataStore.has(0)) {
      logError("sql", "Default spawn group (index 0) is missing from DB! Manually inserted.");
      this._spawnGroupDataStore.set(0, { groupId: 0, name: "Default Group", mapId: SPAWNGROUP_MAP_UNSET, flags: SPAWNGROUP_FLAG_SYSTEM });
    }
    if (!this._spawnGroupDataStore.has(1)) {
      logError("sql", "Default legacy spawn group (index 1) is missing from DB! Manually inserted.");
      this._spawnGroupDataStore.set(1, { groupId: 1, name: "Legacy Group", mapId: SPAWNGROUP_MAP_UNSET, flags: SPAWNGROUP_FLAG_SYSTEM | SPAWNGROUP_FLAG_COMPATIBILITY_MODE });
    }

    log("server", `>> Loaded ${this._spawnGroupDataStore.size} spawn group templates in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /**
   * @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadSpawnGroups
   * @ac-skip Pools: the "also part of pool" warning uses `sPoolMgr->IsPartOfAPool`; here it reads `SpawnData::poolId`.
   */
  loadSpawnGroups(): void {
    const oldMSTime = getMSTime();

    // Reset prior state for hot-reload support
    // Preserve the forced legacy group for spawns on transport maps (set in LoadCreatures/LoadGameobjects).
    this._spawnGroupMapStore.clear();
    for (const data of this._creatureDataStore.values()) data.spawnGroupId = this.isTransportMap(data.mapid) ? 1 : 0;
    for (const data of this._gameObjectDataStore.values()) data.spawnGroupId = this.isTransportMap(data.mapid) ? 1 : 0;

    const rows = this.tables?.all(acoreWorld.spawn_group) ?? [];
    if (rows.length === 0) {
      log("server", ">> Loaded 0 spawn group members. DB table `spawn_group` is empty.");
      return;
    }

    let numMembers = 0;
    for (const row of rows) {
      const groupId = row.groupId;
      const type = row.spawnType;
      if (type >= SPAWN_TYPE_MAX) {
        logError("sql", `Spawn data with invalid type ${type} listed for spawn group ${groupId}. Skipped.`);
        continue;
      }
      const spawnType = type as SpawnObjectType;
      const spawnId = row.spawnId;

      const data = this.getSpawnData(spawnType, spawnId);
      if (!data) {
        logError("sql", `Spawn data with ID (${spawnType},${spawnId}) not found, but is listed as a member of spawn group ${groupId}!`);
        continue;
      }
      if (data.spawnGroupId) {
        logError("sql", `Spawn with ID (${spawnType},${spawnId}) is listed as a member of spawn group ${groupId}, but is already a member of spawn group ${data.spawnGroupId}. Skipping.`);
        continue;
      }

      const groupTemplate = this._spawnGroupDataStore.get(groupId);
      if (!groupTemplate) {
        logError("sql", `Spawn group ${groupId} assigned to spawn ID (${spawnType},${spawnId}), but group is not found!`);
        continue;
      }

      if (groupTemplate.mapId === SPAWNGROUP_MAP_UNSET) {
        groupTemplate.mapId = data.mapid;
      } else if (groupTemplate.mapId !== data.mapid && !(groupTemplate.flags & SPAWNGROUP_FLAG_SYSTEM)) {
        logError("sql", `Spawn group ${groupId} has map ID ${groupTemplate.mapId}, but spawn (${spawnType},${spawnId}) has map id ${data.mapid} - spawn NOT added to group!`);
        continue;
      }

      // Warn if spawn is also in a pool (non-system groups and pools are mutually exclusive)
      if (!(groupTemplate.flags & SPAWNGROUP_FLAG_SYSTEM) && data.poolId) {
        log("sql", `Spawn (${spawnType},${spawnId}) is a member of spawn group ${groupId} and also part of pool ${data.poolId}. This may cause issues!`);
      }

      data.spawnGroupId = groupId;
      if (!(groupTemplate.flags & SPAWNGROUP_FLAG_SYSTEM)) {
        const list = this._spawnGroupMapStore.get(groupId) ?? [];
        list.push(data);
        this._spawnGroupMapStore.set(groupId, list);
      }
      ++numMembers;
    }

    log("server", `>> Loaded ${numMembers} spawn group members in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetSpawnGroupData */
  getSpawnGroupData(groupId: number): SpawnGroupTemplateData | null {
    return this._spawnGroupDataStore.get(groupId) ?? null;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetDefaultSpawnGroup */
  getDefaultSpawnGroup(): SpawnGroupTemplateData {
    return this._spawnGroupDataStore.get(0)!;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetLegacySpawnGroup */
  getLegacySpawnGroup(): SpawnGroupTemplateData {
    return this._spawnGroupDataStore.get(1)!;
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetSpawnDataForGroup (the `equal_range`) */
  getSpawnDataForGroup(groupId: number): readonly SpawnData[] {
    return this._spawnGroupMapStore.get(groupId) ?? [];
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::OnDeleteSpawnData */
  onDeleteSpawnData(data: SpawnData): void {
    const template = this._spawnGroupDataStore.get(data.spawnGroupId);
    if (!template) throw new Error(`Spawn data is being deleted and has invalid spawn group index ${data.spawnGroupId}!`);
    if (template.flags & SPAWNGROUP_FLAG_SYSTEM) return;

    const list = this._spawnGroupMapStore.get(data.spawnGroupId) ?? [];
    const index = list.indexOf(data);
    if (index >= 0) {
      list.splice(index, 1);
      return;
    }
    throw new Error(`Spawn data being removed is member of spawn group ${data.spawnGroupId}, but not found in lookup table!`);
  }
  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadLinkedRespawn */
  loadLinkedRespawn(): void {
    const oldMSTime = getMSTime();

    this._linkedRespawnStore.clear();
    const rows = [...(this.tables?.all(acoreWorld.linked_respawn) ?? [])].sort((a, b) => a.guid - b.guid);
    if (rows.length === 0) {
      log("server", ">> Loaded 0 linked respawns. DB table `linked_respawn` is empty.");
      return;
    }

    for (const row of rows) {
      const guidLow = row.guid;
      const linkedGuidLow = row.linkedGuid;
      const linkType = row.linkType;

      // CreatureLinkedRespawnType: CREATURE_TO_CREATURE, CREATURE_TO_GO, GO_TO_GO, GO_TO_CREATURE
      const slaveIsCreature = linkType === CREATURE_TO_CREATURE || linkType === CREATURE_TO_GO;
      const masterIsCreature = linkType === CREATURE_TO_CREATURE || linkType === GO_TO_CREATURE;
      if (linkType > GO_TO_CREATURE) continue; // C++ switch has no default: no entry is stored
      const slaveName = slaveIsCreature ? "Creature" : "Gameobject";
      const masterName = masterIsCreature ? "Creature" : "Gameobject";

      const slave = slaveIsCreature ? this.getSpawnCreatureData(guidLow) : this.getSpawnGameObjectData(guidLow);
      if (!slave) {
        logError("sql", `LinkedRespawn: ${slaveName} (guid) ${guidLow} not found in ${slaveIsCreature ? "creature" : "gameobject"} table`);
        continue;
      }

      const master = masterIsCreature ? this.getSpawnCreatureData(linkedGuidLow) : this.getSpawnGameObjectData(linkedGuidLow);
      if (!master) {
        logError("sql", `LinkedRespawn: ${masterName} (linkedGuid) ${linkedGuidLow} not found in ${masterIsCreature ? "creature" : "gameobject"} table`);
        continue;
      }

      const map = sMapStore.lookupEntry(master.mapid);
      if (!map || !mapEntryInstanceable(map.map_type) || master.mapid !== slave.mapid) {
        logError("sql", `LinkedRespawn: ${slaveName} '${guidLow}' linking to ${masterName} '${linkedGuidLow}' on an unpermitted map.`);
        continue;
      }

      if (!(master.spawnMask & slave.spawnMask)) {
        // they must have a possibility to meet (normal/heroic difficulty)
        logError("sql", `LinkedRespawn: ${slaveName} '${guidLow}' linking to ${masterName} '${linkedGuidLow}' with not corresponding spawnMask`);
        continue;
      }

      const guid = ObjectGuid.Create(slaveIsCreature ? HighGuid.Unit : HighGuid.GameObject, (slave as SpawnCreatureData | SpawnGameObjectData).id, guidLow);
      const linkedGuid = ObjectGuid.Create(masterIsCreature ? HighGuid.Unit : HighGuid.GameObject, (master as SpawnCreatureData | SpawnGameObjectData).id, linkedGuidLow);
      this._linkedRespawnStore.set(guid, linkedGuid);
    }

    log("server", `>> Loaded ${this._linkedRespawnStore.size} Linked Respawns In ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetLinkedRespawnGuid */
  getLinkedRespawnGuid(guid: bigint): bigint {
    return this._linkedRespawnStore.get(guid) ?? ObjectGuid.Empty;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::SetCreatureLinkedRespawn */
  setCreatureLinkedRespawn(guidLow: number, linkedGuidLow: number): boolean {
    if (!guidLow) return false;

    const master = this.getSpawnCreatureData(guidLow);
    if (!master) return false;
    const guid = ObjectGuid.Create(HighGuid.Unit, master.id, guidLow);

    if (!linkedGuidLow) {
      // we're removing the linking
      this._linkedRespawnStore.delete(guid);
      if (this.worldDb) executeStatementAsync(this.worldDb, WORLD_DEL_CRELINKED_RESPAWN, guidLow);
      return true;
    }

    const slave = this.getSpawnCreatureData(linkedGuidLow);
    if (!slave) {
      logError("sql", `Creature '${guidLow}' linking to non-existent creature '${linkedGuidLow}'.`);
      return false;
    }

    const map = sMapStore.lookupEntry(master.mapid);
    if (!map || !mapEntryInstanceable(map.map_type) || master.mapid !== slave.mapid) {
      logError("sql", `Creature '${guidLow}' linking to '${linkedGuidLow}' on an unpermitted map.`);
      return false;
    }

    if (!(master.spawnMask & slave.spawnMask)) {
      // they must have a possibility to meet (normal/heroic difficulty)
      logError("sql", `LinkedRespawn: Creature '${guidLow}' linking to '${linkedGuidLow}' with not corresponding spawnMask`);
      return false;
    }

    const linkedGuid = ObjectGuid.Create(HighGuid.Unit, slave.id, linkedGuidLow);

    this._linkedRespawnStore.set(guid, linkedGuid);
    if (this.worldDb) executeStatementAsync(this.worldDb, WORLD_REP_CREATURE_LINKED_RESPAWN, guidLow, linkedGuidLow);
    return true;
  }

  /**
   * The shared body of `LoadCreatureTemplateAddons` and `LoadCreatureAddons` for one row (`what` names the key in the
   * log, `table` the table).
   */
  private creatureAddonFromRow(
    row: { path_id: number; mount: number; bytes1: number; bytes2: number; emote: number; visibilityDistanceType: number; auras: string | null },
    what: string,
    table: string,
  ): CreatureAddon {
    const creatureAddon: CreatureAddon = {
      path_id: row.path_id,
      mount: row.mount,
      bytes1: row.bytes1,
      bytes2: row.bytes2,
      emote: row.emote,
      auras: [],
      visibilityDistanceType: row.visibilityDistanceType as CreatureAddon["visibilityDistanceType"],
    };

    for (const aura of (row.auras ?? "").split(" ").filter((token) => token !== "")) {
      const spellId = /^\d+$/.test(aura) ? Number(aura) : null;
      const spellInfo = spellId !== null ? sSpellMgr.getSpellInfo(spellId) : null;
      if (!spellInfo) {
        logError("sql", `Creature (${what}) has wrong spell '${aura}' defined in \`auras\` field in \`${table}\`.`);
        continue;
      }
      if (creatureAddon.auras.includes(spellId!)) {
        logError("sql", `Creature (${what}) has duplicate aura (spell ${spellId}) in \`auras\` field in \`${table}\`.`);
        continue;
      }
      if (spellDuration(spellInfo) > 0) {
        log("sql", `Creature (${what}) has temporary aura (spell ${spellId}) in \`auras\` field in \`${table}\`.`);
      }
      creatureAddon.auras.push(spellId!);
    }

    if (creatureAddon.mount) {
      if (!sCreatureDisplayInfoStore.lookupEntry(creatureAddon.mount)) {
        logError("sql", `Creature (${what}) has invalid displayInfoId (${creatureAddon.mount}) for mount defined in \`${table}\``);
        creatureAddon.mount = 0;
      }
    }

    if (!sEmotesStore.lookupEntry(creatureAddon.emote)) {
      logError("sql", `Creature (${what}) has invalid emote (${creatureAddon.emote}) defined in \`creature_addon\`.`);
      creatureAddon.emote = 0;
    }

    if (creatureAddon.visibilityDistanceType >= VisibilityDistanceType.Max) {
      logError("sql", `Creature (${what}) has invalid visibilityDistanceType (${creatureAddon.visibilityDistanceType}) defined in \`${table}\`.`);
      creatureAddon.visibilityDistanceType = VisibilityDistanceType.Normal;
    }
    return creatureAddon;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadCreatureTemplateAddons */
  loadCreatureTemplateAddons(): void {
    const oldMSTime = getMSTime();
    this._creatureTemplateAddonStore.clear();
    let count = 0;
    for (const row of this.tables?.all(acoreWorld.creature_template_addon) ?? []) {
      const entry = row.entry;
      if (!this.getCreatureTemplate(entry)) {
        logError("sql", `Creature template (Entry: ${entry}) does not exist but has a record in \`creature_template_addon\``);
        continue;
      }
      this._creatureTemplateAddonStore.set(entry, this.creatureAddonFromRow(row, `Entry: ${entry}`, "creature_template_addon"));
      ++count;
    }
    log("server", `>> Loaded ${count} Creature Template Addons in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadCreatureAddons */
  loadCreatureAddons(): void {
    const oldMSTime = getMSTime();
    this._creatureAddonStore.clear();
    let count = 0;
    for (const row of this.tables?.all(acoreWorld.creature_addon) ?? []) {
      const guid = row.guid;
      const creData = this.getSpawnCreatureData(guid);
      if (!creData) {
        logError("sql", `Creature (GUID: ${guid}) does not exist but has a record in \`creature_addon\``);
        continue;
      }
      if (creData.movementType === 2 /* WAYPOINT_MOTION_TYPE */ && !row.path_id) {
        creData.movementType = 0; // IDLE_MOTION_TYPE
        logError("sql", `Creature (GUID ${guid}) has movement type set to WAYPOINT_MOTION_TYPE but no path assigned`);
      }
      this._creatureAddonStore.set(guid, this.creatureAddonFromRow(row, `GUID: ${guid}`, "creature_addon"));
      ++count;
    }
    log("server", `>> Loaded ${count} Creature Addons in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /**
   * @ac game/Globals/ObjectMgr.cpp ObjectMgr::CheckCreatureMovement
   * The values past `Max` are reset to the defaults, as the C++ does for a bad row.
   */
  checkCreatureMovement(table: string, id: number, creatureMovement: CreatureMovementData): void {
    if (creatureMovement.Ground >= CreatureGroundMovementType.Max) {
      logError("sql", `\`${table}\`.\`Ground\` wrong value (${creatureMovement.Ground}) for Id ${id}, setting to Run.`);
      creatureMovement.Ground = CreatureGroundMovementType.Run;
    }

    if (creatureMovement.Flight >= CreatureFlightMovementType.Max) {
      logError("sql", `\`${table}\`.\`Flight\` wrong value (${creatureMovement.Flight}) for Id ${id}, setting to None.`);
      creatureMovement.Flight = CreatureFlightMovementType.None;
    }

    if (creatureMovement.Chase >= CreatureChaseMovementType.Max) {
      logError("sql", `\`${table}\`.\`Chase\` wrong value (${creatureMovement.Chase}) for Id ${id}, setting to Run.`);
      creatureMovement.Chase = CreatureChaseMovementType.Run;
    }

    if (creatureMovement.Random >= CreatureRandomMovementType.Max) {
      logError("sql", `\`${table}\`.\`Random\` wrong value (${creatureMovement.Random}) for Id ${id}, setting to Walk.`);
      creatureMovement.Random = CreatureRandomMovementType.Walk;
    }
  }

  /**
   * @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadCreatureTemplate (the `creature_template_movement` join: `ctm.Ground` ... `ctm.InteractionPauseTimer`;
   * a NULL column keeps the `CreatureMovementData()` default) and `CheckCreatureTemplate` (`CheckCreatureMovement("creature_template_movement", ...)`)
   */
  loadCreatureTemplateMovement(): void {
    this._creatureTemplateMovementStore.clear();
    for (const row of this.tables?.all(acoreWorld.creature_template_movement) ?? []) {
      if (!this.tables?.first(acoreWorld.creature_template, "entry", row.CreatureId)) continue;
      const movement = new CreatureMovementData();
      if (row.Ground !== null) movement.Ground = row.Ground;
      movement.Swim = (row.Swim ?? 0) !== 0; // `fields[44].Get<bool>()`: NULL reads as false
      if (row.Flight !== null) movement.Flight = row.Flight;
      movement.Rooted = (row.Rooted ?? 0) !== 0;
      if (row.Chase !== null) movement.Chase = row.Chase;
      if (row.Random !== null) movement.Random = row.Random;
      if (row.InteractionPauseTimer !== null) movement.InteractionPauseTimer = row.InteractionPauseTimer;
      this.checkCreatureMovement("creature_template_movement", row.CreatureId, movement);
      this._creatureTemplateMovementStore.set(row.CreatureId, movement);
    }
  }

  /**
   * `CreatureTemplate::Movement` of a template. The loader's `LEFT JOIN creature_template_movement` always yields a row: for a template without
   * a `creature_template_movement` row every `ctm.*` column is NULL, so `Ground`, `Flight`, `Chase`, `Random` and `InteractionPauseTimer` keep the
   * `CreatureMovementData()` defaults, while `Swim` and `Rooted` are assigned unconditionally (`Get<bool>()` of NULL is false).
   */
  getCreatureTemplateMovement(entry: number): CreatureMovementData {
    const found = this._creatureTemplateMovementStore.get(entry);
    if (found) return found;
    const movement = new CreatureMovementData();
    movement.Swim = false;
    movement.Rooted = false;
    this._creatureTemplateMovementStore.set(entry, movement);
    return movement;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::GetCreatureMovementOverride */
  getCreatureMovementOverride(spawnId: number): CreatureMovementData | null {
    return this._creatureMovementOverrides.get(spawnId) ?? null;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadCreatureMovementOverrides */
  loadCreatureMovementOverrides(): void {
    const oldMSTime = getMSTime();
    this._creatureMovementOverrides.clear();

    // `COALESCE(cmo.X, ctm.X)` over `creature_movement_override` LEFT JOIN `creature` LEFT JOIN `creature_template_movement`
    const rows = this.tables?.all(acoreWorld.creature_movement_override) ?? [];
    if (rows.length === 0) {
      log("server", ">> Loaded 0 creature movement overrides. DB table `creature_movement_override` is empty!");
      return;
    }

    for (const row of rows) {
      const spawnId = row.SpawnId;
      const creatureRow = this.tables?.first(acoreWorld.creature, "guid", spawnId) ?? null;
      const ctm = creatureRow ? (this.tables?.first(acoreWorld.creature_template_movement, "CreatureId", creatureRow.id) ?? null) : null;
      if (!this.getSpawnCreatureData(spawnId)) {
        logError("sql", `Creature (GUID: ${spawnId}) does not exist but has a record in \`creature_movement_override\``);
        continue;
      }

      const movement = new CreatureMovementData();
      const ground = row.Ground ?? ctm?.Ground ?? null;
      const swim = row.Swim ?? ctm?.Swim ?? null;
      const flight = row.Flight ?? ctm?.Flight ?? null;
      const rooted = row.Rooted ?? ctm?.Rooted ?? null;
      const chase = row.Chase ?? ctm?.Chase ?? null;
      const random = row.Random ?? ctm?.Random ?? null;
      const pause = row.InteractionPauseTimer ?? ctm?.InteractionPauseTimer ?? null;
      if (ground !== null) movement.Ground = ground;
      if (swim !== null) movement.Swim = swim !== 0;
      if (flight !== null) movement.Flight = flight;
      if (rooted !== null) movement.Rooted = rooted !== 0;
      if (chase !== null) movement.Chase = chase;
      if (random !== null) movement.Random = random;
      if (pause !== null) movement.InteractionPauseTimer = pause;

      this.checkCreatureMovement("creature_movement_override", spawnId, movement);
      this._creatureMovementOverrides.set(spawnId, movement);
    }

    log("server", `>> Loaded ${this._creatureMovementOverrides.size} Movement Overrides in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadGameObjectAddons */
  loadGameObjectAddons(): void {
    const oldMSTime = getMSTime();
    this._gameObjectAddonStore.clear();
    let count = 0;
    for (const row of this.tables?.all(acoreWorld.gameobject_addon) ?? []) {
      const guid = row.guid;
      if (!this.getSpawnGameObjectData(guid)) {
        logError("sql", `GameObject (GUID: ${guid}) does not exist but has a record in \`gameobject_addon\``);
        continue;
      }
      const gameObjectAddon: GameObjectAddon = {
        ParentRotation: { x: row.parent_rotation0, y: row.parent_rotation1, z: row.parent_rotation2, w: row.parent_rotation3 },
        invisibilityType: row.invisibilityType,
        InvisibilityValue: row.invisibilityValue,
      };
      if (gameObjectAddon.invisibilityType >= 12 /* TOTAL_INVISIBILITY_TYPES */) {
        logError("sql", `GameObject (GUID: ${guid}) has invalid InvisibilityType in \`gameobject_addon\``);
        gameObjectAddon.invisibilityType = 0; // INVISIBILITY_GENERAL
        gameObjectAddon.InvisibilityValue = 0;
      }
      if (gameObjectAddon.invisibilityType && !gameObjectAddon.InvisibilityValue) {
        logError("sql", `GameObject (GUID: ${guid}) has InvisibilityType set but has no InvisibilityValue in \`gameobject_addon\`, set to 1`);
        gameObjectAddon.InvisibilityValue = 1;
      }
      if (!QuaternionDataIsUnit(gameObjectAddon.ParentRotation)) {
        logError("sql", `GameObject (GUID: ${guid}) has invalid parent rotation in \`gameobject_addon\`, set to default`);
        gameObjectAddon.ParentRotation = { x: 0, y: 0, z: 0, w: 1 };
      }
      this._gameObjectAddonStore.set(guid, gameObjectAddon);
      ++count;
    }
    log("server", `>> Loaded ${count} Gameobject Addons in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadGameObjectTemplateAddons */
  loadGameObjectTemplateAddons(): void {
    const oldMSTime = getMSTime();
    this._gameObjectTemplateAddonStore.clear();
    const rows = this.tables?.all(acoreWorld.gameobject_template_addon) ?? [];
    if (rows.length === 0) {
      log("server", ">> Loaded 0 gameobject template addon definitions. DB table `gameobject_template_addon` is empty.");
      return;
    }

    let count = 0;
    for (const row of rows) {
      const entry = row.entry;
      const got = this.getGameObjectTemplate(entry);
      if (!got) {
        logError("sql", `GameObject template (Entry: ${entry}) does not exist but has a record in \`gameobject_template_addon\``);
        continue;
      }

      const gameObjectAddon: GameObjectTemplateAddon = {
        entry,
        faction: row.faction,
        flags: row.flags,
        mingold: row.mingold,
        maxgold: row.maxgold,
        artKits: [0, 0, 0, 0],
      };

      const artKits = [row.artkit0, row.artkit1, row.artkit2, row.artkit3];
      for (let i = 0; i < artKits.length; i++) {
        const artKitID = artKits[i]!;
        if (!artKitID) continue;

        if (!sGameObjectArtKitStore.lookupEntry(artKitID)) {
          logError("sql", `GameObject (Entry: ${entry}) has invalid \`artkit${i}\` ${artKitID} defined, set to zero instead.`);
          continue;
        }

        gameObjectAddon.artKits[i] = artKitID;
      }

      // checks
      if (gameObjectAddon.faction && !sFactionTemplateStore.lookupEntry(gameObjectAddon.faction)) {
        logError("sql", `GameObject (Entry: ${entry}) has invalid faction (${gameObjectAddon.faction}) defined in \`gameobject_template_addon\`.`);
      }

      if (gameObjectAddon.maxgold > 0) {
        switch (got.type) {
          case 3: // GAMEOBJECT_TYPE_CHEST
          case 25: // GAMEOBJECT_TYPE_FISHINGHOLE
            break;
          default:
            logError("sql", `GameObject (Entry ${entry} GoType: ${got.type}) cannot be looted but has maxgold set in \`gameobject_template_addon\`.`);
            break;
        }
      }

      this._gameObjectTemplateAddonStore.set(entry, gameObjectAddon);
      ++count;
    }

    log("server", `>> Loaded ${count} Game Object Template Addons in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** @ac game/Globals/ObjectMgr.h ObjectMgr::GetGameObjectTemplateAddon */
  getGameObjectTemplateAddon(entry: number): GameObjectTemplateAddon | null {
    return this._gameObjectTemplateAddonStore.get(entry) ?? null;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::GetGameObjectAddon */
  getGameObjectAddon(lowguid: number): GameObjectAddon | null {
    return this._gameObjectAddonStore.get(lowguid) ?? null;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::GetCreatureAddon */
  getCreatureAddon(lowguid: number): CreatureAddon | null {
    return this._creatureAddonStore.get(lowguid) ?? null;
  }

  /** @ac game/Globals/ObjectMgr.cpp ObjectMgr::GetCreatureTemplateAddon */
  getCreatureTemplateAddon(entry: number): CreatureAddon | null {
    return this._creatureTemplateAddonStore.get(entry) ?? null;
  }

  /**
   * The spawn loaders in `World::SetInitialWorldSettings` order: the spawn id counters (`SetHighestGuids`),
   * `LoadScriptNames`, `LoadGameObjectTemplateAddons` (after `LoadGameObjectTemplate`), `LoadCreatureTemplateAddons`, `LoadSpawnGroupTemplates`, `LoadCreatures`, `LoadCreatureAddons`,
   * `LoadGameobjects`, `LoadSpawnGroups`, `LoadGameObjectAddons`, `LoadLinkedRespawn`.
   * `LoadCreatureMovementOverrides` runs between `LoadCreatureAddons` and `LoadGameobjects`; `creature_template_movement` joins the template
   * (`loadCreatureTemplateMovement`).
   */
  loadSpawnStores(): void {
    // a reload starts from empty stores (`_mapObjectGuidsStore` is only ever filled by the loaders below)
    this._mapObjectGuidsStore.clear();
    this.setHighestSpawnIds();
    this.loadScriptNames();
    this.loadGameObjectTemplateAddons();
    this.loadCreatureTemplateMovement();
    this.loadCreatureTemplateAddons();
    this.loadSpawnGroupTemplates();
    this.loadCreatures();
    this.loadCreatureAddons();
    this.loadCreatureMovementOverrides();
    this.loadGameobjects();
    this.loadSpawnGroups();
    this.loadGameObjectAddons();
    this.loadLinkedRespawn();
  }
  // ---- end of spawn stores ----
}

/** `CreatureData`: a `creature` row. */
export type CreatureData = Row<typeof creature>;
/** @ac game/Entities/Creature/CreatureData.h CreatureLocale */
export type CreatureLocale = { Name: string[]; Title: string[] };
/** @ac game/Entities/GameObject/GameObjectData.h GameObjectLocale */
export type GameObjectLocale = { Name: string[]; CastBarCaption: string[] };
/** @ac game/Entities/Item/ItemTemplate.h ItemLocale */
export type ItemLocale = { Name: string[]; Description: string[] };
/** @ac game/Quests/QuestDef.h QuestLocale (the title) */
export type QuestLocale = { Title: string[] };

/** `ResponseCodes` for names */
export const CHAR_NAME_SUCCESS = 0x57;
export const CHAR_NAME_TOO_SHORT = 0x5a;
export const CHAR_NAME_TOO_LONG = 0x5b;
export const CHAR_NAME_MIXED_LANGUAGES = 0x5d;
export const CHAR_NAME_PROFANE = 0x5e;
export const CHAR_NAME_RESERVED = 0x5f;
export const CHAR_NAME_THREE_CONSECUTIVE = 0x62;
const MAX_PLAYER_NAME = 12;

/**
 * @ac game/Globals/ObjectMgr.cpp isValidString
 * `strictMask & 0x2` (realm zone languages) accepts every language: `CONFIG_REALM_ZONE` language types are not ported.
 */
function isValidString(wstr: string, strictMask: number, numericOrSpace: boolean, _create: boolean): boolean {
  const any = (): boolean => isExtendedLatinString(wstr, numericOrSpace) || isCyrillicString(wstr, numericOrSpace) || isEastAsianString(wstr, numericOrSpace);
  if (strictMask === 0) return any(); // any language, ignore realm
  if (strictMask & 0x2 && any()) return true; // realm zone specific
  if (strictMask & 0x1 && isBasicLatinString(wstr, numericOrSpace)) return true; // basic Latin
  return false;
}

/** `ObjectMgr::AddLocaleString`: one string per `LocaleConstant`, from the `locale` column (`GetLocaleByName`). */
function byLocale<R extends { locale: string }>(rows: readonly R[], value: (row: R) => string | null): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const locale = GetLocaleByName(row.locale);
    if (locale === DEFAULT_LOCALE) continue;
    out[locale] = value(row) ?? "";
  }
  return out;
}
/** `GameObjectData`: a `gameobject` row. */
export type GameObjectData = Row<typeof gameobject>;

export const sObjectMgr = new ObjectMgr();

// ---- Spawn stores (Maps topic): module-level parts ----

/**
 * @ac game/Globals/ObjectMgr.h CellGuidSet (`std::set<ObjectGuid::LowType>`)
 * Iterates in ascending order like `std::set`; the sorted order is rebuilt lazily after a change.
 */
export class SortedGuidSet implements Iterable<number> {
  private readonly guids = new Set<number>();
  private sorted: number[] | null = [];

  /** `std::set::insert` */
  insert(guid: number): void {
    if (this.guids.has(guid)) return;
    this.guids.add(guid);
    this.sorted = null;
  }

  /** `std::set::erase` */
  erase(guid: number): void {
    if (this.guids.delete(guid)) this.sorted = null;
  }

  /** `std::set::count` */
  has(guid: number): boolean {
    return this.guids.has(guid);
  }

  /** `std::set::size` */
  get size(): number {
    return this.guids.size;
  }

  [Symbol.iterator](): Iterator<number> {
    this.sorted ??= [...this.guids].sort((a, b) => a - b);
    return this.sorted[Symbol.iterator]();
  }
}

/** @ac game/Globals/ObjectMgr.h CellObjectGuids */
export interface CellObjectGuids {
  creatures: SortedGuidSet;
  gameobjects: SortedGuidSet;
}

/** @ac shared/SharedDefines.h MAKE_PAIR32 */
export function MAKE_PAIR32(l: number, h: number): number {
  return ((l & 0xffff) | ((h & 0xffff) << 16)) >>> 0;
}

/** @ac game/Globals/ObjectMgr.h ObjectMgr::CreatureLinkedRespawnType */
export const CREATURE_TO_CREATURE = 0;
export const CREATURE_TO_GO = 1; // Creature is dependant on GO
export const GO_TO_GO = 2;
export const GO_TO_CREATURE = 3; // GO is dependant on creature

/** @ac shared/DataStores/DBCEnums.h MapTypes */
const MAP_INSTANCE = 1; // party
const MAP_RAID = 2; // raid
const MAP_BATTLEGROUND = 3; // pvp
const MAP_ARENA = 4; // arena

/** @ac shared/DataStores/DBCStructure.h MapEntry::IsDungeon */
export function mapEntryIsDungeon(map_type: number): boolean {
  return map_type === MAP_INSTANCE || map_type === MAP_RAID;
}

/** @ac shared/DataStores/DBCStructure.h MapEntry::IsRaid */
export function mapEntryIsRaid(map_type: number): boolean {
  return map_type === MAP_RAID;
}

/** @ac shared/DataStores/DBCStructure.h MapEntry::Instanceable */
export function mapEntryInstanceable(map_type: number): boolean {
  return map_type === MAP_INSTANCE || map_type === MAP_RAID || map_type === MAP_BATTLEGROUND || map_type === MAP_ARENA;
}

/** @ac game/Entities/GameObject/GameObjectData.h GameObjectTemplate::IsDespawnAtAction (`chest.consumable`, `goober.consumable`) */
export function gameObjectTemplateIsDespawnAtAction(type: number, data: readonly number[]): boolean {
  switch (type) {
    case 3: // GAMEOBJECT_TYPE_CHEST
      return (data[3] ?? 0) !== 0;
    case 10: // GAMEOBJECT_TYPE_GOOBER
      return (data[5] ?? 0) !== 0;
    default:
      return false;
  }
}
