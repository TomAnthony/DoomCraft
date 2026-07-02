// Enemy thinking / AI action functions, ported from p_enemy.c.
//
// Doom 2 v1.9 semantics throughout: Chocolate Doom's gameversion
// branches resolve to exe_doom_1_9 / commercial, and the Doom 1.2
// paths are not ported. "netgame" is always true in DoomCraft.
// There is no separate -fast flag: gameskill === 4 (nightmare) implies
// fast monsters.
//
// The C module globals (soundtarget, corpsehit, viletry*, braintargets,
// the A_BrainSpit `static int easy`, ...) live on the Enemy instance,
// which is bound to one DoomSim: two sims can coexist in tests.

import { MF, MT, S, mobjinfo } from '../data/info.gen.ts';
import { SFX } from '../data/sounds.gen.ts';
import {
  FLOATSPEED, MAPBLOCKSHIFT, MAXPLAYERS, MAXRADIUS, MELEERANGE,
  MISSILERANGE, ML_SOUNDBLOCK, ML_TWOSIDED,
} from '../defs.ts';
import { FRACBITS, FRACUNIT, FixedMul, type Fixed } from '../fixed.ts';
import { aproxDistance, setThingPosition, unsetThingPosition } from '../maputl.ts';
import { pointToAngle2 } from '../angles.ts';
import {
  ANG90, ANG180, ANG270, ANGLETOFINESHIFT, finecosine, finesine,
} from '../tables.ts';
import type { DoomSim } from '../sim.ts';
import { Mobj, type Sector } from '../world.ts';
import type { Sight } from './sight.ts';

// dirtype_t
const DI_EAST = 0;
const DI_NORTHEAST = 1;
const DI_NORTH = 2;
const DI_NORTHWEST = 3;
const DI_WEST = 4;
const DI_SOUTHWEST = 5;
const DI_SOUTH = 6;
const DI_SOUTHEAST = 7;
const DI_NODIR = 8;

// P_NewChaseDir related LUT.
const opposite: readonly number[] = [
  DI_WEST, DI_SOUTHWEST, DI_SOUTH, DI_SOUTHEAST,
  DI_EAST, DI_NORTHEAST, DI_NORTH, DI_NORTHWEST, DI_NODIR,
];

const diags: readonly number[] = [
  DI_NORTHWEST, DI_NORTHEAST, DI_SOUTHWEST, DI_SOUTHEAST,
];

const xspeed: readonly Fixed[] = [
  FRACUNIT, 47000, 0, -47000, -FRACUNIT, -47000, 0, 47000,
];
const yspeed: readonly Fixed[] = [
  0, 47000, FRACUNIT, 47000, 0, -47000, -FRACUNIT, -47000,
];

const TRACEANGLE = 0xc000000;
const FATSPREAD = ANG90 / 8;
const SKULLSPEED = 20 * FRACUNIT;

/**
 * A_BossDeath's EV_DoFloor calls go through this sim-level indirection;
 * the specials module assigns `(sim as any).bossDeathFloor` when it
 * installs (wired in specials install).
 */
export type BossDeathFloorFn = (
  kind: 'lowerFloorToLowest' | 'raiseToTexture',
  tag: number,
) => void;

/** A_KeenDie's EV_DoDoor(open) indirection (wired in specials install). */
export type KeenDoorOpenFn = (tag: number) => void;

/** P_SpawnPuff lives in the combat module (wired in combat install). */
export type SpawnPuffFn = (x: Fixed, y: Fixed, z: Fixed) => void;

interface SimHooks {
  bossDeathFloor?: BossDeathFloorFn;
  keenDoorOpen?: KeenDoorOpenFn;
  spawnPuff?: SpawnPuffFn;
}

export class Enemy {
  // --- C module globals, bound per sim ------------------------------------
  private soundtarget: Mobj | null = null;
  private corpsehit: Mobj | null = null;
  private viletryx: Fixed = 0;
  private viletryy: Fixed = 0;
  private readonly braintargets: Mobj[] = [];
  private numbraintargets = 0;
  private braintargeton = 0;
  /** A_BrainSpit's `static int easy` */
  private easy = 0;

  constructor(
    private readonly sim: DoomSim,
    private readonly sight: Sight,
  ) {}

  /** P_SubstNullMobj (p_mobj.c): dummy at the origin for NULL targets. */
  private substNullMobj(mobj: Mobj | null): Mobj {
    if (mobj === null) {
      const dummy = new Mobj();
      dummy.x = 0;
      dummy.y = 0;
      dummy.z = 0;
      dummy.flags = 0;
      return dummy;
    }
    return mobj;
  }

  // --- sound alerting ------------------------------------------------------

  /**
   * P_RecursiveSound: recursively traverse adjacent sectors, sound
   * blocking lines cut off traversal.
   */
  private recursiveSound(sec: Sector, soundblocks: number): void {
    const w = this.sim.world;

    // wake up all monsters in this sector
    if (sec.validcount === w.validcount && sec.soundtraversed <= soundblocks + 1) {
      return; // already flooded
    }

    sec.validcount = w.validcount;
    sec.soundtraversed = soundblocks + 1;
    sec.soundtarget = this.soundtarget;

    for (let i = 0; i < sec.lines.length; i++) {
      const check = sec.lines[i]!;
      if (!(check.flags & ML_TWOSIDED)) continue;

      this.sim.tr.lineOpening(check);

      if (this.sim.tr.openrange <= 0) continue; // closed door

      const other =
        w.sides[check.sidenum[0]]!.sector === sec
          ? w.sides[check.sidenum[1]]!.sector
          : w.sides[check.sidenum[0]]!.sector;

      if (check.flags & ML_SOUNDBLOCK) {
        if (!soundblocks) this.recursiveSound(other, 1);
      } else {
        this.recursiveSound(other, soundblocks);
      }
    }
  }

  /**
   * P_NoiseAlert: if a monster yells at a player, it will alert other
   * monsters to the player.
   */
  noiseAlert(target: Mobj, emitter: Mobj): void {
    this.soundtarget = target;
    this.sim.world.validcount++;
    this.recursiveSound(emitter.subsector!.sector, 0);
  }

  // --- attack range checks --------------------------------------------------

  /** P_CheckMeleeRange */
  checkMeleeRange(actor: Mobj): boolean {
    if (!actor.target) return false;

    const pl = actor.target;
    const dist = aproxDistance((pl.x - actor.x) | 0, (pl.y - actor.y) | 0);

    // gameversion >= exe_doom_1_5 range
    const range = (MELEERANGE - 20 * FRACUNIT + pl.info.radius) | 0;

    if (dist >= range) return false;

    if (!this.sight.checkSight(actor, actor.target)) return false;

    return true;
  }

  /** P_CheckMissileRange */
  checkMissileRange(actor: Mobj): boolean {
    if (!this.sight.checkSight(actor, actor.target!)) return false;

    if (actor.flags & MF.JUSTHIT) {
      // the target just hit the enemy, so fight back!
      actor.flags &= ~MF.JUSTHIT;
      return true;
    }

    if (actor.reactiontime) return false; // do not attack yet

    let dist =
      (aproxDistance(
        (actor.x - actor.target!.x) | 0,
        (actor.y - actor.target!.y) | 0,
      ) -
        64 * FRACUNIT) |
      0;

    if (!actor.info.meleestate) dist = (dist - 128 * FRACUNIT) | 0; // no melee attack, so fire more

    dist >>= FRACBITS;

    if (actor.type === MT.VILE) {
      if (dist > 14 * 64) return false; // too far away
    }

    if (actor.type === MT.UNDEAD) {
      if (dist < 196) return false; // close for fist attack
      dist >>= 1;
    }

    if (actor.type === MT.CYBORG || actor.type === MT.SPIDER || actor.type === MT.SKULL) {
      dist >>= 1;
    }

    if (dist > 200) dist = 200;

    if (actor.type === MT.CYBORG && dist > 160) dist = 160;

    if (this.sim.rng.pRandom() < dist) return false;

    return true;
  }

  // --- movement --------------------------------------------------------------

  /**
   * P_Move: move in the current direction, returns false if the move is
   * blocked.
   */
  move(actor: Mobj): boolean {
    const sim = this.sim;

    if (actor.movedir === DI_NODIR) return false;

    if ((actor.movedir >>> 0) >= 8) throw new Error('Weird actor->movedir!');

    const tryx = (actor.x + actor.info.speed * xspeed[actor.movedir]!) | 0;
    const tryy = (actor.y + actor.info.speed * yspeed[actor.movedir]!) | 0;

    const tryOk = sim.pmap.tryMove(actor, tryx, tryy);

    if (!tryOk) {
      // open any specials
      if (actor.flags & MF.FLOAT && sim.pmap.floatok) {
        // must adjust height
        if (actor.z < sim.pmap.tmfloorz) actor.z = (actor.z + FLOATSPEED) | 0;
        else actor.z = (actor.z - FLOATSPEED) | 0;

        actor.flags |= MF.INFLOAT;
        return true;
      }

      if (!sim.pmap.spechit.length) return false;

      actor.movedir = DI_NODIR;
      let good = false;
      let numspechit = sim.pmap.spechit.length;
      while (numspechit--) {
        const ld = sim.pmap.spechit[numspechit]!;
        // if the special is not a door that can be opened, return false
        if (sim.useSpecialLine(actor, ld, 0)) good = true;
      }
      return good;
    } else {
      actor.flags &= ~MF.INFLOAT;
    }

    if (!(actor.flags & MF.FLOAT)) actor.z = actor.floorz;
    return true;
  }

  /**
   * P_TryWalk: attempts to move actor in its current (ob->moveangle)
   * direction. If a door is in the way, an OpenDoor call is made.
   */
  tryWalk(actor: Mobj): boolean {
    if (!this.move(actor)) return false;

    actor.movecount = this.sim.rng.pRandom() & 15;
    return true;
  }

  /** P_NewChaseDir */
  newChaseDir(actor: Mobj): void {
    if (!actor.target) throw new Error('P_NewChaseDir: called with no target');

    const olddir = actor.movedir;
    const turnaround = opposite[olddir]!;

    const deltax = (actor.target.x - actor.x) | 0;
    const deltay = (actor.target.y - actor.y) | 0;

    let d1: number;
    let d2: number;

    if (deltax > 10 * FRACUNIT) d1 = DI_EAST;
    else if (deltax < -10 * FRACUNIT) d1 = DI_WEST;
    else d1 = DI_NODIR;

    if (deltay < -10 * FRACUNIT) d2 = DI_SOUTH;
    else if (deltay > 10 * FRACUNIT) d2 = DI_NORTH;
    else d2 = DI_NODIR;

    // try direct route
    if (d1 !== DI_NODIR && d2 !== DI_NODIR) {
      actor.movedir = diags[((deltay < 0 ? 1 : 0) << 1) + (deltax > 0 ? 1 : 0)]!;
      if (actor.movedir !== turnaround && this.tryWalk(actor)) return;
    }

    // try other directions
    if (this.sim.rng.pRandom() > 200 || Math.abs(deltay) > Math.abs(deltax)) {
      const tdir = d1;
      d1 = d2;
      d2 = tdir;
    }

    if (d1 === turnaround) d1 = DI_NODIR;
    if (d2 === turnaround) d2 = DI_NODIR;

    if (d1 !== DI_NODIR) {
      actor.movedir = d1;
      if (this.tryWalk(actor)) {
        // either moved forward or attacked
        return;
      }
    }

    if (d2 !== DI_NODIR) {
      actor.movedir = d2;
      if (this.tryWalk(actor)) return;
    }

    // there is no direct path to the player, so pick another direction.
    if (olddir !== DI_NODIR) {
      actor.movedir = olddir;
      if (this.tryWalk(actor)) return;
    }

    // randomly determine direction of search
    if (this.sim.rng.pRandom() & 1) {
      for (let tdir = DI_EAST; tdir <= DI_SOUTHEAST; tdir++) {
        if (tdir !== turnaround) {
          actor.movedir = tdir;
          if (this.tryWalk(actor)) return;
        }
      }
    } else {
      for (let tdir = DI_SOUTHEAST; tdir !== DI_EAST - 1; tdir--) {
        if (tdir !== turnaround) {
          actor.movedir = tdir;
          if (this.tryWalk(actor)) return;
        }
      }
    }

    if (turnaround !== DI_NODIR) {
      actor.movedir = turnaround;
      if (this.tryWalk(actor)) return;
    }

    actor.movedir = DI_NODIR; // can not move
  }

  /**
   * P_LookForPlayers: if allaround is false, only look 180 degrees in
   * front. Returns true if a player is targeted.
   *
   * Vanilla loops with `& 3` (MAXPLAYERS 4); DoomCraft has MAXPLAYERS 2,
   * so indices 2/3 read playeringame[] as undefined (falsy) and continue,
   * exactly like vanilla's false entries.
   */
  lookForPlayers(actor: Mobj, allaround: boolean): boolean {
    let c = 0;
    const stop = (actor.lastlook - 1) & 3;

    for (; ; actor.lastlook = (actor.lastlook + 1) & 3) {
      if (!this.sim.playeringame[actor.lastlook]) continue;

      if (c++ === 2 || actor.lastlook === stop) {
        // done looking
        return false;
      }

      const player = this.sim.players[actor.lastlook]!;

      if (player.health <= 0) continue; // dead

      if (!this.sight.checkSight(actor, player.mo!)) continue; // out of sight

      if (!allaround) {
        const an =
          (pointToAngle2(actor.x, actor.y, player.mo!.x, player.mo!.y) - actor.angle) | 0;

        if ((an >>> 0) > (ANG90 >>> 0) && (an >>> 0) < (ANG270 >>> 0)) {
          const dist = aproxDistance(
            (player.mo!.x - actor.x) | 0,
            (player.mo!.y - actor.y) | 0,
          );
          // if real close, react anyway
          if (dist > MELEERANGE) continue; // behind back
        }
      }

      actor.target = player.mo;
      return true;
    }
  }

  //
  // A_KeenDie
  // DOOM II special, map 32. Uses special tag 666.
  //
  keenDie(mo: Mobj): void {
    this.fall(mo);

    // scan the remaining thinkers to see if all Keens are dead
    for (const mo2 of this.sim.mobjs()) {
      if (mo2 !== mo && mo2.type === mo.type && mo2.health > 0) {
        // other Keen not dead
        return;
      }
    }

    // EV_DoDoor(tag 666, vld_open) -- wired in specials install
    (this.sim as unknown as SimHooks).keenDoorOpen?.(666);
  }

  //
  // ACTION ROUTINES
  //

  /** A_Look: stay in state until a player is sighted. */
  look(actor: Mobj): void {
    const sim = this.sim;

    actor.threshold = 0; // any shot will wake up
    const targ = actor.subsector!.sector.soundtarget;

    let seeyou = false;
    if (targ && targ.flags & MF.SHOOTABLE) {
      actor.target = targ;

      if (actor.flags & MF.AMBUSH) {
        if (this.sight.checkSight(actor, actor.target)) seeyou = true;
      } else {
        seeyou = true;
      }
    }

    if (!seeyou) {
      if (!this.lookForPlayers(actor, false)) return;
    }

    // go into chase state (seeyou:)
    if (actor.info.seesound) {
      let sound: number;

      switch (actor.info.seesound) {
        case SFX.posit1:
        case SFX.posit2:
        case SFX.posit3:
          sound = SFX.posit1 + (sim.rng.pRandom() % 3);
          break;

        case SFX.bgsit1:
        case SFX.bgsit2:
          sound = SFX.bgsit1 + (sim.rng.pRandom() % 2);
          break;

        default:
          sound = actor.info.seesound;
          break;
      }

      if (actor.type === MT.SPIDER || actor.type === MT.CYBORG) {
        // full volume
        sim.startSoundNum(null, sound);
      } else {
        sim.startSoundNum(actor, sound);
      }
    }

    sim.setMobjState(actor, actor.info.seestate);
  }

  /**
   * A_Chase: actor has a melee attack, so it tries to close as fast as
   * possible.
   */
  chase(actor: Mobj): void {
    const sim = this.sim;

    if (actor.reactiontime) actor.reactiontime--;

    // modify target threshold
    if (actor.threshold) {
      if (!actor.target || actor.target.health <= 0) actor.threshold = 0;
      else actor.threshold--;
    }

    // turn towards movement direction if not there yet
    if (actor.movedir < 8) {
      actor.angle = actor.angle & (7 << 29);
      const delta = (actor.angle - (actor.movedir << 29)) | 0;

      if (delta > 0) actor.angle = (actor.angle - ANG90 / 2) | 0;
      else if (delta < 0) actor.angle = (actor.angle + ANG90 / 2) | 0;
    }

    if (!actor.target || !(actor.target.flags & MF.SHOOTABLE)) {
      // look for a new target
      if (this.lookForPlayers(actor, true)) return; // got a new target

      sim.setMobjState(actor, actor.info.spawnstate);
      return;
    }

    // do not attack twice in a row
    if (actor.flags & MF.JUSTATTACKED) {
      actor.flags &= ~MF.JUSTATTACKED;
      if (sim.gameskill !== 4) this.newChaseDir(actor); // not nightmare/fast
      return;
    }

    // check for melee attack
    if (actor.info.meleestate && this.checkMeleeRange(actor)) {
      if (actor.info.attacksound) sim.startSoundNum(actor, actor.info.attacksound);

      sim.setMobjState(actor, actor.info.meleestate);
      return;
    }

    // check for missile attack
    if (actor.info.missilestate) {
      // (skill < nightmare && !fast && movecount) -> goto nomissile
      if (!(sim.gameskill < 4 && actor.movecount)) {
        if (this.checkMissileRange(actor)) {
          sim.setMobjState(actor, actor.info.missilestate);
          actor.flags |= MF.JUSTATTACKED;
          return;
        }
      }
    }

    // nomissile:
    // possibly choose another target (netgame is always true in DoomCraft)
    if (!actor.threshold && !this.sight.checkSight(actor, actor.target)) {
      if (this.lookForPlayers(actor, true)) return; // got a new target
    }

    // chase towards player
    if (--actor.movecount < 0 || !this.move(actor)) {
      this.newChaseDir(actor);
    }

    // make active sound
    if (actor.info.activesound && sim.rng.pRandom() < 3) {
      sim.startSoundNum(actor, actor.info.activesound);
    }
  }

  /** A_FaceTarget */
  faceTarget(actor: Mobj): void {
    if (!actor.target) return;

    actor.flags &= ~MF.AMBUSH;

    actor.angle = pointToAngle2(actor.x, actor.y, actor.target.x, actor.target.y);

    if (actor.target.flags & MF.SHADOW) {
      actor.angle = (actor.angle + (this.sim.rng.pSubRandom() << 21)) | 0;
    }
  }

  /** A_PosAttack */
  posAttack(actor: Mobj): void {
    const sim = this.sim;
    if (!actor.target) return;

    this.faceTarget(actor);
    let angle = actor.angle;
    const slope = sim.aimLineAttack(actor, angle, MISSILERANGE);

    sim.startSoundNum(actor, SFX.pistol);
    angle = (angle + (sim.rng.pSubRandom() << 20)) | 0;
    const damage = ((sim.rng.pRandom() % 5) + 1) * 3;
    sim.lineAttack(actor, angle, MISSILERANGE, slope, damage);
  }

  /** A_SPosAttack */
  sPosAttack(actor: Mobj): void {
    const sim = this.sim;
    if (!actor.target) return;

    sim.startSoundNum(actor, SFX.shotgn);
    this.faceTarget(actor);
    const bangle = actor.angle;
    const slope = sim.aimLineAttack(actor, bangle, MISSILERANGE);

    for (let i = 0; i < 3; i++) {
      const angle = (bangle + (sim.rng.pSubRandom() << 20)) | 0;
      const damage = ((sim.rng.pRandom() % 5) + 1) * 3;
      sim.lineAttack(actor, angle, MISSILERANGE, slope, damage);
    }
  }

  /** A_CPosAttack */
  cPosAttack(actor: Mobj): void {
    const sim = this.sim;
    if (!actor.target) return;

    sim.startSoundNum(actor, SFX.shotgn);
    this.faceTarget(actor);
    const bangle = actor.angle;
    const slope = sim.aimLineAttack(actor, bangle, MISSILERANGE);

    const angle = (bangle + (sim.rng.pSubRandom() << 20)) | 0;
    const damage = ((sim.rng.pRandom() % 5) + 1) * 3;
    sim.lineAttack(actor, angle, MISSILERANGE, slope, damage);
  }

  /** A_CPosRefire */
  cPosRefire(actor: Mobj): void {
    // keep firing unless target got out of sight
    this.faceTarget(actor);

    if (this.sim.rng.pRandom() < 40) return;

    if (
      !actor.target ||
      actor.target.health <= 0 ||
      !this.sight.checkSight(actor, actor.target)
    ) {
      this.sim.setMobjState(actor, actor.info.seestate);
    }
  }

  /** A_SpidRefire */
  spidRefire(actor: Mobj): void {
    // keep firing unless target got out of sight
    this.faceTarget(actor);

    if (this.sim.rng.pRandom() < 10) return;

    if (
      !actor.target ||
      actor.target.health <= 0 ||
      !this.sight.checkSight(actor, actor.target)
    ) {
      this.sim.setMobjState(actor, actor.info.seestate);
    }
  }

  /** A_BspiAttack */
  bspiAttack(actor: Mobj): void {
    if (!actor.target) return;

    this.faceTarget(actor);

    // launch a missile
    this.sim.spawnMissile(actor, actor.target, MT.ARACHPLAZ);
  }

  /** A_TroopAttack */
  troopAttack(actor: Mobj): void {
    const sim = this.sim;
    if (!actor.target) return;

    this.faceTarget(actor);
    if (this.checkMeleeRange(actor)) {
      sim.startSoundNum(actor, SFX.claw);
      const damage = ((sim.rng.pRandom() % 8) + 1) * 3;
      sim.damageMobj(actor.target, actor, actor, damage);
      return;
    }

    // launch a missile
    sim.spawnMissile(actor, actor.target, MT.TROOPSHOT);
  }

  /** A_SargAttack */
  sargAttack(actor: Mobj): void {
    const sim = this.sim;
    if (!actor.target) return;

    this.faceTarget(actor);

    // gameversion >= exe_doom_1_5
    if (!this.checkMeleeRange(actor)) return;

    const damage = ((sim.rng.pRandom() % 10) + 1) * 4;
    sim.damageMobj(actor.target, actor, actor, damage);
  }

  /** A_HeadAttack */
  headAttack(actor: Mobj): void {
    const sim = this.sim;
    if (!actor.target) return;

    this.faceTarget(actor);
    if (this.checkMeleeRange(actor)) {
      const damage = ((sim.rng.pRandom() % 6) + 1) * 10;
      sim.damageMobj(actor.target, actor, actor, damage);
      return;
    }

    // launch a missile
    sim.spawnMissile(actor, actor.target, MT.HEADSHOT);
  }

  /** A_CyberAttack */
  cyberAttack(actor: Mobj): void {
    if (!actor.target) return;

    this.faceTarget(actor);
    this.sim.spawnMissile(actor, actor.target, MT.ROCKET);
  }

  /** A_BruisAttack (no A_FaceTarget in vanilla) */
  bruisAttack(actor: Mobj): void {
    const sim = this.sim;
    if (!actor.target) return;

    if (this.checkMeleeRange(actor)) {
      sim.startSoundNum(actor, SFX.claw);
      const damage = ((sim.rng.pRandom() % 8) + 1) * 10;
      sim.damageMobj(actor.target, actor, actor, damage);
      return;
    }

    // launch a missile
    sim.spawnMissile(actor, actor.target, MT.BRUISERSHOT);
  }

  /** A_SkelMissile */
  skelMissile(actor: Mobj): void {
    const sim = this.sim;
    if (!actor.target) return;

    this.faceTarget(actor);
    actor.z = (actor.z + 16 * FRACUNIT) | 0; // so missile spawns higher
    const mo = sim.spawnMissile(actor, actor.target, MT.TRACER);
    actor.z = (actor.z - 16 * FRACUNIT) | 0; // back to normal

    if (!mo) return; // P_SpawnMissile never fails in vanilla
    mo.x = (mo.x + mo.momx) | 0;
    mo.y = (mo.y + mo.momy) | 0;
    mo.tracer = actor.target;
  }

  /** A_Tracer */
  tracer(actor: Mobj): void {
    const sim = this.sim;

    // vanilla checks gametic & 3; leveltime == gametic modulo pause
    // semantics in DoomCraft.
    if (sim.leveltime & 3) return;

    // spawn a puff of smoke behind the rocket
    (sim as unknown as SimHooks).spawnPuff?.(actor.x, actor.y, actor.z); // wired in combat install

    const th = sim.spawnMobj(
      (actor.x - actor.momx) | 0,
      (actor.y - actor.momy) | 0,
      actor.z,
      MT.SMOKE,
    );

    th.momz = FRACUNIT;
    th.tics -= sim.rng.pRandom() & 3;
    if (th.tics < 1) th.tics = 1;

    // adjust direction
    const dest = actor.tracer;

    if (!dest || dest.health <= 0) return;

    // change angle
    const exact = pointToAngle2(actor.x, actor.y, dest.x, dest.y);

    if (exact !== actor.angle) {
      if (((exact - actor.angle) >>> 0) > 0x80000000) {
        actor.angle = (actor.angle - TRACEANGLE) | 0;
        if (((exact - actor.angle) >>> 0) < 0x80000000) actor.angle = exact;
      } else {
        actor.angle = (actor.angle + TRACEANGLE) | 0;
        if (((exact - actor.angle) >>> 0) > 0x80000000) actor.angle = exact;
      }
    }

    const fine = actor.angle >>> ANGLETOFINESHIFT;
    actor.momx = FixedMul(actor.info.speed, finecosine(fine));
    actor.momy = FixedMul(actor.info.speed, finesine[fine]!);

    // change slope
    let dist = aproxDistance((dest.x - actor.x) | 0, (dest.y - actor.y) | 0);

    dist = (dist / actor.info.speed) | 0;

    if (dist < 1) dist = 1;
    const slope = ((((dest.z + 40 * FRACUNIT) | 0) - actor.z) / dist) | 0;

    if (slope < actor.momz) actor.momz = (actor.momz - FRACUNIT / 8) | 0;
    else actor.momz = (actor.momz + FRACUNIT / 8) | 0;
  }

  /** A_SkelWhoosh */
  skelWhoosh(actor: Mobj): void {
    if (!actor.target) return;
    this.faceTarget(actor);
    this.sim.startSoundNum(actor, SFX.skeswg);
  }

  /** A_SkelFist */
  skelFist(actor: Mobj): void {
    const sim = this.sim;
    if (!actor.target) return;

    this.faceTarget(actor);

    if (this.checkMeleeRange(actor)) {
      const damage = ((sim.rng.pRandom() % 10) + 1) * 6;
      sim.startSoundNum(actor, SFX.skepch);
      sim.damageMobj(actor.target, actor, actor, damage);
    }
  }

  /** PIT_VileCheck: detect a corpse that could be raised. */
  private pitVileCheck(thing: Mobj): boolean {
    if (!(thing.flags & MF.CORPSE)) return true; // not a monster

    if (thing.tics !== -1) return true; // not lying still yet

    if (thing.info.raisestate === S.NULL) return true; // monster doesn't have a raise state

    const maxdist = (thing.info.radius + mobjinfo[MT.VILE]!.radius) | 0;

    if (
      Math.abs(thing.x - this.viletryx) > maxdist ||
      Math.abs(thing.y - this.viletryy) > maxdist
    ) {
      return true; // not actually touching
    }

    this.corpsehit = thing;
    this.corpsehit.momx = this.corpsehit.momy = 0;
    this.corpsehit.height <<= 2;
    const check = this.sim.pmap.checkPosition(this.corpsehit, this.corpsehit.x, this.corpsehit.y);
    this.corpsehit.height >>= 2;

    if (!check) return true; // doesn't fit here

    return false; // got one, so stop checking
  }

  /** A_VileChase: check for resurrecting a body. */
  vileChase(actor: Mobj): void {
    const sim = this.sim;

    if (actor.movedir !== DI_NODIR) {
      const w = sim.world;
      // check for corpses to raise
      this.viletryx = (actor.x + actor.info.speed * xspeed[actor.movedir]!) | 0;
      this.viletryy = (actor.y + actor.info.speed * yspeed[actor.movedir]!) | 0;

      const xl = (this.viletryx - w.bmaporgx - MAXRADIUS * 2) >> MAPBLOCKSHIFT;
      const xh = (this.viletryx - w.bmaporgx + MAXRADIUS * 2) >> MAPBLOCKSHIFT;
      const yl = (this.viletryy - w.bmaporgy - MAXRADIUS * 2) >> MAPBLOCKSHIFT;
      const yh = (this.viletryy - w.bmaporgy + MAXRADIUS * 2) >> MAPBLOCKSHIFT;

      for (let bx = xl; bx <= xh; bx++) {
        for (let by = yl; by <= yh; by++) {
          // Call PIT_VileCheck to check whether object is a corpse
          // that can be raised.
          if (!sim.tr.blockThingsIterator(bx, by, (t) => this.pitVileCheck(t))) {
            // got one!
            const corpsehit = this.corpsehit!;
            const temp = actor.target;
            actor.target = corpsehit;
            this.faceTarget(actor);
            actor.target = temp;

            sim.setMobjState(actor, S.VILE_HEAL1);
            sim.startSoundNum(corpsehit, SFX.slop);
            const info = corpsehit.info;

            sim.setMobjState(corpsehit, info.raisestate);
            corpsehit.height <<= 2;
            corpsehit.flags = info.flags;
            corpsehit.health = info.spawnhealth;
            corpsehit.target = null;

            return;
          }
        }
      }
    }

    // Return to normal attack.
    this.chase(actor);
  }

  /** A_VileStart */
  vileStart(actor: Mobj): void {
    this.sim.startSoundNum(actor, SFX.vilatk);
  }

  /** A_StartFire */
  startFire(actor: Mobj): void {
    this.sim.startSoundNum(actor, SFX.flamst);
    this.fire(actor);
  }

  /** A_FireCrackle */
  fireCrackle(actor: Mobj): void {
    this.sim.startSoundNum(actor, SFX.flame);
    this.fire(actor);
  }

  /** A_Fire: keep fire in front of player unless out of sight. */
  fire(actor: Mobj): void {
    const dest = actor.tracer;
    if (!dest) return;

    const target = this.substNullMobj(actor.target);

    // don't move it if the vile lost sight
    if (!this.sight.checkSight(target, dest)) return;

    const an = dest.angle >>> ANGLETOFINESHIFT;

    unsetThingPosition(this.sim.world, actor);
    actor.x = (dest.x + FixedMul(24 * FRACUNIT, finecosine(an))) | 0;
    actor.y = (dest.y + FixedMul(24 * FRACUNIT, finesine[an]!)) | 0;
    actor.z = dest.z;
    setThingPosition(this.sim.world, actor);
  }

  /** A_VileTarget: spawn the hellfire. */
  vileTarget(actor: Mobj): void {
    if (!actor.target) return;

    this.faceTarget(actor);

    // vanilla bug kept: target->x is passed for BOTH coordinates
    const fog = this.sim.spawnMobj(actor.target.x, actor.target.x, actor.target.z, MT.FIRE);

    actor.tracer = fog;
    fog.target = actor;
    fog.tracer = actor.target;
    this.fire(fog);
  }

  /** A_VileAttack */
  vileAttack(actor: Mobj): void {
    const sim = this.sim;
    if (!actor.target) return;

    this.faceTarget(actor);

    if (!this.sight.checkSight(actor, actor.target)) return;

    sim.startSoundNum(actor, SFX.barexp);
    sim.damageMobj(actor.target, actor, actor, 20);
    actor.target.momz = ((1000 * FRACUNIT) / actor.target.info.mass) | 0;

    const an = actor.angle >>> ANGLETOFINESHIFT;

    const fire = actor.tracer;

    if (!fire) return;

    // move the fire between the vile and the player
    fire.x = (actor.target.x - FixedMul(24 * FRACUNIT, finecosine(an))) | 0;
    fire.y = (actor.target.y - FixedMul(24 * FRACUNIT, finesine[an]!)) | 0;
    sim.radiusAttack(fire, actor, 70);
  }

  //
  // Mancubus attack: firing three missiles in three different directions?
  //

  /** A_FatRaise */
  fatRaise(actor: Mobj): void {
    this.faceTarget(actor);
    this.sim.startSoundNum(actor, SFX.manatk);
  }

  /** A_FatAttack1 */
  fatAttack1(actor: Mobj): void {
    const sim = this.sim;

    this.faceTarget(actor);

    // Change direction to ...
    actor.angle = (actor.angle + FATSPREAD) | 0;
    const target = this.substNullMobj(actor.target);
    sim.spawnMissile(actor, target, MT.FATSHOT);

    const mo = sim.spawnMissile(actor, target, MT.FATSHOT);
    if (!mo) return; // P_SpawnMissile never fails in vanilla
    mo.angle = (mo.angle + FATSPREAD) | 0;
    const an = mo.angle >>> ANGLETOFINESHIFT;
    mo.momx = FixedMul(mo.info.speed, finecosine(an));
    mo.momy = FixedMul(mo.info.speed, finesine[an]!);
  }

  /** A_FatAttack2 */
  fatAttack2(actor: Mobj): void {
    const sim = this.sim;

    this.faceTarget(actor);
    // Now here choose opposite deviation.
    actor.angle = (actor.angle - FATSPREAD) | 0;
    const target = this.substNullMobj(actor.target);
    sim.spawnMissile(actor, target, MT.FATSHOT);

    const mo = sim.spawnMissile(actor, target, MT.FATSHOT);
    if (!mo) return; // P_SpawnMissile never fails in vanilla
    mo.angle = (mo.angle - FATSPREAD * 2) | 0;
    const an = mo.angle >>> ANGLETOFINESHIFT;
    mo.momx = FixedMul(mo.info.speed, finecosine(an));
    mo.momy = FixedMul(mo.info.speed, finesine[an]!);
  }

  /** A_FatAttack3 */
  fatAttack3(actor: Mobj): void {
    const sim = this.sim;

    this.faceTarget(actor);

    const target = this.substNullMobj(actor.target);

    let mo = sim.spawnMissile(actor, target, MT.FATSHOT);
    if (mo) {
      mo.angle = (mo.angle - FATSPREAD / 2) | 0;
      const an = mo.angle >>> ANGLETOFINESHIFT;
      mo.momx = FixedMul(mo.info.speed, finecosine(an));
      mo.momy = FixedMul(mo.info.speed, finesine[an]!);
    }

    mo = sim.spawnMissile(actor, target, MT.FATSHOT);
    if (mo) {
      mo.angle = (mo.angle + FATSPREAD / 2) | 0;
      const an = mo.angle >>> ANGLETOFINESHIFT;
      mo.momx = FixedMul(mo.info.speed, finecosine(an));
      mo.momy = FixedMul(mo.info.speed, finesine[an]!);
    }
  }

  /** A_SkullAttack: fly at the player like a missile. */
  skullAttack(actor: Mobj): void {
    const sim = this.sim;
    if (!actor.target) return;

    const dest = actor.target;
    actor.flags |= MF.SKULLFLY;

    sim.startSoundNum(actor, actor.info.attacksound);
    this.faceTarget(actor);
    const an = actor.angle >>> ANGLETOFINESHIFT;
    actor.momx = FixedMul(SKULLSPEED, finecosine(an));
    actor.momy = FixedMul(SKULLSPEED, finesine[an]!);
    let dist = aproxDistance((dest.x - actor.x) | 0, (dest.y - actor.y) | 0);
    dist = (dist / SKULLSPEED) | 0;

    if (dist < 1) dist = 1;
    actor.momz = ((((dest.z + (dest.height >> 1)) | 0) - actor.z) / dist) | 0;
  }

  /** A_PainShootSkull: spawn a lost soul and launch it at the target. */
  private painShootSkull(actor: Mobj, angle: number): void {
    const sim = this.sim;

    // count total number of skulls currently on the level
    let count = 0;
    for (const th of sim.mobjs()) {
      if (th.type === MT.SKULL) count++;
    }

    // if there are already 20 skulls on the level, don't spit another one
    if (count > 20) return;

    // okay, there's place for another one
    const an = angle >>> ANGLETOFINESHIFT;

    const prestep =
      (4 * FRACUNIT +
        (((3 * ((actor.info.radius + mobjinfo[MT.SKULL]!.radius) | 0)) / 2) | 0)) |
      0;

    const x = (actor.x + FixedMul(prestep, finecosine(an))) | 0;
    const y = (actor.y + FixedMul(prestep, finesine[an]!)) | 0;
    const z = (actor.z + 8 * FRACUNIT) | 0;

    const newmobj = sim.spawnMobj(x, y, z, MT.SKULL);

    // Check for movements.
    if (!sim.pmap.tryMove(newmobj, newmobj.x, newmobj.y)) {
      // kill it immediately
      sim.damageMobj(newmobj, actor, actor, 10000);
      return;
    }

    newmobj.target = actor.target;
    this.skullAttack(newmobj);
  }

  /** A_PainAttack: spawn a lost soul and launch it at the target. */
  painAttack(actor: Mobj): void {
    if (!actor.target) return;

    this.faceTarget(actor);
    this.painShootSkull(actor, actor.angle);
  }

  /** A_PainDie */
  painDie(actor: Mobj): void {
    this.fall(actor);
    this.painShootSkull(actor, (actor.angle + ANG90) | 0);
    this.painShootSkull(actor, (actor.angle + ANG180) | 0);
    this.painShootSkull(actor, (actor.angle + ANG270) | 0);
  }

  /** A_Scream */
  scream(actor: Mobj): void {
    const sim = this.sim;
    let sound: number;

    switch (actor.info.deathsound) {
      case 0:
        return;

      case SFX.podth1:
      case SFX.podth2:
      case SFX.podth3:
        sound = SFX.podth1 + (sim.rng.pRandom() % 3);
        break;

      case SFX.bgdth1:
      case SFX.bgdth2:
        sound = SFX.bgdth1 + (sim.rng.pRandom() % 2);
        break;

      default:
        sound = actor.info.deathsound;
        break;
    }

    // Check for bosses.
    if (actor.type === MT.SPIDER || actor.type === MT.CYBORG) {
      // full volume
      sim.startSoundNum(null, sound);
    } else {
      sim.startSoundNum(actor, sound);
    }
  }

  /** A_XScream */
  xScream(actor: Mobj): void {
    this.sim.startSoundNum(actor, SFX.slop);
  }

  /** A_Pain */
  pain(actor: Mobj): void {
    if (actor.info.painsound) this.sim.startSoundNum(actor, actor.info.painsound);
  }

  /** A_Fall */
  fall(actor: Mobj): void {
    // actor is on ground, it can be walked over
    actor.flags &= ~MF.SOLID;
  }

  /** A_Explode */
  explode(thingy: Mobj): void {
    this.sim.radiusAttack(thingy, thingy.target, 128);
  }

  /**
   * A_BossDeath: possibly trigger special effects if on first boss
   * level. Doom 2 (commercial) rules only: MAP07 mancubus lowers floor
   * tag 666, arachnotron raises floor tag 667 to texture.
   */
  bossDeath(mo: Mobj): void {
    const sim = this.sim;

    if (sim.gamemap !== 7) return;

    if (mo.type !== MT.FATSO && mo.type !== MT.BABY) return;

    // make sure there is a player alive for victory
    let i = 0;
    for (; i < MAXPLAYERS; i++) {
      if (sim.playeringame[i] && sim.players[i]!.health > 0) break;
    }

    if (i === MAXPLAYERS) return; // no one left alive, so do not end game

    // scan the remaining thinkers to see if all bosses are dead
    for (const mo2 of sim.mobjs()) {
      if (mo2 !== mo && mo2.type === mo.type && mo2.health > 0) {
        // other boss not dead
        return;
      }
    }

    // victory!
    const hooks = sim as unknown as SimHooks;
    if (mo.type === MT.FATSO) {
      hooks.bossDeathFloor?.('lowerFloorToLowest', 666); // wired in specials install
      return;
    }

    if (mo.type === MT.BABY) {
      hooks.bossDeathFloor?.('raiseToTexture', 667); // wired in specials install
      return;
    }

    // unreachable on MAP07 (kept for structural fidelity with vanilla)
    sim.exitLevel();
  }

  /** A_Hoof */
  hoof(mo: Mobj): void {
    this.sim.startSoundNum(mo, SFX.hoof);
    this.chase(mo);
  }

  /** A_Metal */
  metal(mo: Mobj): void {
    this.sim.startSoundNum(mo, SFX.metal);
    this.chase(mo);
  }

  /** A_BabyMetal */
  babyMetal(mo: Mobj): void {
    this.sim.startSoundNum(mo, SFX.bspwlk);
    this.chase(mo);
  }

  // --- boss brain -------------------------------------------------------------

  /** A_BrainAwake */
  brainAwake(_mo: Mobj): void {
    // find all the target spots
    this.numbraintargets = 0;
    this.braintargeton = 0;
    this.braintargets.length = 0;

    for (const m of this.sim.mobjs()) {
      if (m.type === MT.BOSSTARGET) {
        this.braintargets[this.numbraintargets] = m;
        this.numbraintargets++;
      }
    }

    this.sim.startSoundNum(null, SFX.bossit);
  }

  /** A_BrainPain */
  brainPain(_mo: Mobj): void {
    this.sim.startSoundNum(null, SFX.bospn);
  }

  /** A_BrainScream */
  brainScream(mo: Mobj): void {
    const sim = this.sim;

    for (
      let x = (mo.x - 196 * FRACUNIT) | 0;
      x < ((mo.x + 320 * FRACUNIT) | 0);
      x = (x + FRACUNIT * 8) | 0
    ) {
      const y = (mo.y - 320 * FRACUNIT) | 0;
      const z = (128 + sim.rng.pRandom() * 2 * FRACUNIT) | 0;
      const th = sim.spawnMobj(x, y, z, MT.ROCKET);
      th.momz = sim.rng.pRandom() * 512;

      sim.setMobjState(th, S.BRAINEXPLODE1);

      th.tics -= sim.rng.pRandom() & 7;
      if (th.tics < 1) th.tics = 1;
    }

    sim.startSoundNum(null, SFX.bosdth);
  }

  /** A_BrainExplode */
  brainExplode(mo: Mobj): void {
    const sim = this.sim;

    const x = (mo.x + sim.rng.pSubRandom() * 2048) | 0;
    const y = mo.y;
    const z = (128 + sim.rng.pRandom() * 2 * FRACUNIT) | 0;
    const th = sim.spawnMobj(x, y, z, MT.ROCKET);
    th.momz = sim.rng.pRandom() * 512;

    sim.setMobjState(th, S.BRAINEXPLODE1);

    th.tics -= sim.rng.pRandom() & 7;
    if (th.tics < 1) th.tics = 1;
  }

  /** A_BrainDie */
  brainDie(_mo: Mobj): void {
    this.sim.exitLevel();
  }

  /** A_BrainSpit */
  brainSpit(mo: Mobj): void {
    const sim = this.sim;

    this.easy ^= 1;
    if (sim.gameskill <= 1 && !this.easy) return; // sk_easy

    // shoot a cube at current target
    const targ = this.braintargets[this.braintargeton];
    if (this.numbraintargets === 0) {
      throw new Error('A_BrainSpit: numbraintargets was 0 (vanilla crashes here)');
    }
    this.braintargeton = (this.braintargeton + 1) % this.numbraintargets;

    // spawn brain missile
    const newmobj = sim.spawnMissile(mo, targ!, MT.SPAWNSHOT);
    if (!newmobj) return; // P_SpawnMissile never fails in vanilla
    newmobj.target = targ!;
    // reactiontime = ((targ->y - mo->y) / momy) / state->tics
    // (integer division; a zero momy would be a vanilla div-by-zero crash)
    newmobj.reactiontime =
      (((((targ!.y - mo.y) | 0) / newmobj.momy) | 0) /
        sim.stateTable[newmobj.stateNum]![2]) |
      0;

    sim.startSoundNum(null, SFX.bospit);
  }

  /** A_SpawnSound: travelling cube sound. */
  spawnSound(mo: Mobj): void {
    this.sim.startSoundNum(mo, SFX.boscub);
    this.spawnFly(mo);
  }

  /** A_SpawnFly */
  spawnFly(mo: Mobj): void {
    const sim = this.sim;

    mo.reactiontime = (mo.reactiontime - 1) | 0;
    if (mo.reactiontime) return; // still flying

    const targ = this.substNullMobj(mo.target);

    // First spawn teleport fog.
    const fog = sim.spawnMobj(targ.x, targ.y, targ.z, MT.SPAWNFIRE);
    sim.startSoundNum(fog, SFX.telept);

    // Randomly select monster to spawn.
    const r = sim.rng.pRandom();

    // Probability distribution (kind of :), decreasing likelihood.
    let type: number;
    if (r < 50) type = MT.TROOP;
    else if (r < 90) type = MT.SERGEANT;
    else if (r < 120) type = MT.SHADOWS;
    else if (r < 130) type = MT.PAIN;
    else if (r < 160) type = MT.HEAD;
    else if (r < 162) type = MT.VILE;
    else if (r < 172) type = MT.UNDEAD;
    else if (r < 192) type = MT.BABY;
    else if (r < 222) type = MT.FATSO;
    else if (r < 246) type = MT.KNIGHT;
    else type = MT.BRUISER;

    const newmobj = sim.spawnMobj(targ.x, targ.y, targ.z, type);
    if (this.lookForPlayers(newmobj, true)) {
      sim.setMobjState(newmobj, newmobj.info.seestate);
    }

    // telefrag anything in this spot
    sim.pmap.teleportMove(newmobj, newmobj.x, newmobj.y);

    // remove self (i.e., cube).
    sim.removeMobj(mo);
  }

  /** A_PlayerScream */
  playerScream(mo: Mobj): void {
    // Default death sound.
    let sound: number = SFX.pldeth;

    // commercial (Doom 2): if the player dies less than -50% without
    // gibbing
    if (mo.health < -50) sound = SFX.pdiehi;

    this.sim.startSoundNum(mo, sound);
  }
}
