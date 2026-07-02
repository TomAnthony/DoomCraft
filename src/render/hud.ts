// First-person weapon overlay (psprites in vanilla 320x200 screen space),
// the classic status bar (STBAR + widgets), and screen flashes.

import * as THREE from 'three';
import { S_BLOCKGUN_UP, S_BLOCKGUN_REMOVE, S_BLOCKGUN_PLACE } from '../blocks/gun.ts';
import { FF_FRAMEMASK, FF_FULLBRIGHT } from '../sim/defs.ts';
import { sprnames } from '../sim/data/info.gen.ts';
import { FRACUNIT } from '../sim/fixed.ts';
import { Ammo, Weapon, weaponinfo } from '../sim/items.ts';
import type { DoomSim } from '../sim/sim.ts';
import type { Player } from '../sim/world.ts';
import { makeSurfaceMaterial } from './materials.ts';
import { buildSpriteTable, type SpriteTable } from './sprites.ts';
import type { TextureStore } from './textures.ts';
import type { WadFile } from '../wad/wad.ts';

const BAR_Y = 168; // status bar top in 320x200 space

/** Pixelated isometric cube texture for the block gun in hand. */
function makeCubeTexture(): THREE.Texture {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  // top face (light)
  ctx.fillStyle = '#f2f2ee';
  ctx.beginPath();
  ctx.moveTo(cx, 4);
  ctx.lineTo(size - 4, 14);
  ctx.lineTo(cx, 24);
  ctx.lineTo(4, 14);
  ctx.closePath();
  ctx.fill();
  // left face (mid)
  ctx.fillStyle = '#c2c2ba';
  ctx.beginPath();
  ctx.moveTo(4, 14);
  ctx.lineTo(cx, 24);
  ctx.lineTo(cx, 44);
  ctx.lineTo(4, 34);
  ctx.closePath();
  ctx.fill();
  // right face (dark)
  ctx.fillStyle = '#96968e';
  ctx.beginPath();
  ctx.moveTo(size - 4, 14);
  ctx.lineTo(cx, 24);
  ctx.lineTo(cx, 44);
  ctx.lineTo(size - 4, 34);
  ctx.closePath();
  ctx.fill();
  // mortar lines
  ctx.strokeStyle = '#7a7a74';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(4, 24);
  ctx.lineTo(cx, 34);
  ctx.lineTo(size - 4, 24);
  ctx.moveTo(cx / 2 + 1, 19);
  ctx.lineTo(cx / 2 + 1, 39);
  ctx.moveTo(cx + cx / 2 - 1, 19);
  ctx.lineTo(cx + cx / 2 - 1, 39);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  // match the WAD-texture convention (image top at v=0) so the y-down
  // ortho renders it upright like the other psprites
  tex.flipY = false;
  return tex;
}

export class HudView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private readonly pspMeshes: THREE.Mesh[] = [];
  private readonly pspKeys: (string | null)[] = [null, null];
  private readonly materials = new Map<string, THREE.Material>();
  private readonly table: SpriteTable;
  private readonly cubeMaterial: THREE.MeshBasicMaterial;

  private readonly flash: HTMLDivElement;
  private readonly messageEl: HTMLDivElement;
  private messageClearAt = 0;

  // status bar widget meshes
  private readonly barMeshes = new Map<string, THREE.Mesh>();
  private readonly digitPools = new Map<string, THREE.Mesh[]>();

  constructor(
    private readonly store: TextureStore,
    wad: WadFile,
    root: HTMLElement,
  ) {
    this.table = buildSpriteTable(wad);
    // 320x200, y down, matching vanilla screen coordinates.
    this.camera = new THREE.OrthographicCamera(0, 320, 0, 200, -10, 10);
    for (let i = 0; i < 2; i++) {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.setAttribute('light', new THREE.BufferAttribute(new Float32Array(4).fill(255), 1));
      const mesh = new THREE.Mesh(geo);
      mesh.visible = false;
      this.scene.add(mesh);
      this.pspMeshes.push(mesh);
    }
    this.cubeMaterial = new THREE.MeshBasicMaterial({
      map: makeCubeTexture(),
      transparent: true,
      side: THREE.DoubleSide,
    });

    this.flash = document.createElement('div');
    this.flash.style.cssText =
      'position:fixed;inset:0;pointer-events:none;background:#f00;opacity:0';
    root.appendChild(this.flash);

    this.messageEl = document.createElement('div');
    this.messageEl.style.cssText =
      'position:fixed;top:8px;left:8px;color:#fc6;' +
      'font:bold 14px monospace;text-shadow:1px 1px 0 #000;pointer-events:none';
    root.appendChild(this.messageEl);
  }

  // --- lump blitting helpers ------------------------------------------------

  private material(lumpName: string): THREE.Material {
    let mat = this.materials.get(lumpName);
    if (!mat) {
      const entry = this.store.spriteTexture(lumpName)!;
      const m = makeSurfaceMaterial(entry.texture, true);
      m.side = THREE.DoubleSide; // y-down ortho flips winding
      mat = m;
      this.materials.set(lumpName, mat);
    }
    return mat;
  }

  /** A pooled mesh for a fixed status-bar slot, keyed by slot name. */
  private slot(key: string): THREE.Mesh {
    let mesh = this.barMeshes.get(key);
    if (!mesh) {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.setAttribute('light', new THREE.BufferAttribute(new Float32Array(4).fill(255), 1));
      mesh = new THREE.Mesh(geo);
      mesh.visible = false;
      this.scene.add(mesh);
      this.barMeshes.set(key, mesh);
    }
    return mesh;
  }

  /** Show a lump at top-left (x, y); hides the slot if lump missing. */
  private blit(key: string, lumpName: string | null, x: number, y: number, z = 5): void {
    const mesh = this.slot(key);
    if (!lumpName) {
      mesh.visible = false;
      return;
    }
    const entry = this.store.spriteTexture(lumpName);
    if (!entry) {
      mesh.visible = false;
      return;
    }
    mesh.material = this.material(lumpName);
    mesh.scale.set(entry.width, entry.height, 1);
    mesh.position.set(x + entry.width / 2, y + entry.height / 2, z);
    mesh.visible = true;
  }

  /** Right-justified number using a digit font (STTNUM / STYSNUM / STGNUM). */
  private drawNum(
    key: string, font: string, value: number, xRight: number, y: number, maxDigits = 3,
  ): void {
    let pool = this.digitPools.get(key);
    if (!pool) {
      pool = [];
      for (let i = 0; i < maxDigits; i++) {
        const geo = new THREE.PlaneGeometry(1, 1);
        geo.setAttribute('light', new THREE.BufferAttribute(new Float32Array(4).fill(255), 1));
        const mesh = new THREE.Mesh(geo);
        mesh.visible = false;
        this.scene.add(mesh);
        pool.push(mesh);
      }
      this.digitPools.set(key, pool);
    }
    let v = Math.max(0, Math.min(999, value | 0));
    let x = xRight;
    for (let i = 0; i < maxDigits; i++) {
      const mesh = pool[i]!;
      if (i > 0 && v === 0) {
        mesh.visible = false;
        continue;
      }
      const digit = v % 10;
      v = (v / 10) | 0;
      const lumpName = `${font}${digit}`;
      const entry = this.store.spriteTexture(lumpName);
      if (!entry) {
        mesh.visible = false;
        continue;
      }
      x -= entry.width;
      mesh.material = this.material(lumpName);
      mesh.scale.set(entry.width, entry.height, 1);
      mesh.position.set(x + entry.width / 2, y + entry.height / 2, 5);
      mesh.visible = true;
    }
  }

  // --- psprites ----------------------------------------------------------------

  private updatePsprites(sim: DoomSim, player: Player): void {
    for (let i = 0; i < 2; i++) {
      const psp = player.psprites[i]!;
      const mesh = this.pspMeshes[i]!;
      if (!psp.stateNum) {
        mesh.visible = false;
        continue;
      }

      const sx = psp.sx / FRACUNIT;
      const sy = psp.sy / FRACUNIT;

      // Block gun: procedural cube in hand instead of a WAD sprite.
      if (psp.stateNum >= S_BLOCKGUN_UP && psp.stateNum <= S_BLOCKGUN_REMOVE) {
        const attacking = psp.stateNum === S_BLOCKGUN_PLACE || psp.stateNum === S_BLOCKGUN_REMOVE;
        if (this.pspKeys[i] !== '~cube') {
          this.pspKeys[i] = '~cube';
          mesh.material = this.cubeMaterial;
          mesh.scale.set(110, 110, 1);
        }
        const left = 168 + sx;
        const top = (sy - 32) + BAR_Y - 35 - (attacking ? 14 : 0);
        mesh.position.set(left + 55, top + 55, i);
        mesh.visible = true;
        continue;
      }

      const st = sim.stateTable[psp.stateNum]!;
      const spr = sprnames[st[0]]!;
      const frame = st[1] & FF_FRAMEMASK;
      const lump = this.table.get(spr)?.rotations[frame]?.[0];
      const entry = lump ? this.store.spriteTexture(lump.lumpName) : null;
      if (!lump || !entry) {
        mesh.visible = false;
        continue;
      }
      if (this.pspKeys[i] !== lump.lumpName) {
        this.pspKeys[i] = lump.lumpName;
        mesh.material = this.material(lump.lumpName);
        mesh.scale.set(entry.pic.width, entry.pic.height, 1);
      }

      // Vanilla R_DrawPSprite: left = sx - leftOffset, top = sy - topOffset.
      const left = sx - entry.pic.leftOffset;
      const top = sy - entry.pic.topOffset;
      mesh.position.set(left + entry.pic.width / 2, top + entry.pic.height / 2, i);

      const fullBright = (st[1] & FF_FULLBRIGHT) !== 0;
      const sector = player.mo!.subsector!.sector;
      const lightValue = fullBright
        ? 255
        : Math.min(255, sector.lightlevel + player.extralight * 16);
      const lightAttr = (mesh.geometry as THREE.BufferGeometry).getAttribute(
        'light',
      ) as THREE.BufferAttribute;
      if (lightAttr.getX(0) !== lightValue) {
        for (let v = 0; v < 4; v++) lightAttr.setX(v, lightValue);
        lightAttr.needsUpdate = true;
      }
      mesh.visible = true;
    }
  }

  // --- status bar -----------------------------------------------------------------

  private updateStatusBar(sim: DoomSim, player: Player): void {
    this.blit('stbar', 'STBAR', 0, BAR_Y, 3);
    // deathmatch: frags replace the arms panel (vanilla)
    this.blit('starms', sim.deathmatch ? null : 'STARMS', 104, BAR_Y, 4);
    if (sim.deathmatch) {
      const frags = player.frags.reduce((a, b) => a + b, 0);
      this.drawNum('frags', 'STTNUM', frags, 138, BAR_Y + 3, 2);
    } else {
      const pool = this.digitPools.get('frags');
      if (pool) for (const m of pool) m.visible = false;
    }

    // big red ammo (blocks count on the block gun)
    const ammoType = weaponinfo[player.readyweapon]!.ammo;
    if (player.readyweapon === Weapon.BlockGun) {
      this.drawNum('ammo', 'STTNUM', sim.blocks.count, 44, BAR_Y + 3);
    } else if (ammoType !== Ammo.NoAmmo) {
      this.drawNum('ammo', 'STTNUM', player.ammo[ammoType]!, 44, BAR_Y + 3);
    } else {
      const pool = this.digitPools.get('ammo');
      if (pool) for (const m of pool) m.visible = false;
    }

    // health / armor percents
    this.blit('hpct', 'STTPRCNT', 90, BAR_Y + 3);
    this.drawNum('health', 'STTNUM', player.health, 90, BAR_Y + 3);
    this.blit('apct', 'STTPRCNT', 221, BAR_Y + 3);
    this.drawNum('armor', 'STTNUM', player.armorpoints, 221, BAR_Y + 3);

    // arms panel: weapon keys 2-7
    for (let w = 2; w <= 7; w++) {
      const col = (w - 2) % 3;
      const row = ((w - 2) / 3) | 0;
      const owned =
        w === 7
          ? player.weaponowned[Weapon.Bfg]
          : w === 3
            ? player.weaponowned[Weapon.Shotgun] || player.weaponowned[Weapon.SuperShotgun]
            : player.weaponowned[w - 1]; // key -> weapon index
      const font = owned ? 'STYSNUM' : 'STGNUM';
      this.blit(
        `arm${w}`,
        sim.deathmatch ? null : `${font}${w}`,
        111 + col * 12, BAR_Y + 4 + row * 10, 5,
      );
    }

    // face
    let face: string;
    if (player.health <= 0) {
      face = 'STFDEAD0';
    } else {
      const pain = Math.min(4, (((100 - player.health) * 5) / 101) | 0);
      face = player.damagecount > 0 ? `STFKILL${pain}` : `STFST${pain}1`;
    }
    this.blit('face', face, 143, BAR_Y, 4);

    // keys
    for (let k = 0; k < 3; k++) {
      const card = player.cards[k];
      const skull = player.cards[k + 3];
      const lump = skull ? `STKEYS${k + 3}` : card ? `STKEYS${k}` : null;
      this.blit(`key${k}`, lump, 239, BAR_Y + 3 + k * 10, 5);
    }

    // ammo table (cur/max) — bullets, shells, rockets, cells
    const rows: [number, number][] = [
      [player.ammo[0]!, player.maxammo[0]!],
      [player.ammo[1]!, player.maxammo[1]!],
      [player.ammo[3]!, player.maxammo[3]!],
      [player.ammo[2]!, player.maxammo[2]!],
    ];
    rows.forEach(([cur, max], r) => {
      this.drawNum(`at${r}c`, 'STYSNUM', cur, 288, BAR_Y + 5 + r * 6);
      this.drawNum(`at${r}m`, 'STYSNUM', max, 314, BAR_Y + 5 + r * 6);
    });
  }

  // --- per-frame -----------------------------------------------------------------

  update(sim: DoomSim, player: Player): void {
    this.updatePsprites(sim, player);
    this.updateStatusBar(sim, player);

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
}
