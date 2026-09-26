import { expect, test } from "bun:test";
import { SfmtEngine } from "./sfmt.ts";
import { frand, irand, rand32, randChance, randNorm, rollChanceI, seedRandom, urand, urandweighted } from "./random.ts";

const SEED_1234 = [
  3440181298, 1564997079, 1510669302, 2930277156, 1452439940, 3796268453, 423124208, 2143818589, 3827219408, 2987036003,
] as const;

test("SFMT-19937 matches sfmt_init_gen_rand(1234)", () => {
  const engine = new SfmtEngine(1234);
  for (const expected of SEED_1234) {
    expect(engine.nextUint32()).toBe(expected);
  }
});

test("SFMT-19937 matches sfmt_init_by_array", () => {
  const engine = new SfmtEngine(Uint32Array.of(0x123, 0x234, 0x345, 0x456));
  expect(engine.nextUint32()).toBe(3886407011);
  expect(engine.nextUint32()).toBe(4281800351);
  expect(engine.nextUint32()).toBe(111076728);
  expect(engine.nextUint32()).toBe(81347708);
  expect(engine.nextUint32()).toBe(3833203606);
});

test("urand and irand follow libstdc++ uniform_int_distribution on the SFMT stream", () => {
  seedRandom(1234);
  expect(urand(0, 99)).toBe(80);
  seedRandom(1234);
  expect(irand(-1, 1)).toBe(1);
  seedRandom(1234);
  expect(rand32()).toBe(SEED_1234[0]);
});

test("frand and rand_norm use generate_canonical on the same stream", () => {
  const sample = SEED_1234[0];
  const canon = Math.fround(Math.fround(sample) / 4294967296);
  seedRandom(1234);
  expect(frand(0, 1)).toBe(Math.fround(Math.fround(canon * Math.fround(1)) + Math.fround(0)));

  const norm = (SEED_1234[0] + SEED_1234[1] * 4294967296) / 18446744073709551616;
  seedRandom(1234);
  expect(randNorm()).toBe(norm);
  seedRandom(1234);
  expect(randChance()).toBe(norm * 100);
});

test("roll_chance_i and weighted picks stay on the seeded stream", () => {
  seedRandom(1234);
  expect(rollChanceI(100)).toBe(true);
  seedRandom(1234);
  const norm = (SEED_1234[0] + SEED_1234[1] * 4294967296) / 18446744073709551616;
  const index = norm < 0.25 ? 0 : norm < 1 ? 1 : 2;
  expect(urandweighted([1, 3])).toBe(index);
});
