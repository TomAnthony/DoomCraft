// Line-of-sight checks, ported from p_sight.c. Uses the REJECT table
// plus a BSP walk (the Doom 1.4+ P_CheckSight; the Doom 1.2
// PTR_SightTraverse path is not ported — DoomCraft is Doom 2 v1.9).
//
// The C module globals (sightzstart, topslope, bottomslope, strace,
// t2x/t2y) live on the Sight instance, which is bound to one DoomSim:
// two sims can coexist without sharing state.

import { NF_SUBSECTOR } from '../angles.ts';
import { ML_TWOSIDED } from '../defs.ts';
import { FRACBITS, FixedDiv, type Fixed } from '../fixed.ts';
import { interceptVector, type Divline } from '../maputl.ts';
import type { DoomSim } from '../sim.ts';
import type { Mobj } from '../world.ts';

// P_InterceptVector2 is code-identical to P_InterceptVector, already
// ported as interceptVector in maputl.ts.
const interceptVector2 = interceptVector;

/**
 * P_DivlineSide: returns side 0 (front), 1 (back), or 2 (on).
 * Works on anything divline-shaped (divline_t or the node_t prefix).
 */
export function divlineSide(
  x: Fixed,
  y: Fixed,
  node: { x: Fixed; y: Fixed; dx: Fixed; dy: Fixed },
): number {
  if (!node.dx) {
    if (x === node.x) return 2;
    if (x <= node.x) return node.dy > 0 ? 1 : 0;
    return node.dy < 0 ? 1 : 0;
  }

  if (!node.dy) {
    // vanilla bug kept: compares x against node->y
    if (x === node.y) return 2;
    if (y <= node.y) return node.dx < 0 ? 1 : 0;
    return node.dx > 0 ? 1 : 0;
  }

  const dx = (x - node.x) | 0;
  const dy = (y - node.y) | 0;

  const left = Math.imul(node.dy >> FRACBITS, dx >> FRACBITS);
  const right = Math.imul(dy >> FRACBITS, node.dx >> FRACBITS);

  if (right < left) return 0; // front side
  if (left === right) return 2;
  return 1; // back side
}

export class Sight {
  /** eye z of looker */
  private sightzstart: Fixed = 0;
  private topslope: Fixed = 0;
  /** slopes to top and bottom of target */
  private bottomslope: Fixed = 0;

  /** from t1 to t2 */
  private readonly strace: Divline = { x: 0, y: 0, dx: 0, dy: 0 };
  private t2x: Fixed = 0;
  private t2y: Fixed = 0;

  // World structures are read through the sim so a reloaded level
  // (loadLevel replaces sim.world) is picked up automatically.
  constructor(private readonly sim: DoomSim) {}

  /**
   * P_CrossSubsector: returns true if strace crosses the given
   * subsector successfully.
   */
  private crossSubsector(num: number): boolean {
    const w = this.sim.world;
    const sub = w.subsectors[num]!;

    // check lines
    const count = sub.numlines;
    for (let i = 0; i < count; i++) {
      const seg = w.segs[sub.firstline + i]!;
      const line = seg.linedef;

      // already checked other side?
      if (line.validcount === w.validcount) continue;
      line.validcount = w.validcount;

      const v1 = line.v1;
      const v2 = line.v2;
      let s1 = divlineSide(v1.x, v1.y, this.strace);
      let s2 = divlineSide(v2.x, v2.y, this.strace);

      // line isn't crossed?
      if (s1 === s2) continue;

      const divl: Divline = {
        x: v1.x,
        y: v1.y,
        dx: (v2.x - v1.x) | 0,
        dy: (v2.y - v1.y) | 0,
      };
      s1 = divlineSide(this.strace.x, this.strace.y, divl);
      s2 = divlineSide(this.t2x, this.t2y, divl);

      // line isn't crossed?
      if (s1 === s2) continue;

      // Backsector may be NULL if this is an "impassible glass" hack line.
      if (line.backsector === null) return false;

      // stop because it is not two sided anyway
      if (!(line.flags & ML_TWOSIDED)) return false;

      // crosses a two sided line
      const front = seg.frontsector;
      const back = seg.backsector!;

      // no wall to block sight with?
      if (
        front.floorheight === back.floorheight &&
        front.ceilingheight === back.ceilingheight
      ) {
        continue;
      }

      // possible occluder because of ceiling height differences
      const opentop =
        front.ceilingheight < back.ceilingheight
          ? front.ceilingheight
          : back.ceilingheight;

      const openbottom =
        front.floorheight > back.floorheight ? front.floorheight : back.floorheight;

      // quick test for totally closed doors
      if (openbottom >= opentop) return false; // stop

      const frac = interceptVector2(this.strace, divl);

      if (front.floorheight !== back.floorheight) {
        const slope = FixedDiv((openbottom - this.sightzstart) | 0, frac);
        if (slope > this.bottomslope) this.bottomslope = slope;
      }

      if (front.ceilingheight !== back.ceilingheight) {
        const slope = FixedDiv((opentop - this.sightzstart) | 0, frac);
        if (slope < this.topslope) this.topslope = slope;
      }

      if (this.topslope <= this.bottomslope) return false; // stop
    }
    // passed the subsector ok
    return true;
  }

  /**
   * P_CrossBSPNode: returns true if strace crosses the given node
   * successfully.
   */
  private crossBSPNode(bspnum: number): boolean {
    if (bspnum & NF_SUBSECTOR) {
      if (bspnum === -1) return this.crossSubsector(0);
      return this.crossSubsector(bspnum & ~NF_SUBSECTOR);
    }

    const bsp = this.sim.world.nodes[bspnum]!;

    // decide which side the start point is on
    let side = divlineSide(this.strace.x, this.strace.y, bsp);
    if (side === 2) side = 0; // an "on" should cross both sides

    // cross the starting side
    if (!this.crossBSPNode(bsp.children[side as 0 | 1]!)) return false;

    // the partition plane is crossed here
    if (side === divlineSide(this.t2x, this.t2y, bsp)) {
      // the line doesn't touch the other side
      return true;
    }

    // cross the ending side
    return this.crossBSPNode(bsp.children[(side ^ 1) as 0 | 1]!);
  }

  /**
   * P_CheckSight: returns true if a straight line between t1 and t2 is
   * unobstructed. Uses REJECT.
   */
  checkSight(t1: Mobj, t2: Mobj): boolean {
    const w = this.sim.world;

    // First check for trivial rejection.
    // Determine subsector entries in REJECT table.
    const s1 = t1.subsector!.sector.index;
    const s2 = t2.subsector!.sector.index;
    const pnum = (s1 * w.sectors.length + s2) | 0;
    const bytenum = pnum >> 3;
    const bitnum = 1 << (pnum & 7);

    // Check in REJECT table.
    if (w.reject[bytenum]! & bitnum) {
      // can't possibly be connected
      return false;
    }

    // An unobstructed LOS is possible.
    // Now look from eyes of t1 to any part of t2.
    w.validcount++;

    this.sightzstart = (t1.z + t1.height - (t1.height >> 2)) | 0;
    this.topslope = (t2.z + t2.height - this.sightzstart) | 0;
    this.bottomslope = (t2.z - this.sightzstart) | 0;

    this.strace.x = t1.x;
    this.strace.y = t1.y;
    this.t2x = t2.x;
    this.t2y = t2.y;
    this.strace.dx = (t2.x - t1.x) | 0;
    this.strace.dy = (t2.y - t1.y) | 0;

    // the head node is the last node output
    return this.crossBSPNode(w.nodes.length - 1);
  }
}
