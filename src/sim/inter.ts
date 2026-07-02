// Damage, death, and pickups, ported from p_inter.c.
// DoomCraft is always a 2-player net co-op game: netgame=true,
// deathmatch=false paths are taken (weapons stay forever, friendly fire on).

import { MF, MT, S, SPR } from './data/info.gen.ts';
import { SFX } from './data/sounds.gen.ts';
import { ONFLOORZ, PlayerState } from './defs.ts';
import { FRACUNIT, FixedMul } from './fixed.ts';
import {
  Ammo, BASETHRESHOLD, BONUSADD, INFRATICS, INVISTICS, INVULNTICS, IRONTICS,
  MAXHEALTH, NUMAMMO, Power, Weapon, clipammo, weaponinfo,
} from './items.ts';
import { pointToAngle2 } from './angles.ts';
import { ANG180, ANGLETOFINESHIFT, finecosine, finesine } from './tables.ts';
import type { DoomSim } from './sim.ts';
import type { Mobj, Player } from './world.ts';

function giveAmmo(sim: DoomSim, player: Player, ammo: number, num: number): boolean {
  if (ammo === Ammo.NoAmmo) return false;
  if (player.ammo[ammo] === player.maxammo[ammo]) return false;

  if (num) num *= clipammo[ammo]!;
  else num = (clipammo[ammo]! / 2) | 0;

  if (sim.gameskill === 0 || sim.gameskill === 4) {
    // give double ammo in trainer mode / nightmare
    num <<= 1;
  }

  const oldammo = player.ammo[ammo]!;
  player.ammo[ammo] = player.ammo[ammo]! + num;
  if (player.ammo[ammo]! > player.maxammo[ammo]!) player.ammo[ammo] = player.maxammo[ammo]!;

  // If non zero ammo, don't change up weapons.
  if (oldammo) return true;

  // We were down to zero, so select a new weapon.
  switch (ammo) {
    case Ammo.Clip:
      if (player.readyweapon === Weapon.Fist) {
        player.pendingweapon = player.weaponowned[Weapon.Chaingun] ? Weapon.Chaingun : Weapon.Pistol;
      }
      break;
    case Ammo.Shell:
      if (player.readyweapon === Weapon.Fist || player.readyweapon === Weapon.Pistol) {
        if (player.weaponowned[Weapon.Shotgun]) player.pendingweapon = Weapon.Shotgun;
      }
      break;
    case Ammo.Cell:
      if (player.readyweapon === Weapon.Fist || player.readyweapon === Weapon.Pistol) {
        if (player.weaponowned[Weapon.Plasma]) player.pendingweapon = Weapon.Plasma;
      }
      break;
    case Ammo.Misl:
      if (player.readyweapon === Weapon.Fist) {
        if (player.weaponowned[Weapon.Missile]) player.pendingweapon = Weapon.Missile;
      }
      break;
  }
  return true;
}

function giveWeapon(sim: DoomSim, player: Player, weapon: number, dropped: boolean): boolean {
  // netgame (non-altdeath) non-dropped: leave placed weapons forever
  if (sim.netgame && !dropped) {
    if (player.weaponowned[weapon]) return false;
    player.bonuscount += BONUSADD;
    player.weaponowned[weapon] = true;
    giveAmmo(sim, player, weaponinfo[weapon]!.ammo, 2); // coop: 2 clips
    player.pendingweapon = weapon;
    sim.startSoundNum(player.mo, SFX.wpnup);
    return false;
  }

  // single-player / dropped weapons: picking up an owned weapon still
  // gives ammo (one clip if dropped, two if placed) and removes it
  let gaveammo = false;
  if (weaponinfo[weapon]!.ammo !== Ammo.NoAmmo) {
    gaveammo = giveAmmo(sim, player, weaponinfo[weapon]!.ammo, dropped ? 1 : 2);
  }
  let gaveweapon = false;
  if (!player.weaponowned[weapon]) {
    gaveweapon = true;
    player.weaponowned[weapon] = true;
    player.pendingweapon = weapon;
  }
  return gaveweapon || gaveammo;
}

function giveBody(player: Player, num: number): boolean {
  if (player.health >= MAXHEALTH) return false;
  player.health += num;
  if (player.health > MAXHEALTH) player.health = MAXHEALTH;
  player.mo!.health = player.health;
  return true;
}

function giveArmor(player: Player, armortype: number): boolean {
  const hits = armortype * 100;
  if (player.armorpoints >= hits) return false; // don't pick up
  player.armortype = armortype;
  player.armorpoints = hits;
  return true;
}

function giveCard(player: Player, card: number): void {
  if (player.cards[card]) return;
  player.bonuscount = BONUSADD;
  player.cards[card] = true;
}

function givePower(player: Player, power: number): boolean {
  if (power === Power.Invulnerability) {
    player.powers[power] = INVULNTICS;
    return true;
  }
  if (power === Power.Invisibility) {
    player.powers[power] = INVISTICS;
    player.mo!.flags |= MF.SHADOW;
    return true;
  }
  if (power === Power.Infrared) {
    player.powers[power] = INFRATICS;
    return true;
  }
  if (power === Power.IronFeet) {
    player.powers[power] = IRONTICS;
    return true;
  }
  if (power === Power.Strength) {
    giveBody(player, 100);
    player.powers[power] = 1;
    return true;
  }
  if (player.powers[power]) return false; // already got it
  player.powers[power] = 1;
  return true;
}

function touchSpecialThing(sim: DoomSim, special: Mobj, toucher: Mobj): void {
  const delta = (special.z - toucher.z) | 0;
  if (delta > toucher.height || delta < -8 * FRACUNIT) return; // out of reach

  let sound: number = SFX.itemup;
  const player = toucher.player!;

  // Dead thing touching (sliding player corpse).
  if (toucher.health <= 0) return;

  switch (special.sprite) {
    // armor
    case SPR.ARM1:
      if (!giveArmor(player, 1)) return;
      player.message = 'Picked up the armor.';
      break;
    case SPR.ARM2:
      if (!giveArmor(player, 2)) return;
      player.message = 'Picked up the MegaArmor!';
      break;

    // bonus items
    case SPR.BON1:
      player.health++; // can go over 100%
      if (player.health > 200) player.health = 200;
      player.mo!.health = player.health;
      player.message = 'Picked up a health bonus.';
      break;
    case SPR.BON2:
      player.armorpoints++; // can go over 100%
      if (player.armorpoints > 200) player.armorpoints = 200;
      if (!player.armortype) player.armortype = 1;
      player.message = 'Picked up an armor bonus.';
      break;
    case SPR.SOUL:
      player.health += 100;
      if (player.health > 200) player.health = 200;
      player.mo!.health = player.health;
      player.message = 'Supercharge!';
      sound = SFX.getpow;
      break;
    case SPR.MEGA:
      player.health = 200;
      player.mo!.health = player.health;
      giveArmor(player, 2);
      player.message = 'MegaSphere!';
      sound = SFX.getpow;
      break;

    // cards — leave cards for everyone (netgame: don't remove)
    case SPR.BKEY:
      giveCard(player, 0);
      if (sim.netgame) return; // leave keys for the other player
      break;
    case SPR.YKEY:
      giveCard(player, 1);
      if (sim.netgame) return; // leave keys for the other player
      break;
    case SPR.RKEY:
      giveCard(player, 2);
      if (sim.netgame) return; // leave keys for the other player
      break;
    case SPR.BSKU:
      giveCard(player, 3);
      if (sim.netgame) return; // leave keys for the other player
      break;
    case SPR.YSKU:
      giveCard(player, 4);
      if (sim.netgame) return; // leave keys for the other player
      break;
    case SPR.RSKU:
      giveCard(player, 5);
      if (sim.netgame) return; // leave keys for the other player
      break;

    // medikits, heals
    case SPR.STIM:
      if (!giveBody(player, 10)) return;
      player.message = 'Picked up a stimpack.';
      break;
    case SPR.MEDI:
      if (!giveBody(player, 25)) return;
      player.message = player.health < 25
        ? 'Picked up a medikit that you REALLY need!'
        : 'Picked up a medikit.';
      break;

    // power ups
    case SPR.PINV:
      if (!givePower(player, Power.Invulnerability)) return;
      sound = SFX.getpow;
      break;
    case SPR.PSTR:
      if (!givePower(player, Power.Strength)) return;
      if (player.readyweapon !== Weapon.Fist) player.pendingweapon = Weapon.Fist;
      sound = SFX.getpow;
      break;
    case SPR.PINS:
      if (!givePower(player, Power.Invisibility)) return;
      sound = SFX.getpow;
      break;
    case SPR.SUIT:
      if (!givePower(player, Power.IronFeet)) return;
      sound = SFX.getpow;
      break;
    case SPR.PMAP:
      if (!givePower(player, Power.AllMap)) return;
      sound = SFX.getpow;
      break;
    case SPR.PVIS:
      if (!givePower(player, Power.Infrared)) return;
      sound = SFX.getpow;
      break;

    // ammo
    case SPR.CLIP:
      if (special.flags & MF.DROPPED) {
        if (!giveAmmo(sim, player, Ammo.Clip, 0)) return;
      } else {
        if (!giveAmmo(sim, player, Ammo.Clip, 1)) return;
      }
      break;
    case SPR.AMMO:
      if (!giveAmmo(sim, player, Ammo.Clip, 5)) return;
      break;
    case SPR.ROCK:
      if (!giveAmmo(sim, player, Ammo.Misl, 1)) return;
      break;
    case SPR.BROK:
      if (!giveAmmo(sim, player, Ammo.Misl, 5)) return;
      break;
    case SPR.CELL:
      if (!giveAmmo(sim, player, Ammo.Cell, 1)) return;
      break;
    case SPR.CELP:
      if (!giveAmmo(sim, player, Ammo.Cell, 5)) return;
      break;
    case SPR.SHEL:
      if (!giveAmmo(sim, player, Ammo.Shell, 1)) return;
      break;
    case SPR.SBOX:
      if (!giveAmmo(sim, player, Ammo.Shell, 5)) return;
      break;
    case SPR.BPAK:
      if (!player.backpack) {
        for (let i = 0; i < NUMAMMO; i++) player.maxammo[i] = player.maxammo[i]! * 2;
        player.backpack = true;
      }
      for (let i = 0; i < NUMAMMO; i++) giveAmmo(sim, player, i, 1);
      break;

    // weapons
    case SPR.BFUG:
      if (!giveWeapon(sim, player, Weapon.Bfg, false)) return;
      sound = SFX.wpnup;
      break;
    case SPR.MGUN:
      if (!giveWeapon(sim, player, Weapon.Chaingun, (special.flags & MF.DROPPED) !== 0)) return;
      sound = SFX.wpnup;
      break;
    case SPR.CSAW:
      if (!giveWeapon(sim, player, Weapon.Chainsaw, false)) return;
      sound = SFX.wpnup;
      break;
    case SPR.LAUN:
      if (!giveWeapon(sim, player, Weapon.Missile, false)) return;
      sound = SFX.wpnup;
      break;
    case SPR.PLAS:
      if (!giveWeapon(sim, player, Weapon.Plasma, false)) return;
      sound = SFX.wpnup;
      break;
    case SPR.SHOT:
      if (!giveWeapon(sim, player, Weapon.Shotgun, (special.flags & MF.DROPPED) !== 0)) return;
      sound = SFX.wpnup;
      break;
    case SPR.SGN2:
      if (!giveWeapon(sim, player, Weapon.SuperShotgun, (special.flags & MF.DROPPED) !== 0)) return;
      sound = SFX.wpnup;
      break;

    default:
      throw new Error('P_SpecialThing: Unknown gettable thing');
  }

  if (special.flags & MF.COUNTITEM) player.itemcount++;
  sim.removeMobj(special);
  player.bonuscount += BONUSADD;
  sim.startSoundNum(player.mo, sound);
}

function killMobj(sim: DoomSim, source: Mobj | null, target: Mobj): void {
  target.flags &= ~(MF.SHOOTABLE | MF.FLOAT | MF.SKULLFLY);
  if (target.type !== MT.SKULL) target.flags &= ~MF.NOGRAVITY;
  target.flags |= MF.CORPSE | MF.DROPOFF;
  target.height >>= 2;

  if (source && source.player) {
    // count for intermission
    if (target.flags & MF.COUNTKILL) source.player.killcount++;
    if (target.player) {
      source.player.frags[target.player.index] = source.player.frags[target.player.index]! + 1;
    }
  }
  // (netgame: no "count all monster deaths to player 0" branch)

  if (target.player) {
    // count environment kills against you
    if (!source) {
      target.player.frags[target.player.index] = target.player.frags[target.player.index]! + 1;
    }
    target.flags &= ~MF.SOLID;
    target.player.playerstate = PlayerState.Dead;
    dropWeaponHook(sim, target.player);
  }

  if (target.health < -target.info.spawnhealth && target.info.xdeathstate) {
    sim.setMobjState(target, target.info.xdeathstate);
  } else {
    sim.setMobjState(target, target.info.deathstate);
  }
  target.tics -= sim.rng.pRandom() & 3;
  if (target.tics < 1) target.tics = 1;

  // Drop stuff.
  let item: number;
  switch (target.type) {
    case MT.WOLFSS:
    case MT.POSSESSED:
      item = MT.CLIP;
      break;
    case MT.SHOTGUY:
      item = MT.SHOTGUN;
      break;
    case MT.CHAINGUY:
      item = MT.CHAINGUN;
      break;
    default:
      return;
  }
  const mo = sim.spawnMobj(target.x, target.y, ONFLOORZ, item);
  mo.flags |= MF.DROPPED; // special versions of items
}

// P_DropWeapon lives in pspr.ts; injected to avoid a circular import.
let dropWeaponHook: (sim: DoomSim, player: Player) => void = () => {};
export function setDropWeapon(fn: (sim: DoomSim, player: Player) => void): void {
  dropWeaponHook = fn;
}

function damageMobj(
  sim: DoomSim,
  target: Mobj,
  inflictor: Mobj | null,
  source: Mobj | null,
  damage: number,
): void {
  if (!(target.flags & MF.SHOOTABLE)) return; // shouldn't happen...
  if (target.health <= 0) return;

  if (target.flags & MF.SKULLFLY) {
    target.momx = target.momy = target.momz = 0;
  }

  const player = target.player;
  if (player && sim.gameskill === 0) damage >>= 1; // half damage in trainer mode

  // Kick away unless using the chainsaw.
  if (
    inflictor &&
    !(target.flags & MF.NOCLIP) &&
    (!source || !source.player || source.player.readyweapon !== Weapon.Chainsaw)
  ) {
    let ang = pointToAngle2(inflictor.x, inflictor.y, target.x, target.y);
    let thrust = ((damage * (FRACUNIT >> 3) * 100) / target.info.mass) | 0;

    // make fall forwards sometimes
    if (
      damage < 40 && damage > target.health &&
      target.z - inflictor.z > 64 * FRACUNIT &&
      sim.rng.pRandom() & 1
    ) {
      ang = (ang + ANG180) | 0;
      thrust = (thrust * 4) | 0;
    }

    const fine = ang >>> ANGLETOFINESHIFT;
    target.momx = (target.momx + FixedMul(thrust, finecosine(fine))) | 0;
    target.momy = (target.momy + FixedMul(thrust, finesine[fine]!)) | 0;
  }

  // player specific
  if (player) {
    // end of game hell hack
    if (target.subsector!.sector.special === 11 && damage >= target.health) {
      damage = target.health - 1;
    }
    // Below certain threshold, ignore damage with INVUL power.
    if (damage < 1000 && player.powers[Power.Invulnerability]) {
      return;
    }
    if (player.armortype) {
      let saved = player.armortype === 1 ? ((damage / 3) | 0) : ((damage / 2) | 0);
      if (player.armorpoints <= saved) {
        // armor is used up
        saved = player.armorpoints;
        player.armortype = 0;
      }
      player.armorpoints -= saved;
      damage -= saved;
    }
    player.health -= damage;
    if (player.health < 0) player.health = 0;
    player.attacker = source;
    player.damagecount += damage;
    if (player.damagecount > 100) player.damagecount = 100; // teleport stomp does 10k
  }

  // do the damage
  target.health -= damage;
  if (target.health <= 0) {
    killMobj(sim, source, target);
    return;
  }

  if (sim.rng.pRandom() < target.info.painchance && !(target.flags & MF.SKULLFLY)) {
    target.flags |= MF.JUSTHIT; // fight back!
    sim.setMobjState(target, target.info.painstate);
  }

  target.reactiontime = 0; // we're awake now...

  if (
    (!target.threshold || target.type === MT.VILE) &&
    source && source !== target &&
    source.type !== MT.VILE
  ) {
    // if not intent on another player, chase after this one
    target.target = source;
    target.threshold = BASETHRESHOLD;
    if (target.stateNum === target.info.spawnstate && target.info.seestate !== S.NULL) {
      sim.setMobjState(target, target.info.seestate);
    }
  }
}

export function installInter(sim: DoomSim): void {
  sim.damageMobj = (target, inflictor, source, damage) =>
    damageMobj(sim, target, inflictor, source, damage);
  sim.touchSpecialThing = (special, toucher) => touchSpecialThing(sim, special, toucher);
}
