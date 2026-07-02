// Sector base lighting effects, ported from p_lights.c.

import type { DoomSim } from '../sim.ts';
import type { Thinker } from '../thinker.ts';
import type { Line, Sector } from '../world.ts';
import { getNextSector, P_FindMinSurroundingLight, P_FindSectorFromLineTag } from './spec.ts';

export const GLOWSPEED = 8;
export const STROBEBRIGHT = 5;
export const FASTDARK = 15;
export const SLOWDARK = 35;

//
// FIRELIGHT FLICKER
//
export class FireFlicker implements Thinker {
  tprev: Thinker | null = null;
  tnext: Thinker | null = null;
  removed = false;

  sector!: Sector;
  count = 0;
  maxlight = 0;
  minlight = 0;

  constructor(private readonly sim: DoomSim) {}

  /** T_FireFlicker */
  think(): void {
    if (--this.count) return;

    const amount = (this.sim.rng.pRandom() & 3) * 16;

    if (this.sector.lightlevel - amount < this.minlight) {
      this.sector.lightlevel = this.minlight;
    } else {
      this.sector.lightlevel = this.maxlight - amount;
    }

    this.count = 4;
  }
}

//
// P_SpawnFireFlicker
//
export function P_SpawnFireFlicker(sim: DoomSim, sector: Sector): void {
  // Note that we are resetting sector attributes.
  // Nothing special about it during gameplay.
  sector.special = 0;

  const flick = new FireFlicker(sim);
  sim.thinkers.add(flick);

  flick.sector = sector;
  flick.maxlight = sector.lightlevel;
  flick.minlight = P_FindMinSurroundingLight(sector, sector.lightlevel) + 16;
  flick.count = 4;
}

//
// BROKEN LIGHT FLASHING
//
export class LightFlash implements Thinker {
  tprev: Thinker | null = null;
  tnext: Thinker | null = null;
  removed = false;

  sector!: Sector;
  count = 0;
  maxlight = 0;
  minlight = 0;
  maxtime = 0;
  mintime = 0;

  constructor(private readonly sim: DoomSim) {}

  /** T_LightFlash: do flashing lights. */
  think(): void {
    if (--this.count) return;

    if (this.sector.lightlevel === this.maxlight) {
      this.sector.lightlevel = this.minlight;
      this.count = (this.sim.rng.pRandom() & this.mintime) + 1;
    } else {
      this.sector.lightlevel = this.maxlight;
      this.count = (this.sim.rng.pRandom() & this.maxtime) + 1;
    }
  }
}

//
// P_SpawnLightFlash
// After the map has been loaded, scan each sector
// for specials that spawn thinkers
//
export function P_SpawnLightFlash(sim: DoomSim, sector: Sector): void {
  // nothing special about it during gameplay
  sector.special = 0;

  const flash = new LightFlash(sim);
  sim.thinkers.add(flash);

  flash.sector = sector;
  flash.maxlight = sector.lightlevel;

  flash.minlight = P_FindMinSurroundingLight(sector, sector.lightlevel);
  flash.maxtime = 64;
  flash.mintime = 7;
  flash.count = (sim.rng.pRandom() & flash.maxtime) + 1;
}

//
// STROBE LIGHT FLASHING
//
export class StrobeFlash implements Thinker {
  tprev: Thinker | null = null;
  tnext: Thinker | null = null;
  removed = false;

  sector!: Sector;
  count = 0;
  minlight = 0;
  maxlight = 0;
  darktime = 0;
  brighttime = 0;

  /** T_StrobeFlash */
  think(): void {
    if (--this.count) return;

    if (this.sector.lightlevel === this.minlight) {
      this.sector.lightlevel = this.maxlight;
      this.count = this.brighttime;
    } else {
      this.sector.lightlevel = this.minlight;
      this.count = this.darktime;
    }
  }
}

//
// P_SpawnStrobeFlash
// After the map has been loaded, scan each sector
// for specials that spawn thinkers
//
export function P_SpawnStrobeFlash(
  sim: DoomSim,
  sector: Sector,
  fastOrSlow: number,
  inSync: number,
): void {
  const flash = new StrobeFlash();
  sim.thinkers.add(flash);

  flash.sector = sector;
  flash.darktime = fastOrSlow;
  flash.brighttime = STROBEBRIGHT;
  flash.maxlight = sector.lightlevel;
  flash.minlight = P_FindMinSurroundingLight(sector, sector.lightlevel);

  if (flash.minlight === flash.maxlight) flash.minlight = 0;

  // nothing special about it during gameplay
  sector.special = 0;

  if (!inSync) flash.count = (sim.rng.pRandom() & 7) + 1;
  else flash.count = 1;
}

//
// Start strobing lights (usually from a trigger)
//
export function EV_StartLightStrobing(sim: DoomSim, line: Line): void {
  let secnum = -1;
  while ((secnum = P_FindSectorFromLineTag(sim, line, secnum)) >= 0) {
    const sec = sim.world.sectors[secnum]!;
    if (sec.specialdata) continue;

    P_SpawnStrobeFlash(sim, sec, SLOWDARK, 0);
  }
}

//
// TURN LINE'S TAG LIGHTS OFF
//
export function EV_TurnTagLightsOff(sim: DoomSim, line: Line): void {
  for (const sector of sim.world.sectors) {
    if (sector.tag === line.tag) {
      let min = sector.lightlevel;
      for (const templine of sector.lines) {
        const tsec = getNextSector(templine, sector);
        if (!tsec) continue;
        if (tsec.lightlevel < min) min = tsec.lightlevel;
      }
      sector.lightlevel = min;
    }
  }
}

//
// TURN LINE'S TAG LIGHTS ON
//
export function EV_LightTurnOn(sim: DoomSim, line: Line, bright: number): void {
  for (const sector of sim.world.sectors) {
    if (sector.tag === line.tag) {
      // bright = 0 means to search
      // for highest light level
      // surrounding sector
      if (!bright) {
        for (const templine of sector.lines) {
          const temp = getNextSector(templine, sector);

          if (!temp) continue;

          if (temp.lightlevel > bright) bright = temp.lightlevel;
        }
      }
      sector.lightlevel = bright;
    }
  }
}

//
// Spawn glowing light
//
export class Glow implements Thinker {
  tprev: Thinker | null = null;
  tnext: Thinker | null = null;
  removed = false;

  sector!: Sector;
  minlight = 0;
  maxlight = 0;
  direction = 0;

  /** T_Glow */
  think(): void {
    switch (this.direction) {
      case -1:
        // DOWN
        this.sector.lightlevel -= GLOWSPEED;
        if (this.sector.lightlevel <= this.minlight) {
          this.sector.lightlevel += GLOWSPEED;
          this.direction = 1;
        }
        break;

      case 1:
        // UP
        this.sector.lightlevel += GLOWSPEED;
        if (this.sector.lightlevel >= this.maxlight) {
          this.sector.lightlevel -= GLOWSPEED;
          this.direction = -1;
        }
        break;
    }
  }
}

export function P_SpawnGlowingLight(sim: DoomSim, sector: Sector): void {
  const g = new Glow();
  sim.thinkers.add(g);

  g.sector = sector;
  g.minlight = P_FindMinSurroundingLight(sector, sector.lightlevel);
  g.maxlight = sector.lightlevel;
  g.direction = -1;

  sector.special = 0;
}
