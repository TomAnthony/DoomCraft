// Door animation code (opening/closing), ported from p_doors.c.

import { SFX } from '../data/sounds.gen.ts';
import { TICRATE } from '../defs.ts';
import { FRACUNIT, type Fixed } from '../fixed.ts';
import type { DoomSim } from '../sim.ts';
import type { Thinker } from '../thinker.ts';
import type { Line, Mobj, Sector } from '../world.ts';
import { P_FindLowestCeilingSurrounding, P_FindSectorFromLineTag } from './spec.ts';
import { Result, T_MovePlane } from './floors.ts';
import { Plat } from './plats.ts';

export const enum DoorType {
  Normal,
  Close30ThenOpen,
  Close,
  Open,
  RaiseIn5Mins,
  BlazeRaise,
  BlazeOpen,
  BlazeClose,
}

export const VDOORSPEED = FRACUNIT * 2;
export const VDOORWAIT = 150;

// card_t indices into player.cards[]
const it_bluecard = 0;
const it_yellowcard = 1;
const it_redcard = 2;
const it_blueskull = 3;
const it_yellowskull = 4;
const it_redskull = 5;

// d_englsh.h key messages
const PD_BLUEO = 'You need a blue key to activate this object';
const PD_REDO = 'You need a red key to activate this object';
const PD_YELLOWO = 'You need a yellow key to activate this object';
const PD_BLUEK = 'You need a blue key to open this door';
const PD_REDK = 'You need a red key to open this door';
const PD_YELLOWK = 'You need a yellow key to open this door';

export class VDoor implements Thinker {
  tprev: Thinker | null = null;
  tnext: Thinker | null = null;
  removed = false;

  type: DoorType = DoorType.Normal;
  sector!: Sector;
  topheight: Fixed = 0;
  speed: Fixed = 0;

  /** 1 = up, 0 = waiting at top, -1 = down (2 = initial wait) */
  direction = 0;

  /** tics to wait at the top */
  topwait = 0;
  /** (keep in case a door going down is reset); when it reaches 0, start going down */
  topcountdown = 0;

  constructor(private readonly sim: DoomSim) {}

  think(): void {
    T_VerticalDoor(this.sim, this);
  }
}

//
// T_VerticalDoor
//
export function T_VerticalDoor(sim: DoomSim, door: VDoor): void {
  let res: Result;

  switch (door.direction) {
    case 0:
      // WAITING
      if (!--door.topcountdown) {
        switch (door.type) {
          case DoorType.BlazeRaise:
            door.direction = -1; // time to go back down
            sim.startSectorSound(door.sector, SFX.bdcls);
            break;

          case DoorType.Normal:
            door.direction = -1; // time to go back down
            sim.startSectorSound(door.sector, SFX.dorcls);
            break;

          case DoorType.Close30ThenOpen:
            door.direction = 1;
            sim.startSectorSound(door.sector, SFX.doropn);
            break;

          default:
            break;
        }
      }
      break;

    case 2:
      //  INITIAL WAIT
      if (!--door.topcountdown) {
        switch (door.type) {
          case DoorType.RaiseIn5Mins:
            door.direction = 1;
            door.type = DoorType.Normal;
            sim.startSectorSound(door.sector, SFX.doropn);
            break;

          default:
            break;
        }
      }
      break;

    case -1:
      // DOWN
      res = T_MovePlane(
        sim, door.sector, door.speed, door.sector.floorheight,
        false, 1, door.direction,
      );
      if (res === Result.PastDest) {
        switch (door.type) {
          case DoorType.BlazeRaise:
          case DoorType.BlazeClose:
            door.sector.specialdata = null;
            door.removed = true; // unlink and free
            sim.startSectorSound(door.sector, SFX.bdcls);
            break;

          case DoorType.Normal:
          case DoorType.Close:
            door.sector.specialdata = null;
            door.removed = true; // unlink and free
            break;

          case DoorType.Close30ThenOpen:
            door.direction = 0;
            door.topcountdown = TICRATE * 30;
            break;

          default:
            break;
        }
      } else if (res === Result.Crushed) {
        switch (door.type) {
          case DoorType.BlazeClose:
          case DoorType.Close: // DO NOT GO BACK UP!
            break;

          default:
            door.direction = 1;
            sim.startSectorSound(door.sector, SFX.doropn);
            break;
        }
      }
      break;

    case 1:
      // UP
      res = T_MovePlane(
        sim, door.sector, door.speed, door.topheight,
        false, 1, door.direction,
      );

      if (res === Result.PastDest) {
        switch (door.type) {
          case DoorType.BlazeRaise:
          case DoorType.Normal:
            door.direction = 0; // wait at top
            door.topcountdown = door.topwait;
            break;

          case DoorType.Close30ThenOpen:
          case DoorType.BlazeOpen:
          case DoorType.Open:
            door.sector.specialdata = null;
            door.removed = true; // unlink and free
            break;

          default:
            break;
        }
      }
      break;
  }
}

//
// EV_DoLockedDoor
// Move a locked door up/down
//
export function EV_DoLockedDoor(sim: DoomSim, line: Line, type: DoorType, thing: Mobj): number {
  const p = thing.player;

  if (!p) return 0;

  switch (line.special) {
    case 99: // Blue Lock
    case 133:
      if (!p.cards[it_bluecard] && !p.cards[it_blueskull]) {
        p.message = PD_BLUEO;
        sim.startSoundNum(null, SFX.oof);
        return 0;
      }
      break;

    case 134: // Red Lock
    case 135:
      if (!p.cards[it_redcard] && !p.cards[it_redskull]) {
        p.message = PD_REDO;
        sim.startSoundNum(null, SFX.oof);
        return 0;
      }
      break;

    case 136: // Yellow Lock
    case 137:
      if (!p.cards[it_yellowcard] && !p.cards[it_yellowskull]) {
        p.message = PD_YELLOWO;
        sim.startSoundNum(null, SFX.oof);
        return 0;
      }
      break;
  }

  return EV_DoDoor(sim, line, type);
}

export function EV_DoDoor(sim: DoomSim, line: Line, type: DoorType): number {
  const w = sim.world;
  let secnum = -1;
  let rtn = 0;

  while ((secnum = P_FindSectorFromLineTag(sim, line, secnum)) >= 0) {
    const sec = w.sectors[secnum]!;
    if (sec.specialdata) continue;

    // new door thinker
    rtn = 1;
    const door = new VDoor(sim);
    sim.thinkers.add(door);
    sec.specialdata = door;

    door.sector = sec;
    door.type = type;
    door.topwait = VDOORWAIT;
    door.speed = VDOORSPEED;

    switch (type) {
      case DoorType.BlazeClose:
        door.topheight = P_FindLowestCeilingSurrounding(sec);
        door.topheight = (door.topheight - 4 * FRACUNIT) | 0;
        door.direction = -1;
        door.speed = VDOORSPEED * 4;
        sim.startSectorSound(door.sector, SFX.bdcls);
        break;

      case DoorType.Close:
        door.topheight = P_FindLowestCeilingSurrounding(sec);
        door.topheight = (door.topheight - 4 * FRACUNIT) | 0;
        door.direction = -1;
        sim.startSectorSound(door.sector, SFX.dorcls);
        break;

      case DoorType.Close30ThenOpen:
        door.topheight = sec.ceilingheight;
        door.direction = -1;
        sim.startSectorSound(door.sector, SFX.dorcls);
        break;

      case DoorType.BlazeRaise:
      case DoorType.BlazeOpen:
        door.direction = 1;
        door.topheight = P_FindLowestCeilingSurrounding(sec);
        door.topheight = (door.topheight - 4 * FRACUNIT) | 0;
        door.speed = VDOORSPEED * 4;
        if (door.topheight !== sec.ceilingheight) {
          sim.startSectorSound(door.sector, SFX.bdopn);
        }
        break;

      case DoorType.Normal:
      case DoorType.Open:
        door.direction = 1;
        door.topheight = P_FindLowestCeilingSurrounding(sec);
        door.topheight = (door.topheight - 4 * FRACUNIT) | 0;
        if (door.topheight !== sec.ceilingheight) {
          sim.startSectorSound(door.sector, SFX.doropn);
        }
        break;

      default:
        break;
    }
  }
  return rtn;
}

//
// EV_VerticalDoor : open a door manually, no tag value
//
export function EV_VerticalDoor(sim: DoomSim, line: Line, thing: Mobj): void {
  const w = sim.world;
  const side = 0; // only front sides can be used

  //	Check for locks
  const player = thing.player;

  switch (line.special) {
    case 26: // Blue Lock
    case 32:
      if (!player) return;

      if (!player.cards[it_bluecard] && !player.cards[it_blueskull]) {
        player.message = PD_BLUEK;
        sim.startSoundNum(null, SFX.oof);
        return;
      }
      break;

    case 27: // Yellow Lock
    case 34:
      if (!player) return;

      if (!player.cards[it_yellowcard] && !player.cards[it_yellowskull]) {
        player.message = PD_YELLOWK;
        sim.startSoundNum(null, SFX.oof);
        return;
      }
      break;

    case 28: // Red Lock
    case 33:
      if (!player) return;

      if (!player.cards[it_redcard] && !player.cards[it_redskull]) {
        player.message = PD_REDK;
        sim.startSoundNum(null, SFX.oof);
        return;
      }
      break;
  }

  // if the sector has an active thinker, use it

  if (line.sidenum[side ^ 1] === -1) {
    throw new Error('EV_VerticalDoor: DR special type on 1-sided linedef');
  }

  const sec = w.sides[line.sidenum[side ^ 1]!]!.sector;

  if (sec.specialdata) {
    const sd = sec.specialdata;
    switch (line.special) {
      case 1: // ONLY FOR "RAISE" DOORS, NOT "OPEN"s
      case 26:
      case 27:
      case 28:
      case 117: {
        // When is a door not a door?
        // In Vanilla, door->direction is read/set even though
        // "specialdata" might not actually point at a door. On 32-bit,
        // vldoor_t.direction aliases plat_t.wait — emulated here.
        const direction = sd instanceof Plat ? sd.wait : (sd as VDoor).direction;
        if (direction === -1) {
          // go back up
          if (sd instanceof Plat) sd.wait = 1;
          else (sd as VDoor).direction = 1;
        } else {
          if (!thing.player) return; // JDC: bad guys never close doors

          if (sd instanceof VDoor) {
            sd.direction = -1; // start going down immediately
          } else if (sd instanceof Plat) {
            // Erm, this is a plat, not a door: set wait to -1 instead
            // (matches vanilla's 32-bit field aliasing; chocolate-doom
            // does the same via its thinker-function check).
            sd.wait = -1;
          } else {
            // This isn't a door OR a plat.  Now we're in trouble.
            // Try closing it anyway (vanilla writes the field blindly).
            (sd as VDoor).direction = -1;
          }
        }
        return;
      }
    }
  }

  // for proper sound
  switch (line.special) {
    case 117: // BLAZING DOOR RAISE
    case 118: // BLAZING DOOR OPEN
      sim.startSectorSound(sec, SFX.bdopn);
      break;

    case 1: // NORMAL DOOR SOUND
    case 31:
      sim.startSectorSound(sec, SFX.doropn);
      break;

    default: // LOCKED DOOR SOUND
      sim.startSectorSound(sec, SFX.doropn);
      break;
  }

  // new door thinker
  const door = new VDoor(sim);
  sim.thinkers.add(door);
  sec.specialdata = door;
  door.sector = sec;
  door.direction = 1;
  door.speed = VDOORSPEED;
  door.topwait = VDOORWAIT;

  switch (line.special) {
    case 1:
    case 26:
    case 27:
    case 28:
      door.type = DoorType.Normal;
      break;

    case 31:
    case 32:
    case 33:
    case 34:
      door.type = DoorType.Open;
      line.special = 0;
      break;

    case 117: // blazing door raise
      door.type = DoorType.BlazeRaise;
      door.speed = VDOORSPEED * 4;
      break;
    case 118: // blazing door open
      door.type = DoorType.BlazeOpen;
      line.special = 0;
      door.speed = VDOORSPEED * 4;
      break;
  }

  // find the top and bottom of the movement range
  door.topheight = P_FindLowestCeilingSurrounding(sec);
  door.topheight = (door.topheight - 4 * FRACUNIT) | 0;
}

//
// Spawn a door that closes after 30 seconds
//
export function P_SpawnDoorCloseIn30(sim: DoomSim, sec: Sector): void {
  const door = new VDoor(sim);
  sim.thinkers.add(door);

  sec.specialdata = door;
  sec.special = 0;

  door.sector = sec;
  door.direction = 0;
  door.type = DoorType.Normal;
  door.speed = VDOORSPEED;
  door.topcountdown = 30 * TICRATE;
}

//
// Spawn a door that opens after 5 minutes
//
export function P_SpawnDoorRaiseIn5Mins(sim: DoomSim, sec: Sector, _secnum: number): void {
  const door = new VDoor(sim);
  sim.thinkers.add(door);

  sec.specialdata = door;
  sec.special = 0;

  door.sector = sec;
  door.direction = 2;
  door.type = DoorType.RaiseIn5Mins;
  door.speed = VDOORSPEED;
  door.topheight = P_FindLowestCeilingSurrounding(sec);
  door.topheight = (door.topheight - 4 * FRACUNIT) | 0;
  door.topwait = VDOORWAIT;
  door.topcountdown = 5 * 60 * TICRATE;
}
