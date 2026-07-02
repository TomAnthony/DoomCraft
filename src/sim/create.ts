// Factory: a DoomSim with all gameplay modules installed. Pure sim —
// no renderer/audio imports, usable headless (tests, server tools).

import { installBlocks } from '../blocks/index.ts';
import { installAI } from './ai/index.ts';
import { installCombat } from './combat.ts';
import { installInter } from './inter.ts';
import { installWeapons } from './pspr.ts';
import { DoomSim } from './sim.ts';
import { installSpecials } from './specials/index.ts';
import { EV_DoDoor, DoorType } from './specials/doors.ts';
import { EV_DoFloor, FloorType } from './specials/floors.ts';
import { Line } from './world.ts';

export function createGameSim(): DoomSim {
  const sim = new DoomSim();
  installCombat(sim);
  installInter(sim);
  installWeapons(sim);
  installSpecials(sim);
  installAI(sim);
  // blocks must install AFTER AI (it wraps checkSight) and combat
  // (it wraps radiusAttack/explodeMissile)
  installBlocks(sim);

  // A_BossDeath / A_KeenDie floor+door triggers (dummy tagged line, as C).
  const junkLine = (tag: number): Line => {
    const l = new Line(-1);
    l.tag = tag;
    return l;
  };
  sim.bossDeathFloor = (kind, tag) => {
    EV_DoFloor(
      sim, junkLine(tag),
      kind === 'lowerFloorToLowest' ? FloorType.LowerFloorToLowest : FloorType.RaiseToTexture,
    );
  };
  sim.keenDoorOpen = (tag) => {
    EV_DoDoor(sim, junkLine(tag), DoorType.Open);
  };
  return sim;
}
