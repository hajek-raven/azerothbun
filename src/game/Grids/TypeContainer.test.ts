import { describe, expect, test } from "bun:test";
import { TYPEID_CORPSE, TYPEID_GAMEOBJECT, TYPEID_PLAYER, TYPEID_UNIT } from "../Entities/Object/ObjectGuid.ts";
import { GridCell } from "./GridCell.ts";
import { FakeCorpse, FakeCreature, FakeGameObject, FakeObjectMgr, FakePlayer } from "./Grids.test-util.ts";
import { FarVisibleGridContainer, GridTypeMapContainer, TypeContainerVisitor, type GridTypeMapVisitor } from "./TypeContainer.ts";

function filled() {
  const store = new FakeObjectMgr();
  const c = new GridTypeMapContainer();
  const objs = {
    creature: new FakeCreature(store, 1),
    go: new FakeGameObject(store, 2),
    player: new FakePlayer(3, 0, 0),
    corpse: new FakeCorpse(4, 0, 0),
  };
  for (const o of Object.values(objs)) expect(c.insert(o)).toBe(true);
  return { c, objs, store };
}

describe("GridTypeMapContainer", () => {
  test("insert links the object into its type's list", () => {
    const { c, objs } = filled();
    expect(c.count(TYPEID_UNIT)).toBe(1);
    expect(c.count(TYPEID_GAMEOBJECT)).toBe(1);
    expect(c.count(TYPEID_PLAYER)).toBe(1);
    expect(c.count(TYPEID_CORPSE)).toBe(1);
    for (const o of Object.values(objs)) expect(o.isInGrid()).toBe(true);
    objs.creature.removeFromGrid();
    expect(c.count(TYPEID_UNIT)).toBe(0);
  });

  test("a visitor sees only the types it declares, in TYPELIST order", () => {
    const { c } = filled();
    const calls: string[] = [];
    const creaturesOnly: GridTypeMapVisitor = { visitCreatureMap: (m) => calls.push(`creature:${m.getSize()}`) };
    new TypeContainerVisitor(creaturesOnly, "GridTypeMapContainer").visit(c);
    expect(calls).toEqual(["creature:1"]);

    calls.length = 0;
    const all: GridTypeMapVisitor = {
      visitDynamicObjectMap: () => calls.push("dynobj"),
      visitCorpseMap: () => calls.push("corpse"),
      visitCreatureMap: () => calls.push("creature"),
      visitPlayerMap: () => calls.push("player"),
      visitGameObjectMap: () => calls.push("gameobject"),
    };
    new TypeContainerVisitor(all, "GridTypeMapContainer").visit(c);
    // TYPELIST_5(GameObject, Player, Creature, Corpse, DynamicObject)
    expect(calls).toEqual(["gameobject", "player", "creature", "corpse", "dynobj"]);
  });

  test("a walk survives objects unlinking themselves and skips objects linked during it", () => {
    const store = new FakeObjectMgr();
    const c = new GridTypeMapContainer();
    const creatures = [1, 2, 3].map((g) => new FakeCreature(store, g));
    for (const o of creatures) c.insert(o);
    const seen: FakeCreature[] = [];
    for (const o of c.Creature) {
      seen.push(o as FakeCreature);
      if (o === creatures[0]) {
        creatures[1]!.removeFromGrid(); // not reached yet: skipped
        o.removeFromGrid(); // the current one
        c.insert(new FakeCreature(store, 9)); // linked after the walk started: not visited
      }
    }
    expect(seen).toEqual([creatures[0]!, creatures[2]!]);
    expect(c.Creature.getSize()).toBe(2);
  });

  test("clearReferences invalidates every reference", () => {
    const { c, objs } = filled();
    c.Player.clearReferences();
    expect(c.Player.isEmpty()).toBe(true);
    expect(objs.player.isInGrid()).toBe(false);
  });
});

describe("FarVisibleGridContainer and GridCell", () => {
  test("holds creatures and gameobjects only", () => {
    const store = new FakeObjectMgr();
    const far = new FarVisibleGridContainer();
    const creature = new FakeCreature(store, 1);
    const go = new FakeGameObject(store, 2);
    expect(far.insert(creature)).toBe(true);
    expect(far.insert(go)).toBe(true);
    expect([far.count(TYPEID_UNIT), far.count(TYPEID_GAMEOBJECT), far.count(TYPEID_PLAYER)]).toEqual([1, 1, 0]);
    far.remove(creature);
    expect(far.count(TYPEID_UNIT)).toBe(0);
  });

  test("GridCell::Visit hands each visitor its own container", () => {
    const store = new FakeObjectMgr();
    const cell = new GridCell();
    const creature = new FakeCreature(store, 1);
    const big = new FakeCreature(store, 2);
    cell.addGridObject(creature);
    cell.addFarVisibleObject(big);

    const gridSeen: unknown[] = [];
    const farSeen: unknown[] = [];
    cell.visit(new TypeContainerVisitor({ visitCreatureMap: (m) => gridSeen.push(...m) }, "GridTypeMapContainer"));
    cell.visit(new TypeContainerVisitor({ visitCreatureVector: (v) => farSeen.push(...v) }, "FarVisibleGridContainer"));
    expect(gridSeen).toEqual([creature]);
    expect(farSeen).toEqual([big]);

    cell.removeFarVisibleObject(big);
    farSeen.length = 0;
    cell.visit(new TypeContainerVisitor({ visitCreatureVector: (v) => farSeen.push(...v) }, "FarVisibleGridContainer"));
    expect(farSeen).toEqual([]);
  });
});
