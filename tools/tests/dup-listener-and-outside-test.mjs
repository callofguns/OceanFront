// Targets the two new bugs specifically: duplicate listeners after a replay,
// the topbar being unreachable behind the sheet backdrop, and robust
// click-outside-to-close (including "does it also accidentally attack").
// Run the dev server first (`npm start`), then this script.
import { chromium } from './lib/browser.mjs';

const BASE = process.env.BASE || 'http://localhost:8123';
const errors = [];
function ok(m) { console.log(`  ✓ ${m}`); }
function bad(m) { console.log(`  ✗ ${m}`); errors.push(m); }

const browser = await chromium.launch({ headless: true });

const startGame = async (page, seed) => {
  await page.fill('#seed-input', String(seed));
  await page.click('#size-picker .choice:nth-child(1)'); // Small: forcing a win is a real fraction of the map
  await page.click('#btn-start');
  await page.waitForFunction(() => window.OceanFront?.game != null);
  const spawnTile = await page.evaluate(() => window.OceanFront.game.spawnCandidates[0]);
  const p = await page.evaluate((t) => {
    const { renderer: r, game: g } = window.OceanFront;
    const pt = r.worldToScreen(g.map.xOf(t) + 0.5, g.map.yOf(t) + 0.5);
    return { x: Math.round(pt.x), y: Math.round(pt.y) };
  }, spawnTile);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(200);
};

// -------------------------------------------- duplicate-listener regression ---
{
  console.log('\n▸ Replaying a match must not duplicate listeners on persistent buttons');
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await startGame(page, 111);

  // Force an immediate win to get back to the start screen quickly.
  await page.evaluate(() => {
    const g = window.OceanFront.game;
    for (const p of g.players) {
      if (p.isHuman) continue;
      for (const t of [...p.tiles]) g.setOwner(t, g.human.id);
    }
    // A rival mid-attack or mid-boat gets a grace period from elimination
    // (see Game#checkEliminations) even at 0 tiles, and could reclaim land
    // before the next check -- clear those too for a clean, deterministic win.
    g.attacks = g.attacks.filter((a) => a.attackerId === g.human.id);
    g.boats = g.boats.filter((b) => b.ownerId === g.human.id);
  });
  // Victory is only checked every 10 ticks (see Game#checkVictory), so this
  // needs to span at least one such boundary at the default 1x tick rate.
  await page.waitForTimeout(1500);
  if (!(await page.isVisible('#endscreen'))) bad('end screen never appeared, cannot test replay');
  await page.click('#btn-again');
  await page.waitForTimeout(100);

  // Second game -- attach() runs a second time.
  await startGame(page, 222);

  // Nuke button: build a silo, tap it once, expect exactly one mode toggle.
  await page.evaluate(() => { window.OceanFront.game.human.gold = 20000; });
  const siloTile = await page.evaluate(() => {
    const g = window.OceanFront.game;
    for (const t of g.human.tiles) if (!g.buildingPlacementError(g.human, 'silo', t)) return t;
    return -1;
  });
  await page.click('#build-list .build-btn:nth-child(4)'); // Missile Silo
  const p2 = await page.evaluate((t) => {
    const { renderer: r, game: g } = window.OceanFront;
    const pt = r.worldToScreen(g.map.xOf(t) + 0.5, g.map.yOf(t) + 0.5);
    return { x: Math.round(pt.x), y: Math.round(pt.y) };
  }, siloTile);
  await page.mouse.click(p2.x, p2.y);
  await page.waitForTimeout(200);

  await page.click('#btn-nuke');
  await page.waitForTimeout(100);
  const nukeModeAfterOneClick = await page.evaluate(() => window.OceanFront.ui.state.nukeMode);
  if (nukeModeAfterOneClick === true) ok('nuke button toggles ON with exactly one click after a replay (no duplicate listeners)');
  else bad(`nuke button did not toggle on with one click after replay (nukeMode=${nukeModeAfterOneClick}) -- duplicate listeners likely stacked`);

  // Speed buttons: click 2x once, expect exactly speed=2 reported exactly once (not toggled back and forth).
  let speedCalls = [];
  await page.exposeFunction('__recordSpeed', (v) => speedCalls.push(v));
  await page.evaluate(() => {
    window.OceanFront.ui.onSpeed = (v) => window.__recordSpeed(v);
  });
  await page.click('.speed-btn[data-speed="2"]');
  await page.waitForTimeout(100);
  console.log(`  onSpeed fired with: ${JSON.stringify(speedCalls)}`);
  if (speedCalls.length === 1 && speedCalls[0] === 2) ok('speed button fires exactly once per click after a replay');
  else bad(`speed button fired ${speedCalls.length} time(s) on one click after replay: ${JSON.stringify(speedCalls)}`);

  await page.close();
}

// -------------------------------------------------- topbar reachable while ---
// -------------------------------------------------- a sheet is open (z-index) ---
{
  console.log('\n▸ Top bar (pause/speed) must stay reachable while a menu sheet is open');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await startGame(page, 333);

  await page.tap('.tab-btn[data-panel="sidepanel"]');
  await page.waitForTimeout(400);
  const sheetOpen = await page.evaluate(() => document.getElementById('sidepanel').classList.contains('is-open'));
  if (!sheetOpen) bad('sheet did not open, cannot test topbar reachability');

  // What element actually receives a hit-test at the pause button's center?
  const hitTarget = await page.evaluate(() => {
    const btn = document.querySelector('.speed-btn[data-speed="0"]');
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return el ? `${el.tagName}#${el.id}.${el.className}` : 'none';
  });
  console.log(`  element under the pause button while a sheet is open: ${hitTarget}`);
  if (/speed-btn/.test(hitTarget)) ok('pause button is the actual hit target, not the backdrop');
  else bad(`backdrop or something else is intercepting taps meant for the pause button (got: ${hitTarget})`);

  await page.tap('.speed-btn[data-speed="0"]');
  await page.waitForTimeout(150);
  const paused = await page.evaluate(() => document.querySelector('.speed-btn[data-speed="0"]').classList.contains('is-active'));
  if (paused) ok('pause button activates on one tap while a sheet is open');
  else bad('pause button did not activate on one tap while a sheet is open (first tap likely just closed the sheet)');

  await context.close();
}

// --------------------------------------------------- click-outside-to-close ---
{
  console.log('\n▸ Click outside an open menu closes it, without side effects on the map');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await startGame(page, 444);

  const tilesBefore = await page.evaluate(() => window.OceanFront.game.human.tiles.size);
  // Scoped to the human specifically -- the global attacks list also churns
  // from ambient AI-vs-AI activity while the test waits, unrelated to this.
  const humanAttacks = () => window.OceanFront.game.attacksBy(window.OceanFront.game.human.id).length;
  const attacksBefore = await page.evaluate(humanAttacks);

  await page.tap('.tab-btn[data-panel="buildpanel"]');
  await page.waitForTimeout(400);
  if (!(await page.evaluate(() => document.getElementById('buildpanel').classList.contains('is-open')))) {
    bad('build sheet did not open');
  }

  // Tap a point on the visible map sliver above the sheet -- not the backdrop
  // "edge", genuinely where the canvas would otherwise receive the tap. Uses
  // page-level coordinates rather than a #map-locator tap: Playwright's
  // actionability check correctly refuses to force a tap through the
  // backdrop onto a different element, which is itself confirmation the
  // backdrop is doing its job of intercepting that point.
  await page.mouse.click(195, 90);
  await page.waitForTimeout(300);

  const stillOpen = await page.evaluate(() => document.getElementById('buildpanel').classList.contains('is-open'));
  if (!stillOpen) ok('tapping the visible map area outside the sheet closes it');
  else bad('sheet stayed open after tapping outside it');

  const tilesAfter = await page.evaluate(() => window.OceanFront.game.human.tiles.size);
  const attacksAfter = await page.evaluate(humanAttacks);
  if (tilesAfter === tilesBefore && attacksAfter === attacksBefore) {
    ok('the dismiss tap did not also trigger a map action (attack)');
  } else {
    bad(`dismiss tap had a side effect on the map: tiles ${tilesBefore}->${tilesAfter}, attacks ${attacksBefore}->${attacksAfter}`);
  }

  // Tapping *inside* the (now closed, reopen it) sheet must NOT close it.
  await page.tap('.tab-btn[data-panel="sidepanel"]');
  await page.waitForTimeout(400);
  await page.tap('#leaderboard');
  await page.waitForTimeout(200);
  const stillOpenAfterInsideTap = await page.evaluate(() => document.getElementById('sidepanel').classList.contains('is-open'));
  if (stillOpenAfterInsideTap) ok('tapping inside the open sheet does not close it');
  else bad('tapping inside the sheet incorrectly closed it');

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
