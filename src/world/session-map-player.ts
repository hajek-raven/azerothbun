/**
 * @ac game/Entities/Player/Player.cpp Player (the map object of a player)
 * @ac game/Entities/Player/PlayerUpdates.cpp Player::UpdateVisibilityOf, UpdateVisibilityForPlayer, UpdateObjectVisibility
 * @ac game/Entities/Unit/Unit.cpp Unit::Update (the delayed relocation timer), Unit::ExecuteDelayedUnitRelocationEvent
 *
 * `SessionMapPlayer` is the `Player` the map layer works with: a `WorldObject` in a grid cell with a visibility container,
 * a seer, the new visible list, and the notify timers. The player's state (character row, stats, auras) stays on
 * `WorldSession`; this reads it through the session and sends what the grid notifiers produce through its packet path.
 *
 * Position: the object holds its own position (`Relocate`); the session writes both the character row and this on a
 * movement packet, a teleport, and at login.
 *
 * @ac-skip game/Entities/Player/PlayerUpdates.cpp Player::UpdateVisibilityOf: `BeforeVisibilityDestroy` (pets are not ported).
 * @ac-skip game/Entities/Player/PlayerUpdates.cpp Player::GetInitialVisiblePackets: `GetAurasForTarget` and
 * `SendMeleeAttackStart` of a unit that came into view (creature auras and attack starts go out with the combat packets).
 * @ac-skip game/Entities/Unit/Unit.cpp Unit::ExecuteDelayedUnitRelocationEvent: shared vision (`HasSharedVision`), the vehicle
 * seat, and `Unit::ExecuteDelayedUnitAINotifyEvent` (no creature AI is ported).
 * @ac-skip game/Entities/Player/Player.cpp Player::IsGroupVisibleFor: groups are not ported (`Visibility.GroupMode`).
 */
import { CHEAT_GOD, PLAYER_FLAGS_GHOST } from "../game/Entities/Player/PlayerDefines.ts";
import {
  GHOST_VISIBILITY_ALIVE,
  GHOST_VISIBILITY_GHOST,
  NOTIFY_AI_RELOCATION,
  NOTIFY_VISIBILITY_CHANGED,
  WorldObject,
} from "../game/Entities/Object/Object.ts";
import { MAX_VISIBILITY_DISTANCE } from "../game/Entities/Object/ObjectDefines.ts";
import { HighGuid, TYPEID_PLAYER, TYPEMASK_PLAYER, TYPEMASK_UNIT } from "../game/Entities/Object/ObjectGuid.ts";
import { Position, type PositionLike } from "../game/Entities/Object/Position.ts";
import { UpdateData, type WorldPacket } from "../game/Entities/Object/Updates/UpdateData.ts";
import type { Corpse } from "../game/Entities/Corpse/Corpse.ts";
import { VISIBILITY_DISTANCE_GIGANTIC } from "../game/Entities/Object/ObjectDefines.ts";
import { Cell } from "../game/Grids/Cells/Cell.ts";
import type { GridPlayer, GridPlayerSession, UnitLike } from "../game/Grids/GridPlayer.ts";
import { PlayerRelocationNotifier, VisibleNotifier } from "../game/Grids/Notifiers/GridNotifiers.ts";
import type { Map, MapPlayerExtras } from "../game/Maps/Map.ts";
import { MapReference } from "../game/Maps/MapReference.ts";
import { MAP_COMMON } from "../game/DataStores/MapDBCStores.ts";
import { DynamicVisibilityMgr } from "../game/Misc/DynamicVisibility.ts";
import { PLAYER_END } from "../gen/UpdateFields.gen.ts";
import { ChatHandler } from "../game/Chat/Chat.ts";
import { zlibCompress } from "../net/zlib.ts";
import { SMSG_UPDATE_OBJECT } from "./packets.ts";
import type { WorldSession } from "./session.ts";
import { SERVERSIDE_VISIBILITY_GHOST, SERVERSIDE_VISIBILITY_GM } from "../shared/SharedDefines.ts";
import { AddMovementGeneratorFactories } from "../game/AI/CreatureAIRegistry.ts";
import { LIQUID_MAP_ABOVE_WATER, MAP_LIQUID_STATUS_IN_CONTACT } from "../game/Grids/GridTerrainData.ts";
import type { AbstractFollower } from "../game/Movement/AbstractFollower.ts";
import { MotionMaster } from "../game/Movement/MotionMaster.ts";
import type { MovementOwner, MovementOwnerCreature } from "../game/Movement/MovementOwner.ts";
import { MoveSpline } from "../game/Movement/Spline/MoveSpline.ts";
import { DEFAULT_COMBAT_REACH } from "../game/Entities/Object/ObjectDefines.ts";
import { MOVEMENTFLAG_FALLING, MOVEMENTFLAG_MASK_MOVING, MOVEMENTFLAG_WALKING } from "../game/Entities/Unit/UnitDefines.ts";
import { UNIT_STATE_MOVING } from "../spells/enums.ts";

/** `SMSG_COMPRESSED_UPDATE_OBJECT` and the size above which an update goes out compressed (the old per packet limit). */
export const SMSG_COMPRESSED_UPDATE_OBJECT = 0x1f6;
export const MAX_UNCOMPRESSED_UPDATE = 24_000;

/** The first `uint32` of an `SMSG_UPDATE_OBJECT` body is its block count. */
function isEmptyUpdate(payload: Uint8Array): boolean {
  return payload.length < 4 || (payload[0]! | payload[1]! | payload[2]! | payload[3]!) === 0;
}

export class SessionMapPlayer extends WorldObject implements GridPlayer, MapPlayerExtras {
  /** @ac game/Entities/Player/Player.h Player::m_seer */
  m_seer: WorldObject = this;
  /** @ac game/Entities/Player/Player.h Player::m_newVisible */
  m_newVisible: UnitLike[] = [];
  /** @ac game/Entities/Unit/Unit.h Unit::m_last_notify_mstime */
  m_last_notify_mstime = 0;
  /** @ac game/Entities/Unit/Unit.h Unit::m_delayed_unit_relocation_timer */
  m_delayed_unit_relocation_timer = 0;
  /** @ac game/Entities/Unit/Unit.h Unit::m_delayed_unit_ai_notify_timer */
  m_delayed_unit_ai_notify_timer = 0;
  /** @ac game/Entities/Unit/Unit.h Unit::m_last_notify_position */
  readonly m_last_notify_position = new Position();
  /** @ac game/Entities/Unit/Unit.h Unit::bRequestForcedVisibilityUpdate */
  bRequestForcedVisibilityUpdate = false;
  /** @ac game/Entities/Player/Player.h Player::m_InstanceValid */
  m_InstanceValid = true;

  /** @ac game/Entities/Unit/Unit.h Unit::movespline (a player is moved by its client: the spline never runs) */
  readonly movespline = new MoveSpline();
  /** @ac game/Entities/Unit/Unit.h Unit::i_motionMaster (idle: charge, knockback and taxi flights are not ported) */
  private i_motionMaster: MotionMaster | null = null;
  /** @ac game/Entities/Unit/Unit.h Unit::m_followingMe */
  private readonly m_followingMe = new Set<AbstractFollower>();

  private readonly m_mapRef = new MapReference<GridPlayer & Partial<MapPlayerExtras>>();
  private created = false;
  private ghostVisibility = false;
  private gmVisibilityApplied = -1;
  private gmDetectApplied = -1;

  /** @ac game/Entities/Player/Player.cpp Player::Player */
  constructor(readonly session: WorldSession) {
    super();
    this.m_objectType |= TYPEMASK_PLAYER | TYPEMASK_UNIT;
    this.m_objectTypeId = TYPEID_PLAYER;
    this.m_valuesCount = PLAYER_END;
    this.getObjectVisibilityContainer().initForPlayer();
    this.m_last_notify_position.relocate(-5000.0, -5000.0, -5000.0, 0.0);
    this.syncIdentity();
  }

  /** `Player::Create` (guid, name) and the position of the character row. */
  syncIdentity(): void {
    const character = this.session.character;
    if (!character) return;
    if (!this.created) {
      this._CreateWorldObject(character.guid, HighGuid.Player, 1);
      this.created = true;
    }
    this.setName(character.name);
    this.relocate(character.position_x, character.position_y, character.position_z, character.orientation);
    this.syncServerSideVisibility();
  }

  // ------------------------------------------------------------------ identity (WorldObject)

  override getPhaseMask(): number {
    return this.session.playerFacade?.getPhaseMask() ?? 1;
  }

  override setPhaseMask(_newPhaseMask: number, _update: boolean): void {
    // the phase of a player is `SessionPlayer`'s (`.modify phase`, GM mode); it asks `updateObjectVisibility` itself
  }

  override isInWorld(): boolean {
    return super.isInWorld();
  }

  // ------------------------------------------------------------------ Unit members the grid layer reads

  isAlive(): boolean {
    return this.session.deathState === "alive" && this.session.health > 0;
  }

  getHoverHeight(): number {
    return 0;
  }

  canFly(): boolean {
    return this.session.playerFacade?.canFly() ?? false;
  }

  isInWater(): boolean {
    if (!this.findMap()) return false;
    return this.getMap().isInWater(this.getPhaseMask(), this.getPositionX(), this.getPositionY(), this.getPositionZ(), this.getCollisionHeight());
  }

  hasWaterWalkAura(): boolean {
    return this.session.unit?.hasAuraType(104 /* SPELL_AURA_WATER_WALK */) ?? false;
  }

  getCharmerOrOwner(): UnitLike | null {
    return null;
  }

  getVehicleBase(): UnitLike | null {
    return null;
  }

  isCharmedOwnedByPlayerOrPlayer(): boolean {
    return true;
  }

  isInFlight(): boolean {
    return this.session.playerFacade?.isInFlight() ?? false;
  }

  hasStealthAura(): boolean {
    return this.session.unit?.hasAuraType(16 /* SPELL_AURA_MOD_STEALTH */) ?? false;
  }

  hasUnitState(state: number): boolean {
    return this.session.unit?.hasUnitState(state) ?? false;
  }

  hasAuraTypeWithMiscvalue(auraType: number, miscValue: number): boolean {
    return (this.session.unit?.auraEffectsByType(auraType) ?? []).some((effect) => effect.miscValue === miscValue);
  }

  hasUnitMovementFlag(f: number): boolean {
    return (this.session.moveFlags & f) !== 0;
  }

  isWalking(): boolean {
    return (this.session.moveFlags & MOVEMENTFLAG_WALKING) !== 0;
  }

  getSpeed(mtype: number): number {
    return this.session.unit?.speed(mtype) ?? 7;
  }

  // ------------------------------------------------------------------ Unit movement members (what a chasing creature and `MotionMaster` call)

  /** @ac game/Entities/Unit/Unit.h Unit::GetMotionMaster (created idle on first use) */
  getMotionMaster(): MotionMaster {
    if (!this.i_motionMaster) {
      AddMovementGeneratorFactories();
      this.i_motionMaster = new MotionMaster(this as unknown as MovementOwner);
      this.i_motionMaster.initialize();
    }
    return this.i_motionMaster;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::FollowerAdded */
  followerAdded(f: AbstractFollower): void {
    this.m_followingMe.add(f);
  }

  /** @ac game/Entities/Unit/Unit.h Unit::FollowerRemoved */
  followerRemoved(f: AbstractFollower): void {
    this.m_followingMe.delete(f);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::RemoveAllFollowers */
  removeAllFollowers(): void {
    while (this.m_followingMe.size > 0) {
      const follower = this.m_followingMe.values().next().value as AbstractFollower;
      follower.setTarget(null);
    }
  }

  override removeFromWorld(): void {
    // Unit::RemoveFromWorld
    if (this.isInWorld()) this.removeAllFollowers();
    super.removeFromWorld();
  }

  /** @ac game/Entities/Unit/Unit.h Unit::isMoving */
  isMoving(): boolean {
    return (this.session.moveFlags & MOVEMENTFLAG_MASK_MOVING) !== 0;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsStopped */
  isStopped(): boolean {
    return !this.hasUnitState(UNIT_STATE_MOVING);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::StopMoving (@ac-skip Movement: a player stops by its client's packets; no spline runs) */
  stopMoving(): void {}

  /** @ac game/Entities/Unit/Unit.h Unit::IsFalling */
  isFalling(): boolean {
    return (this.session.moveFlags & MOVEMENTFLAG_FALLING) !== 0;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::IsClientControlled */
  isClientControlled(): boolean {
    return true;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetCombatReach (`Player::Create`: `DEFAULT_COMBAT_REACH`) */
  override getCombatReach(): number {
    return DEFAULT_COMBAT_REACH;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetBoundaryRadius (`DEFAULT_PLAYER_BOUNDING_RADIUS`) */
  getBoundaryRadius(): number {
    return 0.388999998569489;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetFollowAngle */
  getFollowAngle(): number {
    return Math.PI / 2;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::GetMeleeRange */
  getMeleeRange(target: { getCombatReach(): number }): number {
    const range = Math.fround(this.getCombatReach() + target.getCombatReach() + 4.0 / 3.0);
    return Math.max(range, 5.0 /* NOMINAL_MELEE_RANGE */);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::GetMeleeAttackPoint (@ac-skip Combat: `getAttackers()` is not tracked, so there is never a second attacker) */
  getMeleeAttackPoint(_attacker: unknown): null {
    return null;
  }

  /** @ac game/Entities/Unit/Unit.h Unit::GetVictim (the creature the combat world has this player attack) */
  getVictim(): MovementOwner | null {
    const guid = this.session.character?.guid;
    return guid === undefined ? null : (this.session.combat?.victimObjectOf(guid) ?? null);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::isInAccessiblePlaceFor */
  isInAccessiblePlaceFor(c: MovementOwnerCreature): boolean {
    // @ac-skip Maps: the Ring of Valor and Icecrown Citadel branches
    if (c.getTransport() !== this.getTransport()) return false;

    const liquidStatus = this.getLiquidData().Status;
    const isInWater = (liquidStatus & MAP_LIQUID_STATUS_IN_CONTACT) !== 0;

    // In water or jumping in water
    if (isInWater || (liquidStatus === LIQUID_MAP_ABOVE_WATER && this.isFalling())) return c.canEnterWater();
    return c.canWalk() || c.canFly();
  }

  // ------------------------------------------------------------------ Player members the grid layer reads

  /** @ac game/Entities/Player/Player.h Player::GetSession */
  getSession(): GridPlayerSession {
    return this.session;
  }

  /** @ac game/Entities/Player/Player.h Player::GetTeamId */
  getTeamId(): number {
    return this.session.playerFacade?.getTeamId() ?? 0;
  }

  /** @ac game/Entities/Player/Player.h Player::IsGameMaster */
  isGameMaster(): boolean {
    return this.session.playerFacade?.isGameMaster() ?? false;
  }

  isSpectator(): boolean {
    return false;
  }

  isDead(): boolean {
    return !this.isAlive();
  }

  getHealth(): number {
    return this.session.health;
  }

  /** @ac game/Entities/Player/Player.h Player::GetCorpse (corpses are rows of `corpse`; the map does not hold one for a player) */
  getCorpse(): Corpse | null {
    return null;
  }

  /** @ac game/Entities/Player/Player.h Player::GetSightPosition */
  getSightPosition(): PositionLike {
    return this.m_seer.isInWorld() ? this.m_seer : this;
  }

  /** @ac game/Entities/Player/Player.h Player::GetFarSightDistance (no far sight) */
  getFarSightDistance(): number | null {
    return null;
  }

  isGroupVisibleFor(_p: GridPlayer): boolean {
    return false;
  }

  /** @ac game/Entities/Player/Player.cpp Player::HaveAtClient (by object or by guid) */
  haveAtClient(u: WorldObject | bigint): boolean {
    const guid = typeof u === "bigint" ? u : u.getGUID();
    return guid === this.getGUID() || (this.getObjectVisibilityContainer().getVisibleWorldObjectsMap()?.has(guid) ?? false);
  }

  /** @ac game/Entities/Player/Player.cpp Player::IsWorldObjectOutOfSightRange */
  isWorldObjectOutOfSightRange(target: WorldObject): boolean {
    return !this.m_seer.isWithinDist(target, this.getSightRange(target), false);
  }

  /** @ac game/Entities/Player/PlayerUpdates.cpp Player::UpdateVisibilityOf (both forms) */
  updateVisibilityOf(target: WorldObject, data?: UpdateData, visibleNow?: UnitLike[]): void {
    if (data && visibleNow) {
      // the template form: queue into `data`
      this.getMap().addObjectToPendingUpdateList(target);

      if (this.haveAtClient(target)) {
        if (!this.canSeeOrDetect(target, false, true)) {
          target.buildOutOfRangeUpdateBlock(data);
          this.getObjectVisibilityContainer().unlinkWorldObjectVisibility(target);
        }
      } else if (this.canSeeOrDetect(target, false, true)) {
        target.buildCreateUpdateBlockForPlayer(data, this);
        this.getObjectVisibilityContainer().linkWorldObjectVisibility(target);
        if (target.isCreature() || target.isPlayer()) visibleNow.push(target as unknown as UnitLike);
      }
      return;
    }

    if (this.haveAtClient(target)) {
      if (!this.canSeeOrDetect(target, false, true)) {
        target.destroyForPlayer(this);
        this.getObjectVisibilityContainer().unlinkWorldObjectVisibility(target);
      }
    } else if (this.canSeeOrDetect(target, false, true)) {
      // Object::SendUpdateToPlayer
      const update = new UpdateData();
      target.buildCreateUpdateBlockForPlayer(update, this);
      if (update.hasData()) this.sendDirectMessage(update.buildPacket());
      this.getObjectVisibilityContainer().linkWorldObjectVisibility(target);

      // target aura duration for caster show only if target exist at caster client send data at target visibility change (adding to client)
      if (target.isUnit()) this.getInitialVisiblePackets(target as unknown as UnitLike);
    }
  }

  /** @ac game/Entities/Player/PlayerUpdates.cpp Player::GetInitialVisiblePackets */
  getInitialVisiblePackets(_target: UnitLike): void {
    // @ac-skip GetAurasForTarget / SendMeleeAttackStart (see the file header)
  }

  /** @ac game/Entities/Player/Player.cpp Player::SendDirectMessage */
  sendDirectMessage(data: WorldPacket): void {
    // `Map::SendInitSelf` builds the self block that the login burst already carries: an update without blocks is not sent
    if (data.opcode === SMSG_UPDATE_OBJECT && isEmptyUpdate(data.payload)) return;
    // `UpdateData::BuildPacket` compresses every update above 100 bytes; here only the large ones (a burst of creatures), as
    // `SMSG_COMPRESSED_UPDATE_OBJECT`: the uncompressed size, then the zlib stream
    if (data.opcode === SMSG_UPDATE_OBJECT && data.payload.length > MAX_UNCOMPRESSED_UPDATE) {
      const stream = zlibCompress(data.payload);
      const body = new Uint8Array(4 + stream.length);
      new DataView(body.buffer).setUint32(0, data.payload.length, true);
      body.set(stream, 4);
      this.session.sendPacket(SMSG_COMPRESSED_UPDATE_OBJECT, body);
      return;
    }
    this.session.sendPacket(data.opcode, data.payload);
  }

  hasSharedVision(): boolean {
    return false;
  }

  getSharedVisionList(): readonly GridPlayer[] {
    return [];
  }

  getVehicle(): null {
    return null;
  }

  // ------------------------------------------------------------------ MapPlayerExtras

  getMapRef(): MapReference<GridPlayer & Partial<MapPlayerExtras>> {
    return this.m_mapRef;
  }

  getViewpoint(): WorldObject | null {
    return null;
  }

  isBeingTeleportedFar(): boolean {
    return this.session.pendingTeleport?.far === true;
  }

  teleportTo(mapid: number, x: number, y: number, z: number, orientation: number): boolean {
    return this.session.playerFacade?.teleportTo(mapid, x, y, z, orientation) ?? false;
  }

  homebind(): { mapId: number; x: number; y: number; z: number } {
    const home = this.session.playerFacade?.getHomebind();
    return home ?? { mapId: 0, x: 0, y: 0, z: 0 };
  }

  teleportToEntryPoint(): void {
    // @ac-skip Player::TeleportToEntryPoint (the entry point of an instance is `m_entryPointData`; instances are not ported)
    const home = this.session.playerFacade?.getHomebind();
    if (home) this.session.playerFacade?.teleportTo(home.mapId, home.x, home.y, home.z, this.getOrientation());
  }

  sendSystemMessage(text: string): void {
    new ChatHandler(this.session).sendSysMessage(text);
  }

  getBattlegroundId(): number {
    return 0;
  }

  getDifficulty(_isRaid: boolean): number {
    return 0;
  }

  hasSpiritOfRedemptionAura(): boolean {
    return false;
  }

  sendTransferAborted(mapid: number, reason: number, arg = 0): void {
    // `WorldSession::SendTransferAborted`: `SMSG_TRANSFER_ABORTED` (u32 map, u8 reason, u8 arg)
    const body = new Uint8Array(6);
    new DataView(body.buffer).setUint32(0, mapid, true);
    body[4] = reason & 0xff;
    body[5] = arg & 0xff;
    this.session.sendPacket(0x18f /* SMSG_TRANSFER_ABORTED */, body);
  }

  removeMeFromThreatLists(): void {
    this.session.combat?.removePlayer(this.session.character?.guid ?? 0);
  }

  getAurasForTarget(_target: GridPlayer, _force: boolean): void {
    // the login burst sends the player's own auras (`SMSG_AURA_UPDATE_ALL`)
  }

  getGroup(): null {
    return null;
  }

  override getTransport(): null {
    return null;
  }

  // ------------------------------------------------------------------ visibility

  /** @ac game/Entities/Player/PlayerUpdates.cpp Player::UpdateObjectVisibility */
  override updateObjectVisibility(forced = true, fromUpdate = false): void {
    // Prevent updating visibility if player is not in world (example: LoadFromDB sets drunkstate which updates invisibility while player is not in map)
    if (!this.isInWorld()) return;

    if (!forced) this.addToNotify(NOTIFY_VISIBILITY_CHANGED);
    else {
      if (!fromUpdate) {
        // pussywizard:
        this.bRequestForcedVisibilityUpdate = true;
        return;
      }
      // Unit::UpdateObjectVisibility(true): the others see the change of this player
      super.updateObjectVisibility(true);
      this.updateVisibilityForPlayer();
    }
  }

  /** @ac game/Entities/Player/PlayerUpdates.cpp Player::UpdateVisibilityForPlayer */
  updateVisibilityForPlayer(mapChange = false): void {
    // After added to map seer must be a player - there is no possibility to still have different seer (all charm auras must be already removed)
    if (mapChange && this.m_seer !== this) this.m_seer = this;

    const sight = this.getSightPosition();
    const notifier = new VisibleNotifier(this, mapChange);
    Cell.visitObjects(sight.getPositionX(), sight.getPositionY(), this.getMap(), notifier, this.getSightRange());
    Cell.visitFarVisibleObjects(sight.getPositionX(), sight.getPositionY(), this.getMap(), notifier, VISIBILITY_DISTANCE_GIGANTIC);
    notifier.sendToSelf();

    // the view is up to date at this place: a later move is measured from here (a deviation, so that returning to the place of
    // the last relocation event after a forced update is not skipped)
    if (mapChange) this.m_last_notify_position.relocate(-5000.0, -5000.0, -5000.0, 0.0);
    else this.m_last_notify_position.relocate(this.getPositionX(), this.getPositionY(), this.getPositionZ());
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::ExecuteDelayedUnitRelocationEvent (the player part) */
  executeDelayedUnitRelocationEvent(): void {
    this.removeFromNotify(NOTIFY_VISIBILITY_CHANGED);
    if (!this.isInWorld()) return;

    const viewPoint: WorldObject = this.m_seer.isInWorld() ? this.m_seer : this;
    if (viewPoint.getMapId() !== this.getMapId()) return;

    if (!this.getFarSightDistance()) {
      const dx = this.m_last_notify_position.getPositionX() - this.getPositionX();
      const dy = this.m_last_notify_position.getPositionY() - this.getPositionY();
      const dz = this.m_last_notify_position.getPositionZ() - this.getPositionZ();
      const distsq = dx * dx + dy * dy + dz * dz;

      const mindistsq = DynamicVisibilityMgr.GetReqMoveDistSq(this.getMap().getEntry()?.map_type ?? MAP_COMMON);
      if (distsq < mindistsq) return;

      this.m_last_notify_position.relocate(this.getPositionX(), this.getPositionY(), this.getPositionZ());
    }

    this.theMap().loadGridsInRange(this, MAX_VISIBILITY_DISTANCE);

    const sight = this.getSightPosition();
    const notifier = new PlayerRelocationNotifier(this);
    Cell.visitObjects(sight.getPositionX(), sight.getPositionY(), this.getMap(), notifier, this.getSightRange());
    Cell.visitFarVisibleObjects(sight.getPositionX(), sight.getPositionY(), this.getMap(), notifier, VISIBILITY_DISTANCE_GIGANTIC);
    notifier.sendToSelf();

    this.addToNotify(NOTIFY_AI_RELOCATION);
  }

  /**
   * `Map::Update` → `Player::Update` for the part that is the map's: `Unit::Update`'s delayed relocation timer, and the forced
   * visibility update of `Player::Update`. The session ticks the rest of the player (`WorldSession.update`). The ghost and GM
   * visibility values follow the session's state here.
   */
  override update(diff: number): void {
    if (!this.isInWorld()) return;
    this.syncServerSideVisibility();

    // pussywizard:
    if (!this.isBeingTeleportedFar() && !this.bRequestForcedVisibilityUpdate) {
      if (this.m_delayed_unit_relocation_timer) {
        if (this.m_delayed_unit_relocation_timer <= diff) {
          this.m_delayed_unit_relocation_timer = 0;
          this.theMap().i_objectsForDelayedVisibility.add(this);
        } else this.m_delayed_unit_relocation_timer -= diff;
      }
      // @ac-skip m_delayed_unit_ai_notify_timer: ExecuteDelayedUnitAINotifyEvent (no creature AI)
      this.m_delayed_unit_ai_notify_timer = 0;
    }

    if (!this.isBeingTeleportedFar() && this.bRequestForcedVisibilityUpdate) {
      this.bRequestForcedVisibilityUpdate = false;
      this.updateObjectVisibility(true, true);
      this.m_delayed_unit_relocation_timer = 0;
      this.removeFromNotify(NOTIFY_VISIBILITY_CHANGED);
    }
  }

  /**
   * The `SERVERSIDE_VISIBILITY_GM` and `SERVERSIDE_VISIBILITY_GHOST` values (`Player::SetServerSideVisibility`, the ghost aura):
   * a hidden GM is seen by its security level and above, a GM detects up to its security; a ghost is seen by ghosts only and
   * sees ghosts and the living. A change shows to the others right away.
   */
  syncServerSideVisibility(): void {
    const facade = this.session.playerFacade;
    if (!facade) return;
    let changed = false;

    const gmVisibility = facade.gmVisibilityLevel();
    if (gmVisibility !== this.gmVisibilityApplied) {
      this.m_serverSideVisibility.setValue(SERVERSIDE_VISIBILITY_GM, gmVisibility);
      this.gmVisibilityApplied = gmVisibility;
      changed = true;
    }
    const gmDetect = facade.gmDetectLevel();
    if (gmDetect !== this.gmDetectApplied) {
      this.m_serverSideVisibilityDetect.setValue(SERVERSIDE_VISIBILITY_GM, gmDetect);
      this.gmDetectApplied = gmDetect;
      changed = true;
    }

    const ghost = ((this.session.character?.playerFlags ?? 0) & PLAYER_FLAGS_GHOST) !== 0;
    if (ghost !== this.ghostVisibility) {
      this.ghostVisibility = ghost;
      if (ghost) {
        this.m_serverSideVisibility.setValue(SERVERSIDE_VISIBILITY_GHOST, GHOST_VISIBILITY_GHOST);
        this.m_serverSideVisibilityDetect.setValue(SERVERSIDE_VISIBILITY_GHOST, GHOST_VISIBILITY_GHOST);
      } else {
        this.m_serverSideVisibility.setValue(SERVERSIDE_VISIBILITY_GHOST, GHOST_VISIBILITY_ALIVE | GHOST_VISIBILITY_GHOST);
        this.m_serverSideVisibilityDetect.setValue(SERVERSIDE_VISIBILITY_GHOST, GHOST_VISIBILITY_ALIVE);
      }
      changed = true;
    }

    if (changed && this.isInWorld()) this.updateObjectVisibility(true);
  }

  // ------------------------------------------------------------------ misc WorldObject queries

  override getCollisionHeight(): number {
    return this.session.unit?.collisionHeight() ?? 2.03128;
  }

  override getObjectSize(): number {
    return 0.389;
  }

  /** `CHEAT_GOD` (a god mode GM) is not hit by environmental damage; the map layer does not need it. */
  isGod(): boolean {
    return this.session.playerFacade?.getCommandStatus(CHEAT_GOD) ?? false;
  }

  /** `GetMap()` as the whole `Map` (the player is always on one). */
  theMap(): Map {
    return this.getMap() as unknown as Map;
  }
}
