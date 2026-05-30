// ============================================================
//  Dairy Bliss — Service Worker
//  Strategy: cache-first for static assets, network-first for
//  API calls. Failed order submissions are queued in
//  localStorage and retried via Background Sync.
// ============================================================

const CACHE_NAME = 'dairy-bliss-v5';

// Assets to precache on install
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/Logo.png',
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

  // Cache-first for local assets
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
        .catch(() => {
          // Offline fallback: serve index.html for navigation requests
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          // For other failed requests, return empty 503
          return new Response('Offline', { status: 503 });
        });
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
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
    })
  );
});
