// Plats (elevator platforms), ported from p_plats.c. The vanilla
// activeplats[] table is kept as a fixed 30-slot array: overflowing it is
// an I_Error, and stasis/removal scan the slots in order.

import { SFX } from '../data/sounds.gen.ts';
import { TICRATE } from '../defs.ts';
import { FRACUNIT, type Fixed } from '../fixed.ts';
import type { DoomSim } from '../sim.ts';
import type { Thinker } from '../thinker.ts';
import type { Line, Sector } from '../world.ts';
import {
  P_FindHighestFloorSurrounding, P_FindLowestFloorSurrounding,
  P_FindNextHighestFloor, P_FindSectorFromLineTag,
} from './spec.ts';
import { Result, T_MovePlane } from './floors.ts';

export const enum PlatStatus {
  Up,
  Down,
  Waiting,
  InStasis,
}

export const enum PlatType {
  PerpetualRaise,
  DownWaitUpStay,
  RaiseAndChange,
  RaiseToNearestAndChange,
  BlazeDWUS,
}

export const PLATWAIT = 3;
export const PLATSPEED = FRACUNIT;
export const MAXPLATS = 30;

const activeplats: (Plat | null)[] = new Array<Plat | null>(MAXPLATS).fill(null);

/** Clear the activeplats table (level start). */
export function resetActivePlats(): void {
  activeplats.fill(null);
}

export class Plat implements Thinker {
  tprev: Thinker | null = null;
  tnext: Thinker | null = null;
  removed = false;

  sector!: Sector;
  speed: Fixed = 0;
  low: Fixed = 0;
  high: Fixed = 0;
  wait = 0;
  count = 0;
  status: PlatStatus = PlatStatus.Up;
  oldstatus: PlatStatus = PlatStatus.Up;
  crush = false;
  tag = 0;
  type: PlatType = PlatType.PerpetualRaise;

  constructor(private readonly sim: DoomSim) {}

  think(): void {
    T_PlatRaise(this.sim, this);
  }
}

//
// Move a plat up and down
//
export function T_PlatRaise(sim: DoomSim, plat: Plat): void {
  let res: Result;

  switch (plat.status) {
    case PlatStatus.Up:
      res = T_MovePlane(sim, plat.sector, plat.speed, plat.high, plat.crush, 0, 1);

      if (plat.type === PlatType.RaiseAndChange
        || plat.type === PlatType.RaiseToNearestAndChange) {
        if (!(sim.leveltime & 7)) sim.startSectorSound(plat.sector, SFX.stnmov);
      }

      if (res === Result.Crushed && !plat.crush) {
        plat.count = plat.wait;
        plat.status = PlatStatus.Down;
        sim.startSectorSound(plat.sector, SFX.pstart);
      } else {
        if (res === Result.PastDest) {
          plat.count = plat.wait;
          plat.status = PlatStatus.Waiting;
          sim.startSectorSound(plat.sector, SFX.pstop);

          switch (plat.type) {
            case PlatType.BlazeDWUS:
            case PlatType.DownWaitUpStay:
              P_RemoveActivePlat(plat);
              break;

            case PlatType.RaiseAndChange:
            case PlatType.RaiseToNearestAndChange:
              P_RemoveActivePlat(plat);
              break;

            default:
              break;
          }
        }
      }
      break;

    case PlatStatus.Down:
      res = T_MovePlane(sim, plat.sector, plat.speed, plat.low, false, 0, -1);

      if (res === Result.PastDest) {
        plat.count = plat.wait;
        plat.status = PlatStatus.Waiting;
        sim.startSectorSound(plat.sector, SFX.pstop);
      }
      break;

    case PlatStatus.Waiting:
      if (!--plat.count) {
        if (plat.sector.floorheight === plat.low) plat.status = PlatStatus.Up;
        else plat.status = PlatStatus.Down;
        sim.startSectorSound(plat.sector, SFX.pstart);
      }
    // fallthrough (vanilla)
    case PlatStatus.InStasis:
      break;
  }
}

//
// Do Platforms
//  "amount" is only used for SOME platforms.
//
export function EV_DoPlat(sim: DoomSim, line: Line, type: PlatType, amount: number): number {
  const w = sim.world;
  let secnum = -1;
  let rtn = 0;

  //	Activate all <type> plats that are in_stasis
  switch (type) {
    case PlatType.PerpetualRaise:
      P_ActivateInStasis(line.tag);
      break;

    default:
      break;
  }

  while ((secnum = P_FindSectorFromLineTag(sim, line, secnum)) >= 0) {
    const sec = w.sectors[secnum]!;

    if (sec.specialdata) continue;

    // Find lowest & highest floors around sector
    rtn = 1;
    const plat = new Plat(sim);
    sim.thinkers.add(plat);

    plat.type = type;
    plat.sector = sec;
    plat.sector.specialdata = plat;
    plat.crush = false;
    plat.tag = line.tag;

    switch (type) {
      case PlatType.RaiseToNearestAndChange:
        plat.speed = (PLATSPEED / 2) | 0;
        sec.floorpic = w.sides[line.sidenum[0]]!.sector.floorpic;
        plat.high = P_FindNextHighestFloor(sec, sec.floorheight);
        plat.wait = 0;
        plat.status = PlatStatus.Up;
        // NO MORE DAMAGE, IF APPLICABLE
        sec.special = 0;

        sim.startSectorSound(sec, SFX.stnmov);
        break;

      case PlatType.RaiseAndChange:
        plat.speed = (PLATSPEED / 2) | 0;
        sec.floorpic = w.sides[line.sidenum[0]]!.sector.floorpic;
        plat.high = (sec.floorheight + amount * FRACUNIT) | 0;
        plat.wait = 0;
        plat.status = PlatStatus.Up;

        sim.startSectorSound(sec, SFX.stnmov);
        break;

      case PlatType.DownWaitUpStay:
        plat.speed = PLATSPEED * 4;
        plat.low = P_FindLowestFloorSurrounding(sec);

        if (plat.low > sec.floorheight) plat.low = sec.floorheight;

        plat.high = sec.floorheight;
        plat.wait = TICRATE * PLATWAIT;
        plat.status = PlatStatus.Down;
        sim.startSectorSound(sec, SFX.pstart);
        break;

      case PlatType.BlazeDWUS:
        plat.speed = PLATSPEED * 8;
        plat.low = P_FindLowestFloorSurrounding(sec);

        if (plat.low > sec.floorheight) plat.low = sec.floorheight;

        plat.high = sec.floorheight;
        plat.wait = TICRATE * PLATWAIT;
        plat.status = PlatStatus.Down;
        sim.startSectorSound(sec, SFX.pstart);
        break;

      case PlatType.PerpetualRaise:
        plat.speed = PLATSPEED;
        plat.low = P_FindLowestFloorSurrounding(sec);

        if (plat.low > sec.floorheight) plat.low = sec.floorheight;

        plat.high = P_FindHighestFloorSurrounding(sec);

        if (plat.high < sec.floorheight) plat.high = sec.floorheight;

        plat.wait = TICRATE * PLATWAIT;
        plat.status = (sim.rng.pRandom() & 1) as PlatStatus;

        sim.startSectorSound(sec, SFX.pstart);
        break;
    }
    P_AddActivePlat(plat);
  }
  return rtn;
}

export function P_ActivateInStasis(tag: number): void {
  for (let i = 0; i < MAXPLATS; i++) {
    const plat = activeplats[i];
    if (plat && plat.tag === tag && plat.status === PlatStatus.InStasis) {
      plat.status = plat.oldstatus;
      // (C also restores thinker.function to T_PlatRaise; our think()
      // is a no-op while in_stasis, so nothing else to do)
    }
  }
}

export function EV_StopPlat(line: Line): void {
  for (let j = 0; j < MAXPLATS; j++) {
    const plat = activeplats[j];
    if (plat && plat.status !== PlatStatus.InStasis && plat.tag === line.tag) {
      plat.oldstatus = plat.status;
      plat.status = PlatStatus.InStasis;
      // (C nulls thinker.function; T_PlatRaise on in_stasis is a no-op)
    }
  }
}

export function P_AddActivePlat(plat: Plat): void {
  for (let i = 0; i < MAXPLATS; i++) {
    if (activeplats[i] === null) {
      activeplats[i] = plat;
      return;
    }
  }
  throw new Error('P_AddActivePlat: no more plats!');
}

export function P_RemoveActivePlat(plat: Plat): void {
  for (let i = 0; i < MAXPLATS; i++) {
    if (plat === activeplats[i]) {
      plat.sector.specialdata = null;
      plat.removed = true; // P_RemoveThinker
      activeplats[i] = null;
      return;
    }
  }
  throw new Error("P_RemoveActivePlat: can't find plat!");
}
