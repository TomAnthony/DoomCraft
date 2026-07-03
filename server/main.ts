// DoomCraft relay server: WebSocket lobby with 4-char room codes plus
// static hosting of the built client. Holds no game state — after start
// it relays binary frames between up to 4 peers: cmd/checksum frames
// (byte1 = sender slot) broadcast to everyone else; WAD transfer frames
// (byte1 = target slot) route to one peer. The host starts the game
// explicitly ('begin') once 2-4 players are present and WAD-ready.
//
// Usage: node --experimental-strip-types server/main.ts [port] [--wad path[:key]]...
//
// WAD serving: freedm.wad from the project root is always served at
// /freedm.wad (it's freely distributable). Additional WADs are only
// served when registered with --wad, at /wad/<key> — the key defaults
// to the file's basename but can be any string, so a non-guessable key
// acts as a private handle (e.g. --wad DOOM2.WAD:s3cret → ?wad=s3cret).
// Nothing else from the project root is reachable.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const args = process.argv.slice(2);
const PORT = Number(args.find((a) => /^\d+$/.test(a)) ?? process.env.PORT ?? 8666);
const DIST = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
const ROOT = join(DIST, '..');

/** url key → filesystem path, from --wad path[:key] */
const servedWads = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--wad' && args[i + 1]) {
    const spec = args[++i]!;
    const sep = spec.lastIndexOf(':');
    const path = sep > 0 ? spec.slice(0, sep) : spec;
    const key = sep > 0 ? spec.slice(sep + 1) : basename(path);
    servedWads.set(key, join(ROOT, path));
    console.log(`serving ${path} at /wad/${key}`);
  }
}

const MAX_ROOM_PLAYERS = 4;

interface Room {
  code: string;
  map: number;
  skill: number;
  wadHash: string;
  blockGun: boolean; // host rule: block gun (slot 8) available
  players: (WebSocket | null)[]; // slot 0 = creator/host
  ready: boolean[]; // WAD hash verified per slot
  started: boolean;
  /** highest cmd tic relayed per slot (arbitrates dropout tic) */
  lastTic: number[];
}

const rooms = new Map<string, Room>();

function roster(r: Room): void {
  const count = r.players.filter(Boolean).length;
  const ready = r.players.filter((p, i) => p && r.ready[i]).length;
  const msg = JSON.stringify({ t: 'roster', count, ready });
  for (const p of r.players) {
    if (p && p.readyState === WebSocket.OPEN) p.send(msg);
  }
}

/** Compact slots (drop pre-start leavers) and start the game. */
function start(r: Room): void {
  const live = r.players.filter(Boolean) as WebSocket[];
  r.players = [...live];
  while (r.players.length < MAX_ROOM_PLAYERS) r.players.push(null);
  r.started = true;
  for (let i = 0; i < live.length; i++) {
    live[i]!.send(
      JSON.stringify({
        t: 'start',
        map: r.map,
        skill: r.skill,
        slot: i,
        players: live.length,
        blockGun: r.blockGun,
      }),
    );
  }
  console.log(`room ${r.code} started with ${live.length} players`);
}

function makeCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

const http = createServer(async (req, res) => {
  try {
    let path = normalize(decodeURIComponent(req.url?.split('?')[0] ?? '/'));
    if (path === '/' || path.includes('..')) path = '/index.html';
    if (path === '/play') path = '/play.html'; // game launch screen
    let file: Buffer;
    if (path === '/freedm.wad' || path === '/freedoom2.wad') {
      // freely-distributable Freedoom IWADs, served from the project root
      file = await readFile(join(ROOT, path.slice(1)));
    } else if (path.startsWith('/wad/')) {
      const target = servedWads.get(path.slice(5));
      if (!target) throw new Error('unregistered wad');
      file = await readFile(target);
    } else {
      file = await readFile(join(DIST, path));
    }
    // WADs never change and vite asset filenames are content-hashed —
    // let browsers cache them so reloads don't re-download 20MB
    const cacheable = path.toLowerCase().endsWith('.wad') || path.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': cacheable ? 'public, max-age=604800' : 'no-cache',
    });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end('not found (run `npm run build` for static hosting)');
  }
});

const MAX_ROOMS = 500;

// maxPayload: ticcmds are 15B and WAD chunks 256KB+5B — cap frames at
// 1MB so a hostile client can't buffer huge frames in server memory.
const wss = new WebSocketServer({ server: http, maxPayload: 1024 * 1024 });

// periodic one-line stats so a traffic spike is visible in the logs
setInterval(() => {
  if (rooms.size > 0 || wss.clients.size > 0) {
    console.log(`[stats] rooms=${rooms.size} sockets=${wss.clients.size} rss=${(process.memoryUsage.rss() / 1048576).toFixed(0)}MB`);
  }
}, 60_000).unref();

wss.on('connection', (ws) => {
  let room: Room | null = null;
  let slot = -1;

  const sendTo = (p: WebSocket | null, data: unknown): void => {
    if (p && p.readyState === WebSocket.OPEN) {
      // a hopelessly backlogged socket (>64MB) gets killed rather than
      // ballooning server memory
      if (p.bufferedAmount > 64 * 1024 * 1024) p.terminate();
      else p.send(data as Buffer);
    }
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!room) return;
      // byte0 = type, byte1 = slot: cmd/checksum (1/2) broadcast from a
      // sender; WAD meta/chunk (3/4) route to a target
      const buf = data as Buffer;
      const type = buf[0];
      if (type === 3 || type === 4) {
        sendTo(room.players[buf[1]!] ?? null, data);
      } else {
        // track the sender's newest cmd tic — it arbitrates the exact
        // tic at which survivors drop a leaver (lockstep must agree)
        if (type === 1 && buf.length >= 6) {
          const tic = buf.readUInt32LE(2);
          if (tic > room.lastTic[slot]!) room.lastTic[slot] = tic;
        }
        for (let i = 0; i < room.players.length; i++) {
          if (i !== slot) sendTo(room.players[i]!, data);
        }
      }
      return;
    }
    let msg: {
      t: string;
      room?: string;
      map?: number;
      skill?: number;
      wadHash?: string;
      blockGun?: boolean;
      to?: number;
      from?: number;
      d?: unknown;
    };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }

    if (msg.t === 'create') {
      if (rooms.size >= MAX_ROOMS) {
        ws.send(JSON.stringify({ t: 'error', reason: 'server full' }));
        return;
      }
      room = {
        code: makeCode(),
        map: msg.map ?? 1,
        skill: msg.skill ?? 3,
        wadHash: msg.wadHash ?? '',
        blockGun: msg.blockGun !== false,
        players: [ws, null, null, null],
        ready: [true, false, false, false],
        started: false,
        lastTic: [-1, -1, -1, -1],
      };
      slot = 0;
      rooms.set(room.code, room);
      ws.send(JSON.stringify({ t: 'created', room: room.code }));
      roster(room);
      console.log(`room ${room.code} created (MAP${String(room.map).padStart(2, '0')})`);
    } else if (msg.t === 'join') {
      const r = rooms.get((msg.room ?? '').toUpperCase());
      if (!r || r.started) {
        ws.send(JSON.stringify({ t: 'error', reason: r ? 'game already started' : 'no such room' }));
        return;
      }
      const free = r.players.findIndex((p, i) => i > 0 && p === null);
      if (free === -1) {
        ws.send(JSON.stringify({ t: 'error', reason: 'room full' }));
        return;
      }
      r.players[free] = ws;
      r.ready[free] = msg.wadHash === r.wadHash;
      room = r;
      slot = free;
      ws.send(JSON.stringify({ t: 'joined', slot: free }));
      if (!r.ready[free]) {
        // joiner lacks the host's WAD: host streams it (RTC or relay),
        // joiner confirms with wadReady when assembled
        r.players[0]!.send(JSON.stringify({ t: 'peerNeedsWad', slot: free }));
        ws.send(JSON.stringify({ t: 'awaitWad' }));
        console.log(`room ${r.code}: transferring WAD to slot ${free}`);
      }
      roster(r);
    } else if (msg.t === 'rtc') {
      // WebRTC signalling: addressed to a slot; server stamps the sender
      if (!room) return;
      const target = room.players[msg.to ?? (slot ^ 1)] ?? null;
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ ...msg, from: slot }));
      }
    } else if (msg.t === 'wadReady') {
      if (room && slot > 0) {
        if (msg.wadHash === room.wadHash) {
          room.ready[slot] = true;
          roster(room);
        } else {
          ws.send(JSON.stringify({ t: 'error', reason: 'WAD transfer failed (hash mismatch)' }));
        }
      }
    } else if (msg.t === 'begin') {
      // host starts the game once 2-4 players are present and ready
      if (room && slot === 0 && !room.started) {
        const present = room.players.filter(Boolean).length;
        const allReady = room.players.every((p, i) => !p || room!.ready[i]);
        if (present >= 2 && allReady) start(room);
        else ws.send(JSON.stringify({ t: 'error', reason: 'players not ready' }));
      }
    }
  });

  ws.on('close', () => {
    if (!room) return;
    if (room.started) {
      // in-game leave: survivors drop the player at an agreed tic and
      // keep playing (the first tic for which no cmd was relayed)
      room.players[slot] = null;
      const dropTic = room.lastTic[slot]! + 1;
      let remaining = 0;
      for (const p of room.players) {
        if (p && p.readyState === WebSocket.OPEN) {
          remaining++;
          p.send(JSON.stringify({ t: 'playerLeft', slot, tic: dropTic }));
        }
      }
      console.log(`room ${room.code}: slot ${slot} left in-game (drop tic ${dropTic}, ${remaining} remain)`);
      if (remaining === 0) rooms.delete(room.code);
    } else if (slot === 0) {
      // host bailing pre-start ends the room
      for (const p of room.players) {
        if (p && p !== ws && p.readyState === WebSocket.OPEN) {
          p.send(JSON.stringify({ t: 'peerleft' }));
        }
      }
      rooms.delete(room.code);
    } else {
      // pre-start joiner leave: free the slot
      room.players[slot] = null;
      room.ready[slot] = false;
      roster(room);
    }
  });
});

// Stale-build tripwire: serving an old dist/ silently runs old netcode.
async function warnIfStale(): Promise<void> {
  const { stat, readdir } = await import('node:fs/promises');
  try {
    const distTime = (await stat(join(DIST, 'index.html'))).mtimeMs;
    const srcDir = join(DIST, '..', 'src');
    let newest = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else newest = Math.max(newest, (await stat(p)).mtimeMs);
      }
    };
    await walk(srcDir);
    if (newest > distTime) {
      console.warn(
        '\n*** dist/ is OLDER than src/ — you are serving a stale build! ***' +
          '\n*** run `npm run build` (or use `npm start`)                 ***\n',
      );
    }
  } catch {
    // no dist yet — the 404 handler already explains
  }
}

http.listen(PORT, () => {
  console.log(`DoomCraft server on http://localhost:${PORT} (ws same port)`);
  void warnIfStale();
});
