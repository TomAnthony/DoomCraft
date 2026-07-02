import { describe, expect, test } from 'vitest';
import { MF, MT, S, SPR, mobjinfo, sprnames, states } from '../src/sim/data/info.gen.ts';
import { SFX, sfxinfo } from '../src/sim/data/sounds.gen.ts';
import { finesine, finetangent, rndtable, tantoangle } from '../src/sim/data/tables.gen.ts';
import { ANG45, ANG90, SlopeDiv, finecosine } from '../src/sim/tables.ts';
import { FRACUNIT } from '../src/sim/fixed.ts';

// Pin well-known Doom 2 values so a codegen regression can't slip through.

describe('generated tables', () => {
  test('table sizes and known entries', () => {
    expect(finesine.length).toBe(10240);
    expect(finetangent.length).toBe(4096);
    expect(tantoangle.length).toBe(2049);
    expect(rndtable.length).toBe(256);
    // From the original source:
    expect(rndtable[0]).toBe(0);
    expect(rndtable[1]).toBe(8);
    expect(rndtable[255]).toBe(249);
    expect(finesine[0]).toBe(25);
    expect(finesine[2047]).toBe(65535); // sin ~ 1.0 at quarter turn
    expect(tantoangle[0]).toBe(0);
    expect(tantoangle[2048]).toBe(ANG45);
  });

  test('finecosine and SlopeDiv', () => {
    expect(finecosine(0)).toBe(finesine[2048]!);
    expect(SlopeDiv(0, 511)).toBe(2048);
    expect(SlopeDiv(1 << 20, 1 << 20)).toBe(2048); // equal num/den caps at SLOPERANGE
  });
});

describe('generated info', () => {
  test('counts', () => {
    expect(sprnames.length).toBe(138);
    expect(states.length).toBe(967);
    expect(mobjinfo.length).toBe(137);
    expect(sfxinfo.length).toBe(109);
  });

  test('player mobj', () => {
    const p = mobjinfo[MT.PLAYER]!;
    expect(p.spawnhealth).toBe(100);
    expect(p.radius).toBe(16 * FRACUNIT);
    expect(p.height).toBe(56 * FRACUNIT);
    expect(p.painchance).toBe(255);
    expect(p.flags & MF.SOLID).toBeTruthy();
    expect(p.flags & MF.SHOOTABLE).toBeTruthy();
  });

  test('famous monsters', () => {
    expect(mobjinfo[MT.CYBORG]!.spawnhealth).toBe(4000);
    expect(mobjinfo[MT.SPIDER]!.spawnhealth).toBe(3000);
    expect(mobjinfo[MT.POSSESSED]!.doomednum).toBe(3004);
    expect(mobjinfo[MT.SHOTGUY]!.doomednum).toBe(9);
    // Imp fireball: speed 10, damage 3
    expect(mobjinfo[MT.TROOPSHOT]!.speed).toBe(10 * FRACUNIT);
    expect(mobjinfo[MT.TROOPSHOT]!.damage).toBe(3);
  });

  test('state chains', () => {
    // S_NULL is the terminator.
    expect(states[S.NULL]![2]).toBe(-1);
    // Pistol ready loops to itself via A_WeaponReady.
    const pistol = states[S.PISTOL]!;
    expect(pistol[3]).toBe('A_WeaponReady');
    expect(pistol[4]).toBe(S.PISTOL);
    // Imp attack chain uses A_TroopAttack.
    expect(states.some((s) => s[3] === 'A_TroopAttack')).toBe(true);
    // Every nextstate is a valid index.
    for (const s of states) expect(s[4]).toBeGreaterThanOrEqual(0);
    for (const s of states) expect(s[4]).toBeLessThan(states.length);
    // Every sprite index is valid.
    for (const s of states) expect(s[0]).toBeLessThan(sprnames.length);
  });

  test('sounds', () => {
    expect(sfxinfo[SFX.pistol]!.name).toBe('pistol');
    expect(sfxinfo[SFX.sawidl]!.priority).toBe(118);
    // Chaingun sound is a link to pistol.
    expect(sfxinfo[SFX.chgun]!.link).not.toBeNull();
  });

  test('sprite names', () => {
    // The enum order must line up with sprnames — every name matches its key.
    for (const [key, index] of Object.entries(SPR)) {
      if (key === 'NUMSPRITES') continue;
      expect(sprnames[index], `SPR.${key}`).toBe(key);
    }
    expect(sprnames[SPR.PLAY]).toBe('PLAY');
  });
});
