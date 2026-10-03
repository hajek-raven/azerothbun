/**
 * Port of `deps/recastnavigation/Recast/Include/RecastAssert.h` and `Source/RecastAssert.cpp`.
 *
 * AzerothCore builds Recast in release mode for the tools (`NDEBUG`, `rcAssert` compiled out); the TypeScript build
 * functions call no assert in hot paths, and `rcAssert` checks only when a custom failure function is installed.
 */

/** @ac deps/recastnavigation/Recast/Include/RecastAssert.h rcAssertFailFunc */
export type rcAssertFailFunc = (expression: string, file: string, line: number) => void;

let sRecastAssertFailFunc: rcAssertFailFunc | null = null;

/** @ac deps/recastnavigation/Recast/Source/RecastAssert.cpp rcAssertFailSetCustom */
export function rcAssertFailSetCustom(assertFailFunc: rcAssertFailFunc | null): void {
  sRecastAssertFailFunc = assertFailFunc;
}

/** @ac deps/recastnavigation/Recast/Source/RecastAssert.cpp rcAssertFailGetCustom */
export function rcAssertFailGetCustom(): rcAssertFailFunc | null {
  return sRecastAssertFailFunc;
}

/**
 * `rcAssert(expression)`: reports a failed expression to the custom handler when one is set.
 * @ac deps/recastnavigation/Recast/Include/RecastAssert.h rcAssert
 */
export function rcAssert(expression: unknown, text = "rcAssert"): void {
  if (!expression && sRecastAssertFailFunc) sRecastAssertFailFunc(text, "Recast", 0);
}
