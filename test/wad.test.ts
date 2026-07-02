// Parser validation against the real DOOM2.WAD (project root, untracked).
// Skips when the WAD is absent so the suite still runs elsewhere.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { decodePicture, readColormap, readPlaypal } from '../src/wad/graphics.ts';
import { listMaps, readMap } from '../src/wad/maps.ts';
import { composeTexture, readPnames, readTextureDefs } from '../src/wad/textures.ts';
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

describe.skipIf(!wad)('DOOM2.WAD parsing', () => {
  test('container and core lumps', () => {
    expect(wad!.type).toBe('IWAD');
    expect(wad!.lumps.length).toBeGreaterThan(2000);
    expect(readPlaypal(wad!).length).toBe(14);
    expect(readColormap(wad!).length).toBeGreaterThanOrEqual(34 * 256);
  });

  test('all 32 maps present and internally consistent', () => {
    const maps = listMaps(wad!);
    expect(maps).toEqual(Array.from({ length: 32 }, (_, i) => `MAP${String(i + 1).padStart(2, '0')}`));
    for (const name of maps) {
      const map = readMap(wad!, name);
      expect(map.things.length, `${name} things`).toBeGreaterThan(0);
      expect(map.sectors.length, `${name} sectors`).toBeGreaterThan(0);
      for (const ld of map.linedefs) {
        expect(ld.v1, name).toBeLessThan(map.vertexes.length);
        expect(ld.v2, name).toBeLessThan(map.vertexes.length);
        for (const side of ld.sidenum) {
          if (side !== 0xffff) expect(side, name).toBeLessThan(map.sidedefs.length);
        }
      }
      for (const sd of map.sidedefs) expect(sd.sector, name).toBeLessThan(map.sectors.length);
      for (const seg of map.segs) {
        expect(seg.linedef, name).toBeLessThan(map.linedefs.length);
        expect(seg.v1, name).toBeLessThan(map.vertexes.length);
      }
      for (const ss of map.subsectors) {
        expect(ss.firstseg + ss.numsegs, name).toBeLessThanOrEqual(map.segs.length);
      }
      for (const node of map.nodes) {
        for (const child of node.children) {
          const idx = child & 0x7fff;
          if (child & 0x8000) expect(idx, name).toBeLessThan(map.subsectors.length);
          else expect(idx, name).toBeLessThan(map.nodes.length);
        }
      }
      expect(map.blockmap.length, name).toBeGreaterThan(8);
      // Player 1 start (doomednum 1) exists on every map.
      expect(map.things.some((t) => t.type === 1), `${name} player start`).toBe(true);
    }
  });

  test('every wall texture composes; every sidedef texture resolves', () => {
    const pnames = readPnames(wad!);
    const defs = readTextureDefs(wad!);
    expect(defs.length).toBeGreaterThan(300); // Doom 2 has 400+
    const cache = new Map();
    const byName = new Set(defs.map((d) => d.name));
    for (const def of defs) {
      const pic = composeTexture(def, pnames, wad!, cache);
      expect(pic.width).toBe(def.width);
      for (const p of def.patches) expect(p.patch).toBeLessThan(pnames.length);
    }
    const missing = new Set<string>();
    for (const name of listMaps(wad!)) {
      for (const sd of readMap(wad!, name).sidedefs) {
        for (const tex of [sd.topTexture, sd.bottomTexture, sd.midTexture]) {
          if (tex !== '-' && !byName.has(tex)) missing.add(`${name}:${tex}`);
        }
      }
    }
    expect([...missing]).toEqual([]);
  });

  test('sector flats all exist as lumps', () => {
    const flats = new Set(wad!.between('F_START', 'F_END').map((l) => l.name));
    expect(flats.size).toBeGreaterThan(100);
    for (const name of listMaps(wad!)) {
      for (const sec of readMap(wad!, name).sectors) {
        expect(flats.has(sec.floorPic), `${name} floor ${sec.floorPic}`).toBe(true);
        expect(flats.has(sec.ceilingPic), `${name} ceil ${sec.ceilingPic}`).toBe(true);
      }
    }
  });

  test('sprites and UI pictures decode', () => {
    const sprites = wad!.between('S_START', 'S_END');
    expect(sprites.length).toBeGreaterThan(1000);
    for (const lump of sprites.slice(0, 200)) {
      const pic = decodePicture(wad!.read(lump));
      expect(pic.width).toBeGreaterThan(0);
    }
    const title = decodePicture(wad!.read('TITLEPIC'));
    expect(title.width).toBe(320);
    expect(title.height).toBe(200);
  });
});
