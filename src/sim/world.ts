// Runtime world structures (r_defs.h / p_mobj.h / d_player.h), all
// coordinates 16.16 fixed point. Mutable classes: the sim owns them.

import type { MobjInfo } from './data/info.gen.ts';
import { PlayerState, SlopeType } from './defs.ts';
import type { Fixed } from './fixed.ts';
import type { TicCmd } from './ticcmd.ts';

export class Vertex {
  constructor(
    public x: Fixed,
    public y: Fixed,
  ) {}
}

export class Sector {
  floorheight: Fixed = 0;
  ceilingheight: Fixed = 0;
  floorpic = '';
  ceilingpic = '';
  lightlevel = 0;
  special = 0;
  tag = 0;
  /** 0 = untraversed, 1,2 = sndlines - 1 */
  soundtraversed = 0;
  soundtarget: Mobj | null = null;
  /** mapblock bounding box for height changes [top, bottom, left, right] */
  blockbox: number[] = [0, 0, 0, 0];
  /** sound origin (bbox center) */
  soundorgX: Fixed = 0;
  soundorgY: Fixed = 0;
  validcount = 0;
  /** list of mobjs in sector (head) */
  thinglist: Mobj | null = null;
  /** thinker for reversable actions (doors/plats) */
  specialdata: unknown = null;
  lines: Line[] = [];
  readonly index: number;
  constructor(index: number) {
    this.index = index;
  }
}

export class Side {
  textureoffset: Fixed = 0;
  rowoffset: Fixed = 0;
  toptexture = '';
  bottomtexture = '';
  midtexture = '';
  sector!: Sector;
}

export class Line {
  v1!: Vertex;
  v2!: Vertex;
  dx: Fixed = 0;
  dy: Fixed = 0;
  flags = 0;
  special = 0;
  tag = 0;
  /** sidenum[1] === -1 if one sided */
  sidenum: [number, number] = [-1, -1];
  bbox: Fixed[] = [0, 0, 0, 0];
  slopetype: SlopeType = SlopeType.Horizontal;
  frontsector: Sector | null = null;
  backsector: Sector | null = null;
  validcount = 0;
  specialdata: unknown = null;
  readonly index: number;
  constructor(index: number) {
    this.index = index;
  }
}

export class Subsector {
  sector!: Sector;
  numlines = 0;
  firstline = 0;
}

export class Seg {
  v1!: Vertex;
  v2!: Vertex;
  offset: Fixed = 0;
  angle = 0;
  sidedef!: Side;
  linedef!: Line;
  frontsector!: Sector;
  backsector: Sector | null = null;
}

export class BspNode {
  x: Fixed = 0;
  y: Fixed = 0;
  dx: Fixed = 0;
  dy: Fixed = 0;
  /** [side][BOXTOP..BOXRIGHT] */
  bbox: [Fixed[], Fixed[]] = [[0, 0, 0, 0], [0, 0, 0, 0]];
  /** bit 15 set = subsector index */
  children: [number, number] = [0, 0];
}

export class Mobj {
  x: Fixed = 0;
  y: Fixed = 0;
  z: Fixed = 0;
  /** sector thing links */
  snext: Mobj | null = null;
  sprev: Mobj | null = null;
  angle = 0; // BAM as int32
  /** DoomCraft deviation: view pitch for freelook, BAM int32 (players only). */
  pitch = 0;
  sprite = 0;
  frame = 0;
  /** blockmap links */
  bnext: Mobj | null = null;
  bprev: Mobj | null = null;
  subsector: Subsector | null = null;
  floorz: Fixed = 0;
  ceilingz: Fixed = 0;
  radius: Fixed = 0;
  height: Fixed = 0;
  momx: Fixed = 0;
  momy: Fixed = 0;
  momz: Fixed = 0;
  validcount = 0;
  type = 0; // mobjtype index
  info!: MobjInfo;
  tics = 0;
  stateNum = 0;
  flags = 0;
  health = 0;
  movedir = 0;
  movecount = 0;
  target: Mobj | null = null;
  reactiontime = 0;
  threshold = 0;
  player: Player | null = null;
  lastlook = 0;
  spawnpoint: { x: number; y: number; angle: number; type: number; options: number } | null = null;
  tracer: Mobj | null = null;
  /** set when removed; excluded from thinker iteration */
  removed = false;
  /** thinker list links (vanilla thinkercap order) */
  tprev: Mobj | null = null;
  tnext: Mobj | null = null;
}

export class Player {
  mo: Mobj | null = null;
  playerstate: PlayerState = PlayerState.Reborn;
  cmd: TicCmd = {
    forwardmove: 0, sidemove: 0, angleturn: 0, pitch: 0,
    buttons: 0, buttons2: 0,
  };
  /** focal origin above mo.z */
  viewz: Fixed = 0;
  /** base height above floor for viewz */
  viewheight: Fixed = 0;
  /** squat speed after hard landing */
  deltaviewheight: Fixed = 0;
  /** bounded/scaled total momentum */
  bob: Fixed = 0;
  onground = false;
  health = 100;
  armorpoints = 0;
  armortype = 0;
  readyweapon = 1; // wp_pistol
  pendingweapon = -1; // wp_nochange marker handled later (M4)
  usedown = false;
  attackdown = false;
  refire = 0;
  damagecount = 0;
  bonuscount = 0;
  attacker: Mobj | null = null;
  extralight = 0;
  fixedcolormap = 0;
  frags = 0;
  readonly index: number;
  constructor(index: number) {
    this.index = index;
  }
}
