import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorldObject } from "../Entities/Object/Object.ts";
import { ObjectGuid } from "../Entities/Object/ObjectGuid.ts";
import { Cell } from "./Cells/Cell.ts";
import { GridCoord, MAX_NUMBER_OF_GRIDS, SIZE_OF_GRID_CELL } from "./GridDefines.ts";
import { GridObjectLoaderHooks } from "./GridObjectLoader.ts";
import { FakeCorpse, FakeCreature, FakeGameObject, FakeMap, FakeObjectMgr, FakePlayer, type FakeSpawn } from "./Grids.test-util.ts";
import { MapGridManager } from "./MapGridManager.ts";

const S = SIZE_OF_GRID_CELL;
const low = (o: WorldObject): number => ObjectGuid.GetCounter(o.getGUID());
/** cell center: x = (256 - cx - 0.5) * S */
const cellX = (cx: number): number => (256 - cx - 0.5) * S;
/** Grid (48, 32) holds cells x 384..391, y 256..263; its id is 32 * 64 + 48. */
const GRID_ID = 32 * 64 + 48;

const savedHooks = { ...GridObjectLoaderHooks };
let store: FakeObjectMgr;

function spawn(kind: "creature" | "gameobject", guid: number, cx: number, cy: number, extra: Partial<FakeSpawn> = {}): FakeSpawn {
  const row: FakeSpawn = { guid, id: 100 + guid, map: 9999, x: cellX(cx), y: cellX(cy), z: 0, phaseMask: 1, spawnGroupId: 0, poolId: 0, ...extra };
  const gridId = Math.floor(cy / 8) * 64 + Math.floor(cx / 8);
  store.add(kind, row, 0, gridId);
  return row;
}

beforeEach(() => {
  store = new FakeObjectMgr();
  GridObjectLoaderHooks.objectMgr = store;
  GridObjectLoaderHooks.createCreature = () => new FakeCreature(store);
  GridObjectLoaderHooks.createGameObject = () => new FakeGameObject(store);
  GridObjectLoaderHooks.createStaticTransport = null;
});

afterEach(() => {
  Object.assign(GridObjectLoaderHooks, savedHooks);
});

describe("MapGridManager grid lifecycle", () => {
  test("a grid is created once, linked into the map, and counted", () => {
    const map = new FakeMap();
    const m = map.gridManager;
    expect(m.isGridCreated(48, 32)).toBe(false);
    expect(m.getGrid(48, 32)).toBeNull();

    m.createGrid(48, 32);
    m.createGrid(48, 32);
    expect(m.isGridCreated(48, 32)).toBe(true);
    expect(m.isGridLoaded(48, 32)).toBe(false);
    expect(m.getCreatedGridsCount()).toBe(1);
    expect(m.getLoadedGridsCount()).toBe(0);
    expect(map.getSize()).toBe(1);
    const grid = m.getGrid(48, 32)!;
    expect([grid.getX(), grid.getY(), grid.getId()]).toEqual([48, 32, GRID_ID]);
    // no .map file for the fake map id: no terrain
    expect(grid.getTerrainData()).toBeNull();
    expect(m.getCreatedCellsInGridCount(48, 32)).toBe(0);
  });

  test("LoadGrid needs a created grid and loads its objects only once", () => {
    const map = new FakeMap();
    const m = map.gridManager;
    expect(m.loadGrid(48, 32)).toBe(false);

    m.createGrid(48, 32);
    expect(m.loadGrid(48, 32)).toBe(true);
    expect(m.isGridLoaded(48, 32)).toBe(true);
    expect(m.loadGrid(48, 32)).toBe(false);
    expect(m.getLoadedGridsCount()).toBe(1);
  });

  test("out of range coordinates are never created", () => {
    const map = new FakeMap();
    const m = map.gridManager;
    expect(MapGridManager.isValidGridCoordinates(MAX_NUMBER_OF_GRIDS - 1, 0)).toBe(true);
    expect(MapGridManager.isValidGridCoordinates(MAX_NUMBER_OF_GRIDS, 0)).toBe(false);
    expect(MapGridManager.isValidGridCoordinates(0, -1)).toBe(false);
    expect(m.isGridCreated(64, 0)).toBe(false);
    expect(m.isGridLoaded(0, 64)).toBe(false);
    expect(m.getGrid(64, 64)).toBeNull();
    expect(m.getCreatedCellsInGridCount(64, 64)).toBe(0);
  });

  test("an instance creates the parent map's grid first", () => {
    const parent = new FakeMap(9999, 0);
    const instance = new FakeMap(9999, 7);
    instance.parent = parent;
    instance.gridManager.createGrid(10, 11);
    expect(parent.gridManager.isGridCreated(10, 11)).toBe(true);
    expect(instance.gridManager.isGridCreated(10, 11)).toBe(true);
    expect(parent.gridManager.isGridLoaded(10, 11)).toBe(false);
  });

  test("fully created / loaded counters", () => {
    const map = new FakeMap();
    const m = map.gridManager;
    expect(m.isGridsFullyCreated()).toBe(false);
    for (let x = 0; x < MAX_NUMBER_OF_GRIDS; ++x) for (let y = 0; y < MAX_NUMBER_OF_GRIDS; ++y) m.createGrid(x, y);
    expect(m.isGridsFullyCreated()).toBe(true);
    expect(m.isGridsFullyLoaded()).toBe(false);
    for (let x = 0; x < MAX_NUMBER_OF_GRIDS; ++x) for (let y = 0; y < MAX_NUMBER_OF_GRIDS; ++y) m.loadGrid(x, y);
    expect(m.isGridsFullyLoaded()).toBe(true);
    expect(m.getCreatedCellsInMapCount()).toBe(0);
  });

  test("cells are created on first use and counted per grid and map", () => {
    const map = new FakeMap();
    map.place(new FakeCreature(store, 1, cellX(390), cellX(257)));
    map.place(new FakeCreature(store, 2, cellX(390), cellX(257)));
    map.place(new FakeCreature(store, 3, cellX(385), cellX(262)));
    map.place(new FakeCreature(store, 4, cellX(395), cellX(257)));
    expect(map.gridManager.getCreatedCellsInGridCount(48, 32)).toBe(2);
    expect(map.gridManager.getCreatedCellsInGridCount(49, 32)).toBe(1);
    expect(map.gridManager.getCreatedCellsInMapCount()).toBe(3);
  });
});

/** Every object in the grid's cells, by type. */
function gridContents(map: FakeMap, gx = 48, gy = 32): { creatures: number[]; gameobjects: number[]; corpses: number[]; players: number[] } {
  const out = { creatures: [] as number[], gameobjects: [] as number[], corpses: [] as number[], players: [] as number[] };
  const grid = map.gridManager.getGrid(gx, gy);
  if (!grid) return out;
  for (let x = 0; x < 8; ++x) {
    for (let y = 0; y < 8; ++y) {
      const c = grid.getCell(x, y)?.getGridObjects();
      if (!c) continue;
      out.creatures.push(...[...c.Creature].map(low));
      out.gameobjects.push(...[...c.GameObject].map(low));
      out.corpses.push(...[...c.Corpse].map(low));
      out.players.push(...[...c.Player].map(low));
    }
  }
  for (const list of Object.values(out)) list.sort((a, b) => a - b);
  return out;
}

describe("GridObjectLoader", () => {
  test("loads exactly the creatures and gameobjects stored for the grid", () => {
    spawn("creature", 1, 390, 257);
    spawn("creature", 2, 385, 262);
    spawn("gameobject", 10, 391, 256);
    spawn("creature", 3, 395, 257); // grid 49
    store.add("creature", { guid: 5, id: 1, map: 1, x: cellX(390), y: cellX(257), z: 0, phaseMask: 1, spawnGroupId: 0, poolId: 0 }, 0, GRID_ID); // other map

    const map = new FakeMap();
    expect(map.ensureGridLoaded(new Cell(cellX(390), cellX(257)))).toBe(true);

    expect(gridContents(map)).toEqual({ creatures: [1, 2], gameobjects: [10], corpses: [], players: [] });
    const grid = map.gridManager.getGrid(48, 32)!;
    const [c1] = [...grid.getCell(6, 1)!.getGridObjects().Creature];
    expect(c1!.isInWorld()).toBe(true);
    expect(c1!.getCurrentCell().equals(new Cell(cellX(390), cellX(257)))).toBe(true);
    expect(map.pendingUpdate.has(c1!)).toBe(true);
    // grid 49 is not loaded by loading grid 48
    expect(map.gridManager.isGridCreated(49, 32)).toBe(false);
  });

  test("skips inactive spawn groups, unspawned pool members, and failed loads", () => {
    spawn("creature", 1, 390, 257);
    spawn("creature", 2, 390, 257, { spawnGroupId: 7 });
    spawn("creature", 3, 390, 257, { poolId: 4 });
    spawn("creature", 4, 390, 257, { poolId: 4 });
    spawn("creature", 5, 390, 257, { failLoad: true });
    spawn("gameobject", 10, 390, 257, { spawnGroupId: 7 });
    spawn("gameobject", 11, 390, 257, { poolId: 9 });
    spawn("gameobject", 12, 390, 257);

    const map = new FakeMap();
    map.spawnGroupsInactive.add(7);
    map.unspawnedPoolMembers.add("Creature:4");
    map.unspawnedPoolMembers.add("GameObject:11");
    map.ensureGridLoaded(new Cell(cellX(390), cellX(257)));

    expect(gridContents(map)).toEqual({ creatures: [1, 3], gameobjects: [12], corpses: [], players: [] });
  });

  test("static transports load through their own hook and stay out of the grid", () => {
    const row = spawn("gameobject", 20, 390, 257);
    store.staticTransportEntries.add(row.id);
    const loaded: [number, boolean | undefined][] = [];
    GridObjectLoaderHooks.createStaticTransport = () => ({
      loadGameObjectFromDB: (spawnId, _map, addToMap) => {
        loaded.push([spawnId, addToMap]);
        return true;
      },
    });

    const map = new FakeMap();
    map.ensureGridLoaded(new Cell(cellX(390), cellX(257)));
    expect(loaded).toEqual([[20, true]]);
    expect(gridContents(map).gameobjects).toEqual([]);
  });

  test("adds the map's corpses of the grid that are not in the grid yet", () => {
    const map = new FakeMap();
    const a = new FakeCorpse(1, cellX(390), cellX(257));
    const b = new FakeCorpse(2, cellX(386), cellX(260));
    a.setMap(map);
    b.setMap(map);
    map.corpsesByGrid.set(GRID_ID, new Set([a, b]));
    // b is already stored (Map::AddToGrid from Player::BuildPlayerRepop before the grid loaded)
    map.ensureGridCreated(new GridCoord(48, 32));
    map.gridManager.getGrid(48, 32)!.addGridObject(2, 4, b);

    map.gridManager.loadGrid(48, 32);
    expect(gridContents(map).corpses).toEqual([1, 2]);
    expect(a.isInWorld()).toBe(true);
    expect(b.isInWorld()).toBe(false);
  });

  test("without an ObjectMgr hook nothing is spawned", () => {
    spawn("creature", 1, 390, 257);
    GridObjectLoaderHooks.objectMgr = null;
    const map = new FakeMap();
    expect(map.ensureGridLoaded(new Cell(cellX(390), cellX(257)))).toBe(true);
    expect(gridContents(map).creatures).toEqual([]);
  });
});

describe("MapGridManager::UnloadGrid", () => {
  test("cleans every object, empties the remove list, deletes creatures and gameobjects, and drops the grid", () => {
    spawn("creature", 1, 390, 257);
    spawn("creature", 2, 385, 262);
    spawn("gameobject", 10, 391, 256);
    const map = new FakeMap();
    const corpse = new FakeCorpse(30, cellX(388), cellX(258));
    corpse.setMap(map);
    map.corpsesByGrid.set(GRID_ID, new Set([corpse]));
    map.ensureGridLoaded(new Cell(cellX(390), cellX(257)));
    const player = new FakePlayer(40, cellX(389), cellX(259));
    map.place(player);

    const grid = map.gridManager.getGrid(48, 32)!;
    const objects = [...grid.getCell(6, 1)!.getGridObjects().Creature, ...grid.getCell(1, 6)!.getGridObjects().Creature, ...grid.getCell(7, 0)!.getGridObjects().GameObject] as FakeCreature[];
    expect(objects.length).toBe(3);

    map.gridManager.unloadGrid(48, 32);

    // GridObjectCleaner, then GridObjectUnloader: each creature and gameobject is cleaned twice
    for (const obj of objects) {
      expect(obj.cleanupsCalls).toBe(2);
      expect(obj.isInGrid()).toBe(false);
      expect(obj.isInWorld()).toBe(false);
      expect(map.removedFromUpdateList).toContain(obj);
    }
    // the corpse is cleaned but stays (corpses are deleted with Map); players are not visited
    expect(corpse.cleanupsCalls).toBe(1);
    expect(corpse.isInGrid()).toBe(true);
    expect(player.cleanupsCalls).toBe(0);
    expect(player.isInGrid()).toBe(true);
    expect(map.removeAllObjectsInRemoveListCalls).toBe(1);

    expect(map.gridManager.isGridCreated(48, 32)).toBe(false);
    expect(map.gridManager.getGrid(48, 32)).toBeNull();
    expect(map.getSize()).toBe(0);
    // the C++ keeps the counters
    expect(map.gridManager.getCreatedGridsCount()).toBe(1);
    expect(map.gridManager.getLoadedGridsCount()).toBe(1);

    // the grid can be created and loaded again
    map.gridManager.createGrid(48, 32);
    expect(map.gridManager.loadGrid(48, 32)).toBe(true);
    expect(gridContents(map).creatures).toEqual([1, 2]);
  });

  test("unloading a grid that does not exist does nothing", () => {
    const map = new FakeMap();
    map.gridManager.unloadGrid(1, 1);
    expect(map.removeAllObjectsInRemoveListCalls).toBe(0);
  });
});
