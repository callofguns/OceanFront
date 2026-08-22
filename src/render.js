// Canvas renderer.
//
// The territory layer is rasterized one pixel per tile into an offscreen
// canvas and only rebuilt when ownership actually changes; everything else
// (labels, structures, projectiles) is drawn on top each frame in screen space.

import { OCEAN, BUILDINGS, NUKE_RADIUS } from './config.js';

const FILL_ALPHA = 0.66;
const BORDER_LIGHTEN = 0.55;
// How far past "the whole map exactly fills the viewport" the player can
// still scroll/pinch out, as a fraction of that fit-to-screen scale --
// matches OpenFrontIO's own feel of the map shrinking to a small island
// surrounded by open space rather than hard-stopping at the edges the
// moment it fits. OpenFrontIO itself uses a fixed absolute scale floor
// (0.2) against a default fit around 0.9, a similar ~1:4 ratio.
const ZOOM_OUT_ROOM = 0.3;
// Below this rendered pixel size, a name/troop label is skipped entirely
// rather than drawn unreadably small -- also matches OpenFrontIO (its own
// name shader culls below a screen-size threshold the same way). See
// #drawLabels: this only does anything now that the label size below it is
// allowed to actually shrink that far.
const LABEL_CULL_PX = 9;
// Matches styles.css's system font stack -- real San Francisco on macOS/iOS,
// that platform's own equivalent everywhere else, so map labels read as the
// same typeface as the surrounding DOM instead of a stray "Inter" that was
// never actually loaded (no @font-face, no link tag -- it silently fell
// through to this exact stack already).
const LABEL_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif';

export class Renderer {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.game = game;

    const { width, height } = game.map;
    this.layer = document.createElement('canvas');
    this.layer.width = width;
    this.layer.height = height;
    this.layerCtx = this.layer.getContext('2d');
    this.image = this.layerCtx.createImageData(width, height);
    this.pixels = this.image.data;
    for (let i = 3; i < this.pixels.length; i += 4) this.pixels[i] = 255;

    this.colors = this.#buildColorTable();
    this.camera = { x: 0, y: 0, scale: 1 };
    this.needsLayer = true;
  }

  #buildColorTable() {
    const table = [];
    for (const p of this.game.players) {
      const [r, g, b] = hexToRgb(p.color);
      table[p.id] = {
        r, g, b,
        br: r + (255 - r) * BORDER_LIGHTEN,
        bg: g + (255 - g) * BORDER_LIGHTEN,
        bb: b + (255 - b) * BORDER_LIGHTEN,
        // Tribes render with no border stroke at all -- just the same
        // translucent fill as their interior tiles, so their territory
        // reads as a flat, borderless blob (matching OpenFrontIO's own
        // bots, whose already-muted palette plus a uniform border formula
        // makes their edges barely readable next to one another).
        noBorder: p.isTribe,
      };
    }
    return table;
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewW = w;
    this.viewH = h;
    this.minScale = Math.min(w / this.game.map.width, h / this.game.map.height);
    // The lowest scale scroll/pinch can reach -- looser than minScale (which
    // stays "the map exactly fills the viewport", used by fitToScreen() and
    // the post-spawn zoom-in) so the player can keep zooming out past that
    // point and see the whole map shrink into open space.
    this.minZoomScale = this.minScale * ZOOM_OUT_ROOM;
    if (this.camera.scale < this.minZoomScale) this.camera.scale = this.minZoomScale;
    this.clampCamera();
  }

  fitToScreen() {
    this.camera.scale = this.minScale;
    this.camera.x = (this.viewW - this.game.map.width * this.camera.scale) / 2;
    this.camera.y = (this.viewH - this.game.map.height * this.camera.scale) / 2;
  }

  clampCamera() {
    const mw = this.game.map.width * this.camera.scale;
    const mh = this.game.map.height * this.camera.scale;
    const c = this.camera;
    if (mw <= this.viewW) c.x = (this.viewW - mw) / 2;
    else c.x = Math.min(0, Math.max(this.viewW - mw, c.x));
    if (mh <= this.viewH) c.y = (this.viewH - mh) / 2;
    else c.y = Math.min(0, Math.max(this.viewH - mh, c.y));
  }

  pan(dx, dy) {
    this.camera.x += dx;
    this.camera.y += dy;
    this.clampCamera();
  }

  zoomAt(sx, sy, factor) {
    const c = this.camera;
    const before = this.screenToWorld(sx, sy);
    c.scale = Math.max(this.minZoomScale, Math.min(24, c.scale * factor));
    const after = this.screenToWorld(sx, sy);
    c.x += (after.x - before.x) * c.scale;
    c.y += (after.y - before.y) * c.scale;
    this.clampCamera();
  }

  centerOn(tile) {
    const x = this.game.map.xOf(tile);
    const y = this.game.map.yOf(tile);
    this.camera.x = this.viewW / 2 - x * this.camera.scale;
    this.camera.y = this.viewH / 2 - y * this.camera.scale;
    this.clampCamera();
  }

  screenToWorld(sx, sy) {
    return { x: (sx - this.camera.x) / this.camera.scale, y: (sy - this.camera.y) / this.camera.scale };
  }

  worldToScreen(x, y) {
    return { x: x * this.camera.scale + this.camera.x, y: y * this.camera.scale + this.camera.y };
  }

  tileAt(sx, sy) {
    const { x, y } = this.screenToWorld(sx, sy);
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (!this.game.map.inBounds(tx, ty)) return -1;
    return this.game.map.idx(tx, ty);
  }

  // ------------------------------------------------------- territory layer --

  rebuildLayer() {
    const game = this.game;
    const { width, height, baseColor } = game.map;
    const owner = game.owner;
    const px = this.pixels;
    const colors = this.colors;

    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const i = row + x;
        const o = owner[i];
        const p = i * 4;

        if (o < 0) {
          px[p] = baseColor[i * 3];
          px[p + 1] = baseColor[i * 3 + 1];
          px[p + 2] = baseColor[i * 3 + 2];
          continue;
        }

        // A tile is a border tile if any orthogonal neighbour is owned by
        // somebody else (map edges count as border too).
        const isBorder =
          x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
          owner[i - 1] !== o || owner[i + 1] !== o ||
          owner[i - width] !== o || owner[i + width] !== o;

        const c = colors[o];
        if (isBorder && !c.noBorder) {
          px[p] = c.br;
          px[p + 1] = c.bg;
          px[p + 2] = c.bb;
        } else {
          px[p] = baseColor[i * 3] * (1 - FILL_ALPHA) + c.r * FILL_ALPHA;
          px[p + 1] = baseColor[i * 3 + 1] * (1 - FILL_ALPHA) + c.g * FILL_ALPHA;
          px[p + 2] = baseColor[i * 3 + 2] * (1 - FILL_ALPHA) + c.b * FILL_ALPHA;
        }
      }
    }
    this.layerCtx.putImageData(this.image, 0, 0);
  }

  // ------------------------------------------------------------- main draw --

  draw(ui) {
    const game = this.game;
    const ctx = this.ctx;

    if (game.dirty || this.needsLayer) {
      this.rebuildLayer();
      game.dirty = false;
      this.needsLayer = false;
    }

    ctx.fillStyle = '#08090b'; // matches styles.css's --bg
    ctx.fillRect(0, 0, this.viewW, this.viewH);

    const c = this.camera;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.layer,
      0, 0, game.map.width, game.map.height,
      c.x, c.y, game.map.width * c.scale, game.map.height * c.scale
    );

    this.#drawSpawnHints();
    this.#drawTradeRoutes();
    this.#drawBoats();
    this.#drawBuildings();
    this.#drawMissiles();
    this.#drawEffects();
    this.#drawLabels();
    this.#drawCursor(ui);
  }

  #drawSpawnHints() {
    if (this.game.state !== 'spawn') return;
    const ctx = this.ctx;
    const t = (performance.now() / 400) % (Math.PI * 2);
    const pulse = 0.5 + 0.5 * Math.sin(t);
    ctx.save();
    ctx.globalAlpha = 0.35 + pulse * 0.35;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    for (const tile of this.game.spawnCandidates.slice(0, 12)) {
      const p = this.worldToScreen(this.game.map.xOf(tile), this.game.map.yOf(tile));
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8 + pulse * 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Faint dashed links between trading ports; the dashes drift to show flow. */
  #drawTradeRoutes() {
    const routes = this.game.tradeRoutes;
    if (routes.length === 0 || this.camera.scale < 0.9) return;
    const ctx = this.ctx;
    const map = this.game.map;
    const offset = (performance.now() / 90) % 14;

    ctx.save();
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 11]);
    ctx.lineDashOffset = -offset;
    for (const r of routes) {
      const a = this.worldToScreen(map.xOf(r.a) + 0.5, map.yOf(r.a) + 0.5);
      const b = this.worldToScreen(map.xOf(r.b) + 0.5, map.yOf(r.b) + 0.5);
      if (Math.max(a.x, b.x) < 0 || Math.min(a.x, b.x) > this.viewW) continue;
      if (Math.max(a.y, b.y) < 0 || Math.min(a.y, b.y) > this.viewH) continue;
      ctx.strokeStyle = r.allied ? 'rgba(143,225,255,0.55)' : 'rgba(255,214,140,0.38)';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  #drawBuildings() {
    const scale = this.camera.scale;
    if (scale < 1.1) return;
    const ctx = this.ctx;
    const size = Math.max(9, Math.min(22, scale * 4));
    ctx.save();
    ctx.font = `${size}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;

    for (const [tile, b] of this.game.buildingAt) {
      const p = this.worldToScreen(this.game.map.xOf(tile) + 0.5, this.game.map.yOf(tile) + 0.5);
      if (p.x < -20 || p.y < -20 || p.x > this.viewW + 20 || p.y > this.viewH + 20) continue;
      ctx.fillText(BUILDINGS[b.key].icon, p.x, p.y);
    }
    ctx.restore();
  }

  #drawBoats() {
    const ctx = this.ctx;
    ctx.save();
    for (const boat of this.game.boats) {
      const idx = Math.min(boat.path.length - 1, Math.floor(boat.progress));
      const tile = boat.path[idx];
      const p = this.worldToScreen(this.game.map.xOf(tile) + 0.5, this.game.map.yOf(tile) + 0.5);
      const target = this.worldToScreen(
        this.game.map.xOf(boat.targetTile) + 0.5,
        this.game.map.yOf(boat.targetTile) + 0.5
      );
      const color = this.game.players[boat.ownerId].color;

      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35;
      ctx.setLineDash([4, 5]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalAlpha = 1;
      const r = Math.max(3, this.camera.scale * 1.2);
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  #drawMissiles() {
    const ctx = this.ctx;
    ctx.save();
    for (const m of this.game.missiles) {
      const from = this.worldToScreen(this.game.map.xOf(m.fromTile), this.game.map.yOf(m.fromTile));
      const now = this.worldToScreen(m.x, m.y);
      const to = this.worldToScreen(this.game.map.xOf(m.toTile), this.game.map.yOf(m.toTile));

      ctx.strokeStyle = 'rgba(255,180,90,0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(now.x, now.y);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255,90,90,0.35)';
      ctx.setLineDash([3, 6]);
      ctx.beginPath();
      ctx.moveTo(now.x, now.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ffd27f';
      ctx.shadowColor = '#ff8a3d';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(now.x, now.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Target reticle.
      ctx.strokeStyle = 'rgba(255,90,90,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(to.x, to.y, NUKE_RADIUS * this.camera.scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  #drawEffects() {
    const ctx = this.ctx;
    ctx.save();
    for (const e of this.game.effects) {
      const p = this.worldToScreen(e.x, e.y);
      const t = e.t / e.life;
      const r = e.radius * this.camera.scale * (0.3 + t * 1.1);
      ctx.globalAlpha = Math.max(0, 1 - t);

      if (e.type === 'nuke') {
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(1, r));
        grad.addColorStop(0, 'rgba(255,244,214,0.95)');
        grad.addColorStop(0.4, 'rgba(255,158,54,0.7)');
        grad.addColorStop(1, 'rgba(120,40,20,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1, r), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = e.type === 'intercept' ? '#8fe1ff' : '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1, r), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  #drawLabels() {
    const ctx = this.ctx;
    const game = this.game;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const p of game.players) {
      if (!p.alive || p.tiles.size < 25) continue;
      const s = this.worldToScreen(p.centroid.x, p.centroid.y);
      if (s.x < -80 || s.y < -40 || s.x > this.viewW + 80 || s.y > this.viewH + 40) continue;

      // No lower clamp here on purpose: matching OpenFrontIO, a name has to
      // be allowed to actually shrink below LABEL_CULL_PX as the camera
      // zooms out, or the cull right below can never trigger and names
      // never disappear at all -- except the player's own tag (below),
      // which is deliberately exempted so it's always findable.
      const rawSize = p.labelScale * this.camera.scale * 0.5;
      if (p.isHuman) {
        // Stays visible at any zoom level right up until the camera hits
        // the very bottom of its range (the whole map shrunk into open
        // space, see minZoomScale in resize()/zoomAt()) -- a small
        // epsilon over the exact clamp value, since repeated multiplicative
        // zoom steps can land a hair above the floor without ever
        // re-triggering the clamp that sets it to that exact number.
        if (this.camera.scale <= this.minZoomScale * 1.01) continue;
      } else if (rawSize < LABEL_CULL_PX) {
        continue;
      }
      // The player's own tag also gets an old-style readable-size floor
      // (never smaller than the cull threshold that would otherwise hide
      // it) instead of shrinking away to nothing like everyone else's --
      // it's exempt from disappearing, so it should stay legible while
      // it's up, not fade into an unreadable sliver first.
      const size = p.isHuman ? Math.max(LABEL_CULL_PX + 1, Math.min(30, rawSize)) : Math.min(30, rawSize);

      // Tribes read as background on the map too: a touch smaller, lighter
      // weight, and less than fully opaque, so a glance still reads which
      // labels are real rivals.
      const weight = p.isTribe ? 500 : 600;
      const labelSize = p.isTribe ? size * 0.85 : size;
      ctx.font = `${weight} ${labelSize}px ${LABEL_FONT}`;
      ctx.lineWidth = Math.max(2, labelSize / 6);
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.fillStyle = p.isTribe ? 'rgba(255,255,255,0.78)' : '#ffffff';
      // Mark nations the player is sworn to, so the map reads at a glance.
      const label = game.human.allies.has(p.id) ? `🤝 ${p.name}` : p.name;
      ctx.strokeText(label, s.x, s.y - size * 0.55);
      ctx.fillText(label, s.x, s.y - size * 0.55);

      ctx.font = `500 ${size * 0.82}px ${LABEL_FONT}`;
      const troops = formatShort(p.troops);
      ctx.strokeText(troops, s.x, s.y + size * 0.55);
      ctx.fillText(troops, s.x, s.y + size * 0.55);
    }
    ctx.restore();
  }

  #drawCursor(ui) {
    const tile = ui.hoverTile;
    if (tile == null || tile < 0) return;
    const ctx = this.ctx;
    const map = this.game.map;
    const x = map.xOf(tile);
    const y = map.yOf(tile);
    const p = this.worldToScreen(x, y);
    const s = this.camera.scale;

    ctx.save();

    // Radius preview for structures that project an area of effect.
    if (ui.buildMode) {
      const def = BUILDINGS[ui.buildMode];
      const legal = !this.game.buildingPlacementError(this.game.human, ui.buildMode, tile);
      if (def.radius) {
        ctx.strokeStyle = legal ? 'rgba(120,220,160,0.7)' : 'rgba(240,120,120,0.6)';
        ctx.fillStyle = legal ? 'rgba(120,220,160,0.10)' : 'rgba(240,120,120,0.08)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x + s / 2, p.y + s / 2, def.radius * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.strokeStyle = legal ? '#7ce0a3' : '#f07878';
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x - 2, p.y - 2, s + 4, s + 4);
      ctx.restore();
      return;
    }

    if (ui.nukeMode) {
      ctx.strokeStyle = 'rgba(255,120,90,0.9)';
      ctx.fillStyle = 'rgba(255,120,90,0.12)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x + s / 2, p.y + s / 2, NUKE_RADIUS * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      return;
    }

    // Plain hover: outline the tile, and highlight spawn legality.
    if (this.game.state === 'spawn') {
      const ok = this.game.canSpawnAt(tile);
      ctx.strokeStyle = ok ? '#7ce0a3' : '#f07878';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x + s / 2, p.y + s / 2, Math.max(6, 3.2 * s), 0, Math.PI * 2);
      ctx.stroke();
    } else if (map.terrain[tile] !== OCEAN) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(p.x - 1, p.y - 1, s + 2, s + 2);
    }
    ctx.restore();
  }
}

export function formatShort(n) {
  const v = Math.round(n);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1) + 'M';
  if (v >= 10_000) return (v / 1000).toFixed(0) + 'k';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
