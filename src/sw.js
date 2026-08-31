/// <reference lib="webworker" />

/**
 * Offline cache.
 *
 * Asset filenames are content-hashed at build time, so this caches at runtime
 * rather than from a precomputed manifest: whatever the app actually requests
 * gets stored, and the next visit is served from disk.
 *
 * Same-origin GETs only. There is nothing else to cache — the app never talks
 * to another origin.
 */

const CACHE = 'local-pdf-editor-v1';

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

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) {
        // Refresh in the background so a deploy is picked up on the next load
        // without ever making the user wait on the network.
        void fetch(request)
          .then((response) => {
            if (response.ok) return caches.open(CACHE).then((c) => c.put(request, response));
            return undefined;
          })
          .catch(() => undefined);
        return cached;
      }

      try {
        const response = await fetch(request);
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return response;
      } catch (err) {
        // An offline navigation falls back to the cached shell.
        if (request.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        throw err;
      }
    })(),
  );
});
