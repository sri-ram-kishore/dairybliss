// ============================================================
//  Dairy Bliss Ops — Service Worker
//  Strategy: network-first for pages (HTML) so the dashboard
//  always reflects the latest deploy; cache-first for static
//  assets. API calls to the backend always hit the network —
//  this is a live dashboard, not something to serve stale.
// ============================================================

const CACHE_NAME = 'dairy-bliss-ops-v1';

const PRECACHE_ASSETS = [
  './',
  './manifest.json',
  '../assets/icon-ops-any-192.png',
  '../assets/logo.webp',
];

// ── INSTALL ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Precache partial failure:', err))
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Backend API calls always go straight to network — dashboard
  // data (orders, expenses, PIN auth) must never be served stale.
  if (url.hostname.includes('script.google.com')) {
    event.respondWith(fetch(request));
    return;
  }

  // Network-first for pages: staff always get the latest deploy,
  // falling back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('./')))
    );
    return;
  }

  // Cache-first for static assets (icons, logo)
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request)
        .then(response => {
          if (
            response &&
            response.status === 200 &&
            response.type === 'basic'
          ) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, clone));
          }
          return response;
        })
        .catch(() => new Response('Offline', { status: 503 }));
    })
  );
});
