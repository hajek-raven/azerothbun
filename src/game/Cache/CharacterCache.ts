/**
 * `CharacterCache`: name, account, race, gender, class, and level of every character, loaded at startup so name and
 * guid lookups never wait on `acore_characters`. Keys are the player low guid.
 */
import type { Db } from "../../database/database.ts";
import { queryFields } from "../../database/database.ts";
import { log, logWarn } from "../../log.ts";
import { teamIdFromRace } from "../../characters/graveyard.ts";
import { getMSTime, getMSTimeDiffToNow } from "../time/timer.ts";

export const MAX_ARENA_SLOT = 3;

export type CharacterCacheEntry = {
  Guid: number;
  Name: string;
  AccountId: number;
  Class: number;
  Race: number;
  Sex: number;
  Level: number;
  MailCount: number;
  GuildId: number;
  ArenaTeamId: number[];
  GroupGuid: bigint;
};

/** @ac game/Cache/CharacterCache.h CharacterCache */
export class CharacterCache {
  private readonly store = new Map<number, CharacterCacheEntry>();
  private readonly byName = new Map<string, CharacterCacheEntry>();

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::LoadCharacterCacheStorage */
  async loadCharacterCacheStorage(db: Db): Promise<void> {
    this.store.clear();
    this.byName.clear();
    const oldMSTime = getMSTime();
    const rows = await queryFields(db, "SELECT guid, name, account, race, gender, class, level FROM characters");
    if (rows.length === 0) {
      log("server", "No character name data loaded, empty query!");
      return;
    }
    for (const row of rows) {
      this.addCharacterCacheEntry(Number(row[0]), Number(row[2]), String(row[1]), Number(row[4]), Number(row[3]), Number(row[5]), Number(row[6]));
    }
    // `MailMgr::LoadMailCounts`
    for (const row of await queryFields(db, "SELECT receiver, COUNT(receiver) FROM mail GROUP BY receiver")) {
      this.updateCharacterMailCount(Number(row[0]), Number(row[1]), true);
    }
    log("server", `>> Loaded Character Infos For ${this.store.size} Characters in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::RefreshCacheEntry */
  async refreshCacheEntry(db: Db, lowGuid: number): Promise<void> {
    const rows = await queryFields(db, "SELECT guid, name, account, race, gender, class, level FROM characters WHERE guid = ?", lowGuid);
    for (const row of rows) {
      this.deleteCharacterCacheEntry(lowGuid, String(row[1]));
      this.addCharacterCacheEntry(Number(row[0]), Number(row[2]), String(row[1]), Number(row[4]), Number(row[3]), Number(row[5]), Number(row[6]));
    }
    // `MailMgr::RecountMailCount`
    const [count] = await queryFields(db, "SELECT COUNT(*) FROM mail WHERE receiver = ?", lowGuid);
    this.updateCharacterMailCount(lowGuid, Number(count?.[0] ?? 0), true);
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::AddCharacterCacheEntry */
  addCharacterCacheEntry(guid: number, accountId: number, name: string, gender: number, race: number, playerClass: number, level: number): void {
    const data: CharacterCacheEntry = this.store.get(guid) ?? {
      Guid: guid,
      Name: name,
      AccountId: accountId,
      Class: playerClass,
      Race: race,
      Sex: gender,
      Level: level,
      MailCount: 0,
      GuildId: 0,
      ArenaTeamId: [0, 0, 0],
      GroupGuid: 0n,
    };
    data.Guid = guid;
    data.Name = name;
    data.AccountId = accountId;
    data.Race = race;
    data.Sex = gender;
    data.Class = playerClass;
    data.Level = level;
    data.GuildId = 0;
    data.ArenaTeamId = [0, 0, 0];
    this.store.set(guid, data);
    this.byName.set(name, data);
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::DeleteCharacterCacheEntry */
  deleteCharacterCacheEntry(guid: number, name: string): void {
    this.store.delete(guid);
    this.byName.delete(name);
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::UpdateCharacterData */
  updateCharacterData(guid: number, name: string, gender?: number, race?: number): void {
    const entry = this.store.get(guid);
    if (!entry) return;
    const oldName = entry.Name;
    entry.Name = name;
    if (gender !== undefined) entry.Sex = gender;
    if (race !== undefined) entry.Race = race;
    this.byName.delete(oldName);
    this.byName.set(name, entry);
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::UpdateCharacterLevel */
  updateCharacterLevel(guid: number, level: number): void {
    const entry = this.store.get(guid);
    if (entry) entry.Level = level;
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::UpdateCharacterAccountId */
  updateCharacterAccountId(guid: number, accountId: number): void {
    const entry = this.store.get(guid);
    if (entry) entry.AccountId = accountId;
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::UpdateCharacterGuildId */
  updateCharacterGuildId(guid: number, guildId: number): void {
    const entry = this.store.get(guid);
    if (entry) entry.GuildId = guildId;
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::UpdateCharacterArenaTeamId */
  updateCharacterArenaTeamId(guid: number, slot: number, arenaTeamId: number): void {
    const entry = this.store.get(guid);
    if (entry) entry.ArenaTeamId[slot] = arenaTeamId;
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::UpdateCharacterMailCount */
  updateCharacterMailCount(guid: number, count: number, update = false): void {
    const entry = this.store.get(guid);
    if (!entry) return;
    const maxCount = 0xffff;
    if (update) {
      entry.MailCount = Math.min(Math.max(count, 0), maxCount);
      return;
    }
    const newCount = entry.MailCount + count;
    if (newCount < 0) {
      logWarn("world", `CharacterCache::UpdateCharacterMailCount: mail count for ${guid} would go negative (${newCount}), a mail insert was not reported; clamping to 0`);
    }
    entry.MailCount = Math.min(Math.max(newCount, 0), maxCount);
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::UpdateCharacterGroup */
  updateCharacterGroup(guid: number, groupGuid: bigint): void {
    const entry = this.store.get(guid);
    if (entry) entry.GroupGuid = groupGuid;
  }

  clearCharacterGroup(guid: number): void {
    this.updateCharacterGroup(guid, 0n);
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::HasCharacterCacheEntry */
  hasCharacterCacheEntry(guid: number): boolean {
    return this.store.has(guid);
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::GetCharacterCacheByGuid */
  getCharacterCacheByGuid(guid: number): Readonly<CharacterCacheEntry> | null {
    return this.store.get(guid) ?? null;
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::GetCharacterCacheByName */
  getCharacterCacheByName(name: string): Readonly<CharacterCacheEntry> | null {
    return this.byName.get(name) ?? null;
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::GetCharacterGuidByName (0 when unknown) */
  getCharacterGuidByName(name: string): number {
    return this.byName.get(name)?.Guid ?? 0;
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::GetCharacterNameByGuid */
  getCharacterNameByGuid(guid: number): string | null {
    return this.store.get(guid)?.Name ?? null;
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::GetCharacterTeamByGuid */
  getCharacterTeamByGuid(guid: number): number {
    const entry = this.store.get(guid);
    return entry ? teamIdFromRace(entry.Race) : 0;
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::GetCharacterAccountIdByGuid */
  getCharacterAccountIdByGuid(guid: number): number {
    return this.store.get(guid)?.AccountId ?? 0;
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::GetCharacterAccountIdByName */
  getCharacterAccountIdByName(name: string): number {
    return this.byName.get(name)?.AccountId ?? 0;
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::GetCharacterLevelByGuid */
  getCharacterLevelByGuid(guid: number): number {
    return this.store.get(guid)?.Level ?? 0;
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::GetCharacterGuildIdByGuid */
  getCharacterGuildIdByGuid(guid: number): number {
    return this.store.get(guid)?.GuildId ?? 0;
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::GetCharacterArenaTeamIdByGuid */
  getCharacterArenaTeamIdByGuid(guid: number, type: number): number {
    return this.store.get(guid)?.ArenaTeamId[type] ?? 0;
  }

  /** @ac game/Cache/CharacterCache.cpp CharacterCache::GetCharacterGroupGuidByGuid */
  getCharacterGroupGuidByGuid(guid: number): bigint {
    return this.store.get(guid)?.GroupGuid ?? 0n;
  }
}

export const sCharacterCache = new CharacterCache();
