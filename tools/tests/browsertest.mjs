// End-to-end check of the real game in Chromium: spawn, economy, attacking,
// building, nukes, alliances, trade, and the end screen. Run the dev server
// first (`npm start`), then `node tools/tests/browsertest.mjs`.
import { chromium } from './lib/browser.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8123';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'oceanfront-test-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const errors = [];
const logs = [];

function step(name) { console.log(`\n▸ ${name}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function bad(msg) { console.log(`  ✗ ${msg}`); errors.push(msg); }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('console', (m) => {
  logs.push(`${m.type()}: ${m.text()}`);
  if (m.type() === 'error') errors.push(`console error: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));

// Screen coordinates of a map tile, right now.
const pointOf = (tile) =>
  page.evaluate((t) => {
    const { renderer: r, game: g } = window.OceanFront;
    const p = r.worldToScreen(g.map.xOf(t) + 0.5, g.map.yOf(t) + 0.5);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }, tile);

const clickTile = async (tile) => {
  const p = await pointOf(tile);
  await page.mouse.click(p.x, p.y);
};

// ---------------------------------------------------------------- start ---
step('Load start screen');
await page.goto(BASE, { waitUntil: 'networkidle' });
if (await page.isVisible('#startscreen')) ok('start screen visible');
else bad('start screen did not render');
await page.screenshot({ path: `${SHOTS}/01-start.png` });

await page.fill('#name-input', 'Testland');
await page.fill('#seed-input', '4242');
await page.click('#size-picker .choice:nth-child(1)'); // small map = quicker match
await page.click('#btn-start');

await page.waitForFunction(() => window.OceanFront?.game != null, null, { timeout: 15000 });
ok('game constructed');

const mapInfo = await page.evaluate(() => {
  const g = window.OceanFront.game;
  return {
    land: g.map.landCount,
    size: g.map.size,
    oceans: g.map.oceanCount,
    players: g.players.length,
    state: g.state,
  };
});
console.log(`  map: ${mapInfo.land}/${mapInfo.size} land, ${mapInfo.oceans} seas, ${mapInfo.players} nations, state=${mapInfo.state}`);
if (mapInfo.state !== 'spawn') bad(`expected spawn state, got ${mapInfo.state}`);
if (mapInfo.land < 1000) bad('map has suspiciously little land');
await page.screenshot({ path: `${SHOTS}/02-spawn.png` });

// ---------------------------------------------------------------- spawn ---
step('Claim a homeland by clicking the map');
const spawnTile = await page.evaluate(() => window.OceanFront.game.spawnCandidates[0]);
await clickTile(spawnTile);
await page.waitForTimeout(400);

const afterSpawn = await page.evaluate(() => {
  const g = window.OceanFront.game;
  return { state: g.state, tiles: g.human.tiles.size, troops: Math.round(g.human.troops) };
});
if (afterSpawn.state === 'playing') ok(`match started; you hold ${afterSpawn.tiles} tiles, ${afterSpawn.troops} troops`);
else bad(`click did not start the match (state=${afterSpawn.state})`);
if (await page.isHidden('#spawnbanner')) ok('spawn banner dismissed');
else bad('spawn banner still showing');

// ------------------------------------------------------------- economy ---
step('Let the economy run');
await page.click('.speed-btn[data-speed="3"]');
await page.waitForTimeout(3000);

const econ = await page.evaluate(() => {
  const g = window.OceanFront.game;
  return {
    gold: Math.round(g.human.gold),
    pop: Math.round(g.human.pop),
    income: +g.human.goldPerSecond.toFixed(2),
    ticks: g.tickCount,
  };
});
console.log(`  after ${econ.ticks} ticks: ${econ.gold} gold (+${econ.income}/s), pop ${econ.pop}`);
if (econ.gold > 150) ok('gold is accumulating');
else bad(`gold did not grow (${econ.gold})`);
if (econ.ticks > 50) ok('simulation is ticking');
else bad(`too few ticks elapsed (${econ.ticks})`);

const hudGold = await page.textContent('#stat-gold');
if (hudGold && /\d/.test(hudGold)) ok(`HUD shows gold: "${hudGold.trim()}"`);
else bad('HUD gold not populated');

// -------------------------------------------------------------- attack ---
step('Attack neutral land');
const tilesBefore = await page.evaluate(() => window.OceanFront.game.human.tiles.size);
const neutralTile = await page.evaluate(() => {
  const g = window.OceanFront.game;
  // Any neutral land tile bordering us -- attacks target an owner, not a tile.
  const nb = new Int32Array(4);
  for (const t of g.human.tiles) {
    const n = g.map.neighbors(t, nb);
    for (let k = 0; k < n; k++) {
      if (g.map.isLand(nb[k]) && g.owner[nb[k]] === -1) return nb[k];
    }
  }
  return -1;
});
if (neutralTile < 0) bad('no neutral border tile found');
else {
  await clickTile(neutralTile);
  await page.waitForTimeout(2500);
  const tilesAfter = await page.evaluate(() => window.OceanFront.game.human.tiles.size);
  if (tilesAfter > tilesBefore) ok(`territory grew ${tilesBefore} → ${tilesAfter} tiles`);
  else bad(`attack did not expand territory (${tilesBefore} → ${tilesAfter})`);
}

// --------------------------------------------------------------- build ---
step('Build structures');
// Grow a bit first so there is room for spaced-out structures and a coastline.
await page.waitForTimeout(4000);
await page.evaluate(() => { window.OceanFront.game.human.gold = 20000; });
console.log(`  territory is now ${await page.evaluate(() => window.OceanFront.game.human.tiles.size)} tiles`);

for (const [key, label] of [['city', 'City'], ['port', 'Port'], ['defense', 'Defense Post'], ['silo', 'Missile Silo']]) {
  const tile = await page.evaluate((k) => {
    const g = window.OceanFront.game;
    for (const t of g.human.tiles) {
      if (!g.buildingPlacementError(g.human, k, t)) return t;
    }
    return -1;
  }, key);

  if (tile < 0) {
    // A landlocked start legitimately has nowhere to put a port.
    if (key === 'port') console.log(`  – ${label} skipped: no coastal tile held yet`);
    else bad(`no legal tile for ${label}`);
    continue;
  }

  const idx = ['city', 'port', 'defense', 'silo', 'sam'].indexOf(key);
  await page.click(`#build-list .build-btn:nth-child(${idx + 1})`);
  await clickTile(tile);
  await page.waitForTimeout(250);

  const built = await page.evaluate((k) => window.OceanFront.game.human.countOf(k), key);
  if (built > 0) ok(`${label} built (${built})`);
  else bad(`${label} was not built`);
}

// ---------------------------------------------------------------- nuke ---
step('Launch a nuclear strike');
await page.evaluate(() => { window.OceanFront.game.human.gold = 20000; });
const nukeDisabled = await page.getAttribute('#btn-nuke', 'disabled');
if (nukeDisabled === null) ok('nuke button enabled after silo');
else bad('nuke button still disabled despite owning a silo');

await page.click('#btn-nuke');
const enemyTile = await page.evaluate(() => {
  const g = window.OceanFront.game;
  const rival = g.players.find((p) => p.alive && !p.isHuman && p.tiles.size > 0);
  return rival ? [...rival.tiles][0] : -1;
});
if (enemyTile < 0) bad('no rival territory to target');
else {
  await clickTile(enemyTile);
  await page.waitForTimeout(300);
  const missiles = await page.evaluate(() => window.OceanFront.game.missiles.length);
  if (missiles > 0) ok(`missile in flight (${missiles})`);
  else bad('missile was not launched');
  await page.waitForTimeout(3000);
}

// ----------------------------------------------------------- diplomacy ---
step('Propose an alliance');
const proposed = await page.evaluate(() => {
  const g = window.OceanFront.game;
  const rival = g.standings().find((p) => !p.isHuman);
  if (!rival) return null;
  const okProposed = g.diplomacy.propose(g.human.id, rival.id);
  return { name: rival.name, okProposed, offers: g.diplomacy.offers.length };
});
if (proposed?.okProposed) ok(`offer sent to ${proposed.name} (${proposed.offers} pending)`);
else bad('alliance offer failed');

// Force one through to exercise the allied-attack block and trade bonus.
const allied = await page.evaluate(() => {
  const g = window.OceanFront.game;
  const rival = g.standings().find((p) => !p.isHuman);
  g.diplomacy.accept({ from: g.human.id, to: rival.id, tick: g.tickCount });
  const blocked = g.launchAttack(g.human, rival.id, 500) === null;
  return { name: rival.name, isAllied: g.human.allies.has(rival.id), blocked };
});
if (allied.isAllied) ok(`allied with ${allied.name}`);
else bad('alliance was not recorded');
if (allied.blocked) ok('attacks against an ally are refused');
else bad('attacking an ally was allowed');

await page.waitForTimeout(500);
const lbHtml = await page.textContent('#leaderboard');
if (lbHtml.includes('Betray')) ok('leaderboard offers a Betray action');
else bad('no Betray button appeared for the ally');

// ---------------------------------------------------------------- trade ---
step('Check trade routes');
const trade = await page.evaluate(() => {
  const g = window.OceanFront.game;
  // Nations start inland, so hand the player and their ally a stretch of coast
  // on the same sea and put a port on each. This exercises the real trade
  // graph rather than waiting for the map to develop naturally.
  const ally = g.players.find((p) => g.human.allies.has(p.id)) || g.standings().find((p) => !p.isHuman);

  const coastals = [];
  for (let i = 0; i < g.map.size; i++) if (g.map.coastal[i]) coastals.push(i);

  const first = coastals[0];
  const sea = g.map.seaOf(first);
  const second = coastals.find((t) => g.map.seaOf(t) === sea && g.map.dist(t, first) > 25);
  if (second === undefined) return { routes: 0, income: 0, humanPorts: 0, allied: 0, note: 'one-sided sea' };

  g.setOwner(first, g.human.id);
  g.setOwner(second, ally.id);
  g.human.gold = 99999;
  ally.gold = 99999;
  const a = g.build(g.human, 'port', first);
  const b = g.build(ally, 'port', second);
  g.refreshTrade();
  if (!a.ok || !b.ok) return { routes: 0, income: 0, humanPorts: 0, allied: 0, note: `${a.reason || ''} ${b.reason || ''}` };
  return {
    routes: g.tradeRoutes.length,
    income: +g.human.tradeIncome.toFixed(2),
    humanPorts: g.human.countOf('port'),
    allied: g.tradeRoutes.filter((r) => r.allied).length,
  };
});
console.log(`  ${trade.routes} route(s) (${trade.allied} with allies), you hold ${trade.humanPorts} port(s), trade income +${trade.income}/s${trade.note ? ` [${trade.note}]` : ''}`);
if (trade.routes > 0) ok('sea trade routes established');
else bad('no trade routes formed even with ports on every coast');
if (trade.humanPorts > 0 && trade.income > 0) ok('player earns gold from trade');
else if (trade.humanPorts > 0) bad('player has a port but earns no trade income');

await page.screenshot({ path: `${SHOTS}/03-midgame.png` });

// zoomed-out view of the whole world
await page.evaluate(() => window.OceanFront.renderer.fitToScreen());
await page.waitForTimeout(1200);
await page.screenshot({ path: `${SHOTS}/04-world.png` });

// ------------------------------------------------------------ endgame ---
step('Force a win to check the end screen');
await page.evaluate(() => {
  const g = window.OceanFront.game;
  for (const p of g.players) {
    if (p.isHuman) continue;
    for (const t of [...p.tiles]) g.setOwner(t, g.human.id);
  }
  // A rival mid-attack or mid-boat gets a grace period from elimination
  // (see Game#checkEliminations) even at 0 tiles, and can reclaim land
  // before the next check -- clear those too for a deterministic win.
  g.attacks = g.attacks.filter((a) => a.attackerId === g.human.id);
  g.boats = g.boats.filter((b) => b.ownerId === g.human.id);
});
await page.waitForTimeout(1500);
const endVisible = await page.isVisible('#endscreen');
if (endVisible) {
  const title = (await page.textContent('#end-title')).trim();
  ok(`end screen shown: "${title}"`);
} else bad('end screen never appeared');
await page.screenshot({ path: `${SHOTS}/05-end.png` });

// ---------------------------------------------------------------- done ---
await browser.close();

console.log(`\n${'='.repeat(58)}`);
if (errors.length === 0) {
  console.log('ALL BROWSER CHECKS PASSED — no console or page errors.');
} else {
  console.log(`${errors.length} PROBLEM(S):`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exitCode = 1;
}
