/**
 * Offline cache.
 *
 * Lives in `public/` so it is copied verbatim to the site root rather than
 * hashed into `assets/`. That matters: a service worker's default scope is its
 * own directory, so one served from `/assets/` could not control the app.
 *
 * Two strategies, because they solve opposite problems:
 *
 *  - **Navigations are network-first.** Asset filenames are content-hashed, so a
 *    cached `index.html` pointing at a previous deploy's files would reference
 *    assets that no longer exist — a permanently broken app. Fetching the
 *    document fresh, and falling back to cache only when offline, avoids that.
 *  - **Everything else is cache-first.** A hashed filename can never mean
 *    different bytes, so once cached it is safe forever, and the ~1.3 MB pdf.js
 *    worker should never be fetched twice.
 *
 * Same-origin GETs only. There is nothing else to cache — the app never talks to
 * another origin.
 */

const CACHE = 'local-pdf-editor-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(request.mode === 'navigate' ? networkFirst(request) : cacheFirst(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) void put(request, response.clone());
    return response;
  } catch (err) {
    const cached = (await caches.match(request)) ?? (await caches.match('./index.html'));
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) void put(request, response.clone());
  return response;
}

async function put(request, response) {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response);
  } catch {
    // A full quota or a partial response. Caching is an optimisation; never let
    // a failure here break the request that is already being served.
  }
}
