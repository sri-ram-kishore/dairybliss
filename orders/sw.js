// ============================================================
//  Dairy Bliss — Service Worker
//  Strategy: network-first for pages (HTML) so deploys arrive
//  without a cache-version bump; cache-first for static assets.
//  Failed order submissions are queued in localStorage and
//  retried via Background Sync.
// ============================================================

const CACHE_NAME = 'dairy-bliss-v9';

// Assets to precache on install (all order apps + shared shell)
const PRECACHE_ASSETS = [
  './',
  './manifest.json',
  './spc/',
  './spc/manifest.json',
  './bnr/',
  './bnr/manifest.json',
  './adg/',
  './adg/manifest.json',
  './bnl/',
  './bnl/manifest.json',
  './icons/icon-any-192.png',
  './icons/favicon.png',
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

// Pick the right offline page for a navigation request: each installed
// per-apartment app must fall back to its own order form, not the
// apartment picker.
function offlineFallbackFor(url) {
  if (url.pathname.includes('/orders/spc')) return caches.match('./spc/');
  if (url.pathname.includes('/orders/bnr')) return caches.match('./bnr/');
  if (url.pathname.includes('/orders/adg')) return caches.match('./adg/');
  if (url.pathname.includes('/orders/bnl')) return caches.match('./bnl/');
  return caches.match('./');
}

// ── FETCH ────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Pass external API calls straight to network (no cache)
  const isExternal =
    url.hostname.includes('razorpay.com')     ||
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('wa.me');

  if (isExternal) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(
          JSON.stringify({ status: 'queued' }),
          { headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // Network-first for pages: users always get the latest deploy,
  // with the cached copy (then the precached shell) as offline fallback.
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
        .catch(() =>
          caches.match(request).then(cached => cached || offlineFallbackFor(url))
        )
    );
    return;
  }

  // Cache-first for static assets (images, manifest, icons)
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request)
        .then(response => {
          // Only cache successful, same-origin, basic responses
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

// ── BACKGROUND SYNC ──────────────────────────────────────────
// When the browser comes back online, tell the active page to
// retry any orders that were queued while offline.
self.addEventListener('sync', event => {
  if (event.tag === 'sync-orders') {
    event.waitUntil(notifyClientsToRetry());
  }
});

async function notifyClientsToRetry() {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client =>
    client.postMessage({ type: 'RETRY_QUEUE' })
  );
}

// ── PUSH NOTIFICATIONS (future use) ──────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const { title = 'Dairy Bliss', body = '' } = event.data.json();
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: './icons/icon-any-192.png',
      badge: './icons/icon-any-192.png',
    })
  );
});
