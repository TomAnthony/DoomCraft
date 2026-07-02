// Weapon overlay sprites and weapon actions, ported from p_pspr.c (plus
// the super-shotgun sound actions that live at the end of p_enemy.c).
//
// Psprite states reuse the shared states table; their actions dispatch
// through this module's table keyed by C action name.
//
// Freelook deviation: P_BulletSlope falls back to the view-pitch slope
// (vanilla: 0) when autoaim finds no target.

import { MF, MT, S } from './data/info.gen.ts';
import { SFX } from './data/sounds.gen.ts';
import { BT_ATTACK, MELEERANGE, MISSILERANGE, PlayerState } from './defs.ts';
import { FRACUNIT, FixedMul, type Fixed } from './fixed.ts';
import { Ammo, BFGCELLS, NUMAMMO, Power, Weapon, weaponinfo } from './items.ts';
import { pitchSlope } from './combat.ts';
import { pointToAngle2 } from './angles.ts';
import {
  ANG90, ANG180, ANGLETOFINESHIFT, FINEANGLES, FINEMASK, finecosine, finesine,
} from './tables.ts';
import type { DoomSim } from './sim.ts';
import { setDropWeapon } from './inter.ts';
import type { Mobj, Player, PspDef } from './world.ts';

const LOWERSPEED = FRACUNIT * 6;
const RAISESPEED = FRACUNIT * 6;
const WEAPONBOTTOM = 128 * FRACUNIT;
const WEAPONTOP = 32 * FRACUNIT;

export const PS_WEAPON = 0;
export const PS_FLASH = 1;

type PspAction = (sim: DoomSim, player: Player, psp: PspDef) => void;

const pspActions = new Map<string, PspAction>();

function setPsprite(sim: DoomSim, player: Player, position: number, stnum: number): void {
  const psp = player.psprites[position]!;
  do {
    if (!stnum) {
      psp.stateNum = 0; // object removed itself
      break;
    }
    const st = sim.stateTable[stnum]!;
    psp.stateNum = stnum;
    psp.tics = st[2]; // could be 0

    if (st[5]) {
      // coordinate set
      psp.sx = st[5] << 16;
      psp.sy = st[6] << 16;
    }

    // Call action routine.
    const action = st[3];
    if (action) {
      const fn = pspActions.get(action);
      if (fn) fn(sim, player, psp);
      if (!psp.stateNum) break;
    }
    stnum = sim.stateTable[psp.stateNum]![4];
  } while (!psp.tics);
}

function bringUpWeapon(sim: DoomSim, player: Player): void {
  if (player.pendingweapon === Weapon.NoChange) player.pendingweapon = player.readyweapon;
  if (player.pendingweapon === Weapon.Chainsaw) sim.startSoundNum(player.mo, SFX.sawup);

  const newstate = weaponinfo[player.pendingweapon]!.upstate;
  player.pendingweapon = Weapon.NoChange;
  player.psprites[PS_WEAPON]!.sy = WEAPONBOTTOM;
  setPsprite(sim, player, PS_WEAPON, newstate);
}

function checkAmmo(sim: DoomSim, player: Player): boolean {
  const ammo = weaponinfo[player.readyweapon]!.ammo;

  // Minimal amount for one shot varies.
  let count = 1;
  if (player.readyweapon === Weapon.Bfg) count = BFGCELLS;
  else if (player.readyweapon === Weapon.SuperShotgun) count = 2;

  if (ammo === Ammo.NoAmmo || player.ammo[ammo]! >= count) return true;

  // Out of ammo, pick a weapon to change to (vanilla preferences).
  do {
    if (player.weaponowned[Weapon.Plasma] && player.ammo[Ammo.Cell]) {
      player.pendingweapon = Weapon.Plasma;
    } else if (player.weaponowned[Weapon.SuperShotgun] && player.ammo[Ammo.Shell]! > 2) {
      player.pendingweapon = Weapon.SuperShotgun;
    } else if (player.weaponowned[Weapon.Chaingun] && player.ammo[Ammo.Clip]) {
      player.pendingweapon = Weapon.Chaingun;
    } else if (player.weaponowned[Weapon.Shotgun] && player.ammo[Ammo.Shell]) {
      player.pendingweapon = Weapon.Shotgun;
    } else if (player.ammo[Ammo.Clip]) {
      player.pendingweapon = Weapon.Pistol;
    } else if (player.weaponowned[Weapon.Chainsaw]) {
      player.pendingweapon = Weapon.Chainsaw;
    } else if (player.weaponowned[Weapon.Missile] && player.ammo[Ammo.Misl]) {
      player.pendingweapon = Weapon.Missile;
    } else if (player.weaponowned[Weapon.Bfg] && player.ammo[Ammo.Cell]! > 40) {
      player.pendingweapon = Weapon.Bfg;
    } else {
      player.pendingweapon = Weapon.Fist; // if everything fails
    }
  } while (player.pendingweapon === Weapon.NoChange);

  setPsprite(sim, player, PS_WEAPON, weaponinfo[player.readyweapon]!.downstate);
  return false;
}

function fireWeapon(sim: DoomSim, player: Player): void {
  if (!checkAmmo(sim, player)) return;
  sim.setMobjState(player.mo!, S.PLAY_ATK1);
  setPsprite(sim, player, PS_WEAPON, weaponinfo[player.readyweapon]!.atkstate);
  sim.noiseAlert(player.mo!, player.mo!);
}

function dropWeapon(sim: DoomSim, player: Player): void {
  setPsprite(sim, player, PS_WEAPON, weaponinfo[player.readyweapon]!.downstate);
}

function decreaseAmmo(player: Player, ammonum: number, amount: number): void {
  if (ammonum < NUMAMMO) player.ammo[ammonum] = player.ammo[ammonum]! - amount;
  else player.maxammo[ammonum - NUMAMMO] = player.maxammo[ammonum - NUMAMMO]! - amount;
}

// --- psprite state actions ------------------------------------------------

pspActions.set('A_WeaponReady', (sim, player, psp) => {
  // get out of attack state
  if (player.mo!.stateNum === S.PLAY_ATK1 || player.mo!.stateNum === S.PLAY_ATK2) {
    sim.setMobjState(player.mo!, S.PLAY);
  }
  if (player.readyweapon === Weapon.Chainsaw && psp.stateNum === S.SAW) {
    sim.startSoundNum(player.mo, SFX.sawidl);
  }

  // check for change; if player is dead, put the weapon away
  if (player.pendingweapon !== Weapon.NoChange || !player.health) {
    setPsprite(sim, player, PS_WEAPON, weaponinfo[player.readyweapon]!.downstate);
    return;
  }

  // check for fire: the missile launcher and bfg do not auto fire
  if (player.cmd.buttons & BT_ATTACK) {
    if (
      !player.attackdown ||
      (player.readyweapon !== Weapon.Missile && player.readyweapon !== Weapon.Bfg)
    ) {
      player.attackdown = true;
      fireWeapon(sim, player);
      return;
    }
  } else {
    player.attackdown = false;
  }

  // bob the weapon based on movement speed
  let angle = (128 * sim.leveltime) & FINEMASK;
  psp.sx = (FRACUNIT + FixedMul(player.bob, finecosine(angle))) | 0;
  angle &= FINEANGLES / 2 - 1;
  psp.sy = (WEAPONTOP + FixedMul(player.bob, finesine[angle]!)) | 0;
});

pspActions.set('A_ReFire', (sim, player) => {
  // (if a weaponchange is pending, let it go through instead)
  if (
    player.cmd.buttons & BT_ATTACK &&
    player.pendingweapon === Weapon.NoChange &&
    player.health
  ) {
    player.refire++;
    fireWeapon(sim, player);
  } else {
    player.refire = 0;
    checkAmmo(sim, player);
  }
});

pspActions.set('A_CheckReload', (sim, player) => {
  checkAmmo(sim, player);
});

pspActions.set('A_Lower', (sim, player, psp) => {
  psp.sy = (psp.sy + LOWERSPEED) | 0;
  if (psp.sy < WEAPONBOTTOM) return; // not yet down

  if (player.playerstate === PlayerState.Dead) {
    psp.sy = WEAPONBOTTOM;
    return; // don't bring weapon back up
  }
  if (!player.health) {
    // Player is dead, so keep the weapon off screen.
    setPsprite(sim, player, PS_WEAPON, S.NULL);
    return;
  }
  player.readyweapon = player.pendingweapon;
  bringUpWeapon(sim, player);
});

pspActions.set('A_Raise', (sim, player, psp) => {
  psp.sy = (psp.sy - RAISESPEED) | 0;
  if (psp.sy > WEAPONTOP) return;
  psp.sy = WEAPONTOP;
  setPsprite(sim, player, PS_WEAPON, weaponinfo[player.readyweapon]!.readystate);
});

pspActions.set('A_GunFlash', (sim, player) => {
  sim.setMobjState(player.mo!, S.PLAY_ATK2);
  setPsprite(sim, player, PS_FLASH, weaponinfo[player.readyweapon]!.flashstate);
});

// --- weapon attacks ---------------------------------------------------------

pspActions.set('A_Punch', (sim, player) => {
  let damage = ((sim.rng.pRandom() % 10) + 1) << 1;
  if (player.powers[Power.Strength]) damage *= 10;

  let angle = player.mo!.angle;
  angle = (angle + (sim.rng.pSubRandom() << 18)) | 0;
  const slope = sim.aimLineAttack(player.mo!, angle, MELEERANGE);
  sim.lineAttack(player.mo!, angle, MELEERANGE, slope, damage);

  // turn to face target
  if (sim.linetarget) {
    sim.startSoundNum(player.mo, SFX.punch);
    player.mo!.angle = pointToAngle2(
      player.mo!.x, player.mo!.y, sim.linetarget.x, sim.linetarget.y,
    );
  }
});

pspActions.set('A_Saw', (sim, player) => {
  const damage = 2 * ((sim.rng.pRandom() % 10) + 1);
  let angle = player.mo!.angle;
  angle = (angle + (sim.rng.pSubRandom() << 18)) | 0;

  // use meleerange + 1 so the puff doesn't skip the flash
  const slope = sim.aimLineAttack(player.mo!, angle, MELEERANGE + 1);
  sim.lineAttack(player.mo!, angle, MELEERANGE + 1, slope, damage);

  if (!sim.linetarget) {
    sim.startSoundNum(player.mo, SFX.sawful);
    return;
  }
  sim.startSoundNum(player.mo, SFX.sawhit);

  // turn to face target
  angle = pointToAngle2(player.mo!.x, player.mo!.y, sim.linetarget.x, sim.linetarget.y);
  const mo = player.mo!;
  if ((angle - mo.angle) >>> 0 > ANG180 >>> 0) {
    if (((angle - mo.angle) | 0) < ((-ANG90 / 20) | 0)) {
      mo.angle = (angle + ((ANG90 / 21) | 0)) | 0;
    } else {
      mo.angle = (mo.angle - ((ANG90 / 20) | 0)) | 0;
    }
  } else {
    if ((angle - mo.angle) >>> 0 > ((ANG90 / 20) | 0) >>> 0) {
      mo.angle = (angle - ((ANG90 / 21) | 0)) | 0;
    } else {
      mo.angle = (mo.angle + ((ANG90 / 20) | 0)) | 0;
    }
  }
  mo.flags |= MF.JUSTATTACKED;
});

pspActions.set('A_FireMissile', (sim, player) => {
  decreaseAmmo(player, weaponinfo[player.readyweapon]!.ammo, 1);
  sim.spawnPlayerMissile(player.mo!, MT.ROCKET);
});

pspActions.set('A_FireBFG', (sim, player) => {
  decreaseAmmo(player, weaponinfo[player.readyweapon]!.ammo, BFGCELLS);
  sim.spawnPlayerMissile(player.mo!, MT.BFG);
});

pspActions.set('A_FirePlasma', (sim, player) => {
  decreaseAmmo(player, weaponinfo[player.readyweapon]!.ammo, 1);
  setPsprite(
    sim, player, PS_FLASH,
    weaponinfo[player.readyweapon]!.flashstate + (sim.rng.pRandom() & 1),
  );
  sim.spawnPlayerMissile(player.mo!, MT.PLASMA);
});

// P_BulletSlope: near misses land at approximately the target height.
let bulletslope: Fixed = 0;

function bulletSlope(sim: DoomSim, mo: Mobj): void {
  let an = mo.angle;
  bulletslope = sim.aimLineAttack(mo, an, 16 * 64 * FRACUNIT);
  if (!sim.linetarget) {
    an = (an + (1 << 26)) | 0;
    bulletslope = sim.aimLineAttack(mo, an, 16 * 64 * FRACUNIT);
    if (!sim.linetarget) {
      an = (an - (2 << 26)) | 0;
      bulletslope = sim.aimLineAttack(mo, an, 16 * 64 * FRACUNIT);
    }
    if (!sim.linetarget) {
      // Freelook deviation: vanilla leaves bulletslope = 0 here.
      bulletslope = pitchSlope(mo.pitch);
    }
  }
}

function gunShot(sim: DoomSim, mo: Mobj, accurate: boolean): void {
  const damage = 5 * ((sim.rng.pRandom() % 3) + 1);
  let angle = mo.angle;
  if (!accurate) angle = (angle + (sim.rng.pSubRandom() << 18)) | 0;
  sim.lineAttack(mo, angle, MISSILERANGE, bulletslope, damage);
}

pspActions.set('A_FirePistol', (sim, player) => {
  sim.startSoundNum(player.mo, SFX.pistol);
  sim.setMobjState(player.mo!, S.PLAY_ATK2);
  decreaseAmmo(player, weaponinfo[player.readyweapon]!.ammo, 1);
  setPsprite(sim, player, PS_FLASH, weaponinfo[player.readyweapon]!.flashstate);
  bulletSlope(sim, player.mo!);
  gunShot(sim, player.mo!, !player.refire);
});

pspActions.set('A_FireShotgun', (sim, player) => {
  sim.startSoundNum(player.mo, SFX.shotgn);
  sim.setMobjState(player.mo!, S.PLAY_ATK2);
  decreaseAmmo(player, weaponinfo[player.readyweapon]!.ammo, 1);
  setPsprite(sim, player, PS_FLASH, weaponinfo[player.readyweapon]!.flashstate);
  bulletSlope(sim, player.mo!);
  for (let i = 0; i < 7; i++) gunShot(sim, player.mo!, false);
});

pspActions.set('A_FireShotgun2', (sim, player) => {
  sim.startSoundNum(player.mo, SFX.dshtgn);
  sim.setMobjState(player.mo!, S.PLAY_ATK2);
  decreaseAmmo(player, weaponinfo[player.readyweapon]!.ammo, 2);
  setPsprite(sim, player, PS_FLASH, weaponinfo[player.readyweapon]!.flashstate);
  bulletSlope(sim, player.mo!);

  for (let i = 0; i < 20; i++) {
    const damage = 5 * ((sim.rng.pRandom() % 3) + 1);
    let angle = player.mo!.angle;
    angle = (angle + (sim.rng.pSubRandom() << ANGLETOFINESHIFT)) | 0;
    sim.lineAttack(
      player.mo!, angle, MISSILERANGE,
      (bulletslope + (sim.rng.pSubRandom() << 5)) | 0, damage,
    );
  }
});

pspActions.set('A_FireCGun', (sim, player, psp) => {
  sim.startSoundNum(player.mo, SFX.pistol);
  if (!player.ammo[weaponinfo[player.readyweapon]!.ammo]) return;

  sim.setMobjState(player.mo!, S.PLAY_ATK2);
  decreaseAmmo(player, weaponinfo[player.readyweapon]!.ammo, 1);
  setPsprite(
    sim, player, PS_FLASH,
    weaponinfo[player.readyweapon]!.flashstate + psp.stateNum - S.CHAIN1,
  );
  bulletSlope(sim, player.mo!);
  gunShot(sim, player.mo!, !player.refire);
});

pspActions.set('A_Light0', (_sim, player) => {
  player.extralight = 0;
});
pspActions.set('A_Light1', (_sim, player) => {
  player.extralight = 1;
});
pspActions.set('A_Light2', (_sim, player) => {
  player.extralight = 2;
});

pspActions.set('A_BFGsound', (sim, player) => {
  sim.startSoundNum(player.mo, SFX.bfg);
});

// Super-shotgun sound actions (from the end of p_enemy.c).
pspActions.set('A_OpenShotgun2', (sim, player) => {
  sim.startSoundNum(player.mo, SFX.dbopn);
});
pspActions.set('A_LoadShotgun2', (sim, player) => {
  sim.startSoundNum(player.mo, SFX.dbload);
});
pspActions.set('A_CloseShotgun2', (sim, player, psp) => {
  sim.startSoundNum(player.mo, SFX.dbcls);
  pspActions.get('A_ReFire')!(sim, player, psp);
});

// A_BFGSpray is a MOBJ action (the BFG ball's explosion), registered
// into sim.actions by installWeapons.
function bfgSpray(sim: DoomSim, mo: Mobj): void {
  // offset angles from its attack angle
  for (let i = 0; i < 40; i++) {
    const an = (mo.angle - ANG90 / 2 + (ANG90 / 40) * i) | 0;

    // mo.target is the originator (player) of the missile
    sim.aimLineAttack(mo.target!, an, 16 * 64 * FRACUNIT);
    if (!sim.linetarget) continue;

    sim.spawnMobj(
      sim.linetarget.x, sim.linetarget.y,
      (sim.linetarget.z + (sim.linetarget.height >> 2)) | 0,
      MT.EXTRABFG,
    );

    let damage = 0;
    for (let j = 0; j < 15; j++) damage += (sim.rng.pRandom() & 7) + 1;
    sim.damageMobj(sim.linetarget, mo.target, mo.target, damage);
  }
}

// --- per-tic driver ------------------------------------------------------------

function setupPsprites(sim: DoomSim, player: Player): void {
  // remove all psprites
  for (const psp of player.psprites) psp.stateNum = 0;
  // spawn the gun
  player.pendingweapon = player.readyweapon;
  bringUpWeapon(sim, player);
}

function movePsprites(sim: DoomSim, player: Player): void {
  for (let i = 0; i < player.psprites.length; i++) {
    const psp = player.psprites[i]!;
    // a null state means not active
    if (psp.stateNum) {
      // a -1 tic count never changes
      if (psp.tics !== -1) {
        psp.tics--;
        if (!psp.tics) setPsprite(sim, player, i, sim.stateTable[psp.stateNum]![4]);
      }
    }
  }
  player.psprites[PS_FLASH]!.sx = player.psprites[PS_WEAPON]!.sx;
  player.psprites[PS_FLASH]!.sy = player.psprites[PS_WEAPON]!.sy;
}

export function installWeapons(sim: DoomSim): void {
  sim.setupPsprites = (player) => setupPsprites(sim, player);
  sim.movePsprites = (player) => movePsprites(sim, player);
  sim.actions.set('A_BFGSpray', (s, mo) => bfgSpray(s, mo));
  setDropWeapon((s, player) => dropWeapon(s, player));
}
