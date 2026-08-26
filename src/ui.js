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
  KEYBOARD_PAN_SPEED,
  SFX_VOLUME_DEFAULT,
  MUSIC_VOLUME_DEFAULT,
  TEAM_MODES,
  DEFAULT_TEAM_MODE,
} from './config.js';
import { formatShort } from './render.js';
import { CURRENT_VERSION, CHANGELOG, UPCOMING } from './changelog.js';
import { SoundBoard } from './sound.js';

const HUD_INTERVAL_MS = 120;
const DRAG_THRESHOLD = 4;
/** How often the leaderboard is allowed to re-sort itself. */
const REORDER_INTERVAL_MS = 1000;
/** Debounce window for persisting a setting changed via a live control (a
 *  pause-menu slider) rather than the Start button -- long enough to not
 *  write to localStorage on every input event of a drag, short enough that
 *  closing the tab a moment later doesn't lose the change. */
const SETTINGS_SAVE_DEBOUNCE_MS = 250;

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(canvas) {
    this.canvas = canvas;
    this.game = null;
    this.renderer = null;

    /** Set by main.js. */
    this.onStart = null;
    this.onSpeed = null;
    this.onExit = null;

    /** The exact options last passed to onStart -- so Restart Match (from
     *  the pause menu) can replay the same seed/settings instead of
     *  re-reading form fields that may have changed since (the seed input
     *  in particular gets re-randomized after Play Again). */
    this._lastStartOptions = null;
    /** Speed button active when the pause menu was opened, so Resume can
     *  restore it -- unless the player had already paused manually first,
     *  in which case Resume leaves it paused rather than un-pausing a state
     *  the player chose themselves. */
    this._speedBeforePause = null;

    this.state = { hoverTile: -1, buildMode: null, nukeMode: false };

    this.settings = {
      name: 'Player',
      color: PLAYER_COLORS[0],
      preset: 'medium',
      difficulty: DEFAULT_DIFFICULTY,
      teamMode: DEFAULT_TEAM_MODE,
      sfxVolume: SFX_VOLUME_DEFAULT,
      musicVolume: MUSIC_VOLUME_DEFAULT,
      muted: false,
    };

    // Constructed before #restoreSettings() so the sound.js module has
    // parsed and a board exists regardless of what's in localStorage --
    // it builds no AudioContext yet (browsers block that before a user
    // gesture), just holds settings until unlock() is called from Start.
    this.sound = new SoundBoard({
      sfxVolume: this.settings.sfxVolume,
      musicVolume: this.settings.musicVolume,
      muted: this.settings.muted,
    });
    this._saveSettingsTimer = null;

    this.keys = new Set();
    this.lastHudAt = 0;
    this.toastTimer = null;

    /** Reused DOM per nation / per offer -- see #refreshLeaderboard for why. */
    this.lbRows = new Map();
    this.offerRows = new Map();
    /** Troop bar elements -- static, queried once and reused every refresh
     *  (~8x/sec) rather than re-looked-up, same reasoning as the
     *  leaderboard rows: a node swapped out mid-tap can silently drop it. */
    this.popBarEls = {
      bar: $('pop-bar'),
      troops: $('pop-bar-troops'),
      attacking: $('pop-bar-attacking'),
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
    // Reflect whatever #restoreSettings just pulled from localStorage onto
    // the board that was built with plain defaults above -- unlock() has
    // not run yet, so this only updates stored volume state, never touches
    // an AudioContext.
    this.sound.setSfxVolume(this.settings.sfxVolume);
    this.sound.setMusicVolume(this.settings.musicVolume);
    this.sound.setMuted(this.settings.muted);
    this.#buildStartScreen();
    this.#buildChangelog();
    this.#buildHelpModal();
    this.#buildPauseMenu();
    this.#buildSoundControls();
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
      if (TEAM_MODES[saved.teamMode]) this.settings.teamMode = saved.teamMode;
      if (typeof saved.sfxVolume === 'number' && saved.sfxVolume >= 0 && saved.sfxVolume <= 1) {
        this.settings.sfxVolume = saved.sfxVolume;
      }
      if (typeof saved.musicVolume === 'number' && saved.musicVolume >= 0 && saved.musicVolume <= 1) {
        this.settings.musicVolume = saved.musicVolume;
      }
      if (typeof saved.muted === 'boolean') this.settings.muted = saved.muted;
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

  /** #saveSettings() otherwise has exactly one call site -- the Start
   *  button -- so a volume dragged in the pause menu mid-match would never
   *  reach localStorage under the plain pattern above. Every live control
   *  (the sound sliders, the mute button) routes through this instead. */
  #saveSettingsSoon() {
    clearTimeout(this._saveSettingsTimer);
    this._saveSettingsTimer = setTimeout(() => this.#saveSettings(), SETTINGS_SAVE_DEBOUNCE_MS);
  }

  #buildStartScreen() {
    const nameInput = $('name-input');
    nameInput.value = this.settings.name;
    nameInput.addEventListener('input', () => {
      this.settings.name = nameInput.value;
    });

    // The hero identity block washes toward the picked colour -- the direct
    // equivalent of OpenFrontIO's username input laid over the player's
    // selected cosmetic pattern, done with a colour wash since OceanFront
    // has no skins/patterns to render. Set once up front for the restored
    // colour, then again on every pick below.
    const heroIdentity = $('hero-identity');
    const applyWash = (color) => { heroIdentity.style.setProperty('--wash', color); };
    applyWash(this.settings.color);

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
        applyWash(color);
      });
      colorPicker.appendChild(dot);
    }

    // World size doubles as this menu's one big visual choice, the closest
    // thing a single-player game has to OpenFrontIO's own lobby-card grid --
    // so each option gets a small abstract scale indicator (filled squares,
    // no image asset) alongside the label, rather than plain text alone.
    const sizePicker = $('size-picker');
    const presets = Object.values(MAP_PRESETS);
    // Filled segments come from how big the world actually is, not from the
    // preset's position in the list: hand-drawn maps sit alongside the
    // generated sizes and have their own fixed dimensions, so counting by
    // index would run off the end of the three segments.
    const biggest = Math.max(...presets.map((p) => p.w * p.h));
    presets.forEach((preset) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice size-card' + (preset.key === this.settings.preset ? ' is-active' : '');

      const filled = Math.max(1, Math.ceil(((preset.w * preset.h) / biggest) * 3));
      const scale = document.createElement('span');
      scale.className = 'size-scale';
      for (let i = 0; i < 3; i++) {
        const seg = document.createElement('span');
        seg.className = 'size-scale-seg' + (i < filled ? ' is-filled' : '');
        scale.appendChild(seg);
      }
      btn.appendChild(scale);

      const body = document.createElement('span');
      body.className = 'size-card-body';
      body.appendChild(document.createTextNode(preset.label));
      const small = document.createElement('small');
      small.textContent = `${preset.bots} rivals, ${preset.tribes} tribes`;
      body.appendChild(small);
      btn.appendChild(body);

      btn.addEventListener('click', () => {
        this.settings.preset = preset.key;
        for (const el of sizePicker.children) el.classList.remove('is-active');
        btn.classList.add('is-active');
      });
      sizePicker.appendChild(btn);
    });

    const difficultyPicker = $('difficulty-picker');
    for (const tier of Object.values(DIFFICULTIES)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice' + (tier.key === this.settings.difficulty ? ' is-active' : '');
      btn.appendChild(document.createTextNode(tier.label));
      const small = document.createElement('small');
      small.textContent = tier.key === 'normal' ? 'default' : `${tier.goldMultiplier}× economy`;
      btn.appendChild(small);
      btn.addEventListener('click', () => {
        this.settings.difficulty = tier.key;
        for (const el of difficultyPicker.children) el.classList.remove('is-active');
        btn.classList.add('is-active');
      });
      difficultyPicker.appendChild(btn);
    }

    const teamPicker = $('team-picker');
    for (const mode of Object.values(TEAM_MODES)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice' + (mode.key === this.settings.teamMode ? ' is-active' : '');
      btn.appendChild(document.createTextNode(mode.label));
      const small = document.createElement('small');
      small.textContent = mode.teamSize === 1 ? 'default' : `${mode.teamSize} per team`;
      btn.appendChild(small);
      btn.addEventListener('click', () => {
        this.settings.teamMode = mode.key;
        for (const el of teamPicker.children) el.classList.remove('is-active');
        btn.classList.add('is-active');
      });
      teamPicker.appendChild(btn);
    }

    const seedInput = $('seed-input');
    seedInput.value = String(Math.floor(Math.random() * 1_000_000));

    $('btn-start').addEventListener('click', () => {
      // A real click handler is the one place the browser's autoplay
      // policy actually permits building an AudioContext -- do it first,
      // synchronously, inside the gesture (unlock() is idempotent, so a
      // Restart Match reaching #btn-start again is harmless).
      this.sound.unlock();
      const name = (nameInput.value || 'Player').trim().slice(0, 16) || 'Player';
      this.settings.name = name;
      this.#saveSettings();
      const options = {
        preset: MAP_PRESETS[this.settings.preset],
        seed: hashSeed(seedInput.value),
        playerName: name,
        playerColor: this.settings.color,
        difficulty: this.settings.difficulty,
        teamMode: this.settings.teamMode,
      };
      this._lastStartOptions = options;
      this.onStart?.(options);
    });

    $('btn-again').addEventListener('click', () => {
      $('endscreen').hidden = true;
      this.#returnToMenu();
      seedInput.value = String(Math.floor(Math.random() * 1_000_000));
    });
  }

  /** Shared by "Play again" (from the end screen) and "New game" (from the
   *  in-match pause menu) -- both mean "stop whatever match exists and show
   *  the start screen again". Only the pause menu needs onExit, since a
   *  match reaching the end screen has already run its course on its own;
   *  calling it there too would be a harmless no-op (main.js's game/renderer
   *  are still valid until a new one replaces them via onStart). */
  #returnToMenu() {
    this.sound.stopMusic();
    this.onExit?.();
    // main.js resets its own speed variable to 1x on the next onStart, but
    // never touches the speed buttons themselves -- do it here so a match
    // left running at 2x/3x doesn't visually carry that into the next one.
    for (const b of document.querySelectorAll('.speed-btn')) b.classList.remove('is-active');
    document.querySelector('.speed-btn[data-speed="1"]')?.classList.add('is-active');
    $('hud').hidden = true;
    $('startscreen').hidden = false;
  }

  /** Promoted from an inline <details> to a real popup, same pattern as
   *  #buildChangelog -- reachable from the main menu and from the in-match
   *  pause menu, so (unlike before) it's available mid-match too. */
  #buildHelpModal() {
    const modal = $('help-modal');
    const close = () => { modal.hidden = true; };
    $('help-tag').addEventListener('click', () => { modal.hidden = false; });
    $('help-close').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) close();
    });
  }

  /** In-match menu, reached from the topbar's gear button. Opening it pauses
   *  the simulation via the existing speed-button mechanism, remembering
   *  whichever speed was active so Resume can restore it -- unless the
   *  player had already paused manually before opening the menu, in which
   *  case Resume leaves it paused rather than un-pausing a state they chose
   *  themselves. This mirrors OpenFrontIO's own pauseGame()/
   *  wasPausedWhenOpened behaviour, not just its look. */
  #buildPauseMenu() {
    const modal = $('pausemenu');

    const open = () => {
      if (!this.game || this.game.state === 'over') return;
      const active = document.querySelector('.speed-btn.is-active');
      this._speedBeforePause = active?.dataset.speed ?? '1';
      if (this._speedBeforePause !== '0') document.querySelector('.speed-btn[data-speed="0"]')?.click();
      modal.hidden = false;
    };
    const close = () => {
      modal.hidden = true;
      if (this._speedBeforePause && this._speedBeforePause !== '0') {
        document.querySelector(`.speed-btn[data-speed="${this._speedBeforePause}"]`)?.click();
      }
      this._speedBeforePause = null;
    };

    $('btn-pause-menu').addEventListener('click', open);
    $('pause-close').addEventListener('click', close);
    $('pause-resume').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) close();
    });

    $('pause-help').addEventListener('click', () => { $('help-modal').hidden = false; });

    // Restart and Exit both replace or tear down the match outright, so
    // there is no prior speed worth restoring -- main.js's onStart sets its
    // own speed back to 1x regardless, and #returnToMenu resets the speed
    // buttons to match. Clear the remembered speed rather than restoring it
    // through close(), which would just be immediately overwritten.
    $('pause-restart').addEventListener('click', () => {
      modal.hidden = true;
      this._speedBeforePause = null;
      if (this._lastStartOptions) this.onStart?.(this._lastStartOptions);
    });
    $('pause-exit').addEventListener('click', () => {
      modal.hidden = true;
      this._speedBeforePause = null;
      this.#returnToMenu();
    });
  }

  /** Sound section of the pause menu: two volume sliders and a mute button,
   *  found by `data-volume`/`data-mute` attribute rather than a fixed id so
   *  a second copy of the same markup (e.g. on the start screen, someday)
   *  is wired for free. Also suspends/resumes the audio context when the
   *  tab is hidden/shown, so a backgrounded tab doesn't keep droning. */
  #buildSoundControls() {
    for (const el of document.querySelectorAll('[data-volume]')) {
      el.addEventListener('input', () => this.#onVolumeInput(el));
    }
    for (const btn of document.querySelectorAll('[data-mute]')) {
      btn.addEventListener('click', () => this.#toggleMute());
    }
    this.#syncSoundUi();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.sound.suspend();
      else this.sound.resume();
    });
  }

  #onVolumeInput(el) {
    const kind = el.dataset.volume;
    const v = Number(el.value) / 100;
    if (kind === 'music') {
      this.settings.musicVolume = v;
      this.sound.setMusicVolume(v);
    } else {
      this.settings.sfxVolume = v;
      this.sound.setSfxVolume(v);
    }
    const label = el.closest('.slider')?.querySelector('.slider-head b');
    if (label) label.textContent = `${el.value}%`;
    this.#saveSettingsSoon();
  }

  #toggleMute() {
    this.settings.muted = !this.settings.muted;
    this.sound.setMuted(this.settings.muted);
    this.#syncSoundUi();
    this.#saveSettingsSoon();
  }

  /** Reflects settings.{sfxVolume,musicVolume,muted} onto every matching
   *  control. Called once at startup and after anything (the mute hotkey,
   *  a slider) changes those settings out from under the DOM. */
  #syncSoundUi() {
    for (const el of document.querySelectorAll('[data-volume]')) {
      const kind = el.dataset.volume;
      const value = kind === 'music' ? this.settings.musicVolume : this.settings.sfxVolume;
      const pct = Math.round(value * 100);
      el.value = String(pct);
      const label = el.closest('.slider')?.querySelector('.slider-head b');
      if (label) label.textContent = `${pct}%`;
    }
    for (const btn of document.querySelectorAll('[data-mute]')) {
      btn.classList.toggle('is-active', this.settings.muted);
      const icon = btn.querySelector('.icon');
      const title = btn.querySelector('.title');
      if (icon) icon.textContent = this.settings.muted ? '🔇' : '🔊';
      if (title) title.textContent = this.settings.muted ? 'Unmute sound' : 'Mute sound';
    }
  }

  /** Small version tag at the foot of the main menu; opens the release
   *  history as a popup, on both desktop and mobile -- the same `.overlay`/
   *  `.dialog` pattern the start/end screens already use, not the mobile
   *  bottom-sheet system (this doesn't need to survive a narrow-viewport
   *  swipe-up interaction, just to appear centered over whatever's behind it). */
  #buildChangelog() {
    const tag = $('changelog-tag');
    tag.textContent = CURRENT_VERSION;

    // The roadmap lives in its own element rather than inside
    // #changelog-entries, so anything reading that container still sees
    // exactly the shipped releases and nothing else.
    const upcoming = $('upcoming-list');
    for (const item of UPCOMING) {
      const li = document.createElement('li');
      li.textContent = item;
      upcoming.appendChild(li);
    }

    const entries = $('changelog-entries');
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

    const modal = $('changelog-modal');
    const close = () => { modal.hidden = true; };
    tag.addEventListener('click', () => { modal.hidden = false; });
    $('changelog-close').addEventListener('click', close);
    // Tapping/clicking the backdrop closes it; clicking inside the dialog
    // (including its own empty padding, which is still a `.dialog` target,
    // not a child's) does not -- e.target === modal is only true when the
    // click landed on the fixed, full-screen overlay itself.
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) close();
    });
  }

  // -------------------------------------------------------------- attach ---

  attach(game, renderer) {
    this.game = game;
    this.renderer = renderer;
    this.state.buildMode = null;
    this.state.nukeMode = false;

    // Rebinding on every attach (not just the first) matters for Restart
    // Match / Play again -- bind() replaces the previous game's onEvent
    // with this one's, so a stale reference to the old Game never lingers.
    this.sound.bind(game);
    this.sound.startMusic();

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
    // Both actions that reach onStart mid-match (Restart Match) already hide
    // this and clear the tracked speed themselves, but a fresh attach() is a
    // reasonable place to guarantee it regardless of how it was reached.
    $('pausemenu').hidden = true;
    this._speedBeforePause = null;

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
      btn.addEventListener('click', () => {
        this.sound.play('click');
        this.#toggleBuildMode(key);
      });
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

    $('btn-nuke').addEventListener('click', () => {
      this.sound.play('click');
      this.#toggleNukeMode();
    });
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
    $('attack-ratio').value = String(attack);
    $('attack-ratio-value').textContent = `${attack}%`;
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
    // Nothing to refresh before a match has actually built the build menu --
    // reachable pre-game via cancelModes(), since Escape calls it
    // unconditionally regardless of whether a game is running.
    if (!this.buildButtons) return;
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
      if (e.key.toLowerCase() === 'm') this.#toggleMute();
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
    const step = KEYBOARD_PAN_SPEED * dt;
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
    if (targetId >= 0 && game.isFriendly(human.id, targetId)) {
      const other = game.players[targetId];
      this.toast(
        other.teamId !== null && other.teamId === human.teamId
          ? `${other.name} is on your team.`
          : `You are allied with ${other.name}. Break the pact first.`
      );
      return;
    }

    const troops = human.troops * human.attackRatio;
    if (game.borders(human, targetId)) {
      // launchAttack nets a new attack against whatever the target already
      // has coming the other way (see Game#launchAttack) -- a null result
      // can now mean "consumed meeting their invasion", not just "too few
      // troops", and the generic toast would be actively misleading there.
      const beingInvadedByTarget = game.attacksOn(human.id).some((a) => a.attackerId === targetId);
      const attack = game.launchAttack(human, targetId, troops);
      if (!attack) {
        this.toast(
          beingInvadedByTarget
            ? `Your attack was consumed meeting ${game.players[targetId].name}'s invasion.`
            : 'Not enough troops to mount that attack.'
        );
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
    const committed = this.#committedTroops(game, human);
    this.#refreshAttackingStat(committed);
    this.#refreshPopBar(human, committed);
    // Whole gold/sec, not tenths -- income is a bigger, steadier number now
    // that gold trickles in at a flat rate (see GOLD_BASE_RATE) rather than
    // fluctuating with a worker headcount, so a decimal no longer earns its
    // width in the topbar.
    $('stat-gold').textContent = `${formatShort(human.gold)}  (+${Math.round(human.goldPerSecond)}/s)`;
    $('stat-land').textContent = `${(game.landShare(human) * 100).toFixed(1)}%`;

    this.#refreshBuildCosts(human);
    this.#refreshNukeButton(human);
    this.#refreshLeaderboard(game, human);
    this.#refreshEvents(game);
    this.#refreshAttackHint(game, human);
  }

  /** Troops currently committed to attacks or a naval invasion -- shared by
   *  the small standing-army stat and the troop bar's second segment. */
  #committedTroops(game, human) {
    let committed = 0;
    for (const a of game.attacksBy(human.id)) committed += a.troops;
    for (const b of game.boats) if (b.ownerId === human.id) committed += b.troops;
    return committed;
  }

  /** Small number next to the standing-army total -- hidden entirely when
   *  nothing is under way. */
  #refreshAttackingStat(committed) {
    const el = $('stat-attacking');
    el.hidden = committed < 1;
    if (!el.hidden) el.textContent = formatShort(committed);
  }

  /**
   * Troop-cap fill bar, matching OpenFrontIO's own troop bar exactly: two
   * stacked segments against maxTroops -- standing troops, then troops
   * currently committed to attacks -- clamped and composed the same way
   * theirs is (a fixed-size base, each segment's raw percentage clamped to
   * [0, 100], and the second clamped again to what's left after the
   * first). `transform`-only updates (no layout) since this runs ~8x/sec.
   */
  #refreshPopBar(human, committed) {
    const els = this.popBarEls;
    const base = Math.max(human.maxTroops, 1);
    const troopPct = Math.max(0, Math.min(100, (human.troops / base) * 100));
    const attackingPct = Math.max(0, Math.min(100 - troopPct, (committed / base) * 100));

    els.troops.style.transform = `scaleX(${troopPct / 100})`;
    els.attacking.style.transform = `translateX(${troopPct}%) scaleX(${attackingPct / 100})`;
    els.bar.classList.toggle('is-over', human.troops > human.maxTroops);

    // Current at the bar's left edge, cap at its right edge, no separator --
    // mirrors OpenFrontIO's mobile troop bar layout exactly (its desktop
    // variant centers "current / max" instead, but at this bar's ~150px
    // width edge-anchored reads more clearly than a centered fraction).
    els.pop.textContent = formatShort(human.troops);
    els.max.textContent = formatShort(human.maxTroops);

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

    const team = document.createElement('span');
    team.className = 'lb-team';

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

    li.append(swatch, team, name, share, tag, btn);
    return { li, swatch, team, name, share, tag, btn };
  }

  #updateLeaderboardRow(row, game, human, p) {
    const { li, swatch, team, name, share, tag, btn } = row;

    const teammate = !p.isHuman && p.teamId !== null && p.teamId === human.teamId;
    li.classList.toggle('is-you', p.isHuman);
    li.classList.toggle('is-tribe', p.isTribe);
    li.classList.toggle('is-teammate', teammate);
    if (swatch.style.background !== p.color) swatch.style.background = p.color;

    // Kept in the layout either way (visibility, not display), same
    // reasoning as the traitor tag below -- a row must never reflow mid-tap.
    const showTeam = game.teamSize > 1 && p.teamId !== null;
    team.classList.toggle('is-empty', !showTeam);
    if (showTeam) {
      const letter = String.fromCharCode(65 + p.teamId);
      if (team.textContent !== letter) team.textContent = letter;
      const teamTitle = teammate ? 'Your team' : `Team ${letter}`;
      if (team.title !== teamTitle) team.title = teamTitle;
    }

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
    // A team is permanent -- there is nothing to offer and nothing to
    // break, so the row simply has no diplomacy action, same as your own.
    if (teammate) {
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
    // A team win is credited to whichever member personally held the most
    // land (game.winner stays a single Player either way) -- teamMembers()
    // tells the difference between that and a solo "team" of one, which is
    // what keeps every branch below inert in a solo match: nobody else
    // ever shares a solo player's teamId.
    const winningTeam = game.teamMembers(game.winningTeamId);
    const teamWin = winningTeam.length > 1;
    const wonPersonally = game.winner === human;
    const won = wonPersonally || (game.winningTeamId != null && game.winningTeamId === human.teamId);
    this.sound.stopMusic();
    this.sound.play(won ? 'victory' : 'defeat');
    $('end-title').textContent = won ? '🏆 Victory' : game.winner ? 'Defeat' : 'Eliminated';
    $('end-body').textContent = won
      ? wonPersonally
        ? teamWin
          ? 'You and your team hold the world. The oceans are yours.'
          : 'You hold the world. The oceans are yours.'
        : 'Your team holds the world. The oceans are yours.'
      : game.winner
        ? teamWin
          ? `${game.winner.name} and team have taken the world.`
          : `${game.winner.name} has taken the world.`
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
