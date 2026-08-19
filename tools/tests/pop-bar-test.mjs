// Playwright verification for the HUD troop-cap fill bar (matches
// OpenFrontIO's own troop bar exactly, not just its layout): the overlay
// numbers and the two fill segments' transforms track troops/maxTroops and
// troops-committed-to-attacks/maxTroops correctly and stay clamped once
// overfull, the rate chip reflects Player#popRate, and the underlying DOM
// nodes are reused across refreshes rather than rebuilt (the DOM-churn
// tap-loss regression this project hit once before -- see
// tap-reliability-verify.mjs).
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

// Recovers a fill percentage from its transform string (scaleX(x) /
// translateX(y%) scaleX(x)) rather than trusting anything cached in JS.
function pctFromScaleX(transform) {
  const m = /scaleX\(([\d.]+)\)/.exec(transform);
  return m ? Number(m[1]) * 100 : NaN;
}
function pctFromTranslateScale(transform) {
  const t = /translateX\(([\d.]+)%\)/.exec(transform);
  const s = /scaleX\(([\d.]+)\)/.exec(transform);
  return { offset: t ? Number(t[1]) : NaN, scale: s ? Number(s[1]) * 100 : NaN };
}

// ---------------------------------------------------------------- Part 1: normal fill matches troops/maxTroops
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await startMatch(page, { seed: 1234 });

  const result = await page.evaluate(() => {
    const g = window.OceanFront.game;
    const h = g.human;
    const maxTroops = h.maxTroops;
    h.troops = maxTroops * 0.5;
    // A fake in-flight attack is enough to exercise the bar's second
    // segment -- it only needs game.attacksBy(human.id) to sum something,
    // not a real, geographically valid attack.
    g.attacks.push({ attackerId: h.id, targetId: -1, troops: maxTroops * 0.2, done: false, frontier: [], inFrontier: new Set(), fails: 0 });
    window.OceanFront.ui.refreshHud(true);
    return {
      maxTroops, troops: h.troops, committed: maxTroops * 0.2,
      troopsT: document.getElementById('pop-bar-troops').style.transform,
      attackingT: document.getElementById('pop-bar-attacking').style.transform,
    };
  });

  const troopPct = pctFromScaleX(result.troopsT);
  const { offset, scale: attackingPct } = pctFromTranslateScale(result.attackingT);
  const expectedTroopPct = (result.troops / result.maxTroops) * 100;
  const expectedAttackingPct = (result.committed / result.maxTroops) * 100;

  console.log(`  troops fill: ${troopPct.toFixed(1)}% (expected ~${expectedTroopPct.toFixed(1)}%)`);
  console.log(`  attacking fill: offset ${offset.toFixed(1)}% scale ${attackingPct.toFixed(1)}% (expected offset ~${expectedTroopPct.toFixed(1)}%, scale ~${expectedAttackingPct.toFixed(1)}%)`);
  check('troops segment scaleX matches troops/maxTroops', Math.abs(troopPct - expectedTroopPct) < 0.5);
  check('attacking segment starts where troops segment ends', Math.abs(offset - troopPct) < 0.5);
  check('attacking segment scaleX matches committed-troops/maxTroops', Math.abs(attackingPct - expectedAttackingPct) < 0.5);

  const overlay = await page.evaluate(() => ({
    pop: document.getElementById('stat-pop').textContent,
    max: document.getElementById('stat-pop-max').textContent,
  }));
  console.log(`  overlay: "${overlay.pop}" / "${overlay.max}"`);
  check('overlay current-troops text is non-empty and numeric-looking', /^[\d.]+[kM]?$/.test(overlay.pop));
  check('overlay max-troops text is non-empty and numeric-looking', /^[\d.]+[kM]?$/.test(overlay.max));

  await page.close();
}

// ---------------------------------------------------------------- Part 2: overfull troops clamps to 100% and flags is-over
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await startMatch(page, { seed: 1234 });

  const result = await page.evaluate(() => {
    const g = window.OceanFront.game;
    const h = g.human;
    const maxTroops = h.maxTroops;
    // Deliberately over the cap, like right after losing a lot of land in
    // one go (Player#updateEconomy's decay branch handles bringing this
    // back down over subsequent ticks -- this test forces the
    // instant-after-loss snapshot the bar needs to render correctly too).
    h.troops = maxTroops * 1.6;
    g.attacks.push({ attackerId: h.id, targetId: -1, troops: maxTroops * 0.8, done: false, frontier: [], inFrontier: new Set(), fails: 0 });
    window.OceanFront.ui.refreshHud(true);
    return {
      isOver: document.getElementById('pop-bar').classList.contains('is-over'),
      troopsT: document.getElementById('pop-bar-troops').style.transform,
      attackingT: document.getElementById('pop-bar-attacking').style.transform,
    };
  });

  const troopPct = pctFromScaleX(result.troopsT);
  const { offset, scale: attackingPct } = pctFromTranslateScale(result.attackingT);
  console.log(`  overfull: troops ${troopPct.toFixed(1)}%, attacking offset ${offset.toFixed(1)}% scale ${attackingPct.toFixed(1)}%, is-over=${result.isOver}`);
  check('overfull troops flags .is-over on the bar', result.isOver === true);
  check('troops segment clamps to <=100%', troopPct <= 100.01);
  check('combined fill never exceeds the track (troops% + attacking% <= 100%)', troopPct + attackingPct <= 100.01);

  await page.close();
}

// ---------------------------------------------------------------- Part 3: rate chip reflects Player#popRate's sign
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await startMatch(page, { seed: 4242 });
  await page.waitForTimeout(600);

  const growing = await page.evaluate(() => {
    window.OceanFront.ui.refreshHud(true);
    return { rate: window.OceanFront.game.human.popRate, text: document.getElementById('stat-pop-rate').textContent };
  });
  console.log(`  growing nation: popRate=${growing.rate.toFixed(1)}, chip="${growing.text}"`);
  check('a fresh, under-cap nation has a positive popRate', growing.rate > 0);
  check('rate chip shows a "+" prefix while growing', growing.text.startsWith('+'));
  check('rate chip is not marked falling while growing', await page.evaluate(() => !document.getElementById('stat-pop-rate').classList.contains('is-falling')));

  const shrinking = await page.evaluate(() => {
    const g = window.OceanFront.game;
    const h = g.human;
    // Force well over cap so the decay branch is guaranteed to dominate this
    // tick regardless of current momentum.
    h.troops = h.maxTroops * 3;
    g.tick();
    window.OceanFront.ui.refreshHud(true);
    return { rate: h.popRate, text: document.getElementById('stat-pop-rate').textContent };
  });
  console.log(`  overfull nation: popRate=${shrinking.rate.toFixed(1)}, chip="${shrinking.text}"`);
  check('an overfull nation has a negative popRate', shrinking.rate < 0);
  check('rate chip shows a "-" prefix while shrinking', shrinking.text.startsWith('-'));
  check('rate chip is marked falling while shrinking', await page.evaluate(() => document.getElementById('stat-pop-rate').classList.contains('is-falling')));

  await page.close();
}

// ---------------------------------------------------------------- Part 4: DOM nodes are reused across refreshes, not rebuilt
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await startMatch(page, { seed: 777 });

  const churn = await page.evaluate(async () => {
    const before = {
      bar: document.getElementById('pop-bar'),
      troops: document.getElementById('pop-bar-troops'),
      attacking: document.getElementById('pop-bar-attacking'),
      pop: document.getElementById('stat-pop'),
      rate: document.getElementById('stat-pop-rate'),
    };
    // Several HUD refresh cycles (~8x/sec) across changing state.
    for (let i = 0; i < 20; i++) {
      window.OceanFront.game.human.troops += 1;
      window.OceanFront.ui.refreshHud(true);
      await new Promise((r) => setTimeout(r, 40));
    }
    return {
      sameBar: before.bar === document.getElementById('pop-bar'),
      sameTroops: before.troops === document.getElementById('pop-bar-troops'),
      sameAttacking: before.attacking === document.getElementById('pop-bar-attacking'),
      samePop: before.pop === document.getElementById('stat-pop'),
      sameRate: before.rate === document.getElementById('stat-pop-rate'),
      cachedTroopsStillLive: window.OceanFront.ui.popBarEls.troops === document.getElementById('pop-bar-troops'),
      allAttached: [before.bar, before.troops, before.attacking, before.pop, before.rate].every((el) => document.contains(el)),
    };
  });
  console.log('  node identity across 20 refreshes:', JSON.stringify(churn));
  check('pop-bar track node is reused, not rebuilt', churn.sameBar);
  check('troops fill node is reused, not rebuilt', churn.sameTroops);
  check('attacking fill node is reused, not rebuilt', churn.sameAttacking);
  check('current-troops text node is reused, not rebuilt', churn.samePop);
  check('rate chip node is reused, not rebuilt', churn.sameRate);
  check("UI's cached element reference still points at the live DOM node", churn.cachedTroopsStillLive);
  check('all bar nodes remain attached to the document', churn.allAttached);

  await page.close();
}

// ---------------------------------------------------------------- Part 5: fits on a narrow phone viewport
{
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true });
  const page = await context.newPage();
  await startMatch(page, { seed: 1234 });

  const barVisible = await page.$eval('#pop-bar', (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  check('troop bar is visible at 375px width', barVisible);

  const topbarWidth = await page.evaluate(() => document.getElementById('topbar').scrollWidth);
  console.log(`  topbar content width at 375px: ${topbarWidth}px`);
  check('topbar still fits without internal overflow at 375px', topbarWidth <= 375);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check('no page-level horizontal overflow at 375px', !overflow);

  await context.close();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
