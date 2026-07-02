// DoomSim: the deterministic game state container and tic driver.
// State is a pure function of (loaded level, sequence of runTic inputs).
//
// Thinker execution order matters for RNG call order, so mobjs live in a
// vanilla-style linked list: spawned thinkers are appended and still run
// in the tic that spawned them.

import type { MapData } from '../wad/maps.ts';
import { MF, MT, mobjinfo, states, type StateRow } from './data/info.gen.ts';
import {
  MAXPLAYERS, ONCEILINGZ, ONFLOORZ, PlayerState, VIEWHEIGHT,
} from './defs.ts';
import { FRACBITS, type Fixed } from './fixed.ts';
import { PMap } from './map.ts';
import { setThingPosition, unsetThingPosition, Traverser } from './maputl.ts';
import { mobjThinker } from './mobj.ts';
import { DoomRandom } from './random.ts';
import { setupWorld, World } from './setup.ts';
import { ANG45 } from './tables.ts';
import { ThinkerList } from './thinker.ts';
import { emptyCmd, copyCmd, type TicCmd } from './ticcmd.ts';
import { playerThink } from './user.ts';
import { Mobj, Player } from './world.ts';

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

  leveltime = 0;
  gamemap = 1;
  /** 0-4 = ITYTD..NM; affects thing spawn filtering and reactiontime */
  gameskill = 3; // Ultra-Violence default

  /** all thinkers (mobjs + sector movers) in vanilla execution order */
  readonly thinkers = new ThinkerList();

  /** sound events emitted this tic (read by the audio layer; not state) */
  soundEvents: SoundEvent[] = [];

  readonly stateTable: readonly StateRow[] = states;

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
    this.pmap.gamemap = gamemap;
    this.gamemap = gamemap;
    this.leveltime = 0;
    this.thinkers.head = this.thinkers.tail = null;
    this.thinkers.count = 0;
    this.playerstarts = [null, null, null, null];

    // P_LoadThings: player starts always recorded; other things
    // spawn from M4 onward (opts.spawnThings).
    for (const t of map.things) {
      if (t.type >= 1 && t.type <= 4) {
        this.playerstarts[t.type - 1] = { ...t };
        continue;
      }
      if (opts?.spawnThings) this.spawnMapThing(t);
    }

    for (let i = 0; i < MAXPLAYERS; i++) {
      if (this.playeringame[i]) {
        this.players[i]!.playerstate = PlayerState.Reborn;
        this.spawnPlayer(i);
      }
    }
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

  spawnPlayer(playernum: number): void {
    if (!this.playeringame[playernum]) return;
    const start = this.playerstarts[playernum] ?? this.playerstarts[0];
    if (!start) throw new Error(`no start for player ${playernum + 1}`);

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
    // (P_SetupPsprites in M4)
  }

  // --- stubs completed in M4 ----------------------------------------------

  useLines(_player: Player): void {}
  movePsprites(_player: Player): void {}
  playerInSpecialSector(_player: Player): void {}

  startSound(mobj: Mobj | null, name: string): void {
    this.soundEvents.push({
      name,
      x: mobj ? mobj.x : 0,
      y: mobj ? mobj.y : 0,
      mobj,
    });
  }

  startSoundNum(mobj: Mobj | null, _sfxId: number): void {
    // resolved via sounds.gen in M4; keep the call graph identical now
    this.startSound(mobj, `sfx#${_sfxId}`);
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

  /** P_UpdateSpecials — replaced by the specials module in M4. */
  updateSpecials(): void {}
}
