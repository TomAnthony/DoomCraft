// Relay load test: N rooms × 2 clients exchanging 15-byte frames at
// 35Hz (exactly the in-game traffic shape). Reports achieved message
// rate, relay round-trip latency percentiles, and server RSS.
//
// Usage: node --experimental-strip-types tools/loadtest.ts [rooms] [seconds]
// Requires a relay on ws://localhost:8666 (fresh process for clean RSS).

import { WebSocket } from 'ws';

const ROOMS = Number(process.argv[2] ?? 100);
const SECONDS = Number(process.argv[3] ?? 15);
const URL = 'ws://localhost:8666';

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.binaryType = 'arraybuffer';
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function makeRoom(): Promise<[WebSocket, WebSocket]> {
  const a = await connect();
  const code = await new Promise<string>((resolve) => {
    a.on('message', function h(data, isBinary) {
      if (!isBinary) {
        const m = JSON.parse(String(data));
        if (m.t === 'created') {
          a.off('message', h);
          resolve(m.room);
        }
      }
    });
    a.send(JSON.stringify({ t: 'create', map: 1, wadHash: 'load' }));
  });
  const b = await connect();
  await new Promise<void>((resolve) => {
    b.on('message', function h(data, isBinary) {
      if (!isBinary && JSON.parse(String(data)).t === 'start') {
        b.off('message', h);
        resolve();
      }
    });
    b.send(JSON.stringify({ t: 'join', room: code, wadHash: 'load' }));
  });
  return [a, b];
}

console.log(`creating ${ROOMS} rooms (${ROOMS * 2} sockets)…`);
const pairs: [WebSocket, WebSocket][] = [];
for (let i = 0; i < ROOMS; i++) {
  pairs.push(await makeRoom());
  if ((i + 1) % 100 === 0) console.log(`  ${i + 1} rooms up`);
}

let sent = 0;
let received = 0;
const latencies: number[] = [];
for (const [a, b] of pairs) {
  for (const ws of [a, b]) {
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      received++;
      const view = new DataView(data as ArrayBuffer);
      if (view.byteLength >= 9 && view.getUint8(0) === 1) {
        // sender embedded a timestamp (ms since start, f32-ish precision ok)
        const t = view.getFloat64(1);
        latencies.push(performance.now() - t);
      }
    });
  }
}

console.log(`driving 35Hz for ${SECONDS}s…`);
const frame = new ArrayBuffer(15);
const view = new DataView(frame);
view.setUint8(0, 1);
const timers: NodeJS.Timeout[] = [];
for (const [a, b] of pairs) {
  for (const ws of [a, b]) {
    timers.push(
      setInterval(() => {
        view.setFloat64(1, performance.now());
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1024) {
          ws.send(frame);
          sent++;
        }
      }, 1000 / 35),
    );
  }
}

await new Promise((r) => setTimeout(r, SECONDS * 1000));
for (const t of timers) clearInterval(t);
await new Promise((r) => setTimeout(r, 500));

latencies.sort((x, y) => x - y);
const pct = (p: number) => latencies[Math.floor(latencies.length * p)]?.toFixed(1);
console.log(`sent ${sent} (${Math.round(sent / SECONDS)}/s), relayed ${received} (${Math.round(received / SECONDS)}/s), delivery ${((received / sent) * 100).toFixed(1)}%`);
console.log(`relay latency ms: p50=${pct(0.5)} p95=${pct(0.95)} p99=${pct(0.99)} max=${latencies[latencies.length - 1]?.toFixed(1)}`);
for (const [a, b] of pairs) {
  a.close();
  b.close();
}
process.exit(0);
