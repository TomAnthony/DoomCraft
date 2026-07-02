// Block gun scenario tests: stacking, bridges, physics interplay,
// destruction, splash attenuation — the user-specified rules.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { BLOCK_FX, BLOCK_HP } from '../src/blocks/grid.ts';
import { simChecksum } from '../src/sim/checksum.ts';
import { createGameSim } from '../src/sim/create.ts';
import {
  BT2_BLOCKREMOVE, BT2_JUMP, BT_ATTACK, BT_CHANGE, BT_WEAPONSHIFT,
} from '../src/sim/defs.ts';
import { FRACUNIT } from '../src/sim/fixed.ts';
import type { DoomSim } from '../src/sim/sim.ts';
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

function newSim(spawnThings = false): DoomSim {
  const sim = createGameSim();
  sim.playeringame[0] = true;
  sim.loadLevel(readMap(wad!, 'MAP01'), 1, { spawnThings });
  return sim;
}

const selectBlockGun = (): TicCmd => {
  const cmd = emptyCmd();
  cmd.buttons = BT_CHANGE | (7 << BT_WEAPONSHIFT);
  return cmd;
};

/** Run tics until the block gun is ready (raise animation). */
function readyBlockGun(sim: DoomSim): void {
  sim.runTic([selectBlockGun()]);
  for (let i = 0; i < 40; i++) sim.runTic([emptyCmd()]);
}

describe.skipIf(!wad)('block gun', () => {
  test('selecting weapon 8 readies the block gun', () => {
    const sim = newSim();
    readyBlockGun(sim);
    expect(sim.players[0]!.readyweapon).toBe(10);
  });

  test('placing blocks: fire creates a block on the floor ahead', () => {
    const sim = newSim();
    readyBlockGun(sim);
    const p = sim.players[0]!;
    p.mo!.pitch = -0x18000000; // look down ~34°
    const fire = emptyCmd();
    fire.buttons = BT_ATTACK;
    for (let i = 0; i < 20; i++) sim.runTic([fire]);
    expect(sim.blocks.count).toBeGreaterThan(0);
  });

  /** Cell N block-widths ahead of the mobj along its facing angle. */
  function aheadCell(sim: DoomSim, n: number): { bx: number; by: number; bz: number } {
    const mo = sim.players[0]!.mo!;
    const rad = (mo.angle / 4294967296) * Math.PI * 2;
    const x = mo.x + Math.round(Math.cos(rad) * n * BLOCK_FX);
    const y = mo.y + Math.round(Math.sin(rad) * n * BLOCK_FX);
    // base cell sits at or above the floor
    const bz = Math.ceil(mo.floorz / BLOCK_FX);
    return { bx: Math.floor(x / BLOCK_FX), by: Math.floor(y / BLOCK_FX), bz };
  }

  /** Displacement (map units) along the facing direction since (x0, y0). */
  function forwardDist(sim: DoomSim, x0: number, y0: number): number {
    const mo = sim.players[0]!.mo!;
    const rad = (mo.angle / 4294967296) * Math.PI * 2;
    return ((mo.x - x0) * Math.cos(rad) + (mo.y - y0) * Math.sin(rad)) / FRACUNIT;
  }

  test('a placed block in front is a wall; player cannot walk through', () => {
    const sim = newSim();
    const mo = sim.players[0]!.mo!;
    const c = aheadCell(sim, 2);
    sim.blocks.place(c.bx, c.by, c.bz);
    sim.blocks.place(c.bx, c.by, c.bz + 1);
    // a 3rd on top in case the floor is well below the base cell
    sim.blocks.place(c.bx, c.by, c.bz + 2);

    const x0 = mo.x;
    const y0 = mo.y;
    const run = emptyCmd();
    run.forwardmove = 0x32;
    for (let i = 0; i < 70; i++) sim.runTic([run]);
    // blocked well before passing the wall cell
    expect(forwardDist(sim, x0, y0)).toBeLessThan(2.5 * 32);
    expect(mo.z).toBe(mo.floorz);
  });

  test('blocks can be climbed by jumping (stair-step / pillar-up)', () => {
    // Jump apex is ~36 units, so a +32 rise between block tops is always
    // jumpable; against a misaligned floor the first block is placed
    // partially buried (grid-aligned) and acts as a step.
    const sim = newSim();
    const mo = sim.players[0]!.mo!;
    const bzBuried = Math.floor(mo.floorz / BLOCK_FX);
    const c1 = aheadCell(sim, 1);
    const c2 = aheadCell(sim, 2);
    sim.blocks.place(c1.bx, c1.by, bzBuried); // top ≤ floor+32 (step/jump on)
    sim.blocks.place(c2.bx, c2.by, bzBuried + 1); // +32 from the first top

    const top2 = (bzBuried + 2) * BLOCK_FX;
    const runJump = emptyCmd();
    runJump.forwardmove = 0x32;
    runJump.buttons2 = BT2_JUMP;
    for (let i = 0; i < 150; i++) {
      sim.runTic([runJump]);
      if (mo.z === top2 && mo.floorz === top2) break;
    }
    // standing on top of the second block, two cells up
    expect(mo.z).toBe(top2);
    expect(mo.floorz).toBe(top2);
  });

  test('bridge: player walks under a block 2 cells up', () => {
    const sim = newSim();
    const mo = sim.players[0]!.mo!;
    const x0 = mo.x;
    const y0 = mo.y;
    for (let i = 1; i <= 4; i++) {
      const c = aheadCell(sim, i);
      sim.blocks.place(c.bx, c.by, c.bz + 2); // 64+ units up
    }
    const run = emptyCmd();
    run.forwardmove = 0x32;
    for (let i = 0; i < 60; i++) sim.runTic([run]);
    // passed beyond the bridge on the ground
    expect(forwardDist(sim, x0, y0)).toBeGreaterThan(5 * 32);
    expect(mo.z).toBe(mo.floorz);
  });

  test('removing a supporting block drops the player', () => {
    const sim = newSim();
    const p = sim.players[0]!;
    const mo = p.mo!;
    const bx = (mo.x / BLOCK_FX) | 0;
    const by = (mo.y / BLOCK_FX) | 0;
    const bz = (mo.floorz / BLOCK_FX) | 0;
    // put a block under the player and teleport them on top
    sim.blocks.place(bx, by, bz);
    sim.pmap.teleportMove(mo, mo.x, mo.y);
    mo.z = (bz + 1) * BLOCK_FX;
    sim.runTic([emptyCmd()]);
    expect(mo.z).toBe((bz + 1) * BLOCK_FX); // standing on the block

    sim.blocks.remove(bx, by, bz);
    // simulate the gun's support sweep
    sim.pmap.thingHeightClip(mo);
    for (let i = 0; i < 30; i++) sim.runTic([emptyCmd()]);
    expect(mo.z).toBe(mo.floorz); // fell back to the sector floor
  });

  test('pistol destroys a block in a few shots (35 HP, 5-15 dmg/shot)', () => {
    const sim = newSim();
    const p = sim.players[0]!;
    const c = aheadCell(sim, 3);
    // 3-stack so eye-height shots connect regardless of floor alignment
    sim.blocks.place(c.bx, c.by, c.bz);
    sim.blocks.place(c.bx, c.by, c.bz + 1);
    sim.blocks.place(c.bx, c.by, c.bz + 2);

    const fire = emptyCmd();
    fire.buttons = BT_ATTACK;
    let shots = 0;
    const ammoStart = p.ammo[0]!;
    for (let i = 0; i < 300 && sim.blocks.count === 3; i++) {
      sim.runTic([fire]);
      shots = ammoStart - p.ammo[0]!;
    }
    expect(sim.blocks.count).toBe(2); // the eye-height block died
    // 35 HP / (5..15 per shot) → 3 typical, 7 worst-case
    expect(shots).toBeGreaterThanOrEqual(3);
    expect(shots).toBeLessThanOrEqual(7);
  });

  test('rocket splash is stopped by a 3-deep block wall', () => {
    const sim = newSim();
    const p = sim.players[0]!;
    const mo = p.mo!;
    // wall of 3-deep blocks at eye level between an explosion and a victim
    const bz = (mo.floorz / BLOCK_FX) | 0;
    const by = (mo.y / BLOCK_FX) | 0;
    const bxBase = ((mo.x / BLOCK_FX) | 0) + 3;
    for (let d = 0; d < 3; d++) {
      for (let z = 0; z < 3; z++) {
        sim.blocks.place(bxBase + d, by, bz + z);
        sim.blocks.place(bxBase + d, by - 1, bz + z);
        sim.blocks.place(bxBase + d, by + 1, bz + z);
      }
    }
    const healthBefore = p.health;
    // explosion on the far side of the wall, 128 dmg (rocket)
    const spot = sim.spawnMobj((bxBase + 4) * BLOCK_FX, mo.y, mo.z, 33 /* MT_ROCKET */);
    sim.radiusAttack(spot, null, 128);
    expect(p.health).toBe(healthBefore); // fully shielded
  });

  test('determinism canary with block place/remove (500 tics)', () => {
    const script = (tic: number): TicCmd => {
      const cmd = emptyCmd();
      if (tic === 0) return selectBlockGun();
      cmd.forwardmove = tic % 60 < 30 ? 0x32 : 0;
      cmd.angleturn = ((tic * 37) % 600) - 300;
      if (tic % 30 < 10) cmd.buttons = BT_ATTACK; // place
      if (tic % 45 < 5) cmd.buttons2 = BT2_BLOCKREMOVE;
      cmd.pitch = tic % 80 < 40 ? -200 : 100;
      return cmd;
    };
    const a = newSim(true);
    const b = newSim(true);
    for (let tic = 0; tic < 500; tic++) {
      a.runTic([script(tic)]);
      b.runTic([script(tic)]);
      if (tic % 35 === 0) expect(simChecksum(a), `tic ${tic}`).toBe(simChecksum(b));
    }
    expect(a.blocks.count).toBeGreaterThan(0); // blocks actually placed
    expect(a.blocks.count).toBe(b.blocks.count);
  });
});
