// Floor movers, ported from p_floor.c (plus EV_DoDonut from p_spec.c):
// T_MovePlane is THE core plane mover shared by floors/doors/ceilings.

import { SFX } from '../data/sounds.gen.ts';
import { ML_TWOSIDED } from '../defs.ts';
import { FRACUNIT, MAXINT, type Fixed } from '../fixed.ts';
import type { DoomSim } from '../sim.ts';
import type { Thinker } from '../thinker.ts';
import type { Line, Sector } from '../world.ts';
import {
  getNextSector, getSector, getSide,
  P_FindHighestFloorSurrounding, P_FindLowestCeilingSurrounding,
  P_FindLowestFloorSurrounding, P_FindNextHighestFloor,
  P_FindSectorFromLineTag, twoSided,
} from './spec.ts';

// e6y
const STAIRS_UNINITIALIZED_CRUSH_FIELD_VALUE = 10;

export const FLOORSPEED = FRACUNIT;

export const enum Result {
  Ok,
  Crushed,
  PastDest,
}

export const enum FloorType {
  /** lower floor to highest surrounding floor */
  LowerFloor,
  /** lower floor to lowest surrounding floor */
  LowerFloorToLowest,
  /** lower floor to highest surrounding floor VERY FAST */
  TurboLower,
  /** raise floor to lowest surrounding CEILING */
  RaiseFloor,
  /** raise floor to next highest surrounding floor */
  RaiseFloorToNearest,
  /** raise floor to shortest height texture around it */
  RaiseToTexture,
  /** lower floor to lowest surrounding floor and change floorpic */
  LowerAndChange,
  RaiseFloor24,
  RaiseFloor24AndChange,
  RaiseFloorCrush,
  /** raise to next highest floor, turbo-speed */
  RaiseFloorTurbo,
  DonutRaise,
  RaiseFloor512,
}

export const enum StairType {
  Build8, // slowly build by 8
  Turbo16, // quickly build by 16
}

// Texture heights by NAME in fixed point (C textureheight[], render data);
// populated by the game shell after wad load. Needed only by the
// raiseToTexture floor type. DEVIATION: entries missing from this map are
// skipped instead of reading textureheight[0] like vanilla does for the
// "-" (no texture) sidedef entry.
export const textureHeights = new Map<string, Fixed>();

//
// Move a plane (floor or ceiling) and check for crushing
//
export function T_MovePlane(
  sim: DoomSim,
  sector: Sector,
  speed: Fixed,
  dest: Fixed,
  crush: boolean | number,
  floorOrCeiling: number,
  direction: number,
): Result {
  let flag: boolean;
  let lastpos: Fixed;
  // C P_ChangeSector takes crush as int; the stairs quirk value (10) is
  // truthy there but fails the `crush == true` comparisons below.
  const crunch = !!crush;

  switch (floorOrCeiling) {
    case 0:
      // FLOOR
      switch (direction) {
        case -1:
          // DOWN
          if (((sector.floorheight - speed) | 0) < dest) {
            lastpos = sector.floorheight;
            sector.floorheight = dest;
            flag = sim.pmap.changeSector(sector, crunch);
            if (flag) {
              sector.floorheight = lastpos;
              sim.pmap.changeSector(sector, crunch);
              // return crushed;
            }
            return Result.PastDest;
          } else {
            lastpos = sector.floorheight;
            sector.floorheight = (sector.floorheight - speed) | 0;
            flag = sim.pmap.changeSector(sector, crunch);
            if (flag) {
              sector.floorheight = lastpos;
              sim.pmap.changeSector(sector, crunch);
              return Result.Crushed;
            }
          }
          break;

        case 1:
          // UP
          if (((sector.floorheight + speed) | 0) > dest) {
            lastpos = sector.floorheight;
            sector.floorheight = dest;
            flag = sim.pmap.changeSector(sector, crunch);
            if (flag) {
              sector.floorheight = lastpos;
              sim.pmap.changeSector(sector, crunch);
              // return crushed;
            }
            return Result.PastDest;
          } else {
            // COULD GET CRUSHED
            lastpos = sector.floorheight;
            sector.floorheight = (sector.floorheight + speed) | 0;
            flag = sim.pmap.changeSector(sector, crunch);
            if (flag) {
              if (crush === true) return Result.Crushed;
              sector.floorheight = lastpos;
              sim.pmap.changeSector(sector, crunch);
              return Result.Crushed;
            }
          }
          break;
      }
      break;

    case 1:
      // CEILING
      switch (direction) {
        case -1:
          // DOWN
          if (((sector.ceilingheight - speed) | 0) < dest) {
            lastpos = sector.ceilingheight;
            sector.ceilingheight = dest;
            flag = sim.pmap.changeSector(sector, crunch);
            if (flag) {
              sector.ceilingheight = lastpos;
              sim.pmap.changeSector(sector, crunch);
              // return crushed;
            }
            return Result.PastDest;
          } else {
            // COULD GET CRUSHED
            lastpos = sector.ceilingheight;
            sector.ceilingheight = (sector.ceilingheight - speed) | 0;
            flag = sim.pmap.changeSector(sector, crunch);
            if (flag) {
              if (crush === true) return Result.Crushed;
              sector.ceilingheight = lastpos;
              sim.pmap.changeSector(sector, crunch);
              return Result.Crushed;
            }
          }
          break;

        case 1:
          // UP
          if (((sector.ceilingheight + speed) | 0) > dest) {
            lastpos = sector.ceilingheight;
            sector.ceilingheight = dest;
            flag = sim.pmap.changeSector(sector, crunch);
            if (flag) {
              sector.ceilingheight = lastpos;
              sim.pmap.changeSector(sector, crunch);
              // return crushed;
            }
            return Result.PastDest;
          } else {
            sector.ceilingheight = (sector.ceilingheight + speed) | 0;
            sim.pmap.changeSector(sector, crunch);
            // (crush check UNUSED in vanilla)
          }
          break;
      }
      break;
  }
  return Result.Ok;
}

export class FloorMove implements Thinker {
  tprev: Thinker | null = null;
  tnext: Thinker | null = null;
  removed = false;

  type: FloorType = FloorType.LowerFloor;
  /** stairs leave this "uninitialized" (10, e6y emulation), see EV_BuildStairs */
  crush: boolean | number = false;
  sector!: Sector;
  direction = 0;
  newspecial = 0;
  texture = '';
  floordestheight: Fixed = 0;
  speed: Fixed = 0;

  constructor(private readonly sim: DoomSim) {}

  think(): void {
    T_MoveFloor(this.sim, this);
  }
}

//
// MOVE A FLOOR TO IT'S DESTINATION (UP OR DOWN)
//
export function T_MoveFloor(sim: DoomSim, floor: FloorMove): void {
  const res = T_MovePlane(
    sim, floor.sector, floor.speed, floor.floordestheight,
    floor.crush, 0, floor.direction,
  );

  if (!(sim.leveltime & 7)) sim.startSectorSound(floor.sector, SFX.stnmov);

  if (res === Result.PastDest) {
    floor.sector.specialdata = null;

    if (floor.direction === 1) {
      switch (floor.type) {
        case FloorType.DonutRaise:
          floor.sector.special = floor.newspecial;
          floor.sector.floorpic = floor.texture;
        // fallthrough
        default:
          break;
      }
    } else if (floor.direction === -1) {
      switch (floor.type) {
        case FloorType.LowerAndChange:
          floor.sector.special = floor.newspecial;
          floor.sector.floorpic = floor.texture;
        // fallthrough
        default:
          break;
      }
    }
    floor.removed = true; // P_RemoveThinker

    sim.startSectorSound(floor.sector, SFX.pstop);
  }
}

//
// HANDLE FLOOR TYPES
//
export function EV_DoFloor(sim: DoomSim, line: Line, floortype: FloorType): number {
  const w = sim.world;
  let secnum = -1;
  let rtn = 0;

  while ((secnum = P_FindSectorFromLineTag(sim, line, secnum)) >= 0) {
    let sec = w.sectors[secnum]!;

    // ALREADY MOVING?  IF SO, KEEP GOING...
    if (sec.specialdata) continue;

    // new floor thinker
    rtn = 1;
    const floor = new FloorMove(sim);
    sim.thinkers.add(floor);
    sec.specialdata = floor;
    floor.type = floortype;
    floor.crush = false;

    switch (floortype) {
      case FloorType.LowerFloor:
        floor.direction = -1;
        floor.sector = sec;
        floor.speed = FLOORSPEED;
        floor.floordestheight = P_FindHighestFloorSurrounding(sec);
        break;

      case FloorType.LowerFloorToLowest:
        floor.direction = -1;
        floor.sector = sec;
        floor.speed = FLOORSPEED;
        floor.floordestheight = P_FindLowestFloorSurrounding(sec);
        break;

      case FloorType.TurboLower:
        floor.direction = -1;
        floor.sector = sec;
        floor.speed = FLOORSPEED * 4;
        floor.floordestheight = P_FindHighestFloorSurrounding(sec);
        // (gameversion > exe_doom_1_2)
        if (floor.floordestheight !== sec.floorheight) {
          floor.floordestheight = (floor.floordestheight + 8 * FRACUNIT) | 0;
        }
        break;

      case FloorType.RaiseFloorCrush:
        floor.crush = true;
      // fallthrough
      case FloorType.RaiseFloor:
        floor.direction = 1;
        floor.sector = sec;
        floor.speed = FLOORSPEED;
        floor.floordestheight = P_FindLowestCeilingSurrounding(sec);
        if (floor.floordestheight > sec.ceilingheight) {
          floor.floordestheight = sec.ceilingheight;
        }
        if (floortype === FloorType.RaiseFloorCrush) {
          floor.floordestheight = (floor.floordestheight - 8 * FRACUNIT) | 0;
        }
        break;

      case FloorType.RaiseFloorTurbo:
        floor.direction = 1;
        floor.sector = sec;
        floor.speed = FLOORSPEED * 4;
        floor.floordestheight = P_FindNextHighestFloor(sec, sec.floorheight);
        break;

      case FloorType.RaiseFloorToNearest:
        floor.direction = 1;
        floor.sector = sec;
        floor.speed = FLOORSPEED;
        floor.floordestheight = P_FindNextHighestFloor(sec, sec.floorheight);
        break;

      case FloorType.RaiseFloor24:
        floor.direction = 1;
        floor.sector = sec;
        floor.speed = FLOORSPEED;
        floor.floordestheight = (floor.sector.floorheight + 24 * FRACUNIT) | 0;
        break;

      case FloorType.RaiseFloor512:
        floor.direction = 1;
        floor.sector = sec;
        floor.speed = FLOORSPEED;
        floor.floordestheight = (floor.sector.floorheight + 512 * FRACUNIT) | 0;
        break;

      case FloorType.RaiseFloor24AndChange:
        floor.direction = 1;
        floor.sector = sec;
        floor.speed = FLOORSPEED;
        floor.floordestheight = (floor.sector.floorheight + 24 * FRACUNIT) | 0;
        sec.floorpic = line.frontsector!.floorpic;
        sec.special = line.frontsector!.special;
        break;

      case FloorType.RaiseToTexture: {
        let minsize = MAXINT;

        floor.direction = 1;
        floor.sector = sec;
        floor.speed = FLOORSPEED;
        for (let i = 0; i < sec.lines.length; i++) {
          if (twoSided(sim, secnum, i)) {
            // C reads textureheight[side->bottomtexture] for both sides
            // (including texture 0 for "-"); we look heights up by name
            // and skip unknown names.
            let side = getSide(sim, secnum, i, 0);
            let h = textureHeights.get(side.bottomtexture);
            if (h !== undefined && h < minsize) minsize = h;
            side = getSide(sim, secnum, i, 1);
            h = textureHeights.get(side.bottomtexture);
            if (h !== undefined && h < minsize) minsize = h;
          }
        }
        floor.floordestheight = (floor.sector.floorheight + minsize) | 0;
        break;
      }

      case FloorType.LowerAndChange:
        floor.direction = -1;
        floor.sector = sec;
        floor.speed = FLOORSPEED;
        floor.floordestheight = P_FindLowestFloorSurrounding(sec);
        floor.texture = sec.floorpic;

        for (let i = 0; i < sec.lines.length; i++) {
          if (twoSided(sim, secnum, i)) {
            if (getSide(sim, secnum, i, 0).sector.index === secnum) {
              sec = getSector(sim, secnum, i, 1);

              if (sec.floorheight === floor.floordestheight) {
                floor.texture = sec.floorpic;
                floor.newspecial = sec.special;
                break;
              }
            } else {
              sec = getSector(sim, secnum, i, 0);

              if (sec.floorheight === floor.floordestheight) {
                floor.texture = sec.floorpic;
                floor.newspecial = sec.special;
                break;
              }
            }
          }
        }
      // fallthrough (vanilla has no break here either)
      default:
        break;
    }
  }
  return rtn;
}

//
// BUILD A STAIRCASE!
//
export function EV_BuildStairs(sim: DoomSim, line: Line, type: StairType): number {
  const w = sim.world;
  let secnum = -1;
  let rtn = 0;

  while ((secnum = P_FindSectorFromLineTag(sim, line, secnum)) >= 0) {
    let sec = w.sectors[secnum]!;

    // ALREADY MOVING?  IF SO, KEEP GOING...
    if (sec.specialdata) continue;

    // new floor thinker
    rtn = 1;
    let floor = new FloorMove(sim);
    sim.thinkers.add(floor);
    sec.specialdata = floor;
    floor.direction = 1;
    floor.sector = sec;

    let stairsize: Fixed = 0;
    let speed: Fixed = 0;
    switch (type) {
      case StairType.Build8:
        speed = (FLOORSPEED / 4) | 0;
        stairsize = 8 * FRACUNIT;
        break;
      case StairType.Turbo16:
        speed = FLOORSPEED * 4;
        stairsize = 16 * FRACUNIT;
        break;
    }
    floor.speed = speed;
    let height = (sec.floorheight + stairsize) | 0;
    floor.floordestheight = height;
    // Initialize
    floor.type = FloorType.LowerFloor;
    // e6y
    // Uninitialized crush field will not be equal to 0 or 1 (true)
    // with high probability. So, initialize it with any other value
    floor.crush = STAIRS_UNINITIALIZED_CRUSH_FIELD_VALUE;

    const texture = sec.floorpic;

    // Find next sector to raise
    // 1.	Find 2-sided line with same sector side[0]
    // 2.	Other side is the next sector to raise
    let ok: boolean;
    do {
      ok = false;
      for (let i = 0; i < sec.lines.length; i++) {
        if (!(sec.lines[i]!.flags & ML_TWOSIDED)) continue;

        let tsec = sec.lines[i]!.frontsector!;
        let newsecnum = tsec.index;

        if (secnum !== newsecnum) continue;

        tsec = sec.lines[i]!.backsector!;
        newsecnum = tsec.index;

        if (tsec.floorpic !== texture) continue;

        height = (height + stairsize) | 0;

        if (tsec.specialdata) continue;

        sec = tsec;
        secnum = newsecnum;
        floor = new FloorMove(sim);

        sim.thinkers.add(floor);

        sec.specialdata = floor;
        floor.direction = 1;
        floor.sector = sec;
        floor.speed = speed;
        floor.floordestheight = height;
        // Initialize
        floor.type = FloorType.LowerFloor;
        // e6y (see above)
        floor.crush = STAIRS_UNINITIALIZED_CRUSH_FIELD_VALUE;
        ok = true;
        break;
      }
    } while (ok);
  }
  return rtn;
}

//
// Special Stuff that can not be categorized  (EV_DoDonut, from p_spec.c)
//
export function EV_DoDonut(sim: DoomSim, line: Line): number {
  const w = sim.world;
  let secnum = -1;
  let rtn = 0;

  while ((secnum = P_FindSectorFromLineTag(sim, line, secnum)) >= 0) {
    const s1 = w.sectors[secnum]!;

    // ALREADY MOVING?  IF SO, KEEP GOING...
    if (s1.specialdata) continue;

    rtn = 1;
    const s2 = getNextSector(s1.lines[0]!, s1);

    // Vanilla Doom does not check if the linedef is one sided; chocolate
    // prints a warning and bails out of the loop.
    if (s2 === null) break;

    for (let i = 0; i < s2.lines.length; i++) {
      const s3 = s2.lines[i]!.backsector;

      if (s3 === s1) continue;

      let s3_floorheight: Fixed;
      let s3_floorpic: string;
      if (s3 === null) {
        // Donut overrun emulation (chocolate reads magic values from
        // low memory; Win98 default is floorheight 0, floorpic 0x16).
        // DEVIATION: flat 0x16 has no name equivalent here, so keep the
        // pool sector's current floorpic.
        s3_floorheight = 0;
        s3_floorpic = s2.floorpic;
      } else {
        s3_floorheight = s3.floorheight;
        s3_floorpic = s3.floorpic;
      }

      //	Spawn rising slime
      let floor = new FloorMove(sim);
      sim.thinkers.add(floor);
      s2.specialdata = floor;
      floor.type = FloorType.DonutRaise;
      floor.crush = false;
      floor.direction = 1;
      floor.sector = s2;
      floor.speed = (FLOORSPEED / 2) | 0;
      floor.texture = s3_floorpic;
      floor.newspecial = 0;
      floor.floordestheight = s3_floorheight;

      //	Spawn lowering donut-hole
      floor = new FloorMove(sim);
      sim.thinkers.add(floor);
      s1.specialdata = floor;
      floor.type = FloorType.LowerFloor;
      floor.crush = false;
      floor.direction = -1;
      floor.sector = s1;
      floor.speed = (FLOORSPEED / 2) | 0;
      floor.floordestheight = s3_floorheight;
      break;
    }
  }
  return rtn;
}
