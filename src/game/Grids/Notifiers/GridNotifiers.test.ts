import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Object as AcObject } from "../../Entities/Object/Object.ts";
import type { WorldPacket } from "../../Entities/Object/Updates/UpdateData.ts";
import { Cell } from "../Cells/Cell.ts";
import { SIZE_OF_GRID_CELL } from "../GridDefines.ts";
import { FakeCreature, FakeGameObject, FakeMap, FakeObjectMgr, FakePlayer } from "../Grids.test-util.ts";
import { MessageDistDeliverer, TeamFilter, VisibleNotifier } from "./GridNotifiers.ts";

/** The center of cell (390, 257). */
const CX = -134.5 * SIZE_OF_GRID_CELL;
const CY = -1.5 * SIZE_OF_GRID_CELL;
const PACKET: WorldPacket = { opcode: 0x1234, payload: new Uint8Array([1, 2, 3]) };

let store: FakeObjectMgr;
let map: FakeMap;
const savedBuilder = AcObject.createUpdateBlockBuilder;

beforeEach(() => {
  store = new FakeObjectMgr();
  map = new FakeMap();
  // one byte per create block: the notifier only counts them
  AcObject.createUpdateBlockBuilder = () => new Uint8Array([0xcc]);
});

afterEach(() => {
  AcObject.createUpdateBlockBuilder = savedBuilder;
});

/** A player on the map that already has `source` at its client (`SendPacket` requires it). */
function listener(guid: number, dx: number, opts: { z?: number; phaseMask?: number; team?: number } = {}, source?: FakePlayer | FakeCreature): FakePlayer {
  const p = new FakePlayer(guid, CX + dx, CY, opts.z ?? 0, opts.phaseMask ?? 1);
  p.teamId = opts.team ?? 0;
  map.place(p);
  if (source) p.getObjectVisibilityContainer().linkWorldObjectVisibility(source);
  return p;
}

describe("MessageDistDeliverer", () => {
  test("delivers to players in range and phase that see the source, never to the source", () => {
    const source = new FakePlayer(1, CX, CY);
    map.place(source);
    const near = listener(2, 10, {}, source);
    const far = listener(3, 50, {}, source);
    const otherPhase = listener(4, 10, { phaseMask: 2 }, source);
    const notAtClient = listener(5, 10);
    const lookingElsewhere = listener(6, 10, {}, source);
    lookingElsewhere.m_seer = far;

    const notifier = new MessageDistDeliverer(source, PACKET, 30);
    Cell.visitObjects(source, notifier, 30);

    expect(near.received).toEqual([PACKET]);
    expect(far.received).toEqual([]);
    expect(otherPhase.received).toEqual([]);
    expect(notAtClient.received).toEqual([]);
    expect(lookingElsewhere.received).toEqual([]);
    expect(source.received).toEqual([]);
  });

  test("the skipped receiver gets nothing", () => {
    const source = new FakePlayer(1, CX, CY);
    map.place(source);
    const a = listener(2, 5, {}, source);
    const b = listener(3, 5, {}, source);
    Cell.visitObjects(source, new MessageDistDeliverer(source, PACKET, 30, TeamFilter.All, b), 30);
    expect(a.received.length).toBe(1);
    expect(b.received.length).toBe(0);
  });

  test("team filters apply to a player source", () => {
    const source = new FakePlayer(1, CX, CY);
    source.teamId = 1;
    map.place(source);
    const ally = listener(2, 5, { team: 1 }, source);
    const enemy = listener(3, 5, { team: 0 }, source);

    Cell.visitObjects(source, new MessageDistDeliverer(source, PACKET, 30, TeamFilter.OwnTeam), 30);
    expect([ally.received.length, enemy.received.length]).toEqual([1, 0]);

    Cell.visitObjects(source, new MessageDistDeliverer(source, PACKET, 30, TeamFilter.OtherTeam), 30);
    expect([ally.received.length, enemy.received.length]).toEqual([1, 1]);
  });

  test("a non-player source ignores the team filter", () => {
    const source = new FakeCreature(store, 1, CX, CY);
    map.place(source);
    const p = listener(2, 5, { team: 1 }, source);
    Cell.visitObjects(source, new MessageDistDeliverer(source, PACKET, 30, TeamFilter.OtherTeam), 30);
    expect(p.received.length).toBe(1);
  });

  test("2D distance by default, 3D on request", () => {
    const source = new FakePlayer(1, CX, CY);
    map.place(source);
    const above = listener(2, 10, { z: 40 }, source);
    Cell.visitObjects(source, new MessageDistDeliverer(source, PACKET, 30), 30);
    expect(above.received.length).toBe(1);
    Cell.visitObjects(source, new MessageDistDeliverer(source, PACKET, 30, TeamFilter.All, null, true), 30);
    expect(above.received.length).toBe(1);
  });

  test("players sharing a creature's vision hear what the creature hears", () => {
    const source = new FakePlayer(1, CX, CY);
    map.place(source);
    const eye = new FakeCreature(store, 7, CX + 10, CY);
    map.place(eye);
    const remote = new FakePlayer(8, CX + 2000, CY);
    map.place(remote);
    remote.getObjectVisibilityContainer().linkWorldObjectVisibility(source);
    remote.m_seer = eye;
    eye.sharedVision.push(remote);

    Cell.visitObjects(source, new MessageDistDeliverer(source, PACKET, 30), 30);
    expect(remote.received.length).toBe(1);
  });

  test("the visible players map variant filters by the listener's sight position", () => {
    const source = new FakePlayer(1, CX, CY);
    map.place(source);
    const near = listener(2, 10, {}, source);
    const far = listener(3, 50, {}, source);
    expect(source.getObjectVisibilityContainer().getVisiblePlayersMap().size).toBe(2);

    new MessageDistDeliverer(source, PACKET, 30).visitVisiblePlayersMap(source.getObjectVisibilityContainer().getVisiblePlayersMap());
    expect([near.received.length, far.received.length]).toEqual([1, 0]);
    // dist 0: everybody in the map
    new MessageDistDeliverer(source, PACKET, 0).visitVisiblePlayersMap(source.getObjectVisibilityContainer().getVisiblePlayersMap());
    expect([near.received.length, far.received.length]).toEqual([2, 1]);
  });
});

describe("VisibleNotifier", () => {
  function setup() {
    map.visibilityRange = 100;
    const player = new FakePlayer(1, CX, CY);
    map.place(player);
    const near = new FakeCreature(store, 2, CX + 50, CY);
    const outOfSight = new FakeCreature(store, 3, CX + 150, CY);
    const go = new FakeGameObject(store, 4, CX - 30, CY);
    for (const o of [near, outOfSight, go]) map.place(o);
    return { player, near, outOfSight, go };
  }

  function run(player: FakePlayer, gobjOnly = false): VisibleNotifier {
    const notifier = new VisibleNotifier(player, gobjOnly);
    Cell.visitObjects(player, notifier, player.getSightRange());
    notifier.sendToSelf();
    return notifier;
  }

  test("creates what came into sight and sends one update", () => {
    const { player, near, outOfSight, go } = setup();
    const n = run(player);

    expect(player.haveAtClient(near)).toBe(true);
    expect(player.haveAtClient(go)).toBe(true);
    expect(player.haveAtClient(outOfSight)).toBe(false);
    expect(n.i_data.getBlockCount()).toBe(2);
    expect(n.i_data.getOutOfRangeGUIDs()).toEqual([]);
    expect(player.received.length).toBe(1);
    // only units get the initial packets
    expect(player.initialVisiblePackets).toEqual([near]);
    expect(player.m_newVisible).toEqual([near]);
    // seen objects are queued for update (`AddObjectToPendingUpdateList`)
    expect(map.pendingUpdate.has(near)).toBe(true);
  });

  test("a second pass with nothing new sends nothing", () => {
    const { player } = setup();
    run(player);
    run(player);
    expect(player.received.length).toBe(1);
  });

  test("destroys what left sight, once", () => {
    const { player, near, go } = setup();
    run(player);
    // the creature walks away without changing cell: still visited, now out of sight
    near.relocate(CX + 400, CY, 0, 0);
    const n = run(player);
    expect(n.i_data.getOutOfRangeGUIDs()).toEqual([near.getGUID()]);
    expect(n.i_data.getBlockCount()).toBe(0);
    expect(player.haveAtClient(near)).toBe(false);
    expect(player.haveAtClient(go)).toBe(true);
    expect(near.getObjectVisibilityContainer().getVisiblePlayersMap().has(player.getGUID())).toBe(false);
  });

  test("an object no longer in any visited cell is destroyed by SendToSelf", () => {
    const { player, near } = setup();
    run(player);
    // move the creature's grid storage far away: the visit does not reach it any more
    near.removeFromGrid();
    near.relocate(CX + 2000, CY, 0, 0);
    map.ensureGridLoaded(new Cell(CX + 2000, CY));
    map.addToGrid(near, new Cell(CX + 2000, CY));
    const n = run(player);
    expect(n.i_data.getOutOfRangeGUIDs()).toEqual([near.getGUID()]);
    expect(player.haveAtClient(near)).toBe(false);
  });

  test("gobjOnly updates gameobjects only", () => {
    const { player, near, go } = setup();
    run(player, true);
    expect(player.haveAtClient(go)).toBe(true);
    expect(player.haveAtClient(near)).toBe(false);
  });
});
