// Renders a map to a PNG so an authored ASCII grid can actually be looked at
// while it is being drawn, instead of only ever being seen by launching the
// game. Dev tool only -- never loaded by the browser, so the zero-runtime-
// dependency rule is untouched; the PNG encoder below uses nothing but Node
// builtins (zlib for the pixel stream, everything else written out by hand).
//
//   node tools/map-preview.mjs --size=world
//   node tools/map-preview.mjs --size=medium --seed=42 --out=/tmp/m.png
//   node tools/map-preview.mjs --size=world --terrain   # flat terrain bands
//
// Default output is the map's real in-game shading (map.baseColor), which is
// what a player would actually see. --terrain instead paints flat per-band
// colours, which is the clearer view when checking whether highland and
// mountain landed where they were drawn.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { generateMap, buildAuthoredMap } from '../src/map.js';
import { MAP_PRESETS, OCEAN, PLAINS, HIGHLAND, MOUNTAIN } from '../src/config.js';

// Declared up here, not next to crc32() below: this file's main body runs
// at import time, ahead of any let/const declared further down, so a
// lower declaration would sit in the temporal dead zone when crc32 first
// runs. Built on first use.
let crcTable = null;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const sizeKey = args.size || 'world';
const preset = MAP_PRESETS[sizeKey];
if (!preset) {
  console.error(`Unknown size "${sizeKey}". Options: ${Object.keys(MAP_PRESETS).join(', ')}`);
  process.exit(1);
}
const seed = Number(args.seed ?? 12345) >>> 0;
const out = args.out || path.join('/tmp', `oceanfront-${sizeKey}.png`);

const t0 = Date.now();
const map = preset.authored
  ? buildAuthoredMap(preset.authored, seed)
  : generateMap(preset.w, preset.h, seed);
const ms = Date.now() - t0;

// Flat band colours for --terrain: deliberately unlike the in-game shading,
// so a glance says which band a tile is in rather than how high it is.
const BAND = {
  [OCEAN]: [18, 52, 86],
  [PLAINS]: [86, 140, 74],
  [HIGHLAND]: [150, 140, 78],
  [MOUNTAIN]: [214, 220, 226],
};

// --crop=x,y,w,h narrows to a region and --zoom=N magnifies it, which is how
// you actually check something tile-scale like a river channel: at 1:1 a
// whole 480x240 world renders too small to see one.
let cx = 0;
let cy = 0;
let cw = map.width;
let ch = map.height;
if (args.crop) {
  const [a, b, c, d] = String(args.crop).split(',').map(Number);
  cx = Math.max(0, a);
  cy = Math.max(0, b);
  cw = Math.min(map.width - cx, c);
  ch = Math.min(map.height - cy, d);
}
const zoom = Math.max(1, Number(args.zoom ?? 1));

const outW = cw * zoom;
const outH = ch * zoom;
const rgb = Buffer.alloc(outW * outH * 3);
for (let y = 0; y < outH; y++) {
  const sy = cy + Math.floor(y / zoom);
  for (let x = 0; x < outW; x++) {
    const sx = cx + Math.floor(x / zoom);
    const src = sy * map.width + sx;
    const dst = (y * outW + x) * 3;
    if (args.terrain) {
      const c = BAND[map.terrain[src]];
      rgb[dst] = c[0];
      rgb[dst + 1] = c[1];
      rgb[dst + 2] = c[2];
    } else {
      rgb[dst] = map.baseColor[src * 3];
      rgb[dst + 1] = map.baseColor[src * 3 + 1];
      rgb[dst + 2] = map.baseColor[src * 3 + 2];
    }
  }
}

fs.writeFileSync(out, encodePng(outW, outH, rgb));

const land = map.landCount;
const share = ((land / map.size) * 100).toFixed(1);
const counts = [0, 0, 0, 0];
for (let i = 0; i < map.size; i++) counts[map.terrain[i]]++;
console.log(`${sizeKey}: ${map.width}x${map.height} (${map.size} tiles) built in ${ms}ms`);
console.log(`  land ${land} (${share}%)  ocean bodies ${map.oceanCount}`);
console.log(
  `  ocean ${counts[OCEAN]}  plains ${counts[PLAINS]}  highland ${counts[HIGHLAND]}  mountain ${counts[MOUNTAIN]}`
);
console.log(`  wrote ${out}`);

// ------------------------------------------------------------- png ---

/** Minimal truecolour PNG encoder: signature, IHDR, IDAT, IEND. */
function encodePng(w, h, pixels) {
  // Each scanline is prefixed with its filter byte; 0 means "no filter",
  // which keeps this simple at the cost of a slightly bigger file.
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    pixels.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
