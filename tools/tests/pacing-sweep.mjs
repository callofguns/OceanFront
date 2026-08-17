// Aggregate pacing sweep across seeds / sizes / difficulties -- a general
// balance-tuning tool, not tied to any one change. Run it before and after a
// config.js edit and compare the two outputs: if games suddenly resolve much
// faster or slower, stall, or structures stop getting built because gold
// dried up, it shows up here.
//
//   node tools/tests/pacing-sweep.mjs "label for this run"
import { Game } from '../../src/game.js';
import { AiController } from '../../src/ai.js';
import { MAP_PRESETS, TICKS_PER_SECOND } from '../../src/config.js';

const SEEDS = [42, 7, 123, 555, 9001];
const MAX_MINUTES = 30;

function runOne(sizeKey, seed, difficulty) {
  const preset = MAP_PRESETS[sizeKey];
  const game = new Game({ preset, seed, playerName: 'Bot Zero', playerColor: '#e0484f', difficulty });
  game.human.ai = new AiController(game.human, game.rng);
  game.beginMatch(game.spawnCandidates[0]);
  game.human.isHuman = false;

  const maxTicks = MAX_MINUTES * 60 * TICKS_PER_SECOND;
  let ticks = 0;
  let worst = 0;
  let total = 0;
  while (game.state === 'playing' && ticks < maxTicks) {
    const t = performance.now();
    game.tick();
    const dt = performance.now() - t;
    if (dt > worst) worst = dt;
    total += dt;
    ticks++;
  }

  let structures = 0;
  let gold = 0;
  for (const p of game.players) {
    structures += p.buildings.length;
    gold += p.gold;
  }
  const claimed = game.players.reduce((s, p) => s + p.tiles.size, 0) / game.map.landCount;

  return {
    minutes: ticks / TICKS_PER_SECOND / 60,
    finished: game.state === 'over',
    survivors: game.players.filter((p) => p.alive).length,
    structures,
    gold: Math.round(gold),
    claimed,
    avgTick: total / ticks,
    worstTick: worst,
  };
}

const label = process.argv[2] || 'run';
console.log(`=== ${label} ===`);
for (const sizeKey of ['small', 'medium', 'large']) {
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const rows = SEEDS.map((s) => runOne(sizeKey, s, difficulty));
    const avg = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
    const stalled = rows.filter((r) => !r.finished).length;
    console.log(
      `${sizeKey.padEnd(6)} ${difficulty.padEnd(6)} ` +
      `time ${avg((r) => r.minutes).toFixed(1).padStart(5)}min  ` +
      `stalled ${stalled}/${rows.length}  ` +
      `survivors ${avg((r) => r.survivors).toFixed(1).padStart(4)}  ` +
      `structures ${avg((r) => r.structures).toFixed(0).padStart(4)}  ` +
      `gold ${avg((r) => r.gold).toFixed(0).padStart(7)}  ` +
      `land ${(avg((r) => r.claimed) * 100).toFixed(1)}%  ` +
      `tick ${avg((r) => r.avgTick).toFixed(3)}/${Math.max(...rows.map((r) => r.worstTick)).toFixed(1)}ms`
    );
  }
}
