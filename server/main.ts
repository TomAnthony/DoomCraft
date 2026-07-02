// DoomCraft relay server: WebSocket lobby with 4-char room codes plus
// static hosting of the built client. Holds no game state — after start
// it relays opaque binary frames between the two peers.
//
// Usage: node --experimental-strip-types server/main.ts [port]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8666);
const DIST = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');

interface Room {
  code: string;
  map: number;
  skill: number;
  wadHash: string;
  players: (WebSocket | null)[]; // slot 0 = creator
}

const rooms = new Map<string, Room>();

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
    let path = normalize(req.url?.split('?')[0] ?? '/');
    if (path === '/' || path.includes('..')) path = '/index.html';
    const file = await readFile(join(DIST, path));
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
      if (r.wadHash && msg.wadHash && r.wadHash !== msg.wadHash) {
        ws.send(JSON.stringify({ t: 'error', reason: 'WAD mismatch — both players need identical DOOM2.WAD files' }));
        return;
      }
      r.players[1] = ws;
      room = r;
      slot = 1;
      // both present: start
      for (let i = 0; i < 2; i++) {
        r.players[i]!.send(JSON.stringify({ t: 'start', map: r.map, skill: r.skill, slot: i }));
      }
      console.log(`room ${r.code} started`);
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

http.listen(PORT, () => {
  console.log(`DoomCraft server on http://localhost:${PORT} (ws same port)`);
});
