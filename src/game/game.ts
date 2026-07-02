// Solo game shell (M4 debug mode, becomes the netgame client in M5):
// full sim with monsters/weapons/specials, sound, HUD, level progression.

import * as THREE from 'three';
import { AudioPlayer } from '../audio/audio.ts';
import { MusicPlayer, musicLumpForMap } from '../audio/music.ts';
import { InputHandler, requestLock } from '../input/input.ts';
import { OptionsMenu } from '../ui/options.ts';
import { MUS, musicNames } from '../sim/data/sounds.gen.ts';
import { BlocksMesh } from '../render/blocksmesh.ts';
import { HudView } from '../render/hud.ts';
import { LevelMesh } from '../render/levelmesh.ts';
import { MobjSprites } from '../render/mobjsprites.ts';
import { makeSky } from '../render/sky.ts';
import { TextureStore } from '../render/textures.ts';


import { FRACUNIT } from '../sim/fixed.ts';


import { gunTarget } from '../blocks/gun.ts';
import { BLOCK_UNITS } from '../blocks/grid.ts';
import { createGameSim } from '../sim/create.ts';
import { PlayerState as PS } from '../sim/defs.ts';
import { Weapon } from '../sim/items.ts';
import { INPUT_DELAY, NetClient } from '../net/client.ts';
import type { DoomSim } from '../sim/sim.ts';
import { textureHeights } from '../sim/specials/floors.ts';
import { PlayerState } from '../sim/defs.ts';
import { emptyCmd } from '../sim/ticcmd.ts';
import { listMaps, readMap, type MapData } from '../wad/maps.ts';
import { hashWad, WadFile } from '../wad/wad.ts';

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

export interface NetOptions {
  url: string;
  /** join this room; omit to create one */
  room?: string;
}

export async function runGame(root: HTMLElement, startMap: number, net?: NetOptions): Promise<void> {
  const resp = await fetch('/DOOM2.WAD');
  if (!resp.ok) {
    root.textContent = 'DOOM2.WAD not found — place it in the project root.';
    return;
  }
  const wadBuffer = await resp.arrayBuffer();
  const wad = new WadFile(wadBuffer);
  const maps = listMaps(wad);
  const store = new TextureStore(wad);
  populateTextureHeights(store);
  const audio = new AudioPlayer(wad);

  // --- lobby (netgame) -----------------------------------------------------
  let netClient: NetClient | null = null;
  let localSlot = 0;
  if (net) {
    const status = document.createElement('div');
    status.style.cssText =
      'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
      'color:#8f8;font:bold 24px monospace;text-align:center;white-space:pre';
    status.textContent = `Connecting to ${net.url}…`;
    root.appendChild(status);

    netClient = new NetClient();
    const hash = await hashWad(wadBuffer);
    try {
      // surface the room code while waiting for player 2
      const poll = setInterval(() => {
        if (netClient!.room) {
          status.textContent =
            `Room code: ${netClient!.room}\n\nwaiting for player 2…\n\n` +
            `they should open ${location.origin}/?server=${encodeURIComponent(net.url)}&room=${netClient!.room}`;
        }
      }, 300);
      const lobby = await netClient.connect(net.url, {
        room: net.room,
        map: startMap,
        wadHash: hash,
      });
      clearInterval(poll);
      localSlot = lobby.slot;
      startMap = lobby.map;
    } catch (err) {
      status.textContent = `Netgame error: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    status.remove();
  }

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

  const music = new MusicPlayer(wad, audio);
  const options = new OptionsMenu(root, audio, input, () => {
    options.hide();
    requestLock(renderer.domElement);
    audio.resume();
  });
  // Esc exits pointer lock; that's the options key. Only after the game
  // was actually captured once (not on the initial click-to-play screen).
  let wasLocked = false;
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === renderer.domElement) {
      wasLocked = true;
      options.hide();
    } else if (wasLocked) {
      options.show();
    }
  });

  const hud = new HudView(store, wad, root);
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
    'background:#000c;color:#e33;font:bold 28px monospace;text-align:center;white-space:pre;pointer-events:none';
  root.appendChild(overlay);

  const sim = createGameSim();
  sim.playeringame[0] = true;
  if (netClient) {
    sim.playeringame[1] = true;
    sim.netgame = true; // weapons stay placed for the other player
    sim.deathmatch = true; // DM spawn points, all keys, frags
  }
  const localPlayer = () => sim.players[localSlot]!;

  // prefill the input-delay buffer so both sims can start immediately
  if (netClient) {
    for (let i = 0; i < INPUT_DELAY; i++) netClient.pushLocalCmd(emptyCmd());
  }

  // block gun aids: world-space target cell outline + center crosshair
  const previewMesh = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(BLOCK_UNITS + 0.6, BLOCK_UNITS + 0.6, BLOCK_UNITS + 0.6)),
    new THREE.LineBasicMaterial({ color: 0x66ff66 }),
  );
  previewMesh.visible = false;
  previewMesh.renderOrder = 2;

  const crosshair = document.createElement('div');
  crosshair.style.cssText =
    'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);color:#8f8;display:none;' +
    'font:bold 18px monospace;text-shadow:1px 1px 0 #000;pointer-events:none';
  crosshair.textContent = '+';
  root.appendChild(crosshair);

  function updateBlockAids(): void {
    const p = localPlayer();
    const active = p.readyweapon === Weapon.BlockGun && p.playerstate === PS.Live && p.mo !== null;
    crosshair.style.display = active ? 'block' : 'none';
    if (!active) {
      previewMesh.visible = false;
      return;
    }
    // gunTarget only touches traversal scratch state — safe from the
    // render loop and guarantees the preview matches actual placement
    const target = gunTarget(sim, p);
    const cell = target.placeCell;
    if (!cell || sim.blocks.isSolid(cell.bx, cell.by, cell.bz)) {
      previewMesh.visible = false;
      return;
    }
    previewMesh.position.set(
      cell.bx * BLOCK_UNITS + BLOCK_UNITS / 2,
      cell.bz * BLOCK_UNITS + BLOCK_UNITS / 2,
      -(cell.by * BLOCK_UNITS + BLOCK_UNITS / 2),
    );
    previewMesh.visible = true;
  }

  // level state
  let mapNumber = startMap;
  let mapData: MapData;
  let level: LevelMesh | null = null;
  let sprites: MobjSprites | null = null;
  let blocksMesh: BlocksMesh | null = null;
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
    const p = localPlayer();
    curView = {
      x: p.mo!.x / FRACUNIT,
      y: p.mo!.y / FRACUNIT,
      z: p.viewz / FRACUNIT,
    };
  }

  function loadLevelSim(n: number): void {
    mapNumber = n;
    const name = `MAP${String(n).padStart(2, '0')}`;
    if (!maps.includes(name)) throw new Error(`no such map ${name}`);
    mapData = readMap(wad, name);
    sim.loadLevel(mapData, n, { spawnThings: true });
  }

  function loadLevel(n: number): void {
    loadLevelSim(n);
    buildLevelRender(n);
  }

  function buildLevelRender(n: number): void {
    const name = `MAP${String(n).padStart(2, '0')}`;

    level?.dispose();
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101010);
    level = new LevelMesh(mapData, store, wad, { dynamic: true });
    scene.add(level.group);
    sprites = new MobjSprites(store, wad);
    scene.add(sprites.group);
    blocksMesh = new BlocksMesh();
    scene.add(blocksMesh.mesh);
    scene.add(previewMesh);
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
    sprites.snapshot(sim, localPlayer().mo);
    snapshotView();
    snapshotView();

    music.play(musicLumpForMap(n, musicNames, MUS.runnin));
  }

  loadLevel(mapNumber);
  const initialMap = mapNumber;

  // --- desync recovery: rebuild the sim by replaying the full cmd log.
  // Determinism means the log is a complete serialization; both peers
  // reconstruct the same state independently.
  let lastResyncAt = -Infinity;
  function resyncFromLog(): boolean {
    if (!netClient) return false;
    const total = netClient.simTic;
    const t0 = performance.now();

    sim.resetForReplay();
    let map = initialMap;
    loadLevelSim(map);
    for (let t = 0; t < total; t++) {
      if (sim.exitPending) {
        const secret = sim.exitPending === 'secret';
        finishLevel(sim);
        map = nextMap(map, secret);
        loadLevelSim(map);
      }
      sim.runTic([netClient.getCmd(0, t), netClient.getCmd(1, t)]);
    }
    buildLevelRender(map);
    netClient.clearDesync();
    console.warn(
      `resynced: replayed ${total} tics in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return true;
  }

  // debug handle for scripted verification (harmless in production)
  (window as unknown as { __dc: unknown }).__dc = {
    sim,
    exit: () => sim.exitLevel(),
    kill: () => sim.damageMobj(localPlayer().mo!, null, null, 10000),
    where: () => ({
      map: mapNumber,
      x: localPlayer().mo!.x / 65536,
      y: localPlayer().mo!.y / 65536,
      health: localPlayer().health,
      state: localPlayer().playerstate,
      mobjs: [...sim.mobjs()].length,
    }),
  };

  // Runs after every simulated tic (solo and net take the same path).
  let intermission = 0;
  function postTic(): void {
    sprites!.snapshot(sim, localPlayer().mo);
    snapshotSectors();
    snapshotView();
    audio.playEvents(sim.soundEvents, {
      x: curView.x,
      y: curView.y,
      angle: bamToRad(localPlayer().mo!.angle),
    });
    // Exit fired this tic: freeze the sim (vanilla pauses the world at
    // intermission; lockstep-safe because both peers hit it on the same
    // sim tic and resume with the same buffered cmd sequence).
    if (sim.exitPending && intermission === 0) {
      const p = localPlayer();
      overlay.textContent =
        `${`MAP${String(mapNumber).padStart(2, '0')}`} COMPLETE\n\n` +
        `KILLS ${p.killcount}/${sim.totalkills}   ITEMS ${p.itemcount}/${sim.totalitems}   SECRETS ${p.secretcount}`;
      overlay.style.display = 'flex';
      intermission = 105; // 3 seconds
    }
  }

  /** One paused intermission tic; true if the tic slot was consumed. */
  function tickIntermission(): boolean {
    if (intermission === 0) return false;
    intermission--;
    if (intermission === 0) {
      overlay.style.display = 'none';
      const secret = sim.exitPending === 'secret';
      finishLevel(sim);
      loadLevel(nextMap(mapNumber, secret));
    }
    return true;
  }

  const waiting = document.createElement('div');
  waiting.style.cssText =
    'position:fixed;top:40%;left:50%;transform:translateX(-50%);color:#fc6;display:none;' +
    'font:bold 20px monospace;text-shadow:2px 2px 0 #000;pointer-events:none';
  waiting.textContent = 'waiting for peer…';
  root.appendChild(waiting);

  let acc = 0;
  let last = performance.now();
  let lastAdvance = performance.now();

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    acc += now - last;
    last = now;

    if (netClient && netClient.peerLeft) {
      overlay.textContent = 'PEER DISCONNECTED';
      overlay.style.display = 'flex';
    } else if (netClient && netClient.desync !== null) {
      // Try replay-based recovery; two desyncs within 30s means a
      // systematic determinism bug — give up rather than thrash.
      if (now - lastResyncAt < 30000) {
        overlay.textContent = `DESYNC at tic ${netClient.desync} — please restart`;
        overlay.style.display = 'flex';
      } else {
        lastResyncAt = now;
        resyncFromLog();
      }
    }

    let ran = 0;
    while (acc >= TIC_MS && ran < 4) {
      if (tickIntermission()) {
        lastAdvance = now;
        acc -= TIC_MS;
        ran++;
        continue;
      }
      if (netClient) {
        // lockstep: emit our cmd for (simTic + delay), then advance.
        // Pace advancement to 1 tic per slot (2 when a backlog built up)
        // so bursty cmd arrival doesn't turn into view stutter — the
        // interpolator needs a steady 35Hz cadence.
        netClient.pushLocalCmd(input.buildTicCmd());
        let allowed = netClient.bufferedAhead() > 6 ? 2 : 1;
        while (
          allowed-- > 0 &&
          intermission === 0 &&
          netClient.canAdvance() &&
          netClient.simTic < netClient.sendTic
        ) {
          netClient.advance(sim);
          postTic();
          lastAdvance = now;
        }
      } else {
        sim.runTic([input.buildTicCmd()]);
        postTic();
        lastAdvance = now;
      }
      acc -= TIC_MS;
      ran++;
    }
    if (ran === 4) acc = 0;

    waiting.style.display =
      netClient && now - lastAdvance > 350 && !netClient.peerLeft ? 'block' : 'none';

    const alpha = Math.min(1, acc / TIC_MS);
    const p = localPlayer();
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
    blocksMesh!.sync(sim);
    updateBlockAids();

    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    hud.update(sim, p);
    renderer.render(hud.scene, hud.camera);
  });
}
