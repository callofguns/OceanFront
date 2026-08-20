// Regression test for WASD/arrow-key camera panning. Written after the pan
// speed was intentionally bumped to match OpenFrontIO's much snappier feel
// (OceanFront's own value was a flat `0.75`, over 20x slower than the
// `KEYBOARD_PAN_SPEED = 16` it was replaced with -- see the comment on that
// constant in src/config.js for the derivation). Drives `UI#applyKeyboardPan`
// directly with a synthetic held key rather than dispatching real keyboard
// events, the same "manipulate public state, not the DOM event pipeline"
// pattern pop-bar-test.mjs uses for its fake in-flight attack.
// Run the dev server first (`npm start`), then this script.
import { chromium } from './lib/browser.mjs';

const BASE = process.env.BASE || 'http://localhost:8123';
let failures = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (!cond) failures++;
}

const browser = await chromium.launch();

async function startMatch(page, { seed } = {}) {
  await page.goto(BASE);
  await page.waitForSelector('#startscreen:not([hidden])');
  if (seed) await page.fill('#seed-input', String(seed));
  await page.click('#btn-start');
  await page.waitForSelector('#spawnbanner:not([hidden])', { timeout: 10000 });
  const spawnTile = await page.evaluate(() => window.OceanFront.game.spawnCandidates[0]);
  const p = await page.evaluate((t) => {
    const { renderer: r, game: g } = window.OceanFront;
    const pt = r.worldToScreen(g.map.xOf(t) + 0.5, g.map.yOf(t) + 0.5);
    return { x: Math.round(pt.x), y: Math.round(pt.y) };
  }, spawnTile);
  await page.mouse.click(p.x, p.y);
  await page.waitForSelector('#topbar', { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------- Part 1: holding a direction moves the camera at the configured rate
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await startMatch(page, { seed: 1234 });

  const result = await page.evaluate(() => {
    const { ui, renderer, game } = window.OceanFront;
    // Spawn's centerOn() can leave the camera sitting exactly on the
    // clamp boundary (e.g. a spawn tile near the map edge), which would
    // make a pan toward that edge measure 0 for reasons unrelated to pan
    // speed. Force the camera to the middle of the map first so there's
    // headroom to move in either direction regardless of where this seed
    // happened to spawn.
    const mw = game.map.width * renderer.camera.scale;
    const mh = game.map.height * renderer.camera.scale;
    renderer.camera.x = (renderer.viewW - mw) / 2;
    renderer.camera.y = (renderer.viewH - mh) / 2;

    // Zero out any existing drift from real input during setup, then hold
    // 'd' (pan left, decreasing camera.x per applyKeyboardPan's sign
    // convention) for a fixed, fake elapsed-time budget -- deterministic,
    // unlike waiting on real animation frames.
    ui.keys.clear();
    ui.keys.add('d');
    const before = renderer.camera.x;
    // applyKeyboardPan takes the same `dt` main.js derives from real elapsed
    // ms (`elapsed * 0.06`); simulate exactly 1000ms of real time in 60
    // steps, matching a 60fps frame cadence, without needing 60 real frames.
    for (let i = 0; i < 60; i++) ui.applyKeyboardPan(16.67 * 0.06);
    const after = renderer.camera.x;
    ui.keys.clear();
    return { movedPx: before - after };
  });

  console.log(`  camera.x moved ${result.movedPx.toFixed(1)}px over a simulated 1s hold`);
  // KEYBOARD_PAN_SPEED=16, dt-per-step=16.67*0.06≈1.0, 60 steps/s ->
  // ~16*1.0*60 = 960px/s minus whatever clampCamera trims at the map edge.
  check('holding a direction pans at roughly the new, faster rate (>=500px/s)', result.movedPx >= 500);
  check('holding a direction pans far faster than the old 0.75 rate (~45px/s)', result.movedPx >= 45 * 5);

  await page.close();
}

// ---------------------------------------------------------------- Part 2: releasing all keys stops the pan
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await startMatch(page, { seed: 1234 });

  const result = await page.evaluate(() => {
    const { ui, renderer } = window.OceanFront;
    ui.keys.clear();
    ui.keys.add('w');
    for (let i = 0; i < 5; i++) ui.applyKeyboardPan(1.0);
    ui.keys.clear();
    const before = renderer.camera.y;
    for (let i = 0; i < 20; i++) ui.applyKeyboardPan(1.0);
    const after = renderer.camera.y;
    return { driftAfterRelease: Math.abs(after - before) };
  });
  check('camera stops moving once no pan key is held', result.driftAfterRelease === 0);

  await page.close();
}

// ---------------------------------------------------------------- Part 3: the camera stays clamped to the map even at the new, larger step size
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await startMatch(page, { seed: 1234 });

  const result = await page.evaluate(() => {
    const { ui, renderer } = window.OceanFront;
    ui.keys.clear();
    ui.keys.add('a'); // pans right, toward camera.x growing without bound if unclamped
    ui.keys.add('w'); // pans down, toward camera.y growing without bound if unclamped
    for (let i = 0; i < 600; i++) ui.applyKeyboardPan(16.67 * 0.06); // ~10s of holding both
    ui.keys.clear();
    return {
      x: renderer.camera.x, y: renderer.camera.y,
      finite: Number.isFinite(renderer.camera.x) && Number.isFinite(renderer.camera.y),
    };
  });
  console.log(`  camera after a long hold into a corner: (${result.x.toFixed(0)}, ${result.y.toFixed(0)})`);
  check('camera position stays finite (no runaway/NaN) at the new speed', result.finite);

  await page.close();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
