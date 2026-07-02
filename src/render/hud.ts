// First-person weapon overlay (psprites in vanilla 320x200 screen space)
// plus a DOM status line and damage/pickup screen flashes.

import * as THREE from 'three';
import { FF_FRAMEMASK, FF_FULLBRIGHT } from '../sim/defs.ts';
import { sprnames } from '../sim/data/info.gen.ts';
import { FRACUNIT } from '../sim/fixed.ts';
import { Ammo, weaponinfo } from '../sim/items.ts';
import type { DoomSim } from '../sim/sim.ts';
import type { Player } from '../sim/world.ts';
import { makeSurfaceMaterial } from './materials.ts';
import { buildSpriteTable, type SpriteTable } from './sprites.ts';
import type { TextureStore } from './textures.ts';
import type { WadFile } from '../wad/wad.ts';

export class HudView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly lumps: (string | null)[] = [null, null];
  private readonly materials = new Map<string, THREE.ShaderMaterial>();
  private readonly table: SpriteTable;

  private readonly status: HTMLDivElement;
  private readonly flash: HTMLDivElement;
  private readonly messageEl: HTMLDivElement;

  constructor(
    private readonly store: TextureStore,
    wad: WadFile,
    root: HTMLElement,
  ) {
    this.table = buildSpriteTable(wad);
    // 320x200, y down, matching vanilla psprite coordinates.
    this.camera = new THREE.OrthographicCamera(0, 320, 0, 200, -10, 10);
    for (let i = 0; i < 2; i++) {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.setAttribute('light', new THREE.BufferAttribute(new Float32Array(4).fill(255), 1));
      const mesh = new THREE.Mesh(geo);
      mesh.visible = false;
      this.scene.add(mesh);
      this.meshes.push(mesh);
    }

    this.status = document.createElement('div');
    this.status.style.cssText =
      'position:fixed;bottom:8px;left:50%;transform:translateX(-50%);color:#e33;' +
      'font:bold 20px monospace;text-shadow:2px 2px 0 #000;pointer-events:none;white-space:pre';
    root.appendChild(this.status);

    this.flash = document.createElement('div');
    this.flash.style.cssText =
      'position:fixed;inset:0;pointer-events:none;mix-blend-mode:normal;background:#f00;opacity:0';
    root.appendChild(this.flash);

    this.messageEl = document.createElement('div');
    this.messageEl.style.cssText =
      'position:fixed;top:8px;left:50%;transform:translateX(-50%);color:#fc6;' +
      'font:bold 14px monospace;text-shadow:1px 1px 0 #000;pointer-events:none';
    root.appendChild(this.messageEl);
  }

  private material(lumpName: string): THREE.ShaderMaterial {
    let mat = this.materials.get(lumpName);
    if (!mat) {
      const entry = this.store.spriteTexture(lumpName)!;
      mat = makeSurfaceMaterial(entry.texture, true);
      // the y-down ortho projection flips winding
      mat.side = THREE.DoubleSide;
      this.materials.set(lumpName, mat);
    }
    return mat;
  }

  update(sim: DoomSim, player: Player): void {
    // psprites: weapon (0) and flash (1)
    for (let i = 0; i < 2; i++) {
      const psp = player.psprites[i]!;
      const mesh = this.meshes[i]!;
      if (!psp.stateNum) {
        mesh.visible = false;
        continue;
      }
      const st = sim.stateTable[psp.stateNum]!;
      const spr = sprnames[st[0]]!;
      const frame = st[1] & FF_FRAMEMASK;
      const lump = this.table.get(spr)?.rotations[frame]?.[0];
      if (!lump) {
        mesh.visible = false;
        continue;
      }
      const entry = this.store.spriteTexture(lump.lumpName);
      if (!entry) {
        mesh.visible = false;
        continue;
      }
      if (this.lumps[i] !== lump.lumpName) {
        this.lumps[i] = lump.lumpName;
        mesh.material = this.material(lump.lumpName);
        // ortho top=0/bottom=200 already inverts y; positive scale is upright
        mesh.scale.set(entry.pic.width, entry.pic.height, 1);
      }

      // Vanilla R_DrawPSprite reduces (unscaled 320x200) to:
      //   left = sx - leftOffset,  top = sy - topOffset
      // (weapon lumps carry large negative offsets that center them).
      const sx = psp.sx / FRACUNIT;
      const sy = psp.sy / FRACUNIT;
      const left = sx - entry.pic.leftOffset;
      const top = sy - entry.pic.topOffset;
      mesh.position.set(left + entry.pic.width / 2, top + entry.pic.height / 2, i);

      const fullBright = (st[1] & FF_FULLBRIGHT) !== 0;
      const sector = player.mo!.subsector!.sector;
      const lightValue = fullBright ? 255 : Math.min(255, sector.lightlevel + player.extralight * 16);
      const lightAttr = (mesh.geometry as THREE.BufferGeometry).getAttribute('light') as THREE.BufferAttribute;
      if (lightAttr.getX(0) !== lightValue) {
        for (let v = 0; v < 4; v++) lightAttr.setX(v, lightValue);
        lightAttr.needsUpdate = true;
      }
      mesh.visible = true;
    }

    // status line
    const ammoType = weaponinfo[player.readyweapon]!.ammo;
    const ammoText =
      player.readyweapon === 10
        ? `BLOCKS ${sim.blocks.count}`
        : ammoType === Ammo.NoAmmo
          ? 'AMMO -'
          : `AMMO ${player.ammo[ammoType]}`;
    this.status.textContent =
      `HEALTH ${player.health}%   ARMOR ${player.armorpoints}%   ${ammoText}   ` +
      `FRAGS ${player.frags.reduce((a, b) => a + b, 0)}   KILLS ${player.killcount}/${sim.totalkills}`;

    // damage/bonus flash
    if (player.damagecount > 0) {
      this.flash.style.background = '#f00';
      this.flash.style.opacity = String(Math.min(0.6, player.damagecount / 60));
    } else if (player.bonuscount > 0) {
      this.flash.style.background = '#cc7818';
      this.flash.style.opacity = String(Math.min(0.35, player.bonuscount / 40));
    } else {
      this.flash.style.opacity = '0';
    }

    // pickup message (auto-clear)
    if (player.message) {
      this.messageEl.textContent = player.message;
      player.message = null;
      this.messageClearAt = performance.now() + 2500;
    } else if (this.messageClearAt && performance.now() > this.messageClearAt) {
      this.messageEl.textContent = '';
      this.messageClearAt = 0;
    }
  }

  private messageClearAt = 0;
}
