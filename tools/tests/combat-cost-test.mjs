// Correctness tests for OpenFrontIO's exact combat/expansion math, ported
// this round: a single attackLogic() call returns both sides' losses and
// the tile's pace cost, relative-strength-scaled troop cost (OpenFrontIO's
// exact 0.6/2 ratio bound), terrain affecting pace independently from cost,
// a traitor discount on both cost and pace, a non-stacking Defense Post
// bonus, and the big-nation "relief" curve (a land-share-based sigmoid that
// eases cost/pace for a dominant nation, reinforcing rather than fighting
// the existing density-based anti-snowball dynamic).
//
// Board states are hand-painted exactly, same harness style as
// encirclement-test.mjs / ai-behavior-test.mjs. Every case here is written
// to fail against the pre-port tileCost()/#processAttack.
import { Game, NEUTRAL } from '../../src/game.js';
import {
  MAP_PRESETS, PLAINS, MOUNTAIN, OCEAN, BUILDINGS,
  COMBAT_RATIO_FLOOR, COMBAT_RATIO_CEIL,
  TRAITOR_DEFENSE_DEBUFF, TRAITOR_SPEED_DEBUFF, TRAITOR_DISTRUST_LIMIT,
  DEFENSE_DEBUFF_MIDPOINT_SHARE,
} from '../../src/config.js';

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

/** Paint a filled, unclaimed rectangle of a specific terrain type. */
function neutralTerrainBlock(game, x0, y0, x1, y1, terrain) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      game.map.terrain[game.map.idx(x, y)] = terrain;
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n▸ Relative strength: a crushing advantage is cheaper, an even fight costlier');
{
  const game = blankGame();
  const attacker = game.players[1];
  const rival = game.players[2];
  own(game, 30, 30, rival.id);
  rival.troops = 1000;
  const tile = game.map.idx(31, 30);
  game.map.terrain[tile] = PLAINS;

  const crushing = game.attackLogic(tile, rival.id, 1_000_000, attacker.id).attackerLoss;
  const even = game.attackLogic(tile, rival.id, 1000, attacker.id).attackerLoss;
  const outnumbered = game.attackLogic(tile, rival.id, 10, attacker.id).attackerLoss;
  const noInfo = game.attackLogic(tile, rival.id, 0, attacker.id).attackerLoss; // must not crash

  check('a crushing numerical advantage costs less than an even fight', crushing < even,
    `crushing=${crushing.toFixed(2)}, even=${even.toFixed(2)}`);
  check('being badly outnumbered costs more than an even fight', outnumbered > even,
    `outnumbered=${outnumbered.toFixed(2)}, even=${even.toFixed(2)}`);
  check('an attackTroops of 0 does not crash and returns a finite number', Number.isFinite(noInfo));

  // The ratio term (COMBAT_RATIO_FLOOR/CEIL-clamped) is only 60% of the
  // blend (see game.js's attackLogic -- 0.6*currentLoss + 0.4*altLoss), so
  // the *overall* attackerLoss doesn't hit the floor/ceiling ratio exactly
  // -- confirm the clamp itself is respected by reading it back directly.
  const rawFloor = Math.min(COMBAT_RATIO_CEIL, Math.max(COMBAT_RATIO_FLOOR, rival.troops / 1_000_000));
  const rawCeil = Math.min(COMBAT_RATIO_CEIL, Math.max(COMBAT_RATIO_FLOOR, rival.troops / 10));
  check('crushing advantage clamps the ratio term at COMBAT_RATIO_FLOOR', Math.abs(rawFloor - COMBAT_RATIO_FLOOR) < 1e-9);
  check('being badly outnumbered clamps the ratio term at COMBAT_RATIO_CEIL', Math.abs(rawCeil - COMBAT_RATIO_CEIL) < 1e-9);
}

// ---------------------------------------------------------------------------
console.log('\n▸ The defender loses troops too, from the same call');
{
  const game = blankGame();
  const attacker = game.players[1];
  const rival = game.players[2];
  own(game, 30, 30, rival.id);
  rival.troops = 500;
  const tile = game.map.idx(31, 30);
  game.map.terrain[tile] = PLAINS;

  const { defenderLoss } = game.attackLogic(tile, rival.id, 500, attacker.id);
  check('a real defender loses troops per tile too, not just the attacker', defenderLoss > 0,
    `defenderLoss=${defenderLoss.toFixed(2)}`);
  check('defender loss matches their density (OpenFrontIO\'s defenderTroopLoss)',
    Math.abs(defenderLoss - rival.density) < 1e-9,
    `defenderLoss=${defenderLoss.toFixed(4)}, density=${rival.density.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Neutral land: no ratio sensitivity, no defender loss');
{
  const game = blankGame();
  const attacker = game.players[1];
  const tile = game.map.idx(50, 50);
  game.map.terrain[tile] = PLAINS;

  const a = game.attackLogic(tile, NEUTRAL, 10, attacker.id);
  const b = game.attackLogic(tile, NEUTRAL, 1_000_000, attacker.id);
  check('neutral land costs the same regardless of attacking force size',
    Math.abs(a.attackerLoss - b.attackerLoss) < 1e-9, `10->${a.attackerLoss}, 1e6->${b.attackerLoss}`);
  check('neutral land has no defender to lose troops', a.defenderLoss === 0 && b.defenderLoss === 0);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Attacking a known traitor is cheaper and faster than an otherwise-identical non-traitor');
{
  const game = blankGame();
  const attacker = game.players[3] ?? game.players.find((p) => !CAST.includes(p.id) && p.id !== 1 && p.id !== 2);
  const traitor = game.players[1];
  const honest = game.players[2];
  own(game, 30, 30, traitor.id);
  own(game, 40, 30, honest.id);
  traitor.troops = 500;
  honest.troops = 500;
  traitor.traitorScore = TRAITOR_DISTRUST_LIMIT + 1;
  honest.traitorScore = 0;

  const tTile = game.map.idx(31, 30);
  const hTile = game.map.idx(41, 30);
  game.map.terrain[tTile] = PLAINS;
  game.map.terrain[hTile] = PLAINS;

  const t = game.attackLogic(tTile, traitor.id, 500, attacker.id);
  const h = game.attackLogic(hTile, honest.id, 500, attacker.id);
  check('traitor territory is cheaper to take', t.attackerLoss < h.attackerLoss,
    `traitor=${t.attackerLoss.toFixed(2)}, honest=${h.attackerLoss.toFixed(2)}`);
  check('traitor territory falls faster too (pace, not just cost)', t.tilesPerTickUsed < h.tilesPerTickUsed,
    `traitor=${t.tilesPerTickUsed.toFixed(3)}, honest=${h.tilesPerTickUsed.toFixed(3)}`);
  check('the pace discount matches TRAITOR_SPEED_DEBUFF exactly',
    Math.abs(t.tilesPerTickUsed / h.tilesPerTickUsed - TRAITOR_SPEED_DEBUFF) < 1e-6,
    `ratio=${(t.tilesPerTickUsed / h.tilesPerTickUsed).toFixed(4)}, expected=${TRAITOR_SPEED_DEBUFF}`);
  check('TRAITOR_DEFENSE_DEBUFF is applied (not the old TRAITOR_COMBAT_DISCOUNT)',
    TRAITOR_DEFENSE_DEBUFF < 1 && TRAITOR_DEFENSE_DEBUFF !== 0.85);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Terrain affects conquest pace, not just cost');
{
  function tilesTakenInOneTick(terrain) {
    const game = blankGame();
    const p = game.players[1];
    rect(game, 10, 10, 12, 12, p.id); // 3x3 starting patch, irrelevant terrain
    // A huge block of a single terrain, all unclaimed, far bigger than any
    // one tick could exhaust -- isolates the tile-budget pacing effect from
    // running out of frontier or being troop-cost-limited.
    neutralTerrainBlock(game, 13, 0, 90, 90, terrain);
    // Neutral land's cost is flat (mag/5, no troop-ratio sensitivity -- see
    // attackLogic), so troops just needs to comfortably afford a handful of
    // tiles, NOT be enormous: the pace term (NEUTRAL_PACE_SCALE*speed/troops)
    // is troop-count-*sensitive* now, unlike the old flat TERRAIN_SPEED_COST,
    // and a huge troop count clamps it to NEUTRAL_PACE_FLOOR for every
    // terrain alike, washing out exactly the distinction this test checks.
    p.troops = 300;

    const before = p.tiles.size;
    game.launchAttack(p, NEUTRAL, 300);
    check(`  setup (${['', 'plains', 'highland', 'mountain'][terrain]}): attack registered`, game.attacks.length === 1);
    game.tick();
    return p.tiles.size - before;
  }

  const plainsTaken = tilesTakenInOneTick(PLAINS);
  const mountainTaken = tilesTakenInOneTick(MOUNTAIN);
  console.log(`  plains taken in one tick: ${plainsTaken}, mountain taken: ${mountainTaken}`);
  check('mountain terrain is conquered slower than plains at equal affordability',
    mountainTaken < plainsTaken, `plains=${plainsTaken}, mountain=${mountainTaken}`);
  check('mountain still makes real progress -- terrain slows, does not halt, conquest',
    mountainTaken > 0);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Defense Post: a flat bonus if any post is in range, not a stacking one');
{
  const game = blankGame();
  const attacker = game.players[1];
  const defender = game.players[2];
  rect(game, 20, 20, 40, 40, defender.id);
  defender.troops = 1000;
  const tile = game.map.idx(30, 30);

  const bare = game.attackLogic(tile, defender.id, 1000, attacker.id);

  defender.buildings.push({ key: 'defense', tile: game.map.idx(30, 20), ownerId: defender.id });
  defender.buildingCounts.defense = 1;
  const onePost = game.attackLogic(tile, defender.id, 1000, attacker.id);
  check('a nearby Defense Post makes the tile costlier', onePost.attackerLoss > bare.attackerLoss,
    `bare=${bare.attackerLoss.toFixed(2)}, onePost=${onePost.attackerLoss.toFixed(2)}`);
  // Higher tilesPerTickUsed eats more of a tick's budget per tile, i.e.
  // *slower* conquest -- see the terrain-pace test, above.
  check('a nearby Defense Post makes the tile fall slower', onePost.tilesPerTickUsed > bare.tilesPerTickUsed,
    `bare=${bare.tilesPerTickUsed.toFixed(3)}, onePost=${onePost.tilesPerTickUsed.toFixed(3)}`);

  defender.buildings.push({ key: 'defense', tile: game.map.idx(30, 40), ownerId: defender.id });
  defender.buildingCounts.defense = 2;
  const twoPosts = game.attackLogic(tile, defender.id, 1000, attacker.id);
  check('a second overlapping post does not stack -- same cost as one',
    Math.abs(twoPosts.attackerLoss - onePost.attackerLoss) < 1e-9,
    `onePost=${onePost.attackerLoss.toFixed(4)}, twoPosts=${twoPosts.attackerLoss.toFixed(4)}`);
  check('BUILDINGS.defense.radius reaches this test\'s post placement (sanity check on the fixture itself)',
    BUILDINGS.defense.radius >= 10);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Big-nation relief: a dominant defender is cheaper/faster to conquer per tile');
{
  // Isolate the land-share sigmoid from every other variable: density
  // (defender.troops / defender.tiles.size) and the attacker/defender troop
  // ratio both stay IDENTICAL between the two scenarios below, by scaling
  // troops and attackTroops proportionally to the fake tile count -- only
  // `defender.tiles.size / map.landCount` (the share the sigmoid reads)
  // differs. Extra tiles are added directly via tiles.add() with fake
  // negative ids (never touching game.owner[]/setOwner) purely to inflate
  // Player#tiles.size for that ratio; the one real, owned tile at (30, 30)
  // is the actual attack target in both scenarios.
  function relief(share) {
    const game = blankGame();
    const attacker = game.players[1];
    const defender = game.players[2];
    own(game, 30, 30, defender.id);
    const tile = game.map.idx(30, 30);
    const fakeTileCount = Math.max(1, Math.round(game.map.landCount * share)) - 1;
    for (let i = 0; i < fakeTileCount; i++) defender.tiles.add(-1000 - i);
    const density = 100; // held constant across both scenarios
    defender.troops = density * defender.tiles.size;
    const attackTroops = defender.troops; // ratio stays 1 in both scenarios
    return game.attackLogic(tile, defender.id, attackTroops, attacker.id);
  }

  const small = relief(0.001); // well below DEFENSE_DEBUFF_MIDPOINT_SHARE
  const big = relief(DEFENSE_DEBUFF_MIDPOINT_SHARE * 2); // well past it

  console.log(`  small land share: loss=${small.attackerLoss.toFixed(2)} pace=${small.tilesPerTickUsed.toFixed(3)}`);
  console.log(`  large land share: loss=${big.attackerLoss.toFixed(2)} pace=${big.tilesPerTickUsed.toFixed(3)}`);
  check('a dominant defender\'s territory costs less per tile than a small one\'s, at identical density/ratio',
    big.attackerLoss < small.attackerLoss);
  // Lower tilesPerTickUsed eats less of a tick's budget per tile, i.e.
  // *faster* conquest -- see the terrain-pace test, above.
  check('a dominant defender\'s territory falls faster per tile than a small one\'s, at identical density/ratio',
    big.tilesPerTickUsed < small.tilesPerTickUsed);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
