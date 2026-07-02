// FNV-1a state checksum — the multiplayer desync canary. Hashes RNG
// cursors, players, and every mobj in thinker order plus sector heights.

import type { DoomSim } from './sim.ts';

export function fnv1a(hash: number, value: number): number {
  // fold 32-bit value in as 4 bytes
  for (let i = 0; i < 4; i++) {
    hash ^= (value >>> (i * 8)) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function simChecksum(sim: DoomSim): number {
  let h = 0x811c9dc5;
  h = fnv1a(h, sim.leveltime);
  h = fnv1a(h, sim.rng.prndindex);

  for (const p of sim.players) {
    if (!p.mo) continue;
    h = fnv1a(h, p.mo.x);
    h = fnv1a(h, p.mo.y);
    h = fnv1a(h, p.mo.z);
    h = fnv1a(h, p.mo.angle);
    h = fnv1a(h, p.mo.pitch);
    h = fnv1a(h, p.mo.momx);
    h = fnv1a(h, p.mo.momy);
    h = fnv1a(h, p.mo.momz);
    h = fnv1a(h, p.health);
    h = fnv1a(h, p.viewz);
  }

  for (const m of sim.mobjs()) {
    h = fnv1a(h, m.type);
    h = fnv1a(h, m.x);
    h = fnv1a(h, m.y);
    h = fnv1a(h, m.z);
    h = fnv1a(h, m.stateNum);
    h = fnv1a(h, m.health);
  }

  for (const s of sim.world.sectors) {
    h = fnv1a(h, s.floorheight);
    h = fnv1a(h, s.ceilingheight);
  }
  return h;
}
