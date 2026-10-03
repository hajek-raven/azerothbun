/** `sGraveyard` (`GameGraveyard.cpp`): the graveyards and zone links shared by every session. */
import { executeStatementAsync, type Db } from "../../database/database.ts";
import type { WorldTables } from "../../database/world-tables.ts";
import { WORLD_INS_GRAVEYARD_ZONE } from "../../gen/WorldDatabase.gen.ts";
import {
  FACTION_ALLIANCE,
  FACTION_HORDE,
  getGraveyard,
  loadGraveyardStore,
  TEAM_ALLIANCE,
  TEAM_NEUTRAL,
  type GraveyardData,
  type GraveyardStore,
  type GraveyardStruct,
  type TeamId,
} from "../../characters/graveyard.ts";

export class Graveyard {
  private store: GraveyardStore | null = null;
  private tables: WorldTables | null = null;
  private worldDb: Db | null = null;

  setWorld(tables: WorldTables | null, worldDb: Db | null = null): void {
    this.tables = tables;
    this.worldDb = worldDb;
    this.store = null;
  }

  hasWorld(): boolean {
    return this.tables !== null;
  }

  /** @ac game/Misc/GameGraveyard.cpp Graveyard::LoadGraveyardFromDB (on first use) */
  graveyardStore(): GraveyardStore {
    if (!this.store) {
      try {
        this.store = this.tables ? loadGraveyardStore(this.tables) : { byId: new Map(), byZone: new Map() };
      } catch {
        this.store = { byId: new Map(), byZone: new Map() };
      }
    }
    return this.store;
  }

  /** @ac game/Misc/GameGraveyard.cpp Graveyard::GetGraveyard */
  getGraveyard(id: number): GraveyardStruct | null {
    return getGraveyard(this.graveyardStore(), id);
  }

  /** @ac game/Misc/GameGraveyard.cpp Graveyard::FindGraveyardData */
  findGraveyardData(id: number, zoneId: number): GraveyardData | null {
    return this.graveyardStore().byZone.get(zoneId)?.find((data) => data.safeLocId === id) ?? null;
  }

  /** @ac game/Misc/GameGraveyard.cpp Graveyard::AddGraveyardLink */
  addGraveyardLink(id: number, zoneId: number, teamId: TeamId, persist = true): boolean {
    if (this.findGraveyardData(id, zoneId)) return false;
    const store = this.graveyardStore();
    const list = store.byZone.get(zoneId) ?? [];
    list.push({ safeLocId: id, teamId });
    store.byZone.set(zoneId, list);
    if (persist && this.worldDb) {
      // Xinef: DB Data compatibility...
      executeStatementAsync(this.worldDb, WORLD_INS_GRAVEYARD_ZONE, id, zoneId, teamId === TEAM_NEUTRAL ? 0 : teamId === TEAM_ALLIANCE ? FACTION_ALLIANCE : FACTION_HORDE);
    }
    return true;
  }
}

export const sGraveyard = new Graveyard();
