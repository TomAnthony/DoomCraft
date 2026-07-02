// installBlocks: wires the voxel layer into the sim at its four choke
// points — movement gap-finding, support sweeps (in gun.ts), hitscan
// (in combat.ts), sight occlusion — plus splash attenuation/destruction.

import { MT } from '../sim/data/info.gen.ts';
import { FRACBITS, type Fixed } from '../sim/fixed.ts';
import type { DoomSim } from '../sim/sim.ts';
import type { Mobj } from '../sim/world.ts';
import { BLOCK_FX, SPLASH_ATTEN_PER_BLOCK } from './grid.ts';
import { installBlockGun } from './gun.ts';

export function installBlocks(sim: DoomSim): void {
  installBlockGun(sim);

  // Choke point 1: movement gap-finding in P_CheckPosition (loadLevel
  // re-wires this onto each level's fresh PMap).
  sim.blockAdjust = (thing: Mobj, x: Fixed, y: Fixed) => {
    if (sim.blocks.count === 0) return;
    const adjusted = sim.blocks.adjustGap(
      x, y, thing.radius, thing.z,
      sim.pmap.tmfloorz, sim.pmap.tmceilingz,
    );
    sim.pmap.tmfloorz = adjusted.floorz;
    sim.pmap.tmceilingz = adjusted.ceilingz;
  };
  if (sim.pmap) sim.pmap.adjustHeights = sim.blockAdjust;

  // Choke point 4: blocks occlude monster sight (but NOT radius attacks,
  // which use checkSightBase and per-depth attenuation instead).
  const baseSight = sim.checkSight;
  sim.checkSightBase = baseSight;
  sim.checkSight = (t1, t2) => {
    if (!baseSight(t1, t2)) return false;
    if (sim.blocks.count === 0) return true;
    const eye = (t1.z + t1.height - (t1.height >> 2)) | 0; // sightzstart
    const mid = (t2.z + (t2.height >> 1)) | 0;
    return sim.blocks.trace(t1.x, t1.y, eye, t2.x, t2.y, mid) === null;
  };

  // Splash attenuation through block walls (used by radiusPit).
  sim.splashAtten = (spot, thing) => {
    if (sim.blocks.count === 0) return 0;
    const depth = sim.blocks.depthBetween(
      spot.x, spot.y, (spot.z + (spot.height >> 1)) | 0,
      thing.x, thing.y, (thing.z + (thing.height >> 1)) | 0,
    );
    return depth * SPLASH_ATTEN_PER_BLOCK;
  };

  // Explosions damage blocks too (attenuated by depth like things).
  const origRadius = sim.radiusAttack;
  sim.radiusAttack = (spot, source, damage) => {
    origRadius(spot, source, damage);
    if (sim.blocks.count === 0) return;
    // collect first (damaging mutates the grid we're iterating)
    const hits: { bx: number; by: number; bz: number; eff: number }[] = [];
    for (const cell of sim.blocks.entries()) {
      const cx = (cell.bx * BLOCK_FX + BLOCK_FX / 2) | 0;
      const cy = (cell.by * BLOCK_FX + BLOCK_FX / 2) | 0;
      const cz = (cell.bz * BLOCK_FX + BLOCK_FX / 2) | 0;
      const dx = Math.abs(cx - spot.x);
      const dy = Math.abs(cy - spot.y);
      const dist = (dx > dy ? dx : dy) >> FRACBITS;
      if (dist >= damage) continue;
      const depth = sim.blocks.depthBetween(
        spot.x, spot.y, (spot.z + (spot.height >> 1)) | 0, cx, cy, cz,
      );
      // the target cell itself is counted by the trace; interior depth
      // is depth-1
      const atten = Math.max(0, depth - 1) * SPLASH_ATTEN_PER_BLOCK;
      const eff = damage - dist - atten;
      if (eff > 0) hits.push({ bx: cell.bx, by: cell.by, bz: cell.bz, eff });
    }
    for (const d of hits) {
      if (sim.blocks.damage(d.bx, d.by, d.bz, d.eff)) {
        sim.startSoundXY(d.bx * BLOCK_FX, d.by * BLOCK_FX, 'barexp');
      }
    }
  };

  // Missile impact: the block that stopped a missile takes its damage;
  // a BFG ball's detonation clears every block in a 4-cell radius.
  const origExplode = sim.explodeMissile.bind(sim);
  sim.explodeMissile = (mo: Mobj) => {
    if (sim.blocks.count > 0) {
      if (mo.type === MT.BFG) {
        const radius = 4 * BLOCK_FX;
        for (const cell of [...sim.blocks.entries()]) {
          const cx = (cell.bx * BLOCK_FX + BLOCK_FX / 2) | 0;
          const cy = (cell.by * BLOCK_FX + BLOCK_FX / 2) | 0;
          const cz = (cell.bz * BLOCK_FX + BLOCK_FX / 2) | 0;
          if (
            Math.abs(cx - mo.x) <= radius &&
            Math.abs(cy - mo.y) <= radius &&
            Math.abs(cz - mo.z) <= radius
          ) {
            sim.blocks.remove(cell.bx, cell.by, cell.bz);
          }
        }
        sim.startSoundXY(mo.x, mo.y, 'barexp');
      } else {
        // damage the block directly ahead of the impact point (probe two
        // momentum-steps forward)
        const cz = (mo.z + (mo.height >> 1)) | 0;
        const hit = sim.blocks.trace(
          mo.x, mo.y, cz,
          (mo.x + mo.momx * 2) | 0,
          (mo.y + mo.momy * 2) | 0,
          (cz + mo.momz * 2) | 0,
        );
        if (hit) {
          if (sim.blocks.damage(hit.bx, hit.by, hit.bz, mo.info.damage * 4)) {
            sim.startSoundXY(mo.x, mo.y, 'barexp');
          }
        }
      }
    }
    origExplode(mo);
  };
}
