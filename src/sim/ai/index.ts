// AI module install: wires p_sight.c (Sight) and p_enemy.c (Enemy) into
// a DoomSim. All mutable state is held per sim instance — two sims can
// coexist in tests without sharing anything.

import type { DoomSim } from '../sim.ts';
import type { Mobj } from '../world.ts';
import { Enemy } from './enemy.ts';
import { Sight } from './sight.ts';

export { Enemy } from './enemy.ts';
export type { BossDeathFloorFn, KeenDoorOpenFn, SpawnPuffFn } from './enemy.ts';
export { Sight, divlineSide } from './sight.ts';

export function installAI(sim: DoomSim): void {
  const sight = new Sight(sim);
  sim.checkSight = (t1, t2) => sight.checkSight(t1, t2);

  const enemy = new Enemy(sim, sight);

  // P_NoiseAlert for the weapons/combat module (P_FireWeapon etc.).
  (sim as unknown as { noiseAlert?: (target: Mobj, emitter: Mobj) => void }).noiseAlert = (
    target,
    emitter,
  ) => enemy.noiseAlert(target, emitter);

  const a = (name: string, fn: (actor: Mobj) => void): void => {
    sim.actions.set(name, (_sim, mobj) => fn(mobj));
  };

  a('A_Look', (m) => enemy.look(m));
  a('A_Chase', (m) => enemy.chase(m));
  a('A_FaceTarget', (m) => enemy.faceTarget(m));
  a('A_PosAttack', (m) => enemy.posAttack(m));
  a('A_SPosAttack', (m) => enemy.sPosAttack(m));
  a('A_CPosAttack', (m) => enemy.cPosAttack(m));
  a('A_CPosRefire', (m) => enemy.cPosRefire(m));
  a('A_SpidRefire', (m) => enemy.spidRefire(m));
  a('A_BspiAttack', (m) => enemy.bspiAttack(m));
  a('A_TroopAttack', (m) => enemy.troopAttack(m));
  a('A_SargAttack', (m) => enemy.sargAttack(m));
  a('A_HeadAttack', (m) => enemy.headAttack(m));
  a('A_CyberAttack', (m) => enemy.cyberAttack(m));
  a('A_BruisAttack', (m) => enemy.bruisAttack(m));
  a('A_SkelMissile', (m) => enemy.skelMissile(m));
  a('A_Tracer', (m) => enemy.tracer(m));
  a('A_SkelWhoosh', (m) => enemy.skelWhoosh(m));
  a('A_SkelFist', (m) => enemy.skelFist(m));
  a('A_VileChase', (m) => enemy.vileChase(m));
  a('A_VileStart', (m) => enemy.vileStart(m));
  a('A_StartFire', (m) => enemy.startFire(m));
  a('A_FireCrackle', (m) => enemy.fireCrackle(m));
  a('A_Fire', (m) => enemy.fire(m));
  a('A_VileTarget', (m) => enemy.vileTarget(m));
  a('A_VileAttack', (m) => enemy.vileAttack(m));
  a('A_FatRaise', (m) => enemy.fatRaise(m));
  a('A_FatAttack1', (m) => enemy.fatAttack1(m));
  a('A_FatAttack2', (m) => enemy.fatAttack2(m));
  a('A_FatAttack3', (m) => enemy.fatAttack3(m));
  a('A_SkullAttack', (m) => enemy.skullAttack(m));
  a('A_PainAttack', (m) => enemy.painAttack(m));
  a('A_PainDie', (m) => enemy.painDie(m));
  a('A_Scream', (m) => enemy.scream(m));
  a('A_XScream', (m) => enemy.xScream(m));
  a('A_Pain', (m) => enemy.pain(m));
  a('A_Fall', (m) => enemy.fall(m));
  a('A_Explode', (m) => enemy.explode(m));
  a('A_BossDeath', (m) => enemy.bossDeath(m));
  a('A_KeenDie', (m) => enemy.keenDie(m));
  a('A_Hoof', (m) => enemy.hoof(m));
  a('A_Metal', (m) => enemy.metal(m));
  a('A_BabyMetal', (m) => enemy.babyMetal(m));
  a('A_BrainAwake', (m) => enemy.brainAwake(m));
  a('A_BrainPain', (m) => enemy.brainPain(m));
  a('A_BrainScream', (m) => enemy.brainScream(m));
  a('A_BrainExplode', (m) => enemy.brainExplode(m));
  a('A_BrainDie', (m) => enemy.brainDie(m));
  a('A_BrainSpit', (m) => enemy.brainSpit(m));
  a('A_SpawnSound', (m) => enemy.spawnSound(m));
  a('A_SpawnFly', (m) => enemy.spawnFly(m));
  a('A_PlayerScream', (m) => enemy.playerScream(m));
}
