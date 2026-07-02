// Doom's RNG, ported from m_random.c. Two independent cursors over the
// same 256-byte table: P_Random participates in gameplay (its call ORDER
// is part of sim state — never call it from rendering or UI code);
// M_Random is for cosmetic effects only.

import { rndtable } from './data/tables.gen.ts';

export class DoomRandom {
  prndindex = 0;
  rndindex = 0;

  /** Gameplay RNG — every call mutates sim state. */
  pRandom(): number {
    this.prndindex = (this.prndindex + 1) & 0xff;
    return rndtable[this.prndindex]!;
  }

  /** Cosmetic RNG — safe outside the deterministic path. */
  mRandom(): number {
    this.rndindex = (this.rndindex + 1) & 0xff;
    return rndtable[this.rndindex]!;
  }

  /** P_SubRandom: symmetric distribution around 0, used by many actions. */
  pSubRandom(): number {
    const r = this.pRandom();
    return r - this.pRandom();
  }

  clear(): void {
    this.prndindex = 0;
    this.rndindex = 0;
  }
}
