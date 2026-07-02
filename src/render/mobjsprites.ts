// Sim-driven mobj billboards: one plane per live mobj, interpolated
// between tics, with rotation-frame selection and sector lighting.

import * as THREE from 'three';
import { FF_FRAMEMASK, FF_FULLBRIGHT } from '../sim/defs.ts';
import { MF, sprnames } from '../sim/data/info.gen.ts';
import { FRACUNIT } from '../sim/fixed.ts';
import type { DoomSim } from '../sim/sim.ts';
import type { Mobj } from '../sim/world.ts';
import { makeSurfaceMaterial } from './materials.ts';
import { buildSpriteTable, rotationFor, type SpriteTable } from './sprites.ts';
import type { TextureStore } from './textures.ts';
import type { WadFile } from '../wad/wad.ts';

interface Tracked {
  mesh: THREE.Mesh;
  lump: string | null;
  mirrored: boolean;
  prevX: number;
  prevY: number;
  prevZ: number;
  curX: number;
  curY: number;
  curZ: number;
}

export class MobjSprites {
  readonly group = new THREE.Group();
  private readonly table: SpriteTable;
  private readonly tracked = new Map<Mobj, Tracked>();
  private readonly materials = new Map<string, THREE.ShaderMaterial>();

  constructor(
    private readonly store: TextureStore,
    wad: WadFile,
  ) {
    this.table = buildSpriteTable(wad);
  }

  private material(lumpName: string, shadow: boolean): THREE.ShaderMaterial {
    const key = shadow ? `${lumpName}~s` : lumpName;
    let mat = this.materials.get(key);
    if (!mat) {
      const entry = this.store.spriteTexture(lumpName)!;
      mat = makeSurfaceMaterial(entry.texture, true);
      mat.side = THREE.DoubleSide;
      if (shadow) {
        mat.transparent = true;
        mat.uniforms.alphaTest!.value = 0.2;
        // spectre "fuzz" approximation
        mat.defines = { ...mat.defines };
        mat.opacity = 0.3;
        mat.uniformsNeedUpdate = true;
      }
      this.materials.set(key, mat);
    }
    return mat;
  }

  /** Each mobj gets its own unit plane (so light attrs don't collide);
   *  sprite size is applied via mesh scale. */
  private makeUnitPlane(): THREE.PlaneGeometry {
    const geo = new THREE.PlaneGeometry(1, 1);
    // our palette textures have row 0 = image top at v=0; PlaneGeometry
    // expects v=1 at the top — flip V so sprites render upright
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    geo.setAttribute('light', new THREE.BufferAttribute(new Float32Array(4).fill(255), 1));
    return geo;
  }

  /** Snapshot current positions as the interpolation targets (call per tic). */
  snapshot(sim: DoomSim, skip?: Mobj | null): void {
    const seen = new Set<Mobj>();
    for (const mobj of sim.mobjs()) {
      if (mobj === skip) continue;
      seen.add(mobj);
      let t = this.tracked.get(mobj);
      if (!t) {
        const mesh = new THREE.Mesh(this.makeUnitPlane());
        mesh.visible = false;
        this.group.add(mesh);
        t = {
          mesh, lump: null, mirrored: false,
          prevX: mobj.x, prevY: mobj.y, prevZ: mobj.z,
          curX: mobj.x, curY: mobj.y, curZ: mobj.z,
        };
        this.tracked.set(mobj, t);
      } else {
        t.prevX = t.curX;
        t.prevY = t.curY;
        t.prevZ = t.curZ;
        t.curX = mobj.x;
        t.curY = mobj.y;
        t.curZ = mobj.z;
      }
    }
    // remove departed mobjs
    for (const [mobj, t] of this.tracked) {
      if (!seen.has(mobj) && mobj.removed) {
        this.group.remove(t.mesh);
        this.tracked.delete(mobj);
      }
    }
  }

  /** Per-frame: position, billboard, and frame-select every sprite. */
  update(sim: DoomSim, camera: THREE.Camera, alpha: number, skip?: Mobj | null): void {
    const camX = camera.position.x;
    const camY = -camera.position.z;

    for (const [mobj, t] of this.tracked) {
      if (mobj.removed || mobj === skip) {
        t.mesh.visible = false;
        continue;
      }
      const spr = sprnames[mobj.sprite];
      const frames = spr ? this.table.get(spr) : undefined;
      const frame = mobj.frame & FF_FRAMEMASK;
      const slots = frames?.rotations[frame];
      if (!slots) {
        t.mesh.visible = false;
        continue;
      }

      const x = (t.prevX + (t.curX - t.prevX) * alpha) / FRACUNIT;
      const y = (t.prevY + (t.curY - t.prevY) * alpha) / FRACUNIT;
      const z = (t.prevZ + (t.curZ - t.prevZ) * alpha) / FRACUNIT;

      const thingAngle = (mobj.angle / 4294967296) * Math.PI * 2;
      const angleToThing = Math.atan2(y - camY, x - camX);
      const lump = slots[rotationFor(angleToThing, thingAngle)] ?? slots[0];
      if (!lump) {
        t.mesh.visible = false;
        continue;
      }

      if (lump.lumpName !== t.lump || lump.mirrored !== t.mirrored) {
        const entry = this.store.spriteTexture(lump.lumpName);
        if (!entry) {
          t.mesh.visible = false;
          continue;
        }
        t.lump = lump.lumpName;
        t.mirrored = lump.mirrored;
        t.mesh.material = this.material(lump.lumpName, (mobj.flags & MF.SHADOW) !== 0);
        t.mesh.scale.set(lump.mirrored ? -entry.pic.width : entry.pic.width, entry.pic.height, 1);
      }

      const entry = this.store.spriteTexture(lump.lumpName)!;
      const fullBright = (mobj.frame & FF_FULLBRIGHT) !== 0;
      const sectorLight = mobj.subsector ? mobj.subsector.sector.lightlevel : 255;
      const lightAttr = t.mesh.geometry.getAttribute('light') as THREE.BufferAttribute;
      const lightValue = fullBright ? 255 : sectorLight;
      if (lightAttr.getX(0) !== lightValue) {
        for (let i = 0; i < 4; i++) lightAttr.setX(i, lightValue);
        lightAttr.needsUpdate = true;
      }

      // sprite top at z + topOffset
      const centerY = z + entry.pic.topOffset - entry.pic.height / 2;
      t.mesh.position.set(x, centerY, -y);
      t.mesh.rotation.y = Math.atan2(camX - x, y - camY);
      t.mesh.visible = true;
    }
  }
}
