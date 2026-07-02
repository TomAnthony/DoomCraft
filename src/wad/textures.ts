// Wall texture composition: PNAMES + TEXTURE1/TEXTURE2 definitions built
// from patch pictures. https://doomwiki.org/wiki/TEXTURE1_and_TEXTURE2

import { decodePicture, type Picture } from './graphics.ts';
import type { WadFile } from './wad.ts';

export interface TexturePatch {
  readonly originX: number;
  readonly originY: number;
  readonly patch: number; // index into PNAMES
}

export interface TextureDef {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly patches: readonly TexturePatch[];
}

function readName8(view: DataView, offset: number): string {
  let s = '';
  for (let i = 0; i < 8; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.toUpperCase();
}

export function readPnames(wad: WadFile): string[] {
  const view = wad.viewOf('PNAMES');
  const count = view.getInt32(0, true);
  const names: string[] = [];
  for (let i = 0; i < count; i++) names.push(readName8(view, 4 + i * 8));
  return names;
}

function readTextureLump(wad: WadFile, lumpName: string): TextureDef[] {
  if (!wad.has(lumpName)) return [];
  const view = wad.viewOf(lumpName);
  const count = view.getInt32(0, true);
  const defs: TextureDef[] = [];
  for (let i = 0; i < count; i++) {
    const at = view.getInt32(4 + i * 4, true);
    const name = readName8(view, at);
    const width = view.getInt16(at + 12, true);
    const height = view.getInt16(at + 14, true);
    const patchCount = view.getInt16(at + 20, true);
    const patches: TexturePatch[] = [];
    for (let p = 0; p < patchCount; p++) {
      const pat = at + 22 + p * 10;
      patches.push({
        originX: view.getInt16(pat, true),
        originY: view.getInt16(pat + 2, true),
        patch: view.getInt16(pat + 4, true),
        // stepdir/colormap fields are unused by every engine.
      });
    }
    defs.push({ name, width, height, patches });
  }
  return defs;
}

export function readTextureDefs(wad: WadFile): TextureDef[] {
  return [...readTextureLump(wad, 'TEXTURE1'), ...readTextureLump(wad, 'TEXTURE2')];
}

/** Compose a wall texture from its patches into one indexed picture. */
export function composeTexture(
  def: TextureDef,
  pnames: readonly string[],
  wad: WadFile,
  patchCache: Map<string, Picture>,
): Picture {
  const pixels = new Uint8Array(def.width * def.height);
  const opaque = new Uint8Array(def.width * def.height);
  for (const tp of def.patches) {
    const patchName = pnames[tp.patch];
    if (patchName === undefined || !wad.has(patchName)) continue;
    let pic = patchCache.get(patchName);
    if (!pic) {
      pic = decodePicture(wad.read(patchName));
      patchCache.set(patchName, pic);
    }
    for (let py = 0; py < pic.height; py++) {
      const y = tp.originY + py;
      if (y < 0 || y >= def.height) continue;
      for (let px = 0; px < pic.width; px++) {
        const x = tp.originX + px;
        if (x < 0 || x >= def.width) continue;
        const src = py * pic.width + px;
        if (!pic.opaque[src]) continue;
        const dst = y * def.width + x;
        pixels[dst] = pic.pixels[src]!;
        opaque[dst] = 1;
      }
    }
  }
  return { width: def.width, height: def.height, leftOffset: 0, topOffset: 0, pixels, opaque };
}
