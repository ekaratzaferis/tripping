// Offline support: app shell is cached up front, map tiles and CDN assets are
// cached as you browse (so areas you've looked at work in the metro).
const VERSION = 'triparw-v3';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icon.svg',
  'js/app.js', 'js/util.js', 'js/store.js', 'js/trip.js', 'js/geo.js', 'js/map.js', 'js/engine.js',
  'js/services.js', 'js/exif.js', 'js/ui.js',
  'js/views/live.js', 'js/views/plan.js', 'js/views/lists.js', 'js/views/timeline.js', 'js/views/settings.js', 'js/views/details.js',
  'data/barcelona-2026.json',
];
const TILE_CACHE = 'triparw-tiles';
const MAX_TILES = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Vector tiles, fonts and sprites: cache-first (immutable URLs).
  // Style / tile index JSON: network-first so tile versions stay current.
  if (url.hostname === 'tiles.openfreemap.org') {
    const immutable = /\.(pbf|png|webp)$/.test(url.pathname) || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/sprites/');
    if (immutable) {
      e.respondWith(caches.open(TILE_CACHE).then(async (c) => {
        const hit = await c.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) { c.put(request, res.clone()); trimTiles(); }
        return res;
      }));
    } else {
      e.respondWith(fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(TILE_CACHE).then((c) => c.put(request, copy));
        return res;
      }).catch(() => caches.match(request)));
    }
    return;
  }

  // Our own files + CDN libs/fonts: network-first so updates land, cache fallback offline.
  const cacheable = url.origin === location.origin || /cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.hostname);
  if (!cacheable) return;
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request, { ignoreSearch: url.origin === location.origin })),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => {
    const c = list.find((w) => 'focus' in w);
    return c ? c.focus() : self.clients.openWindow('./#/live');
  }));
});
