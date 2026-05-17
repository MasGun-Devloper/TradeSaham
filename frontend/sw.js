// ════════════════════════════════════════
//  StockDSS v5.0 — Service Worker (PWA)
// ════════════════════════════════════════
const CACHE_NAME   = 'stockdss-v5';
const STATIC_CACHE = 'stockdss-static-v5';
const API_CACHE    = 'stockdss-api-v5';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/offline.html',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap',
];

// ── Install: cache static assets ──────────────────────────────────────────────
self.addEventListener('install', evt => {
  console.log('[SW] Installing StockDSS v5.0...');
  evt.waitUntil(
    caches.open(STATIC_CACHE).then(cache =>
      Promise.allSettled(STATIC_ASSETS.map(url =>
        cache.add(url).catch(e => console.warn('[SW] Failed to cache:', url, e.message))
      ))
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ─────────────────────────────────────────────────
self.addEventListener('activate', evt => {
  console.log('[SW] Activating...');
  evt.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => ![STATIC_CACHE, API_CACHE].includes(k)).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch strategy ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', evt => {
  const url = new URL(evt.request.url);

  // 1. API calls → Network first, fallback to cache (max 5 min stale)
  if (url.pathname.startsWith('/api/')) {
    evt.respondWith(networkFirstWithCache(evt.request, API_CACHE, 5 * 60 * 1000));
    return;
  }

  // 2. Anthropic API → Network only (no cache for AI)
  if (url.hostname === 'api.anthropic.com') {
    evt.respondWith(fetch(evt.request));
    return;
  }

  // 3. Static assets → Cache first, fallback to network
  if (evt.request.method === 'GET') {
    evt.respondWith(cacheFirstWithNetwork(evt.request));
    return;
  }
});

async function networkFirstWithCache(request, cacheName, maxAge) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request.clone());
    if (response.ok) {
      const toCache = response.clone();
      const headers = new Headers(toCache.headers);
      headers.set('sw-cached-at', Date.now().toString());
      cache.put(request, new Response(await toCache.blob(), { status: toCache.status, headers }));
    }
    return response;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) {
      const cachedAt = parseInt(cached.headers.get('sw-cached-at') || '0');
      if (Date.now() - cachedAt < maxAge) return cached;
    }
    return offlineFallback();
  }
}

async function cacheFirstWithNetwork(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok && response.type !== 'opaque') {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    return offlineFallback();
  }
}

function offlineFallback() {
  return caches.match('/offline.html').then(r =>
    r || new Response('<h1>Offline</h1><p>StockDSS tidak dapat terhubung ke server.</p>', {
      headers: { 'Content-Type': 'text/html' }
    })
  );
}

// ── Background sync: queue failed requests ──────────────────────────────────
self.addEventListener('sync', evt => {
  if (evt.tag === 'sync-watchlist') {
    evt.waitUntil(syncWatchlist());
  }
});

async function syncWatchlist() {
  console.log('[SW] Background sync: watchlist');
}

// ── Push notification support ──────────────────────────────────────────────
self.addEventListener('push', evt => {
  const data = evt.data?.json() || {};
  self.registration.showNotification(data.title || 'StockDSS Alert', {
    body: data.body || 'Ada sinyal saham baru!',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    tag: 'stockdss-alert',
    data: { url: data.url || '/' },
  });
});

self.addEventListener('notificationclick', evt => {
  evt.notification.close();
  evt.waitUntil(clients.openWindow(evt.notification.data?.url || '/'));
});
