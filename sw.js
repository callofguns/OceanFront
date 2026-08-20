// Service worker: makes OceanFront installable and playable offline.
//
// Network-first, falling back to cache: an online player always gets
// whatever is actually live (no stale-cache surprises after a deploy), and
// an offline player gets the last copy that was successfully fetched. Bump
// CACHE_VERSION on a release that removes/renames files, to drop the old
// ones from storage -- it is not required for routine updates to propagate,
// since those are picked up on the very next fetch regardless.

const CACHE_VERSION = 'v6';
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
  'src/maps/world.js',
  'src/names.js',
  'src/player.js',
  'src/render.js',
  'src/rng.js',
  'src/tribe.js',
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
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => {
          if (cached) return cached;
          // Offline, nothing cached for this exact request: for navigations,
          // fall back to the shell so the app still opens instead of showing
          // the browser's error page.
          if (req.mode === 'navigate') return caches.match('index.html');
          throw new Error('offline and not cached');
        })
      )
  );
});
