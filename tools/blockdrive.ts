// Dev utility: drive the block gun and screenshot the result.
// Usage: node --experimental-strip-types tools/blockdrive.ts [outfile]

import { chromium } from 'playwright';

const outfile = process.argv[2] ?? '/tmp/doomcraft-blocks.png';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: string[] = [];
page.on('pageerror', (err) => errors.push(String(err)));
await page.goto('http://localhost:5173/play?map=1');
await page.waitForTimeout(3000);

// select the block gun
await page.keyboard.press('8');
await page.waitForTimeout(800);
// look down and place a line of blocks while backing up
await page.keyboard.down('ArrowDown');
await page.waitForTimeout(700);
await page.keyboard.up('ArrowDown');
await page.keyboard.down('Control');
await page.keyboard.down('s');
await page.waitForTimeout(2500);
await page.keyboard.up('Control');
await page.keyboard.up('s');
// look back up at the result
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(500);
await page.keyboard.up('ArrowUp');
await page.waitForTimeout(400);

await page.screenshot({ path: outfile });
await browser.close();
if (errors.length) {
  console.error('PAGE ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`screenshot saved to ${outfile}`);
