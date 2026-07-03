// Solo game shell (M4 debug mode, becomes the netgame client in M5):
// full sim with monsters/weapons/specials, sound, HUD, level progression.

import * as THREE from 'three';
import { AudioPlayer } from '../audio/audio.ts';
import { MusicPlayer, musicLumpForMap } from '../audio/music.ts';
import { Automap } from '../render/automap.ts';
import { InputHandler, requestLock } from '../input/input.ts';
import { OptionsMenu } from '../ui/options.ts';
import { MUS, musicNames } from '../sim/data/sounds.gen.ts';
import { BlocksMesh } from '../render/blocksmesh.ts';
import { HudView } from '../render/hud.ts';
import { LevelMesh } from '../render/levelmesh.ts';
import { MobjSprites } from '../render/mobjsprites.ts';
import { NameTags } from '../render/nametags.ts';
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
import { cacheWad, loadWadBuffer } from '../wad/load.ts';
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
  /** host rule: allow the block gun (slot 8) in this netgame */
  blockGun?: boolean;
}

export async function runGame(root: HTMLElement, startMap: number, net?: NetOptions): Promise<void> {
  // Joiners resolve quietly (no picker): whatever the host plays gets
  // transferred through the relay if we don't already have it.
  let wadBuffer = await loadWadBuffer(root, { quiet: !!net?.room, multiplayer: !!net });
  let blockGunAllowed = true; // solo always has the block gun

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
    let playerName = '';
    try {
      playerName = (localStorage.getItem('doomcraft.playerName') ?? '').trim().slice(0, 12);
    } catch {
      // ignore
    }
    const hash = wadBuffer ? await hashWad(wadBuffer) : null;
    try {
      // Host lobby: room code, invite link, roster, and a START button
      // (2-4 players; the host decides when everyone's in). Joiners see
      // a waiting screen driven by roster updates.
      const isHost = !net.room;
      let shownRoom = '';
      let rosterLine: HTMLElement | null = null;
      let startBtn: HTMLButtonElement | null = null;
      let lastRoster = { count: 1, ready: 1, names: [] as string[] };
      const updateRosterUi = () => {
        if (rosterLine) {
          const who = lastRoster.names.filter(Boolean).join(', ');
          rosterLine.textContent = `${lastRoster.count} / 4 players` +
            (who ? `: ${who}` : '') +
            (lastRoster.ready < lastRoster.count ? ` (${lastRoster.count - lastRoster.ready} receiving WAD…)` : '');
        }
        if (startBtn) {
          const ok = lastRoster.count >= 2 && lastRoster.ready === lastRoster.count;
          startBtn.disabled = !ok;
          startBtn.style.opacity = ok ? '1' : '0.4';
          startBtn.style.cursor = ok ? 'pointer' : 'default';
        }
        if (!isHost && shownRoom !== '#wad') {
          status.textContent = `In room — waiting for the host to start… (${lastRoster.count} players)`;
        }
      };
      const poll = setInterval(() => {
        if (!isHost) return;
        const room = netClient!.room;
        if (!room || room === shownRoom) return;
        shownRoom = room;
        const sameOrigin =
          net.url === `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
        const joinUrl = sameOrigin
          ? `${location.origin}${location.pathname}?room=${room}`
          : `${location.origin}${location.pathname}?server=${encodeURIComponent(net.url)}&room=${room}`;
        status.innerHTML = `
          <div style="text-align:center">
            <div style="color:#a66;font:13px monospace;margin-bottom:8px">ROOM CODE</div>
            <div style="color:#e33;font:bold 56px monospace;letter-spacing:12px;user-select:all">${room}</div>
            <div style="color:#a66;font:14px monospace;margin:18px 0 10px">send players this link (2-4 players):</div>
            <div style="display:flex;gap:8px;justify-content:center">
              <input id="lobby-url" readonly value="${joinUrl}" style="width:340px;background:#1a1a1a;
                color:#ddd;border:1px solid #822;font:12px monospace;padding:8px"/>
              <button id="lobby-copy" style="padding:8px 16px;background:#822;color:#fff;border:none;
                font:bold 14px monospace;cursor:pointer">COPY</button>
            </div>
            <div id="lobby-roster" style="color:#8f8;font:14px monospace;margin:20px 0 12px">1 / 4 players in the room</div>
            <button id="lobby-start" disabled style="padding:12px 48px;background:#822;color:#fff;border:none;
              font:bold 18px monospace;opacity:0.4">START GAME</button>
          </div>`;
        const urlBox = status.querySelector('#lobby-url') as HTMLInputElement;
        const copyBtn = status.querySelector('#lobby-copy') as HTMLButtonElement;
        rosterLine = status.querySelector('#lobby-roster') as HTMLElement;
        startBtn = status.querySelector('#lobby-start') as HTMLButtonElement;
        startBtn.addEventListener('click', () => netClient!.begin());
        urlBox.addEventListener('focus', () => urlBox.select());
        copyBtn.addEventListener('click', () => {
          urlBox.select();
          navigator.clipboard?.writeText(joinUrl).catch(() => {});
          copyBtn.textContent = 'COPIED!';
          setTimeout(() => (copyBtn.textContent = 'COPY'), 1500);
        });
        updateRosterUi();
      }, 300);
      const lobby = await netClient.connect(net.url, {
        room: net.room,
        map: startMap,
        blockGun: net.blockGun,
        name: playerName,
        wadHash: hash,
        wadProvider: () => wadBuffer!,
        onRoster: (count, ready, names) => {
          lastRoster = { count, ready, names };
          updateRosterUi();
        },
        onWadProgress: (got, total) => {
          shownRoom = '#wad'; // stop the invite-link poll overwriting us
          status.textContent =
            total === 0
              ? 'Host is sending the game data…'
              : `Receiving game data from host… ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
        },
      });
      clearInterval(poll);
      localSlot = lobby.slot;
      startMap = lobby.map;
      blockGunAllowed = lobby.blockGun; // host rule, same on both peers
      if (lobby.receivedWad) {
        wadBuffer = lobby.receivedWad;
        void cacheWad(wadBuffer, 'from-host.wad'); // one-time: cached for next visit
      }
    } catch (err) {
      status.textContent = `Netgame error: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    status.remove();
  }

  if (!wadBuffer) {
    // solo/host without any resolvable WAD ends at the picker inside
    // loadWadBuffer; reaching here means a joiner failed the transfer
    root.textContent = 'No game data available.';
    return;
  }
  const wad = new WadFile(wadBuffer);
  const maps = listMaps(wad);
  const store = new TextureStore(wad);
  populateTextureHeights(store);
  const audio = new AudioPlayer(wad);

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  // Doom's chunky pixels don't need Retina density, and 1x cuts GPU load
  // ~4x on hidpi — the difference between judder and smoothness when two
  // windows share one GPU (options can re-enable hi-res).
  renderer.setPixelRatio(1);
  renderer.autoClear = false;
  root.style.background = '#000';
  const canvas = renderer.domElement;
  canvas.style.position = 'absolute';
  canvas.style.left = '50%';
  canvas.style.top = '50%';
  canvas.style.transform = 'translate(-50%, -50%)';
  root.appendChild(canvas);
  const camera = new THREE.PerspectiveCamera(75, 4 / 3, 1, 20000);

  // Vanilla is a 4:3 display; when locked, letterbox/pillarbox to the
  // largest 4:3 rectangle that fits (also gives the HUD its authentic
  // non-square-pixel proportions).
  let aspectLock = true;
  function applySize(): void {
    let w = window.innerWidth;
    let h = window.innerHeight;
    if (aspectLock) {
      if (w / h > 4 / 3) w = Math.round((h * 4) / 3);
      else h = Math.round((w * 3) / 4);
    }
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  applySize();
  window.addEventListener('resize', applySize);

  let nameTagsEnabled = true;
  const input = new InputHandler();
  input.attach(renderer.domElement);
  renderer.domElement.addEventListener('click', () => audio.resume());

  const music = new MusicPlayer(wad, audio);
  const options = new OptionsMenu(
    root,
    audio,
    input,
    () => {
      options.hide();
      requestLock(renderer.domElement);
      audio.resume();
    },
    (locked) => {
      aspectLock = locked;
      applySize();
    },
    (hires) => {
      renderer.setPixelRatio(hires ? window.devicePixelRatio : 1);
      applySize();
    },
    (show) => {
      nameTagsEnabled = show;
    },
  );
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
  const automap = new Automap(root);

  // --- debug panel (I key or ?debug): live transport/perf stats, plus a
  // compact JSON dump to the console every 5s while open (for sharing)
  const debug = document.createElement('div');
  debug.style.cssText =
    'position:fixed;top:8px;right:8px;color:#8f8;display:none;text-align:left;' +
    'font:12px monospace;text-shadow:1px 1px 0 #000;pointer-events:none;white-space:pre;' +
    'background:rgba(0,0,0,0.55);padding:8px 10px;z-index:6';
  root.appendChild(debug);
  let debugOn = new URLSearchParams(location.search).has('debug');
  debug.style.display = debugOn ? 'block' : 'none';
  const frameGaps: number[] = [];
  let advancesInWindow = 0;
  let stallMax = 0;
  let lastDebugDump = 0;
  let lastDebugPaint = performance.now();
  let resyncCount = 0;

  function debugSnapshot(now: number, fpsWindowMs: number): Record<string, unknown> {
    const gaps = [...frameGaps].sort((a, b) => a - b);
    const mean = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);
    return {
      fps: Math.round(1000 / (mean || 1)),
      gapP95: gaps.length ? Number(gaps[Math.floor(gaps.length * 0.95)]!.toFixed(1)) : null,
      gapMax: gaps.length ? Number(gaps[gaps.length - 1]!.toFixed(1)) : null,
      ticsPerSec: Math.round((advancesInWindow / fpsWindowMs) * 1000),
      stallMaxMs: Math.round(stallMax),
      map: mapNumber,
      resyncs: resyncCount,
      ...(netClient ? netClient.stats() : { solo: true }),
    };
  }

  // transient top-center announcements (player left, etc.)
  const toasts = document.createElement('div');
  toasts.style.cssText =
    'position:fixed;top:12%;left:50%;transform:translateX(-50%);text-align:center;' +
    'pointer-events:none;z-index:5';
  root.appendChild(toasts);
  function toast(text: string): void {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText =
      'color:#e33;font:bold 22px monospace;text-shadow:2px 2px 0 #000;margin-bottom:6px;' +
      'transition:opacity 1s';
    toasts.appendChild(el);
    setTimeout(() => (el.style.opacity = '0'), 3200);
    setTimeout(() => el.remove(), 4300);
  }
  if (netClient) {
    netClient.onPlayerLeft = (slot) => toast(`${netClient!.nameOf(slot).toUpperCase()} LEFT THE GAME`);
  }
  const playerLabel = (slot: number): string =>
    netClient ? netClient.nameOf(slot).toUpperCase() : `PLAYER ${slot + 1}`;
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Tab') {
      e.preventDefault(); // keep focus in the game
      automap.toggle();
    } else if (automap.visible && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
      automap.zoom(1.25);
    } else if (automap.visible && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
      automap.zoom(1 / 1.25);
    } else if (e.code === 'KeyI') {
      debugOn = !debugOn;
      debug.style.display = debugOn ? 'block' : 'none';
    }
  });
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
    'background:#000c;color:#e33;font:bold 28px monospace;text-align:center;white-space:pre;pointer-events:none';
  root.appendChild(overlay);

  const sim = createGameSim();
  sim.playeringame[0] = true;
  if (netClient) {
    for (let i = 1; i < netClient.playerCount; i++) sim.playeringame[i] = true;
    sim.netgame = true; // weapons stay placed for the other players
    sim.deathmatch = true; // DM spawn points, all keys, frags
    sim.allowBlockGun = blockGunAllowed; // host rule (lobby-agreed)
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
  let nameTags: NameTags | null = null;
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
    nameTags = new NameTags();
    scene.add(nameTags.group);
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
    // departed players were present from the start; they drop again at
    // their recorded tic during the replay
    for (let i = 0; i < netClient.playerCount; i++) sim.playeringame[i] = true;
    let map = initialMap;
    loadLevelSim(map);
    for (let t = 0; t < total; t++) {
      for (const [slot, dropTic] of netClient.departures) {
        if (dropTic === t) sim.dropPlayer(slot);
      }
      if (sim.exitPending) {
        const secret = sim.exitPending === 'secret';
        finishLevel(sim);
        map = nextMap(map, secret);
        loadLevelSim(map);
      }
      sim.runTic([0, 1, 2, 3].map((i) => netClient!.getCmd(i, t)));
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
    input,
    net: netClient,
    look: () => ({
      angle: localPlayer().mo!.angle,
      queued: netClient ? netClient.pendingLocalTurn().yaw : 0,
      pending: input.pendingYawTurn() << 16,
      cam: camera.rotation.y,
      simTic: netClient?.simTic ?? -1,
      sendTic: netClient?.sendTic ?? -1,
    }),
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
    // kill feed (presentational; names never enter the sim)
    for (const f of sim.fragEvents) {
      if (netClient) {
        toast(
          f.killer === null
            ? `${playerLabel(f.victim)} DIED`
            : f.killer === f.victim
              ? `${playerLabel(f.victim)} FRAGGED THEMSELVES`
              : `${playerLabel(f.killer)} FRAGGED ${playerLabel(f.victim)}`,
        );
      }
    }
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
  let lastFrame = performance.now();

  function pumpTics(now: number): void {
    acc += now - last;
    last = now;

    if (netClient && netClient.desync !== null) {
      // Try replay-based recovery; two desyncs within 30s means a
      // systematic determinism bug — give up rather than thrash.
      if (now - lastResyncAt >= 30000) {
        lastResyncAt = now;
        resyncCount++;
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
        // frozen while a desync awaits resync (or the fatal overlay)
        if (netClient.desync !== null) {
          lastAdvance = now;
          acc -= TIC_MS;
          ran++;
          continue;
        }
        // lockstep: emit our cmd for (simTic + delay), then advance.
        // Pace advancement to 1 tic per slot so bursty cmd arrival
        // doesn't turn into view stutter; scale catch-up with backlog.
        netClient.pushLocalCmd(input.buildTicCmd());
        const ahead = netClient.bufferedAhead();
        let allowed = ahead > 20 ? 4 : ahead > 6 ? 2 : 1;
        while (
          allowed-- > 0 &&
          intermission === 0 &&
          netClient.canAdvance() &&
          netClient.simTic < netClient.sendTic
        ) {
          netClient.advance(sim);
          postTic();
          lastAdvance = now;
          advancesInWindow++;
        }
      } else {
        sim.runTic([input.buildTicCmd()]);
        postTic();
        lastAdvance = now;
        advancesInWindow++;
      }
      acc -= TIC_MS;
      ran++;
    }
    if (ran === 4) acc = 0;
  }

  // Watchdog: browsers throttle rAF AND main-thread timers in hidden/
  // backgrounded windows (down to 1/sec, or 1/min under intensive
  // throttling), which would starve the peer of our cmds. Timers inside
  // a dedicated Web Worker are NOT visibility-throttled, so a tiny
  // worker acts as the clock; its messages arrive promptly even in
  // background tabs and drive the sim whenever rAF has stalled.
  const clockWorker = new Worker(
    URL.createObjectURL(
      new Blob(['setInterval(() => postMessage(0), 28);'], { type: 'text/javascript' }),
    ),
  );
  clockWorker.onmessage = () => {
    const now = performance.now();
    if (now - lastFrame > 80) pumpTics(now);
  };

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    if (debugOn) {
      frameGaps.push(now - lastFrame);
      stallMax = Math.max(stallMax, now - lastAdvance);
      if (now - lastDebugPaint > 500 && frameGaps.length > 5) {
        const s = debugSnapshot(now, now - lastDebugPaint);
        lastDebugPaint = now;
        debug.textContent = Object.entries(s)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join('\n');
        if (now - lastDebugDump > 5000) {
          lastDebugDump = now;
          console.info('[doomcraft-debug]', JSON.stringify(s));
        }
        frameGaps.length = 0;
        advancesInWindow = 0;
        stallMax = 0;
      }
    }
    lastFrame = now;

    if (netClient && netClient.peerLeft) {
      overlay.textContent = 'PEER DISCONNECTED';
      overlay.style.display = 'flex';
    } else if (netClient && netClient.desync !== null && performance.now() - lastResyncAt < 30000) {
      overlay.textContent = `DESYNC at tic ${netClient.desync} — please restart`;
      overlay.style.display = 'flex';
    }

    pumpTics(now);

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
    // Latency-free look: sim angle + turn queued in sent-but-unsimulated
    // cmds (lockstep applies our cmds INPUT_DELAY tics later — without
    // this term every turn vanishes for ~86ms after being consumed) +
    // the not-yet-consumed mouse delta.
    const queued = netClient ? netClient.pendingLocalTurn() : { yaw: 0, pitch: 0 };
    const yaw = bamToRad((mo.angle + queued.yaw + (input.pendingYawTurn() << 16)) | 0);
    const pitch =
      p.playerstate === PlayerState.Dead
        ? 0
        : bamToRad((mo.pitch + queued.pitch + (input.pendingPitchTurn() << 16)) | 0);
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
    if (netClient && nameTags) {
      nameTags.enabled = nameTagsEnabled;
      nameTags.update(sim, sprites!, netClient.names, localSlot);
    }
    blocksMesh!.sync(sim);
    updateBlockAids();

    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    hud.update(sim, p);
    renderer.render(hud.scene, hud.camera);
    automap.draw(sim, p, renderer.domElement, vx, vy);
  });
}
