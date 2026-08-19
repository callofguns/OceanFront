// Correctness tests for the encirclement + treasury-spoils rules.
//
// Each case builds an exact board state by hand rather than hoping a real
// match happens to produce one, so the assertions are deterministic. Every
// one of these fails against the pre-change code (no absorption at all, and
// no gold ever changing hands on a kill).
//
// Two harness details worth knowing:
//  - Every player not under test is "parked" on an isolated one-tile island,
//    so nobody is eliminated into an accidental last-nation-standing victory
//    that would end the match before the enclosure scan ever runs.
//  - Population (troops) keeps growing while the match ticks, and gold
//    trickles in on its own, so treasuries drift by fractions of a coin.
//    Gold is therefore compared with a small tolerance rather than exact
//    equality.
import { Game, NEUTRAL } from '../../src/game.js';
import { MAP_PRESETS, PLAINS, OCEAN, ENCLOSURE_SCAN_TICKS } from '../../src/config.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}
const near = (a, b, tol = 5) => Math.abs(a - b) <= tol;

/** Ids the tests drive directly; everyone else gets parked out of the way. */
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
    p.lastConquerorId = -1;
    p.ai = null; // no bot decisions -- these tests assert on exact state
    // Gold now trickles in on its own regardless of population (see
    // src/player.js's goldPerSecond) -- zero it out so treasuries stay
    // exactly where the test puts them across the many ticks these
    // fixtures run, the same way workers=0 used to make gold deterministic
    // before the population/gold rework.
    p.goldMultiplier = 0;
  }
  game.state = 'playing';
  game.attacks = [];
  game.boats = [];

  // Park the rest of the field on isolated islands along the bottom edge,
  // well clear of where the tests paint.
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

/** Paint a filled rectangle. `id === NEUTRAL` paints unclaimed land. */
function rect(game, x0, y0, x1, y1, id) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      game.map.terrain[game.map.idx(x, y)] = PLAINS;
      if (id !== NEUTRAL) game.setOwner(game.map.idx(x, y), id);
    }
  }
}

/** Tick past at least two scheduled enclosure scans. */
function runScan(game) {
  for (let i = 0; i < ENCLOSURE_SCAN_TICKS * 2 + 2; i++) game.tick();
  if (game.state !== 'playing') console.log(`    ! match ended early (state=${game.state})`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Neutral pocket ringed by one nation is absorbed for free');
{
  const game = blankGame();
  const q = game.players[1];
  rect(game, 10, 10, 16, 16, q.id);
  const hole = game.map.idx(13, 13);
  game.setOwner(hole, NEUTRAL);
  q.troops = 500;
  const tilesBefore = q.tiles.size;

  runScan(game);

  check('hole now belongs to the encircling nation', game.owner[hole] === q.id,
    `owner=${game.owner[hole]}, expected ${q.id}`);
  check('nation gained exactly the one tile', q.tiles.size === tilesBefore + 1,
    `${tilesBefore} -> ${q.tiles.size}`);
  check('no attack was ever launched for it', game.attacks.length === 0,
    `${game.attacks.length} attacks`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Pocket touching TWO nations is NOT absorbed');
{
  const game = blankGame();
  const q = game.players[1];
  const r = game.players[2];
  rect(game, 10, 10, 16, 16, q.id);
  const hole = game.map.idx(13, 13);
  game.setOwner(hole, NEUTRAL);
  game.setOwner(game.map.idx(13, 12), r.id);

  runScan(game);
  check('contested hole stays unclaimed', game.owner[hole] === NEUTRAL,
    `owner=${game.owner[hole]}`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Landlocked nation ringed by one rival is annexed, with 100% of its gold');
{
  const game = blankGame();
  const q = game.players[1];
  const victim = game.players[2];
  rect(game, 10, 10, 20, 20, q.id);
  rect(game, 14, 14, 16, 16, victim.id);
  victim.gold = 1000;
  q.gold = 250;
  victim.troops = 900; // a big army does not save you once you are sealed in
  const qTilesBefore = q.tiles.size;
  const victimTiles = victim.tiles.size;

  runScan(game);

  check('victim is eliminated', !victim.alive);
  check('victim has no land left', victim.tiles.size === 0, `tiles=${victim.tiles.size}`);
  check('conqueror absorbed the enclave', q.tiles.size === qTilesBefore + victimTiles,
    `${qTilesBefore} + ${victimTiles} -> ${q.tiles.size}`);
  check('conqueror took 100% of the treasury', near(q.gold, 1250), `gold=${q.gold.toFixed(1)}`);
  check('victim treasury emptied', near(victim.gold, 0), `gold=${victim.gold.toFixed(1)}`);
  check('annexation was reported in the log',
    game.events.some((e) => /surrounded and annexed/i.test(e.text)));
}

// ---------------------------------------------------------------------------
console.log('\n▸ Identical nation WITH coastline is NOT annexed');
{
  const game = blankGame();
  const q = game.players[1];
  const victim = game.players[2];
  rect(game, 10, 10, 20, 20, q.id);
  rect(game, 14, 14, 16, 16, victim.id);
  // Punch the ring open to the sea beside the victim.
  game.setOwner(game.map.idx(15, 17), NEUTRAL);
  game.map.terrain[game.map.idx(15, 17)] = OCEAN;
  victim.gold = 1000;

  runScan(game);

  check('coastal nation survives', victim.alive);
  check('coastal nation keeps its land', victim.tiles.size === 9, `tiles=${victim.tiles.size}`);
  check('coastal nation keeps its gold', near(victim.gold, 1000), `gold=${victim.gold.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ An ALLY does not get annexed');
{
  const game = blankGame();
  const q = game.players[1];
  const victim = game.players[2];
  rect(game, 10, 10, 20, 20, q.id);
  rect(game, 14, 14, 16, 16, victim.id);
  victim.gold = 1000;
  // Sign a real pact through the diplomacy API -- areAllied() reads the
  // alliances map, not the players' own ally sets.
  game.diplomacy.propose(q.id, victim.id);
  game.diplomacy.accept(game.diplomacy.offersTo(victim.id)[0]);
  if (!game.diplomacy.areAllied(q.id, victim.id)) console.log('    ! alliance failed to form');

  runScan(game);

  check('allied enclave survives', victim.alive, `alive=${victim.alive}`);
  check('allied enclave keeps its land', victim.tiles.size === 9, `tiles=${victim.tiles.size}`);
  check('allied enclave keeps its gold', near(victim.gold, 1000), `gold=${victim.gold.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Ordinary conquest elimination pays the killer 50%');
{
  const game = blankGame();
  const q = game.players[1];
  const victim = game.players[2];
  rect(game, 30, 30, 32, 30, q.id);
  own(game, 33, 30, victim.id);
  victim.gold = 800;
  q.gold = 100;

  // Seize the last tile the ordinary way -- straight through setOwner, which
  // is what every attack and boat landing funnels into.
  game.setOwner(game.map.idx(33, 30), q.id);
  for (let i = 0; i < 12; i++) game.tick();

  check('victim eliminated', !victim.alive);
  check('killer took exactly 50%', near(q.gold, 500), `gold=${q.gold.toFixed(1)}, expected ~500`);
  check('victim treasury emptied', near(victim.gold, 0), `gold=${victim.gold.toFixed(1)}`);
  check('spoils were reported in the log',
    game.events.some((e) => /carried off/i.test(e.text)));
}

// ---------------------------------------------------------------------------
console.log('\n▸ A nation scorched off the map by a nuke pays nobody');
{
  const game = blankGame();
  const q = game.players[1];
  const victim = game.players[2];
  rect(game, 30, 30, 32, 30, q.id);
  own(game, 33, 30, victim.id);
  victim.gold = 800;
  q.gold = 100;

  // Land going neutral is exactly what #detonate does to it.
  game.setOwner(game.map.idx(33, 30), NEUTRAL);
  for (let i = 0; i < 12; i++) game.tick();

  check('victim eliminated', !victim.alive);
  check('nobody collected the treasury', near(q.gold, 100), `gold=${q.gold.toFixed(1)}, expected ~100`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ A huge unclaimed region is NOT swallowed whole');
{
  const game = blankGame();
  const q = game.players[1];
  rect(game, 5, 5, 60, 40, NEUTRAL);
  rect(game, 5, 5, 6, 40, q.id);
  const countNeutral = () => {
    let n = 0;
    for (let i = 0; i < game.map.size; i++) {
      if (game.map.terrain[i] !== OCEAN && game.owner[i] === NEUTRAL) n++;
    }
    return n;
  };
  const before = countNeutral();

  runScan(game);

  check('open land is left to be expanded into, not inhaled', countNeutral() === before,
    `${before} -> ${countNeutral()} unclaimed tiles`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
