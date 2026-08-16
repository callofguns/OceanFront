// Service worker: makes OceanFront installable and playable offline.
//
// Everything the game needs is a fixed set of local files with no server
// calls once loaded, so a simple cache-first strategy is enough -- there is
// no API data to go stale. Bump CACHE_VERSION on any release that changes
// shipped files; that busts old caches on the next visit.

const CACHE_VERSION = 'v1';
const CACHE_NAME = `oceanfront-${CACHE_VERSION}`;

const PRECACHE = [
  './',
  'index.html',
  'styles.css',
  'manifest.json',
  'src/ai.js',
  'src/config.js',
  'src/diplomacy.js',
  'src/game.js',
  'src/main.js',
  'src/map.js',
  'src/names.js',
  'src/player.js',
  'src/render.js',
  'src/rng.js',
  'src/ui.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // no third-party requests exist, but be explicit

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // Offline and not cached: for navigations, fall back to the shell
          // so the app still opens instead of showing the browser's error page.
          if (req.mode === 'navigate') return caches.match('index.html');
          throw new Error('offline and not cached');
        });
    })
  );
});
