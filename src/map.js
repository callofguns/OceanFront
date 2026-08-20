// Procedural island-continent generator.
//
// Produces a GameMap holding flat typed arrays indexed by `y * width + x`:
//   terrain    -- OCEAN / PLAINS / HIGHLAND / MOUNTAIN
//   baseColor  -- pre-shaded RGB used as the canvas background layer
//   coastal    -- 1 for land tiles touching ocean

import { OCEAN, PLAINS, HIGHLAND, MOUNTAIN } from './config.js';
import { makeRng, fbm } from './rng.js';

const TARGET_LAND_SHARE = 0.46;

export class GameMap {
  constructor(width, height, seed) {
    this.width = width;
    this.height = height;
    this.size = width * height;
    this.seed = seed;
    this.terrain = new Uint8Array(this.size);
    this.baseColor = new Uint8Array(this.size * 3);
    this.coastal = new Uint8Array(this.size);
    /** Connected-component id per water tile (-1 on land). Drives trade routes. */
    this.oceanComponent = new Int32Array(this.size).fill(-1);
    this.oceanCount = 0;
    this.landCount = 0;
    this._nbScratch = new Int32Array(4);
  }

  /**
   * Which body of water a coastal land tile touches. Two ports can trade when
   * they share one, which is an O(1) test instead of a path search.
   */
  seaOf(tile) {
    const nb = this._nbScratch;
    const n = this.neighbors(tile, nb);
    for (let k = 0; k < n; k++) {
      if (this.oceanComponent[nb[k]] >= 0) return this.oceanComponent[nb[k]];
    }
    return -1;
  }

  idx(x, y) {
    return y * this.width + x;
  }

  xOf(i) {
    return i % this.width;
  }

  yOf(i) {
    return (i / this.width) | 0;
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  isLand(i) {
    return this.terrain[i] !== OCEAN;
  }

  isWater(i) {
    return this.terrain[i] === OCEAN;
  }

  /** Orthogonal neighbours, written into `out`. Returns the count. */
  neighbors(i, out) {
    const x = i % this.width;
    let n = 0;
    if (x > 0) out[n++] = i - 1;
    if (x < this.width - 1) out[n++] = i + 1;
    if (i >= this.width) out[n++] = i - this.width;
    if (i < this.size - this.width) out[n++] = i + this.width;
    return n;
  }

  dist(a, b) {
    const dx = (a % this.width) - (b % this.width);
    const dy = ((a / this.width) | 0) - ((b / this.width) | 0);
    return Math.sqrt(dx * dx + dy * dy);
  }
}

export function generateMap(width, height, seed) {
  const map = new GameMap(width, height, seed);
  const rng = makeRng(seed);
  const size = map.size;
  const heightField = new Float32Array(size);

  // Independent noise seeds so the warp does not correlate with the elevation.
  const sElev = seed | 0;
  const sWarpX = (seed + 104729) | 0;
  const sWarpY = (seed + 224737) | 0;
  const sDetail = (seed + 350377) | 0;

  const aspect = width / height;
  const scale = 3.2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      const ny = y / height;

      // Domain warp gives coastlines their crinkled, non-circular look.
      const wx = (fbm(nx * 2.4, ny * 2.4, sWarpX, 3) - 0.5) * 0.55;
      const wy = (fbm(nx * 2.4, ny * 2.4, sWarpY, 3) - 0.5) * 0.55;

      let e = fbm((nx * aspect + wx) * scale, (ny + wy) * scale, sElev, 6);
      // A second, finer layer adds inlets and small islets.
      e = e * 0.82 + fbm((nx * aspect) * 11, ny * 11, sDetail, 3) * 0.18;

      // Radial falloff pushes the borders of the map underwater.
      const dx = (nx - 0.5) * 2;
      const dy = (ny - 0.5) * 2;
      const d = Math.min(1, Math.sqrt(dx * dx * 0.85 + dy * dy) / 1.02);
      e -= Math.pow(d, 2.6) * 0.6;

      heightField[y * width + x] = e;
    }
  }

  // Choose the sea level by quantile so every seed yields a similar land share.
  const seaLevel = quantile(heightField, 1 - TARGET_LAND_SHARE);

  // Classify land elevation bands by quantile too, for consistent terrain mix.
  const landHeights = [];
  for (let i = 0; i < size; i++) {
    if (heightField[i] > seaLevel) landHeights.push(heightField[i]);
  }
  landHeights.sort((a, b) => a - b);
  const highlandLevel = landHeights[Math.floor(landHeights.length * 0.58)] ?? seaLevel;
  const mountainLevel = landHeights[Math.floor(landHeights.length * 0.86)] ?? seaLevel;

  for (let i = 0; i < size; i++) {
    const e = heightField[i];
    if (e <= seaLevel) map.terrain[i] = OCEAN;
    else if (e < highlandLevel) map.terrain[i] = PLAINS;
    else if (e < mountainLevel) map.terrain[i] = HIGHLAND;
    else map.terrain[i] = MOUNTAIN;
  }

  scrubSpecks(map);
  markCoast(map);
  labelOceans(map);
  paintBaseColors(map, heightField, seaLevel, rng);

  map.landCount = 0;
  for (let i = 0; i < size; i++) if (map.terrain[i] !== OCEAN) map.landCount++;

  return map;
}

// ------------------------------------------------------- authored maps ---
//
// Hand-drawn maps are ASCII grids (see src/maps/), authored at a coarse
// resolution and scaled up here. Every tile value they produce is the same
// OCEAN/PLAINS/HIGHLAND/MOUNTAIN encoding generateMap emits, so nothing
// downstream needs to know a map was authored rather than generated.
//
// Rivers are ordinary OCEAN tiles, matching how OpenFrontIO does it (its
// TerrainType enum has no river member either) -- so they block land
// attacks exactly like open sea, boats can sail them, and labelOceans
// gives one that reaches the coast the sea's own component id, making it
// tradeable, all with no special casing anywhere.

/** Legend for the ASCII grids. */
const AUTHORED_LEGEND = {
  '~': OCEAN,
  '.': PLAINS,
  '^': HIGHLAND,
  A: MOUNTAIN,
  '/': OCEAN, // river, carved separately at full resolution
};

/** Height each authored cell contributes before upscaling. */
const AUTHORED_HEIGHT = {
  [OCEAN]: 0.18,
  [PLAINS]: 0.5,
  [HIGHLAND]: 0.72,
  [MOUNTAIN]: 0.92,
};

/** Band thresholds the upscaled height field is cut at. Fixed rather than
 *  quantile-based (unlike generateMap): an authored map's land/sea split is
 *  the author's decision, not something to renormalize away. */
const AUTHORED_SEA = 0.3;
const AUTHORED_HIGHLAND = 0.61;
const AUTHORED_MOUNTAIN = 0.82;

/** How far the coastline detail noise can push a tile across a threshold.
 *  Two octaves: a fine one that crinkles the coast tile by tile, and a
 *  coarser one that bends longer stretches, so an authored ellipse doesn't
 *  read as an ellipse. */
const AUTHORED_NOISE = 0.115;
const AUTHORED_NOISE_COARSE = 0.08;
/** Extra relief added to the height field *after* terrain is classified, so
 *  it varies shading without moving any tile between bands. Authored cells
 *  are flat plateaus, so without this every mountain lands at the same point
 *  on paintBaseColors' rock-to-snow ramp and whole ranges come out uniformly
 *  snow-white instead of rock with snow only on the peaks. */
const AUTHORED_RELIEF = 0.19;
/** Half-width, in tiles, of a carved river channel. 0 gives a single-tile
 *  channel, which is all a river needs: Game#findWaterPath is a plain
 *  4-connected BFS over ocean tiles with no width requirement, so boats
 *  cross a one-tile river perfectly well, while land attacks still cannot. */
const RIVER_HALF_WIDTH = 0;
/** How far, in tiles, a river wanders off the straight line between the
 *  cells it was drawn through. */
const RIVER_MEANDER = 7;

export function buildAuthoredMap(def, seed) {
  const grid = def.grid;
  const cols = grid[0].length;
  const rows = grid.length;
  for (let r = 0; r < rows; r++) {
    if (grid[r].length !== cols) {
      throw new Error(`Authored map "${def.key}": row ${r} is ${grid[r].length} chars, expected ${cols}`);
    }
  }

  const scale = def.scale;
  const width = cols * scale;
  const height = rows * scale;
  const map = new GameMap(width, height, seed);
  const rng = makeRng(seed);

  // Coarse height field, plus the river cells kept aside for carving.
  const coarse = new Float32Array(cols * rows);
  // Which authored cells are open sea, recorded from the characters rather
  // than re-derived from `coarse` -- that is a Float32Array, so comparing it
  // back against the double it was written from silently fails on rounding.
  const isOceanCell = new Uint8Array(cols * rows);
  const riverCells = [];
  for (let r = 0; r < rows; r++) {
    const row = grid[r];
    for (let c = 0; c < cols; c++) {
      const ch = row[c];
      const t = AUTHORED_LEGEND[ch];
      if (t === undefined) {
        throw new Error(`Authored map "${def.key}": unknown character "${ch}" at row ${r}, col ${c}`);
      }
      if (ch === '/') {
        // A river cell is land in the height field, and only becomes water
        // where the channel is actually carved below. Feeding it ocean
        // height here instead would make the upscale smear it into a strait
        // a whole authored cell wide, which is a sea, not a river.
        coarse[r * cols + c] = AUTHORED_HEIGHT[PLAINS];
        riverCells.push({ c, r });
      } else {
        coarse[r * cols + c] = AUTHORED_HEIGHT[t];
        if (t === OCEAN) isOceanCell[r * cols + c] = 1;
      }
    }
  }

  // Bilinear upscale, so authored cells become smooth landmasses rather
  // than scale x scale stair-steps, then a little fbm detail so coastlines
  // crinkle instead of reading as bilinear curves -- the same trick
  // generateMap uses. Seeded from the map definition, never the match seed:
  // a named map has to look the same every time it is played.
  const heightField = new Float32Array(map.size);
  const nSeed = def.noiseSeed | 0;
  for (let y = 0; y < height; y++) {
    // Sample at cell centres so the edges of the grid don't get clipped.
    const fy = Math.min(rows - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const r0 = Math.floor(fy);
    const r1 = Math.min(rows - 1, r0 + 1);
    const ty = fy - r0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(cols - 1, Math.max(0, (x + 0.5) / scale - 0.5));
      const c0 = Math.floor(fx);
      const c1 = Math.min(cols - 1, c0 + 1);
      const tx = fx - c0;

      const top = coarse[r0 * cols + c0] + (coarse[r0 * cols + c1] - coarse[r0 * cols + c0]) * tx;
      const bot = coarse[r1 * cols + c0] + (coarse[r1 * cols + c1] - coarse[r1 * cols + c0]) * tx;
      let e = top + (bot - top) * ty;

      // Sampled in tile space, not normalized space: the noise lattice has
      // to be finer than one authored cell to crinkle a coastline, and
      // normalized coordinates on a non-square map also stretch the noise
      // along the wider axis. `scale` keeps the detail sized to the cells
      // whatever resolution a map is authored at.
      e += (fbm(x / (scale * 0.7), y / (scale * 0.7), nSeed, 4) - 0.5) * AUTHORED_NOISE * 2;
      e += (fbm(x / (scale * 4), y / (scale * 4), nSeed + 4441, 3) - 0.5) * AUTHORED_NOISE_COARSE * 2;
      heightField[y * width + x] = e;
    }
  }

  for (let i = 0; i < map.size; i++) {
    const e = heightField[i];
    if (e <= AUTHORED_SEA) map.terrain[i] = OCEAN;
    else if (e < AUTHORED_HIGHLAND) map.terrain[i] = PLAINS;
    else if (e < AUTHORED_MOUNTAIN) map.terrain[i] = HIGHLAND;
    else map.terrain[i] = MOUNTAIN;
  }

  // Shading relief, applied only now that every tile's band is already
  // decided, so it can freely vary how a tile is painted without ever
  // moving it between terrain types.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (map.terrain[i] === OCEAN) continue;
      const r = fbm(x / (scale * 1.6), y / (scale * 1.6), nSeed + 9151, 3) - 0.5;
      heightField[i] += r * AUTHORED_RELIEF;
    }
  }

  scrubSpecks(map);
  // Carved after scrubSpecks so a narrow channel can't be flipped back to
  // land as a one-tile speck.
  const riverMask = new Uint8Array(map.size);
  carveRivers(map, heightField, riverCells, isOceanCell, cols, rows, scale, nSeed, riverMask);
  labelOceans(map);
  connectRiversToSea(map, heightField, riverMask);
  markCoast(map);
  labelOceans(map);
  paintBaseColors(map, heightField, AUTHORED_SEA, rng);

  map.landCount = 0;
  for (let i = 0; i < map.size; i++) if (map.terrain[i] !== OCEAN) map.landCount++;

  return map;
}

/**
 * Draw each authored river cell through to its authored neighbours at full
 * resolution. Working from the coarse adjacency means the author just draws
 * a connected run of `/` and gets a continuous river, with no need to order
 * waypoints by hand.
 */
function carveRivers(map, heightField, riverCells, isOcean, cols, rows, scale, noiseSeed, riverMask) {
  if (riverCells.length === 0) return;

  const isRiver = new Uint8Array(cols * rows);
  for (const { c, r } of riverCells) isRiver[r * cols + c] = 1;

  const centre = (c, r) => ({
    x: Math.floor(c * scale + scale / 2),
    y: Math.floor(r * scale + scale / 2),
  });

  for (const { c, r } of riverCells) {
    const a = centre(c, r);
    // Only forward neighbours, so each pair is drawn once.
    for (const [dc, dr] of [[1, 0], [0, 1]]) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc >= cols || nr >= rows || !isRiver[nr * cols + nc]) continue;
      const b = centre(nc, nr);
      carveLine(map, heightField, a.x, a.y, b.x, b.y, noiseSeed, riverMask);
    }

    // Where a river runs up against an authored ocean cell, carve on out
    // until the channel is genuinely in open water. Just reaching that
    // cell's centre is not enough: the coastline noise routinely lifts
    // near-shore ocean cells above sea level, so the real coast sits
    // further out than the authored grid says. A river that stops short is
    // its own little ocean component -- still impassable on foot, but no
    // longer reachable by boat either, which is the one thing rivers here
    // must not be.
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      if (isRiver[nr * cols + nc] || !isOcean[nr * cols + nc]) continue;
      carveMouth(map, heightField, a.x, a.y, dc, dr, scale, riverMask);
    }

    // A lone cell (a source, or a diagonal step) still gets its own pool so
    // the run never visually breaks.
    carveLine(map, heightField, a.x, a.y, a.x, a.y, noiseSeed, riverMask);
  }
}

/**
 * Guarantee the rule the whole rivers-are-just-water design rests on: a
 * river always reaches the sea.
 *
 * Rivers block land attacks exactly like open ocean, so the only way across
 * one is by boat -- and Game#findWaterPath can only route a boat through
 * water connected to the water it launched from. A river left in its own
 * component is therefore not a crossing at all, it is a wall no fleet can
 * ever reach. Authored geography makes that easy to do by accident (one
 * diagonal land bridge is enough to seal a whole inland sea), so rather than
 * leave it to be caught by eye on every new map, any carved river that ended
 * up cut off is connected here.
 *
 * Only components containing carved river tiles are joined up. A body of
 * water the author actually drew as enclosed stays an inland lake, which is
 * a real and useful thing to have: a port on one cannot trade with the open
 * sea.
 */
function connectRiversToSea(map, heightField, riverMask) {
  const { size, terrain, oceanComponent } = map;

  const compSize = new Map();
  for (let i = 0; i < size; i++) {
    const c = oceanComponent[i];
    if (c >= 0) compSize.set(c, (compSize.get(c) || 0) + 1);
  }
  if (compSize.size <= 1) return;

  let mainSea = -1;
  let biggest = -1;
  for (const [c, n] of compSize) {
    if (n > biggest) {
      biggest = n;
      mainSea = c;
    }
  }

  // Which stranded components actually hold a river.
  const stranded = new Set();
  for (let i = 0; i < size; i++) {
    if (!riverMask[i]) continue;
    const c = oceanComponent[i];
    if (c >= 0 && c !== mainSea) stranded.add(c);
  }

  const nb = new Int32Array(4);
  for (const comp of stranded) {
    // Breadth-first from every tile of the stranded body at once, across
    // land, until the main sea is reached: that finds the shortest cut to
    // open water from anywhere on it, so the channel carved is the least
    // damaging one available.
    const prev = new Int32Array(size).fill(-1);
    const seen = new Uint8Array(size);
    const queue = new Int32Array(size);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < size; i++) {
      if (oceanComponent[i] !== comp) continue;
      seen[i] = 1;
      queue[tail++] = i;
    }

    let hit = -1;
    while (head < tail && hit < 0) {
      const cur = queue[head++];
      const n = map.neighbors(cur, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (seen[j]) continue;
        seen[j] = 1;
        prev[j] = cur;
        if (oceanComponent[j] === mainSea) {
          hit = j;
          break;
        }
        queue[tail++] = j;
      }
    }
    if (hit < 0) continue;

    for (let cur = hit; cur !== -1; cur = prev[cur]) {
      terrain[cur] = OCEAN;
      riverMask[cur] = 1;
      if (heightField[cur] > AUTHORED_SEA) heightField[cur] = AUTHORED_SEA - 0.02;
    }
  }
}

/**
 * Carve a river mouth from (x0,y0) outward along (dx,dy) until the channel
 * is clearly in open water, defined as having passed through a short run of
 * tiles that were already ocean before carving. Capped so a mouth aimed at a
 * cell the noise happened to fill in can't tunnel across the map.
 */
function carveMouth(map, heightField, x0, y0, dx, dy, scale, riverMask) {
  const maxSteps = scale * 4;
  let openRun = 0;
  for (let s = 0; s <= maxSteps; s++) {
    const x = x0 + dx * s;
    const y = y0 + dy * s;
    if (!map.inBounds(x, y)) return;
    const i = map.idx(x, y);
    openRun = map.terrain[i] === OCEAN ? openRun + 1 : 0;
    map.terrain[i] = OCEAN;
    riverMask[i] = 1;
    if (heightField[i] > AUTHORED_SEA) heightField[i] = AUTHORED_SEA - 0.02;
    if (openRun >= 3) return;
  }
}

function carveLine(map, heightField, x0, y0, x1, y1, noiseSeed, riverMask) {
  const steps = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0)));
  const horizontal = Math.abs(x1 - x0) >= Math.abs(y1 - y0);
  let px = null;
  let py = null;

  const dig = (x, y) => {
    for (let dy = -RIVER_HALF_WIDTH; dy <= RIVER_HALF_WIDTH; dy++) {
      for (let dx = -RIVER_HALF_WIDTH; dx <= RIVER_HALF_WIDTH; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        if (!map.inBounds(tx, ty)) continue;
        const i = map.idx(tx, ty);
        map.terrain[i] = OCEAN;
        riverMask[i] = 1;
        // Drop the height too, or paintBaseColors would still shade these
        // tiles as land.
        if (heightField[i] > AUTHORED_SEA) heightField[i] = AUTHORED_SEA - 0.02;
      }
    }
  };

  // Half-tile steps, so a meandering path never skips a tile and leaves the
  // channel broken.
  const fine = steps * 2;
  for (let s = 0; s <= fine; s++) {
    const t = s / fine;
    let fx = x0 + (x1 - x0) * t;
    let fy = y0 + (y1 - y0) * t;
    // Meander across the direction of travel, so the river snakes rather
    // than stretching. Deliberately applied to the position *before*
    // rounding: offsetting the rounded tile instead would move the channel
    // in whole-tile jumps and rasterize into a right-angle staircase.
    // Tapered to nothing at both ends of the run, so every segment still
    // starts and finishes exactly on its authored cell centre. Without that
    // anchor a wandering river stops meeting the next segment along, and
    // stops meeting its own mouth, which is carved from the centre outward.
    const taper = Math.sin(Math.PI * t);
    const wob = (fbm(fx * 0.055, fy * 0.055, noiseSeed + 7717, 2) - 0.5) * RIVER_MEANDER * taper;
    if (horizontal) fy += wob;
    else fx += wob;
    const cx = Math.round(fx);
    const cy = Math.round(fy);

    // Walk from the previous tile to this one rather than just stamping it,
    // so the channel stays 4-connected however far the meander moved. A
    // break would put the two halves in separate ocean components, which
    // would make the river uncrossable by boat instead of merely impassable
    // on foot -- the one outcome rivers here must never have.
    if (px === null) {
      dig(cx, cy);
    } else {
      const stepX = Math.sign(cx - px);
      const stepY = Math.sign(cy - py);
      let wx = px;
      let wy = py;
      while (wx !== cx) {
        wx += stepX;
        dig(wx, wy);
      }
      while (wy !== cy) {
        wy += stepY;
        dig(wx, wy);
      }
    }
    px = cx;
    py = cy;
  }
}

function quantile(field, q) {
  // Histogram-based quantile: far cheaper than sorting 200k floats.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < field.length; i++) {
    if (field[i] < min) min = field[i];
    if (field[i] > max) max = field[i];
  }
  const BINS = 2048;
  const hist = new Uint32Array(BINS);
  const span = max - min || 1;
  for (let i = 0; i < field.length; i++) {
    let b = Math.floor(((field[i] - min) / span) * BINS);
    if (b >= BINS) b = BINS - 1;
    hist[b]++;
  }
  const target = field.length * q;
  let acc = 0;
  for (let b = 0; b < BINS; b++) {
    acc += hist[b];
    if (acc >= target) return min + (b / BINS) * span;
  }
  return max;
}

/** Remove single-tile islands and single-tile lakes -- they look like noise. */
function scrubSpecks(map) {
  const { size, terrain } = map;
  const nb = new Int32Array(4);
  const flips = [];
  for (let i = 0; i < size; i++) {
    const n = map.neighbors(i, nb);
    let sameCount = 0;
    const isLand = terrain[i] !== OCEAN;
    for (let k = 0; k < n; k++) {
      if ((terrain[nb[k]] !== OCEAN) === isLand) sameCount++;
    }
    if (sameCount === 0 && n === 4) flips.push(i);
  }
  for (const i of flips) {
    terrain[i] = terrain[i] === OCEAN ? PLAINS : OCEAN;
  }
}

/**
 * Flood fill every body of water with a component id. Inland lakes get their
 * own id, so a lakeside port cannot trade with the open sea.
 */
function labelOceans(map) {
  const { size, terrain, oceanComponent } = map;
  const queue = new Int32Array(size);
  const nb = new Int32Array(4);
  let next = 0;

  // Clear first, so this can be run again after terrain changes. Without the
  // reset the fill below skips every already-labelled tile, so a second pass
  // would hand fresh ids to newly-carved water while leaving the bodies it
  // just joined together still wearing their old, separate ids.
  oceanComponent.fill(-1);

  for (let start = 0; start < size; start++) {
    if (terrain[start] !== OCEAN || oceanComponent[start] >= 0) continue;
    const id = next++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    oceanComponent[start] = id;

    while (head < tail) {
      const cur = queue[head++];
      const n = map.neighbors(cur, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (terrain[j] !== OCEAN || oceanComponent[j] >= 0) continue;
        oceanComponent[j] = id;
        queue[tail++] = j;
      }
    }
  }
  map.oceanCount = next;
}

function markCoast(map) {
  const nb = new Int32Array(4);
  for (let i = 0; i < map.size; i++) {
    if (map.terrain[i] === OCEAN) continue;
    const n = map.neighbors(i, nb);
    for (let k = 0; k < n; k++) {
      if (map.terrain[nb[k]] === OCEAN) {
        map.coastal[i] = 1;
        break;
      }
    }
  }
}

function paintBaseColors(map, heightField, seaLevel, rng) {
  const { size, terrain, baseColor } = map;

  // Depth/elevation ramps, sampled by normalized height within each band.
  const deepWater = [8, 30, 54];
  const shallowWater = [22, 78, 118];
  const sand = [196, 178, 128];
  const grass = [64, 118, 72];
  const hill = [104, 118, 66];
  const rock = [126, 118, 104];
  const snow = [214, 220, 226];

  let maxH = -Infinity;
  let minH = Infinity;
  for (let i = 0; i < size; i++) {
    if (heightField[i] > maxH) maxH = heightField[i];
    if (heightField[i] < minH) minH = heightField[i];
  }

  for (let i = 0; i < size; i++) {
    const e = heightField[i];
    let c;
    if (terrain[i] === OCEAN) {
      const t = clamp01((e - minH) / (seaLevel - minH || 1));
      c = mix(deepWater, shallowWater, Math.pow(t, 1.6));
    } else {
      const t = clamp01((e - seaLevel) / (maxH - seaLevel || 1));
      if (t < 0.06) c = mix(sand, grass, t / 0.06);
      else if (terrain[i] === PLAINS) c = mix(grass, hill, (t - 0.06) / 0.35);
      else if (terrain[i] === HIGHLAND) c = mix(hill, rock, clamp01((t - 0.4) / 0.3));
      else c = mix(rock, snow, clamp01((t - 0.7) / 0.3));
    }

    // Subtle per-tile grain so large flat regions do not look plastic.
    const grain = (rng() - 0.5) * 14;
    baseColor[i * 3] = clampByte(c[0] + grain);
    baseColor[i * 3 + 1] = clampByte(c[1] + grain);
    baseColor[i * 3 + 2] = clampByte(c[2] + grain);
  }
}

function mix(a, b, t) {
  const s = clamp01(t);
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/**
 * Pick well-separated starting tiles with enough surrounding land to grow into.
 * Falls back to relaxing the spacing requirement rather than returning too few.
 */
export function findSpawnPoints(map, count, rng) {
  const candidates = [];
  const { width, height } = map;
  const step = 2;

  for (let y = 3; y < height - 3; y += step) {
    for (let x = 3; x < width - 3; x += step) {
      const i = map.idx(x, y);
      if (map.terrain[i] !== PLAINS) continue;
      const room = landAround(map, x, y, 7);
      if (room < 90) continue;
      candidates.push({ i, room });
    }
  }

  if (candidates.length === 0) {
    // Degenerate map: just take any land.
    for (let i = 0; i < map.size; i++) if (map.isLand(i)) candidates.push({ i, room: 1 });
  }

  // Shuffle then greedily accept, so spawns are varied between games but
  // still spread out.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  candidates.sort((a, b) => b.room - a.room);

  const chosen = [];
  let minDist = Math.max(12, Math.sqrt((map.landCount / Math.max(1, count)) * 0.9));

  while (chosen.length < count && minDist > 3) {
    for (const cand of candidates) {
      if (chosen.length >= count) break;
      if (chosen.some((c) => map.dist(c, cand.i) < minDist)) continue;
      chosen.push(cand.i);
    }
    if (chosen.length < count) minDist *= 0.75;
  }

  return chosen;
}

function landAround(map, cx, cy, r) {
  let n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (!map.inBounds(x, y)) continue;
      if (map.isLand(map.idx(x, y))) n++;
    }
  }
  return n;
}
