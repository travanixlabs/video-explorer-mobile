'use strict';

/**
 * Caches the app shell so it launches from the home screen instantly and
 * survives a flaky connection.
 *
 * Deliberately nothing else: video bytes, Graph responses, and thumbnail URLs
 * are all either huge, short-lived, or signed with an expiry. Caching them
 * would fill the phone and serve stale, dead URLs.
 */

const VERSION = 'v25';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './auth.js',
  './graph.js',
  './styles.css',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  // `reload`, past the browser's own HTTP cache. Pages serves these with ten
  // minutes of max-age, so a plain addAll right after a push could fill the
  // NEW cache with the OLD files -- and then serve them until the next push.
  const fresh = SHELL.map((path) => new Request(path, { cache: 'reload' }));
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only our own static files. Anything on graph.microsoft.com, the login
  // endpoints, or a signed CDN URL goes straight to the network.
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  // Network first, asked to revalidate (`no-cache`), so a push shows on the
  // next load. It was stale-while-revalidate, which always answered with the
  // cached copy and made every update land one open late -- a refresh showed
  // the old app however hard it was pressed. Revalidating costs a 304 per file
  // when nothing changed. A slow or absent network still gets the cached app:
  // after WAIT the cache answers, and the network's copy is stored behind it.
  const WAIT = 3000;
  event.respondWith((async () => {
    const network = fetch(event.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((cache) => cache.put(event.request, copy));
      }
      return res;
    });
    const hit = await caches.match(event.request);
    if (!hit) return network.catch(() => caches.match('./index.html'));
    const late = new Promise((resolve) => setTimeout(() => resolve(hit), WAIT));
    return Promise.race([network.catch(() => hit), late]);
  })());
});
