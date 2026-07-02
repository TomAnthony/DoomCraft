// Sector floor/ceiling triangulation.
//
// Doom sectors are defined implicitly by the linedefs that face them:
// the front (right) side of a linedef faces its sidedef's sector. We
// chain directed edges into closed loops, classify outer boundaries vs
// holes by signed area, group holes into their containing outer loop,
// and triangulate with earcut. Degenerate sectors (self-referencing
// tricks, unclosed chains) fall back to convex fans over BSP subsector
// segs, which are guaranteed renderable.

import earcut from 'earcut';
import type { MapData } from '../wad/maps.ts';

export interface SectorTriangulation {
  readonly sector: number;
  /** Flat [x, y, x, y, ...] map coordinates. */
  readonly positions: Float32Array;
  /** Triangle indices into positions. */
  readonly indices: Uint32Array;
  readonly usedFallback: boolean;
}

interface Loop {
  readonly points: number[]; // flat x,y
  readonly area: number; // signed (positive = CCW in map coords)
}

function buildLoops(map: MapData, sector: number): Loop[] | null {
  // Weld vertices by coordinate: maps sometimes use distinct vertex
  // entries at identical positions, which breaks index-based chaining.
  const weld = new Map<string, number>();
  const canon = (v: number): number => {
    const vert = map.vertexes[v]!;
    const key = `${vert.x},${vert.y}`;
    const existing = weld.get(key);
    if (existing !== undefined) return existing;
    weld.set(key, v);
    return v;
  };

  // Directed edges with the sector interior on the right: front side
  // contributes v1->v2, back side contributes v2->v1.
  const edges = new Map<number, number[]>(); // from-vertex -> to-vertices
  let edgeCount = 0;
  for (const ld of map.linedefs) {
    const front = ld.sidenum[0] !== 0xffff ? map.sidedefs[ld.sidenum[0]]?.sector : undefined;
    const back = ld.sidenum[1] !== 0xffff ? map.sidedefs[ld.sidenum[1]]?.sector : undefined;
    if (front === sector && back === sector) continue; // self-referencing: hopeless here
    const [a, b] =
      front === sector ? [canon(ld.v1), canon(ld.v2)] :
      back === sector ? [canon(ld.v2), canon(ld.v1)] : [-1, -1];
    if (a === -1 || a === b) continue;
    (edges.get(a) ?? edges.set(a, []).get(a)!).push(b);
    edgeCount++;
  }
  if (edgeCount === 0) return null;

  // Some IWAD sectors have unclosed boundaries (e.g. MAP22's start
  // sector). Repair by bridging each missing-out vertex to the nearest
  // missing-in vertex, like other robust ports do.
  {
    const inDeg = new Map<number, number>();
    for (const outs of edges.values()) {
      for (const to of outs) inDeg.set(to, (inDeg.get(to) ?? 0) + 1);
    }
    const needOut: number[] = []; // in > out: chain arrives but never leaves
    const needIn: number[] = []; // out > in
    const all = new Set([...edges.keys(), ...inDeg.keys()]);
    for (const v of all) {
      const diff = (inDeg.get(v) ?? 0) - (edges.get(v)?.length ?? 0);
      for (let i = 0; i < diff; i++) needOut.push(v);
      for (let i = 0; i < -diff; i++) needIn.push(v);
    }
    if (needOut.length !== needIn.length || needOut.length > 8) {
      if (needOut.length + needIn.length > 0) return null;
    } else {
      for (const from of needOut) {
        let best = -1;
        let bestDist = Infinity;
        const fv = map.vertexes[from]!;
        for (let i = 0; i < needIn.length; i++) {
          const to = needIn[i]!;
          if (to === -1 || to === from) continue;
          const tv = map.vertexes[to]!;
          const d = (tv.x - fv.x) ** 2 + (tv.y - fv.y) ** 2;
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
        if (best < 0) return null;
        (edges.get(from) ?? edges.set(from, []).get(from)!).push(needIn[best]!);
        needIn[best] = -1;
      }
    }
  }

  const loops: Loop[] = [];
  const takeNext = (from: number): number | undefined => {
    const outs = edges.get(from);
    if (!outs || outs.length === 0) return undefined;
    return outs.pop();
  };

  for (const [start] of edges) {
    for (;;) {
      // Start a new loop from any remaining out-edge of this vertex.
      let current = start;
      let next = takeNext(current);
      if (next === undefined) break;
      const chain = [current];
      while (next !== undefined && next !== chain[0]) {
        chain.push(next);
        current = next;
        next = takeNext(current);
      }
      if (next === undefined) return null; // unclosed chain — fallback
      // Closed loop; compute signed area (shoelace).
      const points: number[] = [];
      let area = 0;
      for (let i = 0; i < chain.length; i++) {
        const a = map.vertexes[chain[i]!]!;
        const b = map.vertexes[chain[(i + 1) % chain.length]!]!;
        points.push(a.x, a.y);
        area += a.x * b.y - b.x * a.y;
      }
      if (area !== 0) loops.push({ points, area: area / 2 });
    }
  }
  return loops.length > 0 ? loops : null;
}

function pointInPolygon(x: number, y: number, points: number[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    const xi = points[i]!, yi = points[i + 1]!;
    const xj = points[j]!, yj = points[j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function triangulateLoops(sector: number, loops: Loop[]): SectorTriangulation {
  // Interior on the right of each directed edge means outer boundaries
  // wind clockwise (negative shoelace area) and holes counter-clockwise.
  const outers = loops.filter((l) => l.area < 0);
  const holes = loops.filter((l) => l.area > 0);

  const positions: number[] = [];
  const indices: number[] = [];
  for (const outer of outers) {
    const myHoles = holes.filter((h) =>
      pointInPolygon(h.points[0]!, h.points[1]!, outer.points),
    );
    const verts = [...outer.points];
    const holeIndices: number[] = [];
    for (const h of myHoles) {
      holeIndices.push(verts.length / 2);
      verts.push(...h.points);
    }
    const base = positions.length / 2;
    const tris = earcut(verts, holeIndices.length ? holeIndices : undefined);
    positions.push(...verts);
    for (const t of tris) indices.push(base + t);
  }
  return {
    sector,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    usedFallback: false,
  };
}

/** Convex fan over each BSP subsector belonging to the sector. */
function fallbackFans(map: MapData, sector: number): SectorTriangulation {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const ss of map.subsectors) {
    const first = map.segs[ss.firstseg];
    if (!first) continue;
    const ld = map.linedefs[first.linedef]!;
    const sidenum = ld.sidenum[first.side === 0 ? 0 : 1];
    if (sidenum === 0xffff || map.sidedefs[sidenum]?.sector !== sector) continue;
    const pts: number[] = [];
    for (let i = 0; i < ss.numsegs; i++) {
      const seg = map.segs[ss.firstseg + i]!;
      const v = map.vertexes[seg.v1]!;
      pts.push(v.x, v.y);
    }
    if (pts.length < 6) continue;
    const base = positions.length / 2;
    positions.push(...pts);
    for (let i = 1; i < pts.length / 2 - 1; i++) {
      indices.push(base, base + i, base + i + 1);
    }
  }
  return {
    sector,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    usedFallback: true,
  };
}

export function triangulateSector(map: MapData, sector: number): SectorTriangulation {
  const loops = buildLoops(map, sector);
  if (loops) {
    const result = triangulateLoops(sector, loops);
    if (result.indices.length > 0) return result;
  }
  return fallbackFans(map, sector);
}

export function triangulateAllSectors(map: MapData): SectorTriangulation[] {
  return map.sectors.map((_, i) => triangulateSector(map, i));
}
