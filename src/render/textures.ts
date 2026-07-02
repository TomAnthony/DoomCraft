// GPU texture management: composed wall textures and flats become
// THREE.DataTexture (nearest-filtered, repeating, palette 0).

import * as THREE from 'three';
import { decodeFlat, decodePicture, readPlaypal, toRGBA, type Picture } from '../wad/graphics.ts';
import { composeTexture, readPnames, readTextureDefs, type TextureDef } from '../wad/textures.ts';
import type { WadFile } from '../wad/wad.ts';

export interface TextureEntry {
  readonly texture: THREE.DataTexture;
  readonly width: number;
  readonly height: number;
}

export class TextureStore {
  private readonly wall = new Map<string, TextureEntry>();
  private readonly flat = new Map<string, TextureEntry>();
  private readonly sprite = new Map<string, TextureEntry & { pic: Picture }>();
  readonly wallDefs = new Map<string, TextureDef>();
  private readonly pnames: string[];
  private readonly patchCache = new Map<string, Picture>();
  readonly palette: Uint8Array;

  constructor(private readonly wad: WadFile) {
    this.palette = readPlaypal(wad)[0]!;
    this.pnames = readPnames(wad);
    for (const def of readTextureDefs(wad)) this.wallDefs.set(def.name, def);
  }

  private toEntry(pic: Picture): TextureEntry {
    const tex = new THREE.DataTexture(
      toRGBA(pic, this.palette), pic.width, pic.height, THREE.RGBAFormat,
    );
    // Row 0 of our RGBA is the image top, so v=0 samples the top and v
    // grows downward — wall UV math relies on this (flipY stays false).
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    // Keep palette bytes untouched: our shader writes raw values, so an
    // sRGB tag here would linearize on sample and darken everything.
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return { texture: tex, width: pic.width, height: pic.height };
  }

  wallTexture(name: string): TextureEntry | null {
    const cached = this.wall.get(name);
    if (cached) return cached;
    const def = this.wallDefs.get(name);
    if (!def) return null;
    const entry = this.toEntry(composeTexture(def, this.pnames, this.wad, this.patchCache));
    this.wall.set(name, entry);
    return entry;
  }

  flatTexture(name: string): TextureEntry | null {
    const cached = this.flat.get(name);
    if (cached) return cached;
    if (!this.wad.has(name)) return null;
    const data = this.wad.read(name);
    if (data.length < 4096) return null;
    const entry = this.toEntry(decodeFlat(data));
    this.flat.set(name, entry);
    return entry;
  }

  spriteTexture(lumpName: string): (TextureEntry & { pic: Picture }) | null {
    const cached = this.sprite.get(lumpName);
    if (cached) return cached;
    if (!this.wad.has(lumpName)) return null;
    const pic = decodePicture(this.wad.read(lumpName));
    const entry = { ...this.toEntry(pic), pic };
    this.sprite.set(lumpName, entry);
    return entry;
  }
}
