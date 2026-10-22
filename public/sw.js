// MiTV Service Worker - PWA & Cache Management
const CACHE_NAME = 'mitv-v7.0';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Critical stream & API exclusion: NEVER cache or intercept streaming/proxy routes or media chunks
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/player/') ||
    url.pathname.endsWith('.ts') ||
    url.pathname.endsWith('.m3u8') ||
    url.pathname.endsWith('.m4s') ||
    url.pathname.endsWith('.mpd') ||
    url.pathname.endsWith('.mp4') ||
    url.pathname.endsWith('.aac') ||
    url.searchParams.has('token') ||
    url.searchParams.has('referer') ||
    event.request.headers.has('range')
  ) {
    return;
  }

  // Network-First strategy for all App Shell assets (HTML, CSS, JS, manifest)
  // Ensures newly deployed code is served immediately without stale cache issues
  event.respondWith(
    fetch(event.request)
      .then((networkRes) => {
        if (networkRes && networkRes.status === 200) {
          const resClone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        }
        return networkRes;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('Red no disponible', { status: 503, headers: { 'Content-Type': 'text/plain' } });
        });
      })
  );
});
