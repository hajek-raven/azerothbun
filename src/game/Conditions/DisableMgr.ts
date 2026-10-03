/**
 * @ac game/Conditions/DisableMgr.h
 * @ac game/Conditions/DisableMgr.cpp
 *
 * `sDisableMgr`: the `disables` table (spells, quests, maps, battlegrounds, achievement criteria, outdoor PvP, vmaps,
 * gameobject line of sight, LFG maps, game events, loot) and the queries the other systems ask it. The map layer reads it for
 * `IsVMAPDisabledFor` (through the pointer `VMapMgr2` carries, installed by `DisableMgr.install`).
 *
 * @ac-skip game/Conditions/DisableMgr.cpp DisableMgr::IsPathfindingEnabled: ported as `MapCollisionDataHooks.isPathfindingEnabled`
 * (`game/Maps/MapCollisionData.ts`); this revision's rule does not read the `disables` table.
 *
 * @ac-skip game/Conditions/DisableMgr.cpp DisableMgr::HandleDisableType (DISABLE_TYPE_ACHIEVEMENT_CRITERIA): the
 * `AchievementCriteria.dbc` store is not loaded, so the existence check is skipped and the row is kept.
 * @ac-skip game/Conditions/DisableMgr.cpp DisableMgr::HandleDisableType (DISABLE_TYPE_GAME_EVENT): `GameEventMgr::StopEvent`
 * is not ported (the event scheduler is not); an active event of a disabled entry is only logged.
 */
import { VMapFactory } from "../../common/Collision/Management/VMapFactory.ts";
import { DisableTypes as VMapDisableTypes } from "../../common/Collision/Management/VMapMgr2.ts";
import { disables } from "../../database/schema/world.ts";
import type { WorldTables } from "../../database/world-tables.ts";
import { log, logError } from "../../log.ts";
import { sBattlemasterListStore, sMapStore } from "../DataStores/DBCStores.ts";
import {
  DUNGEON_DIFFICULTY_HEROIC,
  DUNGEON_DIFFICULTY_NORMAL,
  GetDownscaledMapDifficultyData,
  GetMapDifficultyData,
  MAP_ARENA,
  MAP_BATTLEGROUND,
  MAP_COMMON,
  MAP_INSTANCE,
  MAP_RAID,
  MapEntryIsDungeon,
  MapEntryIsRaid,
  RAID_DIFFICULTY_10MAN_HEROIC,
  RAID_DIFFICULTY_25MAN_HEROIC,
} from "../DataStores/MapDBCStores.ts";
import { sGameEventMgr } from "../Events/GameEventMgr.ts";
import { sObjectMgr } from "../Globals/ObjectMgr.ts";
import { sSpellMgr } from "../Spells/SpellMgr.ts";
import { getMSTime, getMSTimeDiffToNow } from "../time/timer.ts";
import { SPELL_ATTR2_IGNORE_LINE_OF_SIGHT } from "../../spells/defines.ts";

/** @ac game/Conditions/DisableMgr.h DisableType */
export const DISABLE_TYPE_SPELL = 0;
export const DISABLE_TYPE_QUEST = 1;
export const DISABLE_TYPE_MAP = 2;
export const DISABLE_TYPE_BATTLEGROUND = 3;
export const DISABLE_TYPE_ACHIEVEMENT_CRITERIA = 4;
export const DISABLE_TYPE_OUTDOORPVP = 5;
export const DISABLE_TYPE_VMAP = 6;
export const DISABLE_TYPE_GO_LOS = 7;
export const DISABLE_TYPE_LFG_MAP = 8;
export const DISABLE_TYPE_GAME_EVENT = 9;
export const DISABLE_TYPE_LOOT = 10;
export const MAX_DISABLE_TYPES = 11;
export type DisableType = number;

/** @ac game/Conditions/DisableMgr.h SpellDisableTypes */
export const SPELL_DISABLE_PLAYER = 0x1;
export const SPELL_DISABLE_CREATURE = 0x2;
export const SPELL_DISABLE_PET = 0x4;
export const SPELL_DISABLE_DEPRECATED_SPELL = 0x8;
export const SPELL_DISABLE_MAP = 0x10;
export const SPELL_DISABLE_AREA = 0x20;
export const SPELL_DISABLE_LOS = 0x40;
export const MAX_SPELL_DISABLE_TYPE =
  SPELL_DISABLE_PLAYER | SPELL_DISABLE_CREATURE | SPELL_DISABLE_PET | SPELL_DISABLE_DEPRECATED_SPELL | SPELL_DISABLE_MAP | SPELL_DISABLE_AREA | SPELL_DISABLE_LOS;

/** @ac shared/SharedDefines.h DungeonStatusFlag */
export const DUNGEON_STATUSFLAG_NORMAL = 0x01;
export const DUNGEON_STATUSFLAG_HEROIC = 0x02;
export const RAID_STATUSFLAG_10MAN_NORMAL = 0x01;
export const RAID_STATUSFLAG_25MAN_NORMAL = 0x02;
export const RAID_STATUSFLAG_10MAN_HEROIC = 0x04;
export const RAID_STATUSFLAG_25MAN_HEROIC = 0x08;

/** @ac game/OutdoorPvP/OutdoorPvP.h MAX_OUTDOORPVP_TYPES */
const MAX_OUTDOORPVP_TYPES = 8;

/** @ac game/Conditions/DisableMgr.h DisableData */
export interface DisableData {
  flags: number;
  /** params0 (map ids), params1 (area ids) of a spell disable */
  params: [Set<number>, Set<number>];
}

/** The `Unit` members `DisableMgr::IsDisabledFor` reads. */
export interface DisableUnit {
  isPlayer(): boolean;
  isCreature(): boolean;
  isPet?(): boolean;
  getMapId(): number;
  getAreaId(): number;
  toPlayer?(): { getDifficulty?(isRaid: boolean): number } | null;
}

/** `Acore::Tokenize(str, ',', true)`: the non empty parts. */
function tokenize(text: string): string[] {
  return text.split(",").filter((part) => part.length > 0);
}

/** `Acore::StringTo<uint32>`: a whole decimal number, else null. */
function stringToUInt32(text: string): number | null {
  if (!/^[+]?\d+$/.test(text)) return null;
  const value = Number(text);
  return value <= 0xffffffff ? value : null;
}

/** @ac game/Conditions/DisableMgr.h DisableMgr */
export class DisableMgr {
  /** @ac game/Conditions/DisableMgr.h DisableMgr::m_DisableMap */
  private static readonly m_DisableMap: Map<number, DisableData>[] = Array.from({ length: MAX_DISABLE_TYPES }, () => new Map<number, DisableData>());

  private static _instance: DisableMgr | null = null;

  /** @ac game/Conditions/DisableMgr.cpp DisableMgr::instance */
  static instance(): DisableMgr {
    return (DisableMgr._instance ??= new DisableMgr());
  }

  /** @ac game/Conditions/DisableMgr.cpp DisableMgr::LoadDisables (the `disables` table of `tables`) */
  loadDisables(tables: WorldTables | null = sObjectMgr.worldTables()): void {
    const oldMSTime = getMSTime();

    // reload case
    for (const disableTypeMap of DisableMgr.m_DisableMap) disableTypeMap.clear();

    const rows = tables?.all(disables) ?? [];
    let total_count = 0;

    if (rows.length === 0) {
      logError("server", ">> Loaded 0 disables. DB table `disables` is empty!");
      return;
    }

    for (const row of rows) {
      const type = row.sourceType;
      if (type >= MAX_DISABLE_TYPES) {
        logError("sql", `Invalid type ${type} specified in \`disables\` table, skipped.`);
        continue;
      }

      const data: DisableData = { flags: row.flags, params: [new Set(), new Set()] };
      if (!this.handleDisableType(type, row.entry, row.flags, row.params_0, row.params_1, data)) continue;

      // `insert` keeps the first row of a key
      if (!DisableMgr.m_DisableMap[type]!.has(row.entry)) DisableMgr.m_DisableMap[type]!.set(row.entry, data);
      ++total_count;
    }

    log("server", `>> Loaded ${total_count} Disables in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /**
   * @ac game/Conditions/DisableMgr.cpp DisableMgr::AddDisable
   * Allow to add disables without adding it to the database. Useful for modules.
   * @param param0 MapId if DISABLE_TYPE_SPELL used, 0 for all maps.
   * @param param1 AreaId if DISABLE_TYPE_SPELL used, 0 for all areas.
   */
  addDisable(type: DisableType, entry: number, flags: number, param0: string, param1: string): void {
    if (type >= MAX_DISABLE_TYPES) {
      logError("server", `AddDisable: Invalid type ${type} specified for entry ${entry}, skipped.`);
      return;
    }

    const data: DisableData = { flags, params: [new Set(), new Set()] };
    if (!this.handleDisableType(type, entry, flags, param0, param1, data)) return;

    if (!DisableMgr.m_DisableMap[type]!.has(entry)) DisableMgr.m_DisableMap[type]!.set(entry, data);
  }

  /** @ac game/Conditions/DisableMgr.cpp DisableMgr::HandleDisableType */
  handleDisableType(type: DisableType, entry: number, flags: number, params_0: string, params_1: string, data: DisableData): boolean {
    switch (type) {
      case DISABLE_TYPE_GO_LOS:
        if (!sObjectMgr.getGameObjectTemplate(entry)) {
          logError("sql", `Gameobject entry ${entry} from \`disables\` doesn't exist in dbc, skipped.`);
          return false;
        }
        if (flags) logError("sql", `Disable flags specified for gameobject ${entry}, useless data.`);
        break;
      case DISABLE_TYPE_SPELL: {
        if (!(sSpellMgr.getSpellInfo(entry) || flags & SPELL_DISABLE_DEPRECATED_SPELL)) {
          logError("sql", `Spell entry ${entry} from \`disables\` doesn't exist in dbc, skipped.`);
          return false;
        }

        if (!flags || flags > MAX_SPELL_DISABLE_TYPE) {
          logError("sql", `Disable flags for spell ${entry} are invalid, skipped.`);
          return false;
        }

        if (flags & SPELL_DISABLE_MAP) {
          for (const mapStr of tokenize(params_0)) {
            const mapId = stringToUInt32(mapStr);
            if (mapId !== null) data.params[0].add(mapId);
            else logError("sql", `Disable map '${mapStr}' for spell ${entry} is invalid, skipped.`);
          }
        }

        if (flags & SPELL_DISABLE_AREA) {
          for (const areaStr of tokenize(params_1)) {
            const areaId = stringToUInt32(areaStr);
            if (areaId !== null) data.params[1].add(areaId);
            else logError("sql", `Disable area '${areaStr}' for spell ${entry} is invalid, skipped.`);
          }
        }

        // xinef: if spell has disabled los, add flag
        if (flags & SPELL_DISABLE_LOS) {
          const spellInfo = sSpellMgr.getSpellInfo(entry);
          if (spellInfo) spellInfo.attributes[2] = ((spellInfo.attributes[2] ?? 0) | SPELL_ATTR2_IGNORE_LINE_OF_SIGHT) >>> 0;
        }

        break;
      }
      // checked later
      case DISABLE_TYPE_QUEST:
        break;
      case DISABLE_TYPE_MAP:
      case DISABLE_TYPE_LFG_MAP: {
        const mapEntry = sMapStore.lookupEntry(entry);
        if (!mapEntry) {
          logError("sql", `Map entry ${entry} from \`disables\` doesn't exist in dbc, skipped.`);
          return false;
        }
        let isFlagInvalid = false;
        switch (mapEntry.map_type) {
          case MAP_COMMON:
            if (flags) isFlagInvalid = true;
            break;
          case MAP_INSTANCE:
          case MAP_RAID:
            if (flags & DUNGEON_STATUSFLAG_HEROIC && !GetMapDifficultyData(entry, DUNGEON_DIFFICULTY_HEROIC)) isFlagInvalid = true;
            else if (flags & RAID_STATUSFLAG_10MAN_HEROIC && !GetMapDifficultyData(entry, RAID_DIFFICULTY_10MAN_HEROIC)) isFlagInvalid = true;
            else if (flags & RAID_STATUSFLAG_25MAN_HEROIC && !GetMapDifficultyData(entry, RAID_DIFFICULTY_25MAN_HEROIC)) isFlagInvalid = true;
            break;
          case MAP_BATTLEGROUND:
          case MAP_ARENA:
            logError("sql", `Battleground map ${entry} specified to be disabled in map case, skipped.`);
            return false;
        }
        if (isFlagInvalid) {
          logError("sql", `Disable flags for map ${entry} are invalid, skipped.`);
          return false;
        }
        break;
      }
      case DISABLE_TYPE_BATTLEGROUND:
        if (!sBattlemasterListStore.lookupEntry(entry)) {
          logError("sql", `Battleground entry ${entry} from \`disables\` doesn't exist in dbc, skipped.`);
          return false;
        }
        if (flags) logError("sql", `Disable flags specified for battleground ${entry}, useless data.`);
        break;
      case DISABLE_TYPE_OUTDOORPVP:
        if (entry > MAX_OUTDOORPVP_TYPES) {
          logError("sql", `OutdoorPvPTypes value ${entry} from \`disables\` is invalid, skipped.`);
          return false;
        }
        if (flags) logError("sql", `Disable flags specified for outdoor PvP ${entry}, useless data.`);
        break;
      case DISABLE_TYPE_ACHIEVEMENT_CRITERIA:
        // @ac-skip sAchievementCriteriaStore.LookupEntry(entry): the store is not loaded
        if (flags) logError("sql", `Disable flags specified for Achievement Criteria ${entry}, useless data.`);
        break;
      case DISABLE_TYPE_VMAP: {
        const mapEntry = sMapStore.lookupEntry(entry);
        if (!mapEntry) {
          logError("sql", `Map entry ${entry} from \`disables\` doesn't exist in dbc, skipped.`);
          return false;
        }
        switch (mapEntry.map_type) {
          case MAP_COMMON:
            if (flags & VMapDisableTypes.VMAP_DISABLE_AREAFLAG) log("server", `Areaflag disabled for world map ${entry}.`);
            if (flags & VMapDisableTypes.VMAP_DISABLE_LIQUIDSTATUS) log("server", `Liquid status disabled for world map ${entry}.`);
            break;
          case MAP_INSTANCE:
          case MAP_RAID:
          case MAP_BATTLEGROUND:
          case MAP_ARENA: {
            const kind = mapEntry.map_type === MAP_BATTLEGROUND ? "battleground" : mapEntry.map_type === MAP_ARENA ? "arena" : "instance";
            if (flags & VMapDisableTypes.VMAP_DISABLE_HEIGHT) log("server", `Height disabled for ${kind} map ${entry}.`);
            if (flags & VMapDisableTypes.VMAP_DISABLE_LOS) log("server", `LoS disabled for ${kind} map ${entry}.`);
            break;
          }
          default:
            break;
        }
        break;
      }
      case DISABLE_TYPE_GAME_EVENT:
        if (sGameEventMgr.GetActiveEventList().has(entry)) log("server", `Event entry ${entry} is active but disabled (StopEvent is not ported).`);
        break;
      case DISABLE_TYPE_LOOT:
        break;
      default:
        logError("server", `SourceType out of range for entry ${entry}, skipped`);
        return false;
    }
    return true;
  }

  /** @ac game/Conditions/DisableMgr.cpp DisableMgr::CheckQuestDisables */
  checkQuestDisables(): void {
    const oldMSTime = getMSTime();

    const questDisables = DisableMgr.m_DisableMap[DISABLE_TYPE_QUEST]!;
    const count = questDisables.size;
    if (!count) {
      log("server", ">> Checked 0 quest disables.");
      return;
    }

    // check only quests, rest already done at startup
    for (const [entry, data] of [...questDisables]) {
      if (!sObjectMgr.getQuestTemplate(entry)) {
        logError("sql", `Quest entry ${entry} from \`disables\` doesn't exist, skipped.`);
        questDisables.delete(entry);
        continue;
      }
      if (data.flags) logError("sql", `Disable flags specified for quest ${entry}, useless data.`);
    }

    log("server", `>> Checked ${count} Quest Disables in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** @ac game/Conditions/DisableMgr.cpp DisableMgr::IsDisabledFor */
  static isDisabledFor(type: DisableType, entry: number, unit: DisableUnit | null, flags = 0): boolean {
    if (type >= MAX_DISABLE_TYPES) {
      logError("server", `Disables::IsDisabledFor() called with unknown disable type ${type}!  (entry ${entry}, flags ${flags}).`);
      return false;
    }

    const typeMap = DisableMgr.m_DisableMap[type]!;
    if (typeMap.size === 0) return false;

    const data = typeMap.get(entry);
    if (!data) return false; // not disabled

    switch (type) {
      case DISABLE_TYPE_SPELL: {
        const spellFlags = data.flags;
        if (unit) {
          if (
            (spellFlags & SPELL_DISABLE_PLAYER && unit.isPlayer()) ||
            (unit.isCreature() && ((unit.isPet?.() && spellFlags & SPELL_DISABLE_PET) || spellFlags & SPELL_DISABLE_CREATURE))
          ) {
            if (spellFlags & SPELL_DISABLE_MAP) {
              const mapIds = data.params[0];
              if (mapIds.has(unit.getMapId())) return true; // Spell is disabled on current map

              if (!(spellFlags & SPELL_DISABLE_AREA)) return false; // Spell is disabled on another map, but not this one, return false

              // Spell is disabled in an area, but not explicitly our current mapId. Continue processing.
            }

            if (spellFlags & SPELL_DISABLE_AREA) {
              const areaIds = data.params[1];
              return areaIds.has(unit.getAreaId()); // Spell is disabled in this area, or in another area but not this one
            }
            return true; // Spell disabled for all maps
          }

          return false;
        } else if (spellFlags & SPELL_DISABLE_DEPRECATED_SPELL) return true; // call not from spellcast

        break;
      }
      case DISABLE_TYPE_MAP:
      case DISABLE_TYPE_LFG_MAP: {
        const mapEntry = sMapStore.lookupEntry(entry);
        if (!mapEntry) return false;

        if (!MapEntryIsDungeon(mapEntry)) return mapEntry.map_type === MAP_COMMON;

        const disabledModes = data.flags;

        let targetDifficulty: number;
        const player = unit?.isPlayer() ? (unit.toPlayer?.() ?? null) : null;
        if (player?.getDifficulty) targetDifficulty = player.getDifficulty(MapEntryIsRaid(mapEntry));
        else targetDifficulty = flags;

        targetDifficulty = GetDownscaledMapDifficultyData(entry, targetDifficulty).difficulty;

        switch (targetDifficulty) {
          case DUNGEON_DIFFICULTY_NORMAL:
            return (disabledModes & DUNGEON_STATUSFLAG_NORMAL) !== 0;
          case DUNGEON_DIFFICULTY_HEROIC:
            return (disabledModes & DUNGEON_STATUSFLAG_HEROIC) !== 0;
          case RAID_DIFFICULTY_10MAN_HEROIC:
            return (disabledModes & RAID_STATUSFLAG_10MAN_HEROIC) !== 0;
          case RAID_DIFFICULTY_25MAN_HEROIC:
            return (disabledModes & RAID_STATUSFLAG_25MAN_HEROIC) !== 0;
          default:
            return false;
        }
      }
      case DISABLE_TYPE_VMAP:
        return (flags & data.flags) !== 0;
      case DISABLE_TYPE_QUEST:
      case DISABLE_TYPE_BATTLEGROUND:
      case DISABLE_TYPE_OUTDOORPVP:
      case DISABLE_TYPE_ACHIEVEMENT_CRITERIA:
      case DISABLE_TYPE_GO_LOS:
      case DISABLE_TYPE_GAME_EVENT:
      case DISABLE_TYPE_LOOT:
        return true;
      default:
        break;
    }

    return false;
  }

  /** @ac game/Conditions/DisableMgr.cpp DisableMgr::IsVMAPDisabledFor */
  static isVMAPDisabledFor(entry: number, flags: number): boolean {
    return DisableMgr.isDisabledFor(DISABLE_TYPE_VMAP, entry, null, flags);
  }

  /**
   * `World::SetInitialWorldSettings`: `vmmgr2->IsVMAPDisabledForPtr = &DisableMgr::IsVMAPDisabledFor` (the vmap manager and
   * `MapCollisionData` ask the disables through it).
   */
  static install(): void {
    VMapFactory.createOrGetVMapMgr().IsVMAPDisabledForPtr = DisableMgr.isVMAPDisabledFor;
  }

  /** The loaded disables of a type, for the tests and `.disable` commands. */
  static disablesOf(type: DisableType): ReadonlyMap<number, DisableData> {
    return DisableMgr.m_DisableMap[type] ?? new Map();
  }

  /** Drops every loaded disable (tests). */
  static clear(): void {
    for (const disableTypeMap of DisableMgr.m_DisableMap) disableTypeMap.clear();
  }
}

/** @ac game/Conditions/DisableMgr.h sDisableMgr (`DisableMgr::instance()`) */
export function sDisableMgr(): DisableMgr {
  return DisableMgr.instance();
}
