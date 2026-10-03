/**
 * @ac game/Entities/Object/Updates/UpdateData.h UpdateData
 * The blocks of one `SMSG_UPDATE_OBJECT`: an out-of-range guid list followed by create/values/movement blocks.
 */
import { ByteWriter } from "../../../../net/byte-buffer.ts";
import { SMSG_UPDATE_OBJECT } from "../../../../world/packets.ts";
import { ObjectGuid } from "../ObjectGuid.ts";

/**
 * A server packet: opcode and body (the port has no `WorldPacket` class; the session encodes and encrypts the header).
 * `Player::SendDirectMessage` takes one of these.
 */
export type WorldPacket = { readonly opcode: number; readonly payload: Uint8Array };

/** @ac game/Entities/Object/Updates/UpdateData.h OBJECT_UPDATE_TYPE */
export const UPDATETYPE_VALUES = 0;
export const UPDATETYPE_MOVEMENT = 1;
export const UPDATETYPE_CREATE_OBJECT = 2;
export const UPDATETYPE_CREATE_OBJECT2 = 3;
export const UPDATETYPE_OUT_OF_RANGE_OBJECTS = 4;
export const UPDATETYPE_NEAR_OBJECTS = 5;

/** @ac game/Entities/Object/Updates/UpdateData.h OBJECT_UPDATE_FLAGS */
export const UPDATEFLAG_NONE = 0x0000;
export const UPDATEFLAG_SELF = 0x0001;
export const UPDATEFLAG_TRANSPORT = 0x0002;
export const UPDATEFLAG_HAS_TARGET = 0x0004;
export const UPDATEFLAG_UNKNOWN = 0x0008;
export const UPDATEFLAG_LOWGUID = 0x0010;
export const UPDATEFLAG_LIVING = 0x0020;
export const UPDATEFLAG_STATIONARY_POSITION = 0x0040;
export const UPDATEFLAG_VEHICLE = 0x0080;
export const UPDATEFLAG_POSITION = 0x0100;
export const UPDATEFLAG_ROTATION = 0x0200;

export class UpdateData {
  protected m_blockCount = 0;
  protected readonly m_outOfRangeGUIDs: bigint[] = [];
  protected m_data: Uint8Array[] = [];

  /** @ac game/Entities/Object/Updates/UpdateData.cpp UpdateData::AddOutOfRangeGUID */
  addOutOfRangeGUID(guid: bigint): void {
    this.m_outOfRangeGUIDs.push(guid);
  }

  /** @ac game/Entities/Object/Updates/UpdateData.cpp UpdateData::AddUpdateBlock (a `ByteBuffer` block or another `UpdateData`) */
  addUpdateBlock(block: Uint8Array | UpdateData): void {
    if (block instanceof UpdateData) {
      this.m_data.push(...block.m_data);
      this.m_blockCount += block.m_blockCount;
      return;
    }
    this.m_data.push(block);
    ++this.m_blockCount;
  }

  /** @ac game/Entities/Object/Updates/UpdateData.cpp UpdateData::BuildPacket */
  buildPacket(): WorldPacket {
    const packet = new ByteWriter();
    packet.writeU32(this.m_outOfRangeGUIDs.length > 0 ? this.m_blockCount + 1 : this.m_blockCount);

    if (this.m_outOfRangeGUIDs.length > 0) {
      packet.writeU8(UPDATETYPE_OUT_OF_RANGE_OBJECTS);
      packet.writeU32(this.m_outOfRangeGUIDs.length);

      for (const guid of this.m_outOfRangeGUIDs) packet.writeBytes(ObjectGuid.WriteAsPacked(guid));
    }

    for (const block of this.m_data) packet.writeBytes(block);
    return { opcode: SMSG_UPDATE_OBJECT, payload: packet.toUint8Array() };
  }

  /** @ac game/Entities/Object/Updates/UpdateData.h UpdateData::HasData */
  hasData(): boolean {
    return this.m_blockCount > 0 || this.m_outOfRangeGUIDs.length > 0;
  }

  /** @ac game/Entities/Object/Updates/UpdateData.cpp UpdateData::Clear */
  clear(): void {
    this.m_data = [];
    this.m_outOfRangeGUIDs.length = 0;
    this.m_blockCount = 0;
  }

  /** The guids queued as out of range (tests and the integration's logging). */
  getOutOfRangeGUIDs(): readonly bigint[] {
    return this.m_outOfRangeGUIDs;
  }

  /** The number of create/values/movement blocks queued. */
  getBlockCount(): number {
    return this.m_blockCount;
  }
}
