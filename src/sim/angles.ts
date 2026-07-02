// Fixed-point BSP side tests and angle math, ported from r_main.c.
// Angles are BAM stored as wrapping int32.

import { ANG90, ANG180, ANG270, SlopeDiv, tantoangle } from './tables.ts';
import { FixedMul, FRACBITS, type Fixed } from './fixed.ts';
import type { BspNode, Seg } from './world.ts';

export const NF_SUBSECTOR = 0x8000;

export function pointOnSide(x: Fixed, y: Fixed, node: BspNode): number {
  if (!node.dx) {
    if (x <= node.x) return node.dy > 0 ? 1 : 0;
    return node.dy < 0 ? 1 : 0;
  }
  if (!node.dy) {
    if (y <= node.y) return node.dx < 0 ? 1 : 0;
    return node.dx > 0 ? 1 : 0;
  }

  const dx = (x - node.x) | 0;
  const dy = (y - node.y) | 0;

  // Try to quickly decide by looking at sign bits.
  if ((node.dy ^ node.dx ^ dx ^ dy) & 0x80000000) {
    if ((node.dy ^ dx) & 0x80000000) return 1; // left is negative
    return 0;
  }

  const left = FixedMul(node.dy >> FRACBITS, dx);
  const right = FixedMul(dy, node.dx >> FRACBITS);
  return right < left ? 0 : 1;
}

export function pointOnSegSide(x: Fixed, y: Fixed, line: Seg): number {
  const lx = line.v1.x;
  const ly = line.v1.y;
  const ldx = (line.v2.x - lx) | 0;
  const ldy = (line.v2.y - ly) | 0;

  if (!ldx) {
    if (x <= lx) return ldy > 0 ? 1 : 0;
    return ldy < 0 ? 1 : 0;
  }
  if (!ldy) {
    if (y <= ly) return ldx < 0 ? 1 : 0;
    return ldx > 0 ? 1 : 0;
  }

  const dx = (x - lx) | 0;
  const dy = (y - ly) | 0;

  if ((ldy ^ ldx ^ dx ^ dy) & 0x80000000) {
    if ((ldy ^ dx) & 0x80000000) return 1;
    return 0;
  }

  const left = FixedMul(ldy >> FRACBITS, dx);
  const right = FixedMul(dy, ldx >> FRACBITS);
  return right < left ? 0 : 1;
}

/** R_PointToAngle with explicit view origin (R_PointToAngle2). */
export function pointToAngle2(x1: Fixed, y1: Fixed, x2: Fixed, y2: Fixed): number {
  let x = (x2 - x1) | 0;
  let y = (y2 - y1) | 0;

  if (!x && !y) return 0;

  if (x >= 0) {
    if (y >= 0) {
      if (x > y) return tantoangle[SlopeDiv(y, x)]!; // octant 0
      return (ANG90 - 1 - tantoangle[SlopeDiv(x, y)]!) | 0; // octant 1
    }
    y = -y | 0;
    if (x > y) return -tantoangle[SlopeDiv(y, x)]! | 0; // octant 8
    return (ANG270 + tantoangle[SlopeDiv(x, y)]!) | 0; // octant 7
  }
  x = -x | 0;
  if (y >= 0) {
    if (x > y) return (ANG180 - 1 - tantoangle[SlopeDiv(y, x)]!) | 0; // octant 3
    return (ANG90 + tantoangle[SlopeDiv(x, y)]!) | 0; // octant 2
  }
  y = -y | 0;
  if (x > y) return (ANG180 + tantoangle[SlopeDiv(y, x)]!) | 0; // octant 4
  return (ANG270 - 1 - tantoangle[SlopeDiv(x, y)]!) | 0; // octant 5
}
