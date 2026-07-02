// M2 debug page: fly through any map. ?map=MAP07 selects the level.

import * as THREE from 'three';
import { FlyCamera } from '../render/flycam.ts';
import { LevelMesh } from '../render/levelmesh.ts';
import { makeSky } from '../render/sky.ts';
import { TextureStore } from '../render/textures.ts';
import { pointInSector } from '../render/bsp.ts';
import { listMaps, readMap } from '../wad/maps.ts';
import { WadFile } from '../wad/wad.ts';

export async function runMapViewer(root: HTMLElement, mapName: string): Promise<void> {
  const resp = await fetch('/DOOM2.WAD');
  if (!resp.ok) {
    root.textContent = 'DOOM2.WAD not found — place it in the project root.';
    return;
  }
  const wad = new WadFile(await resp.arrayBuffer());
  if (!listMaps(wad).includes(mapName)) {
    root.textContent = `Unknown map ${mapName}`;
    return;
  }
  const map = readMap(wad, mapName);
  const store = new TextureStore(wad);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101010);
  const level = new LevelMesh(map, store, wad);
  scene.add(level.group);
  const sky = makeSky(store, mapName);
  if (sky) scene.add(sky);

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  root.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(
    75, window.innerWidth / window.innerHeight, 1, 20000,
  );
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Spawn at the player 1 start, eye height 41 above the floor.
  const start = map.things.find((t) => t.type === 1) ?? { x: 0, y: 0, angle: 0 };
  const startSector = map.sectors[pointInSector(map, start.x, start.y)]!;
  camera.position.set(start.x, startSector.floorHeight + 41, -start.y);
  const fly = new FlyCamera(camera, renderer.domElement);
  // Doom angle: 0=east, 90=north. Camera yaw 0 looks -Z (= map north).
  fly.yaw = ((start.angle - 90) * Math.PI) / 180;

  // HUD overlay
  const hud = document.createElement('div');
  hud.style.cssText =
    'position:fixed;top:8px;left:8px;color:#8f8;font:12px monospace;pointer-events:none;text-shadow:1px 1px 0 #000';
  root.appendChild(hud);

  let last = performance.now();
  let frames = 0;
  let fps = 0;
  let fpsTime = last;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    frames++;
    if (now - fpsTime > 500) {
      fps = Math.round((frames * 1000) / (now - fpsTime));
      frames = 0;
      fpsTime = now;
    }
    fly.update(dt);
    if (sky) sky.position.copy(camera.position);
    level.updateSprites(camera);
    renderer.render(scene, camera);
    hud.textContent =
      `${mapName} | ${fps} fps | ${renderer.info.render.calls} draw calls | ` +
      `${renderer.info.render.triangles} tris | click to fly (WASD, QE up/down, shift fast)`;
  });
}
