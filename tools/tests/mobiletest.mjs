// Mobile-viewport check: touch input, pinch-zoom, bottom-sheet tabs, PWA bits.
// Run the dev server first (`npm start`), then `node tools/tests/mobiletest.mjs`.
import { chromium, devices } from './lib/browser.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8123';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'oceanfront-test-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const errors = [];
function step(name) { console.log(`\n▸ ${name}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function bad(msg) { console.log(`  ✗ ${msg}`); errors.push(msg); }

const iphone = devices['iPhone 13'];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ...iphone });
const page = await context.newPage();

page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console error: ${m.text()}`); });

step('Load on a phone viewport (iPhone 13, 390x844, touch)');
await page.goto(BASE, { waitUntil: 'networkidle' });
const vp = page.viewportSize();
console.log(`  viewport ${vp.width}x${vp.height}, hasTouch=${iphone.hasTouch}`);
await page.screenshot({ path: `${SHOTS}/m01-start.png` });
if (await page.isVisible('#startscreen')) ok('start screen fits and renders');
else bad('start screen missing');

// Dialog should not force horizontal scroll on a 390px-wide screen.
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
if (!overflow) ok('no horizontal overflow on start screen');
else bad('page has horizontal overflow on a phone viewport');

await page.fill('#seed-input', '4242');
await page.tap('#size-picker .choice:nth-child(1)');
await page.tap('#btn-start');
await page.waitForFunction(() => window.OceanFront?.game != null);

step('Tap to spawn a homeland');
const pointOf = (tile) => page.evaluate((t) => {
  const { renderer: r, game: g } = window.OceanFront;
  const p = r.worldToScreen(g.map.xOf(t) + 0.5, g.map.yOf(t) + 0.5);
  return { x: Math.round(p.x), y: Math.round(p.y) };
}, tile);

const spawnTile = await page.evaluate(() => window.OceanFront.game.spawnCandidates[0]);
let p = await pointOf(spawnTile);
await page.tap('#map', { position: p });
await page.waitForTimeout(400);
const spawned = await page.evaluate(() => window.OceanFront.game.state);
if (spawned === 'playing') ok('tap-to-spawn works with touch input');
else bad(`tap-to-spawn failed (state=${spawned})`);

step('Tab bar opens/closes bottom sheets');
if (await page.isVisible('#mobile-tabbar')) ok('mobile tab bar visible on phone width');
else bad('mobile tab bar not visible on phone width');

await page.tap('.tab-btn[data-panel="buildpanel"]');
await page.waitForTimeout(350);
let buildOpen = await page.evaluate(() => document.getElementById('buildpanel').classList.contains('is-open'));
if (buildOpen) ok('Build sheet opens on tab tap');
else bad('Build sheet did not open');

const backdropVisible = await page.evaluate(() => getComputedStyle(document.getElementById('sheet-backdrop')).opacity !== '0');
if (backdropVisible) ok('backdrop dims the map while a sheet is open');
else bad('backdrop did not appear');

// Tapping backdrop should close it.
await page.tap('#sheet-backdrop', { position: { x: 20, y: 100 } });
await page.waitForTimeout(350);
buildOpen = await page.evaluate(() => document.getElementById('buildpanel').classList.contains('is-open'));
if (!buildOpen) ok('tapping the backdrop closes the sheet');
else bad('backdrop tap did not close the sheet');

step('Selecting a structure auto-closes the sheet so the map is reachable');
await page.evaluate(() => { window.OceanFront.game.human.gold = 20000; });
await page.tap('.tab-btn[data-panel="buildpanel"]');
await page.waitForTimeout(350);
await page.tap('#build-list .build-btn:nth-child(1)'); // City
await page.waitForTimeout(350);
const closedAfterPick = await page.evaluate(() => !document.getElementById('buildpanel').classList.contains('is-open'));
if (closedAfterPick) ok('sheet auto-closes after picking a structure to build');
else bad('sheet stayed open after picking a structure');

const cityTile = await page.evaluate(() => {
  const g = window.OceanFront.game;
  for (const t of g.human.tiles) if (!g.buildingPlacementError(g.human, 'city', t)) return t;
  return -1;
});
if (cityTile >= 0) {
  p = await pointOf(cityTile);
  await page.tap('#map', { position: p });
  await page.waitForTimeout(300);
  const built = await page.evaluate(() => window.OceanFront.game.human.countOf('city'));
  if (built > 0) ok('tapped the map to place the structure after the sheet closed');
  else bad('structure placement tap did not register');
} else bad('no legal city tile to test placement with');

step('Nations tab');
await page.tap('.tab-btn[data-panel="sidepanel"]');
await page.waitForTimeout(350);
const sidepanelOpen = await page.evaluate(() => document.getElementById('sidepanel').classList.contains('is-open'));
if (sidepanelOpen) ok('Nations sheet opens');
else bad('Nations sheet did not open');
const lbVisible = await page.isVisible('#leaderboard .lb-row');
if (lbVisible) ok('leaderboard rows are visible and tappable inside the sheet');
else bad('leaderboard not visible inside sheet');
await page.tap('.tab-btn[data-panel="sidepanel"]'); // close

step('Orders tab (sliders)');
await page.tap('.tab-btn[data-panel="bottombar"]');
await page.waitForTimeout(350);
if (await page.isVisible('#attack-ratio')) ok('attack-force slider reachable in Orders sheet');
else bad('slider not visible in Orders sheet');
await page.tap('.tab-btn[data-panel="bottombar"]'); // close

await page.screenshot({ path: `${SHOTS}/m02-midgame.png` });

step('Pinch to zoom (two-finger touch via CDP, real input pipeline)');
const before = await page.evaluate(() => window.OceanFront.renderer.camera.scale);
const cx = vp.width / 2;
const cy = vp.height / 2;
const cdp = await context.newCDPSession(page);

// A raw `new PointerEvent()` + dispatchEvent() is not backed by a real OS-level
// pointer, so setPointerCapture() rejects it -- CDP's touch input goes through
// the actual input pipeline the same way a finger on real hardware would.
const touch = async (type, points) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });

await touch('touchStart', [{ x: cx - 20, y: cy, id: 1 }, { x: cx + 20, y: cy, id: 2 }]);
await page.waitForTimeout(30);
await touch('touchMove', [{ x: cx - 90, y: cy, id: 1 }, { x: cx + 90, y: cy, id: 2 }]);
await page.waitForTimeout(30);
await touch('touchMove', [{ x: cx - 140, y: cy, id: 1 }, { x: cx + 140, y: cy, id: 2 }]);
await page.waitForTimeout(30);
await touch('touchEnd', []);
await page.waitForTimeout(150);

const after = await page.evaluate(() => window.OceanFront.renderer.camera.scale);
console.log(`  scale ${before.toFixed(2)} → ${after.toFixed(2)}`);
if (after > before * 1.3) ok('pinch-out zoomed in');
else bad(`pinch gesture did not zoom in as expected (${before.toFixed(2)} -> ${after.toFixed(2)})`);

// Pinch-in should zoom back out.
const midScale = after;
await touch('touchStart', [{ x: cx - 140, y: cy, id: 1 }, { x: cx + 140, y: cy, id: 2 }]);
await page.waitForTimeout(30);
await touch('touchMove', [{ x: cx - 30, y: cy, id: 1 }, { x: cx + 30, y: cy, id: 2 }]);
await page.waitForTimeout(30);
await touch('touchEnd', []);
await page.waitForTimeout(150);
const afterPinchIn = await page.evaluate(() => window.OceanFront.renderer.camera.scale);
console.log(`  scale ${midScale.toFixed(2)} → ${afterPinchIn.toFixed(2)}`);
if (afterPinchIn < midScale * 0.8) ok('pinch-in zoomed back out');
else bad(`pinch-in did not zoom out as expected (${midScale.toFixed(2)} -> ${afterPinchIn.toFixed(2)})`);

step('PWA manifest and service worker');
const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
if (manifestHref) ok(`manifest linked: ${manifestHref}`);
else bad('no manifest link tag');

const manifestRes = await page.evaluate(async () => {
  const r = await fetch('manifest.json');
  const j = await r.json();
  return { ok: r.ok, hasIcons: Array.isArray(j.icons) && j.icons.length > 0, display: j.display };
});
if (manifestRes.ok && manifestRes.hasIcons && manifestRes.display === 'standalone') ok('manifest.json is valid and installable (standalone, has icons)');
else bad(`manifest.json looks wrong: ${JSON.stringify(manifestRes)}`);

await page.waitForTimeout(1000); // give the SW registration (fired on load) a moment
const swState = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? (reg.active ? 'active' : 'registered') : 'none';
});
console.log(`  service worker: ${swState}`);
if (swState === 'active' || swState === 'registered') ok('service worker registered');
else bad(`service worker did not register (${swState})`);

await page.screenshot({ path: `${SHOTS}/m03-final.png` });
await browser.close();

console.log(`\n${'='.repeat(58)}`);
if (errors.length === 0) {
  console.log('ALL MOBILE CHECKS PASSED — no console or page errors.');
} else {
  console.log(`${errors.length} PROBLEM(S):`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exitCode = 1;
}
