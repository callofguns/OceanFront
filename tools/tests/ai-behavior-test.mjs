// Correctness tests for the OpenFrontIO-informed AI rework: difficulty-scaled
// cadence/readiness/strictAttacks wiring, the prioritized target chain
// (victim pile-on, very-weak snowballing), the Hard-tier weak-attack guard
// and its retaliation exception, and opportunistic ally-betrayal.
//
// Board states are hand-painted exactly, same harness style as
// encirclement-test.mjs, so results are deterministic rather than hoping a
// real match produces the right conditions. Every case here is written to
// fail against the pre-rework AiController.
import { Game, NEUTRAL } from '../../src/game.js';
import { AiController } from '../../src/ai.js';
import { MAP_PRESETS, PLAINS, OCEAN, DIFFICULTIES, ALLIANCE_MIN_DURATION } from '../../src/config.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}

const CAST = [1, 2, 3, 4];

function blankGame(difficulty = 'normal') {
  const game = new Game({
    preset: MAP_PRESETS.small, seed: 1,
    playerName: 'P0', playerColor: '#e0484f', difficulty,
  });
  game.map.terrain.fill(OCEAN);
  game.owner.fill(NEUTRAL);
  for (const p of game.players) {
    p.tiles.clear();
    p.troops = 0;
    p.gold = 0;
    p.alive = true;
    p.ai = null;
  }
  game.state = 'playing';
  game.attacks = [];
  game.boats = [];

  // Park the rest of the field far away so nobody accidentally borders the
  // tiles this file paints.
  for (const p of game.players) {
    if (CAST.includes(p.id)) continue;
    const x = 5 + p.id * 6;
    const y = 180;
    game.map.terrain[game.map.idx(x, y)] = PLAINS;
    game.setOwner(game.map.idx(x, y), p.id);
  }
  return game;
}

const own = (game, x, y, id) => {
  game.map.terrain[game.map.idx(x, y)] = PLAINS;
  game.setOwner(game.map.idx(x, y), id);
};

function rect(game, x0, y0, x1, y1, id) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      game.map.terrain[game.map.idx(x, y)] = PLAINS;
      if (id !== NEUTRAL) game.setOwner(game.map.idx(x, y), id);
    }
  }
}

// A no-op rng by default; individual tests override it on the constructed
// AiController when they need specific branches to reliably take/skip.
const dummyRng = () => 0.999;

// ---------------------------------------------------------------------------
console.log('\n▸ Cadence, readiness and strictAttacks are wired from DIFFICULTIES');
{
  const fakePlayer = { id: 0 };
  let prevMax = -Infinity;
  let prevReadiness = Infinity;
  for (const key of ['easy', 'normal', 'hard']) {
    const tier = DIFFICULTIES[key];
    const ai = new AiController(fakePlayer, dummyRng, tier);
    check(`${key}: thinkRange matches config`,
      ai.thinkRange[0] === tier.thinkRange[0] && ai.thinkRange[1] === tier.thinkRange[1]);
    check(`${key}: readiness matches config`, ai.readiness === tier.readiness);
    check(`${key}: strictAttacks matches config`, ai.strictAttacks === !!tier.strictAttacks);
    // Monotonicity across tiers: harder should think faster (lower max) and
    // commit to a fight sooner (lower readiness).
    if (key !== 'easy') {
      check(`${key}: thinks at least as fast as the previous tier`, tier.thinkRange[1] <= prevMax);
      check(`${key}: attacks at least as readily as the previous tier`, tier.readiness <= prevReadiness);
    }
    prevMax = tier.thinkRange[1];
    prevReadiness = tier.readiness;
  }
  check('Normal keeps the original flat cadence (18-34 ticks)',
    DIFFICULTIES.normal.thinkRange[0] === 18 && DIFFICULTIES.normal.thinkRange[1] === 34);
  check('Normal keeps the original flat readiness (0.45)', DIFFICULTIES.normal.readiness === 0.45);
  check('only Hard opts into strictAttacks',
    !DIFFICULTIES.easy.strictAttacks && !DIFFICULTIES.normal.strictAttacks && DIFFICULTIES.hard.strictAttacks);

  // A tier-less construction (older call sites) must behave exactly as
  // Normal always has.
  const legacyAi = new AiController(fakePlayer, dummyRng);
  check('constructing without a tier falls back to Normal cadence',
    legacyAi.thinkRange[0] === 18 && legacyAi.thinkRange[1] === 34 && legacyAi.readiness === 0.45);
}

// ---------------------------------------------------------------------------
console.log('\n▸ A rival already under heavy attack is preferred (victim pile-on)');
{
  const game = blankGame();
  const p = game.players[1];
  const a = game.players[2]; // wide border, would win under the old scoring
  const b = game.players[3]; // narrow border, but already being invaded
  const c = game.players[4]; // third party already hitting b

  rect(game, 10, 10, 30, 30, p.id);   // 21x21
  rect(game, 31, 10, 40, 30, a.id);   // wide shared border with p (~21 tiles)
  rect(game, 10, 31, 14, 35, b.id);   // narrow shared border with p (~5 tiles)
  rect(game, 10, 36, 14, 36, c.id);   // borders only b, not p

  p.troops = 5000;
  a.troops = a.tiles.size * 2;
  b.troops = b.tiles.size * 2;
  c.troops = 500;

  // c is already invading b for well over half of b's troops.
  const atk = game.launchAttack(c, b.id, 400);
  check('setup: the c -> b attack actually registered', atk !== null, `frontier=${atk?.frontier?.length}`);
  check('setup: b is a clear "victim" (>50% of its troops incoming)',
    game.attacksOn(b.id).reduce((s, x) => s + x.troops, 0) > b.troops * 0.5);

  const ai = new AiController(p, dummyRng, DIFFICULTIES.normal);
  ai.rng = () => 0.999; // never triggers the naval-harassment roll
  ai.cooldown = 0;
  ai.update(game);

  const attacks = game.attacksBy(p.id);
  check('bot launched exactly one attack', attacks.length === 1, `${attacks.length} attacks`);
  check('bot targeted b (the victim), not a (the wide-border default)',
    attacks[0]?.targetId === b.id, `targetId=${attacks[0]?.targetId}, expected ${b.id}`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ A rival whose army has collapsed is preferred (very-weak snowball)');
{
  const game = blankGame();
  const p = game.players[1];
  const a = game.players[2]; // wide border, healthy army
  const b = game.players[3]; // narrow border, army collapsed

  rect(game, 10, 10, 30, 30, p.id);
  rect(game, 31, 10, 40, 30, a.id);
  rect(game, 10, 31, 14, 35, b.id);

  p.troops = 5000;
  a.troops = a.tiles.size * 5;   // a healthy, well-filled army (fillRatio well above the weak cutoff)
  b.troops = 5;                   // b has all but vanished

  check('setup: a is NOT very weak by its own standard', a.fillRatio >= 0.2, `${a.fillRatio.toFixed(2)}`);
  check('setup: b IS very weak by its own standard', b.fillRatio < 0.2, `${b.fillRatio.toFixed(2)}`);

  const ai = new AiController(p, dummyRng, DIFFICULTIES.normal);
  ai.rng = () => 0.999;
  ai.cooldown = 0;
  ai.update(game);

  const attacks = game.attacksBy(p.id);
  check('bot launched exactly one attack', attacks.length === 1, `${attacks.length} attacks`);
  check('bot targeted b (very weak), not a (the wide-border default)',
    attacks[0]?.targetId === b.id, `targetId=${attacks[0]?.targetId}, expected ${b.id}`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Hard tier refuses a token attack, but still retaliates when attacked itself');
{
  // Viability is now fill-ratio-based (troops vs. own troop cap), not
  // density -- see the boxedIn comment in ai.js's #doDiplomacy -- so p and r
  // are sized to keep their *fill ratios* close (comfortably clearing both
  // the 0.75 viability gate and Hard's own 0.35 readiness floor -- Hard
  // bots also get a 1.25x troopsCapMultiplier, see DIFFICULTIES, which
  // raises the cap both players are being compared against) while r's own
  // cap (and so its absolute troops) is far larger, giving it a big enough
  // troop-count edge that any commit fraction from p sends well under 20%
  // of r's army, with room to spare after r spends 500 troops launching its
  // own counter-attack later in this test.
  const game = blankGame('hard');
  const p = game.players[1];
  const r = game.players[2];

  rect(game, 10, 10, 24, 19, p.id);   // 15x10 = 150 tiles
  rect(game, 25, 10, 99, 49, r.id);   // 75x40 = 3000 tiles, shares the x=24/x=25 edge

  p.troops = 1000;                    // fillRatio ~0.37 at 150 tiles -- clears Hard's 0.35 readiness
  r.troops = 3600;                    // fillRatio ~0.35 at 3000 tiles -- comparable to p's, but a much bigger army

  const ai = new AiController(p, dummyRng, DIFFICULTIES.hard);
  ai.aggression = 0.5; // fixes commit at 0.4 + 0.35*0.5 = 0.575, for a precise threshold check
  ai.rng = () => 0.9;  // fails every probabilistic branch (>0.08 harassment, >0.4 boat roll, ...)
  ai.cooldown = 0;

  const ratio = (p.fillRatio + 0.1) / (r.fillRatio + 0.1);
  const wouldSend = p.troops * 0.575;
  check('setup: r clears the base viability gate', ratio >= 0.75, `ratio=${ratio.toFixed(2)}`);
  check('setup: the attack really would be under 20% of r\'s troops',
    wouldSend < r.troops * 0.2, `${wouldSend.toFixed(0)} vs ${(r.troops * 0.2).toFixed(0)}`);

  ai.update(game);
  check('no attack launched -- too weak to matter', game.attacksBy(p.id).length === 0,
    `${game.attacksBy(p.id).length} attacks`);

  // Now r is the one under attack -- p should retaliate despite the same
  // troop shortfall, since the guard is waived while defending itself.
  const counter = game.launchAttack(r, p.id, 500);
  check('setup: r is now attacking p', counter !== null && game.attacksOn(p.id).length > 0);

  ai.cooldown = 0;
  ai.update(game);
  const attacks = game.attacksBy(p.id);
  check('p retaliates despite the same weak-attack math', attacks.length === 1,
    `${attacks.length} attacks`);
  check('retaliation targets r', attacks[0]?.targetId === r.id);
}

/** Signs an alliance and ages it past ALLIANCE_MIN_DURATION -- canBreak()
 *  refuses anything younger, so betrayal tests need this to even be
 *  possible. */
function setupAlliance(game, p, ally) {
  game.diplomacy.propose(p.id, ally.id);
  const offer = game.diplomacy.offersTo(ally.id)[0];
  game.diplomacy.accept(offer);
  game.tickCount += ALLIANCE_MIN_DURATION + 1;
  return game.diplomacy.areAllied(p.id, ally.id);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Opportunistic betrayal: fires against a collapsed ally, not a healthy one');
{
  // Case 1: a healthy ally, favorable roll -- must NOT be betrayed.
  {
    const game = blankGame();
    const p = game.players[1];
    const ally = game.players[2];
    rect(game, 10, 10, 30, 30, p.id);
    rect(game, 31, 10, 45, 30, ally.id);
    // A strip of neutral land keeps p from being "boxed in" (its only
    // neighbour being an ally with nowhere else to grow) -- that's a
    // separate, pre-existing betrayal valve this case isn't testing.
    rect(game, 5, 10, 9, 30, NEUTRAL);
    p.troops = 5000;
    ally.troops = ally.tiles.size * 3; // healthy, well above the weak-ally cutoff

    check('setup: alliance formed', setupAlliance(game, p, ally));
    check('setup: p is not boxed in (a pre-existing, separate valve)', game.map.isLand(game.map.idx(9, 20)));
    const ai = new AiController(p, dummyRng, DIFFICULTIES.normal);
    ai.rng = () => 0.001; // best possible roll -- only the weakness check should save the ally
    ai.cooldown = 0;
    ai.update(game);
    check('healthy ally is NOT betrayed', game.diplomacy.areAllied(p.id, ally.id) === true);
  }

  // Case 2: a collapsed ally, unfavorable roll -- must NOT be betrayed.
  {
    const game = blankGame();
    const p = game.players[1];
    const ally = game.players[2];
    rect(game, 10, 10, 30, 30, p.id);
    rect(game, 31, 10, 45, 30, ally.id);
    p.troops = 5000;
    ally.troops = 5; // collapsed

    check('setup: alliance formed', setupAlliance(game, p, ally));
    const ai = new AiController(p, dummyRng, DIFFICULTIES.normal);
    ai.rng = () => 0.999; // worst possible roll -- the chance gate should block it
    ai.cooldown = 0;
    ai.update(game);
    check('collapsed ally is NOT betrayed on a bad roll', game.diplomacy.areAllied(p.id, ally.id) === true);
  }

  // Case 3: a collapsed ally, favorable roll -- SHOULD be betrayed.
  {
    const game = blankGame();
    const p = game.players[1];
    const ally = game.players[2];
    rect(game, 10, 10, 30, 30, p.id);
    rect(game, 31, 10, 45, 30, ally.id);
    p.troops = 5000;
    ally.troops = 5; // collapsed

    check('setup: alliance formed', setupAlliance(game, p, ally));
    check('setup: ally really is below the weak-ally cutoff', ally.fillRatio < 0.2);

    const ai = new AiController(p, dummyRng, DIFFICULTIES.normal);
    ai.rng = () => 0.001;
    ai.cooldown = 0;
    ai.update(game);
    check('collapsed ally IS betrayed on a good roll', game.diplomacy.areAllied(p.id, ally.id) === false);
  }
}

// ---------------------------------------------------------------------------
// Found while pacing-testing this round's changes: two mutually allied
// "giants," each also allied with a small, ultra-dense "turtle" nation that
// happens to border the *other* giant, could freeze permanently. The
// boxed-in valve's original check ("every neighbour is an ally") missed
// this: a turtle so dense it fails the same ratio>=0.75 viability gate
// #makeWar uses is functionally unreachable too, but wasn't treated as such,
// so the valve never tripped and nobody ever broke the deadlock. This test
// reproduces that shape directly and would fail against the pre-fix check.
console.log('\n▸ Boxed in by an ally plus an unconquerably-dense rival still trips the valve');
{
  const game = blankGame();
  const p = game.players[1];
  const ally = game.players[2];   // p's only ally -- a fellow giant
  const turtle = game.players[3]; // not allied, but far too dense to ever attack

  rect(game, 10, 10, 30, 30, p.id);    // 21x21 = 441 tiles
  rect(game, 31, 10, 50, 30, ally.id); // wide, healthy ally on one side
  rect(game, 10, 31, 12, 33, turtle.id); // tiny 3x3 on another side

  p.troops = 5000;                 // density ~11.3
  ally.troops = ally.tiles.size * 3; // healthy -- must not look "weak"
  turtle.troops = 5000;              // density ~556 on 9 tiles -- unconquerable

  check('setup: alliance formed', setupAlliance(game, p, ally));
  const turtleRatio = (p.fillRatio + 0.1) / (turtle.fillRatio + 0.1);
  check('setup: turtle genuinely fails the viability gate', turtleRatio < 0.75,
    `ratio=${turtleRatio.toFixed(3)}`);

  const ai = new AiController(p, dummyRng, DIFFICULTIES.normal);
  ai.rng = () => 0.001; // best possible roll on every gate this cycle touches
  ai.cooldown = 0;
  ai.update(game);

  check('the only ally is betrayed once truly boxed in',
    game.diplomacy.areAllied(p.id, ally.id) === false);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
