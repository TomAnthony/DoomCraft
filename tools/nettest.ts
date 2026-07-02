// Two-browser netplay smoke test against a live relay server.
// Usage: node --experimental-strip-types tools/nettest.ts
// Requires: vite dev server on 5173 and relay server on 8666.

import { chromium } from 'playwright';

const base = 'http://localhost:5173';
const relay = 'ws://localhost:8666';

const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 960, height: 600 } });
const ctxB = await browser.newContext({ viewport: { width: 960, height: 600 } });
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();
const errors: string[] = [];
for (const [name, page] of [['A', pageA], ['B', pageB]] as const) {
  page.on('pageerror', (err) => errors.push(`${name}: ${err}`));
}

// Player A creates the room.
await pageA.goto(`${base}/?server=${encodeURIComponent(relay)}&map=1`);
await pageA.waitForSelector('#lobby-url', { timeout: 15000 });
const joinUrl = await pageA.inputValue('#lobby-url');
const room = /room=([A-Z]{4})/.exec(joinUrl)?.[1];
if (!room) throw new Error(`no room code in invite url: ${joinUrl}`);
console.log(`room ${room} created`);

// Player B joins.
await pageB.goto(`${base}/?server=${encodeURIComponent(relay)}&room=${room}`);
await pageB.waitForTimeout(4000);

// Drive both players for ~8 seconds.
await pageA.keyboard.down('w');
await pageB.keyboard.down('a');
await pageA.waitForTimeout(1500);
await pageA.keyboard.down('Control'); // A fires
await pageA.waitForTimeout(1200);
await pageA.keyboard.up('Control');
await pageA.keyboard.up('w');
await pageB.keyboard.up('a');
await pageB.keyboard.down('w'); // B walks toward A's start
await pageB.waitForTimeout(2500);
await pageB.keyboard.up('w');
await pageA.waitForTimeout(2500);

await pageA.screenshot({ path: '/tmp/net-A.png' });
await pageB.screenshot({ path: '/tmp/net-B.png' });

for (const [name, page] of [['A', pageA], ['B', pageB]] as const) {
  const text = await page.evaluate(() => document.body.textContent ?? '');
  if (text.includes('DESYNC')) errors.push(`${name}: DESYNC detected!`);
  if (text.includes('PEER DISCONNECTED')) errors.push(`${name}: peer disconnected`);
  const where = await page.evaluate(() => (window as { __dc?: { where(): unknown } }).__dc?.where());
  console.log(`${name}:`, JSON.stringify(where));
}

await browser.close();
if (errors.length) {
  console.error('ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('netplay smoke test OK — screenshots at /tmp/net-A.png /tmp/net-B.png');
