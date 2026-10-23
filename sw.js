'use strict';

/**
 * Caches the app shell so it launches from the home screen instantly and
 * survives a flaky connection.
 *
 * Deliberately nothing else: video bytes, Graph responses, and thumbnail URLs
 * are all either huge, short-lived, or signed with an expiry. Caching them
 * would fill the phone and serve stale, dead URLs.
 */

const VERSION = 'v43';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './auth.js',
  './graph.js',
  './shared/facets.js',
  './shared/merge.js',
  './shared/format.js',
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

// The shell by pathname, which is how a request is recognised as one of it.
const SHELL_PATHS = new Set(SHELL.map((path) => new URL(path, self.location).pathname));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only our own static files. Anything on graph.microsoft.com, the login
  // endpoints, or a signed CDN URL goes straight to the network -- and so does
  // anything of ours that is not the shell, which is never stored.
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (!SHELL_PATHS.has(url.pathname)) return;

  // Cache first. A push reaches the phone through this file instead: a new
  // VERSION installs fresh copies past the HTTP cache (`reload`, above),
  // activating it purges the old cache, and the page reloads into it on
  // controllerchange. Network-first made every open wait on a revalidation
  // per file, and on no signal it waited three seconds before giving up.
  //
  // Matched and stored without the query string: the sign-in redirect comes
  // back as ./?code=..., and a single-use OAuth code has no business sitting
  // in a cache -- nor would it ever match again if it did.
  event.respondWith((async () => {
    const hit = await caches.match(event.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(event.request);
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((cache) => cache.put(url.origin + url.pathname, copy));
      }
      return res;
    } catch (err) {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
      throw err;
    }
  })());
});
