// Player thinking, ported from p_user.c, plus the two sanctioned
// deviations: GZDoom-style jump and freelook pitch.

import { MF, S } from './data/info.gen.ts';
import {
  BT2_JUMP, BT_CHANGE, BT_USE, BT_WEAPONMASK, BT_WEAPONSHIFT,
  JUMPSPEED, PlayerState, VIEWHEIGHT,
} from './defs.ts';
import { Power, Weapon } from './items.ts';
import { FRACBITS, FRACUNIT, FixedMul, type Fixed } from './fixed.ts';
import { pointToAngle2 } from './angles.ts';
import {
  ANG90, ANG180, ANGLETOFINESHIFT, FINEANGLES, FINEMASK, finecosine, finesine,
} from './tables.ts';
import type { DoomSim } from './sim.ts';
import type { Player } from './world.ts';

const MAXBOB = 0x100000; // 16 pixels of bob
const ANG5 = (ANG90 / 18) | 0;

// Freelook clamp: ±85° (GZDoom allows near-vertical). Steep pitch is
// what makes Minecraft-style backward bridging (seeing the side face of
// your own support block from an overhang) and nerd-pole placement
// (aiming at the cell under your feet mid-jump) possible.
const MAXPITCH = 1014089500 | 0; // 85/360 * 2^32

function thrust(player: Player, angle: number, move: Fixed): void {
  const fine = angle >>> ANGLETOFINESHIFT;
  player.mo!.momx = (player.mo!.momx + FixedMul(move, finecosine(fine))) | 0;
  player.mo!.momy = (player.mo!.momy + FixedMul(move, finesine[fine]!)) | 0;
}

export function calcHeight(sim: DoomSim, player: Player): void {
  const mo = player.mo!;
  // Regular movement bobbing (calculated for gun swing even if airborne).
  player.bob = (FixedMul(mo.momx, mo.momx) + FixedMul(mo.momy, mo.momy)) | 0;
  player.bob >>= 2;
  if (player.bob > MAXBOB) player.bob = MAXBOB;

  if (!player.onground) {
    player.viewz = (mo.z + player.viewheight) | 0;
    if (player.viewz > mo.ceilingz - 4 * FRACUNIT) {
      player.viewz = (mo.ceilingz - 4 * FRACUNIT) | 0;
    }
    return;
  }

  const angle = ((FINEANGLES / 20) * sim.leveltime) & FINEMASK;
  const bob = FixedMul((player.bob / 2) | 0, finesine[angle]!);

  // move viewheight
  if (player.playerstate === PlayerState.Live) {
    player.viewheight = (player.viewheight + player.deltaviewheight) | 0;
    if (player.viewheight > VIEWHEIGHT) {
      player.viewheight = VIEWHEIGHT;
      player.deltaviewheight = 0;
    }
    if (player.viewheight < VIEWHEIGHT / 2) {
      player.viewheight = VIEWHEIGHT / 2;
      if (player.deltaviewheight <= 0) player.deltaviewheight = 1;
    }
    if (player.deltaviewheight) {
      player.deltaviewheight = (player.deltaviewheight + FRACUNIT / 4) | 0;
      if (!player.deltaviewheight) player.deltaviewheight = 1;
    }
  }
  player.viewz = (mo.z + player.viewheight + bob) | 0;
  if (player.viewz > mo.ceilingz - 4 * FRACUNIT) {
    player.viewz = (mo.ceilingz - 4 * FRACUNIT) | 0;
  }
}

function movePlayer(sim: DoomSim, player: Player): void {
  const cmd = player.cmd;
  const mo = player.mo!;

  mo.angle = (mo.angle + (cmd.angleturn << FRACBITS)) | 0;

  // Freelook (deviation): pitch from ticcmd, clamped. Sum in doubles
  // (exact for these magnitudes): pitch + max cmd delta exceeds int32
  // and would wrap, snapping the view from floor-gaze to ceiling-gaze.
  let np = mo.pitch + cmd.pitch * 65536;
  if (np > MAXPITCH) np = MAXPITCH;
  if (np < -MAXPITCH) np = -MAXPITCH;
  mo.pitch = np | 0;

  // Do not let the player control movement if not onground —
  // except for a small GZDoom-style air control (part of the jump
  // deviation; without it, mantling ledges mid-jump needs frame-perfect
  // running starts because vanilla gives zero mid-air steering).
  player.onground = mo.z <= mo.floorz;

  if (cmd.forwardmove) {
    const move = cmd.forwardmove * 2048;
    thrust(player, mo.angle, player.onground ? move : move >> 4);
  }
  if (cmd.sidemove) {
    const move = cmd.sidemove * 2048;
    thrust(player, (mo.angle - ANG90) | 0, player.onground ? move : move >> 4);
  }

  // Jump (deviation, GZDoom-style).
  if (cmd.buttons2 & BT2_JUMP && player.onground) {
    mo.momz = JUMPSPEED;
  }

  if ((cmd.forwardmove || cmd.sidemove) && mo.stateNum === S.PLAY) {
    sim.setMobjState(mo, S.PLAY_RUN1);
  }
}

function deathThink(sim: DoomSim, player: Player): void {
  const mo = player.mo!;
  // (P_MovePsprites arrives with M4 weapons)
  sim.movePsprites(player);

  // fall to the ground
  if (player.viewheight > 6 * FRACUNIT) player.viewheight = (player.viewheight - FRACUNIT) | 0;
  if (player.viewheight < 6 * FRACUNIT) player.viewheight = 6 * FRACUNIT;
  player.deltaviewheight = 0;
  player.onground = mo.z <= mo.floorz;
  calcHeight(sim, player);

  if (player.attacker && player.attacker !== mo) {
    const angle = pointToAngle2(mo.x, mo.y, player.attacker.x, player.attacker.y);
    const delta = (angle - mo.angle) | 0;
    if (delta >>> 0 < ANG5 >>> 0 || delta >>> 0 > (-ANG5 | 0) >>> 0) {
      // Looking at killer, so fade damage flash down.
      mo.angle = angle;
      if (player.damagecount) player.damagecount--;
    } else if (delta >>> 0 < ANG180 >>> 0) {
      mo.angle = (mo.angle + ANG5) | 0;
    } else {
      mo.angle = (mo.angle - ANG5) | 0;
    }
  } else if (player.damagecount) {
    player.damagecount--;
  }

  if (player.cmd.buttons & BT_USE) player.playerstate = PlayerState.Reborn;
}

export function playerThink(sim: DoomSim, player: Player): void {
  const cmd = player.cmd;
  const mo = player.mo!;

  // chain saw run forward
  if (mo.flags & MF.JUSTATTACKED) {
    cmd.angleturn = 0;
    cmd.forwardmove = 0xc800 / 512;
    cmd.sidemove = 0;
    mo.flags &= ~MF.JUSTATTACKED;
  }

  if (player.playerstate === PlayerState.Dead) {
    deathThink(sim, player);
    return;
  }

  // Reactiontime prevents movement for a bit after a teleport.
  if (mo.reactiontime) mo.reactiontime--;
  else movePlayer(sim, player);

  calcHeight(sim, player);

  if (mo.subsector!.sector.special) {
    sim.playerInSpecialSector(player);
  }

  // Check for weapon change; the psprite machinery applies it when the
  // weapon can (not mid-attack).
  if (cmd.buttons & BT_CHANGE) {
    let newweapon = (cmd.buttons & BT_WEAPONMASK) >> BT_WEAPONSHIFT;

    // DoomCraft: weapon key 8 (mask value 7) selects the block gun.
    if (newweapon === 7) newweapon = Weapon.BlockGun;

    if (
      newweapon === Weapon.Fist &&
      player.weaponowned[Weapon.Chainsaw] &&
      !(player.readyweapon === Weapon.Chainsaw && player.powers[Power.Strength])
    ) {
      newweapon = Weapon.Chainsaw;
    }
    if (
      newweapon === Weapon.Shotgun &&
      player.weaponowned[Weapon.SuperShotgun] &&
      player.readyweapon !== Weapon.SuperShotgun
    ) {
      newweapon = Weapon.SuperShotgun;
    }

    if (player.weaponowned[newweapon] && newweapon !== player.readyweapon) {
      player.pendingweapon = newweapon;
    }
  }

  // check for use
  if (cmd.buttons & BT_USE) {
    if (!player.usedown) {
      sim.useLines(player);
      player.usedown = true;
    }
  } else {
    player.usedown = false;
  }

  // cycle psprites
  sim.movePsprites(player);

  // Counters, time dependent power ups.
  if (player.powers[Power.Strength]) player.powers[Power.Strength]!++;
  if (player.powers[Power.Invulnerability]) player.powers[Power.Invulnerability]!--;
  if (player.powers[Power.Invisibility]) {
    if (!--player.powers[Power.Invisibility]!) mo.flags &= ~MF.SHADOW;
  }
  if (player.powers[Power.Infrared]) player.powers[Power.Infrared]!--;
  if (player.powers[Power.IronFeet]) player.powers[Power.IronFeet]!--;

  if (player.damagecount) player.damagecount--;
  if (player.bonuscount) player.bonuscount--;

  // Handling colormaps (INVERSECOLORMAP = 32).
  if (player.powers[Power.Invulnerability]) {
    if (player.powers[Power.Invulnerability]! > 4 * 32 || player.powers[Power.Invulnerability]! & 8) {
      player.fixedcolormap = 32;
    } else {
      player.fixedcolormap = 0;
    }
  } else if (player.powers[Power.Infrared]) {
    if (player.powers[Power.Infrared]! > 4 * 32 || player.powers[Power.Infrared]! & 8) {
      player.fixedcolormap = 1; // almost full bright
    } else {
      player.fixedcolormap = 0;
    }
  } else {
    player.fixedcolormap = 0;
  }
}
