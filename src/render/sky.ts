// Sky: a camera-following inverted cylinder textured with the map's sky.
// Doom 2 sky selection: SKY1 for MAP01-11, SKY2 for 12-20, SKY3 for 21-32.

import * as THREE from 'three';
import type { TextureStore } from './textures.ts';

export function skyNameForMap(mapName: string): string {
  const n = parseInt(mapName.slice(3), 10);
  if (n >= 21) return 'SKY3';
  if (n >= 12) return 'SKY2';
  return 'SKY1';
}

export function makeSky(store: TextureStore, mapName: string): THREE.Mesh | null {
  const entry = store.wallTexture(skyNameForMap(mapName));
  if (!entry) return null;
  const radius = 8192;
  // Tall enough that looking up at max pitch never sees past the rim.
  const geometry = new THREE.CylinderGeometry(radius, radius, radius * 3, 32, 1, true);
  const texture = entry.texture.clone();
  texture.needsUpdate = true;
  texture.repeat.set(4, 1); // vanilla sky tiles 4x around
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}
