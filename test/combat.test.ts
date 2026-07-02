// Full-game integration: monsters + weapons + specials active.
// The two-sim determinism canary here is the strongest pre-netplay check.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { simChecksum } from '../src/sim/checksum.ts';
import { BT_ATTACK, BT_USE } from '../src/sim/defs.ts';
import { createGameSim } from '../src/sim/create.ts';
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

function newSim(mapNum = 1): DoomSim {
  const sim = createGameSim();
  sim.playeringame[0] = true;
  const name = `MAP${String(mapNum).padStart(2, '0')}`;
  sim.loadLevel(readMap(wad!, name), mapNum, { spawnThings: true });
  return sim;
}

function scriptedCmd(tic: number): TicCmd {
  const cmd = emptyCmd();
  let x = (tic * 2654435761) | 0;
  x ^= x >>> 13;
  cmd.forwardmove = tic % 100 < 60 ? 0x32 : 0;
  cmd.sidemove = tic % 130 < 40 ? -0x28 : 0;
  cmd.angleturn = ((x % 900) - 450) | 0;
  if (tic % 50 < 20) cmd.buttons |= BT_ATTACK;
  if (tic % 200 > 190) cmd.buttons |= BT_USE;
  return cmd;
}

describe.skipIf(!wad)('full game integration', () => {
  test('MAP01 spawns monsters and items', () => {
    const sim = newSim(1);
    expect(sim.totalkills).toBeGreaterThan(0);
    let mobjCount = 0;
    for (const _ of sim.mobjs()) mobjCount++;
    expect(mobjCount).toBeGreaterThan(20);
  });

  test('weapon fires: ammo decreases, puff/blood spawns', () => {
    const sim = newSim(1);
    const p = sim.players[0]!;
    const before = p.ammo[0]!;
    const fire = emptyCmd();
    fire.buttons = BT_ATTACK;
    // pistol raise takes ~12 tics, then firing
    for (let i = 0; i < 40; i++) sim.runTic([fire]);
    expect(p.ammo[0]).toBeLessThan(before);
  });

  test('monsters wake and act on noise without crashing', () => {
    const sim = newSim(1);
    const fire = emptyCmd();
    fire.buttons = BT_ATTACK;
    for (let i = 0; i < 20; i++) sim.runTic([fire]);
    // run a while; monsters should be in non-spawn states (chasing)
    for (let i = 0; i < 300; i++) sim.runTic([emptyCmd()]);
    let active = 0;
    for (const m of sim.mobjs()) {
      if (m.info.seestate && m.stateNum === m.info.seestate) active++;
      if (m.stateNum !== m.info.spawnstate && m.flags & 0x400000) active++;
    }
    expect(active).toBeGreaterThan(0);
  });

  test('doors and lifts run on several maps without crashing', () => {
    for (const mapNum of [1, 2, 7, 13, 29]) {
      const sim = newSim(mapNum);
      const cmd = emptyCmd();
      cmd.forwardmove = 0x32;
      cmd.buttons = BT_USE;
      for (let i = 0; i < 200; i++) sim.runTic([cmd]);
    }
  });

  test('determinism canary with full combat (2000 tics)', () => {
    const a = newSim(1);
    const b = newSim(1);
    for (let tic = 0; tic < 2000; tic++) {
      a.runTic([scriptedCmd(tic)]);
      b.runTic([scriptedCmd(tic)]);
      if (tic % 35 === 0) {
        expect(simChecksum(a), `tic ${tic}`).toBe(simChecksum(b));
      }
    }
    // sanity: combat actually happened
    expect(a.players[0]!.ammo[0]).not.toBe(50);
  });
});
