// Instanced rendering of the voxel blocks: one InstancedMesh, synced to
// the sim grid via its version counter. Damage shows as a darkening/red
// tint through instance colors.

import * as THREE from 'three';
import { BLOCK_FX, BLOCK_HP, BLOCK_UNITS, MAX_BLOCKS } from '../blocks/grid.ts';
import { pointInSubsector } from '../sim/maputl.ts';
import type { DoomSim } from '../sim/sim.ts';

/** Procedural 64x64 stone-brick texture (no WAD dependency). */
function makeBlockTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // brick pattern: 2 rows of 2 bricks with offset
      const row = y >> 5;
      const bx = (x + (row % 2 === 0 ? 0 : 16)) % 32;
      const mortar = y % 32 < 2 || bx < 2;
      // deterministic speckle
      const n = ((x * 7919 + y * 104729) % 23) - 11;
      let v = mortar ? 70 : 130 + n * 3;
      v = Math.max(40, Math.min(200, v));
      data[i] = v;
      data[i + 1] = v * 0.95;
      data[i + 2] = v * 0.85;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export class BlocksMesh {
  readonly mesh: THREE.InstancedMesh;
  private lastVersion = -1;
  private lastLightStamp = -1;
  private readonly dummy = new THREE.Object3D();

  constructor() {
    const geometry = new THREE.BoxGeometry(BLOCK_UNITS, BLOCK_UNITS, BLOCK_UNITS);
    const material = new THREE.MeshBasicMaterial({
      map: makeBlockTexture(),
      // blocks often sit flush with floors/walls; win the depth fight
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_BLOCKS);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_BLOCKS * 3), 3,
    );
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  sync(sim: DoomSim): void {
    const grid = sim.blocks;
    // re-tint on grid changes or once per sim tic (sector lights flicker)
    if (grid.version === this.lastVersion && sim.leveltime === this.lastLightStamp) return;
    this.lastVersion = grid.version;
    this.lastLightStamp = sim.leveltime;

    const color = new THREE.Color();
    let i = 0;
    for (const cell of grid.entries()) {
      // map coords: cell center; three: x, height, -y
      this.dummy.position.set(
        cell.bx * BLOCK_UNITS + BLOCK_UNITS / 2,
        cell.bz * BLOCK_UNITS + BLOCK_UNITS / 2,
        -(cell.by * BLOCK_UNITS + BLOCK_UNITS / 2),
      );
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);

      // sector light at the cell (matches the surrounding world shading)
      const sector = pointInSubsector(
        sim.world,
        cell.bx * BLOCK_FX + BLOCK_FX / 2,
        cell.by * BLOCK_FX + BLOCK_FX / 2,
      ).sector;
      const light = Math.min(1, sector.lightlevel / 255 + 0.08);

      // crack tint: full hp = neutral, damaged = darker and redder
      const f = Math.max(0.25, cell.hp / BLOCK_HP);
      color.setRGB((0.5 + 0.5 * f) * light, f * light, f * light);
      this.mesh.setColorAt(i, color);
      i++;
    }
    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}
