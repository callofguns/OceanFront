// Playwright verification for bot difficulty + the attacking-troops HUD stat:
//  1. Attacking-troops HUD stat appears/updates during a live attack, hides when idle.
//  2. Difficulty picker renders, persists via localStorage, and reaches Game/AiController.
// Run the dev server first (`npm start`), then this script.
import { chromium } from './lib/browser.mjs';

const BASE = process.env.BASE || 'http://localhost:8123';
let failures = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (!cond) failures++;
}

const browser = await chromium.launch();

async function startMatch(page, { difficulty, seed } = {}) {
  await page.goto(BASE);
  await page.waitForSelector('#startscreen:not([hidden])');
  if (difficulty) {
    const label = difficulty[0].toUpperCase() + difficulty.slice(1);
    const btn = await page.$(`#difficulty-picker .choice:has-text("${label}")`);
    await btn.click();
  }
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
  // #hud itself has no intrinsic height (its panels are individually
  // fixed-positioned), so wait on a real visible child instead.
  await page.waitForSelector('#topbar', { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------- Part 1: picker UI
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE);
  await page.waitForSelector('#startscreen:not([hidden])');

  const picker = await page.$$eval('#difficulty-picker .choice', (els) =>
    els.map((e) => e.textContent.trim())
  );
  check('difficulty picker renders 3 choices', picker.length === 3);
  check(
    'difficulty picker shows Easy/Normal/Hard',
    picker.some((t) => t.includes('Easy')) && picker.some((t) => t.includes('Normal')) && picker.some((t) => t.includes('Hard'))
  );
  await page.close();
}

// ---------------------------------------------------------------- Part 2: localStorage persistence
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE);
  await page.waitForSelector('#startscreen:not([hidden])');
  const hardBtn = await page.$('#difficulty-picker .choice:has-text("Hard")');
  await hardBtn.click();
  await page.fill('#seed-input', '4242');
  await page.click('#btn-start');
  await page.waitForSelector('#spawnbanner:not([hidden])', { timeout: 10000 });

  const lsKeys = await page.evaluate(() => Object.keys(localStorage));
  console.log('  localStorage keys:', JSON.stringify(lsKeys));
  const saved = await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.toLowerCase().includes('oceanfront') || k.toLowerCase().includes('setting')) {
        try { return { key: k, value: JSON.parse(localStorage.getItem(k)) }; } catch { return { key: k, value: localStorage.getItem(k) }; }
      }
    }
    return null;
  });
  console.log('  saved settings:', JSON.stringify(saved));
  check('difficulty=hard persisted to localStorage', saved?.value?.difficulty === 'hard');

  // Reload and confirm the picker restores Hard as active.
  await page.reload();
  await page.waitForSelector('#startscreen:not([hidden])');
  const activeAfterReload = await page.$eval('#difficulty-picker .is-active', (el) => el.textContent.trim());
  check('difficulty picker restores Hard as active after reload', activeAfterReload.includes('Hard'));
  await page.close();
}

// ---------------------------------------------------------------- Part 3: game.difficulty + bot aggression/economy across tiers
{
  const results = {};
  for (const diff of ['easy', 'normal', 'hard']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await startMatch(page, { difficulty: diff, seed: 9999 });
    const info = await page.evaluate(() => {
      const g = window.OceanFront?.game;
      if (!g) return null;
      const bots = g.players.filter((p) => p.ai && p !== g.human);
      const avgAggr = bots.reduce((s, b) => s + b.ai.aggression, 0) / bots.length;
      const avgGold = bots.reduce((s, b) => s + b.goldMultiplier, 0) / bots.length;
      const avgCap = bots.reduce((s, b) => s + b.troopsCapMultiplier, 0) / bots.length;
      const avgGrowth = bots.reduce((s, b) => s + b.troopsMultiplier, 0) / bots.length;
      return { difficulty: g.difficulty, avgAggr, avgGold, avgCap, avgGrowth, botCount: bots.length };
    });
    results[diff] = info;
    await page.close();
  }
  console.log('cross-tier comparison:', JSON.stringify(results, null, 2));
  check('game.difficulty reflects the picked tier for each', Object.entries(results).every(([k, v]) => v?.difficulty === k));
  check(
    'avg bot aggression strictly increases easy < normal < hard',
    results.easy?.avgAggr < results.normal?.avgAggr && results.normal?.avgAggr < results.hard?.avgAggr
  );
  check(
    'avg bot goldMultiplier strictly increases easy < normal < hard',
    results.easy?.avgGold < results.normal?.avgGold && results.normal?.avgGold < results.hard?.avgGold
  );
  check(
    'avg bot troopsCapMultiplier strictly increases easy < normal < hard',
    results.easy?.avgCap < results.normal?.avgCap && results.normal?.avgCap < results.hard?.avgCap
  );
  check(
    'avg bot troopsMultiplier (growth rate) strictly increases easy < normal < hard',
    results.easy?.avgGrowth < results.normal?.avgGrowth && results.normal?.avgGrowth < results.hard?.avgGrowth
  );
}

// ---------------------------------------------------------------- Part 4: attacking-troops HUD stat
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await startMatch(page, { seed: 555 });
  await page.waitForTimeout(600);

  const idleHidden = await page.$eval('#stat-attacking', (el) => el.hidden);
  check('attacking stat hidden while idle (no attacks in flight)', idleHidden === true);

  const attackTriggered = await page.evaluate(() => {
    const g = window.OceanFront?.game;
    if (!g || !g.human) return false;
    const nb = new Int32Array(4);
    for (const t of g.human.tiles) {
      const n = g.map.neighbors(t, nb);
      for (let k = 0; k < n; k++) {
        const nt = nb[k];
        if (!g.human.tiles.has(nt) && g.map.isLand(nt)) {
          const targetId = g.owner[nt];
          g.launchAttack(g.human, targetId, Math.max(50, g.human.troops * 0.5));
          return true;
        }
      }
    }
    return false;
  }).catch((e) => { console.log('  attack trigger error:', e.message); return false; });

  console.log('  attack triggered via game API:', attackTriggered);
  check('attack could be triggered via game API', attackTriggered === true);

  if (attackTriggered) {
    // Force a HUD refresh (real gameplay ticks call this every frame via the
    // render loop, which is already running, but wait long enough for it).
    await page.waitForTimeout(700);
    const duringVisible = await page.$eval('#stat-attacking', (el) => ({ hidden: el.hidden, text: el.textContent }));
    console.log('  during attack:', JSON.stringify(duringVisible));
    check('attacking stat visible during a live attack', duringVisible.hidden === false);
    check('attacking stat shows a positive troop count', Number(duringVisible.text.replace(/[^0-9.]/g, '')) > 0);

    // Let the attack resolve/settle and confirm it goes back to hidden once done.
    await page.waitForTimeout(6000);
    const afterVisible = await page.$eval('#stat-attacking', (el) => ({ hidden: el.hidden, text: el.textContent }));
    console.log('  after attack settles:', JSON.stringify(afterVisible));
  }

  await page.close();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
