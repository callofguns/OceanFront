// Headless match runner -- no DOM, no rendering.
//
// Drives the simulation with every nation under AI control and reports how the
// match developed. Use it to catch crashes, stalled expansion and tick-time
// regressions without opening a browser.
//
//   node tools/simulate.js [--size=medium] [--seed=123] [--minutes=12] [--difficulty=normal]

import { Game } from '../src/game.js';
import { MAP_PRESETS, TICKS_PER_SECOND, DIFFICULTIES, DEFAULT_DIFFICULTY } from '../src/config.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const preset = MAP_PRESETS[args.size || 'medium'] || MAP_PRESETS.medium;
const seed = Number(args.seed ?? Math.floor(Math.random() * 1e6));
const minutes = Number(args.minutes ?? 12);
const maxTicks = Math.round(minutes * 60 * TICKS_PER_SECOND);
const difficulty = DIFFICULTIES[args.difficulty] ? args.difficulty : DEFAULT_DIFFICULTY;

console.log(`OceanFront headless run — ${preset.label} (${preset.w}x${preset.h}), seed ${seed}, difficulty ${difficulty}`);

const t0 = performance.now();
const game = new Game({ preset, seed, playerName: 'Bot Zero', playerColor: '#e0484f', difficulty });
const genMs = performance.now() - t0;

// Give the "human" slot an AI so the whole board plays itself.
const { AiController } = await import('../src/ai.js');
game.human.ai = new AiController(game.human, game.rng);

console.log(
  `Map generated in ${genMs.toFixed(0)}ms — ` +
  `${game.map.landCount.toLocaleString()} land tiles ` +
  `(${((game.map.landCount / game.map.size) * 100).toFixed(0)}%), ` +
  `${game.map.oceanCount} bodies of water`
);

// Spawn everyone. beginMatch places the human slot, bots fill in around it.
game.beginMatch(game.spawnCandidates[0]);

// Drop the human flag afterwards so losing that nation does not end the match
// early -- headless runs should play through to a real winner.
game.human.isHuman = false;

let worstTick = 0;
let totalTickMs = 0;
let ticks = 0;
let stalledSince = null;
const milestones = [];

const startedAt = performance.now();

while (game.state === 'playing' && ticks < maxTicks) {
  const t = performance.now();
  game.tick();
  const dt = performance.now() - t;

  totalTickMs += dt;
  if (dt > worstTick) worstTick = dt;
  ticks++;

  if (ticks % (TICKS_PER_SECOND * 30) === 0) {
    const claimed = game.players.reduce((n, p) => n + p.tiles.size, 0);
    const share = claimed / game.map.landCount;
    const alive = game.players.filter((p) => p.alive).length;
    const leader = game.standings()[0];
    milestones.push({
      minute: (ticks / TICKS_PER_SECOND / 60).toFixed(1),
      claimed: (share * 100).toFixed(1),
      alive,
      leader: leader ? `${leader.name} ${(game.landShare(leader) * 100).toFixed(1)}%` : '-',
      alliances: game.diplomacy.alliances.size,
      trade: game.tradeRoutes.length,
    });

    // Expansion stall detector: the world should keep getting claimed.
    if (stalledSince !== null && share - stalledSince < 0.005 && share < 0.9) {
      console.warn(`  ! expansion stalled around ${(share * 100).toFixed(1)}% claimed`);
    }
    stalledSince = share;
  }
}

const wallMs = performance.now() - startedAt;

console.log('\n  min   claimed  alive  alliances  trade  leader');
for (const m of milestones) {
  console.log(
    `  ${m.minute.padStart(4)}  ${(m.claimed + '%').padStart(7)}  ` +
    `${String(m.alive).padStart(5)}  ${String(m.alliances).padStart(9)}  ` +
    `${String(m.trade).padStart(5)}  ${m.leader}`
  );
}

const totalBuildings = game.players.reduce((n, p) => n + p.buildings.length, 0);
const byType = {};
for (const p of game.players) {
  for (const b of p.buildings) byType[b.key] = (byType[b.key] || 0) + 1;
}

console.log('\nResult');
console.log(`  outcome        ${game.winner ? `${game.winner.name} won` : 'no winner within time limit'}`);
console.log(`  game time      ${(ticks / TICKS_PER_SECOND / 60).toFixed(1)} min (${ticks} ticks)`);
console.log(`  survivors      ${game.players.filter((p) => p.alive).length} / ${game.players.length}`);
console.log(`  land claimed   ${((game.players.reduce((n, p) => n + p.tiles.size, 0) / game.map.landCount) * 100).toFixed(1)}%`);
console.log(`  structures     ${totalBuildings} ${JSON.stringify(byType)}`);
console.log(`  alliances      ${game.diplomacy.alliances.size} standing, trade routes ${game.tradeRoutes.length}`);
console.log(`  betrayals      ${game.players.reduce((n, p) => n + (p.traitorScore > 0 ? 1 : 0), 0)} nations carry a traitor mark`);
console.log('\nPerformance');
console.log(`  avg tick       ${(totalTickMs / Math.max(1, ticks)).toFixed(3)} ms  (budget ${(1000 / TICKS_PER_SECOND).toFixed(0)} ms)`);
console.log(`  worst tick     ${worstTick.toFixed(2)} ms`);
console.log(`  wall clock     ${(wallMs / 1000).toFixed(1)}s for ${(ticks / TICKS_PER_SECOND / 60).toFixed(1)} game-minutes`);

// Fail loudly if the simulation is unplayably slow or nothing happened.
const avg = totalTickMs / Math.max(1, ticks);
const problems = [];
if (avg > 1000 / TICKS_PER_SECOND) problems.push(`average tick ${avg.toFixed(1)}ms exceeds the ${1000 / TICKS_PER_SECOND}ms budget`);
if (totalBuildings === 0) problems.push('no structures were ever built');
if (game.players.reduce((n, p) => n + p.tiles.size, 0) / game.map.landCount < 0.5) {
  problems.push('less than half the world was ever claimed');
}

if (problems.length > 0) {
  console.error('\nFAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nOK');
