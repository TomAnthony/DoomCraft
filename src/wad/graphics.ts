// Palette, colormap, and image decoding (Doom picture format + flats).
// Decoded images stay palette-indexed; RGBA conversion happens at the edge.

import type { WadFile } from './wad.ts';

/** Palette-indexed image with transparency mask. */
export interface Picture {
  readonly width: number;
  readonly height: number;
  /** Render origin offsets (sprites/HUD use these; walls ignore them). */
  readonly leftOffset: number;
  readonly topOffset: number;
  /** width*height palette indices, column-major irrelevant — stored row-major. */
  readonly pixels: Uint8Array;
  /** width*height 0/1 opacity. */
  readonly opaque: Uint8Array;
}

/** 14 palettes of 256 RGB triples (0 = normal, 1-8 pain, 9-12 item, 13 radsuit). */
export function readPlaypal(wad: WadFile): Uint8Array[] {
  const raw = wad.read('PLAYPAL');
  const palettes: Uint8Array[] = [];
  for (let i = 0; i + 768 <= raw.length; i += 768) {
    palettes.push(raw.subarray(i, i + 768));
  }
  if (palettes.length < 14) throw new Error(`PLAYPAL: expected 14 palettes, got ${palettes.length}`);
  return palettes;
}

/** 34 light-diminishing colormaps of 256 palette indices. */
export function readColormap(wad: WadFile): Uint8Array {
  const raw = wad.read('COLORMAP');
  if (raw.length < 34 * 256) throw new Error('COLORMAP too small');
  return raw;
}

/** Doom picture format: https://doomwiki.org/wiki/Picture_format */
export function decodePicture(data: Uint8Array): Picture {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getInt16(0, true);
  const height = view.getInt16(2, true);
  const leftOffset = view.getInt16(4, true);
  const topOffset = view.getInt16(6, true);
  if (width <= 0 || width > 4096 || height <= 0 || height > 4096) {
    throw new Error(`implausible picture ${width}x${height}`);
  }
  const pixels = new Uint8Array(width * height);
  const opaque = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    let pos = view.getUint32(8 + x * 4, true);
    for (;;) {
      const topDelta = data[pos];
      if (topDelta === undefined || topDelta === 0xff) break;
      const length = data[pos + 1]!;
      // +3 skips topdelta, length, and the unused padding byte.
      let src = pos + 3;
      for (let y = 0; y < length; y++) {
        const row = topDelta + y;
        if (row < height) {
          pixels[row * width + x] = data[src]!;
          opaque[row * width + x] = 1;
        }
        src++;
      }
      pos = src + 1; // trailing pad byte
    }
  }
  return { width, height, leftOffset, topOffset, pixels, opaque };
}

/** Flats are raw 64x64 palette indices with no header. */
export function decodeFlat(data: Uint8Array): Picture {
  if (data.length < 4096) throw new Error(`flat lump too small (${data.length})`);
  return {
    width: 64,
    height: 64,
    leftOffset: 0,
    topOffset: 0,
    pixels: data.subarray(0, 4096),
    opaque: new Uint8Array(4096).fill(1),
  };
}

/** Expand an indexed picture to RGBA using the given 768-byte palette. */
export function toRGBA(pic: Picture, palette: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(pic.width * pic.height * 4);
  for (let i = 0; i < pic.pixels.length; i++) {
    if (!pic.opaque[i]) continue;
    const c = pic.pixels[i]! * 3;
    out[i * 4] = palette[c]!;
    out[i * 4 + 1] = palette[c + 1]!;
    out[i * 4 + 2] = palette[c + 2]!;
    out[i * 4 + 3] = 255;
  }
  return out;
}
