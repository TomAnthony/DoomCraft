// Player movement physics + determinism canary. Uses the real DOOM2.WAD.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { simChecksum } from '../src/sim/checksum.ts';
import { BT2_JUMP, VIEWHEIGHT } from '../src/sim/defs.ts';
import { FRACUNIT } from '../src/sim/fixed.ts';
import { DoomSim } from '../src/sim/sim.ts';
import { emptyCmd, type TicCmd } from '../src/sim/ticcmd.ts';
import { readMap } from '../src/wad/maps.ts';
import { WadFile } from '../src/wad/wad.ts';

function loadWad(): WadFile | null {
  try {
    const buf = readFileSync(join(__dirname, '..', 'DOOM2.WAD'));
    return new WadFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } catch {
    return null;
  }
}

const wad = loadWad();

function newSim(mapName = 'MAP01'): DoomSim {
  const sim = new DoomSim();
  sim.playeringame[0] = true;
  sim.loadLevel(readMap(wad!, mapName), parseInt(mapName.slice(3), 10));
  return sim;
}

// Deterministic input script: pseudo-random but reproducible.
function scriptedCmd(tic: number): TicCmd {
  const cmd = emptyCmd();
  let x = (tic * 2654435761) | 0;
  x ^= x >>> 13;
  cmd.forwardmove = tic % 70 < 40 ? 0x32 : -0x19;
  cmd.sidemove = tic % 90 < 30 ? 0x28 : 0;
  cmd.angleturn = ((x % 1200) - 600) | 0;
  cmd.pitch = ((x % 300) - 150) | 0;
  if (tic % 100 > 90) cmd.buttons2 |= BT2_JUMP;
  return cmd;
}

describe.skipIf(!wad)('player movement physics', () => {
  test('spawns at player 1 start on the floor with view height', () => {
    const sim = newSim();
    const p = sim.players[0]!;
    expect(p.mo).toBeTruthy();
    expect(p.mo!.z).toBe(p.mo!.floorz);
    sim.runTic([emptyCmd()]);
    expect(p.viewz).toBe(p.mo!.z + VIEWHEIGHT);
  });

  test('walking forward builds momentum and friction stops it', () => {
    const sim = newSim();
    const p = sim.players[0]!;
    const startX = p.mo!.x;
    const run = emptyCmd();
    run.forwardmove = 0x32;
    for (let i = 0; i < 35; i++) sim.runTic([run]);
    // MAP01 start faces east (angle 0 per WAD is 90? whatever): position changed.
    const moved = Math.abs(p.mo!.x - startX) + Math.abs(p.mo!.y - sim.playerstarts[0]!.y * FRACUNIT);
    expect(moved).toBeGreaterThan(50 * FRACUNIT);
    // Doom run speed tops out around 16.66 units/tic; sanity-band it.
    const speed = Math.hypot(p.mo!.momx / FRACUNIT, p.mo!.momy / FRACUNIT);
    expect(speed).toBeGreaterThan(10);
    expect(speed).toBeLessThan(18);
    // stop: friction decays momentum to zero
    for (let i = 0; i < 60; i++) sim.runTic([emptyCmd()]);
    expect(p.mo!.momx).toBe(0);
    expect(p.mo!.momy).toBe(0);
  });

  test('cannot walk through walls', () => {
    const sim = newSim();
    const p = sim.players[0]!;
    const run = emptyCmd();
    run.forwardmove = 0x32;
    // Run forward for 20 seconds — hits walls, slides, but never escapes
    // the map or falls out of the world.
    for (let i = 0; i < 700; i++) sim.runTic([run]);
    expect(p.mo!.z).toBe(p.mo!.floorz);
    const sector = p.mo!.subsector!.sector;
    expect(p.mo!.floorz).toBe(sector.floorheight);
  });

  test('jump rises and lands back on the floor', () => {
    const sim = newSim();
    const p = sim.players[0]!;
    const jump = emptyCmd();
    jump.buttons2 = BT2_JUMP;
    const floorz = p.mo!.floorz;
    sim.runTic([jump]);
    // The impulse (8*FRACUNIT) raised z this tic and gravity already
    // decremented momz once within the same tic.
    expect(p.mo!.z - floorz).toBe(8 * FRACUNIT);
    expect(p.mo!.momz).toBe(7 * FRACUNIT);
    let peak = p.mo!.z;
    for (let i = 0; i < 40; i++) {
      sim.runTic([emptyCmd()]);
      peak = Math.max(peak, p.mo!.z);
    }
    expect(peak - p.mo!.floorz).toBeGreaterThan(30 * FRACUNIT); // clears ~1 block (32)
    expect(peak - p.mo!.floorz).toBeLessThan(50 * FRACUNIT);
    expect(p.mo!.z).toBe(p.mo!.floorz); // landed
  });

  test('determinism canary: two sims, same script, same checksums', () => {
    const a = newSim();
    const b = newSim();
    for (let tic = 0; tic < 1000; tic++) {
      a.runTic([scriptedCmd(tic)]);
      b.runTic([scriptedCmd(tic)]);
      if (tic % 35 === 0) {
        expect(simChecksum(a), `tic ${tic}`).toBe(simChecksum(b));
      }
    }
    // the script must have actually moved the player around
    expect(a.players[0]!.mo!.x).not.toBe(a.playerstarts[0]!.x * FRACUNIT);
  });
});
