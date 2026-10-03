/**
 * Port of `deps/recastnavigation/Detour/{Include,Source}/DetourAlloc.*`.
 *
 * Detour allocates raw byte blocks (tile data) through `dtAlloc`. Here a block is a zero-filled `Uint8Array` over
 * its own `ArrayBuffer` (4-byte aligned, like `malloc`), and `dtFree` drops nothing: the garbage collector owns the
 * memory. Objects (`dtNavMesh`, `dtNavMeshQuery`, node pools) are plain classes created with `new`.
 */

/** @ac deps/recastnavigation/Detour/Include/DetourAlloc.h dtAllocHint */
export const dtAllocHint = {
  /** Memory persist after a function call. */
  DT_ALLOC_PERM: 0,
  /** Memory used temporarily within a function. */
  DT_ALLOC_TEMP: 1,
} as const;
export type dtAllocHint = (typeof dtAllocHint)[keyof typeof dtAllocHint];
export const DT_ALLOC_PERM = dtAllocHint.DT_ALLOC_PERM;
export const DT_ALLOC_TEMP = dtAllocHint.DT_ALLOC_TEMP;

/** @ac deps/recastnavigation/Detour/Include/DetourAlloc.h dtAllocFunc */
export type dtAllocFunc = (size: number, hint: dtAllocHint) => Uint8Array | null;
/** @ac deps/recastnavigation/Detour/Include/DetourAlloc.h dtFreeFunc */
export type dtFreeFunc = (ptr: Uint8Array) => void;

/** @ac deps/recastnavigation/Detour/Source/DetourAlloc.cpp dtAllocDefault */
function dtAllocDefault(size: number, _hint: dtAllocHint): Uint8Array | null {
  return new Uint8Array(size);
}

/** @ac deps/recastnavigation/Detour/Source/DetourAlloc.cpp dtFreeDefault */
function dtFreeDefault(_ptr: Uint8Array): void {
  // The garbage collector releases the block once nothing references it.
}

let sAllocFunc: dtAllocFunc = dtAllocDefault;
let sFreeFunc: dtFreeFunc = dtFreeDefault;

/** @ac deps/recastnavigation/Detour/Source/DetourAlloc.cpp dtAllocSetCustom */
export function dtAllocSetCustom(allocFunc: dtAllocFunc | null, freeFunc: dtFreeFunc | null): void {
  sAllocFunc = allocFunc ?? dtAllocDefault;
  sFreeFunc = freeFunc ?? dtFreeDefault;
}

/** @ac deps/recastnavigation/Detour/Source/DetourAlloc.cpp dtAlloc */
export function dtAlloc(size: number, hint: dtAllocHint): Uint8Array | null {
  return sAllocFunc(size, hint);
}

/** @ac deps/recastnavigation/Detour/Source/DetourAlloc.cpp dtFree */
export function dtFree(ptr: Uint8Array | null): void {
  if (ptr) sFreeFunc(ptr);
}
