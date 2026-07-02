// M3 playable viewer: walk a map with real Doom physics (no combat yet).
// The sim runs at 35Hz; rendering interpolates between tics.

import * as THREE from 'three';
import { InputHandler } from '../input/input.ts';
import { LevelMesh } from '../render/levelmesh.ts';
import { makeSky } from '../render/sky.ts';
import { TextureStore } from '../render/textures.ts';
import { FRACUNIT } from '../sim/fixed.ts';
import { DoomSim } from '../sim/sim.ts';
import { listMaps, readMap } from '../wad/maps.ts';
import { WadFile } from '../wad/wad.ts';

const TIC_MS = 1000 / 35;

// BAM int32 angle → radians (signed fraction of a full turn)
function bamToRad(angle: number): number {
  return (angle / 4294967296) * (Math.PI * 2);
}

export async function runPlayViewer(root: HTMLElement, mapName: string): Promise<void> {
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

  // Renderer
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

  // Sim
  const sim = new DoomSim();
  sim.playeringame[0] = true;
  sim.loadLevel(map, parseInt(mapName.slice(3), 10));

  const input = new InputHandler();
  input.attach(renderer.domElement);

  // Interpolation state
  const player = () => sim.players[0]!;
  let prevX = 0, prevY = 0, prevZ = 0;
  let curX = 0, curY = 0, curZ = 0;
  const snapshot = () => {
    prevX = curX; prevY = curY; prevZ = curZ;
    const p = player();
    curX = p.mo!.x / FRACUNIT;
    curY = p.mo!.y / FRACUNIT;
    curZ = p.viewz / FRACUNIT;
  };
  snapshot();
  snapshot();

  const hud = document.createElement('div');
  hud.style.cssText =
    'position:fixed;top:8px;left:8px;color:#8f8;font:12px monospace;pointer-events:none;text-shadow:1px 1px 0 #000';
  root.appendChild(hud);

  let acc = 0;
  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    acc += now - last;
    last = now;

    // Run sim tics (cap to avoid spiral of death on tab-switch).
    let ran = 0;
    while (acc >= TIC_MS && ran < 4) {
      const cmd = input.buildTicCmd();
      sim.runTic([cmd]);
      snapshot();
      acc -= TIC_MS;
      ran++;
    }
    if (ran === 4) acc = 0;

    const alpha = Math.min(1, acc / TIC_MS);
    const x = prevX + (curX - prevX) * alpha;
    const y = prevY + (curY - prevY) * alpha;
    const z = prevZ + (curZ - prevZ) * alpha;
    camera.position.set(x, z, -y);

    // Latency-free look: sim angle + un-consumed mouse delta.
    const mo = player().mo!;
    const yaw = bamToRad((mo.angle + (input.pendingYawTurn() << 16)) | 0);
    const pitch = bamToRad((mo.pitch + (input.pendingPitchTurn() << 16)) | 0);
    // Doom angle 0 = east; three yaw 0 looks -Z (= north). Offset -90°.
    camera.rotation.set(pitch, yaw - Math.PI / 2, 0, 'YXZ');

    if (sky) sky.position.copy(camera.position);
    level.updateSprites(camera);
    renderer.render(scene, camera);

    hud.textContent =
      `${mapName} | tic ${sim.leveltime} | pos ${(mo.x / FRACUNIT).toFixed(0)},${(mo.y / FRACUNIT).toFixed(0)},` +
      `${(mo.z / FRACUNIT).toFixed(0)} | momz ${(mo.momz / FRACUNIT).toFixed(1)} | ` +
      `click to play (WASD move, mouse look, space jump)`;
  });
}
