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
