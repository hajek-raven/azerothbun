/**
 * Port of `deps/recastnavigation/Recast/Include/RecastAlloc.h` and `Source/RecastAlloc.cpp`.
 *
 * Memory is garbage collected, so the allocator hooks are kept only for API parity. `rcIntArray` (the legacy int
 * vector every build step uses) is a growable `Int32Array`; the other `rcTempVector<T>` uses are replaced by typed
 * arrays or JS arrays at the call sites.
 */

/** @ac deps/recastnavigation/Recast/Include/RecastAlloc.h rcAllocHint */
export const rcAllocHint = {
  /** Memory will persist after a function call. */
  RC_ALLOC_PERM: 0,
  /** Memory used temporarily within a function. */
  RC_ALLOC_TEMP: 1,
} as const;
export type rcAllocHint = (typeof rcAllocHint)[keyof typeof rcAllocHint];
export const RC_ALLOC_PERM = rcAllocHint.RC_ALLOC_PERM;
export const RC_ALLOC_TEMP = rcAllocHint.RC_ALLOC_TEMP;

/** @ac deps/recastnavigation/Recast/Include/RecastAlloc.h rcAllocFunc */
export type rcAllocFunc = (size: number, hint: rcAllocHint) => ArrayBuffer | null;
/** @ac deps/recastnavigation/Recast/Include/RecastAlloc.h rcFreeFunc */
export type rcFreeFunc = (ptr: ArrayBuffer | null) => void;

function rcAllocDefault(size: number, _hint: rcAllocHint): ArrayBuffer | null {
  return new ArrayBuffer(size);
}

function rcFreeDefault(_ptr: ArrayBuffer | null): void {}

let sRecastAllocFunc: rcAllocFunc = rcAllocDefault;
let sRecastFreeFunc: rcFreeFunc = rcFreeDefault;

/**
 * Sets the base custom allocation functions to be used by Recast.
 * @ac deps/recastnavigation/Recast/Source/RecastAlloc.cpp rcAllocSetCustom
 * @ac-skip the TypeScript build functions allocate typed arrays directly (garbage collected); the hooks only serve
 * `rcAlloc` / `rcFree` callers
 */
export function rcAllocSetCustom(allocFunc: rcAllocFunc | null, freeFunc: rcFreeFunc | null): void {
  sRecastAllocFunc = allocFunc ?? rcAllocDefault;
  sRecastFreeFunc = freeFunc ?? rcFreeDefault;
}

/**
 * Allocates a memory block.
 * @ac deps/recastnavigation/Recast/Source/RecastAlloc.cpp rcAlloc
 */
export function rcAlloc(size: number, hint: rcAllocHint): ArrayBuffer | null {
  return sRecastAllocFunc(size, hint);
}

/**
 * Deallocates a memory block.
 * @ac deps/recastnavigation/Recast/Source/RecastAlloc.cpp rcFree
 */
export function rcFree(ptr: ArrayBuffer | null): void {
  if (ptr) sRecastFreeFunc(ptr);
}

/**
 * Legacy int vector used throughout the build. Element `i` is `data[i]` (valid below `size()`); `data` is replaced
 * when the array grows, so read it again after `push` / `resize`. New elements are zero (the C++ leaves them
 * uninitialized and never reads them before writing).
 * @ac deps/recastnavigation/Recast/Include/RecastAlloc.h rcIntArray
 */
export class rcIntArray {
  data: Int32Array;
  private m_size: number;

  /** `rcIntArray()` / `rcIntArray(int n)`: `n` zero elements. */
  constructor(n = 0) {
    this.data = new Int32Array(n > 16 ? n : 16);
    this.m_size = n;
  }

  private reserve(n: number): void {
    if (n <= this.data.length) return;
    let cap = this.data.length * 2;
    if (cap < n) cap = n;
    const data = new Int32Array(cap);
    data.set(this.data.subarray(0, this.m_size));
    this.data = data;
  }

  /** @ac deps/recastnavigation/Recast/Include/RecastAlloc.h rcIntArray::push */
  push(item: number): void {
    if (this.m_size === this.data.length) this.reserve(this.m_size + 1);
    this.data[this.m_size++] = item;
  }

  /** @ac deps/recastnavigation/Recast/Include/RecastAlloc.h rcIntArray::resize */
  resize(size: number): void {
    if (size > this.m_size) {
      this.reserve(size);
      this.data.fill(0, this.m_size, size);
    }
    this.m_size = size;
  }

  /** @ac deps/recastnavigation/Recast/Include/RecastAlloc.h rcIntArray::pop */
  pop(): number {
    return this.data[--this.m_size]!;
  }

  /** @ac deps/recastnavigation/Recast/Include/RecastAlloc.h rcIntArray::size */
  size(): number {
    return this.m_size;
  }

  /** `operator[]` read. @ac deps/recastnavigation/Recast/Include/RecastAlloc.h rcIntArray::operator[] */
  get(index: number): number {
    return this.data[index]!;
  }

  /** `operator[]` write. */
  set(index: number, value: number): void {
    this.data[index] = value;
  }
}

/**
 * @ac deps/recastnavigation/Recast/Include/RecastAlloc.h rcVectorBase
 * @ac-skip generic vector; `rcIntArray` and per-call typed arrays replace every use
 */
export type rcVectorBase = never;

/**
 * @ac deps/recastnavigation/Recast/Include/RecastAlloc.h rcScopedDelete
 * @ac-skip memory is garbage collected
 */
export type rcScopedDelete = never;

/**
 * @ac deps/recastnavigation/Recast/Include/RecastAlloc.h rcNewTag
 * @ac-skip placement new does not exist in TypeScript
 */
export type rcNewTag = never;
