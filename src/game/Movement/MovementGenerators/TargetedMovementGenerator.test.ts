import { describe, expect, test } from "bun:test";
import { buildNavMesh, wallWorldTiles } from "../../../common/Detour/test-navmesh.ts";
import { MOVEMENTFLAG_FORWARD } from "../../Entities/Unit/UnitDefines.ts";
import { UNIT_STATE_CHASE, UNIT_STATE_CHASE_MOVE, UNIT_STATE_FOLLOW, UNIT_STATE_FOLLOW_MOVE, UNIT_STATE_NOT_MOVE, UNIT_STATE_NO_COMBAT_MOVEMENT, UNIT_STATE_ROOT } from "../../../spells/enums.ts";
import {
  CHASE_MOTION_TYPE,
  ChaseAngle,
  ChaseRange,
  FOLLOW_MOTION_TYPE,
  IDLE_MOTION_TYPE,
  MOTION_SLOT_ACTIVE,
} from "../MotionMaster.ts";
import { FakeMap, FakeUnit } from "../test-movement-owner.ts";
import { CHASE_MODE_DISTANCING, CHASE_MODE_NORMAL, ChaseMovementGenerator, FollowMovementGenerator } from "./TargetedMovementGenerator.ts";

/** `owner` at `(ox, 0)` chasing `target` at `(tx, 0)`. */
function duel(ox: number, tx: number, ownerOpts: ConstructorParameters<typeof FakeUnit>[0] = {}) {
  const map = ownerOpts.map ?? new FakeMap();
  const owner = new FakeUnit({ pos: [ox, 0, 0], map, ...ownerOpts });
  const target = new FakeUnit({ pos: [tx, 0, 0], player: true, map });
  owner.motionMaster.initialize();
  target.motionMaster.initialize();
  owner.victim = target;
  return { owner, target, map };
}

const lastCall = (owner: FakeUnit) => owner.recordingAI!.calls[owner.recordingAI!.calls.length - 1];

describe("ChaseMovementGenerator", () => {
  test("runs at the target and stops at the edge of melee, facing it, and tells the AI the target's guid", () => {
    const { owner, target } = duel(0, 30);
    owner.motionMaster.moveChase(target.asOwner());
    expect(owner.hasUnitState(UNIT_STATE_CHASE)).toBe(true);
    expect(owner.motionMaster.getCurrentMovementGeneratorType()).toBe(CHASE_MOTION_TYPE);
    owner.advance(100);
    expect(owner.hasUnitState(UNIT_STATE_CHASE_MOVE)).toBe(true);
    expect(owner.movespline.finalized()).toBe(false);
    owner.run(5000);
    // the path to the center is shortened until `CONTACT_DISTANCE + both combat reaches`: 3.5 yards
    expect(Math.abs(owner.x - 30)).toBeLessThan(3.6);
    expect(Math.abs(owner.x - 30)).toBeGreaterThan(3.3);
    expect(owner.hasUnitState(UNIT_STATE_CHASE_MOVE)).toBe(false);
    expect(owner.hasUnitState(UNIT_STATE_CHASE)).toBe(true);
    expect(owner.o).toBeCloseTo(0, 3); // `SetInFront(target)`: the target is straight ahead
    expect(owner.recordingAI!.calls).toContain(`MovementInform(${CHASE_MOTION_TYPE},${Number(target.guid & 0xffffffn)})`);
    expect(owner.cannotReachTarget).toBe(0n);
  });

  test("a target that moves away is followed with new splines", () => {
    const { owner, target } = duel(0, 20);
    owner.motionMaster.moveChase(target.asOwner());
    owner.advance(100);
    const firstId = owner.movespline.getId();
    for (let i = 0; i < 40; ++i) {
      target.x += 0.35; // 3.5 yards per second against the owner's 7
      owner.advance(100);
    }
    expect(owner.movespline.getId()).toBeGreaterThan(firstId);
    expect(owner.x).toBeGreaterThan(15);
    expect(Math.abs(owner.x - target.x)).toBeLessThan(16);
  });

  test("a stationary target is not re-pathed while the owner runs to it", () => {
    const { owner, target } = duel(0, 40);
    owner.motionMaster.moveChase(target.asOwner());
    owner.advance(100);
    const id = owner.movespline.getId();
    owner.run(1500);
    expect(owner.movespline.getId()).toBe(id);
  });

  test("a ranged chaser (ChaseRange 10) stops 13 yards from the center: range plus both combat reaches", () => {
    const { owner, target } = duel(0, 50);
    owner.motionMaster.moveChase(target.asOwner(), new ChaseRange(10));
    owner.run(10_000);
    const dist = target.x - owner.x;
    expect(dist).toBeLessThan(13.05);
    expect(dist).toBeGreaterThan(9);
    expect(owner.movespline.finalized()).toBe(true);
    expect(owner.hasUnitState(UNIT_STATE_CHASE_MOVE)).toBe(false);
  });

  test("a ranged chaser that is already in range does not move (and is told it has arrived)", () => {
    const { owner, target } = duel(0, 8);
    owner.motionMaster.moveChase(target.asOwner(), new ChaseRange(10));
    owner.run(1000);
    expect(owner.x).toBe(0);
    expect(owner.recordingAI!.calls.some((c) => c.startsWith("MovementInform(5,"))).toBe(true);
  });

  test("with a chase angle the chaser goes around to the requested side of the target", () => {
    const { owner, target } = duel(60, 30);
    target.o = 0; // facing +x, the chaser comes from the front
    owner.motionMaster.moveChase(target.asOwner(), new ChaseRange(1), new ChaseAngle(Math.PI, 0.3));
    owner.run(15_000);
    expect(owner.x).toBeLessThan(30); // behind the target
    expect(Math.abs(owner.y)).toBeLessThan(2);
    expect(30 - owner.x).toBeLessThan(5.5);
  });

  test("not the victim any more: the owner stops and clears the cannot-reach state", () => {
    const { owner, target } = duel(0, 40);
    owner.motionMaster.moveChase(target.asOwner());
    owner.run(500);
    expect(owner.movespline.finalized()).toBe(false);
    owner.victim = null;
    owner.cannotReachTarget = 5n;
    owner.advance(100);
    expect(owner.movespline.finalized()).toBe(true);
    expect(owner.cannotReachTarget).toBe(0n);
    expect(owner.motionMaster.getCurrentMovementGeneratorType()).toBe(CHASE_MOTION_TYPE); // the generator is kept
  });

  test("a rooted or casting owner stops; when it can move again it chases on", () => {
    const { owner, target } = duel(0, 40);
    owner.motionMaster.moveChase(target.asOwner());
    owner.run(500);
    owner.addUnitState(UNIT_STATE_ROOT);
    owner.advance(100);
    expect(owner.movespline.finalized()).toBe(true);
    owner.clearUnitState(UNIT_STATE_ROOT);
    owner.run(200);
    expect(owner.movespline.finalized()).toBe(false);
    owner.movementPreventedByCasting = true;
    owner.advance(100);
    expect(owner.movespline.finalized()).toBe(true);
  });

  test("scripted no-combat-movement stops the owner", () => {
    const { owner, target } = duel(0, 40);
    owner.motionMaster.moveChase(target.asOwner());
    owner.run(500);
    owner.addUnitState(UNIT_STATE_NO_COMBAT_MOVEMENT);
    owner.advance(100);
    expect(owner.movespline.finalized()).toBe(true);
  });

  test("a target that left the world ends the generator", () => {
    const { owner, target } = duel(0, 40);
    owner.motionMaster.moveChase(target.asOwner());
    owner.run(300);
    target.inWorld = false;
    owner.advance(100);
    expect(owner.motionMaster.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
    expect(owner.hasUnitState(UNIT_STATE_CHASE)).toBe(false);
    expect(target.followers.size).toBe(0); // the follower registration is gone
  });

  test("a dead owner ends the generator", () => {
    const { owner, target } = duel(0, 40);
    owner.motionMaster.moveChase(target.asOwner());
    owner.alive = false;
    owner.advance(100);
    expect(owner.motionMaster.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
  });

  test("a target the owner cannot get to: the owner is marked as unable to reach it and does not move", () => {
    const { owner, target } = duel(0, 40);
    target.accessible = false;
    owner.motionMaster.moveChase(target.asOwner());
    owner.run(500);
    expect(owner.cannotReachTarget).toBe(target.guid);
    expect(owner.movespline.finalized()).toBe(true);
  });

  test("a chase without a route (no polygon at the target) marks the target as unreachable", () => {
    const { t00, t10, t01 } = wallWorldTiles(4);
    const { mesh, query } = buildNavMesh(10, [t00, t10, t01], 2048, 4);
    const map = new FakeMap(0, { navMesh: mesh, query });
    const owner = new FakeUnit({ pos: [10, 10, 0], map });
    const target = new FakeUnit({ pos: [10, 12, 0], player: true, map });
    owner.motionMaster.initialize();
    owner.victim = target;
    owner.motionMaster.moveChase(target.asOwner());
    owner.run(2000);
    // the target stands next to the owner on the mesh: it is reachable and the owner stands still
    expect(owner.cannotReachTarget).toBe(0n);
  });

  test("distance yourself: the chaser runs away from the target in the distancing mode and the AI is told", () => {
    const { owner, target } = duel(0, 5);
    owner.motionMaster.moveChase(target.asOwner(), new ChaseRange(10));
    owner.advance(100);
    const gen = owner.motionMaster.top() as ChaseMovementGenerator<never>;
    owner.motionMaster.distanceYourself(12);
    expect(owner.recordingAI!.calls).toContain("DistancingStarted()");
    expect(owner.movespline.finalized()).toBe(false);
    expect(gen).toBeInstanceOf(ChaseMovementGenerator);
    expect(owner.movespline.finalDestination().x).toBeCloseTo(5 - 15.5, 3); // `GetNearPoint`: both reaches, boundary radius and the distance
    let minX = 0;
    for (let t = 0; t < 5000; t += 100) {
      owner.advance(100);
      minX = Math.min(minX, owner.x);
    }
    expect(minX).toBeLessThan(-10); // it ran away from the target (which is at +x)
    expect(owner.recordingAI!.calls).toContain("DistancingEnded()");
    // and then the ranged chase brings it back to 13 yards from the center
    expect(5 - owner.x).toBeLessThan(13.1);
  });

  test("distance yourself does nothing when the unit is not chasing", () => {
    const { owner } = duel(0, 5);
    owner.motionMaster.distanceYourself(12);
    expect(owner.recordingAI!.calls).toEqual([]);
  });

  test("retargeting resets the generator state; the follower registration moves to the new target", () => {
    const { owner, target, map } = duel(0, 20);
    const other = new FakeUnit({ pos: [-20, 0, 0], player: true, map });
    owner.motionMaster.moveChase(target.asOwner());
    expect(target.followers.size).toBe(1);
    owner.motionMaster.moveChase(other.asOwner());
    expect(target.followers.size).toBe(0);
    expect(other.followers.size).toBe(1);
    owner.victim = other;
    owner.run(500);
    expect(owner.x).toBeLessThan(0);
  });

  test("a player chases too (no AI call, no cannot-reach state)", () => {
    const map = new FakeMap();
    const player = new FakeUnit({ player: true, pos: [0, 0, 0], map });
    const target = new FakeUnit({ pos: [20, 0, 0], map });
    player.motionMaster.initialize();
    player.victim = target;
    player.motionMaster.moveChase(target.asOwner());
    player.run(5000);
    expect(Math.abs(player.x - 20)).toBeLessThan(3.6);
  });

  test("the mode is back to normal after the AI was told", () => {
    expect(CHASE_MODE_NORMAL).toBe(0);
    expect(CHASE_MODE_DISTANCING).toBe(2);
  });

  test("direct use", () => {
    const { owner, target } = duel(0, 20);
    const gen = new ChaseMovementGenerator<never>(target.asOwner(), null, null);
    expect(gen.getMovementGeneratorType()).toBe(CHASE_MOTION_TYPE);
    expect(gen.getTarget()).toBe(target.asOwner());
    expect(gen.enableWalking()).toBe(false);
    expect(gen.hasLostTarget(owner.asOwner())).toBe(false);
    owner.victim = null;
    expect(gen.hasLostTarget(owner.asOwner())).toBe(true);
    expect(target.followers.size).toBe(1);
    gen.destroy(); // `~AbstractFollower`: `SetTarget(nullptr)`
    expect(gen.getTarget()).toBeNull();
    expect(target.followers.size).toBe(0);
  });
});

describe("FollowMovementGenerator", () => {
  function follower(opts: ConstructorParameters<typeof FakeUnit>[0] = {}) {
    const map = new FakeMap();
    const leader = new FakeUnit({ pos: [100, 100, 0], player: true, map });
    const pet = new FakeUnit({ pos: [90, 100, 0], map, ...opts });
    pet.charmerOrOwner = leader;
    leader.motionMaster.initialize();
    pet.motionMaster.initialize();
    return { leader, pet };
  }

  test("goes to the requested distance and angle from the target, then faces like the target", () => {
    const { leader, pet } = follower();
    leader.o = 1.2;
    pet.motionMaster.moveFollow(leader.asOwner(), 2, Math.PI);
    expect(pet.motionMaster.getCurrentMovementGeneratorType()).toBe(FOLLOW_MOTION_TYPE);
    expect(pet.hasUnitState(UNIT_STATE_FOLLOW)).toBe(true);
    pet.advance(100);
    expect(pet.hasUnitState(UNIT_STATE_FOLLOW_MOVE)).toBe(true);
    pet.run(5000);
    // `combat reach + range` (3.5 yards) at the absolute angle `target orientation + pi`
    const d = Math.hypot(pet.x - leader.x, pet.y - leader.y);
    expect(d).toBeCloseTo(3.5, 1);
    const behind = leader.o + Math.PI;
    expect(pet.x).toBeCloseTo(100 + 3.5 * Math.cos(behind), 1);
    expect(pet.y).toBeCloseTo(100 + 3.5 * Math.sin(behind), 1);
    expect(pet.hasUnitState(UNIT_STATE_FOLLOW_MOVE)).toBe(false);
    expect(pet.o).toBeCloseTo(1.2, 3); // `SetFacingTo(target orientation)`
    expect(pet.recordingAI!.calls).toContain(`MovementInform(${FOLLOW_MOTION_TYPE},${Number(leader.guid & 0xffffffn)})`);
  });

  test("when the target moves the follower repaths; when it stands still it stays put", () => {
    const { leader, pet } = follower();
    pet.motionMaster.moveFollow(leader.asOwner(), 2, Math.PI);
    pet.run(5000);
    const id = pet.movespline.getId();
    pet.run(1000);
    expect(pet.movespline.getId()).toBe(id);
    leader.x += 20;
    pet.advance(100);
    expect(pet.movespline.getId()).toBeGreaterThan(id);
    pet.run(6000);
    expect(pet.x).toBeGreaterThan(110);
  });

  test("walks when the target walks (inherit walk state) and runs otherwise", () => {
    const { leader, pet } = follower();
    leader.walking = true;
    pet.motionMaster.moveFollow(leader.asOwner(), 2, Math.PI, MOTION_SLOT_ACTIVE, true, false);
    pet.advance(100);
    expect(pet.movespline.velocity()).toBeCloseTo(2.5, 3);

    const { leader: l2, pet: p2 } = follower();
    p2.motionMaster.moveFollow(l2.asOwner(), 2, Math.PI, MOTION_SLOT_ACTIVE, false, false);
    l2.walking = true;
    p2.advance(100);
    expect(p2.movespline.velocity()).toBeCloseTo(7, 3);
  });

  test("a pet-like follower takes the target's speed when it inherits speed", () => {
    const { leader, pet } = follower();
    leader.speeds[1] = 9;
    pet.motionMaster.moveFollow(leader.asOwner(), 2, Math.PI, MOTION_SLOT_ACTIVE, false, true);
    pet.advance(100);
    expect(pet.movespline.velocity()).toBeCloseTo(9, 3);
  });

  test("rooted: stops and forgets the path; unrooted: follows again", () => {
    const { leader, pet } = follower();
    pet.motionMaster.moveFollow(leader.asOwner(), 2, Math.PI);
    pet.advance(100);
    pet.addUnitState(UNIT_STATE_NOT_MOVE);
    pet.advance(100);
    expect(pet.movespline.finalized()).toBe(true);
    pet.clearUnitState(UNIT_STATE_NOT_MOVE);
    pet.advance(100);
    expect(pet.movespline.finalized()).toBe(false);
  });

  test("ends when the target leaves the world; the follow states are cleared", () => {
    const { leader, pet } = follower();
    pet.motionMaster.moveFollow(leader.asOwner(), 2, Math.PI);
    pet.advance(100);
    leader.inWorld = false;
    pet.advance(100);
    expect(pet.motionMaster.getCurrentMovementGeneratorType()).toBe(IDLE_MOTION_TYPE);
    expect(pet.hasUnitState(UNIT_STATE_FOLLOW)).toBe(false);
    expect(pet.hasUnitState(UNIT_STATE_FOLLOW_MOVE)).toBe(false);
    expect(leader.followers.size).toBe(0);
  });

  test("a moving player target is predicted: the guardian aims ahead of the player", () => {
    const { leader, pet } = follower({ pos: [90, 100, 0] });
    // `isPlayerPet`: a guardian following a player
    (pet as unknown as { isGuardian: () => boolean }).isGuardian = () => true;
    leader.addUnitMovementFlag(MOVEMENTFLAG_FORWARD);
    leader.o = 0;
    pet.motionMaster.moveFollow(leader.asOwner(), 2, Math.PI);
    pet.advance(100); // the first pass has no last target position yet: no prediction
    expect(pet.movespline.finalDestination().x).toBeCloseTo(96.5, 2); // behind the player at (100, 100)
    pet.advance(100); // now the moving player is predicted half a second (3.5 yards) ahead
    expect(pet.movespline.finalDestination().x).toBeCloseTo(100, 2);
  });

  test("a creature follower far away from a player it cannot path to is teleported next to it", () => {
    const { t00, t10, t01 } = wallWorldTiles(4);
    const { mesh, query } = buildNavMesh(10, [t00, t10, t01], 2048, 4);
    const map = new FakeMap(0, { navMesh: mesh, query });
    const leader = new FakeUnit({ pos: [10, 35, 500], player: true, map }); // no polygon within reach
    const pet = new FakeUnit({ pos: [10, 10, 0], map });
    pet.charmerOrOwner = leader;
    leader.motionMaster.initialize();
    pet.motionMaster.initialize();
    pet.motionMaster.moveFollow(leader.asOwner(), 2, Math.PI);
    pet.advance(100);
    expect(pet.teleports.length).toBe(1);
    expect(pet.teleports[0]![3]).toBe(leader.o);
  });

  test("direct use", () => {
    const { leader, pet } = follower();
    const gen = new FollowMovementGenerator<never>(leader.asOwner(), 2, new ChaseAngle(1), true, true);
    expect(gen.getMovementGeneratorType()).toBe(FOLLOW_MOTION_TYPE);
    expect(gen.getFollowRange()).toBe(2);
    expect(gen.getTarget()).toBe(leader.asOwner());
    FollowMovementGenerator._addUnitStateMove(pet.asOwner());
    expect(pet.hasUnitState(UNIT_STATE_FOLLOW_MOVE)).toBe(true);
    FollowMovementGenerator._clearUnitStateMove(pet.asOwner());
    expect(pet.hasUnitState(UNIT_STATE_FOLLOW_MOVE)).toBe(false);
    expect(lastCall(pet)).toBeUndefined();
  });
});
