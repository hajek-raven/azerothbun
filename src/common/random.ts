import { IN_MILLISECONDS } from "./duration.ts";
import { SfmtEngine } from "./sfmt.ts";

/**
 * `Random.cpp` on top of SFMT.
 * Integer ranges follow libstdc++ `uniform_int_distribution` (the library AzerothCore builds with).
 * Real ranges follow `generate_canonical` plus `uniform_real_distribution`.
 */

const UINT32_MAX = 0xffffffff;

let rng = new SfmtEngine();

export function seedRandom(seed: number): void {
  rng = new SfmtEngine(seed);
}

export function rand32(): number {
  return rng.nextUint32();
}

function uniformUint(lo: number, hi: number): number {
  const urange = (hi - lo) >>> 0;
  if (urange === UINT32_MAX) {
    return (rand32() + lo) >>> 0;
  }
  const uerange = (urange + 1) >>> 0;
  const scaling = Math.floor(UINT32_MAX / uerange);
  const past = uerange * scaling;
  let ret = rand32();
  while (ret >= past) {
    ret = rand32();
  }
  return (Math.floor(ret / scaling) + lo) >>> 0;
}

/** Inclusive signed range. Matches `irand`. */
export function irand(min: number, max: number): number {
  const lo = min | 0;
  const hi = max | 0;
  if (hi < lo) {
    throw new Error("irand: max < min");
  }
  return uniformUint(lo >>> 0, hi >>> 0) | 0;
}

/** Inclusive unsigned range. Matches `urand`. */
export function urand(min: number, max: number): number {
  const lo = min >>> 0;
  const hi = max >>> 0;
  if (hi < lo) {
    throw new Error("urand: max < min");
  }
  return uniformUint(lo, hi);
}

/** `urand(min * IN_MILLISECONDS, max * IN_MILLISECONDS)`. */
export function urandms(min: number, max: number): number {
  if (Math.floor(UINT32_MAX / IN_MILLISECONDS) < max) {
    throw new Error("urandms: max is too large");
  }
  return urand(min * IN_MILLISECONDS, max * IN_MILLISECONDS);
}

/**
 * `generate_canonical<float>`: one uint32 sample, float32 division by 2^32.
 * `uniform_real_distribution<float>` is [min, max).
 */
function canonicalFloat(): number {
  return Math.fround(Math.fround(rand32()) / 4294967296);
}

export function frand(min: number, max: number): number {
  if (max < min) {
    throw new Error("frand: max < min");
  }
  const canon = canonicalFloat();
  const span = Math.fround(Math.fround(max) - Math.fround(min));
  return Math.fround(Math.fround(canon * span) + Math.fround(min));
}

/**
 * `generate_canonical<double>`: two uint32 samples.
 * (u0 + u1 * 2^32) / 2^64, in [0, 1).
 */
function canonicalDouble(): number {
  const u0 = rand32();
  const u1 = rand32();
  return (u0 + u1 * 4294967296) / 18446744073709551616;
}

/** [0, 1). Matches `rand_norm`. */
export function randNorm(): number {
  return canonicalDouble();
}

/** [0, 100). Matches `rand_chance`. */
export function randChance(): number {
  return canonicalDouble() * 100;
}

export function rollChanceF(chance: number): boolean {
  return chance > randChance();
}

export function rollChanceI(chance: number): boolean {
  return chance > irand(0, 99);
}

/** Inclusive millisecond span. Matches `randtime(Milliseconds)`. */
export function randtime(min: number, max: number): number {
  const diff = max - min;
  if (diff < 0 || diff > UINT32_MAX) {
    throw new Error("randtime: invalid range");
  }
  return min + urand(0, diff);
}

/**
 * `std::discrete_distribution`: cumulative weights, last entry forced to 1,
 * then `lower_bound` on a canonical double.
 */
export function urandweighted(chances: ArrayLike<number>): number {
  const count = chances.length;
  if (count === 0) {
    throw new Error("urandweighted: empty chances");
  }
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += chances[i]!;
  }
  if (sum === 0) {
    throw new Error("urandweighted: chances sum to 0");
  }
  const cp: number[] = [];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    acc += chances[i]! / sum;
    cp.push(acc);
  }
  cp[count - 1] = 1;
  const p = randNorm();
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cp[mid]! < p) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}
