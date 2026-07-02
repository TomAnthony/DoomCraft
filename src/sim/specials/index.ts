// Wires the p_spec family (lights/plats/doors/ceilings/floors/teleport/
// switches/spec) into a DoomSim's hook points. Call installSpecials(sim)
// once before loadLevel; P_SpawnSpecials resets per-level module state
// (buttonlist, activeplats, activeceilings, scrolling-line list).

import type { DoomSim } from '../sim.ts';
import {
  P_CrossSpecialLine, P_PlayerInSpecialSector, P_ShootSpecialLine,
  P_SpawnSpecials, P_UpdateSpecials,
} from './spec.ts';
import { P_InitSwitchList, P_UseSpecialLine } from './switches.ts';

export { textureHeights } from './floors.ts';

export function installSpecials(sim: DoomSim): void {
  P_InitSwitchList();

  sim.crossSpecialLine = (line, side, thing) => P_CrossSpecialLine(sim, line, side, thing);
  sim.shootSpecialLine = (thing, line) => P_ShootSpecialLine(sim, thing, line);
  sim.useSpecialLine = (thing, line, side) => P_UseSpecialLine(sim, thing, line, side);
  sim.playerInSpecialSector = (player) => P_PlayerInSpecialSector(sim, player);
  sim.updateSpecials = () => P_UpdateSpecials(sim);
  sim.spawnSpecials = () => P_SpawnSpecials(sim);
}
