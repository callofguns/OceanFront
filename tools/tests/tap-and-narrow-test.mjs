// Confirms: (1) no overflow at the narrowest realistic phone width with the
// bigger touch targets, (2) buttons fire on a single real tap now that hover
// rules are gated behind (hover: hover), by dispatching genuine CDP touch
// taps (not .click()) and checking state changed after exactly one.
// Run the dev server first (`npm start`), then this script.
import { chromium } from './lib/browser.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8123';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'oceanfront-test-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
function ok(m) { console.log(`  ✓ ${m}`); }
function bad(m) { console.log(`  ✗ ${m}`); errors.push(m); }

const browser = await chromium.launch({ headless: true });

// ---------------------------------------------------- iPhone SE, narrowest ---
{
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'networkidle' });

  console.log('\n▸ iPhone SE width (375px) with the bigger touch targets');
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (!overflow) ok('start screen: no horizontal overflow');
  else bad('start screen overflows at 375px');
  await page.screenshot({ path: `${SHOTS}/t01-se-start.png` });

  // The full main-menu form is taller than a 667px-tall phone. .overlay used
  // to center its .dialog with align-items: center, which clips the top of
  // an overflowing centered flex item and leaves that clipped part
  // unreachable by scrolling, in every major mobile browser -- the actual
  // regression this project hit ("the main menu gets cut off at the top on
  // mobile and doesn't scroll"). Confirm the top is never clipped, and the
  // bottom (the Set sail button) is reachable by scrolling the overlay.
  const notClipped = await page.evaluate(() => document.querySelector('#startscreen .dialog').getBoundingClientRect().top >= 0);
  if (notClipped) ok('start screen: dialog top is not clipped above the viewport');
  else bad('start screen: dialog top is clipped and would be unreachable by scrolling');

  const reachedBottom = await page.evaluate(() => {
    const overlay = document.getElementById('startscreen');
    overlay.scrollTop = overlay.scrollHeight;
    const btn = document.getElementById('btn-start').getBoundingClientRect();
    const bottomVisible = btn.bottom <= window.innerHeight + 1;
    overlay.scrollTop = 0; // leave scroll state clean for what follows
    return bottomVisible;
  });
  if (reachedBottom) ok('start screen: scrolling the overlay reaches the Set sail button');
  else bad('start screen: the Set sail button is not reachable by scrolling');

  await page.tap('#btn-start');
  await page.waitForFunction(() => window.OceanFront?.game != null);
  const spawnTile = await page.evaluate(() => window.OceanFront.game.spawnCandidates[0]);
  const p = await page.evaluate((t) => {
    const { renderer: r, game: g } = window.OceanFront;
    const pt = r.worldToScreen(g.map.xOf(t) + 0.5, g.map.yOf(t) + 0.5);
    return { x: Math.round(pt.x), y: Math.round(pt.y) };
  }, spawnTile);
  await page.tap('#map', { position: p });
  await page.waitForTimeout(300);

  overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (!overflow) ok('in-game HUD (with bigger speed/lb buttons): no horizontal overflow');
  else bad('in-game HUD overflows at 375px');

  const topbarWidth = await page.evaluate(() => document.getElementById('topbar').scrollWidth);
  console.log(`  topbar content width: ${topbarWidth}px (viewport 375px)`);
  if (topbarWidth <= 375) ok('topbar fits without internal overflow');
  else bad(`topbar content (${topbarWidth}px) is wider than the viewport`);

  await page.tap('.tab-btn[data-panel="sidepanel"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/t02-se-nations.png` });

  await context.close();
}

// ------------------------------------------------ single-tap responsiveness ---
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const cdp = await context.newCDPSession(page);

  const realTap = async (selector) => {
    const box = await page.locator(selector).boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    // A genuine touch sequence through CDP's input pipeline -- this is what
    // exercises the browser's actual hover/tap-delay heuristics, unlike
    // page.click() which dispatches a synthetic mouse click directly.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  console.log('\n▸ Single real tap must register immediately (the hover-state bug)');

  // World-size choice buttons on the start screen use the now-gated :hover rule.
  await realTap('#size-picker .choice:nth-child(1)');
  await page.waitForTimeout(80);
  const sizeSelected = await page.evaluate(() =>
    document.querySelector('#size-picker .choice:nth-child(1)').classList.contains('is-active')
  );
  if (sizeSelected) ok('world-size button (has :hover rule) selects on one tap');
  else bad('world-size button needed more than one tap');

  // Color dot, same story.
  await realTap('#color-picker .color-dot:nth-child(2)');
  await page.waitForTimeout(80);
  const colorSelected = await page.evaluate(() =>
    document.querySelector('#color-picker .color-dot:nth-child(2)').classList.contains('is-active')
  );
  if (colorSelected) ok('color-dot (has :hover rule) selects on one tap');
  else bad('color-dot needed more than one tap');

  // Start button, then the in-game build button.
  await realTap('#btn-start');
  await page.waitForFunction(() => window.OceanFront?.game != null);
  const started = await page.evaluate(() => window.OceanFront.game.state === 'spawn');
  if (started) ok('Set sail button (has :hover rule) fires on one tap');
  else bad('Set sail did not fire on one tap');

  const spawnTile = await page.evaluate(() => window.OceanFront.game.spawnCandidates[0]);
  const sp = await page.evaluate((t) => {
    const { renderer: r, game: g } = window.OceanFront;
    const pt = r.worldToScreen(g.map.xOf(t) + 0.5, g.map.yOf(t) + 0.5);
    return { x: Math.round(pt.x), y: Math.round(pt.y) };
  }, spawnTile);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [sp] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);

  await realTap('.tab-btn[data-panel="buildpanel"]');
  await page.waitForTimeout(350);
  await realTap('#build-list .build-btn:nth-child(1)'); // City -- has :hover rule
  await page.waitForTimeout(80);
  const buildModeActive = await page.evaluate(() => window.OceanFront.ui.state.buildMode === 'city');
  if (buildModeActive) ok('build-menu button (has :hover rule) activates on one tap');
  else bad('build-menu button needed more than one tap');

  await context.close();
}

await browser.close();

console.log(`\n${'='.repeat(58)}`);
if (errors.length === 0) console.log('ALL CHECKS PASSED.');
else {
  console.log(`${errors.length} PROBLEM(S):`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exitCode = 1;
}
