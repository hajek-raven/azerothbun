/**
 * The movement enums of `game/Entities/Unit/UnitDefines.h` (`UnitMoveType`, `MovementFlags`, `MovementFlags2`) and
 * `AnimTier` (`game/Movement/MotionMaster.h`). The rest of `UnitDefines.h` is not ported here.
 */

/** @ac game/Entities/Unit/UnitDefines.h UnitMoveType */
export const MOVE_WALK = 0;
export const MOVE_RUN = 1;
export const MOVE_RUN_BACK = 2;
export const MOVE_SWIM = 3;
export const MOVE_SWIM_BACK = 4;
export const MOVE_TURN_RATE = 5;
export const MOVE_FLIGHT = 6;
export const MOVE_FLIGHT_BACK = 7;
export const MOVE_PITCH_RATE = 8;
/** @ac game/Entities/Unit/UnitDefines.h MAX_MOVE_TYPE */
export const MAX_MOVE_TYPE = 9;
export type UnitMoveType = number;

/** @ac game/Entities/Unit/UnitDefines.h MovementFlags */
export const MOVEMENTFLAG_NONE = 0x00000000;
export const MOVEMENTFLAG_FORWARD = 0x00000001;
export const MOVEMENTFLAG_BACKWARD = 0x00000002;
export const MOVEMENTFLAG_STRAFE_LEFT = 0x00000004;
export const MOVEMENTFLAG_STRAFE_RIGHT = 0x00000008;
export const MOVEMENTFLAG_LEFT = 0x00000010;
export const MOVEMENTFLAG_RIGHT = 0x00000020;
export const MOVEMENTFLAG_PITCH_UP = 0x00000040;
export const MOVEMENTFLAG_PITCH_DOWN = 0x00000080;
/** Walking */
export const MOVEMENTFLAG_WALKING = 0x00000100;
/** Used for flying on some creatures */
export const MOVEMENTFLAG_ONTRANSPORT = 0x00000200;
/** Former MOVEMENTFLAG_LEVITATING. This is used when walking is not possible. */
export const MOVEMENTFLAG_DISABLE_GRAVITY = 0x00000400;
/** Must not be set along with MOVEMENTFLAG_MASK_MOVING */
export const MOVEMENTFLAG_ROOT = 0x00000800;
/** damage dealt on that type of falling */
export const MOVEMENTFLAG_FALLING = 0x00001000;
export const MOVEMENTFLAG_FALLING_FAR = 0x00002000;
export const MOVEMENTFLAG_PENDING_STOP = 0x00004000;
export const MOVEMENTFLAG_PENDING_STRAFE_STOP = 0x00008000;
export const MOVEMENTFLAG_PENDING_FORWARD = 0x00010000;
export const MOVEMENTFLAG_PENDING_BACKWARD = 0x00020000;
export const MOVEMENTFLAG_PENDING_STRAFE_LEFT = 0x00040000;
export const MOVEMENTFLAG_PENDING_STRAFE_RIGHT = 0x00080000;
export const MOVEMENTFLAG_PENDING_ROOT = 0x00100000;
/** appears with fly flag also */
export const MOVEMENTFLAG_SWIMMING = 0x00200000;
/** press "space" when flying */
export const MOVEMENTFLAG_ASCENDING = 0x00400000;
export const MOVEMENTFLAG_DESCENDING = 0x00800000;
/** Appears when unit can fly AND also walk */
export const MOVEMENTFLAG_CAN_FLY = 0x01000000;
/** unit is actually flying. pretty sure this is only used for players. creatures use disable_gravity */
export const MOVEMENTFLAG_FLYING = 0x02000000;
/** used for flight paths */
export const MOVEMENTFLAG_SPLINE_ELEVATION = 0x04000000;
/** used for flight paths */
export const MOVEMENTFLAG_SPLINE_ENABLED = 0x08000000;
/** prevent unit from falling through water */
export const MOVEMENTFLAG_WATERWALKING = 0x10000000;
/** active rogue safe fall spell (passive) */
export const MOVEMENTFLAG_FALLING_SLOW = 0x20000000;
/** hover, cannot jump */
export const MOVEMENTFLAG_HOVER = 0x40000000;

/** @todo: Check if PITCH_UP and PITCH_DOWN really belong here.. @ac game/Entities/Unit/UnitDefines.h MOVEMENTFLAG_MASK_MOVING */
export const MOVEMENTFLAG_MASK_MOVING =
  (MOVEMENTFLAG_FORWARD |
    MOVEMENTFLAG_BACKWARD |
    MOVEMENTFLAG_STRAFE_LEFT |
    MOVEMENTFLAG_STRAFE_RIGHT |
    MOVEMENTFLAG_PITCH_UP |
    MOVEMENTFLAG_PITCH_DOWN |
    MOVEMENTFLAG_FALLING |
    MOVEMENTFLAG_FALLING_FAR |
    MOVEMENTFLAG_ASCENDING |
    MOVEMENTFLAG_DESCENDING |
    MOVEMENTFLAG_SPLINE_ELEVATION) >>>
  0;
/** @ac game/Entities/Unit/UnitDefines.h MOVEMENTFLAG_MASK_TURNING */
export const MOVEMENTFLAG_MASK_TURNING = MOVEMENTFLAG_LEFT | MOVEMENTFLAG_RIGHT;
/** @ac game/Entities/Unit/UnitDefines.h MOVEMENTFLAG_MASK_MOVING_FLY */
export const MOVEMENTFLAG_MASK_MOVING_FLY = MOVEMENTFLAG_FLYING | MOVEMENTFLAG_ASCENDING | MOVEMENTFLAG_DESCENDING;
/** @todo if needed: add more flags to this masks that are exclusive to players @ac game/Entities/Unit/UnitDefines.h MOVEMENTFLAG_MASK_PLAYER_ONLY */
export const MOVEMENTFLAG_MASK_PLAYER_ONLY = MOVEMENTFLAG_FLYING;
/** @ac game/Entities/Unit/UnitDefines.h MOVEMENTFLAG_MASK_MOVING_OR_TURN */
export const MOVEMENTFLAG_MASK_MOVING_OR_TURN = (MOVEMENTFLAG_MASK_MOVING | MOVEMENTFLAG_MASK_TURNING) >>> 0;
/** Movement flags that have change status opcodes associated for players @ac game/Entities/Unit/UnitDefines.h MOVEMENTFLAG_MASK_HAS_PLAYER_STATUS_OPCODE */
export const MOVEMENTFLAG_MASK_HAS_PLAYER_STATUS_OPCODE =
  MOVEMENTFLAG_DISABLE_GRAVITY | MOVEMENTFLAG_ROOT | MOVEMENTFLAG_CAN_FLY | MOVEMENTFLAG_WATERWALKING | MOVEMENTFLAG_FALLING_SLOW | MOVEMENTFLAG_HOVER;

/** @ac game/Entities/Unit/UnitDefines.h MovementFlags2 */
export const MOVEMENTFLAG2_NONE = 0x00000000;
export const MOVEMENTFLAG2_NO_STRAFE = 0x00000001;
export const MOVEMENTFLAG2_NO_JUMPING = 0x00000002;
/** Overrides various clientside checks */
export const MOVEMENTFLAG2_UNK3 = 0x00000004;
export const MOVEMENTFLAG2_FULL_SPEED_TURNING = 0x00000008;
export const MOVEMENTFLAG2_FULL_SPEED_PITCHING = 0x00000010;
export const MOVEMENTFLAG2_ALWAYS_ALLOW_PITCHING = 0x00000020;
export const MOVEMENTFLAG2_UNK7 = 0x00000040;
export const MOVEMENTFLAG2_UNK8 = 0x00000080;
export const MOVEMENTFLAG2_UNK9 = 0x00000100;
export const MOVEMENTFLAG2_UNK10 = 0x00000200;
export const MOVEMENTFLAG2_INTERPOLATED_MOVEMENT = 0x00000400;
export const MOVEMENTFLAG2_INTERPOLATED_TURNING = 0x00000800;
export const MOVEMENTFLAG2_INTERPOLATED_PITCHING = 0x00001000;
export const MOVEMENTFLAG2_UNK14 = 0x00002000;
export const MOVEMENTFLAG2_UNK15 = 0x00004000;
export const MOVEMENTFLAG2_UNK16 = 0x00008000;

/** @ac game/Movement/MotionMaster.h AnimTier (`enum class AnimTier : uint8`) */
export const AnimTier = {
  Ground: 0,
  Swim: 1,
  Hover: 2,
  Fly: 3,
  Submerged: 4,
  Max: 5,
} as const;
export type AnimTier = (typeof AnimTier)[keyof typeof AnimTier];
