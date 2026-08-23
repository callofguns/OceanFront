// Covers src/sound.js and its wiring into game.js/diplomacy.js.
//
// Two halves, on purpose:
//  - Part A is headless (no browser, no server) -- it proves the actual
//    game.js/diplomacy.js hook sites call Game#signal() with the right
//    event type and data when their *real* trigger condition fires. Same
//    hand-painted-board technique as encirclement-test.mjs (a blank game,
//    every player's AI disabled, terrain/tiles/buildings painted by hand),
//    which makes it fully deterministic -- no ticking bot ever races a
//    check here.
//  - Part B needs a real browser: SoundBoard's own event->sound gating
//    table (driven directly through the public Game#signal(), so it does
//    not depend on Part A's mechanics at all), the Web Audio behaviour a
//    headless page genuinely supports (Playwright's --mute-audio silences
//    the output device only -- AudioContext/OfflineAudioContext both work
//    for real): no context before a gesture, unlock() on Start, the music
//    lifecycle, the volume taper curve, mute as a genuine play() no-op,
//    the minimum re-trigger gap, voice-cap eviction, sound distinctness
//    via renderOffline(), and the pause-menu persistence regression.
// Run the dev server first (`npm start`), then this script.

import { Game, NEUTRAL } from '../../src/game.js';
import {
  MAP_PRESETS, PLAINS, OCEAN, ENCLOSURE_SCAN_TICKS,
  SFX_GAP_MS, MAX_SFX_VOICES, MUSIC_CHORDS, MUSIC_FADE_IN, MUSIC_DUCK_TO,
  SFX_VOLUME_DEFAULT, MUSIC_VOLUME_DEFAULT,
} from '../../src/config.js';
import { chromium } from './lib/browser.mjs';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}

// =============================================================================
// Part A -- the real hook sites, headless
// =============================================================================
console.log('\n▶ Part A: game.js / diplomacy.js call Game#signal() correctly (headless)\n');

/** Everyone except ids 1 and 2 gets parked on an isolated one-tile island,
 *  exactly like encirclement-test.mjs's own CAST convention -- crucially
 *  including the human (id 0): a human with zero tiles is "eliminated" by
 *  the very first #checkEliminations() tick, which calls #endMatch(null)
 *  and flips game.state to 'over', silently no-op'ing every tick after it
 *  (tick() bails out unless state is still 'playing'). Tests that want the
 *  human to act (as a builder, killer, etc.) still can -- painting real
 *  territory with rect() below adds to its one parked tile regardless. */
const CAST = [1, 2];

function blankGame() {
  const game = new Game({
    preset: MAP_PRESETS.small, seed: 1,
    playerName: 'You', playerColor: '#e0484f', difficulty: 'normal',
  });
  game.map.terrain.fill(OCEAN);
  game.owner.fill(NEUTRAL);
  for (const p of game.players) {
    p.tiles.clear();
    p.troops = 0;
    p.gold = 0;
    p.alive = true;
    p.lastConquerorId = -1;
    p.ai = null; // no bot or tribe decisions -- fully deterministic ticks
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

function withRecorder(game) {
  const events = [];
  game.onEvent = (type, data) => events.push({ type, data });
  return events;
}

// --------------------------------------------------------------- build() ---
{
  const game = blankGame();
  const events = withRecorder(game);
  const human = game.players[0];
  rect(game, 10, 10, 14, 14, human.id);
  human.gold = 100000;
  const result = game.build(human, 'city', game.map.idx(12, 12));
  check('build() succeeded (test setup sane)', result.ok, JSON.stringify(result));
  check("exactly one 'build' event fired", events.filter((e) => e.type === 'build').length === 1);
  const evt = events.find((e) => e.type === 'build');
  check("'build' event carries the right key", evt?.data.key === 'city', String(evt?.data.key));
  check("'build' event carries the right playerId", evt?.data.playerId === human.id, String(evt?.data.playerId));
}

// ---------------------------------------------------------- launchNuke() ---
{
  const game = blankGame();
  const events = withRecorder(game);
  const ai = game.players[1];
  rect(game, 30, 30, 34, 34, ai.id);
  ai.gold = 100000;
  const built = game.build(ai, 'silo', game.map.idx(32, 32));
  check('silo built (test setup)', built.ok, JSON.stringify(built));
  const launched = game.launchNuke(ai, game.map.idx(80, 80));
  check('launchNuke() succeeded (test setup)', launched.ok, JSON.stringify(launched));
  const evt = events.find((e) => e.type === 'nuke-launch');
  check("'nuke-launch' fires for an AI launch too -- it is a global fact, not gated here (gating lives in sound.js)", evt?.data.playerId === ai.id, String(evt?.data.playerId));
}

// ----------------------------------------------------- SAM intercept ---
{
  const game = blankGame();
  const events = withRecorder(game);
  const attacker = game.players[0];
  const defender = game.players[1];
  rect(game, 10, 10, 14, 14, attacker.id);
  attacker.gold = 100000;
  game.build(attacker, 'silo', game.map.idx(12, 12));
  const samTile = game.map.idx(60, 60);
  defender.buildings.push({ key: 'sam', tile: samTile, ownerId: defender.id, cooldown: 0 });
  defender.buildingCounts.sam = 1;
  // rng() < SAM_ACCURACY is guaranteed true from 0 -- the deterministic way
  // to force an interception without depending on the real accuracy roll.
  game.rng = () => 0;
  game.launchNuke(attacker, samTile);
  for (let i = 0; i < 200 && !events.some((e) => e.type === 'intercept') && game.missiles.length > 0; i++) {
    game.tick();
  }
  const evt = events.find((e) => e.type === 'intercept');
  check("'intercept' fired once the missile entered SAM range", !!evt);
  check("'intercept' event carries the defending playerId", evt?.data.playerId === defender.id, String(evt?.data.playerId));
}

// --------------------------------------------------------------- nuke-hit ---
{
  const game = blankGame();
  const events = withRecorder(game);
  const attacker = game.players[0];
  rect(game, 10, 10, 14, 14, attacker.id);
  attacker.gold = 100000;
  game.build(attacker, 'silo', game.map.idx(12, 12));
  // No SAMs exist anywhere in this board, so the warhead is guaranteed to
  // reach its target rather than being intercepted en route.
  game.launchNuke(attacker, game.map.idx(100, 100));
  for (let i = 0; i < 400 && game.missiles.length > 0; i++) game.tick();
  check("'nuke-hit' fired on the unconditional detonation, even over empty ground", events.some((e) => e.type === 'nuke-hit'));
}

// ------------------------------------------------------------ eliminated ---
{
  // A human-caused kill fires with the real killerId.
  const game = blankGame();
  const events = withRecorder(game);
  const victim = game.players[2];
  const killer = game.players[0];
  victim.lastConquerorId = killer.id;
  game.tickCount = 9; // tick() increments first -- lands exactly on the %10===0 elimination check
  game.tick();
  check("'eliminated' fires with the real killerId for a human-caused kill", events.some((e) => e.type === 'eliminated' && e.data.killerId === killer.id && e.data.victimId === victim.id));
}
{
  // An AI-caused kill still reports a real killerId -- Game only emits the
  // fact; SoundBoard is what declines to play a sound for it.
  const game = blankGame();
  const events = withRecorder(game);
  const victim = game.players[2];
  const killer = game.players[1];
  victim.lastConquerorId = killer.id;
  game.tickCount = 9;
  game.tick();
  check("'eliminated' fires with the real killerId for an AI-caused kill too (a fact, not a gated decision)", events.some((e) => e.type === 'eliminated' && e.data.killerId === killer.id));
}
{
  // A nuke-kill (land reverted to NEUTRAL, nobody stood there to conquer
  // it) reports killerId -1 -- never a real player id.
  const game = blankGame();
  const events = withRecorder(game);
  const victim = game.players[2];
  game.tickCount = 9;
  game.tick();
  check("'eliminated' reports killerId -1 for a nuke-kill (no conqueror)", events.some((e) => e.type === 'eliminated' && e.data.killerId === -1 && e.data.victimId === victim.id));
}

// ---------------------------------------------------------------- annexed ---
{
  const game = blankGame();
  const events = withRecorder(game);
  const q = game.players[1];
  const victim = game.players[2];
  rect(game, 10, 10, 20, 20, q.id);
  rect(game, 14, 14, 16, 16, victim.id); // landlocked, fully ringed by q -- the exact shape encirclement-test.mjs uses
  for (let i = 0; i < ENCLOSURE_SCAN_TICKS * 2 + 2; i++) game.tick();
  check('the encircled victim was actually annexed (test setup)', !victim.alive);
  check("'annexed' fired with the real conqueror/victim ids", events.some((e) => e.type === 'annexed' && e.data.conquerorId === q.id && e.data.victimId === victim.id));
}

// ------------------------------------------------------------- diplomacy ---
{
  const game = blankGame();
  const events = withRecorder(game);
  const human = game.players[0];
  const ai1 = game.players[1];
  const ai2 = game.players[2];

  game.diplomacy.propose(ai1.id, human.id);
  check("propose() to the human fires 'alliance-offer'", events.some((e) => e.type === 'alliance-offer' && e.data.fromId === ai1.id && e.data.toId === human.id));

  events.length = 0;
  game.diplomacy.propose(ai1.id, ai2.id);
  check("propose() between two AIs does NOT fire 'alliance-offer' -- gated at the source (diplomacy.js's own if (to.isHuman)), since AI-to-AI offers fire constantly", !events.some((e) => e.type === 'alliance-offer'));

  events.length = 0;
  // pendingBetween(), not offersTo(...)[0] -- the AI-to-AI offer above is
  // also still sitting in offersTo(ai2.id) further down, and [0] would
  // silently grab the wrong one.
  game.diplomacy.accept(game.diplomacy.pendingBetween(ai1.id, human.id));
  check("accept() fires 'alliance-formed' with both ids", events.some((e) => e.type === 'alliance-formed' && ((e.data.aId === ai1.id && e.data.bId === human.id) || (e.data.aId === human.id && e.data.bId === ai1.id))));

  game.diplomacy.propose(human.id, ai2.id);
  game.diplomacy.accept(game.diplomacy.pendingBetween(human.id, ai2.id));

  events.length = 0;
  game.diplomacy.breakAlliance(human.id, ai1.id, { penalize: true });
  check("breakAlliance({penalize:true}) fires 'betrayed'", events.some((e) => e.type === 'betrayed' && e.data.initiatorId === human.id && e.data.otherId === ai1.id));
  check("breakAlliance({penalize:true}) does NOT also fire 'alliance-broken'", !events.some((e) => e.type === 'alliance-broken'));

  events.length = 0;
  game.diplomacy.breakAlliance(human.id, ai2.id, { penalize: false });
  check("breakAlliance({penalize:false}) fires 'alliance-broken'", events.some((e) => e.type === 'alliance-broken' && e.data.initiatorId === human.id && e.data.otherId === ai2.id));
  check("breakAlliance({penalize:false}) does NOT also fire 'betrayed'", !events.some((e) => e.type === 'betrayed'));
}

// =============================================================================
// Part B -- SoundBoard itself, in a real browser
// =============================================================================
console.log('\n▶ Part B: SoundBoard in a real browser\n');

const BASE = process.env.BASE || 'http://localhost:8123';
const browser = await chromium.launch({ headless: true });

async function startMatch(page, { seed = 4242 } = {}) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#startscreen:not([hidden])');
  await page.fill('#seed-input', String(seed));
  await page.click('#size-picker .choice:nth-child(1)'); // small -- fast to spawn into
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

// -------------------------------------------------- no context before a gesture; unlock() on Start ---
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#startscreen:not([hidden])');
  const before = await page.evaluate(() => window.OceanFront.ui.sound.ctx === null);
  check('no AudioContext exists before any user gesture', before);

  await page.click('#btn-start');
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => ({ hasCtx: !!window.OceanFront.ui.sound.ctx, running: window.OceanFront.ui.sound.running }));
  check('unlock() built a real AudioContext synchronously from #btn-start', after.hasCtx);
  check('the context is running after unlock()', after.running);

  check('no page errors while unlocking audio', pageErrors.length === 0, pageErrors.join('; '));
  await page.close();
}

// -------------------------------------------------- the rest, sharing one live match ---
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  await startMatch(page);

  // --- music lifecycle ---
  const musicInfo = await page.evaluate(() => {
    const s = window.OceanFront.ui.sound;
    return { playing: s.musicPlaying, voices: s.musicVoiceCount, gain: s.musicGain.gain.value, target: Math.pow(s.musicVolume, 2) };
  });
  const expectedVoices = 2 /* drone */ + 1 /* lfo */ + MUSIC_CHORDS.i.length * 2 /* pad 0's chord, tri+sine per note */;
  check('music starts playing on attach()', musicInfo.playing);
  check(`music has real voices running (drone + lfo + the opening chord, >= ${expectedVoices})`, musicInfo.voices >= expectedVoices, `voices=${musicInfo.voices}`);
  check('music gain has not already reached its target -- still fading in', musicInfo.gain < musicInfo.target * 0.9, `gain=${musicInfo.gain} target=${musicInfo.target}`);

  await page.waitForTimeout((MUSIC_FADE_IN + 1.0) * 1000);
  const afterFade = await page.evaluate(() => window.OceanFront.ui.sound.musicGain.gain.value);
  check('music gain reaches its target once the fade-in window has passed', Math.abs(afterFade - musicInfo.target) < 0.03, `gain=${afterFade} target=${musicInfo.target}`);

  // --- volume taper curve: the one assertion that actually proves the
  // perceptual (squared) curve exists, not just that a slider moves a number ---
  await page.click('#btn-pause-menu');
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const el = document.querySelector('[data-volume="sfx"]');
    el.value = '50';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(100);
  const taper = await page.evaluate(() => ({ setting: window.OceanFront.ui.settings.sfxVolume, gain: window.OceanFront.ui.sound.sfxGain.gain.value }));
  check('a 50% slider position sets settings.sfxVolume to 0.5 (linear)', Math.abs(taper.setting - 0.5) < 0.01, `sfxVolume=${taper.setting}`);
  check('...but the actual gain lands at ~0.25, not 0.5 -- the squared audio-taper curve', Math.abs(taper.gain - 0.25) < 0.02, `gain=${taper.gain}`);

  // Restore full sfx volume for everything below.
  await page.evaluate((v) => window.OceanFront.ui.sound.setSfxVolume(v), SFX_VOLUME_DEFAULT);

  // --- mute is a real play() no-op, not just a flag ---
  await page.evaluate(() => window.OceanFront.ui.sound.resetCounts());
  await page.click('[data-mute]');
  await page.waitForTimeout(50);
  const mutedNow = await page.evaluate(() => window.OceanFront.ui.sound.muted);
  check('the mute button sets sound.muted', mutedNow);
  const beforePlay = await page.evaluate(() => window.OceanFront.ui.sound.playCountOf('click'));
  await page.evaluate(() => window.OceanFront.ui.sound.play('click'));
  const afterPlay = await page.evaluate(() => window.OceanFront.ui.sound.playCountOf('click'));
  check('play() is a real no-op while muted (play count does not move)', afterPlay === beforePlay, `${beforePlay} -> ${afterPlay}`);
  await page.click('[data-mute]'); // unmute for the rest of this part
  await page.waitForTimeout(50);
  check('the mute button unmutes on a second press', await page.evaluate(() => !window.OceanFront.ui.sound.muted));
  await page.click('#pause-resume');

  // --- the minimum re-trigger gap (generalizes OpenFrontIO's MIRV throttle) ---
  await page.evaluate(() => window.OceanFront.ui.sound.resetCounts());
  const gapResult = await page.evaluate(async (gapMs) => {
    const s = window.OceanFront.ui.sound;
    const first = s.play('click');
    const second = s.play('click'); // immediately after -- inside the gap
    await new Promise((r) => setTimeout(r, gapMs + 20));
    const third = s.play('click'); // past the gap
    return { first, second, third, count: s.playCountOf('click') };
  }, SFX_GAP_MS.click);
  check('the first play() succeeds', gapResult.first === true);
  check('a second play() inside the minimum gap is rejected (returns false)', gapResult.second === false);
  check('a play() past the gap succeeds again', gapResult.third === true);
  check('rejected plays never increment the play count', gapResult.count === 2, `count=${gapResult.count}`);

  // --- SoundBoard's own event->sound gating table, driven directly through
  // the public Game#signal() -- this is what actually decides which sound
  // plays for which player, in both directions. rateLimit off so back-to-
  // back cases in this table never collide with each other. ---
  await page.evaluate(() => {
    const s = window.OceanFront.ui.sound;
    s.rateLimit = false;
    s.setMuted(false);
  });
  const [me, ai1, ai2] = await page.evaluate(() => {
    const g = window.OceanFront.game;
    const bots = g.players.filter((p) => !p.isHuman);
    return [g.human.id, bots[0].id, bots[1].id];
  });

  const gatingCases = [
    { type: 'build', sound: 'build-city', yes: { key: 'city', playerId: me }, no: { key: 'city', playerId: ai1 } },
    { type: 'nuke-launch', sound: 'nuke-launch', yes: { playerId: ai1 } }, // global, no gating
    { type: 'nuke-hit', sound: 'nuke-hit', yes: {} }, // global
    { type: 'intercept', sound: 'intercept', yes: {} }, // global
    { type: 'eliminated', sound: 'conquest', yes: { killerId: me, victimId: 9 }, no: { killerId: ai1, victimId: 9 } },
    { type: 'annexed', sound: 'annex', yes: { conquerorId: me, victimId: 9 }, no: { conquerorId: ai1, victimId: 9 } },
    { type: 'alliance-offer', sound: 'alliance-offer', yes: { fromId: ai1, toId: me } }, // gated at the diplomacy.js source, not here
    { type: 'alliance-formed', sound: 'alliance-formed', yes: { aId: me, bId: ai1 }, no: { aId: ai1, bId: ai2 } },
    { type: 'alliance-broken', sound: 'alliance-broken', yes: { initiatorId: me, otherId: ai1 }, no: { initiatorId: ai1, otherId: ai2 } },
    { type: 'betrayed', sound: 'betrayed', yes: { initiatorId: me, otherId: ai1 }, no: { initiatorId: ai1, otherId: ai2 } },
  ];

  for (const c of gatingCases) {
    await page.evaluate(() => window.OceanFront.ui.sound.resetCounts());
    await page.evaluate(({ type, data }) => window.OceanFront.game.signal(type, data), { type: c.type, data: c.yes });
    const yesCount = await page.evaluate((s) => window.OceanFront.ui.sound.playCountOf(s), c.sound);
    check(`'${c.type}' involving the human plays '${c.sound}'`, yesCount === 1, `count=${yesCount}`);

    if (c.no) {
      await page.evaluate(() => window.OceanFront.ui.sound.resetCounts());
      await page.evaluate(({ type, data }) => window.OceanFront.game.signal(type, data), { type: c.type, data: c.no });
      const noCount = await page.evaluate((s) => window.OceanFront.ui.sound.playCountOf(s), c.sound);
      check(`'${c.type}' between two AIs does NOT play '${c.sound}' (an over-eager gate would fail this)`, noCount === 0, `count=${noCount}`);
    }
  }

  // A nuke-kill (killerId -1) must never read as a conquest either.
  await page.evaluate(() => window.OceanFront.ui.sound.resetCounts());
  await page.evaluate(() => window.OceanFront.game.signal('eliminated', { killerId: -1, victimId: 9 }));
  const nukeKillCount = await page.evaluate(() => window.OceanFront.ui.sound.playCountOf('conquest'));
  check("a nuke-kill (killerId -1) does not play 'conquest'", nukeKillCount === 0, `count=${nukeKillCount}`);

  // nuke-hit also ducks the music -- confirm the duck actually moves the gain.
  const preDuck = await page.evaluate(() => window.OceanFront.ui.sound.musicGain.gain.value);
  await page.evaluate(() => window.OceanFront.game.signal('nuke-hit', {}));
  await page.waitForTimeout(200);
  const duckedGain = await page.evaluate(() => window.OceanFront.ui.sound.musicGain.gain.value);
  check(`nuke-hit ducks the music gain down (target factor ${MUSIC_DUCK_TO})`, duckedGain < preDuck * 0.7, `${preDuck} -> ${duckedGain}`);

  // --- voice cap eviction: bursting well past MAX_SFX_VOICES must never throw ---
  const evictResult = await page.evaluate(async (max) => {
    const s = window.OceanFront.ui.sound;
    s.rateLimit = false;
    const names = ['click', 'build-city', 'build-port', 'build-defense', 'build-silo', 'build-sam', 'intercept', 'conquest', 'annex', 'alliance-offer'];
    try {
      for (let i = 0; i < max + 6; i++) s.play(names[i % names.length]);
      return { activeVoices: s.activeVoices, error: null };
    } catch (err) {
      return { activeVoices: s.activeVoices, error: err.message };
    }
  }, MAX_SFX_VOICES);
  check('bursting well past the voice cap never throws', evictResult.error === null, evictResult.error || '');
  check(`active voices stay at or under the cap (${MAX_SFX_VOICES})`, evictResult.activeVoices <= MAX_SFX_VOICES, `active=${evictResult.activeVoices}`);

  // --- sound distinctness via renderOffline(): the deterministic,
  // headless answer to "do these actually sound different from each
  // other" -- every recipe renders a real, non-silent, cleanly-decaying
  // signal, no two are numerically identical, and a few pairs whose
  // relative intensity is part of the design (see src/sound.js's own
  // comments) actually land the right way round. ---
  const allNames = ['click', 'build-city', 'build-port', 'build-defense', 'build-silo', 'build-sam',
    'nuke-launch', 'nuke-hit', 'intercept', 'conquest', 'annex', 'alliance-offer', 'alliance-formed',
    'alliance-broken', 'betrayed', 'victory', 'defeat'];
  const stats = await page.evaluate(async (names) => {
    const s = window.OceanFront.ui.sound;
    const out = {};
    for (const n of names) out[n] = await s.renderOffline(n, 2.5);
    return out;
  }, allNames);

  for (const name of allNames) {
    const s = stats[name];
    check(`${name}: renderOffline() produced a real, audible peak`, s && s.peak > 0.02, `peak=${s?.peak}`);
    check(`${name}: decays to silence well before the render ends (no infinite tail)`, s && s.silentTail === true);
  }

  let anyDuplicate = false;
  for (let i = 0; i < allNames.length && !anyDuplicate; i++) {
    for (let j = i + 1; j < allNames.length; j++) {
      const a = stats[allNames[i]];
      const b = stats[allNames[j]];
      if (a.peak === b.peak && a.rms === b.rms && a.brightness === b.brightness) {
        anyDuplicate = true;
        console.log(`    ! ${allNames[i]} and ${allNames[j]} rendered identically`);
        break;
      }
    }
  }
  check('no two recipes render as literally the same waveform', !anyDuplicate);

  check("betrayed reads as clearly more intense than alliance-broken (the plan's own design requirement)",
    stats.betrayed.peak > stats['alliance-broken'].peak && stats.betrayed.rms > stats['alliance-broken'].rms,
    `betrayed peak=${stats.betrayed.peak.toFixed(3)} rms=${stats.betrayed.rms.toFixed(3)} vs broken peak=${stats['alliance-broken'].peak.toFixed(3)} rms=${stats['alliance-broken'].rms.toFixed(3)}`);
  check('click (deliberately the quietest, most frequent sound) is quieter than nuke-hit',
    stats.click.rms < stats['nuke-hit'].rms, `click rms=${stats.click.rms.toFixed(4)} nuke-hit rms=${stats['nuke-hit'].rms.toFixed(4)}`);
  check('alliance-formed (celebratory) reads louder than alliance-broken (amicable, no percussion)',
    stats['alliance-formed'].peak > stats['alliance-broken'].peak,
    `formed peak=${stats['alliance-formed'].peak.toFixed(3)} broken peak=${stats['alliance-broken'].peak.toFixed(3)}`);

  check('no page errors during the whole shared-match part', pageErrors.length === 0, pageErrors.join('; '));
  await page.close();
}

// -------------------------------------------------- persistence regression ---
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await startMatch(page);
  await page.click('#btn-pause-menu');
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const el = document.querySelector('[data-volume="music"]');
    el.value = '80';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Past the 250ms debounce -- #saveSettings() otherwise has exactly one
  // call site (the Start button), so this slider is exactly the case that
  // regresses silently without the debounced save.
  await page.waitForTimeout(400);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('oceanfront.settings') || '{}'));
  check('a pause-menu-only slider change reaches localStorage via the debounced save', Math.abs(stored.musicVolume - 0.8) < 0.01, `stored=${stored.musicVolume}`);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(100);
  const restored = await page.evaluate(() => window.OceanFront.ui.settings.musicVolume);
  check('the setting restores from localStorage before any gesture on reload', Math.abs(restored - 0.8) < 0.01, `restored=${restored}`);

  // Malformed JSON must not crash the page on load.
  await page.evaluate(() => localStorage.setItem('oceanfront.settings', '{not valid json'));
  let reloadError = null;
  await page.reload({ waitUntil: 'networkidle' }).catch((err) => { reloadError = err.message; });
  const stillLoaded = await page.evaluate(() => !!window.OceanFront?.ui).catch(() => false);
  check('corrupted (unparsable) settings JSON does not crash the page on load', stillLoaded && !reloadError, reloadError || '');

  // Well-formed JSON with out-of-range/wrong-typed values must be rejected
  // field by field, exactly like the four pre-existing settings already were.
  await page.evaluate(() => localStorage.setItem('oceanfront.settings', JSON.stringify({ sfxVolume: 5, musicVolume: 'loud', muted: 'yes' })));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(100);
  const s = await page.evaluate(() => window.OceanFront.ui.settings);
  check('an out-of-range stored sfxVolume is rejected, default kept', s.sfxVolume === SFX_VOLUME_DEFAULT, `sfxVolume=${s.sfxVolume}`);
  check('a non-numeric stored musicVolume is rejected, default kept', s.musicVolume === MUSIC_VOLUME_DEFAULT, `musicVolume=${s.musicVolume}`);
  check('a non-boolean stored muted is rejected, default kept (false)', s.muted === false, `muted=${s.muted}`);

  check('no page errors across the reload/corruption sequence', pageErrors.length === 0, pageErrors.join('; '));
  await page.close();
}

await browser.close();

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
