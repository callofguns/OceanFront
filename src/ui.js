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
  DIFFICULTIES,
  DEFAULT_DIFFICULTY,
} from './config.js';
import { formatShort } from './render.js';
import { CURRENT_VERSION, CHANGELOG } from './changelog.js';

const HUD_INTERVAL_MS = 120;
const DRAG_THRESHOLD = 4;
/** How often the leaderboard is allowed to re-sort itself. */
const REORDER_INTERVAL_MS = 1000;

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
      difficulty: DEFAULT_DIFFICULTY,
    };

    this.keys = new Set();
    this.lastHudAt = 0;
    this.toastTimer = null;

    /** Reused DOM per nation / per offer -- see #refreshLeaderboard for why. */
    this.lbRows = new Map();
    this.offerRows = new Map();
    /** Population bar elements -- static, queried once and reused every
     *  refresh (~8x/sec) rather than re-looked-up, same reasoning as the
     *  leaderboard rows: a node swapped out mid-tap can silently drop it. */
    this.popBarEls = {
      bar: $('pop-bar'),
      troops: $('pop-bar-troops'),
      workers: $('pop-bar-workers'),
      pop: $('stat-pop'),
      max: $('stat-pop-max'),
      rate: $('stat-pop-rate'),
    };
    this.lastEventSignature = null;
    /** True while any finger/mouse button is down anywhere on the page. */
    this.pointerIsDown = false;
    this.pointerOverLeaderboard = false;
    this.lastReorderAt = 0;

    this.#restoreSettings();
    this.#buildStartScreen();
    this.#buildChangelog();
    this.#bindGlobalInput();
    this.#bindMobileChrome();
    this.#bindInstallPrompt();
    // Static elements that live for the page's whole lifetime, not per
    // match -- bound exactly once here. (Binding these from attach() instead
    // would stack a fresh set of listeners on every replay, since nothing
    // ever removed the previous set; a toggle button wired twice fires twice
    // per tap and can cancel itself out.)
    this.#bindHudControls();
    this.#trackPointerState();
  }

  /** Lets the HUD know not to rearrange itself out from under a finger. */
  #trackPointerState() {
    const down = () => { this.pointerIsDown = true; };
    const up = () => { this.pointerIsDown = false; };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', up);

    const list = $('leaderboard');
    list.addEventListener('pointerenter', () => { this.pointerOverLeaderboard = true; });
    list.addEventListener('pointerleave', () => { this.pointerOverLeaderboard = false; });
  }

  /**
   * True when the player is plausibly aiming at the leaderboard: a pointer is
   * down, the cursor is over the list, or the Nations sheet is open (which on
   * a phone is only ever opened deliberately, to act on a nation).
   */
  get #leaderboardIsBusy() {
    return (
      this.pointerIsDown ||
      this.pointerOverLeaderboard ||
      $('sidepanel').classList.contains('is-open')
    );
  }

  // ------------------------------------------------------- start screen ---

  #restoreSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('oceanfront.settings') || '{}');
      if (typeof saved.name === 'string' && saved.name.trim()) this.settings.name = saved.name;
      if (PLAYER_COLORS.includes(saved.color)) this.settings.color = saved.color;
      if (MAP_PRESETS[saved.preset]) this.settings.preset = saved.preset;
      if (DIFFICULTIES[saved.difficulty]) this.settings.difficulty = saved.difficulty;
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

    const difficultyPicker = $('difficulty-picker');
    for (const tier of Object.values(DIFFICULTIES)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice' + (tier.key === this.settings.difficulty ? ' is-active' : '');
      btn.appendChild(document.createTextNode(tier.label));
      const small = document.createElement('small');
      small.textContent = tier.key === 'normal' ? 'default' : `${tier.economy}× economy`;
      btn.appendChild(small);
      btn.addEventListener('click', () => {
        this.settings.difficulty = tier.key;
        for (const el of difficultyPicker.children) el.classList.remove('is-active');
        btn.classList.add('is-active');
      });
      difficultyPicker.appendChild(btn);
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
        difficulty: this.settings.difficulty,
      });
    });

    $('btn-again').addEventListener('click', () => {
      $('endscreen').hidden = true;
      $('startscreen').hidden = false;
      seedInput.value = String(Math.floor(Math.random() * 1_000_000));
    });
  }

  /** Small collapsible version tag + release history at the foot of the main menu. */
  #buildChangelog() {
    const details = $('changelog');

    const summary = document.createElement('summary');
    summary.textContent = CURRENT_VERSION;
    details.appendChild(summary);

    const entries = document.createElement('div');
    entries.className = 'entries';
    for (const entry of CHANGELOG) {
      const version = document.createElement('div');
      version.className = 'entry-version';
      version.textContent = entry.version;
      entries.appendChild(version);

      const list = document.createElement('ul');
      for (const note of entry.notes) {
        const li = document.createElement('li');
        li.textContent = note;
        list.appendChild(li);
      }
      entries.appendChild(list);
    }
    details.appendChild(entries);
  }

  // -------------------------------------------------------------- attach ---

  attach(game, renderer) {
    this.game = game;
    this.renderer = renderer;
    this.state.buildMode = null;
    this.state.nukeMode = false;

    // A new match means new nations, so the reused rows from the last one are
    // stale -- drop them and let them be recreated on the next refresh.
    this.lbRows.clear();
    this.offerRows.clear();
    this.lastEventSignature = null;
    $('leaderboard').replaceChildren();
    $('offers').replaceChildren();
    $('eventlog').replaceChildren();

    $('startscreen').hidden = true;
    $('hud').hidden = false;
    $('hud').classList.add('is-spawning');
    $('spawnbanner').hidden = false;
    $('endscreen').hidden = true;

    this.#buildBuildMenu();
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
    const entering = this.state.buildMode !== key;
    this.state.buildMode = entering ? key : null;
    this.#refreshModeUi();
    // Picking a structure means "now go tap the map" -- get the sheet out of
    // the way so the map underneath it is actually reachable.
    if (entering) this.#closeSheets();
  }

  #toggleNukeMode() {
    if (!this.game.canNuke(this.game.human)) {
      this.toast('Build a Missile Silo first.');
      return;
    }
    this.state.buildMode = null;
    const entering = !this.state.nukeMode;
    this.state.nukeMode = entering;
    this.#refreshModeUi();
    if (entering) this.#closeSheets();
  }

  cancelModes() {
    this.state.buildMode = null;
    this.state.nukeMode = false;
    this.#refreshModeUi();
  }

  // ------------------------------------------------------- mobile chrome ---

  /** Wires the phone-width tab bar that turns the three HUD panels into
   *  dismissible bottom sheets. Harmless no-op on desktop widths, where the
   *  tab bar and backdrop stay display:none and the panels ignore .is-open. */
  #bindMobileChrome() {
    for (const btn of document.querySelectorAll('.tab-btn')) {
      btn.addEventListener('click', () => {
        const panel = $(btn.dataset.panel);
        const wasOpen = panel.classList.contains('is-open');
        this.#closeSheets();
        if (!wasOpen) {
          panel.classList.add('is-open');
          btn.classList.add('is-active');
          $('hud').classList.add('has-open-sheet');
        }
      });
    }

    // Click-outside-to-close: the backdrop's own job is purely visual (the
    // dimming) plus physically blocking a tap on the visible map sliver from
    // also reaching the canvas underneath (it sits above the map in z-index,
    // below the sheets and tab bar). The actual "was this outside the open
    // sheet" decision is made once, here, at the document level, so it
    // reliably covers the backdrop *and* anything else outside the sheet.
    document.addEventListener('click', (e) => {
      const openPanel = document.querySelector('#buildpanel.is-open, #sidepanel.is-open, #bottombar.is-open');
      if (!openPanel) return;
      if (openPanel.contains(e.target)) return;
      if (e.target.closest('.tab-btn')) return; // that button's own handler decides what happens
      this.#closeSheets();
    });
  }

  #closeSheets() {
    for (const el of document.querySelectorAll('.is-open')) el.classList.remove('is-open');
    for (const btn of document.querySelectorAll('.tab-btn.is-active')) btn.classList.remove('is-active');
    $('hud').classList.remove('has-open-sheet');
  }

  // ------------------------------------------------------ install prompt ---

  /** Chromium's install flow: capture the browser's own prompt and offer it
   *  through our own banner instead of an unpredictable native UI. iOS Safari
   *  never fires this event -- there, "Add to Home Screen" stays manual via
   *  the Share sheet, which the manifest/apple-touch-icon tags already support. */
  #bindInstallPrompt() {
    let deferredPrompt = null;
    const banner = $('install-banner');

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      if (localStorage.getItem('oceanfront.installDismissed') !== '1') banner.hidden = false;
    });

    $('btn-install').addEventListener('click', async () => {
      banner.hidden = true;
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    });

    $('btn-install-dismiss').addEventListener('click', () => {
      banner.hidden = true;
      try { localStorage.setItem('oceanfront.installDismissed', '1'); } catch { /* fine, just re-asks next visit */ }
    });

    window.addEventListener('appinstalled', () => {
      banner.hidden = true;
      deferredPrompt = null;
    });
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

    // Pointer Events unify mouse/touch/pen, so single-finger tap-to-attack and
    // drag-to-pan above already work untouched on phones. Two simultaneous
    // pointers is a pinch: track both and derive zoom + pan from the pair.
    const pointers = new Map();
    let pinchDist = 0;
    let pinchMidX = 0;
    let pinchMidY = 0;

    const pinchState = () => {
      const [a, b] = pointers.values();
      return {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      };
    };

    const releasePointer = (id) => {
      pointers.delete(id);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 1) {
        // One finger remains after a pinch: resume single-finger panning from
        // its current position instead of jumping back to a stale lastX/lastY.
        const [remaining] = pointers.values();
        pointerDown = true;
        dragged = true;
        lastX = remaining.x;
        lastY = remaining.y;
      }
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.renderer) return;
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 2) {
        pointerDown = false;
        dragged = true; // a second finger means this is never a tap
        canvas.classList.remove('is-panning');
        const p = pinchState();
        pinchDist = p.dist;
        pinchMidX = p.x;
        pinchMidY = p.y;
        return;
      }
      if (pointers.size > 2) return;

      pointerDown = true;
      dragged = false;
      lastX = e.clientX;
      lastY = e.clientY;
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this.renderer) return;
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.state.hoverTile = this.renderer.tileAt(e.clientX, e.clientY);

      if (pointers.size >= 2) {
        const p = pinchState();
        if (pinchDist > 0) {
          this.renderer.pan(p.x - pinchMidX, p.y - pinchMidY);
          this.renderer.zoomAt(p.x, p.y, p.dist / pinchDist);
        }
        pinchDist = p.dist;
        pinchMidX = p.x;
        pinchMidY = p.y;
        return;
      }

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
      const wasTap = pointers.size === 1 && !dragged;
      releasePointer(e.pointerId);
      if (pointers.size === 0) {
        pointerDown = false;
        canvas.classList.remove('is-panning');
      }
      if (wasTap && e.button === 0) this.#handleClick(this.renderer.tileAt(e.clientX, e.clientY));
    });

    canvas.addEventListener('pointercancel', (e) => {
      releasePointer(e.pointerId);
      if (pointers.size === 0) {
        pointerDown = false;
        canvas.classList.remove('is-panning');
      }
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
    this.#refreshAttackingStat(game, human);
    $('stat-workers').textContent = formatShort(human.workers);
    this.#refreshPopBar(human);
    $('stat-gold').textContent = `${formatShort(human.gold)}  (+${human.goldPerSecond.toFixed(1)}/s)`;
    $('stat-land').textContent = `${(game.landShare(human) * 100).toFixed(1)}%`;

    this.#refreshBuildCosts(human);
    this.#refreshNukeButton(human);
    this.#refreshLeaderboard(game, human);
    this.#refreshEvents(game);
    this.#refreshAttackHint(game, human);
  }

  /** Troops currently spent on attacks or a naval invasion -- committed and
   *  unavailable elsewhere, shown as a small separate number next to the
   *  standing-army total. Hidden entirely when nothing is under way. */
  #refreshAttackingStat(game, human) {
    let committed = 0;
    for (const a of game.attacksBy(human.id)) committed += a.troops;
    for (const b of game.boats) if (b.ownerId === human.id) committed += b.troops;

    const el = $('stat-attacking');
    el.hidden = committed < 1;
    if (!el.hidden) el.textContent = formatShort(committed);
  }

  /**
   * Population-cap fill bar: two stacked segments (troops, then workers)
   * sized to pop/maxPop, clamped and composed the same way OpenFrontIO's
   * troop bar is -- a fixed-size base, each segment's raw percentage clamped
   * to [0, 100], and the second clamped again to what's left after the
   * first. `transform`-only updates (no layout) since this runs ~8x/sec.
   */
  #refreshPopBar(human) {
    const els = this.popBarEls;
    const base = Math.max(human.maxPop, 1);
    const troopPct = Math.max(0, Math.min(100, (human.troops / base) * 100));
    const workerPct = Math.max(0, Math.min(100 - troopPct, (human.workers / base) * 100));

    els.troops.style.transform = `scaleX(${troopPct / 100})`;
    els.workers.style.transform = `translateX(${troopPct}%) scaleX(${workerPct / 100})`;
    els.bar.classList.toggle('is-over', human.pop > human.maxPop);

    // Current at the bar's left edge, cap at its right edge, no separator --
    // mirrors OpenFrontIO's mobile troop bar layout exactly (its desktop
    // variant centers "current / max" instead, but at this bar's ~150px
    // width edge-anchored reads more clearly than a centered fraction).
    els.pop.textContent = formatShort(human.pop);
    els.max.textContent = formatShort(human.maxPop);

    // formatShort() only handles non-negative magnitudes (nothing before
    // this called it with a negative number), so the sign is applied here
    // rather than passing a negative straight through.
    const rate = human.popRate;
    const rateText = `${rate < 0 ? '-' : '+'}${formatShort(Math.abs(rate))}/s`;
    if (els.rate.textContent !== rateText) els.rate.textContent = rateText;
    els.rate.classList.toggle('is-falling', rate < 0);
  }

  #refreshBuildCosts(human) {
    for (const key of BUILDING_ORDER) {
      const { btn, cost } = this.buildButtons[key];
      const price = this.game.costFor(human, key);
      const owned = human.countOf(key);
      const text = owned > 0 ? `${formatShort(price)} ·${owned}` : formatShort(price);
      if (cost.textContent !== text) cost.textContent = text;
      cost.classList.toggle('unaffordable', human.gold < price);
      // Build buttons are never disabled -- affordability is shown in the
      // cost colour instead, and the Game rejects an unaffordable placement
      // with a toast that explains why.
      if (btn.disabled) btn.disabled = false;
    }
  }

  #refreshNukeButton(human) {
    const btn = $('btn-nuke');
    const hasSilo = this.game.canNuke(human);
    const disabled = !hasSilo || human.gold < NUKE_COST;
    // Only assign on a real change: gold hovering around the warhead price
    // would otherwise flip `disabled` mid-tap and cancel the click.
    if (btn.disabled !== disabled) btn.disabled = disabled;
    const sub = hasSilo ? `${formatShort(NUKE_COST)} gold` : 'Requires a Missile Silo';
    if ($('nuke-sub').textContent !== sub) $('nuke-sub').textContent = sub;
    if (!disabled) return;
    if (this.state.nukeMode) this.cancelModes();
  }

  /**
   * Updates the leaderboard in place, reusing one row (and one button) per
   * nation for as long as it is listed.
   *
   * This runs ~8x/second. Rebuilding the rows each time -- which is what it
   * used to do -- meant a button could be destroyed between a finger's
   * pointerdown and pointerup; the browser then dispatches `click` on the
   * nearest common ancestor rather than the button, so the handler never
   * fires and the tap is silently lost. That is why buttons "needed several
   * tries" on touch.
   */
  #refreshLeaderboard(game, human) {
    const list = $('leaderboard');
    const rows = game.standings().slice(0, 12);
    const seen = new Set();

    // Standings shuffle constantly in a busy match. Re-sorting on every
    // refresh makes the list jitter, and a row that slides away between
    // aiming and tapping means acting on the wrong nation. So: never reorder
    // while the player is engaging with the list, and otherwise no more than
    // once a second. The displayed values still update live throughout; only
    // the row order is held still.
    const now = performance.now();
    const mayReorder = !this.#leaderboardIsBusy && now - this.lastReorderAt > REORDER_INTERVAL_MS;
    if (mayReorder) this.lastReorderAt = now;

    rows.forEach((p, index) => {
      seen.add(p.id);
      let row = this.lbRows.get(p.id);
      if (!row) {
        row = this.#createLeaderboardRow(p);
        this.lbRows.set(p.id, row);
      }
      this.#updateLeaderboardRow(row, game, human, p);

      // Only touch the DOM position when the order actually changed -- and
      // never while a finger is down. Standings re-sort several times a
      // second, and a row sliding out from under a tap both loses the click
      // and makes the player hit the wrong nation. Order catches up the
      // moment they lift off.
      if (mayReorder && list.children[index] !== row.li) {
        list.insertBefore(row.li, list.children[index] || null);
      } else if (!row.li.isConnected) {
        // A brand new row still has to be inserted, whatever the throttle says.
        list.appendChild(row.li);
      }
    });

    if (!mayReorder) return; // don't yank a row out from under a tap
    for (const [id, row] of this.lbRows) {
      if (seen.has(id)) continue;
      row.li.remove();
      this.lbRows.delete(id);
    }
  }

  #createLeaderboardRow(player) {
    const li = document.createElement('li');
    li.className = 'lb-row';

    const swatch = document.createElement('span');
    swatch.className = 'lb-swatch';

    const name = document.createElement('span');
    name.className = 'lb-name';

    const share = document.createElement('span');
    share.className = 'lb-share';

    const tag = document.createElement('span');
    tag.className = 'lb-tag';
    tag.textContent = '🗡';
    tag.title = 'Has betrayed an ally';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lb-btn';
    // A single listener for the life of the row. It resolves what the action
    // means from live game state at click time, so changing the button's
    // label never requires replacing the element (and losing taps).
    btn.addEventListener('click', () => this.#onDiplomacyAction(player.id));

    li.append(swatch, name, share, tag, btn);
    return { li, swatch, name, share, tag, btn };
  }

  #updateLeaderboardRow(row, game, human, p) {
    const { li, swatch, name, share, tag, btn } = row;

    li.classList.toggle('is-you', p.isHuman);
    if (swatch.style.background !== p.color) swatch.style.background = p.color;
    if (name.textContent !== p.name) name.textContent = p.name;

    const shareText = `${(game.landShare(p) * 100).toFixed(1)}%`;
    if (share.textContent !== shareText) share.textContent = shareText;

    // Kept in the layout either way (visibility, not display) so the row
    // never reflows and nudges the button sideways mid-tap.
    tag.classList.toggle('is-empty', p.traitorScore < 1);

    if (p.isHuman) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;

    const dip = game.diplomacy;
    let label;
    let disabled = false;
    let betray = false;
    let title = '';

    if (human.allies.has(p.id)) {
      label = 'Betray';
      betray = true;
      disabled = !dip.canBreak(human.id, p.id);
      title = disabled
        ? 'The pact is too fresh to break.'
        : 'Break the pact. Other nations will trust you less.';
    } else {
      const pending = dip.pendingBetween(human.id, p.id);
      if (pending) {
        const mine = pending.from === human.id;
        label = mine ? 'Sent' : 'Accept';
        disabled = mine;
        title = mine ? 'Waiting for their answer.' : 'Accept their alliance offer.';
      } else {
        label = 'Ally';
        title = 'Propose a non-aggression pact and open trade';
      }
    }

    if (btn.textContent !== label) btn.textContent = label;
    // Assign `disabled` only on a real change: flipping it while a finger is
    // down would cancel that tap outright.
    if (btn.disabled !== disabled) btn.disabled = disabled;
    btn.classList.toggle('betray', betray);
    if (btn.title !== title) btn.title = title;
  }

  /** Resolves the current meaning of a nation's diplomacy button and acts. */
  #onDiplomacyAction(otherId) {
    const game = this.game;
    if (!game || game.state !== 'playing') return;
    const human = game.human;
    const other = game.players[otherId];
    if (!other?.alive) return;
    const dip = game.diplomacy;

    if (human.allies.has(otherId)) {
      if (!dip.canBreak(human.id, otherId)) return;
      dip.breakAlliance(human.id, otherId);
      this.refreshHud(true);
      return;
    }

    const pending = dip.pendingBetween(human.id, otherId);
    if (pending) {
      if (pending.to !== human.id) return; // ours, still awaiting their answer
      dip.accept(pending);
      this.refreshHud(true);
      return;
    }

    if (dip.propose(human.id, otherId)) {
      this.toast(`Alliance offered to ${other.name}.`);
      this.refreshHud(true);
    }
  }

  #refreshEvents(game) {
    this.#refreshOffers(game);

    // The log is pure text with nothing clickable in it, so rebuilding is
    // harmless -- but still only do it when the content actually changed.
    const events = game.events.slice(0, 14);
    const signature = events.map((e) => `${e.tick}:${e.text}`).join('|');
    if (signature === this.lastEventSignature) return;
    this.lastEventSignature = signature;

    const log = $('eventlog');
    log.replaceChildren();
    for (const event of events) {
      const li = document.createElement('li');
      li.textContent = event.text;
      li.style.color = event.color;
      log.appendChild(li);
    }
  }

  /**
   * Alliance offers, kept in their own container and keyed by sender so an
   * offer's Accept/Decline buttons survive across refreshes. Rebuilding these
   * on a timer would make them just as untappable as the leaderboard was.
   */
  #refreshOffers(game) {
    const box = $('offers');
    const offers = game.diplomacy.offersTo(game.human.id);
    const seen = new Set();

    offers.forEach((offer, index) => {
      seen.add(offer.from);
      let row = this.offerRows.get(offer.from);
      if (!row) {
        row = this.#createOfferRow(offer.from);
        this.offerRows.set(offer.from, row);
      }
      const fromName = game.players[offer.from]?.name ?? 'A nation';
      const text = `${fromName} offers an alliance`;
      if (row.text.textContent !== text) row.text.textContent = text;
      if (box.children[index] !== row.el) box.insertBefore(row.el, box.children[index] || null);
    });

    for (const [fromId, row] of this.offerRows) {
      if (seen.has(fromId)) continue;
      row.el.remove();
      this.offerRows.delete(fromId);
    }
  }

  #createOfferRow(fromId) {
    const el = document.createElement('div');
    el.className = 'offer';

    const text = document.createElement('span');
    text.className = 'offer-text';

    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'lb-btn';
    yes.textContent = 'Accept';
    yes.addEventListener('click', () => {
      const offer = this.game?.diplomacy.offersTo(this.game.human.id).find((o) => o.from === fromId);
      if (!offer) return;
      this.game.diplomacy.accept(offer);
      this.refreshHud(true);
    });

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'lb-btn betray';
    no.textContent = 'Decline';
    no.addEventListener('click', () => {
      const offer = this.game?.diplomacy.offersTo(this.game.human.id).find((o) => o.from === fromId);
      if (!offer) return;
      this.game.diplomacy.decline(offer);
      this.refreshHud(true);
    });

    el.append(text, yes, no);
    return { el, text };
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
