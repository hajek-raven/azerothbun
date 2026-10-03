/**
 * The `Unit` and `Player` sides the grid layer calls, as structural interfaces with the C++ method names (camelCase).
 * `Entities/Unit` and `Entities/Player` are not ported as classes yet: `Creature` (`src/game/Entities/Creature`)
 * implements `UnitLike` with the state that exists, and the player facade that extends `WorldObject` implements
 * `GridPlayer`. When the real `Unit` / `Player` classes land they replace these two names.
 *
 * Methods the notifiers and checkers need only in some cases are not here; each checker in
 * `Notifiers/GridNotifiers.ts` declares its own capability intersection.
 */
import type { Corpse } from "../Entities/Corpse/Corpse.ts";
import type { WorldObject } from "../Entities/Object/Object.ts";
import type { PositionLike } from "../Entities/Object/Position.ts";
import type { UpdateData, WorldPacket } from "../Entities/Object/Updates/UpdateData.ts";

/** @ac game/Entities/Unit/Unit.h Unit (the members `WorldObject` and the grid notifiers call) */
export interface UnitLike extends WorldObject {
  /** @ac game/Entities/Unit/Unit.h Unit::IsAlive */
  isAlive(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::GetHoverHeight */
  getHoverHeight(): number;
  /** @ac game/Entities/Unit/Unit.h Unit::CanFly */
  canFly(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsInWater */
  isInWater(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::HasWaterWalkAura */
  hasWaterWalkAura(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::GetCharmerOrOwner */
  getCharmerOrOwner(): UnitLike | null;
  /** @ac game/Entities/Unit/Unit.h Unit::GetVehicleBase */
  getVehicleBase(): UnitLike | null;
  /** @ac game/Entities/Unit/Unit.h Unit::IsCharmedOwnedByPlayerOrPlayer */
  isCharmedOwnedByPlayerOrPlayer(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsInFlight */
  isInFlight(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::HasStealthAura */
  hasStealthAura(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::HasUnitState */
  hasUnitState(state: number): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::HasAuraTypeWithMiscvalue */
  hasAuraTypeWithMiscvalue(auraType: number, miscValue: number): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::HasUnitMovementFlag */
  hasUnitMovementFlag(f: number): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::IsWalking */
  isWalking(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::GetSpeed */
  getSpeed(mtype: number): number;
  /** @ac game/Entities/Unit/Unit.h Unit::m_last_notify_mstime */
  m_last_notify_mstime: number;
  /** @ac game/Entities/Unit/Unit.h Unit::m_delayed_unit_relocation_timer */
  m_delayed_unit_relocation_timer: number;
  /** @ac game/Entities/Unit/Unit.h Unit::m_delayed_unit_ai_notify_timer */
  m_delayed_unit_ai_notify_timer: number;
}

/** The session side of a player the grid layer reads (`WorldSession`). */
export interface GridPlayerSession {
  /** @ac game/Server/WorldSession.h WorldSession::GetSessionDbLocaleIndex */
  getSessionDbLocaleIndex(): number;
}

/** @ac game/Entities/Player/Player.h Player (the members the grid layer calls) */
export interface GridPlayer extends UnitLike {
  /** @ac game/Entities/Player/Player.h Player::m_seer */
  m_seer: WorldObject;
  /** @ac game/Entities/Player/Player.h Player::m_newVisible */
  m_newVisible: UnitLike[];
  /** @ac game/Entities/Player/Player.h Player::GetSession */
  getSession(): GridPlayerSession;
  /** @ac game/Entities/Player/Player.h Player::GetTeamId */
  getTeamId(): number;
  /** @ac game/Entities/Player/Player.h Player::IsGameMaster */
  isGameMaster(): boolean;
  /** @ac game/Entities/Player/Player.h Player::IsSpectator */
  isSpectator(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::isDead */
  isDead(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::GetHealth */
  getHealth(): number;
  /** @ac game/Entities/Player/Player.h Player::GetCorpse */
  getCorpse(): Corpse | null;
  /** @ac game/Entities/Player/Player.h Player::GetSightPosition */
  getSightPosition(): PositionLike;
  /** @ac game/Entities/Player/Player.h Player::GetFarSightDistance (the `Optional<float>`) */
  getFarSightDistance(): number | null;
  /** @ac game/Entities/Player/Player.cpp Player::IsGroupVisibleFor */
  isGroupVisibleFor(p: GridPlayer): boolean;
  /** @ac game/Entities/Player/Player.cpp Player::HaveAtClient (by object or by guid) */
  haveAtClient(u: WorldObject | bigint): boolean;
  /** @ac game/Entities/Player/Player.cpp Player::IsWorldObjectOutOfSightRange */
  isWorldObjectOutOfSightRange(target: WorldObject): boolean;
  /**
   * @ac game/Entities/Player/PlayerUpdates.cpp Player::UpdateVisibilityOf
   * `(WorldObject*)` sends the create or destroy right away; `(T*, UpdateData&, std::vector<Unit*>&)` queues it into
   * `data` and records new units in `visibleNow`.
   */
  updateVisibilityOf(target: WorldObject, data?: UpdateData, visibleNow?: UnitLike[]): void;
  /** @ac game/Entities/Player/PlayerUpdates.cpp Player::GetInitialVisiblePackets */
  getInitialVisiblePackets(target: UnitLike): void;
  /** @ac game/Entities/Player/Player.cpp Player::SendDirectMessage */
  sendDirectMessage(data: WorldPacket): void;
  /** @ac game/Entities/Unit/Unit.h Unit::HasSharedVision */
  hasSharedVision(): boolean;
  /** @ac game/Entities/Unit/Unit.h Unit::GetSharedVisionList */
  getSharedVisionList(): readonly GridPlayer[];
  /** @ac game/Entities/Unit/Unit.h Unit::GetVehicle (null while vehicles are not ported) */
  getVehicle(): object | null;
}
