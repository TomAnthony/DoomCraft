// Floating name tags above remote players (netgames only, toggleable in
// options). Purely presentational: canvas-drawn text on THREE.Sprites,
// positioned from the interpolated sprite tracker, depth-tested so
// walls occlude them naturally.

import * as THREE from 'three';
import { PlayerState } from '../sim/defs.ts';
import type { DoomSim } from '../sim/sim.ts';
import type { MobjSprites } from './mobjsprites.ts';

export class NameTags {
  readonly group = new THREE.Group();
  enabled = true;
  private readonly tags = new Map<number, THREE.Sprite>();
  private readonly textures = new Map<string, THREE.Texture>();

  private texture(name: string): THREE.Texture {
    let tex = this.textures.get(name);
    if (!tex) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 48;
      const ctx = canvas.getContext('2d')!;
      ctx.font = 'bold 30px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#000';
      ctx.strokeText(name, 128, 24);
      ctx.fillStyle = '#efe6d8';
      ctx.fillText(name, 128, 24);
      tex = new THREE.CanvasTexture(canvas);
      tex.magFilter = THREE.LinearFilter;
      this.textures.set(name, tex);
    }
    return tex;
  }

  private tag(slot: number, name: string): THREE.Sprite {
    let sprite = this.tags.get(slot);
    if (!sprite) {
      const mat = new THREE.SpriteMaterial({
        map: this.texture(name),
        transparent: true,
        depthTest: true, // walls hide tags — no wallhack
      });
      sprite = new THREE.Sprite(mat);
      sprite.scale.set(64, 12, 1);
      this.group.add(sprite);
      this.tags.set(slot, sprite);
    }
    return sprite;
  }

  update(sim: DoomSim, sprites: MobjSprites, names: string[], localSlot: number): void {
    this.group.visible = this.enabled;
    if (!this.enabled) return;
    for (let slot = 0; slot < 4; slot++) {
      const p = sim.players[slot];
      const show =
        slot !== localSlot &&
        sim.playeringame[slot] &&
        !!p?.mo &&
        p.playerstate === PlayerState.Live;
      const existing = this.tags.get(slot);
      if (!show) {
        if (existing) existing.visible = false;
        continue;
      }
      const pos = sprites.positionOf(p!.mo!);
      if (!pos) {
        if (existing) existing.visible = false;
        continue;
      }
      const sprite = this.tag(slot, names[slot] || `Player ${slot + 1}`);
      sprite.visible = true;
      sprite.position.set(pos.x, pos.y + 42, pos.z);
    }
  }
}
