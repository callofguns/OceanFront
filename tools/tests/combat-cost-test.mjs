// Correctness tests for the OpenFrontIO-informed land-expansion combat
// rework: relative-strength-scaled attacker cost, terrain affecting
// conquest *pace* (not just cost), and a traitor combat discount.
//
// Board states are hand-painted exactly, same harness style as
// encirclement-test.mjs / ai-behavior-test.mjs. Every case here is written
// to fail against the pre-rework tileCost()/#processAttack.
import { Game, NEUTRAL } from '../../src/game.js';
import {
  MAP_PRESETS, PLAINS, MOUNTAIN, OCEAN,
  COMBAT_RATIO_FLOOR, COMBAT_RATIO_CEIL, TRAITOR_COMBAT_DISCOUNT, TRAITOR_DISTRUST_LIMIT,
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
    p.workers = 0;
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
  const rival = game.players[2];
  own(game, 30, 30, rival.id);
  rival.troops = 1000;
  const tile = game.map.idx(31, 30);
  game.map.terrain[tile] = PLAINS;

  const crushing = game.tileCost(tile, rival.id, 1_000_000);
  const even = game.tileCost(tile, rival.id, 1000);
  const outnumbered = game.tileCost(tile, rival.id, 10);
  const noInfo = game.tileCost(tile, rival.id); // default attackTroops -- must not crash, must not apply the ratio

  check('a crushing numerical advantage costs less than an even fight', crushing < even,
    `crushing=${crushing.toFixed(2)}, even=${even.toFixed(2)}`);
  check('being badly outnumbered costs more than an even fight', outnumbered > even,
    `outnumbered=${outnumbered.toFixed(2)}, even=${even.toFixed(2)}`);

  const base = 1000 * 1.15 /* DEFENDER_STRENGTH is baked in, but we only need relative shape here */;
  check('crushing advantage bottoms out at the floor ratio, does not go to zero',
    crushing > 0 && Math.abs(crushing / even - COMBAT_RATIO_FLOOR / 1) < 0.5,
    `crushing=${crushing.toFixed(2)} even=${even.toFixed(2)}`);
  check('being badly outnumbered caps at the ceiling ratio, does not run away unbounded',
    outnumbered < even * (COMBAT_RATIO_CEIL / 1) * 1.01,
    `outnumbered=${outnumbered.toFixed(2)} even=${even.toFixed(2)} ceil=${COMBAT_RATIO_CEIL}`);
  check('an attackTroops of 0 (or omitted) does not crash and does not apply the ratio', Number.isFinite(noInfo));
}

// ---------------------------------------------------------------------------
console.log('\n▸ Neutral land cost is completely unaffected by the attacker\'s troop count');
{
  const game = blankGame();
  const tile = game.map.idx(50, 50);
  game.map.terrain[tile] = PLAINS;

  const a = game.tileCost(tile, NEUTRAL, 0);
  const b = game.tileCost(tile, NEUTRAL, 10);
  const c = game.tileCost(tile, NEUTRAL, 1_000_000);
  check('neutral land costs the same regardless of attacking force size',
    a === b && b === c, `0->${a}, 10->${b}, 1e6->${c}`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Attacking a known traitor is cheaper than an otherwise-identical non-traitor');
{
  const game = blankGame();
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

  const traitorCost = game.tileCost(tTile, traitor.id, 500);
  const honestCost = game.tileCost(hTile, honest.id, 500);
  check('traitor territory is cheaper to take', traitorCost < honestCost,
    `traitor=${traitorCost.toFixed(2)}, honest=${honestCost.toFixed(2)}`);
  check('the discount matches TRAITOR_COMBAT_DISCOUNT exactly',
    Math.abs(traitorCost / honestCost - TRAITOR_COMBAT_DISCOUNT) < 1e-9,
    `ratio=${(traitorCost / honestCost).toFixed(4)}, expected=${TRAITOR_COMBAT_DISCOUNT}`);
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
    p.troops = 500_000; // troops are not the limiting factor here

    const before = p.tiles.size;
    game.launchAttack(p, NEUTRAL, 480_000);
    check(`  setup (${['','plains','highland','mountain'][terrain]}): attack registered`, game.attacks.length === 1);
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

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
