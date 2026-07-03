// The voxel block grid — part of the deterministic sim state.
// 32-map-unit cubes on a global grid aligned to the map origin.
// All queries are integer fixed-point; iteration order is insertion
// order, which is deterministic because all mutations happen in tic
// order on both peers.

import { FRACBITS, type Fixed } from '../sim/fixed.ts';

export const BLOCK_UNITS = 32; // map units per block edge
export const BLOCK_SHIFT = FRACBITS + 5; // fixed -> cell index (floor div 32)
export const BLOCK_FX = BLOCK_UNITS << FRACBITS;
export const BLOCK_HP = 35; // 3-4 pistol shots (5-15 dmg each)
export const MAX_BLOCKS = 4096;
/** splash damage lost per block of intervening depth */
export const SPLASH_ATTEN_PER_BLOCK = 45;

export interface BlockCell {
  bx: number;
  by: number;
  bz: number;
  hp: number;
}

export interface BlockTraceHit {
  frac: Fixed; // 0..FRACUNIT along the trace
  bx: number;
  by: number;
  bz: number;
  /** cell adjacent to the face that was entered (for placement) */
  px: number;
  py: number;
  pz: number;
}

const key = (bx: number, by: number, bz: number): string => `${bx},${by},${bz}`;

export class BlockGrid {
  private cells = new Map<string, BlockCell>();
  /** bumped on every visual change (renderer syncs on it) */
  version = 0;

  clear(): void {
    this.cells.clear();
    this.version++;
  }

  get count(): number {
    return this.cells.size;
  }

  get(bx: number, by: number, bz: number): BlockCell | undefined {
    return this.cells.get(key(bx, by, bz));
  }

  isSolid(bx: number, by: number, bz: number): boolean {
    return this.cells.has(key(bx, by, bz));
  }

  place(bx: number, by: number, bz: number): boolean {
    if (this.cells.size >= MAX_BLOCKS) return false;
    const k = key(bx, by, bz);
    if (this.cells.has(k)) return false;
    this.cells.set(k, { bx, by, bz, hp: BLOCK_HP });
    this.version++;
    return true;
  }

  remove(bx: number, by: number, bz: number): boolean {
    const removed = this.cells.delete(key(bx, by, bz));
    if (removed) this.version++;
    return removed;
  }

  /** Returns true if the block was destroyed. */
  damage(bx: number, by: number, bz: number, amount: number): boolean {
    const cell = this.cells.get(key(bx, by, bz));
    if (!cell) return false;
    cell.hp -= amount;
    this.version++;
    if (cell.hp <= 0) {
      this.cells.delete(key(bx, by, bz));
      return true;
    }
    return false;
  }

  /** Deterministic iteration (insertion order). */
  *entries(): IterableIterator<BlockCell> {
    yield* this.cells.values();
  }

  // --- geometry queries ----------------------------------------------------

  /**
   * Adjust a mover's effective floor/ceiling for the blocks inside its
   * AABB at (x, y): blocks wholly at or below the feet raise the floor,
   * anything else lowers the ceiling (choke point 1).
   */
  adjustGap(
    x: Fixed, y: Fixed, radius: Fixed, z: Fixed,
    floorz: Fixed, ceilingz: Fixed,
  ): { floorz: Fixed; ceilingz: Fixed } {
    if (this.cells.size === 0) return { floorz, ceilingz };
    const bx1 = (x - radius) >> BLOCK_SHIFT;
    const bx2 = (x + radius - 1) >> BLOCK_SHIFT;
    const by1 = (y - radius) >> BLOCK_SHIFT;
    const by2 = (y + radius - 1) >> BLOCK_SHIFT;

    for (const cell of this.cells.values()) {
      if (cell.bx < bx1 || cell.bx > bx2 || cell.by < by1 || cell.by > by2) continue;
      const bottom = cell.bz * BLOCK_FX;
      const top = bottom + BLOCK_FX;
      // A block whose top is within vanilla step range (24) of the
      // mover's feet is a step, not a wall — same climbing rules as
      // native stairs. (A 32-unit block with top-z <= 24 is always at
      // knee height, so it can never be overhead.) Anything higher
      // lowers the ceiling, which is what keeps 2-stacks unclimbable.
      if (top - z <= 24 * (BLOCK_FX / BLOCK_UNITS)) {
        if (top > floorz) floorz = top;
      } else if (bottom < ceilingz) {
        ceilingz = bottom;
      }
    }
    return { floorz, ceilingz };
  }

  /**
   * 3D DDA along a trace (fixed-point endpoints); returns the first
   * solid cell hit, or null. Used by hitscan, sight, and the block gun.
   */
  trace(x1: Fixed, y1: Fixed, z1: Fixed, x2: Fixed, y2: Fixed, z2: Fixed): BlockTraceHit | null {
    if (this.cells.size === 0) return null;

    // Work in block-cell float coordinates for the DDA stepping only;
    // results (cell indices, frac) are integers derived deterministically
    // from integer inputs, so cross-platform float determinism is not
    // required beyond IEEE-754 basics (add/mul/div are exact per spec).
    const fx1 = x1 / BLOCK_FX;
    const fy1 = y1 / BLOCK_FX;
    const fz1 = z1 / BLOCK_FX;
    const fx2 = x2 / BLOCK_FX;
    const fy2 = y2 / BLOCK_FX;
    const fz2 = z2 / BLOCK_FX;

    let bx = Math.floor(fx1);
    let by = Math.floor(fy1);
    let bz = Math.floor(fz1);
    const ex = Math.floor(fx2);
    const ey = Math.floor(fy2);
    const ez = Math.floor(fz2);

    const dx = fx2 - fx1;
    const dy = fy2 - fy1;
    const dz = fz2 - fz1;
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tMaxX = dx !== 0 ? (stepX > 0 ? bx + 1 - fx1 : fx1 - bx) * tDeltaX : Infinity;
    let tMaxY = dy !== 0 ? (stepY > 0 ? by + 1 - fy1 : fy1 - by) * tDeltaY : Infinity;
    let tMaxZ = dz !== 0 ? (stepZ > 0 ? bz + 1 - fz1 : fz1 - bz) * tDeltaZ : Infinity;

    let px = bx;
    let py = by;
    let pz = bz;
    let t = 0;

    for (let i = 0; i < 128; i++) {
      if (this.isSolid(bx, by, bz)) {
        return {
          frac: Math.max(0, Math.min(65536, Math.round(t * 65536))) | 0,
          bx, by, bz, px, py, pz,
        };
      }
      if (bx === ex && by === ey && bz === ez) break;
      px = bx;
      py = by;
      pz = bz;
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        t = tMaxX;
        tMaxX += tDeltaX;
        bx += stepX;
      } else if (tMaxY <= tMaxZ) {
        t = tMaxY;
        tMaxY += tDeltaY;
        by += stepY;
      } else {
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        bz += stepZ;
      }
      if (t > 1) break;
    }
    return null;
  }

  /** Number of solid cells strictly between two points (splash depth). */
  depthBetween(x1: Fixed, y1: Fixed, z1: Fixed, x2: Fixed, y2: Fixed, z2: Fixed): number {
    if (this.cells.size === 0) return 0;
    let depth = 0;
    let cx = x1;
    let cy = y1;
    let cz = z1;
    // walk repeatedly: trace, count, continue past the hit cell center
    for (let guard = 0; guard < 16; guard++) {
      const hit = this.trace(cx, cy, cz, x2, y2, z2);
      if (!hit) break;
      depth++;
      // continue from just past the hit cell along the ray
      const hx = (hit.bx * BLOCK_FX + BLOCK_FX / 2) | 0;
      const hy = (hit.by * BLOCK_FX + BLOCK_FX / 2) | 0;
      const hz = (hit.bz * BLOCK_FX + BLOCK_FX / 2) | 0;
      // step a full cell beyond the hit center toward the target
      const remx = x2 - hx;
      const remy = y2 - hy;
      const remz = z2 - hz;
      const len = Math.max(Math.abs(remx), Math.abs(remy), Math.abs(remz));
      if (len <= BLOCK_FX) break;
      cx = (hx + Math.round((remx / len) * BLOCK_FX * 1.01)) | 0;
      cy = (hy + Math.round((remy / len) * BLOCK_FX * 1.01)) | 0;
      cz = (hz + Math.round((remz / len) * BLOCK_FX * 1.01)) | 0;
    }
    return depth;
  }
}
