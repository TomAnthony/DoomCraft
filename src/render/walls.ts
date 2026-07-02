// Wall quad extraction with vanilla texture pegging rules.
// https://doomwiki.org/wiki/Texture_alignment
//
// Output is pure data: one quad per visible wall section, tagged with the
// sectors whose floor/ceiling heights define its top/bottom edges so the
// scene can update vertices in place when sectors move (doors/lifts).

import type { MapData } from '../wad/maps.ts';

export const ML_DONTPEGTOP = 8;
export const ML_DONTPEGBOTTOM = 16;

export type WallKind = 'middle' | 'upper' | 'lower' | 'midtwo';

export interface WallQuad {
  readonly texture: string;
  readonly kind: WallKind;
  readonly linedef: number;
  readonly side: 0 | 1;
  /** Wall endpoints in map coords, left-to-right as seen from the facing side. */
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** Static heights at build time (world units). */
  readonly bottom: number;
  readonly top: number;
  /**
   * Height bindings for dynamic updates: which sector plane defines each
   * edge. null = static. E.g. an upper quad's bottom follows the back
   * sector's ceiling.
   */
  readonly bindings: {
    readonly top: { sector: number; plane: 'floor' | 'ceiling' } | null;
    readonly bottom: { sector: number; plane: 'floor' | 'ceiling' } | null;
  };
  /** Texture-space u at x1/x2 (world units along the wall). */
  readonly u1: number;
  readonly u2: number;
  /**
   * World z where texture row 0 (top of the image) sits; v coordinates
   * derive from it. For 'midtwo' the quad is already clamped to one
   * texture height, so vTop is its top edge.
   */
  readonly vTop: number;
  /** Sector providing light level for this quad. */
  readonly lightSector: number;
  /** Two-sided middle quads don't tile vertically and use alpha testing. */
  readonly masked: boolean;
}

export interface TextureSize {
  readonly width: number;
  readonly height: number;
}

export function buildWallQuads(
  map: MapData,
  textureSizes: ReadonlyMap<string, TextureSize>,
): WallQuad[] {
  const quads: WallQuad[] = [];

  for (let li = 0; li < map.linedefs.length; li++) {
    const ld = map.linedefs[li]!;
    const v1 = map.vertexes[ld.v1]!;
    const v2 = map.vertexes[ld.v2]!;
    const length = Math.sqrt((v2.x - v1.x) ** 2 + (v2.y - v1.y) ** 2);
    if (length === 0) continue;

    for (const side of [0, 1] as const) {
      const sidenum = ld.sidenum[side];
      if (sidenum === 0xffff) continue;
      const sd = map.sidedefs[sidenum]!;
      const otherSidenum = ld.sidenum[(side ^ 1) as 0 | 1];
      const other = otherSidenum !== 0xffff ? map.sidedefs[otherSidenum] : undefined;
      const front = map.sectors[sd.sector]!;
      // Facing direction: side 0 sees v1->v2, side 1 sees v2->v1.
      const [ax, ay, bx, by] =
        side === 0 ? [v1.x, v1.y, v2.x, v2.y] : [v2.x, v2.y, v1.x, v1.y];
      const u1 = sd.textureOffset;
      const u2 = sd.textureOffset + length;

      const push = (
        kind: WallKind,
        texture: string,
        bottom: number,
        top: number,
        vTop: number,
        bindings: WallQuad['bindings'],
        masked = false,
      ) => {
        if (texture === '-' || top <= bottom) return;
        quads.push({
          texture, kind, linedef: li, side,
          x1: ax, y1: ay, x2: bx, y2: by,
          bottom, top, bindings, u1, u2,
          vTop: vTop + sd.rowOffset,
          lightSector: sd.sector,
          masked,
        });
      };

      if (!other) {
        // One-sided: middle from floor to ceiling. Default pegs the
        // texture top to the ceiling; lower-unpegged pegs its bottom to
        // the floor (texture top = floor + texHeight).
        const tex = textureSizes.get(sd.midTexture);
        const vTop =
          ld.flags & ML_DONTPEGBOTTOM
            ? front.floorHeight + (tex?.height ?? 128)
            : front.ceilingHeight;
        push('middle', sd.midTexture, front.floorHeight, front.ceilingHeight, vTop, {
          top: { sector: sd.sector, plane: 'ceiling' },
          bottom: { sector: sd.sector, plane: 'floor' },
        });
        continue;
      }

      const back = map.sectors[other.sector]!;

      // Upper section: between the two ceilings. Default pegs the texture
      // bottom to the lower ceiling; upper-unpegged pegs its top to the
      // higher ceiling.
      if (back.ceilingHeight < front.ceilingHeight) {
        const tex = textureSizes.get(sd.topTexture);
        const vTop =
          ld.flags & ML_DONTPEGTOP
            ? front.ceilingHeight
            : back.ceilingHeight + (tex?.height ?? 128);
        push('upper', sd.topTexture, back.ceilingHeight, front.ceilingHeight, vTop, {
          top: { sector: sd.sector, plane: 'ceiling' },
          bottom: { sector: other.sector, plane: 'ceiling' },
        });
      }

      // Lower section: between the two floors. Default pegs the texture
      // top to the higher floor; lower-unpegged draws it as if it started
      // at the (front) ceiling.
      if (back.floorHeight > front.floorHeight) {
        const vTop =
          ld.flags & ML_DONTPEGBOTTOM ? front.ceilingHeight : back.floorHeight;
        push('lower', sd.bottomTexture, front.floorHeight, back.floorHeight, vTop, {
          top: { sector: other.sector, plane: 'floor' },
          bottom: { sector: sd.sector, plane: 'floor' },
        });
      }

      // Two-sided middle (masked, e.g. grates): clamped to one texture
      // height within the shared opening; never tiles vertically.
      if (sd.midTexture !== '-') {
        const tex = textureSizes.get(sd.midTexture);
        const texH = tex?.height ?? 128;
        const openBottom = Math.max(front.floorHeight, back.floorHeight);
        const openTop = Math.min(front.ceilingHeight, back.ceilingHeight);
        let top: number;
        let bottom: number;
        if (ld.flags & ML_DONTPEGBOTTOM) {
          bottom = Math.max(openBottom, openBottom + sd.rowOffset);
          top = Math.min(openTop, bottom + texH);
          bottom = Math.max(bottom, top - texH);
        } else {
          top = Math.min(openTop, openTop + sd.rowOffset);
          bottom = Math.max(openBottom, top - texH);
        }
        if (top > bottom) {
          quads.push({
            texture: sd.midTexture, kind: 'midtwo', linedef: li, side,
            x1: ax, y1: ay, x2: bx, y2: by,
            bottom, top, u1, u2, vTop: top,
            // Masked middles don't stretch with the sector in vanilla.
            bindings: { top: null, bottom: null },
            lightSector: sd.sector,
            masked: true,
          });
        }
      }
    }
  }
  return quads;
}
