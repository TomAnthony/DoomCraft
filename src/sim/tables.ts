// Angle and trig tables, ported from tables.h/tables.c.
//
// Angles are 32-bit "binary angle measurement" (BAM): the full circle is
// the full uint32 range and wraparound is load-bearing. We keep angles as
// signed int32 (what `| 0` gives us) and convert with `>>> 0` only when a
// comparison needs unsigned ordering.

import { finesine, finetangent, tantoangle } from './data/tables.gen.ts';

export { finesine, finetangent, tantoangle };

export const FINEANGLES = 8192;
export const FINEMASK = FINEANGLES - 1;
export const ANGLETOFINESHIFT = 19;

export const ANG45 = 0x20000000;
export const ANG90 = 0x40000000;
export const ANG180 = -0x80000000; // 0x80000000 as int32
export const ANG270 = -0x40000000; // 0xc0000000 as int32

export const SLOPERANGE = 2048;
export const SLOPEBITS = 11;
export const DBITS = 16 - SLOPEBITS;

// finecosine is finesine offset by a quarter turn (shared storage in C:
// `#define finecosine (finesine + FINEANGLES/4)`). The table carries an
// extra 2048 entries so no masking is needed — callers pass fine angles
// already masked to [0, FINEANGLES).
export function finecosine(i: number): number {
  return finesine[i + FINEANGLES / 4]!;
}

// SlopeDiv from tables.c; num/den are treated as unsigned 32-bit.
export function SlopeDiv(num: number, den: number): number {
  const uden = den >>> 0;
  if (uden < 512) return SLOPERANGE;
  // (num << 3) wraps mod 2^32 in C; `<< 3 >>> 0` reproduces that.
  const ans = Math.floor(((num << 3) >>> 0) / (uden >> 8));
  return ans <= SLOPERANGE ? ans : SLOPERANGE;
}
