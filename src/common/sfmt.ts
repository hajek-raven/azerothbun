/**
 * SFMT-19937, the standard C little-endian recursion from `deps/SFMT`.
 * The SSE2 build AzerothCore uses on x86 emits the same sequence.
 */

const SFMT_N = 156;
const SFMT_N32 = SFMT_N * 4;
const SFMT_POS1 = 122;
const SFMT_SL1 = 18;
const SFMT_SR1 = 11;
const SFMT_MSK = [0xdfffffef, 0xddfecb7f, 0xbffaffff, 0xbffffff6] as const;
const SFMT_PARITY = [0x00000001, 0x00000000, 0x00000000, 0x13c9e684] as const;
const MASK128 = (1n << 128n) - 1n;

function u32(value: number): number {
  return value >>> 0;
}

function load128(state: Uint32Array, block: number): bigint {
  const i = block * 4;
  return BigInt(state[i]!)
    | (BigInt(state[i + 1]!) << 32n)
    | (BigInt(state[i + 2]!) << 64n)
    | (BigInt(state[i + 3]!) << 96n);
}

function store128(state: Uint32Array, block: number, value: bigint): void {
  const i = block * 4;
  state[i] = Number(value & 0xffffffffn);
  state[i + 1] = Number((value >> 32n) & 0xffffffffn);
  state[i + 2] = Number((value >> 64n) & 0xffffffffn);
  state[i + 3] = Number((value >> 96n) & 0xffffffffn);
}

function word(value: bigint, index: number): number {
  return Number((value >> BigInt(index * 32)) & 0xffffffffn);
}

/** `do_recursion` for SL2 = 1 and SR2 = 1 (8-bit SIMD shifts). */
function doRecursion(a: bigint, b: bigint, c: bigint, d: bigint): bigint {
  const x = (a << 8n) & MASK128;
  const y = c >> 8n;
  let packed = 0n;
  for (let i = 0; i < 4; i++) {
    const mixed = (word(a, i) ^ word(x, i) ^ ((word(b, i) >>> SFMT_SR1) & SFMT_MSK[i]!) ^ word(y, i) ^ (word(d, i) << SFMT_SL1)) >>> 0;
    packed |= BigInt(mixed) << BigInt(i * 32);
  }
  return packed;
}

function genRandAll(state: Uint32Array): void {
  let r1 = load128(state, SFMT_N - 2);
  let r2 = load128(state, SFMT_N - 1);
  for (let i = 0; i < SFMT_N - SFMT_POS1; i++) {
    const next = doRecursion(load128(state, i), load128(state, i + SFMT_POS1), r1, r2);
    store128(state, i, next);
    r1 = r2;
    r2 = next;
  }
  for (let i = SFMT_N - SFMT_POS1; i < SFMT_N; i++) {
    const next = doRecursion(load128(state, i), load128(state, i + SFMT_POS1 - SFMT_N), r1, r2);
    store128(state, i, next);
    r1 = r2;
    r2 = next;
  }
}

function periodCertification(state: Uint32Array): void {
  let inner = 0;
  for (let i = 0; i < 4; i++) {
    inner ^= state[i]! & SFMT_PARITY[i]!;
  }
  for (let i = 16; i > 0; i >>= 1) {
    inner ^= inner >>> i;
  }
  inner &= 1;
  if (inner === 1) {
    return;
  }
  for (let i = 0; i < 4; i++) {
    let work = 1;
    for (let j = 0; j < 32; j++) {
      if ((work & SFMT_PARITY[i]!) !== 0) {
        state[i] = (state[i]! ^ work) >>> 0;
        return;
      }
      work = (work << 1) >>> 0;
    }
  }
}

function func1(x: number): number {
  return u32(Math.imul(x ^ (x >>> 27), 1664525));
}

function func2(x: number): number {
  return u32(Math.imul(x ^ (x >>> 27), 1566083941));
}

export class SfmtEngine {
  private readonly state = new Uint32Array(SFMT_N32);
  private idx = SFMT_N32;

  constructor(seed?: number | Uint32Array) {
    if (typeof seed === "number") {
      this.initGenRand(seed);
      return;
    }
    if (seed) {
      this.initByArray(seed);
      return;
    }
    const entropy = new Uint32Array(SFMT_N32);
    crypto.getRandomValues(entropy);
    this.initByArray(entropy);
  }

  /** `sfmt_init_gen_rand`. */
  initGenRand(seed: number): void {
    this.state[0] = u32(seed);
    for (let i = 1; i < SFMT_N32; i++) {
      const prev = this.state[i - 1]!;
      this.state[i] = u32(Math.imul(1812433253, prev ^ (prev >>> 30)) + i);
    }
    this.idx = SFMT_N32;
    periodCertification(this.state);
  }

  /** `sfmt_init_by_array`. */
  initByArray(key: Uint32Array): void {
    this.state.fill(0x8b8b8b8b);
    const size = SFMT_N * 4;
    const lag = size >= 623 ? 11 : size >= 68 ? 7 : size >= 39 ? 5 : 3;
    const mid = Math.floor((size - lag) / 2);
    const count = Math.max(key.length + 1, SFMT_N32);
    let i = 0;
    let r = func1(this.state[0]! ^ this.state[mid]! ^ this.state[SFMT_N32 - 1]!);
    this.state[mid] = u32(this.state[mid]! + r);
    r = u32(r + key.length);
    this.state[mid + lag] = u32(this.state[mid + lag]! + r);
    this.state[0] = r;

    let j = 0;
    for (i = 1; j < count - 1 && j < key.length; j++) {
      r = func1(this.state[i]! ^ this.state[(i + mid) % SFMT_N32]! ^ this.state[(i + SFMT_N32 - 1) % SFMT_N32]!);
      this.state[(i + mid) % SFMT_N32] = u32(this.state[(i + mid) % SFMT_N32]! + r);
      r = u32(r + key[j]! + i);
      this.state[(i + mid + lag) % SFMT_N32] = u32(this.state[(i + mid + lag) % SFMT_N32]! + r);
      this.state[i] = r;
      i = (i + 1) % SFMT_N32;
    }
    for (; j < count - 1; j++) {
      r = func1(this.state[i]! ^ this.state[(i + mid) % SFMT_N32]! ^ this.state[(i + SFMT_N32 - 1) % SFMT_N32]!);
      this.state[(i + mid) % SFMT_N32] = u32(this.state[(i + mid) % SFMT_N32]! + r);
      r = u32(r + i);
      this.state[(i + mid + lag) % SFMT_N32] = u32(this.state[(i + mid + lag) % SFMT_N32]! + r);
      this.state[i] = r;
      i = (i + 1) % SFMT_N32;
    }
    for (j = 0; j < SFMT_N32; j++) {
      r = func2(u32(this.state[i]! + this.state[(i + mid) % SFMT_N32]! + this.state[(i + SFMT_N32 - 1) % SFMT_N32]!));
      this.state[(i + mid) % SFMT_N32] = (this.state[(i + mid) % SFMT_N32]! ^ r) >>> 0;
      r = u32(r - i);
      this.state[(i + mid + lag) % SFMT_N32] = (this.state[(i + mid + lag) % SFMT_N32]! ^ r) >>> 0;
      this.state[i] = r;
      i = (i + 1) % SFMT_N32;
    }
    this.idx = SFMT_N32;
    periodCertification(this.state);
  }

  /** `sfmt_genrand_uint32`. */
  nextUint32(): number {
    if (this.idx >= SFMT_N32) {
      genRandAll(this.state);
      this.idx = 0;
    }
    const value = this.state[this.idx]!;
    this.idx += 1;
    return value;
  }
}
