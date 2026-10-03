/**
 * Port of `game/Entities/Creature/CreatureGroups.{h,cpp}`: `creature_formations` (`FormationMgr`), and `CreatureGroup`, the
 * group of creatures that follow a leader (`FormationMovementGenerator`), assist each other and evade or respawn together.
 *
 * The members are creatures that satisfy `MovementOwnerCreature` (the real `Creature` once it implements it); the
 * `Map` is the structural `CreatureGroupsMap`, which the real `Map` satisfies (its `CreatureGroupHolder` is typed
 * `Map<number, unknown>` there, and holds `CreatureGroup`s).
 */
import { getTableName } from "drizzle-orm";
import { creature_formations } from "../../../database/schema/world.ts";
import type { WorldTables } from "../../../database/world-tables.ts";
import { logDebug, logError, log } from "../../../log.ts";
import { UNIT_FLAG_PLAYER_CONTROLLED, UNIT_STATE_FOLLOW_MOVE, UNIT_STATE_NOT_MOVE } from "../../../spells/enums.ts";
import { getMSTime, getMSTimeDiffToNow } from "../../time/timer.ts";
import { getGameTime } from "../../time/game-time.ts";
import { FORMATION_MOTION_TYPE, MOTION_SLOT_IDLE } from "../../Movement/MotionMaster.ts";
import type { MovementOwner, MovementOwnerCreature } from "../../Movement/MovementOwner.ts";

const F = Math.fround;

/** @ac game/Entities/Creature/CreatureGroups.h GroupAIFlags */
export const GroupAIFlags = {
  GROUP_AI_FLAG_MEMBER_ASSIST_LEADER: 0x001,
  GROUP_AI_FLAG_LEADER_ASSIST_MEMBER: 0x002,
  GROUP_AI_FLAG_EVADE_TOGETHER: 0x004,
  GROUP_AI_FLAG_RESPAWN_ON_EVADE: 0x008,
  GROUP_AI_FLAG_DONT_RESPAWN_LEADER_ON_EVADE: 0x010,
  GROUP_AI_FLAG_ACQUIRE_NEW_TARGET_ON_EVADE: 0x020,
  //GROUP_AI_FLAG_UNK5                        = 0x040,
  //GROUP_AI_FLAG_UNK6                        = 0x080,
  //GROUP_AI_FLAG_UNK7                        = 0x100,
  GROUP_AI_FLAG_FOLLOW_LEADER: 0x200,

  GROUP_AI_FLAG_ASSIST_MASK: 0x001 | 0x002,
  GROUP_AI_FLAG_EVADE_MASK: 0x004 | 0x008,

  // Used to verify valid and usable flags
  GROUP_AI_FLAG_SUPPORTED: 0x001 | 0x002 | 0x004 | 0x008 | 0x010 | 0x200 | 0x020,
} as const;
export type GroupAIFlags = (typeof GroupAIFlags)[keyof typeof GroupAIFlags];

/** @ac game/Entities/Creature/CreatureGroups.h FormationInfo */
export class FormationInfo {
  leaderGUID = 0; // ObjectGuid::LowType
  follow_dist = 0.0;
  follow_angle = 0.0;
  groupAI = 0;
  point_1 = 0;
  point_2 = 0;

  /** @ac game/Entities/Creature/CreatureGroups.h FormationInfo::HasGroupFlag */
  hasGroupFlag(flag: number): boolean {
    return (this.groupAI & flag) !== 0;
  }

  /** The copy the C++ makes when it stores a `FormationInfo` by value. */
  clone(): FormationInfo {
    return Object.assign(new FormationInfo(), this);
  }
}

/** @ac game/Entities/Creature/CreatureGroups.h CreatureGroupInfoType (`memberDBGUID` to `FormationInfo`) */
export type CreatureGroupInfoType = Map<number, FormationInfo>;
/** @ac game/Entities/Creature/CreatureGroups.h CreatureGroupMembersType (`leaderDBGUID` to `memberDBGUIDs`) */
export type CreatureGroupMembersType = Map<number, number[]>;

/** The `Map` members `CreatureGroups` calls. @ac game/Maps/Map.h Map */
export interface CreatureGroupsMap {
  /** @ac game/Maps/Map.h Map::CreatureGroupHolder (`std::map<uint32 leaderDBGUID, CreatureGroup*>`) */
  readonly CreatureGroupHolder: Map<number, unknown>;
  /** @ac game/Maps/Map.h Map::GetCreatureRespawnTime */
  getCreatureRespawnTime(dbGuid: number): number;
  /** @ac game/Maps/Map.cpp Map::SaveCreatureRespawnTime */
  saveCreatureRespawnTime(spawnId: number, respawnTime: number): number;
}

/** @ac game/Entities/Creature/CreatureGroups.h FormationMgr */
export class FormationMgr {
  /** @ac game/Entities/Creature/CreatureGroups.h FormationMgr::CreatureGroupMap */
  CreatureGroupMap: CreatureGroupInfoType = new Map();
  /** @ac game/Entities/Creature/CreatureGroups.h FormationMgr::CreatureGroupMembers */
  CreatureGroupMembers: CreatureGroupMembersType = new Map();

  private static _instance: FormationMgr | null = null;

  /** @ac game/Entities/Creature/CreatureGroups.cpp FormationMgr::instance */
  static instance(): FormationMgr {
    return (FormationMgr._instance ??= new FormationMgr());
  }

  /** @ac game/Entities/Creature/CreatureGroups.cpp FormationMgr::AddCreatureToGroup */
  addCreatureToGroup(groupId: number, member: MovementOwnerCreature): void {
    const map = member.findMap() as CreatureGroupsMap | null;
    if (!map) {
      return;
    }

    const existing = map.CreatureGroupHolder.get(groupId) as CreatureGroup | undefined;

    //Add member to an existing group
    if (existing) {
      logDebug("movement", () => `Group found: ${groupId}, inserting creature ${member.getGUID()}, Group InstanceID ${member.getInstanceId()}`);
      existing.addMember(member);
    }
    //Create new group
    else {
      logDebug("movement", () => `Group not found: ${groupId}. Creating new group.`);
      const group = new CreatureGroup(groupId);
      map.CreatureGroupHolder.set(groupId, group);
      group.addMember(member);
    }
  }

  /** @ac game/Entities/Creature/CreatureGroups.cpp FormationMgr::RemoveCreatureFromGroup */
  removeCreatureFromGroup(group: CreatureGroup, member: MovementOwnerCreature): void {
    logDebug("movement", () => `Deleting member pointer to spawnId: ${member.getSpawnId()} from group ${group.getId()}`);
    group.removeMember(member);

    if (group.isEmpty()) {
      const map = member.findMap() as CreatureGroupsMap | null;
      if (!map) {
        return;
      }

      logDebug("movement", () => `Deleting group with InstanceID ${member.getInstanceId()}`);
      map.CreatureGroupHolder.delete(group.getId());
    }
  }

  /**
   * Reads `creature_formations` (a `WorldTables` table) into `CreatureGroupMap` and `CreatureGroupMembers`.
   * `creatureDataExists` is `sObjectMgr->GetCreatureData(guid)` (null result: false).
   *
   * @ac game/Entities/Creature/CreatureGroups.cpp FormationMgr::LoadCreatureFormations
   */
  loadCreatureFormations(tables: WorldTables, creatureDataExists: (spawnId: number) => boolean): void {
    const oldMSTime = getMSTime();
    this.CreatureGroupMap.clear();
    this.CreatureGroupMembers.clear();

    //Get group data
    // SELECT leaderGUID, memberGUID, dist, angle, groupAI, point_1, point_2 FROM creature_formations ORDER BY leaderGUID
    const result = [...tables.all(creature_formations)].sort((a, b) => a.leaderGUID - b.leaderGUID);
    if (result.length === 0) {
      logWarnLoading(`>> Loaded 0 creatures in formations. DB table \`${getTableName(creature_formations)}\` is empty!`);
      return;
    }

    let count = 0;
    for (const fields of result) {
      //Load group member data
      const group_member = new FormationInfo();
      group_member.leaderGUID = fields.leaderGUID >>> 0;
      const memberGUID = fields.memberGUID >>> 0;
      const follow_dist = F(fields.dist);
      const follow_angle = F(F(fields.angle) * F(F(Math.PI) / 180));
      group_member.groupAI = fields.groupAI & 0xffff;
      group_member.point_1 = fields.point_1 & 0xffff;
      group_member.point_2 = fields.point_2 & 0xffff;

      //If creature is group leader we may skip loading of dist/angle
      if (group_member.leaderGUID !== memberGUID) {
        if (!group_member.hasGroupFlag(GroupAIFlags.GROUP_AI_FLAG_SUPPORTED)) {
          logError("sql", `creature_formations table leader guid ${group_member.leaderGUID} and member guid ${memberGUID} has unsupported GroupAI flag value (${group_member.groupAI}). Skipped`);
          continue;
        }

        if (!group_member.hasGroupFlag(GroupAIFlags.GROUP_AI_FLAG_FOLLOW_LEADER) && (follow_dist > 0.0 || follow_angle > 0.0)) {
          logError(
            "sql",
            `creature_formations table member guid ${memberGUID} and leader guid ${group_member.leaderGUID} cannot have follow distance or follow angle because don't have GROUP_AI_FLAG_FOLLOW_LEADER flag. Values are not gonna be used`,
          );
          group_member.follow_dist = 0.0;
          group_member.follow_angle = 0.0;
        } else {
          group_member.follow_dist = follow_dist;
          group_member.follow_angle = follow_angle;
        }
      } else {
        // Leader can have 0 AI flags - its allowed
        if (group_member.groupAI && !group_member.hasGroupFlag(GroupAIFlags.GROUP_AI_FLAG_SUPPORTED)) {
          logError("sql", `creature_formations table leader guid ${group_member.leaderGUID} and member guid ${memberGUID} has unsupported GroupAI flag value (${group_member.groupAI}). Skipped`);
          continue;
        }

        group_member.follow_dist = 0.0;
        group_member.follow_angle = 0.0;
        if (follow_dist > 0.0 || follow_angle > 0.0) {
          logError("sql", `creature_formations table member guid ${memberGUID} and leader guid ${group_member.leaderGUID} cannot have follow distance or follow angle. Values are not gonna be used`);
        }
      }

      if (!creatureDataExists(group_member.leaderGUID)) {
        logError("sql", `creature_formations table leader guid ${group_member.leaderGUID} incorrect (does not exist). Skipped`);
        continue;
      }

      if (!creatureDataExists(memberGUID)) {
        logError("sql", `creature_formations table member guid ${memberGUID} incorrect (does not exist). Skipped`);
        continue;
      }

      this.CreatureGroupMap.set(memberGUID, group_member);
      const members = this.CreatureGroupMembers.get(group_member.leaderGUID);
      if (members) members.push(memberGUID);
      else this.CreatureGroupMembers.set(group_member.leaderGUID, [memberGUID]);
      ++count;
    }

    log("server", `>> Loaded ${count} Creatures In Formations in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** `CreatureGroupMap[spawnId]` of `std::unordered_map::operator[]`: a missing member inserts a default `FormationInfo`. */
  groupInfoOf(spawnId: number): FormationInfo {
    let info = this.CreatureGroupMap.get(spawnId);
    if (!info) {
      info = new FormationInfo();
      this.CreatureGroupMap.set(spawnId, info);
    }
    return info;
  }
}

/** `LOG_WARN("server.loading", ...)` */
function logWarnLoading(message: string): void {
  log("server", message);
}

/** @ac game/Entities/Creature/CreatureGroups.h sFormationMgr */
export function sFormationMgr(): FormationMgr {
  return FormationMgr.instance();
}

/** @ac game/Entities/Creature/CreatureGroups.h CreatureGroup */
export class CreatureGroup {
  /** @ac game/Entities/Creature/CreatureGroups.h CreatureGroup::CreatureGroupMemberType (`std::map<Creature*, FormationInfo>`) */
  private m_leader: MovementOwnerCreature | null = null; //Important do not forget sometimes to work with pointers instead synonims :D:D
  private m_members = new Map<MovementOwnerCreature, FormationInfo>();

  private m_groupID: number;
  private m_Formed = false;

  //Group cannot be created empty
  /** @ac game/Entities/Creature/CreatureGroups.h CreatureGroup::CreatureGroup */
  constructor(id: number) {
    this.m_groupID = id;
  }

  /** @ac game/Entities/Creature/CreatureGroups.h CreatureGroup::GetLeader */
  getLeader(): MovementOwnerCreature | null {
    return this.m_leader;
  }

  /** @ac game/Entities/Creature/CreatureGroups.h CreatureGroup::GetId */
  getId(): number {
    return this.m_groupID;
  }

  /** @ac game/Entities/Creature/CreatureGroups.h CreatureGroup::IsEmpty */
  isEmpty(): boolean {
    return this.m_members.size === 0;
  }

  /** @ac game/Entities/Creature/CreatureGroups.h CreatureGroup::IsFormed */
  isFormed(): boolean {
    return this.m_Formed;
  }

  /** @ac game/Entities/Creature/CreatureGroups.h CreatureGroup::GetMembers */
  getMembers(): ReadonlyMap<MovementOwnerCreature, FormationInfo> {
    return this.m_members;
  }

  /** @ac game/Entities/Creature/CreatureGroups.cpp CreatureGroup::AddMember */
  addMember(member: MovementOwnerCreature): void {
    logDebug("movement", () => `CreatureGroup::AddMember: Adding unit ${member.getGUID()}.`);

    //Check if it is a leader
    if (member.getSpawnId() === this.m_groupID) {
      logDebug("movement", () => `Unit ${member.getGUID()} is formation leader. Adding group.`);
      this.m_leader = member;
    }

    const info = sFormationMgr().CreatureGroupMap.get(member.getSpawnId());
    if (!info) throw new Error(`CreatureGroup::AddMember: spawn id ${member.getSpawnId()} is not in creature_formations`);
    this.m_members.set(member, info.clone());
    member.setFormation(this);
  }

  /** @ac game/Entities/Creature/CreatureGroups.cpp CreatureGroup::RemoveMember */
  removeMember(member: MovementOwnerCreature): void {
    if (this.m_leader === member) {
      this.removeFormationMovement();
      this.m_leader = null;
    }

    this.m_members.delete(member);
    member.setFormation(null);
  }

  /** @ac game/Entities/Creature/CreatureGroups.cpp CreatureGroup::MemberEngagingTarget */
  memberEngagingTarget(member: MovementOwnerCreature, target: MovementOwner): void {
    const groupAI = sFormationMgr().groupInfoOf(member.getSpawnId()).groupAI & 0xff;
    if (member === this.m_leader) {
      if (!(groupAI & GroupAIFlags.GROUP_AI_FLAG_MEMBER_ASSIST_LEADER)) {
        return;
      }
    } else if (!(groupAI & GroupAIFlags.GROUP_AI_FLAG_LEADER_ASSIST_MEMBER)) {
      return;
    }

    for (const pMember of this.m_members.keys()) {
      if (!pMember) {
        continue;
      }

      if (pMember === member || !pMember.isAlive() || pMember.getVictim()) {
        continue;
      }

      if (pMember === this.m_leader && !(groupAI & GroupAIFlags.GROUP_AI_FLAG_LEADER_ASSIST_MEMBER)) {
        continue;
      }

      if (pMember.isValidAttackTarget(target)) {
        pMember.engageWithTarget(target);
      }
    }
  }

  /** @ac game/Entities/Creature/CreatureGroups.cpp CreatureGroup::GetNewTargetForMember */
  getNewTargetForMember(member: MovementOwnerCreature): MovementOwner | null {
    const groupAI = sFormationMgr().groupInfoOf(member.getSpawnId()).groupAI & 0xff;
    if (!(groupAI & GroupAIFlags.GROUP_AI_FLAG_ACQUIRE_NEW_TARGET_ON_EVADE)) {
      return null;
    }

    if (member === this.m_leader) {
      if (!(groupAI & GroupAIFlags.GROUP_AI_FLAG_MEMBER_ASSIST_LEADER)) {
        return null;
      }
    } else if (!(groupAI & GroupAIFlags.GROUP_AI_FLAG_LEADER_ASSIST_MEMBER)) {
      return null;
    }

    for (const pMember of this.m_members.keys()) {
      if (!pMember) {
        continue;
      }

      if (pMember === member || !pMember.isAlive() || !pMember.getVictim()) {
        continue;
      }

      if (pMember === this.m_leader && !(groupAI & GroupAIFlags.GROUP_AI_FLAG_MEMBER_ASSIST_LEADER)) {
        continue;
      }

      if (member.isValidAttackTarget(pMember.getVictim()!)) {
        return pMember.getVictim();
      }
    }

    return null;
  }

  /** @ac game/Entities/Creature/CreatureGroups.cpp CreatureGroup::MemberEvaded */
  memberEvaded(member: MovementOwnerCreature): void {
    const groupAI = sFormationMgr().groupInfoOf(member.getSpawnId()).groupAI & 0xff;
    if (!(groupAI & GroupAIFlags.GROUP_AI_FLAG_EVADE_MASK)) {
      return;
    }

    // Copy the member list first: Respawn() below takes the member out of the
    // world, which erases it from m_members and would invalidate this loop.
    const members = new Map(this.m_members);

    for (const [pMember, info] of members) {
      // This should never happen
      if (!pMember) continue;

      // A previous member's Respawn() or EnterEvadeMode() may have removed
      // this one from the group already.
      if (pMember.getFormation() !== this) continue;

      if (pMember === member || pMember.isInEvadeMode() || !info.hasGroupFlag(GroupAIFlags.GROUP_AI_FLAG_EVADE_MASK)) continue;

      // EVADE_TOGETHER and RESPAWN_ON_EVADE are independent: living members evade, dead members respawn.
      if (pMember.isAlive()) {
        if (!info.hasGroupFlag(GroupAIFlags.GROUP_AI_FLAG_EVADE_TOGETHER)) continue;

        if (!pMember.isInCombat()) continue;

        if (pMember.IsAIEnabled) {
          const pMemberAI = pMember.ai();
          if (pMemberAI) pMemberAI.EnterEvadeMode?.();
        }
      } else {
        if (!info.hasGroupFlag(GroupAIFlags.GROUP_AI_FLAG_RESPAWN_ON_EVADE)) continue;

        if (info.hasGroupFlag(GroupAIFlags.GROUP_AI_FLAG_DONT_RESPAWN_LEADER_ON_EVADE) && pMember === this.m_leader) continue;

        pMember.respawn();
      }
    }

    this.respawnRemovedMembers(member.getMap() as unknown as CreatureGroupsMap);
  }

  // In dynamic respawn mode a creature is removed from the world once its corpse decays, and RemoveFromWorld drops it
  // from this group, so members waiting in the map's respawn store are no longer in m_members. Move their stored
  // respawn time to now: ProcessRespawns() recreates them on its next check and they rejoin the group when loaded.
  /** @ac game/Entities/Creature/CreatureGroups.cpp CreatureGroup::RespawnRemovedMembers */
  respawnRemovedMembers(map: CreatureGroupsMap): void {
    const membersList = sFormationMgr().CreatureGroupMembers.get(this.m_groupID);
    if (membersList === undefined) return;

    const now = getGameTime();
    for (const spawnId of membersList) {
      let inWorld = false;
      for (const member of this.m_members.keys()) {
        if (member.getSpawnId() === spawnId) {
          inWorld = true;
          break;
        }
      }
      if (inWorld) continue;

      const info = sFormationMgr().CreatureGroupMap.get(spawnId);
      if (info === undefined) continue;

      if (!info.hasGroupFlag(GroupAIFlags.GROUP_AI_FLAG_RESPAWN_ON_EVADE)) continue;

      if (spawnId === this.m_groupID && info.hasGroupFlag(GroupAIFlags.GROUP_AI_FLAG_DONT_RESPAWN_LEADER_ON_EVADE)) continue;

      // Only creatures with a respawn still pending on this map: one without a stored time (alive, never loaded)
      // is left alone, one already due (evade cascade of the same tick) is left to ProcessRespawns().
      if (map.getCreatureRespawnTime(spawnId) <= now) continue;

      map.saveCreatureRespawnTime(spawnId, now);
    }
  }

  /** @ac game/Entities/Creature/CreatureGroups.cpp CreatureGroup::FormationReset */
  formationReset(dismiss: boolean, initMotionMaster: boolean): void {
    const first = this.m_members.values().next();
    if (this.m_members.size && !first.done && !first.value.hasGroupFlag(GroupAIFlags.GROUP_AI_FLAG_FOLLOW_LEADER)) return;

    for (const member of this.m_members.keys()) {
      if (member && member !== this.m_leader && member.isAlive()) {
        if (initMotionMaster) {
          if (dismiss) member.getMotionMaster().movementExpiredOnSlot(MOTION_SLOT_IDLE, false);
          else member.getMotionMaster().moveIdle();

          logDebug("movement", () => `Set ${dismiss ? "default" : "idle"} movement for member ${member.getGUID()}`);
        }
      }
    }
    this.m_Formed = !dismiss;
  }

  /** @ac game/Entities/Creature/CreatureGroups.cpp CreatureGroup::LeaderStartedMoving */
  leaderStartedMoving(): void {
    if (!this.m_leader) return;

    for (const [member, pFormationInfo] of this.m_members) {
      if (member === this.m_leader || !member.isAlive() || member.getVictim() || !pFormationInfo.hasGroupFlag(GroupAIFlags.GROUP_AI_FLAG_FOLLOW_LEADER)) continue;

      if (member.hasUnitState(UNIT_STATE_NOT_MOVE) || member.isPossessed() || member.hasUnitFlag(UNIT_FLAG_PLAYER_CONTROLLED)) continue;

      const followAngle = pFormationInfo.follow_angle;
      const followDist = pFormationInfo.follow_dist;

      if (!member.hasUnitState(UNIT_STATE_FOLLOW_MOVE)) member.getMotionMaster().moveFormation(this.m_leader, followDist, followAngle, pFormationInfo.point_1, pFormationInfo.point_2);
    }
  }

  /** @ac game/Entities/Creature/CreatureGroups.cpp CreatureGroup::CanLeaderStartMoving */
  canLeaderStartMoving(): boolean {
    for (const member of this.m_members.keys()) {
      if (member && member !== this.m_leader && member.isAlive()) if (member.isEngaged() || member.isInEvadeMode()) return false;
    }

    return true;
  }

  /** @ac game/Entities/Creature/CreatureGroups.cpp CreatureGroup::RemoveFormationMovement */
  removeFormationMovement(): void {
    for (const member of this.m_members.keys()) {
      if (!member || member === this.m_leader) continue;

      if (member.getMotionMaster().getMotionSlotType(MOTION_SLOT_IDLE) === FORMATION_MOTION_TYPE) member.getMotionMaster().movementExpiredOnSlot(MOTION_SLOT_IDLE, false);
    }
  }

  /** The `Milliseconds` and `Seconds` arguments are numbers. @ac game/Entities/Creature/CreatureGroups.cpp CreatureGroup::DespawnFormation */
  despawnFormation(timeToDespawn = 0, forcedRespawnTimer = 0): void {
    // Copy the member list first: DespawnOrUnsummon() takes the member out of
    // the world, which erases it from m_members and would invalidate this loop.
    const members = new Map(this.m_members);

    for (const member of members.keys()) {
      if (member && member.getFormation() === this) member.despawnOrUnsummon(timeToDespawn, forcedRespawnTimer);
    }
  }

  /** @ac game/Entities/Creature/CreatureGroups.cpp CreatureGroup::RespawnFormation */
  respawnFormation(force = false): void {
    // Copy the member list first: Respawn() takes the member out of the world,
    // which erases it from m_members and would invalidate this loop.
    const members = new Map(this.m_members);

    for (const member of members.keys()) {
      if (member && member.getFormation() === this && !member.isAlive()) {
        member.respawn(force);
      }
    }
  }

  /** @ac game/Entities/Creature/CreatureGroups.cpp CreatureGroup::IsFormationInCombat */
  isFormationInCombat(): boolean {
    for (const member of this.m_members.keys()) {
      if (member && member.isInCombat()) {
        return true;
      }
    }

    return false;
  }

  /** @ac game/Entities/Creature/CreatureGroups.cpp CreatureGroup::IsAnyMemberAlive */
  isAnyMemberAlive(ignoreLeader = false): boolean {
    for (const member of this.m_members.keys()) {
      if (member && member.isAlive()) {
        if (!ignoreLeader || member !== this.m_leader) {
          return true;
        }
      }
    }

    return false;
  }
}

// The `Creature` members that deal with the formation (`Creature.cpp`). `Creature` has the `m_formation` field and calls
// these from its methods of the same name (`Creature.ts` marks them `@ac-skip Formations`); they take the creature as the
// first parameter because `Creature` is not edited by the movement port.

/** @ac game/Entities/Creature/Creature.cpp Creature::SearchFormation */
export function SearchFormation(creature: MovementOwnerCreature): void {
  if (creature.isSummon()) {
    return;
  }

  const spawnId = creature.getSpawnId();
  if (!spawnId) {
    return;
  }

  const frmdata = sFormationMgr().CreatureGroupMap.get(spawnId);
  if (frmdata) {
    sFormationMgr().addCreatureToGroup(frmdata.leaderGUID, creature);
  }
}

/** @ac game/Entities/Creature/Creature.cpp Creature::IsFormationLeader */
export function IsFormationLeader(creature: MovementOwnerCreature): boolean {
  const formation = creature.getFormation();
  if (!formation) return false;

  return formation.getLeader() === creature;
}

/** @ac game/Entities/Creature/Creature.cpp Creature::SignalFormationMovement */
export function SignalFormationMovement(creature: MovementOwnerCreature): void {
  const formation = creature.getFormation();
  if (!formation) return;

  if (!formation.getLeader() || formation.getLeader() !== creature) return;

  formation.leaderStartedMoving();
}

/** @ac game/Entities/Creature/Creature.cpp Creature::IsFormationLeaderMoveAllowed */
export function IsFormationLeaderMoveAllowed(creature: MovementOwnerCreature): boolean {
  const formation = creature.getFormation();
  if (!formation) return true;

  return formation.canLeaderStartMoving();
}

/** @ac game/Entities/Creature/Creature.cpp Creature::Motion_Initialize */
export function Motion_Initialize(creature: MovementOwnerCreature): void {
  const formation = creature.getFormation();
  if (!formation) creature.getMotionMaster().initialize();
  else if (formation.getLeader() === creature) {
    formation.formationReset(false, true);
    creature.getMotionMaster().initialize();
  } else if (formation.isFormed()) {
    // If the leader is already moving, start following immediately
    // instead of waiting for the next waypoint signal.
    const leader = formation.getLeader();
    if (leader) {
      if (leader.isAlive() && !leader.movespline.finalized()) {
        formation.leaderStartedMoving();
        return;
      }
    }
    creature.getMotionMaster().moveIdle(); //wait the order of leader
  } else creature.getMotionMaster().initialize();
}
