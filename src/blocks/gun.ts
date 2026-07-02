// The block gun (weapon 8): place and remove voxel blocks.
// Left fire = place at the cell adjacent to the hit face; alt-fire =
// remove the targeted block. Both ride the ticcmd (BT_ATTACK /
// BT2_BLOCKREMOVE), so multiplayer sync is free.

import { states, MF, SPR, type StateRow } from '../sim/data/info.gen.ts';
import {
  BT2_BLOCKREMOVE, BT_ATTACK, MAXRADIUS, MAPBLOCKSHIFT, ML_TWOSIDED,
} from '../sim/defs.ts';
import { FRACBITS, FRACUNIT, FixedDiv, FixedMul, type Fixed } from '../sim/fixed.ts';
import { Ammo, Weapon, weaponinfo } from '../sim/items.ts';
import { pitchSlope } from '../sim/combat.ts';
import { PT_ADDLINES, pointInSubsector, type Intercept } from '../sim/maputl.ts';
import { PS_WEAPON, registerPspAction, setPsprite } from '../sim/pspr.ts';
import { ANGLETOFINESHIFT, FINEANGLES, FINEMASK, finecosine, finesine } from '../sim/tables.ts';
import type { DoomSim } from '../sim/sim.ts';
import type { Mobj, Player } from '../sim/world.ts';
import { BLOCK_FX, BLOCK_SHIFT } from './grid.ts';

export const BLOCK_GUN_RANGE = 512 << FRACBITS;

// Custom psprite states appended after the generated table. The fist
// sprite (PUNG) stands in visually until a custom sprite exists.
const BASE = states.length;
export const S_BLOCKGUN_UP = BASE + 0;
export const S_BLOCKGUN_DOWN = BASE + 1;
export const S_BLOCKGUN_READY = BASE + 2;
export const S_BLOCKGUN_PLACE = BASE + 3;
export const S_BLOCKGUN_REMOVE = BASE + 4;

export const BLOCK_STATES: StateRow[] = [
  [SPR.PUNG, 0, 1, 'A_Raise', S_BLOCKGUN_UP, 0, 0],
  [SPR.PUNG, 0, 1, 'A_Lower', S_BLOCKGUN_DOWN, 0, 0],
  [SPR.PUNG, 0, 1, 'A_BlockGunReady', S_BLOCKGUN_READY, 0, 0],
  [SPR.PUNG, 2, 8, 'A_PlaceBlock', S_BLOCKGUN_READY, 0, 0],
  [SPR.PUNG, 3, 8, 'A_RemoveBlock', S_BLOCKGUN_READY, 0, 0],
];

const WEAPONTOP = 32 * FRACUNIT;

interface GunTarget {
  /** first solid surface hit: existing block, wall, or floor */
  hitCell: { bx: number; by: number; bz: number } | null;
  /** empty cell adjacent to the hit face (placement spot) */
  placeCell: { bx: number; by: number; bz: number } | null;
}

/** Nearest wall-hit fraction along the view ray (3D, like shootTraverse). */
function wallHitFrac(sim: DoomSim, mo: Mobj, shootz: Fixed, slope: Fixed, range: Fixed): Fixed {
  const fine = mo.angle >>> ANGLETOFINESHIFT;
  const x2 = (mo.x + (range >> FRACBITS) * finecosine(fine)) | 0;
  const y2 = (mo.y + (range >> FRACBITS) * finesine[fine]!) | 0;
  let hitFrac = FRACUNIT;

  sim.tr.pathTraverse(mo.x, mo.y, x2, y2, PT_ADDLINES, (inx: Intercept): boolean => {
    const li = inx.line!;
    if (!(li.flags & ML_TWOSIDED)) {
      hitFrac = inx.frac;
      return false;
    }
    sim.tr.lineOpening(li);
    const dist = FixedMul(range, inx.frac);
    if (dist > 0) {
      if (FixedDiv((sim.tr.openbottom - shootz) | 0, dist) > slope) {
        hitFrac = inx.frac;
        return false;
      }
      if (FixedDiv((sim.tr.opentop - shootz) | 0, dist) < slope) {
        hitFrac = inx.frac;
        return false;
      }
    }
    return true;
  });
  return hitFrac;
}

/** Compute what the crosshair ray hits within range. */
export function gunTarget(sim: DoomSim, player: Player): GunTarget {
  const mo = player.mo!;
  const shootz = player.viewz;
  const slope = pitchSlope(mo.pitch);
  const fine = mo.angle >>> ANGLETOFINESHIFT;

  // clamp the ray at the first wall
  const wallFrac = wallHitFrac(sim, mo, shootz, slope, BLOCK_GUN_RANGE);
  const reach = FixedMul(BLOCK_GUN_RANGE, wallFrac);

  const x2 = (mo.x + (reach >> FRACBITS) * finecosine(fine)) | 0;
  const y2 = (mo.y + (reach >> FRACBITS) * finesine[fine]!) | 0;
  const z2 = (shootz + FixedMul(slope, reach)) | 0;

  // 1) existing block hit
  const blockHit = sim.blocks.trace(mo.x, mo.y, shootz, x2, y2, z2);
  if (blockHit) {
    return {
      hitCell: { bx: blockHit.bx, by: blockHit.by, bz: blockHit.bz },
      placeCell: { bx: blockHit.px, by: blockHit.py, bz: blockHit.pz },
    };
  }

  // 2) floor hit: sample along the ray; when a sample dips below the
  // sector floor (or above the ceiling), place in the last valid cell.
  const steps = 32;
  let prev: { bx: number; by: number; bz: number } | null = null;
  for (let i = 1; i <= steps; i++) {
    const frac = ((reach / steps) * i) | 0;
    const sx = (mo.x + FixedMul(finecosine(fine), frac)) | 0;
    const sy = (mo.y + FixedMul(finesine[fine]!, frac)) | 0;
    const sz = (shootz + FixedMul(slope, frac)) | 0;
    const sector = pointInSubsector(sim.world, sx, sy).sector;
    if (sz <= sector.floorheight || sz >= sector.ceilingheight) {
      return { hitCell: prev, placeCell: prev };
    }
    prev = { bx: sx >> BLOCK_SHIFT, by: sy >> BLOCK_SHIFT, bz: sz >> BLOCK_SHIFT };
  }

  // 3) wall hit: place in the last in-bounds cell before the wall
  if (wallFrac < FRACUNIT) {
    return { hitCell: prev, placeCell: prev };
  }
  return { hitCell: null, placeCell: null };
}

/** Would a block at this cell intersect any solid mobj? */
function cellBlockedByThing(sim: DoomSim, bx: number, by: number, bz: number): boolean {
  const w = sim.world;
  const x1 = bx * BLOCK_FX;
  const y1 = by * BLOCK_FX;
  const z1 = bz * BLOCK_FX;
  const x2 = x1 + BLOCK_FX;
  const y2 = y1 + BLOCK_FX;
  const z2 = z1 + BLOCK_FX;

  const xl = (x1 - w.bmaporgx - MAXRADIUS) >> MAPBLOCKSHIFT;
  const xh = (x2 - w.bmaporgx + MAXRADIUS) >> MAPBLOCKSHIFT;
  const yl = (y1 - w.bmaporgy - MAXRADIUS) >> MAPBLOCKSHIFT;
  const yh = (y2 - w.bmaporgy + MAXRADIUS) >> MAPBLOCKSHIFT;

  let blocked = false;
  for (let mx = xl; mx <= xh && !blocked; mx++) {
    for (let my = yl; my <= yh && !blocked; my++) {
      sim.tr.blockThingsIterator(mx, my, (t) => {
        if (!(t.flags & MF.SOLID)) return true;
        if (
          t.x + t.radius > x1 && t.x - t.radius < x2 &&
          t.y + t.radius > y1 && t.y - t.radius < y2 &&
          t.z + t.height > z1 && t.z < z2
        ) {
          blocked = true;
          return false;
        }
        return true;
      });
    }
  }
  return blocked;
}

/** Re-clip everything standing in/on the block column (choke point 2). */
function sweepColumn(sim: DoomSim, bx: number, by: number): void {
  const w = sim.world;
  const x1 = bx * BLOCK_FX;
  const y1 = by * BLOCK_FX;
  const xl = (x1 - w.bmaporgx - MAXRADIUS) >> MAPBLOCKSHIFT;
  const xh = (x1 + BLOCK_FX - w.bmaporgx + MAXRADIUS) >> MAPBLOCKSHIFT;
  const yl = (y1 - w.bmaporgy - MAXRADIUS) >> MAPBLOCKSHIFT;
  const yh = (y1 + BLOCK_FX - w.bmaporgy + MAXRADIUS) >> MAPBLOCKSHIFT;
  for (let mx = xl; mx <= xh; mx++) {
    for (let my = yl; my <= yh; my++) {
      sim.tr.blockThingsIterator(mx, my, (t) => {
        if (
          t.x + t.radius > x1 && t.x - t.radius < x1 + BLOCK_FX &&
          t.y + t.radius > y1 && t.y - t.radius < y1 + BLOCK_FX
        ) {
          sim.pmap.thingHeightClip(t);
        }
        return true;
      });
    }
  }
}

export function installBlockGun(sim: DoomSim): void {
  // extend the state table and weapon info
  sim.stateTable = [...states, ...BLOCK_STATES];
  while (weaponinfo.length < 10) {
    weaponinfo.push({ ammo: Ammo.NoAmmo, upstate: 0, downstate: 0, readystate: 0, atkstate: 0, flashstate: 0 });
  }
  weaponinfo[Weapon.BlockGun] = {
    ammo: Ammo.NoAmmo,
    upstate: S_BLOCKGUN_UP,
    downstate: S_BLOCKGUN_DOWN,
    readystate: S_BLOCKGUN_READY,
    atkstate: S_BLOCKGUN_PLACE,
    flashstate: 0,
  };

  registerPspAction('A_BlockGunReady', (s, player, psp) => {
    // switch away / death (mirrors A_WeaponReady)
    if (player.pendingweapon !== Weapon.NoChange || !player.health) {
      setPsprite(s, player, PS_WEAPON, S_BLOCKGUN_DOWN);
      return;
    }
    if (player.cmd.buttons & BT_ATTACK) {
      setPsprite(s, player, PS_WEAPON, S_BLOCKGUN_PLACE);
      return;
    }
    if (player.cmd.buttons2 & BT2_BLOCKREMOVE) {
      setPsprite(s, player, PS_WEAPON, S_BLOCKGUN_REMOVE);
      return;
    }
    // bob like A_WeaponReady
    let angle = (128 * s.leveltime) & FINEMASK;
    psp.sx = (FRACUNIT + FixedMul(player.bob, finecosine(angle))) | 0;
    angle &= FINEANGLES / 2 - 1;
    psp.sy = (WEAPONTOP + FixedMul(player.bob, finesine[angle]!)) | 0;
  });

  registerPspAction('A_PlaceBlock', (s, player) => {
    const target = gunTarget(s, player);
    const cell = target.placeCell;
    if (!cell) return;
    if (s.blocks.isSolid(cell.bx, cell.by, cell.bz)) return;
    if (cellBlockedByThing(s, cell.bx, cell.by, cell.bz)) return;
    if (s.blocks.place(cell.bx, cell.by, cell.bz)) {
      s.startSoundXY(cell.bx * BLOCK_FX, cell.by * BLOCK_FX, 'stnmov');
      sweepColumn(s, cell.bx, cell.by);
    }
  });

  registerPspAction('A_RemoveBlock', (s, player) => {
    const target = gunTarget(s, player);
    const cell = target.hitCell;
    if (!cell) return;
    if (s.blocks.remove(cell.bx, cell.by, cell.bz)) {
      s.startSoundXY(cell.bx * BLOCK_FX, cell.by * BLOCK_FX, 'itmbk');
      sweepColumn(s, cell.bx, cell.by);
    }
  });
}
