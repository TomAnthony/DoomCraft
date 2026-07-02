// DoomSim: the deterministic game state container and tic driver.
// State is a pure function of (loaded level, sequence of runTic inputs).
//
// Thinker execution order matters for RNG call order, so mobjs live in a
// vanilla-style linked list: spawned thinkers are appended and still run
// in the tic that spawned them.

import type { MapData } from '../wad/maps.ts';
import { BlockGrid } from '../blocks/grid.ts';
import { MF, MT, mobjinfo, states, type StateRow } from './data/info.gen.ts';
import { SFX, sfxinfo } from './data/sounds.gen.ts';
import {
  MAXPLAYERS, ONCEILINGZ, ONFLOORZ, PlayerState, VIEWHEIGHT,
} from './defs.ts';
import { FRACBITS, type Fixed } from './fixed.ts';
import { PMap } from './map.ts';
import { setThingPosition, unsetThingPosition, Traverser } from './maputl.ts';
import { mobjThinker } from './mobj.ts';
import { DoomRandom } from './random.ts';
import { setupWorld, World } from './setup.ts';
import { ANG45, ANGLETOFINESHIFT, finecosine, finesine } from './tables.ts';
import { ThinkerList } from './thinker.ts';
import { emptyCmd, copyCmd, type TicCmd } from './ticcmd.ts';
import { playerThink } from './user.ts';
import { Mobj, Player, type Line, type Sector } from './world.ts';

export interface SoundEvent {
  readonly name: string;
  readonly x: Fixed;
  readonly y: Fixed;
  /** originating mobj (for channel stealing); null = global */
  readonly mobj: Mobj | null;
}

export interface MapThingSpawn {
  x: number;
  y: number;
  angle: number;
  type: number;
  options: number;
}

export class DoomSim {
  world!: World;
  readonly rng = new DoomRandom();
  tr!: Traverser;
  pmap!: PMap;

  readonly players: Player[] = [];
  readonly playeringame: boolean[] = [];
  playerstarts: (MapThingSpawn | null)[] = [null, null, null, null];
  deathmatchstarts: MapThingSpawn[] = [];

  leveltime = 0;
  gamemap = 1;
  /** 0-4 = ITYTD..NM; affects thing spawn filtering and reactiontime */
  gameskill = 3; // Ultra-Violence default
  /** netgame pickup rules (weapons stay placed, keys shared) vs solo */
  netgame = false;
  /** deathmatch-with-monsters: DM spawn points, all keys, no key things */
  deathmatch = false;

  /** all thinkers (mobjs + sector movers) in vanilla execution order */
  readonly thinkers = new ThinkerList();

  /** DoomCraft voxel blocks (part of deterministic state) */
  readonly blocks = new BlockGrid();

  /** sound events emitted this tic (read by the audio layer; not state) */
  soundEvents: SoundEvent[] = [];

  /** shared states; the block-gun module appends its custom states */
  stateTable: readonly StateRow[] = states;

  /** action dispatch (populated as systems land; missing = no-op in M3) */
  actions = new Map<string, (sim: DoomSim, mobj: Mobj) => void>();

  constructor() {
    for (let i = 0; i < MAXPLAYERS; i++) {
      this.players.push(new Player(i));
      this.playeringame.push(false);
    }
  }

  // --- level lifecycle ---------------------------------------------------

  loadLevel(map: MapData, gamemap: number, opts?: { spawnThings?: boolean }): void {
    this.world = setupWorld(map);
    this.tr = new Traverser(this.world);
    this.pmap = new PMap(this.world, this.tr, this.rng);
    this.pmap.hooks = {
      damageMobj: (t, i, s, d) => this.damageMobj(t, i, s, d),
      touchSpecialThing: (sp, to) => this.touchSpecialThing(sp, to),
      crossSpecialLine: (l, side, th) => this.crossSpecialLine(l, side, th),
      setMobjState: (m, s) => this.setMobjState(m, s),
      removeMobj: (m) => this.removeMobj(m),
      spawnMobj: (x, y, z, type) => this.spawnMobj(x, y, z, type),
      leveltime: () => this.leveltime,
    };
    this.pmap.adjustHeights = this.blockAdjust;
    this.pmap.gamemap = gamemap;
    this.gamemap = gamemap;
    this.leveltime = 0;
    this.thinkers.head = this.thinkers.tail = null;
    this.thinkers.count = 0;
    this.blocks.clear();
    this.playerstarts = [null, null, null, null];

    // P_LoadThings: player/deathmatch starts recorded; other things
    // spawn from M4 onward (opts.spawnThings).
    this.deathmatchstarts = [];
    for (const t of map.things) {
      if (t.type >= 1 && t.type <= 4) {
        this.playerstarts[t.type - 1] = { ...t };
        continue;
      }
      if (t.type === 11) {
        if (this.deathmatchstarts.length < 10) this.deathmatchstarts.push({ ...t });
        continue;
      }
      if (opts?.spawnThings) this.spawnMapThing(t);
    }

    for (let i = 0; i < MAXPLAYERS; i++) {
      if (this.playeringame[i]) {
        // Fresh players are reborn (pistol start); players carried over
        // from a previous level keep their inventory (vanilla co-op).
        // A player who is dead at the transition also reborns — never
        // carry a corpse into the next level.
        const p = this.players[i]!;
        if (!p.mo || p.playerstate !== PlayerState.Live || p.health <= 0) {
          p.playerstate = PlayerState.Reborn;
        }
        p.mo = null;
        this.spawnPlayer(i);
      }
    }

    this.exitPending = null;
    this.spawnSpecials();
  }

  /** Iterate live mobjs in thinker order (for rendering/checksums). */
  *mobjs(): IterableIterator<Mobj> {
    for (const t of this.thinkers) {
      if (t instanceof Mobj) yield t;
    }
  }

  // --- mobj management (p_mobj.c) ------------------------------------------

  setMobjState(mobj: Mobj, stateNum: number): boolean {
    let cycle = 0;
    do {
      if (stateNum === 0 /* S_NULL */) {
        mobj.stateNum = 0;
        this.removeMobj(mobj);
        return false;
      }
      const st = this.stateTable[stateNum]!;
      mobj.stateNum = stateNum;
      mobj.tics = st[2];
      mobj.sprite = st[0];
      mobj.frame = st[1];

      // Call action functions when the state is set
      const action = st[3];
      if (action) {
        const fn = this.actions.get(action);
        if (fn) fn(this, mobj);
      }
      stateNum = st[4];
      if (cycle++ > 1000000) throw new Error('P_SetMobjState: infinite state cycle');
    } while (!mobj.tics);
    return true;
  }

  spawnMobj(x: Fixed, y: Fixed, z: Fixed, type: number): Mobj {
    const mobj = new Mobj();
    const info = mobjinfo[type]!;
    mobj.type = type;
    mobj.info = info;
    mobj.x = x;
    mobj.y = y;
    mobj.radius = info.radius;
    mobj.height = info.height;
    mobj.flags = info.flags;
    mobj.health = info.spawnhealth;

    if (this.gameskill !== 4 /* nightmare */) mobj.reactiontime = info.reactiontime;

    mobj.lastlook = this.rng.pRandom() % MAXPLAYERS;
    // do not set the state with setMobjState: actions can't be called yet
    const st = this.stateTable[info.spawnstate]!;
    mobj.stateNum = info.spawnstate;
    mobj.tics = st[2];
    mobj.sprite = st[0];
    mobj.frame = st[1];

    setThingPosition(this.world, mobj);
    mobj.floorz = mobj.subsector!.sector.floorheight;
    mobj.ceilingz = mobj.subsector!.sector.ceilingheight;

    if (z === ONFLOORZ) mobj.z = mobj.floorz;
    else if (z === ONCEILINGZ) mobj.z = (mobj.ceilingz - info.height) | 0;
    else mobj.z = z;

    mobj.think = () => mobjThinker(this, mobj);
    this.thinkers.add(mobj);
    return mobj;
  }

  removeMobj(mobj: Mobj): void {
    // (item respawn queue omitted: only used by -altdeath item respawn)
    unsetThingPosition(this.world, mobj);
    mobj.removed = true; // unlinked from thinker list lazily in runTic
  }

  explodeMissile(mo: Mobj): void {
    mo.momx = mo.momy = mo.momz = 0;
    this.setMobjState(mo, mobjinfo[mo.type]!.deathstate);
    mo.tics -= this.rng.pRandom() & 3;
    if (mo.tics < 1) mo.tics = 1;
    mo.flags &= ~MF.MISSILE;
    if (mo.info.deathsound) this.startSoundNum(mo, mo.info.deathsound);
  }

  spawnMapThing(mthing: MapThingSpawn): void {
    // deathmatch starts / player starts handled in loadLevel
    if (mthing.type === 11 || mthing.type <= 4) return;

    // skill filtering ("not in multiplayer" flag ignored: always netgame)
    let bit: number;
    if (this.gameskill === 0) bit = 1;
    else if (this.gameskill === 4) bit = 4;
    else bit = 1 << ((this.gameskill - 1) & 0x1f);
    if (!(mthing.options & bit)) return;

    // find which type to spawn
    let i = 0;
    for (; i < mobjinfo.length; i++) {
      if (mthing.type === mobjinfo[i]!.doomednum) break;
    }
    if (i === mobjinfo.length) {
      throw new Error(`P_SpawnMapThing: unknown type ${mthing.type} at (${mthing.x}, ${mthing.y})`);
    }

    // don't spawn keycards in deathmatch (players get all keys)
    if (this.deathmatch && mobjinfo[i]!.flags & MF.NOTDMATCH) return;

    const x = mthing.x << FRACBITS;
    const y = mthing.y << FRACBITS;
    const z = mobjinfo[i]!.flags & MF.SPAWNCEILING ? ONCEILINGZ : ONFLOORZ;

    const mobj = this.spawnMobj(x, y, z, i);
    mobj.spawnpoint = { ...mthing };
    if (mobj.tics > 0) mobj.tics = 1 + (this.rng.pRandom() % mobj.tics);
    if (mobj.flags & MF.COUNTKILL) this.totalkills++;
    if (mobj.flags & MF.COUNTITEM) this.totalitems++;

    mobj.angle = ANG45 * ((mthing.angle / 45) | 0);
    if (mthing.options & 8 /* MTF_AMBUSH */) mobj.flags |= MF.AMBUSH;
  }

  totalkills = 0;
  totalitems = 0;

  // --- players -----------------------------------------------------------

  private playerReborn(playernum: number): void {
    const old = this.players[playernum]!;
    const frags = old.frags;
    const p = new Player(playernum);
    p.frags = frags;
    p.playerstate = PlayerState.Reborn;
    this.players[playernum] = p;
  }

  /** G_CheckSpot (simplified): can playernum spawn at this spot? */
  private spotFree(playernum: number, spot: MapThingSpawn): boolean {
    const x = spot.x << FRACBITS;
    const y = spot.y << FRACBITS;
    const mo = this.players[playernum]!.mo;
    if (!mo) {
      // first spawn of the level: only other players could be in the way
      for (let i = 0; i < MAXPLAYERS; i++) {
        const other = this.players[i]!.mo;
        if (i !== playernum && other && other.x === x && other.y === y) return false;
      }
      return true;
    }
    return this.pmap.checkPosition(mo, x, y);
  }

  spawnPlayer(playernum: number): void {
    if (!this.playeringame[playernum]) return;
    let start = this.playerstarts[playernum] ?? this.playerstarts[0];
    if (!start) throw new Error(`no start for player ${playernum + 1}`);
    let dmSpawn = false;

    if (this.deathmatch && this.deathmatchstarts.length > 0) {
      // G_DeathMatchSpawnPlayer: 20 random tries, else own player start.
      for (let j = 0; j < 20; j++) {
        const i = this.rng.pRandom() % this.deathmatchstarts.length;
        if (this.spotFree(playernum, this.deathmatchstarts[i]!)) {
          start = this.deathmatchstarts[i]!;
          dmSpawn = true;
          break;
        }
      }
    } else {
      // Co-op-style respawn: if the own start is blocked (e.g. the other
      // player stands on it), take the first free start (G_DoReborn).
      const oldMo = this.players[playernum]!.mo;
      if (oldMo) {
        const candidates = [start, ...this.playerstarts.filter((s) => s !== null)];
        for (const c of candidates) {
          if (c && this.spotFree(playernum, c)) {
            start = c;
            break;
          }
        }
      }
    }

    if (this.players[playernum]!.playerstate === PlayerState.Reborn) {
      this.playerReborn(playernum);
    }
    const p = this.players[playernum]!;

    const x = start.x << FRACBITS;
    const y = start.y << FRACBITS;
    const mobj = this.spawnMobj(x, y, ONFLOORZ, MT.PLAYER);

    // color translation for player 2+
    if (playernum > 0) mobj.flags |= playernum << 26; // MF_TRANSSHIFT

    mobj.angle = ANG45 * ((start.angle / 45) | 0);
    mobj.player = p;
    mobj.health = p.health;

    p.mo = mobj;
    p.playerstate = PlayerState.Live;
    p.refire = 0;
    p.damagecount = 0;
    p.bonuscount = 0;
    p.extralight = 0;
    p.fixedcolormap = 0;
    p.viewheight = VIEWHEIGHT;
    this.setupPsprites(p);

    // deathmatch: give all cards (keys don't spawn) + teleport fog/sound
    if (this.deathmatch) {
      p.cards = [true, true, true, true, true, true];
      if (dmSpawn) {
        const fine = mobj.angle >>> ANGLETOFINESHIFT;
        const fog = this.spawnMobj(
          (mobj.x + 20 * finecosine(fine)) | 0,
          (mobj.y + 20 * finesine[fine]!) | 0,
          mobj.z,
          MT.TFOG,
        );
        this.startSoundNum(fog, SFX.telept);
      }
    }
  }

  // --- module hook points ---------------------------------------------------
  // Assigned by install functions of the combat (p_inter/p_pspr/p_map
  // attacks), specials (p_spec family), and AI (p_enemy/p_sight) modules.
  // Signatures are the fixed contract; defaults are inert.

  /** who got hit by the last aimLineAttack/lineAttack (C linetarget) */
  linetarget: Mobj | null = null;

  damageMobj: (target: Mobj, inflictor: Mobj | null, source: Mobj | null, damage: number) => void =
    () => {};
  touchSpecialThing: (special: Mobj, toucher: Mobj) => void = () => {};
  aimLineAttack: (t1: Mobj, angle: number, distance: Fixed) => Fixed = () => 0;
  lineAttack: (t1: Mobj, angle: number, distance: Fixed, slope: Fixed, damage: number) => void =
    () => {};
  spawnMissile: (source: Mobj, dest: Mobj, type: number) => Mobj | null = () => null;
  spawnPlayerMissile: (source: Mobj, type: number) => void = () => {};
  radiusAttack: (spot: Mobj, source: Mobj | null, damage: number) => void = () => {};
  checkSight: (t1: Mobj, t2: Mobj) => boolean = () => false;
  /** P_NoiseAlert (p_enemy.c) — wakes monsters when a weapon fires */
  noiseAlert: (target: Mobj, emitter: Mobj) => void = () => {};
  /** P_SpawnPuff (combat.ts) — used by A_Tracer's smoke */
  spawnPuff: (x: Fixed, y: Fixed, z: Fixed) => void = () => {};
  /** blocks: splash damage attenuation by intervening block depth */
  splashAtten: ((spot: Mobj, thing: Mobj) => number) | null = null;
  /** blocks: movement gap adjust, re-wired onto each level's PMap */
  blockAdjust: ((thing: Mobj, x: Fixed, y: Fixed) => void) | null = null;
  /** blocks: sight check WITHOUT block occlusion (radius attacks use it) */
  checkSightBase: ((t1: Mobj, t2: Mobj) => boolean) | null = null;
  /** A_BossDeath floor triggers (wired to the specials module) */
  bossDeathFloor: (kind: 'lowerFloorToLowest' | 'raiseToTexture', tag: number) => void = () => {};
  /** A_KeenDie door-open trigger (wired to the specials module) */
  keenDoorOpen: (tag: number) => void = () => {};

  crossSpecialLine: (line: Line, side: number, thing: Mobj) => void = () => {};
  shootSpecialLine: (thing: Mobj, line: Line) => void = () => {};
  useSpecialLine: (thing: Mobj, line: Line, side: number) => boolean = () => false;
  playerInSpecialSector: (player: Player) => void = () => {};
  /** P_SpawnSpecials: called at the end of loadLevel */
  spawnSpecials: () => void = () => {};

  useLines: (player: Player) => void = () => {};
  movePsprites: (player: Player) => void = () => {};
  setupPsprites: (player: Player) => void = () => {};

  /** set by exit specials; the game shell advances the level */
  exitPending: 'normal' | 'secret' | null = null;
  exitLevel(secret = false): void {
    this.exitPending = secret ? 'secret' : 'normal';
  }

  // --- sound -----------------------------------------------------------------

  startSound(mobj: Mobj | null, name: string): void {
    this.soundEvents.push({
      name,
      x: mobj ? mobj.x : 0,
      y: mobj ? mobj.y : 0,
      mobj,
    });
  }

  startSoundXY(x: Fixed, y: Fixed, name: string): void {
    this.soundEvents.push({ name, x, y, mobj: null });
  }

  startSoundNum(mobj: Mobj | null, sfxId: number): void {
    const info = sfxinfo[sfxId];
    this.startSound(mobj, info ? info.name : `sfx#${sfxId}`);
  }

  /** sector sound (doors/plats), from the sector's sound origin */
  startSectorSound(sector: Sector, sfxId: number): void {
    const info = sfxinfo[sfxId];
    this.soundEvents.push({
      name: info ? info.name : `sfx#${sfxId}`,
      x: sector.soundorgX,
      y: sector.soundorgY,
      mobj: null,
    });
  }

  // --- the tic ---------------------------------------------------------------

  runTic(cmds: TicCmd[]): void {
    this.soundEvents.length = 0;

    // G_Ticker: respawn dead players before thinking
    for (let i = 0; i < MAXPLAYERS; i++) {
      if (this.playeringame[i] && this.players[i]!.playerstate === PlayerState.Reborn) {
        this.spawnPlayer(i);
      }
    }

    // copy cmds
    for (let i = 0; i < MAXPLAYERS; i++) {
      if (this.playeringame[i]) {
        copyCmd(this.players[i]!.cmd, cmds[i] ?? emptyCmd());
      }
    }

    // P_Ticker
    for (let i = 0; i < MAXPLAYERS; i++) {
      if (this.playeringame[i]) playerThink(this, this.players[i]!);
    }

    this.thinkers.run();

    this.updateSpecials();
    this.leveltime++;
  }

  /** P_UpdateSpecials — assigned by the specials module. */
  updateSpecials: () => void = () => {};
}
