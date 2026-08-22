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
//   3. The player's own tag is exempt from that cull: it stays visible (at
//      a readable floored size) at any zoom level right up until the
//      camera hits the exact zoom floor from #1, unlike every other
//      player's, which culls by on-screen size well before that.
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
  // tested in Part 1. Deliberately an ordinary AI player, not game.human --
  // the human is exempt from this cull (Part 3), so testing the general
  // rule on it would test the wrong thing.
  async function sampleAt(labelScale) {
    return page.evaluate((labelScale) => {
      const { renderer: r, game: g } = window.OceanFront;
      const other = g.players[1];
      other.alive = true;
      other.tiles = new Set(Array.from({ length: 30 }, (_, i) => i)); // >= 25, drawLabels' own floor
      other.labelScale = labelScale;

      r.camera.scale = 2;
      r.camera.x = (r.viewW - g.map.width * r.camera.scale) / 2;
      r.camera.y = (r.viewH - g.map.height * r.camera.scale) / 2;
      r.clampCamera();

      const centerWorld = r.screenToWorld(r.viewW / 2, r.viewH / 2);
      other.centroid = { x: centerWorld.x, y: centerWorld.y };

      return new Promise((resolve) => {
        // Let the real rAF loop (main.js) draw a couple of frames with this
        // state before sampling -- the same real render path a player sees,
        // not a manually-invoked draw call.
        setTimeout(() => {
          const s = r.worldToScreen(other.centroid.x, other.centroid.y);
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

// ---------------------------------------------------------------- Part 3: the player's own tag stays visible far longer than everyone else's
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await startMatch(page, { seed: 1234 });

  const { minScale, minZoomScale } = await page.evaluate(() => {
    const { renderer: r } = window.OceanFront;
    return { minScale: r.minScale, minZoomScale: r.minZoomScale };
  });
  // Halfway between the zoom floor and fit-to-screen -- comfortably past
  // where an ordinary tag would already be culled, comfortably short of
  // the floor where even the player's own tag is allowed to disappear.
  const midScale = (minZoomScale + minScale) / 2;
  // Sized so an ordinary player's computed size at midScale lands well
  // under LABEL_CULL_PX (9), regardless of viewport/map -- solves
  // labelScale * midScale * 0.5 = 4.
  const tinyLabelScale = 8 / midScale;

  async function sampleTag({ human, scale, labelScale }) {
    return page.evaluate(({ human, scale, labelScale }) => {
      const { renderer: r, game: g } = window.OceanFront;
      const p = human ? g.human : g.players[1];
      p.alive = true;
      p.tiles = new Set(Array.from({ length: 30 }, (_, i) => i)); // >= 25, drawLabels' own floor
      p.labelScale = labelScale;

      r.camera.scale = scale;
      r.camera.x = (r.viewW - g.map.width * r.camera.scale) / 2;
      r.camera.y = (r.viewH - g.map.height * r.camera.scale) / 2;
      r.clampCamera();

      const centerWorld = r.screenToWorld(r.viewW / 2, r.viewH / 2);
      p.centroid = { x: centerWorld.x, y: centerWorld.y };

      return new Promise((resolve) => {
        setTimeout(() => {
          const s = r.worldToScreen(p.centroid.x, p.centroid.y);
          const boxW = 160, boxH = 60;
          const x0 = Math.max(0, Math.round(s.x - boxW / 2));
          const y0 = Math.max(0, Math.round(s.y - boxH / 2));
          const data = r.ctx.getImageData(x0, y0, boxW, boxH).data;
          let brightCount = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] + data[i + 1] + data[i + 2] > 720) brightCount++;
          }
          resolve({ brightCount });
        }, 120);
      });
    }, { human, scale, labelScale });
  }

  const other = await sampleTag({ human: false, scale: midScale, labelScale: tinyLabelScale });
  console.log(`  other player at midScale=${midScale.toFixed(3)}, labelScale=${tinyLabelScale.toFixed(2)}: brightPixels=${other.brightCount}`);
  check("a normal player's tag is already culled at this zoom level", other.brightCount === 0, `${other.brightCount} bright px`);

  const own = await sampleTag({ human: true, scale: midScale, labelScale: tinyLabelScale });
  console.log(`  own tag at the same midScale and labelScale: brightPixels=${own.brightCount}`);
  check("the player's own tag, same labelScale and zoom level, is still drawn", own.brightCount > 0, `${own.brightCount} bright px`);

  // Push all the way to the true floor -- even the player's own tag finally
  // disappears once the whole map is zoomed all the way out.
  const ownAtFloor = await sampleTag({ human: true, scale: minZoomScale, labelScale: tinyLabelScale });
  console.log(`  own tag at the true zoom floor (minZoomScale=${minZoomScale.toFixed(3)}): brightPixels=${ownAtFloor.brightCount}`);
  check("the player's own tag disappears once the camera hits the true zoom floor", ownAtFloor.brightCount === 0, `${ownAtFloor.brightCount} bright px`);

  await page.close();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
