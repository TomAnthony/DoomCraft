// Sprite frame/rotation table built from the S_START..S_END namespace.
// Lump naming: NNNNFR or NNNNFRFR (second pair = mirrored reuse), where
// F is the frame letter and R the rotation digit ('0' = omnidirectional).

import type { WadFile } from '../wad/wad.ts';

export interface SpriteFrameLump {
  readonly lumpName: string;
  readonly mirrored: boolean;
}

/** frames.get(frameLetterIndex) -> 9 rotation slots (0 = omni, 1-8). */
export interface SpriteFrames {
  readonly rotations: (SpriteFrameLump | null)[][];
}

export type SpriteTable = Map<string, SpriteFrames>;

export function buildSpriteTable(wad: WadFile): SpriteTable {
  const table: SpriteTable = new Map();
  const put = (spr: string, frame: number, rot: number, lumpName: string, mirrored: boolean) => {
    let entry = table.get(spr);
    if (!entry) {
      entry = { rotations: [] };
      table.set(spr, entry);
    }
    while (entry.rotations.length <= frame) entry.rotations.push(new Array(9).fill(null));
    const slots = entry.rotations[frame]!;
    if (rot === 0) {
      // Omnidirectional fills all slots (rotation lumps override).
      for (let r = 0; r < 9; r++) if (!slots[r]) slots[r] = { lumpName, mirrored };
    } else {
      slots[rot] = { lumpName, mirrored };
    }
  };

  for (const lump of wad.between('S_START', 'S_END')) {
    const name = lump.name;
    if (name.length !== 6 && name.length !== 8) continue;
    const spr = name.slice(0, 4);
    const frame = name.charCodeAt(4) - 65; // 'A'
    const rot = name.charCodeAt(5) - 48; // '0'
    if (frame < 0 || rot < 0 || rot > 8) continue;
    put(spr, frame, rot, name, false);
    if (name.length === 8) {
      const frame2 = name.charCodeAt(6) - 65;
      const rot2 = name.charCodeAt(7) - 48;
      if (frame2 >= 0 && rot2 >= 0 && rot2 <= 8) put(spr, frame2, rot2, name, true);
    }
  }
  return table;
}

/**
 * Pick the rotation slot for a sprite as seen by a viewer, vanilla
 * r_things formula: rot = (angleToThing - thingAngle + ANG45/2*9) >> 29.
 * Angles here in radians (render-side); returns slot 1-8.
 */
export function rotationFor(viewAngle: number, thingAngle: number): number {
  const tau = Math.PI * 2;
  let rel = (viewAngle - thingAngle + tau + (Math.PI / 8) * 9) % tau;
  if (rel < 0) rel += tau;
  return (Math.floor(rel / (Math.PI / 4)) % 8) + 1;
}
