// DOM wiring and player input.
//
// Owns the start screen, the HUD, and every mouse/keyboard interaction with the
// map. Validation is never duplicated here -- placement legality, attack rules
// and costs all come from the Game so the AI and the player obey one rulebook.

import {
  BUILDING_ORDER,
  BUILDINGS,
  MAP_PRESETS,
  PLAYER_COLORS,
  NUKE_COST,
} from './config.js';
import { formatShort } from './render.js';

const HUD_INTERVAL_MS = 120;
const DRAG_THRESHOLD = 4;

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(canvas) {
    this.canvas = canvas;
    this.game = null;
    this.renderer = null;

    /** Set by main.js. */
    this.onStart = null;
    this.onSpeed = null;

    this.state = { hoverTile: -1, buildMode: null, nukeMode: false };

    this.settings = {
      name: 'Player',
      color: PLAYER_COLORS[0],
      preset: 'medium',
    };

    this.keys = new Set();
    this.lastHudAt = 0;
    this.toastTimer = null;

    this.#restoreSettings();
    this.#buildStartScreen();
    this.#bindGlobalInput();
  }

  // ------------------------------------------------------- start screen ---

  #restoreSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('oceanfront.settings') || '{}');
      if (typeof saved.name === 'string' && saved.name.trim()) this.settings.name = saved.name;
      if (PLAYER_COLORS.includes(saved.color)) this.settings.color = saved.color;
      if (MAP_PRESETS[saved.preset]) this.settings.preset = saved.preset;
    } catch {
      /* corrupted or unavailable storage is not worth surfacing */
    }
  }

  #saveSettings() {
    try {
      localStorage.setItem('oceanfront.settings', JSON.stringify(this.settings));
    } catch {
      /* private mode -- fine, settings just will not persist */
    }
  }

  #buildStartScreen() {
    const nameInput = $('name-input');
    nameInput.value = this.settings.name;
    nameInput.addEventListener('input', () => {
      this.settings.name = nameInput.value;
    });

    const colorPicker = $('color-picker');
    for (const color of PLAYER_COLORS.slice(0, 12)) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'color-dot' + (color === this.settings.color ? ' is-active' : '');
      dot.style.background = color;
      dot.title = color;
      dot.addEventListener('click', () => {
        this.settings.color = color;
        for (const el of colorPicker.children) el.classList.remove('is-active');
        dot.classList.add('is-active');
      });
      colorPicker.appendChild(dot);
    }

    const sizePicker = $('size-picker');
    for (const preset of Object.values(MAP_PRESETS)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice' + (preset.key === this.settings.preset ? ' is-active' : '');
      btn.appendChild(document.createTextNode(preset.label));
      const small = document.createElement('small');
      small.textContent = `${preset.bots} rivals`;
      btn.appendChild(small);
      btn.addEventListener('click', () => {
        this.settings.preset = preset.key;
        for (const el of sizePicker.children) el.classList.remove('is-active');
        btn.classList.add('is-active');
      });
      sizePicker.appendChild(btn);
    }

    const seedInput = $('seed-input');
    seedInput.value = String(Math.floor(Math.random() * 1_000_000));

    $('btn-start').addEventListener('click', () => {
      const name = (nameInput.value || 'Player').trim().slice(0, 16) || 'Player';
      this.settings.name = name;
      this.#saveSettings();
      this.onStart?.({
        preset: MAP_PRESETS[this.settings.preset],
        seed: hashSeed(seedInput.value),
        playerName: name,
        playerColor: this.settings.color,
      });
    });

    $('btn-again').addEventListener('click', () => {
      $('endscreen').hidden = true;
      $('startscreen').hidden = false;
      seedInput.value = String(Math.floor(Math.random() * 1_000_000));
    });
  }

  // -------------------------------------------------------------- attach ---

  attach(game, renderer) {
    this.game = game;
    this.renderer = renderer;
    this.state.buildMode = null;
    this.state.nukeMode = false;

    $('startscreen').hidden = true;
    $('hud').hidden = false;
    $('hud').classList.add('is-spawning');
    $('spawnbanner').hidden = false;
    $('endscreen').hidden = true;

    this.#buildBuildMenu();
    this.#bindHudControls();
    this.#syncSliders();
    this.refreshHud(true);
  }

  #buildBuildMenu() {
    const list = $('build-list');
    list.replaceChildren();
    this.buildButtons = {};

    BUILDING_ORDER.forEach((key, index) => {
      const def = BUILDINGS[key];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'build-btn';
      btn.title = `${def.desc}  (hotkey ${index + 1})`;

      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = def.icon;

      const body = document.createElement('span');
      body.className = 'body';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = def.name;
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = def.desc;
      body.append(title, sub);

      const cost = document.createElement('span');
      cost.className = 'cost';

      btn.append(icon, body, cost);
      btn.addEventListener('click', () => this.#toggleBuildMode(key));
      list.appendChild(btn);

      this.buildButtons[key] = { btn, cost };
    });
  }

  #bindHudControls() {
    const attack = $('attack-ratio');
    attack.addEventListener('input', () => {
      this.game.human.attackRatio = Number(attack.value) / 100;
      $('attack-ratio-value').textContent = `${attack.value}%`;
    });

    const troop = $('troop-ratio');
    troop.addEventListener('input', () => {
      this.game.human.troopRatio = Number(troop.value) / 100;
      $('troop-ratio-value').textContent = `${troop.value}% troops`;
    });

    $('btn-nuke').addEventListener('click', () => this.#toggleNukeMode());
    $('btn-retreat').addEventListener('click', () => {
      const back = this.game.cancelAttacks(this.game.human);
      this.toast(back > 0 ? `${formatShort(back)} troops recalled.` : 'No attacks under way.');
    });

    for (const btn of document.querySelectorAll('.speed-btn')) {
      btn.addEventListener('click', () => {
        for (const b of document.querySelectorAll('.speed-btn')) b.classList.remove('is-active');
        btn.classList.add('is-active');
        this.onSpeed?.(Number(btn.dataset.speed));
      });
    }
  }

  #syncSliders() {
    const human = this.game.human;
    const attack = Math.round(human.attackRatio * 100);
    const troop = Math.round(human.troopRatio * 100);
    $('attack-ratio').value = String(attack);
    $('attack-ratio-value').textContent = `${attack}%`;
    $('troop-ratio').value = String(troop);
    $('troop-ratio-value').textContent = `${troop}% troops`;
  }

  // --------------------------------------------------------------- modes ---

  #toggleBuildMode(key) {
    this.state.nukeMode = false;
    this.state.buildMode = this.state.buildMode === key ? null : key;
    this.#refreshModeUi();
  }

  #toggleNukeMode() {
    if (!this.game.canNuke(this.game.human)) {
      this.toast('Build a Missile Silo first.');
      return;
    }
    this.state.buildMode = null;
    this.state.nukeMode = !this.state.nukeMode;
    this.#refreshModeUi();
  }

  cancelModes() {
    this.state.buildMode = null;
    this.state.nukeMode = false;
    this.#refreshModeUi();
  }

  #refreshModeUi() {
    for (const [key, { btn }] of Object.entries(this.buildButtons)) {
      btn.classList.toggle('is-active', this.state.buildMode === key);
    }
    $('btn-nuke').classList.toggle('is-active', this.state.nukeMode);
    this.canvas.classList.toggle('is-placing', !!this.state.buildMode || this.state.nukeMode);

    const hint = $('mode-hint');
    hint.classList.toggle('is-alert', !!this.state.buildMode || this.state.nukeMode);
    if (this.state.buildMode) {
      hint.textContent = `Placing ${BUILDINGS[this.state.buildMode].name} — click your land. Right-click to cancel.`;
    } else if (this.state.nukeMode) {
      hint.textContent = 'Select a target for the warhead. Right-click to cancel.';
    } else {
      hint.textContent = 'Click enemy or empty land to attack it.';
    }
  }

  // --------------------------------------------------------------- input ---

  #bindGlobalInput() {
    const canvas = this.canvas;
    let pointerDown = false;
    let dragged = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.renderer) return;
      pointerDown = true;
      dragged = false;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this.renderer) return;
      this.state.hoverTile = this.renderer.tileAt(e.clientX, e.clientY);

      if (!pointerDown) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (!dragged && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        dragged = true;
        canvas.classList.add('is-panning');
      }
      if (dragged) {
        this.renderer.pan(dx, dy);
        lastX = e.clientX;
        lastY = e.clientY;
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      if (!this.renderer) return;
      pointerDown = false;
      canvas.classList.remove('is-panning');
      if (dragged) return;
      if (e.button === 0) this.#handleClick(this.renderer.tileAt(e.clientX, e.clientY));
    });

    canvas.addEventListener('pointercancel', () => {
      pointerDown = false;
      canvas.classList.remove('is-panning');
    });

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.cancelModes();
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.renderer) return;
        e.preventDefault();
        this.renderer.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.16 : 1 / 1.16);
      },
      { passive: false }
    );

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.key.toLowerCase());

      if (e.key === 'Escape') this.cancelModes();
      if (e.code === 'Space') {
        e.preventDefault();
        this.#togglePause();
      }
      const slot = Number(e.key);
      if (slot >= 1 && slot <= BUILDING_ORDER.length && this.game) {
        this.#toggleBuildMode(BUILDING_ORDER[slot - 1]);
      }
      if (e.key.toLowerCase() === 'n' && this.game) this.#toggleNukeMode();
    });

    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  #togglePause() {
    const active = document.querySelector('.speed-btn.is-active');
    const target = active?.dataset.speed === '0'
      ? document.querySelector('.speed-btn[data-speed="1"]')
      : document.querySelector('.speed-btn[data-speed="0"]');
    target?.click();
  }

  /** Keyboard panning, called once per frame from the main loop. */
  applyKeyboardPan(dt) {
    if (!this.renderer || this.keys.size === 0) return;
    const step = 0.75 * dt;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('a') || this.keys.has('arrowleft')) dx += step;
    if (this.keys.has('d') || this.keys.has('arrowright')) dx -= step;
    if (this.keys.has('w') || this.keys.has('arrowup')) dy += step;
    if (this.keys.has('s') || this.keys.has('arrowdown')) dy -= step;
    if (dx || dy) this.renderer.pan(dx, dy);
  }

  #handleClick(tile) {
    const game = this.game;
    if (!game || tile < 0) return;

    if (game.state === 'spawn') {
      if (!game.canSpawnAt(tile)) {
        this.toast('Pick unclaimed land.');
        return;
      }
      game.beginMatch(tile);
      $('spawnbanner').hidden = true;
      $('hud').classList.remove('is-spawning');
      // Zoom past the fit-to-screen scale on purpose: while the whole map fits
      // the viewport the camera cannot be recentred, which can leave the new
      // homeland stranded underneath a HUD panel.
      this.renderer.camera.scale = Math.max(this.renderer.minScale * 1.8, 6);
      this.renderer.centerOn(tile);
      this.refreshHud(true);
      return;
    }

    if (game.state !== 'playing') return;
    const human = game.human;

    if (this.state.buildMode) {
      const key = this.state.buildMode;
      const result = game.build(human, key, tile);
      if (result.ok) {
        this.toast(`${BUILDINGS[key].name} built.`);
        // Keep placing while shift is held, for laying down several at once.
        if (!this.keys.has('shift')) this.cancelModes();
        this.refreshHud(true);
      } else {
        this.toast(result.reason);
      }
      return;
    }

    if (this.state.nukeMode) {
      const result = game.launchNuke(human, tile);
      this.toast(result.ok ? 'Warhead away.' : result.reason);
      if (result.ok) this.cancelModes();
      return;
    }

    // Default action: attack whoever owns the clicked tile.
    if (!game.map.isLand(tile)) {
      this.toast('That is open water.');
      return;
    }
    const targetId = game.owner[tile];
    if (targetId === human.id) {
      this.toast('You already hold that land.');
      return;
    }
    if (targetId >= 0 && human.allies.has(targetId)) {
      this.toast(`You are allied with ${game.players[targetId].name}. Break the pact first.`);
      return;
    }

    const troops = human.troops * human.attackRatio;
    if (game.borders(human, targetId)) {
      const attack = game.launchAttack(human, targetId, troops);
      if (!attack) {
        this.toast('Not enough troops to mount that attack.');
        return;
      }
      const name = targetId >= 0 ? game.players[targetId].name : 'unclaimed land';
      this.toast(`Attacking ${name} with ${formatShort(attack.troops)} troops.`);
    } else {
      const result = game.launchBoat(human, tile, troops);
      this.toast(result.ok ? 'Landing force is under way.' : result.reason);
    }
  }

  // ----------------------------------------------------------------- hud ---

  toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('is-visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2200);
  }

  refreshHud(force = false) {
    const now = performance.now();
    if (!force && now - this.lastHudAt < HUD_INTERVAL_MS) return;
    this.lastHudAt = now;

    const game = this.game;
    if (!game) return;
    const human = game.human;

    $('stat-troops').textContent = formatShort(human.troops);
    $('stat-workers').textContent = formatShort(human.workers);
    $('stat-pop').textContent = `${formatShort(human.pop)} / ${formatShort(human.maxPop)}`;
    $('stat-gold').textContent = `${formatShort(human.gold)}  (+${human.goldPerSecond.toFixed(1)}/s)`;
    $('stat-land').textContent = `${(game.landShare(human) * 100).toFixed(1)}%`;

    this.#refreshBuildCosts(human);
    this.#refreshNukeButton(human);
    this.#refreshLeaderboard(game, human);
    this.#refreshEvents(game);
    this.#refreshAttackHint(game, human);
  }

  #refreshBuildCosts(human) {
    for (const key of BUILDING_ORDER) {
      const { btn, cost } = this.buildButtons[key];
      const price = this.game.costFor(human, key);
      const owned = human.countOf(key);
      cost.textContent = owned > 0 ? `${formatShort(price)} ·${owned}` : formatShort(price);
      cost.classList.toggle('unaffordable', human.gold < price);
      btn.disabled = false;
    }
  }

  #refreshNukeButton(human) {
    const btn = $('btn-nuke');
    const hasSilo = this.game.canNuke(human);
    btn.disabled = !hasSilo || human.gold < NUKE_COST;
    $('nuke-sub').textContent = hasSilo
      ? `${formatShort(NUKE_COST)} gold`
      : 'Requires a Missile Silo';
    if (!btn.disabled) return;
    if (this.state.nukeMode) this.cancelModes();
  }

  #refreshLeaderboard(game, human) {
    const list = $('leaderboard');
    const rows = game.standings().slice(0, 12);
    list.replaceChildren();

    for (const p of rows) {
      const li = document.createElement('li');
      li.className = 'lb-row' + (p.isHuman ? ' is-you' : '');

      const swatch = document.createElement('span');
      swatch.className = 'lb-swatch';
      swatch.style.background = p.color;

      const name = document.createElement('span');
      name.className = 'lb-name';
      name.textContent = p.name;

      const share = document.createElement('span');
      share.className = 'lb-share';
      share.textContent = `${(game.landShare(p) * 100).toFixed(1)}%`;

      li.append(swatch, name, share);

      if (p.traitorScore >= 1) {
        const tag = document.createElement('span');
        tag.className = 'lb-tag';
        tag.textContent = '🗡';
        tag.title = 'Has betrayed an ally';
        li.appendChild(tag);
      }

      if (!p.isHuman) li.appendChild(this.#diplomacyButton(game, human, p));
      list.appendChild(li);
    }
  }

  #diplomacyButton(game, human, other) {
    const dip = game.diplomacy;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lb-btn';

    if (human.allies.has(other.id)) {
      btn.classList.add('betray');
      btn.textContent = 'Betray';
      const allowed = dip.canBreak(human.id, other.id);
      btn.disabled = !allowed;
      btn.title = allowed
        ? 'Break the pact. Other nations will trust you less.'
        : 'The pact is too fresh to break.';
      btn.addEventListener('click', () => {
        dip.breakAlliance(human.id, other.id);
        this.refreshHud(true);
      });
      return btn;
    }

    const pending = dip.pendingBetween(human.id, other.id);
    if (pending) {
      btn.textContent = pending.from === human.id ? 'Sent' : 'Accept';
      btn.disabled = pending.from === human.id;
      if (pending.to === human.id) {
        btn.addEventListener('click', () => {
          dip.accept(pending);
          this.refreshHud(true);
        });
      }
      return btn;
    }

    btn.textContent = 'Ally';
    btn.title = 'Propose a non-aggression pact and open trade';
    btn.addEventListener('click', () => {
      if (dip.propose(human.id, other.id)) {
        this.toast(`Alliance offered to ${other.name}.`);
        this.refreshHud(true);
      }
    });
    return btn;
  }

  #refreshEvents(game) {
    const log = $('eventlog');
    log.replaceChildren();

    // Offers awaiting the player's answer sit above the feed.
    for (const offer of game.diplomacy.offersTo(game.human.id)) {
      const from = game.players[offer.from];
      const li = document.createElement('li');
      const box = document.createElement('div');
      box.className = 'offer';

      const text = document.createElement('span');
      text.className = 'offer-text';
      text.textContent = `${from.name} offers an alliance`;

      const yes = document.createElement('button');
      yes.className = 'lb-btn';
      yes.textContent = 'Accept';
      yes.addEventListener('click', () => {
        game.diplomacy.accept(offer);
        this.refreshHud(true);
      });

      const no = document.createElement('button');
      no.className = 'lb-btn betray';
      no.textContent = 'Decline';
      no.addEventListener('click', () => {
        game.diplomacy.decline(offer);
        this.refreshHud(true);
      });

      box.append(text, yes, no);
      li.appendChild(box);
      log.appendChild(li);
    }

    for (const event of game.events.slice(0, 14)) {
      const li = document.createElement('li');
      li.textContent = event.text;
      li.style.color = event.color;
      log.appendChild(li);
    }
  }

  #refreshAttackHint(game, human) {
    if (this.state.buildMode || this.state.nukeMode) return;
    const attacks = game.attacksBy(human.id);
    const hint = $('mode-hint');
    if (attacks.length === 0) {
      hint.textContent = 'Click enemy or empty land to attack it.';
      hint.classList.remove('is-alert');
      return;
    }
    const total = attacks.reduce((sum, a) => sum + a.troops, 0);
    const names = attacks
      .map((a) => (a.targetId >= 0 ? game.players[a.targetId].name : 'open land'))
      .join(', ');
    hint.textContent = `Attacking ${names} — ${formatShort(total)} troops committed.`;
    hint.classList.add('is-alert');
  }

  showEndScreen(game) {
    const human = game.human;
    const won = game.winner === human;
    $('end-title').textContent = won ? '🏆 Victory' : game.winner ? 'Defeat' : 'Eliminated';
    $('end-body').textContent = won
      ? 'You hold the world. The oceans are yours.'
      : game.winner
        ? `${game.winner.name} has taken the world.`
        : 'Your nation has been erased from the map.';

    const stats = [
      ['Peak territory', `${((human.peakTiles / game.map.landCount) * 100).toFixed(1)}%`],
      ['Structures built', String(human.buildings.length)],
      ['Alliances signed', String(human.allies.size)],
      ['Time survived', formatDuration(game.elapsedSeconds())],
    ];
    const box = $('end-stats');
    box.replaceChildren();
    for (const [k, v] of stats) {
      const kEl = document.createElement('div');
      kEl.className = 'k';
      kEl.textContent = k;
      const vEl = document.createElement('div');
      vEl.className = 'v';
      vEl.textContent = v;
      box.append(kEl, vEl);
    }

    $('endscreen').hidden = false;
  }
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** Accept any text as a seed; identical text always yields the same world. */
function hashSeed(text) {
  const trimmed = String(text ?? '').trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) >>> 0;
  let h = 2166136261;
  for (let i = 0; i < trimmed.length; i++) {
    h ^= trimmed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
