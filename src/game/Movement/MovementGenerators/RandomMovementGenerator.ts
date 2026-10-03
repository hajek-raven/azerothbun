/**
 * Port of `game/Movement/MovementGenerators/RandomMovementGenerator.{h,cpp}`: a creature that wanders around its spawn
 * point. Twelve points on a circle are picked at the first initialization; each point links to seven others, and the path
 * between two points is computed once (`_preComputedPaths`, unless `DontCacheRandomMovementPaths`).
 *
 * Only `RandomMovementGenerator<Creature>` exists in C++.
 */
import { randNorm, rollChanceI, urand } from "../../../common/random.ts";
import { fuzzyEq, fuzzyNe } from "../../../math/g3dmath.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { UNIT_FLAG_DISABLE_MOVE, UNIT_STATE_NOT_MOVE, UNIT_STATE_ROAMING, UNIT_STATE_ROAMING_MOVE } from "../../../spells/enums.ts";
import { TimeTrackerSmall } from "../../time/timer.ts";
import { MAP_OBJECT_CELL_MOVE_NONE } from "../../Entities/Object/Object.ts";
import { Position } from "../../Entities/Object/Position.ts";
import { IsValidMapCoord } from "../../Grids/GridDefines.ts";
import { INVALID_HEIGHT } from "../../Grids/GridTerrainData.ts";
import { LINEOFSIGHT_ALL_CHECKS, ModelIgnoreFlags } from "../../Grids/MapLike.ts";
import { ServerConfig } from "../../world/world-config-data.ts";
import { sWorld } from "../../world/world.ts";
import { MovementGeneratorMedium, type ResetPosition } from "../MovementGenerator.ts";
import { RANDOM_MOTION_TYPE, type MovementGeneratorType } from "../MotionMaster.ts";
import { CreatureRandomMovementType, type MovementOwnerCreature } from "../MovementOwner.ts";
import { MoveSplineInit } from "../Spline/MoveSplineInit.ts";
import { PATHFIND_NOPATH, PathGenerator, type PointsArray } from "./PathGenerator.ts";

const F = Math.fround;

/** @ac game/Movement/MovementGenerators/RandomMovementGenerator.h RANDOM_POINTS_NUMBER */
export const RANDOM_POINTS_NUMBER = 12;
/** @ac game/Movement/MovementGenerators/RandomMovementGenerator.h RANDOM_LINKS_COUNT */
export const RANDOM_LINKS_COUNT = 7;
/** @ac game/Movement/MovementGenerators/RandomMovementGenerator.h MIN_WANDER_DISTANCE_GROUND */
export const MIN_WANDER_DISTANCE_GROUND = 1.0;
/** @ac game/Movement/MovementGenerators/RandomMovementGenerator.h MIN_WANDER_DISTANCE_AIR */
export const MIN_WANDER_DISTANCE_AIR = 10.0;
/** @ac game/Movement/MovementGenerators/RandomMovementGenerator.h MAX_PATH_LENGHT_FACTOR */
export const MAX_PATH_LENGHT_FACTOR = F(1.85);

/** @ac game/Movement/MovementGenerators/RandomMovementGenerator.h RandomMovementGenerator<Creature> */
export class RandomMovementGenerator extends MovementGeneratorMedium<MovementOwnerCreature> {
  private _nextMoveTime = new TimeTrackerSmall(0);
  private _moveCount = 0;
  private _wanderDistance: number;
  private _pathGenerator: PathGenerator | null = null;
  private _destinationPoints: Vector3[] = [];
  private readonly _validPointsVector: number[][] = [];
  private _currentPoint: number = RANDOM_POINTS_NUMBER;
  private readonly _preComputedPaths = new Map<number, PointsArray>();
  private readonly _initialPosition = new Position();
  private readonly _currDestPosition = new Position();

  /** @ac game/Movement/MovementGenerators/RandomMovementGenerator.h RandomMovementGenerator::RandomMovementGenerator */
  constructor(wanderDistance = 0.0) {
    super();
    this._wanderDistance = F(wanderDistance);
    this._initialPosition.relocate(0.0, 0.0, 0.0, 0.0);

    for (let i = 0; i < RANDOM_POINTS_NUMBER; ++i) {
      const links: number[] = [];
      for (let j = 0; j < RANDOM_LINKS_COUNT; ++j) {
        links.push((i + j + Math.trunc(RANDOM_POINTS_NUMBER / 2) - Math.trunc(RANDOM_LINKS_COUNT / 2)) % RANDOM_POINTS_NUMBER);
      }
      this._validPointsVector.push(links);
    }

    const all: number[] = [];
    for (let i = 0; i < RANDOM_POINTS_NUMBER; ++i) all.push(i);
    this._validPointsVector.push(all);
  }

  /** @ac game/Movement/MovementGenerators/RandomMovementGenerator.h RandomMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return RANDOM_MOTION_TYPE;
  }

  /** Removes the `index`-th link of `_currentPoint` and forgets its path (the repeated `erase` of the C++). */
  private _eraseLink(index: number, pathIdx: number): void {
    this._validPointsVector[this._currentPoint]!.splice(index, 1);
    this._preComputedPaths.delete(pathIdx);
  }

  /** @ac game/Movement/MovementGenerators/RandomMovementGenerator.cpp RandomMovementGenerator<Creature>::_setRandomLocation */
  _setRandomLocation(creature: MovementOwnerCreature | null): void {
    if (!creature) return;

    if (creature._moveState !== MAP_OBJECT_CELL_MOVE_NONE) return;

    if (this._validPointsVector[this._currentPoint]!.length === 0) {
      if (this._currentPoint === RANDOM_POINTS_NUMBER)
        // cant go anywhere from initial position, lets stay
        return;
      // go back to initial position and will never return to this point
      this._currentPoint = RANDOM_POINTS_NUMBER;
      this._currDestPosition.relocate(this._initialPosition);
      creature.addUnitState(UNIT_STATE_ROAMING_MOVE);
      const init = new MoveSplineInit(creature);
      init.moveTo(this._currDestPosition.getPositionX(), this._currDestPosition.getPositionY(), this._currDestPosition.getPositionZ());

      let walk = true;
      switch (creature.getMovementTemplate().getRandom()) {
        case CreatureRandomMovementType.CanRun:
          walk = creature.isWalking();
          break;
        case CreatureRandomMovementType.AlwaysRun:
          walk = false;
          break;
        default:
          break;
      }

      init.setWalk(walk);
      init.launch();
      const formation = creature.getFormation();
      if (formation && formation.getLeader() === creature && formation.canLeaderStartMoving()) formation.leaderStartedMoving();
      return;
    }

    const links = this._validPointsVector[this._currentPoint]!;
    const random = urand(0, links.length - 1);
    const newPoint = links[random]!;
    const pathIdx = this._currentPoint * RANDOM_POINTS_NUMBER + newPoint;

    // cant go anywhere from new point, so dont go there to not be stuck
    if (this._validPointsVector[newPoint]!.length === 0) {
      links.splice(random, 1);
      return;
    }

    let finalPath = this._preComputedPaths.get(pathIdx);
    if (!finalPath) {
      finalPath = [];
      this._preComputedPaths.set(pathIdx, finalPath);
    }
    if (finalPath.length === 0) {
      const map = creature.getMap();
      const x = this._destinationPoints[newPoint]!.x;
      const y = this._destinationPoints[newPoint]!.y;
      const z = this._destinationPoints[newPoint]!.z;
      // invalid coordinates
      if (!IsValidMapCoord(x, y)) {
        this._eraseLink(random, pathIdx);
        return;
      }

      const ground = { value: INVALID_HEIGHT };
      const levelZ = creature.getMapWaterOrGroundLevel(x, y, z, ground);
      let newZ = INVALID_HEIGHT;

      // flying creature
      if (creature.canFly()) newZ = Math.max(levelZ, F(z + F(F(randNorm() * this._wanderDistance) / 2.0)));
      // point underwater
      else if (ground.value < levelZ) {
        if (!creature.canEnterWater()) {
          this._eraseLink(random, pathIdx);
          return;
        } else {
          if (levelZ > INVALID_HEIGHT) newZ = Math.min(F(levelZ - 2.0), F(z + F(F(randNorm() * this._wanderDistance) / 2.0)));
          newZ = Math.max(ground.value, newZ);
        }
      }
      // point on ground
      else if (levelZ <= INVALID_HEIGHT || !creature.canWalk()) {
        this._eraseLink(random, pathIdx);
        return;
      }

      newZ = creature.updateAllowedPositionZ(x, y, newZ);

      if (newZ > INVALID_HEIGHT) {
        // flying / swiming creature - dest not in los
        if (!creature.isWithinLOS(x, y, newZ)) {
          this._eraseLink(random, pathIdx);
          return;
        }

        finalPath.push(new Vector3(creature.getPositionX(), creature.getPositionY(), creature.getPositionZ()));
        finalPath.push(new Vector3(x, y, newZ));
      } else {
        // ground
        if (!this._pathGenerator) this._pathGenerator = new PathGenerator(creature);
        else this._pathGenerator.clear();

        const result = this._pathGenerator.calculatePath(x, y, levelZ, false);
        if (result && !(this._pathGenerator.getPathType() & PATHFIND_NOPATH)) {
          // generated path is too long
          const pathLen = this._pathGenerator.getPathLength();
          if (F(pathLen * pathLen) > F(F(creature.getExactDistSq(x, y, levelZ) * MAX_PATH_LENGHT_FACTOR) * MAX_PATH_LENGHT_FACTOR)) {
            this._eraseLink(random, pathIdx);
            return;
          }

          // `finalPath = _pathGenerator->GetPath()` copies the points
          finalPath.length = 0;
          for (const point of this._pathGenerator.getPath()) finalPath.push(new Vector3(point.x, point.y, point.z));

          for (let itr = 0, itrNext = 1; itrNext < finalPath.length; ++itr, ++itrNext) {
            const a = finalPath[itr]!;
            const b = finalPath[itrNext]!;
            const distDiff = F(Math.sqrt(F(F((a.x - b.x) * (a.x - b.x)) + F((a.y - b.y) * (a.y - b.y)))));
            const zDiff = F(Math.abs(a.z - b.z));

            // Xinef: tree climbing, cut as much as we can
            if (zDiff > 2.0 || (fuzzyNe(zDiff, 0.0) && F(distDiff / zDiff) < F(2.15))) {
              // ~25˚
              this._eraseLink(random, pathIdx);
              return;
            }

            if (!map.isInLineOfSight(a.x, a.y, a.z + 2.0, b.x, b.y, b.z + 2.0, creature.getPhaseMask(), LINEOFSIGHT_ALL_CHECKS, ModelIgnoreFlags.Nothing)) {
              this._eraseLink(random, pathIdx);
              return;
            }
          }

          // no valid path
          if (finalPath.length < 2) {
            this._eraseLink(random, pathIdx);
            return;
          }
        } else {
          this._eraseLink(random, pathIdx);
          return;
        }
      }
    }

    this._currentPoint = newPoint;
    if (finalPath.length === 0) throw new Error("RandomMovementGenerator::_setRandomLocation: empty final path");
    const finalPoint = finalPath[finalPath.length - 1]!;
    this._currDestPosition.relocate(finalPoint.x, finalPoint.y, finalPoint.z);

    creature.addUnitState(UNIT_STATE_ROAMING_MOVE);
    let walk = true;
    switch (creature.getMovementTemplate().getRandom()) {
      case CreatureRandomMovementType.CanRun:
        walk = creature.isWalking();
        break;
      case CreatureRandomMovementType.AlwaysRun:
        walk = false;
        break;
      default:
        break;
    }

    const init = new MoveSplineInit(creature);
    init.movebyPath(finalPath);
    init.setWalk(walk);
    init.launch();

    ++this._moveCount;
    if (rollChanceI(this._moveCount * 25 + 10)) {
      this._moveCount = 0;
      this._nextMoveTime.reset(urand(4000, 8000));
    }

    //Call for creature group update
    const formation = creature.getFormation();
    if (formation && formation.getLeader() === creature && formation.canLeaderStartMoving()) formation.leaderStartedMoving();

    if (sWorld().getBoolConfig(ServerConfig.CONFIG_DONT_CACHE_RANDOM_MOVEMENT_PATHS)) this._preComputedPaths.delete(pathIdx);
  }

  /** @ac game/Movement/MovementGenerators/RandomMovementGenerator.cpp RandomMovementGenerator<Creature>::DoInitialize */
  doInitialize(creature: MovementOwnerCreature): void {
    if (!creature.isAlive()) return;

    const creatureWanderDistance = F(creature.getWanderDistance());
    if (!this._wanderDistance) this._wanderDistance = creatureWanderDistance;

    this._nextMoveTime.reset(creature.getSpawnId() && creatureWanderDistance === this._wanderDistance ? urand(1, 5000) : 0);
    this._wanderDistance = Math.max(
      creatureWanderDistance === this._wanderDistance && creature.getInstanceId() === 0 ? (creature.canFly() ? MIN_WANDER_DISTANCE_AIR : MIN_WANDER_DISTANCE_GROUND) : 0.0,
      this._wanderDistance,
    );

    if (fuzzyEq(this._initialPosition.getExactDist2d(0.0, 0.0), 0.0)) {
      this._initialPosition.relocate(creature.getPositionX(), creature.getPositionY(), creature.getPositionZ(), creature.getOrientation());
      this._destinationPoints = [];
      for (let i = 0; i < RANDOM_POINTS_NUMBER; ++i) {
        const angle = F(((Math.PI * 2.0) / RANDOM_POINTS_NUMBER) * i);
        const factor = F(0.5 + randNorm() * 0.5);
        this._destinationPoints.push(
          new Vector3(
            F(this._initialPosition.getPositionX() + this._wanderDistance * Math.cos(angle) * factor),
            F(this._initialPosition.getPositionY() + this._wanderDistance * Math.sin(angle) * factor),
            F(this._initialPosition.getPositionZ()),
          ),
        );
      }
    }

    creature.addUnitState(UNIT_STATE_ROAMING | UNIT_STATE_ROAMING_MOVE);
  }

  /** @ac game/Movement/MovementGenerators/RandomMovementGenerator.cpp RandomMovementGenerator<Creature>::DoReset */
  doReset(creature: MovementOwnerCreature): void {
    this.doInitialize(creature);
  }

  /** @ac game/Movement/MovementGenerators/RandomMovementGenerator.cpp RandomMovementGenerator<Creature>::DoFinalize */
  doFinalize(creature: MovementOwnerCreature): void {
    creature.clearUnitState(UNIT_STATE_ROAMING | UNIT_STATE_ROAMING_MOVE);
  }

  /** @ac game/Movement/MovementGenerators/RandomMovementGenerator.cpp RandomMovementGenerator<Creature>::DoUpdate */
  doUpdate(creature: MovementOwnerCreature, diff: number): boolean {
    if (creature.hasUnitState(UNIT_STATE_NOT_MOVE) || creature.isMovementPreventedByCasting()) {
      this._nextMoveTime.reset(0); // Expire the timer
      creature.stopMoving();
      return true;
    }

    // xinef: if we got disable move flag, do not remove default generator - just prevent movement
    if (creature.hasUnitFlag(UNIT_FLAG_DISABLE_MOVE)) {
      this._nextMoveTime.reset(0); // Expire the timer
      creature.clearUnitState(UNIT_STATE_ROAMING_MOVE);
      return true;
    }

    if (creature.movespline.finalized()) {
      this._nextMoveTime.update(diff);
      if (this._nextMoveTime.passed()) this._setRandomLocation(creature);
    }
    return true;
  }

  /** @ac game/Movement/MovementGenerators/RandomMovementGenerator.cpp RandomMovementGenerator<Creature>::GetResetPosition */
  override getResetPosition(pos: ResetPosition): boolean {
    if (this._currentPoint < RANDOM_POINTS_NUMBER) {
      pos.x = this._currDestPosition.getPositionX();
      pos.y = this._currDestPosition.getPositionY();
      pos.z = this._currDestPosition.getPositionZ();
    } else if (fuzzyNe(this._initialPosition.getExactDist2d(0.0, 0.0), 0.0)) {
      // if initial position is not 0.0f, 0.0f
      pos.x = this._initialPosition.getPositionX();
      pos.y = this._initialPosition.getPositionY();
      pos.z = this._initialPosition.getPositionZ();
    } else return false;
    return true;
  }
}
