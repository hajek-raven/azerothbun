/**
 * @ac game/Grids/Notifiers/GridNotifiers.h
 * @ac game/Grids/Notifiers/GridNotifiers.cpp
 * @ac game/Grids/Notifiers/GridNotifiersImpl.h
 *
 * The grid visitors (`Acore::` namespace): visibility notifiers, message deliverers, searchers, workers, and checks.
 *
 * Shapes:
 * - A notifier is a `GridTypeMapVisitor` (and a `FarVisibleVisitor` when C++ declares `Visit(std::vector<T>&)`): it
 *   implements exactly the `visitXMap` methods for the overloads the C++ declares; the catch-all `template<class SKIP>
 *   Visit(GridRefMgr<SKIP>&) {}` is the absence of the method.
 * - A check is a function or an object with `check(obj)` (the C++ `operator()`); a do is a function or an object with
 *   `do(obj)`.
 * - A searcher's C++ `T*& result` reference is its `i_object` field, read after the visit; list searchers push into the
 *   array they are given (`ContainerInserter`).
 * - Checks declare, per parameter, the `Unit` / `Player` / `Creature` members they call. Members that no class has yet
 *   (`IsHostileTo`, `HasFearAura`, ...) are part of the declared capability: a check can only be used with objects
 *   that implement them, and no behavior is invented for the missing ones.
 */
import { rollChanceI } from "../../../common/random.ts";
import type { GameObject } from "../../Entities/GameObject/GameObject.ts";
import type { Corpse } from "../../Entities/Corpse/Corpse.ts";
import type { Creature } from "../../Entities/Creature/Creature.ts";
import type { DynamicObject } from "../../Entities/DynamicObject/DynamicObject.ts";
import { NOTIFY_AI_RELOCATION, NOTIFY_VISIBILITY_CHANGED, WorldObject } from "../../Entities/Object/Object.ts";
import { ObjectGuid, TYPEID_CORPSE, TYPEID_DYNAMICOBJECT, TYPEID_GAMEOBJECT, TYPEID_PLAYER, TYPEID_UNIT, type TypeID } from "../../Entities/Object/ObjectGuid.ts";
import type { VisiblePlayersMap } from "../../Entities/Object/ObjectVisibilityContainer.ts";
import { UpdateData, type WorldPacket } from "../../Entities/Object/Updates/UpdateData.ts";
import { sSpellMgr } from "../../Spells/SpellMgr.ts";
import type { SpellInfo } from "../../../spells/spell-info.ts";
import {
  CREATURE_TYPE_NON_COMBAT_PET,
  UNIT_FLAG_NON_ATTACKABLE,
  UNIT_FLAG_NOT_SELECTABLE,
  UNIT_STATE_CONFUSED,
  UNIT_STATE_SIGHTLESS,
  UNIT_STATE_STUNNED,
} from "../../../spells/enums.ts";
import { TEAM_NEUTRAL } from "../../../shared/SharedDefines.ts";
import {
  GRID_MAP_TYPE_MASK_ALL,
  GRID_MAP_TYPE_MASK_CORPSE,
  GRID_MAP_TYPE_MASK_CREATURE,
  GRID_MAP_TYPE_MASK_DYNAMICOBJECT,
  GRID_MAP_TYPE_MASK_GAMEOBJECT,
  GRID_MAP_TYPE_MASK_PLAYER,
  type CorpseMapType,
  type CreatureMapType,
  type DynamicObjectMapType,
  type GameObjectMapType,
  type PlayerMapType,
} from "../GridDefines.ts";
import type { GridPlayer, UnitLike } from "../GridPlayer.ts";
import { LINEOFSIGHT_ALL_CHECKS, LINEOFSIGHT_CHECK_GOBJECT_M2, ModelIgnoreFlags } from "../MapLike.ts";
import type { FarVisibleVisitor, GridTypeMapVisitor } from "../TypeContainer.ts";

/** `Unit` as the checks see it (see `GridPlayer.ts`). */
// Kept local so the notifiers carry no runtime import of `GameObject.ts` / `Corpse.ts` (type imports only).
/** @ac shared/SharedDefines.h GameobjectTypes::GAMEOBJECT_TYPE_SPELL_FOCUS */
const GAMEOBJECT_TYPE_SPELL_FOCUS = 8;
/** @ac shared/SharedDefines.h GameobjectTypes::GAMEOBJECT_TYPE_FISHINGHOLE */
const GAMEOBJECT_TYPE_FISHINGHOLE = 25;
/** @ac game/Entities/Corpse/Corpse.h CorpseType::CORPSE_BONES */
const CORPSE_BONES = 0;

type Unit = UnitLike;

/** A C++ check functor: a function or an object with `check` (`operator()`). */
export type Check<T> = ((obj: T) => boolean) | { check(obj: T): boolean };
/** A C++ do functor: a function or an object with `do` (`operator()`). */
export type Do<T> = ((obj: T) => void) | { do(obj: T): void };

function asCheck<T>(check: Check<T>): (obj: T) => boolean {
  return typeof check === "function" ? check : (obj) => check.check(obj);
}

function asDo<T>(work: Do<T>): (obj: T) => void {
  return typeof work === "function" ? work : (obj) => work.do(obj);
}

// ======================================================================================== notifiers

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::VisibleNotifier */
export class VisibleNotifier implements GridTypeMapVisitor, FarVisibleVisitor {
  readonly i_visibleNow: Unit[];
  readonly i_data = new UpdateData();

  /** @ac game/Grids/Notifiers/GridNotifiers.h Acore::VisibleNotifier::VisibleNotifier */
  constructor(
    readonly i_player: GridPlayer,
    readonly i_gobjOnly: boolean,
  ) {
    this.i_visibleNow = i_player.m_newVisible;
    this.i_visibleNow.length = 0;
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::VisibleNotifier::Visit (`GameObjectMapType&`) */
  visitGameObjectMap(m: GameObjectMapType): void {
    for (const go of m) this.i_player.updateVisibilityOf(go, this.i_data, this.i_visibleNow);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::VisibleNotifier::Visit (`GridRefMgr<T>&`) */
  protected visitGridRefMgr(m: Iterable<WorldObject>): void {
    // Xinef: Update gameobjects only
    if (this.i_gobjOnly) return;

    for (const obj of m) this.i_player.updateVisibilityOf(obj, this.i_data, this.i_visibleNow);
  }

  visitPlayerMap(m: PlayerMapType): void {
    this.visitGridRefMgr(m);
  }
  visitCreatureMap(m: CreatureMapType): void {
    this.visitGridRefMgr(m);
  }
  visitCorpseMap(m: CorpseMapType): void {
    this.visitGridRefMgr(m);
  }
  visitDynamicObjectMap(m: DynamicObjectMapType): void {
    this.visitGridRefMgr(m);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::VisibleNotifier::Visit (`std::vector<T>&`) */
  protected visitVector(m: readonly WorldObject[]): void {
    for (const obj of m) this.i_player.updateVisibilityOf(obj, this.i_data, this.i_visibleNow);
  }

  visitCreatureVector(m: readonly Creature[]): void {
    this.visitVector(m);
  }
  visitGameObjectVector(m: readonly GameObject[]): void {
    this.visitVector(m);
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::VisibleNotifier::SendToSelf */
  sendToSelf(): void {
    // Update far visible objects
    const zoneWideVisibleObjects = this.i_player.getMap().getZoneWideVisibleWorldObjectsForZone(this.i_player.getZoneId());
    if (zoneWideVisibleObjects) {
      for (const obj of zoneWideVisibleObjects) {
        switch (obj.getTypeId()) {
          case TYPEID_GAMEOBJECT:
          case TYPEID_UNIT:
          case TYPEID_DYNAMICOBJECT:
            this.i_player.updateVisibilityOf(obj, this.i_data, this.i_visibleNow);
            break;
          default:
            break;
        }
      }
    }

    const visibleWorldObjects = this.i_player.getObjectVisibilityContainer().getVisibleWorldObjectsMap();
    if (visibleWorldObjects) {
      for (const obj of [...visibleWorldObjects.values()]) {
        if (!this.i_player.isWorldObjectOutOfSightRange(obj) || this.i_player.canSeeOrDetect(obj, false, true)) continue;

        this.i_data.addOutOfRangeGUID(obj.getGUID());

        const objPlayer = obj.toPlayer();
        if (objPlayer) objPlayer.updateVisibilityOf(this.i_player);

        // Clean up references
        this.i_player.getObjectVisibilityContainer().unlinkVisibilityFromPlayer(obj);
      }
    }

    if (!this.i_data.hasData()) return;

    this.i_player.sendDirectMessage(this.i_data.buildPacket());

    for (const unit of this.i_visibleNow) this.i_player.getInitialVisiblePackets(unit);
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::VisibleChangesNotifier */
export class VisibleChangesNotifier implements GridTypeMapVisitor {
  constructor(readonly i_object: WorldObject) {}

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::VisibleChangesNotifier::Visit (`PlayerMapType&`) */
  visitPlayerMap(m: PlayerMapType): void {
    for (const player of m) {
      if (player === this.i_object) continue;

      player.updateVisibilityOf(this.i_object);

      if (player.hasSharedVision()) {
        for (const i of player.getSharedVisionList()) {
          if (i.m_seer === player) i.updateVisibilityOf(this.i_object);
        }
      }
    }
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::VisibleChangesNotifier::Visit (`CreatureMapType&`) */
  visitCreatureMap(m: CreatureMapType): void {
    for (const creature of m) {
      if (creature.hasSharedVision()) {
        for (const i of creature.getSharedVisionList()) {
          if (i.m_seer === creature) i.updateVisibilityOf(this.i_object);
        }
      }
    }
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::VisibleChangesNotifier::Visit (`DynamicObjectMapType&`) */
  visitDynamicObjectMap(m: DynamicObjectMapType): void {
    for (const dynObj of m) {
      if (ObjectGuid.IsPlayer(dynObj.getCasterGUID())) {
        const caster = dynObj.getCaster();
        if (caster) {
          const player = caster.toPlayer();
          if (player && player.m_seer === dynObj) player.updateVisibilityOf(this.i_object);
        }
      }
    }
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::PlayerRelocationNotifier */
export class PlayerRelocationNotifier extends VisibleNotifier {
  constructor(player: GridPlayer) {
    super(player, false);
  }

  /**
   * @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::PlayerRelocationNotifier::Visit (`PlayerMapType&`)
   * this notifier with different Visit(PlayerMapType&) than VisibleNotifier is needed to update visibility of self for
   * other players when we move (eg. stealth detection changes)
   */
  override visitPlayerMap(m: PlayerMapType): void {
    for (const player of m) {
      this.i_player.updateVisibilityOf(player, this.i_data, this.i_visibleNow);
      player.updateVisibilityOf(this.i_player);
    }
  }
}

/** The creature AI calls the relocation workers make (`CreatureAI.h`). */
export interface CreatureAILike {
  /** @ac game/AI/CreatureAI.h CreatureAI::MoveInLineOfSight_Safe */
  MoveInLineOfSight_Safe(who: Unit): void;
  /** @ac game/AI/CreatureAI.h CreatureAI::TriggerAlert */
  TriggerAlert(who: Unit): void;
}

/** @ac game/Grids/Notifiers/GridNotifiers.cpp CreatureUnitRelocationWorker */
export function CreatureUnitRelocationWorker(c: Creature, u: Unit): void {
  if (!u.isAlive() || !c.isAlive() || c === u || u.isInFlight()) return;

  if (!c.hasUnitState(UNIT_STATE_SIGHTLESS)) {
    const ai = c.ai();
    if (c.IsAIEnabled && ai && c.canSeeOrDetect(u, false, true)) {
      ai.MoveInLineOfSight_Safe(u);
    } else if (u.isPlayer() && u.hasStealthAura() && c.IsAIEnabled && ai && c.canSeeOrDetect(u, false, true, true)) {
      ai.TriggerAlert(u);
    }
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::CreatureRelocationNotifier */
export class CreatureRelocationNotifier implements GridTypeMapVisitor {
  constructor(readonly i_creature: Creature) {}

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::CreatureRelocationNotifier::Visit (`PlayerMapType&`) */
  visitPlayerMap(m: PlayerMapType): void {
    for (const player of m) {
      // NOTIFY_VISIBILITY_CHANGED does not guarantee that player will do it himself (because distance is also checked), but screw it, it's not that important
      if (!player.m_seer.isNeedNotify(NOTIFY_VISIBILITY_CHANGED)) player.updateVisibilityOf(this.i_creature);

      // NOTIFY_AI_RELOCATION does not guarantee that player will do it himself (because distance is also checked), but screw it, it's not that important
      if (!player.m_seer.isNeedNotify(NOTIFY_AI_RELOCATION) && !this.i_creature.isMoveInLineOfSightStrictlyDisabled()) CreatureUnitRelocationWorker(this.i_creature, player);
    }
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AIRelocationNotifier */
export class AIRelocationNotifier implements GridTypeMapVisitor {
  readonly isCreature: boolean;

  constructor(
    readonly i_unit: Unit,
    readonly includePlayers = false,
  ) {
    this.isCreature = i_unit.isCreature();
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::AIRelocationNotifier::Visit (`CreatureMapType&`) */
  visitCreatureMap(m: CreatureMapType): void {
    const self = this.isCreature && !(this.i_unit as unknown as Creature).isMoveInLineOfSightStrictlyDisabled();
    for (const c of m) {
      // NOTIFY_VISIBILITY_CHANGED | NOTIFY_AI_RELOCATION does not guarantee that unit will do it itself (because distance is also checked), but screw it, it's not that important
      if (!c.isNeedNotify(NOTIFY_VISIBILITY_CHANGED | NOTIFY_AI_RELOCATION) && !c.isMoveInLineOfSightStrictlyDisabled()) CreatureUnitRelocationWorker(c, this.i_unit);

      if (self) CreatureUnitRelocationWorker(this.i_unit as unknown as Creature, c);
    }
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::AIRelocationNotifier::Visit (`PlayerMapType&`) */
  visitPlayerMap(m: PlayerMapType): void {
    if (!this.includePlayers) return;

    const creature = this.i_unit.toCreature();
    if (!creature || creature.isMoveInLineOfSightStrictlyDisabled()) return;

    for (const player of m) CreatureUnitRelocationWorker(creature, player);
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::TeamFilter */
export const TeamFilter = { All: 0, OwnTeam: 1, OtherTeam: 2 } as const;
export type TeamFilter = (typeof TeamFilter)[keyof typeof TeamFilter];

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::MessageDistDeliverer */
export class MessageDistDeliverer implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  readonly i_distSq: number;
  readonly teamFilter: TeamFilter;
  readonly teamId: number;

  /** @ac game/Grids/Notifiers/GridNotifiers.h Acore::MessageDistDeliverer::MessageDistDeliverer */
  constructor(
    readonly i_source: WorldObject,
    readonly i_message: WorldPacket,
    dist: number,
    teamFilter: TeamFilter = TeamFilter.All,
    readonly skipped_receiver: GridPlayer | null = null,
    readonly required3dDist = false,
  ) {
    this.i_phaseMask = i_source.getPhaseMask();
    this.i_distSq = dist * dist;
    const sourcePlayer = i_source.toPlayer();
    this.teamFilter = sourcePlayer ? teamFilter : TeamFilter.All;
    this.teamId = sourcePlayer ? sourcePlayer.getTeamId() : TEAM_NEUTRAL;
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::MessageDistDeliverer::Visit (`VisiblePlayersMap const&`: uses visibility map) */
  visitVisiblePlayersMap(m: VisiblePlayersMap): void {
    for (const target of [...m.values()]) {
      if (this.i_distSq !== 0.0) {
        const sight = target.getSightPosition();
        const dx = sight.getPositionX() - this.i_source.getPositionX();
        const dy = sight.getPositionY() - this.i_source.getPositionY();
        if (dx * dx + dy * dy > this.i_distSq) continue;
      }

      // @todo: Might not need this check anymore
      if (this.skipped_receiver === target) continue;

      target.sendDirectMessage(this.i_message);
    }
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::MessageDistDeliverer::Visit (`PlayerMapType&`) */
  visitPlayerMap(m: PlayerMapType): void {
    for (const target of m) {
      if (!target.inSamePhase(this.i_phaseMask)) continue;

      if (this.required3dDist) {
        if (target.getExactDistSq(this.i_source) > this.i_distSq) continue;
      } else if (target.getExactDist2dSq(this.i_source) > this.i_distSq) continue;

      // Send packet to all who are sharing the player's vision
      if (target.hasSharedVision()) {
        for (const i of target.getSharedVisionList()) {
          if (i.m_seer === target) this.sendPacket(i);
        }
      }

      if (target.m_seer === target || target.getVehicle()) this.sendPacket(target);
    }
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::MessageDistDeliverer::Visit (`CreatureMapType&`) */
  visitCreatureMap(m: CreatureMapType): void {
    for (const target of m) {
      if (!target.hasSharedVision() || !target.inSamePhase(this.i_phaseMask)) continue;

      if (this.required3dDist) {
        if (target.getExactDistSq(this.i_source) > this.i_distSq) continue;
      } else if (target.getExactDist2dSq(this.i_source) > this.i_distSq) continue;

      // Send packet to all who are sharing the creature's vision
      for (const i of target.getSharedVisionList()) {
        if (i.m_seer === target) this.sendPacket(i);
      }
    }
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::MessageDistDeliverer::Visit (`DynamicObjectMapType&`) */
  visitDynamicObjectMap(m: DynamicObjectMapType): void {
    for (const target of m) {
      if (!ObjectGuid.IsPlayer(target.getCasterGUID()) || !target.inSamePhase(this.i_phaseMask)) continue;

      // Xinef: Check whether the dynobject allows to see through it
      if (!target.isViewpoint()) continue;

      if (this.required3dDist) {
        if (target.getExactDistSq(this.i_source) > this.i_distSq) continue;
      } else if (target.getExactDist2dSq(this.i_source) > this.i_distSq) continue;

      // Send packet back to the caster if the caster has vision of dynamic object
      const caster = target.getCaster()?.toPlayer() ?? null;
      if (caster && caster.m_seer === target) this.sendPacket(caster);
    }
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.h Acore::MessageDistDeliverer::SendPacket */
  sendPacket(player: GridPlayer): void {
    // never send packet to self
    if (player === this.i_source || this.skipped_receiver === player) return;

    switch (this.teamFilter) {
      case TeamFilter.OwnTeam:
        if (player.getTeamId() !== this.teamId) return;
        break;
      case TeamFilter.OtherTeam:
        if (player.getTeamId() === this.teamId) return;
        break;
      case TeamFilter.All:
      default:
        break;
    }

    if (!player.haveAtClient(this.i_source)) return;

    player.sendDirectMessage(this.i_message);
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::MessageDistDelivererToHostile */
export class MessageDistDelivererToHostile implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  readonly i_distSq: number;

  constructor(
    readonly i_source: Unit,
    readonly i_message: WorldPacket,
    dist: number,
  ) {
    this.i_phaseMask = i_source.getPhaseMask();
    this.i_distSq = dist * dist;
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::MessageDistDelivererToHostile::Visit (`PlayerMapType&`) */
  visitPlayerMap(m: PlayerMapType): void {
    for (const target of m) {
      if (!target.inSamePhase(this.i_phaseMask)) continue;

      if (target.getExactDist2dSq(this.i_source) > this.i_distSq) continue;

      // Send packet to all who are sharing the player's vision
      if (target.hasSharedVision()) {
        for (const i of target.getSharedVisionList()) {
          if (i.m_seer === target) this.sendPacket(i);
        }
      }

      if (target.m_seer === target || target.getVehicle()) this.sendPacket(target);
    }
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::MessageDistDelivererToHostile::Visit (`CreatureMapType&`) */
  visitCreatureMap(m: CreatureMapType): void {
    for (const target of m) {
      if (!target.hasSharedVision() || !target.inSamePhase(this.i_phaseMask)) continue;

      if (target.getExactDist2dSq(this.i_source) > this.i_distSq) continue;

      // Send packet to all who are sharing the creature's vision
      for (const i of target.getSharedVisionList()) {
        if (i.m_seer === target) this.sendPacket(i);
      }
    }
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::MessageDistDelivererToHostile::Visit (`DynamicObjectMapType&`) */
  visitDynamicObjectMap(m: DynamicObjectMapType): void {
    for (const target of m) {
      if (!ObjectGuid.IsPlayer(target.getCasterGUID()) || !target.inSamePhase(this.i_phaseMask)) continue;

      if (target.getExactDist2dSq(this.i_source) > this.i_distSq) continue;

      // Send packet back to the caster if the caster has vision of dynamic object
      const caster = target.getCaster()?.toPlayer() ?? null;
      if (caster && caster.m_seer === target) this.sendPacket(caster);
    }
  }

  /**
   * @ac game/Grids/Notifiers/GridNotifiers.h Acore::MessageDistDelivererToHostile::SendPacket
   * The player must provide `IsFriendlyTo` (faction reactions are the Combat topic).
   */
  sendPacket(player: GridPlayer): void {
    // never send packet to self
    if (player === this.i_source || !player.haveAtClient(this.i_source) || (player as GridPlayer & ReactionCaps).isFriendlyTo(this.i_source)) return;

    player.sendDirectMessage(this.i_message);
  }
}

// ======================================================================================== searchers and workers

/** The `Unit::IsHostileTo` / `Unit::IsFriendlyTo` capability (faction reactions, Combat topic). */
export interface ReactionCaps {
  isHostileTo(target: WorldObject): boolean;
  isFriendlyTo(target: WorldObject): boolean;
}

/**
 * Visits each object of `m` in the searcher's phase. `stopWhen` ends the walk (first-match searchers).
 * The loop body shared by the C++ `Visit` overloads of every searcher below.
 */
function forEachInPhase<T extends WorldObject>(m: Iterable<T>, phaseMask: number, fn: (obj: T) => boolean | void): void {
  for (const obj of m) {
    if (!obj.inSamePhase(phaseMask)) continue;
    if (fn(obj) === true) return;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::WorldObjectSearcher (first accepted by Check) */
export class WorldObjectSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: WorldObject) => boolean;

  constructor(
    searcher: WorldObject,
    check: Check<WorldObject>,
    readonly i_mapTypeMask = GRID_MAP_TYPE_MASK_ALL,
    public i_object: WorldObject | null = null,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::WorldObjectSearcher::Visit */
  private search(mask: number, m: Iterable<WorldObject>): void {
    if (!(this.i_mapTypeMask & mask)) return;

    // already found
    if (this.i_object) return;

    forEachInPhase(m, this.i_phaseMask, (obj) => {
      if (this.i_check(obj)) {
        this.i_object = obj;
        return true;
      }
    });
  }

  visitGameObjectMap(m: GameObjectMapType): void {
    this.search(GRID_MAP_TYPE_MASK_GAMEOBJECT, m);
  }
  visitPlayerMap(m: PlayerMapType): void {
    this.search(GRID_MAP_TYPE_MASK_PLAYER, m);
  }
  visitCreatureMap(m: CreatureMapType): void {
    this.search(GRID_MAP_TYPE_MASK_CREATURE, m);
  }
  visitCorpseMap(m: CorpseMapType): void {
    this.search(GRID_MAP_TYPE_MASK_CORPSE, m);
  }
  visitDynamicObjectMap(m: DynamicObjectMapType): void {
    this.search(GRID_MAP_TYPE_MASK_DYNAMICOBJECT, m);
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::WorldObjectLastSearcher (last accepted by Check) */
export class WorldObjectLastSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: WorldObject) => boolean;

  constructor(
    searcher: WorldObject,
    check: Check<WorldObject>,
    readonly i_mapTypeMask = GRID_MAP_TYPE_MASK_ALL,
    public i_object: WorldObject | null = null,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::WorldObjectLastSearcher::Visit */
  private search(mask: number, m: Iterable<WorldObject>): void {
    if (!(this.i_mapTypeMask & mask)) return;

    forEachInPhase(m, this.i_phaseMask, (obj) => {
      if (this.i_check(obj)) this.i_object = obj;
    });
  }

  visitGameObjectMap(m: GameObjectMapType): void {
    this.search(GRID_MAP_TYPE_MASK_GAMEOBJECT, m);
  }
  visitPlayerMap(m: PlayerMapType): void {
    this.search(GRID_MAP_TYPE_MASK_PLAYER, m);
  }
  visitCreatureMap(m: CreatureMapType): void {
    this.search(GRID_MAP_TYPE_MASK_CREATURE, m);
  }
  visitCorpseMap(m: CorpseMapType): void {
    this.search(GRID_MAP_TYPE_MASK_CORPSE, m);
  }
  visitDynamicObjectMap(m: DynamicObjectMapType): void {
    this.search(GRID_MAP_TYPE_MASK_DYNAMICOBJECT, m);
  }
}

/**
 * @ac game/Grids/Notifiers/GridNotifiers.h Acore::WorldObjectListSearcher (all accepted by Check)
 * Like the C++, this one does not filter by phase.
 */
export class WorldObjectListSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: WorldObject) => boolean;

  constructor(
    searcher: WorldObject,
    readonly container: WorldObject[],
    check: Check<WorldObject>,
    readonly i_mapTypeMask = GRID_MAP_TYPE_MASK_ALL,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::WorldObjectListSearcher::Visit */
  private search(mask: number, m: Iterable<WorldObject>): void {
    if (!(this.i_mapTypeMask & mask)) return;

    for (const obj of m) if (this.i_check(obj)) this.container.push(obj);
  }

  visitPlayerMap(m: PlayerMapType): void {
    this.search(GRID_MAP_TYPE_MASK_PLAYER, m);
  }
  visitCreatureMap(m: CreatureMapType): void {
    this.search(GRID_MAP_TYPE_MASK_CREATURE, m);
  }
  visitCorpseMap(m: CorpseMapType): void {
    this.search(GRID_MAP_TYPE_MASK_CORPSE, m);
  }
  visitGameObjectMap(m: GameObjectMapType): void {
    this.search(GRID_MAP_TYPE_MASK_GAMEOBJECT, m);
  }
  visitDynamicObjectMap(m: DynamicObjectMapType): void {
    this.search(GRID_MAP_TYPE_MASK_DYNAMICOBJECT, m);
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::WorldObjectWorker */
export class WorldObjectWorker implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_do: (obj: WorldObject) => void;

  constructor(
    searcher: WorldObject,
    work: Do<WorldObject>,
    readonly i_mapTypeMask = GRID_MAP_TYPE_MASK_ALL,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_do = asDo(work);
  }

  private work(mask: number, m: Iterable<WorldObject>): void {
    if (!(this.i_mapTypeMask & mask)) return;
    forEachInPhase(m, this.i_phaseMask, (obj) => {
      this.i_do(obj);
    });
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.h Acore::WorldObjectWorker::Visit (`GameObjectMapType&`) */
  visitGameObjectMap(m: GameObjectMapType): void {
    this.work(GRID_MAP_TYPE_MASK_GAMEOBJECT, m);
  }
  /** @ac game/Grids/Notifiers/GridNotifiers.h Acore::WorldObjectWorker::Visit (`PlayerMapType&`) */
  visitPlayerMap(m: PlayerMapType): void {
    this.work(GRID_MAP_TYPE_MASK_PLAYER, m);
  }
  /** @ac game/Grids/Notifiers/GridNotifiers.h Acore::WorldObjectWorker::Visit (`CreatureMapType&`) */
  visitCreatureMap(m: CreatureMapType): void {
    this.work(GRID_MAP_TYPE_MASK_CREATURE, m);
  }
  /** @ac game/Grids/Notifiers/GridNotifiers.h Acore::WorldObjectWorker::Visit (`CorpseMapType&`) */
  visitCorpseMap(m: CorpseMapType): void {
    this.work(GRID_MAP_TYPE_MASK_CORPSE, m);
  }
  /** @ac game/Grids/Notifiers/GridNotifiers.h Acore::WorldObjectWorker::Visit (`DynamicObjectMapType&`) */
  visitDynamicObjectMap(m: DynamicObjectMapType): void {
    this.work(GRID_MAP_TYPE_MASK_DYNAMICOBJECT, m);
  }
}

// Gameobject searchers

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::GameObjectSearcher */
export class GameObjectSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: GameObject) => boolean;

  constructor(
    searcher: WorldObject,
    check: Check<GameObject>,
    public i_object: GameObject | null = null,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::GameObjectSearcher::Visit */
  visitGameObjectMap(m: GameObjectMapType): void {
    // already found
    if (this.i_object) return;

    forEachInPhase(m, this.i_phaseMask, (go) => {
      if (this.i_check(go)) {
        this.i_object = go;
        return true;
      }
    });
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::GameObjectLastSearcher (last accepted by Check GO if any (Check can change requirements at each call)) */
export class GameObjectLastSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: GameObject) => boolean;

  constructor(
    searcher: WorldObject,
    check: Check<GameObject>,
    public i_object: GameObject | null = null,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::GameObjectLastSearcher::Visit */
  visitGameObjectMap(m: GameObjectMapType): void {
    forEachInPhase(m, this.i_phaseMask, (go) => {
      if (this.i_check(go)) this.i_object = go;
    });
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::GameObjectListSearcher */
export class GameObjectListSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: GameObject) => boolean;

  constructor(
    searcher: WorldObject,
    readonly container: GameObject[],
    check: Check<GameObject>,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::GameObjectListSearcher::Visit */
  visitGameObjectMap(m: GameObjectMapType): void {
    forEachInPhase(m, this.i_phaseMask, (go) => {
      if (this.i_check(go)) this.container.push(go);
    });
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::GameObjectWorker */
export class GameObjectWorker implements GridTypeMapVisitor {
  private readonly _phaseMask: number;
  private readonly _func: (obj: GameObject) => void;

  constructor(searcher: WorldObject, func: Do<GameObject>) {
    this._phaseMask = searcher.getPhaseMask();
    this._func = asDo(func);
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.h Acore::GameObjectWorker::Visit */
  visitGameObjectMap(m: GameObjectMapType): void {
    forEachInPhase(m, this._phaseMask, (go) => {
      this._func(go);
    });
  }
}

// Unit searchers

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::UnitSearcher (first accepted by Check Unit if any) */
export class UnitSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: Unit) => boolean;

  constructor(
    searcher: WorldObject,
    check: Check<Unit>,
    public i_object: Unit | null = null,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::UnitSearcher::Visit */
  private search(m: Iterable<Unit>): void {
    // already found
    if (this.i_object) return;

    forEachInPhase(m, this.i_phaseMask, (u) => {
      if (this.i_check(u)) {
        this.i_object = u;
        return true;
      }
    });
  }

  visitCreatureMap(m: CreatureMapType): void {
    this.search(m);
  }
  visitPlayerMap(m: PlayerMapType): void {
    this.search(m);
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::UnitLastSearcher (last accepted by Check Unit if any (Check can change requirements at each call)) */
export class UnitLastSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: Unit) => boolean;

  constructor(
    searcher: WorldObject,
    check: Check<Unit>,
    public i_object: Unit | null = null,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::UnitLastSearcher::Visit */
  private search(m: Iterable<Unit>): void {
    forEachInPhase(m, this.i_phaseMask, (u) => {
      if (this.i_check(u)) this.i_object = u;
    });
  }

  visitCreatureMap(m: CreatureMapType): void {
    this.search(m);
  }
  visitPlayerMap(m: PlayerMapType): void {
    this.search(m);
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::UnitListSearcher (all accepted by Check units if any) */
export class UnitListSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: Unit) => boolean;

  constructor(
    searcher: WorldObject,
    readonly container: Unit[],
    check: Check<Unit>,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::UnitListSearcher::Visit */
  private search(m: Iterable<Unit>): void {
    forEachInPhase(m, this.i_phaseMask, (u) => {
      if (this.i_check(u)) this.container.push(u);
    });
  }

  visitPlayerMap(m: PlayerMapType): void {
    this.search(m);
  }
  visitCreatureMap(m: CreatureMapType): void {
    this.search(m);
  }
}

// Creature searchers

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::CreatureSearcher */
export class CreatureSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: Creature) => boolean;

  constructor(
    searcher: WorldObject,
    check: Check<Creature>,
    public i_object: Creature | null = null,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::CreatureSearcher::Visit */
  visitCreatureMap(m: CreatureMapType): void {
    // already found
    if (this.i_object) return;

    forEachInPhase(m, this.i_phaseMask, (c) => {
      if (this.i_check(c)) {
        this.i_object = c;
        return true;
      }
    });
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::CreatureLastSearcher (last accepted by Check Creature if any (Check can change requirements at each call)) */
export class CreatureLastSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: Creature) => boolean;

  constructor(
    searcher: WorldObject,
    check: Check<Creature>,
    public i_object: Creature | null = null,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::CreatureLastSearcher::Visit */
  visitCreatureMap(m: CreatureMapType): void {
    forEachInPhase(m, this.i_phaseMask, (c) => {
      if (this.i_check(c)) this.i_object = c;
    });
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::CreatureListSearcher */
export class CreatureListSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: Creature) => boolean;

  constructor(
    searcher: WorldObject,
    readonly container: Creature[],
    check: Check<Creature>,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::CreatureListSearcher::Visit */
  visitCreatureMap(m: CreatureMapType): void {
    forEachInPhase(m, this.i_phaseMask, (c) => {
      if (this.i_check(c)) this.container.push(c);
    });
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::CreatureWorker */
export class CreatureWorker implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_do: (obj: Creature) => void;

  constructor(searcher: WorldObject, work: Do<Creature>) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_do = asDo(work);
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.h Acore::CreatureWorker::Visit */
  visitCreatureMap(m: CreatureMapType): void {
    forEachInPhase(m, this.i_phaseMask, (c) => {
      this.i_do(c);
    });
  }
}

// Player searchers

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::PlayerSearcher */
export class PlayerSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: GridPlayer) => boolean;

  constructor(
    searcher: WorldObject,
    check: Check<GridPlayer>,
    public i_object: GridPlayer | null = null,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::PlayerSearcher::Visit */
  visitPlayerMap(m: PlayerMapType): void {
    // already found
    if (this.i_object) return;

    forEachInPhase(m, this.i_phaseMask, (p) => {
      if (this.i_check(p)) {
        this.i_object = p;
        return true;
      }
    });
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::PlayerListSearcher */
export class PlayerListSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: GridPlayer) => boolean;

  constructor(
    searcher: WorldObject,
    readonly container: GridPlayer[],
    check: Check<GridPlayer>,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::PlayerListSearcher::Visit */
  visitPlayerMap(m: PlayerMapType): void {
    forEachInPhase(m, this.i_phaseMask, (p) => {
      if (this.i_check(p)) this.container.push(p);
    });
  }
}

/** A check that `PlayerListSearcherWithSharedVision` calls with `(player, checkRange)` (`AnyPlayerInObjectRangeCheck`). */
export interface SharedVisionCheck {
  checkWithRange(u: GridPlayer, checkRange: boolean): boolean;
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::PlayerListSearcherWithSharedVision */
export class PlayerListSearcherWithSharedVision implements GridTypeMapVisitor {
  readonly i_phaseMask: number;

  constructor(
    searcher: WorldObject,
    readonly i_objects: GridPlayer[],
    readonly i_check: SharedVisionCheck,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::PlayerListSearcherWithSharedVision::Visit (`PlayerMapType&`) */
  visitPlayerMap(m: PlayerMapType): void {
    forEachInPhase(m, this.i_phaseMask, (p) => {
      if (this.i_check.checkWithRange(p, true)) this.i_objects.push(p);
    });
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::PlayerListSearcherWithSharedVision::Visit (`CreatureMapType&`) */
  visitCreatureMap(m: CreatureMapType): void {
    for (const c of m) {
      if (c.inSamePhase(this.i_phaseMask) && c.hasSharedVision()) {
        for (const i of c.getSharedVisionList()) {
          if (this.i_check.checkWithRange(i, false)) this.i_objects.push(i);
        }
      }
    }
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::PlayerLastSearcher */
export class PlayerLastSearcher implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_check: (obj: GridPlayer) => boolean;

  constructor(
    searcher: WorldObject,
    check: Check<GridPlayer>,
    public i_object: GridPlayer | null = null,
  ) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_check = asCheck(check);
  }

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::PlayerLastSearcher::Visit */
  visitPlayerMap(m: PlayerMapType): void {
    forEachInPhase(m, this.i_phaseMask, (p) => {
      if (this.i_check(p)) this.i_object = p;
    });
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::PlayerWorker */
export class PlayerWorker implements GridTypeMapVisitor {
  readonly i_phaseMask: number;
  private readonly i_do: (obj: GridPlayer) => void;

  constructor(searcher: WorldObject, work: Do<GridPlayer>) {
    this.i_phaseMask = searcher.getPhaseMask();
    this.i_do = asDo(work);
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.h Acore::PlayerWorker::Visit */
  visitPlayerMap(m: PlayerMapType): void {
    forEachInPhase(m, this.i_phaseMask, (p) => {
      this.i_do(p);
    });
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::PlayerDistWorker */
export class PlayerDistWorker implements GridTypeMapVisitor {
  private readonly i_do: (obj: GridPlayer) => void;

  constructor(
    readonly i_searcher: WorldObject,
    readonly i_dist: number,
    work: Do<GridPlayer>,
  ) {
    this.i_do = asDo(work);
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.h Acore::PlayerDistWorker::Visit */
  visitPlayerMap(m: PlayerMapType): void {
    for (const p of m) {
      if (p.haveAtClient(this.i_searcher) && p.isWithinDist(this.i_searcher, this.i_dist)) this.i_do(p);
    }
  }
}

// ======================================================================================== checks and do classes

// WorldObject check classes

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyDeadUnitObjectInRangeCheck */
export class AnyDeadUnitObjectInRangeCheck {
  constructor(
    protected readonly i_searchObj: Unit,
    protected readonly i_range: number,
  ) {}

  /**
   * @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::AnyDeadUnitObjectInRangeCheck::operator()
   * The `Player*`, `Corpse*`, and `Creature*` overloads; anything else is not interesting.
   */
  check(u: WorldObject): boolean {
    switch (u.getTypeId()) {
      case TYPEID_PLAYER: {
        const player = u as GridPlayer & { hasGhostAura(): boolean };
        return !player.isAlive() && !player.hasGhostAura() && this.i_searchObj.isWithinDistInMap(player, this.i_range);
      }
      case TYPEID_CORPSE:
        return (u as Corpse).getType() !== CORPSE_BONES && this.i_searchObj.isWithinDistInMap(u, this.i_range);
      case TYPEID_UNIT:
        return !(u as Creature).isAlive() && this.i_searchObj.isWithinDistInMap(u, this.i_range);
      default:
        return false;
    }
  }
}

/**
 * @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyDeadUnitSpellTargetInRangeCheck
 * `WorldObjectSpellTargetCheck` is the Spells topic: the caller builds it (C++: `(searchObj, searchObj, spellInfo,
 * check, nullptr)`) and passes it as `i_check`.
 */
export class AnyDeadUnitSpellTargetInRangeCheck extends AnyDeadUnitObjectInRangeCheck {
  constructor(
    searchObj: Unit,
    range: number,
    readonly i_spellInfo: SpellInfo | null,
    readonly i_check: (target: WorldObject) => boolean,
  ) {
    super(searchObj, range);
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.cpp Acore::AnyDeadUnitSpellTargetInRangeCheck::operator() */
  override check(u: WorldObject): boolean {
    const type = u.getTypeId();
    if (type !== TYPEID_PLAYER && type !== TYPEID_CORPSE && type !== TYPEID_UNIT) return false;
    return super.check(u) && this.i_check(u);
  }
}

// WorldObject do classes

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::RespawnDo */
export class RespawnDo {
  /** @ac game/Grids/Notifiers/GridNotifiers.h Acore::RespawnDo::operator() (`Creature*` and `GameObject*` respawn; others do nothing) */
  do(u: WorldObject): void {
    const creature = u.toCreature();
    if (creature) {
      creature.respawn();
      return;
    }
    const go = u.toGameObject();
    if (go) go.respawn();
  }
}

// GameObject checks

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::GameObjectFocusCheck */
export class GameObjectFocusCheck {
  constructor(
    private readonly i_caster: WorldObject,
    private readonly i_focusId: number,
  ) {}

  check(go: GameObject): boolean {
    const info = go.getGOInfo();
    if (!info || info.type !== GAMEOBJECT_TYPE_SPELL_FOCUS) return false;

    if (!go.isSpawned()) return false; // xinef: dont allow to count deactivated objects

    if ((info.data[0] ?? 0) !== this.i_focusId) return false; // spellFocus.focusId

    const dist = info.data[1] ?? 0; // spellFocus.dist

    return go.isWithinDistInMap(this.i_caster, dist);
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::NearestGameObjectFishingHole (find the nearest Fishing hole and return true only if source object is in range of hole) */
export class NearestGameObjectFishingHole {
  constructor(
    private readonly i_obj: WorldObject,
    private i_range: number,
  ) {}

  check(go: GameObject): boolean {
    const info = go.getGOInfo();
    if (info && info.type === GAMEOBJECT_TYPE_FISHINGHOLE && go.isSpawned() && this.i_obj.isWithinDistInMap(go, this.i_range) && this.i_obj.isWithinDistInMap(go, info.data[0] ?? 0)) {
      this.i_range = this.i_obj.getDistance(go);
      return true;
    }
    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::NearestGameObjectCheck */
export class NearestGameObjectCheck {
  private i_range = 999;

  constructor(private readonly i_obj: WorldObject) {}

  check(go: GameObject): boolean {
    if (this.i_obj.isWithinDistInMap(go, this.i_range)) {
      this.i_range = this.i_obj.getDistance(go); // use found GO range as new range limit for next check
      return true;
    }
    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::NearestGameObjectEntryInObjectRangeCheck (success at unit in range, range update for next check (this can be use with GameobjectLastSearcher to find nearest GO)) */
export class NearestGameObjectEntryInObjectRangeCheck {
  constructor(
    private readonly i_obj: WorldObject,
    private readonly i_entry: number,
    private i_range: number,
    private readonly i_onlySpawned = false,
  ) {}

  check(go: GameObject): boolean {
    if (go.getEntry() === this.i_entry && this.i_obj.isWithinDistInMap(go, this.i_range) && (!this.i_onlySpawned || go.isSpawned())) {
      this.i_range = this.i_obj.getDistance(go); // use found GO range as new range limit for next check
      return true;
    }
    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::NearestGameObjectTypeInObjectRangeCheck */
export class NearestGameObjectTypeInObjectRangeCheck {
  constructor(
    private readonly i_obj: WorldObject,
    private readonly i_type: number,
    private i_range: number,
  ) {}

  check(go: GameObject): boolean {
    if (go.getGoType() === this.i_type && this.i_obj.isWithinDistInMap(go, this.i_range)) {
      this.i_range = this.i_obj.getDistance(go); // use found GO range as new range limit for next check
      return true;
    }
    return false;
  }
}

// Unit checks

type HealthCaps = { getHealth(): number; getMaxHealth(): number };
type CombatCaps = { isInCombat(): boolean };

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::MostHPMissingInRange */
export class MostHPMissingInRange {
  constructor(
    private readonly i_obj: Unit & ReactionCaps,
    private readonly i_range: number,
    private i_hp: number,
  ) {}

  check(u: Unit & CombatCaps & HealthCaps): boolean {
    if (u.isAlive() && u.isInCombat() && !this.i_obj.isHostileTo(u) && this.i_obj.isWithinDistInMap(u, this.i_range) && u.getMaxHealth() - u.getHealth() > this.i_hp) {
      this.i_hp = u.getMaxHealth() - u.getHealth();
      return true;
    }
    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::MostHPPercentMissingInRange */
export class MostHPPercentMissingInRange {
  private i_hpPct = 101.0;

  constructor(
    private readonly i_obj: Unit & ReactionCaps,
    private readonly i_range: number,
    private readonly i_minHpPct: number,
    private readonly i_maxHpPct: number,
  ) {}

  check(u: Unit & CombatCaps & { getHealthPct(): number }): boolean {
    if (
      u.isAlive() &&
      u.isInCombat() &&
      !this.i_obj.isHostileTo(u) &&
      this.i_obj.isWithinDistInMap(u, this.i_range) &&
      this.i_minHpPct <= u.getHealthPct() &&
      u.getHealthPct() <= this.i_maxHpPct &&
      u.getHealthPct() < this.i_hpPct
    ) {
      this.i_hpPct = u.getHealthPct();
      return true;
    }

    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::FriendlyCCedInRange */
export class FriendlyCCedInRange {
  constructor(
    private readonly i_obj: Unit & ReactionCaps,
    private readonly i_range: number,
  ) {}

  check(u: Unit & CombatCaps & { hasFearAura(): boolean; isCharmed(): boolean; isFrozen(): boolean }): boolean {
    if (
      u.isAlive() &&
      u.isInCombat() &&
      !this.i_obj.isHostileTo(u) &&
      this.i_obj.isWithinDistInMap(u, this.i_range) &&
      (u.hasFearAura() || u.isCharmed() || u.isFrozen() || u.hasUnitState(UNIT_STATE_STUNNED) || u.hasUnitState(UNIT_STATE_CONFUSED))
    ) {
      return true;
    }
    return false;
  }
}

/**
 * @ac game/Grids/Notifiers/GridNotifiers.h Acore::FriendlyMissingBuffInRange
 * @ac-skip `SpellMgr::GetSpellForDifficultyFromSpell`: spell difficulty variants are not ported, so the id stays.
 */
export class FriendlyMissingBuffInRange {
  private readonly i_spell: number;

  constructor(
    private readonly i_obj: Unit & ReactionCaps,
    private readonly i_range: number,
    spellid: number,
  ) {
    this.i_spell = spellid;
    const spell = sSpellMgr.getSpellInfo(spellid);
    if (spell) this.i_spell = spell.id;
  }

  check(u: Unit & CombatCaps & { hasAura(spellId: number, casterGUID?: bigint): boolean }): boolean {
    if (u.isAlive() && u.isInCombat() && !this.i_obj.isHostileTo(u) && this.i_obj.isWithinDistInMap(u, this.i_range) && !u.hasAura(this.i_spell)) {
      return true;
    }
    return false;
  }
}

type CritterCaps = { isCritter(): boolean };
type CreatureAoECaps = { isTotem(): boolean; isTrigger(): boolean; isAvoidingAOE(): boolean };

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyUnfriendlyUnitInObjectRangeCheck */
export class AnyUnfriendlyUnitInObjectRangeCheck {
  constructor(
    private readonly i_obj: WorldObject,
    private readonly i_funit: Unit & ReactionCaps,
    private readonly i_range: number,
  ) {}

  check(u: Unit & CritterCaps): boolean {
    const funitCreature = this.i_funit.toCreature() as (Creature & CreatureAoECaps) | null;
    if (u.isAlive() && !u.isCritter() && this.i_obj.isWithinDistInMap(u, this.i_range) && !this.i_funit.isFriendlyTo(u) && (!this.i_funit.isCreature() || !funitCreature!.isAvoidingAOE())) {
      // pussywizard
      return true;
    }
    return false;
  }
}

type TargetableCaps = { isTargetableForAttack(checkFakeDeath: boolean, byWho: Unit | null): boolean; getCreatureType(): number };

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyUnfriendlyNoTotemUnitInObjectRangeCheck */
export class AnyUnfriendlyNoTotemUnitInObjectRangeCheck {
  constructor(
    private readonly i_obj: WorldObject,
    private readonly i_funit: Unit & ReactionCaps,
    private readonly i_range: number,
  ) {}

  check(u: Unit & TargetableCaps): boolean {
    if (!u.isAlive()) return false;

    if (u.getCreatureType() === CREATURE_TYPE_NON_COMBAT_PET) return false;

    const creature = u.toCreature() as (Creature & CreatureAoECaps) | null;
    if (u.isCreature() && (creature!.isTotem() || creature!.isTrigger() || creature!.isAvoidingAOE())) return false; // pussywizard: added IsAvoidingAOE()

    if (!u.isTargetableForAttack(false, this.i_funit)) return false;

    return this.i_obj.isWithinDistInMap(u, this.i_range) && !this.i_funit.isFriendlyTo(u);
  }
}

type AttackValidCaps = { isValidAttackTarget(target: WorldObject): boolean; getCollisionHeight(): number };

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::NearestAttackableNoTotemUnitInObjectRangeCheck */
export class NearestAttackableNoTotemUnitInObjectRangeCheck {
  constructor(
    private readonly i_obj: WorldObject,
    private readonly i_owner: Unit & AttackValidCaps,
    private readonly i_range: number,
  ) {}

  check(u: Unit & TargetableCaps): boolean {
    if (!u.isAlive()) return false;

    if (u.getCreatureType() === CREATURE_TYPE_NON_COMBAT_PET) return false;

    if (u.isCreature() && (u.toCreature() as Creature & CreatureAoECaps).isTotem()) return false;

    if (!u.isTargetableForAttack(false, this.i_owner)) return false;

    let losChecks = LINEOFSIGHT_ALL_CHECKS;
    let collisionHeight: number | null = null;
    if (this.i_obj.isGameObject()) {
      losChecks &= ~LINEOFSIGHT_CHECK_GOBJECT_M2;
      collisionHeight = this.i_owner.getCollisionHeight();
    }

    if (
      !this.i_obj.isWithinDistInMap(u, this.i_range) ||
      !this.i_owner.isValidAttackTarget(u) ||
      !this.i_obj.isWithinLOSInMap(u, ModelIgnoreFlags.Nothing, losChecks, collisionHeight)
    ) {
      return false;
    }

    return true;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyUnfriendlyAttackableVisibleUnitInObjectRangeCheck */
export class AnyUnfriendlyAttackableVisibleUnitInObjectRangeCheck {
  constructor(
    private readonly i_funit: Unit & ReactionCaps & AttackValidCaps,
    private readonly i_range: number,
  ) {}

  check(u: Unit & CritterCaps & { isTotem(): boolean }): boolean {
    return (
      u.isAlive() &&
      this.i_funit.isWithinDistInMap(u, this.i_range) &&
      !this.i_funit.isFriendlyTo(u) &&
      this.i_funit.isValidAttackTarget(u) &&
      !u.isCritter() &&
      !u.isTotem() // xinef: dont attack totems
      /*&& i_funit->CanSeeOrDetect(u)*/ // pussywizard: already checked in IsValidAttackTarget(u)
    );
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyFriendlyUnitInObjectRangeCheck */
export class AnyFriendlyUnitInObjectRangeCheck {
  constructor(
    private readonly i_obj: WorldObject,
    private readonly i_funit: Unit & ReactionCaps,
    private readonly i_range: number,
    private readonly i_playerOnly = false,
  ) {}

  check(u: Unit): boolean {
    if (u.isAlive() && this.i_obj.isWithinDistInMap(u, this.i_range) && this.i_funit.isFriendlyTo(u) && (!this.i_playerOnly || u.isPlayer())) return true;
    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyFriendlyNotSelfUnitInObjectRangeCheck */
export class AnyFriendlyNotSelfUnitInObjectRangeCheck {
  constructor(
    private readonly i_obj: WorldObject,
    private readonly i_funit: Unit & ReactionCaps,
    private readonly i_range: number,
    private readonly i_playerOnly = false,
  ) {}

  check(u: Unit): boolean {
    if (u !== this.i_obj && u.isAlive() && this.i_obj.isWithinDistInMap(u, this.i_range) && this.i_funit.isFriendlyTo(u) && (!this.i_playerOnly || u.isPlayer())) return true;
    return false;
  }
}

type GroupCaps = { isInRaidWith(u: Unit): boolean; isInPartyWith(u: Unit): boolean };

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyGroupedUnitInObjectRangeCheck */
export class AnyGroupedUnitInObjectRangeCheck {
  constructor(
    private readonly _source: WorldObject,
    private readonly _refUnit: Unit & ReactionCaps & GroupCaps,
    private readonly _range: number,
    private readonly _raid: boolean,
  ) {}

  check(u: Unit & { isVehicle(): boolean }): boolean {
    if (u.isVehicle()) return false;

    if (this._raid) {
      if (!this._refUnit.isInRaidWith(u)) return false;
    } else if (!this._refUnit.isInPartyWith(u)) return false;

    return !this._refUnit.isHostileTo(u) && u.isAlive() && this._source.isWithinDistInMap(u, this._range);
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyUnitInObjectRangeCheck */
export class AnyUnitInObjectRangeCheck {
  constructor(
    private readonly i_obj: WorldObject,
    private readonly i_range: number,
  ) {}

  check(u: Unit): boolean {
    if (u.isAlive() && this.i_obj.isWithinDistInMap(u, this.i_range)) return true;

    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::NearestAttackableUnitInObjectRangeCheck (success at unit in range, range update for next check (this can be use with UnitLastSearcher to find nearest unit)) */
export class NearestAttackableUnitInObjectRangeCheck {
  constructor(
    private readonly i_obj: WorldObject,
    private readonly i_funit: Unit & { isInCombatWith(u: Unit): boolean },
    private i_range: number,
  ) {}

  check(u: Unit & TargetableCaps & ReactionCaps): boolean {
    if (
      u.isTargetableForAttack(true, this.i_funit) &&
      this.i_obj.isWithinDistInMap(u, this.i_range) &&
      (this.i_funit.isInCombatWith(u) || u.isHostileTo(this.i_funit)) &&
      this.i_obj.canSeeOrDetect(u)
    ) {
      this.i_range = this.i_obj.getDistance(u); // use found unit range as new range limit for next check
      return true;
    }

    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyAoETargetUnitInObjectRangeCheck */
export class AnyAoETargetUnitInObjectRangeCheck {
  private readonly i_targetForPlayer: boolean;
  private readonly _spellInfo: SpellInfo | null = null;

  constructor(
    private readonly i_obj: WorldObject,
    private readonly i_funit: Unit & { getOwner(): Unit | null; _IsValidAttackTarget(target: Unit, bySpell: SpellInfo | null, obj: WorldObject | null): boolean },
    private readonly i_range: number,
  ) {
    let check: Unit = i_funit;
    const owner = i_funit.getOwner();
    if (owner) check = owner;
    this.i_targetForPlayer = check.isPlayer();
    const dynObj = i_obj.toDynObject();
    if (dynObj) this._spellInfo = sSpellMgr.getSpellInfo(dynObj.getSpellId());
  }

  check(u: Unit): boolean {
    // Check contains checks for: live, non-selectable, non-attackable flags, flight check and GM check, ignore totems
    const creature = u.toCreature() as (Creature & CreatureAoECaps) | null;
    if (creature) {
      if (creature.isTotem()) return false;

      if (creature.isAvoidingAOE()) return false;
    }

    if (this.i_funit._IsValidAttackTarget(u, this._spellInfo, this.i_obj.isDynamicObject() ? this.i_obj : null) && this.i_obj.isWithinDistInMap(u, this.i_range, true, false, true)) {
      return true;
    }

    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyAttackableUnitExceptForOriginalCasterInObjectRangeCheck */
export class AnyAttackableUnitExceptForOriginalCasterInObjectRangeCheck {
  constructor(
    private readonly i_obj: WorldObject,
    private readonly i_funit: Unit,
    private readonly i_range: number,
  ) {}

  check(u: Unit & CombatCaps & { hasUnitFlag(flags: number): boolean; isImmuneToPC(): boolean }): boolean {
    if (!u.isAlive() || u.hasUnitFlag(UNIT_FLAG_NON_ATTACKABLE | UNIT_FLAG_NOT_SELECTABLE) || (u.isImmuneToPC() && !u.isInCombat())) return false;
    if (u.getGUID() === this.i_funit.getGUID()) return false;

    if (this.i_obj.isWithinDistInMap(u, this.i_range)) return true;

    return false;
  }
}

type AssistCaps = { canAssistTo(u: Unit, enemy: Unit, isOverride?: boolean): boolean };

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::CallOfHelpCreatureInRangeDo (do attack at call of help to friendly crearture) */
export class CallOfHelpCreatureInRangeDo {
  constructor(
    private readonly i_funit: Unit,
    private readonly i_enemy: Unit,
    private readonly i_range: number,
  ) {}

  do(u: Creature & AssistCaps & { setNoCallForHelp(no: boolean): void; engageWithTarget(who: Unit): void }): void {
    if (u === this.i_funit) return;

    if (!u.canAssistTo(this.i_funit, this.i_enemy, false)) return;

    // too far
    if (!u.isWithinDistInMap(this.i_funit, this.i_range)) return;

    // only if see assisted creature's enemy
    if (!u.isWithinLOSInMap(this.i_enemy)) return;

    u.setNoCallForHelp(true); // avoid recursive call for help causing stack overflow
    u.engageWithTarget(this.i_enemy);
    u.setNoCallForHelp(false);
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyDeadUnitCheck */
export class AnyDeadUnitCheck {
  check(u: Unit): boolean {
    return !u.isAlive();
  }
}

// Creature checks

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::NearestHostileUnitCheck */
export class NearestHostileUnitCheck {
  private m_range: number;

  constructor(
    private readonly me: Creature & AttackValidCaps,
    dist = 0,
    private readonly i_playerOnly = false,
  ) {
    this.m_range = dist === 0 ? 9999 : dist;
  }

  check(u: Unit): boolean {
    if (!this.me.isWithinDistInMap(u, this.m_range, true, false, false)) return false;

    if (!this.me.isValidAttackTarget(u)) return false;

    if (this.i_playerOnly && !u.isPlayer()) return false;

    this.m_range = this.me.getDistance(u); // use found unit range as new range limit for next check
    return true;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::NearestHostileUnitInAttackDistanceCheck */
export class NearestHostileUnitInAttackDistanceCheck {
  constructor(
    private readonly me: Creature & { canStartAttack(u: Unit, force?: boolean): boolean },
    private m_range: number,
  ) {}

  check(u: Unit): boolean {
    if (!this.me.isWithinDistInMap(u, this.m_range, true, false, false)) return false;

    if (!this.me.canStartAttack(u)) return false;

    this.m_range = this.me.getDistance(u); // use found unit range as new range limit for next check
    return true;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::NearestVisibleDetectableContestedGuardUnitCheck */
export class NearestVisibleDetectableContestedGuardUnitCheck {
  constructor(private readonly me: Unit) {}

  check(u: Unit & { isContestedGuard(): boolean }): boolean {
    if (!u.canSeeOrDetect(this.me, true, true, false)) return false;

    if (!u.isContestedGuard()) return false;

    return true;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyAssistCreatureInRangeCheck */
export class AnyAssistCreatureInRangeCheck {
  constructor(
    private readonly i_funit: Unit,
    private readonly i_enemy: Unit,
    private readonly i_range: number,
  ) {}

  check(u: Creature & AssistCaps): boolean {
    if (u === this.i_funit) return false;

    if (!u.canAssistTo(this.i_funit, this.i_enemy)) return false;

    // too far
    if (!this.i_funit.isWithinDistInMap(u, this.i_range)) return false;

    // only if see assisted creature
    if (!this.i_funit.isWithinLOSInMap(u)) return false;

    return true;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::NearestAssistCreatureInCreatureRangeCheck */
export class NearestAssistCreatureInCreatureRangeCheck {
  constructor(
    private readonly i_obj: Creature,
    private readonly i_enemy: Unit,
    private i_range: number,
  ) {}

  check(u: Creature & AssistCaps): boolean {
    if (u === this.i_obj) return false;
    if (!u.canAssistTo(this.i_obj, this.i_enemy)) return false;

    if (!this.i_obj.isWithinDistInMap(u, this.i_range)) return false;

    if (!this.i_obj.isWithinLOSInMap(u)) return false;

    this.i_range = this.i_obj.getDistance(u); // use found unit range as new range limit for next check
    return true;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::NearestCreatureEntryWithLiveStateInObjectRangeCheck (success at unit in range, range update for next check (this can be use with CreatureLastSearcher to find nearest creature)) */
export class NearestCreatureEntryWithLiveStateInObjectRangeCheck {
  constructor(
    private readonly i_obj: WorldObject,
    private readonly i_entry: number,
    private readonly i_alive: boolean,
    private i_range: number,
  ) {}

  check(u: Creature): boolean {
    if (u.getEntry() === this.i_entry && u.isAlive() === this.i_alive && this.i_obj.isWithinDist(u, this.i_range) && this.i_obj.inSamePhase(u)) {
      this.i_range = this.i_obj.getDistance(u); // use found unit range as new range limit for next check
      return true;
    }
    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyPlayerInObjectRangeCheck */
export class AnyPlayerInObjectRangeCheck implements SharedVisionCheck {
  constructor(
    private readonly _obj: WorldObject,
    private readonly _range: number,
    private readonly _reqAlive = true,
    private readonly _disallowGM = false,
  ) {}

  check(u: GridPlayer): boolean {
    if (this._reqAlive && !u.isAlive()) return false;

    if (this._disallowGM && (u.isGameMaster() || u.isSpectator())) return false;

    if (!this._obj.isWithinDistInMap(u, this._range)) return false;

    return true;
  }

  /** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyPlayerInObjectRangeCheck::operator() (`(Player*, bool checkRange)`; pussywizard: needed for DestroyForNearbyPlayers) */
  checkWithRange(u: GridPlayer, checkRange: boolean): boolean {
    if (checkRange && !this._obj.isWithinDistInMap(u, this._range)) return false;

    return true;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AnyPlayerExactPositionInGameObjectRangeCheck */
export class AnyPlayerExactPositionInGameObjectRangeCheck {
  constructor(
    private readonly _go: GameObject,
    private readonly _range: number,
  ) {}

  check(u: GridPlayer): boolean {
    if (!this._go.isInRange3d(u.getPositionX(), u.getPositionY(), u.getPositionZ(), this._range)) return false;

    return true;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::NearestPlayerInObjectRangeCheck */
export class NearestPlayerInObjectRangeCheck {
  constructor(
    private readonly i_obj: WorldObject,
    private i_range: number,
  ) {}

  check(u: GridPlayer): boolean {
    if (u.isAlive() && this.i_obj.isWithinDistInMap(u, this.i_range)) {
      this.i_range = this.i_obj.getDistance(u);
      return true;
    }

    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AllFriendlyCreaturesInGrid */
export class AllFriendlyCreaturesInGrid {
  constructor(private readonly unit: Unit) {}

  check(u: Unit & ReactionCaps & { isVisible(): boolean }): boolean {
    if (u.isAlive() && u.isVisible() && u.isFriendlyTo(this.unit)) return true;

    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AllGameObjectsWithEntryInRange */
export class AllGameObjectsWithEntryInRange {
  constructor(
    private readonly m_pObject: WorldObject,
    private readonly m_uiEntry: number,
    private readonly m_fRange: number,
  ) {}

  check(go: GameObject): boolean {
    if (go.getEntry() === this.m_uiEntry && this.m_pObject.isWithinDist(go, this.m_fRange, false)) return true;

    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AllGameObjectsMatchingOneEntryInRange */
export class AllGameObjectsMatchingOneEntryInRange {
  constructor(
    private readonly m_pObject: WorldObject,
    private readonly m_uiEntries: readonly number[],
    private readonly m_fRange: number,
  ) {}

  check(go: GameObject): boolean {
    if (this.m_uiEntries.some((entry) => go.getEntry() === entry) && this.m_pObject.isWithinDist(go, this.m_fRange, false)) return true;

    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AllCreaturesOfEntryInRange */
export class AllCreaturesOfEntryInRange {
  constructor(
    private readonly m_pObject: WorldObject,
    private readonly m_uiEntry: number,
    private readonly m_fRange: number,
  ) {}

  check(unit: Unit): boolean {
    if (unit.getEntry() === this.m_uiEntry && this.m_pObject.isWithinDist(unit, this.m_fRange, false)) return true;

    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AllCreaturesMatchingOneEntryInRange */
export class AllCreaturesMatchingOneEntryInRange {
  constructor(
    private readonly m_pObject: WorldObject,
    private readonly m_uiEntries: readonly number[],
    private readonly m_fRange: number,
  ) {}

  check(unit: Unit): boolean {
    if (this.m_uiEntries.some((entry) => unit.getEntry() === entry) && this.m_pObject.isWithinDist(unit, this.m_fRange, false)) return true;

    return false;
  }
}

type GroupLike = { isMember(guid: bigint): boolean };

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::MostHPMissingGroupInRange */
export class MostHPMissingGroupInRange {
  constructor(
    private readonly i_obj: Unit & ReactionCaps & { isPet(): boolean },
    private readonly i_range: number,
    private i_hp: number,
  ) {}

  check(u: Unit & HealthCaps & { isPet(): boolean; getOwner(): Unit | null }): boolean {
    if ((this.i_obj as Unit) === u) return false;

    let player: (GridPlayer & { getGroup(): GroupLike | null }) | null = null;
    if (u.isPlayer()) {
      player = u.toPlayer() as GridPlayer & { getGroup(): GroupLike | null };
    } else if (u.isPet() && u.getOwner()) {
      player = (u.getOwner()?.toPlayer() ?? null) as (GridPlayer & { getGroup(): GroupLike | null }) | null;
    }

    if (!player) return false;

    const group = player.getGroup();
    if (!group || !group.isMember(this.i_obj.isPet() ? this.i_obj.getOwnerGUID() : this.i_obj.getGUID())) return false;

    if (u.isAlive() && !this.i_obj.isHostileTo(u) && this.i_obj.isWithinDistInMap(u, this.i_range) && u.getMaxHealth() - u.getHealth() >= this.i_hp) {
      this.i_hp = u.getMaxHealth() - u.getHealth();
      return true;
    }

    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AllDeadCreaturesInRange */
export class AllDeadCreaturesInRange {
  constructor(
    private readonly _obj: WorldObject,
    private readonly _range: number,
    private readonly _reqAlive = true,
  ) {}

  check(unit: Unit): boolean {
    if (this._reqAlive && unit.isAlive()) return false;
    if (!this._obj.isWithinDistInMap(unit, this._range)) return false;
    return true;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::PlayerAtMinimumRangeAway */
export class PlayerAtMinimumRangeAway {
  constructor(
    private readonly unit: Unit,
    private readonly fRange: number,
  ) {}

  check(player: GridPlayer): boolean {
    // No threat list check, must be done explicit if expected to be in combat with creature
    if (!player.isGameMaster() && player.isAlive() && !this.unit.isWithinDist(player, this.fRange, false)) return true;

    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::GameObjectInRangeCheck */
export class GameObjectInRangeCheck {
  constructor(
    private readonly x: number,
    private readonly y: number,
    private readonly z: number,
    private readonly range: number,
    private readonly entry = 0,
  ) {}

  check(go: GameObject): boolean {
    if (!this.entry || go.getGOInfo()?.entry === this.entry) return go.isInRange3d(this.x, this.y, this.z, this.range);
    return false;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AllWorldObjectsInRange */
export class AllWorldObjectsInRange {
  constructor(
    private readonly m_pObject: WorldObject,
    private readonly m_fRange: number,
  ) {}

  check(go: WorldObject): boolean {
    return this.m_pObject.isWithinDist(go, this.m_fRange, false) && this.m_pObject.inSamePhase(go);
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::ObjectTypeIdCheck */
export class ObjectTypeIdCheck {
  constructor(
    private readonly _typeId: TypeID,
    private readonly _equals: boolean,
  ) {}

  check(object: WorldObject): boolean {
    return (object.getTypeId() === this._typeId) === this._equals;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::ObjectGUIDCheck */
export class ObjectGUIDCheck {
  constructor(
    private readonly _GUID: bigint,
    private readonly _equals: boolean,
  ) {}

  check(object: WorldObject): boolean {
    return (object.getGUID() === this._GUID) === this._equals;
  }
}

type AuraCaps = { hasAura(spellId: number, casterGUID?: bigint): boolean };

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::UnitAuraCheck (the `Unit const*` and `WorldObject const*` overloads) */
export class UnitAuraCheck {
  constructor(
    private readonly _present: boolean,
    private readonly _spellId: number,
    private readonly _casterGUID: bigint = ObjectGuid.Empty,
  ) {}

  check(object: WorldObject): boolean {
    const unit = object.toUnit() as (Unit & AuraCaps) | null;
    return unit !== null && unit.hasAura(this._spellId, this._casterGUID) === this._present;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::AllWorldObjectsInExactRange */
export class AllWorldObjectsInExactRange {
  constructor(
    private readonly _object: WorldObject,
    private readonly _range: number,
    private readonly _equals: boolean,
  ) {}

  check(object: WorldObject): boolean {
    return this._object.getExactDist2d(object) > this._range === this._equals;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::RandomCheck */
export class RandomCheck {
  constructor(private readonly _chance: number) {}

  check(_object: WorldObject): boolean {
    return rollChanceI(this._chance);
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::PowerCheck */
export class PowerCheck {
  constructor(
    private readonly _power: number,
    private readonly _equals: boolean,
  ) {}

  check(object: WorldObject): boolean {
    const unit = object.toUnit() as (Unit & { getPowerType(): number }) | null;
    return unit !== null && (unit.getPowerType() === this._power) === this._equals;
  }
}

/** @ac game/Grids/Notifiers/GridNotifiers.h Acore::RaidCheck */
export class RaidCheck {
  constructor(
    private readonly _compare: Unit,
    private readonly _equals: boolean,
  ) {}

  check(object: WorldObject): boolean {
    const unit = object.toUnit() as (Unit & GroupCaps) | null;
    return unit !== null && unit.isInRaidWith(this._compare) === this._equals;
  }
}

// Player checks and do

/**
 * @ac game/Grids/Notifiers/GridNotifiers.h Acore::LocalizedPacketDo
 * Prepare using Builder localized packets with caching and send to player. The builder returns the packet for a
 * locale (the C++ fills the `WorldPacket&` it is given).
 */
export class LocalizedPacketDo {
  /** 0 = default, i => i-1 locale index */
  private readonly i_data_cache: (WorldPacket | undefined)[] = [];

  constructor(private readonly i_builder: (loc_idx: number) => WorldPacket) {}

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::LocalizedPacketDo::operator() */
  do(p: GridPlayer): void {
    const loc_idx = p.getSession().getSessionDbLocaleIndex();
    const cache_idx = loc_idx + 1;
    let data = this.i_data_cache[cache_idx];

    // create if not cached yet
    if (!data) {
      data = this.i_builder(loc_idx);
      this.i_data_cache[cache_idx] = data;
    }

    p.sendDirectMessage(data);
  }
}

/**
 * @ac game/Grids/Notifiers/GridNotifiers.h Acore::LocalizedPacketListDo
 * Prepare using Builder localized packets with caching and send to player
 */
export class LocalizedPacketListDo {
  /** 0 = default, i => i-1 locale index */
  private readonly i_data_cache: (WorldPacket[] | undefined)[] = [];

  constructor(private readonly i_builder: (loc_idx: number) => WorldPacket[]) {}

  /** @ac game/Grids/Notifiers/GridNotifiersImpl.h Acore::LocalizedPacketListDo::operator() */
  do(p: GridPlayer): void {
    const loc_idx = p.getSession().getSessionDbLocaleIndex();
    const cache_idx = loc_idx + 1;
    let data_list = this.i_data_cache[cache_idx];

    // create if not cached yet
    if (!data_list || data_list.length === 0) {
      data_list = this.i_builder(loc_idx);
      this.i_data_cache[cache_idx] = data_list;
    }

    for (const data of data_list) p.sendDirectMessage(data);
  }
}

void WorldObject;
