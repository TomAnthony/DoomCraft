// M1 debug page: parse DOOM2.WAD and render decoded assets so parser
// regressions are visible at a glance. Superseded by the game UI later.

import { decodeFlat, decodePicture, readPlaypal, toRGBA, type Picture } from '../wad/graphics.ts';
import { listMaps, readMap } from '../wad/maps.ts';
import { composeTexture, readPnames, readTextureDefs } from '../wad/textures.ts';
import { hashWad, WadFile } from '../wad/wad.ts';

function el(tag: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}

function picCanvas(pic: Picture, palette: Uint8Array, scale = 1): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = pic.width;
  canvas.height = pic.height;
  canvas.style.width = `${pic.width * scale}px`;
  canvas.style.imageRendering = 'pixelated';
  canvas.title = `${pic.width}x${pic.height}`;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(toRGBA(pic, palette), pic.width, pic.height), 0, 0);
  return canvas;
}

function section(root: HTMLElement, title: string): HTMLElement {
  root.appendChild(el('h2', title));
  const div = el('div');
  div.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end';
  root.appendChild(div);
  return div;
}

export async function runWadViewer(root: HTMLElement): Promise<void> {
  root.style.cssText = 'padding:16px;overflow:auto;height:100%;box-sizing:border-box';
  root.appendChild(el('h1', 'DoomCraft — WAD debug viewer'));

  const resp = await fetch('/DOOM2.WAD');
  if (!resp.ok) {
    root.appendChild(el('p', 'DOOM2.WAD not found — place it in the project root.'));
    return;
  }
  const buffer = await resp.arrayBuffer();
  const wad = new WadFile(buffer);
  const palette = readPlaypal(wad)[0]!;

  root.appendChild(
    el('p', `${wad.type}, ${wad.lumps.length} lumps, ${(buffer.byteLength / 1e6).toFixed(1)} MB, sha256 ${(await hashWad(buffer)).slice(0, 16)}…`),
  );

  // Palette swatch
  {
    const div = section(root, 'PLAYPAL[0]');
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    canvas.style.cssText = 'width:128px;image-rendering:pixelated';
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(16, 16);
    for (let i = 0; i < 256; i++) {
      img.data[i * 4] = palette[i * 3]!;
      img.data[i * 4 + 1] = palette[i * 3 + 1]!;
      img.data[i * 4 + 2] = palette[i * 3 + 2]!;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    div.appendChild(canvas);
  }

  // Title screen — exercises the picture decoder end to end.
  section(root, 'TITLEPIC').appendChild(picCanvas(decodePicture(wad.read('TITLEPIC')), palette, 2));

  // Wall textures
  {
    const div = section(root, 'Textures (first 16 of TEXTURE1/2)');
    const pnames = readPnames(wad);
    const defs = readTextureDefs(wad);
    const cache = new Map<string, Picture>();
    for (const def of defs.slice(0, 16)) {
      const wrap = el('figure');
      wrap.appendChild(picCanvas(composeTexture(def, pnames, wad, cache), palette));
      wrap.appendChild(el('figcaption', def.name));
      div.appendChild(wrap);
    }
  }

  // Sprites
  {
    const div = section(root, 'Sprites');
    for (const name of ['TROOA1', 'POSSA1', 'CYBRA1', 'PLAYA1', 'PISGA0', 'SHTGA0', 'BFGGA0', 'MEDIA0']) {
      if (!wad.has(name)) continue;
      const wrap = el('figure');
      wrap.appendChild(picCanvas(decodePicture(wad.read(name)), palette, 2));
      wrap.appendChild(el('figcaption', name));
      div.appendChild(wrap);
    }
  }

  // Flats
  {
    const div = section(root, 'Flats (first 12)');
    for (const lump of wad.between('F_START', 'F_END').slice(0, 12)) {
      if (lump.size < 4096) continue;
      const wrap = el('figure');
      wrap.appendChild(picCanvas(decodeFlat(wad.read(lump)), palette));
      wrap.appendChild(el('figcaption', lump.name));
      div.appendChild(wrap);
    }
  }

  // Map stats
  {
    root.appendChild(el('h2', 'Maps'));
    const table = el('table') as HTMLTableElement;
    table.style.cssText = 'border-collapse:collapse;font-size:12px';
    const header = table.insertRow();
    for (const h of ['map', 'things', 'linedefs', 'sidedefs', 'vertexes', 'segs', 'ssectors', 'nodes', 'sectors']) {
      const th = el('th', h);
      th.style.cssText = 'border:1px solid #444;padding:2px 8px';
      header.appendChild(th);
    }
    for (const name of listMaps(wad)) {
      const m = readMap(wad, name);
      const row = table.insertRow();
      for (const v of [m.name, m.things.length, m.linedefs.length, m.sidedefs.length,
        m.vertexes.length, m.segs.length, m.subsectors.length, m.nodes.length, m.sectors.length]) {
        const td = row.insertCell();
        td.textContent = String(v);
        td.style.cssText = 'border:1px solid #444;padding:2px 8px;text-align:right';
      }
    }
    root.appendChild(table);
  }
}
