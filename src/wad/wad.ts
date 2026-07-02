// WAD container parsing: header, directory, lump lookup, marker namespaces.
// Format: https://doomwiki.org/wiki/WAD (all values little-endian).

export interface Lump {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  readonly index: number;
}

function readName(bytes: Uint8Array, offset: number): string {
  let end = offset;
  const stop = offset + 8;
  while (end < stop && bytes[end] !== 0) end++;
  // Lump names are ASCII; uppercase for case-insensitive lookup.
  return String.fromCharCode(...bytes.subarray(offset, end)).toUpperCase();
}

export class WadFile {
  readonly type: 'IWAD' | 'PWAD';
  readonly lumps: readonly Lump[];
  readonly bytes: Uint8Array;
  readonly view: DataView;
  // Last occurrence wins, matching vanilla W_GetNumForName search order.
  private readonly byName = new Map<string, number>();

  constructor(buffer: ArrayBuffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    const magic = String.fromCharCode(...this.bytes.subarray(0, 4));
    if (magic !== 'IWAD' && magic !== 'PWAD') {
      throw new Error(`not a WAD file (magic ${JSON.stringify(magic)})`);
    }
    this.type = magic;
    const numLumps = this.view.getInt32(4, true);
    const dirOffset = this.view.getInt32(8, true);
    const lumps: Lump[] = [];
    for (let i = 0; i < numLumps; i++) {
      const entry = dirOffset + i * 16;
      lumps.push({
        offset: this.view.getInt32(entry, true),
        size: this.view.getInt32(entry + 4, true),
        name: readName(this.bytes, entry + 8),
        index: i,
      });
      this.byName.set(lumps[i]!.name, i);
    }
    this.lumps = lumps;
  }

  indexOf(name: string): number {
    return this.byName.get(name.toUpperCase()) ?? -1;
  }

  has(name: string): boolean {
    return this.indexOf(name) >= 0;
  }

  lump(name: string): Lump {
    const i = this.indexOf(name);
    if (i < 0) throw new Error(`lump ${name} not found`);
    return this.lumps[i]!;
  }

  read(lump: Lump | string): Uint8Array {
    const l = typeof lump === 'string' ? this.lump(lump) : lump;
    return this.bytes.subarray(l.offset, l.offset + l.size);
  }

  viewOf(lump: Lump | string): DataView {
    const l = typeof lump === 'string' ? this.lump(lump) : lump;
    return new DataView(this.bytes.buffer, l.offset, l.size);
  }

  /** Non-marker lumps strictly between two marker lumps (e.g. S_START/S_END). */
  between(startMarker: string, endMarker: string): Lump[] {
    const start = this.indexOf(startMarker);
    const end = this.indexOf(endMarker);
    if (start < 0 || end < 0 || end <= start) return [];
    return this.lumps.slice(start + 1, end).filter((l) => l.size > 0);
  }
}

/** SHA-256 of the whole WAD; used by the lobby to refuse mismatched WADs. */
export async function hashWad(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
