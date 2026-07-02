import { describe, expect, test } from 'vitest';
import { FRACUNIT, FixedDiv, FixedMul, MAXINT, MININT } from '../src/sim/fixed.ts';

// Bit-exact C reference implementations using BigInt.
function refMul(a: number, b: number): number {
  return Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> 16n));
}
function refDiv(a: number, b: number): number {
  const absA = a === MININT ? MININT : Math.abs(a); // C abs(INT_MIN) == INT_MIN
  if (absA >> 14 >= Math.abs(b)) return (a ^ b) < 0 ? MININT : MAXINT;
  return Number(BigInt.asIntN(32, (BigInt(a) << 16n) / BigInt(b)));
}

// Deterministic pseudo-random int32s covering all magnitude ranges.
function* testValues(): Generator<number> {
  const interesting = [
    0, 1, -1, 2, -2, FRACUNIT, -FRACUNIT, FRACUNIT - 1, -FRACUNIT + 1,
    0xffff, -0xffff, 0x10000, -0x10000, 0x7fff0000, -0x7fff0000,
    MAXINT, MININT, MININT + 1, 123456789, -123456789,
  ];
  yield* interesting;
  let x = 0x12345678;
  for (let i = 0; i < 2000; i++) {
    // xorshift32
    x ^= x << 13; x |= 0; x ^= x >>> 17; x ^= x << 5; x |= 0;
    yield x;
  }
}

describe('FixedMul', () => {
  test('matches int64 C semantics on interesting and random pairs', () => {
    const vals = [...testValues()];
    for (let i = 0; i < vals.length; i++) {
      const a = vals[i]!;
      const b = vals[(i * 7 + 13) % vals.length]!;
      expect(FixedMul(a, b), `FixedMul(${a}, ${b})`).toBe(refMul(a, b));
    }
  });

  test('basic identities', () => {
    expect(FixedMul(FRACUNIT, FRACUNIT)).toBe(FRACUNIT);
    expect(FixedMul(3 * FRACUNIT, 4 * FRACUNIT)).toBe(12 * FRACUNIT);
    expect(FixedMul(-3 * FRACUNIT, 4 * FRACUNIT)).toBe(-12 * FRACUNIT);
    expect(FixedMul(FRACUNIT / 2, FRACUNIT / 2)).toBe(FRACUNIT / 4);
    // Truncation direction: >> floors, so -0.5 * 0.5 = -0.25 exactly,
    // but tiny negatives floor away from zero.
    expect(FixedMul(-1, 1)).toBe(-1);
  });
});

describe('FixedDiv', () => {
  test('matches C semantics on interesting and random pairs', () => {
    const vals = [...testValues()];
    for (let i = 0; i < vals.length; i++) {
      const a = vals[i]!;
      const b = vals[(i * 11 + 29) % vals.length]!;
      if (b === 0) continue; // C would fault; sim never divides by 0 via guard
      expect(FixedDiv(a, b), `FixedDiv(${a}, ${b})`).toBe(refDiv(a, b));
    }
  });

  test('overflow guard', () => {
    expect(FixedDiv(MAXINT, 1)).toBe(MAXINT);
    expect(FixedDiv(MAXINT, -1)).toBe(MININT);
    // C oddity we deliberately reproduce: abs(INT_MIN) stays negative, so
    // the guard doesn't trip and the int32 cast of -2^47 wraps to 0.
    expect(FixedDiv(MININT, 1)).toBe(0);
  });

  test('truncates toward zero like C', () => {
    expect(FixedDiv(-3 * FRACUNIT, 2 * FRACUNIT)).toBe(-1.5 * FRACUNIT);
    expect(FixedDiv(FRACUNIT, 3 * FRACUNIT)).toBe(21845); // 0x5555, trunc
    expect(FixedDiv(-FRACUNIT, 3 * FRACUNIT)).toBe(-21845);
  });
});
