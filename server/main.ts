// DoomCraft relay server: WebSocket lobby with 4-char room codes plus
// static hosting of the built client. Holds no game state — after start
// it relays opaque binary frames between the two peers (including the
// host→joiner WAD transfer, which is just binary frames to the relay).
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

interface Room {
  code: string;
  map: number;
  skill: number;
  wadHash: string;
  players: (WebSocket | null)[]; // slot 0 = creator
}

const rooms = new Map<string, Room>();

function start(r: Room): void {
  for (let i = 0; i < 2; i++) {
    r.players[i]!.send(JSON.stringify({ t: 'start', map: r.map, skill: r.skill, slot: i }));
  }
  console.log(`room ${r.code} started`);
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
    let file: Buffer;
    if (path === '/freedm.wad') {
      file = await readFile(join(ROOT, 'freedm.wad'));
    } else if (path.startsWith('/wad/')) {
      const target = servedWads.get(path.slice(5));
      if (!target) throw new Error('unregistered wad');
      file = await readFile(target);
    } else {
      file = await readFile(join(DIST, path));
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end('not found (run `npm run build` for static hosting)');
  }
});

const wss = new WebSocketServer({ server: http });

wss.on('connection', (ws) => {
  let room: Room | null = null;
  let slot = -1;

  const peer = (): WebSocket | null => (room ? (room.players[slot ^ 1] ?? null) : null);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // in-game: relay verbatim to the other peer
      const p = peer();
      if (p && p.readyState === WebSocket.OPEN) p.send(data);
      return;
    }
    let msg: { t: string; room?: string; map?: number; skill?: number; wadHash?: string };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }

    if (msg.t === 'create') {
      room = {
        code: makeCode(),
        map: msg.map ?? 1,
        skill: msg.skill ?? 3,
        wadHash: msg.wadHash ?? '',
        players: [ws, null],
      };
      slot = 0;
      rooms.set(room.code, room);
      ws.send(JSON.stringify({ t: 'created', room: room.code }));
      console.log(`room ${room.code} created (MAP${String(room.map).padStart(2, '0')})`);
    } else if (msg.t === 'join') {
      const r = rooms.get((msg.room ?? '').toUpperCase());
      if (!r) {
        ws.send(JSON.stringify({ t: 'error', reason: 'no such room' }));
        return;
      }
      if (r.players[1]) {
        ws.send(JSON.stringify({ t: 'error', reason: 'room full' }));
        return;
      }
      r.players[1] = ws;
      room = r;
      slot = 1;
      if (msg.wadHash === r.wadHash) {
        start(r);
      } else {
        // joiner lacks the host's WAD: host streams it through the relay
        // (binary frames), joiner confirms with wadReady when assembled
        r.players[0]!.send(JSON.stringify({ t: 'peerNeedsWad' }));
        ws.send(JSON.stringify({ t: 'awaitWad' }));
        console.log(`room ${r.code}: transferring WAD to joiner`);
      }
    } else if (msg.t === 'wadReady') {
      if (room && slot === 1) {
        if (msg.wadHash === room.wadHash) {
          start(room);
        } else {
          ws.send(JSON.stringify({ t: 'error', reason: 'WAD transfer failed (hash mismatch)' }));
        }
      }
    }
  });

  ws.on('close', () => {
    if (room) {
      const p = peer();
      if (p && p.readyState === WebSocket.OPEN) {
        p.send(JSON.stringify({ t: 'peerleft' }));
      }
      rooms.delete(room.code);
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
