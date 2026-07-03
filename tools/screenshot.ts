// Dev utility: screenshot a page of the running dev server.
// Usage: node --experimental-strip-types tools/screenshot.ts [urlPath] [outfile] [waitMs]

import { chromium } from 'playwright';

const path = process.argv[2] ?? '/play?map=1';
const outfile = process.argv[3] ?? '/tmp/doomcraft.png';
const waitMs = Number(process.argv[4] ?? 2500);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: string[] = [];
page.on('pageerror', (err) => errors.push(String(err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
await page.goto(`http://localhost:5173${path}`);
await page.waitForTimeout(waitMs);
await page.screenshot({ path: outfile });
await browser.close();
if (errors.length) {
  console.error('PAGE ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`screenshot saved to ${outfile}`);
