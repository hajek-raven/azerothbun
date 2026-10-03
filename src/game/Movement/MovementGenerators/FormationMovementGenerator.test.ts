import { beforeEach, describe, expect, test } from "bun:test";
import { creature_formations } from "../../../database/schema/world.ts";
import { WorldTables } from "../../../database/world-tables.ts";
import { UNIT_STATE_FOLLOW_MOVE, UNIT_STATE_ROOT } from "../../../spells/enums.ts";
import { GroupAIFlags, SearchFormation, sFormationMgr } from "../../Entities/Creature/CreatureGroups.ts";
import { FORMATION_MOTION_TYPE, MOTION_SLOT_IDLE } from "../MotionMaster.ts";
import { FakeMap, FakeUnit } from "../test-movement-owner.ts";
import { FormationMovementGenerator } from "./FormationMovementGenerator.ts";

beforeEach(() => {
  sFormationMgr().CreatureGroupMap.clear();
  sFormationMgr().CreatureGroupMembers.clear();
});

function pair(angle = 0, dist = 3) {
  const map = new FakeMap();
  const leader = new FakeUnit({ pos: [100, 100, 0], spawnId: 1, map });
  const follower = new FakeUnit({ pos: [97, 100, 0], spawnId: 2, map });
  leader.motionMaster.initialize();
  follower.motionMaster.initialize();
  return { leader, follower, map, angle, dist };
}

describe("FormationMovementGenerator", () => {
  test("a standing leader: the follower does not move until the leader does", () => {
    const { leader, follower } = pair();
    follower.motionMaster.moveFormation(leader.asOwner(), 3, 0, 0, 0);
    expect(follower.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(FORMATION_MOTION_TYPE);
    follower.run(500);
    // the leader's position is not known yet: after the first interval the follower moves to its place
    expect(follower.recordingAI).not.toBeNull();
  });

  test("follows a leader that runs east and stops when the leader has arrived", () => {
    const { leader, follower } = pair();
    follower.motionMaster.moveFormation(leader.asOwner(), 3, Math.PI / 2, 0, 0);
    leader.motionMaster.movePoint(1, 160, 100, 0);
    for (let t = 0; t < 15_000; t += 100) {
      leader.advance(100);
      follower.advance(100);
    }
    expect(leader.x).toBeCloseTo(160, 1);
    expect(Math.hypot(follower.x - leader.x, follower.y - leader.y)).toBeLessThan(6);
    expect(follower.x).toBeGreaterThan(150);
    expect(follower.movespline.finalized()).toBe(true); // stopped when the leader's spline was done (`_hasPredictedDestination`)
  });

  test("a leader that moved without a spline: the follower walks to its place, faces like the leader and tells the AI", () => {
    const { leader, follower } = pair();
    leader.o = 1.0;
    follower.motionMaster.moveFormation(leader.asOwner(), 3, Math.PI / 2, 0, 0);
    leader.x = 120;
    follower.run(14_000); // 20 yards at the walk speed
    // `MovePositionToFirstCollision(dest, range, angle + relativeAngle)` from the leader's position
    expect(Math.hypot(follower.x - 120, follower.y - 100)).toBeCloseTo(3, 1);
    expect(follower.o).toBeCloseTo(1.0, 3);
    expect(follower.recordingAI!.calls).toContain(`MovementInform(${FORMATION_MOTION_TYPE},0)`);
    expect(follower.movespline.finalized()).toBe(true);
  });

  test("takes the leader's spline velocity (scaled by how far behind it is)", () => {
    const { leader, follower } = pair();
    leader.speeds[1] = 9;
    follower.motionMaster.moveFormation(leader.asOwner(), 3, 0, 0, 0);
    leader.motionMaster.movePoint(1, 200, 100, 0);
    leader.advance(100);
    follower.advance(100);
    expect(follower.movespline.finalized()).toBe(false);
    expect(follower.hasUnitState(UNIT_STATE_FOLLOW_MOVE)).toBe(true);
    expect(follower.movespline.velocity()).toBeGreaterThan(5);
    expect(follower.movespline.velocity()).toBeLessThanOrEqual(9 * 1.5 + 0.01);
  });

  test("walks at the leader's walk speed when the leader is not moving a spline but has moved", () => {
    const { leader, follower } = pair();
    follower.motionMaster.moveFormation(leader.asOwner(), 3, 0, 0, 0);
    leader.x = 120; // teleported
    follower.run(1500);
    expect(follower.movespline.velocity()).toBeCloseTo(2.5, 3);
  });

  test("the angle is mirrored when the leader passes one of the two waypoints (point_1 / point_2)", () => {
    sFormationMgr().loadCreatureFormations(
      WorldTables.fromRows([[creature_formations, [{ leaderGUID: 1, memberGUID: 1, dist: 0, angle: 0, groupAI: 0, point_1: 0, point_2: 0 }, { leaderGUID: 1, memberGUID: 2, dist: 3, angle: 90, groupAI: GroupAIFlags.GROUP_AI_FLAG_FOLLOW_LEADER, point_1: 3, point_2: 0 }]]]),
      () => true,
    );
    const { leader, follower } = pair();
    SearchFormation(leader.asCreature());
    SearchFormation(follower.asCreature());
    follower.motionMaster.moveFormation(leader.asOwner(), 3, Math.PI / 2, 3, 0);
    leader.waypointId = 2; // the next waypoint is 3 = point_1
    leader.motionMaster.movePoint(1, 160, 100, 0);
    leader.advance(100);
    follower.advance(100);
    // the offset angle is 2pi - pi/2 now: the follower is on the other side (-y) of the leader's path (it would be +y otherwise)
    expect(follower.movespline.finalDestination().y).toBeCloseTo(97, 1);

    const { leader: l2, follower: f2 } = pair();
    f2.motionMaster.moveFormation(l2.asOwner(), 3, Math.PI / 2, 3, 0);
    l2.waypointId = 7; // not one of the points
    l2.motionMaster.movePoint(1, 160, 100, 0);
    l2.advance(100);
    f2.advance(100);
    expect(f2.movespline.finalDestination().y).toBeCloseTo(103, 1);
  });

  test("a rooted follower stops; free again it carries on", () => {
    const { leader, follower } = pair();
    follower.motionMaster.moveFormation(leader.asOwner(), 3, 0, 0, 0);
    leader.motionMaster.movePoint(1, 160, 100, 0);
    leader.advance(100);
    follower.advance(100);
    follower.addUnitState(UNIT_STATE_ROOT);
    follower.advance(100);
    expect(follower.movespline.finalized()).toBe(true);
    follower.clearUnitState(UNIT_STATE_ROOT);
    leader.advance(100);
    follower.run(2000);
    expect(follower.x).toBeGreaterThan(100);
  });

  test("the follower registers with the leader and unregisters when the generator goes away", () => {
    const { leader, follower } = pair();
    follower.motionMaster.moveFormation(leader.asOwner(), 3, 0, 0, 0);
    expect(leader.followers.size).toBe(1);
    follower.motionMaster.initialize(); // deletes every generator
    expect(leader.followers.size).toBe(0);
    expect(follower.hasUnitState(UNIT_STATE_FOLLOW_MOVE)).toBe(false);
  });

  test("direct use", () => {
    const { leader } = pair();
    const gen = new FormationMovementGenerator(leader.asOwner(), 3, 1, 4, 5);
    expect(gen.getMovementGeneratorType()).toBe(FORMATION_MOTION_TYPE);
    expect(gen.getTarget()).toBe(leader.asOwner());
    expect(gen.update(new FakeUnit().asOwner(), 10)).toBe(true); // a creature with a target: not finished
    gen.destroy();
    expect(gen.getTarget()).toBeNull();
    expect(gen.update(new FakeUnit().asOwner(), 10)).toBe(false); // no leader: the generator ends
  });
});
