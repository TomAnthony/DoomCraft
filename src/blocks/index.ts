// installBlocks: wires the voxel layer into the sim at its four choke
// points — movement gap-finding, support sweeps (in gun.ts), hitscan
// (in combat.ts), sight occlusion — plus splash attenuation/destruction.

import { MT } from '../sim/data/info.gen.ts';
import { FRACBITS, type Fixed } from '../sim/fixed.ts';
import { pointInSubsector } from '../sim/maputl.ts';
import type { DoomSim } from '../sim/sim.ts';
import type { Mobj } from '../sim/world.ts';
import { BLOCK_FX, BLOCK_SHIFT, SPLASH_ATTEN_PER_BLOCK } from './grid.ts';
import { installBlockGun } from './gun.ts';

export function installBlocks(sim: DoomSim): void {
  installBlockGun(sim);

  // Violent destruction spawns a small burst of bullet-puff smoke at the
  // cell (deliberate right-click removal stays clean). Puffs use
  // pRandom for jitter, so this is part of the deterministic sim.
  const debris = (bx: number, by: number, bz: number): void => {
    const cx = (bx * BLOCK_FX + BLOCK_FX / 2) | 0;
    const cy = (by * BLOCK_FX + BLOCK_FX / 2) | 0;
    const cz = (bz * BLOCK_FX + BLOCK_FX / 2) | 0;
    const off = 10 << FRACBITS;
    sim.spawnPuff(cx, cy, (cz + off) | 0);
    sim.spawnPuff((cx - off) | 0, (cy - off) | 0, cz);
    sim.spawnPuff((cx + off) | 0, (cy + off) | 0, (cz - (4 << FRACBITS)) | 0);
  };
  sim.blockDestroyed = debris;

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

  // Teleports telefrag blocks: anything in the arrival space is
  // destroyed (like monsters being stomped), so a paved teleporter
  // destination can't entomb the arriving player or monster.
  sim.blockStomp = (thing: Mobj, x: Fixed, y: Fixed, floorz: Fixed) => {
    if (sim.blocks.count === 0) return;
    const bx1 = (x - thing.radius) >> BLOCK_SHIFT;
    const bx2 = ((x + thing.radius - 1) | 0) >> BLOCK_SHIFT;
    const by1 = (y - thing.radius) >> BLOCK_SHIFT;
    const by2 = ((y + thing.radius - 1) | 0) >> BLOCK_SHIFT;
    const top = (floorz + thing.height) | 0;
    const doomed: { bx: number; by: number; bz: number }[] = [];
    for (const cell of sim.blocks.entries()) {
      if (cell.bx < bx1 || cell.bx > bx2 || cell.by < by1 || cell.by > by2) continue;
      const cbottom = cell.bz * BLOCK_FX;
      const ctop = cbottom + BLOCK_FX;
      if (ctop > floorz && cbottom < top) doomed.push(cell);
    }
    for (const c of doomed) {
      sim.blocks.remove(c.bx, c.by, c.bz);
      debris(c.bx, c.by, c.bz);
    }
  };
  if (sim.pmap) sim.pmap.stompBlocks = sim.blockStomp;

  // Sector movement vs blocks: a lowering ceiling (door, crusher) that
  // would cut into a block behaves as if a player stood there — the
  // move is blocked (doors bounce back open). Crushers grind instead:
  // they damage the block (vanilla cadence: 10 every 4th tic) until it
  // is destroyed. Rising floors ignore blocks (interpenetration is by
  // design — otherwise every lift under a block would wedge).
  // door sectors are often thinner than a 32-unit cell, so membership
  // uses a 9-point footprint sample, not just the cell center
  const cellTouchesSector = (bx: number, by: number, sector: unknown): boolean => {
    const x0 = bx * BLOCK_FX;
    const y0 = by * BLOCK_FX;
    const inset = 1 << FRACBITS; // 1 map unit in from the faces
    const xs = [x0 + inset, x0 + BLOCK_FX / 2, x0 + BLOCK_FX - inset];
    const ys = [y0 + inset, y0 + BLOCK_FX / 2, y0 + BLOCK_FX - inset];
    for (const sx of xs) {
      for (const sy of ys) {
        if (pointInSubsector(sim.world, sx | 0, sy | 0).sector === sector) return true;
      }
    }
    return false;
  };

  sim.blockSectorHook = (sector, crunch) => {
    if (sim.blocks.count === 0) return false;
    let blocked = false;
    for (const cell of sim.blocks.entries()) {
      // only cells whose top pokes above the (new) ceiling obstruct it
      const top = (cell.bz + 1) * BLOCK_FX;
      if (top <= sector.ceilingheight) continue;
      if (!cellTouchesSector(cell.bx, cell.by, sector)) continue;
      if (crunch && (sim.leveltime & 3) === 0) {
        if (sim.blocks.damage(cell.bx, cell.by, cell.bz, 10)) {
          debris(cell.bx, cell.by, cell.bz);
        }
      }
      blocked = true;
    }
    return blocked;
  };
  if (sim.pmap) sim.pmap.blockSectorCheck = sim.blockSectorHook;

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
        debris(d.bx, d.by, d.bz);
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
            debris(cell.bx, cell.by, cell.bz);
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
            debris(hit.bx, hit.by, hit.bz);
          }
        }
      }
    }
    origExplode(mo);
  };
}
