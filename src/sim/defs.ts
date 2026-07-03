// Core sim constants, ported from doomdef.h / p_local.h / doomdata.h.

import { FRACBITS, FRACUNIT, MAXINT, MININT } from './fixed.ts';

export const TICRATE = 35;

// Blockmap geometry
export const MAPBLOCKUNITS = 128;
export const MAPBLOCKSIZE = MAPBLOCKUNITS * FRACUNIT;
export const MAPBLOCKSHIFT = FRACBITS + 7;
export const MAPBMASK = MAPBLOCKSIZE - 1;
export const MAPBTOFRAC = MAPBLOCKSHIFT - FRACBITS;

export const MAXRADIUS = 32 * FRACUNIT;
export const GRAVITY = FRACUNIT;
export const MAXMOVE = 30 * FRACUNIT;

export const USERANGE = 64 * FRACUNIT;
export const MELEERANGE = 64 * FRACUNIT;
export const MISSILERANGE = 32 * 64 * FRACUNIT;

export const ONFLOORZ = MININT;
export const ONCEILINGZ = MAXINT;

export const VIEWHEIGHT = 41 * FRACUNIT;
export const FLOATSPEED = 4 * FRACUNIT;

export const FRICTION = 0xe800;
export const STOPSPEED = 0x1000;

// Jump (GZDoom-style deviation): vertical impulse when on the ground.
export const JUMPSPEED = 8 * FRACUNIT;

// linedef flags (doomdata.h)
export const ML_BLOCKING = 1;
export const ML_BLOCKMONSTERS = 2;
export const ML_TWOSIDED = 4;
export const ML_DONTPEGTOP = 8;
export const ML_DONTPEGBOTTOM = 16;
export const ML_SECRET = 32;
export const ML_SOUNDBLOCK = 64;
export const ML_DONTDRAW = 128;
export const ML_MAPPED = 256;

// bounding box array indices (m_bbox.h)
export const BOXTOP = 0;
export const BOXBOTTOM = 1;
export const BOXLEFT = 2;
export const BOXRIGHT = 3;

export const enum SlopeType {
  Horizontal,
  Vertical,
  Positive,
  Negative,
}

export const enum PlayerState {
  Live,
  Dead,
  Reborn,
}

// ticcmd buttons (d_event.h)
export const BT_ATTACK = 1;
export const BT_USE = 2;
export const BT_CHANGE = 4;
export const BT_WEAPONMASK = 8 + 16 + 32;
export const BT_WEAPONSHIFT = 3;

// buttons2 (DoomCraft extension)
export const BT2_JUMP = 1;
export const BT2_BLOCKPLACE = 2;
export const BT2_BLOCKREMOVE = 4;

export const MAXPLAYERS = 4; // vanilla

// Frame flags (info.h / p_pspr.h)
export const FF_FULLBRIGHT = 0x8000;
export const FF_FRAMEMASK = 0x7fff;
