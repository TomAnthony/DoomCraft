// Ceiling animation (lowering, crushing, raising), ported from p_ceilng.c.
// The vanilla activeceilings[] table is kept as a fixed 30-slot array;
// note vanilla P_AddActiveCeiling silently drops overflowing ceilings.

import { SFX } from '../data/sounds.gen.ts';
import { FRACUNIT, type Fixed } from '../fixed.ts';
import type { DoomSim } from '../sim.ts';
import type { Thinker } from '../thinker.ts';
import type { Line, Sector } from '../world.ts';
import { P_FindHighestCeilingSurrounding, P_FindSectorFromLineTag } from './spec.ts';
import { Result, T_MovePlane } from './floors.ts';

export const enum CeilingType {
  LowerToFloor,
  RaiseToHighest,
  LowerAndCrush,
  CrushAndRaise,
  FastCrushAndRaise,
  SilentCrushAndRaise,
}

export const CEILSPEED = FRACUNIT;
export const CEILWAIT = 150;
export const MAXCEILINGS = 30;

const activeceilings: (Ceiling | null)[] = new Array<Ceiling | null>(MAXCEILINGS).fill(null);

/** Clear the activeceilings table (level start). */
export function resetActiveCeilings(): void {
  activeceilings.fill(null);
}

export class Ceiling implements Thinker {
  tprev: Thinker | null = null;
  tnext: Thinker | null = null;
  removed = false;

  type: CeilingType = CeilingType.LowerToFloor;
  sector!: Sector;
  bottomheight: Fixed = 0;
  topheight: Fixed = 0;
  speed: Fixed = 0;
  crush = false;

  /** 1 = up, 0 = waiting (in stasis), -1 = down */
  direction = 0;

  /** ID */
  tag = 0;
  olddirection = 0;

  constructor(private readonly sim: DoomSim) {}

  think(): void {
    T_MoveCeiling(this.sim, this);
  }
}

//
// T_MoveCeiling
//
export function T_MoveCeiling(sim: DoomSim, ceiling: Ceiling): void {
  let res: Result;

  switch (ceiling.direction) {
    case 0:
      // IN STASIS
      break;
    case 1:
      // UP
      res = T_MovePlane(
        sim, ceiling.sector, ceiling.speed, ceiling.topheight,
        false, 1, ceiling.direction,
      );

      if (!(sim.leveltime & 7)) {
        switch (ceiling.type) {
          case CeilingType.SilentCrushAndRaise:
            break;
          default:
            sim.startSectorSound(ceiling.sector, SFX.stnmov);
            // ?
            break;
        }
      }

      if (res === Result.PastDest) {
        switch (ceiling.type) {
          case CeilingType.RaiseToHighest:
            P_RemoveActiveCeiling(ceiling);
            break;

          case CeilingType.SilentCrushAndRaise:
            sim.startSectorSound(ceiling.sector, SFX.pstop);
          // fallthrough
          case CeilingType.FastCrushAndRaise:
          case CeilingType.CrushAndRaise:
            ceiling.direction = -1;
            break;

          default:
            break;
        }
      }
      break;

    case -1:
      // DOWN
      res = T_MovePlane(
        sim, ceiling.sector, ceiling.speed, ceiling.bottomheight,
        ceiling.crush, 1, ceiling.direction,
      );

      if (!(sim.leveltime & 7)) {
        switch (ceiling.type) {
          case CeilingType.SilentCrushAndRaise:
            break;
          default:
            sim.startSectorSound(ceiling.sector, SFX.stnmov);
        }
      }

      if (res === Result.PastDest) {
        switch (ceiling.type) {
          case CeilingType.SilentCrushAndRaise:
            sim.startSectorSound(ceiling.sector, SFX.pstop);
          // fallthrough
          case CeilingType.CrushAndRaise:
            ceiling.speed = CEILSPEED;
          // fallthrough
          case CeilingType.FastCrushAndRaise:
            ceiling.direction = 1;
            break;

          case CeilingType.LowerAndCrush:
          case CeilingType.LowerToFloor:
            P_RemoveActiveCeiling(ceiling);
            break;

          default:
            break;
        }
      } else {
        // ( res != pastdest )
        if (res === Result.Crushed) {
          switch (ceiling.type) {
            case CeilingType.SilentCrushAndRaise:
            case CeilingType.CrushAndRaise:
            case CeilingType.LowerAndCrush:
              ceiling.speed = (CEILSPEED / 8) | 0;
              break;

            default:
              break;
          }
        }
      }
      break;
  }
}

//
// EV_DoCeiling
// Move a ceiling up/down and all around!
//
export function EV_DoCeiling(sim: DoomSim, line: Line, type: CeilingType): number {
  const w = sim.world;
  let secnum = -1;
  let rtn = 0;

  //	Reactivate in-stasis ceilings...for certain types.
  switch (type) {
    case CeilingType.FastCrushAndRaise:
    case CeilingType.SilentCrushAndRaise:
    case CeilingType.CrushAndRaise:
      P_ActivateInStasisCeiling(line);
    // fallthrough
    default:
      break;
  }

  while ((secnum = P_FindSectorFromLineTag(sim, line, secnum)) >= 0) {
    const sec = w.sectors[secnum]!;
    if (sec.specialdata) continue;

    // new door thinker
    rtn = 1;
    const ceiling = new Ceiling(sim);
    sim.thinkers.add(ceiling);
    sec.specialdata = ceiling;
    ceiling.sector = sec;
    ceiling.crush = false;

    switch (type) {
      case CeilingType.FastCrushAndRaise:
        ceiling.crush = true;
        ceiling.topheight = sec.ceilingheight;
        ceiling.bottomheight = (sec.floorheight + 8 * FRACUNIT) | 0;
        ceiling.direction = -1;
        ceiling.speed = CEILSPEED * 2;
        break;

      case CeilingType.SilentCrushAndRaise:
      case CeilingType.CrushAndRaise:
        ceiling.crush = true;
        ceiling.topheight = sec.ceilingheight;
      // fallthrough
      case CeilingType.LowerAndCrush:
      case CeilingType.LowerToFloor:
        ceiling.bottomheight = sec.floorheight;
        if (type !== CeilingType.LowerToFloor) {
          ceiling.bottomheight = (ceiling.bottomheight + 8 * FRACUNIT) | 0;
        }
        ceiling.direction = -1;
        ceiling.speed = CEILSPEED;
        break;

      case CeilingType.RaiseToHighest:
        ceiling.topheight = P_FindHighestCeilingSurrounding(sec);
        ceiling.direction = 1;
        ceiling.speed = CEILSPEED;
        break;
    }

    ceiling.tag = sec.tag;
    ceiling.type = type;
    P_AddActiveCeiling(ceiling);
  }
  return rtn;
}

//
// Add an active ceiling
//
export function P_AddActiveCeiling(c: Ceiling): void {
  for (let i = 0; i < MAXCEILINGS; i++) {
    if (activeceilings[i] === null) {
      activeceilings[i] = c;
      return;
    }
  }
  // (vanilla silently drops it: no I_Error here)
}

//
// Remove a ceiling's thinker
//
export function P_RemoveActiveCeiling(c: Ceiling): void {
  for (let i = 0; i < MAXCEILINGS; i++) {
    if (activeceilings[i] === c) {
      c.sector.specialdata = null;
      c.removed = true; // P_RemoveThinker
      activeceilings[i] = null;
      break;
    }
  }
}

//
// Restart a ceiling that's in-stasis
//
export function P_ActivateInStasisCeiling(line: Line): void {
  for (let i = 0; i < MAXCEILINGS; i++) {
    const c = activeceilings[i];
    if (c && c.tag === line.tag && c.direction === 0) {
      c.direction = c.olddirection;
      // (C also restores thinker.function; our think() no-ops on
      // direction 0 so nothing else to do)
    }
  }
}

//
// EV_CeilingCrushStop
// Stop a ceiling from crushing!
//
export function EV_CeilingCrushStop(line: Line): number {
  let rtn = 0;
  for (let i = 0; i < MAXCEILINGS; i++) {
    const c = activeceilings[i];
    if (c && c.tag === line.tag && c.direction !== 0) {
      c.olddirection = c.direction;
      c.direction = 0; // in-stasis
      rtn = 1;
    }
  }
  return rtn;
}
