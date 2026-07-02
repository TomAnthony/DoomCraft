// Instanced rendering of the voxel blocks: one InstancedMesh, synced to
// the sim grid via its version counter. Damage shows as a darkening/red
// tint through instance colors.

import * as THREE from 'three';
import { BLOCK_HP, BLOCK_UNITS, MAX_BLOCKS, type BlockGrid } from '../blocks/grid.ts';

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
  private readonly dummy = new THREE.Object3D();

  constructor() {
    const geometry = new THREE.BoxGeometry(BLOCK_UNITS, BLOCK_UNITS, BLOCK_UNITS);
    const material = new THREE.MeshBasicMaterial({ map: makeBlockTexture() });
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_BLOCKS);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_BLOCKS * 3), 3,
    );
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  sync(grid: BlockGrid): void {
    if (grid.version === this.lastVersion) return;
    this.lastVersion = grid.version;

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
      // crack tint: full hp = light gray, damaged = darker and redder
      const f = Math.max(0.25, cell.hp / BLOCK_HP);
      this.mesh.setColorAt(i, new THREE.Color(1 * (0.5 + 0.5 * f), f, f));
      i++;
    }
    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}
