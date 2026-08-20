// Covers the new in-match pause menu (the topbar gear button): opening it
// pauses without clobbering a manual pause, Resume restores exactly what was
// running before, Restart Match replays the same seed, New Game tears the
// match down cleanly (no stale game/renderer left ticking behind the main
// menu), and How to Play is reachable from inside it.
// Run the dev server first (`npm start`), then this script.
import { chromium } from './lib/browser.mjs';

const BASE = process.env.BASE || 'http://localhost:8123';
const errors = [];
function ok(m) { console.log(`  ✓ ${m}`); }
function bad(m) { console.log(`  ✗ ${m}`); errors.push(m); }

const browser = await chromium.launch({ headless: true });

const activeSpeed = (page) =>
  page.evaluate(() => document.querySelector('.speed-btn.is-active')?.dataset.speed);

const startGame = async (page, seed) => {
  await page.fill('#seed-input', String(seed));
  await page.click('#size-picker .choice:nth-child(1)');
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

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console error: ${m.text()}`); });
await page.goto(BASE, { waitUntil: 'networkidle' });

console.log('▸ Opening and closing the menu');
await startGame(page, 4242);

if (await page.isHidden('#pausemenu')) ok('pause menu is closed by default');
else bad('pause menu should not be open before the gear is clicked');

await page.click('#btn-pause-menu');
await page.waitForTimeout(150);
if (await page.isVisible('#pausemenu')) ok('gear button opens the pause menu');
else bad('gear button did not open the pause menu');

await page.click('#pause-close');
await page.waitForTimeout(150);
if (await page.isHidden('#pausemenu')) ok('the ✕ closes the pause menu');
else bad('the ✕ did not close the pause menu');

console.log('\n▸ Opening the menu pauses; Resume restores the prior speed');
await page.click('.speed-btn[data-speed="2"]');
await page.waitForTimeout(80);
if ((await activeSpeed(page)) === '2') ok('speed set to 2x before opening the menu');
else bad('failed to set speed to 2x for the test setup');

await page.click('#btn-pause-menu');
await page.waitForTimeout(150);
const speedWhileOpen = await activeSpeed(page);
if (speedWhileOpen === '0') ok('opening the pause menu pauses the simulation');
else bad(`opening the pause menu should force speed to 0 (got ${speedWhileOpen})`);

await page.click('#pause-resume');
await page.waitForTimeout(150);
if (await page.isHidden('#pausemenu')) ok('Resume closes the pause menu');
else bad('Resume did not close the pause menu');
const speedAfterResume = await activeSpeed(page);
if (speedAfterResume === '2') ok('Resume restores the speed that was active before opening the menu');
else bad(`Resume should restore 2x, got ${speedAfterResume}`);

console.log('\n▸ A manual pause is not clobbered by opening/closing the menu');
await page.click('.speed-btn[data-speed="0"]');
await page.waitForTimeout(80);
await page.click('#btn-pause-menu');
await page.waitForTimeout(150);
await page.click('#pause-resume');
await page.waitForTimeout(150);
const speedAfterManualPause = await activeSpeed(page);
if (speedAfterManualPause === '0') ok('Resume leaves the game paused if the player had already paused it manually');
else bad(`a manual pause should survive opening/closing the menu, got ${speedAfterManualPause}`);
await page.click('.speed-btn[data-speed="1"]');
await page.waitForTimeout(80);

console.log('\n▸ How to Play is reachable from inside the pause menu');
await page.click('#btn-pause-menu');
await page.waitForTimeout(150);
await page.click('#pause-help');
await page.waitForTimeout(150);
if (await page.isVisible('#help-modal')) ok('"How to play" opens the help modal from the pause menu');
else bad('"How to play" did not open the help modal from the pause menu');
await page.click('#help-close');
await page.waitForTimeout(150);
if (await page.isVisible('#pausemenu')) ok('the pause menu is still open underneath after closing the help modal');
else bad('the pause menu should still be open after closing the help modal on top of it');
await page.click('#pause-close');
await page.waitForTimeout(150);

console.log('\n▸ Restart Match replays the exact same seed');
const beforeRestart = await page.evaluate(() => ({
  seed: window.OceanFront.game.seed,
  tiles: window.OceanFront.game.human.tiles.size,
}));
await page.click('.speed-btn[data-speed="2"]');
await page.waitForTimeout(400); // let the match diverge a bit from a fresh spawn
await page.click('#btn-pause-menu');
await page.waitForTimeout(150);
await page.click('#pause-restart');
await page.waitForFunction(() => window.OceanFront?.game != null);
await page.waitForTimeout(200);
const afterRestart = await page.evaluate(() => ({
  seed: window.OceanFront.game.seed,
  state: window.OceanFront.game.state,
}));
if (afterRestart.seed === beforeRestart.seed) ok(`Restart Match reproduces the same seed (${afterRestart.seed})`);
else bad(`Restart Match should keep seed ${beforeRestart.seed}, got ${afterRestart.seed}`);
if (afterRestart.state === 'spawn') ok('Restart Match drops back into a fresh spawn-selection state');
else bad(`Restart Match should leave the game in "spawn" state, got "${afterRestart.state}"`);
if (await page.isHidden('#pausemenu')) ok('the pause menu closes on Restart Match');
else bad('the pause menu should close on Restart Match');

console.log('\n▸ New Game tears the match down cleanly');
const spawnTile = await page.evaluate(() => window.OceanFront.game.spawnCandidates[0]);
const p2 = await page.evaluate((t) => {
  const { renderer: r, game: g } = window.OceanFront;
  const pt = r.worldToScreen(g.map.xOf(t) + 0.5, g.map.yOf(t) + 0.5);
  return { x: Math.round(pt.x), y: Math.round(pt.y) };
}, spawnTile);
await page.mouse.click(p2.x, p2.y);
await page.waitForTimeout(200);
await page.click('.speed-btn[data-speed="3"]');
await page.waitForTimeout(80);

await page.click('#btn-pause-menu');
await page.waitForTimeout(150);
await page.click('#pause-exit');
await page.waitForTimeout(200);

if (await page.isVisible('#startscreen')) ok('New Game returns to the start screen');
else bad('New Game should return to the start screen');
if (await page.isHidden('#hud')) ok('the HUD is hidden after New Game');
else bad('the HUD should be hidden after New Game');
if (await page.isHidden('#pausemenu')) ok('the pause menu closes on New Game');
else bad('the pause menu should close on New Game');

const gameAfterExit = await page.evaluate(() => window.OceanFront.game);
if (gameAfterExit === null) ok('window.OceanFront.game is null after New Game -- nothing is left ticking');
else bad('a game/renderer reference survived New Game -- the old match may still be ticking invisibly');

const ticksBefore = await page.evaluate(() => performance.now());
await page.waitForTimeout(400);
// The old match's simulation, if it were still ticking, would have kept
// advancing behind the hidden HUD -- there is nothing left to read that
// state from once game is null, so the real assertion is just the null
// check above; this pause only guards against a page error surfacing from
// a frame loop still touching a torn-down game.
void ticksBefore;

const resetSpeed = await activeSpeed(page);
if (resetSpeed === '1') ok('the speed buttons reset to 1x for the next match');
else bad(`speed buttons should reset to 1x after New Game, got ${resetSpeed}`);

await startGame(page, 777);
const freshGame = await page.evaluate(() => ({
  seed: window.OceanFront.game.seed,
  state: window.OceanFront.game.state,
}));
if (freshGame.seed === 777) ok('a genuinely fresh game can be started after New Game');
else bad(`expected a fresh game with seed 777, got ${freshGame.seed}`);

await page.close();
await browser.close();

console.log(`\n${'='.repeat(58)}`);
if (errors.length === 0) console.log('ALL CHECKS PASSED.');
else {
  console.log(`${errors.length} PROBLEM(S):`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exitCode = 1;
}
