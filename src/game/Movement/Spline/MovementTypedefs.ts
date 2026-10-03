/**
 * Port of `game/Movement/Spline/MovementTypedefs.h`.
 *
 * The C++ `Movement` namespace is plain module exports. `G3D::Vector3` is `src/math/Vector3.ts`. C++ `float` is a 32 bit
 * value: results that C++ stores in a `float` go through `Math.fround` here and in the files that port the spline code.
 *
 * `computeFallTime`, `computeFallElevation`, `gravity` and `splineIdGen` are declared here in C++ but defined in
 * `MovementUtil.cpp`; they live in `MovementUtil.ts` (a re-export from here would make the two files import each other).
 */

const fround = Math.fround;

/**
 * TypeScript only: the C++ conversion `static_cast<int32>(float)` as x86-64 (`cvttss2si`) performs it. The value is
 * truncated toward zero; NaN and values outside `int32` give `INT32_MIN`, which is what the C++ overflow checks
 * (`new_length < 0`) rely on.
 */
export function floatToInt32(x: number): number {
  if (x !== x || x >= 2147483648 || x < -2147483648) return -2147483648;
  return Math.trunc(x) | 0;
}

/** @ac game/Movement/Spline/MovementTypedefs.h Movement::SecToMS (`static_cast<uint32>(sec * 1000.f)`) */
export function SecToMS(sec: number): number {
  const ms = fround(fround(sec) * 1000);
  if (ms !== ms) return 0;
  return Math.trunc(ms) >>> 0;
}

/** @ac game/Movement/Spline/MovementTypedefs.h Movement::MSToSec (`ms / 1000.f`) */
export function MSToSec(ms: number): number {
  return fround(fround(ms) / 1000);
}

/** @ac game/Movement/Spline/MovementTypedefs.h Movement::counter */
export class counter {
  private m_counter = 0;

  /** @param limit the template parameter `T limit`: the value after which the counter restarts at 0 */
  constructor(private readonly limit: number) {}

  /** @ac game/Movement/Spline/MovementTypedefs.h Movement::counter::Increase */
  increase(): void {
    if (this.m_counter === this.limit) this.init();
    else ++this.m_counter;
  }

  /** @ac game/Movement/Spline/MovementTypedefs.h Movement::counter::NewId */
  newId(): number {
    this.increase();
    return this.m_counter;
  }

  /** @ac game/Movement/Spline/MovementTypedefs.h Movement::counter::getCurrent */
  getCurrent(): number {
    return this.m_counter;
  }

  private init(): void {
    this.m_counter = 0;
  }
}

/** @ac game/Movement/Spline/MovementTypedefs.h Movement::UInt32Counter (`counter<uint32, 0xFFFFFFFF>`) */
export class UInt32Counter extends counter {
  constructor() {
    super(0xffffffff);
  }
}
