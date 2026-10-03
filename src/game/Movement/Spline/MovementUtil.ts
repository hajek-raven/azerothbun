/**
 * Port of `game/Movement/Spline/MovementUtil.cpp`: the fall physics constants and functions, the spline id counter, and
 * the flag name tables `MoveSplineFlag::ToString` prints. Float math follows the C++ types: `float` operands are rounded
 * with `Math.fround`, and an operation with the `double` `gravity` stays in double until the C++ stores it in a float.
 */
import { UInt32Counter } from "./MovementTypedefs.ts";

const fround = Math.fround;

/** @ac game/Movement/Spline/MovementUtil.cpp Movement::gravity */
export const gravity = 19.29110527038574;
/** @ac game/Movement/Spline/MovementUtil.cpp Movement::splineIdGen */
export const splineIdGen = new UInt32Counter();

/// Velocity bounds that makes fall speed limited
/** @ac game/Movement/Spline/MovementUtil.cpp Movement::terminalVelocity */
export const terminalVelocity = fround(60.148003);
/** @ac game/Movement/Spline/MovementUtil.cpp Movement::terminalSafefallVelocity */
export const terminalSafefallVelocity = fround(7.0);

/** @ac game/Movement/Spline/MovementUtil.cpp Movement::terminal_length (`float(v * v) / (2.0f * gravity)` is a double division) */
export const terminal_length = fround(fround(terminalVelocity * terminalVelocity) / (fround(2.0) * gravity));
/** @ac game/Movement/Spline/MovementUtil.cpp Movement::terminal_safeFall_length */
export const terminal_safeFall_length = fround(fround(terminalSafefallVelocity * terminalSafefallVelocity) / (fround(2.0) * gravity));
/** the time that needed to reach terminalVelocity @ac game/Movement/Spline/MovementUtil.cpp Movement::terminal_fallTime */
export const terminal_fallTime = fround(terminalVelocity / gravity);
/** the time that needed to reach terminalVelocity with safefall @ac game/Movement/Spline/MovementUtil.cpp Movement::terminal_safeFall_fallTime */
export const terminal_safeFall_fallTime = fround(terminalSafefallVelocity / gravity);

/** @ac game/Movement/Spline/MovementUtil.cpp Movement::computeFallTime */
export function computeFallTime(path_length: number, isSafeFall: boolean): number {
  path_length = fround(path_length);
  if (path_length < 0.0) return 0.0;

  let time: number;
  if (isSafeFall) {
    if (path_length >= terminal_safeFall_length) {
      time = fround(fround(fround(path_length - terminal_safeFall_length) / terminalSafefallVelocity) + terminal_safeFall_fallTime);
    } else {
      // sqrtf(2.0f * path_length / gravity): the division is in double, sqrtf takes a float
      time = fround(Math.sqrt(fround(fround(fround(2.0) * path_length) / gravity)));
    }
  } else {
    if (path_length >= terminal_length) {
      time = fround(fround(fround(path_length - terminal_length) / terminalVelocity) + terminal_fallTime);
    } else {
      time = fround(Math.sqrt(fround(fround(fround(2.0) * path_length) / gravity)));
    }
  }

  return time;
}

/** @ac game/Movement/Spline/MovementUtil.cpp Movement::computeFallElevation */
export function computeFallElevation(t_passed: number, isSafeFall: boolean, start_velocity = 0.0): number {
  t_passed = fround(t_passed);
  start_velocity = fround(start_velocity);

  const termVel = isSafeFall ? terminalSafefallVelocity : terminalVelocity;
  let result: number;

  if (start_velocity > termVel) start_velocity = termVel;

  // the time that needed to reach terminalVelocity (`float - float / double` is a double expression stored in a float)
  const terminal_time = fround((isSafeFall ? terminal_safeFall_fallTime : terminal_fallTime) - start_velocity / gravity);

  if (t_passed > terminal_time) {
    // termVel * (t - tt) + v0 * tt are floats, the gravity term is a double expression
    const a = fround(fround(termVel * fround(t_passed - terminal_time)) + fround(start_velocity * terminal_time));
    result = a + gravity * terminal_time * terminal_time * fround(0.5);
  } else {
    result = t_passed * (start_velocity + t_passed * gravity * fround(0.5));
  }

  return fround(result);
}

/** @ac game/Movement/Spline/MovementUtil.cpp Movement::g_MovementFlag_names */
export const g_MovementFlag_names: readonly string[] = [
  "Forward", // 0x00000001,
  "Backward", // 0x00000002,
  "Strafe_Left", // 0x00000004,
  "Strafe_Right", // 0x00000008,
  "Turn_Left", // 0x00000010,
  "Turn_Right", // 0x00000020,
  "Pitch_Up", // 0x00000040,
  "Pitch_Down", // 0x00000080,

  "Walk", // 0x00000100,               // Walking
  "Ontransport", // 0x00000200,
  "Levitation", // 0x00000400,
  "Root", // 0x00000800,
  "Falling", // 0x00001000,
  "Fallingfar", // 0x00002000,
  "Pendingstop", // 0x00004000,
  "PendingSTRafestop", // 0x00008000,
  "Pendingforward", // 0x00010000,
  "Pendingbackward", // 0x00020000,
  "PendingSTRafeleft", // 0x00040000,
  "PendingSTRaferight", // 0x00080000,
  "Pendingroot", // 0x00100000,
  "Swimming", // 0x00200000,               // Appears With Fly Flag Also
  "Ascending", // 0x00400000,               // Swim Up Also
  "Descending", // 0x00800000,               // Swim Down Also
  "Can_Fly", // 0x01000000,               // Can Fly In 3.3?
  "Flying", // 0x02000000,               // Actual Flying Mode
  "Spline_Elevation", // 0x04000000,               // Used For Flight Paths
  "Spline_Enabled", // 0x08000000,               // Used For Flight Paths
  "Waterwalking", // 0x10000000,               // Prevent Unit From Falling Through Water
  "Safe_Fall", // 0x20000000,               // Active Rogue Safe Fall Spell (Passive)
  "Hover", // 0x40000000
  "Unknown13", // 0x80000000
  "Unk1",
  "Unk2",
  "Unk3",
  "Fullspeedturning",
  "Fullspeedpitching",
  "Allow_Pitching",
  "Unk4",
  "Unk5",
  "Unk6",
  "Unk7",
  "Interp_Move",
  "Interp_Turning",
  "Interp_Pitching",
  "Unk8",
  "Unk9",
  "Unk10",
];

/** @ac game/Movement/Spline/MovementUtil.cpp Movement::g_SplineFlag_names */
export const g_SplineFlag_names: readonly string[] = [
  "AnimBit1", // 0x00000001,
  "AnimBit2", // 0x00000002,
  "AnimBit3", // 0x00000004,
  "AnimBit4", // 0x00000008,
  "AnimBit5", // 0x00000010,
  "AnimBit6", // 0x00000020,
  "AnimBit7", // 0x00000040,
  "AnimBit8", // 0x00000080,
  "Done", // 0x00000100,
  "Falling", // 0x00000200,           // Not Compartible With Trajectory Movement
  "No_Spline", // 0x00000400,
  "Trajectory", // 0x00000800,           // Not Compartible With Fall Movement
  "CanSwim", // 0x00001000,
  "Flying", // 0x00002000,           // Smooth Movement(Catmullrom Interpolation Mode), Flying Animation
  "Knockback", // 0x00004000,           // Model Orientation Fixed
  "Final_Point", // 0x00008000,
  "Final_Target", // 0x00010000,
  "Final_Angle", // 0x00020000,
  "Catmullrom", // 0x00040000,           // Used Catmullrom Interpolation Mode
  "Cyclic", // 0x00080000,           // Movement By Cycled Spline
  "Enter_Cycle", // 0x00100000,           // Everytime Appears With Cyclic Flag In Monster Move Packet
  "Animation", // 0x00200000,           // Animationid (0...3), Uint32 Time, Not Compartible With Trajectory And Fall Movement
  "Unknown4", // 0x00400000,           // Disables Movement By Path
  "Unknown5", // 0x00800000,
  "Unknown6", // 0x01000000,
  "Unknown7", // 0x02000000,
  "Unknown8", // 0x04000000,
  "OrientationInversed", // 0x08000000,           // Appears With Runmode Flag, Nodes ), // 1, Handles Orientation
  "Unknown10", // 0x10000000,
  "Unknown11", // 0x20000000,
  "Unknown12", // 0x40000000,
  "Unknown13", // 0x80000000,
];

/** @ac game/Movement/Spline/MovementUtil.cpp Movement::print_flags */
export function print_flags(t: number, names: readonly string[], str: { value: string }): void {
  for (let i = 0; i < names.length; ++i) {
    // `Flags(1 << i)` is a 32 bit shift; only the first 32 names can match a uint32
    if (i < 32 && (t & (1 << i)) !== 0 && names[i] !== undefined) str.value += ` ${names[i]}`;
  }
}
