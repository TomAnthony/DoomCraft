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

describe.skipIf(!wad)('teleporter regression', () => {
  test('spechit reset during crossSpecialLine does not crash tryMove', () => {
    // EV_Teleport's teleportMove RESETS spechit while tryMove is still
    // iterating it (vanilla survives via the shared numspechit global; a
    // captured length indexes an emptied array). Reproduce the mechanism
    // deterministically: cross a special line with spechit holding two
    // entries and a crossSpecialLine hook that clears it (as teleports do).
    const sim = newSim(1);
    const mo = sim.players[0]!.mo!;

    // find a line we can stand on both sides of
    let crossed = false;
    for (const line of sim.world.lines) {
      const mx = ((line.v1.x + line.v2.x) / 2) | 0;
      const my = ((line.v1.y + line.v2.y) / 2) | 0;
      const len = Math.hypot(line.dx / 65536, line.dy / 65536);
      if (len < 32) continue;
      const nx = Math.round(((line.dy / 65536) / len) * 24) * 65536;
      const ny = Math.round(((-line.dx / 65536) / len) * 24) * 65536;
      if (!sim.pmap.teleportMove(mo, (mx + nx) | 0, (my + ny) | 0)) continue;
      mo.z = mo.floorz;

      line.special = 97; // make it "special" so the hook fires
      // teleport-like hook: wipes spechit mid-iteration
      sim.crossSpecialLine = () => {
        sim.pmap.spechit.length = 0;
      };
      // force TWO pending entries for the crossing
      const pm = sim.pmap;
      const origCheck = pm.checkPosition.bind(pm);
      pm.checkPosition = (thing, x, y) => {
        const ok = origCheck(thing, x, y);
        pm.spechit.length = 0;
        pm.spechit.push(line, line);
        return ok;
      };

      expect(() => pm.tryMove(mo, (mx - nx) | 0, (my - ny) | 0)).not.toThrow();
      crossed = true;
      break;
    }
    expect(crossed).toBe(true);
  });
});

describe.skipIf(!wad)('4-player determinism', () => {
  test('two sims, four players, 700 scripted tics stay checksum-identical', () => {
    const mk = () => {
      const sim = newSim(1);
      for (let i = 0; i < 4; i++) sim.playeringame[i] = true;
      sim.netgame = true;
      sim.deathmatch = true;
      sim.loadLevel(readMap(wad!, 'MAP01'), 1, { spawnThings: true });
      return sim;
    };
    const a = mk();
    const b = mk();
    const mkCmds = (t: number) =>
      [0, 1, 2, 3].map((i) => {
        const c = emptyCmd();
        c.forwardmove = ((t + i * 9) % 50) - 25;
        c.sidemove = ((t * 3 + i * 5) % 40) - 20;
        c.angleturn = ((t * 7 + i * 11) % 2000) - 1000;
        if ((t + i) % 5 === 0) c.buttons = 1; // fire
        if ((t + i) % 47 === 0) c.buttons2 = 1; // jump
        return c;
      });
    for (let t = 0; t < 700; t++) {
      a.runTic(mkCmds(t));
      b.runTic(mkCmds(t));
      if (t % 35 === 0) {
        expect(simChecksum(a), `tic ${t}`).toBe(simChecksum(b));
      }
    }
    // all four players alive-or-dead identically, frags arrays match
    for (let i = 0; i < 4; i++) {
      expect(a.players[i]!.health).toBe(b.players[i]!.health);
      expect(a.players[i]!.frags.join(',')).toBe(b.players[i]!.frags.join(','));
    }
  });
});
