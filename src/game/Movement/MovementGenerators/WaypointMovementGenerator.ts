/**
 * Port of `game/Movement/MovementGenerators/WaypointMovementGenerator.{h,cpp}`: `PathMovementBase`, the creature
 * waypoint generator (`WaypointMovementGenerator<Creature>`, which walks a `WaypointPath` node by node or as one smooth
 * spline, honouring delays, scripts and AI hooks) and the player taxi generator (`FlightPathMovementGenerator`).
 *
 * The taxi data (`sTaxiPathNodesByPath` of `DBCStores.cpp`, `ObjectMgr::GetTaxiPath`, `sMapMgr->FindBaseNonInstanceMap`)
 * belongs to other topics: `FlightPathContext` is the seam, with the C++ names.
 *
 * @ac-skip SmartAI: `sSmartWaypointMgr` (`PathSource::SMART_WAYPOINT_MGR`) is `SmartWaypointMgrHook`, empty until SmartAI is ported.
 * @ac-skip Transports: the transport branches of `UpdateHomePosition` (`Transport::CalculatePassengerPosition`) do nothing.
 * @ac-skip Scripts: `Map::ScriptsStart(sWaypointScripts / sEventScripts, ...)` goes to `MovementMap.scriptsStart` with `null` scripts.
 */
import type { TaxiPathNodeEntry } from "../../../gen/DBCStructure.gen.ts";
import { urand } from "../../../common/random.ts";
import { logDebug, logError } from "../../../log.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { UNIT_FLAG_DISABLE_MOVE, UNIT_FLAG_TAXI_FLIGHT, UNIT_STATE_IN_FLIGHT, UNIT_STATE_NOT_MOVE, UNIT_STATE_ROAMING, UNIT_STATE_ROAMING_MOVE } from "../../../spells/enums.ts";
import { PLAYER_FLAGS_TAXI_BENCHMARK } from "../../Entities/Player/PlayerDefines.ts";
import { getGameTime } from "../../time/game-time.ts";
import { ServerConfig } from "../../world/world-config-data.ts";
import { sWorld } from "../../world/world.ts";
import { MovementGeneratorMedium, type ResetPosition } from "../MovementGenerator.ts";
import { AnimTier, FLIGHT_MOTION_TYPE, PathSource, WAYPOINT_MOTION_TYPE, type MovementGeneratorType } from "../MotionMaster.ts";
import { MOVEMENTFLAG_ONTRANSPORT, type MovementOwner, type MovementOwnerCreature, type MovementOwnerPlayer } from "../MovementOwner.ts";
import { MoveSplineInit } from "../Spline/MoveSplineInit.ts";
import {
  WAYPOINT_MOVE_TYPE_LAND,
  WAYPOINT_MOVE_TYPE_RUN,
  WAYPOINT_MOVE_TYPE_TAKEOFF,
  WAYPOINT_MOVE_TYPE_WALK,
  type WaypointNode,
  type WaypointPath,
} from "../Waypoints/WaypointDefines.ts";
import { sWaypointMgr } from "../Waypoints/WaypointMgr.ts";

/** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h FLIGHT_TRAVEL_UPDATE */
export const FLIGHT_TRAVEL_UPDATE = 100;
/** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h TIMEDIFF_NEXT_WP */
export const TIMEDIFF_NEXT_WP = 250;

/** `ACHIEVEMENT_CRITERIA_TYPE_GOLD_SPENT_FOR_TRAVELLING` @ac shared/DataStores/DBCEnums.h */
const ACHIEVEMENT_CRITERIA_TYPE_GOLD_SPENT_FOR_TRAVELLING = 63;

/** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h SKIP_SPLINE_POINT_DISTANCE_SQ (`40.0f * 40.0f`) */
const SKIP_SPLINE_POINT_DISTANCE_SQ = 40.0 * 40.0;

const F = Math.fround;

/** @ac game/Movement/Waypoints/WaypointMgr.h sSmartWaypointMgr (`SmartWaypointMgr::GetPath`) @ac-skip SmartAI: not ported */
export const SmartWaypointMgrHook: { instance: { getPath(id: number): WaypointPath | null } | null } = { instance: null };

/** `switch (pathSource)` of `MotionMaster::MovePath` and `WaypointMovementGenerator::DoInitialize`. */
export function GetWaypointPath(pathSource: PathSource, id: number): WaypointPath | null {
  switch (pathSource) {
    default:
    case PathSource.WAYPOINT_MGR:
      return sWaypointMgr().getPath(id);
    case PathSource.SMART_WAYPOINT_MGR:
      return SmartWaypointMgrHook.instance?.getPath(id) ?? null;
  }
}

/** @ac game/Entities/Player/Player.h TaxiPathNodeList (`std::vector<TaxiPathNodeEntry const*>`) */
export type TaxiPathNodeList = readonly TaxiPathNodeEntry[];

/**
 * What `FlightPathMovementGenerator` reads from the DBC stores, `ObjectMgr` and `MapMgr`.
 * `getTaxiPathNodesByPath` is `sTaxiPathNodesByPath`, `getTaxiPath` is `ObjectMgr::GetTaxiPath` (the `path` and `cost` out
 * parameters are the result) and `findBaseNonInstanceMap` is `sMapMgr->FindBaseNonInstanceMap`.
 */
export const FlightPathContext: {
  getTaxiPathNodesByPath: () => readonly TaxiPathNodeList[];
  getTaxiPath: (source: number, destination: number) => { path: number; cost: number };
  findBaseNonInstanceMap: (mapId: number) => { loadGrid(x: number, y: number): void } | null;
} = {
  getTaxiPathNodesByPath: () => {
    throw new Error("FlightPathContext.getTaxiPathNodesByPath is not wired (sTaxiPathNodesByPath)");
  },
  getTaxiPath: () => {
    throw new Error("FlightPathContext.getTaxiPath is not wired (ObjectMgr::GetTaxiPath)");
  },
  findBaseNonInstanceMap: () => null,
};

/** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h PathMovementBase */
export abstract class PathMovementBase<T extends MovementOwner, P> extends MovementGeneratorMedium<T> {
  protected i_path: P;
  protected i_currentNode = 0;

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h PathMovementBase::PathMovementBase */
  constructor(path: P) {
    super();
    this.i_path = path;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h PathMovementBase::GetCurrentNode */
  getCurrentNode(): number {
    return this.i_currentNode;
  }
}

/** `PositionToVector3` */
function PositionToVector3(p: { getPositionX(): number; getPositionY(): number; getPositionZ(): number }): Vector3 {
  return new Vector3(p.getPositionX(), p.getPositionY(), p.getPositionZ());
}

/** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp UpdateHomePosition */
function UpdateHomePosition(creature: MovementOwnerCreature, waypointNode: WaypointNode): void {
  const x = waypointNode.X;
  const y = waypointNode.Y;
  const z = waypointNode.Z;
  const o = creature.getOrientation();

  const transportPath = creature.hasUnitMovementFlag(MOVEMENTFLAG_ONTRANSPORT) && creature.getTransGUID() !== 0n;
  if (!transportPath) creature.setHomePosition(x, y, z, o);
  // @ac-skip Transports: `Transport* trans = creature->GetTransport()->ToMotionTransport()`: o -= trans->GetOrientation(), SetTransportHomePosition, CalculatePassengerPosition, SetHomePosition
}

/** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h WaypointMovementGenerator<Creature> */
export class WaypointMovementGenerator extends PathMovementBase<MovementOwnerCreature, WaypointPath | null> {
  private _lastSplineId = 0;
  private _pathId: number;
  private _waypointDelay = 0;
  private _pauseTime: number | null = null;
  private _waypointReached = true;

  private _recalculateSpeed = false;
  private _repeating: boolean;
  private _loadedFromDB: boolean;
  private _stalled = false;
  private _hasBeenStalled = false;
  private _done = false;
  private _pathSource: PathSource;
  private _smoothSplineLaunched = false;
  private _lastPassedSplineIdx = 0;

  /**
   * `WaypointMovementGenerator(uint32 pathId = 0, bool repeating = true, PathSource pathSource = WAYPOINT_MGR)` and
   * `WaypointMovementGenerator(WaypointPath& path, bool repeating = true)`.
   *
   * @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp WaypointMovementGenerator<Creature>::WaypointMovementGenerator
   */
  constructor(pathId?: number, repeating?: boolean, pathSource?: PathSource);
  constructor(path: WaypointPath, repeating?: boolean);
  constructor(pathIdOrPath: number | WaypointPath = 0, repeating = true, pathSource: PathSource = PathSource.WAYPOINT_MGR) {
    super(null);
    this._repeating = repeating;
    if (typeof pathIdOrPath === "number") {
      this._pathId = pathIdOrPath;
      this._loadedFromDB = true;
      this._pathSource = pathSource;
    } else {
      this._pathId = 0;
      this._loadedFromDB = false;
      this._pathSource = PathSource.WAYPOINT_MGR;
      this.i_path = pathIdOrPath;
    }
  }

  /** The C++ destructor. @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h WaypointMovementGenerator::~WaypointMovementGenerator */
  override destroy(): void {
    this.i_path = null;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h WaypointMovementGenerator::unitSpeedChanged */
  override unitSpeedChanged(): void {
    this._recalculateSpeed = true;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h WaypointMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return WAYPOINT_MOTION_TYPE;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp WaypointMovementGenerator<Creature>::DoInitialize */
  doInitialize(creature: MovementOwnerCreature): void {
    this._done = false;

    if (this._loadedFromDB) {
      if (!this._pathId) this._pathId = creature.getWaypointPath();

      this.i_path = GetWaypointPath(this._pathSource, this._pathId);
    }

    if (!this.i_path) {
      logError("sql", `WaypointMovementGenerator::DoInitialize: creature ${creature.getName()} (${creature.getGUID()}) doesn't have waypoint path id: ${this._pathId}`);
      return;
    }

    // Determine our first waypoint from the creature's stored waypoint
    const creatureData = creature.getCreatureData();
    if (creatureData) {
      if (this.i_path.Nodes.length > creatureData.currentwaypoint) {
        creature.updateCurrentWaypointInfo(creatureData.currentwaypoint, this.i_path.Id);
        this.i_currentNode = creatureData.currentwaypoint;
      }
    }

    creature.addUnitState(UNIT_STATE_ROAMING | UNIT_STATE_ROAMING_MOVE);

    // Inform AI
    creature.ai()?.WaypointPathStarted?.(this.i_path.Id);
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp WaypointMovementGenerator<Creature>::DoFinalize */
  doFinalize(creature: MovementOwnerCreature): void {
    creature.clearUnitState(UNIT_STATE_ROAMING | UNIT_STATE_ROAMING_MOVE);
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp WaypointMovementGenerator<Creature>::DoReset */
  doReset(creature: MovementOwnerCreature): void {
    // We did not reach our last waypoint before reset, treat this scenario as resuming movement.
    if (!this._done && !this._waypointReached) this._hasBeenStalled = true;
    else if (this._done) {
      // mimic IdleMovementGenerator
      if (!creature.isStopped()) creature.stopMoving();
    }
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp WaypointMovementGenerator<Creature>::ProcessWaypointArrival */
  private processWaypointArrival(creature: MovementOwnerCreature, waypoint: WaypointNode): void {
    if (this._waypointReached) return;

    if (waypoint.Delay > 0) {
      creature.clearUnitState(UNIT_STATE_ROAMING_MOVE);
      this._waypointDelay = waypoint.Delay;
    }

    const pathEnded = this.i_currentNode === this.i_path!.Nodes.length - 1 && !this._repeating && !this._done;
    if (pathEnded) this._done = true;

    UpdateHomePosition(creature, waypoint);

    if (waypoint.EventId && urand(0, 99) < waypoint.EventChance) {
      logDebug("maps", () => `Creature movement start script ${waypoint.EventId} at point ${this.i_currentNode} for ${creature.getGUID()}.`);
      creature.clearUnitState(UNIT_STATE_ROAMING_MOVE);
      creature.getMap().scriptsStart(null /* sWaypointScripts */, waypoint.EventId, creature, null);
    }

    // scripts can invalidate current path, store what we need
    const waypointId = waypoint.Id;
    const pathId = this.i_path!.Id;

    creature.updateWaypointID(waypointId);
    creature.updateCurrentWaypointInfo(waypointId, pathId);

    // Inform AI
    const ai = creature.ai();
    if (ai) {
      ai.MovementInform?.(WAYPOINT_MOTION_TYPE, waypointId);
      ai.WaypointReached?.(waypointId, pathId);
    }

    const owner = creature.getCharmerOrOwner();
    if (owner) {
      owner.getAI()?.SummonMovementInform?.(creature, WAYPOINT_MOTION_TYPE, waypointId);
    } else {
      // `if (TempSummon* tempSummon = creature->ToTempSummon())`
      const owner2 = creature.getSummonerUnit();
      if (owner2) owner2.getAI()?.SummonMovementInform?.(creature, WAYPOINT_MOTION_TYPE, waypointId);
    }

    // Path end notifications fire after WaypointReached so that m_path_id
    // is still valid when SmartAI checks it for SMART_EVENT_WAYPOINT_REACHED.
    if (pathEnded) {
      creature.updateCurrentWaypointInfo(0, 0);

      creature.ai()?.PathEndReached?.(pathId);

      // Re-fetch AI — PathEndReached may have despawned the creature or swapped its AI
      creature.ai()?.WaypointPathEnded?.(waypointId, pathId);
    }

    // All hooks called and infos updated. Time to increment the waypoint node id
    if (this.i_path && this.i_path.Nodes.length > 0)
      // ensure that the path has not been changed in one of the hooks.
      this.i_currentNode = (this.i_currentNode + 1) % this.i_path.Nodes.length;

    this._waypointReached = true;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp WaypointMovementGenerator<Creature>::StartMove */
  private startMove(creature: MovementOwnerCreature, relaunch = false): void {
    // Formation checks. Do not launch a new spline when one of our formation members is currently in combat.
    if (!relaunch) {
      if (!this.isAllowedToMove(creature) || (creature.isFormationLeader() && !creature.isFormationLeaderMoveAllowed())) {
        this._waypointDelay = 1000;
        return;
      }
    }

    // Dont allow dead creatures to move
    if (!creature.isAlive()) return;

    // Step two: node selection is done, build spline data
    creature.addUnitState(UNIT_STATE_ROAMING_MOVE);
    const path = this.i_path!;
    const waypoint = this.nodeAt(path, this.i_currentNode);
    const useTransportPath = creature.hasUnitMovementFlag(MOVEMENTFLAG_ONTRANSPORT) && creature.getTransGUID() !== 0n;

    const init = new MoveSplineInit(creature);
    //! If the creature is on transport, we assume waypoints set in DB are already transport offsets
    if (useTransportPath) init.disableTransportPathTransformations();

    if (waypoint.SmoothTransition && path.Nodes.length > 2) {
      // Build a catmullrom spline segment, stopping at delay waypoints
      init.path().push(PositionToVector3(creature));

      let hasDelayInSegment = false;
      let segmentNodes = 0;
      for (let i = 0; i < path.Nodes.length; ++i) {
        const idx = (this.i_currentNode + i) % path.Nodes.length;
        const node = this.nodeAt(path, idx);
        const newZ = creature.updateAllowedPositionZ(node.X, node.Y, node.Z);
        init.path().push(new Vector3(node.X, node.Y, newZ));
        segmentNodes++;

        // Stop the segment at a waypoint with a delay
        if (node.Delay > 0) {
          hasDelayInSegment = true;
          break;
        }
      }

      // If no delays found and repeating, add wrap-around points for seamless loop
      if (!hasDelayInSegment && this._repeating) {
        for (let i = 0; i < Math.min(3, path.Nodes.length); ++i) {
          const idx = (this.i_currentNode + i) % path.Nodes.length;
          const node = this.nodeAt(path, idx);
          const newZ = creature.updateAllowedPositionZ(node.X, node.Y, node.Z);
          init.path().push(new Vector3(node.X, node.Y, newZ));
        }
      }

      // Need at least 3 waypoints for a meaningful catmullrom spline
      if (segmentNodes >= 3) {
        init.setFirstPointId(this.i_currentNode);
        init.setSmooth();
        this._smoothSplineLaunched = true;
        this._lastPassedSplineIdx = this.i_currentNode;
      } else {
        // Too few points for catmullrom, fall back to linear point-to-point
        init.path().length = 0;
        init.moveTo(new Vector3(waypoint.X, waypoint.Y, waypoint.Z));
      }
    } else if (waypoint.SplinePoints.length > 0) {
      // We have spline points in waypoint_data_addon table
      const splineIndex = 0;

      init.path().length = 0;
      for (let i = splineIndex; i < waypoint.SplinePoints.length; ++i) {
        const p = waypoint.SplinePoints[i]!;
        init.path().push(new Vector3(p.x, p.y, p.z));
      }

      // Add starting vertex and destination
      init.path().unshift(PositionToVector3(creature));
      init.path().push(new Vector3(waypoint.X, waypoint.Y, waypoint.Z));
    } else {
      // Smooth transition for short paths (<=2 nodes): use previous spline endpoint as start
      if (waypoint.SmoothTransition && !creature.movespline.finalized() && this._lastSplineId === creature.movespline.getId()) {
        init.moveTo(creature.movespline.finalDestination(), new Vector3(waypoint.X, waypoint.Y, waypoint.Z));
        if (init.path().length > 0) init.path().unshift(PositionToVector3(creature));
      } else init.moveTo(PositionToVector3(creature), new Vector3(waypoint.X, waypoint.Y, waypoint.Z));
    }

    if (waypoint.Orientation !== undefined && waypoint.Orientation !== null && waypoint.Delay > 0) init.setFacing(waypoint.Orientation);

    switch (waypoint.MoveType) {
      case WAYPOINT_MOVE_TYPE_LAND:
        init.setAnimation(AnimTier.Ground);
        break;
      case WAYPOINT_MOVE_TYPE_TAKEOFF:
        init.setAnimation(AnimTier.Hover);
        break;
      case WAYPOINT_MOVE_TYPE_RUN:
        init.setWalk(false);
        break;
      case WAYPOINT_MOVE_TYPE_WALK:
        init.setWalk(true);
        break;
      default:
        break;
    }

    if (creature.canFly()) init.setFly();

    if (waypoint.Velocity > 0.0) init.setVelocity(waypoint.Velocity);

    init.launch();

    if (!creature.movespline.finalized()) this._lastSplineId = creature.movespline.getId();

    // Inform formation
    creature.signalFormationMovement();

    // Inform AI
    if (!relaunch) creature.ai()?.WaypointStarted?.(waypoint.Id, path.Id);

    this._waypointReached = false;
    this._recalculateSpeed = false;
    this._hasBeenStalled = false;
  }

  /** `i_path->Nodes.at(idx)` (throws `std::out_of_range`). */
  private nodeAt(path: WaypointPath, idx: number): WaypointNode {
    const node = path.Nodes[idx];
    if (!node) throw new RangeError(`WaypointMovementGenerator: node ${idx} is not in path ${path.Id}`);
    return node;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp WaypointMovementGenerator<Creature>::DoUpdate */
  doUpdate(creature: MovementOwnerCreature, diff: number): boolean {
    if (!creature || !creature.isAlive()) return true;

    if (this._done || !this.i_path || this.i_path.Nodes.length === 0) return true;

    // Stop movement if paused, rooted, or casting
    if (!this.isAllowedToMove(creature) && !creature.movespline.finalized()) {
      creature.stopMoving();
      this._lastSplineId = 0;
      this._smoothSplineLaunched = false;
      this._hasBeenStalled = true;
    }

    // Set home position to current position.
    if (!creature.movespline.finalized()) {
      const transportPath = creature.hasUnitMovementFlag(MOVEMENTFLAG_ONTRANSPORT) && creature.getTransGUID() !== 0n;
      if (!transportPath) creature.setHomePosition(creature.getPosition());
    }

    // Smooth spline: track waypoint passages without rebuilding
    if (this._smoothSplineLaunched && creature.movespline.getId() === this._lastSplineId) {
      const currentIdx = creature.movespline.currentPathIdx();

      // Process passed waypoints
      while (this._lastPassedSplineIdx < currentIdx) {
        this._lastPassedSplineIdx++;
        const passedWp = this.nodeAt(this.i_path!, this.i_currentNode);

        UpdateHomePosition(creature, passedWp);

        // Save data before AI callbacks — they can invalidate the reference
        const wpId = passedWp.Id;
        const wpPathId = this.i_path!.Id;
        const wpDelay = passedWp.Delay;
        const wpOrientation = passedWp.Orientation ?? null;

        creature.updateWaypointID(wpId);
        creature.updateCurrentWaypointInfo(wpId, wpPathId);

        if (passedWp.EventId && urand(0, 99) < passedWp.EventChance) {
          creature.clearUnitState(UNIT_STATE_ROAMING_MOVE);
          creature.getMap().scriptsStart(null /* sWaypointScripts */, passedWp.EventId, creature, null);
        }

        const ai = creature.ai();
        if (ai) {
          ai.MovementInform?.(WAYPOINT_MOTION_TYPE, wpId);
          ai.WaypointReached?.(wpId, wpPathId);
        }

        // Advance node
        if (this.i_path && this.i_path.Nodes.length > 0) this.i_currentNode = (this.i_currentNode + 1) % this.i_path.Nodes.length;

        // If this waypoint has a delay, stop the spline and pause
        if (wpDelay > 0) {
          creature.stopMoving();
          creature.clearUnitState(UNIT_STATE_ROAMING_MOVE);
          this._waypointDelay = wpDelay;
          this._waypointReached = true;
          this._smoothSplineLaunched = false;
          if (wpOrientation !== null) creature.setFacingTo(wpOrientation);

          return true;
        }
      }

      if (creature.movespline.finalized()) {
        if (!this._repeating) {
          // Path ended
          const endWpId = this.nodeAt(this.i_path!, this.i_currentNode).Id;
          const endPathId = this.i_path!.Id;
          this._done = true;
          this._smoothSplineLaunched = false;
          creature.updateCurrentWaypointInfo(0, 0);
          creature.ai()?.PathEndReached?.(endPathId);

          // Re-fetch AI — PathEndReached may have despawned the creature or swapped its AI
          creature.ai()?.WaypointPathEnded?.(endWpId, endPathId);
        } else {
          // Repeating: rebuild spline
          this._smoothSplineLaunched = false;
          this.startMove(creature);
        }
      }

      return true;
    }

    // Non-smooth: per-waypoint logic
    const waypoint = this.nodeAt(this.i_path, this.i_currentNode);
    this.updateWaypointState(creature, waypoint);

    // Process movement preventing timers
    if (this._waypointDelay > 0) {
      this._waypointDelay -= diff;
      if (this._waypointDelay > 0) return true;
    }

    if (this._pauseTime !== null) {
      this._pauseTime -= diff;
      if (this._pauseTime > 0) return true;
      else this._pauseTime = null;
    }

    // Timers are ready, let's try to move
    if (this.isAllowedToMove(creature) && (this._waypointReached || this._recalculateSpeed || this._hasBeenStalled)) this.startMove(creature, this._recalculateSpeed || this._hasBeenStalled);

    return true;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp WaypointMovementGenerator<Creature>::Pause */
  override pause(timer = 0): void {
    this._stalled = timer ? false : true;
    this._hasBeenStalled = !this._waypointReached;
    this._pauseTime = timer;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp WaypointMovementGenerator<Creature>::Resume */
  override resume(overrideTimer = 0): void {
    this._hasBeenStalled = !this._waypointReached;
    this._stalled = false;
    if (overrideTimer) this._pauseTime = overrideTimer;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp WaypointMovementGenerator<Creature>::GetResetPosition */
  override getResetPosition(pos: ResetPosition): boolean {
    // prevent a crash at empty waypoint path.
    if (!this.i_path || this.i_path.Nodes.length === 0) return false;

    // A finished non-repeating path no longer owns the creature's reset position.
    if (this._done) return false;

    if (!(this.i_currentNode < this.i_path.Nodes.length)) {
      throw new Error(`WaypointMovementGenerator::GetResetPos: tried to reference a node id (${this.i_currentNode}) which is not included in path (${this.i_path.Id})`);
    }
    const waypoint = this.nodeAt(this.i_path, this.i_currentNode);

    pos.x = waypoint.X;
    pos.y = waypoint.Y;
    pos.z = waypoint.Z;
    return true;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp WaypointMovementGenerator<Creature>::IsAllowedToMove */
  private isAllowedToMove(creature: MovementOwnerCreature): boolean {
    if (this._stalled || this._done) return false;

    if (this._pauseTime !== null) return false;

    if (creature.hasUnitState(UNIT_STATE_NOT_MOVE) || creature.isMovementPreventedByCasting()) return false;

    return true;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp WaypointMovementGenerator<Creature>::UpdateWaypointState */
  private updateWaypointState(creature: MovementOwnerCreature, waypointNode: WaypointNode): void {
    if (creature.movespline.getId() !== this._lastSplineId) return;

    if (creature.movespline.finalized()) this.processWaypointArrival(creature, waypointNode);
  }
}

//----------------------------------------------------//

/** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp IsNodeIncludedInShortenedPath */
function IsNodeIncludedInShortenedPath(p1: TaxiPathNodeEntry, p2: TaxiPathNodeEntry): boolean {
  return p1.mapid !== p2.mapid || F(F((p1.x - p2.x) ** 2) + F((p1.y - p2.y) ** 2)) > SKIP_SPLINE_POINT_DISTANCE_SQ;
}

/** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h FlightPathMovementGenerator::TaxiNodeChangeInfo */
interface TaxiNodeChangeInfo {
  PathIndex: number;
  Cost: number;
}

/**
 * FlightPathMovementGenerator generates movement of the player for the paths and hence generates ground and activities
 * for the player.
 *
 * @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h FlightPathMovementGenerator
 */
export class FlightPathMovementGenerator extends PathMovementBase<MovementOwnerPlayer, TaxiPathNodeEntry[]> {
  private _endGridX = 0.0; //! X coord of last node location
  private _endGridY = 0.0; //! Y coord of last node location
  private _endMapId = 0; //! map Id of last node location
  private _preloadTargetNode = 0; //! node index where preloading starts

  private _pointsForPathSwitch: TaxiNodeChangeInfo[] = []; //! node indexes and costs where TaxiPath changes

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h FlightPathMovementGenerator::FlightPathMovementGenerator */
  constructor(startNode = 0) {
    super([]);
    this.i_currentNode = startNode;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h FlightPathMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return FLIGHT_MOTION_TYPE;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h FlightPathMovementGenerator::GetPath */
  getPath(): TaxiPathNodeList {
    return this.i_path;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h FlightPathMovementGenerator::HasArrived */
  hasArrived(): boolean {
    return this.i_currentNode >= this.i_path.length;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.h FlightPathMovementGenerator::SkipCurrentNode */
  skipCurrentNode(): void {
    ++this.i_currentNode;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp FlightPathMovementGenerator::GetPathAtMapEnd */
  getPathAtMapEnd(): number {
    if (this.i_currentNode >= this.i_path.length) {
      return this.i_path.length;
    }

    const curMapId = this.i_path[this.i_currentNode]!.mapid;
    for (let i = this.i_currentNode; i < this.i_path.length; ++i) {
      if (this.i_path[i]!.mapid !== curMapId) {
        return i;
      }
    }

    return this.i_path.length;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp FlightPathMovementGenerator::LoadPath */
  loadPath(player: MovementOwnerPlayer): boolean {
    this.i_path = [];
    this._pointsForPathSwitch = [];
    const fail = (): boolean => {
      this.i_path = [];
      this._pointsForPathSwitch = [];
      return false;
    };

    const nodesByPath = FlightPathContext.getTaxiPathNodesByPath();
    const taxi = player.m_taxi.getPath();
    const discount = player.getReputationPriceDiscount(player.m_taxi.getFlightMasterFactionTemplate());
    for (let src = 0, dst = 1; dst < taxi.length; src = dst++) {
      const { path, cost } = FlightPathContext.getTaxiPath(taxi[src]!, taxi[dst]!);
      if (path >= nodesByPath.length) return fail();

      const nodes = nodesByPath[path]!;
      if (nodes.length === 0) return fail();

      const start = nodes[0]!;
      const end = nodes[nodes.length - 1]!;
      let passedPreviousSegmentProximityCheck = false;
      let addedPathNode = false;
      for (let i = 0; i < nodes.length; ++i) {
        if (passedPreviousSegmentProximityCheck || !src || this.i_path.length === 0 || IsNodeIncludedInShortenedPath(this.i_path[this.i_path.length - 1]!, nodes[i]!)) {
          if (
            (!src || (IsNodeIncludedInShortenedPath(start, nodes[i]!) && i >= 2)) &&
            (dst === taxi.length - 1 || (IsNodeIncludedInShortenedPath(end, nodes[i]!) && i < nodes.length - 1))
          ) {
            passedPreviousSegmentProximityCheck = true;
            this.i_path.push(nodes[i]!);
            addedPathNode = true;
          }
        } else {
          this.i_path.pop();
          --this._pointsForPathSwitch[this._pointsForPathSwitch.length - 1]!.PathIndex;
        }
      }

      if (!addedPathNode || this.i_path.length === 0) return fail();

      this._pointsForPathSwitch.push({ PathIndex: this.i_path.length - 1, Cost: Math.ceil(F(cost * discount)) });
    }

    // TODO: fixes crash, but can be handled in a better way once we will know how to reproduce it.
    if (this.getCurrentNode() >= this.i_path.length) {
      let paths = "";
      for (let src = 0, dst = 1; dst < taxi.length; src = dst++) {
        const { path } = FlightPathContext.getTaxiPath(taxi[src]!, taxi[dst]!);
        paths += `${path} `;
      }

      logError(
        "movement",
        `Failed to build correct path for player: ${player.getGUID()}. Current node: ${this.getCurrentNode()}, max nodes: ${this.i_path.length}. Paths: ${paths}. Player pos: ${player.getPosition().toString()}.`,
      );

      // Lets choose the second last element so that a player would still have some flight.
      if (this.i_path.length >= 2) this.i_currentNode = this.i_path.length - 2;
      else this.i_currentNode = 0;
    }

    if (this.i_path.length === 0) return fail();

    return true;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp FlightPathMovementGenerator::DoInitialize */
  doInitialize(player: MovementOwnerPlayer): void {
    this.reset(player);
    this.initEndGridInfo();
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp FlightPathMovementGenerator::DoFinalize */
  doFinalize(player: MovementOwnerPlayer): void {
    // remove flag to prevent send object build movement packets for flight state and crash (movement generator already not at top of stack)
    player.clearUnitState(UNIT_STATE_IN_FLIGHT);

    player.m_taxi.clearTaxiDestinations();
    player.dismount();
    player.removeUnitFlag(UNIT_FLAG_DISABLE_MOVE | UNIT_FLAG_TAXI_FLIGHT);
    player.updatePvPState(); // to account for cases such as flying into a PvP territory, as it does not flag on the way in

    if (player.m_taxi.empty()) {
      // update z position to ground and orientation for landing point
      // this prevent cheating with landing  point at lags
      // when client side flight end early in comparison server side
      player.stopMoving();

      // When the player reaches the last flight point, teleport to destination taxi node location
      player.setFallInformation(getGameTime(), player.getPositionZ());
    }

    player.removePlayerFlag(PLAYER_FLAGS_TAXI_BENCHMARK);
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp FlightPathMovementGenerator::DoReset */
  doReset(player: MovementOwnerPlayer): void {
    const end = this.getPathAtMapEnd();
    const currentNodeId = this.getCurrentNode();

    if (currentNodeId === end) {
      logDebug("movement", () => `FlightPathMovementGenerator::DoReset: trying to start a flypath from the end point. ${player.getGUID()}`);
      return;
    }

    if (player.pvpInfo.EndTimer) player.updatePvP(false, true); // PvP flag timer immediately ends when starting taxi

    player.addUnitState(UNIT_STATE_IN_FLIGHT);
    player.setUnitFlag(UNIT_FLAG_DISABLE_MOVE | UNIT_FLAG_TAXI_FLIGHT);

    const init = new MoveSplineInit(player);
    // Providing a starting vertex since the taxi paths do not provide such
    init.path().push(new Vector3(player.getPositionX(), player.getPositionY(), player.getPositionZ()));
    for (let i = currentNodeId; i !== end; ++i) {
      const vertice = new Vector3(this.i_path[i]!.x, this.i_path[i]!.y, this.i_path[i]!.z);
      init.path().push(vertice);
    }
    init.setFirstPointId(this.getCurrentNode());
    init.setFly();
    init.setVelocity(sWorld().getFloatConfig(ServerConfig.CONFIG_TAXI_FLIGHT_SPEED));
    init.launch();
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp FlightPathMovementGenerator::DoUpdate */
  doUpdate(player: MovementOwnerPlayer, _diff: number): boolean {
    // skipping the first spline path point because it's our starting point and not a taxi path point
    const pointId = player.movespline.currentPathIdx() <= 0 ? 0 : player.movespline.currentPathIdx() - 1;
    if (pointId > this.i_currentNode && this.i_currentNode < this.i_path.length - 1) {
      let departureEvent = true;
      do {
        if (!(this.i_currentNode < this.i_path.length)) throw new Error(`Point Id: ${pointId}\n${player.getGUID()}`);

        this.doEventIfAny(player, this.i_path[this.i_currentNode]!, departureEvent);
        while (this._pointsForPathSwitch.length > 0 && this._pointsForPathSwitch[0]!.PathIndex <= this.i_currentNode) {
          this._pointsForPathSwitch.shift();
          player.m_taxi.nextTaxiDestination();
          if (this._pointsForPathSwitch.length > 0) {
            player.updateAchievementCriteria(ACHIEVEMENT_CRITERIA_TYPE_GOLD_SPENT_FOR_TRAVELLING, this._pointsForPathSwitch[0]!.Cost);
            player.modifyMoney(-this._pointsForPathSwitch[0]!.Cost);
          }
        }

        if (pointId === this.i_currentNode) {
          break;
        }

        if (this.i_currentNode === this._preloadTargetNode) {
          this.preloadEndGrid();
        }

        this.i_currentNode += departureEvent ? 1 : 0;
        departureEvent = !departureEvent;
      } while (this.i_currentNode < this.i_path.length - 1);
    }

    return this.i_currentNode < this.i_path.length - 1;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp FlightPathMovementGenerator::SetCurrentNodeAfterTeleport */
  setCurrentNodeAfterTeleport(): void {
    if (this.i_path.length === 0 || this.i_currentNode >= this.i_path.length) {
      return;
    }

    const map0 = this.i_path[this.i_currentNode]!.mapid;
    for (let i = this.i_currentNode + 1; i < this.i_path.length; ++i) {
      if (this.i_path[i]!.mapid !== map0) {
        this.i_currentNode = i;
        return;
      }
    }
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp FlightPathMovementGenerator::DoEventIfAny */
  doEventIfAny(player: MovementOwnerPlayer, node: TaxiPathNodeEntry, departure: boolean): void {
    const eventid = departure ? node.departureEventID : node.arrivalEventID;
    if (eventid) {
      logDebug("maps", () => `Taxi ${departure ? "departure" : "arrival"} event ${eventid} of node ${node.index} of path ${node.path} for player ${player.getName()}`);
      player.getMap().scriptsStart(null /* sEventScripts */, eventid, player, player);
    }
  }

  /** The `float& x, y, z` out parameters are `pos`. @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp FlightPathMovementGenerator::GetResetPos */
  getResetPos(_player: MovementOwnerPlayer, pos: ResetPosition): boolean {
    const node = this.i_path[this.i_currentNode]!;
    pos.x = node.x;
    pos.y = node.y;
    pos.z = node.z;
    return true;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp FlightPathMovementGenerator::InitEndGridInfo */
  initEndGridInfo(): void {
    /*! Storage to preload flightmaster grid at end of flight. For multi-stop flights, this will
       be reinitialized for each flightmaster at the end of each spline (or stop) in the flight. */
    const nodeCount = this.i_path.length; //! Number of nodes in path.
    this._endMapId = this.i_path[nodeCount - 1]!.mapid; //! MapId of last node

    // pussywizard:
    {
      this._preloadTargetNode = nodeCount - 1;
      for (let i = 3; i > 0; --i)
        if (nodeCount >= i && this._endMapId === this.i_path[nodeCount - i]!.mapid) {
          this._preloadTargetNode = nodeCount - i;
          break;
        }
      //_preloadTargetNode = nodeCount - 3; // pussywizard: this can be on other map
    }

    this._endGridX = this.i_path[nodeCount - 1]!.x;
    this._endGridY = this.i_path[nodeCount - 1]!.y;
  }

  /** @ac game/Movement/MovementGenerators/WaypointMovementGenerator.cpp FlightPathMovementGenerator::PreloadEndGrid */
  preloadEndGrid(): void {
    // used to preload the final grid where the flightmaster is
    const endMap = FlightPathContext.findBaseNonInstanceMap(this._endMapId);

    // Load the grid
    if (endMap) {
      logDebug("maps", () => `Preloading grid (${this._endGridX}, ${this._endGridY}) for map ${this._endMapId} at node index ${this._preloadTargetNode}/${this.i_path.length - 1}`);
      endMap.loadGrid(this._endGridX, this._endGridY);
    } else {
      logDebug("maps", () => "Unable to determine map to preload flightmaster grid");
    }
  }
}
