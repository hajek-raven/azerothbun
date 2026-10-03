/**
 * Port of `game/Movement/Spline/MoveSplineInit.{h,cpp}`: builds the `MoveSplineInitArgs` of a unit's next spline,
 * initializes `Unit::movespline` and sends the `SMSG_MONSTER_MOVE` / `SMSG_MONSTER_MOVE_TRANSPORT` packet.
 *
 * `Unit` is not a class of the port yet (a creature implements the grid-object interfaces only), so the members the C++
 * touches are the narrow interface `MoveSplineUnit`; a `Creature` / `Player` satisfies it when it keeps the camelCase C++
 * names. The packet goes out through `MoveSplineUnit.sendMessageToSet(packet, true)` only (`WorldObject::SendMessageToSet`);
 * this file never touches a socket.
 *
 * Overloads are one TypeScript method: `setFacing(Unit | angle | Vector3)` and `moveTo(start, dest, ...)` /
 * `moveTo(dest, ...)` / `moveTo(x, y, z, ...)` (told apart by the argument types). `AnimTier` is a number (`UnitDefines.ts`).
 * The `operator()` of `TransportPathTransform` and `HoverMovementTransform` is `call(input)`.
 *
 * @ac-skip game/Entities/Unit/Unit.h Unit: `MoveSplineUnit` below is the contract; `Creature` / `Player` satisfy it in the
 * integration step (`movespline`, `getSpeed`, `hasUnitMovementFlag`, `getDirectTransport`, `getVehicleBase`, `getPackGUID`, ...).
 * @ac-skip game/Entities/Object/Object.cpp MovementInfo::GetSpeedType: `Object.ts` skips it; `SelectSpeedType` below is the
 * same function (the C++ `Movement::SelectSpeedType` forwards to it), `MovementInfo.getSpeedType` should call this one.
 * @ac-skip game/Entities/Transport/Transport.h TransportBase::CalculatePassengerOffset: transports are not ported; a unit
 * returns `null` from `getDirectTransport()` until they are.
 */
import { SMSG_MONSTER_MOVE } from "../../../combat/constants.ts";
import { logTrace } from "../../../log.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { ByteWriter } from "../../../net/byte-buffer.ts";
import { ObjectGuid } from "../../Entities/Object/ObjectGuid.ts";
import type { PositionLike } from "../../Entities/Object/Position.ts";
import type { WorldPacket } from "../../Entities/Object/Updates/UpdateData.ts";
import {
  MOVE_FLIGHT,
  MOVE_FLIGHT_BACK,
  MOVE_RUN,
  MOVE_RUN_BACK,
  MOVE_SWIM,
  MOVE_SWIM_BACK,
  MOVE_WALK,
  MOVEMENTFLAG_BACKWARD,
  MOVEMENTFLAG_CAN_FLY,
  MOVEMENTFLAG_DISABLE_GRAVITY,
  MOVEMENTFLAG_FLYING,
  MOVEMENTFLAG_FORWARD,
  MOVEMENTFLAG_MASK_MOVING,
  MOVEMENTFLAG_ONTRANSPORT,
  MOVEMENTFLAG_ROOT,
  MOVEMENTFLAG_SPLINE_ENABLED,
  MOVEMENTFLAG_SWIMMING,
  MOVEMENTFLAG_WALKING,
  type UnitMoveType,
} from "../../Entities/Unit/UnitDefines.ts";
import { PATHFIND_NOPATH, PathGenerator, type PathSource } from "../MovementGenerators/PathGenerator.ts";
import { Location, type MoveSpline } from "./MoveSpline.ts";
import { MoveSplineInitArgs, type PointsArray } from "./MoveSplineInitArgs.ts";
import { MoveSplineFlag } from "./MoveSplineFlag.ts";
import { PacketBuilder } from "./MovementPacketBuilder.ts";
import { splineIdGen } from "./MovementUtil.ts";

const fround = Math.fround;

/** `SMSG_MONSTER_MOVE_TRANSPORT` (3.3.5a `Opcodes.h`); `SMSG_MONSTER_MOVE` comes from `combat/constants.ts`. */
export const SMSG_MONSTER_MOVE_TRANSPORT = 0x2ae;

/** @ac game/Entities/Object/Object.h MovementInfo (the members `MoveSplineInit` calls) */
export interface MoveSplineMovementInfo {
  /** @ac game/Entities/Object/Object.h MovementInfo::GetMovementFlags */
  getMovementFlags(): number;
  /** @ac game/Entities/Object/Object.h MovementInfo::SetMovementFlags */
  setMovementFlags(flag: number): void;
  /** @ac game/Entities/Object/Object.h MovementInfo::HasMovementFlag */
  hasMovementFlag(flag: number): boolean;
  /** @ac game/Entities/Object/Object.h MovementInfo::RemoveMovementFlag */
  removeMovementFlag(flag: number): void;
  /** @ac game/Entities/Object/Object.h MovementInfo::transport (`TransportInfo::pos`) */
  readonly transport: { readonly pos: PositionLike };
}

/** @ac game/Entities/Transport/TransportBase (`GetDirectTransport()` result; `CalculatePassengerOffset` writes `x, y, z` in place) */
export interface MoveSplineTransportBase {
  /** `void CalculatePassengerOffset(float& x, float& y, float& z, float* o = nullptr) const`; `pos` is changed in place. @ac game/Entities/Transport/Transport.h Transport::CalculatePassengerOffset */
  calculatePassengerOffset(pos: Vector3): void;
}

/**
 * The `Unit` members `MoveSplineInit` reads or calls. `PathSource` is the part `PathGenerator(unit)` needs (position,
 * map, phase, guid, `ToUnit` / `ToCreature`, ...).
 * @ac game/Entities/Unit/Unit.h Unit
 */
export interface MoveSplineUnit extends PathSource {
  /** `std::unique_ptr<Movement::MoveSpline> movespline` @ac game/Entities/Unit/Unit.h Unit::movespline */
  readonly movespline: MoveSpline;
  /** @ac game/Entities/Object/Object.h WorldObject::m_movementInfo */
  readonly m_movementInfo: MoveSplineMovementInfo;
  /** @ac game/Entities/Object/Position.h Position::GetOrientation */
  getOrientation(): number;
  /** @ac game/Entities/Unit/Unit.h Unit::HasUnitMovementFlag */
  hasUnitMovementFlag(f: number): boolean;
  /** @ac game/Entities/Object/Object.cpp WorldObject::GetTransGUID (0n when not on a transport) */
  getTransGUID(): bigint;
  /** @ac game/Entities/Object/Object.h WorldObject::GetTransSeat */
  getTransSeat(): number;
  /** the packed guid bytes @ac game/Entities/Object/Object.h Object::GetPackGUID */
  getPackGUID(): Uint8Array;
  /** @ac game/Entities/Unit/Unit.h Unit::GetSpeed */
  getSpeed(mtype: UnitMoveType): number;
  /** @ac game/Entities/Object/Object.h Object::GetEntry (only for the trace log) */
  getEntry(): number;
  /** @ac game/Entities/Unit/Unit.h Unit::IsImmobilizedState (only for the trace log) */
  isImmobilizedState(): boolean;
  /** @ac game/Entities/Object/Object.cpp WorldObject::SendMessageToSet (the only way the packet leaves) */
  sendMessageToSet(data: WorldPacket, self: boolean): void;
  /** @ac game/Entities/Unit/Unit.h Unit::GetVehicleBase */
  getVehicleBase(): { getOrientation(): number } | null;
  /** @ac game/Entities/Object/Object.h WorldObject::GetTransport */
  getTransport(): { getOrientation(): number } | null;
  /** @ac game/Entities/Unit/Unit.h Unit::GetDirectTransport (the transport or vehicle the unit is on directly) */
  getDirectTransport(): MoveSplineTransportBase | null;
}

/** @ac game/Movement/Spline/MoveSplineInit.cpp Movement::SelectSpeedType (`MovementInfo::GetSpeedType(moveFlags)`) */
export function SelectSpeedType(moveFlags: number): UnitMoveType {
  // @ac game/Entities/Object/Object.cpp MovementInfo::GetSpeedType
  if (moveFlags & MOVEMENTFLAG_FLYING) {
    if (moveFlags & MOVEMENTFLAG_BACKWARD) return MOVE_FLIGHT_BACK;

    return MOVE_FLIGHT;
  } else if (moveFlags & MOVEMENTFLAG_SWIMMING) {
    if (moveFlags & MOVEMENTFLAG_BACKWARD) return MOVE_SWIM_BACK;

    return MOVE_SWIM;
  } else if (moveFlags & MOVEMENTFLAG_WALKING) return MOVE_WALK;
  else if (moveFlags & MOVEMENTFLAG_BACKWARD) return MOVE_RUN_BACK;

  return MOVE_RUN;
}

/** Transforms coordinates from global to transport offsets @ac game/Movement/Spline/MoveSplineInit.h Movement::TransportPathTransform */
export class TransportPathTransform {
  constructor(
    private readonly _owner: MoveSplineUnit,
    private readonly _transformForTransport: boolean,
  ) {}

  /** `Vector3 operator()(Vector3 input)` (input is taken by value: a copy is returned) @ac game/Movement/Spline/MoveSplineInit.cpp TransportPathTransform::operator() */
  call(input: Vector3): Vector3 {
    const out = input.clone();
    if (this._transformForTransport) {
      const transport = this._owner.getDirectTransport();
      if (transport) transport.calculatePassengerOffset(out);
    }

    return out;
  }
}

/** Xinef: transforms z coordinate with hover offset @ac game/Movement/Spline/MoveSplineInit.h Movement::HoverMovementTransform */
export class HoverMovementTransform {
  constructor(private readonly _offset: number) {}

  /** `Vector3 operator()(Vector3 input)` */
  call(input: Vector3): Vector3 {
    const out = input.clone();
    out.z = fround(out.z + this._offset);
    return out;
  }
}

/** `G3D::wrap(float t, float lo, float hi)` @ac deps/g3dlite/include/G3D/g3dmath.h G3D::wrap */
function wrap(t: number, lo: number, hi: number): number {
  t = fround(t);
  if (t >= lo && t < hi) return t;

  const interval = fround(hi - lo);

  return fround(t - fround(interval * Math.floor(fround(fround(t - lo) / interval))));
}

/** `args.path.resize(n)`: the first elements stay, new ones are `Vector3()`. */
function resizePath(path: PointsArray, n: number): void {
  if (path.length > n) path.length = n;
  while (path.length < n) path.push(new Vector3());
}

/**
 * Initializes and launches spline movement
 * @ac game/Movement/Spline/MoveSplineInit.h Movement::MoveSplineInit
 */
export class MoveSplineInit {
  /** protected in C++ */
  readonly args = new MoveSplineInitArgs();
  /** protected in C++ */
  protected readonly unit: MoveSplineUnit;

  /** @ac game/Movement/Spline/MoveSplineInit.cpp MoveSplineInit::MoveSplineInit */
  constructor(m: MoveSplineUnit) {
    this.unit = m;
    this.args.splineId = splineIdGen.newId();
    this.args.TransformForTransport = this.unit.hasUnitMovementFlag(MOVEMENTFLAG_ONTRANSPORT) && this.unit.getTransGUID() !== 0n;
    // mix existing state into new
    this.args.walk = this.unit.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_WALKING);
    this.args.flags.flying = this.unit.m_movementInfo.hasMovementFlag(MOVEMENTFLAG_CAN_FLY | MOVEMENTFLAG_DISABLE_GRAVITY);
  }

  /** The position the spline starts from / is stopped at: `(x, y, z, orientation)` of the unit or its transport offset. */
  private currentLocation(transport: boolean): Location {
    const pos: PositionLike = !transport ? this.unit : this.unit.m_movementInfo.transport.pos;

    return new Location(fround(pos.getPositionX()), fround(pos.getPositionY()), fround(pos.getPositionZ()), fround(this.unit.getOrientation()));
  }

  /**
   * Final pass of initialization that launches spline movement.
   * @ac game/Movement/Spline/MoveSplineInit.cpp MoveSplineInit::Launch
   */
  launch(): number {
    const move_spline = this.unit.movespline;
    const args = this.args;

    const transport = this.unit.hasUnitMovementFlag(MOVEMENTFLAG_ONTRANSPORT) && this.unit.getTransGUID() !== 0n;
    let real_position: Location;
    // there is a big chance that current position is unknown if current state is not finalized, need compute it
    // this also allows CalculatePath spline position and update map position in much greater intervals
    // Don't compute for transport movement if the unit is in a motion between two transports
    if (!move_spline.finalized() && move_spline.onTransport === transport) real_position = move_spline.computePosition();
    else real_position = this.currentLocation(transport);

    // should i do the things that user should do? - no.
    if (args.path.length === 0) return 0;

    // corrent first vertex
    args.path[0] = new Vector3(real_position.x, real_position.y, real_position.z);
    args.initialOrientation = real_position.orientation;
    move_spline.onTransport = transport;

    let moveFlags = this.unit.m_movementInfo.getMovementFlags();
    moveFlags = (moveFlags | MOVEMENTFLAG_SPLINE_ENABLED) >>> 0;

    if (!args.flags.orientationInversed) {
      moveFlags = (((moveFlags & ~MOVEMENTFLAG_BACKWARD) >>> 0) | MOVEMENTFLAG_FORWARD) >>> 0;
    } else {
      moveFlags = (((moveFlags & ~MOVEMENTFLAG_FORWARD) >>> 0) | MOVEMENTFLAG_BACKWARD) >>> 0;
    }

    const isOrientationOnly = args.path.length === 2 && args.path[0]!.equals(args.path[1]!);

    if (moveFlags & MOVEMENTFLAG_ROOT) {
      // This case should essentially never occur - hence the trace logging - hints to issues elsewhere
      logTrace(
        "movement",
        () => `Invalid movement during root. Entry: ${this.unit.getEntry()} IsImmobilized ${this.unit.isImmobilizedState() ? "true" : "false"}, moveflags ${moveFlags}`,
      );
      moveFlags = (moveFlags & ~MOVEMENTFLAG_MASK_MOVING) >>> 0;
    }

    if (isOrientationOnly) moveFlags = (moveFlags & ~MOVEMENTFLAG_MASK_MOVING) >>> 0;

    if (!args.HasVelocity) {
      // If spline is initialized with SetWalk method it only means we need to select
      // walk move speed for it but not add walk flag to unit
      let moveFlagsForSpeed = moveFlags;
      if (args.walk) moveFlagsForSpeed = (moveFlagsForSpeed | MOVEMENTFLAG_WALKING) >>> 0;
      else moveFlagsForSpeed = (moveFlagsForSpeed & ~MOVEMENTFLAG_WALKING) >>> 0;

      args.velocity = fround(this.unit.getSpeed(SelectSpeedType(moveFlagsForSpeed)));
    }

    // limit the speed in the same way the client does
    args.velocity = Math.min(
      fround(args.velocity),
      args.flags.catmullrom || args.flags.flying ? 50.0 : Math.max(28.0, fround(fround(this.unit.getSpeed(MOVE_RUN)) * 4.0)),
    );

    if (!args.Validate(this.unit)) return 0;

    this.unit.m_movementInfo.setMovementFlags(moveFlags);
    move_spline.initialize(args);

    const data = new ByteWriter();
    data.writeBytes(this.unit.getPackGUID());
    let opcode = SMSG_MONSTER_MOVE;
    if (transport) {
      opcode = SMSG_MONSTER_MOVE_TRANSPORT;
      data.writeBytes(ObjectGuid.WriteAsPacked(this.unit.getTransGUID()));
      data.writeU8(this.unit.getTransSeat() & 0xff);
    }

    PacketBuilder.writeMonsterMove(move_spline, data);
    this.unit.sendMessageToSet({ opcode, payload: data.toUint8Array() }, true);

    return move_spline.duration();
  }

  /**
   * Final pass of initialization that stops movement.
   * @ac game/Movement/Spline/MoveSplineInit.cpp MoveSplineInit::Stop
   */
  stop(): void {
    const move_spline = this.unit.movespline;

    // No need to stop if we are not moving
    if (move_spline.finalized()) return;

    const transport = this.unit.hasUnitMovementFlag(MOVEMENTFLAG_ONTRANSPORT) && this.unit.getTransGUID() !== 0n;
    let loc: Location;
    if (move_spline.onTransport === transport) loc = move_spline.computePosition();
    else loc = this.currentLocation(transport);

    this.args.flags = new MoveSplineFlag(MoveSplineFlag.Done);
    this.unit.m_movementInfo.removeMovementFlag(MOVEMENTFLAG_FORWARD | MOVEMENTFLAG_BACKWARD | MOVEMENTFLAG_SPLINE_ENABLED);
    move_spline.onTransport = transport;
    move_spline.initialize(this.args);

    const data = new ByteWriter();
    data.writeBytes(this.unit.getPackGUID());
    let opcode = SMSG_MONSTER_MOVE;
    if (transport) {
      opcode = SMSG_MONSTER_MOVE_TRANSPORT;
      data.writeBytes(ObjectGuid.WriteAsPacked(this.unit.getTransGUID()));
      data.writeU8(this.unit.getTransSeat() & 0xff);
    }

    PacketBuilder.writeStopMovement(loc, this.args.splineId, data);
    this.unit.sendMessageToSet({ opcode, payload: data.toUint8Array() }, true);
  }

  /**
   * Adds movement by parabolic trajectory
   * @param amplitude  - the maximum height of parabola, value could be negative and positive
   * @param time_shift - delay between movement starting time and beginning to move by parabolic trajectory
   * can't be combined with final animation
   * @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::SetParabolic
   */
  setParabolic(amplitude: number, time_shift: number): void {
    this.args.time_perc = fround(time_shift);
    this.args.parabolic_amplitude = fround(amplitude);
    this.args.flags.enableParabolic();
  }

  /**
   * Plays animation after movement done, can't be combined with parabolic movement
   * @param anim an `AnimTier` (`uint8`)
   * @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::SetAnimation
   */
  setAnimation(anim: number): void {
    this.args.time_perc = 0.0;
    this.args.flags.enableAnimation(anim & 0xff);
  }

  /**
   * Adds final facing animation: sets unit's facing to specified point/angle after all path done; you can have only one
   * final facing: previous will be overriden. `SetFacing(float angle)`, `SetFacing(Vector3 const& point)` and
   * `SetFacing(Unit const* target)`.
   * @ac game/Movement/Spline/MoveSplineInit.cpp MoveSplineInit::SetFacing
   */
  setFacing(facing: number | Vector3 | { getGUID(): bigint }): void {
    if (typeof facing === "number") {
      let angle = fround(facing);
      if (this.args.TransformForTransport) {
        const vehicle = this.unit.getVehicleBase();
        if (vehicle) angle = fround(angle - fround(vehicle.getOrientation()));
        else {
          const transport = this.unit.getTransport();
          if (transport) angle = fround(angle - fround(transport.getOrientation()));
        }
      }

      this.args.facing.angle = wrap(angle, 0.0, fround(2 * Math.PI));
      this.args.flags.enableFacingAngle();
    } else if (facing instanceof Vector3) {
      const transform = new TransportPathTransform(this.unit, this.args.TransformForTransport);
      const finalSpot = transform.call(facing);
      this.args.facing.f.x = fround(finalSpot.x);
      this.args.facing.f.y = fround(finalSpot.y);
      this.args.facing.f.z = fround(finalSpot.z);
      this.args.flags.enableFacingPoint();
    } else {
      this.args.flags.enableFacingTarget();
      this.args.facing.target = facing.getGUID();
    }
  }

  /**
   * Initializes movement by path
   * @param controls - array of points, shouldn't be empty
   * @param path_offset - Id of fisrt point of the path. Example: when third path point will be done it will notify that pointId + 3 done
   * @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::MovebyPath
   */
  movebyPath(controls: readonly Vector3[], path_offset = 0): void {
    this.args.path_Idx_offset = path_offset;
    resizePath(this.args.path, controls.length);
    const transform = new TransportPathTransform(this.unit, this.args.TransformForTransport);
    for (let i = 0; i < controls.length; ++i) this.args.path[i] = transform.call(controls[i]!);
  }

  /**
   * Initializes simple A to B motion, A is current unit's position, B is destination.
   * `moveTo(start, destination, generatePath = true, forceDestination = false)`,
   * `moveTo(destination, generatePath = false, forceDestination = false)` and
   * `moveTo(x, y, z, generatePath = false, forceDestination = false)`.
   * @ac game/Movement/Spline/MoveSplineInit.cpp MoveSplineInit::MoveTo
   */
  moveTo(start: Vector3, destination: Vector3, generatePath?: boolean, forceDestination?: boolean): void;
  moveTo(destination: Vector3, generatePath?: boolean, forceDestination?: boolean): void;
  moveTo(x: number, y: number, z: number, generatePath?: boolean, forceDestination?: boolean): void;
  moveTo(a: Vector3 | number, b?: Vector3 | number | boolean, c?: number | boolean, d?: boolean, e?: boolean): void {
    if (typeof a === "number") {
      this.moveToDestination(new Vector3(a, b as number, c as number), d ?? false, e ?? false);
    } else if (b instanceof Vector3) {
      this.moveToStartDestination(a, b, (c as boolean | undefined) ?? true, d ?? false);
    } else {
      this.moveToDestination(a, (b as boolean | undefined) ?? false, (c as boolean | undefined) ?? false);
    }
  }

  /** `MoveTo(Vector3 const& start, Vector3 const& dest, bool generatePath, bool forceDestination)` */
  private moveToStartDestination(start: Vector3, dest: Vector3, generatePath: boolean, forceDestination: boolean): void {
    if (generatePath) {
      const path = new PathGenerator(this.unit);
      const result = path.calculatePath(start.x, start.y, start.z, dest.x, dest.y, dest.z, forceDestination);
      if (result && !(path.getPathType() & PATHFIND_NOPATH)) {
        this.movebyPath(path.getPath());
        return;
      }
    }

    this.args.path_Idx_offset = 0;
    resizePath(this.args.path, 2);
    const transform = new TransportPathTransform(this.unit, this.args.TransformForTransport);
    this.args.path[1] = transform.call(dest);
  }

  /** `MoveTo(Vector3 const& dest, bool generatePath, bool forceDestination)` */
  private moveToDestination(dest: Vector3, generatePath: boolean, forceDestination: boolean): void {
    if (generatePath) {
      const path = new PathGenerator(this.unit);
      const result = path.calculatePath(dest.x, dest.y, dest.z, forceDestination);
      if (result && !(path.getPathType() & PATHFIND_NOPATH)) {
        this.movebyPath(path.getPath());
        return;
      }
    }

    this.args.path_Idx_offset = 0;
    resizePath(this.args.path, 2);
    const transform = new TransportPathTransform(this.unit, this.args.TransformForTransport);
    this.args.path[1] = transform.call(dest);
  }

  /**
   * Sets Id of fisrt point of the path. When N-th path point will be done ILisener will notify that pointId + N done.
   * Needed for waypoint movement where path splitten into parts
   * @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::SetFirstPointId
   */
  setFirstPointId(pointId: number): void {
    this.args.path_Idx_offset = pointId;
  }

  /**
   * Enables CatmullRom spline interpolation mode, enables flying animation. Disabled by default
   * @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::SetFly
   */
  setFly(): void {
    this.args.flags.enableFlying();
  }

  /** Enables walk mode. Disabled by default @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::SetWalk */
  setWalk(enable: boolean): void {
    this.args.walk = enable;
  }

  /**
   * Enables CatmullRom spline interpolation mode(makes path smooth); if not enabled linear spline mode will be choosen. Disabled by default
   * @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::SetSmooth
   */
  setSmooth(): void {
    this.args.flags.enableCatmullRom();
  }

  /** Makes movement cyclic. Disabled by default @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::SetCyclic */
  setCyclic(): void {
    this.args.flags.cyclic = true;
  }

  /** Enables falling mode. Disabled by default @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::SetFall */
  setFall(): void {
    this.args.flags.enableFalling();
  }

  /** Enters transport. Disabled by default @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::SetTransportEnter */
  setTransportEnter(): void {
    this.args.flags.enableTransportEnter();
  }

  /** Exits transport. Disabled by default @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::SetTransportExit */
  setTransportExit(): void {
    this.args.flags.enableTransportExit();
  }

  /** Inverses unit model orientation. Disabled by default @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::SetOrientationInversed */
  setOrientationInversed(): void {
    this.args.flags.orientationInversed = true;
  }

  /** Fixes unit's model rotation. Disabled by default @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::SetOrientationFixed */
  setOrientationFixed(enable: boolean): void {
    this.args.flags.orientationFixed = enable;
  }

  /**
   * Sets the velocity (in case you want to have custom movement velocity); if no set, speed will be selected based on
   * unit's speeds and current movement mode. Has no effect if falling mode enabled. velocity shouldn't be negative
   * @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::SetVelocity
   */
  setVelocity(vel: number): void {
    this.args.velocity = fround(vel);
    this.args.HasVelocity = true;
  }

  /** @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::Path */
  path(): PointsArray {
    return this.args.path;
  }

  /** Disables transport coordinate transformations for cases where raw offsets are available @ac game/Movement/Spline/MoveSplineInit.h MoveSplineInit::DisableTransportPathTransformations */
  disableTransportPathTransformations(): void {
    this.args.TransformForTransport = false;
  }
}
