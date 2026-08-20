// Entry point: owns the match lifecycle and the fixed-timestep loop.
//
// The simulation advances in whole ticks of TICK_MS regardless of frame rate,
// so a slow machine sees the same game as a fast one -- it just renders less
// often. Rendering happens once per animation frame.

import { TICK_MS } from './config.js';
import { Game } from './game.js';
import { Renderer } from './render.js';
import { UI } from './ui.js';

const canvas = document.getElementById('map');
const ui = new UI(canvas);

let game = null;
let renderer = null;
let speed = 1;
let accumulator = 0;
let lastFrame = performance.now();
let endShown = false;

ui.onStart = (options) => {
  game = new Game(options);
  renderer = new Renderer(canvas, game);
  renderer.resize();
  renderer.fitToScreen();

  accumulator = 0;
  lastFrame = performance.now();
  endShown = false;
  speed = 1;

  ui.attach(game, renderer);
};

// Debug handle: lets you poke at a live match from the console, and lets
// automated tests drive the real game instead of a mock.
window.OceanFront = {
  get game() { return game; },
  get renderer() { return renderer; },
  get ui() { return ui; },
};

ui.onSpeed = (value) => {
  speed = value;
};

// "New game" from the in-match pause menu: stop the live match cleanly so
// the frame loop's own game/renderer references go away, rather than
// leaving the old match ticking invisibly behind the main menu (the loop
// below only checks these closure vars, not anything on ui).
ui.onExit = () => {
  game = null;
  renderer = null;
  accumulator = 0;
  endShown = false;
  speed = 1;
};

window.addEventListener('resize', () => {
  if (renderer) renderer.resize();
});

function frame(now) {
  requestAnimationFrame(frame);

  const elapsed = Math.min(250, now - lastFrame);
  lastFrame = now;

  if (!game || !renderer) return;

  ui.applyKeyboardPan(elapsed * 0.06);

  if (game.state === 'playing' && speed > 0) {
    accumulator += elapsed * speed;
    // Cap catch-up work so a background tab does not freeze on return.
    let budget = 12;
    while (accumulator >= TICK_MS && budget-- > 0) {
      game.tick();
      accumulator -= TICK_MS;
    }
    if (accumulator > TICK_MS * 12) accumulator = 0;
  }

  renderer.draw(ui.state);
  ui.refreshHud();

  if (game.state === 'over' && !endShown) {
    endShown = true;
    ui.showEndScreen(game);
  }
}

requestAnimationFrame(frame);

// Registering the service worker makes the game installable and playable
// offline. It's entirely additive -- if this fails (unsupported browser,
// file:// origin, etc.) the game just runs online as it always did.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // updateViaCache: 'none' stops the browser's own HTTP cache from ever
    // serving a stale copy of sw.js when checking for updates -- without it,
    // a fix can ship and still not be detected for a while.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch((err) => {
      console.warn('Service worker registration failed:', err);
    });

    // The new service worker activates (skipWaiting + clients.claim) without
    // waiting for this tab to close, but this tab's already-parsed CSS/JS
    // won't retroactively change -- so once a new one *replaces an existing
    // one*, reload once to actually pick up whatever it just fixed. Skip this
    // on a first-ever install, where there was no prior controller and
    // nothing to refresh -- claiming a brand new client also fires
    // controllerchange, and reloading there would just be a pointless flash.
    const hadControllerAlready = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadControllerAlready || reloading) return;
      reloading = true;
      window.location.reload();
    });
  });
}
