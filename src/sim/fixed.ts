// Fixed-point math (16.16), ported from m_fixed.c.
//
// Everything here must reproduce the C semantics bit-for-bit on all
// browsers: FixedMul is `(int32)(((int64)a * b) >> 16)` including
// wraparound, FixedDiv truncates toward zero like C int64 division.

export const FRACBITS = 16;
export const FRACUNIT = 1 << FRACBITS;

export const MININT = -2147483648;
export const MAXINT = 2147483647;

export type Fixed = number;

// Exact int64 multiply-shift via 16-bit limbs. Splitting each operand as
// a = ah*2^16 + al (ah signed, al unsigned) gives
//   (a*b) >> 16 = ah*bh*2^16 + ah*bl + al*bh + floor(al*bl / 2^16)
// Every term stays below 2^34, exact in doubles; `| 0` wraps mod 2^32
// exactly like the C cast to int32.
export function FixedMul(a: Fixed, b: Fixed): Fixed {
  const ah = a >> 16;
  const al = a & 0xffff;
  const bh = b >> 16;
  const bl = b & 0xffff;
  return (
    ((Math.imul(ah, bh) << 16) +
      Math.imul(ah, bl) +
      Math.imul(al, bh) +
      ((al * bl) >>> 16)) |
    0
  );
}

// FixedDiv is cold (slopes, aiming) so BigInt's exactness is worth its
// cost; double division could round across an integer boundary and desync.
export function FixedDiv(a: Fixed, b: Fixed): Fixed {
  // Vanilla overflow guard. In C, abs(INT_MIN) stays INT_MIN; ToInt32 in
  // the shift reproduces that, so keep Math.abs + >> as-is.
  if (Math.abs(a) >> 14 >= Math.abs(b)) {
    return (a ^ b) < 0 ? MININT : MAXINT;
  }
  return Number((BigInt(a) << 16n) / BigInt(b)) | 0;
}
