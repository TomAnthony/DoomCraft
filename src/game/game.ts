// Solo game shell (M4 debug mode, becomes the netgame client in M5):
// full sim with monsters/weapons/specials, sound, HUD, level progression.

import * as THREE from 'three';
import { AudioPlayer } from '../audio/audio.ts';
import { InputHandler } from '../input/input.ts';
import { HudView } from '../render/hud.ts';
import { LevelMesh } from '../render/levelmesh.ts';
import { MobjSprites } from '../render/mobjsprites.ts';
import { makeSky } from '../render/sky.ts';
import { TextureStore } from '../render/textures.ts';


import { FRACUNIT } from '../sim/fixed.ts';


import { createGameSim } from '../sim/create.ts';
import type { DoomSim } from '../sim/sim.ts';
import { textureHeights } from '../sim/specials/floors.ts';
import { PlayerState } from '../sim/defs.ts';
import { listMaps, readMap, type MapData } from '../wad/maps.ts';
import { WadFile } from '../wad/wad.ts';

const TIC_MS = 1000 / 35;

function bamToRad(angle: number): number {
  return (angle / 4294967296) * (Math.PI * 2);
}

/** DOOM2 progression incl. secret exits: 15→31, 31→32, 32→16. */
export function nextMap(current: number, secret: boolean): number {
  if (secret) {
    if (current === 15) return 31;
    if (current === 31) return 32;
    return current + 1;
  }
  if (current === 31 || current === 32) return 16;
  if (current === 30) return 1; // wrap after the icon
  return current + 1;
}

/** raiseToTexture needs wall texture heights (render-side data). */
export function populateTextureHeights(store: TextureStore): void {
  textureHeights.clear();
  for (const [name, def] of store.wallDefs) {
    textureHeights.set(name, def.height << 16);
  }
}

/** G_PlayerFinishLevel: strip transient state between levels. */
function finishLevel(sim: DoomSim): void {
  for (const p of sim.players) {
    p.powers = [0, 0, 0, 0, 0, 0];
    p.cards = [false, false, false, false, false, false];
    if (p.mo) p.mo.flags &= ~0x40000; // MF_SHADOW off
    p.extralight = 0;
    p.fixedcolormap = 0;
    p.damagecount = 0;
    p.bonuscount = 0;
    p.message = null;
  }
}

export async function runGame(root: HTMLElement, startMap: number): Promise<void> {
  const resp = await fetch('/DOOM2.WAD');
  if (!resp.ok) {
    root.textContent = 'DOOM2.WAD not found — place it in the project root.';
    return;
  }
  const wad = new WadFile(await resp.arrayBuffer());
  const maps = listMaps(wad);
  const store = new TextureStore(wad);
  populateTextureHeights(store);
  const audio = new AudioPlayer(wad);

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.autoClear = false;
  root.appendChild(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 20000);
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const input = new InputHandler();
  input.attach(renderer.domElement);
  renderer.domElement.addEventListener('click', () => audio.resume());

  const hud = new HudView(store, wad, root);
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
    'background:#000c;color:#e33;font:bold 28px monospace;text-align:center;white-space:pre;pointer-events:none';
  root.appendChild(overlay);

  const sim = createGameSim();
  sim.playeringame[0] = true;

  // level state
  let mapNumber = startMap;
  let mapData: MapData;
  let level: LevelMesh | null = null;
  let sprites: MobjSprites | null = null;
  let sky: THREE.Mesh | null = null;
  let scene = new THREE.Scene();

  // interpolation state
  let prevView = { x: 0, y: 0, z: 0 };
  let curView = { x: 0, y: 0, z: 0 };
  const numSectors = () => sim.world.sectors.length;
  let sectorArrays = {
    prevFloor: new Float64Array(0),
    curFloor: new Float64Array(0),
    prevCeil: new Float64Array(0),
    curCeil: new Float64Array(0),
    lights: new Float64Array(0),
  };

  function snapshotSectors(): void {
    const n = numSectors();
    const a = sectorArrays;
    for (let i = 0; i < n; i++) {
      a.prevFloor[i] = a.curFloor[i]!;
      a.prevCeil[i] = a.curCeil[i]!;
      const s = sim.world.sectors[i]!;
      a.curFloor[i] = s.floorheight / FRACUNIT;
      a.curCeil[i] = s.ceilingheight / FRACUNIT;
      a.lights[i] = s.lightlevel;
    }
  }

  function snapshotView(): void {
    prevView = curView;
    const p = sim.players[0]!;
    curView = {
      x: p.mo!.x / FRACUNIT,
      y: p.mo!.y / FRACUNIT,
      z: p.viewz / FRACUNIT,
    };
  }

  function loadLevel(n: number): void {
    mapNumber = n;
    const name = `MAP${String(n).padStart(2, '0')}`;
    if (!maps.includes(name)) throw new Error(`no such map ${name}`);
    mapData = readMap(wad, name);
    sim.loadLevel(mapData, n, { spawnThings: true });

    level?.dispose();
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101010);
    level = new LevelMesh(mapData, store, wad, { dynamic: true });
    scene.add(level.group);
    sprites = new MobjSprites(store, wad);
    scene.add(sprites.group);
    sky = makeSky(store, name);
    if (sky) scene.add(sky);

    const n2 = numSectors();
    sectorArrays = {
      prevFloor: new Float64Array(n2),
      curFloor: new Float64Array(n2),
      prevCeil: new Float64Array(n2),
      curCeil: new Float64Array(n2),
      lights: new Float64Array(n2),
    };
    snapshotSectors();
    snapshotSectors();
    sprites.snapshot(sim, sim.players[0]!.mo);
    snapshotView();
    snapshotView();
  }

  loadLevel(mapNumber);

  let exitCountdown = 0;
  let acc = 0;
  let last = performance.now();

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    acc += now - last;
    last = now;

    let ran = 0;
    while (acc >= TIC_MS && ran < 4) {
      if (exitCountdown > 0) {
        // intermission pause
        exitCountdown--;
        if (exitCountdown === 0) {
          overlay.style.display = 'none';
          finishLevel(sim);
          loadLevel(nextMap(mapNumber, sim.exitPending === 'secret'));
        }
      } else {
        const cmd = input.buildTicCmd();
        sim.runTic([cmd]);
        sprites!.snapshot(sim, sim.players[0]!.mo);
        snapshotSectors();
        snapshotView();
        audio.playEvents(sim.soundEvents, {
          x: curView.x,
          y: curView.y,
          angle: bamToRad(sim.players[0]!.mo!.angle),
        });
        if (sim.exitPending) {
          const p = sim.players[0]!;
          overlay.textContent =
            `${`MAP${String(mapNumber).padStart(2, '0')}`} COMPLETE\n\n` +
            `KILLS ${p.killcount}/${sim.totalkills}   ITEMS ${p.itemcount}/${sim.totalitems}   SECRETS ${p.secretcount}`;
          overlay.style.display = 'flex';
          exitCountdown = 105; // 3 seconds
        }
      }
      acc -= TIC_MS;
      ran++;
    }
    if (ran === 4) acc = 0;

    const alpha = Math.min(1, acc / TIC_MS);
    const p = sim.players[0]!;
    const mo = p.mo!;

    // camera
    const vx = prevView.x + (curView.x - prevView.x) * alpha;
    const vy = prevView.y + (curView.y - prevView.y) * alpha;
    const vz = prevView.z + (curView.z - prevView.z) * alpha;
    camera.position.set(vx, vz, -vy);
    const yaw = bamToRad((mo.angle + (input.pendingYawTurn() << 16)) | 0);
    const pitch =
      p.playerstate === PlayerState.Dead
        ? 0
        : bamToRad((mo.pitch + (input.pendingPitchTurn() << 16)) | 0);
    camera.rotation.set(pitch, yaw - Math.PI / 2, 0, 'YXZ');

    // world geometry interpolation
    const a = sectorArrays;
    const interpFloor = new Float64Array(a.curFloor.length);
    const interpCeil = new Float64Array(a.curCeil.length);
    for (let i = 0; i < interpFloor.length; i++) {
      interpFloor[i] = a.prevFloor[i]! + (a.curFloor[i]! - a.prevFloor[i]!) * alpha;
      interpCeil[i] = a.prevCeil[i]! + (a.curCeil[i]! - a.prevCeil[i]!) * alpha;
    }
    level!.updateSectors(interpFloor, interpCeil, a.lights);

    if (sky) sky.position.copy(camera.position);
    sprites!.update(sim, camera, alpha, mo);

    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    hud.update(sim, p);
    renderer.render(hud.scene, hud.camera);
  });
}
