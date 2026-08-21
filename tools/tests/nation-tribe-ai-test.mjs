// Correctness tests for this round's OpenFrontIO port: nations hunting
// nearby tribes (#attackNearbyTribes, OpenFrontIO's attackBots()), a
// nation's own retaliation finder (#findRetaliation, OpenFrontIO's
// findIncomingAttackPlayer), the real reserve/expand-ratio commit formula
// replacing the old flat-fraction one, and the tribe combat discount in
// Game#attackLogic.
//
// Board states are hand-painted exactly, same harness style as
// ai-behavior-test.mjs / mutual-attack-test.mjs, so results are
// deterministic rather than hoping a real match produces the right
// conditions. Every case here is written to fail against the pre-port code.
import { Game, NEUTRAL } from '../../src/game.js';
import { AiController } from '../../src/ai.js';
import {
  MAP_PRESETS, PLAINS, OCEAN, DIFFICULTIES,
  AI_TRIBE_ATTACK_COMMIT_MULT, AI_TRIBE_ATTACK_MIN_MULT, AI_TRIBE_PARALLELISM,
  TRIBE_DEFENSE_DISCOUNT,
} from '../../src/config.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}

function blankGame(difficulty = 'normal', cast = [1, 2, 3, 4]) {
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
    if (cast.includes(p.id)) continue;
    const x = 5 + p.id * 6;
    const y = 180;
    game.map.terrain[game.map.idx(x, y)] = PLAINS;
    game.setOwner(game.map.idx(x, y), p.id);
  }
  return game;
}

function rect(game, x0, y0, x1, y1, id) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      game.map.terrain[game.map.idx(x, y)] = PLAINS;
      if (id !== NEUTRAL) game.setOwner(game.map.idx(x, y), id);
    }
  }
}

const dummyRng = () => 0.999;

// ---------------------------------------------------------------------------
console.log('\n▸ Commit formula: send everything above a reserve, not a flat fraction');
{
  // Player-target attack: reserve is reserveRatio * maxTroops.
  {
    const game = blankGame();
    const p = game.players[1];
    const rival = game.players[2]; // the map's tile leader, found via #findLeader

    rect(game, 10, 10, 30, 30, p.id);      // 21x21 = 441 tiles
    rect(game, 31, 10, 70, 30, rival.id);  // 40x21 = 840 tiles, borders p, more tiles than p

    p.troops = 5000;
    rival.troops = 5000; // healthy fillRatio -- not "very weak", clears viability

    const ai = new AiController(p, dummyRng, DIFFICULTIES.normal);
    ai.reserveRatio = 0.33; // arbitrary, distinct from expandRatio, for a precise check
    ai.triggerRatio = 0.33;
    ai.rng = () => 0.99; // fails the naval-harassment roll
    ai.cooldown = 0;

    const maxTroops = p.maxTroops;
    const troopsBefore = p.troops;
    const expected = troopsBefore - maxTroops * ai.reserveRatio;

    ai.update(game);
    const attacks = game.attacksBy(p.id).filter((a) => a.targetId === rival.id);
    check('bot attacked the rival (found via #findLeader)', attacks.length === 1, `${attacks.length} attacks`);
    check('commit equals troops - maxTroops*reserveRatio, not a flat fraction of troops',
      attacks.length === 1 && Math.abs(attacks[0].troops - expected) < 1e-6,
      `troops=${attacks[0]?.troops}, expected=${expected}`);
  }

  // Neutral-land attack: reserve is expandRatio * maxTroops (smaller).
  {
    const game = blankGame();
    const p = game.players[1];
    rect(game, 10, 10, 30, 30, p.id);       // 21x21 = 441 tiles
    rect(game, 31, 10, 40, 30, NEUTRAL);    // open land bordering p, nobody else around

    p.troops = 5000;

    const ai = new AiController(p, dummyRng, DIFFICULTIES.normal);
    ai.expandRatio = 0.15; // arbitrary, distinct from reserveRatio, for a precise check
    ai.reserveRatio = 0.35;
    ai.triggerRatio = 0.35;
    ai.rng = () => 0.99;
    ai.cooldown = 0;

    const maxTroops = p.maxTroops;
    const troopsBefore = p.troops;
    const expected = troopsBefore - maxTroops * ai.expandRatio;

    ai.update(game);
    const attacks = game.attacksBy(p.id).filter((a) => a.targetId === NEUTRAL);
    check('bot grabbed the open land', attacks.length === 1, `${attacks.length} attacks`);
    check('commit equals troops - maxTroops*expandRatio (the smaller reserve)',
      attacks.length === 1 && Math.abs(attacks[0].troops - expected) < 1e-6,
      `troops=${attacks[0]?.troops}, expected=${expected}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n▸ #attackNearbyTribes: multiple simultaneous attacks, priority order, parallelism cap');
{
  const game = blankGame('normal'); // AI_TRIBE_PARALLELISM.normal = 2
  const p = game.players[1];
  const tA = game.players[2]; // holds a structure -- prioritized regardless of density
  const tB = game.players[3]; // no structure, lowest density among the rest
  const tC = game.players[4]; // no structure, higher density -- excluded by the parallelism cap

  rect(game, 30, 10, 60, 60, p.id);       // large, so maxTroops comfortably affords every attack below
  rect(game, 61, 10, 70, 30, tA.id);      // east
  rect(game, 15, 10, 29, 30, tB.id);      // west
  rect(game, 15, 31, 29, 60, tC.id);      // southwest

  for (const t of [tA, tB, tC]) t.isTribe = true;
  tA.buildings.push({ key: 'city' });     // structure-holder
  tA.troops = 100;                        // density 100/210 ~= 0.48
  tB.troops = 20;                         // density 20/315 ~= 0.06 -- lowest of the non-structure pair
  tC.troops = 100;                        // density 100/450 ~= 0.22 -- higher than tB's

  p.troops = 100000; // affordable against every target's *2 minimum and *4 commit below

  const ai = new AiController(p, dummyRng, DIFFICULTIES.normal);
  ai.expandRatio = 0.1;
  ai.rng = () => 0.99;
  ai.cooldown = 0;
  ai.update(game);

  const attacks = game.attacksBy(p.id);
  check('exactly 2 tribe attacks launched (AI_TRIBE_PARALLELISM.normal)', attacks.length === 2,
    `${attacks.length} attacks, parallelism=${AI_TRIBE_PARALLELISM.normal}`);
  check('the structure-holding tribe (tA) was attacked', attacks.some((a) => a.targetId === tA.id));
  check('the lowest-density non-structure tribe (tB) was attacked, not the denser tC',
    attacks.some((a) => a.targetId === tB.id) && !attacks.some((a) => a.targetId === tC.id));
  const atA = attacks.find((a) => a.targetId === tA.id);
  check('commit against a tribe is min(target.troops*4, maxTroops-reserve) -- here the *4 cap',
    Math.abs(atA.troops - tA.troops * AI_TRIBE_ATTACK_COMMIT_MULT) < 1e-6, `troops=${atA.troops}`);

  // A second think-cycle, tribes still all standing: already-targeted
  // tribes (tA, tB) are skipped, not reinforced -- tC, previously excluded
  // only by the parallelism cap, is picked up now instead.
  const troopsBeforeSecond = { a: atA.troops, b: attacks.find((a) => a.targetId === tB.id).troops };
  ai.cooldown = 0;
  ai.update(game);
  const after = game.attacksBy(p.id);
  check('tA is not reinforced by the second think-cycle (already targeted, skipped)',
    Math.abs(after.find((a) => a.targetId === tA.id).troops - troopsBeforeSecond.a) < 1e-6);
  check('tB is not reinforced by the second think-cycle (already targeted, skipped)',
    Math.abs(after.find((a) => a.targetId === tB.id).troops - troopsBeforeSecond.b) < 1e-6);
  check('tC is now attacked on the second cycle, once no longer capped out by parallelism',
    after.some((a) => a.targetId === tC.id));
}

// ---------------------------------------------------------------------------
console.log('\n▸ #attackNearbyTribes: skipped entirely unless a decisive win is affordable');
{
  const game = blankGame('easy'); // AI_TRIBE_PARALLELISM.easy = 1
  const p = game.players[1];
  const giant = game.players[2];

  rect(game, 10, 10, 20, 20, p.id);      // small -- low maxTroops
  rect(game, 21, 10, 30, 20, giant.id);  // borders p

  giant.isTribe = true;
  giant.troops = 100000; // far more than p.maxTroops/AI_TRIBE_ATTACK_MIN_MULT could ever justify
  p.troops = 5000;

  const ai = new AiController(p, dummyRng, DIFFICULTIES.easy);
  ai.rng = () => 0.99;
  ai.cooldown = 0;

  check('setup: the tribe really is unaffordable (maxTroops < troops*2)',
    p.maxTroops < giant.troops * AI_TRIBE_ATTACK_MIN_MULT);

  ai.update(game);
  check('no attack launched against an unaffordable tribe', game.attacksBy(p.id).length === 0,
    `${game.attacksBy(p.id).length} attacks`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Tribe attacks run independent of, not instead of, one ordinary attack');
{
  const game = blankGame('normal');
  const p = game.players[1];
  const tribe = game.players[2];
  const rival = game.players[3]; // the map's tile leader -- an ordinary #findLeader target

  rect(game, 30, 30, 50, 50, p.id);       // 21x21 = 441
  rect(game, 51, 30, 60, 50, tribe.id);   // east, borders p
  rect(game, 30, 51, 90, 90, rival.id);   // south, borders p, far more tiles -- the leader

  tribe.isTribe = true;
  tribe.troops = 50;
  rival.troops = 20000;
  p.troops = 100000;

  const ai = new AiController(p, dummyRng, DIFFICULTIES.normal);
  ai.rng = () => 0.99;
  ai.cooldown = 0;
  ai.update(game);

  const attacks = game.attacksBy(p.id);
  check('both a tribe attack and an ordinary rival attack fired from the same think-cycle',
    attacks.some((a) => a.targetId === tribe.id) && attacks.some((a) => a.targetId === rival.id),
    `targets=${attacks.map((a) => a.targetId).join(',')}`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ #findRetaliation: largest current (non-tribe) attacker, ahead of the ordinary chain');
{
  const game = blankGame('normal');
  const p = game.players[1];
  const leader = game.players[2];  // most tiles -- would be the #findLeader target without retaliation
  const small = game.players[3];   // fewer tiles, but the actual largest attacker
  const tribe = game.players[4];   // biggest nominal attack of all -- must be ignored

  rect(game, 10, 10, 30, 30, p.id);        // 21x21 = 441, borders both leader and small
  rect(game, 31, 10, 70, 30, leader.id);   // 40x21 = 840, most tiles -- the map's tile leader
  rect(game, 10, 31, 14, 35, small.id);    // 5x5 = 25, small but attacks harder
  // tribe (id 4) is deliberately left with zero tiles -- never painted
  // anywhere -- so it can never border p and become a real
  // #attackNearbyTribes target; its incoming attack on p is injected
  // directly below instead, to isolate #findRetaliation's own exclusion.

  p.troops = 5000;
  leader.troops = 5000;
  small.troops = 5000;

  const atkLeader = game.launchAttack(leader, p.id, 200);
  const atkSmall = game.launchAttack(small, p.id, 500);
  check('setup: leader is attacking p', atkLeader !== null);
  check('setup: small is attacking p with more troops than leader', atkSmall !== null);
  const ratio = (p.fillRatio + 0.1) / (small.fillRatio + 0.1);
  check('setup: small actually fails the ordinary viability gate (tiny, so its fillRatio dwarfs p\'s)',
    ratio < 0.75, `ratio=${ratio.toFixed(3)}`);
  // A synthetic tribe attack, nominally the biggest of the three, injected
  // without real geography so #attackNearbyTribes never sees `tribe` as a
  // bordering candidate -- isolates #findRetaliation's own exclusion.
  game.players[4].isTribe = true;
  game.attacks.push({
    attackerId: tribe.id, targetId: p.id, troops: 1000, done: false,
    frontier: [], inFrontier: new Set(), fails: 0,
  });
  check('setup: the tribe\'s nominal attack really is the largest of the three', 1000 > 500 && 1000 > 200);

  const ai = new AiController(p, dummyRng, DIFFICULTIES.normal);
  ai.rng = () => 0.99;
  ai.cooldown = 0;
  ai.update(game);

  const outgoing = game.attacksBy(p.id);
  check('p retaliates against small (the largest *non-tribe* attacker), not leader or the tribe',
    outgoing.length === 1 && outgoing[0].targetId === small.id,
    `targets=${outgoing.map((a) => a.targetId).join(',')}`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Game#attackLogic: attacking a tribe is discounted by TRIBE_DEFENSE_DISCOUNT');
{
  const game = blankGame();
  const attacker = game.players[1];
  const nation = game.players[2];
  const tribe = game.players[3];
  tribe.isTribe = true;

  rect(game, 10, 10, 12, 12, attacker.id); // tiny -- well under LARGE_ATTACKER_SHARE
  rect(game, 20, 20, 29, 29, nation.id);   // 10x10 = 100 tiles
  rect(game, 40, 40, 49, 49, tribe.id);    // 10x10 = 100 tiles -- identical size to nation

  nation.troops = 300;
  tribe.troops = 300; // identical troops and tiles -- density and every other input match exactly

  const sharedTile = game.map.idx(60, 60);
  game.map.terrain[sharedTile] = PLAINS;

  const vsNation = game.attackLogic(sharedTile, nation.id, 100, attacker.id);
  const vsTribe = game.attackLogic(sharedTile, tribe.id, 100, attacker.id);

  check('defenderLoss is unaffected by the discount (same density, same terrain)',
    Math.abs(vsTribe.defenderLoss - vsNation.defenderLoss) < 1e-9,
    `nation=${vsNation.defenderLoss}, tribe=${vsTribe.defenderLoss}`);
  check('tilesPerTickUsed (pace) is unaffected by the discount',
    Math.abs(vsTribe.tilesPerTickUsed - vsNation.tilesPerTickUsed) < 1e-9);
  check('attackerLoss against the tribe is exactly TRIBE_DEFENSE_DISCOUNT of attacking the nation',
    Math.abs(vsTribe.attackerLoss - vsNation.attackerLoss * TRIBE_DEFENSE_DISCOUNT) < 1e-9,
    `nation=${vsNation.attackerLoss.toFixed(4)}, tribe=${vsTribe.attackerLoss.toFixed(4)}, ` +
    `expected=${(vsNation.attackerLoss * TRIBE_DEFENSE_DISCOUNT).toFixed(4)}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
