/** Port of `deps/recastnavigation/Detour/{Include,Source}/DetourAssert.*`. */

/** @ac deps/recastnavigation/Detour/Include/DetourAssert.h dtAssertFailFunc */
export type dtAssertFailFunc = (expression: string, file: string, line: number) => void;

let sAssertFailFunc: dtAssertFailFunc | null = null;

/** @ac deps/recastnavigation/Detour/Source/DetourAssert.cpp dtAssertFailSetCustom */
export function dtAssertFailSetCustom(assertFailFunc: dtAssertFailFunc | null): void {
  sAssertFailFunc = assertFailFunc;
}

/** @ac deps/recastnavigation/Detour/Source/DetourAssert.cpp dtAssertFailGetCustom */
export function dtAssertFailGetCustom(): dtAssertFailFunc | null {
  return sAssertFailFunc;
}

/**
 * The `dtAssert(expression)` macro. Without a custom handler it throws, like `assert` in a debug build.
 * @ac deps/recastnavigation/Detour/Include/DetourAssert.h dtAssert
 */
export function dtAssert(condition: unknown, expression = "dtAssert"): asserts condition {
  if (condition) return;
  const failFunc = dtAssertFailGetCustom();
  if (failFunc === null) throw new Error(`Detour assertion failed: ${expression}`);
  failFunc(expression, "Detour", 0);
}
