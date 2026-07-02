// Render-side BSP point location (float math is fine here — the sim will
// get its own fixed-point R_PointInSubsector port in p_maputl).

import type { MapData } from '../wad/maps.ts';

const NF_SUBSECTOR = 0x8000;

/** Subsector index containing the map point. */
export function pointInSubsector(map: MapData, x: number, y: number): number {
  if (map.nodes.length === 0) return 0;
  let nodeNum = map.nodes.length - 1;
  while (!(nodeNum & NF_SUBSECTOR)) {
    const node = map.nodes[nodeNum]!;
    // Which side of the partition line? 0 = right/front, 1 = left/back.
    // Vanilla R_PointOnSide: side 0 iff dy*node.dx < node.dy*dx.
    const dx = x - node.x;
    const dy = y - node.y;
    const side = node.dy * dx - node.dx * dy > 0 ? 0 : 1;
    nodeNum = node.children[side]!;
  }
  return nodeNum & ~NF_SUBSECTOR;
}

/** Sector index containing the map point. */
export function pointInSector(map: MapData, x: number, y: number): number {
  const ss = map.subsectors[pointInSubsector(map, x, y)];
  const seg = ss && map.segs[ss.firstseg];
  if (!seg) return 0;
  const ld = map.linedefs[seg.linedef]!;
  const sidenum = ld.sidenum[seg.side === 0 ? 0 : 1];
  return sidenum !== 0xffff ? (map.sidedefs[sidenum]?.sector ?? 0) : 0;
}
