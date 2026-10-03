import { beforeEach, describe, expect, test } from "bun:test";
import { creature_formations } from "../../../database/schema/world.ts";
import { WORLD_TABLES } from "../../../database/world-table-list.ts";
import { WorldTables } from "../../../database/world-tables.ts";
import { UNIT_STATE_FOLLOW_MOVE } from "../../../spells/enums.ts";
import { getGameTime } from "../../time/game-time.ts";
import { FORMATION_MOTION_TYPE, IDLE_MOTION_TYPE, MOTION_SLOT_IDLE, NULL_MOTION_TYPE, WAYPOINT_MOTION_TYPE } from "../../Movement/MotionMaster.ts";
import { FakeMap, FakeUnit } from "../../Movement/test-movement-owner.ts";
import { WaypointNode, WaypointPath } from "../../Movement/Waypoints/WaypointDefines.ts";
import { WaypointMovementGenerator } from "../../Movement/MovementGenerators/WaypointMovementGenerator.ts";
import {
  CreatureGroup,
  FormationInfo,
  FormationMgr,
  GroupAIFlags,
  IsFormationLeader,
  IsFormationLeaderMoveAllowed,
  Motion_Initialize,
  SearchFormation,
  SignalFormationMovement,
  sFormationMgr,
} from "./CreatureGroups.ts";

const F = Math.fround;
const FOLLOW = GroupAIFlags.GROUP_AI_FLAG_FOLLOW_LEADER;
const ASSIST = GroupAIFlags.GROUP_AI_FLAG_MEMBER_ASSIST_LEADER | GroupAIFlags.GROUP_AI_FLAG_LEADER_ASSIST_MEMBER;

function row(leaderGUID: number, memberGUID: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { leaderGUID, memberGUID, dist: 0, angle: 0, groupAI: 0, point_1: 0, point_2: 0, ...extra };
}

function load(rows: Record<string, unknown>[], existing: number[]): void {
  sFormationMgr().loadCreatureFormations(WorldTables.fromRows([[creature_formations, rows]]), (id) => existing.includes(id));
}

beforeEach(() => {
  sFormationMgr().CreatureGroupMap.clear();
  sFormationMgr().CreatureGroupMembers.clear();
});

describe("FormationMgr::LoadCreatureFormations", () => {
  test("creature_formations is a loaded world table", () => {
    expect(WORLD_TABLES).toContain(creature_formations);
  });

  test("is the singleton", () => {
    expect(FormationMgr.instance()).toBe(sFormationMgr());
  });

  test("loads leader and members with the angle in radians, ordered by leader", () => {
    load([row(20, 21, { dist: 3, angle: 90, groupAI: FOLLOW | ASSIST, point_1: 4, point_2: 5 }), row(10, 11, { dist: 2, angle: 180, groupAI: FOLLOW }), row(10, 10, { groupAI: ASSIST })], [10, 11, 20, 21]);
    const map = sFormationMgr().CreatureGroupMap;
    expect(map.size).toBe(3);
    const m = map.get(21)!;
    expect(m.leaderGUID).toBe(20);
    expect(m.follow_dist).toBe(3);
    expect(m.follow_angle).toBeCloseTo(Math.PI / 2, 5);
    expect(m.groupAI).toBe(FOLLOW | ASSIST);
    expect([m.point_1, m.point_2]).toEqual([4, 5]);
    expect(map.get(11)!.follow_angle).toBeCloseTo(Math.PI, 5);
    // the leader's own row: no follow values
    const leader = map.get(10)!;
    expect([leader.follow_dist, leader.follow_angle, leader.groupAI]).toEqual([0, 0, ASSIST]);
    expect(sFormationMgr().CreatureGroupMembers.get(10)).toEqual([11, 10]); // `ORDER BY leaderGUID` keeps the row order inside a leader
    expect(sFormationMgr().CreatureGroupMembers.get(20)).toEqual([21]);
  });

  test("an empty table loads nothing", () => {
    load([], []);
    expect(sFormationMgr().CreatureGroupMap.size).toBe(0);
  });

  test("a member with an unsupported group AI flag is skipped (the leader may have no flags)", () => {
    load([row(10, 10), row(10, 11, { groupAI: 0x40 }), row(10, 12, { groupAI: FOLLOW | 0x40 }), row(10, 13, { groupAI: 0 })], [10, 11, 12, 13]);
    const map = sFormationMgr().CreatureGroupMap;
    expect(map.has(10)).toBe(true); // the leader with 0 flags is allowed
    expect(map.has(11)).toBe(false);
    expect(map.has(12)).toBe(true); // the supported bit is there
    expect(map.has(13)).toBe(false); // a member needs a supported flag
    load([row(10, 10, { groupAI: 0x40 })], [10]);
    expect(sFormationMgr().CreatureGroupMap.size).toBe(0); // a leader with only an unsupported flag
  });

  test("distance and angle without the follow flag are dropped for a member and for a leader", () => {
    load([row(10, 11, { dist: 2, angle: 30, groupAI: ASSIST }), row(10, 10, { dist: 5, angle: 5, groupAI: ASSIST })], [10, 11]);
    const map = sFormationMgr().CreatureGroupMap;
    expect([map.get(11)!.follow_dist, map.get(11)!.follow_angle]).toEqual([0, 0]);
    expect([map.get(10)!.follow_dist, map.get(10)!.follow_angle]).toEqual([0, 0]);
  });

  test("rows whose leader or member spawn does not exist are skipped", () => {
    load([row(10, 11, { groupAI: FOLLOW }), row(10, 99, { groupAI: FOLLOW }), row(98, 12, { groupAI: FOLLOW })], [10, 11, 12]);
    expect([...sFormationMgr().CreatureGroupMap.keys()]).toEqual([11]);
  });

  test("a second load replaces the first", () => {
    load([row(10, 11, { groupAI: FOLLOW })], [10, 11]);
    load([row(20, 21, { groupAI: FOLLOW })], [20, 21]);
    expect([...sFormationMgr().CreatureGroupMap.keys()]).toEqual([21]);
  });
});

function squad(opts: { flags?: number; leaderFlags?: number } = {}) {
  const flags = opts.flags ?? FOLLOW | ASSIST;
  const map = new FakeMap();
  // the leader's row has the follow flag too (the usual `groupAI` of the data is 515): `FormationReset` reads the first member's flags
  const rows = [row(10, 10, { groupAI: opts.leaderFlags ?? FOLLOW | ASSIST }), row(10, 11, { dist: 3, angle: 90, groupAI: flags }), row(10, 12, { dist: 3, angle: 270, groupAI: flags })];
  load(rows, [10, 11, 12]);
  const leader = new FakeUnit({ pos: [100, 100, 0], spawnId: 10, map });
  const a = new FakeUnit({ pos: [103, 100, 0], spawnId: 11, map });
  const b = new FakeUnit({ pos: [97, 100, 0], spawnId: 12, map });
  for (const u of [leader, a, b]) {
    u.motionMaster.initialize();
    SearchFormation(u.asCreature());
  }
  return { map, leader, a, b };
}

describe("CreatureGroup membership", () => {
  test("SearchFormation puts a creature with a formation row into its leader's group (the group is created once per map)", () => {
    const { map, leader, a, b } = squad();
    const group = leader.getFormation()!;
    expect(group).toBeInstanceOf(CreatureGroup);
    expect(a.getFormation()).toBe(group);
    expect(b.getFormation()).toBe(group);
    expect(map.CreatureGroupHolder.get(10)).toBe(group);
    expect(group.getId()).toBe(10);
    expect(group.getLeader()).toBe(leader.asCreature());
    expect(group.getMembers().size).toBe(3);
    expect(group.isEmpty()).toBe(false);
    expect(group.getMembers().get(a.asCreature())!.follow_dist).toBe(3);
    expect(IsFormationLeader(leader.asCreature())).toBe(true);
    expect(IsFormationLeader(a.asCreature())).toBe(false);
  });

  test("a summon or a creature without a spawn id or a row is not put into a group", () => {
    load([row(10, 11, { groupAI: FOLLOW })], [10, 11]);
    const map = new FakeMap();
    const summon = new FakeUnit({ spawnId: 11, map });
    summon.isSummon = () => true;
    SearchFormation(summon.asCreature());
    expect(summon.getFormation()).toBeNull();
    const none = new FakeUnit({ spawnId: 0, map });
    SearchFormation(none.asCreature());
    expect(none.getFormation()).toBeNull();
    const other = new FakeUnit({ spawnId: 55, map });
    SearchFormation(other.asCreature());
    expect(other.getFormation()).toBeNull();
    expect(map.CreatureGroupHolder.size).toBe(0);
  });

  test("removing members: the leader leaving dismisses the formation movement; the last member deletes the group", () => {
    const { map, leader, a, b } = squad();
    const group = leader.getFormation()!;
    a.motionMaster.moveFormation(leader.asOwner(), 3, 1, 0, 0);
    b.motionMaster.moveFormation(leader.asOwner(), 3, 1, 0, 0);
    // b also has something in the active slot, so the stack is deeper than one generator
    b.motionMaster.movePoint(1, 97, 101, 0);
    expect(a.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(FORMATION_MOTION_TYPE);
    sFormationMgr().removeCreatureFromGroup(group, leader.asCreature());
    expect(group.getLeader()).toBeNull();
    expect(leader.getFormation()).toBeNull();
    // `RemoveFormationMovement`: `MovementExpiredOnSlot(IDLE)` needs more than one generator on the stack (`size() > 1`)
    expect(a.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(FORMATION_MOTION_TYPE);
    expect(b.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(NULL_MOTION_TYPE); // the slot is empty, not reset to the default
    expect(map.CreatureGroupHolder.has(10)).toBe(true);
    sFormationMgr().removeCreatureFromGroup(group, a.asCreature());
    sFormationMgr().removeCreatureFromGroup(group, b.asCreature());
    expect(group.isEmpty()).toBe(true);
    expect(map.CreatureGroupHolder.has(10)).toBe(false);
  });

  test("a creature that is not on a map cannot be added", () => {
    load([row(10, 11, { groupAI: FOLLOW })], [10, 11]);
    const u = new FakeUnit({ spawnId: 11 });
    u.findMap = () => null;
    sFormationMgr().addCreatureToGroup(10, u.asCreature());
    expect(u.getFormation()).toBeNull();
  });
});

describe("CreatureGroup behavior", () => {
  test("the leader starting to move sends the followers after it (formation generators in the idle slot)", () => {
    const { leader, a, b } = squad();
    leader.getFormation()!.leaderStartedMoving();
    expect(a.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(FORMATION_MOTION_TYPE);
    expect(b.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(FORMATION_MOTION_TYPE);
    expect(leader.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(IDLE_MOTION_TYPE);
  });

  test("a member that is dead, fighting, immobilized or already following is left alone", () => {
    const { leader, a, b } = squad();
    a.alive = false;
    b.addUnitState(UNIT_STATE_FOLLOW_MOVE);
    leader.getFormation()!.leaderStartedMoving();
    expect(a.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(IDLE_MOTION_TYPE);
    expect(b.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(IDLE_MOTION_TYPE);
    b.clearUnitState(UNIT_STATE_FOLLOW_MOVE);
    b.victim = leader;
    leader.getFormation()!.leaderStartedMoving();
    expect(b.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(IDLE_MOTION_TYPE);
  });

  test("members without the follow flag do not follow", () => {
    const { leader, a } = squad({ flags: ASSIST });
    leader.getFormation()!.leaderStartedMoving();
    expect(a.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(IDLE_MOTION_TYPE);
  });

  test("the leader may only start moving when no member is engaged or evading", () => {
    const { leader, a } = squad();
    const group = leader.getFormation()!;
    expect(group.canLeaderStartMoving()).toBe(true);
    expect(IsFormationLeaderMoveAllowed(leader.asCreature())).toBe(true);
    a.engaged = true;
    expect(group.canLeaderStartMoving()).toBe(false);
    expect(IsFormationLeaderMoveAllowed(leader.asCreature())).toBe(false);
    a.alive = false; // a dead member does not count
    expect(group.canLeaderStartMoving()).toBe(true);
    expect(IsFormationLeaderMoveAllowed(new FakeUnit().asCreature())).toBe(true); // no formation
  });

  test("SignalFormationMovement only does something for the leader", () => {
    const { leader, a } = squad();
    SignalFormationMovement(a.asCreature());
    expect(a.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(IDLE_MOTION_TYPE);
    expect(leader.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(IDLE_MOTION_TYPE);
    SignalFormationMovement(leader.asCreature());
    expect(a.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(FORMATION_MOTION_TYPE);
    SignalFormationMovement(new FakeUnit().asCreature()); // no formation
  });

  test("assist: a member that starts a fight pulls in the others (and the leader only with the right flags)", () => {
    const { leader, a, b } = squad();
    const enemy = new FakeUnit({ pos: [110, 100, 0], player: true });
    leader.getFormation()!.memberEngagingTarget(a.asCreature(), enemy.asOwner());
    expect(b.victim).toBe(enemy);
    expect(leader.victim).toBe(enemy); // LEADER_ASSIST_MEMBER is set for a
    expect(a.victim).toBeNull();

    const { leader: l2, a: a2, b: b2 } = squad({ flags: GroupAIFlags.GROUP_AI_FLAG_MEMBER_ASSIST_LEADER });
    l2.getFormation()!.memberEngagingTarget(a2.asCreature(), enemy.asOwner());
    expect(b2.victim).toBeNull(); // a member without LEADER_ASSIST_MEMBER does not pull
    // the leader fights: members with the member-assist-leader flag follow
    l2.getFormation()!.memberEngagingTarget(l2.asCreature(), enemy.asOwner());
    expect(a2.victim).toBe(enemy);
    expect(b2.victim).toBe(enemy);
  });

  test("a member that lost its fight takes its comrades' target (with ACQUIRE_NEW_TARGET_ON_EVADE)", () => {
    const { leader, a, b } = squad({ flags: ASSIST | GroupAIFlags.GROUP_AI_FLAG_ACQUIRE_NEW_TARGET_ON_EVADE });
    const enemy = new FakeUnit({ pos: [110, 100, 0], player: true });
    b.victim = enemy;
    const group = leader.getFormation()!;
    expect(group.getNewTargetForMember(a.asCreature())).toBe(enemy.asOwner());
    expect(group.getNewTargetForMember(b.asCreature())).toBeNull(); // nobody else fights
    const noFlag = squad({ flags: ASSIST });
    noFlag.b.victim = enemy;
    expect(noFlag.leader.getFormation()!.getNewTargetForMember(noFlag.a.asCreature())).toBeNull();
  });

  test("evade: the others evade and dead ones respawn, depending on the flags", () => {
    const flags = GroupAIFlags.GROUP_AI_FLAG_EVADE_TOGETHER | GroupAIFlags.GROUP_AI_FLAG_RESPAWN_ON_EVADE;
    const { leader, a, b } = squad({ flags, leaderFlags: flags });
    const group = leader.getFormation()!;
    a.inCombat = true;
    b.alive = false;
    group.memberEvaded(leader.asCreature());
    expect(a.recordingAI!.calls).toContain("EnterEvadeMode()");
    expect(b.log).toContain("respawn");
    expect(b.alive).toBe(true);
  });

  test("evade: members without an evade flag are not touched; the leader is not respawned with DONT_RESPAWN_LEADER_ON_EVADE", () => {
    const { leader, a } = squad({ flags: FOLLOW, leaderFlags: FOLLOW });
    leader.getFormation()!.memberEvaded(a.asCreature());
    expect(leader.recordingAI!.calls).toEqual([]);

    load([row(10, 10, { groupAI: GroupAIFlags.GROUP_AI_FLAG_RESPAWN_ON_EVADE | GroupAIFlags.GROUP_AI_FLAG_DONT_RESPAWN_LEADER_ON_EVADE }), row(10, 11, { groupAI: GroupAIFlags.GROUP_AI_FLAG_RESPAWN_ON_EVADE })], [10, 11]);
    const map = new FakeMap();
    const l = new FakeUnit({ spawnId: 10, map });
    const m = new FakeUnit({ spawnId: 11, map });
    SearchFormation(l.asCreature());
    SearchFormation(m.asCreature());
    l.alive = false;
    l.getFormation()!.memberEvaded(m.asCreature());
    expect(l.log).not.toContain("respawn");
  });

  test("evade respawns members that left the world: their pending respawn time is moved to now", () => {
    const flags = GroupAIFlags.GROUP_AI_FLAG_RESPAWN_ON_EVADE;
    const { map, leader, a, b } = squad({ flags, leaderFlags: flags });
    // b is out of the world (waiting for its respawn), a has no stored respawn time
    sFormationMgr().removeCreatureFromGroup(leader.getFormation()!, b.asCreature());
    const now = getGameTime();
    map.respawnTimes.set(12, now + 600);
    leader.getFormation()!.memberEvaded(a.asCreature());
    expect(map.getCreatureRespawnTime(12)).toBe(now);
    // a member whose respawn is already due is left to the respawn processing
    map.respawnTimes.set(12, now - 5);
    leader.getFormation()!.respawnRemovedMembers(map);
    expect(map.getCreatureRespawnTime(12)).toBe(now - 5);
  });

  test("formation reset: followers go idle (formed) or back to their default movement (dismissed)", () => {
    const { leader, a } = squad();
    const group = leader.getFormation()!;
    expect(group.isFormed()).toBe(false);
    group.formationReset(false, true);
    expect(group.isFormed()).toBe(true);
    a.motionMaster.moveFormation(leader.asOwner(), 3, 1, 0, 0);
    a.motionMaster.movePoint(1, 103, 101, 0); // a deeper stack, so the idle slot can be expired
    group.formationReset(true, true);
    expect(group.isFormed()).toBe(false);
    expect(a.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(NULL_MOTION_TYPE); // `MovementExpiredOnSlot(IDLE)`
    group.formationReset(false, false); // no motion master init
    expect(group.isFormed()).toBe(true);
  });

  test("formation reset does nothing for a group without the follow flag", () => {
    const { leader } = squad({ flags: ASSIST, leaderFlags: ASSIST });
    leader.getFormation()!.formationReset(false, true);
    expect(leader.getFormation()!.isFormed()).toBe(false);
  });

  test("despawn, respawn and the combat and alive queries", () => {
    const { leader, a, b } = squad();
    const group = leader.getFormation()!;
    group.despawnFormation(1000, 5);
    expect(a.log).toContain("despawnOrUnsummon");
    expect(leader.log).toContain("despawnOrUnsummon");
    a.alive = false;
    b.alive = false;
    group.respawnFormation();
    expect(a.log).toContain("respawn");
    expect(leader.log).not.toContain("respawn"); // alive
    expect(group.isFormationInCombat()).toBe(false);
    a.inCombat = true;
    expect(group.isFormationInCombat()).toBe(true);
    expect(group.isAnyMemberAlive()).toBe(true);
    leader.alive = false;
    a.alive = false;
    b.alive = false;
    expect(group.isAnyMemberAlive()).toBe(false);
    b.alive = true;
    expect(group.isAnyMemberAlive(true)).toBe(true);
    b.alive = false;
    leader.alive = true;
    expect(group.isAnyMemberAlive(true)).toBe(false); // only the leader is left
  });

  test("Motion_Initialize: a plain creature, the leader, a follower of a formed group, and a follower of a moving leader", () => {
    const { leader, a } = squad();
    const plain = new FakeUnit();
    Motion_Initialize(plain.asCreature());
    expect(plain.motionMaster.size()).toBe(1);

    const group = leader.getFormation()!;
    Motion_Initialize(leader.asCreature());
    expect(group.isFormed()).toBe(true); // `FormationReset(false, true)`
    Motion_Initialize(a.asCreature());
    expect(a.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(IDLE_MOTION_TYPE); // waits for the leader's order

    // a leader that is already moving: the follower follows at once
    leader.motionMaster.movePoint(1, 130, 100, 0);
    expect(leader.movespline.finalized()).toBe(false);
    Motion_Initialize(a.asCreature());
    expect(a.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(FORMATION_MOTION_TYPE);

    // a group that is not formed: the default movement
    const other = squad();
    Motion_Initialize(other.a.asCreature());
    expect(other.a.motionMaster.size()).toBe(1);
  });

  test("the leader on a waypoint path signals the formation when it starts a move", () => {
    const { leader, a } = squad();
    const gen = new WaypointMovementGenerator(new WaypointPath(3, [new WaypointNode(1, 130, 100, 0)]), false);
    (leader.motionMaster as unknown as { mutate(m: unknown, slot: number): void }).mutate(gen, MOTION_SLOT_IDLE);
    expect(leader.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(WAYPOINT_MOTION_TYPE);
    leader.advance(100);
    expect(a.motionMaster.getMotionSlotType(MOTION_SLOT_IDLE)).toBe(FORMATION_MOTION_TYPE);
  });

  test("a leader waits while a member is in combat (the move is retried after a second)", () => {
    const { leader, a } = squad();
    a.engaged = true;
    const gen = new WaypointMovementGenerator(new WaypointPath(3, [new WaypointNode(1, 130, 100, 0)]), false);
    (leader.motionMaster as unknown as { mutate(m: unknown, slot: number): void }).mutate(gen, MOTION_SLOT_IDLE);
    leader.run(900);
    expect(leader.movespline.finalized()).toBe(true);
    a.engaged = false;
    leader.run(1500);
    expect(leader.movespline.finalized()).toBe(false);
  });

  test("FormationInfo", () => {
    const info = new FormationInfo();
    expect([info.leaderGUID, info.follow_dist, info.follow_angle, info.groupAI, info.point_1, info.point_2]).toEqual([0, 0, 0, 0, 0, 0]);
    info.groupAI = FOLLOW;
    expect(info.hasGroupFlag(FOLLOW)).toBe(true);
    expect(info.hasGroupFlag(GroupAIFlags.GROUP_AI_FLAG_EVADE_TOGETHER)).toBe(false);
    const copy = info.clone();
    copy.groupAI = 0;
    expect(info.groupAI).toBe(FOLLOW);
    expect(GroupAIFlags.GROUP_AI_FLAG_SUPPORTED).toBe(0x001 | 0x002 | 0x004 | 0x008 | 0x010 | 0x020 | 0x200);
    expect(F(1)).toBe(1);
  });
});
