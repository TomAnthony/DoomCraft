// Map lump parsing: raw on-disk structs decoded into plain objects.
// The sim's p_setup builds its runtime structures from these.
// Formats: https://doomwiki.org/wiki/Doom_level_format

import type { WadFile } from './wad.ts';

export interface MapThing {
  readonly x: number;
  readonly y: number;
  readonly angle: number; // degrees, 0/45/90/...
  readonly type: number; // doomednum
  readonly options: number; // skill/mode flags
}

export interface MapLinedef {
  readonly v1: number;
  readonly v2: number;
  readonly flags: number;
  readonly special: number;
  readonly tag: number;
  readonly sidenum: readonly [number, number]; // 0xffff (=-1) if absent
}

export interface MapSidedef {
  readonly textureOffset: number;
  readonly rowOffset: number;
  readonly topTexture: string;
  readonly bottomTexture: string;
  readonly midTexture: string;
  readonly sector: number;
}

export interface MapVertex {
  readonly x: number;
  readonly y: number;
}

export interface MapSeg {
  readonly v1: number;
  readonly v2: number;
  readonly angle: number;
  readonly linedef: number;
  readonly side: number; // 0 or 1
  readonly offset: number;
}

export interface MapSubsector {
  readonly numsegs: number;
  readonly firstseg: number;
}

export interface MapNode {
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  /** [right, left] bounding boxes as [top, bottom, left, right]. */
  readonly bbox: readonly [readonly number[], readonly number[]];
  /** Child node index; bit 15 set = subsector. */
  readonly children: readonly [number, number];
}

export interface MapSector {
  readonly floorHeight: number;
  readonly ceilingHeight: number;
  readonly floorPic: string;
  readonly ceilingPic: string;
  readonly lightLevel: number;
  readonly special: number;
  readonly tag: number;
}

export interface MapData {
  readonly name: string;
  readonly things: readonly MapThing[];
  readonly linedefs: readonly MapLinedef[];
  readonly sidedefs: readonly MapSidedef[];
  readonly vertexes: readonly MapVertex[];
  readonly segs: readonly MapSeg[];
  readonly subsectors: readonly MapSubsector[];
  readonly nodes: readonly MapNode[];
  readonly sectors: readonly MapSector[];
  /** Raw lump bytes; interpreted by p_setup. */
  readonly blockmap: Uint8Array;
  readonly reject: Uint8Array;
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

function mapLumpView(wad: WadFile, mapIndex: number, name: string, offsetInMap: number): DataView {
  const lump = wad.lumps[mapIndex + offsetInMap];
  if (!lump || lump.name !== name) {
    throw new Error(`expected ${name} at directory slot ${mapIndex + offsetInMap}, found ${lump?.name}`);
  }
  return wad.viewOf(lump);
}

export function readMap(wad: WadFile, mapName: string): MapData {
  const mapIndex = wad.indexOf(mapName);
  if (mapIndex < 0) throw new Error(`map ${mapName} not found`);

  const things: MapThing[] = [];
  {
    const v = mapLumpView(wad, mapIndex, 'THINGS', 1);
    for (let at = 0; at + 10 <= v.byteLength; at += 10) {
      things.push({
        x: v.getInt16(at, true),
        y: v.getInt16(at + 2, true),
        angle: v.getInt16(at + 4, true),
        type: v.getInt16(at + 6, true),
        options: v.getInt16(at + 8, true),
      });
    }
  }

  const linedefs: MapLinedef[] = [];
  {
    const v = mapLumpView(wad, mapIndex, 'LINEDEFS', 2);
    for (let at = 0; at + 14 <= v.byteLength; at += 14) {
      linedefs.push({
        v1: v.getUint16(at, true),
        v2: v.getUint16(at + 2, true),
        flags: v.getInt16(at + 4, true),
        special: v.getInt16(at + 6, true),
        tag: v.getInt16(at + 8, true),
        sidenum: [v.getUint16(at + 10, true), v.getUint16(at + 12, true)],
      });
    }
  }

  const sidedefs: MapSidedef[] = [];
  {
    const v = mapLumpView(wad, mapIndex, 'SIDEDEFS', 3);
    for (let at = 0; at + 30 <= v.byteLength; at += 30) {
      sidedefs.push({
        textureOffset: v.getInt16(at, true),
        rowOffset: v.getInt16(at + 2, true),
        topTexture: readName8(v, at + 4),
        bottomTexture: readName8(v, at + 12),
        midTexture: readName8(v, at + 20),
        sector: v.getInt16(at + 28, true),
      });
    }
  }

  const vertexes: MapVertex[] = [];
  {
    const v = mapLumpView(wad, mapIndex, 'VERTEXES', 4);
    for (let at = 0; at + 4 <= v.byteLength; at += 4) {
      vertexes.push({ x: v.getInt16(at, true), y: v.getInt16(at + 2, true) });
    }
  }

  const segs: MapSeg[] = [];
  {
    const v = mapLumpView(wad, mapIndex, 'SEGS', 5);
    for (let at = 0; at + 12 <= v.byteLength; at += 12) {
      segs.push({
        v1: v.getUint16(at, true),
        v2: v.getUint16(at + 2, true),
        angle: v.getInt16(at + 4, true),
        linedef: v.getUint16(at + 6, true),
        side: v.getInt16(at + 8, true),
        offset: v.getInt16(at + 10, true),
      });
    }
  }

  const subsectors: MapSubsector[] = [];
  {
    const v = mapLumpView(wad, mapIndex, 'SSECTORS', 6);
    for (let at = 0; at + 4 <= v.byteLength; at += 4) {
      subsectors.push({ numsegs: v.getUint16(at, true), firstseg: v.getUint16(at + 2, true) });
    }
  }

  const nodes: MapNode[] = [];
  {
    const v = mapLumpView(wad, mapIndex, 'NODES', 7);
    for (let at = 0; at + 28 <= v.byteLength; at += 28) {
      const bboxRight: number[] = [];
      const bboxLeft: number[] = [];
      for (let i = 0; i < 4; i++) {
        bboxRight.push(v.getInt16(at + 8 + i * 2, true));
        bboxLeft.push(v.getInt16(at + 16 + i * 2, true));
      }
      nodes.push({
        x: v.getInt16(at, true),
        y: v.getInt16(at + 2, true),
        dx: v.getInt16(at + 4, true),
        dy: v.getInt16(at + 6, true),
        bbox: [bboxRight, bboxLeft],
        children: [v.getUint16(at + 24, true), v.getUint16(at + 26, true)],
      });
    }
  }

  const sectors: MapSector[] = [];
  {
    const v = mapLumpView(wad, mapIndex, 'SECTORS', 8);
    for (let at = 0; at + 26 <= v.byteLength; at += 26) {
      sectors.push({
        floorHeight: v.getInt16(at, true),
        ceilingHeight: v.getInt16(at + 2, true),
        floorPic: readName8(v, at + 4),
        ceilingPic: readName8(v, at + 12),
        lightLevel: v.getInt16(at + 20, true),
        special: v.getInt16(at + 22, true),
        tag: v.getInt16(at + 24, true),
      });
    }
  }

  const blockmapLump = wad.lumps[mapIndex + 10];
  const rejectLump = wad.lumps[mapIndex + 9];
  if (rejectLump?.name !== 'REJECT' || blockmapLump?.name !== 'BLOCKMAP') {
    throw new Error(`unexpected lump order after ${mapName}`);
  }

  return {
    name: mapName,
    things, linedefs, sidedefs, vertexes, segs, subsectors, nodes, sectors,
    blockmap: wad.read(blockmapLump),
    reject: wad.read(rejectLump),
  };
}

/** All MAPxx names present in the WAD, in order. */
export function listMaps(wad: WadFile): string[] {
  return wad.lumps.filter((l) => /^MAP\d\d$/.test(l.name)).map((l) => l.name);
}
