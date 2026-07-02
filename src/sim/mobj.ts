// Mobj momentum/state machinery, ported from p_mobj.c (movement subset;
// spawn/state functions live on DoomSim to avoid import cycles).

import { S } from './data/info.gen.ts';
import { MF } from './data/info.gen.ts';
import { FRICTION, GRAVITY, MAXMOVE, STOPSPEED, VIEWHEIGHT } from './defs.ts';
import { FRACUNIT, FixedMul, type Fixed } from './fixed.ts';
import { aproxDistance } from './maputl.ts';
import type { DoomSim } from './sim.ts';
import type { Mobj } from './world.ts';

const FLOATSPEED = 4 * FRACUNIT;
const SKY_FLAT = 'F_SKY1';

export function xyMovement(sim: DoomSim, mo: Mobj): void {
  if (!mo.momx && !mo.momy) {
    if (mo.flags & MF.SKULLFLY) {
      // the skull slammed into something
      mo.flags &= ~MF.SKULLFLY;
      mo.momx = mo.momy = mo.momz = 0;
      sim.setMobjState(mo, mo.info.spawnstate);
    }
    return;
  }

  const player = mo.player;

  if (mo.momx > MAXMOVE) mo.momx = MAXMOVE;
  else if (mo.momx < -MAXMOVE) mo.momx = -MAXMOVE;
  if (mo.momy > MAXMOVE) mo.momy = MAXMOVE;
  else if (mo.momy < -MAXMOVE) mo.momy = -MAXMOVE;

  let xmove = mo.momx;
  let ymove = mo.momy;

  do {
    let ptryx: Fixed;
    let ptryy: Fixed;
    if (xmove > MAXMOVE / 2 || ymove > MAXMOVE / 2) {
      ptryx = (mo.x + ((xmove / 2) | 0)) | 0;
      ptryy = (mo.y + ((ymove / 2) | 0)) | 0;
      xmove >>= 1;
      ymove >>= 1;
    } else {
      ptryx = (mo.x + xmove) | 0;
      ptryy = (mo.y + ymove) | 0;
      xmove = ymove = 0;
    }

    if (!sim.pmap.tryMove(mo, ptryx, ptryy)) {
      // blocked move
      if (mo.player) {
        sim.pmap.slideMove(mo); // try to slide along it
      } else if (mo.flags & MF.MISSILE) {
        // explode a missile, unless against the sky hack
        const cl = sim.pmap.ceilingline;
        if (cl && cl.backsector && cl.backsector.ceilingpic === SKY_FLAT) {
          sim.removeMobj(mo);
          return;
        }
        sim.explodeMissile(mo);
      } else {
        mo.momx = mo.momy = 0;
      }
    }
  } while (xmove || ymove);

  // slow down
  if (mo.flags & (MF.MISSILE | MF.SKULLFLY)) return; // no friction for missiles
  if (mo.z > mo.floorz) return; // no friction when airborne

  if (mo.flags & MF.CORPSE) {
    // do not stop sliding if halfway off a step with some momentum
    if (
      mo.momx > FRACUNIT / 4 || mo.momx < -FRACUNIT / 4 ||
      mo.momy > FRACUNIT / 4 || mo.momy < -FRACUNIT / 4
    ) {
      if (mo.floorz !== mo.subsector!.sector.floorheight) return;
    }
  }

  if (
    mo.momx > -STOPSPEED && mo.momx < STOPSPEED &&
    mo.momy > -STOPSPEED && mo.momy < STOPSPEED &&
    (!player || (player.cmd.forwardmove === 0 && player.cmd.sidemove === 0))
  ) {
    // if in a walking frame, stop moving
    if (player && ((mo.stateNum - S.PLAY_RUN1) >>> 0) < 4) {
      sim.setMobjState(mo, S.PLAY);
    }
    mo.momx = 0;
    mo.momy = 0;
  } else {
    mo.momx = FixedMul(mo.momx, FRICTION);
    mo.momy = FixedMul(mo.momy, FRICTION);
  }
}

export function zMovement(sim: DoomSim, mo: Mobj): void {
  // check for smooth step up
  if (mo.player && mo.z < mo.floorz) {
    mo.player.viewheight = (mo.player.viewheight - (mo.floorz - mo.z)) | 0;
    mo.player.deltaviewheight = (VIEWHEIGHT - mo.player.viewheight) >> 3;
  }

  // adjust height
  mo.z = (mo.z + mo.momz) | 0;

  if (mo.flags & MF.FLOAT && mo.target) {
    // float down towards target if too close
    if (!(mo.flags & MF.SKULLFLY) && !(mo.flags & MF.INFLOAT)) {
      const dist = aproxDistance((mo.x - mo.target.x) | 0, (mo.y - mo.target.y) | 0);
      const delta = ((mo.target.z + (mo.height >> 1)) - mo.z) | 0;
      if (delta < 0 && dist < -(delta * 3)) mo.z = (mo.z - FLOATSPEED) | 0;
      else if (delta > 0 && dist < delta * 3) mo.z = (mo.z + FLOATSPEED) | 0;
    }
  }

  // clip movement
  if (mo.z <= mo.floorz) {
    // hit the floor. Doom2 v1.9 behavior (no correct_lost_soul_bounce):
    // skull momz reversal happens AFTER zeroing below, so a charging
    // skull hit by a raising floor reverses (vanilla bug kept).
    if (mo.momz < 0) {
      if (mo.player && mo.momz < -GRAVITY * 8) {
        // Squat down after hitting the ground hard.
        mo.player.deltaviewheight = mo.momz >> 3;
        sim.startSound(mo, 'oof');
      }
      mo.momz = 0;
    }
    mo.z = mo.floorz;

    if (mo.flags & MF.SKULLFLY) mo.momz = -mo.momz | 0;

    if (mo.flags & MF.MISSILE && !(mo.flags & MF.NOCLIP)) {
      sim.explodeMissile(mo);
      return;
    }
  } else if (!(mo.flags & MF.NOGRAVITY)) {
    if (mo.momz === 0) mo.momz = -GRAVITY * 2;
    else mo.momz = (mo.momz - GRAVITY) | 0;
  }

  if (mo.z + mo.height > mo.ceilingz) {
    // hit the ceiling
    if (mo.momz > 0) mo.momz = 0;
    mo.z = (mo.ceilingz - mo.height) | 0;

    if (mo.flags & MF.SKULLFLY) mo.momz = -mo.momz | 0;

    if (mo.flags & MF.MISSILE && !(mo.flags & MF.NOCLIP)) {
      sim.explodeMissile(mo);
      return;
    }
  }
}

export function mobjThinker(sim: DoomSim, mobj: Mobj): void {
  // momentum movement
  if (mobj.momx || mobj.momy || mobj.flags & MF.SKULLFLY) {
    xyMovement(sim, mobj);
    if (mobj.removed) return;
  }
  if (mobj.z !== mobj.floorz || mobj.momz) {
    zMovement(sim, mobj);
    if (mobj.removed) return;
  }

  // cycle through states, calling action functions at transitions
  if (mobj.tics !== -1) {
    mobj.tics--;
    if (!mobj.tics) {
      if (!sim.setMobjState(mobj, sim.stateTable[mobj.stateNum]![4])) {
        return; // freed itself
      }
    }
  }
  // (nightmare respawn omitted: monsters never respawn in DoomCraft)
}
