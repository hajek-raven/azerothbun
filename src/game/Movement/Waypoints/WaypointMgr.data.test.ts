import { afterAll, describe, expect, test } from "bun:test";
import { openDatabase, parseDatabaseInfo, type Db } from "../../../database/database.ts";
import { waypoint_data, waypoint_data_addon } from "../../../database/schema/world.ts";
import { WorldTables } from "../../../database/world-tables.ts";
import { WaypointMgr } from "./WaypointMgr.ts";

/** The imported `acore_world` of the local MySQL (`docker compose up -d`, `bun run db:update`); skipped without it. */
async function realWorld(): Promise<{ db: Db; tables: WorldTables } | null> {
  const db = openDatabase(parseDatabaseInfo("127.0.0.1;3306;acore;acore;acore_world"), 1);
  try {
    const tables = await WorldTables.load(db, [waypoint_data, waypoint_data_addon]);
    return tables.all(waypoint_data).length > 0 ? { db, tables } : null;
  } catch {
    return null;
  }
}

const world = await realWorld();
afterAll(async () => {
  await world?.db.$client.close();
});

describe.skipIf(!world)("WaypointMgr over the real waypoint_data", () => {
  test("every row with a valid move_type loads, paths are ordered by point", () => {
    const rows = world!.tables.all(waypoint_data);
    const mgr = new WaypointMgr();
    mgr.load(world!.tables);
    mgr.loadWaypointAddons(world!.tables);

    const valid = rows.filter((r) => r.move_type >= 0 && r.move_type < 4).length;
    const ids = new Set(rows.map((r) => r.id));
    let total = 0;
    for (const id of ids) {
      const path = mgr.getPath(id);
      if (!path) continue;
      total += path.Nodes.length;
      const points = path.Nodes.map((n) => n.Id);
      expect(points).toEqual([...points].sort((a, b) => a - b));
    }
    expect(total).toBe(valid);
  });
});
