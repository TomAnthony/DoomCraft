// Movement/collision utilities, ported from p_maputl.c (+ the fixed-point
// R_PointInSubsector from r_main.c). The C globals live on the Traverser.

import { NF_SUBSECTOR, pointOnSide } from './angles.ts';
import {
  BOXBOTTOM, BOXLEFT, BOXRIGHT, BOXTOP,
  MAPBLOCKSHIFT, MAPBLOCKSIZE, MAPBTOFRAC, SlopeType,
} from './defs.ts';
import { FRACBITS, FRACUNIT, FixedDiv, FixedMul, MAXINT, type Fixed } from './fixed.ts';
import { MF } from './data/info.gen.ts';
import type { World } from './setup.ts';
import type { Line, Mobj, Subsector } from './world.ts';

export interface Divline {
  x: Fixed;
  y: Fixed;
  dx: Fixed;
  dy: Fixed;
}

export interface Intercept {
  frac: Fixed;
  line: Line | null;
  thing: Mobj | null;
}

export const PT_ADDLINES = 1;
export const PT_ADDTHINGS = 2;
export const PT_EARLYOUT = 4;

export function aproxDistance(dx: Fixed, dy: Fixed): Fixed {
  dx = Math.abs(dx) | 0;
  dy = Math.abs(dy) | 0;
  if (dx < dy) return (dx + dy - (dx >> 1)) | 0;
  return (dx + dy - (dy >> 1)) | 0;
}

export function pointOnLineSide(x: Fixed, y: Fixed, line: Line): number {
  if (!line.dx) {
    if (x <= line.v1.x) return line.dy > 0 ? 1 : 0;
    return line.dy < 0 ? 1 : 0;
  }
  if (!line.dy) {
    if (y <= line.v1.y) return line.dx < 0 ? 1 : 0;
    return line.dx > 0 ? 1 : 0;
  }
  const dx = (x - line.v1.x) | 0;
  const dy = (y - line.v1.y) | 0;
  const left = FixedMul(line.dy >> FRACBITS, dx);
  const right = FixedMul(dy, line.dx >> FRACBITS);
  return right < left ? 0 : 1;
}

/** Side 0/1, or -1 if the box crosses the (infinite) line. */
export function boxOnLineSide(tmbox: Fixed[], ld: Line): number {
  let p1 = 0;
  let p2 = 0;
  switch (ld.slopetype) {
    case SlopeType.Horizontal:
      p1 = tmbox[BOXTOP]! > ld.v1.y ? 1 : 0;
      p2 = tmbox[BOXBOTTOM]! > ld.v1.y ? 1 : 0;
      if (ld.dx < 0) {
        p1 ^= 1;
        p2 ^= 1;
      }
      break;
    case SlopeType.Vertical:
      p1 = tmbox[BOXRIGHT]! < ld.v1.x ? 1 : 0;
      p2 = tmbox[BOXLEFT]! < ld.v1.x ? 1 : 0;
      if (ld.dy < 0) {
        p1 ^= 1;
        p2 ^= 1;
      }
      break;
    case SlopeType.Positive:
      p1 = pointOnLineSide(tmbox[BOXLEFT]!, tmbox[BOXTOP]!, ld);
      p2 = pointOnLineSide(tmbox[BOXRIGHT]!, tmbox[BOXBOTTOM]!, ld);
      break;
    case SlopeType.Negative:
      p1 = pointOnLineSide(tmbox[BOXRIGHT]!, tmbox[BOXTOP]!, ld);
      p2 = pointOnLineSide(tmbox[BOXLEFT]!, tmbox[BOXBOTTOM]!, ld);
      break;
  }
  if (p1 === p2) return p1;
  return -1;
}

export function pointOnDivlineSide(x: Fixed, y: Fixed, line: Divline): number {
  if (!line.dx) {
    if (x <= line.x) return line.dy > 0 ? 1 : 0;
    return line.dy < 0 ? 1 : 0;
  }
  if (!line.dy) {
    if (y <= line.y) return line.dx < 0 ? 1 : 0;
    return line.dx > 0 ? 1 : 0;
  }
  const dx = (x - line.x) | 0;
  const dy = (y - line.y) | 0;
  // try to quickly decide by looking at sign bits
  if ((line.dy ^ line.dx ^ dx ^ dy) & 0x80000000) {
    if ((line.dy ^ dx) & 0x80000000) return 1;
    return 0;
  }
  const left = FixedMul(line.dy >> 8, dx >> 8);
  const right = FixedMul(dy >> 8, line.dx >> 8);
  return right < left ? 0 : 1;
}

export function makeDivline(li: Line, dl: Divline): void {
  dl.x = li.v1.x;
  dl.y = li.v1.y;
  dl.dx = li.dx;
  dl.dy = li.dy;
}

/** Fractional intercept point along the first divline. */
export function interceptVector(v2: Divline, v1: Divline): Fixed {
  const den = (FixedMul(v1.dy >> 8, v2.dx) - FixedMul(v1.dx >> 8, v2.dy)) | 0;
  if (den === 0) return 0;
  const num =
    (FixedMul((v1.x - v2.x) >> 8, v1.dy) + FixedMul((v2.y - v1.y) >> 8, v1.dx)) | 0;
  return FixedDiv(num, den);
}

/** Fixed-point R_PointInSubsector (r_main.c). */
export function pointInSubsector(w: World, x: Fixed, y: Fixed): Subsector {
  if (w.nodes.length === 0) return w.subsectors[0]!;
  let nodenum = w.nodes.length - 1;
  while (!(nodenum & NF_SUBSECTOR)) {
    const node = w.nodes[nodenum]!;
    const side = pointOnSide(x, y, node);
    nodenum = node.children[side as 0 | 1]!;
  }
  return w.subsectors[nodenum & ~NF_SUBSECTOR]!;
}

// --- thing position linking --------------------------------------------

export function unsetThingPosition(w: World, thing: Mobj): void {
  if (!(thing.flags & MF.NOSECTOR)) {
    if (thing.snext) thing.snext.sprev = thing.sprev;
    if (thing.sprev) thing.sprev.snext = thing.snext;
    else thing.subsector!.sector.thinglist = thing.snext;
  }
  if (!(thing.flags & MF.NOBLOCKMAP)) {
    if (thing.bnext) thing.bnext.bprev = thing.bprev;
    if (thing.bprev) thing.bprev.bnext = thing.bnext;
    else {
      const blockx = (thing.x - w.bmaporgx) >> MAPBLOCKSHIFT;
      const blocky = (thing.y - w.bmaporgy) >> MAPBLOCKSHIFT;
      if (blockx >= 0 && blockx < w.bmapwidth && blocky >= 0 && blocky < w.bmapheight) {
        w.blocklinks[blocky * w.bmapwidth + blockx] = thing.bnext;
      }
    }
  }
}

export function setThingPosition(w: World, thing: Mobj): void {
  const ss = pointInSubsector(w, thing.x, thing.y);
  thing.subsector = ss;

  if (!(thing.flags & MF.NOSECTOR)) {
    const sec = ss.sector;
    thing.sprev = null;
    thing.snext = sec.thinglist;
    if (sec.thinglist) sec.thinglist.sprev = thing;
    sec.thinglist = thing;
  }

  if (!(thing.flags & MF.NOBLOCKMAP)) {
    const blockx = (thing.x - w.bmaporgx) >> MAPBLOCKSHIFT;
    const blocky = (thing.y - w.bmaporgy) >> MAPBLOCKSHIFT;
    if (blockx >= 0 && blockx < w.bmapwidth && blocky >= 0 && blocky < w.bmapheight) {
      const idx = blocky * w.bmapwidth + blockx;
      thing.bprev = null;
      thing.bnext = w.blocklinks[idx]!;
      if (w.blocklinks[idx]) w.blocklinks[idx]!.bprev = thing;
      w.blocklinks[idx] = thing;
    } else {
      thing.bnext = thing.bprev = null;
    }
  }
}

// --- traversal state (C globals) -----------------------------------------

export class Traverser {
  // P_LineOpening results
  opentop: Fixed = 0;
  openbottom: Fixed = 0;
  openrange: Fixed = 0;
  lowfloor: Fixed = 0;

  trace: Divline = { x: 0, y: 0, dx: 0, dy: 0 };
  private earlyout = false;
  private intercepts: Intercept[] = [];

  constructor(private readonly w: World) {}

  lineOpening(linedef: Line): void {
    if (linedef.sidenum[1] === -1) {
      this.openrange = 0; // single sided line
      return;
    }
    const front = linedef.frontsector!;
    const back = linedef.backsector!;
    this.opentop =
      front.ceilingheight < back.ceilingheight ? front.ceilingheight : back.ceilingheight;
    if (front.floorheight > back.floorheight) {
      this.openbottom = front.floorheight;
      this.lowfloor = back.floorheight;
    } else {
      this.openbottom = back.floorheight;
      this.lowfloor = front.floorheight;
    }
    this.openrange = (this.opentop - this.openbottom) | 0;
  }

  blockLinesIterator(x: number, y: number, func: (ld: Line) => boolean): boolean {
    const w = this.w;
    if (x < 0 || y < 0 || x >= w.bmapwidth || y >= w.bmapheight) return true;
    // blockmap offset table starts 4 shorts into the lump.
    let listIdx = w.blockmaplump[4 + y * w.bmapwidth + x]!;
    for (; w.blockmaplump[listIdx] !== -1; listIdx++) {
      const ld = w.lines[w.blockmaplump[listIdx]!]!;
      if (ld.validcount === w.validcount) continue;
      ld.validcount = w.validcount;
      if (!func(ld)) return false;
    }
    return true;
  }

  blockThingsIterator(x: number, y: number, func: (t: Mobj) => boolean): boolean {
    const w = this.w;
    if (x < 0 || y < 0 || x >= w.bmapwidth || y >= w.bmapheight) return true;
    for (let mobj = w.blocklinks[y * w.bmapwidth + x]; mobj; mobj = mobj.bnext) {
      if (!func(mobj)) return false;
    }
    return true;
  }

  private addLineIntercepts(ld: Line): boolean {
    let s1: number;
    let s2: number;
    const trace = this.trace;
    // avoid precision problems with two routines
    if (
      trace.dx > FRACUNIT * 16 || trace.dy > FRACUNIT * 16 ||
      trace.dx < -FRACUNIT * 16 || trace.dy < -FRACUNIT * 16
    ) {
      s1 = pointOnDivlineSide(ld.v1.x, ld.v1.y, trace);
      s2 = pointOnDivlineSide(ld.v2.x, ld.v2.y, trace);
    } else {
      s1 = pointOnLineSide(trace.x, trace.y, ld);
      s2 = pointOnLineSide((trace.x + trace.dx) | 0, (trace.y + trace.dy) | 0, ld);
    }
    if (s1 === s2) return true; // line isn't crossed

    const dl: Divline = { x: 0, y: 0, dx: 0, dy: 0 };
    makeDivline(ld, dl);
    const frac = interceptVector(trace, dl);
    if (frac < 0) return true; // behind source

    if (this.earlyout && frac < FRACUNIT && !ld.backsector) {
      return false; // stop checking
    }
    this.intercepts.push({ frac, line: ld, thing: null });
    return true;
  }

  private addThingIntercepts(thing: Mobj): boolean {
    const trace = this.trace;
    const tracepositive = (trace.dx ^ trace.dy) > 0;
    let x1: Fixed, y1: Fixed, x2: Fixed, y2: Fixed;
    // check a corner to corner crossection for hit
    if (tracepositive) {
      x1 = (thing.x - thing.radius) | 0;
      y1 = (thing.y + thing.radius) | 0;
      x2 = (thing.x + thing.radius) | 0;
      y2 = (thing.y - thing.radius) | 0;
    } else {
      x1 = (thing.x - thing.radius) | 0;
      y1 = (thing.y - thing.radius) | 0;
      x2 = (thing.x + thing.radius) | 0;
      y2 = (thing.y + thing.radius) | 0;
    }
    const s1 = pointOnDivlineSide(x1, y1, trace);
    const s2 = pointOnDivlineSide(x2, y2, trace);
    if (s1 === s2) return true;

    const dl: Divline = { x: x1, y: y1, dx: (x2 - x1) | 0, dy: (y2 - y1) | 0 };
    const frac = interceptVector(trace, dl);
    if (frac < 0) return true;
    this.intercepts.push({ frac, line: null, thing });
    return true;
  }

  private traverseIntercepts(func: (inx: Intercept) => boolean, maxfrac: Fixed): boolean {
    let count = this.intercepts.length;
    let inx: Intercept | null = null;
    while (count--) {
      let dist = MAXINT;
      for (const scan of this.intercepts) {
        if (scan.frac < dist) {
          dist = scan.frac;
          inx = scan;
        }
      }
      if (dist > maxfrac) return true; // checked everything in range
      if (!func(inx!)) return false;
      inx!.frac = MAXINT;
    }
    return true;
  }

  pathTraverse(
    x1: Fixed, y1: Fixed, x2: Fixed, y2: Fixed,
    flags: number,
    trav: (inx: Intercept) => boolean,
  ): boolean {
    const w = this.w;
    this.earlyout = (flags & PT_EARLYOUT) !== 0;
    w.validcount++;
    this.intercepts.length = 0;

    if (((x1 - w.bmaporgx) & (MAPBLOCKSIZE - 1)) === 0) x1 = (x1 + FRACUNIT) | 0;
    if (((y1 - w.bmaporgy) & (MAPBLOCKSIZE - 1)) === 0) y1 = (y1 + FRACUNIT) | 0;

    this.trace.x = x1;
    this.trace.y = y1;
    this.trace.dx = (x2 - x1) | 0;
    this.trace.dy = (y2 - y1) | 0;

    x1 = (x1 - w.bmaporgx) | 0;
    y1 = (y1 - w.bmaporgy) | 0;
    const xt1 = x1 >> MAPBLOCKSHIFT;
    const yt1 = y1 >> MAPBLOCKSHIFT;

    x2 = (x2 - w.bmaporgx) | 0;
    y2 = (y2 - w.bmaporgy) | 0;
    const xt2 = x2 >> MAPBLOCKSHIFT;
    const yt2 = y2 >> MAPBLOCKSHIFT;

    let mapxstep: number;
    let mapystep: number;
    let partial: Fixed;
    let xstep: Fixed;
    let ystep: Fixed;

    if (xt2 > xt1) {
      mapxstep = 1;
      partial = (FRACUNIT - ((x1 >> MAPBTOFRAC) & (FRACUNIT - 1))) | 0;
      ystep = FixedDiv((y2 - y1) | 0, Math.abs(x2 - x1) | 0);
    } else if (xt2 < xt1) {
      mapxstep = -1;
      partial = (x1 >> MAPBTOFRAC) & (FRACUNIT - 1);
      ystep = FixedDiv((y2 - y1) | 0, Math.abs(x2 - x1) | 0);
    } else {
      mapxstep = 0;
      partial = FRACUNIT;
      ystep = 256 * FRACUNIT;
    }
    let yintercept = ((y1 >> MAPBTOFRAC) + FixedMul(partial, ystep)) | 0;

    if (yt2 > yt1) {
      mapystep = 1;
      partial = (FRACUNIT - ((y1 >> MAPBTOFRAC) & (FRACUNIT - 1))) | 0;
      xstep = FixedDiv((x2 - x1) | 0, Math.abs(y2 - y1) | 0);
    } else if (yt2 < yt1) {
      mapystep = -1;
      partial = (y1 >> MAPBTOFRAC) & (FRACUNIT - 1);
      xstep = FixedDiv((x2 - x1) | 0, Math.abs(y2 - y1) | 0);
    } else {
      mapystep = 0;
      partial = FRACUNIT;
      xstep = 256 * FRACUNIT;
    }
    let xintercept = ((x1 >> MAPBTOFRAC) + FixedMul(partial, xstep)) | 0;

    // Step through map blocks; count prevents round-off from skipping
    // the break.
    let mapx = xt1;
    let mapy = yt1;
    for (let count = 0; count < 64; count++) {
      if (flags & PT_ADDLINES) {
        if (!this.blockLinesIterator(mapx, mapy, (ld) => this.addLineIntercepts(ld))) {
          return false; // early out
        }
      }
      if (flags & PT_ADDTHINGS) {
        if (!this.blockThingsIterator(mapx, mapy, (t) => this.addThingIntercepts(t))) {
          return false;
        }
      }
      if (mapx === xt2 && mapy === yt2) break;

      if (yintercept >> FRACBITS === mapy) {
        yintercept = (yintercept + ystep) | 0;
        mapx += mapxstep;
      } else if (xintercept >> FRACBITS === mapx) {
        xintercept = (xintercept + xstep) | 0;
        mapy += mapystep;
      }
    }
    return this.traverseIntercepts(trav, FRACUNIT);
  }
}
