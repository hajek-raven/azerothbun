/** Test helper: a fake `MoveSplineUnit` that records the packets `MoveSplineInit` sends. */
import { Vector3 } from "../../../math/Vector3.ts";
import type { WorldPacket } from "../../Entities/Object/Updates/UpdateData.ts";
import { ObjectGuid } from "../../Entities/Object/ObjectGuid.ts";
import { MOVE_RUN, MOVE_WALK } from "../../Entities/Unit/UnitDefines.ts";
import { fakeCreature, fakeMap, fakeSource } from "../MovementGenerators/test-path-source.ts";
import { MoveSpline } from "./MoveSpline.ts";
import type { MoveSplineMovementInfo, MoveSplineTransportBase, MoveSplineUnit } from "./MoveSplineInit.ts";

export interface FakeMoveUnitOptions {
  guid?: bigint;
  pos?: [number, number, number];
  orientation?: number;
  flags?: number;
  transGuid?: bigint;
  transSeat?: number;
  transPos?: [number, number, number];
  speeds?: Record<number, number>;
  vehicleOrientation?: number;
  transportOrientation?: number;
  directTransport?: MoveSplineTransportBase | null;
}

export interface FakeMoveUnit extends MoveSplineUnit {
  sent: WorldPacket[];
  flags: number;
}

/** A unit at `pos` with run speed 7 and walk speed 2.5 (the creature defaults). */
export function fakeMoveUnit(opts: FakeMoveUnitOptions = {}): FakeMoveUnit {
  const pos = opts.pos ?? [0, 0, 0];
  const guid = opts.guid ?? 1n;
  const speeds: Record<number, number> = { [MOVE_WALK]: 2.5, [MOVE_RUN]: 7, 2: 4.5, 3: 4.722222, 4: 2.5, 6: 7, 7: 4.5, ...opts.speeds };
  const transPos = opts.transPos ?? [0, 0, 0];
  const base = fakeSource(fakeMap(), pos, fakeCreature(), 0);
  const info = {
    flags: opts.flags ?? 0,
    transport: {
      pos: {
        getPositionX: () => transPos[0],
        getPositionY: () => transPos[1],
        getPositionZ: () => transPos[2],
        getOrientation: () => 0,
      },
    },
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
  };
  const sent: WorldPacket[] = [];
  const unit: FakeMoveUnit = {
    ...base,
    getGUID: () => guid,
    sent,
    get flags() {
      return info.flags;
    },
    movespline: new MoveSpline(),
    m_movementInfo: info as MoveSplineMovementInfo,
    getOrientation: () => opts.orientation ?? 0,
    hasUnitMovementFlag: (f) => (info.flags & f) !== 0,
    getTransGUID: () => opts.transGuid ?? 0n,
    getTransSeat: () => opts.transSeat ?? -1,
    getPackGUID: () => ObjectGuid.WriteAsPacked(guid),
    getSpeed: (t) => Math.fround(speeds[t] ?? 7),
    getEntry: () => 1,
    isImmobilizedState: () => false,
    sendMessageToSet: (data) => {
      sent.push(data);
    },
    getVehicleBase: () => (opts.vehicleOrientation === undefined ? null : { getOrientation: () => opts.vehicleOrientation! }),
    getTransport: () => (opts.transportOrientation === undefined ? null : { getOrientation: () => opts.transportOrientation! }),
    getDirectTransport: () => opts.directTransport ?? null,
  };
  return unit;
}

export function v(x: number, y: number, z: number): Vector3 {
  return new Vector3(x, y, z);
}

/** Bytes as lowercase hex, two digits each, no separators. */
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The little endian hex of a float32. */
export function f32hex(value: number): string {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, value, true);
  return hex(b);
}

/** The little endian hex of a uint32. */
export function u32hex(value: number): string {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value >>> 0, true);
  return hex(b);
}
