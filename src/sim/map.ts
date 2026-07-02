// Movement clipping, ported from p_map.c. The C globals (tm*) live on
// the PMap instance. Combat-related hooks (damage, pickups, specials)
// are wired in by the sim; they default to no-ops until M4.
//
// Deliberate deviation: no spechit/intercepts overrun emulation (vanilla
// memory-corruption compat for exotic demos; irrelevant for our use).

import { ANGLETOFINESHIFT, ANG180, finesine, finecosine } from './tables.ts';
import { pointToAngle2 } from './angles.ts';
import {
  BOXBOTTOM, BOXLEFT, BOXRIGHT, BOXTOP,
  MAPBLOCKSHIFT, MAXRADIUS, ML_BLOCKING, ML_BLOCKMONSTERS, ML_TWOSIDED,
  SlopeType,
} from './defs.ts';
import { FRACUNIT, FixedMul, type Fixed } from './fixed.ts';
import { MF, MT, S } from './data/info.gen.ts';
import {
  aproxDistance, pointInSubsector, pointOnLineSide,
  boxOnLineSide, setThingPosition, unsetThingPosition, PT_ADDLINES,
  type Intercept, type Traverser,
} from './maputl.ts';
import type { DoomRandom } from './random.ts';
import type { World } from './setup.ts';
import { Mobj, type Line, type Sector } from './world.ts';

export interface PMapHooks {
  damageMobj(target: Mobj, inflictor: Mobj | null, source: Mobj | null, damage: number): void;
  touchSpecialThing(special: Mobj, toucher: Mobj): void;
  crossSpecialLine(line: Line, side: number, thing: Mobj): void;
  setMobjState(mobj: Mobj, stateNum: number): boolean;
  removeMobj(mobj: Mobj): void;
  spawnMobj(x: Fixed, y: Fixed, z: Fixed, type: number): Mobj;
  leveltime(): number;
}

const noopHooks: PMapHooks = {
  damageMobj: () => {},
  touchSpecialThing: () => {},
  crossSpecialLine: () => {},
  setMobjState: () => true,
  removeMobj: () => {},
  spawnMobj: () => new Mobj(),
  leveltime: () => 0,
};

export class PMap {
  tmbbox: Fixed[] = [0, 0, 0, 0];
  tmthing!: Mobj;
  tmflags = 0;
  tmx: Fixed = 0;
  tmy: Fixed = 0;

  /** If true, move would be ok if within tmfloorz - tmceilingz. */
  floatok = false;
  tmfloorz: Fixed = 0;
  tmceilingz: Fixed = 0;
  tmdropoffz: Fixed = 0;

  /** the line that lowers the ceiling (missiles vs sky hack) */
  ceilingline: Line | null = null;
  spechit: Line[] = [];

  /** current map number (PIT_StompThing: monsters stomp on MAP30) */
  gamemap = 1;

  hooks: PMapHooks = noopHooks;

  /**
   * Block choke point 1: adjusts tmfloorz/tmceilingz for voxel blocks in
   * the destination AABB (installed by the blocks module).
   */
  adjustHeights: ((thing: Mobj, x: Fixed, y: Fixed) => void) | null = null;

  // slide move state
  private bestslidefrac: Fixed = 0;
  private bestslideline: Line | null = null;
  private slidemo!: Mobj;
  private tmxmove: Fixed = 0;
  private tmymove: Fixed = 0;

  constructor(
    private readonly w: World,
    private readonly tr: Traverser,
    private readonly rng: DoomRandom,
  ) {}

  // --- teleport move ----------------------------------------------------

  private stompThing(thing: Mobj): boolean {
    if (!(thing.flags & MF.SHOOTABLE)) return true;
    const blockdist = (thing.radius + this.tmthing.radius) | 0;
    if (
      Math.abs(thing.x - this.tmx) >= blockdist ||
      Math.abs(thing.y - this.tmy) >= blockdist
    ) {
      return true; // didn't hit it
    }
    if (thing === this.tmthing) return true; // don't clip against self
    // monsters don't stomp things except on boss level
    if (!this.tmthing.player && this.gamemap !== 30) return false;
    this.hooks.damageMobj(thing, this.tmthing, this.tmthing, 10000);
    return true;
  }

  teleportMove(thing: Mobj, x: Fixed, y: Fixed): boolean {
    const w = this.w;
    this.tmthing = thing;
    this.tmflags = thing.flags;
    this.tmx = x;
    this.tmy = y;
    this.tmbbox[BOXTOP] = (y + thing.radius) | 0;
    this.tmbbox[BOXBOTTOM] = (y - thing.radius) | 0;
    this.tmbbox[BOXRIGHT] = (x + thing.radius) | 0;
    this.tmbbox[BOXLEFT] = (x - thing.radius) | 0;

    const newsubsec = pointInSubsector(w, x, y);
    this.ceilingline = null;
    this.tmfloorz = this.tmdropoffz = newsubsec.sector.floorheight;
    this.tmceilingz = newsubsec.sector.ceilingheight;

    w.validcount++;
    this.spechit.length = 0;

    const xl = (this.tmbbox[BOXLEFT]! - w.bmaporgx - MAXRADIUS) >> MAPBLOCKSHIFT;
    const xh = (this.tmbbox[BOXRIGHT]! - w.bmaporgx + MAXRADIUS) >> MAPBLOCKSHIFT;
    const yl = (this.tmbbox[BOXBOTTOM]! - w.bmaporgy - MAXRADIUS) >> MAPBLOCKSHIFT;
    const yh = (this.tmbbox[BOXTOP]! - w.bmaporgy + MAXRADIUS) >> MAPBLOCKSHIFT;
    for (let bx = xl; bx <= xh; bx++) {
      for (let by = yl; by <= yh; by++) {
        if (!this.tr.blockThingsIterator(bx, by, (t) => this.stompThing(t))) return false;
      }
    }

    unsetThingPosition(w, thing);
    thing.floorz = this.tmfloorz;
    thing.ceilingz = this.tmceilingz;
    thing.x = x;
    thing.y = y;
    setThingPosition(w, thing);
    return true;
  }

  // --- movement iterator functions ---------------------------------------

  private checkLine(ld: Line): boolean {
    const bb = this.tmbbox;
    if (
      bb[BOXRIGHT]! <= ld.bbox[BOXLEFT]! || bb[BOXLEFT]! >= ld.bbox[BOXRIGHT]! ||
      bb[BOXTOP]! <= ld.bbox[BOXBOTTOM]! || bb[BOXBOTTOM]! >= ld.bbox[BOXTOP]!
    ) {
      return true;
    }
    if (boxOnLineSide(bb, ld) !== -1) return true;

    // A line has been hit.
    if (!ld.backsector) return false; // one sided line

    if (!(this.tmthing.flags & MF.MISSILE)) {
      if (ld.flags & ML_BLOCKING) return false; // explicitly blocking everything
      if (!this.tmthing.player && ld.flags & ML_BLOCKMONSTERS) return false;
    }

    this.tr.lineOpening(ld);

    if (this.tr.opentop < this.tmceilingz) {
      this.tmceilingz = this.tr.opentop;
      this.ceilingline = ld;
    }
    if (this.tr.openbottom > this.tmfloorz) this.tmfloorz = this.tr.openbottom;
    if (this.tr.lowfloor < this.tmdropoffz) this.tmdropoffz = this.tr.lowfloor;

    if (ld.special) this.spechit.push(ld);
    return true;
  }

  private checkThing(thing: Mobj): boolean {
    if (!(thing.flags & (MF.SOLID | MF.SPECIAL | MF.SHOOTABLE))) return true;
    const blockdist = (thing.radius + this.tmthing.radius) | 0;
    if (
      Math.abs(thing.x - this.tmx) >= blockdist ||
      Math.abs(thing.y - this.tmy) >= blockdist
    ) {
      return true; // didn't hit it
    }
    if (thing === this.tmthing) return true;

    // check for skulls slamming into things
    if (this.tmthing.flags & MF.SKULLFLY) {
      const damage = ((this.rng.pRandom() % 8) + 1) * this.tmthing.info.damage;
      this.hooks.damageMobj(thing, this.tmthing, this.tmthing, damage);
      this.tmthing.flags &= ~MF.SKULLFLY;
      this.tmthing.momx = this.tmthing.momy = this.tmthing.momz = 0;
      this.hooks.setMobjState(this.tmthing, this.tmthing.info.spawnstate);
      return false; // stop moving
    }

    // missiles can hit other things
    if (this.tmthing.flags & MF.MISSILE) {
      if (this.tmthing.z > thing.z + thing.height) return true; // overhead
      if (this.tmthing.z + this.tmthing.height < thing.z) return true; // underneath

      const target = this.tmthing.target;
      if (
        target &&
        (target.type === thing.type ||
          (target.type === MT.KNIGHT && thing.type === MT.BRUISER) ||
          (target.type === MT.BRUISER && thing.type === MT.KNIGHT))
      ) {
        // Don't hit same species as originator.
        if (thing === target) return true;
        if (thing.type !== MT.PLAYER) {
          return false; // explode, but do no damage
        }
      }

      if (!(thing.flags & MF.SHOOTABLE)) {
        return !(thing.flags & MF.SOLID); // didn't do any damage
      }

      const damage = ((this.rng.pRandom() % 8) + 1) * this.tmthing.info.damage;
      this.hooks.damageMobj(thing, this.tmthing, target, damage);
      return false; // don't traverse any more
    }

    // check for special pickup
    if (thing.flags & MF.SPECIAL) {
      const solid = (thing.flags & MF.SOLID) !== 0;
      if (this.tmflags & MF.PICKUP) {
        this.hooks.touchSpecialThing(thing, this.tmthing);
      }
      return !solid;
    }

    return !(thing.flags & MF.SOLID);
  }

  // --- movement clipping --------------------------------------------------

  checkPosition(thing: Mobj, x: Fixed, y: Fixed): boolean {
    const w = this.w;
    this.tmthing = thing;
    this.tmflags = thing.flags;
    this.tmx = x;
    this.tmy = y;
    this.tmbbox[BOXTOP] = (y + thing.radius) | 0;
    this.tmbbox[BOXBOTTOM] = (y - thing.radius) | 0;
    this.tmbbox[BOXRIGHT] = (x + thing.radius) | 0;
    this.tmbbox[BOXLEFT] = (x - thing.radius) | 0;

    const newsubsec = pointInSubsector(w, x, y);
    this.ceilingline = null;
    this.tmfloorz = this.tmdropoffz = newsubsec.sector.floorheight;
    this.tmceilingz = newsubsec.sector.ceilingheight;

    w.validcount++;
    this.spechit.length = 0;

    if (this.tmflags & MF.NOCLIP) return true;

    // Check things first; bbox extended by MAXRADIUS since mobjs are
    // blocked by origin point and can overlap into adjacent blocks.
    let xl = (this.tmbbox[BOXLEFT]! - w.bmaporgx - MAXRADIUS) >> MAPBLOCKSHIFT;
    let xh = (this.tmbbox[BOXRIGHT]! - w.bmaporgx + MAXRADIUS) >> MAPBLOCKSHIFT;
    let yl = (this.tmbbox[BOXBOTTOM]! - w.bmaporgy - MAXRADIUS) >> MAPBLOCKSHIFT;
    let yh = (this.tmbbox[BOXTOP]! - w.bmaporgy + MAXRADIUS) >> MAPBLOCKSHIFT;
    for (let bx = xl; bx <= xh; bx++) {
      for (let by = yl; by <= yh; by++) {
        if (!this.tr.blockThingsIterator(bx, by, (t) => this.checkThing(t))) return false;
      }
    }

    // check lines
    xl = (this.tmbbox[BOXLEFT]! - w.bmaporgx) >> MAPBLOCKSHIFT;
    xh = (this.tmbbox[BOXRIGHT]! - w.bmaporgx) >> MAPBLOCKSHIFT;
    yl = (this.tmbbox[BOXBOTTOM]! - w.bmaporgy) >> MAPBLOCKSHIFT;
    yh = (this.tmbbox[BOXTOP]! - w.bmaporgy) >> MAPBLOCKSHIFT;
    for (let bx = xl; bx <= xh; bx++) {
      for (let by = yl; by <= yh; by++) {
        if (!this.tr.blockLinesIterator(bx, by, (ld) => this.checkLine(ld))) return false;
      }
    }

    if (this.adjustHeights) this.adjustHeights(thing, x, y);
    return true;
  }

  tryMove(thing: Mobj, x: Fixed, y: Fixed): boolean {
    this.floatok = false;
    if (!this.checkPosition(thing, x, y)) return false; // solid wall or thing

    if (!(thing.flags & MF.NOCLIP)) {
      if (this.tmceilingz - this.tmfloorz < thing.height) return false; // doesn't fit
      this.floatok = true;
      if (!(thing.flags & MF.TELEPORT) && this.tmceilingz - thing.z < thing.height) {
        return false; // mobj must lower itself to fit
      }
      if (!(thing.flags & MF.TELEPORT) && this.tmfloorz - thing.z > 24 * FRACUNIT) {
        return false; // too big a step up
      }
      if (
        !(thing.flags & (MF.DROPOFF | MF.FLOAT)) &&
        this.tmfloorz - this.tmdropoffz > 24 * FRACUNIT
      ) {
        return false; // don't stand over a dropoff
      }
    }

    // the move is ok, so link the thing into its new position
    unsetThingPosition(this.w, thing);
    const oldx = thing.x;
    const oldy = thing.y;
    thing.floorz = this.tmfloorz;
    thing.ceilingz = this.tmceilingz;
    thing.x = x;
    thing.y = y;
    setThingPosition(this.w, thing);

    // if any special lines were hit, do the effect. Consume from the top
    // re-reading the live length each pass (vanilla `while (numspechit--)`
    // reads the global): crossing a teleporter runs teleportMove, which
    // RESETS spechit mid-loop — a captured length crashes here.
    if (!(thing.flags & (MF.TELEPORT | MF.NOCLIP))) {
      while (this.spechit.length > 0) {
        const ld = this.spechit.pop()!;
        const side = pointOnLineSide(thing.x, thing.y, ld);
        const oldside = pointOnLineSide(oldx, oldy, ld);
        if (side !== oldside) {
          if (ld.special) this.hooks.crossSpecialLine(ld, oldside, thing);
        }
      }
    }
    return true;
  }

  /** Adjust floorz/ceilingz (and z) after a sector height change. */
  thingHeightClip(thing: Mobj): boolean {
    const onfloor = thing.z === thing.floorz;
    this.checkPosition(thing, thing.x, thing.y);
    thing.floorz = this.tmfloorz;
    thing.ceilingz = this.tmceilingz;
    if (onfloor) {
      thing.z = thing.floorz; // walking monsters rise and fall with the floor
    } else if (thing.z + thing.height > thing.ceilingz) {
      thing.z = (thing.ceilingz - thing.height) | 0;
    }
    return thing.ceilingz - thing.floorz >= thing.height;
  }

  // --- sector height changing (P_ChangeSector) -------------------------------

  private crushchange = false;
  private nofit = false;

  private changeSectorPit(thing: Mobj): boolean {
    if (this.thingHeightClip(thing)) {
      return true; // keep checking
    }

    // crunch bodies to giblets
    if (thing.health <= 0) {
      this.hooks.setMobjState(thing, S.GIBS);
      thing.flags &= ~MF.SOLID;
      thing.height = 0;
      thing.radius = 0;
      return true;
    }

    // crunch dropped items
    if (thing.flags & MF.DROPPED) {
      this.hooks.removeMobj(thing);
      return true;
    }

    if (!(thing.flags & MF.SHOOTABLE)) {
      return true; // assume it is bloody gibs or something
    }

    this.nofit = true;

    if (this.crushchange && !(this.hooks.leveltime() & 3)) {
      this.hooks.damageMobj(thing, null, null, 10);
      // spray blood in a random direction
      const mo = this.hooks.spawnMobj(
        thing.x, thing.y, (thing.z + ((thing.height / 2) | 0)) | 0, MT.BLOOD,
      );
      mo.momx = this.rng.pSubRandom() << 12;
      mo.momy = this.rng.pSubRandom() << 12;
    }
    return true; // keep checking (crush other things)
  }

  changeSector(sector: Sector, crunch: boolean): boolean {
    this.nofit = false;
    this.crushchange = crunch;

    // re-check heights for all things near the moving sector
    for (let x = sector.blockbox[BOXLEFT]!; x <= sector.blockbox[BOXRIGHT]!; x++) {
      for (let y = sector.blockbox[BOXBOTTOM]!; y <= sector.blockbox[BOXTOP]!; y++) {
        this.tr.blockThingsIterator(x, y, (t) => this.changeSectorPit(t));
      }
    }
    return this.nofit;
  }

  // --- slide move -----------------------------------------------------------

  private hitSlideLine(ld: Line): void {
    if (ld.slopetype === SlopeType.Horizontal) {
      this.tmymove = 0;
      return;
    }
    if (ld.slopetype === SlopeType.Vertical) {
      this.tmxmove = 0;
      return;
    }

    const side = pointOnLineSide(this.slidemo.x, this.slidemo.y, ld);
    let lineangle = pointToAngle2(0, 0, ld.dx, ld.dy);
    if (side === 1) lineangle = (lineangle + ANG180) | 0;

    const moveangle = pointToAngle2(0, 0, this.tmxmove, this.tmymove);
    let deltaangle = (moveangle - lineangle) | 0;
    // angle_t comparison is unsigned
    if (deltaangle >>> 0 > ANG180 >>> 0) deltaangle = (deltaangle + ANG180) | 0;

    const lineangleFine = lineangle >>> ANGLETOFINESHIFT;
    const deltaangleFine = deltaangle >>> ANGLETOFINESHIFT;

    const movelen = aproxDistance(this.tmxmove, this.tmymove);
    const newlen = FixedMul(movelen, finecosine(deltaangleFine));

    this.tmxmove = FixedMul(newlen, finecosine(lineangleFine));
    this.tmymove = FixedMul(newlen, finesine[lineangleFine]!);
  }

  private slideTraverse(inx: Intercept): boolean {
    const li = inx.line;
    if (!li) throw new Error('PTR_SlideTraverse: not a line?');

    let isblocking = false;
    if (!(li.flags & ML_TWOSIDED)) {
      if (pointOnLineSide(this.slidemo.x, this.slidemo.y, li)) {
        return true; // don't hit the back side
      }
      isblocking = true;
    } else {
      this.tr.lineOpening(li);
      if (this.tr.openrange < this.slidemo.height) isblocking = true; // doesn't fit
      else if (this.tr.opentop - this.slidemo.z < this.slidemo.height) isblocking = true; // too high
      else if (this.tr.openbottom - this.slidemo.z > 24 * FRACUNIT) isblocking = true; // step
    }
    if (!isblocking) return true;

    // the line blocks movement; see if it is closer than best so far
    if (inx.frac < this.bestslidefrac) {
      this.bestslidefrac = inx.frac;
      this.bestslideline = li;
    }
    return false; // stop
  }

  slideMove(mo: Mobj): void {
    this.slidemo = mo;
    let hitcount = 0;

    for (;;) {
      if (++hitcount === 3) {
        // don't loop forever: stairstep
        if (!this.tryMove(mo, mo.x, (mo.y + mo.momy) | 0)) {
          this.tryMove(mo, (mo.x + mo.momx) | 0, mo.y);
        }
        return;
      }

      // trace along the three leading corners
      let leadx: Fixed, trailx: Fixed, leady: Fixed, traily: Fixed;
      if (mo.momx > 0) {
        leadx = (mo.x + mo.radius) | 0;
        trailx = (mo.x - mo.radius) | 0;
      } else {
        leadx = (mo.x - mo.radius) | 0;
        trailx = (mo.x + mo.radius) | 0;
      }
      if (mo.momy > 0) {
        leady = (mo.y + mo.radius) | 0;
        traily = (mo.y - mo.radius) | 0;
      } else {
        leady = (mo.y - mo.radius) | 0;
        traily = (mo.y + mo.radius) | 0;
      }

      this.bestslidefrac = FRACUNIT + 1;
      this.tr.pathTraverse(
        leadx, leady, (leadx + mo.momx) | 0, (leady + mo.momy) | 0,
        PT_ADDLINES, (i) => this.slideTraverse(i),
      );
      this.tr.pathTraverse(
        trailx, leady, (trailx + mo.momx) | 0, (leady + mo.momy) | 0,
        PT_ADDLINES, (i) => this.slideTraverse(i),
      );
      this.tr.pathTraverse(
        leadx, traily, (leadx + mo.momx) | 0, (traily + mo.momy) | 0,
        PT_ADDLINES, (i) => this.slideTraverse(i),
      );

      // move up to the wall
      if (this.bestslidefrac === FRACUNIT + 1) {
        // the move must have hit the middle, so stairstep
        if (!this.tryMove(mo, mo.x, (mo.y + mo.momy) | 0)) {
          this.tryMove(mo, (mo.x + mo.momx) | 0, mo.y);
        }
        return;
      }

      // fudge a bit to make sure it doesn't hit
      this.bestslidefrac = (this.bestslidefrac - 0x800) | 0;
      if (this.bestslidefrac > 0) {
        const newx = FixedMul(mo.momx, this.bestslidefrac);
        const newy = FixedMul(mo.momy, this.bestslidefrac);
        if (!this.tryMove(mo, (mo.x + newx) | 0, (mo.y + newy) | 0)) {
          // goto stairstep
          if (!this.tryMove(mo, mo.x, (mo.y + mo.momy) | 0)) {
            this.tryMove(mo, (mo.x + mo.momx) | 0, mo.y);
          }
          return;
        }
      }

      // now continue along the wall; first calculate remainder
      this.bestslidefrac = (FRACUNIT - (this.bestslidefrac + 0x800)) | 0;
      if (this.bestslidefrac > FRACUNIT) this.bestslidefrac = FRACUNIT;
      if (this.bestslidefrac <= 0) return;

      this.tmxmove = FixedMul(mo.momx, this.bestslidefrac);
      this.tmymove = FixedMul(mo.momy, this.bestslidefrac);
      this.hitSlideLine(this.bestslideline!); // clip the moves
      mo.momx = this.tmxmove;
      mo.momy = this.tmymove;

      if (this.tryMove(mo, (mo.x + this.tmxmove) | 0, (mo.y + this.tmymove) | 0)) {
        return;
      }
    }
  }
}
