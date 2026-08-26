// Covers src/game.js's team-games machinery (Game#assignTeams,
// Game#isFriendly, the team victory conditions, spawn clustering) and its
// wiring into src/ai.js, src/render.js and src/ui.js.
//
// Two halves, sound-test.mjs's precedent:
//  - Part A is headless (no browser, no server) -- hand-painted board
//    states, same technique as encirclement-test.mjs/ai-behavior-test.mjs
//    (every player's AI disabled except where a test specifically wants
//    one, everyone not under test parked on an isolated tile --
//    CRITICALLY including the human this time: an unparked human at zero
//    tiles self-eliminates at tick 10 and silently stops every later tick
//    in the block from doing anything, see HANDOFF.md).
//  - Part B needs a real browser: the start-screen picker, a live duos
//    match's leaderboard/click-guard/rendering, and a forced team win
//    reaching the end screen.
// Run the dev server first (`npm start`), then this script.

import { Game, NEUTRAL } from '../../src/game.js';
import { AiController } from '../../src/ai.js';
import {
  MAP_PRESETS, PLAINS, OCEAN, ENCLOSURE_SCAN_TICKS, DIFFICULTIES,
  TEAM_SPAWN_RADIUS, VICTORY_LAND_SHARE,
} from '../../src/config.js';
import { chromium } from './lib/browser.mjs';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}

// =============================================================================
// Part A -- headless
// =============================================================================
console.log('\n▶ Part A: Game#assignTeams / isFriendly / victory / spawn clustering (headless)\n');

/** Two AIs used as the active actors (players 1, 2) in most of these
 *  fixtures. Deliberately does NOT include the human (0): everyone not in
 *  CAST gets parked on an isolated one-tile island by blankGame() below,
 *  and the human needs that too -- an unparked human sits at zero tiles,
 *  which #checkEliminations reads as an elimination on the very first
 *  %10===0 tick, flips game.state to 'over' via #endMatch(null), and
 *  silently no-ops every tick after it (see HANDOFF.md's own note on this
 *  exact gotcha, from the sound-and-music round hitting it first). */
const CAST = [1, 2];

function blankGame(opts = {}) {
  const game = new Game({
    preset: MAP_PRESETS.small, seed: 1,
    playerName: 'You', playerColor: '#e0484f', difficulty: 'normal',
    ...opts,
  });
  game.map.terrain.fill(OCEAN);
  game.owner.fill(NEUTRAL);
  for (const p of game.players) {
    p.tiles.clear();
    p.troops = 0;
    p.gold = 0;
    p.alive = true;
    p.lastConquerorId = -1;
    p.ai = null; // no bot or tribe decisions -- deterministic ticks
    p.goldMultiplier = 0;
  }
  game.state = 'playing';
  game.attacks = [];
  game.boats = [];
  game.missiles = [];
  for (const p of game.players) {
    if (CAST.includes(p.id)) continue;
    const x = 5 + p.id * 4;
    const y = 185;
    game.map.terrain[game.map.idx(x, y)] = PLAINS;
    game.setOwner(game.map.idx(x, y), p.id);
  }
  return game;
}

/** Paint a filled rectangle. `id === NEUTRAL` paints unclaimed land. */
function rect(game, x0, y0, x1, y1, id) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      game.map.terrain[game.map.idx(x, y)] = PLAINS;
      if (id !== NEUTRAL) game.setOwner(game.map.idx(x, y), id);
    }
  }
}

// -------------------------------------------------------- team assignment ---
{
  for (const preset of [MAP_PRESETS.small, MAP_PRESETS.medium, MAP_PRESETS.large]) {
    for (const teamMode of ['duos', 'trios', 'quads']) {
      const game = new Game({ preset, seed: 7, playerName: 'You', playerColor: '#e0484f', difficulty: 'normal', teamMode });
      const nonTribe = game.players.filter((p) => !p.isTribe);
      const badNonTribe = nonTribe.filter((p) => p.teamId === null).length;
      const badTribe = game.players.filter((p) => p.isTribe && p.teamId !== null).length;
      const sizes = game.teams.map((t) => t.length);
      const tooSmall = sizes.some((s) => s < 2);
      check(`${preset.key}/${teamMode}: every non-tribe player has a real teamId`, badNonTribe === 0, `bad=${badNonTribe}`);
      check(`${preset.key}/${teamMode}: every tribe has teamId===null`, badTribe === 0, `bad=${badTribe}`);
      check(`${preset.key}/${teamMode}: no team has fewer than 2 members`, !tooSmall, `sizes=${JSON.stringify(sizes)}`);
      check(`${preset.key}/${teamMode}: team ids are contiguous 0..n-1`, game.teams.length > 0 && sizes.length === game.teams.length);
    }
  }

  // Solo: every non-tribe player is its own team.
  const solo = new Game({ preset: MAP_PRESETS.small, seed: 7, playerName: 'You', playerColor: '#e0484f', difficulty: 'normal', teamMode: 'solo' });
  const soloOk = solo.players.filter((p) => !p.isTribe).every((p) => p.teamId === p.id);
  check('solo: every nation is its own team (teamId === playerId)', soloOk);

  // Determinism: same seed + mode => identical team composition.
  const dupA = new Game({ preset: MAP_PRESETS.small, seed: 99, playerName: 'You', playerColor: '#e0484f', difficulty: 'normal', teamMode: 'duos' });
  const dupB = new Game({ preset: MAP_PRESETS.small, seed: 99, playerName: 'You', playerColor: '#e0484f', difficulty: 'normal', teamMode: 'duos' });
  const teamsA = dupA.players.map((p) => p.teamId).join(',');
  const teamsB = dupB.players.map((p) => p.teamId).join(',');
  check('same seed + mode reproduces identical team composition (Restart Match)', teamsA === teamsB);
}

// -------------------------------------------------------------- rng discipline ---
{
  // Constructing Game with no teamMode key at all must take the exact same
  // path as an explicit teamMode: 'solo' -- zero extra rng draws, so spawn
  // candidates come out byte-identical. duos, which does shuffle, must NOT.
  const opts = { preset: MAP_PRESETS.small, seed: 55, playerName: 'You', playerColor: '#e0484f', difficulty: 'normal' };
  const implicitSolo = new Game({ ...opts });
  const explicitSolo = new Game({ ...opts, teamMode: 'solo' });
  const duos = new Game({ ...opts, teamMode: 'duos' });
  const sameAsExplicit = implicitSolo.spawnCandidates.length === explicitSolo.spawnCandidates.length
    && implicitSolo.spawnCandidates.every((t, i) => t === explicitSolo.spawnCandidates[i]);
  const sameAsDuos = implicitSolo.spawnCandidates.length === duos.spawnCandidates.length
    && implicitSolo.spawnCandidates.every((t, i) => t === duos.spawnCandidates[i]);
  check('omitting teamMode produces identical spawnCandidates to explicit solo (zero extra rng draws)', sameAsExplicit);
  check('...but different spawnCandidates from duos (which does draw from rng)', !sameAsDuos);
}

// -------------------------------------------------------------- isFriendly ---
{
  const game = blankGame();
  const [human, ai1, ai2] = game.players;
  rect(game, 10, 10, 12, 12, human.id);
  rect(game, 20, 20, 22, 22, ai1.id);
  rect(game, 30, 30, 32, 32, ai2.id);
  human.teamId = 0;
  ai1.teamId = 0; // teammate of human
  ai2.teamId = 1; // stranger

  check('isFriendly: same player is friendly with itself', game.isFriendly(human.id, human.id));
  check('isFriendly: teammates are friendly', game.isFriendly(human.id, ai1.id));
  check('isFriendly: strangers are not friendly', !game.isFriendly(human.id, ai2.id));
  check('isFriendly: NEUTRAL (-1) is never friendly, either side', !game.isFriendly(human.id, -1) && !game.isFriendly(-1, human.id));

  game.diplomacy.propose(ai2.id, human.id);
  game.diplomacy.accept(game.diplomacy.pendingBetween(ai2.id, human.id));
  check('isFriendly: a real alliance is friendly too', game.isFriendly(human.id, ai2.id));

  // Two different tribes must never compare as friendly -- teamId=null for
  // both would collide if isFriendly ever used -1 instead of null.
  const tribeA = game.players.find((p, i) => i > 2 && !CAST.includes(p.id));
  const tribeB = game.players.find((p, i) => i > 3 && p !== tribeA && !CAST.includes(p.id));
  tribeA.isTribe = true;
  tribeA.teamId = null;
  tribeB.isTribe = true;
  tribeB.teamId = null;
  check('isFriendly: two different tribes are NOT friendly (both teamId===null)', !game.isFriendly(tribeA.id, tribeB.id));
}

// ---------------------------------------------------------- attack legality ---
{
  const game = blankGame();
  const [human, ai1] = game.players;
  rect(game, 10, 10, 14, 14, human.id);
  rect(game, 15, 10, 19, 14, ai1.id); // bordering
  human.teamId = 0;
  ai1.teamId = 0;
  human.troops = 10000;

  const result = game.launchAttack(human, ai1.id, 1000);
  check('launchAttack refuses a teammate target', result === null);
  check('...and no attack was created', game.attacks.length === 0);
}

// -------------------------------------------------------------------- annex ---
{
  const game = blankGame();
  const [human, ai1, victim] = game.players;
  rect(game, 10, 10, 20, 20, ai1.id);
  rect(game, 14, 14, 16, 16, victim.id); // landlocked, fully ringed by ai1
  ai1.teamId = 0;
  victim.teamId = 0; // teammates -- must never be annexed
  for (let i = 0; i < ENCLOSURE_SCAN_TICKS * 2 + 2; i++) game.tick();
  check('a teammate fully surrounded is NOT annexed', victim.alive && victim.tiles.size > 0, `alive=${victim.alive} tiles=${victim.tiles.size}`);
}

// -------------------------------------------------------- boats and missiles ---
{
  // The ally case is the one that fails against pre-teams code -- that's
  // the point (see the boats/missiles bug-fix commit). Boat targets are
  // the top-left CORNER of each rect, not its center -- findWaterPath BFSs
  // out from water touching the target tile, so a landlocked center tile
  // (with no ocean-adjacent neighbour at all) would return null for "no
  // path" regardless of friendliness, masking the actual check.
  const game = blankGame();
  const [attacker, teammate, ally] = game.players;
  rect(game, 10, 10, 12, 12, attacker.id);
  attacker.gold = 100000;
  game.build(attacker, 'silo', game.map.idx(11, 11));
  rect(game, 60, 60, 62, 62, teammate.id);
  attacker.teamId = 0;
  teammate.teamId = 0;
  rect(game, 70, 70, 72, 72, ally.id);
  game.diplomacy.propose(attacker.id, ally.id);
  game.diplomacy.accept(game.diplomacy.pendingBetween(attacker.id, ally.id));

  attacker.troops = 10000;
  const boatVsTeammate = game.launchBoat(attacker, game.map.idx(60, 60), 5000);
  check('launchBoat refuses a teammate target', boatVsTeammate.ok === false, JSON.stringify(boatVsTeammate));
  const boatVsAlly = game.launchBoat(attacker, game.map.idx(70, 70), 5000);
  check('launchBoat refuses a REAL ALLY target too (the pre-existing bug this feature fixed)', boatVsAlly.ok === false, JSON.stringify(boatVsAlly));

  const goldBefore = attacker.gold;
  const nukeVsTeammate = game.launchNuke(attacker, game.map.idx(61, 61));
  check('launchNuke refuses a teammate target', nukeVsTeammate.ok === false);
  const nukeVsAlly = game.launchNuke(attacker, game.map.idx(71, 71));
  check('launchNuke refuses a REAL ALLY target too', nukeVsAlly.ok === false);
  check('a refused nuke deducts no gold', attacker.gold === goldBefore, `${goldBefore} -> ${attacker.gold}`);

  const selfNuke = game.launchNuke(attacker, game.map.idx(11, 11));
  check('nuking your OWN ground is still legal (unchanged)', selfNuke.ok === true, JSON.stringify(selfNuke));
}

// -------------------------------------------------- boat stands down mid-voyage ---
{
  const game = blankGame();
  const [attacker, rival] = game.players;
  rect(game, 10, 10, 12, 12, attacker.id);
  attacker.troops = 10000;
  rect(game, 60, 60, 62, 62, rival.id);

  const targetTile = game.map.idx(60, 60); // the rect's corner -- ocean-adjacent
  const launch = game.launchBoat(attacker, targetTile, 5000);
  check('boat launched at a genuine rival (test setup)', launch.ok === true, JSON.stringify(launch));

  // A pact forms mid-voyage -- the boat must stand down at landfall rather
  // than seize the now-friendly tile.
  attacker.teamId = 0;
  rival.teamId = 0;
  const troopsBefore = attacker.troops;
  const boat = game.boats[0];
  boat.progress = boat.path.length - 1; // arrive on the next tick
  game.tick();
  check('a boat that became friendly mid-voyage does not seize the tile', game.owner[targetTile] === rival.id);
  check('...and its troops came back rather than vanishing', attacker.troops > troopsBefore, `${troopsBefore} -> ${attacker.troops}`);
}

// ------------------------------------------------------------------ AI targeting ---
{
  const game = blankGame();
  const [p0, bot, teammate] = game.players;
  rect(game, 10, 10, 20, 20, bot.id);
  rect(game, 21, 10, 25, 20, teammate.id); // bot's ONLY border is its own teammate
  bot.teamId = 0;
  teammate.teamId = 0;
  bot.troops = 50000;
  bot.gold = 100000;
  teammate.troops = 100;

  const ai = new AiController(bot, () => 0.001, DIFFICULTIES.normal); // most favorable roll for every branch
  ai.cooldown = 0;
  ai.update(game);
  check('an AI whose only neighbour is a teammate launches no attack against it', game.attacks.length === 0, `attacks=${game.attacks.length}`);
}

// ---------------------------------------------------------------------- victory ---
{
  // A duo hand-painted to 30% + 32% (62% combined, over VICTORY_LAND_SHARE)
  // wins as a team; the identical board in solo mode does NOT -- the
  // sharpest single proof the team check is additive, not a loosening.
  const buildBoard = (teamMode) => {
    const game = blankGame({ teamMode });
    const [, a, b] = game.players;
    const landCount = game.map.landCount;
    const totalTiles = Math.ceil(landCount * 0.31);
    const side = Math.ceil(Math.sqrt(totalTiles));
    rect(game, 30, 10, 30 + side, 10 + side, a.id);
    rect(game, 30, 10 + side + 5, 30 + side, 10 + side + 5 + side, b.id);
    if (teamMode !== 'solo') {
      a.teamId = 0;
      b.teamId = 0;
    }
    return { game, a, b };
  };

  const duo = buildBoard('duos');
  duo.game.tickCount = 9;
  duo.game.tick();
  const combinedShare = (duo.a.tiles.size + duo.b.tiles.size) / duo.game.map.landCount;
  check(`a duo with combined land share over ${VICTORY_LAND_SHARE} wins as a team`, duo.game.state === 'over' && duo.game.winningTeamId === 0, `state=${duo.game.state} winningTeamId=${duo.game.winningTeamId} combined=${combinedShare.toFixed(2)}`);
  check('the credited winner is whichever member holds more land', duo.game.winner === (duo.a.tiles.size >= duo.b.tiles.size ? duo.a : duo.b));

  const solo = buildBoard('solo');
  solo.game.tickCount = 9;
  solo.game.tick();
  check('the IDENTICAL board in solo mode does NOT win (neither player alone clears 60%)', solo.game.state === 'playing');

  // Last-team-standing requires tribes gone too -- as strict as the
  // existing single-player last-standing check.
  const g1 = blankGame({ teamMode: 'duos' });
  const [, killerA, killerB] = g1.players;
  // Real territory for both -- CAST excludes 1 and 2 from blankGame's
  // parking, precisely so tests can paint them by hand, but that also
  // means they start at zero tiles like the unparked human used to:
  // without real land, #checkEliminations would "eliminate" the very
  // team this test means to leave standing before the victory check ever
  // runs.
  rect(g1, 10, 10, 12, 12, killerA.id);
  rect(g1, 13, 10, 15, 12, killerB.id);
  killerA.teamId = 0;
  killerB.teamId = 0;
  // Every other player (including all tribes) is already dead in blankGame
  // except the parked filler nations/tribes -- kill those too.
  for (const p of g1.players) {
    if (p === killerA || p === killerB) continue;
    p.alive = false;
  }
  g1.tickCount = 9;
  g1.tick();
  check('last team standing wins once every tribe is gone too', g1.state === 'over' && g1.winningTeamId === 0, `state=${g1.state}`);

  const g2 = blankGame({ teamMode: 'duos' });
  const [, killerA2, killerB2] = g2.players;
  rect(g2, 10, 10, 12, 12, killerA2.id);
  rect(g2, 13, 10, 15, 12, killerB2.id);
  killerA2.teamId = 0;
  killerB2.teamId = 0;
  let survivingTribe = null;
  for (const p of g2.players) {
    if (p === killerA2 || p === killerB2) continue;
    if (p.isTribe && !survivingTribe) { survivingTribe = p; continue; } // leave exactly one tribe alive
    p.alive = false;
  }
  rect(g2, 100, 100, 100, 100, survivingTribe.id); // needs real land too, same reasoning
  g2.tickCount = 9;
  g2.tick();
  check('...but a single surviving tribe blocks it, matching the solo check\'s strictness', g2.state === 'playing');
}

// -------------------------------------------------------------- spawn clustering ---
{
  const samples = [];
  for (const seed of [42, 7, 123, 555]) {
    for (const preset of [MAP_PRESETS.small, MAP_PRESETS.medium]) {
      for (const teamMode of ['duos', 'trios']) {
        const game = new Game({ preset, seed, playerName: 'You', playerColor: '#e0484f', difficulty: 'normal', teamMode });
        const humanTile = game.spawnCandidates[Math.floor(game.spawnCandidates.length / 2)];
        game.beginMatch(humanTile);
        // #updateCentroid only runs every 10 ticks (tickCount % 10 === 0),
        // so this needs at least one full interval to give every nation a
        // real centroid at all -- 5 ticks would never reach it.
        for (let i = 0; i < 12; i++) game.tick();

        const byTeam = new Map();
        for (const p of game.players) {
          if (p.isTribe || !p.alive || p.tiles.size === 0) continue;
          const list = byTeam.get(p.teamId);
          if (list) list.push(p);
          else byTeam.set(p.teamId, [p]);
        }
        const centroids = [...byTeam.values()].filter((m) => m.length > 1).map((m) => m.map((p) => p.centroid));
        for (const team of centroids) {
          for (let i = 0; i < team.length; i++) {
            for (let j = i + 1; j < team.length; j++) {
              samples.push({ same: true, d: Math.hypot(team[i].x - team[j].x, team[i].y - team[j].y) });
            }
          }
        }
        const teamList = [...byTeam.values()].filter((m) => m.length > 0);
        for (let a = 0; a < teamList.length; a++) {
          for (let b = a + 1; b < teamList.length; b++) {
            const ca = teamList[a][0].centroid;
            const cb = teamList[b][0].centroid;
            samples.push({ same: false, d: Math.hypot(ca.x - cb.x, ca.y - cb.y) });
          }
        }
      }
    }
  }
  const same = samples.filter((s) => s.same).map((s) => s.d);
  const cross = samples.filter((s) => !s.same).map((s) => s.d);
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const sameMean = mean(same);
  const crossMean = mean(cross);
  console.log(`  spawn clustering: mean same-team distance ${sameMean.toFixed(1)}, mean cross-team distance ${crossMean.toFixed(1)} (n=${same.length}/${cross.length})`);
  check('teammates spawn meaningfully closer together than different teams', sameMean < crossMean * 0.6, `same=${sameMean.toFixed(1)} cross=${crossMean.toFixed(1)}`);

  // Solo-mode identity check: beginMatch with vs. without an explicit
  // teamMode: 'solo' must produce the identical owner array.
  const optsA = { preset: MAP_PRESETS.small, seed: 42, playerName: 'You', playerColor: '#e0484f', difficulty: 'normal' };
  const gA = new Game({ ...optsA });
  const gB = new Game({ ...optsA, teamMode: 'solo' });
  gA.beginMatch(gA.spawnCandidates[0]);
  gB.beginMatch(gB.spawnCandidates[0]);
  let ownerIdentical = gA.owner.length === gB.owner.length;
  if (ownerIdentical) for (let i = 0; i < gA.owner.length; i++) if (gA.owner[i] !== gB.owner[i]) { ownerIdentical = false; break; }
  check('beginMatch produces an identical owner array with or without an explicit teamMode: "solo"', ownerIdentical);
}

// =============================================================================
// Part B -- browser
// =============================================================================
console.log('\n▶ Part B: team games in a real browser\n');

const BASE = process.env.BASE || 'http://localhost:8123';
const browser = await chromium.launch({ headless: true });

async function startMatch(page, { seed = 4242, teamChoice = null } = {}) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#startscreen:not([hidden])');
  if (teamChoice) await page.click(`#team-picker .choice:nth-child(${teamChoice})`);
  await page.fill('#seed-input', String(seed));
  await page.click('#size-picker .choice:nth-child(1)'); // small
  await page.click('#btn-start');
  await page.waitForFunction(() => window.OceanFront?.game != null);
  const spawnTile = await page.evaluate(() => window.OceanFront.game.spawnCandidates[0]);
  const p = await page.evaluate((t) => {
    const { renderer: r, game: g } = window.OceanFront;
    const pt = r.worldToScreen(g.map.xOf(t) + 0.5, g.map.yOf(t) + 0.5);
    return { x: Math.round(pt.x), y: Math.round(pt.y) };
  }, spawnTile);
  await page.mouse.click(p.x, p.y);
  await page.waitForSelector('#topbar', { state: 'visible', timeout: 10000 });
}

// ---------------------------------------------------------- start-screen picker ---
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#startscreen:not([hidden])');
  const labels = await page.$$eval('#team-picker .choice', (els) => els.map((e) => e.textContent));
  check('team picker renders 4 options (Solo/Duos/Trios/Quads)', labels.length === 4, JSON.stringify(labels));
  const activeLabel = await page.evaluate(() => document.querySelector('#team-picker .choice.is-active')?.textContent || '');
  check('Solo is active by default', activeLabel.includes('Solo'), activeLabel);

  await page.click('#team-picker .choice:nth-child(2)'); // Duos
  await page.click('#btn-start');
  await page.waitForFunction(() => window.OceanFront?.game != null);
  await page.waitForTimeout(200);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('oceanfront.settings') || '{}'));
  check('picking Duos persists to localStorage', stored.teamMode === 'duos', `teamMode=${stored.teamMode}`);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#startscreen:not([hidden])');
  const restoredActive = await page.evaluate(() => document.querySelector('#team-picker .choice.is-active')?.textContent || '');
  check('Duos restores as active after reload', restoredActive.includes('Duos'), restoredActive);

  check('no page errors on the start screen', pageErrors.length === 0, pageErrors.join('; '));
  await page.close();
}

// ---------------------------------------------------------- a live duos match ---
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  await startMatch(page, { seed: 4242, teamChoice: 2 }); // Duos

  const teamSize = await page.evaluate(() => window.OceanFront.game.teamSize);
  check('game.teamSize === 2 in a duos match', teamSize === 2, `teamSize=${teamSize}`);

  const teammateId = await page.evaluate(() => {
    const g = window.OceanFront.game;
    return g.teamMembers(g.human.teamId).find((m) => m.id !== g.human.id)?.id;
  });
  check('the human has a teammate', teammateId !== undefined);

  await page.waitForTimeout(400);
  await page.evaluate(() => window.OceanFront.ui.refreshHud(true));
  const lb = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#leaderboard .lb-row')];
    const row = rows.find((r) => r.classList.contains('is-teammate'));
    return row ? { found: true, btnHidden: row.querySelector('.lb-btn').hidden, teamShown: !row.querySelector('.lb-team').classList.contains('is-empty') } : { found: false };
  });
  check("a leaderboard row is marked is-teammate (the human's teammate is on-screen)", lb.found, JSON.stringify(lb));
  if (lb.found) {
    check("the teammate's diplomacy button is hidden", lb.btnHidden === true);
    check('a team letter is shown on the teammate row', lb.teamShown === true);
  }

  // Attack-click guard: clicking a teammate's territory must launch nothing
  // from the human specifically (the live match's own AI churns
  // game.attacks constantly, so this checks attacksBy(human.id), not the
  // raw global count).
  const teammateTile = await page.evaluate((tid) => {
    const g = window.OceanFront.game;
    for (let i = 0; i < g.owner.length; i++) if (g.owner[i] === tid) return i;
    return -1;
  }, teammateId);
  if (teammateTile >= 0) {
    const pt = await page.evaluate((t) => {
      const { renderer: r, game: g } = window.OceanFront;
      const p = r.worldToScreen(g.map.xOf(t) + 0.5, g.map.yOf(t) + 0.5);
      return { x: Math.round(p.x), y: Math.round(p.y) };
    }, teammateTile);
    const before = await page.evaluate(() => window.OceanFront.game.attacksBy(window.OceanFront.game.human.id).length);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => window.OceanFront.game.attacksBy(window.OceanFront.game.human.id).length);
    const toast = await page.evaluate(() => document.getElementById('toast').textContent);
    check('clicking a teammate tile launches no attack from the human', before === after, `${before} -> ${after}`);
    check('the toast mentions the team', toast.toLowerCase().includes('team'), toast);
  } else {
    console.log('  (teammate has no visible territory yet -- skipping click-guard check)');
  }

  const renderOk = await page.evaluate(() => {
    try {
      window.OceanFront.renderer.rebuildLayer();
      return true;
    } catch (e) {
      return e.message;
    }
  });
  check('rebuildLayer() runs with no error against real team data', renderOk === true, String(renderOk));

  check('no page errors during the live duos match', pageErrors.length === 0, pageErrors.join('; '));
  await page.close();
}

// -------------------------------------------------------- rendering: no border ---
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await startMatch(page, { seed: 777, teamChoice: 2 }); // Duos
  await page.click('.speed-btn[data-speed="3"]');
  await page.waitForTimeout(6000); // let real territory grow into contact

  const result = await page.evaluate(() => {
    const { game, renderer } = window.OceanFront;
    const { width, height } = game.map;
    const owner = game.owner;
    const teamOf = (id) => (id < 0 ? null : game.teamKeyOf(id));

    function neighbors(i) {
      const x = i % width, y = Math.floor(i / width);
      const list = [];
      if (x > 0) list.push(i - 1);
      if (x < width - 1) list.push(i + 1);
      if (y > 0) list.push(i - width);
      if (y < height - 1) list.push(i + width);
      return list;
    }
    function isRawBorder(i, o) {
      for (const j of neighbors(i)) if (owner[j] !== o) return true;
      return false;
    }

    let sameTeamBorder = -1;
    let crossBorder = -1;
    for (let i = 0; i < owner.length; i++) {
      const o = owner[i];
      if (o < 0) continue;
      let rawBorder = false;
      let allDiffSameTeam = true;
      let anyDiffTeam = false;
      for (const j of neighbors(i)) {
        const oj = owner[j];
        if (oj === o) continue;
        rawBorder = true;
        const differentTeam = oj < 0 || teamOf(oj) !== teamOf(o);
        if (differentTeam) { allDiffSameTeam = false; anyDiffTeam = true; }
      }
      if (rawBorder && allDiffSameTeam && sameTeamBorder === -1) sameTeamBorder = i;
      if (rawBorder && anyDiffTeam && crossBorder === -1) crossBorder = i;
      if (sameTeamBorder !== -1 && crossBorder !== -1) break;
    }
    if (sameTeamBorder === -1) return { ok: false, reason: 'no same-team border tile found yet (teams may not have grown into contact)' };

    const interiorOf = (ownerId) => {
      for (const t of game.players[ownerId].tiles) if (!isRawBorder(t, ownerId)) return t;
      return -1;
    };
    const sameTeamInterior = interiorOf(owner[sameTeamBorder]);
    const crossInterior = crossBorder >= 0 ? interiorOf(owner[crossBorder]) : -1;

    const px = (i) => {
      const x = i % width, y = Math.floor(i / width);
      return Array.from(renderer.layerCtx.getImageData(x, y, 1, 1).data).slice(0, 3);
    };
    return {
      ok: true,
      sameTeamBorderPx: px(sameTeamBorder),
      sameTeamInteriorPx: sameTeamInterior >= 0 ? px(sameTeamInterior) : null,
      crossBorderPx: crossBorder >= 0 ? px(crossBorder) : null,
      crossInteriorPx: crossInterior >= 0 ? px(crossInterior) : null,
    };
  });

  if (!result.ok) {
    console.log(`  ! ${result.reason} -- skipping the pixel comparison`);
  } else {
    const close = (a, b, tol = 40) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= tol);
    check(
      'a tile whose only raw-border neighbours are a TEAMMATE renders as interior fill (no border stroke)',
      close(result.sameTeamBorderPx, result.sameTeamInteriorPx),
      `border=${result.sameTeamBorderPx} interior=${result.sameTeamInteriorPx}`
    );
    if (result.crossBorderPx && result.crossInteriorPx) {
      check(
        'a genuine cross-team border tile still renders visibly differently from its own interior',
        !close(result.crossBorderPx, result.crossInteriorPx, 8),
        `border=${result.crossBorderPx} interior=${result.crossInteriorPx}`
      );
    }
  }
  await page.close();
}

// ------------------------------------------------------------------ end screen ---
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await startMatch(page, { seed: 1234, teamChoice: 2 }); // Duos

  // The verified browsertest.mjs "force a win" technique, adapted to
  // credit a TEAMMATE rather than the human: reassign every RIVAL's tiles
  // to the human's teammate -- deliberately leaving the human's own
  // homeland untouched, unlike browsertest.mjs's original (which gives
  // everything to the human and so has nothing to preserve). Zeroing the
  // human's own tiles here would self-eliminate them in the very same
  // #checkEliminations pass that's about to credit the team's win --
  // #checkEliminations runs first and #endMatch's state==='over' guard
  // means that elimination would pre-empt the team victory it's racing
  // against, purely a test-setup artifact rather than anything a real
  // match could actually produce (a human's own last tile falling and a
  // teammate's combined share crossing the line in the exact same
  // 10-tick window, atomically, is not how gradual combat works).
  await page.evaluate(() => {
    const g = window.OceanFront.game;
    const human = g.human;
    const teammate = g.teamMembers(human.teamId).find((m) => m.id !== human.id);
    for (const p of g.players) {
      if (p.id === teammate.id || p.id === human.id) continue;
      for (const t of [...p.tiles]) g.setOwner(t, teammate.id);
    }
    g.attacks = g.attacks.filter((a) => a.attackerId === teammate.id || a.attackerId === human.id);
    g.boats = g.boats.filter((b) => b.ownerId === teammate.id || b.ownerId === human.id);
  });
  await page.waitForTimeout(1500);

  const endVisible = await page.isVisible('#endscreen');
  check('the end screen appears once a teammate holds everything', endVisible);
  if (endVisible) {
    const title = (await page.textContent('#end-title')).trim();
    const body = (await page.textContent('#end-body')).trim();
    console.log(`  end screen: "${title}" / "${body}"`);
    check('title reads Victory (the human\'s team won, even though the human personally did not)', title.includes('Victory'), title);
    check('body text credits the team, not just the human personally', body.toLowerCase().includes('team'), body);
  }
  await page.close();
}

await browser.close();

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
