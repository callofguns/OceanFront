// Same measurement as the diagnosis, with the instrumentation artifact fixed
// (one listener total, reset between measurements) so the numbers are real.
// Run the dev server first (`npm start`), then this script.
import { chromium } from './lib/browser.mjs';

const BASE = process.env.BASE || 'http://localhost:8123';
const errors = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const page = await context.newPage();
page.on('pageerror', (e) => { console.log('PAGE ERROR:', e.message); errors.push(e.message); });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const cdp = await context.newCDPSession(page);

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('#seed-input', '4242');
await page.click('#size-picker .choice:nth-child(1)');
await page.click('#btn-start');
await page.waitForFunction(() => window.OceanFront?.game != null);
const spawnTile = await page.evaluate(() => window.OceanFront.game.spawnCandidates[0]);
const sp = await page.evaluate((t) => {
  const { renderer: r, game: g } = window.OceanFront;
  const pt = r.worldToScreen(g.map.xOf(t) + 0.5, g.map.yOf(t) + 0.5);
  return { x: Math.round(pt.x), y: Math.round(pt.y) };
}, spawnTile);
await page.mouse.click(sp.x, sp.y);
await page.waitForTimeout(400);
await page.evaluate(() => { window.OceanFront.game.human.gold = 500000; });
// Nothing here drives the human -- it just sits at its tiny starting patch
// for however long this whole tap sequence takes (several minutes of real
// dwell-timed taps), so it can't be left exposed to the AI for that whole
// stretch: this is a tap-timing test, not a combat-survival one, and an
// idle human getting eliminated (conventional attack or a nuke, which
// bypasses troop-cost entirely) mid-run crashes the test on an unrelated
// "endscreen intercepts pointer events" timeout. Freezing every other
// player's AI (the same duck-typed `if (p.ai) p.ai.update(game)` gate
// every bot/tribe goes through, src/game.js) removes every elimination
// vector at the source rather than trying to out-tank whatever the
// current aggression/pacing tuning happens to be -- the economy still
// ticks normally, only decision-making stops.
await page.evaluate(() => {
  const g = window.OceanFront.game;
  for (const p of g.players) if (!p.isHuman) p.ai = null;
});

// One delegated counter for the whole run; selector + count are swapped per
// measurement instead of adding another listener each time.
await page.evaluate(() => {
  window.__probe = { selector: null, hits: 0 };
  document.addEventListener('click', (e) => {
    const s = window.__probe.selector;
    if (s && e.target.closest && e.target.closest(s)) window.__probe.hits++;
  }, true);
});

async function realTap(x, y, dwellMs) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await new Promise((r) => setTimeout(r, dwellMs));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function measure(label, selector, taps, dwellMs, beforeEachTap) {
  await page.evaluate((s) => { window.__probe.selector = s; window.__probe.hits = 0; }, selector);
  let attempted = 0;
  for (let i = 0; i < taps; i++) {
    if (beforeEachTap) await beforeEachTap();
    const box = await page.locator(selector).first().boundingBox();
    if (!box) break;
    await realTap(box.x + box.width / 2, box.y + box.height / 2, dwellMs);
    attempted++;
    await new Promise((r) => setTimeout(r, 90));
  }
  const hits = await page.evaluate(() => window.__probe.hits);
  const pct = attempted ? Math.round((hits / attempted) * 100) : 0;
  const verdict = pct === 100 ? 'OK' : pct >= 60 ? 'FLAKY' : 'BROKEN';
  console.log(`  ${label.padEnd(32)} ${String(hits).padStart(2)}/${attempted}  ${String(pct).padStart(3)}%  ${verdict}`);
  if (pct < 100) errors.push(`${label} only registered ${pct}% of taps`);
  return pct;
}

/**
 * End-to-end truth test for the Ally button: find a row that currently shows
 * an enabled "Ally", tap it once, and confirm a proposal now exists for that
 * exact nation. This measures whether one tap did the intended thing, rather
 * than merely whether a click event landed somewhere.
 */
async function measureAllyFunctional(dwellMs, taps = 6) {
  let attempted = 0;
  let succeeded = 0;

  for (let i = 0; i < taps; i++) {
    await openSheet('sidepanel');
    // Clear pending offers so there's always a fresh "Ally" target.
    await page.evaluate(() => {
      window.OceanFront.game.diplomacy.offers.length = 0;
      window.__proposals = [];
      // Record every propose() the UI triggers, so a tap that worked is
      // distinguishable from an AI that simply said no.
      const dip = window.OceanFront.game.diplomacy;
      if (!dip.__wrapped) {
        dip.__wrapped = true;
        const original = dip.propose.bind(dip);
        dip.propose = (from, to) => {
          const result = original(from, to);
          if (result) (window.__proposals = window.__proposals || []).push({ from, to });
          return result;
        };
      }
      window.__trace = [];
      if (!window.__traceBound) {
        window.__traceBound = true;
        for (const t of ['pointerdown', 'pointerup', 'click']) {
          document.addEventListener(t, (e) => {
            const btn = e.target.closest && e.target.closest('.lb-btn');
            const row = e.target.closest && e.target.closest('.lb-row');
            window.__trace.push(`${t}:${e.target.tagName}${btn ? '(btn:' + btn.textContent + ',disabled=' + btn.disabled + ')' : ''}${row ? '[' + row.querySelector('.lb-name').textContent + ']' : ''}`);
          }, true);
        }
      }
      window.OceanFront.ui.refreshHud(true);
    });
    await new Promise((r) => setTimeout(r, 60));

    const target = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#leaderboard .lb-row')];
      for (const li of rows) {
        const btn = li.querySelector('.lb-btn');
        if (!btn || btn.hidden || btn.disabled || btn.textContent !== 'Ally') continue;
        const r = btn.getBoundingClientRect();
        // Require the button fully visible, and fully inside the
        // leaderboard's own scroll box -- a half-scrolled-off button isn't
        // something a real player would be tapping at either.
        const scroller = li.parentElement.getBoundingClientRect();
        if (r.width === 0 || r.top < 0 || r.bottom > innerHeight) continue;
        if (r.top < scroller.top || r.bottom > scroller.bottom) continue;
        return { name: li.querySelector('.lb-name').textContent, x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    });
    if (!target) break;

    await realTap(target.x, target.y, dwellMs);
    attempted++;
    await new Promise((r) => setTimeout(r, 140));

    const outcome = await page.evaluate((t) => {
      const g = window.OceanFront.game;
      const other = g.players.find((p) => p.name === t.name);
      if (!other) return { proposed: false, why: 'nation vanished from the game' };
      if (!other.alive) return { proposed: false, why: 'nation was eliminated mid-tap' };
      // Success = the tap actually invoked the diplomacy action for this
      // nation. Whether the AI then accepts, declines, or leaves it pending
      // is game logic, not tap reliability -- a decline still means the
      // button worked on one tap.
      const acted = (window.__proposals || []).some((p) => p.to === other.id);
      const proposed = acted || !!g.diplomacy.pendingBetween(g.human.id, other.id) || g.human.allies.has(other.id);
      // What is actually under the tap point now?
      const el = document.elementFromPoint(t.x, t.y);
      const row = el && el.closest ? el.closest('.lb-row') : null;
      return {
        proposed,
        why: proposed
          ? ''
          : `under tap point now: ${row ? row.querySelector('.lb-name').textContent : el && el.tagName}` +
            ` | events: ${window.__trace.join(' -> ') || 'NONE'}` +
            ` | allied=${g.human.allies.has(other.id)} pending=${!!g.diplomacy.pendingBetween(g.human.id, other.id)}` +
            ` traitor=${g.human.traitorScore.toFixed(2)} state=${g.state}`,
      };
    }, target);
    if (outcome.proposed) succeeded++;
    else console.log(`      [miss] aimed at "${target.name}" — ${outcome.why}`);
  }

  const pct = attempted ? Math.round((succeeded / attempted) * 100) : 0;
  const verdict = pct === 100 ? 'OK' : pct >= 60 ? 'FLAKY' : 'BROKEN';
  console.log(`  ${'leaderboard Ally (functional)'.padEnd(32)} ${String(succeeded).padStart(2)}/${attempted}  ${String(pct).padStart(3)}%  ${verdict}`);
  if (pct < 100) errors.push(`leaderboard Ally button only worked on ${pct}% of single taps`);
}

const openSheet = async (panel) => {
  const isOpen = await page.evaluate((p) => document.getElementById(p).classList.contains('is-open'), panel);
  if (!isOpen) {
    await page.tap(`.tab-btn[data-panel="${panel}"]`);
    // The sheet slides in over 240ms (CSS transition). Wait for the element
    // to actually stop moving before measuring where to tap -- otherwise the
    // harness aims at a position the sheet has since animated away from,
    // which is a measurement artifact, not a game bug.
    await page.waitForFunction((p) => {
      const el = document.getElementById(p);
      const y = el.getBoundingClientRect().top;
      if (window.__lastY === y) return true;
      window.__lastY = y;
      return false;
    }, panel, { polling: 60, timeout: 3000 });
    await page.waitForTimeout(80);
  }
};
const closeSheets = async () => {
  await page.evaluate(() => document.querySelectorAll('.is-open').forEach((e) => e.classList.remove('is-open')));
  await page.evaluate(() => document.getElementById('hud').classList.remove('has-open-sheet'));
  await page.waitForTimeout(200);
};

console.log('\nTap registration during a LIVE game (HUD refreshing ~8x/sec)\n');

for (const dwell of [30, 90, 150]) {
  console.log(`— finger dwell ${dwell}ms —`);

  await openSheet('sidepanel');
  await measureAllyFunctional(dwell);
  await closeSheets();

  // Build buttons close their sheet on activation by design, so reopen and
  // clear the mode before each tap -- otherwise we'd be tapping empty space.
  await measure('build menu btn', '#build-list .build-btn', 6, dwell, async () => {
    await page.evaluate(() => window.OceanFront.ui.cancelModes());
    await openSheet('buildpanel');
  });
  await closeSheets();

  await measure('speed btn', '.speed-btn[data-speed="2"]', 6, dwell);
  await measure('tab btn', '.tab-btn[data-panel="sidepanel"]', 6, dwell, closeSheets);
  await closeSheets();
  console.log('');
}

// Mechanism check: track ONE specific row's button (by nation), not "the
// first button" -- rows legitimately change position when standings re-sort.
const churn = await page.evaluate(async () => {
  const li = document.querySelector('#leaderboard .lb-row');
  const nationName = li.querySelector('.lb-name').textContent;
  const first = li.querySelector('.lb-btn');
  await new Promise((r) => setTimeout(r, 800));
  const stillSame = [...document.querySelectorAll('#leaderboard .lb-row')].some(
    (row) => row.querySelector('.lb-name').textContent === nationName && row.querySelector('.lb-btn') === first
  );
  return { nationName, stillSameNode: stillSame, stillAttached: document.contains(first) };
});
console.log(`\nA specific nation's button (${churn.nationName}) across 800ms of refreshes:`);
console.log(`  still the very same DOM node? ${churn.stillSameNode}`);
console.log(`  still attached to document?   ${churn.stillAttached}`);
if (!churn.stillSameNode || !churn.stillAttached) errors.push('a nation\'s button is still being replaced across refreshes');

await browser.close();
console.log(`\n${'='.repeat(58)}`);
if (errors.length === 0) console.log('ALL TAPS REGISTERED ON THE FIRST TRY.');
else {
  console.log(`${errors.length} PROBLEM(S):`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exitCode = 1;
}
