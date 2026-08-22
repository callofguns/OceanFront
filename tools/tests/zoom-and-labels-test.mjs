// Regression test for two OpenFrontIO-parity changes to camera/label
// rendering (src/render.js):
//   1. Scroll/pinch can now zoom out past "the whole map exactly fills the
//      viewport" (renderer.minScale) down to a looser floor
//      (renderer.minZoomScale), so the map shrinks into open space instead
//      of hard-stopping the moment it fits -- matching OpenFrontIO's own
//      TransformHandler, which floors at a fixed absolute scale well below
//      its default fit.
//   2. Name/troop labels are no longer force-floored to a minimum pixel
//      size, so the existing (previously dead -- the floor was always
//      >= the cull check) "too small, don't draw" cull in #drawLabels can
//      actually trigger as the camera zooms out, matching OpenFrontIO's own
//      name shader, which culls below a screen-size threshold.
// Run the dev server first (`npm start`), then this script.
import { chromium } from './lib/browser.mjs';

const BASE = process.env.BASE || 'http://localhost:8123';
let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? `  (${detail})` : ''}`);
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

// ---------------------------------------------------------------- Part 1: scroll/pinch can zoom out past fit-to-screen
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await startMatch(page, { seed: 1234 });

  const result = await page.evaluate(() => {
    const { renderer: r } = window.OceanFront;
    const before = {
      minScale: r.minScale,
      minZoomScale: r.minZoomScale,
    };
    // Zoom out hard, centered on the viewport, the same call the real
    // mouse-wheel handler makes (ui.js) -- repeated so a single call's
    // per-step factor can't undershoot the floor.
    for (let i = 0; i < 60; i++) r.zoomAt(r.viewW / 2, r.viewH / 2, 1 / 1.16);
    const mapW = r.game.map.width * r.camera.scale;
    const mapH = r.game.map.height * r.camera.scale;
    return {
      ...before,
      finalScale: r.camera.scale,
      viewW: r.viewW,
      viewH: r.viewH,
      mapW, mapH,
      camX: r.camera.x,
      camY: r.camera.y,
    };
  });

  console.log(`  minScale=${result.minScale.toFixed(3)} minZoomScale=${result.minZoomScale.toFixed(3)} reached=${result.finalScale.toFixed(3)}`);
  check('minZoomScale is looser than the fit-to-screen scale', result.minZoomScale < result.minScale);
  check('zooming out repeatedly is clamped at minZoomScale, not below it', Math.abs(result.finalScale - result.minZoomScale) < 0.01, `${result.finalScale} vs ${result.minZoomScale}`);
  // The whole point: past fit, the map is smaller than the viewport on BOTH
  // axes and sits padded/centered in it, not pinned to an edge.
  check('the zoomed-out map is narrower than the viewport, with room on both sides', result.mapW < result.viewW && result.camX > -0.5 && result.camX + result.mapW < result.viewW + 0.5, `mapW=${result.mapW.toFixed(0)} viewW=${result.viewW} camX=${result.camX.toFixed(1)}`);
  check('the zoomed-out map is shorter than the viewport, with room above and below', result.mapH < result.viewH && result.camY > -0.5 && result.camY + result.mapH < result.viewH + 0.5, `mapH=${result.mapH.toFixed(0)} viewH=${result.viewH} camY=${result.camY.toFixed(1)}`);

  await page.close();
}

// ---------------------------------------------------------------- Part 2: names cull below a minimum screen size
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await startMatch(page, { seed: 1234 });

  // Same fixed camera (position AND scale) throughout, so the terrain pixels
  // under the sampled region never change between the two cases -- only
  // labelScale moves, isolating the cull check from the zoom-floor change
  // tested in Part 1.
  async function sampleAt(labelScale) {
    return page.evaluate((labelScale) => {
      const { renderer: r, game: g } = window.OceanFront;
      const human = g.human;
      human.alive = true;
      human.tiles = new Set(Array.from({ length: 30 }, (_, i) => i)); // >= 25, drawLabels' own floor
      human.labelScale = labelScale;

      r.camera.scale = 2;
      r.camera.x = (r.viewW - g.map.width * r.camera.scale) / 2;
      r.camera.y = (r.viewH - g.map.height * r.camera.scale) / 2;
      r.clampCamera();

      const centerWorld = r.screenToWorld(r.viewW / 2, r.viewH / 2);
      human.centroid = { x: centerWorld.x, y: centerWorld.y };

      return new Promise((resolve) => {
        // Let the real rAF loop (main.js) draw a couple of frames with this
        // state before sampling -- the same real render path a player sees,
        // not a manually-invoked draw call.
        setTimeout(() => {
          const s = r.worldToScreen(human.centroid.x, human.centroid.y);
          const boxW = 160, boxH = 60;
          const x0 = Math.max(0, Math.round(s.x - boxW / 2));
          const y0 = Math.max(0, Math.round(s.y - boxH / 2));
          const data = r.ctx.getImageData(x0, y0, boxW, boxH).data;
          let brightCount = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] + data[i + 1] + data[i + 2] > 720) brightCount++;
          }
          resolve({ size: labelScale * r.camera.scale * 0.5, brightCount });
        }, 120);
      });
    }, labelScale);
  }

  // labelScale=5 at camera.scale=2 -> computed size = 5, below the 9px cull.
  const hidden = await sampleAt(5);
  console.log(`  labelScale=5: computed size=${hidden.size} brightPixels=${hidden.brightCount}`);
  check('a name below the cull threshold is not drawn at all', hidden.brightCount === 0, `${hidden.brightCount} bright px, computed size ${hidden.size}px`);

  // labelScale=20 at the same camera.scale=2 -> computed size = 20, clearly visible.
  const visible = await sampleAt(20);
  console.log(`  labelScale=20: computed size=${visible.size} brightPixels=${visible.brightCount}`);
  check('a name above the cull threshold is drawn', visible.brightCount > 0, `${visible.brightCount} bright px, computed size ${visible.size}px`);

  // Back down again -- confirms this is a live, reversible cull each frame,
  // not a one-shot "never draw this player again" flag.
  const hiddenAgain = await sampleAt(5);
  check('zooming back out hides the name again', hiddenAgain.brightCount === 0, `${hiddenAgain.brightCount} bright px`);

  await page.close();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
