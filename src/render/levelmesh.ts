// Builds the Three.js scene for a level: sector flats, wall quads, and
// thing sprites, batched by texture with per-sector/per-quad ranges
// recorded so sector movement (M4) can update vertices in place.
//
// Coordinates: three.x = map.x, three.y = height z, three.z = -map.y.

import * as THREE from 'three';
import type { MapData } from '../wad/maps.ts';
import { MF, MT, mobjinfo, states } from '../sim/data/info.gen.ts';
import { sprnames } from '../sim/data/info.gen.ts';
import { FRACUNIT } from '../sim/fixed.ts';
import { pointInSector } from './bsp.ts';
import { makeSurfaceMaterial } from './materials.ts';
import { triangulateAllSectors } from './sectorpolys.ts';
import { buildSpriteTable, rotationFor, type SpriteTable } from './sprites.ts';
import type { TextureStore } from './textures.ts';
import type { WadFile } from '../wad/wad.ts';
import { buildWallQuads, type TextureSize, type WallQuad } from './walls.ts';

export const SKY_FLAT = 'F_SKY1';
const FF_FRAMEMASK = 0x7fff;
const FF_FULLBRIGHT = 0x8000;

interface FlatRange {
  readonly sector: number;
  readonly plane: 'floor' | 'ceiling';
  readonly vertexStart: number;
  readonly vertexCount: number;
}

interface WallRange {
  readonly quad: WallQuad;
  readonly vertexStart: number;
}

interface SpriteInstance {
  readonly mesh: THREE.Mesh;
  readonly spr: string;
  readonly frame: number;
  readonly angle: number; // radians
  readonly x: number;
  readonly y: number; // map coords
  readonly fullBright: boolean;
  readonly light: number;
  currentLump: string | null;
}

export class LevelMesh {
  readonly group = new THREE.Group();
  private readonly flatRanges = new Map<string, { geometry: THREE.BufferGeometry; ranges: FlatRange[] }>();
  private readonly wallRanges = new Map<string, { geometry: THREE.BufferGeometry; ranges: WallRange[] }>();
  private readonly sprites: SpriteInstance[] = [];
  private readonly spriteTable: SpriteTable;
  private readonly spriteMaterials = new Map<string, THREE.ShaderMaterial>();

  /** last applied per-sector values for dynamic updates */
  private lastFloor: Float64Array;
  private lastCeil: Float64Array;
  private lastLight: Float64Array;
  private readonly dynamic: boolean;

  constructor(
    private readonly map: MapData,
    private readonly store: TextureStore,
    wad: WadFile,
    opts?: { dynamic?: boolean },
  ) {
    this.dynamic = opts?.dynamic ?? false;
    this.spriteTable = buildSpriteTable(wad);
    this.lastFloor = new Float64Array(map.sectors.length);
    this.lastCeil = new Float64Array(map.sectors.length);
    this.lastLight = new Float64Array(map.sectors.length);
    map.sectors.forEach((s, i) => {
      this.lastFloor[i] = s.floorHeight;
      this.lastCeil[i] = s.ceilingHeight;
      this.lastLight[i] = s.lightLevel;
    });
    this.buildFlats();
    this.buildWalls();
    if (!this.dynamic) this.buildThings();
  }

  /**
   * Apply interpolated sector floor/ceiling heights (world units) and
   * light levels. Only geometry belonging to changed sectors is touched.
   */
  updateSectors(floors: Float64Array, ceils: Float64Array, lights: Float64Array): void {
    const changed = new Set<number>();
    for (let i = 0; i < floors.length; i++) {
      if (
        floors[i] !== this.lastFloor[i] ||
        ceils[i] !== this.lastCeil[i] ||
        lights[i] !== this.lastLight[i]
      ) {
        changed.add(i);
      }
    }
    if (changed.size === 0) return;

    for (const { geometry, ranges } of this.flatRanges.values()) {
      const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
      const light = geometry.getAttribute('light') as THREE.BufferAttribute;
      let dirty = false;
      for (const r of ranges) {
        if (!changed.has(r.sector)) continue;
        const h = r.plane === 'floor' ? floors[r.sector]! : ceils[r.sector]!;
        const l = lights[r.sector]!;
        for (let v = r.vertexStart; v < r.vertexStart + r.vertexCount; v++) {
          pos.setY(v, h);
          light.setX(v, l);
        }
        dirty = true;
      }
      if (dirty) {
        pos.needsUpdate = true;
        light.needsUpdate = true;
      }
    }

    for (const [texName, { geometry, ranges }] of this.wallRanges) {
      const entry = this.store.wallTexture(texName)!;
      const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
      const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
      const light = geometry.getAttribute('light') as THREE.BufferAttribute;
      let dirty = false;
      for (const { quad, vertexStart } of ranges) {
        const bindsChanged =
          (quad.bindings.top && changed.has(quad.bindings.top.sector)) ||
          (quad.bindings.bottom && changed.has(quad.bindings.bottom.sector)) ||
          (quad.vtopBind && changed.has(quad.vtopBind.sector)) ||
          changed.has(quad.lightSector);
        if (!bindsChanged) continue;

        const heightOf = (b: { sector: number; plane: 'floor' | 'ceiling' }) =>
          b.plane === 'floor' ? floors[b.sector]! : ceils[b.sector]!;
        const bottom = quad.bindings.bottom ? heightOf(quad.bindings.bottom) : quad.bottom;
        let top = quad.bindings.top ? heightOf(quad.bindings.top) : quad.top;
        if (top < bottom) top = bottom; // degenerate (closed) section
        const vTop = quad.vtopBind
          ? heightOf(quad.vtopBind) + quad.vtopBind.add
          : quad.vTop;

        pos.setY(vertexStart, bottom);
        pos.setY(vertexStart + 1, bottom);
        pos.setY(vertexStart + 2, top);
        pos.setY(vertexStart + 3, top);
        const h = entry.height;
        uv.setY(vertexStart, (vTop - bottom) / h);
        uv.setY(vertexStart + 1, (vTop - bottom) / h);
        uv.setY(vertexStart + 2, (vTop - top) / h);
        uv.setY(vertexStart + 3, (vTop - top) / h);

        let l = lights[quad.lightSector]!;
        if (quad.y1 === quad.y2) l = Math.max(0, l - 16);
        else if (quad.x1 === quad.x2) l = Math.min(255, l + 16);
        for (let v = vertexStart; v < vertexStart + 4; v++) light.setX(v, l);
        dirty = true;
      }
      if (dirty) {
        pos.needsUpdate = true;
        uv.needsUpdate = true;
        light.needsUpdate = true;
      }
    }

    for (const i of changed) {
      this.lastFloor[i] = floors[i]!;
      this.lastCeil[i] = ceils[i]!;
      this.lastLight[i] = lights[i]!;
    }
  }

  // --- flats ------------------------------------------------------------

  private buildFlats(): void {
    const tris = triangulateAllSectors(this.map);
    // Group sector planes by flat texture.
    const groups = new Map<string, { positions: number[]; uvs: number[]; lights: number[]; indices: number[]; ranges: FlatRange[] }>();

    for (const tri of tris) {
      if (tri.indices.length === 0) continue;
      const sector = this.map.sectors[tri.sector]!;
      for (const plane of ['floor', 'ceiling'] as const) {
        const flatName = plane === 'floor' ? sector.floorPic : sector.ceilingPic;
        if (flatName === SKY_FLAT) continue;
        if (!this.store.flatTexture(flatName)) continue;
        let g = groups.get(flatName);
        if (!g) {
          g = { positions: [], uvs: [], lights: [], indices: [], ranges: [] };
          groups.set(flatName, g);
        }
        const height = plane === 'floor' ? sector.floorHeight : sector.ceilingHeight;
        const base = g.positions.length / 3;
        g.ranges.push({
          sector: tri.sector,
          plane,
          vertexStart: base,
          vertexCount: tri.positions.length / 2,
        });
        for (let i = 0; i < tri.positions.length; i += 2) {
          const x = tri.positions[i]!;
          const y = tri.positions[i + 1]!;
          g.positions.push(x, height, -y);
          g.uvs.push(x / 64, -y / 64);
          g.lights.push(sector.lightLevel);
        }
        for (let i = 0; i < tri.indices.length; i += 3) {
          const a = base + tri.indices[i]!;
          const b = base + tri.indices[i + 1]!;
          const c = base + tri.indices[i + 2]!;
          // Floors face up (reverse the map-space winding), ceilings down.
          if (plane === 'floor') g.indices.push(a, c, b);
          else g.indices.push(a, b, c);
        }
      }
    }

    for (const [flatName, g] of groups) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(g.uvs, 2));
      geometry.setAttribute('light', new THREE.Float32BufferAttribute(g.lights, 1));
      geometry.setIndex(g.indices);
      const entry = this.store.flatTexture(flatName)!;
      const material = makeSurfaceMaterial(entry.texture, false);
      // Sector loop winding varies with map quirks (gap repairs, shared
      // vertices), so floors/ceilings render double-sided — you can never
      // legitimately see the far side of a flat anyway.
      material.side = THREE.DoubleSide;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.flatRanges.set(flatName, { geometry, ranges: g.ranges });
    }
  }

  // --- walls ------------------------------------------------------------

  private buildWalls(): void {
    const sizes = new Map<string, TextureSize>();
    for (const [name, def] of this.store.wallDefs) {
      sizes.set(name, { width: def.width, height: def.height });
    }
    const quads = buildWallQuads(this.map, sizes, this.dynamic);
    const groups = new Map<string, { positions: number[]; uvs: number[]; lights: number[]; indices: number[]; ranges: WallRange[]; masked: boolean }>();

    for (const quad of quads) {
      // Sky hack: never draw uppers between two sky ceilings.
      if (quad.kind === 'upper') {
        const ld = this.map.linedefs[quad.linedef]!;
        const s0 = ld.sidenum[0] !== 0xffff ? this.map.sidedefs[ld.sidenum[0]]?.sector : undefined;
        const s1 = ld.sidenum[1] !== 0xffff ? this.map.sidedefs[ld.sidenum[1]]?.sector : undefined;
        if (
          s0 !== undefined && s1 !== undefined &&
          this.map.sectors[s0]!.ceilingPic === SKY_FLAT &&
          this.map.sectors[s1]!.ceilingPic === SKY_FLAT
        ) continue;
      }
      const entry = this.store.wallTexture(quad.texture);
      if (!entry) continue;
      let g = groups.get(quad.texture);
      if (!g) {
        g = { positions: [], uvs: [], lights: [], indices: [], ranges: [], masked: quad.masked };
        groups.set(quad.texture, g);
      }
      g.masked ||= quad.masked;

      const sector = this.map.sectors[quad.lightSector]!;
      // Vanilla "fake contrast": N/S walls lighter, E/W darker.
      let light = sector.lightLevel;
      if (quad.y1 === quad.y2) light = Math.max(0, light - 16);
      else if (quad.x1 === quad.x2) light = Math.min(255, light + 16);

      const base = g.positions.length / 3;
      g.ranges.push({ quad, vertexStart: base });
      const { x1, y1, x2, y2, bottom, top, u1, u2, vTop } = quad;
      const w = entry.width;
      const h = entry.height;
      // 4 verts: bl, br, tr, tl (facing direction x1->x2 keeps outward normal).
      g.positions.push(x1, bottom, -y1, x2, bottom, -y2, x2, top, -y2, x1, top, -y1);
      g.uvs.push(
        u1 / w, (vTop - bottom) / h,
        u2 / w, (vTop - bottom) / h,
        u2 / w, (vTop - top) / h,
        u1 / w, (vTop - top) / h,
      );
      g.lights.push(light, light, light, light);
      g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    for (const [texName, g] of groups) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(g.uvs, 2));
      geometry.setAttribute('light', new THREE.Float32BufferAttribute(g.lights, 1));
      geometry.setIndex(g.indices);
      const entry = this.store.wallTexture(texName)!;
      const mesh = new THREE.Mesh(geometry, makeSurfaceMaterial(entry.texture, g.masked));
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.wallRanges.set(texName, { geometry, ranges: g.ranges });
    }
  }

  // --- things -----------------------------------------------------------

  private buildThings(): void {
    // doomednum -> mobjinfo index
    const byDoomednum = new Map<number, number>();
    mobjinfo.forEach((info, i) => {
      if (info.doomednum !== -1) byDoomednum.set(info.doomednum, i);
    });

    for (const thing of this.map.things) {
      // Skip player/deathmatch starts and anything without a visible sprite.
      if (thing.type >= 1 && thing.type <= 4) continue;
      if (thing.type === 11) continue;
      const mt = byDoomednum.get(thing.type);
      if (mt === undefined || mt === MT.TELEPORTMAN) continue;
      const info = mobjinfo[mt]!;
      const state = states[info.spawnstate]!;
      const spr = sprnames[state[0]]!;
      const frame = state[1] & FF_FRAMEMASK;
      const fullBright = (state[1] & FF_FULLBRIGHT) !== 0;
      const frames = this.spriteTable.get(spr);
      const lump = frames?.rotations[frame]?.[1] ?? frames?.rotations[frame]?.[0];
      if (!lump) continue;
      const entry = this.store.spriteTexture(lump.lumpName);
      if (!entry) continue;

      const sectorIdx = pointInSector(this.map, thing.x, thing.y);
      const sector = this.map.sectors[sectorIdx]!;
      const z =
        info.flags & MF.SPAWNCEILING
          ? sector.ceilingHeight - info.height / FRACUNIT
          : sector.floorHeight;

      const geometry = new THREE.PlaneGeometry(entry.pic.width, entry.pic.height);
      // flip V: our textures put the image top at v=0 (see mobjsprites.ts)
      const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute;
      for (let vi = 0; vi < uvAttr.count; vi++) uvAttr.setY(vi, 1 - uvAttr.getY(vi));
      const lightValue = fullBright ? 255 : sector.lightLevel;
      const lights = new Float32Array(4).fill(lightValue);
      geometry.setAttribute('light', new THREE.BufferAttribute(lights, 1));
      const mesh = new THREE.Mesh(geometry, this.spriteMaterial(lump.lumpName));
      // Sprite top at z + topOffset, with the bottom clamped to the floor
      // for grounded things (see mobjsprites.ts).
      const isGrounded = !(info.flags & MF.SPAWNCEILING) && !(info.flags & MF.NOGRAVITY);
      let bottomOff = entry.pic.topOffset - entry.pic.height;
      if (bottomOff < 0 && isGrounded) bottomOff = 0;
      const centerY = z + bottomOff + entry.pic.height / 2;
      mesh.position.set(thing.x, centerY, -thing.y);
      this.group.add(mesh);
      this.sprites.push({
        mesh, spr, frame,
        angle: (thing.angle * Math.PI) / 180,
        x: thing.x, y: thing.y,
        fullBright, light: lightValue,
        currentLump: lump.lumpName,
      });
    }
  }

  private spriteMaterial(lumpName: string): THREE.ShaderMaterial {
    let mat = this.spriteMaterials.get(lumpName);
    if (!mat) {
      const entry = this.store.spriteTexture(lumpName)!;
      mat = makeSurfaceMaterial(entry.texture, true);
      mat.side = THREE.DoubleSide;
      this.spriteMaterials.set(lumpName, mat);
    }
    return mat;
  }

  /** Cylindrical-billboard the sprites and pick rotation frames. */
  updateSprites(camera: THREE.Camera): void {
    const camX = camera.position.x;
    const camY = -camera.position.z; // back to map coords
    for (const s of this.sprites) {
      // Face the camera around the vertical axis only (three z = -map y).
      s.mesh.rotation.y = Math.atan2(camX - s.x, s.y - camY);
      // Rotation frame from viewer angle.
      const frames = this.spriteTable.get(s.spr);
      if (!frames) continue;
      const angleToThing = Math.atan2(s.y - camY, s.x - camX);
      const slot = rotationFor(angleToThing, s.angle);
      const lump = frames.rotations[s.frame]?.[slot] ?? frames.rotations[s.frame]?.[0];
      if (lump && lump.lumpName !== s.currentLump) {
        s.currentLump = lump.lumpName;
        s.mesh.material = this.spriteMaterial(lump.lumpName);
        // Mirroring: flip u by scaling.
        s.mesh.scale.x = lump.mirrored ? -1 : 1;
      }
    }
  }

  dispose(): void {
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => m.dispose());
      }
    });
  }
}
