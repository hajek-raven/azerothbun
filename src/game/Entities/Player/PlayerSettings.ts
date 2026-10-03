/** `PlayerSettings.cpp`: the per-source setting vectors in `character_settings`. */
import { executeStatementAsync, queryFields, type Db } from "../../../database/database.ts";
import { CHAR_REP_CHAR_SETTINGS, CHAR_SEL_CHAR_SETTINGS } from "../../../gen/CharacterDatabase.gen.ts";
import { ServerConfig } from "../../world/world-config.ts";
import { sWorld } from "../../world/world.ts";

/** @ac game/Entities/Player/PlayerSettings.h AzerothcorePSSource */
export const AzerothcorePSSource = "ac_default";

/** @ac game/Entities/Player/PlayerSettings.h CharacterSettingIndexes */
export const SETTING_ANNOUNCER_FLAGS = 0;

/** @ac game/Entities/Player/PlayerSettings.h AnnouncerFlags */
export const ANNOUNCER_FLAG_DISABLE_BG_QUEUE = 1;
export const ANNOUNCER_FLAG_DISABLE_ARENA_QUEUE = 2;
export const ANNOUNCER_FLAG_DISABLE_AUTOBROADCAST = 4;
export const ANNOUNCER_FLAG_DISABLE_PVP_START = 8;
export const ANNOUNCER_FLAG_DISABLE_PVP_ALL = ANNOUNCER_FLAG_DISABLE_BG_QUEUE | ANNOUNCER_FLAG_DISABLE_ARENA_QUEUE | ANNOUNCER_FLAG_DISABLE_PVP_START;

/** `Player::m_charSettingsMap` */
export type PlayerSettingMap = Map<string, number[]>;

/** @ac game/Entities/Player/PlayerSettings.cpp PlayerSettingsStore::ParseSettingsData */
export function ParseSettingsData(data: string): number[] {
  return data
    .split(" ")
    .filter((token) => token.length > 0 && /^\d+$/.test(token))
    .map((token) => Number(token) >>> 0);
}

/** @ac game/Entities/Player/PlayerSettings.cpp PlayerSettingsStore::SerializeSettingsData */
export function SerializeSettingsData(settings: readonly number[]): string {
  return settings.map((value) => `${value} `).join("");
}

/** @ac game/Entities/Player/PlayerSettings.cpp Player::_LoadCharacterSettings */
export async function LoadCharacterSettings(db: Db, guid: number): Promise<PlayerSettingMap> {
  const map: PlayerSettingMap = new Map();
  if (!sWorld().getBoolConfig(ServerConfig.CONFIG_PLAYER_SETTINGS_ENABLED)) return map;
  for (const fields of await queryFields(db, CHAR_SEL_CHAR_SETTINGS, guid)) map.set(String(fields[0] ?? ""), ParseSettingsData(String(fields[1] ?? "")));
  return map;
}

/** @ac game/Entities/Player/PlayerSettings.cpp Player::_SavePlayerSettings */
export function SavePlayerSettings(db: Db, guid: number, map: PlayerSettingMap): void {
  if (!sWorld().getBoolConfig(ServerConfig.CONFIG_PLAYER_SETTINGS_ENABLED)) return;
  for (const [source, settings] of map) {
    if (settings.length === 0) continue;
    executeStatementAsync(db, CHAR_REP_CHAR_SETTINGS, guid, source, SerializeSettingsData(settings));
  }
}

/** @ac game/Entities/Player/PlayerSettings.cpp Player::UpdatePlayerSetting */
export function UpdatePlayerSetting(map: PlayerSettingMap, source: string, index: number, value: number): void {
  const settings = map.get(source) ?? [];
  while (settings.length < index + 1) settings.push(0);
  settings[index] = value >>> 0;
  map.set(source, settings);
}

/** @ac game/Entities/Player/PlayerSettings.cpp Player::GetPlayerSetting */
export function GetPlayerSetting(map: PlayerSettingMap, source: string, index: number): number {
  const settings = map.get(source);
  if (!settings || index >= settings.length) {
    UpdatePlayerSetting(map, source, index, 0);
    return 0;
  }
  return settings[index]!;
}
