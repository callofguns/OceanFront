// Headless correctness tests for hand-authored maps, using the world map
// (src/maps/world.js) as the real case. Covers the things that would quietly
// make an authored map unplayable rather than merely ugly: a broken grid, a
// land share far off what was drawn, missing terrain bands, rivers that do
// not reach the sea (which turns them from boat crossings into permanent
// walls), spawn points falling back to the degenerate any-land path, and
// terrain that is not identical from one build to the next.
import { buildAuthoredMap, findSpawnPoints } from '../../src/map.js';
import { Game } from '../../src/game.js';
import { MAP_PRESETS, OCEAN, PLAINS, HIGHLAND, MOUNTAIN, DIFFICULTIES } from '../../src/config.js';
import { WORLD_MAP } from '../../src/maps/world.js';
import { makeRng } from '../../src/rng.js';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const preset = MAP_PRESETS.world;

// ------------------------------------------------------------ the grid ---
console.log('\n▸ The authored grid');
{
  const cols = WORLD_MAP.grid[0].length;
  const ragged = WORLD_MAP.grid.filter((r) => r.length !== cols);
  check('every row is the same length', ragged.length === 0, `${WORLD_MAP.grid.length} rows x ${cols}`);

  const legal = new Set(['~', '.', '^', 'A', '/']);
  const bad = new Set();
  for (const row of WORLD_MAP.grid) for (const ch of row) if (!legal.has(ch)) bad.add(ch);
  check('only legend characters appear', bad.size === 0, bad.size ? `saw ${[...bad].join('')}` : 'ok');

  // A ragged or mistyped grid must fail loudly rather than build a broken
  // world, since these are hand-edited files.
  let threw = false;
  try {
    buildAuthoredMap({ ...WORLD_MAP, grid: [...WORLD_MAP.grid.slice(0, -1), 'short'] }, 1);
  } catch {
    threw = true;
  }
  check('a ragged grid is rejected rather than silently built', threw);

  threw = false;
  try {
    const rows = [...WORLD_MAP.grid];
    rows[0] = 'X'.repeat(cols);
    buildAuthoredMap({ ...WORLD_MAP, grid: rows }, 1);
  } catch {
    threw = true;
  }
  check('an unknown character is rejected rather than silently built', threw);
}

// -------------------------------------------------------------- shape ---
console.log('\n▸ Shape and terrain mix');
const map = buildAuthoredMap(WORLD_MAP, 12345);
{
  const expectW = WORLD_MAP.grid[0].length * WORLD_MAP.scale;
  const expectH = WORLD_MAP.grid.length * WORLD_MAP.scale;
  check('dimensions match grid x scale', map.width === expectW && map.height === expectH, `${map.width}x${map.height}`);
  check('the preset advertises the same dimensions', preset.w === map.width && preset.h === map.height);

  const share = map.landCount / map.size;
  check(
    'land share is in a playable band (30-50%)',
    share > 0.3 && share < 0.5,
    `${(share * 100).toFixed(1)}%`
  );

  const counts = [0, 0, 0, 0];
  for (let i = 0; i < map.size; i++) counts[map.terrain[i]]++;
  check('ocean, plains, highland and mountain are all present', counts.every((c) => c > 0));
  // Not just present as a handful of stray tiles -- each band should be a
  // real feature of the map.
  check('highland is a real share of the land', counts[HIGHLAND] / map.landCount > 0.05, `${((counts[HIGHLAND] / map.landCount) * 100).toFixed(1)}% of land`);
  check('mountain is present without dominating', counts[MOUNTAIN] > 200 && counts[MOUNTAIN] / map.landCount < 0.15, `${counts[MOUNTAIN]} tiles`);
  check('no terrain byte outside the 0-3 encoding', map.terrain.every((t) => t <= MOUNTAIN));
}

// ------------------------------------------------------------- rivers ---
console.log('\n▸ Rivers');
{
  const scale = WORLD_MAP.scale;
  const cols = WORLD_MAP.grid[0].length;

  // Every authored river cell should have water at its centre: that centre is
  // exactly where the channel is carved.
  let riverCells = 0;
  let wet = 0;
  for (let r = 0; r < WORLD_MAP.grid.length; r++) {
    for (let c = 0; c < cols; c++) {
      if (WORLD_MAP.grid[r][c] !== '/') continue;
      riverCells++;
      const x = Math.floor(c * scale + scale / 2);
      const y = Math.floor(r * scale + scale / 2);
      if (map.terrain[map.idx(x, y)] === OCEAN) wet++;
    }
  }
  check('the map actually has rivers drawn on it', riverCells > 50, `${riverCells} river cells`);
  check('every authored river cell is water at full resolution', wet === riverCells, `${wet}/${riverCells}`);

  // The one that matters most. Rivers are ordinary water, so they block land
  // attacks; the only way across is by boat, and a boat can only enter a
  // river that shares a component with the sea it launched from. A river cut
  // off in its own component is a permanent wall, not a crossing.
  const sizes = new Map();
  for (let i = 0; i < map.size; i++) {
    const comp = map.oceanComponent[i];
    if (comp >= 0) sizes.set(comp, (sizes.get(comp) || 0) + 1);
  }
  const ordered = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
  const mainSea = ordered[0][0];
  let orphaned = 0;
  for (let r = 0; r < WORLD_MAP.grid.length; r++) {
    for (let c = 0; c < cols; c++) {
      if (WORLD_MAP.grid[r][c] !== '/') continue;
      const i = map.idx(Math.floor(c * scale + scale / 2), Math.floor(r * scale + scale / 2));
      if (map.oceanComponent[i] !== mainSea) orphaned++;
    }
  }
  check(
    'every river connects through to the open sea, so boats can enter it',
    orphaned === 0,
    `${orphaned} orphaned of ${riverCells}`
  );
  check('the map is not fragmented into many separate seas', ordered.length <= 4, `${ordered.length} bodies of water`);
}

// ------------------------------------------------------------- spawns ---
console.log('\n▸ Spawn points');
{
  const want = preset.bots + preset.tribes + 1;
  const spawns = findSpawnPoints(map, want, makeRng(999));
  check('enough spawn points for every player', spawns.length === want, `${spawns.length}/${want}`);
  check('every spawn is on land', spawns.every((t) => map.isLand(t)));
  // findSpawnPoints only seeds on plains unless it hits its degenerate
  // any-land fallback, so all-plains is how we know the real path ran.
  check(
    'spawns come from the plains-with-room path, not the any-land fallback',
    spawns.every((t) => map.terrain[t] === PLAINS)
  );

  let closest = Infinity;
  for (let a = 0; a < spawns.length; a++) {
    for (let b = a + 1; b < spawns.length; b++) {
      closest = Math.min(closest, map.dist(spawns[a], spawns[b]));
    }
  }
  // findSpawnPoints' own minDist floor relaxes as more points are requested
  // (src/map.js) -- `want` is now driven by TRIBE_TARGET_COUNT = 400 (see
  // config.js), over an order of magnitude more than when this threshold
  // was first picked, so spawns pack in noticeably closer by design. 4
  // still clearly separates "packed tightly, as intended at this scale"
  // from the genuinely degenerate case (spawns on top of each other).
  check('spawns are spread out, not clustered', closest >= 4, `closest pair ${closest.toFixed(1)} tiles`);
}

// ------------------------------------------------------- determinism ---
console.log('\n▸ Determinism');
{
  const a = buildAuthoredMap(WORLD_MAP, 1);
  const b = buildAuthoredMap(WORLD_MAP, 999999);
  let same = a.terrain.length === b.terrain.length;
  for (let i = 0; same && i < a.terrain.length; i++) if (a.terrain[i] !== b.terrain[i]) same = false;
  // The whole point of a named map: the seed moves spawns and the AI around,
  // never the coastline.
  check('terrain is identical regardless of the match seed', same);

  const s1 = findSpawnPoints(a, 10, makeRng(5));
  const s2 = findSpawnPoints(a, 10, makeRng(5));
  const s3 = findSpawnPoints(a, 10, makeRng(6));
  check('the same seed gives the same spawns', s1.join() === s2.join());
  check('a different seed gives different spawns', s1.join() !== s3.join());
}

// ----------------------------------------------------- in a real match ---
console.log('\n▸ Wired into a real match');
{
  const game = new Game({
    preset,
    seed: 4242,
    playerName: 'Tester',
    playerColor: '#ffffff',
    difficulty: DIFFICULTIES.normal.key,
  });
  check('Game builds the authored map, not a generated one', game.map.width === preset.w && game.map.height === preset.h);
  check('the roster matches the map definition', game.players.length === preset.bots + preset.tribes + 1, `${game.players.length} players`);

  game.beginMatch(game.spawnCandidates[0]);
  check('the match starts', game.state === 'playing');
  const spawned = game.players.filter((p) => p.tiles.size > 0).length;
  check('every player got a homeland', spawned === game.players.length, `${spawned}/${game.players.length}`);

  // Rivers must be crossable by boat -- the mechanic the whole
  // rivers-are-just-water decision rests on. Find a river tile with land on
  // both banks, hand one bank to the human, and confirm a landing force can
  // actually be launched at the other.
  let crossed = false;
  let found = false;
  outer: for (let y = 2; y < game.map.height - 2; y++) {
    for (let x = 2; x < game.map.width - 2; x++) {
      const i = game.map.idx(x, y);
      if (game.map.terrain[i] !== OCEAN) continue;
      const west = game.map.idx(x - 1, y);
      const east = game.map.idx(x + 1, y);
      // A one-tile channel with land either side, and open water above or
      // below so it reads as a river rather than a lone puddle.
      if (!game.map.isLand(west) || !game.map.isLand(east)) continue;
      const above = game.map.idx(x, y - 1);
      const below = game.map.idx(x, y + 1);
      if (game.map.terrain[above] !== OCEAN && game.map.terrain[below] !== OCEAN) continue;
      found = true;

      const human = game.human;
      game.setOwner(west, human.id);
      human.troops = 100000;
      const result = game.launchBoat(human, east, 5000);
      if (result.ok) {
        crossed = true;
        break outer;
      }
    }
  }
  check('the map has a one-tile river channel with land on both banks', found);
  check('a landing force can be launched across a river', crossed);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exitCode = 1;
