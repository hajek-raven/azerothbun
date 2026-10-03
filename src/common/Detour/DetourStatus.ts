/**
 * Port of `deps/recastnavigation/Detour/Include/DetourStatus.h`.
 *
 * `dtStatus` is an `unsigned int` in C++. Here the flags are the signed 32-bit values JavaScript bit operators
 * produce, so `DT_FAILURE | DT_INVALID_PARAM` and a status built from it with `|` compare equal.
 */

/** @ac deps/recastnavigation/Detour/Include/DetourStatus.h dtStatus */
export type dtStatus = number;

/** Operation failed. @ac deps/recastnavigation/Detour/Include/DetourStatus.h DT_FAILURE */
export const DT_FAILURE = 1 << 31;
/** Operation succeed. @ac deps/recastnavigation/Detour/Include/DetourStatus.h DT_SUCCESS */
export const DT_SUCCESS = 1 << 30;
/** Operation still in progress. @ac deps/recastnavigation/Detour/Include/DetourStatus.h DT_IN_PROGRESS */
export const DT_IN_PROGRESS = 1 << 29;

/** @ac deps/recastnavigation/Detour/Include/DetourStatus.h DT_STATUS_DETAIL_MASK */
export const DT_STATUS_DETAIL_MASK = 0x0ffffff;
/** Input data is not recognized. @ac deps/recastnavigation/Detour/Include/DetourStatus.h DT_WRONG_MAGIC */
export const DT_WRONG_MAGIC = 1 << 0;
/** Input data is in wrong version. @ac deps/recastnavigation/Detour/Include/DetourStatus.h DT_WRONG_VERSION */
export const DT_WRONG_VERSION = 1 << 1;
/** Operation ran out of memory. @ac deps/recastnavigation/Detour/Include/DetourStatus.h DT_OUT_OF_MEMORY */
export const DT_OUT_OF_MEMORY = 1 << 2;
/** An input parameter was invalid. @ac deps/recastnavigation/Detour/Include/DetourStatus.h DT_INVALID_PARAM */
export const DT_INVALID_PARAM = 1 << 3;
/** Result buffer for the query was too small to store all results. @ac deps/recastnavigation/Detour/Include/DetourStatus.h DT_BUFFER_TOO_SMALL */
export const DT_BUFFER_TOO_SMALL = 1 << 4;
/** Query ran out of nodes during search. @ac deps/recastnavigation/Detour/Include/DetourStatus.h DT_OUT_OF_NODES */
export const DT_OUT_OF_NODES = 1 << 5;
/** Query did not reach the end location, returning best guess. @ac deps/recastnavigation/Detour/Include/DetourStatus.h DT_PARTIAL_RESULT */
export const DT_PARTIAL_RESULT = 1 << 6;
/** A tile has already been assigned to the given x,y coordinate. @ac deps/recastnavigation/Detour/Include/DetourStatus.h DT_ALREADY_OCCUPIED */
export const DT_ALREADY_OCCUPIED = 1 << 7;
/** Surface slope too steep to be walkable (AzerothCore addition). @ac deps/recastnavigation/Detour/Include/DetourStatus.h DT_SLOPE_TOO_STEEP */
export const DT_SLOPE_TOO_STEEP = 1 << 8;

/** @ac deps/recastnavigation/Detour/Include/DetourStatus.h dtStatusSucceed */
export function dtStatusSucceed(status: dtStatus): boolean {
  return (status & DT_SUCCESS) !== 0;
}

/** @ac deps/recastnavigation/Detour/Include/DetourStatus.h dtStatusFailed */
export function dtStatusFailed(status: dtStatus): boolean {
  return (status & DT_FAILURE) !== 0;
}

/** @ac deps/recastnavigation/Detour/Include/DetourStatus.h dtStatusInProgress */
export function dtStatusInProgress(status: dtStatus): boolean {
  return (status & DT_IN_PROGRESS) !== 0;
}

/** @ac deps/recastnavigation/Detour/Include/DetourStatus.h dtStatusDetail */
export function dtStatusDetail(status: dtStatus, detail: number): boolean {
  return (status & detail) !== 0;
}
