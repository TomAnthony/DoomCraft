// Teleportation, ported from p_telept.c.

import { MF, MT } from '../data/info.gen.ts';
import { SFX } from '../data/sounds.gen.ts';
import type { DoomSim } from '../sim.ts';
import { ANGLETOFINESHIFT, finecosine, finesine } from '../tables.ts';
import type { Line, Mobj } from '../world.ts';

//
// TELEPORTATION
//
export function EV_Teleport(sim: DoomSim, line: Line, side: number, thing: Mobj): number {
  const w = sim.world;

  // don't teleport missiles
  if (thing.flags & MF.MISSILE) return 0;

  // Don't teleport if hit back of line,
  //  so you can get out of teleporter.
  if (side === 1) return 0;

  const tag = line.tag;
  for (let i = 0; i < w.sectors.length; i++) {
    if (w.sectors[i]!.tag === tag) {
      // (C walks the thinker list for P_MobjThinker entries)
      for (const m of sim.mobjs()) {
        // not a teleportman
        if (m.type !== MT.TELEPORTMAN) continue;

        const sector = m.subsector!.sector;
        // wrong sector
        if (sector.index !== i) continue;

        const oldx = thing.x;
        const oldy = thing.y;
        const oldz = thing.z;

        if (!sim.pmap.teleportMove(thing, m.x, m.y)) return 0;

        // (gameversion != exe_final: the first Final Doom executable
        // did not set thing->z here)
        thing.z = thing.floorz;

        if (thing.player) {
          thing.player.viewz = (thing.z + thing.player.viewheight) | 0;
        }

        // spawn teleport fog at source and destination
        let fog = sim.spawnMobj(oldx, oldy, oldz, MT.TFOG);
        sim.startSoundNum(fog, SFX.telept);
        const an = m.angle >>> ANGLETOFINESHIFT;
        fog = sim.spawnMobj(
          (m.x + 20 * finecosine(an)) | 0,
          (m.y + 20 * finesine[an]!) | 0,
          thing.z,
          MT.TFOG,
        );

        // emit sound, where?
        sim.startSoundNum(fog, SFX.telept);

        // don't move for a bit
        if (thing.player) thing.reactiontime = 18;

        thing.angle = m.angle;
        thing.momx = thing.momy = thing.momz = 0;
        return 1;
      }
    }
  }
  return 0;
}
