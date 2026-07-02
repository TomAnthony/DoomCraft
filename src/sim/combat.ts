// Attack traversal, use lines, radius attack (p_map.c) and the game
// spawn functions (p_mobj.c): puffs, blood, missiles.
//
// Freelook deviation: player attacks fall back to the view-pitch slope
// when autoaim finds no target (vanilla falls back to 0). pitchSlope()
// is the single place implementing it.

import { MF, MT, S } from './data/info.gen.ts';
import {
  MAPBLOCKSHIFT, MAXRADIUS, MELEERANGE, ML_TWOSIDED, USERANGE,
} from './defs.ts';
import { SFX } from './data/sounds.gen.ts';
import { FRACBITS, FRACUNIT, FixedDiv, FixedMul, type Fixed } from './fixed.ts';
import { pointToAngle2 } from './angles.ts';
import {
  PT_ADDLINES, PT_ADDTHINGS, aproxDistance,
  pointOnLineSide as pointOnLineSideOf, type Intercept,
} from './maputl.ts';
import { ANGLETOFINESHIFT, finecosine, finesine, finetangent } from './tables.ts';
import type { BlockTraceHit } from '../blocks/grid.ts';
import type { DoomSim } from './sim.ts';
import type { Mobj, Player } from './world.ts';

const SKY_FLAT = 'F_SKY1';

/** Freelook: convert a BAM pitch to an aim slope via finetangent. */
export function pitchSlope(pitch: number): Fixed {
  let i = 2048 + (pitch >> ANGLETOFINESHIFT);
  if (i < 0) i = 0;
  if (i > 4095) i = 4095;
  return finetangent[i]!;
}

class Combat {
  // C statics for the attack traversers
  private shootthing!: Mobj;
  private shootz: Fixed = 0;
  private laDamage = 0;
  private attackrange: Fixed = 0;
  private aimslope: Fixed = 0;
  private topslope: Fixed = 0;
  private bottomslope: Fixed = 0;
  private usething!: Mobj;
  private bombsource: Mobj | null = null;
  private bombspot!: Mobj;
  private bombdamage = 0;
  /** blocks choke point 3: nearest voxel hit along the current shot */
  private blockHit: BlockTraceHit | null = null;

  constructor(private readonly sim: DoomSim) {}

  /** Bullet strikes a voxel block: puff on the face, damage the block. */
  private hitBlockCell(): void {
    const hit = this.blockHit!;
    this.blockHit = null;
    const trace = this.sim.tr.trace;
    // frac is in FRACUNIT over the same trace segment
    const frac = (hit.frac - FixedDiv(4 * FRACUNIT, this.attackrange)) | 0;
    const x = (trace.x + FixedMul(trace.dx, frac)) | 0;
    const y = (trace.y + FixedMul(trace.dy, frac)) | 0;
    const z = (this.shootz + FixedMul(this.aimslope, FixedMul(frac, this.attackrange))) | 0;
    this.spawnPuff(x, y, z);
    if (this.laDamage) {
      const destroyed = this.sim.blocks.damage(hit.bx, hit.by, hit.bz, this.laDamage);
      if (destroyed) {
        this.sim.startSoundXY(x, y, 'barexp');
      }
    }
  }

  // --- aim ------------------------------------------------------------------

  private aimTraverse(inx: Intercept): boolean {
    const sim = this.sim;
    if (inx.line) {
      const li = inx.line;
      if (!(li.flags & ML_TWOSIDED)) return false; // stop

      // Crosses a two sided line: restrict the possible target ranges.
      sim.tr.lineOpening(li);
      if (sim.tr.openbottom >= sim.tr.opentop) return false; // stop

      const dist = FixedMul(this.attackrange, inx.frac);

      if (li.backsector === null || li.frontsector!.floorheight !== li.backsector.floorheight) {
        const slope = FixedDiv((sim.tr.openbottom - this.shootz) | 0, dist);
        if (slope > this.bottomslope) this.bottomslope = slope;
      }
      if (li.backsector === null || li.frontsector!.ceilingheight !== li.backsector.ceilingheight) {
        const slope = FixedDiv((sim.tr.opentop - this.shootz) | 0, dist);
        if (slope < this.topslope) this.topslope = slope;
      }
      if (this.topslope <= this.bottomslope) return false; // stop
      return true; // shot continues
    }

    // shoot a thing
    const th = inx.thing!;
    if (th === this.shootthing) return true; // can't shoot self
    if (!(th.flags & MF.SHOOTABLE)) return true; // corpse or something

    const dist = FixedMul(this.attackrange, inx.frac);
    let thingtopslope = FixedDiv((th.z + th.height - this.shootz) | 0, dist);
    if (thingtopslope < this.bottomslope) return true; // shot over the thing
    let thingbottomslope = FixedDiv((th.z - this.shootz) | 0, dist);
    if (thingbottomslope > this.topslope) return true; // shot under the thing

    // this thing can be hit!
    if (thingtopslope > this.topslope) thingtopslope = this.topslope;
    if (thingbottomslope < this.bottomslope) thingbottomslope = this.bottomslope;
    this.aimslope = ((thingtopslope + thingbottomslope) / 2) | 0;
    this.sim.linetarget = th;
    return false; // don't go any farther
  }

  aimLineAttack(t1: Mobj, angle: number, distance: Fixed): Fixed {
    const fine = angle >>> ANGLETOFINESHIFT;
    this.shootthing = t1;
    const x2 = (t1.x + (distance >> FRACBITS) * finecosine(fine)) | 0;
    const y2 = (t1.y + (distance >> FRACBITS) * finesine[fine]!) | 0;
    this.shootz = (t1.z + (t1.height >> 1) + 8 * FRACUNIT) | 0;

    // can't shoot outside view angles (SCREENHEIGHT/2*FRACUNIT/(SCREENWIDTH/2))
    this.topslope = ((200 / 2) * FRACUNIT / (320 / 2)) | 0;
    this.bottomslope = -this.topslope | 0;

    this.attackrange = distance;
    this.sim.linetarget = null;

    this.sim.tr.pathTraverse(
      t1.x, t1.y, x2, y2,
      PT_ADDLINES | PT_ADDTHINGS,
      (i) => this.aimTraverse(i),
    );
    if (this.sim.linetarget) return this.aimslope;
    return 0;
  }

  // --- shoot ------------------------------------------------------------------

  private shootTraverse(inx: Intercept): boolean {
    const sim = this.sim;
    const trace = sim.tr.trace;

    // A voxel block sits nearer than this intercept: shoot it instead.
    if (this.blockHit && inx.frac > this.blockHit.frac) {
      this.hitBlockCell();
      return false;
    }

    if (inx.line) {
      const li = inx.line;
      if (li.special) sim.shootSpecialLine(this.shootthing, li);

      let hitline = false;
      if (!(li.flags & ML_TWOSIDED)) {
        hitline = true;
      } else {
        // crosses a two sided line
        sim.tr.lineOpening(li);
        const dist = FixedMul(this.attackrange, inx.frac);
        if (li.backsector === null) {
          if (FixedDiv((sim.tr.openbottom - this.shootz) | 0, dist) > this.aimslope) hitline = true;
          else if (FixedDiv((sim.tr.opentop - this.shootz) | 0, dist) < this.aimslope) hitline = true;
        } else {
          if (
            li.frontsector!.floorheight !== li.backsector.floorheight &&
            FixedDiv((sim.tr.openbottom - this.shootz) | 0, dist) > this.aimslope
          ) {
            hitline = true;
          } else if (
            li.frontsector!.ceilingheight !== li.backsector.ceilingheight &&
            FixedDiv((sim.tr.opentop - this.shootz) | 0, dist) < this.aimslope
          ) {
            hitline = true;
          }
        }
      }

      if (!hitline) return true; // shot continues

      // hit line: position a bit closer
      const frac = (inx.frac - FixedDiv(4 * FRACUNIT, this.attackrange)) | 0;
      const x = (trace.x + FixedMul(trace.dx, frac)) | 0;
      const y = (trace.y + FixedMul(trace.dy, frac)) | 0;
      const z = (this.shootz + FixedMul(this.aimslope, FixedMul(frac, this.attackrange))) | 0;

      if (li.frontsector!.ceilingpic === SKY_FLAT) {
        // don't shoot the sky!
        if (z > li.frontsector!.ceilingheight) return false;
        // it's a sky hack wall
        if (li.backsector && li.backsector.ceilingpic === SKY_FLAT) return false;
      }

      this.spawnPuff(x, y, z);
      return false; // don't go any farther
    }

    // shoot a thing
    const th = inx.thing!;
    if (th === this.shootthing) return true;
    if (!(th.flags & MF.SHOOTABLE)) return true;

    const dist = FixedMul(this.attackrange, inx.frac);
    const thingtopslope = FixedDiv((th.z + th.height - this.shootz) | 0, dist);
    if (thingtopslope < this.aimslope) return true; // shot over the thing
    const thingbottomslope = FixedDiv((th.z - this.shootz) | 0, dist);
    if (thingbottomslope > this.aimslope) return true; // shot under the thing

    // hit thing: position a bit closer
    const frac = (inx.frac - FixedDiv(10 * FRACUNIT, this.attackrange)) | 0;
    const x = (trace.x + FixedMul(trace.dx, frac)) | 0;
    const y = (trace.y + FixedMul(trace.dy, frac)) | 0;
    const z = (this.shootz + FixedMul(this.aimslope, FixedMul(frac, this.attackrange))) | 0;

    if (th.flags & MF.NOBLOOD) this.spawnPuff(x, y, z);
    else this.spawnBlood(x, y, z, this.laDamage);

    if (this.laDamage) sim.damageMobj(th, this.shootthing, this.shootthing, this.laDamage);
    return false;
  }

  lineAttack(t1: Mobj, angle: number, distance: Fixed, slope: Fixed, damage: number): void {
    const fine = angle >>> ANGLETOFINESHIFT;
    this.shootthing = t1;
    this.laDamage = damage;
    const x2 = (t1.x + (distance >> FRACBITS) * finecosine(fine)) | 0;
    const y2 = (t1.y + (distance >> FRACBITS) * finesine[fine]!) | 0;
    this.shootz = (t1.z + (t1.height >> 1) + 8 * FRACUNIT) | 0;
    this.attackrange = distance;
    this.aimslope = slope;

    this.blockHit = null;
    if (this.sim.blocks.count) {
      const z2 = (this.shootz + FixedMul(slope, distance)) | 0;
      this.blockHit = this.sim.blocks.trace(t1.x, t1.y, this.shootz, x2, y2, z2);
    }

    const completed = this.sim.tr.pathTraverse(
      t1.x, t1.y, x2, y2,
      PT_ADDLINES | PT_ADDTHINGS,
      (i) => this.shootTraverse(i),
    );
    // nothing else stopped the shot but a block was in the way
    if (completed && this.blockHit) this.hitBlockCell();
  }

  // --- use lines -----------------------------------------------------------------

  private useTraverse(inx: Intercept): boolean {
    const sim = this.sim;
    const line = inx.line!;
    if (!line.special) {
      sim.tr.lineOpening(line);
      if (sim.tr.openrange <= 0) {
        sim.startSoundNum(this.usething, SFX.noway);
        return false; // can't use through a wall
      }
      return true; // not a special line, but keep checking
    }

    let side = 0;
    if (pointOnLineSideOf(this.usething.x, this.usething.y, line)) side = 1;
    sim.useSpecialLine(this.usething, line, side);
    return false; // can't use more than one special line in a row
  }

  useLines(player: Player): void {
    this.usething = player.mo!;
    const angle = player.mo!.angle >>> ANGLETOFINESHIFT;
    const x1 = player.mo!.x;
    const y1 = player.mo!.y;
    const x2 = (x1 + (USERANGE >> FRACBITS) * finecosine(angle)) | 0;
    const y2 = (y1 + (USERANGE >> FRACBITS) * finesine[angle]!) | 0;
    this.sim.tr.pathTraverse(x1, y1, x2, y2, PT_ADDLINES, (i) => this.useTraverse(i));
  }

  // --- radius attack ---------------------------------------------------------------

  private radiusPit(thing: Mobj): boolean {
    if (!(thing.flags & MF.SHOOTABLE)) return true;
    // Boss spider and cyborg take no damage from concussion.
    if (thing.type === MT.CYBORG || thing.type === MT.SPIDER) return true;

    const dx = Math.abs(thing.x - this.bombspot.x) | 0;
    const dy = Math.abs(thing.y - this.bombspot.y) | 0;
    let dist = dx > dy ? dx : dy;
    dist = (dist - thing.radius) >> FRACBITS;
    if (dist < 0) dist = 0;
    if (dist >= this.bombdamage) return true; // out of range

    // Blocks deviation: splash penetrates block walls with per-depth
    // attenuation, so radius attacks use the block-blind sight check and
    // subtract the attenuation instead.
    let damage = this.bombdamage - dist;
    if (this.sim.splashAtten) {
      damage -= this.sim.splashAtten(this.bombspot, thing);
      if (damage <= 0) return true;
    }
    const sight = this.sim.checkSightBase ?? this.sim.checkSight;
    if (sight(thing, this.bombspot)) {
      // must be in direct path
      this.sim.damageMobj(thing, this.bombspot, this.bombsource, damage);
    }
    return true;
  }

  radiusAttack(spot: Mobj, source: Mobj | null, damage: number): void {
    const w = this.sim.world;
    const dist = (damage + MAXRADIUS) << FRACBITS;
    const yh = (spot.y + dist - w.bmaporgy) >> MAPBLOCKSHIFT;
    const yl = (spot.y - dist - w.bmaporgy) >> MAPBLOCKSHIFT;
    const xh = (spot.x + dist - w.bmaporgx) >> MAPBLOCKSHIFT;
    const xl = (spot.x - dist - w.bmaporgx) >> MAPBLOCKSHIFT;
    this.bombspot = spot;
    this.bombsource = source;
    this.bombdamage = damage;

    for (let y = yl; y <= yh; y++) {
      for (let x = xl; x <= xh; x++) {
        this.sim.tr.blockThingsIterator(x, y, (t) => this.radiusPit(t));
      }
    }
  }

  // --- game spawn functions (p_mobj.c) -------------------------------------------------

  spawnPuff(x: Fixed, y: Fixed, z: Fixed): void {
    const sim = this.sim;
    z = (z + (sim.rng.pSubRandom() << 10)) | 0;
    const th = sim.spawnMobj(x, y, z, MT.PUFF);
    th.momz = FRACUNIT;
    th.tics -= sim.rng.pRandom() & 3;
    if (th.tics < 1) th.tics = 1;
    // don't make punches spark on the wall
    if (this.attackrange === MELEERANGE) sim.setMobjState(th, S.PUFF3);
  }

  spawnBlood(x: Fixed, y: Fixed, z: Fixed, damage: number): void {
    const sim = this.sim;
    z = (z + (sim.rng.pSubRandom() << 10)) | 0;
    const th = sim.spawnMobj(x, y, z, MT.BLOOD);
    th.momz = FRACUNIT * 2;
    th.tics -= sim.rng.pRandom() & 3;
    if (th.tics < 1) th.tics = 1;
    if (damage <= 12 && damage >= 9) sim.setMobjState(th, S.BLOOD2);
    else if (damage < 9) sim.setMobjState(th, S.BLOOD3);
  }

  private checkMissileSpawn(th: Mobj): void {
    const sim = this.sim;
    th.tics -= sim.rng.pRandom() & 3;
    if (th.tics < 1) th.tics = 1;

    // move a little forward so an angle can be computed if it
    // immediately explodes
    th.x = (th.x + (th.momx >> 1)) | 0;
    th.y = (th.y + (th.momy >> 1)) | 0;
    th.z = (th.z + (th.momz >> 1)) | 0;

    if (!sim.pmap.tryMove(th, th.x, th.y)) sim.explodeMissile(th);
  }

  spawnMissile(source: Mobj, dest: Mobj, type: number): Mobj {
    const sim = this.sim;
    const th = sim.spawnMobj(source.x, source.y, (source.z + 4 * 8 * FRACUNIT) | 0, type);
    if (th.info.seesound) sim.startSoundNum(th, th.info.seesound);

    th.target = source; // where it came from
    let an = pointToAngle2(source.x, source.y, dest.x, dest.y);
    // fuzzy player
    if (dest.flags & MF.SHADOW) an = (an + (sim.rng.pSubRandom() << 20)) | 0;

    th.angle = an;
    const fine = an >>> ANGLETOFINESHIFT;
    th.momx = FixedMul(th.info.speed, finecosine(fine));
    th.momy = FixedMul(th.info.speed, finesine[fine]!);

    let dist = aproxDistance((dest.x - source.x) | 0, (dest.y - source.y) | 0);
    dist = (dist / th.info.speed) | 0;
    if (dist < 1) dist = 1;
    th.momz = ((dest.z - source.z) / dist) | 0;

    this.checkMissileSpawn(th);
    return th;
  }

  spawnPlayerMissile(source: Mobj, type: number): void {
    const sim = this.sim;
    // see which target is to be aimed at
    let an = source.angle;
    let slope = this.aimLineAttack(source, an, 16 * 64 * FRACUNIT);

    if (!sim.linetarget) {
      an = (an + (1 << 26)) | 0;
      slope = this.aimLineAttack(source, an, 16 * 64 * FRACUNIT);
      if (!sim.linetarget) {
        an = (an - (2 << 26)) | 0;
        slope = this.aimLineAttack(source, an, 16 * 64 * FRACUNIT);
      }
      if (!sim.linetarget) {
        an = source.angle;
        // Freelook deviation: vanilla uses slope = 0.
        slope = pitchSlope(source.pitch);
      }
    }

    const x = source.x;
    const y = source.y;
    const z = (source.z + 4 * 8 * FRACUNIT) | 0;

    const th = sim.spawnMobj(x, y, z, type);
    if (th.info.seesound) sim.startSoundNum(th, th.info.seesound);
    th.target = source;
    th.angle = an;
    th.momx = FixedMul(th.info.speed, finecosine(an >>> ANGLETOFINESHIFT));
    th.momy = FixedMul(th.info.speed, finesine[an >>> ANGLETOFINESHIFT]!);
    th.momz = FixedMul(th.info.speed, slope);

    this.checkMissileSpawn(th);
  }
}

export function installCombat(sim: DoomSim): Combat {
  const combat = new Combat(sim);
  sim.aimLineAttack = (t1, angle, distance) => combat.aimLineAttack(t1, angle, distance);
  sim.lineAttack = (t1, angle, distance, slope, damage) =>
    combat.lineAttack(t1, angle, distance, slope, damage);
  sim.useLines = (player) => combat.useLines(player);
  sim.radiusAttack = (spot, source, damage) => combat.radiusAttack(spot, source, damage);
  sim.spawnMissile = (source, dest, type) => combat.spawnMissile(source, dest, type);
  sim.spawnPlayerMissile = (source, type) => combat.spawnPlayerMissile(source, type);
  sim.spawnPuff = (x, y, z) => combat.spawnPuff(x, y, z);
  return combat;
}
