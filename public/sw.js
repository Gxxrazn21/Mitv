// MiTV Service Worker - PWA & Cache Management
const CACHE_NAME = 'mitv-v5';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.css?v=5.0',
  '/app.js?v=5.0',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Critical stream exclusion: NEVER cache API calls, player proxies, or media segments
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/player/') ||
    url.pathname.endsWith('.ts') ||
    url.pathname.endsWith('.m3u8') ||
    url.pathname.endsWith('.m4s') ||
    url.pathname.endsWith('.mpd')
  ) {
    return;
  }

  // Network-First for HTML/Navigation so updates are immediately visible
  if (event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request).then((networkRes) => {
        return networkRes;
      }).catch(() => cachedResponse);
    })
  );
});
