/**
 * `LoadDBCStores`: fills every generated `DBCStorage` from `data/dbc` and the `*_dbc` world tables. A store whose
 * file is missing stays empty; a file that does not match its format is reported and left empty.
 */
import { join } from "node:path";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import * as worldSchema from "../../database/schema/world.ts";
import type { WorldTables } from "../../database/world-tables.ts";
import { ALL_DBC_STORES, sSkillLineAbilityStore, sTalentStore, sWorldMapAreaStore } from "../../gen/DBCStores.gen.ts";
import { log, logError } from "../../log.ts";
import type { SkillLineAbilityEntry } from "../../gen/DBCStructure.gen.ts";
import { getMSTime, getMSTimeDiffToNow } from "../time/timer.ts";

export * from "../../gen/DBCStores.gen.ts";

/** @ac game/DataStores/DBCStores.cpp LoadDBCStores */
export async function loadDBCStores(dataPath: string, world: WorldTables | null = null): Promise<void> {
  const oldMSTime = getMSTime();
  let loaded = 0;
  for (const store of ALL_DBC_STORES) {
    const file = Bun.file(join(dataPath, store.info.file));
    try {
      if (await file.exists()) {
        store.loadFromBytes(await file.bytes());
        loaded++;
      }
      const table = (worldSchema as Record<string, unknown>)[store.info.table] as MySqlTable | undefined;
      if (world && table && world.has(table)) {
        store.loadOverrides(world.all(table).map((row) => Object.values(row as Record<string, unknown>)));
      }
    } catch (error) {
      logError("server", `DBC ${store.info.file} not loaded`, error);
    }
  }
  log("server", `>> Initialized ${loaded} DBC data stores in ${getMSTimeDiffToNow(oldMSTime)} ms`);
}


/** @ac game/DataStores/DBCStores.cpp Zone2MapCoordinates */
export function Zone2MapCoordinates(x: number, y: number, zone: number): { x: number; y: number } {
  const maEntry = sWorldMapAreaStore.lookupEntry(zone);
  // if not listed then map coordinates (instance)
  if (!maEntry) return { x, y };
  // at client map coords swapped
  const sx = y;
  const sy = x;
  return {
    x: Math.fround(sx * ((maEntry.x2 - maEntry.x1) / 100) + maEntry.x1),
    y: Math.fround(sy * ((maEntry.y2 - maEntry.y1) / 100) + maEntry.y1),
  };
}

/** @ac game/DataStores/DBCStores.cpp Map2ZoneCoordinates */
export function Map2ZoneCoordinates(x: number, y: number, zone: number): { x: number; y: number } {
  const maEntry = sWorldMapAreaStore.lookupEntry(zone);
  if (!maEntry) return { x, y };
  const zx = (x - maEntry.x1) / ((maEntry.x2 - maEntry.x1) / 100);
  const zy = (y - maEntry.y1) / ((maEntry.y2 - maEntry.y1) / 100);
  // client have map coords swapped
  return { x: Math.fround(zy), y: Math.fround(zx) };
}

/** `sTalentSpellPosMap`: talent id and rank (0-based) of every talent rank spell. */
let talentSpellPos: Map<number, { talent_id: number; rank: number }> | null = null;

/** @ac game/DataStores/DBCStores.cpp GetTalentSpellPos */
export function GetTalentSpellPos(spellId: number): { talent_id: number; rank: number } | null {
  if (!talentSpellPos) {
    talentSpellPos = new Map();
    for (const talentInfo of sTalentStore) {
      for (let j = 0; j < 5; ++j) {
        const spell = talentInfo.RankID[j];
        if (spell) talentSpellPos.set(spell, { talent_id: talentInfo.TalentID, rank: j });
      }
    }
  }
  return talentSpellPos.get(spellId) ?? null;
}

/** @ac game/DataStores/DBCStores.cpp GetTalentSpellCost */
export function GetTalentSpellCost(spellId: number): number {
  const pos = GetTalentSpellPos(spellId);
  return pos ? pos.rank + 1 : 0;
}

/** @ac game/DataStores/DBCStores.cpp GetSkillLineAbilitiesBySkillLine */
export function GetSkillLineAbilitiesBySkillLine(skillLine: number): SkillLineAbilityEntry[] {
  const out: SkillLineAbilityEntry[] = [];
  for (const entry of sSkillLineAbilityStore) if (entry.SkillLine === skillLine) out.push(entry);
  return out;
}
