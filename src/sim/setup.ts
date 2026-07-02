// Level setup, ported from p_setup.c: converts parsed map lumps into
// runtime fixed-point structures and links everything together.

import type { MapData } from '../wad/maps.ts';
import {
  BOXBOTTOM, BOXLEFT, BOXRIGHT, BOXTOP,
  MAPBLOCKSHIFT, MAXRADIUS, SlopeType,
} from './defs.ts';
import { FRACBITS, FixedDiv, type Fixed } from './fixed.ts';
import { BspNode, Line, Mobj, Sector, Seg, Side, Subsector, Vertex } from './world.ts';

export class World {
  vertexes: Vertex[] = [];
  sectors: Sector[] = [];
  sides: Side[] = [];
  lines: Line[] = [];
  subsectors: Subsector[] = [];
  segs: Seg[] = [];
  nodes: BspNode[] = [];
  /** raw blockmap shorts (native-endian), header included */
  blockmaplump = new Int16Array(0);
  /** offset table starts 4 shorts in */
  bmaporgx: Fixed = 0;
  bmaporgy: Fixed = 0;
  bmapwidth = 0;
  bmapheight = 0;
  /** head of mobj chain per block */
  blocklinks: (Mobj | null)[] = [];
  reject: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  validcount = 0;
}

export function setupWorld(map: MapData): World {
  const w = new World();

  for (const v of map.vertexes) {
    w.vertexes.push(new Vertex(v.x << FRACBITS, v.y << FRACBITS));
  }

  map.sectors.forEach((ms, i) => {
    const s = new Sector(i);
    s.floorheight = ms.floorHeight << FRACBITS;
    s.ceilingheight = ms.ceilingHeight << FRACBITS;
    s.floorpic = ms.floorPic;
    s.ceilingpic = ms.ceilingPic;
    s.lightlevel = ms.lightLevel;
    s.special = ms.special;
    s.tag = ms.tag;
    w.sectors.push(s);
  });

  for (const msd of map.sidedefs) {
    const sd = new Side();
    sd.textureoffset = msd.textureOffset << FRACBITS;
    sd.rowoffset = msd.rowOffset << FRACBITS;
    sd.toptexture = msd.topTexture;
    sd.bottomtexture = msd.bottomTexture;
    sd.midtexture = msd.midTexture;
    sd.sector = w.sectors[msd.sector]!;
    w.sides.push(sd);
  }

  map.linedefs.forEach((mld, i) => {
    const ld = new Line(i);
    ld.flags = mld.flags;
    ld.special = mld.special;
    ld.tag = mld.tag;
    const v1 = w.vertexes[mld.v1]!;
    const v2 = w.vertexes[mld.v2]!;
    ld.v1 = v1;
    ld.v2 = v2;
    ld.dx = (v2.x - v1.x) | 0;
    ld.dy = (v2.y - v1.y) | 0;

    if (!ld.dx) ld.slopetype = SlopeType.Vertical;
    else if (!ld.dy) ld.slopetype = SlopeType.Horizontal;
    else if (FixedDiv(ld.dy, ld.dx) > 0) ld.slopetype = SlopeType.Positive;
    else ld.slopetype = SlopeType.Negative;

    if (v1.x < v2.x) {
      ld.bbox[BOXLEFT] = v1.x;
      ld.bbox[BOXRIGHT] = v2.x;
    } else {
      ld.bbox[BOXLEFT] = v2.x;
      ld.bbox[BOXRIGHT] = v1.x;
    }
    if (v1.y < v2.y) {
      ld.bbox[BOXBOTTOM] = v1.y;
      ld.bbox[BOXTOP] = v2.y;
    } else {
      ld.bbox[BOXBOTTOM] = v2.y;
      ld.bbox[BOXTOP] = v1.y;
    }

    // 0xffff in the file means "no side" (-1 after signed read).
    const s0 = mld.sidenum[0] === 0xffff ? -1 : mld.sidenum[0];
    const s1 = mld.sidenum[1] === 0xffff ? -1 : mld.sidenum[1];
    ld.sidenum = [s0, s1];
    ld.frontsector = s0 !== -1 ? w.sides[s0]!.sector : null;
    ld.backsector = s1 !== -1 ? w.sides[s1]!.sector : null;
    w.lines.push(ld);
  });

  map.segs.forEach((ms) => {
    const seg = new Seg();
    seg.v1 = w.vertexes[ms.v1]!;
    seg.v2 = w.vertexes[ms.v2]!;
    seg.angle = (ms.angle << FRACBITS) | 0;
    seg.offset = ms.offset << FRACBITS;
    const ldef = w.lines[ms.linedef]!;
    seg.linedef = ldef;
    const side = ms.side;
    seg.sidedef = w.sides[ldef.sidenum[side === 0 ? 0 : 1]!]!;
    seg.frontsector = seg.sidedef.sector;
    if (ldef.flags & 4 /* ML_TWOSIDED */) {
      const sidenum = ldef.sidenum[side === 0 ? 1 : 0]!;
      seg.backsector = sidenum >= 0 && sidenum < w.sides.length
        ? w.sides[sidenum]!.sector
        : w.sectors[0]!; // "glass hack" fallback (GetSectorAtNullAddress)
    } else {
      seg.backsector = null;
    }
    w.segs.push(seg);
  });

  for (const ms of map.subsectors) {
    const ss = new Subsector();
    ss.numlines = ms.numsegs;
    ss.firstline = ms.firstseg;
    w.subsectors.push(ss);
  }

  for (const mn of map.nodes) {
    const node = new BspNode();
    node.x = mn.x << FRACBITS;
    node.y = mn.y << FRACBITS;
    node.dx = mn.dx << FRACBITS;
    node.dy = mn.dy << FRACBITS;
    node.children = [mn.children[0], mn.children[1]];
    for (let j = 0; j < 2; j++) {
      for (let k = 0; k < 4; k++) {
        node.bbox[j as 0 | 1][k] = mn.bbox[j as 0 | 1][k]! << FRACBITS;
      }
    }
    w.nodes.push(node);
  }

  // Blockmap: native-endian shorts, header = [orgx, orgy, width, height].
  const bm = map.blockmap;
  const lump = new Int16Array(bm.length >> 1);
  const view = new DataView(bm.buffer, bm.byteOffset, bm.byteLength);
  for (let i = 0; i < lump.length; i++) lump[i] = view.getInt16(i * 2, true);
  w.blockmaplump = lump;
  w.bmaporgx = lump[0]! << FRACBITS;
  w.bmaporgy = lump[1]! << FRACBITS;
  w.bmapwidth = lump[2]!;
  w.bmapheight = lump[3]!;
  w.blocklinks = new Array<Mobj | null>(w.bmapwidth * w.bmapheight).fill(null);
  w.reject = map.reject;

  groupLines(w);
  return w;
}

// P_GroupLines: subsector sectors, per-sector line lists, sector bboxes.
function groupLines(w: World): void {
  for (const ss of w.subsectors) {
    ss.sector = w.segs[ss.firstline]!.sidedef.sector;
  }

  // Assign lines to sectors (order matches vanilla's two-pass fill).
  for (const li of w.lines) {
    if (li.frontsector) li.frontsector.lines.push(li);
    if (li.backsector && li.backsector !== li.frontsector) {
      li.backsector.lines.push(li);
    }
  }

  for (const sector of w.sectors) {
    // M_ClearBox / M_AddToBox
    const bbox = [-2147483648, 2147483647, 2147483647, -2147483648]; // top, bottom, left, right
    for (const li of sector.lines) {
      for (const v of [li.v1, li.v2]) {
        if (v.x < bbox[BOXLEFT]!) bbox[BOXLEFT] = v.x;
        if (v.x > bbox[BOXRIGHT]!) bbox[BOXRIGHT] = v.x;
        if (v.y < bbox[BOXBOTTOM]!) bbox[BOXBOTTOM] = v.y;
        if (v.y > bbox[BOXTOP]!) bbox[BOXTOP] = v.y;
      }
    }
    sector.soundorgX = ((bbox[BOXRIGHT]! + bbox[BOXLEFT]!) / 2) | 0;
    sector.soundorgY = ((bbox[BOXTOP]! + bbox[BOXBOTTOM]!) / 2) | 0;

    let block = (bbox[BOXTOP]! - w.bmaporgy + MAXRADIUS) >> MAPBLOCKSHIFT;
    sector.blockbox[BOXTOP] = block >= w.bmapheight ? w.bmapheight - 1 : block;
    block = (bbox[BOXBOTTOM]! - w.bmaporgy - MAXRADIUS) >> MAPBLOCKSHIFT;
    sector.blockbox[BOXBOTTOM] = block < 0 ? 0 : block;
    block = (bbox[BOXRIGHT]! - w.bmaporgx + MAXRADIUS) >> MAPBLOCKSHIFT;
    sector.blockbox[BOXRIGHT] = block >= w.bmapwidth ? w.bmapwidth - 1 : block;
    block = (bbox[BOXLEFT]! - w.bmaporgx - MAXRADIUS) >> MAPBLOCKSHIFT;
    sector.blockbox[BOXLEFT] = block < 0 ? 0 : block;
  }
}
