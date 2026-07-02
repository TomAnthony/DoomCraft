// The automap (Tab): vanilla-style vector overlay drawn on a 2D canvas
// above the 3D view (the status bar stays visible below). Follow-mode
// only, +/- to zoom. Purely presentational — never touches sim state.
//
// Colors follow vanilla am_map.c: one-sided walls red, floor-height
// changes brown, ceiling-height changes yellow, other two-sided gray.

import { BLOCK_UNITS } from '../blocks/grid.ts';
import { ML_DONTDRAW, ML_SECRET } from '../sim/defs.ts';
import { FRACUNIT } from '../sim/fixed.ts';
import type { DoomSim } from '../sim/sim.ts';
import type { Player } from '../sim/world.ts';

const COLOR_WALL = '#fc4646';
const COLOR_FLOORDIFF = '#bc7848';
const COLOR_CEILDIFF = '#fcfc00';
const COLOR_TWOSIDED = '#8c8c8c';
const COLOR_PLAYER = '#ffffff';
const COLOR_BLOCK = '#e8e8e0';

export class Automap {
  visible = false;
  private scale = 0.25; // screen px per map unit (before zoom)
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(root: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'position:absolute;pointer-events:none;display:none;z-index:3';
    root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.canvas.style.display = this.visible ? 'block' : 'none';
  }

  zoom(factor: number): void {
    this.scale = Math.max(0.05, Math.min(2, this.scale * factor));
  }

  /** Draw over the view area of the game canvas (status bar left clear). */
  draw(sim: DoomSim, player: Player, gameCanvas: HTMLCanvasElement, viewX: number, viewY: number): void {
    if (!this.visible || !player.mo) return;

    const rect = gameCanvas.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height * (168 / 200)); // above the status bar
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.canvas.style.left = `${rect.left}px`;
    this.canvas.style.top = `${rect.top}px`;

    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.fillRect(0, 0, w, h);

    const s = this.scale;
    const cx = w / 2;
    const cy = h / 2;
    const tx = (mx: number) => cx + (mx - viewX) * s;
    const ty = (my: number) => cy - (my - viewY) * s;

    // level lines
    ctx.lineWidth = 1;
    for (const line of sim.world.lines) {
      if (line.flags & ML_DONTDRAW) continue;
      let color: string;
      if (!line.backsector || line.flags & ML_SECRET) {
        color = COLOR_WALL;
      } else if (line.frontsector!.floorheight !== line.backsector.floorheight) {
        color = COLOR_FLOORDIFF;
      } else if (line.frontsector!.ceilingheight !== line.backsector.ceilingheight) {
        color = COLOR_CEILDIFF;
      } else {
        color = COLOR_TWOSIDED;
      }
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(tx(line.v1.x / FRACUNIT), ty(line.v1.y / FRACUNIT));
      ctx.lineTo(tx(line.v2.x / FRACUNIT), ty(line.v2.y / FRACUNIT));
      ctx.stroke();
    }

    // placed blocks as filled cells
    if (sim.blocks.count > 0) {
      ctx.fillStyle = COLOR_BLOCK;
      const bs = BLOCK_UNITS * s;
      for (const cell of sim.blocks.entries()) {
        ctx.fillRect(
          tx(cell.bx * BLOCK_UNITS),
          ty(cell.by * BLOCK_UNITS + BLOCK_UNITS),
          Math.max(1, bs),
          Math.max(1, bs),
        );
      }
    }

    // the player: vanilla-style arrow (other players hidden — deathmatch)
    const mo = player.mo;
    const angle = (mo.angle / 4294967296) * Math.PI * 2;
    const px = tx(viewX);
    const py = ty(viewY);
    const len = Math.max(8, 16 * s * 2);
    const dirx = Math.cos(angle);
    const diry = -Math.sin(angle);
    ctx.strokeStyle = COLOR_PLAYER;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    // shaft
    ctx.moveTo(px - dirx * len, py - diry * len);
    ctx.lineTo(px + dirx * len, py + diry * len);
    // head barbs
    const barb = len * 0.5;
    const ba = Math.PI * 0.8;
    ctx.moveTo(px + dirx * len, py + diry * len);
    ctx.lineTo(
      px + dirx * len + Math.cos(angle + ba) * barb,
      py + diry * len - Math.sin(angle + ba) * barb,
    );
    ctx.moveTo(px + dirx * len, py + diry * len);
    ctx.lineTo(
      px + dirx * len + Math.cos(angle - ba) * barb,
      py + diry * len - Math.sin(angle - ba) * barb,
    );
    ctx.stroke();
  }
}
