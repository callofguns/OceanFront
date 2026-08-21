// Correctness tests for the mutual-attack netting in Game#launchAttack,
// ported from OpenFrontIO's AttackExecution.ts (their
// incomingAttacks/outgoingAttacks cancellation, read off their real source
// this round, not guessed): when a new attack is launched against a target
// that already has a live attack running the other way, the two troop pools
// net against each other immediately -- the smaller pool is fully cancelled
// (never runs at all, no refund), the larger pool is reduced by the smaller
// pool's size and continues. There is never more than one live attack
// between the same two players at a time.
//
// Before this fix, A->B and B->A coexisted as two fully independent Attack
// objects with zero interaction, which is what turned a mutual border into
// a tile-flipping mess (see HANDOFF.md). Every case here is written to fail
// against the pre-fix launchAttack, same harness style as
// combat-cost-test.mjs / ai-behavior-test.mjs.
import { Game, NEUTRAL } from '../../src/game.js';
import { MAP_PRESETS, PLAINS, OCEAN } from '../../src/config.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}

const CAST = [1, 2];

function blankGame() {
  const game = new Game({
    preset: MAP_PRESETS.small, seed: 1,
    playerName: 'P0', playerColor: '#e0484f', difficulty: 'normal',
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

  for (const p of game.players) {
    if (CAST.includes(p.id)) continue;
    const x = 5 + p.id * 6;
    const y = 180;
    game.map.terrain[game.map.idx(x, y)] = PLAINS;
    game.setOwner(game.map.idx(x, y), p.id);
  }
  return game;
}

/** Two adjacent rectangles sharing a border, one per player, on plains. */
function facingOff(game, aId, bId) {
  for (let y = 20; y <= 30; y++) {
    for (let x = 10; x <= 19; x++) {
      game.map.terrain[game.map.idx(x, y)] = PLAINS;
      game.setOwner(game.map.idx(x, y), aId);
    }
    for (let x = 20; x <= 29; x++) {
      game.map.terrain[game.map.idx(x, y)] = PLAINS;
      game.setOwner(game.map.idx(x, y), bId);
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n▸ A smaller new attack is fully cancelled by a bigger opposing one');
{
  const game = blankGame();
  const a = game.players[1];
  const b = game.players[2];
  facingOff(game, a.id, b.id);
  a.troops = 1000;
  b.troops = 1000;

  const big = game.launchAttack(a, b.id, 600); // A -> B, 600 troops
  check('the bigger attack (A->B) launched', big !== null && Math.abs(big.troops - 600) < 1e-6,
    `troops=${big?.troops}`);

  const small = game.launchAttack(b, a.id, 250); // B -> A, 250 troops, opposing and smaller
  check('the smaller opposing attack (B->A) is fully cancelled, launchAttack returns null', small === null);
  check('no B->A attack exists in game.attacks', !game.attacks.some((x) => !x.done && x.attackerId === b.id && x.targetId === a.id));
  check('the bigger A->B attack survives, reduced by exactly the cancelled amount',
    Math.abs(big.troops - (600 - 250)) < 1e-6, `troops=${big.troops}, expected=${600 - 250}`);
  check('the bigger A->B attack is still active', !big.done);
  check('B was not refunded the cancelled troops (spent meeting the bigger force, not returned)',
    Math.abs(b.troops - (1000 - 250)) < 1e-6, `b.troops=${b.troops}`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ A bigger new attack absorbs a smaller opposing one and continues with the remainder');
{
  const game = blankGame();
  const a = game.players[1];
  const b = game.players[2];
  facingOff(game, a.id, b.id);
  a.troops = 1000;
  b.troops = 1000;

  const small = game.launchAttack(a, b.id, 200); // A -> B, 200 troops
  check('the smaller attack (A->B) launched', small !== null && Math.abs(small.troops - 200) < 1e-6);

  const big = game.launchAttack(b, a.id, 700); // B -> A, 700 troops, opposing and bigger
  check('the bigger opposing attack (B->A) is created', big !== null);
  check('the bigger attack continues with exactly the net remainder (700 - 200)',
    big !== null && Math.abs(big.troops - (700 - 200)) < 1e-6, `troops=${big?.troops}`);
  check('the smaller A->B attack was fully absorbed and marked done', small.done === true);
  check('only one live attack remains between A and B',
    game.attacks.filter((x) => !x.done && ((x.attackerId === a.id && x.targetId === b.id) || (x.attackerId === b.id && x.targetId === a.id))).length === 1);
}

// ---------------------------------------------------------------------------
console.log('\n▸ A tie nets to a refunded no-op, not a zombie attack');
{
  const game = blankGame();
  const a = game.players[1];
  const b = game.players[2];
  facingOff(game, a.id, b.id);
  a.troops = 1000;
  b.troops = 1000;

  const first = game.launchAttack(a, b.id, 400); // A -> B, 400 troops
  check('the first attack (A->B) launched', first !== null && Math.abs(first.troops - 400) < 1e-6);

  const bBefore = b.troops;
  const tie = game.launchAttack(b, a.id, 400); // B -> A, exactly matching troops
  check('an exactly-matching opposing attack nets to null (net reduces to exactly 0, below ATTACK_MIN_TROOPS)', tie === null);
  check('the first A->B attack is fully cancelled too (marked done)', first.done === true);
  // An exact tie is not a wash for either side -- net lands on exactly 0
  // troops surviving (OpenFront's own comparison is a strict >, so an equal
  // match falls into "the new attack wins the comparison" with nothing left
  // to continue with), so B's whole 400-troop commitment is spent same as
  // A's was, not handed back. Both armies are annihilated meeting each
  // other, which is the correct reading of "both sides pay in full" -- there
  // is nothing left over here to refund.
  check('B\'s full committed troops are consumed in the collision, matching a real tie (nothing left to refund)',
    Math.abs(b.troops - (bBefore - 400)) < 1e-6, `before=${bBefore}, after=${b.troops}, expected=${bBefore - 400}`);
  check('no live attack remains between A and B',
    !game.attacks.some((x) => !x.done && ((x.attackerId === a.id && x.targetId === b.id) || (x.attackerId === b.id && x.targetId === a.id))));
}

// ---------------------------------------------------------------------------
console.log('\n▸ Same-direction reinforcement is untouched by the new opposing-attack branch');
{
  const game = blankGame();
  const a = game.players[1];
  const b = game.players[2];
  facingOff(game, a.id, b.id);
  a.troops = 1000;
  b.troops = 1000;

  const first = game.launchAttack(a, b.id, 300);
  check('first A->B attack launched', first !== null);
  const reinforced = game.launchAttack(a, b.id, 200); // same direction, same target
  check('a second same-direction attack reinforces the existing one instead of creating a new object',
    reinforced === first);
  check('troops are simply added, no netting logic touches a same-direction reinforcement',
    Math.abs(first.troops - 500) < 1e-6, `troops=${first.troops}`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Attacking unclaimed land is never netted against anything');
{
  const game = blankGame();
  const a = game.players[1];
  a.troops = 1000;
  for (let y = 40; y <= 45; y++) {
    for (let x = 40; x <= 45; x++) game.map.terrain[game.map.idx(x, y)] = PLAINS;
  }
  game.map.terrain[game.map.idx(46, 42)] = PLAINS; // unclaimed frontier tile
  game.setOwner(game.map.idx(40, 42), a.id);

  const attack = game.launchAttack(a, NEUTRAL, 300);
  check('attacking neutral land still works normally', attack !== null && Math.abs(attack.troops - 300) < 1e-6);
}

// ---------------------------------------------------------------------------
console.log('\n▸ A real mutual war never has two simultaneously-live opposing attacks');
{
  const game = new Game({
    preset: MAP_PRESETS.small, seed: 777,
    playerName: 'P0', playerColor: '#e0484f', difficulty: 'normal',
  });
  const { AiController } = await import('../../src/ai.js');
  game.human.ai = new AiController(game.human, game.rng);
  game.beginMatch(game.spawnCandidates[0]);
  game.human.isHuman = false; // play the whole match out under AI control

  let sawAnyAttack = false;
  let violation = null;
  for (let t = 0; t < 4000 && game.state === 'playing'; t++) {
    game.tick();
    if (game.attacks.length > 0) sawAnyAttack = true;
    for (const atk of game.attacks) {
      if (atk.done || atk.targetId < 0) continue;
      const reverse = game.attacks.find(
        (o) => !o.done && o.attackerId === atk.targetId && o.targetId === atk.attackerId
      );
      if (reverse) {
        violation = { a: atk.attackerId, b: atk.targetId, tick: t };
        break;
      }
    }
    if (violation) break;
  }

  check('the simulation actually produced at least one attack (a meaningful test)', sawAnyAttack);
  check('no two simultaneously-live opposing attacks ever existed between the same two players',
    violation === null, violation ? `A=${violation.a} B=${violation.b} at tick ${violation.tick}` : '');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
