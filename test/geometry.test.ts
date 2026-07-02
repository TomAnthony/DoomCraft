// Geometry pipeline smoke test over every map in DOOM2.WAD: all sectors
// must triangulate (fallback fans allowed but rare) and all wall quads
// must be sane. Skips when the WAD is absent.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { triangulateAllSectors } from '../src/render/sectorpolys.ts';
import { buildWallQuads, type TextureSize } from '../src/render/walls.ts';
import { listMaps, readMap } from '../src/wad/maps.ts';
import { readTextureDefs } from '../src/wad/textures.ts';
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

describe.skipIf(!wad)('level geometry', () => {
  const textureSizes = new Map<string, TextureSize>();
  if (wad) {
    for (const def of readTextureDefs(wad)) {
      textureSizes.set(def.name, { width: def.width, height: def.height });
    }
  }

  test('every sector on every map triangulates', () => {
    let totalSectors = 0;
    let fallbacks = 0;
    let empty = 0;
    for (const name of listMaps(wad!)) {
      const map = readMap(wad!, name);
      const tris = triangulateAllSectors(map);
      for (const t of tris) {
        totalSectors++;
        if (t.usedFallback) fallbacks++;
        if (t.indices.length === 0) empty++;
        // Indices must address real vertices.
        for (const i of t.indices) expect(i * 2, `${name} s${t.sector}`).toBeLessThan(t.positions.length);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`sectors: ${totalSectors}, fallback fans: ${fallbacks}, empty: ${empty}`);
    // A handful of "dummy" sectors (mapper tricks referenced by only 1-2
    // linedefs) enclose no area and own no subsectors — empty is correct
    // for them. DOOM2.WAD has 17.
    expect(empty).toBeLessThanOrEqual(17);
    expect(fallbacks / totalSectors).toBeLessThan(0.05);
  });

  test('player 1 start stands on triangulated floor on every map', async () => {
    const { pointInSector } = await import('../src/render/bsp.ts');
    const { triangulateSector } = await import('../src/render/sectorpolys.ts');
    for (const name of listMaps(wad!)) {
      const map = readMap(wad!, name);
      const start = map.things.find((t) => t.type === 1)!;
      const tri = triangulateSector(map, pointInSector(map, start.x, start.y));
      let covered = false;
      for (let i = 0; i < tri.indices.length && !covered; i += 3) {
        const [a, b, c] = [tri.indices[i]! * 2, tri.indices[i + 1]! * 2, tri.indices[i + 2]! * 2];
        const s1 = (tri.positions[b]! - tri.positions[a]!) * (start.y - tri.positions[a + 1]!) -
          (tri.positions[b + 1]! - tri.positions[a + 1]!) * (start.x - tri.positions[a]!);
        const s2 = (tri.positions[c]! - tri.positions[b]!) * (start.y - tri.positions[b + 1]!) -
          (tri.positions[c + 1]! - tri.positions[b + 1]!) * (start.x - tri.positions[b]!);
        const s3 = (tri.positions[a]! - tri.positions[c]!) * (start.y - tri.positions[c + 1]!) -
          (tri.positions[a + 1]! - tri.positions[c + 1]!) * (start.x - tri.positions[c]!);
        covered = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
      }
      expect(covered, `${name} start floor`).toBe(true);
    }
  });

  test('wall quads are sane on every map', () => {
    for (const name of listMaps(wad!)) {
      const map = readMap(wad!, name);
      const quads = buildWallQuads(map, textureSizes);
      expect(quads.length, name).toBeGreaterThanOrEqual(100); // MAP30 is one big room: exactly 100
      for (const q of quads) {
        expect(q.top, `${name} ld${q.linedef}`).toBeGreaterThan(q.bottom);
        expect(q.texture).not.toBe('-');
        // Every referenced texture must exist (validated in wad.test too,
        // but this catches pegging-code name mix-ups like top vs mid).
        expect(textureSizes.has(q.texture), `${name} ${q.texture}`).toBe(true);
      }
    }
  });
});
