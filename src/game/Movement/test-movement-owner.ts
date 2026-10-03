/**
 * Test helper: a fake `Map` and a fake `Unit` that satisfy `MovementOwner` / `MovementOwnerCreature` / `MovementOwnerPlayer`
 * over the real `MoveSpline` / `MoveSplineInit` / `PathGenerator` (no nav mesh: a path is the two point shortcut), so the
 * movement generators and `MotionMaster` run unchanged. `advance(diff)` is `Unit::UpdateSplineMovement` followed by
 * `MotionMaster::UpdateMotion`, the two calls `Unit::Update` makes.
 */
import { Vector3 } from "../../math/Vector3.ts";
import { UNIT_STATE_MOVING } from "../../spells/enums.ts";
import { ObjectGuid } from "../Entities/Object/ObjectGuid.ts";
import { NormalizeOrientation, Position, type PositionLike } from "../Entities/Object/Position.ts";
import { MOVE_RUN, MOVE_WALK, MOVEMENTFLAG_FORWARD, MOVEMENTFLAG_WALKING } from "../Entities/Unit/UnitDefines.ts";
import { AddMovementGeneratorFactories } from "../AI/CreatureAIRegistry.ts";
import type { FloatRef } from "../Grids/MapLike.ts";
import { IDLE_MOTION_TYPE, MotionMaster } from "./MotionMaster.ts";
import type { AbstractFollower } from "./AbstractFollower.ts";
import type {
  MovementCreatureAI,
  MovementMap,
  MovementObject,
  MovementOwner,
  MovementOwnerCombatManager,
  MovementOwnerCreature,
  MovementOwnerCreatureMovementData,
  MovementOwnerMovementInfo,
  MovementOwnerPlayer,
  MovementOwnerPlayerTaxi,
} from "./MovementOwner.ts";
import { MoveSpline } from "./Spline/MoveSpline.ts";
import { MoveSplineInit, SelectSpeedType } from "./Spline/MoveSplineInit.ts";
import type { CreatureGroup } from "../Entities/Creature/CreatureGroups.ts";
import type { FactionTemplateEntry } from "../../gen/DBCStructure.gen.ts";
import type { dtNavMesh } from "../../common/Detour/DetourNavMesh.ts";
import type { dtNavMeshQuery } from "../../common/Detour/DetourNavMeshQuery.ts";

/** What the fake map records or answers. */
export interface FakeMapOptions {
  /** `Map::GetHeight`: the ground under `(x, y)` (default `z`). */
  ground?: (x: number, y: number, z: number) => number;
  /** `Map::isInLineOfSight` (default true). */
  los?: (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) => boolean;
  /** `Map::IsInWater` (default false). */
  water?: (x: number, y: number, z: number) => boolean;
  /** `Map::CanReachPositionAndGetValidCoords` (default true, `dest` untouched). */
  canReach?: (dest: { x: number; y: number; z: number }) => boolean;
  /** The nav mesh and its query (`MMapData`); none means `PathGenerator` builds the two point shortcut. */
  navMesh?: dtNavMesh | null;
  query?: dtNavMeshQuery | null;
}

export class FakeMap implements MovementMap {
  readonly scripts: { id: number }[] = [];
  readonly loadedGrids: [number, number][] = [];
  /** `Map::CreatureGroupHolder` and the creature respawn times (`Map::GetCreatureRespawnTime`). */
  readonly CreatureGroupHolder = new Map<number, unknown>();
  readonly respawnTimes = new Map<number, number>();

  constructor(
    readonly id = 0,
    readonly opts: FakeMapOptions = {},
  ) {}

  getId(): number {
    return this.id;
  }
  isBattlegroundOrArena(): boolean {
    return false;
  }
  getMapCollisionData() {
    return { getMMapData: () => ({ getNavMesh: () => this.opts.navMesh ?? null, getNavMeshQuery: () => this.opts.query ?? null }) };
  }
  getLiquidData() {
    return { Status: 0, Flags: 0 };
  }
  isInWater(_phaseMask: number, x: number, y: number, z: number): boolean {
    return this.opts.water?.(x, y, z) ?? false;
  }
  isInLineOfSight(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): boolean {
    return this.opts.los?.(x1, y1, z1, x2, y2, z2) ?? true;
  }
  getHeight(_phasemask: number, x: number, y: number, z: number): number {
    return this.opts.ground?.(x, y, z) ?? z;
  }
  canReachPositionAndGetValidCoords(_source: MovementObject, dest: { x: number; y: number; z: number }): boolean {
    return this.opts.canReach?.(dest) ?? true;
  }
  scriptsStart(_scripts: unknown, id: number): void {
    this.scripts.push({ id });
  }
  getCreatureRespawnTime(dbGuid: number): number {
    return this.respawnTimes.get(dbGuid) ?? 0;
  }
  saveCreatureRespawnTime(spawnId: number, respawnTime: number): number {
    this.respawnTimes.set(spawnId, respawnTime);
    return respawnTime;
  }
  loadGrid(x: number, y: number): void {
    this.loadedGrids.push([x, y]);
  }
}

/** A recording creature AI: every movement hook call is a line `Name(args)` in `calls`. */
export class RecordingAI implements MovementCreatureAI {
  readonly calls: string[] = [];
  MoveInLineOfSight_Safe(): void {}
  TriggerAlert(): void {}
  MovementInform(type: number, id: number): void {
    this.calls.push(`MovementInform(${type},${id})`);
  }
  SummonMovementInform(_creature: MovementOwnerCreature, type: number, id: number): void {
    this.calls.push(`SummonMovementInform(${type},${id})`);
  }
  JustReachedHome(): void {
    this.calls.push("JustReachedHome()");
  }
  WaypointPathStarted(pathId: number): void {
    this.calls.push(`WaypointPathStarted(${pathId})`);
  }
  WaypointStarted(nodeId: number, pathId: number): void {
    this.calls.push(`WaypointStarted(${nodeId},${pathId})`);
  }
  WaypointReached(nodeId: number, pathId: number): void {
    this.calls.push(`WaypointReached(${nodeId},${pathId})`);
  }
  PathEndReached(pathId: number): void {
    this.calls.push(`PathEndReached(${pathId})`);
  }
  WaypointPathEnded(nodeId: number, pathId: number): void {
    this.calls.push(`WaypointPathEnded(${nodeId},${pathId})`);
  }
  DistancingStarted(): void {
    this.calls.push("DistancingStarted()");
  }
  DistancingEnded(): void {
    this.calls.push("DistancingEnded()");
  }
  AttackStart(): void {
    this.calls.push("AttackStart()");
  }
  EnterEvadeMode(): void {
    this.calls.push("EnterEvadeMode()");
  }
}

export interface FakeUnitOptions {
  guid?: bigint;
  /** a player (`IsPlayer()`), else a creature */
  player?: boolean;
  map?: FakeMap;
  pos?: [number, number, number];
  orientation?: number;
  entry?: number;
  spawnId?: number;
  wanderDistance?: number;
  defaultMovementType?: number;
  flags?: number;
  canFly?: boolean;
  canWalk?: boolean;
  canEnterWater?: boolean;
  combatReach?: number;
  ai?: boolean;
}

let nextGuid = 100n;

/**
 * One class for creature and player: `isPlayer()` tells which. `toCreature()` / `toPlayer()` return `this` for the right
 * kind. The `Unit` state that the generators set (`unitState`, `unitFlags`, movement flags) is real state; everything the
 * AI, combat and the map would own is a field the tests set.
 */
export class FakeUnit implements Omit<MovementOwner, "toCreature" | "toPlayer" | "toUnit" | "getMap" | "findMap" | "m_movementInfo"> {
  readonly guid: bigint;
  readonly kind: "creature" | "player";
  readonly map: FakeMap;
  x: number;
  y: number;
  z: number;
  o: number;
  entry: number;
  spawnId: number;
  wanderDistance: number;
  defaultMovementType: number;
  unitState = 0;
  unitFlags = 0;
  alive = true;
  inWorld = true;
  inCombat = false;
  engaged = false;
  victim: FakeUnit | null = null;
  targetGuid = 0n;
  charmerOrOwner: FakeUnit | null = null;
  summoner: FakeUnit | null = null;
  _moveState = 0;
  canFlyValue: boolean;
  canWalkValue: boolean;
  canEnterWaterValue: boolean;
  combatReachValue: number;
  hoverHeight = 0;
  walking = false;
  movementPreventedByCasting = false;
  readonly speeds: Record<number, number> = { [MOVE_WALK]: 2.5, [MOVE_RUN]: 7, 2: 4.5, 3: 4.722222, 4: 2.5, 6: 7, 7: 4.5 };
  readonly movespline = new MoveSpline();
  readonly sent: { opcode: number; payload: Uint8Array }[] = [];
  readonly log: string[] = [];
  readonly followers = new Set<AbstractFollower>();
  readonly motionMaster: MotionMaster;
  readonly recordingAI: RecordingAI | null;
  homePosition = new Position();
  formation: CreatureGroup | null = null;
  waypointId = 0;
  currentWaypointInfo: [number, number] = [0, 0];
  reactState = 2;
  cannotReachTarget = 0n;
  movementTemplate: MovementOwnerCreatureMovementData = { getRandom: () => 0, getChase: () => 0 };
  creatureData: { currentwaypoint: number } | null = null;
  waypointPath = 0;
  attackTime = 2000;
  standState = 0;
  fallInformation: [number, number] | null = null;
  readonly units = new Map<bigint, FakeUnit>();
  readonly taxi = { path: [] as number[], cleared: 0, next: 0 };
  money = 1000;
  evadeStates: number[] = [];
  readonly followAngle = 0;
  teleports: [number, number, number, number][] = [];

  private readonly info: MovementOwnerMovementInfo & { flags: number };

  constructor(opts: FakeUnitOptions = {}) {
    this.guid = opts.guid ?? nextGuid++;
    this.kind = opts.player ? "player" : "creature";
    this.map = opts.map ?? new FakeMap();
    const pos = opts.pos ?? [0, 0, 0];
    this.x = pos[0];
    this.y = pos[1];
    this.z = pos[2];
    this.o = opts.orientation ?? 0;
    this.entry = opts.entry ?? 1;
    this.spawnId = opts.spawnId ?? 0;
    this.wanderDistance = opts.wanderDistance ?? 0;
    this.defaultMovementType = opts.defaultMovementType ?? IDLE_MOTION_TYPE;
    this.canFlyValue = opts.canFly ?? false;
    this.canWalkValue = opts.canWalk ?? true;
    this.canEnterWaterValue = opts.canEnterWater ?? false;
    this.combatReachValue = opts.combatReach ?? 1.5;
    this.recordingAI = opts.ai === false || opts.player ? null : new RecordingAI();
    this.homePosition.relocate(this.x, this.y, this.z, this.o);
    const self = this;
    this.info = {
      flags: opts.flags ?? 0,
      transport: { pos: { getPositionX: () => 0, getPositionY: () => 0, getPositionZ: () => 0, getOrientation: () => 0 } },
      getMovementFlags() {
        return this.flags;
      },
      setMovementFlags(f: number) {
        this.flags = f >>> 0;
      },
      hasMovementFlag(f: number) {
        return (this.flags & f) !== 0;
      },
      removeMovementFlag(f: number) {
        this.flags = (this.flags & ~f) >>> 0;
      },
      setFallTime() {},
      getSpeedType() {
        return SelectSpeedType(this.flags);
      },
    };
    void self;
    AddMovementGeneratorFactories();
    this.motionMaster = new MotionMaster(this.asOwner());
  }

  asOwner(): MovementOwner {
    return this as unknown as MovementOwner;
  }
  asCreature(): MovementOwnerCreature {
    return this as unknown as MovementOwnerCreature;
  }
  asPlayer(): MovementOwnerPlayer {
    return this as unknown as MovementOwnerPlayer;
  }

  /** `Unit::UpdateSplineMovement` and `MotionMaster::UpdateMotion`, `diff` ms of game time. */
  advance(diff: number): void {
    if (!this.movespline.finalized()) {
      this.movespline.updateState(diff);
      const loc = this.movespline.computePosition();
      this.x = loc.x;
      this.y = loc.y;
      this.z = loc.z;
      this.o = loc.orientation;
    }
    this.motionMaster.updateMotion(diff);
  }

  /** `advance` in `step` ms steps for `total` ms. */
  run(total: number, step = 100): void {
    for (let t = 0; t < total; t += step) this.advance(step);
  }

  // ---- MovementObject / WorldObject
  getGUID(): bigint {
    return this.guid;
  }
  getPositionX(): number {
    return this.x;
  }
  getPositionY(): number {
    return this.y;
  }
  getPositionZ(): number {
    return this.z;
  }
  getOrientation(): number {
    return this.o;
  }
  getPosition(): Position {
    return new Position(this.x, this.y, this.z, this.o);
  }
  getMap(): FakeMap {
    return this.map;
  }
  findMap(): FakeMap | null {
    return this.map;
  }
  getMapId(): number {
    return this.map.id;
  }
  getPhaseMask(): number {
    return 1;
  }
  getCollisionHeight(): number {
    return 2;
  }
  getObjectSize(): number {
    return 0.5;
  }
  getCombatReach(): number {
    return this.combatReachValue;
  }
  getEntry(): number {
    return this.entry;
  }
  getName(): string {
    return `Fake${this.guid}`;
  }
  getInstanceId(): number {
    return 0;
  }
  isInWorld(): boolean {
    return this.inWorld;
  }
  isInMap(obj: MovementObject | null): boolean {
    return obj !== null && (obj as unknown as FakeUnit).map === this.map;
  }
  isPlayer(): boolean {
    return this.kind === "player";
  }
  isCreature(): boolean {
    return this.kind === "creature";
  }
  toUnit(): MovementOwner {
    return this.asOwner();
  }
  toCreature(): MovementOwnerCreature | null {
    return this.kind === "creature" ? this.asCreature() : null;
  }
  toPlayer(): MovementOwnerPlayer | null {
    return this.kind === "player" ? this.asPlayer() : null;
  }
  getTransGUID(): bigint {
    return 0n;
  }
  getTransSeat(): number {
    return -1;
  }
  getTransport(): null {
    return null;
  }
  getDirectTransport(): null {
    return null;
  }
  getVehicleBase(): null {
    return null;
  }
  getPackGUID(): Uint8Array {
    return ObjectGuid.WriteAsPacked(this.guid);
  }
  sendMessageToSet(data: { opcode: number; payload: Uint8Array }): void {
    this.sent.push(data);
  }
  isImmobilizedState(): boolean {
    return false;
  }
  getCharmerOrOwnerGUID(): bigint {
    return this.charmerOrOwner?.guid ?? 0n;
  }
  getOwnerGUID(): bigint {
    return this.charmerOrOwner?.guid ?? 0n;
  }
  getCharmerOrOwner(): FakeUnit | null {
    return this.charmerOrOwner;
  }
  getCharmerOrOwnerPlayerOrPlayerItself(): MovementOwnerPlayer | null {
    if (this.isPlayer()) return this.asPlayer();
    return this.charmerOrOwner?.isPlayer() ? this.charmerOrOwner.asPlayer() : null;
  }
  getCritterGUID(): bigint {
    return 0n;
  }
  getSummonerUnit(): FakeUnit | null {
    return this.summoner;
  }

  // ---- Position members over the getters
  getExactDistSq(xOrPos: number | PositionLike, y?: number, z?: number): number {
    return this.getPosition().getExactDistSq(xOrPos, y, z);
  }
  getExactDist(xOrPos: number | PositionLike, y?: number, z?: number): number {
    return this.getPosition().getExactDist(xOrPos, y, z);
  }
  getExactDist2d(xOrPos: number | PositionLike, y?: number): number {
    return this.getPosition().getExactDist2d(xOrPos, y);
  }
  isInDist(xOrPos: number | PositionLike, yOrDist: number, z?: number, dist?: number): boolean {
    return this.getPosition().isInDist(xOrPos, yOrDist, z, dist);
  }
  getAngle(xOrPos: number | PositionLike | null, y?: number): number {
    return this.getPosition().getAngle(xOrPos, y);
  }
  getRelativeAngle(xOrPos: number | PositionLike, y?: number): number {
    return this.getPosition().getRelativeAngle(xOrPos, y);
  }
  toAbsoluteAngle(relAngle: number): number {
    return this.getPosition().toAbsoluteAngle(relAngle);
  }
  getDistance(objOrPosOrX: PositionLike | number, y?: number, z?: number): number {
    const d = this.getExactDist(objOrPosOrX, y, z) - this.getObjectSize() - (typeof objOrPosOrX !== "number" && "getObjectSize" in objOrPosOrX ? (objOrPosOrX as unknown as FakeUnit).getObjectSize() : 0);
    return d > 0 ? d : 0;
  }
  getDistance2d(objOrX: MovementObject | number, y?: number): number {
    const d = this.getExactDist2d(objOrX as number | PositionLike, y) - this.getObjectSize() - (typeof objOrX !== "number" ? (objOrX as unknown as FakeUnit).getObjectSize() : 0);
    return d > 0 ? d : 0;
  }
  isWithinLOS(ox: number, oy: number, oz: number): boolean {
    return this.map.isInLineOfSight(this.x, this.y, this.z, ox, oy, oz);
  }
  isWithinLOSInMap(obj: MovementObject): boolean {
    return this.isWithinLOS(obj.getPositionX(), obj.getPositionY(), obj.getPositionZ());
  }
  getNearPoint(_searcher: MovementObject | null, searcher_size: number, distance2d: number, absAngle: number): { x: number; y: number; z: number } {
    const reach = this.combatReachValue + (_searcher ? (_searcher as unknown as FakeUnit).combatReachValue : 0);
    void searcher_size;
    return { x: this.x + (reach + distance2d + searcher_size) * Math.cos(absAngle), y: this.y + (reach + distance2d + searcher_size) * Math.sin(absAngle), z: this.z };
  }
  getNearPoint2D(searcher: MovementObject | null, distance2d: number, absAngle: number): { x: number; y: number } {
    const reach = this.combatReachValue + (searcher ? (searcher as unknown as FakeUnit).combatReachValue : 0);
    return { x: this.x + (reach + distance2d) * Math.cos(absAngle), y: this.y + (reach + distance2d) * Math.sin(absAngle) };
  }
  getClosePoint(size: number, distance2d = 0, angle = 0): { x: number; y: number; z: number; ok: boolean } {
    const a = this.o + angle;
    return { x: this.x + (size + distance2d) * Math.cos(a), y: this.y + (size + distance2d) * Math.sin(a), z: this.z, ok: true };
  }
  movePositionToFirstCollision(pos: Position, dist: number, angle: number): void {
    // no collision in the fake map: `MovePosition`
    const a = angle + this.o;
    pos.relocate(pos.getPositionX() + dist * Math.cos(a), pos.getPositionY() + dist * Math.sin(a), pos.getPositionZ(), pos.getOrientation());
  }
  getMapHeight(x: number, y: number, z: number): number {
    return this.map.getHeight(1, x, y, z);
  }
  getMapWaterOrGroundLevel(xOrPos: number | PositionLike, yOrGround?: number | FloatRef | null, z?: number, ground?: FloatRef | null): number {
    if (typeof xOrPos !== "number") return this.getMapWaterOrGroundLevel(xOrPos.getPositionX(), xOrPos.getPositionY(), xOrPos.getPositionZ(), yOrGround as FloatRef | null);
    const level = this.map.getHeight(1, xOrPos, yOrGround as number, z ?? 0);
    if (ground) ground.value = level;
    return level;
  }
  updateAllowedPositionZ(_x: number, _y: number, z: number): number {
    return z;
  }
  getHitSpherePointFor(dest: PositionLike): PositionLike {
    return dest;
  }

  // ---- Unit state
  isAlive(): boolean {
    return this.alive;
  }
  hasUnitState(f: number): boolean {
    return (this.unitState & f) !== 0;
  }
  addUnitState(f: number): void {
    this.unitState = (this.unitState | f) >>> 0;
  }
  clearUnitState(f: number): void {
    this.unitState = (this.unitState & ~f) >>> 0;
  }
  hasUnitFlag(flags: number): boolean {
    return (this.unitFlags & flags) !== 0;
  }
  setUnitFlag(flags: number): void {
    this.unitFlags = (this.unitFlags | flags) >>> 0;
  }
  removeUnitFlag(flags: number): void {
    this.unitFlags = (this.unitFlags & ~flags) >>> 0;
  }
  get m_movementInfo(): MovementOwnerMovementInfo {
    return this.info;
  }
  hasUnitMovementFlag(f: number): boolean {
    return this.info.hasMovementFlag(f);
  }
  addUnitMovementFlag(f: number): void {
    this.info.setMovementFlags(this.info.getMovementFlags() | f);
  }
  removeUnitMovementFlag(f: number): void {
    this.info.removeMovementFlag(f);
  }
  sendMovementFlagUpdate(): void {
    this.log.push("sendMovementFlagUpdate");
  }
  isFlying(): boolean {
    return this.canFlyValue;
  }
  isHovering(): boolean {
    return false;
  }
  getHoverHeight(): number {
    return this.hoverHeight;
  }
  isMoving(): boolean {
    return this.info.hasMovementFlag(MOVEMENTFLAG_FORWARD);
  }
  isWalking(): boolean {
    return this.walking || this.info.hasMovementFlag(MOVEMENTFLAG_WALKING);
  }
  canFly(): boolean {
    return this.canFlyValue;
  }
  canSwim(): boolean {
    return false;
  }
  canWalk(): boolean {
    return this.canWalkValue;
  }
  canEnterWater(): boolean {
    return this.canEnterWaterValue;
  }
  isFalling(): boolean {
    return false;
  }
  isInWater(): boolean {
    return false;
  }
  isUnderWater(): boolean {
    return false;
  }
  isInCombat(): boolean {
    return this.inCombat;
  }
  isEngaged(): boolean {
    return this.engaged;
  }
  isPet(): boolean {
    return false;
  }
  isGuardian(): boolean {
    return false;
  }
  isVehicle(): boolean {
    return false;
  }
  isSummon(): boolean {
    return false;
  }
  isControlledByPlayer(): boolean {
    return false;
  }
  isCharmedOwnedByPlayerOrPlayer(): boolean {
    return this.isPlayer();
  }
  isStandState(): boolean {
    return this.standState === 0;
  }
  setStandState(state: number): void {
    this.standState = state;
  }
  getBoundaryRadius(): number {
    return 0.5;
  }
  getMeleeRange(target: MovementOwner): number {
    return Math.max(5, this.combatReachValue + (target as unknown as FakeUnit).combatReachValue + 4 / 3);
  }
  getMeleeAttackPoint(): Position | null {
    return null;
  }
  accessible = true;
  isInAccessiblePlaceFor(): boolean {
    return this.accessible;
  }
  getFollowAngle(): number {
    return this.followAngle;
  }
  getSpeed(mtype: number): number {
    return Math.fround(this.speeds[mtype] ?? 7);
  }
  getAI(): RecordingAI | null {
    return this.recordingAI;
  }
  ai(): RecordingAI | null {
    return this.recordingAI;
  }
  IsAIEnabled = true;
  getVictim(): MovementOwner | null {
    return this.victim ? this.victim.asOwner() : null;
  }
  getTarget(): bigint {
    return this.targetGuid;
  }
  setTarget(guid = 0n): void {
    this.targetGuid = guid;
  }
  attack(victim: MovementOwner): boolean {
    this.victim = victim as unknown as FakeUnit;
    this.log.push("attack");
    return true;
  }
  attackStop(): boolean {
    this.victim = null;
    this.log.push("attackStop");
    return true;
  }
  castStop(): void {
    this.log.push("castStop");
  }
  isMovementPreventedByCasting(): boolean {
    return this.movementPreventedByCasting;
  }
  isStopped(): boolean {
    return !this.hasUnitState(UNIT_STATE_MOVING);
  }
  stopMoving(): void {
    this.clearUnitState(UNIT_STATE_MOVING);
    if (!this.inWorld || this.movespline.finalized()) return;
    new MoveSplineInit(this.asOwner()).stop();
  }
  setFacingTo(ori: number): void {
    this.o = NormalizeOrientation(ori);
    this.log.push(`setFacingTo(${ori})`);
  }
  setInFront(target: MovementOwner): void {
    this.o = this.getAngle(target);
    this.log.push("setInFront");
  }
  nearTeleportTo(x: number, y: number, z: number, o: number): boolean {
    this.teleports.push([x, y, z, o]);
    this.x = x;
    this.y = y;
    this.z = z;
    this.o = o;
    return true;
  }
  isClientControlled(): boolean {
    return false;
  }
  followerAdded(f: AbstractFollower): void {
    this.followers.add(f);
  }
  followerRemoved(f: AbstractFollower): void {
    this.followers.delete(f);
  }
  getUnit(guid: bigint): MovementOwner | null {
    return this.units.get(guid)?.asOwner() ?? null;
  }
  getMotionMaster(): MotionMaster {
    return this.motionMaster;
  }

  // ---- Creature
  getSpawnId(): number {
    return this.spawnId;
  }
  getWanderDistance(): number {
    return this.wanderDistance;
  }
  getDefaultMovementType(): number {
    return this.defaultMovementType;
  }
  getMovementTemplate(): MovementOwnerCreatureMovementData {
    return this.movementTemplate;
  }
  getWaypointPath(): number {
    return this.waypointPath;
  }
  getCreatureData(): { currentwaypoint: number } | null {
    return this.creatureData;
  }
  updateCurrentWaypointInfo(nodeId: number, pathId: number): void {
    this.currentWaypointInfo = [nodeId, pathId];
  }
  updateWaypointID(wpID: number): void {
    this.waypointId = wpID;
  }
  getCurrentWaypointID(): number {
    return this.waypointId;
  }
  setHomePosition(xOrPos: number | Position, y = 0, z = 0, o = 0): void {
    if (typeof xOrPos === "number") this.homePosition.relocate(xOrPos, y, z, o);
    else this.homePosition.relocate(xOrPos);
  }
  getHomePosition(): Position {
    return this.homePosition;
  }
  setTransportHomePosition(): void {}
  loadCreaturesAddon(): boolean {
    this.log.push("loadCreaturesAddon");
    return true;
  }
  hasSwimmingFlagOutOfCombat(): boolean {
    return false;
  }
  getCombatManager(): MovementOwnerCombatManager {
    return { setEvadeState: (state: number) => void this.evadeStates.push(state) };
  }
  getAttackTime(): number {
    return this.attackTime;
  }
  setReactState(state: number): void {
    this.reactState = state;
  }
  setNoCallAssistance(val: boolean): void {
    this.log.push(`setNoCallAssistance(${val})`);
  }
  callAssistance(): void {
    this.log.push("callAssistance");
  }
  setCannotReachTarget(guid = 0n): void {
    this.cannotReachTarget = guid;
  }
  isPossessed(): boolean {
    return false;
  }
  isInEvadeMode(): boolean {
    return false;
  }
  isValidAttackTarget(): boolean {
    return true;
  }
  engageWithTarget(target: MovementOwner): void {
    this.victim = target as unknown as FakeUnit;
    this.log.push("engageWithTarget");
  }
  respawn(): void {
    this.alive = true;
    this.log.push("respawn");
  }
  despawnOrUnsummon(): void {
    this.log.push("despawnOrUnsummon");
  }
  getFormation(): CreatureGroup | null {
    return this.formation;
  }
  setFormation(formation: CreatureGroup | null): void {
    this.formation = formation;
  }
  isFormationLeader(): boolean {
    return this.formation?.getLeader() === (this as unknown as MovementOwnerCreature);
  }
  isFormationLeaderMoveAllowed(): boolean {
    return this.formation ? this.formation.canLeaderStartMoving() : true;
  }
  signalFormationMovement(): void {
    if (this.formation?.getLeader() === (this as unknown as MovementOwnerCreature)) this.formation.leaderStartedMoving();
  }

  // ---- Player
  get m_taxi(): MovementOwnerPlayerTaxi {
    return {
      getPath: () => this.taxi.path,
      getFlightMasterFactionTemplate: () => null as FactionTemplateEntry | null,
      clearTaxiDestinations: () => {
        this.taxi.cleared++;
        this.taxi.path.length = 0;
      },
      nextTaxiDestination: () => void this.taxi.next++,
      empty: () => this.taxi.path.length === 0,
    };
  }
  readonly pvpInfo = { EndTimer: 0 };
  getReputationPriceDiscount(): number {
    return 1.0;
  }
  dismount(): void {
    this.log.push("dismount");
  }
  updatePvPState(): void {}
  updatePvP(): void {}
  setFallInformation(time: number, z: number): void {
    this.fallInformation = [time, z];
  }
  removePlayerFlag(flags: number): void {
    this.log.push(`removePlayerFlag(${flags})`);
  }
  updateAchievementCriteria(): void {}
  modifyMoney(amount: number): boolean {
    this.money += amount;
    return true;
  }
  isGameMaster(): boolean {
    return false;
  }
}

/** A `Vector3` list from `[x, y, z]` triples. */
export function points(...triples: [number, number, number][]): Vector3[] {
  return triples.map(([x, y, z]) => new Vector3(x, y, z));
}
