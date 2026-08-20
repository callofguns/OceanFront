// Verifies tribes render distinctly from nations on the map: no border
// stroke around their territory (just the same translucent fill as their
// interior tiles) and a muted color drawn from TRIBE_COLORS rather than
// PLAYER_COLORS -- matching OpenFrontIO's own bot rendering, where an
// already-desaturated palette plus a uniform border formula makes bot edges
// read as flat, borderless blobs next to one another.
// Run the dev server first (`npm start`), then this script.
import { chromium } from './lib/browser.mjs';

const BASE = process.env.BASE || 'http://localhost:8123';
let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(BASE);
await page.waitForSelector('#startscreen:not([hidden])');
await page.fill('#seed-input', '42');
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

// Run several ticks at max speed so tribes and nations both hold enough real
// (non-hand-painted) territory to have genuine interior and border tiles.
await page.click('.speed-btn[data-speed="3"]');
await page.waitForTimeout(5000);

const result = await page.evaluate(() => {
  const { game, renderer } = window.OceanFront;
  const { width, height } = game.map;
  const owner = game.owner;

  function isBorder(i, o) {
    const x = i % width;
    const y = Math.floor(i / width);
    return (
      x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
      owner[i - 1] !== o || owner[i + 1] !== o ||
      owner[i - width] !== o || owner[i + width] !== o
    );
  }

  // Find one real border tile and one real interior tile for a tribe and a
  // nation with enough territory to have both kinds.
  function findTiles(player) {
    let border = -1;
    let interior = -1;
    for (const t of player.tiles) {
      const b = isBorder(t, player.id);
      if (b && border === -1) border = t;
      if (!b && interior === -1) interior = t;
      if (border !== -1 && interior !== -1) break;
    }
    return { border, interior };
  }

  const tribe = game.players.filter((pl) => pl.isTribe && pl.tiles.size > 20)[0];
  const nation = game.players.filter((pl) => pl.ai && !pl.isTribe && !pl.isHuman && pl.tiles.size > 20)[0];
  if (!tribe || !nation) return { ok: false, reason: 'not enough territory yet' };

  const tTiles = findTiles(tribe);
  const nTiles = findTiles(nation);
  if (tTiles.border < 0 || tTiles.interior < 0 || nTiles.border < 0 || nTiles.interior < 0) {
    return { ok: false, reason: 'could not find both border and interior tiles', tTiles, nTiles };
  }

  const px = (i) => {
    const x = i % width;
    const y = Math.floor(i / width);
    return renderer.layerCtx.getImageData(x, y, 1, 1).data;
  };

  return {
    ok: true,
    tribeIsNoBorder: renderer.colors[tribe.id].noBorder,
    nationIsNoBorder: renderer.colors[nation.id].noBorder,
    tribeColor: tribe.color,
    nationColor: nation.color,
    tribeBorderPx: Array.from(px(tTiles.border)).slice(0, 3),
    tribeInteriorPx: Array.from(px(tTiles.interior)).slice(0, 3),
    nationBorderPx: Array.from(px(nTiles.border)).slice(0, 3),
    nationInteriorPx: Array.from(px(nTiles.interior)).slice(0, 3),
  };
});

console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  check('setup: found both a tribe and a nation with real border+interior tiles', false, result.reason);
} else {
  check('renderer.colors marks the tribe as noBorder', result.tribeIsNoBorder === true);
  check('renderer.colors does NOT mark the nation as noBorder', result.nationIsNoBorder === false);

  const close = (a, b, tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  check(
    "a tribe's border tile renders identically to its own interior tile (no border stroke)",
    close(result.tribeBorderPx, result.tribeInteriorPx),
    `border=${result.tribeBorderPx} interior=${result.tribeInteriorPx}`
  );
  check(
    "a nation's border tile renders visibly differently from its own interior tile (border stroke present)",
    !close(result.nationBorderPx, result.nationInteriorPx, 8),
    `border=${result.nationBorderPx} interior=${result.nationInteriorPx}`
  );

  const TRIBE_COLORS = [
    '#96a08c', '#aaaa78', '#96aa96', '#788c78',
    '#82a096', '#8296aa', '#8ca0aa', '#78828c',
    '#968296', '#aa96aa', '#aa788c', '#b48c8c',
    '#be8c78', '#aa9682', '#a08c96', '#b4a0a0',
  ];
  check('the tribe’s color comes from the muted TRIBE_COLORS palette', TRIBE_COLORS.includes(result.tribeColor));
}

await browser.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
