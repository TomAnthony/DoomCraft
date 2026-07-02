// Weapon/ammo/power definitions, ported from doomdef.h + d_items.c.

import { S } from './data/info.gen.ts';

export const enum Weapon {
  Fist = 0,
  Pistol = 1,
  Shotgun = 2,
  Chaingun = 3,
  Missile = 4,
  Plasma = 5,
  Bfg = 6,
  Chainsaw = 7,
  SuperShotgun = 8,
  NoChange = 9,
}
export const NUMWEAPONS = 9;

export const enum Ammo {
  Clip = 0,
  Shell = 1,
  Cell = 2,
  Misl = 3,
  NoAmmo = 5,
}
export const NUMAMMO = 4;

export const enum Power {
  Invulnerability = 0,
  Strength = 1,
  Invisibility = 2,
  IronFeet = 3,
  AllMap = 4,
  Infrared = 5,
}
export const NUMPOWERS = 6;

export const INVULNTICS = 30 * 35;
export const INVISTICS = 60 * 35;
export const INFRATICS = 120 * 35;
export const IRONTICS = 60 * 35;

export const MAXHEALTH = 100;
export const BONUSADD = 6;
export const BASETHRESHOLD = 100;
export const BFGCELLS = 40;

export const maxammo: readonly number[] = [200, 50, 300, 50];
export const clipammo: readonly number[] = [10, 4, 20, 1];

export interface WeaponInfo {
  readonly ammo: number;
  readonly upstate: number;
  readonly downstate: number;
  readonly readystate: number;
  readonly atkstate: number;
  readonly flashstate: number;
}

export const weaponinfo: readonly WeaponInfo[] = [
  { ammo: Ammo.NoAmmo, upstate: S.PUNCHUP, downstate: S.PUNCHDOWN, readystate: S.PUNCH, atkstate: S.PUNCH1, flashstate: S.NULL },
  { ammo: Ammo.Clip, upstate: S.PISTOLUP, downstate: S.PISTOLDOWN, readystate: S.PISTOL, atkstate: S.PISTOL1, flashstate: S.PISTOLFLASH },
  { ammo: Ammo.Shell, upstate: S.SGUNUP, downstate: S.SGUNDOWN, readystate: S.SGUN, atkstate: S.SGUN1, flashstate: S.SGUNFLASH1 },
  { ammo: Ammo.Clip, upstate: S.CHAINUP, downstate: S.CHAINDOWN, readystate: S.CHAIN, atkstate: S.CHAIN1, flashstate: S.CHAINFLASH1 },
  { ammo: Ammo.Misl, upstate: S.MISSILEUP, downstate: S.MISSILEDOWN, readystate: S.MISSILE, atkstate: S.MISSILE1, flashstate: S.MISSILEFLASH1 },
  { ammo: Ammo.Cell, upstate: S.PLASMAUP, downstate: S.PLASMADOWN, readystate: S.PLASMA, atkstate: S.PLASMA1, flashstate: S.PLASMAFLASH1 },
  { ammo: Ammo.Cell, upstate: S.BFGUP, downstate: S.BFGDOWN, readystate: S.BFG, atkstate: S.BFG1, flashstate: S.BFGFLASH1 },
  { ammo: Ammo.NoAmmo, upstate: S.SAWUP, downstate: S.SAWDOWN, readystate: S.SAW, atkstate: S.SAW1, flashstate: S.NULL },
  { ammo: Ammo.Shell, upstate: S.DSGUNUP, downstate: S.DSGUNDOWN, readystate: S.DSGUN, atkstate: S.DSGUN1, flashstate: S.DSGUNFLASH1 },
];
