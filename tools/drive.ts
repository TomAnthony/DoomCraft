// Dev utility: drive the game with scripted keys and screenshot the result.
// Usage: node --experimental-strip-types tools/drive.ts [urlPath] [outfile]

import { chromium } from 'playwright';

const path = process.argv[2] ?? '/play?map=1';
const outfile = process.argv[3] ?? '/tmp/doomcraft-drive.png';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: string[] = [];
page.on('pageerror', (err) => errors.push(String(err)));
await page.goto(`http://localhost:5173${path}`);
await page.waitForTimeout(3000);

// walk forward into the room
await page.keyboard.down('w');
await page.waitForTimeout(1800);
await page.keyboard.up('w');
// fire a burst
await page.keyboard.down('Control');
await page.waitForTimeout(1500);
await page.keyboard.up('Control');
await page.waitForTimeout(800);

await page.screenshot({ path: outfile });
await browser.close();
if (errors.length) {
  console.error('PAGE ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`screenshot saved to ${outfile}`);
